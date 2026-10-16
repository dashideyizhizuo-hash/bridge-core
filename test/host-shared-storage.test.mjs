import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir,userInfo,homedir} from 'node:os';
import {resolve,join} from 'node:path';
import * as hostFiles from '../src/host-files.mjs';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {hostConfigDir,setupHost} from '../src/host-onboarding.mjs';
import {preparePersistence} from '../src/host-persistence.mjs';
import {connectDirectHost} from '../src/direct-connect-client.mjs';
import {maintainHost} from '../src/host-maintenance.mjs';
import {nativeServicePaths,installNativeService} from '../src/host-native-service.mjs';
import {hostServicePaths,stageHostRuntime} from '../src/host-service.mjs';

const code=value=>error=>error.code===value;
const endpoint='https://bridge.example/mcp';
const pair='synthetic-pairing-token-abcdefghijklmnopqrstuvwxyz';
function fixture(t){
  const root=makeTestDirectory(join(tmpdir(),'bridge-shared-storage-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');hostFiles.ensureHostDirectory(config);
  return {root,config};
}

async function maintenanceFixture(t){
  const f=fixture(t),stateDir=join(f.config,'state'),assetDir=join(stateDir,'assets');
  hostFiles.ensureHostDirectory(stateDir);hostFiles.ensureHostDirectory(assetDir);
  const daemon=join(f.config,'old-daemon.mjs');hostFiles.writeHostFile(daemon,'// synthetic fixture only\n');
  hostFiles.writeHostFile(join(f.config,'host.json'),JSON.stringify({version:1,host:{id:'host-shared-maintenance-fixture'},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root:f.root,stateDir,assetDir,maxSeconds:900,resultBytes:1048576}}));
  hostFiles.writeHostFile(join(f.config,'direct-runner.env'),'SYNTHETIC_FIXTURE_ONLY=not-a-credential\n');
  const identity=readFileSync(join(f.config,'host.json')),credential=readFileSync(join(f.config,'direct-runner.env'));
  const calls={stop:0,remove:0,install:0};let registered=false,spec,enabled=false;
  const options={platform:'win32',home:f.root,env:{},start:false,realpath:path=>path,
    runtimeStatus:()=>({localReady:false}),exec:(_exe,_args,options)=>{
      const input=JSON.parse(options.env.BRIDGE_HOST_DATA);
      if(input.operation==='probe')return JSON.stringify({available:true,sid:'S-1-5-21-1000'});
      if(registered&&JSON.stringify(input.spec)!==JSON.stringify(spec))return '{"failure":"HOST_SERVICE_CONFLICT","field":"fixtureReceipt"}';
      if(input.operation==='install'){calls.install++;registered=true;spec=input.spec;enabled=input.start!==false;}
      if(input.operation==='stop'){calls.stop++;enabled=false;}
      if(input.operation==='remove'){calls.remove++;registered=false;}
      if(input.operation==='autostart')enabled=input.enabled;
      return JSON.stringify({installed:registered,active:false,autostartEnabled:enabled,sid:'S-1-5-21-1000'});
    }};
  const paths=nativeServicePaths(f.config,{platform:'win32'});
  await installNativeService(paths,{...options,daemonPath:daemon});calls.install=0;
  const retained=()=>{
    assert.deepEqual(readFileSync(join(f.config,'host.json')),identity);
    assert.deepEqual(readFileSync(join(f.config,'direct-runner.env')),credential);
  };
  return {...f,stateDir,assetDir,daemon,paths,options,calls,retained,unchanged(){
    assert.equal(calls.stop,0);assert.equal(calls.remove,0);assert.equal(calls.install,0);
    assert.equal(existsSync(join(f.config,'maintenance-pending.json')),false);retained();
  }};
}

test('upgrade rejects redirected configuration before stopping or removing its owned registration',async t=>{
  const f=await maintenanceFixture(t);
  await assert.rejects(maintainHost(f.config,'upgrade',{...f.options,
    realpath:path=>path===f.config?join(path,'package-private-view'):path
  }),code('HOST_PATH_NOT_SHARED'));
  f.unchanged();
});

for(const selected of ['runtime-root','target-daemon','policy-state'])
test(`upgrade rejects redirected ${selected} before changing registration or transaction state`,async t=>{
  const f=await maintenanceFixture(t);let options={...f.options},refused;
  if(selected==='runtime-root'){
    options.env={XDG_DATA_HOME:join(f.root,'xdg-data')};
    refused=hostServicePaths(f.config,options).runtimeRoot;hostFiles.ensureHostDirectory(refused);
  }else if(selected==='target-daemon'){
    refused=stageHostRuntime(hostServicePaths(f.config,options),options);
  }else refused=f.stateDir;
  options.realpath=path=>path===refused?path+'-package-private-view':path;
  await assert.rejects(maintainHost(f.config,'upgrade',options),code('HOST_PATH_NOT_SHARED'));
  f.unchanged();
});

for(const selected of ['configuration','target-daemon','policy-state'])
test(`rollback rejects redirected ${selected} before stopping the current owned registration`,async t=>{
  const f=await maintenanceFixture(t);
  const snapshot={schemaVersion:1,platform:'win32',configDir:f.config,
    receipt:readFileSync(f.paths.receiptPath,'utf8'),unit:null,active:false,daemonPath:f.daemon,autostartEnabled:false};
  hostFiles.writeHostFile(join(f.config,'maintenance-previous.json'),JSON.stringify(snapshot));
  const refused=selected==='configuration'?f.config:selected==='target-daemon'?f.daemon:f.stateDir;
  await assert.rejects(maintainHost(f.config,'rollback',{...f.options,
    realpath:path=>path===refused?path+'-package-private-view':path
  }),code('HOST_PATH_NOT_SHARED'));
  f.unchanged();
});

test('uninstall can remove its exact old virtualized registration while retaining identity for recovery',async t=>{
  const f=await maintenanceFixture(t);let checks=0;
  const result=await maintainHost(f.config,'uninstall',{...f.options,
    realpath:()=>{checks++;throw new Error('Uninstall must not require shared storage');}
  });
  assert.equal(result.completed,true);assert.ok(f.calls.stop>0);assert.equal(f.calls.remove,1);assert.equal(f.calls.install,0);
  assert.equal(checks,0);assert.equal(existsSync(f.paths.receiptPath),false);
  assert.equal(existsSync(join(f.config,'maintenance-pending.json')),false);f.retained();
});

test('background storage rejects a Windows path redirected to a private package view',t=>{
  assert.equal(typeof hostFiles.assertSharedHostPath,'function');
  const logical=fixture(t).config;
  assert.throws(()=>hostFiles.assertSharedHostPath(logical,{
    platform:'win32',realpath:path=>resolve(path,'package-private-view')
  }),code('HOST_PATH_NOT_SHARED'));
});

test('shared directory accepts an unchanged physical Windows path',t=>{
  assert.equal(typeof hostFiles.assertSharedHostPath,'function');
  const logical=fixture(t).config;
  assert.doesNotThrow(()=>hostFiles.assertSharedHostPath(logical,{platform:'win32',realpath:path=>path}));
});

test('shared Windows paths accept normal case differences and a local drive device prefix',
  {skip:process.platform!=='win32'},t=>{
  const {config}=fixture(t),slash=String.fromCharCode(92);
  assert.doesNotThrow(()=>hostFiles.assertSharedHostPath(config,{platform:'win32',realpath:path=>path.toUpperCase()}));
  assert.doesNotThrow(()=>hostFiles.assertSharedHostPath(config,{
    platform:'win32',realpath:path=>slash+slash+'?'+slash+path
  }));
});

test('shared Windows paths continue to reject UNC shares and non-drive device paths',
  {skip:process.platform!=='win32'},t=>{
  const {config}=fixture(t),slash=String.fromCharCode(92);
  const physicalPaths=[slash+slash+'server'+slash+'share'+slash+'bridge',
    slash+slash+'.'+slash+'C:'+slash+'bridge',
    slash+slash+'?'+slash+'UNC'+slash+'server'+slash+'share'+slash+'bridge'];
  for(const physical of physicalPaths)assert.throws(()=>hostFiles.assertSharedHostPath(config,{
    platform:'win32',realpath:()=>physical
  }),error=>['HOST_PATH_INVALID','HOST_PATH_DENIED','HOST_PATH_NOT_SHARED'].includes(error.code));
});

test('new Windows installs choose home .config while legacy selection and XDG precedence remain stable',t=>{
  assert.equal(typeof hostFiles.defaultHostConfigDirectory,'function');
  const {root}=fixture(t),home=join(root,'home'),local=join(root,'local-appdata');
  mkdirSync(home);mkdirSync(local);
  const select=env=>hostFiles.defaultHostConfigDirectory(env,home,'win32');
  assert.equal(select({LOCALAPPDATA:local}),resolve(home,'.config','bridge'));
  mkdirSync(join(local,'bridge'));
  assert.equal(select({LOCALAPPDATA:local}),resolve(local,'bridge'),'Existing legacy state must not select a second identity');
  const xdg=join(root,'xdg');
  assert.equal(select({LOCALAPPDATA:local,XDG_CONFIG_HOME:xdg}),resolve(xdg,'bridge'));
  if(process.platform==='win32')assert.equal(hostConfigDir({LOCALAPPDATA:local},home),resolve(local,'bridge'));
});

for(const mode of ['background','auto'])test(`virtualized ${mode} preflight rejects before browser login or claim`,async t=>{
  const {root,config}=fixture(t);let browser=0,claim=0,osProbe=0;
  await assert.rejects(setupHost({endpoint,configDir:config,persistenceMode:mode,
    login:async()=>{browser++;return {endpoint,pairingToken:pair};},
    connect:async()=>{claim++;throw new Error('Unexpected fixture claim');},
    serviceOptions:{platform:'win32',home:root,env:{},realpath:path=>join(path,'package-private-view'),
      exec:()=>{osProbe++;throw Object.assign(new Error('Unexpected OS probe'),{code:'FIXTURE_OS_PROBE'});}}
  }),code('HOST_PATH_NOT_SHARED'));
  assert.equal(browser,0);assert.equal(claim,0);assert.equal(osProbe,0);
  for(const file of ['host.json','direct-runner.env','.pending-runner.env'])assert.equal(existsSync(join(config,file)),false);
});

test('a separately redirected XDG runtime root is rejected before browser authorization',async t=>{
  const {root,config}=fixture(t),dataHome=join(root,'data');
  const runtimeRoot=resolve(dataHome,'bridge','runtimes');let browser=0,claims=0;const checked=[];
  await assert.rejects(setupHost({endpoint,configDir:config,persistenceMode:'background',
    login:async()=>{browser++;return {endpoint,pairingToken:pair};},
    connect:async()=>{claims++;throw new Error('Unexpected fixture claim');},
    serviceOptions:{platform:'win32',home:root,env:{XDG_DATA_HOME:dataHome},
      realpath:path=>{checked.push(path);return path===runtimeRoot?join(path,'package-private-view'):path;},
      exec:()=>JSON.stringify({available:true,sid:'S-1-5-21-1000',installed:false,active:false,autostartEnabled:false})}
  }),code('HOST_PATH_NOT_SHARED'));
  assert.ok(checked.includes(config));assert.ok(checked.includes(runtimeRoot));
  assert.equal(browser,0);assert.equal(claims,0);
  assert.equal(existsSync(join(config,'.pending-runner.env')),false);
});

test('an existing Host with redirected replay state is preserved and never re-paired',async t=>{
  const {root,config}=fixture(t),stateDir=join(config,'state'),assetDir=join(stateDir,'assets');
  hostFiles.ensureHostDirectory(stateDir);hostFiles.ensureHostDirectory(assetDir);
  const policy={version:1,host:{id:'host-existing-shared-fixture'},repositories:{},directExec:{enabled:true,
    serviceUser:userInfo().username,root,stateDir,assetDir,maxSeconds:900,resultBytes:1048576}};
  hostFiles.writeHostFile(join(config,'host.json'),JSON.stringify(policy));
  hostFiles.writeHostFile(join(config,'direct-runner.env'),`BRIDGE_PUBLIC_URL=${endpoint}\nBRIDGE_DIRECT_RUNNER_TOKEN=${'r'.repeat(43)}\n`);
  const savedPolicy=readFileSync(join(config,'host.json'));
  const savedEnv=readFileSync(join(config,'direct-runner.env'));
  let browser=0,claims=0;
  await assert.rejects(setupHost({endpoint,configDir:config,persistenceMode:'background',
    login:async()=>{browser++;throw new Error('Existing Host must not reauthorize');},
    connect:async()=>{claims++;throw new Error('Existing Host must not claim');},
    serviceOptions:{platform:'win32',home:root,env:{},realpath:path=>path===stateDir?join(path,'package-private-view'):path,
      exec:()=>JSON.stringify({available:true,sid:'S-1-5-21-1000',installed:false,active:false,autostartEnabled:false})}
  }),code('HOST_PATH_NOT_SHARED'));
  assert.equal(browser,0);assert.equal(claims,0);
  assert.deepEqual(readFileSync(join(config,'host.json')),savedPolicy);
  assert.deepEqual(readFileSync(join(config,'direct-runner.env')),savedEnv);
});

for(const mode of ['foreground','manual'])test(`${mode} selection does not require shared background storage`,t=>{
  const {root,config}=fixture(t);let checks=0;
  const selected=preparePersistence(config,{mode,platform:'win32',home:root,env:{},
    realpath:()=>{checks++;throw new Error('Background-only check reached');}});
  assert.equal(selected.mode,mode);assert.equal(checks,0);
});

for(const refused of ['config','root','state'])test(`shared claim refuses a redirected ${refused} directory before consuming pairing`,async t=>{
  const {root,config}=fixture(t);let claims=0,hits=0;const checked=[];
  const previousStateHome=process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME=join(root,'claim-state-home');
  t.after(()=>{if(previousStateHome===undefined)delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=previousStateHome;});
  const expectedState=process.platform==='win32'&&!process.env.XDG_STATE_HOME?resolve(config,'direct-exec'):
    resolve(process.env.XDG_STATE_HOME || (process.platform==='win32'?process.env.LOCALAPPDATA||resolve(homedir(),'AppData/Local'):resolve(homedir(),'.local','state')),'bridge','direct-exec');
  const target=refused==='config'?config:refused==='root'?resolve(homedir()):expectedState;
  await assert.rejects(connectDirectHost({endpoint,pairingToken:pair,configDir:config,sharedStorage:true,
    platform:'win32',realpath:path=>{
      checked.push(path);
      if(path===target){hits++;return path+'-package-private-view';}
      return path;
    },fetchImpl:async()=>{claims++;throw new Error('Unexpected fixture claim');}
  }),code('HOST_PATH_NOT_SHARED'));
  assert.equal(claims,0);
  assert.ok(checked.includes(config));assert.ok(checked.includes(target),`The ${refused} guard must inspect its exact target path`);
  assert.equal(hits,1,`The ${refused} case must fail on its own target rather than an earlier path`);
  for(const file of ['host.json','direct-runner.env','.pending-runner.env'])assert.equal(existsSync(join(config,file)),false);
});

test('manual claim retains its original behavior without a background visibility requirement',async t=>{
  const {config}=fixture(t);let claims=0,checks=0;
  await assert.rejects(connectDirectHost({endpoint,pairingToken:pair,configDir:config,sharedStorage:false,
    platform:'win32',realpath:()=>{checks++;throw new Error('Background-only check reached');},
    fetchImpl:async()=>{claims++;return Response.json({error:{code:'DIRECT_PAIRING_DENIED'}},{status:403});}
  }),code('DIRECT_PAIRING_DENIED'));
  assert.equal(claims,1);assert.equal(checks,0);
  assert.equal(existsSync(join(config,'.pending-runner.env')),false);
});

test('background setup requests shared claim storage while manual and foreground setup do not',async t=>{
  for(const mode of ['background','foreground','manual']){
    const {root,config}=fixture(t);let requested;
    await assert.rejects(setupHost({endpoint,configDir:config,persistenceMode:mode,
      login:async()=>({endpoint,pairingToken:pair}),
      connect:async options=>{requested=options.sharedStorage;throw Object.assign(new Error('Stop fixture before claim'),{code:'FIXTURE_STOP'});},
      serviceOptions:{platform:'win32',home:root,env:{},realpath:path=>path,exec:(_exe,_args,options)=>{
        const request=JSON.parse(options.env.BRIDGE_HOST_DATA);
        return JSON.stringify({available:true,sid:'S-1-5-21-1000',installed:false,active:false,autostartEnabled:false,operation:request.operation});
      }}
    }),code('FIXTURE_STOP'));
    assert.equal(requested===true,mode==='background');
  }
});
