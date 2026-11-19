// The review, feature verification and PR check adapters of a council: each turns the merged result into its stage's
// own verdict shape, and routes disputes to the members that raised the finding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { councilFor, lateBox } from '../lib/council.mjs';
import { repeatedContradictions } from '../../feature-verification/lib/workflows.mjs';
import { readJsonl, writeJson } from '../lib/util.mjs';
import { councilArchitectureReview, reviewDisputesFile } from '../../review/lib/review.mjs';
import { councilVerifier } from '../../feature-verification/lib/verify.mjs';
import { councilLenses, scoreRound } from '../../pr-check/lib/loop.mjs';

const members = [
  { name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' },
  { name: 'sol', cli: 'codex', model: 'sol', lens: 'security' },
  { name: 'tests', cli: 'copilot', model: 'sonnet', lens: 'test-value' },
];

function repo(council) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-stage-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n.factory/metrics/\n');
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ baseRef: 'main', agent: { modelIds: { codex: { sol: 'gpt-6.1-sol' } } }, council }));
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
  const dir = repo({ members, stages: { review: {} } });
  const config = loadConfig('review', dir);
  const story = { key: 'SHOP-1', file: 'story.md' };
  const finding = { severity: 'blocking', category: 'security', file: 'a.js', line: 1, issue: 'any user reads any order', fix: 'filter by owner' };
  const tasks = {};
  const round1 = { opus: out({ verdict: 'CHANGES_REQUESTED', score: 5, findings: [finding] }), sol: out({ verdict: 'CHANGES_REQUESTED', score: 4, findings: [{ ...finding, line: 2 }] }), tests: out({ verdict: 'APPROVED', score: 9, findings: [] }) };
  const r1 = await councilArchitectureReview(config, story, 1, { runMember: async (m, task) => ((tasks[m.name] = task), round1[m.name]) });
  assert.equal(r1.verdict, 'CHANGES_REQUESTED');
  assert.equal(r1.findings.filter((f) => f.severity === 'blocking').length, 1);
  assert.match(r1.findings[0].issue, /any user reads any order \[raised by opus, sol\]/);
  assert.match(tasks.opus, /Review round: 1 of at most 3[\s\S]*## Council member/);
  // The implementer disputes it (implement/lib/feedback.mjs writes this file); only opus and sol rule on it.
  writeJson(reviewDisputesFile(config, 'SHOP-1'), { open: [{ id: 'review-r1-1', issue: r1.findings[0].issue, kind: 'out-of-scope', reason: 'no AC' }], overruled: [], state: { 'review-r1-1': { disputes: 1, reasserts: 0 } } });
  const round2 = { opus: out({ verdict: 'APPROVED', score: 9, findings: [], disputes: [{ finding: 'review-r1-1', decision: 'accepted' }] }), sol: out({ verdict: 'APPROVED', score: 9, findings: [], disputes: [{ finding: 'review-r1-1', decision: 'accepted' }] }), tests: out({ verdict: 'APPROVED', score: 10, findings: [] }) };
  const r2 = await councilArchitectureReview(config, story, 2, { runMember: async (m, task) => ((tasks[m.name] = task), round2[m.name]) });
  assert.match(tasks.opus, /Implementer disputes of your last findings[\s\S]*review-r1-1 \(out-of-scope\)/);
  assert.match(tasks.sol, /review-r1-1 \(out-of-scope\)/);
  assert.doesNotMatch(tasks.tests, /review-r1-1 \(out-of-scope\)|Implementer disputes of your last findings/);
  assert.equal(r2.verdict, 'APPROVED');
  const recs = readJsonl(path.join(dir, '.factory/metrics/council-rounds.jsonl'));
  assert.deepEqual(recs.map((r) => [r.stage, r.round, r.pass, r.score]), [['review', 1, false, 4], ['review', 2, true, 9]]);
});

test('test automation council: the stage\'s score-and-gaps contract, merged; pass needs every blocking member at passScore', async () => {
  const dir = repo({ passScore: 9, members, stages: { testAutomation: { members: ['opus', 'tests'], rounds: 5 } } });
  const config = loadConfig('feature-verification', dir);
  const council = councilFor(config, 'testAutomation');
  assert.equal(council.rounds, 5);
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
  const lenses = councilLenses(councilFor({ council: { members, stages: { prCheck: {} } } }, 'prCheck'));
  assert.deepEqual(Object.entries(lenses).map(([k, v]) => [k, v.agent]), [['opus', 'pr-check-flow'], ['sol', 'pr-check-flow'], ['tests', 'pr-check-style'], ['acceptance', 'pr-check-acceptance']]);
  const withAcc = councilLenses(councilFor({ council: { members: [...members, { name: 'ac', cli: 'claude', model: 'opus', lens: 'acceptance' }], stages: { prCheck: {} } } }, 'prCheck'));
  assert.equal(withAcc.acceptance, undefined);
  assert.equal(withAcc.ac.agent, 'pr-check-acceptance');
  // An acceptance-lens member's coverage table is reconciled like the acceptance critic's: an open line never passes.
  const scored = scoreRound({ lenses: ['ac', 'opus'], findings: [], rulings: [], coverage: { ac: { coverage: [{ ref: 'AC 1: a user sees only their orders', status: 'unmet', evidence: 'none' }] } }, acceptanceLenses: ['ac'] });
  assert.equal(scored.upheld.length, 1);
  assert.equal(scored.upheld[0].lens, 'ac');
  assert.ok(scored.lensScores.ac < 10);
});

test('feature verification council: a non-blocking member\'s late result is feedback in the next round; a repeated contradiction is an owner question', async () => {
  const dir = repo({ members: [...members, { name: 'slow', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false }], stages: { testAutomation: { members: ['opus', 'slow'] } } });
  const config = loadConfig('feature-verification', dir);
  const council = councilFor(config, 'testAutomation');
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
  const dir = repo({ members: [members[0], { name: 'slow', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false }], stages: { review: {} } });
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
    const r1 = await councilArchitectureReview(config, story, 1);
    assert.equal(r1.verdict, 'APPROVED', 'the round ended without the non-blocking member');
    assert.equal(r1.council.members.find((m) => m.name === 'slow').status, 'late');
    fs.writeFileSync(go, '');
    const lateDir = path.join(dir, '.factory/state/council/review-SHOP-1');
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(lateDir, 'r1-slow.result.json')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const r2 = await councilArchitectureReview(config, story, 2);
    assert.equal(r2.verdict, 'APPROVED', 'feedback never blocks');
    assert.match(r2.findings.find((f) => f.feedback)?.issue ?? '', /a\.js could be one line \(feedback from non-blocking member slow\)/);
    assert.ok(!fs.existsSync(path.join(lateDir, 'r1-slow.result.json')), 'consumed once');
    // Round 2's own slow member is late again; let it finish before the repository goes.
    const end = Date.now() + 60_000;
    while (!fs.existsSync(path.join(lateDir, 'r2-slow.result.json')) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_AGENT_CMD;
    else process.env.PIPELINE_AGENT_CMD = saved;
    fs.rmSync(agent, { force: true });
    fs.rmSync(go, { force: true });
  }
});

// C14 (owner instruction): two members named opus and sol sit in every stage, each with a lens chosen per stage.
test('a stage can give a member its own lens; the lens is validated like the member\'s', async () => {
  const { councilProblems } = await import('../lib/council-config.mjs');
  const agent = { allowedModels: ['opus', 'sol'], modelIds: { claude: { opus: 'claude-opus-5-5' }, codex: { sol: 'gpt-6.1-sol' } } };
  const two = [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', lens: 'correctness' }];
  const council = { members: two, stages: { testAutomation: { lenses: { opus: 'acceptance', sol: 'test-value' } }, review: {} } };
  assert.deepEqual(councilProblems(council, agent), []);
  assert.deepEqual(councilFor({ council }, 'testAutomation').members.map((m) => [m.name, m.lens]), [['opus', 'acceptance'], ['sol', 'test-value']]);
  assert.deepEqual(councilFor({ council }, 'review').members.map((m) => m.lens), ['correctness', 'correctness'], 'the member\'s own lens elsewhere');
  assert.deepEqual(councilProblems({ members: two, stages: { review: { members: ['opus'], lenses: { sol: 'rewrite', opus: 'nope' } } } }, agent), [
    'council.stages.review.lenses names "sol", who does not sit for this stage',
    'council.stages.review.lenses.opus "nope" is not a lens (correctness, acceptance, security, test-value, rewrite, ui)',
  ]);
  assert.match(councilProblems({ members: two, stages: { review: { lenses: { sol: 'ui' } } } }, agent).join(), /lenses\.sol is ui/);
});

// C14 proof: a two-member PR check council (correctness and test-value) ran without the design, video and flow critics:
// the mockup, the recordings and the list of behaviour changes outside the ticket were judged by nobody.
test('a PR check council keeps the stage\'s own critics no member covers: design, video, and flow for side effects', async () => {
  const { activeLenses } = await import('../../pr-check/lib/loop.mjs');
  const two = [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', lens: 'test-value' }];
  const ctx = (council, { frontend = true, videos = 1 } = {}) => ({ councilLenses: councilLenses(councilFor({ council: { members: two, stages: { prCheck: council } } }, 'prCheck')), isFrontend: frontend, video: { videos: Array(videos).fill('v'), unreadable: [] } });
  assert.deepEqual(activeLenses(ctx({})), ['opus', 'sol', 'acceptance', 'design', 'video'], 'flow is covered by the correctness member');
  assert.deepEqual(activeLenses(ctx({ lenses: { opus: 'acceptance' } }, { frontend: false, videos: 0 })), ['opus', 'sol', 'flow']);
});

// Council C9 proof run (TYPE-1): a Codex member in pairUiVerify could neither start Chromium (its sandbox denied
// bootstrap_check_in) nor reach the leased stack (curl exit 7), so it could never give a verdict.
test('a Codex member sits in pairUiVerify without the ui lens, checks the app over HTTP, and its verify runs may reach localhost', async () => {
  const { councilProblems } = await import('../lib/council-config.mjs');
  const { cliInvocation } = await import('../lib/agents.mjs');
  const { uiVerifierTask } = await import('../../implement/lib/tasks.mjs');
  const agent = { allowedModels: ['opus', 'sol'], modelIds: { claude: { opus: 'claude-opus-5-5' }, codex: { sol: 'gpt-6.1-sol' } } };
  const two = [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', lens: 'correctness' }];
  assert.deepEqual(councilProblems({ members: two, stages: { pairUiVerify: { lenses: { opus: 'ui', sol: 'correctness' } } } }, agent), []);
  assert.match(councilProblems({ members: two, stages: { pairUiVerify: { lenses: { opus: 'correctness', sol: 'ui' } } } }, agent).join(), /sol runs on Codex, whose sandbox cannot start a browser/);
  assert.match(councilProblems({ members: [two[0], { ...two[1], lens: 'ui' }], stages: { pairUiVerify: {} } }, agent).join(), /Codex member's sandbox cannot start a browser/);
  const codex = { agent: { cli: 'codex', cmd: null, models: {} } };
  const args = (mode) => cliInvocation(codex, { prompt: 'p', mode, model: null, cwd: '/repo/wt' }).args;
  assert.ok(args('verify').includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!args('read').includes('sandbox_workspace_write.network_access=true'), 'read mode stays offline');
  assert.equal(args('read')[args('read').indexOf('--sandbox') + 1], 'read-only');
  const st = { id: 'self', goal: 'g', owns: ['src/WebApp/**'], acceptance: ['a'], verify: 'ui' };
  const base = { key: 'TYPE-1', st, round: 1, maxRounds: 3, diff: '', checks: '', diagnostics: '', webappUrl: 'http://localhost:29080', screenshotsDir: '/s/sol', worktree: '/w' };
  assert.match(uiVerifierTask({ ...base, browser: false }), /cannot start a browser: do not try Playwright or Chromium\. Check every acceptance criterion over HTTP against the running app at http:\/\/localhost:29080/);
  assert.doesNotMatch(uiVerifierTask(base), /cannot start a browser/);
  assert.match(uiVerifierTask(base), /Check every acceptance criterion in the browser/);
});
