// GEN-11: the stage's orchestrator picks the council's seats and lenses; the harness holds the pick to a diverse
// council, asks once more after a bad pick, then fills the seats itself; the pick is kept for the ticket; one
// council.selection event per pick.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { councilFor, memberTask, mergeCouncil, runCouncil } from '../lib/council.mjs';
import { byRank, harnessPick, pickProblems, selectCouncil } from '../lib/selection.mjs';
import { readJsonl } from '../lib/util.mjs';

const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { name: 'gem', cli: 'copilot', model: 'gemini-3-pro', effort: 'high' },
];
function setup(t, { pool = POOL, seats = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selection-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const saved = { shard: process.env.FACTORY_METRICS_SHARD, spool: process.env.FACTORY_METRICS_SPOOL };
  Object.assign(process.env, { FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0' });
  t.after(() => { for (const [k, v] of Object.entries({ FACTORY_METRICS_SHARD: saved.shard, FACTORY_METRICS_SPOOL: saved.spool })) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', lessonsDir: '.factory/lessons', models: { pool, agents: { default: 'sonnet' } }, orchestrator: { model: 'opus' }, ...seats };
}
// A scripted orchestrator: each call answers the next pick; it records the tasks it was given.
const picker = (...picks) => {
  const tasks = [];
  const run = async (o) => (tasks.push(o), { ok: true, output: `AGENT_RESULT: ${JSON.stringify({ seats: picks[Math.min(tasks.length - 1, picks.length - 1)] })}` });
  return { run, tasks };
};
const events = (config) => readJsonl(path.join(config.root, '.factory/metrics/council-selections.jsonl'));
const seat = (entry, lens, reason = `${entry} for ${lens}`) => ({ entry, lens, reason });

test('a pick that seats one family twice while another has no seat is rejected with the reason, and asked for once more', async (t) => {
  const config = setup(t, { pool: [POOL[0], POOL[1], POOL[2]], seats: { architectureReview: { councilMembers: 2 } } });
  const o = picker([seat('opus', 'correctness'), seat('sonnet', 'security')], [seat('opus', 'correctness'), seat('sol', 'security')]);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.equal(o.tasks.length, 2);
  assert.match(o.tasks[1].task, /## Your last pick was rejected[\s\S]*Anthropic sit twice while OpenAI has no seat/);
  assert.deepEqual([o.tasks[0].name, o.tasks[0].entry, o.tasks[0].mode], ['stage-orchestrator', 'opus', 'read']);
  assert.deepEqual([r.chooser, r.members.map((m) => [m.name, m.lens, m.blocking])], ['orchestrator', [['opus', 'correctness', true], ['sol', 'security', true]]]);
  assert.match(events(config)[0].rejected[0].reason, /^Anthropic sit twice while OpenAI has no seat: seat one entry per family first/);
});

test('a second bad pick: the harness seats one entry per family in pool order, and the event names it the chooser with both rejected picks', async (t) => {
  const config = setup(t, { pool: [POOL[0], POOL[1], POOL[2]], seats: { architectureReview: { councilMembers: 2 } } });
  const bad = [seat('opus', 'correctness'), seat('sonnet', 'security')];
  const o = picker(bad, bad);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.equal(r.chooser, 'harness');
  assert.deepEqual(r.members.map((m) => [m.entry, m.lens]), [['opus', 'correctness'], ['sol', 'security']]);
  const [ev] = events(config);
  assert.deepEqual([ev.chooser, ev.rejected.length, ev.rejected.map((x) => x.pick.map((s) => s.entry).join('+'))], ['harness', 2, ['opus+sonnet', 'opus+sonnet']]);
});

test('two families and three seats: each family once and one repeat is accepted', async (t) => {
  const config = setup(t, { pool: [POOL[0], POOL[1], POOL[2]], seats: { architectureReview: { councilMembers: 3 } } });
  const o = picker([seat('opus', 'correctness'), seat('sol', 'security'), seat('sonnet', 'rewrite')]);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.deepEqual([o.tasks.length, r.chooser, r.members.map((m) => m.entry)], [1, 'orchestrator', ['opus', 'sol', 'sonnet']]);
});

test('the rules: the stage\'s core lens, a lens it allows, ui only on a CLI that drives a browser, no shared lens while one is free, the count', () => {
  const pool = POOL;
  const problems = (stage, pick) => pickProblems({ stage, count: pick.length, pool, pick }).join('\n');
  assert.match(problems('prCheck', [seat('opus', 'correctness'), seat('sol', 'security'), seat('gem', 'rewrite')]), /the stage's core lens acceptance has no seat/);
  assert.equal(problems('prCheck', [seat('opus', 'acceptance'), seat('sol', 'security'), seat('gem', 'rewrite')]), '');
  assert.match(problems('pairUiVerify', [seat('sol', 'ui'), seat('opus', 'correctness')]), /sol runs on codex, which cannot drive a browser, so it cannot take the ui lens/);
  assert.match(problems('testPlan', [seat('opus', 'test-value'), seat('sol', 'ui')]), /lens "ui" is not one this stage allows/);
  assert.match(problems('architectureReview', [seat('opus', 'correctness'), seat('sol', 'correctness')]), /two members share the correctness lens while security, rewrite, acceptance, test-value has no seat/);
  assert.match(pickProblems({ stage: 'architectureReview', count: 3, pool, pick: [seat('opus', 'correctness')] }).join(), /pick exactly 3 seat\(s\) \(got 1\)/);
  assert.match(problems('architectureReview', [seat('opus', 'correctness'), seat('haiku', 'security')]), /"haiku" is not in the pool/);
});

// Council r1 (A12, sol-08): the orchestrator picks the one seat too; the harness keeps the stage's own verifier for a bad pick.
test('one seat: the orchestrator picks its entry, the member reviews every lens on it, and a bad pick falls back to the stage\'s own verifier', async (t) => {
  const config = setup(t);
  const o = picker([seat('sol', 'all', 'another family reads plans well')]);
  const r = await selectCouncil(config, 'testPlan', { subject: 'K-1', run: o.run });
  assert.deepEqual([o.tasks.length, o.tasks[0].name], [1, 'stage-orchestrator']);
  assert.match(o.tasks[0].task, /Seat 1 member for the testPlan stage[\s\S]*reviews through every lens \(lens `all`\)/);
  assert.deepEqual([r.chooser, r.members.map((m) => [m.name, m.entry, m.lens, m.sole])], ['orchestrator', [['verifier', 'sol', 'all', true]]]);
  assert.equal(councilFor(config, 'testPlan', { subject: 'K-1' }).members[0].entry, 'sol', 'the stage sits the picked entry');
  const [ev] = events(config);
  assert.deepEqual([ev.event, ev.seats, ev.lenses, ev.chooser, ev.pick[0].entry], ['council.selection', 1, ['all'], 'orchestrator', 'sol']);
  // The pair UI verifier drives a browser: a Codex entry goes back; two bad picks seat the stage's own verifier.
  const ui = picker([seat('sol', 'all')]);
  const fallback = await selectCouncil(config, 'pairUiVerify', { subject: 'K-1', run: ui.run });
  assert.match(ui.tasks[1].task, /sol runs on codex, which cannot drive a browser/);
  assert.deepEqual([fallback.chooser, fallback.members.map((m) => m.entry)], ['harness', ['sonnet']]);
});

test('the pick is kept: a second round, a resume or another subtask sees the same members and lenses, and no new selection is made', async (t) => {
  const config = setup(t, { seats: { prCheck: { councilMembers: 3 } } });
  const o = picker([seat('opus', 'acceptance', 'strongest reader'), seat('sol', 'correctness', 'another family'), seat('gem', 'security', 'a third family')]);
  await selectCouncil(config, 'prCheck', { subject: 'K-1', run: o.run });
  const again = await selectCouncil(config, 'prCheck', { subject: 'K-1', run: o.run });
  assert.deepEqual([o.tasks.length, again.chooser], [1, 'kept']);
  assert.deepEqual(councilFor(config, 'prCheck', { subject: 'K-1' }).members.map((m) => [m.name, m.lens, m.blocking]), [['opus', 'acceptance', true], ['sol', 'correctness', true], ['gem', 'security', true]]);
  assert.equal(events(config).length, 1, 'exactly one council.selection event for the pick');
  const [ev] = events(config);
  for (const field of ['ts', 'event', 'stage', 'story', 'seats', 'pool', 'pick', 'lenses', 'reasons', 'scorecardVersion', 'rejected', 'chooser']) assert.ok(field in ev, field);
  assert.deepEqual(ev.pool.map((p) => [p.entry, p.family]), [['opus', 'Anthropic'], ['sonnet', 'Anthropic'], ['sol', 'OpenAI'], ['gem', 'Google']]);
  assert.deepEqual([ev.stage, ev.story, ev.reasons, ev.scorecardVersion, ev.rejected], ['prCheck', 'K-1', ['strongest reader', 'another family', 'a third family'], null, []]);
  assert.match(o.tasks[0].task, /## Pool[\s\S]*- sol: codex, gpt-6\.1-sol, family OpenAI[\s\S]*## Scorecard[\s\S]*\(empty: every model is unknown\)/);
});

// GEN-14: seats by the scorecard, the exploration seat, the shadow seat.
const row = (model, lens, stage, seats, score) => ({ model, lens, stage, seats, unknown: score === null, score });
const scorecard = (config, rows) => {
  fs.mkdirSync(path.join(config.root, '.factory/lessons'), { recursive: true });
  fs.writeFileSync(path.join(config.root, '.factory/lessons/scorecard.json'), JSON.stringify({ version: 'sc-1', rows }));
};
// The architecture review: opus and sol well sampled, sonnet less, gem never seated.
const REVIEW_ROWS = [
  row('claude-opus-5-5', 'correctness', 'architectureReview', 12, 0.5),
  row('claude-sonnet-5-5', 'security', 'architectureReview', 4, null),
  row('gpt-6.1-sol', 'correctness', 'architectureReview', 10, 0.2),
];

test('three seats and an entry with no seats in the stage: it holds the exploration seat, a pick without it goes back, and the event marks it', async (t) => {
  const config = setup(t, { seats: { architectureReview: { councilMembers: 3 } } });
  scorecard(config, REVIEW_ROWS);
  const o = picker([seat('opus', 'correctness'), seat('sol', 'security'), seat('sonnet', 'rewrite')], [seat('opus', 'correctness'), seat('sol', 'security'), seat('gem', 'rewrite')]);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.match(o.tasks[0].task, /## Exploration seat\n\nOne seat is gem's: it has the fewest seats in this stage/);
  assert.match(o.tasks[1].task, /the exploration seat is gem's \(the fewest seats in this stage\): give it a seat/);
  assert.deepEqual(r.members.map((m) => [m.entry, m.lens, Boolean(m.exploration)]), [['opus', 'correctness', false], ['sol', 'security', false], ['gem', 'rewrite', true]]);
  const [ev] = events(config);
  assert.deepEqual([ev.explorationSeat, ev.shadowSeat, ev.scorecardVersion, ev.pick.filter((p) => p.exploration).map((p) => p.entry)], ['gem', null, 'sc-1', ['gem']]);
});

test('the harness fill with the exploration seat: the least-sampled entry takes the last seat, the others go one per family by score', async (t) => {
  const config = setup(t, { seats: { architectureReview: { councilMembers: 3 } } });
  scorecard(config, REVIEW_ROWS);
  const bad = [seat('opus', 'correctness'), seat('sonnet', 'security'), seat('sol', 'rewrite')];
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: picker(bad, bad).run });
  // correctness: opus (0.5) before sol (0.2); security: the families not seated yet, OpenAI (sol); rewrite: gem.
  assert.deepEqual([r.chooser, r.members.map((m) => [m.entry, m.lens, Boolean(m.exploration)])], ['harness', [['opus', 'correctness', false], ['sol', 'security', false], ['gem', 'rewrite', true]]]);
  assert.equal(events(config)[0].explorationSeat, 'gem');
});

test('exploration off: every seat goes by the family rule and the score, and no seat is marked', async (t) => {
  const config = setup(t, { seats: { architectureReview: { councilMembers: 3 }, council: { explorationSeat: { enabled: false } } } });
  scorecard(config, [...REVIEW_ROWS, row('gemini-3-pro', 'security', 'architectureReview', 10, 0.3)]);
  const bad = [seat('opus', 'correctness'), seat('sonnet', 'security'), seat('sol', 'rewrite')];
  const o = picker(bad, bad);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.doesNotMatch(o.tasks[0].task, /Exploration seat/);
  // security: gem (0.3) before sol (no row: 0); rewrite: the family left, OpenAI. Seats in pool order.
  assert.deepEqual(r.members.map((m) => [m.entry, m.lens, Boolean(m.exploration)]), [['opus', 'correctness', false], ['sol', 'rewrite', false], ['gem', 'security', false]]);
  assert.equal(events(config)[0].explorationSeat, null);
});

test('ordering: an unknown row is neither preferred to a known good row nor ranked below a known bad one', () => {
  const entries = [
    { name: 'unknown', model: 'm-unknown' }, // first in pool order, unknown: below the good row all the same
    { name: 'bad', model: 'm-bad' },
    { name: 'none', model: 'm-none' }, // never sat: unknown too
    { name: 'good', model: 'm-good' },
  ];
  const card = { rows: [row('m-unknown', 'correctness', 'pairVerify', 6, null), row('m-bad', 'correctness', 'pairVerify', 10, -0.2), row('m-good', 'correctness', 'pairVerify', 10, 0.4)] };
  assert.deepEqual(byRank(card, 'pairVerify', 'correctness', entries).map((e) => e.name), ['good', 'unknown', 'none', 'bad']);
});

test('one seat with the shadow seat on: two members run, only the first decides, a late shadow result is feedback; off, one runs', async (t) => {
  const config = setup(t, { seats: { council: { shadowSeat: { enabled: true } } } });
  scorecard(config, [row('gpt-6.1-sol', 'all', 'architectureReview', 10, -0.5), row('gemini-3-pro', 'all', 'architectureReview', 10, 0.1)]);
  const o = picker([]);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.equal(o.tasks.length, 2, 'no readable pick twice: the harness seats the stage\'s own verifier');
  // The sole member runs on sonnet (Anthropic): the shadow is another family's best-ranked entry, gem.
  assert.deepEqual(r.members.map((m) => [m.name, m.entry, m.lens, m.blocking, Boolean(m.shadow)]), [['verifier', 'sonnet', 'all', true, false], ['gem', 'gem', 'all', false, true]]);
  const [ev] = events(config);
  assert.deepEqual([ev.seats, ev.shadowSeat, ev.pick.map((p) => [p.entry, p.blocking, Boolean(p.shadow)])], [1, 'gem', [['sonnet', true, false], ['gem', false, true]]]);
  const council = councilFor(config, 'architectureReview', { subject: 'K-1' });
  assert.deepEqual([council.members.length, council.sole, council.shadow, council.onUnavailable, council.intercom.enabled], [2, false, 'gem', 'fail', false]);
  assert.match(memberTask('t', { council, member: council.members[0], round: 1, skill: '' }), /only deciding member[\s\S]*A non-blocking member, gem, reviews it apart from you/);
  assert.match(memberTask('t', { council, member: council.members[1], round: 1, skill: '' }), /non-blocking shadow member[\s\S]*You are non-blocking: your findings are feedback and your score is not recorded/);
  // The round: the stage does not wait for the shadow; the decider's score decides; the late result is next round's feedback.
  const late = [];
  let release;
  const gate = new Promise((res) => (release = res));
  const result = (score, findings = []) => ({ status: 0, output: `AGENT_RESULT: ${JSON.stringify({ verdict: findings.length ? 'CHANGES_REQUESTED' : 'APPROVED', score, findings })}` });
  const out = await runCouncil({
    council,
    taskFor: () => 't',
    run: async (m) => (m.shadow ? (await gate, result(2, [{ severity: 'blocking', issue: 'the order total ignores the discount', file: 'src/a.js', resolves: 'code' }])) : result(10)),
    parse: (text) => JSON.parse(text.slice(text.indexOf('{'))),
    onLate: (x) => late.push(x),
    log: () => {},
  });
  assert.deepEqual(out.results.map((x) => [x.member.name, x.status]), [['verifier', 'ok'], ['gem', 'late']]);
  assert.equal(mergeCouncil(council, out.results).pass, true, 'only the sole member decides');
  release();
  await new Promise((res) => setTimeout(res, 20));
  const next = mergeCouncil(council, [out.results[0]], { feedback: late });
  assert.equal(next.pass, true, 'feedback never blocks');
  assert.match(next.notes.find((n) => n.feedback).text, /the order total ignores the discount/);

  const off = setup(t);
  const one = await selectCouncil(off, 'architectureReview', { subject: 'K-1', run: picker([]).run });
  assert.deepEqual([one.members.length, councilFor(off, 'architectureReview', { subject: 'K-1' }).members.length, events(off)[0].shadowSeat], [1, 1, null]);
});

// Council r1 (A2): the PR check's one seat (its critic panel) gets a shadow too, of another family than its critics'.
test('the PR check\'s critic panel gets a shadow seat of another family when it is on', async (t) => {
  const config = setup(t, { seats: { council: { shadowSeat: { enabled: true } } } });
  const r = await selectCouncil(config, 'prCheck', { subject: 'K-1', run: picker([]).run });
  assert.deepEqual(r.members.map((m) => [m.name, m.entry, m.blocking, Boolean(m.shadow)]), [['verifier', null, true, false], ['sol', 'sol', false, true]]);
  const council = councilFor(config, 'prCheck', { subject: 'K-1' });
  assert.deepEqual([council.sole, council.shadow], [false, 'sol']);
});

// Council r1 (sol-09): seat names are unique across a sitting, even when an entry is named like a repeat.
test('an entry named a-2 beside a repeated entry a: the seats are a, a-2 and a-3, never two a-2', async (t) => {
  const pool = [{ name: 'a', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { name: 'a-2', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' }];
  const config = setup(t, { pool, seats: { architectureReview: { councilMembers: 3 }, orchestrator: { model: 'a' } } });
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: picker([seat('a', 'correctness'), seat('a-2', 'security'), seat('a', 'rewrite')]).run });
  assert.deepEqual([r.chooser, r.members.map((m) => [m.name, m.entry])], ['orchestrator', [['a', 'a'], ['a-2', 'a-2'], ['a-3', 'a']]]);
  // The fill, which repeats a before seating a-2: still each entry under its own name first.
  const { seatNames } = await import('../lib/council.mjs');
  assert.deepEqual(seatNames(['a', 'a', 'a-2']), ['a', 'a-3', 'a-2']);
});

// Council r1 (sol-10): seats and lenses are fitted together; no family or entry repeats while another is free.
test('six families, six pair UI seats, one entry that drives a browser: one ui seat, every family once, and the fill passes the rules', () => {
  const pool = ['m1', 'm2', 'm3', 'm4', 'm5'].map((m) => ({ name: m, cli: 'codex', model: m, effort: 'high' })).concat({ name: 'web', cli: 'claude', model: 'm6', effort: 'high' });
  const pick = harnessPick('pairUiVerify', pool, 6);
  assert.deepEqual(pick.filter((p) => p.lens === 'ui').map((p) => p.entry), ['web']);
  assert.equal(new Set(pick.map((p) => p.entry)).size, 6, 'six entries, each family once');
  assert.deepEqual(pickProblems({ stage: 'pairUiVerify', count: 6, pool, pick }), []);
  // The exploration entry is the browser entry: it takes the ui seat, and is not seated twice.
  const explored = harnessPick('pairUiVerify', pool, 6, { explore: pool[5] });
  assert.deepEqual([explored.filter((p) => p.entry === 'web').map((p) => p.lens), new Set(explored.map((p) => p.entry)).size], [['ui'], 6]);
  // A pick that repeats an entry while another entry of the pool has no seat is refused, even with every family seated.
  const three = [POOL[0], POOL[1], POOL[2]];
  assert.match(pickProblems({ stage: 'architectureReview', count: 3, pool: three, pick: [seat('opus', 'correctness'), seat('sol', 'security'), seat('opus', 'rewrite')] }).join(), /opus sit twice while sonnet has no seat: seat every entry once first/);
});

// Council r2 (sol-10): two browser entries of one family could take both ui seats and leave a family out.
test('six pair UI seats, two browser entries of one family and five other families: one ui seat, every family seated, no fill problem', async (t) => {
  const pool = [{ name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, ...['m1', 'm2', 'm3', 'm4', 'm5'].map((m) => ({ name: m, cli: 'codex', model: m, effort: 'high' }))];
  const config = setup(t, { pool, seats: { implement: { councilMembers: 6 }, orchestrator: { model: 'opus' } } });
  const r = await selectCouncil(config, 'pairUiVerify', { subject: 'K-1', run: picker([]).run });
  const families = r.members.map((m) => (m.entry === 'opus' || m.entry === 'sonnet' ? 'Anthropic' : m.entry));
  assert.deepEqual([r.chooser, r.members.filter((m) => m.lens === 'ui').length, new Set(families).size], ['harness', 1, 6]);
  assert.equal(events(config)[0].fillProblems, undefined);
});

// Council r2 (sol-18): with exploration on and two or more seats, one seat is always reserved, ties included.
test('exploration on with an empty scorecard: the last of the equally sampled entries holds the exploration seat', async (t) => {
  const config = setup(t, { pool: [POOL[0], POOL[1], POOL[2]], seats: { architectureReview: { councilMembers: 3 } } });
  const o = picker([seat('opus', 'correctness'), seat('sol', 'security'), seat('sonnet', 'rewrite')]);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-1', run: o.run });
  assert.match(o.tasks[0].task, /## Exploration seat\n\nOne seat is sol's/);
  assert.deepEqual([events(config)[0].explorationSeat, r.members.find((m) => m.exploration)?.entry], ['sol', 'sol']);
});

// Council r3 (sol-10): the fill searches seats and lenses together, so the reserved exploration entry and the ui lens
// land together when that is the only valid council.
test('two pair UI seats, pool Opus, Sol, Sonnet with Sonnet reserved for exploration: Sonnet takes ui, Sol correctness', async (t) => {
  const pool = [POOL[0], POOL[2], POOL[1]];
  const config = setup(t, { pool, seats: { implement: { councilMembers: 2 } } });
  const r = await selectCouncil(config, 'pairUiVerify', { subject: 'K-1', run: picker([]).run });
  assert.deepEqual([r.chooser, r.members.map((m) => [m.entry, m.lens, Boolean(m.exploration)]).sort()], ['harness', [['sol', 'correctness', false], ['sonnet', 'ui', true]]]);
  assert.equal(events(config)[0].fillProblems, undefined);
  // Whatever the pool order and reserved entry, the fill passes the rules whenever some council does.
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2]]) {
    const p = order.map((i) => pool[i]);
    for (const explore of [null, ...p]) assert.deepEqual(pickProblems({ stage: 'pairUiVerify', count: 2, pool: p, pick: harnessPick('pairUiVerify', p, 2, { explore }), explore }), [], `${order} ${explore?.name}`);
  }
});

// Council r4 (sol-10): the fill's work is bounded (seats times pool), and it still finds a valid council whenever one
// exists. The exhaustive search below is the oracle, on pools small enough to enumerate.
test('the harness fill is quick at 30 families and 10 seats, and valid whenever some council is (exhaustive check on small pools)', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ name: `m${i}`, cli: i % 3 ? 'codex' : 'claude', model: `family-${i}`, effort: 'high' }));
  const t0 = Date.now();
  const pick = harnessPick('architectureReview', big, 10, { explore: big[29] });
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.deepEqual(pickProblems({ stage: 'architectureReview', count: 10, pool: big, pick, explore: big[29] }), []);
  assert.deepEqual(pickProblems({ stage: 'pairUiVerify', count: 10, pool: big, pick: harnessPick('pairUiVerify', big, 10), explore: null }), []);
  // Small pools: every subset of entries and lenses, as the oracle of whether a valid council exists.
  const subsets = (items, k, from = 0) => (k === 0 ? [[]] : items.slice(from).flatMap((x, i) => subsets(items, k - 1, from + i + 1).map((c) => [x, ...c])));
  const multisets = (items, k, from = 0) => (k === 0 ? [[]] : items.slice(from).flatMap((x, i) => multisets(items, k - 1, from + i).map((c) => [x, ...c])));
  const spread = (items, k) => (k <= items.length ? subsets(items, k) : multisets(items, k - items.length).map((extra) => [...items, ...extra]));
  const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const lensesOf = { pairUiVerify: ['ui', 'correctness', 'acceptance', 'security', 'rewrite'], architectureReview: ['correctness', 'security', 'rewrite', 'acceptance', 'test-value'], prCheck: ['acceptance', 'correctness', 'security', 'rewrite', 'test-value'] };
  const someValid = (stage, pool, count, explore) => spread(pool, count).some((entries) => spread(lensesOf[stage], count).some((lenses) => permutations(lenses).some((ls) => !pickProblems({ stage, count, pool, pick: entries.map((e, i) => ({ entry: e.name, lens: ls[i] })), explore }).length)));
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  let checked = 0;
  for (let trial = 0; trial < 400; trial++) {
    const size = 2 + rand(3);
    const pool = Array.from({ length: size }, (_, i) => ({ name: `e${i}`, cli: rand(2) ? 'codex' : 'claude', model: `fam-${rand(3)}-${i % 2 ? 'x' : 'y'}`, effort: 'high' }));
    for (const f of pool) f.model = `family-${rand(3)}`;
    const stage = ['pairUiVerify', 'architectureReview', 'prCheck'][rand(3)];
    const count = 2 + rand(2);
    const explore = rand(2) ? pool[rand(size)] : null;
    // Council r5 (sol-10): ranked entries too, so the first list can be far from a valid one.
    const scorecard = { rows: pool.map((e) => ({ model: e.model, stage, lens: 'correctness', seats: 12, score: rand(10) / 10 })) };
    if (!someValid(stage, pool, count, explore)) continue;
    checked++;
    const fill = harnessPick(stage, pool, count, { explore, scorecard });
    assert.deepEqual(pickProblems({ stage, count, pool, pick: fill, explore }), [], JSON.stringify({ stage, count, explore: explore?.name, pool, fill }));
  }
  assert.ok(checked > 150, `${checked} pools with a valid council`);
});

// Council r4 (sol-27): one pair UI seat; the orchestrator twice picks a Codex entry, and the stage's own verifier runs on
// Codex too: the fallback seats an entry that can drive a browser.
test('one pair UI seat: when the picks and the stage\'s own entry cannot drive a browser, the fallback seats one that can', async (t) => {
  const config = setup(t, { pool: [POOL[2], POOL[0]], seats: { implement: { councilMembers: 1 } } });
  config.models.agents = { default: 'sol' };
  const o = picker([seat('sol', 'all')], [seat('sol', 'all')]);
  const r = await selectCouncil(config, 'pairUiVerify', { subject: 'K-1', run: o.run });
  assert.deepEqual([r.chooser, r.members.map((m) => m.entry)], ['harness', ['opus']]);
  assert.equal(events(config)[0].fillProblems, undefined);
});

// Council r4 (sol-10): the fill seats each family's best-ranked entry, not merely the first of the pool.
test('the harness fill seats each family\'s best-ranked entry', () => {
  // a2 first in the pool, a1 ranked higher (council r5, T14: with a1 first, pool order alone gave the same seats).
  const pool = [{ name: 'a2', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, { name: 'a1', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { name: 'b', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { name: 'c', cli: 'copilot', model: 'gemini-3-pro', effort: 'high' }];
  const card = { rows: [{ model: 'claude-opus-5-5', stage: 'architectureReview', lens: 'correctness', seats: 12, score: 0.5 }, { model: 'claude-sonnet-5-5', stage: 'architectureReview', lens: 'correctness', seats: 12, score: 0.1 }] };
  assert.deepEqual(harnessPick('architectureReview', pool, 3, { scorecard: card }).map((p) => p.entry), ['a1', 'b', 'c']);
});

// Council r5 (sol-10): sol's case needs two swaps from the first list: two pair UI seats; Codex a and b ranked first,
// Claude opus third, the unsampled Codex `least` reserved for exploration. opus/ui + least/correctness is valid.
test('sol r5: the fill repairs in steps, seating the exploration entry and a browser entry together', () => {
  const pool = [{ name: 'a', cli: 'codex', model: 'family-a', effort: 'high' }, { name: 'b', cli: 'codex', model: 'family-b', effort: 'high' }, { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { name: 'least', cli: 'codex', model: 'family-least', effort: 'high' }];
  const row = (model, score) => ({ model, stage: 'pairUiVerify', lens: 'correctness', seats: 12, score });
  const scorecard = { rows: [row('family-a', 0.9), row('family-b', 0.8), row('claude-opus-5-5', 0.2)] };
  const pick = harnessPick('pairUiVerify', pool, 2, { scorecard, explore: pool[3] });
  assert.deepEqual(pickProblems({ stage: 'pairUiVerify', count: 2, pool, pick, explore: pool[3] }), []);
  assert.deepEqual(pick.map((p) => [p.entry, p.lens]).sort(), [['least', 'correctness'], ['opus', 'ui']]);
});

// Council r5 (sol-30): with PIPELINE_AGENT_CLI=codex and the shipped pool, every run moves onto Codex, which cannot drive a
// browser: the pair UI council fails selection saying so, and any other council is picked among the Codex entries.
test('sol r5: PIPELINE_AGENT_CLI=codex: the council is picked among the entries that will run; a pair UI council with none that can drive a browser fails clearly', async (t) => {
  const { defaultSettings } = await import('../lib/settings.mjs');
  const config = setup(t, { pool: defaultSettings().models.pool, seats: { implement: { councilMembers: 2 }, architectureReview: { councilMembers: 2 } } });
  const env = { ...process.env, PIPELINE_AGENT_CLI: 'codex' };
  await assert.rejects(selectCouncil(config, 'pairUiVerify', { subject: 'K-1', run: picker([]).run, env }), /PIPELINE_AGENT_CLI is codex: no models\.pool entry on it can drive a browser, and the pairUiVerify council drives the app/);
  const r = await selectCouncil(config, 'architectureReview', { subject: 'K-2', run: picker([]).run, env });
  assert.deepEqual([...new Set(r.members.map((m) => m.entry))], ['sol']);
  assert.deepEqual([...new Set(events(config).at(-1).pick.map((p) => p.family))], ['OpenAI']);
});
