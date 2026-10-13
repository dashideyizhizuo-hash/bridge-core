import {ensureHostDirectory,readHostFile} from '../src/host-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntimeReporter } from '../src/host-runtime-status.mjs';
import { setupHost } from '../src/host-onboarding.mjs';
import { hostServicePaths, hostServiceUnit, stageHostRuntime, safeHostPath, hostServiceStatus, stopHostService } from '../src/host-service.mjs';
import { HOST_RUNTIME_FILES } from '../src/host-package-spec.mjs';
import { connectDirectHost } from '../src/direct-connect-client.mjs';

const endpoint='https://bridge.example/mcp';
const hostId='host-test-1234567890';
const token='R'.repeat(43);
const pairing='P'.repeat(600);
const code=value=>error=>error.code===value;
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'bridge-host-ux-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const configDir=join(root,'config/bridge');
  const env={XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data')};
  const counts={login:0,connect:0,exec:[]};
  let failStart=false;
  const exec=(_command,args)=>{
    counts.exec.push(args);
    if(args.includes('is-system-running')) return {status:0,stdout:'running\n'};
    if(args.includes('enable') && failStart) return {status:1,stdout:''};
    if(args.includes('enable')) createRuntimeReporter({configDir,daemonPath:stageHostRuntime(hostServicePaths(configDir,{env,home:root}))})({phase:'ready'});
    return {status:0,stdout:args.includes('is-active') ? 'active\n' : ''};
  };
  const connect=async ()=>{
    counts.connect++;
    mkdirSync(configDir,{recursive:true,mode:0o700});
    const policy={version:1,host:{id:hostId},repositories:{},directExec:{enabled:true,
      serviceUser:userInfo().username,root,maxSeconds:900,resultBytes:1048576}};
    writeFileSync(join(configDir,'host.json'),JSON.stringify(policy),{mode:0o600,flag:'wx'});
    writeFileSync(join(configDir,'direct-runner.env'),`BRIDGE_PUBLIC_URL=${endpoint}\nBRIDGE_DIRECT_RUNNER_TOKEN=${token}\n`,{mode:0o600,flag:'wx'});
    return {connected:true,hostId,endpoint};
  };
  const options={endpoint,configDir,login:async()=>{counts.login++;return {endpoint,hostId,pairingToken:pairing};},
    connect,doctorImpl:()=>({ok:true}),serviceOptions:{platform:'linux',env,home:root,exec}};
  return {root,configDir,env,counts,options,exec,failStart:value=>{failStart=value;}};
}
test('setup installs privately and reruns without re-pairing or npx cache dependency',{skip:process.platform==='win32'?'POSIX systemd/mode fixture; native Windows is covered separately':false},async t=>{
  const f=fixture(t);
  const result=await setupHost(f.options);
  assert.equal(result.connected,true);assert.equal(result.hostId,hostId);assert.equal(result.reused,false);
  assert.equal(result.service.active,true);assert.equal(result.remoteExecutionVerified,false);
  const second=await setupHost(f.options);assert.equal(second.hostId,hostId);assert.equal(second.reused,true);
  assert.equal(f.counts.login,1);assert.equal(f.counts.connect,1);
  const paths=hostServicePaths(f.configDir,f.options.serviceOptions);
  const unit=readFileSync(paths.unitPath,'utf8');
  assert.match(unit,/runtimes\/[a-f0-9]{64}\/bin\/bridge-host-daemon.mjs/);
  assert.doesNotMatch(unit,/_npx|BRIDGE_DIRECT_RUNNER_TOKEN|Bearer/);
  assert.equal(statSync(paths.receiptPath).mode&0o777,0o600);
  assert.equal(existsSync(join(f.configDir,'.setup-lock')),false);
  assert.equal(hostServiceStatus(paths,{exec:f.exec}).active,true);
  assert.equal(stopHostService(paths,{exec:f.exec}).credentialsRetained,true);
  assert.ok(existsSync(join(f.configDir,'direct-runner.env')));
});
test('manual setup does not require a service manager or install a service',async t=>{
  const f=fixture(t);const result=await setupHost({...f.options,service:false});
  assert.equal(result.service.manual,true);assert.equal(f.counts.exec.length,0);
});
test('missing service manager fails before consuming pairing or login',async t=>{
  const f=fixture(t);
  f.options.serviceOptions.exec=()=>({status:1,stdout:'offline\n'});
  await assert.rejects(setupHost(f.options),code('HOST_SERVICE_UNAVAILABLE'));
  assert.equal(f.counts.login,0);assert.equal(f.counts.connect,0);
});
test('service failure retains identity and a later setup reuses it',{skip:process.platform==='win32'?'POSIX systemd/mode fixture; native Windows is covered separately':false},async t=>{
  const f=fixture(t);f.failStart(true);
  await assert.rejects(setupHost(f.options),code('HOST_SERVICE_FAILED'));
  assert.ok(existsSync(join(f.configDir,'host.json')));
  f.failStart(false);const result=await setupHost(f.options);
  assert.equal(result.reused,true);assert.equal(f.counts.connect,1);assert.equal(f.counts.login,1);
});
test('root and unsupported automatic service platforms are rejected before authorization',async t=>{
  const f=fixture(t);
  await assert.rejects(setupHost({...f.options,user:{uid:0,username:'root'}}),code('HOST_ROOT_DENIED'));
  f.options.serviceOptions.platform='unknown';
  await assert.rejects(setupHost(f.options),code('HOST_SERVICE_UNSUPPORTED'));
  assert.equal(f.counts.login,0);
});
test('partial, ambiguous and busy configurations fail closed',async t=>{
  for(const [file,expected] of [['maintenance-pending.json','HOST_MAINTENANCE_INCOMPLETE'],['host.json','HOST_CONFIG_INCOMPLETE'],['.pending-runner.env','HOST_CONNECT_INCOMPLETE'],['.setup-lock','HOST_SETUP_BUSY']]) {
    const f=fixture(t);ensureHostDirectory(f.configDir);
    if(file==='.setup-lock') mkdirSync(join(f.configDir,file));
    else writeFileSync(join(f.configDir,file),'private',{mode:0o600});
    await assert.rejects(setupHost(f.options),code(expected));assert.equal(f.counts.login,0);
  }
});
test('existing identity is not moved to another endpoint or token',async t=>{
  const f=fixture(t);await setupHost({...f.options,service:false});
  await assert.rejects(setupHost({...f.options,endpoint:'https://other.example/mcp'}),code('HOST_ENDPOINT_MISMATCH'));
  await assert.rejects(setupHost({...f.options,pairingToken:pairing}),code('HOST_ALREADY_CONNECTED'));
  assert.equal(f.counts.connect,1);
});
test('foreign systemd unit is not overwritten or stopped',{skip:process.platform==='win32'?'POSIX systemd/mode fixture; native Windows is covered separately':false},async t=>{
  const f=fixture(t);const paths=hostServicePaths(f.configDir,f.options.serviceOptions);
  mkdirSync(dirname(paths.unitPath),{recursive:true});writeFileSync(paths.unitPath,'foreign-service',{mode:0o600});
  await assert.rejects(setupHost(f.options),code('HOST_SERVICE_CONFLICT'));
  assert.throws(()=>stopHostService(paths,{exec:f.exec}),code('HOST_SERVICE_CONFLICT'));
  assert.equal(readFileSync(paths.unitPath,'utf8'),'foreign-service');assert.equal(f.counts.login,0);
});
test('unsafe paths, file permissions and symlinks are rejected',{skip:process.platform==='win32'?'POSIX systemd/mode fixture; native Windows is covered separately':false},async t=>{
  const f=fixture(t);
  assert.throws(()=>safeHostPath('/tmp/a\nExecStart=evil'),code('HOST_PATH_INVALID'));
  symlinkSync(f.root,join(f.root,'link'));
  assert.throws(()=>safeHostPath(join(f.root,'link','config')),code('HOST_PATH_DENIED'));
  await setupHost({...f.options,service:false});chmodSync(join(f.configDir,'direct-runner.env'),0o644);
  await assert.rejects(setupHost(f.options),code('HOST_PATH_DENIED'));
});
test('systemd quoting handles spaces, percent and dollar without injecting commands',{skip:process.platform==='win32'?'POSIX systemd/mode fixture; native Windows is covered separately':false},()=>{
  const root=realpathSync(tmpdir());
  const unit=hostServiceUnit({daemonPath:join(root,'my app%p$/daemon.mjs'),configDir:join(root,'my config%h$'),
    nodePath:process.execPath,home:join(root,'my home$')});
  assert.match(unit,/my app%%p\$\$\/daemon/);assert.match(unit,/my config%%h\$\$/);
  assert.match(unit,/my home\$\/.local\/bin/);assert.doesNotMatch(unit,/my home\$\$\//);
  assert.throws(()=>hostServiceUnit({daemonPath:'/tmp/x\nExecStart=evil',configDir:'/tmp/x'}),code('HOST_PATH_INVALID'));
});
test('durable runtime is immutable and survives deleting its original package',t=>{
  const f=fixture(t);const source=join(f.root,'fake-npx-cache');mkdirSync(source);
  for(const path of HOST_RUNTIME_FILES) {
    mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),`// ${path}\n`);
  }
  const paths=hostServicePaths(f.configDir,f.options.serviceOptions);
  const daemon=stageHostRuntime(paths,{sourceRoot:source});
  assert.equal(stageHostRuntime(paths,{sourceRoot:source}),daemon);
  writeFileSync(daemon,'tampered');
  assert.throws(()=>stageHostRuntime(paths,{sourceRoot:source}),code('HOST_RUNTIME_CONFLICT'));
  writeFileSync(daemon,'// bin/bridge-host-daemon.mjs\n');rmSync(source,{recursive:true});
  assert.ok(existsSync(daemon));assert.equal(existsSync(join(dirname(dirname(daemon)),'node_modules')),false);
});
test('a concurrent setup cannot consume a second pairing',async t=>{
  const f=fixture(t);let unblock;
  const gate=new Promise(resolve=>{unblock=resolve;});
  const first=setupHost({...f.options,service:false,login:async()=>{await gate;return {endpoint,hostId,pairingToken:pairing};}});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(setupHost({...f.options,service:false}),code('HOST_SETUP_BUSY'));
  unblock();await first;assert.equal(f.counts.connect,1);
});
test('claim supports production-length capabilities and checks the expected host',async t=>{
  if(userInfo().uid===0) {t.skip('requires non-root host user');return;}
  const parent=mkdtempSync(join(tmpdir(),'bridge-claim-'));const root=ensureHostDirectory(join(parent,'private'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const result=await connectDirectHost({endpoint,configDir:root,pairingToken:pairing,expectedHostId:hostId,
    fetchImpl:async (_url,init)=>{
      assert.equal(init.headers.authorization.length,607);
      assert.deepEqual(Object.keys(JSON.parse(init.body)),['runnerTokenSha256']);
      assert.ok(existsSync(join(root,'.pending-runner.env')));
      return Response.json({paired:true,hostId});
    }});
  assert.equal(result.hostId,hostId);assert.equal(existsSync(join(root,'.pending-runner.env')),false);
});
for(const [response,expected] of [
  [()=>{throw new Error('LOST_RESPONSE_SECRET');},'HOST_NETWORK_FAILED'],
  [()=>Response.json({paired:true,hostId:'host-wrong'}),'DIRECT_CONNECT_FAILED'],
  [()=>new Response('<invalid>'),'DIRECT_CONNECT_AMBIGUOUS']
]) test(`ambiguous claim ${expected} retains private credential and forbids blind retry`,async t=>{
  if(userInfo().uid===0) {t.skip('requires non-root host user');return;}
  const parent=mkdtempSync(join(tmpdir(),'bridge-claim-lost-'));const root=ensureHostDirectory(join(parent,'private'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
  let calls=0;
  const options={endpoint,configDir:root,pairingToken:pairing,expectedHostId:hostId,
    fetchImpl:async()=>{calls++;return response();}};
  await assert.rejects(connectDirectHost(options),code(expected));
  if(process.platform==='win32')assert.ok(readHostFile(join(root,'.pending-runner.env')));else assert.equal(statSync(join(root,'.pending-runner.env')).mode&0o777,0o600);
  await assert.rejects(connectDirectHost(options),code('DIRECT_CONNECT_CONFLICT'));
  assert.equal(calls,1);
});

test('new setup selects placeholder default or explicit self-hosted endpoint before authorization',async t=>{
  for(const chosen of [undefined,'https://self-hosted.example/mcp']) {
    const root=mkdtempSync(join(tmpdir(),'bridge-endpoint-selection-'));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    let observed;
    await assert.rejects(setupHost({endpoint:chosen,configDir:join(root,'config'),service:false,
      login:async options=>{observed=options.endpoint;throw Object.assign(Error('stop before authorization'),{code:'FIXTURE_STOP'});}
    }),{code:'FIXTURE_STOP'});
    assert.equal(observed,chosen??'https://bridge.example.invalid/mcp');
  }
});
