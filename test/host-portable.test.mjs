import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir, userInfo, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { setupHost } from '../src/host-onboarding.mjs';
import { preparePersistence } from '../src/host-persistence.mjs';
import { ensureHostDirectory, readHostFile, safeHostPath, writeHostFile } from '../src/host-files.mjs';
import { hostPowerShell, xmlText } from '../src/host-platform.mjs';
import { windowsArgument } from '../src/host-native-service.mjs';
import { openHostBrowser } from '../src/host-loopback.mjs';
import { executeDirectExec } from '../src/direct-exec.mjs';
import { runHost } from '../src/host-runner.mjs';
import { sanitizedExecutionEnv } from '../src/environment.mjs';

const endpoint='https://bridge.example/mcp',hostId='host-portable-fixture-0001';
const token='r'.repeat(43),pairingToken='p'.repeat(600);
const code=value=>error=>error.code===value;
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-portable-test-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const configDir=join(root,'config'),state=join(root,'state');
  ensureHostDirectory(configDir);ensureHostDirectory(state);
  const policy={version:1,host:{id:hostId},repositories:{},directExec:{enabled:true,
    serviceUser:userInfo().username,root,stateDir:state,assetDir:join(state,'assets'),maxSeconds:30,resultBytes:1048576}};
  function configured() {
    writeHostFile(join(configDir,'host.json'),JSON.stringify(policy));
    writeHostFile(join(configDir,'direct-runner.env'),`BRIDGE_PUBLIC_URL=${endpoint}\nBRIDGE_DIRECT_RUNNER_TOKEN=${token}\n`);
  }
  return {root,configDir,state,policy,configured};
}

test('portable files: create-only private storage and bounded readers',t=>{
  const f=fixture(t);const file=join(f.configDir,'state.json');
  writeHostFile(file,'{"ok":true}');assert.equal(readHostFile(file),'{"ok":true}');
  assert.throws(()=>writeHostFile(file,'overwrite'));
  if(process.platform!=='win32') assert.equal(statSync(file).mode&0o777,0o600);
  assert.throws(()=>safeHostPath(join(f.root,'bad\npath')),code('HOST_PATH_INVALID'));
});
test('portable paths reject symlinks/junctions rather than following them',t=>{
  const f=fixture(t);symlinkSync(f.configDir,join(f.root,'link'),process.platform==='win32' ? 'junction' : 'dir');
  assert.throws(()=>safeHostPath(join(f.root,'link','secret')),code('HOST_PATH_DENIED'));
});
test('Windows ACL is real, excludes unrelated readers, and detects broadening',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t);const file=join(f.configDir,'credential');writeHostFile(file,'fake-test-only');
  assert.equal(readHostFile(file),'fake-test-only');
  const broaden=spawnSync('icacls.exe',[file,'/grant','*S-1-5-32-545:R'],{encoding:'utf8',windowsHide:true});
  assert.equal(broaden.error,undefined,broaden.error?.message);
  assert.equal(broaden.status,0,`${broaden.stdout}\n${broaden.stderr}`);
  assert.throws(()=>readHostFile(file));
  for(const name of ['x:stream','NUL','aux.txt','trailing.','trailing ']) assert.throws(()=>safeHostPath(join(f.root,name)),code('HOST_PATH_INVALID'));
});
test('foreground does not call any supervisor, even when no user manager exists',t=>{
  const f=fixture(t);const p=preparePersistence(f.configDir,{mode:'foreground',exec:()=>{throw new Error('must not invoke supervisor');}});
  assert.equal(p.mode,'foreground');
});
test('WSL/Linux auto mode falls back to foreground; explicit background fails before pairing',t=>{
  const f=fixture(t);
  const options={platform:'linux',env:{XDG_CONFIG_HOME:f.root,XDG_DATA_HOME:join(f.root,'data')},home:f.root,
    exec:()=>({status:1,stdout:'offline\n'})};
  assert.equal(preparePersistence(f.configDir,options).mode,'foreground');
  assert.throws(()=>preparePersistence(f.configDir,{...options,mode:'background'}),code('HOST_SERVICE_UNAVAILABLE'));
});
test('unknown OS is foreground-capable but not falsely background-supported',t=>{
  const f=fixture(t);assert.equal(preparePersistence(f.configDir,{platform:'unknown'}).mode,'foreground');
  assert.throws(()=>preparePersistence(f.configDir,{platform:'unknown',mode:'background'}),code('HOST_SERVICE_UNSUPPORTED'));
});
test('native quoting preserves metacharacters as data',()=>{
  assert.equal(windowsArgument('C:\\a b\\'),'"C:\\a b\\\\"');
  assert.equal(windowsArgument('a"b'),'"a\\"b"');
  assert.equal(xmlText('<a&"\'>'),'&lt;a&amp;&quot;&apos;&gt;');
  assert.throws(()=>windowsArgument('bad\narg'));
});
test('Windows browser authorization passes URL as data, never PowerShell source',async()=>{
  const url='https://bridge.example/authorize?state=a&x=$()';let called=false;
  assert.equal(await openHostBrowser(url,{platform:'win32',nativeOpen:(script,data)=>{
    called=true;assert.equal(script.includes(url),false);assert.equal(data.url,url);return {opened:true};
  }}),true);assert.equal(called,true);
});
test('setup foreground reuses existing identity without any OAuth or pairing call',async t=>{
  const f=fixture(t);f.configured();
  for(let i=0;i<2;i++) {
    const result=await setupHost({configDir:f.configDir,persistenceMode:'foreground',
      login:()=>{throw new Error('unexpected login');},connect:()=>{throw new Error('unexpected pairing');}});
    assert.equal(result.reused,true);assert.equal(result.hostId,hostId);assert.equal(result.mode,'foreground');
    assert.equal(result.remoteExecutionVerified,false);
  }
});
test('native first claim creates private config and retains the same Host on rerun',async t=>{
  const f=fixture(t);let claims=0;
  const old=process.env.XDG_STATE_HOME;process.env.XDG_STATE_HOME=f.state;
  t.after(()=>{if(old===undefined) delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=old;});
  const result=await setupHost({endpoint,configDir:f.configDir,persistenceMode:'foreground',pairingToken,
    fetchImpl:async(url,options)=>{
      claims++;assert.equal(new URL(url).pathname,'/direct/enroll/claim');
      assert.equal(Object.keys(JSON.parse(options.body)).join(','),'runnerTokenSha256');
      assert.equal(options.headers.authorization,'Bearer '+pairingToken);
      return Response.json({paired:true,hostId});
    }});
  assert.equal(result.hostId,hostId);assert.equal(claims,1);
  assert.equal((await setupHost({configDir:f.configDir,persistenceMode:'foreground'})).reused,true);
  assert.equal(existsSync(join(f.configDir,'.pending-runner.env')),false);
  assert.doesNotMatch(readHostFile(join(f.configDir,'host.json')),/access_token|refresh_token/);
});
test('foreground runner executes a real native command and returns its result',async t=>{
  const f=fixture(t);f.configured();let completed;
  const request={schemaVersion:1,requestId:'portable-exec-0001',hostId,
    argv:[process.execPath,'-e','console.log("portable:"+process.platform)'],timeoutSeconds:10};
  const result=await runHost({configDir:f.configDir,once:true,fetchImpl:async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer '+token);
    if(new URL(url).pathname==='/direct/runner/claim') return Response.json({request,leaseOwner:'fixture-owner',runId:'fixture-run'});
    completed=JSON.parse(options.body).result;return Response.json({ok:true});
  }});
  assert.equal(result.status,'SUCCEEDED');assert.equal(completed.execution.exitCode,0);
  assert.equal(completed.evidence.stdout.trim(),'portable:'+process.platform);
});
test('foreground loop exits promptly from idle without deleting its identity',async t=>{
  const f=fixture(t);f.configured();const controller=new AbortController();
  const work=runHost({configDir:f.configDir,signal:controller.signal,fetchImpl:async()=>new Response(null,{status:204})});
  setTimeout(()=>controller.abort(),100);
  assert.equal((await work).status,'STOPPED');assert.ok(existsSync(join(f.configDir,'direct-runner.env')));
});
test('foreground shutdown cancels an in-flight native command and descendants',async t=>{
  const f=fixture(t);const marker=join(f.root,'processes.json');const controller=new AbortController();
  const request={schemaVersion:1,requestId:'portable-cancel-001',hostId,timeoutSeconds:20,
    argv:[process.execPath,'-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);`]};
  const running=executeDirectExec({request,hostPolicy:f.policy,signal:controller.signal});
  running.catch(()=>{});
  for(let n=0;n<100 && !existsSync(marker);n++) await delay(50);
  assert.ok(existsSync(marker),'real command started');const pids=JSON.parse(readFileSync(marker,'utf8'));
  controller.abort();await assert.rejects(running,code('EXECUTION_CANCELED'));
  function alive(pid) {
    try {
      process.kill(pid,0);
      if(process.platform==='linux' && /\) Z /.test(readFileSync('/proc/'+pid+'/stat','utf8'))) return false;
      return true;
    } catch{return false;}
  }
  for(let n=0;n<100 && (alive(pids.parent)||alive(pids.child));n++) await delay(50);
  try {assert.equal(alive(pids.parent),false);assert.equal(alive(pids.child),false);}
  finally {for(const pid of Object.values(pids)) if(alive(pid)) try{process.kill(pid,'SIGKILL');}catch{}}
});
test('pre-aborted execution never spawns a command',async t=>{
  const f=fixture(t);const controller=new AbortController();controller.abort();
  await assert.rejects(executeDirectExec({hostPolicy:f.policy,signal:controller.signal,
    request:{schemaVersion:1,requestId:'portable-preabort-01',hostId,argv:[process.execPath,'-e','throw Error("must not run")']}}),code('EXECUTION_CANCELED'));
});
test('Windows runtime environment keeps OS essentials but drops arbitrary credentials',()=>{
  const env=sanitizedExecutionEnv();
  if(process.platform==='win32') assert.equal(env.SystemRoot,process.env.SystemRoot);
  assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.BRIDGE_PAIRING_TOKEN,undefined);
});
