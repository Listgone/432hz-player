// AudioEndpoint.cs — 音频端点查询 / 默认设备切换 / 电平探测（零安装，用系统自带 csc.exe 编译）
// 编译：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /out:AudioEndpoint.exe AudioEndpoint.cs
// 用法：
//   AudioEndpoint.exe list                     列出所有端点（render/capture，含状态与 ID）
//   AudioEndpoint.exe default                  当前默认播放/录音设备
//   AudioEndpoint.exe set-render <id|nameSub>  切换默认播放设备（打印切换前快照，便于还原）
//   AudioEndpoint.exe set-capture <id|nameSub> 切换默认录音设备
//   AudioEndpoint.exe restore <renderId> <captureId|null>  还原到指定 ID
//   AudioEndpoint.exe peaks <ms>               采样所有活动 render 端点的峰值（判断声音去了哪个设备）
//   AudioEndpoint.exe watch-render <ms> <step> 轮询默认播放设备是否变化（判断 ffplay 是否跟随默认设备）
// 输出一律为单行 JSON（UTF-8），便于 Node 解析。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class AudioEndpoint
{
    // ---------- Core Audio COM ----------
    private const int CLSCTX_ALL = 23;
    private static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid IID_IAudioMeterInformation = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
    private static readonly Guid CLSID_CPolicyConfigClientLegacy = new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9");
    private static readonly Guid CLSID_CPolicyConfigClientModern = new Guid("294935CE-F637-4E7C-A41B-AB255460B862");
    private static readonly Guid IID_IPolicyConfig = new Guid("f8679f50-850a-4090-9c72-430f290290c8");

    private enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    private enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    private struct PROPVARIANT
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
        [PreserveSig] int GetMeteringChannelCount(out int channelCount);
        [PreserveSig] int GetChannelsPeakValues(int channelCount, [Out] float[] peakValues);
        [PreserveSig] int QueryHardwareSupport(out int hardwareSupportMask);
    }

    // IPolicyConfig：未公开接口，vtable 顺序必须精确。
    // Windows 11 24H2/25H2 把该接口换成了新 CLSID {294935CE-...} + 新 IID {568b9108-...}，
    // 旧 IID {f8679f50-...} 会 E_NOINTERFACE —— 因此两套都声明，运行时按可用性选择。
    [ComImport, Guid("f8679f50-850a-4090-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfigLegacy
    {
        int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, out IntPtr format);
        int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bDefault, out IntPtr format);
        int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName);
        int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr endpointFormat, IntPtr mixFormat);
        int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
        int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr period);
        int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr mode);
        int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr mode);
        int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bFxStore, IntPtr key, IntPtr value);
        int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bFxStore, IntPtr key, IntPtr value);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceName, ERole role);
        int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool visible);
    }

    /** 24H2/25H2 的 IPolicyConfig（同布局，新 IID）。 */
    [ComImport, Guid("568b9108-44bf-40b4-9006-86afe5b5a620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfigModern
    {
        int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, out IntPtr format);
        int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bDefault, out IntPtr format);
        int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName);
        int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr endpointFormat, IntPtr mixFormat);
        int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
        int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr period);
        int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr mode);
        int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr mode);
        int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bFxStore, IntPtr key, IntPtr value);
        int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool bFxStore, IntPtr key, IntPtr value);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceName, ERole role);
        int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceName, bool visible);
    }

    private static readonly PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY
    { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    private static readonly PROPERTYKEY PKEY_Device_DeviceDesc = new PROPERTYKEY
    { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 2 };
    private static readonly PROPERTYKEY PKEY_DeviceInterface_FriendlyName = new PROPERTYKEY
    { fmtid = new Guid("b3f8fa53-0004-438e-9003-51a46e139bfc"), pid = 6 };

    private const int DEVICE_STATE_ACTIVE = 0x1;
    private const int DEVICE_STATE_DISABLED = 0x2;
    private const int DEVICE_STATE_NOTPRESENT = 0x4;
    private const int DEVICE_STATE_UNPLUGGED = 0x8;
    private const int DEVICE_STATEMASK_ALL = 0xF;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorCoClass { }

    private static IMMDeviceEnumerator Enumerator()
    {
        try
        {
            var comClass = new MMDeviceEnumeratorCoClass();
            var typed = comClass as IMMDeviceEnumerator;
            if (typed != null) return typed;
        }
        catch (Exception)
        {
            // 回退到 CLSID 激活
        }
        var type = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
        return (IMMDeviceEnumerator)Activator.CreateInstance(type);
    }

    private static string GetString(IMMDevice device, PROPERTYKEY key)
    {
        IPropertyStore store = null;
        try
        {
            if (device == null) return null;
            int hr = device.OpenPropertyStore(0, out store);
            if (hr != 0 || store == null) return null;
            var v = new PROPVARIANT();
            if (store.GetValue(ref key, out v) != 0) return null;
            if (v.vt == 31 && v.pointerValue != IntPtr.Zero) return Marshal.PtrToStringUni(v.pointerValue);
            return null;
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            if (store != null) Marshal.ReleaseComObject(store);
        }
    }

    // 逐步诊断：返回每一步的 HRESULT，便于定位互操作失败点
    private static string Diagnose()
    {
        var sb = new StringBuilder("{\"ok\":true,\"steps\":[");
        Action<string, string> add = (step, detail) =>
        {
            if (sb.Length > 20) sb.Append(',');
            sb.Append("{\"step\":").Append(Q(step)).Append(",\"detail\":").Append(Q(detail)).Append('}');
        };
        try
        {
            var en = Enumerator();
            add("enumerator", en == null ? "null" : en.GetType().Name);
            if (en != null)
            {
                IMMDeviceCollection col = null;
                int hr = en.EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATEMASK_ALL, out col);
                add("EnumAudioEndpoints", "hr=0x" + hr.ToString("X8") + " col=" + (col == null ? "null" : "ok"));
                if (col != null)
                {
                    int count; int hr2 = col.GetCount(out count);
                    add("GetCount", "hr=0x" + hr2.ToString("X8") + " count=" + count);
                    if (hr2 == 0 && count > 0)
                    {
                        IMMDevice dev = null;
                        int hr3 = col.Item(0, out dev);
                        add("Item0", "hr=0x" + hr3.ToString("X8") + " dev=" + (dev == null ? "null" : "ok"));
                        if (dev != null)
                        {
                            string id; int hr4 = dev.GetId(out id);
                            add("GetId", "hr=0x" + hr4.ToString("X8") + " id=" + id);
                            IPropertyStore ps = null;
                            int hr5 = dev.OpenPropertyStore(0, out ps);
                            add("OpenPropertyStore", "hr=0x" + hr5.ToString("X8") + " store=" + (ps == null ? "null" : "ok"));
                            add("FriendlyName", "val=" + GetString(dev, PKEY_Device_FriendlyName));
                            Marshal.ReleaseComObject(dev);
                        }
                    }
                    Marshal.ReleaseComObject(col);
                }
                Marshal.ReleaseComObject(en);
            }
        }
        catch (Exception ex)
        {
            add("EXCEPTION", ex.GetType().Name + ": " + ex.Message + " @ " + (ex.StackTrace ?? "").Split('\n')[0].Trim());
        }
        sb.Append("]}");
        return sb.ToString();
    }

    private static string StateName(int state)
    {
        if ((state & DEVICE_STATE_ACTIVE) != 0) return "active";
        if ((state & DEVICE_STATE_DISABLED) != 0) return "disabled";
        if ((state & DEVICE_STATE_NOTPRESENT) != 0) return "notpresent";
        if ((state & DEVICE_STATE_UNPLUGGED) != 0) return "unplugged";
        return "unknown(" + state + ")";
    }

    private sealed class Endpoint
    {
        public string id, friendly, desc, adapter, flow;
        public int state;
        public string Json()
        {
            return "{\"id\":" + Q(id) + ",\"name\":" + Q(friendly) + ",\"desc\":" + Q(desc)
                + ",\"adapter\":" + Q(adapter) + ",\"flow\":" + Q(flow)
                + ",\"state\":" + Q(StateName(state)) + ",\"stateRaw\":" + state + "}";
        }
    }

    private static List<Endpoint> Enumerate(EDataFlow flow)
    {
        var list = new List<Endpoint>();
        var en = Enumerator();
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(flow, DEVICE_STATEMASK_ALL, out col) != 0) return list;
        int count; col.GetCount(out count);
        for (int i = 0; i < count; i++)
        {
            IMMDevice dev;
            if (col.Item(i, out dev) != 0) continue;
            string id; dev.GetId(out id);
            int state; dev.GetState(out state);
            var e = new Endpoint
            {
                id = id,
                friendly = GetString(dev, PKEY_Device_FriendlyName),
                desc = GetString(dev, PKEY_Device_DeviceDesc),
                adapter = GetString(dev, PKEY_DeviceInterface_FriendlyName),
                flow = flow == EDataFlow.eRender ? "render" : "capture",
                state = state,
            };
            list.Add(e);
            Marshal.ReleaseComObject(dev);
        }
        Marshal.ReleaseComObject(col);
        Marshal.ReleaseComObject(en);
        return list;
    }

    private static Endpoint GetDefault(EDataFlow flow, out string error)
    {
        error = null;
        try
        {
            var en = Enumerator();
            IMMDevice dev;
            int hr = en.GetDefaultAudioEndpoint(flow, ERole.eConsole, out dev);
            if (hr != 0) { error = "0x" + hr.ToString("X8"); Marshal.ReleaseComObject(en); return null; }
            string id; dev.GetId(out id);
            int state; dev.GetState(out state);
            var e = new Endpoint
            {
                id = id,
                friendly = GetString(dev, PKEY_Device_FriendlyName),
                desc = GetString(dev, PKEY_Device_DeviceDesc),
                adapter = GetString(dev, PKEY_DeviceInterface_FriendlyName),
                flow = flow == EDataFlow.eRender ? "render" : "capture",
                state = state,
            };
            Marshal.ReleaseComObject(dev);
            Marshal.ReleaseComObject(en);
            return e;
        }
        catch (Exception ex) { error = ex.Message; return null; }
    }

    private static string Ignore;

    private static string Q(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    private static bool Matches(Endpoint e, string needle)
    {
        if (string.IsNullOrEmpty(needle)) return false;
        if (string.Equals(e.id, needle, StringComparison.OrdinalIgnoreCase)) return true;
        if (e.friendly != null && e.friendly.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (e.desc != null && e.desc.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }

    /** 尝试两套 CLSID/IID：新（24H2/25H2）优先，失败回退旧。返回实际使用的组合名。 */
    private static object CreatePolicyConfig(out string variant)
    {
        // 新 IID：CLSID {294935CE-...}
        try
        {
            var type = Type.GetTypeFromCLSID(CLSID_CPolicyConfigClientModern);
            var obj = Activator.CreateInstance(type);
            var modern = obj as IPolicyConfigModern;
            if (modern != null) { variant = "modern:294935CE/568b9108"; return modern; }
            Marshal.ReleaseComObject(obj);
        }
        catch { /* 回退 */ }
        try
        {
            var type = Type.GetTypeFromCLSID(CLSID_CPolicyConfigClientLegacy);
            var obj = Activator.CreateInstance(type);
            var legacy = obj as IPolicyConfigLegacy;
            if (legacy != null) { variant = "legacy:870af99c/f8679f50"; return legacy; }
            Marshal.ReleaseComObject(obj);
        }
        catch { /* 无可用 */ }
        variant = null;
        return null;
    }

    private static int SetDefault(string id, EDataFlow flow)
    {
        string variant;
        object pc = CreatePolicyConfig(out variant);
        if (pc == null) return unchecked((int)0x80004002); // E_NOINTERFACE
        int hr = 1;
        var legacy = pc as IPolicyConfigLegacy;
        if (legacy != null)
        {
            foreach (ERole role in new[] { ERole.eConsole, ERole.eMultimedia, ERole.eCommunications })
            {
                int r = legacy.SetDefaultEndpoint(id, role);
                if (r == 0) hr = 0;
            }
        }
        else
        {
            var modern = (IPolicyConfigModern)pc;
            foreach (ERole role in new[] { ERole.eConsole, ERole.eMultimedia, ERole.eCommunications })
            {
                int r = modern.SetDefaultEndpoint(id, role);
                if (r == 0) hr = 0;
            }
        }
        Marshal.ReleaseComObject(pc);
        return hr;
    }

    private static float PeakOf(string id)
    {
        try
        {
            var en = Enumerator();
            IMMDevice dev;
            if (en.GetDevice(id, out dev) != 0) { Marshal.ReleaseComObject(en); return -1f; }
            var iid = IID_IAudioMeterInformation;
            object o;
            if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0) { Marshal.ReleaseComObject(dev); Marshal.ReleaseComObject(en); return -1f; }
            var meter = (IAudioMeterInformation)o;
            float p; meter.GetPeakValue(out p);
            Marshal.ReleaseComObject(o);
            Marshal.ReleaseComObject(dev);
            Marshal.ReleaseComObject(en);
            return p;
        }
        catch { return -1f; }
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "default";
        try
        {
            switch (cmd)
            {
                case "list":
                {
                    var sb = new StringBuilder("{\"ok\":true,\"render\":[");
                    var rs = Enumerate(EDataFlow.eRender);
                    for (int i = 0; i < rs.Count; i++) { if (i > 0) sb.Append(','); sb.Append(rs[i].Json()); }
                    sb.Append("],\"capture\":[");
                    var cs = Enumerate(EDataFlow.eCapture);
                    for (int i = 0; i < cs.Count; i++) { if (i > 0) sb.Append(','); sb.Append(cs[i].Json()); }
                    sb.Append("]}");
                    Console.WriteLine(sb.ToString());
                    return 0;
                }
                case "diag":
                {
                    Console.WriteLine(Diagnose());
                    return 0;
                }
                case "default":
                {
                    string e1, e2;
                    var r = GetDefault(EDataFlow.eRender, out e1);
                    var c = GetDefault(EDataFlow.eCapture, out e2);
                    Console.WriteLine("{\"ok\":" + (r != null ? "true" : "false")
                        + ",\"render\":" + (r != null ? r.Json() : "null")
                        + ",\"capture\":" + (c != null ? c.Json() : "null")
                        + ",\"error\":" + Q(e1 ?? e2) + "}");
                    return r != null ? 0 : 1;
                }
                case "set-render":
                case "set-capture":
                {
                    if (args.Length < 2) { Console.WriteLine("{\"ok\":false,\"error\":\"missing target\"}"); return 2; }
                    var flow = cmd == "set-render" ? EDataFlow.eRender : EDataFlow.eCapture;
                    var before = GetDefault(flow, out Ignore);
                    var all = Enumerate(flow);
                    Endpoint target = null;
                    foreach (var e in all) if (Matches(e, args[1])) { target = e; break; }
                    if (target == null)
                    {
                        Console.WriteLine("{\"ok\":false,\"error\":\"not found\",\"before\":" + (before != null ? before.Json() : "null") + "}");
                        return 3;
                    }
                    if ((target.state & DEVICE_STATE_ACTIVE) == 0)
                    {
                        Console.WriteLine("{\"ok\":false,\"error\":\"target not active\",\"state\":" + Q(StateName(target.state))
                            + ",\"target\":" + target.Json() + ",\"before\":" + (before != null ? before.Json() : "null") + "}");
                        return 4;
                    }
                    int hr = SetDefault(target.id, flow);
                    Thread.Sleep(150);
                    var after = GetDefault(flow, out Ignore);
                    bool ok = hr == 0 && after != null && string.Equals(after.id, target.id, StringComparison.OrdinalIgnoreCase);
                    Console.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"hr\":" + Q("0x" + hr.ToString("X8"))
                        + ",\"target\":" + target.Json() + ",\"before\":" + (before != null ? before.Json() : "null")
                        + ",\"after\":" + (after != null ? after.Json() : "null") + "}");
                    return ok ? 0 : 5;
                }
                case "restore":
                {
                    if (args.Length < 2) { Console.WriteLine("{\"ok\":false,\"error\":\"missing id\"}"); return 2; }
                    string rid = args[1];
                    string cid = args.Length > 2 && args[2] != "null" ? args[2] : null;
                    int hr = 1;
                    bool okR = false, okC = cid == null;
                    if (rid != "null" && rid.Length > 0)
                    {
                        hr = SetDefault(rid, EDataFlow.eRender);
                        Thread.Sleep(120);
                        var a = GetDefault(EDataFlow.eRender, out Ignore);
                        okR = a != null && string.Equals(a.id, rid, StringComparison.OrdinalIgnoreCase);
                    }
                    else okR = true;
                    if (cid != null)
                    {
                        int hr2 = SetDefault(cid, EDataFlow.eCapture);
                        Thread.Sleep(120);
                        var a2 = GetDefault(EDataFlow.eCapture, out Ignore);
                        okC = a2 != null && string.Equals(a2.id, cid, StringComparison.OrdinalIgnoreCase);
                    }
                    Console.WriteLine("{\"ok\":" + ((okR && okC) ? "true" : "false") + ",\"renderOk\":" + (okR ? "true" : "false")
                        + ",\"captureOk\":" + (okC ? "true" : "false") + ",\"hr\":" + Q("0x" + hr.ToString("X8")) + "}");
                    return (okR && okC) ? 0 : 5;
                }
                case "peaks":
                {
                    int ms = args.Length > 1 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 1000;
                    var rs = Enumerate(EDataFlow.eRender);
                    var maxima = new Dictionary<string, float>();
                    var names = new Dictionary<string, string>();
                    foreach (var e in rs) { maxima[e.id] = 0f; names[e.id] = e.friendly; }
                    var sw = Stopwatch.StartNew();
                    while (sw.ElapsedMilliseconds < ms)
                    {
                        foreach (var e in rs)
                        {
                            if ((e.state & DEVICE_STATE_ACTIVE) == 0) continue;
                            float p = PeakOf(e.id);
                            if (p > maxima[e.id]) maxima[e.id] = p;
                        }
                        Thread.Sleep(20);
                    }
                    var sb = new StringBuilder("{\"ok\":true,\"peaks\":[");
                    bool first = true;
                    foreach (var e in rs)
                    {
                        if ((e.state & DEVICE_STATE_ACTIVE) == 0) continue;
                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append("{\"id\":").Append(Q(e.id)).Append(",\"name\":").Append(Q(names[e.id]))
                          .Append(",\"peak\":").Append(maxima[e.id].ToString("0.0000", CultureInfo.InvariantCulture)).Append('}');
                    }
                    sb.Append("]}");
                    Console.WriteLine(sb.ToString());
                    return 0;
                }
                case "watch-render":
                {
                    int ms = args.Length > 1 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 2000;
                    int step = args.Length > 2 ? int.Parse(args[2], CultureInfo.InvariantCulture) : 100;
                    var seen = new List<string>();
                    var sw = Stopwatch.StartNew();
                    while (sw.ElapsedMilliseconds < ms)
                    {
                        var d = GetDefault(EDataFlow.eRender, out Ignore);
                        if (d != null) { if (seen.Count == 0 || seen[seen.Count - 1] != d.id) seen.Add(d.id); }
                        Thread.Sleep(step);
                    }
                    var sb = new StringBuilder("{\"ok\":true,\"sequence\":[");
                    for (int i = 0; i < seen.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Q(seen[i])); }
                    sb.Append("],\"changes\":").Append(Math.Max(0, seen.Count - 1)).Append('}');
                    Console.WriteLine(sb.ToString());
                    return 0;
                }
                default:
                    Console.WriteLine("{\"ok\":false,\"error\":\"unknown command\"}");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"ok\":false,\"error\":" + Q(ex.GetType().Name + ": " + ex.Message)
                + ",\"stack\":" + Q(ex.StackTrace ?? "") + "}");
            return 9;
        }
    }
}
