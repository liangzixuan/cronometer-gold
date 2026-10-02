using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.IO;
using Microsoft.Win32.SafeHandles;

// Atomic job creation and console ownership serve finite commands and bounded headless sessions.
// HANDLE_LIST deliberately excludes the controller control pipe and the private job handle.
public sealed class WindowsOwnedProcess : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Accounting {
        public long UserTime,KernelTime,PeriodUserTime,PeriodKernelTime;
        public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
        public ushort show,reservedSize; public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits info,uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint length,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint length,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetConsoleProcessList([Out] uint[] ids,uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint signal,uint group);

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public uint Length; public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SecurityAttributes attributes,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);

    readonly int outputLimit;
    long outputBytes;
    volatile bool outputOverflow, outputFailure;
    FileStream stdoutStream,stderrStream;
    Task stdoutTask,stderrTask;
    static readonly object outputGate=new object();
    static void Emit(char kind,string value) {
        lock(outputGate) { Console.Out.WriteLine(kind+":"+value); Console.Out.Flush(); }
    }
    Task Drain(FileStream stream,char kind) {
        return Task.Run(()=> {
            try {
                byte[] buffer=new byte[4096]; int count;
                while((count=stream.Read(buffer,0,buffer.Length))!=0) {
                    if(Interlocked.Add(ref outputBytes,count)>outputLimit) { outputOverflow=true; continue; }
                    Emit(kind,Convert.ToBase64String(buffer,0,count));
                }
            } catch { outputFailure=true; }
        });
    }
    static void Close(ref IntPtr handle) {
        if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; }
    }
    IntPtr job, process; Timer watchdog; readonly object gate=new object();
    static int initialConsoleStepUsed, ownerCreationStarted;
    public uint Pid { get; private set; }
    public volatile bool WatchdogFired;
    public bool CtrlCDelivered { get; private set; }
    static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
    public static void RequireNoConsole() {
        uint[] ids=new uint[1]; uint count=GetConsoleProcessList(ids,1);
        if(count!=0) throw new InvalidOperationException("Use a dedicated CreateNoWindow owner host; do not detach a user console.");
        int error=Marshal.GetLastWin32Error();
        if(error!=6) throw new Win32Exception(error,"GetConsoleProcessList must establish no attached console");
    }
    public static bool InitializeControllerConsole() {
        if(Interlocked.CompareExchange(ref ownerCreationStarted,0,0)!=0 || Interlocked.Exchange(ref initialConsoleStepUsed,1)!=0)
            throw new InvalidOperationException("Controller console initialization is allowed once.");
        uint[] ids=new uint[2]; uint count=GetConsoleProcessList(ids,2);
        if(count==0) { RequireNoConsole(); return false; }
        if(count!=1 || ids[0]!=(uint)Environment.ProcessId)
            throw new InvalidOperationException("Refusing to detach a shared console.");
        Check(FreeConsole(),"Release initial self-only controller console");
        RequireNoConsole();
        return true;
    }
    static string Quote(string value) {
        if(value.IndexOf('\0')>=0) throw new ArgumentException("NUL in argument");
        var b=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            b.Append('\\', c=='\"' ? slashes*2+1 : slashes); b.Append(c); slashes=0;
        }
        b.Append('\\',slashes*2); return b.Append('"').ToString();
    }
    public WindowsOwnedProcess(string executable,string[] arguments,string cwd,IDictionary<string,string> environment,int maximumMilliseconds,int maximumOutputBytes,bool session) {
        if(maximumMilliseconds<100 || maximumMilliseconds>(session ? 3600000 : 240000)) throw new ArgumentOutOfRangeException("maximumMilliseconds");
        if(maximumOutputBytes<1 || maximumOutputBytes>20000000) throw new ArgumentOutOfRangeException("maximumOutputBytes");
        outputLimit=maximumOutputBytes;
        Interlocked.Exchange(ref ownerCreationStarted,1);
        RequireNoConsole();
        job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero); Check(job!=IntPtr.Zero,"CreateJobObject");
        IntPtr attributes=IntPtr.Zero,jobValue=IntPtr.Zero,env=IntPtr.Zero,handleList=IntPtr.Zero;
        IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero; bool initialized=false; ProcessInfo child=new ProcessInfo();
        try {
            var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE only; no breakaway.
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>()),"SetInformationJobObject");
            IntPtr size=IntPtr.Zero;
            bool sized=InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
            if(sized || Marshal.GetLastWin32Error()!=122 || size==IntPtr.Zero) throw new InvalidOperationException("Attribute sizing failed");
            attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,2,0,ref size),"InitializeProcThreadAttributeList"); initialized=true;
            jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Set atomic creation job list");
            var pipeAttributes=new SecurityAttributes { Length=(uint)Marshal.SizeOf<SecurityAttributes>(),Inherit=true };
            Check(CreatePipe(out inputRead,out inputWrite,ref pipeAttributes,0),"Create stdin pipe");
            Check(CreatePipe(out outputRead,out outputWrite,ref pipeAttributes,0),"Create stdout pipe");
            Check(CreatePipe(out errorRead,out errorWrite,ref pipeAttributes,0),"Create stderr pipe");
            Check(SetHandleInformation(outputRead,1,0),"Keep stdout reader private");
            Check(SetHandleInformation(errorRead,1,0),"Keep stderr reader private");
            Close(ref inputWrite); // Commands and headless sessions receive immediate stdin EOF.
            handleList=Marshal.AllocHGlobal(3*IntPtr.Size);
            Marshal.WriteIntPtr(handleList,0,inputRead);
            Marshal.WriteIntPtr(handleList,IntPtr.Size,outputWrite);
            Marshal.WriteIntPtr(handleList,2*IntPtr.Size,errorWrite);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handleList,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Restrict inherited handles");
            var values=environment.OrderBy(pair=>pair.Key,StringComparer.OrdinalIgnoreCase).Select(pair=>{
                if(pair.Key.Length==0 || pair.Key.IndexOfAny(new[]{'=','\0'})>=0 || pair.Value.IndexOf('\0')>=0) throw new ArgumentException("Invalid environment");
                return pair.Key+"="+pair.Value;
            });
            env=Marshal.StringToHGlobalUni(string.Join("\0",values)+"\0\0");
            var startup=new StartupEx(); startup.Startup.cb=(uint)Marshal.SizeOf<StartupEx>();
            startup.Startup.flags=0x101;
            startup.Startup.input=inputRead; startup.Startup.output=outputWrite; startup.Startup.error=errorWrite; startup.Startup.show=0; startup.Attributes=attributes; // Hidden isolated console.
            string command=string.Join(" ",new[]{executable}.Concat(arguments).Select(Quote));
            // Atomic JOB_LIST closes the owner-death gap between creation and assignment.
            Check(CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x00080414,env,cwd,ref startup,out child),"CreateProcess with atomic job membership");
            process=child.Process; Pid=child.Pid;
            Check(IsProcessInJob(process,job,out bool inside),"IsProcessInJob"); if(!inside) throw new InvalidOperationException("Child escaped creation job");
            Close(ref inputRead); Close(ref outputWrite); Close(ref errorWrite);
            stdoutStream=new FileStream(new SafeFileHandle(outputRead,true),FileAccess.Read,4096,false); outputRead=IntPtr.Zero;
            stderrStream=new FileStream(new SafeFileHandle(errorRead,true),FileAccess.Read,4096,false); errorRead=IntPtr.Zero;
            stdoutTask=Drain(stdoutStream,'O'); stderrTask=Drain(stderrStream,'E');
            Emit('S',Pid.ToString(System.Globalization.CultureInfo.InvariantCulture));
            watchdog=new Timer(_=>{ lock(gate) { if(job!=IntPtr.Zero) { WatchdogFired=true; TerminateJobObject(job,124); } } },null,maximumMilliseconds,Timeout.Infinite);
            if(ResumeThread(child.Thread)==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");
        } catch {
            if(job!=IntPtr.Zero) { TerminateJobObject(job,125); WaitEmpty(3000); }
            Dispose(); throw;
        }
        finally {
            Close(ref inputRead); Close(ref inputWrite);
            Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
            if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if(child.Thread!=IntPtr.Zero) CloseHandle(child.Thread);
            if(initialized) DeleteProcThreadAttributeList(attributes);
            if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if(jobValue!=IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
        }
    }
    public Accounting Count() { Check(QueryInformationJobObject(job,1,out Accounting info,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero),"Job accounting"); return info; }
    public uint[] ProcessIds() {
        const int capacity=128; int bytes=8+capacity*IntPtr.Size; IntPtr buffer=Marshal.AllocHGlobal(bytes);
        try {
            Check(QueryInformationJobObject(job,3,buffer,(uint)bytes,IntPtr.Zero),"Job process list");
            int assigned=Marshal.ReadInt32(buffer,0),count=Marshal.ReadInt32(buffer,4);
            if(count<0 || count>capacity || assigned!=count) throw new InvalidOperationException("Incomplete job process inventory");
            var ids=new uint[count]; for(int i=0;i<count;i++) ids[i]=checked((uint)Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64()); return ids;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    public uint RootExitCode() { Check(GetExitCodeProcess(process,out uint code),"GetExitCodeProcess"); return code; }
    public bool WaitEmpty(int milliseconds) {
        if(milliseconds<0 || milliseconds>30000) throw new ArgumentOutOfRangeException("milliseconds");
        var time=Stopwatch.StartNew(); do { if(Count().ActiveProcesses==0) return true; Thread.Sleep(25); } while(time.ElapsedMilliseconds<milliseconds); return Count().ActiveProcesses==0;
    }
    public bool SendConsoleCtrlCAndWaitLeader(int milliseconds) {
        if(milliseconds<0 || milliseconds>30000) throw new ArgumentOutOfRangeException("milliseconds");
        RequireNoConsole(); Check(AttachConsole(Pid),"Attach owned console");
        try {
            // AttachConsole resets handlers. Ignore Ctrl+C only in this owner, after attach.
            Check(SetConsoleCtrlHandler(IntPtr.Zero,true),"Ignore owner Ctrl+C");
            uint[] ids=new uint[128]; uint n=GetConsoleProcessList(ids,(uint)ids.Length);
            if(n==0 || n>ids.Length) throw new InvalidOperationException("Console inventory unavailable");
            var owned=new HashSet<uint>(ProcessIds()); owned.Add((uint)Environment.ProcessId);
            for(int i=0;i<n;i++) if(!owned.Contains(ids[i])) throw new InvalidOperationException("Unexpected process attached to owned console");
            Check(GenerateConsoleCtrlEvent(0,0),"Generate real Ctrl+C");
            CtrlCDelivered=true;
            // The fixture leader waits for its child. Detach before checking job zero because
            // the isolated console host can itself belong to the job while this owner attaches.
            return WaitForSingleObject(process,(uint)milliseconds)==0;
        } finally { Check(FreeConsole(),"Detach owned console"); }
    }
    public void StopAbnormally() { Check(TerminateJobObject(job,124),"Terminate owned job"); }
    public sealed class Result {
        public string reason="startup failure";
        public int status=-1;
        public bool activeZero,outputDrained,forcedCleanup,parentLost,watchdogFired;
        public bool ctrlCDelivered,leaderExitedAfterCtrlC;
        public uint pid;
    }
    public static string ReadRequestLine(TextReader reader) {
        var request=new StringBuilder();
        for(int i=0;i<=65536;i++) {
            int next=reader.Read();
            if(next<0) throw new InvalidOperationException("Controller request missing.");
            if(next==10) return request.ToString();
            request.Append((char)next);
        }
        throw new InvalidOperationException("Controller request exceeds limit.");
    }
    public static Result Run(string executable,string[] arguments,string cwd,IDictionary<string,string> environment,int timeoutMs,int maxOutputBytes,bool session,TextReader control) {
        var result=new Result();
        WindowsOwnedProcess owner=null;
        // This reader is the parent's non-inherited control pipe, not child stdin.
        var controlRead=Task.Run(()=>control.Read());
        var elapsed=Stopwatch.StartNew();
        long leaderExitedAt=-1;
        try {
            if(controlRead.IsCompleted) { result.reason="parent unavailable"; result.parentLost=true; result.activeZero=true; result.outputDrained=true; return result; }
            owner=new WindowsOwnedProcess(executable,arguments,cwd,environment,timeoutMs,maxOutputBytes,session);
            result.pid=owner.Pid;
            for(;;) {
                if(controlRead.IsCompleted) {
                    result.parentLost=controlRead.IsFaulted || controlRead.Result<0;
                    result.reason=result.parentLost ? "parent lost" : "cancelled";
                    break;
                }
                if(owner.outputOverflow) { result.reason="output limit exceeded"; break; }
                if(owner.outputFailure) { result.reason="output pipe failed"; break; }
                if(owner.WatchdogFired || elapsed.ElapsedMilliseconds>=timeoutMs) { result.reason="timeout"; break; }
                bool rootExited=WaitForSingleObject(owner.process,0)==0;
                if(rootExited && owner.Count().ActiveProcesses==0 && owner.stdoutTask.IsCompleted && owner.stderrTask.IsCompleted) {
                    result.status=checked((int)owner.RootExitCode());
                    result.reason=result.status==0 ? "completed" : "nonzero exit";
                    result.activeZero=true;
                    result.outputDrained=!owner.outputFailure && !owner.outputOverflow;
                    return result;
                }
                if(rootExited) {
                    if(leaderExitedAt<0) leaderExitedAt=elapsed.ElapsedMilliseconds;
                    if(elapsed.ElapsedMilliseconds-leaderExitedAt>=1000) { result.reason="lingering descendant or output"; break; }
                }
                Thread.Sleep(10);
            }
        } catch { result.reason="owner operation failed"; }
        finally {
            if(owner!=null) {
                try {
                    bool active=owner.Count().ActiveProcesses!=0;
                    if(active && result.reason=="cancelled" && WaitForSingleObject(owner.process,0)!=0) {
                        try { result.leaderExitedAfterCtrlC=owner.SendConsoleCtrlCAndWaitLeader(1000); } catch { }
                        active=!owner.WaitEmpty(1000);
                    }
                    if(active) { result.forcedCleanup=true; owner.StopAbnormally(); }
                    result.ctrlCDelivered=owner.CtrlCDelivered;
                    result.activeZero=owner.WaitEmpty(3000);
                    result.watchdogFired=owner.WatchdogFired;
                    if(result.watchdogFired) result.forcedCleanup=true;
                    result.outputDrained=Task.WaitAll(new[]{owner.stdoutTask,owner.stderrTask},2000) && !owner.outputFailure && !owner.outputOverflow;
                    if(WaitForSingleObject(owner.process,0)==0) result.status=unchecked((int)owner.RootExitCode());
                } catch { result.reason="cleanup could not be verified"; result.activeZero=false; }
                finally { owner.Dispose(); }
            }
        }
        return result;
    }
    public void Dispose() {
        lock(gate) {
            if(watchdog!=null) { watchdog.Dispose(); watchdog=null; }
            if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
            if(process!=IntPtr.Zero) { CloseHandle(process); process=IntPtr.Zero; }
            if(stdoutTask==null || stdoutTask.IsCompleted) stdoutStream?.Dispose();
            if(stderrTask==null || stderrTask.IsCompleted) stderrStream?.Dispose();
            // Unsettled readers stay owned by this finite controller; process exit closes them.

        }
    }
}
