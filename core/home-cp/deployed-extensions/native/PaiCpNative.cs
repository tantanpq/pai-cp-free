// PAI CP owned-fixture backend R1. One request, one exact HWND; no window discovery,
// focus restoration, background daemon, security-desktop access, shell, or retry.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class PaiCpNative {
    const int ProjectionLimit = 500, TreeLimit = 10000;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 24000000, RecursionLimit = 100 };
    static bool attempted = false;
    class CpError : Exception { public string Code; public CpError(string c, string m) : base(m) { Code = c; } }
    static void Fail(string c, string m) { throw new CpError(c,m); }
    static Dictionary<string,object> Obj(object x) { var d=x as Dictionary<string,object>; if(d==null) Fail("INVALID_REQUEST","Object required"); return d; }
    static string S(Dictionary<string,object> d,string k) { object x; if(!d.TryGetValue(k,out x)||!(x is string)) Fail("INVALID_REQUEST","String required: "+k); return (string)x; }
    static bool B(Dictionary<string,object> d,string k) { object x; if(!d.TryGetValue(k,out x)||!(x is bool)) Fail("INVALID_REQUEST","Boolean required: "+k); return (bool)x; }
    static int I(Dictionary<string,object> d,string k) { object x; if(!d.TryGetValue(k,out x)||!(x is int)) Fail("INVALID_REQUEST","Integer required: "+k); return (int)x; }
    static void Keys(Dictionary<string,object> d,params string[] allowed) { var a=new HashSet<string>(allowed,StringComparer.Ordinal); foreach(var k in d.Keys) if(!a.Contains(k)) Fail("INVALID_REQUEST","Unknown field: "+k); }
    static object[] Arr(object x) { var a=x as object[]; if(a!=null) return a; var l=x as ArrayList; if(l!=null) return l.ToArray(); Fail("INVALID_REQUEST","Array required"); return null; }
    static double N(object x) { if(!(x is int)&&!(x is long)&&!(x is decimal)&&!(x is double)) Fail("INVALID_REQUEST","Finite number required"); double n=Convert.ToDouble(x,CultureInfo.InvariantCulture); if(Double.IsNaN(n)||Double.IsInfinity(n)) Fail("INVALID_REQUEST","Finite number required"); return n; }
    static bool Same(object a,object b) { return Json.Serialize(a)==Json.Serialize(b); }
    static string CanonicalPath(string p) { return Path.GetFullPath(p).TrimEnd('\\'); }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; public POINT(int x,int y) { X=x;Y=y; } }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct MONITORINFOEX { public int Size; public RECT Monitor,Work; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Device; }
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint Size,Tick; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int X,Y;public uint MouseData,Flags,Time;public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort Vk,Scan;public uint Flags,Time;public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT Mouse; [FieldOffset(0)] public KEYBDINPUT Key; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint Type; public INPUTUNION Data; }
    delegate bool EnumProc(IntPtr hwnd,IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetLastActivePopup(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h,ref MONITORINFOEX info);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder value,int len,out int needed);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int attr,out int value,int size);
    [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetWindowFrameBounds(IntPtr h,int attr,out RECT value,int size);
    [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);

    static string DesktopName(IntPtr h) { if(h==IntPtr.Zero) return ""; int n; var s=new StringBuilder(512); if(!GetUserObjectInformation(h,2,s,1024,out n)) return "";return s.ToString(); }
    static bool IsDefaultInput() {
        IntPtr h=OpenInputDesktop(0,false,1); if(h==IntPtr.Zero) return false;
        try { return DesktopName(h)=="Default" && DesktopName(GetThreadDesktop(GetCurrentThreadId()))=="Default"; }
        finally { CloseDesktop(h); }
    }
    static uint InputTick() { var x=new LASTINPUTINFO {Size=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO))}; if(!GetLastInputInfo(ref x)) Fail("BLOCKED_SESSION","Input epoch unavailable");return x.Tick; }
    static bool SessionActive(int session) {
        IntPtr buffer=IntPtr.Zero;int bytes;
        try { return WTSQuerySessionInformation(IntPtr.Zero,session,8,out buffer,out bytes)&&buffer!=IntPtr.Zero&&bytes>=4&&Marshal.ReadInt32(buffer)==0; }
        finally { if(buffer!=IntPtr.Zero) WTSFreeMemory(buffer); }
    }
    static void NoHeldKeys() { foreach(int k in new int[]{1,2,4,5,6,16,17,18,91,92}) if((GetAsyncKeyState(k)&0x8000)!=0) Fail("USER_TAKEOVER","Mouse button/modifier held"); }
    static RECT Rect(IntPtr h) { RECT r; if(!GetWindowRect(h,out r)||r.Right<=r.Left||r.Bottom<=r.Top) Fail("BLOCKED_SESSION","Window rectangle unavailable");return r; }
    static RECT VisibleFrame(IntPtr h) {
        // GetWindowRect includes invisible DWM resize margins. CopyFromScreen of that
        // rectangle leaks neighboring desktop pixels. DWM extended frame bounds are
        // authoritative physical pixels (not DPI-virtualized); unknown geometry blocks.
        RECT full=Rect(h),frame;
        if(DwmGetWindowFrameBounds(h,9,out frame,Marshal.SizeOf(typeof(RECT)))!=0||frame.Right<=frame.Left||frame.Bottom<=frame.Top||frame.Left<full.Left||frame.Top<full.Top||frame.Right>full.Right||frame.Bottom>full.Bottom) Fail("BLOCKED_SESSION","Authoritative visible DWM frame unavailable/inconsistent");
        return frame;
    }
    static object[] R(RECT r) { return new object[]{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top}; }
    static bool Intersects(RECT a,RECT b) { return a.Left<b.Right && a.Right>b.Left && a.Top<b.Bottom && a.Bottom>b.Top; }
    static bool Cloaked(IntPtr h) { int v; int hr=DwmGetWindowAttribute(h,14,out v,4); return hr!=0||v!=0; }
    static bool Occluded(IntPtr target,RECT r) {
        bool hit=false,found=false;
        bool ok=EnumWindows(delegate(IntPtr h,IntPtr unused) {
            if(h==target) { found=true;return false; }
            if(!IsWindowVisible(h)||IsIconic(h)) return true;
            int cloak; if(DwmGetWindowAttribute(h,14,out cloak,4)!=0) { hit=true;return false; }
            if(cloak!=0) return true;
            RECT other;if(!GetWindowRect(h,out other)) {hit=true;return false;}
            if(Intersects(r,other)) { hit=true;return false; } return true;
        },IntPtr.Zero);
        // EnumWindows returns false for intentional early-stop. Missing target is not clear.
        return hit||!found;
    }
    class Bound {
        public Dictionary<string,object> Pin; public IntPtr Hwnd; public Process Process; public RECT Rect;
        public double Dpi; public string Display; public bool Foreground,Modal,Occluded;
        public uint Tick; public int Session;
        public Dictionary<string,object> Lease;
    }
    static Bound Bind(Dictionary<string,object> pin,bool mutation) {
        Keys(pin,"host","app","window_ref","window_id","pid","process_started_at","executable","session_id","allowed_fixture");
        if(!B(pin,"allowed_fixture")||S(pin,"app")!="pai-cp-owned-fixture") Fail("BLOCKED_PERMISSION","Only explicitly owned PAI CP fixture is qualified");
        if(!String.Equals(S(pin,"host"),Environment.MachineName,StringComparison.OrdinalIgnoreCase)) Fail("TARGET_MISMATCH","Machine binding differs");
        long value;if(!Int64.TryParse(S(pin,"window_id"),NumberStyles.None,CultureInfo.InvariantCulture,out value)||value<=0) Fail("INVALID_REQUEST","Positive decimal HWND required");
        var h=new IntPtr(value);
        if(S(pin,"window_ref")!="hwnd:"+value.ToString("x",CultureInfo.InvariantCulture)) Fail("TARGET_MISMATCH","Window reference does not match HWND");
        if(!IsWindow(h)||!IsWindowVisible(h)||IsIconic(h)||Cloaked(h)||GetAncestor(h,2)!=h) Fail("BLOCKED_SESSION","Exact visible non-cloaked top-level target required");
        uint pid;GetWindowThreadProcessId(h,out pid);
        if(pid!=(uint)I(pin,"pid")) Fail("TARGET_MISMATCH","HWND process differs");
        var p=Process.GetProcessById((int)pid);
        if(p.Id==Process.GetCurrentProcess().Id) Fail("TARGET_MISMATCH","Helper cannot target itself");
        if(p.StartTime.ToUniversalTime().ToString("o",CultureInfo.InvariantCulture)!=S(pin,"process_started_at")) Fail("TARGET_MISMATCH","Process start differs");
        string exe=CanonicalPath(p.MainModule.FileName);
        if(!String.Equals(exe,CanonicalPath(S(pin,"executable")),StringComparison.OrdinalIgnoreCase)) Fail("TARGET_MISMATCH","Executable path differs");
        // Explicit fixture ownership is mandatory; these real product/security surfaces remain excluded.
        string baseName=Path.GetFileNameWithoutExtension(exe).ToLowerInvariant();
        foreach(string denied in new string[]{"capcut","autologon","autologon64","consent","logonui","credentialuibroker","regedit","mmc","sechealthui","mstsc","chrome","msedge","firefox"})
            if(baseName==denied) Fail("BLOCKED_PERMISSION","Product/security surface excluded from owned fixture backend");
        int session=p.SessionId;
        if(session<=0||session!=I(pin,"session_id")||session!=Process.GetCurrentProcess().SessionId||!SessionActive(session)||!Environment.UserInteractive||!IsDefaultInput()) Fail("BLOCKED_SESSION","Same WTSActive unlocked Default interactive session required");
        IntPtr old=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(old==IntPtr.Zero) Fail("BLOCKED_SESSION","Per-monitor physical DPI context unavailable");
        RECT rect=VisibleFrame(h); uint dpi=GetDpiForWindow(h);if(dpi==0) Fail("BLOCKED_SESSION","Window DPI unavailable");
        // CopyFromScreen rectangle must be fully inside one physical monitor; no mixed-monitor ambiguity.
        var mi=new MONITORINFOEX {Size=Marshal.SizeOf(typeof(MONITORINFOEX))};
        if(!GetMonitorInfo(MonitorFromWindow(h,2),ref mi)||rect.Left<mi.Monitor.Left||rect.Top<mi.Monitor.Top||rect.Right>mi.Monitor.Right||rect.Bottom>mi.Monitor.Bottom) Fail("BLOCKED_SESSION","Target must fit one physical monitor");
        bool foreground=GetForegroundWindow()==h;
        IntPtr popup=GetLastActivePopup(h);bool modal=!IsWindowEnabled(h)||(popup!=h&&IsWindowVisible(popup));
        bool occ=Occluded(h,rect);
        if(mutation&&(!foreground||modal||occ)) Fail(!foreground?"USER_TAKEOVER":"OCCLUDED","Exact target lost foreground or is occluded/modal");
        return new Bound {Pin=pin,Hwnd=h,Process=p,Rect=rect,Dpi=dpi/96.0,Display=mi.Device,Foreground=foreground,Modal=modal,Occluded=occ,Tick=InputTick(),Session=session};
    }
    static Dictionary<string,object> Locator(AutomationElement e) {
        var ids=e.GetRuntimeId(); var a=new object[ids.Length];for(int i=0;i<ids.Length;i++) a[i]=ids[i];
        return new Dictionary<string,object>{{"runtime_id",a}};
    }
    static bool SameLocator(AutomationElement e,object loc) { return Same(Locator(e),loc); }
    static string Role(ControlType type) { if(type==ControlType.Edit) return "textbox";if(type==ControlType.Button) return "button";if(type==ControlType.Text) return "text";if(type==ControlType.Document) return "document";if(type==ControlType.Window) return "window";return type.ProgrammaticName.Replace("ControlType.","").ToLowerInvariant(); }
    class Tree {
        public List<object> Elements=new List<object>(); public Dictionary<string,AutomationElement> ByLocator=new Dictionary<string,AutomationElement>();
        public List<string> Text=new List<string>(); public object Focused=null; public bool HasSecret=false;
    }
    static Tree Scan(Bound b) {
        var tree=new Tree();var root=AutomationElement.FromHandle(b.Hwnd);
        if(root==null||root.Current.ProcessId!=b.Process.Id) Fail("TARGET_MISMATCH","UIA root process differs");
        var walk=TreeWalker.RawViewWalker; var queue=new Queue<AutomationElement>();queue.Enqueue(root);int count=0;
        while(queue.Count>0) {
            var e=queue.Dequeue(); if(++count>TreeLimit) Fail("TREE_LIMIT","Complete secret scan exceeds safe tree bound");
            var info=e.Current;
            if(info.ProcessId!=b.Process.Id) Fail("TARGET_MISMATCH","Foreign UIA descendant not qualified");
            var box=info.BoundingRectangle;
            bool intersects=!box.IsEmpty&&box.Width>0&&box.Height>0&&box.Left<b.Rect.Right&&box.Right>b.Rect.Left&&box.Top<b.Rect.Bottom&&box.Bottom>b.Rect.Top;
            // Even offscreen password descendants may be aggregated by ancestor Name/Text/Value.
            // Owned-fixture v1 therefore excludes the entire tree on ANY password descendant.
            if(info.IsPassword) tree.HasSecret=true;
            // Password metadata/value/name is never exported. Secret guard scans independently of projection.
            if(intersects&&!info.IsOffscreen&&!info.IsPassword) {
                object value=null; object pattern;
                if(e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) value=((ValuePattern)pattern).Current.Value;
                else if(e.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) value=((TextPattern)pattern).DocumentRange.GetText(20000);
                string name=info.Name??"";if(name.Length>2000) name=name.Substring(0,2000);
                if(value is string && ((string)value).Length>20000) value=((string)value).Substring(0,20000);
                var loc=Locator(e);string key=Json.Serialize(loc);
                tree.ByLocator[key]=e;
                if(info.HasKeyboardFocus) tree.Focused=loc;
                if(tree.Elements.Count<ProjectionLimit) {
                    var item=new Dictionary<string,object>{{"name",name},{"role",Role(info.ControlType)},
                        {"bounds_px",new object[]{box.Left-b.Rect.Left,box.Top-b.Rect.Top,box.Width,box.Height}},
                        {"locator",loc},{"enabled",info.IsEnabled},{"source","UIA"},{"confidence",1}};
                    if(value!=null) item.Add("value",value);
                    tree.Elements.Add(item);
                    if(!String.IsNullOrEmpty(name)) tree.Text.Add(name);
                    if(value is string && !String.IsNullOrEmpty((string)value)) tree.Text.Add((string)value);
                }
            }
            // Enumerate siblings lazily so a malicious gigantic provider cannot allocate an unbounded FindAll.
            var child=walk.GetFirstChild(e);int siblings=0;
            while(child!=null) { if(++siblings>TreeLimit||queue.Count+count>=TreeLimit) Fail("TREE_LIMIT","Complete secret scan exceeds safe tree bound");queue.Enqueue(child);child=walk.GetNextSibling(child); }
        }
        return tree;
    }
    static Dictionary<string,object> Facts(Bound b,Tree tree) {
        return new Dictionary<string,object>{{"host",S(b.Pin,"host")},{"app",S(b.Pin,"app")},{"window_ref",S(b.Pin,"window_ref")},
            {"window_id",S(b.Pin,"window_id")},{"pid",b.Process.Id},{"process_started_at",S(b.Pin,"process_started_at")},
            {"executable",S(b.Pin,"executable")},{"session_ref","windows-session:"+b.Session},
            {"rect_px",R(b.Rect)},{"dpi_scale",b.Dpi},{"display_id",b.Display},
            {"screenshot_width",b.Rect.Right-b.Rect.Left},{"screenshot_height",b.Rect.Bottom-b.Rect.Top},
            {"permission_allowed",true},{"interactive",true},{"locked",false},{"foreground",b.Foreground},
            {"modal_blocked",b.Modal},{"occluded",b.Occluded},{"elements",tree.Elements},
            {"focused_locator",tree.Focused},{"document_text",String.Join("\n",tree.Text)},
            {"visible_text",String.Join("\n",tree.Text)},{"input_tick",b.Tick.ToString(CultureInfo.InvariantCulture)},
            {"secret_present",tree.HasSecret},{"capture_source","physical-scoped-CopyFromScreen"},
            {"physical_geometry_source","DWMWA_EXTENDED_FRAME_BOUNDS"}};
    }
    static void CompareFacts(Dictionary<string,object> expected,Dictionary<string,object> now) {
        foreach(string key in new string[]{"host","app","window_ref","window_id","pid","process_started_at","executable","session_ref"})
            if(!expected.ContainsKey(key)||!Same(expected[key],now[key])) Fail("TARGET_MISMATCH","Native dispatch identity changed: "+key);
        foreach(string key in new string[]{"rect_px","dpi_scale","display_id","screenshot_width","screenshot_height","elements","focused_locator","input_tick","secret_present"})
            if(!expected.ContainsKey(key)||!Same(expected[key],now[key])) Fail(key=="input_tick"?"USER_TAKEOVER":"STALE_SNAPSHOT","Native dispatch observation changed: "+key);
    }
    static void FastFence(Bound b) {
        // Called immediately adjacent to each irreversible API. No focus/activate/restore is ever attempted.
        LeaseFence(b);NoHeldKeys();var next=Bind(b.Pin,true);
        if(!Same(R(b.Rect),R(next.Rect))||b.Dpi!=next.Dpi||b.Display!=next.Display) Fail("STALE_SNAPSHOT","Physical geometry changed before effect");
        if(InputTick()!=b.Tick) Fail("USER_TAKEOVER","User input epoch changed before effect");
    }
    static void LeaseFence(Bound b) {
        if(b.Lease==null) Fail("LEASE_LOST","Pinned existing resource lease required for all native reads/effects");
        Keys(b.Lease,"path","sha256","expires_at");
        string leasePath=S(b.Lease,"path"),expected=S(b.Lease,"sha256"),expiry=S(b.Lease,"expires_at");
        if(!Regex.IsMatch(leasePath,@"^[A-Za-z]:[\\/]")||leasePath.Length>1000||leasePath.IndexOfAny(new char[]{'\0','\r','\n'})>=0||!Regex.IsMatch(expected,"^[a-f0-9]{64}$")) Fail("LEASE_LOST","Invalid pinned local lease descriptor");
        DateTimeOffset expires=DateTimeOffset.MinValue;
        if(!expiry.EndsWith("Z",StringComparison.Ordinal)||!DateTimeOffset.TryParse(expiry,CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out expires)||expires<=DateTimeOffset.UtcNow) Fail("LEASE_LOST","Existing resource lease expired");
        try {
            var info=new FileInfo(leasePath);if(!info.Exists||info.Length>65536||(info.Attributes&FileAttributes.ReparsePoint)!=0) Fail("LEASE_LOST","Existing resource lease absent/invalid");
            byte[] bytes=File.ReadAllBytes(leasePath);string actual;
            using(var sha=System.Security.Cryptography.SHA256.Create()) actual=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
            if(actual!=expected) Fail("LEASE_LOST","Existing resource lease exact bytes changed");
            if(expires<=DateTimeOffset.UtcNow) Fail("LEASE_LOST","Existing resource lease expired during verification");
        } catch(CpError) { throw; } catch(Exception) { Fail("LEASE_LOST","Existing resource lease cannot be verified"); }
    }
    static Tree EffectFence(Bound b,Tree expected) {
        FastFence(b);var current=Scan(b);
        if(current.HasSecret) Fail("SECRET_SURFACE","Secret control appeared immediately before effect");
        if(!Same(expected.Elements,current.Elements)||!Same(expected.Focused,current.Focused)) Fail("STALE_SNAPSHOT","UIA controls/focus changed immediately before effect");
        FastFence(b);return current;
    }
    static void ControlFence(Bound b,AutomationElement e,object locator,ControlType role,bool focus) {
        var info=e.Current;
        if(info.ProcessId!=b.Process.Id||!SameLocator(e,locator)||info.ControlType!=role||!info.IsEnabled||info.IsOffscreen||info.IsPassword) Fail("STALE_SNAPSHOT","Exact allowed UIA control changed before effect");
        if(focus&&!info.HasKeyboardFocus) Fail("USER_TAKEOVER","Exact editable focus changed before effect");
        // A same-HWND overlay is invisible to top-level Z-order tests. Hit-test a concrete
        // visible point and require that UIA resolves the exact control or its descendant.
        // This is read-only: no focus, scroll, invoke or mouse move occurs during the test.
        System.Windows.Point point;
        if(!e.TryGetClickablePoint(out point)) {
            var box=info.BoundingRectangle;
            if(box.IsEmpty||box.Width<=0||box.Height<=0) Fail("OCCLUDED","Allowed control has no visible geometry");
            point=new System.Windows.Point(box.Left+box.Width/2.0,box.Top+box.Height/2.0);
        }
        if(Double.IsNaN(point.X)||Double.IsNaN(point.Y)||Double.IsInfinity(point.X)||Double.IsInfinity(point.Y)||point.X<b.Rect.Left||point.Y<b.Rect.Top||point.X>=b.Rect.Right||point.Y>=b.Rect.Bottom) Fail("OCCLUDED","Allowed control point outside exact window");
        IntPtr under=WindowFromPoint(new POINT((int)Math.Floor(point.X),(int)Math.Floor(point.Y)));
        uint underPid;GetWindowThreadProcessId(under,out underPid);
        if(under==IntPtr.Zero||GetAncestor(under,2)!=b.Hwnd||underPid!=(uint)b.Process.Id) Fail("OCCLUDED","Allowed control point is covered by another native window");
        var hit=AutomationElement.FromPoint(point);bool found=false;
        for(int depth=0;hit!=null&&depth<100;depth++) {
            var h=hit.Current;
            if(h.ProcessId!=b.Process.Id||h.IsPassword) Fail("OCCLUDED","Allowed control point resolves another or secret surface");
            if(SameLocator(hit,locator)) {found=true;break;}
            if(h.NativeWindowHandle==b.Hwnd.ToInt64()) break;
            hit=TreeWalker.RawViewWalker.GetParent(hit);
        }
        if(!found) Fail("OCCLUDED","Allowed control is covered by another UIA control");
    }
    static byte[] Capture(Bound b,Tree before) {
        if(before.HasSecret) Fail("SECRET_SURFACE","Password surface suppresses image");
        if(!b.Foreground||b.Occluded||b.Modal) Fail("OCCLUDED","Image requires clear exact foreground target");
        FastFence(b);
        int width=b.Rect.Right-b.Rect.Left,height=b.Rect.Bottom-b.Rect.Top;
        if(width>8192||height>8192||(long)width*height>24000000) Fail("UNSUPPORTED","Image pixel budget exceeded");
        byte[] bytes;
        using(var bmp=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
            using(var g=Graphics.FromImage(bmp)) g.CopyFromScreen(b.Rect.Left,b.Rect.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
            using(var ms=new MemoryStream()) { bmp.Save(ms,ImageFormat.Png);bytes=ms.ToArray(); }
        }
        // Do not release screenshot bytes if binding, tree/secret or user epoch changed during capture.
        FastFence(b);var after=Scan(Bind(b.Pin,false));
        if(after.HasSecret||!Same(before.Elements,after.Elements)) Fail("STALE_SNAPSHOT","Controls/secret state changed during capture");
        return bytes;
    }
    static AutomationElement Resolve(Tree tree,object locator) {
        var loc=Obj(locator);Keys(loc,"runtime_id");var ids=Arr(loc["runtime_id"]);if(ids.Length<1||ids.Length>64) Fail("INVALID_REQUEST","Bounded runtime ID required");
        foreach(object id in ids) if(!(id is int)) Fail("INVALID_REQUEST","Integer runtime ID required");
        AutomationElement e;if(!tree.ByLocator.TryGetValue(Json.Serialize(loc),out e)) Fail("STALE_SNAPSHOT","Exact observed UIA runtime ID no longer exists");
        return e;
    }
    static void DispatchOrPreflight(Bound b,Tree tree,Dictionary<string,object> action,bool execute) {
        Keys(action,"kind","element_ref","resolved_element","locator","point","space","text","clear","key");
        string kind=S(action,"kind");
        if(tree.HasSecret) Fail("SECRET_SURFACE","Input to secret-bearing fixture is excluded");
        AutomationElement e=null;object loc;
        if(action.TryGetValue("locator",out loc)) {e=Resolve(tree,loc);if(!e.Current.IsEnabled||e.Current.IsPassword||e.Current.IsOffscreen) Fail("BLOCKED_SESSION","Observed element unavailable");}
        if(kind=="type") {
            if(e==null||tree.Focused==null||!Same(tree.Focused,loc)||!e.Current.HasKeyboardFocus||e.Current.ControlType!=ControlType.Edit) Fail("USER_TAKEOVER","Observed editable locator must already own focus");
            string text=S(action,"text");if(text.Length>20000||text.IndexOf('\0')>=0) Fail("INVALID_REQUEST","Bounded NUL-free text required");
            if(!action.ContainsKey("clear")||!B(action,"clear")) Fail("UNSUPPORTED","R1 type requires explicit clear=true ValuePattern fill");
            tree=EffectFence(b,tree);e=Resolve(tree,loc);ControlFence(b,e,loc,ControlType.Edit,true);
            object pattern;if(!e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.IsReadOnly) Fail("UNSUPPORTED","Writable ValuePattern required");
            FastFence(b);ControlFence(b,e,loc,ControlType.Edit,true);
            if(!execute) return;
            attempted=true;((ValuePattern)pattern).SetValue(text);
        } else if(kind=="click"&&e!=null) {
            if(e.Current.ControlType!=ControlType.Button) Fail("UNSUPPORTED","R1 semantic click requires Button InvokePattern");
            tree=EffectFence(b,tree);e=Resolve(tree,loc);ControlFence(b,e,loc,ControlType.Button,false);
            object pattern;if(!e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) Fail("UNSUPPORTED","InvokePattern unavailable");
            FastFence(b);ControlFence(b,e,loc,ControlType.Button,false);if(!execute) return;
            attempted=true;((InvokePattern)pattern).Invoke();
        } else if(kind=="click"&&e==null) {
            if(S(action,"space")!="physical_window_px") Fail("INVALID_REQUEST","Resolved physical window point required");
            var xy=Arr(action["point"]);if(xy.Length!=2) Fail("INVALID_REQUEST","XY required");double x=N(xy[0]),y=N(xy[1]);
            int width=b.Rect.Right-b.Rect.Left,height=b.Rect.Bottom-b.Rect.Top;
            if(x<0||y<0||x>=width||y>=height) Fail("TARGET_MISMATCH","Point outside exact target");
            int sx=b.Rect.Left+(int)Math.Floor(x),sy=b.Rect.Top+(int)Math.Floor(y);
            tree=EffectFence(b,tree);IntPtr under=WindowFromPoint(new POINT(sx,sy));
            if(under!=b.Hwnd&&!IsChild(b.Hwnd,under)) Fail("OCCLUDED","Point does not hit exact target/descendant");
            uint underPid;GetWindowThreadProcessId(under,out underPid);if(underPid!=(uint)b.Process.Id) Fail("TARGET_MISMATCH","Point PID differs");
            // Reject a password hit even if the UIA provider's visible-tree projection disagrees.
            var hit=AutomationElement.FromPoint(new System.Windows.Point(sx,sy));
            if(hit==null||hit.Current.ProcessId!=b.Process.Id||hit.Current.IsPassword) Fail("SECRET_SURFACE","Point UIA hit is not an allowed fixture element");
            int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
            if(vw<2||vh<2) Fail("BLOCKED_SESSION","Virtual desktop metrics unavailable");
            var move=new INPUT {Type=0,Data=new INPUTUNION {Mouse=new MOUSEINPUT {X=(int)Math.Round((sx-vx)*65535.0/(vw-1)),Y=(int)Math.Round((sy-vy)*65535.0/(vh-1)),Flags=0x8000|0x4000|0x0001,ExtraInfo=new UIntPtr(0x50414943)}}};
            var down=new INPUT {Type=0,Data=new INPUTUNION {Mouse=new MOUSEINPUT {Flags=0x0002,ExtraInfo=new UIntPtr(0x50414943)}}};
            var up=new INPUT {Type=0,Data=new INPUTUNION {Mouse=new MOUSEINPUT {Flags=0x0004,ExtraInfo=new UIntPtr(0x50414943)}}};
            FastFence(b);if(!execute) return;
            attempted=true;if(SendInput(3,new INPUT[]{move,down,up},Marshal.SizeOf(typeof(INPUT)))!=3) Fail("UNKNOWN_EFFECT","Partial coordinate input dispatch");
        } else if(kind=="press") {
            if(e==null||tree.Focused==null||!Same(tree.Focused,loc)||!e.Current.HasKeyboardFocus||e.Current.ControlType!=ControlType.Edit) Fail("USER_TAKEOVER","Press requires already-focused exact edit locator");
            string key=S(action,"key");ushort vk=0;
            if(key=="Enter") vk=13;else if(key=="ArrowLeft") vk=37;else if(key=="ArrowRight") vk=39;else if(key=="Home") vk=36;else if(key=="End") vk=35;else if(key=="Backspace") vk=8;else if(key=="Delete") vk=46;else Fail("UNSUPPORTED","R1 key is not allowlisted");
            tree=EffectFence(b,tree);e=Resolve(tree,loc);ControlFence(b,e,loc,ControlType.Edit,true);
            FastFence(b);ControlFence(b,e,loc,ControlType.Edit,true);
            var down=new INPUT {Type=1,Data=new INPUTUNION {Key=new KEYBDINPUT {Vk=vk,ExtraInfo=new UIntPtr(0x50414943)}}};
            var up=new INPUT {Type=1,Data=new INPUTUNION {Key=new KEYBDINPUT {Vk=vk,Flags=2,ExtraInfo=new UIntPtr(0x50414943)}}};
            if(!execute) return;
            attempted=true;if(SendInput(2,new INPUT[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2) Fail("UNKNOWN_EFFECT","Partial keyboard input dispatch");
        } else Fail("UNSUPPORTED","Only typed click/type/press are implemented");
        // This check cannot make OS input atomic. Any changed state after a dispatch is explicitly unknown;
        // existing journal must never retry automatically. The next observation/postcondition owns success.
        LeaseFence(b);var after=Bind(b.Pin,true);
        bool semantic=kind=="type"||(kind=="click"&&e!=null);
        if(semantic) {
            // Invoke/Value may legitimately resize their own window. Their concrete UIA identity,
            // all pre-effect geometry gates, and unchanged post-effect user epoch still bind the
            // dispatch. Core must observe the NEW visible frame/PNG and verify its postcondition.
            if(InputTick()!=b.Tick) Fail("UNKNOWN_EFFECT","User input epoch changed during semantic dispatch");
            // Other DPI/monitors remain outside owned-fixture v1 native qualification.
            if(after.Dpi!=b.Dpi||after.Display!=b.Display) Fail("UNKNOWN_EFFECT","DPI/display changed during semantic dispatch");
        } else if(!Same(R(after.Rect),R(b.Rect))||after.Dpi!=b.Dpi||after.Display!=b.Display) Fail("UNKNOWN_EFFECT","Binding/geometry changed after coordinate/keyboard dispatch");
    }
    public static string Run(string input) {
        attempted=false;
        try {
            if(input==null||input.Length==0||input.Length>2000000) Fail("INVALID_REQUEST","Bounded single JSON request required");
            var request=Obj(Json.DeserializeObject(input));Keys(request,"schema","op","binding","params","expected","action","fence","resource_lease");
            if(I(request,"schema")!=1) Fail("INVALID_REQUEST","Unsupported schema");
            string op=S(request,"op");if(op!="read"&&op!="preflight"&&op!="perform") Fail("INVALID_REQUEST","Only read/preflight/perform are supported");
            var pin=Obj(request["binding"]);var b=Bind(pin,op=="perform");
            b.Lease=Obj(request["resource_lease"]);LeaseFence(b);var tree=Scan(b);
            // Suppress the complete observation, including aggregate ancestor Name/Text/Value, when
            // a visible password descendant exists. Never export potentially aggregated secret text.
            if(tree.HasSecret) Fail("SECRET_SURFACE","Password-bearing fixture observation is excluded");
            var facts=Facts(b,tree);
            if(op=="read") {
                var args=Obj(request["params"]);Keys(args,"include_image","preflight");string mode=S(args,"include_image");
                if(mode!="never"&&mode!="auto"&&mode!="always") Fail("INVALID_REQUEST","Explicit image mode required");
                if(mode!="never") {
                    try { byte[] bytes=Capture(b,tree);facts.Add("image",new Dictionary<string,object>{{"mime_type","image/png"},{"base64",Convert.ToBase64String(bytes)},{"width",b.Rect.Right-b.Rect.Left},{"height",b.Rect.Bottom-b.Rect.Top}}); }
                    catch(CpError e) { if(e.Code!="SECRET_SURFACE"&&e.Code!="OCCLUDED") throw;facts.Add("image_unavailable_reason",e.Code+": "+e.Message); }
                }
                LeaseFence(b);return Json.Serialize(new Dictionary<string,object>{{"ok",true},{"facts",facts},{"attempted",false}});
            }
            CompareFacts(Obj(request["expected"]),facts);
            if(op=="preflight") {
                // The same typed guard/pattern/hit-test path returns BEFORE every native effect API.
                // No journal attempt exists or is needed for this side-effect-free rejection gate.
                DispatchOrPreflight(b,tree,Obj(request["action"]),false);
                LeaseFence(b);return Json.Serialize(new Dictionary<string,object>{{"ok",true},{"attempted",false},{"status","PREFLIGHT_VERIFIED"}});
            }
            var fence=Obj(request["fence"]);Keys(fence,"resource_verified","journal_attempt_id","resource_lease");
            if(!B(fence,"resource_verified")||S(fence,"journal_attempt_id").Length<8||S(fence,"journal_attempt_id").Length>200) Fail("BLOCKED_SESSION","Existing resource/journal fence receipt required");
            var receiptLease=Obj(fence["resource_lease"]);Keys(receiptLease,"path","sha256","expires_at");
            foreach(string field in new string[]{"path","sha256","expires_at"}) if(S(receiptLease,field)!=S(b.Lease,field)) Fail("LEASE_LOST","Journal fence lease differs from immutable native resource lease");
            LeaseFence(b);DispatchOrPreflight(b,tree,Obj(request["action"]),true);
            return Json.Serialize(new Dictionary<string,object>{{"ok",true},{"attempted",attempted},{"action_state","DISPATCHED"},{"effect_state","UNVERIFIED"}});
        } catch(Exception e) {
            var cp=e as CpError;string code=cp==null?"NATIVE_BACKEND_ERROR":cp.Code;
            if(attempted) code="UNKNOWN_EFFECT";
            var error=new Dictionary<string,object>{{"ok",false},{"code",code},{"message",cp==null?e.GetType().Name+": native provider failed":cp.Message},{"attempted",attempted}};
            if(cp==null) {
                Exception cause=e.GetBaseException();
                error.Add("native_diagnostic",new Dictionary<string,object>{{"type",e.GetType().FullName},{"hresult","0x"+e.HResult.ToString("x8",CultureInfo.InvariantCulture)},
                    {"cause_type",cause.GetType().FullName},{"cause_hresult","0x"+cause.HResult.ToString("x8",CultureInfo.InvariantCulture)}});
            }
            return Json.Serialize(error);
        }
    }
    public static void RunStdin() { Console.Out.WriteLine(Run(Console.In.ReadToEnd())); }
}
