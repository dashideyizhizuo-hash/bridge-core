import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBridgeMcpHandler} from '../src/mcp-server.mjs';

function assertConcreteSchema(schema,path='inputSchema'){
  if(schema.$ref)return; // Local file definitions are supported by the published OpenAI contract.
  assert.equal(typeof schema.type,'string',`${path} needs an explicit resolver type`);
  if(schema.type==='array'){
    assert.ok(schema.items&&typeof schema.items==='object',`${path} needs a resolvable items schema`);
    assertConcreteSchema(schema.items,path+'.items');
  }
  for(const [key,value] of Object.entries(schema.properties??{}))assertConcreteSchema(value,path+'.'+key);
  for(const [key,value] of Object.entries(schema.$defs??{}))assertConcreteSchema(value,path+'.$defs.'+key);
}

test('SDK wire tool definitions have concrete input types and array items before file metadata resolution',async t=>{
  const deny=async()=>{throw Error('Schema discovery must not invoke tools');};
  const handler=createBridgeMcpHandler({gateway:{discover:deny,run:deny,getRun:deny,getResult:deny,publish:deny}});
  const client=new Client({name:'bridge-schema-contract',version:'1'});
  t.after(async()=>{await client.close();await handler.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL('https://schema.example/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));
  const {tools}=await client.listTools();
  for(const tool of tools)assertConcreteSchema(tool.inputSchema,tool.name);
  const run=tools.find(tool=>tool.name==='bridge.import_file');assert.deepEqual(run._meta['openai/fileParams'],['file']);
  const file=run.inputSchema.properties.file;
  const resolved=file.$ref?file.$ref.slice(2).split('/').reduce((value,key)=>value?.[key],run.inputSchema):file;
  assert.equal(resolved.type,'object');assert.equal(resolved.additionalProperties,false);
  assert.deepEqual(Object.keys(resolved.properties).sort(),['download_url','file_id','file_name','mime_type']);
  assert.deepEqual([...resolved.required].sort(),['download_url','file_id']);
  for(const value of Object.values(resolved.properties))assert.equal(value.type,'string');
  assert.deepEqual(run.inputSchema.required,['file'],'only file import declares a native file parameter');
});
