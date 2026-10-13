import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BridgeError } from '../src/errors.mjs';
import { DirectPairingCodec } from '../src/cloudflare/direct-pairing-codec.mjs';
import { DirectPairingService } from '../src/cloudflare/direct-pairing-service.mjs';
import { createDirectPairingClaimHandler } from '../src/cloudflare/direct-pairing-api.mjs';

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

const SECRET='github-client-secret-for-pairing-tests-123456';
const FAKE_PAIRING=`hp1.${'p'.repeat(48)}.${'s'.repeat(43)}`;
const principal={
  bridgeUserId:'bridge-user-1',
  externalProvider:'https://github.com/',
  externalSubject:'123'
};

test('pairing capability is signed, principal-bound and expires',async()=>{
  let now=2_100_000_000_000;
  const codec=new DirectPairingCodec({
    secret:SECRET,
    clock:()=>now,
    randomBytes:size=>new Uint8Array(size).fill(7)
  });
  const issued=await codec.issue({
    principal,
    hostId:'host-1234567890abcdef',
    ttlSeconds:120
  });
  assert.match(issued.token,/^hp1\./);
  assert.equal(issued.expiresAt,now+120_000);

  const verified=await codec.verify(issued.token);
  assert.equal(verified.principal.bridgeUserId,'bridge-user-1');
  assert.equal(verified.principal.externalProvider,'https://github.com/');
  assert.equal(verified.hostId,'host-1234567890abcdef');

  const parts=issued.token.split('.');
  const tampered=`${parts[0]}.${parts[1]}.${parts[2][0]==='A'?'B':'A'}${parts[2].slice(1)}`;
  await assert.rejects(
    ()=>codec.verify(tampered),
    error=>error.code==='DIRECT_PAIRING_DENIED'
  );

  now+=120_001;
  await assert.rejects(
    ()=>codec.verify(issued.token),
    error=>error.code==='DIRECT_PAIRING_DENIED'
  );
});

test('OAuth-side pairing service allocates a server host id and returns only short-lived capability',async()=>{
  let issuedInput;
  const service=new DirectPairingService({
    publicUrl:'https://bridge.example/mcp',
    randomUUID:()=> 'fixed-uuid-1234567890',
    codec:{
      async issue(input) {
        issuedInput=input;
        return {
          token:FAKE_PAIRING,
          expiresAt:123456
        };
      },
      async verify(){ throw new Error('not used'); }
    }
  });

  const result=await service.create({principal,ttlSeconds:600});
  assert.equal(result.kind,'connect');
  assert.equal(result.endpoint,'https://bridge.example/mcp');
  assert.equal(result.claimUrl,'https://bridge.example/direct/enroll/claim');
  assert.equal(result.hostId,'host-fixed-uuid-1234567890');
  assert.equal(result.pairingToken,FAKE_PAIRING);
  assert.equal(issuedInput.principal,principal);
  assert.equal(issuedInput.hostId,'host-fixed-uuid-1234567890');
  assert.equal(issuedInput.ttlSeconds,600);
});

test('host claim sends only local runner-token digest into Direct store',async()=>{
  const localRunnerToken='runner_token_that_never_leaves_the_host_123456';
  const localRunnerDigest=sha(localRunnerToken);
  let registration;

  const handler=createDirectPairingClaimHandler({
    pairingCodec:{
      async verify(token) {
        assert.equal(token,FAKE_PAIRING);
        return {
          principal,
          hostId:'host-1234567890abcdef'
        };
      }
    },
    directExecStore:{
      async registerHost(input) {
        registration=input;
        return {hostId:input.hostId,enabled:true,rotated:false};
      }
    }
  });

  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/enroll/claim',
    {
      method:'POST',
      headers:{
        authorization:`Bearer ${FAKE_PAIRING}`,
        'content-type':'application/json'
      },
      body:JSON.stringify({runnerTokenSha256:localRunnerDigest})
    }
  ));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.paired,true);
  assert.equal(body.hostId,'host-1234567890abcdef');
  assert.equal(registration.hostId,'host-1234567890abcdef');
  assert.equal(registration.runnerTokenSha256,localRunnerDigest);
  assert.equal(registration.allowRotate,false);
  assert.equal(JSON.stringify(registration).includes(localRunnerToken),false);
});

test('replaying the same pairing capability cannot rotate the already-created host',async()=>{
  let registrations=0;
  const handler=createDirectPairingClaimHandler({
    pairingCodec:{
      async verify(){
        return {
          principal,
          hostId:'host-replay-123456'
        };
      }
    },
    directExecStore:{
      async registerHost() {
        registrations++;
        if(registrations>1) {
          throw new BridgeError('DIRECT_HOST_EXISTS','already exists');
        }
        return {hostId:'host-replay-123456',enabled:true,rotated:false};
      }
    }
  });

  const request=()=>new Request(
    'https://bridge.example/direct/enroll/claim',
    {
      method:'POST',
      headers:{
        authorization:`Bearer ${FAKE_PAIRING}`,
        'content-type':'application/json'
      },
      body:JSON.stringify({runnerTokenSha256:'a'.repeat(64)})
    }
  );
  assert.equal((await handler.fetch(request())).status,200);
  assert.equal((await handler.fetch(request())).status,409);
});

test('pairing claim rejects any host identity supplied by the client',async()=>{
  let verified=false;
  const handler=createDirectPairingClaimHandler({
    pairingCodec:{async verify(){ verified=true; return {}; }},
    directExecStore:{async registerHost(){}}
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/enroll/claim',
    {
      method:'POST',
      headers:{
        authorization:`Bearer ${FAKE_PAIRING}`,
        'content-type':'application/json'
      },
      body:JSON.stringify({
        hostId:'attacker-selected',
        runnerTokenSha256:'a'.repeat(64)
      })
    }
  ));
  assert.equal(response.status,400);
  assert.equal(verified,false);
});

test('missing pairing capability is rejected before verification',async()=>{
  let touched=false;
  const handler=createDirectPairingClaimHandler({
    pairingCodec:{async verify(){ touched=true; }},
    directExecStore:{async registerHost(){ touched=true; }}
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/enroll/claim',
    {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:'{}'
    }
  ));
  assert.equal(response.status,401);
  assert.equal(touched,false);
});
