import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {ensureHostDirectory} from '../src/host-files.mjs';
import * as systemd from '../src/host-service.mjs';
import * as native from '../src/host-native-service.mjs';

function fixture(t) {
  const root=realpathSync(makeTestDirectory(join(tmpdir(),'bridge-demand-start-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');ensureHostDirectory(config);
  return {root,config};
}

test('systemd demand start preserves both enabled and disabled autostart preferences',{skip:process.platform!=='linux'},async t=>{
  assert.equal(typeof systemd.startHostService,'function');
  for(const enabled of [false,true]) {
    const f=fixture(t);let active=false;const changes=[];
    const options={platform:'linux',env:{},home:f.root,exec:(_command,args)=>{
      if(args.includes('is-active'))return {status:active?0:3,stdout:active?'active\n':'inactive\n'};
      if(args.includes('is-enabled'))return {status:enabled?0:1,stdout:enabled?'enabled\n':'disabled\n'};
      if(args.includes('start'))active=true;
      if(args.some(value=>['enable','disable','start','stop'].includes(value)))changes.push(args);
      return {status:0,stdout:''};
    }};
    const paths=systemd.hostServicePaths(f.config,options);
    mkdirSync(dirname(paths.unitPath),{recursive:true});
    await systemd.installHostService(paths,{...options,daemonPath:join(f.root,'installed-daemon.mjs'),start:false});
    assert.equal(systemd.startHostService(paths,options).active,true);
    assert.equal(systemd.hostServiceStatus(paths,options).autostartEnabled,enabled);
    assert.deepEqual(changes,[['--user','start',paths.unitName]]);
  }
});

test('native demand start reuses its verified installed identity without enabling autostart',async t=>{
  assert.equal(typeof native.startNativeService,'function');
  assert.equal(typeof native.nativeServiceIdentity,'function');
  const f=fixture(t);let installed=false,active=false;const changes=[];
  const options={platform:'win32',home:f.root,exec:(_command,_args,options)=>{
    const data=JSON.parse(options.env.BRIDGE_HOST_DATA);
    if(data.operation==='install'){installed=true;active=data.start!==false;changes.push('install');}
    if(data.operation==='start'){active=true;changes.push('start');}
    return JSON.stringify({sid:'S-1-5-21-fixture',installed,active,autostartEnabled:false,available:true});
  }};
  const paths=native.nativeServicePaths(f.config,options),daemonPath=join(f.root,'installed-daemon.mjs');
  await native.installNativeService(paths,{...options,daemonPath,start:false});
  assert.deepEqual(native.nativeServiceIdentity(paths,options),{nodePath:process.execPath,daemonPath,detachedConsole:true});
  assert.equal(native.startNativeService(paths,options).active,true);
  assert.equal(native.nativeServiceStatus(paths,options).autostartEnabled,false);
  assert.deepEqual(changes,['install','start']);
});

test('native demand start rejects a conflicting registration before any mutation',async t=>{
  const f=fixture(t);let installed=false,conflict=false;const mutations=[];
  const options={platform:'win32',home:f.root,exec:(_command,_args,options)=>{
    const data=JSON.parse(options.env.BRIDGE_HOST_DATA);
    if(data.operation==='install'){installed=true;mutations.push(data.operation);}
    if(conflict && data.operation==='inspect')return JSON.stringify({failure:'HOST_SERVICE_CONFLICT',field:'principal'});
    if(['start','stop','autostart','remove'].includes(data.operation))mutations.push(data.operation);
    return JSON.stringify({sid:'S-1-5-21-fixture',installed,active:false,autostartEnabled:false,available:true});
  }};
  const paths=native.nativeServicePaths(f.config,options);
  await native.installNativeService(paths,{...options,daemonPath:join(f.root,'installed.mjs'),start:false});
  conflict=true;
  assert.throws(()=>native.startNativeService(paths,options),error=>error.code==='HOST_SERVICE_CONFLICT');
  assert.deepEqual(mutations,['install']);
});

test('native demand start requires an existing owned registration',t=>{
  const f=fixture(t),changes=[];
  const options={platform:'win32',home:f.root,exec:(_command,_args,options)=>{
    const data=JSON.parse(options.env.BRIDGE_HOST_DATA);
    if(data.operation!=='inspect')changes.push(data.operation);
    return JSON.stringify({installed:false,active:false,autostartEnabled:false});
  }};
  const paths=native.nativeServicePaths(f.config,options);
  assert.throws(()=>native.startNativeService(paths,options),error=>error.code==='HOST_SERVICE_UNAVAILABLE');
  assert.deepEqual(changes,[]);
});

test('launchd demand start preserves disabled preference and refuses an unloaded disabled job',async t=>{
  const f=fixture(t),name='dev.runner-bridge.host.'+'a'.repeat(20);
  const paths={adapter:'launchd',configDir:f.config,name,domain:'gui/501',receiptPath:join(f.config,'launchd.json'),unitPath:join(f.config,'owned.plist')};
  let active=false,loaded=false;const changes=[];
  const options={exec:(_command,args)=>{
    if(args[0]==='print-disabled')return {status:0,stdout:`disabled services = {\n "${name}" => true\n}`};
    if(args[0]==='print'&&args[1]===paths.domain)return {status:0,stdout:''};
    if(args[0]==='print')return {status:loaded?0:113,stdout:active?'pid = 12345':''};
    changes.push(args[0]);if(args[0]==='kickstart')active=true;
    return {status:0,stdout:''};
  }};
  await native.installNativeService(paths,{...options,daemonPath:join(f.root,'installed.mjs'),start:false});
  assert.throws(()=>native.startNativeService(paths,options),error=>error.code==='HOST_SERVICE_UNAVAILABLE');
  assert.deepEqual(changes,[]);
  loaded=true;
  const started=native.startNativeService(paths,options);
  assert.equal(started.active,true);assert.equal(started.autostartEnabled,false);
  assert.deepEqual(changes,['kickstart']);
});
