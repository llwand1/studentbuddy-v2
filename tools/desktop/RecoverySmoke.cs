using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

/** Isolated executable used by recovery-smoke.ps1. Never launches the installed UI,
 * acquires the desktop mutex, opens a database or kills a process it did not create.
 */
internal static class RecoverySmoke
{
    private static readonly BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance;
    private static Type Supervisor, Launcher;
    private static string AssemblyPath, NodePath, Root;
    private static int checks;
    private static void Check(bool condition, string message)
    { if (!condition) throw new Exception(message); checks++; Console.WriteLine("PASS " + message); }
    private static bool Eventually(Func<bool> condition, int seconds)
    { DateTime until = DateTime.UtcNow.AddSeconds(seconds); do { if (condition()) return true; Thread.Sleep(50); } while (DateTime.UtcNow < until); return false; }
    private static ProcessStartInfo IdleInfo()
    {
        ProcessStartInfo info = new ProcessStartInfo(NodePath, "-e \"setInterval(()=>{},1000)\"");
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        return info;
    }
    private static object Create(Func<Process, bool> wait)
    { return Activator.CreateInstance(Supervisor, Flags, null, new object[] { IdleInfo(), wait, (Action<string>)delegate(string line) {} }, null); }
    private static bool Start(object server) { return (bool)Supervisor.GetMethod("Start", Flags).Invoke(server, null); }
    private static void Tick(object server) { Supervisor.GetMethod("Tick", Flags).Invoke(server, null); }
    private static bool Ready(object server) { return (bool)Supervisor.GetProperty("Ready", Flags).GetValue(server, null); }
    private static Process Owned(object server) { return (Process)Supervisor.GetField("process", Flags).GetValue(server); }
    private static void Dispose(object server) { ((IDisposable)server).Dispose(); }
    private static Process Child(string args)
    {
        ProcessStartInfo info = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
            "\"" + AssemblyPath + "\" \"" + NodePath + "\" \"" + Root + "\" " + args);
        info.UseShellExecute = false; info.CreateNoWindow = true;
        return Process.Start(info);
    }
    private static void Configure(string[] args)
    {
        AssemblyPath = args[0]; NodePath = args[1]; Root = args[2];
        Assembly assembly = Assembly.LoadFrom(AssemblyPath);
        Supervisor = assembly.GetType("DesktopServerSupervisor", true); Launcher = assembly.GetType("Launcher", true);
        Launcher.GetField("LogPath", Flags).SetValue(null, Path.Combine(Root, "isolated-desktop.log"));
        Launcher.GetField("UpdateLockPath", Flags).SetValue(null, Path.Combine(Root, "isolated-update-lock"));
    }
    private static int Main(string[] args)
    {
        // The production watchdog restarts this harness with only --watched.
        if (Array.IndexOf(args, "--watched") >= 0)
        { File.WriteAllText(Environment.GetEnvironmentVariable("SB_RECOVERY_TEST_SENTINEL"), "restarted"); return 0; }
        Configure(args);
        if (args.Length > 3 && args[3] == "--target") { Thread.Sleep(3500); return Int32.Parse(args[4]); }
        if (args.Length > 3 && args[3] == "--guard")
        {
            File.WriteAllText(Path.Combine(Root, "guard-diagnostic"), "target=" + Process.GetProcessById(Int32.Parse(args[4])).MainModule.FileName + "; self=" + System.Windows.Forms.Application.ExecutablePath);
            try {
                int result = (int)Launcher.GetMethod("RunWatchdog", Flags).Invoke(null, new object[] { new string[] { "--watchdog", args[4], "--no-browser" }, 0 });
                File.AppendAllText(Path.Combine(Root, "guard-diagnostic"), "; code=" + result.ToString()); return result;
            } catch (Exception error) { File.AppendAllText(Path.Combine(Root, "guard-diagnostic"), error.ToString()); return 111; }
        }
        if (args.Length > 3 && args[3] == "--job-host")
        {
            object server = Create(p => { Thread.Sleep(60); return !p.HasExited; }); Start(server);
            File.WriteAllText(Path.Combine(Root, "job-child-pid"), Owned(server).Id.ToString());
            Thread.Sleep(Timeout.Infinite); return 1;
        }
        try
        {
            MethodInfo delay = Launcher.GetMethod("RecoveryDelay", Flags);
            foreach (int failure in new int[] { 1, 2, 3, 4, 5, 6, Int32.MaxValue })
                Check((int)delay.Invoke(null, new object[] { failure }) == (failure <= 1 ? 1 : failure >= 6 ? 30 : 1 << (failure - 1)), "Bounded retry delay " + failure.ToString());
            using (Process unrelated = Process.Start(IdleInfo()))
            {
                object server = Create(p => { Thread.Sleep(60); return !p.HasExited; });
                try
                {
                    Check(Start(server) && Ready(server), "Owned service becomes healthy");
                    int original = Owned(server).Id; Owned(server).Kill(); Owned(server).WaitForExit();
                    Check(Eventually(() => { Tick(server); return Ready(server) && Owned(server).Id != original; }, 10), "Crashed service restarts automatically with a new PID");
                    Check(!unrelated.HasExited, "Recovery never terminates unrelated Node processes");
                    Dispose(server); Tick(server);
                    Check(Owned(server) == null && !Ready(server), "Normal shutdown cannot resurrect the service");
                }
                finally { Dispose(server); if (!unrelated.HasExited) unrelated.Kill(); }
            }
            int attempts = 0;
            object flaky = Create(p => { Thread.Sleep(60); return Interlocked.Increment(ref attempts) >= 3 && !p.HasExited; });
            try
            {
                Check(!Start(flaky), "Failed readiness does not report success");
                Check(Eventually(() => { Tick(flaky); return Ready(flaky); }, 15) && attempts == 3, "Failed starts retry with backoff until healthy");
            }
            finally { Dispose(flaky); }
            using (Process host = Child("--job-host"))
            {
                string file = Path.Combine(Root, "job-child-pid");
                Check(Eventually(() => File.Exists(file), 10), "Crash fixture reports only its owned child");
                using (Process child = Process.GetProcessById(Int32.Parse(File.ReadAllText(file))))
                {
                    host.Kill(); host.WaitForExit();
                    Check(child.WaitForExit(5000), "Killing the host releases its service job without orphan Node processes");
                }
            }
            string sentinel = Path.Combine(Root, "watchdog-restarted");
            Environment.SetEnvironmentVariable("SB_RECOVERY_TEST_SENTINEL", sentinel);
            using (Process target = Child("--target 17"))
            using (Process guard = Child("--guard " + target.Id.ToString()))
            { Check(guard.WaitForExit(12000) && guard.ExitCode == 0 && File.Exists(sentinel), "Watchdog restarts an abnormal desktop exit"); }
            File.Delete(sentinel);
            using (Process target = Child("--target 0"))
            using (Process guard = Child("--guard " + target.Id.ToString()))
            { Check(guard.WaitForExit(8000) && guard.ExitCode == 0 && !File.Exists(sentinel), "Watchdog leaves intentional exit stopped"); }
            Console.WriteLine("Native recovery smoke: " + checks.ToString() + " assertions passed."); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
