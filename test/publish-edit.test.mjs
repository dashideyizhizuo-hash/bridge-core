import {pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareEditCandidate } from '../src/edit.mjs';
import { verifyEditCandidate } from '../src/verify-edit.mjs';
import { publishEditCandidate } from '../src/publish-edit.mjs';

const fixture=resolve('test/fixtures/project');

function git(cwd,args){
  const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
  if(r.status!==0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function setup({publish=true}={}){
  const root=mkdtempSync(join(tmpdir(),'bridge-publish-edit-'));
  const repo=join(root,'repo'),remote=join(root,'remote.git');
  const prepareDir=join(root,'prepare'),verifyDir=join(root,'verify'),publishDir=join(root,'publish');
  cpSync(fixture,repo,{recursive:true});
  if(!publish){
    const policyPath=join(repo,'.bridge','project.json');
    const policy=JSON.parse(readFileSync(policyPath,'utf8'));
    policy.editing.publish=false;
    writeFileSync(policyPath,JSON.stringify(policy,null,2)+'\n');
  }
  git(repo,['init','-b','main']);
  git(repo,['config','user.email','test@example.com']);
  git(repo,['config','user.name','Bridge Test']);
  git(repo,['add','.']);
  git(repo,['commit','-m','fixture']);
  const sha=git(repo,['rev-parse','HEAD']);
  const r=spawnSync('git',['init','--bare',remote],{encoding:'utf8'});
  if(r.status!==0) throw new Error(r.stderr);
  git(repo,['remote','add','origin',pathToFileURL(remote).href]);
  git(repo,['push','origin','HEAD:refs/heads/agent/test']);
  const host={
    version:1,
    host:{id:'publish-host'},
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
  const requestPath=join(root,'request.json');
  writeFileSync(requestPath,JSON.stringify({
    schemaVersion:1,
    requestId:'publish-edit-request-1234',
    repository:'example/project',
    target:{ref:'agent/test',sha},
    policy:{ref:'main',sha},
    operations:[{
      type:'replace-exact',
      path:'scripts/inspect.mjs',
      oldText:"const id=process.argv[2];",
      newText:"const id=String(process.argv[2]);"
    }],
    verification:[{capability:'verify-clean',parameters:{}}],
    commitSubject:'fix: publish bounded edit'
  }));
  return {root,repo,remote,prepareDir,verifyDir,publishDir,sha,hostPath,requestPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

async function prepareAndVerify(s){
  const prepared=prepareEditCandidate({
    requestPath:s.requestPath,
    repoPath:s.repo,
    hostPolicyPath:s.hostPath,
    outputDir:s.prepareDir
  });
  const verified=await verifyEditCandidate({
    prepareDir:s.prepareDir,
    repoPath:s.repo,
    hostPolicyPath:s.hostPath,
    outputDir:s.verifyDir
  });
  return {prepared,verified};
}

test('publish-edit publishes only the verified candidate with exact lease',async()=>{
  const s=setup();
  try{
    const {prepared}=await prepareAndVerify(s);
    const result=publishEditCandidate({
      prepareDir:s.prepareDir,
      verificationDir:s.verifyDir,
      repoPath:s.repo,
      outputDir:s.publishDir,
      writeToken:'not-used-for-local-remote'
    });
    assert.equal(result.status,'PUBLISHED');
    assert.equal(result.candidateSha,prepared.candidateSha);
    assert.equal(git(s.remote,['rev-parse','refs/heads/agent/test']),prepared.candidateSha);
    assert.equal(git(s.repo,['rev-parse','HEAD']),s.sha);
    const receipt=readFileSync(join(s.publishDir,'publish-result.json'),'utf8');
    assert.equal(receipt.includes('not-used-for-local-remote'),false);
  } finally { s.cleanup(); }
});

test('publish-edit fails closed when remote target moved after verification',async()=>{
  const s=setup();
  try{
    await prepareAndVerify(s);
    const path=join(s.repo,'scripts','mutate.mjs');
    writeFileSync(path,readFileSync(path,'utf8')+'\n');
    git(s.repo,['add','scripts/mutate.mjs']);
    git(s.repo,['commit','-m','concurrent change']);
    const moved=git(s.repo,['rev-parse','HEAD']);
    git(s.repo,['push','origin','HEAD:refs/heads/agent/test']);
    assert.throws(
      ()=>publishEditCandidate({prepareDir:s.prepareDir,verificationDir:s.verifyDir,repoPath:s.repo,outputDir:s.publishDir}),
      e=>e.code==='PUBLISH_STALE'
    );
    assert.equal(git(s.remote,['rev-parse','refs/heads/agent/test']),moved);
  } finally { s.cleanup(); }
});

test('publish-edit rejects tampered verification receipt',async()=>{
  const s=setup();
  try{
    await prepareAndVerify(s);
    const path=join(s.verifyDir,'verification-result.json');
    const receipt=JSON.parse(readFileSync(path,'utf8'));
    receipt.candidateSha='0'.repeat(40);
    writeFileSync(path,JSON.stringify(receipt));
    assert.throws(
      ()=>publishEditCandidate({prepareDir:s.prepareDir,verificationDir:s.verifyDir,repoPath:s.repo,outputDir:s.publishDir}),
      e=>e.code==='VERIFICATION_BINDING_MISMATCH'
    );
  } finally { s.cleanup(); }
});

test('publish-edit requires explicit trusted project publication authority',async()=>{
  const s=setup({publish:false});
  try{
    await prepareAndVerify(s);
    assert.throws(
      ()=>publishEditCandidate({prepareDir:s.prepareDir,verificationDir:s.verifyDir,repoPath:s.repo,outputDir:s.publishDir}),
      e=>e.code==='PUBLISH_DENIED'
    );
    assert.equal(git(s.remote,['rev-parse','refs/heads/agent/test']),s.sha);
  } finally { s.cleanup(); }
});
