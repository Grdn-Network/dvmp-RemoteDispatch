using DV.Logic.Job;
using HarmonyLib;
using System;
using System.Reflection;
using UnityModManagerNet;

namespace DvMod.RemoteDispatch
{
    [EnableReloading]
    public static class Main
    {
        public static UnityModManager.ModEntry? mod;

        public static Settings settings = new Settings();
        public static bool enabled;
        private static Action<Job>? attachedJobChangedHandler;

        static public bool Load(UnityModManager.ModEntry modEntry)
        {
            mod = modEntry;

            try
            {
                var loaded = Settings.Load<Settings>(modEntry);
                if (loaded.version == modEntry.Info.Version)
                    settings = loaded;
            }
            catch
            {
            }

            mod.OnGUI = OnGUI;
            mod.OnSaveGUI = OnSaveGUI;
            mod.OnToggle = OnToggle;

            return true;
        }

        private static void OnGUI(UnityModManager.ModEntry modEntry)
        {
            settings.Draw();
        }

        private static void OnSaveGUI(UnityModManager.ModEntry modEntry)
        {
            settings.Save(modEntry);
            Sessions.AddTag("cars");
        }

        private static bool OnToggle(UnityModManager.ModEntry modEntry, bool value)
        {
            Harmony harmony = new Harmony(modEntry.Info.Id);

            if (value)
            {
                harmony.PatchAll();
                WorldStreamingInit.LoadingFinished += Start;
                UnloadWatcher.UnloadRequested += Stop;
                ConnectToPersistentJobs();
                if (WorldStreamingInit.Instance && WorldStreamingInit.IsLoaded)
                {
                    Start();
                }
            }
            else
            {
                Stop();
                UnloadWatcher.UnloadRequested -= Stop;
                WorldStreamingInit.LoadingFinished -= Start;
                DisconnectFromPersistentJobs();
                harmony.UnpatchAll(modEntry.Info.Id);
            }
            return true;
        }

        private static void DisconnectFromPersistentJobs()
        {
            EventInfo? jobTracksChanged = GetPersistentJobsTrackChangedEvent();
            if (jobTracksChanged != null && attachedJobChangedHandler != null)
            {
                jobTracksChanged.RemoveEventHandler(null, attachedJobChangedHandler);
                attachedJobChangedHandler = null;
                DebugLog("Persistent Jobs event handler removed");
            }
        }

        private static void ConnectToPersistentJobs()
        {
            EventInfo? jobTracksChanged = GetPersistentJobsTrackChangedEvent();
            if (jobTracksChanged != null)
            {
                attachedJobChangedHandler = new Action<Job>(JobData.JobPatches.UpdateJobsFromPersistentJobs);
                jobTracksChanged.AddEventHandler(null, attachedJobChangedHandler);
                DebugLog("Persistent Jobs found and hooked");
            }
        }

        /// <summary>Gets event exposed by Persistent Jobs for notifications when jobs are modified.</summary>
        /// <returns>Persistent Jobs mod track changed event if installed, otherwise null.</returns>
        private static EventInfo? GetPersistentJobsTrackChangedEvent()
        {
            return UnityModManager.FindMod("PersistentJobsMod")
                ?.Assembly
                ?.GetType("PersistentJobsModInteractionFeatures")
                ?.GetEvent("JobTracksChanged");
        }

        private static void Start()
        {
            // Start() is only called once WorldStreamingInit.IsLoaded is true.
            // Only run the dispatch server on the host (or in singleplayer): clients just
            // point a browser at the host's instance, so running the server + 4 Hz updater
            // on every client only lags their game. The override lets a client self-host
            // when the host's link is down (takes effect on the next world load).
            if (!(IsHostOrSingleplayer() || settings.runServerAsClientFallback))
            {
                Main.Log("RemoteDispatch: multiplayer client and 'run as client' override is off — not starting the dispatch server.");
                return;
            }
            HttpServer.Create();
            Updater.Create();
            CarUpdater.Start();
            SignalsShim.Initialize();
        }

        /// <summary>
        /// True if this instance is the multiplayer host, or if multiplayer is not loaded
        /// (singleplayer). Uses reflection so RemoteDispatch keeps zero compile-time
        /// dependency on the Multiplayer mod. Fails open to true so non-multiplayer players
        /// still get RemoteDispatch.
        /// </summary>
        private static bool IsHostOrSingleplayer()
        {
            try
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (!asm.GetName().Name.StartsWith("Multiplayer", StringComparison.OrdinalIgnoreCase))
                        continue;

                    Type? apiType = null;
                    foreach (var t in asm.GetExportedTypes())
                    {
                        if (t.Name == "MultiplayerAPI")
                        {
                            apiType = t;
                            break;
                        }
                    }
                    if (apiType == null)
                        continue;

                    // IsMultiplayerLoaded == false -> singleplayer even with the mod installed.
                    var isLoadedProp = apiType.GetProperty("IsMultiplayerLoaded", BindingFlags.Public | BindingFlags.Static);
                    if (isLoadedProp != null && !(bool)isLoadedProp.GetValue(null))
                        return true;

                    // Prefer Instance.IsHost / Instance.IsSinglePlayer.
                    var instance = apiType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
                    if (instance != null)
                    {
                        var instanceType = instance.GetType();
                        if (instanceType.GetProperty("IsSinglePlayer")?.GetValue(instance) as bool? == true)
                            return true;
                        var isHost = instanceType.GetProperty("IsHost")?.GetValue(instance) as bool?;
                        if (isHost.HasValue)
                            return isHost.Value;
                    }

                    // Fallback: Server != null -> hosting.
                    var serverProp = apiType.GetProperty("Server", BindingFlags.Public | BindingFlags.Static);
                    if (serverProp != null)
                        return serverProp.GetValue(null) != null;

                    // Multiplayer API found but shape unrecognised -> don't start on a client, to be safe.
                    return false;
                }

                // Multiplayer assembly not loaded at all -> singleplayer.
                return true;
            }
            catch
            {
                return true; // fail open
            }
        }

        private static void Stop()
        {
            CarUpdater.Stop();
            Updater.Destroy();
            HttpServer.Destroy();
            SignalsShim.Teardown();
        }

        public static void Log(string message)
        {
            mod?.Logger.Log(message);
        }

        public static void DebugLog(string message)
        {
            if (settings.enableLogging)
                mod?.Logger.Log(message);
        }

        public static void Warning(string message)
        {
            mod?.Logger.Warning(message);
        }
    }
}
