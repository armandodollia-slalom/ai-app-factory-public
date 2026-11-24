// GEN-8: every verifier stage is a council, under the stage's own round limit and pass score, whatever its size. A
// council of one gets the member rules without the parts that need other members; the PR check reads one round limit in
// every caller and passes at one score for one member or three.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { COUNCIL_STAGES } from '../lib/council-config.mjs';
import { councilFor, memberTask, mergeCouncil, skillText } from '../lib/council.mjs';
import { hookStop, reviewMaxRounds } from '../../review/lib/review.mjs';
import { councilOutcome, decidePass, prCheckAccepted, prCheckPassed, scoreRound } from '../../pr-check/lib/loop.mjs';
import { fixBeforePr } from '../../implement/lib/implement.mjs';
import { poolSettings } from './fixtures/pool.mjs';
import { ciGate } from '../../implement/lib/ci-wait.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// Three pool entries from two families, seated three to a council in every stage.
const THREE = {
  ...poolSettings([{ name: 'opus', cli: 'claude', model: 'opus' }, { name: 'sol', cli: 'codex', model: 'sol' }, { name: 'tests', cli: 'claude', model: 'sonnet' }]),
  ...Object.fromEntries([...new Set(Object.values(COUNCIL_STAGES).map((s) => s.section))].map((section) => [section, { councilMembers: 3 }])),
};
const demoted = (text) => text.replace(/^#{1,2} /gm, (h) => `#${h}`);

// The member rules a council of one keeps, and the parts that need other members (or are the orchestrator's).
const KEPT = [/None of this code is precious/, /\*\*No nits\.\*\*/, /\*\*No major scope creep\.\*\*/, /behaviour the ticket does not ask for[\s\S]*is a blocking finding/, /\*\*Evidence or nothing\.\*\*/, /### Useless tests/, /### Rewrite/, /`score`: 0-10[^\n]*one decimal place is allowed/, /`resolves`/, /`delete-test`/, /`followUps`/];
const LEFT_OUT = [/council members who review this change independently/, /Look through it first/, /### Lenses/, /Work alone/, /### Discussion/, /non-blocking/, /### Before the council sits/, /### Seating/, /### Merging results/, /### Pull request/, /### Council review/, /### By hand/];

// Every line of the skill a sole member goes without: the sections it leaves out and the whole of rule 5 (work alone).
const skillLines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l.length > 24 && !/^[|#-]/.test(l));
const SKILL = skillText();
const leftOutLines = [
  ...SKILL.split(/^(?=## )/m).filter((sec) => /^## (Before the council sits|Seating|Lenses|Discussion|Merging results|Pull request|Council review|By hand)/.test(sec)).flatMap(skillLines),
  ...skillLines(/^5\. \*\*Work alone[\s\S]*?(?=\n\n|\n\d+\. |\n## )/m.exec(SKILL)[0]),
].filter((l) => !skillLines(SKILL.split(/^(?=## )/m).filter((sec) => !/^## (Before the council sits|Seating|Lenses|Discussion|Merging results|Pull request|Council review|By hand)|^# Council\n/.test(sec)).join('\n').replace(/^5\. \*\*Work alone[\s\S]*?(?=\n\n|\n\d+\. |\n## )/m, '')).includes(l));

test('no council settings: every verifier stage seats one member, whose task holds the kept rules and none of the parts that need other members', () => {
  for (const stage of Object.keys(COUNCIL_STAGES)) {
    const c = councilFor({}, stage);
    assert.deepEqual([c.sole, c.members.length, c.members[0].lens, c.members[0].blocking], [true, 1, 'all', true], stage);
    const t = memberTask('STAGE TASK', { council: c, member: c.members[0], round: 1 });
    assert.match(t, /You are the council's only member: you review the change through every lens/, stage);
    for (const re of KEPT) assert.match(t, re, `${stage} keeps ${re}`);
    for (const re of LEFT_OUT) assert.doesNotMatch(t, re, `${stage} leaves out ${re}`);
    // Council r2 (A14): none of the left-out text, line by line (rule 5 ran on past its first line).
    for (const line of leftOutLines) assert.ok(!t.includes(line), `${stage} still has: ${line}`);
    // It still rules on the implementer's disputes.
    assert.match(memberTask('STAGE TASK', { council: c, member: c.members[0], round: 2, disputes: '- f1 (nit): "rename x"' }), /Rule on each in `disputes: [\s\S]*- f1 \(nit\)/, stage);
  }
});

test('three members: each member\'s task is the full member task, with the seat list, its own lens and the whole council skill', () => {
  const skill = skillText();
  for (const stage of Object.keys(COUNCIL_STAGES)) {
    const c = councilFor(THREE, stage);
    assert.equal(c.sole, false);
    assert.deepEqual(c.members.map((m) => m.name), ['opus', 'sol', 'tests']);
    for (const m of c.members) {
      const t = memberTask('STAGE TASK', { council: c, member: m, round: 1, skill });
      assert.match(t, new RegExp(`You are one of 3 council members who review this change independently: opus \\(${c.members[0].lens}\\), sol \\(${c.members[1].lens}\\), tests \\(${c.members[2].lens}\\)\\.`));
      assert.match(t, new RegExp(`You are \\*\\*${m.name}\\*\\*; your lens is \\*\\*${m.lens}\\*\\*`));
      assert.ok(t.includes(demoted(skill)), `${stage}/${m.name}: the whole skill`);
      assert.match(t, /one decimal place is allowed/);
    }
  }
});

test('architectureReview.maxCouncilRounds 5 with three members: a review not passed by round 5 escalates instead of sitting again', async (t) => {
  const dir = tmp(t, 'arch-rounds-');
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ ...THREE, architectureReview: { maxCouncilRounds: 5, councilMembers: 3 } }));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n.factory/metrics/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  g('switch', '-q', '-c', 'feature/demo-1');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.cs'), '// a\n');
  const config = { ...loadConfig('review', dir), baseRef: 'main' };
  assert.equal(councilFor(config, 'architectureReview').members.length, 3);
  assert.equal(reviewMaxRounds(config), 5);
  const stateFile = path.join(dir, '.factory/state/stories/DEMO-1.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ key: 'DEMO-1', done: { hash: 'x' }, review: { rounds: 5, lastHash: 'older', lastVerdict: 'CHANGES_REQUESTED', lastReason: 'still open' } }));
  const out = await hookStop(config, { key: 'DEMO-1' }, {});
  assert.match(JSON.stringify(out), /was not approved after 5 architecture review rounds/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).review.lastVerdict, 'ESCALATED');
  assert.ok(fs.existsSync(path.join(dir, '.factory/state/escalations/DEMO-1-review.md')));
});

test('PR check with the defaults: 9.5 and no blocking finding passes and 9.4 does not, for a council of one and for three members', (t) => {
  const config = { ...loadConfig(null, ROOT), root: tmp(t, 'pr-pass-'), metricsDir: '.factory/metrics' };
  assert.equal(config.prCheck.councilPassScore, 9.5);
  // A council of one: the critic panel's score after the judge, and its upheld findings (minor never blocks).
  const minor = { id: 'STY-1-1', lens: 'style', severity: 'minor' };
  assert.equal(prCheckPassed(config, { score: 9.5, upheld: [minor] }), true);
  assert.equal(prCheckPassed(config, { score: 9.4, upheld: [] }), false);
  assert.equal(prCheckPassed(config, { score: 10, upheld: [{ ...minor, severity: 'major' }] }), false, 'a standing blocking finding holds it');
  // Three members: the same value decides, on each blocking member's lens as the judge scored it.
  const council = councilFor({ ...config, ...THREE }, 'prCheck');
  const lenses = council.members.map((m) => m.name);
  const ctx = { story: { key: 'DEMO-1' }, council, councilLenses: Object.fromEntries(council.members.map((m) => [m.name, { member: m, code: m.name.toUpperCase() }])) };
  const outcome = (scores) => {
    const merged = mergeCouncil(council, council.members.map((m, i) => ({ member: m, status: 'ok', score: scores[i], verdict: 'APPROVED', summary: '', findings: [] })));
    // A lens scores below 10 only with an upheld finding: a minor one here, which never blocks on its own.
    const upheld = lenses.filter((l, i) => scores[i] < 10).map((l) => ({ id: `${l}-1`, lens: l, severity: 'minor' }));
    const scored = { lensScores: Object.fromEntries(lenses.map((l, i) => [l, scores[i]])), upheld, questions: [] };
    councilOutcome(config, ctx, 1, lenses, { merged, failedLenses: [] }, scored);
    return prCheckPassed(config, scored);
  };
  assert.equal(outcome([9.5, 10, 9.5]), true);
  assert.equal(outcome([9.5, 9.4, 10]), false);
  // The merge on the members' own scores uses the same value.
  const merged = (scores) => mergeCouncil(council, council.members.map((m, i) => ({ member: m, status: 'ok', score: scores[i], verdict: 'APPROVED', summary: '', findings: [] }))).pass;
  assert.deepEqual([merged([9.5, 9.5, 9.5]), merged([9.5, 9.4, 9.5])], [true, false]);
});

// Council r1 (sol-01, sol-02): no path passes below the configured score, with a failed critic, or with no score.
test('the pass score holds on every path: the judge\'s 9.4 with nothing upheld is not a 10, a failed critic never passes, a member with no score does not pass', (t) => {
  const config = { ...loadConfig(null, ROOT), root: tmp(t, 'pr-gate-'), metricsDir: '.factory/metrics' };
  const scored = scoreRound({ lenses: ['acceptance', 'flow'], findings: [], rulings: [], judgeLensScores: { acceptance: 10, flow: 9.4 } });
  assert.deepEqual([scored.lensScores, scored.score, prCheckPassed(config, scored)], [{ acceptance: 10, flow: 9.4 }, 9.4, false]);
  assert.equal(scoreRound({ lenses: ['flow'], findings: [], judgeLensScores: {} }).lensScores.flow, 10, 'a lens the judge did not score and nothing upheld');
  // Council r3 (sol-01): scores the judge gave for no lens of the round, or that are not scores, leave its overall score
  // in force; a carried-over 10 never lifts the round above it.
  for (const judgeLensScores of [{ typo: 10 }, { acceptance: 'n/a' }, { acceptance: null }, { acceptance: 11 }]) {
    const r = scoreRound({ lenses: ['acceptance', 'flow'], findings: [], judgeLensScores, judgeScore: 9.4 });
    assert.deepEqual([r.score, prCheckPassed(config, { ...r, pass: undefined })], [9.4, false], JSON.stringify(judgeLensScores));
  }
  const carried = scoreRound({ lenses: ['acceptance', 'flow'], findings: [], judgeLensScores: {}, judgeScore: 9.4 });
  carried.lensScores.style = 10;
  assert.deepEqual(decidePass(config, null, carried), { score: 9.4, pass: false });
  // Council r2 (sol-01): a judge that scored no lens is taken at its overall score; no valid judging never passes; the
  // ACCEPTED end of --until needs judging, every critic, and something to defer.
  const overall = scoreRound({ lenses: ['acceptance', 'flow'], findings: [], judgeLensScores: {}, judgeScore: 9.4 });
  // Council r4 (sol-01): a lens the judge did not score takes its overall score, never a free 10.
  assert.deepEqual([overall.lensScores, overall.score, prCheckPassed(config, overall)], [{ acceptance: 9.4, flow: 9.4 }, 9.4, false]);
  const unjudged = scoreRound({ lenses: ['acceptance'], findings: [], judged: false });
  assert.deepEqual([unjudged.score, prCheckPassed(config, unjudged)], [10, false]);
  const mustFix = (f) => f.severity !== 'minor';
  const minor = { id: 'S-1', lens: 'flow', severity: 'minor' };
  assert.equal(prCheckAccepted({ ...overall, upheld: [] }, { mustFix }), false, 'nothing to defer: only the pass score passes');
  assert.equal(prCheckAccepted({ ...overall, upheld: [minor] }, { mustFix }), true);
  assert.equal(prCheckAccepted({ ...unjudged, upheld: [minor] }, { mustFix }), false, 'not judged');
  assert.equal(prCheckAccepted({ ...overall, upheld: [minor], failedLenses: ['acceptance'] }, { mustFix }), false, 'a critic failed');
  // A failed critic scores 0, and does not pass even at a pass score of 0.
  const failed = scoreRound({ lenses: ['acceptance'], findings: [], failedLenses: ['acceptance'] });
  assert.equal(prCheckPassed({ ...config, prCheck: { ...config.prCheck, councilPassScore: 0 } }, { ...failed, failedLenses: ['acceptance'] }), false);
  // Three members, nothing upheld, one lens the judge scored 9.4: the council does not pass.
  const council = councilFor({ ...config, ...THREE }, 'prCheck');
  const lenses = council.members.map((m) => m.name);
  const ctx = { story: { key: 'DEMO-1' }, council, councilLenses: Object.fromEntries(council.members.map((m) => [m.name, { member: m, code: m.name.toUpperCase() }])) };
  const merged = mergeCouncil(council, council.members.map((m) => ({ member: m, status: 'ok', score: 10, verdict: 'APPROVED', summary: '', findings: [] })));
  const three = scoreRound({ lenses, findings: [], judgeLensScores: { [lenses[0]]: 10, [lenses[1]]: 9.4, [lenses[2]]: 10 } });
  councilOutcome(config, ctx, 1, lenses, { merged, failedLenses: [] }, three);
  assert.equal(three.pass, false);
  // The shared gate: a sole member that approves with no score does not pass, and is told to give one.
  const sole = councilFor({}, 'architectureReview');
  const none = mergeCouncil(sole, [{ member: sole.members[0], status: 'ok', score: null, verdict: 'APPROVED', summary: '', findings: [] }]);
  assert.equal(none.pass, false);
  assert.match(none.findings[0].text, /verifier gave no score \(the pass score is \d/);
});

test('the PR check gets its rounds from prCheck.maxCouncilRounds in every caller: delivery, epic and CI fix pass no limit of their own; by hand --max-rounds overrides it', async (t) => {
  // Delivery (fix mode before the PR opens).
  const ran = [];
  fixBeforePr({ prCheck: { mode: 'fix', fixMinSeverity: 'major', maxCouncilRounds: 3 }, implement: { waitSec: { prCheck: 60 } } }, { key: 'B-1', worktree: '/tmp/wt', base: 'main' }, { status: 'done', openFindings: [{ id: 'F-1', lens: 'flow', severity: 'major' }] }, { runCli: (cmd, args) => (ran.push(args), { status: 0, stdout: JSON.stringify({ verdict: 'PASS', score: 10, rounds: 1 }) }) });
  // CI fix.
  const dir = tmp(t, 'pr-callers-');
  await ciGate({ gh: () => ({ stdout: '[]' }), repo: 'a/b', pr: 'p', branch: 'b', cwd: dir, prCheckCli: 'pr-check.mjs', targetArgs: [], base: 'main', seedFile: path.join(dir, 's.json'), fixRounds: 1, run: (c, args) => (ran.push(args), {}), wait: (() => { const s = ['failure', 'success']; return async () => ({ state: s.shift(), failing: ['unit'], pending: [] }); })(), flakyOf: () => [] });
  assert.equal(ran.length, 2);
  for (const args of ran) assert.ok(!args.includes('--max-rounds'), args.join(' '));
  // The epic's unit check passes none either (prCheckUnitArgs); the PR check stopping at prCheck.maxCouncilRounds, and a
  // run by hand's --max-rounds overriding it, are run end to end in pr-check.test.mjs.
  const { prCheckUnitArgs } = await import('../../implement/lib/epic.mjs');
  assert.ok(!prCheckUnitArgs({ wtConfig: {}, base: 'main' }, ['B-1'], { fix: true }).includes('--max-rounds'));
});
