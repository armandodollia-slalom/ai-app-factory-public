// `factory adapter check host --write`: the test branch it pushes always has a commit of its own, so the host can open a
// pull request for it (live, round C16: a branch at the base's own commit was refused, "No commits between main and ...").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitHelper } from '../lib/adapter-check.mjs';

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

test('the adapter check\'s test branch is one empty commit ahead of HEAD; the working tree and current branch are untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-check-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  const head = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const g = gitHelper(repo);
  assert.equal(g.pushBranch('factory-conformance-1'), true);
  const pushed = git(origin, 'rev-parse', 'refs/heads/factory-conformance-1').stdout.trim();
  assert.notEqual(pushed, head);
  assert.equal(git(origin, 'rev-parse', `${pushed}^`).stdout.trim(), head, 'one commit on top of HEAD');
  assert.equal(git(repo, 'rev-parse', 'HEAD').stdout.trim(), head, 'the current branch did not move');
  assert.equal(g.head(), pushed);
  assert.equal(g.deleteBranch('factory-conformance-1'), true);
});
