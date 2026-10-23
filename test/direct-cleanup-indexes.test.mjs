import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';
import {D1DirectAssetStore} from '../src/cloudflare/d1-direct-asset-store.mjs';

test('actual bounded cleanup SQL uses maintenance indexes without temporary sorting',async t=>{
  const native=new DatabaseSync(':memory:');t.after(()=>native.close());
  native.exec('CREATE TABLE bridge_users(id TEXT PRIMARY KEY)');
  for(const file of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql','0039_direct_run_progress.sql','0011_direct_assets.sql',
    '0012_persistent_direct_assets.sql','0021_direct_asset_object_retirements.sql','0022_direct_cleanup_indexes.sql']){
    native.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
  // Reapplication is harmless; no production data or retention semantics change.
  native.exec(readFileSync(new URL('../migrations/0022_direct_cleanup_indexes.sql',import.meta.url),'utf8'));
  const plans=[];
  const db={batch:async()=>[],prepare(sql){return {bind(...args){return {
    async all(){plans.push(native.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail));return {results:[]};}
  };}}}};
  const runs=new D1DirectExecStore({db}),assets=new D1DirectAssetStore({db});
  await runs.pruneTerminal();await runs.reconcileExpired();
  await assets.listRetiredObjects();
  const expected=['direct_runs_terminal_gc','direct_runs_queued_gc','direct_runs_running_gc',
    'direct_runs_running_gc','direct_asset_retirements_gc'];
  assert.equal(plans.length,expected.length);
  for(let index=0;index<plans.length;index++){
    const plan=plans[index].join('\n');
    assert.ok(plan.includes(expected[index]),`${expected[index]} must serve production SQL: ${plan}`);
    assert.doesNotMatch(plan,/USE TEMP B-TREE/,plan);
    assert.doesNotMatch(plan,/SCAN (direct_runs|direct_assets)(?:$|\n)/,plan);
  }
});
