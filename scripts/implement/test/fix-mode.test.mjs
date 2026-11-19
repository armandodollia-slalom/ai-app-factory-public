import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixBeforePr, prCheckSection } from '../lib/implement.mjs';

// Council C1: BUG-10 shipped a false 200 on a retried 404 (FLOW-1-1) and CAT-1 two major video findings,
// because a single-ticket PR opened with the report round's verdict as it was.
const reported = (severities) => ({ status: 'done', verdict: 'FAIL', score: 8, openFindings: severities.map((severity, i) => ({ id: `F-${i}`, lens: 'flow', severity, title: `t${i}` })) });
const wt = (prCheck) => ({ implement: { prCheck } });
const opts = { key: 'B-1', worktree: '/tmp/wt', base: 'origin/main' };

test('fix mode: a major finding sends the story through the fixing loop before the PR; the PR gets the final report', () => {
  const calls = [];
  const runCli = (cmd, args, o) => {
    calls.push({ args, o });
    return { status: 0, stdout: `log\n${JSON.stringify({ verdict: 'ACCEPTED', score: 9, rounds: 2, commits: ['abc1234'], openFindings: [{ id: 'STY-2-1', lens: 'style', severity: 'minor', title: 'nit' }] })}` };
  };
  const out = fixBeforePr(wt({}), opts, reported(['major', 'minor']), { runCli });
  assert.equal(calls.length, 1);
  const args = calls[0].args.slice(1);
  assert.deepEqual(args, ['run', '--story', 'B-1', '--base', 'origin/main', '--until', 'major', '--max-rounds', '3', '--fix-first', '/tmp/wt/.factory/state/pr-check/B-1/result.json', '--json']);
  assert.equal(calls[0].o.cwd, '/tmp/wt');
  assert.equal(calls[0].o.env.PIPELINE_ROOT, '/tmp/wt');
  assert.deepEqual([out.mode, out.verdict, out.score, out.rounds, out.reportScore, out.reportMajor], ['fix', 'ACCEPTED', 9, 2, 8, 1]);
  assert.match(prCheckSection(out), /fix mode, before this PR: the report round scored 8\/10 with 1 finding\(s\) to fix, then 2 fixing round\(s\) and 1 fix commit\(s\)\): ACCEPTED 9\/10/);
});

test('fix mode does nothing for minor-only findings; report mode keeps the reference behaviour', () => {
  const runCli = () => assert.fail('no fixing loop');
  const minor = reported(['minor']);
  assert.equal(fixBeforePr(wt({}), opts, minor, { runCli }), minor);
  const major = reported(['blocking']);
  assert.equal(fixBeforePr(wt({ mode: 'report' }), opts, major, { runCli }), major);
  assert.match(prCheckSection(major), /report only, before this PR\): FAIL 8\/10/);
});

test('a fixing loop that fails leaves the report round\'s verdict, with the reason', () => {
  const out = fixBeforePr(wt({}), opts, reported(['major']), { runCli: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.equal(out.verdict, 'FAIL');
  assert.match(out.fixError, /boom/);
});

// Dogfood C4: a feature paid a third fixing round for a minor video finding. A feature stops at majors; its minors
// (video ones too) go to the PR's Follow-ups. A lens named in implement.prCheck.fixLenses is still fixed at any severity.
test('a feature\'s minor findings, on any lens, go to the Follow-ups instead of a fixing round; fixLenses still forces a fix', async () => {
  const { prCheckFollowUps, followUpsSection } = await import('../lib/implement.mjs');
  let called = 0;
  const runCli = () => { called++; return { status: 0, stdout: JSON.stringify({ verdict: 'PASS', score: 10, rounds: 2, commits: ['c'], openFindings: [] }) }; };
  const video = { status: 'done', verdict: 'FAIL', score: 9, openFindings: [{ id: 'VID-1-1', lens: 'video', severity: 'minor', title: 'never shows the section' }] };
  assert.equal(fixBeforePr(wt({}), opts, video, { runCli }), video, 'no fixing round');
  assert.equal(called, 0);
  assert.match(followUpsSection(prCheckFollowUps([video])), /- never shows the section \(PR check before this PR VID-1-1, video, minor: not fixed in this PR\)/);
  assert.equal(fixBeforePr(wt({ fixLenses: ['video'] }), opts, video, { runCli }).verdict, 'PASS');
  assert.equal(called, 1);
});

// Dogfood C2: a Low bug group at 9/10 went to review: the gate auto-merges only at PR check 10/10.
test('a bug fix aims at 10/10: minor findings also go through the fixing loop (--until minor)', () => {
  const calls = [];
  const runCli = (cmd, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ verdict: 'PASS', score: 10, rounds: 2, commits: ['c'], openFindings: [] }) }; };
  const minor = { status: 'done', verdict: 'FAIL', score: 9, openFindings: [{ id: 'STY-1-1', lens: 'style', severity: 'minor', title: 'nit' }] };
  assert.equal(fixBeforePr(wt({}), { ...opts, bug: true }, minor, { runCli }).verdict, 'PASS');
  assert.ok(calls[0].includes('minor') && calls[0][calls[0].indexOf('--until') + 1] === 'minor');
  assert.equal(fixBeforePr(wt({}), opts, minor, { runCli: () => assert.fail('a feature keeps its minors') }), minor);
});

// Council C2: say in the PR what ran in full before it opened.
test('the PR body lists the whole test projects run before it, the latest run of each, with why and how it ended', async () => {
  const { fullProjectsSection } = await import('../lib/implement.mjs');
  assert.equal(fullProjectsSection([]), '');
  const text = fullProjectsSection([
    { unit: 'tests/Api.FunctionalTests', why: "holds the story's tests", status: 0 },
    { unit: 'tests/Api.UnitTests', why: 'covers api', status: 1, timedOut: false },
    { unit: 'tests/Web.Tests', why: 'covers web', status: 2, step: 'build' },
  ]);
  assert.equal(text, "- Whole test projects run before this PR, as CI runs them:\n  - `tests/Api.FunctionalTests` (holds the story's tests): passed\n  - `tests/Api.UnitTests` (covers api): failed (exit 1)\n  - `tests/Web.Tests` (covers web): did not build (exit 2)\n");
});

// Council C8: #154's body omitted the report round's side effects (`??` on an empty list) and reported the check's
// total rounds as fixing rounds.
test('fix mode keeps the report round side effects and reports its fixing rounds', () => {
  const runCli = () => ({ status: 0, stdout: JSON.stringify({ verdict: 'PASS', score: 10, rounds: 2, fixRounds: 1, commits: ['bbee105'], openFindings: [], sideEffects: [] }) });
  const prc = { ...reported(['minor']), sideEffects: ['GET /api/catalog/items: new optional sort parameter'] };
  const out = fixBeforePr(wt({ fixUntil: 'minor' }), opts, prc, { runCli });
  assert.deepEqual(out.sideEffects, ['GET /api/catalog/items: new optional sort parameter']);
  assert.match(prCheckSection(out), /then 1 fixing round\(s\) and 1 fix commit\(s\)/);
});
