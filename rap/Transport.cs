using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace PathPlotterRap
{
    public sealed class RequestDeadline : IDisposable
    {
        private readonly Timer timer;
        public RequestDeadline(HttpWebRequest request, int timeoutMs)
        {
            timer = new Timer(delegate { try { request.Abort(); } catch { } }, null, timeoutMs, Timeout.Infinite);
        }
        public void Dispose() { timer.Dispose(); }
    }

    // A background .NET reader keeps SSE listening during the synchronous upload.
    // It never runs PowerShell on a background thread or retries a request.
    public sealed class EventStream : IDisposable
    {
        private readonly HttpWebRequest request;
        private readonly Thread thread;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
        private volatile bool connected;
        private volatile bool closed;
        private volatile bool armed;
        private volatile bool disposed;
        private HttpWebResponse response;

        public EventStream(string url, string token)
        {
            request = (HttpWebRequest)WebRequest.Create(url);
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.Timeout = 3000;
            request.ReadWriteTimeout = 25000;
            request.Accept = "text/event-stream";
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
            // Separate connection group avoids a long-lived stream blocking upload.
            request.ConnectionGroupName = Guid.NewGuid().ToString("N");
            thread = new Thread(Read);
            thread.IsBackground = true;
            thread.Start();
        }

        public bool WaitReady(int timeoutMs)
        {
            return ready.WaitOne(timeoutMs) && connected && !closed;
        }

        public bool IsOpen { get { return connected && !closed; } }

        public void Arm()
        {
            string ignored;
            while (events.TryDequeue(out ignored)) { }
            armed = true;
        }

        public string Take(int timeoutMs)
        {
            var timer = System.Diagnostics.Stopwatch.StartNew();
            do
            {
                string value;
                if (events.TryDequeue(out value)) return value;
                if (closed) return null;
                if (timeoutMs <= 0) return null;
                Thread.Sleep(10);
            } while (timer.ElapsedMilliseconds < timeoutMs);
            return null;
        }

        // Exact SSE event names only. Generic success/type fields are not events.
        public static string ImportPayload(string eventName, string data)
        {
            return eventName == "file_imported" && data.Length <= 8192 ? data : null;
        }

        private static string ReadBoundedLine(StreamReader reader)
        {
            var line = new StringBuilder();
            for (;;)
            {
                int c = reader.Read();
                if (c == -1) return line.Length == 0 ? null : line.ToString();
                if (c == '\n') return line.ToString().TrimEnd('\r');
                if (line.Length >= 8192) throw new InvalidDataException();
                line.Append((char)c);
            }
        }

        private void Read()
        {
            try
            {
                response = (HttpWebResponse)request.GetResponse();
                if ((int)response.StatusCode != 200 ||
                    !response.ContentType.StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase))
                    return;
                using (var reader = new StreamReader(response.GetResponseStream(), new UTF8Encoding(false, true)))
                {
                    string name = "message";
                    var data = new StringBuilder();
                    bool frameArmed = false;
                    while (!disposed)
                    {
                        string line = ReadBoundedLine(reader);
                        if (line == null) break;
                        if (line == ":connected")
                        {
                            connected = true;
                            ready.Set();
                        }
                        if (line.Length == 0)
                        {
                            string payload = ImportPayload(name, data.ToString());
                            if (armed && frameArmed && payload != null)
                            {
                                if (events.Count >= 32) throw new InvalidDataException();
                                events.Enqueue(payload);
                            }
                            name = "message";
                            data.Length = 0;
                            frameArmed = false;
                        }
                        else if (line.StartsWith("event:", StringComparison.Ordinal))
                        {
                            name = line.Substring(6).TrimStart(' ');
                            frameArmed = armed;
                        }
                        else if (line.StartsWith("data:", StringComparison.Ordinal))
                        {
                            if (data.Length > 0) data.Append('\n');
                            data.Append(line.Substring(5).TrimStart(' '));
                            if (data.Length > 8192) throw new InvalidDataException();
                        }
                    }
                }
            }
            catch { /* Caller treats closed/unready streams as failure, never confirmation. */ }
            finally
            {
                closed = true;
                ready.Set();
                if (response != null) response.Close();
            }
        }

        public void Dispose()
        {
            disposed = true;
            armed = false;
            request.Abort();
            if (response != null) response.Close();
            // Do not leave a background reader accessing a disposed wait handle.
            if (thread.Join(3500)) ready.Dispose();
            request.ServicePoint.CloseConnectionGroup(request.ConnectionGroupName);
        }
    }
}
