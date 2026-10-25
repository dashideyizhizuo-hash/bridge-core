import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BridgeGateway } from '../src/gateway.mjs';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp-tools.mjs';
import {defaultProjectPolicy} from '../src/default-project-policy.mjs';

const BASE='a'.repeat(40);
const TARGET='b'.repeat(40);
const CANDIDATE='c'.repeat(40);

function fixturePolicy(){
  return JSON.parse(readFileSync(resolve('test/fixtures/project/.bridge/project.json'),'utf8'));
}

class FakeTransport {
  constructor(policy=fixturePolicy()){
    this.policy=policy;
    this.runs=new Map();
    this.submitted=[];
    this.counter=0;
  }
  async resolveRepository(repository){
    return {repository,defaultRef:'main',defaultSha:BASE};
  }
  async resolveTarget(_repository,{ref,sha}){
    if(sha && sha!==TARGET){
      const error=new Error('target stale'); error.code='TARGET_STALE'; throw error;
    }
    return {ref,sha:TARGET};
  }
  async readProjectPolicy(_repository,sha){
    assert.equal(sha,BASE);
    return structuredClone(this.policy);
  }
  async submitCapabilityRequest(request){
    const runId=`cap-run-${++this.counter}`;
    const run={runId,kind:'capability',targetRef:request.target.ref,status:'QUEUED',request,...(request.task?{task:request.task}:{})};
    const result={runId,status:'SUCCEEDED',repository:request.repository,targetSha:request.target.sha,policySha:request.policy.sha,capability:request.capability,...(request.task?{task:request.task}:{})};
    this.runs.set(runId,{run,result});
    this.submitted.push({kind:'capability',request});
    return {runId};
  }
  async submitEditRequest(request){
    const runId=`edit-run-${++this.counter}`;
    const run={runId,kind:'edit',targetRef:request.target.ref,status:'VERIFIED',request,...(request.task?{task:request.task}:{})};
    const result={runId,status:'VERIFIED',repository:request.repository,targetSha:request.target.sha,policySha:request.policy.sha,candidateSha:CANDIDATE,...(request.task?{task:request.task}:{})};
    this.runs.set(runId,{run,result});
    this.submitted.push({kind:'edit',request});
    return {runId};
  }
  async submitBatchRequest(request){
    const runId=`batch-run-${++this.counter}`;
    const edited=request.steps.some(step=>step.type==='edit');
    const run={runId,kind:'batch',targetRef:request.target.ref,status:edited?'VERIFIED':'SUCCEEDED',request,...(request.task?{task:request.task}:{})};
    const result={
      runId,mode:'batch',status:edited?'VERIFIED':'SUCCEEDED',
      repository:request.repository,targetSha:request.target.sha,policySha:request.policy.sha,
      ...(edited?{baseSha:request.target.sha,candidateSha:CANDIDATE}: {}),
      ...(request.task?{task:request.task}:{})
    };
    this.runs.set(runId,{run,result});
    this.submitted.push({kind:'batch',request});
    return {runId};
  }
  async getRun(runId){ return this.runs.get(runId)?.run ?? null; }
  async getResult(runId){ return this.runs.get(runId)?.result ?? null; }
  async publishVerified({run,result}){
    assert.equal(run.targetRef,'agent/test');
    assert.equal(result.candidateSha,CANDIDATE);
    return {runId:run.runId,status:'PUBLISHED',candidateSha:result.candidateSha,targetRef:run.targetRef};
  }
}

test('discover exposes logical trusted capabilities without command argv or host paths',async()=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const result=await gateway.discover({repository:'example/project'});
  assert.deepEqual(result.policy,{ref:'main',sha:BASE});
  const inspect=result.capabilities.find(x=>x.id==='inspect-data');
  assert.equal(inspect.class,'observe');
  assert.deepEqual(inspect.resources,['test-data']);
  assert.equal('command' in inspect,false);
  assert.equal(JSON.stringify(result).includes('/data/'),false);
  assert.equal(result.exec.enabled,true);
  assert.deepEqual(result.exec.resources,['test-data']);
  assert.equal(result.editing.enabled,true);
  assert.equal(result.editing.publish,true);
});

test('run capability binds caller target to exact SHA and server-selected trusted policy',async()=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const result=await gateway.run({
    repository:'example/project',
    targetRef:'agent/test',
    mode:'capability',
    capability:'inspect-data',
    parameters:{dataset_id:'demo'},
    policy:{sha:'f'.repeat(40)}
  });
  assert.equal(result.target.sha,TARGET);
  assert.equal(result.policy.sha,BASE);
  const request=transport.submitted[0].request;
  assert.equal(request.target.sha,TARGET);
  assert.equal(request.policy.sha,BASE);
  assert.deepEqual(request.parameters,{dataset_id:'demo'});
});

test('run rejects caller-provided stale target SHA',async()=>{
  const gateway=new BridgeGateway({transport:new FakeTransport()});
  await assert.rejects(
    ()=>gateway.run({repository:'example/project',targetRef:'agent/test',targetSha:'d'.repeat(40),mode:'capability',capability:'inspect-data',parameters:{dataset_id:'demo'}}),
    e=>e.code==='TARGET_STALE'
  );
});

test('batch run binds one trusted policy and normalizes preset parameters without adding public tools',async()=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const result=await gateway.run({
    repository:'example/project',
    targetRef:'agent/test',
    mode:'batch',
    steps:[
      {id:'status',type:'exec',argv:['git','status','--short']},
      {id:'inspect',type:'preset',capability:'inspect-data',parameters:{dataset_id:'demo'}}
    ]
  });
  assert.equal(result.kind,'batch');
  assert.equal(result.stepCount,2);
  assert.equal(result.policy.sha,BASE);
  const submitted=transport.submitted[0];
  assert.equal(submitted.kind,'batch');
  assert.equal(submitted.request.mode,'batch');
  assert.equal(submitted.request.target.sha,TARGET);
  assert.equal(submitted.request.policy.sha,BASE);
  assert.deepEqual(submitted.request.steps[1].parameters,{dataset_id:'demo'});
});

test('edit run uses trusted verification capabilities and trusted policy identity',async()=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const result=await gateway.run({
    repository:'example/project',
    targetRef:'agent/test',
    mode:'edit',
    operations:[{type:'replace-exact',path:'scripts/inspect.mjs',oldText:'x',newText:'y'}],
    verification:[{capability:'verify-clean',parameters:{}}],
    commitSubject:'fix: gateway edit'
  });
  assert.equal(result.kind,'edit');
  assert.equal(result.policy.sha,BASE);
  const request=transport.submitted[0].request;
  assert.equal(request.policy.sha,BASE);
  assert.deepEqual(request.verification,[{capability:'verify-clean',parameters:{}}]);
});

test('edit run rejects observe capability as verification authority',async()=>{
  const gateway=new BridgeGateway({transport:new FakeTransport()});
  await assert.rejects(
    ()=>gateway.run({
      repository:'example/project',targetRef:'agent/test',mode:'edit',
      operations:[{type:'replace-exact',path:'scripts/inspect.mjs',oldText:'x',newText:'y'}],
      verification:[{capability:'inspect-data',parameters:{dataset_id:'demo'}}],
      commitSubject:'fix: invalid verification'
    }),
    e=>e.code==='VERIFICATION_DENIED'
  );
});

test('publish accepts only a verified edit run and cannot redirect branch',async()=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const edit=await gateway.run({
    repository:'example/project',targetRef:'agent/test',mode:'edit',
    operations:[{type:'replace-exact',path:'scripts/inspect.mjs',oldText:'x',newText:'y'}],
    verification:[{capability:'verify-clean',parameters:{}}],
    commitSubject:'fix: publish me'
  });
  const published=await gateway.publish({runId:edit.runId,targetBranch:'main'});
  assert.equal(published.status,'PUBLISHED');
  assert.equal(published.targetRef,'agent/test');

  const capability=await gateway.run({
    repository:'example/project',targetRef:'agent/test',mode:'capability',
    capability:'inspect-data',parameters:{dataset_id:'demo'}
  });
  await assert.rejects(()=>gateway.publish({runId:capability.runId}),e=>e.code==='PUBLISH_DENIED');
});

test('publish accepts a VERIFIED edited batch but rejects an unedited batch',async()=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const edited=await gateway.run({
    repository:'example/project',targetRef:'agent/test',mode:'batch',
    steps:[
      {id:'edit',type:'edit',operations:[{type:'replace-exact',path:'scripts/inspect.mjs',oldText:'x',newText:'y'}]},
      {id:'verify',type:'preset',capability:'verify-sandbox',parameters:{}}
    ],
    commitSubject:'fix: batch publish'
  });
  const published=await gateway.publish({runId:edited.runId});
  assert.equal(published.status,'PUBLISHED');
  assert.equal(published.targetRef,'agent/test');

  const plain=await gateway.run({
    repository:'example/project',targetRef:'agent/test',mode:'batch',
    steps:[{id:'status',type:'exec',argv:['git','status','--short']}]
  });
  await assert.rejects(()=>gateway.publish({runId:plain.runId}),e=>e.code==='PUBLISH_DENIED');
});

test('get_run and get_result fail closed for unknown run id',async()=>{
  const gateway=new BridgeGateway({transport:new FakeTransport()});
  await assert.rejects(()=>gateway.getRun({runId:'missing-run'}),e=>e.code==='RUN_NOT_FOUND');
  await assert.rejects(()=>gateway.getResult({runId:'missing-run'}),e=>e.code==='RUN_NOT_FOUND');
});

test('task activity renews only after a successful operation bound to the current task',async()=>{
  const transport=new FakeTransport();
  let renewals=0;
  const gateway=new BridgeGateway({
    transport,
    taskContext:{taskKey:'example/project#45',leaseEpoch:7},
    taskActivity:{async renew(){ renewals++; }}
  });
  transport.runs.set('current-run',{
    run:{
      runId:'current-run',kind:'capability',status:'RUNNING',
      task:{taskKey:'example/project#45',leaseEpoch:7,canonicalBranch:'agent/test',baseSha:TARGET}
    },
    result:null
  });
  await gateway.getRun({runId:'current-run'});
  assert.equal(renewals,1);

  transport.runs.set('other-run',{
    run:{
      runId:'other-run',kind:'capability',status:'RUNNING',
      task:{taskKey:'example/project#45',leaseEpoch:8,canonicalBranch:'agent/test',baseSha:TARGET}
    },
    result:null
  });
  await assert.rejects(
    ()=>gateway.getRun({runId:'other-run'}),
    error=>error.code==='TASK_BINDING_MISMATCH'
  );
  assert.equal(renewals,1);
  await assert.rejects(()=>gateway.getRun({runId:'missing-run'}),error=>error.code==='RUN_NOT_FOUND');
  assert.equal(renewals,1);
});

test('MCP public surface adds one bounded task transition beside non-redirectable publish',()=>{
  assert.deepEqual(MCP_TOOL_DEFINITIONS.map(x=>x.name),["bridge.list_hosts","bridge.create_host_pairing","bridge.pause_host","bridge.resume_host","bridge.run_host_command","bridge.import_file","bridge.create_file_upload","bridge.delete_file","bridge.get_repository_configuration","bridge.execute_repository_commands","bridge.verify_repository","bridge.edit_and_verify_repository","bridge.get_run","bridge.get_result","bridge.publish","bridge.task_transition","bridge.repository_tools_status"]);
  const run=MCP_TOOL_DEFINITIONS.find(x=>x.name==='bridge.execute_repository_commands');
  assert.equal(Object.hasOwn(run.inputSchema.properties,'mode'),false);
  assert.equal(run.inputSchema.properties.commands.maxItems,16);
  const publish=MCP_TOOL_DEFINITIONS.find(x=>x.name==='bridge.publish');
  assert.deepEqual(Object.keys(publish.inputSchema.properties),['runId','taskSessionToken']);
});

test('Gateway delegates task transition only when a task lifecycle is bound',async()=>{
  const transport=new FakeTransport();
  const unbound=new BridgeGateway({transport});
  await assert.rejects(
    ()=>unbound.transitionTask({outcome:'BLOCKED',reasonCode:'TEST_BLOCKER'}),
    error=>error.code==='TASK_SESSION_REQUIRED'
  );

  const calls=[];
  const bound=new BridgeGateway({
    transport,
    taskLifecycle:{
      async transition(input) {
        calls.push(input);
        return {action:'BLOCKED',status:'BLOCKED'};
      }
    }
  });
  const input={outcome:'BLOCKED',reasonCode:'TEST_BLOCKER'};
  assert.deepEqual(await bound.transitionTask(input),{
    action:'BLOCKED',
    status:'BLOCKED'
  });
  assert.deepEqual(calls,[input]);
});

test('built-in discovery is usable without a policy file and does not claim project tests or environment readiness',async()=>{
 const transport=new FakeTransport(defaultProjectPolicy('example/project',BASE)),gateway=new BridgeGateway({transport});
 const result=await gateway.discover({repository:'example/project'});
 assert.equal(result.policyProfile.source,'builtin');assert.equal(result.policyProfile.verification,'patch-integrity');assert.equal(result.policyProfile.projectTestsRun,false);
 assert.equal(result.executionEnvironment.status,'unchecked');assert.equal(result.exec.enabled,true);assert.equal(result.editing.enabled,true);
 assert.ok(result.capabilities.some(item=>item.id==='patch-integrity'));
});
