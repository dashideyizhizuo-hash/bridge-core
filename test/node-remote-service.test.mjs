import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  createNodeRemoteBridgeApplication,
  createRemoteBridgeHttpServer,
  loadGitHubAppPrivateKey,
  loadRemoteRuntime,
  parseNodeRemoteServiceConfig,
  publicNodeRemoteServiceConfig
} from '../src/node-remote-service.mjs';
import { assertRemoteRuntime } from '../src/remote-service.mjs';

const RESOURCE='https://bridge.example/mcp';
const INLINE_SECRET='inline-private-key-secret-that-must-not-leak';

function baseEnv(overrides={}) {
  return {
    BRIDGE_PUBLIC_URL:RESOURCE,
    BRIDGE_REMOTE_HOST:'127.0.0.1',
    BRIDGE_REMOTE_PORT:'8787',
    BRIDGE_REMOTE_RUNTIME_MODULE:'./test/fixtures/remote-runtime.mjs',
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

test('Node deployment config requires runtime module and exactly one App key source',()=>{
  const config=parseNodeRemoteServiceConfig(baseEnv());
  assert.equal(config.core.publicUrl.href,RESOURCE);
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.port,8787);
  assert.equal(config.runtimeModule,'./test/fixtures/remote-runtime.mjs');
  assert.equal(config.githubPrivateKey.kind,'env');

  assert.throws(
    ()=>parseNodeRemoteServiceConfig(baseEnv({
      BRIDGE_GITHUB_APP_PRIVATE_KEY_FILE:'/run/secrets/app-key.pem'
    })),
    error=>error.code==='REMOTE_SERVICE_CONFIG_INVALID'
  );
  assert.throws(
    ()=>parseNodeRemoteServiceConfig(baseEnv({BRIDGE_REMOTE_RUNTIME_MODULE:''})),
    error=>error.code==='REMOTE_SERVICE_CONFIG_INVALID'
  );
});

test('Node public config and secret-file failures never expose secret material or secret paths',async()=>{
  const inlineConfig=parseNodeRemoteServiceConfig(baseEnv());
  const publicInline=publicNodeRemoteServiceConfig(inlineConfig);
  assert.equal(JSON.stringify(publicInline).includes(INLINE_SECRET),false);
  assert.equal('githubPrivateKey' in publicInline,false);

  const path='/definitely-not-present/bridge-super-secret-key.pem';
  await assert.rejects(
    ()=>loadGitHubAppPrivateKey({kind:'file',value:path}),
    error=>
      error.code==='REMOTE_SERVICE_CONFIG_INVALID' &&
      !error.message.includes(path)
  );
});

test('Node runtime module loader supplies resource identity and core validates the adapter contract',async()=>{
  const loaded=await loadRemoteRuntime('./test/fixtures/remote-runtime.mjs',{
    env:{},
    resourceServerUrl:new URL(RESOURCE)
  });
  assert.equal(loaded.fixtureResource,RESOURCE);
  assert.equal(assertRemoteRuntime(loaded),loaded);
});

test('Node HTTP adapter binds independently of runner hosts',async t=>{
  let closed=false;
  const service=createRemoteBridgeHttpServer({
    webApplication:{
      async fetch(request) {
        const url=new URL(request.url);
        if(url.pathname==='/healthz') return Response.json({status:'ok'});
        return new Response('not found',{status:404});
      },
      async close() {
        closed=true;
      }
    },
    host:'127.0.0.1',
    port:0
  });
  const address=await service.listen();
  t.after(async()=>service.close());
  assert.ok(address && typeof address==='object' && Number.isInteger(address.port));

  const response=await fetch('http://127.0.0.1:'+address.port+'/healthz');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'ok'});

  await service.close();
  assert.equal(closed,true);
});

test('Node remote application composes runtime/key adapters without changing protected MCP behavior',async t=>{
  const app=await createNodeRemoteBridgeApplication({
    env:baseEnv(),
    runtime:runtime(),
    privateKey:privateKeyPem(),
    fetchImpl:async()=>{ throw new Error('GitHub must not be called during startup'); }
  });
  t.after(async()=>app.close());

  assert.equal(app.config.publicUrl,RESOURCE);
  assert.equal(app.config.host,'127.0.0.1');
  assert.equal(JSON.stringify(app.config).includes(INLINE_SECRET),false);

  const anonymous=await app.fetch(new Request(RESOURCE,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:'{}'
  }));
  assert.equal(anonymous.status,401);
});
