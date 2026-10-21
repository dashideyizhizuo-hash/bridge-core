import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {RepositoryAuthorizer,createStaticRepositoryAuthorizer} from '../src/authorization.mjs';
import {GitHubTransport} from '../src/github-transport.mjs';
import {buildPrivateGateway,createPrivateMcpHttpServer} from '../src/private-mcp.mjs';
import {repositoryToolCatalog,isRepositoryTool} from '../src/mcp-repository-catalog.mjs';

const REPO='team/allowed',SHA='a'.repeat(40),TOKEN='test-private-token-1234567890';
const policy={version:1,project:{repository:REPO},runners:{local:{class:'test-runner'}},capabilities:{inspect:{class:'observe',runner:'local',command:{argv:['node','inspect.mjs']}}}};

test('static inventory snapshots only configured read grants and validates a read grant for each listed repository',async()=>{
  const read=[REPO];const authorizer=createStaticRepositoryAuthorizer({read,run:['team/run-only'],publish:['team/publish-only']});read.push('team/unconfigured');
  assert.deepEqual(await authorizer.listRepositories(),[REPO]);
  const checked=[];const rejected=new RepositoryAuthorizer({check:async value=>{checked.push(value);return false;},list:async()=>['team/not-granted']});
  await assert.rejects(rejected.listRepositories(),error=>error?.code==='REPOSITORY_DENIED');
  assert.deepEqual(checked,[{repository:'team/not-granted',permission:'read'}]);
});

test('optional inventory defaults to empty and malformed or unbounded hook output fails closed',async()=>{
  const empty=new RepositoryAuthorizer({check:()=>true});assert.deepEqual(await empty.listRepositories(),[]);
  for(const result of [null,'team/repo',['/absolute/path'],Array.from({length:18},(_,i)=>'team/repo-'+i)]){
    const authorizer=new RepositoryAuthorizer({check:()=>true,list:async()=>result});
    await assert.rejects(authorizer.listRepositories(),error=>error?.code==='REPOSITORY_AUTHORIZATION_INVALID');
  }
  assert.throws(()=>new RepositoryAuthorizer({check:()=>true,list:'not a hook'}),error=>error?.code==='REPOSITORY_AUTHORIZATION_INVALID');
});

test('GitHub transport inventories authorizer metadata without querying GitHub and rechecks read authority',async()=>{
  let providerCalls=0;
  const github={request:async()=>{providerCalls++;throw Error('must not enumerate GitHub');},download:async()=>{throw Error('unused');}};
  const none=new GitHubTransport({github,authorizer:{assertRepository:async repository=>repository}});
  assert.deepEqual(await none.listRepositories(),[]);
  const forged=new GitHubTransport({github,authorizer:{listRepositories:async()=>['team/not-granted'],assertRepository:async()=>{throw Object.assign(new Error('read denied'),{code:'REPOSITORY_DENIED'});}}});
  await assert.rejects(forged.listRepositories(),error=>error?.code==='REPOSITORY_DENIED');assert.equal(providerCalls,0);
});

test('more than sixteen static read grants uses a seventeenth sentinel and exposes no truncated preset catalog',async()=>{
  let requests=0;
  const gateway=buildPrivateGateway({config:{githubToken:'fixture',grants:{read:Array.from({length:30},(_,i)=>'team/repo-'+i),run:[],publish:[]}},fetchImpl:async()=>{requests++;throw Error('no provider access before inventory limit');}});
  assert.equal((await gateway.listRepositories()).length,17);
  const catalog=await repositoryToolCatalog(gateway);assert.equal(catalog.status,'limit');assert.deepEqual(catalog.definitions,[]);assert.equal(requests,0);
});

test('buildPrivateGateway over actual authenticated HTTP advertises only configured read repositories, never global GitHub inventory',async t=>{
  const requests=[];
  const gateway=buildPrivateGateway({config:{githubToken:'local-github-fixture',grants:{read:[REPO],run:[],publish:[]}},fetchImpl:async(input,init={})=>{
    const url=new URL(input);requests.push({path:url.pathname,method:init.method??'GET'});
    assert.equal(init.method??'GET','GET','read-only catalog must never mutate GitHub');
    if(url.pathname==='/repos/'+REPO)return Response.json({default_branch:'main'});
    if(url.pathname==='/repos/'+REPO+'/commits/main'||url.pathname==='/repos/'+REPO+'/commits/agent%2Fwork')return Response.json({sha:SHA});
    if(url.pathname==='/repos/'+REPO+'/contents/.bridge/project.json'&&url.search==='?ref='+SHA)return Response.json({encoding:'base64',content:Buffer.from(JSON.stringify(policy)).toString('base64')});
    throw Error('unapproved endpoint: '+url.pathname);
  }});
  const service=createPrivateMcpHttpServer({gateway,bearerToken:TOKEN,clientId:'local-catalog'});
  const address=await service.listen({host:'127.0.0.1',port:0});
  const client=new Client({name:'local-catalog-test',version:'1'});t.after(async()=>{await client.close();await service.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{authorization:'Bearer '+TOKEN}}}));
  const tools=await client.listTools();const presets=tools.tools.filter(tool=>isRepositoryTool(tool.name));
  assert.equal(presets.length,1);assert.equal(presets[0].title,'Observe: inspect');assert.ok(presets[0].description.includes(REPO));assert.equal(JSON.stringify(tools).includes('team/not-granted'),false);
  assert.ok(requests.length>0);assert.ok(requests.every(request=>request.path.startsWith('/repos/'+REPO)));
  const before=requests.length;
  const denied=await client.callTool({name:'bridge.get_repository_configuration',arguments:{repository:'team/not-granted'}});
  assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error.code,'REPOSITORY_DENIED');assert.equal(requests.length,before);
  const noRun=await client.callTool({name:presets[0].name,arguments:{targetRef:'agent/work',parameters:{}}});
  assert.equal(noRun.isError,true);assert.equal(noRun.structuredContent.error.code,'REPOSITORY_DENIED');assert.ok(requests.every(request=>request.method==='GET'));
});
