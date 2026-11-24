// The single delivery and CI's analysis jobs: the jobs run here before the push (a failure after the fixing round pushes
// nothing); a red branch CI goes back for the harness's way out and the new head is proven before the PR opens; a
// pre-open failure keeps the first push time in the result (held-out C20: HINT-1's firstPushAt was null).
import assert from 'node:assert/strict';
import { ciFixBudget } from '../lib/ci-wait.mjs';
import { spawnSync as sh } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { deliverFinished } = await import('../lib/implement.mjs');

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-delivery-')));
  const g = (...a) => sh('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, config: { root: dir, stateDir: '.factory/state', metricsDir: '.factory/metrics', implement: {}, project: { languages: [] } } };
}

function io(order, { gates, gate = { ok: true, results: [{ check: 'factory-analysis Secret scan', job: 'secrets', ok: true }] }, remedy = null }) {
  let n = 0;
  return {
    analysisGate: () => (order.push('analysis-gate'), gate),
    push: (o) => (order.push(o.commitRecords === false ? 'sync' : 'push'), { pushed: true }),
    repo: () => 'acme/shop',
    gate: async () => (order.push('branch-ci'), gates[Math.min(n++, gates.length - 1)]),
    remedy: remedy ? async (a) => (order.push('remedy'), remedy(a)) : undefined,
    prOpen: () => false,
    publishTicket: () => {},
    assess: () => ({ severity: 'Low', tickets: [] }),
    publishGate: () => {},
    regate: () => {},
    analyse: async () => {},
    media: () => ({ notes: [] }),
    updateBody: () => {},
    release: () => {},
    ownsPr: () => true,
    stateDecision: async () => {},
    usage: () => [],
    held: () => [],
  };
}
const RED = { state: 'failure', names: ['factory-analysis'], failing: ['workflow factory-analysis'], pending: [], rounds: 1, fixRun: { verdict: 'ESCALATED', fixerNotes: [] } };
const GREEN = { state: 'success', names: ['factory-analysis'], failing: [], pending: [], rounds: 0 };
const args = (r, extra) => ({ id: 'HINT-1', keys: ['HINT-1'], label: 'HINT-1', branch: 'feat/hint-1', worktree: r.dir, base: 'main', title: 't', body: 'Implements HINT-1.\n\n- Test plan and automated tests: verified\n', isBug: false, save: () => {}, ...extra });

test('CI\'s analysis jobs failing here after the fixing round: nothing is pushed, the delivery stops before any PR', async () => {
  const r = repo();
  const order = [];
  const failing = { ok: false, results: [{ check: 'factory-analysis Secret scan', job: 'secrets', ok: false, output: 'BLOCKING leaks generic-api-key a.sql:1', findings: [{ verdict: 'blocking', secret: true, tool: 'leaks', rule: 'generic-api-key', file: 'a.sql', line: 1 }] }], fixRun: { verdict: 'ESCALATED' } };
  const out = await deliverFinished(r.config, r.config, args(r, { io: io(order, { gates: [GREEN], gate: failing }), open: () => assert.fail('no PR') }));
  assert.deepEqual(order, ['analysis-gate']);
  assert.equal(out.outcome, 'blocked');
  assert.match(out.reason, /analysis jobs fail on the head before the push/);
  assert.equal(out.firstPushAt, undefined, 'never pushed');
});

test('a red branch CI goes back for the harness\'s way out; the new head is proven, then the PR opens once', async () => {
  const r = repo();
  const order = [];
  let opened = 0;
  const out = await deliverFinished(r.config, r.config, args(r, { io: io(order, { gates: [RED, GREEN], remedy: () => ({ retried: true, reason: 'folded the story branch and pushed it with a lease', decisions: ['x.sql:1 shares-span (fake), pushed-no-pr: implementer + fold-branch'] }) }), open: async () => (opened++, order.push('open'), { url: 'https://github.com/acme/shop/pull/1' }) }));
  assert.deepEqual(order.slice(0, 6), ['analysis-gate', 'push', 'branch-ci', 'remedy', 'branch-ci', 'sync']);
  assert.equal(opened, 1);
  assert.ok(out.firstPushAt, 'first push time kept');
});

test('a red branch CI with no way out ends before the PR, and the result keeps the first push time', async () => {
  const r = repo();
  const order = [];
  const out = await deliverFinished(r.config, r.config, args(r, { io: io(order, { gates: [RED], remedy: () => ({ retried: false, reason: 'the secret decision table says escalate' }) }), open: () => assert.fail('no PR') }));
  assert.deepEqual(order, ['analysis-gate', 'push', 'branch-ci', 'remedy']);
  assert.equal(out.outcome, 'ci-red');
  assert.ok(out.firstPushAt && !Number.isNaN(Date.parse(out.firstPushAt)), `firstPushAt in the result: ${JSON.stringify(out.firstPushAt)}`);
});

test('the harness\'s way out is taken once: a head still red after it ends before the PR', async () => {
  const r = repo();
  const order = [];
  const out = await deliverFinished(r.config, r.config, args(r, { io: io(order, { gates: [RED, RED], remedy: () => ({ retried: true, reason: 'pushed a fix' }) }), open: () => assert.fail('no PR') }));
  assert.deepEqual(order, ['analysis-gate', 'push', 'branch-ci', 'remedy', 'branch-ci']);
  assert.equal(out.outcome, 'ci-red');
});

// Council r1 (A6): the way out's fixing round ran with implement.ci.maxFixRounds 0 and was not counted.
test('the way out\'s fixing round is one of the ticket\'s CI fixing rounds: with none left it does not run, and a person decides', async () => {
  const { remedyRedBranch } = await import('../lib/analysis-gate.mjs');
  const r = repo();
  const seen = [];
  r.config.implement = { ci: { maxFixRounds: 0 } };
  await deliverFinished(r.config, r.config, args(r, { io: io([], { gates: [{ ...RED, rounds: 0 }], remedy: (a) => (seen.push(a.budget.left()), { retried: false, reason: 'none' }) }), open: () => assert.fail('no PR') }));
  assert.deepEqual(seen, [0], 'the way out is told no round is left');
  const finding = { verdict: 'blocking', secret: false, tool: 'semgrep', rule: 'sql-injection', file: 'a.js', line: 1 };
  const out = await remedyRedBranch(r.config, { worktree: r.dir, branch: 'feat/x', base: 'main', ci: { failing: ['workflow factory-analysis'] }, prOpen: false, keys: ['X-1'], jobs: () => [{ check: 'factory-analysis Security patterns', job: 'sast', ok: false, findings: [finding] }], fix: () => assert.fail('no fixing round left'), credentials: [], budget: ciFixBudget({ ci: { maxFixRounds: 0 } }, {}, {}) });
  assert.deepEqual([out.retried, out.fixRounds], [false, 0]);
  assert.match(out.reason, /implement\.ci\.maxFixRounds has none left: a person decides/);
});
