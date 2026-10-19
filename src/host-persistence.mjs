import { userInfo } from 'node:os';
import { existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BridgeError, assertBridge } from './errors.mjs';
import { hostServicePaths, preflightHostService, installHostService, hostServiceStatus, stopHostService, setHostServiceAutostart, stageHostRuntime } from './host-service.mjs';
import { nativeServicePaths, preflightNativeService, installNativeService, nativeServiceStatus, stopNativeService, setNativeServiceAutostart } from './host-native-service.mjs';
import { ensureHostDirectory, writeHostFile, assertSharedHostPath } from './host-files.mjs';
import { readRuntimeStatus } from './host-runtime-status.mjs';

function adapter(configDir,options={}) {
  const platform=options.platform ?? process.platform;
  if(platform==='linux') {
    const paths=hostServicePaths(configDir,options);
    return {id:'systemd-user',paths,preflight:()=>preflightHostService(paths,options),
      autostart:enabled=>setHostServiceAutostart(paths,enabled,options),
      status:()=>hostServiceStatus(paths,options),stop:()=>stopHostService(paths,options),
      install:details=>installHostService(paths,{...options,...details})};
  }
  if(platform==='win32' || platform==='darwin') {
    const paths=nativeServicePaths(configDir,options);
    return {id:paths.adapter,paths,preflight:()=>preflightNativeService(paths,options),
      autostart:enabled=>setNativeServiceAutostart(paths,enabled,options),
      status:()=>nativeServiceStatus(paths,options),stop:()=>stopNativeService(paths,options),
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
  return {...state,adapter:impl.id,autostart:autostartDetails(impl.id,autostartEnabled),runtime:readRuntimeStatus(configDir)};
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
    if(mode!=='auto' || !unavailable || hasReceipt) throw error;
    return {mode:'foreground',fallbackReason:error.code,
      install:async()=>({active:false,adapter:'foreground',persistence:false,fallbackReason:error.code})};
  }
}

export function stopPersistence(configDir,options={}) {
  const impl=adapter(configDir,options);
  assertBridge(impl,'HOST_SERVICE_UNSUPPORTED','No managed background adapter; stop a foreground Host with Ctrl+C');
  return impl.stop();
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
