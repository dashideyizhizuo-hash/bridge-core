#!/usr/bin/env node
// Real native user-task lifecycle on a disposable CI VM. No production account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeServicePaths, preflightNativeService, nativeServiceStatus, installNativeService, startNativeService, stopNativeService, setNativeServiceAutostart, taskAccountSidPowerShell } from '../src/host-native-service.mjs';
import { ensureHostDirectory, writeHostFile } from '../src/host-files.mjs';
import { hostPowerShell } from '../src/host-platform.mjs';
import { windowsAction } from '../src/host-windows-action.mjs';

assert.ok(['win32','darwin'].includes(process.platform));
const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-native-test-')));
const configDir=join(root,'config $HOME %h & 中文');ensureHostDirectory(configDir);
const daemonPath=join(configDir,'heartbeat daemon.mjs');
const marker=join(configDir,'heartbeat.json');
const paths=nativeServicePaths(configDir);
const identity='host-native-lifecycle-fixture';
writeHostFile(join(configDir,'identity.json'),JSON.stringify({hostId:identity}));
writeHostFile(daemonPath,`import {writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {userInfo} from 'node:os';const config=process.argv[3];const file=join(config,'heartbeat.json');writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,parent:process.ppid,user:userInfo().username,config}),{mode:0o600});renameSync(file+'.tmp',file);setInterval(()=>{},1000);`);
let owned=false,installAttempted=false,originalFailure,phase='preflight';
let installer,installerError,survivesInstallerExit=false;
async function stopInstaller() {
  if(!installer || !Number.isInteger(installer.pid))return;
  if(installer.exitCode===null && installer.signalCode===null) {
    assert.equal(installer.kill('SIGKILL'),true,'The exact fixture installer must accept termination');
  }
  for(let n=0;n<100 && installer.exitCode===null && installer.signalCode===null;n++)await delay(100);
  assert.ok(installer.exitCode!==null || installer.signalCode!==null,'The fixture installer must exit within its cleanup bound');
  assert.equal(alive(installer.pid),false,'The owned installer process must be gone');
}
async function installFromHiddenHelper() {
  const helper=join(configDir,'installer helper.mjs'),ready=join(configDir,'installer-ready.json');
  const moduleUrl=pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)),'../src/host-native-service.mjs')).href;
  const filesUrl=pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)),'../src/host-files.mjs')).href;
  // This one-off installer uses the actual implementation and owns no daemon.
  // Keep it alive after readiness so termination is an observed test boundary.
  writeHostFile(helper,`import {installNativeService,nativeServicePaths} from ${JSON.stringify(moduleUrl)};
import {writeHostFile} from ${JSON.stringify(filesUrl)};
import {renameSync} from 'node:fs';
await installNativeService(nativeServicePaths(${JSON.stringify(configDir)}),{daemonPath:${JSON.stringify(daemonPath)}});
writeHostFile(${JSON.stringify(ready+'.tmp')},JSON.stringify({ready:true,pid:process.pid}));
renameSync(${JSON.stringify(ready+'.tmp')},${JSON.stringify(ready)});
setInterval(()=>{},1000);
`);
  installer=spawn(process.execPath,[helper],{windowsHide:true,stdio:'ignore',shell:false});
  installer.on('error',error=>{installerError=error;});
  const deadline=Date.now()+30_000;
  while(Date.now()<deadline) {
    assert.equal(installerError,undefined,'The hidden fixture installer must start');
    if(existsSync(ready)) {
      const value=JSON.parse(readFileSync(ready,'utf8'));
      assert.deepEqual(value,{ready:true,pid:installer.pid});
      assert.equal(alive(installer.pid),true,'Installer must still be running at task readiness');
      return nativeServiceStatus(paths);
    }
    assert.equal(installer.exitCode,null,'The hidden installer must publish readiness before exiting');
    assert.equal(installer.signalCode,null,'The hidden installer must not exit before readiness');
    await delay(100);
  }
  throw new Error('Hidden fixture installer did not become ready within its bound');
}
const cleanupTaskScript=`
$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$folder=$s.GetFolder('\\')
$task=$null;try{$task=$folder.GetTask($d.name)}catch{if($_.Exception.HResult -ne -2147024894 -and $_.Exception.HResult -ne -2147216625){throw}}
if($null -eq $task){@{found=$false;removed=$false}|ConvertTo-Json -Compress;exit}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($d.name -cne $d.spec.name -or $d.spec.sid -cne $sid -or $d.spec.configDir -cne $d.configDir -or
   $d.spec.adapter -cne 'windows-task' -or $d.spec.schemaVersion -ne 1){@{failure='HOST_SERVICE_CONFLICT';field='fixtureIdentity'}|ConvertTo-Json -Compress;exit}
$def=$task.Definition;$currentName=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$separator=$currentName.LastIndexOf([char]92);$currentShort=if($separator -ge 0){$currentName.Substring($separator+1)}else{$currentName}
function FixtureIdentity($value){return ($value -ceq $sid -or $value -ceq $currentName -or $value -ieq $currentShort)}
if($def.RegistrationInfo.Description -cne $d.spec.marker -or $def.Principal.LogonType -ne 3 -or $def.Principal.RunLevel -ne 0 -or
   -not (FixtureIdentity $def.Principal.UserId) -or $def.Actions.Count -ne 1 -or $def.Triggers.Count -ne 1){@{failure='HOST_SERVICE_CONFLICT';field='fixtureOwnership'}|ConvertTo-Json -Compress;exit}
$a=$def.Actions.Item(1);$trigger=$def.Triggers.Item(1)
if($a.Type -ne 0 -or $a.Path -cne $d.spec.action.path -or $a.Arguments -cne $d.spec.action.arguments -or
   $a.WorkingDirectory -cne $d.spec.configDir -or $trigger.Type -ne 9 -or -not (FixtureIdentity $trigger.UserId)){
  @{failure='HOST_SERVICE_CONFLICT';field='fixtureAction'}|ConvertTo-Json -Compress;exit
}
$task.Enabled=$false;if($task.State -eq 4){$task.Stop(0)}
for($i=0;$i -lt 100 -and $task.GetInstances(0).Count -gt 0;$i++){Start-Sleep -Milliseconds 100}
if($task.GetInstances(0).Count -gt 0){@{failure='HOST_SERVICE_FAILED';field='fixtureStop'}|ConvertTo-Json -Compress;exit}
$folder.DeleteTask($d.name,0);@{found=$true;removed=$true}|ConvertTo-Json -Compress
`;
function taskDiagnostics(label,pids={}) {
  if(process.platform!=='win32') return;
  const result=hostPowerShell(`$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.GetFolder('\\').GetTask($d.name);$x=$t.Definition.Settings;@{state=$t.State;lastResult=$t.LastTaskResult;instances=$t.GetInstances(0).Count;restartCount=$x.RestartCount;restartInterval=$x.RestartInterval}|ConvertTo-Json -Compress`,{name:paths.name});
  console.log(JSON.stringify({fixturePhase:label,...result,parentAlive:pids.parent ? alive(pids.parent) : null,childAlive:pids.pid ? alive(pids.pid) : null}));
}
function windowsContract({legacyDisabled=false}={}) {
  const spec=JSON.parse(readFileSync(paths.receiptPath,'utf8'));
  return hostPowerShell(`
function Conflict($field='fixtureOwnership') {@{failure='HOST_SERVICE_CONFLICT';field=$field}|ConvertTo-Json -Compress;exit}
${taskAccountSidPowerShell}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$folder=$s.GetFolder('\\');$task=$folder.GetTask($d.name)
$def=$task.Definition;$a=$def.Actions.Item(1);$t=$def.Triggers.Item(1)
if($d.spec.name -cne $d.name -or $d.spec.sid -cne $sid -or $def.RegistrationInfo.Description -cne $d.spec.marker -or
  (AccountSid $def.Principal.UserId) -cne $sid -or $def.Principal.LogonType -ne 3 -or $def.Principal.RunLevel -ne 0 -or
  $def.Actions.Count -ne 1 -or $def.Triggers.Count -ne 1 -or $a.Type -ne 0 -or $a.Path -cne $d.spec.action.path -or
  $a.Arguments -cne $d.spec.action.arguments -or $a.WorkingDirectory -cne $d.spec.configDir -or
  $t.Type -ne 9 -or (AccountSid $t.UserId) -cne $sid){Conflict}
if($d.legacyDisabled){
  $t.Enabled=$true;$def.Settings.Enabled=$false
  $task=$folder.RegisterTaskDefinition($d.name,$def,20,$sid,$null,3,$null)
  $def=$task.Definition;$a=$def.Actions.Item(1);$t=$def.Triggers.Item(1)
}
@{security=$task.GetSecurityDescriptor(7);marker=$def.RegistrationInfo.Description;
  principal=@{sid=(AccountSid $def.Principal.UserId);logonType=$def.Principal.LogonType;runLevel=$def.Principal.RunLevel};
  action=@{path=$a.Path;arguments=$a.Arguments;workingDirectory=$a.WorkingDirectory};
  actionCount=$def.Actions.Count;triggerCount=$def.Triggers.Count;triggerType=$t.Type;triggerSid=(AccountSid $t.UserId)
}|ConvertTo-Json -Compress -Depth 5
`,{name:paths.name,spec,legacyDisabled});
}
async function heartbeat(previousPid,{timeoutMs=15_000}={}) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end) {
    if(existsSync(marker)) {
      const value=JSON.parse(readFileSync(marker,'utf8'));
      if(previousPid===undefined || value.pid!==previousPid) {
        assert.equal(value.user,userInfo().username);assert.equal(value.config,configDir);return value;
      }
    }
    await delay(200);
  }
  throw new Error('Native task did not produce its scoped heartbeat');
}
function alive(pid) {try{process.kill(pid,0);return true;}catch{return false;}}
function assertDetachedSupervisor(parent) {
  const result=hostPowerShell(`
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class ConsoleProbe {
  [DllImport("kernel32.dll",SetLastError=true)]public static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll",SetLastError=true)]public static extern bool FreeConsole();
}
'@
[void][ConsoleProbe]::FreeConsole()
$attached=[ConsoleProbe]::AttachConsole([uint32]$d.parent)
$attachError=if($attached){0}else{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
if($attached){[void][ConsoleProbe]::FreeConsole()}
@{attached=$attached;attachError=$attachError}|ConvertTo-Json -Compress
`,{parent});
  assert.equal(result.attached,false,'The background supervisor must not remain attached to a terminal console');
  assert.equal(result.attachError,6,'The owned parent must have no console, not an inaccessible console');
}
async function stopped(pids) {
  // macOS's parent is launchd itself, not an owned wrapper; never wait/kill it.
  const ownedPids=[pids.pid,...(process.platform==='win32' ? [pids.parent] : [])].filter(Number.isInteger);
  for(let n=0;n<100 && ownedPids.some(alive);n++) await delay(100);
  for(const pid of ownedPids) assert.equal(alive(pid),false,'Owned native processes must exit after stop');
}
try {
  assert.equal(nativeServiceStatus(paths).installed,false,'Must not touch a pre-existing task');
  preflightNativeService(paths);
  phase='initial-start';
  installAttempted=true;
  const started=process.platform==='win32' ? await installFromHiddenHelper() : await installNativeService(paths,{daemonPath});owned=true;
  assert.equal(started.active,true);const first=await heartbeat();
  if(process.platform==='win32') {
    assertDetachedSupervisor(first.parent);
    assert.notEqual(first.pid,installer.pid);assert.notEqual(first.parent,installer.pid);
    phase='installer-exit';await stopInstaller();
    for(let n=0;n<3;n++) {
      await delay(500);
      const same=await heartbeat();
      assert.equal(same.pid,first.pid,'Daemon PID must survive the installer exit');
      assert.equal(same.parent,first.parent,'Scheduled supervisor PID must survive the installer exit');
      assert.equal(alive(first.pid),true);assert.equal(alive(first.parent),true);
    }
    assert.equal(nativeServiceStatus(paths).active,true);
    survivesInstallerExit=true;
  }
  await installNativeService(paths,{daemonPath});assert.equal((await heartbeat()).pid,first.pid);
  const contract=process.platform==='win32' ? windowsContract() : null;
  phase='autostart-toggle-running';
  for(const enabled of [false,true]) {
    const state=setNativeServiceAutostart(paths,enabled);
    assert.equal(state.active,true);assert.equal(state.autostartEnabled,enabled);
    assert.equal((await heartbeat()).pid,first.pid);assert.equal(alive(first.parent),true);
    if(contract)assert.deepEqual(windowsContract(),contract,'Autostart edits must preserve task ACL, action and principal');
  }
  taskDiagnostics('before-crash',first);
  phase='crash-restart';
  process.kill(first.pid,'SIGKILL');
  if(process.platform==='win32'){await delay(1500);taskDiagnostics('after-crash',first);}
  const restarted=await heartbeat(first.pid,{timeoutMs:100_000});
  assert.equal(nativeServiceStatus(paths).active,true);
  phase='stop';stopNativeService(paths);
  await stopped(restarted);
  assert.equal(nativeServiceStatus(paths).active,false);
  assert.deepEqual(JSON.parse(readFileSync(join(configDir,'identity.json'),'utf8')),{hostId:identity});
  if(process.platform==='win32') {
    phase='legacy-disabled-normalization';
    assert.deepEqual(windowsContract({legacyDisabled:true}),contract);
    const legacy=nativeServiceStatus(paths);assert.equal(legacy.active,false);assert.equal(legacy.autostartEnabled,false);
  } else {
    // A disabled/unloaded launchd job needs an explicit persisted enable before
    // bootstrap. Native demand start must not hide that OS limitation.
    assert.throws(()=>startNativeService(paths),error=>error.code==='HOST_SERVICE_UNAVAILABLE');
    setNativeServiceAutostart(paths,true);
  }
  phase='demand-resume';
  const demand=startNativeService(paths);assert.equal(demand.autostartEnabled,process.platform==='darwin');
  const resumed=await heartbeat(restarted.pid);
  assert.notEqual(resumed.pid,restarted.pid);
  assert.equal(nativeServiceStatus(paths).active,true);
  startNativeService(paths);assert.equal((await heartbeat()).pid,resumed.pid);
  if(contract) {
    assert.deepEqual(windowsContract(),contract,'Demand start must preserve task ACL, action and principal');
    assertDetachedSupervisor(resumed.parent);
  }
  const evidence={platform:process.platform,node:process.version,adapter:paths.adapter,
    actualNativeTask:true,currentUserIdentity:true,metacharacterAndUnicodePaths:true,
    idempotentStart:true,crashRestart:true,stopTerminatesChild:true,resumeRetainsIdentity:true,
    autostartTogglePreservesProcess:true,
    ...(process.platform==='win32'?{supervisorDetachedFromConsole:true,survivesInstallerExit,legacyDisabledNormalization:true,
      demandStartPreservesAutostartOff:true,unchangedTaskAclActionAndPrincipal:true}:{}),
    productionLogin:false,productionHostModified:false,logoffOrRebootTest:false,
    windowsPrivilegeNote:process.platform==='win32' ? 'Task configured InteractiveToken/LUA, not LocalSystem; hosted CI may itself be administrator' : undefined};
  const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const output=join(repository,'dist/host-preview/native-service-verification.json');mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  originalFailure=error;
  if(owned || (installAttempted && existsSync(marker))) try{taskDiagnostics('failure-'+phase,existsSync(marker) ? JSON.parse(readFileSync(marker,'utf8')) : {});}catch(diagnostic){console.error(JSON.stringify({fixtureDiagnosticError:diagnostic.code ?? 'FAILED'}));}
  throw error;
} finally {
  let installerCleanupFailure;
  try {await stopInstaller();}catch(error){installerCleanupFailure=error;}
  try {
    if(process.platform==='win32' && installAttempted && existsSync(paths.receiptPath)) {
      const spec=JSON.parse(readFileSync(paths.receiptPath,'utf8'));
      const current=hostPowerShell(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;@{sid=$sid}|ConvertTo-Json -Compress`,{});
      const expected={schemaVersion:1,adapter:paths.adapter,name:paths.name,configDir:paths.configDir,
        nodePath:process.execPath,daemonPath,sid:current.sid,detachedConsole:true};
      expected.action=windowsAction(expected);
      expected.marker='Bridge Host '+createHash('sha256').update(JSON.stringify(expected)).digest('hex');
      assert.deepEqual(spec,expected,'Fixture receipt must match the harness-owned paths, identity and action before task cleanup');
      const cleanup=hostPowerShell(cleanupTaskScript,{name:paths.name,configDir:configDir,spec});
      const latest=existsSync(marker) ? JSON.parse(readFileSync(marker,'utf8')) : {};
      await stopped(latest);
      assert.equal(cleanup.removed,true,'The exact test-owned Windows task must be removed');
    } else if(owned || existsSync(paths.receiptPath)) {
      const latest=existsSync(marker) ? JSON.parse(readFileSync(marker,'utf8')) : {};
      try {
        stopNativeService(paths);
        await stopped(latest);
      } finally {
        if(process.platform==='win32') {
          hostPowerShell(`$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$s.GetFolder('\\').DeleteTask($d.name,0);@{removed=$true}|ConvertTo-Json -Compress`,{name:paths.name});
        } else if(paths.unitPath) rmSync(paths.unitPath,{force:true});
      }
    }
    if(installerCleanupFailure)throw installerCleanupFailure;
    // Node 22's synchronous rimraf misses retries when the first directory
    // removal returns EBUSY. Its async path applies the same bounded backoff
    // to that case too. Process/task ownership and exit are checked above;
    // a persistently locked directory still fails CI instead of being ignored.
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    assert.equal(existsSync(root),false,'The owned native fixture must be fully removed');
    console.log(JSON.stringify({nativeFixtureCleanup:true}));
  } catch(cleanupError) {
    if(!originalFailure) throw cleanupError;
    console.error(JSON.stringify({fixtureCleanupError:cleanupError.code ?? 'NATIVE_CLEANUP_FAILED'}));
  }
}
