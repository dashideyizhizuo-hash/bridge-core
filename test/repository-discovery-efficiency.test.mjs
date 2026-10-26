import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBridgePrincipal} from '../src/auth/principal.mjs';
import {createRequestScopedGateway} from '../src/control-plane.mjs';
import {repositoryToolCatalog} from '../src/mcp-repository-catalog.mjs';

const REPO='owner/repository',COMMIT='a'.repeat(40),TREE='b'.repeat(40);
function fixture({contentError=404,policy,tree=[],treeSha=TREE,truncated=false,commitTree=TREE,hook}={}){
  const paths=[],grants=[],state={allowed:true,installationId:11};
  const principal=createBridgePrincipal({bridgeUserId:'owner-a',externalProvider:'fixture',externalSubject:'subject-a'});
  const gateway=createRequestScopedGateway({principal,
    principalRepositoryAuthorizer:{list:async()=>[REPO],assert:async input=>{if(!state.allowed)throw Object.assign(Error('revoked'),{code:'REPOSITORY_DENIED'});assert.equal(input.principal.bridgeUserId,principal.bridgeUserId);assert.equal(input.repository,REPO);assert.equal(input.permission,'read');return REPO;}},
    installationResolver:{resolve:async()=>({installationId:state.installationId})},
    credentialProvider:{acquire:async input=>{grants.push(input);return {...input,token:'fixture-read-only-token'};}},
    fetchImpl:async(input,init)=>{
      const url=new URL(input);paths.push(url.pathname);assert.equal(init.method,'GET');
      if(hook)await hook(url,init);
      if(url.pathname===`/repos/${REPO}`)return Response.json({default_branch:'main'});
      if(url.pathname===`/repos/${REPO}/commits/main`)return Response.json({sha:COMMIT,...(commitTree===null?{}:{commit:{tree:{sha:commitTree}}})});
      if(url.pathname===`/repos/${REPO}/contents/.bridge/project.json`)return policy===undefined?Response.json({message:'not found'},{status:contentError}):Response.json({encoding:'base64',content:Buffer.from(policy).toString('base64')});
      if(url.pathname===`/repos/${REPO}/git/commits/${COMMIT}`)return Response.json({sha:COMMIT,tree:{sha:TREE}});
      if(url.pathname===`/repos/${REPO}/git/trees/${TREE}`)return Response.json({sha:treeSha,truncated,tree});
      throw Error('Unexpected metadata request: '+url.pathname);
    }});
  return {gateway,paths,grants,state};
}

test('cold default-profile discovery reuses one bound transport and its exact commit tree',async()=>{
  const f=fixture(),catalog=await repositoryToolCatalog(f.gateway);
  assert.equal(catalog.status,'ready');assert.equal(catalog.definitions.length,1);
  assert.equal(catalog.definitions[0].operation.policySha,COMMIT);
  assert.equal(f.grants.length,1,'one bounded inspection must not reacquire the same credential');
  assert.deepEqual(f.paths,[`/repos/${REPO}`,`/repos/${REPO}/commits/main`,`/repos/${REPO}/contents/.bridge/project.json`,`/repos/${REPO}/git/trees/${TREE}`]);
});

test('default discovery still rejects provider failures, incomplete or false tree proofs',async()=>{
  for(const input of [{contentError:403},{treeSha:'c'.repeat(40)},{truncated:true},{commitTree:'not-a-sha'},
    {tree:[{path:'.bridge',type:'blob',mode:'120000',sha:TREE}]},
    {tree:[{path:'.bridge',type:'tree',mode:'040000',sha:TREE},{path:'.bridge',type:'tree',mode:'040000',sha:TREE}]}]){
    const f=fixture(input);await assert.rejects(f.gateway.discover({repository:REPO}));
  }
});

test('older transport responses without a tree still require a fresh exact-commit absence proof',async()=>{
  const f=fixture({commitTree:null}),result=await f.gateway.discover({repository:REPO});
  assert.equal(result.policyProfile.source,'builtin');assert.equal(result.policyProfile.projectTestsRun,false);
  assert.ok(f.paths.includes(`/repos/${REPO}/git/commits/${COMMIT}`));
});

test('advanced policy inspection stays authoritative without extra tree reads',async()=>{
  const policy=JSON.parse(readFileSync(new URL('./fixtures/project/.bridge/project.json',import.meta.url),'utf8'));policy.project.repository=REPO;
  const f=fixture({policy:JSON.stringify(policy)}),result=await f.gateway.discover({repository:REPO});
  assert.equal(result.policyProfile.source,'repository');assert.equal(f.grants.length,1);
  assert.equal(f.paths.length,3);assert.ok(!f.paths.some(path=>path.includes('/git/trees/')));
  await assert.rejects(fixture({policy:'invalid JSON'}).gateway.discover({repository:REPO}),{code:'GITHUB_EVIDENCE_INVALID'});
});

test('standalone policy reads cannot accept an unverified external tree hint',async()=>{
  const f=fixture();await f.gateway.transport.readProjectPolicy(REPO,COMMIT,{treeSha:'e'.repeat(40),trustedTreeSha:'f'.repeat(40)});
  assert.ok(f.paths.includes(`/repos/${REPO}/git/commits/${COMMIT}`));
});

test('cancellation at each metadata stage prevents all subsequent sends',async()=>{
  const expected=[`/repos/${REPO}`,`/repos/${REPO}/commits/main`,`/repos/${REPO}/contents/.bridge/project.json`,`/repos/${REPO}/git/trees/${TREE}`];
  for(let index=0;index<expected.length;index++){
    const controller=new AbortController(),f=fixture({hook:async(url,init)=>{assert.equal(init.signal,controller.signal);if(url.pathname===expected[index])controller.abort();}});
    await assert.rejects(f.gateway.discover({repository:REPO,signal:controller.signal}));
    assert.deepEqual(f.paths,expected.slice(0,index+1));
  }
});

test('a local grant revoked or installation changed between context phases prevents policy access',async()=>{
  for(const variant of ['grant','installation']){
    let f;f=fixture({hook:async url=>{if(url.pathname.endsWith('/commits/main')){if(variant==='grant')f.state.allowed=false;else f.state.installationId=12;}}});
    await assert.rejects(f.gateway.discover({repository:REPO}),{code:variant==='grant'?'REPOSITORY_DENIED':'GITHUB_APP_CREDENTIAL_INVALID'});
    assert.deepEqual(f.paths,[`/repos/${REPO}`,`/repos/${REPO}/commits/main`]);assert.equal(f.grants.length,1);
  }
});
