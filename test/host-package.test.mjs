import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, readdirSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOST_PACKAGE_NAME, HOST_VERSION, HOST_PACKAGE_FILES, HOST_SDK_VERSION, DEFAULT_HOST_ENDPOINT } from '../src/host-package-spec.mjs';

test('public Host package is independently runnable and excludes operator tooling',()=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-host-package-'));
  try {
    const built=spawnSync(process.execPath,[resolve('bin/package-host.mjs'),'--output',root],{encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    const summary=JSON.parse(built.stdout);assert.equal(summary.package,HOST_PACKAGE_NAME);
    const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
    assert.equal(manifest.name,'@dashideyizhizuo/bridge-host');
    assert.equal(DEFAULT_HOST_ENDPOINT,'https://bridge.example.invalid/mcp');
    assert.equal(manifest.license,'Elastic-2.0');
    assert.match(readFileSync(join(root,'LICENSE'),'utf8'),/^Elastic License 2.0/);
    assert.equal(manifest.private,undefined);assert.equal(manifest.version,HOST_VERSION);
    assert.deepEqual(manifest.dependencies,{'@modelcontextprotocol/client':HOST_SDK_VERSION});
    assert.equal(manifest.scripts,undefined);assert.equal(manifest.engines.node,'>=22');
    assert.deepEqual(Object.keys(manifest.bin),['bridge-host']);
    const files=readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile())
      .map(x=>join(x.parentPath,x.name).slice(root.length+1).replaceAll('\\','/')).sort();
    assert.deepEqual(files,[...HOST_PACKAGE_FILES,'README.md','package.json'].sort());
    for(const args of [['--help'],['--version']]) {
      const result=spawnSync(process.execPath,[join(root,'bin/bridge-host.mjs'),...args],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      if(args[0]==='--help')assert.ok(result.stdout.includes(`npx ${HOST_PACKAGE_NAME}@${HOST_VERSION}`));
      else assert.equal(result.stdout.trim(),HOST_VERSION);
    }
    const readme=readFileSync(join(root,'README.md'),'utf8');
    assert.match(readme,/self-deployment/i);assert.match(readme,/Node\.js 22/);
    assert.ok(readme.includes(`${HOST_PACKAGE_NAME}@${HOST_VERSION}`));
    assert.ok(readme.includes('dashideyizhizuo-bridge-host-'+HOST_VERSION+'.tgz'));
  } finally {rmSync(root,{recursive:true,force:true});}
});
