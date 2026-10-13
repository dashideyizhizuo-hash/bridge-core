#!/usr/bin/env node
// Real systemd USER maintenance with synthetic runtimes; never a production Host.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,existsSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {HOST_RUNTIME_FILES} from '../src/host-package-spec.mjs';
import {hostServicePaths,hostServiceUnit,stageHostRuntime,preflightHostService,hostServiceStatus,installHostService,stopHostService} from '../src/host-service.mjs';
import {readRuntimeStatus} from '../src/host-runtime-status.mjs';
import {ensureHostDirectory,readHostFile,writeHostFile} from '../src/host-files.mjs';
import {persistenceStatus,setPersistenceAutostart} from '../src/host-persistence.mjs';
import {maintainHost} from '../src/host-maintenance.mjs';

assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);
function systemctl(args,{allowInactive=false}={}) {
  const result=spawnSync('systemctl',['--user',...args],{encoding:'utf8',timeout:10_000,maxBuffer:16_384,stdio:['ignore','pipe','pipe']});
  assert.equal(result.error,undefined,result.error?.message);
  if(!allowInactive)assert.equal(result.status,0,`systemctl ${args[0]} failed: ${result.stderr}`);
  return result;
}
systemctl(['show-environment']); // Existing manager only; never provision or elevate.
const parent=realpathSync(tmpdir()),root=realpathSync(mkdtempSync(join(parent,'bridge-maintenance-linux-')));
const name=`bridge-host-test-${randomBytes(8).toString('hex')}.service`;
const config=join(root,'config 中文 ${HOME} %h $NAME');ensureHostDirectory(config);
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const options={env:{...process.env,XDG_DATA_HOME:join(root,'data')},home:homedir(),unitName:name,startupAttempts:30,startupDelayMs:100,stopAttempts:80,stopDelayMs:100};
const paths=hostServicePaths(config,options),knownUnits=new Set(),seen=new Set();
let originalFailure,phase='prepare',cleanupComplete=false;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
function recordPid() {
  const path=join(config,'fixture-marker.json');if(!existsSync(path))return null;
  const value=JSON.parse(readHostFile(path));assert.equal(value.config,config);assert.equal(value.uid,process.getuid());
  assert.equal(value.noNewPrivileges,true);assert.ok(Number.isSafeInteger(value.pid)&&value.pid>0);seen.add(value.pid);return value;
}
function runtime(version) {
  const source=join(root,'source-'+version);mkdirSync(source,{mode:0o700});
  for(const file of HOST_RUNTIME_FILES){const target=join(source,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(join(repository,file),target);}
  const daemon=version==='broken' ? `throw new Error('isolated maintenance fixture startup failure');` : `
import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {writeHostFile} from '../src/host-files.mjs';import {createRuntimeReporter} from '../src/host-runtime-status.mjs';
import {existsSync,unlinkSync,readFileSync} from 'node:fs';
const config=process.argv[3],marker=join(config,'fixture-marker.json');if(existsSync(marker))unlinkSync(marker);
writeHostFile(marker,JSON.stringify({pid:process.pid,uid:process.getuid(),config,version:${JSON.stringify(version)},noNewPrivileges:/^NoNewPrivs:\\s+1$/m.test(readFileSync('/proc/self/status','utf8'))}));
const report=createRuntimeReporter({configDir:config,daemonPath:fileURLToPath(import.meta.url)});report({phase:'ready'});setInterval(()=>report({phase:'ready'}),1000);
`;
  writeFileSync(join(source,'bin/bridge-host-daemon.mjs'),daemon,{mode:0o600});
  const daemonPath=stageHostRuntime(paths,{sourceRoot:source});
  knownUnits.add(hostServiceUnit({daemonPath,configDir:config,home:options.home}));return {source,daemonPath};
}
try {
  assert.equal(existsSync(paths.unitPath),false,'Never overwrite an existing unit');
  assert.notEqual(systemctl(['is-active',name],{allowInactive:true}).status,0,'Never touch an existing active unit');
  preflightHostService(paths);
  const a=runtime('A'),b=runtime('B'),broken=runtime('broken');
  writeHostFile(join(config,'host.json'),JSON.stringify({host:{id:'host-isolated-linux-maintenance'}}));
  writeHostFile(join(config,'direct-runner.env'),'SYNTHETIC_FIXTURE_ONLY=not-a-credential\n');
  ensureHostDirectory(join(config,'direct-exec'));writeHostFile(join(config,'direct-exec/journal.json'),'{}\n');
  const identity=readHostFile(join(config,'host.json')),journal=readHostFile(join(config,'direct-exec/journal.json'));
  phase='install-A';console.log(JSON.stringify({fixturePhase:phase}));
  await installHostService(paths,{...options,hostId:'host-isolated-linux-maintenance',daemonPath:a.daemonPath,startupStatus:()=>readRuntimeStatus(config)});
  const first=recordPid();assert.equal(first.version,'A');assert.ok(alive(first.pid));
  phase='autostart-off-while-running';
  let setting=setPersistenceAutostart(config,false,options);assert.equal(setting.active,true);assert.equal(setting.autostart.enabled,false);assert.equal(recordPid().pid,first.pid);assert.ok(alive(first.pid));
  phase='upgrade-B';console.log(JSON.stringify({fixturePhase:phase}));await maintainHost(config,'upgrade',{...options,sourceRoot:b.source});
  const second=recordPid();assert.equal(second.version,'B');assert.notEqual(first.pid,second.pid);assert.equal(alive(first.pid),false);
  assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='failed-upgrade-restores-B';console.log(JSON.stringify({fixturePhase:phase}));
  await assert.rejects(maintainHost(config,'upgrade',{...options,sourceRoot:broken.source}),error=>error.code==='HOST_MAINTENANCE_FAILED');
  const restored=recordPid();assert.equal(restored.version,'B');assert.notEqual(restored.pid,second.pid);assert.equal(alive(second.pid),false);
  assert.equal(readRuntimeStatus(config).daemonPath,b.daemonPath);assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='rollback-A';console.log(JSON.stringify({fixturePhase:phase}));await maintainHost(config,'rollback',options);
  const rolled=recordPid();assert.equal(rolled.version,'A');assert.equal(alive(restored.pid),false);
  assert.equal(persistenceStatus(config,options).autostart.enabled,false);
  phase='autostart-on-while-stopped';stopHostService(paths,options);
  assert.equal(alive(rolled.pid),false);
  setting=setPersistenceAutostart(config,true,options);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);
  await maintainHost(config,'upgrade',{...options,sourceRoot:b.source});
  setting=persistenceStatus(config,options);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);assert.equal(alive(recordPid().pid),false);
  await maintainHost(config,'rollback',options);
  setting=persistenceStatus(config,options);assert.equal(setting.active,false);assert.equal(setting.autostart.enabled,true);assert.equal(alive(recordPid().pid),false);
  phase='uninstall';console.log(JSON.stringify({fixturePhase:phase}));await maintainHost(config,'uninstall',options);
  assert.equal(hostServiceStatus(paths).installed,false);assert.equal(alive(rolled.pid),false);
  assert.equal(readHostFile(join(config,'host.json')),identity);assert.equal(readHostFile(join(config,'direct-exec/journal.json')),journal);
  assert.ok(existsSync(join(config,'direct-runner.env')));
  console.log(JSON.stringify({actualLinuxMaintenance:true,node:process.version,uid:process.getuid(),ordinaryUser:true,noNewPrivileges:true,upgrade:true,failedUpgradeRestoresPrevious:true,explicitRollback:true,uninstall:true,previousDaemonExit:true,identityAndJournalRetained:true,independentAutostart:true,autostartPreservedAcrossMaintenance:true,productionHostModified:false,productionLogin:false,rebootTest:false}));
} catch(error){originalFailure=error;console.error(JSON.stringify({fixturePhase:phase,errorCode:error.code ?? error.name}));throw error;}
finally {
  try {
    recordPid();
    if(existsSync(paths.unitPath)) {
      assert.ok(knownUnits.has(readHostFile(paths.unitPath)),'Only this invocation\'s exact generated units may be removed');
      systemctl(['disable','--now',name]);unlinkSync(paths.unitPath);systemctl(['daemon-reload']);
    }
    assert.notEqual(systemctl(['is-active',name],{allowInactive:true}).status,0);
    for(let i=0;i<100 && [...seen].some(alive);i++)await delay(100);
    assert.equal([...seen].some(alive),false,'Retain the fixture if an owned daemon remains alive');
    const rel=relative(parent,root);assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && dirname(root)===parent && root.startsWith(join(parent,'bridge-maintenance-linux-')));
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});assert.equal(existsSync(root),false);
    cleanupComplete=true;console.log(JSON.stringify({actualLinuxMaintenanceCleanup:true}));
  } catch(error){console.error(JSON.stringify({fixtureCleanupFailed:true,retainedFixture:root,unit:name,code:error.code ?? error.name}));if(!originalFailure)throw error;}
}
assert.equal(cleanupComplete,true);
