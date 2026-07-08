using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// Train transfer ("xfer") offers between dispatchers. The dispatcher handing a
    /// train over creates an offer addressed to another user; the recipient accepts or
    /// rejects. Accepting reassigns the destination zone to the recipient.
    ///
    /// Offers expire after 60s. There is no server timer — offers are pruned lazily on
    /// any access, and each offer carries its expiry so clients can self-hide a lapsed
    /// banner. State is in-memory and resets on host restart.
    /// </summary>
    public static class XferSystem
    {
        private class XferOffer
        {
            public string offerId = "";
            public string trainId = "";
            public string fromZone = "";
            public string toZone = "";
            public string fromUser = "";
            public string toUser = "";
            public DateTime expiresAt;
        }

        private static readonly ConcurrentDictionary<string, XferOffer> offers =
            new ConcurrentDictionary<string, XferOffer>();
        private static readonly TimeSpan OfferTtl = TimeSpan.FromSeconds(60);

        public static string CreateOffer(string trainId, string fromZone, string toZone,
            string fromUser, string toUser)
        {
            PruneExpired();
            var offer = new XferOffer
            {
                offerId = Guid.NewGuid().ToString("N"),
                trainId = trainId ?? "",
                fromZone = fromZone ?? "",
                toZone = toZone ?? "",
                fromUser = fromUser ?? "",
                toUser = toUser ?? "",
                expiresAt = DateTime.UtcNow + OfferTtl,
            };
            offers[offer.offerId] = offer;
            Sessions.AddTag("xfer");
            return offer.offerId;
        }

        /// <summary>Accept an offer; only the addressed recipient may. Reassigns toZone.</summary>
        public static bool TryAccept(string offerId, string username)
        {
            PruneExpired();
            if (!offers.TryGetValue(offerId, out var offer)) return false;
            if (offer.toUser != username) return false;
            offers.TryRemove(offerId, out _);
            if (!string.IsNullOrEmpty(offer.toZone))
                ZoneSystem.ForceAssign(username, offer.toZone);
            Sessions.AddTag("xfer");
            return true;
        }

        public static bool TryReject(string offerId, string username)
        {
            if (!offers.TryGetValue(offerId, out var offer)) return false;
            if (offer.toUser != username) return false;
            offers.TryRemove(offerId, out _);
            Sessions.AddTag("xfer");
            return true;
        }

        private static void PruneExpired()
        {
            var now = DateTime.UtcNow;
            var changed = false;
            foreach (var kvp in offers)
            {
                if (kvp.Value.expiresAt < now && offers.TryRemove(kvp.Key, out _))
                    changed = true;
            }
            if (changed) Sessions.AddTag("xfer");
        }

        public static JObject GetStateJObject()
        {
            PruneExpired();
            var arr = new JArray();
            foreach (var o in offers.Values.OrderBy(o => o.expiresAt))
            {
                arr.Add(new JObject
                {
                    ["offerId"] = o.offerId,
                    ["trainId"] = o.trainId,
                    ["fromZone"] = o.fromZone,
                    ["toZone"] = o.toZone,
                    ["fromUser"] = o.fromUser,
                    ["toUser"] = o.toUser,
                    ["expiresAt"] = new DateTimeOffset(o.expiresAt).ToUnixTimeMilliseconds(),
                });
            }
            return new JObject { ["offers"] = arr };
        }
    }
}
