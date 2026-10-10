using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
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
    /** 悬浮球（桌面版 0.2.0 起）：无边框置顶的吉祥物小窗，独立于主窗口的第二个 WebView2。--no-browser 时为 null。 */
    private static Form BallWindow;
    private static bool BallStarted;
    /** 球态与展开态的逻辑尺寸（按当前 DPI 换算后才是物理像素） */
    private const int BallLogical = 96;
    private const int ScreenLogicalW = 420;
    private const int ScreenLogicalH = 760;
    /**
     * 球态要「桌上只有一只吉祥物、没有窗口底板」：用**窗口 Region 按吉祥物外形把球窗裁出来**
     * （数据由 make-icon.mjs 从点阵生成，见 mascot-region.txt）。
     * ★ 为什么不用颜色键（TransparencyKey）：那会把窗体变成**分层窗口**（WS_EX_LAYERED），
     *   而分层窗口的子窗口收不到鼠标消息 —— 实测「点了没反应」，日志里一条消息都没有。
     *   Region 是硬边、不影响子窗口输入，而且像素风的边缘本来就该是硬的。
     */
    private const int BallCellLogical = 5;
    private const int BallOriginLogical = 8;
    /** 球窗底色：取吉祥物轮廓的墨色，万一裁剪边缘有 1px 缝隙也看不出来 */
    private static readonly Color BallSeamColor = Color.FromArgb(60, 28, 43);
    /** 品牌图标：构建期由吉祥物点阵生成（tools/desktop/make-icon.mjs），随安装包分发；读不到退回系统默认 */
    private static Icon AppIcon;
    private static Icon TrayIcon;
    /** 两个 WebView2 共用一个环境（同一份用户数据目录）；只建一次。 */
    private static CoreWebView2Environment WebviewEnv;
    private static readonly string BallPosFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudentBuddy", "float-pos");
    // 无边框窗口拖动：WebView2 吃掉了鼠标事件，只能请宿主进入系统原生移动循环
    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int HTCAPTION = 0x0002;
    private const int WM_EXITSIZEMOVE = 0x0232;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

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
                    AppIcon = LoadIcon(0);
                    TrayIcon = LoadIcon(SystemInformation.SmallIconSize.Width);
                    Window = CreateWindow();
                    // --no-browser（自动化/冒烟）：不建球窗，省一个 WebView2 进程
                    if (!noWindow) BallWindow = CreateBallWindow();
                    using (NotifyIcon tray = new NotifyIcon())
                    using (ContextMenuStrip menu = new ContextMenuStrip())
                    using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer())
                    {
                        menu.Items.Add("打开 StudentBuddy", null, delegate { ShowWindow(); });
                        ToolStripMenuItem ballItem = new ToolStripMenuItem("显示悬浮球");
                        ballItem.Click += delegate { ToggleBall(); };
                        menu.Items.Add(ballItem);
                        // 球态与展开态是**同一个窗口**：网页里点「对战」会离开 #/float，收起按钮随之消失。
                        // 这一项把球窗拉回吉祥物页（尺寸也收回去），是那条路唯一的出路（见 DESKTOP-SPEC）。
                        ToolStripMenuItem homeItem = new ToolStripMenuItem("悬浮球回到吉祥物");
                        homeItem.Click += delegate { ResetBall(); };
                        menu.Items.Add(homeItem);
                        menu.Items.Add("退出 StudentBuddy", null, delegate { ExitApp(); });
                        // 文本随球窗可见性变（一个开关项，不在菜单里放两个互斥项）
                        menu.Opening += delegate
                        {
                            ballItem.Text = BallWindow != null && BallWindow.Visible ? "隐藏悬浮球" : "显示悬浮球";
                            homeItem.Enabled = BallWindow != null;
                        };
                        tray.Icon = TrayIcon;
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
                        if (!noWindow)
                        {
                            Window.Show();
                            if (BallWindow != null) BallWindow.Show();
                        }
                        Application.Run();
                        tray.Visible = false;
                    }
                    if (BallWindow != null) { BallWindow.Dispose(); BallWindow = null; }
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

    /** 主显示器 DPI 缩放比（96 DPI = 1.0）。
     *  ★ 为什么需要：清单声明 PerMonitorV2 之后，窗体尺寸的单位是**物理像素**——
     *  在 200% 缩放的屏幕上若不换算，窗口只有期望尺寸的一半大。
     *  读取失败一律回落 1.0（宁可窗口偏小，也不要因为一次探测失败起不来）。 */
    private static float SystemDpiScale()
    {
        try
        {
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
            {
                float scale = g.DpiX / 96f;
                return scale > 0f ? scale : 1f;
            }
        }
        catch (Exception) { return 1f; }
    }

    /** 主窗口：WinForms 窗体承载 WebView2，加载本地服务；关闭只隐藏到托盘。 */
    private static Form CreateWindow()
    {
        Form form = new Form();
        form.Text = "StudentBuddy";
        form.Icon = AppIcon;
        form.StartPosition = FormStartPosition.CenterScreen;
        // 尺寸按当前 DPI 换算（逻辑尺寸 1180×780 / 最小 880×560）；AutoScaleMode 显式 None
        // 以避免 WinForms 再缩一次（本窗体唯一子控件是 Dock=Fill 的 WebView2，无需布局缩放）。
        form.AutoScaleMode = AutoScaleMode.None;
        float scale = SystemDpiScale();
        form.MinimumSize = new Size((int)Math.Round(880 * scale), (int)Math.Round(560 * scale));
        form.Size = new Size((int)Math.Round(1180 * scale), (int)Math.Round(780 * scale));
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
                await view.EnsureCoreWebView2Async(await WebviewEnvironment());
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

    /** 两个 WebView2 共用的环境（同一份用户数据目录，固定放在 LOCALAPPDATA，不写进安装目录）；只建一次。 */
    private static async Task<CoreWebView2Environment> WebviewEnvironment()
    {
        if (WebviewEnv != null) return WebviewEnv;
        string dataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "StudentBuddy", "webview2");
        Directory.CreateDirectory(dataFolder);
        WebviewEnv = await CoreWebView2Environment.CreateAsync(null, dataFolder, null);
        return WebviewEnv;
    }

    /** 应用图标（构建期由吉祥物点阵生成，tools/desktop/make-icon.mjs）；读不到就退回系统默认，绝不因此起不来。 */
    private static Icon LoadIcon(int size)
    {
        try
        {
            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
            if (File.Exists(path)) return size > 0 ? new Icon(path, size, size) : new Icon(path);
        }
        catch (Exception error) { Log("图标加载失败，用系统默认图标：" + error.Message); }
        return SystemIcons.Application;
    }

    /**
     * 悬浮球（桌面版 0.2.0 起，契约 docs/DESKTOP-SPEC.md「桌面悬浮球」）：
     * 无边框 + 置顶 + 不在任务栏 + 可拖 + 位置记忆，独立 WebView2 加载 `#/float`。
     * ★ **球态按吉祥物外形裁剪**（ApplyBallRegion）：桌面上看见的只有一只吉祥物，
     *   轮廓外的点击穿透到桌面；网页整页透明，只画吉祥物本身。
     * ★ 不用 WinForms 的默认拖动（无边框窗口没有标题栏）——拖动由网页经 WebView2 消息请宿主代做，
     *   见 HandleBallMessage。
     */
    private static Form CreateBallWindow()
    {
        BallForm form = new BallForm();
        form.FormBorderStyle = FormBorderStyle.None;
        form.ShowInTaskbar = false;
        form.TopMost = true;
        form.StartPosition = FormStartPosition.Manual;
        form.AutoScaleMode = AutoScaleMode.None;
        form.Text = "StudentBuddy 吉祥物";
        form.Icon = AppIcon;
        form.BackColor = BallSeamColor;
        Size ball = BallSize();
        form.ClientSize = ball;
        // 显式最小尺寸：WinForms 给无边框窗体自己塞的最小宽度会让球变成扁的
        form.MinimumSize = ball;
        form.MaximumSize = new Size(0, 0);
        form.Location = ReadBallPos(ball);
        form.Settled = delegate { SaveBallPos(form); };
        WebView2 view = new WebView2();
        view.Dock = DockStyle.Fill;
        // 透明底：裁剪区里若有网页没画到的像素，露出来的是窗体底色（墨色），不是白块
        view.DefaultBackgroundColor = Color.Transparent;
        form.Controls.Add(view);
        ApplyBallRegion(form);
        form.Shown += async delegate(object sender, EventArgs e)
        {
            if (BallStarted) return;
            BallStarted = true;
            try
            {
                await view.EnsureCoreWebView2Async(await WebviewEnvironment());
                view.CoreWebView2.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs ev)
                {
                    HandleBallMessage(ev.TryGetWebMessageAsString());
                };
                view.Source = new Uri(Url + "/#/float");
            }
            catch (Exception error)
            {
                // 球窗失败不牵连主窗口：记日志并收掉它，主窗口照常可用。
                Log("悬浮球初始化失败：" + error.ToString());
                form.Hide();
            }
        };
        return form;
    }

    /** 球态（吉祥物）的物理尺寸 */
    private static Size BallSize()
    {
        float scale = SystemDpiScale();
        int side = (int)Math.Round(BallLogical * scale);
        return new Size(side, side);
    }

    /**
     * 按吉祥物外形把球窗裁出来（网格单位矩形来自 `mascot-region.txt`，由 make-icon.mjs 从点阵生成）。
     * 坐标系与网页对齐：吉祥物是最外圈 16 格、每格 5 逻辑 px、整块居中于 96 逻辑 px 的窗口
     * （见 float.css 的 `.sb-ball .welcome-mascot svg { width: 80px }`）。
     * ★ 读不到外形文件时退回**椭圆**兜底 —— 至少不是一个方块，且球仍然可点、可拖。
     */
    private static void ApplyBallRegion(Form form)
    {
        try
        {
            float scale = SystemDpiScale();
            int cell = (int)Math.Round(BallCellLogical * scale);
            int origin = (int)Math.Round(BallOriginLogical * scale);
            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mascot-region.txt");
            Region region = new Region();
            region.MakeEmpty();
            bool any = false;
            if (File.Exists(path))
            {
                foreach (string line in File.ReadAllLines(path))
                {
                    string[] parts = line.Trim().Split(' ');
                    int x, y, w;
                    if (parts.Length == 3
                        && int.TryParse(parts[0], out x)
                        && int.TryParse(parts[1], out y)
                        && int.TryParse(parts[2], out w))
                    {
                        region.Union(new Rectangle(origin + x * cell, origin + y * cell, w * cell, cell));
                        any = true;
                    }
                }
            }
            if (!any)
            {
                Log("吉祥物外形文件缺失或损坏，悬浮球改用椭圆兜底。");
                using (GraphicsPath path2 = new GraphicsPath())
                {
                    path2.AddEllipse(0, 0, form.ClientSize.Width, form.ClientSize.Height);
                    region = new Region(path2);
                }
            }
            form.Region = region;
        }
        catch (Exception error) { Log("悬浮球外形裁剪失败：" + error.ToString()); }
    }

    /** 球窗里那个 WebView2（窗体唯一的子控件） */
    private static WebView2 BallWebView()
    {
        if (BallWindow == null || BallWindow.Controls.Count == 0) return null;
        return BallWindow.Controls[0] as WebView2;
    }

    /** 显示/隐藏悬浮球（托盘菜单用）。没有球窗（--no-browser）时空操作。 */
    private static void ToggleBall()
    {
        if (BallWindow == null) return;
        if (BallWindow.Visible) BallWindow.Hide();
        else
        {
            BallWindow.Show();
            BallWindow.BringToFront();
        }
    }

    /**
     * 把球窗拉回吉祥物页（托盘「悬浮球回到吉祥物」）：
     * 展开态里点「对战」会离开 `#/float`，网页的收起按钮随之消失 —— 这条是那条路唯一的出路。
     * 先把尺寸收回球态，再让 WebView2 重新导航回 `#/float`（导航会把整棵 React 树重置回球态）。
     */
    private static void ResetBall()
    {
        if (BallWindow == null) return;
        SetBallExpanded(false);
        try
        {
            WebView2 view = BallWebView();
            if (view != null && view.CoreWebView2 != null) view.CoreWebView2.Navigate(Url + "/#/float");
        }
        catch (Exception error) { Log("重置悬浮球失败：" + error.ToString()); }
        if (!BallWindow.Visible) BallWindow.Show();
        BallWindow.BringToFront();
    }

    /**
     * 悬浮球网页经 `window.chrome.webview.postMessage` 请宿主代做的事（拖动 / 展开 / 收起）。
     * ★ 常量必须与网页侧 `features/float/float-view.ts` 的 HOST_* 逐字一致。
     */
    private static void HandleBallMessage(string message)
    {
        Log("球窗收到消息：" + message);
        if (message == "sb-float:drag")
        {
            // 进入系统原生窗口移动循环：网页改不了 OS 窗口位置，这是无边框 WebView2 窗唯一可靠的做法
            if (BallWindow == null) return;
            Point before = BallWindow.Location;
            ReleaseCapture();
            SendMessage(BallWindow.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            // ★ 移动循环是**同步**返回的（松开鼠标才回来）：位置没变 ⇒ 这是一次「点一下」而不是拖动。
            //   网页侧看不到位移（WebView2 按住不放时不派发 pointermove），所以这个判断只能在这儿做。
            if (BallWindow.Location == before)
            {
                WebView2 view = BallWebView();
                if (view != null && view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsString("sb-float:tap");
            }
        }
        else if (message == "sb-float:expand")
        {
            SetBallExpanded(true);
        }
        else if (message == "sb-float:collapse")
        {
            SetBallExpanded(false);
        }
    }

    /**
     * 在「球态」与「展开态（手机小屏）」之间切窗口尺寸，并把窗口夹回屏幕内。
     * ★ 只改尺寸、**不导航**：网页侧自己切本地视图 —— 导航会把 App 整棵重挂，草稿与滚动位置全丢。
     */
    private static void SetBallExpanded(bool expanded)
    {
        if (BallWindow == null) return;
        float scale = SystemDpiScale();
        Size size = expanded
            ? new Size((int)Math.Round(ScreenLogicalW * scale), (int)Math.Round(ScreenLogicalH * scale))
            : BallSize();
        SetBallBounds(size);
        // 展开态是正常矩形窗（手机小屏要满窗），球态才按吉祥物外形裁剪
        if (expanded) BallWindow.Region = null;
        else ApplyBallRegion(BallWindow);
    }

    /** 改尺寸并保证整窗落在当前屏幕工作区内 —— 球贴在屏幕右下角时直接放大一定会跑出去。 */
    private static void SetBallBounds(Size size)
    {
        Rectangle area;
        try { area = Screen.FromControl(BallWindow).WorkingArea; }
        catch (Exception) { area = Screen.PrimaryScreen.WorkingArea; }
        int width = Math.Min(size.Width, area.Width);
        int height = Math.Min(size.Height, area.Height);
        int x = Math.Min(Math.Max(BallWindow.Location.X, area.Left), area.Right - width);
        int y = Math.Min(Math.Max(BallWindow.Location.Y, area.Top), area.Bottom - height);
        BallWindow.Bounds = new Rectangle(new Point(x, y), new Size(width, height));
    }

    /** 读球窗上次落盘的位置；没有、损坏或已跑到屏幕外时回落到主屏右下角。 */
    private static Point ReadBallPos(Size size)
    {
        try
        {
            string[] parts = File.ReadAllText(BallPosFile).Trim().Split(',');
            int x, y;
            if (parts.Length == 2
                && int.TryParse(parts[0], out x)
                && int.TryParse(parts[1], out y)
                && BallPosOnScreen(x, y, size))
            {
                return new Point(x, y);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (FormatException) { }
        try
        {
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            int margin = (int)Math.Round(24 * SystemDpiScale());
            return new Point(area.Right - size.Width - margin, area.Bottom - size.Height - margin);
        }
        catch (Exception) { return new Point(0, 0); }
    }

    /** 至少有一半窗面落在虚拟屏内才认（换显示器/改分辨率后不至于把球留在看不见的地方）。 */
    private static bool BallPosOnScreen(int x, int y, Size size)
    {
        try
        {
            Rectangle screen = SystemInformation.VirtualScreen;
            return x > screen.Left - size.Width / 2 && x < screen.Right - size.Width / 2
                && y > screen.Top - size.Height / 2 && y < screen.Bottom - size.Height / 2;
        }
        catch (Exception) { return false; }
    }

    private static void SaveBallPos(Form form)
    {
        try
        {
            File.WriteAllText(BallPosFile, form.Location.X.ToString() + "," + form.Location.Y.ToString());
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /**
     * 悬浮球的窗体类型。唯一的作用是拦下 **WM_EXITSIZEMOVE**：系统原生移动循环结束时
     * 才把位置落盘（`LocationChanged` 在拖动中每帧都发，每分钟写上百次文件）。
     */
    private sealed class BallForm : Form
    {
        public Action Settled;
        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg == WM_EXITSIZEMOVE && Settled != null) Settled();
        }
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