import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SELFTEST_FILE, SELFTEST_TITLE, repoOf, retroSelftest } from '../lib/selftest.mjs';

// A fake git and gh: records each call; `fail` names a step to refuse.
function fakeRun({ fail = null, files = [SELFTEST_FILE] } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const refuse = (name) => fail === name ? { status: 1, stdout: '', stderr: `${name} refused` } : null;
    if (cmd === 'git' && args[0] === 'clone') return refuse('clone') ?? (fs.mkdirSync(args.at(-1), { recursive: true }), { status: 0, stdout: '', stderr: '' });
    if (cmd === 'git' && args[0] === 'push' && args.includes('--delete')) return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'push') return refuse('push') ?? { status: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'ls-remote') return refuse('ls-remote') ?? { status: 0, stdout: `${'a'.repeat(40)}\trefs/heads/${args.at(-1).replace('refs/heads/', '')}\n`, stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    if (cmd === 'gh' && args[1] === 'create') return refuse('create') ?? { status: 0, stdout: 'https://github.com/acme/factory/pull/9\n', stderr: '' };
    if (cmd === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefName: args.includes('x') ? '' : calls.find((c) => c.startsWith('git checkout')).split(' ').pop(), title: SELFTEST_TITLE, files: files.map((p) => ({ path: p })) }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}
const config = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-'));
  return { root, metricsDir: '.factory/metrics', stateDir: '.factory/state' };
};
const source = { from: '/install', source: 'https://github.com/acme/factory.git' };
const now = new Date('2026-11-14T06:30:00Z');

// Council C2: the retro's factory PR path had never run. The self-test exercises it mechanically and says so.
test('retro selftest pushes a scratch branch, checks it on the remote and deletes it; it opens no PR', () => {
  const f = fakeRun();
  const r = retroSelftest(config(), { run: f.run, now, source });
  assert.equal(r.status, 'passed', JSON.stringify(r.steps));
  assert.equal(r.kind, 'plumbing self-test, not a proposal');
  assert.equal(r.branch, 'retro/selftest-2026-11-14-06-30');
  assert.deepEqual(r.steps.map((s) => s.step), ['factory source', 'code host repository', 'clone', 'commit', 'push', 'verify pushed branch', 'delete branch']);
  assert.ok(!f.calls.some((c) => c.startsWith('gh pr')), 'no PR');
  assert.ok(f.calls.includes('git push -q origin --delete retro/selftest-2026-11-14-06-30'));
});

test('a step that fails fails the self-test, and whatever was created is still cleaned up', () => {
  const f = fakeRun({ fail: 'ls-remote' });
  const r = retroSelftest(config(), { run: f.run, now, source });
  assert.equal(r.status, 'failed');
  assert.equal(r.steps.find((s) => s.step === 'verify pushed branch').ok, false);
  assert.ok(f.calls.includes('git push -q origin --delete retro/selftest-2026-11-14-06-30'), 'deleted anyway');
  const refused = fakeRun({ fail: 'push' });
  const p = retroSelftest(config(), { run: refused.run, now, source });
  assert.deepEqual([p.status, p.steps.at(-1).step], ['failed', 'push']);
  assert.ok(!refused.calls.some((c) => c.includes('--delete') || c.startsWith('gh pr')), 'nothing pushed: nothing to clean');
  assert.equal(repoOf('git@github.com:acme/factory.git'), 'acme/factory');
  assert.equal(retroSelftest(config(), { run: f.run, now, source: { from: '/install', source: null } }).steps[0].ok, false);
});

// Dogfood C4: retro worktree folders outlived their runs (git worktree remove keeps ignored folders), one with a
// checkout of the factory source and its run notes.
test('the retro removes its worktree folder completely and sweeps folders no run uses', async () => {
  const { execFileSync } = await import('node:child_process');
  const { dropWorktree, sweepRetroWorktrees } = await import('../lib/lessons.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-wt-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.factory/state/\n');
  const config = { root: repo, stateDir: '.factory/state' };
  const wt = path.join(repo, '.factory/state/worktrees/retro-lessons-2026-11-14-05-50');
  g('worktree', 'add', '-q', '-b', 'retro/x', wt);
  fs.mkdirSync(path.join(wt, '.factory/state/factory-src/examples'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.factory/state/factory-src/examples/notes.md'), 'x');
  fs.writeFileSync(path.join(wt, '.gitignore'), '.factory/state/\n');
  dropWorktree(config, wt);
  assert.equal(fs.existsSync(wt), false);
  const stale = path.join(repo, '.factory/state/worktrees/retro-lessons-2026-11-13-22-04');
  fs.mkdirSync(path.join(stale, 'graphify-out'), { recursive: true });
  const live = path.join(repo, '.factory/state/worktrees/retro-lessons-2026-11-14-06-30');
  g('worktree', 'add', '-q', '-b', 'retro/y', live);
  assert.deepEqual(sweepRetroWorktrees(config), ['retro-lessons-2026-11-13-22-04']);
  assert.ok(fs.existsSync(live), 'a registered worktree (an interrupted run) is kept');
});
