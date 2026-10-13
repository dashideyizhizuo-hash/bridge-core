import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { assertBridge } from './errors.mjs';
import {
  createRemoteBridgeApplication,
  parseRemoteServiceConfig
} from './remote-service.mjs';

function parseInteger(value,label,{minimum,maximum}) {
  const parsed=Number(value);
  assertBridge(
    Number.isInteger(parsed) && parsed>=minimum && parsed<=maximum,
    'REMOTE_SERVICE_CONFIG_INVALID',
    `${label} must be an integer between ${minimum} and ${maximum}`
  );
  return parsed;
}

function normalizeRuntimeModule(value) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=1024,
    'REMOTE_SERVICE_CONFIG_INVALID',
    'BRIDGE_REMOTE_RUNTIME_MODULE is required'
  );
  return value;
}

function runtimeSpecifier(value) {
  if(value.startsWith('.') || value.startsWith('/')) {
    return pathToFileURL(resolvePath(process.cwd(),value)).href;
  }
  return value;
}

export function parseNodeRemoteServiceConfig(env=process.env) {
  const core=parseRemoteServiceConfig(env);
  const host=env.BRIDGE_REMOTE_HOST ?? '0.0.0.0';
  assertBridge(
    typeof host==='string' && host.length>=1 && host.length<=253,
    'REMOTE_SERVICE_CONFIG_INVALID',
    'BRIDGE_REMOTE_HOST is invalid'
  );
  const port=parseInteger(
    env.BRIDGE_REMOTE_PORT ?? env.PORT ?? '8787',
    'BRIDGE_REMOTE_PORT',
    {minimum:1,maximum:65535}
  );

  const inlinePrivateKey=env.BRIDGE_GITHUB_APP_PRIVATE_KEY;
  const privateKeyFile=env.BRIDGE_GITHUB_APP_PRIVATE_KEY_FILE;
  assertBridge(
    Boolean(inlinePrivateKey) !== Boolean(privateKeyFile),
    'REMOTE_SERVICE_CONFIG_INVALID',
    'configure exactly one of BRIDGE_GITHUB_APP_PRIVATE_KEY or BRIDGE_GITHUB_APP_PRIVATE_KEY_FILE'
  );

  return Object.freeze({
    core,
    host,
    port,
    runtimeModule:normalizeRuntimeModule(env.BRIDGE_REMOTE_RUNTIME_MODULE),
    githubPrivateKey:inlinePrivateKey
      ? Object.freeze({kind:'env',value:inlinePrivateKey})
      : Object.freeze({kind:'file',value:privateKeyFile})
  });
}

export async function loadGitHubAppPrivateKey(source) {
  assertBridge(
    source && (source.kind==='env' || source.kind==='file') && typeof source.value==='string',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'GitHub App private-key source is invalid'
  );
  if(source.kind==='env') return source.value;

  try {
    const value=await readFile(source.value,'utf8');
    assertBridge(
      value.length>0,
      'REMOTE_SERVICE_CONFIG_INVALID',
      'GitHub App private-key secret file is empty'
    );
    return value;
  } catch(error) {
    if(error?.code==='REMOTE_SERVICE_CONFIG_INVALID') throw error;
    assertBridge(
      false,
      'REMOTE_SERVICE_CONFIG_INVALID',
      'unable to read GitHub App private-key secret file'
    );
  }
}

export async function loadRemoteRuntime(moduleSpecifier,{
  env=process.env,
  resourceServerUrl
}={}) {
  const specifier=normalizeRuntimeModule(moduleSpecifier);
  let loaded;
  try {
    loaded=await import(runtimeSpecifier(specifier));
  } catch {
    assertBridge(
      false,
      'REMOTE_SERVICE_CONFIG_INVALID',
      'unable to load BRIDGE_REMOTE_RUNTIME_MODULE'
    );
  }
  assertBridge(
    typeof loaded.createBridgeRemoteRuntime==='function',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote runtime module must export createBridgeRemoteRuntime(...)'
  );
  return loaded.createBridgeRemoteRuntime({
    env,
    resourceServerUrl:new URL(resourceServerUrl)
  });
}

export function createRemoteBridgeHttpServer({
  webApplication,
  host='0.0.0.0',
  port=8787
}={}) {
  assertBridge(
    webApplication &&
      typeof webApplication.fetch==='function' &&
      typeof webApplication.close==='function',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote web application is required'
  );

  const nodeHandler=toNodeHandler({
    fetch:request=>webApplication.fetch(request)
  });
  const server=createServer((req,res)=>{
    void nodeHandler(req,res);
  });

  return Object.freeze({
    server,
    async listen({host:listenHost=host,port:listenPort=port}={}) {
      server.listen(listenPort,listenHost);
      await once(server,'listening');
      return server.address();
    },
    async close() {
      await webApplication.close();
      if(server.listening) {
        server.close();
        await once(server,'close');
      }
    }
  });
}

export function publicNodeRemoteServiceConfig(config) {
  assertBridge(
    config && typeof config==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'node remote service config is required'
  );
  return Object.freeze({
    ...config.core,
    publicUrl:config.core.publicUrl.href,
    trustedHosts:Object.freeze([...config.core.trustedHosts]),
    allowedOrigins:Object.freeze([...config.core.allowedOrigins]),
    host:config.host,
    port:config.port,
    runtimeModule:config.runtimeModule
  });
}

export async function createNodeRemoteBridgeApplication({
  env=process.env,
  fetchImpl=globalThis.fetch,
  runtime,
  privateKey
}={}) {
  const config=parseNodeRemoteServiceConfig(env);
  const activeRuntime=runtime ?? await loadRemoteRuntime(config.runtimeModule,{
    env,
    resourceServerUrl:config.core.publicUrl
  });
  const activePrivateKey=privateKey ?? await loadGitHubAppPrivateKey(config.githubPrivateKey);
  const webApplication=await createRemoteBridgeApplication({
    env,
    fetchImpl,
    runtime:activeRuntime,
    privateKey:activePrivateKey
  });
  const http=createRemoteBridgeHttpServer({
    webApplication,
    host:config.host,
    port:config.port
  });

  return Object.freeze({
    config:publicNodeRemoteServiceConfig(config),
    fetch:request=>webApplication.fetch(request),
    async listen() {
      return http.listen();
    },
    async close() {
      await http.close();
    }
  });
}
