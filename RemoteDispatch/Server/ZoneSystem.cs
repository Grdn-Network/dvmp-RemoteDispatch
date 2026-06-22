using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// Territorial dispatch control. Zones are authored in the embedded zones.json
    /// and group junctions (by their integer index, as used by /junction/{i}/toggle)
    /// and signals (by id). A zone may be claimed by one dispatcher; while claimed,
    /// only its owner may throw the junctions / set the signals inside it. Resources
    /// not assigned to any zone, or in an unclaimed zone, are unrestricted (subject
    /// to the existing base permissions).
    ///
    /// Ownership is in-memory and resets on host restart. There is no auto-release on
    /// disconnect (a dispatcher with multiple tabs would otherwise lose zones on one
    /// tab close); zones are released explicitly or freed by a restart.
    /// </summary>
    public static class ZoneSystem
    {
        public class ZoneConfig
        {
            public string id = "";
            public string name = "";
            public string color = "#888888";
            public List<int> junctionIds = new List<int>();
            public List<string> signalIds = new List<string>();
        }

        private static readonly object zonesLock = new object();
        private static List<ZoneConfig> zones = new List<ZoneConfig>();
        private static readonly Dictionary<int, string> junctionZone = new Dictionary<int, string>();
        private static readonly Dictionary<string, string> signalZone = new Dictionary<string, string>();

        // zoneId -> owning username. Presence means owned; absence means unclaimed.
        private static readonly ConcurrentDictionary<string, string> ownership =
            new ConcurrentDictionary<string, string>();

        /// <summary>Load zone definitions from the embedded zones.json. Safe if missing.</summary>
        public static void Load()
        {
            try
            {
                var assembly = typeof(ZoneSystem).Assembly;
                using var stream = assembly.GetManifestResourceStream(typeof(HttpServer), "zones.json");
                if (stream == null)
                {
                    Main.Log("ZoneSystem: zones.json not found; zone control disabled.");
                    return;
                }
                using var reader = new StreamReader(stream);
                var parsed = JObject.Parse(reader.ReadToEnd());
                var arr = parsed["zones"] as JArray ?? new JArray();

                var list = new List<ZoneConfig>();
                foreach (var z in arr)
                {
                    list.Add(new ZoneConfig
                    {
                        id = (string?)z["id"] ?? "",
                        name = (string?)z["name"] ?? "",
                        color = (string?)z["color"] ?? "#888888",
                        junctionIds = (z["junctionIds"] as JArray)?.Select(t => (int)t).ToList()
                            ?? new List<int>(),
                        signalIds = (z["signalIds"] as JArray)?.Select(t => (string)t!).ToList()
                            ?? new List<string>(),
                    });
                }

                lock (zonesLock)
                {
                    zones = list;
                    junctionZone.Clear();
                    signalZone.Clear();
                    foreach (var z in zones)
                    {
                        foreach (var j in z.junctionIds) junctionZone[j] = z.id;
                        foreach (var s in z.signalIds) signalZone[s] = z.id;
                    }
                }
                Main.Log($"ZoneSystem: loaded {list.Count} dispatch zones.");
            }
            catch (Exception e)
            {
                Main.Warning($"ZoneSystem: failed to load zones.json: {e.Message}");
            }
        }

        public static string? ZoneForJunction(int junctionId)
        {
            lock (zonesLock)
                return junctionZone.TryGetValue(junctionId, out var z) ? z : null;
        }

        public static string? ZoneForSignal(string signalId)
        {
            lock (zonesLock)
                return signalZone.TryGetValue(signalId, out var z) ? z : null;
        }

        public static bool CanControlJunction(string username, int junctionId) =>
            CanControl(username, ZoneForJunction(junctionId));

        public static bool CanControlSignal(string username, string signalId) =>
            CanControl(username, ZoneForSignal(signalId));

        private static bool CanControl(string username, string? zoneId)
        {
            if (zoneId == null) return true; // not zoned
            if (!ownership.TryGetValue(zoneId, out var owner) || string.IsNullOrEmpty(owner))
                return true; // unclaimed zone is free
            return owner == username;
        }

        /// <summary>Claim a zone. Succeeds if unclaimed or already owned by the caller.</summary>
        public static bool TryClaim(string username, string zoneId)
        {
            if (string.IsNullOrEmpty(username)) return false;
            lock (zonesLock)
                if (!zones.Any(z => z.id == zoneId)) return false;

            // Atomic: add if absent, otherwise keep the existing owner. Caller wins only
            // if the resulting owner is them.
            var winner = ownership.AddOrUpdate(zoneId, username, (_, cur) => cur == username ? username : cur);
            var ok = winner == username;
            if (ok) Sessions.AddTag("zones");
            return ok;
        }

        public static void Release(string username, string zoneId)
        {
            if (ownership.TryGetValue(zoneId, out var owner) && owner == username
                && ownership.TryRemove(zoneId, out _))
                Sessions.AddTag("zones");
        }

        /// <summary>Reassign a zone to a new owner (used when a train transfer is accepted).</summary>
        public static void ForceAssign(string username, string zoneId)
        {
            if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(zoneId)) return;
            bool exists;
            lock (zonesLock) exists = zones.Any(z => z.id == zoneId);
            if (!exists) return;
            ownership[zoneId] = username;
            Sessions.AddTag("zones");
        }

        public static JObject GetZoneStateJObject()
        {
            var zonesObj = new JObject();
            lock (zonesLock)
            {
                foreach (var z in zones)
                {
                    ownership.TryGetValue(z.id, out var owner);
                    zonesObj[z.id] = new JObject
                    {
                        ["name"] = z.name,
                        ["color"] = z.color,
                        ["owner"] = string.IsNullOrEmpty(owner) ? null : owner,
                    };
                }
            }
            return new JObject { ["zones"] = zonesObj };
        }
    }
}
