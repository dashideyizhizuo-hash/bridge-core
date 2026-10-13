#!/usr/bin/env node
// Real macOS current-user launchd acceptance. Only a random, receipt-owned
// LaunchAgent and synthetic heartbeat process are created; no Host credentials.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureHostDirectory,writeHostFile} from '../src/host-files.mjs';
import {nativeServicePaths,preflightNativeService,installNativeService,nativeServiceStatus,
  stopNativeService,removeNativeService} from '../src/host-native-service.mjs';
import {persistenceStatus,setPersistenceAutostart} from '../src/host-persistence.mjs';
import {HOST_RUNTIME_FILES} from '../src/host-package-spec.mjs';
import {hostServicePaths,stageHostRuntime} from '../src/host-service.mjs';
import {readRuntimeStatus} from '../src/host-runtime-status.mjs';
import {maintainHost} from '../src/host-maintenance.mjs';

assert.equal(process.platform,'darwin','This acceptance requires real macOS; it must not report a platform skip as success');
assert.notEqual(process.getuid(),0,'The fixture must run as an ordinary user, never root');
const parent=realpathSync(tmpdir());
const root=realpathSync(mkdtempSync(join(parent,'bridge-launchd-test-')));
assert.equal(dirname(root),parent);
const configDir=join(root,'config 中文 $HOME %h');ensureHostDirectory(configDir);
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const options={env:{...process.env,XDG_DATA_HOME:join(root,'private-runtime-data')},stopAttempts:100,stopDelayMs:100};
const paths=nativeServicePaths(configDir,{home:homedir()});
const marker=join(configDir,'heartbeat.json');
const identityPath=join(configDir,'identity-test.json');
const identity=JSON.stringify({hostId:'fixture-'+randomBytes(12).toString('hex'),synthetic:true});
writeHostFile(identityPath,identity);
writeHostFile(join(configDir,'host.json'),JSON.stringify({host:{id:JSON.parse(identity).hostId}}));
ensureHostDirectory(join(configDir,'direct-exec'));
writeHostFile(join(configDir,'direct-exec/journal.json'),'{}\n');
const pidHistory=join(configDir,'fixture-pids.jsonl');
function runtime(version){
  const source=join(root,'source-'+version);mkdirSync(source,{mode:0o700});
  for(const file of HOST_RUNTIME_FILES){const target=join(source,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(join(repository,file),target);}
  writeFileSync(join(source,'bin/bridge-host-daemon.mjs'),`import {readFileSync,writeFileSync,renameSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntimeReporter} from '../src/host-runtime-status.mjs';
const config=process.argv[3],output=join(config,'heartbeat.json');
const identity=JSON.parse(readFileSync(join(config,'identity-test.json'),'utf8'));
const report=createRuntimeReporter({configDir:config,daemonPath:fileURLToPath(import.meta.url)});
appendFileSync(join(config,'fixture-pids.jsonl'),JSON.stringify({pid:process.pid,uid:process.getuid(),config})+'\\n',{mode:0o600});
let sequence=0;function beat(){writeFileSync(output+'.tmp',JSON.stringify({pid:process.pid,uid:process.getuid(),config,identity,version:${JSON.stringify(version)},sequence:++sequence,at:Date.now()}),{mode:0o600});renameSync(output+'.tmp',output);report({phase:'ready'});}
beat();setInterval(beat,200);
`);
  return {source,daemonPath:stageHostRuntime(hostServicePaths(configDir,options),{sourceRoot:source})};
}
const runtimeA=runtime('A'),runtimeB=runtime('B'),daemonPath=runtimeA.daemonPath;
const seen=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function heartbeat({differentPid,afterSequence}={}){
  for(let attempt=0;attempt<100;attempt++){
    if(existsSync(marker)){
      const record=JSON.parse(readFileSync(marker,'utf8'));
      assert.equal(record.uid,process.getuid());assert.equal(record.config,configDir);
      assert.deepEqual(record.identity,JSON.parse(identity));
      assert.ok(Number.isSafeInteger(record.pid)&&record.pid>1);
      if(record.pid!==differentPid&&(afterSequence===undefined||record.sequence>afterSequence)&&Date.now()-record.at<5000&&alive(record.pid)){
        seen.add(record.pid);return record;
      }
    }
    await delay(200);
  }
  throw Error('Synthetic LaunchAgent heartbeat did not arrive');
}
async function stopped(pid){
  for(let attempt=0;attempt<100;attempt++){if(!alive(pid))return;await delay(100);}
  throw Error('Owned synthetic daemon did not stop');
}
let failure,cleanupComplete=false,ownedInstallationStarted=false,phase='preflight';
try{
  assert.equal(existsSync(paths.unitPath),false,'Never replace an existing LaunchAgent');
  assert.equal(existsSync(paths.receiptPath),false,'Never replace an existing receipt');
  // GUI bootstrap availability is mandatory: no foreground/mock fallback here.
  preflightNativeService(paths);
  assert.equal(nativeServiceStatus(paths).installed,false);
  phase='install';
  ownedInstallationStarted=true;
  assert.equal((await installNativeService(paths,{daemonPath,startupStatus:()=>readRuntimeStatus(configDir)})).active,true);
  const first=await heartbeat();
  phase='idempotent-reinstall';
  await installNativeService(paths,{daemonPath});
  assert.equal((await heartbeat({afterSequence:first.sequence})).pid,first.pid);
  assert.equal(readFileSync(identityPath,'utf8'),identity);
  phase='autostart-off-running';
  let setting=setPersistenceAutostart(configDir,false);
  assert.equal(setting.autostart.enabled,false);assert.equal(setting.active,true);
  let observed=await heartbeat({afterSequence:first.sequence});assert.equal(observed.pid,first.pid);
  assert.equal(persistenceStatus(configDir).autostart.enabled,false);
  phase='autostart-on-running';
  setting=setPersistenceAutostart(configDir,true);
  assert.equal(setting.autostart.enabled,true);assert.equal(setting.active,true);
  assert.equal((await heartbeat({afterSequence:observed.sequence})).pid,first.pid);
  phase='stop';
  assert.equal(stopNativeService(paths).credentialsRetained,true);await stopped(first.pid);
  assert.equal(nativeServiceStatus(paths).active,false);
  assert.equal(readFileSync(identityPath,'utf8'),identity);
  phase='autostart-on-stopped';
  setting=setPersistenceAutostart(configDir,true);
  assert.equal(setting.autostart.enabled,true);assert.equal(setting.active,false);
  await delay(500);assert.equal(nativeServiceStatus(paths).active,false);
  phase='resume';
  await installNativeService(paths,{daemonPath});
  const resumed=await heartbeat({differentPid:first.pid});assert.notEqual(resumed.pid,first.pid);
  assert.equal(readFileSync(identityPath,'utf8'),identity);
  phase='upgrade-running-autostart-off';
  setPersistenceAutostart(configDir,false);
  await maintainHost(configDir,'upgrade',{...options,sourceRoot:runtimeB.source});
  const upgraded=await heartbeat({differentPid:resumed.pid});assert.equal(upgraded.version,'B');
  await stopped(resumed.pid);
  setting=persistenceStatus(configDir);assert.equal(setting.active,true);assert.equal(setting.autostart.enabled,false);
  assert.equal(readRuntimeStatus(configDir).daemonPath,runtimeB.daemonPath);
  phase='rollback-running-autostart-off';
  await maintainHost(configDir,'rollback',options);
  const rolled=await heartbeat({differentPid:upgraded.pid});assert.equal(rolled.version,'A');
  await stopped(upgraded.pid);
  setting=persistenceStatus(configDir);assert.equal(setting.active,true);assert.equal(setting.autostart.enabled,false);
  assert.equal(readRuntimeStatus(configDir).daemonPath,runtimeA.daemonPath);
  phase='upgrade-stopped-autostart-on';
  stopNativeService(paths);await stopped(rolled.pid);setPersistenceAutostart(configDir,true);
  await maintainHost(configDir,'upgrade',{...options,sourceRoot:runtimeB.source});
  setting=persistenceStatus(configDir);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);
  assert.equal(JSON.parse(readFileSync(paths.receiptPath,'utf8')).daemonPath,runtimeB.daemonPath);
  phase='rollback-stopped-autostart-on';
  await maintainHost(configDir,'rollback',options);
  setting=persistenceStatus(configDir);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);
  assert.equal(JSON.parse(readFileSync(paths.receiptPath,'utf8')).daemonPath,runtimeA.daemonPath);
  assert.equal(readFileSync(identityPath,'utf8'),identity);
  assert.equal(readFileSync(join(configDir,'direct-exec/journal.json'),'utf8'),'{}\n');
  phase='verified';
}catch(error){failure=error;}
finally{
  try{
    // Removal itself revalidates the exact receipt/plist. Never use broad labels,
    // pkill, another user's domain, or a privileged launchctl operation.
    if(ownedInstallationStarted&&existsSync(paths.receiptPath))removeNativeService(paths);
    if(ownedInstallationStarted&&existsSync(pidHistory))for(const line of readFileSync(pidHistory,'utf8').trim().split('\n')){
      const record=JSON.parse(line);assert.equal(record.config,configDir);assert.equal(record.uid,process.getuid());
      assert.ok(Number.isSafeInteger(record.pid)&&record.pid>1);seen.add(record.pid);
    }
    for(const pid of seen)await stopped(pid);
    assert.equal(existsSync(paths.unitPath),false,'Owned fixture plist must be removed');
    assert.equal(existsSync(paths.receiptPath),false,'Owned fixture receipt must be removed');
    assert.equal(nativeServiceStatus(paths).loaded,false,'Owned fixture must be unloaded');
    if(ownedInstallationStarted){rmSync(root,{recursive:true,force:true});cleanupComplete=true;}
  }catch(error){failure??=error;}
}
const evidence={node:process.version,platform:process.platform,realLaunchdUserService:!failure,ordinaryUser:true,
  literalSpecialCharacterPaths:!failure,idempotentInstall:!failure,stopAndResume:!failure,
  autostartIndependentOfActivity:!failure,identityRetained:!failure,maintenanceRunningDisabled:!failure,
  maintenanceStoppedEnabled:!failure,upgradeAndRollback:!failure,journalRetained:!failure,cleanupComplete,
  productionHostUsed:false,productionCredentialsUsed:false,loginLogoutTest:false,rebootTest:false,
  ...(failure?{failedPhase:phase,errorCode:failure.code??'ACCEPTANCE_FAILED',message:failure.message}: {})};
const output=join(repository,'dist/host-preview/launchd-verification.json');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(failure)throw failure;
