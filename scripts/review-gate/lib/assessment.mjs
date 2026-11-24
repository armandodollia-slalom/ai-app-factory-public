// Assessment of a published fix PR: the triage agent's ratings per ticket, plus everything the harness
// computes from the diff and the pipeline's records (systems, severity, confidence), recorded on the
// tickets (issue body `## Triage`, board fields) and in the decision log (`bug-triage`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { nowIso, readJsonl } from '../../pipeline/lib/util.mjs';
import { readMeta, ticketFile } from '../../board/lib/source.mjs';
import { runTriage } from './assess.mjs';
import { confidence, ticketSignals } from './confidence.mjs';
import { setTicketBody, setTriageFields, ticketBody } from './fields.mjs';
import { checksState, prNumber } from './github.mjs';
import { mergeReopens } from './reopens.mjs';
import { recordedReopens } from './rejections.mjs';
import { ciTarget } from '../../pipeline/lib/ci/index.mjs';
import { floorReasons, prClass, prSeverity, ticketSeverity } from './severity.mjs';
import { overridePathsHit, systemsTouched, gateSystemsSettings } from './systems.mjs';
import { extractTriage, upsertTriage } from './triage-section.mjs';
import { readMetricsLocal } from '../../pipeline/lib/state.mjs';
import { headActivities } from '../../implement/lib/pre-open.mjs';

export const TRIAGE_STAGE = 'bug-triage';

// The main checkout of a worktree (the git common dir's parent): where board sync and the group
// outcomes write their metrics, since a published PR's branch must not get new commits for them.
export function mainCheckout(cwd) {
  const r = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common && path.basename(common) === '.git' ? path.dirname(common) : cwd;
}

const lines = (s) => String(s ?? '').split('\n').filter(Boolean);

export function prFilesLocal(cwd, base) {
  return lines(git(cwd, ['diff', '--name-only', `${base}...HEAD`]).stdout);
}

// Files the PR adds (a new project's manifest floors the severity: its class is derived, and a person sees it).
export function prAddedFilesLocal(cwd, base) {
  return lines(git(cwd, ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]).stdout);
}

// The PR's own change, as a key a rating is bound to: what a reviewer reads as its content in the diff between the merge
// base with the target branch and the head: each file's path, the header lines of a new or deleted file, a mode change,
// a rename or copy, binary files, every added and removed line and the line of context on each side of a change (so a
// moved line, a `chmod`, a rename and an added empty file change it). Line numbers, blob ids and the rest of the context
// are left out, and so are the pipeline's records, so the pipeline's own base merges keep it (a diff with more context,
// the host's, gives the same key); any commit that changes the PR's own diff changes it. Null when there is no diff.
const RECORDS = /^(?:\.factory\/metrics\/|\.factory\/state\/|graphify-out\/)/;
const HEADER = /^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|Binary files) /;
export function diffKey(diff) {
  if (typeof diff !== 'string') return null;
  const hash = crypto.createHash('sha256');
  let file = null;
  let hunk = [];
  const flush = () => {
    hunk.forEach((l, i) => {
      const change = l[0] === '+' || l[0] === '-';
      // Context is kept only right beside a change: the same whatever context the diff was made with.
      if (change || hunk[i - 1]?.[0] === '+' || hunk[i - 1]?.[0] === '-' || hunk[i + 1]?.[0] === '+' || hunk[i + 1]?.[0] === '-') hash.update(`${file}\t${l}\n`);
    });
    hunk = [];
  };
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      flush();
      inHunk = false;
      file = head[2];
      if (!RECORDS.test(file)) hash.update(`file\t${head[1]}\t${file}\n`);
    } else if (!file || RECORDS.test(file)) continue;
    else if (line.startsWith('@@')) {
      flush();
      inHunk = true;
      hash.update(`${file}\t@@\n`);
    } else if (inHunk && /^[ +-]/.test(line)) hunk.push(line);
    else if (HEADER.test(line)) {
      flush();
      inHunk = false;
      hash.update(`${file}\t${line}\n`);
    }
  }
  flush();
  return hash.digest('hex').slice(0, 24);
}
// The key of `head` (default HEAD) in `cwd` against the target branch `base`, or null when the merge base cannot be told
// for sure (then no rating counts for it: it is rated again, never taken as the same nor silently as another change).
// The merge base is the newest one of: the target fetched from the remote now (with no remote, the local branch), and
// the base side of every merge on the head's first-parent line that descends from the target (the pipeline's base
// merges), so a stale remote-tracking ref does not count; a remote that cannot be fetched leaves only those merges.
export function localDiffKey(cwd, base, head = 'HEAD') {
  const sha = (ref) => {
    const r = ref ? git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) : null;
    return r?.status === 0 ? r.stdout.trim() : null;
  };
  const tip = sha(head);
  if (!tip || !base) return null;
  const name = String(base).replace(/^origin\//, '');
  const remote = git(cwd, ['remote', 'get-url', 'origin']).status === 0;
  const fetched = remote && git(cwd, ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).status === 0;
  const target = fetched ? sha(`origin/${name}`) : remote ? null : sha(name);
  const known = [target, sha(`origin/${name}`), sha(name)].filter(Boolean);
  const merges = git(cwd, ['rev-list', '--first-parent', '--merges', '--parents', '-n', '200', tip]).stdout.split('\n').map((l) => l.trim().split(/\s+/)[2]).filter(Boolean);
  const isAncestor = (a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b]).status === 0;
  const baseSides = merges.filter((p) => known.some((k) => isAncestor(k, p) || isAncestor(p, k)));
  const candidates = [target, ...baseSides].filter(Boolean);
  if (!candidates.length) return null;
  const bases = [...new Set(candidates.map((c) => git(cwd, ['merge-base', tip, c]).stdout.trim()).filter(Boolean))];
  const newest = bases.find((b) => bases.every((o) => isAncestor(o, b)));
  if (!newest) return null;
  const r = git(cwd, ['diff', '--no-ext-diff', '--no-color', '-M', newest, tip]);
  return r.status === 0 ? diffKey(r.stdout) : null;
}
// The key of an open PR's head as it is now: computed here when the head commit is in this clone, else from the code
// host's diff of the PR; null when neither can be read (then no rating counts for it).
export function liveDiffKey({ cwd, base, head, host, pr }) {
  const here = head ? localDiffKey(cwd, base, head) : null;
  if (here) return here;
  try {
    return host?.capabilities?.diff === false ? null : diffKey(host.pr.diff(pr));
  } catch {
    return null;
  }
}

export function prDiffLocal(cwd, base, maxChars) {
  let diff = git(cwd, ['diff', '--no-ext-diff', `${base}...HEAD`, '--', '.', ':(exclude)graphify-out', ':(exclude).factory/metrics']).stdout;
  if (diff.length > maxChars) diff = `${diff.slice(0, maxChars)}\n... diff truncated at ${maxChars} chars; read the remaining files directly.`;
  return diff;
}

// Files per ticket: in a group branch each ticket arrived as `<KEY>: Merge into <branch>`, so its files
// are that merge's diff against its first parent. A ticket without such a merge (a single-ticket PR)
// gets every file of the PR.
export function ticketFilesLocal(cwd, base, keys, all) {
  if (keys.length < 2) return Object.fromEntries(keys.map((k) => [k, all]));
  const log = lines(git(cwd, ['log', '--first-parent', '--format=%H%x09%s', `${base}..HEAD`]).stdout).map((l) => l.split('\t'));
  return Object.fromEntries(
    keys.map((k) => {
      const merge = log.find(([, subject]) => subject?.startsWith(`${k}: Merge into `));
      const files = merge ? lines(git(cwd, ['diff', '--name-only', `${merge[0]}^1`, merge[0]]).stdout) : [];
      return [k, files.length ? files : all];
    }),
  );
}

export function loadTicket(config, key) {
  const meta = readMeta(config, key) ?? {};
  const file = ticketFile(config, key);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { key, title: meta.title ?? /^#\s+(.+)$/m.exec(text)?.[1] ?? key, text, issue: meta.issue?.number ? { number: meta.issue.number, url: meta.issue.url } : null, type: meta.type ?? null };
}

export function readMetrics(config) {
  const read = (f) => readMetricsLocal(config, f);
  return { implementRuns: read('implement-runs.jsonl'), subtaskRuns: read('subtask-runs.jsonl'), prChecks: read('pr-checks.jsonl'), outcomes: read('decision-outcomes.jsonl') };
}

// One ticket's assessment from its rating, files, signals and earlier triage (its reopens).
export function assessTicket({ ticket, rating, files, added = [], systemsSettings, signals, prior, settings }) {
  const reopens = prior?.reopens ?? [];
  const reopensUnknown = Boolean(prior?.unknown);
  const floor = rating ? floorReasons({ files, added: added.filter((f) => files.includes(f)), categories: rating.categories }, settings, { overridePathsHit }) : [];
  const severity = rating ? ticketSeverity({ impact: rating.impact, complexity: rating.complexity, fixRisk: rating.fixRisk, floorReasons: floor, reopens: reopens.length }, settings) : ticketSeverity({}, settings);
  const conf = confidence({ ...signals, agent: rating?.agentConfidence ?? null }, settings.confidence);
  return {
    key: ticket.key,
    title: ticket.title,
    issue: ticket.issue,
    impact: rating?.impact ?? null,
    impactReason: rating?.impactReason ?? null,
    complexity: rating?.complexity ?? null,
    complexityReason: rating?.complexityReason ?? null,
    fixRisk: rating?.fixRisk ?? null,
    fixRiskReason: rating?.fixRiskReason ?? null,
    categories: rating?.categories ?? [],
    summary: rating?.summary ?? null,
    agentConfidence: rating?.agentConfidence ?? null,
    floorReasons: floor,
    severity,
    confidence: conf,
    signals,
    systems: systemsTouched(files, systemsSettings).names,
    files: files.length,
    paths: files.slice(0, 200),
    reopens,
    ...(reopensUnknown ? { reopensUnknown } : {}),
  };
}

// Assesses a published PR from its worktree. deps: { gh, runAgent, log }.
// `skipTriage`: build a deterministic unassessed assessment without starting any agent (pipeline delivery when no saved
// pre-open assessment exists; decideGate then forces `review` / `needs-human`).
export function assessPr(config, { pr, keys, cwd = config.root, base, skipTriage = false, skipReason = null }, deps) {
  // Systems come from implement.reviewGate.systems, else from the project model's services.
  const s = gateSystemsSettings(config);
  const repo = config.board.repo;
  const log = deps.log ?? (() => {});
  const files = prFilesLocal(cwd, base);
  const added = prAddedFilesLocal(cwd, base);
  const systems = systemsTouched(files, s);
  const tickets = keys.map((k) => loadTicket(config, k));
  const perTicket = ticketFilesLocal(cwd, base, keys, files);
  const triage = skipTriage
    ? { ratings: new Map(), errors: [skipReason ?? 'no saved pre-open assessment (no agent may run after the PR opens)'] }
    : runTriage(config, { pr, tickets, systems, files, diff: prDiffLocal(cwd, base, s.maxDiffChars), cwd }, deps);
  const ci = pr ? safe(() => checksState(ciTarget(config, repo, deps.gh), repo, pr, { head: git(cwd, ['rev-parse', 'HEAD']).stdout.trim() || null, ciSettings: config.implement?.reviewGate?.ci ?? {}, activities: (h) => headActivities(config, pr, h) }), null) : null;
  const metrics = readMetrics(config);
  // The reopens the tickets' records hold; publishing reads every rejection again live (rejections.mjs).
  const reopens = recordedReopens(config, deps.gh, tickets, { cwd });
  const assessed = tickets.map((t) => {
    const prior = reopens.get(t.key);
    const signals = ticketSignals(t.key, metrics, { ci });
    return assessTicket({ ticket: t, rating: triage.ratings.get(t.key) ?? null, files: perTicket[t.key] ?? files, added, systemsSettings: s, signals, prior, settings: s });
  });
  const severity = prSeverity({ tickets: assessed, systems }, s);
  if (triage.errors.length) log(`triage: ${triage.errors.join('; ')}`);
  return {
    pr,
    number: prNumber(pr),
    repo,
    base,
    headSha: git(cwd, ['rev-parse', 'HEAD']).stdout.trim() || null,
    // The PR's own change this rating is for (diffKey): what a later head must still have for the rating to count.
    diffKey: base ? localDiffKey(cwd, base) : null,
    assessedAt: nowIso(),
    ciReadAt: nowIso(),
    files: files.length,
    systems,
    tickets: assessed,
    severity,
    class: prClass({ severity: severity.level, shared: systems.shared || systems.contract }),
    ci,
    errors: triage.errors,
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// The data stored in a ticket's `## Triage` section.
export const triageData = (a, t) => ({
  v: 1,
  key: t.key,
  pr: a.pr,
  // The head this rating was made for, and the PR's own change it rated (a rebuilt assessment keeps the ones it read).
  ratedHead: t.ratedHead ?? a.headSha ?? null,
  ratedDiff: t.ratedDiff ?? a.diffKey ?? null,
  assessedAt: a.assessedAt,
  ciReadAt: a.ciReadAt ?? a.assessedAt,
  impact: t.impact,
  impactReason: t.impactReason,
  complexity: t.complexity,
  complexityReason: t.complexityReason,
  fixRisk: t.fixRisk,
  fixRiskReason: t.fixRiskReason,
  categories: t.categories,
  floorReasons: t.floorReasons,
  severity: t.severity,
  confidence: { score: t.confidence.score, high: t.confidence.high, criteria: t.confidence.criteria, reasons: t.confidence.reasons, questions: t.confidence.questions ?? [] },
  agentConfidence: t.agentConfidence,
  systems: t.systems,
  paths: (t.paths ?? []).slice(0, 50),
  summary: t.summary,
  reopens: t.reopens,
  // Every PR the ticket was delivered in: the gate reads each one's history (rejections.mjs).
  prs: [...new Set([...(t.prs ?? []), a.pr].filter(Boolean))],
});

export const fieldValues = (t) => ({ impact: t.impact, complexity: t.complexity, fixRisk: t.fixRisk, severity: t.severity?.level ?? null, confidence: t.confidence?.score ?? null, reopens: t.reopens?.length ?? 0 });

// Writes one ticket's triage to its issue (body section and board fields). Never throws; returns
// the problems.
export function recordTicket(config, gh, assessment, t) {
  const problems = [];
  if (!t.issue) return ['no issue'];
  try {
    const body = ticketBody(config, gh, t.issue.number);
    // A triage written again never drops a reopen the ticket already records (an assessment made before it, or one
    // that could not read it).
    const data = triageData(assessment, t);
    const before = extractTriage(body);
    data.reopens = mergeReopens(before?.reopens ?? [], data.reopens ?? []);
    data.prs = [...new Set([...(before?.prs ?? []), ...(before?.pr ? [before.pr] : []), ...data.prs])];
    const next = upsertTriage(body, data);
    if (next !== body.replace(/\r\n/g, '\n')) setTicketBody(config, gh, t.issue.number, next);
  } catch (error) {
    problems.push(`issue body: ${error.message.split('\n')[0]}`);
  }
  try {
    if (config.board?.projectNumber) setTriageFields(config, gh, t.issue, fieldValues(t));
  } catch (error) {
    problems.push(`board fields: ${error.message.split('\n')[0]}`);
  }
  return problems;
}

// The `bug-triage` decision of one PR, in the decision log of `metricsConfig` (the main checkout).
export function logTriageDecision(metricsConfig, a, gate = null) {
  return logDecision(metricsConfig, {
    stage: TRIAGE_STAGE,
    story: a.tickets[0]?.key ?? null,
    agent: 'bug-triage',
    subject: 'implementer',
    decision: gate?.action ?? 'assessed',
    reason: [`PR severity ${a.severity.level ?? 'unknown'} (${a.severity.explanation})`, gate?.reasons?.length ? `review: ${gate.reasons.join('; ')}` : null].filter(Boolean).join('. '),
    pr: a.pr,
    stories: a.tickets.map((t) => t.key),
    pr_severity: a.severity.level,
    pr_class: a.class,
    systems: a.systems.names,
    shared: a.systems.shared,
    contract: a.systems.contract,
    approvals: gate?.approvals ?? null,
    ci: a.ci,
    errors: a.errors,
    items: a.tickets.map((t) => ({
      story: t.key,
      impact: t.impact,
      complexity: t.complexity,
      fix_risk: t.fixRisk,
      severity: t.severity?.level ?? null,
      severity_base: t.severity?.base ?? null,
      severity_bump: t.severity?.bump ?? 0,
      floor: t.floorReasons,
      confidence: t.confidence?.score ?? null,
      high_confidence: Boolean(t.confidence?.high),
      agent_confidence: t.agentConfidence,
      reopens: t.reopens?.length ?? 0,
      systems: t.systems,
      reason: t.severity?.explanation ?? null,
    })),
  });
}
