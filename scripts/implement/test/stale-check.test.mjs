// The PR check's waiter and "stale" (dogfood C24: a story ended "not delivered" with the check stale, while the review,
// automation and PR-check states all named one implementation hash and the waiter's log was empty). Cause, from the
// recorded run: test automation committed a file the implementation hash covers (a central package-version file for a
// new test package); feature verification recorded the hash it started from as verified, so every state named a hash that
// was no longer the current one, and the waiter, comparing with the real current hash, went stale.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { implChanges } from '../../pipeline/lib/git.mjs';
import { loadState, updateState } from '../../pipeline/lib/state.mjs';
import { verifiedHashOf } from '../../feature-verification/lib/workflows.mjs';
import { hookRun } from '../../pr-check/lib/hooks.mjs';
import { waitForHookPrCheck } from '../lib/implement.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-check-'));
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 't@example.invalid');
  g(root, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.cs'), 'class A {}\n');
  fs.writeFileSync(path.join(root, 'Directory.Packages.props'), '<Project />\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.factory/state/\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'base');
  g(root, 'checkout', '-qb', 'feat/x');
  fs.writeFileSync(path.join(root, 'src/a.cs'), 'class A { int B; }\n');
  g(root, 'commit', '-qam', 'implementation');
  const config = { root, baseRef: 'main', stateDir: '.factory/state', implExclude: ['.factory', 'tests', 'e2e'], prCheck: { hook: { pollSec: 0, waitForTestsMin: 1 } }, recovery: { startingGraceSec: 120, maxAttempts: 3, backoffSec: 30 } };
  return { root, config };
}

// Test automation's own commit: a test and the central package versions it needs.
function automationCommit(root) {
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/ATests.cs'), 'class ATests {}\n');
  fs.writeFileSync(path.join(root, 'Directory.Packages.props'), '<Project><PackageVersion Include="Test.Pkg" Version="1.0.0" /></Project>\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'tests');
}

test('reproduction: automation moves the hash; the verified hash is the current one, not the one it started from', () => {
  const { root, config } = repo();
  const started = implChanges(config).hash;
  automationCommit(root);
  const v = verifiedHashOf(config, started);
  assert.notEqual(v.hash, started, 'the package-version file is part of the implementation hash');
  assert.equal(v.hash, implChanges(config).hash);
  assert.equal(v.from, started);
  // On v0.2.85 the recorded verified hash was `started`; the waiter for that hash then went stale with every state
  // naming it. With the canonical value the waiter started for the current implementation runs the check.
  updateState(config, 'K-1', (s) => {
    Object.assign(s.automation, { status: 'verified', verifiedHash: v.hash });
    Object.assign(s.prCheck, { status: 'waiting', hash: implChanges(config).hash });
  });
  let checked = 0;
  return hookRun(config, { key: 'K-1' }, implChanges(config).hash, async () => {
    checked++;
    return { verdict: 'PASS', score: 10, openFindings: [], report: 'r.md' };
  }).then(() => {
    const pc = loadState(config, 'K-1').prCheck;
    assert.equal(checked, 1);
    assert.deepEqual([pc.status, pc.verdict], ['done', 'PASS']);
  });
});

test('a waiter goes stale only with a current hash that differs from the one it waited for, and records both', async () => {
  const { root, config } = repo();
  const waited = implChanges(config).hash;
  updateState(config, 'K-2', (s) => {
    Object.assign(s.automation, { status: 'running', requestedHash: waited });
    Object.assign(s.prCheck, { status: 'waiting', hash: waited, files: implChanges(config).files });
  });
  automationCommit(root);
  await hookRun(config, { key: 'K-2' }, waited, async () => assert.fail('no check on a moved implementation'));
  const pc = loadState(config, 'K-2').prCheck;
  assert.equal(pc.status, 'stale');
  assert.equal(pc.currentHash, implChanges(config).hash);
  assert.notEqual(pc.currentHash, pc.hash, 'stale with identical hashes cannot be recorded');
  assert.ok(pc.reason.includes(waited) && pc.reason.includes(pc.currentHash), pc.reason);
  // Unchanged implementation: never stale, whatever the other states say.
  const other = repo();
  const h = implChanges(other.config).hash;
  updateState(other.config, 'K-3', (s) => {
    Object.assign(s.automation, { status: 'verified', verifiedHash: h });
    Object.assign(s.prCheck, { status: 'waiting', hash: h });
  });
  await hookRun(other.config, { key: 'K-3' }, h, async () => ({ verdict: 'FAIL', score: 6, openFindings: [], report: 'r.md' }));
  assert.equal(loadState(other.config, 'K-3').prCheck.status, 'done');
});

test('a stale check before the open is started again once on the current implementation, and its result is taken', async () => {
  const { config } = repo();
  updateState(config, 'K-4', (s) => Object.assign(s.prCheck, { status: 'stale', hash: 'h1', currentHash: 'h2', reason: 'the implementation changed while waiting (waited for h1, now h2)' }));
  let t = 0;
  let restarts = 0;
  const said = [];
  const wait = async (ms) => {
    t += ms;
    if (restarts && t >= 120_000) updateState(config, 'K-4', (s) => Object.assign(s.prCheck, { status: 'done', hash: 'h2', verdict: 'PASS', score: 10 }));
    else if (restarts) updateState(config, 'K-4', (s) => Object.assign(s.prCheck, { status: 'waiting', hash: 'h2', pid: process.pid }));
  };
  const prc = await waitForHookPrCheck(config, 'K-4', { pollSec: 15, died: () => false, now: () => t, wait, log: (m) => said.push(m), restartStale: () => restarts++ });
  assert.equal(restarts, 1);
  assert.deepEqual([prc.status, prc.hash, prc.verdict], ['done', 'h2', 'PASS']);
  assert.match(said.join('\n'), /waited for h1, current h2/);
  // A second stale is not restarted again: it ends the wait as not complete.
  updateState(config, 'K-5', (s) => Object.assign(s.prCheck, { status: 'stale', hash: 'h1', currentHash: 'h2' }));
  let n = 0;
  const again = await waitForHookPrCheck(config, 'K-5', { pollSec: 15, died: () => false, now: () => t, wait: async (ms) => { t += ms; updateState(config, 'K-5', (s) => Object.assign(s.prCheck, { status: 'stale', hash: 'h2', currentHash: 'h3' })); }, restartStale: () => n++ });
  assert.equal(n, 1);
  assert.equal(again.status, 'stale');
});
