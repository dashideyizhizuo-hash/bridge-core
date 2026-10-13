import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import { D1BridgeIdentityStore } from '../src/cloudflare/d1-identity-store.mjs';

const REPO='example/project';
const INSTALLATION_ID=12345;
const NOW=1_800_000_000_000;

function principal(overrides={}) {
  return createBridgePrincipal({
    bridgeUserId:'bridge-user-1',
    externalProvider:'https://identity.example/',
    externalSubject:'subject-1',
    ...overrides
  });
}

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
    this.db.calls.push({kind:'run',sql:this.sql,args:this.args});
    return {success:true,results:[]};
  }
  async first() {
    const call={kind:'first',sql:this.sql,args:this.args};
    this.db.calls.push(call);
    return this.db.firstHandler(call);
  }
  async all() {
    const call={kind:'all',sql:this.sql,args:this.args};
    this.db.calls.push(call);
    return this.db.allHandler ? this.db.allHandler(call) : {success:true,results:[]};
  }
}

class FakeD1 {
  constructor() {
    this.calls=[];
    this.batches=[];
    this.firstHandler=()=>null;
    this.allHandler=null;
    this.batchHandler=null;
  }
  prepare(sql) {
    return new FakeStatement(this,sql);
  }
  async batch(statements) {
    const calls=statements.map(statement=>({
      kind:'batch',
      sql:statement.sql,
      args:statement.args
    }));
    this.batches.push(calls);
    this.calls.push(...calls);
    if(this.batchHandler) return this.batchHandler(calls);
    return calls.map(()=>({success:true,results:[]}));
  }
}

test('D1 migration contains only identity/onboarding authority tables, not execution state',()=>{
  const sql=readFileSync(
    new URL('../migrations/0001_remote_identity.sql',import.meta.url),
    'utf8'
  );
  for(const table of [
    'bridge_users',
    'github_installations',
    'user_installation_grants',
    'repository_grants',
    'github_onboarding_states'
  ]) {
    assert.match(sql,new RegExp('CREATE TABLE IF NOT EXISTS '+table));
  }
  assert.equal(/workflow_runs|bridge_runs|execution_results/i.test(sql),false);
});

test('D1 onboarding state persists principal safely and consumes state transactionally',async()=>{
  const db=new FakeD1();
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
  const activePrincipal=principal();
  const state='s'.repeat(43);
  const row={
    state,
    principal_json:JSON.stringify(activePrincipal),
    code_verifier:'v'.repeat(43),
    code_challenge:'c'.repeat(43),
    installation_id:INSTALLATION_ID,
    created_at:NOW,
    expires_at:NOW+600_000
  };

  await store.put({
    state,
    principal:activePrincipal,
    codeVerifier:'v'.repeat(43),
    codeChallenge:'c'.repeat(43),
    createdAt:NOW,
    expiresAt:NOW+600_000
  });
  assert.ok(db.calls.some(call=>
    call.kind==='run' &&
    call.sql.includes('INSERT INTO github_onboarding_states') &&
    call.args.includes(activePrincipal.bridgeUserId)
  ));

  db.batchHandler=calls=>{
    if(calls[0].sql.startsWith('UPDATE github_onboarding_states')) {
      return [{success:true,results:[]},{success:true,results:[row]}];
    }
    if(calls[0].sql.startsWith('SELECT state, principal_json')) {
      return [{success:true,results:[row]},{success:true,results:[]}];
    }
    throw new Error('unexpected state batch');
  };

  const bound=await store.bindInstallation({
    state,
    installationId:INSTALLATION_ID,
    now:NOW
  });
  assert.equal(bound.installationId,INSTALLATION_ID);
  assert.equal(bound.principal.bridgeUserId,activePrincipal.bridgeUserId);

  const taken=await store.take({state,now:NOW});
  assert.equal(taken.installationId,INSTALLATION_ID);
  assert.equal(taken.codeVerifier,'v'.repeat(43));
  const takeBatch=db.batches.at(-1);
  assert.ok(takeBatch[1].sql.startsWith('DELETE FROM github_onboarding_states'));
});

test('D1 onboarding commit uses one transaction and preserves read/run/publish hierarchy',async()=>{
  const db=new FakeD1();
  db.firstHandler=call=>{
    if(call.sql.includes('FROM bridge_users')) return null;
    throw new Error('unexpected first query');
  };
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});

  await store.commitGitHubOnboarding({
    principal:principal(),
    githubUser:{id:'9001',login:'octocat'},
    installation:{
      installationId:INSTALLATION_ID,
      accountLogin:'example',
      accountId:'777',
      ownerType:'Organization',
      suspendedAt:null
    },
    repositories:[REPO,'example/other'],
    permissions:{read:true,run:true,publish:true}
  });

  assert.equal(db.batches.length,1);
  const statements=db.batches[0];
  assert.ok(statements.some(call=>call.sql.includes('INSERT INTO bridge_users')));
  assert.ok(statements.some(call=>call.sql.includes('INSERT INTO github_installations')));
  assert.ok(statements.some(call=>call.sql.includes('INSERT INTO user_installation_grants')));
  assert.ok(statements.some(call=>call.sql.includes('DELETE FROM repository_grants')));
  const grantInsert=statements.find(call=>call.sql.includes('INSERT INTO repository_grants'));
  assert.ok(grantInsert);
  assert.equal(grantInsert.args.includes(REPO),true);

  const repoIndex=grantInsert.args.indexOf(REPO);
  assert.equal(grantInsert.args[repoIndex+1],1);
  assert.equal(grantInsert.args[repoIndex+2],1);
  assert.equal(grantInsert.args[repoIndex+3],1);
});

test('D1 onboarding rejects invalid read/run/publish hierarchy before persistence',async()=>{
  for(const permissions of [
    {read:false,run:true,publish:false},
    {read:true,run:false,publish:true}
  ]) {
    const db=new FakeD1();
    const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
    await assert.rejects(
      ()=>store.commitGitHubOnboarding({
        principal:principal(),
        githubUser:{id:'9001',login:'octocat'},
        installation:{
          installationId:INSTALLATION_ID,
          accountLogin:'example',
          accountId:'777',
          ownerType:'Organization',
          suspendedAt:null
        },
        repositories:[REPO],
        permissions
      }),
      error=>error.code==='D1_IDENTITY_INVALID'
    );
    assert.equal(db.batches.length,0);
    assert.equal(db.calls.length,0);
  }
});

test('D1 identity store refuses to relink an existing Bridge principal to another external identity',async()=>{
  const db=new FakeD1();
  db.firstHandler=call=>{
    if(call.sql.includes('FROM bridge_users')) {
      return {
        external_provider:'https://other.example/',
        external_subject:'other-subject',
        github_user_id:null
      };
    }
    return null;
  };
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});

  await assert.rejects(
    ()=>store.commitGitHubOnboarding({
      principal:principal(),
      githubUser:{id:'9001',login:'octocat'},
      installation:{
        installationId:INSTALLATION_ID,
        accountLogin:'example',
        accountId:'777',
        ownerType:'Organization',
        suspendedAt:null
      },
      repositories:[REPO],
      permissions:{read:true,run:true,publish:false}
    }),
    error=>error.code==='D1_IDENTITY_DENIED'
  );
  assert.equal(db.batches.length,0);
});

test('D1 store serves principal-scoped repository authorization and installation resolution',async()=>{
  const db=new FakeD1();
  db.firstHandler=call=>{
    if(call.sql.includes('SELECT rg.can_read')) {
      assert.match(call.sql,/rg\.bridge_user_id = \?/);
      assert.deepEqual(call.args,['bridge-user-1',REPO]);
      return {
        can_read:1,
        can_run:1,
        can_publish:0,
        suspended_at:null
      };
    }
    if(call.sql.includes('SELECT rg.installation_id')) {
      return {installation_id:INSTALLATION_ID};
    }
    throw new Error('unexpected query: '+call.sql);
  };
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
  const activePrincipal=principal();

  assert.equal(
    await store.assert({principal:activePrincipal,repository:REPO,permission:'read'}),
    REPO
  );
  assert.equal(
    await store.assert({principal:activePrincipal,repository:REPO,permission:'run'}),
    REPO
  );
  await assert.rejects(
    ()=>store.assert({principal:activePrincipal,repository:REPO,permission:'publish'}),
    error=>error.code==='REPOSITORY_DENIED'
  );

  assert.deepEqual(
    await store.resolve({principal:activePrincipal,repository:REPO}),
    {installationId:INSTALLATION_ID}
  );
});

test('D1 store resolves a persisted Bridge principal by external identity',async()=>{
  const db=new FakeD1();
  db.firstHandler=call=>{
    if(call.sql.includes('FROM bridge_users')) {
      return {
        id:'bridge-user-1',
        external_provider:'https://identity.example/',
        external_subject:'subject-1',
        github_user_id:'9001'
      };
    }
    return null;
  };
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
  const resolved=await store.resolvePrincipal({
    externalProvider:'https://identity.example/',
    externalSubject:'subject-1'
  });
  assert.equal(resolved.bridgeUserId,'bridge-user-1');
  assert.equal(resolved.githubUserId,'9001');
});


test('D1 store creates a Bridge principal on first external OAuth identity',async()=>{
  const db=new FakeD1();
  let lookups=0;
  db.firstHandler=call=>{
    if(call.sql.includes('FROM bridge_users')) {
      lookups++;
      if(lookups===1) return null;
      return {
        id:'bridge-user-fixed-uuid',
        external_provider:'https://identity.example/',
        external_subject:'first-login',
        github_user_id:null
      };
    }
    return null;
  };
  const store=new D1BridgeIdentityStore({
    db,
    clock:()=>NOW,
    randomUUID:()=>'fixed-uuid'
  });

  const created=await store.ensurePrincipal({
    externalProvider:'https://identity.example/',
    externalSubject:'first-login'
  });

  assert.equal(created.bridgeUserId,'bridge-user-fixed-uuid');
  assert.ok(db.calls.some(call=>
    call.kind==='run' &&
    call.sql.includes('INSERT INTO bridge_users') &&
    call.args.includes('bridge-user-fixed-uuid')
  ));
});


test('publish-default migration only promotes existing read+run grants',()=>{
  const sql=readFileSync(
    new URL('../migrations/0003_default_repository_publish.sql',import.meta.url),
    'utf8'
  );
  assert.match(sql,/UPDATE repository_grants/i);
  assert.match(sql,/SET\s+can_publish\s*=\s*1/i);
  assert.match(sql,/updated_at\s*=\s*CAST\(strftime\('%s','now'\) AS INTEGER\)\s*\*\s*1000/i);
  assert.match(sql,/WHERE\s+can_read\s*=\s*1\s+AND\s+can_run\s*=\s*1\s+AND\s+can_publish\s*=\s*0/i);
  assert.equal(/INSERT\s+INTO\s+repository_grants/i.test(sql),false);
  assert.equal(/DELETE\s+FROM\s+repository_grants/i.test(sql),false);
});


test('D1 store resolves the owning Bridge principal by durable id',async()=>{
  const db=new FakeD1();
  db.firstHandler=call=>{
    if(call.sql.includes('WHERE id = ?')) {
      assert.deepEqual(call.args,['bridge-user-1']);
      return {
        id:'bridge-user-1',
        external_provider:'https://identity.example/',
        external_subject:'subject-1',
        github_user_id:'9001'
      };
    }
    return null;
  };
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
  const resolved=await store.resolvePrincipalById('bridge-user-1');
  assert.equal(resolved.bridgeUserId,'bridge-user-1');
  assert.equal(resolved.externalSubject,'subject-1');
  assert.equal(resolved.githubUserId,'9001');
});


test('D1 store resolves a unique Bridge principal by verified GitHub user id',async()=>{
  const db=new FakeD1();
  db.allHandler=call=>{
    assert.ok(call.sql.includes('WHERE github_user_id = ?'));
    assert.deepEqual(call.args,['9001']);
    return {
      success:true,
      results:[{
        id:'bridge-user-1',
        external_provider:'https://github.com/',
        external_subject:'9001',
        github_user_id:'9001'
      }]
    };
  };
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
  const resolved=await store.resolvePrincipalByGitHubUserId('9001');
  assert.equal(resolved.bridgeUserId,'bridge-user-1');
  assert.equal(resolved.githubUserId,'9001');
});

test('D1 store fails closed when one GitHub user maps to multiple Bridge principals',async()=>{
  const db=new FakeD1();
  db.allHandler=()=>({
    success:true,
    results:[
      {id:'a',external_provider:'x',external_subject:'1',github_user_id:'9001'},
      {id:'b',external_provider:'y',external_subject:'2',github_user_id:'9001'}
    ]
  });
  const store=new D1BridgeIdentityStore({db,clock:()=>NOW});
  await assert.rejects(
    ()=>store.resolvePrincipalByGitHubUserId('9001'),
    error=>error.code==='D1_IDENTITY_DENIED'
  );
});


test('Cloudflare publish-grant repair migration only promotes existing read+run grants',()=>{
  const sql=readFileSync(
    new URL('../migrations/0008_restore_cloudflare_publish_grants.sql',import.meta.url),
    'utf8'
  );
  assert.match(sql,/UPDATE repository_grants/i);
  assert.match(sql,/SET\s+can_publish\s*=\s*1/i);
  assert.match(sql,/updated_at\s*=\s*CAST\(strftime\('%s','now'\) AS INTEGER\)\s*\*\s*1000/i);
  assert.match(sql,/WHERE\s+can_read\s*=\s*1\s+AND\s+can_run\s*=\s*1\s+AND\s+can_publish\s*=\s*0/i);
  assert.equal(/INSERT\s+INTO\s+repository_grants/i.test(sql),false);
  assert.equal(/DELETE\s+FROM\s+repository_grants/i.test(sql),false);
});
