// What runs after the pipeline publishes a fix PR (a single-ticket bug PR or a bug-epic group PR):
// assess it (triage agent + harness), record the assessment on the tickets and in the decision log,
// then gate it (review notice, labels and reviewers, or a wait for its checks).
// Nothing here changes the factory flow before the PR exists, and nothing fails a pipeline outcome.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { assessPr, logTriageDecision, mainCheckout, recordTicket } from './assessment.mjs';
import { applyDeliveryCheck } from './delivery-check.mjs';
import { autoMergePr, disarmUnlessMerging } from './automerge.mjs';
import { applyReview, decideGate, gateState, readPrState } from './gate.mjs';
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
  const decision = decideGate(a, { settings: s, autoMerge: config.implement.autoMerge, prior });
  const pr = safe(() => prView(prHost(config, gh), repo, a.pr), null);
  const assignees = Object.fromEntries(a.tickets.map((t) => [t.key, t.issue ? safe(() => ticketAssignees(config, gh, t.issue.number), []) : []]));
  const state = gateState(a, decision, prior);
  const context = { assignees, codeowners: readCodeowners(cwd, a.base ?? config.baseRef), author: pr?.author ?? null, currentLabels: pr?.labels ?? [] };
  safe(() => disarmUnlessMerging(prHost(config, gh), repo, a.pr, decision, { log, headSha: a.headSha }), false);
  if (decision.action === 'auto-merge') {
    const m = autoMergePr(config, gh, a, decision, state, context);
    log(`${a.pr}: ${m.merged ? `auto-merge (${m.state.merge.identity}, ${m.state.merge.method})` : m.problems[0]}`);
    return { decision: m.decision, state: m.state, problems: m.merged ? m.problems : m.problems.slice(1) };
  }
  const applied = applyReview(config, gh, a, decision, state, context);
  log(`${a.pr}: ${decision.action}${decision.action === 'review' ? ` (${decision.approvals} approval(s): ${decision.triggers.join('; ')})` : ''}${applied.reviewers.length ? `; review requested from ${applied.reviewers.join(', ')}` : ''}`);
  for (const p of applied.problems) log(`${a.pr}: ${p}`);
  return { decision, state: { ...state, reviewers: applied.reviewers }, problems: applied.problems };
}

// deps: { gh, runAgent, log }. Returns { assessment, decision, problems }.
// `assessment`: one computed before the PR existed (`review-gate assess`, implement.preOpen): publishing it is
// deterministic, no model runs once the PR is open; it is bound to the PR and its head here.
// `noAgent`: set by pipeline delivery so publishing on an open PR never starts a triage agent; if no saved assessment
// is provided, publishes an unassessed result (`review` / `needs-human`) and records why.
export function publishGate(config, { pr, keys, cwd = config.root, base, assessment: before = null, noAgent = false, missingReason = null }, deps) {
  const log = deps.log ?? (() => {});
  const assessment = before
    ? { ...before, pr, number: prNumber(pr), assessedBeforeOpen: true }
    : noAgent
      ? assessPr(config, { pr, keys, cwd, base, skipTriage: true, skipReason: missingReason ?? 'no saved pre-open assessment (no agent may run after the PR opens)' }, deps)
      : assessPr(config, { pr, keys, cwd, base }, deps);
  const problems = [];
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
  return { assessment, decision: gate.decision, problems };
}
