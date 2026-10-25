import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {git,readTrustedProjectPolicyBytes} from '../src/git.mjs';
import {defaultProjectPolicy,defaultProjectPolicyBytes,policyProfile} from '../src/default-project-policy.mjs';
import {validateProjectPolicy} from '../src/validate.mjs';
import {executeRequest} from '../src/runtime.mjs';
import {prepareEditCandidate} from '../src/edit.mjs';
import {verifyEditCandidate} from '../src/verify-edit.mjs';
import {publishEditCandidate} from '../src/publish-edit.mjs';
const repository='example/project';
function fixture(t){
 const root=makeTestDirectory(join(tmpdir(),'bridge-default-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'repo'),remote=join(root,'remote.git');mkdirSync(repo);git(repo,['init','-b','main']);git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.com']);
 writeFileSync(join(repo,'README.md'),'before\n');git(repo,['add','.']);git(repo,['commit','-m','fixture']);const sha=git(repo,['rev-parse','HEAD']).trim();
 git(root,['init','--bare',remote]);git(repo,['remote','add','origin',pathToFileURL(remote).href]);git(repo,['push','origin','HEAD:refs/heads/agent/test']);
 const hostPath=join(root,'host.json');const host={version:1,host:{id:'default-host'},repositories:{[repository]:{runnerClasses:['bridge'],workspaceExec:{enabled:true,runnerClass:'bridge',serviceUser:userInfo().username},editing:{enabled:true,runnerClass:'bridge',serviceUser:userInfo().username}}}};
 writeFileSync(hostPath,JSON.stringify(host));const request={schemaVersion:1,requestId:'default-profile-1234',repository,target:{ref:'agent/test',sha},policy:{ref:'main',sha},operations:[{type:'replace-exact',path:'README.md',oldText:'before',newText:'after'}],verification:[{capability:'patch-integrity',parameters:{}}],commitSubject:'fix: test default profile'};
 const requestPath=join(root,'request.json');writeFileSync(requestPath,JSON.stringify(request));
 return {root,repo,remote,sha,host,hostPath,request,requestPath,prepareDir:join(root,'prepare'),verificationDir:join(root,'verification'),outputDir:join(root,'published')};
}
test('no policy file: exact deterministic profile executes, prepares, verifies and publishes through real Git',async t=>{
 const f=fixture(t);const bytes=readTrustedProjectPolicyBytes(f.repo,f.sha,repository);
 assert.equal(bytes,defaultProjectPolicyBytes(repository,f.sha));validateProjectPolicy(JSON.parse(bytes),repository);
 const check={schemaVersion:1,requestId:'default-check-1234',repository,target:{ref:'main',sha:f.sha},policy:{ref:'main',sha:f.sha},capability:'patch-integrity',parameters:{}};
 const checkPath=join(f.repo,'request.json');writeFileSync(checkPath,JSON.stringify(check));
 const execution=await executeRequest({requestPath:checkPath,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:join(f.root,'execution')});
 assert.equal(execution.policyProfile.projectTestsRun,false);
 writeFileSync(checkPath,JSON.stringify({...check,capability:'workspace-exec',parameters:{argv:[process.execPath,'-e','console.log("default exec")']}}));
 const generic=await executeRequest({requestPath:checkPath,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:join(f.root,'generic')});
 assert.equal(generic.status,'SUCCEEDED');rmSync(checkPath);
 const prepared=prepareEditCandidate({requestPath:f.requestPath,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.prepareDir});
 const verified=await verifyEditCandidate({prepareDir:f.prepareDir,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.verificationDir});
 assert.equal(verified.policyProfile.verification,'patch-integrity');assert.equal(verified.policyProfile.projectTestsRun,false);
 const digest=createHash('sha256').update(bytes).digest('hex');assert.equal(prepared.projectPolicySha256,digest);assert.equal(verified.projectPolicySha256,digest);
 const published=publishEditCandidate({prepareDir:f.prepareDir,verificationDir:f.verificationDir,repoPath:f.repo,outputDir:f.outputDir});
 assert.equal(published.projectPolicySha256,digest);assert.equal(git(f.remote,['rev-parse','refs/heads/agent/test']).trim(),prepared.candidateSha);
});
test('missing policy fallback does not forgive malformed or missing commit, invalid advanced policy, or repository mismatch',t=>{
 const f=fixture(t);
 for(const sha of ['main','a'.repeat(40),'--help'])assert.throws(()=>readTrustedProjectPolicyBytes(f.repo,sha,repository));
 assert.throws(()=>validateProjectPolicy(defaultProjectPolicy(repository,f.sha),'other/repo'),{code:'PROJECT_POLICY_INVALID'});
 mkdirSync(join(f.repo,'.bridge'));writeFileSync(join(f.repo,'.bridge/project.json'),'{broken');git(f.repo,['add','.']);git(f.repo,['commit','-m','bad policy']);
 const sha=git(f.repo,['rev-parse','HEAD']).trim();assert.equal(readTrustedProjectPolicyBytes(f.repo,sha,repository),'{broken');
 assert.throws(()=>JSON.parse(readTrustedProjectPolicyBytes(f.repo,sha,repository)));
 assert.equal(policyProfile(defaultProjectPolicy(repository,f.sha)).projectTestsRun,false);
});
test('default policy cannot bypass missing host grant or allowed branch',t=>{
 const f=fixture(t);
 for(const change of [{repository:'other/project'},{target:{...f.request.target,ref:'main'}}]){
  writeFileSync(f.requestPath,JSON.stringify({...f.request,...change}));
  assert.throws(()=>prepareEditCandidate({requestPath:f.requestPath,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.prepareDir}));
 }
});
test('default policy digest tampering cannot publish',async t=>{
 const f=fixture(t);prepareEditCandidate({requestPath:f.requestPath,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.prepareDir});
 await verifyEditCandidate({prepareDir:f.prepareDir,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.verificationDir});
 const path=join(f.prepareDir,'prepare-result.json'),value=JSON.parse(readFileSync(path));value.projectPolicySha256='0'.repeat(64);writeFileSync(path,JSON.stringify(value));
 assert.throws(()=>publishEditCandidate({prepareDir:f.prepareDir,verificationDir:f.verificationDir,repoPath:f.repo,outputDir:f.outputDir}));
});

test('default verification rejects whitespace-invalid patch rather than pretending project tests passed',async t=>{
 const f=fixture(t);f.request.operations[0].newText='after  ';writeFileSync(f.requestPath,JSON.stringify(f.request));
 prepareEditCandidate({requestPath:f.requestPath,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.prepareDir});
 await assert.rejects(verifyEditCandidate({prepareDir:f.prepareDir,repoPath:f.repo,hostPolicyPath:f.hostPath,outputDir:f.verificationDir}));
});
