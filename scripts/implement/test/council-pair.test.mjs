// A council seated for the pair verifier (council.stages.pairVerify): members on three CLIs in parallel, the merged
// findings to the implementer, the council's round limit, disputes ruled by the members that raised them, and an
// unavailable member. Agents are faked in-process (orchestrate.test.mjs's pattern) against a real throwaway repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { createContext, orchestrate } from '../lib/orchestrate.mjs';
import { isResolvesQuestion, RESOLVES_ANSWER } from '../../pipeline/test/fixtures/resolves-question.mjs';
import { councilSettings } from '../../pipeline/test/fixtures/pool.mjs';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const result = (o) => `Working...\nAGENT_RESULT: ${JSON.stringify(o)}\n`;
const done = (extra = {}) => result({ status: 'done', reason: 'ok', ...extra });
const sub = (id, owns) => ({ id, goal: `build ${id}`, acceptance: [`${id} works`], owns, dependsOn: [], model: 'opus', verify: 'code', modelReason: 'normal', verifyReason: 'code', expectedFiles: 1, expectedLoc: 5, confidence: 0.9, alternatives: [] });
const plan = (subtasks) => result({ mode: 'delegate', modeReason: 'several services', splitReason: 'per service', subtasks });
const verdict = (score, findings = []) => result({ verdict: findings.some((f) => f.severity !== 'minor') ? 'CHANGES_REQUESTED' : 'APPROVED', summary: 's', score, findings });

const MEMBERS = [
  { name: 'opus', cli: 'claude', model: 'opus', effort: 'high', lens: 'correctness' },
  { name: 'sol', cli: 'codex', model: 'sol', effort: 'high', lens: 'security' },
  { name: 'tests', cli: 'copilot', model: 'sonnet', lens: 'test-value' },
];

function makeRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-pair-')));
  const repo = path.join(tmp, 'demo-1');
  write(repo, 'src/Shared/Common.cs', '// shared\n');
  const storyRel = seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-thing', text: '# DEMO-1: [BE - Catalog.API] - Thing\n\n## Acceptance Criteria\n\n- it works\n' });
  write(repo, '.gitignore', '.factory/state/\nartifacts/\n');
  sh(repo, 'init', '-q', '-b', 'feat/demo-1-thing');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');
  return { repo, storyFile: path.join(repo, storyRel) };
}

// The council's members are the pool; the pair verifier council seats as many as it lists (councilSettings).
function makeConfig(repo, council, over = {}) {
  const base = loadConfig('implement', repo);
  const settings = council ? councilSettings(council) : {};
  return {
    ...base,
    ...settings,
    agent: { ...base.agent, cmd: null },
    // These councils were written for a pass score of 9 (the default is 9.5).
    implement: { ...base.implement, checks: [], unitTests: null, prepareCmd: null, councilPassScore: 9, ...settings.implement, ...over },
    council: { ...base.council, ...settings.council },
  };
}

const fakeLsp = { start: async () => ({ ok: true }), stop: async () => {}, stopAll: async () => {}, diagnostics: async () => ({ available: false, errors: [], warnings: [] }), calls: () => [], isReferences: () => false, leasedRunning: () => false };

// Scripted agents per name; a council member's script is keyed `<agent>@<member>`.
function fakeAgents(script) {
  const calls = [];
  const runAgent = async (config, opts) => {
    if (isResolvesQuestion(opts.task)) return { ok: true, status: 0, timedOut: false, output: RESOLVES_ANSWER, version: 'v1', seconds: 0 };
    const member = opts.extraEnv?.PIPELINE_COUNCIL_MEMBER;
    const key = member ? `${opts.name}@${member}` : opts.name;
    calls.push({ ...opts, key, member });
    const steps = script[key] ?? [];
    const n = calls.filter((c) => c.key === key).length - 1;
    const step = steps[Math.min(n, steps.length - 1)];
    const output = step ? await step(opts) : 'nothing';
    if (output && typeof output === 'object') return { ok: false, status: 1, timedOut: false, version: 'v1', seconds: 0, ...output };
    return { ok: true, status: 0, timedOut: false, output, version: 'v1', seconds: 0 };
  };
  return { runAgent, calls };
}

const context = (env, config, agents) => createContext({ config, key: 'DEMO-1', storyFile: env.storyFile, branch: 'feat/demo-1-thing', worktree: env.repo, base: 'main', deps: { runAgent: agents.runAgent, lsp: fakeLsp, acquire: async () => () => {} }, log: () => {} });
const writeIn = (rel, text, extra) => async (o) => (write(o.cwd, rel, text), done(extra));
const bug = { severity: 'blocking', category: 'correctness', file: 'src/Catalog.API/Api.cs', line: 3, issue: 'the owner check is missing', fix: 'add it' };


// A member's answer to an adjudication task (council.mjs adjudicationTask): every item answered `answer`.
const answerAll = (task, answer) => `AGENT_RESULT: ${JSON.stringify({ answers: [...String(task).matchAll(/^## Item \d+: `([^`]+)`/gm)].map((m) => ({ key: m[1], answer, evidence: 'src/Catalog.API/Api.cs:4: the agreed fix answers 400 for a non-numeric id here' })) })}`;
const adjudicationYes = async (o) => answerAll(o.task, 'yes');

test('a three-member council on claude, codex and copilot verifies a pair: parallel members, one merged finding, then approval', async () => {
  const env = makeRepo();
  const council = { members: MEMBERS, stages: { pairVerify: {} } };
  // The seats the stage's orchestrator kept for the ticket (the fill would hold an exploration seat).
  const seats = path.join(env.repo, '.factory/state/council/seats/pairVerify--DEMO-1.json');
  fs.mkdirSync(path.dirname(seats), { recursive: true });
  fs.writeFileSync(seats, JSON.stringify({ members: [{ name: 'opus', entry: 'opus', lens: 'correctness' }, { name: 'sol', entry: 'sol', lens: 'acceptance' }, { name: 'tests', entry: 'tests', lens: 'security' }] }));
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1'), writeIn('src/Catalog.API/Api.cs', 'v2')],
    'pair-verifier@opus': [async () => verdict(6, [bug]), async () => verdict(9)],
    'pair-verifier@sol': [async () => verdict(5, [{ ...bug, line: 4, issue: 'any caller reads any catalog item', evidence: 'no owner filter' }]), async () => verdict(10)],
    'pair-verifier@tests': [async () => verdict(9), async () => verdict(9)],
  });
  const ctx = context(env, makeConfig(env.repo, council), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  const members = agents.calls.filter((c) => c.member);
  assert.equal(members.length, 6, 'three members, two rounds');
  const first = Object.fromEntries(members.slice(0, 3).map((c) => [c.member, c]));
  // Each member runs on its seat's pool entry (its CLI, model id and effort come from the entry).
  assert.deepEqual([first.opus.entry, first.opus.mode], ['opus', 'read']);
  const entry = (n) => ctx.config.models.pool.find((e) => e.name === first[n].entry);
  assert.deepEqual(['opus', 'sol', 'tests'].map((n) => [entry(n).cli, entry(n).model, entry(n).effort]), [['claude', 'claude-opus-5-5', 'high'], ['codex', 'gpt-6.1-sol', 'high'], ['copilot', 'claude-sonnet-5.5', 'high']]);
  assert.match(first.sol.task, /You are \*\*sol\*\*; your lens is \*\*acceptance\*\*[\s\S]*### The council skill/);
  // The implementer gets the defect once, with both members.
  const second = agents.calls.filter((c) => c.name === 'pair-implementer')[1];
  assert.equal((second.task.match(/the owner check is missing/g) ?? []).length, 1);
  assert.match(second.task, /\[raised by opus, sol\]/);
  // 6 member runs, plus the follow-up question for `resolves` to the two members whose round-1 finding lacked it.
  assert.equal(ctx.metrics.byRole.verifier, 8, 'every member is an agent run of the story (maxAgentRunsPerStory), the resolves question too');
  const rounds = readJsonl(path.join(env.repo, '.factory/metrics/council-rounds.jsonl'));
  assert.deepEqual(rounds.map((x) => [x.stage, x.step, x.round, x.pass, x.members.map((m) => m.score).join(',')]), [['pairVerify', 'api', 1, false, '6,5,9'], ['pairVerify', 'api', 2, true, '9,10,9']]);
});

test('implement.maxCouncilRounds limits the pair for any council size, and at the limit the pair escalates exactly as before', async () => {
  const env = makeRepo();
  const council = { members: MEMBERS.slice(0, 2), stages: { pairVerify: {} } };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])]), async (o) => (assert.match(o.task, /Escalation for story DEMO-1/), result({ action: 'fail', reason: 'needs a person' }))],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1'), writeIn('src/Catalog.API/Api.cs', 'v2'), writeIn('src/Catalog.API/Api.cs', 'v3')],
    'pair-verifier@opus': [async () => verdict(4, [bug])],
    'pair-verifier@sol': [async () => verdict(9)],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo, council, { maxCouncilRounds: 2 }), agents));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'pair-exhausted');
  assert.equal(agents.calls.filter((c) => c.name === 'pair-implementer').length, 2, 'two council rounds');
  assert.match(agents.calls.filter((c) => c.name === 'pair-implementer')[1].task, /Round 2 of at most 2/);
});

test('with several members, a dispute goes only to the members that raised the finding, and their ruling decides', async () => {
  const env = makeRepo();
  const council = { members: MEMBERS.slice(0, 2), stages: { pairVerify: {} } };
  const nit = { severity: 'blocking', category: 'style', file: 'src/Catalog.API/Api.cs', line: 1, issue: 'rename x to total', fix: 'rename' };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1'), writeIn('src/Catalog.API/Api.cs', 'v2', { disputes: [{ finding: 'api-r1-1', kind: 'nit', reason: 'no AC names it' }] })],
    'pair-verifier@opus': [async () => verdict(7, [nit]), async () => result({ verdict: 'APPROVED', summary: 'ok', score: 9, findings: [], disputes: [{ finding: 'api-r1-1', decision: 'accepted' }] })],
    'pair-verifier@sol': [async () => verdict(9), async () => verdict(9)],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo, council), agents));
  assert.ok(r.ok, JSON.stringify(r));
  const round2 = agents.calls.filter((c) => c.member).slice(2);
  const opus = round2.find((c) => c.member === 'opus');
  const sol = round2.find((c) => c.member === 'sol');
  assert.match(opus.task, /### Disputes from the implementer[\s\S]*- api-r1-1 \(nit\)/);
  assert.doesNotMatch(sol.task, /Disputes from the implementer/);
  const run = readJsonl(path.join(env.repo, '.factory/metrics/subtask-runs.jsonl'))[0];
  assert.deepEqual(run.rounds.map((x) => [x.verdict, x.disputes.accepted]), [['CHANGES_REQUESTED', 0], ['APPROVED', 1]]);
});

test('an unavailable member stops the story under onUnavailable fail; under report the council goes on without it', async () => {
  for (const onUnavailable of ['fail', 'report']) {
    const env = makeRepo();
    const council = { onUnavailable, members: MEMBERS.slice(0, 2), stages: { pairVerify: {} } };
    const agents = fakeAgents({
      implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
      'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1')],
      'pair-verifier@opus': [async () => verdict(10)],
      'pair-verifier@sol': [async () => ({ outage: 'usage limit reached', output: '' })],
    });
    const r = await orchestrate(context(env, makeConfig(env.repo, council), agents));
    if (onUnavailable === 'fail') {
      assert.equal(r.ok, false);
      assert.equal(r.outcome, 'agent-unavailable');
      assert.match(r.reason, /sol \(codex\): provider unavailable: usage limit reached/);
    } else {
      assert.ok(r.ok, JSON.stringify(r));
      const rec = readJsonl(path.join(env.repo, '.factory/metrics/council-rounds.jsonl'))[0];
      assert.deepEqual(rec.members.map((m) => [m.name, m.status]), [['opus', 'ok'], ['sol', 'unavailable']]);
    }
    assert.equal(agents.calls.filter((c) => c.member).length, 2, 'no other model was started in its place');
  }
});

// GEN-8: with no members configured, the pair seats its own verifier as a council of one.
test('without council members the pair seats its own verifier as a council of one, which reviews every lens', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1')],
    'pair-verifier': [async () => result({ verdict: 'APPROVED', summary: 'ok', findings: [], score: 9.5 })],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo, undefined, { councilPassScore: 9.5 }), agents));
  assert.ok(r.ok, JSON.stringify(r));
  const calls = agents.calls.filter((c) => c.name === 'pair-verifier');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].member, undefined, 'it runs on the verifier role\'s own CLI and model');
  // Council r1 (sol-14): its usage rows still name its seat and lens, so the scorecard counts its cost.
  assert.deepEqual([calls[0].usage?.member, calls[0].usage?.lens], ['verifier', 'all']);
  assert.match(calls[0].task, /You are the council's only member/);
  const rows = fs.readFileSync(path.join(env.repo, '.factory/metrics/council-rounds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.stage, x.members.length, x.members[0].lens, x.passScore, x.pass]), [['pairVerify', 1, 'all', 9.5, true]]);
});

test('a protected test the pair implementer deletes is restored and the round fails with a finding; the council instructions reach the implementer for any council size', async () => {
  const env = makeRepo();
  write(env.repo, 'src/Catalog.API/Tests/DEMO-7.Api.spec.ts', "test('TC-DEMO-7-01 another story', () => {});\n");
  sh(env.repo, 'add', '-A');
  sh(env.repo, 'commit', '-qm', 'another story\'s test');
  const council = { members: MEMBERS.slice(0, 1), stages: { pairVerify: {} } };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [async (o) => (write(o.cwd, 'src/Catalog.API/Api.cs', 'v1'), fs.rmSync(path.join(o.cwd, 'src/Catalog.API/Tests/DEMO-7.Api.spec.ts')), done()), writeIn('src/Catalog.API/Api.cs', 'v2')],
    // One seat: the stage's own verifier sits alone.
    'pair-verifier': [async () => verdict(10)],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo, council), agents));
  assert.ok(r.ok, JSON.stringify(r));
  const impl = agents.calls.filter((c) => c.name === 'pair-implementer');
  assert.match(impl[0].task, /### Council findings: deleting tests and rewrites/);
  assert.match(impl[1].task, /src\/Catalog\.API\/Tests\/DEMO-7\.Api\.spec\.ts \(TC-DEMO-7-01\), which is protected: it belongs to another story \(DEMO-7\)\. The harness restored the file/);
  assert.equal(agents.calls.filter((c) => c.name === 'pair-verifier').length, 1, 'the round with the deleted test never reached the council');
  assert.equal(fs.readFileSync(path.join(env.repo, 'src/Catalog.API/Tests/DEMO-7.Api.spec.ts'), 'utf8'), "test('TC-DEMO-7-01 another story', () => {});\n", 'merged back into the story branch intact');

  // A council of one (no members configured) can ask for a test to be deleted too: the implementer gets the same text.
  const env2 = makeRepo();
  const agents2 = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1')],
    'pair-verifier': [async () => result({ score: 10, verdict: 'APPROVED', summary: 'ok', findings: [] })],
  });
  await orchestrate(context(env2, makeConfig(env2.repo, undefined), agents2));
  assert.match(agents2.calls.find((c) => c.name === 'pair-implementer').task, /### Council findings: deleting tests and rewrites/);
});

// GEN-9: every implement agent runs on a pool entry (and so with that entry's env: pipeline/test/models.test.mjs).
test('each implement agent runs on its pool entry: the pair verifier on its own, the pair implementer on its subtask\'s', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([{ ...sub('api', ['src/Catalog.API/**']), model: 'tests' }])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1')],
    'pair-verifier': [async () => result({ verdict: 'APPROVED', summary: 'ok', score: 10, findings: [] })],
  });
  const config = makeConfig(env.repo, { members: MEMBERS });
  config.models = { ...config.models, agents: { ...config.models.agents, 'pair-verifier': 'sol' } };
  const r = await orchestrate(context(env, config, agents));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(['implementer', 'pair-implementer', 'pair-verifier'].map((n) => agents.calls.find((c) => c.name === n).entry), ['opus', 'tests', 'sol']);
  assert.equal(readJsonl(path.join(env.repo, '.factory/metrics/subtask-runs.jsonl'))[0].model, 'tests', 'the run record names the entry');
});

test('a pair that ends because a blocking member gave no verdict says so (C9 proof run TYPE-1)', async () => {
  const { noVerdictNote } = await import('../lib/orchestrate.mjs');
  const rec = { council: { members: [{ name: 'opus', cli: 'claude', blocking: true, status: 'ok', verdict: 'APPROVED', score: 10 }, { name: 'sol', cli: 'codex', blocking: true, status: 'failed', reason: 'no parsable result' }] } };
  assert.equal(noVerdictNote(rec), ': council member sol (codex) gave no verdict (failed: no parsable result), while opus APPROVED 10/10 in the last round');
  assert.equal(noVerdictNote({ council: { members: [{ name: 'opus', cli: 'claude', blocking: true, status: 'ok', verdict: 'CHANGES_REQUESTED', score: 6 }] } }), '');
  assert.equal(noVerdictNote({}), '');
});

// Dogfood C16 held-out: a later council round blocked, as behaviour no ticket line names, the validation an earlier
// round had upheld as the fix. The pair's council remembers its earlier rounds (council.mjs councilMemory).
test('a pair council does not block, in a later round, the change an earlier round upheld as the fix', async () => {
  const env = makeRepo();
  const council = { members: MEMBERS.slice(0, 2), stages: { pairVerify: {} } };
  const crash = { severity: 'blocking', category: 'correctness', file: 'src/Catalog.API/Api.cs', line: 2, issue: 'a non-numeric id throws FormatException: an unhandled 500', fix: 'answer 400 for an id that is not a number' };
  const scope = { severity: 'blocking', category: 'acceptance', lens: 'acceptance', file: 'src/Catalog.API/Api.cs', line: 4, issue: 'adds a 400 response no ticket line asks for', fix: 'remove the 400 branch' };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    // Round 2 fixes the crash and declares the lines it wrote for it (council.mjs fixDeclarationText).
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'get(id)\nint.Parse(id)\n'), async (o) => {
      write(o.cwd, 'src/Catalog.API/Api.cs', 'get(id)\nif (!int.TryParse(id, out var n))\n{\n    return Results.BadRequest();\n}\n');
      write(o.cwd, '.factory/state/council/fixes/pairVerify--DEMO-1--api.json', JSON.stringify({ fixes: [{ id: 'api-r1-1', hunks: [{ file: 'src/Catalog.API/Api.cs', start: 2, end: 5 }] }] }));
      return done();
    }],
    // Round 2's scope objection is on lines declared for api-r1-1: both members are asked, fresh, and accept it.
    'pair-verifier@opus': [async () => verdict(9), async () => verdict(8, [scope]), adjudicationYes],
    'pair-verifier@sol': [async () => verdict(6, [crash]), async () => verdict(9), adjudicationYes],
  });
  const ctx = context(env, makeConfig(env.repo, council), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  const second = agents.calls.filter((c) => c.member === 'opus')[1];
  assert.match(second.task, /### Findings the council upheld in earlier rounds[\s\S]*FormatException[\s\S]*Agreed fix: answer 400/);
  assert.match(agents.calls.filter((c) => c.name === 'pair-implementer')[1].task, /### Say which lines answer which finding[\s\S]*pairVerify--DEMO-1--api\.json[\s\S]*`api-r1-1`/);
  const rounds = readJsonl(path.join(env.repo, '.factory/metrics/council-rounds.jsonl'));
  assert.deepEqual(rounds.map((x) => [x.kind ?? 'round', x.round, x.pass ?? null, x.earlierRound ?? x.covered ?? 0]), [['round', 1, false, 0], ['adjudication', 2, null, 1], ['round', 2, true, 1]]);
  const adj = agents.calls.filter((c) => /^# Council adjudication/.test(c.task));
  assert.deepEqual(adj.map((c) => [c.member, c.mode]), [['opus', 'read'], ['sol', 'read']]);
});

test('a pair council: the same objection stands when one member does not accept it on adjudication', async () => {
  const env = makeRepo();
  const council = { members: MEMBERS.slice(0, 2), stages: { pairVerify: {} } };
  const crash = { severity: 'blocking', category: 'correctness', file: 'src/Catalog.API/Api.cs', line: 2, issue: 'a non-numeric id throws FormatException: an unhandled 500', fix: 'answer 400 for an id that is not a number' };
  const scope = { severity: 'blocking', category: 'acceptance', lens: 'acceptance', file: 'src/Catalog.API/Api.cs', line: 4, issue: 'adds a 400 response no ticket line asks for', fix: 'remove the 400 branch' };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'get(id)\nint.Parse(id)\n'), async (o) => {
      write(o.cwd, 'src/Catalog.API/Api.cs', 'get(id)\nif (!int.TryParse(id, out var n))\n{\n    return Results.BadRequest();\n}\n');
      write(o.cwd, '.factory/state/council/fixes/pairVerify--DEMO-1--api.json', JSON.stringify({ fixes: [{ id: 'api-r1-1', hunks: [{ file: 'src/Catalog.API/Api.cs', start: 2, end: 5 }] }] }));
      return done();
    }],
    'pair-verifier@opus': [async () => verdict(9), async () => verdict(8, [scope]), adjudicationYes],
    'pair-verifier@sol': [async () => verdict(6, [crash]), async () => verdict(9), async (o) => answerAll(o.task, 'no')],
  });
  const ctx = context(env, makeConfig(env.repo, council, { maxCouncilRounds: 2 }), agents);
  const r = await orchestrate(ctx);
  assert.equal(r.ok, false);
  const rounds = readJsonl(path.join(env.repo, '.factory/metrics/council-rounds.jsonl'));
  assert.deepEqual(rounds.filter((x) => x.kind === 'adjudication').map((x) => x.items.map((i) => [i.outcome, i.rejectedBy.join('+')])), [[['stands', 'sol']]]);
  assert.deepEqual(rounds.filter((x) => !x.kind).map((x) => [x.round, x.pass]), [[1, false], [2, false]]);
});

// Dogfood C17 (council C11, Sol 2): a UI pair's council passed round 2 with both members at 10, and a round 3 followed,
// because the harness's code-intelligence finding (round 2 changed a signature without find-references) was added after
// the pass. A passing council round is terminal: the signature check is answered before the council sits.
test('a passing council round ends the pair: nothing is scheduled after it, the signature check included', async () => {
  const env = makeRepo();
  const council = { blockQuorum: 'any', members: MEMBERS.slice(0, 2), stages: { pairVerify: {} } };
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [
      writeIn('src/Catalog.API/Api.cs', '// the api\n'),
      writeIn('src/Catalog.API/Api.cs', '// the api\npublic class Api {\n    public string GiftMessage(int id, string text) => text;\n}\n'),
      async () => done({ reason: 'GiftMessage is a new member with no callers' }),
    ],
    'pair-verifier@opus': [async () => verdict(6, [{ id: 'O1', severity: 'blocking', category: 'acceptance', file: 'src/Catalog.API/Api.cs', line: 2, issue: 'no gift message member', fix: 'add GiftMessage' }]), async () => verdict(10)],
    'pair-verifier@sol': [async () => verdict(10), async () => verdict(10)],
  });
  const lsp = { ...fakeLsp, leasedRunning: () => true, calls: () => [] };
  const ctx = createContext({ config: makeConfig(env.repo, council), key: 'DEMO-1', storyFile: env.storyFile, branch: 'feat/demo-1-thing', worktree: env.repo, base: 'main', deps: { runAgent: agents.runAgent, lsp, acquire: async () => () => {} }, log: () => {} });
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  const sittings = readJsonl(path.join(env.repo, '.factory/metrics/council-rounds.jsonl')).filter((x) => x.stage === 'pairVerify');
  assert.deepEqual(sittings.map((x) => [x.round, x.pass]), [[1, false], [2, true]], 'no round after the pass');
  assert.equal(agents.calls.filter((c) => c.name === 'pair-verifier').length, 4, 'two members, two rounds');
  const impl = agents.calls.filter((c) => c.name === 'pair-implementer');
  assert.equal(impl.length, 3);
  assert.match(impl[2].task, /without running lsp_find_references[\s\S]*GiftMessage/);
  const run = readJsonl(path.join(env.repo, '.factory/metrics/subtask-runs.jsonl'))[0];
  assert.deepEqual(run.rounds.map((x) => x.verdict), ['CHANGES_REQUESTED', 'APPROVED']);
  assert.equal(run.rounds[1].codeIntelligence.answer, 'GiftMessage is a new member with no callers');
});

// Council r1 (A1): the code verifier sat the harness's seating, not the seats kept for the ticket.
test('the pair code verifier seats the pick kept for the ticket, with its lenses', async () => {
  const env = makeRepo();
  const council = { members: MEMBERS, stages: { pairVerify: {} } };
  const seats = path.join(env.repo, '.factory/state/council/seats/pairVerify--DEMO-1.json');
  fs.mkdirSync(path.dirname(seats), { recursive: true });
  fs.writeFileSync(seats, JSON.stringify({ stage: 'pairVerify', subject: 'DEMO-1', chooser: 'orchestrator', members: [{ name: 'sol', entry: 'sol', lens: 'acceptance', blocking: true }, { name: 'tests', entry: 'tests', lens: 'correctness', blocking: true }] }));
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn('src/Catalog.API/Api.cs', 'v1')],
    'pair-verifier@sol': [async () => verdict(10)],
    'pair-verifier@tests': [async () => verdict(10)],
  });
  const r = await orchestrate(context(env, makeConfig(env.repo, council), agents));
  assert.ok(r.ok, JSON.stringify(r));
  const sat = agents.calls.filter((c) => c.name === 'pair-verifier').map((c) => [c.member, c.extraEnv?.PIPELINE_COUNCIL_LENS]);
  assert.deepEqual(sat, [['sol', 'acceptance'], ['tests', 'correctness']]);
});
