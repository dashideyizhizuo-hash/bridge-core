import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BridgeError } from '../src/errors.mjs';
import { BridgeGateway } from '../src/gateway.mjs';
import { GitHubTransport } from '../src/github-transport.mjs';
import { createStaticRepositoryAuthorizer } from '../src/authorization.mjs';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp-tools.mjs';

const REPO='example/project';
const POLICY='a'.repeat(40);
const TARGET='b'.repeat(40);
const POLICY_TREE='c'.repeat(40);
const BLOB='d'.repeat(40);
const REQUEST_TREE='e'.repeat(40);
const CONTROL='f'.repeat(40);
const CANDIDATE='1'.repeat(40);

function fixturePolicy() {
  return JSON.parse(
    readFileSync(resolve('test/fixtures/project/.bridge/project.json'),'utf8')
  );
}

function task(epoch=17) {
  return {
    taskKey:`${REPO}#45`,
    leaseEpoch:epoch,
    canonicalBranch:'agent/test',
    baseSha:TARGET
  };
}

function taskEditRequest(epoch=17) {
  return {
    schemaVersion:1,
    requestId:'bridge-task-edit-12345678',
    repository:REPO,
    target:{ref:'agent/test',sha:TARGET},
    policy:{ref:'main',sha:POLICY},
    operations:[{type:'replace-exact',path:'README.md',oldText:'x',newText:'y'}],
    verification:[{capability:'verify-clean',parameters:{}}],
    commitSubject:'fix: task fenced edit',
    task:task(epoch)
  };
}

function encodedJson(value) {
  return {
    encoding:'base64',
    content:Buffer.from(JSON.stringify(value)).toString('base64')
  };
}

class FakeGatewayTransport {
  constructor() {
    this.submitted=[];
  }
  async resolveRepository(repository) {
    return {repository,defaultRef:'main',defaultSha:POLICY};
  }
  async resolveTarget(_repository,{ref}) {
    return {ref,sha:TARGET};
  }
  async readProjectPolicy() {
    return fixturePolicy();
  }
  async submitCapabilityRequest(request) {
    this.submitted.push(request);
    return {runId:'cap-run-task'};
  }
  async submitEditRequest(request) {
    this.submitted.push(request);
    return {runId:'edit-run-task'};
  }
  async submitBatchRequest(request) {
    this.submitted.push(request);
    return {runId:'batch-run-task'};
  }
  async getRun() { return null; }
  async getResult() { return null; }
  async publishVerified() { throw new Error('not used'); }
}

class FakeGitHub {
  constructor(handler) {
    this.handler=handler;
    this.calls=[];
  }
  async request(method,path,options={}) {
    const call={method,path,body:options.body};
    this.calls.push(call);
    return this.handler(call);
  }
  async download() {
    throw new Error('unexpected download');
  }
}

function authorizer({publish=false}={}) {
  return createStaticRepositoryAuthorizer({
    read:[REPO],
    run:[REPO],
    publish:publish?[REPO]:[]
  });
}

function submissionGitHub() {
  return new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/git/commits/${POLICY}`) {
      return {tree:{sha:POLICY_TREE}};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/blobs`) {
      return {sha:BLOB};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/trees`) {
      return {sha:REQUEST_TREE};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/commits`) {
      return {sha:CONTROL};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/refs`) {
      return {ref:call.body.ref};
    }
    if(
      call.method==='POST' &&
      call.path===`/repos/${REPO}/actions/workflows/bridge-gateway.yml/dispatches`
    ) return null;
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
}

test('trusted Gateway task context binds task key, epoch, canonical branch and exact base SHA',async()=>{
  const transport=new FakeGatewayTransport();
  const gateway=new BridgeGateway({
    transport,
    taskContext:{taskKey:`${REPO}#45`,leaseEpoch:17}
  });
  const started=await gateway.run({
    repository:REPO,
    targetRef:'agent/test',
    mode:'batch',
    steps:[
      {id:'edit',type:'edit',operations:[
        {type:'replace-exact',path:'README.md',oldText:'x',newText:'y'}
      ]},
      {id:'verify',type:'preset',capability:'verify-clean',parameters:{}}
    ],
    commitSubject:'fix: task bound batch',
    task:{taskKey:`${REPO}#45`,leaseEpoch:999}
  });

  assert.deepEqual(started.task,task(17));
  assert.deepEqual(transport.submitted[0].task,task(17));
  assert.equal(
    Object.hasOwn(
      MCP_TOOL_DEFINITIONS.find(item=>item.name==='bridge.run').inputSchema.properties,
      'task'
    ),
    false
  );
});

test('task-aware submit fails closed without runtime and records the active run through the current lease',async()=>{
  const request=taskEditRequest(17);
  const githubWithoutRuntime=submissionGitHub();
  const unavailable=new GitHubTransport({
    github:githubWithoutRuntime,
    authorizer:authorizer()
  });
  await assert.rejects(
    ()=>unavailable.submitEditRequest(request),
    error=>error.code==='TASK_RUNTIME_UNAVAILABLE'
  );
  assert.equal(githubWithoutRuntime.calls.length,0);

  const calls=[];
  const leaseValidator={
    async assertCurrent(binding) {
      calls.push({kind:'assert',binding});
      assert.equal(binding.leaseEpoch,17);
      assert.equal(binding.repository,REPO);
      return {};
    },
    async bindRun(binding) {
      calls.push({kind:'bind',binding});
      assert.match(binding.runId,new RegExp(`^gh1:${REPO}:bridge-task-edit-12345678:${CONTROL}$`));
      return {};
    }
  };
  const github=submissionGitHub();
  const transport=new GitHubTransport({
    github,
    authorizer:authorizer(),
    taskLeaseValidator:leaseValidator
  });
  const started=await transport.submitEditRequest(request);

  assert.match(started.runId,/^gh1:/);
  assert.deepEqual(calls.map(item=>item.kind),['assert','bind']);
  const blobCall=github.calls.find(call=>call.path.endsWith('/git/blobs'));
  assert.ok(blobCall);
  assert.match(blobCall.body.content,/"leaseEpoch": 17/);
  assert.match(blobCall.body.content,/"canonicalBranch": "agent\/test"/);
});

test('zombie epoch is rejected before any publish-side GitHub mutation',async()=>{
  const request=taskEditRequest(17);
  const github=new FakeGitHub(call=>{
    if(
      call.method==='GET' &&
      call.path===`/repos/${REPO}/contents/.bridge/requests/${request.requestId}.json?ref=${CONTROL}`
    ) return encodedJson(request);
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const leaseValidator={
    async assertCurrent(binding) {
      if(binding.leaseEpoch!==18) {
        throw new BridgeError(
          'TASK_LEASE_STALE',
          'task lease is stale or no longer owns the bounded stage'
        );
      }
    },
    async bindRun() {}
  };
  const transport=new GitHubTransport({
    github,
    authorizer:authorizer({publish:true}),
    taskLeaseValidator:leaseValidator
  });
  const runId=`gh1:${REPO}:${request.requestId}:${CONTROL}`;

  await assert.rejects(
    ()=>transport.publishVerified({
      run:{runId,kind:'edit'},
      result:{
        runId,
        status:'VERIFIED',
        repository:REPO,
        baseSha:TARGET,
        targetSha:TARGET,
        policySha:POLICY,
        candidateSha:CANDIDATE
      }
    }),
    error=>error.code==='TASK_LEASE_STALE'
  );

  assert.equal(
    github.calls.some(call=>call.method==='POST' || call.method==='PATCH' || call.method==='DELETE'),
    false
  );
});

test('task binding cannot redirect a task to another repository or branch',async()=>{
  const transport=new FakeGatewayTransport();
  const wrongRepository=new BridgeGateway({
    transport,
    taskContext:{taskKey:'example/other#45',leaseEpoch:1}
  });
  await assert.rejects(
    ()=>wrongRepository.run({
      repository:REPO,
      targetRef:'agent/test',
      mode:'capability',
      capability:'inspect-data',
      parameters:{dataset_id:'demo'}
    }),
    error=>error.code==='TASK_BINDING_INVALID'
  );
  assert.equal(transport.submitted.length,0);
});
