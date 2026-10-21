import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const MAX_OUTPUT_BYTES=1024*1024;
const MAX_PROMPT_CHARS=32*1024;
const MODEL_CHOICES=new Set([
  'fast','balanced','advanced','very-high','pro'
]);
export class ChatCliError extends Error {
  constructor(message) {
    super(message);
    this.name='ChatCliError';
  }
}

function requiredValue(args,index,flag) {
  const value=args[index+1];
  if(typeof value!=='string' || value.length===0 || value.startsWith('--')) {
    throw new ChatCliError(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const command=argv[0];
  if(command!=='create' && command!=='send' && command!=='activate' && command!=='launch') {
    throw new ChatCliError('Usage: bridge-chat <create|send|activate|launch> (--prompt <text>|--prompt-stdin) [--conversation <id|url>] [--task <owner/repo#issue>] [--dispatch <id>] [--model <level>] [--timeout <seconds>] [--json]');
  }
  const parsed={command,prompt:null,promptFromStdin:false,conversation:null,task:null,dispatch:null,model:null,timeoutSeconds:60,json:false};
  for(let index=1;index<argv.length;index++) {
    const token=argv[index];
    if(token==='--prompt') {
      parsed.prompt=requiredValue(argv,index,token);
      index++;
    } else if(token==='--prompt-stdin') {
      parsed.promptFromStdin=true;
    } else if(token==='--model') {
      parsed.model=requiredValue(argv,index,token);
      index++;
    } else if(token==='--conversation') {
      parsed.conversation=requiredValue(argv,index,token);
      index++;
    } else if(token==='--task') {
      parsed.task=requiredValue(argv,index,token);
      index++;
    } else if(token==='--dispatch') {
      parsed.dispatch=requiredValue(argv,index,token);
      index++;
    } else if(token==='--timeout') {
      const raw=requiredValue(argv,index,token);
      const value=Number(raw);
      if(!Number.isInteger(value) || value<10 || value>300) {
        throw new ChatCliError('--timeout must be an integer from 10 to 300 seconds');
      }
      parsed.timeoutSeconds=value;
      index++;
    } else if(token==='--json') {
      parsed.json=true;
    } else {
      throw new ChatCliError(`Unknown option: ${token.startsWith('--') ? token : '<argument>'}`);
    }
  }
  if(parsed.promptFromStdin && parsed.prompt!==null) {
    throw new ChatCliError('use exactly one of --prompt or --prompt-stdin');
  }
  if(!parsed.promptFromStdin) {
    if(typeof parsed.prompt!=='string' || parsed.prompt.trim().length===0) {
      throw new ChatCliError('--prompt or --prompt-stdin is required');
    }
    parsed.prompt=parsed.prompt.trim();
    if(parsed.prompt.length>MAX_PROMPT_CHARS) {
      throw new ChatCliError(`--prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
  }
  if(parsed.model!==null && !MODEL_CHOICES.has(parsed.model)) {
    throw new ChatCliError(`--model must be one of: ${[...MODEL_CHOICES].join(', ')}`);
  }
  if(command==='create' && (parsed.conversation!==null || parsed.task!==null || parsed.dispatch!==null)) {
    throw new ChatCliError('--conversation, --task and --dispatch are valid only with send or activate');
  }
  if(command==='send') {
    if(parsed.model!==null) {
      throw new ChatCliError('--model is valid only with create');
    }
    parsed.conversationId=parseConversationTarget(parsed.conversation);
    if(parsed.task!==null || parsed.dispatch!==null) {
      throw new ChatCliError('--task and --dispatch are valid only with activate');
    }
  }
  if(command==='activate') {
    if(parsed.model!==null) {
      throw new ChatCliError('--model is valid only with create');
    }
    parsed.conversationId=parseConversationTarget(parsed.conversation);
    if(typeof parsed.task!=='string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(parsed.task)) {
      throw new ChatCliError('--task must be owner/repository#issue');
    }
    if(typeof parsed.dispatch!=='string' || !/^dispatch-[A-Za-z0-9-]{16,128}$/.test(parsed.dispatch)) {
      throw new ChatCliError('--dispatch must be a Bridge dispatch ID');
    }
  }
  if(command==='launch') {
    if(parsed.model!==null) {
      throw new ChatCliError('--model is valid only with create');
    }
    if(parsed.conversation!==null) {
      throw new ChatCliError('--conversation is not valid with launch');
    }
    if(typeof parsed.task!=='string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(parsed.task)) {
      throw new ChatCliError('--task must be owner/repository#issue');
    }
    if(typeof parsed.dispatch!=='string' || !/^dispatch-[A-Za-z0-9-]{16,128}$/.test(parsed.dispatch)) {
      throw new ChatCliError('--dispatch must be a Bridge dispatch ID');
    }
  }
  return parsed;
}

async function defaultReadStdin() {
  const chunks=[];
  let total=0;
  for await (const chunk of process.stdin) {
    const value=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total+=value.length;
    if(total>MAX_PROMPT_CHARS*4) {
      throw new ChatCliError(`stdin prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizePrompt(value) {
  const prompt=String(value ?? '').trim();
  if(prompt.length===0) throw new ChatCliError('stdin prompt must not be empty');
  if(prompt.length>MAX_PROMPT_CHARS) {
    throw new ChatCliError(`stdin prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  return prompt;
}

export function parseConversationTarget(value) {
  if(typeof value!=='string' || value.trim().length===0) {
    throw new ChatCliError('--conversation is required with send');
  }
  const target=value.trim();
  if(/^[A-Za-z0-9_-]{8,128}$/.test(target)) return target;
  let url;
  try {
    url=new URL(target);
  } catch {
    throw new ChatCliError('--conversation must be a ChatGPT conversation ID or URL');
  }
  const match=url.pathname.match(/^\/c\/([A-Za-z0-9_-]{8,128})\/?$/);
  if(url.protocol!=='https:' || url.hostname!=='chatgpt.com' || !match) {
    throw new ChatCliError('--conversation must be a ChatGPT conversation ID or URL');
  }
  return match[1];
}

function parseConversationEnvelope(stdout,expectedConversationId=null) {
  let rows;
  try {
    rows=JSON.parse(String(stdout));
  } catch {
    throw new ChatCliError('OpenCLI returned malformed JSON');
  }
  const row=Array.isArray(rows) ? rows[0] : rows;
  const conversationId=String(row?.conversationId ?? '');
  const conversationUrl=String(row?.conversationUrl ?? '');
  let url;
  try {
    url=new URL(conversationUrl);
  } catch {
    throw new ChatCliError('OpenCLI did not return a valid ChatGPT conversation URL');
  }
  const match=url.pathname.match(/(?:^|\/)c\/([A-Za-z0-9_-]{8,128})(?:\/|$)/);
  if(url.protocol!=='https:' || url.hostname!=='chatgpt.com' || !match || match[1]!==conversationId) {
    throw new ChatCliError('OpenCLI returned an invalid ChatGPT conversation identity');
  }
  if(expectedConversationId!==null && conversationId!==expectedConversationId) {
    throw new ChatCliError('OpenCLI returned a different ChatGPT conversation identity');
  }
  return {
    conversationId,
    conversationUrl:url.href,
    response:typeof row?.response==='string' ? row.response :
      (typeof row?.Response==='string' ? row.Response : '')
  };
}

export function parseConversationResult(stdout,expectedConversationId=null) {
  const {conversationId,conversationUrl}=parseConversationEnvelope(stdout,expectedConversationId);
  return {conversationId,conversationUrl};
}

export const parseCreateResult=parseConversationResult;

async function defaultOpenCli(args,{timeoutMs}) {
  try {
    import.meta.resolve('@jackwener/opencli');
  } catch {
    throw new ChatCliError('OpenCLI dependency is unavailable; run npm install in the Bridge repository');
  }
  const entry=fileURLToPath(new URL('./opencli-stdin-entry.mjs',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry],{
      windowsHide:true,
      stdio:['pipe','pipe','pipe']
    });
    const stdout=[];
    let stdoutBytes=0;
    let stderrBytes=0;
    let settled=false;
    const finishError=()=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      reject(new ChatCliError('OpenCLI ChatGPT browser command failed; run opencli doctor and verify the Browser Bridge extension'));
    };
    const timer=setTimeout(()=>{
      child.kill();
      finishError();
    },timeoutMs);
    child.stdout.on('data',chunk=>{
      stdoutBytes+=chunk.length;
      if(stdoutBytes>MAX_OUTPUT_BYTES) {
        child.kill();
        finishError();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data',chunk=>{
      stderrBytes+=chunk.length;
      if(stderrBytes>MAX_OUTPUT_BYTES) {
        child.kill();
        finishError();
      }
    });
    child.on('error',finishError);
    child.on('close',code=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      if(code!==0) {
        reject(new ChatCliError('OpenCLI ChatGPT browser command failed; run opencli doctor and verify the Browser Bridge extension'));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.on('error',finishError);
    child.stdin.end(JSON.stringify({args}));
  });
}

export function parseTaskActivation(stdout,options,{now=Date.now}={}) {
  let payload;
  try {
    payload=JSON.parse(stdout);
  } catch {
    throw new ChatCliError('Bridge task activation returned malformed JSON');
  }
  const token=payload?.taskSessionToken;
  const expiry=Date.parse(payload?.leaseExpiresAt ?? '');
  if(
    payload?.status!=='ACTIVATED' ||
    payload?.taskKey!==options.task ||
    typeof payload?.workerId!=='string' ||
    !/^[A-Za-z0-9._:-]{8,256}$/.test(payload.workerId) ||
    !Number.isSafeInteger(payload?.leaseEpoch) ||
    payload.leaseEpoch<1 ||
    !Number.isFinite(expiry) ||
    expiry<=now() ||
    typeof token!=='string' ||
    !/^bts_[A-Za-z0-9_-]{43,128}$/.test(token)
  ) throw new ChatCliError('Bridge task activation did not return the exact requested task session');
  return token;
}

async function defaultActivateTask(options) {
  const entry=fileURLToPath(new URL('../bin/bridge-task.mjs',import.meta.url));
  let stdout;
  try {
    const result=await execFileAsync(process.execPath,[
      entry,'activate',options.task,options.dispatch,'--json','--show-session-token'
    ],{
      windowsHide:true,
      timeout:options.timeoutSeconds*1000,
      maxBuffer:MAX_OUTPUT_BYTES,
      encoding:'utf8'
    });
    stdout=result.stdout;
  } catch {
    throw new ChatCliError('Bridge task activation failed');
  }
  return parseTaskActivation(stdout,options);
}

export async function createChat(options,{runOpenCli=defaultOpenCli}={}) {
  const timeoutMs=options.timeoutSeconds*1000;
  if(options.model!==null) {
    await runOpenCli(['chatgpt','model',options.model,'-f','json'],{timeoutMs});
  }
  const stdout=await runOpenCli([
    'chatgpt','ask',options.prompt,
    '--new','true','--wait','true','-f','json'
  ],{timeoutMs});
  return {
    status:'created',
    ...parseConversationResult(stdout),
    model:options.model
  };
}

export async function sendChat(options,{runOpenCli=defaultOpenCli}={}) {
  const stdout=await runOpenCli([
    'chatgpt','ask',options.prompt,
    '--conversation',options.conversationId,
    '--wait','false','-f','json'
  ],{timeoutMs:options.timeoutSeconds*1000});
  return {
    status:'sent',
    ...parseConversationResult(stdout,options.conversationId),
    model:null
  };
}

export async function activateChat(options,{
  runOpenCli=defaultOpenCli,
  activateTask=defaultActivateTask
}={}) {
  const taskSessionToken=await activateTask(options);
  const activationPrompt=`${options.prompt}\n\nTask session token for this lease: ${taskSessionToken}`;
  let sent;
  try {
    sent=await sendChat({...options,prompt:activationPrompt},{runOpenCli});
  } catch {
    throw new ChatCliError('Bridge activation was consumed but browser delivery failed; wait for lease expiry before retrying');
  }
  return {
    ...sent,
    status:'activated-and-sent'
  };
}

function preflightPrompt(nonce,repository) {
  return [
    'Complete this task in the current ordinary Chat mode. Do not request or attempt a switch to Work or Codex mode.',
    `Before starting repository work, call bridge.get_repository_configuration for ${repository}. If that call succeeds for the same repository, reply with exactly one plain-text line: BRIDGEREADY|${nonce}. If the action is absent or fails, reply exactly: BRIDGEUNAVAILABLE|${nonce}. Then stop.`
  ].join('\n');
}

function parseLatestAssistant(stdout) {
  let rows;
  try {
    rows=JSON.parse(String(stdout));
  } catch {
    throw new ChatCliError('OpenCLI returned malformed ChatGPT detail JSON');
  }
  const values=Array.isArray(rows) ? rows : [rows];
  const assistants=values.filter(row=>String(row?.role ?? row?.Role ?? '').toLowerCase()==='assistant');
  const row=assistants.at(-1);
  if(!row) return {text:'',generating:null};
  const rawGenerating=row?.generating ?? row?.Generating;
  return {
    text:String(row?.text ?? row?.Text ?? '').trim(),
    generating:typeof rawGenerating==='boolean' ? rawGenerating : null
  };
}

export async function launchChat(options,{
  runOpenCli=defaultOpenCli,
  activateTask=defaultActivateTask,
  nonceFactory=randomUUID,
  sleep=delay,
  now=Date.now
}={}) {
  const nonce=String(nonceFactory()).replace(/[^A-Za-z0-9]/g,'').slice(0,8);
  if(nonce.length<8) throw new ChatCliError('Chat readiness nonce is invalid');
  const repository=options.task.slice(0,options.task.lastIndexOf('#'));
  const timeoutMs=options.timeoutSeconds*1000;
  const deadline=now()+timeoutMs;
  const stdout=await runOpenCli([
    'chatgpt','ask',preflightPrompt(nonce,repository),
    '--new','true','--wait','false','-f','json'
  ],{timeoutMs});
  const carrier=parseConversationEnvelope(stdout);
  let readiness={text:'',generating:null};
  while(now()<deadline) {
    const remaining=deadline-now();
    const detail=await runOpenCli([
      'chatgpt','detail',carrier.conversationId,
      '--markdown','true','--wait','false','-f','json'
    ],{timeoutMs:Math.max(1,Math.min(10_000,remaining))});
    readiness=parseLatestAssistant(detail);
    if(readiness.generating===false) break;
    await sleep(Math.min(1_000,Math.max(1,deadline-now())));
  }
  if(readiness.generating!==false) {
    throw new ChatCliError('Chat carrier readiness did not stabilize; dispatch was not consumed');
  }
  const response=readiness.text;
  if(response===`BRIDGEUNAVAILABLE|${nonce}`) {
    throw new ChatCliError('Chat carrier does not expose the required Bridge action surface; dispatch was not consumed');
  }
  if(response!==`BRIDGEREADY|${nonce}`) {
    throw new ChatCliError('Chat carrier readiness response was missing or ambiguous; dispatch was not consumed');
  }
  const activated=await activateChat({
    ...options,
    conversationId:carrier.conversationId
  },{runOpenCli,activateTask});
  return {
    ...activated,
    status:'launched'
  };
}

function writeHuman(stream,result) {
  stream.write(`status: ${result.status}\n`);
  stream.write(`conversationId: ${result.conversationId}\n`);
  stream.write(`conversationUrl: ${result.conversationUrl}\n`);
  if(result.model!==null) stream.write(`model: ${result.model}\n`);
}

export async function runChatCli(argv,{
  stdout=process.stdout,
  runOpenCli,
  readStdin=defaultReadStdin,
  activateTask,
  nonceFactory
}={}) {
  const options=parseArgs(argv);
  if(options.promptFromStdin) options.prompt=normalizePrompt(await readStdin());
  let result;
  if(options.command==='create') result=await createChat(options,{runOpenCli});
  else if(options.command==='send') result=await sendChat(options,{runOpenCli});
  else if(options.command==='activate') result=await activateChat(options,{runOpenCli,activateTask});
  else result=await launchChat(options,{runOpenCli,activateTask,nonceFactory});
  if(options.json) stdout.write(JSON.stringify(result)+'\n');
  else writeHuman(stdout,result);
  return result;
}

export async function main(argv=process.argv.slice(2),dependencies={}) {
  const stderr=dependencies.stderr ?? process.stderr;
  try {
    await runChatCli(argv,dependencies);
    return 0;
  } catch(error) {
    const message=error instanceof ChatCliError ? error.message : 'Unexpected bridge-chat failure';
    stderr.write(`bridge-chat: ${message}\n`);
    return 1;
  }
}
