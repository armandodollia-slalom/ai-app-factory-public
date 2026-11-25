// What every council finding was, who raised it and what came of it (GEN-12), so the pipeline can learn which models
// are good in which roles: one stream, council-findings.jsonl, with three kinds of record.
//
// - `finding`: one per finding per round per member that raised it: ticket, stage, step, round, finding id, the member's
//   seat, pool entry, model, family and lens, severity, action, file and line, and whether another member raised the
//   same finding in that round (`shared`).
// - `outcome`: one per finding when it is known. PR check: what came of it (`upheld` or `dismissed`), the judge's own
//   ruling (`ruling`, null when the judge gave none) and who decided (`by`: `judge`, or `harness` when the finding stood
//   without a ruling or the harness reversed one); the judge's pool entry, model and family only when it ruled. The
//   other stages: `led-to-change` (the fix declaration names lines changed for it, council.mjs sealFixes) or
//   `no-change` (a note, outvoted, superseded, disputed and dropped, or no change declared).
// - `miss`: a problem found after a council passed, against the members that sat on it with the matching lens (or its
//   sole member, lens `all`): a PR check upheld finding by its own lens (against the stages before it), a CI failure by
//   a fixed mapping (a failing test is `test-value`, a build or static analysis failure `correctness`), and, flagged
//   `lowWeight`, a human "changes requested" review or a later bug ticket that names the ticket, against every member
//   that sat on it. Every problem but the PR check's own findings counts against the PR check's council too.
//
// Records hold no evidence text (it can quote code or secrets) and no absolute paths; they go through the metrics
// streams' rules (redaction, the sink) like every other stream.
import path from 'node:path';
import { COUNCIL_FILE } from './council.mjs';
import { SOLE_LENS } from './council-config.mjs';
import { memoryFile } from './council.mjs';
import { familyOf, poolEntry } from './pool.mjs';
import { metricsFile, readMetricsLocal } from './state.mjs';
import { setting } from './settings.mjs';
import { appendJsonl, nowIso, readJson } from './util.mjs';
import { CLEAN_CODE_LENS, ruleIdOf } from './clean-code.mjs';

export const FINDINGS_FILE = 'council-findings.jsonl';
// The councils a later problem can count against, by the lens it maps to.
const VERIFIER_STAGES = ['pairVerify', 'pairUiVerify', 'architectureReview', 'testPlan', 'testAutomation'];
// The PR check's own critics, as the council lens each judges.
export const CRITIC_LENS = { acceptance: 'acceptance', flow: 'correctness', design: 'ui', style: 'rewrite', video: 'acceptance', [CLEAN_CODE_LENS]: CLEAN_CODE_LENS };

const write = (config, rows) => {
  if (!rows.length) return;
  try {
    appendJsonl(metricsFile(config, FINDINGS_FILE), rows.map((r) => ({ ts: nowIso(), ...r })));
  } catch {
    // the records are informational: a write that fails never stops a stage
  }
};
const relative = (config, file) => (file && path.isAbsolute(String(file)) ? path.relative(config.root, String(file)).replace(/\\/g, '/') : file ?? null);

// A seat as its records name it.
export function seatFacts(config, member) {
  const e = member?.entry ? poolEntry(config, member.entry) : null;
  return { seat: member?.name ?? null, entry: member?.entry ?? null, model: e?.model ?? member?.model ?? null, family: e ? familyOf(e) : member?.family ?? null, lens: member?.lens ?? null };
}

// The clean-code rule a raiser's item cites, for the retro's writer-rule ledger (writer-rules.mjs): only a clean-code
// item's (the raiser's own evidence in a merged finding, `ev` with its member; else the finding when it is the
// clean-code seat's own).
const cleanCodeRule = (f, ev) => {
  const own = ev?.member ? ev : null;
  const item = own ?? f;
  return (item?.lens === CLEAN_CODE_LENS || (!own && f?.cleanCode)) && ruleIdOf(item) ? { rule: ruleIdOf(item) } : {};
};
// A raiser's own evidence in a merged finding.
const raiserItem = (f, member) => (f.memberEvidence ?? []).find((e) => e.member === member);

// The finding records of one council round, and the outcomes it settles: its own notes now, and the previous round's
// upheld findings by their sealed fix declarations (the round's memory ledger).
// A non-blocking member's findings, recorded by its own run when it finishes (council r5, sol-26: a detached shadow
// that finished after the last round was never recorded): finding rows marked feedback, with no outcome.
export function recordFeedback(config, { stage, story, step = null, round, member, findings = [] }) {
  write(config, (findings ?? []).filter((f) => f && typeof f === 'object').map((f, k) => ({ kind: 'finding', story, stage, ...(step ? { step } : {}), round, finding: String(f.id ?? `${stage}-r${round}-${member.name}-${k + 1}`), ...seatFacts(config, member), severity: f.severity ?? null, action: f.action ?? null, file: relative(config, f.file ?? null), line: f.line ?? null, shared: false, feedback: true })));
}

// `selfRecorded`: the non-blocking members whose own runs record their findings (recordFeedback); feedback only they
// raised is not recorded again here.
export function recordRoundFindings(config, { stage, story, step = null, round, council, merged, selfRecorded = [] }) {
  if (!merged || merged.error) return;
  const members = new Map((council?.members ?? []).map((m) => [m.name, m]));
  const rows = [];
  // Feedback from a non-blocking member (the shadow seat) is recorded as its finding, marked, with no outcome: it was never
  // judged (council r4, sol-26: it vanished from the records, and with it the shadow seat's signal).
  const self = new Set(selfRecorded);
  const all = [...(merged.findings ?? []).map((f) => ({ f, standing: true })), ...(merged.notes ?? []).filter((f) => !(f.feedback && (f.members?.length ? f.members : [f.member]).every((n) => self.has(n)))).map((f) => ({ f, standing: false }))];
  all.forEach(({ f }, i) => {
    const raisers = f.members?.length ? f.members : [f.member].filter(Boolean);
    const id = f.id ?? `${stage}-r${round}-${i + 1}`;
    for (const name of raisers) {
      const ev = (f.memberEvidence ?? []).find((e) => e.member === name) ?? {};
      rows.push({ kind: 'finding', story, stage, ...(step ? { step } : {}), round, finding: id, ...seatFacts(config, members.get(name) ?? { name }), severity: ev.severity ?? f.severity ?? null, action: ev.action ?? f.action ?? null, file: relative(config, ev.file ?? f.file), line: ev.line ?? f.line ?? null, shared: raisers.length > 1, ...cleanCodeRule(f, ev), ...(f.feedback ? { feedback: true } : {}) });
    }
  });
  // A note never starts a fix cycle: no change comes of it. Feedback has no outcome at all.
  all.forEach(({ f, standing }, i) => {
    if (standing || f.feedback) return;
    const why = f.supersededBy ? 'superseded' : f.protected ? 'protected' : f.noEvidence ? 'no evidence' : f.notUpheld ? 'not upheld' : 'minor';
    rows.push({ kind: 'outcome', story, stage, ...(step ? { step } : {}), round, finding: f.id ?? `${stage}-r${round}-${i + 1}`, outcome: 'no-change', reason: why });
  });
  // The previous round's upheld findings: their fixes were sealed into the ledger when this round sat.
  const ledger = readJson(memoryFile(config.root, setting(config, 'stateDir'), { stage, story, step }), null);
  const before = (ledger?.rounds ?? []).find((r) => r.round === round - 1);
  const dropped = new Set((merged.disputes ?? []).filter((d) => d.decision === 'accepted').map((d) => String(d.finding)));
  for (const u of before?.upheld ?? []) {
    if (!u?.id) continue;
    const changed = (before.provenance ?? []).some((p) => p.id === u.id && (p.lines?.length ?? 0) > 0);
    rows.push({ kind: 'outcome', story, stage, ...(step ? { step } : {}), round: round - 1, finding: u.id, outcome: changed ? 'led-to-change' : 'no-change', reason: changed ? 'the fix declaration names lines changed for it' : dropped.has(String(u.id)) ? 'disputed and dropped' : 'no change declared for it' });
  }
  write(config, rows);
}

// The PR check's findings of one round and the judge's ruling on each (dismissed ones too). `seatOf(lens)` gives the
// critic's seat; `judge` the judge's pool entry; `rulings` the judge's own rulings, so a finding the judge never ruled
// on, or one the harness upheld against its ruling, is never credited to the judge.
// `outcomes: false` records the findings only (the shadow seat's, which nobody judges).
// `check` names the check run: its finding ids start again in the next check of the ticket.
export function recordPrCheckRound(config, { story, round, check = null, findings, upheld, seatOf, judge, rulings = [], outcomes = true, feedback = false }) {
  const up = new Set((upheld ?? []).map((f) => String(f.id)));
  const ruled = new Map((rulings ?? []).filter((r) => r?.id && ['upheld', 'dismissed'].includes(r.ruling)).map((r) => [String(r.id), r.ruling]));
  const rows = [];
  for (const f of findings ?? []) {
    const raisers = f.members?.length ? f.members : [f.lens];
    for (const r of raisers) rows.push({ kind: 'finding', story, stage: 'prCheck', ...(check ? { check } : {}), round, finding: String(f.id), ...seatOf(r, f), severity: f.severity ?? null, action: f.action ?? null, file: relative(config, f.file), line: f.line ?? null, shared: raisers.length > 1, ...cleanCodeRule(f, raiserItem(f, r)), ...(feedback ? { feedback: true } : {}) });
    if (!outcomes) continue;
    const outcome = up.has(String(f.id)) ? 'upheld' : 'dismissed';
    const ruling = ruled.get(String(f.id)) ?? null;
    rows.push({ kind: 'outcome', story, stage: 'prCheck', ...(check ? { check } : {}), round, finding: String(f.id), outcome, ruling, by: ruling === outcome ? 'judge' : 'harness', ...(ruling ? { judge } : {}) });
  }
  write(config, rows);
}

// The councils that passed for a ticket, each with the members of its passing round (council-rounds.jsonl). The PR check's
// own council is one of them for any problem found after it (CI, a person, a later bug), not for its own findings.
function passedCouncils(config, story, { prCheck = true } = {}) {
  const stages = prCheck ? [...VERIFIER_STAGES, 'prCheck'] : VERIFIER_STAGES;
  // A shared PR check's rounds name every ticket it covered (`stories`): its council sat on each (council r5, sol-32).
  const rows = readMetricsLocal(config, COUNCIL_FILE).filter((r) => (r.story === story || (r.stories ?? []).includes(story)) && r.kind !== 'adjudication' && stages.includes(r.stage));
  const byStage = new Map();
  for (const r of rows) if (r.pass) byStage.set(`${r.stage}|${r.step ?? ''}`, r);
  return [...byStage.values()];
}

// Misses against the councils that passed for `story`: members with `lens` (or a sole member), or every member when
// `lens` is null (a human review, a later bug: flagged lower weight).
// `check`: the PR check run that found it; an escaped defect is recorded once per check, however many rounds uphold it.
export function recordMisses(config, { story, lens = null, source, finding = null, lowWeight = false, head = null, check = null }) {
  if (check && finding && readMetricsLocal(config, FINDINGS_FILE).some((r) => r.kind === 'miss' && r.story === story && r.source === source && r.finding === finding && r.check === check)) return [];
  const rows = [];
  for (const c of passedCouncils(config, story, { prCheck: source !== 'prCheck' })) {
    const sole = (c.members ?? []).length === 1;
    for (const m of c.members ?? []) {
      if (lens && !sole && m.lens !== lens && m.lens !== SOLE_LENS) continue;
      rows.push({ kind: 'miss', story, stage: c.stage, ...(c.step ? { step: c.step } : {}), councilRound: c.round, seat: m.name, entry: m.entry ?? null, model: m.model ?? null, family: m.family ?? null, lens: m.lens ?? null, missedLens: lens, source, ...(finding ? { finding } : {}), ...(check ? { check } : {}), ...(head ? { head } : {}), ...(lowWeight ? { lowWeight: true } : {}) });
    }
  }
  write(config, rows);
  return rows;
}

// A red CI check as a miss: a failing test counts against test-value members, a build or static analysis failure
// against correctness members. Once per ticket, check and head: the same red check seen again on the same commit (the
// wait before a fixing round, then the gate of that round) is one miss.
export const ciLens = (check) => (/\b(test|tests|spec|specs|e2e|playwright|unit|integration|jest|vitest|xunit|pytest)\b/i.test(String(check)) ? 'test-value' : 'correctness');
export function recordCiMisses(config, { keys, failing, head = null }) {
  const seen = new Set(readMetricsLocal(config, FINDINGS_FILE).filter((r) => r.kind === 'miss' && r.source === 'ci').map((r) => `${r.story}|${r.finding}|${r.head ?? ''}`));
  for (const key of keys ?? []) {
    for (const check of failing ?? []) {
      const finding = String(check).slice(0, 200);
      if (head && seen.has(`${key}|${finding}|${head}`)) continue;
      seen.add(`${key}|${finding}|${head ?? ''}`);
      recordMisses(config, { story: key, lens: ciLens(check), source: 'ci', finding, head });
    }
  }
}

// Later bug tickets that name a delivered ticket: a lower-weight miss against every member that sat on it, once per
// bug ticket and ticket (the board sync calls this with every story it knows: [{ key, text }]).
export function recordBugTicketMisses(config, stories) {
  const done = new Set(readMetricsLocal(config, FINDINGS_FILE).filter((r) => r.kind === 'miss' && r.source === 'bug-ticket').map((r) => `${r.story}|${r.finding}`));
  const keys = new Set(stories.map((s) => s.key));
  let n = 0;
  for (const bug of stories.filter((s) => /^BUG-/i.test(s.key))) {
    const named = [...new Set([...String(bug.text ?? '').matchAll(/\b([A-Z][A-Z0-9]*-\d+)\b/g)].map((m) => m[1]))].filter((k) => k !== bug.key && keys.has(k));
    for (const key of named) {
      if (done.has(`${key}|${bug.key}`)) continue;
      done.add(`${key}|${bug.key}`);
      n += recordMisses(config, { story: key, source: 'bug-ticket', finding: bug.key, lowWeight: true }).length;
    }
  }
  return n;
}
