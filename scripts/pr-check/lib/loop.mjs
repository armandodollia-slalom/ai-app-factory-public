// The adversarial PR check loop. Each round: critics review in parallel, the defender rebuts, the
// critics answer (debateTurns times), the judge rules and the round is scored. Below 10/10 the fixer
// fixes the upheld findings, the script commits them, and a new round with fresh agents starts.
import { recordAnalysis, reportFor } from '../../pipeline/lib/analysis/fixloop.mjs';
import { evidenceText } from '../../pipeline/lib/analysis/report.mjs';
import { describesUserError, describesWeakerAuthz } from '../../pipeline/lib/user-errors.mjs';
import { wantsSlot, withAgentSlot } from '../../feature-verification/lib/slots.mjs';
import { stampKeptCases } from './pr-notes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentAsync } from '../../pipeline/lib/agents.mjs';
import { changedSince, contestedText, councilActionsText, councilFor, councilMemory, fixDeclarationText, fixesFile, memoryFile, memberRunEnv, guardProtectedTests, lateBox, memberScore, memberTask, mergeCouncil, normalizeFinding as normalizeCouncilFinding, planCases, recordCouncilRound, rewriteText, testProtection, unavailableReason } from '../../pipeline/lib/council.mjs';
import { escalate, metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, extractResult, log, nowIso, sha, writeJson } from '../../pipeline/lib/util.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { commitFixes, prDiff } from './context.mjs';
import { formattingOnlyHunks } from '../../implement/lib/gitops.mjs';
import { changedLineLint } from '../../implement/lib/ci-parity.mjs';

export const LENSES = {
  acceptance: { agent: 'pr-check-acceptance', code: 'ACC', title: 'Acceptance criteria' },
  flow: { agent: 'pr-check-flow', code: 'FLOW', title: 'End-to-end flow' },
  design: { agent: 'pr-check-design', code: 'UI', title: 'UI design vs mockup' },
  style: { agent: 'pr-check-style', code: 'STY', title: 'Code style and guidelines' },
  video: { agent: 'pr-check-video', code: 'VID', title: 'Video evidence' },
};
import { SEVERITIES, severityAtLeast } from '../../pipeline/lib/severity.mjs';
import { INFRA_PATTERNS, diffStatus, infraSideEffects } from './infra-changes.mjs';

export { severityAtLeast };
const CAP = { blocking: 6, major: 8, minor: 9 };
export const CHECKS_FILE = 'pr-checks.jsonl';

const rel = (ctx, p) => path.relative(ctx.workRoot, p).replace(/\\/g, '/');
const json = (value) => JSON.stringify(value, null, 2);

// A council (council.stages.prCheck) replaces the critics: each member is a critic of its own, named after the member,
// running the PR check agent closest to its lens. The acceptance critic still runs when no member has the acceptance
// lens: the ticket is the contract, and its coverage table is what proves every line met.
export const COUNCIL_CRITIC = { acceptance: 'acceptance', correctness: 'flow', security: 'flow', 'test-value': 'style', rewrite: 'style', ui: 'design' };
export function councilLenses(council) {
  if (!council) return null;
  const out = {};
  for (const m of council.members) {
    const critic = LENSES[COUNCIL_CRITIC[m.lens]];
    out[m.name] = { agent: critic.agent, code: m.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MEMBER', title: `${critic.title}, through the ${m.lens} lens (council member ${m.name})`, member: m };
  }
  if (!council.members.some((m) => m.lens === 'acceptance') && !out.acceptance) out.acceptance = LENSES.acceptance;
  return out;
}
export const lensInfo = (ctx, lens) => ctx.councilLenses?.[lens] ?? LENSES[lens];
// A lens's title, a council member's included (the report names every lens it scored).
export const lensTitle = (ctx, lens) => lensInfo(ctx, lens)?.title ?? lens;
// The lenses that rate the ticket's acceptance lines.
const acceptanceLensesOf = (ctx) => (ctx.councilLenses ? Object.entries(ctx.councilLenses).filter(([name, l]) => name === 'acceptance' || l.member?.lens === 'acceptance').map(([name]) => name) : ['acceptance']);

// The lenses of a round; `ctx.only` (--lenses) narrows them, for example to the design lens of an epic.
export function activeLenses(ctx) {
  const hasVideo = ctx.video.videos.length > 0 || ctx.video.unreadable.length > 0;
  if (ctx.councilLenses) {
    // The council's members, plus the stage's own critics no member's lens covers: the design critic (the mockup) on a
    // frontend PR, the video critic when there are recordings, and the flow critic, which lists the behaviour changes
    // outside the ticket's lines, when no member sits on it (council C9 proof: a two-member council dropped all three).
    const own = Object.keys(ctx.councilLenses);
    const covered = new Set(Object.values(ctx.councilLenses).map((l) => (l.member ? COUNCIL_CRITIC[l.member.lens] : null)).filter(Boolean));
    const extra = [...(covered.has('flow') ? [] : ['flow']), ...(ctx.isFrontend && !covered.has('design') ? ['design'] : []), ...(hasVideo ? ['video'] : [])];
    const lenses = [...own, ...extra.filter((l) => !own.includes(l))];
    return ctx.only?.length ? lenses.filter((l) => ctx.only.includes(l) || own.includes(l)) : lenses;
  }
  const lenses = ['acceptance', 'flow', ...(ctx.isFrontend ? ['design'] : []), 'style', ...(hasVideo ? ['video'] : [])];
  return ctx.only?.length ? lenses.filter((l) => ctx.only.includes(l)) : lenses;
}

// Council C4: the critics read a story's Implementation Notes ("the story records this as a decision") as
// accepting an authorization rule weaker than the ticket's, and did not raise it. Every round says what the notes are.
export const CONTRACT_NOTE = '**The ticket is the contract.** Its Expected behaviour and acceptance criteria are what the PR must meet. The story\'s `## Implementation Notes` section (Decisions, Deviations, Code map) was written by the implementer: it is their account, never a waiver. A criterion it narrows, or an authorization or security rule weaker than the ticket states, is unmet and `blocking`.';

// The tickets block of a multi-ticket check: every ticket with its story and mockups, the epic's journey,
// and how the critics (the design critic above all) use them.
export function ticketsBlock(ctx) {
  if (!ctx.multi) return [];
  const mock = (t) => (t.mockups.length ? t.mockups.join(', ') : '(no mockup: use its Outputs and the design system)');
  return [
    '',
    `### Tickets in this check (${ctx.tickets.length}${ctx.epic ? `, epic ${ctx.epic.key}` : ''})`,
    '',
    'The PR delivers all of these; hold it to every one. The design lens checks every frontend ticket against its own mockups, and the journey across them against the epic.',
    '',
    ...ctx.tickets.map((t) => `- ${t.key}${t.frontend ? ' (frontend)' : ''}: ${t.title}\n  - Story: ${t.file}\n  - Mockups: ${mock(t)}`),
    ...(ctx.epic ? [`- Epic ${ctx.epic.key}: ${ctx.epic.title} (the journey across the tickets)\n  - Body: ${ctx.epic.file}\n  - Mockups: ${ctx.epic.mockups.join(', ') || '(none)'}`] : []),
    '',
    'Name the ticket key (or "journey") in the `requirement` of every finding.',
  ];
}

export function modelFor(config, role) {
  return process.env[`PR_CHECK_MODEL_${role.toUpperCase()}`] || config.prCheck.models?.[config.agent.cli]?.[role] || null;
}

// Scoring is deterministic so an agent cannot talk its way to 10: any upheld finding caps its lens
// (blocking 6, major 8, minor 9), a lens whose critic failed scores 0, and the PR scores the lowest lens.
// A finding the judge did not rule on stands unless its critic withdrew it.
// The ticket is the contract (council C6): an acceptance line the critic still rates partial, unmet or unverifiable is
// never a follow-up and never passes. It is upheld, or, when the judge rules it a question for the ticket's owner (the
// ticket contradicts the application), it is an owner question: the acceptance lens stays below 10 and the check ends
// QUESTION, never PASS or ACCEPTED.
const OPEN_ROW = /^(partial|unmet|unverifiable|not[- ]met)$/i;
const UMBRELLA = /\b(result|outcome|behaviou?r)\b[^.]*\bmatch(es)?\b[^.]*\bexpected\b/i;
const firstSentence = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].slice(0, 140);

// Which coverage row a finding or question is about. The critic quotes the row's `ref` as the finding's `requirement`
// (agents/pr-check-acceptance.agent.md); when it does not, "AC <n>" labels must agree, else most of the row's words must
// appear in the finding.
const STOP = new Set('the and for with that this from are was not but can its has have when then given into than any all each only must should will does'.split(' '));
const normText = (t) => String(t ?? '').toLowerCase().replace(/\bac\s*[-#]?\s*(\d+)/g, 'ac$1').replace(/\s+/g, ' ').trim();
const words = (t) => new Set((normText(t).match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
const acIds = (t) => new Set(normText(t).match(/\bac\d+\b/g) ?? []);

export function addressesRow(row, item) {
  const ref = normText(row?.ref);
  if (!ref) return false;
  const req = normText(item?.requirement);
  if (req && (req === ref || (req.length >= 12 && ref.includes(req)) || (ref.length >= 12 && req.includes(ref)))) return true;
  const rowIds = acIds(row.ref);
  const itemIds = acIds([item?.requirement, item?.title].join(' '));
  if (rowIds.size && itemIds.size) return [...itemIds].some((id) => rowIds.has(id));
  const rw = words(row.ref);
  const iw = words([item?.requirement, item?.title, item?.detail, item?.question].join(' '));
  if (!rw.size || !iw.size) return false;
  const shared = [...rw].filter((w) => iw.has(w)).length;
  return shared >= 2 && shared / Math.min(rw.size, iw.size) >= 0.5;
}

// What an owner question may be about (the judge's questionKind).
export const QUESTION_KINDS = ['ambiguous', 'contradiction', 'two-readings', 'impossible'];
const severityAtLeastMajor = (sev) => (sev === 'blocking' ? 'blocking' : 'major');

function reconcileCoverage({ coverage, failedLenses, lenses, findings, upheld, questions, acc = 'acceptance' }) {
  if (failedLenses.includes(acc) || !lenses.includes(acc) || !coverage?.[acc]) return;
  const rows = coverage?.[acc]?.coverage ?? [];
  // A council seats acceptance-lens members as critics of their own (lens = member name): each one's table is reconciled.
  const tag = acc === 'acceptance' ? '' : `${acc}-`;
  const harness = (id, row, title, detail) => upheld.push({ id: `${tag}${id}`, lens: acc, severity: 'major', title, detail, evidence: String(row?.evidence ?? ''), requirement: String(row?.ref ?? ''), fix: 'Meet the line, or, if the ticket contradicts the application, rule it a question for the ticket owner.', reason: 'raised by the harness: open acceptance coverage', raisedBy: 'harness', criterion: true });
  if (!rows.length) {
    harness('acceptance-criterion-0', null, 'Criterion not rated: the acceptance critic rated no ticket line', 'The acceptance critic returned no coverage table, so no Expected or acceptance line is shown to be met. A check cannot pass or be accepted without one.');
    return;
  }
  const qItems = questions.map((q) => ({ ...findings.find((f) => f.id === q.id), question: q.question }));
  // The umbrella criterion ("Then the result matches Expected") is open whenever an Expected line is (council C7: a
  // question on an Expected line left the umbrella row to the harness, which sent the fixer at a contradiction). While
  // another open line exists, that line is reconciled on its own and stands for the umbrella; alone, the umbrella row is
  // reconciled like any other.
  const umbrella = (row) => UMBRELLA.test(String(row?.ref ?? ''));
  const isOpen = (row) => OPEN_ROW.test(String(row?.status ?? '').trim());
  const otherOpen = rows.some((row) => isOpen(row) && !umbrella(row));
  rows.forEach((row, i) => {
    if (!isOpen(row)) return;
    if (umbrella(row) && otherOpen) return;
    if (qItems.some((q) => addressesRow(row, q))) return;
    const own = upheld.findIndex((f) => f.lens === acc && f.raisedBy !== 'harness' && addressesRow(row, f));
    if (own >= 0) {
      upheld[own] = { ...upheld[own], criterion: true };
      if (upheld[own].severity === 'minor') upheld[own] = { ...upheld[own], severity: 'major', raisedBy: 'harness', criterion: true, reason: `${upheld[own].reason ?? ''} (raised to major by the harness: the ticket line it is about is ${String(row.status).toLowerCase()})`.trim() };
      return;
    }
    harness(`acceptance-criterion-${i + 1}`, row, `Criterion not met: ${firstSentence(row.ref) || 'a ticket line'}`, `The acceptance critic rates this ticket line ${String(row.status).toLowerCase()}${row.evidence ? ` (${row.evidence})` : ''}. A line it does not rate met cannot pass, and it cannot be a follow-up; no upheld finding or owner question is about it.`);
  });
}

// Findings the CI gate seeds from the PR's checks (scripts/implement/lib/ci-wait.mjs ciFindings).
export const isCiFinding = (f) => /^CI(-FLAKY)?-\d+$/.test(String(f?.id ?? ''));

export function scoreRound({ lenses, findings, rulings = [], judgeLensScores = {}, failedLenses = [], coverage = {}, acceptanceLenses = ['acceptance'] }) {
  const byId = new Map(rulings.filter((r) => r && r.id).map((r) => [String(r.id), r]));
  const upheld = [];
  for (const f of findings) {
    const r = byId.get(f.id);
    if (r) {
      if (r.ruling === 'upheld') upheld.push({ ...f, severity: SEVERITIES.includes(r.severity) ? r.severity : f.severity, reason: r.reason ?? '', fix: r.fix || f.fix });
    } else if (f.status !== 'withdrawn') {
      upheld.push({ ...f, reason: 'The judge gave no ruling, so the finding stands.' });
    }
  }
  // An upheld finding filed as minor that describes an error users hit is at least major (lib/user-errors.mjs).
  for (const [i, f] of upheld.entries()) if (f.severity === 'minor' && describesUserError([f.title, f.detail, f.reason].join(' '))) upheld[i] = { ...f, severity: 'major', raisedBy: 'harness' };
  // An upheld finding that says access is weaker than required is blocking (council C4).
  for (const [i, f] of upheld.entries()) if (f.severity !== 'blocking' && describesWeakerAuthz([f.title, f.detail, f.reason, f.requirement].join(' '))) upheld[i] = { ...f, severity: 'blocking', raisedBy: 'harness' };
  const known = new Set(findings.map((f) => f.id));
  for (const r of rulings) {
    if (r?.ruling !== 'upheld' || known.has(String(r.id))) continue;
    const lens = lenses.find((l) => String(r.id).toLowerCase().startsWith(l));
    if (!lens) continue;
    upheld.push({ id: String(r.id), lens, severity: SEVERITIES.includes(r.severity) ? r.severity : 'major', title: r.title ? String(r.title).slice(0, 200) : `Coverage gap: ${firstSentence(r.reason) || 'an item the critic did not rate met'}`, detail: r.reason ?? '', evidence: '', requirement: '', fix: r.fix ?? '', reason: r.reason ?? '' });
  }
  // Owner questions: an acceptance finding the judge dismissed as a question for the ticket's owner, or with a follow-up
  // (an acceptance line cannot be a follow-up).
  const accIds = new Set(findings.filter((f) => acceptanceLenses.includes(f.lens)).map((f) => f.id));
  // A question is for what only the ticket's owner can decide: the ticket is ambiguous, contradicts itself or the
  // application, or allows two valid readings (`questionKind`). Anything else the judge turned into a question (dogfood
  // C14: "is a 9999 limit acceptable?" about a limit no ticket line asked for) is an upheld acceptance finding:
  // the ticket is the answer, and the finding goes back to implementation.
  const asked = rulings.filter((r) => r?.ruling === 'dismissed' && accIds.has(String(r.id)) && (r.question || (typeof r.followUp === 'string' && r.followUp.trim())));
  const questions = [];
  for (const r of asked) {
    const f = findings.find((x) => x.id === String(r.id));
    const text = String(r.question && r.question !== true ? r.question : r.followUp ?? r.reason ?? '').trim();
    if (QUESTION_KINDS.includes(r.questionKind)) {
      questions.push({ id: String(r.id), kind: r.questionKind, title: f?.title ?? String(r.id), question: text, reason: String(r.reason ?? '').trim() });
      continue;
    }
    upheld.push({ ...(f ?? { id: String(r.id), lens: acceptanceLenses[0] }), severity: severityAtLeastMajor(f?.severity), raisedBy: 'harness', reason: `Not a question for the owner (no ticket ambiguity, contradiction or second reading named): the ticket is the answer. ${text}`.trim(), fix: r.fix ?? 'Make the change do what the ticket says and nothing it does not ask for.' });
  }
  // Every acceptance line the critic still rates open is reconciled on its own (council C7): it needs an upheld
  // acceptance finding about that line (at least major: an unmet line is never polish) or an owner question about that
  // line. A finding or question about another line never covers it. A line nothing addresses is upheld by the harness.
  for (const acc of acceptanceLenses) reconcileCoverage({ coverage, failedLenses, lenses, findings, upheld, questions, acc });
  const lensScores = {};
  for (const lens of lenses) {
    if (failedLenses.includes(lens)) {
      lensScores[lens] = 0;
      continue;
    }
    const mine = upheld.filter((f) => f.lens === lens);
    if (!mine.length) {
      lensScores[lens] = 10;
      continue;
    }
    const cap = Math.min(...mine.map((f) => CAP[f.severity] ?? CAP.major));
    const judged = Number(judgeLensScores[lens]);
    lensScores[lens] = Math.max(0, Math.min(cap, Number.isFinite(judged) ? Math.round(judged) : cap));
  }
  if (questions.length) for (const acc of acceptanceLenses) if (acc in lensScores) lensScores[acc] = Math.min(lensScores[acc], 9);
  // A finding the judge dismissed as real but pre-existing or outside the PR's tickets, with a follow-up to
  // file: it goes to the PR's Follow-ups and the board, not into this PR (council C2).
  const followUps = rulings
    .filter((r) => r?.ruling === 'dismissed' && typeof r.followUp === 'string' && r.followUp.trim() && !accIds.has(String(r.id)))
    .map((r) => ({ id: String(r.id), lens: findings.find((f) => f.id === String(r.id))?.lens ?? null, title: r.followUp.trim(), reason: (r.reason ?? '').trim() }));
  return { score: Math.min(...Object.values(lensScores)), lensScores, upheld, followUps, questions };
}

function normalizeFinding(raw, lens, id) {
  const text = (v) => (v == null ? '' : String(v));
  return {
    id,
    lens,
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'major',
    title: text(raw.title).slice(0, 200) || '(untitled)',
    detail: text(raw.detail),
    evidence: text(raw.evidence),
    requirement: text(raw.requirement),
    fix: text(raw.fix),
    status: 'open',
    thread: [],
    // A council member's finding keeps the council's fields (council.mjs): who raised it, its action and what it targets.
    ...Object.fromEntries(['action', 'test', 'deletes', 'approach', 'why', 'covers', 'members', 'upheldBy', 'notUpheld', 'protected', 'supersededBy', 'contested', 'file', 'line'].filter((k) => raw[k] !== undefined && raw[k] !== null).map((k) => [k, raw[k]])),
  };
}

function header(config, ctx, round, files) {
  const { pr, story } = ctx;
  const lines = [
    `PR check round ${round} of at most ${config.prCheck.maxRounds}.`,
    pr ? `Pull request: #${pr.number} "${pr.title}" (${pr.url}), branch ${pr.headRef} into ${pr.baseRef}` : `Branch: ${ctx.branch}`,
    `Story: ${story.key} - ${ctx.storyTitle} (${story.file})`,
    `Frontend story: ${ctx.isFrontend ? 'yes' : 'no'}`,
    ...(ctx.ciFixIds?.length ? [`This round checks a fix for failing or retried CI checks (${ctx.ciFixIds.join(', ')}). CI runs again after the push and the CI wait verifies those checks: do not rate or report them.`] : []),
    `Round folder: ${files.roundDir}`,
    '',
    'Files (paths relative to the repository root; read what you need):',
    `- Story (ticket cache, absolute path): ${config.abs(story.file)}`,
    `- PR description: ${files.prFile}`,
    `- Diff against ${ctx.baseRef} (merge base ${ctx.baseRev.slice(0, 10)}): ${files.diffFile}`,
    `- Changed files (${ctx.diff.files.length}): ${ctx.diff.files.slice(0, 200).join(', ')}${ctx.diff.files.length > 200 ? ', ...' : ''}`,
    `- Conventions: ${ctx.conventions.join(', ') || '(none)'}`,
    `- Mockups (absolute paths): ${ctx.mockups.join(', ') || '(none for this story)'}`,
    ...(ctx.mockupRenders?.ok && ctx.mockupRenders.entries.length ? [`- Mockup renders: ${rel(ctx, path.join(ctx.runDir, 'context', 'mockups', 'manifest.json'))} (${ctx.mockupRenders.entries.filter((e) => e.kind === 'screen' && e.png).length} screens and states as PNGs)`] : []),
    `- Video frames: ${ctx.video.videos.length ? `${files.framesFile} (${ctx.video.videos.length} video(s), ${ctx.video.videos.reduce((n, v) => n + v.frames.length, 0)} frames)` : '(no readable videos)'}`,
  ];
  if (ctx.video.unreadable.length) lines.push(`- Videos that could not be read: ${ctx.video.unreadable.map((u) => `${u.source} (${u.reason})`).join('; ')}`);
  if (files.previousRulings) lines.push(`- Upheld findings from the previous round: ${files.previousRulings}`);
  lines.push(...ticketsBlock(ctx));
  // The lint and format check, run by the harness on the PR's changed lines (council C6: a read-only critic could not
  // run the formatter and marked formatting unverifiable). Critics use this result; they do not run formatters.
  // Static analysis of the PR's head (the report the pipeline wrote for that commit, or one run now): evidence for the
  // critics, who do not run the tools again.
  if (files.analysis) lines.push('', evidenceText(files.analysis));
  if (files.lint) lines.push('', `### Lint and format check of the changed lines (run by the harness, as CI runs it)`, '', files.lint.length ? files.lint.map((e) => `- ${e.slice(0, 600)}`).join('\n') : 'Clean: no problem on any changed line.');
  lines.push('', CONTRACT_NOTE);
  lines.push('', '### Diff stat', '', '```', ctx.diff.stat.trimEnd() || '(empty)', '```');
  return lines.join('\n');
}

async function callAgent(config, ctx, files, { role, agent, label, task, mode = 'read', timeoutSec, validate, env = {}, member = null, onResult = null }) {
  for (let attempt = 0; attempt <= config.agent.resultParseRetries; attempt++) {
    const result = await runAgentAsync(config, {
      name: agent,
      task,
      mode,
      model: member ? member.model ?? null : modelFor(config, role),
      ...(member ? { cli: member.cli === 'custom' ? null : member.cli, effort: member.effort ?? null, cmd: member.cli === 'custom' ? member.cmd : null } : {}),
      cwd: ctx.workRoot,
      timeoutSec: timeoutSec ?? config.prCheck.timeoutSec,
      promptFile: path.join(files.roundAbs, `${label}.prompt.md`),
      usage: { stage: 'pr-check', story: ctx.story?.key ?? null, round: files.round ?? null, step: label },
      // The stories this check covers: the fixer may change their tests only (story-guard foreignTestGuard).
      extraEnv: { PIPELINE_STORY_KEYS: (ctx.tickets ?? [ctx.story]).filter(Boolean).map((t) => t.key).join(','), ...(member ? memberRunEnv(member) : {}), ...env },
    });
    fs.writeFileSync(path.join(files.roundAbs, `${label}.out.md`), result.output ?? '');
    onResult?.(result);
    const raw = extractResult(result.output ?? '');
    if (raw && validate(raw)) return raw;
    log(`${label}: no valid AGENT_RESULT (attempt ${attempt + 1})`);
  }
  return null;
}

async function critique(config, ctx, files, round, lens, previousUpheld) {
  const earlier = previousUpheld.filter((f) => f.lens === lens).map(({ id, severity, title, evidence, fix }) => ({ id, severity, title, evidence, fix }));
  const task = [
    header(config, ctx, round, files),
    '',
    `## Lens: ${lensInfo(ctx, lens).title}. First pass`,
    '',
    'Review the PR through your lens and report every finding with evidence.',
    earlier.length ? `\nThese findings were upheld last round; check each one and re-raise it with the same id if it is not fixed:\n\n${json(earlier)}` : '',
  ].join('\n');
  const member = lensInfo(ctx, lens).member ?? null;
  const council = member ? ctx.council : null;
  let last = null;
  const review = await callAgent(config, ctx, files, {
    role: lens,
    agent: lensInfo(ctx, lens).agent,
    label: `critic-${lens}`,
    task: council ? memberTask(task, { council, member, round, earlier: ctx.councilMemory?.text ?? '' }) : task,
    member,
    onResult: (r) => (last = r),
    validate: (r) => Array.isArray(r.findings) && (member ? true : Number.isFinite(Number(r.score))),
  });
  if (member && !review) ctx.councilRuns[lens] = last;
  return review;
}

async function debate(config, ctx, files, round, findings, lenses) {
  const save = () => writeJson(files.debateAbs, { round, lenses, findings });
  save();
  for (let turn = 1; turn <= config.prCheck.debateTurns; turn++) {
    const open = findings.filter((f) => f.status === 'open');
    if (!open.length) break;
    const defense = await callAgent(config, ctx, files, {
      role: 'defender',
      agent: 'pr-check-defender',
      label: `defender-turn-${turn}`,
      task: [header(config, ctx, round, files), '', `## Debate turn ${turn} of ${config.prCheck.debateTurns}`, '', `Answer every finding below (the full debate so far is in ${files.debateFile}):`, '', json(open)].join('\n'),
      validate: (r) => Array.isArray(r.responses),
    });
    if (!defense) {
      log(`round ${round}: the defender gave no answer on turn ${turn}; the judge rules without it`);
      break;
    }
    const answers = new Map(defense.responses.filter((r) => r?.id).map((r) => [String(r.id), r]));
    const contested = [];
    for (const f of open) {
      const r = answers.get(f.id);
      if (!r) continue;
      f.thread.push({ turn, by: 'defender', position: r.position, argument: r.argument ?? '', evidence: r.evidence ?? '', severity: r.severity });
      if (r.position === 'concede') f.status = 'conceded';
      else contested.push(f);
    }
    save();
    if (!contested.length) break;
    const byLens = Object.groupBy ? Object.groupBy(contested, (f) => f.lens) : contested.reduce((acc, f) => ((acc[f.lens] ??= []).push(f), acc), {});
    await Promise.all(
      Object.entries(byLens).map(async ([lens, mine]) => {
        const reply = await callAgent(config, ctx, files, {
          role: lens,
          agent: lensInfo(ctx, lens).agent,
          member: lensInfo(ctx, lens).member ?? null,
          label: `critic-${lens}-rejoinder-${turn}`,
          task: [header(config, ctx, round, files), '', `## Lens: ${lensInfo(ctx, lens).title}. Rejoinder, debate turn ${turn}`, '', 'The defender answered these findings of yours. Maintain, amend or withdraw each one:', '', json(mine)].join('\n'),
          validate: (r) => Array.isArray(r.responses),
        });
        const replies = new Map((reply?.responses ?? []).filter((r) => r?.id).map((r) => [String(r.id), r]));
        for (const f of mine) {
          const r = replies.get(f.id);
          if (!r) continue;
          f.thread.push({ turn, by: 'critic', action: r.action, argument: r.argument ?? '' });
          if (r.action === 'withdraw') f.status = 'withdrawn';
          if (r.action === 'amend' && r.finding && typeof r.finding === 'object') {
            Object.assign(f, normalizeFinding({ ...f, ...r.finding }, f.lens, f.id), { status: 'open', thread: f.thread });
          }
        }
      }),
    );
    save();
  }
}

async function judge(config, ctx, files, round, lenses, findings, coverage, failedLenses) {
  writeJson(path.join(files.roundAbs, 'coverage.json'), coverage);
  const task = [
    header(config, ctx, round, files),
    '',
    '## Rule on this round',
    '',
    `Lenses: ${lenses.join(', ')}.${failedLenses.length ? ` These critics failed and score 0 regardless: ${failedLenses.join(', ')}.` : ''}`,
    `Debate (${findings.length} findings; statuses open, conceded or withdrawn, with the full thread): ${files.debateFile}`,
    `Critic coverage tables: ${files.coverageFile}`,
    `Coverage gaps without a finding use the id "<lens>-coverage-<n>", for example "acceptance-coverage-1".`,
    '',
    findings.length ? json(findings.map(({ thread, ...f }) => ({ ...f, exchanges: thread.length }))) : 'No findings were raised. Check the coverage tables before you award 10.',
  ].join('\n');
  return callAgent(config, ctx, files, {
    role: 'judge',
    agent: 'pr-check-judge',
    label: 'judge',
    task,
    validate: (r) => Number.isFinite(Number(r.score)) && Array.isArray(r.rulings),
  });
}

async function fixRound(config, ctx, files, round, upheld) {
  writeJson(files.rulingsAbs, { round, upheld });
  const before = git(ctx.workRoot, ['rev-parse', 'HEAD']).stdout.trim();
  // D-C8-4: the fixer may run the e2e specs; under `implement run` it does so on a leased slot of its own, never on
  // slot 0 (which the teststack refuses to agents there). No slot free: it works without a stack and says so.
  const slotConfig = { ...config, root: ctx.workRoot };
  const fixer = (env) => callAgent(config, ctx, files, {
    role: 'fixer',
    agent: 'pr-check-fixer',
    label: 'fixer',
    mode: 'write',
    timeoutSec: config.prCheck.fixTimeoutSec,
    env,
    task: [header(config, ctx, round, files), '', '## Fix these upheld findings', '', `Also in ${files.rulingsFile}.`, '', json(upheld), ...(env.TESTSTACK_SLOT ? ['', `Your test stack is slot ${env.TESTSTACK_SLOT} (TESTSTACK_SLOT, ${env.TESTSTACK_URL}); \`factory teststack up\` and the e2e specs use it.`] : wantsSlot(slotConfig) ? ['', 'No test stack slot is free for you: do not start a stack; feature verification runs the e2e specs after your fix.'] : []), ...(ctx.council ? ['', councilActionsText({ refuse: 'put the finding in `notFixed`', owns: false }), '', fixDeclarationText(fixesFile(ctx.workRoot, config.stateDir, { stage: 'prCheck', story: ctx.story?.key ?? 'pr' }), upheld)] : [])].join('\n'),
    validate: (r) => Array.isArray(r.fixed),
  });
  const leased = await withAgentSlot(slotConfig, ctx.story.key, fixer, undefined, { stage: 'pr-check fixer', owner: `pr-check-fixer-${ctx.id}`, waitSec: 300 });
  const result = leased?.noSlot ? await fixer({}) : leased;
  // With a council (which can ask for tests to be deleted), a protected test the fixer deleted is put back before the
  // commit; the next round's critics judge the restored code, and the run log says what came back.
  const keys = (ctx.tickets ?? [ctx.story]).filter(Boolean).map((t) => t.key);
  const restoredTests = ctx.council ? guardProtectedTests({ cwd: ctx.workRoot, from: before, keys, cases: keys.flatMap((k) => planCases(ctx.workRoot, ctx.plansDir, k)) }) : [];
  if (restoredTests.length) log(`round ${round}: restored ${restoredTests.length} protected test file(s) the fixer changed: ${restoredTests.map((v) => `${v.file} (${v.reasons.join('; ')})`).join(', ')}`);
  // Plan cases the fixer added or changed for these findings are kept through any re-plan (council C5).
  const touched = [...new Set([...git(ctx.workRoot, ['diff', '--name-only', 'HEAD']).stdout.split('\n'), ...git(ctx.workRoot, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n')].filter(Boolean))];
  const fixedIds = Array.isArray(result?.fixed) && result.fixed.length ? result.fixed.map(String) : upheld.map((f) => f.id);
  const kept = stampKeptCases(touched, fixedIds, { read: (f) => (fs.existsSync(path.join(ctx.workRoot, f)) ? fs.readFileSync(path.join(ctx.workRoot, f), 'utf8') : null), write: (f, t) => fs.writeFileSync(path.join(ctx.workRoot, f), t) });
  if (kept.length) log(`round ${round}: ${kept.length} plan case(s) the fixer wrote are kept for ${fixedIds.join(', ')}`);
  let commit = commitFixes(config, ctx, `${ctx.story.key}: PR check round ${round} fixes\n\nFixes upheld PR check findings: ${upheld.map((f) => f.id).join(', ')}`);
  // The fixer's change ends with the checks every implementation change gets (dogfood C4): no formatting-only hunks on
  // lines it does not otherwise change, and CI's lint clean on the changed lines. What they find goes back to the
  // fixer once, in the same round.
  const checks = commit ? afterFixChecks(ctx, before) : [];
  if (checks.length) {
    log(`round ${round}: the fix fails ${checks.length} check(s) CI or the review would; the fixer fixes them`);
    await callAgent(config, ctx, files, {
      role: 'fixer',
      agent: 'pr-check-fixer',
      label: 'fixer-checks',
      mode: 'write',
      timeoutSec: config.prCheck.fixTimeoutSec,
      task: [header(config, ctx, round, files), '', '## Fix these problems in your last change', '', json(checks)].join('\n'),
      validate: (r) => Array.isArray(r.fixed),
    });
    commit = commitFixes(config, ctx, `${ctx.story.key}: PR check round ${round} fixes (lint and formatting)`) ?? commit;
  }
  return { ...(restoredTests.length ? { restoredTests } : {}), fixed: result?.fixed ?? [], notFixed: result?.notFixed ?? [], notes: Array.isArray(result?.notes) ? result.notes.filter((n) => n && typeof n.field === 'string' && typeof n.text === 'string') : [], summary: result?.summary ?? '', commit };
}

// Formatting-only hunks the fix made, and CI's changed-line lint, as findings for the fixer.
export function afterFixChecks(ctx, before, { hunks = formattingOnlyHunks, lint = changedLineLint } = {}) {
  const out = hunks(ctx.workRoot, before).map((h, i) => ({ id: `HYG-${i + 1}`, title: 'Whitespace or line breaks changed on a line the fix does not otherwise change', evidence: `${h.file}: lines ${h.lines}`, fix: 'Restore these lines exactly as they were.' }));
  const errors = ctx.baseRev ? lint(ctx.workRoot, ctx.baseRev) : [];
  errors.forEach((e, i) => out.push({ id: `LINT-${i + 1}`, title: "CI's lint reports a problem on a changed line", evidence: e.slice(0, 2000), fix: "Fix the reported lines to the repository's formatter and linter rules, without changing behavior." }));
  return out;
}

function roundFiles(ctx, round, { clean = true } = {}) {
  const roundAbs = path.join(ctx.runDir, `round-${round}`);
  if (clean) fs.rmSync(roundAbs, { recursive: true, force: true });
  fs.mkdirSync(roundAbs, { recursive: true });
  return {
    round,
    roundAbs,
    roundDir: rel(ctx, roundAbs),
    prFile: rel(ctx, path.join(ctx.runDir, 'context', 'pr.md')),
    framesFile: rel(ctx, path.join(ctx.runDir, 'context', 'frames.json')),
    diffFile: rel(ctx, path.join(roundAbs, 'diff.patch')),
    debateAbs: path.join(roundAbs, 'debate.json'),
    debateFile: rel(ctx, path.join(roundAbs, 'debate.json')),
    coverageFile: rel(ctx, path.join(roundAbs, 'coverage.json')),
    rulingsAbs: path.join(roundAbs, 'rulings.json'),
    rulingsFile: rel(ctx, path.join(roundAbs, 'rulings.json')),
    previousRulings: round > 1 ? rel(ctx, path.join(ctx.runDir, `round-${round - 1}`, 'rulings.json')) : null,
  };
}

// Lenses a fix could not have changed, from round 2 on (cost, dogfood C2): the design critic when the last fix
// touched no frontend file, the video critic when the frames are the ones it judged and the fix touched no spec
// or frontend file. Only a lens that scored 10 with nothing upheld is carried; acceptance, flow and style (the
// code itself) always run again.
export function carryOver(ctx, history, gitImpl) {
  const last = history[history.length - 1];
  if (!last?.fix?.commit || !last.lensScores) return {};
  const changed = String(gitImpl(ctx.workRoot, ['diff', '--name-only', `${last.fix.commit}^`, last.fix.commit]).stdout ?? '').split('\n').filter(Boolean);
  if (!changed.length) return {};
  const ui = changed.some((f) => ctx.frontendHit?.(f));
  const specs = changed.some((f) => /(^|\/)(e2e|tests?)\//.test(f));
  const framesSame = ctx.videoKey && last.videoKey === ctx.videoKey;
  const clean = (lens) => last.lensScores[lens] === 10 && !last.upheld.some((f) => f.lens === lens);
  const carry = {};
  // A fix that addressed only minor findings re-runs only the lenses those findings were on (cost, dogfood C4): a lens
  // that scored 10 with nothing upheld is carried, except acceptance (council C7): every round that can end PASS or
  // ACCEPTED rates every ticket line against the code it ends on.
  if (last.upheld.length && last.upheld.every((f) => f.severity === 'minor')) {
    for (const lens of Object.keys(last.lensScores)) if (lens !== 'acceptance' && clean(lens) && (lens !== 'video' || (!ui && !specs && framesSame))) carry[lens] = 10;
    return carry;
  }
  if (clean('design') && !ui) carry.design = 10;
  if (clean('video') && !ui && !specs && framesSame) carry.video = 10;
  // A council member need not sit again when its last score passed, nothing it raised was upheld, and the fix touched
  // nothing it judges (dogfood C14: every member re-sat every round). Its scope: test files for test-value, frontend
  // files for ui, the production code for the others. Never the acceptance lens: every ticket line is rated again.
  for (const m of ctx.council?.members ?? []) {
    const lens = m.name;
    if (!(lens in last.lensScores) || m.lens === 'acceptance') continue;
    const passed = last.lensScores[lens] >= (ctx.council.passScore ?? 9) && !last.upheld.some((f) => f.lens === lens);
    const inScope = (f) => (m.lens === 'test-value' ? /(^|\/)(e2e|tests?)\/|\.(spec|test)\./.test(f) : m.lens === 'ui' ? Boolean(ctx.frontendHit?.(f)) : !/(^|\/)(e2e|tests?)\/|\.(spec|test)\.|^\.factory\//.test(f));
    if (passed && !changed.some(inScope)) carry[lens] = last.lensScores[lens];
  }
  return carry;
}

const LATE = Symbol('late');

// The critics of a round, in parallel. Without a council every one is waited for, as always. With one, a non-blocking
// member is not: once every other critic has answered, a non-blocking member still running is marked LATE, and its
// review, when it comes, goes to ctx.councilLate as feedback for the next round (its score is never recorded).
async function critiques(config, ctx, files, round, lenses, previousUpheld) {
  const runs = lenses.map((lens) => critique(config, ctx, files, round, lens, previousUpheld));
  if (!ctx.council) return { lenses, reviews: await Promise.all(runs) };
  const nonBlocking = (lens) => lensInfo(ctx, lens).member?.blocking === false;
  const settled = new Map();
  runs.forEach((p, i) => p.then((r) => settled.set(i, r), () => settled.set(i, null)));
  await Promise.all(runs.filter((_, i) => !nonBlocking(lenses[i])));
  await new Promise((resolve) => setImmediate(resolve));
  const reviews = runs.map((p, i) => {
    if (settled.has(i)) return settled.get(i);
    const member = lensInfo(ctx, lenses[i]).member;
    log(`round ${round}: council member ${member.name} (non-blocking) is still running; its review will be feedback for the next round`);
    const pending = p.then((review) => {
      if (review) ctx.councilLate.push({ member, status: 'ok', findings: review.findings.filter((f) => f && typeof f === 'object').map((f) => normalizeCouncilFinding({ ...f, text: f.title ?? f.detail }, member)) });
    }, () => {});
    (ctx.councilPending ??= new Set()).add(pending);
    pending.then(() => ctx.councilPending.delete(pending));
    return LATE;
  });
  return { lenses, reviews };
}

// The council's findings of a round, merged (council.mjs mergeCouncil), as debate findings: one per defect, on the lens
// of the first member that raised it, with every member's evidence. Minor, outvoted and protected findings go in as
// minor; findings inside a region an upheld rewrite deletes are left out (the rewrite replaces them).
function councilFindings(ctx, round, lenses, reviews, previousUpheld, used, lateMembers = [], carried = {}) {
  const results = lateMembers.map((member) => ({ member, status: 'late', reason: 'not waited for (non-blocking)' }));
  // A member carried over (carryOver) counts with its last score and nothing new, and the record says so.
  for (const [lens, score] of Object.entries(carried)) {
    const member = lensInfo(ctx, lens).member;
    if (member) results.push({ member, status: 'ok', score, verdict: 'APPROVED', summary: 'carried over: nothing it judges changed since its last passing round', findings: [], reason: 'carried over' });
  }
  const failedLenses = [];
  const earlier = new Map(previousUpheld.map((f) => [f.id, f]));
  lenses.forEach((lens, i) => {
    const member = lensInfo(ctx, lens).member;
    if (!member) return;
    const review = reviews[i];
    if (!review) {
      const why = unavailableReason(ctx.councilRuns[lens]);
      results.push({ member, status: why ? 'unavailable' : 'failed', reason: why ?? 'no valid result' });
      // A failed blocking member scores 0; an unavailable one under onUnavailable "report", or a non-blocking one, is left out.
      if (member.blocking && !(why && ctx.council.onUnavailable === 'report')) failedLenses.push(lens);
      return;
    }
    results.push({ member, status: 'ok', score: memberScore(review), verdict: null, summary: String(review.summary ?? ''), findings: review.findings.filter((f) => f && typeof f === 'object').map((f) => normalizeCouncilFinding({ ...f, text: f.title ?? f.detail }, member)), followUps: review.followUps });
  });
  const keys = (ctx.tickets ?? [ctx.story]).filter(Boolean).map((t) => t.key);
  const cases = keys.flatMap((k) => planCases(ctx.workRoot, ctx.plansDir, k));
  const merged = mergeCouncil(ctx.council, results, { protect: (f) => testProtection(f, { keys, cases }), feedback: ctx.councilLate?.take() ?? [], changed: changedSince(ctx.workRoot, ctx.baseRev, git), earlier: ctx.councilMemory ?? null, root: ctx.workRoot });
  const findings = [];
  let n = 0;
  // Late feedback from a non-blocking member goes into the debate as a minor finding of the first blocking lens (it never
  // blocks: council pass ignores minor findings).
  for (const f of [...merged.findings, ...merged.notes.filter((x) => !x.supersededBy)]) {
    const lens = lenses.find((l) => lensInfo(ctx, l).member?.name === f.member) ?? lenses.find((l) => lensInfo(ctx, l).member?.blocking !== false) ?? lenses[0];
    const code = lensInfo(ctx, lens).code;
    const reuse = f.id && earlier.has(String(f.id)) && !used.has(String(f.id));
    let id = reuse ? String(f.id) : `${code}-${round}-${++n}`;
    while (used.has(id)) id = `${code}-${round}-${++n}`;
    used.add(id);
    const fix = f.action === 'rewrite' ? rewriteText(f) : f.action === 'delete-test' ? `Delete the test ${f.test || '(named in the evidence)'}${f.file ? ` in ${f.file}` : ''}: it adds no protection.` : f.fix;
    const why = f.protected ? ` Not acted on: ${f.protected}.` : f.notUpheld ? ` Not upheld: ${f.notUpheld}.` : f.feedback ? ` Feedback from non-blocking council member ${f.member}.` : '';
    findings.push(normalizeFinding({ ...f, title: f.title || f.text, detail: `${f.detail ?? ''}${contestedText(f)}${why}${f.members?.length > 1 ? ` Raised by ${f.members.join(', ')}.` : ''}`.trim(), fix }, lens, id));
  }
  return { findings, failedLenses, merged, results };
}

// The council's pass for a PR check round, after the debate and the judge: no failed blocking member, and no upheld
// finding that blocks (minor, outvoted and protected findings never block); contradictions between members become
// questions for the ticket's owner. Recorded with the members' own scores.
function councilOutcome(config, ctx, round, lenses, council, scored) {
  const { merged } = council;
  const blocks = (f) => f.severity !== 'minor' && !f.notUpheld && !f.protected;
  for (const [i, c] of (merged.contradictions ?? []).entries()) {
    scored.questions.push({ id: `council-contradiction-${round}-${i + 1}`, title: `Council members contradict each other: ${String(c.subject).slice(0, 120)}`, question: c.positions.map((p) => `${p.member}: ${p.action} (${String(p.evidence ?? '').slice(0, 200)})`).join('; '), reason: 'the members disagree and the evidence has not settled it' });
  }
  const blockingLenses = lenses.filter((l) => !lensInfo(ctx, l).member || lensInfo(ctx, l).member.blocking);
  const scores = blockingLenses.map((l) => scored.lensScores[l]).filter((x) => Number.isFinite(x));
  scored.score = scores.length ? Math.min(...scores) : 0;
  scored.pass = !merged.error && !council.failedLenses.length && !scored.upheld.some(blocks) && !scored.questions.length;
  // The judge's upheld findings are what the council upheld this round (council.mjs councilMemory).
  if (!merged.error) ctx.councilMemory?.remember(scored.upheld.filter(blocks));
  recordCouncilRound(config, { stage: 'prCheck', story: ctx.story.key, round, council: ctx.council, merged: { ...merged, pass: scored.pass } });
}

export async function runRound(config, ctx, round, previousUpheld, { carry = {} } = {}) {
  const files = roundFiles(ctx, round);
  try {
    files.lint = ctx.baseRev ? changedLineLint(ctx.workRoot, ctx.baseRev) : null;
  } catch {
    files.lint = null;
  }
  try {
    files.analysis = ctx.baseRev ? await reportFor(config, 'prCheck', { cwd: ctx.workRoot, base: ctx.baseRev }) : null;
    if (files.analysis) recordAnalysis(config, { story: ctx.story?.key ?? null, stage: 'pr-check', round, report: files.analysis });
  } catch (error) {
    log(`static analysis not run: ${error.message}`);
    files.analysis = null;
  }
  ctx.diff = prDiff(config, ctx);
  fs.writeFileSync(path.join(files.roundAbs, 'diff.patch'), `${ctx.diff.stat}\n${ctx.diff.diff}`);
  const seated = activeLenses(ctx).filter((l) => !(l in carry));
  log(`round ${round}: critics ${seated.join(', ')}${Object.keys(carry).length ? `; carried over: ${Object.keys(carry).join(', ')} (nothing they judge changed)` : ''}`);

  // What earlier rounds of this check upheld, for every member and for the merge (council.mjs councilMemory).
  if (ctx.council) ctx.councilMemory = councilMemory({ file: memoryFile(config.root, config.stateDir, { stage: 'prCheck', story: ctx.story?.key ?? 'pr' }), cwd: ctx.workRoot, round, fixes: fixesFile(ctx.workRoot, config.stateDir, { stage: 'prCheck', story: ctx.story?.key ?? 'pr' }) });
  const all = await critiques(config, ctx, files, round, seated, previousUpheld);
  // A non-blocking council member still running when the blocking critics have answered is not waited for (its result
  // is feedback for the next round): this round goes on without its lens.
  const lenses = all.lenses.filter((l, i) => all.reviews[i] !== LATE);
  const reviews = all.reviews.filter((r) => r !== LATE);
  const findings = [];
  const coverage = {};
  const failedLenses = [];
  const used = new Set();
  const earlierIds = new Set(previousUpheld.map((f) => f.id));
  // A council: the members' findings are merged (same defect once, every member's evidence, blockOn) before the debate.
  const council = ctx.council ? councilFindings(ctx, round, lenses, reviews, previousUpheld, used, all.lenses.filter((l, i) => all.reviews[i] === LATE).map((l) => lensInfo(ctx, l).member), carry) : null;
  if (council) {
    findings.push(...council.findings);
    failedLenses.push(...council.failedLenses);
  }
  reviews.forEach((review, i) => {
    const lens = lenses[i];
    if (council && lensInfo(ctx, lens).member) {
      if (review) coverage[lens] = { score: Number(review.score), summary: review.summary ?? '', coverage: Array.isArray(review.coverage) ? review.coverage : [], sideEffects: Array.isArray(review.sideEffects) ? review.sideEffects.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [] };
      return;
    }
    if (!review) {
      failedLenses.push(lens);
      return;
    }
    coverage[lens] = { score: Number(review.score), summary: review.summary ?? '', coverage: Array.isArray(review.coverage) ? review.coverage : [], sideEffects: Array.isArray(review.sideEffects) ? review.sideEffects.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [] };
    let n = 0;
    for (const raw of review.findings) {
      if (!raw || typeof raw !== 'object') continue;
      const reused = raw.id && earlierIds.has(String(raw.id)) && previousUpheld.find((f) => f.id === String(raw.id))?.lens === lens && !used.has(String(raw.id));
      let id = reused ? String(raw.id) : `${lensInfo(ctx, lens).code}-${round}-${++n}`;
      while (used.has(id)) id = `${lensInfo(ctx, lens).code}-${round}-${++n}`;
      used.add(id);
      findings.push(normalizeFinding(raw, lens, id));
    }
  });

  await debate(config, ctx, files, round, findings, lenses);
  const verdict = await judge(config, ctx, files, round, lenses, findings, coverage, failedLenses);
  if (!verdict) log(`round ${round}: the judge gave no ruling; every finding not withdrawn stands`);
  // Findings, rulings and coverage rows about the CI checks a CI fixing round is waiting on are the CI wait's to verify.
  const aboutCi = (x) => (ctx.ciFixIds ?? []).some((id) => new RegExp(`\\b${id}\\b`).test([x?.title, x?.detail, x?.requirement, x?.reason, x?.ref].filter(Boolean).join(' ')));
  const keptFindings = ctx.ciFixIds?.length ? findings.filter((f) => !aboutCi(f)) : findings;
  const keptRulings = ctx.ciFixIds?.length ? (verdict?.rulings ?? []).filter((r) => !aboutCi(r)) : verdict?.rulings ?? [];
  if (ctx.ciFixIds?.length) for (const c of Object.values(coverage)) c.coverage = (c.coverage ?? []).filter((row) => !aboutCi(row));
  const scored = scoreRound({ lenses, findings: keptFindings, rulings: keptRulings, judgeLensScores: verdict?.lensScores ?? {}, failedLenses, coverage, acceptanceLenses: acceptanceLensesOf(ctx) });
  if (council) councilOutcome(config, ctx, round, lenses, council, scored);
  // A carried-over lens keeps its last score (10, nothing upheld) without a critic run.
  for (const [lens, score] of Object.entries(carry)) scored.lensScores[lens] = score;
  if (Object.keys(carry).length) scored.score = Math.min(...Object.values(scored.lensScores));
  writeJson(files.rulingsAbs, { round, score: scored.score, lensScores: scored.lensScores, summary: verdict?.summary ?? '', upheld: scored.upheld, questions: scored.questions ?? [], rulings: verdict?.rulings ?? [] });
  return {
    round,
    files,
    lenses,
    failedLenses,
    findings,
    ...scored,
    ...(council ? { pass: scored.pass, councilError: council.merged.error ?? null } : {}),
    rulings: verdict?.rulings ?? [],
    summary: verdict?.summary ?? (failedLenses.length ? `critics failed: ${failedLenses.join(', ')}` : ''),
    diffHash: sha(ctx.diff.diff),
    // Behaviour the diff changes outside the ticket's lines, as the critics list it (council C7), and the shared test,
    // build and CI files it changes, from the diff itself (council C12: a critic missed one): the PR body lists both.
    sideEffects: [...new Set([...Object.values(coverage).flatMap((c) => c.sideEffects ?? []), ...infraSideEffects(diffStatus(ctx.workRoot, ctx.baseRev), { patterns: infraPatterns(config) })])],
  };
}

// prCheck.infraPaths (regular expressions) replace the default shared test, build and CI file patterns.
const infraPatterns = (config) => (Array.isArray(config.prCheck?.infraPaths) ? config.prCheck.infraPaths.map((p) => new RegExp(p)) : INFRA_PATTERNS);

// The finding details the lessons process (scripts/feature-verification/lib/lessons.mjs) learns from: upheld findings
// teach the implementer (round 1) or the fixer (a finding it failed to fix), dismissed ones teach the
// critic that raised them.
export function lessonFields(result, previousUpheld = []) {
  const clip = (v, n = 300) => (v ? String(v).slice(0, n) : '');
  const earlier = new Set(previousUpheld.map((f) => f.id));
  const rulings = new Map((result.rulings ?? []).filter((r) => r && r.id).map((r) => [String(r.id), r]));
  return {
    upheld: result.upheld.map((f) => ({
      id: f.id,
      lens: f.lens,
      severity: f.severity,
      title: clip(f.title, 200),
      detail: clip(f.detail),
      requirement: clip(f.requirement, 200),
      evidence: clip(f.evidence, 200),
      repeat: earlier.has(f.id),
    })),
    dismissed: result.findings
      .filter((f) => rulings.has(f.id) && rulings.get(f.id).ruling !== 'upheld')
      .map((f) => ({ id: f.id, lens: f.lens, severity: f.severity, title: clip(f.title, 200), reason: clip(rulings.get(f.id).reason) })),
  };
}

// Runs rounds until 10/10, the round limit, or a stall (the fixer changes nothing, or the same finding
// survives three rounds in a row). Without fixing, one round is the whole check. `onProgress` gets the
// loop state after each critique and each fix; passing it back as `resume` continues an interrupted
// check from there (a fix that was cut short runs again, unless it was already committed).
// `until` (a severity: 'blocking' or 'major') also ends a fixing loop as ACCEPTED once a round upholds nothing at
// or above it: the delivery fix mode fixes what matters before the PR opens and reports the rest.

export async function runPrCheck(config, ctx, { fix, resume = null, onProgress = () => {}, afterFix = null, afterNotes = null, until = null, fixLenses = [] }) {
  // A finding about an open ticket line is always fixed, whatever --until says (council C7).
  const mustFix = (f) => f.criterion || severityAtLeast(f.severity, until) || fixLenses.includes(f.lens);
  // A council (council.stages.prCheck) replaces the critics; see councilLenses.
  ctx.council = councilFor(config, 'prCheck');
  ctx.councilLenses = councilLenses(ctx.council);
  ctx.councilRuns = {};
  ctx.councilLate = lateBox();
  ctx.plansDir ??= config.plansDir;
  const { maxRounds } = config.prCheck;
  const history = resume?.history ?? [];
  let previousUpheld = resume?.previousUpheld ?? [];
  const streak = new Map(resume?.streak ?? []);
  let verdict = 'FAIL';
  let reason = '';
  const head = () => git(ctx.workRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  const save = (round, phase) => onProgress({ round, phase, history, previousUpheld, streak: [...streak], head: head() });

  // Fixes the round's upheld findings; returns why the loop must stop, if it must.
  const applyFix = async (entry, files, round) => {
    entry.fix = await fixRound(config, ctx, files, round, entry.upheld);
    log(`round ${round}: fixer ${entry.fix.commit ? `committed ${entry.fix.commit}` : 'changed nothing'}`);
    // The next round judges the fixed code with fresh evidence: feature verification verifies (and records
    // again) what the fix made stale, and the video frames are extracted again from those recordings.
    // Otherwise a video finding the fixer fixed is judged on frames from before the fix, round after round.
    if (entry.fix.commit && afterFix) await afterFix(entry);
    if (entry.fix.commit) return null;
    // A fix that only corrects the story's Implementation Notes (the fixer gives the text; the harness writes it) has no
    // commit but is progress: the next round reads the corrected story.
    if (entry.fix.notes?.length && afterNotes) {
      await afterNotes(entry);
      return null;
    }
    const humanNeeded = entry.fix.notFixed.length >= entry.upheld.length;
    const previousNoop = history.length > 1 && history[history.length - 2].fix && !history[history.length - 2].fix.commit;
    if (humanNeeded) return 'the fixer could not fix the upheld findings without a human decision';
    return previousNoop ? 'the fixer changed nothing two rounds in a row' : null;
  };

  let start = 1;
  if (resume) {
    start = resume.round + 1;
    log(`resuming at round ${resume.phase === 'fix' ? `${resume.round} (fix)` : start}`);
    if (resume.phase === 'fix') {
      const entry = history[history.length - 1];
      const now = head();
      if (now !== resume.head) entry.fix = { fixed: [], notFixed: [], summary: 'committed before the check was interrupted', commit: now };
      else {
        ctx.diff = prDiff(config, ctx);
        reason = (await applyFix(entry, roundFiles(ctx, resume.round, { clean: false }), resume.round)) ?? '';
      }
      if (reason) verdict = 'ESCALATED';
      // A CI finding (a red or retried check, seeded by the CI gate) is verified by the CI wait after the push, never by a
      // critic, who cannot see CI (council C8 proof: the check after a CI fix re-raised CI-1 and every CI fix escalated).
      previousUpheld = entry.upheld.filter((f) => !isCiFinding(f));
      ctx.ciFixIds = entry.upheld.filter(isCiFinding).map((f) => f.id);
      save(resume.round, 'done');
      // A fix round seeded from earlier findings (a report round, a CI gate's red or retried tests) is a check of its
      // own: recorded with the seed's score and what the fixer did, escalated or not (council C7: #120's escalated CI
      // fix round left no record, so the gate kept reading the last 10/10).
      if (resume.seeded) {
        appendJsonl(metricsFile(config, CHECKS_FILE), {
          ts: nowIso(),
          target: ctx.id,
          story: ctx.story.key,
          ...(ctx.multi ? { stories: ctx.tickets.map((t) => t.key), epic: ctx.epic?.key ?? null } : {}),
          round: resume.round,
          score: Number.isFinite(entry.score) ? entry.score : null,
          lensScores: entry.lensScores ?? {},
          raised: entry.upheld.length,
          withdrawn: 0,
          questions: [],
          seeded: true,
          upheld: entry.upheld.map(({ id, lens, severity, title }) => ({ id, lens, severity, title })),
          fix: { commit: entry.fix?.commit ?? null, fixed: entry.fix?.fixed ?? [], notFixed: (entry.fix?.notFixed ?? []).map((n) => ({ id: n.id, reason: String(n.reason ?? '').slice(0, 1000) })) },
          ...(reason ? { escalated: true, reason } : {}),
        });
      }
    }
  }
  for (let round = start; round <= maxRounds && !reason; round++) {
    // The check after a CI fixing round runs before CI re-runs on the fixed head: the video critic would judge recordings
    // made before the fix, and nobody can see the new CI result yet. The CI wait after the push re-records and checks
    // both (council C8 proof, #167: the check escalated on a stale video and an 'unverifiable' CI row).
    // With a council, the stage's own design and video critics carry over as they do without one (a fix that cannot have
    // changed what they judge), and so does a member whose last score passed and whose scope the fix did not touch
    // (carryOver); other members sit again.
    const own = { ...carryOver(ctx, history, git), ...(ctx.ciFixIds?.length && activeLenses(ctx).includes('video') ? { video: 10 } : {}) };
    const memberNames = new Set((ctx.council?.members ?? []).map((m) => m.name));
    const carry = ctx.council ? Object.fromEntries(Object.entries(own).filter(([lens]) => memberNames.has(lens) || (['design', 'video'].includes(lens) && !ctx.councilLenses[lens]))) : own;
    const result = await runRound(config, ctx, round, previousUpheld, { carry });
    const entry = { round, score: result.score, lensScores: result.lensScores, raised: result.findings.length, upheld: result.upheld, followUps: result.followUps ?? [], questions: result.questions ?? [], failedLenses: result.failedLenses, summary: result.summary, videoKey: ctx.videoKey ?? null, sideEffects: result.sideEffects ?? [] };
    history.push(entry);
    appendJsonl(metricsFile(config, CHECKS_FILE), {
      ts: nowIso(),
      target: ctx.id,
      story: ctx.story.key,
      ...(ctx.multi ? { stories: ctx.tickets.map((t) => t.key), epic: ctx.epic?.key ?? null } : {}),
      round,
      score: result.score,
      lensScores: result.lensScores,
      raised: result.findings.length,
      withdrawn: result.findings.filter((f) => f.status === 'withdrawn').length,
      questions: (result.questions ?? []).map((q) => ({ id: q.id, title: q.title, question: q.question })),
      ...lessonFields(result, previousUpheld),
    });
    log(`round ${round}: ${result.score}/10 (${Object.entries(result.lensScores).map(([l, s]) => `${l} ${s}`).join(', ')}); ${result.upheld.length} upheld of ${result.findings.length} raised`);

    // An owner question ends the check once nothing major is left to fix: the fixer cannot answer it.
    if ((result.questions ?? []).length && (!fix || !result.upheld.some((f) => f.severity !== 'minor'))) {
      verdict = 'QUESTION';
      reason = `needs an owner decision: ${result.questions.map((q) => `${q.id} ${q.title}`).join('; ')}`;
      break;
    }
    if (result.councilError) {
      verdict = 'ESCALATED';
      reason = `PR check council: ${result.councilError}`;
      break;
    }
    // With a council the council's pass decides (council.passScore, minor never blocks); otherwise 10/10.
    if (result.pass ?? result.score === 10) {
      verdict = 'PASS';
      break;
    }
    if (!fix) break;
    if (until && !result.upheld.some(mustFix)) {
      verdict = 'ACCEPTED';
      reason = `nothing ${until} or worse${fixLenses.length ? ` and nothing on ${fixLenses.join(', ')}` : ''} is upheld; ${result.upheld.length} lesser finding(s) reported`;
      break;
    }
    if (round === maxRounds) {
      verdict = 'ESCALATED';
      reason = ctx.council ? `the council did not pass after ${maxRounds} rounds` : `not 10/10 after ${maxRounds} rounds`;
      break;
    }
    for (const id of [...streak.keys()]) if (!result.upheld.some((f) => f.id === id)) streak.delete(id);
    for (const f of result.upheld) streak.set(f.id, (streak.get(f.id) ?? 0) + 1);
    const stuck = [...streak].filter(([, n]) => n >= 3).map(([id]) => id);
    if (stuck.length) {
      verdict = 'ESCALATED';
      reason = `findings upheld three rounds in a row: ${stuck.join(', ')}`;
      break;
    }
    if (result.upheld.length) {
      save(round, 'fix');
      reason = (await applyFix(entry, result.files, round)) ?? '';
      if (reason) verdict = 'ESCALATED';
    }
    previousUpheld = result.upheld;
    if (!reason) save(round, 'done');
  }
  if (verdict === 'ESCALATED') {
    const last = history[history.length - 1];
    escalate(config, { key: ctx.id }, 'pr-check', reason, last.upheld.map((f) => `- [${f.severity}] ${f.id} (${f.lens}) ${f.title}: ${f.fix}`).join('\n'));
  }
  // A non-blocking member that answered after the last round: its findings are not lost but become follow-ups of the
  // check (dogfood C14: such a result was simply unused).
  if (ctx.councilPending?.size) {
    const grace = Number(ctx.council?.lateGraceSec ?? 120) * 1000;
    await Promise.race([Promise.allSettled([...ctx.councilPending]), new Promise((r) => setTimeout(r, grace).unref?.())]);
  }
  const late = ctx.councilLate?.take?.() ?? [];
  if (late.length && history.length) {
    const last = history[history.length - 1];
    last.followUps = [...(last.followUps ?? []), ...late.flatMap((r) => (r.findings ?? []).map((f) => ({ id: f.id ?? null, lens: r.member?.name ?? null, title: String(f.text ?? f.title ?? '').split('\n')[0].slice(0, 200), reason: `late feedback from non-blocking council member ${r.member?.name}` })))];
  }
  return { verdict, reason, history };
}
