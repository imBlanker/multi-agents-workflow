// Native Windows process-tree supervisor. No executable starts before it has
// entered a non-breakaway, kill-on-close Job Object. Built with inbox .NET 4.x.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Collections.Generic;
using System.Web.Script.Serialization;

partial class WindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessTime, PerJobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long a,b,c,d; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref Accounting info,int size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Identity(int pid) { using(var p=Process.GetProcessById(pid)) return p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); }
  static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') b.Append('\\',slashes*2+1).Append(c);
      else b.Append('\\',slashes).Append(c);
      slashes=0;
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  static bool Matches(int pid,string start) { try { return Identity(pid)==start; } catch { return false; } }
  static uint Count(IntPtr job) { var a=new Accounting(); Check(QueryInformationJobObject(job,1,ref a,Marshal.SizeOf(a),IntPtr.Zero)); return a.ActiveProcesses; }
  static int Run(Dictionary<string,object> r) {
    string name=(string)r["jobName"];
    if(!name.StartsWith("Local\\mawf-") || name.Length!=47) throw new Exception("Invalid job name");
    int parent=Convert.ToInt32(r["parentPid"]); string parentStart=(string)r["parentStart"];
    if(!Matches(parent,parentStart)) throw new Exception("Controller identity unavailable");
    IntPtr job=CreateJobObject(IntPtr.Zero,name);
    if(job==IntPtr.Zero) throw new Win32Exception();
    if(Marshal.GetLastWin32Error()==183) { CloseHandle(job); throw new Exception("Job already exists"); }
    var pi=new ProcessInfo(); Sandbox sandbox=null;
    try {
      var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)));
      var si=new Startup(); si.cb=Marshal.SizeOf(si); si.flags=0x100;
      si.stdin=GetStdHandle(-10); si.stdout=GetStdHandle(-11); si.stderr=GetStdHandle(-12);
      foreach(var h in new[]{si.stdin,si.stdout,si.stderr}) if(h!=IntPtr.Zero && h!=new IntPtr(-1)) Check(SetHandleInformation(h,1,1));
      var argv=(System.Collections.ArrayList)r["command"];
      var command=new StringBuilder(); foreach(string arg in argv) { if(command.Length>0) command.Append(' '); command.Append(Quote(arg)); }
      if(r.ContainsKey("sandbox")) {
        sandbox=new Sandbox((Dictionary<string,object>)r["sandbox"]);
        sandbox.Start((string)argv[0],command,(string)r["cwd"],si,(Dictionary<string,object>)r["childEnv"],out pi);
      } else Check(CreateProcess((string)argv[0],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,(string)r["cwd"],ref si,out pi));
      // A failed assignment must never resume the suspended process.
      Check(AssignProcessToJobObject(job,pi.process));
      if(ResumeThread(pi.thread)==0xffffffff) throw new Win32Exception();
      long deadline=Convert.ToInt64(r["deadlineUnixMs"]);
      bool interrupted=false;
      while(Count(job)>0) {
        if(!Matches(parent,parentStart) || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>=deadline) {
          interrupted=true;
          Check(TerminateJobObject(job,124));
        }
        System.Threading.Thread.Sleep(40);
      }
      uint code; Check(GetExitCodeProcess(pi.process,out code)); return interrupted ? 124 : unchecked((int)code);
    } finally {
      TerminateJobObject(job,125);
      if(pi.process!=IntPtr.Zero) { TerminateProcess(pi.process,125); CloseHandle(pi.process); }
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      CloseHandle(job);
      if(sandbox!=null) sandbox.Dispose();
    }
  }
  static int Main(string[] args) {
    try {
      Console.OutputEncoding=new UTF8Encoding(false);
      if(args[0]=="identity") { Console.WriteLine(Identity(int.Parse(args[1]))); return 0; }
      if(args[0]=="recover") { Sandbox.Recover(new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(args[1]))); return 0; }
      if(args[0]=="run") return Run(new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(args[1])));
      if(args[0]=="query" || args[0]=="stop") {
        // The exact helper incarnation owns the random job name; never signal a reused PID.
        bool alive=Matches(int.Parse(args[2]),args[3]);
        if(args[0]=="stop" && !alive) throw new Exception("Controller identity mismatch");
        IntPtr job=OpenJobObject(args[0]=="stop"? 8u:4u,false,args[1]);
        if(job==IntPtr.Zero) {
          if(Marshal.GetLastWin32Error()==2 && !alive) { Console.WriteLine("0"); return 0; }
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try { if(args[0]=="stop") Check(TerminateJobObject(job,130)); else Console.WriteLine(Count(job)); }
        finally { CloseHandle(job); }
        return 0;
      }
      throw new Exception("Unknown operation");
    } catch(Exception e) { Console.Error.WriteLine("WINDOWS_JOB_FAILED: "+e.GetType().Name+" "+(e is Win32Exception ? ((Win32Exception)e).NativeErrorCode : e.HResult)+" "+e.Message+" "+e.StackTrace); return 125; }
  }
}
