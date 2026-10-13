import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

test('operator task origin is explicit and remains pinned against token redirection',()=>{
  const source=`import {validateBaseUrl} from './src/task-cli.mjs';
    if(validateBaseUrl('https://owned.example')!=='https://owned.example/')process.exit(1);
    for(const url of ['https://other.example','http://owned.example','https://u:p@owned.example']){
      let denied=false;try{validateBaseUrl(url)}catch{denied=true}if(!denied)process.exit(2);
    }`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,BRIDGE_TASK_ORIGIN:'https://owned.example'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
test('plugin packaging requires an actual operator App binding',()=>{
  const result=spawnSync(process.execPath,['bin/package-plugin.mjs'],{env:{...process.env,BRIDGE_APP_ID:''},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Set BRIDGE_APP_ID/);
  assert.deepEqual(JSON.parse(readFileSync('.app.json','utf8')),{apps:{}});
});
