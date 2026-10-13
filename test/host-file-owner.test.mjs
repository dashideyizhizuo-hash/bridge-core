import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHostDirectory, writeHostFile, readHostFile } from '../src/host-files.mjs';
import { hostPowerShell } from '../src/host-platform.mjs';

test('new Windows credential files explicitly belong to current SID even under an elevated default owner',
  {skip:process.platform!=='win32'},t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-file-owner-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'private');ensureHostDirectory(dir);
  const file=join(dir,'credential');writeHostFile(file,'test-only-content');
  const ownership=hostPowerShell(`$acl=Get-Acl -LiteralPath $d.path; @{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected=$acl.AreAccessRulesProtected}|ConvertTo-Json -Compress`,{path:file});
  assert.equal(ownership.owner,ownership.current);
  assert.equal(ownership.protected,true);
  assert.equal(readHostFile(file),'test-only-content');
  assert.throws(()=>writeHostFile(file,'overwritten'));
  assert.equal(readFileSync(file,'utf8'),'test-only-content');
});
