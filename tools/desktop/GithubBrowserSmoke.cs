using System;
internal static class GithubBrowserSmoke
{
    private static int Main()
    {
        string good = "https://github.com/login/oauth/authorize?client_id=fixture&state=0123456789abcdef&code_challenge="+new string('a',43)+"&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback";
        int count = 0;
        foreach (string url in new [] { good, good.Replace("localhost", "127.0.0.1") }) { if (!GithubBrowserLauncher.Allowed(url)) throw new Exception("Valid fixed GitHub PKCE address refused"); count++; }
        foreach (string url in new [] { "file:///C:/private.txt", "https://github.com/login/device", good.Replace("github.com/", "github.com.evil.invalid/"),good.Replace("https://", "http://"),good.Replace("S256", "plain"),good+"#fragment",good.Replace("localhost", "evil.invalid"),good.Replace("%2Fcallback", "%2Fother"),good.Replace("github.com/", "user@github.com/") }) {
            if (GithubBrowserLauncher.Allowed(url)) throw new Exception("Unsafe address accepted"); count++;
        }
        if (GithubBrowserLauncher.Executable("powershell") != null) throw new Exception("Arbitrary command accepted"); count++;
        Console.WriteLine("GitHub chosen-browser adapter: "+count+" native validation checks passed (no login, no browser launched)."); return 0;
    }
}
