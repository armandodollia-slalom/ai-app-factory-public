// The review, feature verification and PR check adapters of a council: each turns the merged result into its stage's
// own verdict shape, and routes disputes to the members that raised the finding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { councilFor, lateBox, mergeCouncil, runCouncil } from '../lib/council.mjs';
import { councilPairVerdict } from '../../implement/lib/orchestrate.mjs';
import { repeatedContradictions } from '../../feature-verification/lib/workflows.mjs';
import { readJsonl, writeJson } from '../lib/util.mjs';
import { councilArchitectureReview, reviewDisputesFile } from '../../review/lib/review.mjs';
import { councilVerifier } from '../../feature-verification/lib/verify.mjs';
import { councilLenses, scoreRound } from '../../pr-check/lib/loop.mjs';
import { isResolvesQuestion, RESOLVES_ANSWER } from './fixtures/resolves-question.mjs';
import { poolSettings, seatedCouncil } from './fixtures/pool.mjs';

const members = [
  { name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' },
  { name: 'sol', cli: 'codex', model: 'sol', lens: 'security' },
  { name: 'tests', cli: 'copilot', model: 'sonnet', lens: 'test-value' },
];

// These councils were written for a pass score of 9 (GEN-8: each stage's own councilPassScore).
const at9 = Object.fromEntries(['implement', 'architectureReview', 'testPlan', 'testAutomation', 'prCheck'].map((s) => [s, { councilPassScore: 9 }]));
// The members are the pool; each test seats the council it needs (seatedCouncil), as the stage's orchestrator will.
function repo({ members: pool }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-stage-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n.factory/metrics/\n');
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ baseRef: 'main', ...at9, ...poolSettings(pool) }));
  fs.writeFileSync(path.join(dir, 'story.md'), '# SHOP-1: Orders\n\n## Acceptance Criteria\n\n- a user sees only their orders\n');
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat/shop-1');
  fs.writeFileSync(path.join(dir, 'a.js'), 'y\n');
  git('commit', '-qam', 'change');
  return dir;
}
const out = (o) => ({ status: 0, output: `AGENT_RESULT: ${JSON.stringify(o)}` });

test('review council: merged findings, the members\' own scores, and a dispute ruled only by the members that raised it', async () => {
  const dir = repo({ members });
  const config = loadConfig('review', dir);
  const council = seatedCouncil(config, 'architectureReview', members);
  const story = { key: 'SHOP-1', file: 'story.md' };
  const finding = { severity: 'blocking', category: 'security', file: 'a.js', line: 1, issue: 'any user reads any order', fix: 'filter by owner' };
  const tasks = {};
  const round1 = { opus: out({ verdict: 'CHANGES_REQUESTED', score: 5, findings: [finding] }), sol: out({ verdict: 'CHANGES_REQUESTED', score: 4, findings: [{ ...finding, line: 2 }] }), tests: out({ verdict: 'APPROVED', score: 9, findings: [] }) };
  const r1 = await councilArchitectureReview(config, story, 1, { council, runMember: async (m, task) => isResolvesQuestion(task) ? { status: 0, output: RESOLVES_ANSWER } : ((tasks[m.name] = task), round1[m.name]) });
  assert.equal(r1.verdict, 'CHANGES_REQUESTED');
  assert.equal(r1.findings.filter((f) => f.severity === 'blocking').length, 1);
  assert.match(r1.findings[0].issue, /any user reads any order \[raised by opus, sol\]/);
  assert.match(tasks.opus, /Review round: 1 of at most 5[\s\S]*## Council member/);
  // The implementer disputes it (implement/lib/feedback.mjs writes this file); only opus and sol rule on it.
  writeJson(reviewDisputesFile(config, 'SHOP-1'), { open: [{ id: 'review-r1-1', issue: r1.findings[0].issue, kind: 'out-of-scope', reason: 'no AC' }], overruled: [], state: { 'review-r1-1': { disputes: 1, reasserts: 0 } } });
  const round2 = { opus: out({ verdict: 'APPROVED', score: 9, findings: [], disputes: [{ finding: 'review-r1-1', decision: 'accepted' }] }), sol: out({ verdict: 'APPROVED', score: 9, findings: [], disputes: [{ finding: 'review-r1-1', decision: 'accepted' }] }), tests: out({ verdict: 'APPROVED', score: 10, findings: [] }) };
  const r2 = await councilArchitectureReview(config, story, 2, { council, runMember: async (m, task) => isResolvesQuestion(task) ? { status: 0, output: RESOLVES_ANSWER } : ((tasks[m.name] = task), round2[m.name]) });
  assert.match(tasks.opus, /Implementer disputes of your last findings[\s\S]*review-r1-1 \(out-of-scope\)/);
  assert.match(tasks.sol, /review-r1-1 \(out-of-scope\)/);
  assert.doesNotMatch(tasks.tests, /review-r1-1 \(out-of-scope\)|Implementer disputes of your last findings/);
  assert.equal(r2.verdict, 'APPROVED');
  const recs = readJsonl(path.join(dir, '.factory/metrics/council-rounds.jsonl'));
  assert.deepEqual(recs.map((r) => [r.stage, r.round, r.pass, r.score]), [['architectureReview', 1, false, 4], ['architectureReview', 2, true, 9]]);
  // Council r1 (sol-12): the finding records and the outcome the next round writes carry one id, so they join.
  const found = readJsonl(path.join(dir, '.factory/metrics/council-findings.jsonl'));
  assert.deepEqual([...new Set(found.filter((r) => r.kind === 'finding').map((r) => r.finding))], ['review-r1-1']);
  assert.deepEqual(found.filter((r) => r.kind === 'outcome' && r.round === 1).map((r) => r.finding), ['review-r1-1']);
});

test('test automation council: the stage\'s score-and-gaps contract, merged; pass needs every blocking member at passScore', async () => {
  const dir = repo({ members });
  const config = loadConfig('feature-verification', dir);
  const council = seatedCouncil(config, 'testAutomation', [members[0], members[2]]);
  assert.equal(council.maxCouncilRounds, 5);
  const gap = { case: 'TC-SHOP-1-01', category: 'wrong-assertion', detail: 'asserts 200 only, never the body' };
  const answers = { opus: out({ score: 6, gaps: [gap] }), tests: out({ score: 7, gaps: [{ ...gap, detail: 'the body is never checked for the owner' }, { case: 'TC-SHOP-1-02', category: 'over-mocked', action: 'delete-test', severity: 'major', test: 'TC-SHOP-1-02 mocks the repository', detail: 'only checks the mock' }] }) };
  const v = await councilVerifier(config, { stage: 'automation', story: { key: 'SHOP-1' }, round: 1, task: 'verify the tests', producerVersion: 'p1', council, runMember: async (m) => answers[m.name] });
  assert.equal(v.passed, false);
  assert.equal(v.score, 6);
  assert.deepEqual(v.gaps.map((g) => [g.case, g.category, g.subtype]), [['TC-SHOP-1-01', 'wrong-assertion', null], ['TC-SHOP-1-02', 'over-mocked', 'delete-test']]);
  assert.match(v.gaps[1].detail, /^DELETE TEST TC-SHOP-1-02 mocks the repository/);
  const ok = await councilVerifier(config, { stage: 'automation', story: { key: 'SHOP-1' }, round: 2, task: 't', producerVersion: 'p1', council, runMember: async () => out({ score: 10, gaps: [] }) });
  assert.equal(ok.passed, true);
  assert.equal(readJsonl(path.join(dir, '.factory/metrics/verifier-runs.jsonl')).at(-1).members.length, 2);
});

test('PR check council: members are critics named after themselves; the acceptance critic stays unless a member has that lens', () => {
  const lenses = councilLenses(seatedCouncil(poolSettings(members), 'prCheck', members));
  assert.deepEqual(Object.entries(lenses).map(([k, v]) => [k, v.agent]), [['opus', 'pr-check-flow'], ['sol', 'pr-check-flow'], ['tests', 'pr-check-style'], ['acceptance', 'pr-check-acceptance']]);
  const withAccMembers = [...members, { name: 'ac', cli: 'claude', model: 'opus', lens: 'acceptance' }];
  const withAcc = councilLenses(seatedCouncil(poolSettings(withAccMembers), 'prCheck', withAccMembers));
  assert.equal(withAcc.acceptance, undefined);
  assert.equal(withAcc.ac.agent, 'pr-check-acceptance');
  // An acceptance-lens member's coverage table is reconciled like the acceptance critic's: an open line never passes.
  const scored = scoreRound({ lenses: ['ac', 'opus'], findings: [], rulings: [], coverage: { ac: { coverage: [{ ref: 'AC 1: a user sees only their orders', status: 'unmet', evidence: 'none' }] } }, acceptanceLenses: ['ac'] });
  assert.equal(scored.upheld.length, 1);
  assert.equal(scored.upheld[0].lens, 'ac');
  assert.ok(scored.lensScores.ac < 10);
});

test('feature verification council: a non-blocking member\'s late result is feedback in the next round; a repeated contradiction is an owner question', async () => {
  const slow = { name: 'slow', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false };
  const dir = repo({ members: [...members, slow] });
  const config = loadConfig('feature-verification', dir);
  const council = seatedCouncil(config, 'testAutomation', [members[0], slow]);
  const late = lateBox();
  let release;
  const gate = new Promise((r) => (release = r));
  const run = async (m) => {
    if (m.name === 'slow') {
      await gate;
      return out({ score: 2, gaps: [{ case: 'TC-SHOP-1-03', category: 'over-mocked', detail: 'mocks the repository it tests' }] });
    }
    return out({ score: 10, gaps: [] });
  };
  const v1 = await councilVerifier(config, { stage: 'automation', story: { key: 'SHOP-1' }, round: 1, task: 't', producerVersion: 'p', council, runMember: run, late });
  assert.equal(v1.passed, true, 'the non-blocking member is not waited for');
  release();
  await new Promise((r) => setTimeout(r, 20));
  const v2 = await councilVerifier(config, { stage: 'automation', story: { key: 'SHOP-1' }, round: 2, task: 't', producerVersion: 'p', council, runMember: async () => out({ score: 10, gaps: [] }), late });
  assert.equal(v2.passed, true);
  assert.equal(v2.notes.length, 1);
  assert.match(v2.notes[0].note, /feedback from non-blocking member slow/);
  assert.match(v2.notes[0].detail, /mocks the repository it tests/);

  const seen = new Set();
  const contradiction = { council: { contradictions: [{ subject: 'totals test' }] } };
  assert.deepEqual(repeatedContradictions(contradiction, seen), [], 'once: not yet a question');
  assert.deepEqual(repeatedContradictions(contradiction, seen), ['totals test'], 'twice running: an owner question');
  assert.deepEqual(repeatedContradictions({ council: { contradictions: [] } }, seen), []);
});

test('review council: a non-blocking member runs detached, is not waited for, and its late result is feedback in the next round', { skip: process.platform === 'win32' }, async () => {
  const seats = [members[0], { name: 'slow', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false }];
  const dir = repo({ members: seats });
  const agent = path.join(dir, '..', `${path.basename(dir)}-agent.mjs`);
  const go = path.join(dir, '..', `${path.basename(dir)}-go`);
  // The slow member answers only once the test lets it (after round 1 has ended), so the timing never decides.
  fs.writeFileSync(agent, [
    "import fs from 'node:fs';",
    "const slow = process.env.PIPELINE_COUNCIL_MEMBER === 'slow';",
    // Bounded: a member that never sees the gate still ends (and so does the review's wait for it).
    `if (slow) for (let i = 0; i < 600 && !fs.existsSync(${JSON.stringify(go)}); i++) await new Promise((r) => setTimeout(r, 50));`,
    "const r = slow ? { verdict: 'CHANGES_REQUESTED', score: 3, findings: [{ severity: 'major', file: 'a.js', line: 1, issue: 'a.js could be one line' }] } : { verdict: 'APPROVED', score: 10, findings: [] };",
    "console.log('AGENT_RESULT: ' + JSON.stringify(r));",
  ].join('\n'));
  const saved = process.env.PIPELINE_AGENT_CMD;
  process.env.PIPELINE_AGENT_CMD = `"${process.execPath}" "${agent}"`;
  try {
    const config = loadConfig('review', dir);
    const story = { key: 'SHOP-1', file: 'story.md' };
    const council = seatedCouncil(config, 'architectureReview', seats);
    const r1 = await councilArchitectureReview(config, story, 1, { council });
    assert.equal(r1.verdict, 'APPROVED', 'the round ended without the non-blocking member');
    assert.equal(r1.council.members.find((m) => m.name === 'slow').status, 'late');
    fs.writeFileSync(go, '');
    const lateDir = path.join(dir, '.factory/state/council/review-SHOP-1');
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(lateDir, 'r1-slow.result.json')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    // Council r5 (sol-26): the detached member records its finding itself when it finishes, though no further round may
    // ever read it (the deciding member passed): marked feedback, no outcome.
    const fed = () => readJsonl(path.join(dir, '.factory/metrics/council-findings.jsonl')).filter((r) => r.kind === 'finding' && r.seat === 'slow' && r.round === 1);
    const until = Date.now() + 30_000;
    while (!fed().length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(fed().map((r) => [r.feedback, r.file]), [[true, 'a.js']]);
    // Council r3 (T9): the detached member's usage row names its seat and its lens.
    const usage = readJsonl(path.join(dir, '.factory/metrics/token-usage.jsonl')).filter((u) => u.seat === 'slow');
    assert.ok(usage.length, 'the detached member\'s run is in the usage');
    assert.deepEqual([...new Set(usage.map((u) => u.lens))], ['rewrite']);
    const r2 = await councilArchitectureReview(config, story, 2, { council });
    assert.equal(r2.verdict, 'APPROVED', 'feedback never blocks');
    assert.match(r2.findings.find((f) => f.feedback)?.issue ?? '', /a\.js could be one line \(feedback from non-blocking member slow\)/);
    assert.ok(!fs.existsSync(path.join(lateDir, 'r1-slow.result.json')), 'consumed once');
    assert.equal(fed().length, 1, 'recorded once, though round 2 read it as feedback');
    // Round 2's own slow member is late again; let it finish before the repository goes.
    const end = Date.now() + 60_000;
    while (!fs.existsSync(path.join(lateDir, 'r2-slow.result.json')) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    // Round 2 read round 1's finding as feedback without recording it again: its only row from slow is slow's own round 2.
    const round2 = () => readJsonl(path.join(dir, '.factory/metrics/council-findings.jsonl')).filter((r) => r.kind === 'finding' && r.seat === 'slow' && r.round === 2);
    while (!round2().length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(round2().length, 1, JSON.stringify(round2()));
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_AGENT_CMD;
    else process.env.PIPELINE_AGENT_CMD = saved;
    fs.rmSync(agent, { force: true });
    fs.rmSync(go, { force: true });
  }
});

// GEN-9: lenses are no longer settings. The harness gives the seats the stage's lenses in order, its core lens first,
// and the ui lens only to an entry whose CLI can drive a browser.
test('each seat gets the stage\'s lenses in order, core lens first; ui never goes to a Codex entry', () => {
  const two = [{ name: 'opus', cli: 'claude', model: 'opus' }, { name: 'sol', cli: 'codex', model: 'sol' }];
  const seated = (pool, stage, section) => councilFor({ ...poolSettings(pool), [section]: { councilMembers: 2 } }, stage).members.map((m) => [m.name, m.lens]);
  assert.deepEqual(seated(two, 'testAutomation', 'testAutomation'), [['opus', 'test-value'], ['sol', 'correctness']]);
  assert.deepEqual(seated(two, 'architectureReview', 'architectureReview'), [['opus', 'correctness'], ['sol', 'security']]);
  assert.deepEqual(seated(two, 'prCheck', 'prCheck'), [['opus', 'acceptance'], ['sol', 'correctness']]);
  assert.deepEqual(seated(two, 'pairUiVerify', 'implement'), [['opus', 'ui'], ['sol', 'correctness']]);
  assert.deepEqual(seated([two[1], two[0]], 'pairUiVerify', 'implement'), [['sol', 'correctness'], ['opus', 'ui']], 'the ui lens moves to the entry that can drive a browser');
  assert.deepEqual(seated([two[1], { ...two[1], name: 'sol2' }], 'pairUiVerify', 'implement'), [['sol', 'correctness'], ['sol2', 'acceptance']], 'no ui seat when no entry can drive a browser');
});

// C14 proof: a two-member PR check council (correctness and test-value) ran without the design, video and flow critics:
// the mockup, the recordings and the list of behaviour changes outside the ticket were judged by nobody.
test('a PR check council keeps the stage\'s own critics no member covers: design, video, and flow for side effects', async () => {
  const { activeLenses } = await import('../../pr-check/lib/loop.mjs');
  const two = [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', lens: 'test-value' }];
  const ctx = (lenses, { frontend = true, videos = 1 } = {}) => ({ councilLenses: councilLenses(seatedCouncil(poolSettings(two), 'prCheck', two.map((m) => ({ ...m, lens: lenses[m.name] ?? m.lens })))), isFrontend: frontend, video: { videos: Array(videos).fill('v'), unreadable: [] } });
  assert.deepEqual(activeLenses(ctx({})), ['opus', 'sol', 'acceptance', 'design', 'video'], 'flow is covered by the correctness member');
  assert.deepEqual(activeLenses(ctx({ opus: 'acceptance' }, { frontend: false, videos: 0 })), ['opus', 'sol', 'flow']);
});

// Council C9 proof run (TYPE-1): a Codex member in pairUiVerify could neither start Chromium (its sandbox denied
// bootstrap_check_in) nor reach the leased stack (curl exit 7), so it could never give a verdict.
test('a Codex member sits in pairUiVerify without the ui lens, checks the app over HTTP, and its verify runs may reach localhost', async () => {
  const { cliInvocation } = await import('../lib/agents.mjs');
  const { uiVerifierTask } = await import('../../implement/lib/tasks.mjs');
  const codex = { agent: { cmd: null } };
  const args = (mode) => cliInvocation(codex, { prompt: 'p', mode, model: null, cli: 'codex', cwd: '/repo/wt' }).args;
  assert.ok(args('verify').includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!args('read').includes('sandbox_workspace_write.network_access=true'), 'read mode stays offline');
  assert.equal(args('read')[args('read').indexOf('--sandbox') + 1], 'read-only');
  const st = { id: 'self', goal: 'g', owns: ['src/WebApp/**'], acceptance: ['a'], verify: 'ui' };
  const base = { key: 'TYPE-1', st, round: 1, maxRounds: 3, diff: '', checks: '', diagnostics: '', webappUrl: 'http://localhost:29080', screenshotsDir: '/s/sol', worktree: '/w' };
  assert.match(uiVerifierTask({ ...base, browser: false }), /cannot start a browser: do not try Playwright or Chromium\. Check every acceptance criterion over HTTP against the running app at http:\/\/localhost:29080/);
  assert.doesNotMatch(uiVerifierTask(base), /cannot start a browser/);
  assert.match(uiVerifierTask(base), /Check every acceptance criterion in the browser/);
});

// Council r3 (sol-11): a shadow seat's finding is feedback in every stage. It never enters a verdict, never becomes
// blocking through the user-error raise, and the deciding member alone passes the stage. One test per stage; the PR
// check's is in pr-check-council.test.mjs (the panel's shadow).
const decider = { name: 'opus', cli: 'claude', model: 'opus', lens: 'all' };
const shadow = { name: 'sol', cli: 'codex', model: 'sol', lens: 'all', blocking: false };
const outage = { severity: 'blocking', category: 'correctness', file: 'a.js', line: 1, issue: 'Saving returns HTTP 500', detail: 'Saving returns HTTP 500', evidence: 'POST /orders answers 500', fix: 'handle the save' };

test('architecture review: the deciding member passes with nothing; the shadow\'s "Saving returns HTTP 500" stays feedback, never blocking', async () => {
  const dir = repo({ members: [decider, shadow] });
  const config = loadConfig('review', dir);
  const council = { ...seatedCouncil(config, 'architectureReview', [decider, shadow]), sole: false, shadow: 'sol' };
  const answers = { opus: out({ verdict: 'APPROVED', score: 10, findings: [] }), sol: out({ verdict: 'CHANGES_REQUESTED', score: 2, findings: [outage] }) };
  const r = await councilArchitectureReview(config, { key: 'SHOP-1', file: 'story.md' }, 1, { council, runMember: async (m, task) => (isResolvesQuestion(task) ? { status: 0, output: RESOLVES_ANSWER } : answers[m.name]) });
  assert.equal(r.verdict, 'APPROVED');
  assert.deepEqual(r.findings.filter((f) => f.severity === 'blocking'), []);
  const note = r.findings.find((f) => /HTTP 500/.test(f.issue));
  assert.ok(note && note.feedback && !note.raisedBy, JSON.stringify(r.findings));
});

test('test plan and test automation: the deciding member passes with nothing; the shadow\'s gap is a note, never a gap', async () => {
  const dir = repo({ members: [decider, shadow] });
  const config = loadConfig('feature-verification', dir);
  for (const [stage, councilStage] of [['plan', 'testPlan'], ['automation', 'testAutomation']]) {
    const council = { ...seatedCouncil(config, councilStage, [decider, shadow]), sole: false, shadow: 'sol' };
    const answers = { opus: out({ score: 10, gaps: [] }), sol: out({ score: 2, gaps: [{ case: 'TC-SHOP-1-01', category: 'other', severity: 'blocking', detail: 'Saving returns HTTP 500' }] }) };
    const v = await councilVerifier(config, { stage, story: { key: 'SHOP-1' }, round: 1, task: 't', producerVersion: 'p', council, runMember: async (m) => answers[m.name] });
    assert.deepEqual([stage, v.passed, v.score, v.gaps], [stage, true, 10, []]);
    assert.match(v.notes.find((n) => /HTTP 500/.test(n.detail))?.note ?? '', /feedback from non-blocking member sol/);
  }
});

test('pair verify and pair UI verify: the deciding member passes with nothing; the shadow\'s finding is a minor note', async () => {
  const dir = repo({ members: [decider, shadow] });
  const config = loadConfig('implement', dir);
  for (const stage of ['pairVerify', 'pairUiVerify']) {
    const council = { ...seatedCouncil(config, stage, [decider, shadow]), sole: false, shadow: 'sol' };
    const answers = { opus: out({ verdict: 'APPROVED', score: 10, findings: [] }), sol: out({ verdict: 'CHANGES_REQUESTED', score: 2, findings: [outage] }) };
    const ran = await runCouncil({ council, taskFor: () => 't', run: async (m) => answers[m.name], parse: (text) => JSON.parse(text.slice(text.indexOf('{'))), log: () => {} });
    const v = councilPairVerdict(mergeCouncil(council, ran.results));
    assert.deepEqual([stage, v.verdict, v.findings.filter((f) => f.severity === 'blocking')], [stage, 'APPROVED', []]);
    assert.ok(v.findings.find((f) => /HTTP 500/.test(f.issue))?.feedback);
  }
  // Feedback is never raised, whatever it says: the user-error raise skips it.
  const { raiseUserErrors } = await import('../lib/user-errors.mjs');
  assert.deepEqual(raiseUserErrors([{ severity: 'minor', issue: 'Saving returns HTTP 500', feedback: true }], { to: 'blocking' }).raised, []);
});

// Council r3 (sol-21): a verifier result with no score was normalized to 0, which a pass score of 0 accepted.
test('a test verifier with no valid score never passes, even at a pass score of 0: one verifier or a council', async () => {
  const dir = repo({ members: [decider] });
  const config = loadConfig('feature-verification', dir);
  config.testPlan.councilPassScore = 0;
  const { normalizeVerdict } = await import('../../feature-verification/lib/verify.mjs');
  for (const raw of [{}, { score: null }, { score: '' }, { score: 'n/a' }, { score: 11 }, { score: -1 }]) {
    const v = normalizeVerdict(config, 'plan', raw);
    assert.deepEqual([JSON.stringify(raw), v.passed, v.gaps.map((g) => g.subtype)], [JSON.stringify(raw), false, ['no-score']]);
  }
  assert.equal(normalizeVerdict(config, 'plan', { score: 0 }).passed, true, 'a real 0 at a pass score of 0 passes');
  const council = seatedCouncil(config, 'testPlan', [decider]);
  const v = await councilVerifier(config, { stage: 'plan', story: { key: 'SHOP-1' }, round: 1, task: 't', producerVersion: 'p', council, runMember: async () => out({}) });
  assert.equal(v.passed, false);
});
