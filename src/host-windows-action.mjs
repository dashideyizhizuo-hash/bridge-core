import { powershellPath } from './host-platform.mjs';
import { assertBridge } from './errors.mjs';

export function windowsArgument(value) {
  assertBridge(typeof value==='string' && !/[\x00\r\n]/.test(value),'HOST_SERVICE_INVALID','Invalid Windows argument');
  return '"'+value.replace(/(\\*)"/g,(_,slashes)=>slashes+slashes+'\\"').replace(/\\+$/g,slashes=>slashes+slashes)+'"';
}

// Keep a private kill-on-close Job handle for the launcher's lifetime. Assign
// the launcher before spawning Node so descendants inherit membership without
// a start-then-assign race. Windows closes the non-inheritable handle even when
// Task Scheduler forcibly terminates PowerShell; no Node child is orphaned.
const JOB_SOURCE=String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BridgeHostJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr ownedJob=IntPtr.Zero;
  public static void Attach() {
    if(ownedJob!=IntPtr.Zero) return;
    // NULL attributes = non-inheritable handle; the children cannot keep the
    // job alive after its owning launcher is terminated.
    IntPtr job=CreateJobObjectW(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      ExtendedLimits limits=new ExtendedLimits();
      limits.Basic.Flags=0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if(!AssignProcessToJobObject(job,GetCurrentProcess()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      // Intentionally lifetime-owned, not a transient SafeHandle/GC local.
      // Process exit closes it; closing it earlier would terminate ourselves.
      ownedJob=job;job=IntPtr.Zero;
    } finally { if(job!=IntPtr.Zero) CloseHandle(job); }
  }
}
`;

const CONSOLE_SOURCE=String.raw`
public static class BridgeHostConsole {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  static extern bool FreeConsole();
  public static void Detach() {
    if(!FreeConsole()) throw new System.ComponentModel.Win32Exception(
      System.Runtime.InteropServices.Marshal.GetLastWin32Error());
  }
  public static void Drain(System.IO.Stream stream) {
    // Closing an inherited pipe is expected during retries. Observe the task's
    // failure without waiting for descendants that may retain its write end.
    var copy=stream.CopyToAsync(System.IO.Stream.Null,8192);
    copy.ContinueWith(task => task.Exception, System.Threading.CancellationToken.None,
      System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted |
      System.Threading.Tasks.TaskContinuationOptions.ExecuteSynchronously,
      System.Threading.Tasks.TaskScheduler.Default);
  }
}
`;

export function windowsAction(spec) {
  assertBridge(spec.detachedConsole===undefined || spec.detachedConsole===true,
    'HOST_SERVICE_INVALID','Unknown Windows console mode');
  const detached=spec.detachedConsole===true;
  const diagnostic=message=>detached ? `try {[Console]::Error.WriteLine('${message}')} catch {}` :
    `[Console]::Error.WriteLine('${message}')`;
  const data=Buffer.from(JSON.stringify({nodePath:spec.nodePath,configDir:spec.configDir,
    arguments:[spec.daemonPath,'--config-dir',spec.configDir].map(windowsArgument).join(' ')})).toString('base64');
  // Task Scheduler did not retry exit code 1 in native acceptance despite
  // RestartCount/RestartInterval. Keep the child under the same live task and
  // retry failed exits here; no detached process, new task, credential or shell.
  const script=String.raw`
$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Add-Type -TypeDefinition @'
${JOB_SOURCE}${detached ? CONSOLE_SOURCE : ''}
'@ -ErrorAction Stop
${detached ? '[BridgeHostConsole]::Detach()\n' : ''}[BridgeHostJob]::Attach()
$p=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))
$s=[Diagnostics.ProcessStartInfo]::new()
$s.FileName=$p.nodePath
$s.Arguments=$p.arguments
$s.WorkingDirectory=$p.configDir
$s.UseShellExecute=$false
$s.CreateNoWindow=$true
${detached ? '$s.RedirectStandardOutput=$true\n$s.RedirectStandardError=$true\n' : ''}$backoffMs=5000
while($true){
  $child=$null
${detached ? '  $outStream=$null\n  $errStream=$null\n' : ''}  $watch=[Diagnostics.Stopwatch]::StartNew()
  try {
    $child=[Diagnostics.Process]::Start($s)
${detached ? '    $outStream=$child.StandardOutput.BaseStream\n    $errStream=$child.StandardError.BaseStream\n    [BridgeHostConsole]::Drain($outStream)\n    [BridgeHostConsole]::Drain($errStream)\n' : ''}    $child.WaitForExit()
    $code=$child.ExitCode
  } catch {
    $code=1
    ${diagnostic('Bridge Host child could not start; retrying without re-pairing.')}
  } finally {
${detached ? '    if($null -ne $outStream){try {$outStream.Dispose()} catch {}}\n    if($null -ne $errStream){try {$errStream.Dispose()} catch {}}\n' : ''}    if($null -ne $child){$child.Dispose()}
    $watch.Stop()
  }
  if($code -eq 0){exit 0}
  ${diagnostic('Bridge Host child exited abnormally; retrying without re-pairing.')}
  if($watch.Elapsed.TotalSeconds -ge 60){$backoffMs=5000}
  [Threading.Thread]::Sleep($backoffMs)
  $backoffMs=[Math]::Min(30000,$backoffMs*2)
}
`;
  return {path:powershellPath(),arguments:'-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64')};
}
