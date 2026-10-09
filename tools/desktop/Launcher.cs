using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Launcher
{
    private const int PreferredPort = 18794;
    private static int Port = PreferredPort;
    private static string Url { get { return "http://127.0.0.1:" + Port.ToString(); } }
    private static readonly string PortFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudentBuddy", "port");
    private static readonly string Identity = "Local\\StudentBuddy.Desktop." + WindowsIdentity.GetCurrent().User.Value;
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudentBuddy", "desktop.log");
    private static readonly object LogLock = new object();
    private static bool Quiet;
    private static bool Exiting;
    private static Form Window;
    private static bool WebviewStarted;
    private static bool WebviewFailed;

    [STAThread]
    private static int Main(string[] args)
    {
        // --no-browser 语义＝不打开窗口（自动化与冒烟使用），服务照常启动并驻留托盘。
        bool noWindow = Array.IndexOf(args, "--no-browser") >= 0;
        Quiet = noWindow;
        if (Array.IndexOf(args, "--stop") >= 0) return Stop();
        bool created;
        using (Mutex instance = new Mutex(true, Identity, out created))
        {
            if (!created)
            {
                // 第二实例：不新建窗口、不新建服务，只把已有窗口带到前台。
                Port = ReadOwnedPort();
                if (!WaitForServer(null)) { ShowError("正在运行的服务没有响应。"); return 1; }
                if (!noWindow) SignalShow();
                return 0;
            }
            using (EventWaitHandle stop = new EventWaitHandle(false, EventResetMode.ManualReset, Identity + ".Stop"))
            using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, Identity + ".Show"))
            {
                Process server = null;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
                    if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 2000000) File.WriteAllText(LogPath, "");
                    string root = AppDomain.CurrentDomain.BaseDirectory;
                    // 择优端口：优先 18794；被占用或被系统排除时自动改用回环空闲端口，绝不替换其他进程。
                    Port = SelectPort();
                    File.WriteAllText(PortFile, Port.ToString());
                    Log("本地服务端口：" + Port.ToString());
                    ProcessStartInfo info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"),
                        "\"" + Path.Combine(root, "packages", "server", "dist", "index.js") + "\"");
                    info.WorkingDirectory = root;
                    info.UseShellExecute = false;
                    info.CreateNoWindow = true;
                    info.RedirectStandardOutput = true;
                    info.RedirectStandardError = true;
                    info.EnvironmentVariables["SB_HOST"] = "127.0.0.1";
                    info.EnvironmentVariables["SB_PORT"] = Port.ToString();
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
                    if (!WaitForServer(server)) throw new Exception("本地服务未能启动，详见日志。");
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Window = CreateWindow();
                    using (NotifyIcon tray = new NotifyIcon())
                    using (ContextMenuStrip menu = new ContextMenuStrip())
                    using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer())
                    {
                        menu.Items.Add("打开 StudentBuddy", null, delegate { ShowWindow(); });
                        menu.Items.Add("退出 StudentBuddy", null, delegate { ExitApp(); });
                        tray.Icon = SystemIcons.Application;
                        tray.Text = "StudentBuddy";
                        tray.ContextMenuStrip = menu;
                        tray.DoubleClick += delegate { ShowWindow(); };
                        tray.Visible = true;
                        timer.Interval = 500;
                        timer.Tick += delegate
                        {
                            if (stop.WaitOne(0)) ExitApp();
                            else if (server.HasExited)
                            {
                                ShowError("本地服务已停止，请重新启动 StudentBuddy。");
                                ExitApp();
                            }
                            else if (show.WaitOne(0)) ShowWindow();
                        };
                        timer.Start();
                        if (!noWindow) Window.Show();
                        Application.Run();
                        tray.Visible = false;
                    }
                    if (Window != null) { Window.Dispose(); Window = null; }
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
                    try { if (File.Exists(PortFile)) File.Delete(PortFile); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                    instance.ReleaseMutex();
                }
            }
        }
    }

    /** 主窗口：WinForms 窗体承载 WebView2，加载本地服务；关闭只隐藏到托盘。 */
    private static Form CreateWindow()
    {
        Form form = new Form();
        form.Text = "StudentBuddy";
        form.Icon = SystemIcons.Application;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.MinimumSize = new Size(880, 560);
        form.Size = new Size(1180, 780);
        WebView2 view = new WebView2();
        view.Dock = DockStyle.Fill;
        form.Controls.Add(view);
        form.FormClosing += delegate(object sender, FormClosingEventArgs e)
        {
            if (!Exiting) { e.Cancel = true; form.Hide(); }
        };
        form.Shown += async delegate(object sender, EventArgs e)
        {
            if (WebviewStarted) return;
            WebviewStarted = true;
            try
            {
                // 用户数据目录固定放在 LOCALAPPDATA，不写进安装目录。
                string dataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "StudentBuddy", "webview2");
                Directory.CreateDirectory(dataFolder);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, dataFolder, null);
                await view.EnsureCoreWebView2Async(environment);
                view.Source = new Uri(Url);
            }
            catch (Exception error)
            {
                // 不静默失败：写明原因并降级用系统浏览器打开，服务与数据不受影响。
                WebviewFailed = true;
                Log("应用窗口初始化失败，改用系统浏览器：" + error.ToString());
                OpenInBrowser();
            }
        };
        return form;
    }

    /** 显示并激活主窗口；窗口初始化失败时降级为浏览器打开。 */
    private static void ShowWindow()
    {
        if (WebviewFailed) { OpenInBrowser(); return; }
        if (Window == null) return;
        if (!Window.Visible) Window.Show();
        if (Window.WindowState == FormWindowState.Minimized) Window.WindowState = FormWindowState.Normal;
        Window.Activate();
        Window.BringToFront();
    }

    /** 通知已在运行的实例把窗口带到前台（第二实例用）。 */
    private static void SignalShow()
    {
        try
        {
            using (EventWaitHandle signal = EventWaitHandle.OpenExisting(Identity + ".Show")) signal.Set();
        }
        catch (WaitHandleCannotBeOpenedException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void ExitApp()
    {
        Exiting = true;
        Application.ExitThread();
    }

    private static void OpenInBrowser()
    {
        try { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); }
        catch (Exception error) { Log(error.ToString()); }
    }

    /** 择优端口：优先 18794；被占用或被系统「端口排除段」拦下时，改用回环空闲端口。 */
    private static int SelectPort()
    {
        if (CanBind(PreferredPort)) return PreferredPort;
        int picked;
        TcpListener probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        try { picked = ((IPEndPoint)probe.LocalEndpoint).Port; }
        finally { probe.Stop(); }
        Log("首选端口 " + PreferredPort.ToString() + " 不可用（被占用或被系统排除），改用回环端口 " + picked.ToString());
        return picked;
    }

    private static bool CanBind(int port)
    {
        TcpListener probe = new TcpListener(IPAddress.Loopback, port);
        try { probe.Start(); return true; }
        catch (SocketException) { return false; }
        finally { probe.Stop(); }
    }

    /** 第二实例读回已在运行的实例实际使用的端口。 */
    private static int ReadOwnedPort()
    {
        try
        {
            int port;
            string text = File.ReadAllText(PortFile).Trim();
            if (int.TryParse(text, out port) && port > 0 && port < 65536) return port;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return PreferredPort;
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
                {
                    // /api/health 的载荷会随版本增字段（version / instance / sse / rssMb…）。
                    // 只认 ok:true，不做整串相等比较——否则服务端一加字段，启动器就永远等不到就绪。
                    string body = reader.ReadToEnd().Replace(" ", "");
                    if (body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0) return true;
                }
            }
            catch (WebException) { }
            Thread.Sleep(250);
        }
        return false;
    }

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