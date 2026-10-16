import { existsSync, mkdirSync, unlinkSync, writeFileSync, rmdirSync, renameSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureHostDirectory, readHostFile, writeHostFile, assertSharedHostPath } from './host-files.mjs';
import { hostServicePaths, hostServiceStatus, setHostServiceAutostart, hostServiceIdentity, stopHostService, stageHostRuntime, installHostService, removeHostService, resumeHostService } from './host-service.mjs';
import { nativeServicePaths, nativeServiceStatus, setNativeServiceAutostart, stopNativeService, installNativeService, removeNativeService } from './host-native-service.mjs';
import { readRuntimeStatus } from './host-runtime-status.mjs';
import { assertBridge, BridgeError } from './errors.mjs';

// Local, explicit maintenance. No remote caller, new privilege or identity rotation.
export async function maintainHost(configDir,operation,{platform=process.platform,runtimeStatus=readRuntimeStatus,privateWrite=writeHostFile,processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}},...options}={}) {
  const user=userInfo();
  assertBridge(user.uid!==0 && user.username!=='root','HOST_ROOT_DENIED','Run Host maintenance as the ordinary owner, not root');
  assertBridge(['upgrade','rollback','uninstall'].includes(operation),'HOST_USAGE_INVALID','Unknown maintenance operation');
  ensureHostDirectory(configDir);
  const linux=platform==='linux';
  assertBridge(linux || ['win32','darwin'].includes(platform),'HOST_SERVICE_UNSUPPORTED','No maintenance adapter');
  const paths=linux ? hostServicePaths(configDir,{...options,platform}) : nativeServicePaths(configDir,{...options,platform});
  const sharedOptions={platform,realpath:options.realpath};
  // Uninstall remains available to stop an owned, unreachable installation.
  // Replacement must not tear down the old task before validating visibility.
  if(operation!=='uninstall') {
    assertSharedHostPath(configDir,sharedOptions);
    if(operation==='upgrade')assertSharedHostPath(process.execPath,sharedOptions);
  }
  const status=()=>linux ? hostServiceStatus(paths,options) : nativeServiceStatus(paths,options);
  const remove=async()=>{
    const runtime=runtimeStatus(configDir);
    if(linux) stopHostService(paths,options);else stopNativeService(paths,options);
    if(Number.isSafeInteger(runtime.pid)) {
      for(let i=0;i<(options.stopAttempts ?? 60) && processAlive(runtime.pid);i++) await delay(options.stopDelayMs ?? 250);
      assertBridge(!processAlive(runtime.pid),'HOST_SERVICE_STILL_RUNNING','The previous daemon is still running; its registration was retained');
    }
    assertBridge(!status().active,'HOST_SERVICE_STILL_RUNNING','The supervisor is still active; its registration was retained');
    return linux ? removeHostService(paths,options) : removeNativeService(paths,options);
  };
  const transaction=resolve(configDir,'maintenance-pending.json'),previous=resolve(configDir,'maintenance-previous.json');
  const lock=resolve(configDir,'.setup-lock');
  try {mkdirSync(lock,{mode:0o700});}
  catch(error){if(error.code!=='EEXIST')throw error;throw new BridgeError('HOST_SETUP_BUSY','Another setup or maintenance operation owns this configuration');}
  try {
    writeFileSync(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});
    assertBridge(!existsSync(transaction),'HOST_MAINTENANCE_INCOMPLETE','An interrupted maintenance transaction needs explicit operator recovery; retain maintenance-pending.json');
    const snapshot=()=>{
      const current=status();assertBridge(current.installed!==false && existsSync(paths.receiptPath),'HOST_SERVICE_UNAVAILABLE','No owned background registration is installed');
      const receipt=readHostFile(paths.receiptPath);
      const daemonPath=linux ? hostServiceIdentity(paths).daemonPath : JSON.parse(receipt).daemonPath;
      const runtime=runtimeStatus(configDir);
      if(runtime.localReady || (Number.isSafeInteger(runtime.pid) && processAlive(runtime.pid)))
        assertBridge(current.active && runtime.daemonPath===daemonPath,'HOST_FOREGROUND_CONFLICT','A live runtime is not bound to the active owned registration; stop it before maintenance');
      assertBridge(typeof current.autostartEnabled==='boolean','HOST_SERVICE_FAILED','Could not read the current autostart setting; registration was not changed');
      return {schemaVersion:1,platform,configDir,receipt,
        unit:paths.unitPath ? readHostFile(paths.unitPath) : null,active:current.active,
        daemonPath,autostartEnabled:current.autostartEnabled ?? current.active};
    };
    const validate=value=>{
      assertBridge(value?.schemaVersion===1 && value.platform===platform && value.configDir===configDir &&
        typeof value.receipt==='string' && typeof value.active==='boolean' &&
        (value.autostartEnabled===undefined || typeof value.autostartEnabled==='boolean') &&
        (paths.unitPath ? typeof value.unit==='string' : value.unit===null),'HOST_MAINTENANCE_INVALID','Backup does not belong to this Host');
      const receipt=JSON.parse(value.receipt);
      assertBridge(receipt?.schemaVersion===1 && (linux ?
        receipt.unitPath===paths.unitPath && receipt.unitSha256===createHash('sha256').update(value.unit).digest('hex') :
        receipt.configDir===configDir && receipt.name===paths.name && receipt.adapter===paths.adapter),
      'HOST_MAINTENANCE_INVALID','Backup registration does not match its owned receipt');
      // Older snapshots predate independent settings; preserve their original active-based behavior.
      return {...value,autostartEnabled:value.autostartEnabled ?? value.active};
    };
    const before=existsSync(paths.receiptPath) ? snapshot() : null;
    assertBridge(before || operation==='rollback','HOST_SERVICE_UNAVAILABLE','No owned registration is installed');
    if(!before) {
      const current=status(),runtime=runtimeStatus(configDir);
      assertBridge(!current.installed,'HOST_SERVICE_CONFLICT','An unowned registration exists');
      assertBridge(!runtime.localReady && !(Number.isSafeInteger(runtime.pid) && processAlive(runtime.pid)),
        'HOST_FOREGROUND_CONFLICT','A runtime is still running without an owned registration; stop it before rollback');
    }
    const target=operation==='rollback' ? validate(JSON.parse(readHostFile(previous))) : null;
    const runtimePaths=operation==='upgrade' ? hostServicePaths(configDir,{...options,platform}) : null;
    const daemonPath=runtimePaths ? stageHostRuntime(runtimePaths,options) : null;
    if(operation!=='uninstall') {
      const targetSpec=target ? JSON.parse(target.receipt) : null;
      for(const path of (runtimePaths ? [runtimePaths.runtimeRoot,daemonPath] : [targetSpec.nodePath,targetSpec.daemonPath]))
        assertSharedHostPath(path,sharedOptions);
      const policyPath=resolve(configDir,'host.json');
      if(existsSync(policyPath)) {
        const policy=JSON.parse(readHostFile(policyPath));
        for(const path of [policy.directExec?.root,policy.directExec?.stateDir,policy.directExec?.assetDir,policy.directExec?.exportDir].filter(Boolean))
          assertSharedHostPath(path,sharedOptions);
      }
    }
    const ready=daemon=>()=>{const state=runtimeStatus(configDir);return {...state,localReady:state.localReady && state.daemonPath===daemon};};
    const restoreAutostart=saved=>{
      if(linux) setHostServiceAutostart(paths,saved.autostartEnabled,options);
      else setNativeServiceAutostart(paths,saved.autostartEnabled,options);
    };
    const restore=async saved=>{
      if(existsSync(paths.receiptPath)) await remove();
      if(paths.unitPath) {assertBridge(!existsSync(paths.unitPath),'HOST_SERVICE_CONFLICT','Refusing to replace an unowned service file');writeFileSync(paths.unitPath,saved.unit,{mode:0o600,flag:'wx'});}
      privateWrite(paths.receiptPath,saved.receipt);
      if(linux) {
        if(saved.active) {
          assertBridge(saved.daemonPath,'HOST_MAINTENANCE_INVALID','Active legacy service backup has no daemon readiness identity');
          resumeHostService(paths,options);
          restoreAutostart(saved);
          let stable=0;
          for(let i=0;i<(options.startupAttempts ?? 60);i++) {
            stable=status().active && ready(saved.daemonPath)().localReady ? stable+1 : 0;
            if(stable>=2) return;
            await delay(options.startupDelayMs ?? 250);
          }
          throw new BridgeError('HOST_SERVICE_FAILED','Restored service did not report readiness');
        }
        restoreAutostart(saved);
      } else {
        const spec=JSON.parse(saved.receipt);
        await installNativeService(paths,{...options,nodePath:spec.nodePath,daemonPath:spec.daemonPath,start:saved.active,startupStatus:ready(spec.daemonPath)});
        restoreAutostart(saved);
      }
    };
    if(before?.active && linux) assertBridge(before.daemonPath,'HOST_MAINTENANCE_INVALID','Active legacy service has no readiness identity; stop it before maintenance');
    privateWrite(transaction,JSON.stringify({before})+'\n');
    try {
      if(before) await remove();
      if(operation==='upgrade') {
        const policy=JSON.parse(readHostFile(resolve(configDir,'host.json')));
        if(linux) await installHostService(paths,{...options,hostId:policy.host.id,daemonPath,start:before.active,startupStatus:ready(daemonPath)});
        else await installNativeService(paths,{...options,daemonPath,start:before.active,startupStatus:ready(daemonPath)});
        restoreAutostart(before);
      } else if(target) await restore(target);
      if(before) {
        if(existsSync(previous)) readHostFile(previous);
        const staged=resolve(configDir,`.maintenance-previous-${randomUUID()}.json`);
        try {privateWrite(staged,JSON.stringify(before)+'\n');renameSync(staged,previous);}
        finally {if(existsSync(staged)) unlinkSync(staged);}
      }
      unlinkSync(transaction);
      return {operation,completed:true,identityRetained:true,journalRetained:true,runtimeFilesRetained:true};
    } catch(error) {
      try {if(before) await restore(before);else if(existsSync(paths.receiptPath)) await remove();unlinkSync(transaction);}
      catch {throw new BridgeError('HOST_MAINTENANCE_RECOVERY_REQUIRED','Maintenance and automatic restoration failed; retain the pending snapshot and all Host files for operator recovery');}
      throw new BridgeError('HOST_MAINTENANCE_FAILED','Maintenance failed; the previous owned registration was restored');
    }
  } finally {if(existsSync(resolve(lock,'owner.json'))) unlinkSync(resolve(lock,'owner.json'));rmdirSync(lock);}
}
