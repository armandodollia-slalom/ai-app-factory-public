// The PR check sends production findings back to the implementation stack (owner, dogfood C15): routing table, a full
// return cycle ending in a pass, the limit, an owner question that still asks, and resume of a run that died mid-return.
// `implement run --pr` with the Stop hook's PR check on, scripted fake agents, a local origin and a fake gh (no council,
// no analysis).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { RETURN_DEFAULTS, returnTask, routeFinding, routeFindings } from '../lib/pr-check-return.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts/pipeline/test/fixtures/fake-agent.mjs');
let tmp;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-check-return-')));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

test('routing table: what a finding is about decides who fixes it', () => {
  const r = (f, memberLenses = {}) => routeFinding(f, { memberLenses, root: '/wt' }).route;
  // About the production change: back to implementation.
  assert.equal(r({ lens: 'acceptance', title: 'Quantities above 9999 are refused' }), 'implementation');
  assert.equal(r({ lens: 'flow', title: 'A huge in-range quantity still breaks the page' }), 'implementation');
  assert.equal(r({ lens: 'design', title: 'Message not tied to the input' }), 'implementation');
  assert.equal(r({ lens: 'style', action: 'rewrite', title: 'Use Math.Clamp' }), 'implementation');
  assert.equal(r({ lens: 'opus', file: 'src/WebApp/Cart.razor' }, { opus: 'correctness' }), 'implementation', 'a member is routed by its lens');
  assert.equal(r({ lens: 'sol', file: '/wt/src/Catalog.API/Apis/CatalogApi.cs:91' }, { sol: 'security' }), 'implementation');
  assert.equal(r({ lens: 'mystery' }), 'implementation', 'an unknown lens takes the full stack');
  // Confined to tests, docs, records, video or style: the light fixer.
  assert.equal(r({ lens: 'video', title: 'Step not narrated' }), 'light');
  assert.equal(r({ lens: 'style', file: 'src/WebApp/Cart.razor', title: 'Naming' }), 'light');
  assert.equal(r({ lens: 'acceptance', file: 'e2e/teststack/bug-46.spec.ts' }), 'light', 'an acceptance finding confined to a spec');
  assert.equal(r({ lens: 'opus', file: 'tests/Catalog.FunctionalTests/X.cs' }, { opus: 'correctness' }), 'light');
  assert.equal(r({ lens: 'sol', file: 'e2e/x.spec.ts' }, { sol: 'test-value' }), 'light');
  assert.equal(r({ lens: 'flow', files: ['docs/x.md', 'README.md'] }), 'light');
  // Severity (dogfood C15): only major or worse returns; a minor production finding stays with the PR check's fixer.
  assert.equal(r({ lens: 'design', severity: 'major', title: 'Message not tied to the input' }), 'implementation');
  assert.equal(r({ lens: 'acceptance', severity: 'blocking', title: 'Quantities above 9999 are refused' }), 'implementation');
  assert.equal(r({ lens: 'opus', severity: 'minor', title: 'Error styling diverges from the validation-message style' }, { opus: 'rewrite' }), 'light');
  assert.equal(r({ lens: 'style', action: 'rewrite', severity: 'minor', title: 'Use Math.Clamp' }), 'light');
  assert.match(routeFinding({ lens: 'design', severity: 'minor' }).why, /below prCheck\.returnToImplementation\.minSeverity major/);
  assert.equal(routeFinding({ lens: 'design', severity: 'minor' }, { settings: { ...RETURN_DEFAULTS, minSeverity: 'minor' } }).route, 'implementation', 'governance can return minors too');
  // A finding with no file is routed by the paths its text names (live: "captionAfterPost copied from bug-44.spec.ts").
  assert.equal(r({ lens: 'opus', severity: 'major', title: 'captionAfterPost copied from bug-44.spec.ts' }, { opus: 'rewrite' }), 'light');
  assert.equal(r({ lens: 'opus', severity: 'major', title: 'Same check written twice in CartPage.razor' }, { opus: 'rewrite' }), 'implementation');
  // Governance can change the table.
  assert.equal(routeFinding({ lens: 'video' }, { settings: { ...RETURN_DEFAULTS, lightLenses: [], implementationLenses: [...RETURN_DEFAULTS.implementationLenses, 'video'] } }).route, 'implementation');
  const split = routeFindings([{ id: 'ACC-1-1', lens: 'acceptance', title: 'a' }, { id: 'VID-1-1', lens: 'video', title: 'v' }]);
  assert.deepEqual([split.implementation.map((f) => f.id), split.light.map((f) => f.id)], [['ACC-1-1'], ['VID-1-1']]);
  assert.match(returnTask({ key: 'BUG-46', findings: split.implementation, n: 1, max: 2, round: 1 }), /The ticket is the answer: behaviour no line of the ticket asks for is removed, not defended\.[\s\S]*ACC-1-1/);
});

// ---- end to end ------------------------------------------------------------------------------------------------

const sh = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const editJson = (file, fn) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(j);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
};
const rows = [{ ref: 'Rule: a valid coupon gives 10% off', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }, { ref: 'Rule: an expired coupon is rejected with 400', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }];
const clean = (lens) => ({ result: { lens, score: 10, summary: 'ok', coverage: lens === 'acceptance' ? rows : [], findings: [] } });
const invented = { result: { lens: 'acceptance', score: 6, summary: 'adds a limit', coverage: rows, findings: [{ severity: 'major', title: 'Coupons above $9999 are refused, which no line asks for', detail: 'Coupons.cs refuses totals over 9999', evidence: 'src/Basket/Coupons.cs:1', requirement: 'Rule: a valid coupon gives 10% off', fix: 'remove the 9999 limit' }] } };
const upheld = { result: { score: 6, lensScores: { acceptance: 6 }, summary: 'invented limit', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'major', reason: 'no line asks for it', fix: 'remove the 9999 limit' }] } };
const pass = { result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } };
const base = {
  implementer: [{ writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } }, { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'limit removed' } }],
  'architecture-reviewer': [{ result: { score: 10, verdict: 'APPROVED', summary: 'ok', findings: [] } }],
  'test-planner': [{ writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }] }],
  'test-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
  'test-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
  'test-automation-verifier': [{ result: { score: 10, gaps: [] } }],
  'pr-check-flow': [clean('flow')],
  'pr-check-style': [clean('style')],
  'pr-check-video': [clean('video')],
  'pr-check-design': [clean('design')],
  'pr-check-defender': [{ result: { responses: [] } }],
};

function setup(name, { maxReturns = 2 } = {}) {
  const root = path.join(tmp, name);
  const repo = path.join(root, 'shop');
  const origin = path.join(root, 'origin.git');
  const bin = path.join(root, 'bin');
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/feature-verification', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video', 'scripts/review-gate', 'scripts/retro', 'scripts/factory', 'scripts/stack', 'scripts/teststack'].filter((d) => fs.existsSync(path.join(source, d)))) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  // Every section's defaults and descriptions: a stage reads the others' (scripts/pipeline/lib/settings.mjs).
  for (const d of fs.readdirSync(path.join(source, 'scripts'))) for (const f of ['config.json', 'settings.json']) if (fs.existsSync(path.join(source, 'scripts', d, f)) && !fs.existsSync(path.join(repo, 'scripts', d, f))) {
    fs.mkdirSync(path.join(repo, 'scripts', d), { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts', d, f), path.join(repo, 'scripts', d, f));
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  editJson(path.join(repo, 'scripts/feature-verification/config.json'), (j) => (j.featureVerification.precheck.runTests = false));
  editJson(path.join(repo, 'scripts/pipeline/config.json'), (j) => (j.implExclude = ['.factory', 'graphify-out', 'e2e']));
  editJson(path.join(repo, 'scripts/implement/config.json'), (j) => {
    Object.assign(j.implement, { pollSec: { featureVerification: 0.2 }, maxParallel: 1, ci: { ...j.implement.ci, parity: { enabled: false } }, worker: { maxRetries: 1, retryDelaySec: 0 } });
  });
  editJson(path.join(repo, 'scripts/pr-check/config.json'), (j) => {
    Object.assign(j.prCheck.hook, { enabled: true, pollSec: 0.2 });
    j.prCheck.returnToImplementation.maxReturns = maxReturns;
  });
  write(repo, '.gitignore', '.factory/state/\n');
  write(repo, 'src/Basket/Coupons.cs', '// coupons\n');
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: '# DEMO-1 Apply coupon\n\nRule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n' });
  sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'fv@example.com']);
  sh(repo, 'git', ['config', 'user.name', 'Return Test']);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);
  sh(repo, 'git', ['remote', 'add', 'origin', origin]);
  sh(repo, 'git', ['push', '-q', 'origin', 'main']);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'create') { fs.writeFileSync(${JSON.stringify(path.join(root, 'pr-body.md'))}, a[a.indexOf('--body') + 1]); process.stdout.write('https://github.com/acme/shop/pull/1\\n'); }
`, { mode: 0o755 });
  return { root, repo, bin };
}

function run(ctx, script, extraEnv = {}) {
  const scriptFile = path.join(ctx.root, 'agent.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const env = { ...process.env, PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', ...extraEnv };
  for (const k of ['PIPELINE_CHILD', 'PIPELINE_DISABLE', 'PIPELINE_ROOT', 'PIPELINE_BOARD']) delete env[k];
  const r = spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', 'implement', 'run', 'DEMO-1', '--pr'], { cwd: ctx.repo, encoding: 'utf8', env, timeout: 1_800_000 });
  const calls = JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
  const record = JSON.parse(fs.readFileSync(path.join(ctx.repo, '.factory/state/implement/DEMO-1.json'), 'utf8'));
  const body = fs.existsSync(path.join(ctx.root, 'pr-body.md')) ? fs.readFileSync(path.join(ctx.root, 'pr-body.md'), 'utf8') : null;
  const logs = path.join(ctx.repo, '.factory/state/logs');
  const log = fs.readdirSync(logs).filter((f) => f.startsWith('implement-DEMO-1')).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n');
  return { ...r, calls, record, body, log };
}

test('a production finding returns to implementation, passes the stack again, and the PR check passes: no question, no lone fixer', { timeout: 1_800_000 }, () => {
  const r = run(setup('cycle'), { ...base, 'pr-check-acceptance': [invented, clean('acceptance')], 'pr-check-judge': [upheld, pass] });
  assert.match(r.stdout, /DEMO-1 +done/, `${r.stdout}\n${r.stderr}`);
  assert.match(r.log, /back to implementation \(return 1 of at most 2\)/);
  assert.equal(r.calls.implementer, 2, 'the implementer fixed it');
  assert.ok(!r.calls['pr-check-fixer'], 'no lone fixer ran on a production finding');
  assert.equal(r.calls['architecture-reviewer'], 2, 'the review checked the change again');
  assert.equal(r.calls['pr-check-judge'], 2, 'the PR check sat again on the new head');
  assert.equal(r.record.prCheckReturns.length, 1);
  assert.deepEqual(r.record.prCheckReturns[0].findings.map((f) => [f.id, f.lens]), [['ACC-1-1', 'acceptance']]);
  assert.match(r.body, /- PR check \([^)]*\): PASS 10\/10/);
  assert.match(r.body, /Sent back to implementation by the PR check: 1 time\(s\)\n {2}- return 1: the PR check \(score 6\/10, head [0-9a-f]{7}\) upheld ACC-1-1 \[acceptance\] Coupons above \$9999/);
});

test('at the limit the story escalates with the open findings; it never opens a PR', { timeout: 1_800_000 }, () => {
  const r = run(setup('limit', { maxReturns: 1 }), { ...base, 'pr-check-acceptance': [invented], 'pr-check-judge': [upheld] });
  assert.match(r.stdout, /DEMO-1 +unresolved/, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /still upholds 1 production finding\(s\) after 1 return\(s\) to implementation/);
  assert.equal(r.body, null);
  assert.equal(r.calls.implementer, 2);
});

test('a real ticket ambiguity still asks the owner; nothing returns to implementation', { timeout: 1_800_000 }, () => {
  const question = { result: { score: 9, lensScores: { acceptance: 9 }, summary: 'two readings', rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'two-readings', reason: '"10% off" may be of the net or the gross', question: 'Is the 10% off the net or the gross price?' }] } };
  const r = run(setup('question'), { ...base, 'pr-check-acceptance': [invented], 'pr-check-judge': [question] });
  assert.match(r.stdout, /DEMO-1 +needs-decision/, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.calls.implementer, 1);
  assert.ok(!r.record.prCheckReturns?.length);
});

test('a run that dies in the middle of a return resumes it and finishes', { timeout: 1_800_000 }, () => {
  const r = run(setup('resume'), { ...base, 'pr-check-acceptance': [invented, clean('acceptance')], 'pr-check-judge': [upheld, pass] }, { PIPELINE_TEST_DIE_AT: 'pr-check-return' });
  assert.match(r.stdout, /DEMO-1 +done/, `${r.stdout}\n${r.stderr}`);
  assert.match(r.log, /resuming return 1 from the PR check \(ACC-1-1\)/);
  assert.equal(r.record.prCheckReturns.length, 1);
  assert.match(r.body, /Sent back to implementation by the PR check: 1 time\(s\)/);
  assert.equal(r.record.attempts.length, 1, 'the attempt that died is kept');
  assert.equal(r.record.attempts[0].outcome, 'error');
  assert.equal(r.record.totals.attempts, 2);
});

// Dogfood C23 (SURP-1): a PR-check finding that asks for tests went to the implementer twice and the ticket ran out of
// returns. Now it is a required case for the test plan and test automation; the implementer and the review do not run
// again, the PR check sits again once the tests verify.
test('a test gap upheld by the PR check returns to test automation as a required case, not to the implementer', { timeout: 1_800_000 }, () => {
  const ctx = setup('test-gap');
  const gap = { result: { lens: 'acceptance', score: 6, summary: 'untested branch', coverage: rows, findings: [{ severity: 'major', title: 'The expired-coupon 400 branch is not tested', detail: 'no test exercises the expired coupon', evidence: 'src/Basket/Coupons.cs:1', requirement: 'Rule: an expired coupon is rejected with 400', fix: 'add a test for an expired coupon' }] } };
  const toTests = { result: { score: 6, lensScores: { acceptance: 6 }, summary: 'test gap', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'major', reason: 'the branch is untested', fix: 'add a test for an expired coupon', resolves: 'tests' }] } };
  const r = run(ctx, {
    ...base,
    implementer: [{ writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } }],
    'test-planner': [{ writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }] }, { writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }, { title: 'Expired coupon 400 branch', type: 'sad', why: 'covers ACC-1-1 (the PR check found the branch untested)' }] }],
    'test-automation': [{ writeTests: [1, 2], result: { status: 'done' } }, { writeTests: [1, 2, 3], result: { status: 'done' } }],
    'pr-check-acceptance': [gap, clean('acceptance')],
    'pr-check-judge': [toTests, pass],
  });
  assert.match(r.stdout, /DEMO-1 +done/, `${r.stdout}\n${r.stderr}\n${r.log.slice(-3000)}`);
  assert.match(r.log, /test gap\(s\) \(ACC-1-1\); to test automation as required cases \(return 1 of at most 2\)/);
  assert.equal(r.calls.implementer, 1, 'the implementer, who writes no tests, did not get it');
  assert.equal(r.calls['architecture-reviewer'], 1, 'no production change, no second review');
  assert.equal(r.calls['test-planner'], 2);
  assert.equal(r.calls['test-automation'], 2);
  assert.equal(r.calls['pr-check-judge'], 2, 'the PR check sat again');
  assert.deepEqual(r.record.prCheckReturns[0].findings.map((f) => [f.id, f.route, f.resolves]), [['ACC-1-1', 'tests', ['tests']]]);
  assert.match(fs.readFileSync(`${path.join(ctx.root, 'agent.json')}.prompts.log`, 'utf8'), /=== test-automation-verifier #2[\s\S]*Required cases \(a later stage upheld these gaps\)[\s\S]*ACC-1-1/, 'the automation verifier saw the finding');
});

test('test automation cannot be approved while the required case is unmet: no PR on a verifier\'s 10/10', { timeout: 1_800_000 }, () => {
  const ctx = setup('test-gap-unmet');
  const gap = { result: { lens: 'acceptance', score: 6, summary: 'untested branch', coverage: rows, findings: [{ severity: 'major', title: 'The expired-coupon 400 branch is not tested', detail: 'no test exercises it', evidence: 'src/Basket/Coupons.cs:1', requirement: 'Rule: an expired coupon is rejected with 400', fix: 'add a test' }] } };
  const toTests = { result: { score: 6, lensScores: { acceptance: 6 }, summary: 'test gap', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'major', reason: 'untested', fix: 'add a test', resolves: 'tests' }] } };
  const r = run(ctx, {
    ...base,
    implementer: [{ writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } }],
    // The planner never names the finding; the verifiers say 10 anyway.
    'pr-check-acceptance': [gap, clean('acceptance')],
    'pr-check-judge': [toTests, pass],
  });
  assert.doesNotMatch(r.stdout, /DEMO-1 +done/, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.body, null, 'no PR');
  assert.equal(r.calls.implementer, 1);
  assert.ok((r.calls['test-planner'] ?? 0) >= 2, 'the planner was sent back for the required case');
  assert.equal(r.record.outcome, 'fv-blocked-on-plan', 'the plan could not be verified without the required case');
  assert.match(fs.readFileSync(`${path.join(ctx.root, 'agent.json')}.prompts.log`, 'utf8'), /=== test-plan-verifier #2[\s\S]*Required cases \(a later stage upheld these gaps\)[\s\S]*ACC-1-1/, 'the plan verifier saw the finding');
});
