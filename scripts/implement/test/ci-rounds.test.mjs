// GEN-7: implement.ci.maxFixRounds is one count of a ticket's CI fixing rounds, before and after its PR opens. 0 sends a
// red CI straight to a person; 2 allows at most two rounds in all.
import assert from 'node:assert/strict';
import { spawnSync as sh } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { afterOpen } from '../lib/implement.mjs';
import { proveBeforeOpen } from '../lib/pre-open.mjs';
import { parityGate } from '../lib/ci-parity.mjs';
import { ciFixBudget, ciGate } from '../lib/ci-wait.mjs';

function tmpRepo(t, maxFixRounds) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-rounds-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => sh('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { root: dir, stateDir: '.factory/state', metricsDir: '.factory/metrics', implement: { ci: { maxFixRounds } }, project: { languages: [] }, host: { type: 'github', repo: 'acme/shop' }, ci: { provider: 'github-actions' } };
}

const RED = { state: 'failure', names: ['CI'], failing: ['unit tests'], pending: [] };
const GREEN = { state: 'success', names: ['CI'], failing: [], pending: [], rounds: 0 };

// The ticket's run record: what every fixing path charges, and what a resumed run reads.
const record = (spent = 0) => {
  const rec = spent ? { ciFixSpent: spent } : {};
  return { rec, load: () => rec, save: (patch) => Object.assign(rec, patch) };
};

// Before the open: each proof of the branch may spend a round while the count lasts. A gate that fixes announces it
// (beforeFix) before its fixer runs, as ciGate does.
async function prove(config, results, r = record()) {
  const calls = [];
  const out = await proveBeforeOpen(config, {
    label: 'X-1', branch: 'feat/x-1', worktree: config.root, base: 'main', targetArgs: [], prCheckCli: 'x', env: {}, stateDir: path.join(config.root, '.factory/state'), repo: 'acme/shop',
    sync: async () => ({ pushed: true }), log: () => {}, budget: ciFixBudget(config.implement, r, {}),
    gate: async (o) => {
      calls.push(o.fixRounds);
      const g = results.shift();
      if (g.rounds) o.beforeFix();
      return g;
    },
  });
  return { out, calls };
}

// After the open: a red PR gets the rounds the run record has left.
async function held(config, { r = record(), holds = [], spentAtCall = [] } = {}) {
  const calls = [];
  const io = {
    repo: () => 'acme/shop', ownsPr: () => true, regate: () => {}, stateDecision: async () => {}, updateBody: () => {},
    hold: () => ({ mode: 'draft', label: 'work-in-progress', ok: true, from: new Date().toISOString(), why: 'ci' }),
    release: () => true, usage: () => [], held: () => [],
    // What the run record says was spent when the gate (whose fixer starts at once) was called.
    gate: async (o) => {
      calls.push(o.fixRounds);
      spentAtCall.push(r.rec.ciFixSpent ?? 0);
      return { ...RED, rounds: o.fixRounds };
    },
  };
  await afterOpen(config, config, { id: 'X-1', keys: ['X-1'], label: 'X-1', prUrl: 'https://github.com/acme/shop/pull/1', branch: 'feat/x-1', worktree: config.root, base: 'main', isBug: false, result: { outcome: 'done' }, readyAt: new Date().toISOString(), holds, save: r.save, load: r.load, io, env: {} });
  return calls;
}

// The local CI parity fix before the PR: red checks, and a fixer that would run.
function parity(config, r) {
  const fixes = [];
  const run = (cmd, args) => {
    if (cmd !== 'git') fixes.push({ spentWhenStarted: r.rec.ciFixSpent ?? 0 });
    return { status: 0, stdout: cmd === 'git' ? '' : JSON.stringify({ verdict: 'ACCEPTED', rounds: 1, commits: [] }) };
  };
  const out = parityGate({ cwd: config.root, base: 'main', targetArgs: ['--story', 'X-1'], seedFile: path.join(config.root, '.factory/state/seed.json'), prCheckCli: 'pr-check.mjs', budget: ciFixBudget(config.implement, r, {}), run, checks: () => [{ check: 'unit tests', ok: false, output: 'red' }] });
  return { out, fixes };
}

test('implement.ci.maxFixRounds 0: no fixing round runs here before the PR, on the branch, or after the open; a person decides', async (t) => {
  const config = tmpRepo(t, 0);
  const r = record();
  // Council r3 (sol-06): the local parity fix is one of the rounds too.
  const p = parity(config, r);
  assert.deepEqual([p.fixes, p.out.noFixRoundLeft], [[], true], 'no fixer for the red local checks');
  const { out, calls } = await prove(config, [{ ...RED, rounds: 0 }], r);
  assert.deepEqual(calls, [0], 'the branch proof gets no fixing round');
  assert.ok(out.delivery, 'a red branch stops before its PR');
  assert.deepEqual(await held(config, { r }), [0], 'after the open only the wait runs');
});

test('implement.ci.maxFixRounds 2: at most two rounds in all, wherever they run: local parity, the branch, the PR', async (t) => {
  const config = tmpRepo(t, 2);
  // Local parity spends one, charged in the run record before its fixer starts.
  const r = record();
  const p = parity(config, r);
  assert.deepEqual([p.fixes, r.rec.ciFixSpent], [[{ spentWhenStarted: 1 }], 1]);
  // The branch proof gets the second (after which the branch is green).
  const { out, calls } = await prove(config, [{ ...GREEN, rounds: 1 }], r);
  assert.deepEqual([calls, out.fixRounds, out.delivery, r.rec.ciFixSpent], [[1], 1, null, 2]);
  // After the open: none left, only the wait, even though CI is red.
  assert.deepEqual(await held(config, { r }), [0]);
  // With nothing spent before the open, both are left for the PR, then a person decides.
  assert.deepEqual(await held(config, { r: record() }), [0, 1, 1]);
});

// Council r1/r3 (sol-06): a resume reads the rounds spent from the run record, whatever point the run stopped at (one
// hold spanning several rounds; a stop right after the PR opened, before any later checkpoint).
test('a resumed run gets only the rounds its run record has left, wherever it stopped', async (t) => {
  const config = tmpRepo(t, 2);
  const hold = { mode: 'draft', label: 'work-in-progress', ok: true, from: new Date().toISOString(), why: 'ci', cycle: 2 };
  assert.deepEqual(await held(config, { r: record(2), holds: [hold] }), [0], 'only the wait: both rounds were spent');
  assert.deepEqual(await held(config, { r: record(1), holds: [{ ...hold, cycle: 1 }] }), [0, 1], 'one round spent: one left');
  // The branch proof spent one; the run stops right after the PR opens (PIPELINE_TEST_DIE_AT=after-pr-open), and the
  // resume continues after the open with nothing but the run record: one round left, not two.
  const r = record();
  await prove(config, [{ ...RED, rounds: 1 }, { ...RED, rounds: 0 }], r);
  assert.equal(r.rec.ciFixSpent, 1, 'charged before the fixer ran');
  const resumed = record(r.rec.ciFixSpent);
  assert.deepEqual(await held(config, { r: resumed }), [0, 1]);
  assert.equal(resumed.rec.ciFixSpent, 2);
});

// A fixer that never returns (the run is killed mid-fix) still counts: the round is charged when it starts.
test('a CI fixing round counts in the run record before its fixer runs', async (t) => {
  const config = tmpRepo(t, 1);
  const r = record();
  const gate = async (o) => {
    o.beforeFix();
    throw new Error('killed mid-fix');
  };
  await assert.rejects(ciFixBudget(config.implement, r, {}).gate(gate, {}), /killed mid-fix/);
  assert.equal(r.rec.ciFixSpent, 1);
  assert.equal(ciFixBudget(config.implement, record(r.rec.ciFixSpent), {}).left(), 0);
});

// Council r4 (T11): the real code paths charge the round in the run record before the fixer starts: ciGate (driven
// through the budget, as proveBeforeOpen does) and afterOpen's own rounds.
test('the real ciGate and afterOpen charge a CI fixing round in the run record before its fixer starts', async (t) => {
  const config = tmpRepo(t, 2);
  const r = record();
  const atFixer = [];
  const run = (cmd, args) => {
    if (args.includes('--fix-first')) atFixer.push(r.rec.ciFixSpent ?? 0);
    return { status: 0, stdout: JSON.stringify({ verdict: 'PASS', commits: [] }) };
  };
  const states = ['failure', 'success'];
  const wait = async () => ({ state: states.shift(), failing: ['unit tests'], pending: [] });
  const g = await ciFixBudget(config.implement, r, {}).gate(ciGate, { gh: () => ({ stdout: '[]' }), repo: 'acme/shop', pr: 'p', cwd: config.root, prCheckCli: 'pr-check.mjs', targetArgs: [], base: 'main', seedFile: path.join(config.root, '.factory/state/seed.json'), run, wait, flakyOf: () => [] });
  assert.deepEqual([g.rounds, atFixer, r.rec.ciFixSpent], [1, [1], 1], 'charged once, before the fixer ran');
  const spentAtCall = [];
  assert.deepEqual(await held(config, { r: record(), spentAtCall }), [0, 1, 1]);
  assert.deepEqual(spentAtCall, [0, 1, 2], 'each after-open round was charged before its gate (and fixer) ran');
});
