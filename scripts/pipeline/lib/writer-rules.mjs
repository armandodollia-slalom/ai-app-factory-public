// The retro's ledger of the writers' clean-code rules (GEN-27): which `CC-<n>` rules the writing agents carry, decided by
// arithmetic over the traces of a window, never by an agent's judgement. The set lives in the writer rule set file
// (clean-code.mjs writerRulesPath, `<lessonsDir>/clean-code-writers.json`), a pipeline-owned file committed with the
// lessons; the next writer task carries exactly its rules. The fixed `SCOPE` rule is never weighed and never removed,
// and business rules (`RULE-<n>`, `rules/`) are never read or touched here.
//
// Per rule, over the window (the records after the previous ledger run's last one):
// - breach cost: the upheld clean-code findings citing it on writers' work, times the mean cost (and seconds) of a writer
//   fix run (a writer run after the first round; with none measured, a writer run);
// - carry cost: the tokens its text adds to a writer task (4 characters a token), times the writer runs, at the writers'
//   measured price per prompt token;
// - accuracy: the first-round pass rate on the rule (round-1 sittings with no upheld finding citing it) while carried and
//   while not, by the writer set each round recorded.
// Decisions, each needing `retro.writerRules.minSamples` round-1 sittings on writers' work in the window:
// - add a rule outside the set whose breach cost exceeds its carry cost;
// - remove, on probation, a carried rule with no upheld breach; one on probation whose breach cost returns above its
//   carry cost is put back and cannot be removed for two windows;
// - density: when the last change added rules and the first-round pass rate on all rules fell since, remove the carried
//   rule with the lowest net value first;
// - at most `retro.writerRules.maxChangesPerRetro` changes, the largest value first; the rest are deferred.
import fs from 'node:fs';
import { agentsWithCleanCode } from './agents.mjs';
import { CLEAN_CODE_LENS, SCOPE_RULE, ruleText, skillRules, writerRuleIds, writerRulesPath } from './clean-code.mjs';
import { COUNCIL_FILE, WRITER_STAGES } from './council.mjs';
import { FINDINGS_FILE } from './findings.mjs';
import { USAGE_FILE } from './usage.mjs';
import { writeTextIfChanged } from './redact.mjs';
import { setting } from './settings.mjs';
import { UPHELD_OUTCOMES } from './scorecard.mjs';
import { readMetrics } from './state.mjs';
import { sha } from './util.mjs';

export const WRITER_RULES_LOG = 'writer-rules.jsonl';
const CHARS_PER_TOKEN = 4;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const ratio = (a, b) => (b ? round6(a / b) : null);

// The records the ledger reads from this checkout's metrics (and what the retro pulled from the store).
export function writerRuleRecords(config) {
  return { rounds: readMetrics(config, COUNCIL_FILE).filter((r) => r.kind !== 'adjudication'), findings: readMetrics(config, FINDINGS_FILE), usage: readMetrics(config, USAGE_FILE) };
}

// The ledger's own state in the set file: the window count, the last record it read, probation and locks.
export function readLedger(config, root = config.root) {
  const file = writerRulesPath(config, root);
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { rules: writerRuleIds(config, { root }), window: doc.window ?? 0, windowEnd: doc.windowEnd ?? null, probation: doc.probation ?? {}, locked: doc.locked ?? {}, lastChange: doc.lastChange ?? null };
}
const ledgerState = (ledger) => ({ window: ledger.window, windowEnd: ledger.windowEnd, probation: ledger.probation, locked: ledger.locked, lastChange: ledger.lastChange });

const sitting = (r) => `${r.story}|${r.stage}|${r.step ?? ''}|${r.check ?? ''}`;
const inWindow = (since) => (r) => !since || String(r.ts ?? '') > since;

// Upheld clean-code findings on writers' work, each counted once, in the window its upheld outcome lands in (a finding
// raised before the window's start and upheld after it counts in this window): [{ rule, key, story, step, round,
// sitting }], and which first-round sittings each rule failed.
function upheldBreaches(findings, since) {
  // A finding's clean-code raiser row, by finding: another raiser's row of the same finding (a corroborating member, a
  // shadow) is not the breach, whichever row came first (council r4, sol-13).
  const raised = new Map(findings.filter((f) => f.kind === 'finding' && f.lens === CLEAN_CODE_LENS && f.rule).map((f) => [`${sitting(f)}|${f.round}|${f.finding}`, f]));
  const breaches = [];
  const failedFirst = new Map();
  for (const o of findings.filter(inWindow(since)).filter((r) => r.kind === 'outcome' && UPHELD_OUTCOMES.has(r.outcome))) {
    const key = `${sitting(o)}|${o.round}|${o.finding}`;
    const f = raised.get(key);
    if (f?.lens !== CLEAN_CODE_LENS || !f.rule || !WRITER_STAGES.includes(f.stage) || breaches.some((b) => b.key === key)) continue;
    breaches.push({ rule: f.rule, key, story: f.story, stage: f.stage, step: f.step ?? null, check: f.check ?? null, round: f.round, sitting: sitting(f) });
    if (f.round === 1) (failedFirst.get(f.rule) ?? failedFirst.set(f.rule, new Set()).get(f.rule)).add(sitting(f));
  }
  return { breaches, failedFirst };
}

// Where each council stage's fix is in the usage trace, whoever ran it (the writer it was handed to, or the stage's
// orchestrator doing it itself), one entry per way the stage fixes (council r5, sol-11): the usage stages it is recorded
// under, its step (`same`: the finding's own subtask; null: none; else the step it has), its round after the ruling's
// (0: the same round, 1: the next) and whether it is the ruling's own check. A writer stage missing here would charge
// its breaches nothing of their own (the table test in writer-rules.test.mjs covers every one).
export const FIX_RUNS = {
  pairVerify: [{ stages: ['implement-pair', 'implement'], step: 'same', after: 1 }],
  pairUiVerify: [{ stages: ['implement-pair', 'implement'], step: 'same', after: 1 }],
  // Handed back to the implement stage (its implementer's next run, no step), or fixed by the review's orchestrator.
  architectureReview: [{ stages: ['implement'], step: null, after: 1 }, { stages: ['review'], step: 'orchestrator-fix', after: 0 }],
  // The automation round after the verifier's: the test automation agent's, or the orchestrator's own.
  testAutomation: [{ stages: ['automation'], step: 'any', after: 1 }],
  // The fixer (fixer, fixer-checks) or the orchestrator, in the check and round of the ruling.
  prCheck: [{ stages: ['pr-check'], step: /^fixer\b/, after: 0, check: true }],
};
const FIX_ROLES = Object.values(FIX_RUNS).flat();
const stepIs = (want, step, findingStep) => {
  if (want === 'any') return true;
  if (want === 'same') return findingStep === undefined || step === findingStep;
  if (want === null) return !step;
  return want instanceof RegExp ? want.test(step ?? '') : step === want;
};
// A usage row that can be a fix of some stage (its role, whoever ran it).
const fixRow = (u) => FIX_ROLES.some((f) => f.stages.includes(u.stage) && stepIs(f.step, u.step ?? null));
// A fix in the same round as its ruling (no later round marks it as one).
const sameRoundFix = (u) => FIX_ROLES.some((f) => f.after === 0 && f.stages.includes(u.stage) && stepIs(f.step, u.step ?? null));

// A run from its first usage row, before its rows' cost and prompt tokens are summed. `writer`: a writing agent's run
// (it carries the writer rule set); `fix`: a fix run (the mean fix run's basis).
const newRun = (u, writers) => ({ story: u.story, stage: u.stage ?? null, agent: u.agent, step: u.step ?? null, check: u.check ?? null, round: u.round ?? 1, cost: 0, seconds: u.seconds ?? 0, prompt: 0, writer: writers.includes(u.agent), fix: sameRoundFix(u) || (fixRow(u) && (u.round ?? 1) > 1) || (writers.includes(u.agent) && (u.round ?? 1) > 1) });

// The runs in the window (usage rows joined by run): the writers' (the agents whose definitions say `clean-code:
// writer`) and every fix run (FIX_RUNS), each with its ticket, stage, step, check and round, cost and seconds. `list`
// holds the writers' runs (they carry the rule set: the carry cost and the price per prompt token), `fixes` every run
// that can have fixed a breach.
function writerRuns(usage, since, writers) {
  const runs = new Map();
  for (const u of usage.filter(inWindow(since)).filter((x) => writers.includes(x.agent) || fixRow(x))) {
    const run = runs.get(u.run_id) ?? newRun(u, writers);
    const t = u.tokens ?? {};
    run.cost += u.cost_usd ?? 0;
    run.prompt += (t.input ?? 0) + (t.cache_read ?? 0) + (t.cache_write_5m ?? 0) + (t.cache_write_1h ?? 0);
    runs.set(u.run_id, run);
  }
  const fixes = [...runs.values()];
  const list = fixes.filter((r) => r.writer);
  const promptTokens = list.reduce((n, r) => n + r.prompt, 0);
  return { list, fixes, pricePerToken: promptTokens ? list.reduce((n, r) => n + r.cost, 0) / promptTokens : 0 };
}

// The mean cost and seconds of a fix run (a writer run after the first round; with none, any run): a breach's cost when
// no run of its own can be found.
function meanFix(list) {
  const fixes = list.filter((r) => r.fix);
  const basis = fixes.length ? fixes : list;
  const mean = (k) => (basis.length ? basis.reduce((n, r) => n + r[k], 0) / basis.length : 0);
  return { cost: mean('cost'), seconds: mean('seconds') };
}

// The runs that fixed a breach: its ticket's runs in one of its own stage's fix roles (FIX_RUNS), in the round after
// the ruling the role says and, for the PR check, in the ruling's check (council r3 to r5, sol-11).
const fixedBy = (b) => (r) => r.story === b.story && (FIX_RUNS[b.stage] ?? []).some((f) => f.stages.includes(r.stage) && stepIs(f.step, r.step, b.step ?? null) && r.round === b.round + f.after && (!f.check || r.check === b.check));

// What a breach cost: the writer runs that fixed it (fixedBy), shared among the upheld findings of its round they fixed;
// with no such run, the mean fix run.
function breachCosts(breaches, findings, runs) {
  const upheldIn = (b) => findings.filter((o) => o.kind === 'outcome' && UPHELD_OUTCOMES.has(o.outcome) && `${sitting(o)}|${o.round}` === `${b.sitting}|${b.round}`).length;
  const fallback = meanFix(runs.fixes);
  return breaches.map((b) => {
    const fixers = runs.fixes.filter(fixedBy(b));
    const share = Math.max(1, upheldIn(b));
    return fixers.length ? { ...b, cost: fixers.reduce((n, r) => n + r.cost, 0) / share, seconds: fixers.reduce((n, r) => n + r.seconds, 0) / share } : { ...b, ...fallback };
  });
}

// One rule's row of the ledger, from its breaches' own costs.
function ruleRow(rule, { ledger, firsts, breaches, failed, runs }) {
  const tokens = Math.ceil(ruleText(rule).length / CHARS_PER_TOKEN);
  const passRate = (list) => ratio(list.filter((x) => !failed?.has(sitting(x))).length, list.length);
  const breachCost = round6(breaches.reduce((n, b) => n + b.cost, 0));
  const carryCost = round6(tokens * runs.list.length * runs.pricePerToken);
  return {
    rule: rule.id,
    carried: ledger.rules.includes(rule.id),
    breaches: breaches.length,
    breachCost,
    breachSeconds: round6(breaches.reduce((n, b) => n + b.seconds, 0)),
    tokens,
    writerRuns: runs.list.length,
    carryCost,
    net: round6(breachCost - carryCost),
    passRateCarried: passRate(firsts.filter((x) => x.writerRules.includes(rule.id))),
    passRateNotCarried: passRate(firsts.filter((x) => !x.writerRules.includes(rule.id))),
  };
}

// A first-round sitting the ledger can learn from: on a writer stage, with the rule set the writer carried recorded
// (writerRules) and the clean-code seat's judgment: the seat sat and finished (status ok). A seat that failed, was
// unavailable or late judged nothing (council r3, sol-11). Older records without either are not samples.
const observedFirst = (r) => WRITER_STAGES.includes(r.stage) && r.round === 1 && Array.isArray(r.writerRules) && (r.members ?? []).some((m) => m.fixed && m.status === 'ok');

// The numbers of every rule (SCOPE aside) over the window, and the window's facts.
export function ledgerNumbers(config, records, ledger = { rules: [], windowEnd: null }) {
  const since = ledger.windowEnd;
  const findings = records.findings ?? [];
  const firsts = (records.rounds ?? []).filter(inWindow(since)).filter(observedFirst);
  const samples = new Set(firsts.map(sitting)).size;
  const { breaches, failedFirst } = upheldBreaches(findings, since);
  const runs = writerRuns(records.usage ?? [], since, agentsWithCleanCode(config, 'writer'));
  const costed = breachCosts(breaches, findings, runs);
  const rules = skillRules().filter((r) => r.id !== SCOPE_RULE).map((r) => ruleRow(r, { ledger, firsts, breaches: costed.filter((b) => b.rule === r.id), failed: failedFirst.get(r.id), runs }));
  // The writers' first-round pass rate on all rules: round-1 sittings with no upheld clean-code finding.
  const failedAny = new Set([...failedFirst.values()].flatMap((x) => [...x]));
  const passRate = ratio([...new Set(firsts.map(sitting))].filter((k) => !failedAny.has(k)).length, samples);
  const windowEnd = [...(records.rounds ?? []), ...findings, ...(records.usage ?? [])].map((r) => String(r.ts ?? '')).filter((ts) => !since || ts > since).sort().at(-1) ?? since;
  const fix = meanFix(runs.list);
  return { samples, passRate, fixCost: round6(fix.cost), fixSeconds: round6(fix.seconds), pricePerToken: runs.pricePerToken, rules, windowEnd };
}

const costsMore = (n) => n.breaches > 0 && n.breachCost > n.carryCost;

// Rules on probation: put back when their breaches cost more than carrying them, else their probation ends.
function restoreCandidates(ledger, byRule, window) {
  const candidates = [];
  const ended = [];
  for (const [rule, since] of Object.entries(ledger.probation)) {
    const n = byRule.get(rule);
    if (n && costsMore(n)) candidates.push({ action: 'restore', rule, value: n.net, reason: `on probation since window ${since}; its breaches cost ${n.breachCost} USD over a carry cost of ${n.carryCost} USD`, lockedUntil: window + 2, numbers: n });
    else ended.push(rule);
  }
  return { candidates, ended };
}

// Rules outside the set (and not on probation) whose breaches cost more than carrying them.
const addCandidates = (ledger, rows) =>
  rows.filter((n) => !n.carried && !Object.hasOwn(ledger.probation, n.rule) && costsMore(n)).map((n) => ({ action: 'add', rule: n.rule, value: n.net, reason: `its upheld breaches cost ${n.breachCost} USD (${n.breaches} x a fix run) over a carry cost of ${n.carryCost} USD`, numbers: n }));

// Carried rules with no upheld breach: removed on probation.
const removeCandidates = (removable) =>
  removable.filter((n) => n.breaches === 0).map((n) => ({ action: 'remove', rule: n.rule, value: n.carryCost, probation: true, reason: `no upheld breach in the window; it costs ${n.carryCost} USD to carry`, numbers: n }));

// Density: the last change added rules and the writers pass fewer first rounds since: the carried rule with the lowest
// net value goes first, before any other change (it replaces a plain removal of the same rule).
function densityCandidate(ledger, numbers, removable) {
  const last = ledger.lastChange;
  if (last?.action !== 'add' || !Number.isFinite(last.passRate) || numbers.passRate === null || numbers.passRate >= last.passRate) return [];
  const lowest = [...removable].sort((a, b) => a.net - b.net || a.rule.localeCompare(b.rule))[0];
  return lowest ? [{ action: 'remove', rule: lowest.rule, value: Infinity, probation: true, density: true, reason: `the first-round pass rate fell from ${last.passRate} to ${numbers.passRate} after rules were added; it has the lowest net value (${lowest.net} USD)`, numbers: lowest }] : [];
}

// The decisions of one retro over the window: { window, samples, insufficient, changes, deferred, set, numbers }. Pure:
// the same records and ledger give the same decisions.
export function planWriterRules(config, records, ledger) {
  const minSamples = setting(config, 'retro.writerRules.minSamples');
  const maxChanges = setting(config, 'retro.writerRules.maxChangesPerRetro');
  const window = ledger.window + 1;
  const numbers = ledgerNumbers(config, records, ledger);
  const base = { window, samples: numbers.samples, minSamples, numbers, changes: [], deferred: [], probationEnded: [] };
  if (numbers.samples < minSamples) return { ...base, insufficient: true, set: ledger.rules };
  const restore = restoreCandidates(ledger, new Map(numbers.rules.map((r) => [r.rule, r])), window);
  // A rule restored with lockedUntil n is protected through window n.
  const removable = numbers.rules.filter((n) => n.carried && !((ledger.locked[n.rule] ?? 0) >= window));
  const density = densityCandidate(ledger, numbers, removable);
  const removes = removeCandidates(removable).filter((c) => !density.some((d) => d.rule === c.rule));
  const candidates = [...density, ...restore.candidates, ...addCandidates(ledger, numbers.rules), ...removes];
  const sorted = candidates.sort((a, b) => b.value - a.value || a.rule.localeCompare(b.rule) || a.action.localeCompare(b.action));
  const changes = sorted.slice(0, maxChanges);
  const set = [...ledger.rules.filter((r) => !changes.some((c) => c.rule === r && c.action === 'remove')), ...changes.filter((c) => c.action !== 'remove').map((c) => c.rule)];
  return { ...base, insufficient: false, changes, deferred: sorted.slice(maxChanges), probationEnded: restore.ended, set: [SCOPE_RULE, ...skillRules().map((r) => r.id).filter((id) => id !== SCOPE_RULE && set.includes(id))] };
}

// The set file after a plan: the rules, the window, the last record read, probation and locks, and the last change with
// the pass rate it was made at (the density check reads it next time). No timestamp: the same plan gives the same file.
// With insufficient evidence nothing moves, the window either: its records count again next time, so evidence builds up.
const COMMENT = 'The clean-code rules writing agents carry (rule ids of the clean-code skill). Written by the retro from the traces; not edited by hand.';
const versioned = (doc) => ({ ...doc, version: sha(JSON.stringify(doc)) });
export function ledgerDoc(ledger, plan) {
  if (plan.insufficient) return versioned({ $comment: COMMENT, rules: ledger.rules, ...ledgerState(ledger) });
  const probation = Object.fromEntries(Object.entries(ledger.probation).filter(([rule]) => !plan.probationEnded.includes(rule) && !plan.changes.some((c) => c.rule === rule && c.action === 'restore')));
  for (const c of plan.changes) if (c.action === 'remove') probation[c.rule] = plan.window;
  const locked = Object.fromEntries(Object.entries(ledger.locked).filter(([, until]) => until > plan.window));
  for (const c of plan.changes) if (c.action === 'restore') locked[c.rule] = c.lockedUntil;
  const last = plan.changes.length ? { window: plan.window, action: plan.changes.some((c) => c.action !== 'remove') ? 'add' : 'remove', rules: plan.changes.map((c) => c.rule), passRate: plan.numbers.passRate } : ledger.lastChange;
  return versioned({ $comment: COMMENT, rules: plan.set, window: plan.window, windowEnd: plan.numbers.windowEnd, probation, locked, lastChange: last });
}

// One retro's ledger: plans from the records and writes the set file under `root`. Returns { plan, doc, changed }.
export function writeWriterRules(config, root = config.root, records = writerRuleRecords(config)) {
  const ledger = readLedger(config, root);
  const plan = planWriterRules(config, records, ledger);
  const doc = ledgerDoc(ledger, plan);
  const file = writerRulesPath(config, root);
  // Without the evidence to decide, a repository that has no set file yet gets none: nothing was decided.
  if (plan.insufficient && !fs.existsSync(file)) return { plan, doc, changed: false };
  return { plan, doc, changed: writeTextIfChanged(file, `${JSON.stringify(doc, null, 2)}\n`) };
}

// The log rows of a plan (writer-rules.jsonl): every change with the numbers behind it, the deferred ones and the window.
export const ledgerRows = (plan) => [
  ...plan.changes.map((c) => ({ event: 'writer-rules.change', window: plan.window, action: c.action, rule: c.rule, reason: c.reason, ...(c.probation ? { probation: true } : {}), ...(c.density ? { density: true } : {}), ...(c.lockedUntil ? { lockedUntil: c.lockedUntil } : {}), numbers: c.numbers, samples: plan.samples })),
  ...plan.deferred.map((c) => ({ event: 'writer-rules.deferred', window: plan.window, action: c.action, rule: c.rule, reason: c.reason, numbers: c.numbers, samples: plan.samples })),
  ...(plan.insufficient ? [{ event: 'writer-rules.insufficient', window: plan.window, samples: plan.samples, minSamples: plan.minSamples }] : []),
];

// The retro report's section on the writer rules.
export function ledgerSection(plan) {
  const lines = ['### Writer clean-code rules', ''];
  if (plan.insufficient) return [...lines, `No change: the evidence is insufficient (${plan.samples} first-round sittings on writers' work in window ${plan.window}, fewer than ${plan.minSamples}).`].join('\n');
  if (!plan.changes.length) lines.push(`No change in window ${plan.window} (${plan.samples} first-round sittings).`);
  for (const c of plan.changes) lines.push(`- ${c.action} ${c.rule}${c.probation ? ' (on probation)' : ''}: ${c.reason}.`);
  if (plan.deferred.length) lines.push('', 'Deferred (more qualifying changes than `retro.writerRules.maxChangesPerRetro`):', ...plan.deferred.map((c) => `- ${c.action} ${c.rule}: ${c.reason}.`));
  lines.push('', `The writers now carry: ${plan.set.join(', ')}.`);
  return lines.join('\n');
}
