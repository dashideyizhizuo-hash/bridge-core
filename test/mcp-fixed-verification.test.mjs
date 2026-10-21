import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BridgeGateway} from '../src/gateway.mjs';
import {validateProjectPolicy} from '../src/validate.mjs';
import {invokePublicTool} from '../src/mcp-public-api.mjs';

const REPO='example/project',POLICY='a'.repeat(40),TARGET='b'.repeat(40);
const identity={repository:REPO,targetRef:'agent/test',targetSha:TARGET,expectedPolicySha:POLICY,};
function policy(){
  const value=JSON.parse(readFileSync(new URL('./fixtures/project/.bridge/project.json',import.meta.url),'utf8'));
  value.capabilities['verify-fixed']={class:'verify',runner:'sandbox',command:{argv:['node','check.mjs','{params.level}']},parameters:{level:{type:'string',default:'trusted',pattern:'^trusted$'}}};
  value.mcp={verification:[{capability:'verify-fixed'},{capability:'verify-clean',parameters:{}}]};
  return value;
}
function fixture(value=policy()){
  const events=[],submitted=[];let reads=0,currentSha=POLICY;
  const transport={
    async resolveRepository(repository){events.push('repository');assert.equal(repository,REPO);return {defaultRef:'main',defaultSha:currentSha};},
    async readProjectPolicy(repository,sha){reads++;events.push('policy');assert.equal(repository,REPO);assert.equal(sha,currentSha);return structuredClone(value);},
    async resolveTarget(repository,target){events.push('target');assert.equal(repository,REPO);return {...target,sha:TARGET};},
    async submitBatchRequest(request){events.push('submit');submitted.push(request);return {runId:'github-batch-123'};},
    async submitEditRequest(request){events.push('submit');submitted.push(request);return {runId:'github-edit-123'};},
    async submitCapabilityRequest(request){events.push('submit');submitted.push(request);return {runId:'github-capability-123'};},
    async getRun(){throw Error('unused');},async getResult(){throw Error('unused');},async publishVerified(){throw Error('unused');}
  };
  return {gateway:new BridgeGateway({transport}),transport,events,submitted,reads:()=>reads,setSha:sha=>{currentSha=sha;}};
}

test('fixed verification uses one trusted policy acquisition and server-owned defaults before submitting',async()=>{
  const f=fixture();
  const result=await invokePublicTool(f.gateway,'bridge.verify_repository',identity);
  assert.deepEqual(f.events,['repository','policy','target','submit']);assert.equal(f.reads(),1);
  assert.equal(result.policy.sha,POLICY);assert.equal(f.submitted.length,1);
  assert.deepEqual(f.submitted[0].steps,[
    {id:'verify-0',type:'preset',capability:'verify-fixed',parameters:{level:'trusted'}},
    {id:'verify-1',type:'preset',capability:'verify-clean',parameters:{}}
  ]);
  assert.deepEqual(f.submitted[0].policy,{ref:'main',sha:POLICY});
});

test('fixed edit verification replaces internal verification overrides and preserves existing edit request semantics',async()=>{
  const f=fixture();const operations=[{type:'replace-exact',path:'README.md',oldText:'old',newText:'new'}];
  await f.gateway.run({...identity,mode:'edit',trustedVerification:true,operations,commitSubject:'fix: update text',verification:[{capability:'inspect-data',parameters:{dataset_id:'attacker'}}]});
  assert.equal(f.reads(),1);assert.equal(f.submitted.length,1);
  assert.deepEqual(f.submitted[0].operations,operations);
  assert.deepEqual(f.submitted[0].verification,[{capability:'verify-fixed',parameters:{level:'trusted'}},{capability:'verify-clean',parameters:{}}]);
});

test('internal fixed batch ignores caller recipe/steps instead of executing them',async()=>{
  const f=fixture();
  await f.gateway.run({...identity,mode:'batch',trustedVerification:true,steps:[{id:'attacker',type:'exec',argv:['arbitrary']}],parameters:{level:'attacker'},capability:'inspect-data'});
  assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].steps.some(step=>step.type==='exec'),false);
  assert.deepEqual(f.submitted[0].steps[0].parameters,{level:'trusted'});
});

test('public verification never accepts arbitrary capabilities, parameters, recipes or verification lists',async()=>{
  const f=fixture();
  for(const name of ['bridge.verify_repository','bridge.edit_and_verify_repository'])for(const key of ['capability','parameters','recipe','verification','steps','trustedVerification']){
    const args={...identity,...(name.includes('edit_and')?{operations:[{type:'apply-patch',patch:'patch'}],commitSubject:'fix: text'}:{}),[key]:[]};
    await assert.rejects(invokePublicTool(f.gateway,name,args),error=>error?.code==='INVALID_MCP_ARGUMENTS');
  }
  assert.equal(f.events.length,0);assert.equal(f.submitted.length,0);
});

test('changed trusted policy rejects preset, fixed verification and fixed edit before target lookup or submission',async()=>{
  for(const input of [
    {...identity,mode:'capability',capability:'verify-fixed',parameters:{}},
    {...identity,mode:'batch',trustedVerification:true},
    {...identity,mode:'edit',trustedVerification:true,operations:[{type:'apply-patch',patch:'patch'}],commitSubject:'fix: text'}
  ]){
    const f=fixture();f.setSha('c'.repeat(40));
    await assert.rejects(f.gateway.run(input),error=>error?.code==='POLICY_STALE');
    assert.deepEqual(f.events,['repository','policy']);assert.equal(f.submitted.length,0);
  }
});

test('missing fixed verification configuration fails closed and cannot be replaced by caller data',async()=>{
  const value=policy();delete value.mcp;const f=fixture(value);
  await assert.rejects(f.gateway.run({...identity,mode:'batch',trustedVerification:true,steps:[{id:'caller',type:'preset',capability:'verify-clean',parameters:{}}]}),error=>error?.code==='VERIFICATION_DENIED');
  assert.deepEqual(f.events,['repository','policy']);assert.equal(f.submitted.length,0);
});

test('policy rejects observe, undeclared presets, missing parameters, invalid defaults and malformed recipes',()=>{
  const changes=[
    value=>{value.mcp.verification=[{capability:'inspect-data',parameters:{dataset_id:'demo'}}];},
    value=>{value.mcp.verification=[{capability:'not-declared'}];},
    value=>{delete value.capabilities['verify-fixed'].parameters.level.default;},
    value=>{value.capabilities['verify-fixed'].parameters.level.default='untrusted';},
    value=>{value.mcp.verification=[];},
    value=>{value.mcp.verification=Array(5).fill({capability:'verify-clean'});},
    value=>{value.mcp.verification=[{capability:'verify-clean',parameters:[]}];},
    value=>{value.mcp.verification=[{capability:'verify-clean',parameters:{override:'denied'}}];},
    value=>{value.mcp.verification=[{capability:'verify-clean',argv:['arbitrary']}];},
    value=>{value.mcp.arbitraryRecipe=[];}
  ];
  for(const change of changes){const value=policy();change(value);assert.throws(()=>validateProjectPolicy(value,REPO),error=>error?.code==='PROJECT_POLICY_INVALID');}
});

test('invalid fixed recipes are rejected before target lookup and any execution submission',async()=>{
  for(const mutate of [value=>{value.mcp.verification=[{capability:'inspect-data',parameters:{dataset_id:'demo'}}];},value=>{delete value.capabilities['verify-fixed'].parameters.level.default;}]){
    const value=policy();mutate(value);const f=fixture(value);
    await assert.rejects(invokePublicTool(f.gateway,'bridge.verify_repository',identity),error=>error?.code==='PROJECT_POLICY_INVALID');
    assert.deepEqual(f.events,['repository','policy']);assert.equal(f.submitted.length,0);
  }
});
