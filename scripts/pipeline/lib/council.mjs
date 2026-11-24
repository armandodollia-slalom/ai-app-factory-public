// Council verifiers: a verification stage seats several independent verifiers (members), each on its own CLI, model,
// reasoning effort and lens, instead of its single verifier, and the harness merges their results deterministically.
// Configuration and validation: council-config.mjs. The rules every member follows: skills/council/SKILL.md, which
// is injected into every member's prompt. See docs/ai-pipeline/council.md.
//
// A stage adapter (orchestrate.mjs, review.mjs, feature verification's verify.mjs, the PR check loop) gives runCouncil
// a `run` (one member's agent run) and a `parse` (the stage's own AGENT_RESULT contract, normalized), then turns the
// merged result back into the stage's own verdict shape. With no `council` section, or none for the stage, no adapter
// calls anything here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNCIL_LENSES, COUNCIL_STAGES, SOLE_LENS, STAGE_LENSES, canDriveBrowser, resolveIntercom } from './council-config.mjs';
import { agentEnv, entryFor, familyOf, poolOf, subtaskModels } from './pool.mjs';
import { recordRoundFindings } from './findings.mjs';
import { setting } from './settings.mjs';
import { logDecision } from './decisions.mjs';
import { metricsFile, readMetricsLocal } from './state.mjs';
import { appendJsonl, log as defaultLog, extractResult, nowIso, parseFrontMatter, readJson, run, sha, writeJson } from './util.mjs';
import { resolvesGiven, resolvesOf } from './finding-route.mjs';

export { COUNCIL_STAGES, COUNCIL_LENSES, SOLE_LENS, agentEnv };
export const COUNCIL_FILE = 'council-rounds.jsonl';
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SKILL_FILE = path.join(INSTALL_ROOT, 'skills', 'council', 'SKILL.md');

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const SEVERITY_RANK = { blocking: 0, major: 1, minor: 2 };
const ACTIONS = ['fix', 'delete-test', 'rewrite'];

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

// The member a stage seats when the council section seats none for it: the stage's own verifier, on the CLI and model
// its own settings give it (the stage runs it as it runs its verifier). It reviews everything (lens `all`).
// A council's sole member: the stage's own verifier, on its own agent's pool entry (`models.agents.<agent>`). The PR
// check's is its critic panel, each critic on its own entry.
export function soleMember(config = {}, stage = null) {
  const agent = COUNCIL_STAGES[stage]?.agent;
  let entry = null;
  if (agent && !agent.includes(' ')) {
    try {
      entry = entryFor(config, { name: agent });
    } catch {
      entry = null;
    }
  }
  return { name: 'verifier', entry: entry?.name ?? null, cli: entry?.cli ?? null, model: entry?.model ?? null, effort: entry?.effort ?? null, family: entry?.family ?? null, env: entry?.env ?? null, cmd: null, timeoutSec: null, lens: SOLE_LENS, blocking: true, sole: true };
}

// How many members a stage's council seats: the stage section's `councilMembers`, else `council.members`.
export function memberCount(config, stage) {
  const section = COUNCIL_STAGES[stage]?.section;
  return setting(config, `${section}.councilMembers`) ?? setting(config, 'council.members');
}

// The entries a council of `count` seats, before the stage's orchestrator picks (GEN-11): one entry per family in pool
// order first, then the other entries in pool order; entries repeat once every entry has a seat.
export function poolSeats(pool, count) {
  const order = [];
  const families = new Set();
  for (const e of pool) {
    if (families.has(familyOf(e))) continue;
    families.add(familyOf(e));
    order.push(e);
  }
  for (const e of pool) if (!order.includes(e)) order.push(e);
  return order.length ? Array.from({ length: count }, (_, i) => order[i % order.length]) : [];
}

// The lens of each seat: the stage's lenses in order (its core lens first), repeating; the `ui` lens goes to a seat whose
// CLI can drive a browser, else to nobody.
export function seatLenses(stage, entries) {
  const order = STAGE_LENSES[stage] ?? Object.keys(COUNCIL_LENSES);
  const lenses = entries.map((_, i) => order[i % order.length]);
  const ui = lenses.indexOf('ui');
  if (ui >= 0 && !canDriveBrowser(entries[ui])) {
    const j = entries.findIndex((e, k) => k !== ui && canDriveBrowser(e));
    if (j >= 0) [lenses[ui], lenses[j]] = [lenses[j], lenses[ui]];
    else return seatLensesWithout(order, 'ui', entries);
  }
  return lenses;
}
const seatLensesWithout = (order, lens, entries) => {
  const rest = order.filter((l) => l !== lens);
  return entries.map((_, i) => rest[i % rest.length]);
}

// Seat names unique across one sitting: an entry's first seat is its name, a repeated entry's later seats `<entry>-2`,
// `<entry>-3`, skipping any name already taken (an entry may itself be named `a-2`). runCouncil and the PR check's lens
// map key members by name, so two seats never share one. `taken` may hold names seated before (the sole `verifier`).
// Every entry's own name is kept for its first seat, so a repeat of `a` beside an entry named `a-2` is `a-3`, never
// `a-2`.
export function seatNames(entries, taken = []) {
  const used = new Set([...taken, ...entries]);
  const first = new Set();
  return entries.map((entry) => {
    if (!first.has(entry) && !taken.includes(entry)) {
      first.add(entry);
      return entry;
    }
    let name;
    for (let n = 2; used.has((name = `${entry}-${n}`)); n++);
    used.add(name);
    return name;
  });
}

// A seat resolved from its pool entry: { name, entry, cli, model, effort, family, env, cmd, timeoutSec, lens, blocking }.
// Names come from seatNames.
export function seatMembers(stage, entries) {
  const lenses = seatLenses(stage, entries);
  const names = seatNames(entries.map((e) => e.name));
  return entries.map((e, i) => {
    return { name: names[i], entry: e.name, cli: e.cli, model: e.model ?? null, effort: e.effort ?? null, family: familyOf(e), env: e.env ?? null, cmd: e.cli === 'custom' ? e.cmd : null, timeoutSec: e.timeoutSec ?? null, lens: lenses[i], blocking: true };
  });
}

// A stage's seats for one ticket, once chosen, are kept across its rounds and on resume:
// <stateDir>/council/seats/<stage>--<subject>.json, { members: [{ name, entry, lens, blocking }] }. Each seat runs on its
// pool entry; a kept pick that names an entry the pool no longer has is not used.
export const seatsFile = (config, stage, subject) => path.join(config.root, setting(config, 'stateDir'), 'council', 'seats', `${stage}--${String(subject).replace(/[^\w.-]/g, '_')}.json`);
export function savedSeats(config, stage, subject) {
  if (!subject || !config?.root) return null;
  const doc = readJson(seatsFile(config, stage, subject), null);
  if (!Array.isArray(doc?.members) || !doc.members.length) return null;
  const seat = (m) => {
    const e = poolOf(config).find((x) => x?.name === m.entry);
    return e && { name: m.name ?? e.name, entry: e.name, cli: e.cli, model: e.model ?? null, effort: e.effort ?? null, family: familyOf(e), env: e.env ?? null, cmd: e.cli === 'custom' ? e.cmd : null, timeoutSec: e.timeoutSec ?? null, lens: m.lens, blocking: m.blocking !== false, ...(m.exploration ? { exploration: true } : {}) };
  };
  // One seat kept: the stage's own verifier on the entry the orchestrator picked (still in the pool; else its agent's
  // own, and none for the PR check's critic panel, whose critics then run on their own), with its non-blocking shadow
  // member when one was seated (selection.mjs shadowEntry) and its entry is still in the pool.
  const shadow = doc.members.find((m) => m.shadow);
  if (doc.members.length === 1 || shadow) {
    const picked = doc.members.find((m) => !m.shadow)?.entry;
    const own = picked && seat({ entry: picked, lens: SOLE_LENS });
    const sole = own ? { ...soleMember(config, stage), ...own, name: 'verifier', lens: SOLE_LENS, blocking: true, sole: true } : soleMember(config, stage);
    const s = shadow && seat(shadow);
    return s ? [sole, { ...s, lens: SOLE_LENS, blocking: false, shadow: true }] : [sole];
  }
  const members = doc.members.map(seat);
  return members.every(Boolean) ? members : null;
}

// The council a stage seats: every verifier stage is a council. Its round limit and pass score are the stage section's
// (`<section>.maxCouncilRounds`, `<section>.councilPassScore`; COUNCIL_STAGES names the section), for any council size.
// Its size is memberCount; one seat is the stage's own verifier (soleMember), more are filled from `models.pool`
// (poolSeats, seatMembers). A council of one holds no discussion, has no quorum to apply, and fails its round when the
// member cannot run.
export function councilFor(config, stage, { subject = null } = {}) {
  const c = config?.council ?? {};
  const section = COUNCIL_STAGES[stage]?.section;
  if (!section) return null;
  const count = memberCount(config, stage);
  const kept = savedSeats(config, stage, subject);
  const seated = kept ?? (count > 1 ? seatMembers(stage, poolSeats(poolOf(config), count)) : []);
  const sole = seated.length < 2;
  // A kept single seat is the stage's own verifier on the entry the orchestrator picked (savedSeats).
  const members = sole ? (seated.length === 1 ? seated : [soleMember(config, stage)]) : seated;
  // One deciding member (alone, or beside a shadow): no discussion, no quorum, and a round fails when it cannot run.
  const alone = members.filter((m) => m.blocking).length < 2;
  const shadow = members.find((m) => m.shadow)?.name ?? null;
  const own = { councilIntercom: setting(config, `${section}.councilIntercom`) };
  return {
    stage,
    section,
    maxCouncilRounds: setting(config, `${section}.maxCouncilRounds`),
    councilPassScore: setting(config, `${section}.councilPassScore`),
    blockQuorum: setting(config, 'council.blockQuorum'),
    onUnavailable: alone ? 'fail' : setting(config, 'council.onUnavailable'),
    intercom: alone ? { ...resolveIntercom(c, own.councilIntercom), enabled: false } : resolveIntercom(c, own.councilIntercom),
    sole,
    // The shadow seat's member name (a non-blocking member beside a council of one), else null.
    shadow,
    members,
  };
}

// The round limit of a stage (`<section>.maxCouncilRounds`).
export const councilRounds = (config, stage) => councilFor(config, stage).maxCouncilRounds;

// The model and CLI line of a member, as the PR table and logs show it.
export const memberLabel = (m) => `${m.name} (${m.cli})`;

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

// The skill's text without its front matter (the engine reads it from the install; agents may not read the install).
export function skillText(file = SKILL_FILE) {
  try {
    return parseFrontMatter(fs.readFileSync(file, 'utf8')).body.trim();
  } catch {
    return '';
  }
}

// The skill's sections a sole member does without: the orchestrator's, the lens table and the discussion (it has no
// other members to look through a lens for, to work apart from or to talk to), and rule 5 (work alone).
const SOLE_LEFT_OUT = [/^# Council\n/, /^## Before the council sits/, /^## Seating/, /^## Lenses/, /^## Discussion/, /^## Merging results/, /^## Pull request/, /^## Council review/, /^## By hand/];
export function soleSkillText(skill) {
  const sections = String(skill ?? '').split(/^(?=## )/m);
  return sections
    .filter((sec) => !SOLE_LEFT_OUT.some((re) => re.test(sec)))
    // Rule 5 whole: its first line and every line after it up to a blank line or the next numbered rule.
    .map((sec) => sec.replace(/^5\. \*\*Work alone[^\n]*(?:\n(?!\n|\d+\. )[^\n]*)*\n?/m, '').trimEnd())
    .filter(Boolean)
    .join('\n\n');
}

// What a member's task adds to the stage's own task: who it is, its lens, the council's output fields, the disputes it
// rules on and the skill. The stage's own instructions and AGENT_RESULT contract stay as they are; the lens adds to them.
// A sole member (a council of one) gets the same rules without the parts that need other members: no seat list, no lens
// to look through first (it reviews everything), no non-blocking members, no discussion and no orchestrator sections.
// Beside a shadow seat, the sole member and the shadow both review everything; each is told the other works apart.
export function memberTask(task, { council, member, round, disputes = '', earlier = '', skill = skillText() }) {
  const everyLens = member.lens === SOLE_LENS;
  const sole = council.members.length === 1;
  const seat = council.members.map((m) => `${m.name} (${m.lens}${m.blocking ? '' : ', non-blocking'})`).join(', ');
  const every = 'the change through every lens (correctness, acceptance, security, test value, a simpler design)';
  const other = council.members.find((m) => m.name !== member.name)?.name;
  const who = sole
    ? `You are the council's only member: you review ${every}.`
    : everyLens && member.blocking
      ? `You are the council's only deciding member: you review ${every}. A non-blocking member, ${other}, reviews it apart from you; its findings are feedback only.`
      : everyLens
        ? `You are the council's non-blocking shadow member: you review ${every}, apart from its deciding member, ${other}.`
        : `You are one of ${council.members.length} council members who review this change independently: ${seat}. You are **${member.name}**; your lens is **${member.lens}**: ${COUNCIL_LENSES[member.lens]} Look through it first; report what you find outside it only when it is blocking.`;
  const pass = sole || (everyLens && member.blocking)
    ? `Council round ${round} of at most ${council.maxCouncilRounds}. The council passes when you score ${council.councilPassScore}/10 or more and no blocking finding stands.`
    : `Council round ${round} of at most ${council.maxCouncilRounds}. The council passes when every blocking member scores ${council.councilPassScore}/10 or more and no blocking finding stands.${member.blocking ? '' : ' You are non-blocking: your findings are feedback and your score is not recorded.'}`;
  const rules = sole || everyLens ? soleSkillText(skill) : skill;
  return [
    task,
    '',
    '## Council member',
    '',
    who,
    pass,
    '',
    // Rule 3 binds the change as much as the review (dogfood C14: a fix added a 9999 per-item quantity limit no line of
    // the ticket asked for, and nothing in the review was charged with noticing).
    'Whatever your lens, check the change itself for scope: behaviour the ticket does not ask for (a new limit, error, default, message, field or side effect; an existing behaviour changed or removed) is a blocking finding with `lens` "acceptance" and `kind` "scope", unless a line of the ticket or the subtask, or a finding the council upheld in an earlier round (listed below when there is one), requires it; name that behaviour, the file and line, and say that no ticket line asks for it. Code already on the base branch that the change does not touch is not the change.',
    ...(earlier ? ['', earlier] : []),
    '',
    'Keep the instructions and the `AGENT_RESULT` contract above exactly as they are. The council adds these fields to the same JSON object:',
    '',
    '- `score`: 0-10 for the change against the ticket, through your lens; one decimal place is allowed (for example 9.5). Leave it out only when you cannot score, and say why in `summary`.',
    '- on every finding: `lens`, `severity` (`blocking`, `major` or `minor`; major blocks like blocking where the contract above knows only blocking and minor), `action` (`fix`, `delete-test` or `rewrite`) and `evidence` (file and line, a command and its output, or a screenshot). Keep a finding\'s `id` whenever you raise it again.',
    '- on every finding: `resolves`, what would resolve it: `code` (the production change), `tests` (a missing automated test, or one to remove), `plan` (a test-plan case) or `records` (PR text, records, docs, video); `code and tests` for a finding that needs both. The harness sends it where that work is done: a test gap never goes to the implementer.',
    '- a `delete-test` finding (severity `major`) names the test in `test`, its file in `file`, and in `evidence` the bug that would still be caught without it.',
    '- a `rewrite` finding lists what to delete in `deletes` (files, or `file:start-end` regions the branch added or changed), the new approach in `approach` (five lines or fewer), `why` it is better for this ticket, and the acceptance lines it `covers`.',
    '- `followUps`: `[{"title": "...", "reason": "..."}]` for real problems outside the ticket; they are not findings.',
    ...(disputes ? ['', '### Implementer disputes of findings you raised', '', 'The implementer did not act on these and says why. Rule on each in `disputes: [{"finding": "<id>", "decision": "accepted" | "reasserted", "evidence": "<why>"}]`; re-raise a finding (same id) only with new evidence that the ticket requires it.', '', disputes] : []),
    ...(rules ? ['', '### The council skill (the rules every member follows)', '', rules.replace(/^#{1,2} /gm, (h) => `#${h}`)] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Member results
// ---------------------------------------------------------------------------------------------

function whereOf(f) {
  const raw = str(f.file) || str(f.where) || str(f.location);
  const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(raw);
  const file = (m ? m[1] : raw).replace(/\\/g, '/').replace(/^\.\//, '');
  const line = Number.isFinite(Number(f.line)) && f.line !== null && f.line !== '' ? Number(f.line) : m ? Number(m[2]) : null;
  return { file: file || null, line };
}

// One finding of one member, in the council's terms. The stage's own fields stay on it.
export function normalizeFinding(f, member) {
  const { file, line } = whereOf(f ?? {});
  return {
    ...f,
    lens: str(f?.lens) || member.lens,
    severity: Object.hasOwn(SEVERITY_RANK, f?.severity) ? f.severity : 'blocking',
    action: ACTIONS.includes(f?.action) ? f.action : 'fix',
    text: str(f?.issue) || str(f?.title) || str(f?.detail),
    evidence: str(f?.evidence),
    file,
    line,
    member: member.name,
  };
}

// A score from 0 to 10, or null (the member gave none).
// A member's score as given: a number (or numeric text) from 0 to 10, to one decimal place. Anything else (missing,
// empty, not a number, out of range) is no score, which never passes: never read as 0 or as the cap.
// A stage's verifier time limit: a council member runs this long unless its pool entry sets its own (`timeoutSec`).
export function stageTimeoutSec(config, stage) {
  if (stage === 'pairVerify' || stage === 'pairUiVerify') return setting(config, 'implement.timeoutsSec.pairVerifier');
  if (stage === 'architectureReview') return setting(config, 'architectureReview.timeoutSec');
  if (stage === 'testPlan' || stage === 'testAutomation') return setting(config, 'featureVerification.timeoutsSec.verifier');
  return setting(config, 'prCheck.timeoutSec');
}

export function memberScore(raw) {
  const v = raw?.score;
  const n = Number(v);
  if (!((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(n) && n >= 0 && n <= 10)) return null;
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------------------------

const UNAVAILABLE = /\b(command not found|not found: (claude|codex|copilot)|ENOENT|not logged in|please (log|sign) ?in|authenticat(e|ion) (required|failed)|unauthori[sz]ed|model .* (not available|not found|does not exist|is not supported))\b/i;

// Why a member could not serve, or null: a provider outage (outage.mjs), a CLI that is not installed or not signed in.
export function unavailableReason(res) {
  if (!res) return null;
  if (res.outage) return `provider unavailable: ${res.outage}`;
  if (res.status === 127) return 'the CLI is not installed (exit 127)';
  if (res.status !== 0 && !res.timedOut && UNAVAILABLE.test(String(res.output ?? '').slice(0, 2000))) return String(res.output).split('\n').find((l) => UNAVAILABLE.test(l))?.trim().slice(0, 300) ?? 'unavailable';
  return null;
}

// A fingerprint of a checkout's working tree (tracked changes, and untracked files with their contents: a member that
// rewrites a file that was already untracked changes it too), without the folders the harness itself writes to while
// members run (metrics, state, prompts).
export function treeFingerprint(cwd, exclude = []) {
  const specs = ['.', ...exclude.filter(Boolean).map((e) => `:(exclude)${e}`)];
  const status = run('git', ['status', '--porcelain=v1', '-uall', '--', ...specs], { cwd });
  if (status.status !== 0) return null;
  const diff = run('git', ['diff', 'HEAD', '--', ...specs], { cwd });
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs], { cwd }).stdout.split('\0').filter(Boolean);
  const contents = untracked.map((f) => {
    try {
      const abs = path.join(cwd, f);
      return `${f}\0${sha(fs.lstatSync(abs).isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs), 16)}`;
    } catch {
      return `${f}\0unreadable`;
    }
  });
  return sha(`${status.stdout}\n${diff.stdout}\n${contents.join('\n')}`, 16);
}

// Seats the council: every member runs at once through `run(member, task, { signal })` (the stage's own agent call,
// which owns the semaphore, the budget and the CLI). `parse(output, member)` reads the stage's contract and returns
// { score, verdict, summary, findings, disputes, followUps } or null. A blocking member is waited for; a non-blocking
// member is not: when the last blocking member has answered, a non-blocking one still running is left to finish in the
// background and its result goes to `onLate` (the caller hands it on as feedback; its score is never recorded).
// `readOnly` (a checkout and the folders to ignore) fails the round when any member changed the working tree: every
// CLI's read-only mode is enforced by the CLI, and this catches what got past it (a custom command).
export async function runCouncil({ council, run: runMember, parse, taskFor, retries = 0, onLate = null, readOnly = null, round = 1, waitAll = Boolean(council?.intercom?.enabled && round === 1), log = defaultLog }) {
  const before = readOnly ? treeFingerprint(readOnly.cwd, readOnly.exclude) : null;
  const attempt = async (m) => {
    const t0 = Date.now();
    const base = { member: m, seconds: 0 };
    let res = null;
    let tries = 0;
    for (let i = 0; i <= retries; i++) {
      tries = i + 1;
      try {
        res = await runMember(m, taskFor(m));
      } catch (error) {
        if (error?.councilFatal || error?.outcome) throw error;
        return { ...base, attempts: Math.max(tries, 1), status: 'failed', reason: error.message, seconds: Math.round((Date.now() - t0) / 1000) };
      }
      // A later round already took this member's result as feedback (its result file is gone): that is its answer,
      // never a reason to run it again (dogfood C15: the retry ran the member a second time and left its result twice).
      if (res?.consumed) return { ...base, attempts: Math.max(tries, 1), status: 'consumed', reason: 'a later round took its result as feedback', res, seconds: Math.round((Date.now() - t0) / 1000) };
      const why = unavailableReason(res);
      if (why) return { ...base, attempts: Math.max(tries, 1), status: 'unavailable', reason: why, res, seconds: Math.round((Date.now() - t0) / 1000) };
      const parsed = res?.factoryGuard ? null : parse(res?.output ?? '', m);
      if (parsed) {
        // The member's result as written, for the intercom room's seed (only when a discussion can follow).
        const raw = council.intercom?.enabled ? { rawResult: extractResult(res?.output ?? '') } : {};
        const filled = await fillResolves(parsed.findings ?? [], { member: m, run: runMember, stage: council.stage, log });
        return { ...base, attempts: Math.max(tries, 1), status: 'ok', ...parsed, ...raw, findings: filled.findings.map((f) => normalizeFinding(f, m)), ...(filled.reasked ? { resolvesReasked: filled.reasked } : {}), res, seconds: Math.round((Date.now() - t0) / 1000) };
      }
      log(`council ${council.stage}: ${m.name} returned no parsable result (attempt ${i + 1})`);
    }
    return { ...base, attempts: Math.max(tries, 1), status: 'failed', reason: 'no parsable result', res, seconds: Math.round((Date.now() - t0) / 1000) };
  };
  const promises = new Map(council.members.map((m) => [m.name, attempt(m)]));
  const settled = new Map();
  for (const [name, p] of promises) p.then((r) => settled.set(name, r), (e) => settled.set(name, { member: council.members.find((m) => m.name === name), status: 'failed', reason: e?.message ?? String(e) }));
  const waited = waitAll ? council.members : council.members.filter((m) => m.blocking);
  await Promise.all(waited.map((m) => promises.get(m.name)));
  await new Promise((resolve) => setImmediate(resolve));
  const results = [];
  for (const m of council.members) {
    if (settled.has(m.name)) results.push(settled.get(m.name));
    else {
      results.push({ member: m, status: 'late', reason: 'still running when the blocking members had answered; not waited for' });
      promises.get(m.name).then((r) => onLate?.(r), () => {});
    }
  }
  if (readOnly && before) {
    const after = treeFingerprint(readOnly.cwd, readOnly.exclude);
    if (after && after !== before) {
      log(`council ${council.stage}: the working tree changed while the read-only members ran; their results are discarded`);
      return { results, violation: 'a council member changed the working tree; members are read-only, so this round has no result' };
    }
  }
  return { results };
}

// Every member fills `resolves` on every finding (what would resolve it; finding-route.mjs routes by it). A result with
// findings that lack it is rejected and the member is asked once, with a short classification-only task, to name it for
// those findings; what is still missing after that is inferred from the finding (its words, action and files) and
// marked `resolvesInferred`, so the records say which values a member gave and which the harness guessed.
const keyOf = (f, i) => String(f?.id ?? f?.case ?? `F${i + 1}`);
export async function fillResolves(findings, { member, run: runMember, stage = '', log = defaultLog }) {
  const missing = findings.map((f, i) => [f, i]).filter(([f]) => !resolvesGiven(f).length);
  if (!missing.length) return { findings, reasked: null };
  log(`council ${stage}: ${member.name} left \`resolves\` out on ${missing.length} finding(s); asking once`);
  const task = [
    `Your result was rejected: ${missing.length} finding(s) have no \`resolves\` field. Do not review again and do not read files: classify only.`,
    'For each finding below, name what would resolve it: `code` (the production change), `tests` (a missing automated test, or one to remove), `plan` (a test-plan case), `records` (PR text, records, docs, video), or `code and tests` for a finding that needs both.',
    '',
    ...missing.map(([f, i]) => `- ${keyOf(f, i)}: ${String(f.issue ?? f.title ?? f.text ?? f.detail ?? f.reason ?? '').slice(0, 400)}${f.fix ? ` (fix: ${String(f.fix).slice(0, 300)})` : ''}${f.file ? ` [${f.file}]` : ''}`),
    '',
    'End with one line: AGENT_RESULT: {"resolves": {"<id>": "<value>", ...}}',
  ].join('\n');
  let answer = {};
  try {
    const res = await runMember(member, task, { purpose: 'resolves' });
    const r = extractResult(res?.output ?? '');
    if (r && typeof r.resolves === 'object' && r.resolves) answer = r.resolves;
  } catch (error) {
    if (error?.councilFatal || error?.outcome) throw error;
  }
  let given = 0;
  const out = findings.map((f, i) => {
    if (resolvesGiven(f).length) return f;
    const a = answer[keyOf(f, i)];
    if (a && resolvesGiven({ resolves: a }).length) {
      given++;
      return { ...f, resolves: a, resolvesAsked: true };
    }
    return { ...f, resolves: resolvesOf(f), resolvesInferred: true };
  });
  if (given < missing.length) log(`council ${stage}: ${member.name} still left \`resolves\` out on ${missing.length - given} finding(s); inferred and marked`);
  return { findings: out, reasked: { missing: missing.length, given, inferred: missing.length - given } };
}

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

const STOP = new Set('the and for with that this from are was not but can its has have when then given into than any all each only must should will does test tests'.split(' '));
const words = (t) => new Set((String(t ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
// Words close enough that two findings say the same thing (no line or file needed).
const similarText = (a, b) => similar(a, b, 0.6);
function similar(a, b, min) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= min;
}
const testKey = (f) => str(f.test).toLowerCase().replace(/\s+/g, ' ');

// A region a rewrite deletes: { file, from, to } (from/to null for the whole file).
export function parseRegion(r) {
  const s = str(typeof r === 'object' ? r?.file ?? r?.path : r).replace(/\\/g, '/').replace(/^\.\//, '');
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(s);
  if (m) return { file: m[1], from: Number(m[2]), to: Number(m[3] ?? m[2]) };
  return s ? { file: s, from: null, to: null } : null;
}
const regionsOf = (f) => (Array.isArray(f.deletes) ? f.deletes : f.deletes ? [f.deletes] : []).map(parseRegion).filter(Boolean);
const covers = (region, f) => {
  if (!f.file) return false;
  const inFile = region.file.endsWith('/') ? f.file.startsWith(region.file) : f.file === region.file || f.file.startsWith(`${region.file}/`);
  if (!inFile) return false;
  if (region.from == null || f.line == null) return true;
  return f.line >= region.from && f.line <= region.to;
};
const overlap = (a, b) => regionsOf(a).some((r) => regionsOf(b).some((s) => r.file === s.file && (r.from == null || s.from == null || (r.from <= s.to && s.from <= r.to))));

// Whether two findings of different members name the same defect.
export function sameDefect(a, b) {
  if (a.member === b.member) return false;
  if (str(a.id) && str(a.id) === str(b.id)) return true;
  if (testKey(a) || testKey(b)) return Boolean(testKey(a)) && testKey(a) === testKey(b);
  if (a.action === 'rewrite' || b.action === 'rewrite') return a.action === b.action && overlap(a, b);
  // A test verifier's gaps name a plan case and a category: the same pair is the same gap.
  if (str(a.case) && str(a.case) === str(b.case) && str(a.category) && a.category === b.category) return true;
  if (a.file || b.file) {
    if (a.file !== b.file) return false;
    if (a.line != null && b.line != null) return Math.abs(a.line - b.line) <= 3 || similar(a.text, b.text, 0.6);
    return similar(a.text, b.text, 0.5);
  }
  return similar(a.text, b.text, 0.6);
}

const needed = (blockQuorum, n) => (blockQuorum === 'all' ? n : blockQuorum === 'majority' ? Math.floor(n / 2) + 1 : 1);

// Merges the members' results into one council result. Deterministic: findings are clustered in member order;
// `protect(finding)` (the stage's test protections) returns why a delete-test finding may not be acted on, or null.
// Returns {
//   pass, error, score (lowest blocking member score), members (per-member status and score),
//   findings (merged findings that stand: severity blocking/major; each with `members` and every member's `evidence`),
//   notes (minor findings, findings blockQuorum did not uphold, protected and superseded ones, non-blocking feedback),
//   contradictions, rewrites, disputes (merged rulings), followUps, summary }
// The lines a change added or changed, per file, from `git diff -U0 <base>` (pass it to mergeCouncil as `changed`).
// changedLines of what a checkout changed since `base` (committed and uncommitted); null when git cannot say.
export function changedSince(cwd, base, gitRun) {
  if (!base) return null;
  const r = gitRun(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', base]);
  return r.status === 0 ? changedLines(r.stdout) : null;
}

export function changedLines(diffText) {
  const files = new Map();
  let cur = null;
  for (const line of String(diffText ?? '').split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      cur = f[1];
      if (!files.has(cur)) files.set(cur, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < n; i++) files.get(cur).add(start + i);
    }
  }
  return { files };
}

const NEAR = 3;
const relPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^.*?(?:-worktrees\/[^/]+\/|\/scratchpad\/[^/]+\/)/, '').replace(/^\.\//, '');
const touchesChange = (changed, file, line) => {
  const set = changed.files.get(relPath(file));
  if (!set) return false;
  for (let d = -NEAR; d <= NEAR; d++) if (set.has(line + d)) return true;
  return false;
};
// Whether a merged finding is about code the change did not touch (see rule 3 in mergeCouncil).
export function outsideChange(f, changed) {
  if (!changed?.files?.size || f.lens === 'acceptance' || !f.file || !Number.isFinite(f.line)) return false;
  const file = relPath(f.file);
  if (!changed.files.has(file)) return false;
  if (touchesChange(changed, file, f.line)) return false;
  const cited = [f.evidence, f.text, ...(f.memberEvidence ?? []).map((e) => e.evidence)].join(' ');
  for (const m of cited.matchAll(/([\w./\\-]+\.[A-Za-z0-9]+):(\d+)/g)) if (touchesChange(changed, m[1], Number(m[2]))) return false;
  return true;
}

// Rule 4 of the skill, "evidence or nothing", as the harness applies it: a finding stands only with a file and line,
// a command and its output (the `evidence` text, or an output file that shows a finished run), or a screenshot (an image
// that exists). A harness finding (a tool's) carries its own. Without any, it is a question: it never blocks and never
// starts a fix cycle (dogfood C19: "no passing result could be established", citing only a test run the member itself
// cancelled, cost an implementer run and a UI council sitting).
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const ABORTED = /\b(cancel(?:l?ed|ing|s)?|timed out|time-?out|aborted|terminated|killed|interrupted)\b/i;
const EMPTY_EVIDENCE = /^(none|n\/?a|-+|tbd|unknown|not available|no evidence)\.?$/i;
export function hasEvidence(f, root = null) {
  if (f?.harness || String(f?.source ?? '').startsWith('tool:')) return true;
  if (str(f?.file) && Number.isFinite(f?.line) && f.line > 0) return true;
  // The stage's own locators: a region a rewrite deletes (file and lines), a test case of the plan, a named test in a file.
  if (regionsOf(f).some((r) => r.file && (r.from != null || /\/$/.test(r.file)))) return true;
  if (/\bTC-[A-Za-z][A-Za-z0-9]*-\d+-\d+\b/i.test(str(f?.case))) return true;
  if (str(f?.test) && str(f?.file)) return true;
  const text = [str(f?.evidence), str(f?.output), str(f?.commandOutput)].filter((t) => t && !EMPTY_EVIDENCE.test(t));
  if (text.some((t) => t.length >= 12)) return true;
  const shots = [f?.screenshot, ...(Array.isArray(f?.screenshots) ? f.screenshots : [])].map(str).filter(Boolean);
  for (const s of shots) {
    const abs = path.isAbsolute(s) ? s : path.resolve(root ?? process.cwd(), s);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || !st.size) continue;
      if (IMAGE.test(abs)) return true;
      const out = fs.readFileSync(abs, 'utf8').slice(0, 65536);
      if (out.trim() && !ABORTED.test(out)) return true;
    } catch {
      /* a path that does not exist proves nothing */
    }
  }
  return false;
}

// `intercom` is a discussion's result (intercom.mjs). A finding it disposed of (by its `<seat>:<n>` key, `intercomId`) is
// taken out before clustering: dropped, noted or withdrawn, held for the owner, or awaiting a ruling. It never joins a
// cluster, blockQuorum or a severity; it stays as a note with its `disposition`, and still explains its member's low score.
// The earlier disposition wins (a vote, then a later withdrawal: the vote). Revised scores replace round-1 scores. A
// discussion with a read-only violation fails the council.
export function mergeCouncil(council, results, { protect = null, feedback = [], violation = null, changed = null, earlier = null, root = null, adjudications = null, intercom = null } = {}) {
  const ic = intercom?.violation ? null : intercom;
  const fate = new Map(); // intercomId -> disposition { kind, why, question? }
  const dispose = (id, d) => fate.has(id) || fate.set(id, d);
  for (const d of ic?.settledDisputes ?? []) if (d.againstFinding && !d.withdrawn) dispose(d.findingId, { kind: d.outcome, why: `the council discussion settled ${d.outcome} (${d.kind}; votes: ${(d.tally ?? []).map((t) => `${t.effect} ${t.count}`).join(', ')})` });
  for (const r of ic?.rulings ?? []) if (r.againstFinding) dispose(r.findingId, { kind: r.ruling, why: `ruled ${r.ruling} on a council split: ${r.reason}` });
  for (const w of ic?.withdrawn ?? []) dispose(w.findingId, { kind: 'withdrawn', why: `withdrawn by its author (${w.by}) in the council discussion` });
  for (const q of ic?.ownerQuestions ?? []) dispose(q.findingId, { kind: 'owner', why: `pending the owner's decision: ${q.question} (${q.reason})`, question: q });
  for (const e of ic?.awaitingRuling ?? []) dispose(e.findingId, { kind: 'awaiting-ruling', why: `awaiting a ruling on ${e.disputeId}` });
  if (Object.keys(ic?.scoreChanges ?? {}).length) results = results.map((r) => (r.status === 'ok' && ic.scoreChanges[r.member.name] ? { ...r, ...ic.scoreChanges[r.member.name] } : r));
  const ok = results.filter((r) => r.status === 'ok');
  const okBlocking = ok.filter((r) => r.member.blocking);
  const unavailable = results.filter((r) => r.status === 'unavailable');
  const failed = results.filter((r) => r.status === 'failed' && r.member.blocking);
  const members = results.map((r) => ({
    name: r.member.name,
    cli: r.member.cli,
    model: r.member.model ?? null,
    effort: r.member.effort ?? null,
    lens: r.member.lens,
    login: memberLogin(r.member),
    blocking: r.member.blocking,
    status: r.status,
    // A non-blocking member's score is never recorded.
    score: r.status === 'ok' && r.member.blocking ? r.score ?? null : null,
    verdict: r.status === 'ok' ? r.verdict ?? null : null,
    findings: r.status === 'ok' ? r.findings.length : 0,
    seconds: r.seconds ?? null,
    // Executions of this member in this sitting (a retry after an unparsable answer is a second execution, not a second
    // sitting; council C10, Sol 3).
    attempts: r.attempts ?? 1,
    ...(r.reason ? { reason: String(r.reason).slice(0, 300) } : {}),
  }));
  let error = violation || intercom?.violation || null;
  if (!error && unavailable.some((r) => r.member.blocking) && council.onUnavailable === 'fail') {
    error = `council member(s) unavailable: ${unavailable.filter((r) => r.member.blocking).map((r) => `${r.member.name} (${r.member.cli}): ${r.reason}`).join('; ')} (council.onUnavailable is fail; no other model is substituted)`;
  }
  if (!error && !okBlocking.length) error = `no blocking council member gave a result (${results.filter((r) => r.member.blocking).map((r) => `${r.member.name}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join('; ')})`;
  const base = { members, unavailable: unavailable.map((r) => ({ name: r.member.name, cli: r.member.cli, reason: r.reason })), blockQuorum: council.blockQuorum, passScore: council.councilPassScore };
  if (error) return { ...base, pass: false, error, score: null, findings: [], notes: [], contradictions: [], rewrites: [], disputes: [], followUps: [], summary: error };

  // Cluster same-defect findings across members: the blocking members' first, then the non-blocking members'. A
  // non-blocking member's finding is feedback unless a blocking member raised the same, so it joins a blocking cluster
  // only on evidence that it is the same defect (the same id, or similar words), never on nearby lines alone: two
  // different defects on one line would otherwise merge, and the feedback finding would be credited with the blocking
  // one (and lend it its text).
  const clusters = [];
  const disposed = [];
  const blockingFirst = [...ok.filter((r) => r.member.blocking), ...ok.filter((r) => !r.member.blocking)];
  const blockingNames0 = new Set(ok.filter((r) => r.member.blocking).map((r) => r.member.name));
  const sameAsBlocking = (y, f) => (blockingNames0.has(y.member) && !blockingNames0.has(f.member) ? Boolean(str(y.id) && str(y.id) === str(f.id)) || similarText(y.text, f.text) : sameDefect(y, f));
  for (const r of blockingFirst) {
    for (const f of r.findings) {
      if (fate.has(f.intercomId)) {
        disposed.push(f);
        continue;
      }
      const c = clusters.find((x) => x.items.some((y) => sameAsBlocking(y, f)) && !x.items.some((y) => y.member === f.member));
      if (c) c.items.push(f);
      else clusters.push({ items: [f] });
    }
  }
  const threshold = needed(council.blockQuorum, okBlocking.length);
  const blockingNames = new Set(okBlocking.map((r) => r.member.name));
  const merged = clusters.map((c) => {
    // The deciding (blocking) members' items alone decide the finding: its id, its evidence, whether it has any (rule 4)
    // and so its severity. A non-blocking member's corroboration is kept in memberEvidence for the record, never as
    // evidence (council r4, sol-11: a shadow's evidence turned the deciding member's evidence-less finding into a
    // standing one).
    const deciding = c.items.filter((f) => blockingNames.has(f.member));
    const basis = deciding.length ? deciding : c.items;
    const first = basis[0];
    const raisers = [...new Set(c.items.map((f) => f.member))];
    const backing = [...new Set(c.items.filter((f) => blockingNames.has(f.member) && f.severity !== 'minor').map((f) => f.member))];
    const worst = c.items.filter((f) => blockingNames.has(f.member)).map((f) => f.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? 'minor';
    const actions = [...new Set(basis.map((f) => f.action))];
    const upheld = worst !== 'minor' && backing.length >= threshold;
    const out = {
      ...first,
      id: basis.map((f) => str(f.id)).find(Boolean) || undefined,
      severity: upheld ? worst : 'minor',
      members: raisers,
      upheldBy: upheld ? backing : [],
      evidence: basis.map((f) => (f.evidence ? `${f.member}: ${f.evidence}` : '')).filter(Boolean).join('\n') || first.evidence,
      memberEvidence: c.items.map((f) => ({ member: f.member, evidence: f.evidence, text: f.text, action: f.action, severity: f.severity, file: f.file ?? null, line: f.line ?? null, ...(str(f.kind) ? { kind: str(f.kind) } : {}) })),
    };
    if (!upheld && worst !== 'minor') out.notUpheld = `raised by ${backing.join(', ')}; council.blockQuorum "${council.blockQuorum}" needs ${threshold} blocking member(s)`;
    // Raised by non-blocking members only (the shadow seat): feedback, in every stage. It never enters a verdict, a
    // severity raise (raiseUserErrors) or a PR check debate and ruling; it is recorded, and reaches a producer as a note.
    if (!c.items.some((f) => blockingNames0.has(f.member))) {
      out.feedback = true;
      delete out.notUpheld;
    }
    // Rule 4: no member of the cluster gave evidence. A question for the record, never a fix cycle.
    if (out.severity !== 'minor' && !basis.some((f) => hasEvidence(f, root))) {
      out.severity = 'minor';
      out.upheldBy = [];
      out.notUpheld = 'evidence or nothing (rule 4): no file and line, command output or screenshot backs it; it is a question, not a blocking finding';
      out.noEvidence = true;
    }
    // Rule 3 (and rule 1: base code the change does not touch is outside the ticket), applied by the harness: a finding
    // on a line of a changed file that the change did not touch, whose evidence names no line the change made, is a note
    // and a follow-up, not a blocking finding (dogfood C14 TYPE-1: format errors on main's lines of a touched file cost
    // two pair rounds before a dispute settled them). Acceptance findings are left to the members: an unmet line can
    // point anywhere.
    if (out.severity !== 'minor' && outsideChange(out, changed)) {
      out.severity = 'minor';
      out.upheldBy = [];
      out.notUpheld = `rule 3: ${out.file}:${out.line} is a line the change did not touch; a problem in code already on the base branch is a follow-up`;
      out.outsideChange = true;
    }
    // A blocking finding that asks for no change can never be resolved: it is a note (dogfood C16 held-out: "fix: none
    // required; keep it" stood as the only blocking finding of a review round and the story ended unresolved).
    // It must not hide a request: every blocking item of the cluster asks for no change (a second member asking for one
    // keeps it), nothing after the "none" asks for a change, and a scope objection is a request to take the behaviour
    // out whatever its fix says (it gets a concrete instruction instead; council C12, Sol 1).
    const blockingItems = c.items.filter((f) => blockingNames.has(f.member) && f.severity !== 'minor');
    const ownFix = fixOf(out);
    const scope = (blockingItems.length ? blockingItems : [out]).every(isScopeObjection);
    if (out.severity !== 'minor' && scope && (!fixOf(out) || asksNoChange(out))) {
      out.fix = `Take out the behaviour at ${out.file ?? 'the place the finding names'}${out.line ? `:${out.line}` : ''} that no ticket line asks for, or dispute the finding by quoting the ticket line that asks for it.`;
    }
    if (out.severity !== 'minor' && !scope && out.action === 'fix' && (blockingItems.length ? blockingItems : [out]).every((f) => (f.action ?? 'fix') === 'fix' && asksNoChange(f))) {
      out.severity = 'minor';
      out.upheldBy = [];
      out.notUpheld = `the finding asks for no change ("${fixOf(out).slice(0, 120)}"); a blocking finding must name a change`;
      out.noChange = true;
    }
    // A later round objects to the fix of a finding the council upheld in an earlier round (a scope objection on lines
    // the fixer declared, and the harness sealed, for that one finding). The harness never decides by itself that the
    // remedy required the behaviour (council C11 and C12, Sol 1: a declaration proves authorship, not necessity): the
    // objection stands and is a candidate for adjudication. Only when every blocking member, asked fresh whether the
    // agreed remedy requires this behaviour, answers yes with evidence (`adjudications`, from adjudicate()) is it a
    // note crediting that finding. Otherwise it stands with a concrete instruction: take out what the adjudication did
    // not accept, keep what carries out the earlier finding's agreed fix.
    const sanction = out.severity !== 'minor' ? sanctionedBy(out, earlier) : null;
    if (sanction) {
      const [u] = sanction;
      const key = adjudicationKey(out, u);
      const ruled = adjudications && Object.hasOwn(adjudications, key) ? adjudicationOutcome(council, adjudications[key]) : null;
      const record = ruled && { key, earlier: u.id, earlierText: str(u.text).slice(0, 300), earlierFix: fixOf(u).slice(0, 300), file: out.file, line: out.line ?? null, outcome: ruled.accepted ? 'covered' : 'stands', acceptedBy: ruled.yes, rejectedBy: ruled.no, missing: ruled.missing, ambiguous: ruled.ambiguous, answers: ruled.answers };
      if (ruled?.accepted) {
        out.severity = 'minor';
        out.upheldBy = [];
        out.sanctionedBy = [u.id];
        out.adjudication = record;
        out.notUpheld = `every blocking member (${ruled.yes.join(', ')}) accepted, on adjudication, that the agreed fix of ${u.id} (upheld in round ${u.round}${fixOf(u) ? `: ${fixOf(u).slice(0, 160)}` : ''}) requires this behaviour; a change an upheld finding requires is in scope`;
      } else if (ruled) {
        out.adjudication = record;
        const why = [ruled.no.length ? `${ruled.no.join(', ')} said no` : '', ruled.missing.length ? `no answer from ${ruled.missing.join(', ')}` : '', ruled.ambiguous.length ? `no clear yes with evidence from ${ruled.ambiguous.join(', ')}` : ''].filter(Boolean).join('; ');
        const asked = !ownFix || asksNoChange({ fix: ownFix }) ? '' : ` (${ownFix.slice(0, 200)})`;
        out.fix = `The council's adjudication did not accept that ${u.id}'s agreed fix requires the behaviour at ${out.file}:${out.line} (${why}). Take out that behaviour${asked}, and keep the change that carries out ${u.id}'s agreed fix: ${fixOf(u).slice(0, 300) || str(u.text).slice(0, 300)}.`;
      } else {
        out.adjudicate = { key, finding: { id: u.id, text: str(u.text), fix: fixOf(u), file: u.file ?? null, line: u.line ?? null, round: u.round, stage: u.stage ?? null, step: u.step ?? null }, declared: u.declared ?? null };
      }
    }
    // Two members ask opposite things of the same test: neither position is picked silently.
    if (actions.includes('delete-test') && actions.includes('fix')) {
      out.contested = basis.map((f) => ({ member: f.member, action: f.action, evidence: f.evidence || f.text }));
    }
    return out;
  });
  // The discussion's dispositions, each its own note for the record: never a fix, never promoted downstream.
  for (const f of disposed) {
    const d = fate.get(f.intercomId);
    merged.push({ ...f, severity: 'minor', members: [f.member], upheldBy: [], notUpheld: d.why, disposition: d.kind, memberEvidence: [{ member: f.member, evidence: f.evidence, text: f.text, action: f.action, severity: f.severity, file: f.file ?? null, line: f.line ?? null }], ...(d.question ? { pendingOwner: true, ownerQuestion: d.question } : {}) });
  }

  // Delete-test protections (harness-enforced): a test that is the only cover for an acceptance line, a regression test
  // kept for an upheld finding, or another story's test is never deleted.
  const notes = [];
  for (const f of merged) {
    if (f.action !== 'delete-test' || f.severity === 'minor' || !protect) continue;
    const why = protect(f);
    if (why) {
      f.severity = 'minor';
      f.protected = why;
      f.upheldBy = [];
    }
  }

  // Contradictions: opposite actions on one test, and upheld rewrites of the same regions with different approaches.
  const contradictions = merged.filter((f) => f.contested && f.severity !== 'minor').map((f) => ({ subject: f.test || f.text, id: f.id, positions: f.contested }));
  const rewrites = merged.filter((f) => f.action === 'rewrite' && f.severity !== 'minor');
  for (let i = 0; i < rewrites.length; i++) {
    for (let j = i + 1; j < rewrites.length; j++) {
      if (overlap(rewrites[i], rewrites[j])) {
        contradictions.push({ subject: `rewrites of ${regionsOf(rewrites[i]).map((r) => r.file).join(', ')}`, id: rewrites[i].id, positions: [rewrites[i], rewrites[j]].map((r) => ({ member: r.members.join('+'), action: 'rewrite', evidence: str(r.approach) || r.text })) });
      }
    }
  }

  // An upheld rewrite replaces the fix list for the regions it deletes: findings inside them are not patched.
  const superseded = [];
  for (const f of merged) {
    if (f.severity === 'minor' || f.action === 'rewrite') continue;
    const by = rewrites.find((r) => regionsOf(r).some((reg) => covers(reg, f)));
    if (by) {
      f.supersededBy = by.id ?? by.text;
      superseded.push(f);
    }
  }
  const standing = merged.filter((f) => f.severity !== 'minor' && !f.supersededBy);
  // The council contradicting itself on the same lines: a finding the adjudication already limited (an objection to its
  // fix stood, and the implementer was told to take that part out) is demanded again. One owner question with both
  // positions; never another fix cycle.
  for (const f of standing) {
    if (f.adjudicate || f.adjudication) continue;
    const r = (earlier?.rejected ?? []).filter((x) => !(str(f.id) && str(f.id) === str(x.objection.id))).find((x) => (str(f.id) && str(f.id) === str(x.earlier.id)) || (f.file && x.earlier.file && relPath(f.file) === relPath(x.earlier.file) && similar(f.text, x.earlier.text, 0.5)));
    if (!r) continue;
    contradictions.push({
      subject: `the council contradicts itself on ${r.earlier.id} (${r.objection.file}${r.objection.line ? `:${r.objection.line}` : ''})`,
      id: f.id ?? r.earlier.id,
      escalate: true,
      positions: [
        { member: `council, round ${r.earlier.round ?? '?'}${f.members?.length ? ` and now ${f.members.join('+')}` : ''}`, action: `requires ${r.earlier.id}: ${r.earlier.fix || r.earlier.text}`, evidence: str(f.text) || r.earlier.text },
        { member: `council, objection upheld on adjudication${r.objection.rejectedBy?.length ? ` (no: ${r.objection.rejectedBy.join(', ')})` : ''}`, action: `take out the behaviour at ${r.objection.file}:${r.objection.line}`, evidence: r.objection.text },
      ],
    });
  }
  for (const f of merged) if (f.severity === 'minor' || f.supersededBy) notes.push(f);
  for (const r of feedback) for (const f of r.findings ?? []) notes.push({ ...normalizeFinding(f, r.member), severity: 'minor', feedback: true });

  // Pass: every blocking member scores passScore or more and no blocking finding stands. A blocking member with no score
  // does not pass. A low score counts unless every non-minor finding it raised was ruled not upheld by the merge
  // (outvoted by blockQuorum, settled by an adjudication or an earlier round, or a question for want of evidence): one
  // member's score never overturns those rulings. A low score, or no score, with no finding of the member's behind it is
  // a finding of its own (the member must say what is wrong).
  const low = [];
  for (const r of okBlocking) {
    if (r.score != null && r.score >= council.councilPassScore) continue;
    const raised = merged.filter((f) => f.members.includes(r.member.name) && f.memberEvidence.some((e) => e.member === r.member.name && e.severity !== 'minor'));
    if (r.score != null && raised.length && raised.every((f) => f.notUpheld)) continue;
    low.push(r);
    if (!raised.some((f) => !f.notUpheld)) {
      standing.push({ id: `council-${r.member.name}-score`, member: r.member.name, members: [r.member.name], upheldBy: [r.member.name], lens: r.member.lens, severity: 'blocking', action: 'fix', file: null, line: null, text: `${r.member.name} ${r.score == null ? 'gave no score' : `scored ${r.score}/10`} (the pass score is ${council.councilPassScore}) without a standing blocking finding`, issue: `${r.member.name} ${r.score == null ? 'gave no score' : `scored ${r.score}/10`} (the pass score is ${council.councilPassScore}) without a standing blocking finding: ${str(r.summary) || 'no reason given'}`, evidence: str(r.summary), harness: true });
    }
  }
  const missing = results.filter((r) => r.member.blocking && r.status !== 'ok');
  const scores = okBlocking.map((r) => r.score).filter((s) => s != null);
  // An owner question or a split awaiting a ruling holds the council: nobody fixes what is not decided.
  const pendingDecisions = (ic?.ownerQuestions?.length ?? 0) + (ic?.awaitingRuling?.length ?? 0);
  const pass = !standing.length && !low.length && (!missing.length || council.onUnavailable === 'report') && !failed.length && !pendingDecisions;
  return {
    ...base,
    pass,
    error: null,
    score: scores.length ? Math.min(...scores) : null,
    findings: standing,
    notes,
    superseded: superseded.map((f) => f.id ?? f.text),
    contradictions,
    // Contradictions with an earlier round's upheld finding, settled by the harness (never an owner question).
    // Findings rule 4 turned into questions (no evidence): asked, recorded, never fixed.
    questions: merged.filter((f) => f.noEvidence).map((f) => ({ id: f.id ?? null, members: f.members, text: f.text, file: f.file ?? null })),
    earlierRound: merged.filter((f) => f.sanctionedBy).map((f) => ({ id: f.id ?? null, subject: f.text, file: f.file ?? null, line: f.line ?? null, earlier: f.sanctionedBy, acceptedBy: f.adjudication?.acceptedBy ?? [], resolution: 'every blocking member accepted on adjudication that the earlier finding\'s fix requires it; this objection is a note' })),
    // Scope objections on lines declared for an earlier upheld finding, not yet adjudicated: they stand until adjudicate() asks.
    adjudicate: merged.filter((f) => f.adjudicate && f.severity !== 'minor').map((f) => ({ ...f.adjudicate, objection: { id: f.id ?? null, text: str(f.text), fix: fixOf(f), file: f.file, line: f.line ?? null, members: f.members, evidence: str(f.evidence) } })),
    adjudicated: merged.filter((f) => f.adjudication).map((f) => f.adjudication),
    rewrites,
    disputes: mergeRulings(ok, merged),
    followUps: [...ok.flatMap((r) => (r.followUps ?? []).filter((u) => str(u?.title)).map((u) => ({ title: str(u.title), reason: str(u.reason), member: r.member.name }))), ...merged.filter((f) => f.outsideChange).map((f) => ({ title: String(f.text ?? f.issue ?? f.id).split('\n')[0].slice(0, 160), reason: f.notUpheld, member: (f.members ?? [])[0] ?? null }))],
    ...(intercom ? { intercom, ownerQuestions: ic?.ownerQuestions ?? [], ...(ic?.awaitingRuling?.length ? { awaitingRuling: ic.awaitingRuling } : {}) } : {}),
    summary: summarize(council, members, standing, notes, contradictions, pass),
  };
}

// ---------------------------------------------------------------------------------------------
// Memory across rounds
// ---------------------------------------------------------------------------------------------
// A stage's council remembers what it upheld within one sitting. Each member is a fresh process that sees the ticket
// and the change, not the earlier rounds, so a later round could block the very change an earlier round required
// (dogfood C16 held-out: the review upheld "a bad price crashes the cast" with the fix "answer InvalidArgument"; the
// next round blocked that validation as an error response no ticket line names, with "fix: none required", and the
// story ended unresolved). The harness keeps every round's upheld findings with their agreed fixes and a snapshot of the
// tree it judged; the next round's members read them, and the merge settles a scope objection to their fix.

const fixOf = (f) => str(f?.fix) || str(f?.suggestion) || str(f?.recommendation) || str(f?.remedy);
const NO_CHANGE = /^\s*(?:none|nothing|n\/a|no(?:\s+(?:code\s+)?(?:change|fix|action)s?)?)(?:\s+(?:is\s+|are\s+)?(?:required|needed|necessary))?\s*(?:[.;:,!(—-]|$)/i;
// Whether a finding's own fix asks for nothing: "none required" with no request after it ("None required; remove the
// limit" asks for a change; council C12, Sol 1 adversarial list).
const CHANGE_VERB = /\b(?:remove|delete|drop|revert|undo|add|change|replace|rename|move|restore|reject|validate|rewrite|return|throw|guard|handle|update|use|make|limit|cap|take\s+out|fix)\b/i;
export const asksNoChange = (f) => fixOf(f) !== '' && NO_CHANGE.test(fixOf(f)) && !CHANGE_VERB.test(fixOf(f).replace(NO_CHANGE, ''));
// The scope objection rule 3 asks for ("no ticket line asks for it"), by the member's `kind` or its wording.
const SCOPE = /\bno\s+(?:line\s+of\s+the\s+)?(?:ticket|story|subtask|acceptance)(?:\s+(?:line|criterion|criteria|requirement)s?)?\s+(?:asks?|names?|requires?|mentions?|calls?|covers?)\b|\b(?:not|never)\s+(?:asked|required|requested)\s+(?:for\s+)?by\s+(?:the|any)\s+(?:ticket|story|subtask)\b|\bout(?:side)?\s+(?:of\s+)?(?:the\s+)?(?:ticket'?s?\s+)?scope\b|\bscope\s+creep\b/i;
export const isScopeObjection = (f) => str(f?.kind).toLowerCase() === 'scope' || SCOPE.test(`${str(f?.text)} ${str(f?.issue)} ${str(f?.title)}`);

// The earlier upheld finding whose fix a merged finding objects to, as a one-element list, or null. Every blocking
// member's item in the cluster must be a scope objection (a defect clustered with it by line still blocks). The places
// are the objection's own lines (the merged finding's and each blocking item's file and line), never the lines its
// evidence cites: each must resolve, through the recorded provenance (councilMemory's `sanctions`), to the same one
// upheld finding. Anything else (no provenance, two findings, a place outside every recorded fix) leaves it standing.
function sanctionedBy(f, earlier) {
  if (!earlier?.sanctions || !f.file) return null;
  const items = (f.memberEvidence ?? []).filter((e) => e.severity !== 'minor');
  if (!(items.length ? items : [f]).every(isScopeObjection)) return null;
  const places = [{ file: f.file, line: f.line }, ...items.filter((e) => e.file && Number.isFinite(e.line)).map((e) => ({ file: e.file, line: e.line }))];
  let one = null;
  for (const p of places) {
    const by = earlier.sanctions(p.file, p.line);
    if (by?.length !== 1) return null;
    if (one && one.key !== by[0].key) return null;
    one ??= by[0];
  }
  return one ? [one] : null;
}

// The key that ties an objection to the earlier finding it is adjudicated against (stable across the re-merge).
const adjudicationKey = (f, u) => `${relPath(f.file)}:${f.line ?? ''}|${u.key ?? u.id}`;
const ANSWER = (a) => {
  const v = str(a).toLowerCase().replace(/[.!]$/, '');
  return v === 'yes' || v === 'no' ? v : null;
};
// The adjudication of one objection: covered only when every blocking member of the stage's council answered exactly
// "yes" with evidence, once. A "no", a missing answer (an unavailable or failed member, or no answer for this objection),
// anything but a plain yes or no, a yes without evidence, or two different answers from one member: the objection stands.
// blockQuorum is honoured by asking only the blocking members and needing all of them: a single blocking member can uphold a
// finding under "any", so a single one can keep an objection standing; under "majority" or "all" the objection was
// already upheld by that many, and accepting it as covered still takes every one (the strict side of every rule).
export function adjudicationOutcome(council, answers = []) {
  const names = council.members.filter((m) => m.blocking).map((m) => m.name);
  const yes = [];
  const no = [];
  const missing = [];
  const ambiguous = [];
  for (const n of names) {
    const mine = (answers ?? []).filter((a) => a?.member === n);
    const values = [...new Set(mine.map((a) => ANSWER(a.answer)))];
    if (!mine.length) missing.push(n);
    else if (values.length !== 1 || values[0] === null) ambiguous.push(n);
    else if (values[0] === 'no') no.push(n);
    else if (!mine.every((a) => str(a.evidence).length >= 10)) ambiguous.push(n);
    else yes.push(n);
  }
  return { accepted: names.length > 0 && yes.length === names.length, yes, no, missing, ambiguous, answers: (answers ?? []).map((a) => ({ member: a.member, answer: str(a.answer).slice(0, 20), evidence: str(a.evidence).slice(0, 400) })) };
}

// The question a blocking member answers, fresh and read-only, for each candidate: the earlier finding, its agreed fix,
// the lines the fixer declared for it (as the harness sealed them) and the objection. Nothing from the fixer's own
// argument beyond the declaration.
export function adjudicationTask(items, { stage = null } = {}) {
  return [
    `# Council adjudication${stage ? ` (${stage})` : ''}`,
    '',
    'You are a member of this ticket\'s council, asked one narrow question per item. Earlier, the council upheld a finding and agreed a fix. The agent that fixed it declared which new lines carry out that fix. Now a council member objects that a behaviour on one of those lines is outside the ticket. Decide only this: **does the agreed fix of the earlier finding require this specific behaviour?**',
    '',
    '- Answer `yes` only when the agreed fix cannot be carried out without this behaviour, and say why with evidence (file and line, the finding\'s words). A behaviour that is merely near the fix, in the same file, convenient, or a reasonable extra is `no`.',
    '- Answer `no` when the behaviour goes beyond what the agreed fix asks, or when you cannot tell. Read the code (read-only); change nothing.',
    '- The declaration is the fixer\'s claim, not evidence that the fix needs the line.',
    '',
    ...items.flatMap((it, i) => [
      `## Item ${i + 1}: \`${it.label ?? it.key}\``,
      '',
      `- Earlier finding \`${it.finding.id}\`${it.finding.stage ? ` (${it.finding.stage}${it.finding.step ? `, ${it.finding.step}` : ''}, round ${it.finding.round})` : it.finding.round ? ` (round ${it.finding.round})` : ''}${it.finding.file ? ` at ${it.finding.file}${it.finding.line ? `:${it.finding.line}` : ''}` : ''}: ${it.finding.text}`,
      `- Its agreed fix: ${it.finding.fix || '(none recorded)'}`,
      `- Lines the fixer declared for it${it.declared?.file ? ` in ${it.declared.file}` : ''}:`,
      '',
      '```',
      ...(it.declared?.lines ?? []).slice(0, 40),
      '```',
      '',
      `- The objection, at ${it.objection.file}${it.objection.line ? `:${it.objection.line}` : ''}${it.objection.members?.length ? ` (raised by ${it.objection.members.join(', ')})` : ''}: ${it.objection.text}`,
      ...(it.objection.fix ? [`- It asks: ${it.objection.fix}`] : []),
      ...(it.objection.evidence ? [`- Its evidence: ${it.objection.evidence.slice(0, 600)}`] : []),
      '',
    ]),
    'Answer on the last line, one entry per item, with the item keys exactly as given:',
    '',
    `AGENT_RESULT: {"answers": [${items.map((it) => `{"key": "${it.label ?? it.key}", "answer": "yes|no", "evidence": "<file:line and why>"}`).join(', ')}]}`,
  ].join('\n');
}

// A member's adjudication answers ({ answers: [{ key, answer, evidence }] }), or null when there is no AGENT_RESULT.
export function parseAdjudication(output) {
  const m = [...String(output ?? '').matchAll(/AGENT_RESULT:\s*(\{.*\})\s*$/gm)].at(-1);
  let raw;
  try {
    raw = m ? JSON.parse(m[1]) : null;
  } catch {
    raw = null;
  }
  if (!raw || !Array.isArray(raw.answers)) return null;
  return { score: null, verdict: null, summary: '', findings: [], answers: raw.answers.filter((a) => a && typeof a === 'object').map((a) => ({ key: str(a.key), answer: str(a.answer), evidence: str(a.evidence) })) };
}

// Settles the merge's adjudication candidates (merged.adjudicate) with the stage's blocking members: one sitting, every
// member fresh and read-only, one question per candidate. `run(member, task)` is the stage's own member call (its
// usage tagged as the adjudication), `remerge(adjudications)` merges the same results again with the answers. The
// sitting is recorded in council-rounds as kind "adjudication" (counted and costed as a sitting; the PR's council table
// lists it). Without candidates, the merge is returned unchanged.
export async function adjudicate({ config = null, council, merged, remerge, run: runMember, stage, story, step = null, round, retries = 0, readOnly = null, log = defaultLog }) {
  // Each item is asked under a short label (I1, I2, ...); answers are mapped back to the objection's own key.
  const items = (merged?.adjudicate ?? []).map((it, i) => ({ ...it, label: `I${i + 1}` }));
  if (merged?.error || !items.length) return merged;
  const byLabel = new Map(items.map((it) => [it.label, it.key]));
  const blocking = council.members.filter((m) => m.blocking);
  const out = await runCouncil({ council: { ...council, members: blocking }, run: runMember, parse: parseAdjudication, taskFor: () => adjudicationTask(items, { stage }), retries, readOnly, log });
  const adjudications = Object.fromEntries(items.map((it) => [it.key, []]));
  if (!out.violation) {
    for (const r of out.results) {
      if (r.status !== 'ok') continue;
      for (const a of r.answers ?? []) {
        const key = byLabel.get(a.key);
        if (key) adjudications[key].push({ member: r.member.name, answer: a.answer, evidence: a.evidence });
      }
    }
  }
  const again = remerge(adjudications);
  if (config) recordAdjudication(config, { stage, story, step, round, council, results: out.results, adjudicated: again.adjudicated ?? [], violation: out.violation ?? null });
  for (const a of again.adjudicated ?? []) log(`council ${stage}: adjudication of the objection at ${a.file}:${a.line} against ${a.earlier}: ${a.outcome}${a.acceptedBy.length ? ` (yes: ${a.acceptedBy.join(', ')})` : ''}${a.rejectedBy.length ? ` (no: ${a.rejectedBy.join(', ')})` : ''}${a.missing.length ? ` (no answer: ${a.missing.join(', ')})` : ''}`);
  return { ...again, adjudication: { members: out.results.map((r) => ({ name: r.member.name, status: r.status, attempts: r.attempts ?? 1, seconds: r.seconds ?? null })), items: again.adjudicated ?? [] } };
}

// The adjudication sitting's record (council-rounds, kind "adjudication") and its decision.
export function recordAdjudication(config, { stage, story, step = null, round, council, results = [], adjudicated = [], violation = null }) {
  const rec = {
    ts: nowIso(),
    kind: 'adjudication',
    stage,
    story,
    ...(step ? { step } : {}),
    round,
    blockQuorum: council.blockQuorum,
    members: results.map((r) => ({ name: r.member.name, cli: r.member.cli, model: r.member.model ?? null, lens: r.member.lens, login: memberLogin(r.member), blocking: true, status: r.status, attempts: r.attempts ?? 1, seconds: r.seconds ?? null, ...(r.reason ? { reason: String(r.reason).slice(0, 300) } : {}) })),
    ...(violation ? { error: String(violation).slice(0, 300) } : {}),
    items: adjudicated.map((a) => ({ file: a.file, line: a.line, earlier: a.earlier, outcome: a.outcome, acceptedBy: a.acceptedBy, rejectedBy: a.rejectedBy, missing: a.missing, ambiguous: a.ambiguous })),
    covered: adjudicated.filter((a) => a.outcome === 'covered').length,
    stands: adjudicated.filter((a) => a.outcome !== 'covered').length,
  };
  try {
    appendJsonl(metricsFile(config, COUNCIL_FILE), rec);
    logDecision(config, { stage: `council-${stage}`, story, round, agent: 'council', subject: step ? `${story}/${step}` : story, decision: 'adjudicated', reason: `${rec.covered} covered, ${rec.stands} standing`, members: rec.members, items: adjudicated.map((a) => ({ source: 'adjudication', file: a.file, line: a.line, earlier: a.earlier, outcome: a.outcome, acceptedBy: a.acceptedBy, rejectedBy: a.rejectedBy, missing: a.missing, ambiguous: a.ambiguous, answers: a.answers })) });
  } catch (error) {
    defaultLog(`council: could not record the adjudication of ${stage} round ${round}: ${error.message}`);
  }
  return rec;
}

// A snapshot of a checkout's working tree (tracked and untracked files, .gitignore respected) as a git tree id, or null.
export function treeSnapshot(cwd) {
  const index = path.join(os.tmpdir(), `factory-council-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (run('git', ['read-tree', 'HEAD'], { cwd, env }).status !== 0) return null;
    if (run('git', ['add', '-A', '--', '.'], { cwd, env }).status !== 0) return null;
    const t = run('git', ['write-tree'], { cwd, env });
    return t.status === 0 ? t.stdout.trim() || null : null;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

const safeName = (x) => String(x ?? '').replace(/[^A-Za-z0-9._-]+/g, '_');
// Where a stage's memory for one story (and subtask) lives: the run state, never the change.
export const memoryFile = (root, stateDir, { stage, story, step = null }) => path.join(root, stateDir, 'council', 'memory', `${ledgerBase({ stage, story, step })}.json`);

const upheldRecord = (f) => ({ id: str(f.id) || null, text: (str(f.text) || str(f.issue) || str(f.title)).slice(0, 600), fix: fixOf(f).slice(0, 600), file: f.file ?? null, line: Number.isFinite(f.line) ? f.line : null, members: f.upheldBy?.length ? f.upheldBy : f.members ?? [], ...(f.adjudication?.outcome === 'stands' ? { adjudication: { earlier: f.adjudication.earlier, earlierText: f.adjudication.earlierText, earlierFix: f.adjudication.earlierFix, file: f.adjudication.file, line: f.adjudication.line, rejectedBy: f.adjudication.rejectedBy } } : {}) });

// Names the merged findings no member named (`<prefix>-<n>`, in place), before they are remembered and handed to the
// agent fixing them, so its declaration of which lines answer which finding (fixDeclarationText) can name each one.
export function nameFindings(findings = [], prefix) {
  findings.forEach((f, i) => {
    if (f && !str(f.id)) f.id = `${prefix}-${i + 1}`;
  });
  return findings;
}

// The prompt block of the earlier rounds' upheld findings ('' when none).
export function earlierFindingsText(upheld = []) {
  if (!upheld.length) return '';
  return [
    '### Findings the council upheld in earlier rounds',
    '',
    'The council upheld these for this ticket in earlier rounds (of this stage, or of an earlier stage where one is named), and the change since then answers them. A change that exists to resolve one of them is required by it, as if a ticket line asked for it: do not raise it as behaviour no ticket line asks for, and do not ask to undo it. You may still report a real defect in how it was done (with evidence), and re-raise one of these (same `id`) if it is not resolved.',
    '',
    ...upheld.map((u) => `- ${u.stage ? `${u.stage}${u.step ? ` (${u.step})` : ''}, ` : ''}round ${u.round}${u.id ? `, \`${u.id}\`` : ''}${u.file ? ` (${u.file}${u.line ? `:${u.line}` : ''})` : ''}: ${u.text}${u.fix ? ` Agreed fix: ${u.fix}` : ''}`),
  ].join('\n');
}

// Provenance of a fix (council C11, Sol 1: a later round's scope objection was settled whenever it landed near any line
// changed since the first upheld round, or near text a fix of the same round had added, crediting every finding of that
// round; an unrelated limit added in the same interval would have been waved through). The agent that fixes upheld
// findings declares, per finding, the line ranges it changed to carry out that finding's agreed fix (fixDeclarationText;
// a JSON file in the git-ignored state directory). The harness seals the declaration against the diff of that fixing
// step (sealFixes): only lines the step added, whose text was not in the file before it and is not text the step
// removed elsewhere (moved code), become the finding's provenance. A scope objection is settled only when its own line
// is one of those lines, under exactly one finding, whose file or agreed fix names that file. Nothing is inferred from
// timing, proximity, file identity or matching text in a citation.
const SIGNIFICANT = (t) => t.length >= 8 && /[A-Za-z0-9]/.test(t);
const MAX_HUNK = 200;
// A path as the repository names it, from a relative path or one inside the checkout or a story worktree.
const inRepo = (cwd, p) => relPath(cwd && String(p ?? '').startsWith(`${cwd}/`) ? String(p).slice(cwd.length + 1) : p);
const ledgerBase = ({ stage, story, step = null }) => `${safeName(stage)}--${safeName(story)}${step ? `--${safeName(step)}` : ''}`;
// Where the agent fixing a stage's upheld findings declares which lines answer which finding (in its own checkout).
export const fixesFile = (cwd, stateDir, ledger) => path.join(cwd, stateDir, 'council', 'fixes', `${ledgerBase(ledger)}.json`);

// The block added to a fixer's task: write the declaration ('' when no finding has an id).
export function fixDeclarationText(file, findings = []) {
  const ids = [...new Set(findings.map((f) => str(f?.id)).filter(Boolean))];
  if (!file || !ids.length) return '';
  return [
    '### Say which lines answer which finding',
    '',
    `When you finish, write \`${file}\` (JSON; create the folder if needed; it is git-ignored and never part of the change):`,
    '',
    '`{"fixes": [{"id": "<finding id>", "hunks": [{"file": "<path from the repository root>", "start": <first line>, "end": <last line>}]}]}`',
    '',
    `One entry per finding you changed code for (${ids.map((i) => `\`${i}\``).join(', ')}), listing only the line ranges, as the files stand when you finish, that you added or changed to carry out that finding's agreed fix. Do not list lines you changed for another reason (another finding, clean-up, code you only moved), and leave out a finding you changed nothing for. A later objection that a line is outside the ticket can become a note only for new lines listed here under exactly one finding, and only when every council member, asked separately, agrees that finding's fix requires that line; list nothing else.`,
  ].join('\n');
}

const gitText = (cwd, args) => {
  const r = run('git', args, { cwd });
  return r.status === 0 ? r.stdout : null;
};
// Per file, the lines a diff added ({ line -> text }), and the trimmed text of every line it removed (any file).
function diffLines(text) {
  const added = new Map();
  const removed = new Set();
  let cur = null;
  let n = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const f = /^\+\+\+ b\/(.+)$/.exec(line);
      cur = f ? f[1] : null;
      if (cur && !added.has(cur)) added.set(cur, new Map());
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (line.startsWith('+') && cur) added.get(cur).set(n++, line.slice(1));
    else if (line.startsWith('-')) removed.add(line.slice(1).trim());
  }
  return { added, removed };
}

// Checks a fixer's declaration against the diff of its fixing step (`from`, a commit or tree before it; `to`, the tree
// after it): { provenance: [{ id, file, lines }], rejected: [{ id, file?, reason }] }. `upheld` are the findings the
// step was fixing; an id that is not one of them is rejected.
export function sealFixes({ declared, cwd, from, to, upheld = [] }) {
  const provenance = [];
  const rejected = [];
  const ids = new Set(upheld.map((u) => str(u.id)).filter(Boolean));
  const diff = from && to ? gitText(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', from, to]) : null;
  if (diff === null) return { provenance, rejected: [{ id: null, reason: 'the fixing step has no diff' }] };
  const { added, removed } = diffLines(diff);
  for (const fx of Array.isArray(declared?.fixes) ? declared.fixes : []) {
    const id = str(fx?.id);
    if (!ids.has(id)) {
      rejected.push({ id: id || null, reason: 'not a finding that round upheld' });
      continue;
    }
    for (const h of Array.isArray(fx.hunks) ? fx.hunks : []) {
      const rel = inRepo(cwd, h?.file);
      const start = Number(h?.start);
      const end = Number(h?.end ?? h?.start);
      if (!rel || !Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start >= MAX_HUNK) {
        rejected.push({ id, file: rel || null, reason: `not a narrow line range (at most ${MAX_HUNK} lines)` });
        continue;
      }
      const lines = added.get(rel);
      if (!lines) {
        rejected.push({ id, file: rel, reason: 'the fixing step did not change that file' });
        continue;
      }
      const before = new Set((gitText(cwd, ['show', `${from}:${rel}`]) ?? '').split('\n').map((t) => t.trim()));
      const kept = [];
      let old = 0;
      for (let i = start; i <= end; i++) {
        const t = lines.get(i)?.trim();
        if (!t || !SIGNIFICANT(t)) continue;
        if (before.has(t) || removed.has(t)) old++;
        else kept.push(t.slice(0, 300));
      }
      if (kept.length) provenance.push({ id, file: rel, lines: [...new Set(kept)] });
      else rejected.push({ id, file: rel, reason: old ? 'every declared line was already there before the fix (original or moved code)' : 'no line in that range was added by the fixing step' });
    }
  }
  return { provenance, rejected };
}

// Seals a pending declaration into the ledger round whose findings it answers, and removes it. `from` is the tree or
// commit before the fixing step (default: the round's own tree), `to` the tree after it (default: the checkout now).
export function sealDeclaration({ fixes, ledger, cwd, from = null, to = null, log = defaultLog }) {
  const declared = readJson(fixes, null);
  if (!declared) return null;
  fs.rmSync(fixes, { force: true });
  const saved = readJson(ledger, null);
  const target = (saved?.rounds ?? []).at(-1);
  if (!target?.upheld?.length) return null;
  const sealed = sealFixes({ declared, cwd, from: from ?? target.tree, to: to ?? treeSnapshot(cwd), upheld: target.upheld });
  target.provenance = [...(target.provenance ?? []), ...sealed.provenance];
  if (sealed.rejected.length) target.rejected = [...(target.rejected ?? []), ...sealed.rejected];
  target.sealed = true;
  try {
    writeJson(ledger, saved);
  } catch (error) {
    log(`council: could not record the fix provenance: ${error.message}`);
  }
  return sealed;
}

// After an agent run that fixed upheld findings outside a council round (the implementer answering a review or a PR
// check return): every declaration it left is sealed against `before`, the commit the run started from.
export function sealPendingFixes({ cwd, stateDir, root, before, log = defaultLog }) {
  const dir = path.join(cwd, stateDir, 'council', 'fixes');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => sealDeclaration({ fixes: path.join(dir, n), ledger: path.join(root, stateDir, 'council', 'memory', n), cwd, from: before, log })).filter(Boolean);
}

// Whether an upheld finding's agreed remedy covers a file: the finding is about that file, or its fix or text names it.
const remedyCovers = (u, rel) => {
  if (u.file && relPath(u.file) === rel) return true;
  const said = `${u.fix ?? ''} ${u.text ?? ''}`;
  return said.includes(rel) || new RegExp(`(^|[^\\w.-])${path.basename(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(said);
};

// One round's view of a story's council memory: { upheld (earlier rounds of this sitting, then earlier rulings of the
// story's other stages and sittings), sanctions(file, line) (the one upheld finding whose sealed fix made that line, as
// a one-element list, or null), text (the prompt block), fixes (where this stage's fixer declares), remember(findings) }.
// A round number not after the last one recorded starts a new sitting; the old sitting's rounds become history, so a
// later stage (the PR check after the review, the review after a PR check return) still knows them. The fixer's
// declaration for the last round is sealed here, against the diff from the tree that round judged to the tree now.
export function councilMemory({ file, cwd, round, fixes = null }) {
  const me = ledgerName(file);
  const tree = cwd ? treeSnapshot(cwd) : null;
  if (fixes && cwd && fs.existsSync(fixes)) sealDeclaration({ fixes, ledger: file, cwd, to: tree });
  const saved = readJson(file, null) ?? { rounds: [], history: [] };
  const newSitting = (saved.rounds ?? []).some((r) => r.round >= round);
  const sitting = newSitting ? [] : saved.rounds ?? [];
  const history = [...(saved.history ?? []), ...(newSitting ? saved.rounds ?? [] : [])].slice(-30);
  const here = sitting.flatMap((r) => (r.upheld ?? []).map((u) => ({ ...u, round: r.round })));
  // The story's other ledgers (other stages and subtasks) and this ledger's history: earlier rulings with their fixes.
  const others = [];
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      const other = path.join(path.dirname(file), name);
      if (other === file || !name.endsWith('.json')) continue;
      const them = ledgerName(other);
      if (them.story !== me.story) continue;
      const j = readJson(other, null);
      for (const r of [...(j?.history ?? []), ...(j?.rounds ?? [])]) if (r.upheld?.length) others.push({ ...r, stage: them.stage, step: them.step });
    }
  } catch {
    // no other ledger yet
  }
  for (const r of history) if (r.upheld?.length) others.push({ ...r, stage: me.stage, step: me.step, earlierSitting: true });
  const elsewhere = others.flatMap((r) => r.upheld.map((u) => ({ ...u, round: r.round, stage: r.stage, step: r.step, earlierSitting: r.earlierSitting ?? false })));
  // Every sealed provenance entry of the story, tied to its one finding.
  const sealed = [...sitting.map((r) => ({ ...r, stage: me.stage, step: me.step })), ...others].flatMap((r) =>
    (r.provenance ?? []).flatMap((p) => {
      const u = (r.upheld ?? []).find((x) => str(x.id) === p.id);
      return u ? [{ file: p.file, lines: new Set(p.lines), finding: { ...u, round: r.round, stage: r.stage, step: r.step, key: `${r.stage}|${r.step ?? ''}|${r.ts ?? r.round}|${p.id}` } }] : [];
    }),
  );
  const sanctions = (f, line) => {
    if (!cwd || !Number.isFinite(line) || !sealed.length) return null;
    const rel = inRepo(cwd, f);
    let all;
    try {
      all = fs.readFileSync(path.join(cwd, rel), 'utf8').split('\n').map((t) => t.trim());
    } catch {
      return null;
    }
    const text = all[line - 1];
    // A generic or repeated line cannot name its fix.
    if (!text || !SIGNIFICANT(text) || all.filter((t) => t === text).length !== 1) return null;
    const by = new Map(sealed.filter((s) => s.file === rel && s.lines.has(text)).map((s) => [s.finding.key, s.finding]));
    if (by.size !== 1) return null;
    const [finding] = by.values();
    const declared = sealed.filter((x) => x.file === rel && x.finding.key === finding.key).flatMap((x) => [...x.lines]);
    return remedyCovers(finding, rel) ? [{ ...finding, declared: { file: rel, lines: [...new Set(declared)] } }] : null;
  };
  const upheld = [...here, ...elsewhere].slice(-20);
  // Objections that stood on adjudication against an earlier finding's fix (the implementer was told to take that part
  // out): a later demand for that finding again is the council contradicting itself (mergeCouncil escalates it).
  const all = [...here, ...elsewhere];
  const rejected = all.filter((u) => u.adjudication).map((u) => {
    const e = all.find((x) => str(x.id) === str(u.adjudication.earlier));
    return { earlier: { id: u.adjudication.earlier, text: e?.text ?? u.adjudication.earlierText ?? '', fix: e?.fix ?? u.adjudication.earlierFix ?? '', file: e?.file ?? null, round: e?.round ?? null }, objection: { id: u.id, text: u.text, file: u.adjudication.file, line: u.adjudication.line, rejectedBy: u.adjudication.rejectedBy ?? [] } };
  });
  return {
    upheld,
    rejected,
    sanctions,
    fixes,
    text: earlierFindingsText(upheld),
    remember(findings = []) {
      try {
        const list = findings.filter((f) => f && !f.harness && f.severity !== 'minor').map(upheldRecord);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fixes) fs.rmSync(fixes, { force: true });
        writeJson(file, { ...me, rounds: [...sitting, { round, ts: nowIso(), tree, upheld: list }], history });
      } catch (error) {
        defaultLog(`council: could not remember round ${round}: ${error.message}`);
      }
    },
  };
}
// A ledger's stage, story and subtask, from its file name (memoryFile).
const ledgerName = (file) => {
  const [stage, story, step] = path.basename(file, '.json').split('--');
  return { stage: stage || null, story: story ?? null, step: step ?? null };
};

// The members' rulings on the implementer's disputes, one per finding: re-asserted when a member that raised the finding
// re-asserted it with evidence, accepted when every raiser that ruled accepted it. Only the members that raised a
// finding rule on it.
function mergeRulings(ok, merged) {
  const byId = new Map();
  for (const r of ok) {
    for (const d of Array.isArray(r.disputes) ? r.disputes : []) {
      const id = str(d?.finding);
      if (!id) continue;
      const f = merged.find((x) => x.id === id);
      if (f && !f.members.includes(r.member.name)) continue;
      (byId.get(id) ?? byId.set(id, []).get(id)).push({ ...d, member: r.member.name });
    }
  }
  return [...byId].map(([id, list]) => {
    const re = list.find((d) => d.decision === 'reasserted' && str(d.evidence));
    if (re) return { finding: id, decision: 'reasserted', evidence: re.evidence, members: list.map((d) => d.member) };
    return { finding: id, decision: list.every((d) => d.decision === 'accepted') ? 'accepted' : 'reasserted', evidence: list.map((d) => str(d.evidence)).filter(Boolean).join(' ') || '', members: list.map((d) => d.member) };
  });
}

function summarize(council, members, standing, notes, contradictions, pass) {
  const scores = members.filter((m) => m.blocking).map((m) => `${m.name} ${m.status === 'ok' ? `${m.score ?? 'no score'}${m.score != null ? '/10' : ''}` : m.status}`).join(', ');
  return `Council (${council.stage}, blockQuorum ${council.blockQuorum}, pass ${council.councilPassScore}/10): ${pass ? 'passed' : 'not passed'}; ${scores}; ${standing.length} finding(s) stand, ${notes.length} note(s)${contradictions.length ? `, ${contradictions.length} contradiction(s) between members` : ''}.`;
}

// The disputes block for one member: only the disputes of findings it raised.
export function disputesFor(member, open = [], format) {
  const mine = open.filter((d) => !Array.isArray(d.members) || !d.members.length || d.members.includes(member.name));
  return mine.length ? format(mine) : '';
}

// The text the implementer or fixer reads for a contested finding: both positions, for it to answer with evidence.
export function contestedText(f) {
  if (!f.contested?.length) return '';
  return ` Council members disagree: ${f.contested.map((p) => `${p.member} asks to ${p.action === 'delete-test' ? 'delete the test' : p.action} (${String(p.evidence ?? '').slice(0, 200)})`).join('; ')}. Do what the evidence supports and say why in your result; if the ticket does not settle it, report it for the ticket's owner.`;
}

// The text an upheld rewrite gives the implementer: delete these regions and write them again, do not patch them.
export function rewriteText(f) {
  const regions = regionsOf(f).map((r) => (r.from == null ? r.file : `${r.file}:${r.from}-${r.to}`)).join(', ');
  return `REWRITE (upheld by ${f.upheldBy?.join(', ') || f.members?.join(', ')}): delete what the branch added or changed in ${regions || '(the regions it names)'} and write it again this way: ${str(f.approach) || f.text}. Why: ${str(f.why) || f.evidence}. Covers: ${[].concat(f.covers ?? []).join('; ') || '(see the finding)'}. This replaces every finding inside those regions; do not patch code that is about to go, and stay inside the ticket.`;
}

// ---------------------------------------------------------------------------------------------
// Delete-test protections
// ---------------------------------------------------------------------------------------------

const KEY = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/g;
const caseIdsOf = (text) => [...String(text ?? '').matchAll(/\b(TC-[A-Za-z][A-Za-z0-9]*-\d+-\d+)\b/gi)].map((m) => m[1].toUpperCase());

// The plan cases of a story's test plan: { id, covers: [...], keptFor }.
export function planCases(root, plansDir, key) {
  const dir = path.join(root, plansDir ?? setting({}, 'featureVerification.plansDir'), key);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^TC-.*\.md$/.test(f)).map((f) => {
    const { data } = parseFrontMatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: String(data.id ?? f.replace(/\.md$/, '')).toUpperCase(), covers: [].concat(data.covers ?? []).map(String), keptFor: data['kept-for'] ? String(data['kept-for']) : null };
  });
}

// Why a delete-test finding may not be acted on, or null. `keys` are the stories the change delivers; `cases` their
// plan cases (planCases). Never deleted: another story's test, a regression test kept for an upheld finding (`kept-for`),
// the only test of an acceptance line (the only plan case that covers one of its lines).
export function testProtection(f, { keys = [], cases = [] } = {}) {
  const mine = new Set(keys.map((k) => String(k).toUpperCase()));
  const text = [f.test, f.file, f.text].map(str).join(' ');
  const fileKeys = [...path.basename(str(f.file)).matchAll(KEY)].map((m) => m[1].toUpperCase());
  const ids = caseIdsOf(text);
  const caseKeys = ids.map((id) => id.replace(/^TC-/, '').replace(/-\d+$/, ''));
  const foreign = [...fileKeys.filter((k) => !/^TC-/.test(k)), ...caseKeys].filter((k) => mine.size && !mine.has(k) && /^[A-Z][A-Z0-9]*-\d+$/.test(k));
  if (foreign.length) return `it belongs to another story (${[...new Set(foreign)].join(', ')})`;
  for (const id of ids) {
    const c = cases.find((x) => x.id === id || x.id.startsWith(`${id}-`));
    if (!c) continue;
    if (c.keptFor) return `it is a regression test kept for upheld finding(s) ${c.keptFor} (kept-for in ${c.id})`;
    const only = c.covers.filter((line) => !cases.some((o) => o !== c && o.covers.includes(line)));
    if (only.length) return `it is the only cover for acceptance line(s): ${only.join('; ')} (${c.id})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Records: metrics, the decision log and the PR body
// ---------------------------------------------------------------------------------------------

// One council round to council-rounds.jsonl and the decision log.
// `stories`: every ticket a shared check covers (a PR check of --stories A,B); its council sat on each of them.
export function recordCouncilRound(config, { stage, story, step = null, check = null, stories = null, round, council, merged, selfRecorded = [] }) {
  const rec = {
    ts: nowIso(),
    stage,
    story,
    ...(step ? { step } : {}),
    // A PR check's run id: its rounds, findings and usage join on it (ids and round numbers start again in each check).
    ...(check ? { check } : {}),
    ...(stories?.length > 1 ? { stories } : {}),
    round,
    rounds: council.maxCouncilRounds,
    passScore: council.councilPassScore,
    blockQuorum: council.blockQuorum,
    pass: Boolean(merged.pass),
    ...(merged.error ? { error: String(merged.error).slice(0, 500) } : {}),
    score: merged.score ?? null,
    // Each member with its pool entry, model and family (misses count against them; the scorecard keys rows by model).
    members: (merged.members ?? []).map((m) => {
      const seat = (council.members ?? []).find((x) => x.name === m.name) ?? {};
      return { ...m, entry: seat.entry ?? null, model: seat.model ?? null, family: seat.family ?? null };
    }),
    standing: (merged.findings ?? []).length,
    notes: (merged.notes ?? []).length,
    contradictions: (merged.contradictions ?? []).length,
    rewrites: (merged.rewrites ?? []).length,
    superseded: (merged.superseded ?? []).length,
    ...((merged.earlierRound ?? []).length ? { earlierRound: merged.earlierRound.length } : {}),
    ...((merged.questions ?? []).length ? { noEvidence: merged.questions.length } : {}),
    // The discussion, counted; its journal relative to the repository (metrics are committed: no local absolute path).
    ...(merged.intercom ? { intercom: { roomId: merged.intercom.roomId, transcript: merged.intercom.transcript && path.relative(config.root, merged.intercom.transcript), ...(merged.intercom.violation ? { violation: true } : {}), settled: merged.intercom.settledDisputes.length, rulings: merged.intercom.rulings.map(({ disputeId, findingId, ruling, reason, by }) => ({ disputeId, findingId, ruling, reason, by })), awaitingRuling: merged.intercom.awaitingRuling.length, ownerQuestions: merged.intercom.ownerQuestions.length, withdrawn: merged.intercom.withdrawn.length, disconnected: merged.intercom.disconnected.length } } : {}),
  };
  try {
    appendJsonl(metricsFile(config, COUNCIL_FILE), rec);
    // The round's findings and the outcomes it settles (council-findings.jsonl). The PR check records its own, with
    // the judge's rulings (pr-check loop).
    if (stage !== 'prCheck') recordRoundFindings(config, { stage, story, step, round, council, merged, selfRecorded });
    logDecision(config, {
      stage: `council-${stage}`,
      story,
      round,
      agent: 'council',
      subject: step ? `${story}/${step}` : story,
      decision: merged.error ? 'error' : merged.pass ? 'approved' : 'changes-requested',
      reason: merged.summary,
      members: merged.members,
      items: [...(merged.findings ?? []), ...(merged.notes ?? [])].slice(0, 100).map((f) => ({ source: f.harness ? 'harness' : `model:${(f.members ?? [f.member]).filter(Boolean)[0] ?? 'unknown'}`, severity: f.severity, action: f.action, lens: f.lens, members: f.members ?? [f.member], file: f.file ?? null, line: f.line ?? null, reason: f.text, ...(f.notUpheld ? { notUpheld: f.notUpheld } : {}), ...(f.protected ? { protected: f.protected } : {}), ...(f.supersededBy ? { supersededBy: f.supersededBy } : {}), ...(f.sanctionedBy ? { sanctionedBy: f.sanctionedBy } : {}), ...(f.noChange ? { noChange: true } : {}), ...(f.noEvidence ? { noEvidence: true } : {}), ...(f.contested ? { contested: true } : {}) })),
    });
  } catch (error) {
    defaultLog(`council: could not record round ${round} of ${stage}: ${error.message}`);
  }
  return rec;
}

// The council's results as the skill's "Council review" table, one per stage (and subtask) that seated a council for
// these stories: the latest run of each (the records after its last round 1), blocking members only.
export function councilReviewSection(records) {
  // Every sitting of a stage's council, in order: a round 1 after earlier rounds starts a new sitting (a check again after
  // fixes), and a round 0 is a verify-first check (feature verification checks again before any new round). Council C9
  // proof run: keeping only the last sitting showed the test automation council as "Rounds: 0" with no score.
  const groups = new Map();
  // Adjudication sittings (kind "adjudication") are listed under their stage, never as rounds of it.
  const adjudications = records.filter((r) => r.kind === 'adjudication');
  for (const r of [...records].filter((x) => x.kind !== 'adjudication').sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    const key = `${r.stage}|${r.story}|${r.step ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    const sittings = groups.get(key);
    const last = sittings.at(-1);
    // A check (round 0) opens a sitting whose round 1 follows it; any other round not after the previous one starts anew.
    const prev = last?.at(-1).round;
    if (!last || r.round === 0 || (prev !== 0 && r.round <= prev)) sittings.push([]);
    sittings.at(-1).push(r);
  }
  if (!groups.size) return '';
  const blocks = [];
  for (const [key, sittings] of groups) {
    const [stage, story, step] = key.split('|');
    const cols = sittings.flatMap((list, i) => list.map((r) => ({ r, label: `${sittings.length > 1 ? `Sitting ${i + 1}, ` : ''}${r.round === 0 ? 'check' : `round ${r.round}`}` })));
    const names = [];
    for (const { r } of cols) for (const m of r.members ?? []) if (m.blocking && !names.some((n) => n.name === m.name)) names.push(m);
    const rows = names.map((m) => `| ${memberLabel(m)} | ${cols.map(({ r }) => {
      const got = r.members?.find((x) => x.name === m.name);
      const runs = got?.attempts > 1 ? `, ${got.attempts} executions` : '';
      return got && Number.isFinite(got.score) ? `${got.score}/10${got.lens ? ` (${got.lens}${runs})` : runs ? ` (${runs.slice(2)})` : ''}` : got ? `no score${got.status && got.status !== 'ok' ? ` (${got.status}${runs})` : runs ? ` (${runs.slice(2)})` : ''}` : 'not seated';
    }).join(' | ')} |`);
    // The PR check passes on its judge's ruling, not on every critic reaching passScore (council C10, Sol 3): the row says so.
    const judged = stage === 'prCheck';
    const passes = cols.map(({ r }) => (judged ? (r.pass ? 'PASS' : 'not passed') : r.pass ? 'pass' : 'not passed'));
    const heading = groups.size > 1 ? [`### ${COUNCIL_STAGES[stage]?.title ?? stage} (${story}${step ? `, ${step}` : ''})`, ''] : [];
    const rounds = cols.filter(({ r }) => r.round > 0).length;
    const checks = cols.length - rounds;
    const executions = cols.reduce((n, { r }) => n + (r.members ?? []).filter((m) => m.blocking).reduce((k, m) => k + (m.attempts ?? 1), 0), 0);
    const seats = cols.reduce((n, { r }) => n + (r.members ?? []).filter((m) => m.blocking).length, 0);
    const summary = `Rounds: ${rounds}${checks ? `, checks: ${checks}` : ''}${sittings.length > 1 ? ` (${sittings.length} sittings)` : ''}${executions > seats ? `; member executions: ${executions} for ${seats} seat(s) (retries after an unparsable answer)` : ''}`;
    // A sitting whose first recorded round is not round 1: the rounds before it never reached the members (council C10,
    // Opus 6: the test plan table showed only "Round 2").
    const gaps = sittings.map((list, i) => ({ i, first: list[0]?.round })).filter((x) => x.first > 1).map((x) => `${sittings.length > 1 ? `sitting ${x.i + 1}: ` : ''}round${x.first > 2 ? 's' : ''} 1${x.first > 2 ? `–${x.first - 1}` : ''} did not reach the council (the harness's checks before the members sit sent ${x.first > 2 ? 'them' : 'it'} back)`);
    // Scope objections the harness settled as notes through an earlier finding's recorded fix: every one is counted and
    // placed (council C11, Sol 3: a report said three where the records held four).
    const settledAt = cols.filter(({ r }) => r.earlierRound > 0);
    const settled = settledAt.reduce((n, { r }) => n + r.earlierRound, 0);
    if (settled) gaps.push(`${settled} scope objection${settled > 1 ? 's' : ''} accepted as a note, on adjudication by every blocking member, as required by the agreed fix of an earlier upheld finding (${settledAt.map(({ r, label }) => `${label}${r.earlierRound > 1 ? ` ×${r.earlierRound}` : ''}`).join(', ')})`);
    // Every adjudication sitting of this stage: counted as a sitting, with each objection's outcome and who answered.
    const adj = adjudications.filter((a) => `${a.stage}|${a.story}|${a.step ?? ''}` === key).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (adj.length) {
      const runs = adj.reduce((n, a) => n + (a.members ?? []).reduce((k, m) => k + (m.attempts ?? 1), 0), 0);
      gaps.push(`${adj.length} adjudication sitting${adj.length > 1 ? 's' : ''} (${runs} member execution${runs === 1 ? '' : 's'}): ${adj.flatMap((a) => (a.items ?? []).map((it) => `round ${a.round}, ${it.file}:${it.line} against ${it.earlier}: ${it.outcome === 'covered' ? `covered (yes: ${it.acceptedBy.join(', ')})` : `stands (${[it.rejectedBy?.length ? `no: ${it.rejectedBy.join(', ')}` : '', it.missing?.length ? `no answer: ${it.missing.join(', ')}` : '', it.ambiguous?.length ? `unclear: ${it.ambiguous.join(', ')}` : ''].filter(Boolean).join('; ')})`}`)).join('; ') || 'no item recorded'}`);
    }
    const notes = [...gaps, ...(judged ? ['the critics\' scores are inputs: the judge rules each finding, and the PR check passes on that ruling, not on every critic reaching the council\'s passScore'] : [])];
    blocks.push([...heading, summary, ...(notes.length ? ['', ...notes.map((n) => `- ${n[0].toUpperCase()}${n.slice(1)}.`)] : []), '', `| Member | ${cols.map((c) => c.label[0].toUpperCase() + c.label.slice(1)).join(' | ')} |`, `| --- | ${cols.map(() => '---').join(' | ')} |`, ...rows, `| ${judged ? 'Judge\'s ruling' : 'Result'} | ${passes.join(' | ')} |`].join('\n'));
  }
  return ['## Council review', '', blocks.join('\n\n')].join('\n');
}

// The council records of these stories.
export const councilRecords = (config, keys) => readMetricsLocal(config, COUNCIL_FILE).filter((r) => keys.includes(r.story));

const CSTART = '<!-- council-review:start -->';
const CEND = '<!-- council-review:end -->';
// The PR body with the "Council review" section replaced (regenerated from the latest records), or added before the
// model and harness line at the end (a trailing "Generated with" / robot line), before the demo video block, or at the end.
export function withCouncilReview(body, section) {
  let text = String(body ?? '').replace(/\r\n/g, '\n');
  const a = text.indexOf(CSTART);
  const b = text.indexOf(CEND);
  if (a >= 0 && b > a) text = `${text.slice(0, a).trimEnd()}\n\n${text.slice(b + CEND.length).trimStart()}`.trimEnd() + '\n';
  if (!section) return text;
  const block = `${CSTART}\n${section}\n${CEND}`;
  const lines = text.trimEnd().split('\n');
  const last = lines.length - 1;
  if (/^(🤖|Generated with|Model:|Harness:)/i.test(lines[last] ?? '')) return `${lines.slice(0, last).join('\n').trimEnd()}\n\n${block}\n\n${lines[last]}\n`;
  const video = text.indexOf('<!-- pr-demo-video:start -->');
  if (video >= 0) return `${text.slice(0, video).trimEnd()}\n\n${block}\n\n${text.slice(video)}`;
  return `${text.trimEnd()}\n\n${block}\n`;
}

// ---------------------------------------------------------------------------------------------
// Late results of non-blocking members
// ---------------------------------------------------------------------------------------------

// Holds the late results of a stage's non-blocking members until the next round hands them on as feedback.
export function lateBox() {
  const box = [];
  return { push: (r) => r?.status === 'ok' && box.push(r), take: () => box.splice(0) };
}

// ---------------------------------------------------------------------------------------------
// factory doctor
// ---------------------------------------------------------------------------------------------

// How doctor asks each CLI whether it is installed and signed in. Copilot's CLI has no status command: a token in the
// environment or its config folder counts as signed in.
export const CLI_PROBES = {
  claude: { installed: ['claude', ['--version']], signedIn: ['claude', ['auth', 'status']] },
  codex: { installed: ['codex', ['--version']], signedIn: ['codex', ['login', 'status']] },
  copilot: { installed: ['copilot', ['--version']], signedIn: null },
};

// Doctor rows ([what, ok, note]) for every member a stage seats: its CLI installed and signed in, and its model resolving
// to an id for that CLI. `probe(cmd, args, env)` runs a command in `env` and says whether it succeeded: each member is
// checked with its own `env` (a member with env.CODEX_HOME is checked against that login's home).
// The oldest Codex CLI that takes the factory's inline PreToolUse guard (`-c hooks.PreToolUse=...` with
// --dangerously-bypass-hook-trust): an older one would run a Codex member without the guard.
export const CODEX_MIN_VERSION = '0.167.1';
const semver = (v) => (/(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')) ?? []).slice(1).map(Number);
export const versionAtLeast = (v, min) => {
  const a = semver(v);
  const b = semver(min);
  if (a.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
const defaultVersionOf = (cmd, env) => spawnSync(cmd, ['--version'], { env, encoding: 'utf8', timeout: 60_000 }).stdout ?? '';

export function councilDoctorRows(config, { probe, env = process.env, home = env.HOME ?? '', versionOf = defaultVersionOf } = {}) {
  const pool = poolOf(config);
  // The entries something runs on: an agent's own, the first seats of every stage's council, the planner's choices.
  const used = new Set([...Object.values(setting(config, 'models.agents') ?? {}), ...subtaskModels(config), ...Object.keys(COUNCIL_STAGES).flatMap((s) => (memberCount(config, s) > 1 ? poolSeats(pool, memberCount(config, s)).map((e) => e.name) : []))]);
  const rows = [[`council seats per stage`, true, Object.keys(COUNCIL_STAGES).map((s) => `${s} ${memberCount(config, s)}`).join(', ')]];
  for (const m of pool) {
    const login = memberLogin(m);
    const label = `pool entry ${m.name} (${m.cli}${m.model ? `, ${m.model}` : ''}, family ${familyOf(m)}${login === 'default' ? '' : `, ${login}`})`;
    // An entry nothing runs on is listed, never a failure.
    const row = (what, ok, detail) => rows.push([`${label}: ${what}`, ok || !used.has(m.name), ok || used.has(m.name) ? detail : `${detail} (no agent or council seat uses this entry)`]);
    let menv;
    try {
      menv = { ...env, ...agentEnv(m.env, env) };
    } catch (error) {
      row('environment', false, error.message);
      continue;
    }
    if (m.cli === 'custom') {
      const bin = String(m.cmd ?? '').trim().split(/\s+/)[0];
      row('command installed', Boolean(bin) && probe('sh', ['-c', `command -v ${JSON.stringify(bin)}`], menv), m.cmd);
      continue;
    }
    const p = CLI_PROBES[m.cli];
    const installed = probe(...p.installed, menv);
    row('CLI installed', installed, installed ? '' : `\`${p.installed[0]}\` is not on PATH; the council does not substitute another model (council.onUnavailable ${setting(config, 'council.onUnavailable')})`);
    if (installed && m.cli === 'codex') {
      const v = String(versionOf('codex', menv)).trim();
      const ok = versionAtLeast(v, CODEX_MIN_VERSION);
      row('CLI version runs the factory guard', ok, ok ? v : `${v || 'unknown version'}: codex ${CODEX_MIN_VERSION} or later is needed for the inline PreToolUse guard (-c hooks.PreToolUse with --dangerously-bypass-hook-trust); update codex`);
    }
    const signedIn = !installed ? false : p.signedIn ? probe(...p.signedIn, menv) : Boolean(menv.COPILOT_GITHUB_TOKEN || menv.GH_TOKEN || menv.GITHUB_TOKEN || fs.existsSync(menv.COPILOT_HOME ?? path.join(home, '.copilot')));
    row('signed in', signedIn, signedIn ? '' : `sign in to ${m.cli}${login === 'default' ? '' : ` with ${login}`} on this machine`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The implementer and fixer side
// ---------------------------------------------------------------------------------------------

// How the agent that acts on the findings (implementer, pair implementer, PR check fixer, test automation agent)
// handles DELETE TEST and REWRITE findings. Added to its task only when a council sits for the stage, so the agent
// definitions (and their prompt versions) are what they are without a council. `refuse` says how that agent declines a
// protected test; `owns` whether a rewrite is also bounded by its owns.
export function councilActionsText({ refuse = 'dispute the finding (`kind` `out-of-scope`)', owns = true } = {}) {
  return [
    '### Council findings: deleting tests and rewrites',
    '',
    'A council of verifiers reviews this work. Two kinds of finding ask for more than a patch:',
    '',
    `- **DELETE TEST**: the council upheld that a test adds no protection (it asserts what the compiler, the framework or a mock already guarantees, repeats another test with different literals, tests a getter, constructor or constant, mocks the thing under test, or restates the implementation line by line). Delete that test; do not rewrite or weaken it. The harness never hands you a test that is the only cover for an acceptance line or an error path, a regression test kept for an upheld finding (\`kept-for\` in the plan), or another story's test, and it restores such a test if one is deleted; if one reaches you anyway, keep it and ${refuse}, naming the protection.`,
    `- **REWRITE**: nothing on the feature branch is precious. Delete what the branch added or changed in the regions the finding names and write it again the way it describes, inside the ticket. Do not patch code the rewrite deletes: it replaces every finding inside those regions. A rewrite that would need code outside the ticket${owns ? ' or your `owns`' : ''} is a follow-up, not part of this change.`,
    '- When council members disagree on a finding, both positions are given: do what the evidence supports and say why in your result; if the ticket does not settle it, say so for the ticket\'s owner.',
  ].join('\n');
}

// Test files, as the story guard recognises them (story-guard.mjs foreignTestGuard).
const TEST_FILE = /(^|\/)(e2e|tests?|[^/]*\.Tests?)\/|\.(spec|test)\.[cm]?[jt]sx?$|Tests?\.cs$/i;

// After an implementer, fixer or test automation round in a stage with a council: every test deleted since `from` (the
// round's start; committed or not) that is protected (testProtection: another story's, kept for an upheld finding, the
// only cover of an acceptance line) is restored to its content at `from`, so a delete-test finding can never take it,
// whatever the prompt said. A whole deleted file comes back; a test removed from a file brings that file back as it
// was, and the returned violations say so (the caller tells the agent, which redoes its other changes to the file).
// Tests are named by their plan case ids (TC-<KEY>-<n>-<nn>) and their file's ticket key.
export function guardProtectedTests({ cwd, from, keys = [], cases = [], restore = true }) {
  const status = run('git', ['diff', '--name-status', '--no-renames', from], { cwd });
  if (status.status !== 0) return [];
  const untracked = new Set(run('git', ['ls-files', '--others', '--exclude-standard'], { cwd }).stdout.split('\n').filter(Boolean));
  const violations = [];
  for (const line of status.stdout.split('\n').filter(Boolean)) {
    const [kind, file] = line.split('\t');
    if (!file || !TEST_FILE.test(file) || untracked.has(file) || !['D', 'M'].includes(kind[0])) continue;
    const old = run('git', ['show', `${from}:${file}`], { cwd }).stdout;
    const now = kind[0] === 'D' ? '' : fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : '';
    const still = new Set(caseIdsOf(now));
    const removed = [...new Set(caseIdsOf(old))].filter((id) => !still.has(id));
    const reasons = new Set();
    if (kind[0] === 'D') {
      const why = testProtection({ file, test: removed.join(' '), text: '' }, { keys, cases });
      if (why) reasons.add(why);
    }
    for (const id of removed) {
      const why = testProtection({ file, test: id, text: '' }, { keys, cases });
      if (why) reasons.add(why);
    }
    if (!reasons.size) continue;
    violations.push({ file, deleted: kind[0] === 'D', tests: removed, reasons: [...reasons] });
    if (restore) run('git', ['checkout', from, '--', file], { cwd });
  }
  return violations;
}

// The finding an agent gets for a protected test it deleted (the harness restored it).
export const protectedTestFinding = (v) => ({
  severity: 'blocking',
  category: 'tests',
  file: v.file,
  line: null,
  issue: `${v.deleted ? 'You deleted' : 'You removed tests from'} ${v.file}${v.tests.length ? ` (${v.tests.join(', ')})` : ''}, which is protected: ${v.reasons.join('; ')}. The harness restored the file as it was before your round.`,
  fix: `Keep the protected test${v.deleted ? '' : '; redo any other change you made to this file without removing it'}. If a council finding asked you to delete it, dispute that finding and name the protection.`,
});

// ---------------------------------------------------------------------------------------------
// Detached members (a stage whose process ends with the round)
// ---------------------------------------------------------------------------------------------

export const COUNCIL_MEMBER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'council-member.mjs');

// Starts a member as its own detached process (council-member.mjs) and resolves with its run result when its result file
// appears. A member still running when the stage's process exits keeps running and leaves the file for the next round.
// `dir` is the stage's council folder for the story; `stageDir` the stage's config folder (loadConfig). `hold: false`
// when nobody waits for the member (a non-blocking member with no discussion): its poll then never keeps the stage's
// process alive, so the stage ends with its blocking members.
// `record`: what its run records its findings under when it finishes (findings.mjs recordFeedback), for a non-blocking member.
export function runDetachedMember({ root, stageDir, dir, round, member, run: runOpts, pollMs = 300, spawnImpl = null, hold = true, record = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `r${round}-${member.name}.result.json`);
  const job = path.join(dir, `r${round}-${member.name}.job.json`);
  fs.rmSync(out, { force: true });
  fs.writeFileSync(job, JSON.stringify({ root, stage: stageDir, round, member: member.name, out, run: runOpts, ...(record ? { record } : {}) }));
  const start = spawnImpl ?? ((cmd, args, opts) => import('node:child_process').then(({ spawn }) => spawn(cmd, args, opts).unref()));
  return Promise.resolve(start(process.execPath, [COUNCIL_MEMBER_SCRIPT, job], { cwd: root, detached: true, stdio: 'ignore', env: process.env, windowsHide: true })).then(
    () =>
      new Promise((resolve) => {
        // A runner killed before it wrote anything: give up after ten times the member's time limit.
        const giveUp = Date.now() + (runOpts.timeoutSec ?? 1800) * 10_000;
        const tick = () => {
          if (Date.now() > giveUp) return resolve({ status: 1, output: '', timedOut: true });
          // The runner removes its job file only after writing the result: neither left means a later round took it.
          if (!fs.existsSync(out) && !fs.existsSync(job)) return resolve({ status: 1, output: '', consumed: true });
          if (fs.existsSync(out)) {
            try {
              return resolve({ ...JSON.parse(fs.readFileSync(out, 'utf8')), resultFile: out });
            } catch {
              // still being renamed into place
            }
          }
          const timer = setTimeout(tick, pollMs);
          if (!hold) timer.unref?.();
        };
        tick();
      }),
  );
}

// The results of earlier rounds' members that finished after their round (files left in `dir`), parsed with the stage's
// `parse`, as feedback for this round; each file is consumed once.
export function takeLate(dir, round, members, parse) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.result.json'))) {
    const m = /^r(\d+)-(.+)\.result\.json$/.exec(f);
    if (!m || Number(m[1]) >= round) continue;
    const file = path.join(dir, f);
    try {
      const res = JSON.parse(fs.readFileSync(file, 'utf8'));
      const member = members.find((x) => x.name === m[2]);
      const parsed = member && res.status === 0 ? parse(res.output ?? '', member) : null;
      if (parsed) out.push({ member, status: 'ok', ...parsed, findings: (parsed.findings ?? []).map((x) => normalizeFinding(x, member)) });
    } catch {
      // unreadable: dropped
    }
    fs.rmSync(file, { force: true });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-member (and per-role) environment
// ---------------------------------------------------------------------------------------------


// The variables a council member's agent run gets: its seat name (for the guards and fake agents) and its login label.
// The member's name and login label also reach its usage rows (agents.mjs reads them back from the run's environment).
// The entry's own `env` reaches the run through its pool entry (agents.mjs).
export const memberRunEnv = (m) => ({ PIPELINE_COUNCIL_MEMBER: m.name, PIPELINE_COUNCIL_LOGIN: memberLogin(m), ...(m.lens ? { PIPELINE_COUNCIL_LENS: m.lens } : {}) });

// Which login a member's CLI used, for the metrics and the PR table: the CLI's home-folder variable as configured (never
// expanded, so no path or secret is recorded beyond what the settings say), or "default".
export const LOGIN_HOMES = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'HOME'];
export function memberLogin(m) {
  const set = LOGIN_HOMES.filter((k) => m?.env?.[k] != null).map((k) => `${k}=${m.env[k]}`);
  return set.length ? set.join(' ') : 'default';
}
