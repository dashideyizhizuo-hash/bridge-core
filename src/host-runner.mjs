import { resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync, mkdirSync, rmdirSync, unlinkSync} from 'node:fs';
import { readHostFile, writeHostFile } from './host-files.mjs';
import {createRuntimeReporter, readRuntimeStatus} from './host-runtime-status.mjs';
import {assertBridge, BridgeError} from './errors.mjs';
import { readDirectRunnerEnv } from './direct-connect-client.mjs';
import { runDirectRunnerLoop } from './direct-runner-client.mjs';
import { hostEndpoint } from './host-http.mjs';
import { validateHostPolicy } from './validate.mjs';

export async function runHost({configDir,once=false,pollMs=5000,signal,fetchImpl=globalThis.fetch,onError=()=>{},onState=()=>{}}={}) {
  // Verify local credential and policy ownership on every launch, not only setup.
  validateHostPolicy(JSON.parse(readHostFile(resolve(configDir,'host.json'))));
  readHostFile(resolve(configDir,'direct-runner.env'));
  const local=readDirectRunnerEnv(resolve(configDir,'direct-runner.env'));
  onState({phase:'ready'});
  // The common Runner transport enforces control/asset bounds once, including
  // standalone CLI use. Keep production endpoint validation at the Host edge.
  hostEndpoint(local.endpoint);
  return runDirectRunnerLoop({endpoint:local.endpoint,token:local.token,
    hostPolicyPath:resolve(configDir,'host.json'),once,pollMs,signal,
    onContact:()=>onState({phase:'connected'}),
    onError:error=>{onState({phase:'retrying',code:error.code});onError(error);},
    fetchImpl});
}

export async function runForeground(options) {
  let report=options.onState,releaseStartup=()=>{};
  if(!report) {
    // Serialize first readiness with setup/maintenance. After publishing our
    // live PID, their existing runtime fence prevents conflicting operations.
    const lock=resolve(options.configDir,'.setup-lock');
    try {mkdirSync(lock,{mode:0o700});}
    catch(error){if(error.code!=='EEXIST')throw error;throw new BridgeError('HOST_SETUP_BUSY','Another setup or maintenance operation owns this configuration');}
    let locked=true;
    releaseStartup=()=>{if(locked){if(existsSync(resolve(lock,'owner.json')))unlinkSync(resolve(lock,'owner.json'));rmdirSync(lock);locked=false;}};
    try {
      writeHostFile(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid})+'\n');
      assertBridge(!existsSync(resolve(options.configDir,'maintenance-pending.json')),'HOST_MAINTENANCE_INCOMPLETE','Reconcile interrupted maintenance before starting Host');
      const current=readRuntimeStatus(options.configDir);
      let alive=false;
      if(Number.isSafeInteger(current.pid) && current.phase!=='stopped') {
        try {process.kill(current.pid,0);alive=true;}catch(error){alive=error.code!=='ESRCH';}
      }
      assertBridge(!current.localReady && !alive,'HOST_ALREADY_RUNNING','A Host is already running with this configuration');
      report=createRuntimeReporter({configDir:options.configDir,daemonPath:fileURLToPath(import.meta.url),mode:'foreground'});
    } catch(error){releaseStartup();throw error;}
  }
  const onState=value=>{report(value);if(value.phase==='ready')releaseStartup();};
  const controller=new AbortController();
  const shutdown=()=>controller.abort();
  const signals=process.platform==='win32' ? ['SIGINT','SIGTERM','SIGBREAK'] : ['SIGINT','SIGTERM','SIGHUP'];
  for(const signal of signals) process.on(signal,shutdown);
  try {
    return await runHost({...options,onState,signal:options.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal,
      onError:error=>process.stderr.write(JSON.stringify({code:/^[A-Z][A-Z0-9_]{2,63}$/.test(error.code ?? '') ? error.code : 'HOST_RUN_RETRY',
        message:'Host request failed; retrying without re-pairing'})+'\n')});
  } finally {for(const signal of signals) process.removeListener(signal,shutdown);try{onState({phase:'stopped'});}finally{releaseStartup();}}
}
