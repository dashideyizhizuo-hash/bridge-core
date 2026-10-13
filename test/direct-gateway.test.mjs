import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeGateway } from '../src/gateway.mjs';

function githubTransport() {
  return {
    resolveRepository:async()=>{ throw new Error('GitHub transport should not be used'); },
    resolveTarget:async()=>{ throw new Error('GitHub transport should not be used'); },
    readProjectPolicy:async()=>{ throw new Error('GitHub transport should not be used'); },
    submitCapabilityRequest:async()=>{ throw new Error('GitHub transport should not be used'); },
    submitEditRequest:async()=>{ throw new Error('GitHub transport should not be used'); },
    getRun:async()=>{ throw new Error('GitHub transport should not be used'); },
    getResult:async()=>{ throw new Error('GitHub transport should not be used'); },
    publishVerified:async()=>{ throw new Error('GitHub transport should not be used'); }
  };
}

test('bridge.run direct needs only mode and argv when Direct store resolves the host',async()=>{
  const calls=[];
  const direct={
    async submit(input) {
      calls.push(input);
      return {
        runId:'dx1:host-main:direct-fixed',
        hostId:'host-main',
        requestId:'direct-fixed',
        status:'QUEUED'
      };
    },
    async getRun({runId}) {
      return {runId,kind:'direct',transport:'direct',hostId:'host-main',status:'QUEUED'};
    },
    async getResult({runId}) {
      return {runId,kind:'direct',transport:'direct',hostId:'host-main',status:'SUCCEEDED',evidence:{stdout:'ok',stderr:''}};
    }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    principal
  });

  const submitted=await gateway.run({mode:'direct',argv:['node','--version']});
  assert.equal(submitted.kind,'direct');
  assert.equal(submitted.hostId,'host-main');
  assert.equal(calls.length,1);
  assert.equal(calls[0].hostId,undefined);
  assert.deepEqual(calls[0].request.argv,['node','--version']);
  assert.match(calls[0].request.requestId,/^direct-/);

  assert.equal((await gateway.getRun({runId:submitted.runId})).status,'QUEUED');
  assert.equal((await gateway.getResult({runId:submitted.runId})).evidence.stdout,'ok');
  await assert.rejects(
    ()=>gateway.publish({runId:submitted.runId}),
    error=>error.code==='PUBLISH_DENIED'
  );
});

test('direct mode fails closed when deployment has no Direct store',async()=>{
  const gateway=new BridgeGateway({transport:githubTransport()});
  await assert.rejects(
    ()=>gateway.run({mode:'direct',argv:['node','--version']}),
    error=>error.code==='DIRECT_EXEC_UNAVAILABLE'
  );
});


test('Direct Exec is rejected inside a GitHub durable-task gateway',async()=>{
  const direct={
    async submit(){ throw new Error('must not submit'); },
    async getRun(){ throw new Error('must not read'); },
    async getResult(){ throw new Error('must not read'); }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const taskContext={
    taskKey:'example/project#1',
    leaseEpoch:1
  };
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    principal,
    taskContext
  });
  await assert.rejects(
    ()=>gateway.run({mode:'direct',argv:['node','--version']}),
    error=>error.code==='DIRECT_EXEC_TASK_UNSUPPORTED'
  );
  await assert.rejects(
    ()=>gateway.getRun({runId:'dx1:host-main:direct-fixed'}),
    error=>error.code==='DIRECT_EXEC_TASK_UNSUPPORTED'
  );
  await assert.rejects(
    ()=>gateway.getResult({runId:'dx1:host-main:direct-fixed'}),
    error=>error.code==='DIRECT_EXEC_TASK_UNSUPPORTED'
  );
});


test('bridge.discover without repository reports Direct hosts and default host',async()=>{
  const direct={
    async submit(){ throw new Error('not used'); },
    async getRun(){ throw new Error('not used'); },
    async getResult(){ throw new Error('not used'); },
    async listHosts(){
      return [{hostId:'host-main',enabled:true,lastSeenAt:12345}];
    }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    principal
  });
  const discovered=await gateway.discover();
  assert.equal(discovered.direct.enabled,true);
  assert.equal(discovered.direct.defaultHost,'host-main');
  assert.equal(discovered.direct.hosts[0].lastSeenAt,12345);
});


test('bridge.run asset creates one upload ticket and routes asset run state',async()=>{
  const direct={
    async submit(){ throw new Error('not used'); },
    async getRun(){ throw new Error('not used'); },
    async getResult(){ throw new Error('not used'); },
    async listHosts(){ return [{hostId:'host-main',enabled:true}]; }
  };
  const calls=[];
  const directAssets={
    async createUpload(input) {
      calls.push(input);
      return {
        runId:'da1:asset-fixed',
        kind:'asset',
        assetId:'asset-fixed',
        status:'WAITING_UPLOAD',
        upload:{url:'https://bridge.example/direct/assets/upload/asset-fixed',token:'secret'}
      };
    },
    async importFile(){ throw new Error('not used'); },
    async assertReady(){ throw new Error('not used'); },
    async getRun({runId}) {
      return {runId,kind:'asset',assetId:'asset-fixed',status:'WAITING_UPLOAD'};
    },
    async getResult({runId}) {
      return {runId,kind:'asset',assetId:'asset-fixed',status:'READY'};
    },
    async issueResource(){},
    async readResource(){ throw new Error('not used'); }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    directAssets,
    principal
  });
  const created=await gateway.run({
    mode:'asset',
    fileName:'art.png',
    mimeType:'image/png',
    sizeBytes:123,
    sha256:'a'.repeat(64)
  });
  assert.equal(created.runId,'da1:asset-fixed');
  assert.equal(calls.length,1);
  assert.equal(calls[0].principal,principal);
  assert.equal((await gateway.getRun({runId:created.runId})).status,'WAITING_UPLOAD');
  assert.equal((await gateway.getResult({runId:created.runId})).status,'READY');
  await assert.rejects(
    ()=>gateway.publish({runId:created.runId}),
    error=>error.code==='PUBLISH_DENIED'
  );
});

test('Direct Exec resolves owned READY assets into trusted request metadata',async()=>{
  let submitted;
  const direct={
    async submit(input) {
      submitted=input;
      return {runId:'dx1:host-main:direct-fixed',hostId:'host-main',status:'QUEUED'};
    },
    async getRun(){ throw new Error('not used'); },
    async getResult(){ throw new Error('not used'); }
  };
  const directAssets={
    async createUpload(){ throw new Error('not used'); },
    async importFile(){ throw new Error('not used'); },
    async assertReady({assetIds}) {
      assert.deepEqual(assetIds,['asset-one']);
      return [{
        assetId:'asset-one',
        fileName:'art.png',
        mimeType:'image/png',
        sizeBytes:100,
        sha256:'b'.repeat(64)
      }];
    },
    async getRun(){ throw new Error('not used'); },
    async getResult(){ throw new Error('not used'); },
    async issueResource(){},
    async readResource(){ throw new Error('not used'); }
  };
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    directAssets,
    principal:{bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'}
  });
  await gateway.run({
    mode:'direct',
    argv:['tool','--image','{asset:0}'],
    assets:['asset-one']
  });
  assert.deepEqual(submitted.request.assets,[{
    assetId:'asset-one',
    fileName:'art.png',
    mimeType:'image/png',
    sizeBytes:100,
    sha256:'b'.repeat(64)
  }]);
});

test('discover reports Direct Asset support only when configured',async()=>{
  const direct={
    async submit(){},
    async getRun(){},
    async getResult(){},
    async listHosts(){ return [{hostId:'host-main',enabled:true}]; }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const withoutAssets=new BridgeGateway({transport:githubTransport(),directExec:direct,principal});
  assert.equal((await withoutAssets.discover()).direct.assets.enabled,false);

  const directAssets={
    async createUpload(){},
    async importFile(){},
    async assertReady(){},
    async getRun(){},
    async getResult(){},
    async issueResource(){},
    async readResource(){}
  };
  const withAssets=new BridgeGateway({transport:githubTransport(),directExec:direct,directAssets,principal});
  const discovery=await withAssets.discover();
  assert.equal(discovery.direct.assets.enabled,true);
  assert.equal(discovery.direct.assets.maxBytes,25*1024*1024);
});


test('bridge.run connect creates OAuth-principal-bound pairing without repository context',async()=>{
  const calls=[];
  const direct={
    async submit(){ throw new Error('not used'); },
    async getRun(){ throw new Error('not used'); },
    async getResult(){ throw new Error('not used'); },
    async listHosts(){ return []; }
  };
  const directPairing={
    async create(input) {
      calls.push(input);
      return {
        kind:'connect',
        pairingId:'pair-1234567890abcdef',
        pairingToken:'pairing_token_abcdefghijklmnopqrstuvwxyz123456',
        endpoint:'https://bridge.example/mcp',
        expiresAt:123456
      };
    }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    directPairing,
    principal
  });

  const result=await gateway.run({mode:'connect'});
  assert.equal(result.kind,'connect');
  assert.equal(calls.length,1);
  assert.equal(calls[0].principal,principal);
  assert.equal(calls[0].ttlSeconds,600);

  const discovery=await gateway.discover();
  assert.equal(discovery.direct.connect.enabled,true);
  assert.equal(discovery.direct.connect.selfService,true);
});

test('connect mode forwards only bounded ticket lifetime to pairing service',async()=>{
  let input;
  const direct={
    async submit(){},
    async getRun(){},
    async getResult(){},
    async listHosts(){ return []; }
  };
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    directPairing:{
      async create(value) {
        input=value;
        return {kind:'connect'};
      }
    },
    principal:{bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'}
  });
  await gateway.run({mode:'connect',ttlSeconds:120});
  assert.equal(input.ttlSeconds,120);
  assert.equal(input.hostId,undefined);
  assert.equal(input.allowReplace,undefined);
});


test('authenticated connector user can disable or re-enable only through Direct host ownership store',async()=>{
  const calls=[];
  const direct={
    async submit(){},
    async getRun(){},
    async getResult(){},
    async listHosts(){ return [{hostId:'host-owned',enabled:true}]; },
    async setHostEnabled(input) {
      calls.push(input);
      return {hostId:input.hostId,enabled:input.enabled};
    }
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    principal
  });
  const disabled=await gateway.run({
    mode:'host',
    host:'host-owned',
    enabled:false
  });
  assert.deepEqual(disabled,{kind:'host',hostId:'host-owned',enabled:false});
  assert.equal(calls[0].principal,principal);
  assert.equal(calls[0].hostId,'host-owned');
  assert.equal(calls[0].enabled,false);
});


test('bridge.run asset imports a native ChatGPT file directly and defaults to temporary storage',async()=>{
  const file={
    download_url:'https://files.oaiusercontent.com/private/file-1',
    file_id:'file_1',
    mime_type:'image/png',
    file_name:'input.png'
  };
  let imported;
  const direct={
    async submit(){ throw new Error('not used'); },
    async getRun(){},
    async getResult(){},
    async listHosts(){ return [{hostId:'host-main',enabled:true}]; }
  };
  const directAssets={
    async createUpload(){ throw new Error('legacy ticket path must not run'); },
    async importFile(input) {
      imported=input;
      return {
        runId:'da1:asset-native',
        kind:'asset',
        assetId:'asset-native',
        status:'READY',
        fileName:'input.png',
        mimeType:'image/png',
        sizeBytes:7,
        sha256:'a'.repeat(64),
        persistent:true
      };
    },
    async assertReady(){},
    async getRun(){},
    async getResult(){},
    async issueResource(){},
    async readResource(){}
  };
  const principal={bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'};
  const gateway=new BridgeGateway({transport:githubTransport(),directExec:direct,directAssets,principal});
  const result=await gateway.run({mode:'asset',file});
  assert.equal(result.status,'READY');
  assert.equal(imported.principal,principal);
  assert.deepEqual(imported.file,file);
  assert.equal(imported.persistent,false);
});

test('Direct Exec forwards only bounded export descriptors and no caller filesystem path',async()=>{
  let submitted;
  const direct={
    async submit(input) {
      submitted=input;
      return {runId:'dx1:host-main:direct-fixed',hostId:'host-main',status:'QUEUED'};
    },
    async getRun(){},
    async getResult(){}
  };
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    principal:{bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'}
  });
  await gateway.run({
    mode:'direct',
    argv:['tool','--output','{export:0}'],
    exports:[{fileName:'result.png',mimeType:'image/png',maxBytes:4096,required:true}]
  });
  assert.deepEqual(submitted.request.exports,[{
    fileName:'result.png',
    mimeType:'image/png',
    maxBytes:4096,
    required:true
  }]);
  assert.equal(JSON.stringify(submitted.request).includes('C:\\'),false);
  assert.equal(JSON.stringify(submitted.request).includes('G:/'),false);
});


test('legacy upload-ticket path cannot create persistent orphan metadata',async()=>{
  let called=false;
  const direct={
    async submit(){},
    async getRun(){},
    async getResult(){},
    async listHosts(){ return [{hostId:'host-main',enabled:true}]; }
  };
  const directAssets={
    async createUpload(){ called=true; throw new Error('must not create ticket'); },
    async importFile(){},
    async assertReady(){},
    async getRun(){},
    async getResult(){},
    async issueResource(){},
    async readResource(){}
  };
  const gateway=new BridgeGateway({
    transport:githubTransport(),
    directExec:direct,
    directAssets,
    principal:{bridgeUserId:'bridge-user-1',externalProvider:'test',externalSubject:'subject'}
  });
  await assert.rejects(
    ()=>gateway.run({
      mode:'asset',
      fileName:'orphan.bin',
      mimeType:'application/octet-stream',
      sizeBytes:32,
      sha256:'a'.repeat(64),
      persistent:true
    }),
    error=>error.code==='INVALID_GATEWAY_REQUEST'
  );
  assert.equal(called,false);
});
