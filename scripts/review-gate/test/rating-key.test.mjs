// The key a bug PR's rating is bound to (the PR's own change): what a reviewer reads as its content changes it (a moved
// line, a mode change, a rename, an added empty file); the pipeline's own base merges keep it, whatever the state of
// this clone's remote-tracking refs; a merge base that cannot be told for sure is unknown, never "the same".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { diffKey, localDiffKey } from '../lib/assessment.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const lines = (n, extra = {}) => Array.from({ length: n }, (_, i) => extra[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

function world(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rating-key-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, repo);
  git(repo, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), lines(30));
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  // A branch from the base with one change made by `change(dir)`.
  const branch = (name, change) => {
    git(repo, 'checkout', '-q', '-b', name, 'main');
    change(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', name);
    return localDiffKey(repo, 'main');
  };
  return { tmp, origin, repo, branch };
}

test('what a reviewer reads as the PR\'s content changes the key: a moved added line, a chmod, a rename, an added empty file (Gemini, rating key)', (t) => {
  const w = world(t);
  const at5 = w.branch('at-5', (d) => fs.writeFileSync(path.join(d, 'a.txt'), lines(30, { 5: 'line 5\nADDED' })));
  const at25 = w.branch('at-25', (d) => fs.writeFileSync(path.join(d, 'a.txt'), lines(30, { 25: 'line 25\nADDED' })));
  const chmod = w.branch('chmod', (d) => fs.chmodSync(path.join(d, 'b.txt'), 0o755));
  const rename = w.branch('rename', (d) => fs.renameSync(path.join(d, 'b.txt'), path.join(d, 'c.txt')));
  const empty = w.branch('empty', (d) => fs.writeFileSync(path.join(d, 'empty.txt'), ''));
  const empty2 = w.branch('empty-elsewhere', (d) => fs.writeFileSync(path.join(d, 'other.txt'), ''));
  const nothing = localDiffKey(w.repo, 'main', 'main');
  for (const k of [at5, at25, chmod, rename, empty, empty2, nothing]) assert.match(k, /^[0-9a-f]{24}$/);
  assert.equal(new Set([at5, at25, chmod, rename, empty, empty2, nothing]).size, 7, 'each change has its own key');
  // The same change read with more or less context (the host's diff has three lines) has the same key.
  const u1 = spawnSync('git', ['diff', '-U1', 'main', 'at-5'], { cwd: w.repo, encoding: 'utf8' }).stdout;
  const u3 = spawnSync('git', ['diff', '-U3', 'main', 'at-5'], { cwd: w.repo, encoding: 'utf8' }).stdout;
  const u7 = spawnSync('git', ['diff', '-U7', 'main', 'at-5'], { cwd: w.repo, encoding: 'utf8' }).stdout;
  assert.equal(diffKey(u1), diffKey(u3));
  assert.equal(diffKey(u7), diffKey(u3));
  assert.equal(diffKey(u3), at5);
});

test('a pipeline base merge keeps the key with a stale remote-tracking ref, and with no remote to fetch; no way to tell the merge base is unknown, never the same (Gemini, rating key)', (t) => {
  const w = world(t);
  const rated = w.branch('pr', (d) => fs.writeFileSync(path.join(d, 'a.txt'), lines(30, { 5: 'line 5\nADDED' })));
  const before = git(w.repo, 'rev-parse', 'origin/main');
  // The target moves on (another clone pushes), and the pipeline merges it into the PR.
  const other = path.join(w.tmp, 'other');
  git(w.tmp, 'clone', '-q', w.origin, other);
  fs.writeFileSync(path.join(other, 'base.txt'), 'new on the base\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'base moves on');
  git(other, 'push', '-q', 'origin', 'main');
  git(w.repo, 'fetch', '-q', 'origin');
  git(w.repo, 'merge', '-q', '--no-edit', 'origin/main');
  // This clone's tracking ref is left stale (as a narrowed fetch can leave it).
  git(w.repo, 'update-ref', 'refs/remotes/origin/main', before);
  assert.equal(localDiffKey(w.repo, 'main'), rated, 'the target fetched now is the base');
  git(w.repo, 'update-ref', 'refs/remotes/origin/main', before);
  // The remote cannot be fetched: the base side of the pipeline's merge is the base.
  git(w.repo, 'remote', 'set-url', 'origin', path.join(w.tmp, 'gone.git'));
  assert.equal(localDiffKey(w.repo, 'main'), rated, 'the base side of the PR\'s own base merge is the base');
  // No base merge and no remote to fetch: the merge base cannot be told for sure.
  git(w.repo, 'checkout', '-q', '-b', 'plain', 'main');
  fs.writeFileSync(path.join(w.repo, 'p.txt'), 'p\n');
  git(w.repo, 'add', '-A');
  git(w.repo, 'commit', '-qm', 'plain');
  assert.equal(localDiffKey(w.repo, 'main'), null, 'unknown: rated again');
});
