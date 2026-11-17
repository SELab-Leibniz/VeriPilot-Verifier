using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// One non-breakaway Windows Job per sample. No KILL_ON_JOB_CLOSE: an observer
// or supervisor crash must not prematurely kill healthy work before its limit.
public sealed class RcSampleJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] public struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attr, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr handle;
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Created(IntPtr process) {
    long c,e,k,u; Check(GetProcessTimes(process,out c,out e,out k,out u));
    return DateTime.FromFileTimeUtc(c).ToString("o");
  }
  public static string ProcessCreated(int pid) {
    IntPtr p=OpenProcess(0x1000,false,pid);
    if(p==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return Created(p); } finally { CloseHandle(p); }
  }
  public static bool OriginalAlive(int pid,string created) {
    IntPtr p=OpenProcess(0x101000,false,pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if(p==IntPtr.Zero) {
      int code=Marshal.GetLastWin32Error();
      return code!=87 && code!=1168; // Unknown/access denied is not proof of exit.
    }
    try {
      if(Created(p)!=created) return false;
      // A terminated process can keep its PID/creation time while another
      // process holds a handle. Its signaled state is the actual liveness test.
      uint state=WaitForSingleObject(p,0);
      if(state==0) return false;
      if(state==258) return true;
      throw new Win32Exception(Marshal.GetLastWin32Error());
    } catch { return true; }
    finally { CloseHandle(p); }
  }
  public RcSampleJob(string name,int pid,string created,bool recovering) {
    handle=OpenJobObjectW(0x1F003F,false,name);
    bool existing=handle!=IntPtr.Zero;
    if(!existing && recovering) throw new InvalidOperationException("Previously assigned sample Job is unavailable; no PID fallback was used");
    if(!existing) { handle=CreateJobObjectW(IntPtr.Zero,name); Check(handle!=IntPtr.Zero); }
    IntPtr p=OpenProcess(0x1141,false,pid);
    try {
      if(p==IntPtr.Zero) {
        if(existing && recovering) return;
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      if(Created(p)!=created) {
        if(existing && recovering) return; // Reused PID is unrelated: never attach/kill it.
        throw new InvalidOperationException("Gateway process creation time changed");
      }
      bool inside; Check(IsProcessInJob(p,handle,out inside));
      if(!inside) {
        if(existing && recovering) throw new InvalidOperationException("Original Gateway is not in the expected sample Job");
        Check(AssignProcessToJobObject(handle,p));
        IntPtr duplicate;
        Check(DuplicateHandle(GetCurrentProcess(),handle,p,out duplicate,0,false,2));
        // The Gateway keeps a handle so a failed supervisor can reopen this Job.
      }
    } catch { if(handle!=IntPtr.Zero) CloseHandle(handle); handle=IntPtr.Zero; throw; }
    finally { if(p!=IntPtr.Zero) CloseHandle(p); }
  }
  public Accounting Query() {
    Accounting info; Check(QueryInformationJobObject(handle,1,out info,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return info;
  }
  public void Terminate() { Check(TerminateJobObject(handle,1460)); }
  public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}
