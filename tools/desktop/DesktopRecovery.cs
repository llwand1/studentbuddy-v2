using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/** Supervise only our own child process. Recovery never exits the UI, changes its origin,
 * or terminates an unrelated Node. Backoff also covers failed starts, and shutdown wins.
 */
internal sealed class DesktopServerSupervisor : IDisposable
{
    private readonly object gate = new object();
    private readonly ProcessStartInfo info;
    private readonly Func<Process, bool> wait;
    private readonly Action<string> log;
    private readonly OwnedProcessJob job;
    private Process process;
    private bool stopped, recovering;
    private int failures;
    private DateTime nextStart, started;
    private volatile bool ready;
    internal bool Ready { get { return ready; } private set { ready = value; } }
    private volatile int generation;
    internal int Generation { get { return generation; } }
    internal DesktopServerSupervisor(ProcessStartInfo info, Func<Process, bool> wait, Action<string> log)
    { this.info = info; this.wait = wait; this.log = log; job = new OwnedProcessJob(); }
    internal bool Start() { return Recover(); }
    internal void Tick()
    {
        lock (gate)
        {
            if (stopped || recovering) return;
            if (process != null && !process.HasExited)
            {
                if (Ready && DateTime.UtcNow - started > TimeSpan.FromMinutes(2)) failures = 0;
                return;
            }
            Ready = false;
            if (DateTime.UtcNow < nextStart) return;
            recovering = true;
            Task.Run((Action)delegate { Recover(); });
        }
    }
    private bool Recover()
    {
        bool ready = false;
        try
        {
            Process child;
            lock (gate)
            {
                if (stopped) return false;
                ReleaseProcess();
                process = child = new Process(); child.StartInfo = info;
                child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) log(e.Data); };
                child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) log(e.Data); };
                child.Start(); job.Attach(child); child.BeginOutputReadLine(); child.BeginErrorReadLine();
                started = DateTime.UtcNow;
                log("本地服务启动 PID=" + child.Id.ToString());
            }
            ready = wait(child);
            if (ready) log("本地服务已就绪（保留会话与原端口）。");
        }
        catch (Exception error) { log("本地服务恢复失败：" + error.Message); }
        finally
        {
            lock (gate)
            {
                Ready = ready && !stopped;
                if (Ready) generation++;
                if (!Ready) ReleaseProcess();
                if (!stopped)
                {
                    failures++;
                    nextStart = DateTime.UtcNow.AddSeconds(Launcher.RecoveryDelay(failures));
                    if (!ready) log("稍后自动重试本地服务，不退出学习窗口。");
                }
                recovering = false;
            }
        }
        return Ready;
    }
    private void ReleaseProcess()
    {
        if (process == null) return;
        try { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        process.Dispose(); process = null;
    }
    public void Dispose() { lock (gate) { stopped = true; Ready = false; ReleaseProcess(); job.Dispose(); } }
}

/** A killed launcher cannot run finally. A non-inherited kill-on-close job releases its
 * service tree when Windows closes the launcher's handles, so the watchdog starts cleanly.
 */
internal sealed class OwnedProcessJob : IDisposable
{
    private IntPtr handle;
    [StructLayout(LayoutKind.Sequential)] private struct Limits
    {
        internal long ProcessTime, JobTime;
        internal uint Flags;
        internal UIntPtr MinWorkingSet, MaxWorkingSet;
        internal uint ActiveProcesses;
        internal UIntPtr Affinity;
        internal uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    { internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    { internal Limits Basic; internal IoCounters Io; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
    internal OwnedProcessJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
        if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        { int error = Marshal.GetLastWin32Error(); Dispose(); throw new System.ComponentModel.Win32Exception(error, "无法创建本地服务进程守护"); }
    }
    internal void Attach(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "无法守护本地服务进程");
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}

internal static partial class Launcher
{
    private static bool WatchdogStarted;
    private static string BallDisplayMode = "ball";
    private static readonly Dictionary<Form, DateTime> PendingViews = new Dictionary<Form, DateTime>();
    private static readonly Dictionary<Form, int> ViewFailures = new Dictionary<Form, int>();
    private static readonly Dictionary<Form, string> ViewUrls = new Dictionary<Form, string>();
    internal static int RecoveryDelay(int failures) { return failures <= 1 ? 1 : failures >= 6 ? 30 : 1 << (failures - 1); }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);
    private static void StartWatchdog(string[] args)
    {
        if (Array.IndexOf(args, "--watched") >= 0) return;
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(Application.ExecutablePath,
                "--watchdog " + Process.GetCurrentProcess().Id.ToString() + (Quiet ? " --no-browser" : "") + (Array.IndexOf(args, "--start-minimized") >= 0 ? " --start-minimized" : ""));
            info.UseShellExecute = false; info.CreateNoWindow = true;
            Process guard = Process.Start(info); guard.Dispose(); WatchdogStarted = true;
        }
        catch (Exception error) { Log("启动崩溃守护失败：" + error.Message); }
    }
    private static int RunWatchdog(string[] args, int index)
    {
        int pid;
        if (index + 1 >= args.Length || !int.TryParse(args[index + 1], out pid) || pid <= 0) return 1;
        Process target;
        try
        {
            target = Process.GetProcessById(pid);
            if (!String.Equals(target.MainModule.FileName, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase)) { target.Dispose(); return 1; }
        }
        catch (Exception) { return 0; }
        int failures = 0;
        for (;;)
        {
            DateTime started = DateTime.UtcNow;
            // .NET Framework cannot read ExitCode on a Process obtained by GetProcessById.
            // Retain its native handle before exit and query it directly instead.
            IntPtr targetHandle = target.Handle;
            target.WaitForExit(); int code;
            if (!GetExitCodeProcess(targetHandle, out code)) code = 1;
            target.Dispose();
            // Menu exit, --stop, update and uninstall return 0: never resurrect them.
            if (code == 0 || UpdateInProgress()) return 0;
            if (DateTime.UtcNow - started > TimeSpan.FromMinutes(2)) failures = 0;
            Log("桌面进程异常退出（" + code.ToString() + "），守护进程将自动重启。");
            Thread.Sleep(RecoveryDelay(++failures) * 1000);
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(Application.ExecutablePath,
                    "--watched" + (Array.IndexOf(args, "--no-browser") >= 0 ? " --no-browser" : "") + (Array.IndexOf(args, "--start-minimized") >= 0 ? " --start-minimized" : ""));
                info.UseShellExecute = false; info.CreateNoWindow = true;
                target = Process.Start(info);
            }
            catch (Exception error) { Log("桌面进程重启失败：" + error.Message); return 1; }
        }
    }

    /** Renderer exits/unresponsiveness need a fresh controller; browser exits close both
     * controllers. GPU/utility failures are recovered by WebView2 itself, so leave them alone.
     */
    private static void AttachViewRecovery(Form form, WebView2 view, bool ball)
    {
        view.CoreWebView2.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            if (e.ProcessFailedKind != CoreWebView2ProcessFailedKind.BrowserProcessExited &&
                e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessExited &&
                e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessUnresponsive &&
                e.ProcessFailedKind != CoreWebView2ProcessFailedKind.FrameRenderProcessExited) return;
            Log((ball ? "悬浮窗" : "主窗口") + "渲染异常：" + e.ProcessFailedKind.ToString());
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) WebviewEnv = null;
            ScheduleViewRecovery(form, ball);
        };
        view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
        { if (IsLocalMessage(e.Uri)) ViewUrls[form] = e.Uri; };
        view.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) ScheduleViewRecovery(form, ball);
            else if (e.IsSuccess) ViewFailures[form] = 0;
        };
    }
    private static void ScheduleViewRecovery(Form form, bool ball)
    {
        if (Exiting || form.IsDisposed || PendingViews.ContainsKey(form)) return;
        int failures; ViewFailures.TryGetValue(form, out failures);
        ViewFailures[form] = ++failures;
        PendingViews[form] = DateTime.UtcNow.AddSeconds(RecoveryDelay(failures));
        if (!ViewUrls.ContainsKey(form)) ViewUrls[form] = Url + (ball ? "/#/float" : "");
    }
    private static void RecoverViewsTick()
    {
        foreach (Form form in new List<Form>(PendingViews.Keys))
        {
            if (Exiting || form.IsDisposed) { PendingViews.Remove(form); continue; }
            if (DateTime.UtcNow < PendingViews[form]) continue;
            PendingViews[form] = DateTime.MaxValue;
            RebuildView(form, form == BallWindow);
        }
    }
    private static void NotifyServiceRestored(Form form)
    {
        if (form == null || form.IsDisposed || PendingViews.ContainsKey(form)) return;
        foreach (Control control in form.Controls)
        {
            WebView2 view = control as WebView2;
            if (view != null && view.CoreWebView2 != null)
                view.CoreWebView2.PostWebMessageAsString("sb-desktop:service-restored");
        }
    }
    private static async void RebuildView(Form form, bool ball)
    {
        try
        {
            foreach (Control old in new List<Control>(ControlsOf(form))) { form.Controls.Remove(old); old.Dispose(); }
            WebView2 view = new WebView2(); view.Dock = DockStyle.Fill;
            if (ball) view.DefaultBackgroundColor = Color.Transparent;
            form.Controls.Add(view);
            await view.EnsureCoreWebView2Async(await WebviewEnvironment());
            if (Exiting || form.IsDisposed) return;
            AttachViewRecovery(form, view, ball);
            if (ball) view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            view.CoreWebView2.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs e)
            {
                if (!IsLocalMessage(e.Source)) return;
                if (ball) HandleBallMessage(e.TryGetWebMessageAsString());
                else HandleDesktopMessage(view, e.TryGetWebMessageAsString());
            };
            string url = ViewUrls[form];
            if (ball && url.Contains("#/float"))
            {
                if (BallDisplayMode == "ball") SetBallExpanded(false);
                url = Url + "/#/float?mode=" + BallDisplayMode;
            }
            PendingViews.Remove(form);
            view.Source = new Uri(url);
            if (!ball) WebviewFailed = false;
            Log(ball ? "悬浮窗已自动恢复。" : "主窗口已自动恢复。");
        }
        catch (Exception error)
        {
            Log("窗口恢复失败：" + error.Message);
            PendingViews.Remove(form); ScheduleViewRecovery(form, ball);
        }
    }
    private static IEnumerable<Control> ControlsOf(Form form)
    { foreach (Control control in form.Controls) yield return control; }
}
