using System;
using System.Reflection;
internal static class ReaderSmoke
{
    [STAThread] private static int Main(string[] args)
    {
        try {
            Assembly app = Assembly.LoadFrom(args[0]);
            MethodInfo allowed = app.GetType("DesktopNativeReader", true).GetMethod("AllowedAddress", BindingFlags.Static | BindingFlags.NonPublic);
            int count = 0;
            foreach (string url in new [] { "https://example.com/reading", "http://example.org/a?q=1", "https://github.com/login" }) {
                if (!(bool)allowed.Invoke(null, new object[] {url})) throw new Exception("Public page blocked: " + url); count++;
            }
            foreach (string url in new [] { "file:///C:/secret", "javascript:alert(1)", "data:text/html,hello", "https://user:pass@example.com/", "http://127.0.0.1:18794", "http://localhost", "http://10.1.1.1", "http://192.168.0.1", "http://172.16.1.1", "http://169.254.1.1", "http://100.64.1.1", "http://[::1]", "https://site.local", "https://site.internal" }) {
                if ((bool)allowed.Invoke(null, new object[] {url})) throw new Exception("Unsafe page allowed: " + url); count++;
            }
            Console.WriteLine("Native reader address smoke: " + count + " assertions; no user pages or browser authorization accessed."); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
