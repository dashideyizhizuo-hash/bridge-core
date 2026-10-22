import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BridgeGateway } from '../src/gateway.mjs';
import { createBridgeMcpHandler } from '../src/mcp-server.mjs';
import {isRepositoryTool} from '../src/mcp-repository-catalog.mjs';

const BASE='a'.repeat(40);
const TARGET='b'.repeat(40);
const CANDIDATE='c'.repeat(40);

function fixturePolicy(){
  const policy=JSON.parse(readFileSync(resolve('test/fixtures/project/.bridge/project.json'),'utf8'));
  policy.mcp={verification:[{capability:'verify-clean',parameters:{}}]};
  return policy;
}

async function presetName(client){
  const tool=(await client.listTools()).tools.find(item=>item.title==='Observe: inspect-data');
  assert.ok(tool,'trusted inspect-data preset must be advertised before invocation');
  return tool.name;
}

function toolPayload(result){
  if(result.structuredContent) return result.structuredContent;
  const block=result.content?.find(item=>item.type==='text');
  assert.ok(block && typeof block.text==='string','tool result must contain JSON text');
  return JSON.parse(block.text);
}

class FakeTransport {
  constructor(policy=fixturePolicy()){
    this.policy=policy;
    this.runs=new Map();
    this.submitted=[];
    this.counter=0;
    this.publishCalls=0;
  }
  async listRepositories(){return ['example/project'];}
  async resolveRepository(repository){
    return {repository,defaultRef:'main',defaultSha:BASE};
  }
  async resolveTarget(_repository,{ref,sha}){
    if(sha && sha!==TARGET){
      const error=new Error('target stale');
      error.code='TARGET_STALE';
      throw error;
    }
    return {ref,sha:TARGET};
  }
  async readProjectPolicy(_repository,sha){
    assert.equal(sha,BASE);
    return structuredClone(this.policy);
  }
  async submitCapabilityRequest(request){
    const runId=`cap-run-${++this.counter}`;
    const run={runId,kind:'capability',targetRef:request.target.ref,status:'QUEUED',request};
    const result={
      runId,
      status:'SUCCEEDED',
      repository:request.repository,
      targetSha:request.target.sha,
      policySha:request.policy.sha,
      capability:request.capability
    };
    this.runs.set(runId,{run,result});
    this.submitted.push({kind:'capability',request});
    return {runId};
  }
  async submitEditRequest(request){
    const runId=`edit-run-${++this.counter}`;
    const run={runId,kind:'edit',targetRef:request.target.ref,status:'VERIFIED',request};
    const result={
      runId,
      status:'VERIFIED',
      repository:request.repository,
      targetSha:request.target.sha,
      policySha:request.policy.sha,
      candidateSha:CANDIDATE
    };
    this.runs.set(runId,{run,result});
    this.submitted.push({kind:'edit',request});
    return {runId};
  }
  async getRun(runId){ return this.runs.get(runId)?.run ?? null; }
  async getResult(runId){ return this.runs.get(runId)?.result ?? null; }
  async publishVerified({run,result}){
    this.publishCalls++;
    assert.equal(run.targetRef,'agent/test');
    assert.equal(result.candidateSha,CANDIDATE);
    return {runId:run.runId,status:'PUBLISHED',candidateSha:result.candidateSha,targetRef:run.targetRef};
  }
}

async function connectInProcess(t, handler, authInfo){
  const transport=new StreamableHTTPClientTransport(
    new URL('http://bridge.test/mcp'),
    {
      fetch: async (input,init) => {
        const request=input instanceof Request ? new Request(input,init) : new Request(input,init);
        return handler.fetch(request,{authInfo});
      }
    }
  );
  const client=new Client({name:'bridge-test-client',version:'0.1.0'});
  await client.connect(transport);
  t.after(async()=>{
    await client.close();
    await handler.close();
  });
  return client;
}

test('Streamable HTTP MCP lists execution tools plus bounded task transition',async t=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const authInfo={token:'test-token',clientId:'test-client',scopes:['repository:example/project']};
  const seenAuth=[];
  const handler=createBridgeMcpHandler({
    gatewayForRequest: context=>{
      seenAuth.push(context.authInfo);
      return gateway;
    }
  });
  const client=await connectInProcess(t,handler,authInfo);

  const listed=await client.listTools();
  assert.deepEqual(listed.tools.filter(tool=>!isRepositoryTool(tool.name)).map(tool=>tool.name),[
    'bridge.list_hosts','bridge.create_host_pairing','bridge.pause_host','bridge.resume_host',
    'bridge.run_host_command','bridge.import_file','bridge.create_file_upload','bridge.delete_file',
    'bridge.get_repository_configuration','bridge.execute_repository_commands','bridge.verify_repository','bridge.edit_and_verify_repository',
    'bridge.get_run',
    'bridge.get_result',
    'bridge.publish',
    'bridge.task_transition','bridge.repository_tools_status'
  ]);
  // Assert the wire-visible contract, not just the source definitions.
  const expectedHints={
    'bridge.list_hosts':[true,false,false],
    'bridge.create_host_pairing':[false,true,false],
    'bridge.pause_host':[false,true,false],
    'bridge.resume_host':[false,true,false],
    'bridge.run_host_command':[false,true,true],
    'bridge.import_file':[false,false,false],
    'bridge.create_file_upload':[false,false,false],
    'bridge.delete_file':[false,true,false],
    'bridge.get_repository_configuration':[true,false,false],
    'bridge.execute_repository_commands':[false,true,true],
    'bridge.verify_repository':[false,true,true],
    'bridge.edit_and_verify_repository':[false,true,true],
    'bridge.get_run':[false,false,false],
    'bridge.get_result':[false,false,false],
    'bridge.publish':[false,true,true],
    'bridge.task_transition':[false,true,true],
    'bridge.repository_tools_status':[true,false,false],  };
  for(const tool of listed.tools){
    const [readOnlyHint,destructiveHint,openWorldHint]=isRepositoryTool(tool.name)?[false,true,true]:expectedHints[tool.name];
    assert.deepEqual(tool.annotations,{readOnlyHint,destructiveHint,openWorldHint});
  }
  const publish=listed.tools.find(tool=>tool.name==='bridge.publish');
  assert.deepEqual(Object.keys(publish.inputSchema.properties),['runId','taskSessionToken']);
  const runTool=listed.tools.find(tool=>tool.name==='bridge.edit_and_verify_repository');
  assert.deepEqual(
    Object.keys(runTool.inputSchema.properties).filter(key=>key.startsWith('task')),
    ['taskSessionToken']
  );

  const discovered=toolPayload(await client.callTool({
    name:'bridge.get_repository_configuration',
    arguments:{repository:'example/project'}
  }));
  assert.deepEqual(discovered.policy,{ref:'main',sha:BASE});
  assert.equal(discovered.capabilities.some(capability=>'command' in capability),false);
  assert.equal(JSON.stringify(discovered).includes('/data/'),false);
  assert.ok(seenAuth.length>=1);
  assert.ok(seenAuth.every(value=>value===authInfo));
});

test('named MCP preset/get_result preserves trusted identities and rejects policy injection',async t=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const handler=createBridgeMcpHandler({gateway});
  const client=await connectInProcess(t,handler);
  const name=await presetName(client);

  const rejected=await client.callTool({
    name,
    arguments:{
      targetRef:'agent/test',

      parameters:{dataset_id:'demo'},
      policy:{sha:'f'.repeat(40)}
    }
  });
  assert.equal(rejected.isError,true);
  assert.equal(transport.submitted.length,0);

  const started=toolPayload(await client.callTool({
    name,
    arguments:{
      targetRef:'agent/test',

      parameters:{dataset_id:'demo'}
    }
  }));
  assert.equal(started.target.sha,TARGET);
  assert.equal(started.policy.sha,BASE);

  const run=toolPayload(await client.callTool({
    name:'bridge.get_run',
    arguments:{runId:started.runId}
  }));
  assert.equal(run.request.target.sha,TARGET);
  assert.equal(run.request.policy.sha,BASE);

  const result=toolPayload(await client.callTool({
    name:'bridge.get_result',
    arguments:{runId:started.runId}
  }));
  assert.equal(result.targetSha,TARGET);
  assert.equal(result.policySha,BASE);
});

test('MCP publish remains run-bound and cannot redirect the verified branch',async t=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const handler=createBridgeMcpHandler({gateway});
  const client=await connectInProcess(t,handler);

  const edit=toolPayload(await client.callTool({
    name:'bridge.edit_and_verify_repository',
    arguments:{
      repository:'example/project',
      targetRef:'agent/test',
      expectedPolicySha:BASE,

      operations:[{
        type:'replace-exact',
        path:'scripts/inspect.mjs',
        oldText:'x',
        newText:'y'
      }],
      commitSubject:'fix: MCP verified edit'
    }
  }));

  const redirected=await client.callTool({
    name:'bridge.publish',
    arguments:{runId:edit.runId,targetBranch:'main'}
  });
  assert.equal(redirected.isError,true);
  assert.equal(transport.publishCalls,0);

  const published=toolPayload(await client.callTool({
    name:'bridge.publish',
    arguments:{runId:edit.runId}
  }));
  assert.equal(published.status,'PUBLISHED');
  assert.equal(published.targetRef,'agent/test');
  assert.equal(transport.publishCalls,1);
});


test('opaque taskSessionToken selects a task-aware gateway and is not forwarded as business input',async t=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const token='bts_'+('A'.repeat(43));
  const resolutions=[];
  const handler=createBridgeMcpHandler({
    gateway,
    gatewayForTool:async value=>{
      resolutions.push(structuredClone({
        toolName:value.toolName,
        taskSessionToken:value.taskSessionToken,
        args:value.args
      }));
      return gateway;
    }
  });
  const client=await connectInProcess(t,handler);
  const name=await presetName(client);

  const started=toolPayload(await client.callTool({
    name,
    arguments:{
      targetRef:'agent/test',

      parameters:{dataset_id:'demo'},
      taskSessionToken:token
    }
  }));

  assert.equal(typeof started.runId,'string');
  assert.equal(resolutions.length,1);
  assert.equal(resolutions[0].toolName,name);
  assert.equal(resolutions[0].taskSessionToken,token);
  assert.equal('taskSessionToken' in resolutions[0].args,false);
  assert.equal('taskSessionToken' in transport.submitted[0].request,false);
});

test('taskSessionToken fails closed when the deployment has no resolver',async t=>{
  const transport=new FakeTransport();
  const gateway=new BridgeGateway({transport});
  const handler=createBridgeMcpHandler({gateway});
  const client=await connectInProcess(t,handler);
  const token='bts_'+('B'.repeat(43));
  const name=await presetName(client);

  const rejected=await client.callTool({
    name,
    arguments:{
      targetRef:'agent/test',

      parameters:{dataset_id:'demo'},
      taskSessionToken:token
    }
  });

  assert.equal(rejected.isError,true);
  const payload=toolPayload(rejected);
  assert.equal(payload.error.code,'TASK_SESSION_UNAVAILABLE');
  assert.equal(transport.submitted.length,0);
});

test('task transition requires a resolved task session and strips the opaque token',async t=>{
  const transport=new FakeTransport();
  const baseGateway=new BridgeGateway({transport});
  const transitions=[];
  const taskGateway=new BridgeGateway({
    transport,
    taskLifecycle:{
      async transition(input) {
        transitions.push(structuredClone(input));
        return {action:'STOP',status:'READY',checkpointSha:input.checkpointSha};
      }
    }
  });
  const token='bts_'+('T'.repeat(43));
  const handler=createBridgeMcpHandler({
    gateway:baseGateway,
    gatewayForTool:async value=>{
      assert.equal(value.toolName,'bridge.task_transition');
      assert.equal(value.taskSessionToken,token);
      assert.equal('taskSessionToken' in value.args,false);
      return taskGateway;
    }
  });
  const client=await connectInProcess(t,handler);

  const withoutSession=await client.callTool({
    name:'bridge.task_transition',
    arguments:{
      outcome:'READY',
      checkpointSha:'d'.repeat(40),
      stateCommentId:84
    }
  });
  assert.equal(withoutSession.isError,true);
  assert.equal(toolPayload(withoutSession).error.code,'TASK_SESSION_REQUIRED');

  const transitioned=toolPayload(await client.callTool({
    name:'bridge.task_transition',
    arguments:{
      outcome:'READY',
      checkpointSha:'d'.repeat(40),
      stateCommentId:84,
      continue:false,
      taskSessionToken:token
    }
  }));
  assert.equal(transitioned.action,'STOP');
  assert.deepEqual(transitions,[{
    outcome:'READY',
    checkpointSha:'d'.repeat(40),
    stateCommentId:84,
    continue:false
  }]);
});


test('MCP advertises ChatGPT fileParams and returns principal-bound file resources',async t=>{
  const transport=new FakeTransport();
  const now=2_100_000_000_000,downloadExpiresAt=now+900_000;
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const payload=Buffer.from('native-file-bytes','utf8');
  let receipt;
  let resourcesIssued=0;
  const directAssets={
    async createUpload(){ throw new Error('legacy upload must not run'); },
    async importFile({principal:seen,file,persistent}) {
      assert.equal(seen,principal);
      assert.equal(file.file_id,'file_123');
      assert.equal(persistent,false);
      return receipt={
        runId:'da1:asset-native-1234',
        kind:'asset',
        transport:'direct-asset',
        assetId:'asset-native-1234',
        status:'READY',
        fileName:'input.txt',
        mimeType:'text/plain',
        sizeBytes:payload.length,
        sha256:'a'.repeat(64),
        persistent:true
      };
    },
    async assertReady(){},
    async getRun({principal:seen}){ assert.equal(seen,principal); return receipt; },
    async getResult({principal:seen}){ assert.equal(seen,principal); return receipt; },
    async issueResource({principal:seen,assetId}) {
      resourcesIssued++;
      assert.equal(seen,principal);
      assert.equal(assetId,'asset-native-1234');
      return {
        asset:{assetId},
        uri:'bridge-file:///access/test-capability-1234',
        expiresAt:downloadExpiresAt
      };
    },
    async readResource({principal:seen,token}) {
      assert.equal(seen,principal);
      assert.equal(token,'test-capability-1234');
      return {
        asset:{
          assetId:'asset-native-1234',
          fileName:'input.txt',
          mimeType:'text/plain',
          sizeBytes:payload.length,
          sha256:'a'.repeat(64)
        },
        bytes:payload
      };
    }
  };
  const gateway=new BridgeGateway({transport,directAssets,principal});
  const handler=createBridgeMcpHandler({gateway,clock:()=>now});
  const client=await connectInProcess(t,handler);

  const listed=await client.listTools();
  const runTool=listed.tools.find(tool=>tool.name==='bridge.import_file');
  assert.deepEqual(runTool._meta?.['openai/fileParams'],['file']);
  assert.deepEqual(
    runTool.inputSchema.properties.file.required,
    ['download_url','file_id']
  );
  assert.deepEqual(
    Object.keys(runTool.inputSchema.properties.file.properties).sort(),
    ['download_url','file_id','file_name','mime_type']
  );

  const called=await client.callTool({
    name:'bridge.import_file',
    arguments:{
      file:{
        download_url:'https://files.oaiusercontent.com/private/file_123',
        file_id:'file_123',
        mime_type:'text/plain',
        file_name:'input.txt'
      }
    }
  });
  assert.equal(called.isError,undefined);
  assert.deepEqual(called.structuredContent,receipt);
  assert.equal(called.content.some(item=>item.type==='resource_link'),false);
  assert.equal(resourcesIssued,0);
  const polled=await client.callTool({name:'bridge.get_run',arguments:{runId:receipt.runId}});
  assert.deepEqual(polled.structuredContent,receipt);
  assert.equal(polled.content.some(item=>item.type==='resource_link'),false);
  assert.equal(resourcesIssued,0);
  const result=await client.callTool({name:'bridge.get_result',arguments:{runId:receipt.runId}});
  assert.deepEqual(result.structuredContent,{...receipt,downloadExpiresAt});
  assert.equal(resourcesIssued,1);
  const link=result.content.find(item=>item.type==='resource_link');
  assert.ok(link);
  assert.equal(link.uri,'bridge-file:///access/test-capability-1234');
  assert.equal(link.name,'input.txt');
  assert.equal(link.mimeType,'text/plain');
  assert.equal(link.size,payload.length);

  const resource=await client.readResource({uri:link.uri});
  assert.equal(resource.contents.length,1);
  assert.equal(resource.contents[0].mimeType,'text/plain');
  assert.equal(Buffer.from(resource.contents[0].blob,'base64').toString('utf8'),'native-file-bytes');
});

test('Direct export resource links are issued only by get_result',async t=>{
  const asset={kind:'asset',transport:'direct-asset',assetId:'asset-export-1234',
    status:'READY',fileName:'output.txt',mimeType:'text/plain',sizeBytes:12};
  const receipt={runId:'dx1:host-test:direct-export-test',kind:'direct',transport:'direct',
    status:'SUCCEEDED',exports:[asset]};
  let issued=0;
  const gateway={
    async discover(){ return {}; },async run(){ return receipt; },
    async getRun(){ return receipt; },async getResult(){ return receipt; },
    async publish(){ throw new Error('not used'); },
    async issueAssetResource({assetId}) {
      assert.equal(assetId,asset.assetId); issued++;
      return {uri:'bridge-file:///access/export-test-capability'};
    }
  };
  const client=await connectInProcess(t,createBridgeMcpHandler({gateway}));
  for(const name of ['bridge.run_host_command','bridge.get_run']) {
    const response=await client.callTool({name,arguments:name==='bridge.run_host_command'
      ? {hostId:'host-test',argv:['fixture'],waitSeconds:0} : {runId:receipt.runId}});
    assert.equal(response.isError,undefined);
    assert.deepEqual(response.structuredContent,receipt);
    assert.equal(response.content.some(item=>item.type==='resource_link'),false);
    assert.equal(issued,0);
  }
  const result=await client.callTool({name:'bridge.get_result',arguments:{runId:receipt.runId}});
  assert.equal(result.isError,undefined);
  assert.deepEqual(result.structuredContent,receipt);
  assert.equal(issued,1);
  assert.equal(result.content.find(item=>item.type==='resource_link').uri,
    'bridge-file:///access/export-test-capability');
});
