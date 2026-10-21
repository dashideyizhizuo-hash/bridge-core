import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {assertBridge} from './errors.mjs';

export const REPOSITORY_CATALOG_LIMITS=Object.freeze({repositories:16,tools:46,parameters:32});
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,12);
const repoHash=repository=>digest(repository);
export const isRepositoryTool=name=>typeof name==='string'&&/^bridge\.repo_[0-9a-f]{12}_[a-z0-9_-]{1,24}_[0-9a-f]{12}$/.test(name);
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,...(required.length?{required}:{})});

function parameterSchema(specs) {
  const entries=Object.entries(specs),properties={},required=[];
  assertBridge(entries.length<=REPOSITORY_CATALOG_LIMITS.parameters,'MCP_CATALOG_LIMIT','A repository preset exceeds the 32-parameter limit');
  for(const [name,spec] of entries) {
    assertBridge(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)&&['string','integer','boolean'].includes(spec.type),
      'MCP_CATALOG_INVALID','Repository preset parameters are invalid');
    const schema={type:spec.type};
    for(const key of ['minLength','maxLength','minimum','maximum','pattern','default'])if(spec[key]!==undefined)schema[key]=spec[key];
    if(spec.type==='string'&&schema.maxLength===undefined)schema.maxLength=1_000_000;
    properties[name]=schema;
    if(spec.required!==false&&!Object.hasOwn(spec,'default'))required.push(name);
  }
  return object(properties,required);
}

function presetDefinition(repository,policySha,capability) {
  const inputSchema=object({
    targetRef:{type:'string',minLength:1,maxLength:255},
    targetSha:{type:'string',pattern:'^[0-9a-f]{40}$'},
    parameters:parameterSchema(capability.parameters??{}),
    taskSessionToken:{type:'string',pattern:'^bts_[A-Za-z0-9_-]{43,128}$'}
  },['targetRef','parameters']);
  const id=capability.id,slug=id.replaceAll('.','_').replaceAll('-','_').slice(0,24);
  const name=`bridge.repo_${repoHash(repository)}_${slug}_${digest(JSON.stringify({repository,policySha,id,inputSchema}))}`;
  return {
    name,
    title:`${capability.class==='verify'?'Verify':'Observe'}: ${id}`,
    description:`Execute only the declared ${id} ${capability.class} preset for ${repository}, using trusted default-branch policy ${policySha}. Its fixed command and parameter schema are declared before invocation. Project code may change files or access the network; current GitHub, project, Host and task permissions still apply. This does not publish changes. A changed policy rejects this tool; refresh the available tools rather than selecting another operation implicitly.`,
    annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true},
    inputSchema,
    operation:Object.freeze({repository,policySha,capability:id})
  };
}

// This bounded catalog is metadata, not authorization. It is rebuilt per owner
// and policy identity; invocations still use the billed, reauthorizing gateway.
// Fixed Host tools never fetch a GitHub policy and survive catalog/provider errors.
async function buildRepositoryToolCatalog(gateway,{requestedTool,signal}={}) {
  const empty={status:'ready',definitions:[],errors:[],repositories:[]};
  if(typeof gateway.listRepositories!=='function')return empty;
  let repositories;
  try {repositories=await gateway.listRepositories();}
  catch {return {...empty,status:'unavailable',errors:[{code:'MCP_CATALOG_UNAVAILABLE'}]};}
  if(repositories.length>REPOSITORY_CATALOG_LIMITS.repositories)return {...empty,status:'limit',errors:[{
    code:'MCP_CATALOG_LIMIT',message:'Select at most 16 repositories to expose their preset tools. Fixed Host operations remain available.'
  }]};
  const definitions=[],errors=[];let cursor=0,metadataBytes=0;
  const load=async repository=>{
    if(signal?.aborted)throw signal.reason;
    try {
      const configuration=await gateway.discover({repository,signal});
      signal?.throwIfAborted();
      assertBridge(configuration.repository===repository&&/^[0-9a-f]{40}$/.test(configuration.policy?.sha)&&Array.isArray(configuration.capabilities),
        'MCP_CATALOG_INVALID','Trusted repository identity is unavailable');
      for(const capability of configuration.capabilities) {
        assertBridge(/^[a-z][a-z0-9.-]{1,63}$/.test(capability.id)&&['observe','verify'].includes(capability.class),
          'MCP_CATALOG_INVALID','Trusted preset identity is unavailable');
        const definition=presetDefinition(repository,configuration.policy.sha,capability);
        metadataBytes+=Buffer.byteLength(JSON.stringify(definition));
        assertBridge(metadataBytes<=512*1024,'MCP_CATALOG_LIMIT','Repository metadata exceeds the 512 KiB catalog limit');
        definitions.push(definition);
        assertBridge(definitions.length<=REPOSITORY_CATALOG_LIMITS.tools,'MCP_CATALOG_LIMIT','Repository presets exceed the 46-tool catalog limit');
      }
    } catch(error) {
      signal?.throwIfAborted();
      errors.push({repository,code:['MCP_CATALOG_LIMIT','MCP_CATALOG_INVALID'].includes(error?.code)?error.code:'REPOSITORY_TOOLS_UNAVAILABLE'});
    }
  };
  await Promise.all(Array.from({length:Math.min(3,repositories.length)},async()=>{
    while(cursor<repositories.length){signal?.throwIfAborted();const repository=repositories[cursor++];await load(repository);}
  }));
  // Never publish a truncated catalog: no preset becomes executable through a
  // partially advertised collection. Status exposes the actionable failure.
  if(errors.some(item=>item.code==='MCP_CATALOG_LIMIT'))return {...empty,status:'limit',repositories,errors};
  const names=new Set();
  for(const item of definitions){assertBridge(!names.has(item.name),'MCP_CATALOG_INVALID','Repository tool identity collision');names.add(item.name);}
  definitions.sort((a,b)=>a.name.localeCompare(b.name));errors.sort((a,b)=>(a.repository??'').localeCompare(b.repository??''));
  return {status:errors.length?'partial':'ready',definitions:requestedTool?definitions.filter(item=>item.name===requestedTool):definitions,errors,repositories};
}

export async function repositoryToolCatalog(gateway,{signal,timeoutMs=8000,...options}={}) {
  const cancellation=new AbortController(),combined=signal?AbortSignal.any([signal,cancellation.signal]):cancellation.signal;
  let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>{
    cancellation.abort(new Error('Repository catalog deadline exceeded'));
    resolve({status:'unavailable',definitions:[],repositories:[],errors:[{code:'MCP_CATALOG_TIMEOUT',message:'Repository tool metadata timed out. Fixed Host operations remain available; retry repository_tools_status later.'}]});
  },timeoutMs);});
  try {return await Promise.race([buildRepositoryToolCatalog(gateway,{...options,signal:combined}),timeout]);}
  finally {clearTimeout(timer);}
}

export async function invokeRepositoryTool(gateway,definition,args) {
  const op=definition.operation;
  assertBridge(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(key=>['targetRef','targetSha','parameters'].includes(key)),
    'INVALID_MCP_ARGUMENTS','Unsupported repository preset argument');
  return gateway.run({...args,mode:'capability',repository:op.repository,expectedPolicySha:op.policySha,capability:op.capability});
}

const CACHE_BYTES=512*1024,CACHE_MS=60_000;
function validSnapshot(value,now) {
  if(value?.version!==1||!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.expiresAt)||
    value.createdAt>now||value.expiresAt<=now||value.expiresAt-value.createdAt!==CACHE_MS)return false;
  const c=value.catalog;
  if(!c||!['ready','partial','limit','unavailable'].includes(c.status)||!Array.isArray(c.definitions)||c.definitions.length>46||
    !Array.isArray(c.repositories)||c.repositories.length>16||!Array.isArray(c.errors)||c.errors.length>17)return false;
  if(['limit','unavailable'].includes(c.status)&&c.definitions.length)return false;
  const names=new Set();
  for(const d of c.definitions) {
    const op=d?.operation;
    if(!op||!c.repositories.includes(op.repository)||!/^[0-9a-f]{40}$/.test(op.policySha)||
      !/^[a-z][a-z0-9.-]{1,63}$/.test(op.capability)||!isRepositoryTool(d.name)||names.has(d.name))return false;
    if(d.annotations?.readOnlyHint!==false||d.annotations?.destructiveHint!==true||d.annotations?.openWorldHint!==true)return false;
    const slug=op.capability.replaceAll('.','_').replaceAll('-','_').slice(0,24);
    if(d.name!==`bridge.repo_${repoHash(op.repository)}_${slug}_${digest(JSON.stringify({repository:op.repository,policySha:op.policySha,id:op.capability,inputSchema:d.inputSchema}))}`)return false;
    if(d.inputSchema?.type!=='object'||d.inputSchema.additionalProperties!==false||
      Object.keys(d.inputSchema.properties??{}).some(key=>!['targetRef','targetSha','parameters','taskSessionToken'].includes(key))||
      d.inputSchema.properties.parameters?.type!=='object'||d.inputSchema.properties.parameters.additionalProperties!==false)return false;
    names.add(d.name);
  }
  return true;
}

export function createRepositoryCatalogCache({kv,owner,origin,clock=()=>Date.now(),admit}={}) {
  assertBridge(kv&&typeof kv.get==='function'&&typeof kv.put==='function'&&typeof kv.delete==='function'&&
    typeof owner==='string'&&owner.length>0&&typeof origin==='string','MCP_CATALOG_INVALID','An authenticated catalog cache is required');
  // Neither the namespace nor owner comes from tool arguments. Hashes keep
  // account identifiers out of key listings; no bearer or provider tokens enter KV.
  const key='mcp-public-v2:'+createHash('sha256').update(origin+'\0'+owner).digest('hex');
  return {
    ...(typeof admit==='function'?{admit}:{}),
    async read(){
      try {
        const raw=await kv.get(key);
        if(typeof raw!=='string'||Buffer.byteLength(raw)>CACHE_BYTES)return null;
        const value=JSON.parse(raw);return validSnapshot(value,clock())?value.catalog:null;
      } catch {return null;}
    },
    async write(catalog){
      const now=clock(),value={version:1,createdAt:now,expiresAt:now+CACHE_MS,catalog},raw=JSON.stringify(value);
      if(Buffer.byteLength(raw)>CACHE_BYTES||!validSnapshot(value,now))return;
      try {await kv.put(key,raw,{expirationTtl:60});}catch{}
    },
    async invalidate(){try {await kv.delete(key);}catch{}}
  };
}

export async function availableRepositoryTools(gateway,{cache,requestedTool,forceRefresh=false,signal}={}) {
  let catalog=!forceRefresh&&cache?await cache.read():null;
  if(!catalog){
    try {await cache?.admit?.();}
    catch(error){return {status:'unavailable',definitions:[],repositories:[],errors:[{
      code:error?.code==='MCP_CATALOG_RATE_LIMIT'?'MCP_CATALOG_RATE_LIMIT':'MCP_CATALOG_UNAVAILABLE',
      ...(Number.isInteger(error?.details?.retryAfterSeconds)&&error.details.retryAfterSeconds>=1&&error.details.retryAfterSeconds<=60?{retryAfterSeconds:error.details.retryAfterSeconds}:{}),
      message:'Repository metadata rebuild is temporarily unavailable. Fixed Host operations remain available.'
    }]};}
    catalog=await repositoryToolCatalog(gateway,{signal});if(cache)await cache.write(catalog);
  }
  return requestedTool?{...catalog,definitions:catalog.definitions.filter(item=>item.name===requestedTool)}:catalog;
}
