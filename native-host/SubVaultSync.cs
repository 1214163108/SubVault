using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
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

            // The vault must not live next to the host binary: reinstalling or
            // moving the host would silently look like "vault disappeared" and
            // the other browser would fail to decrypt whatever replaced it.
            string stable = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SubVaultSync");
            try
            {
                Directory.CreateDirectory(stable);
                string probe = Path.Combine(stable, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                MigrateLegacyData(stable);
                return stable;
            }
            catch
            {
            }

            // A locked-down profile: fall back to the host folder so sync still
            // works for this install.
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

            return Path.Combine(Path.GetTempPath(), "SubVaultSync");
        }

        /// <summary>
        /// Builds up to 1.5.x kept the vault in a "data" folder beside the host
        /// binary. Copy that state into the stable folder once, so upgrading or
        /// reinstalling the host never loses the vault.
        /// </summary>
        private static void MigrateLegacyData(string stableDir)
        {
            try
            {
                string legacyDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
                if (!Directory.Exists(legacyDir)) return;
                foreach (string source in Directory.GetFiles(legacyDir, "*.json"))
                {
                    string target = Path.Combine(stableDir, Path.GetFileName(source));
                    if (File.Exists(target)) continue;
                    try { File.Copy(source, target, false); }
                    catch { }
                }
            }
            catch
            {
            }
        }
        private static readonly string StatePath = Path.Combine(DataDir, "state.json");
        private static readonly Mutex StateMutex = new Mutex(false, "Local\\SubVaultSyncState");
        private static long lastAnnouncedRevision = -1;

        private static string VaultKeyFrom(Dictionary<string, object> message)
        {
            string raw = message != null && message.ContainsKey("vaultId")
                ? Convert.ToString(message["vaultId"]) ?? ""
                : "";
            var builder = new StringBuilder();
            foreach (char ch in raw.Trim().ToLowerInvariant())
            {
                if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_')
                    builder.Append(ch);
                if (builder.Length >= 64) break;
            }
            return builder.ToString();
        }

        private static string StatePathFor(string key)
        {
            if (String.IsNullOrEmpty(key) || key == "default") return StatePath;
            return Path.Combine(DataDir, "vault-" + key + ".json");
        }

        private static Dictionary<string, object> ReadState(string path)
        {
            if (!File.Exists(path)) return null;
            for (int attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
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

        private static void WriteState(string path, Dictionary<string, object> state)
        {
            Directory.CreateDirectory(DataDir);
            string temp = path + ".tmp";
            File.WriteAllText(temp, Json.Serialize(state), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                string backup = path + ".bak";
                try { File.Replace(temp, path, backup); }
                catch (PlatformNotSupportedException) { File.Delete(path); File.Move(temp, path); }
                catch (IOException) { File.Delete(path); File.Move(temp, path); }
                if (File.Exists(backup)) File.Delete(backup);
            }
            else
            {
                File.Move(temp, path);
            }
        }

        private static Dictionary<string, object> WithState(string path, Action<Dictionary<string, object>> action)
        {
            if (!StateMutex.WaitOne(5000))
                return Error("同步宿主正忙，请稍后重试");
            try
            {
                var state = ReadState(path);
                action(state);
                return null;
            }
            finally
            {
                StateMutex.ReleaseMutex();
            }
        }

        private static Dictionary<string, object> Status(Dictionary<string, object> message)
        {
            string path = StatePathFor(VaultKeyFrom(message));
            var state = ReadState(path);
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "exists", state != null },
                { "revision", Revision(state) },
                { "updatedAt", state != null && state.ContainsKey("updatedAt") ? state["updatedAt"] : 0 },
                { "path", path }
            };
        }

        private static Dictionary<string, object> Pull(Dictionary<string, object> message)
        {
            string path = StatePathFor(VaultKeyFrom(message));
            var state = ReadState(path);
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

            string path = StatePathFor(VaultKeyFrom(message));
            var error = WithState(path, state =>
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
                WriteState(path, next);
                response = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "revision", current + 1 },
                    { "updatedAt", next["updatedAt"] }
                };
            });
            return error ?? response;
        }

        // ------------------------------------------------------------------
        // Optional WebDAV transport
        //
        // Credentials arrive per command and are never written to disk. The
        // fixed path is <base>/subvault/state.json; HTTPS is required except
        // for loopback testing. ETag / If-Match protects concurrent writers.
        // ------------------------------------------------------------------

        private sealed class WebDavResult
        {
            public int Status;
            public string ETag = "";
            public byte[] Body = new byte[0];
        }

        private static string WebDavRelativeFor(string key)
        {
            if (String.IsNullOrEmpty(key) || key == "default") return "/subvault/state.json";
            return "/subvault/" + key + "/state.json";
        }

        private static string WebDavEndpoint(string raw, string key)
        {
            Uri uri;
            if (String.IsNullOrWhiteSpace(raw) || !Uri.TryCreate(raw.Trim(), UriKind.Absolute, out uri) || String.IsNullOrEmpty(uri.Host))
                throw new InvalidOperationException("WebDAV 地址格式不正确");
            if (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback))
                throw new InvalidOperationException("WebDAV 地址必须使用 HTTPS（本机测试可用 http://127.0.0.1）");
            var builder = new UriBuilder(uri);
            builder.Path = builder.Path.TrimEnd('/') + WebDavRelativeFor(key);
            builder.Query = "";
            builder.Fragment = "";
            return builder.Uri.ToString();
        }

        private static string WebDavEndpointFromMessage(Dictionary<string, object> message, out string user, out string password)
        {
            user = "";
            password = "";
            var config = message.ContainsKey("config") ? message["config"] as Dictionary<string, object> : null;
            if (config == null) throw new InvalidOperationException("缺少 WebDAV 配置");
            if (config.ContainsKey("username")) user = Convert.ToString(config["username"]) ?? "";
            if (config.ContainsKey("password")) password = Convert.ToString(config["password"]) ?? "";
            if (user.Length > 256 || password.Length > 1024) throw new InvalidOperationException("WebDAV 凭据过长");
            return WebDavEndpoint(config.ContainsKey("url") ? Convert.ToString(config["url"]) : "", VaultKeyFrom(message));
        }

        private static WebDavResult WebDavRequest(string method, string endpoint, string user, string password, byte[] body, Dictionary<string, string> headers)
        {
            var request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Method = method;
            request.Timeout = 20000;
            request.ReadWriteTimeout = 20000;
            request.AllowAutoRedirect = true;
            request.MaximumAutomaticRedirections = 5;
            request.UserAgent = "SubVaultSync/1.1";
            request.Proxy = null;
            if (!String.IsNullOrEmpty(user) || !String.IsNullOrEmpty(password))
            {
                request.Headers["Authorization"] = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(user + ":" + password));
            }
            string contentType = body != null ? "application/json" : null;
            if (headers != null)
            {
                foreach (var pair in headers)
                {
                    if (String.Equals(pair.Key, "Accept", StringComparison.OrdinalIgnoreCase)) request.Accept = pair.Value;
                    else if (String.Equals(pair.Key, "Content-Type", StringComparison.OrdinalIgnoreCase)) contentType = pair.Value;
                    else if (String.Equals(pair.Key, "Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                    else if (String.Equals(pair.Key, "User-Agent", StringComparison.OrdinalIgnoreCase)) request.UserAgent = pair.Value;
                    else if (String.Equals(pair.Key, "Referer", StringComparison.OrdinalIgnoreCase)) request.Referer = pair.Value;
                    else request.Headers[pair.Key] = pair.Value;
                }
            }
            if (body != null)
            {
                request.ContentType = String.IsNullOrEmpty(contentType) ? "application/json" : contentType;
                request.ContentLength = body.Length;
                using (var stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            }
            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return ReadWebDavResponse(response);
                }
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                if (response == null) throw new InvalidOperationException("WebDAV 请求失败：" + error.Message);
                using (response) return ReadWebDavResponse(response);
            }
        }

        private static WebDavResult ReadWebDavResponse(HttpWebResponse response)
        {
            var result = new WebDavResult { Status = (int)response.StatusCode, ETag = response.Headers["ETag"] ?? "" };
            try
            {
                using (var stream = response.GetResponseStream())
                using (var memory = new MemoryStream())
                {
                    if (stream != null)
                    {
                        var buffer = new byte[81920];
                        int read;
                        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0 && memory.Length < 32 * 1024 * 1024)
                            memory.Write(buffer, 0, read);
                    }
                    result.Body = memory.ToArray();
                }
            }
            catch (IOException)
            {
                result.Body = new byte[0];
            }
            return result;
        }

        private static string WebDavFailure(WebDavResult result)
        {
            switch (result.Status)
            {
                case 401:
                case 403: return "WebDAV 认证失败，请检查用户名和密码";
                case 404: return "WebDAV 路径不存在：" + "/subvault/state.json";
                case 409: return "WebDAV 目录创建失败（HTTP 409）：请确认地址指向已存在且可写的目录，例如 https://dav.jianguoyun.com/dav";
            }
            string snippet = result.Body.Length > 0 ? Encoding.UTF8.GetString(result.Body).Trim() : "";
            if (snippet.Length > 200) snippet = snippet.Substring(0, 200);
            return snippet.Length > 0
                ? "WebDAV 返回 HTTP " + result.Status + "：" + snippet
                : "WebDAV 返回 HTTP " + result.Status;
        }

        private static Dictionary<string, object> ParseWebDavEnvelope(byte[] body)
        {
            Dictionary<string, object> envelope;
            try
            {
                envelope = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
            }
            catch
            {
                throw new InvalidOperationException("WebDAV 上的 SubVault 数据格式不正确");
            }
            if (envelope == null || !envelope.ContainsKey("vault") || envelope["vault"] == null)
                throw new InvalidOperationException("WebDAV 上的 SubVault 数据缺少密码库");
            return envelope;
        }

        private static Dictionary<string, object> WebDavStatus(Dictionary<string, object> message)
        {
            string user, password;
            string endpoint = WebDavEndpointFromMessage(message, out user, out password);
            string etag = message.ContainsKey("etag") ? Convert.ToString(message["etag"]) : "";
            var headers = new Dictionary<string, string> { { "Accept", "application/json" } };
            if (!String.IsNullOrEmpty(etag)) headers["If-None-Match"] = etag;
            var result = WebDavRequest("GET", endpoint, user, password, null, headers);
            if (result.Status == 304)
                return new Dictionary<string, object> { { "ok", true }, { "exists", true }, { "notModified", true }, { "etag", etag } };
            if (result.Status == 404)
                return new Dictionary<string, object> { { "ok", true }, { "exists", false }, { "etag", "" } };
            if (result.Status != 200) return Error(WebDavFailure(result));
            var envelope = ParseWebDavEnvelope(result.Body);
            return new Dictionary<string, object>
            {
                { "ok", true }, { "exists", true }, { "notModified", false },
                { "revision", envelope.ContainsKey("revision") ? envelope["revision"] : 0 },
                { "updatedAt", envelope.ContainsKey("updatedAt") ? envelope["updatedAt"] : 0 },
                { "etag", result.ETag }, { "path", endpoint }
            };
        }

        private static Dictionary<string, object> WebDavPull(Dictionary<string, object> message)
        {
            string user, password;
            string endpoint = WebDavEndpointFromMessage(message, out user, out password);
            var result = WebDavRequest("GET", endpoint, user, password, null, null);
            if (result.Status == 404)
                return new Dictionary<string, object> { { "ok", true }, { "exists", false } };
            if (result.Status == 304)
                return new Dictionary<string, object> { { "ok", true }, { "exists", false } };
            if (result.Status != 200) return Error(WebDavFailure(result));
            var envelope = ParseWebDavEnvelope(result.Body);
            return new Dictionary<string, object>
            {
                { "ok", true }, { "exists", true },
                { "revision", envelope.ContainsKey("revision") ? envelope["revision"] : 0 },
                { "updatedAt", envelope.ContainsKey("updatedAt") ? envelope["updatedAt"] : 0 },
                { "vault", envelope.ContainsKey("vault") ? envelope["vault"] : null },
                { "settings", envelope.ContainsKey("settings") ? envelope["settings"] : null },
                { "ignores", envelope.ContainsKey("ignores") ? envelope["ignores"] : new object[0] },
                { "etag", result.ETag }, { "path", endpoint }
            };
        }

        private static string WebDavBackupName(object value)
        {
            string name = Convert.ToString(value) ?? "";
            if (name.Length == 0 || name.Length > 120) return "";
            foreach (char c in name)
            {
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
                if (!ok) return "";
            }
            if (!name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return "";
            return name;
        }

        private static Dictionary<string, object> WebDavPush(Dictionary<string, object> message)
        {
            string user, password;
            string endpoint = WebDavEndpointFromMessage(message, out user, out password);
            if (!message.ContainsKey("vault") || message["vault"] == null)
                return Error("缺少加密密码库数据");
            long baseRevision = message.ContainsKey("baseRevision") ? Convert.ToInt64(message["baseRevision"]) : 0;
            string etag = message.ContainsKey("etag") ? Convert.ToString(message["etag"]) : "";
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var envelope = new Dictionary<string, object>
            {
                { "revision", baseRevision + 1 }, { "updatedAt", now },
                { "vault", message["vault"] },
                { "settings", message.ContainsKey("settings") ? message["settings"] : null },
                { "ignores", message.ContainsKey("ignores") ? message["ignores"] : new object[0] }
            };
            byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(envelope));
            var headers = new Dictionary<string, string>();
            if (!String.IsNullOrEmpty(etag)) headers["If-Match"] = etag;
            else headers["If-None-Match"] = "*";
            if (String.IsNullOrEmpty(etag))
                WebDavMkcol(endpoint, user, password, VaultKeyFrom(message));
            var result = WebDavRequest("PUT", endpoint, user, password, body, headers);
            if ((result.Status == 409 || result.Status == 404) && String.IsNullOrEmpty(etag) && WebDavMkcol(endpoint, user, password, VaultKeyFrom(message)))
                result = WebDavRequest("PUT", endpoint, user, password, body, headers);
            if (result.Status == 412 || result.Status == 409)
                return new Dictionary<string, object> { { "ok", false }, { "conflict", true }, { "status", result.Status } };
            if (result.Status != 200 && result.Status != 201 && result.Status != 204)
                return Error(WebDavFailure(result));
            string backupName = WebDavBackupName(message.ContainsKey("backupName") ? message["backupName"] : null);
            string archiveError = "";
            if (backupName.Length > 0)
            {
                var archiveBuilder = new UriBuilder(endpoint);
                string path = archiveBuilder.Path;
                string suffix = "/state.json";
                if (path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                    archiveBuilder.Path = path.Substring(0, path.Length - suffix.Length) + "/" + backupName;
                else
                    archiveBuilder.Path = path.TrimEnd('/') + "/" + backupName;
                var archiveHeaders = new Dictionary<string, string>
                {
                    { "If-None-Match", "*" }, { "Accept", "application/json" }
                };
                var archive = WebDavRequest("PUT", archiveBuilder.Uri.ToString(), user, password, body, archiveHeaders);
                if (archive.Status != 200 && archive.Status != 201 && archive.Status != 204)
                    archiveError = "历史备份副本写入失败（HTTP " + archive.Status + "）";
            }
            return new Dictionary<string, object>
            {
                { "ok", true }, { "revision", baseRevision + 1 }, { "updatedAt", now },
                { "etag", result.ETag }, { "name", backupName }, { "archiveError", archiveError }
            };
        }

        private static readonly Regex BackupNamePattern =
            new Regex(@"^subvault-\d{8}-\d{6}\.json$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static string WebDavDirectory(string endpoint)
        {
            var builder = new UriBuilder(endpoint);
            string path = builder.Path;
            const string suffix = "/state.json";
            if (path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                builder.Path = path.Substring(0, path.Length - suffix.Length);
            return builder.Uri.ToString().TrimEnd('/');
        }

        private static long ParseDavModified(string raw)
        {
            if (String.IsNullOrWhiteSpace(raw)) return 0;
            DateTimeOffset parsed;
            if (DateTimeOffset.TryParse(raw.Trim(), CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out parsed))
                return parsed.ToUnixTimeMilliseconds();
            return 0;
        }

        private static string XmlTagText(string block, string tag)
        {
            int open = block.IndexOf("<" + tag, StringComparison.OrdinalIgnoreCase);
            if (open < 0) return "";
            int start = block.IndexOf('>', open);
            if (start < 0) return "";
            start += 1;
            int end = block.IndexOf("</" + tag, start, StringComparison.OrdinalIgnoreCase);
            if (end < 0) return "";
            return block.Substring(start, end - start).Trim();
        }

        private static List<Dictionary<string, object>> WebDavListArchives(string endpoint, string user, string password)
        {
            string directory = WebDavDirectory(endpoint);
            string query = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                + "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:getlastmodified/>"
                + "<d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>";
            var headers = new Dictionary<string, string>
            {
                { "Depth", "1" }, { "Content-Type", "application/xml; charset=utf-8" }
            };
            var result = WebDavRequest("PROPFIND", directory, user, password, Encoding.UTF8.GetBytes(query), headers);
            var archives = new List<Dictionary<string, object>>();
            if (result.Status == 405 || result.Status == 501) return archives;
            if (result.Status != 207 && result.Status != 200)
                throw new InvalidOperationException(WebDavFailure(result));
            string xml = Encoding.UTF8.GetString(result.Body);
            string[] blocks = xml.Split(new[] { "<d:response" }, StringSplitOptions.None);
            for (int index = 1; index < blocks.Length; index += 1)
            {
                string block = blocks[index];
                string href = XmlTagText(block, "d:href");
                if (href.Length == 0) href = XmlTagText(block, "href");
                if (href.Length == 0) continue;
                string name = href;
                int slash = name.LastIndexOf('/');
                if (slash >= 0) name = name.Substring(slash + 1);
                try { name = Uri.UnescapeDataString(name); } catch (UriFormatException) { }
                if (!BackupNamePattern.IsMatch(name)) continue;
                long modified = ParseDavModified(XmlTagText(block, "d:getlastmodified"));
                if (modified == 0) modified = ParseDavModified(XmlTagText(block, "getlastmodified"));
                long size = 0;
                long.TryParse(XmlTagText(block, "d:getcontentlength"), out size);
                archives.Add(new Dictionary<string, object>
                {
                    { "name", name }, { "modified", modified }, { "size", size }
                });
            }
            archives.Sort((a, b) =>
            {
                long left = Convert.ToInt64(a["modified"]);
                long right = Convert.ToInt64(b["modified"]);
                if (left != right) return right.CompareTo(left);
                return String.CompareOrdinal(Convert.ToString(b["name"]), Convert.ToString(a["name"]));
            });
            return archives;
        }

        private static Dictionary<string, object> WebDavHistory(Dictionary<string, object> message)
        {
            string user, password;
            string endpoint = WebDavEndpointFromMessage(message, out user, out password);
            var archives = WebDavListArchives(endpoint, user, password);
            return new Dictionary<string, object>
            {
                { "ok", true }, { "archives", archives }, { "count", archives.Count }
            };
        }

        private static Dictionary<string, object> WebDavPrune(Dictionary<string, object> message)
        {
            string user, password;
            string endpoint = WebDavEndpointFromMessage(message, out user, out password);
            int keep = message.ContainsKey("keep") ? Math.Max(0, Convert.ToInt32(message["keep"])) : 0;
            int olderThanDays = message.ContainsKey("olderThanDays")
                ? Math.Max(0, Convert.ToInt32(message["olderThanDays"]))
                : 0;
            if (keep == 0 && olderThanDays == 0)
                return new Dictionary<string, object>
                {
                    { "ok", true }, { "deleted", new object[0] }, { "failures", new object[0] },
                    { "skipped", "未配置保留数量或过期天数" }
                };
            var archives = WebDavListArchives(endpoint, user, password);
            long cutoff = olderThanDays > 0
                ? DateTimeOffset.UtcNow.AddDays(-olderThanDays).ToUnixTimeMilliseconds()
                : 0;
            string directory = WebDavDirectory(endpoint);
            var deleted = new List<object>();
            var failures = new List<object>();
            for (int index = 0; index < archives.Count; index += 1)
            {
                var archive = archives[index];
                long modified = Convert.ToInt64(archive["modified"]);
                bool drop = keep > 0 && index >= keep;
                if (cutoff > 0 && modified > 0 && modified < cutoff) drop = true;
                if (!drop) continue;
                string name = Convert.ToString(archive["name"]);
                var result = WebDavRequest("DELETE", directory + "/" + name, user, password, null, null);
                if (result.Status == 200 || result.Status == 204 || result.Status == 404)
                {
                    deleted.Add(name);
                    continue;
                }
                failures.Add(name + "：HTTP " + result.Status);
            }
            return new Dictionary<string, object>
            {
                { "ok", true }, { "deleted", deleted }, { "failures", failures },
                { "remaining", archives.Count - deleted.Count },
                { "keep", keep }, { "olderThanDays", olderThanDays }
            };
        }

        private static bool WebDavMkcol(string endpoint, string user, string password, string key)
        {
            var builder = new UriBuilder(endpoint);
            string directory = builder.Path.Substring(0, builder.Path.Length - "/state.json".Length).TrimEnd('/');
            string relativeDir = WebDavRelativeFor(key);
            relativeDir = relativeDir.Substring(0, relativeDir.Length - "/state.json".Length).TrimEnd('/');
            string basePath = directory.Length >= relativeDir.Length
                ? directory.Substring(0, directory.Length - relativeDir.Length)
                : "";
            var authority = new UriBuilder(endpoint) { Path = "", Query = "", Fragment = "" }.Uri.GetLeftPart(UriPartial.Authority);
            var segments = relativeDir.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            string current = basePath;
            bool ok = false;
            foreach (string segment in segments)
            {
                current += "/" + segment;
                var result = WebDavRequest("MKCOL", authority + current, user, password, null, null);
                ok = result.Status == 201 || result.Status == 200 || result.Status == 405;
                if (!ok) return false;
            }
            return ok;
        }

        private static Dictionary<string, object> Error(string text)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", text } };
        }

        private static readonly object DeviceLock = new object();

        private static string DevicePathFor(string key)
        {
            string file = String.IsNullOrEmpty(key) || key == "default"
                ? "device.json"
                : "device-" + key + ".json";
            return Path.Combine(DataDir, file);
        }

        private static byte[] DeviceEntropy(string key)
        {
            return Encoding.UTF8.GetBytes("SubVaultSync:device:v1:" + (String.IsNullOrEmpty(key) ? "default" : key));
        }

        private static Dictionary<string, object> DeviceStatus(Dictionary<string, object> message)
        {
            string key = VaultKeyFrom(message);
            string path = DevicePathFor(key);
            lock (DeviceLock)
            {
                if (!File.Exists(path))
                {
                    return new Dictionary<string, object>
                    {
                        { "ok", true }, { "supported", true }, { "exists", false }
                    };
                }
                try
                {
                    var record = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                    long createdAt = 0;
                    if (record != null && record.ContainsKey("createdAt"))
                        long.TryParse(Convert.ToString(record["createdAt"]), out createdAt);
                    string credentialId = record != null && record.ContainsKey("credentialId")
                        ? Convert.ToString(record["credentialId"])
                        : "";
                    return new Dictionary<string, object>
                    {
                        { "ok", true }, { "supported", true }, { "exists", true },
                        { "createdAt", createdAt }, { "cipher", "DPAPI" },
                        { "credentialId", credentialId ?? "" },
                        { "needsHello", string.IsNullOrEmpty(credentialId) }
                    };
                }
                catch
                {
                    return new Dictionary<string, object>
                    {
                        { "ok", true }, { "supported", true }, { "exists", false }
                    };
                }
            }
        }

        private static Dictionary<string, object> DeviceProtect(Dictionary<string, object> message)
        {
            string key = VaultKeyFrom(message);
            string rawText = message != null && message.ContainsKey("key") ? Convert.ToString(message["key"]) : "";
            byte[] raw;
            try
            {
                raw = Convert.FromBase64String(rawText ?? "");
            }
            catch
            {
                return Error("设备密钥格式无效");
            }
            if (raw.Length != 32) return Error("设备密钥长度无效");
            string credentialId = message != null && message.ContainsKey("credentialId")
                ? Convert.ToString(message["credentialId"]) ?? ""
                : "";
            if (credentialId.Length > 1024) return Error("设备验证凭据过长");
            try
            {
                byte[] protectedBytes = ProtectedData.Protect(raw, DeviceEntropy(key), DataProtectionScope.CurrentUser);
                long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                var record = new Dictionary<string, object>
                {
                    { "v", 1 },
                    { "cipher", "DPAPI" },
                    { "createdAt", now },
                    { "credentialId", credentialId },
                    { "protectedKey", Convert.ToBase64String(protectedBytes) }
                };
                lock (DeviceLock)
                {
                    Directory.CreateDirectory(DataDir);
                    string path = DevicePathFor(key);
                    string temp = path + ".tmp";
                    File.WriteAllText(temp, Json.Serialize(record), new UTF8Encoding(false));
                    File.Copy(temp, path, true);
                    File.Delete(temp);
                }
                return new Dictionary<string, object>
                {
                    { "ok", true }, { "supported", true }, { "exists", true }, { "createdAt", now }, { "cipher", "DPAPI" }
                };
            }
            catch (Exception error)
            {
                return Error("无法创建设备绑定：" + error.Message);
            }
        }

        private static Dictionary<string, object> DeviceUnlock(Dictionary<string, object> message)
        {
            string key = VaultKeyFrom(message);
            string path = DevicePathFor(key);
            lock (DeviceLock)
            {
                if (!File.Exists(path))
                {
                    return new Dictionary<string, object>
                    {
                        { "ok", false }, { "supported", true }, { "exists", false },
                        { "error", "此设备尚未启用快速解锁" }
                    };
                }
                try
                {
                    var record = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                    string storedCredential = record != null && record.ContainsKey("credentialId")
                        ? Convert.ToString(record["credentialId"]) ?? ""
                        : "";
                    string presentedCredential = message != null && message.ContainsKey("credentialId")
                        ? Convert.ToString(message["credentialId"]) ?? ""
                        : "";
                    if (string.IsNullOrEmpty(storedCredential) || string.IsNullOrEmpty(presentedCredential)
                        || !string.Equals(storedCredential, presentedCredential, StringComparison.Ordinal))
                    {
                        return new Dictionary<string, object>
                        {
                            { "ok", false }, { "supported", true }, { "exists", true },
                            { "needsHelloSetup", true },
                            { "error", "需要 Windows Hello 验证。此绑定创建于旧版本或缺少验证凭据，请用主密码解锁后在设置页重新启用设备快速解锁" }
                        };
                    }
                    string protectedText = record != null && record.ContainsKey("protectedKey")
                        ? Convert.ToString(record["protectedKey"])
                        : "";
                    byte[] protectedBytes = Convert.FromBase64String(protectedText ?? "");
                    byte[] raw = ProtectedData.Unprotect(protectedBytes, DeviceEntropy(key), DataProtectionScope.CurrentUser);
                    if (raw.Length != 32) throw new InvalidOperationException("bad key length");
                    return new Dictionary<string, object>
                    {
                        { "ok", true }, { "supported", true }, { "exists", true },
                        { "key", Convert.ToBase64String(raw) }
                    };
                }
                catch
                {
                    return new Dictionary<string, object>
                    {
                        { "ok", false }, { "supported", true }, { "exists", true },
                        { "error", "设备绑定已失效，请用主密码解锁后重新启用" }
                    };
                }
            }
        }

        private static Dictionary<string, object> DeviceForget(Dictionary<string, object> message)
        {
            string key = VaultKeyFrom(message);
            string path = DevicePathFor(key);
            lock (DeviceLock)
            {
                try
                {
                    if (File.Exists(path)) File.Delete(path);
                    return new Dictionary<string, object>
                    {
                        { "ok", true }, { "supported", true }, { "exists", false }
                    };
                }
                catch (Exception error)
                {
                    return Error("无法移除设备绑定：" + error.Message);
                }
            }
        }

        private static Dictionary<string, object> Handle(Dictionary<string, object> message)
        {
            string type = message.ContainsKey("type") ? Convert.ToString(message["type"]) : "";
            switch (type)
            {
                case "ping": return new Dictionary<string, object> { { "ok", true }, { "pong", true } };
                case "status": return Status(message);
                case "pull": return Pull(message);
                case "publish": return Publish(message);
                case "webdav-status": return WebDavStatus(message);
                case "webdav-pull": return WebDavPull(message);
                case "webdav-push": return WebDavPush(message);
                case "webdav-history": return WebDavHistory(message);
                case "webdav-prune": return WebDavPrune(message);
                case "device-status": return DeviceStatus(message);
                case "device-protect": return DeviceProtect(message);
                case "device-unlock": return DeviceUnlock(message);
                case "device-forget": return DeviceForget(message);
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
                    var state = ReadState(StatePath);
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
            var initial = ReadState(StatePath);
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
                Dictionary<string, object> message = null;
                try
                {
                    message = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
                    response = Handle(message ?? new Dictionary<string, object>());
                }
                catch (Exception error)
                {
                    response = Error(error.Message);
                }
                if (message != null && message.ContainsKey("id"))
                    response["id"] = message["id"];
                WriteMessage(response);
            }
        }
    }
}
