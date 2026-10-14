using System;
using System.Drawing;
using System.Reflection;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Drawing.Imaging;

internal static class DesktopInputSmoke
{
    private static int checks;
    private static void Check(bool ok,string message){if(!ok)throw new Exception(message);checks++;Console.WriteLine("PASS "+message);}
    [STAThread] private static int Main(string[] args)
    {
        try
        {
            Assembly asm=Assembly.LoadFrom(args[0]); BindingFlags flags=BindingFlags.Static|BindingFlags.NonPublic;
            Type menu=asm.GetType("DesktopQuickMenu",true),selector=asm.GetType("DesktopCaptureSelector",true),encoding=asm.GetType("DesktopCaptureEncoding",true);
            MethodInfo place=menu.GetMethod("Place",flags),normalize=selector.GetMethod("Normalize",flags),crop=encoding.GetMethod("Crop",flags),fit=encoding.GetMethod("Fit",flags),encode=encoding.GetMethod("Encode",flags);
            Rectangle work=new Rectangle(-1920,0,1920,1080);Size size=new Size(218,38);
            foreach(Rectangle anchor in new[]{new Rectangle(-1920,0,64,64),new Rectangle(-64,1016,64,64),new Rectangle(-900,500,64,64)})
            {
                Rectangle r=(Rectangle)place.Invoke(null,new object[]{anchor,size,work,4});Check(work.Contains(r),"Hover menu stays within a negative-coordinate monitor");
            }
            Rectangle top=(Rectangle)place.Invoke(null,new object[]{new Rectangle(0,0,64,64),size,new Rectangle(0,0,800,600),4});Check(top.Y==68,"Menu falls below a top-edge companion");
            Rectangle rect=(Rectangle)normalize.Invoke(null,new object[]{new Point(80,70),new Point(10,20),new Size(100,100)});Check(rect==new Rectangle(10,20,70,50),"Reverse-direction capture normalizes correctly");
            rect=(Rectangle)normalize.Invoke(null,new object[]{new Point(-30,-20),new Point(130,120),new Size(100,80)});Check(rect==new Rectangle(0,0,100,80),"Out-of-bounds selection is clamped to snapshot");
            using(Bitmap image=new Bitmap(100,80))
            {
                using(Graphics g=Graphics.FromImage(image)){g.Clear(Color.White);g.FillRectangle(Brushes.Red,10,20,40,30);}
                using(Bitmap selected=(Bitmap)crop.Invoke(null,new object[]{image,new Rectangle(10,20,40,30)}))
                {
                    Check(selected.Size==new Size(40,30),"Only the selected region is returned");Check(selected.GetPixel(5,5).R>230&&selected.GetPixel(5,5).G<30,"Crop pixels correspond to selected origin");
                    object[] call=new object[]{selected,new Size()};string data=(string)encode.Invoke(null,call);Check(data.StartsWith("data:image/png;base64,"),"Text-like screenshots preserve PNG");
                    Check(data.Length<5000000,"Native data URL fits shared chat limit");Check((Size)call[1]==selected.Size,"Small captures are never upscaled");
                }
                try{crop.Invoke(null,new object[]{image,new Rectangle(150,150,20,20)});throw new Exception("Empty crop accepted");}catch(TargetInvocationException e){Check(e.InnerException is ArgumentException,"Empty crops fail before transmission");}
                using(Bitmap fitted=(Bitmap)fit.Invoke(null,new object[]{image,40}))Check(fitted.Size==new Size(40,32),"Fitting preserves aspect ratio");
                using(Form dialog=(Form)Activator.CreateInstance(selector,BindingFlags.Instance|BindingFlags.NonPublic,null,new object[]{image,new Rectangle(-100,0,100,80)},null))
                {
                    Check(dialog.Text=="StudentBuddy 截图框选","Capture selector has an identifiable native title");
                    selector.GetMethod("OnKeyDown",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(dialog,new object[]{new KeyEventArgs(Keys.Escape)});
                    Check(dialog.DialogResult==DialogResult.Cancel,"Escape cancels without selecting pixels");
                }
                using(Form dialog=(Form)Activator.CreateInstance(selector,BindingFlags.Instance|BindingFlags.NonPublic,null,new object[]{image,new Rectangle(0,0,100,80)},null))
                {
                    selector.GetMethod("OnKeyDown",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(dialog,new object[]{new KeyEventArgs(Keys.Enter)});
                    Check(dialog.DialogResult==DialogResult.OK,"Enter explicitly selects full snapshot");Check((Rectangle)selector.GetProperty("Selection",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(dialog,null)==new Rectangle(0,0,100,80),"Full capture uses snapshot coordinates");
                }
            }
            using(Bitmap noise=new Bitmap(2400,1600,PixelFormat.Format24bppRgb))
            {
                BitmapData pixels=noise.LockBits(new Rectangle(Point.Empty,noise.Size),ImageLockMode.WriteOnly,PixelFormat.Format24bppRgb);byte[] bytes=new byte[pixels.Stride*noise.Height];new Random(7).NextBytes(bytes);Marshal.Copy(bytes,0,pixels.Scan0,bytes.Length);noise.UnlockBits(pixels);
                object[] call=new object[]{noise,new Size()};string data=(string)encode.Invoke(null,call);Check(data.StartsWith("data:image/jpeg;base64,"),"Noisy large captures use bounded JPEG fallback");Check(data.Length<5000000,"JPEG fallback remains below input cap");
                using(MemoryStream stream=new MemoryStream(Convert.FromBase64String(data.Substring(data.IndexOf(',')+1))))using(Image decoded=Image.FromStream(stream))Check(decoded.Size==(Size)call[1],"Fallback payload is a valid decodable image");
            }
            using(Form ball=new Form())using(Form strip=(Form)Activator.CreateInstance(menu,BindingFlags.Instance|BindingFlags.NonPublic,null,new object[]{ball,new Func<bool>(()=>false),new Action(()=>{}),new Action(()=>{}),1f},null))
            {Check(strip.Controls.Count==2,"Hover strip contains exactly input and screenshot actions");Check(!strip.ShowInTaskbar&&strip.TopMost,"Hover strip avoids an extra taskbar item");}
            Console.WriteLine("Native desktop input smoke: "+checks+" assertions passed; synthetic pixels only, no screens or personal files read.");return 0;
        }
        catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
