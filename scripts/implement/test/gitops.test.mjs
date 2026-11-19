import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitAll } from '../lib/gitops.mjs';
import { scopeViolations } from '../lib/plan.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const write = (dir, file, text = '{}\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

// Dogfood BUG-10: the implementer ran `graphify update src/Ordering.API`, and the round commit swept the
// 82 files of src/Ordering.API/graphify-out/ into the story's branch.
test('commitAll never commits a graphify-out folder, at the root or below it', () => {
  const dir = repo();
  write(dir, 'src/Api/Orders.cs', 'class Orders {}\n');
  write(dir, 'graphify-out/graph.json');
  write(dir, 'src/Api/graphify-out/graph.json');
  write(dir, 'src/Api/graphify-out/cache/x.json');
  assert.equal(commitAll(dir, 'round 1'), true);
  const committed = git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
  assert.deepEqual(committed, ['src/Api/Orders.cs']);
});

test('a graphify-out folder below the root is never an out-of-scope edit', () => {
  assert.deepEqual(scopeViolations(['src/Api/graphify-out/graph.json', 'graphify-out/x.json', 'src/Web/Page.razor'], ['src/Api/**']), ['src/Web/Page.razor']);
});

// Dogfood BUG-10: the retro ran before the PR merged and saw none of the story's feature verification,
// PR check or outcome records: only the Stop hook pushed to the store, before they existed.
test('a story ships its metrics to the store when it ends; a store failure never fails it', async () => {
  const { shipMetrics } = await import('../lib/implement.mjs');
  const wt = { root: os.tmpdir(), metrics: { sink: { type: 'directory', path: os.tmpdir() } } };
  const calls = [];
  assert.deepEqual(await shipMetrics(wt, async (c) => { calls.push(c); return { shipped: 3 }; }), { shipped: 3 });
  assert.equal(calls.length, 1);
  assert.equal(await shipMetrics(wt, async () => { throw new Error('store down'); }), null);
  assert.equal(await shipMetrics({ root: os.tmpdir(), metrics: { sink: { type: 'none' } } }, async () => assert.fail('no sink: no push')), null);
});

// Dogfood C2: a group branch committed a node_modules symlink to an absolute path on the developer's machine.
test('commitAll never commits node_modules, as a symlink or a folder', () => {
  const dir = repo();
  write(dir, 'src/Api/Fix.cs', 'class Fix {}\n');
  fs.symlinkSync('/tmp', path.join(dir, 'node_modules'));
  write(dir, 'web/node_modules/x/index.js', 'x\n');
  assert.equal(commitAll(dir, 'round 1'), true);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['src/Api/Fix.cs']);
});

// Council C2: a bug-fix run reformatted untouched lines (`new (){` -> `new()` + `{`) and they shipped.
test('formattingOnlyHunks finds hunks that change only whitespace or line breaks, not edits or new files', async () => {
  const { formattingOnlyHunks } = await import('../lib/gitops.mjs');
  const dir = repo();
  write(dir, 'src/Api.cs', 'class Api\n{\n    void A() { return new (){ X = 1 }; }\n    // a comment\n    void B() { return 1; }\n}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  write(dir, 'src/Api.cs', 'class Api\n{\n    void A() { return new()\n    { X = 1 }; }\n        // a comment\n    void B() { return 2; }\n}\n');
  write(dir, 'src/New.cs', 'class New {}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'change');
  assert.deepEqual(formattingOnlyHunks(dir, base), [{ file: 'src/Api.cs', lines: '3-4' }, { file: 'src/Api.cs', lines: '5-5' }]);
  const { formattingRuns } = await import('../lib/gitops.mjs');
  assert.deepEqual(formattingRuns(['x = 1;'], ['x = 2;']), [], 'a real edit');
  assert.deepEqual(formattingRuns(['a(b,c);', 'x = 1;'], ['a(b, c);', 'x = 2;']), [[0, 1]], 'formatting beside a real edit');
  assert.deepEqual(formattingRuns([''], []), [], 'a removed blank line is not counted');
});

// Council C11: two stories started together raced on .git/config's lock in `git worktree add -b`; one failed.
test('worktrees are created one at a time across processes; six at once all succeed', async () => {
  const { execFileSync, spawn } = await import('node:child_process');
  const os = await import('node:os');
  const fsm = await import('node:fs');
  const p = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = fsm.mkdtempSync(p.join(os.tmpdir(), 'wt-race-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b'); g('config', 'user.name', 'a');
  fsm.writeFileSync(p.join(repo, 'f'), 'x'); g('add', '-A'); g('commit', '-qm', 'i');
  g('remote', 'add', 'origin', repo); g('fetch', '-q', 'origin');
  const gitLib = p.join(p.dirname(fileURLToPath(import.meta.url)), '../../pipeline/lib/git.mjs');
  const one = (i) => new Promise((resolve) => {
    const code = `import { addWorktree } from ${JSON.stringify(gitLib)}; addWorktree(${JSON.stringify(repo)}, ['-q', '-b', 'b${i}', ${JSON.stringify(repo)} + '-w${i}', 'origin/main']); console.log('ok');`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('close', (status) => resolve({ status, out, err }));
  });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(one));
  assert.deepEqual(results.map((r) => r.status), [0, 0, 0, 0, 0, 0], results.map((r) => r.err).join('\n'));
  assert.equal(g('worktree', 'list').trim().split('\n').length, 7);
  assert.ok(!fsm.existsSync(p.join(repo, '.git', 'factory-worktree-add.lock')), 'the lock is released');
});

// Council C8: SUMM-1's one-round PR check record was untracked in its worktree; the PR branch had no PR check.
test('commitRecords commits the pipeline records, and only them; openStoryPr commits them before the push', async () => {
  const { commitRecords } = await import('../lib/gitops.mjs');
  const { openStoryPr } = await import('../lib/implement.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'records-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b'); g('config', 'user.name', 'a');
  fs.writeFileSync(path.join(repo, 'f'), 'x'); g('add', '-A'); g('commit', '-qm', 'i');
  fs.mkdirSync(path.join(repo, '.factory/metrics/pr-checks.jsonl.d'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.factory/metrics/pr-checks.jsonl.d/feat__summ-1.jsonl'), '{"round":1,"score":10}\n');
  fs.writeFileSync(path.join(repo, 'src.cs'), 'not a record');
  assert.equal(commitRecords(repo, 'records'), true);
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['.factory/metrics/pr-checks.jsonl.d/feat__summ-1.jsonl']);
  assert.equal(commitRecords(repo, 'records'), false, 'nothing new');
  const order = [];
  await openStoryPr({}, { worktree: repo, branch: 'b', base: 'main', title: 't', body: 'b' }, {
    commitRecords: () => order.push('commit'),
    publisher: { push: () => (order.push('push'), { status: 0 }), env: {} },
    run: () => (order.push('push'), { status: 0, stdout: 'https://github.com/a/b/pull/1' }),
  });
  assert.equal(order[0], 'commit');
});
