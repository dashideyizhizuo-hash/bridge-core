import test from 'node:test';
import assert from 'node:assert/strict';
import { withDirectAssetBufferSlot } from '../src/cloudflare/direct-asset-memory.mjs';

test('Direct Asset memory slot fails fast instead of buffering concurrent large operations',async()=>{
  let release;
  const first=withDirectAssetBufferSlot(()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve();
  await assert.rejects(
    withDirectAssetBufferSlot(async()=> 'second'),
    error=>error?.code==='DIRECT_ASSET_BUSY' && error?.details?.retryAfterSeconds===1
  );
  release('first');
  assert.equal(await first,'first');
  assert.equal(await withDirectAssetBufferSlot(async()=> 'third'),'third');
});
