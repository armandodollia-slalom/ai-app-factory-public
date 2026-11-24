// Findings go where they can be resolved (dogfood C23: a PR-check test gap went to the implementer twice and the ticket
// ran out of returns). Pure routing, the "returned, nothing addressed" detector, required cases in feature verification,
// and the same class at the other hand-offs: the review, the automation verifier, the pairs, the PR check's hook delivery.
// Includes a replay of the recorded SURP-1 rounds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { freeReroute, routeFindings, unaddressed } from '../lib/pr-check-return.mjs';
import { isTestGap, pairHandoff, resolvesOf, routeToRole } from '../../pipeline/lib/finding-route.mjs';
import { enforceRequired, requiredProducerText, requiredVerifierText, unmetRequired } from '../../feature-verification/lib/required.mjs';
import { normalizeVerdict } from '../../feature-verification/lib/verify.mjs';
import { productGapsOf } from '../../feature-verification/lib/workflows.mjs';
import { handOffTestGaps } from '../../review/lib/review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SURP = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'surp1-pr-check-returns.json'), 'utf8'));
const major = (r) => r.upheld.filter((f) => f.severity !== 'minor');
const ids = (xs) => xs.map((f) => f.id).sort();

test('SURP-1 replay: the recorded rounds route by what resolves each finding', () => {
  const [r1, r2, r3] = SURP.prCheckRounds;
  const opts = { memberLenses: SURP.memberLenses, root: '/wt' };
  // v0.2.84 sent FLOW-1-1 to the implementer ("flow finding about the production change").
  assert.match(SURP.returns[1].findings[0].routeWhy, /flow finding about the production change/);
  const a = routeFindings(major(r1), opts);
  assert.deepEqual([ids(a.implementation), ids(a.tests)], [['OPUS-1-1'], []], 'round 1: the in-page 404 is a production finding');
  const b = routeFindings(major(r2), opts);
  assert.deepEqual([ids(b.implementation), ids(b.tests)], [[], ['FLOW-1-1', 'SOL-1-2']], 'round 2: both test gaps go to test automation, none to the implementer');
  const c = routeFindings(major(r3), opts);
  assert.deepEqual([ids(c.implementation), ids(c.tests)], [[], ['FLOW-1-1', 'SOL-1-1', 'SOL-1-2']]);
  for (const f of [...b.tests, ...c.tests]) assert.match(f.routeWhy, /required case/);
});

test('SURP-1 replay: the recorded return 2 is detected as sent where it cannot be resolved and re-routed once, free', () => {
  const r3 = routeFindings(major(SURP.prCheckRounds[2]), { memberLenses: SURP.memberLenses, root: '/wt' });
  const toReturn = [...r3.implementation, ...r3.tests];
  const stale = unaddressed(toReturn, SURP.returns, { changed: SURP.changedAfterReturn['2'] });
  assert.deepEqual(stale.map((x) => [x.id, x.kind, x.sentRoute]), [['FLOW-1-1', 'wrong-route', 'implementation']]);
  assert.match(stale[0].why, /return 2 sent FLOW-1-1 to the implementer, which cannot resolve it/);
  // The run had spent both returns; v0.2.84 ended it unresolved. Now the re-route is free, once.
  assert.equal(freeReroute(toReturn, stale, SURP.returns), true);
  assert.equal(freeReroute(toReturn, stale, [...SURP.returns, { n: 3, free: true }]), false, 'only once per story');
});

test('SURP-1 replay: with the gaps as required cases, the recorded plan and tests could never be approved', () => {
  const plan = { cases: SURP.planCasesAtEnd.map((name) => ({ name, text: `# ${name}` })) };
  const required = ['FLOW-1-1', 'SOL-1-2'].map((id) => ({ id, source: 'pr-check round 1', title: id, head: SURP.returns[1].head }));
  const unmet = unmetRequired({ root: '/nonexistent' }, { key: 'SURP-1' }, 'plan', { required, plan });
  assert.deepEqual(unmet.map((u) => u.id), ['FLOW-1-1', 'SOL-1-2']);
  const v = enforceRequired({ score: 10, gaps: [], passed: true }, unmet, { requiredScore: 9, stage: 'automation' });
  assert.equal(v.passed, false);
  assert.equal(v.score, 8);
  assert.deepEqual(v.requiredUnmet, ['FLOW-1-1', 'SOL-1-2']);
  assert.match(v.gaps[0].detail, /Required case FLOW-1-1 .* is unmet: no case of the plan names FLOW-1-1/);
});

test('a return that changed nothing of what resolves its finding escalates with that reason', () => {
  const returns = [{ n: 1, head: 'abc', findings: [{ id: 'F-1', route: 'tests' }, { id: 'C-1', route: 'implementation', file: 'src/A.cs' }] }];
  const f = [{ id: 'F-1', route: 'tests', resolves: ['tests'], title: 'x is not tested' }, { id: 'C-1', route: 'implementation', file: 'src/A.cs', resolves: ['code'], title: 'wrong total' }];
  const none = unaddressed(f, returns, { changed: ['src/B.cs', '.factory/metrics/x.jsonl'] });
  assert.deepEqual(none.map((x) => [x.id, x.kind]), [['F-1', 'nothing-changed'], ['C-1', 'nothing-changed']]);
  assert.match(none[0].why, /no test or plan file/);
  assert.deepEqual(unaddressed(f, returns, { changed: ['e2e/x.spec.ts', 'src/A.cs'] }), []);
  assert.deepEqual(unaddressed(f, [], { changed: [] }), [], 'no earlier return, nothing to detect');
});

test('the judge\'s resolves field decides; a mixed finding is split and both parts keep the id', () => {
  const r = routeFindings([
    { id: 'J-1', lens: 'flow', severity: 'major', title: 'Discount is wrong for zero quantity', resolves: 'code and tests', file: 'src/Basket.API/Cart.cs' },
    { id: 'J-2', lens: 'acceptance', severity: 'major', title: 'AC3', resolves: ['tests'] },
    { id: 'J-3', lens: 'flow', severity: 'major', title: 'PR text claims a cache', resolves: 'records' },
  ]);
  assert.deepEqual(r.implementation.map((f) => [f.id, f.part]), [['J-1', 'code']]);
  assert.deepEqual(r.tests.map((f) => [f.id, f.part ?? null]), [['J-1', 'tests'], ['J-2', null]]);
  assert.deepEqual(r.light.map((f) => f.id), ['J-3']);
  // Without the field the harness reads the finding.
  assert.deepEqual(resolvesOf({ title: 'Add the required no-match browser regression' }), ['tests']);
  assert.deepEqual(resolvesOf({ title: 'Remove overlapping unfiltered randomness test' }), ['tests']);
  assert.deepEqual(resolvesOf({ title: 'No-match on /item/random adds a global NotFoundPage' }), ['code']);
  assert.deepEqual(resolvesOf({ title: 'Null quantity is not validated and not tested', file: 'src/Ordering.API/X.cs', fix: 'validate the quantity and add a test' }), ['code', 'tests']);
  assert.deepEqual(resolvesOf({ title: 'x', action: 'delete-test' }), ['tests']);
  // A minor test gap stays with the PR check's fixer; a fix to an existing spec too.
  assert.equal(routeFindings([{ id: 'm', lens: 'flow', severity: 'minor', title: 'branch not tested' }]).light.length, 1);
  assert.equal(routeFindings([{ id: 's', lens: 'acceptance', severity: 'major', file: 'e2e/teststack/bug-46.spec.ts', title: 'wrong selector' }]).light.length, 1);
});

test('the architecture review hands a test-only finding to feature verification and stops blocking on it', () => {
  const added = [];
  const findings = [
    { id: 'R-1', severity: 'blocking', issue: 'The new error branch in CatalogApi.cs is not tested', file: 'src/Catalog.API/Apis/CatalogApi.cs' },
    { id: 'R-2', severity: 'blocking', issue: 'The repository call bypasses the service layer', file: 'src/Catalog.API/Apis/CatalogApi.cs', fix: 'move the query into CatalogService' },
    { id: 'R-3', severity: 'minor', issue: 'naming' },
  ];
  const r = handOffTestGaps({}, { key: 'X-1' }, findings, 1, { add: (_c, key, items) => added.push(...items.map((i) => [key, i.id, i.source])) });
  assert.equal(r.count, 1);
  assert.deepEqual(r.findings.map((f) => [f.id, f.severity]), [['R-1', 'minor'], ['R-2', 'blocking'], ['R-3', 'minor']]);
  assert.deepEqual(added, [['X-1', 'R-1', 'architecture review round 1']]);
});

test('the automation verifier\'s gap that only a production change can close is a product bug, not feedback to the test writer', () => {
  const config = { featureVerification: { categories: { automation: ['wrong-assertion', 'case-not-covered'] } }, testAutomation: { councilPassScore: 9 } };
  const v = normalizeVerdict(config, 'automation', { score: 6, gaps: [{ case: 'TC-X-1-01', category: 'wrong-assertion', detail: 'the API returns 500 for an unknown id; the case expects 404 and the test is right', resolves: 'code' }, { case: 'TC-X-1-02', category: 'case-not-covered', detail: 'missing' }] });
  assert.deepEqual(productGapsOf(v.gaps).map((g) => g.case), ['TC-X-1-01']);
  const plan = normalizeVerdict({ ...config, featureVerification: { categories: { plan: ['ac-not-covered'] } } }, 'plan', { score: 6, gaps: [{ category: 'ac-not-covered', detail: 'x', resolves: 'code' }] });
  assert.equal(plan.gaps[0].resolves, undefined, 'only the automation verifier may say it');
});

test('pairs: a UI finding to the backend pair goes to integration, a test gap to feature verification', () => {
  const ownerOf = (f) => (f.startsWith('src/WebApp/') ? 'web' : f.startsWith('src/Catalog.API/') ? 'api' : null);
  const h = pairHandoff([
    { id: 'P-1', severity: 'blocking', file: 'src/WebApp/Components/Pages/Item/ItemPage.razor', issue: 'the button is not shown' },
    { id: 'P-2', severity: 'blocking', file: 'src/Catalog.API/Apis/CatalogApi.cs', issue: 'the random pick reads count and offset separately' },
    { id: 'P-3', severity: 'blocking', issue: 'the 404 branch is not tested' },
    { id: 'P-4', severity: 'blocking', category: 'build', issue: 'build failed', file: 'src/WebApp/x.cs' },
  ], { ownerOf, self: 'api' });
  assert.deepEqual([ids(h.mine), ids(h.otherSide), ids(h.tests)], [['P-2', 'P-4'], ['P-1'], ['P-3']]);
  const role = routeToRole([{ id: 'T', title: 'error branches are not tested' }, { id: 'C', title: 'wrong status code' }], 'implementer');
  assert.deepEqual([ids(role.mine), ids(role.elsewhere)], [['C'], ['T']]);
  assert.deepEqual(ids(routeToRole([{ id: 'C', title: 'wrong status code', resolves: 'code' }], 'test-automation').elsewhere), ['C']);
});

test('required cases: the plan must name the finding, and its test must be new or changed since the finding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'required-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'e2e'));
  fs.writeFileSync(path.join(root, 'e2e/x.spec.ts'), '// TC-X-1-01\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  const head = g('rev-parse', 'HEAD');
  const required = [{ id: 'FLOW-1-1', source: 'pr-check', title: 'error branch untested', head }];
  const story = { key: 'X-1' };
  const plan = { cases: [{ name: 'TC-X-1-01-error.md', text: '---\ncovers: FLOW-1-1\n---\n' }] };
  const tests = new Map([['e2e/x.spec.ts', new Set(['TC-X-1-01'])]]);
  assert.deepEqual(unmetRequired({ root }, story, 'plan', { required, plan }), []);
  const stale = unmetRequired({ root }, story, 'automation', { required, plan, tests });
  assert.match(stale[0].why, /did not change since FLOW-1-1 was recorded/);
  fs.appendFileSync(path.join(root, 'e2e/x.spec.ts'), 'test("TC-X-1-01 error branch", () => {});\n');
  assert.deepEqual(unmetRequired({ root }, story, 'automation', { required, plan, tests }), []);
  assert.match(unmetRequired({ root }, story, 'automation', { required, plan, tests: new Map() })[0].why, /no test implements TC-X-1-01/);
  assert.match(requiredVerifierText(required, 'automation'), /cannot score the tests at the pass mark while any item below is unmet[\s\S]*FLOW-1-1/);
  assert.match(requiredProducerText(required, 'plan'), /covers: <id>/);
  fs.rmSync(root, { recursive: true, force: true });
});

// Dogfood C24: the bug-fix pair (a later-change pair, self mode, owns everything) got a test gap for two of its three
// rounds and the story ended pair-exhausted. The recorded verdicts, replayed through the hand-off every pair now uses.
const BUG59 = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'bug59-bugfix-pair.json'), 'utf8'));
const selfPair = { ownerOf: () => 'bug-fix-5', self: 'bug-fix-5' };

test('BUG-59 replay: the bug-fix pair keeps round 1\'s production findings; the test gaps of rounds 2 and 3 go to feature verification', () => {
  const [r1, r2, r3] = BUG59.rounds.map((r) => pairHandoff(r.findings.filter((f) => f.severity !== 'minor'), selfPair));
  assert.deepEqual([ids(r1.mine), ids(r1.tests)], [['BUG59-A1', 'BUG59-PAR'], ['BUG59-PAR']], 'round 1: production fixes stay; its "cover a pushed request" part is a required case');
  assert.deepEqual([ids(r2.mine), ids(r2.tests)], [[], ['BUG59-PAR']], 'round 2: "bypasses the PAR path whose regression coverage was required" is a test gap');
  assert.deepEqual([ids(r3.mine), ids(r3.tests)], [[], ['BUG59-PAR']], 'round 3: "the regression required by ... is not covered" is a test gap');
  for (const r of [r1, r2, r3]) assert.deepEqual(r.otherSide, []);
});

test('test gaps are read from the judge\'s resolves first, wording second, including the C24 phrasings', () => {
  // resolves given: decides, whatever the words.
  assert.deepEqual(ids(pairHandoff([{ id: 'G1', severity: 'blocking', file: 'src/a.cs', reason: 'The retry path.', resolves: 'tests' }], selfPair).tests), ['G1']);
  assert.deepEqual(ids(pairHandoff([{ id: 'G2', severity: 'blocking', file: 'e2e/a.spec.ts', reason: 'The regression is not covered.', resolves: 'code' }], selfPair).mine), ['G2']);
  // Wording, when no resolves is given.
  for (const t of [
    'The regression required by the upheld finding X is not covered.',
    'TC-BUG-59-08 still bypasses the PAR path whose regression coverage was explicitly required in round 1.',
    'The lockout case remains uncovered by the e2e suite.',
    'The aborted retry is not covered by any test.',
    'The spec never exercises the pushed authorization request.',
    'Coverage of the empty basket is still required.',
  ]) assert.ok(isTestGap(t), t);
  for (const t of ['The handler returns 500 when the provider is unknown.', 'The null case is not handled by the controller.', 'Rename the method.']) assert.ok(!isTestGap(t), t);
  // The `reason` field (recorded pair verdicts) is read, not only issue/title.
  assert.deepEqual(resolvesOf({ reason: 'The regression required by F is not covered.', file: 'src/a.cs' }), ['tests']);
});
