import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedWithStatus } from '../../review/lib/review.mjs';

// Dogfood C5: the policy got a plain list of changed files and counted a new migration as an edited one.
test('the policy review passes each changed file with its git status against the base', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-status-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'old.cs'), 'a\n');
  fs.writeFileSync(path.join(root, 'gone.cs'), 'a\n');
  g('add', '-A');
  g('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'old.cs'), 'b\n');
  fs.rmSync(path.join(root, 'gone.cs'));
  fs.writeFileSync(path.join(root, 'new.cs'), 'c\n');
  assert.deepEqual(changedWithStatus({ root }, ['old.cs', 'gone.cs', 'new.cs'], base), { 'old.cs': 'M', 'gone.cs': 'D', 'new.cs': 'A' });
  assert.deepEqual(changedWithStatus({ root }, ['x.cs'], null), ['x.cs'], 'no base: the list as it is');
});
