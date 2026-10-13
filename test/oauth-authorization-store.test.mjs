import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1McpAuthorizationStore } from '../src/cloudflare/oauth-authorization-store.mjs';

const NOW=1_800_000_000_000;
const INSTALLATION_ID=12345;

class FakeStatement {
  constructor(db,sql,args=[]) {
    this.db=db;
    this.sql=sql.replace(/\s+/g,' ').trim();
    this.args=args;
  }
  bind(...args) {
    return new FakeStatement(this.db,this.sql,args);
  }
  async run() {
    const call={kind:'run',sql:this.sql,args:this.args};
    this.db.calls.push(call);
    return this.db.runHandler(call);
  }
  async all() {
    const call={kind:'all',sql:this.sql,args:this.args};
    this.db.calls.push(call);
    return this.db.allHandler(call);
  }
}

class FakeD1 {
  constructor() {
    this.calls=[];
    this.runHandler=()=>({success:true,meta:{changes:0},results:[]});
    this.allHandler=()=>({success:true,results:[]});
    this.batchHandler=()=>[];
  }
  prepare(sql) {
    return new FakeStatement(this,sql);
  }
  async batch(statements) {
    const call={kind:'batch',statements};
    this.calls.push(call);
    return this.batchHandler(call);
  }
}

function oauthRequest() {
  return {
    responseType:'code',
    clientId:'https://chatgpt.example/oauth-client.json',
    redirectUri:'https://chatgpt.example/callback',
    scope:['bridge'],
    state:'chatgpt-state',
    codeChallenge:'chatgpt-challenge',
    codeChallengeMethod:'S256',
    resource:'https://bridge.example/mcp',
    issuer:'https://bridge.example'
  };
}

function storedRow(state) {
  return {
    state,
    oauth_request_json:JSON.stringify(oauthRequest()),
    client_name:'ChatGPT',
    code_verifier:'v'.repeat(43),
    code_challenge:'c'.repeat(43),
    installation_id:INSTALLATION_ID,
    consented:1,
    created_at:NOW,
    expires_at:NOW+600_000
  };
}

test('OAuth authorization migration stores only bounded transient browser flow state',()=>{
  const sql=readFileSync(
    new URL('../migrations/0002_mcp_authorization.sql',import.meta.url),
    'utf8'
  );
  assert.match(sql,/CREATE TABLE IF NOT EXISTS mcp_authorization_states/);
  for(const field of [
    'oauth_request_json',
    'code_verifier',
    'code_challenge',
    'installation_id',
    'expires_at'
  ]) {
    assert.match(sql,new RegExp(field));
  }
  assert.equal(/access_token|refresh_token|github_token|private_key/i.test(sql),false);
});

test('D1 authorization state persists validated OAuth request and GitHub PKCE data',async()=>{
  const db=new FakeD1();
  const store=new D1McpAuthorizationStore({db,clock:()=>NOW});
  const state='s'.repeat(43);

  await store.put({
    state,
    oauthRequest:oauthRequest(),
    clientName:'ChatGPT',
    codeVerifier:'v'.repeat(43),
    codeChallenge:'c'.repeat(43),
    createdAt:NOW,
    expiresAt:NOW+600_000
  });

  assert.equal(db.calls.length,1);
  const insert=db.calls[0];
  assert.equal(insert.kind,'run');
  assert.match(insert.sql,/INSERT INTO mcp_authorization_states/);
  assert.equal(insert.args[0],state);
  assert.equal(JSON.parse(insert.args[1]).resource,'https://bridge.example/mcp');
  assert.equal(insert.args[2],'ChatGPT');
  assert.equal(insert.args.includes('v'.repeat(43)),true);
});

test('D1 authorization state uses transactional batches because D1 write results are empty',async()=>{
  const db=new FakeD1();
  const store=new D1McpAuthorizationStore({db,clock:()=>NOW});
  const state='s'.repeat(43);
  const row=storedRow(state);

  let batchNumber=0;
  db.batchHandler=call=>{
    batchNumber+=1;
    const statements=call.statements;
    assert.equal(statements.length,2);

    if(batchNumber===1) {
      assert.match(statements[0].sql,/^UPDATE mcp_authorization_states/);
      assert.equal(/RETURNING/i.test(statements[0].sql),false);
      assert.match(statements[1].sql,/^SELECT state, oauth_request_json/);
      return [
        {success:true,meta:{changes:1},results:[]},
        {success:true,meta:{changes:0},results:[row]}
      ];
    }

    assert.match(statements[0].sql,/^SELECT state, oauth_request_json/);
    assert.match(statements[1].sql,/^DELETE FROM mcp_authorization_states/);
    assert.equal(/RETURNING/i.test(statements[1].sql),false);
    return [
      {success:true,meta:{changes:0},results:[row]},
      {success:true,meta:{changes:1},results:[]}
    ];
  };

  const bound=await store.bindInstallation({
    state,
    installationId:INSTALLATION_ID,
    now:NOW
  });
  assert.equal(bound.installationId,INSTALLATION_ID);
  assert.equal(bound.consented,true);
  assert.equal(
    bound.oauthRequest.clientId,
    'https://chatgpt.example/oauth-client.json'
  );

  const taken=await store.take({state,now:NOW});
  assert.equal(taken.installationId,INSTALLATION_ID);
  assert.equal(taken.codeVerifier,'v'.repeat(43));

  const batches=db.calls.filter(call=>call.kind==='batch');
  assert.equal(batches.length,2);
  assert.equal(
    batches.some(call=>call.statements.some(stmt=>/RETURNING/i.test(stmt.sql))),
    false
  );
});

test('D1 authorization store returns null when transactional transition changes no row',async()=>{
  const db=new FakeD1();
  const store=new D1McpAuthorizationStore({db,clock:()=>NOW});

  let batchNumber=0;
  db.batchHandler=()=>{
    batchNumber+=1;
    if(batchNumber===1) {
      return [
        {success:true,meta:{changes:0},results:[]},
        {success:true,meta:{changes:0},results:[]}
      ];
    }
    return [
      {success:true,meta:{changes:0},results:[]},
      {success:true,meta:{changes:0},results:[]}
    ];
  };

  assert.equal(
    await store.bindInstallation({
      state:'s'.repeat(43),
      installationId:INSTALLATION_ID,
      now:NOW
    }),
    null
  );
  assert.equal(
    await store.take({state:'t'.repeat(43),now:NOW}),
    null
  );
});

test('OAuth authorization store prunes abandoned expired states',async()=>{
  const db=new FakeD1();
  const store=new D1McpAuthorizationStore({db,clock:()=>NOW});
  db.allHandler=call=>{
    assert.match(call.sql,/^DELETE FROM mcp_authorization_states/);
    assert.deepEqual(call.args,[NOW,100]);
    return {
      success:true,
      results:[{state:'a'.repeat(43)},{state:'b'.repeat(43)}]
    };
  };
  assert.deepEqual(await store.pruneExpired(),{removed:2});
});
