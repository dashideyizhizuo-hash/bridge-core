#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { zipSync, strToU8 } from "fflate";

const root = process.cwd();
const plugin = JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8"));
let app = JSON.parse(await readFile(path.join(root, ".app.json"), "utf8"));

if (!plugin?.name || !plugin?.version) {
  throw new Error("plugin.json must contain name and version");
}

if(process.env.BRIDGE_APP_ID) app={apps:{bridge:{id:process.env.BRIDGE_APP_ID,required:true}}};
if(Object.keys(app?.apps??{}).length===0) throw new Error('Set BRIDGE_APP_ID to your own connected App ID before packaging');
const appIds = Object.values(app?.apps ?? {}).map((entry) => entry?.id).filter(Boolean);
for (const id of appIds) {
  if (!/^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(`Unsupported .app.json id format: ${id}`);
  }
}

async function collect(dir, prefix = "") {
  const out = {};
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = await stat(full);
    if (info.isDirectory()) Object.assign(out, await collect(full, rel));
    else out[rel.replaceAll("\\", "/")] = new Uint8Array(await readFile(full));
  }
  return out;
}

const files = {
  "plugin.json": strToU8(JSON.stringify(plugin, null, 2) + "\n"),
  ".app.json": strToU8(JSON.stringify(app, null, 2) + "\n"),
  ...(await collect(path.join(root, "skills"), "skills")),
  ...(await collect(path.join(root, "assets"), "assets")),
};

const outputDir = path.join(root, "dist");
await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, `${plugin.name}-plugin-${plugin.version}.zip`);
await writeFile(output, zipSync(files, { level: 9 }));

console.log(output);
