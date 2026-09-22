// AudioRender.cs — 432Hz 播放器的输出端：把 stdin 的 PCM 显式渲染到**指定物理端点**。
//
// 为什么需要它：ffplay/SDL2 只能跟随 Windows 默认播放设备，而本机（Win11 25H2）切换
// 默认设备的未公开接口 IPolicyConfig / WinRT AudioPolicyConfig 均已失效（实测 hr=0 但
// 无效果）。WASAPI 允许直接按端点 ID 打开渲染流，因此输出端改为本工具，与系统默认设备
// 完全解耦：系统默认保持 CABLE Input（供所有 App 被捕获），本工具把处理后的声音直接送到
// 物理声卡 → 从根上消除自激环。
//
// 编译：csc /nologo /optimize+ /platform:x64 /out:AudioRender.exe AudioRender.cs
// 用法：AudioRender.exe --device <endpointId> [--rate 48000] [--channels 2] [--format s16]
// 输入：stdin 上的交错 PCM（s16le），按设备时钟节流消费（ffmpeg 捕获是实时速率）。
// 输出：stderr 上一行 JSON 就绪报告；随后周期性输出电平 JSON 行（供宿主读取 RMS）。
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class AudioRender
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorCoClass { }

    private enum EDataFlow { eRender = 0, eCapture = 1 }
    private enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow f, int m, out IntPtr c);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow f, ERole r, out IMMDevice d);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
        [PreserveSig] int OpenPropertyStore(int a, out IntPtr p);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int s);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int flags, long bufDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out int frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out int padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long def, out long min);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(int frames, out IntPtr buffer);
        [PreserveSig] int ReleaseBuffer(int frames, int flags);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    private const int CLSCTX_ALL = 23;
    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const long REFTIMES_PER_SEC = 10000000;
    private const int WAVE_FORMAT_IEEE_FLOAT = 3;
    private const int WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

    private static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioRenderClient = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
    private static readonly Guid SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");
    private static readonly Guid SUBTYPE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");

    private static string Q(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s) { if (c == '"' || c == '\\') sb.Append('\\'); sb.Append(c == '\n' ? ' ' : c); }
        return sb.Append('"').ToString();
    }

    private static void Emit(string text)
    {
        try
        {
            Console.Error.WriteLine(text);
            Console.Error.Flush();
        }
        catch { }
    }

    private static int Fail(string step, int hr)
    {
        Emit("{\"ok\":false,\"step\":" + Q(step) + ",\"hr\":" + Q("0x" + hr.ToString("X8")) + "}");
        return 1;
    }

    private static int Main(string[] args)
    {
        string deviceId = null, inFormat = "s16";
        int inRate = 48000, inChannels = 2, statsMs = 1000;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--device": deviceId = args[++i]; break;
                case "--rate": inRate = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                case "--channels": inChannels = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                case "--format": inFormat = args[++i]; break;
                case "--stats-ms": statsMs = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
            }
        }
        if (deviceId == null) { Emit("{\"ok\":false,\"error\":\"--device required\"}"); return 2; }
        if (inFormat != "s16") { Emit("{\"ok\":false,\"error\":\"only s16 stdin supported\"}"); return 2; }

        try
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCoClass();
            IMMDevice dev;
            int hr = en.GetDevice(deviceId, out dev);
            if (hr != 0) return Fail("GetDevice", hr);

            object o;
            var iid = IID_IAudioClient;
            hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            if (hr != 0) return Fail("Activate", hr);
            var ac = (IAudioClient)o;

            IntPtr pFormat;
            hr = ac.GetMixFormat(out pFormat);
            if (hr != 0) return Fail("GetMixFormat", hr);
            var wf = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
            int devRate = (int)wf.nSamplesPerSec;
            int devChannels = wf.nChannels;
            bool devFloat = false;
            int devBits = wf.wBitsPerSample;
            if (wf.wFormatTag == WAVE_FORMAT_IEEE_FLOAT) devFloat = true;
            else if (wf.wFormatTag == WAVE_FORMAT_EXTENSIBLE)
            {
                var we = (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEXTENSIBLE));
                if (we.SubFormat == SUBTYPE_FLOAT) devFloat = true;
                else if (we.SubFormat != SUBTYPE_PCM) { Emit("{\"ok\":false,\"error\":\"unsupported device subformat " + we.SubFormat + "\"}"); return 3; }
            }

            var ev = new ManualResetEvent(false);
            // 100ms 缓冲：够稳、延迟可控
            hr = ac.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, REFTIMES_PER_SEC / 10, 0, pFormat, IntPtr.Zero);
            if (hr != 0) return Fail("Initialize", hr);
            hr = ac.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
            if (hr != 0) return Fail("SetEventHandle", hr);
            int bufFrames; ac.GetBufferSize(out bufFrames);
            object ro;
            var iidR = IID_IAudioRenderClient;
            hr = ac.GetService(ref iidR, out ro);
            if (hr != 0) return Fail("GetService", hr);
            var rc = (IAudioRenderClient)ro;

            hr = ac.Start();
            if (hr != 0) return Fail("Start", hr);
            Emit("{\"ok\":true,\"ready\":true,\"deviceId\":" + Q(deviceId) + ",\"deviceRate\":" + devRate
                + ",\"deviceChannels\":" + devChannels + ",\"deviceFormat\":" + Q((devFloat ? "float" : "pcm") + devBits)
                + ",\"inputRate\":" + inRate + ",\"inputChannels\":" + inChannels + ",\"bufferFrames\":" + bufFrames + "}");

            var stdin = Console.OpenStandardInput();
            double step = (double)inRate / devRate;
            double sourcePos = 0;                 // 输入侧重采样位置（线性插值）
            int inFrameBytes = inChannels * 2;
            var readBuf = new byte[inFrameBytes * 4096];
            var carried = new MemoryStream();
            long totalInFrames = 0;
            double peak = 0, sumSquares = 0;
            long statFrames = 0;
            var sw = Stopwatch.StartNew();
            var statSw = Stopwatch.StartNew();
            // 输入缓冲：inBuf[inStart..inLen) 是尚未消费的 s16le 交错样本。
            var inBuf = new byte[inFrameBytes * 8192];
            int inStart = 0, inLen = 0;
            bool eof = false;

            /** 至少补足 needBytes 字节（不足时返回 false 表示流结束）。 */
            Func<int, bool> ensure = (needBytes) =>
            {
                if (inLen - inStart >= needBytes) return true;
                if (inStart > 0)
                {
                    Buffer.BlockCopy(inBuf, inStart, inBuf, 0, inLen - inStart);
                    inLen -= inStart;
                    inStart = 0;
                }
                if (needBytes > inBuf.Length)
                {
                    var bigger = new byte[needBytes * 2];
                    Buffer.BlockCopy(inBuf, 0, bigger, 0, inLen);
                    inBuf = bigger;
                }
                while (inLen - inStart < needBytes && !eof)
                {
                    int read = stdin.Read(inBuf, inLen, inBuf.Length - inLen);
                    if (read <= 0) { eof = true; break; }
                    inLen += read;
                }
                return inLen - inStart >= needBytes;
            };

            var stop = false;
            while (!stop)
            {
                ev.WaitOne(200);
                int padding; ac.GetCurrentPadding(out padding);
                int avail = bufFrames - padding;
                if (avail <= 0) continue;

                int needInFrames = (int)Math.Ceiling(avail * step) + 3;
                if (!ensure(needInFrames * inFrameBytes)) break;

                IntPtr dst;
                if (rc.GetBuffer(avail, out dst) != 0) break;

                int produced = 0;
                while (produced < avail)
                {
                    int inFramesAvailable = (inLen - inStart) / inFrameBytes;
                    int idx = (int)sourcePos;
                    if (idx + 1 >= inFramesAvailable) break;
                    double frac = sourcePos - idx;

                    for (int c = 0; c < devChannels; c++)
                    {
                        int srcChannel = c < inChannels ? c : inChannels - 1;
                        int i0 = inStart + (idx * inChannels + srcChannel) * 2;
                        int i1 = inStart + ((idx + 1) * inChannels + srcChannel) * 2;
                        short s0 = (short)(inBuf[i0] | (inBuf[i0 + 1] << 8));
                        short s1 = (short)(inBuf[i1] | (inBuf[i1 + 1] << 8));
                        double value = (s0 + (s1 - s0) * frac) / 32768.0;
                        double abs = Math.Abs(value);
                        if (abs > peak) peak = abs;
                        sumSquares += value * value;
                        statFrames++;
                        int outOffset = (produced * devChannels + c) * (devBits / 8);
                        if (devFloat)
                            Marshal.WriteInt32(dst, outOffset, BitConverter.ToInt32(BitConverter.GetBytes((float)value), 0));
                        else if (devBits == 16)
                            Marshal.WriteInt16(dst, outOffset, (short)Math.Max(-32768, Math.Min(32767, value * 32767)));
                        else if (devBits == 32)
                            Marshal.WriteInt32(dst, outOffset, (int)Math.Max(int.MinValue, Math.Min(int.MaxValue, value * 2147483647.0)));
                        else if (devBits == 24)
                        {
                            int v = (int)(value * 8388607.0);
                            Marshal.WriteByte(dst, outOffset, (byte)(v & 0xFF));
                            Marshal.WriteByte(dst, outOffset + 1, (byte)((v >> 8) & 0xFF));
                            Marshal.WriteByte(dst, outOffset + 2, (byte)((v >> 16) & 0xFF));
                        }
                    }
                    produced++;
                    sourcePos += step;
                }

                // 消费掉已读过的输入帧（保留不足一帧的尾巴）
                int advanced = (int)sourcePos;
                if (advanced > 0)
                {
                    inStart += advanced * inFrameBytes;
                    sourcePos -= advanced;
                    totalInFrames += advanced;
                    if (inStart >= inLen) { inStart = 0; inLen = 0; }
                }
                rc.ReleaseBuffer(produced, 0);

                if (statSw.ElapsedMilliseconds >= statsMs)
                {
                    double rms = statFrames > 0 ? Math.Sqrt(sumSquares / statFrames) : 0;
                    Emit("{\"evt\":\"level\",\"elapsedMs\":" + sw.ElapsedMilliseconds + ",\"frames\":" + totalInFrames
                        + ",\"peak\":" + peak.ToString("0.0000", CultureInfo.InvariantCulture)
                        + ",\"rms\":" + rms.ToString("0.0000", CultureInfo.InvariantCulture)
                        + ",\"rmsDb\":" + (rms > 0 ? (20 * Math.Log10(rms)).ToString("0.0", CultureInfo.InvariantCulture) : "-inf") + "}");
                    peak = 0; sumSquares = 0; statFrames = 0;
                    statSw.Restart();
                }
            }

            Thread.Sleep(120);
            ac.Stop();
            Emit("{\"evt\":\"eof\",\"elapsedMs\":" + sw.ElapsedMilliseconds + ",\"frames\":" + totalInFrames + "}");
            return 0;
        }
        catch (Exception ex)
        {
            Emit("{\"ok\":false,\"error\":" + Q(ex.GetType().Name + ": " + ex.Message) + "}");
            return 9;
        }
    }
}
