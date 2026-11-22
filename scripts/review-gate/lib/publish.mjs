// What runs after the pipeline publishes a fix PR (a single-ticket bug PR or a bug-epic group PR):
// assess it (triage agent + harness), record the assessment on the tickets and in the decision log,
// then gate it (review notice, labels and reviewers, or a wait for its checks).
// Nothing here changes the factory flow before the PR exists, and nothing fails a pipeline outcome.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { assessPr, liveDiffKey, logTriageDecision, mainCheckout, recordTicket } from './assessment.mjs';
import { LIVE, withCurrentRejections } from './rejections.mjs';
import { applyDeliveryCheck } from './delivery-check.mjs';
import { autoMergePr, disarmUnlessMerging } from './automerge.mjs';
import { applyReview, decideGate, gateState, readPrState, rejectionSection, withRejectionSection } from './gate.mjs';
import { prHost, prNumber, prView } from './github.mjs';
import { ticketAssignees } from './fields.mjs';
import { parseCodeowners } from './systems.mjs';

export const stateFile = (config, pr) => path.join(config.root, config.stateDir, 'review-gate', `pr-${prNumber(pr)}.json`);
export const loadGateState = (config, pr) => readJson(stateFile(config, pr), null);
export const saveGateState = (config, pr, state) => writeJson(stateFile(config, pr), { ...state, updatedAt: nowIso() });

const CODEOWNERS_FILES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

// The CODEOWNERS rules GitHub applies to a PR: the file on its base branch (`base`, e.g. origin/main),
// not the PR's own copy (a fix branch may predate the file, or change it). Falls back to the working tree.
export function readCodeowners(root, base = null) {
  if (base) {
    for (const f of CODEOWNERS_FILES) {
      const r = git(root, ['show', `${base}:${f}`]);
      if (r.status === 0) return parseCodeowners(r.stdout);
    }
  }
  const file = CODEOWNERS_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  return parseCodeowners(file ? fs.readFileSync(file, 'utf8') : '');
}

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// Decides and applies the gate for an assessment. `prior` is the gate state already on the PR.
// Returns { decision, state, problems }.
export function gatePr(config, a, { gh, prior = null, cwd = config.root, log = () => {}, retryCheck = undefined }) {
  const s = config.implement.reviewGate;
  const repo = config.board.repo;
  applyDeliveryCheck(a, prior, { gh, repo, pr: a.pr, log, ...(retryCheck !== undefined ? { retryCheck } : {}) });
  // A person's rejection, read now from the ticket and the host (never only from what an earlier step recorded); read
  // once per decision (publishGate reads it before it records the tickets).
  if (!a[LIVE]) Object.assign(a, withCurrentRejections(config, gh, a, { cwd }));
  let decision = decideGate(a, { settings: s, autoMerge: config.implement.autoMerge, prior });
  const pr = safe(() => prView(prHost(config, gh), repo, a.pr), null);
  const assignees = Object.fromEntries(a.tickets.map((t) => [t.key, t.issue ? safe(() => ticketAssignees(config, gh, t.issue.number), []) : []]));
  let state = gateState(a, decision, prior);
  const context = { assignees, codeowners: readCodeowners(cwd, a.base ?? config.baseRef), author: pr?.author ?? null, currentLabels: pr?.labels ?? [] };
  const early = gateEffects(config, gh, a, decision, { log });
  if (decision.action === 'auto-merge') {
    const r = mergeAtBoundary(config, gh, a, decision, state, context, { cwd, prior });
    if (r.merge) {
      const m = r.merge;
      log(`${a.pr}: ${m.merged ? `auto-merge (${m.state.merge.identity}, ${m.state.merge.method})` : m.problems[0]}`);
      return { decision: m.decision, state: m.state, problems: [...early, ...(m.merged ? m.problems : m.problems.slice(1))] };
    }
    // Decided again at the merge boundary: the PR's effects follow the new decision.
    decision = r.decision;
    state = gateState(a, decision, prior);
    early.push(...gateEffects(config, gh, a, decision, { log }));
  }
  const applied = applyReview(config, gh, a, decision, state, context);
  log(`${a.pr}: ${decision.action}${decision.action === 'review' ? ` (${decision.approvals} approval(s): ${decision.triggers.join('; ')})` : ''}${applied.reviewers.length ? `; review requested from ${applied.reviewers.join(', ')}` : ''}`);
  for (const p of applied.problems) log(`${a.pr}: ${p}`);
  return { decision, state: { ...state, reviewers: applied.reviewers }, problems: [...early, ...applied.problems] };
}

// The merge boundary, in one place for publish and regate: a decision to merge reads each ticket's rejections once more
// immediately before the host's merge call (inside mergePr, after the merge state was read and waited for) and merges
// only if nothing changed: { merge } with autoMergePr's result, or { decision } decided again (review) when a "changes
// requested", a close or a reopen arrived since the decision's read, or the history is unknown now. The window between
// this read and the host's own merge is not covered (docs/ai-pipeline/review-gate.md).
export function mergeAtBoundary(config, gh, a, decision, state, context, { cwd = config.root, prior = null } = {}) {
  const boundary = () => {
    const final = atMergeBoundary(config, gh, a, decision, { cwd, prior });
    return final.action === 'auto-merge' ? null : final;
  };
  const merge = autoMergePr(config, gh, a, decision, state, context, { boundary });
  return merge.decidedAgain ? { decision: merge.decidedAgain, merge: null } : { decision, merge };
}
function atMergeBoundary(config, gh, a, decision, { cwd = config.root, prior = null } = {}) {
  if (decision.action !== 'auto-merge') return decision;
  const again = withCurrentRejections(config, gh, a, { cwd });
  const fresh = again.tickets.some((t, i) => t.rejectionChecked !== true || (t.reopens?.length ?? 0) > (a.tickets[i].reopens?.length ?? 0));
  if (!fresh) return decision;
  Object.assign(a, again);
  return decideGate(a, { settings: config.implement.reviewGate, autoMerge: config.implement.autoMerge, prior });
}

// What every gate decision does on the PR first (publish and regate): the host's auto-merge disarmed unless the decision
// merges, and the description's reason a person must review rebuilt from this read. Returns the problems.
export function gateEffects(config, gh, a, decision, { log = () => {} } = {}) {
  const problems = [];
  const host = prHost(config, gh);
  try {
    disarmUnlessMerging(host, config.board.repo, a.pr, decision, { log, headSha: a.headSha });
  } catch (error) {
    problems.push(`auto-merge not disarmed: ${error.message.split('\n')[0]}`);
  }
  try {
    const body = host.pr.get(a.pr)?.body ?? '';
    const next = withRejectionSection(body, rejectionSection(a, decision.approvals));
    if (next !== body) host.pr.update(a.pr, { body: next });
  } catch (error) {
    problems.push(`PR description not updated with why a person reviews it: ${error.message.split('\n')[0]}`);
  }
  for (const p of problems) log(`${a.pr}: ${p}`);
  return problems;
}

// deps: { gh, runAgent, log }. Returns { assessment, decision, problems }.
// `assessment`: one computed before the PR existed (`review-gate assess`, implement.preOpen): publishing it is
// deterministic, no model runs once the PR is open; it is bound to the PR and its head here.
// `noAgent`: set by pipeline delivery so publishing on an open PR never starts a triage agent; if no saved assessment
// is provided, publishes an unassessed result (`review` / `needs-human`) and records why.
export function publishGate(config, { pr, keys, cwd = config.root, base, assessment: before = null, noAgent = false, missingReason: missing = null }, deps) {
  let missingReason = missing;
  const log = deps.log ?? (() => {});
  // A saved assessment counts only for the PR's own change as the host has it now (its diff key: the pipeline's base
  // merges keep it, any other commit voids it; else the PR is published as not assessed: a person reviews it). Whatever
  // is published is stamped with the PR's head as the host reports it, never this checkout's; its reopens are read again
  // below, so a rejection since then counts.
  const view = safe(() => prView(prHost(config, deps.gh), config.board.repo, pr), null);
  const liveHead = view?.headRefOid ?? null;
  const liveKey = liveHead ? liveDiffKey({ cwd, base: view?.baseRefName ?? base, head: liveHead, host: prHost(config, deps.gh), pr }) : null;
  const bound = before && before.diffKey && liveKey && before.diffKey === liveKey;
  if (before && !bound) missingReason = `the saved rating is for another change than the PR's head ${String(liveHead ?? 'unread').slice(0, 7)} holds`;
  const fresh = !before && !noAgent;
  const assessment = bound
    ? { ...before, pr, number: prNumber(pr), assessedBeforeOpen: true, headSha: liveHead }
    : before || noAgent
      ? { ...assessPr(config, { pr, keys, cwd, base, skipTriage: true, skipReason: missingReason ?? 'no saved pre-open assessment (no agent may run after the PR opens)' }, deps), headSha: liveHead, diffKey: liveKey }
      : assessPr(config, { pr, keys, cwd, base }, deps);
  // A rating made here (by hand) on a checkout that is not at the PR's head is not published for that head.
  if (fresh && assessment.headSha !== liveHead) return { assessment, decision: null, problems: [`this checkout is at ${String(assessment.headSha).slice(0, 7)}, not the PR's head ${String(liveHead ?? 'unread').slice(0, 7)}: nothing published`], published: false };
  // This publication's own mark: the readback must show it, not an earlier notice for the same head and decision.
  assessment.publication = crypto.randomUUID();
  const problems = [];
  // Recorded on the tickets with what the host says now (a rejection the ticket's record did not have yet included);
  // the severity is recomputed with it, and the gate decides on this same read.
  Object.assign(assessment, withCurrentRejections(config, deps.gh, assessment, { cwd }));
  for (const t of assessment.tickets) {
    const p = recordTicket(config, deps.gh, assessment, t);
    if (p.length && !(p.length === 1 && p[0] === 'no issue')) problems.push(`${t.key}: ${p.join('; ')}`);
  }
  log(`${pr}: severity ${assessment.severity.level ?? 'unknown'} (${assessment.severity.explanation}); ${assessment.tickets.map((t) => `${t.key} ${t.severity.level ?? '?'}, confidence ${t.confidence.score}`).join('; ')}`);
  const prior = safe(() => readPrState(prHost(config, deps.gh), config.board.repo, pr), null);
  const gate = gatePr(config, assessment, { gh: deps.gh, prior, cwd, log });
  problems.push(...gate.problems);
  const main = { ...config, root: mainCheckout(cwd) };
  logTriageDecision(main, assessment, gate.decision);
  saveGateState(main, pr, { pr, assessment, gate: gate.state });
  for (const p of problems) log(`not recorded: ${p}`);
  // Published only once the host shows it: the gate's state on the PR, for this head and this decision (delivery holds a
  // bug PR until it is, and treats anything else as a failed publication).
  const shown = safe(() => readPrState(prHost(config, deps.gh), config.board.repo, pr), null);
  const published = Boolean(liveHead && shown && shown.publication === assessment.publication && shown.headSha === liveHead && shown.action === gate.state.action);
  return { assessment, decision: gate.decision, problems, published };
}
