import {pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeRequest } from '../src/runtime.mjs';
import { publishEditCandidate } from '../src/publish-edit.mjs';

const fixture=resolve('test/fixtures/project');

function git(cwd,args){
  const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
  if(r.status!==0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function setup({remote=false}={}){
  const root=mkdtempSync(join(tmpdir(),'bridge-batch-edit-'));
  const repo=join(root,'repo'),out=join(root,'out');
  cpSync(fixture,repo,{recursive:true});
  git(repo,['init','-b','main']);
  git(repo,['config','user.email','test@example.com']);
  git(repo,['config','user.name','Bridge Test']);
  git(repo,['add','.']);
  git(repo,['commit','-m','fixture']);
  const sha=git(repo,['rev-parse','HEAD']);
  let remotePath=null;
  if(remote){
    remotePath=join(root,'remote.git');
    const r=spawnSync('git',['init','--bare',remotePath],{encoding:'utf8'});
    if(r.status!==0) throw new Error(r.stderr);
    git(repo,['remote','add','origin',pathToFileURL(remotePath).href]);
    git(repo,['push','origin',`${sha}:refs/heads/agent/test`]);
  }
  const host={
    version:1,
    host:{id:'batch-edit-host'},
    repositories:{
      'example/project':{
        runnerClasses:['bridge-sandbox','test-runner'],
        workspaceExec:{
          enabled:true,runnerClass:'bridge-sandbox',serviceUser:userInfo().username,
          maxArgv:16,maxSeconds:10,stdoutBytes:4096,stderrBytes:4096
        },
        editing:{
          enabled:true,runnerClass:'bridge-sandbox',serviceUser:userInfo().username,
          maxOperations:8,maxPatchBytes:65536
        }
      }
    }
  };
  const hostPath=join(root,'host.json');
  writeFileSync(hostPath,JSON.stringify(host));
  return {root,repo,out,sha,hostPath,remotePath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

function request(s,steps,extra={}){
  mkdirSync(join(s.repo,'.bridge','requests'),{recursive:true});
  const path=join(s.repo,'.bridge','requests','batch-edit.json');
  writeFileSync(path,JSON.stringify({
    schemaVersion:1,
    mode:'batch',
    requestId:'batch-edit-request-0001',
    repository:'example/project',
    target:{ref:'agent/test',sha:s.sha},
    policy:{ref:'main',sha:s.sha},
    steps,
    commitSubject:'fix: shared batch edit',
    ...extra
  }));
  return path;
}

const editStep=()=>({
  id:'edit',type:'edit',
  operations:[{
    type:'replace-exact',
    path:'scripts/inspect.mjs',
    oldText:'const id=process.argv[2];',
    newText:'const id=String(process.argv[2]);'
  }]
});
const verifyStep=(capability='verify-sandbox')=>({id:'verify',type:'preset',capability,parameters:{}});

test('edited batch verifies the same workspace and emits exact candidate without moving HEAD',async()=>{
  const s=setup(); try{
    const result=await executeRequest({
      requestPath:request(s,[editStep(),verifyStep()]),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    });
    assert.equal(result.status,'VERIFIED');
    assert.equal(result.baseSha,s.sha);
    assert.equal(git(s.repo,['rev-parse','HEAD']),s.sha);
    assert.ok(/^[0-9a-f]{40}$/.test(result.candidateSha));
    assert.ok(git(s.repo,['show',`${result.candidateSha}:scripts/inspect.mjs`]).includes('String(process.argv[2])'));
    assert.ok(existsSync(join(s.out,'prepare','candidate.bundle')));
    assert.ok(existsSync(join(s.out,'verification','verification-result.json')));
    assert.deepEqual(result.steps.map(step=>step.status),['SUCCEEDED','SUCCEEDED']);
  } finally { s.cleanup(); }
});

test('trusted verifier cannot mutate an already-dirty edited file without invalidating verification',async()=>{
  const s=setup(); try{
    const result=await executeRequest({
      requestPath:request(s,[editStep(),verifyStep('verify-mutate-sandbox')]),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    });
    assert.notEqual(result.status,'VERIFIED');
    assert.equal(result.steps[1].status,'DENIED');
    assert.equal(result.steps[1].error.code,'WORKSPACE_MUTATED');
    assert.equal(result.candidateSha,undefined);
    assert.equal(existsSync(join(s.out,'prepare','candidate.bundle')),false);
  } finally { s.cleanup(); }
});

test('generic exec cannot smuggle tracked changes into a later edited candidate',async()=>{
  const s=setup(); try{
    const result=await executeRequest({
      requestPath:request(s,[
        {id:'smuggle',type:'exec',argv:['node','-e',"require('fs').appendFileSync('scripts/mutate.mjs',String.fromCharCode(10)+'// smuggle'+String.fromCharCode(10))"]},
        editStep(),verifyStep()
      ]),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    });
    assert.notEqual(result.status,'VERIFIED');
    assert.equal(result.steps[0].status,'SUCCEEDED');
    assert.equal(result.steps[1].status,'DENIED');
    assert.equal(result.steps[1].error.code,'WORKSPACE_MUTATED');
    assert.equal(result.steps[2].status,'SKIPPED');
  } finally { s.cleanup(); }
});

test('edited batch preflight requires a final trusted verify tail and one compatible runner',async()=>{
  const s=setup(); try{
    const missing=await executeRequest({
      requestPath:request(s,[editStep(),{id:'after',type:'exec',argv:['node','-e','process.exit(0)']}]),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:join(s.root,'missing')
    });
    assert.equal(missing.status,'DENIED');
    assert.equal(missing.error.code,'VERIFICATION_DENIED');

    const mismatch=await executeRequest({
      requestPath:request(s,[editStep(),{id:'verify',type:'preset',capability:'verify-clean',parameters:{}}]),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:join(s.root,'mismatch')
    });
    assert.equal(mismatch.status,'DENIED');
    assert.equal(mismatch.steps[1].error.code,'BATCH_RUNNER_MISMATCH');
  } finally { s.cleanup(); }
});

test('batch candidate remains separately publishable with exact lease and stale-target protection',async()=>{
  const s=setup({remote:true}); try{
    const result=await executeRequest({
      requestPath:request(s,[editStep(),verifyStep()]),
      repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out
    });
    assert.equal(result.status,'VERIFIED');
    const published=publishEditCandidate({
      prepareDir:join(s.out,'prepare'),
      verificationDir:join(s.out,'verification'),
      repoPath:s.repo,
      outputDir:join(s.root,'publish'),
      writeToken:'not-used-for-local-remote'
    });
    assert.equal(published.status,'PUBLISHED');
    assert.equal(published.candidateSha,result.candidateSha);
    assert.equal(git(s.remotePath,['rev-parse','refs/heads/agent/test']),result.candidateSha);
    assert.equal(git(s.repo,['rev-parse','HEAD']),s.sha);
  } finally { s.cleanup(); }
});
