import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeLatestBase } from '../lib/base-merge.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, PIPELINE_DISABLE: '1' } });
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

// Dogfood C2: after one pipeline PR merged, every other open one was DIRTY on GitHub (the metrics logs), so no
// checks ran and none could merge.
test('the latest base is merged with the metrics union driver; a real conflict is aborted and reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'base-merge-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const a = path.join(root, 'a');
  git(root, 'clone', '-q', origin, a);
  git(a, 'config', 'user.email', 't@example.com');
  git(a, 'config', 'user.name', 't');
  write(a, '.gitattributes', '.factory/metrics/*.jsonl merge=union\n');
  write(a, '.factory/metrics/runs.jsonl', '{"r":0}\n');
  write(a, 'src/app.txt', 'one\n');
  git(a, 'add', '.');
  git(a, 'commit', '-q', '-m', 'init');
  git(a, 'push', '-q', 'origin', 'main');
  git(a, 'checkout', '-q', '-b', 'feat/x');
  fs.appendFileSync(path.join(a, '.factory/metrics/runs.jsonl'), '{"r":"x"}\n');
  write(a, 'src/x.txt', 'x\n');
  git(a, 'add', '.');
  git(a, 'commit', '-q', '-m', 'x');
  git(a, 'checkout', '-q', 'main');
  fs.appendFileSync(path.join(a, '.factory/metrics/runs.jsonl'), '{"r":"y"}\n');
  git(a, 'commit', '-q', '-am', 'y');
  git(a, 'push', '-q', 'origin', 'main');
  git(a, 'checkout', '-q', 'feat/x');
  const r = mergeLatestBase(a, 'main');
  assert.deepEqual(r, { merged: true });
  const lines = fs.readFileSync(path.join(a, '.factory/metrics/runs.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.sort(), ['{"r":"x"}', '{"r":"y"}', '{"r":0}'].sort());
  assert.deepEqual(mergeLatestBase(a, 'origin/main'), { merged: false, upToDate: true });

  // A real conflict (an application file) is left for a person.
  write(a, 'src/app.txt', 'branch\n');
  git(a, 'commit', '-q', '-am', 'branch edit');
  git(a, 'checkout', '-q', 'main');
  write(a, 'src/app.txt', 'main\n');
  git(a, 'commit', '-q', '-am', 'main edit');
  git(a, 'push', '-q', 'origin', 'main');
  git(a, 'checkout', '-q', 'feat/x');
  const c = mergeLatestBase(a, 'main');
  assert.equal(c.conflict, true);
  assert.deepEqual(c.files, ['src/app.txt']);
  assert.equal(git(a, 'status', '--porcelain').trim(), '', 'the merge was aborted');
});

test('board sync refreshes only DIRTY pipeline PRs; a real conflict is reported, not pushed', async () => {
  const { refreshDirtyPrs } = await import('../../board/lib/refresh.mjs');
  const calls = [];
  const gitImpl = (cwd, args) => (calls.push(args.join(' ')), { status: 0, stdout: '', stderr: '' });
  const logs = [];
  const list = () => [
    { number: 40, headRefName: 'feat/bug-10-x', baseRefName: 'main', mergeStateStatus: 'DIRTY' },
    { number: 50, headRefName: 'bugfix/epic/catalog', baseRefName: 'main', mergeStateStatus: 'DIRTY' },
    { number: 8, headRefName: 'dependabot/nuget/x', baseRefName: 'main', mergeStateStatus: 'DIRTY' },
    { number: 21, headRefName: 'feat/bug-7-y', baseRefName: 'main', mergeStateStatus: 'CLEAN' },
    { number: 30, headRefName: 'feat/bug-9-z', baseRefName: 'main', mergeStateStatus: 'UNKNOWN' },
  ];
  const mergeBase = () => { const n = calls.filter((c) => c.startsWith('worktree add')).length; return n === 1 ? { merged: true } : n === 2 ? { merged: false, conflict: true, files: ['src/a.cs'] } : { merged: false, upToDate: true }; };
  const refreshed = refreshDirtyPrs({ root: '/repo', board: { repo: 'acme/shop' }, implement: {} }, { log: (l) => logs.push(l), list, mergeBase, gitImpl, stateOf: () => 'UNKNOWN', pause: () => {} });
  assert.deepEqual(refreshed, [40]);
  assert.equal(calls.filter((c) => c.startsWith('push')).length, 1, 'an UNKNOWN PR that already has the base is not pushed');
  assert.equal(calls.filter((c) => c.startsWith('worktree add')).length, 3, 'the UNKNOWN pipeline PR was checked');
  assert.ok(logs.some((l) => /#50: merging main conflicts in src\/a\.cs/.test(l)));
  assert.ok(!calls.some((c) => c.includes('dependabot')), 'not a pipeline PR');
});

// Council C4: every merge to main forced a base merge (and a full CI run) into each open PR GitHub had not yet
// recomputed. An UNKNOWN PR that turns out mergeable is left alone.
test('board sync asks again about an UNKNOWN PR and leaves it alone when GitHub finds it mergeable', async () => {
  const { refreshDirtyPrs } = await import('../../board/lib/refresh.mjs');
  const calls = [];
  const gitImpl = (cwd, args) => (calls.push(args.join(' ')), { status: 0, stdout: '', stderr: '' });
  const asked = [];
  const states = { 30: ['UNKNOWN', 'CLEAN'], 31: ['DIRTY'] };
  const list = () => [
    { number: 30, headRefName: 'feat/bug-9-z', baseRefName: 'main', mergeStateStatus: 'UNKNOWN' },
    { number: 31, headRefName: 'feat/bug-8-w', baseRefName: 'main', mergeStateStatus: 'UNKNOWN' },
  ];
  const refreshed = refreshDirtyPrs({ root: '/repo', board: { repo: 'acme/shop' }, implement: {} }, { list, gitImpl, mergeBase: () => ({ merged: true }), stateOf: (n) => (asked.push(n), states[n].shift()), pause: () => {} });
  assert.deepEqual(refreshed, [31]);
  assert.deepEqual(asked, [30, 30, 31]);
});

// Council C5: the pipeline's own uncommitted metrics stopped the merge of the base before the PR opened (reported as a
// conflict in no file); the PR opened unmergeable.
test('a base merge blocked only by the pipeline\'s own uncommitted records commits them and merges', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mergeLatestBase } = await import('../lib/base-merge.mjs');
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pm = await import('node:path');
  const base = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'bm-'));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  const origin = pm.join(base, 'origin');
  fsm.mkdirSync(origin);
  g(origin, 'init', '-q', '-b', 'main');
  fsm.mkdirSync(pm.join(origin, '.factory/metrics'), { recursive: true });
  fsm.writeFileSync(pm.join(origin, '.factory/metrics/runs.jsonl'), '{"a":1}\n');
  g(origin, 'add', '-A');
  g(origin, 'commit', '-qm', 'base');
  const work = pm.join(base, 'work');
  g(base, 'clone', '-q', origin, work);
  g(work, 'checkout', '-qb', 'feat/x');
  fsm.writeFileSync(pm.join(origin, '.factory/metrics/runs.jsonl'), '{"a":1}\n{"main":2}\n');
  g(origin, 'commit', '-qam', 'main moved');
  fsm.appendFileSync(pm.join(work, '.factory/metrics/runs.jsonl'), '{"branch":3}\n');
  const r = mergeLatestBase(work, 'origin/main', { gitImpl: (cwd, args, opts) => { try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'merge.union.driver=true', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...(opts?.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; } catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; } } });
  assert.ok(r.merged || r.conflict, JSON.stringify(r));
  assert.match(g(work, 'log', '--format=%s', '-3'), /Record pipeline metrics/);
});
