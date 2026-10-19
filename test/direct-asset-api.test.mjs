import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DirectAssetService } from '../src/cloudflare/direct-asset-service.mjs';
import { BridgeError } from '../src/errors.mjs';
import { withDirectAssetBufferSlot } from '../src/cloudflare/direct-asset-memory.mjs';
import {
  cleanupDirectAssets,
  createDirectAssetHandler
} from '../src/cloudflare/direct-asset-api.mjs';

const bytes=Buffer.from([0x89,0x50,0x4e,0x47,10,20,30]);
const sha=createHash('sha256').update(bytes).digest('hex');
const UPLOAD='upload_token_abcdefghijklmnopqrstuvwxyz123456';
const RUNNER='runner_token_abcdefghijklmnopqrstuvwxyz123456';

for(const phase of ['initial','buffered'])test('paused runner download '+phase+' denies private bytes',async()=>{
  let paused=phase==='initial',reads=0;
  const handler=createDirectAssetHandler({store:serviceStore({async authorizeUpload(){},async markReady(){},
    async authorizeRunnerDownload(){return {assetId:'asset-12345678',objectKey:'direct-assets/asset-12345678',fileName:'art.png',mimeType:'image/png',sizeBytes:bytes.length,sha256:sha};}}),
    directExecStore:{async authorizeExportUpload(){throw Error('unused');},async assertRunner(input){assert.equal(input.signalPaused,true);assert.equal(input.runnerTokenSha256,await hashText(RUNNER));if(paused)throw new BridgeError('DIRECT_HOST_PAUSED','paused');}},
    bucket:{async put(){throw Error('must not write');},async get(){reads++;paused=true;return {body:bytes};},async delete(){}}
  });
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/assets/asset-12345678',{headers:{authorization:'Bearer '+RUNNER,'x-bridge-host-id':'host-main','x-bridge-run-id':'dx1:host-main:direct-12345678','x-bridge-lease-owner':'runner:lease-1234'}}));
  assert.equal(response.status,403);assert.equal((await response.json()).error.code,'DIRECT_HOST_PAUSED');assert.equal(reads,phase==='initial'?0:1);
});

for(const phase of ['initial','buffered'])test('paused runner export '+phase+' writes no R2 object or asset',async()=>{
  let authorizations=0,writes=0;
  const handler=createDirectAssetHandler({store:serviceStore({async authorizeUpload(){},async markReady(){},async authorizeRunnerDownload(){}}),
    directExecStore:{async authorizeExportUpload(){if(phase==='initial'||++authorizations>1)throw new BridgeError('DIRECT_HOST_PAUSED','paused');return {bridgeUserId:'u',fileName:'art.png',mimeType:'image/png',maxBytes:1024};}},
    bucket:{async put(){writes++;},async get(){return null;},async delete(){}}
  });
  const response=await handler.fetch(new Request('https://bridge.example/direct/runner/exports/'+encodeURIComponent('dx1:host-main:direct-12345678')+'/0',{method:'PUT',headers:{authorization:'Bearer '+RUNNER,'x-bridge-host-id':'host-main','x-bridge-lease-owner':'runner:lease-1234','x-bridge-sha256':sha,'content-length':String(bytes.length)},body:bytes}));
  assert.equal(response.status,403);assert.equal((await response.json()).error.code,'DIRECT_HOST_PAUSED');assert.equal(writes,0);
});

async function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serviceStore(overrides={}) {
  return {
    async create(){ throw new Error('not used'); },
    async createReady(){ throw new Error('not used'); },
    async prepareReady(){ throw new Error('not used'); },
    async finalizePreparedReady(){ throw new Error('not used'); },
    async findReadyBySource(){ return null; },
    async getOwnedReady(){ throw new Error('not used'); },
    async assertReady(){},
    async getRun(){},
    async getResult(){},
    ...overrides
  };
}

test('Direct Asset service returns a one-time upload ticket without storing raw token',async()=>{
  let captured;
  const service=new DirectAssetService({
    publicUrl:'https://bridge.example/mcp',
    randomUUID:()=> 'fixed-uuid',
    randomBytes:()=>new Uint8Array(32).fill(7),
    store:serviceStore({
      async create(input) {
        captured=input;
        return {
          runId:'da1:asset-fixed-uuid',
          assetId:'asset-fixed-uuid',
          status:'WAITING_UPLOAD',
          fileName:input.fileName,
          mimeType:input.mimeType,
          sizeBytes:input.sizeBytes,
          sha256:input.sha256,
          expiresAt:12345
        };
      }
    })
  });
  const ticket=await service.createUpload({
    principal:{bridgeUserId:'u',externalProvider:'x',externalSubject:'y'},
    fileName:'art.png',
    mimeType:'image/png',
    sizeBytes:bytes.length,
    sha256:sha
  });
  assert.equal(ticket.assetId,'asset-fixed-uuid');
  assert.equal(ticket.upload.url,'https://bridge.example/direct/assets/upload/asset-fixed-uuid');
  assert.ok(ticket.upload.token.length>=40);
  assert.equal(captured.uploadTokenSha256,await hashText(ticket.upload.token));
  assert.equal(JSON.stringify(captured).includes(ticket.upload.token),false);
});

test('concurrent buffered asset upload fails fast with 429 before private persistence',async()=>{
  let release,put=false;
  const occupied=withDirectAssetBufferSlot(()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve();
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){return {
        assetId:'asset-busy-1234',objectKey:'direct-assets/asset-busy-1234',
        fileName:'busy.bin',mimeType:'application/octet-stream',sizeBytes:bytes.length,sha256:sha
      };},
      async markReady(){throw new Error('must not mark');},
      async authorizeRunnerDownload(){throw new Error('not used');}
    },
    bucket:{async put(){put=true;},async get(){return null;},async delete(){}}
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/assets/upload/asset-busy-1234',
    {method:'PUT',headers:{authorization:`Bearer ${UPLOAD}`,'content-length':String(bytes.length)},body:bytes}
  ));
  assert.equal(response.status,429);
  assert.equal((await response.json()).error.code,'DIRECT_ASSET_BUSY');
  assert.equal(put,false);
  release();
  await occupied;
});

test('asset upload validates exact bytes before putting private R2 object',async()=>{
  const objects=new Map();
  const uploadHash=await hashText(UPLOAD);
  let marked;
  const store={
    async authorizeUpload({assetId,uploadTokenSha256}) {
      assert.equal(assetId,'asset-12345678');
      assert.equal(uploadTokenSha256,uploadHash);
      return {
        assetId,
        objectKey:'direct-assets/asset-12345678',
        fileName:'art.png',
        mimeType:'image/png',
        sizeBytes:bytes.length,
        sha256:sha
      };
    },
    async markReady(input) {
      marked=input;
      return {runId:'da1:asset-12345678',assetId:'asset-12345678',status:'READY'};
    },
    async authorizeRunnerDownload(){ throw new Error('not used'); }
  };
  const bucket={
    async put(key,value,options) {
      objects.set(key,{bytes:Buffer.from(value),options});
    },
    async get(){ return null; },
    async delete(key){ objects.delete(key); }
  };
  const handler=createDirectAssetHandler({store,bucket});
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/assets/upload/asset-12345678',
    {
      method:'PUT',
      headers:{
        authorization:`Bearer ${UPLOAD}`,
        'content-type':'image/png',
        'content-length':String(bytes.length)
      },
      body:bytes
    }
  ));
  assert.equal(response.status,200);
  assert.deepEqual(objects.get('direct-assets/asset-12345678').bytes,bytes);
  assert.equal(objects.get('direct-assets/asset-12345678').options.customMetadata.sha256,sha);
  assert.equal(marked.actualSha256,sha);
  assert.equal(marked.actualSizeBytes,bytes.length);
});

test('asset upload finalization failure does not delete a potentially concurrent winner object',async()=>{
  const objects=new Map();
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){
        return {
          assetId:'asset-12345678',
          objectKey:'direct-assets/asset-12345678',
          fileName:'art.png',
          mimeType:'image/png',
          sizeBytes:bytes.length,
          sha256:sha
        };
      },
      async markReady(){ throw new BridgeError('DIRECT_ASSET_UPLOAD_DENIED','stale ticket'); },
      async authorizeRunnerDownload(){ throw new Error('not used'); }
    },
    bucket:{
      async put(key,value){ objects.set(key,Buffer.from(value)); },
      async get(){ return null; },
      async delete(key){ objects.delete(key); }
    }
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/assets/upload/asset-12345678',
    {method:'PUT',headers:{authorization:`Bearer ${UPLOAD}`},body:bytes}
  ));
  assert.equal(response.status,403);
  assert.deepEqual(objects.get('direct-assets/asset-12345678'),bytes);
});

test('asset upload rejects hash mismatch without creating object',async()=>{
  let put=false;
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){
        return {
          assetId:'asset-12345678',
          objectKey:'direct-assets/asset-12345678',
          fileName:'art.png',
          mimeType:'image/png',
          sizeBytes:bytes.length,
          sha256:'0'.repeat(64)
        };
      },
      async markReady(){ throw new Error('must not mark'); },
      async authorizeRunnerDownload(){ throw new Error('not used'); }
    },
    bucket:{
      async put(){ put=true; },
      async get(){},
      async delete(){}
    }
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/assets/upload/asset-12345678',
    {method:'PUT',headers:{authorization:`Bearer ${UPLOAD}`},body:bytes}
  ));
  assert.equal(response.status,403);
  assert.equal(put,false);
});

test('runner asset download is private and bound to runner authorization',async()=>{
  const runnerHash=await hashText(RUNNER);
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){ throw new Error('not used'); },
      async markReady(){ throw new Error('not used'); },
      async authorizeRunnerDownload({hostId,runnerTokenSha256,assetId,runId,leaseOwner}) {
        assert.equal(hostId,'host-main');
        assert.equal(runnerTokenSha256,runnerHash);
        assert.equal(assetId,'asset-12345678');
        assert.equal(runId,'dx1:host-main:direct-12345678');
        assert.equal(leaseOwner,'runner:lease-1234');
        return {
          assetId,
          objectKey:'direct-assets/asset-12345678',
          fileName:'art.png',
          mimeType:'image/png',
          sizeBytes:bytes.length,
          sha256:sha
        };
      }
    },
    bucket:{
      async put(){},
      async get(key) {
        assert.equal(key,'direct-assets/asset-12345678');
        return {body:bytes};
      },
      async delete(){}
    }
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/runner/assets/asset-12345678',
    {
      method:'GET',
      headers:{
        authorization:`Bearer ${RUNNER}`,
        'x-bridge-host-id':'host-main',
        'x-bridge-run-id':'dx1:host-main:direct-12345678',
        'x-bridge-lease-owner':'runner:lease-1234'
      }
    }
  ));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-bridge-sha256'),sha);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});

test('scheduled asset cleanup retires metadata durably before deleting bytes',async()=>{
  const order=[];
  let deleted;
  let marked;
  const result=await cleanupDirectAssets({
    store:{
      async listExpired(){
        order.push('list');
        return [
          {assetId:'asset-a',objectKey:'direct-assets/asset-a'},
          {assetId:'asset-b',objectKey:'direct-assets/asset-b'}
        ];
      },
      async markExpired({assetIds}){
        order.push('mark');
        marked=assetIds;
        return assetIds;
      },
      async listRetiredObjects(){ return [{objectKey:'direct-assets/asset-a'},{objectKey:'direct-assets/asset-b'}]; },
      async acknowledgeRetiredObjects(){order.push('ack');}
    },
    bucket:{
      async delete(keys){
        order.push('delete');
        deleted=keys;
      }
    }
  });
  assert.equal(result.expired,2);
  assert.deepEqual(order,['list','mark','delete','ack']);
  assert.deepEqual(deleted,['direct-assets/asset-a','direct-assets/asset-b']);
  assert.deepEqual(marked,['asset-a','asset-b']);
});

test('R2 cleanup failure leaves metadata retryable',async()=>{
  let marked=false;
  await assert.rejects(
    ()=>cleanupDirectAssets({
      store:{
        async listExpired(){
          return [{assetId:'asset-a',objectKey:'direct-assets/asset-a'}];
        },
        async markExpired(){ marked=true; return ['asset-a']; },
        async listRetiredObjects(){return [{objectKey:'direct-assets/asset-a'}];},
        async acknowledgeRetiredObjects(){throw Error('must retain failed delete');}
      },
      bucket:{
        async delete(){ throw new Error('temporary R2 failure'); }
      }
    }),
    /temporary R2 failure/
  );
  assert.equal(marked,true);
});

test('browser upload preflight is CORS-safe and malformed asset paths fail closed',async()=>{
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){ throw new Error('not used'); },
      async markReady(){ throw new Error('not used'); },
      async authorizeRunnerDownload(){ throw new Error('not used'); }
    },
    bucket:{
      async put(){},
      async get(){},
      async delete(){}
    }
  });
  const preflight=await handler.fetch(new Request(
    'https://bridge.example/direct/assets/upload/asset-12345678',
    {method:'OPTIONS'}
  ));
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
  assert.match(preflight.headers.get('access-control-allow-methods'),/PUT/);

  const malformed=await handler.fetch(new Request(
    'https://bridge.example/direct/assets/upload/%E0%A4%A',
    {method:'PUT'}
  ));
  assert.equal(malformed.status,404);
});


test('MCP-native file import fetches an approved ChatGPT file directly into temporary private R2',async()=>{
  const objects=new Map();
  let created;
  const service=new DirectAssetService({
    publicUrl:'https://bridge.example/mcp',
    randomUUID:()=> 'native-import',
    fetchImpl:async (url,init)=>{
      assert.equal(new URL(url).hostname,'files.oaiusercontent.com');
      assert.equal(init.redirect,'manual');
      return new Response(bytes,{
        status:200,
        headers:{'content-type':'image/png','content-length':String(bytes.length)}
      });
    },
    bucket:{
      async put(key,value,options){ objects.set(key,{bytes:Buffer.from(value),options}); },
      async get(){ return null; },
      async delete(key){ objects.delete(key); }
    },
    store:serviceStore({
      async prepareReady(input) {
        created=input;
        return {
          runId:'da1:asset-native-import',
          kind:'asset',
          assetId:'asset-native-import',
          objectKey:'direct-assets/asset-native-import',
          status:'WAITING_UPLOAD',
          fileName:input.fileName,
          mimeType:input.mimeType,
          sizeBytes:input.sizeBytes,
          sha256:input.sha256,
          persistent:false
        };
      },
      async finalizePreparedReady(input) {
        return {
          runId:'da1:asset-native-import',
          kind:'asset',
          assetId:'asset-native-import',
          status:'READY',
          fileName:'input.png',
          mimeType:'image/png',
          sizeBytes:bytes.length,
          sha256:sha,
          persistent:input.persistent
        };
      }
    })
  });
  const result=await service.importFile({
    principal:{bridgeUserId:'u',externalProvider:'x',externalSubject:'y'},
    file:{
      download_url:'https://files.oaiusercontent.com/private/file-1',
      file_id:'file_1',
      mime_type:'image/png',
      file_name:'input.png'
    }
  });
  assert.equal(result.status,'READY');
  assert.equal(result.persistent,false);
  assert.equal(created.sourceKind,'openai-file');
  assert.equal(created.sourceRef,'file_1');
  assert.equal(created.sha256,sha);
  assert.deepEqual(objects.get('direct-assets/asset-native-import').bytes,bytes);
  assert.equal(objects.get('direct-assets/asset-native-import').options.customMetadata.sha256,sha);
});

test('MCP-native file import rejects non-approved download hosts before fetching',async()=>{
  let fetched=false;
  const service=new DirectAssetService({
    publicUrl:'https://bridge.example/mcp',
    fetchImpl:async()=>{ fetched=true; throw new Error('must not fetch'); },
    bucket:{async put(){},async get(){},async delete(){}},
    store:serviceStore()
  });
  await assert.rejects(
    ()=>service.importFile({
      principal:{bridgeUserId:'u',externalProvider:'x',externalSubject:'y'},
      file:{
        download_url:'https://EVIL.Example/private/sensitive-path?token=synthetic-secret',
        file_id:'file_sensitive-id'
      }
    }),
    error=>{
      assert.equal(error.code,'DIRECT_ASSET_IMPORT_DENIED');
      assert.deepEqual(error.details,{hostname:'evil.example'});
      assert.equal(JSON.stringify(error.details).includes('sensitive'),false);
      assert.equal(JSON.stringify(error.details).includes('token'),false);
      return true;
    }
  );
  assert.equal(fetched,false);
});

test('file import redirect denial reveals only the normalized rejected hostname',async()=>{
  const fetched=[];
  const service=new DirectAssetService({
    publicUrl:'https://bridge.example/mcp',
    fetchImpl:async url=>{
      fetched.push(url.hostname);
      return new Response(null,{status:302,headers:{
        location:'https://Rejected.Example/hidden-path?signature=synthetic-secret'
      }});
    },
    bucket:{async put(){ throw new Error('must not store'); },async get(){},async delete(){}},
    store:serviceStore()
  });
  await assert.rejects(()=>service.importFile({
    principal:{bridgeUserId:'u',externalProvider:'x',externalSubject:'y'},
    file:{download_url:'https://files.oaiusercontent.com/private?token=synthetic-secret',file_id:'file_sensitive-id'}
  }),error=>{
    assert.equal(error.code,'DIRECT_ASSET_IMPORT_DENIED');
    assert.deepEqual(error.details,{hostname:'rejected.example'});
    assert.equal(JSON.stringify(error.details).includes('signature'),false);
    return true;
  });
  assert.deepEqual(fetched,['files.oaiusercontent.com']);
});

test('invalid file URL and credential-bearing URLs do not expose diagnostic details',async()=>{
  const service=new DirectAssetService({
    publicUrl:'https://bridge.example/mcp',
    fetchImpl:async()=>{ throw new Error('must not fetch'); },
    bucket:{async put(){ throw new Error('must not store'); },async get(){},async delete(){}},
    store:serviceStore()
  });
  for(const download_url of ['not-a-url','https://localhost/private',
    'https://127.0.0.1/private','https://user:synthetic-secret@evil.example/private']) {
    await assert.rejects(()=>service.importFile({
      principal:{bridgeUserId:'u',externalProvider:'x',externalSubject:'y'},
      file:{download_url,file_id:'file_sensitive-id'}
    }),error=>{
      assert.equal(error.code,'DIRECT_ASSET_IMPORT_DENIED');
      assert.equal(error.details,undefined);
      return true;
    });
  }
});

test('lease-bound Direct export uploads only a declared slot and persists exact bytes',async()=>{
  const objects=new Map();
  let created;
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){ throw new Error('not used'); },
      async markReady(){ throw new Error('not used'); },
      async authorizeRunnerDownload(){ throw new Error('not used'); },
      async findReadyBySource(){ return null; },
      async prepareReady(input) {
        created=input;
        return {
          runId:'da1:asset-exported',
          kind:'asset',
          assetId:'asset-exported',
          objectKey:'direct-assets/asset-exported',
          status:'WAITING_UPLOAD',
          fileName:input.fileName,
          mimeType:input.mimeType,
          sizeBytes:input.sizeBytes,
          sha256:input.sha256,
          persistent:false
        };
      },
      async finalizePreparedReady(input) {
        return {
          runId:'da1:asset-exported',
          kind:'asset',
          assetId:'asset-exported',
          status:'READY',
          fileName:'result.png',
          mimeType:'image/png',
          sizeBytes:bytes.length,
          sha256:sha,
          persistent:input.persistent
        };
      }
    },
    directExecStore:{
      async authorizeExportUpload(input) {
        assert.equal(input.hostId,'host-main');
        assert.equal(input.runId,'dx1:host-main:direct-export-run');
        assert.equal(input.exportIndex,0);
        assert.equal(input.leaseOwner,'runner:lease-1234');
        assert.equal(input.runnerTokenSha256,await hashText(RUNNER));
        return {
          bridgeUserId:'bridge-user-1',
          runId:input.runId,
          exportIndex:0,
          fileName:'result.png',
          mimeType:'image/png',
          maxBytes:1024,
          required:true
        };
      }
    },
    randomUUID:()=> 'exported',
    bucket:{
      async put(key,value,options){ objects.set(key,{bytes:Buffer.from(value),options}); },
      async get(){ return null; },
      async delete(key){ objects.delete(key); }
    }
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/runner/exports/'+
      encodeURIComponent('dx1:host-main:direct-export-run')+'/0',
    {
      method:'PUT',
      headers:{
        authorization:`Bearer ${RUNNER}`,
        'x-bridge-host-id':'host-main',
        'x-bridge-lease-owner':'runner:lease-1234',
        'x-bridge-sha256':sha,
        'content-length':String(bytes.length),
        'content-type':'image/png'
      },
      body:bytes
    }
  ));
  assert.equal(response.status,200);
  assert.equal(created.sourceKind,'direct-export');
  assert.equal(created.sourceRef,'dx1:host-main:direct-export-run:0');
  assert.equal(created.sha256,sha);
  assert.deepEqual(objects.get('direct-assets/asset-exported').bytes,bytes);
});

test('stale Direct export lease fails closed before private R2 write',async()=>{
  let put=false;
  const handler=createDirectAssetHandler({
    store:{
      async authorizeUpload(){},
      async markReady(){},
      async authorizeRunnerDownload(){},
      async findReadyBySource(){ return null; },
      async prepareReady(){ throw new Error('must not prepare'); },
      async finalizePreparedReady(){ throw new Error('must not finalize'); }
    },
    directExecStore:{
      async authorizeExportUpload(){
        throw new BridgeError('DIRECT_RUN_STALE','stale lease');
      }
    },
    bucket:{
      async put(){ put=true; },
      async get(){},
      async delete(){}
    }
  });
  const response=await handler.fetch(new Request(
    'https://bridge.example/direct/runner/exports/'+
      encodeURIComponent('dx1:host-main:direct-export-run')+'/0',
    {
      method:'PUT',
      headers:{
        authorization:`Bearer ${RUNNER}`,
        'x-bridge-host-id':'host-main',
        'x-bridge-lease-owner':'runner:lease-1234',
        'x-bridge-sha256':sha,
        'content-length':String(bytes.length)
      },
      body:bytes
    }
  ));
  assert.equal(response.status,409);
  assert.equal(put,false);
});
