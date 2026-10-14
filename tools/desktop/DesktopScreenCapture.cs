using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

internal static class DesktopCaptureEncoding
{
    internal static Bitmap Crop(Bitmap source, Rectangle selected)
    {
        Rectangle actual=Rectangle.Intersect(new Rectangle(Point.Empty,source.Size),selected);
        if(actual.Width<1||actual.Height<1)throw new ArgumentException("截图区域为空");
        return source.Clone(actual,PixelFormat.Format24bppRgb);
    }
    internal static Bitmap Fit(Bitmap source, int maxEdge)
    {
        double ratio=Math.Min(1d,(double)maxEdge/Math.Max(source.Width,source.Height));
        Bitmap result=new Bitmap(Math.Max(1,(int)Math.Round(source.Width*ratio)),Math.Max(1,(int)Math.Round(source.Height*ratio)),PixelFormat.Format24bppRgb);
        using(Graphics g=Graphics.FromImage(result)){g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.DrawImage(source,0,0,result.Width,result.Height);}return result;
    }
    internal static string Encode(Bitmap source, out Size encodedSize)
    {
        using(Bitmap fitted=Fit(source,2400))using(MemoryStream bytes=new MemoryStream())
        {
            encodedSize=fitted.Size;fitted.Save(bytes,ImageFormat.Png);
            string mime="png";
            // Bound the native bridge below the shared 5M-character chat image cap.
            if(bytes.Length>3000000)
            {
                bytes.SetLength(0);mime="jpeg";ImageCodecInfo codec=Array.Find(ImageCodecInfo.GetImageEncoders(),c=>c.MimeType=="image/jpeg");
                using(EncoderParameters options=new EncoderParameters(1)){options.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,80L);fitted.Save(bytes,codec,options);}
            }
            if(bytes.Length>3000000)throw new InvalidOperationException("截图过大，请缩小框选范围。");
            return "data:image/"+mime+";base64,"+Convert.ToBase64String(bytes.ToArray());
        }
    }
}

internal static partial class Launcher
{
    private static bool CaptureRunning;
    private static DesktopCaptureSelector ActiveCapture;
    private static void CaptureDesktop(WebView2 recipient)
    {
        if(CaptureRunning||Exiting||recipient==null||recipient.CoreWebView2==null)return;
        CaptureRunning=true;
        Form target=recipient.FindForm();bool mainVisible=Window!=null&&Window.Visible,ballVisible=BallWindow!=null&&BallWindow.Visible;
        if(QuickMenu!=null)QuickMenu.Hide();if(BallTrail!=null)BallTrail.ClearTrail();
        if(Window!=null)Window.Hide();if(BallWindow!=null)BallWindow.Hide();
        Timer delay=new Timer();delay.Interval=220;
        delay.Tick+=delegate
        {
            delay.Stop();delay.Dispose();string payload=null,error=null;
            try
            {
                if(Exiting)return;
                Rectangle screen=SystemInformation.VirtualScreen;
                if((long)screen.Width*screen.Height>40000000)screen=Screen.FromPoint(Cursor.Position).Bounds;
                using(Bitmap frame=new Bitmap(screen.Width,screen.Height,PixelFormat.Format24bppRgb))
                {
                    using(Graphics g=Graphics.FromImage(frame))g.CopyFromScreen(screen.Location,Point.Empty,screen.Size,CopyPixelOperation.SourceCopy);
                    using(DesktopCaptureSelector selector=new DesktopCaptureSelector(frame,screen))
                    {
                        ActiveCapture=selector;
                        if(selector.ShowDialog()==DialogResult.OK&&!Exiting)
                        {
                            using(Bitmap chosen=DesktopCaptureEncoding.Crop(frame,selector.Selection))
                            {
                                Size encoded;string data=DesktopCaptureEncoding.Encode(chosen,out encoded);
                                JavaScriptSerializer json=new JavaScriptSerializer();json.MaxJsonLength=6000000;
                                payload=json.Serialize(new {id=Guid.NewGuid().ToString("N"),dataUrl=data,name="截图-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+(data.StartsWith("data:image/png")?".png":".jpg"),width=encoded.Width,height=encoded.Height});
                            }
                        }
                    }
                }
            }
            catch(Exception ex){error="截图没有完成："+ex.Message;Log("本机截图失败："+ex.GetType().Name);}
            finally
            {
                ActiveCapture=null;CaptureRunning=false;
                if(!Exiting)
                {
                    if(mainVisible&&Window!=null&&!Window.IsDisposed)Window.Show();
                    if(ballVisible&&BallWindow!=null&&!BallWindow.IsDisposed)BallWindow.Show();
                    WebView2 view=target==BallWindow?BallWebView():ViewOf(target);
                    if(view!=null&&view.CoreWebView2!=null)
                    {
                        if(payload!=null)
                        {
                            if(target==BallWindow){BallDisplayMode="screen";SetBallExpanded(true);BallWindow.Show();}
                            view.CoreWebView2.PostWebMessageAsString("sb-desktop:capture-result:"+payload);
                            if(target!=null&&!target.IsDisposed)target.Activate();
                        }
                        else if(error!=null)view.CoreWebView2.PostWebMessageAsString("sb-desktop:capture-error:"+error);
                    }
                }
            }
        };
        delay.Start();
    }
    private static WebView2 ViewOf(Form form)
    {
        if(form==null||form.IsDisposed)return null;
        foreach(Control control in form.Controls){WebView2 view=control as WebView2;if(view!=null)return view;}return null;
    }
}
