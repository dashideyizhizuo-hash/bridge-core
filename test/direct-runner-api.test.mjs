import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectRunnerHandler } from '../src/cloudflare/direct-runner-api.mjs';
import { createDirectAdminHandler } from '../src/cloudflare/direct-admin-api.mjs';

const TOKEN='runner_token_abcdefghijklmnopqrstuvwxyz123456';
const ADMIN='admin-secret-token-abcdefghijklmnopqrstuvwxyz';

async function sha256Hex(value) {
  const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

function runnerStore(overrides={}) {
  return {
    async claimNext(){ return null; },
    async renewLease(){ return {runId:'dx1:host-main:direct-1234',continue:true,leaseExpiresAt:123}; },
    async complete(input){ return {runId:input.runId,status:'SUCCEEDED'}; },
    ...overrides
  };
}

test('runner API authenticates bearer token and returns claimed work',async()=>{
  const expectedHash=await sha256Hex(TOKEN);
  const calls=[];
  const handler=createDirectRunnerHandler({
    store:runnerStore({
      async claimNext(input) {
        calls.push(input);
        return {
          runId:'dx1:host-main:direct-1234',
          request:{schemaVersion:1,requestId:'direct-1234',hostId:'host-main',argv:['node','--version']},
          leaseOwner:input.leaseOwner,
          leaseExpiresAt:123
        };
      }
    }),
    randomUUID:()=> 'fixed-uuid'
  });
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/claim',{
    method:'POST',
    headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},
    body:JSON.stringify({hostId:'host-main',leaseMs:90_000})
  }));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.runId,'dx1:host-main:direct-1234');
  assert.equal(calls[0].runnerTokenSha256,expectedHash);
  assert.equal(calls[0].leaseOwner,'runner:fixed-uuid');
});

test('runner API returns 204 plus retry hint when there is no work',async()=>{
  const handler=createDirectRunnerHandler({store:runnerStore()});
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/claim',{
    method:'POST',
    headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},
    body:JSON.stringify({hostId:'host-main',leaseMs:90_000,leaseOwner:'runner:session-1234'})
  }));
  assert.equal(response.status,204);
  assert.equal(response.headers.get('retry-after'),'5');
});

test('runner heartbeat renews the exact leased run',async()=>{
  const expectedHash=await sha256Hex(TOKEN);
  let call;
  const handler=createDirectRunnerHandler({
    store:runnerStore({
      async renewLease(input) {
        call=input;
        return {runId:input.runId,continue:true,leaseExpiresAt:999};
      }
    })
  });
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/heartbeat',{
    method:'POST',
    headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},
    body:JSON.stringify({
      hostId:'host-main',
      leaseOwner:'runner:session-1234',
      runId:'dx1:host-main:direct-1234',
      leaseMs:90_000
    })
  }));
  assert.equal(response.status,200);
  assert.equal(call.runnerTokenSha256,expectedHash);
  assert.equal(call.runId,'dx1:host-main:direct-1234');
});

test('runner completion is bound to authenticated runner input',async()=>{
  const expectedHash=await sha256Hex(TOKEN);
  let call;
  const handler=createDirectRunnerHandler({
    store:runnerStore({
      async complete(input) {
        call=input;
        return {runId:input.runId,status:'SUCCEEDED'};
      }
    })
  });
  const result={
    schemaVersion:1,transport:'direct',requestId:'direct-1234',
    hostId:'host-main',status:'SUCCEEDED',evidence:{stdout:'ok',stderr:''}
  };
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/complete',{
    method:'POST',
    headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},
    body:JSON.stringify({
      hostId:'host-main',
      leaseOwner:'runner:session-1234',
      runId:'dx1:host-main:direct-1234',
      result
    })
  }));
  assert.equal(response.status,200);
  assert.equal(call.runnerTokenSha256,expectedHash);
  assert.deepEqual(call.result,result);
});

test('runner API rejects missing token before touching store',async()=>{
  let called=false;
  const handler=createDirectRunnerHandler({
    store:runnerStore({
      async claimNext(){ called=true; return null; },
      async renewLease(){ called=true; },
      async complete(){ called=true; }
    })
  });
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/claim',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({hostId:'host-main'})
  }));
  assert.equal(response.status,401);
  assert.equal(called,false);
});

function adminFixture() {
  const registered=[];
  const enabled=[];
  const principal={
    bridgeUserId:'bridge-user-1',
    externalProvider:'https://identity.example/',
    externalSubject:'subject'
  };
  const handler=createDirectAdminHandler({
    adminToken:ADMIN,
    identityStore:{
      async resolvePrincipalById(id) {
        assert.equal(id,'bridge-user-1');
        return principal;
      }
    },
    store:{
      async registerHost(input) {
        registered.push(input);
        return {hostId:input.hostId,enabled:input.enabled,rotated:false};
      },
      async setHostEnabled(input) {
        enabled.push(input);
        return {hostId:input.hostId,enabled:input.enabled};
      }
    }
  });
  return {handler,registered,enabled,principal};
}

test('admin register-host returns one runner token and stores only its hash',async()=>{
  const f=adminFixture();
  const response=await f.handler.fetch(new Request('https://bridge.example/direct/admin/register-host',{
    method:'POST',
    headers:{authorization:`Bearer ${ADMIN}`,'content-type':'application/json'},
    body:JSON.stringify({bridgeUserId:'bridge-user-1',hostId:'host-main'})
  }));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.hostId,'host-main');
  assert.match(body.runnerToken,/^[A-Za-z0-9_-]{40,}$/);
  assert.equal(f.registered.length,1);
  assert.equal(f.registered[0].principal,f.principal);
  assert.equal(f.registered[0].runnerTokenSha256,await sha256Hex(body.runnerToken));
  assert.equal(JSON.stringify(f.registered[0]).includes(body.runnerToken),false);
});

test('admin can disable a host as a kill switch',async()=>{
  const f=adminFixture();
  const response=await f.handler.fetch(new Request('https://bridge.example/direct/admin/set-host-enabled',{
    method:'POST',
    headers:{authorization:`Bearer ${ADMIN}`,'content-type':'application/json'},
    body:JSON.stringify({bridgeUserId:'bridge-user-1',hostId:'host-main',enabled:false})
  }));
  assert.equal(response.status,200);
  assert.equal(f.enabled.length,1);
  assert.equal(f.enabled[0].enabled,false);
});

test('short or wrong admin bearer tokens are rejected',async()=>{
  assert.throws(
    ()=>createDirectAdminHandler({
      adminToken:'too-short',
      identityStore:{resolvePrincipalById(){}},
      store:{registerHost(){},setHostEnabled(){}}
    }),
    /at least 32/
  );
  const f=adminFixture();
  const response=await f.handler.fetch(new Request('https://bridge.example/direct/admin/register-host',{
    method:'POST',
    headers:{authorization:'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','content-type':'application/json'},
    body:'{}'
  }));
  assert.equal(response.status,403);
});
