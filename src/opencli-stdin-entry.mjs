import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES=64*1024;

async function readInput() {
  const chunks=[];
  let total=0;
  for await (const chunk of process.stdin) {
    const value=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total+=value.length;
    if(total>MAX_INPUT_BYTES) throw new Error('OpenCLI invocation input is too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const payload=JSON.parse(await readInput());
if(
  !payload ||
  !Array.isArray(payload.args) ||
  payload.args.length<1 ||
  payload.args.length>64 ||
  payload.args.some(value=>typeof value!=='string' || value.length>32*1024)
) {
  throw new Error('OpenCLI invocation input is invalid');
}

const entryUrl=import.meta.resolve('@jackwener/opencli');
process.argv=[process.execPath,fileURLToPath(entryUrl),...payload.args];
await import(entryUrl);
