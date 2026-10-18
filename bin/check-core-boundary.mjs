#!/usr/bin/env node
// A release regression gate, not a substitute for reviewing an source-available export.
import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';

const tracked=spawnSync('git',['ls-files','-z'],{encoding:'utf8',windowsHide:true});
if(tracked.status!==0) throw new Error('Core boundary check requires a Git checkout');
const files=tracked.stdout.split('\0').filter(Boolean),violations=[];
for(const file of files) {
  if(/(?:^|\/)(?:test-)?billing(?:[-_.\/]|$)/i.test(file) || /^migrations\/\d+_(?:billing|waffo)/i.test(file)) {
    violations.push({file,reason:'private billing implementation or artifact'});continue;
  }
  if(/(?:^|\/)(?:test-)?commercial(?:[-_.\/]|$)/i.test(file) ||
    /^migrations\/\d+_commercial/i.test(file) || /^wrangler\.commercial(?:[.-]|$)/i.test(file)) {
    violations.push({file,reason:'private commercial implementation or artifact'});continue;
  }
  if(lstatSync(file).isSymbolicLink()) {violations.push({file,reason:'symlink requires explicit export review'});continue;}
  if(/^src\/.*\.[cm]?[jt]sx?$/.test(file)) {
    const source=readFileSync(file,'utf8');
    if(/\b(?:BRIDGE_BILLING_[A-Z_]+|STRIPE_[A-Z_]+|WAFFO_[A-Z_]+)\b|(?:from|import\s*\()\s*['"][^'"]*(?:billing[-.]|commercial\/)/.test(source))
      violations.push({file,reason:'commercial billing/payment runtime dependency'});
  }
  if(file==='package.json') {
    const pkg=JSON.parse(readFileSync(file,'utf8'));
    const dependencies={...pkg.dependencies,...pkg.devDependencies,...pkg.optionalDependencies};
    if(Object.keys(dependencies).some(name=>name==='stripe'||name.startsWith('@stripe/')||name.startsWith('@waffo/')))
      violations.push({file,reason:'payment SDK dependency'});
  }
}
console.log(JSON.stringify({ok:violations.length===0,trackedFiles:files.length,violations}));
if(violations.length)process.exitCode=1;
