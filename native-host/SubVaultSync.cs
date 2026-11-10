using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace SubVaultSync
{
    internal static class Bootstrap
    {
        private static void Main(string[] args)
        {
            try
            {
                Program.Run(args);
            }
            catch (Exception error)
            {
                try
                {
                    File.WriteAllText(
                        Path.Combine(Path.GetTempPath(), "SubVaultSync-host-error.log"),
                        error.ToString());
                }
                catch
                {
                }
            }
        }
    }

    internal static class Program
    {
        public static void Run(string[] args)
        {
            MainCore(args);
        }
        private static readonly object OutputLock = new object();
        private static JavaScriptSerializer jsonSerializer;
        private static JavaScriptSerializer Json
        {
            get
            {
                if (jsonSerializer == null)
                    jsonSerializer = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
                return jsonSerializer;
            }
        }
        private static readonly string DataDir = ResolveDataDir();

        private static string ResolveDataDir()
        {
            string custom = Environment.GetEnvironmentVariable("SUBVAULT_SYNC_DIR");
            if (!String.IsNullOrEmpty(custom)) return custom;

            // Prefer the host's own folder. This works when the host is extracted
            // to a writable user folder and avoids restricted-profile ACLs.
            try
            {
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                string probe = Path.Combine(exeDir, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return Path.Combine(exeDir, "data");
            }
            catch
            {
            }

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SubVaultSync");
        }
        private static readonly string StatePath = Path.Combine(DataDir, "state.json");
        private static readonly Mutex StateMutex = new Mutex(false, "Local\\SubVaultSyncState");
        private static long lastAnnouncedRevision = -1;

        private static Dictionary<string, object> ReadState()
        {
            if (!File.Exists(StatePath)) return null;
            for (int attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    using (var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        var parsed = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        if (parsed == null) return null;
                        if (!parsed.ContainsKey("revision")) parsed["revision"] = 0;
                        if (!parsed.ContainsKey("updatedAt")) parsed["updatedAt"] = 0;
                        if (!parsed.ContainsKey("ignores")) parsed["ignores"] = new object[0];
                        return parsed;
                    }
                }
                catch (IOException)
                {
                    Thread.Sleep(50);
                }
                catch (UnauthorizedAccessException)
                {
                    Thread.Sleep(50);
                }
            }
            return null;
        }

        private static long Revision(Dictionary<string, object> state)
        {
            if (state == null || !state.ContainsKey("revision")) return 0;
            return Convert.ToInt64(state["revision"]);
        }

        private static void WriteState(Dictionary<string, object> state)
        {
            Directory.CreateDirectory(DataDir);
            string temp = StatePath + ".tmp";
            File.WriteAllText(temp, Json.Serialize(state), new UTF8Encoding(false));
            if (File.Exists(StatePath))
            {
                string backup = StatePath + ".bak";
                try { File.Replace(temp, StatePath, backup); }
                catch (PlatformNotSupportedException) { File.Delete(StatePath); File.Move(temp, StatePath); }
                catch (IOException) { File.Delete(StatePath); File.Move(temp, StatePath); }
                if (File.Exists(backup)) File.Delete(backup);
            }
            else
            {
                File.Move(temp, StatePath);
            }
        }

        private static Dictionary<string, object> WithState(Action<Dictionary<string, object>> action)
        {
            if (!StateMutex.WaitOne(5000))
                return Error("同步宿主正忙，请稍后重试");
            try
            {
                var state = ReadState();
                action(state);
                return null;
            }
            finally
            {
                StateMutex.ReleaseMutex();
            }
        }

        private static Dictionary<string, object> Status()
        {
            var state = ReadState();
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "exists", state != null },
                { "revision", Revision(state) },
                { "updatedAt", state != null && state.ContainsKey("updatedAt") ? state["updatedAt"] : 0 },
                { "path", StatePath }
            };
        }

        private static Dictionary<string, object> Pull()
        {
            var state = ReadState();
            if (state == null)
                return new Dictionary<string, object> { { "ok", true }, { "exists", false } };
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "exists", true },
                { "revision", Revision(state) },
                { "updatedAt", state.ContainsKey("updatedAt") ? state["updatedAt"] : 0 },
                { "vault", state.ContainsKey("vault") ? state["vault"] : null },
                { "settings", state.ContainsKey("settings") ? state["settings"] : null },
                { "ignores", state.ContainsKey("ignores") ? state["ignores"] : new object[0] }
            };
        }

        private static Dictionary<string, object> Publish(Dictionary<string, object> message)
        {
            if (!message.ContainsKey("vault") || message["vault"] == null)
                return Error("缺少加密密码库数据");
            long baseRevision = message.ContainsKey("baseRevision")
                ? Convert.ToInt64(message["baseRevision"])
                : 0;
            Dictionary<string, object> response = null;

            var error = WithState(state =>
            {
                long current = Revision(state);
                if (baseRevision != current)
                {
                    response = new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "conflict", true },
                        { "revision", current },
                        { "updatedAt", state != null && state.ContainsKey("updatedAt") ? state["updatedAt"] : 0 }
                    };
                    return;
                }
                var next = state ?? new Dictionary<string, object>();
                next["revision"] = current + 1;
                next["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                next["vault"] = message["vault"];
                next["settings"] = message.ContainsKey("settings") ? message["settings"] : null;
                next["ignores"] = message.ContainsKey("ignores") ? message["ignores"] : new object[0];
                WriteState(next);
                response = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "revision", current + 1 },
                    { "updatedAt", next["updatedAt"] }
                };
            });
            return error ?? response;
        }

        private static Dictionary<string, object> Error(string text)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", text } };
        }

        private static Dictionary<string, object> Handle(Dictionary<string, object> message)
        {
            string type = message.ContainsKey("type") ? Convert.ToString(message["type"]) : "";
            switch (type)
            {
                case "ping": return new Dictionary<string, object> { { "ok", true }, { "pong", true } };
                case "status": return Status();
                case "pull": return Pull();
                case "publish": return Publish(message);
                default: return Error("未知同步命令: " + type);
            }
        }

        private static void WriteMessage(Dictionary<string, object> message)
        {
            byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(message));
            byte[] header = BitConverter.GetBytes(payload.Length);
            lock (OutputLock)
            {
                var stdout = Console.OpenStandardOutput();
                stdout.Write(header, 0, 4);
                stdout.Write(payload, 0, payload.Length);
                stdout.Flush();
            }
        }

        private static byte[] ReadExactly(Stream input, int count)
        {
            byte[] buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = input.Read(buffer, offset, count - offset);
                if (read <= 0) return null;
                offset += read;
            }
            return buffer;
        }

        private static void PollChanges()
        {
            while (true)
            {
                Thread.Sleep(900);
                try
                {
                    var state = ReadState();
                    long revision = Revision(state);
                    if (revision > 0 && revision != lastAnnouncedRevision)
                    {
                        lastAnnouncedRevision = revision;
                        WriteMessage(new Dictionary<string, object>
                        {
                            { "type", "change" },
                            { "revision", revision },
                            { "updatedAt", state.ContainsKey("updatedAt") ? state["updatedAt"] : 0 }
                        });
                    }
                }
                catch
                {
                    // Polling must never terminate the native host.
                }
            }
        }

        private static void MainCore(string[] args)
        {
            Directory.CreateDirectory(DataDir);
            var initial = ReadState();
            lastAnnouncedRevision = Revision(initial);
            var poll = new Thread(PollChanges) { IsBackground = true, Name = "SubVaultSyncPoll" };
            poll.Start();

            var stdin = Console.OpenStandardInput();
            while (true)
            {
                byte[] header = ReadExactly(stdin, 4);
                if (header == null) break;
                int length = BitConverter.ToInt32(header, 0);
                if (length <= 0 || length > 32 * 1024 * 1024) break;
                byte[] payload = ReadExactly(stdin, length);
                if (payload == null) break;
                Dictionary<string, object> response;
                try
                {
                    var message = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
                    response = Handle(message ?? new Dictionary<string, object>());
                    if (message != null && message.ContainsKey("id"))
                        response["id"] = message["id"];
                }
                catch (Exception error)
                {
                    response = Error(error.Message);
                }
                WriteMessage(response);
            }
        }
    }
}
