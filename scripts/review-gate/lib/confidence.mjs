// Confidence (0-100) in a ticket's fix, computed by the harness from records the pipeline already
// keeps. The triage agent's own estimate is only one input (`confidence.agentWeight`, 20%).
//
// High confidence means all of:
//   fv       no feature verification bug-fix cycles (bugFixCycles = 0: feature verification's tests passed on the first try)
//   pairs    every verifier pair approved, in at most `maxPairRounds` (2) rounds
//   prCheck  the PR check reached 10/10 in at most `maxPrCheckRounds` (2) rounds
//   owns     no edits outside a subtask's `owns`
//   ci       the PR's checks are green
// and a score of at least `highMin`. Each criterion carries an equal share of the non-agent weight; an
// unknown criterion (no record) earns nothing and is not met; pending CI earns half and is not met.

export const CRITERIA = ['fv', 'pairs', 'prCheck', 'owns', 'ci'];
const DEFAULTS = { highMin: 85, maxPairRounds: 2, maxPrCheckRounds: 2, agentWeight: 0.2 };

const latest = (records, pred) => records.filter(pred).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1) ?? null;
const forTicket = (key) => (r) => r.story === key || (Array.isArray(r.stories) && r.stories.includes(key));

// The signals of one ticket from the metrics files: { implementRuns, subtaskRuns, prChecks, outcomes }
// (arrays of .factory/metrics records), and the PR's CI state ('success' | 'pending' | 'failure' | null).
export function ticketSignals(key, { implementRuns = [], subtaskRuns = [], prChecks = [], outcomes = [] } = {}, { ci = null, agent = null } = {}) {
  const story = latest(outcomes, (r) => r.type === 'story' && r.story === key);
  const run = latest(implementRuns, (r) => r.story === key);
  const bugFixCycles = story?.bugFixCycles ?? run?.bug_fix_cycles ?? null;
  const decisionId = story?.decisionId ?? run?.decision_id ?? null;
  const subtasks = subtaskRuns.filter((r) => r.story === key && (!decisionId || r.decisionId === decisionId));
  const pairRounds = subtasks.length ? Math.max(...subtasks.map((s) => (s.rounds ?? []).length || 1)) : null;
  const pairsApproved = subtasks.length ? subtasks.every((s) => s.approved) : null;
  const outsideOwns = subtasks.length
    ? subtasks.reduce((n, s) => n + (s.filesNeededOutsideOwns?.length ?? 0) + (s.rounds ?? []).reduce((m, x) => m + (Number(x.outOfOwnsEdits) || 0), 0), 0)
    : null;
  // Critique rounds only: a seeded fix round (a CI or report-round fix, council C7) is not a round of review (council C8:
  // #154's gate said "10/10 in round 3" for a report round and one fixing round).
  const checks = prChecks.filter(forTicket(key)).filter((c) => !c.seeded).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  // Rounds to the 10 the checks end on (council C7): a 10 that a later round undid (a fix round, a question) counts nothing.
  let trailing10 = 0;
  while (trailing10 < checks.length && checks[checks.length - 1 - trailing10].score === 10) trailing10++;
  const prCheckRounds = trailing10 ? checks.length - trailing10 + 1 : null;
  // Ticket lines the last PR check left as questions for the ticket's owner (council C6).
  const questions = (checks.at(-1)?.questions ?? []).map((q) => q.question || q.title).filter(Boolean);
  // A 10 counts only on the last check: a later round that left a question undoes it.
  const prCheckRoundsMet = questions.length ? null : prCheckRounds;
  return { bugFixCycles, pairRounds, pairsApproved, outsideOwns, prCheckRounds: prCheckRoundsMet, prCheckScore: checks.at(-1)?.score ?? null, questions, ci, agent: agent == null ? null : clamp(Number(agent)) };
}

const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null);

// Each criterion: 'met', 'unmet', 'unknown' or (CI only) 'pending'.
export function criteria(signals, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const known = (v, ok) => (v == null ? 'unknown' : ok ? 'met' : 'unmet');
  return {
    fv: known(signals.bugFixCycles, signals.bugFixCycles === 0),
    pairs: signals.pairRounds == null ? 'unknown' : signals.pairsApproved && signals.pairRounds <= s.maxPairRounds ? 'met' : 'unmet',
    prCheck: signals.prCheckRounds == null ? (signals.prCheckScore == null ? 'unknown' : 'unmet') : signals.prCheckRounds <= s.maxPrCheckRounds ? 'met' : 'unmet',
    owns: known(signals.outsideOwns, signals.outsideOwns === 0),
    ci: signals.ci === 'success' ? 'met' : signals.ci === 'pending' ? 'pending' : signals.ci == null ? 'unknown' : 'unmet',
  };
}

// { score, high, criteria, reasons } for one ticket's signals.
export function confidence(signals, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const c = criteria(signals, s);
  const share = ((1 - s.agentWeight) * 100) / CRITERIA.length;
  const earned = CRITERIA.reduce((n, k) => n + (c[k] === 'met' ? share : c[k] === 'pending' ? share / 2 : 0), 0);
  const agent = signals.agent == null ? 50 : signals.agent;
  const score = clamp(earned + s.agentWeight * agent);
  const allMet = CRITERIA.every((k) => c[k] === 'met');
  const reasons = CRITERIA.filter((k) => c[k] !== 'met').map((k) => `${LABELS[k]} ${c[k]}`);
  if (allMet && score < s.highMin) reasons.push(`score ${score} below ${s.highMin} (agent estimate ${agent})`);
  if (signals.questions?.length) reasons.unshift(`needs an owner decision: ${signals.questions.join('; ')}`);
  return { score, high: allMet && score >= s.highMin && !signals.questions?.length, criteria: c, reasons, questions: signals.questions ?? [] };
}

export const LABELS = { fv: 'Feature verification first try', pairs: `pair verifier rounds`, prCheck: 'PR check 10/10', owns: 'edits inside owns', ci: 'CI' };

// One line per criterion for the review notice: "Feature verification first try: met (0 bug-fix cycles)".
export function describeSignals(signals, c) {
  const detail = {
    fv: signals.bugFixCycles == null ? 'no record' : `${signals.bugFixCycles} bug-fix cycle(s)`,
    pairs: signals.pairRounds == null ? 'no pair record' : `${signals.pairsApproved ? 'approved' : 'not approved'}, ${signals.pairRounds} round(s)`,
    prCheck: signals.prCheckRounds != null ? `10/10 in round ${signals.prCheckRounds}` : signals.prCheckScore != null ? `last score ${signals.prCheckScore}/10` : 'no record',
    owns: signals.outsideOwns == null ? 'no pair record' : `${signals.outsideOwns} edit(s) outside owns`,
    ci: signals.ci ?? 'unknown',
  };
  return CRITERIA.map((k) => `${LABELS[k]}: ${c[k]} (${detail[k]})`);
}
