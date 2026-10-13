import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { createStaticRepositoryAuthorizer } from '../src/authorization.mjs';
import { GitHubRestClient, GitHubTransport, parseRunId } from '../src/github-transport.mjs';

const POLICY='a'.repeat(40);
const TARGET='b'.repeat(40);
const POLICY_TREE='c'.repeat(40);
const BLOB='d'.repeat(40);
const REQUEST_TREE='e'.repeat(40);
const CONTROL='f'.repeat(40);
const CANDIDATE='1'.repeat(40);
const REPO='example/project';

test('GitHub REST client sends a valid User-Agent for API and artifact requests',async()=>{
  const calls=[];
  const client=new GitHubRestClient({
    token:'ghs_test_token',
    fetchImpl:async(input,init={})=>{
      const url=input instanceof URL ? input : new URL(input);
      calls.push({url:url.href,init});
      assert.equal(init.headers['User-Agent'],'runner-bridge');
      if(url.pathname==='/repos/example/project') {
        return Response.json({default_branch:'main'});
      }
      if(url.pathname==='/repos/example/project/actions/artifacts/7/zip') {
        return new Response(new Uint8Array([1,2,3]),{status:200});
      }
      throw new Error('unexpected URL '+url.href);
    }
  });

  await client.request('GET','/repos/example/project');
  const bytes=await client.download('/repos/example/project/actions/artifacts/7/zip');
  assert.deepEqual([...bytes],[1,2,3]);
  assert.equal(calls.length,2);
});

function capabilityRequest(){
  return {
    schemaVersion:1,
    requestId:'bridge-12345678',
    repository:REPO,
    target:{ref:'agent/test',sha:TARGET},
    policy:{ref:'main',sha:POLICY},
    capability:'inspect-data',
    parameters:{dataset_id:'demo'}
  };
}

function editRequest(){
  return {
    schemaVersion:1,
    requestId:'bridge-87654321',
    repository:REPO,
    target:{ref:'agent/test',sha:TARGET},
    policy:{ref:'main',sha:POLICY},
    operations:[{type:'replace-exact',path:'README.md',oldText:'x',newText:'y'}],
    verification:[{capability:'verify-clean',parameters:{}}],
    commitSubject:'fix: transport edit'
  };
}

function batchRequest({edited=false}={}){
  return {
    schemaVersion:1,
    mode:'batch',
    requestId:edited?'bridge-batch-edit-1234':'bridge-batch-12345678',
    repository:REPO,
    target:{ref:'agent/test',sha:TARGET},
    policy:{ref:'main',sha:POLICY},
    steps:edited
      ? [
          {id:'edit',type:'edit',operations:[{type:'replace-exact',path:'README.md',oldText:'x',newText:'y'}]},
          {id:'verify',type:'preset',capability:'verify-clean',parameters:{}}
        ]
      : [{id:'status',type:'exec',argv:['git','status','--short']}],
    ...(edited?{commitSubject:'fix: transport batch'}:{})
  };
}

function encodedJson(value){
  return {encoding:'base64',content:Buffer.from(JSON.stringify(value)).toString('base64')};
}

function artifactZip(filename,value){
  return zipSync({[filename]:strToU8(JSON.stringify(value))});
}

class FakeGitHub {
  constructor(handler){
    this.handler=handler;
    this.calls=[];
    this.downloads=[];
  }
  async request(method,path,options={}){
    const call={method,path,body:options.body};
    this.calls.push(call);
    return this.handler(call,this);
  }
  async download(path){
    this.downloads.push(path);
    return this.handler({method:'DOWNLOAD',path},this);
  }
}

function transportFor(github,{publish=false}={}){
  return new GitHubTransport({
    github,
    authorizer:createStaticRepositoryAuthorizer({
      read:[REPO],
      run:[REPO],
      publish:publish?[REPO]:[]
    }),
    pollIntervalMs:0,
    publishTimeoutMs:1000,
    sleep:async()=>{}
  });
}

function submissionHandler(request,{kind='capability'}={}){
  return call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/git/commits/${POLICY}`) return {tree:{sha:POLICY_TREE}};
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/blobs`) return {sha:BLOB};
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/trees`) return {sha:REQUEST_TREE};
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/commits`) return {sha:CONTROL};
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/refs`) return {ref:call.body.ref};
    if(call.method==='POST' && call.path===`/repos/${REPO}/actions/workflows/bridge-gateway.yml/dispatches`) return null;
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
}

test('GitHub transport durably binds request control ref to trusted policy SHA',async()=>{
  const request=capabilityRequest();
  const github=new FakeGitHub(submissionHandler(request));
  const transport=transportFor(github);
  const submitted=await transport.submitCapabilityRequest(request);

  const identity=parseRunId(submitted.runId);
  assert.deepEqual(identity,{repository:REPO,requestId:request.requestId,controlSha:CONTROL});

  const treeCall=github.calls.find(call=>call.path===`/repos/${REPO}/git/trees`);
  assert.equal(treeCall.body.base_tree,POLICY_TREE);
  assert.deepEqual(treeCall.body.tree,[{
    path:`.bridge/requests/${request.requestId}.json`,
    mode:'100644',
    type:'blob',
    sha:BLOB
  }]);

  const commitCall=github.calls.find(call=>call.path===`/repos/${REPO}/git/commits`);
  assert.deepEqual(commitCall.body.parents,[POLICY]);

  const dispatch=github.calls.find(call=>call.path.endsWith('/bridge-gateway.yml/dispatches'));
  assert.equal(dispatch.body.ref,`bridge/requests/${request.requestId}`);
  assert.equal(dispatch.body.inputs.bridge_kind,'capability');
  assert.equal(dispatch.body.inputs.bridge_target_sha,TARGET);
  assert.equal(dispatch.body.inputs.bridge_request_path,`.bridge/requests/${request.requestId}.json`);
});

test('GitHub transport submits batch through the same durable control ref and one gateway dispatch',async()=>{
  const request=batchRequest();
  const github=new FakeGitHub(submissionHandler(request));
  const transport=transportFor(github);
  const submitted=await transport.submitBatchRequest(request);
  const identity=parseRunId(submitted.runId);
  assert.equal(identity.requestId,request.requestId);
  const dispatch=github.calls.find(call=>call.path.endsWith('/bridge-gateway.yml/dispatches'));
  assert.equal(dispatch.body.inputs.bridge_kind,'batch');
  assert.equal(dispatch.body.inputs.bridge_target_sha,TARGET);
  assert.equal(github.calls.filter(call=>call.path.endsWith('/bridge-gateway.yml/dispatches')).length,1);
});

test('GitHub transport reads bounded result artifact only after exact control-run match',async()=>{
  const request=capabilityRequest();
  const branch=`bridge/requests/${request.requestId}`;
  const result={
    schemaVersion:1,
    requestId:request.requestId,
    status:'SUCCEEDED',
    repository:REPO,
    targetSha:TARGET,
    policySha:POLICY,
    capability:'inspect-data',
    evidence:{stdout:'ok',stderr:'',artifacts:[]}
  };
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/contents/.bridge/requests/${request.requestId}.json?ref=${CONTROL}`) return encodedJson(request);
    if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-gateway.yml/runs?`)){
      return {workflow_runs:[
        {id:41,status:'completed',conclusion:'success',head_sha:'0'.repeat(40),head_branch:branch},
        {id:42,status:'completed',conclusion:'success',head_sha:CONTROL,head_branch:branch,html_url:'https://github.test/run/42'}
      ]};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/actions/runs/42/artifacts?per_page=100`) return {artifacts:[{id:7,name:'bridge-result-42',expired:false}]};
    if(call.method==='DOWNLOAD' && call.path===`/repos/${REPO}/actions/artifacts/7/zip`) return artifactZip('nested/bridge-result.json',result);
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const transport=transportFor(github);
  const runId=`gh1:${REPO}:${request.requestId}:${CONTROL}`;

  const run=await transport.getRun(runId);
  assert.equal(run.status,'SUCCEEDED');
  assert.equal(run.github.workflowRunId,42);
  assert.equal(run.github.headSha,CONTROL);

  const fetched=await transport.getResult(runId);
  assert.equal(fetched.status,'SUCCEEDED');
  assert.equal(fetched.targetSha,TARGET);
  assert.equal(fetched.policySha,POLICY);
  assert.equal(fetched.github.workflowRunId,42);
  assert.deepEqual(github.downloads,[`/repos/${REPO}/actions/artifacts/7/zip`]);
});

test('GitHub transport returns structured successful and failed batch receipts from the run artifact',async()=>{
  for(const failure of [false,true]){
    const request=batchRequest();
    const branch=`bridge/requests/${request.requestId}`;
    const runIdNumber=failure?72:71;
    const result={
      schemaVersion:1,mode:'batch',requestId:request.requestId,
      status:failure?'FAILED':'SUCCEEDED',repository:REPO,
      targetRef:'agent/test',targetSha:TARGET,policySha:POLICY,
      requestSha256:'4'.repeat(64),steps:[{id:'status',type:'exec',status:failure?'FAILED':'SUCCEEDED',durationMs:1}],
      durationMs:1,startedAt:new Date(0).toISOString(),completedAt:new Date(1).toISOString()
    };
    const github=new FakeGitHub(call=>{
      if(call.method==='GET' && call.path===`/repos/${REPO}/contents/.bridge/requests/${request.requestId}.json?ref=${CONTROL}`) return encodedJson(request);
      if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-gateway.yml/runs?`)) return {workflow_runs:[{
        id:runIdNumber,status:'completed',conclusion:failure?'failure':'success',head_sha:CONTROL,head_branch:branch,html_url:`https://github.test/run/${runIdNumber}`
      }]};
      if(call.method==='GET' && call.path===`/repos/${REPO}/actions/runs/${runIdNumber}/artifacts?per_page=100`) return {artifacts:[{id:runIdNumber,name:`bridge-result-${runIdNumber}`,expired:false}]};
      if(call.method==='DOWNLOAD' && call.path===`/repos/${REPO}/actions/artifacts/${runIdNumber}/zip`) return artifactZip('bridge-result.json',result);
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });
    const transport=transportFor(github);
    const fetched=await transport.getResult(`gh1:${REPO}:${request.requestId}:${CONTROL}`);
    assert.equal(fetched.status,result.status);
    assert.equal(fetched.mode,'batch');
    assert.equal(fetched.targetSha,TARGET);
    assert.equal(fetched.github.conclusion,failure?'failure':'success');
  }
});

test('failed task batch without an artifact preserves its task binding',async()=>{
  const request={
    ...batchRequest(),
    task:{
      taskKey:`${REPO}#45`,leaseEpoch:7,
      canonicalBranch:'agent/test',baseSha:TARGET
    }
  };
  const branch=`bridge/requests/${request.requestId}`;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/contents/.bridge/requests/${request.requestId}.json?ref=${CONTROL}`) return encodedJson(request);
    if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-gateway.yml/runs?`)) return {workflow_runs:[{
      id:73,status:'completed',conclusion:'failure',head_sha:CONTROL,head_branch:branch
    }]};
    if(call.method==='GET' && call.path===`/repos/${REPO}/actions/runs/73/artifacts?per_page=100`) return {artifacts:[]};
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const fetched=await transportFor(github).getResult(
    `gh1:${REPO}:${request.requestId}:${CONTROL}`
  );
  assert.equal(fetched.status,'FAILED');
  assert.deepEqual(fetched.task,request.task);
});

test('repository authorization fails before any GitHub API access',async()=>{
  const github=new FakeGitHub(()=>{ throw new Error('must not call GitHub'); });
  const transport=new GitHubTransport({
    github,
    authorizer:createStaticRepositoryAuthorizer()
  });
  await assert.rejects(
    ()=>transport.resolveRepository(REPO),
    error=>error.code==='REPOSITORY_DENIED'
  );
  assert.equal(github.calls.length,0);
});

test('publish accepts a verified edited batch through the existing isolated publication workflow',async()=>{
  const request=batchRequest({edited:true});
  const sourceBranch=`bridge/requests/${request.requestId}`;
  const sourceRunId=62;
  const sourceRun={id:sourceRunId,status:'completed',conclusion:'success',head_sha:CONTROL,head_branch:sourceBranch,html_url:'https://github.test/run/62'};
  const verified={
    schemaVersion:1,mode:'batch',status:'VERIFIED',requestId:request.requestId,repository:REPO,
    targetSha:TARGET,policySha:POLICY,baseSha:TARGET,candidateSha:CANDIDATE,treeSha:'2'.repeat(40),
    diffSha256:'3'.repeat(64),changedFiles:['README.md']
  };
  const published={schemaVersion:1,status:'PUBLISHED',published:true,requestId:request.requestId,repository:REPO,targetRef:'agent/test',baseSha:TARGET,policySha:POLICY,candidateSha:CANDIDATE};
  let publishBranch=null;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/contents/.bridge/requests/${request.requestId}.json?ref=${CONTROL}`) return encodedJson(request);
    if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-gateway.yml/runs?`)) return {workflow_runs:[sourceRun]};
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/refs`){publishBranch=call.body.ref.replace('refs/heads/','');return {ref:call.body.ref};}
    if(call.method==='POST' && call.path===`/repos/${REPO}/actions/workflows/bridge-publish.yml/dispatches`) return null;
    if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-publish.yml/runs?`)) return {workflow_runs:[{id:63,status:'completed',conclusion:'success',head_sha:CONTROL,head_branch:publishBranch,html_url:'https://github.test/run/63'}]};
    if(call.method==='GET' && call.path===`/repos/${REPO}/actions/runs/63/artifacts?per_page=100`) return {artifacts:[{id:13,name:'bridge-publish-63',expired:false}]};
    if(call.method==='DOWNLOAD' && call.path===`/repos/${REPO}/actions/artifacts/13/zip`) return artifactZip('publish-result.json',published);
    if(call.method==='DELETE' && call.path.startsWith(`/repos/${REPO}/git/refs/heads/bridge/publish/`)) return null;
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const transport=transportFor(github,{publish:true});
  const runId=`gh1:${REPO}:${request.requestId}:${CONTROL}`;
  const result=await transport.publishVerified({run:{runId,kind:'batch',targetRef:'agent/test'},result:{...verified,runId}});
  assert.equal(result.status,'PUBLISHED');
  assert.equal(result.candidateSha,CANDIDATE);
});

test('publish uses a separate trusted ref and validates verified candidate artifact binding',async()=>{
  const request=editRequest();
  const sourceBranch=`bridge/requests/${request.requestId}`;
  const sourceRunId=52;
  const sourceRun={
    id:sourceRunId,status:'completed',conclusion:'success',
    head_sha:CONTROL,head_branch:sourceBranch,html_url:'https://github.test/run/52'
  };
  const verified={
    schemaVersion:1,status:'VERIFIED',requestId:request.requestId,repository:REPO,
    baseSha:TARGET,policySha:POLICY,candidateSha:CANDIDATE,treeSha:'2'.repeat(40),
    diffSha256:'3'.repeat(64),changedFiles:['README.md'],verifications:[{index:0}]
  };
  const published={
    schemaVersion:1,status:'PUBLISHED',published:true,requestId:request.requestId,
    repository:REPO,targetRef:'agent/test',baseSha:TARGET,policySha:POLICY,
    candidateSha:CANDIDATE,treeSha:'2'.repeat(40),diffSha256:'3'.repeat(64),
    changedFiles:['README.md']
  };
  let publishBranch=null;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/contents/.bridge/requests/${request.requestId}.json?ref=${CONTROL}`) return encodedJson(request);
    if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-gateway.yml/runs?`)) return {workflow_runs:[sourceRun]};
    if(call.method==='POST' && call.path===`/repos/${REPO}/git/refs`){
      publishBranch=call.body.ref.replace('refs/heads/','');
      assert.equal(call.body.sha,CONTROL);
      return {ref:call.body.ref};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/actions/workflows/bridge-publish.yml/dispatches`){
      assert.equal(call.body.ref,publishBranch);
      assert.equal(call.body.inputs.bridge_source_run_id,String(sourceRunId));
      assert.equal(call.body.inputs.bridge_source_artifact,`bridge-result-${sourceRunId}`);
      return null;
    }
    if(call.method==='GET' && call.path.startsWith(`/repos/${REPO}/actions/workflows/bridge-publish.yml/runs?`)){
      return {workflow_runs:[{
        id:53,status:'completed',conclusion:'success',head_sha:CONTROL,
        head_branch:publishBranch,html_url:'https://github.test/run/53'
      }]};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/actions/runs/53/artifacts?per_page=100`) return {artifacts:[{id:9,name:'bridge-publish-53',expired:false}]};
    if(call.method==='DOWNLOAD' && call.path===`/repos/${REPO}/actions/artifacts/9/zip`) return artifactZip('publish-result.json',published);
    if(call.method==='DELETE' && call.path.startsWith(`/repos/${REPO}/git/refs/heads/bridge/publish/`)) return null;
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const transport=transportFor(github,{publish:true});
  const runId=`gh1:${REPO}:${request.requestId}:${CONTROL}`;
  const result=await transport.publishVerified({
    run:{runId,kind:'edit',targetRef:'agent/test'},
    result:{...verified,runId}
  });
  assert.equal(result.status,'PUBLISHED');
  assert.equal(result.candidateSha,CANDIDATE);
  assert.equal(result.runId,runId);
  assert.ok(publishBranch.startsWith(`bridge/publish/${request.requestId}-`));
  assert.ok(github.calls.some(call=>call.method==='DELETE' && call.path.includes('/git/refs/heads/bridge/publish/')));
});
