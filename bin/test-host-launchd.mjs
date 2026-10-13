#!/usr/bin/env node
// Real macOS current-user launchd acceptance. Only a random, receipt-owned
// LaunchAgent and synthetic heartbeat process are created; no Host credentials.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureHostDirectory,writeHostFile} from '../src/host-files.mjs';
import {nativeServicePaths,preflightNativeService,installNativeService,nativeServiceStatus,
  stopNativeService,removeNativeService} from '../src/host-native-service.mjs';
import {persistenceStatus,setPersistenceAutostart} from '../src/host-persistence.mjs';

assert.equal(process.platform,'darwin','This acceptance requires real macOS; it must not report a platform skip as success');
assert.notEqual(process.getuid(),0,'The fixture must run as an ordinary user, never root');
const parent=realpathSync(tmpdir());
const root=realpathSync(mkdtempSync(join(parent,'bridge-launchd-test-')));
assert.equal(dirname(root),parent);
const configDir=join(root,'config 中文 $HOME %h');ensureHostDirectory(configDir);
const daemonPath=join(root,'synthetic daemon 中文 $.mjs');
const paths=nativeServicePaths(configDir,{home:homedir()});
const marker=join(configDir,'heartbeat.json');
const identityPath=join(configDir,'identity-test.json');
const identity=JSON.stringify({hostId:'fixture-'+randomBytes(12).toString('hex'),synthetic:true});
writeHostFile(identityPath,identity);
writeHostFile(daemonPath,`import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
const config=process.argv[3],output=join(config,'heartbeat.json');
const identity=JSON.parse(readFileSync(join(config,'identity-test.json'),'utf8'));
let sequence=0;function beat(){writeFileSync(output+'.tmp',JSON.stringify({pid:process.pid,uid:process.getuid(),config,identity,sequence:++sequence,at:Date.now()}),{mode:0o600});renameSync(output+'.tmp',output);}
beat();setInterval(beat,200);
`);
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
let failure,cleanupComplete=false,phase='preflight';
try{
  assert.equal(existsSync(paths.unitPath),false,'Never replace an existing LaunchAgent');
  assert.equal(existsSync(paths.receiptPath),false,'Never replace an existing receipt');
  // GUI bootstrap availability is mandatory: no foreground/mock fallback here.
  preflightNativeService(paths);
  assert.equal(nativeServiceStatus(paths).installed,false);
  phase='install';
  assert.equal((await installNativeService(paths,{daemonPath})).active,true);
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
  phase='verified';
}catch(error){failure=error;}
finally{
  try{
    // Removal itself revalidates the exact receipt/plist. Never use broad labels,
    // pkill, another user's domain, or a privileged launchctl operation.
    if(existsSync(paths.receiptPath))removeNativeService(paths);
    for(const pid of seen)await stopped(pid);
    assert.equal(existsSync(paths.unitPath),false,'Owned fixture plist must be removed');
    assert.equal(existsSync(paths.receiptPath),false,'Owned fixture receipt must be removed');
    assert.equal(nativeServiceStatus(paths).loaded,false,'Owned fixture must be unloaded');
    rmSync(root,{recursive:true,force:true});cleanupComplete=true;
  }catch(error){failure??=error;}
}
const evidence={node:process.version,platform:process.platform,realLaunchdUserService:!failure,ordinaryUser:true,
  literalSpecialCharacterPaths:!failure,idempotentInstall:!failure,stopAndResume:!failure,
  autostartIndependentOfActivity:!failure,identityRetained:!failure,cleanupComplete,
  productionHostUsed:false,productionCredentialsUsed:false,loginLogoutTest:false,rebootTest:false,
  ...(failure?{failedPhase:phase,errorCode:failure.code??'ACCEPTANCE_FAILED',message:failure.message}: {})};
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(repository,'dist/host-preview/launchd-verification.json');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(failure)throw failure;
