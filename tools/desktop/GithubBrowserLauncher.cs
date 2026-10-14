using System;
using System.Diagnostics;
using System.IO;

// A process-local adapter for the pinned official MCP binary, not an OS handler.
internal static class GithubBrowserLauncher
{
    internal static bool Allowed(string value)
    {
        Uri url;
        if (value == null || value.Length > 8192 || !Uri.TryCreate(value, UriKind.Absolute, out url)) return false;
        if (url.Scheme != "https" || url.Host != "github.com" || url.Port != 443 || url.UserInfo.Length != 0 || url.Fragment.Length != 0 || url.AbsolutePath != "/login/oauth/authorize") return false;
        var query = System.Web.HttpUtility.ParseQueryString(url.Query);
        Uri redirect;
        return query["state"] != null && query["state"].Length >= 16 && query["client_id"] != null &&
            query["code_challenge_method"] == "S256" && query["code_challenge"] != null && query["code_challenge"].Length >= 40 &&
            Uri.TryCreate(query["redirect_uri"], UriKind.Absolute, out redirect) && redirect.Scheme == "http" &&
            (redirect.Host == "localhost" || redirect.Host == "127.0.0.1") && redirect.Port > 0 && redirect.UserInfo.Length == 0 &&
            redirect.AbsolutePath == "/callback" && redirect.Query.Length == 0 && redirect.Fragment.Length == 0;
    }
    internal static string Executable(string browser)
    {
        if (browser != "chrome" && browser != "edge") return null;
        string suffix = browser == "chrome" ? @"Google\Chrome\Application\chrome.exe" : @"Microsoft\Edge\Application\msedge.exe";
        foreach (var folder in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData }) {
            string file = Path.Combine(Environment.GetFolderPath(folder), suffix);
            if (File.Exists(file)) return file;
        }
        return null;
    }
    [STAThread]
    private static int Main(string[] args)
    {
        try {
            if (args.Length != 2 || args[0] != "url.dll,FileProtocolHandler" || !Allowed(args[1])) return 2;
            string executable = Executable(Environment.GetEnvironmentVariable("SB_GITHUB_BROWSER"));
            if (executable == null) return 3;
            Process.Start(new ProcessStartInfo(executable, "\"" + args[1].Replace("\"", "%22") + "\"") { UseShellExecute = false });
            return 0;
        } catch { return 4; }
    }
}
