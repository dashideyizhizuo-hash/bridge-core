import { assertBridge } from './errors.mjs';
import { createGitHubAppJwtProvider } from './auth/github-app-jwt.mjs';
import { GitHubAppInstallationClient } from './auth/github-installations.mjs';
import { GitHubAppCredentialProvider } from './auth/github-app-credentials.mjs';
import { createRequestScopedGateway } from './control-plane.mjs';
import { createBridgeOAuthMcpHandler } from './oauth-resource-server.mjs';

const HOST_PATTERN=/^[A-Za-z0-9.:[\]-]{1,253}$/;

function parsePublicUrl(value) {
  let url;
  try {
    url=new URL(value);
  } catch {
    assertBridge(false,'REMOTE_SERVICE_CONFIG_INVALID','BRIDGE_PUBLIC_URL must be an absolute URL');
  }
  assertBridge(
    url.protocol==='https:',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'BRIDGE_PUBLIC_URL must use HTTPS'
  );
  assertBridge(
    url.username==='' &&
      url.password==='' &&
      url.search==='' &&
      url.hash==='' &&
      url.pathname==='/mcp',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'BRIDGE_PUBLIC_URL must be a clean HTTPS /mcp endpoint'
  );
  return url;
}

function parseHttpsApiBase(value) {
  let url;
  try {
    url=new URL(value);
  } catch {
    assertBridge(false,'REMOTE_SERVICE_CONFIG_INVALID','BRIDGE_GITHUB_API_BASE must be an absolute URL');
  }
  assertBridge(
    url.protocol==='https:' &&
      url.username==='' &&
      url.password==='' &&
      url.search==='' &&
      url.hash==='',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'BRIDGE_GITHUB_API_BASE must be a clean HTTPS URL'
  );
  return url.href.replace(/\/$/,'');
}

function parseCsv(value,label) {
  if(value===undefined || value==='') return [];
  assertBridge(
    typeof value==='string',
    'REMOTE_SERVICE_CONFIG_INVALID',
    `${label} must be a comma-separated string`
  );
  const result=[];
  const seen=new Set();
  for(const raw of value.split(',')) {
    const item=raw.trim();
    assertBridge(
      item.length>=1 && item.length<=512,
      'REMOTE_SERVICE_CONFIG_INVALID',
      `${label} contains an invalid value`
    );
    if(!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function parseTrustedHosts(value,publicUrl) {
  const hosts=new Set([publicUrl.host]);
  for(const host of parseCsv(value,'BRIDGE_REMOTE_TRUSTED_HOSTS')) {
    assertBridge(
      HOST_PATTERN.test(host),
      'REMOTE_SERVICE_CONFIG_INVALID',
      'BRIDGE_REMOTE_TRUSTED_HOSTS contains an invalid host'
    );
    hosts.add(host);
  }
  return Object.freeze([...hosts]);
}

function parseAllowedOrigins(value,publicUrl) {
  const origins=new Set([publicUrl.origin]);
  for(const raw of parseCsv(value,'BRIDGE_REMOTE_ALLOWED_ORIGINS')) {
    let origin;
    try {
      origin=new URL(raw);
    } catch {
      assertBridge(false,'REMOTE_SERVICE_CONFIG_INVALID','BRIDGE_REMOTE_ALLOWED_ORIGINS contains an invalid URL');
    }
    assertBridge(
      origin.protocol==='https:' &&
        origin.username==='' &&
        origin.password==='' &&
        origin.pathname==='/' &&
        origin.search==='' &&
        origin.hash==='',
      'REMOTE_SERVICE_CONFIG_INVALID',
      'BRIDGE_REMOTE_ALLOWED_ORIGINS must contain HTTPS origins only'
    );
    origins.add(origin.origin);
  }
  return Object.freeze([...origins]);
}

function normalizeGithubIssuer(value) {
  assertBridge(
    (typeof value==='string' && value.length>=1 && value.length<=256) ||
      (Number.isSafeInteger(value) && value>0),
    'REMOTE_SERVICE_CONFIG_INVALID',
    'BRIDGE_GITHUB_APP_ISSUER is required'
  );
  return value;
}

function privateKeyValue(value) {
  assertBridge(
    typeof value==='string' && value.length>=1,
    'REMOTE_SERVICE_CONFIG_INVALID',
    'GitHub App private-key secret is required'
  );
  return value;
}

export function parseRemoteServiceConfig(env={}) {
  assertBridge(
    env && typeof env==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote service environment is required'
  );
  const publicUrl=parsePublicUrl(env.BRIDGE_PUBLIC_URL);
  return Object.freeze({
    publicUrl,
    trustedHosts:parseTrustedHosts(env.BRIDGE_REMOTE_TRUSTED_HOSTS,publicUrl),
    allowedOrigins:parseAllowedOrigins(env.BRIDGE_REMOTE_ALLOWED_ORIGINS,publicUrl),
    githubAppIssuer:normalizeGithubIssuer(env.BRIDGE_GITHUB_APP_ISSUER),
    githubApiBase:parseHttpsApiBase(env.BRIDGE_GITHUB_API_BASE ?? 'https://api.github.com')
  });
}

export function assertRemoteRuntime(runtime) {
  assertBridge(
    runtime && typeof runtime==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote runtime is required'
  );
  assertBridge(
    runtime.oauth &&
      runtime.oauth.verifier &&
      typeof runtime.oauth.verifier.verifyAccessToken==='function' &&
      runtime.oauth.principalResolver &&
      typeof runtime.oauth.principalResolver.resolve==='function' &&
      runtime.oauth.metadata &&
      typeof runtime.oauth.metadata==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote runtime OAuth configuration is incomplete'
  );
  assertBridge(
    runtime.identity &&
      runtime.identity.principalRepositoryAuthorizer &&
      typeof runtime.identity.principalRepositoryAuthorizer.assert==='function' &&
      runtime.identity.installationResolver &&
      typeof runtime.identity.installationResolver.resolve==='function',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote runtime identity configuration is incomplete'
  );
  if(runtime.oauth.requiredScopes!==undefined) {
    assertBridge(
      Array.isArray(runtime.oauth.requiredScopes) && runtime.oauth.requiredScopes.length>=1,
      'REMOTE_SERVICE_CONFIG_INVALID',
      'remote runtime OAuth requiredScopes is invalid'
    );
  }
  return runtime;
}

export function buildRemoteBridgeMcpService({
  config,
  runtime,
  privateKey,
  fetchImpl=globalThis.fetch
}={}) {
  assertBridge(
    config && typeof config==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote service config is required'
  );
  const activeRuntime=assertRemoteRuntime(runtime);
  assertBridge(
    typeof fetchImpl==='function',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'fetch implementation is required'
  );

  const jwtProvider=createGitHubAppJwtProvider({
    issuer:config.githubAppIssuer,
    privateKey:privateKeyValue(privateKey)
  });
  const installations=new GitHubAppInstallationClient({
    jwtProvider,
    fetchImpl,
    apiBase:config.githubApiBase
  });
  const credentialProvider=new GitHubAppCredentialProvider({installations});

  return createBridgeOAuthMcpHandler({
    verifier:activeRuntime.oauth.verifier,
    principalResolver:activeRuntime.oauth.principalResolver,
    resourceServerUrl:config.publicUrl,
    oauthMetadata:activeRuntime.oauth.metadata,
    requiredScopes:activeRuntime.oauth.requiredScopes ?? ['bridge'],
    gatewayForPrincipal:({principal})=>createRequestScopedGateway({
      principal,
      principalRepositoryAuthorizer:activeRuntime.identity.principalRepositoryAuthorizer,
      installationResolver:activeRuntime.identity.installationResolver,
      credentialProvider,
      fetchImpl,
      apiBase:config.githubApiBase
    })
  });
}

function remoteRequestAllowed(request,config) {
  const url=new URL(request.url);
  if(!config.trustedHosts.includes(url.host)) return false;

  const headerHost=request.headers.get('host');
  if(headerHost!==null && headerHost!==url.host) return false;

  const origin=request.headers.get('origin');
  if(origin===null) return true;
  try {
    return config.allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function createRemoteBridgeFetchService({
  config,
  mcpService,
  ready=()=>true
}={}) {
  assertBridge(
    config && typeof config==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote service config is required'
  );
  assertBridge(
    mcpService && typeof mcpService.fetch==='function' && typeof mcpService.close==='function',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote MCP service is required'
  );
  assertBridge(
    typeof ready==='function',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'readiness callback is required'
  );

  return Object.freeze({
    async fetch(request) {
      if(!remoteRequestAllowed(request,config)) {
        return Response.json({error:'forbidden'},{status:403});
      }

      const url=new URL(request.url);
      if(request.method==='GET' && url.pathname==='/healthz') {
        return Response.json({status:'ok'});
      }
      if(request.method==='GET' && url.pathname==='/readyz') {
        const isReady=await ready();
        return Response.json(
          {status:isReady ? 'ready' : 'not_ready'},
          {status:isReady ? 200 : 503}
        );
      }

      return mcpService.fetch(request);
    },
    async close() {
      await mcpService.close();
    }
  });
}

export function publicRemoteServiceConfig(config) {
  assertBridge(
    config && typeof config==='object',
    'REMOTE_SERVICE_CONFIG_INVALID',
    'remote service config is required'
  );
  return Object.freeze({
    publicUrl:config.publicUrl.href,
    trustedHosts:Object.freeze([...config.trustedHosts]),
    allowedOrigins:Object.freeze([...config.allowedOrigins]),
    githubAppIssuer:config.githubAppIssuer,
    githubApiBase:config.githubApiBase
  });
}

export async function createRemoteBridgeApplication({
  env={},
  fetchImpl=globalThis.fetch,
  runtime,
  privateKey
}={}) {
  const config=parseRemoteServiceConfig(env);
  const activeRuntime=assertRemoteRuntime(runtime);
  const activePrivateKey=privateKey ?? env.BRIDGE_GITHUB_APP_PRIVATE_KEY;
  const mcpService=buildRemoteBridgeMcpService({
    config,
    runtime:activeRuntime,
    privateKey:activePrivateKey,
    fetchImpl
  });
  const web=createRemoteBridgeFetchService({config,mcpService});
  return Object.freeze({
    config:publicRemoteServiceConfig(config),
    fetch:request=>web.fetch(request),
    async close() {
      await web.close();
    }
  });
}
