using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
	public class HttpServer : MonoBehaviour
	{
		private static GameObject? rootObject;
		private readonly HttpListener listener = new HttpListener();

		public async void Start()
		{
			if (!listener.IsListening)
			{
				listener.Prefixes.Add($"http://*:{Main.settings.serverPort}/");
				listener.AuthenticationSchemes = AuthenticationSchemes.Anonymous | AuthenticationSchemes.Basic;
				listener.Realm = "DV Remote Dispatch";
				Main.Log($"Starting HTTP server on port {Main.settings.serverPort}");
				listener.Start();
			}

			while (listener.IsListening)
			{
				try
				{
					var context = await listener.GetContextAsync().ConfigureAwait(true);
					if (CheckAuthentication(context))
					{
						_ = Task.Run(async () =>
						{
							try
							{
								await HandleRequest(context).ConfigureAwait(false);
							}
							catch (Exception e)
							{
								Main.Log($"Exception while handling HTTP request ({context.Request.Url}): {e}");
							}
						});
					}
					else
					{
						context.Response.Headers.Add("WWW-Authenticate", "Basic");
						RenderEmpty(context, 401);
					}
				}
				catch (ObjectDisposedException e) when (e.ObjectName == "listener")
				{
					// ignore when OnDestroy() is called to shutdown the server
				}
			}
		}

		public void OnDestroy()
		{
			if (listener.IsListening)
			{
				Main.Log("Stopping HTTP server");
				listener.Stop();
				listener.Prefixes.Clear();
			}
		}

		private static bool CheckAuthentication(HttpListenerContext context)
		{
			string serverPassword = Main.settings.serverPassword;
			return context.User?.Identity is HttpListenerBasicIdentity identity && (string.IsNullOrEmpty(serverPassword) || identity.Password == serverPassword);
		}

		private static async Task HandleRequest(HttpListenerContext context)
		{
			var request = context.Request;
			if (request.Url.Segments.Length < 2)
			{
				context.Response.ContentType = ContentTypes.Html;
				RenderResource(context, "frontend.index.html");
				return;
			}

			switch (request.Url.Segments[1].TrimEnd('/'))
			{
			case "car":
#if DEBUG
				Main.Log("/car endpoint hit");
#endif
				HandleCarRequest(context);
				break;
			case "junction":
				HandleJunctionRequest(context);
#if DEBUG
				Main.Log("/junction endpoint hit");
#endif
				break;
			case "player":
#if DEBUG
				Main.Log("/player endpoint hit");
#endif
				if(!Main.settings.permissions.CanSeePlayerBlips(context.User.Identity.Name))
				{
					RenderEmpty(context, 200);
					break;
				}
				var playerJson = PlayerData.GetPlayerDataJson();
				if (playerJson != null)
					Render200(context, ContentTypes.Json, playerJson);
				else
					RenderEmpty(context, 500);
				break;
			case "res":
#if DEBUG
				Main.Log("/res endpoint hit");
#endif
				RenderResource(context);
				break;
			case "track":
#if DEBUG
				Main.Log("/track endpoint hit");
#endif
				Render200(context, ContentTypes.Json, await RailTracks.GetTrackPointJSON().ConfigureAwait(false));
				break;
			case "updates":
#if DEBUG
				Main.Log("/updates endpoint hit");
#endif
				await HandleUpdatesRequest(context).ConfigureAwait(false);
				break;
			case "signals":
#if DEBUG
				Main.Log("/signals endpoint hit");
#endif
				// POST /signals/bulk — set mode (+ optional aspect) on many signals at once.
				if (request.Url.Segments.Length >= 3
					&& request.Url.Segments[2].TrimEnd('/') == "bulk"
					&& request.HttpMethod == "POST")
				{
					HandleSignalsBulkRequest(context);
					break;
				}
				string signalsJson = Main.settings.featureFlags.enableSignals ? JsonConvert.SerializeObject(SignalsShim.GetAllSignalsData()) : JsonConvert.SerializeObject(new JObject());
				Render200(context, ContentTypes.Json, signalsJson);
				break;
			case "signal":
#if DEBUG
				Main.Log("/signal endpoint hit");
#endif
				await HandleSignalRequest(context);
				break;
			case "whoami":
				// Lets the web client learn its own authenticated name so it can do
				// "owned-by-me" / xfer-targeting checks the server enforces anyway.
				Render200(context, new JObject { ["username"] = CollabUser(context) });
				break;
			case "zones":
				Render200(context, ZoneSystem.GetZoneStateJObject());
				break;
			case "zone":
				HandleZoneRequest(context);
				break;
			case "notes":
				HandleNotesRequest(context);
				break;
			case "chat":
				HandleChatRequest(context);
				break;
			case "xfer":
				HandleXferRequest(context);
				break;
			case "ws":
#if DEBUG
				Main.Log("/ws endpoint hit");
#endif
				await HandleWebSocketRequest(context).ConfigureAwait(false);
				break;
			default:
#if DEBUG
				Main.Log("unknown endpoint hit");
#endif
				RenderEmpty(context, 404);
				break;
			}
		}

		// Live updates over a websocket (one persistent connection instead of long-polling
		// /updates). Reuses the same per-session update machinery via WebSocketPump.
		private static async Task HandleWebSocketRequest(HttpListenerContext context)
		{
			// Do NOT gate on context.Request.IsWebSocketRequest — Mono returns false even
			// for a valid upgrade (confirmed in-game). Validate the header ourselves, then
			// do the handshake + framing on the raw stream (RawWebSocket), since Mono's
			// HttpListener AcceptWebSocketAsync is unreliable.
			var upgradeHeader = context.Request.Headers["Upgrade"];
			if (string.IsNullOrEmpty(upgradeHeader)
				|| upgradeHeader.IndexOf("websocket", StringComparison.OrdinalIgnoreCase) < 0)
			{
				Main.Log($"/ws: not a websocket upgrade (Upgrade='{upgradeHeader}', "
					+ $"Connection='{context.Request.Headers["Connection"]}')");
				RenderEmpty(context, 400);
				return;
			}

			var username = context.User?.Identity?.Name ?? "";
			try
			{
				var ok = await RawWebSocket.Run(context, username).ConfigureAwait(false);
				if (!ok)
					try { RenderEmpty(context, 500); } catch { }
			}
			catch (Exception e)
			{
				Main.Log($"/ws: raw websocket failed: {e.Message}");
				try { RenderEmpty(context, 500); } catch { }
			}
		}

		private static async void HandleCarRequest(HttpListenerContext context)
		{
			var segments = context.Request.Url.Segments;
			if (segments.Length == 2 && context.Request.HttpMethod == "GET")
			{
				var allCarDataJson = CarData.GetAllCarDataJson(Main.settings.permissions.CanSeeLocomotives(context.User.Identity.Name));
				Render200(context, allCarDataJson);
				return;
			}

			if (segments.Length == 3 && context.Request.HttpMethod == "GET")
			{
				var carGuid = segments[2].TrimEnd('/');
				var carDataJson = CarData.GetCarGuidDataJson(carGuid);
				if (carDataJson == null)
					RenderEmpty(context, 404);
				else
					Render200(context, carDataJson);
				return;
			}

			if (segments.Length == 4 && segments[3] == "control" && context.Request.HttpMethod == "POST")
			{
				var carGuid = segments[2].TrimEnd('/');
				var controller = LocoControl.GetLocoController(carGuid);
				if (controller == null)
				{
					RenderEmpty(context, 404);
					return;
				}
				if (!Main.settings.permissions.HasLocoControlPermission(context.User.Identity.Name))
				{
					RenderEmpty(context, 403);
					return;
				}
				var success = await Updater.RunOnMainThread(() =>
					LocoControl.RunCommand(controller, context.Request.QueryString)
				).ConfigureAwait(false);
				RenderEmpty(context, success ? 204 : 400);
			}
			RenderEmpty(context, 404);
		}

		private static async Task HandleSignalRequest(HttpListenerContext context)
		{
			var url = context.Request.Url;
			var segments = url.Segments;

			if (segments.Length < 3 || !segments[2].TrimEnd('/').Equals("control", StringComparison.OrdinalIgnoreCase))
			{
				Main.Warning($"Invalid signal control request URL: {url}");
				Main.DebugLog($"Number of URL segments: {segments.Length}");
				Main.DebugLog($"First URL segment (should be host): {(segments.Length >= 1 ? segments[0] : "N/A")}");
				Main.DebugLog($"Second URL segment (should be 'signal'): {(segments.Length >= 2 ? segments[1] : "N/A")}");
				Main.DebugLog($"Third URL segment (should be signal ID): {(segments.Length >= 3 ? segments[2] : "N/A")}");
				Main.DebugLog($"Fourth URL segment (should be 'control'): {(segments.Length >= 4 ? segments[3] : "N/A")}");
				RenderEmpty(context, 404);
				return;
			}

			if (!Main.settings.permissions.HasSignalControlPermission(context.User.Identity.Name))
			{
				RenderEmpty(context, 403);
				return;
			}

			bool success = true;
			bool bodyRead = false;
			string? mode = null;
			string? aspect = null;
			string? signalId = null;

			try
			{
				const int maxBodySize = 65536;
				using var stream = context.Request.InputStream;
				var buffer = new byte[8192];
				int totalRead = 0;

				while (stream.CanRead)
				{
					int 					bytesRead = stream.Read(buffer, 0, buffer.Length);
					if (bytesRead == 0) break;
					
					totalRead += bytesRead;
					if (totalRead > maxBodySize)
					{
						throw new Exception("Request body too large");
					}
				}

				string? bodyText = Encoding.UTF8.GetString(buffer, 0, totalRead);

				if (!string.IsNullOrEmpty(bodyText))
				{
					var requestData = JObject.Parse(bodyText);
					bodyRead = true;

					if (requestData.TryGetValue("signalId", out JToken? idToken))
					{
						signalId = idToken.Value<string?>();
					}

					if (requestData.TryGetValue("mode", out JToken? modeToken))
					{
						mode = modeToken.Value<string?>();
					}
					else if (requestData.TryGetValue("aspect", out JToken? aspectToken))
					{
						aspect = aspectToken.Value<string?>();
					}
				}

				if (string.IsNullOrEmpty(signalId))
				{
					Main.Warning("Signal control request missing 'signalId' in body");
					RenderEmpty(context, 400);
					return;
				}

				if (!ZoneSystem.CanControlSignal(context.User.Identity.Name, signalId!))
				{
					RenderEmpty(context, 403);
					return;
				}

				if (mode != null)
				{
					Main.DebugLog($"Setting signal {signalId} mode to {mode}");
					bool result = SignalsShim.SetSignalMode(signalId!, mode!);

					if (!result && SignalsShim.IsInitialized == false)
					{
						Main.Warning($"[SIGNAL] Integration not initialized - cannot set mode: {mode}/{signalId}");
						Main.DebugLog("  -> Check that DVSignals mod is enabled in GameMods list");
					}
					else if (!result && SignalsShim.IsInitialized == true)
					{
						Main.Warning($"[SIGNAL] API call failed: signal={signalId}, mode={mode}");
						Main.DebugLog("  -> Check Signal exists, spelling correct, aspect not already set");
					}

					success = result;
				}
				else if (aspect != null)
				{
					Main.DebugLog($"Setting signal {signalId} aspect to {aspect}");
					bool result2 = SignalsShim.SetSignalAspect(signalId!, aspect!);

					if (!result2)
					{
						Main.Warning($"[SIGNAL] API call failed: signal={signalId}, aspect={aspect}");
					}

					success &= result2;
				}

				if (!bodyRead)
				{
					Main.Warning($"Signal control request lacks 'mode' or 'aspect'): {url}");
				}
			}
			catch (Exception e)
			{
				Main.Warning($"Failed to parse signal control request body: {e.Message}");
				success = false;
			}

			RenderEmpty(context, success ? 204 : 400);
		}

		// POST /signals/bulk  body: { "signalIds": [...], "mode": "Manual"|"Automatic", "aspect": "S1"? }
		// Sets mode (and optional aspect, when going Manual) on many signals at once.
		// Returns { requested, applied } so the client can confirm the API took the change.
		private static void HandleSignalsBulkRequest(HttpListenerContext context)
		{
			if (!Main.settings.featureFlags.enableSignals)
			{
				RenderEmpty(context, 409);
				return;
			}
			if (!Main.settings.permissions.HasSignalControlPermission(context.User.Identity.Name))
			{
				RenderEmpty(context, 403);
				return;
			}
			try
			{
				var body = JObject.Parse(ReadRequestBody(context));
				var mode = (string?)body["mode"];
				var aspect = (string?)body["aspect"];
				var idsArr = body["signalIds"] as JArray;
				if (idsArr == null || idsArr.Count == 0 || string.IsNullOrEmpty(mode))
				{
					RenderEmpty(context, 400);
					return;
				}
				var user = CollabUser(context);
				int requested = 0, applied = 0;
				foreach (var t in idsArr)
				{
					var id = (string?)t;
					if (string.IsNullOrEmpty(id)) continue;
					requested++;
					if (!ZoneSystem.CanControlSignal(user, id!)) continue;
					bool ok = SignalsShim.SetSignalMode(id!, mode!);
					if (ok && mode == "Manual" && !string.IsNullOrEmpty(aspect))
						SignalsShim.SetSignalAspect(id!, aspect!);
					if (ok) applied++;
				}
				Render200(context, new JObject { ["requested"] = requested, ["applied"] = applied });
			}
			catch (Exception e)
			{
				Main.Warning($"Bad /signals/bulk request: {e.Message}");
				RenderEmpty(context, 400);
			}
		}

		private static async Task HandleUpdatesRequest(HttpListenerContext context)
		{
			if (context.Request.Url.Segments.Length < 3)
			{
				RenderEmpty(context, 404);
				return;
			}

			var username = context.User?.Identity?.Name ?? "";
			var sessionId = context.Request.Url.Segments[2];
			Render200(context, ContentTypes.Json, await Sessions.GetUpdates(username, sessionId).ConfigureAwait(false));
		}

		private static bool IsValidJunctionId(int junctionId)
		{
			return junctionId >= 0 && junctionId < RailTrackRegistry.Instance.OrderedJunctions.Length;
		}

		private static async void HandleJunctionRequest(HttpListenerContext context)
		{
			var url = context.Request.Url;
			switch (url.Segments.Length)
			{
			case 2:
				Render200(context, ContentTypes.Json, Junctions.GetJunctionPointJSON());
				break;
			case 4:
				var junctionIdString = url.Segments[2].TrimEnd('/');
				if (int.TryParse(junctionIdString, out var junctionId) && url.Segments[3] == "toggle" && IsValidJunctionId(junctionId))
				{
					if (!Main.settings.permissions.HasJunctionPermission(context.User.Identity.Name))
					{
						RenderEmpty(context, 403);
						return;
					}
					if (!ZoneSystem.CanControlJunction(context.User.Identity.Name, junctionId))
					{
						RenderEmpty(context, 403);
						return;
					}
					var newSelectedBranch = await Updater.RunOnMainThread(() =>
					{
						Main.DebugLog($"Toggling J-{junctionId}.");
						var junction = RailTrackRegistry.Instance.OrderedJunctions[junctionId];
						junction.Switch(Junction.SwitchMode.REGULAR);
						return junction.selectedBranch;
					}).ConfigureAwait(false);
					Render200(context, new JValue(newSelectedBranch));
					return;
				}
				RenderEmpty(context, 404);
				break;
			default:
				RenderEmpty(context, 404);
				break;
			}
		}

		public static void HandleTrainsetRequest(HttpListenerContext context)
		{
			var request = context.Request;
			if (request.Url.Segments.Length < 3)
			{
				RenderEmpty(context, 404);
				return;
			}
			var trainsetId = int.Parse(request.Url.Segments[2]);
			Render200(context, CarData.GetTrainsetDataJson(trainsetId));
		}

		// Identity for the collaboration features (zones/notes/chat/xfer). A solo /
		// no-password session is anonymous (empty name); fall back to "host" so zone
		// claims succeed and "owned-by-me" resolves. In multiplayer, real names come
		// from auth. (Multiple simultaneous anonymous clients share the "host" identity.)
		private static string CollabUser(HttpListenerContext context)
		{
			var name = context.User?.Identity?.Name;
			return string.IsNullOrEmpty(name) ? "host" : name;
		}

		private static string ReadRequestBody(HttpListenerContext context, int maxBytes = 65536)
		{
			using var ms = new MemoryStream();
			var stream = context.Request.InputStream;
			var buffer = new byte[8192];
			int total = 0, read;
			while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
			{
				total += read;
				if (total > maxBytes) break;
				ms.Write(buffer, 0, read);
			}
			return Encoding.UTF8.GetString(ms.ToArray());
		}

		// POST /zone/{zoneId}/claim | /zone/{zoneId}/release
		private static void HandleZoneRequest(HttpListenerContext context)
		{
			var segments = context.Request.Url.Segments;
			if (segments.Length != 4 || context.Request.HttpMethod != "POST")
			{
				RenderEmpty(context, 404);
				return;
			}
			var username = CollabUser(context);
			var zoneId = segments[2].TrimEnd('/');
			switch (segments[3].TrimEnd('/'))
			{
			case "claim":
				RenderEmpty(context, ZoneSystem.TryClaim(username, zoneId) ? 200 : 409);
				break;
			case "release":
				ZoneSystem.Release(username, zoneId);
				RenderEmpty(context, 200);
				break;
			default:
				RenderEmpty(context, 404);
				break;
			}
		}

		// GET /notes | POST /notes (body = plain text, last-write-wins)
		private static void HandleNotesRequest(HttpListenerContext context)
		{
			switch (context.Request.HttpMethod)
			{
			case "GET":
				Render200(context, DispatchCollab.GetNotesJObject());
				break;
			case "POST":
				DispatchCollab.UpdateNotes(ReadRequestBody(context));
				RenderEmpty(context, 204);
				break;
			default:
				RenderEmpty(context, 405);
				break;
			}
		}

		// POST /chat (body = {"text": "..."})
		private static void HandleChatRequest(HttpListenerContext context)
		{
			if (context.Request.HttpMethod != "POST")
			{
				RenderEmpty(context, 405);
				return;
			}
			var username = CollabUser(context);
			try
			{
				var body = ReadRequestBody(context);
				var text = string.IsNullOrEmpty(body) ? null : (string?)JObject.Parse(body)["text"];
				if (string.IsNullOrEmpty(text))
				{
					RenderEmpty(context, 400);
					return;
				}
				DispatchCollab.PostChat(username, text!);
				RenderEmpty(context, 204);
			}
			catch (Exception e)
			{
				Main.Warning($"Bad chat request: {e.Message}");
				RenderEmpty(context, 400);
			}
		}

		// GET /xfer | POST /xfer/offer | POST /xfer/accept/{id} | POST /xfer/reject/{id}
		private static void HandleXferRequest(HttpListenerContext context)
		{
			var segments = context.Request.Url.Segments;
			var username = CollabUser(context);

			if (segments.Length == 2 && context.Request.HttpMethod == "GET")
			{
				Render200(context, XferSystem.GetStateJObject());
				return;
			}
			if (context.Request.HttpMethod != "POST" || segments.Length < 3)
			{
				RenderEmpty(context, 404);
				return;
			}

			switch (segments[2].TrimEnd('/'))
			{
			case "offer":
				try
				{
					var body = JObject.Parse(ReadRequestBody(context));
					var trainId = (string?)body["trainId"] ?? "";
					var toUser = (string?)body["toUser"] ?? "";
					var toZone = (string?)body["toZone"] ?? "";
					var fromZone = (string?)body["fromZone"] ?? "";
					if (string.IsNullOrEmpty(trainId) || string.IsNullOrEmpty(toUser))
					{
						RenderEmpty(context, 400);
						return;
					}
					var offerId = XferSystem.CreateOffer(trainId, fromZone, toZone, username, toUser);
					Render200(context, new JObject { ["offerId"] = offerId });
				}
				catch (Exception e)
				{
					Main.Warning($"Bad xfer offer: {e.Message}");
					RenderEmpty(context, 400);
				}
				break;
			case "accept":
				if (segments.Length < 4) { RenderEmpty(context, 404); return; }
				RenderEmpty(context, XferSystem.TryAccept(segments[3].TrimEnd('/'), username) ? 200 : 403);
				break;
			case "reject":
				if (segments.Length < 4) { RenderEmpty(context, 404); return; }
				RenderEmpty(context, XferSystem.TryReject(segments[3].TrimEnd('/'), username) ? 200 : 403);
				break;
			default:
				RenderEmpty(context, 404);
				break;
			}
		}

		public static void Create()
		{
			if (rootObject == null)
			{
				rootObject = new GameObject();
				GameObject.DontDestroyOnLoad(rootObject);
				rootObject.AddComponent<HttpServer>();
			}
		}

		public static void Destroy()
		{
			if (rootObject == null)
				return;
			// ensure server shuts down immediately, not at the end of the frame
			DestroyImmediate(rootObject);
			rootObject = null;
		}

		private static void RenderResource(HttpListenerContext context)
		{
			var resourceName = context.Request.Url.Segments[2];
			var extension = Path.GetExtension(resourceName);
			context.Response.ContentType = ContentTypes.ForExtension(extension);
			RenderResource(context, $"frontend.{resourceName}");
		}

		private static void RenderResource(HttpListenerContext context, string resourceName)
		{
			var assembly = typeof(HttpServer).Assembly;
			using var stream = assembly.GetManifestResourceStream(typeof(HttpServer), resourceName);
			if (stream == null)
			{
				RenderEmpty(context, 404);
			}
			else
			{
				// The page itself and its code change between mod builds. Caching those as
				// "public, max-age" made the browser AND the Cloudflare edge serve a stale
				// version for up to an hour after a redeploy. Mark them no-store so a new
				// build always takes effect; images and other assets can still cache.
				bool volatileAsset = resourceName.EndsWith(".html")
					|| resourceName.EndsWith(".js")
					|| resourceName.EndsWith(".css");
				if (volatileAsset)
				{
					context.Response.Headers.Add("Cache-Control", "no-store, no-cache, must-revalidate");
					context.Response.Headers.Add("Pragma", "no-cache");
				}
				else
				{
					context.Response.Headers.Add("Cache-Control", "public, max-age=3600");
				}
				stream.CopyTo(context.Response.OutputStream);
				context.Response.Close();
			}
		}

		private static class ContentTypes
		{
			public const string Css = "text/css";
			public const string Html = "text/html; charset=UTF-8";
			public const string Json = "application/json";
			public const string Javascript = "application/javascript";
			public const string Png = "image/png";
			public const string Svg = "image/svg+xml";

			public static string ForExtension(string extension)
			{
				return extension switch
				{
					".css" => Css,
					".js" => Javascript,
					".json" => Json,
					".png" => Png,
					".svg" => Svg,
					_ => "",
				};
			}
		}

		private static void Render200(HttpListenerContext context, JToken json)
		{
			Render200(context, ContentTypes.Json, JsonConvert.SerializeObject(json));
		}

		private static void Render200(HttpListenerContext context, string contentType, string s)
		{
#if DEBUG
			Main.Log("Render200");
#endif
			context.Response.ContentType = contentType;
			var bytes = Encoding.UTF8.GetBytes(s);
			if (bytes.Length > 128 && (context.Request.Headers.GetValues("Accept-Encoding")?.Contains("gzip") ?? false))
			{
				context.Response.Headers.Add("Content-Encoding", "gzip");
				var mem = new MemoryStream(bytes);
				using var gzip = new GZipStream(context.Response.OutputStream, CompressionMode.Compress);
				mem.CopyTo(gzip);
			}
			else
			{
				context.Response.Close(bytes, false);
			}
		}

		private static void RenderEmpty(HttpListenerContext context, int statusCode)
		{
			context.Response.StatusCode = statusCode;
			context.Response.Close();
		}
	}
}
