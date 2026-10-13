#!/usr/bin/env node
// Actual current-user Windows maintenance, isolated synthetic daemons only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {HOST_RUNTIME_FILES} from '../src/host-package-spec.mjs';
import {hostServicePaths,stageHostRuntime} from '../src/host-service.mjs';
import {nativeServicePaths,nativeServiceStatus,installNativeService,stopNativeService,taskAccountSidPowerShell} from '../src/host-native-service.mjs';
import {readRuntimeStatus} from '../src/host-runtime-status.mjs';
import {ensureHostDirectory,writeHostFile} from '../src/host-files.mjs';
import {hostPowerShell} from '../src/host-platform.mjs';
import {windowsAction} from '../src/host-windows-action.mjs';
import {persistenceStatus,setPersistenceAutostart} from '../src/host-persistence.mjs';
import {maintainHost} from '../src/host-maintenance.mjs';

assert.equal(process.platform,'win32','Run this acceptance only on native Windows');
const principal=hostPowerShell(`$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($i);@{sid=$i.User.Value;elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress`,{});
assert.equal(principal.elevated,false,'Run as a normal non-elevated user; this test never elevates');
const parent=realpathSync(process.env.BRIDGE_NATIVE_TEST_ROOT ?? tmpdir());
const root=realpathSync(mkdtempSync(join(parent,'bridge-maintenance-test-')));
assert.ok(dirname(root)===parent && root.startsWith(join(parent,'bridge-maintenance-test-')));
const config=join(root,'config 中文 $HOME %h');ensureHostDirectory(config);
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const paths=nativeServicePaths(config),knownSpecs=[],seen=new Set();
const options={env:{},startupAttempts:12,startupDelayMs:100,stopAttempts:80,stopDelayMs:100};
let originalFailure,cleanupComplete=false,phase='prepare';
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
function recordPid() {
  const path=join(config,'fixture-marker.json');
  if(!existsSync(path))return null;
  const value=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(value.config,config);assert.equal(value.user,userInfo().username);
  for(const pid of [value.pid,value.parent]){assert.ok(Number.isSafeInteger(pid)&&pid>0);seen.add(pid);}
  return value;
}
function runtime(version) {
  const source=join(root,'source-'+version);mkdirSync(source);
  for(const file of HOST_RUNTIME_FILES){const target=join(source,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(repository,file),target);}
  const daemon=version==='broken' ? `throw new Error('isolated maintenance fixture startup failure');` : `
import {userInfo} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {writeHostFile} from '../src/host-files.mjs';import {createRuntimeReporter} from '../src/host-runtime-status.mjs';
import {existsSync,unlinkSync} from 'node:fs';
const config=process.argv[3];const marker=join(config,'fixture-marker.json');
if(existsSync(marker))unlinkSync(marker);
writeHostFile(marker,JSON.stringify({pid:process.pid,parent:process.ppid,user:userInfo().username,config,version:${JSON.stringify(version)}}));
const report=createRuntimeReporter({configDir:config,daemonPath:fileURLToPath(import.meta.url)});
report({phase:'ready'});setInterval(()=>report({phase:'ready'}),1000);
`;
  writeFileSync(join(source,'bin/bridge-host-daemon.mjs'),daemon);
  const daemonPath=stageHostRuntime(hostServicePaths(config,options),{sourceRoot:source});
  const spec={schemaVersion:1,adapter:paths.adapter,name:paths.name,configDir:config,nodePath:process.execPath,daemonPath,sid:principal.sid};
  spec.action=windowsAction(spec);spec.marker='Bridge Host '+createHash('sha256').update(JSON.stringify(spec)).digest('hex');knownSpecs.push(spec);
  return {source,daemonPath};
}
const cleanupScript=`
function Conflict($field='fixture'){ @{failure='HOST_SERVICE_CONFLICT';field=$field}|ConvertTo-Json -Compress;exit }
${taskAccountSidPowerShell}
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect();$folder=$svc.GetFolder('\\')
$task=$null;try{$task=$folder.GetTask($d.name)}catch{if($_.Exception.HResult -ne -2147024894 -and $_.Exception.HResult -ne -2147216625){throw}}
if($null -eq $task){@{absent=$true}|ConvertTo-Json -Compress;exit}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$def=$task.Definition
$spec=@($d.specs|Where-Object {$_.marker -ceq $def.RegistrationInfo.Description})
if($spec.Count -ne 1){Conflict 'marker'};$spec=$spec[0]
if($spec.sid -cne $sid -or $spec.name -cne $d.name -or $spec.configDir -cne $d.configDir -or $spec.adapter -cne 'windows-task'){Conflict 'identity'}
if((AccountSid $def.Principal.UserId) -cne $sid -or $def.Principal.LogonType -ne 3 -or $def.Principal.RunLevel -ne 0 -or $def.Actions.Count -ne 1 -or $def.Triggers.Count -ne 1){Conflict 'principal'}
$a=$def.Actions.Item(1);$t=$def.Triggers.Item(1)
if($a.Type -ne 0 -or $a.Path -cne $spec.action.path -or $a.Arguments -cne $spec.action.arguments -or $a.WorkingDirectory -cne $d.configDir -or $t.Type -ne 9 -or (AccountSid $t.UserId) -cne $sid){Conflict 'action'}
$task.Enabled=$false;$task.Stop(0)
for($i=0;$i -lt 100 -and $task.GetInstances(0).Count -gt 0;$i++){Start-Sleep -Milliseconds 100}
if($task.GetInstances(0).Count -gt 0){Conflict 'stillRunning'}
$folder.DeleteTask($d.name,0);@{removed=$true}|ConvertTo-Json -Compress
`;
try {
  assert.equal(nativeServiceStatus(paths).installed,false,'Never touch a pre-existing task');
  const a=runtime('A'),b=runtime('B'),broken=runtime('broken');
  writeHostFile(join(config,'host.json'),JSON.stringify({host:{id:'host-isolated-maintenance-fixture'}}));
  writeHostFile(join(config,'direct-runner.env'),'SYNTHETIC_FIXTURE_ONLY=not-a-credential\n');
  ensureHostDirectory(join(config,'direct-exec'));writeHostFile(join(config,'direct-exec/journal.json'),'{}\n');
  const identity=readFileSync(join(config,'host.json'),'utf8'),journal=readFileSync(join(config,'direct-exec/journal.json'),'utf8');
  phase='install-A';
  await installNativeService(paths,{...options,daemonPath:a.daemonPath,startupStatus:()=>readRuntimeStatus(config)});
  const first=recordPid();assert.equal(first.version,'A');assert.ok(alive(first.pid));
  phase='autostart-off-while-running';
  let setting=setPersistenceAutostart(config,false,options);assert.equal(setting.active,true);assert.equal(setting.autostart.enabled,false);assert.equal(recordPid().pid,first.pid);assert.ok(alive(first.pid));
  phase='disabled-trigger-is-not-autostart';
  const spec=knownSpecs.find(value=>value.daemonPath===a.daemonPath);
  const triggerScript=`
function Conflict($field='fixture'){ @{failure='HOST_SERVICE_CONFLICT';field=$field}|ConvertTo-Json -Compress;exit }
${taskAccountSidPowerShell}
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect();$folder=$svc.GetFolder('\\');$task=$folder.GetTask($d.spec.name);$def=$task.Definition
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($d.spec.sid -cne $sid -or $def.RegistrationInfo.Description -cne $d.spec.marker -or (AccountSid $def.Principal.UserId) -cne $sid -or $def.Principal.LogonType -ne 3 -or $def.Principal.RunLevel -ne 0 -or $def.Triggers.Count -ne 1 -or $def.Actions.Count -ne 1){Conflict 'fixture'}
$a=$def.Actions.Item(1);$t=$def.Triggers.Item(1)
if($a.Path -cne $d.spec.action.path -or $a.Arguments -cne $d.spec.action.arguments -or $a.WorkingDirectory -cne $d.spec.configDir -or $t.Type -ne 9 -or (AccountSid $t.UserId) -cne $sid){Conflict 'action'}
$t.Enabled=[bool]$d.enabled
[void]$folder.RegisterTaskDefinition($d.spec.name,$def,4,$sid,$null,3,$null)
@{triggerEnabled=$t.Enabled}|ConvertTo-Json -Compress
`;
  hostPowerShell(triggerScript,{spec,enabled:false});
  try {
    assert.throws(()=>persistenceStatus(config,options),error=>error.code==='HOST_SERVICE_CONFLICT');
    assert.throws(()=>setPersistenceAutostart(config,true,options),error=>error.code==='HOST_SERVICE_CONFLICT');
    assert.ok(alive(first.pid));
  } finally {hostPowerShell(triggerScript,{spec,enabled:true});}
  assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='upgrade-B';await maintainHost(config,'upgrade',{...options,sourceRoot:b.source});
  const second=recordPid();assert.equal(second.version,'B');assert.notEqual(second.pid,first.pid);assert.equal(alive(first.pid),false);assert.equal(alive(first.parent),false);
  assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='failed-upgrade-restores-B';
  await assert.rejects(maintainHost(config,'upgrade',{...options,sourceRoot:broken.source}),error=>error.code==='HOST_MAINTENANCE_FAILED');
  const restored=recordPid();assert.equal(restored.version,'B');assert.notEqual(restored.pid,second.pid);assert.equal(alive(second.pid),false);
  assert.equal(readRuntimeStatus(config).daemonPath,b.daemonPath);assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='rollback-A';await maintainHost(config,'rollback',options);
  const rolled=recordPid();assert.equal(rolled.version,'A');assert.equal(alive(restored.pid),false);
  assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='autostart-on-while-stopped';stopNativeService(paths);
  for(let i=0;i<80 && alive(rolled.pid);i++)await delay(100);
  assert.equal(alive(rolled.pid),false);
  setting=setPersistenceAutostart(config,true,options);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);
  await maintainHost(config,'upgrade',{...options,sourceRoot:b.source});
  setting=persistenceStatus(config,options);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);assert.equal(alive(recordPid().pid),false);
  await maintainHost(config,'rollback',options);
  setting=persistenceStatus(config,options);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);assert.equal(alive(recordPid().pid),false);
  phase='uninstall';await maintainHost(config,'uninstall',options);
  assert.equal(nativeServiceStatus(paths).installed,false);assert.equal(alive(rolled.pid),false);assert.equal(alive(rolled.parent),false);
  assert.equal(readFileSync(join(config,'host.json'),'utf8'),identity);assert.equal(readFileSync(join(config,'direct-exec/journal.json'),'utf8'),journal);
  assert.ok(existsSync(join(config,'direct-runner.env')));
  console.log(JSON.stringify({actualWindowsMaintenance:true,node:process.version,nonElevatedUser:true,upgrade:true,failedUpgradeRestoresPrevious:true,explicitRollback:true,uninstall:true,previousDaemonAndLauncherExit:true,identityAndJournalRetained:true,independentAutostart:true,disabledTriggerRejected:true,autostartPreservedAcrossMaintenance:true,productionHostModified:false,productionLogin:false,rebootTest:false}));
} catch(error) {originalFailure=error;console.error(JSON.stringify({fixturePhase:phase,errorCode:error.code ?? error.name}));throw error;}
finally {
  try {
    recordPid();
    // The OS action is checked against a finite set of synthetic runtimes from this invocation.
    const result=hostPowerShell(cleanupScript,{name:paths.name,configDir:config,specs:knownSpecs});
    assert.ok(result.removed || result.absent);
    for(let i=0;i<100 && [...seen].some(alive);i++)await delay(100);
    assert.equal([...seen].some(alive),false,'Do not remove fixture files while an owned process is live');
    const rel=relative(parent,root);assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && dirname(root)===parent);
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    assert.equal(existsSync(root),false);cleanupComplete=true;
    console.log(JSON.stringify({actualWindowsMaintenanceCleanup:true}));
  } catch(error) {console.error(JSON.stringify({fixtureCleanupFailed:true,retainedFixture:root,code:error.code ?? error.name}));if(!originalFailure)throw error;}
}
assert.equal(cleanupComplete,true);
