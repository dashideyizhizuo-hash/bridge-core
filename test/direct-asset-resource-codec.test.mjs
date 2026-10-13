import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectAssetResourceCodec } from '../src/cloudflare/direct-asset-resource-codec.mjs';

const SECRET='resource-secret-abcdefghijklmnopqrstuvwxyz';
const NOW=2_100_000_000_000;
const principal=id=>({
  bridgeUserId:id,
  externalProvider:'test',
  externalSubject:id
});

test('file resource capability is principal-bound and expires independently of persistent object',async()=>{
  let now=NOW;
  const codec=new DirectAssetResourceCodec({
    secret:SECRET,
    clock:()=>now,
    randomBytes:size=>new Uint8Array(size).fill(7)
  });
  const issued=await codec.issue({
    principal:principal('bridge-user-1'),
    assetId:'asset-12345678',
    ttlSeconds:900
  });
  assert.match(issued.token,/^bf1\./);
  assert.equal(issued.expiresAt,NOW+900_000);

  const verified=await codec.verify({
    principal:principal('bridge-user-1'),
    token:issued.token
  });
  assert.equal(verified.assetId,'asset-12345678');
  assert.equal(verified.expiresAt,issued.expiresAt);

  await assert.rejects(
    ()=>codec.verify({
      principal:principal('bridge-user-2'),
      token:issued.token
    }),
    error=>error.code==='DIRECT_ASSET_RESOURCE_DENIED'
  );

  now=issued.expiresAt+1;
  await assert.rejects(
    ()=>codec.verify({
      principal:principal('bridge-user-1'),
      token:issued.token
    }),
    error=>error.code==='DIRECT_ASSET_RESOURCE_DENIED'
  );
});

test('file resource capability rejects tampering and excessive lifetime',async()=>{
  const codec=new DirectAssetResourceCodec({
    secret:SECRET,
    clock:()=>NOW,
    randomBytes:size=>new Uint8Array(size).fill(9)
  });
  await assert.rejects(
    ()=>codec.issue({
      principal:principal('bridge-user-1'),
      assetId:'asset-12345678',
      ttlSeconds:3601
    }),
    error=>error.code==='DIRECT_ASSET_RESOURCE_INVALID'
  );
  const issued=await codec.issue({
    principal:principal('bridge-user-1'),
    assetId:'asset-12345678'
  });
  const tampered=issued.token.slice(0,-1)+(issued.token.endsWith('A')?'B':'A');
  await assert.rejects(
    ()=>codec.verify({
      principal:principal('bridge-user-1'),
      token:tampered
    }),
    error=>error.code==='DIRECT_ASSET_RESOURCE_DENIED'
  );
});
