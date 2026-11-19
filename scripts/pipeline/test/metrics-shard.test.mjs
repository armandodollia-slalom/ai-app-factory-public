// Council C4: every pipeline branch appended to the same tracked metrics files, so each merge to main made every
// other open pipeline PR conflict on GitHub (which ignores merge=union). Each branch now writes its own shard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('two branches record metrics in files of their own; merging both into main never conflicts, and readers see all', async () => {
  process.env.FACTORY_METRICS_SHARD = '1';
  const { appendJsonl } = await import('../lib/util.mjs');
  const { metricsFile, readMetricsLocal } = await import('../lib/state.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-'));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  g(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, '.factory/metrics'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/metrics/token-usage.jsonl'), '{"story":"OLD","n":0}\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'base');
  for (const [branch, story] of [['feat/a-1', 'A-1'], ['bugfix/epic/b', 'B-2']]) {
    const wt = path.join(root, '..', `${path.basename(root)}-${story}`);
    g(root, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
    const config = { root: wt, metricsDir: '.factory/metrics', stateDir: '.factory/state' };
    appendJsonl(metricsFile(config, 'token-usage.jsonl'), [{ story, n: 1 }, { story, n: 2 }]);
    assert.match(path.relative(wt, metricsFile(config, 'token-usage.jsonl')), /^\.factory\/metrics\/token-usage\.jsonl\.d\/.+\.jsonl$/);
    g(wt, 'add', '-A');
    g(wt, 'commit', '-q', '-m', story);
  }
  // No union driver involved: GitHub's merge is a plain three-way merge.
  g(root, 'merge', '-q', '--no-ff', '-m', 'one', 'feat/a-1');
  g(root, 'merge', '-q', '--no-ff', '-m', 'two', 'bugfix/epic/b');
  assert.equal(g(root, 'status', '--porcelain').trim(), '');
  process.env.FACTORY_METRICS_SHARD = '0';
  const all = readMetricsLocal({ root, metricsDir: '.factory/metrics', stateDir: '.factory/state' }, 'token-usage.jsonl').map((r) => `${r.story}${r.n}`);
  assert.deepEqual(all.sort(), ['A-11', 'A-12', 'B-21', 'B-22', 'OLD0']);
  delete process.env.FACTORY_METRICS_SHARD;
});
