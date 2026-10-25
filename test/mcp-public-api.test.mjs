import test from 'node:test';
import assert from 'node:assert/strict';
import {invokePublicTool} from '../src/mcp-public-api.mjs';

const identity={repository:'owner/project',targetRef:'agent/work',targetSha:'a'.repeat(40),expectedPolicySha:'b'.repeat(40),};
const receipt={runId:'dx1:host-a:request-1234',hostId:'host-a',kind:'direct',transport:'direct',status:'QUEUED'};
function fixture(){
  const calls=[];
  const gateway=Object.fromEntries(['discover','run','getRun','getResult','publish','transitionTask'].map(method=>[method,async args=>{calls.push({method,args});return {method};}]));
  return {gateway,calls};
}
const denied=error=>error?.code==='INVALID_MCP_ARGUMENTS';

test('repository discovery preserves default verification scope and unverified execution readiness for the caller',async()=>{
  const profile={source:'builtin',version:1,verification:'patch-integrity',projectTestsRun:false};
  const environment={status:'unchecked',requirements:['workflow','runner','host-policy']};
  const gateway={discover:async()=>({repository:'owner/project',policyProfile:profile,executionEnvironment:environment,privateInternalValue:'not-public'})};
  const result=await invokePublicTool(gateway,'bridge.get_repository_configuration',{repository:'owner/project'});
  assert.deepEqual(result.policyProfile,profile);
  assert.deepEqual(result.executionEnvironment,environment);
  assert.equal(Object.hasOwn(result,'privateInternalValue'),false);
});

test('removed aggregate tools and unknown names cannot invoke the gateway',async()=>{
  const f=fixture();
  for(const name of ['bridge.run','bridge.discover','run','__proto__','bridge.custom_preset'])
    await assert.rejects(invokePublicTool(f.gateway,name,{mode:'direct',argv:['whoami']}),error=>error?.code==='UNKNOWN_MCP_TOOL');
  assert.equal(f.calls.length,0);
});

test('embedded managed paths are rejected before gateway dispatch',async()=>{
  const f=fixture();
  for(const script of ["$src='{asset:0}'", "write('{export:0}')"]) {
    await assert.rejects(invokePublicTool(f.gateway,'bridge.run_host_command',{
      hostId:'host-a',argv:['powershell.exe','-Command',script],assets:['asset-12345678']
    }),error=>error.code==='DIRECT_EXEC_INVALID'&&/standalone argv/.test(error.message));
  }
  assert.equal(f.calls.length,0);
});

test('all fixed tools reject mode, arbitrary parameters and hidden authority before dispatch',async()=>{
  const f=fixture();
  const cases={
    'bridge.list_hosts':{},'bridge.create_host_pairing':{},'bridge.pause_host':{hostId:'host-a'},'bridge.resume_host':{hostId:'host-a'},
    'bridge.run_host_command':{hostId:'host-a',argv:['whoami']},'bridge.import_file':{file:{download_url:'https://files.example/a',file_id:'file-a'}},
    'bridge.create_file_upload':{fileName:'input.txt',mimeType:'text/plain',sizeBytes:1,sha256:'a'.repeat(64)},'bridge.delete_file':{assetId:'asset-12345678'},
    'bridge.get_repository_configuration':{repository:'owner/project'},'bridge.execute_repository_commands':{...identity,commands:[{id:'first',argv:['node','--version']}]},
    'bridge.verify_repository':identity,'bridge.edit_and_verify_repository':{...identity,operations:[{type:'apply-patch',patch:'patch'}],commitSubject:'Update code'},
    'bridge.get_run':{runId:receipt.runId},'bridge.get_result':{runId:receipt.runId},'bridge.publish':{runId:'github-run-123'},
    'bridge.task_transition':{outcome:'BLOCKED',reasonCode:'NEEDS_INPUT'}
  };
  for(const [name,args] of Object.entries(cases))for(const field of ['mode','parameters','principal','taskSessionToken','trustedVerification','idempotencyKey'])
    await assert.rejects(invokePublicTool(f.gateway,name,{...args,[field]:field==='mode'?'direct':{override:true}}),denied,`${name} must reject ${field}`);
  assert.equal(f.calls.length,0);
});

test('pause and resume inject separate fixed states and cannot accept an enabled override',async()=>{
  const f=fixture();
  await invokePublicTool(f.gateway,'bridge.pause_host',{hostId:'host-a'});
  await invokePublicTool(f.gateway,'bridge.resume_host',{hostId:'host-a'});
  assert.deepEqual(f.calls,[{method:'run',args:{mode:'host',host:'host-a',enabled:false}},{method:'run',args:{mode:'host',host:'host-a',enabled:true}}]);
  await assert.rejects(invokePublicTool(f.gateway,'bridge.pause_host',{hostId:'host-a',enabled:true}),denied);
});

test('pairing and file tools use only the decorated gateway run entry',async()=>{
  const f=fixture();
  const file={download_url:'https://files.example/input',file_id:'file-input'};
  await invokePublicTool(f.gateway,'bridge.create_host_pairing',{ttlSeconds:120});
  await invokePublicTool(f.gateway,'bridge.import_file',{file,ttlSeconds:600});
  await invokePublicTool(f.gateway,'bridge.create_file_upload',{fileName:'input.txt',mimeType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64)});
  await invokePublicTool(f.gateway,'bridge.delete_file',{assetId:'asset-12345678'});
  assert.deepEqual(f.calls,[
    {method:'run',args:{mode:'connect',ttlSeconds:120}},
    {method:'run',args:{mode:'asset',file,ttlSeconds:600}},
    {method:'run',args:{mode:'asset',fileName:'input.txt',mimeType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64)}},
    {method:'run',args:{mode:'asset',assetAction:'delete',assetId:'asset-12345678'}}
  ]);
  await assert.rejects(invokePublicTool(f.gateway,'bridge.import_file',{file,persistent:true}),denied);
});

test('repository commands compile only fixed exec steps and preserve exact policy identity',async()=>{
  const f=fixture();
  const commands=[{id:'inspect',argv:['node','--version']},{id:'check',argv:['npm','test'],cwd:'src',resources:['project-data'],timeoutSeconds:30}];
  const args={...identity,commands};const original=structuredClone(args);
  await invokePublicTool(f.gateway,'bridge.execute_repository_commands',args);
  assert.deepEqual(f.calls,[{method:'run',args:{mode:'batch',...identity,steps:commands.map(command=>({...command,type:'exec'}))}}]);
  assert.deepEqual(args,original);
  for(const bad of [{...commands[0],type:'preset'},{...commands[0],parameters:{}},{...commands[0],capability:'untrusted'}])
    await assert.rejects(invokePublicTool(f.gateway,'bridge.execute_repository_commands',{...identity,commands:[bad]}),denied);
  for(const commands_ of [[],Array(17).fill(commands[0]),[null]])
    await assert.rejects(invokePublicTool(f.gateway,'bridge.execute_repository_commands',{...identity,commands:commands_}),denied);
  assert.equal(f.calls.length,1);
});

test('verification and editing keep existing execution modes and inject a trusted recipe marker',async()=>{
  const f=fixture();const operations=[{type:'replace-exact',path:'src/index.mjs',oldText:'old',newText:'new'}];
  await invokePublicTool(f.gateway,'bridge.verify_repository',identity);
  await invokePublicTool(f.gateway,'bridge.edit_and_verify_repository',{...identity,operations,commitSubject:'Update implementation'});
  assert.deepEqual(f.calls,[
    {method:'run',args:{mode:'batch',...identity,trustedVerification:true}},
    {method:'run',args:{mode:'edit',...identity,operations,commitSubject:'Update implementation',trustedVerification:true}}
  ]);
  for(const field of ['steps','verification','capability'])
    await assert.rejects(invokePublicTool(f.gateway,'bridge.verify_repository',{...identity,[field]:[]}),denied);
  const {expectedPolicySha,...missing}=identity;
  await assert.rejects(invokePublicTool(f.gateway,'bridge.verify_repository',missing),denied);
  assert.equal(f.calls.length,2);
});

test('direct commands wait by default above the decorated gateway and submit only once',async()=>{
  const calls=[];let bound=false;
  const gateway={
    async run(args){calls.push(['run',args]);bound=true;return receipt;},
    async getRun(args){assert.equal(bound,true);calls.push(['getRun',args]);return {...receipt,status:'SUCCEEDED'};},
    async getResult(args){calls.push(['getResult',args]);return {...receipt,status:'SUCCEEDED',evidence:{stdout:'中文'}};}
  };
  const args={hostId:'host-a',argv:['node','--version'],cwd:'src',timeoutSeconds:12,assets:['asset-12345678'],exports:[{fileName:'output.txt',mimeType:'text/plain'}]};
  const result=await invokePublicTool(gateway,'bridge.run_host_command',args);
  assert.equal(result.evidence.stdout,'中文');assert.equal(result.runId,receipt.runId);
  const {hostId,...execution}=args;
  assert.deepEqual(calls,[['run',{mode:'direct',host:hostId,...execution}],['getRun',{runId:receipt.runId}],['getResult',{runId:receipt.runId}]]);
});

test('zero wait returns the admitted receipt and invalid windows never dispatch',async()=>{
  let calls=0;const gateway={run:async()=>{calls++;return receipt;},getRun(){throw Error('must not poll');}};
  assert.equal(await invokePublicTool(gateway,'bridge.run_host_command',{hostId:'host-a',argv:['whoami'],waitSeconds:0}),receipt);
  for(const waitSeconds of [-1,21,0.5,'1'])await assert.rejects(invokePublicTool(gateway,'bridge.run_host_command',{hostId:'host-a',argv:['whoami'],waitSeconds}),error=>error?.code==='INVALID_GATEWAY_REQUEST');
  assert.equal(calls,1);
});

test('a failed or interrupted wait keeps the same admitted run and never resubmits',async()=>{
  for(const interrupted of [false,true]){
    const ac=new AbortController();let submissions=0,reads=0;
    const gateway={run:async()=>{submissions++;if(interrupted)ac.abort();return receipt;},getRun:async()=>{reads++;throw Error('secret backend detail');}};
    const result=await invokePublicTool(gateway,'bridge.run_host_command',{hostId:'host-a',argv:['whoami']},{signal:ac.signal});
    assert.equal(result.runId,receipt.runId);assert.equal(result.waitStatus,interrupted?'interrupted':'unavailable');
    assert.equal(submissions,1);assert.equal(reads,interrupted?0:1);assert.equal(JSON.stringify(result).includes('secret'),false);
  }
});

test('run getters, publication, and task transition retain canonical gateway methods',async()=>{
  const f=fixture();
  for(const name of ['bridge.get_run','bridge.get_result','bridge.publish'])await invokePublicTool(f.gateway,name,{runId:'github-run-123'});
  const args={outcome:'READY',checkpointSha:'c'.repeat(40),stateCommentId:1,continue:true};
  await invokePublicTool(f.gateway,'bridge.task_transition',args);
  assert.deepEqual(f.calls,[{method:'getRun',args:{runId:'github-run-123'}},{method:'getResult',args:{runId:'github-run-123'}},{method:'publish',args:{runId:'github-run-123'}},{method:'transitionTask',args}]);
  await assert.rejects(invokePublicTool({},'bridge.task_transition',{outcome:'BLOCKED',reasonCode:'NEEDS_INPUT'}),error=>error?.code==='TASK_SESSION_REQUIRED');
});

test('malformed argument containers and missing required fields are rejected locally',async()=>{
  const f=fixture();
  for(const args of [null,[],1,'payload'])await assert.rejects(invokePublicTool(f.gateway,'bridge.list_hosts',args),denied);
  await assert.rejects(invokePublicTool(f.gateway,'bridge.run_host_command',{argv:['whoami']}),denied);
  assert.equal(f.calls.length,0);
});

test('all wait options reject invalid input before admission, including immediate calls',async()=>{
  let submissions=0;
  const gateway={run:async()=>{submissions++;throw Error('must not admit');}};
  for(const key of ['queueWaitSeconds','transferWaitSeconds'])for(const value of [-1,121,0.5,'1',null])
    await assert.rejects(invokePublicTool(gateway,'bridge.run_host_command',{hostId:'host-a',argv:['whoami'],waitSeconds:0,[key]:value}),e=>e.code==='INVALID_GATEWAY_REQUEST');
  assert.equal(submissions,0);
});
