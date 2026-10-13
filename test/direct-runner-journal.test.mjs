import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ambiguousReplayResult,
  cleanupDirectJournal,
  inspectDirectJournal,
  markDirectJournalCompleted,
  markDirectJournalStarted
} from '../src/direct-runner-journal.mjs';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'bridge-journal-'));
  const hostPolicy={directExec:{stateDir:join(root,'state')}};
  const request={
    schemaVersion:1,
    requestId:'direct-1234',
    hostId:'host-main',
    argv:['node','--version']
  };
  return {root,hostPolicy,request,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('journal marks start before execution and treats unfinished replay as ambiguous',()=>{
  const f=fixture();
  try {
    assert.equal(inspectDirectJournal(f).state,'NEW');
    const started=markDirectJournalStarted(f);
    assert.equal(started.state,'STARTED');
    const replay=inspectDirectJournal(f);
    assert.equal(replay.state,'AMBIGUOUS');
    assert.equal(replay.started.requestId,'direct-1234');
    if(process.platform!=='win32') {
      const mode=statSync(join(started.dir,'started.json')).mode & 0o777;
      assert.equal(mode,0o600);
    }
  } finally { f.cleanup(); }
});

test('journal persists result and replays it without re-execution',()=>{
  const f=fixture();
  try {
    markDirectJournalStarted(f);
    const result={
      schemaVersion:1,
      transport:'direct',
      requestId:'direct-1234',
      hostId:'host-main',
      status:'SUCCEEDED',
      evidence:{stdout:'ok',stderr:''}
    };
    markDirectJournalCompleted({...f,result});
    const replay=inspectDirectJournal(f);
    assert.equal(replay.state,'COMPLETED');
    assert.deepEqual(replay.result,result);
  } finally { f.cleanup(); }
});

test('ambiguous replay is fail-closed',()=>{
  const f=fixture();
  try {
    const result=ambiguousReplayResult(f.request);
    assert.equal(result.status,'FAILED');
    assert.equal(result.error.code,'DIRECT_EXEC_AMBIGUOUS_REPLAY');
  } finally { f.cleanup(); }
});

test('journal cleanup removes stale request directories only',()=>{
  const f=fixture();
  try {
    const started=markDirectJournalStarted(f);
    const record=JSON.parse(readFileSync(join(started.dir,'started.json'),'utf8'));
    assert.equal(record.requestId,'direct-1234');
    const result=cleanupDirectJournal({
      hostPolicy:f.hostPolicy,
      now:Date.now()+8*24*60*60*1000,
      retentionMs:7*24*60*60*1000
    });
    assert.equal(result.removed,1);
  } finally { f.cleanup(); }
});

// Release hardening: identity and destructive-maintenance negative controls.
for(const completed of [false,true]) test(`journal rejects changed request content (completed=${completed})`,()=>{
  const f=fixture();
  try {
    markDirectJournalStarted(f);
    if(completed) markDirectJournalCompleted({...f,result:{requestId:f.request.requestId,hostId:f.request.hostId,status:'SUCCEEDED'}});
    assert.throws(()=>inspectDirectJournal({...f,request:{...f.request,argv:['node','different-command']}}),
      error=>error.code==='DIRECT_JOURNAL_INVALID');
  } finally {f.cleanup();}
});
test('journal rejects a host path segment that escapes its state root',()=>{
  const f=fixture();
  try {assert.throws(()=>markDirectJournalStarted({...f,request:{...f.request,hostId:'..'}}),
    error=>error.code==='DIRECT_JOURNAL_INVALID');} finally {f.cleanup();}
});
test('journal retention preserves unrelated directories even under a host namespace',async()=>{
  const f=fixture();
  const {mkdirSync,writeFileSync,existsSync,utimesSync}=await import('node:fs');
  try {
    const dir=join(f.hostPolicy.directExec.stateDir,'host-main','unrelated-backup');
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'important.txt'),'keep');
    const old=new Date(Date.now()-8*24*60*60*1000);utimesSync(dir,old,old);
    cleanupDirectJournal({hostPolicy:f.hostPolicy});assert.equal(existsSync(join(dir,'important.txt')),true);
  } finally {f.cleanup();}
});
test('journal retention rejects invalid destructive retention settings',()=>{
  const f=fixture();
  try {for(const retentionMs of [-1,0,NaN]) assert.throws(()=>cleanupDirectJournal({...f,retentionMs}),
    error=>error.code==='DIRECT_JOURNAL_INVALID');} finally {f.cleanup();}
});
