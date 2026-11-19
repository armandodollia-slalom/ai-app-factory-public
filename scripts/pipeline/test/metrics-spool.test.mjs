import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// Dogfood C2: the main checkout's own commands appended to the tracked metrics files, so `git pull` after a
// pipeline PR merged needed a stash.
test('the main checkout on the base branch spools its records; a pipeline worktree writes the tracked files; readers see both', async () => {
  const saved = process.env.FACTORY_METRICS_SPOOL;
  delete process.env.FACTORY_METRICS_SPOOL;
  try {
    const { appendJsonl } = await import('../lib/util.mjs');
    const { metricsFile, readMetricsLocal, spools, trackedMetricsFile } = await import('../lib/state.mjs');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-')));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(root, '.factory/metrics'), { recursive: true });
    fs.writeFileSync(path.join(root, '.factory/metrics/runs.jsonl'), '{"r":"merged"}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    const config = { root, metricsDir: '.factory/metrics', stateDir: '.factory/state', baseRef: 'origin/main' };
    assert.equal(spools(config), true);
    assert.equal(metricsFile(config, 'runs.jsonl'), path.join(root, '.factory/state/metrics-spool/runs.jsonl'));
    appendJsonl(metricsFile(config, 'runs.jsonl'), [{ r: 'board sync' }]);
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'no tracked file changed');
    assert.deepEqual(readMetricsLocal(config, 'runs.jsonl').map((x) => x.r), ['merged', 'board sync']);

    const wt = path.join(root, '..', `${path.basename(root)}-wt`);
    git(root, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    const wtConfig = { ...config, root: wt };
    assert.equal(spools(wtConfig), false);
    assert.equal(metricsFile(wtConfig, 'runs.jsonl'), trackedMetricsFile(wtConfig, 'runs.jsonl'));
  } finally {
    if (saved === undefined) delete process.env.FACTORY_METRICS_SPOOL;
    else process.env.FACTORY_METRICS_SPOOL = saved;
  }
});

test('the sink ships spooled records with their own cursor, once', async () => {
  const { push } = await import('../lib/sink.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-sink-'));
  fs.mkdirSync(path.join(root, '.factory/metrics'), { recursive: true });
  fs.mkdirSync(path.join(root, '.factory/state/metrics-spool'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/metrics/runs.jsonl'), '{"r":1}\n');
  fs.writeFileSync(path.join(root, '.factory/state/metrics-spool/runs.jsonl'), '{"r":2}\n');
  const config = { root, metricsDir: '.factory/metrics', stateDir: '.factory/state', project: { name: 'p' }, metrics: { sink: { type: 'directory', path: path.join(root, 'store') } } };
  const sent = [];
  const adapter = { push: async (stream, records) => sent.push(...records.map((r) => [stream, r.r ?? r.record?.r ?? JSON.stringify(r).match(/"r":(\d)/)?.[1]])) };
  const first = await push(config, { adapter });
  assert.equal(first.shipped, 2);
  assert.equal((await push(config, { adapter })).shipped, 0, 'the cursors hold');
});
