using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace FlowServer
{
    public class ServerHost
    {
        public int Port { get; set; } = 3942;
        public int PdfPort { get; set; } = 4042;
        public string? CustomDataDir { get; set; }
        public string? CustomPublicDir { get; set; }
        public bool IsServiceMode { get; set; }
        public bool IsHeadless { get; set; }

        private Process? _serverProcess;
        private readonly object _lock = new();
        private StreamWriter? _logWriter;
        private bool _isStopping = false;

        public event Action<string>? OnLog;

        public void Start()
        {
            lock (_lock)
            {
                if (_serverProcess != null && !_serverProcess.HasExited)
                    return;

                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string runtimeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FlowServer", "runtime");
                Directory.CreateDirectory(runtimeDir);

                InitLogger(baseDir);

                Log($"[FlowServer] Starting Flow Server Host on port {Port}...");

                // 1. Resolve node.exe
                string nodePath = ResolveNodeExecutable(baseDir, runtimeDir);
                Log($"[FlowServer] Using Node engine: {nodePath}");

                // 2. Resolve server script
                string scriptPath = ResolveServerScript(baseDir, runtimeDir);
                Log($"[FlowServer] Using Server bundle: {scriptPath}");

                // 3. Resolve public assets
                string publicDir = ResolvePublicDir(baseDir, runtimeDir);
                Log($"[FlowServer] Serving public assets from: {publicDir}");

                // 4. Resolve data directory
                string dataDir = ResolveDataDir(baseDir);
                Directory.CreateDirectory(dataDir);
                Log($"[FlowServer] Persisting board data to: {dataDir}");

                var psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = $"\"{scriptPath}\"",
                    WorkingDirectory = baseDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = IsHeadless || IsServiceMode,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };

                psi.EnvironmentVariables["PORT"] = Port.ToString();
                psi.EnvironmentVariables["PDF_PORT"] = PdfPort.ToString();
                psi.EnvironmentVariables["FLOW_DATA_DIR"] = dataDir;
                psi.EnvironmentVariables["FLOW_PUBLIC_DIR"] = publicDir;

                _serverProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };

                _serverProcess.OutputDataReceived += (s, e) =>
                {
                    if (e.Data != null) Log(e.Data);
                };

                _serverProcess.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data != null) Log("[ERR] " + e.Data);
                };

                _serverProcess.Exited += (s, e) =>
                {
                    Log($"[FlowServer] Server engine exited with code {_serverProcess?.ExitCode ?? -1}");
                    if (!_isStopping && IsServiceMode)
                    {
                        Log("[FlowServer] Service mode active: attempting server restart in 3 seconds...");
                        System.Threading.Thread.Sleep(3000);
                        if (!_isStopping) Start();
                    }
                };

                _serverProcess.Start();
                _serverProcess.BeginOutputReadLine();
                _serverProcess.BeginErrorReadLine();

                Log($"[FlowServer] Server process started (PID: {_serverProcess.Id})");
            }
        }

        public void Stop()
        {
            lock (_lock)
            {
                _isStopping = true;
                if (_serverProcess != null && !_serverProcess.HasExited)
                {
                    Log($"[FlowServer] Stopping server process (PID: {_serverProcess.Id})...");
                    try
                    {
                        KillProcessTree(_serverProcess.Id);
                        if (!_serverProcess.WaitForExit(5000))
                        {
                            _serverProcess.Kill();
                        }
                    }
                    catch (Exception ex)
                    {
                        Log($"[FlowServer] Error during process termination: {ex.Message}");
                    }
                }
                _serverProcess = null;
                _logWriter?.Flush();
                _logWriter?.Dispose();
                _logWriter = null;
            }
        }

        private void InitLogger(string baseDir)
        {
            try
            {
                string logDir = baseDir;
                if (IsServiceMode || !IsDirectoryWritable(baseDir))
                {
                    logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "FlowServer");
                }
                Directory.CreateDirectory(logDir);
                string logFile = Path.Combine(logDir, IsServiceMode ? "service.log" : "server.log");
                _logWriter = new StreamWriter(new FileStream(logFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                {
                    AutoFlush = true
                };
            }
            catch {}
        }

        public void Log(string message)
        {
            string line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}";
            try
            {
                _logWriter?.WriteLine(line);
            }
            catch {}

            OnLog?.Invoke(message);
        }

        private string ResolveNodeExecutable(string baseDir, string runtimeDir)
        {
            // 1. Next to exe
            string localNode = Path.Combine(baseDir, "node.exe");
            if (File.Exists(localNode)) return localNode;

            // 2. Already extracted in runtimeDir
            string cachedNode = Path.Combine(runtimeDir, "node.exe");
            if (File.Exists(cachedNode)) return cachedNode;

            // 3. System PATH
            string? pathNode = FindInPath("node.exe");
            if (!string.IsNullOrEmpty(pathNode) && File.Exists(pathNode)) return pathNode;

            // 4. Extract embedded resource if present
            if (TryExtractResource("node.exe", cachedNode) || TryExtractGzResource("node.gz", cachedNode))
            {
                return cachedNode;
            }

            // Fallback: check standard Program Files
            string defaultPf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            if (File.Exists(defaultPf)) return defaultPf;

            throw new FileNotFoundException("Could not find or extract node.exe. Ensure node.exe is present or installed.");
        }

        private string ResolveServerScript(string baseDir, string runtimeDir)
        {
            // 1. Next to exe
            string localBundle = Path.Combine(baseDir, "server.bundle.js");
            if (File.Exists(localBundle)) return localBundle;

            // 2. Repo path (dev/worktree)
            string repoServer = Path.Combine(baseDir, "flow_note", "server.js");
            if (File.Exists(repoServer)) return repoServer;

            string parentRepoServer = Path.Combine(baseDir, "..", "flow_note", "server.js");
            if (File.Exists(parentRepoServer)) return Path.GetFullPath(parentRepoServer);

            // 3. Cached in runtimeDir
            string cachedBundle = Path.Combine(runtimeDir, "server.bundle.js");
            if (File.Exists(cachedBundle)) return cachedBundle;

            // 4. Extract embedded resource
            if (TryExtractResource("server.bundle.js", cachedBundle))
            {
                return cachedBundle;
            }

            throw new FileNotFoundException("Could not find server.bundle.js or flow_note/server.js.");
        }

        private string ResolvePublicDir(string baseDir, string runtimeDir)
        {
            if (!string.IsNullOrEmpty(CustomPublicDir) && Directory.Exists(CustomPublicDir))
                return CustomPublicDir;

            // 1. Next to exe
            string localPublic = Path.Combine(baseDir, "public");
            if (Directory.Exists(localPublic)) return localPublic;

            // 2. Repo path
            string repoPublic = Path.Combine(baseDir, "flow_note", "public");
            if (Directory.Exists(repoPublic)) return repoPublic;

            string parentRepoPublic = Path.Combine(baseDir, "..", "flow_note", "public");
            if (Directory.Exists(parentRepoPublic)) return Path.GetFullPath(parentRepoPublic);

            // 3. Cached public dir in AppData
            string cachedPublic = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FlowServer", "public");
            Directory.CreateDirectory(cachedPublic);
            ExtractEmbeddedPublicFiles(cachedPublic);
            return cachedPublic;
        }

        private string ResolveDataDir(string baseDir)
        {
            if (!string.IsNullOrEmpty(CustomDataDir)) return CustomDataDir;

            string localData = Path.Combine(baseDir, "data");
            if (Directory.Exists(localData) || (IsDirectoryWritable(baseDir) && !IsServiceMode))
            {
                return localData;
            }

            // Service or read-only mode: use ProgramData or LocalAppData
            string appData = Environment.GetFolderPath(IsServiceMode 
                ? Environment.SpecialFolder.CommonApplicationData 
                : Environment.SpecialFolder.LocalApplicationData);

            return Path.Combine(appData, "FlowServer", "data");
        }

        private static bool IsDirectoryWritable(string dirPath)
        {
            try
            {
                string testFile = Path.Combine(dirPath, ".flow_write_test_" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(testFile, "test");
                File.Delete(testFile);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string? FindInPath(string filename)
        {
            var pathEnv = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathEnv)) return null;

            foreach (var p in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    string fullPath = Path.Combine(p.Trim(), filename);
                    if (File.Exists(fullPath)) return fullPath;
                }
                catch {}
            }
            return null;
        }

        private static bool TryExtractResource(string resourceName, string targetPath)
        {
            var asm = Assembly.GetExecutingAssembly();
            string? foundName = null;
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("." + resourceName, StringComparison.OrdinalIgnoreCase) || name.Equals(resourceName, StringComparison.OrdinalIgnoreCase))
                {
                    foundName = name;
                    break;
                }
            }

            if (foundName == null) return false;

            try
            {
                using var stream = asm.GetManifestResourceStream(foundName);
                if (stream == null) return false;
                string? dir = Path.GetDirectoryName(targetPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                using var outStream = File.Create(targetPath);
                stream.CopyTo(outStream);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryExtractGzResource(string resourceName, string targetPath)
        {
            var asm = Assembly.GetExecutingAssembly();
            string? foundName = null;
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("." + resourceName, StringComparison.OrdinalIgnoreCase) || name.Equals(resourceName, StringComparison.OrdinalIgnoreCase))
                {
                    foundName = name;
                    break;
                }
            }

            if (foundName == null) return false;

            try
            {
                using var stream = asm.GetManifestResourceStream(foundName);
                if (stream == null) return false;
                using var gz = new GZipStream(stream, CompressionMode.Decompress);
                string? dir = Path.GetDirectoryName(targetPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                using var outStream = File.Create(targetPath);
                gz.CopyTo(outStream);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void ExtractEmbeddedPublicFiles(string targetDir)
        {
            var asm = Assembly.GetExecutingAssembly();
            string prefix = asm.GetName().Name + ".Resources.public.";
            foreach (var res in asm.GetManifestResourceNames())
            {
                if (res.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    string relative = res.Substring(prefix.Length);
                    string filePath = Path.Combine(targetDir, relative);
                    if (!File.Exists(filePath))
                    {
                        TryExtractResource(res, filePath);
                    }
                }
            }
        }

        private static void KillProcessTree(int pid)
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/T /F /PID {pid}",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
                p?.WaitForExit(3000);
            }
            catch {}
        }

        public static string[] GetLocalIPAddresses()
        {
            var list = new System.Collections.Generic.List<string>();
            try
            {
                var host = Dns.GetHostEntry(Dns.GetHostName());
                foreach (var ip in host.AddressList)
                {
                    if (ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip))
                    {
                        string s = ip.ToString();
                        if (!s.StartsWith("169.254.") && !s.StartsWith("192.168.56."))
                        {
                            list.Add(s);
                        }
                    }
                }
            }
            catch {}
            return list.ToArray();
        }
    }
}
