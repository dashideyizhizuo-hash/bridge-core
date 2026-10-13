import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareEditCandidate } from '../src/edit.mjs';
import { verifyEditCandidate } from '../src/verify-edit.mjs';

const fixture=resolve('test/fixtures/project');

function git(cwd,args){
  const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
  if(r.status!==0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function setup(){
  const root=mkdtempSync(join(tmpdir(),'bridge-verify-edit-'));
  const repo=join(root,'repo'),prepareDir=join(root,'prepare'),verifyDir=join(root,'verify');
  cpSync(fixture,repo,{recursive:true});
  git(repo,['init','-b','main']);
  git(repo,['config','user.email','test@example.com']);
  git(repo,['config','user.name','Bridge Test']);
  git(repo,['add','.']);
  git(repo,['commit','-m','fixture']);
  const sha=git(repo,['rev-parse','HEAD']);
  const host={
    version:1,
    host:{id:'verify-host'},
    repositories:{
      'example/project':{
        runnerClasses:['bridge-sandbox','test-runner'],
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
  return {root,repo,prepareDir,verifyDir,sha,hostPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

function writeRequest(s,verification=[{capability:'verify-clean',parameters:{}}]){
  const path=join(s.root,'request.json');
  writeFileSync(path,JSON.stringify({
    schemaVersion:1,
    requestId:'verify-edit-request-1234',
    repository:'example/project',
    target:{ref:'agent/test',sha:s.sha},
    policy:{ref:'main',sha:s.sha},
    operations:[{
      type:'replace-exact',
      path:'scripts/inspect.mjs',
      oldText:"const id=process.argv[2];",
      newText:"const id=String(process.argv[2]);"
    }],
    verification,
    commitSubject:'fix: verified bounded edit'
  }));
  return path;
}

function prepare(s,verification){
  return prepareEditCandidate({
    requestPath:writeRequest(s,verification),
    repoPath:s.repo,
    hostPolicyPath:s.hostPath,
    outputDir:s.prepareDir
  });
}

test('verify-edit independently executes trusted verify capability and emits bound receipt',async()=>{
  const s=setup();
  try{
    const prepared=prepare(s);
    const result=await verifyEditCandidate({
      prepareDir:s.prepareDir,
      repoPath:s.repo,
      hostPolicyPath:s.hostPath,
      outputDir:s.verifyDir
    });
    assert.equal(result.status,'VERIFIED');
    assert.equal(result.candidateSha,prepared.candidateSha);
    assert.equal(result.baseSha,s.sha);
    assert.equal(result.verifications.length,1);
    assert.equal(result.verifications[0].capability,'verify-clean');
    assert.ok(existsSync(join(s.verifyDir,'verification-result.json')));
    assert.ok(existsSync(join(s.verifyDir,'step-0','bridge-result.json')));
  } finally { s.cleanup(); }
});

test('verify-edit denies observe capability in verification plan',async()=>{
  const s=setup();
  try{
    prepare(s,[{capability:'inspect-data',parameters:{dataset_id:'demo'}}]);
    await assert.rejects(
      ()=>verifyEditCandidate({prepareDir:s.prepareDir,repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.verifyDir}),
      e=>e.code==='VERIFICATION_DENIED'
    );
    assert.equal(existsSync(join(s.verifyDir,'verification-result.json')),false);
  } finally { s.cleanup(); }
});

test('verify-edit fails closed when target verification mutates candidate workspace',async()=>{
  const s=setup();
  try{
    prepare(s,[{capability:'mutate-workspace',parameters:{}}]);
    await assert.rejects(
      ()=>verifyEditCandidate({prepareDir:s.prepareDir,repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.verifyDir}),
      e=>e.code==='WORKSPACE_MUTATED'
    );
    assert.equal(existsSync(join(s.verifyDir,'verification-result.json')),false);
  } finally { s.cleanup(); }
});

test('verify-edit rejects tampered immutable request after prepare',async()=>{
  const s=setup();
  try{
    prepare(s);
    const requestPath=join(s.prepareDir,'request.json');
    const request=JSON.parse(readFileSync(requestPath,'utf8'));
    request.verification=[{capability:'mutate-workspace',parameters:{}}];
    writeFileSync(requestPath,JSON.stringify(request));
    await assert.rejects(
      ()=>verifyEditCandidate({prepareDir:s.prepareDir,repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.verifyDir}),
      e=>e.code==='REQUEST_DIGEST_MISMATCH'
    );
  } finally { s.cleanup(); }
});

test('verify-edit target capability cannot inherit GitHub/token-like environment',async()=>{
  const s=setup();
  const previous={
    GITHUB_TOKEN:process.env.GITHUB_TOKEN,
    BRIDGE_WRITE_TOKEN:process.env.BRIDGE_WRITE_TOKEN,
    RUNNER_TEMP:process.env.RUNNER_TEMP
  };
  try{
    process.env.GITHUB_TOKEN='secret';
    process.env.BRIDGE_WRITE_TOKEN='secret2';
    process.env.RUNNER_TEMP=s.root;
    prepare(s,[{capability:'token-check',parameters:{}}]);
    const result=await verifyEditCandidate({
      prepareDir:s.prepareDir,
      repoPath:s.repo,
      hostPolicyPath:s.hostPath,
      outputDir:s.verifyDir
    });
    assert.equal(result.status,'VERIFIED');
    const step=JSON.parse(readFileSync(join(s.verifyDir,'step-0','bridge-result.json'),'utf8'));
    const report=JSON.parse(step.evidence.report.content);
    assert.deepEqual(report.leaked,[]);
  } finally {
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
    s.cleanup();
  }
});
