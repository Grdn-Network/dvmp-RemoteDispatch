using Newtonsoft.Json.Linq;
using System.Collections.Concurrent;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// Shared coordination state for the Logistics Officer board: which dispatcher
    /// has claimed each job, its status, and a free-text note. In-memory, broadcast
    /// to all clients through the session/dirty-tag machinery (tag "jobboard"), so
    /// the board stays in sync between everyone. Resets on host restart.
    /// </summary>
    public static class JobBoard
    {
        private class JobState
        {
            public string assignee = "";
            public string status = "claimed";
            public string note = "";
        }

        private static readonly ConcurrentDictionary<string, JobState> jobs =
            new ConcurrentDictionary<string, JobState>();

        /// <summary>Claim a job; succeeds if unassigned or already the caller's.</summary>
        public static bool Claim(string jobId, string user)
        {
            if (string.IsNullOrEmpty(jobId) || string.IsNullOrEmpty(user)) return false;
            var winner = jobs.AddOrUpdate(jobId,
                _ => new JobState { assignee = user, status = "claimed" },
                (_, cur) =>
                {
                    if (string.IsNullOrEmpty(cur.assignee) || cur.assignee == user)
                    {
                        cur.assignee = user;
                        if (string.IsNullOrEmpty(cur.status)) cur.status = "claimed";
                    }
                    return cur;
                });
            var ok = winner.assignee == user;
            if (ok) Sessions.AddTag("jobboard");
            return ok;
        }

        public static void Release(string jobId, string user)
        {
            if (jobs.TryGetValue(jobId, out var s) && s.assignee == user
                && jobs.TryRemove(jobId, out _))
                Sessions.AddTag("jobboard");
        }

        public static bool SetStatus(string jobId, string user, string status)
        {
            if (jobs.TryGetValue(jobId, out var s) && s.assignee == user)
            {
                s.status = status ?? "";
                Sessions.AddTag("jobboard");
                return true;
            }
            return false;
        }

        public static bool SetNote(string jobId, string user, string note)
        {
            if (jobs.TryGetValue(jobId, out var s) && s.assignee == user)
            {
                s.note = note ?? "";
                Sessions.AddTag("jobboard");
                return true;
            }
            return false;
        }

        public static JObject GetStateJObject()
        {
            var o = new JObject();
            foreach (var kv in jobs)
            {
                o[kv.Key] = new JObject
                {
                    ["assignee"] = kv.Value.assignee,
                    ["status"] = kv.Value.status,
                    ["note"] = kv.Value.note,
                };
            }
            return new JObject { ["jobs"] = o };
        }
    }
}
