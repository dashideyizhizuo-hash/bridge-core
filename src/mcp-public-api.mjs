import {assertBridge} from './errors.mjs';
import {assertDirectFileArgv} from './direct-exec.mjs';
import {directWaitSeconds,waitForDirectResult} from './direct-run-wait.mjs';

const REPOSITORY_FIELDS=['repository','targetRef','targetSha','expectedPolicySha'];
const REPOSITORY_REQUIRED=['repository','targetRef','expectedPolicySha'];
const COMMAND_FIELDS=['id','argv','cwd','resources','timeoutSeconds'];
const DIRECT_FIELDS=['argv','cwd','timeoutSeconds','assets','exports'];
// This is an explicit translator, not a capability-name or mode dispatcher.
// The HTTP layer validates each input schema and resolves taskSessionToken
// before invoking it. Unknown fields are still rejected here, never forwarded.
const INPUTS=Object.freeze({
  'bridge.list_hosts':[[],[]],
  'bridge.create_host_pairing':[['ttlSeconds'],[]],
  'bridge.pause_host':[['hostId'],['hostId']],
  'bridge.resume_host':[['hostId'],['hostId']],
  'bridge.run_host_command':[['hostId',...DIRECT_FIELDS,'waitSeconds'],['hostId','argv']],
  'bridge.import_file':[['file','ttlSeconds'],['file']],
  'bridge.create_file_upload':[['fileName','mimeType','sizeBytes','sha256','ttlSeconds'],['fileName','mimeType','sizeBytes','sha256']],
  'bridge.delete_file':[['assetId'],['assetId']],
  'bridge.get_repository_configuration':[['repository'],['repository']],
  'bridge.execute_repository_commands':[[...REPOSITORY_FIELDS,'commands'],[...REPOSITORY_REQUIRED,'commands']],
  'bridge.verify_repository':[REPOSITORY_FIELDS,REPOSITORY_REQUIRED],
  'bridge.edit_and_verify_repository':[[...REPOSITORY_FIELDS,'operations','commitSubject'],[...REPOSITORY_REQUIRED,'operations','commitSubject']],
  'bridge.get_run':[['runId'],['runId']],
  'bridge.get_result':[['runId'],['runId']],
  'bridge.publish':[['runId'],['runId']],
  'bridge.task_transition':[['outcome','checkpointSha','stateCommentId','continue','reasonCode'],['outcome']]
});

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fieldsOnly(args,allowed,required=[]){
  assertBridge(isObject(args),'INVALID_MCP_ARGUMENTS','Tool arguments must be an object');
  for(const key of Object.keys(args))assertBridge(allowed.includes(key),'INVALID_MCP_ARGUMENTS',`Unsupported tool argument: ${key}`);
  for(const key of required)assertBridge(Object.hasOwn(args,key)&&args[key]!==undefined,'INVALID_MCP_ARGUMENTS',`Required tool argument: ${key}`);
}
function pick(value,fields){
  const result={};
  for(const key of fields)if(Object.hasOwn(value,key)&&value[key]!==undefined)result[key]=value[key];
  return result;
}
function call(gateway,method,args){
  assertBridge(gateway&&typeof gateway[method]==='function',
    method==='transitionTask'?'TASK_SESSION_REQUIRED':'GATEWAY_CONFIG_INVALID',
    method==='transitionTask'?'An active durable task session is required':`Gateway missing method: ${method}`);
  return gateway[method](args);
}

export async function invokePublicTool(gateway,toolName,args={}, {signal}={}){
  assertBridge(Object.hasOwn(INPUTS,toolName),'UNKNOWN_MCP_TOOL',`Unknown MCP tool: ${toolName}`);
  fieldsOnly(args,...INPUTS[toolName]);
  switch(toolName){
    case 'bridge.list_hosts':
      return pick(await call(gateway,'discover',{}),['direct']);
    case 'bridge.create_host_pairing':
      return call(gateway,'run',{mode:'connect',...pick(args,['ttlSeconds'])});
    case 'bridge.pause_host':
    case 'bridge.resume_host':
      return call(gateway,'run',{mode:'host',host:args.hostId,enabled:toolName==='bridge.resume_host'});
    case 'bridge.run_host_command':{
      assertDirectFileArgv(args.argv);
      const seconds=directWaitSeconds({mode:'direct',...pick(args,['waitSeconds'])});
      const receipt=await call(gateway,'run',{mode:'direct',host:args.hostId,...pick(args,DIRECT_FIELDS)});
      return seconds===0?receipt:waitForDirectResult(gateway,receipt,seconds,{signal});
    }
    case 'bridge.import_file':
      return call(gateway,'run',{mode:'asset',...pick(args,['file','ttlSeconds'])});
    case 'bridge.create_file_upload':
      return call(gateway,'run',{mode:'asset',...pick(args,['fileName','mimeType','sizeBytes','sha256','ttlSeconds'])});
    case 'bridge.delete_file':
      return call(gateway,'run',{mode:'asset',assetAction:'delete',assetId:args.assetId});
    case 'bridge.get_repository_configuration':
      return pick(await call(gateway,'discover',{repository:args.repository,...(signal?{signal}:{})}),['repository','policy','capabilities','exec','workspaceExec','editing','mcp']);
    case 'bridge.execute_repository_commands':{
      assertBridge(Array.isArray(args.commands)&&args.commands.length>=1&&args.commands.length<=16,'INVALID_MCP_ARGUMENTS','Repository commands must contain 1-16 command records');
      const steps=args.commands.map(command=>{
        fieldsOnly(command,COMMAND_FIELDS,['id','argv']);
        return {...pick(command,COMMAND_FIELDS),type:'exec'};
      });
      return call(gateway,'run',{mode:'batch',...pick(args,REPOSITORY_FIELDS),steps});
    }
    case 'bridge.verify_repository':
      return call(gateway,'run',{mode:'batch',...pick(args,REPOSITORY_FIELDS),trustedVerification:true});
    case 'bridge.edit_and_verify_repository':
      return call(gateway,'run',{mode:'edit',...pick(args,[...REPOSITORY_FIELDS,'operations','commitSubject']),trustedVerification:true});
    case 'bridge.get_run':
      return call(gateway,'getRun',{runId:args.runId});
    case 'bridge.get_result':
      return call(gateway,'getResult',{runId:args.runId});
    case 'bridge.publish':
      return call(gateway,'publish',{runId:args.runId});
    case 'bridge.task_transition':
      return call(gateway,'transitionTask',pick(args,INPUTS[toolName][0]));
  }
}
