import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir, userInfo} from 'node:os';
import {join} from 'node:path';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {ensureHostDirectory, readHostFile, writeHostFile} from '../src/host-files.mjs';
import {validateHostPolicy} from '../src/validate.mjs';
import {connectDirectHost} from '../src/direct-connect-client.mjs';
import {runForeground} from '../src/host-runner.mjs';
import {readRuntimeStatus} from '../src/host-runtime-status.mjs';
import {setupHost} from '../src/host-onboarding.mjs';
import {resolveDirectExecPlan} from '../src/direct-exec.mjs';
import {maintainHost} from '../src/host-maintenance.mjs';
import {nativeServicePaths, installNativeService} from '../src/host-native-service.mjs';

function fixture(t) {
  const root=realpathSync(makeTestDirectory(join(tmpdir(),'bridge-release-regression-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const configDir=join(root,'config');ensureHostDirectory(configDir);
  const policy={version:1,host:{id:'host-release-fixture'},repositories:{},directExec:{enabled:true,
    serviceUser:userInfo().username,root,stateDir:join(configDir,'state'),assetDir:join(configDir,'state/assets')}};
  return {root,configDir,policy};
}

test('Direct Host permits exact Unicode/space OS account names, rejecting controls and root',t=>{
  const f=fixture(t);
  for(const serviceUser of ['张三','Alice Smith','95888','álîce'])
    assert.doesNotThrow(()=>validateHostPolicy({...f.policy,directExec:{...f.policy.directExec,serviceUser}}));
  for(const serviceUser of ['','root','bad\nname','bad\u0000name','bad\u202ename','a'.repeat(257)])
    assert.throws(()=>validateHostPolicy({...f.policy,directExec:{...f.policy.directExec,serviceUser}}),
      error=>error.code==='HOST_POLICY_INVALID');
  const otherUser=userInfo().username==='张三' ? '李四' : '张三';
  assert.throws(()=>resolveDirectExecPlan({hostPolicy:{...f.policy,directExec:{...f.policy.directExec,serviceUser:otherUser}},
    request:{schemaVersion:1,requestId:'unicode-owner-test',hostId:f.policy.host.id,argv:[process.execPath,'--version']}}),
    error=>error.code==='DIRECT_EXEC_DENIED');
});

test('pairing validates the complete local policy before consuming a one-use claim',async t=>{
  const f=fixture(t);let claims=0;
  await assert.rejects(connectDirectHost({endpoint:'https://bridge.example/mcp',pairingToken:'p'.repeat(48),
    configDir:f.configDir,user:{username:'bad\nname',uid:1000},fetchImpl:async()=>{
      claims++;return Response.json({paired:true,hostId:'host-release-fixture'});
    }}),error=>error.code==='HOST_POLICY_INVALID');
  assert.equal(claims,0);
  assert.equal(existsSync(join(f.configDir,'.pending-runner.env')),false);
});

test('real foreground entry reports its live PID and marks a clean stop',async t=>{
  const f=fixture(t);writeHostFile(join(f.configDir,'host.json'),JSON.stringify(f.policy));
  writeHostFile(join(f.configDir,'direct-runner.env'),
    `BRIDGE_PUBLIC_URL=https://bridge.example/mcp\nBRIDGE_DIRECT_RUNNER_TOKEN=${'r'.repeat(43)}\n`);
  const controller=new AbortController();let firstContact;
  const contacted=new Promise(resolve=>{firstContact=resolve;});
  const running=runForeground({configDir:f.configDir,signal:controller.signal,pollMs:1000,
    fetchImpl:async()=>{firstContact();return new Response(null,{status:204});}});
  // Always stop the actual loop, including when an assertion catches the bug.
  try {
    await contacted;
    const state=readRuntimeStatus(f.configDir);
    assert.equal(state.localReady,true);assert.equal(state.pid,process.pid);
    assert.equal(state.daemonPath.endsWith('host-runner.mjs'),true);
    assert.equal(state.mode,'foreground');
    await assert.rejects(runForeground({configDir:f.configDir,once:true,fetchImpl:async()=>{
      throw new Error('A second foreground must never poll');
    }}),error=>error.code==='HOST_ALREADY_RUNNING');
    await assert.rejects(setupHost({configDir:f.configDir,persistenceMode:'background'}),
      error=>error.code==='HOST_ALREADY_RUNNING');
    assert.equal(readRuntimeStatus(f.configDir).localReady,true);
    // A stopped, test-owned registration must not hide the real foreground PID.
    // Only the native supervisor transport is faked; status/fencing are real.
    let registered=false,mutations=0;
    const options={platform:'win32',env:{},home:f.root,exec:(_exe,_args,opts)=>{
      const data=JSON.parse(opts.env.BRIDGE_HOST_DATA);
      if(data.operation==='install'){registered=true;mutations++;}
      if(['stop','remove','autostart'].includes(data.operation))mutations++;
      return JSON.stringify({available:true,sid:'S-1-5-21-fixture',installed:registered,active:false,autostartEnabled:false});
    }};
    const paths=nativeServicePaths(f.configDir,options);
    await installNativeService(paths,{...options,daemonPath:join(f.root,'stopped-daemon.mjs'),start:false});
    mutations=0;
    await assert.rejects(maintainHost(f.configDir,'uninstall',options),error=>error.code==='HOST_FOREGROUND_CONFLICT');
    assert.equal(mutations,0);
    assert.equal(existsSync(join(f.configDir,'maintenance-pending.json')),false);
  } finally {controller.abort();await running;}
  assert.equal(readRuntimeStatus(f.configDir).localReady,false);
  assert.equal(JSON.parse(readHostFile(join(f.configDir,'runtime-status.json'))).phase,'stopped');
});
