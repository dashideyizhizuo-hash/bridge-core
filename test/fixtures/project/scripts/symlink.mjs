import {mkdirSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
mkdirSync('bridge-output',{recursive:true});
if(process.platform==='win32')symlinkSync(resolve('.bridge'),'bridge-output/escape','junction');
else symlinkSync('../.bridge/project.json','bridge-output/escape');
