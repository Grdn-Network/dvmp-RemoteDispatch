using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch
{
    /// <summary>
    /// Shared dispatcher collaboration: one common notepad (last-write-wins) and a
    /// capped chat log. Both are broadcast as full state (the whole notepad / the whole
    /// recent log) so the dirty-tag coalescing in <see cref="Sessions"/> never drops a
    /// message. In-memory only; resets on host restart.
    /// </summary>
    public static class DispatchCollab
    {
        private static readonly object gate = new object();

        private static string notes = "";

        private struct ChatMessage
        {
            public string User;
            public string Text;
            public long Ts;
        }

        private const int MaxChat = 200;
        private static readonly List<ChatMessage> chat = new List<ChatMessage>();

        public static void UpdateNotes(string content)
        {
            lock (gate) notes = content ?? "";
            Sessions.AddTag("notes");
        }

        public static JObject GetNotesJObject()
        {
            lock (gate) return new JObject { ["content"] = notes };
        }

        public static void PostChat(string user, string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            var msg = new ChatMessage
            {
                User = string.IsNullOrEmpty(user) ? "anon" : user,
                Text = text,
                Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            lock (gate)
            {
                chat.Add(msg);
                while (chat.Count > MaxChat) chat.RemoveAt(0);
            }
            Sessions.AddTag("chat");
        }

        public static JObject GetChatJObject()
        {
            var arr = new JArray();
            lock (gate)
            {
                foreach (var m in chat)
                    arr.Add(new JObject { ["user"] = m.User, ["text"] = m.Text, ["ts"] = m.Ts });
            }
            return new JObject { ["messages"] = arr };
        }
    }
}
