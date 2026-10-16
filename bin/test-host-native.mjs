#!/usr/bin/env node
// Real native user-task lifecycle on a disposable CI VM. No production account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeServicePaths, preflightNativeService, nativeServiceStatus, installNativeService, stopNativeService } from '../src/host-native-service.mjs';
import { ensureHostDirectory, writeHostFile } from '../src/host-files.mjs';
import { hostPowerShell, powershellPath } from '../src/host-platform.mjs';
import { windowsAction } from '../src/host-windows-action.mjs';

assert.ok(['win32','darwin'].includes(process.platform));
const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-native-test-')));
const configDir=join(root,'config $HOME %h & 中文');ensureHostDirectory(configDir);
const daemonPath=join(configDir,'heartbeat daemon.mjs');
const marker=join(configDir,'heartbeat.json');
const paths=nativeServicePaths(configDir);
const identity='host-native-lifecycle-fixture';
writeHostFile(join(configDir,'identity.json'),JSON.stringify({hostId:identity}));
writeHostFile(daemonPath,`import {writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {userInfo} from 'node:os';const config=process.argv[3];const file=join(config,'heartbeat.json');writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,parent:process.ppid,user:userInfo().username,config,cwd:process.cwd()}),{mode:0o600});renameSync(file+'.tmp',file);setInterval(()=>{},1000);`);
let owned=false,installAttempted=false,originalFailure,phase='preflight';
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
$expectedWorkingDirectory=if($d.spec.action.PSObject.Properties.Name -ccontains 'workingDirectory'){$d.spec.action.workingDirectory}else{$d.spec.configDir}
if($a.Type -ne 0 -or $a.Path -cne $d.spec.action.path -or $a.Arguments -cne $d.spec.action.arguments -or
   $a.WorkingDirectory -cne $expectedWorkingDirectory -or $trigger.Type -ne 9 -or -not (FixtureIdentity $trigger.UserId)){
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
async function heartbeat(previousPid,{timeoutMs=15_000}={}) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end) {
    if(existsSync(marker)) {
      const value=JSON.parse(readFileSync(marker,'utf8'));
      if(previousPid===undefined || value.pid!==previousPid) {
        assert.equal(value.user,userInfo().username);assert.equal(value.config,configDir);
        assert.equal(value.cwd,configDir,'The Node child must retain its private configuration working directory');return value;
      }
    }
    await delay(200);
  }
  throw new Error('Native task did not produce its scoped heartbeat');
}
function alive(pid) {try{process.kill(pid,0);return true;}catch{return false;}}
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
  const started=await installNativeService(paths,{daemonPath});owned=true;
  assert.equal(started.active,true);const first=await heartbeat();
  if(process.platform==='win32') {
    const directory=hostPowerShell(`$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.GetFolder('\\').GetTask($d.name);@{workingDirectory=$t.Definition.Actions.Item(1).WorkingDirectory}|ConvertTo-Json -Compress`,{name:paths.name});
    assert.equal(directory.workingDirectory,win32.dirname(win32.dirname(win32.dirname(powershellPath()))),'The scheduler launcher must start in trusted System32');
  }
  await installNativeService(paths,{daemonPath});assert.equal((await heartbeat()).pid,first.pid);
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
  phase='resume';await installNativeService(paths,{daemonPath});const resumed=await heartbeat(restarted.pid);
  assert.notEqual(resumed.pid,restarted.pid);
  const evidence={platform:process.platform,node:process.version,adapter:paths.adapter,
    actualNativeTask:true,currentUserIdentity:true,metacharacterAndUnicodePaths:true,
    idempotentStart:true,crashRestart:true,stopTerminatesChild:true,resumeRetainsIdentity:true,
    privateNodeWorkingDirectory:true,...(process.platform==='win32'?{trustedSchedulerWorkingDirectory:true}:{}),
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
  try {
    if(process.platform==='win32' && installAttempted && existsSync(paths.receiptPath)) {
      const spec=JSON.parse(readFileSync(paths.receiptPath,'utf8'));
      const current=hostPowerShell(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;@{sid=$sid}|ConvertTo-Json -Compress`,{});
      const expected={schemaVersion:1,adapter:paths.adapter,name:paths.name,configDir:paths.configDir,
        nodePath:process.execPath,daemonPath,sid:current.sid};
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
