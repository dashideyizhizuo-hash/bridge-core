import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  claimDirectRun,
  completeDirectRun,
  heartbeatDirectRun,
  runDirectRunnerOnce
} from '../src/direct-runner-client.mjs';

const TOKEN='runner_token_abcdefghijklmnopqrstuvwxyz123456';

for(const [mode,status] of [['fresh',401],['fresh',403],['fresh',409],['completed',403],['ambiguous',403]]) {
  test(`heartbeat ${status} cancels pending ${mode} completion and preserves recovery`,async()=>{
    const f=hostFixture();
    try {
      const {markDirectJournalStarted,markDirectJournalCompleted,inspectDirectJournal}=await import('../src/direct-runner-journal.mjs');
      const marker=join(f.root,'executions');
      const request={schemaVersion:1,requestId:'direct-1234',hostId:'host-main',argv:[process.execPath,'-e',
        `require('fs').appendFileSync(${JSON.stringify(marker)},'x');console.log('done')`]};
      const policy=JSON.parse(readFileSync(f.hostPolicyPath));
      if(mode!=='fresh')markDirectJournalStarted({hostPolicy:policy,request});
      if(mode==='completed')markDirectJournalCompleted({hostPolicy:policy,request,result:{
        schemaVersion:1,requestId:request.requestId,hostId:request.hostId,status:'SUCCEEDED',evidence:{stdout:'stored',stderr:''}}});
      let revoked=false,completionAborted=false,heartbeats=0;
      const fetchImpl=async(url,init)=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/claim'))return Response.json({request,leaseOwner:'fixture-owner',runId:'dx1:host-main:direct-1234'});
        if(path.endsWith('/heartbeat')){revoked=true;heartbeats++;return Response.json({error:{code:'DIRECT_RUNNER_DENIED'}},{status});}
        if(!path.endsWith('/complete'))throw new Error('Unexpected fixture request');
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>resolve(Response.json({ok:true})),2500);
          init.signal.addEventListener('abort',()=>{clearTimeout(timer);completionAborted=true;reject(init.signal.reason);},{once:true});
        });
      };
      await assert.rejects(runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,
        hostPolicyPath:f.hostPolicyPath,heartbeatMs:1000,fetchImpl}),
        error=>error.code==='HOST_NETWORK_FAILED' && error.cause?.status===status);
      assert.equal(revoked,true);assert.equal(completionAborted,true);assert.ok(heartbeats>=1);
      const saved=inspectDirectJournal({hostPolicy:policy,request});assert.equal(saved.state,'COMPLETED');
      assert.equal(saved.result.status,mode==='ambiguous'?'FAILED':'SUCCEEDED');
      const replay=await runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
        fetchImpl:async url=>new URL(url).pathname.endsWith('/claim')
          ? Response.json({request,leaseOwner:'fresh-owner',runId:'dx1:host-main:direct-1234'}) : Response.json({ok:true})});
      assert.equal(replay.replayed,true);
      if(mode==='fresh')assert.equal(readFileSync(marker,'utf8'),'x');else assert.equal(existsSync(marker),false);
    } finally {f.cleanup();}
  });
}

function hostFixture() {
  const root=mkdtempSync(join(tmpdir(),'bridge-direct-client-'));
  const hostPolicyPath=join(root,'host.json');
  const stateDir=join(root,'state');
  writeFileSync(hostPolicyPath,JSON.stringify({
    version:1,
    host:{id:'host-main'},
    repositories:{},
    directExec:{
      enabled:true,
      serviceUser:userInfo().username,
      root,
      stateDir,
      maxSeconds:10,
      stdoutBytes:4096,
      stderrBytes:4096,
      resultBytes:4096
    }
  }));
  return {root,stateDir,hostPolicyPath,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

function claimResponse(argv) {
  return Response.json({
    runId:'dx1:host-main:direct-1234',
    request:{
      schemaVersion:1,
      requestId:'direct-1234',
      hostId:'host-main',
      argv
    },
    leaseOwner:'runner:session-1234',
    leaseExpiresAt:Date.now()+90_000
  });
}

test('direct runner client claims and completes one local command',async()=>{
  const f=hostFixture();
  try {
    const calls=[];
    const fetchImpl=async (url,init)=>{
      const parsed=new URL(url);
      calls.push({path:parsed.pathname,init});
      if(parsed.pathname==='/direct/runner/claim') {
        return claimResponse([process.execPath,'-e','process.stdout.write("hello")']);
      }
      if(parsed.pathname==='/direct/runner/complete') {
        const body=JSON.parse(init.body);
        assert.equal(body.runId,'dx1:host-main:direct-1234');
        assert.equal(body.result.status,'SUCCEEDED');
        assert.equal(body.result.evidence.stdout,'hello');
        return Response.json({runId:body.runId,status:'SUCCEEDED'});
      }
      throw new Error('unexpected URL '+parsed.pathname);
    };

    const result=await runDirectRunnerOnce({
      endpoint:'https://bridge.example',
      token:TOKEN,
      hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',
      fetchImpl
    });
    assert.equal(result.status,'SUCCEEDED');
    assert.deepEqual(calls.map(x=>x.path),[
      '/direct/runner/claim',
      '/direct/runner/complete'
    ]);
    const claimBody=JSON.parse(calls[0].init.body);
    assert.equal(claimBody.hostId,'host-main');
    assert.equal(claimBody.leaseMs,90_000);
    assert.equal(existsSync(join(f.stateDir,'host-main','direct-1234','result.json')),true);
  } finally {
    f.cleanup();
  }
});

test('lost completion replays durable result without executing side effect twice',async()=>{
  const f=hostFixture();
  try {
    const sideEffect=join(f.root,'side-effect.txt');
    const argv=[
      process.execPath,
      '-e',
      `require("fs").appendFileSync(${JSON.stringify(sideEffect)},"x");process.stdout.write("done")`
    ];
    let completeAttempts=0;
    const fetchImpl=async (url,init)=>{
      const path=new URL(url).pathname;
      if(path==='/direct/runner/claim') return claimResponse(argv);
      if(path==='/direct/runner/complete') {
        completeAttempts++;
        if(completeAttempts===1) {
          return Response.json({error:{code:'TEMPORARY',message:'down'}},{status:503});
        }
        return Response.json({runId:'dx1:host-main:direct-1234',status:'SUCCEEDED'});
      }
      throw new Error('unexpected '+path);
    };

    await assert.rejects(
      ()=>runDirectRunnerOnce({
        endpoint:'https://bridge.example',
        token:TOKEN,
        hostPolicyPath:f.hostPolicyPath,
        leaseOwner:'runner:session-1234',
        fetchImpl
      }),
      /HTTP 503/
    );
    assert.equal(readFileSync(sideEffect,'utf8'),'x');

    const second=await runDirectRunnerOnce({
      endpoint:'https://bridge.example',
      token:TOKEN,
      hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',
      fetchImpl
    });
    assert.equal(second.status,'SUCCEEDED');
    assert.equal(second.replayed,true);
    assert.equal(readFileSync(sideEffect,'utf8'),'x');
    assert.equal(completeAttempts,2);
  } finally {
    f.cleanup();
  }
});

test('unfinished local journal refuses automatic side-effect replay',async()=>{
  const f=hostFixture();
  try {
    const dir=join(f.stateDir,'host-main','direct-1234');
    const {mkdirSync}=await import('node:fs');
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'started.json'),JSON.stringify({
      schemaVersion:1,
      requestId:'direct-1234',
      hostId:'host-main',
      startedAt:new Date().toISOString()
    }));
    const sideEffect=join(f.root,'must-not-exist.txt');
    let completed;
    const fetchImpl=async (url,init)=>{
      const path=new URL(url).pathname;
      if(path==='/direct/runner/claim') {
        return claimResponse([
          process.execPath,
          '-e',
          `require("fs").writeFileSync(${JSON.stringify(sideEffect)},"bad")`
        ]);
      }
      if(path==='/direct/runner/complete') {
        completed=JSON.parse(init.body).result;
        return Response.json({runId:'dx1:host-main:direct-1234',status:'FAILED'});
      }
      throw new Error('unexpected '+path);
    };
    const result=await runDirectRunnerOnce({
      endpoint:'https://bridge.example',
      token:TOKEN,
      hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',
      fetchImpl
    });
    assert.equal(result.status,'FAILED');
    assert.equal(completed.error.code,'DIRECT_EXEC_AMBIGUOUS_REPLAY');
    assert.equal(existsSync(sideEffect),false);
  } finally {
    f.cleanup();
  }
});

for(const paused of [false,true])test((paused?'owner pause':'authorization loss')+' aborts a running process group',async()=>{
  const f=hostFixture();
  try {
    let heartbeatCount=0;
    let completed;
    const fetchImpl=async (url,init)=>{
      const path=new URL(url).pathname;
      if(path==='/direct/runner/claim') {
        return claimResponse([
          process.execPath,
          '-e',
          'setTimeout(()=>process.stdout.write("too-late"),10000)'
        ]);
      }
      if(path==='/direct/runner/heartbeat') {
        heartbeatCount++;
        return Response.json(
          {error:{code:paused?'DIRECT_HOST_PAUSED':'DIRECT_RUNNER_DENIED',message:'disabled'}},
          {status:paused?409:403}
        );
      }
      if(path==='/direct/runner/complete') {
        completed=JSON.parse(init.body).result;
        return Response.json(
          {error:{code:paused?'DIRECT_HOST_PAUSED':'DIRECT_RUNNER_DENIED',message:'disabled'}},
          {status:paused?409:403}
        );
      }
      throw new Error('unexpected '+path);
    };
    await assert.rejects(
      ()=>runDirectRunnerOnce({
        endpoint:'https://bridge.example',
        token:TOKEN,
        hostPolicyPath:f.hostPolicyPath,
        leaseOwner:'runner:session-1234',
        leaseMs:30_000,
        heartbeatMs:1_000,
        fetchImpl
      }),
      error=>error.status===(paused?409:403)
    );
    assert.ok(heartbeatCount>=1);
    assert.equal(completed,undefined,'revoked leases must not start a completion upload');
    const recorded=JSON.parse(readFileSync(join(f.stateDir,'host-main','direct-1234','result.json'),'utf8')).result;
    assert.equal(recorded.status,'FAILED');
    assert.equal(recorded.error.code,paused?'DIRECT_HOST_PAUSED':'DIRECT_RUNNER_DENIED');
  } finally {
    f.cleanup();
  }
});

test('claim client returns null for HTTP 204',async()=>{
  const result=await claimDirectRun({
    endpoint:'https://bridge.example',
    hostId:'host-main',
    token:TOKEN,
    leaseOwner:'runner:session-1234',
    fetchImpl:async()=>new Response(null,{status:204})
  });
  assert.equal(result,null);
});

test('successful lease heartbeats report contact while a native command is still running',async()=>{
  const f=hostFixture();let contacts=0,heartbeats=0,completed=false;
  try {
    const result=await runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      heartbeatMs:1000,onContact:()=>{contacts++;},fetchImpl:async(url)=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/claim'))return claimResponse([process.execPath,'-e','setTimeout(()=>{},2400)']);
        if(path.endsWith('/heartbeat')){heartbeats++;assert.equal(completed,false);return Response.json({ok:true});}
        completed=true;return Response.json({ok:true});
      }});
    assert.equal(result.status,'SUCCEEDED');assert.ok(heartbeats>=1);assert.ok(contacts>=2);
  } finally {f.cleanup();}
});

test('heartbeat client surfaces stale lease',async()=>{
  await assert.rejects(
    ()=>heartbeatDirectRun({
      endpoint:'https://bridge.example',
      hostId:'host-main',
      token:TOKEN,
      leaseOwner:'runner:session-1234',
      runId:'dx1:host-main:direct-1234',
      fetchImpl:async()=>Response.json(
        {error:{code:'DIRECT_RUN_STALE',message:'stale'}},
        {status:409}
      )
    }),
    error=>error.status===409 && error.bridgeCode==='DIRECT_RUN_STALE'
  );
});

test('completion client does not hide remote failure',async()=>{
  await assert.rejects(
    ()=>completeDirectRun({
      endpoint:'https://bridge.example',
      hostId:'host-main',
      token:TOKEN,
      leaseOwner:'runner:session-1234',
      runId:'dx1:host-main:direct-1234',
      result:{},
      fetchImpl:async()=>Response.json(
        {error:{code:'DIRECT_RUN_STALE',message:'stale'}},
        {status:409}
      )
    }),
    /HTTP 409/
  );
});


test('Direct Runner stages an asset before executing its placeholder argv',async()=>{
  const f=hostFixture();
  try {
    const assetBytes=Buffer.from([0x89,0x50,0x4e,0x47,1,2,3]);
    const {createHash}=await import('node:crypto');
    const digest=createHash('sha256').update(assetBytes).digest('hex');
    let completed;
    const fetchImpl=async (url,init)=>{
      const path=new URL(url).pathname;
      if(path==='/direct/runner/claim') {
        return Response.json({
          runId:'dx1:host-main:direct-asset-run',
          request:{
            schemaVersion:1,
            requestId:'direct-asset-run',
            hostId:'host-main',
            argv:[
              process.execPath,
              '-e',
              'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("hex"))',
              '{asset:0}'
            ],
            assets:[{
              assetId:'asset-12345678',
              fileName:'art.png',
              mimeType:'image/png',
              sizeBytes:assetBytes.length,
              sha256:digest
            }]
          },
          leaseOwner:'runner:session-1234',
          leaseExpiresAt:Date.now()+90_000
        });
      }
      if(path==='/direct/runner/assets/asset-12345678') {
        assert.equal(init.headers['x-bridge-host-id'],'host-main');
        assert.equal(init.headers['x-bridge-run-id'],'dx1:host-main:direct-asset-run');
        assert.equal(init.headers['x-bridge-lease-owner'],'runner:session-1234');
        return new Response(assetBytes,{
          status:200,
          headers:{'x-bridge-sha256':digest}
        });
      }
      if(path==='/direct/runner/complete') {
        completed=JSON.parse(init.body).result;
        return Response.json({runId:'dx1:host-main:direct-asset-run',status:'SUCCEEDED'});
      }
      throw new Error('unexpected '+path);
    };
    const result=await runDirectRunnerOnce({
      endpoint:'https://bridge.example',
      token:TOKEN,
      hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',
      fetchImpl
    });
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(completed.evidence.stdout,assetBytes.toString('hex'));
  } finally {
    f.cleanup();
  }
});

// Release hardening: exercise the lower-level entrypoint, not only runHost.
test('runner control transport rejects declared oversized replies before buffering',async()=>{
  await assert.rejects(claimDirectRun({endpoint:'https://bridge.example',hostId:'host-main',token:TOKEN,
    leaseOwner:'runner:session-1234',fetchImpl:async()=>new Response('{}',{headers:{'content-length':'2000000'}})}),
    error=>error.code==='HOST_RESPONSE_TOO_LARGE');
});
test('runner control transport never follows redirects with runner credentials',async()=>{
  await assert.rejects(claimDirectRun({endpoint:'https://bridge.example',hostId:'host-main',token:TOKEN,
    leaseOwner:'runner:session-1234',fetchImpl:async(_url,init)=>{
      assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://other.example'}});
    }}),error=>error.code==='HOST_REDIRECT_DENIED');
});
test('remote error text and untrusted error codes are not reflected in runner diagnostics',async()=>{
  await assert.rejects(heartbeatDirectRun({endpoint:'https://bridge.example',hostId:'host-main',token:TOKEN,
    leaseOwner:'runner:session-1234',runId:'dx1:host-main:direct-1234',fetchImpl:async()=>Response.json(
      {error:{code:'secret-reflection',message:TOKEN}},{status:503})}),
    error=>error.status===503 && !error.message.includes(TOKEN) && !error.message.includes('secret-reflection') && !error.bridgeCode);
});
test('completed replay does not depend on downloading an expired asset again',async()=>{
  const f=hostFixture();
  try {
    const {markDirectJournalStarted,markDirectJournalCompleted}=await import('../src/direct-runner-journal.mjs');
    const request={schemaVersion:1,requestId:'direct-1234',hostId:'host-main',argv:[process.execPath,'-e','throw Error()'],
      assets:[{assetId:'asset-12345678',fileName:'expired.bin',mimeType:'application/octet-stream',sizeBytes:1,sha256:'a'.repeat(64)}]};
    const hostPolicy=JSON.parse(readFileSync(f.hostPolicyPath));
    markDirectJournalStarted({hostPolicy,request});
    const stored={schemaVersion:1,requestId:request.requestId,hostId:request.hostId,status:'SUCCEEDED',evidence:{stdout:'already delivered',stderr:''}};
    markDirectJournalCompleted({hostPolicy,request,result:stored});
    let downloads=0,completed;
    const result=await runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',fetchImpl:async(url,init)=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/claim')) return Response.json({request,runId:'dx1:host-main:direct-1234',leaseOwner:'runner:session-1234'});
        if(path.includes('/assets/')) {downloads++;return new Response('expired',{status:404});}
        completed=JSON.parse(init.body).result;return Response.json({ok:true});
      }});
    assert.equal(result.replayed,true);assert.equal(downloads,0);assert.deepEqual(completed,stored);
  } finally {f.cleanup();}
});
test('authorization loss during asset preparation prevents command execution',async()=>{
  const f=hostFixture();
  try {
    const {createHash}=await import('node:crypto');const bytes=Buffer.from('x');
    const marker=join(f.root,'must-not-execute');let heartbeats=0,completed;
    const request={schemaVersion:1,requestId:'direct-1234',hostId:'host-main',
      argv:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
      assets:[{assetId:'asset-12345678',fileName:'test.bin',mimeType:'application/octet-stream',sizeBytes:1,
        sha256:createHash('sha256').update(bytes).digest('hex')}]};
    await assert.rejects(runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',heartbeatMs:1000,fetchImpl:async(url,init)=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/claim')) return Response.json({request,runId:'dx1:host-main:direct-1234',leaseOwner:'runner:session-1234'});
        if(path.endsWith('/heartbeat')) {heartbeats++;return Response.json({error:{code:'DIRECT_RUNNER_DENIED'}},{status:403});}
        if(path.includes('/assets/')) return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>resolve(new Response(bytes)),2200);
          init.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal.reason);},{once:true});
        });
        completed=JSON.parse(init.body).result;return Response.json({ok:true});
      }}),error=>error.status===403);
    assert.ok(heartbeats>=1);assert.equal(existsSync(marker),false);assert.equal(completed,undefined);
    const recorded=JSON.parse(readFileSync(join(f.stateDir,'host-main','direct-1234','result.json'),'utf8')).result;
    assert.equal(recorded.error.code,'DIRECT_RUNNER_DENIED');
  } finally {f.cleanup();}
});

test('explicit file pause skips command and completion, preserving pause response identity',async()=>{
  const f=hostFixture();try{
    const request={schemaVersion:1,requestId:'direct-1234',hostId:'host-main',argv:['must-not-start'],
      assets:[{assetId:'asset-12345678',fileName:'input.txt',mimeType:'text/plain',sizeBytes:1,sha256:'a'.repeat(64)}]};
    const calls=[];await assert.rejects(runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      fetchImpl:async(url)=>{const path=new URL(url).pathname;calls.push(path);if(path.endsWith('/claim'))return Response.json({request,runId:'dx1:host-main:direct-1234',leaseOwner:'runner:pause-fixture'});
        if(path.includes('/assets/'))return Response.json({error:{code:'DIRECT_HOST_PAUSED'}},{status:403});throw Error('must not complete or export');}}),e=>e.code==='DIRECT_HOST_PAUSED'&&e.status===403);
    assert.equal(calls.length,2);assert.ok(!calls.some(p=>p.endsWith('/complete')||p.includes('/exports/')));
  }finally{f.cleanup();}
});

test('large failed output is serialized once and stays below the completion limit',async()=>{
  const f=hostFixture();
  try {
    const policy=JSON.parse(readFileSync(f.hostPolicyPath));
    Object.assign(policy.directExec,{stdoutBytes:1048576,resultBytes:1048576});
    writeFileSync(f.hostPolicyPath,JSON.stringify(policy));let completed;
    await runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      fetchImpl:async(url,init)=>{
        if(new URL(url).pathname.endsWith('/claim')) return claimResponse([process.execPath,'-e',
          `process.stdout.write('x'.repeat(800000),()=>process.exit(1))`]);
        completed=JSON.parse(init.body).result;return Response.json({ok:true});
      }});
    assert.equal(completed.status,'FAILED');assert.equal(completed.evidence.stdout.length,800000);
    assert.ok(Buffer.byteLength(JSON.stringify(completed))<1500000);
    assert.equal(completed.error.details,undefined);
  } finally {f.cleanup();}
});
test('timeout retains partial output and execution identity in the normal result envelope',async()=>{
  const f=hostFixture();
  try {
    let completed;
    await runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      fetchImpl:async(url,init)=>{
        if(new URL(url).pathname.endsWith('/claim')) {
          const claim=await claimResponse([process.execPath,'-e',`process.stdout.write('before timeout');setInterval(()=>{},1000)`]).json();
          claim.request.timeoutSeconds=1;return Response.json(claim);
        }
        completed=JSON.parse(init.body).result;return Response.json({ok:true});
      }});
    assert.equal(completed.error.code,'EXECUTION_TIMEOUT');
    assert.equal(completed.evidence.stdout,'before timeout');
    assert.match(completed.requestSha256,/^[0-9a-f]{64}$/);assert.ok(completed.execution.durationMs>=900);
  } finally {f.cleanup();}
});
test('independent lease deadline cancels execution even while heartbeat fetch never settles',async t=>{
  const f=hostFixture(),stop=new AbortController();let completed,heartbeats=0;
  const realSetTimeout=globalThis.setTimeout;
  const fallback=realSetTimeout(()=>stop.abort(),10000);
  try {
    const policy=JSON.parse(readFileSync(f.hostPolicyPath));policy.directExec.maxSeconds=60;
    writeFileSync(f.hostPolicyPath,JSON.stringify(policy));
    t.mock.timers.enable({apis:['setTimeout','setInterval']});
    const running=runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      signal:stop.signal,leaseMs:30000,heartbeatMs:1000,fetchImpl:async(url,init)=>{
        const path=new URL(url).pathname;
        if(path.endsWith('/claim')) return claimResponse([process.execPath,'-e','setInterval(()=>{},1000)']);
        if(path.endsWith('/heartbeat')) {heartbeats++;return new Promise(()=>{});}
        completed=JSON.parse(init.body).result;return Response.json({ok:true});
      }});
    const rejection=assert.rejects(running,error=>error.code==='DIRECT_RUN_LEASE_UNCERTAIN');
    for(let i=0;i<20;i++) await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(1000);
    for(let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(21000);t.mock.timers.reset();
    await rejection;
    assert.ok(heartbeats>=1);assert.equal(completed,undefined);
    const recorded=JSON.parse(readFileSync(join(f.stateDir,'host-main','direct-1234','result.json'),'utf8')).result;
    assert.equal(recorded.error.code,'DIRECT_RUN_LEASE_UNCERTAIN');
  } finally {clearTimeout(fallback);stop.abort();t.mock.timers.reset();f.cleanup();}
});

test('replayed completion obeys independent lease expiry while heartbeat hangs',async t=>{
  const f=hostFixture(),stop=new AbortController();
  const realSetTimeout=globalThis.setTimeout;
  const fallback=realSetTimeout(()=>stop.abort(),10000);
  try {
    const {markDirectJournalStarted,markDirectJournalCompleted}=await import('../src/direct-runner-journal.mjs');
    const request={schemaVersion:1,requestId:'direct-1234',hostId:'host-main',argv:[process.execPath,'-e','throw Error("must not execute")']};
    const policy=JSON.parse(readFileSync(f.hostPolicyPath));
    markDirectJournalStarted({hostPolicy:policy,request});
    markDirectJournalCompleted({hostPolicy:policy,request,result:{schemaVersion:1,requestId:request.requestId,
      hostId:request.hostId,status:'SUCCEEDED',evidence:{stdout:'stored',stderr:''}}});
    const path=join(f.stateDir,'host-main','direct-1234','result.json');const before=readFileSync(path,'utf8');
    let completionStarted=false,completionAborted=false,heartbeats=0;
    t.mock.timers.enable({apis:['setTimeout','setInterval']});
    const running=runDirectRunnerOnce({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
      signal:stop.signal,leaseMs:30000,heartbeatMs:1000,fetchImpl:async(url,init)=>{
        const phase=new URL(url).pathname;
        if(phase.endsWith('/claim'))return Response.json({request,runId:'dx1:host-main:direct-1234',leaseOwner:'fixture-owner'});
        if(phase.endsWith('/heartbeat')){heartbeats++;return new Promise(()=>{});}
        completionStarted=true;
        return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>{
          completionAborted=true;reject(init.signal.reason);
        },{once:true}));
      }});
    const rejection=assert.rejects(running,error=>error.code==='DIRECT_RUN_LEASE_UNCERTAIN');
    for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(completionStarted,true);
    t.mock.timers.tick(1000);for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(21000);t.mock.timers.reset();await rejection;
    assert.ok(heartbeats>=1);assert.equal(completionAborted,true);assert.equal(readFileSync(path,'utf8'),before);
  } finally {clearTimeout(fallback);stop.abort();t.mock.timers.reset();f.cleanup();}
});


test('Direct Runner uploads only the declared export slot and binds returned asset to the result',async()=>{
  const f=hostFixture();
  try {
    const runId='dx1:host-main:direct-export-run';
    const request={
      schemaVersion:1,
      requestId:'direct-export-run',
      hostId:'host-main',
      argv:[
        process.execPath,
        '-e',
        'require("fs").writeFileSync(process.argv[1],"export-bytes");process.stdout.write("done")',
        '{export:0}'
      ],
      exports:[{
        fileName:'result.txt',
        mimeType:'text/plain',
        maxBytes:1024,
        required:true
      }]
    };
    let uploaded=null,completed=null;
    const fetchImpl=async(url,init)=>{
      const path=new URL(url).pathname;
      if(path==='/direct/runner/claim') {
        return Response.json({
          runId,
          request,
          leaseOwner:'runner:session-1234',
          leaseExpiresAt:Date.now()+90_000
        });
      }
      if(path.startsWith('/direct/runner/exports/')) {
        const body=Buffer.from(init.body);
        const digest=createHash('sha256').update(body).digest('hex');
        assert.equal(init.headers['x-bridge-host-id'],'host-main');
        assert.equal(init.headers['x-bridge-lease-owner'],'runner:session-1234');
        assert.equal(init.headers['x-bridge-sha256'],digest);
        assert.equal(init.headers['content-length'],String(body.length));
        assert.equal(body.toString('utf8'),'export-bytes');
        uploaded={path,digest,bytes:body.length};
        return Response.json({
          runId:'da1:asset-export-1',
          kind:'asset',
          assetId:'asset-export-1',
          status:'READY',
          fileName:'result.txt',
          mimeType:'text/plain',
          sizeBytes:body.length,
          sha256:digest,
          persistent:true
        });
      }
      if(path==='/direct/runner/complete') {
        completed=JSON.parse(init.body).result;
        return Response.json({runId,status:'SUCCEEDED'});
      }
      throw new Error('unexpected '+path);
    };
    const result=await runDirectRunnerOnce({
      endpoint:'https://bridge.example',
      token:TOKEN,
      hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',
      fetchImpl
    });
    assert.equal(result.status,'SUCCEEDED');
    assert.ok(uploaded);
    assert.equal(completed.status,'SUCCEEDED');
    assert.equal(completed.exports.length,1);
    assert.equal(completed.exports[0].assetId,'asset-export-1');
    assert.equal(completed.exports[0].persistent,true);
    assert.equal(
      readFileSync(join(f.stateDir,'exports','host-main','direct-export-run','00-result.txt'),'utf8'),
      'export-bytes'
    );
  } finally {
    f.cleanup();
  }
});

test('missing required Direct export fails the run without an upload attempt',async()=>{
  const f=hostFixture();
  try {
    const runId='dx1:host-main:direct-export-missing';
    const request={
      schemaVersion:1,
      requestId:'direct-export-missing',
      hostId:'host-main',
      argv:[process.execPath,'-e','process.stdout.write("no-file")'],
      exports:[{
        fileName:'required.txt',
        mimeType:'text/plain',
        maxBytes:1024,
        required:true
      }]
    };
    let uploadAttempted=false,completed;
    const fetchImpl=async(url,init)=>{
      const path=new URL(url).pathname;
      if(path==='/direct/runner/claim') {
        return Response.json({
          runId,
          request,
          leaseOwner:'runner:session-1234',
          leaseExpiresAt:Date.now()+90_000
        });
      }
      if(path.startsWith('/direct/runner/exports/')) {
        uploadAttempted=true;
        throw new Error('must not upload');
      }
      if(path==='/direct/runner/complete') {
        completed=JSON.parse(init.body).result;
        return Response.json({runId,status:'FAILED'});
      }
      throw new Error('unexpected '+path);
    };
    const result=await runDirectRunnerOnce({
      endpoint:'https://bridge.example',
      token:TOKEN,
      hostPolicyPath:f.hostPolicyPath,
      leaseOwner:'runner:session-1234',
      fetchImpl
    });
    assert.equal(result.status,'FAILED');
    assert.equal(uploadAttempted,false);
    assert.equal(completed.error.code,'DIRECT_EXPORT_MISSING');
  } finally {
    f.cleanup();
  }
});
