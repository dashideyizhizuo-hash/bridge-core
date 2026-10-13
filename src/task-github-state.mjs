import { assertBridge, BridgeError } from './errors.mjs';

const STATE_START='<!-- bridge-durable-task-state:v1:start -->';
const STATE_END='<!-- bridge-durable-task-state:v1:end -->';
const CHECKPOINT_MARKER='<!-- bridge-stage-checkpoint:v1 -->';
const BLOCKER_MARKER='<!-- bridge-task-blocker:v1 -->';
const SHA_PATTERN=/^[0-9a-f]{40}$/;
const MODES=new Set(['supervised','continuous']);
const STATUSES=new Set(['READY','DISPATCHING','RECOVERING','RUNNING','ORPHANED','BLOCKED','DONE']);
const CONTINUATIONS=new Set(['same-worker','handoff']);
const MAX_COMMENT_PAGES=20;

function taskIdentity(value) {
  const match=/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value ?? '');
  assertBridge(match,'TASK_STATE_INVALID','taskKey must be owner/repository#issue-number');
  return {
    taskKey:value,
    repository:match[1],
    issueNumber:Number(match[2])
  };
}

function exactSha(value,label='sha') {
  assertBridge(
    typeof value==='string' && SHA_PATTERN.test(value),
    'TASK_STATE_INVALID',
    `${label} must be an exact SHA`
  );
  return value;
}

function branch(value) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=255 && !/[\r\n\0]/.test(value),
    'TASK_STATE_INVALID',
    'canonicalBranch is invalid'
  );
  return value;
}

function shortText(value,label,{max=256,nullable=false}={}) {
  if(nullable && (value===null || value===undefined)) return null;
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=max && !/\0/.test(value),
    'TASK_STATE_INVALID',
    `${label} is invalid`
  );
  return value;
}

function optionalPositiveInteger(value,label) {
  if(value===null || value===undefined) return null;
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_STATE_INVALID',
    `${label} must be a positive integer`
  );
  return value;
}

function checkpointStatus(value,{nullable=false}={}) {
  if(nullable && (value===null || value===undefined)) return null;
  assertBridge(
    value==='READY' || value==='DONE',
    'TASK_CHECKPOINT_INVALID',
    'checkpoint status must be READY or DONE'
  );
  return value;
}

function continuationMode(value,{nullable=true,code='TASK_STATE_INVALID'}={}) {
  if(nullable && (value===null || value===undefined)) return null;
  assertBridge(
    CONTINUATIONS.has(value),
    code,
    'continuation must be same-worker or handoff'
  );
  return value;
}

function isoDate(value,label='updatedAt') {
  assertBridge(
    typeof value==='string' && Number.isFinite(Date.parse(value)),
    'TASK_STATE_INVALID',
    `${label} must be an ISO timestamp`
  );
  return value;
}

function checkpointShape(value) {
  if(value===null || value===undefined) return null;
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_STATE_INVALID',
    'checkpoint must be an object'
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      new Set(['stage','sha','commentId']).has(key),
      'TASK_STATE_INVALID',
      `checkpoint contains unsupported field: ${key}`
    );
  }
  return {
    stage:shortText(value.stage,'checkpoint.stage',{max:256}),
    sha:exactSha(value.sha,'checkpoint.sha'),
    commentId:optionalPositiveInteger(value.commentId,'checkpoint.commentId')
  };
}

function blockerShape(value) {
  if(value===null || value===undefined) return null;
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_STATE_INVALID',
    'blocker must be an object'
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      new Set(['reason','commentId']).has(key),
      'TASK_STATE_INVALID',
      `blocker contains unsupported field: ${key}`
    );
  }
  return {
    reason:shortText(value.reason,'blocker.reason',{max:512}),
    commentId:optionalPositiveInteger(value.commentId,'blocker.commentId')
  };
}

export function assertDurableStateIdentity(state,task) {
  assertBridge(
    state &&
      task &&
      state.taskKey===task.taskKey &&
      state.canonicalBranch===task.canonicalBranch &&
      state.mode===task.mode,
    'TASK_RECOVERY_DIVERGED',
    'durable GitHub identity does not match runtime coordination state'
  );
  return state;
}

export function validateDurableTaskState(value,{expectedTaskKey}={}) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_STATE_INVALID',
    'durable task state must be an object'
  );
  const allowed=new Set([
    'schemaVersion','taskKey','mode','status','canonicalBranch',
    'checkpoint','blocker','nextStage','continuation','pullRequest','updatedAt'
  ]);
  for(const key of Object.keys(value)) {
    assertBridge(allowed.has(key),'TASK_STATE_INVALID',`durable task state contains unsupported field: ${key}`);
  }
  assertBridge(value.schemaVersion===1,'TASK_STATE_INVALID','durable task state schemaVersion must equal 1');
  const identity=taskIdentity(value.taskKey);
  if(expectedTaskKey!==undefined) {
    assertBridge(identity.taskKey===expectedTaskKey,'TASK_STATE_MISMATCH','durable task state belongs to another task');
  }
  assertBridge(MODES.has(value.mode),'TASK_STATE_INVALID','durable task state mode is invalid');
  assertBridge(STATUSES.has(value.status),'TASK_STATE_INVALID','durable task state status is invalid');
  const nextStage=shortText(value.nextStage,'nextStage',{max:256,nullable:true});
  const continuation=continuationMode(value.continuation);
  assertBridge(
    nextStage!==null || continuation===null,
    'TASK_STATE_INVALID',
    'continuation requires a nextStage'
  );
  return {
    schemaVersion:1,
    taskKey:identity.taskKey,
    mode:value.mode,
    status:value.status,
    canonicalBranch:branch(value.canonicalBranch),
    checkpoint:checkpointShape(value.checkpoint),
    blocker:blockerShape(value.blocker),
    nextStage,
    continuation,
    pullRequest:optionalPositiveInteger(value.pullRequest,'pullRequest'),
    updatedAt:isoDate(value.updatedAt)
  };
}

function fencedJson(marker,value) {
  return `${marker}\n\`\`\`json\n${JSON.stringify(value,null,2)}\n\`\`\``;
}

export function parseDurableTaskState(body,{expectedTaskKey}={}) {
  assertBridge(typeof body==='string','TASK_STATE_INVALID','Issue body must be text');
  const start=body.indexOf(STATE_START);
  if(start===-1) return null;
  const end=body.indexOf(STATE_END,start+STATE_START.length);
  assertBridge(end!==-1,'TASK_STATE_INVALID','durable task state block is not closed');
  assertBridge(
    body.indexOf(STATE_START,start+STATE_START.length)===-1,
    'TASK_STATE_INVALID',
    'Issue body contains multiple durable task state blocks'
  );
  const segment=body.slice(start+STATE_START.length,end);
  const match=/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/.exec(segment);
  assertBridge(match,'TASK_STATE_INVALID','durable task state block must contain fenced JSON');
  let parsed;
  try { parsed=JSON.parse(match[1]); }
  catch(error) {
    throw new BridgeError('TASK_STATE_INVALID','durable task state JSON is invalid',{cause:error.message});
  }
  return validateDurableTaskState(parsed,{expectedTaskKey});
}

export function upsertDurableTaskState(body,state) {
  const normalized=validateDurableTaskState(state);
  assertBridge(typeof body==='string','TASK_STATE_INVALID','Issue body must be text');
  const block=`${STATE_START}\n\`\`\`json\n${JSON.stringify(normalized,null,2)}\n\`\`\`\n${STATE_END}`;
  const start=body.indexOf(STATE_START);
  if(start===-1) {
    const prefix=body.trimEnd();
    return `${prefix}${prefix ? '\n\n' : ''}${block}\n`;
  }
  const end=body.indexOf(STATE_END,start+STATE_START.length);
  assertBridge(end!==-1,'TASK_STATE_INVALID','durable task state block is not closed');
  assertBridge(
    body.indexOf(STATE_START,start+STATE_START.length)===-1,
    'TASK_STATE_INVALID',
    'Issue body contains multiple durable task state blocks'
  );
  return body.slice(0,start)+block+body.slice(end+STATE_END.length);
}

function validateCheckpointPayload(value,{expectedTaskKey}={}) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_CHECKPOINT_INVALID',
    'checkpoint payload must be an object'
  );
  const allowed=new Set([
    'schemaVersion','taskKey','canonicalBranch','stage','sha',
    'runId','nextStage','continuation','pullRequest','summary','status'
  ]);
  for(const key of Object.keys(value)) {
    assertBridge(allowed.has(key),'TASK_CHECKPOINT_INVALID',`checkpoint contains unsupported field: ${key}`);
  }
  assertBridge(value.schemaVersion===1,'TASK_CHECKPOINT_INVALID','checkpoint schemaVersion must equal 1');
  const identity=taskIdentity(value.taskKey);
  if(expectedTaskKey!==undefined) {
    assertBridge(identity.taskKey===expectedTaskKey,'TASK_CHECKPOINT_INVALID','checkpoint belongs to another task');
  }
  const nextStage=shortText(value.nextStage,'checkpoint nextStage',{max:256,nullable:true});
  const continuation=continuationMode(value.continuation,{code:'TASK_CHECKPOINT_INVALID'});
  assertBridge(
    nextStage!==null || continuation===null,
    'TASK_CHECKPOINT_INVALID',
    'checkpoint continuation requires a nextStage'
  );
  return {
    schemaVersion:1,
    taskKey:identity.taskKey,
    canonicalBranch:branch(value.canonicalBranch),
    stage:shortText(value.stage,'checkpoint stage',{max:256}),
    sha:exactSha(value.sha,'checkpoint sha'),
    runId:shortText(value.runId,'checkpoint runId',{max:256,nullable:true}),
    nextStage,
    continuation,
    pullRequest:optionalPositiveInteger(value.pullRequest,'checkpoint pullRequest'),
    summary:shortText(value.summary,'checkpoint summary',{max:4000,nullable:true}),
    status:checkpointStatus(value.status,{nullable:true})
  };
}

export function parseCheckpointComment(body,{expectedTaskKey}={}) {
  if(typeof body!=='string' || !body.includes(CHECKPOINT_MARKER)) return null;
  const segment=body.slice(body.indexOf(CHECKPOINT_MARKER)+CHECKPOINT_MARKER.length);
  const match=/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/.exec(segment);
  assertBridge(match,'TASK_CHECKPOINT_INVALID','checkpoint comment must contain fenced JSON');
  let parsed;
  try { parsed=JSON.parse(match[1]); }
  catch(error) {
    throw new BridgeError('TASK_CHECKPOINT_INVALID','checkpoint JSON is invalid',{cause:error.message});
  }
  return validateCheckpointPayload(parsed,{expectedTaskKey});
}

function checkpointComment(payload) {
  return fencedJson(CHECKPOINT_MARKER,validateCheckpointPayload(payload));
}

function validateBlockerPayload(value,{expectedTaskKey}={}) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_BLOCKER_INVALID',
    'blocker payload must be an object'
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      new Set(['schemaVersion','taskKey','reason','summary','at']).has(key),
      'TASK_BLOCKER_INVALID',
      `blocker contains unsupported field: ${key}`
    );
  }
  assertBridge(value.schemaVersion===1,'TASK_BLOCKER_INVALID','blocker schemaVersion must equal 1');
  const identity=taskIdentity(value.taskKey);
  if(expectedTaskKey!==undefined) {
    assertBridge(identity.taskKey===expectedTaskKey,'TASK_BLOCKER_INVALID','blocker belongs to another task');
  }
  return {
    schemaVersion:1,
    taskKey:identity.taskKey,
    reason:shortText(value.reason,'blocker reason',{max:512}),
    summary:shortText(value.summary,'blocker summary',{max:4000,nullable:true}),
    at:isoDate(value.at,'blocker at')
  };
}

export function parseBlockerComment(body,{expectedTaskKey}={}) {
  if(typeof body!=='string' || !body.includes(BLOCKER_MARKER)) return null;
  const segment=body.slice(body.indexOf(BLOCKER_MARKER)+BLOCKER_MARKER.length);
  const match=/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/.exec(segment);
  assertBridge(match,'TASK_BLOCKER_INVALID','blocker comment must contain fenced JSON');
  let parsed;
  try { parsed=JSON.parse(match[1]); }
  catch(error) {
    throw new BridgeError('TASK_BLOCKER_INVALID','blocker JSON is invalid',{cause:error.message});
  }
  return validateBlockerPayload(parsed,{expectedTaskKey});
}

function assertGitHub(value) {
  assertBridge(
    value && typeof value.request==='function',
    'TASK_GITHUB_CONFIG_INVALID',
    'GitHub request client is required'
  );
  return value;
}

function optionalAuthorId(value) {
  if(value===null || value===undefined) return null;
  const normalized=Number.isSafeInteger(value) ? String(value) : value;
  assertBridge(
    typeof normalized==='string' && /^[1-9][0-9]{0,31}$/.test(normalized),
    'TASK_GITHUB_CONFIG_INVALID',
    'expected durable-event author id is invalid'
  );
  return normalized;
}

function compareSummary(compare,checkpointSha,headSha) {
  assertBridge(
    compare && typeof compare==='object',
    'TASK_RECOVERY_INVALID',
    'GitHub compare response is invalid'
  );
  const mergeBase=compare.merge_base_commit?.sha;
  const status=compare.status;
  assertBridge(
    status==='ahead' && mergeBase===checkpointSha,
    'TASK_RECOVERY_DIVERGED',
    'canonical branch no longer descends linearly from the durable checkpoint',
    {checkpointSha,headSha,status,mergeBase}
  );
  const commits=Array.isArray(compare.commits) ? compare.commits : [];
  const aheadBy=Number(compare.ahead_by);
  assertBridge(
    Number.isSafeInteger(aheadBy) && aheadBy>=1 && aheadBy===commits.length,
    'TASK_RECOVERY_INCOMPLETE',
    'GitHub compare response does not contain the complete intervening commit set',
    {aheadBy,returnedCommits:commits.length}
  );
  const files=Array.isArray(compare.files) ? compare.files : [];
  assertBridge(
    files.length<300,
    'TASK_RECOVERY_INCOMPLETE',
    'GitHub compare file set reached the API safety bound'
  );
  return {
    commits:commits.map(commit=>({
      sha:exactSha(commit.sha,'recovered commit sha'),
      message:
        typeof commit.commit?.message==='string'
          ? commit.commit.message.split('\n',1)[0].slice(0,500)
          : ''
    })),
    files:files.map(file=>({
      filename:typeof file.filename==='string' ? file.filename : '',
      status:typeof file.status==='string' ? file.status : '',
      additions:Number.isSafeInteger(file.additions) ? file.additions : null,
      deletions:Number.isSafeInteger(file.deletions) ? file.deletions : null
    }))
  };
}

export class GitHubDurableTaskState {
  constructor({github,clock=()=>Date.now(),expectedAuthorId=null}={}) {
    this.github=assertGitHub(github);
    assertBridge(typeof clock==='function','TASK_GITHUB_CONFIG_INVALID','clock is required');
    this.clock=clock;
    this.expectedAuthorId=optionalAuthorId(expectedAuthorId);
  }

  #isExpectedAuthor(comment) {
    return this.expectedAuthorId===null ||
      String(comment?.user?.id ?? '')===this.expectedAuthorId;
  }

  #assertExpectedAuthor(comment) {
    assertBridge(
      this.#isExpectedAuthor(comment),
      'TASK_DURABLE_AUTHOR_MISMATCH',
      'durable task event was not written by the enrolled GitHub principal'
    );
  }

  async #issue(identity) {
    const issue=await this.github.request(
      'GET',
      `/repos/${identity.repository}/issues/${identity.issueNumber}`
    );
    assertBridge(
      issue && typeof issue.body==='string',
      'TASK_STATE_NOT_FOUND',
      'primary GitHub Issue is unavailable'
    );
    return issue;
  }

  async readState(taskKey) {
    const identity=taskIdentity(taskKey);
    const issue=await this.#issue(identity);
    const state=parseDurableTaskState(issue.body,{expectedTaskKey:taskKey});
    assertBridge(state,'TASK_STATE_NOT_FOUND','primary Issue has no durable task state block');
    return {identity,issue,state};
  }

  async writeState(taskKey,nextState) {
    const identity=taskIdentity(taskKey);
    const issue=await this.#issue(identity);
    const state=validateDurableTaskState(nextState,{expectedTaskKey:taskKey});
    const body=upsertDurableTaskState(issue.body,state);
    const updated=await this.github.request(
      'PATCH',
      `/repos/${identity.repository}/issues/${identity.issueNumber}`,
      {body:{body}}
    );
    return {
      identity,
      state,
      issue:updated ?? {...issue,body}
    };
  }

  async initialize({
    taskKey,
    mode,
    canonicalBranch,
    status='READY',
    nextStage=null,
    continuation=null,
    pullRequest=null
  }={}) {
    const identity=taskIdentity(taskKey);
    const issue=await this.#issue(identity);
    const existing=parseDurableTaskState(issue.body,{expectedTaskKey:taskKey});
    assertBridge(!existing,'TASK_STATE_CONFLICT','durable task state is already initialized');
    const state=validateDurableTaskState({
      schemaVersion:1,
      taskKey,
      mode,
      status,
      canonicalBranch,
      checkpoint:null,
      blocker:null,
      nextStage,
      continuation,
      pullRequest,
      updatedAt:new Date(this.clock()).toISOString()
    });
    const body=upsertDurableTaskState(issue.body,state);
    const updated=await this.github.request(
      'PATCH',
      `/repos/${identity.repository}/issues/${identity.issueNumber}`,
      {body:{body}}
    );
    return {identity,state,issue:updated ?? {...issue,body}};
  }

  async listCheckpoints(taskKey) {
    const identity=taskIdentity(taskKey);
    const checkpoints=[];
    for(let page=1;page<=MAX_COMMENT_PAGES;page++) {
      const comments=await this.github.request(
        'GET',
        `/repos/${identity.repository}/issues/${identity.issueNumber}/comments?per_page=100&page=${page}`
      );
      assertBridge(Array.isArray(comments),'TASK_CHECKPOINT_INVALID','Issue comments response must be an array');
      for(const comment of comments) {
        if(!this.#isExpectedAuthor(comment)) continue;
        const parsed=parseCheckpointComment(comment?.body,{expectedTaskKey:taskKey});
        if(!parsed) continue;
        assertBridge(
          Number.isSafeInteger(comment.id) && comment.id>0,
          'TASK_CHECKPOINT_INVALID',
          'checkpoint comment has no stable GitHub comment id'
        );
        checkpoints.push({
          ...parsed,
          commentId:comment.id,
          createdAt:
            typeof comment.created_at==='string' && Number.isFinite(Date.parse(comment.created_at))
              ? comment.created_at
              : null
        });
      }
      if(comments.length<100) return checkpoints;
    }
    throw new BridgeError(
      'TASK_CHECKPOINT_HISTORY_TOO_LARGE',
      `checkpoint scan exceeded ${MAX_COMMENT_PAGES*100} Issue comments`
    );
  }

  async readLatestCheckpoint(taskKey) {
    const checkpoints=await this.listCheckpoints(taskKey);
    return checkpoints.length===0 ? null : checkpoints.at(-1);
  }

  async readLatestTaskEvents(taskKey) {
    const identity=taskIdentity(taskKey);
    let checkpoint=null;
    let blocker=null;
    for(let page=1;page<=MAX_COMMENT_PAGES;page++) {
      const comments=await this.github.request(
        'GET',
        `/repos/${identity.repository}/issues/${identity.issueNumber}/comments?per_page=100&page=${page}`
      );
      assertBridge(Array.isArray(comments),'TASK_STATE_INVALID','Issue comments response must be an array');
      for(const comment of comments) {
        assertBridge(
          Number.isSafeInteger(comment?.id) && comment.id>0,
          'TASK_STATE_INVALID',
          'durable Issue comment has no stable GitHub comment id'
        );
        if(!this.#isExpectedAuthor(comment)) continue;
        const parsedCheckpoint=parseCheckpointComment(comment.body,{expectedTaskKey:taskKey});
        if(parsedCheckpoint) {
          checkpoint={...parsedCheckpoint,commentId:comment.id};
          continue;
        }
        const parsedBlocker=parseBlockerComment(comment.body,{expectedTaskKey:taskKey});
        if(parsedBlocker) blocker={...parsedBlocker,commentId:comment.id};
      }
      if(comments.length<100) return {checkpoint,blocker};
    }
    throw new BridgeError(
      'TASK_CHECKPOINT_HISTORY_TOO_LARGE',
      `durable event scan exceeded ${MAX_COMMENT_PAGES*100} Issue comments`
    );
  }

  async verifyCheckpoint({
    taskKey,
    canonicalBranch,
    checkpoint,
    previousCheckpointSha=null,
    previousStateCommentId=null,
    expectedStatus=null,
    expectedNextStage=undefined,
    expectedContinuation=undefined,
    requireStatus=false
  }={}) {
    const identity=taskIdentity(taskKey);
    const canonical=branch(canonicalBranch);
    const pointer=checkpointShape(checkpoint);
    assertBridge(
      pointer && pointer.commentId!==null,
      'TASK_CHECKPOINT_INVALID',
      'checkpoint pointer must include a stable comment id'
    );
    const previousSha=previousCheckpointSha===null
      ? null
      : exactSha(previousCheckpointSha,'previous checkpoint sha');
    const previousComment=previousStateCommentId===null
      ? null
      : optionalPositiveInteger(previousStateCommentId,'previous state comment id');
    if(previousComment!==null) {
      assertBridge(
        pointer.commentId>previousComment,
        'TASK_RECOVERY_DIVERGED',
        'durable checkpoint comment did not advance monotonically',
        {previousStateCommentId:previousComment,stateCommentId:pointer.commentId}
      );
    }

    const comment=await this.github.request(
      'GET',
      `/repos/${identity.repository}/issues/comments/${pointer.commentId}`
    );
    assertBridge(
      comment && comment.id===pointer.commentId,
      'TASK_CHECKPOINT_INVALID',
      'GitHub checkpoint comment identity is invalid'
    );
    this.#assertExpectedAuthor(comment);
    const parsed=parseCheckpointComment(comment.body,{expectedTaskKey:taskKey});
    assertBridge(parsed,'TASK_CHECKPOINT_INVALID','GitHub comment is not a durable checkpoint');
    assertBridge(
      parsed.canonicalBranch===canonical &&
        parsed.stage===pointer.stage &&
        parsed.sha===pointer.sha,
      'TASK_CHECKPOINT_INVALID',
      'GitHub checkpoint comment does not match the managed state pointer'
    );
    if(expectedStatus!==null) {
      const status=checkpointStatus(expectedStatus);
      assertBridge(
        parsed.status===null || parsed.status===status,
        'TASK_CHECKPOINT_INVALID',
        'GitHub checkpoint status does not match the requested transition'
      );
      if(requireStatus) {
        assertBridge(
          parsed.status===status,
          'TASK_CHECKPOINT_INVALID',
          'GitHub checkpoint must record its terminal task status'
        );
      }
    }
    if(expectedNextStage!==undefined) {
      const nextStage=shortText(
        expectedNextStage,
        'expected checkpoint nextStage',
        {max:256,nullable:true}
      );
      assertBridge(
        parsed.nextStage===nextStage,
        'TASK_CHECKPOINT_INVALID',
        'GitHub checkpoint nextStage does not match the managed state'
      );
    }
    if(expectedContinuation!==undefined) {
      const continuation=continuationMode(
        expectedContinuation,
        {code:'TASK_CHECKPOINT_INVALID'}
      );
      assertBridge(
        parsed.continuation===continuation,
        'TASK_CHECKPOINT_INVALID',
        'GitHub checkpoint continuation does not match the managed state'
      );
    }

    const head=await this.#resolveHead(identity.repository,canonical);
    assertBridge(
      head===pointer.sha,
      'TASK_CHECKPOINT_STALE',
      'checkpoint SHA must equal the current canonical branch HEAD',
      {checkpointSha:pointer.sha,headSha:head}
    );
    if(previousSha!==null && previousSha!==pointer.sha) {
      const compare=await this.github.request(
        'GET',
        `/repos/${identity.repository}/compare/${previousSha}...${pointer.sha}`
      );
      compareSummary(compare,previousSha,pointer.sha);
    }
    return {...parsed,commentId:pointer.commentId};
  }

  async verifyBlocker({
    taskKey,
    blocker,
    previousStateCommentId=null
  }={}) {
    const identity=taskIdentity(taskKey);
    const pointer=blockerShape(blocker);
    assertBridge(
      pointer && pointer.commentId!==null,
      'TASK_BLOCKER_INVALID',
      'blocker pointer must include a stable comment id'
    );
    const previousComment=previousStateCommentId===null
      ? null
      : optionalPositiveInteger(previousStateCommentId,'previous state comment id');
    if(previousComment!==null) {
      assertBridge(
        pointer.commentId>previousComment,
        'TASK_RECOVERY_DIVERGED',
        'durable blocker comment did not advance beyond the prior checkpoint',
        {previousStateCommentId:previousComment,blockerCommentId:pointer.commentId}
      );
    }
    const comment=await this.github.request(
      'GET',
      `/repos/${identity.repository}/issues/comments/${pointer.commentId}`
    );
    assertBridge(
      comment && comment.id===pointer.commentId,
      'TASK_BLOCKER_INVALID',
      'GitHub blocker comment identity is invalid'
    );
    this.#assertExpectedAuthor(comment);
    const parsed=parseBlockerComment(comment.body,{expectedTaskKey:taskKey});
    assertBridge(parsed,'TASK_BLOCKER_INVALID','GitHub comment is not a durable blocker');
    assertBridge(
      parsed.reason===pointer.reason,
      'TASK_BLOCKER_INVALID',
      'GitHub blocker comment does not match the managed state pointer'
    );
    return {...parsed,commentId:pointer.commentId};
  }

  async #resolveHead(repository,canonicalBranch) {
    const commit=await this.github.request(
      'GET',
      `/repos/${repository}/commits/${encodeURIComponent(canonicalBranch)}`
    );
    return exactSha(commit?.sha,'canonical branch HEAD');
  }

  async checkpoint({
    taskKey,
    stage,
    sha,
    runId=null,
    summary=null,
    nextStage=null,
    continuation,
    status='READY',
    pullRequest
  }={}) {
    const {identity,issue,state}=await this.readState(taskKey);
    const exact=exactSha(sha,'checkpoint sha');
    const head=await this.#resolveHead(identity.repository,state.canonicalBranch);
    assertBridge(
      exact===head,
      'TASK_CHECKPOINT_STALE',
      'checkpoint SHA must equal the current canonical branch HEAD',
      {checkpointSha:exact,headSha:head}
    );
    const nextContinuation=continuation===undefined ? null : continuation;
    const payload=validateCheckpointPayload({
      schemaVersion:1,
      taskKey,
      canonicalBranch:state.canonicalBranch,
      stage,
      sha:exact,
      runId,
      nextStage,
      continuation:nextContinuation,
      status,
      pullRequest:pullRequest===undefined ? state.pullRequest : pullRequest,
      summary
    });
    const comment=await this.github.request(
      'POST',
      `/repos/${identity.repository}/issues/${identity.issueNumber}/comments`,
      {body:{body:checkpointComment(payload)}}
    );
    assertBridge(
      Number.isSafeInteger(comment?.id) && comment.id>0,
      'TASK_CHECKPOINT_INVALID',
      'GitHub did not return a durable checkpoint comment id'
    );
    const next=validateDurableTaskState({
      ...state,
      status,
      checkpoint:{stage:payload.stage,sha:payload.sha,commentId:comment.id},
      blocker:null,
      nextStage:payload.nextStage,
      continuation:payload.continuation,
      pullRequest:payload.pullRequest,
      updatedAt:new Date(this.clock()).toISOString()
    },{expectedTaskKey:taskKey});
    const body=upsertDurableTaskState(issue.body,next);
    await this.github.request(
      'PATCH',
      `/repos/${identity.repository}/issues/${identity.issueNumber}`,
      {body:{body}}
    );
    return {
      state:next,
      checkpoint:{...payload,commentId:comment.id}
    };
  }

  async block({
    taskKey,
    reason,
    summary=null
  }={}) {
    const {identity,issue,state}=await this.readState(taskKey);
    const blocker=validateBlockerPayload({
      schemaVersion:1,
      taskKey,
      reason:shortText(reason,'blocker reason',{max:512}),
      summary:shortText(summary,'blocker summary',{max:4000,nullable:true}),
      at:new Date(this.clock()).toISOString()
    },{expectedTaskKey:taskKey});
    const comment=await this.github.request(
      'POST',
      `/repos/${identity.repository}/issues/${identity.issueNumber}/comments`,
      {body:{body:fencedJson(BLOCKER_MARKER,blocker)}}
    );
    assertBridge(
      Number.isSafeInteger(comment?.id) && comment.id>0,
      'TASK_BLOCKER_INVALID',
      'GitHub did not return a durable blocker comment id'
    );
    const next=validateDurableTaskState({
      ...state,
      status:'BLOCKED',
      blocker:{reason:blocker.reason,commentId:comment.id},
      continuation:null,
      updatedAt:blocker.at
    },{expectedTaskKey:taskKey});
    const body=upsertDurableTaskState(issue.body,next);
    await this.github.request(
      'PATCH',
      `/repos/${identity.repository}/issues/${identity.issueNumber}`,
      {body:{body}}
    );
    return {state:next,blocker:{...blocker,commentId:comment.id}};
  }

  async recover(taskKey) {
    const {identity,state}=await this.readState(taskKey);
    const latest=await this.readLatestCheckpoint(taskKey);
    let checkpoint=latest;
    if(!checkpoint && state.checkpoint) {
      checkpoint={
        taskKey,
        canonicalBranch:state.canonicalBranch,
        stage:state.checkpoint.stage,
        sha:state.checkpoint.sha,
        commentId:state.checkpoint.commentId,
        runId:null,
        nextStage:state.nextStage,
        continuation:state.continuation,
        pullRequest:state.pullRequest,
        summary:null
      };
    }
    if(checkpoint) {
      assertBridge(
        checkpoint.canonicalBranch===state.canonicalBranch,
        'TASK_RECOVERY_DIVERGED',
        'latest durable checkpoint belongs to a different canonical branch',
        {
          checkpointBranch:checkpoint.canonicalBranch,
          canonicalBranch:state.canonicalBranch
        }
      );
    }

    const headSha=await this.#resolveHead(identity.repository,state.canonicalBranch);
    if(!checkpoint) {
      return {
        taskKey,
        state,
        checkpoint:null,
        headSha,
        recovery:'NO_CHECKPOINT',
        commits:[],
        files:[]
      };
    }
    if(checkpoint.sha===headSha) {
      return {
        taskKey,
        state,
        checkpoint,
        headSha,
        recovery:'AT_CHECKPOINT',
        commits:[],
        files:[]
      };
    }

    const compare=await this.github.request(
      'GET',
      `/repos/${identity.repository}/compare/${checkpoint.sha}...${headSha}`
    );
    const summary=compareSummary(compare,checkpoint.sha,headSha);
    return {
      taskKey,
      state,
      checkpoint,
      headSha,
      recovery:'ADVANCED',
      ...summary
    };
  }
}

export const DURABLE_TASK_STATE_MARKERS=Object.freeze({
  stateStart:STATE_START,
  stateEnd:STATE_END,
  checkpoint:CHECKPOINT_MARKER,
  blocker:BLOCKER_MARKER
});
