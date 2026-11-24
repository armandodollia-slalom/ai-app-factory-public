// The PR check with a council (council.stages.prCheck) end to end through `pr-check run`, with the fake agent: members
// as critics next to the acceptance critic, the debate and the judge, the council's pass, a non-blocking member that is
// not waited for and whose late review is feedback next round, the fixer's council instructions, and a protected test
// the fixer deleted put back.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { poolSettings } from '../../pipeline/test/fixtures/pool.mjs';

// The fixer leases a test-stack slot: a registry of its own, so the machine's real leases (another run, another suite
// file) never make it wait past this test's time limit (it did once in a full run: 240 s waiting for a slot).
// Local git calls can stall for minutes on a loaded machine (external.mjs); a full suite run once spent 240 s in round 2's
// tree snapshot. The time limits below are ceilings for a slow run, never the expected time (alone: about 10 s).
const leaseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-check-council-leases-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts', 'pipeline', 'test', 'fixtures', 'fake-agent.mjs');
let repo;
let scriptFile;

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const OTHER_TEST = 'tests/DEMO-9.Coupons.spec.ts';
const COUNCIL = {
  members: [
    { name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' },
    { name: 'sol', cli: 'codex', model: 'sol', lens: 'security' },
    { name: 'slow', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false },
  ],
  stages: { prCheck: {} },
};

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-check-council-'));
  scriptFile = path.join(repo, '..', `${path.basename(repo)}-agent.json`);
  for (const dir of ['scripts/pipeline', 'scripts/pr-check', 'scripts/board', 'scripts/implement', 'scripts/feature-verification', 'scripts/stack', 'scripts/teststack']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  // Every section's defaults and descriptions: a stage reads the others' (scripts/pipeline/lib/settings.mjs).
  for (const d of fs.readdirSync(path.join(source, 'scripts'))) for (const f of ['config.json', 'settings.json']) if (fs.existsSync(path.join(source, 'scripts', d, f)) && !fs.existsSync(path.join(repo, 'scripts', d, f))) {
    fs.mkdirSync(path.join(repo, 'scripts', d), { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts', d, f), path.join(repo, 'scripts', d, f));
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  fs.cpSync(path.join(source, 'skills', 'council'), path.join(repo, 'skills', 'council'), { recursive: true });
  write('.gitignore', '.factory/state/\n.factory/metrics/\n');
  // The members are the pool; the PR check council of DEMO-1 is the pick kept for the ticket (with its lenses and a
  // non-blocking member), as the stage's orchestrator would have made it.
  write('.factory/config.json', JSON.stringify({ ...poolSettings(COUNCIL.members), prCheck: { councilPassScore: 9, councilMembers: 3 } }));
  write('.factory/state/council/seats/prCheck--DEMO-1.json', JSON.stringify({ members: COUNCIL.members.map((m) => ({ name: m.name, entry: m.name, lens: m.lens, blocking: m.blocking !== false })) }));
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: '# DEMO-1 Apply coupon\n\nAC 1: a valid coupon gives 10% off. AC 2: an expired coupon is rejected with 400.\n' });
  write(OTHER_TEST, "test('TC-DEMO-9-01 coupons of another story', () => {});\n");
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'fv@example.com']);
  sh('git', ['config', 'user.name', 'T']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
  sh('git', ['switch', '-q', '-c', 'feature/DEMO-1']);
  write('src/Basket/Coupons.cs', '// coupons\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'DEMO-1: coupons']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const suffix of ['', '.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
});

const rowsMet = [{ ref: 'AC 1: a valid coupon gives 10% off', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }, { ref: 'AC 2: an expired coupon is rejected with 400', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }];
const clean = (score = 10) => ({ result: { score, summary: 'ok', coverage: [], findings: [] } });
const expired = { severity: 'blocking', title: 'Expired coupon is accepted', detail: 'AC 2 says 400', evidence: 'src/Basket/Coupons.cs:1', requirement: 'AC 2', fix: 'reject expired coupons', file: 'src/Basket/Coupons.cs', line: 1 };

test('a PR check council: members critique beside the acceptance critic, a non-blocking member is not waited for and its late review is feedback, the fixer\'s deleted protected test comes back, and the council passes', () => {
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [{ result: { score: 10, summary: 'all met', coverage: rowsMet, findings: [] } }],
    'pr-check-flow@opus': [{ result: { score: 5, summary: 'AC 2', findings: [expired] } }, clean()],
    'pr-check-flow@sol': [{ result: { score: 6, summary: 'AC 2', findings: [{ ...expired, title: 'Expired coupons pass the check', evidence: 'no expiry comparison' }] } }, clean(9)],
    // Late in both rounds whatever the machine's speed: it answers only once that round's judge ran.
    'pr-check-style@slow': [
      { waitForCall: 'pr-check-judge', result: { score: 3, summary: 'rewrite', findings: [{ severity: 'major', title: 'The coupon helper could be one function', file: 'src/Basket/Coupons.cs', line: 1, evidence: 'two helpers do one thing' }] } },
      { waitForCall: 'pr-check-judge', waitForCalls: 2, result: { score: 3, summary: 'rewrite', findings: [{ severity: 'major', title: 'The coupon helper could be one function', file: 'src/Basket/Coupons.cs', line: 1, evidence: 'two helpers do one thing' }] } },
    ],
    'pr-check-defender': [{ result: { responses: [{ id: 'OPUS-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [{ result: { score: 5, lensScores: { opus: 5 }, summary: 'AC 2 unmet', rulings: [{ id: 'OPUS-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'reject expired coupons' }] } }, { result: { score: 10, lensScores: {}, summary: 'fixed', rulings: [] } }],
    'pr-check-fixer': [{ delayMs: 3500, writeFiles: { 'src/Basket/Coupons.cs': '// coupons, expiry checked\n' }, deleteFiles: [OTHER_TEST], result: { fixed: ['OPUS-1-1'], notFixed: [], summary: 'checks expiry' } }],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual([result.verdict, result.rounds], ['PASS', 2]);

  const prompts = fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');
  const calls = JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
  assert.equal(calls['pr-check-flow@opus'], 2);
  assert.equal(calls['pr-check-acceptance'], 2, 'no member has the acceptance lens: the acceptance critic still runs');
  assert.equal(calls['pr-check-style'], undefined, 'the stage\'s own style critic is replaced by the council');
  // The two members' finding is one finding, raised by both.
  assert.match(prompts, /=== pr-check-defender #1[\s\S]*Expired coupon is accepted[\s\S]*Raised by opus, sol\./);
  // The fixer is told how to handle council findings.
  assert.match(prompts, /=== pr-check-fixer #1[\s\S]*### Council findings: deleting tests and rewrites/);
  // The non-blocking member was not waited for in round 1; its late review reached round 2 as feedback.
  const rounds = fs.readFileSync(path.join(repo, '.factory/metrics/council-rounds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rounds.map((x) => [x.round, x.pass, x.members.map((m) => `${m.name}:${m.status}:${m.score ?? '-'}`).join(' ')]), [
    [1, false, 'slow:late:- opus:ok:5 sol:ok:6'],
    [2, true, 'slow:late:- opus:ok:10 sol:ok:9'],
  ]);
  // Council r3 (sol-11): feedback never reaches the debate or the judge, where a ruling could uphold or raise it; it is
  // a follow-up of round 2.
  const section = (name) => prompts.split('\n=== ').find((p) => p.startsWith(name)) ?? '';
  assert.ok(section('pr-check-judge #2'), 'the judge sat in round 2');
  assert.doesNotMatch(section('pr-check-judge #2'), /The coupon helper could be one function/);
  assert.doesNotMatch(section('pr-check-defender #2'), /The coupon helper could be one function/);
  assert.ok((result.followUps ?? []).some((u) => /The coupon helper could be one function/.test(u.title) && /feedback from non-blocking council member slow; never judged/.test(u.reason ?? '')), JSON.stringify(result.followUps));
  // Council r4 (sol-26): the feedback stays in the findings records as the member's, marked, with no outcome.
  const records = fs.readFileSync(path.join(repo, '.factory/metrics/council-findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const fed = records.filter((x) => x.kind === 'finding' && x.seat === 'slow');
  assert.ok(fed.length && fed.every((x) => x.feedback === true), JSON.stringify(fed));
  assert.ok(!records.some((x) => x.kind === 'outcome' && fed.some((f) => f.finding === x.finding && f.round === x.round && f.check === x.check)));
  // Its review of round 2 came after the last round: it is a follow-up of the check, not lost (dogfood C14).
  assert.ok((result.followUps ?? []).some((u) => /late feedback from non-blocking council member slow/.test(u.reason ?? '')), JSON.stringify(result.followUps));
  // The fixer deleted another story's test: the harness put it back before committing.
  assert.equal(fs.readFileSync(path.join(repo, OTHER_TEST), 'utf8'), "test('TC-DEMO-9-01 coupons of another story', () => {});\n");
  assert.match(sh('git', ['log', '-1', '--name-only', '--format=%s']), /PR check round 1 fixes[\s\S]*src\/Basket\/Coupons\.cs/);
  assert.doesNotMatch(sh('git', ['log', '-1', '--name-only', '--format=%s']), /DEMO-9/);
});

// Dogfood C16 held-out: a later council round blocked, as behaviour no ticket line names, the validation an earlier
// round upheld as the fix. The PR check's council remembers the judge's upheld findings (council.mjs councilMemory):
// the next round's critics read them, and the same objection on the fix's lines is a note even when the judge upholds it.
test('a PR check council does not block, in a later round, the fix of a finding the judge upheld in an earlier round', () => {
  const crash = { severity: 'blocking', title: 'A malformed coupon code throws: an unhandled 500', detail: 'Parse throws on "ABC"', evidence: 'src/Basket/Coupons.cs:1', fix: 'answer 400 for a malformed code', file: 'src/Basket/Coupons.cs', line: 1 };
  const scope = { severity: 'blocking', kind: 'scope', title: 'Adds a 400 for malformed codes that no ticket line asks for', detail: 'new error response', evidence: 'src/Basket/Coupons.cs:3', fix: 'remove the 400 branch', file: 'src/Basket/Coupons.cs', line: 3 };
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [{ result: { score: 10, summary: 'all met', coverage: rowsMet, findings: [] } }],
    // Round 2's scope objection is on lines declared for OPUS-1-1: both blocking members accept it on adjudication.
    'pr-check-flow@opus': [{ result: { score: 5, summary: 'crash', findings: [crash] } }, { result: { score: 6, summary: 'scope', findings: [scope] } }, { result: { answers: [{ key: 'I1', answer: 'yes', evidence: 'src/Basket/Coupons.cs:3: the agreed fix is this 400' }] } }],
    'pr-check-flow@sol': [clean(), { result: { score: 6, summary: 'scope', findings: [{ ...scope, title: 'A 400 response no ticket line names' }] } }, { result: { answers: [{ key: 'I1', answer: 'yes', evidence: 'src/Basket/Coupons.cs:3: the agreed fix is this 400' }] } }],
    'pr-check-style@slow': [clean()],
    'pr-check-defender': [{ result: { responses: [{ id: 'OPUS-1-1', position: 'concede', argument: 'true' }] } }, { result: { responses: [{ id: 'OPUS-2-1', position: 'rebut', argument: 'round 1 required it' }] } }],
    'pr-check-judge': [{ result: { score: 5, lensScores: { opus: 5 }, summary: 'crash', rulings: [{ id: 'OPUS-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'answer 400 for a malformed code' }] } }, { result: { score: 6, lensScores: { opus: 6, sol: 10, slow: 10, acceptance: 10 }, summary: 'scope', rulings: [{ id: 'OPUS-2-1', ruling: 'upheld', severity: 'blocking', reason: 'no ticket line', fix: 'remove the 400 branch' }] } }],
    // The fixer declares the lines it wrote for OPUS-1-1 (council.mjs fixDeclarationText): the settlement's provenance.
    'pr-check-fixer': [{ writeFiles: { 'src/Basket/Coupons.cs': '// coupons, expiry checked\nif (!Coupon.TryParse(code, out var c))\n    return Results.BadRequest("malformed coupon code");\n', '.factory/state/council/fixes/prCheck--DEMO-1.json': JSON.stringify({ fixes: [{ id: 'OPUS-1-1', hunks: [{ file: 'src/Basket/Coupons.cs', start: 2, end: 3 }] }] }) }, result: { fixed: ['OPUS-1-1'], notFixed: [], summary: 'answers 400' } }],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  fs.rmSync(path.join(repo, '.factory/metrics/council-rounds.jsonl'), { force: true });
  const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual([result.verdict, result.rounds], ['PASS', 2], JSON.stringify(result).slice(0, 2000));
  const prompts = fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');
  assert.match(prompts, /=== pr-check-flow@sol #2[\s\S]*### Findings the council upheld in earlier rounds[\s\S]*A malformed coupon code throws[\s\S]*Agreed fix: answer 400/);
  assert.match(prompts, /=== pr-check-fixer #1[\s\S]*### Say which lines answer which finding[\s\S]*council\/fixes\/prCheck--DEMO-1\.json[\s\S]*`OPUS-1-1`/);
  const rounds = fs.readFileSync(path.join(repo, '.factory/metrics/council-rounds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rounds.map((x) => [x.kind ?? 'round', x.round, x.pass ?? null, x.earlierRound ?? x.covered ?? 0]), [['round', 1, false, 0], ['adjudication', 2, null, 1], ['round', 2, true, 1]]);
  assert.match(prompts, /=== pr-check-flow@opus #3[\s\S]*# Council adjudication \(prCheck\)[\s\S]*Earlier finding `OPUS-1-1`/);
});

// Council r1 (A12, A2), r2 (sol-11): the PR check's one seat is its critic panel on the entry the orchestrator picked;
// the shadow seat beside it never touches the verdict (what it says is follow-ups and records, never judged), and a
// shadow still running when the check ends is stopped, not waited for.
test('a one-seat PR check: the critics run on the picked entry; the shadow cannot veto the panel and is never waited for', () => {
  const seatsFile = path.join(repo, '.factory/state/council/seats/prCheck--DEMO-1.json');
  const kept = fs.readFileSync(seatsFile, 'utf8');
  fs.writeFileSync(seatsFile, JSON.stringify({ members: [{ name: 'verifier', entry: 'opus', lens: 'all', blocking: true }, { name: 'sol', entry: 'sol', lens: 'all', blocking: false, shadow: true }] }));
  const clean = (score = 10) => ({ result: { score, summary: 'ok', coverage: [], findings: [] } });
  const outage = { severity: 'major', title: 'Saving returns HTTP 500', file: 'src/Basket/Coupons.cs', line: 1, evidence: 'POST /basket answers 500' };
  const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  const check = (shadow, judgeWaits) => {
    fs.writeFileSync(scriptFile, JSON.stringify({
      'pr-check-acceptance': [{ result: { score: 10, summary: 'all met', coverage: rowsMet, findings: [] } }],
      'pr-check-flow': [clean()],
      'pr-check-style': [clean()],
      'pr-check-flow@sol': [shadow],
      // The shadow has answered before the judge sits (its run started, and it answers at once).
      'pr-check-judge': [{ ...(judgeWaits ? { waitForCall: 'pr-check-flow@sol', delayMs: 1500 } : {}), result: { score: 10, lensScores: { acceptance: 10, flow: 10, style: 10 }, summary: 'all met', rulings: [] } }],
    }));
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--no-fix', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
    return { r, seconds: (Date.now() - t0) / 1000, result: JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) };
  };
  try {
    const before = fs.existsSync(path.join(repo, '.factory/metrics/token-usage.jsonl')) ? fs.readFileSync(path.join(repo, '.factory/metrics/token-usage.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    const { r, result } = check({ result: { findings: [outage] } }, true);
    assert.deepEqual([r.status, result.verdict, result.score], [0, 'PASS', 10], r.stderr.slice(-2000));
    assert.ok(!(result.openFindings ?? []).some((f) => /HTTP 500/.test(f.title)), 'never judged, never upheld');
    assert.ok((result.followUps ?? []).some((u) => /Saving returns HTTP 500/.test(u.title) && /non-blocking shadow seat sol/.test(u.reason)), JSON.stringify(result.followUps));
    // The critics ran on the picked entry; the shadow on its own, as a seat of its own; its finding is recorded, unjudged.
    const usage = fs.readFileSync(path.join(repo, '.factory/metrics/token-usage.jsonl'), 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
    assert.deepEqual([...new Set(usage.filter((u) => /^pr-check-(acceptance|style)$/.test(u.agent)).map((u) => u.entry))], ['opus']);
    assert.deepEqual(usage.filter((u) => u.seat === 'sol').map((u) => [u.agent, u.entry, u.lens]), [['pr-check-flow', 'sol', 'all']]);
    const records = fs.readFileSync(path.join(repo, '.factory/metrics/council-findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => /^SHADOW-/.test(x.finding));
    assert.deepEqual(records.map((x) => [x.kind, x.seat, x.entry, x.feedback]), [['finding', 'sol', 'sol', true]]);
    const round = fs.readFileSync(path.join(repo, '.factory/metrics/council-rounds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(round.members.filter((m) => m.name === 'sol').map((m) => [m.blocking, m.status]), [[false, 'late']]);
    // A shadow still running when the check ends: stopped, not waited for (council.lateGraceSec is 120 s).
    // The shadow would answer after 300 s; the check ends well before (a loaded machine stretches the check itself, so
    // the margin is wide: waiting for the shadow would take over 300 s).
    const pidFile = path.join(repo, '..', `${path.basename(repo)}-shadow.pid`);
    fs.rmSync(pidFile, { force: true });
    const slow = check({ pidFile, delayMs: 300_000, result: { findings: [outage] } }, false);
    assert.deepEqual([slow.r.status, slow.result.verdict], [0, 'PASS']);
    assert.ok(slow.seconds < 240, `the check ended in ${slow.seconds} s`);
    // ... and its run was stopped with it: the shadow's own agent process is gone.
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    fs.rmSync(pidFile, { force: true });
    assert.equal(alive, false, 'the shadow\'s agent was stopped');
  } finally {
    fs.writeFileSync(seatsFile, kept);
  }
});

// Council r3 (T8, sol-01): the same pass decision for a three-member council: the judge's score below the pass score
// (this repository's is 9) with no lens scores and nothing upheld is not a pass.
test('a three-member PR check council: the judge\'s 8.9 with no lens scores and nothing upheld is not a pass at a pass score of 9', () => {
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [{ result: { score: 10, summary: 'all met', coverage: rowsMet, findings: [] } }],
    'pr-check-flow@opus': [clean()],
    'pr-check-flow@sol': [clean()],
    'pr-check-style@slow': [clean()],
    'pr-check-judge': [{ result: { score: 8.9, lensScores: {}, summary: 'close', rulings: [] } }],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--no-fix', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'))['pr-check-flow@sol'], 1, 'the council sat');
  assert.deepEqual([r.status, result.verdict, result.score], [1, 'FAIL', 8.9], r.stderr.slice(-1500));
  // Council r4 (sol-01): one lens scored 10 and the others left out does not lift the round above the overall score;
  // an out-of-range overall score is no score.
  for (const judge of [{ score: 8.9, lensScores: { opus: 10 }, summary: 'close', rulings: [] }, { score: 11, lensScores: {}, summary: 'perfect', rulings: [] }]) {
    fs.writeFileSync(scriptFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(scriptFile, 'utf8')), 'pr-check-judge': [{ result: judge }] }));
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
    const again = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--no-fix', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
    const out = JSON.parse(again.stdout.slice(again.stdout.indexOf('{')));
    assert.equal(again.status, 1, JSON.stringify(judge));
    assert.notEqual(out.verdict, 'PASS', JSON.stringify(judge));
  }
});

// Council r5 (sol-26): the panel's shadow raising the deciding acceptance critic's finding is recorded under that
// finding's id (with its action), not as a SHADOW finding unique to each.
test('a one-seat PR check: a shadow finding that matches a deciding critic\'s finding is recorded under its id', () => {
  const seatsFile = path.join(repo, '.factory/state/council/seats/prCheck--DEMO-1.json');
  const kept = fs.readFileSync(seatsFile, 'utf8');
  fs.writeFileSync(seatsFile, JSON.stringify({ members: [{ name: 'verifier', entry: 'opus', lens: 'all', blocking: true }, { name: 'sol', entry: 'sol', lens: 'all', blocking: false, shadow: true }] }));
  const outage = { severity: 'major', title: 'Saving returns HTTP 500', detail: 'POST /basket answers 500', file: 'src/Basket/Coupons.cs', line: 1, evidence: 'POST /basket answers 500', action: 'fix', fix: 'handle the save' };
  try {
    fs.writeFileSync(scriptFile, JSON.stringify({
      'pr-check-acceptance': [{ result: { score: 8, summary: 'outage', coverage: rowsMet, findings: [outage] } }],
      'pr-check-flow': [clean()],
      'pr-check-style': [clean()],
      'pr-check-flow@sol': [{ result: { findings: [{ ...outage, title: 'Saving the basket returns HTTP 500' }] } }],
      'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
      'pr-check-judge': [{ waitForCall: 'pr-check-flow@sol', result: { score: 8, lensScores: { acceptance: 8, flow: 10, style: 10 }, summary: 'outage', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'major', reason: 'conceded', fix: 'handle the save' }] } }],
    }));
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
    const recordsFile = path.join(repo, '.factory/metrics/council-findings.jsonl');
    const before = fs.existsSync(recordsFile) ? fs.readFileSync(recordsFile, 'utf8').trim().split('\n').length : 0;
    const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
    delete env.PIPELINE_CHILD;
    delete env.PIPELINE_DISABLE;
    const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--no-fix', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
    assert.ok(r.stdout.includes('{'), r.stderr.slice(-1500));
    const rows = fs.readFileSync(recordsFile, 'utf8').trim().split('\n').slice(before).map((l) => JSON.parse(l)).filter((x) => x.kind === 'finding');
    assert.deepEqual(rows.filter((x) => x.seat === 'sol').map((x) => [x.finding, x.feedback, x.action]), [['ACC-1-1', true, 'fix']], JSON.stringify(rows));
  } finally {
    fs.writeFileSync(seatsFile, kept);
  }
});

// Council r3 (sol-22): the panel (one seat, no council object) skipped the protected-test restoration before the commit.
test('a one-seat PR check: another story\'s test the fix deleted comes back before the commit', () => {
  const seatsFile = path.join(repo, '.factory/state/council/seats/prCheck--DEMO-1.json');
  const kept = fs.readFileSync(seatsFile, 'utf8');
  fs.writeFileSync(seatsFile, JSON.stringify({ members: [{ name: 'verifier', entry: 'opus', lens: 'all', blocking: true }] }));
  try {
    fs.writeFileSync(scriptFile, JSON.stringify({
      'pr-check-acceptance': [{ result: { score: 5, summary: 'AC 2', coverage: rowsMet, findings: [expired] } }, { result: { score: 10, summary: 'all met', coverage: rowsMet, findings: [] } }],
      'pr-check-flow': [clean(), clean()],
      'pr-check-style': [clean(), clean()],
      'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
      'pr-check-judge': [{ result: { score: 5, lensScores: { acceptance: 5, flow: 10, style: 10 }, summary: 'AC 2 unmet', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'reject expired coupons' }] } }, { result: { score: 10, lensScores: { acceptance: 10, flow: 10, style: 10 }, summary: 'fixed', rulings: [] } }],
      'pr-check-fixer': [{ writeFiles: { 'src/Basket/Coupons.cs': '// coupons, expiry checked in the panel round\n' }, deleteFiles: [OTHER_TEST], result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'checks expiry' } }],
    }));
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
    const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
    delete env.PIPELINE_CHILD;
    delete env.PIPELINE_DISABLE;
    const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
    const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.equal(JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'))['pr-check-fixer'], 1, r.stderr.slice(-2000));
    assert.equal(result.verdict, 'PASS', r.stderr.slice(-2000));
    assert.equal(fs.readFileSync(path.join(repo, OTHER_TEST), 'utf8'), "test('TC-DEMO-9-01 coupons of another story', () => {});\n");
    assert.doesNotMatch(sh('git', ['log', '-1', '--name-only', '--format=%s']), /DEMO-9/);
  } finally {
    fs.writeFileSync(seatsFile, kept);
  }
});

// Council r2 (sol-14): a panel critic's rejoinder in the debate ran on the critic's own entry, with no seat.
test('a one-seat PR check: a critic\'s rejoinder runs on the picked entry and is recorded as its seat', () => {
  const seatsFile = path.join(repo, '.factory/state/council/seats/prCheck--DEMO-1.json');
  const kept = fs.readFileSync(seatsFile, 'utf8');
  fs.writeFileSync(seatsFile, JSON.stringify({ members: [{ name: 'verifier', entry: 'sol', lens: 'all', blocking: true }] }));
  const clean = { result: { score: 10, summary: 'ok', coverage: [], findings: [] } };
  try {
    fs.writeFileSync(scriptFile, JSON.stringify({
      'pr-check-acceptance': [{ result: { score: 10, summary: 'all met', coverage: rowsMet, findings: [] } }],
      'pr-check-flow': [clean],
      'pr-check-style': [{ result: { score: 8, summary: 'naming', coverage: [], findings: [{ severity: 'minor', title: 'A helper name is vague', file: 'src/Basket/Coupons.cs', line: 1, evidence: 'helper()' }] } }, { result: { responses: [{ id: 'STY-1-1', action: 'maintain', argument: 'still vague' }] } }],
      'pr-check-defender': [{ result: { responses: [{ id: 'STY-1-1', position: 'rebut', argument: 'it is clear' }] } }],
      'pr-check-judge': [{ result: { score: 9, lensScores: { style: 9 }, summary: 'minor', rulings: [{ id: 'STY-1-1', ruling: 'upheld', severity: 'minor', reason: 'vague' }] } }],
    }));
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
    const before = fs.readFileSync(path.join(repo, '.factory/metrics/token-usage.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', TESTSTACK_STATE_HOME: leaseHome };
    delete env.PIPELINE_CHILD;
    delete env.PIPELINE_DISABLE;
    const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--no-fix', '--debate-turns', '1', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 1_800_000 });
    assert.equal(JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'))['pr-check-style'], 2, `the critic answered the defender\n${r.stderr.slice(-1500)}`);
    const usage = fs.readFileSync(path.join(repo, '.factory/metrics/token-usage.jsonl'), 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
    assert.deepEqual(usage.filter((u) => u.agent === 'pr-check-style').map((u) => [u.entry, u.seat, u.lens]), [['sol', 'style', 'rewrite'], ['sol', 'style', 'rewrite']]);
  } finally {
    fs.writeFileSync(seatsFile, kept);
  }
});
