using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// A minimal server-side WebSocket (RFC 6455) implemented directly on the
    /// connection's raw stream. DV runs on Unity's Mono, whose HttpListener
    /// WebSocket support is broken (IsWebSocketRequest returns false even for a
    /// valid upgrade, and AcceptWebSocketAsync is unreliable). We instead pull the
    /// underlying stream out of the HttpListenerContext by reflection, write the
    /// 101 handshake ourselves, and frame messages by hand — so it works regardless
    /// of the runtime. Reuses the same per-session update feed as the long-poll.
    /// </summary>
    internal sealed class RawWebSocket
    {
        private const string WsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

        private readonly Stream stream;
        private readonly SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);

        private RawWebSocket(Stream stream) => this.stream = stream;

        /// <summary>
        /// Completes the upgrade and pumps live updates until the socket closes.
        /// Returns false if the connection's stream couldn't be obtained (so the
        /// caller can fall back to an error response).
        /// </summary>
        public static async Task<bool> Run(HttpListenerContext context, string username)
        {
            var stream = GetUnderlyingStream(context);
            if (stream == null)
            {
                Main.Log("/ws: could not obtain the underlying connection stream for a raw upgrade.");
                return false;
            }

            var key = context.Request.Headers["Sec-WebSocket-Key"];
            if (string.IsNullOrEmpty(key))
            {
                Main.Log("/ws: missing Sec-WebSocket-Key.");
                return false;
            }

            var accept = Convert.ToBase64String(
                SHA1.Create().ComputeHash(Encoding.ASCII.GetBytes(key + WsGuid)));
            var handshake =
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
            var bytes = Encoding.ASCII.GetBytes(handshake);
            await stream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
            await stream.FlushAsync().ConfigureAwait(false);
            Main.Log("/ws: raw websocket upgraded.");

            var ws = new RawWebSocket(stream);
            await ws.Pump(username).ConfigureAwait(false);
            return true;
        }

        // HttpListenerContext.cnc (HttpConnection) holds the Socket/Stream. Both are
        // internal, so reach them by reflection. Prefer the managed stream; fall back
        // to wrapping the raw socket.
        private static Stream? GetUnderlyingStream(HttpListenerContext context)
        {
            try
            {
                const BindingFlags bf = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
                var cnc = typeof(HttpListenerContext).GetField("cnc", bf)?.GetValue(context)
                    ?? typeof(HttpListenerContext).GetProperty("Connection", bf)?.GetValue(context);
                if (cnc == null) return null;

                var streamObj = cnc.GetType().GetField("stream", bf)?.GetValue(cnc) as Stream;
                if (streamObj != null) return streamObj;

                var sock = cnc.GetType().GetField("sock", bf)?.GetValue(cnc) as Socket;
                return sock != null ? new NetworkStream(sock, ownsSocket: false) : null;
            }
            catch (Exception e)
            {
                Main.Log($"/ws: reflection to obtain stream failed: {e.Message}");
                return null;
            }
        }

        private async Task Pump(string username)
        {
            var sessionId = "ws-" + Guid.NewGuid().ToString("N");
            var cts = new CancellationTokenSource();
            var receiver = ReceiveLoop(cts);
            var keepalive = KeepAliveLoop(cts);
            try
            {
                while (!cts.IsCancellationRequested)
                {
                    // Blocks up to ~60s for the next dirty tag, or returns immediately if
                    // data is pending. The first call yields the base-tag snapshot.
                    var json = await Sessions.GetUpdates(username, sessionId).ConfigureAwait(false);
                    if (cts.IsCancellationRequested) break;
                    if (string.IsNullOrEmpty(json) || json == "{}") continue; // idle timeout
                    await SendText(json).ConfigureAwait(false);
                }
            }
            catch (Exception e)
            {
                Main.DebugLog($"/ws pump ended for {sessionId}: {e.Message}");
            }
            finally
            {
                cts.Cancel();
                try { await SendClose().ConfigureAwait(false); } catch { }
                try { await Task.WhenAny(Task.WhenAll(receiver, keepalive), Task.Delay(1000)).ConfigureAwait(false); } catch { }
                cts.Dispose();
                Sessions.EndSession(sessionId);
                try { stream.Dispose(); } catch { }
            }
        }

        // Reads incoming frames so the close handshake works and pings are answered.
        // Client->server data frames are ignored (commands still go over HTTP POST).
        private async Task ReceiveLoop(CancellationTokenSource cts)
        {
            try
            {
                while (!cts.IsCancellationRequested)
                {
                    var frame = await ReadFrame(cts.Token).ConfigureAwait(false);
                    if (frame == null) break; // stream closed
                    int opcode = frame.Value.opcode;
                    if (opcode == 0x8) break;                 // close
                    if (opcode == 0x9) await SendPong(frame.Value.payload).ConfigureAwait(false); // ping -> pong
                    // 0xA pong and data frames: ignore
                }
            }
            catch { }
            finally { cts.Cancel(); }
        }

        private async Task KeepAliveLoop(CancellationTokenSource cts)
        {
            try
            {
                while (!cts.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(30), cts.Token).ConfigureAwait(false);
                    await SendPing().ConfigureAwait(false);
                }
            }
            catch { }
        }

        /////////////////////
        // Framing

        private Task SendText(string s) => SendFrame(0x1, Encoding.UTF8.GetBytes(s));
        private Task SendPing() => SendFrame(0x9, Array.Empty<byte>());
        private Task SendPong(byte[] payload) => SendFrame(0xA, payload ?? Array.Empty<byte>());
        private Task SendClose() => SendFrame(0x8, Array.Empty<byte>());

        // Server->client frames are never masked.
        private async Task SendFrame(int opcode, byte[] payload)
        {
            var header = new byte[10];
            int n = 0;
            header[n++] = (byte)(0x80 | (opcode & 0x0F)); // FIN + opcode
            int len = payload.Length;
            if (len < 126)
            {
                header[n++] = (byte)len;
            }
            else if (len <= 0xFFFF)
            {
                header[n++] = 126;
                header[n++] = (byte)(len >> 8);
                header[n++] = (byte)len;
            }
            else
            {
                header[n++] = 127;
                for (int i = 7; i >= 0; i--) header[n++] = (byte)((long)len >> (8 * i));
            }
            await writeLock.WaitAsync().ConfigureAwait(false);
            try
            {
                await stream.WriteAsync(header, 0, n).ConfigureAwait(false);
                if (len > 0) await stream.WriteAsync(payload, 0, len).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
            }
            finally { writeLock.Release(); }
        }

        private async Task<(int opcode, byte[] payload)?> ReadFrame(CancellationToken ct)
        {
            var h = await ReadExactly(2, ct).ConfigureAwait(false);
            if (h == null) return null;
            int opcode = h[0] & 0x0F;
            bool masked = (h[1] & 0x80) != 0;
            long len = h[1] & 0x7F;
            if (len == 126)
            {
                var e = await ReadExactly(2, ct).ConfigureAwait(false);
                if (e == null) return null;
                len = (e[0] << 8) | e[1];
            }
            else if (len == 127)
            {
                var e = await ReadExactly(8, ct).ConfigureAwait(false);
                if (e == null) return null;
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
            }
            byte[]? mask = null;
            if (masked)
            {
                mask = await ReadExactly(4, ct).ConfigureAwait(false);
                if (mask == null) return null;
            }
            var payload = len > 0 ? await ReadExactly((int)len, ct).ConfigureAwait(false) : Array.Empty<byte>();
            if (payload == null) return null;
            if (mask != null)
                for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
            return (opcode, payload);
        }

        private async Task<byte[]?> ReadExactly(int count, CancellationToken ct)
        {
            var buf = new byte[count];
            int read = 0;
            while (read < count)
            {
                int r = await stream.ReadAsync(buf, read, count - read, ct).ConfigureAwait(false);
                if (r <= 0) return null; // closed
                read += r;
            }
            return buf;
        }
    }
}
