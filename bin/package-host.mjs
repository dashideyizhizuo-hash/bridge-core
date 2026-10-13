#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HOST_PACKAGE_FILES, HOST_PACKAGE_NAME, HOST_SDK_VERSION, HOST_VERSION } from '../src/host-package-spec.mjs';
import { assertPackageOutput } from '../src/package-output.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({args:process.argv.slice(2),strict:true,options:{output:{type:'string'}}});
const output=values.output ? resolve(values.output) : resolve(root,'dist','bridge-host-package');
assertPackageOutput(root,output);
rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});
for(const path of HOST_PACKAGE_FILES){const target=resolve(output,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(resolve(root,path),target);}
chmodSync(resolve(output,'bin/bridge-host.mjs'),0o755);
const manifest={name:HOST_PACKAGE_NAME,version:HOST_VERSION,description:'Cross-platform browser-authorized Bridge Host with foreground and native user-session adapters.',
 type:'module',engines:{node:'>=22'},bin:{'bridge-host':'./bin/bridge-host.mjs'},dependencies:{'@modelcontextprotocol/client':HOST_SDK_VERSION},
 publishConfig:{access:'public'},license:'Elastic-2.0',files:['bin','src','README.md','LICENSE']};
writeFileSync(resolve(output,'package.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(resolve(output,'README.md'),readFileSync(resolve(root,'docs/HOST_QUICKSTART.md')));
process.stdout.write(JSON.stringify({output,package:manifest.name,version:manifest.version,files:HOST_PACKAGE_FILES.length+2})+'\n');
