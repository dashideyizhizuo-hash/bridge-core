import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupDirectAssetCache, stageDirectAssets } from '../src/direct-runner-assets.mjs';

const TOKEN='runner_token_abcdefghijklmnopqrstuvwxyz123456';
const RUN_ID='dx1:host-main:direct-assets-12345678';
const LEASE_OWNER='runner:lease-1234';
const bytes=Buffer.from([0x89,0x50,0x4e,0x47,1,2,3,4]);
const sha=createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'bridge-assets-'));
  return {
    root,
    hostPolicy:{
      directExec:{
        assetDir:join(root,'assets')
      }
    },
    cleanup:()=>rmSync(root,{recursive:true,force:true})
  };
}

function asset(overrides={}) {
  return {
    assetId:'asset-12345678',
    fileName:'art.png',
    mimeType:'image/png',
    sizeBytes:bytes.length,
    sha256:sha,
    ...overrides
  };
}

test('runner downloads, hashes and atomically stages a private asset',async()=>{
  const f=fixture();
  try {
    let calls=0;
    const paths=await stageDirectAssets({
      endpoint:'https://bridge.example/mcp',
      token:TOKEN,
      hostId:'host-main',
      runId:RUN_ID,
      leaseOwner:LEASE_OWNER,
      hostPolicy:f.hostPolicy,
      assets:[asset()],
      fetchImpl:async (url,init)=>{
        calls++;
        assert.equal(new URL(url).pathname,'/direct/runner/assets/asset-12345678');
        assert.equal(init.headers['x-bridge-host-id'],'host-main');
        assert.equal(init.headers['x-bridge-run-id'],RUN_ID);
        assert.equal(init.headers['x-bridge-lease-owner'],LEASE_OWNER);
        return new Response(bytes,{
          status:200,
          headers:{
            'content-type':'image/png',
            'content-length':String(bytes.length),
            'x-bridge-sha256':sha
          }
        });
      }
    });
    assert.equal(calls,1);
    assert.equal(paths.length,1);
    assert.match(paths[0],new RegExp(sha+'\\.png$'));
    assert.deepEqual(readFileSync(paths[0]),bytes);

    const cached=await stageDirectAssets({
      endpoint:'https://bridge.example/mcp',
      token:TOKEN,
      hostId:'host-main',
      runId:RUN_ID,
      leaseOwner:LEASE_OWNER,
      hostPolicy:f.hostPolicy,
      assets:[asset()],
      fetchImpl:async()=>{ throw new Error('cache should avoid network'); }
    });
    assert.deepEqual(cached,paths);
  } finally { f.cleanup(); }
});

test('runner refuses wrong asset bytes before command staging',async()=>{
  const f=fixture();
  try {
    await assert.rejects(
      ()=>stageDirectAssets({
        endpoint:'https://bridge.example',
        token:TOKEN,
        hostId:'host-main',
        runId:RUN_ID,
        leaseOwner:LEASE_OWNER,
        hostPolicy:f.hostPolicy,
        assets:[asset()],
        fetchImpl:async()=>new Response(Buffer.from('wrong'),{
          status:200,
          headers:{'x-bridge-sha256':sha}
        })
      }),
      error=>error.code==='DIRECT_ASSET_INTEGRITY'
    );
    assert.equal(existsSync(join(f.root,'assets',sha+'.png')),false);
  } finally { f.cleanup(); }
});

test('runner refuses unauthorized asset download',async()=>{
  const f=fixture();
  try {
    await assert.rejects(
      ()=>stageDirectAssets({
        endpoint:'https://bridge.example',
        token:TOKEN,
        hostId:'host-main',
        runId:RUN_ID,
        leaseOwner:LEASE_OWNER,
        hostPolicy:f.hostPolicy,
        assets:[asset()],
        fetchImpl:async()=>Response.json(
          {error:{code:'DIRECT_ASSET_DENIED',message:'denied'}},
          {status:403}
        )
      }),
      error=>error.code==='DIRECT_ASSET_DENIED'
    );
  } finally { f.cleanup(); }
});

for(const declared of [false,true])test('oversized '+(declared?'declared':'streamed')+' 403 control reply is canceled and cannot become owner pause',async()=>{
  const f=fixture();let canceled=false,pulls=0;
  try{
    const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(8193));},cancel(){canceled=true;}},{highWaterMark:0});
    await assert.rejects(stageDirectAssets({endpoint:'https://bridge.example',token:TOKEN,hostId:'host-main',runId:RUN_ID,leaseOwner:LEASE_OWNER,hostPolicy:f.hostPolicy,
      assets:[{...asset(),sizeBytes:20000}],fetchImpl:async()=>new Response(body,{status:403,headers:declared?{'content-length':'8193'}:{}})}),e=>e.code==='DIRECT_ASSET_DENIED'&&e.status===403);
    assert.equal(canceled,true);assert.equal(pulls,declared?0:1);
  }finally{f.cleanup();}
});


test('host asset cache removes stale transport files but keeps recent files',()=>{
  const f=fixture();
  try {
    const root=join(f.root,'assets');
    mkdirSync(root,{recursive:true});
    const stale=join(root,'a'.repeat(64)+'.bin');
    const recent=join(root,'b'.repeat(64)+'.bin');
    const unrelated=join(root,'do-not-delete.txt');
    writeFileSync(stale,'old');
    writeFileSync(recent,'new');
    writeFileSync(unrelated,'keep');
    const old=new Date(Date.now()-8*24*60*60*1000);
    utimesSync(stale,old,old);
    utimesSync(unrelated,old,old);
    const result=cleanupDirectAssetCache({
      hostPolicy:f.hostPolicy,
      now:Date.now(),
      retentionMs:7*24*60*60*1000
    });
    assert.equal(result.removed,1);
    assert.equal(existsSync(stale),false);
    assert.equal(existsSync(recent),true);
    assert.equal(existsSync(unrelated),true);
  } finally { f.cleanup(); }
});
