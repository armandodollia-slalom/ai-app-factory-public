// Static analysis in the pair rounds: the harness fix loop runs before the verifier or the council, its bounces do not
// spend a pair round, and what stays open after its budget reaches the members as `source: tool` harness findings
// (blocking only for rules on the tool's block list), outside the council's votes and its disputes. Agents are faked
// in-process; the tool is a fake SARIF tool (a Node script) run for real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { readReport } from '../../pipeline/lib/analysis/report.mjs';
import { createContext, orchestrate } from '../lib/orchestrate.mjs';
import { councilSettings } from '../../pipeline/test/fixtures/pool.mjs';
import { cleanCodeSeatAnswer } from '../../pipeline/test/fixtures/clean-code-seat.mjs';

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

// A fake analysis tool: every line containing BAD is a finding of rule BAD-RULE, every line with MEH one of MEH-RULE.
// FIXME lines are auto-fixed (the tool's `fix` deletes them). It prints SARIF.
const TOOL = `import fs from 'node:fs';
const fix = process.argv[2] === '--fix';
const files = process.argv.slice(fix ? 3 : 2);
const results = [];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\\n');
  if (fix) { fs.writeFileSync(f, lines.filter((l) => !l.includes('FIXME')).join('\\n')); continue; }
  lines.forEach((l, i) => {
    for (const rule of ['BAD', 'MEH']) if (l.includes(rule)) results.push({ ruleId: rule + '-RULE', level: 'warning', message: { text: rule + ' found' }, locations: [{ physicalLocation: { artifactLocation: { uri: f }, region: { startLine: i + 1 } } }] });
  });
}
if (!fix) console.log(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'fake' } }, results }] }));
`;

function makeRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-pair-')));
  const repo = path.join(tmp, 'demo-1');
  write(repo, 'src/Shared/Common.cs', '// shared\n');
  const storyRel = seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-thing', text: '# DEMO-1: [BE - Catalog.API] - Thing\n\n## Acceptance Criteria\n\n- it works\n' });
  write(repo, '.gitignore', '.factory/state/\nartifacts/\n');
  sh(repo, 'init', '-q', '-b', 'feat/demo-1-thing');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');
  const tool = path.join(tmp, 'fake-tool.mjs');
  fs.writeFileSync(tool, TOOL);
  return { repo, tmp, tool, storyFile: path.join(repo, storyRel) };
}

function makeConfig(env, { council = undefined, bounces = 2, block = ['BAD-RULE'], analysis = true } = {}) {
  const base = loadConfig('implement', env.repo);
  return {
    ...base,
    agent: { ...base.agent, cmd: null },
    // A council's members are the pool; the pair verifier council seats them all (councilSettings).
    ...(council ? councilSettings(council) : {}),
    implement: { ...base.implement, checks: [], unitTests: null, prepareCmd: null, lsp: { enabled: false }, ...(council ? councilSettings(council).implement : {}) },
    ...(council ? { council: { ...base.council, ...councilSettings(council).council } } : {}),
    ...(analysis ? { analysis: { tools: { fake: { licence: 'MIT', run: [process.execPath, env.tool, '{files}'], fix: [process.execPath, env.tool, '--fix', '{files}'], parse: 'sarif', scope: 'changed-lines', block: { rules: block }, lens: 'security', extensions: ['.cs'] } }, stages: { pair: ['fake'] }, maxFixRounds: bounces } } : {}),
  };
}

const fakeLsp = { start: async () => ({ ok: true }), stop: async () => {}, stopAll: async () => {}, diagnostics: async () => ({ available: false, errors: [], warnings: [] }), calls: () => [], isReferences: () => false, leasedRunning: () => false };

function fakeAgents(script) {
  const calls = [];
  const runAgent = async (config, opts) => {
    const seat = cleanCodeSeatAnswer(opts, script);
    if (seat) return seat;
    const member = opts.extraEnv?.PIPELINE_COUNCIL_MEMBER;
    const key = member ? `${opts.name}@${member}` : opts.name;
    calls.push({ ...opts, key, member });
    const steps = script[key] ?? [];
    const n = calls.filter((c) => c.key === key).length - 1;
    const step = steps[Math.min(n, steps.length - 1)];
    const output = step ? await step(opts) : 'nothing';
    return { ok: true, status: 0, timedOut: false, output, version: 'v1', seconds: 0 };
  };
  return { runAgent, calls };
}

const context = (env, config, agents) => createContext({ config, key: 'DEMO-1', storyFile: env.storyFile, branch: 'feat/demo-1-thing', worktree: env.repo, base: 'main', deps: { runAgent: agents.runAgent, lsp: fakeLsp, acquire: async () => () => {} }, log: () => {} });
const writeIn = (rel, text, extra) => async (o) => (write(o.cwd, rel, text), done(extra));
const API = 'src/Catalog.API/Api.cs';

test('a tool finding goes back to the implementer in a fix bounce that does not spend a pair round; the verifier sees clean code', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn(API, 'ok\nBAD\n// FIXME\n'), writeIn(API, 'ok\nfine\n')],
    'pair-verifier': [async (o) => (assert.match(o.task, /### Static analysis \(harness/), assert.match(o.task, /Fixed before this review: 1/), verdict(10))],
  });
  const ctx = context(env, makeConfig(env), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(ctx.metrics.pairRounds, 1, 'the fix bounce is not a pair round');
  const impl = agents.calls.filter((c) => c.name === 'pair-implementer');
  assert.equal(impl.length, 2);
  assert.match(impl[1].task, /fix bounce 1 of 2; this is not a review round/);
  assert.match(impl[1].task, /fake BAD-RULE at src\/Catalog\.API\/Api\.cs:2/);
  assert.equal(agents.calls.filter((c) => c.name === 'pair-verifier').length, 1);
  // The auto-fix was committed by the harness, before the tool ran.
  const log = sh(env.repo, 'log', '--all', '--format=%s');
  assert.match(log, /analysis auto-fix \(fake\)/);
  const runs = readJsonl(path.join(env.repo, '.factory/metrics/analysis-runs.jsonl'));
  assert.deepEqual(runs.map((x) => [x.stage, x.step, x.round, x.bounces, x.fixed, x.open]), [['pair', 'api', 1, 1, 1, 0]]);
  const findings = readJsonl(path.join(env.repo, '.factory/metrics/analysis-findings.jsonl'));
  assert.deepEqual(findings.map((x) => [x.source, x.rule, x.outcome]), [['tool:fake', 'BAD-RULE', 'fixed-before-review']]);
});

test('after the fix budget a blocking tool finding reaches the round as a source: tool harness finding with a stable id; a non-blocking one is a note', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn(API, 'BAD\nMEH\n'), writeIn(API, 'BAD\nMEH\n'), writeIn(API, 'good\nMEH\n')],
    'pair-verifier': [async () => verdict(10), async () => verdict(10)],
  });
  const ctx = context(env, makeConfig(env, { bounces: 1 }), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(ctx.metrics.pairRounds, 2, 'the verifier approved, but the blocking tool finding sent the round back');
  const impl = agents.calls.filter((c) => c.name === 'pair-implementer');
  // Round 1, its bounce, round 2, and round 2's bounce for MEH (every provable finding is bounced; only BAD blocks).
  assert.equal(impl.length, 4);
  assert.match(impl[2].task, /tool:fp-[0-9a-f]{16}:BAD-RULE/);
  assert.match(impl[3].task, /\[fix\] fake MEH-RULE/);
  const sr = JSON.parse(fs.readFileSync(path.join(env.repo, '.factory/metrics/subtask-runs.jsonl'), 'utf8').trim().split('\n').pop());
  const round1 = sr.rounds[0];
  assert.equal(round1.verdict, 'CHANGES_REQUESTED');
  // Round 2 is clean of BAD; MEH (not on the block list) never blocked and is a minor note.
  const head = sh(env.repo, 'rev-parse', 'HEAD');
  assert.ok(head);
  const runs = readJsonl(path.join(env.repo, '.factory/metrics/analysis-runs.jsonl'));
  assert.deepEqual(runs.map((x) => [x.round, x.bounces, x.open, x.blocking]), [[1, 1, 2, 1], [2, 1, 1, 0]]);
});

test('with a council: a blocking tool finding stands although every member approves, and the implementer cannot dispute it', async () => {
  const env = makeRepo();
  const council = { members: [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', lens: 'security' }], stages: { pairVerify: {} }, blockQuorum: 'all' };
  let toolId = null;
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [
      writeIn(API, 'BAD\n'),
      async (o) => {
        toolId = /tool:fp-[0-9a-f]{16}:BAD-RULE/.exec(o.task)?.[0];
        write(o.cwd, API, 'BAD\n');
        return done({ disputes: [{ finding: toolId, kind: 'nit', reason: 'the tool is wrong' }] });
      },
      writeIn(API, 'good\n'),
    ],
    'pair-verifier@opus': [async (o) => (assert.doesNotMatch(o.task, /the tool is wrong/), verdict(10))],
    'pair-verifier@sol': [async () => verdict(10)],
  });
  const ctx = context(env, makeConfig(env, { council, bounces: 0 }), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(toolId);
  assert.equal(ctx.metrics.pairRounds, 3, 'blockOn "all" does not apply to harness findings; the dispute is dropped');
  const rounds = readJsonl(path.join(env.repo, '.factory/metrics/council-rounds.jsonl'));
  assert.ok(rounds.every((x) => x.pass), 'the members passed every round; the tool finding blocked outside their votes');
});

test('the per-commit report is reused: a resumed loop on the same head and tool settings does not run the tool again', async () => {
  const env = makeRepo();
  const config = makeConfig(env);
  write(env.repo, API, 'MEH\n');
  sh(env.repo, 'add', '-A');
  sh(env.repo, 'commit', '-qm', 'x');
  const { fixLoop } = await import('../../pipeline/lib/analysis/fixloop.mjs');
  const deps = { commit: () => false, head: () => sh(env.repo, 'rev-parse', 'HEAD'), askImplementer: async () => assert.fail('nothing blocks... but MEH is a finding') };
  let calls = 0;
  const exec = async (...a) => (calls++, (await import('../../pipeline/lib/util.mjs')).runAsync(...a));
  const first = await fixLoop(config, 'pair', { cwd: env.repo, base: 'HEAD~1', bounces: 0, deps: { ...deps, exec } });
  assert.equal(first.findings.length, 1);
  const n = calls;
  const again = await fixLoop(config, 'pair', { cwd: env.repo, base: 'HEAD~1', bounces: 0, deps: { ...deps, exec } });
  assert.equal(calls - n, 1, 'only the auto-fix ran; the tool result came from the report');
  assert.deepEqual(again.findings.map((f) => f.id), first.findings.map((f) => f.id));
  assert.ok(readReport(config, deps.head(), 'pair'));
});

test('without an analysis section nothing runs: no report, no metrics, the pair behaves as before', async () => {
  const env = makeRepo();
  const agents = fakeAgents({
    implementer: [async () => plan([sub('api', ['src/Catalog.API/**'])])],
    'pair-implementer': [writeIn(API, 'BAD\n')],
    'pair-verifier': [async (o) => (assert.doesNotMatch(o.task, /Static analysis/), verdict(10))],
  });
  const ctx = context(env, makeConfig(env, { analysis: false }), agents);
  const r = await orchestrate(ctx);
  assert.ok(r.ok);
  assert.equal(ctx.metrics.pairRounds, 1);
  assert.equal(fs.existsSync(path.join(env.repo, '.factory/metrics/analysis-runs.jsonl')), false);
  assert.equal(fs.existsSync(path.join(env.repo, '.factory/state/analysis')), false);
});
