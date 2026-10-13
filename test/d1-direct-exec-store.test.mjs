import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import { D1DirectExecStore } from '../src/cloudflare/d1-direct-exec-store.mjs';

const NOW=1_900_000_000_000;
const TOKEN='a'.repeat(64);

function principal(id='bridge-user-1') {
  return createBridgePrincipal({
    bridgeUserId:id,
    externalProvider:'https://identity.example/',
    externalSubject:id
  });
}

function runRow(value) {
  if(!value) return null;
  return {
    request_id:value.requestId,
    run_id:value.runId,
    bridge_user_id:value.bridgeUserId,
    host_id:value.hostId,
    request_json:value.requestJson,
    status:value.status,
    lease_owner:value.leaseOwner,
    lease_expires_at:value.leaseExpiresAt,
    result_json:value.resultJson,
    created_at:value.createdAt,
    updated_at:value.updatedAt,
    completed_at:value.completedAt,
    expires_at:value.expiresAt,
    cancel_reason:value.cancelReason
  };
}

class FakeStatement {
  constructor(db,sql,args=[]) {
    this.db=db;
    this.sql=sql.replace(/\s+/g,' ').trim();
    this.args=args;
  }
  bind(...args) { return new FakeStatement(this.db,this.sql,args); }

  async run() {
    if(this.sql.startsWith('INSERT INTO direct_hosts')) {
      const [hostId,bridgeUserId,token,enabled,createdAt,updatedAt]=this.args;
      const existing=this.db.hosts.get(hostId);
      if(existing && existing.bridgeUserId!==bridgeUserId) return {success:true,meta:{changes:0}};
      this.db.hosts.set(hostId,{
        hostId,bridgeUserId,token,enabled:Number(enabled),
        createdAt:existing?.createdAt??createdAt,
        updatedAt,lastSeenAt:existing?.lastSeenAt??null
      });
      return {success:true,meta:{changes:1}};
    }
    if(this.sql.startsWith('UPDATE direct_hosts SET enabled=')) {
      const [enabled,updatedAt,hostId,bridgeUserId]=this.args;
      const host=this.db.hosts.get(hostId);
      if(!host || host.bridgeUserId!==bridgeUserId) return {success:true,meta:{changes:0}};
      host.enabled=Number(enabled);
      host.updatedAt=updatedAt;
      return {success:true,meta:{changes:1}};
    }
    if(this.sql.startsWith('UPDATE direct_hosts SET last_seen_at=')) {
      const [lastSeenAt,hostId,token]=this.args;
      const host=this.db.hosts.get(hostId);
      if(!host || host.token!==token || host.enabled!==1) return {success:true,meta:{changes:0}};
      host.lastSeenAt=lastSeenAt;
      return {success:true,meta:{changes:1}};
    }
    if(this.sql.startsWith('INSERT INTO direct_runs')) {
      const [requestId,runId,bridgeUserId,hostId,requestJson,createdAt,updatedAt,expiresAt]=this.args;
      if(this.db.runs.has(requestId)) throw new Error('UNIQUE constraint failed');
      this.db.runs.set(requestId,{
        requestId,runId,bridgeUserId,hostId,requestJson,status:'QUEUED',
        leaseOwner:null,leaseExpiresAt:null,resultJson:null,
        createdAt,updatedAt,completedAt:null,expiresAt,cancelReason:null
      });
      return {success:true,meta:{changes:1}};
    }
    if(this.sql.includes("cancel_reason='TOKEN_ROTATED'")) {
      const [updatedAt,completedAt,hostId]=this.args;
      let changes=0;
      for(const run of this.db.runs.values()) {
        if(run.hostId===hostId && run.status==='RUNNING') {
          Object.assign(run,{
            status:'CANCELED',cancelReason:'TOKEN_ROTATED',
            leaseOwner:null,leaseExpiresAt:null,updatedAt,completedAt
          });
          changes++;
        }
      }
      return {success:true,meta:{changes}};
    }
    if(this.sql.includes("cancel_reason='HOST_DISABLED'")) {
      const [updatedAt,completedAt,hostId]=this.args;
      let changes=0;
      for(const run of this.db.runs.values()) {
        if(run.hostId===hostId && ['QUEUED','RUNNING'].includes(run.status)) {
          Object.assign(run,{
            status:'CANCELED',cancelReason:'HOST_DISABLED',
            leaseOwner:null,leaseExpiresAt:null,updatedAt,completedAt
          });
          changes++;
        }
      }
      return {success:true,meta:{changes}};
    }
    if(this.sql.includes("cancel_reason='QUEUE_EXPIRED'")) {
      const [updatedAt,completedAt,hostId,now]=this.args;
      let changes=0;
      for(const run of this.db.runs.values()) {
        if(run.hostId===hostId && run.status==='QUEUED' && run.expiresAt!==null && run.expiresAt<=now) {
          Object.assign(run,{
            status:'CANCELED',cancelReason:'QUEUE_EXPIRED',updatedAt,completedAt
          });
          changes++;
        }
      }
      return {success:true,meta:{changes}};
    }
    if(this.sql.startsWith("UPDATE direct_runs SET status='QUEUED'")) {
      const [updatedAt,hostId,now]=this.args;
      let changes=0;
      for(const run of this.db.runs.values()) {
        if(
          run.hostId===hostId && run.status==='RUNNING' &&
          run.leaseExpiresAt!==null && run.leaseExpiresAt<=now &&
          run.resultJson===null
        ) {
          run.status='QUEUED';
          run.leaseOwner=null;
          run.leaseExpiresAt=null;
          run.updatedAt=updatedAt;
          changes++;
        }
      }
      return {success:true,meta:{changes}};
    }
    throw new Error('unexpected run SQL: '+this.sql);
  }

  async first() {
    if(this.sql.startsWith('SELECT bridge_user_id, runner_token_sha256 FROM direct_hosts')) {
      const host=this.db.hosts.get(this.args[0]);
      return host ? {bridge_user_id:host.bridgeUserId,runner_token_sha256:host.token} : null;
    }
    if(this.sql.startsWith('SELECT host_id FROM direct_hosts WHERE bridge_user_id = ? AND host_id = ?')) {
      const [bridgeUserId,hostId]=this.args;
      const host=this.db.hosts.get(hostId);
      return host && host.bridgeUserId===bridgeUserId && host.enabled===1
        ? {host_id:hostId}
        : null;
    }
    if(this.sql.startsWith('SELECT host_id, last_seen_at FROM direct_hosts')) {
      const [hostId,token]=this.args;
      const host=this.db.hosts.get(hostId);
      return host && host.token===token && host.enabled===1
        ? {host_id:hostId,last_seen_at:host.lastSeenAt}
        : null;
    }
    if(this.sql.startsWith('SELECT request_id, run_id, host_id, status, created_at')) {
      const [runId,bridgeUserId]=this.args;
      const run=[...this.db.runs.values()].find(x=>x.runId===runId && x.bridgeUserId===bridgeUserId);
      return runRow(run);
    }
    if(this.sql.startsWith('SELECT request_id, run_id, host_id, status, result_json')) {
      const [runId,bridgeUserId]=this.args;
      const run=[...this.db.runs.values()].find(x=>x.runId===runId && x.bridgeUserId===bridgeUserId);
      return runRow(run);
    }
    if(this.sql.startsWith("UPDATE direct_runs SET status='RUNNING'")) {
      const [owner,leaseExpiresAt,updatedAt,hostId,now]=this.args;
      const candidates=[...this.db.runs.values()]
        .filter(x=>
          x.hostId===hostId &&
          x.status==='QUEUED' &&
          (x.expiresAt===null || x.expiresAt>now)
        )
        .sort((a,b)=>a.createdAt-b.createdAt || a.requestId.localeCompare(b.requestId));
      const run=candidates[0];
      if(!run) return null;
      Object.assign(run,{status:'RUNNING',leaseOwner:owner,leaseExpiresAt,updatedAt});
      return runRow(run);
    }
    if(this.sql.startsWith('UPDATE direct_runs SET lease_expires_at=')) {
      const [leaseExpiresAt,updatedAt,runId,hostId,owner,now]=this.args;
      const run=[...this.db.runs.values()].find(x=>x.runId===runId);
      if(
        !run || run.hostId!==hostId || run.status!=='RUNNING' ||
        run.leaseOwner!==owner || run.leaseExpiresAt===null || run.leaseExpiresAt<=now
      ) return null;
      run.leaseExpiresAt=leaseExpiresAt;
      run.updatedAt=updatedAt;
      return {run_id:run.runId,lease_expires_at:leaseExpiresAt};
    }
    if(this.sql.startsWith('UPDATE direct_runs SET status=?')) {
      const [status,resultJson,updatedAt,completedAt,runId,hostId,owner,now]=this.args;
      const run=[...this.db.runs.values()].find(x=>x.runId===runId);
      if(
        !run || run.hostId!==hostId || run.status!=='RUNNING' ||
        run.leaseOwner!==owner || run.leaseExpiresAt===null || run.leaseExpiresAt<=now
      ) return null;
      Object.assign(run,{
        status,resultJson,leaseOwner:null,leaseExpiresAt:null,
        updatedAt,completedAt
      });
      return runRow(run);
    }
    throw new Error('unexpected first SQL: '+this.sql);
  }

  async all() {
    if(this.sql.startsWith('SELECT host_id, enabled, created_at')) {
      const [bridgeUserId]=this.args;
      return {
        success:true,
        results:[...this.db.hosts.values()]
          .filter(x=>x.bridgeUserId===bridgeUserId)
          .sort((a,b)=>a.hostId.localeCompare(b.hostId))
          .map(x=>({
            host_id:x.hostId,enabled:x.enabled,created_at:x.createdAt,
            updated_at:x.updatedAt,last_seen_at:x.lastSeenAt
          }))
      };
    }
    if(this.sql.startsWith('SELECT host_id FROM direct_hosts WHERE bridge_user_id = ?')) {
      const [bridgeUserId]=this.args;
      const results=[...this.db.hosts.values()]
        .filter(x=>x.bridgeUserId===bridgeUserId && x.enabled===1)
        .sort((a,b)=>a.hostId.localeCompare(b.hostId))
        .slice(0,2)
        .map(x=>({host_id:x.hostId}));
      return {success:true,results};
    }
    if(this.sql.includes("cancel_reason='QUEUE_EXPIRED'")) {
      const [updatedAt,completedAt,now,limit]=this.args;
      const candidates=[...this.db.runs.values()]
        .filter(x=>x.status==='QUEUED' && x.expiresAt!==null && x.expiresAt<=now)
        .sort((a,b)=>a.expiresAt-b.expiresAt)
        .slice(0,limit);
      for(const run of candidates) {
        Object.assign(run,{
          status:'CANCELED',
          cancelReason:'QUEUE_EXPIRED',
          leaseOwner:null,
          leaseExpiresAt:null,
          updatedAt,
          completedAt
        });
      }
      return {success:true,results:candidates.map(x=>({request_id:x.requestId}))};
    }
    if(this.sql.includes("cancel_reason='LEASE_EXPIRED'")) {
      const [updatedAt,completedAt,leaseNow,queueNow,limit]=this.args;
      const candidates=[...this.db.runs.values()]
        .filter(x=>
          x.status==='RUNNING' &&
          x.leaseExpiresAt!==null && x.leaseExpiresAt<=leaseNow &&
          x.expiresAt!==null && x.expiresAt<=queueNow
        )
        .sort((a,b)=>a.leaseExpiresAt-b.leaseExpiresAt)
        .slice(0,limit);
      for(const run of candidates) {
        Object.assign(run,{
          status:'CANCELED',
          cancelReason:'LEASE_EXPIRED',
          leaseOwner:null,
          leaseExpiresAt:null,
          updatedAt,
          completedAt
        });
      }
      return {success:true,results:candidates.map(x=>({request_id:x.requestId}))};
    }
    if(this.sql.startsWith("UPDATE direct_runs SET status='QUEUED'")) {
      const [updatedAt,leaseNow,queueNow,limit]=this.args;
      const candidates=[...this.db.runs.values()]
        .filter(x=>
          x.status==='RUNNING' &&
          x.leaseExpiresAt!==null && x.leaseExpiresAt<=leaseNow &&
          (x.expiresAt===null || x.expiresAt>queueNow)
        )
        .sort((a,b)=>a.leaseExpiresAt-b.leaseExpiresAt)
        .slice(0,limit);
      for(const run of candidates) {
        Object.assign(run,{
          status:'QUEUED',
          leaseOwner:null,
          leaseExpiresAt:null,
          updatedAt
        });
      }
      return {success:true,results:candidates.map(x=>({request_id:x.requestId}))};
    }
    if(this.sql.startsWith('DELETE FROM direct_runs')) {
      const [cutoff,limit]=this.args;
      const candidates=[...this.db.runs.values()]
        .filter(x=>
          ['SUCCEEDED','FAILED','CANCELED'].includes(x.status) &&
          x.completedAt!==null &&
          x.completedAt<=cutoff
        )
        .sort((a,b)=>a.completedAt-b.completedAt)
        .slice(0,limit);
      for(const run of candidates) this.db.runs.delete(run.requestId);
      return {
        success:true,
        results:candidates.map(x=>({request_id:x.requestId}))
      };
    }
    throw new Error('unexpected all SQL: '+this.sql);
  }
}

class FakeD1 {
  constructor() {
    this.hosts=new Map();
    this.runs=new Map();
  }
  prepare(sql) { return new FakeStatement(this,sql); }
  async batch(statements) {
    const results=[];
    for(const statement of statements) results.push(await statement.run());
    return results;
  }
}

function request(id='direct-1234',hostId='host-main') {
  return {
    schemaVersion:1,
    requestId:id,
    hostId,
    argv:['node','--version']
  };
}

test('Direct Exec migrations cover durable runs and hardening metadata',()=>{
  const initial=readFileSync(new URL('../migrations/0009_direct_exec.sql',import.meta.url),'utf8');
  const hardening=readFileSync(new URL('../migrations/0010_direct_exec_hardening.sql',import.meta.url),'utf8');
  assert.match(initial,/CREATE TABLE IF NOT EXISTS direct_hosts/);
  assert.match(initial,/CREATE TABLE IF NOT EXISTS direct_runs/);
  assert.match(hardening,/last_seen_at/);
  assert.match(hardening,/expires_at/);
  assert.match(hardening,/cancel_reason/);
});

test('one registered host is selected automatically and discoverable',async()=>{
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>NOW});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  assert.equal(await store.resolveHost({principal:principal()}),'host-main');
  const hosts=await store.listHosts({principal:principal()});
  assert.equal(hosts.length,1);
  assert.equal(hosts[0].hostId,'host-main');
  assert.equal(hosts[0].enabled,true);
});

test('multiple hosts require an explicit host',async()=>{
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>NOW});
  await store.registerHost({principal:principal(),hostId:'host-a',runnerTokenSha256:'a'.repeat(64)});
  await store.registerHost({principal:principal(),hostId:'host-b',runnerTokenSha256:'b'.repeat(64)});
  await assert.rejects(
    ()=>store.resolveHost({principal:principal()}),
    error=>error.code==='DIRECT_HOST_AMBIGUOUS'
  );
  assert.equal(await store.resolveHost({principal:principal(),hostId:'host-b'}),'host-b');
});

test('a host cannot be silently taken over by another principal',async()=>{
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>NOW});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  await assert.rejects(
    ()=>store.registerHost({
      principal:principal('bridge-user-2'),
      hostId:'host-main',
      runnerTokenSha256:'b'.repeat(64)
    }),
    error=>error.code==='DIRECT_HOST_DENIED'
  );
});

test('direct run lifecycle is principal scoped, leased, renewable and bounded',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>now});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});

  const submitted=await store.submit({principal:principal(),request:request()});
  assert.equal(submitted.status,'QUEUED');
  assert.equal(submitted.expiresAt,NOW+15*60*1000);

  const claim=await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,
    leaseOwner:'runner:session-1234',leaseMs:90_000
  });
  assert.equal(claim.runId,submitted.runId);

  now+=20_000;
  const renewed=await store.renewLease({
    hostId:'host-main',runnerTokenSha256:TOKEN,
    leaseOwner:'runner:session-1234',runId:submitted.runId,leaseMs:90_000
  });
  assert.equal(renewed.continue,true);
  assert.equal(renewed.leaseExpiresAt,now+90_000);

  const completed=await store.complete({
    hostId:'host-main',
    runnerTokenSha256:TOKEN,
    leaseOwner:'runner:session-1234',
    runId:submitted.runId,
    result:{
      schemaVersion:1,transport:'direct',requestId:'direct-1234',
      hostId:'host-main',status:'SUCCEEDED',evidence:{stdout:'ok',stderr:''}
    }
  });
  assert.equal(completed.status,'SUCCEEDED');
  const result=await store.getResult({principal:principal(),runId:submitted.runId});
  assert.equal(result.evidence.stdout,'ok');
});

test('expired queued work is canceled instead of executing later',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>now});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  const submitted=await store.submit({
    principal:principal(),request:request(),queueTtlMs:30_000
  });
  now+=30_001;
  const claim=await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,
    leaseOwner:'runner:session-1234',leaseMs:90_000
  });
  assert.equal(claim,null);
  const run=await store.getRun({principal:principal(),runId:submitted.runId});
  assert.equal(run.status,'CANCELED');
  assert.equal(run.cancelReason,'QUEUE_EXPIRED');
  const result=await store.getResult({principal:principal(),runId:submitted.runId});
  assert.equal(result.status,'CANCELED');
});

test('expired runner leases are requeued and old completion is fenced',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>now});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  const submitted=await store.submit({principal:principal(),request:request()});
  await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,leaseOwner:'runner:first-0001',leaseMs:5_000
  });
  now+=5_001;
  const second=await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,leaseOwner:'runner:second-0002',leaseMs:5_000
  });
  assert.equal(second.runId,submitted.runId);
  await assert.rejects(
    ()=>store.complete({
      hostId:'host-main',runnerTokenSha256:TOKEN,
      leaseOwner:'runner:first-0001',runId:submitted.runId,
      result:{
        schemaVersion:1,transport:'direct',requestId:'direct-1234',
        hostId:'host-main',status:'SUCCEEDED',evidence:{stdout:'late',stderr:''}
      }
    }),
    error=>error.code==='DIRECT_RUN_STALE'
  );
});

test('disabling host cancels queued and running work',async()=>{
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>NOW});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  const queued=await store.submit({principal:principal(),request:request('direct-queued')});
  const running=await store.submit({principal:principal(),request:request('direct-running')});
  await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,leaseOwner:'runner:session-1234',leaseMs:90_000
  });
  await store.setHostEnabled({principal:principal(),hostId:'host-main',enabled:false});
  assert.equal((await store.getRun({principal:principal(),runId:queued.runId})).status,'CANCELED');
  assert.equal((await store.getRun({principal:principal(),runId:running.runId})).status,'CANCELED');
  await assert.rejects(
    ()=>store.assertRunner({hostId:'host-main',runnerTokenSha256:TOKEN}),
    error=>error.code==='DIRECT_RUNNER_DENIED'
  );
});

test('runner token rotation cancels in-flight work and invalidates old token',async()=>{
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>NOW});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  const submitted=await store.submit({principal:principal(),request:request()});
  await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,leaseOwner:'runner:session-1234',leaseMs:90_000
  });
  const next='b'.repeat(64);
  const rotated=await store.registerHost({
    principal:principal(),hostId:'host-main',runnerTokenSha256:next
  });
  assert.equal(rotated.rotated,true);
  assert.equal((await store.getRun({principal:principal(),runId:submitted.runId})).cancelReason,'TOKEN_ROTATED');
  await assert.rejects(
    ()=>store.assertRunner({hostId:'host-main',runnerTokenSha256:TOKEN}),
    error=>error.code==='DIRECT_RUNNER_DENIED'
  );
  assert.equal(await store.assertRunner({hostId:'host-main',runnerTokenSha256:next}),'host-main');
});

test('runner authentication updates last-seen at bounded frequency',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>now});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  await store.assertRunner({hostId:'host-main',runnerTokenSha256:TOKEN});
  let hosts=await store.listHosts({principal:principal()});
  assert.equal(hosts[0].lastSeenAt,NOW);
  now+=10_000;
  await store.assertRunner({hostId:'host-main',runnerTokenSha256:TOKEN});
  hosts=await store.listHosts({principal:principal()});
  assert.equal(hosts[0].lastSeenAt,NOW);
  now+=60_000;
  await store.assertRunner({hostId:'host-main',runnerTokenSha256:TOKEN});
  hosts=await store.listHosts({principal:principal()});
  assert.equal(hosts[0].lastSeenAt,now);
});

test('D1-safe result ceiling rejects oversized durable results',async()=>{
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>NOW});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  const submitted=await store.submit({principal:principal(),request:request()});
  await store.claimNext({
    hostId:'host-main',runnerTokenSha256:TOKEN,leaseOwner:'runner:session-1234',leaseMs:90_000
  });
  await assert.rejects(
    ()=>store.complete({
      hostId:'host-main',runnerTokenSha256:TOKEN,leaseOwner:'runner:session-1234',
      runId:submitted.runId,
      result:{
        schemaVersion:1,transport:'direct',requestId:'direct-1234',
        hostId:'host-main',status:'SUCCEEDED',
        evidence:{stdout:'x'.repeat(1_600_000),stderr:''}
      }
    }),
    error=>error.code==='DIRECT_RUN_INVALID'
  );
});


test('terminal Direct Run results are pruned after bounded retention',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>now});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});
  const submitted=await store.submit({principal:principal(),request:request()});
  await store.claimNext({
    hostId:'host-main',
    runnerTokenSha256:TOKEN,
    leaseOwner:'runner:session-1234',
    leaseMs:90_000
  });
  await store.complete({
    hostId:'host-main',
    runnerTokenSha256:TOKEN,
    leaseOwner:'runner:session-1234',
    runId:submitted.runId,
    result:{
      schemaVersion:1,
      transport:'direct',
      requestId:'direct-1234',
      hostId:'host-main',
      status:'SUCCEEDED',
      evidence:{stdout:'ok',stderr:''}
    }
  });
  now+=14*24*60*60*1000+1;
  const pruned=await store.pruneTerminal({retentionMs:14*24*60*60*1000});
  assert.equal(pruned.removed,1);
  assert.equal(db.runs.has('direct-1234'),false);
});


test('scheduled reconciliation converges offline queued and stale running work',async()=>{
  let now=NOW;
  const db=new FakeD1();
  const store=new D1DirectExecStore({db,clock:()=>now});
  await store.registerHost({principal:principal(),hostId:'host-main',runnerTokenSha256:TOKEN});

  const expiredQueued=await store.submit({
    principal:principal(),
    request:request('direct-expired-q'),
    queueTtlMs:30_000
  });
  const staleRequeue=await store.submit({
    principal:principal(),
    request:request('direct-requeue'),
    queueTtlMs:5*60_000
  });
  const staleCancel=await store.submit({
    principal:principal(),
    request:request('direct-stale-cancel'),
    queueTtlMs:30_000
  });

  // Leave the first row QUEUED, and force the other two into representative
  // stale RUNNING states to test each reconciler transition independently.
  const requeueRow=db.runs.get('direct-requeue');
  Object.assign(requeueRow,{
    status:'RUNNING',
    leaseOwner:'runner:second-0002',
    leaseExpiresAt:NOW+5_000
  });
  const cancelRow=db.runs.get('direct-stale-cancel');
  Object.assign(cancelRow,{
    status:'RUNNING',
    leaseOwner:'runner:third-0003',
    leaseExpiresAt:NOW+5_000
  });

  now+=30_001;
  const result=await store.reconcileExpired({limit:100});
  assert.equal(result.canceledQueued,1);
  assert.equal(result.canceledRunning,1);
  assert.equal(result.requeued,1);

  assert.equal(db.runs.get('direct-expired-q').status,'CANCELED');
  assert.equal(db.runs.get('direct-expired-q').cancelReason,'QUEUE_EXPIRED');
  assert.equal(db.runs.get('direct-requeue').status,'QUEUED');
  assert.equal(db.runs.get('direct-stale-cancel').status,'CANCELED');
  assert.equal(db.runs.get('direct-stale-cancel').cancelReason,'LEASE_EXPIRED');

  assert.equal((await store.getRun({principal:principal(),runId:expiredQueued.runId})).status,'CANCELED');
  assert.ok(staleRequeue.runId);
  assert.ok(staleCancel.runId);
});
