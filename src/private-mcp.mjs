import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { assertBridge } from './errors.mjs';
import { createStaticRepositoryAuthorizer } from './authorization.mjs';
import { BridgeGateway } from './gateway.mjs';
import { GitHubRestClient, GitHubTransport } from './github-transport.mjs';
import { createBridgeMcpHandler } from './mcp-server.mjs';

const REPOSITORY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOOPBACK_HOSTS=new Set(['127.0.0.1','::1','localhost']);

function parseInteger(value,label,{minimum,maximum}) {
  const parsed=Number(value);
  assertBridge(Number.isInteger(parsed) && parsed>=minimum && parsed<=maximum,'PRIVATE_MCP_CONFIG_INVALID',`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function uniqueRepositories(values,label) {
  assertBridge(Array.isArray(values),'PRIVATE_MCP_CONFIG_INVALID',`${label} must be an array`);
  const result=[];
  const seen=new Set();
  for(const value of values) {
    assertBridge(typeof value==='string' && REPOSITORY_PATTERN.test(value),'PRIVATE_MCP_CONFIG_INVALID',`${label} contains invalid repository: ${value}`);
    if(!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function parseRepositoryGrants(raw) {
  let parsed;
  try { parsed=JSON.parse(raw); }
  catch(error) { throw new Error(`BRIDGE_REPOSITORY_GRANTS must be valid JSON: ${error.message}`); }
  assertBridge(parsed && typeof parsed==='object' && !Array.isArray(parsed),'PRIVATE_MCP_CONFIG_INVALID','BRIDGE_REPOSITORY_GRANTS must be an object');
  const read=uniqueRepositories(parsed.read ?? [],'read grants');
  const run=uniqueRepositories(parsed.run ?? [],'run grants');
  const publish=uniqueRepositories(parsed.publish ?? [],'publish grants');
  const readSet=new Set(read);
  const runSet=new Set(run);
  for(const repository of run) {
    assertBridge(readSet.has(repository),'PRIVATE_MCP_CONFIG_INVALID',`run grant requires read grant: ${repository}`);
  }
  for(const repository of publish) {
    assertBridge(readSet.has(repository) && runSet.has(repository),'PRIVATE_MCP_CONFIG_INVALID',`publish grant requires read and run grants: ${repository}`);
  }
  return {read,run,publish};
}

export function parsePrivateMcpConfig(env=process.env) {
  const bearerToken=env.BRIDGE_MCP_TOKEN;
  const githubToken=env.BRIDGE_GITHUB_TOKEN;
  assertBridge(typeof bearerToken==='string' && bearerToken.length>=24,'PRIVATE_MCP_CONFIG_INVALID','BRIDGE_MCP_TOKEN must be at least 24 characters');
  assertBridge(typeof githubToken==='string' && githubToken.length>0,'PRIVATE_MCP_CONFIG_INVALID','BRIDGE_GITHUB_TOKEN is required');
  assertBridge(typeof env.BRIDGE_REPOSITORY_GRANTS==='string' && env.BRIDGE_REPOSITORY_GRANTS.length>0,'PRIVATE_MCP_CONFIG_INVALID','BRIDGE_REPOSITORY_GRANTS is required');

  const host=env.BRIDGE_MCP_HOST ?? '127.0.0.1';
  assertBridge(LOOPBACK_HOSTS.has(host),'PRIVATE_MCP_CONFIG_INVALID','private MCP server must bind to loopback; expose it only through an authenticated reverse proxy/tunnel');
  const port=parseInteger(env.BRIDGE_MCP_PORT ?? '8787','BRIDGE_MCP_PORT',{minimum:1,maximum:65535});
  const grants=parseRepositoryGrants(env.BRIDGE_REPOSITORY_GRANTS);
  const clientId=env.BRIDGE_MCP_CLIENT_ID ?? 'bridge-private';
  assertBridge(typeof clientId==='string' && clientId.length>=1 && clientId.length<=128,'PRIVATE_MCP_CONFIG_INVALID','BRIDGE_MCP_CLIENT_ID is invalid');

  return {bearerToken,githubToken,grants,host,port,clientId};
}

function constantTimeTokenEqual(expected,actual) {
  if(typeof actual!=='string') return false;
  const a=Buffer.from(expected,'utf8');
  const b=Buffer.from(actual,'utf8');
  if(a.length!==b.length) return false;
  return timingSafeEqual(a,b);
}

export function authenticatePrivateRequest(request,{bearerToken,clientId}) {
  const header=request.headers.get('authorization') ?? '';
  const match=/^Bearer ([^\s]+)$/.exec(header);
  if(!match || !constantTimeTokenEqual(bearerToken,match[1])) {
    return new Response(JSON.stringify({error:'invalid_token'}),{
      status:401,
      headers:{
        'content-type':'application/json',
        'www-authenticate':'Bearer realm="bridge-private"'
      }
    });
  }
  return {
    token:match[1],
    clientId,
    scopes:['bridge'],
    expiresAt:Math.floor(Date.now()/1000)+300
  };
}

export function buildPrivateGateway({config,fetchImpl=globalThis.fetch}) {
  const authorizer=createStaticRepositoryAuthorizer(config.grants);
  const github=new GitHubRestClient({token:config.githubToken,fetchImpl});
  const transport=new GitHubTransport({github,authorizer});
  return new BridgeGateway({transport});
}

export function createPrivateMcpHttpServer({gateway,bearerToken,clientId='bridge-private'}) {
  assertBridge(gateway && typeof gateway==='object','PRIVATE_MCP_CONFIG_INVALID','gateway is required');
  assertBridge(typeof bearerToken==='string' && bearerToken.length>=24,'PRIVATE_MCP_CONFIG_INVALID','bearer token must be at least 24 characters');

  const mcp=createBridgeMcpHandler({
    gatewayForRequest:({authInfo})=>{
      assertBridge(authInfo?.clientId===clientId,'REPOSITORY_DENIED','authenticated private MCP principal required');
      return gateway;
    }
  });

  const webHandler={
    async fetch(request) {
      const url=new URL(request.url);
      if(url.pathname!=='/mcp') return new Response('Not found',{status:404});
      const authInfo=authenticatePrivateRequest(request,{bearerToken,clientId});
      if(authInfo instanceof Response) return authInfo;
      return mcp.fetch(request,{authInfo});
    }
  };

  const nodeHandler=toNodeHandler(webHandler);
  const validateHost=localhostHostValidation();
  const validateOrigin=localhostOriginValidation();
  const server=createServer((req,res)=>{
    if(!validateHost(req,res) || !validateOrigin(req,res)) return;
    void nodeHandler(req,res);
  });

  return {
    server,
    async listen({host='127.0.0.1',port=8787}={}) {
      assertBridge(LOOPBACK_HOSTS.has(host),'PRIVATE_MCP_CONFIG_INVALID','private MCP server must bind to loopback');
      server.listen(port,host);
      await once(server,'listening');
      return server.address();
    },
    async close() {
      await mcp.close();
      if(server.listening) {
        server.close();
        await once(server,'close');
      }
    }
  };
}
