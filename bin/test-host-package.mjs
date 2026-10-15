#!/usr/bin/env node
// Real npm pack + npx test in an empty consumer directory. No registry publish,
// production login, host claim, user-service mutation or private-repo access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HOST_VERSION, HOST_PACKAGE_FILES, HOST_PACKAGE_NAME, HOST_SDK_VERSION } from '../src/host-package-spec.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-npx-consumer-')));
const pkg=join(root,'build'),consumer=join(root,'consumer'),installConsumer=join(root,'installed-consumer'),cache=join(root,'npm-cache');
const home=join(root,'home');
mkdirSync(consumer);mkdirSync(installConsumer);mkdirSync(home);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|GITHUB|^GH_/i.test(key)));
Object.assign(env,{HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),
  XDG_STATE_HOME:join(home,'state'),npm_config_cache:cache,npm_config_userconfig:join(home,'npmrc'),
  npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'});
writeFileSync(env.npm_config_userconfig,'');
function run(command,args,{cwd=consumer,status=0}={}) {
  if(process.platform==='win32' && ['npm','npx'].includes(command)) {
    const cli=join(dirname(process.execPath),'node_modules/npm/bin',command==='npm' ? 'npm-cli.js' : 'npx-cli.js');
    assert.ok(existsSync(cli),'Node distribution must contain the npm CLI');
    args=[cli,...args];command=process.execPath;
  }
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:180_000,maxBuffer:4*1024*1024});
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,status,`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  run(process.execPath,[join(repository,'bin/package-host.mjs'),'--output',pkg]);
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:pkg}));
  assert.equal(packed.length,1);
  // Assert actual packed contents, not only the staging directory. New private
  // files or dependencies must not silently enter the customer artifact.
  assert.deepEqual(packed[0].files.map(file=>file.path).sort(),[...HOST_PACKAGE_FILES,'README.md','package.json'].sort());
  for(const file of packed[0].files) {
    assert.doesNotMatch(file.path,/(?:^|\/)(?:commercial|billing|migrations|\.git|\.env|\.dev\.vars|node_modules)(?:[./-]|$)|(?:stripe|wrangler)|\.(?:pem|key|pfx)$/i);
  }
  const tarball=join(root,packed[0].filename);
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',tarball],{cwd:installConsumer});
  const customerPackage=join(installConsumer,'node_modules',HOST_PACKAGE_NAME);
  const manifest=JSON.parse(readFileSync(join(customerPackage,'package.json'),'utf8'));
  assert.equal(manifest.name,HOST_PACKAGE_NAME);
  assert.equal(manifest.version,HOST_VERSION);
  assert.equal(manifest.license,'Elastic-2.0');
  assert.match(readFileSync(join(customerPackage,'LICENSE'),'utf8'),/^Elastic License 2.0/);
  assert.deepEqual(manifest.dependencies,{'@modelcontextprotocol/client':HOST_SDK_VERSION});
  assert.equal(manifest.scripts,undefined,'installation must not run lifecycle scripts');
  assert.deepEqual(manifest.bin,{'bridge-host':'./bin/bridge-host.mjs'});
  assert.ok(existsSync(join(installConsumer,'node_modules/.bin',process.platform==='win32' ? 'bridge-host.cmd' : 'bridge-host')));
  // Resolve the command through npm's real local bin shims, with registry access
  // disabled. A missing package must not be replaced by a downloaded namesake.
  assert.equal(run('npm',['exec','--offline','--no','--','bridge-host','--version'],{cwd:installConsumer}).trim(),HOST_VERSION);
  const npxArgs=['--yes','--ignore-scripts','--cache',cache,'--package',tarball,'bridge-host'];
  const version=run('npx',[...npxArgs,'--version']).trim();
  assert.equal(version,HOST_VERSION);
  assert.match(run('npx',[...npxArgs,'--help']),/systemd USER service/);
  const status=JSON.parse(run('npx',[...npxArgs,'status','--config-dir',join(home,'isolated-config')]));
  assert.equal(status.installed,false);
  // Run via the installed entry to avoid shell-specific .cmd behavior. No
  // consent means no browser, cloud enrollment or service mutation.
  const noninteractive=spawnSync(process.execPath,[join(customerPackage,'bin/bridge-host.mjs'),'setup'],{cwd:consumer,env,encoding:'utf8',timeout:30_000});
  assert.equal(noninteractive.status,65);
  assert.match(noninteractive.stderr,/HOST_CONSENT_REQUIRED/);
  const caches=readdirSync(join(cache,'_npx'));
  const installed=caches.map(name=>join(cache,'_npx',name,'node_modules',HOST_PACKAGE_NAME))
    .find(path=>existsSync(join(path,'package.json')));
  assert.ok(installed,'npx must install only the standalone Host package');
  // Exercise installed SDK resolution, not the repository's node_modules.
  run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(join(installed,'src/host-login.mjs')).href)});`]);
  const service=await import(pathToFileURL(join(installed,'src/host-service.mjs')).href);
  const paths=service.hostServicePaths(join(home,'isolated-config'),{env,home});
  const daemon=service.stageHostRuntime(paths,{sourceRoot:installed});
  const unit=service.hostServiceUnit({daemonPath:daemon,configDir:paths.configDir,home});
  const unitPath=join(root,'bridge-host.service');writeFileSync(unitPath,unit);
  if(process.platform==='linux') run('systemd-analyze',['verify',unitPath]);
  // Removing the original package/cache cannot break daemon imports. No real
  // credential is supplied, so it exits at argument validation without network.
  rmSync(cache,{recursive:true,force:true});rmSync(pkg,{recursive:true,force:true});
  const daemonResult=spawnSync(process.execPath,[daemon],{cwd:consumer,env,encoding:'utf8',timeout:10_000});
  assert.equal(daemonResult.status,65);
  assert.match(daemonResult.stderr,/config-dir is required/);
  assert.doesNotMatch(daemonResult.stderr,/ERR_MODULE_NOT_FOUND|Cannot find package/);
  const bytes=readFileSync(tarball),sha256=createHash('sha256').update(bytes).digest('hex');
  const out=join(repository,'dist/host-preview');mkdirSync(out,{recursive:true});
  copyFileSync(tarball,join(out,packed[0].filename));
  const evidence={package:packed[0].name,version,filename:packed[0].filename,bytes:bytes.length,sha256,
    node:process.version,platform:process.platform,npmInstall:true,localBinShim:true,packedAllowlist:true,npx:true,help:true,noninteractiveConsent:true,installedSdk:true,
    cacheIndependentDaemon:true,systemdUnitSyntax:process.platform==='linux',
    productionLogin:false,registryPublish:false,realHostServiceChanged:false};
  writeFileSync(join(out,'verification.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {rmSync(root,{recursive:true,force:true});}
