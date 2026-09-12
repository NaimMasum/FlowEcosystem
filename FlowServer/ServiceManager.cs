using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.ServiceProcess;
using Microsoft.Win32;

namespace FlowServer
{
    public static class ServiceManager
    {
        public const string ServiceName = FlowWindowsService.DefaultServiceName;
        public const string DisplayName = FlowWindowsService.DefaultDisplayName;
        public const string Description = FlowWindowsService.DefaultDescription;
        private const string RunRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static bool IsAdministrator()
        {
            try
            {
                using var identity = WindowsIdentity.GetCurrent();
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch
            {
                return false;
            }
        }

        public static (string fileName, string arguments) ResolveLauncher(string? preferredExe)
        {
            if (!string.IsNullOrEmpty(preferredExe) && File.Exists(preferredExe) && preferredExe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && !preferredExe.EndsWith("dotnet.exe", StringComparison.OrdinalIgnoreCase))
            {
                return (Path.GetFullPath(preferredExe), "");
            }

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string localExe = Path.Combine(baseDir, "FlowServer.exe");
            if (File.Exists(localExe)) return (Path.GetFullPath(localExe), "");

            string repoRootExe = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "FlowServer.exe"));
            if (File.Exists(repoRootExe)) return (repoRootExe, "");

            string distExe = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "dist", "FlowServer.exe"));
            if (File.Exists(distExe)) return (distExe, "");

            string dll = Path.Combine(baseDir, "FlowServer.dll");
            string dotnet = Environment.ProcessPath ?? "dotnet.exe";
            return (dotnet, $"\"{dll}\"");
        }

        public static bool InstallWindowsService(string exePath, int port)
        {
            if (!IsAdministrator())
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("[!] Administrator privileges required to install Windows Services.");
                Console.WriteLine("    Please right-click cmd/PowerShell and choose 'Run as Administrator',");
                Console.WriteLine("    or use '--install-startup' to run automatically at user login without admin rights.");
                Console.ResetColor();
                return false;
            }

            var (launcherExe, launcherArgs) = ResolveLauncher(exePath);
            string binPath = string.IsNullOrEmpty(launcherArgs)
                ? $"\\\"{launcherExe}\\\" --service --port {port}"
                : $"\\\"{launcherExe}\\\" {launcherArgs} --service --port {port}";

            Console.WriteLine($"[*] Registering Windows Service '{ServiceName}'...");
            Console.WriteLine($"    Binary path: {binPath.Replace("\\\"", "\"")}");

            // 1. Create service with Automatic startup
            int exitCode = RunCommand("sc.exe", $"create {ServiceName} binPath= \"{binPath}\" start= auto DisplayName= \"{DisplayName}\"");
            if (exitCode != 0)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"[!] Failed to create service (sc exit code {exitCode}).");
                Console.ResetColor();
                return false;
            }

            // 2. Set description
            RunCommand("sc.exe", $"description {ServiceName} \"{Description}\"");

            // 3. Configure recovery on failure (restart after 5s, 10s, 60s)
            RunCommand("sc.exe", $"failure {ServiceName} reset= 86400 actions= restart/5000/restart/10000/restart/60000");

            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"[✓] Service '{ServiceName}' successfully installed with Automatic startup!");
            Console.ResetColor();

            // 4. Start the service
            Console.WriteLine($"[*] Starting service '{ServiceName}'...");
            StartService();

            return true;
        }

        public static bool UninstallWindowsService()
        {
            if (!IsAdministrator())
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("[!] Administrator privileges required to remove Windows Services.");
                Console.WriteLine("    Please run as Administrator.");
                Console.ResetColor();
                return false;
            }

            Console.WriteLine($"[*] Stopping service '{ServiceName}' if running...");
            StopService();

            Console.WriteLine($"[*] Deleting service '{ServiceName}'...");
            int exitCode = RunCommand("sc.exe", $"delete {ServiceName}");
            if (exitCode == 0)
            {
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine($"[✓] Service '{ServiceName}' successfully uninstalled.");
                Console.ResetColor();
                return true;
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"[!] Failed to delete service (sc exit code {exitCode}).");
                Console.ResetColor();
                return false;
            }
        }

        public static bool StartService()
        {
            int code = RunCommand("sc.exe", $"start {ServiceName}");
            if (code == 0)
            {
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine($"[✓] Service '{ServiceName}' started successfully.");
                Console.ResetColor();
                return true;
            }
            else
            {
                Console.WriteLine($"[!] sc start returned code {code}. Checking status...");
                PrintStatus();
                return false;
            }
        }

        public static bool StopService()
        {
            int code = RunCommand("sc.exe", $"stop {ServiceName}");
            return code == 0;
        }

        public static void PrintStatus()
        {
            Console.WriteLine("=================================================");
            Console.WriteLine(" Flow Ecosystem Service Status");
            Console.WriteLine("=================================================");

            // 1. Check Windows Service
            try
            {
                var (code, output) = RunCommandWithOutput("sc.exe", $"query {ServiceName}");
                if (code == 0)
                {
                    Console.WriteLine($" Windows Service:    Installed ({ServiceName})");
                    Console.Write(" Service State:      ");
                    if (output.Contains("RUNNING", StringComparison.OrdinalIgnoreCase))
                    {
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("RUNNING (Active)");
                    }
                    else if (output.Contains("STOPPED", StringComparison.OrdinalIgnoreCase))
                    {
                        Console.ForegroundColor = ConsoleColor.Yellow;
                        Console.WriteLine("STOPPED");
                    }
                    else
                    {
                        Console.WriteLine("Installed");
                    }
                    Console.ResetColor();
                    Console.WriteLine($" Startup Type:       Automatic (starts at system boot)");
                }
                else
                {
                    Console.WriteLine($" Windows Service:    Not Installed");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($" Windows Service:    Unknown ({ex.Message})");
            }

            // 2. Check User Startup Registry
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, false);
                var val = key?.GetValue(ServiceName) as string;
                if (!string.IsNullOrEmpty(val))
                {
                    Console.WriteLine($" User Login Startup: ENABLED ({val})");
                }
                else
                {
                    Console.WriteLine($" User Login Startup: Disabled");
                }
            }
            catch
            {
                Console.WriteLine($" User Login Startup: Unknown");
            }

            Console.WriteLine("=================================================");
        }

        public static bool InstallUserStartup(string exePath, int port)
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true);
                if (key == null)
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("[!] Could not open user Run registry key.");
                    Console.ResetColor();
                    return false;
                }

                var (launcherExe, launcherArgs) = ResolveLauncher(exePath);
                string cmd = string.IsNullOrEmpty(launcherArgs)
                    ? $"\"{launcherExe}\" --startup --port {port}"
                    : $"\"{launcherExe}\" {launcherArgs} --startup --port {port}";

                key.SetValue(ServiceName, cmd);

                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine($"[✓] Successfully registered for User Startup at login!");
                Console.WriteLine($"    Command: {cmd}");
                Console.WriteLine("    The server will start silently in the background whenever you log into Windows.");
                Console.ResetColor();
                return true;
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"[!] Failed to register User Startup: {ex.Message}");
                Console.ResetColor();
                return false;
            }
        }

        public static bool UninstallUserStartup()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true);
                if (key != null && key.GetValue(ServiceName) != null)
                {
                    key.DeleteValue(ServiceName);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine($"[✓] Successfully removed User Startup entry.");
                    Console.ResetColor();
                    return true;
                }
                else
                {
                    Console.WriteLine($"[*] User Startup was not registered.");
                    return true;
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"[!] Failed to remove User Startup: {ex.Message}");
                Console.ResetColor();
                return false;
            }
        }

        private static int RunCommand(string fileName, string args)
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = args,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                });
                p?.WaitForExit();
                return p?.ExitCode ?? -1;
            }
            catch
            {
                return -1;
            }
        }

        private static (int exitCode, string output) RunCommandWithOutput(string fileName, string args)
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = args,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                });
                string output = p?.StandardOutput.ReadToEnd() ?? "";
                p?.WaitForExit();
                return (p?.ExitCode ?? -1, output);
            }
            catch
            {
                return (-1, "");
            }
        }
    }
}
