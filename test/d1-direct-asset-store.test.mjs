import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import { D1DirectAssetStore } from '../src/cloudflare/d1-direct-asset-store.mjs';

const NOW=2_000_000_000_000;
const TOKEN='a'.repeat(64);
const SHA='b'.repeat(64);

function principal(id='bridge-user-1') {
  return createBridgePrincipal({
    bridgeUserId:id,
    externalProvider:'https://identity.example/',
    externalSubject:id
  });
}

function row(value) {
  if(!value) return null;
  return {
    asset_id:value.assetId,
    run_id:value.runId,
    bridge_user_id:value.bridgeUserId,
    object_key:value.objectKey,
    file_name:value.fileName,
    mime_type:value.mimeType,
    size_bytes:value.sizeBytes,
    sha256:value.sha256,
    upload_token_sha256:value.uploadTokenSha256,
    status:value.status,
    created_at:value.createdAt,
    expires_at:value.expiresAt,
    uploaded_at:value.uploadedAt,
    persistent:value.persistent ? 1 : 0,
    source_kind:value.sourceKind ?? null,
    source_ref:value.sourceRef ?? null
  };
}

class Statement {
  constructor(db,sql,args=[]) {
    this.db=db;
    this.sql=sql.replace(/\s+/g,' ').trim();
    this.args=args;
  }
  bind(...args){ return new Statement(this.db,this.sql,args); }
  async run() {
    if(this.sql.startsWith('INSERT INTO direct_assets')) {
      if(this.sql.includes("NULL, 'READY'")) {
        const [
          assetId,runId,bridgeUserId,objectKey,fileName,mimeType,sizeBytes,
          sha256,createdAt,expiresAt,uploadedAt,persistent,sourceKind,sourceRef
        ]=this.args;
        this.db.assets.set(assetId,{
          assetId,runId,bridgeUserId,objectKey,fileName,mimeType,sizeBytes,
          sha256,uploadTokenSha256:null,status:'READY',
          createdAt,expiresAt,uploadedAt,persistent:Boolean(persistent),sourceKind,sourceRef
        });
      } else if(this.sql.includes("NULL, 'WAITING_UPLOAD'")) {
        const [
          assetId,runId,bridgeUserId,objectKey,fileName,mimeType,sizeBytes,
          sha256,createdAt,expiresAt,sourceKind,sourceRef
        ]=this.args;
        const existing=[...this.db.assets.values()].find(value=>
          value.assetId===assetId ||
          (
            value.bridgeUserId===bridgeUserId &&
            value.sourceKind===sourceKind &&
            value.sourceRef===sourceRef
          )
        );
        if(existing) return {success:true,meta:{changes:0}};
        this.db.assets.set(assetId,{
          assetId,runId,bridgeUserId,objectKey,fileName,mimeType,sizeBytes,
          sha256,uploadTokenSha256:null,status:'WAITING_UPLOAD',
          createdAt,expiresAt,uploadedAt:null,persistent:false,sourceKind,sourceRef
        });
      } else {
        const [
          assetId,runId,bridgeUserId,objectKey,fileName,mimeType,sizeBytes,
          sha256,uploadTokenSha256,createdAt,expiresAt,persistent,sourceKind,sourceRef
        ]=this.args;
        this.db.assets.set(assetId,{
          assetId,runId,bridgeUserId,objectKey,fileName,mimeType,sizeBytes,
          sha256,uploadTokenSha256,status:'WAITING_UPLOAD',
          createdAt,expiresAt,uploadedAt:null,persistent:Boolean(persistent),sourceKind,sourceRef
        });
      }
      return {success:true,meta:{changes:1}};
    }
    if(this.sql.startsWith('INSERT INTO direct_asset_object_retirements'))return {success:true};
    if(this.sql.startsWith("UPDATE direct_assets SET status='EXPIRED'"))return this.all();
    throw new Error('unexpected run SQL: '+this.sql);
  }
  async first() {
    if(this.sql.startsWith('SELECT * FROM direct_assets WHERE asset_id=? AND upload_token_sha256=?')) {
      const [id,token,now]=this.args;
      const asset=this.db.assets.get(id);
      return asset &&
        asset.uploadTokenSha256===token &&
        asset.status==='WAITING_UPLOAD' &&
        asset.expiresAt>now
        ? row(asset) : null;
    }
    if(this.sql.startsWith("UPDATE direct_assets SET status='READY',persistent=")) {
      const [persistent,uploadedAt,expiresAt,id,user,objectKey,now]=this.args;
      const asset=this.db.assets.get(id);
      if(
        !asset ||
        asset.bridgeUserId!==user ||
        asset.status!=='WAITING_UPLOAD' ||
        asset.uploadTokenSha256!==null || asset.objectKey!==objectKey || asset.expiresAt<=now
      ) return null;
      Object.assign(asset,{
        status:'READY',
        persistent:Boolean(persistent),
        uploadedAt,
        expiresAt
      });
      return row(asset);
    }
    if(this.sql.startsWith("UPDATE direct_assets SET status='WAITING_UPLOAD'")) {
      const [objectKey,expiresAt,id,user,oldKey,now]=this.args;
      const asset=this.db.assets.get(id);
      if(!asset || asset.bridgeUserId!==user || asset.objectKey!==oldKey || asset.expiresAt>now) return null;
      Object.assign(asset,{
        objectKey,status:'WAITING_UPLOAD',
        uploadTokenSha256:null,
        persistent:false,
        uploadedAt:null,
        expiresAt
      });
      return row(asset);
    }
    if(
      this.sql.startsWith('SELECT * FROM direct_assets WHERE bridge_user_id=? AND source_kind=? AND source_ref=?') &&
      !this.sql.includes("status='READY'")
    ) {
      const [user,kind,ref]=this.args;
      return row([...this.db.assets.values()].find(value=>
        value.bridgeUserId===user && value.sourceKind===kind && value.sourceRef===ref
      ));
    }
    if(
      this.sql.startsWith("SELECT * FROM direct_assets WHERE asset_id=? AND bridge_user_id=? AND object_key=? AND status='READY'")
    ) {
      const [id,user,key,now]=this.args;
      const asset=this.db.assets.get(id);
      return asset && asset.bridgeUserId===user && asset.objectKey===key && asset.status==='READY' && (asset.persistent || asset.expiresAt>now) ? row(asset) : null;
    }
    if(
      this.sql.startsWith("SELECT * FROM direct_assets WHERE asset_id=? AND status='READY'")
    ) {
      const [id,size,sha]=this.args;
      const asset=this.db.assets.get(id);
      return asset && asset.status==='READY' && asset.sizeBytes===size && asset.sha256===sha
        ? row(asset) : null;
    }
    if(this.sql.startsWith("UPDATE direct_assets SET status='READY'")) {
      const [uploadedAt,id,token,now,size,sha]=this.args;
      const asset=this.db.assets.get(id);
      if(
        !asset || asset.uploadTokenSha256!==token ||
        asset.status!=='WAITING_UPLOAD' || asset.expiresAt<=now ||
        asset.sizeBytes!==size || asset.sha256!==sha
      ) return null;
      Object.assign(asset,{
        status:'READY',
        uploadTokenSha256:null,
        uploadedAt
      });
      return row(asset);
    }
    if(
      this.sql.includes('source_kind=?') &&
      this.sql.includes('source_ref=?') &&
      this.sql.includes("status='READY'")
    ) {
      const [user,kind,ref,now]=this.args;
      const asset=[...this.db.assets.values()].find(value=>
        value.bridgeUserId===user &&
        value.sourceKind===kind &&
        value.sourceRef===ref &&
        value.status==='READY' &&
        (value.persistent || value.expiresAt>now)
      );
      return row(asset);
    }
    if(
      this.sql.startsWith("SELECT * FROM direct_assets WHERE asset_id=? AND bridge_user_id=? AND status='READY'")
    ) {
      const [id,user,now]=this.args;
      const asset=this.db.assets.get(id);
      return asset &&
        asset.bridgeUserId===user &&
        asset.status==='READY' &&
        (asset.persistent || asset.expiresAt>now)
        ? row(asset) : null;
    }
    if(this.sql.startsWith('SELECT * FROM direct_assets WHERE asset_id=? AND bridge_user_id=?')) {
      const [id,user]=this.args;
      const asset=this.db.assets.get(id);
      return asset && asset.bridgeUserId===user ? row(asset) : null;
    }
    if(this.sql.startsWith('SELECT a.*, h.host_id, r.request_json FROM direct_assets a')) {
      const [id,now,hostId,token,runId,leaseOwner,leaseNow]=this.args;
      const asset=this.db.assets.get(id);
      const host=this.db.hosts.get(hostId);
      const run=this.db.runs.get(runId);
      return asset && host && run &&
        asset.status==='READY' && (asset.persistent || asset.expiresAt>now) &&
        host.bridgeUserId===asset.bridgeUserId &&
        host.token===token && host.enabled===1 &&
        run.bridgeUserId===asset.bridgeUserId &&
        run.hostId===hostId &&
        run.status==='RUNNING' &&
        run.leaseOwner===leaseOwner &&
        run.leaseExpiresAt>leaseNow
        ? {...row(asset),host_id:hostId,request_json:run.requestJson} : null;
    }
    throw new Error('unexpected first SQL: '+this.sql);
  }

  async all() {
    if(this.sql.startsWith('SELECT asset_id, object_key FROM direct_assets')) {
      const [now,limit]=this.args;
      const candidates=[...this.db.assets.values()]
        .filter(x=>x.expiresAt<=now && (x.status==='WAITING_UPLOAD' || (!x.persistent && x.status==='READY')))
        .sort((a,b)=>a.expiresAt-b.expiresAt)
        .slice(0,limit);
      return {
        success:true,
        results:candidates.map(x=>({asset_id:x.assetId,object_key:x.objectKey}))
      };
    }
    if(this.sql.startsWith("UPDATE direct_assets SET status='EXPIRED'")) {
      const now=this.args.at(-1);
      const ids=this.args.slice(0,-1);
      const results=[];
      for(const id of ids) {
        const asset=this.db.assets.get(id);
        if(
          asset &&
          asset.expiresAt<=now &&
          (asset.status==='WAITING_UPLOAD' || (!asset.persistent && asset.status==='READY'))
        ) {
          asset.status='EXPIRED';
          asset.uploadTokenSha256=null;
          results.push({asset_id:id});
        }
      }
      return {success:true,results};
    }
    if(this.sql.startsWith('DELETE FROM direct_assets')) {
      const [cutoff,limit]=this.args;
      const candidates=[...this.db.assets.values()]
        .filter(x=>x.status==='EXPIRED' && x.expiresAt<=cutoff)
        .sort((a,b)=>a.expiresAt-b.expiresAt)
        .slice(0,limit);
      for(const asset of candidates) this.db.assets.delete(asset.assetId);
      return {
        success:true,
        results:candidates.map(x=>({asset_id:x.assetId}))
      };
    }
    throw new Error('unexpected all SQL: '+this.sql);
  }
}

class FakeD1 {
  constructor(){
    this.assets=new Map();
    this.hosts=new Map();
    this.runs=new Map();
  }
  prepare(sql){ return new Statement(this,sql); }
  async batch(statements){
    const out=[];
    for(const statement of statements) out.push(await statement.run());
    return out;
  }
}

function createInput() {
  return {
    principal:principal(),
    assetId:'asset-12345678',
    objectKey:'direct-assets/asset-12345678',
    fileName:'art.png',
    mimeType:'image/png',
    sizeBytes:123,
    sha256:SHA,
    uploadTokenSha256:TOKEN
  };
}

test('migrations keep Direct Asset bytes out of D1 and add persistent object metadata',()=>{
  const base=readFileSync(new URL('../migrations/0011_direct_assets.sql',import.meta.url),'utf8');
  const persistent=readFileSync(new URL('../migrations/0012_persistent_direct_assets.sql',import.meta.url),'utf8');
  assert.match(base,/CREATE TABLE IF NOT EXISTS direct_assets/);
  assert.match(base,/upload_token_sha256/);
  assert.match(persistent,/ADD COLUMN persistent/);
  assert.match(persistent,/source_kind/);
  assert.match(persistent,/source_ref/);
  assert.equal(/\bblob\b|binary_payload/i.test(base+persistent),false);
});

test('asset upload lifecycle is principal-scoped and one-time',async()=>{
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>NOW});
  const created=await store.create(createInput());
  assert.equal(created.status,'WAITING_UPLOAD');
  assert.equal(created.expiresAt,NOW+60*60*1000);

  const ticket=await store.authorizeUpload({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN
  });
  assert.equal(ticket.objectKey,'direct-assets/asset-12345678');

  const ready=await store.markReady({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN,
    actualSizeBytes:123,
    actualSha256:SHA
  });
  assert.equal(ready.status,'READY');

  await assert.rejects(
    ()=>store.authorizeUpload({
      assetId:'asset-12345678',
      uploadTokenSha256:TOKEN
    }),
    error=>error.code==='DIRECT_ASSET_UPLOAD_DENIED'
  );

  assert.equal(
    (await store.getResult({principal:principal(),runId:created.runId})).assetId,
    'asset-12345678'
  );
  await assert.rejects(
    ()=>store.getRun({principal:principal('bridge-user-2'),runId:created.runId}),
    error=>error.code==='RUN_NOT_FOUND'
  );
});

test('internal source staging is durable and idempotent before READY finalization',async()=>{
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>NOW});
  const input={
    principal:principal(),
    assetId:'asset-source-1234',
    objectKey:'direct-assets/asset-source-1234',
    fileName:'input.png',
    mimeType:'image/png',
    sizeBytes:123,
    sha256:SHA,
    sourceKind:'openai-file',
    sourceRef:'file_1'
  };
  const prepared=await store.prepareReady(input);
  assert.equal(prepared.status,'WAITING_UPLOAD');
  assert.equal(prepared.persistent,false);
  assert.equal(db.assets.get(prepared.assetId).status,'WAITING_UPLOAD');

  const retried=await store.prepareReady({
    ...input,
    assetId:'asset-source-5678',
    objectKey:'direct-assets/asset-source-5678'
  });
  assert.equal(retried.assetId,prepared.assetId);
  assert.equal(retried.objectKey,prepared.objectKey);

  const ready=await store.finalizePreparedReady({
    principal:principal(),
    assetId:prepared.assetId,
    objectKey:prepared.objectKey,
    persistent:true
  });
  assert.equal(ready.status,'READY');
  assert.equal(ready.persistent,true);
  const replay=await store.finalizePreparedReady({
    principal:principal(),
    assetId:prepared.assetId,
    objectKey:prepared.objectKey,
    persistent:true
  });
  assert.equal(replay.status,'READY');
  assert.equal(replay.assetId,prepared.assetId);
});

test('markReady is idempotent after a concurrent upload winner',async()=>{
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>NOW});
  await store.create(createInput());
  const first=await store.markReady({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN,
    actualSizeBytes:123,
    actualSha256:SHA
  });
  const retry=await store.markReady({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN,
    actualSizeBytes:123,
    actualSha256:SHA
  });
  assert.equal(first.status,'READY');
  assert.equal(retry.status,'READY');
  assert.equal(retry.assetId,first.assetId);
});

test('expired persistent WAITING upload is cleanup-eligible but persistent READY is not',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>now});
  await store.create({...createInput(),persistent:true,ttlMs:60_000});
  now+=60_001;
  assert.deepEqual(await store.listExpired({limit:10}),[{
    assetId:'asset-12345678',
    objectKey:'direct-assets/asset-12345678'
  }]);
  assert.deepEqual(await store.markExpired({assetIds:['asset-12345678']}),['asset-12345678']);

  now=NOW;
  const db2=new FakeD1();
  const store2=new D1DirectAssetStore({db:db2,clock:()=>now});
  await store2.create({...createInput(),persistent:true,ttlMs:60_000});
  await store2.markReady({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN,
    actualSizeBytes:123,
    actualSha256:SHA
  });
  now+=60_001;
  assert.deepEqual(await store2.listExpired({limit:10}),[]);
});

test('Direct Exec can resolve only owned READY assets',async()=>{
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>NOW});
  await store.create(createInput());
  await store.markReady({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN,
    actualSizeBytes:123,
    actualSha256:SHA
  });
  const assets=await store.assertReady({
    principal:principal(),
    assetIds:['asset-12345678']
  });
  assert.equal(assets.length,1);
  await assert.rejects(
    ()=>store.assertReady({
      principal:principal('bridge-user-2'),
      assetIds:['asset-12345678']
    }),
    error=>error.code==='DIRECT_ASSET_DENIED'
  );
});

test('runner download is bound to active Run lease, asset membership, host owner and token',async()=>{
  const db=new FakeD1();
  db.hosts.set('host-main',{
    bridgeUserId:'bridge-user-1',
    token:'c'.repeat(64),
    enabled:1
  });
  const runId='dx1:host-main:direct-12345678';
  const leaseOwner='runner:lease-1234';
  db.runs.set(runId,{
    bridgeUserId:'bridge-user-1',
    hostId:'host-main',
    status:'RUNNING',
    leaseOwner,
    leaseExpiresAt:NOW+60_000,
    requestJson:JSON.stringify({
      schemaVersion:1,
      requestId:'direct-12345678',
      hostId:'host-main',
      argv:['echo'],
      assets:[{assetId:'asset-12345678'}]
    })
  });
  const store=new D1DirectAssetStore({db,clock:()=>NOW});
  await store.create(createInput());
  await store.markReady({
    assetId:'asset-12345678',
    uploadTokenSha256:TOKEN,
    actualSizeBytes:123,
    actualSha256:SHA
  });

  assert.equal(
    (await store.authorizeRunnerDownload({
      hostId:'host-main',
      runnerTokenSha256:'c'.repeat(64),
      assetId:'asset-12345678',
      runId,
      leaseOwner
    })).objectKey,
    'direct-assets/asset-12345678'
  );
  await assert.rejects(
    ()=>store.authorizeRunnerDownload({
      hostId:'host-main',
      runnerTokenSha256:'c'.repeat(64),
      assetId:'asset-12345678',
      runId,
      leaseOwner:'runner:other-1234'
    }),
    error=>error.code==='DIRECT_ASSET_DENIED'
  );
  db.runs.get(runId).requestJson=JSON.stringify({
    schemaVersion:1,
    requestId:'direct-12345678',
    hostId:'host-main',
    argv:['echo'],
    assets:[]
  });
  await assert.rejects(
    ()=>store.authorizeRunnerDownload({
      hostId:'host-main',
      runnerTokenSha256:'c'.repeat(64),
      assetId:'asset-12345678',
      runId,
      leaseOwner
    }),
    error=>error.code==='DIRECT_ASSET_DENIED'
  );
});

test('expired asset cleanup is two-phase and metadata retention is bounded',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>now});
  await store.create({...createInput(),ttlMs:60_000});
  now+=60_001;

  const expired=await store.listExpired({limit:100});
  assert.deepEqual(expired,[{
    assetId:'asset-12345678',
    objectKey:'direct-assets/asset-12345678'
  }]);
  assert.equal(db.assets.get('asset-12345678').status,'WAITING_UPLOAD');

  const marked=await store.markExpired({assetIds:['asset-12345678']});
  assert.deepEqual(marked,['asset-12345678']);
  assert.equal(db.assets.get('asset-12345678').status,'EXPIRED');

  now+=7*24*60*60*1000+1;
  const pruned=await store.pruneExpiredMetadata({retentionMs:7*24*60*60*1000});
  assert.equal(pruned.removed,1);
  assert.equal(db.assets.has('asset-12345678'),false);
});


test('persistent READY assets remain usable after transport TTL and are excluded from expiry cleanup',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectAssetStore({db,clock:()=>now});
  const created=await store.createReady({
    principal:principal(),
    assetId:'asset-persist-1234',
    objectKey:'direct-assets/asset-persist-1234',
    fileName:'saved.png',
    mimeType:'image/png',
    sizeBytes:123,
    sha256:SHA,
    persistent:true,
    sourceKind:'openai-file',
    sourceRef:'file_1234',
    ttlMs:60_000
  });
  assert.equal(created.status,'READY');
  assert.equal(created.persistent,true);
  now+=60_001;

  const resolved=await store.assertReady({
    principal:principal(),
    assetIds:['asset-persist-1234']
  });
  assert.equal(resolved[0].persistent,true);
  assert.deepEqual(await store.listExpired({limit:100}),[]);
  assert.equal(
    (await store.findReadyBySource({
      bridgeUserId:'bridge-user-1',
      sourceKind:'openai-file',
      sourceRef:'file_1234'
    })).assetId,
    'asset-persist-1234'
  );
});
