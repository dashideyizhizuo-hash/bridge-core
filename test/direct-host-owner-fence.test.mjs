import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';

const principal=bridgeUserId=>({bridgeUserId,externalProvider:'test',externalSubject:bridgeUserId});
function fixture(t) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec("PRAGMA foreign_keys=ON; CREATE TABLE bridge_users(id TEXT PRIMARY KEY); INSERT INTO bridge_users VALUES('user-a'),('user-b')");
  for(const file of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql','0039_direct_run_progress.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const db={
    prepare(query) {
      return {bind(...args) {
        return {async run() {
          const result=sql.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}};
        }};
      }};
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}
      catch(error){sql.exec('ROLLBACK');throw error;}
    }
  };
  for(const [host,user,token] of [['host-a','user-a','a'],['host-b','user-b','b']])
    sql.prepare('INSERT INTO direct_hosts(host_id,bridge_user_id,runner_token_sha256,created_at,updated_at) VALUES(?,?,?,?,?)').run(host,user,token.repeat(64),1,1);
  for(const [id,host,user,state] of [['queue-b','host-b','user-b','QUEUED'],['running-b','host-b','user-b','RUNNING'],['done-b','host-b','user-b','SUCCEEDED'],['running-a','host-a','user-a','RUNNING']])
    sql.prepare("INSERT INTO direct_runs(request_id,run_id,bridge_user_id,host_id,request_json,status,lease_owner,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,5000,1,1)").run(id,'dx1:'+host+':'+id,user,host,'{}',state,state==='RUNNING'?'fixture-owner':null);
  return {sql,store:new D1DirectExecStore({db,clock:()=>1000}),snapshot:()=>({hosts:sql.prepare('SELECT * FROM direct_hosts ORDER BY host_id').all(),runs:sql.prepare('SELECT * FROM direct_runs ORDER BY request_id').all()})};
}

test('foreign owner cannot disable a host or cancel its queued/running work despite a DENIED response',async t=>{
  const f=fixture(t),before=f.snapshot();
  for(const enabled of [false,true]) {
    await assert.rejects(f.store.setHostEnabled({principal:principal('user-a'),hostId:'host-b',enabled}),{code:'DIRECT_HOST_DENIED'});
    assert.deepEqual(f.snapshot(),before,'denial must have no committed side effects');
  }
  await assert.rejects(f.store.setHostEnabled({principal:principal('user-a'),hostId:'host-missing',enabled:false}),{code:'DIRECT_HOST_DENIED'});
  assert.deepEqual(f.snapshot(),before);
});

test('owner disable cancels only owned active work; repeats and re-enable preserve terminal history',async t=>{
  const f=fixture(t),before=f.snapshot();
  assert.deepEqual(await f.store.setHostEnabled({principal:principal('user-b'),hostId:'host-b',enabled:false}),{hostId:'host-b',enabled:false});
  for(const id of ['queue-b','running-b']) {
    const row=f.sql.prepare('SELECT * FROM direct_runs WHERE request_id=?').get(id);
    assert.equal(row.status,'CANCELED');assert.equal(row.cancel_reason,'HOST_DISABLED');
    assert.equal(row.lease_owner,null);assert.equal(row.lease_expires_at,null);assert.equal(row.completed_at,1000);
  }
  for(const id of ['running-a','done-b'])
    assert.deepEqual(f.sql.prepare('SELECT * FROM direct_runs WHERE request_id=?').get(id),before.runs.find(row=>row.request_id===id));
  const canceled=f.snapshot().runs;
  await f.store.setHostEnabled({principal:principal('user-b'),hostId:'host-b',enabled:false});
  await f.store.setHostEnabled({principal:principal('user-b'),hostId:'host-b',enabled:true});
  assert.deepEqual(f.snapshot().runs,canceled);
  assert.equal(f.sql.prepare("SELECT enabled FROM direct_hosts WHERE host_id='host-b'").get().enabled,1);
});
