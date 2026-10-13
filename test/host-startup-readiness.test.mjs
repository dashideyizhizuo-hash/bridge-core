import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, rmSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostServicePaths } from '../src/host-service.mjs';
import { nativeServicePaths, installNativeService } from '../src/host-native-service.mjs';
import { ensureHostDirectory } from '../src/host-files.mjs';
import { connectDirectHost } from '../src/direct-connect-client.mjs';
import { readFileSync } from 'node:fs';

test('Windows runtime follows the selected configuration instead of a separate profile directory',()=>{
  const base=realpathSync(tmpdir());const config=join(base,'bridge-config');
  const paths=hostServicePaths(config,{platform:'win32',env:{LOCALAPPDATA:join(base,'unrelated-profile')},home:base});
  assert.equal(paths.runtimeRoot,join(config,'runtimes'));
  assert.equal(hostServicePaths(config,{platform:'win32',env:{XDG_DATA_HOME:base},home:base}).runtimeRoot,
    join(base,'bridge','runtimes'));
});

test('an active Windows supervisor is insufficient when its daemon never reports readiness',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-startup-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');ensureHostDirectory(config);
  const paths=nativeServicePaths(config,{platform:'win32'});
  const exec=(_exe,_args,options)=>{
    const d=JSON.parse(options.env.BRIDGE_HOST_DATA);
    return JSON.stringify(d.operation==='probe'?{available:true,sid:'S-1-5-21-test'}:{installed:true,active:true});
  };
  await assert.rejects(installNativeService(paths,{daemonPath:join(root,'daemon.mjs'),exec,
    startupStatus:()=>null,startupAttempts:2,startupDelayMs:0}),
    error=>error.code==='HOST_SERVICE_FAILED');
});

test('native startup waits for both supervisor and daemon readiness',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-ready-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));const config=join(root,'config');ensureHostDirectory(config);
  const paths=nativeServicePaths(config,{platform:'win32'});
  const exec=(_exe,_args,options)=>JSON.stringify(JSON.parse(options.env.BRIDGE_HOST_DATA).operation==='probe'
    ? {available:true,sid:'S-1-5-21-test'} : {installed:true,active:true});
  let checks=0;
  const result=await installNativeService(paths,{daemonPath:join(root,'daemon.mjs'),exec,
    startupStatus:()=>({localReady:++checks>=2,connected:false}),startupAttempts:3,startupDelayMs:0});
  assert.equal(checks,3);assert.equal(result.runtime.localReady,true);assert.equal(result.runtime.connected,false);
});

test('Windows pairing keeps replay journals with the selected configuration',{skip:process.platform!=='win32'},async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-journal-location-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const previous=process.env.XDG_STATE_HOME;delete process.env.XDG_STATE_HOME;
  t.after(()=>{if(previous!==undefined)process.env.XDG_STATE_HOME=previous;});
  const config=join(root,'config');
  await connectDirectHost({endpoint:'https://bridge.example/mcp',pairingToken:'fake_pairing_abcdefghijklmnopqrstuvwxyz123456',configDir:config,
    fetchImpl:async()=>Response.json({paired:true,hostId:'host-journal-location'})});
  const policy=JSON.parse(readFileSync(join(config,'host.json'),'utf8'));
  assert.equal(policy.directExec.stateDir,join(config,'direct-exec'));
});
