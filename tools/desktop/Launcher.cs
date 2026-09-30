using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:18794";
    private static readonly string Identity = "Local\\StudentBuddy.Desktop." + WindowsIdentity.GetCurrent().User.Value;
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudentBuddy", "desktop.log");
    private static readonly object LogLock = new object();
    private static bool Quiet;

    [STAThread]
    private static int Main(string[] args)
    {
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        Quiet = noBrowser;
        if (Array.IndexOf(args, "--stop") >= 0) return Stop();
        bool created;
        using (Mutex instance = new Mutex(true, Identity, out created))
        {
            if (!created)
            {
                if (!WaitForServer(null)) { ShowError("正在运行的服务没有响应。"); return 1; }
                if (!noBrowser) OpenBrowser();
                return 0;
            }
            using (EventWaitHandle stop = new EventWaitHandle(false, EventResetMode.ManualReset, Identity + ".Stop"))
            {
                Process server = null;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
                    if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 2000000) File.WriteAllText(LogPath, "");
                    string root = AppDomain.CurrentDomain.BaseDirectory;
                    TcpListener portProbe = new TcpListener(IPAddress.Loopback, 18794);
                    try { portProbe.Start(); }
                    finally { portProbe.Stop(); }
                    ProcessStartInfo info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"),
                        "\"" + Path.Combine(root, "packages", "server", "dist", "index.js") + "\"");
                    info.WorkingDirectory = root;
                    info.UseShellExecute = false;
                    info.CreateNoWindow = true;
                    info.RedirectStandardOutput = true;
                    info.RedirectStandardError = true;
                    info.EnvironmentVariables["SB_HOST"] = "127.0.0.1";
                    info.EnvironmentVariables["SB_PORT"] = "18794";
                    info.EnvironmentVariables["SB_REQUIRE_AUTH"] = "0";
                    info.EnvironmentVariables["SB_WEB_DIST"] = Path.Combine(root, "web");
                    info.EnvironmentVariables.Remove("SB_TRUST_PROXY");
                    server = new Process();
                    server.StartInfo = info;
                    server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
                    server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
                    server.Start();
                    server.BeginOutputReadLine();
                    server.BeginErrorReadLine();
                    if (!WaitForServer(server)) throw new Exception("本地服务未能启动，或启动端口已被占用。");
                    if (!noBrowser) OpenBrowser();
                    Application.EnableVisualStyles();
                    using (NotifyIcon tray = new NotifyIcon())
                    using (ContextMenuStrip menu = new ContextMenuStrip())
                    using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer())
                    {
                        menu.Items.Add("打开 StudentBuddy", null, delegate { OpenBrowser(); });
                        menu.Items.Add("退出 StudentBuddy", null, delegate { Application.ExitThread(); });
                        tray.Icon = SystemIcons.Application;
                        tray.Text = "StudentBuddy";
                        tray.ContextMenuStrip = menu;
                        tray.DoubleClick += delegate { OpenBrowser(); };
                        tray.Visible = true;
                        timer.Interval = 500;
                        timer.Tick += delegate
                        {
                            if (stop.WaitOne(0)) Application.ExitThread();
                            else if (server.HasExited)
                            {
                                ShowError("本地服务已停止，请重新启动 StudentBuddy。");
                                Application.ExitThread();
                            }
                        };
                        timer.Start();
                        Application.Run();
                        tray.Visible = false;
                    }
                    return 0;
                }
                catch (Exception error)
                {
                    Log(error.ToString());
                    ShowError(error.Message);
                    return 1;
                }
                finally
                {
                    if (server != null)
                    {
                        try { if (!server.HasExited) { server.Kill(); server.WaitForExit(10000); } }
                        catch (InvalidOperationException) { }
                        server.Dispose();
                    }
                    instance.ReleaseMutex();
                }
            }
        }
    }

    private static int Stop()
    {
        try
        {
            using (EventWaitHandle signal = EventWaitHandle.OpenExisting(Identity + ".Stop")) signal.Set();
            using (Mutex instance = Mutex.OpenExisting(Identity))
            {
                try { if (!instance.WaitOne(15000)) return 1; }
                catch (AbandonedMutexException) { }
                instance.ReleaseMutex();
            }
            return 0;
        }
        catch (WaitHandleCannotBeOpenedException) { return 0; }
    }

    private static bool WaitForServer(Process server)
    {
        for (int attempt = 0; attempt < 60; attempt++)
        {
            if (server != null && server.HasExited) return false;
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Url + "/api/health");
                request.Timeout = 500;
                request.Proxy = null;
                using (WebResponse response = request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                    if (reader.ReadToEnd() == "{\"ok\":true}") return true;
            }
            catch (WebException) { }
            Thread.Sleep(250);
        }
        return false;
    }

    private static void OpenBrowser() { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); }
    private static void ShowError(string message)
    {
        if (Quiet) { Log(message); return; }
        MessageBox.Show(message + "\n\n日志：" + LogPath, "StudentBuddy", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
    private static void Log(string line)
    {
        if (line == null) return;
        lock (LogLock)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("s") + " " + line + Environment.NewLine); }
            catch (IOException) { }
        }
    }
}
