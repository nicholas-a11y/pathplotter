using System;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

namespace PathPlotterRap
{
    public sealed class UiBridge
    {
        public readonly ConcurrentQueue<object> Commands = new ConcurrentQueue<object>();
        public readonly ConcurrentQueue<object> Events = new ConcurrentQueue<object>();
        public volatile bool StopRequested;
    }

    // Only current-user activation; the sole wire action is byte 1 (show status).
    public sealed class Activation : IDisposable
    {
        private readonly string name;
        private readonly Mutex mutex;
        private readonly Thread thread;
        private NamedPipeServerStream pipe;
        private volatile bool stopping;
        private int pending;
        public bool Owner { get; private set; }

        public Activation(string key)
        {
            name = "PathPlotterRAP-" + key;
            var sid = WindowsIdentity.GetCurrent().User;
            var security = new MutexSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new MutexAccessRule(sid, MutexRights.FullControl, AccessControlType.Allow));
            bool created;
            mutex = new Mutex(true, @"Local\" + name, out created, security);
            Owner = created;
            if (!Owner) return;
            thread = new Thread(Listen);
            thread.IsBackground = true;
            thread.Start();
        }

        private void Listen()
        {
            while (!stopping)
            {
                try
                {
                    var security = new PipeSecurity();
                    security.SetAccessRuleProtection(true, false);
                    security.AddAccessRule(new PipeAccessRule(
                        new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                        PipeAccessRights.FullControl, AccessControlType.Deny));
                    security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,
                        PipeAccessRights.FullControl, AccessControlType.Allow));
                    using (var server = new NamedPipeServerStream(name, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1, 1, security))
                    {
                        pipe = server;
                        if (stopping) break;
                        server.WaitForConnection();
                        using (var timeout = new Timer(delegate { try { server.Dispose(); } catch { } },
                            null, 1000, Timeout.Infinite))
                        {
                            if (server.ReadByte() == 1) Interlocked.Exchange(ref pending, 1);
                        }
                    }
                }
                catch (System.IO.IOException) { }
                catch (ObjectDisposedException) { }
                catch (UnauthorizedAccessException) { stopping = true; }
            }
        }

        public bool TakeActivation() { return Interlocked.Exchange(ref pending, 0) == 1; }
        public bool Signal()
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", name, PipeDirection.Out))
                {
                    client.Connect(3000);
                    client.WriteByte(1);
                    client.Flush();
                }
                return true;
            }
            catch (System.IO.IOException) { return false; }
            catch (TimeoutException) { return false; }
        }
        public void Dispose()
        {
            stopping = true;
            if (pipe != null) { try { pipe.Dispose(); } catch { } }
            if (thread != null) thread.Join(2000);
            if (Owner) mutex.ReleaseMutex();
            mutex.Dispose();
        }
    }
}
