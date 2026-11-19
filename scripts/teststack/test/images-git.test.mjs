import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitBounded } from '../lib/images.mjs';

// Dogfood C2: `git hash-object --stdin` hung for 21 minutes in a UI verifier's stack rebuild.
test('a git call that does not finish is retried once, then fails with an error instead of blocking', () => {
  const ctx = { root: '/tmp' };
  let n = 0;
  const hangsOnce = () => (++n === 1 ? { status: null, signal: 'SIGKILL', stdout: '' } : { status: 0, signal: null, stdout: 'abc\n' });
  assert.equal(gitBounded(ctx, ['hash-object', '--stdin'], 'x', { spawn: hangsOnce }).stdout, 'abc\n');
  assert.equal(n, 2);
  const hangs = () => ({ status: null, signal: 'SIGKILL', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
  assert.throws(() => gitBounded(ctx, ['hash-object', '--stdin'], 'x', { spawn: hangs }), /did not finish twice \(ETIMEDOUT\)/);
});
