import {mkdtempSync,realpathSync} from 'node:fs';
// Tests own this freshly created directory. Resolve OS temp aliases before
// passing it to production boundaries that intentionally reject symlinks.
export const makeTestDirectory=(prefix)=>realpathSync(mkdtempSync(prefix));
