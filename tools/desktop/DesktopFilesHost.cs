using System;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.WinForms;
internal static partial class Launcher
{
    private static void HandleDesktopMessage(WebView2 view, string message)
    {
        if (message != null && message.StartsWith("sb-desktop:reader:", StringComparison.Ordinal)) { OpenNativeReader(message); return; }
        if (message == "sb-desktop:extension") OpenExtensionFolder();
        else if (message == "sb-desktop:choose-workspace") ChooseDesktopWorkspace(view);
        else if (message == "sb-desktop:capture") CaptureDesktop(view);
    }
    private static void ChooseDesktopWorkspace(WebView2 view)
    {
        if (view == null || view.CoreWebView2 == null) return;
        string selected = null;
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "选择独立工作区：StudentBuddy 可在此文件夹内读写文件，电脑其他位置保持只读。";
            dialog.ShowNewFolderButton = true;
            if (dialog.ShowDialog(view.FindForm()) == DialogResult.OK) selected = dialog.SelectedPath;
        }
        if (!Exiting && !view.IsDisposed && view.CoreWebView2 != null)
            view.CoreWebView2.PostWebMessageAsString("sb-desktop:workspace-selected:" + new JavaScriptSerializer().Serialize(selected));
    }
}
