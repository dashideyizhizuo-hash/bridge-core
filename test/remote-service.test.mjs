import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertRemoteRuntime,
  createRemoteBridgeApplication,
  createRemoteBridgeFetchService,
  parseRemoteServiceConfig,
  publicRemoteServiceConfig
} from '../src/remote-service.mjs';

const RESOURCE='https://bridge.example/mcp';
const INLINE_SECRET='inline-private-key-secret-that-must-not-leak';

function baseEnv(overrides={}) {
  return {
    BRIDGE_PUBLIC_URL:RESOURCE,
    BRIDGE_GITHUB_APP_ISSUER:'Iv1.bridge-client',
    BRIDGE_GITHUB_APP_PRIVATE_KEY:INLINE_SECRET,
    ...overrides
  };
}

function runtime() {
  return {
    oauth:{
      verifier:{
        async verifyAccessToken() {
          throw new Error('test verifier should not be called for anonymous request');
        }
      },
      principalResolver:{
        async resolve() {
          return null;
        }
      },
      metadata:{
        issuer:'https://identity.example/',
        authorization_endpoint:'https://identity.example/authorize',
        token_endpoint:'https://identity.example/oauth/token',
        response_types_supported:['code'],
        grant_types_supported:['authorization_code'],
        code_challenge_methods_supported:['S256'],
        token_endpoint_auth_methods_supported:['none'],
        scopes_supported:['bridge']
      },
      requiredScopes:['bridge']
    },
    identity:{
      principalRepositoryAuthorizer:{
        async assert() {
          throw new Error('test authorizer should not be called');
        }
      },
      installationResolver:{
        async resolve() {
          throw new Error('test installation resolver should not be called');
        }
      }
    }
  };
}

function privateKeyPem() {
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  return privateKey.export({type:'pkcs8',format:'pem'});
}

test('remote config requires canonical HTTPS MCP URL and keeps deployment config secret-free',()=>{
  const config=parseRemoteServiceConfig(baseEnv());
  assert.equal(config.publicUrl.href,RESOURCE);
  assert.deepEqual(config.trustedHosts,['bridge.example']);
  assert.deepEqual(config.allowedOrigins,['https://bridge.example']);
  assert.equal(config.githubAppIssuer,'Iv1.bridge-client');

  const publicConfig=publicRemoteServiceConfig(config);
  const serialized=JSON.stringify(publicConfig);
  assert.equal(serialized.includes(INLINE_SECRET),false);
  assert.equal(serialized.includes('PRIVATE_KEY'),false);

  assert.throws(
    ()=>parseRemoteServiceConfig(baseEnv({BRIDGE_PUBLIC_URL:'http://bridge.example/mcp'})),
    error=>error.code==='REMOTE_SERVICE_CONFIG_INVALID'
  );
  assert.throws(
    ()=>parseRemoteServiceConfig(baseEnv({BRIDGE_PUBLIC_URL:'https://bridge.example/not-mcp'})),
    error=>error.code==='REMOTE_SERVICE_CONFIG_INVALID'
  );
});

test('remote runtime contract requires OAuth identity and principal repository authority',()=>{
  const active=runtime();
  assert.equal(assertRemoteRuntime(active),active);
  assert.throws(
    ()=>assertRemoteRuntime({oauth:{},identity:{}}),
    error=>error.code==='REMOTE_SERVICE_CONFIG_INVALID'
  );
});

test('portable remote service core has no Node HTTP filesystem or dynamic-module dependency',()=>{
  const source=readFileSync(new URL('../src/remote-service.mjs',import.meta.url),'utf8');
  for(const forbidden of [
    'node:http',
    'node:fs',
    'node:path',
    'node:url',
    '@modelcontextprotocol/node',
    'process.env'
  ]) {
    assert.equal(source.includes(forbidden),false,'portable remote core must not depend on '+forbidden);
  }
});

test('fetch service exposes minimal health/readiness and rejects host/origin aliases before MCP',async()=>{
  const config=parseRemoteServiceConfig(baseEnv());
  let closed=false;
  const mcpService={
    async fetch() {
      return new Response('mcp',{status:200});
    },
    async close() {
      closed=true;
    }
  };
  const service=createRemoteBridgeFetchService({
    config,
    mcpService,
    ready:()=>false
  });

  const health=await service.fetch(new Request('https://bridge.example/healthz'));
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{status:'ok'});

  const readiness=await service.fetch(new Request('https://bridge.example/readyz'));
  assert.equal(readiness.status,503);
  assert.deepEqual(await readiness.json(),{status:'not_ready'});

  const blockedHost=await service.fetch(new Request('https://evil.example/mcp'));
  assert.equal(blockedHost.status,403);

  const blockedHeaderHost=await service.fetch(new Request(RESOURCE,{
    headers:{host:'evil.example'}
  }));
  assert.equal(blockedHeaderHost.status,403);

  const blockedOrigin=await service.fetch(new Request(RESOURCE,{
    headers:{origin:'https://evil.example'}
  }));
  assert.equal(blockedOrigin.status,403);

  await service.close();
  assert.equal(closed,true);
});

test('remote fetch application is deployable without a listener or runner-local dependency',async t=>{
  const app=await createRemoteBridgeApplication({
    env:baseEnv(),
    runtime:runtime(),
    privateKey:privateKeyPem(),
    fetchImpl:async()=>{ throw new Error('GitHub must not be called during startup'); }
  });
  t.after(async()=>app.close());

  assert.equal(typeof app.fetch,'function');
  assert.equal('listen' in app,false);
  assert.equal(app.config.publicUrl,RESOURCE);
  assert.equal(JSON.stringify(app.config).includes(INLINE_SECRET),false);

  const anonymous=await app.fetch(new Request(RESOURCE,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:'{}'
  }));
  assert.equal(anonymous.status,401);

  const wrongOrigin=await app.fetch(new Request(RESOURCE,{
    method:'POST',
    headers:{
      origin:'https://evil.example',
      'content-type':'application/json'
    },
    body:'{}'
  }));
  assert.equal(wrongOrigin.status,403);
});

test('remote application fails closed on missing or invalid GitHub App private key without echoing it',async()=>{
  await assert.rejects(
    ()=>createRemoteBridgeApplication({
      env:baseEnv({BRIDGE_GITHUB_APP_PRIVATE_KEY:undefined}),
      runtime:runtime()
    }),
    error=>error.code==='REMOTE_SERVICE_CONFIG_INVALID'
  );

  const invalid='this-is-a-secret-but-not-a-private-key';
  await assert.rejects(
    ()=>createRemoteBridgeApplication({
      env:baseEnv({BRIDGE_GITHUB_APP_PRIVATE_KEY:invalid}),
      runtime:runtime()
    }),
    error=>
      error.code==='GITHUB_APP_CONFIG_INVALID' &&
      !error.message.includes(invalid)
  );
});
