import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { assertBridge } from './errors.mjs';

const HOST_ID=/^(?!\.\.?$)[A-Za-z0-9_.-]{1,128}$/;
const REQUEST_ID=/^[A-Za-z0-9._-]{8,160}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRequestId(value) {
  assertBridge(
    typeof value==='string' && REQUEST_ID.test(value),
    'DIRECT_JOURNAL_INVALID',
    'requestId is invalid for local journal'
  );
  return value;
}

export function directJournalRoot(hostPolicy) {
  const configured=hostPolicy?.directExec?.stateDir;
  return resolve(configured ?? resolve(homedir(),'.local','state','bridge','direct-exec'));
}

function requestDir(root,hostId,requestId) {
  assertBridge(typeof hostId==='string' && HOST_ID.test(hostId),
    'DIRECT_JOURNAL_INVALID','hostId is invalid for local journal');
  return resolve(root,hostId,safeRequestId(requestId));
}

function readJson(path,label) {
  try {
    return JSON.parse(readFileSync(path,'utf8'));
  } catch(error) {
    const wrapped=new Error(`${label} is unreadable or invalid`);
    wrapped.code='DIRECT_JOURNAL_INVALID';
    wrapped.cause=error;
    throw wrapped;
  }
}

function durableWrite(path,value) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  const fd=openSync(temp,'wx',0o600);
  try {
    writeFileSync(fd,JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp,path);
}

export function inspectDirectJournal({hostPolicy,request}) {
  const root=directJournalRoot(hostPolicy);
  const dir=requestDir(root,request.hostId,request.requestId);
  const startedPath=resolve(dir,'started.json');
  const resultPath=resolve(dir,'result.json');
  const expected=sha256(Buffer.from(JSON.stringify(request),'utf8'));

  if(existsSync(resultPath)) {
    const record=readJson(resultPath,'Direct Exec journal result');
    assertBridge(
      record?.requestId===request.requestId &&
      record?.hostId===request.hostId &&
      record?.result &&
      record.result.requestId===request.requestId &&
      record.result.hostId===request.hostId,
      'DIRECT_JOURNAL_INVALID',
      'Direct Exec journal result identity mismatch'
    );
    // Older results retain their digest in the execution result or start marker.
    const digest=record.requestSha256 ?? record.result.requestSha256 ??
      (existsSync(startedPath) ? readJson(startedPath,'Direct Exec journal start').requestSha256 : undefined);
    assertBridge(digest===expected &&
      (record.result.requestSha256===undefined || record.result.requestSha256===expected),
      'DIRECT_JOURNAL_INVALID','Direct Exec journal result request digest mismatch');
    return {state:'COMPLETED',dir,result:record.result};
  }

  if(existsSync(startedPath)) {
    const started=readJson(startedPath,'Direct Exec journal start');
    assertBridge(
      started?.requestId===request.requestId &&
      started?.hostId===request.hostId,
      'DIRECT_JOURNAL_INVALID',
      'Direct Exec journal start identity mismatch'
    );
    // Legacy markers without a digest remain ambiguous, never executable.
    assertBridge(started.requestSha256===undefined || started.requestSha256===expected,
      'DIRECT_JOURNAL_INVALID','Direct Exec journal start request digest mismatch');
    return {state:'AMBIGUOUS',dir,started};
  }

  return {state:'NEW',dir};
}

export function markDirectJournalStarted({hostPolicy,request}) {
  const current=inspectDirectJournal({hostPolicy,request});
  if(current.state!=='NEW') return current;

  mkdirSync(current.dir,{recursive:true,mode:0o700});
  const startedPath=resolve(current.dir,'started.json');
  const body={
    schemaVersion:1,
    requestId:request.requestId,
    hostId:request.hostId,
    requestSha256:sha256(Buffer.from(JSON.stringify(request),'utf8')),
    startedAt:new Date().toISOString()
  };
  try {
    const fd=openSync(startedPath,'wx',0o600);
    try {
      writeFileSync(fd,JSON.stringify(body));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return {state:'STARTED',dir:current.dir,started:body};
  } catch(error) {
    if(error?.code==='EEXIST') return inspectDirectJournal({hostPolicy,request});
    throw error;
  }
}

export function markDirectJournalCompleted({hostPolicy,request,result}) {
  assertBridge(result?.requestId===request.requestId && result?.hostId===request.hostId,
    'DIRECT_JOURNAL_INVALID','Direct Exec result identity does not match its request');
  const existing=inspectDirectJournal({hostPolicy,request});
  if(existing.state==='COMPLETED') return existing;
  const root=directJournalRoot(hostPolicy);
  const dir=requestDir(root,request.hostId,request.requestId);
  durableWrite(resolve(dir,'result.json'),{
    schemaVersion:1,
    requestId:request.requestId,
    hostId:request.hostId,
    requestSha256:sha256(Buffer.from(JSON.stringify(request),'utf8')),
    completedAt:new Date().toISOString(),
    result
  });
  return {state:'COMPLETED',dir,result};
}

export function ambiguousReplayResult(request) {
  const now=new Date().toISOString();
  return {
    schemaVersion:1,
    transport:'direct',
    requestId:request.requestId,
    hostId:request.hostId,
    status:'FAILED',
    evidence:{stdout:'',stderr:''},
    startedAt:now,
    completedAt:now,
    error:{
      code:'DIRECT_EXEC_AMBIGUOUS_REPLAY',
      message:'a prior execution started locally but no durable result was recorded; refusing automatic re-execution'
    }
  };
}

export function cleanupDirectJournal({
  hostPolicy,
  now=Date.now(),
  retentionMs=7*24*60*60*1000
}={}) {
  assertBridge(Number.isFinite(retentionMs) && retentionMs>=60*60*1000 && Number.isFinite(now),
    'DIRECT_JOURNAL_INVALID','journal retention must be at least one hour with a finite clock');
  const root=directJournalRoot(hostPolicy);
  if(!existsSync(root)) return {removed:0};
  let removed=0;

  let hostEntries=[];
  try {
    hostEntries=readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory());
  } catch {
    return {removed:0};
  }

  for(const hostEntry of hostEntries) {
    if(!HOST_ID.test(hostEntry.name)) continue;
    const hostPath=resolve(root,hostEntry.name);
    let requestEntries=[];
    try {
      requestEntries=readdirSync(hostPath,{withFileTypes:true}).filter(entry=>entry.isDirectory());
    } catch {
      continue;
    }
    for(const requestEntry of requestEntries) {
      if(!REQUEST_ID.test(requestEntry.name)) continue;
      const path=resolve(hostPath,requestEntry.name);
      try {
        const marker=existsSync(resolve(path,'started.json')) ? 'started.json' : 'result.json';
        const record=readJson(resolve(path,marker),'Direct Exec retention marker');
        if(record?.hostId!==hostEntry.name || record?.requestId!==requestEntry.name) continue;
        if(now-statSync(path).mtimeMs>retentionMs) {
          rmSync(path,{recursive:true,force:true});
          removed++;
        }
      } catch {}
    }
  }
  return {removed};
}
