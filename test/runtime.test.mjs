import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeRequest } from '../src/runtime.mjs';

const fixture=resolve('test/fixtures/project'), dataFixture=resolve('test/fixtures/data');
function git(cwd,args){const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'}); if(r.status!==0) throw new Error(r.stderr); return r.stdout.trim();}
function setup(){
 const root=mkdtempSync(join(tmpdir(),'bridge-test-')); const repo=join(root,'repo'),data=join(root,'data'),out=join(root,'out'); cpSync(fixture,repo,{recursive:true}); cpSync(dataFixture,data,{recursive:true}); mkdirSync(join(data,'results'),{recursive:true});
 git(repo,['init','-b','main']); git(repo,['config','user.email','test@example.com']); git(repo,['config','user.name','Bridge Test']); git(repo,['add','.']); git(repo,['commit','-m','fixture']); const sha=git(repo,['rev-parse','HEAD']);
 const host={version:1,host:{id:'test-host'},repositories:{'example/project':{runnerClasses:['test-runner','bridge-sandbox'],resources:{'test-data':{root:data,read:['catalog/**','raw/**','results/**'],write:['results/**']}},workspaceExec:{enabled:true,runnerClass:'bridge-sandbox',serviceUser:userInfo().username,maxArgv:16,maxSeconds:10,stdoutBytes:4096,stderrBytes:4096}}}}; const hostPath=join(root,'host.json'); writeFileSync(hostPath,JSON.stringify(host));
 return {root,repo,data,out,sha,hostPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
function request(s,cap='inspect-data',parameters={dataset_id:'demo'},policySha=s.sha,targetSha=s.sha){mkdirSync(join(s.repo,'.bridge','requests'),{recursive:true}); const p=join(s.repo,'.bridge','requests','request.json'); writeFileSync(p,JSON.stringify({schemaVersion:1,requestId:'request-1234',repository:'example/project',target:{ref:'main',sha:targetSha},policy:{ref:'main',sha:policySha},capability:cap,parameters})); return p;}

test('executes trusted observe capability and redacts host resource roots from cloud evidence',async()=>{const s=setup(); try{
 const result=await executeRequest({requestPath:request(s),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
 assert.equal(result.status,'SUCCEEDED');
 assert.equal(result.evidence.report.content,JSON.stringify({dataset_id:'demo',sample:'real-local-sample',root:'<bridge-resource:test-data>'}));
 assert.equal(JSON.parse(result.evidence.stdout).root,'<bridge-resource:test-data>');
 assert.equal(JSON.stringify(result).includes(s.data),false);
 assert.equal(result.runner.hostId,'test-host');
 const persisted=readFileSync(join(s.out,'bridge-result.json'),'utf8');
 assert.ok(persisted.includes('inspect-data'));
 assert.equal(persisted.includes(s.data),false);
}finally{s.cleanup();}});

test('candidate-only capability is denied because policy is loaded from trusted SHA',async()=>{const s=setup(); try{const trusted=s.sha; const policy=JSON.parse(readFileSync(join(s.repo,'.bridge/project.json'),'utf8')); policy.capabilities['candidate-only']={class:'verify',runner:'research',command:{argv:['node','-e','process.exit(0)']}}; writeFileSync(join(s.repo,'.bridge/project.json'),JSON.stringify(policy)); git(s.repo,['add','.bridge/project.json']); git(s.repo,['commit','-m','candidate adds authority']); const target=git(s.repo,['rev-parse','HEAD']); await assert.rejects(()=>executeRequest({requestPath:request(s,'candidate-only',{},trusted,target),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='UNKNOWN_CAPABILITY');}finally{s.cleanup();}});

test('unknown resource is denied',async()=>{const s=setup(); try{const host=JSON.parse(readFileSync(s.hostPath,'utf8')); host.repositories['example/project'].resources={}; writeFileSync(s.hostPath,JSON.stringify(host)); await assert.rejects(()=>executeRequest({requestPath:request(s),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='HOST_RESOURCE_DENIED');}finally{s.cleanup();}});

test('execution failures redact granted host resource roots',async()=>{const s=setup(); try{
 await assert.rejects(
   ()=>executeRequest({requestPath:request(s,'path-error',{}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),
   e=>e.code==='EXECUTION_FAILED' && !JSON.stringify(e.details).includes(s.data) && JSON.stringify(e.details).includes('<bridge-resource:test-data>/raw')
 );
}finally{s.cleanup();}});

test('target SHA mismatch fails stale',async()=>{const s=setup(); try{await assert.rejects(()=>executeRequest({requestPath:request(s,'inspect-data',{dataset_id:'demo'},s.sha,'0'.repeat(40)),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='TARGET_STALE');}finally{s.cleanup();}});

test('workspace mutation is rejected',async()=>{const s=setup(); try{await assert.rejects(()=>executeRequest({requestPath:request(s,'mutate-workspace',{}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='WORKSPACE_MUTATED');}finally{s.cleanup();}});

test('oversized stdout is rejected',async()=>{const s=setup(); try{await assert.rejects(()=>executeRequest({requestPath:request(s,'huge-output',{}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='OUTPUT_LIMIT_EXCEEDED');}finally{s.cleanup();}});

test('policy SHA missing from checkout fails stale',async()=>{const s=setup(); try{await assert.rejects(()=>executeRequest({requestPath:request(s,'inspect-data',{dataset_id:'demo'},'f'.repeat(40),s.sha),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='POLICY_STALE');}finally{s.cleanup();}});

test('request file outside repository is denied',async()=>{const s=setup(); try{const outside=join(s.root,'outside.json'); writeFileSync(outside,JSON.stringify({schemaVersion:1})); await assert.rejects(()=>executeRequest({requestPath:outside,repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='INVALID_REQUEST');}finally{s.cleanup();}});

test('target command does not inherit GitHub or token-like credentials',async()=>{const s=setup(); const old={GITHUB_TOKEN:process.env.GITHUB_TOKEN,AGENT_JOB_WRITE_TOKEN:process.env.AGENT_JOB_WRITE_TOKEN,RUNNER_TEMP:process.env.RUNNER_TEMP}; try{process.env.GITHUB_TOKEN='secret';process.env.AGENT_JOB_WRITE_TOKEN='secret2';process.env.RUNNER_TEMP='/tmp/private';const result=await executeRequest({requestPath:request(s,'token-check',{}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}); const report=JSON.parse(result.evidence.report.content); assert.deepEqual(report.leaked,[]);}finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}s.cleanup();}});

test('symlink artifacts are denied',async()=>{const s=setup(); try{await assert.rejects(()=>executeRequest({requestPath:request(s,'symlink-output',{}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='EVIDENCE_INVALID');}finally{s.cleanup();}});

test('declared report path does not authorize sibling workspace mutations',async()=>{const s=setup(); try{await assert.rejects(()=>executeRequest({requestPath:request(s,'unexpected-output',{}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),e=>e.code==='WORKSPACE_MUTATED');}finally{s.cleanup();}});


test('workspace-exec reuses the checked out Run workspace without a nested worktree', async()=> {
  const s=setup();
  try {
    const params={argv:['node','-e',"require('fs').writeFileSync('shared.txt','x'); process.stdout.write('ok')"],cwd:'.'};
    const result=await executeRequest({requestPath:request(s,'workspace-exec',params),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(result.runner.class,'bridge-sandbox');
    assert.equal(result.execution.sharedWorkspace,true);
    assert.equal(result.evidence.stdout,'ok');
    assert.equal(existsSync(join(s.repo,'shared.txt')),true);
  } finally { s.cleanup(); }
});

test('workspace-exec does not receive Bridge logical resource mappings', async()=> {
  const s=setup();
  try {
    const params={argv:['node','-e',"process.stdout.write(String(process.env.TEST_DATA_DIR||''))"]};
    const result=await executeRequest({requestPath:request(s,'workspace-exec',params),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.evidence.stdout,'');
  } finally { s.cleanup(); }
});

test('workspace-exec isolates HOME from runner credential state', async()=> {
  const s=setup();
  const previous=process.env.HOME;
  try {
    const originalHome=join(s.root,'original-home');
    mkdirSync(join(originalHome,'.ssh'),{recursive:true});
    writeFileSync(join(originalHome,'.ssh','credential'),'secret');
    process.env.HOME=originalHome;
    const params={argv:['node','-e',"process.stdout.write(String(require('fs').existsSync(process.env.HOME+'/.ssh/credential')))"]};
    const result=await executeRequest({requestPath:request(s,'workspace-exec',params),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.evidence.stdout,'false');
  } finally {
    if(previous===undefined) delete process.env.HOME; else process.env.HOME=previous;
    s.cleanup();
  }
});

test('workspace-exec fails closed on service-user mismatch', async()=> {
  const s=setup();
  try {
    const host=JSON.parse(readFileSync(s.hostPath,'utf8'));
    host.repositories['example/project'].workspaceExec.serviceUser='definitely-not-current-user';
    writeFileSync(s.hostPath,JSON.stringify(host));
    await assert.rejects(
      ()=>executeRequest({requestPath:request(s,'workspace-exec',{argv:['node','-e','process.exit(0)']}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),
      e=>e.code==='HOST_RESOURCE_DENIED'
    );
  } finally { s.cleanup(); }
});

test('workspace-exec requires both project and host opt-in', async()=> {
  const s=setup();
  try {
    const host=JSON.parse(readFileSync(s.hostPath,'utf8'));
    host.repositories['example/project'].workspaceExec.enabled=false;
    writeFileSync(s.hostPath,JSON.stringify(host));
    await assert.rejects(
      ()=>executeRequest({requestPath:request(s,'workspace-exec',{argv:['node','-e','process.exit(0)']}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),
      e=>e.code==='HOST_RESOURCE_DENIED'
    );
  } finally { s.cleanup(); }
});

test('workspace-exec rejects cwd traversal and argv overflow', async()=> {
  const s=setup();
  try {
    await assert.rejects(
      ()=>executeRequest({requestPath:request(s,'workspace-exec',{argv:['node','-e','process.exit(0)'],cwd:'../'}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),
      e=>e.code==='PARAMETER_DENIED'
    );
    await assert.rejects(
      ()=>executeRequest({requestPath:request(s,'workspace-exec',{argv:Array.from({length:17},()=> 'x')}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out}),
      e=>e.code==='PARAMETER_DENIED'
    );
  } finally { s.cleanup(); }
});
