import test from 'node:test';
import assert from 'node:assert/strict';
import { D1TaskSessionStore } from '../src/cloudflare/d1-task-session-store.mjs';

const TASK='example/project#61';
const TOKEN='bts_'+('A'.repeat(43));

function memoryDb() {
  const rows=new Map();
  const tasks=new Map();
  const writes=[];
  const db={
    rows,
    tasks,
    writes,
    prepare(sql) {
      const statement={
        sql:sql.replace(/\s+/g,' ').trim(),
        args:[],
        bind(...values) {
          statement.args=values;
          return statement;
        },
        async run() {
          if(sql.includes('INSERT INTO agent_task_sessions')) {
            const [tokenHash,taskKey,workerId,leaseEpoch,expiresAt,createdAt]=statement.args;
            assert.equal(typeof tokenHash,'string');
            assert.equal(tokenHash.length,64);
            assert.equal(tokenHash.includes(TOKEN),false);
            rows.set(tokenHash,{
              token_hash:tokenHash,
              task_key:taskKey,
              worker_id:workerId,
              lease_epoch:leaseEpoch,
              expires_at:expiresAt,
              created_at:createdAt
            });
            writes.push([...statement.args]);
            return {success:true};
          }
          if(statement.sql.includes('task-session:renew-token')) {
            const [expiry,tokenHash,taskKey,workerId,leaseEpoch,now,key,owner,epoch]=statement.args;
            const row=rows.get(tokenHash);
            const task=tasks.get(key);
            const current=
              row && row.task_key===taskKey && row.worker_id===workerId &&
              row.lease_epoch===leaseEpoch && row.expires_at>now &&
              task && task.lease_owner===owner && task.lease_epoch===epoch &&
              ['RECOVERING','RUNNING'].includes(task.status) && task.lease_expires_at>now;
            if(current) row.expires_at=expiry;
            return {success:true,meta:{changes:current ? 1 : 0}};
          }
          throw new Error('unexpected run SQL');
        },
        async all() {
          if(statement.sql.startsWith('DELETE FROM agent_task_sessions')) {
            const [now,limit]=statement.args;
            const expired=[...rows.values()]
              .filter(row=>row.expires_at<=now)
              .sort((a,b)=>a.expires_at.localeCompare(b.expires_at))
              .slice(0,limit);
            for(const row of expired) rows.delete(row.token_hash);
            return {
              success:true,
              results:expired.map(row=>({token_hash:row.token_hash}))
            };
          }
          throw new Error('unexpected all SQL');
        },
        async first() {
          if(statement.sql.includes('task-session:renew-lease')) {
            const [expiry,updatedAt,taskKey,workerId,leaseEpoch,now,tokenHash,key,owner,epoch,tokenExpiry]=statement.args;
            const task=tasks.get(taskKey);
            const row=rows.get(tokenHash);
            if(
              !task || task.lease_owner!==workerId || task.lease_epoch!==leaseEpoch ||
              !['RECOVERING','RUNNING'].includes(task.status) || task.lease_expires_at<=now ||
              !row || row.task_key!==key || row.worker_id!==owner ||
              row.lease_epoch!==epoch || row.expires_at!==tokenExpiry
            ) return null;
            task.lease_expires_at=expiry;
            task.last_transition_reason='TASK_SESSION_ACTIVITY';
            task.updated_at=updatedAt;
            return {
              task_key:taskKey,
              worker_id:workerId,
              lease_epoch:leaseEpoch,
              expires_at:expiry
            };
          }
          if(sql.includes('FROM agent_task_sessions')) {
            return rows.get(statement.args[0]) ?? null;
          }
          throw new Error('unexpected first SQL');
        }
      };
      return statement;
    },
    async batch(statements) {
      const first=await statements[0].run();
      const second=await statements[1].first();
      return [first,{success:true,results:second ? [second] : []}];
    }
  };
  return db;
}

test('task session store persists only a hash and resolves the opaque capability',async()=>{
  const db=memoryDb();
  const clock=()=>Date.parse('2026-09-20T05:00:00.000Z');
  const store=new D1TaskSessionStore({
    db,
    clock,
    tokenGenerator:()=>TOKEN
  });

  const issued=await store.issue({
    taskKey:TASK,
    workerId:'worker-12345678',
    leaseEpoch:7,
    expiresAt:'2026-09-20T05:15:00.000Z'
  });
  assert.equal(issued,TOKEN);
  assert.equal(db.writes.length,1);
  assert.equal(JSON.stringify(db.writes).includes(TOKEN),false);

  const resolved=await store.resolve(TOKEN);
  assert.deepEqual(resolved,{
    taskKey:TASK,
    workerId:'worker-12345678',
    leaseEpoch:7,
    expiresAt:'2026-09-20T05:15:00.000Z'
  });
});

test('random and expired task session capabilities fail closed',async()=>{
  const db=memoryDb();
  let now=Date.parse('2026-09-20T05:00:00.000Z');
  const store=new D1TaskSessionStore({
    db,
    clock:()=>now,
    tokenGenerator:()=>TOKEN
  });

  await store.issue({
    taskKey:TASK,
    workerId:'worker-12345678',
    leaseEpoch:7,
    expiresAt:'2026-09-20T05:15:00.000Z'
  });

  await assert.rejects(
    ()=>store.resolve('bts_'+('B'.repeat(43))),
    error=>error.code==='TASK_SESSION_INVALID'
  );

  now=Date.parse('2026-09-20T05:16:00.000Z');
  await assert.rejects(
    ()=>store.resolve(TOKEN),
    error=>error.code==='TASK_LEASE_STALE'
  );
});

test('task session renewal extends only a still-live matching capability',async()=>{
  const db=memoryDb();
  let now=Date.parse('2026-09-20T05:00:00.000Z');
  const store=new D1TaskSessionStore({
    db,clock:()=>now,tokenGenerator:()=>TOKEN,leaseTtlMs:30*60*1000
  });
  await store.issue({
    taskKey:TASK,workerId:'worker-12345678',leaseEpoch:7,
    expiresAt:'2026-09-20T05:15:00.000Z'
  });
  db.tasks.set(TASK,{
    lease_owner:'worker-12345678',
    lease_epoch:7,
    status:'RUNNING',
    lease_expires_at:'2026-09-20T05:15:00.000Z'
  });

  const renewed=await store.renewSession({
    token:TOKEN,taskKey:TASK,workerId:'worker-12345678',leaseEpoch:7
  });
  assert.equal(renewed.expiresAt,'2026-09-20T05:30:00.000Z');
  assert.equal(db.tasks.get(TASK).lease_expires_at,renewed.expiresAt);
  assert.equal((await store.resolve(TOKEN)).expiresAt,renewed.expiresAt);

  now=Date.parse('2026-09-20T05:31:00.000Z');
  await assert.rejects(
    ()=>store.renewSession({
      token:TOKEN,taskKey:TASK,workerId:'worker-12345678',leaseEpoch:7
    }),
    error=>error.code==='TASK_LEASE_STALE'
  );
  assert.equal(db.tasks.get(TASK).lease_expires_at,'2026-09-20T05:30:00.000Z');
});


test('expired task-session capability rows are pruned',async()=>{
  const db=memoryDb();
  let now=Date.parse('2026-09-20T05:00:00.000Z');
  const store=new D1TaskSessionStore({
    db,
    clock:()=>now,
    tokenGenerator:()=>TOKEN
  });
  await store.issue({
    taskKey:TASK,
    workerId:'worker-12345678',
    leaseEpoch:7,
    expiresAt:'2026-09-20T05:15:00.000Z'
  });
  assert.equal(db.rows.size,1);
  now=Date.parse('2026-09-20T05:16:00.000Z');
  assert.deepEqual(await store.pruneExpired(),{removed:1});
  assert.equal(db.rows.size,0);
});
