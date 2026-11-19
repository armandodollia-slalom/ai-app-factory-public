// A test file that leaves temp directories behind and fails, for the temp guard test (test-temp.test.mjs). Not run by
// `npm test` (not *.test.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('leaks and fails', () => {
  fs.writeFileSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leak-')), 'x'), 'x');
  spawnSync(process.execPath, ['-e', "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'child-leak-'))"]);
  fs.writeFileSync(process.env.LEAKY_REPORT, JSON.stringify({ tmp: os.tmpdir() }));
  throw new Error('this fixture fails on purpose');
});
