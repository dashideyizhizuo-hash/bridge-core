import test from 'node:test';
import assert from 'node:assert/strict';
import {redactResourceText,redactResourceValue} from '../src/redaction.mjs';

const root=String.raw`C:\Synthetic\资料 [test]\data`;
const resources=[{name:'data',root}];
const marker='<bridge-resource:data>';

test('redacts raw Windows roots and JSON.stringify encoded roots without regex interpretation',()=>{
  assert.equal(redactResourceText('path='+root,resources),'path='+marker);
  const text=JSON.stringify({root,nested:root+String.raw`\结果.txt`,other:String.raw`C:\Unrelated\data`});
  assert.deepEqual(JSON.parse(redactResourceText(text,resources)),{
    root:marker,nested:marker+String.raw`\结果.txt`,other:String.raw`C:\Unrelated\data`
  });
  assert.equal(redactResourceText('ordinary [test] text; C:\\Unrelated\\data',resources),
    'ordinary [test] text; C:\\Unrelated\\data');
});

test('longest resource root wins for raw and JSON report text',()=>{
  const child=root+String.raw`\private`;
  const mapping=[{name:'parent',root},{name:'child',root:child}];
  assert.equal(redactResourceText(child+' then '+root,mapping),'<bridge-resource:child> then <bridge-resource:parent>');
  assert.deepEqual(JSON.parse(redactResourceText(JSON.stringify({parent:root,child:child+String.raw`\file.txt`}),mapping)),{
    parent:'<bridge-resource:parent>',child:String.raw`<bridge-resource:child>\file.txt`
  });
});

test('POSIX roots, JSON quote escapes and structured-value redaction remain usable',()=>{
  const path='/synthetic/with "quotes"/data';
  assert.equal(JSON.parse(redactResourceText(JSON.stringify({root:path}),[{name:'quoted',root:path}])).root,
    '<bridge-resource:quoted>');
  assert.deepEqual(redactResourceValue({values:[root,'safe',19]},resources),{values:[marker,'safe',19]});
  assert.equal(redactResourceText('/synthetic/data/file', [{name:'posix',root:'/synthetic/data/'}]),
    '<bridge-resource:posix>/file');
});
