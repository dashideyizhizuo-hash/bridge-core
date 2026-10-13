import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/doctor.mjs';

test('doctor validates repository resource subpaths',()=>{const root=mkdtempSync(join(tmpdir(),'bridge-doctor-'));try{const data=join(root,'data');for(const p of ['catalog','raw','results'])mkdirSync(join(data,p),{recursive:true});const policy={version:1,host:{id:'h'},repositories:{'a/b':{runnerClasses:['r'],resources:{data:{root:data,read:['catalog/**','raw/**'],write:['results/**']}}}}};const path=join(root,'host.json');writeFileSync(path,JSON.stringify(policy));const result=doctor({hostPolicyPath:path,repository:'a/b'});assert.equal(result.ok,true);assert.ok(result.findings.some(x=>x.code==='RESOURCE_WRITE_OK'));}finally{rmSync(root,{recursive:true,force:true});}});

test('doctor fails missing declared subpath',()=>{const root=mkdtempSync(join(tmpdir(),'bridge-doctor-'));try{const data=join(root,'data');mkdirSync(data);const policy={version:1,host:{id:'h'},repositories:{'a/b':{runnerClasses:['r'],resources:{data:{root:data,read:['missing/**']}}}}};const path=join(root,'host.json');writeFileSync(path,JSON.stringify(policy));const result=doctor({hostPolicyPath:path,repository:'a/b'});assert.equal(result.ok,false);assert.ok(result.findings.some(x=>x.code==='RESOURCE_PATH_MISSING'));}finally{rmSync(root,{recursive:true,force:true});}});


test('workspace-exec doctor fails when a denied root is readable by the sandbox user',()=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-doctor-'));
  try {
    const denied=join(root,'privileged-data');
    mkdirSync(denied);
    const policy={
      version:1,
      host:{id:'h'},
      repositories:{
        'a/b':{
          runnerClasses:['bridge-sandbox'],
          workspaceExec:{
            enabled:true,
            runnerClass:'bridge-sandbox',
            serviceUser:userInfo().username,
            deniedRoots:[denied]
          }
        }
      }
    };
    const path=join(root,'host.json');
    writeFileSync(path,JSON.stringify(policy));
    const result=doctor({hostPolicyPath:path,repository:'a/b'});
    assert.equal(result.ok,false);
    assert.ok(result.findings.some(x=>x.code==='WORKSPACE_EXEC_DENIED_ROOT_READABLE'));
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
