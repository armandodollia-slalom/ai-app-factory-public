// Epic delivery (`implement run --epic <EPIC>`, delivery "epic"). An epic is delivered in **units**:
//   - a feature epic is one unit: the epic branch `epic/<slug>` and one long-lived epic worktree;
//   - a bug epic (most tickets are bugs, or --grouping ticket) is one unit per PR group the
//     orchestrator chose: `bugfix/<slug>/<group>` from the base (stacked on the groups it depends on).
// The flow: EPIC PLAN (orchestrator, read mode: the design note, and for bug epics the PR groups) ->
// epic foundation (feature epics, optional) -> per unit: each ticket through the usual per-story flow
// on a story branch from the unit branch, merged into it once its tests verify (serial, Blocked-by
// order; conflicts -> the orchestrator) -> unit-level feature verification (cross-story journeys) -> PR check of every
// ticket against the unit diff -> ONE PR per unit -> board (Pending Review, epic evidence).
// Every step is persisted in .factory/state/implement/epics/<epic>.json, so `implement resume` continues
// an interrupted epic. See docs/ai-pipeline/implement.md#epic-delivery.
import { writeText } from '../../pipeline/lib/redact.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';
import { prAnalysisSection } from '../../pipeline/lib/analysis/fixloop.mjs';
import { withStaticAnalysis } from '../../pipeline/lib/analysis/report.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ceiling, runAgentAsync } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { openPullRequest, prPublisher, publisherHost } from '../../pipeline/lib/bot.mjs';
import { addWorktree, git, revExists } from '../../pipeline/lib/git.mjs';
import { prsDisabled, runTags } from '../../pipeline/lib/run-tags.mjs';
import { loadState, metricsFile } from '../../pipeline/lib/state.mjs';
import { readOutage } from '../../pipeline/lib/outage.mjs';
import { acquireLock, appendJsonl, log as defaultLog, nowIso, readJson, releaseLock, run, sleep, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { ticketDir, writeTicket } from '../../board/lib/source.mjs';
import { metaFor } from '../../board/lib/ticket-format.mjs';
import { worktreeFor } from './batch.mjs';
import { boardEvent } from './board-events.mjs';
import { OUTCOMES_FILE } from './decisions.mjs';
import { councilRecords, councilReviewSection, withCouncilReview } from '../../pipeline/lib/council.mjs';
import { EPIC_PLAN_STAGE, featureGroupTitle, deliveryShape, epicDeps, journeyGroup, epicPlanDecision, epicPlanTask, epicPrBody, epicSlug, epicTestKey, groupDeps, groupOutcome, groupsDecision, journeyTicket, nextStories, noteMarkdown, singleGroups, validateNote } from './epic-plan.mjs';
import { parityGate, paritySection } from './ci-parity.mjs';
import { HARNESS_EXCLUDES, commitAll, commitEnv, commitRecords, headSha, mergeInProgress, mustGit, unmergedFiles } from './gitops.mjs';
import { adoptOpenedPr, afterOpen, prCheckHold, deliverFinished, deliveryIo, holdOpenPr, fullProjectRuns, fullProjectsSection, plan as planStories, prCheckFollowUps, runConditions, runConditionsSection, runsDir, shipMetrics, skippedOutcome, startWorker, withoutResolved, ownerDecisionBlock, waitingForPerson } from './implement.mjs';
import { lspAdapter } from './lsp.mjs';
import { waitForMemory } from './resources.mjs';
import { agentSettings, createContext, runSelf } from './orchestrate.mjs';
import { parsePlanOutput } from './plan.mjs';
import { syncFromRemote } from './reopen.mjs';
import { withDerivedClasses } from '../../pipeline/lib/policy-classes.mjs';

const FV_CLI = path.join(INSTALL_ROOT, 'scripts/feature-verification/feature-verification.mjs');
const PR_CHECK_CLI = path.join(INSTALL_ROOT, 'scripts/pr-check/pr-check.mjs');

// ---------------------------------------------------------------------------------------------
// Epic run state
// ---------------------------------------------------------------------------------------------

export const epicsDir = (config) => path.join(runsDir(config), 'epics');
export const epicStateFile = (config, epicKey) => path.join(epicsDir(config), `${epicKey}.json`);
export const loadEpicRun = (config, epicKey) => readJson(epicStateFile(config, epicKey), null);
// Re-read before every write: a joined single-ticket run updates the same file.
export function saveEpicRun(config, epicKey, patch) {
  const cur = loadEpicRun(config, epicKey) ?? { epic: epicKey, stories: {}, units: {} };
  const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
  writeJson(epicStateFile(config, epicKey), { ...next, updatedAt: nowIso() });
  return next;
}
const saveStory = (config, epicKey, key, patch) => saveEpicRun(config, epicKey, (cur) => ({ ...cur, stories: { ...cur.stories, [key]: { ...(cur.stories?.[key] ?? {}), ...patch } } }));
const saveUnit = (config, epicKey, id, patch) => saveEpicRun(config, epicKey, (cur) => ({ ...cur, units: { ...cur.units, [id]: { ...(cur.units?.[id] ?? {}), ...patch } } }));

export const listEpicRuns = (config) => (fs.existsSync(epicsDir(config)) ? fs.readdirSync(epicsDir(config)).filter((f) => f.endsWith('.json') && !f.endsWith('.note.json')).map((f) => readJson(path.join(epicsDir(config), f), null)).filter((s) => s?.epic) : []);

export const epicBranchFor = (config, epicKey) => `${config.implement.epic?.branchPrefix ?? 'epic/'}${epicSlug(epicKey)}`;
export const epicWorktreeFor = (config, epicKey) => worktreeFor(config, { key: `epic-${epicSlug(epicKey)}` });
export const groupBranchFor = (config, epicKey, id, { feature = false } = {}) => (feature ? `${config.implement.branchPrefix ?? 'feat/'}${epicSlug(epicKey)}--${id}` : `${config.implement.epic?.bugfixPrefix ?? 'bugfix/'}${epicSlug(epicKey)}/${id}`);
export const groupWorktreeFor = (config, epicKey, id, { feature = false } = {}) => worktreeFor(config, { key: `${feature ? 'feat' : 'bugfix'}-${epicSlug(epicKey)}--${id}` });

// Statuses of an epic run that is finished for good: a single ticket of that epic then runs on its own.
const SETTLED = new Set(['delivered', 'complete']);

// The in-progress epic run a single ticket joins: its epic has a run state that is not delivered, the
// ticket's unit (the epic branch, or its PR group's branch) still exists. Null with --standalone, for
// tickets without an epic, or when no epic run is in progress. Returns { state, unit }.
// A reopened bug fix (`reopen`, review gate) also joins a delivered epic's PR group while the group's PR
// is open (`prOpen(url)`), so the fix lands on the PR a person reviews.
export function epicToJoin(config, tickets, { standalone = false, reopen = false, prOpen = () => false } = {}) {
  if (standalone || !tickets.length) return null;
  const epics = new Set(tickets.map((t) => t?.epic ?? null));
  if (epics.size !== 1 || epics.has(null)) return null;
  const state = loadEpicRun(config, [...epics][0]);
  if (!state) return null;
  const unit = Object.values(state.units ?? {}).find((u) => tickets.every((t) => u.keys?.includes(t.key)));
  if (SETTLED.has(state.status) && !(reopen && unit?.kind === 'group' && unit.pr && prOpen(unit.pr))) return null;
  if (!unit || !revExists(config.root, `refs/heads/${unit.branch}`)) return null;
  return { state, unit };
}

// ---------------------------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------------------------

// Creates (or reuses) a unit's branch and worktree; `merge` are branches it also builds on (other
// groups it depends on). Copies the tickets (epic, stories, their mockups) into its ticket cache.
export function prepareUnitWorktree(config, { branch, worktree, base, merge = [], tickets = [] }) {
  if (!fs.existsSync(worktree)) {
    const exists = revExists(config.root, `refs/heads/${branch}`);
    if (!exists && !revExists(config.root, base)) throw new Error(`base ${base} does not exist`);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    addWorktree(config.root, ['-q', ...(exists ? [worktree, branch] : ['-b', branch, worktree, base])], { env: commitEnv });
  }
  for (const other of merge) {
    if (git(worktree, ['merge', '--no-edit', '-q', other], { env: commitEnv }).status !== 0) {
      git(worktree, ['merge', '--abort']);
      throw new Error(`merging ${other} into ${branch} conflicts`);
    }
  }
  // The unit's stages read this run's settings (the caller's implement and agent config), from the worktree.
  const wtConfig = { ...loadConfig('implement', worktree), implement: { ...config.implement }, agent: config.agent };
  for (const t of tickets) {
    const src = path.dirname(config.abs(t.file));
    const dst = ticketDir(wtConfig, t.key);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
  return wtConfig;
}

// ---------------------------------------------------------------------------------------------
// Steps (each replaceable in tests through `deps`)
// ---------------------------------------------------------------------------------------------

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// EPIC PLAN: the orchestrator reads every ticket and writes the design note (bug epics: with the PR
// groups); asked once more with the errors when it is invalid. A bug epic whose only remaining
// problem is its grouping falls back to one PR per ticket. Logged in the decision log (stage
// implement-epic-plan; the grouping as decision pr-groups).
export async function planEpic(env, opts = {}) {
  try {
    return await planEpicOnce(env, opts);
  } finally {
    // A bug epic is planned in the main checkout: the language-server daemon its planner started there is released
    // when planning ends, not when the whole run ends (council C3: it held a slot, idle, while the next story ran without C#).
    if (env.groups) await env.deps?.lsp?.release?.(env.cwd);
  }
}

async function planEpicOnce(env, { attempts = 2 } = {}) {
  const { planConfig, cwd, epic, stories, deps, log, groups } = env;
  const keys = stories.map((s) => s.key);
  // A feature epic split into PRs (prSplit story or groups): no foundation, feature wording; the cap is its own.
  const featureGroups = Boolean(env.shape?.feature);
  const maxPerGroup = featureGroups ? planConfig.implement.epic?.maxStoriesPerGroup ?? null : planConfig.implement.maxBugsPerGroup ?? null;
  let errors = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { cli, model } = agentSettings(planConfig, 'orchestrator');
    const res = await deps.runAgent(planConfig, {
      name: 'implementer',
      mode: 'read',
      model,
      cli,
      noSubagents: true,
      cwd,
      timeoutSec: planConfig.implement.epic?.planTimeoutSec ?? planConfig.implement.timeouts.plannerSec,
      task: epicPlanTask({ epic, stories, mockups: env.mockups ?? [], errors, groups, maxPerGroup, featureGroups }),
      usage: { stage: EPIC_PLAN_STAGE, story: epic.key, step: 'epic-plan', round: attempt },
    });
    const agent = { version: res.version, cli, model };
    const raw = parsePlanOutput(res.output);
    if (raw?.status === 'blocked') {
      logDecision(planConfig, { ...epicPlanDecision({ epic, attempt, accepted: false, errors: [`blocked: ${raw.reason ?? ''}`], agent }), decision: 'blocked' });
      return { ok: false, outcome: 'blocked', reason: raw.reason ?? 'the orchestrator reported the epic blocked' };
    }
    const v = validateNote(raw, { keys, groups, stories, maxPerGroup, featureGroups });
    const last = attempt === attempts;
    const fallback = groups && !v.ok && last && v.note && !v.noteErrors.length ? `the grouping was rejected twice (${v.groupErrors[0]}); one PR per ${featureGroups ? 'story' : 'ticket'} instead` : null;
    const accepted = v.ok || Boolean(fallback);
    const decisionId = accepted ? randomUUID() : null;
    logDecision(planConfig, epicPlanDecision({ epic, attempt, accepted, errors: v.errors, note: v.note, agent, decisionId }));
    if (accepted) {
      const note = fallback ? { ...v.note, prGroups: singleGroups(stories) } : v.note;
      if (groups) logDecision(planConfig, groupsDecision({ epic, groups: note.prGroups, decisionId, fallback, agent }));
      if (fallback) log(fallback);
      return { ok: true, note, decisionId };
    }
    errors = v.errors;
    log(`epic plan rejected (${errors.length} problem(s))${last ? '' : '; asking the orchestrator again'}`);
  }
  return { ok: false, outcome: 'plan-rejected', reason: `the epic plan was rejected twice: ${errors[0]}`, findings: errors };
}

// The epic foundation: shared groundwork as one verifier pair (the orchestrator implements, a fresh
// verifier checks, owns enforced) in the epic worktree, committed on the epic branch.
export async function runFoundation(env, note) {
  const { wtConfig, worktree, branch, epic, deps } = env;
  const specFile = path.join(worktree, wtConfig.stateDir, 'implement', `${epic.key}.foundation.md`);
  fs.mkdirSync(path.dirname(specFile), { recursive: true });
  writeText(specFile, `# ${epic.key}: epic foundation\n\n${note.foundation.goal}\n\n${noteMarkdown(note, { epic })}`);
  const ctx = createContext({ config: wtConfig, key: epic.key, storyFile: specFile, branch, worktree, base: headSha(worktree), deps: { runAgent: deps.runAgent, lsp: deps.lsp, ...(deps.stack ? { stack: deps.stack } : {}), ...(deps.acquire ? { acquire: deps.acquire } : {}) }, log: env.rawLog });
  ctx.decisionId = env.decisionId;
  const st = { id: 'foundation', goal: note.foundation.goal, acceptance: note.foundation.acceptance.length ? note.foundation.acceptance : [note.foundation.goal], owns: note.foundation.owns, dependsOn: [], modelClass: 'large', verify: 'code' };
  const r = await runSelf(ctx, { mode: 'self', subtasks: [st] });
  return { ...r, agentRuns: ctx.metrics.agentRuns, usage: ctx.metrics.usage };
}

const conflictTask = ({ epic, key, worktree, branch, storyBranch, files, noteFile }) =>
  [
    `Merge conflict in epic ${epic.key}: merging ${key} (${storyBranch}) into ${branch} in ${worktree} stopped with conflicts in:`,
    ...files.map((f) => `- ${f}`),
    '',
    `Both sides were reviewed and tested on their own. Resolve every conflict so both tickets' behaviour survives${noteFile ? `, following the epic design note (${noteFile})` : ''}; \`git add\` the files and finish the merge with \`git commit --no-edit\`. Do not abort the merge, reset, checkout, switch or rebase. Run the build afterwards if you can.`,
    '',
    'End your reply with exactly one line:',
    'AGENT_RESULT: {"status": "done" | "blocked", "reason": "<one sentence>"}',
  ].join('\n');

// Merges a verified story branch into the unit branch (one at a time, under a lock shared with a
// joined single-ticket run). A conflict goes to the orchestrator in the unit worktree.
export async function mergeStory(env, story) {
  const { config, wtConfig, worktree, branch, epic, deps, log } = env;
  const lock = path.join(epicsDir(config), `${epic.key}--${env.unit.id}.merge.lock`);
  while (!acquireLock(lock)) await sleep(1000);
  try {
    // Agents that ran in the unit worktree (an earlier conflict resolution) leave their usage and decision
    // records uncommitted there, and git refuses to merge over them.
    commitAll(worktree, `${env.unit?.id ?? branch}: Record metrics`, [wtConfig.metricsDir]);
    const r = git(worktree, ['merge', '--no-ff', '--no-edit', '-m', `${story.key}: Merge into ${branch}`, story.branch], { env: commitEnv });
    if (r.status === 0) return { ok: true, sha: headSha(worktree) };
    const files = unmergedFiles(worktree);
    if (!files.length) {
      git(worktree, ['merge', '--abort']);
      return { ok: false, reason: `merging ${story.branch} failed: ${tail(r.stderr || r.stdout, 300)}` };
    }
    log(`${story.key}: merging into ${branch} conflicts in ${files.join(', ')}; asking the orchestrator to resolve them`);
    const { cli, model } = agentSettings(wtConfig, 'orchestrator');
    await deps.runAgent(wtConfig, { name: 'implementer', mode: 'implement', model, cli, noSubagents: true, cwd: worktree, timeoutSec: wtConfig.implement.timeouts.orchestratorSec, task: conflictTask({ epic, key: story.key, worktree, branch, storyBranch: story.branch, files, noteFile: env.noteFile }), usage: { stage: 'implement', story: story.key, step: `merge into ${branch}` } });
    const left = unmergedFiles(worktree);
    if (left.length || /<<<<<<< /.test(git(worktree, ['diff', 'HEAD', '--', ...files]).stdout)) {
      git(worktree, ['merge', '--abort']);
      return { ok: false, reason: `the conflicts merging ${story.key} into ${branch} (${files.join(', ')}) were not resolved`, files };
    }
    if (mergeInProgress(worktree)) {
      git(worktree, ['add', '-A', '--', '.', ...HARNESS_EXCLUDES], { env: commitEnv });
      git(worktree, ['commit', '-q', '--no-edit'], { env: commitEnv });
    }
    return { ok: true, sha: headSha(worktree), conflicts: files };
  } finally {
    releaseLock(lock);
  }
}

// Each ticket's cached text in its story worktree (with the implementer's Implementation Notes, which
// its plan's story-sha covers) replaces the unit worktree's copy taken before the story ran, so the
// unit's PR check and the pre-push feature verification check read the text the plan was verified against.
export function syncTickets(env, keys, state) {
  for (const key of keys) {
    const storyWt = state.stories?.[key]?.worktree ?? worktreeFor(env.config, { key });
    const src = ticketDir(loadConfig('implement', storyWt), key);
    if (!fs.existsSync(path.join(src, 'story.md'))) continue;
    const dst = ticketDir(env.wtConfig, key);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}

// The ticket's text (with Implementation Notes) back to its issue, and its card to Pending Review
// naming the unit branch (and the unit's PR once it exists; no PR per ticket).
// A group publishes each ticket from its own worktree's copy: the text its plan and tests were verified against, which
// CI's `fv check` reads back from the issue. Publishing the story worktree's copy instead turned a held-out PR's check red
// (council C3, D-C7-1: the PR check fixer had edited the group copy, the plan was re-stamped from it, and the other
// copy was published).
export function publishSource(env, story) {
  if (!env.unit || !env.worktree) return story.worktree;
  try {
    return fs.existsSync(path.join(ticketDir(loadConfig('implement', env.worktree), story.key), 'story.md')) ? env.worktree : story.worktree;
  } catch {
    return story.worktree;
  }
}

function reportStory(env, story, pr = null) {
  const verifiedHash = loadState(loadConfig('implement', story.worktree), story.key).automation?.verifiedHash;
  env.deps.board(publishSource(env, story), story.key, ['publish', story.key]);
  env.deps.board(story.worktree, story.key, ['review', story.key, ...(pr ? ['--pr', pr] : []), '--epic-branch', env.branch, ...(verifiedHash ? ['--id', `verified:${verifiedHash}`] : [])]);
}

function cli(script, worktree, base, args, { timeoutSec, sources = [] } = {}) {
  const env = { ...process.env, PIPELINE_ROOT: worktree, PIPELINE_BASE_REF: base, PIPELINE_HEADLESS: '1', PIPELINE_TICKETS_OFFLINE: '1' };
  if (sources.length) env.PIPELINE_STORY_SOURCES = [process.env.PIPELINE_STORY_SOURCES, ...sources].filter(Boolean).join(path.delimiter);
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  // The stage runs agents: its limit is a ceiling of agent.supervisor.ceilingFactor times the usual budget (council C12).
  return run(process.execPath, [script, ...args], { cwd: worktree, env, timeoutSec: ceiling(loadConfigSafe(worktree), timeoutSec) });
}

function loadConfigSafe(worktree) {
  try {
    return loadConfig('implement', worktree);
  } catch {
    return null;
  }
}

// Unit-level feature verification: the cross-story journeys become a ticket (EPIC-<n>) in the unit worktree's cache, and
// the feature verification stage plans and automates it like a story (tests tagged TC-EPIC-<n>-NN).
export async function epicFv(env, { key, note }) {
  const { wtConfig, worktree, base, epic, stories } = env;
  const text = journeyTicket({ key, epic, note, stories });
  writeTicket(wtConfig, key, { content: text, meta: metaFor({ key, type: 'story', title: `${key}: ${epic.title ?? epic.key} (cross-story journeys)`, slug: `${key}-${epicSlug(epic.key)}`, source: null, parent: epic.key }, text), origin: 'file' });
  const sources = [ticketDir(wtConfig, key)];
  const timeoutSec = wtConfig.implement.fvTimeoutSec;
  const planned = cli(FV_CLI, worktree, base, ['plan', key], { timeoutSec, sources });
  const state = () => loadState(wtConfig, key);
  if (state().plan?.status !== 'verified') return { status: `plan-${state().plan?.status ?? (planned.status === 0 ? 'unknown' : 'failed')}` };
  cli(FV_CLI, worktree, base, ['automate', key], { timeoutSec, sources });
  return { status: state().automation?.status ?? 'unknown', bugs: state().automation?.bugs ?? [] };
}

// The tickets on a unit branch whose verified tests went stale because other tickets edited the same
// spec files (`fv check`: "tests or scenario edited after verification"); feature verification automates each again in
// the unit worktree, which re-runs its verifier, and the result is committed.
const STALE_TESTS = /^FAIL\s+(\S+)\s.*tests or scenario edited after verification/;
export async function reverifyStale(env, keys) {
  const { wtConfig, worktree, base, log = () => {} } = env;
  const checked = cli(FV_CLI, worktree, base, ['check', '--changed-from', wtConfig.baseRef], { sources: keys.map((k) => ticketDir(wtConfig, k)) });
  const stale = (checked.stdout ?? '').split('\n').map((l) => STALE_TESTS.exec(l)?.[1]).filter((k) => k && keys.includes(k));
  const failed = [];
  for (const key of stale) {
    log(`${key}: its verified tests changed with later tickets' spec edits; re-verifying them in ${env.branch}`);
    const r = cli(FV_CLI, worktree, base, ['automate', key, '--verify-first'], { timeoutSec: wtConfig.implement.fvTimeoutSec, sources: [ticketDir(wtConfig, key)] });
    commitAll(worktree, `${key}: Re-verify automated tests after later tickets edited their spec files`);
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter((l) => /^\[feature-verification\]|^\S+: (verified|failed|blocked|escalated)/.test(l)).slice(-12);
    for (const line of tail) log(`${key}: ${line}`);
    if (r.status !== 0) failed.push(key);
  }
  return { stale, failed };
}

// The PR check of a whole unit (its tickets, and the journey ticket) against the unit diff, in one run of
// the PR check's multi-ticket mode (`run --stories K1,K2`): every frontend ticket gets the design lens.
// Report only unless `fix` (fixes are committed on the unit branch).
export async function prCheckUnit(env, keys, { fix = false } = {}) {
  const { worktree, base, wtConfig } = env;
  const pc = { fixUntil: 'major', bugFixUntil: 'minor', fixRounds: 3, fixLenses: [], ...(wtConfig.implement.prCheck ?? {}) };
  // A bug group aims at 10/10, which the review gate's auto-merge needs.
  if (env.unit?.kind === 'group') pc.fixUntil = pc.bugFixUntil;
  const r = cli(PR_CHECK_CLI, worktree, base, ['run', '--stories', keys.join(','), '--base', base, '--json', ...(fix ? ['--until', pc.fixUntil, ...(pc.fixLenses?.length ? ['--fix-lenses', pc.fixLenses.join(',')] : []), '--max-rounds', String(pc.fixRounds)] : ['--no-fix'])], { timeoutSec: wtConfig.implement.epic?.prCheckTimeoutSec ?? 14400, sources: keys.map((k) => ticketDir(wtConfig, k)) });
  try {
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    return { verdict: out.verdict, score: out.score, openFindings: out.openFindings ?? [], resolvedFindings: out.resolvedFindings ?? [], followUps: out.followUps ?? [], report: out.report ?? null };
  } catch {
    return { verdict: 'ERROR', score: null, openFindings: [], reason: tail(r.stderr || r.stdout, 300) };
  }
}

// A unit's PR (a bug-epic group or the feature epic), opened as the pipeline's PR bot (dev-bot-<login>, lib/bot.mjs), or
// as the developer's gh login when the bot is not set up. Called only by the delivery (implement.mjs deliverFinished),
// once, on the head CI proved: nothing is committed or merged here. An open PR is never opened again or pushed to from
// here (council C11, owner C18): a unit whose PR is open is put on hold and delivered through `existingPr`.
export async function openPr(env, { title, body: plainBody, existing = null, records = false, draft = false }, deps = {}) {
  if (existing) throw new Error(`openPr: ${existing} is already open; it is re-delivered on hold through the delivery, never opened again`);
  const { worktree, branch, prBase } = env;
  const body = withDerivedClasses(plainBody, worktree, prBase ? `origin/${String(prBase).replace(/^origin\//, '')}` : null, { runner: deps.run ?? run });
  const publisher = deps.publisher ?? (await prPublisher(env.wtConfig ?? env.config));
  const host = publisherHost(publisher, { cwd: worktree, ...(deps.run ? { run: deps.run } : {}) });
  if (records) commitRecords(worktree, 'Pipeline records (PR check, run conditions, usage) before the PR');
  const opened = await openPullRequest(publisher, { cwd: worktree, branch, base: prBase.replace(/^origin\//, ''), title, body, draft }, { run: deps.run, ...(records ? {} : { mergeBase: () => null }) });
  if (opened.url) return { url: opened.url, pushed: true, draft, ...(opened.reduced ? { reduced: opened.reduced } : {}) };
  // The PR exists but this run has no record of it (an earlier run stopped right after opening it): adopted as it is.
  if (opened.pushed && /already exists/.test(opened.reason ?? '')) {
    const prior = await host.pr
      .list({ head: branch, state: 'open', limit: 1 })
      .then((list) => list[0]?.url ?? null)
      .catch(() => null);
    if (prior) return { url: prior, pushed: true, draft, adopted: true };
  }
  return { url: null, pushed: Boolean(opened.pushed), reason: opened.reason, ...(opened.refused ? { refused: true, attempts: opened.attempts, records: opened.records } : {}) };
}

export const defaultDeps = (config, log) => ({
  runAgent: runAgentAsync,
  startWorker,
  reverifyStale,
  lsp: lspAdapter(config, { log }),
  board: (root, key, args, opts) => boardEvent(root, key, args, opts),
  planEpic,
  runFoundation,
  epicFv,
  prCheck: prCheckUnit,
  openPr,
  // The unit worktree's records (its PR check, re-verification, triage) go to the store when the unit ends,
  // as a single ticket's do: the branch may not merge for days, and the retro reads the store.
  shipMetrics: (wt) => shipMetrics(wt),
  parityGate,
  // OPEN, MERGED or CLOSED, for a PR of this repository; null when it cannot be read.
  prState: (pr) => {
    try {
      const host = hostFor(config).sync;
      if (!String(host.repo ?? '') || !host.ownsPr(pr)) return null;
      const state = host.pr.get(pr)?.state;
      return state ? state.toUpperCase() : null;
    } catch {
      return null;
    }
  },
});

const ciEnv = (env) => {
  const e = { ...process.env, PIPELINE_ROOT: env.worktree, PIPELINE_BASE_REF: env.prBase, PIPELINE_HEADLESS: '1', PIPELINE_TICKETS_OFFLINE: '1' };
  delete e.PIPELINE_CHILD;
  delete e.PIPELINE_DISABLE;
  return e;
};

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------

const DONE = new Set(['done']);
const sum = (xs) => (xs.some((x) => x != null) ? Math.round(xs.reduce((n, x) => n + (x ?? 0), 0) * 1e6) / 1e6 : null);

// Runs (or continues) an epic. `tickets` are the epic's ticket objects (key, title, type, epic, issue,
// blockedBy, file), `inputs` their story files. `grouping` is auto, epic or ticket (bug epics). `only`
// runs just those tickets in their existing unit (a single ticket joining an in-progress epic): no epic
// plan, foundation, feature verification, PR check or PR then. Returns { results, epic: summary }.
export async function runEpic(config, { epic, tickets, inputs, base, parallel = 1, pr = false, force = false, only = null, grouping = null, prSplit = null, script, deps: injected = {}, log: rawLog = defaultLog }) {
  const log = (m) => rawLog(`${epic.key}: ${m}`);
  const E = config.implement.epic ?? {};
  const prior = loadEpicRun(config, epic.key);
  const shape = prior?.shape ?? deliveryShape(tickets, grouping ?? E.grouping ?? 'auto', prSplit ?? E.prSplit ?? 'epic');
  const epicBase = prior?.base ?? base;
  const deps = { ...defaultDeps(config, log), ...injected };
  const stories = tickets.map((t) => ({ key: t.key, title: t.title, type: t.type, number: t.issue?.number ?? null, blockedBy: t.blockedBy ?? [], text: readText(config.abs(t.file)) }));
  const noteJson = path.join(epicsDir(config), `${epic.key}.note.json`);
  const noteFile = path.join(epicsDir(config), `${epic.key}.note.md`);
  saveEpicRun(config, epic.key, (cur) => ({
    ...cur,
    epic: epic.key,
    title: epic.title ?? cur.title ?? null,
    number: epic.number ?? cur.number ?? null,
    shape,
    base: epicBase,
    baseSha: cur.baseSha ?? git(config.root, ['rev-parse', epicBase]).stdout.trim(),
    ...(only ? {} : { status: 'running', pid: process.pid, startedAt: cur.startedAt ?? nowIso(), finishedAt: null, reason: null, outcome: null }),
  }));
  const env = { config, epic, stories, tickets, inputs, deps, log, rawLog, noteFile, noteJson, epicBase, parallel, pr, force, only, script, E, shape };
  try {
    return await epicFlow(env);
  } catch (error) {
    // A crash never leaves the epic `running` for ever: the state says where it stopped and why, and `implement resume`
    // continues from it (the plan, merged stories and opened PRs are kept; a delivered group is not delivered again).
    if (!only) saveEpicRun(config, epic.key, (cur) => ({ ...cur, status: 'interrupted', outcome: 'crashed', reason: `${cur.phase ?? 'the run'} stopped: ${String(error?.message ?? error).slice(0, 300)}`, pid: null, finishedAt: nowIso() }));
    log(`CRASHED in ${loadEpicRun(config, epic.key).phase ?? 'the run'}: ${error?.message ?? error}; the epic state is saved, \`implement resume\` continues it`);
    throw error;
  } finally {
    await deps.lsp.stopAll?.();
    // The records the epic run wrote in this checkout (the epic plan's usage and its decisions) go to the store too,
    // whatever happened after the plan; the groups' worktrees ship their own.
    await deps.shipMetrics?.(config);
  }
}

async function epicFlow(env) {
  const { config, epic, stories, tickets, deps, log, noteFile, noteJson, epicBase, only, shape } = env;
  const feature = shape.kind === 'epic';
  const failAll = (outcome, reason, findings = []) => {
    const results = stories.map((s) => ({ key: s.key, outcome: 'blocked', reason: `${outcome === 'foundation-failed' ? 'the epic foundation' : 'the epic plan'} failed: ${reason}`, branch: null }));
    saveEpicRun(config, epic.key, { status: 'failed', outcome, reason, findings, phase: 'finished', pid: null, finishedAt: nowIso() });
    return { results, epic: { key: epic.key, outcome, reason } };
  };

  // The epic worktree of a feature epic exists before the plan (the plan reads the code there); a bug
  // epic plans from this checkout and gets its group worktrees from the plan.
  const epicUnit = { id: 'epic', kind: 'epic', branch: epicBranchFor(config, epic.key), worktree: epicWorktreeFor(config, epic.key), keys: stories.map((s) => s.key), deps: [] };
  const epicWt = feature ? prepareUnitWorktree(config, { branch: epicUnit.branch, worktree: epicUnit.worktree, base: epicBase, tickets: [...(epic.file ? [epic] : []), ...tickets] }) : null;
  if (feature) await deps.lsp.start?.(epicUnit.worktree, { key: epic.key });

  // 1. The epic plan (once; a resumed or joined run reuses the note). Each step's phase is saved before it starts.
  const phase = (name) => !only && saveEpicRun(config, epic.key, { phase: name, phaseAt: nowIso() });
  phase('plan');
  let state = loadEpicRun(config, epic.key);
  let note = state.plan?.ok && fs.existsSync(noteJson) ? readJson(noteJson, null) : null;
  if (!note && !only) {
    if (!feature && !shape.planned && !shape.feature) {
      note = { summary: '', contracts: [], migrations: [], components: [], events: [], foundation: null, stories: stories.map((s) => ({ key: s.key, owns: [], dependsOn: [], notes: null })), buildOrder: [], journeys: [], risks: [], prGroups: singleGroups(stories) };
      logDecision(config, groupsDecision({ epic, groups: note.prGroups, fallback: 'grouping "ticket": one PR per ticket' }));
    } else {
      // A feature epic split one PR per story still gets its design note (shared contracts, journeys); its groups are
      // fixed by the harness, one per story.
      const storySplit = shape.feature && !shape.planned;
      log(`planning the epic (design note${feature || storySplit ? '' : ' and PR groups'})`);
      const planConfig = feature ? epicWt : config;
      const planned = await deps.planEpic({ ...env, planConfig, cwd: feature ? epicUnit.worktree : config.root, groups: !feature && !storySplit });
      if (planned.ok && storySplit) {
        planned.note.prGroups = singleGroups(stories);
        logDecision(config, groupsDecision({ epic, groups: planned.note.prGroups, decisionId: planned.decisionId ?? null, fallback: 'prSplit "story": one PR per story' }));
      }
      if (!planned.ok) return failAll(planned.outcome, planned.reason, planned.findings);
      note = planned.note;
      if (feature) commitAll(epicUnit.worktree, `${epic.key}: Epic plan (design note)`, [epicWt.metricsDir]);
      state = saveEpicRun(config, epic.key, { plan: { ok: true, decisionId: planned.decisionId, note: noteFile, at: nowIso() } });
    }
    writeJson(noteJson, note);
    writeText(noteFile, noteMarkdown(note, { epic }));
    state = saveEpicRun(config, epic.key, { plan: { ...(state.plan ?? {}), ok: true, note: noteFile } });
  }
  // Tickets added to a bug epic after its plan (dogfood C4: two new tickets were "skipped: its group never ran"):
  // the saved PR groups are kept for the tickets they hold, and the new tickets are planned into groups now.
  if (!feature && note && !only) {
    const held = new Set((note.prGroups ?? []).flatMap((g) => g.tickets ?? []));
    const fresh = stories.filter((s) => !held.has(s.key));
    if (fresh.length && note.prGroups?.length) {
      log(`${fresh.map((s) => s.key).join(', ')} not in any PR group of the epic's plan (added since): planning them now`);
      let added;
      if (shape.planned) {
        const planned = await deps.planEpic({ ...env, stories: fresh, tickets: tickets.filter((t) => fresh.some((s) => s.key === t.key)), planConfig: config, cwd: config.root, groups: true });
        if (!planned.ok) return failAll(planned.outcome, `planning the tickets added since the epic's plan failed: ${planned.reason}`, planned.findings);
        added = planned.note.prGroups?.length ? planned.note.prGroups : singleGroups(fresh);
        note.stories = [...(note.stories ?? []), ...(planned.note.stories ?? []).filter((x) => fresh.some((s) => s.key === x.key))];
      } else added = singleGroups(fresh);
      const ids = new Set(note.prGroups.map((g) => g.id));
      for (const g of added) {
        let id = g.id;
        for (let n = 2; ids.has(id); n++) id = `${g.id}-${n}`;
        ids.add(id);
        note.prGroups.push({ ...g, id, tickets: (g.tickets ?? []).filter((k) => fresh.some((s) => s.key === k)) });
      }
      const still = fresh.filter((s) => !note.prGroups.some((g) => g.tickets.includes(s.key)));
      if (still.length) note.prGroups.push(...singleGroups(still));
      writeJson(noteJson, note);
      writeText(noteFile, noteMarkdown(note, { epic }));
      logDecision(config, groupsDecision({ epic, groups: note.prGroups, fallback: null }));
    }
  }
  env.note = note;
  env.decisionId = state.plan?.decisionId ?? null;

  // The units: the epic branch, or one branch per PR group.
  const units = feature
    ? [epicUnit]
    : (() => {
        const groups = note?.prGroups?.length ? note.prGroups : singleGroups(stories);
        const gdeps = groupDeps(groups, stories, note);
        // A feature epic split into PRs: every cross-story journey is verified on one group, stacked on the others that
        // hold a journey story (journeyGroup).
        const jg = shape.feature ? journeyGroup(groups, gdeps, note?.journeys ?? []) : null;
        if (jg?.added.length) {
          gdeps.set(jg.id, [...(gdeps.get(jg.id) ?? []), ...jg.added]);
          log(`group ${jg.id} verifies the cross-story journeys; it is stacked on ${jg.added.join(', ')} so its branch has every story they cross`);
        }
        const feat = { feature: Boolean(shape.feature) };
        return groups.map((g) => ({ id: g.id, kind: 'group', ...feat, journeys: jg?.id === g.id, group: g, branch: groupBranchFor(config, epic.key, g.id, feat), worktree: groupWorktreeFor(config, epic.key, g.id, feat), keys: g.tickets, deps: gdeps.get(g.id) ?? [] }));
      })();
  for (const u of units) saveUnit(config, epic.key, u.id, { id: u.id, kind: u.kind, ...(u.feature ? { feature: true, journeys: u.journeys } : {}), branch: u.branch, worktree: u.worktree, keys: u.keys, deps: u.deps, ...(u.group ? { title: u.group.title, reason: u.group.reason, risk: u.group.risk } : {}) });

  // 2. The epic foundation (feature epics), before any story.
  if (feature && note?.foundation && !only && state.foundation?.status !== 'approved') {
    phase('foundation');
    log(`epic foundation: ${note.foundation.goal}`);
    const f = await deps.runFoundation({ ...env, wtConfig: epicWt, worktree: epicUnit.worktree, branch: epicUnit.branch }, note);
    commitAll(epicUnit.worktree, `${epic.key}: Epic foundation`);
    saveEpicRun(config, epic.key, { foundation: { status: f.ok ? 'approved' : 'failed', goal: note.foundation.goal, reason: f.reason ?? null, agentRuns: f.agentRuns ?? null } });
    if (!f.ok) return failAll('foundation-failed', f.reason ?? f.outcome, f.findings);
  }

  // 3. The units. A feature epic's stories run up to --parallel at once; bug groups run up to
  // --parallel groups at once, each group's tickets one at a time. A group whose dependency group
  // failed is skipped.
  const targets = only ? units.filter((u) => u.keys.some((k) => only.includes(k))) : units;
  phase('units');
  const unitResults = new Map();
  const groupParallel = feature ? 1 : env.parallel;
  const pending = [...targets];
  const running = new Map();
  const unitsStarted = Date.now();
  while (pending.length || running.size) {
    // An agent provider outage (outage.mjs): start no more groups and skip none for it.
    const outage = readOutage(unitsStarted);
    if (outage && !running.size) break;
    for (let i = 0; !outage && i < pending.length; i++) {
      const u = pending[i];
      const failedDep = u.deps.find((d) => unitResults.has(d) && unitResults.get(d).outcome !== 'done');
      if (failedDep && !only) {
        pending.splice(i--, 1);
        const reason = `blocker group ${failedDep} ended ${unitResults.get(failedDep).outcome}`;
        const results = u.keys.map((k) => ({ key: k, outcome: 'skipped', reason: `blocker ${failedDep} (group) ended ${unitResults.get(failedDep).outcome}` }));
        for (const k of u.keys) saveStory(config, epic.key, k, { outcome: 'skipped', reason, merged: false });
        saveUnit(config, epic.key, u.id, { status: 'skipped', outcome: 'skipped', reason });
        recordGroupOutcome(env, u, results, null, 'skipped');
        unitResults.set(u.id, { outcome: 'skipped', results, reason });
        continue;
      }
      // A group an earlier run finished (its PR opened, merged or closed, or nothing to deliver) is not delivered
      // again: its PR branch may have moved on GitHub since (dogfood C4: a re-push was rejected).
      const saved = loadEpicRun(config, epic.key);
      const done = saved.units?.[u.id];
      if (!only && !env.force && done?.status === 'done' && (done.pr || done.noPr) && u.keys.every((k) => saved.stories?.[k]?.merged || done.noPr)) {
        pending.splice(i--, 1);
        // The no-PR reason is its own field: older runs saved the group's planning rationale in `reason`, which read
        // as if it explained why nothing was delivered (council C3).
        const results = u.keys.map((k) => ({ key: k, outcome: 'skipped', reason: done.pr ? `delivered in ${done.pr} by an earlier run` : `nothing to deliver: ${done.noPrReason ?? 'an earlier run found every ticket of this group already done'}` }));
        unitResults.set(u.id, { outcome: 'done', results, pr: done.pr ?? null, noPr: Boolean(done.noPr), earlier: true });
        log(`group ${u.id}: ${results[0].reason}`);
        continue;
      }
      const ready = only || u.deps.every((d) => unitResults.get(d)?.outcome === 'done' || loadEpicRun(config, epic.key).units?.[d]?.outcome === 'done');
      if (running.size < groupParallel && ready) {
        pending.splice(i--, 1);
        running.set(u.id, waitForMemory(config, `group ${u.id}`).then(() => deliverUnit(env, u, units, feature ? epicWt : null)).then((r) => [u, r]));
      }
    }
    if (!running.size) break;
    const [u, r] = await Promise.race(running.values());
    running.delete(u.id);
    unitResults.set(u.id, r);
  }
  const results = stories.map((s) => {
    for (const r of unitResults.values()) {
      const hit = r.results?.find((x) => x.key === s.key);
      if (hit) return hit;
    }
    if (!only && readOutage(unitsStarted)) return { key: s.key, outcome: null, reason: 'not started: the agent provider is unavailable' };
    return only ? { key: s.key, outcome: 'skipped', reason: 'not part of this run' } : { key: s.key, outcome: 'undelivered', reason: 'its group never ran' };
  }).filter((r) => !only || only.includes(r.key));
  if (only) {
    log(`joined ${only.join(', ')} finished; the epic run (or \`implement resume\`) finishes the epic.`);
    return { results, epic: { key: epic.key, outcome: 'joined' } };
  }
  const all = [...unitResults.values()];
  phase('summary');
  // A PR closed without merging is not one of the epic's deliveries (council C7: the summary listed the closed #56).
  const prs = [...new Set(all.map((r) => r.pr).filter(Boolean))].filter((pr) => deps.prState?.(pr) !== 'CLOSED');
  // A ticket this run was asked to deliver that no group ran is a failure, said out loud (dogfood C4: the run
  // ended "every unit verified" with two tickets never started).
  const undelivered = results.filter((r) => r.outcome === 'undelivered');
  let outcome = all.every((r) => r.outcome === 'done') ? 'done' : all.find((r) => r.outcome !== 'done')?.outcome ?? 'failed';
  let reason = outcome === 'done' ? null : all.filter((r) => r.outcome !== 'done').map((r) => r.reason).filter(Boolean).join('; ');
  if (undelivered.length && !readOutage(unitsStarted)) {
    outcome = outcome === 'done' ? 'undelivered' : outcome;
    reason = [reason, `${undelivered.map((r) => r.key).join(', ')} not delivered: no PR group ran ${undelivered.length === 1 ? 'it' : 'them'}`].filter(Boolean).join('; ');
    log(`FAILED: ${reason}`);
  }
  // A ticket waiting for a person (an owner decision, an escalation, a delivery a person must decide) keeps the epic
  // waiting, never delivered or done (council C7: the epic said "delivered" over two tickets waiting for their owners).
  const waiting = [...new Set([...tickets.filter((t) => waitingForPerson(config, t)).map((t) => t.key), ...results.filter((r) => r.outcome === 'needs-decision' || /^ci-/.test(r.outcome ?? '')).map((r) => r.key)])];
  if (waiting.length && outcome === 'done') {
    outcome = 'waiting';
    reason = `${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} for a person's decision (on the ticket)`;
    log(`WAITING: ${reason}`);
  }
  // A group with nothing to deliver needs no PR; only a group that should have one and has none is a gap (council C3:
  // "PRs were not all opened" was printed when the only PR-less groups had nothing to deliver).
  const missingPr = all.filter((r) => !r.pr && !r.noPr);
  const delivered = outcome === 'done' && (!missingPr.length || !env.pr || prsDisabled());
  saveEpicRun(config, epic.key, { status: outcome === 'done' ? (prs.length ? 'delivered' : 'complete') : outcome === 'waiting' ? 'waiting' : 'failed', outcome, reason, prs, waiting, phase: 'finished', pid: null, finishedAt: nowIso() });
  if (outcome === 'done') {
    const fresh = all.filter((r) => r.pr && !r.earlier).length;
    const earlier = all.filter((r) => r.earlier && r.pr).length;
    const empty = all.filter((r) => r.noPr).length;
    log(`every unit verified: ${fresh} group PR(s) opened by this run${earlier ? `, ${earlier} delivered by an earlier run` : ''}${empty ? `, ${empty} with nothing to deliver` : ''}${missingPr.length ? `; ${missingPr.length} group(s) without the PR they should have` : ''}`);
  }
  if (!delivered && outcome === 'done') log(`not delivered: ${missingPr.length} group(s) have no PR`);
  return { results, epic: { key: epic.key, outcome, reason, prs, branches: units.map((u) => u.branch) } };
}

// One unit, from its worktree to its PR. Returns { outcome, results, pr, reason }.
async function deliverUnit(env, unit, units, epicWt) {
  const { config, epic, tickets, deps, E, note, only, epicBase } = env;
  const feature = unit.kind === 'epic';
  const log = (m) => env.log(feature ? m : `group ${unit.id}: ${m}`);
  // A group stacks on the groups it depends on (their branches hold the tickets its tickets need).
  const depBranches = unit.deps.map((d) => units.find((u) => u.id === d)?.branch).filter(Boolean);
  const unitBase = depBranches[0] ?? epicBase;
  let wtConfig = epicWt;
  try {
    wtConfig ??= prepareUnitWorktree(config, { branch: unit.branch, worktree: unit.worktree, base: unitBase, merge: depBranches.slice(1), tickets: [...(epic.file ? [epic] : []), ...tickets.filter((t) => unit.keys.includes(t.key))] });
  } catch (error) {
    const results = unit.keys.map((k) => ({ key: k, outcome: 'blocked', reason: error.message }));
    saveUnit(config, epic.key, unit.id, { status: 'failed', outcome: 'blocked', reason: error.message });
    return { outcome: 'blocked', results, reason: error.message };
  }
  const uenv = { ...env, unit, wtConfig, worktree: unit.worktree, branch: unit.branch, base: unitBase, prBase: unitBase, log, stories: env.stories.filter((s) => unit.keys.includes(s.key)) };
  // A group whose PR is already open (a reopened bug fix joins it): take a person's commits on the PR first.
  const openPr = only && !feature ? loadEpicRun(config, epic.key).units?.[unit.id]?.pr ?? null : null;
  if (openPr && !syncFromRemote(unit.worktree, unit.branch, commitEnv)) log(`${unit.branch} could not be fast-forwarded to origin; continuing from the local branch`);
  const shared = unitDelivery(env, unit, uenv, { feature });
  const io = { ...deliveryIo(wtConfig), ...shared.io };
  const prior = loadEpicRun(config, epic.key).units?.[unit.id] ?? {};
  // A run that stopped after the unit's PR opened continues after the open (resume): no agent runs again. A PR opened
  // right before the stop, before the run recorded it, is found on the host and adopted, never opened twice.
  let after = !only && env.pr && !prsDisabled() && ['ci-wait', 'draft-back'].includes(prior.delivery?.phase) && prior.delivery?.pr ? prior.delivery : null;
  if (!after && !only && env.pr && !prsDisabled() && prior.delivery?.phase === 'pre-open' && !prior.delivery.pr) {
    const adopted = adoptOpenedPr(wtConfig, unit.branch, { io });
    if (adopted) {
      log(`${adopted.pr} was opened by the earlier run before it stopped; continuing after the open`);
      shared.save({ phase: 'ci-wait', pr: adopted.pr, preOpen: true, openedAt: adopted.openedAt, readyAt: adopted.readyAt, holds: adopted.holds });
      after = { ...prior.delivery, ...adopted };
    }
  }
  if (after) {
    log(`resuming after the open of ${after.pr}`);
    const results = unit.keys.map((k) => ({ key: k, outcome: 'done', reason: null, pr: after.pr }));
    const out = await afterOpen(config, wtConfig, { ...shared, io, prUrl: after.pr, result: {}, readyAt: after.readyAt ?? null, holds: after.holds ?? [] });
    const finishResumed = async (outcome, extra = {}) => {
      saveUnit(config, epic.key, unit.id, { status: outcome === 'done' ? 'done' : 'failed', outcome, ...extra });
      await deps.shipMetrics?.(wtConfig);
      return { outcome, results, ...extra };
    };
    return finishDelivery(env, unit, uenv, { out, results, finish: finishResumed, log });
  }
  // A unit whose PR is open (a reopened ticket joins it, or an earlier run delivered it and this one works on it again):
  // the PR is put on hold before any agent runs, and marked ready again only by the delivery, once CI is green.
  const openNow = env.pr && !prsDisabled() ? openPr ?? (prior.pr && prior.status !== 'done' && deps.prState?.(prior.pr) === 'OPEN' ? prior.pr : null) : null;
  if (openNow && !prior.delivery?.holds?.some((h) => !h.to)) {
    const hold = holdOpenPr(wtConfig, openNow, only ? `${only.join(', ')} joins it again` : 'its tickets are worked on again', { io });
    shared.save({ pr: openNow, preOpen: true, holds: [...(prior.delivery?.holds ?? []), hold] });
  }
  saveUnit(config, epic.key, unit.id, { status: 'running', base: unitBase });

  const results = await runUnitStories(uenv, { parallel: feature ? env.parallel : 1, deferReview: !feature });
  if (only && openPr && env.pr && !prsDisabled()) {
    // The re-run fix goes onto the open group PR (on hold since before the agents ran), through the same delivery: CI
    // proven on the branch head, the gate's rating made before the PR is marked ready again, its tickets back to Pending
    // Review with it.
    const state = loadEpicRun(config, epic.key);
    const merged = results.filter((x) => DONE.has(x.outcome) && state.stories?.[x.key]?.merged);
    const held = state.units?.[unit.id]?.delivery ?? {};
    const out = await deliverFinished(config, wtConfig, {
      ...shared,
      title: null,
      body: io.prBody?.(openPr) ?? `Fix ${unit.keys.join(', ')}: ${unit.group.title}`,
      result: {},
      existingPr: openPr,
      holds: held.holds ?? [],
      openedAt: held.openedAt ?? null,
      readyAt: held.readyAt ?? null,
      open: () => ({ pushed: false, url: null, reason: 'an open PR is never opened again' }),
      onOpen: (url) => {
        for (const r of merged) reportStory(uenv, r, url);
      },
    });
    for (const r of results) if (out.outcome && DONE.has(r.outcome)) Object.assign(r, { outcome: out.outcome, reason: out.reason, findings: out.findings, pr: openPr });
    saveUnit(config, epic.key, unit.id, { status: out.outcome ? 'failed' : 'done', ...(out.outcome ? { outcome: out.outcome, reason: out.reason } : {}) });
  }
  if (only) {
    await deps.shipMetrics?.(wtConfig);
    return { outcome: 'joined', results };
  }
  const state = loadEpicRun(config, epic.key);
  // Every ticket merged into the unit, in this run or an earlier one: a group PR opened by a later run
  // moves the cards of the tickets merged before it too.
  const delivered = results.filter((x) => state.stories?.[x.key]?.merged);
  const open = results.filter((r) => !(DONE.has(r.outcome) && state.stories?.[r.key]?.merged) && !(r.outcome === 'skipped' && !/^blocker /.test(r.reason ?? '')));
  const finish = async (outcome, extra = {}) => {
    saveUnit(config, epic.key, unit.id, { status: outcome === 'done' ? 'done' : 'failed', outcome, ...extra });
    if (!feature) recordGroupOutcome(uenv, unit, results, extra.pr ?? null, outcome);
    await deps.shipMetrics?.(wtConfig);
    return { outcome, results, ...extra };
  };
  // A group none of whose tickets is merged into its branch (all delivered elsewhere or skipped) has nothing for a PR.
  if (!feature && !open.length && !delivered.length) {
    const reason = `nothing to deliver in group ${unit.id}: ${results.map((r) => `${r.key} ${r.reason ?? r.outcome}`).join('; ')}`;
    log(`no PR: ${reason}`);
    saveUnit(config, epic.key, unit.id, { status: 'done', outcome: 'done', noPr: true, reason, noPrReason: results.map((r) => `${r.key} ${r.reason ?? r.outcome}`).join('; ') });
    return { outcome: 'done', results, reason, noPr: true };
  }
  if (open.length) {
    const reason = `${feature ? 'epic' : `group ${unit.id}`} not delivered: ${open.map((r) => `${r.key} ${r.outcome}`).join(', ')}`;
    log(`no PR: ${reason}`);
    if (!feature) for (const r of delivered) reportStory(uenv, r);
    return finish('stories-failed', { reason, failed: open.filter((r) => r.outcome !== 'skipped').map((r) => r.key) });
  }

  // Unit-level feature verification over the cross-story journeys: the whole epic's for a feature epic; for a bug group
  // only journeys the plan lists whose tickets are all in this group.
  // A feature epic split into PRs: the journey group verifies every journey (its branch is stacked on the others).
  const journeys = feature || unit.journeys ? note?.journeys ?? [] : unit.feature ? [] : (note?.journeys ?? []).filter((j) => j.stories.length && j.stories.every((k) => unit.keys.includes(k)));
  const fvKey = epicTestKey(epic.key, epic.number);
  let fv = state.units?.[unit.id]?.fv ?? null;
  if (E.featureVerification !== false && (feature || journeys.length) && fv?.status !== 'verified') {
    log(`unit feature verification (${fvKey}): ${journeys.length} cross-story journey(s)`);
    fv = { key: fvKey, ...(await deps.epicFv(uenv, { key: fvKey, note: { ...(note ?? { summary: '' }), journeys } })) };
    commitAll(unit.worktree, `${fvKey}: Add verified epic test plan and automated tests`);
    saveUnit(config, epic.key, unit.id, { fv });
    if (fv.status !== 'verified') return finish(`epic-fv-${fv.status}`, { reason: `epic-level feature verification ended ${fv.status}${fv.bugs?.length ? `: ${fv.bugs.length} bug(s)` : ''}` });
  }

  // A stacked group's branch also carries the plans of the groups it stacks on, which the pre-push
  // feature verification check verifies too.
  const stacked = new Set();
  const addStack = (u) => {
    for (const d of u?.deps ?? []) {
      if (stacked.has(d)) continue;
      stacked.add(d);
      addStack(units.find((x) => x.id === d));
    }
  };
  addStack(unit);
  const branchKeys = [...unit.keys, ...units.filter((u) => stacked.has(u.id)).flatMap((u) => u.keys)];
  syncTickets(uenv, branchKeys, state);
  // Tickets of one branch add cases to the same spec files, so a later ticket changes the files an
  // earlier ticket's verified tests live in and that ticket's automation hash goes stale. Its feature verification runs
  // again in the unit worktree (verifier gate unchanged) before the pre-push check sees it.
  const reverified = await deps.reverifyStale(uenv, branchKeys);
  if (reverified.failed.length) return finish('fv-reverify-failed', { reason: `re-verifying the tests of ${reverified.failed.join(', ')} after later tickets edited their spec files failed` });

  // The PR check for the whole unit, in one run: every ticket (frontend ones get the design lens) and
  // the journeys. Each ticket's row in the PR body shows the unit's result.
  let prChecks = { ...(state.units?.[unit.id]?.prChecks ?? {}) };
  const mode = E.prCheck ?? 'report';
  const checked = [...unit.keys, ...(fv?.status === 'verified' ? [fvKey] : [])];
  if (mode !== 'off' && !checked.every((k) => prChecks[k])) {
    log(`PR check ${checked.join(', ')} against ${unit.branch} (${mode})`);
    const result = await deps.prCheck(uenv, checked, { fix: mode === 'fix' });
    prChecks = Object.fromEntries(checked.map((k) => [k, result]));
    saveUnit(config, epic.key, unit.id, { prChecks, prCheck: result });
    commitAll(unit.worktree, `${feature ? epic.key : unit.id}: Record PR check metrics`, [wtConfig.metricsDir]);
  }

  // The tickets as CI will read them: published from this unit's copy and fetched back from the board before the parity
  // run, so its `fv check` reads the same text CI does (council C4, D-C7-1: parity read a group copy the board never got).
  if (!feature && env.pr && !prsDisabled()) {
    for (const k of unit.keys) {
      deps.board(unit.worktree, k, ['publish', k]);
      deps.board(unit.worktree, k, ['fetch', k, '--refresh']);
    }
  }

  // What CI runs on the PR, run here first; failures go back through the fixing loop (dogfood C4).
  let parity = null;
  if (!feature && env.pr && !prsDisabled() && deps.parityGate) {
    const penv = { ...process.env, PIPELINE_ROOT: unit.worktree, PIPELINE_BASE_REF: unitBase, PIPELINE_HEADLESS: '1', PIPELINE_TICKETS_OFFLINE: '1', PIPELINE_STORY_SOURCES: [process.env.PIPELINE_STORY_SOURCES, ...unit.keys.map((k) => ticketDir(wtConfig, k))].filter(Boolean).join(path.delimiter) };
    delete penv.PIPELINE_CHILD;
    delete penv.PIPELINE_DISABLE;
    parity = deps.parityGate({ cwd: unit.worktree, base: unitBase, targetArgs: ['--stories', unit.keys.join(',')], seedFile: path.join(unit.worktree, wtConfig.stateDir ?? '.factory/state', 'pr-check', `${unit.id}-ci-parity.json`), prCheckCli: PR_CHECK_CLI, env: penv, log });
    commitAll(unit.worktree, `${unit.id}: Record CI parity metrics`, [wtConfig.metricsDir]);
  }

  // One PR for the unit, then the board.
  const runs = Object.fromEntries(results.map((r) => [r.key, r]));
  // Follow-ups the implementers listed instead of widening their tickets (filing them is up to people).
  const followUps = [...withoutResolved(results.flatMap((r) => (r.followUps ?? []).map((u) => ({ ...u, ticket: r.key }))), Object.values(prChecks)), ...prCheckFollowUps(Object.values(prChecks))];
  if (followUps.length) saveUnit(config, epic.key, unit.id, { followUps });
  const conditions = runConditionsSection(runConditions(wtConfig, [...unit.keys, ...(fv?.key ? [fv.key] : [])]), deps.lsp?.unavailable?.(unit.worktree) ?? []);
  const councilSection = councilReviewSection(councilRecords(wtConfig, [...unit.keys, ...(fv?.key ? [fv.key] : [])]));
  const plainBody = ownerDecisionBlock(unitQuestions(prChecks)) + epicPrBody({ followUps, conditions, parity: paritySection(parity?.results), fullProjects: fullProjectsSection(fullProjectRuns(wtConfig, [...unit.keys, ...(fv?.key ? [fv.key] : [])])), epic, branch: unit.branch, stories: uenv.stories, results: runs, fv, prChecks, foundation: feature ? loadEpicRun(config, epic.key).foundation : null, noteFile: path.relative(config.root, env.noteFile), group: feature ? null : unit.group });
  // The council's results, when a stage seated one for these tickets; nothing without a council.
  const councilBody = councilSection ? withCouncilReview(plainBody, councilSection) : plainBody;
  const analysisSection = prAnalysisSection(wtConfig, [...unit.keys, ...(fv?.key ? [fv.key] : [])], { cwd: unit.worktree });
  const body = analysisSection ? withStaticAnalysis(councilBody, analysisSection) : councilBody;
  if (!env.pr || prsDisabled()) {
    if (!feature) for (const r of delivered) reportStory(uenv, r);
    log(`every ticket verified and merged into ${unit.branch}${env.pr ? ' (PRs disabled)' : '; --pr opens the PR'}`);
    return finish('done', { prBody: body });
  }
  const epicTitle = (epic.title ?? epic.key).replace(/^Epic:\s*/i, '');
  const title = feature ? `Epic: ${epicTitle}` : unit.feature ? featureGroupTitle(epicTitle, unit.group.title, unit.keys) : `Fix ${unit.keys.join(', ')}: ${unit.group.title}`;
  // The unit's PR opens finished, through the same delivery as a standalone ticket's (implement.mjs deliverFinished):
  // every agent stage done, CI proven on the branch head, the PR opened once with its full body, and after the open only
  // deterministic steps; a failure before the open escalates on the tickets with no PR (owner requirement C16, C18).
  // A unit whose PR is already open (delivered by an earlier run) was put on hold before its agents ran again.
  const now = loadEpicRun(config, epic.key).units?.[unit.id] ?? {};
  const existing = now.pr && now.delivery?.holds?.some((h) => !h.to) ? now.pr : null;
  const out = await deliverFinished(config, wtConfig, {
    ...unitDelivery(env, unit, uenv, { feature, fvKey: fv?.key ?? null }),
    title,
    body,
    result: {},
    questions: unitQuestions(prChecks),
    // An escalated unit PR check (fix mode) is a pre-open failure: no PR, the findings on the tickets.
    prcIncomplete: prCheckHold(Object.values(prChecks)[0] ?? null, { mode, fixUntil: (wtConfig.implement.prCheck ?? {}).fixUntil ?? 'major', issues: unit.keys.map((k) => uenv.stories?.find?.((st) => st.key === k)?.number ?? null).filter(Boolean) }),
    existingPr: existing,
    holds: existing ? now.delivery.holds : [],
    openedAt: existing ? now.delivery.openedAt ?? null : null,
    readyAt: existing ? now.delivery.readyAt ?? null : null,
    open: (x) => deps.openPr(uenv, { ...x, existing: null, records: false }),
    onOpen: (url, { existing: wasOpen }) => reportUnitPr(env, unit, uenv, { url, feature, delivered, followUps, existing: wasOpen }),
  });
  return finishDelivery(env, unit, uenv, { out, results, finish, log });
}

// What every delivery of a unit's PR shares (a first delivery, a re-delivery, a joined ticket, a resume).
function unitDelivery(env, unit, uenv, { feature, fvKey = null }) {
  const { config, epic, deps } = env;
  const keys = unit.keys;
  return {
    id: `${epic.key}--${unit.id}`,
    keys,
    // The PR's ready audit covers every agent run of its tickets, their feature verification and the epic's own stages.
    auditKeys: [...keys, ...(fvKey ? [fvKey] : []), ...(feature ? [epic.key] : [])],
    label: feature ? epic.key : `group ${unit.id}`,
    branch: unit.branch,
    worktree: unit.worktree,
    base: uenv.prBase,
    // The review gate's bug-fix rating is for bug groups only; a feature epic's group PR is a feature PR.
    isBug: !feature && !unit.feature,
    issues: keys.map((k) => uenv.stories?.find?.((st) => st.key === k)?.number ?? null).filter(Boolean),
    targetArgs: ['--stories', keys.join(',')],
    env: ciEnv(uenv),
    save: (s) => saveUnit(config, epic.key, unit.id, { ...(s.pr ? { pr: s.pr } : {}), delivery: { ...(loadEpicRun(config, epic.key).units?.[unit.id]?.delivery ?? {}), ...s } }),
    load: () => loadEpicRun(config, epic.key).units?.[unit.id]?.delivery ?? null,
    io: { ...(deps.deliveryIo ?? {}), publishTicket: (wt, k) => (feature ? null : deps.board(unit.worktree, k, ['publish', k])) },
  };
}

// The board after a unit's PR opened (or, for a PR on hold, was refreshed): the tickets to Pending Review, the epic's PR list.
function reportUnitPr(env, unit, uenv, { url, feature, delivered, followUps = [], existing = false }) {
  const { config, epic, deps } = env;
  if (feature) {
    if (epic.number && !existing) deps.board(config.root, epic.key, ['epic-pr', String(epic.number), '--pr', url, '--branch', unit.branch]);
    return;
  }
  for (const r of delivered) reportStory(uenv, r, url);
  if (epic.number && !existing) deps.board(config.root, epic.key, ['epic-pr', String(epic.number), '--pr', url, '--branch', unit.branch, '--group', unit.id, '--title', unit.group.title, '--tickets', unit.keys.join(','), ...(followUps.length ? ['--follow-ups', JSON.stringify(followUps.map((u) => `${u.ticket ? `${u.ticket}: ` : ''}${u.title}`))] : [])]);
}

// A unit's tickets take the delivery's outcome: a failure before the open (no PR) or after it (CI, a person's decision).
async function finishDelivery(env, unit, uenv, { out, results, finish, log }) {
  if (out.outcome) {
    log(`${out.pr ? `PR ${out.pr}` : 'no PR'}: ${out.reason}`);
    for (const r of results) if (unit.keys.includes(r.key) && DONE.has(r.outcome)) Object.assign(r, { outcome: out.outcome, reason: out.reason, findings: out.findings, ...(out.delivery ? { delivery: out.delivery } : {}), ...(out.pr ? { pr: out.pr } : {}) });
    return finish(out.outcome, { pr: out.pr ?? null, reason: out.reason, ...(out.ci ? { ci: out.ci } : {}), ...(out.branchPushed ? { branchPushed: true } : {}) });
  }
  log(`PR: ${out.pr}`);
  return finish('done', { pr: out.pr, ...(out.ci ? { ci: out.ci } : {}) });
}

const unitQuestions = (prChecks) => {
  const seen = new Map();
  for (const r of Object.values(prChecks ?? {})) for (const q of r?.questions ?? []) if (!seen.has(q.id)) seen.set(q.id, q);
  return [...seen.values()];
};

// Per-group outcome for the retro (decision-outcomes, type pr-group): written in this checkout's
// .factory/metrics, next to the bug epic's plan decisions.
function recordGroupOutcome(env, unit, results, pr, outcome) {
  if (unit.kind !== 'group') return;
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  const state = loadEpicRun(env.config, env.epic.key);
  const conflicts = unit.keys.filter((k) => state.stories?.[k]?.conflicts?.length || byKey[k]?.outcome === 'merge-conflict').length;
  appendJsonl(metricsFile(env.config, OUTCOMES_FILE), [{ ...groupOutcome({ ts: nowIso(), epic: env.epic, decisionId: env.decisionId, group: unit.group ?? { id: unit.id, tickets: unit.keys }, results: byKey, pr, outcome, costUsd: sum(results.map((r) => r.cost_usd)), mergeConflicts: conflicts }), ...runTags() }]);
}

// Schedules a unit's tickets: Blocked-by (and the note's dependsOn) order, at most `parallel` at once,
// never two stories whose planned `owns` overlap at the same time; each verified story is merged into
// the unit branch before its dependents start. A failed story's dependents are skipped; independent
// stories keep going.
async function runUnitStories(env, { parallel, deferReview }) {
  const { config, epic, branch, note, deps, log, inputs, force, script, noteFile, unit } = env;
  const mine = inputs.filter((p) => unit.keys.some((k) => p.split(path.sep).includes(k) || path.basename(p).startsWith(`${k}-`)));
  const planned = planStories(config, mine, { base: branch, force, placeReopenedRuns: false }).filter((s) => !env.only || env.only.includes(s.key));
  const state = loadEpicRun(config, epic.key);
  const byKey = new Map(planned.map((s) => [s.key, s]));
  for (const s of planned) {
    Object.assign(s, { base: branch, merge: [], epicBranch: branch, epicNote: fs.existsSync(noteFile) ? noteFile : null });
    if (state.stories?.[s.key]?.merged && !force) s.skip = `merged into ${branch} in a previous run`;
    // A ticket already delivered in a PR of its own (a single-ticket run) is not delivered again in a group
    // PR (dogfood C2: the epic merged a ticket's branch into a new group and was about to open a second PR next
    // to its open #21); one done on a branch without a PR is merged into the unit, as before.
    else if (s.ownPr && !force) s.skip = `delivered in its own PR ${s.ownPr}`;
    else if (s.doneBefore) Object.assign(s, { skip: null, mergeOnly: true });
  }
  const sdeps = epicDeps(planned, note);
  // A blocker that is already implemented (and so skipped) is on the base branch, like in story
  // delivery: its dependents don't wait for it to be merged into the epic branch.
  const delivered = new Set(planned.filter((s) => s.implemented && !force).map((s) => s.key));
  for (const [k, ds] of sdeps) sdeps.set(k, ds.filter((d) => !delivered.has(d)));
  const owns = new Map((note?.stories ?? []).map((s) => [s.key, s.owns]));
  const outcome = new Map();
  const pending = new Set();
  for (const s of planned) {
    if (s.skip) outcome.set(s.key, skippedOutcome(s));
    else pending.add(s.key);
  }
  const merged = new Set(planned.filter((s) => state.stories?.[s.key]?.merged).map((s) => s.key));
  // A standing escalation counts as failed, so its dependents are skipped for it.
  const failed = new Set(planned.filter((s) => s.escalatedBefore && !merged.has(s.key)).map((s) => s.key));
  const running = new Map();
  const order = planned.map((s) => s.key);
  const finishStory = async (s, result) => {
    if (!DONE.has(result.outcome)) {
      failed.add(s.key);
      saveStory(config, epic.key, s.key, { outcome: result.outcome, reason: result.reason ?? null, merged: false, status: 'finished', followUps: result.followUps ?? [] });
      return result;
    }
    const m = await mergeStory(env, s);
    if (!m.ok) {
      failed.add(s.key);
      const r = { ...result, outcome: 'merge-conflict', reason: m.reason, findings: (m.files ?? []).map((f) => ({ file: f, issue: `merge conflict into ${branch}` })) };
      saveStory(config, epic.key, s.key, { outcome: r.outcome, reason: r.reason, merged: false, status: 'finished' });
      return r;
    }
    merged.add(s.key);
    saveStory(config, epic.key, s.key, { outcome: 'done', status: 'finished', merged: true, mergedSha: m.sha, mergedAt: nowIso(), conflicts: m.conflicts ?? [], unit: unit.id, branch: s.branch, mode: result.mode ?? null, agentRuns: result.agentRuns ?? null, reviewBlocks: result.reviewBlocks ?? null, bugFixCycles: result.bugFixCycles ?? null, cost_usd: result.cost_usd ?? null, followUps: result.followUps ?? [], disputes: result.disputes ?? null });
    log(`${s.key} merged into ${branch}`);
    // A feature epic's card goes to Pending Review now; a bug group's waits for the group PR.
    if (!deferReview) reportStory(env, s);
    return { ...result, mergedSha: m.sha };
  };

  const storiesStarted = Date.now();
  for (;;) {
    const skippedByBlocker = [...outcome].filter(([, r]) => r.outcome === 'skipped' && /^blocker /.test(r.reason ?? '')).map(([k]) => k);
    // An agent provider outage (outage.mjs): start no more stories and skip none for it.
    const { start, skip } = readOutage(storiesStarted) ? { start: [], skip: [] } : nextStories({ order, deps: sdeps, owns, pending, running: new Set(running.keys()), merged, failed: new Set([...failed, ...skippedByBlocker]), slots: parallel });
    for (const { key, blocker } of skip) {
      pending.delete(key);
      const r = { outcome: 'skipped', reason: `blocker ${blocker} ended ${outcome.get(blocker)?.outcome ?? 'failed'}` };
      outcome.set(key, r);
      saveStory(config, epic.key, key, { outcome: 'skipped', reason: r.reason, merged: false });
      log(`${key}: ${r.reason}; skipped.`);
    }
    for (const key of start) {
      pending.delete(key);
      const s = byKey.get(key);
      saveStory(config, epic.key, key, { outcome: null, status: 'running', unit: unit.id, branch: s.branch, worktree: s.worktree, startedAt: nowIso() });
      const work = s.mergeOnly ? Promise.resolve({ key, outcome: 'done', branch: s.branch, worktree: s.worktree }) : waitForMemory(config, key).then(() => deps.startWorker(config, s, { pr: false, script }));
      running.set(key, work.then((result) => finishStory(s, result)).then((r) => [key, r]));
    }
    if (!running.size) {
      if (skip.length) continue;
      break;
    }
    const [key, r] = await Promise.race(running.values());
    running.delete(key);
    outcome.set(key, r);
    log(`${key}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
  }
  // Stories that could never start (a dependency outside the epic that never merged) are reported too.
  const outage = readOutage(storiesStarted);
  for (const key of pending) outcome.set(key, outage ? { outcome: null, reason: 'not started: the agent provider is unavailable' } : { outcome: 'skipped', reason: 'its dependencies were never merged' });
  return planned.map((s) => ({ ...s, ...outcome.get(s.key) }));
}

// Lines per epic run for `implement status`.
export function formatEpicStatus(state) {
  const stories = Object.entries(state.stories ?? {});
  const merged = stories.filter(([, s]) => s.merged).map(([k]) => k);
  const failed = stories.filter(([, s]) => s.outcome && !['done', 'skipped'].includes(s.outcome)).map(([k]) => k);
  const skipped = stories.filter(([, s]) => s.outcome === 'skipped').map(([k]) => k);
  const running = stories.filter(([, s]) => s.status === 'running').map(([k]) => k);
  const kind = state.shape?.kind === 'groups' ? 'bug epic' : 'epic';
  const lines = [`${state.epic} (${kind}, ${state.status ?? '-'})${state.prs?.length ? `  ${state.prs.join(' ')}` : ''}`];
  lines.push(`           plan ${state.plan?.ok ? 'written' : 'not yet'}${state.foundation ? `, foundation ${state.foundation.status}` : ''}, merged ${merged.length}/${stories.length}${merged.length ? ` (${merged.join(', ')})` : ''}${running.length ? `, running ${running.join(', ')}` : ''}${failed.length ? `, failed ${failed.join(', ')}` : ''}${skipped.length ? `, skipped ${skipped.join(', ')}` : ''}`);
  for (const u of Object.values(state.units ?? {})) lines.push(`           ${u.kind === 'group' ? `group ${u.id}` : 'epic'}: ${u.branch} ${u.status ?? 'pending'}${u.keys ? ` [${u.keys.join(', ')}]` : ''}${u.fv ? `, feature verification ${u.fv.status}` : ''}${u.pr ? `  ${u.pr}` : ''}`);
  if (state.reason) lines.push(`           ${state.reason}`);
  return lines.join('\n');
}
