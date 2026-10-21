import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateChat,
  createChat,
  launchChat,
  main,
  parseArgs,
  parseConversationTarget,
  parseCreateResult,
  parseTaskActivation,
  runChatCli,
  sendChat
} from '../src/chat-cli.mjs';

function stream() {
  let value='';
  return {
    target:{write(text) { value+=text; }},
    value:()=>value
  };
}

test('create sends one bounded OpenCLI ChatGPT command and returns exact identity',async()=>{
  const calls=[];
  const result=await createChat({
    prompt:'Read the durable task and wait.',model:null,timeoutSeconds:60
  },{
    runOpenCli:async(args,options)=>{
      calls.push({args,options});
      return JSON.stringify([{
        conversationId:'6ab1e2e4-dc48-83ec-b9d5-23e0c4c6625c',
        conversationUrl:'https://chatgpt.com/c/6ab1e2e4-dc48-83ec-b9d5-23e0c4c6625c',
        response:''
      }]);
    }
  });
  assert.deepEqual(calls,[{
    args:[
      'chatgpt','ask','Read the durable task and wait.',
      '--new','true','--wait','true','-f','json'
    ],
    options:{timeoutMs:60_000}
  }]);
  assert.deepEqual(result,{
    status:'created',
    conversationId:'6ab1e2e4-dc48-83ec-b9d5-23e0c4c6625c',
    conversationUrl:'https://chatgpt.com/c/6ab1e2e4-dc48-83ec-b9d5-23e0c4c6625c',
    model:null
  });
});

test('optional model is selected before creating the chat',async()=>{
  const calls=[];
  await createChat({prompt:'hello',model:'advanced',timeoutSeconds:30},{
    runOpenCli:async(args)=>{
      calls.push(args);
      if(args[1]==='model') return '[]';
      return JSON.stringify([{
        conversationId:'conversation_1234',
        conversationUrl:'https://chatgpt.com/c/conversation_1234'
      }]);
    }
  });
  assert.deepEqual(calls[0],['chatgpt','model','advanced','-f','json']);
  assert.equal(calls[1][1],'ask');
});

test('arguments fail closed before browser execution',async()=>{
  assert.throws(()=>parseArgs(['create']),/--prompt or --prompt-stdin is required/);
  assert.throws(()=>parseArgs(['create','--prompt','x','--model','invented']),/--model must be one of/);
  assert.throws(()=>parseArgs(['create','--prompt','x','--timeout','2']),/10 to 300/);
  assert.throws(()=>parseArgs(['create','secret-value']),/Unknown option: <argument>/);
  assert.throws(()=>parseArgs(['create','--prompt','x','--conversation','abcdefgh']),/valid only with send/);
  assert.throws(()=>parseArgs(['send','--prompt','x']),/--conversation is required/);
  assert.throws(()=>parseArgs(['send','--prompt','x','--conversation','abcdefgh','--model','advanced']),/valid only with create/);
  assert.throws(()=>parseArgs(['send','--prompt','x','--prompt-stdin','--conversation','abcdefgh']),/exactly one/);
  assert.throws(()=>parseArgs(['activate','--prompt','x','--conversation','abcdefgh']),/--task must/);
  assert.throws(()=>parseArgs(['activate','--prompt','x','--conversation','abcdefgh','--task','owner/repo#147']),/--dispatch must/);
  assert.throws(()=>parseArgs(['launch','--prompt','x','--conversation','abcdefgh','--task','owner/repo#147','--dispatch','dispatch-12345678-1234-1234-1234-123456789abc']),/not valid with launch/);
  assert.throws(()=>parseArgs(['launch','--prompt','x','--task','owner/repo#147']),/--dispatch must/);
});

test('conversation target accepts only an exact ChatGPT id or conversation URL',()=>{
  assert.equal(parseConversationTarget('conversation_1234'),'conversation_1234');
  assert.equal(
    parseConversationTarget('https://chatgpt.com/c/conversation_1234'),
    'conversation_1234'
  );
  assert.throws(()=>parseConversationTarget('https://evil.test/c/conversation_1234'),/ChatGPT conversation/);
  assert.throws(()=>parseConversationTarget('https://chatgpt.com/g/g-p-project/c/conversation_1234'),/ChatGPT conversation/);
});

test('send continues the exact conversation through OpenCLI browser transport',async()=>{
  const calls=[];
  const result=await sendChat({
    prompt:'Continue from the durable checkpoint.',
    conversationId:'conversation_1234',
    timeoutSeconds:60
  },{
    runOpenCli:async(args,options)=>{
      calls.push({args,options});
      return JSON.stringify([{
        conversationId:'conversation_1234',
        conversationUrl:'https://chatgpt.com/c/conversation_1234'
      }]);
    }
  });
  assert.deepEqual(calls,[{
    args:[
      'chatgpt','ask','Continue from the durable checkpoint.',
      '--conversation','conversation_1234',
      '--wait','false','-f','json'
    ],
    options:{timeoutMs:60_000}
  }]);
  assert.deepEqual(result,{
    status:'sent',
    conversationId:'conversation_1234',
    conversationUrl:'https://chatgpt.com/c/conversation_1234',
    model:null
  });
});

test('send rejects browser navigation drift to a different conversation',async()=>{
  await assert.rejects(
    ()=>sendChat({
      prompt:'continue',conversationId:'conversation_1234',timeoutSeconds:60
    },{
      runOpenCli:async()=>JSON.stringify([{
        conversationId:'conversation_5678',
        conversationUrl:'https://chatgpt.com/c/conversation_5678'
      }])
    }),
    /different ChatGPT conversation identity/
  );
});

test('activate consumes dispatch and sends the token only inside the browser prompt',async()=>{
  const calls=[];
  const token=`bts_${'a'.repeat(43)}`;
  const options={
    prompt:'Recover from GitHub durable truth.',
    conversationId:'conversation_1234',
    task:'owner/repo#147',
    dispatch:'dispatch-12345678-1234-1234-1234-123456789abc',
    timeoutSeconds:60
  };
  const result=await activateChat(options,{
    activateTask:async(received)=>{
      assert.equal(received,options);
      return token;
    },
    runOpenCli:async(args)=>{
      calls.push(args);
      return JSON.stringify([{
        conversationId:'conversation_1234',
        conversationUrl:'https://chatgpt.com/c/conversation_1234'
      }]);
    }
  });
  assert.match(calls[0][2],/Recover from GitHub durable truth/);
  assert.match(calls[0][2],new RegExp(token));
  assert.equal(result.status,'activated-and-sent');
  assert.doesNotMatch(JSON.stringify(result),new RegExp(token));
});

test('activate reports consumed delivery failure without leaking the token',async()=>{
  const token=`bts_${'b'.repeat(43)}`;
  await assert.rejects(
    ()=>activateChat({
      prompt:'recover',conversationId:'conversation_1234',timeoutSeconds:60
    },{
      activateTask:async()=>token,
      runOpenCli:async()=>{ throw new Error(token); }
    }),
    error=>{
      assert.match(error.message,/activation was consumed/);
      assert.doesNotMatch(error.message,new RegExp(token));
      return true;
    }
  );
});

test('task activation parser binds the token to the requested live task envelope',()=>{
  const options={task:'owner/repo#147'};
  const valid={
    status:'ACTIVATED',taskKey:options.task,workerId:'worker-12345678',
    leaseEpoch:9,leaseExpiresAt:'2030-01-01T00:15:00.000Z',
    taskSessionToken:`bts_${'a'.repeat(43)}`
  };
  assert.equal(
    parseTaskActivation(JSON.stringify(valid),options,{now:()=>Date.parse('2029-01-01')}),
    valid.taskSessionToken
  );
  assert.throws(
    ()=>parseTaskActivation(JSON.stringify({...valid,taskKey:'owner/repo#148'}),options,{now:()=>Date.parse('2029-01-01')}),
    /exact requested task session/
  );
  assert.throws(
    ()=>parseTaskActivation(JSON.stringify({...valid,leaseExpiresAt:'2028-01-01'}),options,{now:()=>Date.parse('2029-01-01')}),
    /exact requested task session/
  );
});

test('launch preflights a fresh Chat before consuming the dispatch',async()=>{
  const calls=[];
  const token=`bts_${'c'.repeat(43)}`;
  let activationCalls=0;
  const result=await launchChat({
    prompt:'Recover durable truth and continue.',
    task:'owner/repo#147',
    dispatch:'dispatch-12345678-1234-1234-1234-123456789abc',
    timeoutSeconds:60
  },{
      nonceFactory:()=> 'abc12345',
    activateTask:async()=>{
      activationCalls++;
      return token;
    },
    runOpenCli:async(args,options)=>{
      calls.push({args,options});
      if(args.includes('--new')) {
        assert.match(args[2],/bridge\.get_repository_configuration/);
        assert.match(args[2],/BRIDGEREADY\|abc12345/);
        return JSON.stringify([{
          conversationId:'conversation_1234',
          conversationUrl:'https://chatgpt.com/c/conversation_1234'
        }]);
      }
      if(args[1]==='detail') {
        return JSON.stringify([{
          Role:'assistant',Text:'BRIDGEREADY|abc12345',Generating:false
        }]);
      }
      assert.match(args[2],/Recover durable truth/);
      assert.match(args[2],new RegExp(token));
      return JSON.stringify([{
        conversationId:'conversation_1234',
        conversationUrl:'https://chatgpt.com/c/conversation_1234'
      }]);
    }
  });
  assert.equal(activationCalls,1);
  assert.equal(calls.length,3);
  assert.deepEqual(calls[0].args.slice(-6),['--new','true','--wait','false','-f','json']);
  assert.equal(calls[1].args[1],'detail');
  assert.equal(result.status,'launched');
  assert.equal(result.conversationId,'conversation_1234');
  assert.doesNotMatch(JSON.stringify(result),new RegExp(token));
});

test('launch rejects a carrier without Bridge actions before activation',async()=>{
  let activationCalls=0;
  await assert.rejects(
    ()=>launchChat({
      prompt:'recover',task:'owner/repo#147',
      dispatch:'dispatch-12345678-1234-1234-1234-123456789abc',
      timeoutSeconds:60
    },{
      nonceFactory:()=> 'def67890',
      activateTask:async()=>{
        activationCalls++;
        return `bts_${'d'.repeat(43)}`;
      },
      runOpenCli:async(args)=>args[1]==='detail' ? JSON.stringify([{
        Role:'assistant',Text:'BRIDGEUNAVAILABLE|def67890',Generating:false
      }]) : JSON.stringify([{
        conversationId:'conversation_5678',
        conversationUrl:'https://chatgpt.com/c/conversation_5678'
      }])
    }),
    /does not expose the required Bridge action surface/
  );
  assert.equal(activationCalls,0);
});

test('launch fails closed on an ambiguous readiness reply',async()=>{
  let activationCalls=0;
  await assert.rejects(
    ()=>launchChat({
      prompt:'recover',task:'owner/repo#147',
      dispatch:'dispatch-12345678-1234-1234-1234-123456789abc',
      timeoutSeconds:60
    },{
      nonceFactory:()=> 'ghi13579',
      activateTask:async()=>{
        activationCalls++;
        return `bts_${'e'.repeat(43)}`;
      },
      runOpenCli:async(args)=>args[1]==='detail' ? JSON.stringify([{
        Role:'assistant',Text:'READY',Generating:false
      }]) : JSON.stringify([{
        conversationId:'conversation_9999',
        conversationUrl:'https://chatgpt.com/c/conversation_9999'
      }])
    }),
    /readiness response was missing or ambiguous/
  );
  assert.equal(activationCalls,0);
});

test('launch never consumes a dispatch while the carrier is still generating',async()=>{
  let activationCalls=0;
  let clock=0;
  await assert.rejects(
    ()=>launchChat({
      prompt:'recover',task:'owner/repo#147',
      dispatch:'dispatch-12345678-1234-1234-1234-123456789abc',
      timeoutSeconds:60
    },{
      nonceFactory:()=> 'jkl24680',
      now:()=>clock,
      sleep:async()=>{ clock=60_000; },
      activateTask:async()=>{
        activationCalls++;
        return `bts_${'f'.repeat(43)}`;
      },
      runOpenCli:async(args)=>args[1]==='detail' ? JSON.stringify([{
        Role:'assistant',Text:'BRIDGEREADY|jkl24680',Generating:true
      }]) : JSON.stringify([{
        conversationId:'conversation_busy',
        conversationUrl:'https://chatgpt.com/c/conversation_busy'
      }])
    }),
    /readiness did not stabilize/
  );
  assert.equal(activationCalls,0);
});

test('result parser accepts only matching chatgpt.com conversation identity',()=>{
  assert.throws(
    ()=>parseCreateResult(JSON.stringify([{conversationId:'abcdefgh',conversationUrl:'https://evil.test/c/abcdefgh'}])),
    /invalid ChatGPT conversation identity/
  );
  assert.throws(
    ()=>parseCreateResult(JSON.stringify([{conversationId:'abcdefgh',conversationUrl:'https://chatgpt.com/c/different'}])),
    /invalid ChatGPT conversation identity/
  );
  assert.throws(()=>parseCreateResult('not json'),/malformed JSON/);
});

test('json output omits prompt and keeps a stable contract',async()=>{
  const output=stream();
  const prompt='private bootstrap instruction';
  await runChatCli(['create','--prompt',prompt,'--json'],{
    stdout:output.target,
    runOpenCli:async()=>JSON.stringify([{
      conversationId:'conversation_5678',
      conversationUrl:'https://chatgpt.com/c/conversation_5678'
    }])
  });
  const value=JSON.parse(output.value());
  assert.equal(value.conversationId,'conversation_5678');
  assert.doesNotMatch(output.value(),new RegExp(prompt));
});

test('send json output omits activation material',async()=>{
  const output=stream();
  const prompt='private activation material';
  await runChatCli([
    'send','--conversation','conversation_5678','--prompt',prompt,'--json'
  ],{
    stdout:output.target,
    runOpenCli:async()=>JSON.stringify([{
      conversationId:'conversation_5678',
      conversationUrl:'https://chatgpt.com/c/conversation_5678'
    }])
  });
  assert.equal(JSON.parse(output.value()).status,'sent');
  assert.doesNotMatch(output.value(),new RegExp(prompt));
});

test('prompt stdin keeps activation material out of argv and output',async()=>{
  const output=stream();
  const prompt='short-lived activation material';
  const calls=[];
  await runChatCli([
    'send','--conversation','conversation_5678','--prompt-stdin','--json'
  ],{
    stdout:output.target,
    readStdin:async()=>prompt,
    runOpenCli:async(args)=>{
      calls.push(args);
      return JSON.stringify([{
        conversationId:'conversation_5678',
        conversationUrl:'https://chatgpt.com/c/conversation_5678'
      }]);
    }
  });
  assert.equal(calls[0][2],prompt);
  assert.doesNotMatch(JSON.stringify([
    'send','--conversation','conversation_5678','--prompt-stdin','--json'
  ]),new RegExp(prompt));
  assert.doesNotMatch(output.value(),new RegExp(prompt));
});

test('runtime errors do not echo the prompt',async()=>{
  const error=stream();
  const prompt='do-not-echo-this-instruction';
  const code=await main(['create','--prompt',prompt],{
    stderr:error.target,
    stdout:stream().target,
    runOpenCli:async()=>{ throw new Error(prompt); }
  });
  assert.equal(code,1);
  assert.doesNotMatch(error.value(),new RegExp(prompt));
  assert.match(error.value(),/Unexpected bridge-chat failure/);
});
