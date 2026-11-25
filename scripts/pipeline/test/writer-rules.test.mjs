// GEN-27: the retro decides from the traces, by arithmetic, which clean-code rules the writing agents carry: add when a
// rule's upheld breaches cost more than carrying it, remove on probation when it has none, put back a rule whose breaches
// return, remove the lowest-value rule when added rules lowered the first-round pass rate, at most a few changes a retro,
// never SCOPE and never a business rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentDefinition, agentsWithCleanCode, buildPrompt } from '../lib/agents.mjs';
import { writerRuleIds, writerRulesPath } from '../lib/clean-code.mjs';
import { loadConfig } from '../lib/config.mjs';
import { ledgerDoc, ledgerNumbers, ledgerRows, ledgerSection, planWriterRules, readLedger, writeWriterRules } from '../lib/writer-rules.mjs';

const RETRO = fileURLToPath(new URL('../../retro/retro.mjs', import.meta.url));

function setup(t, { writerRules = {}, file = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-rules-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const config = { root, mainRoot: root, lessonsDir: '.factory/lessons', stateDir: '.factory/state', metricsDir: '.factory/metrics', retro: { writerRules: { minSamples: 10, maxChangesPerRetro: 2, ...writerRules } } };
  if (file) {
    fs.mkdirSync(path.join(root, '.factory/lessons'), { recursive: true });
    fs.writeFileSync(writerRulesPath(config), JSON.stringify(file));
  }
  return config;
}

// Traces of `n` first-round pair-verifier sittings, the set the writers carried, the upheld clean-code findings (rule
// per sitting index) and writer runs: a first run per sitting (cheap per prompt token) and a fix run per breach.
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 10, 1) + (clock += 1000)).toISOString();
function traces({ n = 12, carried = ['SCOPE', 'CC-1', 'CC-2'], breaches = {}, fixCost = 0.5, prefix = 'S' } = {}) {
  const rounds = [];
  const findings = [];
  const usage = [];
  for (let i = 1; i <= n; i++) {
    const story = `${prefix}-${i}`;
    rounds.push({ ts: ts(), story, stage: 'pairVerify', step: 'api', round: 1, pass: true, writerRules: carried, members: [{ name: 'verifier' }, { name: 'clean-code', fixed: true, status: 'ok' }] });
    usage.push({ ts: ts(), run_id: `${story}-w1`, story, stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 100000 } });
  }
  let k = 0;
  for (const [rule, sittings] of Object.entries(breaches)) {
    for (const i of sittings) {
      const story = `${prefix}-${i}`;
      const finding = `F-${rule}-${i}`;
      findings.push({ ts: ts(), kind: 'finding', story, stage: 'pairVerify', step: 'api', round: 1, finding, lens: 'clean-code', rule, seat: 'clean-code' });
      findings.push({ ts: ts(), kind: 'outcome', story, stage: 'pairVerify', step: 'api', round: 1, finding, outcome: 'led-to-change' });
      usage.push({ ts: ts(), run_id: `${story}-fix-${k++}`, story, stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 2, cost_usd: fixCost, seconds: 120, tokens: { input: 100000 } });
    }
  }
  return { rounds, findings, usage };
}
const plan = (config, records) => planWriterRules(config, records, readLedger(config));

test('a rule outside the set whose upheld breaches cost more than carrying it is added, with both costs on the record; the next writer task carries it', (t) => {
  const config = setup(t);
  // The carried rules are breached too, so none of them is removed.
  const records = traces({ breaches: { 'CC-7': [1, 2, 3], 'CC-1': [4], 'CC-2': [5] } });
  const { plan: p, doc } = writeWriterRules(config, config.root, records);
  assert.deepEqual(p.changes.map((c) => [c.action, c.rule]), [['add', 'CC-7']]);
  const c = p.changes[0];
  assert.equal(c.numbers.breachCost, 1.5, 'three upheld breaches times a fix run');
  assert.ok(c.numbers.carryCost > 0 && c.numbers.carryCost < c.numbers.breachCost, JSON.stringify(c.numbers));
  assert.deepEqual(doc.rules, ['SCOPE', 'CC-1', 'CC-2', 'CC-7']);
  const rows = ledgerRows(p);
  assert.deepEqual([rows[0].event, rows[0].action, rows[0].rule, rows[0].window], ['writer-rules.change', 'add', 'CC-7', 1]);
  assert.ok('breachCost' in rows[0].numbers && 'carryCost' in rows[0].numbers);
  assert.match(ledgerSection(p), /- add CC-7: its upheld breaches cost 1\.5 USD \(3 x a fix run\) over a carry cost of [\d.e-]+ USD\.[\s\S]*The writers now carry: SCOPE, CC-1, CC-2, CC-7\./);
  // GEN-15 AC7: the next writer task carries the new set, with no change to any agent definition.
  const def = agentDefinition({ ...loadConfig('implement', config.root), lessonsDir: '.factory/lessons' }, 'pair-implementer');
  assert.match(buildPrompt(def, 'x'), /### CC-7 No flag that switches behaviour/);
});

test('the same numbers with fewer sittings than retro.writerRules.minSamples change nothing, and the report says the evidence is insufficient', (t) => {
  const config = setup(t);
  const { plan: p, doc } = writeWriterRules(config, config.root, traces({ n: 5, breaches: { 'CC-7': [1, 2, 3] } }));
  assert.deepEqual([p.insufficient, p.changes, doc.rules, doc.window], [true, [], ['SCOPE', 'CC-1', 'CC-2'], 0]);
  assert.equal(fs.existsSync(writerRulesPath(config)), false, 'nothing decided: no set file is created');
  assert.match(ledgerSection(p), /No change: the evidence is insufficient \(5 first-round sittings on writers' work in window 1, fewer than 10\)/);
});

test('a carried rule with no upheld breach is removed on probation; back above its carry cost next window, it is restored and locked for two windows', (t) => {
  const config = setup(t);
  const first = writeWriterRules(config, config.root, traces({ breaches: { 'CC-1': [1, 2] } }));
  assert.deepEqual(first.plan.changes.map((c) => [c.action, c.rule, Boolean(c.probation)]), [['remove', 'CC-2', true]]);
  assert.deepEqual([first.doc.rules, first.doc.probation], [['SCOPE', 'CC-1'], { 'CC-2': 1 }]);
  // The trial window: its breaches return above its carry cost.
  const second = writeWriterRules(config, config.root, traces({ carried: ['SCOPE', 'CC-1'], breaches: { 'CC-1': [1], 'CC-2': [2, 3] } }));
  assert.deepEqual(second.plan.changes.map((c) => [c.action, c.rule, c.lockedUntil]), [['restore', 'CC-2', 4]]);
  assert.deepEqual([second.doc.rules, second.doc.probation, second.doc.locked], [['SCOPE', 'CC-1', 'CC-2'], {}, { 'CC-2': 4 }]);
  // Locked: with no breach in the next window it stays (CC-1 too: it was breached).
  const third = writeWriterRules(config, config.root, traces({ carried: ['SCOPE', 'CC-1', 'CC-2'], breaches: { 'CC-1': [1] } }));
  assert.ok(!third.plan.changes.some((c) => c.rule === 'CC-2'), JSON.stringify(third.plan.changes));
  assert.ok(third.doc.rules.includes('CC-2'));
});

test('a rule on probation whose breaches stay below its carry cost stays out once the trial window ends', (t) => {
  const config = setup(t, { file: { rules: ['SCOPE', 'CC-1'], window: 1, windowEnd: null, probation: { 'CC-2': 1 }, locked: {} } });
  const p = plan(config, traces({ carried: ['SCOPE', 'CC-1'], breaches: { 'CC-1': [1] } }));
  assert.deepEqual([p.changes, p.probationEnded], [[], ['CC-2']]);
  assert.deepEqual(ledgerDoc(readLedger(config), p).probation, {});
});

test('the first-round pass rate fell after rules were added: the rule with the lowest net value goes first', (t) => {
  const config = setup(t, { file: { rules: ['SCOPE', 'CC-1', 'CC-2', 'CC-7'], window: 3, windowEnd: null, probation: {}, locked: {}, lastChange: { window: 3, action: 'add', rules: ['CC-7'], passRate: 0.9 } } });
  // Every carried rule is breached (no probation removal), and half the first rounds fail now.
  const p = plan(config, traces({ carried: ['SCOPE', 'CC-1', 'CC-2', 'CC-7'], breaches: { 'CC-1': [1, 2, 3, 4], 'CC-2': [5, 6], 'CC-7': [7] } }));
  assert.equal(p.numbers.passRate, 0.416667, '5 of 12 first rounds passed');
  assert.deepEqual(p.changes.map((c) => [c.action, c.rule, Boolean(c.density)]), [['remove', 'CC-7', true]], JSON.stringify(p.changes.map((c) => [c.rule, c.numbers.net])));
});

test('more qualifying changes than retro.writerRules.maxChangesPerRetro: only that many, the largest net value first; the rest are deferred', (t) => {
  const config = setup(t, { writerRules: { maxChangesPerRetro: 2 } });
  const p = plan(config, traces({ breaches: { 'CC-1': [1], 'CC-2': [2], 'CC-5': [1, 2], 'CC-7': [3, 4, 5], 'CC-9': [6] } }));
  assert.deepEqual(p.changes.map((c) => [c.action, c.rule]), [['add', 'CC-7'], ['add', 'CC-5']]);
  assert.deepEqual(p.deferred.map((c) => [c.action, c.rule]), [['add', 'CC-9']]);
  assert.match(ledgerSection(p), /Deferred[\s\S]*- add CC-9/);
});

test('SCOPE stays in the writer set whatever the traces say', (t) => {
  const config = setup(t, { writerRules: { maxChangesPerRetro: 10 } });
  const { doc, plan: p } = writeWriterRules(config, config.root, traces({ breaches: {} }));
  assert.ok(!p.numbers.rules.some((r) => r.rule === 'SCOPE'), 'never weighed');
  assert.deepEqual(doc.rules, ['SCOPE'], 'both CC rules had no breach: removed on probation; SCOPE stays');
  assert.deepEqual(writerRuleIds(config), ['SCOPE']);
});

test('the same traces give the same decisions and the same file', (t) => {
  const a = setup(t);
  const b = setup(t);
  const records = traces({ breaches: { 'CC-7': [1, 2, 3], 'CC-1': [4] } });
  const one = writeWriterRules(a, a.root, records);
  const two = writeWriterRules(b, b.root, records);
  assert.deepEqual(one.plan.changes, two.plan.changes);
  assert.equal(fs.readFileSync(writerRulesPath(a), 'utf8'), fs.readFileSync(writerRulesPath(b), 'utf8'));
});

test('business rules are never touched: rules/ stays as it is and the writer set holds clean-code rule ids only', (t) => {
  const config = setup(t);
  fs.mkdirSync(path.join(config.root, 'rules'), { recursive: true });
  const businessRule = '# RULE-1: an expired coupon is rejected\n\nApproved by the owner.\n';
  fs.writeFileSync(path.join(config.root, 'rules/RULE-1.md'), businessRule);
  const records = traces({ breaches: { 'CC-7': [1, 2, 3] } });
  // A finding on another lens citing a business rule is not a clean-code finding.
  records.findings.push({ ts: ts(), kind: 'finding', story: 'S-1', stage: 'pairVerify', step: 'api', round: 1, finding: 'B1', lens: 'acceptance', rule: 'RULE-1' }, { ts: ts(), kind: 'outcome', story: 'S-1', stage: 'pairVerify', step: 'api', round: 1, finding: 'B1', outcome: 'led-to-change' });
  const { doc } = writeWriterRules(config, config.root, records);
  assert.equal(fs.readFileSync(path.join(config.root, 'rules/RULE-1.md'), 'utf8'), businessRule);
  assert.ok(doc.rules.every((r) => /^(CC-\d+|SCOPE)$/.test(r)), doc.rules.join(', '));
  assert.ok(![...doc.rules, ...Object.keys(doc.probation), ...Object.keys(doc.locked)].some((r) => r.startsWith('RULE')));
});

// Council r1 (sol-04): the density step picks the lowest net value among every carried rule, a zero-breach one too, and
// takes precedence under the change cap; a restored rule is protected for two whole windows.
test('sol-04: density removes the lowest-net carried rule first under the cap, even one with no breach', (t) => {
  const config = setup(t, { writerRules: { maxChangesPerRetro: 1 }, file: { rules: ['SCOPE', 'CC-1', 'CC-2', 'CC-7'], window: 1, windowEnd: null, probation: {}, locked: {}, lastChange: { window: 1, action: 'add', rules: ['CC-7'], passRate: 1 } } });
  // CC-1 is breached often, CC-7 once, CC-2 never (its net value is its carry cost, negative: the lowest).
  const p = plan(config, traces({ carried: ['SCOPE', 'CC-1', 'CC-2', 'CC-7'], breaches: { 'CC-1': [1, 2, 3, 4], 'CC-7': [5] } }));
  const net = Object.fromEntries(p.numbers.rules.map((r) => [r.rule, r.net]));
  assert.ok(net['CC-2'] < net['CC-7'] && net['CC-7'] < net['CC-1'], JSON.stringify(net));
  assert.deepEqual(p.changes.map((c) => [c.action, c.rule, Boolean(c.density)]), [['remove', 'CC-2', true]]);
  assert.ok(!p.deferred.some((c) => c.rule === 'CC-2'), 'never also deferred as a plain removal');
});

// Council r2 (TV-6): the member's probe. Under a cap of one change, the density removal and an outside rule's add both
// qualify; the density removal goes first and the add waits.
test('TV-6: under the change cap the density removal goes before a competing add', (t) => {
  const config = setup(t, { writerRules: { maxChangesPerRetro: 1 }, file: { rules: ['SCOPE', 'CC-1', 'CC-2', 'CC-7'], window: 3, windowEnd: null, probation: {}, locked: {}, lastChange: { window: 3, action: 'add', rules: ['CC-7'], passRate: 0.9 } } });
  const p = plan(config, traces({ carried: ['SCOPE', 'CC-1', 'CC-2', 'CC-7'], breaches: { 'CC-1': [1, 2, 3, 4], 'CC-2': [5, 6], 'CC-7': [7], 'CC-9': [8, 9, 10, 11, 12] } }));
  const add = p.numbers.rules.find((r) => r.rule === 'CC-9');
  assert.ok(add.breachCost > add.carryCost, 'CC-9 qualifies for an add on its own');
  assert.deepEqual(p.changes.map((c) => [c.action, c.rule, Boolean(c.density)]), [['remove', 'CC-7', true]]);
  assert.deepEqual(p.deferred.map((c) => [c.action, c.rule, Boolean(c.density)]), [['add', 'CC-9', false]]);
});

// Council r2 (TV-7): the member's probe. writerRuleRecords reads the whole metrics history, so the ledger's windowEnd is
// what ages evidence out: window 1 breached CC-2, window 2 did not. Window 2's retro counts only its own sittings and
// removes CC-2; the old breach does not keep it forever.
test('TV-7: records up to the ledger\'s windowEnd are not counted again: samples, breaches and runs are the new window\'s', (t) => {
  const carried = ['SCOPE', 'CC-1', 'CC-2'];
  const one = traces({ carried, breaches: { 'CC-1': [1], 'CC-2': [2, 3] }, prefix: 'W1' });
  const windowEnd = [...one.rounds, ...one.findings, ...one.usage].map((r) => r.ts).sort().at(-1);
  const two = traces({ carried, breaches: { 'CC-1': [1] }, prefix: 'W2' });
  const config = setup(t, { file: { rules: carried, window: 1, windowEnd, probation: {}, locked: {} } });
  const both = { rounds: [...one.rounds, ...two.rounds], findings: [...one.findings, ...two.findings], usage: [...one.usage, ...two.usage] };
  const p = plan(config, both);
  const cc2 = p.numbers.rules.find((r) => r.rule === 'CC-2');
  assert.deepEqual([p.samples, cc2.breaches, cc2.writerRuns], [12, 0, 13], 'window 2: 12 sittings, 12 first runs and one fix run');
  assert.deepEqual(p.changes.map((c) => [c.action, c.rule]), [['remove', 'CC-2']]);
  assert.ok(p.numbers.windowEnd > windowEnd, 'the window moves on to the last record read');
  // The same records with no window read: window 1 counts too, and CC-2 stays.
  const fresh = setup(t, { file: { rules: carried, window: 0, windowEnd: null, probation: {}, locked: {} } });
  assert.deepEqual(plan(fresh, both).changes.map((c) => [c.action, c.rule]), []);
});

test('sol-04: a rule restored in window 2 (locked until 4) is not removed in windows 3 and 4, and can be in window 5', (t) => {
  const base = { rules: ['SCOPE', 'CC-1', 'CC-2'], windowEnd: null, probation: {}, locked: { 'CC-2': 4 } };
  const quiet = () => traces({ carried: ['SCOPE', 'CC-1', 'CC-2'], breaches: { 'CC-1': [1] } });
  for (const [window, removed] of [[2, false], [3, false], [4, true]]) {
    const config = setup(t, { file: { ...base, window } });
    assert.equal(plan(config, quiet()).changes.some((c) => c.rule === 'CC-2' && c.action === 'remove'), removed, `window ${window + 1}`);
  }
});

// Council r1 (cc-3): the writers are read from the definitions' `clean-code: writer`, not from a second list.
test('cc-3: an agent whose definition says `clean-code: writer` counts as a writer, with no list to update', (t) => {
  const config = setup(t);
  const usage = [{ ts: ts(), run_id: 'c1', agent: 'ci-fixer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 1000 } }];
  const writerRuns = () => ledgerNumbers(config, { usage }).rules[0].writerRuns;
  assert.equal(writerRuns(), 0, 'no ci-fixer definition yet');
  fs.mkdirSync(path.join(config.root, 'agents'));
  fs.writeFileSync(path.join(config.root, 'agents/ci-fixer.agent.md'), '---\nname: ci-fixer\nclean-code: writer\n---\n\n# CI fixer\n');
  assert.equal(writerRuns(), 1);
  assert.deepEqual(agentsWithCleanCode(config, 'writer'), ['ci-fixer', 'implementer', 'pair-implementer', 'pr-check-fixer', 'test-automation']);
});

// Council r1 (TV-3): the retro's own wiring (retro/lib/lessons.mjs), as scorecard.test.mjs runs it: over real metrics
// files, the retro writes the rule set file, appends the change to writer-rules.jsonl, and puts the section in its
// commit and in the PR body, all on its branch.
// Council r2 (F10): the same with the metrics spooled (a checkout's default): the rows still go into the retro's commit.
test('TV-3: a retro run writes the rule set, logs the change and puts the section in the commit and the PR body, spooled or not', (t) => {
  for (const spool of ['0', '1']) retroWriterRun(t, spool);
});

function retroWriterRun(t, spool) {
  const config = setup(t);
  const { rounds, findings, usage } = traces({ breaches: { 'CC-7': [1, 2, 3], 'CC-1': [4], 'CC-2': [5] } });
  const write = (stream, rows) => {
    fs.mkdirSync(path.join(config.root, config.metricsDir), { recursive: true });
    fs.writeFileSync(path.join(config.root, config.metricsDir, stream), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  };
  write('council-rounds.jsonl', rounds);
  write('council-findings.jsonl', findings);
  write('token-usage.jsonl', usage);
  const pool = [{ name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }];
  fs.writeFileSync(path.join(config.root, '.factory/config.json'), JSON.stringify({ models: { pool } }));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: config.root, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-qm', 'init');
  const env = { ...process.env, PIPELINE_LESSONS: 'on', FACTORY_SINK: 'none', FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: spool, PIPELINE_ROOT: '' };
  delete env.PIPELINE_CHILD;
  const r = spawnSync(process.execPath, [RETRO, 'run', '--no-push'], { cwd: config.root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const { status, branch } = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(status, 'committed');
  const show = (file) => git('show', `${branch}:${file}`).stdout;
  assert.ok(show('.factory/metrics/writer-rules.jsonl'), `spool ${spool}: the log rows are in the commit`);
  assert.deepEqual(JSON.parse(show('.factory/lessons/clean-code-writers.json')).rules, ['SCOPE', 'CC-1', 'CC-2', 'CC-7']);
  assert.deepEqual(show('.factory/metrics/writer-rules.jsonl').trim().split('\n').map((l) => JSON.parse(l)).map((x) => [x.event, x.action, x.rule]), [['writer-rules.change', 'add', 'CC-7']]);
  const section = /### Writer clean-code rules[\s\S]*- add CC-7: its upheld breaches cost 1\.5 USD[\s\S]*The writers now carry: SCOPE, CC-1, CC-2, CC-7\./;
  assert.match(git('log', '-1', '--format=%B', branch).stdout, section, 'the commit message');
  const run = JSON.parse(fs.readFileSync(path.join(config.root, '.factory/state/lessons-run.json'), 'utf8'));
  assert.match(run.body, section, 'the PR body');
}

// Council r2 (sol-11): the member's three probes. The ledger learns only from observed sittings, counts a finding raised
// before the window's start and upheld after it once, and charges a breach the run that fixed it.
test('sol-11: a breach across the window start counts once; unobserved rounds are no samples; a breach costs its own fix', (t) => {
  const at = (hhmm, s = 0) => `2026-11-20T${hhmm}:${String(s).padStart(2, '0')}.000Z`;
  const observed = (i, rules = ['SCOPE', 'CC-1', 'CC-2']) => ({ ts: at('11:10', i), story: `A-${i}`, stage: 'pairVerify', step: 'api', round: 1, pass: true, writerRules: rules, members: [{ name: 'verifier' }, { name: 'clean-code', fixed: true, status: 'ok' }] });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at('11:20', i), run_id: `w-${i}`, story: `A-${i}`, stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 100000 } }));
  const breach = (rule, story, ts, outcomeTs) => [
    { ts, kind: 'finding', story, stage: 'pairVerify', step: 'api', round: 1, finding: `F-${rule}`, lens: 'clean-code', rule, seat: 'clean-code' },
    { ts: outcomeTs, kind: 'outcome', story, stage: 'pairVerify', step: 'api', round: 1, finding: `F-${rule}`, outcome: 'led-to-change' },
  ];
  // 1. CC-1 raised at 10:59, before the window that starts at 11:00, and upheld at 11:02: its $3 fix counts here, once.
  const cut = setup(t, { file: { rules: ['SCOPE', 'CC-1', 'CC-2'], window: 1, windowEnd: at('11:00'), probation: {}, locked: {} } });
  const across = { rounds: Array.from({ length: 10 }, (_, i) => observed(i)), findings: breach('CC-1', 'A-0', at('10:59'), at('11:02')), usage: [...firstRuns, { ts: at('11:30'), run_id: 'fix-0', story: 'A-0', stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 2, cost_usd: 3, seconds: 90, tokens: { input: 100000 } }] };
  const p1 = plan(cut, across);
  assert.equal(p1.numbers.rules.find((r) => r.rule === 'CC-1').breaches, 1);
  assert.ok(!p1.changes.some((c) => c.rule === 'CC-1'), 'CC-1 is not removed as if unbreached');
  // 2. Ten legacy round-one records with no rule set and no clean-code seat: not samples; nothing changes.
  const legacy = setup(t);
  const p2 = plan(legacy, { rounds: Array.from({ length: 10 }, (_, i) => ({ ts: at('11:10', i), story: `L-${i}`, stage: 'pairVerify', step: 'api', round: 1, pass: true })), findings: [], usage: [] });
  assert.deepEqual([p2.samples, p2.insufficient, p2.changes.length], [0, true, 0]);
  // 3. CC-7's fix on A-0 cost $0.001 and 1 second; an unrelated fix on A-9 cost $5. CC-7 is charged its own fix only,
  // which costs less than carrying it: it is not added.
  const own = setup(t);
  const p3 = plan(own, { rounds: Array.from({ length: 10 }, (_, i) => observed(i)), findings: breach('CC-7', 'A-0', at('11:11'), at('11:12')), usage: [...firstRuns, { ts: at('11:40'), run_id: 'fix-a0', story: 'A-0', stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 2, cost_usd: 0.001, seconds: 1, tokens: { input: 1000 } }, { ts: at('11:41'), run_id: 'fix-a9', story: 'A-9', stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 2, cost_usd: 5, seconds: 99, tokens: { input: 1000 } }] });
  const cc7 = p3.numbers.rules.find((r) => r.rule === 'CC-7');
  assert.deepEqual([cc7.breaches, cc7.breachCost, cc7.breachSeconds], [1, 0.001, 1]);
  assert.ok(cc7.carryCost > cc7.breachCost, JSON.stringify(cc7));
  assert.ok(!p3.changes.some((c) => c.rule === 'CC-7'), 'not added on an unrelated run\'s cost');
});

// Council r3 (sol-11): the member's two traces, shaped like the producers. The PR check's fixer runs in the same check
// and round as the ruling it fixes; a fix in another check of the same ticket is not this breach's. A PR check round
// whose clean-code critic failed judged nothing: not a sample.
test('sol-11 r3: a PR check breach is charged its own check\'s fix; a failed clean-code seat is no sample', (t) => {
  const at = (mm, s = 0) => `2026-11-24T12:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const prRound = (i, status = 'ok') => ({ ts: at(10, i), story: `P-${i}`, stage: 'prCheck', check: `chk-${i}`, round: 1, pass: true, writerRules: ['SCOPE', 'CC-2'], members: [{ name: 'acceptance', status: 'ok' }, { name: 'clean-code', fixed: true, status }] });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at(5, i), run_id: `impl-${i}`, story: `P-${i}`, agent: 'implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 100000 } }));
  const fixer = (runId, check, round, cost, seconds, mm) => ({ ts: at(mm), run_id: runId, story: 'P-0', stage: 'pr-check', agent: 'pr-check-fixer', step: 'fixer', check, round, cost_usd: cost, seconds, tokens: { input: 1000 } });
  const breach = [
    { ts: at(11), kind: 'finding', story: 'P-0', stage: 'prCheck', check: 'chk-0', round: 1, finding: 'CLN-1-1', lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' },
    { ts: at(12), kind: 'outcome', story: 'P-0', stage: 'prCheck', check: 'chk-0', round: 1, finding: 'CLN-1-1', outcome: 'led-to-change' },
  ];
  // 1. CC-1 upheld in round 1 of check chk-0, fixed in that round for $0.001 and 1 second; a round-2 fix in another
  // check of the same ticket (its rounds 1 and 2) cost $5 and 99 seconds each. CC-1 is charged its own fix, which costs
  // less than carrying it.
  const config = setup(t, { file: { rules: ['SCOPE', 'CC-2'], window: 0, windowEnd: null, probation: {}, locked: {} } });
  const p1 = plan(config, { rounds: Array.from({ length: 10 }, (_, i) => prRound(i)), findings: breach, usage: [...firstRuns, fixer('fix-own', 'chk-0', 1, 0.001, 1, 13), fixer('fix-later-1', 'chk-late', 1, 5, 99, 30), fixer('fix-later-2', 'chk-late', 2, 5, 99, 40)] });
  const cc1 = p1.numbers.rules.find((r) => r.rule === 'CC-1');
  assert.deepEqual([p1.samples, cc1.breaches, cc1.breachCost, cc1.breachSeconds], [10, 1, 0.001, 1]);
  assert.ok(cc1.breachCost < cc1.carryCost, JSON.stringify(cc1));
  assert.ok(!p1.changes.some((c) => c.rule === 'CC-1'), 'not added on another check\'s fix');
  // 2. Ten first rounds whose clean-code critic failed: no judgment, no samples, nothing removed.
  const failed = setup(t, { file: { rules: ['SCOPE', 'CC-1', 'CC-2'], window: 0, windowEnd: null, probation: {}, locked: {} } });
  const p2 = plan(failed, { rounds: Array.from({ length: 10 }, (_, i) => prRound(i, 'failed')), findings: [], usage: firstRuns });
  assert.deepEqual([p2.samples, p2.insufficient, p2.changes], [0, true, []]);
});

// Council r3 (TV-10): each sample condition alone. A first round counts only with the rule set the writer carried
// (writerRules) and the clean-code seat's finished judgment; either missing, it is no sample.
test('TV-10: a first round without the seat, or without the rule set, is no sample; with both it is', (t) => {
  const at = (i) => `2026-11-24T13:00:${String(i).padStart(2, '0')}.000Z`;
  const round = (i, extra) => ({ ts: at(i), story: `T-${i}`, stage: 'pairVerify', step: 'api', round: 1, pass: true, ...extra });
  const seat = { members: [{ name: 'verifier', status: 'ok' }, { name: 'clean-code', fixed: true, status: 'ok' }] };
  const rules = { writerRules: ['SCOPE', 'CC-1', 'CC-2'] };
  const samples = (extra) => plan(setup(t), { rounds: Array.from({ length: 10 }, (_, i) => round(i, extra)), findings: [], usage: [] }).samples;
  assert.equal(samples({ ...rules, members: [{ name: 'verifier', status: 'ok' }] }), 0, 'rule set, no seat');
  assert.equal(samples(seat), 0, 'seat, no rule set');
  assert.equal(samples({ ...rules, ...seat }), 10, 'both');
});

// Council r4 (sol-11): the member's reproducer. The PR check's orchestrator fixed the ruling itself (agent
// stage-orchestrator, stage pr-check, step fixer, mode write) in the same check and round; a delegated fix in another
// check of the ticket cost $5. The fix is found by its role (stage, step, check, round), whoever ran it.
test('sol-11 r4: a fix the PR check\'s orchestrator does itself is that check\'s fix', (t) => {
  const at = (mm, s = 0) => `2026-11-24T14:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const prRound = (i) => ({ ts: at(10, i), story: `P-${i}`, stage: 'prCheck', check: `chk-${i}`, round: 1, pass: true, writerRules: ['SCOPE', 'CC-2'], members: [{ name: 'acceptance', status: 'ok' }, { name: 'clean-code', fixed: true, status: 'ok' }] });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at(5, i), run_id: `impl-${i}`, story: `P-${i}`, agent: 'implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 100000 } }));
  const breach = [
    { ts: at(11), kind: 'finding', story: 'P-0', stage: 'prCheck', check: 'chk-0', round: 1, finding: 'CLN-1-1', lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' },
    { ts: at(12), kind: 'outcome', story: 'P-0', stage: 'prCheck', check: 'chk-0', round: 1, finding: 'CLN-1-1', outcome: 'led-to-change' },
  ];
  const selfFix = { ts: at(13), run_id: 'self-fix', story: 'P-0', stage: 'pr-check', agent: 'stage-orchestrator', step: 'fixer', mode: 'write', check: 'chk-0', round: 1, cost_usd: 0.001, seconds: 1, tokens: { input: 1000 } };
  const otherCheck = { ts: at(30), run_id: 'fix-later', story: 'P-0', stage: 'pr-check', agent: 'pr-check-fixer', step: 'fixer', mode: 'write', check: 'chk-late', round: 1, cost_usd: 5, seconds: 99, tokens: { input: 1000 } };
  const config = setup(t, { file: { rules: ['SCOPE', 'CC-2'], window: 0, windowEnd: null, probation: {}, locked: {} } });
  const p = plan(config, { rounds: Array.from({ length: 10 }, (_, i) => prRound(i)), findings: breach, usage: [...firstRuns, selfFix, otherCheck] });
  const cc1 = p.numbers.rules.find((r) => r.rule === 'CC-1');
  assert.deepEqual([cc1.breaches, cc1.breachCost, cc1.breachSeconds], [1, 0.001, 1]);
  assert.ok(!p.changes.some((c) => c.rule === 'CC-1'), 'not added on another check\'s fix');
  // The orchestrator's fix carries the full rules, not the writer set: it is no writer run in the carry cost.
  assert.equal(cc1.writerRuns, 11, 'the ten first runs and the delegated fixer');
});

// Council r4 (sol-13): the member's reproducer. One upheld finding has two raiser rows: the clean-code seat's (CC-1)
// and a corroborating shadow's (another lens, no rule). Whatever their order, the breach is the clean-code row's.
test('sol-13: a corroborating raiser\'s row does not erase the clean-code breach of the same finding, in either order', (t) => {
  const at = (mm, s = 0) => `2026-11-24T15:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const prRound = (i) => ({ ts: at(10, i), story: `P-${i}`, stage: 'prCheck', check: `chk-${i}`, round: 1, pass: true, writerRules: ['SCOPE', 'CC-1', 'CC-2'], members: [{ name: 'acceptance', status: 'ok' }, { name: 'clean-code', fixed: true, status: 'ok' }] });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at(5, i), run_id: `impl-${i}`, story: `P-${i}`, agent: 'implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 100000 } }));
  const row = { kind: 'finding', story: 'P-0', stage: 'prCheck', check: 'chk-0', round: 1, finding: 'CLN-1-1' };
  const ccRow = { ...row, ts: at(11), lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' };
  const shadowRow = { ...row, ts: at(11, 1), lens: 'correctness', seat: 'shadow' };
  const outcome = { ts: at(12), kind: 'outcome', story: 'P-0', stage: 'prCheck', check: 'chk-0', round: 1, finding: 'CLN-1-1', outcome: 'led-to-change' };
  for (const rows of [[ccRow, shadowRow], [shadowRow, ccRow]]) {
    const config = setup(t, { file: { rules: ['SCOPE', 'CC-1', 'CC-2'], window: 0, windowEnd: null, probation: {}, locked: {} } });
    const p = plan(config, { rounds: Array.from({ length: 10 }, (_, i) => prRound(i)), findings: [...rows, outcome], usage: firstRuns });
    assert.equal(p.numbers.rules.find((r) => r.rule === 'CC-1').breaches, 1, rows.map((r) => r.seat).join(' then '));
    assert.ok(!p.changes.some((c) => c.rule === 'CC-1' && c.action === 'remove'), 'CC-1 is not removed on probation');
  }
});

// Council r4 (test-value follow-up): a stage breach (a pair's) is charged its own step's next round only: not a PR check
// fix of the same ticket, not another subtask's next round. A breach with no run of its own costs the mean fix run,
// which counts every fix (a PR check fix in its own round 1 too) and no first run.
test('a pair breach is charged its own step\'s next round, not a PR fix or another subtask; the mean fix counts PR fixes', (t) => {
  const at = (mm, s = 0) => `2026-11-24T16:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const round = (i) => ({ ts: at(10, i), story: `S-${i}`, stage: 'pairVerify', step: 'api', round: 1, pass: true, writerRules: ['SCOPE', 'CC-2'], members: [{ name: 'verifier', status: 'ok' }, { name: 'clean-code', fixed: true, status: 'ok' }] });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at(5, i), run_id: `w-${i}`, story: `S-${i}`, stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 100000 } }));
  const breach = (story, step) => [
    { ts: at(11), kind: 'finding', story, stage: 'pairVerify', step, round: 1, finding: `F-${story}`, lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' },
    { ts: at(12), kind: 'outcome', story, stage: 'pairVerify', step, round: 1, finding: `F-${story}`, outcome: 'led-to-change' },
  ];
  const run = (id, extra, cost, seconds) => ({ ts: at(20), run_id: id, story: 'S-0', stage: 'implement-pair', agent: 'pair-implementer', step: 'api', round: 2, cost_usd: cost, seconds, tokens: { input: 1000 }, ...extra });
  const own = run('own', {}, 0.001, 1);
  const otherStep = run('other-step', { step: 'ui' }, 5, 99);
  const prFixRun = run('pr-fix', { agent: 'pr-check-fixer', stage: 'pr-check', step: 'fixer', check: 'chk-1' }, 7, 77);
  const rounds = Array.from({ length: 10 }, (_, i) => round(i));
  const cc1 = (usage, findings = breach('S-0', 'api')) => plan(setup(t), { rounds, findings, usage: [...firstRuns, ...usage] }).numbers.rules.find((r) => r.rule === 'CC-1');
  assert.deepEqual([cc1([own, otherStep, prFixRun]).breachCost, cc1([own, otherStep, prFixRun]).breachSeconds], [0.001, 1]);
  // No run of its own (S-1 has no round 2): the mean of the fix runs, here a round-1 PR fix ($3) and the other step's
  // round 2 ($5); the first runs ($0.1) are not fixes.
  // An architecture review breach has no step: the PR check's fix of the ticket in round 2 is still not its fix.
  const review = [
    { ts: at(11), kind: 'finding', story: 'S-0', stage: 'architectureReview', round: 1, finding: 'R-1', lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' },
    { ts: at(12), kind: 'outcome', story: 'S-0', stage: 'architectureReview', round: 1, finding: 'R-1', outcome: 'led-to-change' },
  ];
  const implFix = run('impl-fix', { agent: 'implementer', stage: 'implement', step: null }, 0.002, 2);
  assert.deepEqual([cc1([implFix, prFixRun], review).breachCost, cc1([implFix, prFixRun], review).breachSeconds], [0.002, 2]);
  const prRoundOne = { ...prFixRun, run_id: 'pr-fix-r1', round: 1, cost_usd: 3, seconds: 30 };
  assert.deepEqual([cc1([otherStep, prRoundOne], breach('S-1', 'api')).breachCost, cc1([otherStep, prRoundOne], breach('S-1', 'api')).breachSeconds], [4, 64.5]);
});

// Council r5 (sol-11): the member's two cases. The architecture review's orchestrator fixed round 1 itself (stage
// review, step orchestrator-fix, round 1); a pair's round-2 fix of the same ticket is no architecture fix.
test('sol-11 r5: the architecture review\'s own fix is its round\'s fix; a pair fix of the ticket is not', (t) => {
  const at = (mm, s = 0) => `2026-11-25T10:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const round = (i) => ({ ts: at(10, i), story: `R-${i}`, stage: 'architectureReview', round: 1, pass: true, writerRules: ['SCOPE', 'CC-2'], members: [{ name: 'verifier', status: 'ok' }, { name: 'clean-code', fixed: true, status: 'ok' }] });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at(5, i), run_id: `impl-${i}`, story: `R-${i}`, stage: 'implement', agent: 'implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 2000 } }));
  const breach = [
    { ts: at(11), kind: 'finding', story: 'R-0', stage: 'architectureReview', round: 1, finding: 'ARCH-1', lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' },
    { ts: at(12), kind: 'outcome', story: 'R-0', stage: 'architectureReview', round: 1, finding: 'ARCH-1', outcome: 'led-to-change' },
  ];
  const selfFix = { ts: at(13), run_id: 'arch-self', story: 'R-0', stage: 'review', step: 'orchestrator-fix', agent: 'stage-orchestrator', mode: 'implement', round: 1, cost_usd: 0.001, seconds: 1, tokens: { input: 1000 } };
  const pairFix = { ts: at(14), run_id: 'pair-r2', story: 'R-0', stage: 'implement-pair', step: 'api', agent: 'pair-implementer', round: 2, cost_usd: 5, seconds: 99, tokens: { input: 1000 } };
  const rounds = Array.from({ length: 10 }, (_, i) => round(i));
  for (const usage of [[selfFix], [selfFix, pairFix]]) {
    const p = plan(setup(t), { rounds, findings: breach, usage: [...firstRuns, ...usage] });
    const cc1 = p.numbers.rules.find((r) => r.rule === 'CC-1');
    assert.deepEqual([cc1.breaches, cc1.breachCost, cc1.breachSeconds], [1, 0.001, 1], usage.map((u) => u.run_id).join(', '));
    assert.ok(!p.changes.some((c) => c.rule === 'CC-1'), 'not added');
  }
});

// Council r5 (sol-11): every council stage that can uphold a breach on a writer's work has its fix roles (FIX_RUNS),
// and each role is found: a breach is charged the run in its own role, never another stage's fix of the same ticket.
test('sol-11 r5: every writer stage\'s breach is charged its own fix run, in each of the stage\'s roles', async (t) => {
  const { FIX_RUNS } = await import('../lib/writer-rules.mjs');
  const { WRITER_STAGES } = await import('../lib/council.mjs');
  assert.deepEqual(WRITER_STAGES.filter((s) => !FIX_RUNS[s]?.length), [], 'a fix role for every writer stage');
  const at = (mm, s = 0) => `2026-11-25T11:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  // A row in a role: its stage, a step it accepts, the round after the ruling it names, and the ruling's check.
  const stepFor = (f) => (f.step === 'same' ? 'api' : f.step === null ? null : f.step === 'any' ? 'any-step' : f.step instanceof RegExp ? 'fixer' : f.step);
  const roleRun = (id, f, usageStage, cost) => ({ ts: at(20), run_id: id, story: 'T-0', stage: usageStage, step: stepFor(f), check: f.check ? 'chk-0' : undefined, agent: 'stage-orchestrator', round: 1 + f.after, cost_usd: cost, seconds: 7, tokens: { input: 1000 } });
  const firstRuns = Array.from({ length: 10 }, (_, i) => ({ ts: at(5, i), run_id: `w-${i}`, story: `T-${i}`, stage: 'implement', agent: 'implementer', round: 1, cost_usd: 0.1, seconds: 60, tokens: { input: 2000 } }));
  for (const stage of WRITER_STAGES) {
    const rounds = Array.from({ length: 10 }, (_, i) => ({ ts: at(10, i), story: `T-${i}`, stage, step: 'api', check: 'chk-0', round: 1, pass: true, writerRules: ['SCOPE', 'CC-2'], members: [{ name: 'verifier', status: 'ok' }, { name: 'clean-code', fixed: true, status: 'ok' }] }));
    const finding = { story: 'T-0', stage, step: stage.startsWith('pair') ? 'api' : undefined, check: stage === 'prCheck' ? 'chk-0' : undefined, round: 1, finding: 'F-1' };
    const breach = [{ ...finding, ts: at(11), kind: 'finding', lens: 'clean-code', rule: 'CC-1', seat: 'clean-code' }, { ...finding, ts: at(12), kind: 'outcome', outcome: 'led-to-change' }];
    // Every other stage's fix roles, as decoys on the same ticket (a stage whose roles are this one's, the UI pair's and
    // the pair's, is the same fix).
    const same = (a, b) => JSON.stringify(a.map(String)) === JSON.stringify(b.map(String)) && JSON.stringify(a) === JSON.stringify(b);
    const decoys = Object.entries(FIX_RUNS).filter(([s, roles]) => s !== stage && !same(roles, FIX_RUNS[stage])).flatMap(([s, roles]) => roles.map((f, i) => roleRun(`decoy-${s}-${i}`, f, f.stages[0], 9)));
    for (const [i, f] of FIX_RUNS[stage].entries()) {
      for (const usageStage of f.stages) {
        const p = plan(setup(t), { rounds, findings: breach, usage: [...firstRuns, ...decoys, roleRun(`own-${i}`, f, usageStage, 0.003)] });
        const cc1 = p.numbers.rules.find((r) => r.rule === 'CC-1');
        assert.deepEqual([cc1.breaches, cc1.breachCost, cc1.breachSeconds], [1, 0.003, 7], `${stage}, role ${i} (${usageStage})`);
      }
    }
  }
});
