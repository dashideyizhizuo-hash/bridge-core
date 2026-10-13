import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth
} from '@modelcontextprotocol/server';
import { assertBridge } from './errors.mjs';
import { assertAuthenticatedPrincipal } from './auth/principal.mjs';
import { createBridgeMcpHandler } from './mcp-server.mjs';

function canonicalResourceUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    assertBridge(false, 'OAUTH_RESOURCE_CONFIG_INVALID', 'resourceServerUrl must be an absolute URL');
  }
  assertBridge(
    url.protocol === 'https:',
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'remote MCP resourceServerUrl must use HTTPS'
  );
  assertBridge(
    url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '',
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'resourceServerUrl must not contain credentials, query or fragment'
  );
  return url;
}

function assertVerifier(value) {
  assertBridge(
    value && typeof value.verifyAccessToken === 'function',
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'OAuth access-token verifier is required'
  );
  return value;
}

function assertPrincipalResolver(value) {
  assertBridge(
    value && typeof value.resolve === 'function',
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'OAuth principal resolver is required'
  );
  return value;
}

function assertGatewayFactory(value) {
  assertBridge(
    typeof value === 'function',
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'gatewayForPrincipal is required'
  );
  return value;
}

function requiredScopeList(value) {
  assertBridge(
    Array.isArray(value) && value.length >= 1,
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'requiredScopes must contain at least one scope'
  );
  const scopes=[];
  const seen=new Set();
  for(const scope of value) {
    assertBridge(
      typeof scope === 'string' &&
        scope.length >= 1 &&
        scope.length <= 128 &&
        /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope),
      'OAUTH_RESOURCE_CONFIG_INVALID',
      'requiredScopes contains an invalid OAuth scope'
    );
    if(!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  return scopes;
}

function sameResource(actual, expected) {
  if(actual instanceof URL) return actual.href === expected.href;
  if(typeof actual === 'string') {
    try {
      return new URL(actual).href === expected.href;
    } catch {
      return false;
    }
  }
  return false;
}

function invalidToken(message) {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

export function createBridgeOAuthVerifier({
  verifier,
  principalResolver,
  resourceServerUrl
} = {}) {
  const upstreamVerifier=assertVerifier(verifier);
  const resolver=assertPrincipalResolver(principalResolver);
  const resource=canonicalResourceUrl(resourceServerUrl);

  return Object.freeze({
    async verifyAccessToken(token) {
      const authInfo=await upstreamVerifier.verifyAccessToken(token);
      if(
        !authInfo ||
        typeof authInfo !== 'object' ||
        !sameResource(authInfo.resource,resource)
      ) {
        throw invalidToken('access token is not valid for this Bridge resource');
      }

      const principal=await resolver.resolve({authInfo});
      if(principal === null || principal === undefined) {
        throw invalidToken('access token does not map to a Bridge principal');
      }
      const authenticatedPrincipal=assertAuthenticatedPrincipal(principal);

      return {
        ...authInfo,
        extra:{
          ...(authInfo.extra && typeof authInfo.extra === 'object' ? authInfo.extra : {}),
          bridgePrincipal:authenticatedPrincipal
        }
      };
    }
  });
}

export function principalFromAuthInfo(authInfo) {
  assertBridge(
    authInfo && typeof authInfo === 'object',
    'AUTHENTICATION_REQUIRED',
    'verified OAuth auth info is required'
  );
  return assertAuthenticatedPrincipal(authInfo.extra?.bridgePrincipal);
}

export function createBridgeOAuthMcpHandler({
  verifier,
  principalResolver,
  resourceServerUrl,
  oauthMetadata,
  requiredScopes=['bridge'],
  gatewayForPrincipal
} = {}) {
  const resource=canonicalResourceUrl(resourceServerUrl);
  assertBridge(
    oauthMetadata && typeof oauthMetadata === 'object' && !Array.isArray(oauthMetadata),
    'OAUTH_RESOURCE_CONFIG_INVALID',
    'OAuth authorization-server metadata is required'
  );
  const scopes=requiredScopeList(requiredScopes);
  const buildGateway=assertGatewayFactory(gatewayForPrincipal);
  const resourceMetadataUrl=getOAuthProtectedResourceMetadataUrl(resource);
  const bridgeVerifier=createBridgeOAuthVerifier({
    verifier,
    principalResolver,
    resourceServerUrl:resource
  });
  const gate=requireBearerAuth({
    verifier:bridgeVerifier,
    requiredScopes:scopes,
    resourceMetadataUrl
  });

  const mcp=createBridgeMcpHandler({
    gatewayForRequest:({authInfo,requestInfo})=>{
      const principal=principalFromAuthInfo(authInfo);
      return buildGateway({principal,requestInfo});
    }
  });

  return Object.freeze({
    resourceMetadataUrl,
    async fetch(request) {
      const metadata=await oauthMetadataResponse(request,{
        oauthMetadata,
        resourceServerUrl:resource
      });
      if(metadata !== undefined) return metadata;

      const url=new URL(request.url);
      if(url.pathname !== resource.pathname) {
        return new Response('Not found',{status:404});
      }

      const authInfo=await gate(request);
      if(authInfo instanceof Response) return authInfo;
      return mcp.fetch(request,{authInfo});
    },
    async close() {
      await mcp.close();
    }
  });
}
