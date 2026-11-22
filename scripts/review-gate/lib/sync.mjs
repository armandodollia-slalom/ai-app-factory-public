// The review gate's part of `board sync` (bookkeeping that belongs to no single run):
//   1. human reopens of triaged tickets (card moved back, issue reopened, "changes requested" reviews):
//      severity bump, `## Decisions` note for the re-run, `reopened` label, board event, metrics record,
//      and the PR's gate back to review when it is still open;
//   2. open gated PRs evaluated again: a PR waiting for its checks auto-merges once they pass;
//   3. closed gated PRs recorded for the retro (pr-review.mjs), and reverts of their merges.
// Everything is informational: a GitHub error is logged and the rest of the sync goes on.
import { appendJsonl, nowIso, readJsonl, run } from '../../pipeline/lib/util.mjs';
import { metricsFile, readMetricsLocal } from '../../pipeline/lib/state.mjs';
import { extractDecisions, upsertDecisions } from '../../board/lib/escalation.mjs';
import { OUTCOMES_FILE } from '../../implement/lib/decisions.mjs';
import { addTicketLabel, setTicketBody, setTriageFields, ticketAssignees, ticketBody } from './fields.mjs';
import { confidence, ticketSignals } from './confidence.mjs';
import { ciFlaky } from '../../implement/lib/ci-wait.mjs';
import { applyDeliveryCheck } from './delivery-check.mjs';
import { failedTestsIn, originLine, pipelineOrigin } from './ci-origin.mjs';
import { MARKER, applyReview, decideGate, gateState, isMergeTrigger, readPrState, renderNotice } from './gate.mjs';
import { checksState, prFiles, disableAutoMerge, prCommits, prHost, prReviewComments, prReviews, prView, toReview, upsertComment } from './github.mjs';

import { gateEffects, mergeAtBoundary, readCodeowners } from './publish.mjs';
import { ciTarget } from '../../pipeline/lib/ci/index.mjs';
import { cardReopen, mergeReopens, newChangesRequested, reopenDecisionNote, ticketReopens, withReopen } from './reopens.mjs';
import { isBugTicket } from '../../implement/lib/epic-plan.mjs';
import { personEvents, withCurrentRejections } from './rejections.mjs';
import { prClass, prSeverity } from './severity.mjs';
import { gateSystemsSettings, systemsTouched } from './systems.mjs';
import { extractTriage, upsertTriage } from './triage-section.mjs';
import { fieldValues, liveDiffKey, recordTicket } from './assessment.mjs';
import { quorum, requiredApprovals } from './quorum.mjs';
import { prReviewRecord, revertsOf } from './pr-review.mjs';
import { headActivities } from '../../implement/lib/pre-open.mjs';

const safe = (fn, fallback, onError) => {
  try {
    return fn();
  } catch (error) {
    onError?.(error);
    return fallback;
  }
};

const nextRound = (body) => {
  const inner = extractDecisions(body) ?? '';
  const rounds = [...inner.matchAll(/^### Round (\d+)\b/gm)].map((m) => Number(m[1]));
  return rounds.length ? Math.max(...rounds) + 1 : 1;
};

// Records one human reopen of a ticket. Returns the updated triage data. A ticket the gate never assessed gets a triage
// section that holds only its reopens, so its next assessment still knows a person rejected it.
export function recordReopen(config, gh, { key, issue, reopen }, { metricsConfig, applyEvent = null, log = () => {} }) {
  const body = ticketBody(config, gh, issue.number);
  const triage = extractTriage(body) ?? { v: 1, key, pr: reopen.pr ?? null, reopens: [] };
  // Stored once: a retry of a rejection already on the ticket changes nothing (the same source, PR and time).
  if (mergeReopens(triage.reopens ?? [], [reopen]).length === (triage.reopens ?? []).length) return triage;
  const next = withReopen(triage, reopen, config.implement.reviewGate);
  let updated = upsertTriage(body, next);
  updated = upsertDecisions(updated, { round: nextRound(updated), by: reopen.by ?? 'review-gate', at: reopen.at.slice(0, 10), answers: [], note: reopenDecisionNote(reopen) });
  setTicketBody(config, gh, issue.number, updated);
  safe(() => setTriageFields(config, gh, issue, fieldValues(next)), null, (e) => log(`${key}: board fields not updated: ${e.message.split('\n')[0]}`));
  safe(() => addTicketLabel(config, gh, issue.number, config.implement.reviewGate.labels?.reopened ?? 'reopened'), null, (e) => log(`${key}: label not added: ${e.message.split('\n')[0]}`));
  appendJsonl(metricsFile(metricsConfig, OUTCOMES_FILE), { ts: reopen.at, type: 'reopen', story: key, pr: reopen.pr ?? null, source: reopen.source, detail: reopen.detail ?? null, by: reopen.by ?? null, afterMerge: Boolean(reopen.afterMerge), reopens: next.reopens.length, severity: next.severity?.level ?? null, severityBase: next.severity?.base ?? null });
  if (applyEvent) {
    const n = next.reopens.length;
    const comment = `Human reopen #${n} (${reopen.detail ?? reopen.source}${reopen.pr ? `, ${reopen.pr}` : ''}). ${next.severity?.level ? `Severity is now **${next.severity.level}** (${next.severity.explanation}); ` : ''}rejected by a person: this ticket can no longer auto-merge. ${reopen.afterMerge ? 'Its PR already merged, so `implement requeue` runs the fix again as a follow-up PR through the same gate.' : '`implement requeue` runs it again on its PR\'s branch.'} The reason is recorded under **Decisions** in the issue body for the re-run.`;
    safe(() => applyEvent(key, { type: 'reopened', id: `reopen:${key}:${n}`, body: comment }), null, (e) => log(`${key}: card not moved: ${e.message.split('\n')[0]}`));
  }
  log(`${key}: human reopen #${next.reopens.length} (${reopen.source}); severity ${next.severity?.level ?? 'not assessed'}.`);
  return next;
}

// An assessment rebuilt from what GitHub holds (the PR's gate state and each ticket's triage data), so
// any machine can evaluate a PR again without the original run.
export function rebuildAssessment(config, gh, pr, state, { log = () => {}, cwd = config.root } = {}) {
  const repo = config.board.repo;
  const view = prView(prHost(config, gh), repo, pr);
  const outcomes = safe(() => readMetricsLocal(config, OUTCOMES_FILE), []);
  const errors = [];
  // A rating counts only for the PR's own change it rated (its diff key): the pipeline's base merges keep it; any other
  // commit (a person's push, a fixing round, a conflict resolved differently), or no rating on the ticket at all (the
  // severity the gate's comment shows is not one), is not assessed until it is rated, and says why.
  const head = view.headRefOid ?? null;
  let liveKey;
  const currentKey = () => (liveKey === undefined ? (liveKey = liveDiffKey({ cwd, base: view.baseRefName ?? config.baseRef, head, host: prHost(config, gh), pr })) : liveKey);
  const tickets = (state.tickets ?? []).map((t) => {
    const read = t.issue ? safe(() => extractTriage(ticketBody(config, gh, t.issue)), null, (e) => log(`${t.key}: triage not read: ${e.message}`)) : null;
    const rated = Boolean(read && (read.severity?.level || read.impact));
    const stale = !rated || !read.ratedDiff || !currentKey() || read.ratedDiff !== currentKey();
    // The PR's change that cannot be read for sure (no merge base to trust, no host diff) is unknown: rated again.
    if (stale) errors.push(!rated ? `${t.key} has no rating on its ticket for the PR's head ${String(head ?? '?').slice(0, 7)}` : read.ratedDiff && !currentKey() ? `${t.key}'s rating cannot be matched to the PR's change at ${String(head ?? '?').slice(0, 7)} (it could not be read for sure): it is rated again` : `${t.key}'s rating is for another change than the PR's head ${String(head ?? '?').slice(0, 7)} holds`);
    const triage = stale && read ? { ...read, severity: { level: null, explanation: errors.at(-1) } } : read;
    // Every recorded reopen counts; the live read (withCurrentRejections) reads the ticket again and compares with the
    // count the gate stored on the PR (`storedReopens`): fewer found is unknown, so review.
    const reopens = ticketReopens({ key: t.key, triage, outcomes });
    return { key: t.key, issue: t.issue ? { number: t.issue } : null, signals: t.signals ?? null, ...(triage ?? {}), severity: triage?.severity ?? { level: null, explanation: errors.at(-1) }, confidence: triage?.confidence ?? { score: null, high: t.high, reasons: [] }, reopens, storedReopens: Number(t.reopens ?? 0), systems: triage?.systems ?? [], paths: triage?.paths ?? [] };
  });
  // The systems come from the PR's files as they are now, with today's settings (council C8: a regate kept the systems
  // of the first assessment, so the pipeline's own files stayed a system named "Other" after the gate stopped counting
  // them). With no file list, the stored systems stand.
  const files = safe(() => prFiles(prHost(config, gh), repo, pr), null);
  const live = Array.isArray(files) && files.length ? systemsTouched(files, gateSystemsSettings(config)) : null;
  const systems = live ? { names: live.names, shared: live.shared, contract: live.contract } : state.systems ?? { names: [], shared: false, contract: false };
  if (live) for (const t of tickets) if (Array.isArray(t.systems)) t.systems = t.systems.filter((n) => live.names.includes(n));
  const severity = prSeverity({ tickets, systems }, config.implement.reviewGate);
  const ci = safe(() => checksState(ciTarget(config, repo, gh), repo, pr, { head: view.headRefOid ?? null, ciSettings: config.implement?.reviewGate?.ci ?? {}, activities: (h) => headActivities(config, pr, h) }), null);
  // CI is a live signal: refresh each ticket's CI criterion.
  for (const t of tickets) {
    if (!t.confidence?.criteria) continue;
    const ciState = ci === 'success' ? 'met' : ci === 'pending' ? 'pending' : ci == null ? 'unknown' : 'unmet';
    const others = (t.confidence.reasons ?? []).filter((r) => !/^CI /.test(r));
    t.confidence = { ...t.confidence, criteria: { ...t.confidence.criteria, ci: ciState }, reasons: ciState === 'met' ? others : [...others, `CI ${ciState}`] };
    t.confidence.high = ciState === 'met' && !others.length && (t.confidence.score ?? 0) >= (config.implement.reviewGate.confidence?.highMin ?? 85);
  }
  // Owner questions are live too (council C6): the latest PR check of each ticket that this checkout records decides
  // them; with no record here, the questions kept in the issue's triage stand.
  const checks = safe(() => readMetricsLocal(config, 'pr-checks.jsonl'), []);
  for (const t of tickets) {
    const mine = checks.filter((r) => r.story === t.key || (Array.isArray(r.stories) && r.stories.includes(t.key))).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    // With the ticket's PR check records here, every PR check signal and the whole confidence (score, criteria, reasons,
    // the prose of the notice and the triage block) is rebuilt from the latest check (council C7), never kept from the
    // first assessment.
    if (t.signals && mine.length) {
      const fresh = ticketSignals(t.key, { prChecks: mine });
      t.signals = { ...t.signals, prCheckRounds: fresh.prCheckRounds, prCheckScore: fresh.prCheckScore, questions: fresh.questions, ci: ci ?? t.signals.ci ?? null };
      t.confidence = confidence({ ...t.signals, agent: t.agentConfidence ?? null }, config.implement.reviewGate.confidence);
      continue;
    }
    const last = mine.at(-1);
    const questions = last ? (last.questions ?? []).map((q) => q.question || q.title).filter(Boolean) : (t.confidence?.questions ?? []);
    const reasons = (t.confidence?.reasons ?? []).filter((r) => !/^needs an owner decision/.test(r));
    t.confidence = { ...(t.confidence ?? {}), questions, reasons: questions.length ? [`needs an owner decision: ${questions.join('; ')}`, ...reasons] : reasons, high: Boolean(t.confidence?.high) && !questions.length };
  }
  // The signals the gate recorded when it first assessed the PR, with CI as it is now.
  for (const t of tickets) if (t.signals) t.signals = { ...t.signals, ci: ci ?? t.signals.ci ?? null };
  return { pr: view.url ?? pr, view, tickets, severity, systems, class: prClass({ severity: severity.level, shared: systems.shared || systems.contract }), ci, headSha: view.headRefOid ?? null, assessedAt: state.assessedAt ?? null, ciReadAt: nowIso(), errors };
}

// Evaluates an open gated PR again and applies the result (the notice, labels, reviewers), auto-merging
// a PR that now qualifies. Returns { decision, state, merged }.
// What a red CI run of the PR's head fails on, and whether the pipeline wrote those tests (lib/ci-origin.mjs).
export function ciFailureOrigin(config, gh, a, { logOf = null } = {}) {
  const branch = a.view?.headRefName;
  if (!branch || !a.headSha) return null;
  const ci = ciTarget(config, config.board?.repo ?? null, gh).ci;
  const runs = ci.runs({ branch, head: a.headSha, limit: 20 }) ?? [];
  const failed = runs.filter((r) => (!r.sha || r.sha === a.headSha) && r.conclusion === 'failure');
  if (!failed.length) return null;
  const text = failed.map((r) => (logOf ? logOf(r.id) : safe(() => ci.log(r.id, { failedOnly: true }), ''))).join('\n');
  const tests = failedTestsIn(text);
  if (!tests.classes.length && !tests.specs.length) return null;
  run('git', ['fetch', '-q', 'origin', branch], { cwd: config.root });
  return originLine(pipelineOrigin(config.root, tests, { ref: a.headSha }));
}

// Whether every commit pushed after `sinceSha` only merges the base branch in (the pipeline's "keep the PR
// mergeable" merges, or GitHub's "Update branch"). Unknown history counts as a real change.
export const BASE_MERGE = /^Merge (?:\S+ into this branch \(keep the PR mergeable\)|branch '[^']+' (?:of \S+ )?into )/;
export function onlyBaseMergesSince(commits, sinceSha) {
  const i = commits.findIndex((c) => c.sha === sinceSha);
  if (i < 0) return false;
  const later = commits.slice(i + 1);
  return later.length > 0 && later.every((c) => (c.parents?.length ?? 0) > 1 && BASE_MERGE.test(String(c.commit?.message ?? '')));
}

// The review-quorum status of a PR's head, posted by the gate where the CI system cannot run it on a review event.
// { pr, state } when posted; null when the CI system runs it itself or the host takes no statuses.
export function postQuorumStatus(config, gh, pr, { ci = null } = {}) {
  const t = ciTarget(config, config.board?.repo ?? null, gh);
  const system = ci ?? t.ci;
  if (system.capabilities?.reviewEvents !== false || t.host.capabilities?.commitStatus === false) return null;
  const view = t.host.pr.get(pr);
  if (!view || view.state !== 'open' || !view.headSha) return null;
  let labels = view.labels ?? [];
  if (t.host.capabilities?.labels === false) {
    const st = readPrState(t.host, config.board?.repo ?? null, pr);
    labels = st && Number.isFinite(Number(st.approvals)) ? [`approvals:${Number(st.approvals)}`] : [];
  }
  const result = quorum({ labels, reviews: t.host.pr.reviews(pr).map(toReview), author: view.author, headSha: view.headSha, pattern: config.implement?.reviewGate?.labels?.approvals });
  t.host.pr.setStatus(view.headSha, { name: 'review-quorum', state: result.pass ? 'success' : 'failure', description: String(result.summary).slice(0, 140), pr });
  return { pr, state: result.pass ? 'success' : 'failure' };
}

export function regate(config, gh, pr, { prior, cwd = config.root, log = () => {}, extraState = {}, delivery = undefined, retryCheck = ciFlaky }) {
  const repo = config.board.repo;
  const a = rebuildAssessment(config, gh, pr, prior, { log, cwd });
  applyDeliveryCheck(a, prior, { gh, repo, pr, delivery, retryCheck, log });
  if (prior?.headSha && a.headSha && prior.headSha !== a.headSha) a.baseMergesOnly = safe(() => onlyBaseMergesSince(prCommits(prHost(config, gh), repo, pr), prior.headSha), false);
  if (a.ci === 'failure') {
    a.ciOrigin = safe(() => ciFailureOrigin(config, gh, a), null);
    if (a.ciOrigin) log(`${pr}: CI is red: ${a.ciOrigin}`);
  }
  // A person's rejection, read now from the ticket and the host, on this path too (a direct regate after the CI wait).
  Object.assign(a, withCurrentRejections(config, gh, a, { cwd }));
  let decision = decideGate(a, { settings: config.implement.reviewGate, autoMerge: config.implement.autoMerge, prior });
  let state = { ...gateState(a, decision, prior), ...extraState };
  const assignees = Object.fromEntries(a.tickets.map((t) => [t.key, t.issue ? safe(() => ticketAssignees(config, gh, t.issue.number), []) : []]));
  const context = { assignees, codeowners: readCodeowners(cwd, config.baseRef), author: a.view.author, currentLabels: a.view.labels ?? [] };
  gateEffects(config, gh, { ...a, pr }, decision, { log });
  if (decision.action === 'auto-merge') {
    const r = mergeAtBoundary(config, gh, a, decision, state, context, { cwd, prior });
    if (r.merge) {
      log(`${pr}: ${r.merge.merged ? 'checks green; auto-merge' : r.merge.problems[0]}`);
      return { decision: r.merge.decision, state: r.merge.state, merged: r.merge.merged };
    }
    // Decided again at the merge boundary: the PR's effects follow the new decision.
    decision = r.decision;
    state = { ...gateState(a, decision, prior), ...extraState };
    gateEffects(config, gh, { ...a, pr }, decision, { log });
  }
  const applied = applyReview(config, gh, a, decision, state, context);
  for (const p of applied.problems) log(`${pr}: ${p}`);
  // The issue's triage block says what the notice says (council C6: an issue kept "CI pending" after the notice moved on).
  for (const t of a.tickets.filter((x) => x.issue)) for (const p of recordTicket(config, gh, a, t)) log(`${pr} ${t.key}: triage block not refreshed (${p})`);
  return { decision, state };
}

// Open PRs the gate has labeled (`approvals:N`, including approvals:0 for a PR waiting for its checks).
export function gatedPrs(config, gh, { state = 'open' } = {}) {
  const pattern = config.implement.reviewGate.labels?.approvals ?? 'approvals:{n}';
  const prs = prHost(config, gh).pr.list({ state, limit: 200 });
  return prs.filter((p) => requiredApprovals(p.labels ?? [], pattern) != null).map((p) => ({ number: p.number, url: p.url, state: String(p.state).toUpperCase(), labels: p.labels, headRefName: p.head }));
}

// The board sync step. deps: { gh, items (board cards with severity, column, state, stateReason),
// markerOf(number) -> the last pipeline marker, commentsOf(number), applyEvent(key, event), metricsConfig,
// log }. Returns { reopens: [keys], regated: [pr urls], reviews: [pr urls], reverts: [pr urls] }.
export function syncGate(config, deps) {
  const { gh, items = [], log = () => {} } = deps;
  const at = deps.now ?? nowIso();
  const out = { reopens: [], regated: [], reviews: [], reverts: [] };
  const regate_ = new Set();

  // 1a. Cards and issues reopened by a person: assessed tickets, and bug tickets the gate has not rated (yet).
  const bug = (i) => Boolean(i.severity) || isBugTicket({ key: i.key, type: i.type ?? (i.labels?.includes('bug') ? 'bug' : null) });
  for (const item of items.filter((i) => i.key && bug(i) && !i.labels?.includes(config.board.epicLabel))) {
    const candidate = ['inProgress', 'ready', 'backlog'].includes(item.column) || (item.state === 'OPEN' && item.stateReason === 'REOPENED');
    if (!candidate) continue;
    const marker = safe(() => deps.markerOf(item.number), null, (e) => log(`${item.key}: comments not read: ${e.message}`));
    const found = cardReopen(item, marker);
    if (!found) continue;
    safe(
      () => {
        const triage = extractTriage(ticketBody(config, gh, item.number));
        // An issue that stands reopened is one reopen until it is closed again: once recorded, a later pipeline marker
        // (the re-run's review) does not count it twice. The pipeline never closes an issue; a merge does (then Done).
        if (found.source === 'issue' && marker?.column !== 'done' && (triage?.reopens ?? []).some((r) => r.source === 'issue')) return;
        const pr = triage?.pr ? safe(() => prView(prHost(config, gh), config.board.repo, triage.pr), null) : null;
        const feedback = (deps.commentsOf?.(item.number) ?? []).filter((c) => !/<!-- pipeline-board:/.test(c.body ?? '') && (!marker?.at || String(c.createdAt ?? '') > marker.at)).map((c) => `${c.author ? `@${c.author}: ` : ''}${String(c.body ?? '').replace(/\s+/g, ' ').trim()}`).join(' / ');
        recordReopen(config, gh, { key: item.key, issue: { number: item.number, url: item.url }, reopen: { at, source: found.source, detail: found.detail, pr: triage?.pr ?? null, afterMerge: pr?.state === 'MERGED', feedback: feedback || null } }, deps);
        out.reopens.push(item.key);
        if (pr?.state === 'OPEN') regate_.add(pr.url);
      },
      null,
      (e) => log(`${item.key}: reopen not recorded: ${e.message.split('\n')[0]}`),
    );
  }

  // 1b. "Changes requested" reviews on open gated PRs, and 2. every open gated PR evaluated again.
  const open = safe(() => gatedPrs(config, gh), [], (e) => log(`gated PRs not listed: ${e.message.split('\n')[0]}`));
  for (const p of open) {
    safe(
      () => {
        const prior = readPrState(prHost(config, gh), config.board.repo, p.url);
        if (!prior) return;
        const keys = (prior.tickets ?? []).map((t) => t.key);
        const fresh = newChangesRequested(prReviews(prHost(config, gh), config.board.repo, p.url), prReviewComments(prHost(config, gh), config.board.repo, p.url), keys, prior.countedReviews);
        const counted = [...(prior.countedReviews ?? [])];
        for (const cr of fresh) {
          // The review is counted only once every ticket it names has the rejection stored (a ticket with no issue, or a
          // write that fails, leaves it to the next sync; a write that succeeded is not repeated, recordReopen).
          let stored = true;
          for (const key of cr.keys) {
            const t = prior.tickets.find((x) => x.key === key);
            if (!t?.issue) {
              stored = false;
              log(`${key}: the changes requested on ${p.url} have no issue to be stored on; counted again next sync`);
              continue;
            }
            try {
              recordReopen(config, gh, { key, issue: { number: t.issue }, reopen: { at: cr.review.submitted_at ?? at, source: 'changes-requested', detail: `changes requested by @${cr.review.user?.login ?? '?'}`, by: cr.review.user?.login ?? null, pr: p.url, afterMerge: false, feedback: cr.feedback || null } }, deps);
              out.reopens.push(key);
            } catch (error) {
              stored = false;
              log(`${key}: reopen not recorded: ${error.message.split('\n')[0]}`);
            }
          }
          if (stored) counted.push(cr.review.id);
        }
        // A reopened ticket blocks the PR's auto-merge for good.
        if (fresh.length || regate_.has(p.url)) disableAutoMerge(prHost(config, gh), config.board.repo, p.url);
        // The notice states the PR's checks; when they finished (or changed) since it was written, it is written again
        // (council C2: notices said "CI: pending" days after CI passed).
        const ci = safe(() => checksState(ciTarget(config, config.board.repo, gh), config.board.repo, p.url, { ciSettings: config.implement?.reviewGate?.ci ?? {}, activities: (h) => headActivities(config, p.url, h) }), null);
        const ciChanged = ci != null && ci !== (prior.ci ?? null);
        // A PR waiting for its checks or for GitHub to clear its merge, or whose merge failed, is tried again each
        // sync; so is one that earlier gate versions sent to review only because a merge attempt failed.
        const mergeOnly = prior.action === 'review' && (prior.triggers ?? []).length > 0 && prior.triggers.every(isMergeTrigger);
        if (fresh.length || regate_.has(p.url) || ['wait', 'merge-failed'].includes(prior.action) || mergeOnly || ciChanged) {
          regate(config, gh, p.url, { prior: { ...prior, countedReviews: counted }, cwd: deps.cwd ?? config.root, log, extraState: { countedReviews: counted } });
          out.regated.push(p.url);
          regate_.delete(p.url);
        }
        // A CI system that starts no pipeline on a review (capability reviewEvents off: Jenkins, CircleCI, ...): the gate
        // posts review-quorum on the head itself, so an approval counts without a new push.
        const posted = safe(() => postQuorumStatus(config, gh, p.url), null, (e) => log(`${p.url}: review-quorum status not posted: ${e.message.split('\n')[0]}`));
        if (posted) (out.quorum ??= []).push(posted);
      },
      null,
      (e) => log(`${p.url}: not evaluated: ${e.message.split('\n')[0]}`),
    );
  }
  // A reopened ticket whose PR is open but no longer labeled (a person removed it) is gated again too.
  for (const url of regate_) {
    safe(
      () => {
        const prior = readPrState(prHost(config, gh), config.board.repo, url);
        if (!prior) return;
        disableAutoMerge(prHost(config, gh), config.board.repo, url);
        regate(config, gh, url, { prior, cwd: deps.cwd ?? config.root, log });
        out.regated.push(url);
      },
      null,
      (e) => log(`${url}: not evaluated: ${e.message.split('\n')[0]}`),
    );
  }
  // 3. Closed gated PRs: one pr-review record each, for the retro; reverts of merged ones.
  safe(() => Object.assign(out, recordClosedPrs(config, gh, deps)), null, (e) => log(`pr-review records: ${e.message.split('\n')[0]}`));
  return out;
}

// Writes a `pr-review` record for every recently closed gated PR not recorded yet, and a `revert`
// record when a recorded merge was reverted on the base branch (`deps.baseLog()` -> [{ sha, subject, body }]).
export function recordClosedPrs(config, gh, { metricsConfig, log = () => {}, baseLog = () => [], now = null }) {
  const file = metricsFile(metricsConfig, OUTCOMES_FILE);
  const existing = readMetricsLocal(metricsConfig, OUTCOMES_FILE);
  const recorded = new Set(existing.filter((r) => r.type === 'pr-review' || r.type === 'pr-closed').map((r) => r.pr));
  const reverted = new Set(existing.filter((r) => r.type === 'revert').map((r) => r.pr));
  const repo = config.board.repo;
  const min = config.implement.reviewGate.substantiveCommentChars ?? 20;
  const reviews = [];
  for (const p of gatedPrs(config, gh, { state: 'closed' }).filter((x) => !recorded.has(x.url))) {
    safe(
      () => {
        const state = readPrState(prHost(config, gh), repo, p.url);
        if (!state) return;
        const view = prView(prHost(config, gh), repo, p.url);
        // A PR closed without merge is not a review: it is marked once and kept out of the review statistics (dogfood
        // C2: the retired attempts' PRs counted as 0-approval reviews). The pipeline never closes a PR it delivered,
        // except to hold it (implement.preOpen.afterOpen close-reopen, which leaves its hold comment): any other close is
        // a person rejecting the delivery, recorded as a reopen of each of its tickets.
        if (!view.mergedAt) {
          // The pipeline's own close (a close-reopen hold it recorded by its event) is left for the hold to end; a close
          // that is a person's is a rejection of each of its tickets; one whose provenance cannot be read is recorded as
          // nothing yet (the gate reads it live as unknown, so review) and tried again next sync.
          const why = 'PR closed without merge';
          let held;
          try {
            const { events, person, unknown } = personEvents(prHost(config, gh), p.url);
            const last = events.filter((e) => e.type === 'closed').at(-1);
            // Made by the pipeline's own login with no record of the pipeline naming it: never stored as a person's
            // rejection; the gate reads it as unknown (review) meanwhile.
            if (last && unknown.includes(last)) throw new Error('the close was made by the pipeline\'s own login and no record of the pipeline names it');
            held = Boolean(last) && !person.includes(last);
          } catch (error) {
            log(`${p.url}: closed without merge; whether by a person could not be read (${error.message.split('\n')[0]}): review until it can, tried again next sync.`);
            return;
          }
          if (held) {
            log(`${p.url}: closed by a pipeline hold; not recorded until the hold ends.`);
            return;
          }
          const rejected = [];
          const failed = [];
          for (const t of state.tickets ?? []) {
            if (!t?.issue) {
              failed.push(t?.key ?? '?');
              continue;
            }
            try {
              recordReopen(config, gh, { key: t.key, issue: { number: t.issue }, reopen: { at: view.closedAt ?? now ?? nowIso(), source: 'pr-closed', detail: why, pr: p.url, afterMerge: false } }, { metricsConfig, log });
              rejected.push(t.key);
            } catch (error) {
              failed.push(t.key);
              log(`${t.key}: reopen not recorded: ${error.message.split('\n')[0]}`);
            }
          }
          // Persisted before the close is consumed: a ticket not recorded keeps the PR unrecorded, so the next sync tries
          // again (the gate reads the close live meanwhile).
          if (failed.length) {
            log(`${p.url}: closed without merge; the rejection of ${failed.join(', ')} was not recorded yet: tried again next sync.`);
            return;
          }
          appendJsonl(file, { type: 'pr-closed', ts: now ?? nowIso(), pr: p.url, superseded: true, closedAt: view.closedAt ?? null, ...(rejected.length ? { rejected } : {}) });
          log(`${p.url}: closed without merge; not counted in the review statistics${rejected.length ? `; a rejection of ${rejected.join(', ')}` : ''}.`);
          return;
        }
        // An auto-merge the gate enabled has now happened: the notice says so, with the time.
        if (state.action === 'auto-merge' && !state.merge?.merged) safe(() => {
          const a = rebuildAssessment(config, gh, p.url, state, { log });
          const done = { ...state, merge: { ...(state.merge ?? {}), merged: true, mergedAt: view.mergedAt } };
          upsertComment(prHost(config, gh), repo, p.url, MARKER, renderNotice(a, { action: 'auto-merge', approvals: 0, triggers: [], wouldAutoMerge: [], reasons: state.reasons ?? [] }, done));
        }, null, (e) => log(`${p.url}: notice not refreshed: ${e.message.split('\n')[0]}`));
        const triages = (state.tickets ?? []).map((t) => (t.issue ? safe(() => extractTriage(ticketBody(config, gh, t.issue)), null) : null)).filter(Boolean);
        const rec = prReviewRecord({ ts: now ?? nowIso(), view, state, triages, reviews: prReviews(prHost(config, gh), repo, p.url), comments: prReviewComments(prHost(config, gh), repo, p.url), commits: ghLinesSafe(prHost(config, gh), repo, p.url), min });
        appendJsonl(file, rec);
        reviews.push(p.url);
        log(`${p.url}: review recorded (${rec.class}, ${rec.approvals} approval(s), ${rec.reviewers.length} reviewer(s)).`);
      },
      null,
      (e) => log(`${p.url}: review not recorded: ${e.message.split('\n')[0]}`),
    );
  }
  const reverts = [];
  const log_ = safe(() => baseLog(), []);
  for (const rec of [...existing.filter((r) => r.type === 'pr-review' && r.merged && !reverted.has(r.pr))]) {
    const hits = revertsOf(rec, log_, null);
    if (!hits.length) continue;
    appendJsonl(file, { ts: now ?? nowIso(), type: 'revert', pr: rec.pr, stories: rec.stories, commits: hits.map((h) => h.sha) });
    reverts.push(rec.pr);
    log(`${rec.pr}: reverted on the base branch (${hits.map((h) => h.sha.slice(0, 7)).join(', ')}).`);
  }
  return { reviews, reverts };
}

const ghLinesSafe = (gh, repo, pr) => safe(() => prCommits(gh, repo, pr), []);
