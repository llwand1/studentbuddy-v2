using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class StudyInviteSmoke
{
    private static int checks;
    private static void Check(bool ok,string message){if(!ok)throw new Exception(message);checks++;Console.WriteLine("PASS "+message);}
    [STAThread] private static int Main(string[] args)
    {
        try
        {
            Assembly assembly=Assembly.LoadFrom(args[0]);Type type=assembly.GetType("DesktopStudyInvite",true);
            BindingFlags statics=BindingFlags.Static|BindingFlags.NonPublic,instances=BindingFlags.Instance|BindingFlags.NonPublic;
            MethodInfo place=type.GetMethod("Place",statics),elements=type.GetMethod("TextElements",statics);
            foreach(float scale in new[]{1f,1.25f,1.5f,2f})foreach(Rectangle work in new[]{new Rectangle(0,0,1920,1080),new Rectangle(-1920,-100,1920,1080)})
            {
                Size size=new Size((int)(292*scale),(int)(166*scale));
                foreach(Point point in new[]{work.Location,new Point(work.Right-64,work.Bottom-64),new Point(work.Left+600,work.Top+300)})
                {
                    Rectangle result=(Rectangle)place.Invoke(null,new object[]{new Rectangle(point,new Size(64,64)),size,work,8});
                    Check(work.Contains(result),"Speech balloon stays within work area at DPI "+scale);
                }
            }
            string[] unicode=(string[])elements.Invoke(null,new object[]{"题🪄e\u0301"});
            Check(unicode.Length==3&&unicode[1]=="🪄"&&unicode[2]=="e\u0301","Typewriter keeps emoji and combining marks intact");
            using(Form ball=new Form())
            {
                ConstructorInfo constructor=type.GetConstructors(instances)[0];
                using(Form invite=(Form)constructor.Invoke(new object[]{ball,"JavaScript 闭包",false,new Func<bool>(()=>false),new Action(()=>{}),new Action(()=>{}),1f}))
                {
                    Check((bool)type.GetProperty("ShowWithoutActivation",instances).GetValue(invite,null),"Invitation does not activate on show");
                    Check(invite.AccessibleName.Contains("快来挑战"),"Complete invitation is available to accessibility tools");
                    Check(invite.Controls.Count==2&&invite.Controls[0].AccessibleName=="挑战一下","Explicit challenge and snooze buttons are present");
                    Check(!invite.Visible,"Constructing an invitation never opens the quiz or a visible window");
                    type.GetMethod("SetReduced",instances).Invoke(invite,new object[]{true});
                    Check((bool)type.GetField("reduced",instances).GetValue(invite),"Reduced motion uses complete static text");
                    if(args.Length>1)
                    {
                        Directory.CreateDirectory(args[1]);type.GetMethod("SetReduced",instances).Invoke(invite,new object[]{false});
                        invite.Location=new Point(-32000,-32000);invite.Show();Application.DoEvents();
                        for(int frame=0;frame<24;frame++)
                        {
                            type.GetField("frame",instances).SetValue(invite,frame);
                            using(Bitmap bitmap=new Bitmap(invite.Width,invite.Height)){invite.DrawToBitmap(bitmap,new Rectangle(Point.Empty,invite.Size));bitmap.Save(Path.Combine(args[1],"invite-"+frame.ToString("00")+".png"),ImageFormat.Png);}
                        }
                    }
                }
            }
            Console.WriteLine("Native invitation assertions: "+checks);return 0;
        }
        catch(Exception error){Console.Error.WriteLine(error.ToString());return 1;}
    }
}
