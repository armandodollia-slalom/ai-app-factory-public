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
import { COUNCIL_DEFAULTS, COUNCIL_LENSES, COUNCIL_STAGES, seatedNames } from './council-config.mjs';
import { logDecision } from './decisions.mjs';
import { metricsFile, readMetricsLocal } from './state.mjs';
import { appendJsonl, log as defaultLog, nowIso, parseFrontMatter, readJson, run, sha, writeJson } from './util.mjs';

export { COUNCIL_STAGES, COUNCIL_LENSES };
export const COUNCIL_FILE = 'council-rounds.jsonl';
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SKILL_FILE = path.join(INSTALL_ROOT, 'skills', 'council', 'SKILL.md');

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const SEVERITY_RANK = { blocking: 0, major: 1, minor: 2 };
const ACTIONS = ['fix', 'delete-test', 'rewrite'];

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

// The council a stage seats, or null when it has none (the stage then runs its single verifier, as without a council).
// Members are resolved to { name, cli, model, effort, lens, blocking, cmd, timeoutSec }.
export function councilFor(config, stage) {
  const c = config?.council;
  if (!c || !c.stages || !Object.hasOwn(c.stages, stage)) return null;
  const byName = new Map((c.members ?? []).map((m) => [m.name, m]));
  const lenses = c.stages[stage]?.lenses ?? {};
  const members = seatedNames(c, stage).map((n) => byName.get(n)).filter(Boolean).map((m) => ({ effort: null, cmd: null, timeoutSec: null, ...m, lens: lenses[m.name] ?? m.lens, blocking: m.blocking !== false }));
  if (!members.length) return null;
  return {
    stage,
    rounds: c.stages[stage].rounds ?? c.rounds ?? COUNCIL_DEFAULTS.rounds,
    passScore: c.passScore ?? COUNCIL_DEFAULTS.passScore,
    blockOn: c.blockOn ?? COUNCIL_DEFAULTS.blockOn,
    onUnavailable: c.onUnavailable ?? COUNCIL_DEFAULTS.onUnavailable,
    members,
  };
}

// The round limit of a stage: its council's (council.stages.<stage>.rounds, else council.rounds) when it seats one,
// otherwise the stage's own setting (`fallback`).
export const councilRounds = (config, stage, fallback) => councilFor(config, stage)?.rounds ?? fallback;

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

// What a member's task adds to the stage's own task: who it is, its lens, the council's output fields, the disputes it
// rules on and the skill. The stage's own instructions and AGENT_RESULT contract stay as they are; the lens adds to them.
export function memberTask(task, { council, member, round, disputes = '', earlier = '', skill = skillText() }) {
  const seat = council.members.map((m) => `${m.name} (${m.lens}${m.blocking ? '' : ', non-blocking'})`).join(', ');
  return [
    task,
    '',
    '## Council member',
    '',
    `You are one of ${council.members.length} council members who review this change independently: ${seat}. You are **${member.name}**; your lens is **${member.lens}**: ${COUNCIL_LENSES[member.lens]} Look through it first; report what you find outside it only when it is blocking.`,
    `Council round ${round} of at most ${council.rounds}. The council passes when every blocking member scores ${council.passScore}/10 or more and no blocking finding stands.${member.blocking ? '' : ' You are non-blocking: your findings are feedback and your score is not recorded.'}`,
    '',
    // Rule 3 binds the change as much as the review (dogfood C14: a fix added a 9999 per-item quantity limit no line of
    // the ticket asked for, and nothing in the review was charged with noticing).
    'Whatever your lens, check the change itself for scope: behaviour the ticket does not ask for (a new limit, error, default, message, field or side effect; an existing behaviour changed or removed) is a blocking finding with `lens` "acceptance" and `kind` "scope", unless a line of the ticket or the subtask, or a finding the council upheld in an earlier round (listed below when there is one), requires it; name that behaviour, the file and line, and say that no ticket line asks for it. Code already on the base branch that the change does not touch is not the change.',
    ...(earlier ? ['', earlier] : []),
    '',
    'Keep the instructions and the `AGENT_RESULT` contract above exactly as they are. The council adds these fields to the same JSON object:',
    '',
    '- `score`: 0-10 for the change against the ticket, through your lens. Leave it out only when you cannot score, and say why in `summary`.',
    '- on every finding: `lens`, `severity` (`blocking`, `major` or `minor`; major blocks like blocking where the contract above knows only blocking and minor), `action` (`fix`, `delete-test` or `rewrite`) and `evidence` (file and line, a command and its output, or a screenshot). Keep a finding\'s `id` whenever you raise it again.',
    '- a `delete-test` finding (severity `major`) names the test in `test`, its file in `file`, and in `evidence` the bug that would still be caught without it.',
    '- a `rewrite` finding lists what to delete in `deletes` (files, or `file:start-end` regions the branch added or changed), the new approach in `approach` (five lines or fewer), `why` it is better for this ticket, and the acceptance lines it `covers`.',
    '- `followUps`: `[{"title": "...", "reason": "..."}]` for real problems outside the ticket; they are not findings.',
    ...(disputes ? ['', '### Implementer disputes of findings you raised', '', 'The implementer did not act on these and says why. Rule on each in `disputes: [{"finding": "<id>", "decision": "accepted" | "reasserted", "evidence": "<why>"}]`; re-raise a finding (same id) only with new evidence that the ticket requires it.', '', disputes] : []),
    ...(skill ? ['', '### The council skill (the rules every member follows)', '', skill.replace(/^#{1,2} /gm, (h) => `#${h}`)] : []),
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
export function memberScore(raw) {
  const n = Number(raw?.score);
  return raw?.score === undefined || raw?.score === null || raw?.score === '' || !Number.isFinite(n) ? null : Math.max(0, Math.min(10, Math.round(n)));
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

// A fingerprint of a checkout's working tree (tracked changes and untracked files), without the folders the harness
// itself writes to while members run (metrics, state, prompts).
export function treeFingerprint(cwd, exclude = []) {
  const specs = ['.', ...exclude.filter(Boolean).map((e) => `:(exclude)${e}`)];
  const status = run('git', ['status', '--porcelain=v1', '-uall', '--', ...specs], { cwd });
  if (status.status !== 0) return null;
  const diff = run('git', ['diff', 'HEAD', '--', ...specs], { cwd });
  return sha(`${status.stdout}\n${diff.stdout}`, 16);
}

// Seats the council: every member runs at once through `run(member, task, { signal })` (the stage's own agent call,
// which owns the semaphore, the budget and the CLI). `parse(output, member)` reads the stage's contract and returns
// { score, verdict, summary, findings, disputes, followUps } or null. A blocking member is waited for; a non-blocking
// member is not: when the last blocking member has answered, a non-blocking one still running is left to finish in the
// background and its result goes to `onLate` (the caller hands it on as feedback; its score is never recorded).
// `readOnly` (a checkout and the folders to ignore) fails the round when any member changed the working tree: every
// CLI's read-only mode is enforced by the CLI, and this catches what got past it (a custom command).
export async function runCouncil({ council, run: runMember, parse, taskFor, retries = 0, onLate = null, readOnly = null, log = defaultLog }) {
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
      if (parsed) return { ...base, attempts: Math.max(tries, 1), status: 'ok', ...parsed, findings: (parsed.findings ?? []).map((f) => normalizeFinding(f, m)), res, seconds: Math.round((Date.now() - t0) / 1000) };
      log(`council ${council.stage}: ${m.name} returned no parsable result (attempt ${i + 1})`);
    }
    return { ...base, attempts: Math.max(tries, 1), status: 'failed', reason: 'no parsable result', res, seconds: Math.round((Date.now() - t0) / 1000) };
  };
  const promises = new Map(council.members.map((m) => [m.name, attempt(m)]));
  const settled = new Map();
  for (const [name, p] of promises) p.then((r) => settled.set(name, r), (e) => settled.set(name, { member: council.members.find((m) => m.name === name), status: 'failed', reason: e?.message ?? String(e) }));
  const blocking = council.members.filter((m) => m.blocking);
  await Promise.all(blocking.map((m) => promises.get(m.name)));
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

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

const STOP = new Set('the and for with that this from are was not but can its has have when then given into than any all each only must should will does test tests'.split(' '));
const words = (t) => new Set((String(t ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
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

const needed = (blockOn, n) => (blockOn === 'all' ? n : blockOn === 'majority' ? Math.floor(n / 2) + 1 : 1);

// Merges the members' results into one council result. Deterministic: findings are clustered in member order;
// `protect(finding)` (the stage's test protections) returns why a delete-test finding may not be acted on, or null.
// Returns {
//   pass, error, score (lowest blocking member score), members (per-member status and score),
//   findings (merged findings that stand: severity blocking/major; each with `members` and every member's `evidence`),
//   notes (minor findings, findings blockOn did not uphold, protected and superseded ones, non-blocking feedback),
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

export function mergeCouncil(council, results, { protect = null, feedback = [], violation = null, changed = null, earlier = null, root = null } = {}) {
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
  let error = violation;
  if (!error && unavailable.some((r) => r.member.blocking) && council.onUnavailable === 'fail') {
    error = `council member(s) unavailable: ${unavailable.filter((r) => r.member.blocking).map((r) => `${r.member.name} (${r.member.cli}): ${r.reason}`).join('; ')} (council.onUnavailable is fail; no other model is substituted)`;
  }
  if (!error && !okBlocking.length) error = `no blocking council member gave a result (${results.filter((r) => r.member.blocking).map((r) => `${r.member.name}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join('; ')})`;
  const base = { members, unavailable: unavailable.map((r) => ({ name: r.member.name, cli: r.member.cli, reason: r.reason })), blockOn: council.blockOn, passScore: council.passScore };
  if (error) return { ...base, pass: false, error, score: null, findings: [], notes: [], contradictions: [], rewrites: [], disputes: [], followUps: [], summary: error };

  // Cluster same-defect findings across members.
  const clusters = [];
  for (const r of ok) {
    for (const f of r.findings) {
      const c = clusters.find((x) => x.items.some((y) => sameDefect(y, f)) && !x.items.some((y) => y.member === f.member));
      if (c) c.items.push(f);
      else clusters.push({ items: [f] });
    }
  }
  const threshold = needed(council.blockOn, okBlocking.length);
  const blockingNames = new Set(okBlocking.map((r) => r.member.name));
  const merged = clusters.map((c) => {
    const first = c.items[0];
    const raisers = [...new Set(c.items.map((f) => f.member))];
    const backing = [...new Set(c.items.filter((f) => blockingNames.has(f.member) && f.severity !== 'minor').map((f) => f.member))];
    const worst = c.items.filter((f) => blockingNames.has(f.member)).map((f) => f.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? 'minor';
    const actions = [...new Set(c.items.map((f) => f.action))];
    const upheld = worst !== 'minor' && backing.length >= threshold;
    const out = {
      ...first,
      id: c.items.map((f) => str(f.id)).find(Boolean) || undefined,
      severity: upheld ? worst : 'minor',
      members: raisers,
      upheldBy: upheld ? backing : [],
      evidence: c.items.map((f) => (f.evidence ? `${f.member}: ${f.evidence}` : '')).filter(Boolean).join('\n') || first.evidence,
      memberEvidence: c.items.map((f) => ({ member: f.member, evidence: f.evidence, text: f.text, action: f.action, severity: f.severity, file: f.file ?? null, line: f.line ?? null, ...(str(f.kind) ? { kind: str(f.kind) } : {}) })),
    };
    if (!upheld && worst !== 'minor') out.notUpheld = `raised by ${backing.join(', ')}; council.blockOn "${council.blockOn}" needs ${threshold} blocking member(s)`;
    // Rule 4: no member of the cluster gave evidence. A question for the record, never a fix cycle.
    if (out.severity !== 'minor' && !c.items.some((f) => hasEvidence(f, root))) {
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
    if (out.severity !== 'minor' && out.action === 'fix' && asksNoChange(out)) {
      out.severity = 'minor';
      out.upheldBy = [];
      out.notUpheld = `the finding asks for no change ("${fixOf(out).slice(0, 120)}"); a blocking finding must name a change`;
      out.noChange = true;
    }
    // A later round objects to the fix of a finding the council upheld in an earlier round (rule 3's scope objection on
    // lines the change made since then): the earlier ruling stands and the objection is a note, settled by the harness
    // instead of ending the story unresolved. A defect in how the fix was done is not a scope objection and still blocks.
    const sanction = out.severity !== 'minor' ? sanctionedBy(out, earlier) : null;
    if (sanction) {
      out.severity = 'minor';
      out.upheldBy = [];
      out.sanctionedBy = sanction.map((u) => u.id);
      out.notUpheld = `the change it objects to answers ${sanction.map((u) => `${u.id} (upheld in round ${u.round}${fixOf(u) ? `; agreed fix: ${fixOf(u).slice(0, 160)}` : ''})`).join('; ')}; a change an upheld finding requires is in scope`;
    }
    // Two members ask opposite things of the same test: neither position is picked silently.
    if (actions.includes('delete-test') && actions.includes('fix')) {
      out.contested = c.items.map((f) => ({ member: f.member, action: f.action, evidence: f.evidence || f.text }));
    }
    return out;
  });

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
  for (const f of merged) if (f.severity === 'minor' || f.supersededBy) notes.push(f);
  for (const r of feedback) for (const f of r.findings ?? []) notes.push({ ...normalizeFinding(f, r.member), severity: 'minor', feedback: true });

  // Pass: every blocking member scores passScore or more and no blocking finding stands. A blocking member's low score
  // counts unless every non-minor finding it raised was outvoted by blockOn; a low score with no blocking finding at
  // all is a finding of its own (the member must say what is wrong).
  const low = [];
  for (const r of okBlocking) {
    const passes = r.score == null ? r.verdict === 'APPROVED' : r.score >= council.passScore;
    if (passes) continue;
    const raised = merged.filter((f) => f.members.includes(r.member.name) && f.memberEvidence.some((e) => e.member === r.member.name && e.severity !== 'minor'));
    if (raised.length && raised.every((f) => f.notUpheld)) continue;
    low.push(r);
    if (!raised.length) {
      standing.push({ id: `council-${r.member.name}-score`, member: r.member.name, members: [r.member.name], upheldBy: [r.member.name], lens: r.member.lens, severity: 'blocking', action: 'fix', file: null, line: null, text: `${r.member.name} scored ${r.score ?? 'no score'}/10 (below ${council.passScore}) without a blocking finding`, issue: `${r.member.name} scored ${r.score ?? 'no score'}/10 (below ${council.passScore}) without a blocking finding: ${str(r.summary) || 'no reason given'}`, evidence: str(r.summary), harness: true });
    }
  }
  const missing = results.filter((r) => r.member.blocking && r.status !== 'ok');
  const scores = okBlocking.map((r) => r.score).filter((s) => s != null);
  const pass = !standing.length && !low.length && (!missing.length || council.onUnavailable === 'report') && !failed.length;
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
    earlierRound: merged.filter((f) => f.sanctionedBy).map((f) => ({ id: f.id ?? null, subject: f.text, file: f.file ?? null, line: f.line ?? null, earlier: f.sanctionedBy, resolution: 'the earlier upheld finding stands; this objection is a note' })),
    rewrites,
    disputes: mergeRulings(ok, merged),
    followUps: [...ok.flatMap((r) => (r.followUps ?? []).filter((u) => str(u?.title)).map((u) => ({ title: str(u.title), reason: str(u.reason), member: r.member.name }))), ...merged.filter((f) => f.outsideChange).map((f) => ({ title: String(f.text ?? f.issue ?? f.id).split('\n')[0].slice(0, 160), reason: f.notUpheld, member: (f.members ?? [])[0] ?? null }))],
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
// Whether a finding's own fix asks for nothing.
export const asksNoChange = (f) => NO_CHANGE.test(fixOf(f)) && fixOf(f) !== '';
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

const upheldRecord = (f) => ({ id: str(f.id) || null, text: (str(f.text) || str(f.issue) || str(f.title)).slice(0, 600), fix: fixOf(f).slice(0, 600), file: f.file ?? null, line: Number.isFinite(f.line) ? f.line : null, members: f.upheldBy?.length ? f.upheldBy : f.members ?? [] });

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
    `One entry per finding you changed code for (${ids.map((i) => `\`${i}\``).join(', ')}), listing only the line ranges, as the files stand when you finish, that you added or changed to carry out that finding's agreed fix. Do not list lines you changed for another reason (another finding, clean-up, code you only moved), and leave out a finding you changed nothing for. A later objection that a line is outside the ticket is settled without the council only for new lines listed here under exactly one finding; everything else goes back to the council.`,
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
    return remedyCovers(finding, rel) ? [finding] : null;
  };
  const upheld = [...here, ...elsewhere].slice(-20);
  return {
    upheld,
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
  return `Council (${council.stage}, blockOn ${council.blockOn}, pass ${council.passScore}/10): ${pass ? 'passed' : 'not passed'}; ${scores}; ${standing.length} finding(s) stand, ${notes.length} note(s)${contradictions.length ? `, ${contradictions.length} contradiction(s) between members` : ''}.`;
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
  const dir = path.join(root, plansDir ?? '.factory/plans', key);
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
export function recordCouncilRound(config, { stage, story, step = null, round, council, merged }) {
  const rec = {
    ts: nowIso(),
    stage,
    story,
    ...(step ? { step } : {}),
    round,
    rounds: council.rounds,
    passScore: council.passScore,
    blockOn: council.blockOn,
    pass: Boolean(merged.pass),
    ...(merged.error ? { error: String(merged.error).slice(0, 500) } : {}),
    score: merged.score ?? null,
    members: merged.members,
    standing: (merged.findings ?? []).length,
    notes: (merged.notes ?? []).length,
    contradictions: (merged.contradictions ?? []).length,
    rewrites: (merged.rewrites ?? []).length,
    superseded: (merged.superseded ?? []).length,
    ...((merged.earlierRound ?? []).length ? { earlierRound: merged.earlierRound.length } : {}),
    ...((merged.questions ?? []).length ? { noEvidence: merged.questions.length } : {}),
  };
  try {
    appendJsonl(metricsFile(config, COUNCIL_FILE), rec);
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
  for (const r of [...records].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
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
    if (settled) gaps.push(`${settled} scope objection${settled > 1 ? 's' : ''} settled as a note by the recorded fix of an earlier upheld finding (${settledAt.map(({ r, label }) => `${label}${r.earlierRound > 1 ? ` ×${r.earlierRound}` : ''}`).join(', ')})`);
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
  const c = config?.council;
  if (!c?.stages) return [];
  const seated = new Set(Object.keys(c.stages).flatMap((s) => seatedNames(c, s)));
  const rows = [];
  for (const m of (c.members ?? []).filter((x) => seated.has(x.name))) {
    const login = memberLogin(m);
    const label = `council member ${m.name} (${m.cli}${m.model ? `, ${m.model}` : ''}${login === 'default' ? '' : `, ${login}`})`;
    let menv;
    try {
      menv = { ...env, ...agentEnv(m.env, env) };
    } catch (error) {
      rows.push([`${label}: environment`, false, error.message]);
      continue;
    }
    if (m.cli === 'custom') {
      const bin = String(m.cmd ?? '').trim().split(/\s+/)[0];
      rows.push([`${label}: command installed`, Boolean(bin) && probe('sh', ['-c', `command -v ${JSON.stringify(bin)}`], menv), m.cmd]);
      continue;
    }
    const p = CLI_PROBES[m.cli];
    const installed = probe(...p.installed, menv);
    rows.push([`${label}: CLI installed`, installed, installed ? '' : `\`${p.installed[0]}\` is not on PATH; the council does not substitute another model (council.onUnavailable ${c.onUnavailable ?? 'fail'})`]);
    if (installed && m.cli === 'codex') {
      const v = String(versionOf('codex', menv)).trim();
      const ok = versionAtLeast(v, CODEX_MIN_VERSION);
      rows.push([`${label}: CLI version runs the factory guard`, ok, ok ? v : `${v || 'unknown version'}: codex ${CODEX_MIN_VERSION} or later is needed for the inline PreToolUse guard (-c hooks.PreToolUse with --dangerously-bypass-hook-trust); update codex`]);
    }
    const signedIn = !installed ? false : p.signedIn ? probe(...p.signedIn, menv) : Boolean(menv.COPILOT_GITHUB_TOKEN || menv.GH_TOKEN || menv.GITHUB_TOKEN || fs.existsSync(menv.COPILOT_HOME ?? path.join(home, '.copilot')));
    rows.push([`${label}: signed in`, signedIn, signedIn ? '' : `sign in to ${m.cli}${login === 'default' ? '' : ` with ${login}`} on this machine`]);
    const id = config.agent?.modelIds?.[m.cli]?.[m.model];
    rows.push([`${label}: model resolves`, Boolean(id), id ? `${m.model} -> ${id}` : `agent.modelIds.${m.cli}.${m.model} is missing`]);
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
// `dir` is the stage's council folder for the story; `stageDir` the stage's config folder (loadConfig).
export function runDetachedMember({ root, stageDir, dir, round, member, run: runOpts, pollMs = 300, spawnImpl = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `r${round}-${member.name}.result.json`);
  const job = path.join(dir, `r${round}-${member.name}.job.json`);
  fs.rmSync(out, { force: true });
  fs.writeFileSync(job, JSON.stringify({ root, stage: stageDir, round, member: member.name, memberEnv: member.env ?? null, out, run: runOpts }));
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
          setTimeout(tick, pollMs);
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

// An `env` map (council member or implement role; validated by council-config.mjs envProblems) as the variables its CLI
// process gets: `${NAME}` from this process's environment (an unset one stops the run, as the metrics sink does) and a
// leading `~` as the home folder.
export function agentEnv(envMap, env = process.env, home = os.homedir()) {
  const out = {};
  for (const [k, v] of Object.entries(envMap ?? {})) {
    const expanded = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] == null) throw new Error(`env.${k} needs the environment variable ${name}, which is not set`);
      return env[name];
    });
    out[k] = expanded === '~' || expanded.startsWith('~/') ? path.join(home, expanded.slice(1)) : expanded;
  }
  return out;
}

// The variables a council member's agent run gets: its name (for the guards and fake agents) and its own `env`.
// The member's name and login label also reach its usage rows (agents.mjs reads them back from the run's environment).
export const memberRunEnv = (m) => ({ PIPELINE_COUNCIL_MEMBER: m.name, PIPELINE_COUNCIL_LOGIN: memberLogin(m), ...agentEnv(m.env) });

// Which login a member's CLI used, for the metrics and the PR table: the CLI's home-folder variable as configured (never
// expanded, so no path or secret is recorded beyond what the settings say), or "default".
export const LOGIN_HOMES = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'HOME'];
export function memberLogin(m) {
  const set = LOGIN_HOMES.filter((k) => m?.env?.[k] != null).map((k) => `${k}=${m.env[k]}`);
  return set.length ? set.join(' ') : 'default';
}
