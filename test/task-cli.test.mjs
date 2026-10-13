import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertPrivateMode,
  DEFAULT_BASE_URL,
  getConfigPaths,
  initializeConfig,
  main,
  parseTaskKey,
  postControl,
  readAdminToken,
  readConfig,
  runTaskCli,
  validateBaseUrl
} from '../src/task-cli.mjs';

const TASK='example/crypto#26';
const ADMIN='test-admin-token-value-with-more-than-32-characters';
const SHA='a'.repeat(40);
const SESSION_HEADERS={
  'x-bridge-task-key':TASK,
  'x-bridge-task-epoch':'4',
  'x-bridge-task-owner':'worker-test'
};

function createStream() {
  let value='';
  return {
    stream:{write(text) { value+=text; }},
    value:()=>value
  };
}

function makeWorkspace({token=ADMIN,includeToken=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'bridge-task-test-'));
  const paths=getConfigPaths({env:{},homeDir:root});
  if(process.platform==='win32') {
    initializeConfig(paths,{platform:process.platform});
  } else {
    mkdirSync(paths.dir,{recursive:true,mode:0o700});
  }
  writeFileSync(
    paths.configFile,
    JSON.stringify({baseUrl:DEFAULT_BASE_URL},null,2)+'\n',
    {mode:0o600}
  );
  if(includeToken) {
    writeFileSync(paths.tokenFile,token+'\n',{mode:0o600});
  } else if(process.platform==='win32') {
    rmSync(paths.tokenFile);
  }
  if(process.platform!=='win32') {
    chmodSync(paths.dir,0o700);
    chmodSync(paths.configFile,0o600);
    if(includeToken) chmodSync(paths.tokenFile,0o600);
  }
  return {root,paths};
}

function response(payload,status=200) {
  return new Response(JSON.stringify(payload),{
    status,
    headers:{'content-type':'application/json'}
  });
}

function dependencies(paths,fetchImpl,stream,extra={}) {
  return {
    paths,
    fetchImpl,
    stdout:stream.stream,
    stderr:stream.stream,
    platform:process.platform,
    ...extra
  };
}

test('config paths use XDG_CONFIG_HOME or ~/.config',()=>{
  const xdgRoot=join(tmpdir(),'bridge-task-xdg');
  const home=join(tmpdir(),'bridge-task-home');
  assert.deepEqual(
    getConfigPaths({env:{XDG_CONFIG_HOME:xdgRoot},homeDir:home}),
    {
      dir:join(xdgRoot,'bridge-task'),
      configFile:join(xdgRoot,'bridge-task','config.json'),
      tokenFile:join(xdgRoot,'bridge-task','admin-token')
    }
  );
  assert.equal(
    getConfigPaths({env:{},homeDir:home}).dir,
    join(home,'.config','bridge-task')
  );
});

test('config reads the production HTTPS origin and rejects other origins/secrets/paths',t=>{
  const workspace=makeWorkspace({includeToken:false});
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  assert.deepEqual(readConfig(workspace.paths),{baseUrl:DEFAULT_BASE_URL+'/'});
  assert.equal(DEFAULT_BASE_URL,'https://bridge.example.invalid');
  assert.throws(()=>validateBaseUrl('http://example.com'),/HTTPS/);
  assert.throws(()=>validateBaseUrl('https://bridge.example/path'),/without a path/);
  assert.throws(()=>validateBaseUrl('https://bridge.example'),/production origin/);
});

test('config refuses secret fields so token stays in its separate file',t=>{
  const workspace=makeWorkspace({includeToken:false});
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  writeFileSync(
    workspace.paths.configFile,
    JSON.stringify({baseUrl:'https://bridge.example',adminToken:ADMIN})
  );
  assert.throws(
    ()=>readConfig(workspace.paths),
    error=>error.message.includes('only baseUrl') &&
      !error.message.includes(ADMIN)
  );
});

test('admin token reader strips trailing newlines without returning them',t=>{
  const workspace=makeWorkspace({token:ADMIN+'\r\n'});
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  assert.equal(readAdminToken(workspace.paths),ADMIN);
});

test('missing and short admin tokens fail with the local file path',t=>{
  const missing=makeWorkspace({includeToken:false});
  t.after(()=>rmSync(missing.root,{recursive:true,force:true}));
  assert.throws(
    ()=>readAdminToken(missing.paths),
    error=>error.message.includes(missing.paths.tokenFile) &&
      !error.message.includes(ADMIN)
  );

  const short=makeWorkspace({token:'short'});
  t.after(()=>rmSync(short.root,{recursive:true,force:true}));
  assert.throws(
    ()=>readAdminToken(short.paths),
    error=>error.message.includes('at least 32 characters') &&
      error.message.includes(short.paths.tokenFile)
  );
});

test('unsafe POSIX file modes fail closed with a chmod repair command',()=>{
  assert.throws(
    ()=>assertPrivateMode(0o100644,'/home/test/.config/bridge-task/admin-token',0o600,'linux'),
    error=>error.message.includes('chmod 600') &&
      error.message.includes('admin-token')
  );
  assert.doesNotThrow(
    ()=>assertPrivateMode(0o100600,'/home/test/.config/bridge-task/admin-token',0o600,'linux')
  );
});

test('config init creates private config and empty token placeholder; check never prints token',async t=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-task-init-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const paths=getConfigPaths({env:{},homeDir:root});
  const init= createStream();
  await runTaskCli(['config','init'],{
    paths,
    platform:process.platform,
    stdout:init.stream
  });
  assert.equal(JSON.parse(readFileSync(paths.configFile,'utf8')).baseUrl,DEFAULT_BASE_URL);
  assert.equal(readFileSync(paths.tokenFile,'utf8'),'');
  assert.match(init.value(),/Created empty admin token file/);
  writeFileSync(paths.tokenFile,ADMIN+'\n');
  if(process.platform!=='win32') chmodSync(paths.tokenFile,0o600);
  const check=createStream();
  await runTaskCli(['config','check'],{
    paths,
    platform:process.platform,
    stdout:check.stream
  });
  assert.match(check.value(),/Admin token: present; value not shown/);
  assert.doesNotMatch(check.value(),new RegExp(ADMIN));
  assert.equal(existsSync(paths.dir),true);
});

test('Windows token reader rejects an ACL grant to another local account',{
  skip:process.platform!=='win32'
},t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  execFileSync('icacls.exe',[
    workspace.paths.tokenFile,
    '/grant',
    '*S-1-1-0:(R)'
  ],{stdio:'ignore',windowsHide:true});
  assert.throws(
    ()=>readAdminToken(workspace.paths,{platform:'win32'}),
    /Could not verify or secure the Windows ACL/
  );
});

test('task key parses repository and positive issue number locally',()=>{
  assert.deepEqual(parseTaskKey(TASK),{
    taskKey:TASK,
    repository:'example/crypto',
    issueNumber:26
  });
  assert.throws(()=>parseTaskKey('crypto#0'),/owner\/repository/);
  assert.throws(()=>parseTaskKey('owner/repo#9007199254740992'),/safe integer/);
});

test('inspect sends ADMIN_TOKEN only to control with exact action body',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const calls=[];
  const stream=createStream();
  const payload={
    action:'INSPECT',
    task:{
      taskKey:TASK,status:'READY',canonicalBranch:'agent/durable-runtime-t8',
      mode:'continuous',leaseEpoch:0,leaseOwner:null,leaseExpiresAt:null,
      dispatchId:null,dispatchExpiresAt:null,activeRunId:null,
      checkpointSha:SHA,lastTransitionReason:'INITIAL'
    }
  };
  await runTaskCli(['inspect',TASK],dependencies(
    workspace.paths,
    async (url,init)=>{
      calls.push({url,init});
      return response(payload);
    },
    stream
  ));
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,DEFAULT_BASE_URL+'/task-runtime/control');
  assert.equal(calls[0].init.headers.authorization,'Bearer '+ADMIN);
  assert.equal(calls[0].init.redirect,'error');
  assert.deepEqual(JSON.parse(calls[0].init.body),{action:'inspect',taskKey:TASK});
  assert.match(stream.value(),/canonicalBranch: agent\/durable-runtime-t8/);
  assert.match(stream.value(),/checkpointSha: /);
});

test('enroll validates locally and sends parsed repository/issue plus supplied checkpoint',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const calls=[];
  const stream=createStream();
  await runTaskCli([
    'enroll',
    '--task',TASK,
    '--github-user-id','263676473',
    '--branch','agent/durable-runtime-t8',
    '--mode','continuous',
    '--checkpoint',SHA.toUpperCase(),
    '--state-comment-id','5746695902',
    '--json'
  ],dependencies(
    workspace.paths,
    async (_url,init)=>{
      calls.push(init);
      return response({action:'ENROLLED',task:{taskKey:TASK}});
    },
    stream
  ));
  assert.equal(calls[0].headers.authorization,'Bearer '+ADMIN);
  assert.deepEqual(JSON.parse(calls[0].body),{
    action:'enroll',
    task:{
      taskKey:TASK,
      githubUserId:'263676473',
      repository:'example/crypto',
      issueNumber:26,
      canonicalBranch:'agent/durable-runtime-t8',
      mode:'continuous',
      checkpointSha:SHA,
      stateCommentId:5746695902
    }
  });
  assert.throws(()=>parseTaskKey('bad-key'));
});

test('enroll rejects malformed local fields before any HTTP request',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const base=[
    'enroll','--task',TASK,
    '--github-user-id','263676473',
    '--branch','agent/durable-runtime-t8',
    '--mode','continuous',
    '--checkpoint',SHA,
    '--state-comment-id','5746695902'
  ];
  const invalid=[
    ['--task','invalid-key'],
    ['--github-user-id','not-numeric'],
    ['--branch',''],
    ['--mode','automatic'],
    ['--checkpoint','not-a-sha'],
    ['--state-comment-id','0']
  ];
  let calls=0;
  for(const [option,value] of invalid) {
    const args=base.slice();
    args[args.indexOf(option)+1]=value;
    await assert.rejects(()=>runTaskCli(args,dependencies(
      workspace.paths,
      async ()=>{ calls++; return response({action:'unexpected'}); },
      createStream()
    )));
  }
  assert.equal(calls,0);
});

test('JSON output redacts ADMIN_TOKEN from response values and keys',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const stream=createStream();
  const payload={
    action:'INSPECT',
    task:{taskKey:TASK,status:'READY'},
    diagnostic:ADMIN,
    [ADMIN]:'unexpected reflected field'
  };
  await runTaskCli(['inspect',TASK,'--json'],dependencies(
    workspace.paths,
    async ()=>response(payload),
    stream
  ));
  assert.doesNotMatch(stream.value(),new RegExp(ADMIN));
});

test('tick always sets launch false and displays dispatch/noop fields',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const calls=[];
  const stream=createStream();
  await runTaskCli(['tick',TASK],dependencies(
    workspace.paths,
    async (_url,init)=>{
      calls.push(init);
      return response({
        action:'TICK',
        decision:{
          taskKey:TASK,status:'DISPATCHING',action:'DISPATCH',
          dispatchId:'dispatch-one',dispatchExpiresAt:'2030-01-01T00:00:00.000Z'
        },
        launch:null
      });
    },
    stream
  ));
  assert.equal(calls[0].headers.authorization,'Bearer '+ADMIN);
  assert.deepEqual(JSON.parse(calls[0].body),{action:'tick',taskKey:TASK,launch:false});
  assert.match(stream.value(),/decision: DISPATCH/);
  assert.match(stream.value(),/dispatchId: dispatch-one/);
  assert.match(stream.value(),/dispatchExpiresAt: 2030/);
});


test('tick reports a NOOP reason without activation',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const calls=[];
  const stream=createStream();
  await runTaskCli(['tick',TASK],dependencies(
    workspace.paths,
    async (_url,init)=>{
      calls.push(init);
      return response({
        action:'TICK',
        decision:{action:'NOOP',reason:'ACTIVE_DISPATCH'},
        launch:null
      });
    },
    stream
  ));
  assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(calls[0].body),{action:'tick',taskKey:TASK,launch:false});
  assert.match(stream.value(),/decision: NOOP/);
  assert.match(stream.value(),/reason: ACTIVE_DISPATCH/);
});

test('unknown command errors do not echo argument values',async()=>{
  await assert.rejects(
    ()=>runTaskCli([ADMIN]),
    error=>!error.message.includes(ADMIN)
  );
});
test('activate sends exact body without ADMIN_TOKEN and does not print unexpected credentials',async t=>{
  const workspace=makeWorkspace({includeToken:false});
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const calls=[];
  const stream=createStream();
  await runTaskCli(['activate',TASK,'dispatch-one','--json'],dependencies(
    workspace.paths,
    async (_url,init)=>{
      calls.push(init);
      return response({
        status:'ACTIVATED',
        taskKey:TASK,
        workerId:'worker-one',
        leaseEpoch:4,
        leaseExpiresAt:'2030-01-01T00:15:00.000Z',
        canonicalBranch:'agent/durable-runtime-t8',
        mode:'continuous',
        taskSessionToken:'bts_'+('A'.repeat(43)),
        mcpSession:{headers:SESSION_HEADERS},
        oauthBearerToken:'must-not-print'
      });
    },
    stream
  ));
  assert.equal(calls.length,1);
  assert.equal(calls[0].headers.authorization,undefined);
  assert.deepEqual(JSON.parse(calls[0].body),{taskKey:TASK,dispatchId:'dispatch-one'});
  assert.deepEqual(JSON.parse(stream.value()).mcpSession.headers,SESSION_HEADERS);
  assert.equal(JSON.parse(stream.value()).taskSessionToken,undefined);
  assert.doesNotMatch(stream.value(),/oauthBearerToken|must-not-print|Bearer |bts_/);
});

test('HTTP errors include status/code/message while redacting ADMIN_TOKEN from message and stack',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const stream=createStream();
  await assert.rejects(
    ()=>runTaskCli(['inspect',TASK],dependencies(
      workspace.paths,
      async ()=>response({
        error:{code:'TASK_CONTROL_UNAUTHORIZED',message:'rejected token '+ADMIN}
      },401),
      stream
    )),
    error=>error.message.includes('HTTP 401') &&
      error.message.includes('TASK_CONTROL_UNAUTHORIZED') &&
      error.message.includes('[REDACTED]') &&
      !error.message.includes(ADMIN) &&
      !error.stack.includes(ADMIN)
  );
});

test('control refuses to send ADMIN_TOKEN to any non-production host',async()=>{
  let called=false;
  assert.throws(
    ()=>postControl({
      config:{baseUrl:'https://untrusted.example/'},
      adminToken:ADMIN,
      body:{action:'inspect',taskKey:TASK},
      fetchImpl:async()=>{called=true;return response({});}
    }),
    /production origin/
  );
  assert.equal(called,false);
});

test('response byte limit cancels an oversized stream while reading',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  let cancelled=false;
  const body=new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024*1024+1));
    },
    cancel() { cancelled=true; }
  });
  await assert.rejects(
    ()=>runTaskCli(['inspect',TASK],dependencies(
      workspace.paths,
      async()=>new Response(body),
      createStream()
    )),
    /1 MiB size limit/
  );
  assert.equal(cancelled,true);
});

test('human output escapes terminal controls from Bridge data and errors',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const output=createStream();
  await runTaskCli(['inspect',TASK],dependencies(
    workspace.paths,
    async()=>response({taskKey:TASK,status:'ACTIVE\u001b[2J\nforged'}),
    output
  ));
  assert.doesNotMatch(output.value(),/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(output.value(),/ACTIVE\\u001b\[2J\\u000aforged/);

  const errorOutput=createStream();
  const status=await main(['inspect',TASK],dependencies(
    workspace.paths,
    async()=>response({
      error:{code:'BAD\u001b[2J',message:'failure\u001b[31m\nnext'}
    },502),
    errorOutput
  ));
  assert.equal(status,1);
  assert.doesNotMatch(errorOutput.value(),/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(errorOutput.value(),/\\u001b\[2J/);
});

test('activate rejects dispatch IDs outside the server contract before network access',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  let calls=0;
  const fetchImpl=async()=>{calls++;return response({});};
  for(const dispatchId of ['x','dispatch/invalid']) {
    await assert.rejects(
      ()=>runTaskCli(['activate',TASK,dispatchId],dependencies(
        workspace.paths,fetchImpl,createStream()
      )),
      /dispatchId must be 8-256 characters/
    );
  }
  assert.equal(calls,0);
});

test('start dispatches with launch=false then activates; NOOP never activates',async t=>{
  const workspace=makeWorkspace();
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const dispatchCalls=[];
  const dispatchStream=createStream();
  await runTaskCli(['start',TASK],dependencies(
    workspace.paths,
    async (url,init)=>{
      dispatchCalls.push({url,init});
      if(url.endsWith('/task-runtime/control')) {
        return response({
          action:'TICK',
          decision:{action:'DISPATCH',dispatchId:'dispatch-two',dispatchExpiresAt:'2030-01-01'}
        });
      }
      return response({
        status:'ACTIVATED',taskKey:TASK,workerId:'worker-two',
        leaseEpoch:5,leaseExpiresAt:'2030-01-02',
        canonicalBranch:'agent/durable-runtime-t8',mode:'continuous',
        taskSessionToken:'bts_'+('B'.repeat(43)),
        mcpSession:{headers:SESSION_HEADERS}
      });
    },
    dispatchStream
  ));
  assert.equal(dispatchCalls.length,2);
  assert.deepEqual(JSON.parse(dispatchCalls[0].init.body),{
    action:'tick',taskKey:TASK,launch:false
  });
  assert.equal(dispatchCalls[0].init.headers.authorization,'Bearer '+ADMIN);
  assert.deepEqual(JSON.parse(dispatchCalls[1].init.body),{
    taskKey:TASK,dispatchId:'dispatch-two'
  });
  assert.equal(dispatchCalls[1].init.headers.authorization,undefined);

  const noopCalls=[];
  const noopStream=createStream();
  await runTaskCli(['start',TASK],dependencies(
    workspace.paths,
    async (url,init)=>{
      noopCalls.push({url,init});
      return response({
        action:'TICK',
        decision:{action:'NOOP',reason:'ACTIVE_DISPATCH'}
      });
    },
    noopStream
  ));
  assert.equal(noopCalls.length,1);
  assert.match(noopStream.value(),/No activation was performed/);
});


test('activate exposes taskSessionToken only with explicit --show-session-token',async t=>{
  const workspace=makeWorkspace({includeToken:false});
  t.after(()=>rmSync(workspace.root,{recursive:true,force:true}));
  const stream=createStream();
  await runTaskCli(
    ['activate',TASK,'dispatch-one','--json','--show-session-token'],
    dependencies(
      workspace.paths,
      async()=>response({
        status:'ACTIVATED',
        taskKey:TASK,
        workerId:'worker-one',
        leaseEpoch:4,
        leaseExpiresAt:'2030-01-01T00:15:00.000Z',
        canonicalBranch:'agent/durable-runtime-t8',
        mode:'continuous',
        taskSessionToken:'bts_'+('C'.repeat(43)),
        mcpSession:{headers:SESSION_HEADERS}
      }),
      stream
    )
  );
  const payload=JSON.parse(stream.value());
  assert.equal(payload.taskSessionToken,'bts_'+('C'.repeat(43)));
});
