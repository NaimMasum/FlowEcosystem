using System;
using System.ServiceProcess;

namespace FlowServer
{
    public class FlowWindowsService : ServiceBase
    {
        public const string DefaultServiceName = "FlowServer";
        public const string DefaultDisplayName = "Flow Ecosystem Server Service";
        public const string DefaultDescription = "Background service hosting the Flow Note infinite canvas whiteboard and real-time synchronization backend.";

        private readonly ServerHost _host;

        public FlowWindowsService(ServerHost host)
        {
            _host = host;
            _host.IsServiceMode = true;
            _host.IsHeadless = true;

            ServiceName = DefaultServiceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            _host.Log("[FlowWindowsService] SCM Start signal received.");
            try
            {
                _host.Start();
                _host.Log("[FlowWindowsService] Service started successfully.");
            }
            catch (Exception ex)
            {
                _host.Log("[FlowWindowsService] Fatal start failure: " + ex);
                throw;
            }
        }

        protected override void OnStop()
        {
            _host.Log("[FlowWindowsService] SCM Stop signal received.");
            try
            {
                _host.Stop();
                _host.Log("[FlowWindowsService] Service stopped cleanly.");
            }
            catch (Exception ex)
            {
                _host.Log("[FlowWindowsService] Error during stop: " + ex);
            }
        }

        protected override void OnShutdown()
        {
            _host.Log("[FlowWindowsService] System shutdown detected. Terminating server cleanly...");
            OnStop();
        }
    }
}
