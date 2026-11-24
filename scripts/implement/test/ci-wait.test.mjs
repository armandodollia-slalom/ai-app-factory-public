// Council C4: #99 was reported delivered with a red CI check. The run waits for CI and never calls a red PR delivered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ciGate, ciLine, ciOutcome, ciState, waitForCi } from '../lib/ci-wait.mjs';

// The head's expected workflows, green: these tests are about the PR's checks (council C9 tests the workflows in
// review-gate/test/merge-routes.test.mjs).
const W = { workflows: () => ({ state: 'success', expected: [], missing: [], running: [], failing: [] }) };

const checks = (list) => ({ status: list.some((c) => c.bucket === 'pending') ? 8 : 0, stdout: JSON.stringify(list), stderr: '' });

test('the approval check is not CI; red, pending and green are read from the other checks', () => {
  const gh = () => checks([{ name: 'review-quorum', bucket: 'fail' }, { name: 'test', bucket: 'pass' }]);
  assert.equal(ciState(gh, 'a/b', 1, W).state, 'success');
  assert.deepEqual(ciState(() => checks([{ name: 'fv check', bucket: 'fail' }, { name: 'test', bucket: 'pending' }]), 'a/b', 1, W).failing, ['fv check']);
  assert.equal(ciState(() => ({ status: 1, stdout: '', stderr: 'no pull requests found' }), 'a/b', 1, W).state, 'unknown');
});

// Council C12 (PRB-9 live): a push's workflows started 2 minutes late. Meanwhile the head had only a skipped check and
// review-quorum, and the wait called that green: the run said "CI green", done, on a head whose pipeline then failed.
test("only skipped checks are not green: the wait waits for the head's workflows, and a late one is not missed", async () => {
  assert.equal(ciState(() => checks([{ name: 'check', bucket: 'skipping' }, { name: 'review-quorum', bucket: 'pass' }]), 'a/b', 1, W).state, 'none');
  let polls = 0;
  const prb9 = (args) => {
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }) };
    polls += 1;
    if (polls <= 3) return checks([{ name: 'check', bucket: 'skipping' }, { name: 'review-quorum', bucket: 'pass' }]);
    if (polls <= 5) return checks([{ name: 'check', bucket: 'skipping' }, { name: 'pipeline', bucket: 'pending' }, { name: 'lint', bucket: 'pending' }]);
    return checks([{ name: 'check', bucket: 'skipping' }, { name: 'pipeline', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]);
  };
  let t = 0;
  const r = await waitForCi(prb9, 'a/b', 186, { ciOptions: W, sleep: async () => {}, now: () => (t += 30_000) });
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.failing, ['pipeline']);
  // One workflow green while another has not registered yet: green only once it holds a settle period with no new check.
  let p2 = 0;
  const late = () => {
    p2 += 1;
    return p2 <= 1 ? checks([{ name: 'lint', bucket: 'pass' }]) : checks([{ name: 'lint', bucket: 'pass' }, { name: 'pipeline', bucket: p2 <= 3 ? 'pending' : 'fail' }]);
  };
  t = 0;
  assert.equal((await waitForCi(late, 'a/b', 186, { ciOptions: W, sleep: async () => {}, now: () => (t += 30_000), settleSec: 60 })).state, 'failure');
  let p3 = 0;
  const steady = () => ((p3 += 1), checks([{ name: 'lint', bucket: 'pass' }, { name: 'pipeline', bucket: 'pass' }]));
  t = 0;
  assert.equal((await waitForCi(steady, 'a/b', 186, { ciOptions: W, sleep: async () => {}, now: () => (t += 30_000), settleSec: 60 })).state, 'success');
  assert.ok(p3 >= 2, 'green on two polls a settle period apart');
});

test('the gate never reads only skipped checks as green', async () => {
  const { checksState } = await import('../../review-gate/lib/github.mjs');
  assert.equal(checksState(() => checks([{ name: 'check', bucket: 'skipping' }, { name: 'review-quorum', bucket: 'pass' }]), 'a/b', 186, W), 'pending');
  assert.equal(checksState(() => checks([{ name: 'check', bucket: 'skipping' }, { name: 'lint', bucket: 'pass' }]), 'a/b', 186, W), 'success');
});

test('the wait ends on a result, and says pending when time runs out', async () => {
  let n = 0;
  const gh = () => checks(n++ < 2 ? [{ name: 'test', bucket: 'pending' }] : [{ name: 'test', bucket: 'pass' }]);
  assert.equal((await waitForCi(gh, 'a/b', 1, { ciOptions: W, sleep: async () => {}, settleSec: 0 })).state, 'success');
  let t = 0;
  const slow = await waitForCi(() => checks([{ name: 'test', bucket: 'pending' }]), 'a/b', 1, { ciOptions: W, sleep: async () => {}, now: () => (t += 1000 * 60 * 60), timeoutSec: 60 });
  assert.equal(slow.state, 'pending');
  assert.match(ciLine(slow), /still running/);
});

test('a red check gets one fixing round with its log as the finding; still red is not delivered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gate-'));
  const states = ['failure', 'success'];
  const wait = async () => ({ state: states.shift(), failing: ['feature-verification / check'], pending: [] });
  const ran = [];
  const gh = (args) => (args[0] === 'run' && args[1] === 'list' ? { stdout: JSON.stringify([{ databaseId: 7, conclusion: 'failure' }]) } : args[0] === 'run' ? { stdout: 'check\tstep\t2026Z FAIL BUG-4 plan=stale story changed since the plan was written\n' } : { stdout: '[]' });
  // Council r3 (sol-06): the fixing round is announced (and charged in the run record) before its fixer runs.
  const announced = [];
  const r = await ciGate({ gh, repo: 'a/b', pr: 'https://github.com/a/b/pull/9', branch: 'bugfix/x', cwd: dir, prCheckCli: 'pr-check.mjs', targetArgs: ['--stories', 'BUG-4'], base: 'origin/main', seedFile: path.join(dir, 'seed.json'), run: (cmd, args) => (ran.push(args), {}), wait, flakyOf: () => [], beforeFix: () => announced.push(ran.length) });
  assert.deepEqual(announced, [0], 'announced once, before the fixer ran');
  assert.equal(r.state, 'success');
  assert.equal(r.fixed, true);
  assert.ok(ran[0].includes('--fix-first') && ran[0].includes('--push'));
  const seed = JSON.parse(fs.readFileSync(path.join(dir, 'seed.json'), 'utf8'));
  assert.match(seed.upheldFindings[0].title, /CI check fails on the PR: feature-verification \/ check/);
  assert.match(seed.upheldFindings[0].detail, /plan=stale/);
  const red = await ciGate({ gh, repo: 'a/b', pr: 'p', cwd: dir, prCheckCli: 'x', targetArgs: [], base: 'b', seedFile: path.join(dir, 's2.json'), run: () => ({}), wait: async () => ({ state: 'failure', failing: ['lint'], pending: [] }) });
  assert.equal(ciOutcome(red), 'ci-red');
  assert.match(ciLine(red), /CI red \(lint\): not delivered/);
});

// D-C8-3: right after a PR opened, "no checks reported" ended the wait as "unknown", and a PR GitHub could not merge
// (so no CI ran on it) was reported delivered.
test('no checks yet keeps the wait going; a DIRTY PR gets the base merged and is then waited for', async () => {
  let polls = 0;
  let merged = 0;
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: merged ? 'BLOCKED' : 'DIRTY' }) };
    polls += 1;
    if (polls < 3 || !merged) return { status: 1, stdout: '', stderr: "no checks reported on the 'feat/x' branch" };
    return checks([{ name: 'test', bucket: polls < 5 ? 'pending' : 'pass' }]);
  };
  const r = await waitForCi(gh, 'a/b', 9, { ciOptions: W, sleep: async () => {}, settleSec: 0, resolveDirty: async () => ((merged += 1), { merged: true }) });
  assert.equal(merged, 1);
  assert.equal(r.state, 'success');
  assert.equal(ciOutcome(r), 'done');
  let clock = 0;
  const stuck = await waitForCi((args) => (args[1] === 'view' ? { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }) } : { status: 1, stdout: '', stderr: 'no checks reported' }), 'a/b', 9, { sleep: async () => {}, now: () => (clock += 600 * 1000), timeoutSec: 1800 });
  assert.equal(stuck.state, 'none');
});

test('only CI that ran and passed is delivered', async () => {
  const conflict = await waitForCi((args) => (args[1] === 'view' ? { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'DIRTY' }) } : { status: 1, stdout: '', stderr: 'no checks reported' }), 'a/b', 9, { sleep: async () => {}, resolveDirty: async () => ({ merged: false, reason: 'merging main conflicts in src/a.cs' }) });
  assert.equal(ciOutcome(conflict), 'ci-conflict');
  assert.match(ciLine(conflict), /cannot merge \(merging main conflicts in src\/a\.cs\).*not delivered/);
  let t = 0;
  const none = await waitForCi((args) => (args[1] === 'view' ? { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }) } : { status: 1, stdout: '', stderr: 'no checks reported' }), 'a/b', 9, { sleep: async () => {}, now: () => (t += 3600 * 1000), timeoutSec: 60 });
  assert.equal(ciOutcome(none), 'ci-unverified');
  assert.match(ciLine(none), /no CI check ran.*not delivered/);
  assert.equal(ciOutcome({ state: 'unknown', failing: [] }), 'ci-unverified');
  assert.equal(ciOutcome({ state: 'pending', failing: [], pending: ['test'] }), 'ci-unverified');
});

// Council C6: a green recording job hid two tests that passed only on a retry.
test('a test that passed only on a retry is found in the CI log, fixed once, and never counted as delivered', async () => {
  const { parseFlaky } = await import('../lib/ci-wait.mjs');
  const log = [
    'record\tRecord the changed specs\t2026-11-15T07:56:28.0878561Z   2 flaky',
    'record\tRecord the changed specs\t2026-11-15T07:56:28.0879062Z     [scenarios] › e2e/teststack/ordd-1.spec.ts:159:5 › TC-ORDD-1-06 order number that does not exist ',
    'record\tRecord the changed specs\t2026-11-15T07:56:28.0879767Z     [scenarios] › e2e/teststack/ordd-1.spec.ts:218:5 › TC-ORDD-1-10 order number 0 ',
    'record\tRecord the changed specs\t2026-11-15T07:56:28.0880153Z   7 passed (5.2m)',
  ].join('\n');
  assert.deepEqual(parseFlaky(log).map((t) => t.match(/TC-ORDD-1-\d+/)[0]), ['TC-ORDD-1-06', 'TC-ORDD-1-10']);
  assert.deepEqual(parseFlaky('  7 passed (5.2m)'), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-flaky-'));
  let flakyCalls = 0;
  const ran = [];
  const r = await ciGate({ gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'p', branch: 'b', cwd: dir, prCheckCli: 'x', targetArgs: ['--story', 'ORDD-1'], base: 'origin/main', seedFile: path.join(dir, 's.json'), run: (c, args) => (ran.push(args), {}), wait: async () => ({ state: 'success', failing: [], pending: [] }), flakyOf: () => (flakyCalls++ === 0 ? ['[scenarios] › ordd-1.spec.ts › TC-ORDD-1-06'] : []) });
  assert.equal(r.state, 'success');
  assert.equal(r.rounds, 1, 'one fixing round on the retried test');
  const seed = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8'));
  assert.match(seed.upheldFindings[0].title, /A test passes only on a retry in CI: .*TC-ORDD-1-06/);
  const still = await ciGate({ gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'p', branch: 'b', cwd: dir, prCheckCli: 'x', targetArgs: [], base: 'b', seedFile: path.join(dir, 's2.json'), run: () => ({}), wait: async () => ({ state: 'success', failing: [], pending: [] }), flakyOf: () => ['TC-X'] });
  assert.equal(ciOutcome(still), 'ci-flaky');
  assert.match(ciLine(still), /CI green only with retries \(TC-X\): not delivered/);
});

// Council C7 (Opus 1): a retry-only pass, red or unverified CI, or an escalated fix round waits for a person.
test('deliveryDecision: delivered only when CI is green on the first attempt and the fix round did not escalate', async () => {
  const { deliveryDecision } = await import('../lib/ci-wait.mjs');
  assert.equal(deliveryDecision({ state: 'success', failing: [] }), null);
  const flaky = deliveryDecision({ state: 'flaky', failing: ['flaky: TC-06'], flaky: ['TC-06'], fixRun: { verdict: 'ESCALATED', reason: 'the fixer could not fix the upheld findings without a human decision', fixerNotes: [{ id: 'CI-FLAKY-1', title: 'A test passes only on a retry', reason: 'Headers are read-only: the 404 body is cut; options (a) NotFoundPage (b) drop StreamRendering (c) relax the 404' }] } }, { issues: [117] });
  assert.equal(flaky.outcome, 'ci-flaky');
  assert.match(flaky.reason, /CI green only with retries \(TC-06\).*the fix round escalated/);
  assert.deepEqual(flaky.findings.map((f) => f.id), ['CI-FLAKY-1', 'CI-FLAKY-1']);
  assert.match(flaky.findings[1].detail, /options \(a\) NotFoundPage/);
  assert.deepEqual(flaky.issues, [117]);
  // Green after the fix round, but the fixer escalated: still a person's decision.
  const esc = deliveryDecision({ state: 'success', failing: [], fixRun: { verdict: 'ESCALATED', reason: 'r', fixerNotes: [] } });
  assert.deepEqual([esc.state, esc.outcome], ['escalated', 'ci-escalated']);
  assert.equal(deliveryDecision({ state: 'failure', failing: ['build'] }).outcome, 'ci-red');
  assert.equal(deliveryDecision({ state: 'pending', failing: [], pending: ['e2e'] }).outcome, 'ci-unverified');
});

test('ciGate keeps what the fix round did: its verdict and the fixer\'s notes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fixrun-'));
  const out = JSON.stringify({ verdict: 'ESCALATED', reason: 'needs a human', fixerNotes: [{ id: 'CI-FLAKY-1', title: 't', reason: 'option a or b' }], commits: [] }, null, 2);
  const r = await ciGate({ gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'p', branch: 'b', cwd: dir, prCheckCli: 'x', targetArgs: [], base: 'b', seedFile: path.join(dir, 's.json'), run: () => ({ status: 1, stdout: `log line\n${out}\n` }), wait: async () => ({ state: 'success', failing: [], pending: [] }), flakyOf: () => ['TC-X'] });
  assert.equal(r.fixRun.verdict, 'ESCALATED');
  assert.equal(r.fixRun.fixerNotes[0].reason, 'option a or b');
  assert.equal(r.fixed, false);
});

// Council C7 live (#120 on 0.2.53): the CI fix round committed a new middleware that no critic looked at, the run said
// delivered, and the PR body never mentioned it (the fix round did not know its PR).
test('the CI fix round knows its PR and is checked after its fix; an unchecked fix is not delivered', async () => {
  const { deliveryDecision } = await import('../lib/ci-wait.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fixpr-'));
  const ran = [];
  await ciGate({ gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'https://github.com/a/b/pull/120', branch: 'b', cwd: dir, prCheckCli: 'x', targetArgs: ['--story', 'ORDD-1'], base: 'origin/main', seedFile: path.join(dir, 's.json'), run: (c, args) => (ran.push(args), {}), wait: async () => ({ state: 'success', failing: [], pending: [] }), flakyOf: () => ['TC-06'] });
  const args = ran[0];
  assert.equal(args[args.indexOf('--pr') + 1], '120');
  assert.ok(!args.includes('--max-rounds'), 'the fixing run gets prCheck.maxCouncilRounds, so a check follows the fix');
  const green = { state: 'success', failing: [] };
  assert.equal(deliveryDecision({ ...green, fixRun: { verdict: 'PASS', commits: ['fc0b602'], fixerNotes: [] } }), null);
  assert.equal(deliveryDecision({ ...green, fixRun: { verdict: 'ACCEPTED', commits: ['fc0b602'], fixerNotes: [] } }), null);
  const unchecked = deliveryDecision({ ...green, fixRun: { verdict: 'FAIL', reason: '', commits: ['fc0b602'], fixerNotes: [] } });
  assert.deepEqual([unchecked.state, unchecked.outcome], ['escalated', 'ci-escalated']);
  assert.match(unchecked.reason, /the fix round's commits were not accepted by a check after them \(FAIL\)/);
});

test('implement.ci.maxFixRounds 0 sends a retry-only pass straight to a person; the env overrides one run', async () => {
  const { ciFixRounds, deliveryDecision } = await import('../lib/ci-wait.mjs');
  assert.equal(ciFixRounds({}, {}), 2, 'the default: two rounds in all');
  assert.equal(ciFixRounds({ ci: { maxFixRounds: 0 } }, {}), 0);
  assert.equal(ciFixRounds({ ci: { maxFixRounds: 2 } }, { PIPELINE_CI_FIX_ROUNDS: '0' }), 0);
  assert.equal(ciFixRounds({}, { PIPELINE_CI_FIX_ROUNDS: 'x' }), 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-nofix-'));
  const ci = await ciGate({ fixRounds: 0, gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'p', branch: 'b', cwd: dir, prCheckCli: 'x', targetArgs: [], base: 'b', seedFile: path.join(dir, 's.json'), run: () => assert.fail('no fixing round'), wait: async () => ({ state: 'success', failing: [], pending: [] }), flakyOf: () => ['TC-01'] });
  assert.deepEqual([ci.state, ci.rounds], ['flaky', 0]);
  assert.equal(deliveryDecision(ci).outcome, 'ci-flaky');
});

// Council r3/r4 (T10): `pr-check --wait-ci` waited with the wait's built-in numbers, not implement.ci.wait.*. The wait it
// runs receives the repository's settings, and its answer is the result.
test('pr-check --wait-ci waits with the repository\'s implement.ci.wait settings', async () => {
  const { waitForPrCi } = await import('../lib/ci-wait.mjs');
  const config = { root: os.tmpdir(), implement: { ci: { wait: { timeoutSec: 1234, pollSec: 7, settleSec: 3 } }, reviewGate: { ci: { required: ['build'] } } } };
  const seen = [];
  const wait = async (target, repo, pr, opts) => (seen.push({ repo, pr, opts }), { state: 'failure', failing: ['build'], pending: [] });
  const out = await waitForPrCi(config, 42, { target: { host: { repo: 'acme/shop' } }, wait });
  assert.deepEqual([seen[0].repo, seen[0].pr, seen[0].opts.timeoutSec, seen[0].opts.pollSec, seen[0].opts.settleSec, seen[0].opts.ciOptions], ['acme/shop', 42, 1234, 7, 3, { ciSettings: { required: ['build'] } }]);
  assert.deepEqual([out.state, out.failing], ['failure', ['build']]);
});
