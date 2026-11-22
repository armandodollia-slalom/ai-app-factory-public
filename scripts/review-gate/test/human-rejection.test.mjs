// Owner rule: once a person has rejected a delivery (changes requested, the PR closed, the card moved back, the issue
// reopened, the ticket re-queued after a person's decision), every later delivery of that ticket needs a person's
// review: it never merges itself, whatever the new rating says, and the PR says why.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { markHistoryUnknown, saveRun, startResolvedReruns } from '../../implement/lib/implement.mjs';
import { assessPr, recordTicket } from '../lib/assessment.mjs';
import { decideGate, encodeState, gateState, parseState, rejectionSection, renderNotice, withRejectionSection } from '../lib/gate.mjs';
import { publishGate } from '../lib/publish.mjs';
import { cardReopen } from '../lib/reopens.mjs';
import { withCurrentRejections } from '../lib/rejections.mjs';
import { recordClosedPrs, regate, syncGate } from '../lib/sync.mjs';
import { extractTriage, upsertTriage } from '../lib/triage-section.mjs';
import { fakeGh } from './fake-gh.mjs';
import { SETTINGS, cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, git, low } from './helpers.mjs';

const REJECTED = /rejected by a person earlier/;
const reopenRow = (key, extra = {}) => ({ ts: '2026-11-02T08:00:00Z', type: 'reopen', story: key, pr: 'https://github.com/acme/shop/pull/4', source: 'changes-requested', by: 'dana', afterMerge: false, ...extra });
const append = (root, rows) => fs.appendFileSync(path.join(root, '.factory/metrics/decision-outcomes.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));

// A group PR of BUG-1 and BUG-2 on a repo with clean pipeline records and green checks.
function groupPr({ issues = {} } = {}) {
  const root = fixRepo({ merges: [{ key: 'BUG-1', files: { 'src/Basket.API/A.cs': 'a' } }, { key: 'BUG-2', files: { 'src/Basket.API/B.cs': 'b' } }] });
  cacheTicket(root, 'BUG-1', { number: 11 });
  cacheTicket(root, 'BUG-2', { number: 12 });
  cleanMetrics(root, ['BUG-1', 'BUG-2']);
  const gh = fakeGh();
  gh.addFields();
  for (const n of [11, 12]) if (issues[n] !== null) gh.addIssue(n, { body: issues[n] ?? `story ${n}` });
  const pr = gh.addPr(9, { checks: [{ name: 'ci', bucket: 'pass' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  return { root, gh, pr, config: gateConfigFor(root), agent: fakeTriage({ 'BUG-1': low, 'BUG-2': low }) };
}

test('every kind of rejection is recorded as a reopen: the card moved back, the issue reopened, the PR closed, a re-queue after a decision', () => {
  assert.equal(cardReopen({ column: 'ready' }, { column: 'review' }).detail, 'card moved from Pending Review back to Ready');
  assert.equal(cardReopen({ column: 'backlog' }, { column: 'done' }).detail, 'card moved from Done back to Backlog');
  assert.equal(cardReopen({ column: 'review', state: 'OPEN', stateReason: 'REOPENED' }, { column: 'done' }).source, 'issue');

  // A bug the gate never rated (no Triage section, no Severity on the card), moved back to Ready.
  const w = groupPr();
  const out = syncGate(w.config, { gh: w.gh.gh, items: [{ key: 'BUG-1', number: 11, url: 'u11', column: 'ready', state: 'OPEN', severity: null, labels: [] }], metricsConfig: w.config, markerOf: () => ({ column: 'review' }), commentsOf: () => [], applyEvent: () => {}, now: '2026-11-03T00:00:00Z' });
  assert.deepEqual(out.reopens, ['BUG-1']);
  assert.equal(extractTriage(w.gh.issues.get(11).body).reopens[0].detail, 'card moved from Pending Review back to Ready');
  assert.ok(w.gh.issues.get(11).labels.includes('reopened'));

  // A gated PR closed without merge: a rejection of each ticket; one the pipeline closed for a hold is not.
  const state = { v: 1, action: 'review', approvals: 1, required: true, triggers: [], headSha: 'h1', class: 'Low', severity: 'Low', tickets: [{ key: 'BUG-2', issue: 12, severity: 'Low', high: true, reopens: 0 }], countedReviews: [] };
  for (const [n, hold] of [[21, false], [22, true]]) {
    const p = w.gh.addPr(n, { state: 'CLOSED', closedAt: '2026-11-03T05:00:00Z', labels: ['approvals:1'] });
    p.comments.push({ id: 700 + n, body: `## Review gate\n\n${encodeState(state)}` });
    p.events = [{ id: n, event: 'closed', actor: { login: hold ? 'pipeline-bot' : 'dana' }, created_at: '2026-11-03T05:00:00Z' }];
    // The pipeline's close-reopen hold, recorded by the pipeline's own identity, naming the host's event.
    if (hold) p.comments.push({ id: 800 + n, author: 'pipeline-bot', body: `<!-- factory:holds [{"type":"closed","event":${n}}] -->` });
  }
  recordClosedPrs(w.config, w.gh.gh, { metricsConfig: w.config, now: '2026-11-03T06:00:00Z' });
  const reopens = extractTriage(w.gh.issues.get(12).body).reopens;
  assert.deepEqual(reopens.map((r) => [r.source, r.pr]), [['pr-closed', 'https://github.com/acme/shop/pull/21']]);
  const closed = readJsonl(path.join(w.root, '.factory/metrics/decision-outcomes.jsonl')).filter((r) => r.type === 'pr-closed');
  assert.deepEqual(closed.map((r) => [r.pr.split('/').pop(), r.rejected ?? null]), [['21', ['BUG-2']]], 'the held PR is left for its hold to end');

  // `implement requeue` after a person resolved the escalation of a delivery that had a PR.
  const calls = [];
  const cfg = { ...w.config, board: { ...w.config.board, resolvedLabel: 'escalation-resolved' } };
  saveRun(cfg, 'BUG-1', { outcome: 'ci-failed', pr: 'https://github.com/acme/shop/pull/9' });
  saveRun(cfg, 'BUG-2', { outcome: 'review-escalated' });
  startResolvedReruns(cfg, [{ key: 'BUG-1', resolved: true }, { key: 'BUG-2', resolved: true }], { event: () => {}, recordRejection: (c, r) => calls.push(r) });
  assert.deepEqual(calls, [{ key: 'BUG-1', pr: 'https://github.com/acme/shop/pull/9' }], 'only a delivery that had a PR was rejected');
});

test('a rejection survives a re-run: an assessment from scratch, a follow-up or group PR, and changes requested not yet recorded', () => {
  // The Triage section on the issue is gone (or was never written); the metrics still hold the reopen.
  const w = groupPr();
  append(w.root, [reopenRow('BUG-1')]);
  const a = assessPr(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: w.gh.gh, runAgent: w.agent.runAgent });
  assert.deepEqual(a.tickets.map((t) => [t.key, t.reopens.length]), [['BUG-1', 1], ['BUG-2', 0]]);
  const d = decideGate({ ...withCurrentRejections(w.config, w.gh.gh, a), deliveryChecked: a.headSha, ci: 'success' }, { settings: SETTINGS, autoMerge: { enabled: true } });
  assert.equal(d.action, 'review', 'a group PR with one rejected ticket never merges itself');
  assert.ok(d.triggers.some((t) => /^BUG-1 has 1 human reopen/.test(t) && REJECTED.test(t)));
  assert.deepEqual(d.wouldAutoMerge, ['BUG-2']);

  // A follow-up PR on a new branch: the reopen recorded on the ticket by the earlier PR counts.
  const f = groupPr({ issues: { 11: upsertTriage('story 11', { v: 1, key: 'BUG-1', pr: 'https://github.com/acme/shop/pull/4', reopens: [{ at: '2026-11-02T08:00:00Z', source: 'card', pr: 'https://github.com/acme/shop/pull/4' }] }) } });
  assert.equal(assessPr(f.config, { pr: f.pr.url, keys: ['BUG-1'], base: 'main' }, { gh: f.gh.gh, runAgent: f.agent.runAgent }).tickets[0].reopens.length, 1);

  // Changes requested on the PR being assessed, before `board sync` recorded them: they count for the ticket named.
  const c = groupPr();
  c.pr.reviews.push({ id: 5, state: 'CHANGES_REQUESTED', body: 'BUG-2 still rounds wrong', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' });
  const ac = withCurrentRejections(c.config, c.gh.gh, assessPr(c.config, { pr: c.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: c.gh.gh, runAgent: c.agent.runAgent }));
  assert.deepEqual(ac.tickets.map((t) => t.reopens.length), [0, 1]);

  // A ticket that cannot be read is not taken as never rejected.
  const u = groupPr({ issues: { 12: null } });
  const au = assessPr(u.config, { pr: u.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: u.gh.gh, runAgent: u.agent.runAgent });
  const du = decideGate({ ...withCurrentRejections(u.config, u.gh.gh, au), deliveryChecked: au.headSha, ci: 'success' }, { settings: SETTINGS, autoMerge: { enabled: true } });
  assert.equal(du.action, 'review');
  assert.ok(du.triggers.some((t) => /^BUG-2 could not be checked for a rejection/.test(t)), du.triggers.join('; '));
});

test('a saved rating made before the rejection: publishing reads the reopens again and never writes them away', () => {
  const w = groupPr();
  // The rating saved before the PR opened (a resume reuses it), when nothing was rejected yet.
  const saved = assessPr(w.config, { pr: null, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: w.gh.gh, runAgent: w.agent.runAgent });
  assert.ok(saved.tickets.every((t) => !t.reopens.length));
  // Then a person rejected BUG-1 (board sync recorded it on the ticket).
  w.gh.issues.get(11).body = upsertTriage('story 11', { v: 1, key: 'BUG-1', reopens: [{ at: '2026-11-03T02:00:00Z', source: 'issue', detail: 'issue reopened' }] });
  const { assessment, decision } = publishGate(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', assessment: saved }, { gh: w.gh.gh, runAgent: () => assert.fail('no agent runs at publish') });
  assert.equal(assessment.tickets[0].reopens.length, 1);
  assert.equal(assessment.tickets[0].severity.level, 'Medium', 'the reopen bumps the saved Low');
  assert.equal(decision.action, 'review');
  assert.equal(extractTriage(w.gh.issues.get(11).body).reopens.length, 1, 'the Triage section written at publish keeps it');

  // Writing a stale assessment's triage never drops a recorded reopen.
  recordTicket(w.config, w.gh.gh, saved, saved.tickets[0]);
  assert.equal(extractTriage(w.gh.issues.get(11).body).reopens.length, 1);
});

test('the PR description and the gate comment say why a person must review', () => {
  const t = { key: 'BUG-1', impact: 'Low', fixRisk: 'Low', confidence: { score: 95 }, reopens: [{ source: 'card', detail: 'card moved from Pending Review back to Ready' }] };
  const a = { pr: 'https://github.com/acme/shop/pull/9', tickets: [{ ...t, severity: { level: 'Medium', explanation: 'x' }, confidence: { score: 95, high: true, reasons: [] }, systems: [] }], severity: { level: 'Medium', explanation: 'x' }, systems: { names: [] }, class: 'Medium', ci: 'success', headSha: 'h' };
  const d = decideGate(a, { settings: SETTINGS, autoMerge: { enabled: true } });
  const notice = renderNotice(a, d, gateState(a, d));
  assert.match(notice, REJECTED);
  assert.match(rejectionSection(a), /\*\*A person reviews this PR\*\*[\s\S]*BUG-1: rejected by a person earlier \(card moved from Pending Review back to Ready\)[\s\S]*A person's approval of this PR settles it/);
  assert.equal(rejectionSection({ tickets: [{ key: 'BUG-2', reopens: [], rejectionChecked: true }] }), null);
  // Replaced in place, and removed once nothing applies.
  const body = withRejectionSection('Fixes BUG-1.\n', rejectionSection(a));
  assert.equal(withRejectionSection(body, rejectionSection(a)), body);
  assert.equal(withRejectionSection(body, null), 'Fixes BUG-1.');
});

// ---- round 2: the adversary's reproductions, on the routes that can merge on their own ------------------------------

// A Low group PR (BUG-3, BUG-4) whose checks are pending at publish (the gate waits), then green: a regate decides.
function waitingGroup({ whoamiFail = false } = {}) {
  const root = fixRepo({ merges: [{ key: 'BUG-3', files: { 'src/Basket.API/A.cs': 'a' } }, { key: 'BUG-4', files: { 'src/Basket.API/B.cs': 'b' } }] });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cacheTicket(root, 'BUG-4', { number: 4 });
  cleanMetrics(root, ['BUG-3', 'BUG-4']);
  const gh = fakeGh();
  gh.whoamiFail = whoamiFail;
  gh.addFields();
  gh.addIssue(3, { body: 'story 3' });
  gh.addIssue(4, { body: 'story 4' });
  const pr = gh.addPr(8, { checks: [{ name: 'ci', bucket: 'pending' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, { autoMerge: { enabled: true } });
  const published = publishGate(config, { pr: pr.url, keys: ['BUG-3', 'BUG-4'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': low, 'BUG-4': low }).runAgent });
  assert.equal(published.decision.action, 'wait');
  pr.checks = [{ name: 'ci', bucket: 'pass' }];
  gh.runs = [{ databaseId: 1, conclusion: 'success' }];
  const regateNow = () => regate(config, gh.gh, pr.url, { prior: JSON.parse(/<!-- review-gate:(\{.*\}) -->/.exec(pr.comments.find((c) => c.body.includes('review-gate:')).body)[1]), delivery: null, retryCheck: () => [] });
  return { root, gh, pr, config, regateNow };
}

test('the control: a clean group PR whose checks turn green merges itself on regate', () => {
  const w = waitingGroup();
  assert.equal(w.regateNow().decision.action, 'auto-merge');
});

test('regate reads a person\'s rejection now: a live "changes requested" on one ticket, or a history it cannot read, is review', () => {
  const w = waitingGroup();
  w.pr.reviews.push({ id: 41, state: 'CHANGES_REQUESTED', body: 'BUG-4 still rounds wrong', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' });
  const d = w.regateNow().decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /^BUG-4 has 1 human reopen/.test(t)), d.triggers.join('; '));
  const u = waitingGroup();
  u.pr.eventsFail = true;
  const du = u.regateNow().decision;
  assert.equal(du.action, 'review');
  assert.ok(du.triggers.some((t) => /could not be checked for a rejection by a person earlier: the history of .* could not be read/.test(t)), du.triggers.join('; '));
});

test('a person\'s close and reopen of the PR between two syncs, or of an earlier PR of the ticket, is a rejection; the pipeline\'s recorded hold is not', () => {
  const w = waitingGroup();
  w.pr.events = [{ id: 1, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-03T02:00:00Z' }, { id: 2, event: 'reopened', actor: { login: 'dana' }, created_at: '2026-11-03T02:05:00Z' }];
  assert.equal(w.regateNow().decision.action, 'review');
  // The pipeline's own close-reopen hold, each event made by its identity and recorded by it with the event's id.
  const h = waitingGroup();
  h.pr.events = [{ id: 1, event: 'closed', actor: { login: 'pipeline-bot' }, created_at: '2026-11-03T02:00:00Z' }, { id: 2, event: 'reopened', actor: { login: 'pipeline-bot' }, created_at: '2026-11-03T02:05:00Z' }];
  h.pr.comments.push({ id: 950, author: 'pipeline-bot', body: '<!-- factory:holds [{"type":"closed","event":1}] -->' }, { id: 951, author: 'pipeline-bot', body: '<!-- factory:holds [{"type":"reopened","event":2}] -->' });
  assert.equal(h.regateNow().decision.action, 'auto-merge');
  // An earlier PR of BUG-3 a person closed, with an old hold of the pipeline recorded for another event: reviewed.
  const f = waitingGroup();
  const old = f.gh.addPr(2, { state: 'CLOSED', closedAt: '2026-11-01T00:00:00Z' });
  old.comments.push({ id: 951, author: 'pipeline-bot', body: '<!-- factory:holds [{"type":"closed","event":2}] -->' });
  old.events = [{ id: 2, event: 'closed', actor: { login: 'pipeline-bot' }, created_at: '2026-10-20T00:00:00Z' }, { id: 3, event: 'reopened', actor: { login: 'pipeline-bot' }, created_at: '2026-10-20T00:30:00Z' }, { id: 4, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-01T00:00:00Z' }];
  f.gh.issues.get(3).body = upsertTriage(f.gh.issues.get(3).body, { ...extractTriage(f.gh.issues.get(3).body), prs: [old.url, f.pr.url] });
  assert.equal(f.regateNow().decision.action, 'review');
  // A changes-requested review left on that earlier PR, never synced, counts the same way.
  const c = waitingGroup();
  const earlier = c.gh.addPr(2, { state: 'CLOSED', mergedAt: null });
  earlier.reviews.push({ id: 42, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'ann' }, submitted_at: '2026-11-01T00:00:00Z' });
  c.gh.issues.get(4).body = upsertTriage(c.gh.issues.get(4).body, { ...extractTriage(c.gh.issues.get(4).body), prs: [earlier.url, c.pr.url] });
  const dc = c.regateNow().decision;
  assert.equal(dc.action, 'review');
  assert.deepEqual(dc.wouldAutoMerge, ['BUG-3']);
});

test('a close is not consumed until every ticket\'s rejection is stored; a requeue keeps its marker when its rejection cannot be stored', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rej-persist-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gh = fakeGh();
  gh.addFields();
  const pr = gh.addPr(31, { state: 'CLOSED', closedAt: '2026-11-03T05:00:00Z', labels: ['approvals:1'] });
  pr.events = [{ id: 9, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-03T05:00:00Z' }];
  const state = { v: 1, action: 'review', approvals: 1, required: true, triggers: [], headSha: 'h1', class: 'Low', severity: 'Low', tickets: [{ key: 'BUG-5', issue: 5, severity: 'Low', high: true, reopens: 0 }], countedReviews: [] };
  pr.comments.push({ id: 960, body: `## Review gate\n\n${encodeState(state)}` });
  const config = gateConfigFor(root);
  // The ticket cannot be read: nothing is consumed.
  recordClosedPrs(config, gh.gh, { metricsConfig: config, now: '2026-11-03T06:00:00Z' });
  const rows = () => (fs.existsSync(path.join(root, '.factory/metrics/decision-outcomes.jsonl')) ? readJsonl(path.join(root, '.factory/metrics/decision-outcomes.jsonl')) : []);
  assert.deepEqual(rows().filter((r) => r.type === 'pr-closed'), []);
  // Readable again: the next sync records the rejection, then consumes the close.
  gh.addIssue(5, { body: 'story 5' });
  recordClosedPrs(config, gh.gh, { metricsConfig: config, now: '2026-11-03T07:00:00Z' });
  assert.equal(extractTriage(gh.issues.get(5).body).reopens[0].source, 'pr-closed');
  assert.equal(rows().filter((r) => r.type === 'pr-closed').length, 1);

  const cfg = { ...config, board: { ...config.board, resolvedLabel: 'escalation-resolved' } };
  saveRun(cfg, 'BUG-6', { outcome: 'ci-failed', pr: 'https://github.com/acme/shop/pull/32' });
  const events = [];
  const stories = [{ key: 'BUG-6', resolved: true }];
  startResolvedReruns(cfg, stories, { event: (root0, key, args) => events.push(args[0]), recordRejection: () => { throw new Error('tracker unreachable'); } });
  assert.deepEqual(events, [], 'escalation-resolved is not cleared');
  assert.match(stories[0].skip, /could not be recorded/);
});

// A code host for holdPr/releasePr: closes and reopens make state events by the identity the token acts as.
function holdHost({ identity = 'pipeline-bot', closeFails = false, ids = true } = {}) {
  const st = { state: 'open', comments: [], events: [], log: [] };
  const host = {
    capabilities: { drafts: false, labels: false, stateEvents: true },
    identity: () => ({ login: identity }),
    pr: {
      get: () => ({ state: st.state }),
      update: (pr, u) => {
        st.log.push(`update ${u.state}`);
        if (u.state === 'closed' && closeFails) throw new Error('refused');
        // Like `gh pr close` on a closed PR (or reopen on an open one): "already closed", exit 0, no event.
        if (u.state === st.state) return;
        st.state = u.state ?? st.state;
        st.events.push({ ...(ids ? { id: 100 + st.events.length } : {}), type: u.state === 'closed' ? 'closed' : 'reopened', at: `2026-11-03T02:0${st.events.length}:00Z`, actor: identity });
      },
      stateEvents: () => st.events,
      comments: () => st.comments,
      comment: (pr, body) => (st.log.push('comment'), st.comments.push({ author: identity, body }), {}),
    },
  };
  return { st, host };
}

test('the pipeline records its own close and reopen after the host made them, by the event\'s id; a close that failed records nothing', async () => {
  const { holdPr, releasePr, readHoldLedger } = await import('../../implement/lib/pre-open.mjs');
  const ok = holdHost();
  const h = holdPr(ok.host, 7, { mode: 'close-reopen', why: 'agents work again', sleep: () => {} });
  assert.equal(h.ok, true);
  assert.equal(h.recorded, true);
  assert.deepEqual(ok.st.log.slice(0, 2), ['update closed', 'comment'], 'recorded after the host closed it');
  assert.deepEqual(readHoldLedger(ok.host, 7).map((e) => [e.type, e.event]), [['closed', 100]]);
  assert.equal(releasePr(ok.host, 7, { mode: 'close-reopen', sleep: () => {} }), true);
  assert.deepEqual(readHoldLedger(ok.host, 7).map((e) => [e.type, e.event]), [['closed', 100], ['reopened', 101]]);
  // A close the host refused: no record is left behind to excuse a person's later close.
  const bad = holdHost({ closeFails: true });
  const hb = holdPr(bad.host, 7, { mode: 'close-reopen', why: 'x', attempts: 1, sleep: () => {} });
  assert.equal(hb.ok, false);
  assert.deepEqual(bad.st.comments, []);
  // A host with no event ids: the exact time and actor it returned name the event.
  const noIds = holdHost({ ids: false });
  holdPr(noIds.host, 7, { mode: 'close-reopen', why: 'x', sleep: () => {} });
  assert.deepEqual(readHoldLedger(noIds.host, 7), [{ type: 'closed', at: '2026-11-03T02:00:00Z', actor: 'pipeline-bot', why: 'x' }]);
});

test('a hold record counts only when the pipeline\'s own identity wrote it and made the event: a commenter\'s record, a blanket record, an unknown identity are a person\'s close (ADV2-R2-01, Sol 15)', () => {
  const events = [{ id: 1, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-03T02:00:00Z' }, { id: 2, event: 'reopened', actor: { login: 'dana' }, created_at: '2026-11-03T02:05:00Z' }];
  // Another login writes a record naming the person's events.
  const forged = waitingGroup();
  forged.pr.events = events;
  forged.pr.comments.push({ id: 960, author: 'mallory', body: '<!-- factory:holds [{"type":"closed","event":1},{"type":"reopened","event":2}] -->' });
  assert.equal(forged.regateNow().decision.action, 'review');
  // The pipeline's own record cannot excuse an event a person made, even when it names that event.
  const named = waitingGroup();
  named.pr.events = events;
  named.pr.comments.push({ id: 961, author: 'pipeline-bot', body: '<!-- factory:holds [{"type":"closed","event":1},{"type":"reopened","event":2}] -->' });
  assert.equal(named.regateNow().decision.action, 'review');
  // A blanket record of many times (the old time window) names no event: a person's close at any time is a rejection.
  const blanket = waitingGroup();
  blanket.pr.events = [{ id: 7, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-03T13:37:00Z' }];
  blanket.pr.comments.push({ id: 962, author: 'pipeline-bot', body: `<!-- factory:holds ${JSON.stringify(Array.from({ length: 160 }, (_, i) => ({ closeAt: new Date(Date.parse('2026-11-03T00:00:00Z') + i * 540_000).toISOString() })))} -->` });
  assert.equal(blanket.regateNow().decision.action, 'review');
  // The pipeline's identity cannot be resolved: its own recorded hold counts as a person's close.
  const anon = waitingGroup({ whoamiFail: true });
  anon.pr.events = [{ id: 1, event: 'closed', actor: { login: 'pipeline-bot' }, created_at: '2026-11-03T02:00:00Z' }];
  anon.pr.comments.push({ id: 963, author: 'pipeline-bot', body: '<!-- factory:holds [{"type":"closed","event":1}] -->' });
  assert.equal(anon.regateNow().decision.action, 'review');
});

test('an issue that stands reopened counts once, not again at the re-run\'s next marker, and the gate reads it standing', () => {
  const w = waitingGroup();
  // board sync recorded it once; a later review marker while it stands reopened does not record it again.
  w.gh.issues.get(3).body = upsertTriage('story 3', { v: 1, key: 'BUG-3', reopens: [{ at: '2026-11-02T00:00:00Z', source: 'issue', detail: 'issue reopened' }] });
  const before = extractTriage(w.gh.issues.get(3).body).reopens.length;
  syncGate(w.config, { gh: w.gh.gh, items: [{ key: 'BUG-3', number: 3, url: 'u3', column: 'review', state: 'OPEN', stateReason: 'REOPENED', severity: 'Low', labels: [] }], metricsConfig: w.config, markerOf: () => ({ column: 'review', at: '2026-11-03T00:00:00Z' }), commentsOf: () => [], applyEvent: () => {}, now: '2026-11-03T03:00:00Z' });
  assert.equal(extractTriage(w.gh.issues.get(3).body).reopens.length, before);
  // Never synced at all: the gate still sees the issue standing reopened.
  const s = waitingGroup();
  Object.assign(s.gh.issues.get(4), { state: 'OPEN', stateReason: 'REOPENED' });
  assert.equal(s.regateNow().decision.action, 'review');
});

// ---- round 3: both reviews' reproductions ----------------------------------------------------------------------------

const prior = (w) => JSON.parse(/<!-- review-gate:(\{.*\}) -->/.exec(w.pr.comments.find((c) => c.body.includes('review-gate:')).body)[1]);

test('a rejection count the gate stored on the PR is never cleared by a read that finds fewer (ADV2-R2-02)', () => {
  const w = waitingGroup();
  const st = prior(w);
  st.tickets = st.tickets.map((t) => (t.key === 'BUG-3' ? { ...t, reopens: 1 } : t));
  const d = regate(w.config, w.gh.gh, w.pr.url, { prior: st, delivery: null, retryCheck: () => [] }).decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /^BUG-3 could not be checked .*records 1 rejection\(s\) of it, its history shows 0/.test(t)), d.triggers.join('; '));
});

test('a "changes requested" is cleared only by a later approval of the same person, not by a dismissal or a comment (Sol 13)', () => {
  const cr = { id: 41, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' };
  for (const [later, action] of [[{ id: 42, state: 'DISMISSED', body: '', user: { login: 'dana' }, submitted_at: '2026-11-03T02:00:00Z' }, 'review'], [{ id: 43, state: 'COMMENTED', body: 'ok', user: { login: 'dana' }, submitted_at: '2026-11-03T02:00:00Z' }, 'review'], [{ id: 44, state: 'APPROVED', body: '', user: { login: 'eve' }, submitted_at: '2026-11-03T02:00:00Z' }, 'review'], [{ id: 45, state: 'APPROVED', body: '', user: { login: 'dana' }, submitted_at: '2026-11-03T02:00:00Z' }, 'auto-merge']]) {
    const w = waitingGroup();
    w.pr.reviews.push(cr, later);
    assert.equal(w.regateNow().decision.action, action, later.state);
  }
});

test('every PR of the ticket is read: one the host lists with its key, one its run record names, though its record never had them (Sol 14, ADV2-R2-10)', () => {
  // A first PR of BUG-3, closed by a person before the gate ever published on it: not in the triage.
  const listed = waitingGroup();
  const first = listed.gh.addPr(5, { state: 'CLOSED', title: 'BUG-3: fix the rounding', headRefName: 'feat/bug-3-old' });
  first.events = [{ id: 1, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-02T00:00:00Z' }];
  const d = listed.regateNow().decision;
  assert.equal(d.action, 'review');
  assert.deepEqual(d.wouldAutoMerge, ['BUG-4']);
  // A PR only the ticket's run record names (an earlier run's), with no title naming it.
  const run = waitingGroup();
  const older = run.gh.addPr(6, { state: 'CLOSED', title: 'Rounding' });
  older.events = [{ id: 2, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-02T00:00:00Z' }];
  saveRun(run.config, 'BUG-4', { earlierPrs: [older.url] });
  assert.equal(run.regateNow().decision.action, 'review');
  // The repository's PRs cannot be listed: unknown, so review.
  const fail = waitingGroup();
  const gh0 = fail.gh.gh;
  fail.gh.gh = (args, o) => (args[0] === 'pr' && args[1] === 'list' && args.includes('all') ? { status: 1, stdout: '', stderr: 'HTTP 502' } : gh0(args, o));
  assert.equal(regate(fail.config, fail.gh.gh, fail.pr.url, { prior: prior(fail), delivery: null, retryCheck: () => [] }).decision.action, 'review');
});

test('a forced re-run, or a run whose board sync failed, delivers for review: its history may be incomplete (ADV2-R2-10)', () => {
  const w = waitingGroup();
  const stories = [{ key: 'BUG-3' }];
  markHistoryUnknown(w.config, stories, 'a forced re-run (implement run --force)');
  assert.equal(stories[0].historyUnknown, 'a forced re-run (implement run --force)');
  const d = w.regateNow().decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /^BUG-3 could not be checked .*a forced re-run/.test(t)), d.triggers.join('; '));
  // The CLI marks every story of a forced run, and of a run whose start sync failed.
  const cli = fs.readFileSync(new URL('../../implement/implement.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const synced = syncBoard\(config\.root\);[\s\S]*if \(force \|\| !synced\) markHistoryUnknown\(config,/);
});

test('a requeue whose rejection store answers nothing keeps its marker; the rejection is stored with the gate off too (Sol 17)', () => {
  const w = waitingGroup();
  const cfg = { ...w.config, board: { ...w.config.board, resolvedLabel: 'escalation-resolved' } };
  saveRun(cfg, 'BUG-6', { outcome: 'ci-failed', pr: 'https://github.com/acme/shop/pull/32' });
  const events = [];
  const stories = [{ key: 'BUG-6', resolved: true }];
  startResolvedReruns(cfg, stories, { event: (r, key, args) => events.push(args[0]), recordRejection: () => null });
  assert.deepEqual(events, []);
  assert.match(stories[0].skip, /nothing was stored/);
  const src = fs.readFileSync(new URL('../../implement/lib/implement.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function recordRequeueRejection('), src.indexOf('export function markHistoryUnknown('));
  assert.doesNotMatch(fn, /gateOff/, 'not skipped while the gate is off');
});

test('a close whose provenance cannot be read is not stored as a person\'s rejection, and not consumed: retried next sync (Sol 18)', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rej-unknown-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gh = fakeGh();
  gh.addFields();
  gh.addIssue(5, { body: 'story 5' });
  const pr = gh.addPr(31, { state: 'CLOSED', closedAt: '2026-11-03T05:00:00Z', labels: ['approvals:1'] });
  pr.events = [{ id: 9, event: 'closed', actor: { login: 'pipeline-bot' }, created_at: '2026-11-03T05:00:00Z' }];
  pr.comments.push({ id: 960, author: 'pipeline-bot', body: `## Review gate\n\n${encodeState({ v: 1, action: 'review', approvals: 1, required: true, triggers: [], headSha: 'h1', class: 'Low', severity: 'Low', tickets: [{ key: 'BUG-5', issue: 5, severity: 'Low', high: true, reopens: 0 }], countedReviews: [] })}` }, { id: 961, author: 'pipeline-bot', body: '<!-- factory:holds [{"type":"closed","event":9}] -->' });
  pr.eventsFail = true;
  const config = gateConfigFor(root);
  const rows = () => (fs.existsSync(path.join(root, '.factory/metrics/decision-outcomes.jsonl')) ? readJsonl(path.join(root, '.factory/metrics/decision-outcomes.jsonl')) : []);
  recordClosedPrs(config, gh.gh, { metricsConfig: config, now: '2026-11-03T06:00:00Z' });
  assert.equal(extractTriage(gh.issues.get(5).body)?.reopens?.length ?? 0, 0, 'no rejection stored');
  assert.deepEqual(rows(), [], 'nothing consumed');
  // Readable now: the pipeline's own hold, left for the hold to end.
  pr.eventsFail = false;
  recordClosedPrs(config, gh.gh, { metricsConfig: config, now: '2026-11-03T07:00:00Z' });
  assert.equal(extractTriage(gh.issues.get(5).body)?.reopens?.length ?? 0, 0);
});

test('the PR description says why a person reviews it, from the live read, on publish and regate (Sol 20)', () => {
  const w = waitingGroup();
  assert.doesNotMatch(w.pr.body, /review-gate:why/);
  w.pr.events = [{ id: 1, event: 'closed', actor: { login: 'dana' }, created_at: '2026-11-03T02:00:00Z' }];
  w.regateNow();
  assert.match(w.pr.body, /\*\*A person reviews this PR\*\*[\s\S]*BUG-3: rejected by a person earlier \(PR closed without merge by @dana[\s\S]*BUG-4: rejected by a person earlier[\s\S]*A person's approval of this PR settles it/);
});

test('the host\'s auto-merge is armed only on an auto-merge decision and cancelled when a later read says review; a failed cancel is reported (ADV2-R2-05, Sol 12)', () => {
  const w = waitingGroup();
  w.config.implement.autoMerge = { ...w.config.implement.autoMerge, native: true };
  // Checks green, but GitHub has not cleared the merge yet (BLOCKED): the gate arms the host's auto-merge.
  w.pr.mergeStateStatus = 'BLOCKED';
  assert.equal(w.regateNow().decision.action, 'auto-merge');
  assert.deepEqual([w.pr.autoMerge, w.pr.state], [true, 'OPEN'], 'armed on the auto-merge decision, not merged yet');
  // A person requests changes; the next read disarms it before the host can merge.
  w.pr.reviews.push({ id: 41, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' });
  assert.equal(w.regateNow().decision.action, 'review');
  assert.equal(w.pr.autoMerge, false, 'disarmed');
  // A cancel the host refuses is reported, not swallowed.
  const r = waitingGroup();
  r.config.implement.autoMerge = { ...r.config.implement.autoMerge, native: true };
  r.pr.mergeStateStatus = 'BLOCKED';
  r.regateNow();
  r.pr.reviews.push({ id: 41, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' });
  const gh0 = r.gh.gh;
  r.gh.gh = (args, o) => (args.includes('--disable-auto') ? { status: 1, stdout: '', stderr: 'refused' } : gh0(args, o));
  const logs = [];
  regate(r.config, r.gh.gh, r.pr.url, { prior: prior(r), delivery: null, retryCheck: () => [], log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /auto-merge not disarmed: the host's auto-merge is armed/.test(m)), logs.join('\n'));
});


test('GitLab: every page of a merge request\'s state events is read, and a denied or malformed read is unknown, not "nothing" (ADV2-R2-09, Sol 16)', async () => {
  const { createGitlabHost } = await import('../../pipeline/lib/hosts/gitlab.mjs');
  const pages = { 1: [{ id: 1, state: 'reopened', created_at: '2026-11-03T01:00:00Z', user: { username: 'pipeline-bot' } }], 2: [{ id: 2, state: 'closed', created_at: '2026-11-03T02:00:00Z', user: { username: 'dana' } }] };
  const fetch = async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (u.pathname.endsWith('/resource_state_events')) return new Response(JSON.stringify(pages[page]), { status: 200, headers: page === 1 ? { 'x-next-page': '2' } : {} });
    if (u.pathname.endsWith('/approvals')) return new Response(JSON.stringify({ approved_by: [] }), { status: 200 });
    if (u.pathname.endsWith('/reviewers')) return new Response(JSON.stringify({ message: '403 Forbidden' }), { status: 403 });
    if (/merge_requests\/7$/.test(u.pathname)) return new Response(JSON.stringify({ iid: 7, sha: 'abc' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const host = createGitlabHost({ url: 'https://gitlab.example', repo: 'g/p', resolveToken: () => 'x' }, { fetch, sleep: async () => {} });
  assert.deepEqual((await host.pr.stateEvents(7)).map((e) => [e.id, e.type, e.actor]), [[1, 'reopened', 'pipeline-bot'], [2, 'closed', 'dana']]);
  assert.deepEqual(await host.pr.reviews(7), [], 'the lenient read other callers use is unchanged');
  await assert.rejects(host.pr.reviews(7, { strict: true }), /403|reviewers/);
  pages[2] = { message: 'oops' };
  await assert.rejects(host.pr.stateEvents(7), /did not answer with a list/);
});

test('a rating the host does not show on the PR is not published: the publication reports it, and a saved rating for another head is not used (Sol 22, Sol 25)', () => {
  const w = groupPr();
  const saved = assessPr(w.config, { pr: null, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: w.gh.gh, runAgent: w.agent.runAgent });
  // The gate's comment cannot be written: not published.
  const gh0 = w.gh.gh;
  const refusing = (args, o) => (args[0] === 'pr' && args[1] === 'comment' ? { status: 1, stdout: '', stderr: 'HTTP 502' } : gh0(args, o));
  assert.equal(publishGate(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', assessment: saved, noAgent: true }, { gh: refusing }).published, false);
  assert.equal(publishGate(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', assessment: saved, noAgent: true }, { gh: w.gh.gh }).published, true);
  // A saved rating made for another head than the PR's: published as not assessed (a person reviews it).
  w.pr.headRefOid = 'f'.repeat(40);
  const other = publishGate(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', assessment: saved, noAgent: true }, { gh: w.gh.gh });
  assert.equal(other.decision.action, 'review');
  assert.match(other.assessment.errors.join(' '), /the saved rating is for another change than the PR's head fffffff holds/);
  const cli = fs.readFileSync(new URL('../review-gate.mjs', import.meta.url), 'utf8');
  assert.match(cli, /if \(!r\.published\) \{[\s\S]*?return 3;/);
});

// ---- round 4 -----------------------------------------------------------------------------------------------------------

test('a close or reopen the pipeline\'s update did not make is never recorded as its own, also on the person\'s own login (ADV2-R3-01, review-required-15)', async () => {
  const { holdPr, pipelineEvents, readHoldLedger, releasePr } = await import('../../implement/lib/pre-open.mjs');
  // The pipeline acts as the person's own login (no PR bot): its hold close is recorded.
  const h = holdHost({ identity: 'dev' });
  assert.equal(holdPr(h.host, 7, { mode: 'close-reopen', why: 'agents work again', sleep: () => {} }).recorded, true);
  // The person reopens the held PR from the same login: a rejection.
  h.st.state = 'open';
  h.st.events.push({ id: 150, type: 'reopened', at: '2026-11-03T03:00:00Z', actor: 'dev' });
  // The pipeline's release then does nothing (already open): no new event, nothing recorded.
  assert.equal(releasePr(h.host, 7, { mode: 'close-reopen', sleep: () => {} }), true);
  assert.deepEqual(readHoldLedger(h.host, 7).map((e) => [e.type, e.event]), [['closed', 100]]);
  const own = pipelineEvents(h.st.events, readHoldLedger(h.host, 7), 'dev');
  assert.ok(!own.has(h.st.events.find((e) => e.id === 150)), 'the person\'s reopen stays a person\'s');
  // The person closed it already; the pipeline's close then throws (or does nothing): no record of the person's close.
  for (const closeFails of [true, false]) {
    const c = holdHost({ identity: 'dev', closeFails });
    c.st.state = 'closed';
    c.st.events.push({ id: 160, type: 'closed', at: '2026-11-03T04:00:00Z', actor: 'dev' });
    const held = holdPr(c.host, 7, { mode: 'close-reopen', why: 'x', attempts: 1, sleep: () => {} });
    assert.equal(held.recorded, false, `close ${closeFails ? 'threw' : 'did nothing'}`);
    assert.deepEqual(readHoldLedger(c.host, 7), []);
  }
});


test('a review dismissed in place (its original request no longer shown) counts as a standing "changes requested" until the same person approves (review-required-13a)', () => {
  const dismissed = { id: 41, state: 'DISMISSED', body: '', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' };
  const w = waitingGroup();
  w.pr.reviews.push(dismissed);
  assert.equal(w.regateNow().decision.action, 'review');
  const a = waitingGroup();
  a.pr.reviews.push(dismissed, { id: 42, state: 'APPROVED', body: '', user: { login: 'dana' }, submitted_at: '2026-11-03T02:00:00Z' });
  assert.equal(a.regateNow().decision.action, 'auto-merge');
});

test('a "changes requested" that arrives after the decision\'s read and before the merge is read at the merge boundary: no merge (review-required-13b)', () => {
  const w = waitingGroup();
  // The request arrives between the gate's first read of the reviews and the merge.
  let reads = 0;
  const gh0 = w.gh.gh;
  w.gh.gh = (args, o) => {
    if (args[0] === 'api' && /pulls\/8\/reviews/.test(args[1] ?? '') && ++reads === 2) w.pr.reviews.push({ id: 43, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'dana' }, submitted_at: '2026-11-03T05:00:00Z' });
    return gh0(args, o);
  };
  const d = regate(w.config, w.gh.gh, w.pr.url, { prior: prior(w), delivery: null, retryCheck: () => [] }).decision;
  assert.equal(d.action, 'review');
  assert.equal(w.gh.merges.length, 0, 'no merge call');
});

test('a saturated PR query is unknown, so review; the queries are targeted (its branch, its key in the title) (review-required-14)', () => {
  const w = waitingGroup();
  // A first PR of BUG-3 a person closed, older than 500 newer PRs of the repository, in no record of the ticket.
  const old = w.gh.addPr(2, { state: 'CLOSED', title: 'BUG-3: rounding', headRefName: 'feat/bug-3-old' });
  old.events = [{ id: 1, event: 'closed', actor: { login: 'dana' }, created_at: '2026-10-01T00:00:00Z' }];
  for (let n = 1000; n < 1500; n++) w.gh.addPr(n, { state: 'MERGED', title: `Other change ${n}` });
  assert.equal(w.regateNow().decision.action, 'review', 'found by the title query, not lost behind 500 newer PRs');
  assert.ok(w.gh.calls.some((c) => c.args.includes('--search') && c.args.includes('"BUG-3" in:title')));
  // A query that reaches the cap: unknown, review.
  const s = waitingGroup();
  for (let n = 2000; n < 2500; n++) s.gh.addPr(n, { state: 'MERGED', title: `BUG-4 follow-up ${n}` });
  const d = s.regateNow().decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /^BUG-4 could not be checked .*naming BUG-4 match 500 PRs or more/.test(t)), d.triggers.join('; '));
});

test('GitLab strict reviews read every reviewers page and refuse an approvals answer without its list (review-required-16)', async () => {
  const { createGitlabHost } = await import('../../pipeline/lib/hosts/gitlab.mjs');
  let approvals = { approved_by: [] };
  const fetch = async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') || 1);
    if (u.pathname.endsWith('/approvals')) return new Response(JSON.stringify(approvals), { status: 200 });
    if (u.pathname.endsWith('/reviewers')) return new Response(JSON.stringify(page === 1 ? [{ user: { username: 'ann' }, state: 'unreviewed' }] : [{ user: { username: 'dana' }, state: 'requested_changes' }]), { status: 200, headers: page === 1 ? { 'x-next-page': '2' } : {} });
    if (/merge_requests\/7$/.test(u.pathname)) return new Response(JSON.stringify({ iid: 7, sha: 'abc' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const host = createGitlabHost({ url: 'https://gitlab.example', repo: 'g/p', resolveToken: () => 'x' }, { fetch, sleep: async () => {} });
  assert.deepEqual((await host.pr.reviews(7, { strict: true })).map((r) => [r.author, r.state]), [['dana', 'changes_requested']]);
  approvals = { approvals_left: 0 };
  await assert.rejects(host.pr.reviews(7, { strict: true }), /approvals of the merge request could not be read/);
});

test('a "changes requested" is counted as handled only once every ticket it names has it stored (review-required-17)', () => {
  const w = waitingGroup();
  w.pr.reviews.push({ id: 44, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'dana' }, submitted_at: '2026-11-03T01:00:00Z' });
  // BUG-4's issue mapping is missing from the PR's gate state.
  const c = w.pr.comments.find((x) => x.body.includes('review-gate:'));
  const st = prior(w);
  st.tickets = st.tickets.map((t) => (t.key === 'BUG-4' ? { ...t, issue: null } : t));
  c.body = c.body.replace(/<!-- review-gate:\{.*\} -->/, encodeState(st));
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null, commentsOf: () => [], applyEvent: () => {} });
  assert.ok(!(prior(w).countedReviews ?? []).includes(44), 'not counted: BUG-4 has no place to store it');
  assert.equal(extractTriage(w.gh.issues.get(3).body).reopens.length, 1, 'BUG-3 has it, once');
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null, commentsOf: () => [], applyEvent: () => {} });
  assert.equal(extractTriage(w.gh.issues.get(3).body).reopens.length, 1, 'a retry does not store it twice');
});

test('a close or reopen made by the pipeline\'s own login with no record is unknown: review, never stored as a person\'s rejection (review-required-18)', () => {
  const w = waitingGroup();
  w.pr.events = [{ id: 1, event: 'closed', actor: { login: 'pipeline-bot' }, created_at: '2026-11-03T02:00:00Z' }, { id: 2, event: 'reopened', actor: { login: 'pipeline-bot' }, created_at: '2026-11-03T02:05:00Z' }];
  const d = w.regateNow().decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /could not be checked .*pipeline's own login that no record of the pipeline names/.test(t)), d.triggers.join('; '));
  assert.equal(extractTriage(w.gh.issues.get(3).body)?.reopens?.length ?? 0, 0, 'no reopen stored');
});

test('the notice and the description say what settles an unknown history, with the number of approvals required (review-required-20)', () => {
  const u = waitingGroup();
  u.pr.eventsFail = true;
  const d = u.regateNow().decision;
  assert.ok(d.triggers.some((t) => /could not be checked for a rejection .*\(a person's approval of this PR settles it\)$/.test(t)), d.triggers.join('; '));
  assert.match(rejectionSection({ tickets: [{ key: 'BUG-1', reopens: [], reopensUnknown: 'x' }] }, 2), /2 approvals of this PR's head by people settle it\./);
});

test('a merge that ends waiting cancels the host\'s auto-merge armed earlier (round 3 statement, native off)', () => {
  const w = waitingGroup();
  w.pr.autoMergeRequest = { enabledAt: '2026-11-03T00:00:00Z' };
  w.pr.mergeStateStatus = 'BLOCKED';
  const r = w.regateNow();
  assert.equal(r.decision.action, 'wait');
  assert.ok(w.gh.calls.some((c) => c.args.includes('--disable-auto')), 'disarmed');
});

test('a rating on the ticket counts only for the head it rated: regate of another head is "not assessed", so review (resuming-25)', () => {
  const w = waitingGroup();
  const t3 = extractTriage(w.gh.issues.get(3).body);
  assert.equal(t3.ratedHead, w.pr.headRefOid, 'publication records the head it rated');
  // The ticket holds a Low rating made for another change (round 5: a rating is bound to the PR's own diff).
  assert.ok(t3.ratedDiff, 'publication records the change it rated');
  w.gh.issues.get(3).body = upsertTriage(w.gh.issues.get(3).body, { ...t3, ratedDiff: 'f'.repeat(24) });
  const d = w.regateNow().decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /^BUG-3 was not assessed \(BUG-3's rating is for another change than the PR's head/.test(t)), d.triggers.join('; '));
  // No rating on the ticket at all (its triage removed): the severity the gate's comment shows is not one (resuming-25, Sol).
  const n = waitingGroup();
  n.gh.issues.get(3).body = 'story 3';
  const dn = n.regateNow().decision;
  assert.equal(dn.action, 'review');
  assert.ok(dn.triggers.some((t) => /^BUG-3 was not assessed \(BUG-3 has no rating on its ticket/.test(t)), dn.triggers.join('; '));
  assert.equal(w.gh.merges.length, 0);
});

// ---- round 5 -----------------------------------------------------------------------------------------------------------

test('a publication is stamped with the PR\'s head as the host has it, and confirmed only by reading back this very publication (resuming-22)', () => {
  // The checkout is behind the PR (a person pushed): the "needs a person" result is published for the PR's head.
  const w = groupPr();
  w.pr.headRefOid = 'f'.repeat(40);
  const r = publishGate(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', noAgent: true }, { gh: w.gh.gh });
  assert.equal(r.published, true);
  assert.equal(r.assessment.headSha, 'f'.repeat(40));
  assert.equal(parseState(w.pr.comments.find((c) => c.body.includes('review-gate:')).body).headSha, 'f'.repeat(40));
  // A rating made by hand on a checkout that is not at the PR's head is not published at all.
  const fresh = publishGate(w.config, { pr: w.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main' }, { gh: w.gh.gh, runAgent: w.agent.runAgent });
  assert.equal(fresh.published, false);
  // An earlier notice for the same head and decision is not this publication: an update the host refuses is reported.
  const s = groupPr();
  publishGate(s.config, { pr: s.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', noAgent: true }, { gh: s.gh.gh });
  const gh0 = s.gh.gh;
  const refusing = (args, o) => (args[0] === 'api' && args.includes('PATCH') ? { status: 1, stdout: '', stderr: 'HTTP 502' } : gh0(args, o));
  assert.equal(publishGate(s.config, { pr: s.pr.url, keys: ['BUG-1', 'BUG-2'], base: 'main', noAgent: true }, { gh: refusing }).published, false);
});

// ---- round 5: dismissed reviews, strict GitHub pages, the title query ------------------------------------------------

test('a dismissed review counts by what it was: an approval is no rejection, a "changes requested" is one, an unknown one is review with nothing stored (ADV2-R4-03)', () => {
  const dismissed = { id: 41, state: 'DISMISSED', body: 'LGTM', user: { login: 'ann' }, submitted_at: '2026-11-03T01:00:00Z' };
  const approval = waitingGroup();
  approval.pr.reviews.push(dismissed);
  approval.pr.timeline = [{ event: 'review_dismissed', dismissed_review: { review_id: 41, state: 'approved' } }];
  assert.equal(approval.regateNow().decision.action, 'auto-merge');
  assert.equal(extractTriage(approval.gh.issues.get(3).body)?.reopens?.length ?? 0, 0, 'no rejection stored');
  const request = waitingGroup();
  request.pr.reviews.push({ ...dismissed, body: 'BUG-3 is still wrong' });
  request.pr.timeline = [{ event: 'review_dismissed', dismissed_review: { review_id: 41, state: 'changes_requested' } }];
  const r = request.regateNow().decision;
  assert.equal(r.action, 'review');
  assert.ok(r.triggers.some((t) => /^BUG-3 has 1 human reopen/.test(t)), r.triggers.join('; '));
  const unknown = waitingGroup();
  unknown.pr.reviews.push(dismissed);
  const u = unknown.regateNow().decision;
  assert.equal(u.action, 'review');
  assert.ok(u.triggers.some((t) => /could not be checked .*was dismissed and the host does not say what it was/.test(t)), u.triggers.join('; '));
  assert.ok(!u.triggers.some((t) => /human reopen|changes requested by @ann/.test(t)), u.triggers.join('; '));
  assert.equal(extractTriage(unknown.gh.issues.get(3).body)?.reopens?.length ?? 0, 0, 'no rejection stored');
});

test('GitHub strict reads exhaust every page and fail closed on an incomplete answer: a flattened list, a row without its fields (review-16)', async () => {
  const { createGithubHost } = await import('../../pipeline/lib/hosts/github.mjs');
  const answer = (stdout) => () => ({ status: 0, stdout, stderr: '' });
  const host = (runner) => createGithubHost({ repo: 'acme/shop' }, { gh: runner });
  // Success with rows that are not a list of pages (an injected runner flattening the pages).
  assert.throws(() => host(answer(JSON.stringify([{ id: 1, event: 'closed' }]))).pr.stateEvents(8), /incomplete \(not a list of pages\)/);
  assert.throws(() => host(answer(JSON.stringify([{ id: 1, state: 'APPROVED', user: { login: 'ann' } }]))).pr.reviews(8, { strict: true }), /incomplete \(not a list of pages\)/);
  // A row without its fields.
  assert.throws(() => host(answer(JSON.stringify([[{ id: 1 }]]))).pr.stateEvents(8), /incomplete \(a row without its fields\)/);
  assert.throws(() => host(answer(JSON.stringify([[{ id: 1, state: 'APPROVED' }]]))).pr.reviews(8, { strict: true }), /a row without its fields/);
  // Every page is read.
  const pages = JSON.stringify([[{ id: 1, event: 'closed', created_at: 'a' }], [{ id: 2, event: 'reopened', created_at: 'b' }]]);
  assert.deepEqual(host(answer(pages)).pr.stateEvents(8).map((e) => e.type), ['closed', 'reopened']);
  // Through the gate: an incomplete answer is unknown history, so review.
  const w = waitingGroup();
  const gh0 = w.gh.gh;
  w.gh.gh = (args, o) => {
    const r = gh0(args, o);
    if (args[0] === 'api' && /issues\/8\/events/.test(args[1] ?? '') && args.includes('--slurp')) return { ...r, stdout: JSON.stringify(JSON.parse(r.stdout).flat().concat([{ id: 9, event: 'closed' }])) };
    return r;
  };
  const d = regate(w.config, w.gh.gh, w.pr.url, { prior: prior(w), delivery: null, retryCheck: () => [] }).decision;
  assert.equal(d.action, 'review');
  assert.ok(d.triggers.some((t) => /could not be checked .*incomplete/.test(t)), d.triggers.join('; '));
});

test('GitHub PR comments are read on every page: the gate notice past the first page is edited, not posted again (Gemini follow-up)', async () => {
  const { createGithubHost } = await import('../../pipeline/lib/hosts/github.mjs');
  const gh = fakeGh();
  gh.pageSize = 30;
  const pr = gh.addPr(8);
  for (let i = 1; i <= 105; i++) pr.comments.push({ id: 1000 + i, body: i === 105 ? '<!-- marker --> old' : `chatter ${i}`, author: 'someone' });
  const host = createGithubHost({ repo: 'acme/shop' }, { gh: gh.gh });
  assert.equal(host.pr.comments(8).length, 105);
  host.pr.comment(8, '<!-- marker --> new', { marker: '<!-- marker -->' });
  assert.equal(pr.comments.length, 105, 'edited in place');
  assert.equal(pr.comments.at(-1).body, '<!-- marker --> new');
});

test('the title query quotes the key, and the cap applies after the key filter: PRs that only resemble the key do not make the history unknown (ADV2-R4-05)', () => {
  const w = waitingGroup();
  for (let n = 3000; n < 3600; n++) w.gh.addPr(n, { state: 'MERGED', title: `BUG-30 change ${n}` });
  const d = w.regateNow().decision;
  assert.ok(w.gh.calls.some((c) => c.args.includes('--search') && c.args.includes('"BUG-3" in:title')));
  assert.ok(!d.triggers.some((t) => /naming BUG-3 match/.test(t)), d.triggers.join('; '));
  assert.equal(d.action, 'auto-merge');
});

test('GitLab: a reviewer\'s "requested changes" after their approval is read, and one with no time wins over the approval (review-13)', async () => {
  const { createGitlabHost } = await import('../../pipeline/lib/hosts/gitlab.mjs');
  let reviewers = [{ user: { username: 'dana' }, state: 'requested_changes', updated_at: '2026-11-03T02:00:00Z' }];
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/approvals')) return new Response(JSON.stringify({ approved_by: [{ user: { username: 'dana' }, approved_at: '2026-11-03T01:00:00Z' }] }), { status: 200 });
    if (u.pathname.endsWith('/reviewers')) return new Response(JSON.stringify(reviewers), { status: 200 });
    if (/merge_requests\/7$/.test(u.pathname)) return new Response(JSON.stringify({ iid: 7, sha: 'abc' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const host = createGitlabHost({ url: 'https://gitlab.example', repo: 'g/p', resolveToken: () => 'x' }, { fetch, sleep: async () => {} });
  const later = (await host.pr.reviews(7, { strict: true })).map((r) => [r.author, r.state, r.submittedAt]);
  assert.deepEqual(later, [['dana', 'approved', '2026-11-03T01:00:00Z'], ['dana', 'changes_requested', '2026-11-03T02:00:00Z']]);
  // Read by time, the request is the latest: the PR needs review.
  const { quorum } = await import('../lib/quorum.mjs');
  const { toReview } = await import('../lib/github.mjs');
  assert.deepEqual(quorum({ labels: [], reviews: (await host.pr.reviews(7, { strict: true })).map(toReview), author: 'bot', headSha: 'abc' }).blocking, ['dana']);
  reviewers = [{ user: { username: 'dana' }, state: 'requested_changes' }];
  assert.deepEqual((await host.pr.reviews(7, { strict: true })).map((r) => [r.author, r.state]), [['dana', 'changes_requested']]);
});

test('the merge boundary reads the rejections immediately before the merge call, after the merge state was read, in one place for publish and regate (Gemini follow-up)', () => {
  const w = waitingGroup();
  const d = w.regateNow().decision;
  assert.equal(d.action, 'auto-merge');
  const calls = w.gh.calls.map((c) => c.args);
  const merge = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge');
  const lastReviews = calls.slice(0, merge).findLastIndex((a) => a[0] === 'api' && /pulls\/8\/reviews/.test(a[1] ?? ''));
  const lastState = calls.slice(0, merge).findLastIndex((a) => a[0] === 'pr' && a[1] === 'view' && a.some((x) => String(x).includes('mergeStateStatus')));
  assert.ok(merge > 0 && lastState >= 0 && lastReviews > lastState, `state read ${lastState}, boundary read ${lastReviews}, merge ${merge}`);
  const src = ['publish.mjs', 'sync.mjs'].map((f) => fs.readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.equal((src.match(/atMergeBoundary\(/g) ?? []).length, 2, 'defined once and called once (inside mergeAtBoundary)');
});
