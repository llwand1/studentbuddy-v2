using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

/** A separate speech balloon keeps the companion's 64px transparency and never opens a quiz by itself. */
internal sealed class DesktopStudyInvite : Form
{
    private readonly Form ball;
    private readonly Func<bool> available;
    private readonly Timer animation;
    private readonly Button challenge, later;
    private readonly float scale;
    private readonly string caption;
    private readonly string[] letters;
    private int frame;
    private bool reduced;
    protected override bool ShowWithoutActivation { get { return true; } }
    internal DesktopStudyInvite(Form companion, string topic, bool reducedMotion, Func<bool> canShow, Action accept, Action snooze, float dpi)
    {
        ball=companion;available=canShow;scale=dpi;reduced=reducedMotion;
        caption=topic+"的小题出好了，快来挑战一下吧！";letters=TextElements(caption);
        Text="StudentBuddy 学习来信";AccessibleName=caption;AccessibleDescription="题目已备好，点击挑战一下开始，两分钟后可延后。";
        ShowInTaskbar=false;TopMost=true;FormBorderStyle=FormBorderStyle.None;StartPosition=FormStartPosition.Manual;AutoScaleMode=AutoScaleMode.None;
        DoubleBuffered=true;BackColor=Color.FromArgb(28,19,32);ForeColor=Color.FromArgb(246,229,193);
        ClientSize=new Size((int)Math.Round(292*scale),(int)Math.Round(166*scale));
        Font=new Font("Microsoft YaHei UI",13*scale,GraphicsUnit.Pixel);
        challenge=MakeButton("挑战一下",20);later=MakeButton("两分钟后",150);
        challenge.Click+=delegate {SetBusy(true);accept();};later.Click+=delegate {SetBusy(true);snooze();};
        Controls.Add(challenge);Controls.Add(later);
        animation=new Timer();animation.Interval=125;animation.Tick+=delegate {frame++;Invalidate();};
        VisibleChanged+=delegate {if(Visible&&!reduced)animation.Start();else animation.Stop();};
    }
    private Button MakeButton(string label,int x)
    {
        Button button=new Button();button.Text=label;button.AccessibleName=label;button.FlatStyle=FlatStyle.Flat;
        button.BackColor=Color.FromArgb(51,34,49);button.ForeColor=ForeColor;button.FlatAppearance.BorderColor=Color.FromArgb(213,178,118);
        button.Bounds=new Rectangle((int)(x*scale),(int)(122*scale),(int)(120*scale),(int)(30*scale));return button;
    }
    internal static string[] TextElements(string text)
    {
        List<string> result=new List<string>();TextElementEnumerator iterator=StringInfo.GetTextElementEnumerator(text);
        while(iterator.MoveNext())result.Add(iterator.GetTextElement());return result.ToArray();
    }
    internal static Rectangle Place(Rectangle anchor,Size size,Rectangle work,int gap)
    {
        int width=Math.Min(size.Width,work.Width),height=Math.Min(size.Height,work.Height);
        int x=Math.Min(Math.Max(anchor.Left+anchor.Width/2-width/2,work.Left),work.Right-width);
        int y=anchor.Bottom+gap;if(y+height>work.Bottom)y=anchor.Top-height-gap;
        y=Math.Min(Math.Max(y,work.Top),work.Bottom-height);return new Rectangle(x,y,width,height);
    }
    internal void RefreshAnchor()
    {
        if(ball.IsDisposed||!available()){if(Visible)Hide();return;}
        Bounds=Place(ball.Bounds,ClientSize,Screen.FromControl(ball).WorkingArea,(int)(8*scale));
        if(!Visible)Show();
    }
    internal void SetReduced(bool value)
    {reduced=value;if(reduced)animation.Stop();else if(Visible)animation.Start();Invalidate();}
    internal void SetBusy(bool value) {challenge.Enabled=!value;later.Enabled=!value;}
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);Graphics g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
        using(Pen border=new Pen(Color.FromArgb(213,178,118),2*scale))g.DrawRectangle(border,scale,scale,ClientSize.Width-2*scale,ClientSize.Height-2*scale);
        using(Brush gold=new SolidBrush(Color.FromArgb(225,188,130)))g.DrawString("✦ 学习来信",Font,gold,18*scale,13*scale);
        int count=reduced?letters.Length:Math.Min(letters.Length,frame*3+1);
        string shown=String.Join("",letters,0,count);
        RectangleF box=new RectangleF(20*scale,43*scale,ClientSize.Width-40*scale,70*scale);
        using(Brush ink=new SolidBrush(ForeColor))g.DrawString(shown,Font,ink,box);
        string[] runes={"✦","◇","ϟ","✧"};
        for(int i=0;i<runes.Length;i++)
        {
            int glow=reduced?210:150+(int)(Math.Sin(frame*.3+i)*55);
            using(Brush spark=new SolidBrush(Color.FromArgb(glow,213,178,118)))g.DrawString(runes[i],Font,spark,(204+i*18)*scale,(14+(reduced?0:(int)(Math.Sin(frame*.25+i)*2)))*scale);
        }
    }
    protected override void Dispose(bool disposing)
    {if(disposing){animation.Stop();animation.Dispose();Font.Dispose();}base.Dispose(disposing);}
}

internal static partial class Launcher
{
    private static DesktopStudyInvite StudyInvite;
    private static string StudyInviteId="";
    private static readonly HashSet<string> ShownInvites=new HashSet<string>();
    private static readonly Queue<string> InviteOrder=new Queue<string>();
    internal static Rectangle StudyInviteBounds() {return StudyInvite!=null&&StudyInvite.Visible?StudyInvite.Bounds:Rectangle.Empty;}
    private static void CloseStudyInvite()
    {if(StudyInvite!=null){StudyInvite.Dispose();StudyInvite=null;}StudyInviteId="";}
    private static void RefreshStudyInvite()
    {if(StudyInvite!=null)StudyInvite.RefreshAnchor();}
    private static void HandleStudyInvite(string payload)
    {
        if(payload=="off"){CloseStudyInvite();return;}
        if(payload=="reset"){if(StudyInvite!=null)StudyInvite.SetBusy(false);return;}
        if(payload.Length>2000||BallWindow==null)return;
        try
        {
            Dictionary<string,object> value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(payload);
            if(value==null||value.Count!=3||!value.ContainsKey("id")||!value.ContainsKey("topic")||!value.ContainsKey("reducedMotion"))return;
            string id=value["id"] as string,topic=value["topic"] as string;
            if(id==null||!Regex.IsMatch(id,"^[a-zA-Z0-9_-]{1,128}$")||topic==null||topic.Length>200||!(value["reducedMotion"] is bool))return;
            foreach(char c in topic)if(Char.IsControl(c))return;
            string[] elements=DesktopStudyInvite.TextElements(topic.Trim());
            if(elements.Length==0)return;topic=String.Join("",elements,0,Math.Min(elements.Length,40));
            bool reduced=(bool)value["reducedMotion"];
            if(StudyInviteId==id&&StudyInvite!=null){StudyInvite.SetReduced(reduced);RefreshStudyInvite();return;}
            CloseStudyInvite();if(ShownInvites.Contains(id))return;
            ShownInvites.Add(id);InviteOrder.Enqueue(id);while(InviteOrder.Count>32)ShownInvites.Remove(InviteOrder.Dequeue());
            StudyInviteId=id;
            StudyInvite=new DesktopStudyInvite(BallWindow,topic,reduced,delegate{return !Exiting&&!BallMoving&&!CaptureRunning&&BallWindow!=null&&BallWindow.Visible&&BallWindow.ClientSize==BallSize()&&!PendingViews.ContainsKey(BallWindow);},
                delegate{RespondToStudyInvite("sb-float:challenge:",id);},delegate{RespondToStudyInvite("sb-float:snooze:",id);},SystemDpiScale());
            RefreshStudyInvite();
        }
        catch { /* Invalid or stale invitations do not interrupt the companion. */ }
    }
    private static void RespondToStudyInvite(string action,string id)
    {
        WebView2 view=BallWebView();
        if(StudyInviteId==id&&view!=null&&view.CoreWebView2!=null)view.CoreWebView2.PostWebMessageAsString(action+id);
    }
}
