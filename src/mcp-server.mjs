import { createMcpHandler, fromJsonSchema, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { Buffer } from 'node:buffer';
import { assertBridge, errorEnvelope } from './errors.mjs';
import { MCP_TOOL_DEFINITIONS } from './mcp-tools.mjs';
import {invokePublicTool} from './mcp-public-api.mjs';
import {availableRepositoryTools,invokeRepositoryTool,isRepositoryTool} from './mcp-repository-catalog.mjs';
import {readBoundedBody} from './cloudflare/request-body.mjs';

const CORE_GATEWAY_METHODS=Object.freeze([
  'discover','run','getRun','getResult','publish'
]);

function assertGateway(gateway) {
  assertBridge(gateway && typeof gateway === 'object', 'GATEWAY_CONFIG_INVALID', 'gateway is required');
  for (const method of CORE_GATEWAY_METHODS) {
    assertBridge(typeof gateway[method] === 'function', 'GATEWAY_CONFIG_INVALID', `gateway missing method: ${method}`);
  }
  return gateway;
}

function expiredExport(item,now) {
  return item?.kind==='asset' && item?.transport==='direct-asset' &&
    item?.status==='READY' && typeof item.assetId==='string' && item.persistent===false &&
    Number.isFinite(item.expiresAt) && item.expiresAt<=now;
}

async function assetLinks(value,gateway,clock) {
  const candidates=[];
  const directResult=value?.kind==='direct' && value?.transport==='direct' && Array.isArray(value.exports);
  if(value?.kind==='asset' && value?.transport==='direct-asset' &&
    typeof value.assetId==='string' && value.status==='READY') candidates.push(value);
  if(directResult) candidates.push(...value.exports.filter(item=>
    item?.kind==='asset' && item?.transport==='direct-asset' && item?.status==='READY'));
  const seen=new Set(),expired=new Set(),links=[];
  const isExpired=item=>directResult && expiredExport(item,clock());
  for(const item of candidates) {
    if(!item || typeof item.assetId!=='string')continue;
    if(isExpired(item)){expired.add(item);continue;}
    if(seen.has(item.assetId))continue;
    seen.add(item.assetId);
    assertBridge(typeof gateway.issueAssetResource==='function',
      'DIRECT_ASSET_RESOURCE_UNAVAILABLE','Bridge private file resources are unavailable on this deployment');
    let issued;
    try {issued=await gateway.issueAssetResource({assetId:item.assetId});}
    catch(error) {
      // A TTL can elapse during the awaited authorization query. Downgrade only
      // when the authorized run receipt independently proves temporary expiry;
      // a DENIED code, missing metadata or absent expiry is not that evidence.
      // Unexpected/service errors remain failures even across the TTL boundary.
      if(!['DIRECT_ASSET_DENIED','DIRECT_ASSET_EXPIRED'].includes(error?.code) || !isExpired(item))throw error;
      expired.add(item);continue;
    }
    if(isExpired(item)){expired.add(item);continue;}
    links.push({
      type:'resource_link',
      uri:issued.uri,
      name:typeof item.fileName==='string' ? item.fileName : item.assetId,
      ...(typeof item.mimeType==='string' ? {mimeType:item.mimeType} : {}),
      ...(Number.isInteger(item.sizeBytes) && item.sizeBytes>=0 ? {size:item.sizeBytes} : {}),
      description:'Short-lived access to a principal-owned Bridge file stored in private R2'
    });
  }
  return {links,expired};
}

async function successResult(value,gateway,toolName,clock) {
  // File delivery is an explicit result read, separate from submitting native
  // file parameters or polling metadata. Run authorization has already passed.
  const {links,expired}=toolName==='bridge.get_result'
    ? await assetLinks(value,gateway,clock) : {links:[],expired:new Set()};
  if(expired.size) {
    // Keep the durable READY history intact, even after asset metadata is pruned.
    value={...value,exports:value.exports.map(item=>expired.has(item) ? {...item,availability:'expired'} : item)};
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(value) },
      ...(expired.size ? [{type:'text',text:'One or more temporary output files have expired. Their receipts and command output remain available; expired files have no download link.'}] : []),
      ...links
    ],
    structuredContent: value
  };
}

function failureResult(error) {
  const envelope = errorEnvelope(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: envelope }) }],
    structuredContent: { error: envelope },
    isError: true
  };
}

function splitTaskSessionToken(args) {
  if(!args || typeof args!=='object' || Array.isArray(args)) {
    return {taskSessionToken:null,args:args ?? {}};
  }
  const {taskSessionToken,...rest}=args;
  return {
    taskSessionToken:taskSessionToken ?? null,
    args:rest
  };
}

export function createBridgeMcpHandler({
  gateway,
  gatewayForRequest,
  gatewayForTool,
  repositoryCatalogCache,
  clock=()=>Date.now()
} = {}) {
  assertBridge(
    gateway !== undefined || typeof gatewayForRequest === 'function',
    'GATEWAY_CONFIG_INVALID',
    'gateway or gatewayForRequest is required'
  );

  const resolveGateway =
    typeof gatewayForRequest === 'function'
      ? gatewayForRequest
      : () => gateway;

  const handlers=new Set();
  const createHandler=scope=>createMcpHandler(async context => {
    const baseGateway = assertGateway(
      resolveGateway({
        authInfo: context?.authInfo,
        requestInfo: context?.requestInfo
      })
    );

    const server = new McpServer({
      name: 'runner-bridge',
      version: '0.5.0'
    },{maxToolInputElements:10_000});

    server.registerResource(
      'bridge-private-file',
      new ResourceTemplate('bridge-file:///access/{token}', { list: undefined }),
      {
        title:'Bridge private file',
        description:'Principal-owned file stored in Bridge private R2',
        mimeType:'application/octet-stream'
      },
      async (uri,{token}) => {
        assertBridge(
          typeof baseGateway.readAssetResource==='function',
          'DIRECT_ASSET_UNAVAILABLE',
          'Bridge private file resources are unavailable on this deployment'
        );
        const result=await baseGateway.readAssetResource({token,holdBuffer:scope?.hold,signal:scope?.signal});
        return {
          contents:[{
            uri:uri.href,
            mimeType:result.asset.mimeType,
            blob:Buffer.from(result.bytes.buffer,result.bytes.byteOffset,result.bytes.byteLength).toString('base64')
          }]
        };
      }
    );

    const needsCatalog=scope?.method==='tools/list'||isRepositoryTool(scope?.toolName)||scope?.toolName==='bridge.repository_tools_status';
    const catalog=needsCatalog?await availableRepositoryTools(baseGateway,{cache:repositoryCatalogCache,forceRefresh:scope?.toolName==='bridge.repository_tools_status',requestedTool:isRepositoryTool(scope?.toolName)?scope.toolName:undefined,signal:scope?.signal}):{status:'not-requested',definitions:[],errors:[],repositories:[]};
    for (const definition of [...MCP_TOOL_DEFINITIONS,...catalog.definitions]) {
      server.registerTool(
        definition.name,
        {
          title:definition.title,
          description: definition.description,
          annotations:definition.annotations,
          inputSchema: fromJsonSchema(definition.inputSchema),
          ...(definition._meta===undefined ? {} : {_meta:definition._meta})
        },
        async rawArgs => {
          try {
            const separated=splitTaskSessionToken(rawArgs);
            let activeGateway=baseGateway;
            if(separated.taskSessionToken!==null) {
              assertBridge(
                typeof gatewayForTool==='function',
                'TASK_SESSION_UNAVAILABLE',
                'task session capabilities are unavailable on this Bridge deployment'
              );
              activeGateway=assertGateway(await gatewayForTool({
                toolName:definition.name,
                taskSessionToken:separated.taskSessionToken,
                args:separated.args,
                baseGateway,
                authInfo:context?.authInfo,
                requestInfo:context?.requestInfo
              }));
            }
            return await successResult(
              definition.name==='bridge.repository_tools_status'
                ? {status:catalog.status,toolNames:catalog.definitions.map(item=>item.name),repositories:catalog.repositories,errors:catalog.errors}
                : definition.operation
                  ? await invokeRepositoryTool(activeGateway,definition,separated.args)
                  : await invokePublicTool(activeGateway,definition.name,separated.args,{signal:scope?.signal}),
              activeGateway,
              definition.name,
              clock
            );
          } catch (error) {
            if(['POLICY_STALE','REPOSITORY_DENIED'].includes(error?.code))await repositoryCatalogCache?.invalidate();
            return failureResult(error);
          }
        }
      );
    }

    return server;
  },{maxRequestBodySize:2*1024*1024});
  return {
    async close(){await Promise.all([...handlers].map(handler=>handler.close()));},
    async fetch(request,...args) {
      let method,toolName;
      // Bound and cancel the original source before SDK request classification
      // can clone/tee it. File payload bytes use the separate asset endpoints.
      if(request.method==='POST'&&request.body){
        let bytes;
        try {bytes=await readBoundedBody(request,{maxBytes:2*1024*1024,code:'MCP_REQUEST_TOO_LARGE',signal:request.signal});}
        catch(error){
          if(error?.code!=='MCP_REQUEST_TOO_LARGE')throw error;
          return Response.json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'MCP request body exceeds the 2 MiB limit or has an invalid length'}},{status:413,headers:{'cache-control':'no-store'}});
        }
        // Routing hints never bypass SDK argument or authentication validation.
        try {const hint=JSON.parse(new TextDecoder().decode(bytes));method=hint?.method;toolName=hint?.params?.name;}catch{}
        request=new Request(request,{body:bytes});
      }
      const holds=new Set(),cancellation=new AbortController();let reader,finished=false,streamController,ready,ending;
      const responseReady=new Promise(resolve=>{ready=resolve;});
      const finish=()=>{
        if(finished)return;finished=true;
        for(const hold of holds){hold.signal.removeEventListener('abort',abort);hold.release();}
        holds.clear();handlers.delete(handler);void handler.close().catch(()=>{});
        request.signal?.removeEventListener('abort',abort);cancellation.abort();
      };
      const abort=()=>{
        if(finished)return;
        if(!ending)ending=Promise.resolve().then(async()=>{
          cancellation.abort();
          try {await responseReady;await reader?.cancel().catch(()=>{});} finally {
            try {streamController?.error(new Error('File response canceled or timed out'));} catch {}
            finish();
          }
        });
        return ending;
      };
      request.signal?.addEventListener('abort',abort,{once:true});
      const scope={method,toolName,signal:cancellation.signal,hold(lease){
        if(finished){lease.release();throw new Error('File response is closed');}
        holds.add(lease);lease.signal.addEventListener('abort',abort,{once:true});
        if(lease.signal.aborted)void abort();
      }};
      const handler=createHandler(scope);handlers.add(handler);
      if(request.signal?.aborted)void abort();
      try {
        const response=await handler.fetch(request,...args);
        if(!response.body){ready();finish();return response;}
        reader=response.body.getReader();ready();
        const stream=new ReadableStream({
          start(controller){streamController=controller;},
          async pull(controller){
            try {
              const {done,value}=await reader.read();
              if(done){finish();controller.close();}else controller.enqueue(value);
            } catch(error){finish();controller.error(error);}
          },
          cancel(){return abort();}
        },{highWaterMark:0});
        return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
      } catch(error){ready();finish();throw error;}
    }
  };
}
