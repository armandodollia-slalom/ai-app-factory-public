import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killTree, runAsync } from '../lib/util.mjs';

// Dogfood C2: a timed-out stack step killed only the shim; the engine process and its hung git kept the
// output pipe open and the story waited forever.
test('a timeout ends the whole process tree, so a grandchild holding the pipe cannot block the call', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-')), 'grandchild.pid');
  // Long enough for a loaded machine to start the grandchild before the timeout; far shorter than its sleep.
  const t0 = Date.now();
  const r = await runAsync('sh', ['-c', `sh -c 'echo $$ > ${marker}; sleep 300' & wait`], { timeoutSec: 5 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 25000, 'returned well before the grandchild would have ended');
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the grandchild was killed');
});

test('killTree signals descendants deepest first', () => {
  const tree = killTree(10, 0, { list: () => [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }] });
  assert.deepEqual(tree, [12, 11, 10]);
});

test('`implement stop` is routed to the stop command, not read as a story', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const r = spawnSync(process.execPath, [path.resolve('scripts/pipeline/pipeline.mjs'), 'implement', 'stop'], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: root } });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /No such file or directory: stop/);
});
