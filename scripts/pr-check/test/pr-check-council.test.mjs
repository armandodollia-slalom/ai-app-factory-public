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
  stages: { prCheck: { rounds: 3 } },
};

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-check-council-'));
  scriptFile = path.join(repo, '..', `${path.basename(repo)}-agent.json`);
  for (const dir of ['scripts/pipeline', 'scripts/pr-check', 'scripts/board', 'scripts/implement', 'scripts/feature-verification', 'scripts/stack', 'scripts/teststack']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  fs.cpSync(path.join(source, 'skills', 'council'), path.join(repo, 'skills', 'council'), { recursive: true });
  write('.gitignore', '.factory/state/\n.factory/metrics/\n');
  write('.factory/config.json', JSON.stringify({ agent: { modelIds: { codex: { sol: 'gpt-6.1-sol' } } }, council: COUNCIL }));
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
    'pr-check-style@slow': [{ delayMs: 2500, result: { score: 3, summary: 'rewrite', findings: [{ severity: 'major', title: 'The coupon helper could be one function', file: 'src/Basket/Coupons.cs', line: 1, evidence: 'two helpers do one thing' }] } }],
    'pr-check-defender': [{ result: { responses: [{ id: 'OPUS-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [{ result: { score: 5, lensScores: { opus: 5 }, summary: 'AC 2 unmet', rulings: [{ id: 'OPUS-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'reject expired coupons' }] } }, { result: { score: 10, lensScores: {}, summary: 'fixed', rulings: [] } }],
    'pr-check-fixer': [{ delayMs: 3500, writeFiles: { 'src/Basket/Coupons.cs': '// coupons, expiry checked\n' }, deleteFiles: [OTHER_TEST], result: { fixed: ['OPUS-1-1'], notFixed: [], summary: 'checks expiry' } }],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 240_000 });
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
  assert.match(prompts, /=== pr-check-judge #2[\s\S]*The coupon helper could be one function[\s\S]*Feedback from non-blocking council member slow/);
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
    'pr-check-flow@opus': [{ result: { score: 5, summary: 'crash', findings: [crash] } }, { result: { score: 6, summary: 'scope', findings: [scope] } }],
    'pr-check-flow@sol': [clean(), { result: { score: 6, summary: 'scope', findings: [{ ...scope, title: 'A 400 response no ticket line names' }] } }],
    'pr-check-style@slow': [clean()],
    'pr-check-defender': [{ result: { responses: [{ id: 'OPUS-1-1', position: 'concede', argument: 'true' }] } }, { result: { responses: [{ id: 'OPUS-2-1', position: 'rebut', argument: 'round 1 required it' }] } }],
    'pr-check-judge': [{ result: { score: 5, lensScores: { opus: 5 }, summary: 'crash', rulings: [{ id: 'OPUS-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'answer 400 for a malformed code' }] } }, { result: { score: 6, lensScores: { opus: 6 }, summary: 'scope', rulings: [{ id: 'OPUS-2-1', ruling: 'upheld', severity: 'blocking', reason: 'no ticket line', fix: 'remove the 400 branch' }] } }],
    // The fixer declares the lines it wrote for OPUS-1-1 (council.mjs fixDeclarationText): the settlement's provenance.
    'pr-check-fixer': [{ writeFiles: { 'src/Basket/Coupons.cs': '// coupons, expiry checked\nif (!Coupon.TryParse(code, out var c))\n    return Results.BadRequest("malformed coupon code");\n', '.factory/state/council/fixes/prCheck--DEMO-1.json': JSON.stringify({ fixes: [{ id: 'OPUS-1-1', hunks: [{ file: 'src/Basket/Coupons.cs', start: 2, end: 3 }] }] }) }, result: { fixed: ['OPUS-1-1'], notFixed: [], summary: 'answers 400' } }],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  fs.rmSync(path.join(repo, '.factory/metrics/council-rounds.jsonl'), { force: true });
  const env = { ...process.env, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 240_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual([result.verdict, result.rounds], ['PASS', 2], JSON.stringify(result).slice(0, 2000));
  const prompts = fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');
  assert.match(prompts, /=== pr-check-flow@sol #2[\s\S]*### Findings the council upheld in earlier rounds[\s\S]*A malformed coupon code throws[\s\S]*Agreed fix: answer 400/);
  assert.match(prompts, /=== pr-check-fixer #1[\s\S]*### Say which lines answer which finding[\s\S]*council\/fixes\/prCheck--DEMO-1\.json[\s\S]*`OPUS-1-1`/);
  const rounds = fs.readFileSync(path.join(repo, '.factory/metrics/council-rounds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rounds.map((x) => [x.round, x.pass, x.earlierRound ?? 0]), [[1, false, 0], [2, true, 1]]);
});
