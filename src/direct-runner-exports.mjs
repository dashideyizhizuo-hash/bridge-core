import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { assertBridge } from './errors.mjs';
import { validateDirectExecRequest } from './direct-exec.mjs';

function exportRoot(hostPolicy) {
  return resolve(
    hostPolicy?.directExec?.exportDir ??
    resolve(
      hostPolicy?.directExec?.stateDir ??
      resolve(homedir(),'.local','state','bridge','direct-exec'),
      'exports'
    )
  );
}

function runExportRoot(hostPolicy,request) {
  return resolve(exportRoot(hostPolicy),request.hostId,request.requestId);
}

export function prepareDirectExportPaths({
  hostPolicy,
  request,
  reset=false
}={}) {
  const validated=validateDirectExecRequest(request);
  const exports=validated.exports ?? [];
  if(exports.length===0) return [];
  const root=runExportRoot(hostPolicy,validated);
  mkdirSync(root,{recursive:true,mode:0o700});
  return exports.map((item,index)=>{
    const path=resolve(root,String(index).padStart(2,'0')+'-'+item.fileName);
    if(reset && existsSync(path)) {
      const stat=lstatSync(path);
      assertBridge(
        stat.isFile() || stat.isSymbolicLink(),
        'DIRECT_EXPORT_INVALID',
        'stale export path is not a file'
      );
      unlinkSync(path);
    }
    return path;
  });
}

export function collectDirectExports({
  request,
  exportPaths
}={}) {
  const validated=validateDirectExecRequest(request);
  const exports=validated.exports ?? [];
  if(exports.length===0) return [];
  assertBridge(
    Array.isArray(exportPaths) && exportPaths.length===exports.length,
    'DIRECT_EXPORT_INVALID',
    'export path count mismatch'
  );
  const collected=[];
  for(let index=0;index<exports.length;index++) {
    const spec=exports[index];
    const path=exportPaths[index];
    if(!existsSync(path)) {
      assertBridge(!spec.required,'DIRECT_EXPORT_MISSING','required export was not produced: '+spec.fileName);
      continue;
    }
    const stat=lstatSync(path);
    assertBridge(stat.isFile() && !stat.isSymbolicLink(),
      'DIRECT_EXPORT_INVALID','export must be a regular file: '+spec.fileName);
    assertBridge(stat.size>0 && stat.size<=spec.maxBytes,
      'DIRECT_EXPORT_INVALID','export size invalid: '+spec.fileName);
    const noFollow=constants.O_NOFOLLOW ?? 0;
    let fd;
    try {
      fd=openSync(path,constants.O_RDONLY|noFollow);
      const opened=fstatSync(fd);
      assertBridge(
        opened.isFile() &&
          opened.dev===stat.dev &&
          opened.ino===stat.ino &&
          opened.size===stat.size,
        'DIRECT_EXPORT_INVALID',
        'export path changed before secure read: '+spec.fileName
      );
      const bytes=readFileSync(fd);
      assertBridge(
        bytes.length===opened.size && bytes.length<=spec.maxBytes,
        'DIRECT_EXPORT_INVALID',
        'export size changed while reading: '+spec.fileName
      );
      collected.push({
        index,
        path,
        fileName:spec.fileName,
        mimeType:spec.mimeType,
        sizeBytes:bytes.length,
        sha256:createHash('sha256').update(bytes).digest('hex'),
        bytes
      });
    } finally {
      if(fd!==undefined) closeSync(fd);
    }
  }
  return collected;
}

export function cleanupDirectExportCache({
  hostPolicy,
  now=Date.now(),
  retentionMs=7*24*60*60*1000
}={}) {
  assertBridge(
    Number.isFinite(retentionMs) && retentionMs>=60*60*1000,
    'DIRECT_EXPORT_INVALID',
    'export cache retention must be at least one hour'
  );
  const root=exportRoot(hostPolicy);
  if(!existsSync(root)) return {removed:0};
  let removed=0;
  let hosts=[];
  try { hosts=readdirSync(root,{withFileTypes:true}); }
  catch { return {removed:0}; }
  for(const host of hosts) {
    if(!host.isDirectory()) continue;
    const hostPath=resolve(root,host.name);
    let runs=[];
    try { runs=readdirSync(hostPath,{withFileTypes:true}); } catch { continue; }
    for(const run of runs) {
      if(!run.isDirectory()) continue;
      const path=resolve(hostPath,run.name);
      try {
        const stat=lstatSync(path);
        if(now-stat.mtimeMs>retentionMs) {
          rmSync(path,{recursive:true,force:true});
          removed++;
        }
      } catch {}
    }
  }
  return {removed};
}
