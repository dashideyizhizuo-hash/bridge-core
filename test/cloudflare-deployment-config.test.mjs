import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Wrangler config uses one Worker with auto-provisioned D1/KV and required compatibility flags',()=>{
  const config=JSON.parse(
    readFileSync(
      new URL('../wrangler.jsonc',import.meta.url),
      'utf8'
    )
  );

  assert.equal(config.name,'bridge-control-plane');
  assert.equal(config.main,'src/cloudflare/worker-entry.mjs');
  assert.equal(config.keep_vars,true);
  assert.ok(config.compatibility_date>='2026-08-04');
  assert.ok(config.compatibility_flags.includes('nodejs_compat'));
  assert.ok(
    config.compatibility_flags.includes('global_fetch_strictly_public')
  );

  assert.deepEqual(
    config.kv_namespaces,
    [{binding:'OAUTH_KV'}]
  );
  assert.equal(config.d1_databases.length,1);
  assert.equal(config.d1_databases[0].binding,'DB');
  assert.equal(config.d1_databases[0].database_name,'bridge-auth');
  assert.equal(config.d1_databases[0].migrations_dir,'migrations');
  assert.deepEqual(
    config.r2_buckets,
    [{binding:'DIRECT_ASSETS',bucket_name:'bridge-direct-assets'}]
  );
  assert.deepEqual(config.triggers?.crons,['*/5 * * * *']);

  const serialized=JSON.stringify(config);
  assert.equal(serialized.includes('PRIVATE_KEY'),false);
  assert.equal(serialized.includes('CLIENT_SECRET'),false);
  assert.equal(serialized.includes('TASK_RUNTIME_ADMIN_TOKEN'),false);
  assert.equal(serialized.includes('TASK_LAUNCHER_TOKEN'),false);
  assert.equal(serialized.includes('database_id'),false);
  assert.equal(serialized.includes('namespace_id'),false);
  assert.equal(serialized.includes('jurisdiction'),false);
});
