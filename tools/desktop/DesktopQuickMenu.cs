using System;
using System.Drawing;
using System.Windows.Forms;

/** Separate non-activating strip: the 64px companion and its transparent clip never resize. */
internal sealed class DesktopQuickMenu : Form
{
    private readonly Form ball;
    private readonly Func<bool> available;
    private readonly Timer clock;
    private DateTime leftAt = DateTime.MinValue;
    protected override bool ShowWithoutActivation { get { return true; } }
    internal DesktopQuickMenu(Form companion, Func<bool> canShow, Action input, Action capture, float scale)
    {
        ball = companion; available = canShow;
        Text = "StudentBuddy 快速提问"; ShowInTaskbar = false; TopMost = true;
        FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.Manual; AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.FromArgb(21, 13, 21); ClientSize = new Size((int)Math.Round(218*scale), (int)Math.Round(38*scale));
        Font = new Font("Microsoft YaHei", 9f);
        Button ask = MakeButton("输入提问", 0, scale), shot = MakeButton("截图提问", 1, scale);
        ask.Click += delegate { Hide(); input(); }; shot.Click += delegate { Hide(); capture(); };
        Controls.Add(ask); Controls.Add(shot);
        clock = new Timer(); clock.Interval = 100; clock.Tick += delegate { TickMenu(); }; clock.Start();
    }
    private static Button MakeButton(string label, int index, float scale)
    {
        Button button = new Button(); button.Text = label; button.AccessibleName = label;
        button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderColor = Color.FromArgb(125,92,39);
        button.BackColor = Color.FromArgb(33,21,31); button.ForeColor = Color.FromArgb(231,212,167);
        button.Bounds = new Rectangle((int)Math.Round((4+106*index)*scale), (int)Math.Round(4*scale), (int)Math.Round(104*scale), (int)Math.Round(30*scale));
        return button;
    }
    internal static Rectangle Place(Rectangle anchor, Size menu, Rectangle work, int gap)
    {
        int x = Math.Min(Math.Max(anchor.Right-menu.Width,work.Left),Math.Max(work.Left,work.Right-menu.Width));
        int y = anchor.Top-menu.Height-gap;
        if (y < work.Top) y = anchor.Bottom+gap;
        y = Math.Min(Math.Max(y,work.Top),Math.Max(work.Top,work.Bottom-menu.Height));
        return new Rectangle(x,y,Math.Min(menu.Width,work.Width),Math.Min(menu.Height,work.Height));
    }
    private void TickMenu()
    {
        if (ball.IsDisposed || !available()) { Hide(); leftAt = DateTime.MinValue; return; }
        Point mouse = Cursor.Position;
        if (ball.Bounds.Contains(mouse))
        {
            Bounds = Place(ball.Bounds,ClientSize,Screen.FromControl(ball).WorkingArea,4);
            leftAt = DateTime.MinValue; if (!Visible) Show(); return;
        }
        Rectangle safe = Bounds; safe.Inflate(6,8);
        if (Visible && safe.Contains(mouse)) { leftAt = DateTime.MinValue; return; }
        if (leftAt == DateTime.MinValue) leftAt = DateTime.UtcNow;
        if (DateTime.UtcNow-leftAt > TimeSpan.FromMilliseconds(350)) Hide();
    }
    protected override void Dispose(bool disposing)
    { if (disposing) { clock.Stop(); clock.Dispose(); } base.Dispose(disposing); }
}

internal static partial class Launcher
{
    private static DesktopQuickMenu QuickMenu;
    private static bool BallMoving;
    private static void StartQuickMenu()
    {
        if (BallWindow == null) return;
        QuickMenu = new DesktopQuickMenu(BallWindow, delegate { return !Exiting && !BallMoving && !CaptureRunning && BallWindow.Visible && BallWindow.ClientSize == BallSize() && !PendingViews.ContainsKey(BallWindow); },
            OpenQuickInput, delegate { CaptureDesktop(BallWebView()); }, SystemDpiScale());
    }
    private static void OpenQuickInput()
    {
        var view = BallWebView();
        if (view == null || view.CoreWebView2 == null) return;
        BallDisplayMode = "screen"; SetBallExpanded(true); BallWindow.Show();
        view.CoreWebView2.PostWebMessageAsString("sb-float:quick-input");
        BallWindow.Activate();
    }
    private static void CloseDesktopHelpers()
    {
        if (QuickMenu != null) { QuickMenu.Dispose(); QuickMenu = null; }
        if (ActiveCapture != null) { ActiveCapture.Close(); ActiveCapture = null; }
    }
}
