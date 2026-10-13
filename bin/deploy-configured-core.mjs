#!/usr/bin/env node
// Deployment authority comes from the operator's private build configuration
// and Cloudflare credential, never from a request or a target repository.
import {openSync,closeSync,writeFileSync,unlinkSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBridge,BridgeError} from '../src/errors.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const CONFIG_KEYS=['$schema','name','account_id','main','compatibility_date','compatibility_flags',
  'keep_vars','workers_dev','observability','triggers','kv_namespaces','d1_databases','r2_buckets','vars','routes'];
const HEX_ID=/^[0-9a-f]{32}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const invalid=condition=>assertBridge(condition,'CONFIGURED_CORE_INVALID','Invalid operated core deployment configuration');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function keys(value,allowed) {
  invalid(object(value)&&Object.keys(value).every(key=>allowed.includes(key)));
}
function resource(value,allowed,binding) {
  invalid(Array.isArray(value)&&value.length===1);
  keys(value[0],allowed);invalid(value[0].binding===binding);
  return value[0];
}

export function validateConfiguredCore(rawConfig) {
  invalid(typeof rawConfig==='string'&&rawConfig.length>0&&rawConfig.length<=5000);
  let config;
  try {config=JSON.parse(rawConfig);}catch {invalid(false);}
  keys(config,CONFIG_KEYS);
  invalid(typeof config.name==='string'&&NAME.test(config.name)&&
    typeof config.account_id==='string'&&HEX_ID.test(config.account_id));
  invalid(config.main==='src/cloudflare/worker-entry.mjs'&&config.keep_vars===true);
  invalid(typeof config.compatibility_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date));
  const date=new Date(config.compatibility_date);
  invalid(Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===config.compatibility_date&&config.compatibility_date>='2026-08-04');
  invalid(Array.isArray(config.compatibility_flags)&&config.compatibility_flags.length===2&&
    new Set(config.compatibility_flags).size===2&&
    config.compatibility_flags.includes('nodejs_compat')&&config.compatibility_flags.includes('global_fetch_strictly_public'));
  const db=resource(config.d1_databases,['binding','database_name','database_id','migrations_dir'],'DB');
  invalid(typeof db.database_name==='string'&&NAME.test(db.database_name)&&
    typeof db.database_id==='string'&&UUID.test(db.database_id)&&db.migrations_dir==='migrations');
  const kv=resource(config.kv_namespaces,['binding','id'],'OAUTH_KV');
  invalid(typeof kv.id==='string'&&HEX_ID.test(kv.id));
  const r2=resource(config.r2_buckets,['binding','bucket_name'],'DIRECT_ASSETS');
  invalid(typeof r2.bucket_name==='string'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r2.bucket_name));
  if(config.$schema!==undefined)invalid(typeof config.$schema==='string'&&config.$schema.length<=256);
  if(config.workers_dev!==undefined)invalid(typeof config.workers_dev==='boolean');
  if(config.vars!==undefined) {
    invalid(object(config.vars));
    for(const [name,value]of Object.entries(config.vars)) {
      invalid(/^[A-Z][A-Z0-9_]{0,127}$/.test(name)&&!/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL|AUTHORIZATION|ACCESS_KEY)/i.test(name));
      invalid(typeof value==='string'&&value.length<=5000&&
        !/-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:github_pat_|gh[pousr]_|sk_live_|sk_test_)/i.test(value));
    }
  }
  if(config.routes!==undefined) {
    invalid(Array.isArray(config.routes)&&config.routes.length<=8);
    for(const route of config.routes) {
      keys(route,['pattern','custom_domain']);
      invalid(typeof route.pattern==='string'&&route.pattern.length<=253&&
        /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(route.pattern)&&route.custom_domain===true);
    }
  }
  if(config.triggers!==undefined) {
    keys(config.triggers,['crons']);
    invalid(Array.isArray(config.triggers.crons)&&config.triggers.crons.length<=5&&
      config.triggers.crons.every(cron=>typeof cron==='string'&&/^[-*/?,0-9A-Za-z ]{1,128}$/.test(cron)));
  }
  if(config.observability!==undefined) {
    keys(config.observability,['enabled','head_sampling_rate','logs','traces']);
    for(const [name,value]of Object.entries(config.observability)) {
      if(name==='logs'||name==='traces') {
        keys(value,['enabled','head_sampling_rate','invocation_logs','persist','redact_query_string']);
        for(const [key,item]of Object.entries(value))invalid(key==='head_sampling_rate'?
          typeof item==='number'&&item>=0&&item<=1:typeof item==='boolean');
      }else invalid(name==='head_sampling_rate'?
        typeof value==='number'&&value>=0&&value<=1:typeof value==='boolean');
    }
  }
  return config;
}

export function deployConfiguredCore({rawConfig=process.env.BRIDGE_DEPLOY_CONFIG,root=ROOT,
  check=false,migrate=false,run=spawnSync,env=process.env}={}) {
  const config=validateConfiguredCore(rawConfig);
  const outcome={checked:true,worker:config.name,deployed:false,migrated:false};
  if(check)return outcome;
  const directory=realpathSync(root),path=join(directory,`.bridge-core-deploy-${randomUUID()}.json`);
  const childEnv={...env};delete childEnv.BRIDGE_DEPLOY_CONFIG;
  let owned=false;
  try {
    const fd=openSync(path,'wx',0o600);owned=true;
    try {writeFileSync(fd,JSON.stringify(config)+'\n','utf8');}finally {closeSync(fd);}
    const invoke=args=>{
      let result;
      try {
        result=run(process.execPath,[join(directory,'node_modules','wrangler','bin','wrangler.js'),...args,'--config',path],
          {cwd:directory,env:childEnv,stdio:'inherit',windowsHide:true,shell:false});
      }catch {throw new BridgeError('CONFIGURED_CORE_DEPLOY_FAILED','Configured core deployment command failed');}
      assertBridge(result?.status===0&&!result.error&&!result.signal,
        'CONFIGURED_CORE_DEPLOY_FAILED','Configured core deployment command failed');
    };
    if(migrate) {invoke(['d1','migrations','apply','DB','--remote']);outcome.migrated=true;}
    invoke(['deploy']);outcome.deployed=true;
    return outcome;
  }finally {
    if(owned) {
      try {unlinkSync(path);}catch(error) {
        if(error.code!=='ENOENT')throw new BridgeError('CONFIGURED_CORE_CLEANUP_FAILED','Could not remove temporary core deployment configuration');
      }
    }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    assertBridge(args.every(arg=>['--check','--migrate'].includes(arg))&&new Set(args).size===args.length,
      'CONFIGURED_CORE_USAGE','Usage: deploy-configured-core.mjs [--check] [--migrate]');
    console.log(JSON.stringify(deployConfiguredCore({check:args.includes('--check'),migrate:args.includes('--migrate')})));
  }catch(error) {
    console.error(JSON.stringify({code:error instanceof BridgeError?error.code:'CONFIGURED_CORE_DEPLOY_FAILED',
      message:error instanceof BridgeError?error.message:'Configured core deployment failed'}));
    process.exitCode=1;
  }
}
