// Shell-only AppContainer boundary. No network capabilities are granted.
// Per-launch ACL entries are removed on normal exit; the unique SID is never reused.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

partial class WindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities {
    public IntPtr Sid, Capabilities; public uint Count, Reserved;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateIsolatedProcess(string app,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);

  sealed class Sandbox : IDisposable {
    string name="mawf-"+Guid.NewGuid().ToString("N"); IntPtr sid=IntPtr.Zero;
    List<KeyValuePair<string,FileSystemAccessRule>> rules=new List<KeyValuePair<string,FileSystemAccessRule>>();
    List<KeyValuePair<string,string>> sealedAcls=new List<KeyValuePair<string,string>>();
    Dictionary<string,string> original=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    Mutex mutex; bool owned; string journal;
    static string LockName(string workspace) {
      // Interpreter/package read grants can overlap even for different workspaces.
      // Serialize ACL transactions for this user across all Windows sessions.
      return "Global\\mawf-acl-"+WindowsIdentity.GetCurrent().User.Value;
    }
    void Remember(string dir) {
      if(original.ContainsKey(dir)) return;
      original[dir]=Directory.GetAccessControl(dir,AccessControlSections.Access).GetSecurityDescriptorSddlForm(AccessControlSections.Access);
      File.WriteAllText(journal,new JavaScriptSerializer().Serialize(new { profile=name, paths=original }),Encoding.UTF8);
    }
    static void Restore(string file) {
      var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
      var paths=(Dictionary<string,object>)data["paths"];
      foreach(var entry in paths) {
        var acl=new DirectorySecurity(); acl.SetSecurityDescriptorSddlForm((string)entry.Value,AccessControlSections.Access); Directory.SetAccessControl(entry.Key,acl);
      }
      DeleteAppContainerProfile((string)data["profile"]); File.Delete(file);
    }
    public static void Recover(Dictionary<string,object> policy) {
      string root=(string)((ArrayList)policy["write"])[0], directory=(string)policy["journalDirectory"];
      using(var gate=new Mutex(false,LockName(root))) {
        bool held=false;
        try {
          try { held=gate.WaitOne(30000); } catch(AbandonedMutexException) { held=true; }
          if(!held) throw new Exception("Sandbox ACL recovery lock timed out");
          foreach(string file in Directory.GetFiles(directory,"*.acl.json")) Restore(file);
        } finally { if(held) gate.ReleaseMutex(); }
      }
    }
    public Sandbox(Dictionary<string,object> policy) {
      try {
        string root=(string)((ArrayList)policy["write"])[0], directory=(string)policy["journalDirectory"];
        mutex=new Mutex(false,LockName(root));
        try { owned=mutex.WaitOne(30000); } catch(AbandonedMutexException) { owned=true; }
        if(!owned) throw new Exception("Sandbox ACL lock timed out");
        foreach(string file in Directory.GetFiles(directory,"*.acl.json")) Restore(file);
        journal=Path.Combine(directory,name+".acl.json");
        int hr=CreateAppContainerProfile(name,name,"MAWF isolated shell",IntPtr.Zero,0,out sid);
        if(hr<0) Marshal.ThrowExceptionForHR(hr);
        var identity=new SecurityIdentifier(sid);
        // Snapshot all roots before any inheritable grant can alter a nested root.
        foreach(string key in new[]{"read","write","denyWrite"}) foreach(string dir in (ArrayList)policy[key]) Remember(dir);
        foreach(string dir in (ArrayList)policy["read"]) Grant(dir,identity,FileSystemRights.ReadAndExecute,AccessControlType.Allow);
        foreach(string dir in (ArrayList)policy["write"]) Grant(dir,identity,FileSystemRights.Modify,AccessControlType.Allow);
        // AppContainer package checks ignore DENY ACEs. Cut inheritance on a
        // protected subtree and remove this launch's write grant instead.
        foreach(string dir in (ArrayList)policy["denyWrite"]) Seal(dir,identity);
      } catch { Dispose(); throw; }
    }
    void Seal(string dir,SecurityIdentifier identity) {
      if(!Directory.Exists(dir) || (File.GetAttributes(dir)&FileAttributes.ReparsePoint)!=0) throw new Exception("Invalid sealed directory");
      Remember(dir);
      var acl=Directory.GetAccessControl(dir,AccessControlSections.Access);
      sealedAcls.Add(new KeyValuePair<string,string>(dir,acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access)));
      acl.SetAccessRuleProtection(true,true);
      Directory.SetAccessControl(dir,acl);
      acl=Directory.GetAccessControl(dir,AccessControlSections.Access);
      foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
        if(rule.IdentityReference.Equals(identity)) acl.RemoveAccessRuleSpecific(rule);
      }
      acl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      Directory.SetAccessControl(dir,acl);
    }
    void Grant(string dir,SecurityIdentifier identity,FileSystemRights rights,AccessControlType type) {
      if(!Directory.Exists(dir)) throw new Exception("Sandbox grant directory is missing: "+dir);
      if((File.GetAttributes(dir)&FileAttributes.ReparsePoint)!=0) throw new Exception("Sandbox grant cannot be a reparse point");
      Remember(dir);
      var rule=new FileSystemAccessRule(identity,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,type);
      var acl=Directory.GetAccessControl(dir,AccessControlSections.Access); acl.AddAccessRule(rule);
      Directory.SetAccessControl(dir,acl); rules.Add(new KeyValuePair<string,FileSystemAccessRule>(dir,rule));
    }
    public void Start(string executable,StringBuilder command,string cwd,Startup startup,Dictionary<string,object> environment,out ProcessInfo process) {
      IntPtr size=IntPtr.Zero,attributes=IntPtr.Zero,capabilities=IntPtr.Zero,env=IntPtr.Zero;
      try {
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
        var cap=new SecurityCapabilities(); cap.Sid=sid;
        capabilities=Marshal.AllocHGlobal(Marshal.SizeOf(cap)); Marshal.StructureToPtr(cap,capabilities,false);
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),capabilities,new IntPtr(Marshal.SizeOf(cap)),IntPtr.Zero,IntPtr.Zero));
        var si=new StartupEx(); si.Startup=startup; si.Startup.cb=Marshal.SizeOf(si); si.Attributes=attributes;
        var variables=new List<string>(); foreach(var pair in environment) variables.Add(pair.Key+"="+pair.Value);
        variables.Sort(StringComparer.OrdinalIgnoreCase);
        env=Marshal.StringToHGlobalUni(String.Join("\0",variables.ToArray())+"\0\0");
        Check(CreateIsolatedProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref si,out process));
      } finally {
        if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
        if(capabilities!=IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
        if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
      }
    }
    public void Dispose() {
      for(int i=sealedAcls.Count-1;i>=0;i--) {
        var entry=sealedAcls[i];
        try { var acl=new DirectorySecurity(); acl.SetSecurityDescriptorSddlForm(entry.Value,AccessControlSections.Access); Directory.SetAccessControl(entry.Key,acl); }
        catch(Exception e) { Console.Error.WriteLine("SANDBOX_ACL_RESTORE_FAILED: "+e.Message); }
      }
      sealedAcls.Clear();
      foreach(var entry in rules) {
        try { var acl=Directory.GetAccessControl(entry.Key,AccessControlSections.Access); acl.RemoveAccessRuleSpecific(entry.Value); Directory.SetAccessControl(entry.Key,acl); }
        catch(Exception e) { Console.Error.WriteLine("SANDBOX_ACL_CLEANUP_FAILED: "+e.Message); }
      }
      rules.Clear();
      if(sid!=IntPtr.Zero) { FreeSid(sid); sid=IntPtr.Zero; DeleteAppContainerProfile(name); }
      try { if(journal!=null && File.Exists(journal)) Restore(journal); }
      finally { if(owned) { owned=false; mutex.ReleaseMutex(); } if(mutex!=null) { mutex.Dispose(); mutex=null; } }
    }
  }
}
