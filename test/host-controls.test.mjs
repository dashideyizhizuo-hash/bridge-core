import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir,userInfo} from 'node:os';
import {join,resolve} from 'node:path';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {ensureHostDirectory,writeHostFile} from '../src/host-files.mjs';
import {nativeServicePaths,installNativeService} from '../src/host-native-service.mjs';
import * as controls from '../src/host-persistence.mjs';

async function fixture(t,{running=false,autostart=false}={}){
 const root=makeTestDirectory(join(tmpdir(),'bridge-control-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'config');ensureHostDirectory(config);
 const daemon=join(config,'installed-daemon.mjs');writeFileSync(daemon,'// offline control fixture\n',{mode:0o600});
 const policy={version:1,host:{id:'host-control-fixture'},repositories:{},directExec:{enabled:true,
  serviceUser:userInfo().username,root,maxSeconds:900,resultBytes:1048576}};
 writeFileSync(join(config,'host.json'),JSON.stringify(policy),{mode:0o600});
 writeFileSync(join(config,'direct-runner.env'),'BRIDGE_PUBLIC_URL=https://bridge.example/mcp\nBRIDGE_DIRECT_RUNNER_TOKEN='+'S'.repeat(43)+'\n',{mode:0o600});
 let active=false,enabled=false,registered=false,foreign=false,ready=true,orphan=false;
 const calls=[];
 const runtime=()=>active?{localReady:ready,connected:ready,pid:87654321,daemonPath:daemon,phase:ready?'connected':'retrying'}:
  orphan?{localReady:false,connected:false,pid:87654321,daemonPath:daemon,phase:'connected'}:{localReady:false,connected:false,phase:'stopped'};
 const options={platform:'win32',home:root,startupAttempts:2,startupDelayMs:0,stopAttempts:2,stopDelayMs:0,
  runtimeStatus:runtime,processAlive:pid=>pid===87654321&&(active||orphan),exec:(_exe,_args,opts)=>{
   const d=JSON.parse(opts.env.BRIDGE_HOST_DATA);calls.push(d.operation);
   if(foreign&&d.operation!=='probe')return JSON.stringify({failure:'HOST_SERVICE_CONFLICT',field:'fixtureOwnership'});
   if(d.operation==='install'){registered=true;active=d.start!==false;enabled=active;}
   if(d.operation==='start')active=true;
   if(d.operation==='stop'){active=false;enabled=false;}
   if(d.operation==='autostart')enabled=d.enabled;
   return JSON.stringify({sid:'S-1-5-21-control-fixture',available:true,installed:registered,active,autostartEnabled:enabled});
  }};
 const paths=nativeServicePaths(config,options);await installNativeService(paths,{...options,daemonPath:daemon,start:false});
 active=running;enabled=autostart;calls.length=0;
 const retained=()=>['host.json','direct-runner.env','windows-task.json'].map(f=>readFileSync(join(config,f),'utf8'));
 return {root,config,daemon,paths,options,calls,retained,state:()=>({active,enabled}),foreign:()=>{foreign=true;},unready:()=>{ready=false;},orphan:()=>{orphan=true;}};
}

test('background start preserves all four running/autostart states and the installed identity',async t=>{
 for(const running of [false,true])for(const autostart of [false,true]){
  const f=await fixture(t,{running,autostart}),before=f.retained();
  const result=await controls.startPersistence(f.config,f.options);
  assert.equal(result.active,true);assert.equal(result.autostart.enabled,autostart);
  assert.equal(result.mode,'background');assert.equal(result.runtime.daemonPath,f.daemon);
  assert.deepEqual(f.state(),{active:true,enabled:autostart});assert.deepEqual(f.retained(),before);
  assert.equal(f.calls.filter(x=>x==='start').length,running?0:1);
  assert.equal(f.calls.some(x=>['install','remove','autostart','stop'].includes(x)),false);
  assert.equal(existsSync(join(f.config,'.setup-lock')),false);
 }
});

test('start rejects missing identity, pending claims and maintenance without creating another Host',async t=>{
 for(const [file,code]of [['host.json','HOST_CONFIG_INCOMPLETE'],['direct-runner.env','HOST_CONFIG_INCOMPLETE'],
  ['maintenance-pending.json','HOST_MAINTENANCE_INCOMPLETE'],['.pending-runner.env','HOST_CONNECT_INCOMPLETE']]){
  const f=await fixture(t);if(file.endsWith('pending.json')||file.startsWith('.pending'))writeHostFile(join(f.config,file),'{}');else rmSync(join(f.config,file));
  await assert.rejects(controls.startPersistence(f.config,f.options),e=>e.code===code);
  assert.equal(f.calls.some(x=>['start','install','stop','autostart'].includes(x)),false);
  assert.equal(existsSync(join(f.config,'.setup-lock')),false);
 }
});

test('start cannot run a foreign registration, a live foreground process or an unreadied active daemon',async t=>{
 for(const kind of ['foreign','orphan','active-unready']){
  const f=await fixture(t,{running:kind==='active-unready'}),before=f.retained();
  if(kind==='foreign')f.foreign();else if(kind==='orphan')f.orphan();else f.unready();
  await assert.rejects(controls.startPersistence(f.config,f.options),e=>['HOST_SERVICE_CONFLICT','HOST_FOREGROUND_CONFLICT','HOST_SERVICE_FAILED'].includes(e.code));
  assert.equal(f.calls.includes('start'),false);assert.deepEqual(f.retained(),before);
 }
});

test('a successful OS start without exact daemon readiness remains a failure and retains pairing',async t=>{
 const f=await fixture(t),before=f.retained();f.unready();
 await assert.rejects(controls.startPersistence(f.config,f.options),e=>e.code==='HOST_SERVICE_FAILED');
 assert.deepEqual(f.retained(),before);assert.equal(f.calls.filter(x=>x==='start').length,1);
});

test('control lock prevents concurrent starts before touching the native registration',async t=>{
 const f=await fixture(t);mkdirSync(join(f.config,'.setup-lock'),{mode:0o700});
 await assert.rejects(controls.startPersistence(f.config,f.options),e=>e.code==='HOST_SETUP_BUSY');
 assert.deepEqual(f.calls,[]);
});

test('explicit stop verifies process exit, disables future startup and retains identity',async t=>{
 const f=await fixture(t,{running:true,autostart:true}),before=f.retained();
 const result=await controls.stopPersistenceAndWait(f.config,f.options);
 assert.equal(result.stopped,true);assert.equal(result.active,false);assert.equal(result.autostart.enabled,false);
 assert.deepEqual(f.state(),{active:false,enabled:false});assert.deepEqual(f.retained(),before);
});

test('stop never claims success while the original daemon still exists',async t=>{
 const f=await fixture(t,{running:true});f.orphan();
 await assert.rejects(controls.stopPersistenceAndWait(f.config,f.options),e=>e.code==='HOST_SERVICE_FAILED');
 assert.equal(existsSync(join(f.config,'direct-runner.env')),true);
});

test('invalid local diagnostics cannot prevent an explicit owned stop or fabricate verified process exit',async t=>{
 const f=await fixture(t,{running:true,autostart:true}),before=f.retained();
 f.options.runtimeStatus=()=>{throw Object.assign(new Error('synthetic invalid local diagnostic'),{code:'HOST_STATUS_INVALID'});};
 await assert.rejects(controls.stopPersistenceAndWait(f.config,f.options),e=>e.code==='HOST_SERVICE_FAILED'&&/stopped.*automatic startup.*off/i.test(e.message));
 assert.equal(f.calls.filter(x=>x==='stop').length,1);assert.deepEqual(f.state(),{active:false,enabled:false});assert.deepEqual(f.retained(),before);
});

test('ordinary CLI start is background-only and never opens a pairing or foreground session',t=>{
 const root=makeTestDirectory(join(tmpdir(),'bridge-control-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const missing=join(root,'not-installed'),cli=resolve('bin/bridge-host.mjs');
 for(const flags of [['--once'],['--poll-ms','15000'],['--no-service'],['--background','--foreground']]){
  const result=spawnSync(process.execPath,[cli,'start',...flags,'--config-dir',missing],{encoding:'utf8',timeout:10_000});
  assert.equal(result.status,65);assert.equal(JSON.parse(result.stderr).code,'HOST_USAGE_INVALID');assert.equal(existsSync(missing),false);
 }
 const result=spawnSync(process.execPath,[cli,'start','--config-dir',missing],{encoding:'utf8',timeout:10_000});
 assert.equal(result.status,65);assert.equal(JSON.parse(result.stderr).code,'HOST_SERVICE_UNAVAILABLE');
 assert.equal(existsSync(missing),false);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/Foreground Host|Authorize this computer/);
});

test('Windows automatic setup never silently falls back to a terminal-bound session',t=>{
 const root=makeTestDirectory(join(tmpdir(),'bridge-no-terminal-fallback-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'config');ensureHostDirectory(config);
 assert.throws(()=>controls.preparePersistence(config,{mode:'auto',platform:'win32',home:root,
  exec:()=>{throw new Error('synthetic unavailable task manager');}}),e=>e.code==='HOST_SERVICE_UNAVAILABLE');
 assert.equal(existsSync(join(config,'windows-task.json')),false);assert.equal(existsSync(join(config,'host.json')),false);
});
