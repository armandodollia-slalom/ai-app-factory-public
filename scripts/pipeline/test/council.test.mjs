// Council verifiers (scripts/pipeline/lib/council.mjs, council-config.mjs): configuration, seating, merging and the
// PR body table, and a council of three members on three fake CLIs (claude, codex, copilot) end to end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { councilProblems, envProblems } from '../lib/council-config.mjs';
import { poolProblems } from '../lib/pool.mjs';
import { councilSettings, poolSettings, seatedCouncil } from './fixtures/pool.mjs';
import { agentEnv, councilActionsText, councilDoctorRows, memberLogin, memberRunEnv, councilFor, councilReviewSection, councilRounds, disputesFor, guardProtectedTests, memberTask, mergeCouncil, normalizeFinding, protectedTestFinding, runCouncil, runDetachedMember, takeLate, testProtection, withCouncilReview } from '../lib/council.mjs';
import { agentDefinition, cliInvocation } from '../lib/agents.mjs';
import { sha } from '../lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.resolve(here, '../../..');
const members = [
  { name: 'opus', cli: 'claude', model: 'opus', effort: 'high', lens: 'correctness' },
  { name: 'sol', cli: 'codex', model: 'sol', effort: 'high', lens: 'correctness' },
  { name: 'tests', cli: 'copilot', model: 'sonnet', lens: 'test-value' },
  { name: 'rewrite', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false },
];
// The four members as the pool, with a council of three for the architecture review.
const POOLED = { ...poolSettings(members), architectureReview: { councilMembers: 3 } };
const COUNCIL = { blockQuorum: 'any', onUnavailable: 'fail' };

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

test('council config: the council is a count of members; a list of members is refused, naming the pool', () => {
  assert.deepEqual(councilProblems({ ...COUNCIL, members: 2 }), []);
  assert.deepEqual(councilProblems(undefined), []);
  assert.match(councilProblems({ members }).join('\n'), /council\.members is now how many members a council seats[\s\S]*models\.pool entries/);
  assert.match(councilProblems({ members: 0 }).join('\n'), /council\.members must be a whole number, 1 or more/);
  assert.match(councilProblems({ blockQuorum: 'most', onUnavailable: 'substitute' }).join('\n'), /blockQuorum must be one of any, majority, all[\s\S]*onUnavailable must be one of fail, report/);
});

test('pool config: a bad entry, a duplicate name, a custom entry without its command and an unknown entry name are refused', () => {
  const pool = poolSettings(members).models.pool;
  const bad = (patch, extra = {}) => poolProblems({ models: { pool: patch, agents: { default: 'opus', ...extra } } }).join('\n');
  assert.match(bad([...pool, { name: 'x', cli: 'gemini', model: 'gemini-3', effort: 'high' }]), /models\.pool\[4\] \("x"\)\.cli must be one of claude, codex, copilot, custom/);
  assert.match(bad([...pool, { name: 'x', cli: 'claude', model: 'claude-opus-5-5', effort: 'huge' }]), /\("x"\)\.effort must be one of low, medium, high, xhigh, max/);
  assert.match(bad([...pool, { ...pool[0] }]), /two entries named "opus"/);
  assert.match(bad([...pool, { name: 'own', cli: 'custom', effort: 'high' }]), /\("own"\)\.cmd must be the command a custom entry runs/);
  assert.match(bad([...pool, { name: 'x', cli: 'claude', effort: 'high' }]), /\("x"\)\.model must be the CLI's own model id/);
  assert.match(bad(pool, { 'pr-check-judge': 'ghost' }), /models\.agents\.pr-check-judge is "ghost", which is not in models\.pool \(entries: opus, sol, tests, rewrite\)/);
  assert.match(bad([]), /models\.pool must list at least one entry/);
  assert.deepEqual(bad([...pool, { name: 'own', cli: 'custom', cmd: 'my-agent --json', effort: 'high' }]), '');
});

test('pool config is checked when the settings load: an agent naming no entry fails at once and lists the entries', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-cfg-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ ...POOLED, models: { ...POOLED.models, agents: { ...POOLED.models.agents, 'architecture-reviewer': 'gpt-9' } } }));
  assert.throws(() => loadConfig('review', dir), /\.factory\/config\.json: models\.agents\.architecture-reviewer is "gpt-9", which is not in models\.pool \(entries: opus, sol, tests, rewrite\)/);
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(POOLED));
  const config = loadConfig('review', dir);
  assert.equal(councilFor(config, 'architectureReview').members.length, 3);
});

// GEN-8: every verifier stage is a council with its own round limit and pass score, whatever its size.
test('rounds and pass score: each stage\'s own (<section>.maxCouncilRounds, .councilPassScore), for one member or several', () => {
  const config = { ...POOLED, architectureReview: { maxCouncilRounds: 4, councilPassScore: 9.5, councilMembers: 3 } };
  assert.deepEqual([councilRounds(config, 'architectureReview'), councilFor(config, 'architectureReview').councilPassScore], [4, 9.5]);
  assert.deepEqual(['pairVerify', 'pairUiVerify', 'architectureReview', 'testPlan', 'testAutomation', 'prCheck'].map((s) => [councilRounds({}, s), councilFor({}, s).councilPassScore]), [[3, 9.5], [3, 9.5], [5, 9.5], [5, 9], [5, 9], [3, 9.5]], 'the defaults');
  const sole = councilFor({}, 'architectureReview');
  assert.deepEqual([sole.sole, sole.members.length, sole.members[0].lens, sole.members[0].blocking, sole.intercom.enabled, sole.onUnavailable], [true, 1, 'all', true, false, 'fail'], 'no members: a council of one');
  // Three seats from the pool: one entry per family first (opus, sol), then the next in pool order; every one blocks.
  const c = councilFor(config, 'architectureReview');
  assert.deepEqual(c.members.map((m) => [m.name, m.family, m.lens, m.blocking]), [['opus', 'Anthropic', 'correctness', true], ['sol', 'OpenAI', 'security', true], ['tests', 'Anthropic', 'rewrite', true]]);
});

test('effort maps to each CLI\'s own option; a custom member runs its own command', () => {
  const config = { root: '/r', agent: { cli: 'claude', cmd: null } };
  assert.ok(cliInvocation(config, { prompt: 'p', mode: 'read', model: 'm', cli: 'claude', effort: 'high' }).args.join(' ').includes('--model m --effort high'));
  const codex = cliInvocation(config, { prompt: 'p', mode: 'read', model: 'gpt', cli: 'codex', effort: 'max' }).args;
  assert.ok(codex.includes('model_reasoning_effort="xhigh"') && codex.includes('read-only'));
  assert.ok(!cliInvocation(config, { prompt: 'p', mode: 'read', model: 'x', cli: 'copilot', effort: 'high' }).args.some((a) => /effort/.test(a)), 'copilot has no effort option');
  const custom = cliInvocation(config, { prompt: 'p', mode: 'read', model: 'opus', cli: 'custom', effort: 'low', cmd: 'my-agent' });
  assert.deepEqual([custom.cmd, custom.args, custom.env], ['sh', ['-c', 'my-agent'], { PIPELINE_AGENT_MODEL: 'opus', PIPELINE_AGENT_EFFORT: 'low' }]);
  // Without a member, nothing changes.
  assert.equal(cliInvocation(config, { prompt: 'p', mode: 'read', model: 'm', cli: 'claude' }).args.includes('--effort'), false);
  assert.equal(cliInvocation({ ...config, agent: { cli: 'claude', cmd: 'fake' } }, { prompt: 'p', mode: 'read', model: 'm' }).env, undefined);
});

test('every member\'s prompt carries its lens, the council fields and the skill text; disputes go only to the members that raised them', () => {
  const c = seatedCouncil(POOLED, 'architectureReview', [members[0], members[1], members[3]]);
  const t = memberTask('STAGE TASK', { council: c, member: c.members[1], round: 2 });
  assert.match(t, /^STAGE TASK\n\n## Council member/);
  assert.match(t, /You are \*\*sol\*\*; your lens is \*\*correctness\*\*/);
  assert.match(t, /Council round 2 of at most 5/);
  // Every member, whatever its lens, checks the change for behaviour the ticket does not ask for (dogfood C14, BUG-46).
  assert.match(t, /Whatever your lens, check the change itself for scope: behaviour the ticket does not ask for \(a new limit[\s\S]*blocking finding with `lens` "acceptance"/);
  assert.match(t, /`delete-test`[\s\S]*`rewrite`/);
  assert.match(t, /### The council skill[\s\S]*This is a feature branch\. None of this code is precious\.[\s\S]*### Useless tests/);
  const open = [{ id: 'a', members: ['opus'] }, { id: 'b', members: ['sol', 'opus'] }, { id: 'c' }];
  assert.equal(disputesFor(c.members[1], open, (l) => l.map((d) => d.id).join(',')), 'b,c');
  assert.equal(disputesFor(c.members[2], open.slice(0, 2), (l) => l.map((d) => d.id).join(',')), '');
});

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

const council3 = (over = {}) => ({ stage: 'review', maxCouncilRounds: 3, councilPassScore: 9, blockQuorum: 'any', onUnavailable: 'fail', members: [{ name: 'a', cli: 'claude', lens: 'correctness', blocking: true }, { name: 'b', cli: 'codex', lens: 'correctness', blocking: true }, { name: 'c', cli: 'copilot', lens: 'test-value', blocking: true }], ...over });
const ok = (m, score, findings = [], extra = {}) => ({ member: m, status: 'ok', score, verdict: findings.some((f) => f.severity !== 'minor') ? 'CHANGES_REQUESTED' : 'APPROVED', summary: '', findings: findings.map((f) => normalizeFinding(f, m)), ...extra });
const bug = { file: 'src/a.js', line: 10, issue: 'the owner check is missing', severity: 'blocking', evidence: 'a.js:10 returns every order' };

test('same-defect findings are merged once with every member\'s evidence and name', () => {
  const c = council3();
  const [a, b, cc] = c.members;
  const m = mergeCouncil(c, [ok(a, 6, [bug]), ok(b, 7, [{ ...bug, line: 12, issue: 'any user reads any order', evidence: 'curl as bob returns alice' }]), ok(cc, 9)]);
  assert.equal(m.pass, false);
  assert.equal(m.findings.length, 1);
  assert.deepEqual(m.findings[0].members, ['a', 'b']);
  assert.match(m.findings[0].evidence, /a: a\.js:10 returns every order\nb: curl as bob returns alice/);
  assert.equal(m.score, 6);
});

test('blockQuorum: any upholds one member\'s finding, majority needs most of the blocking members, all needs every one', () => {
  const lone = (blockQuorum) => {
    const c = council3({ blockQuorum });
    const [a, b, cc] = c.members;
    return mergeCouncil(c, [ok(a, 6, [bug]), ok(b, 9), ok(cc, 10)]);
  };
  assert.equal(lone('any').findings.length, 1);
  assert.equal(lone('any').pass, false);
  for (const rule of ['majority', 'all']) {
    const m = lone(rule);
    assert.equal(m.findings.length, 0, rule);
    assert.match(m.notes[0].notUpheld, new RegExp(`blockQuorum "${rule}" needs ${rule === 'all' ? 3 : 2}`));
    assert.equal(m.pass, true, `${rule}: an outvoted member's low score does not hold the council`);
  }
  const two = (blockQuorum) => {
    const c = council3({ blockQuorum });
    const [a, b, cc] = c.members;
    return mergeCouncil(c, [ok(a, 6, [bug]), ok(b, 7, [{ ...bug, line: 11 }]), ok(cc, 10)]);
  };
  assert.equal(two('majority').findings.length, 1);
  assert.equal(two('all').findings.length, 0);
});

test('minor never blocks or lowers the pass decision; a low score with no blocking finding becomes a finding of its own', () => {
  const c = council3();
  const [a, b, cc] = c.members;
  const minor = mergeCouncil(c, [ok(a, 9, [{ ...bug, severity: 'minor', issue: 'rename x' }]), ok(b, 10), ok(cc, 9)]);
  assert.equal(minor.pass, true);
  assert.equal(minor.notes.length, 1);
  const unexplained = mergeCouncil(c, [ok(a, 5, [], { summary: 'feels wrong' }), ok(b, 10), ok(cc, 9)]);
  assert.equal(unexplained.pass, false);
  assert.match(unexplained.findings[0].text, /a scored 5\/10 \(the pass score is 9\) without a standing blocking finding/);
});

test('a non-blocking member is not waited for, its score is never recorded, and its late result comes back as feedback', async () => {
  const c = { ...council3(), members: [...council3().members.slice(0, 2), { name: 'slow', cli: 'claude', lens: 'rewrite', blocking: false }] };
  const late = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const t0 = Date.now();
  const out = await runCouncil({
    council: c,
    taskFor: () => 't',
    run: async (m) => {
      if (m.name === 'slow') await gate;
      return { status: 0, output: `AGENT_RESULT: ${JSON.stringify({ verdict: 'APPROVED', score: m.name === 'slow' ? 2 : 10, findings: m.name === 'slow' ? [{ severity: 'blocking', issue: 'rewrite it all', file: 'src/a.js' }] : [] })}` };
    },
    parse: (o) => {
      const r = JSON.parse(o.slice(o.indexOf('{')));
      return { score: r.score, verdict: r.verdict, findings: r.findings };
    },
    onLate: (r) => late.push(r),
    log: () => {},
  });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(out.results.map((r) => [r.member.name, r.status]), [['a', 'ok'], ['b', 'ok'], ['slow', 'late']]);
  const m = mergeCouncil(c, out.results);
  assert.equal(m.pass, true);
  assert.equal(m.members.find((x) => x.name === 'slow').score, null);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(late.length, 1);
  const next = mergeCouncil(c, out.results.map((r) => (r.status === 'late' ? { ...r, status: 'late' } : r)), { feedback: late });
  assert.equal(next.pass, true, 'feedback never blocks');
  assert.match(next.notes.find((n) => n.feedback).text, /rewrite it all/);
  // A non-blocking member's own finding, even blocking, is feedback when no blocking member raised it.
  const nb = mergeCouncil(c, [ok(c.members[0], 10), ok(c.members[1], 10), ok(c.members[2], 3, [bug])]);
  assert.equal(nb.pass, true);
  assert.equal(nb.findings.length, 0);
});

test('an unavailable member fails the round under onUnavailable fail, and is reported and left out under report; never substituted', () => {
  const run = (onUnavailable) => {
    const c = council3({ onUnavailable });
    const [a, b, cc] = c.members;
    return mergeCouncil(c, [ok(a, 10), { member: b, status: 'unavailable', reason: 'provider unavailable: usage limit reached' }, ok(cc, 9)]);
  };
  const fail = run('fail');
  assert.equal(fail.pass, false);
  assert.match(fail.error, /b \(codex\): provider unavailable: usage limit reached \(council\.onUnavailable is fail; no other model is substituted\)/);
  const report = run('report');
  assert.equal(report.error, null);
  assert.equal(report.pass, true);
  assert.deepEqual(report.unavailable, [{ name: 'b', cli: 'codex', reason: 'provider unavailable: usage limit reached' }]);
  assert.equal(report.members.find((m) => m.name === 'b').status, 'unavailable');
});

test('an upheld rewrite replaces the fix list for the regions it deletes', () => {
  const c = council3();
  const [a, b, cc] = c.members;
  const rewrite = { action: 'rewrite', severity: 'blocking', issue: 'the cache layer is needless', deletes: ['src/cache/', 'src/a.js:1-40'], approach: 'read through the existing repository', why: 'one moving part fewer', covers: ['AC 1'] };
  const m = mergeCouncil(c, [ok(a, 5, [rewrite]), ok(b, 6, [bug, { file: 'src/cache/lru.js', line: 3, issue: 'eviction is off by one', severity: 'blocking' }, { file: 'src/b.js', line: 3, issue: 'b is wrong', severity: 'major' }]), ok(cc, 9)]);
  assert.deepEqual(m.findings.map((f) => f.action === 'rewrite' ? 'rewrite' : f.file), ['rewrite', 'src/b.js']);
  assert.deepEqual(m.superseded.length, 2);
  assert.ok(m.notes.every((f) => f.supersededBy));
});

test('delete-test findings are major and acted on, except a test that is another story\'s, kept for a finding, or the only cover of a line', () => {
  const c = council3();
  const [a, b, cc] = c.members;
  const cases = [
    { id: 'TC-SHOP-1-01', covers: ['AC 1'], keptFor: null },
    { id: 'TC-SHOP-1-02', covers: ['AC 1'], keptFor: null },
    { id: 'TC-SHOP-1-03', covers: ['AC 2'], keptFor: null },
    { id: 'TC-SHOP-1-04', covers: ['AC 1'], keptFor: 'ACC-2-1' },
  ];
  const del = (test) => ({ action: 'delete-test', severity: 'major', test, file: 'tests/orders.spec.ts', issue: `${test} only checks a mock`, evidence: 'mocks the repository it tests' });
  const m = mergeCouncil(c, [ok(a, 8, [del('TC-SHOP-1-02 lists orders')]), ok(b, 8, [del('TC-SHOP-1-03 rejects bad ids'), del('TC-SHOP-1-04 regression'), del('TC-SHOP-9-01 other story')]), ok(cc, 9)], { protect: (f) => testProtection(f, { keys: ['SHOP-1'], cases }) });
  assert.deepEqual(m.findings.map((f) => f.test), ['TC-SHOP-1-02 lists orders']);
  assert.equal(m.findings[0].severity, 'major');
  const why = Object.fromEntries(m.notes.map((f) => [f.test.split(' ')[0], f.protected]));
  assert.match(why['TC-SHOP-1-03'], /only cover for acceptance line\(s\): AC 2/);
  assert.match(why['TC-SHOP-1-04'], /regression test kept for upheld finding\(s\) ACC-2-1/);
  assert.match(why['TC-SHOP-9-01'], /belongs to another story \(SHOP-9\)/);
});

test('members who contradict each other are surfaced with both positions, never resolved silently', () => {
  const c = council3();
  const [a, b, cc] = c.members;
  const m = mergeCouncil(c, [ok(a, 7, [{ action: 'delete-test', severity: 'major', test: 'totals test', file: 't.spec.ts', issue: 'restates the code' }]), ok(b, 7, [{ action: 'fix', severity: 'blocking', test: 'totals test', file: 't.spec.ts', issue: 'assert the rounding too' }]), ok(cc, 10)]);
  assert.equal(m.contradictions.length, 1);
  assert.deepEqual(m.contradictions[0].positions.map((p) => [p.member, p.action]), [['a', 'delete-test'], ['b', 'fix']]);
});

test('dispute rulings with several members: only the raisers rule, and one re-assertion with evidence keeps the finding', () => {
  const c = council3();
  const [a, b, cc] = c.members;
  const f = { ...bug, id: 'r1-1' };
  const m = mergeCouncil(c, [ok(a, 7, [f], { disputes: [{ finding: 'r1-1', decision: 'accepted' }] }), ok(b, 7, [{ ...f, evidence: 'AC 2 requires it' }], { disputes: [{ finding: 'r1-1', decision: 'reasserted', evidence: 'AC 2 requires it' }] }), ok(cc, 10, [], { disputes: [{ finding: 'r1-1', decision: 'accepted' }] })]);
  assert.deepEqual(m.disputes, [{ finding: 'r1-1', decision: 'reasserted', evidence: 'AC 2 requires it', members: ['a', 'b'] }]);
  const accepted = mergeCouncil(c, [ok(a, 10, [], { disputes: [{ finding: 'x', decision: 'accepted' }] }), ok(b, 10), ok(cc, 10)]);
  assert.deepEqual(accepted.disputes.map((d) => d.decision), ['accepted']);
});

// ---------------------------------------------------------------------------------------------
// PR body
// ---------------------------------------------------------------------------------------------

test('the PR body gets the skill\'s "Council review" table with every sitting, regenerated in place; no score when a member gave none', () => {
  const rec = (round, scores, ts) => ({ ts, stage: 'architectureReview', story: 'SHOP-1', round, members: [{ name: 'opus', cli: 'claude', blocking: true, score: scores[0] }, { name: 'sol', cli: 'codex', blocking: true, score: scores[1] }, { name: 'rw', cli: 'claude', blocking: false, score: null }] });
  const records = [rec(1, [3, 3], '2026-01-01'), rec(1, [7, 8], '2026-01-02'), rec(2, [9, null], '2026-01-03')];
  const section = councilReviewSection(records);
  assert.equal(section, ['## Council review', '', 'Rounds: 3 (2 sittings)', '', '| Member | Sitting 1, round 1 | Sitting 2, round 1 | Sitting 2, round 2 |', '| --- | --- | --- | --- |', '| opus (claude) | 3/10 | 7/10 | 9/10 |', '| sol (codex) | 3/10 | 8/10 | no score |', '| Result | not passed | not passed | not passed |'].join('\n'));
  const body = 'Implements SHOP-1.\n\n🤖 Generated with the factory';
  const once = withCouncilReview(body, section);
  assert.match(once, /Implements SHOP-1\.\n\n<!-- council-review:start -->\n## Council review[\s\S]*<!-- council-review:end -->\n\n🤖 Generated with the factory\n$/);
  const twice = withCouncilReview(once, councilReviewSection([...records, rec(3, [10, 10], '2026-01-04')]));
  assert.equal(twice.match(/## Council review/g).length, 1);
  assert.match(twice, /Rounds: 4 \(2 sittings\)/);
  assert.equal(withCouncilReview('plain body\n', ''), 'plain body\n');
  const two = councilReviewSection([...records, { ...rec(1, [10, 10], '2026-01-05'), stage: 'pairVerify', step: 'api' }]);
  assert.match(two, /### Architecture review \(SHOP-1\)[\s\S]*### Pair verifier \(SHOP-1, api\)/);
  // Council C9 proof run BUG-43: verify-first checks (round 0) after fix mode replaced the test automation council's rounds
  // with "Rounds: 0" and empty cells.
  const ta = (round, scores, ts, pass) => ({ ts, stage: 'testAutomation', story: 'BUG-43', round, pass, members: [{ name: 'opus', cli: 'claude', blocking: true, lens: 'acceptance', status: 'ok', score: scores[0] }, { name: 'sol', cli: 'codex', blocking: true, lens: 'test-value', status: 'ok', score: scores[1] }] });
  const auto = councilReviewSection([ta(1, [9, 10], '1', true), ta(0, [9, 8], '2', false), ta(1, [10, 10], '3', true), ta(0, [9, 10], '4', true)]);
  assert.match(auto, /Rounds: 2, checks: 2 \(3 sittings\)/);
  assert.match(auto, /\| Member \| Sitting 1, round 1 \| Sitting 2, check \| Sitting 2, round 1 \| Sitting 3, check \|/);
  assert.match(auto, /\| sol \(codex\) \| 10\/10 \(test-value\) \| 8\/10 \(test-value\) \| 10\/10 \(test-value\) \| 10\/10 \(test-value\) \|/);
});

test('doctor lists every pool entry with its family and login check, and each stage\'s seats', () => {
  const rows = councilDoctorRows({ ...POOLED, council: COUNCIL }, { probe: (cmd, args) => !(cmd === 'codex' && args[0] === 'login'), env: {}, home: '/nowhere', versionOf: () => 'codex-cli 0.167.1' });
  const get = (what) => rows.find((r) => r[0] === what);
  assert.deepEqual(rows[0], ['council seats per stage', true, 'pairVerify 1, pairUiVerify 1, architectureReview 3, testPlan 1, testAutomation 1, prCheck 1']);
  assert.equal(get('pool entry opus (claude, claude-opus-5-5, family Anthropic): signed in')[1], true);
  assert.equal(get('pool entry sol (codex, gpt-6.1-sol, family OpenAI): signed in')[1], false, 'sol sits on the architecture review');
  assert.equal(get('pool entry tests (copilot, claude-sonnet-5.5, family Anthropic): signed in')[1], false, 'no Copilot token or config');
  assert.equal(get('pool entry rewrite (claude, claude-opus-5-5, family Anthropic): signed in')[1], true);
});

// ---------------------------------------------------------------------------------------------
// End to end: three members on three fake CLIs
// ---------------------------------------------------------------------------------------------

function fakeClis() {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-clis-')));
  for (const cli of ['claude', 'codex', 'copilot']) {
    fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-cli.mjs')}" ${cli} "$@"\n`, { mode: 0o755 });
  }
  return bin;
}

function councilRepo(council) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-e2e-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n.factory/metrics/\n');
  const settings = councilSettings(council);
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ ...settings, architectureReview: { policy: { enabled: false }, councilPassScore: 9, ...settings.architectureReview } }, null, 2));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/orders.js'), 'export const list = () => [];\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat/orders');
  fs.writeFileSync(path.join(dir, 'src/orders.js'), 'export const list = (all) => all;\n');
  git('commit', '-qam', 'orders');
  return dir;
}

const skipOnWindows = process.platform === 'win32' ? 'the fake CLIs are shell wrappers' : false;

test('factory council review: three members on claude, codex and copilot run in parallel with their own model and effort, and the result merges', { skip: skipOnWindows }, () => {
  const bin = fakeClis();
  const council = { members: [{ name: 'opus', cli: 'claude', model: 'opus', effort: 'high', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', effort: 'max', lens: 'security', env: { CODEX_HOME: '~/.codex-second' } }, { name: 'tests', cli: 'copilot', model: 'sonnet', lens: 'test-value' }], stages: { architectureReview: {} } };
  const dir = councilRepo(council);
  const script = path.join(dir, '..', `${path.basename(dir)}-script.json`);
  const finding = { severity: 'blocking', file: 'src/orders.js', line: 1, issue: 'list returns every order to any caller', evidence: 'src/orders.js:1' };
  fs.writeFileSync(script, JSON.stringify({
    opus: [{ verdict: 'CHANGES_REQUESTED', score: 6, findings: [finding] }],
    sol: [{ verdict: 'CHANGES_REQUESTED', score: 5, findings: [{ ...finding, line: 2, issue: 'any user lists any order', evidence: 'no owner filter' }] }],
    tests: [{ verdict: 'APPROVED', score: 9, findings: [] }],
  }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CLI_SCRIPT: script, FACTORY_METRICS_SPOOL: '0', FACTORY_METRICS_SHARD: '0' };
  for (const k of ['PIPELINE_AGENT_CMD', 'PIPELINE_AGENT_CLI', 'PIPELINE_CHILD', 'PIPELINE_ROOT', 'PIPELINE_MODEL_OVERRIDE']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(INSTALL, 'bin/factory.mjs'), 'council', 'review', '--stage', 'architectureReview', '--base', 'main', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 1, `not passed: ${r.stderr}`);
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual(out.members.map((m) => [m.name, m.cli, m.status, m.score]), [['opus', 'claude', 'ok', 6], ['sol', 'codex', 'ok', 5], ['tests', 'copilot', 'ok', 9]]);
  assert.equal(out.findings.length, 1, JSON.stringify(out.findings.map((f) => [f.file, f.line, f.members, f.text])));
  assert.deepEqual(out.findings[0].members, ['opus', 'sol']);
  const calls = fs.readFileSync(`${script}.calls.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const by = Object.fromEntries(calls.map((c) => [c.cli, c]));
  assert.ok(by.claude.argv.join(' ').includes('--model claude-opus-5-5 --effort high'));
  assert.ok(by.claude.argv.join(',').includes('--disallowedTools,Edit,Write'), 'claude members are read-only');
  assert.ok(by.codex.argv.join(' ').includes('--sandbox read-only') && by.codex.argv.includes('model_reasoning_effort="xhigh"') && by.codex.argv.join(' ').includes('-m gpt-6.1-sol'));
  // The member's own env reaches its CLI (a second Codex login's home), and only its CLI.
  assert.equal(by.codex.env.CODEX_HOME, path.join(os.homedir(), '.codex-second'));
  assert.notEqual(by.claude.env.CODEX_HOME, path.join(os.homedir(), '.codex-second'));
  // The factory's PreToolUse guard is defined for the Codex run itself (Codex ignores the repository's hooks headlessly).
  assert.ok(by.codex.argv.includes('--dangerously-bypass-hook-trust'));
  assert.ok(by.codex.argv.some((a) => /^hooks\.PreToolUse=\[\{hooks=\[\{type="command",command=".*factory\.mjs.* hook pre-tool",timeout=10\}\]\}\]$/.test(a)));
  assert.ok(by.copilot.argv.join(' ').includes('--deny-tool write --deny-tool shell') && by.copilot.argv.join(' ').includes('--model claude-sonnet-5.5'));
  for (const c of calls) assert.match(c.prompt, /## Council member[\s\S]*### The council skill/);
  assert.equal(by.claude.agent, 'architecture-reviewer');
  const recorded = fs.readFileSync(path.join(dir, '.factory/metrics/council-rounds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recorded.at(-1).stage, 'architectureReview');
  assert.deepEqual(recorded.at(-1).members.map((m) => [m.name, m.login]), [['opus', 'default'], ['sol', 'CODEX_HOME=~/.codex-second'], ['tests', 'default']], 'which login each member used, as configured');
  assert.equal(recorded.at(-1).pass, false);

  // `factory council check` validates the same configuration.
  const check = spawnSync(process.execPath, [path.join(INSTALL, 'bin/factory.mjs'), 'council', 'check'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Council configuration: OK\nPool: opus \(claude, claude-opus-5-5, Anthropic\); sol \(codex, gpt-6\.1-sol, OpenAI\); tests \(copilot, claude-sonnet-5\.5, Anthropic\)\n[\s\S]*- architectureReview \(3 seats\): opus \(opus, Anthropic, correctness\), sol \(sol, OpenAI, security\), tests \(tests, Anthropic, rewrite\) \(5 round\(s\), pass 9\/10, blockQuorum any, onUnavailable fail\)/);
});

test('factory council review: a member whose CLI is unavailable fails the round under fail and is reported under report', { skip: skipOnWindows }, () => {
  const bin = fakeClis();
  for (const onUnavailable of ['fail', 'report']) {
    const council = { onUnavailable, members: [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', lens: 'correctness' }], stages: { architectureReview: {} } };
    const dir = councilRepo(council);
    const script = path.join(dir, '..', `${path.basename(dir)}-script.json`);
    fs.writeFileSync(script, JSON.stringify({ opus: [{ verdict: 'APPROVED', score: 10, findings: [] }], sol: [{ exit: 1, text: 'Claude AI usage limit reached|1700000000', stderr: 'usage limit reached' }] }));
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CLI_SCRIPT: script, FACTORY_METRICS_SPOOL: '0', FACTORY_METRICS_SHARD: '0' };
    for (const k of ['PIPELINE_AGENT_CMD', 'PIPELINE_AGENT_CLI', 'PIPELINE_CHILD', 'PIPELINE_ROOT', 'PIPELINE_OUTAGE_FILE']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(INSTALL, 'bin/factory.mjs'), 'council', 'review', '--base', 'main', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    if (onUnavailable === 'fail') {
      assert.equal(r.status, 2);
      assert.match(out.error, /sol \(codex\): provider unavailable[\s\S]*no other model is substituted/);
    } else {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(out.pass, true);
      assert.equal(out.unavailable[0].name, 'sol');
    }
    const calls = fs.readFileSync(`${script}.calls.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => c.cli).sort(), ['claude', 'codex'], 'nothing else was started in its place');
  }
});

// ---------------------------------------------------------------------------------------------
// Protected tests, late results of detached members, prompt versions
// ---------------------------------------------------------------------------------------------

test('a protected test deleted in a round is put back: another story\'s, kept for a finding, the only cover of a line; others may go', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-guard-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const files = {
    'tests/DEMO-9.spec.ts': "test('TC-DEMO-9-01 other story', () => {});\n",
    'tests/orders.spec.ts': "test('TC-DEMO-1-01 lists', () => {});\ntest('TC-DEMO-1-02 only cover', () => {});\ntest('TC-DEMO-1-03 duplicate', () => {});\n",
    'tests/kept.spec.ts': "test('TC-DEMO-1-04 regression', () => {});\n",
    'tests/bloat.spec.ts': "test('TC-DEMO-1-05 getter', () => {});\n",
  };
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  git('add', '-A');
  git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qm', 'tests');
  const from = git('rev-parse', 'HEAD').stdout.trim();
  const cases = [
    { id: 'TC-DEMO-1-01', covers: ['AC 1'], keptFor: null },
    { id: 'TC-DEMO-1-02', covers: ['AC 2'], keptFor: null },
    { id: 'TC-DEMO-1-03', covers: ['AC 1'], keptFor: null },
    { id: 'TC-DEMO-1-04', covers: ['AC 1'], keptFor: 'OPUS-2-1' },
    { id: 'TC-DEMO-1-05', covers: ['AC 1'], keptFor: null },
  ];
  fs.rmSync(path.join(dir, 'tests/DEMO-9.spec.ts'));
  fs.rmSync(path.join(dir, 'tests/kept.spec.ts'));
  fs.rmSync(path.join(dir, 'tests/bloat.spec.ts'));
  fs.writeFileSync(path.join(dir, 'tests/orders.spec.ts'), "test('TC-DEMO-1-01 lists', () => {});\n");
  const v = guardProtectedTests({ cwd: dir, from, keys: ['DEMO-1'], cases });
  assert.deepEqual(v.map((x) => [x.file, x.deleted]).sort(), [['tests/DEMO-9.spec.ts', true], ['tests/kept.spec.ts', true], ['tests/orders.spec.ts', false]]);
  assert.match(v.find((x) => x.file === 'tests/orders.spec.ts').reasons.join(), /only cover for acceptance line\(s\): AC 2/);
  for (const f of ['tests/DEMO-9.spec.ts', 'tests/kept.spec.ts', 'tests/orders.spec.ts']) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), files[f], `${f} restored`);
  assert.equal(fs.existsSync(path.join(dir, 'tests/bloat.spec.ts')), false, 'an unprotected test may be deleted');
  assert.match(protectedTestFinding(v[0]).issue, /The harness restored the file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a detached member (council-member.mjs) that finishes after its round leaves its result for the next round, once', { skip: skipOnWindows }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-late-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const agentScript = path.join(dir, 'agent.mjs');
  fs.writeFileSync(agentScript, "await new Promise((r) => setTimeout(r, 1500)); console.log('AGENT_RESULT: ' + JSON.stringify({ verdict: 'CHANGES_REQUESTED', score: 3, findings: [{ severity: 'major', file: 'a.js', issue: 'one function would do' }] }));\n");
  const saved = process.env.PIPELINE_AGENT_CMD;
  process.env.PIPELINE_AGENT_CMD = `"${process.execPath}" "${agentScript}"`;
  try {
    const member = { name: 'slow', cli: 'claude', model: 'opus', lens: 'rewrite', blocking: false };
    const lateDir = path.join(dir, '.factory/state/council/review-X-1');
    const pending = runDetachedMember({ root: dir, stageDir: 'review', dir: lateDir, round: 1, member, run: { name: 'architecture-reviewer', mode: 'read', task: 'review' } });
    // The round ends without it; its process keeps running and writes its result.
    const parse = (o) => {
      const r = JSON.parse(o.slice(o.indexOf('{')));
      return { score: r.score, verdict: r.verdict, findings: r.findings };
    };
    assert.deepEqual(takeLate(lateDir, 2, [member], parse), [], 'not finished yet');
    const res = await pending;
    assert.equal(res.status, 0);
    const late = takeLate(lateDir, 2, [member], parse);
    assert.equal(late.length, 1);
    assert.equal(late[0].findings[0].text, 'one function would do');
    assert.deepEqual(takeLate(lateDir, 2, [member], parse), [], 'consumed once');
    const merged = mergeCouncil(seatedCouncil(poolSettings([{ name: 'a', cli: 'claude', model: 'opus' }, member]), 'architectureReview', [{ name: 'a', cli: 'claude', model: 'opus', lens: 'correctness' }, member]), [{ member: { name: 'a', cli: 'claude', lens: 'correctness', blocking: true }, status: 'ok', score: 10, verdict: 'APPROVED', findings: [] }], { feedback: late });
    assert.equal(merged.pass, true);
    assert.equal(merged.notes[0].feedback, true);
  } finally {
    if (saved === undefined) delete process.env.PIPELINE_AGENT_CMD;
    else process.env.PIPELINE_AGENT_CMD = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt versions: without a council the acting agents\' definitions carry no council text, and a council never changes them', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-prompts-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const plain = loadConfig('implement', dir);
  const withCouncil = { ...plain, ...councilSettings({ members, stages: { pairVerify: {}, architectureReview: {}, testAutomation: {}, prCheck: {} } }) };
  for (const name of ['implementer', 'pair-implementer', 'pr-check-fixer', 'test-automation']) {
    const def = agentDefinition(plain, name);
    assert.doesNotMatch(def.body, /Council findings|DELETE TEST|council/i, `${name}'s definition has no council text`);
    // The version is the hash of the shipped definition alone (no addendum or lessons here), exactly as before councils.
    assert.equal(def.version, sha(`${fs.readFileSync(path.join(INSTALL, 'agents', `${name}.agent.md`), 'utf8')}\n`, 8));
    assert.equal(agentDefinition(withCouncil, name).version, def.version, 'the council adds to the task, never to the definition');
  }
  assert.match(councilActionsText(), /^### Council findings: deleting tests and rewrites[\s\S]*DELETE TEST[\s\S]*REWRITE[\s\S]*or your `owns`/);
  assert.doesNotMatch(councilActionsText({ owns: false, refuse: 'put the finding in `notFixed`' }), /your `owns`/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pool entry\'s env: CLI settings such as a login home, expanded per run; never a literal secret; the harness\'s variables are off limits', () => {
  const pool = poolSettings(members).models.pool;
  const withEnv = (env) => poolProblems({ models: { pool: [...pool, { name: 'x', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', env }], agents: { default: 'opus' } } }).join('\n');
  assert.equal(withEnv({ CODEX_HOME: '~/.codex-personal', OPENAI_API_KEY: '${MY_KEY}' }), '');
  // Key-shaped strings are built from parts, so no file holds one.
  assert.match(withEnv({ OPENAI_API_KEY: ['sk', 'live', 'abcdefghijk'].join('-') }), /env\.OPENAI_API_KEY looks like a secret: put the value in the environment and write "\$\{OPENAI_API_KEY\}" here/);
  assert.match(withEnv({ GH_TOKEN: 'abc' }), /env\.GH_TOKEN looks like a secret/);
  assert.match(withEnv({ SOMETHING: ['ghp', 'abcdefghijklmnopq'].join('_') }), /env\.SOMETHING holds what looks like a credential/);
  assert.match(withEnv({ PIPELINE_ROOT: '/x' }), /env\.PIPELINE_ROOT is the harness's own variable/);
  assert.match(withEnv({ CODEX_HOME: 3 }), /env\.CODEX_HOME must be a string/);
  assert.match(withEnv('~/.codex'), /env must be an object/);
  assert.deepEqual(envProblems({ CLAUDE_CONFIG_DIR: '${HOME}/.claude-second' }, 'e'), []);

  assert.deepEqual(agentEnv({ CODEX_HOME: '~/.codex-personal', KEY: '${MY_KEY}', DIR: '${BASE}/x' }, { MY_KEY: 's3cret', BASE: '/b' }, '/home/me'), { CODEX_HOME: '/home/me/.codex-personal', KEY: 's3cret', DIR: '/b/x' });
  assert.throws(() => agentEnv({ KEY: '${UNSET_VAR_X}' }, {}), /env\.KEY needs the environment variable UNSET_VAR_X, which is not set/);
  assert.equal(memberLogin({ env: { CODEX_HOME: '~/.codex-personal', OPENAI_API_KEY: '${MY_KEY}' } }), 'CODEX_HOME=~/.codex-personal', 'the home as configured; nothing else, never a value read from the environment');
  assert.equal(memberLogin({}), 'default');
  assert.deepEqual(memberRunEnv({ name: 'sol', env: { CODEX_HOME: '/h' } }), { PIPELINE_COUNCIL_MEMBER: 'sol', PIPELINE_COUNCIL_LOGIN: 'CODEX_HOME=/h' }, 'the entry\'s env itself comes with its pool entry');
});

test('doctor and council check probe each pool entry with its own env (a second login home)', () => {
  const config = poolSettings([{ name: 'sol', cli: 'codex', model: 'sol', env: { CODEX_HOME: '~/.codex-personal' } }]);
  const seen = [];
  const rows = councilDoctorRows(config, { probe: (cmd, args, env) => (seen.push([cmd, args.join(' '), env.CODEX_HOME]), !(args[0] === 'login' && env.CODEX_HOME !== path.join(os.homedir(), '.codex-personal'))), env: { CODEX_HOME: '/default/home' }, versionOf: () => 'codex-cli 0.167.1' });
  assert.deepEqual(seen.find((s) => s[1] === 'login status'), ['codex', 'login status', path.join(os.homedir(), '.codex-personal')]);
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[1]]), [
    ['pool entry sol (codex, gpt-6.1-sol, family OpenAI, CODEX_HOME=~/.codex-personal): CLI installed', true],
    ['pool entry sol (codex, gpt-6.1-sol, family OpenAI, CODEX_HOME=~/.codex-personal): CLI version runs the factory guard', true],
    ['pool entry sol (codex, gpt-6.1-sol, family OpenAI, CODEX_HOME=~/.codex-personal): signed in', true],
  ]);
});

// The council's builder left it open: doctor did not check the Codex version, and a codex older than 0.167.1 runs a
// member without the factory's inline guard.
test('doctor checks that a Codex member\'s CLI is new enough to run the factory guard', async () => {
  const { versionAtLeast } = await import('../lib/council.mjs');
  const config = poolSettings([{ name: 'sol', cli: 'codex', model: 'sol' }]);
  const row = (v) => councilDoctorRows(config, { probe: () => true, env: {}, versionOf: () => v }).find((r) => /CLI version/.test(r[0]));
  assert.equal(row('codex-cli 0.167.1')[1], true);
  assert.equal(row('codex-cli 0.170.0')[1], true);
  assert.equal(row('codex-cli 0.166.9')[1], false);
  assert.match(row('codex-cli 0.166.9')[2], /0\.167\.1 or later is needed for the inline PreToolUse guard/);
  assert.equal(versionAtLeast('nonsense', '0.167.1'), false);
});

// Dogfood C14 TYPE-1: a member's blocking finding about format errors on main's lines of a file the story touched cost two
// pair rounds before a dispute settled it. The harness applies rule 3 itself.
test('rule 3 by the harness: a finding on a line the change did not touch is a note and a follow-up; on a changed line, or citing one, it stands', async () => {
  const { changedLines, outsideChange } = await import('../lib/council.mjs');
  const diff = ['diff --git a/src/Catalog.API/Apis/CatalogApi.cs b/src/Catalog.API/Apis/CatalogApi.cs', '--- a/src/Catalog.API/Apis/CatalogApi.cs', '+++ b/src/Catalog.API/Apis/CatalogApi.cs', '@@ -230,0 +231,4 @@', '+a', '+b', '+c', '+d', ''].join('\n');
  const changed = changedLines(diff);
  assert.deepEqual([...changed.files.get('src/Catalog.API/Apis/CatalogApi.cs')], [231, 232, 233, 234]);
  const c = council3();
  const [a, b, cc] = c.members;
  const at = (line, extra = {}) => ({ severity: 'blocking', lens: 'correctness', action: 'fix', file: '/x/eShop-factory-test-worktrees/type-1/src/Catalog.API/Apis/CatalogApi.cs', line, issue: 'dotnet format fails', evidence: 'dotnet format --verify-no-changes', ...extra });
  const run = (f, opts = { changed }) => mergeCouncil(c, [ok(a, 9), ok(b, 9, [f]), ok(cc, 9)], opts);
  const m = run(at(91));
  assert.equal(m.findings.length, 0, 'not blocking');
  assert.match(m.notes[0].notUpheld, /rule 3: .*CatalogApi\.cs:91 is a line the change did not touch/);
  assert.ok(m.followUps.some((u) => /rule 3/.test(u.reason)));
  assert.equal(m.pass, true);
  assert.equal(run(at(233)).findings.length, 1, 'on a changed line it stands');
  assert.equal(run(at(91, { evidence: 'called from src/Catalog.API/Apis/CatalogApi.cs:232' })).findings.length, 1, 'citing a changed line it stands');
  assert.equal(run(at(91, { lens: 'acceptance' })).findings.length, 1, 'acceptance is left to the members');
  assert.equal(run(at(91), {}).findings.length, 1, 'without the change\'s lines nothing is demoted');
  assert.equal(outsideChange({ ...at(10), file: 'src/Other.cs' }, changed), false, 'a file the change did not touch is left to the members');
});

test('a member whose result a later round already took is not run again: consumed is its answer, never a retry', async () => {
  const council = { stage: 'review', members: [{ name: 'a', blocking: true, lens: 'correctness' }, { name: 'late', blocking: true, lens: 'rewrite' }] };
  const calls = { a: 0, late: 0 };
  const run = async (m) => {
    calls[m.name]++;
    return m.name === 'late' ? { status: 1, output: '', consumed: true } : { status: 0, output: 'AGENT_RESULT: {"verdict":"APPROVED","score":10,"findings":[]}' };
  };
  const parse = (out) => (/AGENT_RESULT/.test(out) ? { verdict: 'APPROVED', score: 10, findings: [] } : null);
  const r = await runCouncil({ council, run, parse, taskFor: () => 'task', retries: 2, log: () => {} });
  assert.equal(calls.late, 1, 'not retried');
  assert.equal(r.results.find((x) => x.member.name === 'late').status, 'consumed');
});

test('UI pair members are checked for an unchanged tree too; only the declared artifact folders may change (council C10, Opus 2)', async () => {
  const { uiArtifactDirs } = await import('../../implement/lib/orchestrate.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-tree-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.cs'), 'class A {}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const council = { stage: 'pairUiVerify', members: [{ name: 'sol', blocking: true, lens: 'correctness' }] };
  const parse = () => ({ verdict: 'APPROVED', score: 10, findings: [] });
  const readOnly = { cwd: root, exclude: ['.factory/metrics', '.factory/state', ...uiArtifactDirs({})] };
  const screenshot = await runCouncil({ council, parse, taskFor: () => 't', readOnly, log: () => {}, run: async () => {
    fs.mkdirSync(path.join(root, 'artifacts/pairs/K-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts/pairs/K-1/home.png'), 'png');
    return { status: 0, output: 'AGENT_RESULT: {}' };
  } });
  assert.equal(screenshot.violation, undefined, 'a screenshot in artifacts/ is allowed');
  const edit = await runCouncil({ council, parse, taskFor: () => 't', readOnly, log: () => {}, run: async () => {
    fs.writeFileSync(path.join(root, 'src/a.cs'), 'class A { int x; }\n');
    return { status: 0, output: 'AGENT_RESULT: {}' };
  } });
  assert.match(edit.violation, /changed the working tree/);
  assert.deepEqual(uiArtifactDirs({ implement: { ui: { artifactDirs: ['out/shots'] } } }), ['out/shots']);
});

test('the council table counts executions apart from sittings, labels the PR check by its judge, and says when earlier rounds never reached the council (council C10)', () => {
  const m = (name, score, extra = {}) => ({ name, cli: name === 'sol' ? 'codex' : 'claude', lens: 'test-value', blocking: true, status: 'ok', score, ...extra });
  const recs = [
    { ts: '1', stage: 'testPlan', story: 'K-1', round: 2, pass: true, members: [m('opus', 10), m('sol', 10)] },
    { ts: '2', stage: 'prCheck', story: 'K-1', round: 1, pass: true, members: [m('opus', 10), m('sol', 8, { attempts: 2 })] },
  ];
  const t = councilReviewSection(recs);
  assert.match(t, /Round 1 did not reach the council \(the harness's checks before the members sit sent it back\)/);
  assert.match(t, /member executions: 3 for 2 seat\(s\)/);
  assert.match(t, /8\/10 \(test-value, 2 executions\)/);
  assert.match(t, /The critics' scores are inputs: the judge rules each finding/);
  assert.match(t, /\| Judge's ruling \| PASS \|/);
  assert.match(t, /\| Result \| pass \|/, 'other stages keep their result row');
});

// Held-out C19 replay (EVT-1, pair UI after the PR check's return): Sol blocked with "Acceptance requires a passing
// Application.UnitTests run; no passing result could be established", naming a project file without a line and, as its
// "screenshot", a text file of its own test run that it cancelled. No file and line, no command output of a finished
// run, no screenshot: rule 4 makes it a question, and it starts no fix cycle.
test('evidence or nothing: a finding with no file and line, command output or screenshot is a question, never a block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-evidence-'));
  fs.mkdirSync(path.join(dir, 'artifacts/sol'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts/sol/unit-tests.txt'), 'Running tests from tests/Application.UnitTests/bin/Debug/net10.0/Application.UnitTests.dll (net10.0|arm64)\n\nCanceling the test session...\n');
  const c = council3();
  const [a, b, cc] = c.members;
  const noise = { id: 'SOL-R1-UNIT', severity: 'blocking', category: 'acceptance', file: 'tests/Application.UnitTests/Application.UnitTests.csproj', line: null, screenshot: 'artifacts/sol/unit-tests.txt', reason: 'Acceptance requires a passing Application.UnitTests run; no passing result could be established.', issue: 'Acceptance requires a passing Application.UnitTests run; no passing result could be established.', fix: 'Run the required suite to completion and provide passing output.' };
  const m = mergeCouncil(c, [ok(a, 10), ok(b, 4, [noise]), ok(cc, 10)], { root: dir });
  assert.equal(m.pass, true, 'it blocks nothing and starts no fix cycle');
  assert.equal(m.findings.length, 0);
  assert.equal(m.notes[0].noEvidence, true);
  assert.match(m.notes[0].notUpheld, /evidence or nothing/);
  assert.deepEqual(m.questions.map((q) => q.id), ['SOL-R1-UNIT']);
  // The same claim with evidence blocks: a line, a finished run's output, or a screenshot that exists.
  assert.equal(mergeCouncil(c, [ok(a, 10), ok(b, 4, [{ ...noise, line: 3 }]), ok(cc, 10)], { root: dir }).pass, false);
  fs.writeFileSync(path.join(dir, 'artifacts/sol/failed.txt'), 'Failed!  - Failed:     1, Passed:   140, Skipped:     0, Total:   141\n');
  assert.equal(mergeCouncil(c, [ok(a, 10), ok(b, 4, [{ ...noise, screenshot: 'artifacts/sol/failed.txt' }]), ok(cc, 10)], { root: dir }).pass, false);
  fs.writeFileSync(path.join(dir, 'artifacts/sol/page.png'), 'png');
  assert.equal(mergeCouncil(c, [ok(a, 10), ok(b, 4, [{ ...noise, screenshot: 'artifacts/sol/page.png' }]), ok(cc, 10)], { root: dir }).pass, false);
  assert.equal(mergeCouncil(c, [ok(a, 10), ok(b, 4, [{ ...noise, screenshot: null, evidence: '`dotnet test` exits 1: OrderTests.Pays failed (expected 200, got 500)' }]), ok(cc, 10)], { root: dir }).pass, false);
});

// Council r1 (sol-11): a detached non-blocking member never keeps the stage's process alive (the review's Stop hook).
test('a detached member nobody waits for does not hold the stage process open (the review passes hold: false without a discussion)', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-detached-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const council = new URL('../lib/council.mjs', import.meta.url).href;
  const script = `import { runDetachedMember } from ${JSON.stringify(council)};
runDetachedMember({ root: ${JSON.stringify(dir)}, stageDir: 'review', dir: ${JSON.stringify(dir)}, round: 1, member: { name: 'shadow' }, run: { timeoutSec: 600 }, pollMs: 20, spawnImpl: () => {}, hold: false }).then(() => console.log('resolved'));
console.log('round over');`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'round over', 'the process ended with the member still running');
  assert.ok(Date.now() - t0 < 10_000);
});

// Council r1 (sol-16): a non-blocking member on time, with another defect on the same line, took over the blocking
// members' finding (its text, and credit for raising it). Proximity alone never makes a feedback finding the same.
test('a non-blocking member\'s different defect on the same line stays feedback; the blocking finding keeps its text and raisers', () => {
  const m = (name, blocking, lens) => ({ name, cli: 'claude', lens, blocking });
  const c = { stage: 'prCheck', maxCouncilRounds: 6, councilPassScore: 9.5, blockQuorum: 'any', onUnavailable: 'fail', members: [m('slow', false, 'rewrite'), m('opus', true, 'correctness'), m('sol', true, 'security')] };
  const [slow, opus, sol] = c.members;
  const expired = { severity: 'blocking', title: 'Expired coupon is accepted', detail: 'AC 2 says 400', file: 'src/Basket/Coupons.cs', line: 1, resolves: 'code' };
  const one = (member, score, findings) => ({ member, status: 'ok', score, verdict: 'CHANGES_REQUESTED', summary: '', findings: findings.map((f) => normalizeFinding(f, member)) });
  const helper = { severity: 'major', title: 'The coupon helper could be one function', file: 'src/Basket/Coupons.cs', line: 1, resolves: 'code' };
  const merged = mergeCouncil(c, [one(slow, 3, [helper]), one(opus, 5, [expired]), one(sol, 6, [{ ...expired, title: 'Expired coupons pass the check' }])]);
  assert.deepEqual(merged.findings.map((f) => [f.text, f.members]), [['Expired coupon is accepted', ['opus', 'sol']]]);
  assert.deepEqual(merged.notes.map((f) => [f.text, f.members]), [['The coupon helper could be one function', ['slow']]]);
  // The same defect in similar words does join, and the blocking member's text leads.
  const same = mergeCouncil(c, [one(slow, 3, [{ ...expired, title: 'An expired coupon is accepted' }]), one(opus, 5, [expired])]);
  assert.deepEqual(same.findings.map((f) => [f.text, f.members]), [['Expired coupon is accepted', ['opus', 'slow']]]);
});

// Council r4 (A4): a member with no time limit of its own runs under the stage's verifier time limit (as documented
// for models.pool[].timeoutSec), never a time written in the council command.
test('factory council review: a member with no time limit of its own is stopped at the stage\'s verifier time limit', { skip: skipOnWindows }, () => {
  const bin = fakeClis();
  const council = { members: [{ name: 'opus', cli: 'claude', model: 'opus', effort: 'high', lens: 'correctness' }, { name: 'sol', cli: 'codex', model: 'sol', effort: 'high', lens: 'security' }], stages: { architectureReview: {} } };
  const dir = councilRepo(council);
  const file = path.join(dir, '.factory/config.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...settings, architectureReview: { ...settings.architectureReview, timeoutSec: 2 } }, null, 2));
  const script = path.join(dir, '..', `${path.basename(dir)}-script.json`);
  fs.writeFileSync(script, JSON.stringify({ opus: [{ verdict: 'APPROVED', score: 10, findings: [] }], sol: [{ delayMs: 15000, verdict: 'APPROVED', score: 10, findings: [] }] }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CLI_SCRIPT: script, FACTORY_METRICS_SPOOL: '0', FACTORY_METRICS_SHARD: '0', PIPELINE_CEILING_FACTOR: '1' };
  for (const k of ['PIPELINE_AGENT_CMD', 'PIPELINE_AGENT_CLI', 'PIPELINE_CHILD', 'PIPELINE_ROOT', 'PIPELINE_MODEL_OVERRIDE']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(INSTALL, 'bin/factory.mjs'), 'council', 'review', '--stage', 'architectureReview', '--base', 'main', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual(out.members.map((m) => [m.name, m.status === 'ok']), [['opus', true], ['sol', false]], r.stderr.slice(-1500));
});

// Council r5 (sol-31): every stage the documented by-hand examples name runs on default settings (the docs named a
// `review` stage that does not exist, and the default one-seat PR check had no critic for its member's lens `all`).
test('every documented `factory council review --stage` example runs on default settings', { skip: skipOnWindows }, () => {
  const doc = fs.readFileSync(path.join(INSTALL, 'docs/ai-pipeline/council.md'), 'utf8');
  const block = doc.slice(doc.indexOf('## By hand'));
  const stages = [...new Set([...block.slice(0, block.indexOf('```', block.indexOf('```bash') + 7)).matchAll(/factory council review --stage (\S+)/g)].map((m) => m[1]))];
  assert.ok(stages.length >= 2, stages.join(', '));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-byhand-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n.factory/metrics/\n');
  fs.writeFileSync(path.join(dir, '.factory/config.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat/x');
  fs.writeFileSync(path.join(dir, 'a.js'), 'y\n');
  git('commit', '-qam', 'change');
  const script = path.join(dir, '..', `${path.basename(dir)}-byhand.json`);
  const ok = { result: { verdict: 'APPROVED', score: 10, summary: 'ok', coverage: [], findings: [] } };
  fs.writeFileSync(script, JSON.stringify({ 'architecture-reviewer': [ok], 'pr-check-acceptance': [ok], 'pair-verifier': [ok], 'test-plan-verifier': [ok], 'test-automation-verifier': [ok] }));
  const env = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${path.join(here, 'fixtures', 'fake-agent.mjs')}"`, PIPELINE_FAKE_SCRIPT: script, FACTORY_METRICS_SPOOL: '0', FACTORY_METRICS_SHARD: '0' };
  for (const k of ['PIPELINE_AGENT_CLI', 'PIPELINE_CHILD', 'PIPELINE_ROOT', 'PIPELINE_MODEL_OVERRIDE']) delete env[k];
  try {
    for (const stage of stages) {
      const r = spawnSync(process.execPath, [path.join(INSTALL, 'bin/factory.mjs'), 'council', 'review', '--stage', stage, '--base', 'main', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
      assert.ok([0, 1].includes(r.status), `${stage}: exit ${r.status}\n${r.stderr.slice(-800)}`);
      const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      assert.ok(out.members.length && out.members.every((m) => m.status === 'ok'), `${stage}: ${JSON.stringify(out.members)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(script, { force: true });
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(script + suffix, { force: true });
  }
});
