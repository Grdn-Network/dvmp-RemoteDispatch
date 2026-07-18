using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch
{
    public static class PlayerData
    {
        private static World.Position previousPosition;
        private static float previousRotation;

        public static void CheckTransform()
        {
            var transform = PlayerManager.PlayerTransform;
            if (transform == null)
                return;
            var position = new World.Position(transform.position - WorldMover.currentMove);
            var rotation = transform.eulerAngles.y;
            if (!(
                ApproximatelyEquals(previousPosition.x, position.x)
                && ApproximatelyEquals(previousPosition.z, position.z)
                && ApproximatelyEquals(previousRotation, rotation)))
            {
                Sessions.AddTag("player");
                previousPosition = position;
                previousRotation = rotation;
            }
        }

        private static bool ApproximatelyEquals(float f1, float f2)
        {
            var delta = f1 - f2;
            return delta > -1e-3 && delta < 1e-3;
        }

        private static string GetLocalSteamName()
        {
            try
            {
                // https://wiki.facepunch.com/steamworks/SteamClient
                return Steamworks.SteamClient.Name ?? "steam name unknown";
            }
            catch
            {
                return "unknown";
            }
        }

        public static JObject GetPlayerData()
        {
            CheckTransform();
            var res = new JObject();

            res[GetLocalSteamName()] = new JObject(
                // Do not change this format, it gets patched by the MP mod to add all client players
                new JProperty("color", "aqua"),
                new JProperty("position", previousPosition.ToLatLon().ToJson()),
                new JProperty("rotation", Math.Round(previousRotation, 2))
            );
            return res;
        }

        // Loco labels on player blips: "[L-014] Guardian". The cache is rebuilt about
        // once a second on the Unity main thread (Updater); decoration then runs safely
        // on HTTP/websocket threads against the immutable snapshot. Decoration happens
        // AFTER GetPlayerData so the MP mod's patch has already added every client.
        private const float PREFIX_RANGE_METERS = 30f;
        private const float DEGREES_PER_METER = 360f / 40e6f; // matches World.LatLon
        private static volatile List<LocoBlip>? locoCache;

        private sealed class LocoBlip
        {
            public string Id = "";
            public float Lat;
            public float Lon;
        }

        /// <summary>Main thread only: snapshot every locomotive's id and position.</summary>
        public static void RefreshLocoCache()
        {
            try
            {
                var list = new List<LocoBlip>();
                var registry = TrainCarRegistry.Instance;
                if (registry != null)
                {
                    foreach (var kv in registry.logicCarToTrainCar)
                    {
                        var trainCar = kv.Value;
                        if (trainCar == null || !trainCar.IsLoco)
                            continue;
                        var ll = new World.Position(trainCar.transform.position - WorldMover.currentMove).ToLatLon();
                        list.Add(new LocoBlip { Id = trainCar.ID, Lat = ll.latitude, Lon = ll.longitude });
                    }
                }
                locoCache = list;
            }
            catch (Exception e)
            {
                Main.DebugLog($"loco cache refresh failed: {e.Message}");
            }
        }

        private static string? NearestLocoId(float lat, float lon)
        {
            var cache = locoCache;
            if (cache == null)
                return null;
            float limit = PREFIX_RANGE_METERS * DEGREES_PER_METER;
            float bestSq = limit * limit;
            string? best = null;
            foreach (var loco in cache)
            {
                float dLat = loco.Lat - lat;
                float dLon = loco.Lon - lon;
                float dSq = dLat * dLat + dLon * dLon;
                if (dSq < bestSq)
                {
                    bestSq = dSq;
                    best = loco.Id;
                }
            }
            return best;
        }

        /// <summary>
        /// Player blips with the locomotive they are riding prefixed to their name.
        /// Reads the MP-patched GetPlayerData result, so every client gets decorated.
        /// </summary>
        public static JObject GetDecoratedPlayerData()
        {
            var raw = GetPlayerData();
            try
            {
                var decorated = new JObject();
                foreach (var prop in raw.Properties())
                {
                    var name = prop.Name;
                    if (prop.Value is JObject entry && entry["position"] is JArray pos && pos.Count >= 2)
                    {
                        var locoId = NearestLocoId((float)pos[0], (float)pos[1]);
                        if (locoId != null)
                            name = $"[{locoId}] {name}";
                    }
                    decorated[name] = prop.Value;
                }
                return decorated;
            }
            catch (Exception e)
            {
                Main.DebugLog($"player decoration failed: {e.Message}");
                return raw;
            }
        }

        public static string GetPlayerDataJson()
        {
            return JsonConvert.SerializeObject(GetDecoratedPlayerData());
        }
    }
}
