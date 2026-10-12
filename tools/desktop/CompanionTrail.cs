using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

/** Pure world-coordinate trail: bounded history, interpolated movement and timed evaporation. */
internal sealed class CompanionTrailState
{
    internal const int LifeMs = 900;
    internal const int MaxStamps = 48;
    private sealed class Stamp { internal Point Center; internal double Time; internal int Seed; }
    private readonly List<Stamp> stamps = new List<Stamp>();
    private int seed;
    internal int Count { get { return stamps.Count; } }
    internal void Clear() { stamps.Clear(); }
    internal void Add(Point center, double now, float scale)
    {
        Prune(now);
        if (stamps.Count > 0)
        {
            Point previous = stamps[stamps.Count - 1].Center;
            double dx = (double)center.X - previous.X, dy = (double)center.Y - previous.Y;
            double distance = Math.Sqrt(dx * dx + dy * dy);
            if (distance < 2 * scale) return;
            if (distance > 280 * scale) stamps.Clear();
            else
            {
                int steps = Math.Min(12, Math.Max(1, (int)Math.Ceiling(distance / (7 * scale))));
                for (int i = 1; i < steps; i++)
                    Append(new Point((int)Math.Round(previous.X + dx * i / steps), (int)Math.Round(previous.Y + dy * i / steps)), now);
            }
        }
        Append(center, now);
        stamps.RemoveAll(delegate(Stamp s) { return Math.Abs((double)s.Center.X - center.X) > 280 * scale || Math.Abs((double)s.Center.Y - center.Y) > 280 * scale; });
    }
    private void Append(Point center, double now)
    {
        stamps.Add(new Stamp { Center = center, Time = now, Seed = seed++ });
        if (stamps.Count > MaxStamps) stamps.RemoveAt(0);
    }
    private void Prune(double now) { stamps.RemoveAll(delegate(Stamp s) { return now - s.Time >= LifeMs; }); }
    internal List<CompanionTrailPixel> Frame(double now, float scale)
    {
        Prune(now);
        List<CompanionTrailPixel> frame = new List<CompanionTrailPixel>();
        foreach (Stamp stamp in stamps)
        {
            double age = Math.Max(0, Math.Min(1, (now - stamp.Time) / LifeMs));
            int drift = (int)Math.Round(age * 18 * scale);
            int flicker = (int)Math.Round(Math.Sin(now / 65 + stamp.Seed * 1.9) * 2 * scale);
            int x = stamp.Center.X + flicker, y = stamp.Center.Y - drift;
            int width = Math.Max(1, (int)Math.Round((3 - age * 1.5) * scale));
            int height = Math.Max(2, (int)Math.Round((5 - age * 2) * scale));
            int unit = Math.Max(1, (int)Math.Round(scale));
            AddPixel(frame, x - unit, y - unit, width + 2 * unit, height + 2 * unit, Fade(84, 36, 45, age));
            AddPixel(frame, x, y, width, height, Fade(237, 121, 80, age));
            AddPixel(frame, x + width / 2, y - height / 2, unit, height, Fade(255, 173, 82, age));
            if (stamp.Seed % 3 == 0)
            {
                int side = (int)Math.Round(Math.Sin(stamp.Seed * 2.3) * (5 + age * 6) * scale);
                AddPixel(frame, x + side, y - height * 2, unit, unit, Fade(255, 224, 163, age));
            }
        }
        if (stamps.Count > 0)
        {
            Point newest = stamps[stamps.Count - 1].Center;
            Rectangle body = new Rectangle(newest.X - (int)Math.Ceiling(18 * scale), newest.Y - (int)Math.Ceiling(20 * scale),
                (int)Math.Ceiling(36 * scale), (int)Math.Ceiling(40 * scale));
            frame.RemoveAll(delegate(CompanionTrailPixel pixel) { return pixel.Bounds.IntersectsWith(body); });
        }
        return frame;
    }
    private static Color Fade(int r, int g, int b, double age)
    {
        double strength = 1 - age * .8;
        return Color.FromArgb((int)(r * strength), (int)(g * strength), (int)(b * strength));
    }
    private static void AddPixel(List<CompanionTrailPixel> frame, int x, int y, int w, int h, Color color)
    {
        frame.Add(new CompanionTrailPixel { Bounds = new Rectangle(x, y, w, h), Color = color });
    }
}

internal sealed class CompanionTrailPixel { internal Rectangle Bounds; internal Color Color; }

/** No WebView or input surface: the layered overlay is click-through and never activates. */
internal sealed class CompanionTrail : Form
{
    internal const int PassThroughStyles = 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080;
    private readonly CompanionTrailState history = new CompanionTrailState();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly Timer timer = new Timer();
    private readonly float scale;
    private List<CompanionTrailPixel> pixels = new List<CompanionTrailPixel>();
    internal CompanionTrail(float dpiScale)
    {
        scale = dpiScale;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        TopMost = true;
        BackColor = TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
        timer.Interval = 33;
        timer.Tick += delegate { RefreshTrail(); };
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { CreateParams value = base.CreateParams; value.ExStyle |= PassThroughStyles; return value; }
    }
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0084) { message.Result = (IntPtr)(-1); return; }
        base.WndProc(ref message);
    }
    internal void Follow(Point center)
    {
        history.Add(center, clock.Elapsed.TotalMilliseconds, scale);
        RefreshTrail();
        if (!timer.Enabled) timer.Start();
    }
    internal void ClearTrail()
    {
        timer.Stop(); history.Clear(); pixels.Clear(); Hide();
    }
    private void RefreshTrail()
    {
        pixels = history.Frame(clock.Elapsed.TotalMilliseconds, scale);
        if (pixels.Count == 0) { if (history.Count == 0) timer.Stop(); Hide(); return; }
        Rectangle bounds = pixels[0].Bounds;
        foreach (CompanionTrailPixel pixel in pixels) bounds = Rectangle.Union(bounds, pixel.Bounds);
        bounds.Inflate(2, 2);
        Bounds = bounds;
        if (!Visible) Show();
        Invalidate();
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        foreach (CompanionTrailPixel pixel in pixels)
        {
            Rectangle rect = pixel.Bounds; rect.Offset(-Left, -Top);
            using (SolidBrush brush = new SolidBrush(pixel.Color)) e.Graphics.FillRectangle(brush, rect);
        }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { timer.Stop(); timer.Dispose(); history.Clear(); }
        base.Dispose(disposing);
    }
}
