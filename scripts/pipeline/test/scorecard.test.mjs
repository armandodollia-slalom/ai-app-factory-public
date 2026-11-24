// GEN-13: the council scorecard, plain arithmetic over the council records: one row per model, lens and stage, unknown
// under the minimum sample, uniqueness within a ticket, the family-bias check, a pipeline-owned file the pre-push
// check guards, empty with no records.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeScorecard, scorecardPath, scorecardProblems, scorecardRecords, scorecardVersion, writeScorecard } from '../lib/scorecard.mjs';
import { scorecardFor, selectionTask } from '../lib/selection.mjs';

const RETRO = fileURLToPath(new URL('../../retro/retro.mjs', import.meta.url));
const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
];
// The repository's own settings for the CLI runs: the default agent map names sonnet too.
const REPO_CONFIG = JSON.stringify({ models: { pool: [...POOL, { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }] }, council: { scorecard: { minSeats: 2 } } });
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
function setup(t, settings = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  const saved = { shard: process.env.FACTORY_METRICS_SHARD, spool: process.env.FACTORY_METRICS_SPOOL };
  Object.assign(process.env, { FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0' });
  t.after(() => { for (const [k, v] of Object.entries({ FACTORY_METRICS_SHARD: saved.shard, FACTORY_METRICS_SPOOL: saved.spool })) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', lessonsDir: '.factory/lessons', models: { pool: POOL, agents: { default: 'opus' } }, ...settings };
}
const write = (config, stream, rows) => {
  fs.mkdirSync(path.join(config.root, config.metricsDir), { recursive: true });
  fs.appendFileSync(path.join(config.root, config.metricsDir, stream), rows.map((r) => `${JSON.stringify({ ts: '2026-11-20T10:00:00.000Z', ...r })}\n`).join(''));
};
const member = (entry, lens) => ({ name: entry, entry, model: POOL.find((e) => e.name === entry).model, family: entry === 'opus' ? 'Anthropic' : 'OpenAI', lens, status: 'ok' });
const ROUND_MEMBERS = [member('opus', 'correctness'), member('sol', 'security')];
const round = (story, n, pass, stage = 'architectureReview', members = ROUND_MEMBERS) => ({ stage, story, round: n, pass, members });
const finding = (story, rnd, id, entry, lens, stage = 'architectureReview') => ({ kind: 'finding', story, stage, round: rnd, finding: id, seat: entry, entry, model: POOL.find((e) => e.name === entry).model, family: entry === 'opus' ? 'Anthropic' : 'OpenAI', lens });
const outcome = (story, rnd, id, result, stage = 'architectureReview', judge = undefined, ruling = result) => ({ kind: 'outcome', story, stage, round: rnd, finding: id, outcome: result, ...(judge ? { ruling, by: ruling === result ? 'judge' : 'harness', judge } : {}) });
const usage = (story, seat, lens, runId, tokens, seconds) => ({ run_id: runId, story, stage: 'review', seat, member: seat, lens, entry: seat, tokens, seconds });

// Two tickets of an architecture review council (opus on correctness, sol on security), hand-computed below.
function fixture(config) {
  write(config, 'council-rounds.jsonl', [round('T-1', 1, false), round('T-1', 2, true), round('T-2', 1, true)]);
  write(config, 'council-findings.jsonl', [
    finding('T-1', 1, 'F1', 'opus', 'correctness'), finding('T-1', 1, 'F1', 'sol', 'security'), // raised by both
    finding('T-1', 1, 'F2', 'opus', 'correctness'),
    finding('T-1', 1, 'F3', 'sol', 'security'),
    finding('T-2', 1, 'F4', 'opus', 'correctness'), // no outcome yet: not judged
    outcome('T-1', 1, 'F1', 'led-to-change'), outcome('T-1', 1, 'F2', 'led-to-change'), outcome('T-1', 1, 'F3', 'no-change'),
    { kind: 'miss', story: 'T-1', stage: 'architectureReview', seat: 'opus', entry: 'opus', model: 'claude-opus-5-5', lens: 'correctness', missedLens: 'correctness', source: 'prCheck' },
    { kind: 'miss', story: 'T-2', stage: 'architectureReview', seat: 'sol', entry: 'sol', model: 'gpt-6.1-sol', lens: 'security', missedLens: null, source: 'bug-ticket', lowWeight: true },
  ]);
  write(config, 'token-usage.jsonl', [
    // One run that used two models writes two records with one run id: its seconds count once.
    usage('T-1', 'opus', 'correctness', 'r1', { input: 1000, output: 200 }, 30), usage('T-1', 'opus', 'correctness', 'r1', { input: 100, output: 0 }, 30),
    usage('T-2', 'opus', 'correctness', 'r2', { input: 400, output: 100 }, 20),
    usage('T-1', 'sol', 'security', 'r3', { input: 700, output: 100 }, 10),
    { run_id: 'r4', story: 'T-1', stage: 'review', agent: 'stage-orchestrator', tokens: { input: 9999 }, seconds: 99 }, // not a seat
  ]);
}

test('each number of a row, against a hand-computed fixture; the retro writes the same scorecard twice', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 2 } } });
  fixture(config);
  const doc = computeScorecard(config, scorecardRecords(config));
  const pick = (r) => [r.model, r.lens, r.stage, r.seats, r.unknown, r.judged, r.upheld, r.upheldRate, r.unique, r.misses, r.lowWeightMisses, r.tokensPerUpheld, r.secondsPerUpheld, r.score];
  assert.deepEqual(doc.rows.map(pick), [
    // opus: 2 councils; F1 and F2 judged and led to a change, F2 its own (F1 sol raised too), F4 not judged; one miss;
    // tokens 1200 + 100 + 500 = 1800 over 2 upheld; seconds 30 (once for r1) + 20 over 2; score (2 × 0.5 − 1 × 1) / 2.
    ['claude-opus-5-5', 'correctness', 'architectureReview', 2, false, 2, 2, 1, 1, 1, 0, 900, 25, 0],
    // sol: F1 led to a change (shared: unique to neither), F3 did not; a lower-weight miss; 800 tokens and 10 seconds
    // over 1 upheld; score (1 × 0.5 − 1 × 0.25) / 2.
    ['gpt-6.1-sol', 'security', 'architectureReview', 2, false, 2, 1, 0.5, 0, 0, 1, 800, 10, 0.125],
  ]);
  assert.deepEqual([doc.minSeats, doc.weights], [2, { prCheckRuling: 1, miss: 1, ledToChange: 0.5, lowWeightMiss: 0.25 }]);
  const first = writeScorecard(config);
  const text = fs.readFileSync(scorecardPath(config), 'utf8');
  fs.rmSync(scorecardPath(config));
  writeScorecard(config);
  assert.equal(fs.readFileSync(scorecardPath(config), 'utf8'), text, 'the same records give the same file');
  assert.equal(first.doc.version, doc.version);
  assert.equal(scorecardFor(config).version, doc.version, 'selection quotes the version it read');
});

test('the retro run writes the scorecard beside the lessons, and a second run writes the same one', (t) => {
  const config = setup(t);
  fixture(config);
  fs.mkdirSync(path.join(config.root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(config.root, '.factory/config.json'), REPO_CONFIG);
  git(config.root, 'add', '-A');
  git(config.root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  const run = () => spawnSync(process.execPath, [RETRO, 'run', '--local'], { cwd: config.root, encoding: 'utf8', env: { ...process.env, PIPELINE_LESSONS: 'on', FACTORY_SINK: 'none' } });
  const a = run();
  assert.equal(a.status, 0, a.stderr);
  const text = fs.readFileSync(scorecardPath(config), 'utf8');
  assert.equal(JSON.parse(text).rows.length, 2);
  fs.rmSync(scorecardPath(config));
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(scorecardPath(config), 'utf8'), text);
});

test('the minimum sample: 9 seats in a lens and stage is unknown, with no numbers; 10 has numbers', (t) => {
  const config = setup(t);
  const rounds = (n) => Array.from({ length: n }, (_, i) => round(`T-${i + 1}`, 1, true, 'testPlan', [member('opus', 'test-value')]));
  const nine = computeScorecard(config, { rounds: rounds(9) }).rows[0];
  assert.deepEqual([nine.seats, nine.unknown, nine.upheldRate, nine.unique, nine.misses, nine.score], [9, true, null, null, null, null]);
  const ten = computeScorecard(config, { rounds: rounds(10) }).rows[0];
  assert.deepEqual([ten.seats, ten.unknown, ten.upheld, ten.misses, ten.score], [10, false, 0, 0, 0]);
  assert.match(selectionTask({ stage: 'testPlan', count: 2, pool: POOL, shape: 'test', scorecard: { rows: [nine, ten] } }), /- claude-opus-5-5 \/ test-value: unknown \(9 seats, too few\)\n- claude-opus-5-5 \/ test-value: seats 10, score 0,/);
});

test('uniqueness is within the ticket: a finding two members raised is unique to neither; the same id on another ticket is another finding', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 1 } } });
  const rows = computeScorecard(config, {
    rounds: [round('T-1', 1, true), round('T-2', 1, true)],
    findings: [
      finding('T-1', 1, 'X', 'opus', 'correctness'), finding('T-1', 1, 'X', 'sol', 'security'), outcome('T-1', 1, 'X', 'led-to-change'),
      finding('T-2', 1, 'X', 'opus', 'correctness'), outcome('T-2', 1, 'X', 'led-to-change'),
    ],
  }).rows;
  assert.deepEqual(rows.map((r) => [r.model, r.upheld, r.unique]), [['claude-opus-5-5', 2, 1], ['gpt-6.1-sol', 1, 0]]);
});

test('the bias check: per judge family, the upheld rate of same-family and other-family findings, reported separately', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 1 } } });
  const judge = { entry: 'opus', model: 'claude-opus-5-5', family: 'Anthropic' };
  const doc = computeScorecard(config, {
    rounds: [round('T-1', 1, true, 'prCheck', [member('opus', 'acceptance'), member('sol', 'correctness')])],
    findings: [
      finding('T-1', 1, 'A', 'opus', 'acceptance', 'prCheck'), outcome('T-1', 1, 'A', 'upheld', 'prCheck', judge),
      finding('T-1', 1, 'B', 'opus', 'acceptance', 'prCheck'), outcome('T-1', 1, 'B', 'dismissed', 'prCheck', judge),
      finding('T-1', 1, 'C', 'sol', 'correctness', 'prCheck'), outcome('T-1', 1, 'C', 'upheld', 'prCheck', judge),
      finding('T-1', 1, 'D', 'sol', 'correctness', 'prCheck'), outcome('T-1', 1, 'D', 'upheld', 'prCheck', judge),
      // The harness upheld E against the judge's dismissal, and F stood with no ruling: neither is a ruling of the judge.
      finding('T-1', 1, 'E', 'opus', 'acceptance', 'prCheck'), outcome('T-1', 1, 'E', 'upheld', 'prCheck', judge, 'dismissed'),
      finding('T-1', 1, 'F', 'opus', 'acceptance', 'prCheck'), { kind: 'outcome', story: 'T-1', stage: 'prCheck', round: 1, finding: 'F', outcome: 'upheld', ruling: null, by: 'harness' },
    ],
  });
  // E counts as the judge's dismissal; F, never ruled on, not at all.
  assert.deepEqual(doc.bias, [{ judgeFamily: 'Anthropic', sameFamily: { judged: 3, upheld: 1, upheldRate: 0.333 }, otherFamilies: { judged: 2, upheld: 2, upheldRate: 1 } }]);
  // A PR check ruling weighs 1.0 (the pair stages' "led to a change" 0.5): opus 3 upheld outcomes (A, E, F) over 1 seat.
  assert.equal(doc.rows.find((r) => r.lens === 'acceptance').score, 3);
});

test('no records: the retro writes an empty scorecard and selection sees every model as unknown', (t) => {
  const config = setup(t);
  const { doc } = writeScorecard(config);
  assert.deepEqual([doc.rows, doc.bias, doc.inputs.records], [[], [], 0]);
  const card = scorecardFor(config);
  assert.deepEqual([card.version, card.rows], [doc.version, []]);
  assert.match(selectionTask({ stage: 'prCheck', count: 2, pool: POOL, shape: 'backend', scorecard: card }), /## Scorecard\n\n\(empty: every model is unknown\)/);
});

test('an edited scorecard is refused by the pre-push check, as for the other pipeline-owned files; the retro\'s own passes', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 2 } } });
  fixture(config);
  fs.mkdirSync(path.join(config.root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(config.root, '.factory/config.json'), REPO_CONFIG);
  const commit = (msg) => (git(config.root, 'add', '-A'), git(config.root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg), git(config.root, 'rev-parse', 'HEAD').stdout.trim());
  const base = commit('init');
  writeScorecard(config);
  const own = commit('retro: scorecard');
  const push = (sha) => spawnSync(process.execPath, [RETRO, 'git-hook', 'pre-push'], { cwd: config.root, encoding: 'utf8', input: `refs/heads/main ${sha} refs/heads/main ${base}\n` });
  assert.equal(push(own).status, 0, push(own).stderr);
  // An agent raises its own row's numbers.
  const doc = JSON.parse(fs.readFileSync(scorecardPath(config), 'utf8'));
  doc.rows[1].upheldRate = 1;
  fs.writeFileSync(scorecardPath(config), JSON.stringify(doc, null, 2));
  const edited = commit('better numbers');
  const refused = push(edited);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /changes \.factory\/lessons\/scorecard\.json, which only the retro writes: its version does not match its content/);
  // Re-hashing the version does not help while the records it was computed from are here.
  doc.version = scorecardVersion(doc);
  assert.deepEqual(scorecardProblems(config, JSON.stringify(doc)), ['its numbers differ from the ones its records give']);
  // Council r3 (sol-23): deleting it is refused too, against a remote that has it.
  git(config.root, 'reset', '-q', '--hard', own);
  fs.rmSync(scorecardPath(config));
  const deleted = commit('drop the scorecard');
  const gone = spawnSync(process.execPath, [RETRO, 'git-hook', 'pre-push'], { cwd: config.root, encoding: 'utf8', input: `refs/heads/main ${deleted} refs/heads/main ${own}\n` });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /changes \.factory\/lessons\/scorecard\.json, which only the retro writes: the push deletes it/);
});

// Council r2 (sol-17): two checks of one ticket both start their ids at ACC-1-1; the join must not mix their outcomes.
test('two PR check runs of one ticket: each finding joins its own run\'s outcome, whatever the order of the records', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 1 } } });
  const judge = { entry: 'opus', model: 'claude-opus-5-5', family: 'Anthropic' };
  const run = (check, result) => [{ ...finding('T-1', 1, 'ACC-1-1', 'sol', 'acceptance', 'prCheck'), check }, { ...outcome('T-1', 1, 'ACC-1-1', result, 'prCheck', judge), check }];
  const rounds = [round('T-1', 1, true, 'prCheck', [member('sol', 'acceptance')])];
  const a = computeScorecard(config, { rounds, findings: [...run('c1', 'upheld'), ...run('c2', 'dismissed')] }).rows[0];
  const b = computeScorecard(config, { rounds, findings: [...run('c2', 'dismissed'), ...run('c1', 'upheld')] }).rows[0];
  assert.deepEqual([a.judged, a.upheld, b.judged, b.upheld], [2, 1, 2, 1]);
});

// Council r3 (sol-20): two checks of one ticket, the same seat held by another model in each: the usage join took the
// first seat it found, so the first model got both runs' cost and the second none.
test('two PR check runs with another model in the same seat: each run\'s cost goes to the model that ran it', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 1 } } });
  const judge = { entry: 'opus', model: 'claude-opus-5-5', family: 'Anthropic' };
  const seatOn = (entry) => ({ ...member(entry, 'acceptance'), name: 'acc' });
  const rounds = [{ ...round('T-1', 1, false, 'prCheck', [seatOn('opus')]), check: 'c1' }, { ...round('T-1', 1, false, 'prCheck', [seatOn('sol')]), check: 'c2' }];
  const findings = [
    { ...finding('T-1', 1, 'ACC-1-1', 'opus', 'acceptance', 'prCheck'), seat: 'acc', check: 'c1' }, { ...outcome('T-1', 1, 'ACC-1-1', 'upheld', 'prCheck', judge), check: 'c1' },
    { ...finding('T-1', 1, 'ACC-1-1', 'sol', 'acceptance', 'prCheck'), seat: 'acc', check: 'c2' }, { ...outcome('T-1', 1, 'ACC-1-1', 'upheld', 'prCheck', judge), check: 'c2' },
  ];
  const run = (entry, check, tokens, seconds) => ({ run_id: `${check}-${entry}`, story: 'T-1', stage: 'pr-check', seat: 'acc', member: 'acc', lens: 'acceptance', entry, check, tokens: { input: tokens, output: 0 }, seconds });
  const rows = computeScorecard(config, { rounds, findings, usage: [run('opus', 'c1', 300, 2), run('sol', 'c2', 500, 4)] }).rows;
  const of = (model) => rows.find((r) => r.model === model);
  assert.deepEqual([of('claude-opus-5-5').tokensPerUpheld, of('claude-opus-5-5').secondsPerUpheld, of('gpt-6.1-sol').tokensPerUpheld, of('gpt-6.1-sol').secondsPerUpheld], [300, 2, 500, 4]);
});

// Council r4 (sol-25): a miss is charged to the model the miss names, not to the model that held the seat last.
test('a miss counts against the model it names, even when another model held that seat in a later round', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 1 } } });
  const seatOn = (entry) => ({ ...member(entry, 'correctness'), name: 'corr' });
  const rounds = [round('T-1', 1, true, 'architectureReview', [seatOn('opus')]), round('T-1', 2, true, 'architectureReview', [seatOn('sol')])];
  const miss = { kind: 'miss', story: 'T-1', stage: 'architectureReview', seat: 'corr', councilRound: 1, entry: 'opus', model: 'claude-opus-5-5', lens: 'correctness', missedLens: 'correctness', source: 'prCheck' };
  const rows = computeScorecard(config, { rounds, findings: [miss] }).rows;
  assert.deepEqual([rows.find((r) => r.model === 'claude-opus-5-5').misses, rows.find((r) => r.model === 'gpt-6.1-sol').misses], [1, 0]);
});

// Council r5 (sol-26): the shadow seat raising the deciding critic's finding (recorded under its id) makes the finding
// unique to neither, and earns the shadow's model no judged or upheld credit for a ruling on the deciding finding.
test('a shadow row under the deciding finding\'s id: not unique for the decider, no outcome credit for the shadow', (t) => {
  const config = setup(t, { council: { scorecard: { minSeats: 1 } } });
  const judge = { entry: 'opus', model: 'claude-opus-5-5', family: 'Anthropic' };
  const rounds = [round('T-1', 1, false, 'prCheck', [member('opus', 'acceptance'), { ...member('sol', 'all'), name: 'sol', shadow: true }])];
  const findings = [finding('T-1', 1, 'ACC-1-1', 'opus', 'acceptance', 'prCheck'), { ...finding('T-1', 1, 'ACC-1-1', 'sol', 'all', 'prCheck'), feedback: true }, outcome('T-1', 1, 'ACC-1-1', 'upheld', 'prCheck', judge)];
  const rows = computeScorecard(config, { rounds, findings }).rows;
  const opus = rows.find((r) => r.model === 'claude-opus-5-5');
  const sol = rows.find((r) => r.model === 'gpt-6.1-sol');
  assert.deepEqual([opus.judged, opus.upheld, opus.unique, sol.judged, sol.upheld], [1, 1, 0, 0, 0]);
});
