// Council C9 (Sol major, Opus 2): the gate and the CI wait judged "green" from whichever checks happened to be
// registered. A fast check that passed before the application workflows registered (Sol's reproducer), or a check a
// label triggered (Opus route A), could authorise a Low PR to merge before its CI ran; an armed GitHub auto-merge
// survived a new head (Opus route B). Green now needs every workflow the head is expected to run (derived from the
// workflow files at that head) completed and green, and every route to a merge fails closed without it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combine, evaluateRuns, expectedWorkflows, globRegex, headWorkflows, workflowApplies } from '../lib/expected-ci.mjs';
import { checksState } from '../lib/github.mjs';
import { applyDeliveryCheck } from '../lib/delivery-check.mjs';
import { decideGate } from '../lib/gate.mjs';
import { publishGate } from '../lib/publish.mjs';
import { regate, syncGate } from '../lib/sync.mjs';
import { ciFlaky, ciGate, waitForCi } from '../../implement/lib/ci-wait.mjs';
import { fakeGh } from './fake-gh.mjs';
import { cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, git, low } from './helpers.mjs';

// The test repository's own pull-request workflows, reduced to their triggers.
const WORKFLOWS = {
  '.github/workflows/factory-gate.yml': 'name: AI app factory\non:\n  pull_request:\n',
  '.github/workflows/markdownlint.yml': 'name: Markdownlint\non:\n  pull_request:\n',
  '.github/workflows/pr-validation.yml': "name: eShop Pull Request Validation\non:\n  pull_request:\n    paths-ignore:\n      - '**.md'\n      - 'src/ClientApp/**'\n  push:\n    branches: [main]\n",
  '.github/workflows/playwright.yml': "name: Playwright Tests for eShop\non:\n  pull_request:\n    branches: [ main ]\n    paths-ignore:\n      - '**.md'\n",
  '.github/workflows/pr-validation-maui.yml': "name: eShop Pull Request Validation - .NET MAUI\non:\n  pull_request:\n    branches:\n      - '**'\n    paths:\n      - 'src/ClientApp/**'\n",
  '.github/workflows/factory-pr-check.yml': 'name: PR check\non:\n  pull_request:\n    types: [labeled, synchronize]\n  workflow_dispatch:\n',
  '.github/workflows/factory-pr-demo-video.yml': 'name: PR demo video\non:\n  pull_request:\n    types: [opened, reopened, synchronize, ready_for_review, closed]\n',
  '.github/workflows/factory-review-quorum.yml': 'name: review-quorum\non:\n  pull_request:\n    types: [opened, synchronize, labeled]\n  pull_request_review:\n',
  '.github/workflows/factory-retro.yml': 'name: lessons\non:\n  workflow_dispatch:\n',
  '.github/workflows/factory-feature-verification-check.yml': 'name: fv check\non:\n  workflow_call:\n',
};
const files = (wf = WORKFLOWS) => Object.entries(wf).map(([path, text]) => ({ path, text }));

test('the expected workflows of a head follow its triggers, types, branches and paths (the test repository\'s own)', () => {
  const code = expectedWorkflows(files(), { base: 'main', changed: ['src/WebApp/Components/Pages/User/Orders.razor'] });
  assert.deepEqual(code.map((w) => [w.name, w.required]), [
    ['AI app factory', true],
    ['Markdownlint', true],
    ['eShop Pull Request Validation', true],
    ['Playwright Tests for eShop', true],
    ['PR check', false], // labeled/synchronize only: it may run, then it must pass, but its absence does not hold
    ['PR demo video', true],
  ]);
  const docs = expectedWorkflows(files(), { base: 'main', changed: ['docs/a.md'] }).map((w) => w.name);
  assert.ok(!docs.includes('eShop Pull Request Validation') && !docs.includes('Playwright Tests for eShop'), 'paths-ignore **.md');
  assert.ok(expectedWorkflows(files(), { base: 'main', changed: ['src/ClientApp/App.cs'] }).some((w) => w.name === 'eShop Pull Request Validation - .NET MAUI'));
  assert.ok(!expectedWorkflows(files(), { base: 'release', changed: ['src/A.cs'] }).some((w) => w.name === 'Playwright Tests for eShop'), 'branches: [main]');
  assert.deepEqual(expectedWorkflows(files(), { base: 'main', changed: ['x'], settings: { expected: ['.github/workflows/a.yml'] } }).map((w) => w.path), ['.github/workflows/a.yml']);
  assert.equal(globRegex('**.md').test('docs/deep/a.md'), true);
  assert.equal(globRegex('src/ClientApp/**').test('src/ClientApp/x/y.cs'), true);
  assert.equal(workflowApplies({ on: 'pull_request' }, { base: 'main' }).required, true);
  assert.equal(workflowApplies({ on: ['push'] }, { base: 'main' }).applies, false);
});

test('a workflow with no run, a run still going, an unreadable workflow file or no workflow at all is never green', () => {
  const expected = [{ path: 'a.yml', name: 'app', required: true }, { path: 'm.yml', name: 'meta', required: true }];
  const run = (path, status, conclusion, id = 1) => ({ id, path, name: path, status, conclusion, event: 'pull_request' });
  assert.equal(evaluateRuns(expected, [run('m.yml', 'completed', 'success')]).state, 'pending');
  assert.deepEqual(evaluateRuns(expected, [run('m.yml', 'completed', 'success')]).missing, ['app']);
  assert.equal(evaluateRuns(expected, [run('m.yml', 'completed', 'success'), run('a.yml', 'in_progress', null)]).state, 'pending');
  assert.equal(evaluateRuns(expected, [run('m.yml', 'completed', 'success'), run('a.yml', 'completed', 'failure')]).state, 'failure');
  assert.equal(evaluateRuns(expected, [run('m.yml', 'completed', 'success'), run('a.yml', 'completed', 'success')]).state, 'success');
  // The latest run of a workflow for the head counts: a re-run after a failure clears it, a later failure does not.
  assert.equal(evaluateRuns(expected, [run('m.yml', 'completed', 'success'), run('a.yml', 'completed', 'failure', 1), run('a.yml', 'completed', 'success', 2)]).state, 'success');
  assert.equal(evaluateRuns([{ path: 'x.yml', name: 'x', required: true, unreadable: true }], []).state, 'pending');
  assert.equal(evaluateRuns([], []).state, 'none');
  assert.equal(combine('success', { state: 'none' }), 'none');
  assert.equal(combine('success', { state: 'unknown' }), 'unknown');
});

// Sol's reproducer (C9-sol.md), on the gate and the CI wait as they are now: a fast `metadata` check passes from the
// start; the application workflow registers at t=120 s and fails. `run list` for the head is empty until then.
function solRepo() {
  const gh = fakeGh();
  gh.workflows = { '.github/workflows/meta.yml': 'name: metadata\non: pull_request\n', '.github/workflows/app.yml': 'name: application-tests\non: pull_request\n' };
  const pr = gh.addPr(7, { headRefOid: 'head123', files: ['src/A.cs'], checks: [{ name: 'metadata', bucket: 'pass' }], runs: [{ id: 1, path: '.github/workflows/meta.yml', name: 'metadata', status: 'completed', conclusion: 'success', event: 'pull_request' }] });
  gh.runs = [];
  return { gh, pr };
}

test("Sol's reproducer: a fast passing check before the application workflow registers is not green (CI wait, gate, delivery check)", async () => {
  const { gh, pr } = solRepo();
  let t = 1000;
  const register = () => {
    if (t >= 121000 && pr.checks.length === 1) {
      pr.checks.push({ name: 'application-tests', bucket: 'fail' });
      pr.runs.push({ id: 2, path: '.github/workflows/app.yml', name: 'application-tests', status: 'completed', conclusion: 'failure', event: 'pull_request' });
    }
  };
  const ci = await ciGate({ gh: (a, o) => (register(), gh.gh(a, o)), repo: 'acme/shop', pr: 7, fixRounds: 0, wait: (g, r, p, o) => waitForCi(g, r, p, { ...o, now: () => t, sleep: async (ms) => { t += ms; } }) });
  assert.equal(ci.state, 'failure', 'the wait waited for application-tests instead of calling the head green at 60 s');
  assert.ok(t - 1000 >= 120000);
  // The gate and the delivery check at t=0, as board sync would see the head.
  const fresh = solRepo();
  assert.equal(checksState(fresh.gh.gh, 'acme/shop', 7, { head: 'head123' }), 'pending');
  assert.equal(ciFlaky(fresh.gh.gh, 'acme/shop', 7), null, 'an empty run list is "not checked", never "no retried test"');
  const a = { headSha: 'head123', ci: checksState(fresh.gh.gh, 'acme/shop', 7, { head: 'head123' }), severity: { level: 'Low' }, tickets: [{ key: 'BUG', severity: { level: 'Low' }, confidence: { score: 99, high: true, reasons: [] }, reopens: [], rejectionChecked: true }] };
  applyDeliveryCheck(a, null, { gh: fresh.gh.gh, repo: 'acme/shop', pr: 7 });
  assert.equal(a.deliveryChecked, undefined);
  assert.equal(decideGate(a, { settings: { approvals: {} }, autoMerge: { enabled: true } }).action, 'wait');
});

test('a check a label triggered that passes does not stand in for the head\'s workflows (Opus route A)', () => {
  const gh = fakeGh();
  gh.workflows = { '.github/workflows/label.yml': 'name: label-check\non:\n  pull_request:\n    types: [labeled]\n', '.github/workflows/app.yml': 'name: app\non: pull_request\n' };
  gh.addPr(9, { headRefOid: 'h9', files: ['src/A.cs'], checks: [{ name: 'label-check', bucket: 'pass' }], runs: [{ id: 5, path: '.github/workflows/label.yml', name: 'label-check', status: 'completed', conclusion: 'success', event: 'pull_request' }] });
  assert.equal(checksState(gh.gh, 'acme/shop', 9, { head: 'h9' }), 'pending');
  assert.deepEqual(headWorkflows(gh.gh, 'acme/shop', '9').missing, ['app']);
});

test('evidence for one head never counts for another: a moved head is pending', () => {
  const gh = fakeGh();
  gh.addPr(3, { headRefOid: 'new', checks: [{ name: 'ci', bucket: 'pass' }] });
  assert.equal(checksState(gh.gh, 'acme/shop', 3, { head: 'old' }), 'pending');
  assert.match(headWorkflows(gh.gh, 'acme/shop', '3', { head: 'old' }).missing[0], /head moved from old to new/);
});

// Every route that can end in a merge, on the same Low, high-confidence ticket whose application workflow has not
// registered: none merges, none arms GitHub auto-merge. Then, with every expected workflow green, each one merges.
function lowRepo({ appRun = null } = {}) {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.workflows = { '.github/workflows/meta.yml': 'name: metadata\non: pull_request\n', '.github/workflows/app.yml': 'name: application-tests\non: pull_request\n' };
  gh.addIssue(3);
  const runs = [{ id: 1, path: '.github/workflows/meta.yml', name: 'metadata', status: 'completed', conclusion: 'success', event: 'pull_request' }, ...(appRun ? [{ id: 2, path: '.github/workflows/app.yml', name: 'application-tests', event: 'pull_request', ...appRun }] : [])];
  const checks = [{ name: 'metadata', bucket: 'pass' }, ...(appRun?.status === 'completed' ? [{ name: 'application-tests', bucket: appRun.conclusion === 'success' ? 'pass' : 'fail' }] : [])];
  const pr = gh.addPr(8, { labels: [], files: ['src/Basket.API/A.cs'], checks, runs, headRefOid: git(root, 'rev-parse', 'HEAD') });
  gh.runs = runs.filter((r) => r.conclusion === 'success').map((r) => ({ databaseId: r.id, conclusion: 'success' }));
  const config = gateConfigFor(root, { autoMerge: { enabled: true } });
  return { root, gh, pr, config };
}
const merged = (gh) => gh.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge' && !c.args.includes('--disable-auto'));
const armed = (gh) => gh.calls.some((c) => c.args.includes('--auto'));

const ROUTES = {
  'gate at PR open (publish)': (w) => publishGate(w.config, { pr: w.pr.url, keys: ['BUG-3'], base: 'main' }, { gh: w.gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent }),
  'board sync / ci-gate / implement and resume (regate)': (w) => {
    publishGate(w.config, { pr: w.pr.url, keys: ['BUG-3'], base: 'main' }, { gh: w.gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
    w.gh.calls.length = 0;
    return syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  },
  'regate with a clear delivery (implement CI tail, ci-gate)': (w) => {
    publishGate(w.config, { pr: w.pr.url, keys: ['BUG-3'], base: 'main' }, { gh: w.gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
    w.gh.calls.length = 0;
    const prior = JSON.parse(/<!-- review-gate:(\{.*\}) -->/.exec(w.pr.comments[0].body)[1]);
    return regate(w.config, w.gh.gh, w.pr.url, { prior, delivery: null });
  },
  'bot identity (the PR bot merges)': (w) => {
    w.config.implement.autoMerge.identity = 'bot';
    process.env.REVIEW_GATE_TEST_BOT = '1';
    return publishGate(w.config, { pr: w.pr.url, keys: ['BUG-3'], base: 'main' }, { gh: w.gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
  },
};

for (const [route, go] of Object.entries(ROUTES)) {
  test(`fails closed: ${route} does not merge or arm a head whose application workflow has not run`, () => {
    for (const appRun of [null, { status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }]) {
      const w = lowRepo({ appRun });
      try {
        go(w);
      } catch {
        // a bot route with no bot configured may refuse to merge: that is closed too
      }
      assert.equal(merged(w.gh), false, `${route}, application workflow ${appRun ? `${appRun.status}/${appRun.conclusion}` : 'not registered'}`);
      assert.equal(armed(w.gh), false);
    }
  });
}

test('with every expected workflow green the same PR merges, bound to its head', () => {
  const w = lowRepo({ appRun: { status: 'completed', conclusion: 'success' } });
  ROUTES['gate at PR open (publish)'](w);
  const m = w.gh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(m, 'merged');
  assert.equal(m.args[m.args.indexOf('--match-head-commit') + 1], w.pr.headRefOid);
});

test('an armed GitHub auto-merge is disarmed when the head is not cleared to merge (Opus route B)', () => {
  const w = lowRepo({ appRun: null });
  w.pr.autoMergeRequest = { enabledAt: '2026-11-17T00:00:00Z' };
  ROUTES['board sync / ci-gate / implement and resume (regate)'](w);
  assert.ok(w.gh.calls.some((c) => c.args.includes('--disable-auto')), 'disarmed');
  assert.equal(merged(w.gh), false);
});

// ---- council C10: what a head owes, by the events that happened to it ------------------------------------------------

test('a head owes a workflow for the activities it went through: a synchronize-only workflow is owed by a replacement head, not by the first (Sol 2)', () => {
  const wf = [{ path: 'app.yml', text: 'name: app\non: pull_request\n' }, { path: 'sync.yml', text: 'name: expensive-security\non:\n  pull_request:\n    types: [synchronize]\n' }, { path: 'label.yml', text: 'name: label-check\non:\n  pull_request:\n    types: [labeled]\n' }];
  const appGreen = [{ id: 1, path: 'app.yml', name: 'app', status: 'completed', conclusion: 'success', event: 'pull_request' }];
  const first = expectedWorkflows(wf, { base: 'main', changed: ['src/A.cs'], activities: ['opened'] });
  assert.deepEqual(first.map((w) => [w.name, w.required]), [['app', true], ['expensive-security', false], ['label-check', false]]);
  assert.equal(evaluateRuns(first, appGreen).state, 'success', 'the first head does not owe the synchronize-only run');
  // Sol's counterexample: a replacement head, its synchronize-only run not registered yet.
  const replacement = expectedWorkflows(wf, { base: 'main', changed: ['src/A.cs'], activities: ['synchronize'] });
  const r = evaluateRuns(replacement, appGreen);
  assert.deepEqual([r.state, r.missing], ['pending', ['expensive-security']]);
  // A head the gate labelled owes the label workflow too.
  assert.ok(expectedWorkflows(wf, { base: 'main', changed: ['x'], activities: ['opened', 'labeled'] }).find((w) => w.name === 'label-check').required);
  // Unknown activities (a PR the pipeline did not open): fail closed, every opened/synchronize/reopened workflow is owed.
  assert.ok(workflowApplies({ on: { pull_request: { types: ['synchronize'] } } }, { base: 'main', activities: null }).required);
});

test('a newer skipped run never supersedes a run that executed: a failing or running run is not hidden by the gate\'s own label edit (Opus 1)', () => {
  const expected = [{ path: 'ci.yml', name: 'ci', required: true }];
  const run = (id, status, conclusion) => ({ id, path: 'ci.yml', name: 'ci', status, conclusion, event: 'pull_request' });
  assert.equal(evaluateRuns(expected, [run(100, 'completed', 'failure'), run(101, 'completed', 'skipped')]).state, 'failure');
  assert.equal(evaluateRuns(expected, [run(100, 'in_progress', null), run(101, 'completed', 'skipped')]).state, 'pending');
  assert.equal(evaluateRuns(expected, [run(100, 'completed', 'success'), run(101, 'completed', 'skipped')]).state, 'success');
  assert.equal(evaluateRuns(expected, [run(100, 'completed', 'failure'), run(102, 'completed', 'success')]).state, 'success', 'a newer executed run does supersede');
  assert.equal(evaluateRuns(expected, [run(101, 'completed', 'skipped')]).state, 'success', 'only skipped runs: as before for a PR head');
  assert.equal(evaluateRuns(expected, [run(101, 'completed', 'skipped')], { green: new Set(['success', 'neutral']) }).state, 'failure', 'the branch gate counts no skip');
});

test('before the PR: a branch push owes its push-triggered workflows; PR-only ones are listed, never waited for', () => {
  const wf = [
    { path: 'gate.yml', text: 'name: gate\non:\n  pull_request:\n  push:\n    branches: ["feat/**", "bugfix/**"]\n' },
    { path: 'quorum.yml', text: 'name: review-quorum\non:\n  pull_request:\n  pull_request_review:\n' },
    { path: 'lint.yml', text: 'name: Markdownlint\non: pull_request\n' },
    { path: 'main.yml', text: 'name: main-only\non:\n  push:\n    branches: [main]\n' },
  ];
  const exp = expectedWorkflows(wf, { base: 'main', changed: ['src/A.cs'], mode: 'push', branch: 'feat/x-1-y', settings: { ignoreNames: [] } });
  assert.deepEqual(exp.map((w) => [w.name, w.required, Boolean(w.prOnly)]), [['gate', true, false], ['review-quorum', false, true], ['Markdownlint', false, true]]);
});
