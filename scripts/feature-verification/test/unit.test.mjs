import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatEvidence, readEvidence } from '../lib/evidence.mjs';
import { lessonCandidates, parseRules } from '../../retro/lib/lessons.mjs';
import { digestIsEmpty, retroDigest } from '../../retro/lib/digest.mjs';
import { clip, decisionRecord, formatBugs, normalizeBugs } from '../../pipeline/lib/decisions.mjs';
import { computeMetrics } from '../lib/metrics.mjs';
import { acquireLock, bootId, extractResult, isProcessAlive, lockHolder, parseFrontMatter, stringifyFrontMatter } from '../../pipeline/lib/util.mjs';
import { attributedAgent, normalizeVerdict } from '../lib/verify.mjs';
import { automationUpToDate, fixFiles, lintFiles } from '../lib/workflows.mjs';

const config = {
  loops: { requiredScore: 10 },
  categories: { plan: ['missing-sad-path', 'other'], automation: ['missing-assertion', 'other'] },
  lessons: { storyThreshold: 3, retireAfterStories: 3, revertMinRounds: 4, examplesPerCategory: 2 },
};

test('extractResult takes the last balanced AGENT_RESULT object, even with braces in strings', () => {
  const text = 'AGENT_RESULT: {"score": 1}\nthinking...\nAGENT_RESULT: {"score": 9, "gaps": [{"detail": "use } and { \\" carefully"}]}\ntrailing';
  assert.deepEqual(extractResult(text), { score: 9, gaps: [{ detail: 'use } and { " carefully' }] });
  assert.equal(extractResult('no marker'), null);
  assert.equal(extractResult('AGENT_RESULT: {"broken": '), null);
});

test('front matter round-trips lists with commas and drops undefined fields', () => {
  const text = stringifyFrontMatter({ id: 'TC-A-1-01', covers: ['Rule, part 1', 'x'], score: 10, gone: undefined }, '# Body\n');
  const parsed = parseFrontMatter(text);
  assert.deepEqual(parsed.data, { id: 'TC-A-1-01', covers: ['Rule, part 1', 'x'], score: 10 });
  assert.equal(parsed.body, '# Body\n');
});

test('normalizeVerdict passes at the required score even with minor gaps, and never lets a low score go unexplained', () => {
  const at9 = { ...config, loops: { requiredScore: 9 } };
  assert.equal(normalizeVerdict(at9, 'plan', { score: 10, gaps: [] }).passed, true);
  const minorAt9 = normalizeVerdict(at9, 'plan', { score: 9, gaps: [{ category: 'missing-sad-path', detail: 'pick one command' }] });
  assert.equal(minorAt9.passed, true);
  assert.equal(minorAt9.gaps.length, 1, 'minor gaps are kept for the metrics');
  assert.equal(normalizeVerdict(at9, 'plan', { score: 8, gaps: [{ category: 'missing-sad-path', detail: 'auth' }] }).passed, false);
  assert.equal(normalizeVerdict(config, 'plan', { score: 9, gaps: [{ category: 'missing-sad-path', detail: 'auth' }] }).passed, false, 'a 10/10 bar still rejects a 9');

  const unexplained = normalizeVerdict(config, 'plan', { score: 8 });
  assert.equal(unexplained.passed, false);
  assert.equal(unexplained.gaps[0].subtype, 'unexplained-score');

  const unknown = normalizeVerdict(config, 'automation', { score: 7, gaps: [{ category: 'made-up', root_stage: 'plan', detail: 'x' }] });
  assert.equal(unknown.gaps[0].category, 'other');
  assert.equal(unknown.gaps[0].subtype, 'made-up');
  assert.equal(unknown.gaps[0].root_stage, 'plan');
  assert.equal(normalizeVerdict(config, 'automation', { score: 'garbage' }).score, 0);
});

test('denials that trace back to the plan are attributed to the plan agent', () => {
  assert.equal(attributedAgent('plan', 'plan'), 'test-planner');
  assert.equal(attributedAgent('automation', 'plan'), 'test-planner');
  assert.equal(attributedAgent('automation', 'automation'), 'test-automation');
});

const denial = (story, ts, extra = {}) => ({ ts, stage: 'automation', story, category: 'missing-assertion', subtype: 'error-body', attributed_agent: 'test-automation', detail: `d-${story}`, ...extra });
const runAt = (story, ts) => ({ ts, stage: 'automation', story, passed: false });

test('lessons: a category recurring across enough stories becomes an "add" request', () => {
  const data = {
    denials: [denial('A-1', '2026-01-01'), denial('B-1', '2026-01-02'), denial('C-1', '2026-01-03'), denial('C-1', '2026-01-04', { category: 'other' })],
    runs: [],
    calibration: [],
  };
  const report = lessonCandidates(config, data, 'test-automation', '');
  assert.equal(report.actionable, true);
  assert.equal(report.changes.length, 1);
  assert.deepEqual({ ...report.changes[0], examples: report.changes[0].examples.length }, { action: 'add', rule: null, category: 'missing-assertion', subtype: 'error-body', count: 3, stories: 3, examples: 2 });

  const twoStories = { ...data, denials: data.denials.filter((d) => d.story !== 'C-1') };
  assert.equal(lessonCandidates(config, twoStories, 'test-automation', '').actionable, false);
});

test('lessons: existing rules are strengthened, retired or reverted based on what happened after they were added', () => {
  const rule = (id, added) => `## ${id}: Assert the error body\n<!-- category: missing-assertion; subtype: error-body; added: ${added} -->\n\nText.\n`;
  const runs = ['A-1', 'B-1', 'C-1', 'D-1'].flatMap((s, i) => [runAt(s, `2026-01-0${i + 1}`), runAt(s, `2026-03-0${i + 1}`)]);

  // Still recurring in 3 stories after the rule: strengthen. Rate did not drop: revert.
  const recurring = { denials: ['A-1', 'B-1', 'C-1'].flatMap((s, i) => [denial(s, `2026-01-0${i + 1}`), denial(s, `2026-03-0${i + 1}`)]), runs, calibration: [] };
  const r1 = lessonCandidates(config, recurring, 'test-automation', rule('L1', '2026-02-01'));
  assert.equal(r1.changes[0].action, 'strengthen');
  assert.equal(r1.changes[0].rule, 'L1');
  assert.equal(r1.rules[0].action, 'revert');

  // No hits in the 4 stories since the rule was added: retire.
  const fixed = { denials: ['A-1', 'B-1', 'C-1'].map((s, i) => denial(s, `2026-01-0${i + 1}`)), runs, calibration: [] };
  const r2 = lessonCandidates(config, fixed, 'test-automation', rule('L1', '2026-02-01'));
  assert.equal(r2.changes.length, 0);
  assert.equal(r2.rules[0].action, 'retire');

  assert.deepEqual(parseRules(rule('L3', '2026-02-01')).map((r) => [r.id, r.category, r.subtype]), [['L3', 'missing-assertion', 'error-body']]);
});

test('lessons for verifiers come from calibration misses, not from producer denials', () => {
  const data = {
    denials: ['A-1', 'B-1', 'C-1'].map((s) => denial(s, '2026-01-01')),
    runs: [],
    calibration: ['A-1', 'B-1', 'C-1'].map((s) => ({ ts: '2026-01-01', stage: 'plan', story: s, category: 'missing-sad-path', subtype: 'auth', attributed_agent: 'test-plan-verifier' })),
  };
  assert.equal(lessonCandidates(config, data, 'test-plan-verifier', '').changes[0].category, 'missing-sad-path');
});

test('lessons for the implementer come from blocking architecture review findings, grouped by policy rule', () => {
  const review = (story, findings, extra = {}) => ({ ts: '2026-01-01', story, round: 1, verdict: 'CHANGES_REQUESTED', findings, ...extra });
  const sec = { severity: 'blocking', category: 'security', rule: 'SEC-001', file: 'src/A.cs', line: 3, issue: 'SEC-001 No secrets: literal password' };
  const data = {
    denials: ['A-1', 'B-1', 'C-1'].map((s) => denial(s, '2026-01-01')),
    runs: [],
    calibration: [],
    reviews: [
      review('A-1', [sec, { severity: 'minor', category: 'fit', file: 'src/A.cs' }]),
      review('B-1', [sec], { reviewer: 'arch-review-agent' }),
      review('C-1', [sec]),
      review('D-1', [sec], { verdict: 'APPROVED' }),
      review('E-1', [{ severity: 'blocking', category: 'fit', file: 'src/E.cs' }]),
    ],
  };
  const report = lessonCandidates(config, data, 'implementer', '');
  assert.deepEqual(report.changes.map((c) => [c.action, c.category, c.subtype, c.stories]), [['add', 'security', 'SEC-001', 3]]);
  assert.deepEqual(report.changes[0].examples.at(-1), { story: 'C-1', case: 'review round 1 (architecture-reviewer)', detail: 'SEC-001 No secrets: literal password', location: 'src/A.cs:3' });
});

test('PR check findings teach the implementer (round 1), the fixer (not fixed) and the critics (dismissed)', () => {
  const check = (story, round, upheld, dismissed = []) => ({ ts: '2026-01-02', target: `pr-${story}`, story, round, lensScores: { acceptance: 8, style: 10 }, upheld, dismissed });
  const acc = (id, repeat = false) => ({ id, lens: 'acceptance', severity: 'major', title: 'AC2 not met', detail: 'no 404 path', evidence: 'src/A.cs:9', repeat });
  const noise = { id: 'STY-1-1', lens: 'style', severity: 'minor', title: 'Naming', reason: 'matches the repo convention' };
  const data = {
    denials: [],
    runs: [],
    calibration: [],
    reviews: [],
    prChecks: ['A-1', 'B-1', 'C-1'].flatMap((s) => [check(s, 1, [acc('ACC-1-1')], [noise]), check(s, 2, [acc('ACC-1-1', true)])]),
  };
  const implementer = lessonCandidates(config, data, 'implementer', '');
  assert.deepEqual(implementer.changes.map((c) => [c.action, c.category, c.stories]), [['add', 'pr-check-acceptance', 3]]);
  assert.deepEqual(implementer.changes[0].examples.at(-1), { story: 'C-1', case: 'PR check pr-C-1 round 1 (ACC-1-1)', detail: 'AC2 not met: no 404 path', location: 'src/A.cs:9' });
  assert.deepEqual(lessonCandidates(config, data, 'pr-check-fixer', '').changes.map((c) => [c.category, c.subtype, c.count]), [['not-fixed', 'acceptance', 3]]);
  assert.deepEqual(lessonCandidates(config, data, 'pr-check-style', '').changes.map((c) => [c.category, c.stories]), [['dismissed-finding', 3]]);
  assert.equal(lessonCandidates(config, data, 'pr-check-acceptance', '').changes.length, 0);
});

test('decision records strip control characters and cap reasons, items included', () => {
  const record = decisionRecord({ stage: 'review', story: 'A-1', agent: 'architecture-reviewer', subject: 'implementer', decision: 'approved', reason: 'ok\u0007 fine', items: [{ reason: 'x'.repeat(1500), undefinedField: undefined }] });
  assert.equal(record.reason, 'ok fine');
  assert.equal(record.items[0].reason.length, 1000);
  assert.ok(!('undefinedField' in record.items[0]));
  assert.equal(clip('   '), null);
});

test('product bugs are normalized from objects or legacy strings and formatted for the implementer', () => {
  const bugs = normalizeBugs([{ case: 'TC-A-1-02', expected: '404', actual: '500', location: 'src/A.cs:9', why: 'no not-found check' }, 'TC-A-1-03: expected 400, got 200', 'free text']);
  assert.deepEqual(bugs.map((b) => [b.case, b.reason]), [['TC-A-1-02', 'no not-found check'], ['TC-A-1-03', 'expected 400, got 200'], [null, 'free text']]);
  assert.equal(formatBugs(bugs.slice(0, 2)), '- TC-A-1-02: expected 404, got 500 (no not-found check) at src/A.cs:9\n- TC-A-1-03: expected 400, got 200');
});

test('product bugs from the decision log teach the implementer', () => {
  const bug = (story) => ({ ts: '2026-01-02', stage: 'automation', story, round: 1, decision: 'product-bug', items: [{ case: `TC-${story}-01`, expected: '404', actual: '500', location: 'src/A.cs:9', reason: 'missing check' }] });
  const data = { denials: [], runs: [], calibration: [], reviews: [], prChecks: [], decisions: ['A-1', 'B-1', 'C-1'].map(bug) };
  const report = lessonCandidates(config, data, 'implementer', '');
  assert.deepEqual(report.changes.map((c) => [c.action, c.category, c.stories]), [['add', 'product-bug', 3]]);
  assert.deepEqual(report.changes[0].examples.at(-1), { story: 'C-1', case: 'TC-C-1-01', detail: 'expected 404; got 500; missing check', location: 'src/A.cs:9' });
});

test('the retro digest ties later findings back to why each case was written', () => {
  const d = (stage, decision, extra) => ({ ts: '2026-01-02', story: 'A-1', round: 1, stage, decision, ...extra });
  const decisions = [
    d('plan', 'plan-written', { ts: '2025-12-01', reason: 'old', items: [] }),
    d('plan', 'plan-written', { reason: 'split by rule', excluded: [{ item: 'rate limits', reason: 'out of scope' }], items: [{ case: 'TC-A-1-01', reason: 'protects AC1' }, { case: 'TC-A-1-02', reason: 'auth sad path' }] }),
    d('automation-verify', 'denied', { score: 7, reason: 'case 2 is ambiguous', items: [{ case: 'TC-A-1-02', category: 'other', root_stage: 'plan', subject: 'test-planner', reason: 'no expected body' }] }),
    d('automation', 'product-bug', { items: [{ case: 'TC-A-1-01', expected: '404', actual: '500', reason: 'no check' }] }),
    d('review', 'changes-requested', { agent: 'arch-review-agent', reason: 'secret in code', items: [{ severity: 'blocking', category: 'security', rule: 'SEC-001', file: 'src/A.cs', line: 3, reason: 'literal password', fix: 'use options' }] }),
    d('review', 'approved', { agent: 'architecture-reviewer', reason: 'fits the Apis/ layout' }),
  ];
  const digest = retroDigest({ lessons: { examplesPerCategory: 5 } }, decisions, '2026-01-01');
  assert.deepEqual(digest.counts, { 'plan:plan-written': 1, 'automation-verify:denied': 1, 'automation:product-bug': 1, 'review:changes-requested': 1, 'review:approved': 1 });
  assert.deepEqual(digest.plans.stories, [{ story: 'A-1', rounds: 1, cases: 2, summary: 'split by rule', excluded: [{ item: 'rate limits', reason: 'out of scope' }] }]);
  assert.equal(digest.plans.casesTracedBackToPlan[0].why_written, 'auth sad path');
  assert.deepEqual(digest.plans.casesThatCaughtBugs, [{ story: 'A-1', case: 'TC-A-1-01', why_written: 'protects AC1' }]);
  assert.deepEqual(digest.review.blocked[0].examples, [{ story: 'A-1', case: undefined, location: 'src/A.cs:3', reason: 'literal password', fix: 'use options' }]);
  assert.equal(digest.review.approvals[0].reason, 'fits the Apis/ layout');
  assert.equal(digest.productBugs[0].why_written, 'protects AC1');
});

test('the factory retro shows the implement orchestrator\'s plans, escalations and pair verifier findings', () => {
  const d = (stage, decision, extra = {}) => ({ ts: '2026-02-01', stage, story: 'A-1', agent: 'implementer', decision, ...extra });
  const decisions = [
    d('implement-plan', 'plan-written', { mode: 'delegate', reason: 'two services', items: [{ id: 'api', modelClass: 'large', modelReason: 'new aggregate', verify: 'code', verifyReason: 'api only', confidence: 0.6 }] }),
    d('implement-plan', 'escalation-takeover', { subtask: 'api', pair_outcome: 'exhausted', reason: 'the spec was ambiguous' }),
    d('implement-verify', 'changes-requested', { agent: 'pair-verifier', items: [{ severity: 'blocking', category: 'logic', file: 'src/A.cs', line: 2, reason: 'no owner check' }] }),
    d('implement-verify', 'approved', { agent: 'pair-verifier' }),
  ];
  const digest = retroDigest({ lessons: { examplesPerCategory: 5 } }, decisions, '2026-01-01');
  assert.deepEqual(digest.implement.plans, [{ story: 'A-1', decision: 'plan-written', mode: 'delegate', reason: 'two services', subtasks: [{ id: 'api', modelClass: 'large', modelReason: 'new aggregate', verify: 'code', verifyReason: 'api only', confidence: 0.6 }] }]);
  assert.deepEqual(digest.implement.escalations, [{ story: 'A-1', subtask: 'api', decision: 'escalation-takeover', pairOutcome: 'exhausted', reason: 'the spec was ambiguous' }]);
  assert.equal(digest.implement.verifierFindings.length, 1);
  assert.equal(digest.implement.verifierFindings[0].examples[0].reason, 'no owner check');
});

test('computeMetrics summarizes loops per stage and categories per attributed agent', () => {
  const data = {
    runs: [
      { ts: '1', stage: 'plan', story: 'A-1', round: 1, passed: false, agent_prompt_ver: 'v1' },
      { ts: '2', stage: 'plan', story: 'A-1', round: 2, passed: true, agent_prompt_ver: 'v1' },
      { ts: '3', stage: 'plan', story: 'B-1', round: 1, passed: true, agent_prompt_ver: 'v2' },
    ],
    denials: [{ ts: '1', stage: 'plan', story: 'A-1', category: 'missing-sad-path', subtype: 'auth', attributed_agent: 'test-planner' }],
    prechecks: [],
    calibration: [],
  };
  const m = computeMetrics(config, { data });
  const plan = m.stages.plan;
  assert.equal(plan.verifierRounds, 3);
  assert.equal(plan.firstRoundPassRate, 0.5);
  assert.equal(plan.denials, 1);
  assert.equal(plan.stories, 2);
  assert.equal(m.categories[0].category, 'missing-sad-path');
});

test('readEvidence ignores manifests from older runs and formats failed tests with absolute keyframe paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-evidence-'));
  const cfg = { root, evidence: { manifest: 'out/manifest.json' } };
  fs.mkdirSync(path.join(root, 'out'));
  const startedAt = '2026-01-01T10:00:00.000Z';
  fs.writeFileSync(path.join(root, 'out/manifest.json'), JSON.stringify({
    startedAt,
    tests: [
      { title: 'TC-DEMO-1-01 adds', file: 'e2e/a.spec.ts', line: 3, ok: false, status: 'failed', errors: ['expected 1 got 0'],
        videos: ['p/a.failed.webm'], keyframes: [{ label: 'step failed: add', path: 'p/a.failed.keyframes/01-add.png' }] },
      { title: 'TC-OTHER-1-01 unrelated', file: 'e2e/b.spec.ts', line: 1, ok: true, status: 'passed', videos: [], keyframes: [] },
    ],
  }));

  assert.deepEqual(readEvidence(cfg, { casePrefix: 'TC-DEMO-1-', since: '2026-01-01T10:00:01.000Z' }), []);
  const tests = readEvidence(cfg, { casePrefix: 'TC-DEMO-1-', since: '2026-01-01T09:59:59.000Z' });
  assert.equal(tests.length, 1);
  const frame = path.join(root, 'out', 'p/a.failed.keyframes/01-add.png');
  assert.equal(tests[0].keyframes[0].path, frame);

  const text = formatEvidence(tests);
  assert.match(text, /FAILED: failed/);
  assert.match(text, /expected 1 got 0/);
  assert.ok(text.includes(`1. step failed: add: \`${frame}\``));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a pid recorded before a reboot is never alive, and locks from older versions (pid only) still count', () => {
  assert.equal(isProcessAlive(process.pid, bootId()), true);
  if (bootId()) assert.equal(isProcessAlive(process.pid, 'another-boot'), false, 'the pid may have been reused since');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'run.lock');
  fs.writeFileSync(file, String(process.pid));
  assert.equal(lockHolder(file), process.pid);
  assert.equal(acquireLock(file), false);
  fs.writeFileSync(file, `${process.pid} another-boot`);
  if (bootId()) assert.equal(acquireLock(file), true, 'a lock left by an earlier boot is taken over');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("lintFiles runs the commit hook's linters on the agent's files and skips linters that are not installed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-lint-'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/mdlint'), '');
  const config = { root, precheck: { lint: { '.md': ['bin/mdlint', '{files}'], '.ts': ['node_modules/.bin/eslint', '{files}'], '.cs': ['dotnet', 'format', '{files}'], '.yaml': ['node_modules/.bin/yamllint', '{files}'] } } };
  // The repository configured .ts itself; .yaml is only an engine default, so its absence is not an error.
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ precheck: { lint: { '.ts': ['node_modules/.bin/eslint', '{files}'] } } }));
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd === 'dotnet' ? { status: 127, stdout: '', stderr: 'not found' } : { status: 1, stdout: 'a.md:19 error MD060/table-column-style', stderr: '' };
  };
  const errors = lintFiles(config, ['plans/a.md', 'plans/b.md', 'e2e/a.spec.ts', 'tests/A.cs', 'x.yaml'], { runner });
  assert.deepEqual(calls, [['bin/mdlint', 'plans/a.md', 'plans/b.md'], ['dotnet', 'format', 'tests/A.cs']], 'a missing local linter binary is not run');
  assert.equal(errors.length, 2, 'a linter that is not on PATH (127) is skipped; a configured local one that is missing is reported');
  assert.match(errors[0], /`mdlint` .*failed on plans\/a\.md, plans\/b\.md:\n.*MD060/);
  assert.match(errors[1], /node_modules\/\.bin\/eslint` \(precheck\.lint for \.ts\) is not installed in this checkout/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('automationUpToDate: an unchanged implementation is not automated again, unless the run stopped on a plan that is now verified', () => {
  const a = (status) => ({ status, workingHash: 'h1' });
  assert.equal(automationUpToDate(a('running'), 'h2'), true);
  assert.equal(automationUpToDate(a('escalated'), 'h1'), true);
  assert.equal(automationUpToDate(a('escalated'), 'h2'), false, 'a changed implementation is automated');
  assert.equal(automationUpToDate(a('interrupted'), 'h1'), false);
  assert.equal(automationUpToDate(a('blocked-on-plan'), 'h1', 'escalated'), true, 'still blocked: nothing to do');
  assert.equal(automationUpToDate(a('blocked-on-plan'), 'h1', 'verified'), false, 'the plan was fixed: automate');
});

test('fixFiles auto-fixes the agent files by extension, ignores exit codes and skips fixers that are not installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-fix-'));
  const config = { root, precheck: { fix: { '.ts': ['node_modules/.bin/eslint', '--fix', '{files}'], '.cs': ['dotnet', 'format', 'whitespace', '--include', '{files}'] } } };
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 2, stdout: '', stderr: 'could not fix everything' };
  };
  const fixed = fixFiles(config, ['e2e/a.spec.ts', 'tests/A.cs', 'tests/B.cs', 'plans/a.md'], { runner });
  assert.deepEqual(calls, [['dotnet', 'format', 'whitespace', '--include', 'tests/A.cs', 'tests/B.cs']], 'a missing local fixer binary is skipped; extensions with no fixer are left alone');
  assert.deepEqual(fixed, ['tests/A.cs', 'tests/B.cs']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a case title is its heading only: a front-matter title is refused (markdownlint MD025 counts it as a second H1; dogfood step 5)', async () => {
  const { caseTitle, precheckPlan } = await import('../lib/plans.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-title-'));
  const dir = '.factory/plans/BUG-7-x';
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  const body = (id) => `# ${id}: Home renders\n\n## Why\n\n- w\n\n## Preconditions\n\n- p\n\n## Steps\n\n1. s\n\n## Expected result\n\n- e\n`;
  const write = (name, fm, id) => fs.writeFileSync(path.join(root, dir, name), `---\nid: ${id}\n${fm}type: happy\nlayer: e2e\ncovers: ["Expected"]\n---\n\n${body(id)}`);
  write('TC-BUG-7-01-home.md', '', 'TC-BUG-7-01');
  write('TC-BUG-7-02-cart.md', 'title: Cart renders\n', 'TC-BUG-7-02');
  fs.writeFileSync(path.join(root, dir, '_index.md'), '---\nstory: BUG-7\n---\n\n# Test plan: BUG-7\n\n| ID | Title |\n| --- | --- |\n| TC-BUG-7-01 | a |\n| TC-BUG-7-02 | b |\n');
  const config = { root, categories: { sadPathSubtypes: ['validation'] } };
  const { plan, errors } = precheckPlan(config, { key: 'BUG-7', planDir: dir });
  assert.ok(errors.some((e) => /TC-BUG-7-02-cart\.md: remove `title` from the front matter/.test(e)), errors.join('\n'));
  assert.ok(!errors.some((e) => /TC-BUG-7-01-home\.md/.test(e)), errors.join('\n'));
  assert.equal(caseTitle(plan.cases.find((c) => c.name.startsWith('TC-BUG-7-01'))), 'Home renders');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the retro digest shows what did not go through on its own: escalations, failed outcomes, first verifier scores, PR checks (dogfood step 5)', () => {
  const config = { lessons: { examplesPerCategory: 5 } };
  const d = retroDigest(config, [], '2026-11-01T00:00:00Z', {
    escalations: [{ ts: '2026-11-13T06:38:03Z', story: 'BUG-7', stage: 'plan', title: 'plan did not reach 9/10 in 5 rounds' }],
    implementRuns: [{ ts: '2026-11-13T06:38:30Z', story: 'BUG-7', outcome: 'fv-blocked-on-plan', reason: 'Feature verification ended blocked-on-plan' }, { ts: '2026-11-13T07:47:00Z', story: 'BUG-7', outcome: 'done' }],
    verifierRuns: [{ ts: '2026-11-13T07:30:20Z', story: 'BUG-7', stage: 'plan', round: 2, score: 7, gaps: 6 }, { ts: '2026-11-13T07:31:30Z', story: 'BUG-7', stage: 'plan', round: 3, score: 9, gaps: 2 }],
    prChecks: [{ ts: '2026-11-13T08:07:14Z', target: 'pr-21', story: 'BUG-7', round: 3, score: 9, upheld: [{ id: 'VID-1-1', lens: 'video', severity: 'minor', title: 'callout clipped', repeat: true }] }],
  });
  assert.deepEqual(d.escalations.map((e) => [e.story, e.stage]), [['BUG-7', 'plan']]);
  assert.deepEqual(d.runOutcomes.map((r) => r.outcome), ['fv-blocked-on-plan']);
  assert.deepEqual(d.firstVerifierScores, [{ story: 'BUG-7', stage: 'plan', firstRound: 2, score: 7, gaps: 6, rounds: 2, finalScore: 9 }]);
  assert.equal(d.prChecks[0].target, 'pr-21');
  assert.deepEqual(d.prChecks[0].upheld.map((u) => u.id), ['VID-1-1']);
  assert.equal(digestIsEmpty({ ...d, counts: {} }), false, 'an escalation alone is enough for the retro to run');
});

// Council C9 (CANC-1): a whole-project run that passed before the PR could not be explained afterwards: its record had no
// head and no test count. The counts are read from the runner's own summary; "success" with no test ran is a failure.
test('test counts are read from the runner summaries the packs use', async () => {
  const { testCounts } = await import('../lib/workflows.mjs');
  assert.deepEqual(testCounts('Test run summary: Failed!\n  total: 27\n  failed: 1\n  succeeded: 26\n'), { total: 27, failed: 1 });
  assert.deepEqual(testCounts('Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12'), { total: 12, failed: 0 });
  assert.deepEqual(testCounts('Tests:       1 failed, 26 passed, 27 total'), { total: 27, failed: 1 });
  assert.deepEqual(testCounts('==== 26 passed, 1 failed in 3.1s ===='), { total: 27, failed: 1 });
  assert.deepEqual(testCounts('Test run summary: Zero tests ran\n  total: 0\n  failed: 0\n'), { total: 0, failed: 0 });
  assert.equal(testCounts('Build succeeded.'), null);
  const { runSummary } = await import('../lib/workflows.mjs');
  const out = 'failed eShop.Ordering.FunctionalTests.OrderingApiTests.GetStoredOrdersWithOrderId (19ms)\nTest run summary: Failed!\n  total: 27\n  failed: 1\n  succeeded: 26\n';
  assert.deepEqual(runSummary(out), { failedTests: ['eShop.Ordering.FunctionalTests.OrderingApiTests.GetStoredOrdersWithOrderId'], summary: ['Test run summary: Failed!', 'total: 27', 'failed: 1', 'succeeded: 26'] });
  assert.deepEqual(runSummary('  Failed Ns.T.M [12 ms]\nFailed!  - Failed: 1, Passed: 3').failedTests, ['Ns.T.M']);
});

// Council C9 proof run: the precheck demanded a sad case for a story with no error outcome; the council rejected the
// invented ones, and the planner went back and forth for five rounds. A plan may say why it has none.
test('a plan with no sad case passes the precheck only when its index says why under "## No sad path"', async () => {
  const { precheckPlan } = await import('../lib/plans.mjs');
  const story = { key: 'TYPE-1', planDir: 'plans/TYPE-1' };
  const kase = '---\nid: TC-TYPE-1-01\ntype: happy\ncovers: AC1\nlayer: e2e\n---\n# TC-TYPE-1-01: shows the category\n\n## Why\nAC1\n\n## Preconditions\nstack\n\n## Steps\nopen item 1\n\n## Expected result\nCategory: Footwear\n';
  const index = (extra) => `---\nstory: TYPE-1\n---\n# Test plan: TYPE-1\n\n| ID | Title | Type | Layer | Covers |\n| --- | --- | --- | --- | --- |\n| TC-TYPE-1-01 | shows the category | happy | e2e | AC1 |\n${extra}`;
  const reader = (idx) => ({ read: (p) => (p.endsWith('_index.md') ? idx : p.endsWith('TC-TYPE-1-01-category.md') ? kase : null), list: () => ['TC-TYPE-1-01-category.md'] });
  const config = { root: '/r', categories: { sadPathSubtypes: ['validation', 'not-found'] } };
  const without = precheckPlan(config, story, reader(index(''))).errors;
  assert.ok(without.some((e) => /no sad-path case\. Add one only where the story states or directly implies an error outcome/.test(e)), without.join('\n'));
  const declared = precheckPlan(config, story, reader(index('\n## No sad path\n\nThe story only adds a field to a page; it names no error and changes no existing one.\n'))).errors;
  assert.ok(!declared.some((e) => /sad-path/.test(e)), declared.join('\n'));
  assert.ok(precheckPlan(config, story, reader(index('\n## No sad path\n\n'))).errors.some((e) => /no sad-path case/.test(e)), 'an empty section explains nothing');
});

test('a verifier loop that ends without a pass says why: the last lowest score and the open gaps, not "did not reach" a score it reached', async () => {
  const { notPassed } = await import('../lib/workflows.mjs');
  const config = { loops: { requiredScore: 9 } };
  assert.equal(notPassed(config, 9, [{ id: 'g1' }]), 'last round: lowest score 9/10, 1 open gap(s); passing needs 9/10 and no open gap');
  assert.match(notPassed(config, null, []), /lowest score none\/10, 0 open gap/);
});

test('a plan stamp that is all digits stays a hash: written quoted, read back as text, and the plan is not stale', async () => {
  const { parseFrontMatter, stringifyFrontMatter } = await import('../../pipeline/lib/util.mjs');
  const { storyMatches } = await import('../../pipeline/lib/stories.mjs');
  // Written by 0.2.73 and earlier, unquoted: the live PRB-18 plan looked stale in every automation round.
  const legacy = parseFrontMatter('---\nstory-sha: 202826363866\nplan-sha: 012345678901\nverified-score: 10\n---\nbody\n').data;
  assert.equal(legacy['story-sha'], '202826363866');
  assert.equal(legacy['plan-sha'], '012345678901', 'a leading zero is kept');
  assert.equal(legacy['verified-score'], 10, 'other numbers are still numbers');
  const text = stringifyFrontMatter({ 'story-sha': '202826363866', other: 'true', n: 3 }, 'body\n');
  assert.match(text, /^story-sha: "202826363866"$/m);
  assert.match(text, /^other: "true"$/m);
  assert.match(text, /^n: 3$/m);
  assert.equal(parseFrontMatter(text).data['story-sha'], '202826363866');
  // The stamp compares as text with the story's hash.
  const story = 'x';
  const { ticketSha } = await import('../../pipeline/lib/stories.mjs');
  assert.ok(storyMatches(parseFrontMatter(`---\nstory-sha: ${ticketSha(story)}\n---\n`).data['story-sha'], story));
});
