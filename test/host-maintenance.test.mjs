import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { maintainHost } from '../src/host-maintenance.mjs';
import { hostServicePaths,installHostService } from '../src/host-service.mjs';

async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'bridge-maintain-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');mkdirSync(config,{mode:0o700});
  const options={platform:'linux',home:root,env:{},startupAttempts:3,startupDelayMs:0};
  const paths=hostServicePaths(config,options);mkdirSync(dirname(paths.unitPath),{recursive:true,mode:0o700});
  let active=true,enabled=false,fail=false;
  options.exec=(_exe,args)=>{
    if(args.includes('disable')) {enabled=false;if(args.includes('--now'))active=false;}
    if(args.includes('enable')) {if(fail){fail=false;return {status:1,stdout:''};}enabled=true;if(args.includes('--now'))active=true;}
    if(args.includes('is-enabled'))return {status:enabled?0:1,stdout:enabled?'enabled\n':'disabled\n'};
    return {status:args.includes('is-active')&&!active?3:0,stdout:args.includes('is-active')?(active?'active\n':'inactive\n'):''};
  };
  options.runtimeStatus=()=>({localReady:active,connected:false,daemonPath:existsSync(paths.unitPath)?
    JSON.parse(readFileSync(paths.unitPath,'utf8').match(/^ExecStart=("[^"]+") ("[^"]+")/m)[2]):null});
  writeFileSync(join(config,'host.json'),JSON.stringify({host:{id:'host-test'}}),{mode:0o600});
  writeFileSync(join(config,'direct-runner.env'),'private-identity-fixture',{mode:0o600});
  mkdirSync(join(config,'direct-exec'),{mode:0o700});writeFileSync(join(config,'direct-exec','journal'),'retained');
  await installHostService(paths,{...options,hostId:'host-test',daemonPath:join(root,'old-daemon.mjs')});
  return {config,options,paths,fail:()=>{fail=true;}};
}
const linux={skip:process.platform!=='linux'};
test('explicit upgrade and rollback retain identity and restore original registration',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8');
  assert.equal((await maintainHost(f.config,'upgrade',f.options)).completed,true);
  assert.notEqual(readFileSync(f.paths.unitPath,'utf8'),old);
  await maintainHost(f.config,'rollback',f.options);
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);
  assert.equal(readFileSync(join(f.config,'direct-runner.env'),'utf8'),'private-identity-fixture');
  assert.equal(readFileSync(join(f.config,'direct-exec','journal'),'utf8'),'retained');
});
test('uninstall removes only owned registration and rollback can restore it',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8');
  await maintainHost(f.config,'uninstall',f.options);
  assert.equal(existsSync(f.paths.unitPath),false);assert.equal(existsSync(f.paths.receiptPath),false);
  assert.ok(existsSync(join(f.config,'host.json')));
  await maintainHost(f.config,'rollback',f.options);
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);
});
test('failed upgrade restores the previous registration and retains credentials',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8');f.fail();
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_FAILED');
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);
  assert.equal(existsSync(join(f.config,'maintenance-pending.json')),false);
});
test('edited registration, foreign backup and pending transaction fail closed',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8');
  writeFileSync(f.paths.unitPath,old+'# foreign\n',{mode:0o600});
  await assert.rejects(maintainHost(f.config,'uninstall',f.options),e=>e.code==='HOST_SERVICE_CONFLICT');
  writeFileSync(f.paths.unitPath,old,{mode:0o600});
  writeFileSync(join(f.config,'maintenance-previous.json'),JSON.stringify({schemaVersion:1,platform:'linux',configDir:'/other'}),{mode:0o600});
  await assert.rejects(maintainHost(f.config,'rollback',f.options),e=>e.code==='HOST_MAINTENANCE_INVALID');
  writeFileSync(join(f.config,'maintenance-pending.json'),'{}',{mode:0o600});
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_INCOMPLETE');
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);
});

test('native explicit maintenance restores a stopped registration without starting it',async t=>{
  const {ensureHostDirectory,writeHostFile}=await import('../src/host-files.mjs');
  const {nativeServicePaths,installNativeService}=await import('../src/host-native-service.mjs');
  const root=mkdtempSync(join(tmpdir(),'bridge-native-maintain-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');ensureHostDirectory(config);
  const paths=nativeServicePaths(config,{platform:'win32'});let registered=false,active=false,enabled=false,spec;
  const options={platform:'win32',home:root,env:{},startupAttempts:3,startupDelayMs:0,
    exec:(_exe,_args,opts)=>{
      const d=JSON.parse(opts.env.BRIDGE_HOST_DATA);
      if(d.operation==='install'){registered=true;active=d.start!==false;enabled=active;spec=d.spec;}
      if(d.operation==='stop'){active=false;enabled=false;}
      if(d.operation==='autostart')enabled=d.enabled;
      if(d.operation==='remove'){registered=false;active=false;}
      return JSON.stringify({available:true,sid:'S-1-5-21-test',installed:registered,active,autostartEnabled:enabled});
    },runtimeStatus:()=>({localReady:active,daemonPath:spec?.daemonPath})};
  writeHostFile(join(config,'host.json'),JSON.stringify({host:{id:'host-native-fixture'}}));
  await installNativeService(paths,{...options,daemonPath:join(root,'old-daemon.mjs'),start:false});
  const original=readFileSync(paths.receiptPath,'utf8');
  await maintainHost(config,'uninstall',options);assert.equal(registered,false);
  await maintainHost(config,'rollback',options);
  assert.equal(registered,true);assert.equal(active,false);
  assert.equal(readFileSync(paths.receiptPath,'utf8'),original);
});

test('maintenance rejects foreground and runtime identity drift before stopping services',linux,async t=>{
  for(const active of [true,false]) {
    const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8'),exec=f.options.exec;
    f.options.exec=(exe,args)=>args.includes('is-active')?{status:active?0:3,stdout:active?'active\n':'inactive\n'}:exec(exe,args);
    f.options.runtimeStatus=()=>({localReady:true,daemonPath:join(f.config,'different-daemon.mjs')});
    await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_FOREGROUND_CONFLICT');
    assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);
    assert.equal(existsSync(join(f.config,'maintenance-pending.json')),false);
  }
});
test('a daemon surviving supervisor stop blocks deletion and retains recovery snapshot',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8'),runtime=f.options.runtimeStatus;
  f.options.runtimeStatus=()=>({...runtime(),pid:12345});f.options.processAlive=()=>true;
  f.options.stopAttempts=1;f.options.stopDelayMs=0;
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_RECOVERY_REQUIRED');
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);assert.ok(existsSync(f.paths.receiptPath));
  assert.ok(existsSync(join(f.config,'maintenance-pending.json')));
});
test('reload failure after deletion restores the old owned registration',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8'),exec=f.options.exec;let fail=true;
  f.options.exec=(exe,args)=>{if(args.includes('daemon-reload')&&fail){fail=false;return {status:1,stdout:''};}return exec(exe,args);};
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_FAILED');
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);assert.ok(existsSync(f.paths.receiptPath));
  assert.equal(existsSync(join(f.config,'maintenance-pending.json')),false);
});
test('failed restoration receipt write retains pending snapshot instead of claiming rollback success',linux,async t=>{
  const {writeHostFile}=await import('../src/host-files.mjs');
  const f=await fixture(t);f.fail();
  f.options.privateWrite=(path,bytes)=>{if(path===f.paths.receiptPath)throw new Error('injected restore write failure');return writeHostFile(path,bytes);};
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_RECOVERY_REQUIRED');
  assert.ok(existsSync(join(f.config,'maintenance-pending.json')));
  assert.equal(existsSync(f.paths.receiptPath),false);
  assert.ok(existsSync(join(f.config,'direct-runner.env')));
});
test('failed snapshot replacement preserves the previous snapshot and restores registration',linux,async t=>{
  const {writeHostFile}=await import('../src/host-files.mjs');
  const f=await fixture(t);await maintainHost(f.config,'upgrade',f.options);
  const history=join(f.config,'maintenance-previous.json'),saved=readFileSync(history,'utf8'),unit=readFileSync(f.paths.unitPath,'utf8');
  f.options.privateWrite=(path,bytes)=>{if(path.includes('.maintenance-previous-'))throw new Error('injected history write failure');return writeHostFile(path,bytes);};
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_FAILED');
  assert.equal(readFileSync(history,'utf8'),saved);assert.equal(readFileSync(f.paths.unitPath,'utf8'),unit);
});

test('a new daemon that never becomes ready restores the previous ready daemon',linux,async t=>{
  const f=await fixture(t),old=readFileSync(f.paths.unitPath,'utf8'),runtime=f.options.runtimeStatus;
  f.options.runtimeStatus=()=>{const value=runtime();return {...value,localReady:value.localReady && value.daemonPath.endsWith('/old-daemon.mjs')};};
  await assert.rejects(maintainHost(f.config,'upgrade',f.options),e=>e.code==='HOST_MAINTENANCE_FAILED');
  assert.equal(readFileSync(f.paths.unitPath,'utf8'),old);
  assert.equal(existsSync(join(f.config,'maintenance-pending.json')),false);
});
test('Linux receipt identity decoder preserves dollars, percent, quotes and Unicode',linux,async t=>{
  const {hostServiceIdentity,hostServiceUnit}=await import('../src/host-service.mjs');
  const {createHash}=await import('node:crypto');const f=await fixture(t);
  const daemonPath=join(f.config,'中文 $HOME %s "quoted".mjs');
  const unit=hostServiceUnit({configDir:f.config,daemonPath,home:f.options.home});
  writeFileSync(f.paths.unitPath,unit,{mode:0o600});
  writeFileSync(f.paths.receiptPath,JSON.stringify({schemaVersion:1,unitPath:f.paths.unitPath,unitSha256:createHash('sha256').update(unit).digest('hex')}),{mode:0o600});
  assert.equal(hostServiceIdentity(f.paths).daemonPath,daemonPath);
});


test('upgrade and rollback preserve independent running and autostart states',linux,async t=>{
  const {setPersistenceAutostart,persistenceStatus}=await import('../src/host-persistence.mjs');
  const {stopHostService}=await import('../src/host-service.mjs');
  for(const running of [true,false]) {
    const f=await fixture(t);
    if(!running)stopHostService(f.paths,f.options);
    setPersistenceAutostart(f.config,!running,f.options);
    const check=()=>{const state=persistenceStatus(f.config,f.options);assert.equal(state.active,running);assert.equal(state.autostart.enabled,!running);};
    check();await maintainHost(f.config,'upgrade',f.options);check();
    await maintainHost(f.config,'rollback',f.options);check();
  }
});
test('legacy snapshots retain the former active-based autostart behavior',linux,async t=>{
  const {persistenceStatus}=await import('../src/host-persistence.mjs');
  const f=await fixture(t);await maintainHost(f.config,'upgrade',f.options);
  const path=join(f.config,'maintenance-previous.json'),value=JSON.parse(readFileSync(path,'utf8'));
  delete value.autostartEnabled;writeFileSync(path,JSON.stringify(value),{mode:0o600});
  await maintainHost(f.config,'rollback',f.options);
  assert.equal(persistenceStatus(f.config,f.options).autostart.enabled,value.active);
});
