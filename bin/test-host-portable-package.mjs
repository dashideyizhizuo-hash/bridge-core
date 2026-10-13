#!/usr/bin/env node
// Real packed npx CLI -> TLS fixture -> native command -> result round trip.
// The certificate/key and Host credential are public TEST fixtures only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHostDirectory, writeHostFile } from '../src/host-files.mjs';
import { HOST_VERSION } from '../src/host-package-spec.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-native-package-')));
const pkg=join(root,'package'),consumer=join(root,'consumer'),home=join(root,'home'),cache=join(root,'npm-cache');
for(const path of [consumer,home]) mkdirSync(path,{mode:0o700});
const configDir=join(home,'host-config'),state=join(home,'host-state');
ensureHostDirectory(configDir);ensureHostDirectory(state);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|^GH_|^GITHUB_/i.test(key)));
Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_STATE_HOME:state,
  npm_config_cache:cache,npm_config_userconfig:join(home,'npmrc'),npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',
  NODE_EXTRA_CA_CERTS:join(repository,'test/fixtures/host-tls/cert.pem')});
writeFileSync(env.npm_config_userconfig,'');
function npmCommand(name,args) {
  if(process.platform!=='win32') return [name,args];
  const cli=join(dirname(process.execPath),'node_modules/npm/bin',name==='npm' ? 'npm-cli.js' : 'npx-cli.js');
  assert.ok(existsSync(cli),'Node distribution must contain the npm CLI');
  return [process.execPath,[cli,...args]];
}
async function run(command,args,{cwd=consumer,expected=0}={}) {
  const [exe,argv]=['npm','npx'].includes(command) ? npmCommand(command,args) : [command,args];
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,argv,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('Packaged CLI timed out'));},180_000);
    child.stdout.on('data',part=>{out+=part;if(out.length>1048576) child.kill();});
    child.stderr.on('data',part=>{err+=part;if(err.length>1048576) child.kill();});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',status=>{
      clearTimeout(timer);
      try {assert.equal(status,expected,`${command} status ${status}: ${err}\n${out}`);resolve(out);}
      catch(error){reject(error);}
    });
  });
}
const token='t'.repeat(43),hostId='host-native-package-test';
let claims=0;const results=[];
const server=createServer({key:readFileSync(join(repository,'test/fixtures/host-tls/key.pem')),
  cert:readFileSync(join(repository,'test/fixtures/host-tls/cert.pem'))},async(req,res)=>{
  try {
    assert.equal(req.headers.authorization,'Bearer '+token);let raw='';
    for await(const chunk of req){raw+=chunk;assert.ok(raw.length<=1048576);}
    const input=JSON.parse(raw);
    assert.equal(input.hostId,hostId);res.setHeader('content-type','application/json');
    if(req.url==='/direct/runner/claim') {
      claims++;
      res.end(JSON.stringify({leaseOwner:input.leaseOwner,runId:'packed-run-'+claims,
        request:{schemaVersion:1,requestId:'packed-request-'+claims,hostId,timeoutSeconds:10,
          argv:[process.execPath,'-e','console.log("packed:"+process.platform)']}}));
    } else if(req.url==='/direct/runner/complete') {
      results.push(input.result);res.end('{"ok":true}');
    } else throw new Error('Unexpected fixture route');
  } catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
});
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`https://127.0.0.1:${server.address().port}/mcp`;
  writeHostFile(join(configDir,'host.json'),JSON.stringify({version:1,host:{id:hostId},repositories:{},directExec:{enabled:true,
    serviceUser:userInfo().username,root:consumer,stateDir:state,assetDir:join(state,'assets'),maxSeconds:30,resultBytes:1048576}}));
  writeHostFile(join(configDir,'direct-runner.env'),`BRIDGE_PUBLIC_URL=${endpoint}\nBRIDGE_DIRECT_RUNNER_TOKEN=${token}\n`);
  await run(process.execPath,[join(repository,'bin/package-host.mjs'),'--output',pkg]);
  const pack=JSON.parse(await run('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:pkg}))[0];
  const tarball=join(root,pack.filename);
  const npx=['--yes','--ignore-scripts','--cache',cache,'--package',tarball,'bridge-host'];
  assert.equal((await run('npx',[...npx,'--version'])).trim(),HOST_VERSION);
  assert.match(await run('npx',[...npx,'--help']),/foreground/);
  for(let iteration=0;iteration<2;iteration++) {
    const output=await run('npx',[...npx,'setup','--yes','--foreground','--once','--config-dir',configDir]);
    assert.ok(output.includes(hostId));assert.ok(output.includes('SUCCEEDED'));
    assert.equal(output.includes(token),false);assert.equal(output.includes('pairingToken'),false);
  }
  assert.equal(claims,2);assert.equal(results.length,2);
  for(const result of results){assert.equal(result.execution.exitCode,0);assert.equal(result.evidence.stdout.trim(),'packed:'+process.platform);}
  const out=join(repository,'dist/host-preview');mkdirSync(out,{recursive:true});copyFileSync(tarball,join(out,pack.filename));
  const evidence={platform:process.platform,node:process.version,version:HOST_VERSION,
    tarballSha256:createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    realNpx:true,realForegroundCli:true,realTlsTransport:true,realNativeExec:true,reusedHostIdentity:true,
    productionCloud:false,publicRegistryRelease:false};
  writeFileSync(join(out,'portable-package-verification.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} finally {
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  rmSync(root,{recursive:true,force:true});
}
