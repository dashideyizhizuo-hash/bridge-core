import path from 'node:path';

// Guard destructive packaging cleanup. Windows relative() returns an absolute
// path across volumes; that means disjoint trees, not an ancestor relationship.
export function assertPackageOutput(source,output,paths=path) {
  const back=paths.relative(output,source);
  const outside=paths.isAbsolute(back) || back==='..' || back.startsWith('..'+paths.sep);
  if(!outside) throw new Error('package output must not contain the source repository');
}
