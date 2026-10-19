import {mkdtempSync,realpathSync} from 'node:fs';
// Tests own this freshly created directory. Resolve OS temp symlinks and
// Windows 8.3 aliases before passing it to the production path boundaries.
export const makeTestDirectory=(prefix)=>realpathSync.native(mkdtempSync(prefix));
