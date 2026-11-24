// GEN-12: every council finding recorded with who raised it, its outcome, the misses after a council passed, and the
// cost of each member (council-findings.jsonl, token-usage.jsonl).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAgent } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';
import { COUNCIL_FILE, memberRunEnv, memoryFile, mergeCouncil, normalizeFinding, recordCouncilRound } from '../lib/council.mjs';
import { FINDINGS_FILE, ciLens, recordBugTicketMisses, recordCiMisses, recordMisses, recordPrCheckRound, recordRoundFindings } from '../lib/findings.mjs';
import { readJsonl } from '../lib/util.mjs';
import { ciGate } from '../../implement/lib/ci-wait.mjs';

const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
];
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'findings-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const saved = { shard: process.env.FACTORY_METRICS_SHARD, spool: process.env.FACTORY_METRICS_SPOOL };
  Object.assign(process.env, { FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0' });
  t.after(() => { for (const [k, v] of Object.entries({ FACTORY_METRICS_SHARD: saved.shard, FACTORY_METRICS_SPOOL: saved.spool })) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', models: { pool: POOL, agents: { default: 'sonnet', 'pr-check-judge': 'opus' } } };
}
const rows = (config, kind) => readJsonl(path.join(config.root, '.factory/metrics', FINDINGS_FILE)).filter((r) => !kind || r.kind === kind);
const seat = (name, entry, lens) => ({ name, entry, lens, blocking: true, cli: POOL.find((e) => e.name === entry).cli });
const COUNCIL = { stage: 'architectureReview', maxCouncilRounds: 5, councilPassScore: 9, blockQuorum: 'any', onUnavailable: 'fail', members: [seat('opus', 'opus', 'correctness'), seat('sol', 'sol', 'security')] };
const ok = (m, score, findings = []) => ({ member: m, status: 'ok', score, verdict: findings.length ? 'CHANGES_REQUESTED' : 'APPROVED', summary: '', findings: findings.map((f) => normalizeFinding(f, m)) });
const bug = { file: 'src/orders.js', line: 10, issue: 'any user reads any order', severity: 'blocking', action: 'fix', evidence: 'src/orders.js:10 returns every order' };

test('a round\'s findings: one record per member that raised each, with seat, entry, model, family, lens, severity, action, file and line; a shared one is marked on both', (t) => {
  const config = setup(t);
  const [opus, sol] = COUNCIL.members;
  const merged = mergeCouncil(COUNCIL, [ok(opus, 5, [bug]), ok(sol, 6, [{ ...bug, line: 11, issue: 'orders of other users are returned', evidence: 'curl as bob lists alice\'s orders' }])]);
  recordRoundFindings(config, { stage: 'architectureReview', story: 'SHOP-1', round: 1, council: COUNCIL, merged });
  const found = rows(config, 'finding');
  assert.deepEqual(found.map((r) => [r.story, r.stage, r.round, r.seat, r.entry, r.model, r.family, r.lens, r.severity, r.action, r.file, r.line, r.shared]), [
    ['SHOP-1', 'architectureReview', 1, 'opus', 'opus', 'claude-opus-5-5', 'Anthropic', 'correctness', 'blocking', 'fix', 'src/orders.js', 10, true],
    ['SHOP-1', 'architectureReview', 1, 'sol', 'sol', 'gpt-6.1-sol', 'OpenAI', 'security', 'blocking', 'fix', 'src/orders.js', 11, true],
  ]);
  assert.equal(found[0].finding, found[1].finding, 'the same finding, raised by both');
  assert.ok(!JSON.stringify(found).includes('returns every order'), 'no evidence text is recorded');
});

test('outcomes in the pair stages: a finding whose fix declaration names changed lines led to a change; one disputed and dropped did not', (t) => {
  const config = setup(t);
  const ledger = memoryFile(config.root, config.stateDir, { stage: 'pairVerify', story: 'SHOP-1', step: 'api' });
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ rounds: [{ round: 1, upheld: [{ id: 'api-r1-1' }, { id: 'api-r1-2' }], provenance: [{ id: 'api-r1-1', file: 'src/a.cs', lines: [3, 4] }] }], history: [] }));
  const council = { ...COUNCIL, stage: 'pairVerify' };
  recordRoundFindings(config, { stage: 'pairVerify', story: 'SHOP-1', step: 'api', round: 2, council, merged: { pass: true, members: [], findings: [], notes: [], disputes: [{ finding: 'api-r1-2', decision: 'accepted' }] } });
  assert.deepEqual(rows(config, 'outcome').map((r) => [r.step, r.round, r.finding, r.outcome, r.reason]), [
    ['api', 1, 'api-r1-1', 'led-to-change', 'the fix declaration names lines changed for it'],
    ['api', 1, 'api-r1-2', 'no-change', 'disputed and dropped'],
  ]);
});

test('the PR check: every finding\'s ruling, upheld or dismissed, with the judge\'s entry, model and family', (t) => {
  const config = setup(t);
  const findings = [{ id: 'ACC-1-1', lens: 'acceptance', severity: 'blocking', file: 'src/a.cs', line: 2 }, { id: 'FLO-1-1', lens: 'flow', severity: 'major', file: 'src/b.cs', line: 9 }];
  const judge = { entry: 'opus', model: 'claude-opus-5-5', family: 'Anthropic' };
  recordPrCheckRound(config, { story: 'SHOP-1', round: 1, findings, upheld: [findings[0]], seatOf: (lens) => ({ seat: lens, entry: 'sonnet', model: 'claude-sonnet-5-5', family: 'Anthropic', lens: lens === 'flow' ? 'correctness' : 'acceptance' }), judge, rulings: [{ id: 'ACC-1-1', ruling: 'upheld' }, { id: 'FLO-1-1', ruling: 'dismissed' }] });
  assert.deepEqual(rows(config, 'outcome').map((r) => [r.finding, r.outcome, r.ruling, r.by, r.judge.entry, r.judge.model, r.judge.family]), [['ACC-1-1', 'upheld', 'upheld', 'judge', 'opus', 'claude-opus-5-5', 'Anthropic'], ['FLO-1-1', 'dismissed', 'dismissed', 'judge', 'opus', 'claude-opus-5-5', 'Anthropic']]);
  assert.deepEqual(rows(config, 'finding').map((r) => [r.finding, r.seat, r.lens]), [['ACC-1-1', 'acceptance', 'acceptance'], ['FLO-1-1', 'flow', 'correctness']]);
});

// Council r1 (sol-13): a finding the judge never ruled on, or one the harness upheld against its dismissal, is never
// credited to the judge.
test('the PR check: a finding that stood without a ruling, or that the harness upheld against the judge, is the harness\'s outcome, with no judge', (t) => {
  const config = setup(t);
  const findings = [{ id: 'ACC-1-1', lens: 'acceptance', severity: 'major' }, { id: 'ACC-1-2', lens: 'acceptance', severity: 'major' }];
  const judge = { entry: 'opus', model: 'claude-opus-5-5', family: 'Anthropic' };
  recordPrCheckRound(config, { story: 'SHOP-1', round: 1, findings, upheld: findings, seatOf: (lens) => ({ seat: lens, lens }), judge, rulings: [{ id: 'ACC-1-2', ruling: 'dismissed', question: true }] });
  assert.deepEqual(rows(config, 'outcome').map((r) => [r.finding, r.outcome, r.ruling, r.by, 'judge' in r]), [['ACC-1-1', 'upheld', null, 'harness', false], ['ACC-1-2', 'upheld', 'dismissed', 'harness', true]]);
});

// A council round that passed, as council-rounds.jsonl has it.
const passed = (config, stage, members) => {
  fs.mkdirSync(path.join(config.root, '.factory/metrics'), { recursive: true });
  fs.appendFileSync(path.join(config.root, '.factory/metrics', COUNCIL_FILE), `${JSON.stringify({ ts: 't', stage, story: 'SHOP-1', round: 2, pass: true, members })}\n`);
};

test('misses: a PR check upheld correctness finding counts against the passed review council\'s correctness member, or its sole member', (t) => {
  const config = setup(t);
  passed(config, 'architectureReview', [{ name: 'opus', entry: 'opus', family: 'Anthropic', lens: 'correctness' }, { name: 'sol', entry: 'sol', family: 'OpenAI', lens: 'security' }]);
  passed(config, 'testPlan', [{ name: 'verifier', entry: 'sonnet', lens: 'all' }]);
  recordMisses(config, { story: 'SHOP-1', lens: 'correctness', source: 'prCheck', finding: 'FLO-1-1' });
  assert.deepEqual(rows(config, 'miss').map((r) => [r.stage, r.seat, r.entry, r.missedLens, r.source, r.finding, r.lowWeight ?? false]), [
    ['architectureReview', 'opus', 'opus', 'correctness', 'prCheck', 'FLO-1-1', false],
    ['testPlan', 'verifier', 'sonnet', 'correctness', 'prCheck', 'FLO-1-1', false],
  ]);
});

test('misses: a red CI test counts against test-value members, a build failure against correctness members', (t) => {
  const config = setup(t);
  passed(config, 'testAutomation', [{ name: 'opus', entry: 'opus', lens: 'test-value' }, { name: 'sol', entry: 'sol', lens: 'correctness' }]);
  assert.deepEqual(['e2e (chromium)', 'unit tests', 'build', 'lint'].map(ciLens), ['test-value', 'test-value', 'correctness', 'correctness']);
  recordCiMisses(config, { keys: ['SHOP-1'], failing: ['e2e (chromium)'] });
  assert.deepEqual(rows(config, 'miss').map((r) => [r.stage, r.seat, r.missedLens, r.source]), [['testAutomation', 'opus', 'test-value', 'ci']]);
});

// Council r1 (sol-15): the wait before a fixing round and the gate of that round see the same red check on one head.
test('misses: the same red check seen twice on one head is one miss; on a new head it is another', (t) => {
  const config = setup(t);
  passed(config, 'testAutomation', [{ name: 'opus', entry: 'opus', lens: 'test-value' }]);
  recordCiMisses(config, { keys: ['SHOP-1'], failing: ['unit tests'], head: 'aaa111' });
  recordCiMisses(config, { keys: ['SHOP-1'], failing: ['unit tests'], head: 'aaa111' });
  assert.equal(rows(config, 'miss').length, 1);
  recordCiMisses(config, { keys: ['SHOP-1'], failing: ['unit tests'], head: 'bbb222' });
  assert.deepEqual(rows(config, 'miss').map((r) => r.head), ['aaa111', 'bbb222']);
});

test('misses: a later bug ticket that names a delivered ticket counts, with lower weight, against every member that sat on it, once', (t) => {
  const config = setup(t);
  passed(config, 'architectureReview', [{ name: 'opus', entry: 'opus', lens: 'correctness' }, { name: 'sol', entry: 'sol', lens: 'security' }]);
  const stories = [{ key: 'SHOP-1', text: '# SHOP-1 orders' }, { key: 'BUG-7', text: '# BUG-7: SHOP-1 lists other users\' orders' }];
  assert.equal(recordBugTicketMisses(config, stories), 2);
  assert.equal(recordBugTicketMisses(config, stories), 0, 'once per bug ticket');
  assert.deepEqual(rows(config, 'miss').map((r) => [r.seat, r.source, r.finding, r.lowWeight, r.missedLens]), [['opus', 'bug-ticket', 'BUG-7', true, null], ['sol', 'bug-ticket', 'BUG-7', true, null]]);
});

test('a council member\'s run: its usage row carries the seat, the pool entry and the lens', (t) => {
  const config = setup(t);
  fs.mkdirSync(path.join(config.root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(config.root, '.factory/config.json'), JSON.stringify({ models: config.models }));
  const probe = path.join(config.root, 'probe.mjs');
  fs.writeFileSync(probe, "console.log('AGENT_RESULT: {}');\n");
  const saved = process.env.PIPELINE_AGENT_CMD;
  process.env.PIPELINE_AGENT_CMD = `"${process.execPath}" "${probe}"`;
  t.after(() => (saved === undefined ? delete process.env.PIPELINE_AGENT_CMD : (process.env.PIPELINE_AGENT_CMD = saved)));
  const c = { ...loadConfig(null, config.root), root: config.root };
  const member = { name: 'sol', entry: 'sol', lens: 'security' };
  runAgent(c, { name: 'architecture-reviewer', task: 't', entry: member.entry, cwd: config.root, extraEnv: memberRunEnv(member), usage: { stage: 'review', story: 'SHOP-1' } });
  const [u] = readJsonl(path.join(config.root, '.factory/metrics/token-usage.jsonl'));
  assert.deepEqual([u.seat, u.entry, u.family, u.lens, u.agent], ['sol', 'sol', 'OpenAI', 'security', 'architecture-reviewer']);
});

// Council r1 (T1): a red CI check reaches the records through the CI gate itself, against the head it was seen on.
test('the CI gate records a red check as a miss of the ticket\'s passed councils, on the head it saw', async (t) => {
  const config = setup(t);
  passed(config, 'testAutomation', [{ name: 'opus', entry: 'opus', lens: 'test-value' }]);
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: config.root });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: config.root, encoding: 'utf8' }).stdout.trim();
  const red = async () => ({ state: 'failure', failing: ['unit tests'], pending: [] });
  const gate = () => ciGate({ config, gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'p', branch: 'b', cwd: config.root, prCheckCli: 'x', targetArgs: ['--story', 'SHOP-1'], base: 'main', seedFile: path.join(config.root, 's.json'), fixRounds: 0, wait: red, flakyOf: () => [], log: () => {} });
  await gate();
  await gate();
  assert.deepEqual(rows(config, 'miss').map((r) => [r.story, r.seat, r.missedLens, r.source, r.finding, r.head]), [['SHOP-1', 'opus', 'test-value', 'ci', 'unit tests', head]], 'seen twice on one head: one miss');
});

// Council r2 (sol-19): a later bug or a person's change request counts against the PR check's council too; the PR
// check's own findings count only against the stages before it.
test('misses: a later bug counts against the passed PR check council as well; a PR check finding does not count against it', (t) => {
  const config = setup(t);
  passed(config, 'architectureReview', [{ name: 'opus', entry: 'opus', lens: 'correctness' }, { name: 'sol', entry: 'sol', lens: 'security' }]);
  passed(config, 'prCheck', [{ name: 'acceptance', entry: 'sonnet', lens: 'acceptance' }, { name: 'flow', entry: 'sonnet', lens: 'correctness' }]);
  recordMisses(config, { story: 'SHOP-1', source: 'human-review', finding: 'review 9', lowWeight: true });
  recordMisses(config, { story: 'SHOP-1', lens: 'acceptance', source: 'prCheck', finding: 'ACC-1-1' });
  assert.deepEqual(rows(config, 'miss').map((r) => [r.stage, r.seat, r.source]), [['architectureReview', 'opus', 'human-review'], ['architectureReview', 'sol', 'human-review'], ['prCheck', 'acceptance', 'human-review'], ['prCheck', 'flow', 'human-review']]);
});

// Council r4 (sol-29): an escaped defect is recorded once per PR check run, however many rounds uphold it; another check
// of the ticket records it again. A multi-ticket check's finding is the escaped defect of the ticket it names.
test('misses: a PR check finding upheld in two rounds of one check is one miss; the tickets it names are the ones charged', async (t) => {
  const config = setup(t);
  passed(config, 'architectureReview', [{ name: 'opus', entry: 'opus', family: 'Anthropic', lens: 'correctness' }]);
  for (const round of [1, 2]) recordMisses(config, { story: 'SHOP-1', lens: 'correctness', source: 'prCheck', finding: 'FLO-1-1', check: 'c1' });
  recordMisses(config, { story: 'SHOP-1', lens: 'correctness', source: 'prCheck', finding: 'FLO-1-1', check: 'c2' });
  assert.deepEqual(rows(config, 'miss').map((r) => [r.finding, r.check]), [['FLO-1-1', 'c1'], ['FLO-1-1', 'c2']]);
  const { findingTickets } = await import('../../pr-check/lib/loop.mjs');
  const ctx = { story: { key: 'BUG-1' }, tickets: [{ key: 'BUG-1' }, { key: 'BUG-12' }] };
  assert.deepEqual(findingTickets(ctx, { requirement: 'BUG-12: AC 2 answers 400' }), ['BUG-12']);
  assert.deepEqual(findingTickets(ctx, { requirement: 'journey', title: 'the epic flow breaks' }), ['BUG-1', 'BUG-12'], 'no ticket named: every ticket of the check');
});

// Council r4 (sol-26): a shadow's finding stays in the records, marked feedback, with no outcome.
test('a round\'s records keep the non-blocking member\'s findings, marked feedback, with no outcome', (t) => {
  const config = setup(t);
  const [opus] = COUNCIL.members;
  const shadow = { ...seat('sol', 'sol', 'all'), blocking: false, shadow: true };
  const council = { ...COUNCIL, members: [opus, shadow] };
  const merged = mergeCouncil(council, [ok(opus, 10), ok(shadow, 2, [bug])]);
  recordRoundFindings(config, { stage: 'architectureReview', story: 'SHOP-1', round: 1, council, merged });
  assert.deepEqual(rows(config, 'finding').map((r) => [r.seat, r.entry, r.feedback ?? false]), [['sol', 'sol', true]]);
  assert.deepEqual(rows(config, 'outcome'), []);
});

// Council r5 (sol-32): a PR check shared by two tickets (--stories A,B) records its council under both: a later miss that
// names B counts against that council, once per seat.
test('a shared PR check\'s council counts for every ticket it covered: a later miss naming the second ticket finds it', (t) => {
  const config = setup(t);
  const [opus, sol] = COUNCIL.members;
  const council = { ...COUNCIL, stage: 'prCheck' };
  recordCouncilRound(config, { stage: 'prCheck', story: 'SHOP-1', stories: ['SHOP-1', 'SHOP-2'], check: 'c1', round: 1, council, merged: mergeCouncil(council, [ok(opus, 10), ok(sol, 10)]) });
  recordMisses(config, { story: 'SHOP-2', source: 'bug-ticket', lowWeight: true });
  assert.deepEqual(rows(config, 'miss').map((r) => [r.story, r.stage, r.seat]), [['SHOP-2', 'prCheck', 'opus'], ['SHOP-2', 'prCheck', 'sol']]);
});
