// Learn's C# core for Learn.ps1: the Windows calls the window needs, the line channel
// to the helper in WSL (learn.sh serve), and atomic saves of the window's own prefs.
// Windows PowerShell 5.1 compiles this with the old C# 5 compiler: no string
// interpolation, no ?., no expression-bodied members, no out var, no nameof.
// Kept ASCII-only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LearnCore
{
    public static class LearnWin32
    {
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        struct MonitorInfo { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public static IntPtr WindowByText(string text)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                var title = new StringBuilder(256);
                GetWindowText(hWnd, title, title.Capacity);
                if (title.ToString() == text) { found = hWnd; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // The usable part of the screen the window is on (the taskbar left out).
        public static RECT WorkArea(IntPtr hWnd)
        {
            var info = new MonitorInfo();
            info.Size = Marshal.SizeOf(typeof(MonitorInfo));
            IntPtr monitor = MonitorFromWindow(hWnd, 2); // MONITOR_DEFAULTTONEAREST
            if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info))
            {
                var whole = new RECT();
                whole.Right = 1920; whole.Bottom = 1080;
                return whole;
            }
            return info.Work;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        static IntPtr killJob = IntPtr.Zero;

        // Puts a process in a job that Windows kills when this process exits, however it exits.
        public static bool TieToThisProcess(Process child)
        {
            try
            {
                if (killJob == IntPtr.Zero)
                {
                    var job = CreateJobObject(IntPtr.Zero, null);
                    if (job == IntPtr.Zero) return false;
                    var limits = new ExtendedLimits();
                    limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    int length = Marshal.SizeOf(typeof(ExtendedLimits));
                    IntPtr buffer = Marshal.AllocHGlobal(length);
                    try
                    {
                        Marshal.StructureToPtr(limits, buffer, false);
                        if (!SetInformationJobObject(job, 9, buffer, (uint)length)) return false;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                    killJob = job;
                }
                return AssignProcessToJobObject(killJob, child.Handle);
            }
            catch { return false; }
        }
    }

    // A child process spoken to in lines: what it prints is read on background threads
    // into a list the window drains from a DispatcherTimer, so no PowerShell ever runs
    // off the window's thread. Writes go out as UTF-8.
    public sealed class LineProcess
    {
        readonly object gate = new object();
        readonly List<string> lines = new List<string>();
        readonly StringBuilder errors = new StringBuilder();
        Process process;
        StreamWriter input;

        public string StartError { get; private set; }

        public static LineProcess Start(string file, string arguments)
        {
            var channel = new LineProcess();
            try
            {
                var info = new ProcessStartInfo(file, arguments);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardInput = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                info.StandardOutputEncoding = new UTF8Encoding(false);
                info.StandardErrorEncoding = new UTF8Encoding(false);
                channel.process = Process.Start(info);
                LearnWin32.TieToThisProcess(channel.process);
                channel.input = new StreamWriter(channel.process.StandardInput.BaseStream, new UTF8Encoding(false));
                channel.input.AutoFlush = true;
                channel.input.NewLine = "\n";
                var reader = new Thread(channel.ReadOut);
                reader.IsBackground = true;
                reader.Start();
                var errorReader = new Thread(channel.ReadErr);
                errorReader.IsBackground = true;
                errorReader.Start();
            }
            catch (Exception e)
            {
                channel.StartError = e.Message;
            }
            return channel;
        }

        void ReadOut()
        {
            try
            {
                string line;
                while ((line = process.StandardOutput.ReadLine()) != null)
                {
                    lock (gate) { lines.Add(line); }
                }
            }
            catch { }
        }

        void ReadErr()
        {
            try
            {
                string line;
                while ((line = process.StandardError.ReadLine()) != null)
                {
                    lock (gate)
                    {
                        errors.AppendLine(line);
                        if (errors.Length > 8000) errors.Remove(0, errors.Length - 8000);
                    }
                }
            }
            catch { }
        }

        public bool IsAlive
        {
            get
            {
                try { return process != null && !process.HasExited; }
                catch { return false; }
            }
        }

        public bool Send(string line)
        {
            try
            {
                if (!IsAlive) return false;
                input.WriteLine(line);
                return true;
            }
            catch { return false; }
        }

        public string[] Drain()
        {
            lock (gate)
            {
                var taken = lines.ToArray();
                lines.Clear();
                return taken;
            }
        }

        public string Errors()
        {
            lock (gate) { return errors.ToString(); }
        }

        public void Stop()
        {
            try { if (input != null) input.Close(); } catch { }
            try { if (process != null && !process.WaitForExit(800)) process.Kill(); } catch { }
        }
    }

    public static class SafeFile
    {
        public static void WriteAtomic(string path, string text)
        {
            string temp = path + ".tmp", backup = path + ".bak";
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(temp, text, Encoding.ASCII);
            if (!File.Exists(path)) { File.Move(temp, path); return; }
            try { File.Replace(temp, path, backup, true); }
            catch
            {
                File.Copy(path, backup, true);
                File.Copy(temp, path, true);
                File.Delete(temp);
            }
        }

        public static string Read(string path)
        {
            try { return File.Exists(path) ? File.ReadAllText(path, Encoding.ASCII) : null; }
            catch { return null; }
        }
    }
}
