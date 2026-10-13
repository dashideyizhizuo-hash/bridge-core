import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostPowerShell, powershellPath } from '../src/host-platform.mjs';

test('Windows helper closes stdin and pins built-in module resolution without inheriting secrets',()=>{
  const result=hostPowerShell('@{ok=$true}|ConvertTo-Json -Compress',{path:'C:\\test & 中文'},{exec:(exe,args,options)=>{
    assert.equal(exe,powershellPath());
    assert.equal(options.input,'');assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
    assert.equal(options.env.PSModulePath,win32.join(win32.dirname(exe),'Modules'));
    for(const key of ['APPDATA','ProgramFiles','ProgramData','CommonProgramFiles']) assert.equal(options.env[key],process.env[key]);
    assert.equal(options.env.GITHUB_TOKEN,undefined);
    assert.equal(options.env.BRIDGE_DIRECT_RUNNER_TOKEN,undefined);
    assert.equal(options.env.PATH.includes('_npx'),false);
    assert.deepEqual(JSON.parse(options.env.BRIDGE_HOST_DATA),{path:'C:\\test & 中文'});
    const source=Buffer.from(args.at(-1),'base64').toString('utf16le');
    assert.equal(source.includes('C:\\test'),false);assert.match(source,/OutputEncoding/);
    return '{"ok":true}';
  }});
  assert.equal(result.ok,true);
});
test('real Windows helper starts and round-trips Unicode JSON',{skip:process.platform!=='win32'},()=>{
  let result;
  const script='@{ok=$true;value=$d.value}|ConvertTo-Json -Compress';
  const data={value:'private-path & 中文 $HOME'};
  try { result=hostPowerShell(script,data); }
  catch(error) {
    // Test-only bounded differential diagnosis. Inputs contain test constants,
    // never a credential. Do not change or swallow the original failing gate.
    let captured;
    hostPowerShell(script,data,{exec:(exe,args,options)=>{captured={exe,args,options};return '{"ok":true}';}});
    const {exe,args,options}=captured;
    const normal=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|^GH_|^GITHUB_)/i.test(key)));
    normal.BRIDGE_HOST_DATA=options.env.BRIDGE_HOST_DATA;
    const base=['-NoLogo','-NoProfile','-NonInteractive'];
    const source=Buffer.from(args.at(-1),'base64').toString('utf16le');
    const cases=[
      {label:'literal-filtered-env',env:options.env,args:[...base,'-Command','[Console]::Write("bootstrap-ok"); exit 0']},
      {label:'same-encoded-normal-env',env:normal,args},
      {label:'same-source-command-filtered-env',env:options.env,args:[...base,'-Command',source+'; exit 0']},
      {label:'encoded-without-format-options',env:options.env,args:[...base,'-EncodedCommand',args.at(-1)]},
      {label:'encoded-phase-probe',env:options.env,args:[...base,'-EncodedCommand',Buffer.from('[Console]::Error.Write("before;"); '+source.replace('[Console]::OutputEncoding=','[Console]::Error.Write("encoding;"); [Console]::OutputEncoding=').replace('$d=ConvertFrom-Json','[Console]::Error.Write("json;"); $d=ConvertFrom-Json')+'; [Console]::Error.Write("done;"); exit 0','utf16le').toString('base64')]}
    ];
    for(const item of cases) {
      const start=Date.now();
      try {
        const output=execFileSync(exe,item.args,{...options,env:item.env,timeout:5000});
        console.log(JSON.stringify({diagnostic:item.label,completed:true,stdoutBytes:output.length,elapsedMs:Date.now()-start}));
      } catch(cause) {
        console.log(JSON.stringify({diagnostic:item.label,errorCode:cause.code,status:cause.status,
          stdoutBytes:cause.stdout?.length ?? 0,stderrBytes:cause.stderr?.length ?? 0,
          phases:typeof cause.stderr==='string' ? cause.stderr.match(/(?:before|encoding|json|done);/g) : null,elapsedMs:Date.now()-start}));
      }
    }
    throw error;
  }
  assert.deepEqual(result,{ok:true,value:'private-path & 中文 $HOME'});
});
