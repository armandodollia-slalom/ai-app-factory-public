// The gate: from an assessment, decide whether the PR may auto-merge, must wait for its checks, or
// needs people, and apply that to the PR (labels, reviewer requests, the review notice).
//
// Auto-merge only when the PR severity is Low, every ticket has high confidence, no ticket has a human
// reopen, and the checks pass (and implement.autoMerge.enabled). Everything else needs at least one
// approval: the PR gets `approvals:N` (N from the approvals policy table, never below 1) and
// `needs-human`, reviews are requested from the tickets' assignees (or the CODEOWNERS of the systems a
// ticket touches when it has none), and a comment says exactly what triggered the review. Once a PR
// needs people it stays that way (`required` is sticky), so the gate never merges a PR a person was
// asked to review. CODEOWNERS stay optional reviewers on every PR: the gate only sets how many
// approvals are required.
import { describeSignals } from './confidence.mjs';
import { editPrLabels, findComment, prHost, requestReviewers, upsertComment } from './github.mjs';
import { ownersOfFiles } from './systems.mjs';
import { defaultSettings, setting } from '../../pipeline/lib/settings.mjs';

export const MARKER = 'review-gate:';
const MARKER_RE = /<!-- review-gate:(\{.*?\}) -->/;
export const encodeState = (s) => `<!-- review-gate:${JSON.stringify(s).replace(/--/g, '-\\u002d')} -->`;
export function parseState(body) {
  const m = MARKER_RE.exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const list = (keys) => (keys.length <= 1 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`);

// The approvals a PR of this class needs: the policy table's entry for the class (e.g. "High+shared"),
// else for its severity, else `default`; never fewer than 1 for a PR that does not auto-merge.
export function approvalsFor(table, { cls, severity }) {
  const n = [table?.[cls], table?.[severity], table?.default, 1].find((v) => Number.isInteger(v));
  return Math.max(1, n);
}

// A ticket's confidence problems, with CI left to the PR-level decision (pending CI is a wait, not a
// review; failing CI is a PR-level trigger).
// A trigger that only says a merge attempt failed is not a reason for people to review (dogfood C6): earlier gate
// versions recorded "auto-merge failed (...)" as a review trigger, which then stuck to the PR.
export const isMergeTrigger = (t) => /^(auto-)?merge failed\b/.test(String(t));
// Failing checks are a live signal too: the trigger holds while the checks fail and is decided again each time.
const isCiTrigger = (t) => /^the PR's checks are failing\b/.test(String(t));
// The delivery decision is live too: it holds while the gate state carries it and is cleared only by a later CI gate.
const isDeliveryTrigger = (t) => /^the delivery needs a person's decision\b/.test(String(t));
// Triggers every evaluation derives again from the tickets (severity, confidence, owner decisions, reopens, PR
// severity) are never carried from an earlier one (council C11: #154's notice kept "confidence 73" next to the
// current 81). Only what a later evaluation cannot see again (the PR changed after it was assessed) sticks.
const isDerivedTrigger = (t) => /^\S+ (has confidence \d+|is (Low|Medium|High|Severe)\b|needs an owner decision|was not assessed|has \d+ human reopen|could not be checked for a rejection|was not checked for a rejection)|^the PR is (Low|Medium|High|Severe)|^PR severity /.test(String(t));
const reviewTriggers = (prior) => (prior?.triggers ?? []).filter((t) => !isMergeTrigger(t) && !isCiTrigger(t) && !isDeliveryTrigger(t) && !isDerivedTrigger(t));
// What the CI gate left for a person (council C7): a test that passed only on a retry, red or unverified CI, or a fix
// round that escalated. `a.delivery` is set when a CI gate just ran (null clears it); otherwise the stored one holds.
export const deliveryOf = (a, prior) => (a.delivery !== undefined ? a.delivery : prior?.delivery ?? null);
export const deliveryTrigger = (d) => `the delivery needs a person's decision: ${d.reason}`;

const confidenceProblems = (t) => (t.confidence?.reasons ?? []).filter((r) => !/^CI /.test(r));

// What settles a review a person's rejection (known or unknown) requires: the same sentence in the notice and the PR
// description, naming the number of approvals of this PR's head when more than one is required.
export const settles = (n) => (Number(n) > 1 ? `${n} approvals of this PR's head by people settle it` : 'a person\'s approval of this PR settles it');

// { action: 'auto-merge' | 'wait' | 'review', approvals, triggers: [text], wouldAutoMerge: [keys], reasons }
export function decideGate(a, { settings, autoMerge, prior = null }) {
  const triggers = [];
  const okTickets = [];
  for (const t of a.tickets) {
    const own = [];
    if (!t.severity?.level) own.push(`${t.key} was not assessed${a.errors?.length ? ` (${a.errors[0]})` : ''}`);
    else if (t.severity.level !== 'Low') own.push(`${t.key} is ${t.severity.level} (${[...(t.systems?.length ? [t.systems.join(', ')] : []), t.severity.explanation].join('; ')})`);
    const conf = confidenceProblems(t);
    if (t.severity?.level && conf.length) own.push(`${t.key} has confidence ${t.confidence.score} (${conf.join('; ')})`);
    // A ticket the check left with a question for its owner is never auto-merged, at any severity (council C6).
    if (t.confidence?.questions?.length) own.unshift(`${t.key} needs an owner decision: ${t.confidence.questions.join('; ')}`);
    // A ticket a person rejected earlier always needs a person again, whatever its new rating (owner rule); so does one
    // whose earlier rejections could not be read.
    // Merging needs positive proof that no person rejected the ticket: its history read now (withCurrentRejections).
    const settled = settles(approvalsFor(settings.approvals, { cls: a.class, severity: a.severity?.level ?? 'Severe' }));
    if (t.reopens?.length) own.push(`${t.key} has ${t.reopens.length} human reopen(s): rejected by a person earlier, so a person reviews it again (${settled})`);
    else if (t.reopensUnknown) own.push(`${t.key} could not be checked for a rejection by a person earlier: ${t.reopensUnknown} (${settled})`);
    else if (t.rejectionChecked !== true) own.push(`${t.key} was not checked for a rejection by a person earlier (${settled})`);
    if (own.length) triggers.push(...own);
    else okTickets.push(t.key);
  }
  // Never auto-merged at any severity while the delivery waits for a person (council C7).
  const delivery = deliveryOf(a, prior);
  if (delivery?.state) triggers.unshift(deliveryTrigger(delivery));
  // PR-level reasons the tickets alone do not explain: several systems, shared infrastructure, a contract.
  if (a.severity?.level && a.severity.level !== 'Low' && !a.tickets.some((t) => t.severity?.level && t.severity.level !== 'Low')) triggers.push(`the PR is ${a.severity.level}: ${a.severity.explanation}`);
  else if (a.severity?.level && (a.severity.bumped || a.severity.floor)) triggers.push(`PR severity ${a.severity.level}: ${a.severity.explanation}`);
  if (a.ci === 'failure') triggers.push(a.ciOrigin ? `the PR's checks are failing: ${a.ciOrigin}` : 'the PR\'s checks are failing');
  if (prior?.required) triggers.push(...reviewTriggers(prior).filter((x) => !triggers.includes(x)));
  // The pipeline's own base merges (`board sync` keeping the PR mergeable) are not a change to review.
  if (prior?.headSha && a.headSha && prior.headSha !== a.headSha && ['wait', 'merge-failed'].includes(prior.action) && !a.baseMergesOnly) triggers.push('the PR changed after it was assessed');

  if (!triggers.length) {
    if (a.ci !== 'success') return { action: 'wait', approvals: 0, triggers, wouldAutoMerge: okTickets, reasons: [`waiting for the PR's checks (${a.ci ?? 'none reported yet'})`] };
    // Nothing merges before the delivery check (the retry check) has run on this head (council C8).
    const checked = a.deliveryChecked ?? prior?.deliveryChecked ?? null;
    if (!a.headSha || checked !== a.headSha) return { action: 'wait', approvals: 0, triggers, wouldAutoMerge: okTickets, reasons: ['waiting for the delivery check (no retried test) on the PR\'s head'] };
    if (!autoMerge?.enabled) {
      const off = 'auto-merge is switched off (implement.autoMerge.enabled); it would have auto-merged';
      return { action: 'review', approvals: approvalsFor(settings.approvals, { cls: a.class, severity: a.severity.level }), triggers: [off], wouldAutoMerge: okTickets, reasons: [off] };
    }
    return { action: 'auto-merge', approvals: 0, triggers, wouldAutoMerge: okTickets, reasons: ['PR severity Low, every ticket high confidence, no human reopens, checks green'] };
  }
  const approvals = approvalsFor(settings.approvals, { cls: a.class, severity: a.severity?.level ?? 'Severe' });
  const would = okTickets.length && okTickets.length < a.tickets.length ? [`${list(okTickets)} would have auto-merged`] : [];
  return { action: 'review', approvals, triggers, wouldAutoMerge: okTickets, reasons: [...triggers, ...would] };
}

// ---------------------------------------------------------------------------------------------
// The review notice (one PR comment, edited in place, carrying the gate's state)
// ---------------------------------------------------------------------------------------------

const cell = (s) => String(s ?? '-').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-';

export function gateState(a, d, prior = null, extra = {}) {
  return {
    v: 1,
    action: d.action,
    approvals: d.approvals,
    required: (Boolean(prior?.required) && reviewTriggers(prior).length > 0) || d.action === 'review',
    triggers: d.triggers,
    headSha: a.headSha,
    // The publication that wrote this state (publishGate reads it back to confirm it is shown).
    ...(a.publication ? { publication: a.publication } : {}),
    class: a.class,
    severity: a.severity?.level ?? null,
    systems: { names: a.systems?.names ?? [], shared: Boolean(a.systems?.shared), contract: Boolean(a.systems?.contract) },
    // Each ticket's confidence signals, so a later evaluation (board sync, another machine) still explains them
    // (council C2: a rebuilt notice said "met (no record)" for signals the gate had).
    tickets: a.tickets.map((t) => ({ key: t.key, issue: t.issue?.number ?? null, severity: t.severity?.level ?? null, high: Boolean(t.confidence?.high), reopens: t.reopens?.length ?? 0, signals: t.signals ?? prior?.tickets?.find((x) => x.key === t.key)?.signals ?? null })),
    ci: a.ci ?? null,
    reasons: d.reasons ?? [],
    countedReviews: prior?.countedReviews ?? [],
    assessedAt: a.assessedAt,
    // When the CI state was read (council C9: a notice showed the first assessment's time next to a CI result read
    // later, when three workflows that had been running then had finished).
    ciReadAt: a.ciReadAt ?? a.assessedAt ?? null,
    delivery: deliveryOf(a, prior),
    deliveryChecked: a.deliveryChecked ?? (a.headSha && prior?.deliveryChecked === a.headSha ? a.headSha : null),
    ...extra,
  };
}

export function renderNotice(a, d, state) {
  const head = {
    review: `## Review gate: ${d.approvals} approval${d.approvals === 1 ? '' : 's'} required`,
    wait: state?.pendingMerge ? '## Review gate: waiting for GitHub to clear the merge' : '## Review gate: waiting for the checks',
    'auto-merge': '## Review gate: auto-merge',
    'merge-failed': '## Review gate: merge failed',
  }[d.action];
  const lines = [head, ''];
  // An owner decision is stated first (council C6): the PR cannot be merged on its checks alone.
  const owner = a.tickets.filter((t) => t.confidence?.questions?.length);
  if (owner.length) lines.push(`> **Needs an owner decision.** ${owner.map((t) => `${t.key}: ${t.confidence.questions.join('; ')}`).join(' ')} The ticket contradicts the application on these lines; the ticket's owner decides (options on the ticket). This PR is never auto-merged until then.`, '');
  const delivery = state?.delivery;
  if (delivery?.state) {
    const issues = (delivery.issues ?? []).length ? delivery.issues : a.tickets.map((t) => t.issue?.number).filter(Boolean);
    lines.push(`> **Needs a person's decision: not delivered.** ${delivery.reason}.${delivery.flaky?.length ? ` Tests that passed only on a retry: ${delivery.flaky.map((t) => `\`${t}\``).join('; ')}.` : ''} The options are on the ticket${issues.length ? ` (${issues.map((n) => `#${n}`).join(', ')})` : ''} and in this PR's comments. This PR is never auto-merged until a person decides.`, '');
    for (const n of delivery.fixerNotes ?? []) lines.push(`> - ${n.id}${n.title ? ` ${n.title}` : ''}: ${String(n.reason ?? '').replace(/\s+/g, ' ').slice(0, 600)}`);
    if ((delivery.fixerNotes ?? []).length) lines.push('');
  }
  if (d.action === 'review') lines.push(`**What triggered review:** ${d.triggers.join('; ')}.${d.wouldAutoMerge.length && d.wouldAutoMerge.length < a.tickets.length ? ` ${list(d.wouldAutoMerge)} would have auto-merged.` : ''}`, '');
  if (d.action === 'wait' && state?.pendingMerge) lines.push(`Every ticket qualifies for auto-merge and every check and expected workflow of this head is green, but GitHub has not cleared the merge yet (\`${state.pendingMerge.status}\`). GitHub's own auto-merge is not armed (it would merge a later head without its CI): \`board sync\` checks this head again and merges it as soon as GitHub does. No approval is required.`, '');
  else if (d.action === 'wait') lines.push(`Every ticket qualifies for auto-merge; the gate merges the PR once its checks pass (\`board sync\` checks again). ${d.reasons.join('; ')}.`, '');
  if (d.action === 'merge-failed') lines.push(`Every ticket qualifies for auto-merge, but GitHub refused the merge: **${state?.mergeError?.cause ?? 'unknown cause'}**. No approval is required for this; \`board sync\` tries the merge again each time it runs, and a person may merge it once the cause is fixed.`, '');
  // Says what happened: GitHub merges an auto-merge PR only once its required checks pass (council C2: the notice
  // said "Merged" nine minutes before the merge).
  if (d.action === 'auto-merge') {
    const m = state?.merge ?? {};
    lines.push(m.merged
      ? `${d.reasons.join('; ')}. Merged${m.mergedAt ? ` at ${m.mergedAt}` : ''} (\`gh pr merge\`${m.method ? `, ${m.method}` : ''}); the cards reach Done through \`board sync\`.`
      : `${d.reasons.join('; ')}. Auto-merge is enabled (\`gh pr merge --auto\`): GitHub merges the PR once its required checks pass, and \`board sync\` then moves the cards to Done.`, '');
  }
  lines.push('| Ticket | Impact | Complexity | Fix risk | Severity | Confidence | Systems |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of a.tickets) lines.push(`| ${t.key} | ${cell(t.impact)} | ${cell(t.complexity)} | ${cell(t.fixRisk)} | **${cell(t.severity?.level ?? 'not assessed')}** | ${t.confidence?.score ?? '-'}${t.confidence?.high ? ' (high)' : ''} | ${cell(t.systems?.join(', ') || 'none')} |`);
  lines.push('');
  for (const t of a.tickets) {
    lines.push(`<details><summary>${t.key}: how it was rated</summary>`, '');
    lines.push(`- **Severity:** ${t.severity?.explanation ?? 'not assessed'}`);
    for (const [f, label] of [['impact', 'Impact'], ['complexity', 'Complexity'], ['fixRisk', 'Fix risk']]) if (t[`${f}Reason`]) lines.push(`- **${label} ${t[f]}:** ${t[`${f}Reason`].replace(/\s+/g, ' ')}`);
    lines.push(`- **Confidence ${t.confidence?.score ?? '-'}:** ${describeSignals(t.signals ?? {}, t.confidence?.criteria ?? {}).join('; ')}; the agent's own estimate ${t.agentConfidence ?? 'none'}`);
    if (t.reopens?.length) lines.push(`- **Human reopens:** ${t.reopens.length} (rejected by a person earlier: never merges itself)`);
    lines.push('', '</details>', '');
  }
  lines.push(`**PR severity:** ${a.severity?.level ?? 'unknown'} (${a.severity?.explanation ?? '-'}) · class \`${a.class}\` · systems: ${a.systems?.names?.join(', ') || 'none'} · checks: ${a.ci ?? 'none yet'}${a.headSha ? ` on head ${String(a.headSha).slice(0, 7)}` : ''}${a.ciReadAt ? ` (read ${String(a.ciReadAt).replace('T', ' ').slice(0, 16)} UTC)` : ''}`, '');
  if (d.action === 'review') lines.push(`The \`review-quorum\` check counts approvals from distinct people other than the author, given on the latest push. Anyone can add more reviewers; the gate only sets how many approvals are required. A "changes requested" review counts as a human reopen of the tickets it names (or all of them), which raises their severity.`, '');
  lines.push(encodeState(state));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Applying the decision to the PR
// ---------------------------------------------------------------------------------------------

export const approvalsLabel = (settings, n) => (settings.labels?.approvals ?? defaultSettings().implement.reviewGate.labels.approvals).replace('{n}', String(n));

// Reviewers: each ticket's assignees, or the CODEOWNERS of the files it touches when it has none.
// Never the PR's author (GitHub refuses that).
export function reviewersFor(a, { assignees, codeowners, author }) {
  const out = [];
  for (const t of a.tickets) {
    const mine = assignees[t.key] ?? [];
    out.push(...(mine.length ? mine : ownersOfFiles(t.paths ?? [], codeowners)));
  }
  return [...new Set(out)].filter((l) => l && l.toLowerCase() !== String(author ?? '').toLowerCase());
}

// The gate state on the PR (its notice's marker), or null.
export function readPrState(gh, repo, pr) {
  return parseState(findComment(gh, repo, pr, MARKER)?.body);
}

// Labels, reviewers and the notice for a PR that needs people, or just the notice otherwise. Returns
// { reviewers, problems }.
export function applyReview(config, gh, a, d, state, { assignees, codeowners, author, currentLabels = [] }) {
  const s = config.implement.reviewGate;
  const repo = config.board.repo;
  const problems = [];
  let reviewers = [];
  const attempt = (what, fn) => {
    try {
      return fn();
    } catch (error) {
      problems.push(`${what}: ${error.message.split('\n')[0]}`);
      return null;
    }
  };
  // Every gated PR carries `approvals:N` (approvals:0 while it waits for its checks or auto-merges), so
  // `board sync` finds it again and the review-quorum check knows the count.
  const want = approvalsLabel(s, d.action === 'review' ? d.approvals : 0);
  const prefix = approvalsLabel(s, '');
  const stale = currentLabels.filter((l) => l.startsWith(prefix) && l !== want);
  if (d.action === 'review') {
    attempt('labels', () => editPrLabels(prHost(config, gh), repo, a.pr, { add: [want, setting(config, 'implement.reviewGate.labels.needsHuman')], remove: stale }));
    reviewers = attempt('reviewers', () => requestReviewers(prHost(config, gh), repo, a.pr, reviewersFor(a, { assignees, codeowners, author }))) ?? [];
  } else if (!currentLabels.includes(want) || stale.length) attempt('labels', () => editPrLabels(prHost(config, gh), repo, a.pr, { add: currentLabels.includes(want) ? [] : [want], remove: stale }));
  attempt('notice', () => upsertComment(prHost(config, gh), repo, a.pr, MARKER, renderNotice(a, d, { ...state, reviewers })));
  return { reviewers, problems };
}

// The part of the PR description that says why a person must review it because of a person's earlier rejection, or a
// history that could not be read, rebuilt from the live read the gate just decided on (null: none applies).
export const WHY_MARKER = '<!-- review-gate:why -->';
const WHY_END = '<!-- /review-gate:why -->';
export function rejectionSection(a, approvals = 1) {
  const lines = a.tickets.flatMap((t) => {
    if (t.reopens?.length) return [`- ${t.key}: rejected by a person earlier (${[...new Set(t.reopens.map((r) => r.detail ?? r.source))].slice(0, 3).join('; ')})`];
    if (t.reopensUnknown) return [`- ${t.key}: whether a person rejected it earlier could not be checked (${t.reopensUnknown})`];
    return t.rejectionChecked === true ? [] : [`- ${t.key}: not checked for a rejection by a person earlier`];
  });
  return lines.length ? `${WHY_MARKER}\n**A person reviews this PR**, whatever its rating:\n${lines.join('\n')}\n\n${settles(approvals).replace(/^a/, 'A')}.\n${WHY_END}` : null;
}
export function withRejectionSection(body, section) {
  const text = String(body ?? '').replace(/\n*<!-- review-gate:why -->[\s\S]*?<!-- \/review-gate:why -->\n?/, '');
  return section ? `${text.replace(/\s+$/, '')}\n\n${section}\n` : text;
}
