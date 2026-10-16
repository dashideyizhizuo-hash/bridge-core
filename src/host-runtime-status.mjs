import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { assertBridge } from './errors.mjs';
import { readHostFile, writeHostFile, safeHostPath } from './host-files.mjs';

const phases=new Set(['ready','connected','retrying','stopped','failed']);
const statusPath=dir=>resolve(dir,'runtime-status.json');
const safeCode=value=>/^[A-Z][A-Z0-9_]{2,63}$/.test(value ?? '') ? value : 'HOST_RUNTIME_FAILED';

// Local diagnostics contain no credentials, remote text, command output or argv.
export function createRuntimeReporter({configDir,daemonPath,mode,clock=()=>Date.now()}={}) {
  const path=safeHostPath(statusPath(configDir));
  const startedAt=clock();let previous,updatedAt=0,lastContactAt;
  return ({phase,code}={})=>{
    assertBridge(phases.has(phase),'HOST_STATUS_INVALID','Unknown local runtime phase');
    const now=clock();
    if(phase==='connected') lastContactAt=now;
    if(previous===phase && now-updatedAt<30_000) return;
    const record={schemaVersion:1,pid:process.pid,daemonPath:safeHostPath(daemonPath),startedAt,updatedAt:now,phase,
      ...(mode!==undefined ? {mode} : {}),
      ...(lastContactAt!==undefined ? {lastContactAt} : {}),...(code!==undefined ? {code:safeCode(code)} : {})};
    if(existsSync(path)) readHostFile(path); // refuse a replaced/unsafe destination
    const temporary=resolve(configDir,`.runtime-status-${randomUUID()}.json`);
    try {writeHostFile(temporary,JSON.stringify(record)+'\n');renameSync(temporary,path);}
    finally {if(existsSync(temporary)) unlinkSync(temporary);}
    previous=phase;updatedAt=now;
  };
}

export function readRuntimeStatus(configDir,{clock=()=>Date.now(),alive=pid=>{
  try {process.kill(pid,0);return true;} catch {return false;}
}}={}) {
  const path=safeHostPath(statusPath(configDir));
  if(!existsSync(path)) return {localReady:false,connected:false,phase:'unknown'};
  const value=JSON.parse(readHostFile(path));
  assertBridge(value?.schemaVersion===1 && Number.isSafeInteger(value.pid) && value.pid>0 &&
    Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt>=value.startedAt && value.updatedAt<=clock()+60_000 && phases.has(value.phase) &&
    typeof value.daemonPath==='string' &&
    (value.mode===undefined || ['foreground','background'].includes(value.mode)) &&
    (value.lastContactAt===undefined || (Number.isSafeInteger(value.lastContactAt) &&
      value.lastContactAt>=value.startedAt && value.lastContactAt<=value.updatedAt)),
  'HOST_STATUS_INVALID','Local runtime diagnostic is invalid');
  const running=alive(value.pid) && clock()-value.updatedAt<=120_000;
  const localReady=running && ['ready','connected','retrying'].includes(value.phase);
  return {localReady,connected:localReady && value.phase==='connected',phase:value.phase,pid:value.pid,
    daemonPath:safeHostPath(value.daemonPath),updatedAt:value.updatedAt,
    ...(value.mode!==undefined ? {mode:value.mode} : {}),
    ...(value.lastContactAt!==undefined ? {lastContactAt:value.lastContactAt} : {}),
    ...(value.code!==undefined ? {code:safeCode(value.code)} : {})};
}
