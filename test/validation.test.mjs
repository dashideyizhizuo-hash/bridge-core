import test from 'node:test'; import assert from 'node:assert/strict';
import { validateHostPolicy, validateProjectPolicy, validateRequest } from '../src/validate.mjs';
import { validateAndDefaultParameters, interpolateArgv } from '../src/parameters.mjs';

test('request rejects absolute/path-like authority fields not in schema',()=>{assert.throws(()=>validateRequest({schemaVersion:1,requestId:'request-1234',repository:'a/b',target:{ref:'main',sha:'a'.repeat(40)},policy:{ref:'main',sha:'b'.repeat(40)},capability:'test-cap',parameters:{},path:'/etc'}),e=>e.code==='INVALID_REQUEST');});
test('host policy requires absolute resource root',()=>{assert.throws(()=>validateHostPolicy({version:1,host:{id:'h'},repositories:{'a/b':{runnerClasses:['x'],resources:{r:{root:'relative'}}}}}),e=>e.code==='HOST_POLICY_INVALID');});
test('parameters are typed, bounded and interpolated as argv data',()=>{const p=validateAndDefaultParameters({id:{type:'string',pattern:'^[a-z]+$'},n:{type:'integer',minimum:1,maximum:5,default:2}},{id:'abc'}); assert.deepEqual(p,{id:'abc',n:2}); assert.deepEqual(interpolateArgv(['cmd','{params.id}','{params.n}'],p),['cmd','abc','2']); assert.throws(()=>validateAndDefaultParameters({id:{type:'string'}},{id:'ok',shell:'rm -rf /'}),e=>e.code==='PARAMETER_DENIED');});


test('host policy rejects root execution identities',()=>{
  const base={
    version:1,
    host:{id:'host-main'},
    repositories:{}
  };
  assert.throws(
    ()=>validateHostPolicy({
      ...base,
      directExec:{enabled:true,serviceUser:'root'}
    }),
    error=>error.code==='HOST_POLICY_INVALID'
  );
  assert.throws(
    ()=>validateHostPolicy({
      ...base,
      repositories:{
        'example/project':{
          runnerClasses:['bridge'],
          workspaceExec:{
            enabled:true,
            runnerClass:'bridge',
            serviceUser:'root'
          }
        }
      }
    }),
    error=>error.code==='HOST_POLICY_INVALID'
  );
  assert.throws(
    ()=>validateHostPolicy({
      ...base,
      repositories:{
        'example/project':{
          runnerClasses:['bridge'],
          editing:{
            enabled:true,
            runnerClass:'bridge',
            serviceUser:'root'
          }
        }
      }
    }),
    error=>error.code==='HOST_POLICY_INVALID'
  );
});
