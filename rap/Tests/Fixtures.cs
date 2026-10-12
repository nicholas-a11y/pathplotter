using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace PathPlotterRapTests
{
    public sealed class SocketFixture : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Thread thread;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly object sync = new object();
        private TcpClient client;
        private NetworkStream stream;
        public string Url { get; private set; }
        public string Headers { get; private set; }
        public string Received { get; private set; }
        public SocketFixture()
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Url = "ws://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/agent/stream?generation=1";
            thread = new Thread(Run); thread.IsBackground = true; thread.Start();
        }
        private void Run()
        {
            try
            {
                client = listener.AcceptTcpClient();
                stream = client.GetStream();
                stream.ReadTimeout = 5000;
                var headers = new StringBuilder();
                while (!headers.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
                {
                    int b = stream.ReadByte();
                    if (b < 0 || headers.Length > 16384) return;
                    headers.Append((char)b);
                }
                Headers = headers.ToString();
                var match = System.Text.RegularExpressions.Regex.Match(Headers, @"(?im)^Sec-WebSocket-Key:\s*(\S+)");
                string accept;
                using (var sha = System.Security.Cryptography.SHA1.Create())
                    accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(match.Groups[1].Value + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                var reply = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
                stream.Write(reply, 0, reply.Length);
                ready.Set();
                stream.ReadTimeout = 20000;
                int opcode = stream.ReadByte();
                if (opcode < 0) return;
                int size = stream.ReadByte();
                if ((size & 128) == 0) return;
                int count = size & 127;
                if (count == 126) count = stream.ReadByte() * 256 + stream.ReadByte();
                if (count > 65536 || count == 127) return;
                var mask = new byte[4];
                for (int i = 0; i < 4; i++) mask[i] = (byte)stream.ReadByte();
                var bytes = new byte[count];
                for (int i = 0; i < count; i++) bytes[i] = (byte)(stream.ReadByte() ^ mask[i % 4]);
                Received = Encoding.UTF8.GetString(bytes);
                while (stream.ReadByte() >= 0) { }
            }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            finally { ready.Set(); }
        }
        private void Frame(byte opcode, bool final, byte[] bytes)
        {
            stream.WriteByte((byte)(opcode | (final ? 128 : 0)));
            if (bytes.Length < 126) stream.WriteByte((byte)bytes.Length);
            else if (bytes.Length <= 65535)
            {
                stream.WriteByte(126); stream.WriteByte((byte)(bytes.Length >> 8)); stream.WriteByte((byte)bytes.Length);
            }
            else
            {
                stream.WriteByte(127);
                for (int i = 7; i >= 0; i--) stream.WriteByte((byte)((long)bytes.Length >> (i * 8)));
            }
            stream.Write(bytes, 0, bytes.Length);
        }
        public void Send(string text, bool fragmented)
        {
            if (!ready.WaitOne(5000) || stream == null) throw new IOException("Fixture handshake timeout.");
            var bytes = Encoding.UTF8.GetBytes(text);
            lock (sync)
            {
                if (!fragmented) Frame(1, true, bytes);
                else
                {
                    var first = new byte[bytes.Length / 2];
                    var second = new byte[bytes.Length - first.Length];
                    Array.Copy(bytes, first, first.Length); Array.Copy(bytes, first.Length, second, 0, second.Length);
                    Frame(1, false, first); Frame(0, true, second);
                }
            }
        }
        public void Dispose()
        {
            listener.Stop(); if (client != null) client.Close();
            if (thread.Join(2000)) ready.Dispose();
        }
    }

    public sealed class HttpFixture : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Thread thread;
        private readonly int status;
        private readonly string contentType;
        private readonly string body;
        private readonly int delay;
        private TcpClient client;
        public string Url { get; private set; }
        public string RequestHeaders { get; private set; }
        public byte[] RequestBody { get; private set; }

        public HttpFixture(int statusCode, string type, string responseBody, int delayMs)
        {
            status = statusCode; contentType = type; body = responseBody; delay = delayMs;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/fixture";
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        private void Run()
        {
            try
            {
                client = listener.AcceptTcpClient();
                using (var stream = client.GetStream())
                {
                    stream.ReadTimeout = 5000;
                    int state = 0; int length = 0;
                    var incoming = new StringBuilder();
                    byte[] end = { 13, 10, 13, 10 };
                    while (state < 4)
                    {
                        int value = stream.ReadByte();
                        if (value < 0 || ++length > 16384) return;
                        incoming.Append((char)value);
                        state = value == end[state] ? state + 1 : 0;
                    }
                    RequestHeaders = incoming.ToString();
                    var match = System.Text.RegularExpressions.Regex.Match(RequestHeaders, @"(?im)^Content-Length:\s*(\d+)");
                    int bodyLength = match.Success ? Int32.Parse(match.Groups[1].Value) : 0;
                    if (bodyLength > 1048576) return;
                    RequestBody = new byte[bodyLength];
                    int offset = 0;
                    while (offset < bodyLength)
                    {
                        int count = stream.Read(RequestBody, offset, bodyLength - offset);
                        if (count == 0) return;
                        offset += count;
                    }
                    Thread.Sleep(delay);
                    byte[] bytes = Encoding.UTF8.GetBytes(body);
                    string header = "HTTP/1.1 " + status + " Fixture\r\nContent-Type: " + contentType +
                        "\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\n\r\n";
                    byte[] headers = Encoding.ASCII.GetBytes(header);
                    stream.Write(headers, 0, headers.Length);
                    stream.Write(bytes, 0, bytes.Length);
                }
            }
            catch { }
            finally { if (client != null) client.Close(); }
        }

        public void Dispose()
        {
            listener.Stop();
            if (client != null) client.Close();
            thread.Join(5000);
        }
    }

    // Test-only ephemeral loopback server; never contacts LightBurn or the cloud.
    public sealed class SseFixture : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Thread thread;
        private readonly ManualResetEvent prepared = new ManualResetEvent(false);
        private readonly object sync = new object();
        private readonly string opening;
        private TcpClient client;
        private NetworkStream stream;
        public string Url { get; private set; }

        public SseFixture(string initialComment)
        {
            opening = initialComment;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/events";
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        private void Run()
        {
            try
            {
                client = listener.AcceptTcpClient();
                stream = client.GetStream();
                stream.ReadTimeout = 5000;
                int state = 0;
                int length = 0;
                byte[] end = { 13, 10, 13, 10 };
                while (state < 4)
                {
                    int value = stream.ReadByte();
                    if (value < 0 || ++length > 16384) return;
                    state = value == end[state] ? state + 1 : 0;
                }
                EmitRaw("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" + opening + "\n\n");
                prepared.Set();
            }
            catch { prepared.Set(); }
        }

        private void EmitRaw(string text)
        {
            lock (sync)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(text);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
        }

        public void Emit(string text)
        {
            if (!prepared.WaitOne(5000)) throw new IOException("Fixture did not prepare.");
            EmitRaw(text);
        }

        public void Dispose()
        {
            listener.Stop();
            if (client != null) client.Close();
            thread.Join(5000);
            prepared.Dispose();
        }
    }
}
