import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { bootstrapProject } from '../src/bootstrap-project.mjs';

const BRIDGE_SHA='a'.repeat(40);

test('default bootstrap and CLI need no project file or verification arguments',()=>{
  const f=fixture();
  try {
    const result=bootstrapProject({repoPath:f.target,bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA});
    assert.equal(result.files.length,2);
    assert.equal(result.policyMode,'builtin');
    assert.equal(result.verifyArgv,null);
    assert.equal(existsSync(join(f.target,'.bridge','project.json')),false);
    const cli=spawnSync(process.execPath,[resolve('bin/bridge-runner.mjs'),'bootstrap-project','--repo',f.target,'--bridge-sha',BRIDGE_SHA,'--bridge-repository','fixture-owner/runtime'],{encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);
    assert.equal(JSON.parse(cli.stdout).files.every(file=>!file.changed),true);
    assert.equal(existsSync(join(f.target,'.bridge','project.json')),false);
    const policyCheck=spawnSync(process.execPath,[resolve('bin/bridge-runner.mjs'),'validate-project-policy','--repo',f.target,'--policy-sha',git(f.target,['rev-parse','HEAD']),'--repository','example/project'],{encoding:'utf8'});
    assert.equal(policyCheck.status,0,policyCheck.stderr);
  } finally { f.cleanup(); }
});

test('a custom runner without an advanced policy is rejected before creating mismatched workflows',()=>{
  const f=fixture();
  try {
    assert.throws(()=>bootstrapProject({repoPath:f.target,bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA,runnerClass:'custom'}),{code:'BOOTSTRAP_INVALID'});
    assert.equal(existsSync(join(f.target,'.github','workflows','bridge-gateway.yml')),false);
    assert.equal(existsSync(join(f.target,'.bridge','project.json')),false);
  } finally { f.cleanup(); }
});

test('default bootstrap cannot mislabel or overwrite an existing advanced setup',()=>{
  const f=fixture();
  try {
    bootstrapProject({repoPath:f.target,verify:['npm','test'],runnerClass:'bridge',bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA});
    const policy=readFileSync(join(f.target,'.bridge','project.json'),'utf8');
    const workflow=readFileSync(join(f.target,'.github','workflows','bridge-gateway.yml'),'utf8');
    assert.throws(()=>bootstrapProject({repoPath:f.target,bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA}),{code:'BOOTSTRAP_CONFLICT'});
    assert.equal(readFileSync(join(f.target,'.bridge','project.json'),'utf8'),policy);
    assert.equal(readFileSync(join(f.target,'.github','workflows','bridge-gateway.yml'),'utf8'),workflow);
  } finally { f.cleanup(); }
});

test('self-hosted bootstrap rejects missing, placeholder and injected runtime repository before writing',()=>{
  const f=fixture();
  try{
    for(const bridgeRepository of [undefined,'example/bridge','bad/repo\npermissions: write-all'])
      assert.throws(()=>bootstrapProject({repoPath:f.target,verify:['npm','test'],bridgeSha:BRIDGE_SHA,bridgeRepository}),{code:'BOOTSTRAP_INVALID'});
    assert.equal(existsSync(join(f.target,'.bridge','project.json')),false);
    assert.equal(existsSync(join(f.target,'.github','workflows','bridge-gateway.yml')),false);
  }finally{f.cleanup();}
});

function git(cwd,args) {
  return execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
}

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'bridge-bootstrap-'));
  const target=join(root,'target');
  mkdirSync(target);
  git(target,['init','-b','main']);
  git(target,['config','user.email','test@example.com']);
  git(target,['config','user.name','Bridge Test']);
  git(target,['remote','add','origin','git@github.com:example/project.git']);
  writeFileSync(join(target,'README.md'),'# project\n');
  git(target,['add','.']);
  git(target,['commit','-m','initial']);

  const hostPath=join(root,'host.json');
  writeFileSync(hostPath,JSON.stringify({
    version:1,
    host:{id:'host-main'},
    repositories:{},
    directExec:{
      enabled:true,
      serviceUser:userInfo().username,
      maxSeconds:900
    }
  },null,2)+'\n');

  return {root,target,hostPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('bootstrap creates canonical project policy and pinned workflows in one call',()=>{
  const f=fixture();
  try {
    const result=bootstrapProject({
      repoPath:f.target,
      verify:['npm','test'],
      bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA,
      runnerClass:'bridge-engineering',
      serviceUser:userInfo().username,
      hostPolicyPath:f.hostPath
    });
    assert.equal(result.repository,'example/project');
    assert.equal(result.bridgeSha,BRIDGE_SHA);
    assert.equal(result.files.filter(x=>x.changed).length,3);
    assert.equal(result.hostPolicy.changed,true);

    const policy=JSON.parse(readFileSync(join(f.target,'.bridge','project.json'),'utf8'));
    assert.equal(policy.project.repository,'example/project');
    assert.deepEqual(policy.capabilities.verify.command.argv,['npm','test']);
    assert.equal(policy.workspaceExec.enabled,true);
    assert.equal(policy.editing.publish,true);

    const gateway=readFileSync(join(f.target,'.github','workflows','bridge-gateway.yml'),'utf8');
    const publish=readFileSync(join(f.target,'.github','workflows','bridge-publish.yml'),'utf8');
    assert.match(gateway,/runs-on: \[self-hosted, linux, x64, bridge-engineering\]/);
    assert.ok(gateway.includes('fixture-owner/runtime@'+BRIDGE_SHA));
    assert.ok(publish.includes('fixture-owner/runtime@'+BRIDGE_SHA));

    const host=JSON.parse(readFileSync(f.hostPath,'utf8'));
    const entry=host.repositories['example/project'];
    assert.ok(entry.runnerClasses.includes('bridge-engineering'));
    assert.equal(entry.workspaceExec.runnerClass,'bridge-engineering');
    assert.equal(entry.workspaceExec.serviceUser,userInfo().username);
    assert.equal(entry.editing.enabled,true);
    assert.equal(entry.editing.serviceUser,userInfo().username);
  } finally {
    f.cleanup();
  }
});

test('bootstrap is idempotent when generated state already matches',()=>{
  const f=fixture();
  try {
    const input={
      repoPath:f.target,
      verify:['node','--test'],
      bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA,
      hostPolicyPath:f.hostPath
    };
    bootstrapProject(input);
    const second=bootstrapProject(input);
    assert.equal(second.files.every(x=>x.changed===false),true);
    assert.equal(second.hostPolicy.changed,false);
  } finally {
    f.cleanup();
  }
});

test('bootstrap refuses to overwrite unrelated project files without force',()=>{
  const f=fixture();
  try {
    mkdirSync(join(f.target,'.bridge'),{recursive:true});
    writeFileSync(join(f.target,'.bridge','project.json'),'{"custom":true}\n');
    assert.throws(
      ()=>bootstrapProject({
        repoPath:f.target,
        verify:['npm','test'],
        bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA
      }),
      error=>error.code==='BOOTSTRAP_CONFLICT'
    );
    assert.equal(readFileSync(join(f.target,'.bridge','project.json'),'utf8'),'{"custom":true}\n');
  } finally {
    f.cleanup();
  }
});

test('bootstrap refuses conflicting existing host execution identity',()=>{
  const f=fixture();
  try {
    const host=JSON.parse(readFileSync(f.hostPath,'utf8'));
    host.repositories['example/project']={
      runnerClasses:['other-runner'],
      workspaceExec:{
        enabled:true,
        runnerClass:'other-runner',
        serviceUser:'other-user',
        maxSeconds:900
      }
    };
    writeFileSync(f.hostPath,JSON.stringify(host));
    assert.throws(
      ()=>bootstrapProject({
        repoPath:f.target,
        verify:['npm','test'],
        bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA,
        runnerClass:'bridge',
        serviceUser:userInfo().username,
        hostPolicyPath:f.hostPath
      }),
      error=>error.code==='BOOTSTRAP_CONFLICT'
    );
  } finally {
    f.cleanup();
  }
});

test('bootstrap preserves existing repository resources while adding missing engineering authority',()=>{
  const f=fixture();
  try {
    const host=JSON.parse(readFileSync(f.hostPath,'utf8'));
    host.repositories['example/project']={
      runnerClasses:['bridge'],
      resources:{
        data:{
          root:join(f.root,'data'),
          read:['catalog/**'],
          write:[]
        }
      }
    };
    mkdirSync(join(f.root,'data'));
    writeFileSync(f.hostPath,JSON.stringify(host));
    bootstrapProject({
      repoPath:f.target,
      verify:['npm','test'],
      bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA,
      runnerClass:'bridge',
      serviceUser:userInfo().username,
      hostPolicyPath:f.hostPath
    });
    const updated=JSON.parse(readFileSync(f.hostPath,'utf8'));
    assert.equal(updated.repositories['example/project'].resources.data.root,join(f.root,'data'));
  } finally {
    f.cleanup();
  }
});


test('bridge-runner bootstrap-project exposes the one-command workflow',()=>{
  const f=fixture();
  try {
    const result=spawnSync(
      process.execPath,
      [
        resolve('bin/bridge-runner.mjs'),
        'bootstrap-project',
        '--repo',f.target,
        '--verify-argv','["node","--test"]',
        '--bridge-sha',BRIDGE_SHA,'--bridge-repository','fixture-owner/runtime',
        '--host-policy',f.hostPath
      ],
      {encoding:'utf8'}
    );
    assert.equal(result.status,0,result.stderr);
    const summary=JSON.parse(result.stdout);
    assert.equal(summary.repository,'example/project');
    assert.equal(summary.files.length,3);
    assert.equal(summary.hostPolicy.changed,true);
    assert.equal(summary.serviceUser,'bridge-runner');
    const host=JSON.parse(readFileSync(f.hostPath,'utf8'));
    assert.equal(
      host.repositories['example/project'].workspaceExec.serviceUser,
      'bridge-runner'
    );
  } finally {
    f.cleanup();
  }
});


test('bootstrap preflights all managed file conflicts before writing anything',()=>{
  const f=fixture();
  try {
    const workflows=join(f.target,'.github','workflows');
    mkdirSync(workflows,{recursive:true});
    writeFileSync(join(workflows,'bridge-publish.yml'),'custom workflow\n');
    assert.throws(
      ()=>bootstrapProject({
        repoPath:f.target,
        verify:['npm','test'],
        bridgeRepository:'fixture-owner/runtime',bridgeSha:BRIDGE_SHA
      }),
      error=>error.code==='BOOTSTRAP_CONFLICT'
    );
    assert.equal(existsSync(join(f.target,'.bridge','project.json')),false);
    assert.equal(existsSync(join(workflows,'bridge-gateway.yml')),false);
    assert.equal(readFileSync(join(workflows,'bridge-publish.yml'),'utf8'),'custom workflow\n');
  } finally {
    f.cleanup();
  }
});
