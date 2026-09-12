using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace FlowServer
{
    class Program
    {
        static int Main(string[] args)
        {
            int port = 3942;
            int pdfPort = 4042;
            string? customData = null;
            string? customPublic = null;
            string exePath = Environment.ProcessPath ?? "FlowServer.exe";

            // Parse flags
            bool isService = false;
            bool isStartup = false;
            bool isInstallService = false;
            bool isUninstallService = false;
            bool isStartService = false;
            bool isStopService = false;
            bool isStatus = false;
            bool isInstallStartup = false;
            bool isUninstallStartup = false;
            bool isHelp = false;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i].ToLowerInvariant();
                if (arg == "--service") isService = true;
                else if (arg == "--startup") isStartup = true;
                else if (arg == "--install" || arg == "--install-service") isInstallService = true;
                else if (arg == "--uninstall" || arg == "--uninstall-service") isUninstallService = true;
                else if (arg == "--start") isStartService = true;
                else if (arg == "--stop") isStopService = true;
                else if (arg == "--status") isStatus = true;
                else if (arg == "--install-startup") isInstallStartup = true;
                else if (arg == "--uninstall-startup") isUninstallStartup = true;
                else if (arg == "--help" || arg == "-h" || arg == "/?") isHelp = true;
                else if (arg == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], out int p))
                {
                    port = p;
                    i++;
                }
                else if (arg == "--pdf-port" && i + 1 < args.Length && int.TryParse(args[i + 1], out int pp))
                {
                    pdfPort = pp;
                    i++;
                }
                else if (arg == "--data" && i + 1 < args.Length)
                {
                    customData = args[i + 1];
                    i++;
                }
                else if (arg == "--public" && i + 1 < args.Length)
                {
                    customPublic = args[i + 1];
                    i++;
                }
            }

            // Also check environment variable overrides
            if (int.TryParse(Environment.GetEnvironmentVariable("PORT"), out int envPort)) port = envPort;
            if (int.TryParse(Environment.GetEnvironmentVariable("PDF_PORT"), out int envPdfPort)) pdfPort = envPdfPort;

            // Handle Help
            if (isHelp)
            {
                PrintHelp();
                return 0;
            }

            // Handle Service Management Commands
            if (isInstallService)
            {
                return ServiceManager.InstallWindowsService(exePath, port) ? 0 : 1;
            }
            if (isUninstallService)
            {
                return ServiceManager.UninstallWindowsService() ? 0 : 1;
            }
            if (isStartService)
            {
                return ServiceManager.StartService() ? 0 : 1;
            }
            if (isStopService)
            {
                return ServiceManager.StopService() ? 0 : 1;
            }
            if (isStatus)
            {
                ServiceManager.PrintStatus();
                return 0;
            }
            if (isInstallStartup)
            {
                return ServiceManager.InstallUserStartup(exePath, port) ? 0 : 1;
            }
            if (isUninstallStartup)
            {
                return ServiceManager.UninstallUserStartup() ? 0 : 1;
            }

            var serverHost = new ServerHost
            {
                Port = port,
                PdfPort = pdfPort,
                CustomDataDir = customData,
                CustomPublicDir = customPublic
            };

            // Case A: Windows Service Control Manager invocation
            if (isService)
            {
                ServiceBase.Run(new FlowWindowsService(serverHost));
                return 0;
            }

            // Case B: Silent User Login Startup
            if (isStartup)
            {
                serverHost.IsHeadless = true;
                serverHost.Start();
                var exitEvent = new ManualResetEvent(false);
                AppDomain.CurrentDomain.ProcessExit += (s, e) =>
                {
                    serverHost.Stop();
                    exitEvent.Set();
                };
                exitEvent.WaitOne();
                return 0;
            }

            // Case C: Interactive Console Mode
            return RunInteractive(serverHost);
        }

        static int RunInteractive(ServerHost host)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.Clear();

            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine(@"
   ███████╗██╗      ██████╗ ██╗    ██╗
   ██╔════╝██║     ██╔═══██╗██║    ██║
   █████╗  ██║     ██║   ██║██║ █╗ ██║
   ██╔══╝  ██║     ██║   ██║██║███╗██║
   ██║     ███████╗╚██████╔╝╚███╔███╔╝
   ╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ 
      STANDALONE ECOSYSTEM SERVER
");
            Console.ResetColor();

            Console.WriteLine("=================================================================");
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine(" [✓] Engine Status:   INITIALIZING");
            Console.ResetColor();
            Console.WriteLine($" [*] Whiteboard Port: {host.Port}");
            Console.WriteLine($" [*] PDF Engine Port: {host.PdfPort}");
            Console.WriteLine($" [*] Local Web:       http://localhost:{host.Port}");

            string[] lanIps = ServerHost.GetLocalIPAddresses();
            if (lanIps.Length > 0)
            {
                foreach (var ip in lanIps)
                {
                    Console.ForegroundColor = ConsoleColor.Yellow;
                    Console.WriteLine($" [*] LAN Access:      http://{ip}:{host.Port}");
                    Console.ResetColor();
                }
            }
            else
            {
                Console.WriteLine(" [*] LAN Access:      Check Wi-Fi connection for network sharing.");
            }

            Console.WriteLine($" [*] mDNS Discovery:  Flow Whiteboard ({host.Port}) active");
            Console.WriteLine("=================================================================");
            Console.WriteLine(" [Startup / Service Commands]");
            Console.WriteLine("   FlowServer.exe --install-service   (Auto-run on Windows boot)");
            Console.WriteLine("   FlowServer.exe --install-startup   (Auto-run on User login)");
            Console.WriteLine("   FlowServer.exe --status            (Check service status)");
            Console.WriteLine("   FlowServer.exe --uninstall         (Remove service)");
            Console.WriteLine("=================================================================");
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine(" Press Ctrl+C at any time to stop the server.\n");
            Console.ResetColor();

            host.OnLog += msg =>
            {
                Console.WriteLine($" {msg}");
            };

            var shutdownEvent = new ManualResetEvent(false);

            Console.CancelKeyPress += (s, e) =>
            {
                e.Cancel = true;
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("\n[*] Shutting down Flow Server gracefully...");
                Console.ResetColor();
                host.Stop();
                shutdownEvent.Set();
            };

            AppDomain.CurrentDomain.ProcessExit += (s, e) =>
            {
                host.Stop();
                shutdownEvent.Set();
            };

            try
            {
                host.Start();
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"\n[!] Failed to start server: {ex.Message}");
                Console.ResetColor();
                return 1;
            }

            shutdownEvent.WaitOne();
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("[✓] Server stopped.");
            Console.ResetColor();
            return 0;
        }

        static void PrintHelp()
        {
            Console.WriteLine(@"
Flow Ecosystem Standalone Server & Service Manager
Usage: FlowServer.exe [options]

Modes:
  FlowServer.exe                     Run server interactively in console
  FlowServer.exe --service           Run as Windows Service (invoked by Windows SCM)
  FlowServer.exe --startup           Run silently in background (invoked by User Startup)

Service Management (Requires Administrator):
  --install, --install-service       Install and register Windows Service to start at boot
  --uninstall, --uninstall-service   Stop and remove the Windows Service
  --start                            Start the Windows Service
  --stop                             Stop the Windows Service
  --status                           Check status of the Windows Service and Startup registry

User Startup Management (No Administrator required):
  --install-startup                  Register server to start silently at user login
  --uninstall-startup                Remove from user login startup

Configuration Options:
  --port <number>                    Whiteboard HTTP/WS port (default: 3942)
  --pdf-port <number>                PDF Annotator port (default: 4042)
  --data <path>                      Custom data directory path for board persistence
  --public <path>                    Custom public web assets directory path
  --help, -h                         Show this help message
");
        }
    }
}
