using System;
using System.Drawing;
using System.Windows.Forms;

/** Snapshot selection is entirely local. Escape never returns image bytes to a WebView. */
internal sealed class DesktopCaptureSelector : Form
{
    private readonly Bitmap snapshot;
    private Point start;
    private bool selecting;
    internal Rectangle Selection { get; private set; }
    internal DesktopCaptureSelector(Bitmap image, Rectangle screen)
    {
        snapshot = image; Text = "StudentBuddy 截图框选"; AccessibleDescription = "拖动框选区域，Enter 整屏，Escape 取消";
        FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.Manual; AutoScaleMode = AutoScaleMode.None;
        ShowInTaskbar = false; TopMost = true; KeyPreview = true; Bounds = screen; Cursor = Cursors.Cross;
        DoubleBuffered = true; BackColor = Color.Black;
    }
    internal static Rectangle Normalize(Point a, Point b, Size size)
    {
        int x1=Math.Min(size.Width,Math.Max(0,a.X)), x2=Math.Min(size.Width,Math.Max(0,b.X));
        int y1=Math.Min(size.Height,Math.Max(0,a.Y)), y2=Math.Min(size.Height,Math.Max(0,b.Y));
        return Rectangle.FromLTRB(Math.Min(x1,x2),Math.Min(y1,y2),Math.Max(x1,x2),Math.Max(y1,y2));
    }
    protected override void OnMouseDown(MouseEventArgs e)
    { base.OnMouseDown(e); if(e.Button!=MouseButtons.Left)return; start=e.Location; selecting=true; Capture=true; Selection=Rectangle.Empty; }
    protected override void OnMouseMove(MouseEventArgs e)
    { base.OnMouseMove(e); if(!selecting)return; Selection=Normalize(start,e.Location,snapshot.Size); Invalidate(); }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e); if(!selecting||e.Button!=MouseButtons.Left)return;
        selecting=false; Capture=false; Selection=Normalize(start,e.Location,snapshot.Size);
        if(Selection.Width>=6&&Selection.Height>=6) { DialogResult=DialogResult.OK; Close(); } else Invalidate();
    }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if(e.KeyCode==Keys.Escape){e.Handled=true;DialogResult=DialogResult.Cancel;Close();}
        if(e.KeyCode==Keys.Enter){e.Handled=true;if(Selection.Width<6||Selection.Height<6)Selection=new Rectangle(Point.Empty,snapshot.Size);DialogResult=DialogResult.OK;Close();}
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.DrawImageUnscaled(snapshot,0,0);
        using(Brush shade=new SolidBrush(Color.FromArgb(145,0,0,0)))e.Graphics.FillRectangle(shade,ClientRectangle);
        if(Selection.Width>0&&Selection.Height>0)
        {
            e.Graphics.DrawImage(snapshot,Selection,Selection,GraphicsUnit.Pixel);
            using(Pen edge=new Pen(Color.FromArgb(235,194,100),2))e.Graphics.DrawRectangle(edge,Selection);
        }
        string hint="拖动框选 · 松开预览 · Enter 整屏 · Esc 取消（尚未发送给 AI）";
        Point origin=PointToClient(new Point(Screen.FromPoint(Cursor.Position).Bounds.Left+20,Screen.FromPoint(Cursor.Position).Bounds.Top+20));
        using(Brush background=new SolidBrush(Color.FromArgb(230,24,15,24)))e.Graphics.FillRectangle(background,origin.X,origin.Y,600,40);
        TextRenderer.DrawText(e.Graphics,hint,Font,new Point(origin.X+10,origin.Y+11),Color.White);
    }
}
