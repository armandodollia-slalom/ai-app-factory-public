// GEN-16: a clean-code reviewer sits on every council beside the counted seats, no setting removes it, it is a strict
// arbiter (every upheld breach blocks, outside blockQuorum; a finding needs its rule id and, for a duplication, both
// copies), the orchestrator picks its entry under the diversity rule, and its searches and seat are recorded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { COUNCIL_STAGES } from '../lib/council-config.mjs';
import { COUNCIL_FILE, councilFor, isCleanCodeSeat, memberTask, mergeCouncil, recordCouncilRound, runCouncil, savedSeats, seatsFile } from '../lib/council.mjs';
import { computeScorecard } from '../lib/scorecard.mjs';
import { selectCouncil } from '../lib/selection.mjs';
import { readJsonl } from '../lib/util.mjs';
import { activeLenses, cleanCodeReview } from '../../pr-check/lib/loop.mjs';

const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { name: 'gem', cli: 'copilot', model: 'gemini-3-pro', effort: 'high' },
];
const SECTIONS = [...new Set(Object.values(COUNCIL_STAGES).map((s) => s.section))];
const settings = (count, pool = POOL) => ({ models: { pool, agents: { default: 'sonnet' } }, ...Object.fromEntries(SECTIONS.map((s) => [s, { councilMembers: count }])) });
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
};
const ok = (member, score, findings = []) => ({ member, status: 'ok', score, verdict: findings.length ? 'CHANGES_REQUESTED' : 'APPROVED', summary: '', findings });
const finding = (member, fields) => ({ lens: member.lens, severity: 'blocking', action: 'fix', member: member.name, text: 'x', evidence: 'src/a.js:3', file: 'src/a.js', line: 3, ...fields });

test('every verifier stage: councilMembers 1 sits two members, 3 sits four, exactly one on the clean-code lens', () => {
  for (const stage of Object.keys(COUNCIL_STAGES)) {
    for (const [count, sitting] of [[1, 2], [3, 4]]) {
      const c = councilFor(settings(count), stage);
      assert.equal(c.members.length, sitting, `${stage}, ${count}`);
      assert.deepEqual(c.members.filter((m) => m.lens === 'clean-code').map((m) => [m.name, m.blocking, m.fixed]), [['clean-code', true, true]], `${stage}, ${count}`);
    }
    // The sole counted member still reviews every lens.
    assert.equal(councilFor(settings(1), stage).members[0].lens, 'all');
  }
});

test('a settings file that removes or turns off the clean-code seat is refused at load, saying the seat is fixed', (t) => {
  for (const overlay of [{ council: { cleanCode: { enabled: false } } }, { prCheck: { councilMembers: 0 } }, { council: { members: 0 } }, { architectureReview: { excludeLenses: ['clean-code'] } }]) {
    const dir = tmp(t, 'fixed-seat-');
    fs.mkdirSync(path.join(dir, '.factory'));
    fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(overlay));
    assert.throws(() => loadConfig(null, dir), /the clean-code seat is fixed/, JSON.stringify(overlay));
  }
});

// A scripted orchestrator: each call answers the next pick.
const picker = (...picks) => {
  const tasks = [];
  return { tasks, run: async (o) => (tasks.push(o), { ok: true, output: `AGENT_RESULT: ${JSON.stringify({ seats: picks[Math.min(tasks.length - 1, picks.length - 1)] })}` }) };
};
const seat = (entry, lens) => ({ entry, lens, reason: `${entry} for ${lens}` });
const selection = (t, count) => {
  const root = tmp(t, 'cc-select-');
  for (const k of ['FACTORY_METRICS_SHARD', 'FACTORY_METRICS_SPOOL']) process.env[k] = '0';
  // No exploration seat: the picks below are about the clean-code seat alone.
  return { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', lessonsDir: '.factory/lessons', orchestrator: { model: 'opus' }, council: { explorationSeat: { enabled: false } }, ...settings(count) };
};

test('a pick without the clean-code seat goes back once with the reason; a retry without it keeps its counted seats and the harness seats it', async (t) => {
  const config = selection(t, 2);
  const counted = [seat('opus', 'correctness'), seat('sol', 'security')];
  const o = picker(counted, counted);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.equal(o.tasks.length, 2);
  assert.match(o.tasks[1].task, /## Your last pick was rejected\n\n- the clean-code seat is missing: seat one more member with lens "clean-code"/);
  // The retry's counted seats stand; the harness puts the clean-code seat on a family no counted seat has (Google).
  assert.deepEqual(r.members.map((m) => [m.entry, m.lens]), [['opus', 'correctness'], ['sol', 'security'], ['gem', 'clean-code']]);
  const [ev] = readJsonl(path.join(config.root, '.factory/metrics/council-selections.jsonl'));
  assert.deepEqual([ev.chooser, ev.cleanCodeChooser, ev.cleanCodeSeat, ev.rejected.length], ['orchestrator', 'harness', 'clean-code', 2]);
});

test('the clean-code seat on a family a counted seat has, while another family has none, is rejected; on an unseated family it sits', async (t) => {
  const config = selection(t, 2);
  const o = picker([seat('opus', 'correctness'), seat('sol', 'security'), seat('sonnet', 'clean-code')], [seat('opus', 'correctness'), seat('sol', 'security'), seat('gem', 'clean-code')]);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.match(o.tasks[1].task, /the clean-code seat sits on Anthropic, which a counted seat already has, while Google has no seat/);
  assert.deepEqual([r.members.at(-1).entry, r.members.at(-1).lens], ['gem', 'clean-code']);
  const [ev] = readJsonl(path.join(config.root, '.factory/metrics/council-selections.jsonl'));
  assert.equal(ev.cleanCodeChooser, 'orchestrator');
  // Kept for the ticket like the other seats.
  assert.deepEqual(councilFor(config, 'architectureReview', { subject: 'K-1' }).members.map((m) => m.entry), ['opus', 'sol', 'gem']);
});

test('the evidence rule: a clean-code finding without a rule id, or a duplication without both copies, is a question and does not block', () => {
  const c = councilFor(settings(1), 'architectureReview');
  const [verifier, cc] = c.members;
  const merge = (f) => mergeCouncil(c, [ok(verifier, 10), ok(cc, 6, [finding(cc, f)])]);
  const noRule = merge({ text: 'a second timeout default' });
  assert.deepEqual([noRule.pass, noRule.findings.length, noRule.questions.length], [true, 0, 1]);
  assert.match(noRule.notes[0].notUpheld, /cites no clean-code rule id/);
  const oneCopy = merge({ rule: 'CC-2', copies: ['src/a.js:3'], text: 'copied total' });
  assert.deepEqual([oneCopy.pass, oneCopy.questions.length], [true, 1]);
  assert.match(oneCopy.notes[0].notUpheld, /does not name both copies/);
  // With its rule and both copies it stands, and blocks.
  const proven = merge({ rule: 'CC-2', copies: ['src/a.js:3', 'src/b.js:9'], text: 'copied total' });
  assert.deepEqual([proven.pass, proven.findings.map((f) => f.rule)], [false, ['CC-2']]);
  // A rule that is not about duplication needs no copies.
  assert.equal(merge({ rule: 'CC-7', text: 'a flag switches the export format' }).findings.length, 1);
});

test('the clean-code member cannot mark a breach minor, its findings stand outside blockQuorum, and its low score holds the stage', () => {
  const c = { ...councilFor(settings(3), 'architectureReview'), blockQuorum: 'all' };
  const cc = c.members.find((m) => m.fixed);
  const others = c.members.filter((m) => !m.fixed).map((m) => ok(m, 10));
  // Raised as minor through the council's own normalisation (runCouncil -> normalizeFinding): it comes out blocking.
  const raised = { severity: 'minor', rule: 'CC-1', copies: ['src/a.js:3', 'src/settings.js:5'], issue: 'the fallback 900 repeats the default', file: 'src/a.js', line: 3, evidence: 'src/settings.js:5', resolves: 'code' };
  return runCouncil({ council: c, taskFor: () => 't', parse: (o) => JSON.parse(o.slice(o.indexOf('{'))), log: () => {}, run: async (m) => ({ status: 0, output: `AGENT_RESULT: ${JSON.stringify(m.fixed ? { verdict: 'CHANGES_REQUESTED', score: 6, findings: [raised] } : { verdict: 'APPROVED', score: 10, findings: [] })}` }) }).then(({ results }) => {
    const ccResult = results.find((r) => r.member.fixed);
    assert.equal(ccResult.findings[0].severity, 'blocking');
    const merged = mergeCouncil(c, results);
    // blockQuorum all with four blocking members: one raiser is enough for the clean-code seat.
    assert.deepEqual([merged.pass, merged.findings.length, merged.findings[0].upheldBy], [false, 1, ['clean-code']]);
    // A low score with a standing blocking finding of its own: the stage does not pass.
    const scoredOnly = mergeCouncil(c, [...others, ok(cc, 8, [finding(cc, { rule: 'CC-7' })])]);
    assert.equal(scoredOnly.pass, false);
  });
});

test('on the test plan the clean-code member reviews for repeated and redundant cases; such a finding is handled like any plan finding', () => {
  const c = councilFor(settings(1), 'testPlan');
  const [verifier, cc] = c.members;
  const task = memberTask('PLAN TASK', { council: c, member: cc, round: 1, skill: '' });
  assert.match(task, /two cases that would catch the same bug \(a redundant case\), breaks `CC-14`/);
  // The contract (both cases in `copies`) is the arbiter's, in the same task (council r3, cc-1).
  assert.match(task, /on a test plan, two cases that catch the\s+same bug, `CC-14`\) both places in `copies`/);
  assert.match(task, /## Clean code \(the full rules\)|### Clean code \(the full rules\)/);
  const redundant = finding(cc, { rule: 'CC-14', copies: ['.factory/plans/S-1/TC-S-1-02.md:1', '.factory/plans/S-1/TC-S-1-03.md:1'], file: '.factory/plans/S-1/TC-S-1-03.md', line: 1, evidence: '.factory/plans/S-1/TC-S-1-03.md:1', text: 'TC-S-1-03 checks what TC-S-1-02 checks', resolves: 'plan' });
  const merged = mergeCouncil(c, [ok(verifier, 10), ok(cc, 7, [redundant])]);
  assert.deepEqual([merged.pass, merged.findings.map((f) => f.resolves)], [false, ['plan']]);
  // The sole verifier is told the clean-code member reviews beside it.
  assert.match(memberTask('PLAN TASK', { council: c, member: verifier, round: 1, skill: '' }), /only counted member[\s\S]*The clean-code member, clean-code, reviews it apart from you for clean code only/);
});

test('the clean-code member\'s task: full rules, the guidance check, its own searches; its searches are counted into the round record', async (t) => {
  const root = tmp(t, 'cc-trace-');
  const c = councilFor(settings(1), 'architectureReview');
  const cc = c.members.find((m) => m.fixed);
  const task = memberTask('REVIEW TASK', { council: c, member: cc, round: 1, skill: '' });
  assert.match(task, /You are \*\*clean-code\*\*, the council's clean-code member/);
  assert.match(task, /redefines what the guidance said to reuse is a blocking finding citing the guidance, rule `CC-1` and both\s+places/);
  assert.match(task, /lsp_find_references/);
  assert.match(task, /#### CC-14 No useless tests/, 'the full rules');
  // Its searches, as the hook and the lsp server log them with its seat; another member's are not its own.
  const log = (member, tool) => fs.appendFileSync(path.join(root, '.git/lsp/calls.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), agent: 'architecture-reviewer', member, tool })}\n`);
  fs.mkdirSync(path.join(root, '.git/lsp'), { recursive: true });
  const out = await runCouncil({ council: c, cwd: root, taskFor: () => 't', parse: (o) => JSON.parse(o.slice(o.indexOf('{'))), log: () => {}, run: async (m) => {
    if (m.fixed) {
      log('clean-code', 'lsp_workspace_symbols');
      log('clean-code', 'lsp_find_references');
    } else log('verifier', 'lsp_find_references');
    return { status: 0, output: 'AGENT_RESULT: {"verdict": "APPROVED", "score": 10, "findings": []}' };
  } });
  const merged = mergeCouncil(c, out.results);
  assert.deepEqual(merged.members.map((m) => [m.name, m.searches ?? null, Boolean(m.fixed)]), [['verifier', null, false], ['clean-code', 2, true]]);
});

test('the scorecard has the clean-code seat\'s own rows by stage', () => {
  const rounds = ['architectureReview', 'testPlan'].flatMap((stage) => [1, 2].map((n) => ({ story: `S-${n}`, stage, round: 1, members: [{ name: 'verifier', model: 'claude-sonnet-5-5', lens: 'all' }, { name: 'clean-code', model: 'gpt-6.1-sol', lens: 'clean-code' }] })));
  const findings = [{ kind: 'finding', story: 'S-1', stage: 'architectureReview', round: 1, finding: 'F1', seat: 'clean-code', model: 'gpt-6.1-sol', lens: 'clean-code' }, { kind: 'outcome', story: 'S-1', stage: 'architectureReview', round: 1, finding: 'F1', outcome: 'led-to-change' }];
  const card = computeScorecard({ council: { scorecard: { minSeats: 1 } } }, { rounds, findings });
  const rows = card.rows.filter((r) => r.lens === 'clean-code').map((r) => [r.stage, r.model, r.seats, r.upheld]);
  assert.deepEqual(rows, [['architectureReview', 'gpt-6.1-sol', 2, 1], ['testPlan', 'gpt-6.1-sol', 2, 0]]);
});

test('PR check: the clean-code critic always sits in the panel; its findings are blocking for the defender and the judge, and one without its proof is kept aside', () => {
  const ctx = { video: { videos: [], unreadable: [] }, isFrontend: false };
  assert.deepEqual(activeLenses(ctx), ['acceptance', 'flow', 'style', 'clean-code']);
  assert.deepEqual(activeLenses({ ...ctx, only: ['acceptance'] }), ['acceptance', 'clean-code'], '--lenses never drops it');
  const review = cleanCodeReview({ score: 6, findings: [{ id: 'CLN-1', severity: 'minor', rule: 'CC-2', copies: ['src/a.js:3', 'src/b.js:8'], title: 'copied total' }, { id: 'CLN-2', severity: 'major', title: 'a helper that already exists' }] });
  assert.deepEqual(review.findings.map((f) => [f.id, f.severity]), [['CLN-1', 'blocking']]);
  assert.deepEqual(review.questions.map((q) => q.id), ['CLN-2']);
});

// Council r1 (sol-01): the evidence rule is applied item by item before clustering, and blockQuorum counts the
// configured seats only.
test('sol-01: a clean-code item without its rule id never drags down another member\'s finding, and the seat never raises the quorum', () => {
  const c = { ...councilFor(settings(1), 'architectureReview'), blockQuorum: 'any' };
  const [verifier, cc] = c.members;
  const same = { file: 'src/a.js', line: 3, fix: 'read the default from the settings', evidence: 'src/a.js:3', text: 'the timeout default 900 is written again' };
  const merged = mergeCouncil(c, [ok(verifier, 6, [finding(verifier, { ...same, lens: 'correctness' })]), ok(cc, 6, [finding(cc, { ...same })])]);
  assert.deepEqual([merged.pass, merged.findings.map((f) => f.members)], [false, [['verifier']]], 'the correctness finding stands on its own');
  assert.deepEqual(merged.questions.map((q) => q.members), [['clean-code']], 'the unsupported clean-code item is its own question');
  // Two counted seats under quorum "all": both raise it, the clean-code seat is silent. Before, the seat counted toward
  // "all" (3 needed), so the finding fell and the council passed.
  const three = { ...councilFor(settings(2), 'architectureReview'), blockQuorum: 'all' };
  const [a, b, seat] = three.members;
  const all = mergeCouncil(three, [ok(a, 6, [finding(a, { ...same, lens: 'correctness' })]), ok(b, 6, [finding(b, { ...same, lens: 'security' })]), ok(seat, 10)]);
  assert.deepEqual([all.pass, all.findings.length, all.findings[0].upheldBy.sort()], [false, 1, [a.name, b.name].sort()]);
});

// Council r1 (sol-02): an upheld clean-code breach is blocking on every path a finding takes to a verdict.
test('sol-02: an upheld clean-code finding is blocking through the merge, the judge, a seeded or CI-filtered result and the debate', async () => {
  const { decidePass, normalizeFinding: loopFinding, scoreRound } = await import('../../pr-check/lib/loop.mjs');
  // The merge: a seat item filed as minor (a seeded result, past runCouncil's normalisation) stands as blocking.
  const c = councilFor(settings(1), 'architectureReview');
  const [verifier, cc] = c.members;
  // Scored 10, so the only finding that can stand is the seat's own (not the harness's low-score one).
  const merged = mergeCouncil(c, [ok(verifier, 10), ok(cc, 10, [{ ...finding(cc, { rule: 'CC-5', text: 'grade does three jobs' }), severity: 'minor', lens: 'correctness' }])]);
  assert.deepEqual([merged.pass, merged.findings.map((f) => [f.rule, f.lens, f.severity, f.upheldBy, Boolean(f.harness)])], [false, [['CC-5', 'clean-code', 'blocking', ['clean-code'], false]]]);
  // The judge: a CC-5 finding upheld as minor (the member's reproducer: score 9, pass score 9).
  const config = { prCheck: { councilPassScore: 9 } };
  const f = loopFinding({ severity: 'blocking', rule: 'CC-5', title: 'grade does three jobs', cleanCode: true }, 'clean-code', 'CLN-1-1');
  const scored = scoreRound({ lenses: ['clean-code'], findings: [f], rulings: [{ id: 'CLN-1-1', ruling: 'upheld', severity: 'minor', reason: 'small' }], judgeLensScores: { 'clean-code': 9 }, judgeScore: 9 });
  assert.deepEqual([scored.upheld[0].severity, decidePass(config, null, scored).pass], ['blocking', false]);
  // Council r2 (TV-5): held before the lens caps, so the recorded and shown score carries the blocking cap (6), not the
  // judge's 9.
  assert.deepEqual([scored.lensScores['clean-code'], scored.score], [6, 6]);
  // A seeded result, or one the CI wait filtered, that carries it as minor.
  assert.equal(decidePass(config, null, { judged: true, lensScores: { 'clean-code': 9 }, judgeOverall: 9, upheld: [{ ...f, severity: 'minor' }], questions: [] }).pass, false);
  // The debate: a critic's amendment of the finding keeps its mark, so the hold applies to the amended one.
  const amended = loopFinding({ ...f, title: 'grade mixes parsing and scoring', severity: 'minor' }, f.lens, f.id);
  assert.deepEqual([amended.cleanCode, amended.rule, scoreRound({ lenses: ['clean-code'], findings: [amended], rulings: [{ id: 'CLN-1-1', ruling: 'upheld', severity: 'minor' }], judgeLensScores: { 'clean-code': 9 }, judgeScore: 9 }).upheld[0].severity], [true, 'CC-5', 'blocking']);
  // Not upheld (outvoted, protected) is not held: those are dispositions, not breaches.
  assert.equal(decidePass(config, null, { judged: true, lensScores: { 'clean-code': 10 }, upheld: [{ ...f, severity: 'minor', notUpheld: 'settled' }], questions: [] }).pass, true);
});

// Council r1 (sol-03): each clean-code raiser's rule and copies survive the merge, the PR check's normalisation and the
// records.
test('sol-03: a shared finding led by another lens keeps the clean-code raiser\'s rule and copies, in the finding and its record', async (t) => {
  const { normalizeFinding: loopFinding } = await import('../../pr-check/lib/loop.mjs');
  const { recordRoundFindings, recordPrCheckRound } = await import('../lib/findings.mjs');
  const c = councilFor(settings(1), 'architectureReview');
  const [verifier, cc] = c.members;
  const same = { file: 'src/a.js', line: 3, fix: 'read the default', evidence: 'src/a.js:3', text: 'the default 900 is written again' };
  const merged = mergeCouncil(c, [ok(verifier, 6, [finding(verifier, { ...same, lens: 'correctness' })]), ok(cc, 6, [finding(cc, { ...same, rule: 'CC-1', copies: ['src/a.js:3', 'src/settings.js:5'] })])]);
  const [m] = merged.findings;
  assert.deepEqual([m.members, m.lens, m.rule, m.copies, m.cleanCode], [['verifier', 'clean-code'], 'correctness', 'CC-1', ['src/a.js:3', 'src/settings.js:5'], true]);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-records-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { root, metricsDir: '.factory/metrics', stateDir: '.factory/state', ...settings(1) };
  recordRoundFindings(config, { stage: 'architectureReview', story: 'S-1', round: 1, council: c, merged });
  const rows = readJsonl(path.join(root, '.factory/metrics/council-findings.jsonl')).filter((r) => r.kind === 'finding');
  assert.deepEqual(rows.map((r) => [r.seat, r.rule ?? null]), [['verifier', null], ['clean-code', 'CC-1']]);
  // The PR check keeps them through its own normalisation and records them by raiser.
  const pr = loopFinding({ ...m, title: m.text }, 'clean-code', 'CLN-1-1');
  assert.deepEqual([pr.rule, pr.copies, pr.cleanCode, pr.memberEvidence.length], ['CC-1', ['src/a.js:3', 'src/settings.js:5'], true, 2]);
  recordPrCheckRound(config, { story: 'S-1', round: 1, findings: [pr], upheld: [pr], seatOf: (r) => ({ seat: r }), judge: null, rulings: [] });
  const prRows = readJsonl(path.join(root, '.factory/metrics/council-findings.jsonl')).filter((r) => r.kind === 'finding' && r.stage === 'prCheck');
  assert.deepEqual(prRows.map((r) => [r.seat, r.rule ?? null]), [['verifier', null], ['clean-code', 'CC-1']]);
});

// Council r1 (opus F1): blockQuorum counts the configured seats only, whatever the quorum. The member's probe: a
// one-seat review whose verifier scores 4 with a blocking finding while the clean-code seat is silent fails under any,
// majority and all; with three counted seats, majority needs two, not three.
test('F1: the silent clean-code seat never raises the number of blocking members a finding needs', () => {
  const same = { file: 'src/a.js', line: 3, fix: 'reject notes over 200 characters', evidence: 'src/a.js:3', text: 'a 300-character note is accepted' };
  for (const blockQuorum of ['any', 'majority', 'all']) {
    const c = { ...councilFor(settings(1), 'architectureReview'), blockQuorum };
    const [verifier, cc] = c.members;
    const merged = mergeCouncil(c, [ok(verifier, 4, [finding(verifier, { ...same, lens: 'correctness' })]), ok(cc, 10)]);
    assert.deepEqual([merged.pass, merged.findings.filter((f) => !f.harness).map((f) => f.upheldBy)], [false, [['verifier']]], blockQuorum);
  }
  const c = { ...councilFor(settings(3), 'architectureReview'), blockQuorum: 'majority' };
  const [a, b, x, seat] = c.members;
  const merged = mergeCouncil(c, [ok(a, 6, [finding(a, { ...same, lens: 'correctness' })]), ok(b, 6, [finding(b, { ...same, lens: 'acceptance' })]), ok(x, 10), ok(seat, 10)]);
  assert.deepEqual([merged.pass, merged.findings.filter((f) => !f.harness).map((f) => f.upheldBy.length)], [false, [2]]);
});

// Council r2 (sol-01): a duplication is proven by two different places, not two spellings of one; and on the test plan
// a redundant case (CC-14) names both cases. The member's reproducers, each a question that does not block.
test('sol-01 r2: one place spelt twice, or a redundant test case naming one case, is a question; two real places stand', () => {
  const c = councilFor(settings(1), 'architectureReview');
  const [, cc] = c.members;
  const root = '/repo';
  const dup = (copies, extra = {}) => finding(cc, { rule: 'CC-1', copies, text: 'the default is written twice', ...extra });
  const merge = (council, f, opts = {}) => mergeCouncil(council, [ok(council.members[0], 10), ok(council.members[1], 10, [f])], { root, ...opts });
  const aliased = merge(c, dup(['scripts/pipeline/lib/council.mjs:1', './scripts/pipeline/lib/council.mjs:1']));
  assert.deepEqual([aliased.pass, aliased.findings.length, aliased.questions.length], [true, 0, 1]);
  assert.equal(merge(c, dup(['/repo/src/a.js:3', 'src/a.js:3'])).questions.length, 1, 'an absolute path under the root is the same place');
  assert.deepEqual([merge(c, dup(['src/a.js:3', 'src/b.js:3'])).pass, merge(c, dup(['src/a.js:3', 'src/b.js:3'])).findings.length], [false, 1], 'two places: it stands');
  // The test plan: CC-14 is a redundant case and must name both cases.
  const plan = councilFor(settings(1), 'testPlan');
  const redundant = (copies) => finding(plan.members[1], { rule: 'CC-14', copies, text: 'The test plan repeats an existing case', file: '.factory/plans/T-1/TC-1.md', line: 1, evidence: '.factory/plans/T-1/TC-1.md:1' });
  assert.deepEqual([merge(plan, redundant(['.factory/plans/T-1/TC-1.md:1'])).pass, merge(plan, redundant(['.factory/plans/T-1/TC-1.md:1'])).questions.length], [true, 1]);
  assert.equal(merge(plan, redundant(['.factory/plans/T-1/TC-1.md:1', '.factory/plans/T-1/TC-3.md:1'])).findings.length, 1);
  // Elsewhere CC-14 is a useless test: one place is enough.
  assert.equal(merge(c, finding(cc, { rule: 'CC-14', text: 'asserts a constant', file: 'tests/a.test.js', line: 4, evidence: 'tests/a.test.js:4' })).findings.length, 1);
  // The PR check's critic is held to the same rule.
  assert.equal(cleanCodeReview({ findings: [{ rule: 'CC-2', copies: ['src/a.js:1', './src/a.js:1'], title: 'x', evidence: 'src/a.js:1' }] }).questions.length, 1);
});

// Council r2 (sol-03): a PR critic may cite its rule only in the detail. The rule that passed the evidence rule stays on
// the finding through the panel's normalisation and into its record, so the breach counts against that rule.
test('sol-03 r2: a rule cited only in a PR critic\'s detail is kept on the finding and its record', async (t) => {
  const { normalizeFinding: loopFinding } = await import('../../pr-check/lib/loop.mjs');
  const { ruleIdOf } = await import('../lib/clean-code.mjs');
  const raw = { title: 'Long function', detail: 'CC-5 at src/app.js:5', evidence: 'src/app.js:5', severity: 'minor' };
  const review = cleanCodeReview({ findings: [raw] });
  assert.equal(review.questions.length, 0);
  const f = loopFinding({ ...review.findings[0], cleanCode: true }, 'clean-code', 'CLN-1-1');
  assert.deepEqual([f.severity, f.rule, ruleIdOf(f)], ['blocking', 'CC-5', 'CC-5']);
  // Its record: the PR check round's finding row names the rule.
  const root = tmp(t, 'sol03r2-');
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', models: { pool: POOL, agents: { default: 'sonnet' } } };
  const { recordPrCheckRound } = await import('../lib/findings.mjs');
  recordPrCheckRound(config, { story: 'S-1', round: 1, check: 'c1', findings: [f], upheld: [f], seatOf: () => ({ seat: 'clean-code', entry: 'sonnet', lens: 'clean-code' }), judge: null, rulings: [] });
  const rows = fs.readFileSync(path.join(root, '.factory/metrics/council-findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'finding');
  assert.deepEqual(rows.map((r) => [r.lens, r.rule]), [['clean-code', 'CC-5']]);
  // The ledger's extraction reads the detail too, for a finding that came another way.
  assert.equal(ruleIdOf({ title: 'Long function', detail: 'breaks CC-5' }), 'CC-5');
});

// Council r2 (cc-1): the clean-code finding contract has one home (agents/shared/clean-code-arbiter.md); the seat's task
// states it once.
// Council r3 (cc-1): on every stage, the test plan too (its own line names CC-14, the arbiter keeps the contract).
test('cc-1 r2: the seat\'s task states the copies format and the dismissed shape once, on every stage', () => {
  for (const stage of Object.keys(COUNCIL_STAGES)) {
    const c = councilFor(settings(1), stage);
    const task = memberTask('REVIEW TASK', { council: c, member: c.members.find((m) => m.fixed), round: 1, skill: '' });
    const times = (s) => task.split(s).length - 1;
    assert.equal(times('["<file>:<line>", "<file>:<line>"]'), 1, stage);
    assert.equal(times('"evidence": "<the tool item>"'), 1, stage);
    assert.equal(times('`copies`'), 1, `${stage}: the copies contract once`);
  }
});

// Council r2 follow-up: a seat resolved from its pool entry (entrySeat, for the counted seats and the clean-code seat
// alike) keeps the entry's model, which the round record names (the scorecard keys rows by model).
test('a council seated from the pool records each seat\'s model, the clean-code seat\'s too', (t) => {
  const root = tmp(t, 'cc-model-');
  const c = councilFor(settings(2), 'architectureReview');
  const config = { root, metricsDir: '.factory/metrics', stateDir: '.factory/state', ...settings(2) };
  const merged = mergeCouncil(c, c.members.map((m) => ok(m, 10)));
  recordCouncilRound(config, { stage: 'architectureReview', story: 'S-1', round: 1, council: c, merged });
  const [rec] = readJsonl(path.join(root, '.factory/metrics', COUNCIL_FILE));
  const modelOf = Object.fromEntries(POOL.map((e) => [e.name, e.model]));
  assert.deepEqual(rec.members.map((m) => [m.name, m.model]), c.members.map((m) => [m.name, modelOf[m.entry]]));
  assert.ok(rec.members.some((m) => m.name === 'clean-code' && m.model), JSON.stringify(rec.members));
  assert.ok(rec.members.every((m) => m.model), 'every seat has its model');
});

// Council r3 (test-value, savedSeats): seats kept before the clean-code seat existed (no `fixed` member in the seats
// file) are still a council with the always-on seat, on every stage and on resume; its round record names the seat, so
// the writer-rule ledger can count the round.
test('a kept seats file without the clean-code seat still seats it, and the round records it', (t) => {
  const root = tmp(t, 'cc-kept-');
  const config = { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', ...settings(2) };
  for (const stage of Object.keys(COUNCIL_STAGES)) {
    const file = seatsFile(config, stage, 'S-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ members: [{ name: 'opus', entry: 'opus', lens: 'correctness', blocking: true }, { name: 'sol', entry: 'sol', lens: 'security', blocking: true }] }));
    assert.ok(!savedSeats(config, stage, 'S-1').some(isCleanCodeSeat), `${stage}: the kept seats have none`);
    const c = councilFor(config, stage, { subject: 'S-1' });
    assert.deepEqual(c.members.map((m) => [m.name, Boolean(m.fixed)]), [['opus', false], ['sol', false], ['clean-code', true]], stage);
  }
  const c = councilFor(config, 'pairVerify', { subject: 'S-1' });
  recordCouncilRound(config, { stage: 'pairVerify', story: 'S-1', step: 'api', round: 1, council: c, merged: mergeCouncil(c, c.members.map((m) => ok(m, 10))) });
  const [rec] = readJsonl(path.join(root, '.factory/metrics', COUNCIL_FILE));
  assert.ok(rec.members.some((m) => m.fixed && m.status === 'ok') && Array.isArray(rec.writerRules), JSON.stringify(rec.members));
});

// Council r3 (test-value follow-up): the PR check's shadow critic judges every lens on its first pass with the guidance
// the last fix's writer had, as the critics do; with none, no guidance block.
test('the PR shadow\'s first pass carries the last fix\'s guidance', async () => {
  const { shadowTask } = await import('../../pr-check/lib/loop.mjs');
  const guidance = [{ what: 'the configured tax rate', where: 'src/Basket/TaxOptions.cs:7', do: 'reuse' }];
  // Council r4 (test-value follow-up): the current hand-off's guidance, not the first decision's.
  const ctx = { guidance, orchestrator: { decision: 'delegate', guidance: [{ what: 'the coupon expiry check', where: 'src/Basket/Coupons.cs:1', do: 'change' }] } };
  const task = shadowTask('HEAD', ctx);
  assert.match(task, /## Every lens\. First pass[\s\S]*worked to this guidance[\s\S]*reuse: the configured tax rate \(`src\/Basket\/TaxOptions\.cs:7`\)/);
  assert.doesNotMatch(task, /the coupon expiry check/);
  assert.doesNotMatch(shadowTask('HEAD', { guidance: [] }), /worked to this guidance/);
});
