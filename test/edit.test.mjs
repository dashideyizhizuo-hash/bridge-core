import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareEditCandidate } from '../src/edit.mjs';

const fixture = resolve('test/fixtures/project');

function git(cwd,args){
  const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
  if(r.status!==0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function setup(){
  const root=mkdtempSync(join(tmpdir(),'bridge-edit-test-'));
  const repo=join(root,'repo'),out=join(root,'out');
  cpSync(fixture,repo,{recursive:true});
  git(repo,['init','-b','main']);
  git(repo,['config','user.email','test@example.com']);
  git(repo,['config','user.name','Bridge Test']);
  git(repo,['add','.']);
  git(repo,['commit','-m','fixture']);
  const sha=git(repo,['rev-parse','HEAD']);
  const host={
    version:1,
    host:{id:'edit-host'},
    repositories:{
      'example/project':{
        runnerClasses:['bridge-sandbox'],
        editing:{
          enabled:true,
          runnerClass:'bridge-sandbox',
          serviceUser:userInfo().username,
          maxOperations:8,
          maxPatchBytes:65536
        }
      }
    }
  };
  const hostPath=join(root,'host.json');
  writeFileSync(hostPath,JSON.stringify(host));
  return {root,repo,out,sha,hostPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

function writeRequest(s,{ref='agent/test',targetSha=s.sha,policySha=s.sha,operations,commitSubject='fix: bounded edit'}={}){
  const path=join(s.root,'request.json');
  writeFileSync(path,JSON.stringify({
    schemaVersion:1,
    requestId:'edit-request-1234',
    repository:'example/project',
    target:{ref,sha:targetSha},
    policy:{ref:'main',sha:policySha},
    operations:operations ?? [{
      type:'replace-exact',
      path:'scripts/inspect.mjs',
      oldText:"const id=process.argv[2];",
      newText:"const id=String(process.argv[2]);"
    }],
    verification:[{capability:'verify-clean',parameters:{}}],
    commitSubject
  }));
  return path;
}

test('prepare-edit creates an isolated candidate receipt and bundle without mutating base checkout',()=>{
  const s=setup();
  try{
    const path=join(s.repo,'scripts/inspect.mjs');
    const before=readFileSync(path,'utf8');
    const result=prepareEditCandidate({
      requestPath:writeRequest(s),
      repoPath:s.repo,
      hostPolicyPath:s.hostPath,
      outputDir:s.out
    });
    assert.equal(result.status,'PREPARED');
    assert.equal(result.executionMode,'NO_TARGET_CODE');
    assert.equal(result.baseSha,s.sha);
    assert.equal(result.parentSha,s.sha);
    assert.deepEqual(result.changedFiles,['scripts/inspect.mjs']);
    assert.notEqual(result.candidateSha,s.sha);
    assert.equal(readFileSync(path,'utf8'),before);
    assert.ok(existsSync(join(s.out,'candidate.bundle')));
    assert.ok(existsSync(join(s.out,'prepare-result.json')));
    const candidate=git(s.repo,['show',`${result.candidateSha}:scripts/inspect.mjs`]);
    assert.ok(candidate.includes('String(process.argv[2])'));
    const verify=spawnSync('git',['-C',s.repo,'bundle','verify',join(s.out,'candidate.bundle')],{encoding:'utf8'});
    assert.equal(verify.status,0,verify.stderr);
  } finally { s.cleanup(); }
});

test('prepare-edit rejects protected Bridge policy paths',()=>{
  const s=setup();
  try{
    const operation={type:'replace-exact',path:'.bridge/project.json',oldText:'"version": 1',newText:'"version": 2'};
    assert.throws(()=>prepareEditCandidate({
      requestPath:writeRequest(s,{operations:[operation]}),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    }),e=>e.code==='EDIT_PATH_DENIED');
  } finally { s.cleanup(); }
});

test('prepare-edit rejects target branches outside trusted editing policy',()=>{
  const s=setup();
  try{
    assert.throws(()=>prepareEditCandidate({
      requestPath:writeRequest(s,{ref:'main'}),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    }),e=>e.code==='EDIT_BRANCH_DENIED');
  } finally { s.cleanup(); }
});

test('replace-exact fails closed when old text is ambiguous',()=>{
  const s=setup();
  try{
    const operation={type:'replace-exact',path:'scripts/inspect.mjs',oldText:'bridge-output',newText:'x'};
    assert.throws(()=>prepareEditCandidate({
      requestPath:writeRequest(s,{operations:[operation]}),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    }),e=>e.code==='EDIT_AMBIGUOUS');
  } finally { s.cleanup(); }
});

test('apply-patch cannot create a new file in M4 v1',()=>{
  const s=setup();
  try{
    const patch='diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n';
    assert.throws(()=>prepareEditCandidate({
      requestPath:writeRequest(s,{operations:[{type:'apply-patch',patch}]}),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    }),e=>e.code==='EDIT_CHANGE_TYPE_DENIED');
  } finally { s.cleanup(); }
});

test('prepare-edit fails stale when exact target SHA does not match checkout',()=>{
  const s=setup();
  try{
    assert.throws(()=>prepareEditCandidate({
      requestPath:writeRequest(s,{targetSha:'0'.repeat(40)}),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    }),e=>e.code==='TARGET_STALE');
  } finally { s.cleanup(); }
});

test('candidate policy cannot self-authorize a branch denied by trusted policy SHA',()=>{
  const s=setup();
  try{
    const trusted=s.sha;
    const policyPath=join(s.repo,'.bridge/project.json');
    const policy=JSON.parse(readFileSync(policyPath,'utf8'));
    policy.editing.allowedBranches.push('main');
    writeFileSync(policyPath,JSON.stringify(policy,null,2)+'\n');
    git(s.repo,['add','.bridge/project.json']);
    git(s.repo,['commit','-m','candidate broadens editing']);
    const target=git(s.repo,['rev-parse','HEAD']);
    assert.throws(()=>prepareEditCandidate({
      requestPath:writeRequest(s,{ref:'main',targetSha:target,policySha:trusted}),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    }),e=>e.code==='EDIT_BRANCH_DENIED');
  } finally { s.cleanup(); }
});
