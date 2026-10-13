import test from 'node:test';
import assert from 'node:assert/strict';
import { win32, posix } from 'node:path';
import { assertPackageOutput } from '../src/package-output.mjs';

test('packaging permits different Windows volumes and sibling/dist outputs',()=>{
  for(const output of ['C:\\Users\\test\\Temp\\package','D:\\repo\\dist\\host','D:\\other']) {
    assert.doesNotThrow(()=>assertPackageOutput('D:\\repo',output,win32));
  }
  for(const output of ['/tmp/host','/repo/dist/host','/other']) assert.doesNotThrow(()=>assertPackageOutput('/repo',output,posix));
});
test('packaging rejects source itself and ancestors, including Windows case aliases',()=>{
  for(const output of ['D:\\','D:\\repo','d:\\REPO']) assert.throws(()=>assertPackageOutput('D:\\repo',output,win32));
  for(const output of ['/','/repo','/repo/project']) assert.throws(()=>assertPackageOutput('/repo/project',output,posix));
});
