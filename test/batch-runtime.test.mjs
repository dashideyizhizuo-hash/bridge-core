import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeRequest } from '../src/runtime.mjs';

const fixture = resolve('test/fixtures/project');
const dataFixture = resolve('test/fixtures/data');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-batch-test-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  const out = join(root, 'out');
  cpSync(fixture, repo, { recursive: true });
  cpSync(dataFixture, data, { recursive: true });
  mkdirSync(join(data, 'results'), { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Bridge Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  const sha = git(repo, ['rev-parse', 'HEAD']);

  const host = {
    version: 1,
    host: { id: 'test-host' },
    repositories: {
      'example/project': {
        runnerClasses: ['test-runner', 'bridge-sandbox'],
        resources: {
          'test-data': {
            root: data,
            read: ['catalog/**', 'raw/**', 'results/**'],
            write: ['results/**']
          }
        },
        workspaceExec: {
          enabled: true,
          runnerClass: 'bridge-sandbox',
          serviceUser: userInfo().username,
          maxArgv: 16,
          maxSeconds: 10,
          stdoutBytes: 4096,
          stderrBytes: 4096
        }
      }
    }
  };
  const hostPath = join(root, 'host.json');
  writeFileSync(hostPath, JSON.stringify(host));
  return { root, repo, data, out, sha, hostPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function batchRequest(s, steps, extra = {}) {
  mkdirSync(join(s.repo, '.bridge', 'requests'), { recursive: true });
  const path = join(s.repo, '.bridge', 'requests', 'batch.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    mode: 'batch',
    requestId: 'batch-request-0001',
    repository: 'example/project',
    target: { ref: 'main', sha: s.sha },
    policy: { ref: 'main', sha: s.sha },
    steps,
    ...extra
  }));
  return path;
}

test('ordered exec steps share one checked out Run workspace', async () => {
  const s=setup(); try {
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'write',type:'exec',argv:['node','-e',"require('fs').writeFileSync('scratch.txt','shared')"]},
      {id:'read',type:'exec',argv:['node','-e',"process.stdout.write(require('fs').readFileSync('scratch.txt','utf8'))"]}
    ]),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'SUCCEEDED');
    assert.deepEqual(result.steps.map(x=>x.status),['SUCCEEDED','SUCCEEDED']);
    assert.equal(result.steps[1].evidence.stdout,'shared');
    assert.deepEqual(result.workspace,{materializations:1,shared:true});
  } finally { s.cleanup(); }
});

test('generic exec binds only trusted logical resources and redacts physical roots', async () => {
  const s=setup(); try {
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'data',type:'exec',argv:['node','-e',"process.stdout.write(process.env.TEST_DATA_DIR)"],resources:['test-data']}
    ]),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(result.steps[0].evidence.stdout,'<bridge-resource:test-data>');
    assert.equal(JSON.stringify(result).includes(s.data),false);
  } finally { s.cleanup(); }
});

test('generic exec rejects a resource not declared by trusted project policy before execution', async () => {
  const s=setup(); try {
    const policy=JSON.parse(readFileSync(join(s.repo,'.bridge/project.json'),'utf8'));
    policy.workspaceExec.resources=[];
    writeFileSync(join(s.repo,'.bridge/project.json'),JSON.stringify(policy));
    git(s.repo,['add','.bridge/project.json']); git(s.repo,['commit','-m','remove exec resource']);
    const target=git(s.repo,['rev-parse','HEAD']);
    const requestPath=batchRequest({...s,sha:target},[
      {id:'data',type:'exec',argv:['node','-e',"require('fs').writeFileSync('should-not.txt','x')"],resources:['test-data']}
    ]);
    const result=await executeRequest({requestPath,repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'DENIED');
    assert.equal(result.steps[0].error.code,'HOST_RESOURCE_DENIED');
    assert.equal(existsSync(join(s.repo,'should-not.txt')),false);
  } finally { s.cleanup(); }
});

test('trusted preset delegates to shared exec and preserves structured resource evidence', async () => {
  const s=setup(); try {
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'inspect',type:'preset',capability:'inspect-data',parameters:{dataset_id:'demo'}}
    ]),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(result.runner.class,'test-runner');
    assert.equal(result.steps[0].status,'SUCCEEDED');
    assert.equal(JSON.parse(result.steps[0].evidence.report.content).root,'<bridge-resource:test-data>');
    assert.equal(JSON.parse(result.steps[0].evidence.stdout).root,'<bridge-resource:test-data>');
    assert.equal(JSON.stringify(result).includes(s.data),false);
  } finally { s.cleanup(); }
});

test('mixed batch preflight requires one runner class and executes nothing on mismatch', async () => {
  const s=setup(); try {
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'would-run',type:'exec',argv:['node','-e',"require('fs').writeFileSync('marker.txt','bad')"]},
      {id:'verify',type:'preset',capability:'verify-clean'}
    ]),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'DENIED');
    assert.deepEqual(result.steps.map(x=>x.status),['SKIPPED','DENIED']);
    assert.equal(result.steps[1].error.code,'BATCH_RUNNER_MISMATCH');
    assert.equal(existsSync(join(s.repo,'marker.txt')),false);
  } finally { s.cleanup(); }
});

test('edit preflight requires explicit host editing authority before any earlier execution', async () => {
  const s=setup(); try {
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'would-run',type:'exec',argv:['node','-e',"require('fs').writeFileSync('marker.txt','bad')"]},
      {id:'edit',type:'edit',operations:[{type:'replace-exact',path:'README.md',oldText:'fixture',newText:'changed'}]}
    ],{commitSubject:'test: future edit'}),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'DENIED');
    assert.equal(result.steps[1].error.code,'EDIT_DENIED');
    assert.equal(existsSync(join(s.repo,'marker.txt')),false);
  } finally { s.cleanup(); }
});

test('batch execution is fail-fast and marks the untouched suffix SKIPPED', async () => {
  const s=setup(); try {
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'first',type:'exec',argv:['node','-e',"require('fs').writeFileSync('first.txt','yes')"]},
      {id:'fail',type:'exec',argv:['node','-e',"process.stderr.write('boom'); process.exit(7)"]},
      {id:'never',type:'exec',argv:['node','-e',"require('fs').writeFileSync('never.txt','no')"]}
    ]),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'FAILED');
    assert.deepEqual(result.steps.map(x=>x.status),['SUCCEEDED','FAILED','SKIPPED']);
    assert.equal(result.steps[1].execution.exitCode,7);
    assert.equal(result.steps[1].evidence.stderr,'boom');
    assert.equal(existsSync(join(s.repo,'never.txt')),false);
  } finally { s.cleanup(); }
});

test('batch preflight fails closed on service-user mismatch without target execution', async () => {
  const s=setup(); try {
    const host=JSON.parse(readFileSync(s.hostPath,'utf8'));
    host.repositories['example/project'].workspaceExec.serviceUser='not-the-current-user';
    writeFileSync(s.hostPath,JSON.stringify(host));
    const result=await executeRequest({requestPath:batchRequest(s,[
      {id:'never',type:'exec',argv:['node','-e',"require('fs').writeFileSync('authority.txt','bad')"]}
    ]),repoPath:s.repo,hostPolicyPath:s.hostPath,outputDir:s.out});
    assert.equal(result.status,'DENIED');
    assert.equal(result.error.code,'HOST_RESOURCE_DENIED');
    assert.equal(existsSync(join(s.repo,'authority.txt')),false);
  } finally { s.cleanup(); }
});
