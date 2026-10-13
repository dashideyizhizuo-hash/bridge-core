#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function filesUnder(root) {
  const out=[];
  const visit=dir=>{
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=resolve(dir,entry.name);
      if(entry.isDirectory()) visit(path);
      else if(entry.isFile() && entry.name.endsWith('.mjs')) out.push(path);
    }
  };
  visit(resolve(root));
  return out;
}

const files=[...filesUnder('bin'),...filesUnder('src')];
for(const file of files) {
  const checked=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(checked.error) throw checked.error;
  if(checked.status!==0) process.exit(checked.status ?? 1);
}
process.stdout.write(JSON.stringify({ok:true,files:files.length})+'\n');
