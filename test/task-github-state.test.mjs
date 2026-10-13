import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DURABLE_TASK_STATE_MARKERS,
  GitHubDurableTaskState,
  parseDurableTaskState,
  upsertDurableTaskState
} from '../src/task-github-state.mjs';

const REPO='example/project';
const TASK=`${REPO}#45`;
const BRANCH='agent/task-45';
const A='a'.repeat(40);
const B='b'.repeat(40);
const C='c'.repeat(40);
const D='d'.repeat(40);

function state(overrides={}) {
  return {
    schemaVersion:1,
    taskKey:TASK,
    mode:'continuous',
    status:'READY',
    canonicalBranch:BRANCH,
    checkpoint:{stage:'S1',sha:A,commentId:10},
    nextStage:'S2',
    continuation:'same-worker',
    pullRequest:99,
    updatedAt:'2026-09-20T00:00:00.000Z',
    ...overrides
  };
}

function issueBody(value=state()) {
  return upsertDurableTaskState('Human-owned issue context.\n',value);
}

function checkpointBody({
  stage='S1',
  sha=A,
  nextStage='S2',
  canonicalBranch=BRANCH,
  status,
  continuation
}={}) {
  const payload={
    schemaVersion:1,
    taskKey:TASK,
    canonicalBranch,
    stage,
    sha,
    runId:'gh1:example/project:request:'+C,
    nextStage,
    pullRequest:99,
    summary:'focused verification passed',
    ...(status===undefined ? {} : {status}),
    ...(continuation===undefined ? {} : {continuation})
  };
  return `${DURABLE_TASK_STATE_MARKERS.checkpoint}
\`\`\`json
${JSON.stringify(payload,null,2)}
\`\`\``;
}

class FakeGitHub {
  constructor(handler) {
    this.handler=handler;
    this.calls=[];
  }
  async request(method,path,options={}) {
    const call={method,path,body:options.body};
    this.calls.push(call);
    return this.handler(call,this);
  }
}

test('managed durable state round-trips without replacing human Issue content',()=>{
  const original='Intro written by a human.\n\nAcceptance criteria stay here.\n';
  const first=upsertDurableTaskState(original,state());
  assert.match(first,/Intro written by a human/);
  assert.match(first,/Acceptance criteria stay here/);
  assert.equal(parseDurableTaskState(first,{expectedTaskKey:TASK}).checkpoint.sha,A);

  const second=upsertDurableTaskState(first,state({
    status:'BLOCKED',
    nextStage:null,
    continuation:null,
    updatedAt:'2026-09-20T01:00:00.000Z'
  }));
  assert.equal(second.split(DURABLE_TASK_STATE_MARKERS.stateStart).length-1,1);
  assert.equal(parseDurableTaskState(second).status,'BLOCKED');
});

test('recovery adopts already-pushed linear work after crash instead of recreating it',async()=>{
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45`) {
      return {number:45,body:issueBody()};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45/comments?per_page=100&page=1`) {
      return [{id:10,created_at:'2026-09-20T00:00:00.000Z',body:checkpointBody()}];
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`) {
      return {sha:D};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/compare/${A}...${D}`) {
      return {
        status:'ahead',
        ahead_by:3,
        merge_base_commit:{sha:A},
        commits:[
          {sha:B,commit:{message:'stage work part 1'}},
          {sha:C,commit:{message:'stage work part 2'}},
          {sha:D,commit:{message:'verified pushed candidate'}}
        ],
        files:[
          {filename:'src/a.mjs',status:'modified',additions:3,deletions:1},
          {filename:'test/a.test.mjs',status:'modified',additions:5,deletions:0}
        ]
      };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});
  const recovered=await durable.recover(TASK);

  assert.equal(recovered.recovery,'ADVANCED');
  assert.equal(recovered.checkpoint.sha,A);
  assert.equal(recovered.headSha,D);
  assert.deepEqual(recovered.commits.map(item=>item.sha),[B,C,D]);
  assert.equal(github.calls.some(call=>call.path.includes('/git/refs')),false);
  assert.equal(github.calls.some(call=>call.method!=='GET'),false);
});

test('recovery hard-stops when canonical HEAD diverges from the checkpoint ancestry',async()=>{
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45`) {
      return {body:issueBody()};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45/comments?per_page=100&page=1`) {
      return [{id:10,body:checkpointBody()}];
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`) {
      return {sha:D};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/compare/${A}...${D}`) {
      return {
        status:'diverged',
        ahead_by:1,
        merge_base_commit:{sha:B},
        commits:[{sha:D,commit:{message:'unexpected'}}],
        files:[]
      };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});
  await assert.rejects(
    ()=>durable.recover(TASK),
    error=>error.code==='TASK_RECOVERY_DIVERGED'
  );
});

test('checkpoint helper verifies exact branch HEAD, appends journal comment, then advances state pointer',async()=>{
  let patchedBody=null;
  let postedComment=null;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45`) {
      return {number:45,body:issueBody()};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`) {
      return {sha:D};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/issues/45/comments`) {
      postedComment=call.body.body;
      return {id:11,body:postedComment};
    }
    if(call.method==='PATCH' && call.path===`/repos/${REPO}/issues/45`) {
      patchedBody=call.body.body;
      return {number:45,body:patchedBody};
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({
    github,
    clock:()=>Date.parse('2026-09-20T02:00:00.000Z')
  });
  const result=await durable.checkpoint({
    taskKey:TASK,
    stage:'S2',
    sha:D,
    runId:'gh1:example/project:request:'+D,
    summary:'tests and focused verification passed',
    nextStage:'S3',
    status:'READY'
  });

  assert.equal(result.checkpoint.commentId,11);
  assert.equal(result.checkpoint.status,'READY');
  assert.match(postedComment,/bridge-stage-checkpoint:v1/);
  const parsed=parseDurableTaskState(patchedBody,{expectedTaskKey:TASK});
  assert.deepEqual(parsed.checkpoint,{stage:'S2',sha:D,commentId:11});
  assert.equal(parsed.nextStage,'S3');
  assert.equal(parsed.continuation,null);
  assert.equal(parsed.updatedAt,'2026-09-20T02:00:00.000Z');
  assert.equal(github.calls.some(call=>call.path.includes('/git/refs')),false);
});

test('checkpoint verifier dereferences the exact comment, current HEAD and forward ancestry',async()=>{
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/comments/11`) {
      return {
        id:11,
        body:checkpointBody({
          stage:'S2',
          sha:D,
          nextStage:'S3',
          status:'READY',
          continuation:'handoff'
        })
      };
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/comments/12`) {
      return null;
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/comments/13`) {
      return {
        id:13,
        body:checkpointBody({
          stage:'S2',
          sha:D,
          nextStage:'S3',
          continuation:'handoff'
        })
      };
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`) {
      return {sha:D};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/compare/${A}...${D}`) {
      return {
        status:'ahead',
        ahead_by:1,
        merge_base_commit:{sha:A},
        commits:[{sha:D,commit:{message:'S2'}}],
        files:[]
      };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});
  const verified=await durable.verifyCheckpoint({
    taskKey:TASK,
    canonicalBranch:BRANCH,
    checkpoint:{stage:'S2',sha:D,commentId:11},
    previousCheckpointSha:A,
    previousStateCommentId:10,
    expectedStatus:'READY',
    expectedNextStage:'S3',
    expectedContinuation:'handoff',
    requireStatus:true
  });
  assert.equal(verified.commentId,11);
  assert.equal(verified.status,'READY');

  await assert.rejects(
    ()=>durable.verifyCheckpoint({
      taskKey:TASK,
      canonicalBranch:BRANCH,
      checkpoint:{stage:'S2',sha:D,commentId:11},
      previousCheckpointSha:A,
      previousStateCommentId:10,
      expectedStatus:'READY',
      expectedNextStage:'S3',
      expectedContinuation:'same-worker',
      requireStatus:true
    }),
    error=>error.code==='TASK_CHECKPOINT_INVALID'
  );
  await assert.rejects(
    ()=>durable.verifyCheckpoint({
      taskKey:TASK,
      canonicalBranch:BRANCH,
      checkpoint:{stage:'S2',sha:D,commentId:11},
      previousCheckpointSha:A,
      previousStateCommentId:10,
      expectedStatus:'READY',
      expectedNextStage:'DIFFERENT_STAGE',
      expectedContinuation:'handoff',
      requireStatus:true
    }),
    error=>error.code==='TASK_CHECKPOINT_INVALID'
  );
  await assert.rejects(
    ()=>durable.verifyCheckpoint({
      taskKey:TASK,
      canonicalBranch:BRANCH,
      checkpoint:{stage:'S2',sha:D,commentId:13},
      previousCheckpointSha:A,
      previousStateCommentId:10,
      expectedStatus:'READY',
      expectedNextStage:'S3',
      expectedContinuation:'handoff',
      requireStatus:true
    }),
    error=>error.code==='TASK_CHECKPOINT_INVALID'
  );

  await assert.rejects(
    ()=>durable.verifyCheckpoint({
      taskKey:TASK,
      canonicalBranch:BRANCH,
      checkpoint:{stage:'wrong stage',sha:D,commentId:11},
      previousCheckpointSha:A,
      previousStateCommentId:10,
      expectedStatus:'READY'
    }),
    error=>error.code==='TASK_CHECKPOINT_INVALID'
  );
  await assert.rejects(
    ()=>durable.verifyCheckpoint({
      taskKey:TASK,
      canonicalBranch:BRANCH,
      checkpoint:{stage:'S2',sha:D,commentId:12},
      previousCheckpointSha:A,
      previousStateCommentId:10,
      expectedStatus:'READY'
    }),
    error=>error.code==='TASK_CHECKPOINT_INVALID'
  );

  await assert.rejects(
    ()=>durable.verifyCheckpoint({
      taskKey:TASK,
      canonicalBranch:BRANCH,
      checkpoint:{stage:'S1',sha:A,commentId:10},
      previousCheckpointSha:D,
      previousStateCommentId:11,
      expectedStatus:'READY'
    }),
    error=>error.code==='TASK_RECOVERY_DIVERGED'
  );
});

test('checkpoint helper refuses a stale SHA before writing any durable comment',async()=>{
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45`) {
      return {body:issueBody()};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`) {
      return {sha:D};
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});

  await assert.rejects(
    ()=>durable.checkpoint({
      taskKey:TASK,
      stage:'S2',
      sha:C,
      nextStage:'S3'
    }),
    error=>error.code==='TASK_CHECKPOINT_STALE'
  );
  assert.equal(github.calls.some(call=>call.method==='POST' || call.method==='PATCH'),false);
});

test('latest machine checkpoint comment can recover a pointer update interrupted after comment creation',async()=>{
  const body=issueBody(state({
    checkpoint:{stage:'S1',sha:A,commentId:10},
    nextStage:'S2'
  }));
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45`) {
      return {body};
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45/comments?per_page=100&page=1`) {
      return [
        {id:10,body:checkpointBody()},
        {id:11,body:checkpointBody({stage:'S2',sha:D,nextStage:'S3',status:'READY'})}
      ];
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`) {
      return {sha:D};
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});
  const recovered=await durable.recover(TASK);
  assert.equal(recovered.recovery,'AT_CHECKPOINT');
  assert.equal(recovered.checkpoint.commentId,11);
  assert.equal(recovered.checkpoint.stage,'S2');
  assert.equal(recovered.checkpoint.status,'READY');
  assert.equal(recovered.headSha,D);
});

test('latest durable event scan returns both checkpoint and blocker candidates in one bounded pass',async()=>{
  const blockerBody=`${DURABLE_TASK_STATE_MARKERS.blocker}
\`\`\`json
${JSON.stringify({
  schemaVersion:1,
  taskKey:TASK,
  reason:'SECURITY_BOUNDARY_CHANGED',
  summary:null,
  at:'2026-09-20T03:00:00.000Z'
},null,2)}
\`\`\``;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45/comments?per_page=100&page=1`) {
      return [
        {id:9,body:'human comment'},
        {id:10,body:checkpointBody({status:'READY',continuation:'same-worker'})},
        {id:11,body:blockerBody}
      ];
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});
  const events=await durable.readLatestTaskEvents(TASK);
  assert.equal(events.checkpoint.commentId,10);
  assert.equal(events.checkpoint.status,'READY');
  assert.equal(events.blocker.commentId,11);
  assert.equal(events.blocker.reason,'SECURITY_BOUNDARY_CHANGED');
  assert.equal(github.calls.length,1);
});

test('production durable event recovery ignores outsider markers and exact verification rejects them',async()=>{
  const outsiderBlocker=`${DURABLE_TASK_STATE_MARKERS.blocker}
\`\`\`json
${JSON.stringify({
  schemaVersion:1,
  taskKey:TASK,
  reason:'FORGED_BLOCKER',
  summary:null,
  at:'2026-09-20T03:00:00.000Z'
},null,2)}
\`\`\``;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45/comments?per_page=100&page=1`) {
      return [
        {
          id:10,
          user:{id:9001},
          body:checkpointBody({status:'READY',continuation:'same-worker'})
        },
        {id:11,user:{id:7777},body:outsiderBlocker}
      ];
    }
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/comments/11`) {
      return {id:11,user:{id:7777},body:outsiderBlocker};
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github,expectedAuthorId:'9001'});
  const events=await durable.readLatestTaskEvents(TASK);
  assert.equal(events.checkpoint.commentId,10);
  assert.equal(events.blocker,null);
  await assert.rejects(
    ()=>durable.verifyBlocker({
      taskKey:TASK,
      blocker:{reason:'FORGED_BLOCKER',commentId:11},
      previousStateCommentId:10
    }),
    error=>error.code==='TASK_DURABLE_AUTHOR_MISMATCH'
  );
});


test('hard-stop helper appends a durable blocker before marking the Issue state BLOCKED',async()=>{
  let posted=null;
  let patched=null;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/45`) {
      return {body:issueBody()};
    }
    if(call.method==='POST' && call.path===`/repos/${REPO}/issues/45/comments`) {
      posted=call.body.body;
      return {id:123,body:posted};
    }
    if(call.method==='PATCH' && call.path===`/repos/${REPO}/issues/45`) {
      patched=call.body.body;
      return {body:patched};
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({
    github,
    clock:()=>Date.parse('2026-09-20T03:00:00.000Z')
  });
  const result=await durable.block({
    taskKey:TASK,
    reason:'UNEXPLAINED_DIFF',
    summary:'unrelated changes require human authority'
  });

  assert.equal(result.blocker.commentId,123);
  assert.match(posted,/bridge-task-blocker:v1/);
  assert.match(posted,/UNEXPLAINED_DIFF/);
  const blockedState=parseDurableTaskState(patched);
  assert.equal(blockedState.status,'BLOCKED');
  assert.deepEqual(blockedState.blocker,{
    reason:'UNEXPLAINED_DIFF',
    commentId:123
  });
  const writes=github.calls.filter(call=>call.method==='POST' || call.method==='PATCH');
  assert.deepEqual(writes.map(call=>call.method),['POST','PATCH']);
});

test('blocker verifier dereferences the exact durable reason and rejects mismatches',async()=>{
  const body=`${DURABLE_TASK_STATE_MARKERS.blocker}
\`\`\`json
${JSON.stringify({
  schemaVersion:1,
  taskKey:TASK,
  reason:'UNEXPLAINED_DIFF',
  summary:'human review required',
  at:'2026-09-20T03:00:00.000Z'
},null,2)}
\`\`\``;
  const github=new FakeGitHub(call=>{
    if(call.method==='GET' && call.path===`/repos/${REPO}/issues/comments/123`) {
      return {id:123,body};
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const durable=new GitHubDurableTaskState({github});
  const verified=await durable.verifyBlocker({
    taskKey:TASK,
    blocker:{reason:'UNEXPLAINED_DIFF',commentId:123},
    previousStateCommentId:122
  });
  assert.equal(verified.reason,'UNEXPLAINED_DIFF');

  await assert.rejects(
    ()=>durable.verifyBlocker({
      taskKey:TASK,
      blocker:{reason:'OTHER_REASON',commentId:123},
      previousStateCommentId:122
    }),
    error=>error.code==='TASK_BLOCKER_INVALID'
  );
});
