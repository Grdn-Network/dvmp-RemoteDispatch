using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// Pushes live updates to a connected dispatcher over a websocket. Each connection gets
    /// its own server-side session and reuses the exact update machinery as the long-poll
    /// /updates endpoint (<see cref="Sessions.GetUpdates"/>): per-user permission remapping,
    /// the dirty-tag queue, and pre-baked JSON. One pump per socket means a single sender, so
    /// there is no concurrent-send hazard. The /updates long-poll endpoint is left intact as a
    /// fallback for clients that don't (yet) use the websocket.
    /// </summary>
    internal static class WebSocketPump
    {
        public static async Task Run(WebSocket socket, string username)
        {
            var sessionId = "ws-" + Guid.NewGuid().ToString("N");
            var cts = new CancellationTokenSource();
            var drain = DrainIncoming(socket, cts);
            try
            {
                while (socket.State == WebSocketState.Open && !cts.IsCancellationRequested)
                {
                    // Returns immediately if updates are pending, otherwise blocks up to 60 s
                    // for the next dirty tag (no busy loop). The first call returns the initial
                    // snapshot (base tags), honouring this user's permissions.
                    string json = await Sessions.GetUpdates(username, sessionId).ConfigureAwait(false);
                    if (socket.State != WebSocketState.Open || cts.IsCancellationRequested)
                        break;
                    if (string.IsNullOrEmpty(json) || json == "{}")
                        continue; // idle timeout — the keep-alive ping keeps the socket alive
                    var bytes = Encoding.UTF8.GetBytes(json);
                    await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
                }
            }
            catch (Exception e)
            {
                Main.DebugLog($"WebSocket pump ended for {sessionId}: {e.Message}");
            }
            finally
            {
                cts.Cancel();
                try { await drain.ConfigureAwait(false); } catch { }
                cts.Dispose();
                Sessions.EndSession(sessionId);
                try { socket.Dispose(); } catch { }
            }
        }

        // Drains incoming frames (pongs / any client messages) and handles the close
        // handshake so the socket state stays accurate. Client->server data is ignored
        // for now (commands still go over the existing HTTP POST endpoints).
        private static async Task DrainIncoming(WebSocket socket, CancellationTokenSource cts)
        {
            var buffer = new byte[1024];
            try
            {
                while (socket.State == WebSocketState.Open && !cts.IsCancellationRequested)
                {
                    var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).ConfigureAwait(false); } catch { }
                        break;
                    }
                }
            }
            catch { }
            finally { cts.Cancel(); }
        }
    }
}
