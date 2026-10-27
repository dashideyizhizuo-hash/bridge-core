import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {repositoryToolCatalog,invokeRepositoryTool,isRepositoryTool,REPOSITORY_CATALOG_LIMITS,createRepositoryCatalogCache,availableRepositoryTools} from '../src/mcp-repository-catalog.mjs';
import {createBridgeMcpHandler} from '../src/mcp-server.mjs';
import {createRequestScopedGateway} from '../src/control-plane.mjs';
import {D1BridgeIdentityStore} from '../src/cloudflare/d1-identity-store.mjs';
import {createBridgePrincipal} from '../src/auth/principal.mjs';
import {BridgeError} from '../src/errors.mjs';

const POLICY='a'.repeat(40);
const preset=(id='verify-clean',parameters={})=>({id,class:'verify',parameters});
function configuration(repository,capabilities=[preset()],sha=POLICY){return {repository,policy:{ref:'main',sha},capabilities};}
function catalogGateway({repositories=['owner/project'],capabilities=[preset()],sha=POLICY}={}){
  const calls={list:0,discover:[],run:[]};
  const gateway={
    async listRepositories(){calls.list++;return repositories;},
    async discover({repository}={}){calls.discover.push(repository);return repository?configuration(repository,capabilities,sha):{direct:{hosts:[]}};},
    async run(args){calls.run.push(args);return {runId:'github-run-123',status:'QUEUED'};},
    async getRun(){return {};},async getResult(){return {};},async publish(){return {};}
  };
  return {gateway,calls};
}
async function clientFor(t,handler,owner){
  const client=new Client({name:owner,version:'1'});
  t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('https://catalog.example/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init),{authInfo:{clientId:owner}})}));
  return client;
}

test('preset catalog advertises closed typed inputs and binds the operation to exact repository/policy',async()=>{
  const f=catalogGateway({capabilities:[preset('verify-typed',{name:{type:'string',minLength:1,maxLength:20,pattern:'^[a-z]+$'},count:{type:'integer',minimum:1,maximum:9,default:3},optional:{type:'boolean',required:false}})]});
  const result=await repositoryToolCatalog(f.gateway);assert.equal(result.status,'ready');assert.equal(result.definitions.length,1);
  const tool=result.definitions[0];assert.equal(isRepositoryTool(tool.name),true);assert.ok(tool.name.length<=64);
  assert.deepEqual(tool.operation,{repository:'owner/project',policySha:POLICY,capability:'verify-typed'});
  assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.inputSchema.properties.parameters.additionalProperties,false);
  assert.deepEqual(tool.inputSchema.properties.parameters.required,['name']);
  assert.deepEqual(tool.inputSchema.properties.parameters.properties.count,{type:'integer',minimum:1,maximum:9,default:3});
  assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.destructiveHint,true);
  assert.equal('mode' in tool.inputSchema.properties,false);assert.equal('capability' in tool.inputSchema.properties,false);assert.equal('repository' in tool.inputSchema.properties,false);
  const args={targetRef:'agent/work',parameters:{name:'sample'}};
  await invokeRepositoryTool(f.gateway,tool,args);
  assert.deepEqual(f.calls.run,[{...args,mode:'capability',repository:'owner/project',expectedPolicySha:POLICY,capability:'verify-typed'}]);
  for(const key of ['mode','capability','repository','expectedPolicySha','verification','recipe','steps','trustedVerification'])
    await assert.rejects(invokeRepositoryTool(f.gateway,tool,{...args,[key]:'forged'}),error=>error?.code==='INVALID_MCP_ARGUMENTS');
  assert.equal(f.calls.run.length,1);
});

test('tool identity changes when repository, trusted policy or typed preset schema changes',async()=>{
  const names=[];
  for(const input of [{},{repositories:['other/project']},{sha:'b'.repeat(40)},{capabilities:[preset('verify-clean',{name:{type:'string'}})]}])
    names.push((await repositoryToolCatalog(catalogGateway(input).gateway)).definitions[0].name);
  assert.equal(new Set(names).size,4);
});

test('catalog overflow never publishes a truncated executable collection, including a requested known tool',async()=>{
  const first=(await repositoryToolCatalog(catalogGateway().gateway)).definitions[0].name;
  const capabilities=Array.from({length:REPOSITORY_CATALOG_LIMITS.tools+1},(_,i)=>preset(i===0?'verify-clean':'verify-'+i));
  const many=catalogGateway({capabilities});
  for(const requestedTool of [undefined,first]){
    const result=await repositoryToolCatalog(many.gateway,{requestedTool});
    assert.equal(result.status,'limit');assert.deepEqual(result.definitions,[]);assert.equal(result.errors.some(error=>error.code==='MCP_CATALOG_LIMIT'),true);
  }
  const tooManyRepositories=catalogGateway({repositories:Array.from({length:17},(_,i)=>'owner/project-'+i)});
  const result=await repositoryToolCatalog(tooManyRepositories.gateway);
  assert.equal(result.status,'limit');assert.deepEqual(result.definitions,[]);assert.equal(tooManyRepositories.calls.discover.length,0);
  const tooManyParameters=catalogGateway({capabilities:[preset('verify-many',Object.fromEntries(Array.from({length:33},(_,i)=>['param'+i,{type:'string'}])))]});
  assert.deepEqual((await repositoryToolCatalog(tooManyParameters.gateway)).definitions,[]);
});

test('requested tool lookup still checks the complete selected repository set for overflow',async()=>{
  const f=catalogGateway({repositories:['owner/first','owner/last']});
  f.gateway.discover=async({repository})=>{f.calls.discover.push(repository);return configuration(repository,Array.from({length:repository.endsWith('first')?1:46},(_,i)=>preset('verify-'+i)));};
  const requested=(await repositoryToolCatalog(catalogGateway({repositories:['owner/first'],capabilities:[preset('verify-0')]}).gateway)).definitions[0].name;
  const result=await repositoryToolCatalog(f.gateway,{requestedTool:requested});
  assert.deepEqual(f.calls.discover,['owner/first','owner/last']);assert.equal(result.status,'limit');assert.deepEqual(result.definitions,[]);
});

test('provider failures expose bounded error status without credentials or raw provider diagnostics',async()=>{
  const f=catalogGateway();f.gateway.listRepositories=async()=>{throw Error('Bearer private-provider-token');};
  const unavailable=await repositoryToolCatalog(f.gateway);assert.equal(unavailable.status,'unavailable');assert.deepEqual(unavailable.definitions,[]);
  assert.equal(JSON.stringify(unavailable).includes('private-provider'),false);
  const g=catalogGateway({repositories:['owner/good','owner/denied']});
  g.gateway.discover=async({repository})=>{if(repository.endsWith('denied'))throw Error('secret denial');return configuration(repository);};
  const partial=await repositoryToolCatalog(g.gateway);assert.equal(partial.status,'partial');assert.equal(partial.definitions.length,1);
  assert.equal(JSON.stringify(partial).includes('secret denial'),false);
});

test('actual SQLite repository enumeration keeps owners, read grants and suspension boundaries',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON;');
  sql.exec(readFileSync(new URL('../migrations/0001_remote_identity.sql',import.meta.url),'utf8'));
  for(const owner of ['alice','bob'])sql.prepare('INSERT INTO bridge_users VALUES(?,?,?,?,?,?,?)').run(owner,'test',owner,null,null,1,1);
  for(const [id,suspended] of [[1,null],[2,'2026-10-21']])sql.prepare('INSERT INTO github_installations VALUES(?,?,?,?,?,?,?)').run(id,'owner','1','Organization',suspended,1,1);
  for(const [owner,installation,repo,read] of [['alice',1,'owner/alice',1],['alice',1,'owner/no-read',0],['alice',2,'owner/suspended',1],['bob',1,'owner/bob',1]]){
    sql.prepare('INSERT OR IGNORE INTO user_installation_grants VALUES(?,?,?,?)').run(owner,installation,1,1);
    sql.prepare('INSERT INTO repository_grants VALUES(?,?,?,?,?,?,?,?)').run(owner,installation,repo,read,read,read,1,1);
  }
  const db={prepare(query){return {bind(...args){return {all:async()=>({results:sql.prepare(query).all(...args)})};}};},batch:async()=>{throw Error('read only');}};
  const authorizer=new D1BridgeIdentityStore({db});
  let providerCalls=0;
  const gateway=owner=>createRequestScopedGateway({principal:createBridgePrincipal({bridgeUserId:owner,externalProvider:'test',externalSubject:owner}),principalRepositoryAuthorizer:authorizer,
    installationResolver:{resolve:async()=>{providerCalls++;throw Error('enumeration must not acquire credentials');}},credentialProvider:{acquire:async()=>{providerCalls++;throw Error('unused');}}});
  assert.deepEqual(await gateway('alice').listRepositories(),['owner/alice']);assert.deepEqual(await gateway('bob').listRepositories(),['owner/bob']);assert.equal(providerCalls,0);
});

test('actual SDK tools/list is owner-specific and unknown, forged, old and cross-owner names cannot execute',async t=>{
  const a=catalogGateway({repositories:['owner/alice']}),b=catalogGateway({repositories:['owner/bob']});
  const handler=createBridgeMcpHandler({gatewayForRequest:({authInfo})=>authInfo.clientId==='alice'?a.gateway:b.gateway});t.after(()=>handler.close());
  const alice=await clientFor(t,handler,'alice'),bob=await clientFor(t,handler,'bob');
  const listedA=await alice.listTools(),listedB=await bob.listTools();
  const toolsA=listedA.tools.filter(tool=>isRepositoryTool(tool.name)),toolsB=listedB.tools.filter(tool=>isRepositoryTool(tool.name));
  assert.equal(toolsA.length,1);assert.equal(toolsB.length,1);assert.notEqual(toolsA[0].name,toolsB[0].name);
  assert.equal('operation' in toolsA[0],false);
  for(const name of [toolsA[0].name,'bridge.repo_000000000000_verify-clean_000000000000','bridge.run','bridge.discover']){
    await assert.rejects(bob.callTool({name,arguments:{targetRef:'agent/work',parameters:{}}}),error=>error?.code===-32602&&/not found/.test(error.message));
  }
  assert.equal(a.calls.run.length,0);assert.equal(b.calls.run.length,0);
  const valid=await alice.callTool({name:toolsA[0].name,arguments:{targetRef:'agent/work',parameters:{}}});
  assert.notEqual(valid.isError,true);assert.equal(a.calls.run.length,1);assert.equal(a.calls.run[0].repository,'owner/alice');
});

test('SDK rejects a previously advertised tool after selected ownership or trusted policy changes',async t=>{
  const f=catalogGateway();let currentSha=POLICY,selected=true;
  f.gateway.listRepositories=async()=>selected?['owner/project']:[];
  f.gateway.discover=async({repository})=>configuration(repository,[preset()],currentSha);
  const handler=createBridgeMcpHandler({gateway:f.gateway});t.after(()=>handler.close());const client=await clientFor(t,handler,'alice');
  const tool=(await client.listTools()).tools.find(tool=>isRepositoryTool(tool.name));
  for(const change of [()=>{currentSha='b'.repeat(40);},()=>{currentSha=POLICY;selected=false;}]){
    change();await assert.rejects(client.callTool({name:tool.name,arguments:{targetRef:'agent/work',parameters:{}}}),error=>error?.code===-32602&&/not found/.test(error.message));
    assert.equal(f.calls.run.length,0);
  }
});

test('SDK refuses even a valid named preset when the full current catalog overflows',async t=>{
  const f=catalogGateway();let overflow=false;
  f.gateway.discover=async({repository})=>configuration(repository,overflow?Array.from({length:47},(_,i)=>preset(i===0?'verify-clean':'verify-'+i)):[preset()]);
  const handler=createBridgeMcpHandler({gateway:f.gateway});t.after(()=>handler.close());const client=await clientFor(t,handler,'alice');
  const name=(await client.listTools()).tools.find(tool=>isRepositoryTool(tool.name)).name;overflow=true;
  await assert.rejects(client.callTool({name,arguments:{targetRef:'agent/work',parameters:{}}}),error=>error?.code===-32602&&/not found/.test(error.message));
  assert.equal(f.calls.run.length,0);
});

test('Host tool execution does not enumerate repositories or fetch GitHub configuration',async t=>{
  let lists=0,policies=0,dispatches=0;
  const gateway={listRepositories:async()=>{lists++;throw Error('provider offline');},discover:async args=>{if(args.repository){policies++;throw Error('must not inspect repository');}return {direct:{hosts:[]}};},
    run:async()=>{dispatches++;return {runId:'dx1:host-a:request-1234',status:'QUEUED'};},getRun:async()=>({}),getResult:async()=>({}),publish:async()=>({})};
  const handler=createBridgeMcpHandler({gateway});t.after(()=>handler.close());const client=await clientFor(t,handler,'alice');
  assert.notEqual((await client.callTool({name:'bridge.list_hosts',arguments:{}})).isError,true);
  assert.notEqual((await client.callTool({name:'bridge.run_host_command',arguments:{hostId:'host-a',argv:['whoami'],waitSeconds:0}})).isError,true);
  assert.equal(lists,0);assert.equal(policies,0);assert.equal(dispatches,1);
});

function memoryKv(){
  const values=new Map(),calls={get:[],put:[],delete:[]};
  return {values,calls,async get(key){calls.get.push(key);return values.get(key)??null;},async put(key,value,options){calls.put.push({key,options});values.set(key,value);},async delete(key){calls.delete.push(key);values.delete(key);}};
}

test('catalog cache separates authenticated owners and service origins without storing identity in its keys',async()=>{
  const kv=memoryKv(),clock=()=>1_000_000;
  const a=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://a.example/mcp',clock});
  const b=createRepositoryCatalogCache({kv,owner:'bob',origin:'https://a.example/mcp',clock});
  const otherOrigin=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://b.example/mcp',clock});
  const value=await repositoryToolCatalog(catalogGateway().gateway);await a.write(value);
  assert.deepEqual(await a.read(),value);assert.equal(await b.read(),null);assert.equal(await otherOrigin.read(),null);
  assert.equal(new Set(kv.calls.get).size,3);assert.ok(kv.calls.get.every(key=>!key.includes('alice')&&!key.includes('bob')));
  assert.deepEqual(kv.calls.put[0].options,{expirationTtl:60});
});

test('catalog cache rejects expiry, oversized data, malformed JSON and corrupt operation/schema graphs',async()=>{
  const kv=memoryKv();let now=1_000_000;
  const cache=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://catalog.example/mcp',clock:()=>now});
  await cache.write(await repositoryToolCatalog(catalogGateway().gateway));
  const key=kv.calls.put[0].key,original=kv.values.get(key),snapshot=JSON.parse(original);
  for(const mutate of [value=>{value.version=99;},value=>{value.createdAt=now+1;},value=>{value.expiresAt++;},
    value=>{value.catalog.definitions[0].operation.repository='foreign/repository';},value=>{value.catalog.definitions[0].operation.policySha='not-a-sha';},
    value=>{value.catalog.definitions[0].name='bridge.run';},value=>{value.catalog.definitions[0].inputSchema.additionalProperties=true;},
    value=>{value.catalog.definitions.push(value.catalog.definitions[0]);}]){
    const invalid=structuredClone(snapshot);mutate(invalid);kv.values.set(key,JSON.stringify(invalid));assert.equal(await cache.read(),null);
  }
  for(const raw of ['{invalid json','x'.repeat(512*1024+1)]){kv.values.set(key,raw);assert.equal(await cache.read(),null);}
  kv.values.set(key,original);now+=60_000;assert.equal(await cache.read(),null);
});

test('catalog cache rejects inconsistent limit snapshots and changed mutating annotations',async()=>{
  const kv=memoryKv(),cache=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://catalog.example/mcp',clock:()=>1_000_000});
  const catalog=await repositoryToolCatalog(catalogGateway().gateway);
  for(const status of ['limit','unavailable'])await cache.write({...catalog,status});
  assert.equal(kv.calls.put.length,0,'failed catalog states must never retain executable definitions');
  await cache.write(catalog);const key=kv.calls.put[0].key;
  const invalid=JSON.parse(kv.values.get(key));invalid.catalog.definitions[0].annotations.readOnlyHint=true;kv.values.set(key,JSON.stringify(invalid));
  assert.equal(await cache.read(),null,'cached descriptor cannot relabel execution as read-only');
});

test('overflow cannot populate a cached subset and no-cache/force-refresh keep the same bounded semantics',async()=>{
  const kv=memoryKv(),cache=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://catalog.example/mcp',clock:()=>1_000_000});
  const f=catalogGateway({capabilities:Array.from({length:47},(_,i)=>preset('verify-'+i))});
  const cached=await availableRepositoryTools(f.gateway,{cache}),uncached=await availableRepositoryTools(f.gateway);
  assert.equal(cached.status,'limit');assert.deepEqual(cached.definitions,[]);assert.deepEqual(uncached.definitions,[]);
  assert.equal([...kv.values.values()].some(raw=>JSON.parse(raw).catalog.definitions.length>0),false);
  const g=catalogGateway();await availableRepositoryTools(g.gateway,{cache,forceRefresh:true});
  const before=g.calls.discover.length;await availableRepositoryTools(g.gateway,{cache});assert.equal(g.calls.discover.length,before);
  await availableRepositoryTools(g.gateway,{cache,forceRefresh:true});assert.equal(g.calls.discover.length,before+1);
});

test('warm SDK preset calls use cached metadata but still dispatch through the current gateway and invalidate stale policy',async t=>{
  const kv=memoryKv(),cache=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://catalog.example/mcp',clock:()=>1_000_000});
  const f=catalogGateway();let currentSha=POLICY;
  f.gateway.discover=async({repository})=>{f.calls.discover.push(repository);return configuration(repository,[preset()],currentSha);};
  f.gateway.run=async args=>{f.calls.run.push(args);if(args.expectedPolicySha!==currentSha)throw new BridgeError('POLICY_STALE','policy changed');return {runId:'github-run-123',status:'QUEUED'};};
  const handler=createBridgeMcpHandler({gateway:f.gateway,repositoryCatalogCache:cache});t.after(()=>handler.close());const client=await clientFor(t,handler,'alice');
  const tool=(await client.listTools()).tools.find(tool=>isRepositoryTool(tool.name));const before=f.calls.discover.length;
  const args={targetRef:'agent/work',parameters:{}};
  assert.notEqual((await client.callTool({name:tool.name,arguments:args})).isError,true);
  assert.equal(f.calls.discover.length,before);assert.equal(f.calls.run.length,1);
  currentSha='b'.repeat(40);const stale=await client.callTool({name:tool.name,arguments:args});
  assert.equal(stale.isError,true);assert.equal(stale.structuredContent.error.code,'POLICY_STALE');
  assert.equal(f.calls.discover.length,before);assert.equal(f.calls.run.length,2);assert.equal(kv.calls.delete.length,1);
  await assert.rejects(client.callTool({name:tool.name,arguments:args}),error=>error?.code===-32602);
  assert.equal(f.calls.discover.length,before+1);assert.equal(f.calls.run.length,2);
});

test('cold catalog construction has at most three concurrent repository policy reads',async()=>{
  let active=0,maximum=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),threeStarted=new Promise(resolve=>{entered=resolve;});
  const f=catalogGateway({repositories:Array.from({length:8},(_,i)=>'owner/project-'+i)});
  f.gateway.discover=async({repository})=>{f.calls.discover.push(repository);active++;maximum=Math.max(maximum,active);if(active===3)entered();await gate;active--;return configuration(repository);};
  const pending=repositoryToolCatalog(f.gateway);await threeStarted;
  assert.equal(f.calls.discover.length,3);release();const catalog=await pending;
  assert.equal(maximum,3);assert.equal(catalog.status,'ready');assert.equal(catalog.definitions.length,8);
});

test('cold catalog accepts nine-second asynchronous metadata within its twelve-second budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let entered;const started=new Promise(resolve=>{entered=resolve;}),f=catalogGateway();
  f.gateway.discover=async({repository,signal})=>{f.calls.discover.push(repository);entered();await new Promise(resolve=>setTimeout(resolve,9000));signal.throwIfAborted();return configuration(repository);};
  const pending=repositoryToolCatalog(f.gateway);await started;t.mock.timers.tick(9000);
  const result=await pending;assert.equal(result.status,'ready');assert.equal(result.definitions.length,1);
});

test('cold catalog twelve-second deadline aborts pending loads and discards already completed tools',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let entered,aborted=0,settled=false;const threeStarted=new Promise(resolve=>{entered=resolve;});
  const f=catalogGateway({repositories:Array.from({length:8},(_,i)=>'owner/project-'+i)});
  f.gateway.discover=async({repository,signal})=>{
    f.calls.discover.push(repository);if(f.calls.discover.length===3)entered();
    if(repository.endsWith('-0'))return configuration(repository);
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}));
    return configuration(repository);
  };
  const pending=repositoryToolCatalog(f.gateway).then(result=>{settled=true;return result;});
  await threeStarted;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.discover.length,4,'one completed plus three pending; remaining repositories stay queued');
  t.mock.timers.tick(11999);await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  t.mock.timers.tick(1);const result=await pending;
  assert.equal(result.status,'unavailable');assert.deepEqual(result.definitions,[]);assert.equal(result.errors[0].code,'MCP_CATALOG_TIMEOUT');
  assert.equal(aborted,3);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.discover.length,4,'timeout must not start the four queued repositories');
});

test('catalog metadata byte ceiling refuses the whole executable catalog',async()=>{
  const f=catalogGateway({capabilities:[preset('verify-big',{value:{type:'string',default:'x'.repeat(512*1024)}})]});
  const result=await repositoryToolCatalog(f.gateway);assert.equal(result.status,'limit');assert.deepEqual(result.definitions,[]);
  assert.equal(result.errors.some(error=>error.code==='MCP_CATALOG_LIMIT'),true);
});

test('optional rebuild admission denies before provider work and returns only bounded retry diagnostics',async()=>{
  const f=catalogGateway(),kv=memoryKv();
  const cache=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://catalog.example/mcp',admit:async()=>{throw new BridgeError('MCP_CATALOG_RATE_LIMIT','private backend diagnostic',{retryAfterSeconds:12});}});
  const result=await availableRepositoryTools(f.gateway,{cache});
  assert.equal(result.status,'unavailable');assert.deepEqual(result.definitions,[]);assert.equal(result.errors[0].code,'MCP_CATALOG_RATE_LIMIT');assert.equal(result.errors[0].retryAfterSeconds,12);
  assert.equal(JSON.stringify(result).includes('private backend'),false);assert.equal(f.calls.list,0);assert.equal(f.calls.discover.length,0);assert.equal(kv.calls.put.length,0);
  const deniedCache=createRepositoryCatalogCache({kv,owner:'bob',origin:'https://catalog.example/mcp',admit:async()=>{throw new BridgeError('PRIVATE_BACKEND_FAILURE','private diagnostic',{retryAfterSeconds:61});}});
  const unavailable=await availableRepositoryTools(f.gateway,{cache:deniedCache});assert.equal(unavailable.errors[0].code,'MCP_CATALOG_UNAVAILABLE');assert.equal(unavailable.errors[0].retryAfterSeconds,undefined);assert.equal(f.calls.list,0);
});

test('warm catalog reads consume no rebuild admission; force refresh remains admitted and cannot fall back to stale tools',async()=>{
  const f=catalogGateway(),kv=memoryKv();let admitted=0,deny=false;
  const cache=createRepositoryCatalogCache({kv,owner:'alice',origin:'https://catalog.example/mcp',admit:async()=>{admitted++;if(deny)throw new BridgeError('MCP_CATALOG_RATE_LIMIT','denied');}});
  const cold=await availableRepositoryTools(f.gateway,{cache});assert.equal(cold.status,'ready');assert.equal(admitted,1);assert.equal(f.calls.list,1);
  deny=true;const warm=await availableRepositoryTools(f.gateway,{cache,requestedTool:cold.definitions[0].name});assert.equal(warm.definitions.length,1);assert.equal(admitted,1);assert.equal(f.calls.list,1);
  const forced=await availableRepositoryTools(f.gateway,{cache,forceRefresh:true});assert.equal(forced.status,'unavailable');assert.deepEqual(forced.definitions,[]);assert.equal(admitted,2);assert.equal(f.calls.list,1);
});
