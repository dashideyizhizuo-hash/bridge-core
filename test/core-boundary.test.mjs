import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
const script=resolve('bin/check-core-boundary.mjs');
test('public core gate accepts deployable core and rejects private payment artifacts',t=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-core-boundary-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  const add=(path,text)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);git('add',path);};
  const check=()=>spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8'});
  git('init','-q');add('src/core.mjs','export const core=true;');add('package.json','{"private":true}');
  assert.equal(check().status,0);
  add('src/cloudflare/billing-store.mjs','export const ledger=true;');
  const privateResult=check();assert.equal(privateResult.status,1);assert.match(privateResult.stdout,/private billing/);
  git('rm','-f','src/cloudflare/billing-store.mjs');
  add('src/core.mjs',"export const enabled=env.STRIPE_SECRET_KEY;");
  assert.equal(check().status,1);
  add('src/core.mjs','export const core=true;');add('package.json','{"dependencies":{"stripe":"1.0.0"}}');
  assert.equal(check().status,1);
  add('package.json','{"private":true}');
  for(const path of ['src/commercial/auth.mjs','test/commercial-auth.test.mjs',
    'migrations/0023_commercial_accounts.sql','wrangler.commercial.jsonc','docs/COMMERCIAL_PORTAL.md']) {
    add(path,'no payment dependency here');
    const result=check();assert.equal(result.status,1,path);assert.match(result.stdout,/private commercial/);
    git('rm','-f',path);assert.equal(check().status,0,path);
  }
  add('src/core.mjs',"export {login} from './commercial/auth.mjs';");
  assert.equal(check().status,1);
  add('src/core.mjs','export const core=true;');
  // A maintained authentication library is not inherently commercial code.
  add('package.json','{"dependencies":{"better-auth":"1.7.7"}}');
  assert.equal(check().status,0);
});
