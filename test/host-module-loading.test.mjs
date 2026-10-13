import test from 'node:test';
import assert from 'node:assert/strict';
import { hostPowerShell } from '../src/host-platform.mjs';

test('Windows native helper imports only explicit built-in module manifests before JSON parsing',()=>{
  hostPowerShell('@{ok=$true}|ConvertTo-Json -Compress',{},{exec:(_exe,args)=>{
    const source=Buffer.from(args.at(-1),'base64').toString('utf16le');
    assert.ok(source.includes("$PSModuleAutoLoadingPreference='None'"));
    assert.ok(source.includes("[IO.Path]::Combine($PSHOME,'Modules',$module,($module+'.psd1'))"));
    assert.ok(source.indexOf('Import-Module')<source.indexOf('$d=ConvertFrom-Json'));
    for(const name of ['Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security']) assert.ok(source.includes(name));
    return '{"ok":true}';
  }});
});
