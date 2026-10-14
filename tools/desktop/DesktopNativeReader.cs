using System;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class DesktopNativeReader : Form
{
    private readonly string endpoint, code;
    private readonly WebView2 view = new WebView2();
    private readonly TextBox address = new TextBox();
    private readonly Button read = new Button();
    private readonly Label status = new Label();
    private readonly Timer timer = new Timer();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 800000 };
    private string token = "", epoch = Guid.NewGuid().ToString("N");
    private int generation, seq;
    private bool started, busy, closed, ready;
    internal DesktopNativeReader(string endpoint, string code)
    {
        this.endpoint = endpoint; this.code = code;
        Text = "StudentBuddy 网页共读"; Size = new Size(1050, 760); MinimumSize = new Size(700, 500);
        StartPosition = FormStartPosition.CenterScreen;
        FlowLayoutPanel toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8) };
        address.Width = 440; address.AccessibleName = "网页地址";
        Button go = new Button { Text = "打开网页", AutoSize = true };
        read.Text = "开始共读"; read.AutoSize = true; read.Enabled = false;
        status.Text = "选择网页，再点击开始；尚未读取正文"; status.AutoSize = true; status.Dock = DockStyle.Bottom; status.Padding = new Padding(8);
        toolbar.Controls.Add(address); toolbar.Controls.Add(go); toolbar.Controls.Add(read);
        view.Dock = DockStyle.Fill; Controls.Add(view); Controls.Add(toolbar); Controls.Add(status);
        go.Click += delegate { NavigateAddress(); };
        address.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; NavigateAddress(); } };
        read.Click += async delegate {
            if (!ready) return;
            if (started) { started = false; read.Text = "开始共读"; generation++; await DropPage(); epoch = Guid.NewGuid().ToString("N"); seq = 0; status.Text = "已停止并清除临时正文"; }
            else if (AllowedAddress(view.Source == null ? "" : view.Source.AbsoluteUri)) { started = true; read.Text = "停止共读"; await Snapshot(); }
            else status.Text = "请先打开一个公开 http/https 网页";
        };
        timer.Interval = 1500; timer.Tick += async delegate { await Snapshot(); };
        Shown += async delegate { await Initialize(); };
        FormClosed += delegate { closed = true; started = false; generation++; timer.Stop(); timer.Dispose(); string old = token; token = ""; if (old.Length > 0) Forget(old); };
    }
    internal static bool AllowedAddress(string raw)
    {
        Uri uri;
        if (raw.Length > 3000 || !Uri.TryCreate(raw, UriKind.Absolute, out uri) || !(uri.Scheme == "http" || uri.Scheme == "https") || uri.UserInfo.Length > 0) return false;
        string host = uri.DnsSafeHost.ToLowerInvariant(); IPAddress ip;
        if (!host.Contains(".") || host.EndsWith(".local") || host.EndsWith(".localhost") || host.EndsWith(".internal") || host == "localhost") return false;
        if (IPAddress.TryParse(host, out ip)) {
            byte[] b = ip.GetAddressBytes();
            if (b.Length != 4 || b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224 || b[0] == 169 && b[1] == 254 || b[0] == 172 && b[1] >= 16 && b[1] <= 31 || b[0] == 192 && b[1] == 168 || b[0] == 100 && b[1] >= 64 && b[1] <= 127) return false;
        }
        return true;
    }
    private void NavigateAddress()
    {
        string url = address.Text.Trim(); if (!url.Contains("://")) url = "https://" + url;
        if (!AllowedAddress(url)) { status.Text = "请输入公开 http/https 网页地址（不支持本机地址或文件协议）"; return; }
        if (ready) view.CoreWebView2.Navigate(url); else status.Text = "浏览窗口正在准备，请稍后打开";
    }
    private async Task Initialize()
    {
        try {
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudentBuddy", "reader-webview2");
            await view.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(null, profile, null));
            if (closed) return;
            // Remote pages must never have the privileged bridge used by the app.
            view.CoreWebView2.Settings.IsWebMessageEnabled = false;
            view.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            view.CoreWebView2.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
            view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; if (AllowedAddress(e.Uri)) view.CoreWebView2.Navigate(e.Uri); };
            view.CoreWebView2.NavigationStarting += async delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                if (!AllowedAddress(e.Uri)) { e.Cancel = true; return; }
                generation++; string old = epoch; epoch = Guid.NewGuid().ToString("N"); seq = 0;
                if (started) await DropPage(old);
            };
            view.CoreWebView2.NavigationCompleted += delegate { if (!closed && view.Source != null) address.Text = view.Source.AbsoluteUri; };
            view.CoreWebView2.ProcessFailed += delegate { started = false; read.Text = "开始共读"; status.Text = "网页进程已中断，请关闭并重新打开共读窗口"; Forget(token); token = ""; ready = false; read.Enabled = false; };
            string paired = await Send("/pair", "POST", json.Serialize(new { code = code }), "");
            var result = json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(paired);
            string candidate = Convert.ToString(result["token"]);
            if (!Regex.IsMatch(candidate, "^[a-f0-9]{64}$")) throw new Exception("Pair failed");
            if (closed) { Forget(candidate); return; }
            token = candidate; ready = true; read.Enabled = true; timer.Start();
            status.Text = "已连接当前对话；打开网页后点击开始共读，不会自动提取";
        } catch { if (!closed) status.Text = "共读连接失败，请关闭窗口后重新点击网页共读"; }
    }
    private async Task Snapshot()
    {
        if (!ready || !started || closed || busy || view.Source == null || !AllowedAddress(view.Source.AbsoluteUri)) return;
        busy = true; int before = generation; string pageEpoch = epoch;
        try {
            // ExecuteScript returns data only; pages cannot supply a host message/endpoint.
            string extractor = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "browser-extension", "extract.js"));
            string raw = await view.ExecuteScriptAsync(extractor + "\n;JSON.stringify({...globalThis.studentBuddyReadPage(),url:location.href,title:document.title})");
            if (!started || closed || generation != before) return;
            string data = json.Deserialize<string>(raw);
            var page = json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(data);
            page["epoch"] = pageEpoch; page["seq"] = ++seq;
            await Send("/page", "POST", json.Serialize(page), token);
            if (!closed && started && generation == before) status.Text = "共读中 · 正文和划选临时同步到当前对话 · 停止即清除";
        } catch (WebException error) {
            HttpWebResponse response = error.Response as HttpWebResponse;
            if (response != null && (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.NotFound)) {
                ready = false; started = false; token = "";
                if (!closed) { read.Enabled = false; status.Text = "当前对话连接已结束，请关闭窗口并重新点击网页共读"; }
            } else if (!closed && started) status.Text = "本机连接暂不可用；正在重试";
        } catch { if (!closed && started) status.Text = "当前页暂不可读取；正在重试（登录页或无正文可能无法共读）"; }
        finally { busy = false; }
    }
    private async Task DropPage(string previous = null)
    {
        if (token.Length == 0) return;
        try { await Send("/page", "DELETE", json.Serialize(new { epoch = previous ?? epoch }), token); } catch { }
    }
    private async void Forget(string previous)
    {
        if (previous.Length == 0) return;
        try { await Send("/connection", "DELETE", "{}", previous); } catch { }
    }
    private async Task<string> Send(string path, string method, string body, string bearer)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint + path);
        request.Method = method; request.ContentType = "application/json"; request.Proxy = null; request.AllowAutoRedirect = false; request.Timeout = 5000;
        if (bearer.Length > 0) request.Headers["Authorization"] = "Bearer " + bearer;
        byte[] bytes = Encoding.UTF8.GetBytes(body); request.ContentLength = bytes.Length;
        // HttpWebRequest.Timeout does not bound its async methods on .NET Framework.
        using (System.Threading.Timer abort = new System.Threading.Timer(delegate { request.Abort(); }, null, 5000, System.Threading.Timeout.Infinite)) {
            using (Stream stream = await request.GetRequestStreamAsync()) await stream.WriteAsync(bytes, 0, bytes.Length);
            using (WebResponse response = await request.GetResponseAsync()) using (StreamReader reader = new StreamReader(response.GetResponseStream())) return await reader.ReadToEndAsync();
        }
    }
}
internal static partial class Launcher
{
    private static DesktopNativeReader ReaderWindow;
    private static void OpenNativeReader(string message)
    {
        string code = message.Substring("sb-desktop:reader:".Length);
        if (!Regex.IsMatch(code, "^[a-f0-9]{10}$") || Exiting) return;
        if (ReaderWindow != null && !ReaderWindow.IsDisposed) ReaderWindow.Close();
        ReaderWindow = new DesktopNativeReader(Url + "/api/desktop/bridge", code);
        ReaderWindow.Icon = AppIcon; ReaderWindow.Show();
    }
}
