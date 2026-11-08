import { userInfo } from 'node:os';
import { existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import { BridgeError, assertBridge } from './errors.mjs';
import { hostServicePaths, preflightHostService, installHostService, hostServiceStatus, stopHostService, setHostServiceAutostart, stageHostRuntime, startHostService, hostServiceIdentity } from './host-service.mjs';
import { nativeServicePaths, preflightNativeService, installNativeService, nativeServiceStatus, stopNativeService, setNativeServiceAutostart, startNativeService, nativeServiceIdentity } from './host-native-service.mjs';
import { ensureHostDirectory, writeHostFile, readHostFile, assertSharedHostPath } from './host-files.mjs';
import { readRuntimeStatus } from './host-runtime-status.mjs';
import {validateHostPolicy} from './validate.mjs';
import {readDirectRunnerEnv} from './direct-connect-client.mjs';
import {doctor} from './doctor.mjs';

function adapter(configDir,options={}) {
  const platform=options.platform ?? process.platform;
  if(platform==='linux') {
    const paths=hostServicePaths(configDir,options);
    return {id:'systemd-user',paths,preflight:()=>preflightHostService(paths,options),
      autostart:enabled=>setHostServiceAutostart(paths,enabled,options),
      status:()=>hostServiceStatus(paths,options),stop:()=>stopHostService(paths,options),
      start:()=>startHostService(paths,options),identity:()=>hostServiceIdentity(paths),
      install:details=>installHostService(paths,{...options,...details})};
  }
  if(platform==='win32' || platform==='darwin') {
    const paths=nativeServicePaths(configDir,options);
    return {id:paths.adapter,paths,preflight:()=>preflightNativeService(paths,options),
      autostart:enabled=>setNativeServiceAutostart(paths,enabled,options),
      status:()=>nativeServiceStatus(paths,options),stop:()=>stopNativeService(paths,options),
      start:()=>startNativeService(paths,options),identity:()=>nativeServiceIdentity(paths,options),
      install:details=>installNativeService(paths,{...options,...details})};
  }
  return null;
}

function autostartDetails(adapter,enabled) {
  return {enabled:typeof enabled==='boolean' ? enabled : null,
    supported:['windows-task','systemd-user','launchd'].includes(adapter),
    scope:['windows-task','launchd'].includes(adapter) ? 'user-login' : adapter==='systemd-user' ? 'systemd-user-session' : 'unsupported',
    condition:['windows-task','launchd'].includes(adapter) ? 'Starts after this user signs in; the computer must be awake.' :
      adapter==='systemd-user' ? 'Starts with the systemd user manager; WSL must already be running when applicable.' :
        'Independent autostart controls are not supported on this platform.'};
}

export function persistenceStatus(configDir,options={}) {
  const impl=adapter(configDir,options);
  if(!impl) return {adapter:'foreground',installed:false,active:false,autostart:autostartDetails('foreground',false)};
  // No receipt means no owned service. Setup still probes for foreign name
  // collisions before it installs; status need not require a user manager.
  const receipt=impl.paths.receiptPath;
  if(!existsSync(receipt) && !(impl.paths.unitPath && existsSync(impl.paths.unitPath))) {
    return {adapter:impl.id,installed:false,active:false,autostart:autostartDetails(impl.id,false)};
  }
  const {autostartEnabled,...state}=impl.status();
  return {...state,adapter:impl.id,autostart:autostartDetails(impl.id,autostartEnabled),runtime:(options.runtimeStatus??readRuntimeStatus)(configDir)};
}

export function preparePersistence(configDir,{mode='auto',...options}={}) {
  assertBridge(['auto','background','foreground','manual'].includes(mode),'HOST_USAGE_INVALID','Unknown persistence mode');
  const impl=adapter(configDir,options);
  if(mode==='manual') return {mode,install:async()=>({active:false,manual:true,adapter:'none'})};
  if(mode==='foreground') {
    const current=persistenceStatus(configDir,options);
    assertBridge(!current.active,'HOST_ALREADY_RUNNING','A managed background Host is already active; stop it before starting foreground mode');
    return {mode,install:async()=>({active:false,adapter:'foreground',persistence:false})};
  }
  try {
    assertBridge(impl,'HOST_SERVICE_UNSUPPORTED','No background adapter for this platform');
    assertSharedHostPath(configDir,options);
    impl.preflight();
    const runtimePaths=hostServicePaths(configDir,options);
    const daemonPath=stageHostRuntime(runtimePaths,options);
    for(const path of [runtimePaths.runtimeRoot,daemonPath,process.execPath])assertSharedHostPath(path,options);
    return {mode:'background',adapter:impl.id,install:details=>impl.install({...details,daemonPath,
      startupStatus:()=>{
        const state=readRuntimeStatus(configDir);
        return {...state,localReady:state.localReady && state.daemonPath===daemonPath};
      }})};
  } catch(error) {
    const unavailable=['HOST_SERVICE_UNAVAILABLE','HOST_SERVICE_UNSUPPORTED'].includes(error.code);
    // Never hide a conflicting/unsafe installation, partial claim, or a failed
    // start behind fallback. An existing registration requires explicit repair.
    const hasReceipt=impl && existsSync(impl.paths.receiptPath);
    if(mode!=='auto' || !unavailable || hasReceipt || (options.platform??process.platform)==='win32') throw error;
    return {mode:'foreground',fallbackReason:error.code,
      install:async()=>({active:false,adapter:'foreground',persistence:false,fallbackReason:error.code})};
  }
}

export function stopPersistence(configDir,options={}) {
  const impl=adapter(configDir,options);
  assertBridge(impl,'HOST_SERVICE_UNSUPPORTED','No managed background adapter; stop a foreground Host with Ctrl+C');
  return impl.stop();
}

function controlLock(configDir,options) {
  const user=userInfo();
  assertBridge(user.uid!==0 && user.username!=='root','HOST_ROOT_DENIED','Run Host controls as your ordinary user, not root');
  const impl=adapter(configDir,options);
  assertBridge(impl,'HOST_SERVICE_UNSUPPORTED','No background adapter; use an explicit foreground session');
  assertBridge(existsSync(configDir),'HOST_SERVICE_UNAVAILABLE','No existing Host configuration; run setup first');
  ensureHostDirectory(configDir);
  const lock=resolve(configDir,'.setup-lock');
  try {mkdirSync(lock,{mode:0o700});}
  catch(error){if(error.code!=='EEXIST')throw error;throw new BridgeError('HOST_SETUP_BUSY','Another Host setup or control owns this configuration');}
  const release=()=>{if(existsSync(resolve(lock,'owner.json')))unlinkSync(resolve(lock,'owner.json'));rmdirSync(lock);};
  try {
    writeHostFile(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid})+'\n');
    assertBridge(!existsSync(resolve(configDir,'maintenance-pending.json')),'HOST_MAINTENANCE_INCOMPLETE','Reconcile interrupted maintenance before controlling Host');
    assertBridge(existsSync(impl.paths.receiptPath),'HOST_SERVICE_UNAVAILABLE','No owned background Host is installed; run setup --background first');
    return {impl,release,user};
  } catch(error){release();throw error;}
}

function alive(pid,options) {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  if(options.processAlive)return options.processAlive(pid);
  try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}

function pairedIdentity(configDir,user) {
  assertBridge(!existsSync(resolve(configDir,'.pending-runner.env')),'HOST_CONNECT_INCOMPLETE','A pairing claim is pending; retain it and reconcile before starting');
  for(const file of ['host.json','direct-runner.env'])assertBridge(existsSync(resolve(configDir,file)),
    'HOST_CONFIG_INCOMPLETE','Existing Host identity is incomplete; restore its matching files without re-pairing');
  const policy=JSON.parse(readHostFile(resolve(configDir,'host.json')));
  validateHostPolicy(policy);
  assertBridge(policy.directExec?.serviceUser===user.username,'HOST_USER_MISMATCH','This Host belongs to another OS user');
  readHostFile(resolve(configDir,'direct-runner.env'));readDirectRunnerEnv(resolve(configDir,'direct-runner.env'));
  return policy.host.id;
}

// Demand start is separate from installation and future login startup. It never
// authorizes, pairs, stages a runtime or silently changes an installed action.
export async function startPersistence(configDir,options={}) {
  const {impl,release,user}=controlLock(configDir,options);
  try {
    const hostId=pairedIdentity(configDir,user);
    assertSharedHostPath(configDir,options);
    const before=persistenceStatus(configDir,options),identity=impl.identity();
    assertBridge(before.installed && typeof before.autostart.enabled==='boolean','HOST_SERVICE_FAILED','Cannot verify the existing background service and startup setting');
    assertBridge(impl.id!=='windows-task'||identity.detachedConsole===true,'HOST_SERVICE_UPGRADE_REQUIRED',
      'This legacy Windows launcher requires an explicit Host upgrade before background start; retain its configuration');
    if(before.active){
      assertBridge(before.runtime.localReady && before.runtime.daemonPath===identity.daemonPath,'HOST_SERVICE_FAILED',
        'The background service is active but not ready; inspect status before another start');
      return {...before,hostId,mode:'background',reused:true,remoteExecutionVerified:false};
    }
    assertBridge(!alive(before.runtime.pid,options),'HOST_FOREGROUND_CONFLICT','A live process still owns this Host configuration; do not start a duplicate');
    assertBridge((options.doctorImpl??doctor)({hostPolicyPath:resolve(configDir,'host.json')}).ok,'HOST_DOCTOR_FAILED',
      'Local Host validation failed; repair this configuration rather than pairing again');
    await impl.start();
    let stable=0;
    for(let i=0;i<(options.startupAttempts??30);i++){
      const current=persistenceStatus(configDir,options);
      stable=current.active && current.runtime.localReady && current.runtime.daemonPath===identity.daemonPath &&
        current.autostart.enabled===before.autostart.enabled?stable+1:0;
      if(stable>=2)return {...current,hostId,mode:'background',reused:true,remoteExecutionVerified:false};
      await delay(options.startupDelayMs??250);
    }
    throw new BridgeError('HOST_SERVICE_FAILED','The installed Host did not become ready; pairing is retained. Inspect status before retrying');
  } finally {release();}
}

export async function stopPersistenceAndWait(configDir,options={}) {
  const {impl,release}=controlLock(configDir,options);
  try {
    // Manager ownership is authoritative for stopping. Optional diagnostics may
    // be stale/corrupt (including after a clock correction) and must never keep
    // an explicitly stopped service running.
    const before=impl.status();
    assertBridge(before.installed,'HOST_SERVICE_UNAVAILABLE','No owned background Host is installed');
    let runtime,diagnosticUnavailable=false;
    try {runtime=(options.runtimeStatus??readRuntimeStatus)(configDir);}catch{diagnosticUnavailable=true;}
    const result=impl.stop();
    for(let i=0;i<(options.stopAttempts??30);i++){
      const {autostartEnabled,...current}=impl.status();
      if(!current.active && autostartEnabled===false && !alive(runtime?.pid,options)){
        if(diagnosticUnavailable)throw new BridgeError('HOST_SERVICE_FAILED',
          'The owned background task was stopped and automatic startup is off, but daemon exit could not be verified from invalid local diagnostics; pairing is retained',
          {taskStopped:true,autostartDisabled:true,daemonExitVerified:false});
        return {...result,...current,adapter:impl.id,autostart:autostartDetails(impl.id,autostartEnabled),stopped:true,credentialsRetained:true};
      }
      await delay(options.stopDelayMs??100);
    }
    throw new BridgeError('HOST_SERVICE_FAILED','Host stop could not be verified; identity is retained. Inspect status before retrying');
  } finally {release();}
}

export function setPersistenceAutostart(configDir,enabled,options={}) {
  assertBridge(typeof enabled==='boolean','HOST_USAGE_INVALID','Autostart must be on or off');
  const user=userInfo();
  assertBridge(user.uid!==0 && user.username!=='root','HOST_ROOT_DENIED','Run Host settings as your ordinary user, not root');
  assertBridge(['linux','win32','darwin'].includes(options.platform ?? process.platform),'HOST_SERVICE_UNSUPPORTED','No supported autostart adapter');
  const impl=adapter(configDir,options);
  assertBridge(impl && ['windows-task','systemd-user','launchd'].includes(impl.id),'HOST_SERVICE_UNSUPPORTED','No supported autostart adapter');
  assertBridge(existsSync(configDir),'HOST_SERVICE_UNAVAILABLE','Run setup --background before changing autostart');
  ensureHostDirectory(configDir);
  const lock=resolve(configDir,'.setup-lock');
  try {mkdirSync(lock,{mode:0o700});}
  catch(error){if(error.code!=='EEXIST')throw error;throw new BridgeError('HOST_SETUP_BUSY','Another Host setup or maintenance operation is in progress');}
  try {
    writeHostFile(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid})+'\n');
    assertBridge(!existsSync(resolve(configDir,'maintenance-pending.json')),'HOST_MAINTENANCE_INCOMPLETE','Reconcile the interrupted maintenance transaction before changing settings');
    const {autostartEnabled,...state}=impl.autostart(enabled);
    return {...state,adapter:impl.id,autostart:autostartDetails(impl.id,autostartEnabled),runtime:readRuntimeStatus(configDir)};
  } finally {if(existsSync(resolve(lock,'owner.json'))) unlinkSync(resolve(lock,'owner.json'));rmdirSync(lock);}
}
