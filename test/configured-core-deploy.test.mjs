import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {deployConfiguredCore,validateConfiguredCore} from '../bin/deploy-configured-core.mjs';

const config=()=>({
  name:'test-core',account_id:'0'.repeat(32),main:'src/cloudflare/worker-entry.mjs',
  compatibility_date:'2026-09-19',compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],
  keep_vars:true,workers_dev:false,
  d1_databases:[{binding:'DB',database_name:'test-core-db',database_id:'11111111-1111-4111-8111-111111111111',migrations_dir:'migrations'}],
  kv_namespaces:[{binding:'OAUTH_KV',id:'1'.repeat(32)}],
  r2_buckets:[{binding:'DIRECT_ASSETS',bucket_name:'test-core-assets'}],
  vars:{BRIDGE_PUBLIC_URL:'https://test.example.invalid/mcp'},
  routes:[{pattern:'test.example.invalid',custom_domain:true}],
  observability:{enabled:true},triggers:{crons:['*/5 * * * *']}
});
function temporaryRoot(t) {
  const root=makeTestDirectory(join(tmpdir(),'bridge-configured-core-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}

test('configured core rejects malformed JSON without echoing its contents',()=>{
  for(const raw of [undefined,'','[]','null','{"PRIVATE_KEY":"do-not-expose"',JSON.stringify({password:'do-not-expose'})]) {
    assert.throws(()=>validateConfiguredCore(raw),error=>{
      assert.equal(error.code,'CONFIGURED_CORE_INVALID');
      assert.equal(String(error).includes('do-not-expose'),false);
      return true;
    });
  }
});

test('configured core rejects source, migration, resource and secret configuration overrides',()=>{
  const mutations=[
    value=>{value.main='src/commercial/worker-entry.mjs';},
    value=>{value.main='/some/absolute/entry.mjs';},
    value=>{value.build={command:'unexpected build hook'};},
    value=>{value.env={production:{main:'other.mjs'}};},
    value=>{value.rules=[{type:'ESModule',globs:['other/**']}];},
    value=>{value.keep_vars=false;},
    value=>{delete value.keep_vars;},
    value=>{delete value.name;},
    value=>{value.name=['test-core'];},
    value=>{value.account_id='not-an-account';},
    value=>{value.account_id=['0'.repeat(32)];},
    value=>{value.compatibility_flags=['nodejs_compat'];},
    value=>{value.compatibility_date='2026-02-30';},
    value=>{value.d1_databases[0].migrations_dir='../commercial/migrations';},
    value=>{value.d1_databases[0].migrations_dir='/absolute/migrations';},
    value=>{value.d1_databases[0].migrations_table='another_table';},
    value=>{value.d1_databases[0].database_id='missing-id';},
    value=>{value.d1_databases[0].database_id=[value.d1_databases[0].database_id];},
    value=>{delete value.d1_databases[0].database_id;},
    value=>{delete value.d1_databases[0].database_name;},
    value=>{value.d1_databases.push({...value.d1_databases[0],binding:'OTHER_DB'});},
    value=>{value.d1_databases[0].binding='OTHER_DB';},
    value=>{value.kv_namespaces[0].id='invalid-kv-id';},
    value=>{value.kv_namespaces[0].id=['1'.repeat(32)];},
    value=>{delete value.kv_namespaces[0].id;},
    value=>{value.kv_namespaces[0].binding='OTHER_KV';},
    value=>{value.r2_buckets[0].bucket_name='../different-bucket';},
    value=>{value.r2_buckets[0].binding='OTHER_ASSETS';},
    value=>{value.vars.CLIENT_SECRET='do-not-expose';},
    value=>{value.vars.SAFE_NAME='-----BEGIN PRIVATE KEY-----\ndo-not-expose';},
    value=>{value.vars.SAFE_NAME='github_pat_do-not-expose';},
    value=>{value.routes[0].pattern='https://test.example.invalid/mcp';}
  ];
  for(const mutate of mutations) {
    const value=config();mutate(value);
    assert.throws(()=>validateConfiguredCore(JSON.stringify(value)),error=>{
      assert.equal(error.code,'CONFIGURED_CORE_INVALID');
      assert.equal(String(error).includes('do-not-expose'),false);
      return true;
    });
  }
});

test('check-only validates without creating a file or calling a runner',t=>{
  const root=temporaryRoot(t);
  const outcome=deployConfiguredCore({rawConfig:JSON.stringify(config()),root,check:true,migrate:true,
    run:()=>assert.fail('check-only must not spawn')});
  assert.deepEqual(outcome,{checked:true,worker:'test-core',deployed:false,migrated:false});
  assert.deepEqual(readdirSync(root),[]);
});

test('invalid input fails before creating a file or calling a runner',t=>{
  const root=temporaryRoot(t),value=config();value.vars.API_TOKEN='do-not-expose';
  assert.throws(()=>deployConfiguredCore({rawConfig:JSON.stringify(value),root,
    run:()=>assert.fail('invalid configuration must not spawn')}),{code:'CONFIGURED_CORE_INVALID'});
  assert.deepEqual(readdirSync(root),[]);
});

test('deployment invokes Node/Wrangler with argv and an ephemeral root configuration',t=>{
  const root=temporaryRoot(t),calls=[],paths=[];
  const run=(program,args,options)=>{
    const path=args.at(-1);paths.push(path);
    assert.equal(program,process.execPath);
    assert.equal(args[0],join(root,'node_modules','wrangler','bin','wrangler.js'));
    assert.deepEqual(args.slice(1,-1),['deploy','--config']);
    assert.equal(options.cwd,root);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
    assert.equal(options.env.BRIDGE_DEPLOY_CONFIG,undefined);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN,'test-only-provider-credential');
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),config());
    assert.equal(join(root,path.split(/[\\/]/).at(-1)),path);
    calls.push(args);return {status:0};
  };
  for(let i=0;i<2;i++) assert.deepEqual(deployConfiguredCore({rawConfig:JSON.stringify(config()),root,run,
    env:{BRIDGE_DEPLOY_CONFIG:'must-not-reach-child',CLOUDFLARE_API_TOKEN:'test-only-provider-credential'}}),
  {checked:true,worker:'test-core',deployed:true,migrated:false});
  assert.equal(calls.length,2);assert.notEqual(paths[0],paths[1]);
  for(const path of paths)assert.equal(existsSync(path),false);
  assert.deepEqual(readdirSync(root),[]);
});

test('explicit migration uses the same core configuration before deployment',t=>{
  const root=temporaryRoot(t),calls=[];
  const outcome=deployConfiguredCore({rawConfig:JSON.stringify(config()),root,migrate:true,
    run:(_program,args)=>{assert.ok(existsSync(args.at(-1)));calls.push(args);return {status:0};}});
  assert.equal(outcome.migrated,true);assert.equal(outcome.deployed,true);
  assert.deepEqual(calls[0].slice(1,-1),['d1','migrations','apply','DB','--remote','--config']);
  assert.deepEqual(calls[1].slice(1,-1),['deploy','--config']);
  assert.equal(calls[0].at(-1),calls[1].at(-1));
  assert.equal(existsSync(calls[0].at(-1)),false);
});

test('migration failure prevents deployment and removes the temporary configuration',t=>{
  const root=temporaryRoot(t),calls=[];
  assert.throws(()=>deployConfiguredCore({rawConfig:JSON.stringify(config()),root,migrate:true,
    run:(_program,args)=>{calls.push(args);return {status:7};}}),{code:'CONFIGURED_CORE_DEPLOY_FAILED'});
  assert.equal(calls.length,1);assert.equal(existsSync(calls[0].at(-1)),false);
  assert.deepEqual(readdirSync(root),[]);
});

test('deployment failure and thrown runner errors clean up without leaking diagnostics',t=>{
  for(const failure of [()=>({status:1}),()=>({status:null,error:new Error('do-not-expose')}),
    ()=>{throw new Error('do-not-expose');}]) {
    const root=temporaryRoot(t);
    assert.throws(()=>deployConfiguredCore({rawConfig:JSON.stringify(config()),root,run:failure}),error=>{
      assert.equal(error.code,'CONFIGURED_CORE_DEPLOY_FAILED');
      assert.equal(String(error).includes('do-not-expose'),false);return true;
    });
    assert.deepEqual(readdirSync(root),[]);
  }
});

test('CLI check-only succeeds from another working directory without temporary configuration',t=>{
  const root=temporaryRoot(t);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/deploy-configured-core.mjs',import.meta.url)),'--check'],
    {cwd:root,env:{...process.env,BRIDGE_DEPLOY_CONFIG:JSON.stringify(config())},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{checked:true,worker:'test-core',deployed:false,migrated:false});
  assert.deepEqual(readdirSync(root),[]);
});

test('CLI reports invalid JSON and arguments without printing private input',t=>{
  const root=temporaryRoot(t),script=fileURLToPath(new URL('../bin/deploy-configured-core.mjs',import.meta.url));
  for(const args of [['--check'],['--do-not-expose']]) {
    const result=spawnSync(process.execPath,[script,...args],
      {cwd:root,env:{...process.env,BRIDGE_DEPLOY_CONFIG:'{"secret":"do-not-expose"'},encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);assert.equal((result.stdout+result.stderr).includes('do-not-expose'),false);
    assert.ok(['CONFIGURED_CORE_INVALID','CONFIGURED_CORE_USAGE'].includes(JSON.parse(result.stderr).code));
    assert.deepEqual(readdirSync(root),[]);
  }
});
