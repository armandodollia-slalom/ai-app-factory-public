// Council C7 (Sol 2): #119's notice kept "confidence 90" and "PR check 10/10: met (10/10 in round 2)", and its signals
// kept prCheckScore 10, after a later check ended QUESTION 9/10. A regate rebuilds every PR check signal and the whole
// confidence from the latest check: the notice, its state, the issue's triage block and the board fields.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseState } from '../lib/gate.mjs';
import { publishGate } from '../lib/publish.mjs';
import { regate } from '../lib/sync.mjs';
import { extractTriage } from '../lib/triage-section.mjs';
import { ticketSignals } from '../lib/confidence.mjs';
import { fakeGh } from './fake-gh.mjs';
import { cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, git, low } from './helpers.mjs';

test('a regate after a later QUESTION check rebuilds the score, criteria, signals and prose from that check', () => {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3'], { 'BUG-3': { prChecks: [8, 10] } });
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(8, { labels: [], checks: [{ name: 'ci', bucket: 'pass' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, { autoMerge: { enabled: false } });
  publishGate(config, { pr: pr.url, keys: ['BUG-3'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
  const before = parseState(pr.comments[0].body);
  assert.match(pr.comments[0].body, /PR check 10\/10: met \(10\/10 in round 2\)/);
  assert.equal(before.tickets[0].signals.prCheckScore, 10);
  const scoreBefore = extractTriage(gh.issues.get(3).body).confidence.score;

  // A later check (a standalone re-check) ends QUESTION 9/10.
  fs.appendFileSync(path.join(root, '.factory/metrics/pr-checks.jsonl'), `${JSON.stringify({ ts: '2026-11-02T09:00:00Z', story: 'BUG-3', round: 1, score: 9, questions: [{ id: 'ACC-1-1', title: 't', question: 'Which landing page?' }] })}\n`);
  regate(config, gh.gh, pr.url, { prior: before });
  const notice = pr.comments.at(-1).body;
  const after = parseState(notice);
  assert.doesNotMatch(notice, /10\/10 in round 2/);
  assert.match(notice, /PR check 10\/10: unmet \(last score 9\/10\)/);
  assert.match(notice, /Needs an owner decision/);
  assert.deepEqual([after.tickets[0].signals.prCheckScore, after.tickets[0].signals.prCheckRounds, after.tickets[0].high], [9, null, false]);
  const triage = extractTriage(gh.issues.get(3).body);
  assert.ok(triage.confidence.score < scoreBefore, `${triage.confidence.score} < ${scoreBefore}`);
  assert.equal(triage.confidence.criteria.prCheck, 'unmet');
  assert.deepEqual(triage.confidence.questions, ['Which landing page?']);
  assert.match(notice, new RegExp(`confidence ${triage.confidence.score}\\b`));
});

test('a 10 that a later round undid counts nothing; the rounds count to the 10 the checks end on', () => {
  const s = (scores) => ticketSignals('B', { prChecks: scores.map((score, i) => ({ ts: String(i), story: 'B', score })) });
  assert.equal(s([8, 10]).prCheckRounds, 2);
  assert.equal(s([10, 8]).prCheckRounds, null);
  assert.equal(s([10, 8, 10]).prCheckRounds, 3);
  assert.equal(s([10, 8]).prCheckScore, 8);
});

// Council C7 (Opus 1): the probe that auto-merged a Low, high-confidence PR whose tests passed only on a retry.
test('a Low, high-confidence, green PR with a retry-only pass or an escalated fix round is never auto-merged', async () => {
  const { decideGate, gateState, renderNotice } = await import('../lib/gate.mjs');
  const a = { tickets: [{ key: 'BUG-1', issue: { number: 7 }, severity: { level: 'Low' }, confidence: { score: 95, high: true, reasons: [], questions: [] } }], severity: { level: 'Low' }, ci: 'success', class: 'Low', systems: { names: [] }, headSha: 'h1', deliveryChecked: 'h1' };
  const settings = { approvals: { Low: 0, Medium: 1, High: 1, Severe: 2 } };
  assert.equal(decideGate(a, { settings, autoMerge: { enabled: true } }).action, 'auto-merge', 'the probe as it was');
  const delivery = { state: 'flaky', outcome: 'ci-flaky', reason: 'CI green only with retries (TC-06): not delivered; the fix round escalated (r)', flaky: ['TC-06'], fixerNotes: [{ id: 'CI-FLAKY-1', title: 't', reason: 'options a, b, c' }] };
  const held = { ...a, delivery };
  const d = decideGate(held, { settings, autoMerge: { enabled: true } });
  assert.equal(d.action, 'review');
  assert.ok(d.approvals >= 1);
  assert.match(d.triggers[0], /^the delivery needs a person's decision: CI green only with retries/);
  const state = gateState(held, d, null);
  assert.equal(state.delivery.state, 'flaky');
  const notice = renderNotice(held, d, state);
  assert.match(notice, /> \*\*Needs a person's decision: not delivered\.\*\*.*`TC-06`.*on the ticket \(#7\)/);
  assert.match(notice, /CI-FLAKY-1 t: options a, b, c/);
  // A later evaluation without a new CI gate keeps it (it lives in the gate state on GitHub); a passing CI gate clears it.
  assert.equal(decideGate(a, { settings, autoMerge: { enabled: true }, prior: state }).action, 'review');
  const cleared = decideGate({ ...a, delivery: null }, { settings, autoMerge: { enabled: true }, prior: state });
  assert.equal(cleared.action, 'auto-merge');
  const esc = decideGate({ ...a, delivery: { state: 'escalated', reason: 'the fix round escalated' } }, { settings, autoMerge: { enabled: true } });
  assert.equal(esc.action, 'review');
});

test('the decision posted on the PR is the ticket\'s, without its marker or Resolved box', async () => {
  const { prDecisionComment, RESOLVED_LINE } = await import('../../board/lib/escalation.mjs');
  const body = `<!-- pipeline-escalation:{"round":1} -->\n## Pipeline escalation\n\nQ1. Which fix? (a) NotFoundPage (b) drop StreamRendering. Recommended: (a)\n\n${RESOLVED_LINE}\n`;
  const c = prDecisionComment({ key: 'ORDD-1', issue: 117, body });
  assert.match(c, /^## Needs a person's decision: ORDD-1 \(#117\)/);
  assert.match(c, /Q1\. Which fix\?/);
  assert.doesNotMatch(c, /pipeline-escalation|\*\*Resolved\*\*/);
});

// Council C7 live (#119 on 0.2.53): the ticket was already in Failed, board fail was not a transition, and the PR never
// got the decision.
test('a ticket already waiting in Failed: its latest open decision goes on the PR once', async () => {
  const { decisionForPr } = await import('../../board/lib/escalation.mjs');
  const issueComments = ['The pipeline stopped: **needs-decision** (old). Q1 (a) (b)', 'unrelated', 'The pipeline stopped: **needs-decision** (latest). Q1 (a) (b) (c)'];
  const first = decisionForPr({ key: 'BUG-34', issue: 116, applied: false, body: 'fresh', issueComments, prComments: ['## Review gate: 1 approval required'] });
  assert.match(first, /^## Needs a person's decision: BUG-34 \(#116\)[\s\S]*\(latest\)/);
  assert.equal(decisionForPr({ key: 'BUG-34', issue: 116, applied: false, body: 'fresh', issueComments, prComments: [first] }), null, 'once');
  assert.match(decisionForPr({ key: 'BUG-34', issue: 116, applied: true, body: 'fresh decision', issueComments, prComments: [first] }), /fresh decision/, 'a new failure posts its own');
});

// Council C12 (PRB-8 live): the ticket waited in Failed on a red CI ("no decision is needed from you"); a CI gate then
// found a retry-only pass and held the PR saying the options were on the ticket, but board fail posted nothing there.
test('a ticket waiting in Failed that now stops for something else gets the new decision, and its PR a new copy', async () => {
  const { supersedingStop, decisionForPr } = await import('../../board/lib/escalation.mjs');
  const red = 'The pipeline stopped: **ci-red** (CI red (test): not delivered).\n\nNo decision is needed from you.';
  const flaky = 'The pipeline stopped: **ci-flaky** (CI green only with retries (t1): not delivered).\n\nI need 1 decision from you.\n<!-- pipeline-escalation:{"key":"PRB-8"} -->';
  const posted = supersedingStop({ body: flaky, issueComments: ['Claimed', red] });
  assert.match(posted, /^The pipeline stopped: \*\*ci-flaky\*\*/);
  assert.match(posted, /This replaces the earlier stop on this ticket \(\*\*ci-red\*\* \(CI red \(test\): not delivered\)\.\); answer this one\./);
  assert.match(posted, /I need 1 decision from you\.[\s\S]*pipeline-escalation/);
  assert.equal(supersedingStop({ body: red, issueComments: ['Claimed', red] }), null, 'the same stop again posts nothing');
  assert.equal(supersedingStop({ body: flaky, issueComments: ['Claimed'] }), null, 'no earlier stop: the usual path posts it');
  const pr = decisionForPr({ key: 'PRB-8', issue: 181, applied: true, body: posted, issueComments: [red], prComments: ["## Needs a person's decision: PRB-8 (#181)\n\nred"] });
  assert.match(pr, /^## Needs a person's decision: PRB-8 \(#181\)[\s\S]*ci-flaky[\s\S]*replaces the earlier stop/);
});

// Council C11 (#154): the notice listed "confidence 81" next to a stale "confidence 73" carried from the first assessment.
test('a re-evaluation never carries a derived trigger (confidence, severity) from an earlier one', async () => {
  const { decideGate } = await import('../lib/gate.mjs');
  const a = { tickets: [{ key: 'BUG-40', issue: { number: 150 }, severity: { level: 'Medium', explanation: 'x' }, systems: [], confidence: { score: 81, high: false, reasons: ['PR check 10/10 unmet'], questions: [] } }], severity: { level: 'High', explanation: 'e' }, ci: 'success', class: 'High', systems: { names: [] } };
  const prior = { required: true, triggers: ['BUG-40 has confidence 73 (PR check 10/10 unmet; CI pending)', 'BUG-40 is Medium (x)', 'PR severity High: e', 'the PR changed after it was assessed'] };
  const d = decideGate(a, { settings: { approvals: { High: 1 } }, autoMerge: { enabled: true }, prior });
  const conf = d.triggers.filter((t) => /has confidence/.test(t));
  assert.deepEqual(conf, ['BUG-40 has confidence 81 (PR check 10/10 unmet)']);
  assert.ok(d.triggers.includes('the PR changed after it was assessed'), 'what cannot be derived again still sticks');
  assert.equal(d.triggers.filter((t) => /^BUG-40 is Medium/.test(t)).length, 1);
});

// Council C8: a run that died before its CI gate left a Low PR whose checks later went green; a `board sync` would
// have auto-merged it without the retry check. The gate runs that check itself first.
test('a regate on a green head nobody checked runs the retry check before it can merge', async () => {
  const { applyDeliveryCheck } = await import('../lib/delivery-check.mjs');
  const { decideGate } = await import('../lib/gate.mjs');
  const base = () => ({ tickets: [{ key: 'BUG-1', severity: { level: 'Low' }, confidence: { score: 95, high: true, reasons: [], questions: [] } }], severity: { level: 'Low' }, ci: 'success', class: 'Low', systems: { names: [] }, headSha: 'h2' });
  const opts = { settings: { approvals: { Low: 0 } }, autoMerge: { enabled: true } };
  const flaky = applyDeliveryCheck(base(), null, { retryCheck: () => ['[scenarios] › probe.spec.ts › TC-01'] });
  assert.equal(decideGate(flaky, opts).action, 'review');
  assert.equal(flaky.delivery.state, 'flaky');
  const clean = applyDeliveryCheck(base(), null, { retryCheck: () => [] });
  assert.equal(decideGate(clean, opts).action, 'auto-merge');
  const unknown = applyDeliveryCheck(base(), null, { retryCheck: () => { throw new Error('logs unreadable'); } });
  assert.equal(decideGate(unknown, opts).action, 'wait', 'a check that could not run holds the merge');
  const pending = applyDeliveryCheck({ ...base(), ci: 'pending' }, null, { retryCheck: () => assert.fail('not before CI is green') });
  assert.equal(decideGate(pending, opts).action, 'wait');
});

// Council C8: a regate kept the first assessment's systems, so "Other" (the pipeline's own files) stayed on #119, #130,
// #148 and #154 after the gate stopped counting them.
test('a regate recomputes the systems from the PR files with the current settings', () => {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(8, { labels: [], checks: [{ name: 'ci', bucket: 'pass' }], headRefOid: git(root, 'rev-parse', 'HEAD'), files: ['src/Basket.API/A.cs', '.factory/stack/scenarios/bug-3/scenario.yaml', '.factory/metrics/pr-checks.jsonl.d/x.jsonl'] });
  const config = gateConfigFor(root, { autoMerge: { enabled: false } });
  const prior = { required: true, triggers: [], systems: { names: ['Basket.API', 'Other'], shared: false, contract: false }, tickets: [{ key: 'BUG-3', issue: 3, signals: null }], headSha: 'old' };
  regate(config, gh.gh, pr.url, { prior, retryCheck: () => [] });
  assert.deepEqual(parseState(pr.comments.at(-1).body).systems.names, ['Basket.API']);
});
