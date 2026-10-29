// Native AppContainer isolation with pinned filesystem identities and one ACL journal.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

partial class WindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr Sid, Capabilities; public uint Count, Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateIsolatedProcess(string app,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileInfo info);

  sealed class Pins : IDisposable {
    Dictionary<string,IntPtr> handles=new Dictionary<string,IntPtr>(StringComparer.OrdinalIgnoreCase);
    public string Pin(string file) {
      file=Path.GetFullPath(file);
      string parent=Path.GetDirectoryName(file.TrimEnd(Path.DirectorySeparatorChar));
      if(parent!=null && !String.Equals(parent,file,StringComparison.OrdinalIgnoreCase)) Pin(parent);
      IntPtr handle;
      if(!handles.TryGetValue(file,out handle)) {
        // No FILE_SHARE_DELETE: neither this object nor a pinned ancestor may
        // be renamed/replaced while privileged ACL operations use its pathname.
        handle=CreateFile(file,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        handles.Add(file,handle);
      }
      FileInfo info; Check(GetFileInformationByHandle(handle,out info));
      if((info.Attributes&0x400)!=0) throw new Exception("Sandbox paths cannot contain reparse points");
      return info.Volume+":"+info.IndexHigh+":"+info.IndexLow;
    }
    public void Dispose() { foreach(var handle in handles.Values) CloseHandle(handle); handles.Clear(); }
  }
  sealed class Sandbox : IDisposable {
    string name="mawf-"+Guid.NewGuid().ToString("N"), journal;
    IntPtr sid=IntPtr.Zero; Mutex mutex; bool owned; Pins pins=new Pins();
    Dictionary<string,object> original=new Dictionary<string,object>(StringComparer.OrdinalIgnoreCase);
    public IntPtr Sid { get { return sid; } }
    static string LockName() { return "Global\\mawf-acl-"+WindowsIdentity.GetCurrent().User.Value; }
    static FileSystemSecurity ReadAcl(string file) { return Directory.Exists(file)?(FileSystemSecurity)Directory.GetAccessControl(file,AccessControlSections.Access):File.GetAccessControl(file,AccessControlSections.Access); }
    static void WriteAcl(string file,FileSystemSecurity acl) {
      if(acl is DirectorySecurity) Directory.SetAccessControl(file,(DirectorySecurity)acl); else File.SetAccessControl(file,(FileSecurity)acl);
    }
    void Remember(string file) {
      file=Path.GetFullPath(file); if(original.ContainsKey(file)) return;
      string identity=pins.Pin(file);
      original[file]=new Dictionary<string,object>{{"identity",identity},{"directory",Directory.Exists(file)},{"sddl",ReadAcl(file).GetSecurityDescriptorSddlForm(AccessControlSections.Access)}};
      string temporary=journal+".new";
      File.WriteAllText(temporary,new JavaScriptSerializer().Serialize(new { profile=name, paths=original }),new UTF8Encoding(false));
      if(File.Exists(journal)) File.Replace(temporary,journal,null); else File.Move(temporary,journal);
    }
    static void Restore(string file,Pins pinned) {
      var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
      var paths=(Dictionary<string,object>)data["paths"];
      // Verify every identity before restoring any descriptor. Never follow a
      // replacement directory/junction left at the old pathname after a crash.
      foreach(var entry in paths) {
        var old=(Dictionary<string,object>)entry.Value;
        if(pinned.Pin(entry.Key)!=(string)old["identity"]) throw new Exception("Sandbox ACL restore refused: directory identity changed");
      }
      foreach(var entry in paths) {
        var old=(Dictionary<string,object>)entry.Value;
        FileSystemSecurity acl=(bool)old["directory"]?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();
        acl.SetSecurityDescriptorSddlForm((string)old["sddl"],AccessControlSections.Access); WriteAcl(entry.Key,acl);
      }
      int hr=DeleteAppContainerProfile((string)data["profile"]);
      if(hr<0 && hr!=unchecked((int)0x80070002) && hr!=unchecked((int)0x80070003)) Marshal.ThrowExceptionForHR(hr);
      File.Delete(file);
    }
    public static void Recover(Dictionary<string,object> policy) {
      using(var gate=new Mutex(false,LockName())) using(var pinned=new Pins()) {
        bool held=false;
        try {
          try { held=gate.WaitOne(30000); } catch(AbandonedMutexException) { held=true; }
          if(!held) throw new Exception("Sandbox ACL recovery lock timed out");
          string directory=(string)policy["journalDirectory"]; pinned.Pin(directory);
          foreach(string file in Directory.GetFiles(directory,"*.acl.json")) Restore(file,pinned);
        } finally { if(held) gate.ReleaseMutex(); }
      }
    }
    public Sandbox(Dictionary<string,object> policy,long deadline) {
      try {
        mutex=new Mutex(false,LockName());
        int wait=(int)Math.Max(0,Math.Min(30000,deadline-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        try { owned=mutex.WaitOne(wait); } catch(AbandonedMutexException) { owned=true; }
        if(!owned || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>=deadline) throw new Exception("Sandbox deadline expired while waiting for ACL lock");
        string directory=(string)policy["journalDirectory"]; pins.Pin(directory);
        foreach(string file in Directory.GetFiles(directory,"*.acl.json")) Restore(file,pins);
        journal=Path.Combine(directory,name+".acl.json");
        int hr=CreateAppContainerProfile(name,name,"MAWF isolated shell",IntPtr.Zero,0,out sid); if(hr<0) Marshal.ThrowExceptionForHR(hr);
        foreach(string key in new[]{"read","write","denyWrite"}) foreach(string file in (ArrayList)policy[key]) Remember(file);
        var identity=new SecurityIdentifier(sid);
        foreach(string file in (ArrayList)policy["read"]) Grant(file,identity,FileSystemRights.ReadAndExecute);
        foreach(string file in (ArrayList)policy["write"]) Grant(file,identity,FileSystemRights.Modify);
        foreach(string file in (ArrayList)policy["denyWrite"]) Seal(file,identity);
      } catch { Dispose(); throw; }
    }
    void Grant(string file,SecurityIdentifier identity,FileSystemRights rights) {
      bool directory=Directory.Exists(file);
      var rule=new FileSystemAccessRule(identity,rights,directory?InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit:InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow);
      var acl=ReadAcl(file); acl.AddAccessRule(rule); WriteAcl(file,acl);
    }
    void Seal(string file,SecurityIdentifier identity) {
      // Package SID DENY ACEs are ignored by the AppContainer access check.
      // Materialize inherited ACEs first, then remove this launch's write grant.
      var acl=ReadAcl(file); acl.SetAccessRuleProtection(true,true); WriteAcl(file,acl); acl=ReadAcl(file);
      foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) if(rule.IdentityReference.Equals(identity)) acl.RemoveAccessRuleSpecific(rule);
      WriteAcl(file,acl); Grant(file,identity,FileSystemRights.ReadAndExecute);
    }
    public void Dispose() {
      try {
        if(journal!=null && File.Exists(journal)) Restore(journal,pins);
        else if(sid!=IntPtr.Zero) DeleteAppContainerProfile(name);
      } finally {
        if(sid!=IntPtr.Zero) { FreeSid(sid); sid=IntPtr.Zero; }
        pins.Dispose();
        if(owned) { owned=false; mutex.ReleaseMutex(); } if(mutex!=null) { mutex.Dispose(); mutex=null; }
      }
    }
  }
  static void StartInJob(string executable,StringBuilder command,string cwd,Startup startup,IntPtr job,IntPtr sid,Dictionary<string,object> environment,out ProcessInfo process) {
    IntPtr size=IntPtr.Zero,attributes=IntPtr.Zero,capabilities=IntPtr.Zero,env=IntPtr.Zero,jobs=IntPtr.Zero;
    try {
      int count=sid==IntPtr.Zero?1:2;
      InitializeProcThreadAttributeList(IntPtr.Zero,count,0,ref size);
      attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,count,0,ref size));
      if(sid!=IntPtr.Zero) {
        var cap=new SecurityCapabilities(); cap.Sid=sid;
        capabilities=Marshal.AllocHGlobal(Marshal.SizeOf(cap)); Marshal.StructureToPtr(cap,capabilities,false);
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),capabilities,new IntPtr(Marshal.SizeOf(cap)),IntPtr.Zero,IntPtr.Zero));
      }
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var si=new StartupEx(); si.Startup=startup; si.Startup.cb=Marshal.SizeOf(si); si.Attributes=attributes;
      if(environment!=null) {
        var variables=new List<string>(); foreach(var pair in environment) variables.Add(pair.Key+"="+pair.Value);
        variables.Sort(StringComparer.OrdinalIgnoreCase); env=Marshal.StringToHGlobalUni(String.Join("\0",variables.ToArray())+"\0\0");
      }
      Check(CreateIsolatedProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref si,out process));
    } finally {
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if(capabilities!=IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
      if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
    }
  }
}
