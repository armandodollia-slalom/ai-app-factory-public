// Human reopens of a bug ticket (a person rejected a delivery), counted apart from feature verification's bug-fix
// cycles. `board sync` finds them:
//   card              the card moved back to In Progress, Ready or Backlog from Pending Review or Done with no
//                     pipeline event behind it (the last pipeline event on the card left it in review or done)
//   issue             the issue was reopened (open again after it was closed)
//   changes-requested a "changes requested" review on the PR, against the tickets it names (or all the
//                     PR's tickets when it names none); each review counts once
//   pr-closed         a gated PR closed without merge (the pipeline never closes one, except a close-reopen hold)
//   requeue           `implement requeue` running a ticket again after a person resolved an escalation of a delivery
//                     that had a PR
// A reopen is kept in the ticket's `## Triage` section and in the metrics (`decision-outcomes.jsonl`); every assessment
// reads both, so a re-run, a follow-up PR or a group PR still sees it.
// The board is a user project, so projects_v2_item webhooks don't fire and Actions can't watch lane
// moves: the sync compares the card with the last pipeline event instead.
//
// Each reopen bumps the ticket's severity by one level (capped at Severe) and blocks auto-merge for it
// for good. Before its PR merges, the PR's gate goes to review and the ticket re-runs on its branch;
// after the merge, the ticket re-runs as a follow-up PR through the same gate.
import { ticketSeverity } from './severity.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';

const KEY = /\b([A-Z][A-Z0-9]*-\d+)\b/g;

// The reopen a card shows, or null. `item`: { column, state, stateReason }; `marker`: the last
// pipeline event marker on the issue ({ event, column }).
// The lanes a card moves back to; named as board.columns' defaults (the detail is the same on every board).
const BACK = ['inProgress', 'ready', 'backlog'];
const COLUMN = defaultSettings().board.columns;
export function cardReopen(item, marker) {
  const left = marker?.column ?? null;
  if (!['review', 'done'].includes(left)) return null;
  if (BACK.includes(item.column)) return { source: 'card', detail: `card moved from ${COLUMN[left]} back to ${COLUMN[item.column]}` };
  if (item.state === 'OPEN' && item.stateReason === 'REOPENED') return { source: 'issue', detail: 'issue reopened' };
  return null;
}

// One reopen, however many places record it: the same source, PR and time (to the second).
const reopenId = (r) => `${r?.source ?? ''}|${r?.pr ?? ''}|${String(r?.at ?? '').slice(0, 19)}`;
export function mergeReopens(...lists) {
  const out = new Map();
  for (const r of lists.flat()) if (r && typeof r === 'object' && !out.has(reopenId(r))) out.set(reopenId(r), r);
  return [...out.values()];
}

// Every recorded reopen of a ticket: its `## Triage` section's and the metrics' `reopen` rows (either may be missing: a
// triage written again from a stale assessment, a checkout without the metrics).
export function ticketReopens({ key, triage = null, outcomes = [] }) {
  const rows = (outcomes ?? []).filter((r) => r?.type === 'reopen' && r.story === key).map((r) => ({ at: r.ts ?? null, source: r.source ?? 'reopen', detail: r.detail ?? null, by: r.by ?? null, pr: r.pr ?? null, afterMerge: Boolean(r.afterMerge) }));
  return mergeReopens(triage?.reopens ?? [], rows);
}

// The tickets a "changes requested" review names (in its body or its inline comments), else all of them.
export function reviewTargets(review, comments, keys) {
  const text = [review.body ?? '', ...comments.filter((c) => c.pull_request_review_id === review.id).map((c) => `${c.path ?? ''} ${c.body ?? ''}`)].join('\n');
  const named = [...new Set([...text.matchAll(KEY)].map((m) => m[1]).filter((k) => keys.includes(k)))];
  return named.length ? named : keys;
}

// The "changes requested" reviews not counted yet: [{ review, keys, feedback }].
export function newChangesRequested(reviews, comments, keys, counted = []) {
  const seen = new Set((counted ?? []).map(String));
  return (reviews ?? [])
    .filter((r) => r.state === 'CHANGES_REQUESTED' && !seen.has(String(r.id)))
    .map((r) => ({ review: r, keys: reviewTargets(r, comments ?? [], keys), feedback: reviewFeedback(r, comments ?? []) }));
}

// What the reviewer asked for, for the re-run: the review body and its inline comments.
export function reviewFeedback(review, comments, max = 4000) {
  const inline = comments.filter((c) => c.pull_request_review_id === review.id).map((c) => `- \`${c.path}${c.line ? `:${c.line}` : ''}\`: ${String(c.body ?? '').replace(/\s+/g, ' ').trim()}`);
  const text = [String(review.body ?? '').trim(), ...inline].filter(Boolean).join('\n');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The triage data with one more reopen: severity recomputed from the stored ratings and floor.
export function withReopen(triage, reopen, settings) {
  const reopens = [...(triage.reopens ?? []), reopen];
  const severity = ticketSeverity({ impact: triage.impact, complexity: triage.complexity, fixRisk: triage.fixRisk, floorReasons: triage.floorReasons ?? [], reopens: reopens.length }, settings);
  return { ...triage, reopens, severity };
}

// The note added to the ticket's `## Decisions` for the re-run: binding, like a human's answers.
export function reopenDecisionNote(reopen) {
  const who = reopen.by ? ` by @${reopen.by}` : '';
  const where = reopen.pr ? ` on ${reopen.pr}` : '';
  const head = reopen.source === 'changes-requested'
    ? `Changes requested${who}${where}`
    : reopen.source === 'issue'
      ? `Issue reopened${who}`
      : reopen.source === 'pr-closed'
        ? `PR closed without merge${where}`
        : reopen.source === 'requeue'
          ? `Re-queued after a person's decision${where}`
          : `Card moved back to ${/back to (.+)$/.exec(reopen.detail ?? '')?.[1] ?? 'In Progress'}${who}`;
  return `Human reopen (${head}${reopen.afterMerge ? ', after the PR merged' : ''}): ${reopen.feedback ? reopen.feedback.replace(/\s+/g, ' ').trim() : 'no reason given; see the latest comments on this issue and its PR.'}`;
}
