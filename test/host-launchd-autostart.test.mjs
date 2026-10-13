import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ensureHostDirectory} from '../src/host-files.mjs';
import {installNativeService,nativeServiceStatus,setNativeServiceAutostart} from '../src/host-native-service.mjs';
async function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-launchd-autostart-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'config');ensureHostDirectory(config);
 const name='dev.runner-bridge.host.'+'a'.repeat(20),paths={adapter:'launchd',configDir:config,name,domain:'gui/501',receiptPath:join(config,'launchd.json'),unitPath:join(config,'owned.plist')};
 let enabled=true,active=false,loaded=false,budget='normal';const calls=[];
 const exec=(_exe,args)=>{calls.push(args);
 if(args[0]==='print-disabled')return budget==='unavailable'?{status:1,stdout:''}:{status:0,stdout:budget==='malformed'?'unrecognized output':`disabled services = {\n "${name}" => ${enabled?'false':'true'}\n}\n`};
 if(args[0]==='print'&&args[1]===paths.domain)return {status:budget==='no-gui'?1:0,stdout:''};
 if(args[0]==='print')return {status:loaded?0:113,stdout:active?'pid = 12345':''};
 if(args[0]==='disable')enabled=false;if(args[0]==='enable')enabled=true;
 if(args[0]==='bootstrap'||args[0]==='kickstart'){loaded=true;active=true;}
 return {status:0,stdout:''};};
 await installNativeService(paths,{daemonPath:join(root,'synthetic.mjs'),exec,start:false});
 return {paths,exec,calls,set:(value)=>budget=value,active:(value)=>{active=value;loaded=value;}};
}
test('launchd autostart rejects unreadable and malformed enabled state',async t=>{
 const f=await fixture(t);
 for(const state of ['unavailable','malformed','no-gui']){f.set(state);assert.throws(()=>setNativeServiceAutostart(f.paths,false,{exec:f.exec}),e=>e.code==='HOST_SERVICE_UNAVAILABLE'||e.code==='HOST_SERVICE_FAILED');}
 assert.equal(f.calls.filter(a=>['enable','disable'].includes(a[0])).length,0);
});
test('launchd enabled and active are independent; toggling never starts or stops',async t=>{
 const f=await fixture(t);f.active(true);
 assert.equal(setNativeServiceAutostart(f.paths,false,{exec:f.exec}).autostartEnabled,false);
 assert.equal(nativeServiceStatus(f.paths,{exec:f.exec}).active,true);
 f.active(false);assert.equal(setNativeServiceAutostart(f.paths,true,{exec:f.exec}).active,false);
 assert.equal(nativeServiceStatus(f.paths,{exec:f.exec}).autostartEnabled,true);
 assert.equal(f.calls.filter(a=>['bootstrap','kickstart','bootout'].includes(a[0])).length,0);
});

test('launchd maintenance preserves stopped-but-enabled and running-but-disabled states',{skip:process.platform==='win32'},async t=>{
 const {nativeServicePaths}=await import('../src/host-native-service.mjs');
 const {maintainHost}=await import('../src/host-maintenance.mjs');
 const {setPersistenceAutostart}=await import('../src/host-persistence.mjs');
 const {writeHostFile}=await import('../src/host-files.mjs');
 for(const initialActive of [false,true]) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-launchd-maintain-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');ensureHostDirectory(config);
  const paths=nativeServicePaths(config,{platform:'darwin',home:root});mkdirSync(join(root,'Library','LaunchAgents'),{recursive:true,mode:0o700});
  let enabled=!initialActive,active=false,loaded=false;
  const exec=(_exe,args)=>{
   if(args[0]==='print-disabled')return {status:0,stdout:`disabled services = {\n "${paths.name}" => ${enabled?'false':'true'}\n}`};
   if(args[0]==='print'&&args[1]===paths.domain)return {status:0,stdout:''};
   if(args[0]==='print')return {status:loaded?0:113,stdout:active?'pid = 12345':''};
   if(args[0]==='disable')enabled=false;if(args[0]==='enable')enabled=true;
   if(args[0]==='bootout'){active=false;loaded=false;}
   if(args[0]==='bootstrap'||args[0]==='kickstart'){loaded=true;active=true;}
   return {status:0,stdout:''};
  };
  const options={platform:'darwin',home:root,env:{},exec,startupAttempts:3,startupDelayMs:0,
    runtimeStatus:()=>({localReady:active,daemonPath:JSON.parse(readFileSync(paths.receiptPath,'utf8')).daemonPath})};
  writeHostFile(join(config,'host.json'),JSON.stringify({host:{id:'fixture-host'}}));
  await installNativeService(paths,{...options,daemonPath:join(root,'old.mjs'),start:initialActive});
  const setting=setPersistenceAutostart(config,!initialActive,options);
  assert.equal(setting.autostart.supported,true);assert.equal(setting.autostart.enabled,!initialActive);
  await maintainHost(config,'upgrade',options);
  let state=nativeServiceStatus(paths,options);assert.equal(state.active,initialActive);assert.equal(state.autostartEnabled,!initialActive);
  await maintainHost(config,'rollback',options);
  state=nativeServiceStatus(paths,options);assert.equal(state.active,initialActive);assert.equal(state.autostartEnabled,!initialActive);
 }
});
