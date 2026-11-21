// The orchestrated implement flow for one story, run by the harness (not by an LLM managing loops):
//   plan (orchestrator, read mode) -> validate -> verifier pairs per subtask, in their own worktrees, at
//   most `maxConcurrentPairs` at once -> escalation to the orchestrator -> serial merges into the story
//   branch -> (implement.mjs) integration pass, review loop, feature verification, PR.
// Every agent is a separate headless CLI process (claude, copilot, codex or PIPELINE_AGENT_CMD), so the
// flow does not depend on any one CLI's subagent features. See docs/ai-pipeline/implement.md.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ceiling, runAgentAsync } from '../../pipeline/lib/agents.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { readDecisions } from '../../pipeline/lib/human-decisions.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, extractResult, log as defaultLog, nowIso, readJson, runAsync, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { agentEnv, changedSince, contestedText, councilActionsText, councilFor, councilMemory, fixDeclarationText, fixesFile, memoryFile, nameFindings, memberRunEnv, councilRounds, disputesFor, guardProtectedTests, lateBox, protectedTestFinding, memberScore, memberTask, mergeCouncil, planCases, recordCouncilRound, rewriteText, runCouncil, testProtection, adjudicate } from '../../pipeline/lib/council.mjs';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { runTags } from '../../pipeline/lib/run-tags.mjs';
import { addUsage } from '../../pipeline/lib/usage.mjs';
import { SUBTASK_RUNS_FILE, crossFindings, decisionRecord, planDecisionLog, roundRecord, subtaskRunRecord, verdictDecisionLog } from './decisions.mjs';
import { HARNESS_EXCLUDES, commitAll, commitEnv, createSubtaskWorktree, diffSince, discardChanges, filesChanged, headSha, mergeInProgress, removeWorktree, unmergedFiles } from './gitops.mjs';
import { disputeCounts, formatDisputes, openDisputes, parseImplementerReport, ruleDisputes, withIds } from './disputes.mjs';
import { diagnosticFindings, formatDiagnostics, lspAdapter, signatureChanges } from './lsp.mjs';
import { matchesAny } from './plan.mjs';
import { pairHandoff } from '../../pipeline/lib/finding-route.mjs';
import { isUiStory, parsePlanOutput, uiRules, parseVerdict, resolveModelForRole, roleCli, scopeViolations, topoOrder, validatePlan, validateRewrite } from './plan.mjs';
import { pathLikeRegex, servicesOf, servicesOfFile } from './project.mjs';
import { waitForMemory } from './resources.mjs';
import { formatMockups, formatRenders, hasMockups, mockupFilesOf, renderMockups, storyMockups } from './mockups.mjs';
import { acquire, semaphoreDir } from './semaphore.mjs';
import { resolveAnalysis } from '../../pipeline/lib/analysis/config.mjs';
import { fixLoop, recordAnalysis } from '../../pipeline/lib/analysis/fixloop.mjs';
import { evidenceText, isToolFinding, preexistingFollowUps, toolFindings } from '../../pipeline/lib/analysis/report.mjs';
import { stackAdapter } from './stack.mjs';
import { codeVerifierTask, conflictTask, escalationTask, pairImplementerTask, planTask, uiVerifierTask } from './tasks.mjs';

// A hard stop (agent runs, wall clock): the story ends with `outcome`.
export class LimitError extends Error {
  constructor(outcome, message) {
    super(message);
    this.outcome = outcome;
  }
}
class AbortedError extends Error {}

export function createContext({ config, key, storyFile, branch, worktree, base, epicNote = null, resume = false, deps = {}, onProgress = () => {}, log = defaultLog }) {
  const s = config.implement;
  const started = Date.now();
  const ctx = {
    config,
    s,
    key,
    resume,
    storyFile,
    storyText: fs.readFileSync(storyFile, 'utf8'),
    // A human's answers to an earlier run's escalation questions (decisions.md next to the story).
    decisions: readDecisions(storyFile),
    // Epic delivery: the epic design note, handed to the planner.
    epicNote,
    branch,
    worktree,
    base,
    started,
    // A ceiling, not the usual budget: slow agents make a story slower, never end it (council C12).
    deadline: started + ceiling(config, s.storyWallClockSec) * 1000,
    abort: new AbortController(),
    log: (m) => log(`${key}: ${m}`),
    storyBaseSha: headSha(worktree),
    decisionId: null,
    plan: null,
    subtasks: new Map(), // id -> { status, branch, worktree, rounds }
    integrationNotes: [],
    // Test gaps pair verifiers raised: required cases for feature verification (implement.mjs records them).
    requiredCases: [],
    metrics: { agentRuns: 0, byRole: {}, pairRounds: 0, takeovers: 0, escalations: 0, limitHit: null, mode: null, lspCalls: 0, signatureChangesWithoutReferences: false, leaseWaitSec: 0, usage: null, followUps: [], analysisBounces: 0, analysisFixed: 0 },
  };
  ctx.deps = {
    runAgent: deps.runAgent ?? runAgentAsync,
    stack: deps.stack ?? stackAdapter(config),
    lsp: deps.lsp ?? lspAdapter(config, { log: ctx.log }),
    acquire: deps.acquire ?? ((label) => acquire(semaphoreDir(config.root), s.maxConcurrentAgents, { deadline: ctx.deadline, label })),
    memoryGate: deps.memoryGate ?? ((label) => waitForMemory(config, label)),
    renderMockups: deps.renderMockups ?? renderMockups,
  };
  ctx.progress = () =>
    onProgress({
      orchestration: {
        mode: ctx.metrics.mode,
        decisionId: ctx.decisionId,
        agentRuns: ctx.metrics.agentRuns,
        lspCalls: ctx.metrics.lspCalls,
        signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences,
        followUps: ctx.metrics.followUps,
        subtasks: [...ctx.subtasks.entries()].map(([id, st]) => ({ id, ...st })),
      },
    });
  return ctx;
}

const record = (ctx, file, rec) => appendJsonl(metricsFile(ctx.config, file), { ...rec, ...runTags() });

// The story's mockups (its own, and the epic's when the epic was handed to the run), found once.
const mockupsOf = (ctx) => (ctx.mockups ??= storyMockups(ctx.config, ctx.storyFile));
const mockupText = (ctx) => (hasMockups(mockupsOf(ctx)) ? formatMockups(mockupsOf(ctx)) : null);

// Wall clock and agent-run budget for a story; throws LimitError when either is spent.
export function checkBudget(ctx) {
  if (ctx.abort.signal.aborted) throw new AbortedError('aborted');
  if (ctx.metrics.agentRuns >= ctx.s.maxAgentRunsPerStory) throw limit(ctx, 'limit-agent-runs', `the story used all ${ctx.s.maxAgentRunsPerStory} agent runs (maxAgentRunsPerStory)`);
  const left = ctx.deadline - Date.now();
  if (left <= 0) throw limit(ctx, 'limit-wall-clock', `the story ran past its ${ceiling(ctx.config, ctx.s.storyWallClockSec)}s ceiling (storyWallClockSec × agent.supervisor.ceilingFactor)`);
  return Math.floor(left / 1000);
}

function limit(ctx, outcome, message) {
  ctx.metrics.limitHit ??= outcome;
  return new LimitError(outcome, message);
}

// The model and CLI a role runs with.
export function agentSettings(config, role, modelClass, explicitModel = null) {
  const s = config.implement;
  const cli = s.roles?.[role]?.cli || null;
  const model = resolveModelForRole(config, role, modelClass, explicitModel);
  return { cli, model, cliName: config.agent.cmd ? 'custom' : roleCli(config, role) };
}

// Token usage is attributed to a stage per role; `step` is the plan, the merge or the subtask id.
const USAGE_STAGE = { orchestrator: 'implement', pairImplementer: 'implement-pair', verifier: 'implement-verify', uiVerifier: 'implement-ui-verify' };

// Runs one agent under the story's budget and the machine-wide agent semaphore.
export async function callAgent(ctx, { role, name, task, mode, modelClass = 'medium', model: explicitModel = null, cwd, timeoutSec, step = null, round = null, env = {}, member = null, signal = null }) {
  checkBudget(ctx);
  const release = await ctx.deps.acquire(`${ctx.key}:${name}`);
  if (!release) throw limit(ctx, 'limit-wall-clock', 'no agent slot (maxConcurrentAgents) before the story deadline');
  try {
    const left = checkBudget(ctx);
    ctx.metrics.agentRuns++;
    ctx.metrics.byRole[role] = (ctx.metrics.byRole[role] ?? 0) + 1;
    // A council member runs on its own CLI, model and effort (council.mjs); every other agent on its role's.
    const { cli, model, cliName } = member ? { cli: member.cli === 'custom' ? null : member.cli, model: member.model ?? null, cliName: ctx.config.agent.cmd ? 'custom' : member.cli } : agentSettings(ctx.config, role, modelClass, explicitModel);
    const t0 = Date.now();
    // The story's own ticket (story and mockups) is open to every agent of its run, in whichever worktree
    // it works (the story guard matches the key in any checkout's ticket cache); nothing else is added.
    // A role's own `env` (implement.roles.<role>.env, beside its `cli`), for example a second login's CLI home folder.
    const roleEnv = member ? {} : agentEnv(ctx.s.roles?.[role]?.env);
    const extraEnv = { PIPELINE_STORY_SOURCES: [process.env.PIPELINE_STORY_SOURCES, ctx.key].filter(Boolean).join(path.delimiter), ...roleEnv, ...env };
    const memberOpts = member ? { effort: member.effort ?? null, cmd: member.cli === 'custom' ? member.cmd : null } : {};
    const res = await ctx.deps.runAgent(ctx.config, { name, task, mode, model, cli, noSubagents: true, cwd, timeoutSec: Math.max(1, Math.min(timeoutSec, left)), signal: signal ? AbortSignal.any([ctx.abort.signal, signal]) : ctx.abort.signal, extraEnv, usage: { stage: USAGE_STAGE[role] ?? 'implement', story: ctx.key, step: member ? `${step}:${member.name}` : step, round }, ...memberOpts });
    if (ctx.abort.signal.aborted) throw new AbortedError('aborted');
    if (res.outage && !member) throw limit(ctx, 'agent-unavailable', `the agent provider is unavailable: ${res.outage}`);
    if (res.timedOut && Date.now() >= ctx.deadline) throw limit(ctx, 'limit-wall-clock', `the story ran past its ${ceiling(ctx.config, ctx.s.storyWallClockSec)}s ceiling while ${name} was running`);
    ctx.metrics.usage = addUsage(ctx.metrics.usage, res.usage ?? null);
    const calls = ctx.deps.lsp.calls(cwd, name, t0, Date.now());
    ctx.metrics.lspCalls += calls.length;
    ctx.progress();
    return { ...res, cli: cliName, model, lspCalls: calls.length, referencesCalls: calls.filter((c) => ctx.deps.lsp.isReferences(c.tool)).length };
  } finally {
    release();
  }
}

// The unit tests to run for a set of changed files, from the project model: one entry per service with
// changed files that declares `unitTests`, plus every service that lists one of those in `dependsOn`
// (a shared library's change runs its dependants' tests too). `unitTests` is a path (run with
// `implement.unitTests.cmd`, where {project} is that path and {service} the service name) or a whole
// command (anything with a space in it). Returns [{ service, target, cmd }], sorted, without duplicates.
export function unitTestRuns(config, files, { cwd = config.root, log = () => {} } = {}) {
  const project = config.project ?? {};
  const template = config.implement?.unitTests?.cmd ?? null;
  const touched = new Set((files ?? []).flatMap((f) => servicesOfFile(f, project).map((s) => s.name)));
  const all = servicesOf(project);
  const wanted = all.filter((s) => touched.has(s.name) || (s.dependsOn ?? []).some((d) => touched.has(d)));
  const runs = new Map();
  for (const svc of wanted) {
    for (const target of [svc.unitTests].flat().filter(Boolean)) {
      const isCmd = /\s/.test(target);
      if (!isCmd && !template) {
        log(`unit tests of ${svc.name} skipped: ${target} is a path and implement.unitTests.cmd is not configured`);
        continue;
      }
      if (!isCmd && !fs.existsSync(path.join(cwd, target))) {
        log(`unit tests of ${svc.name} skipped: ${target} does not exist in ${path.basename(cwd)}`);
        continue;
      }
      const cmd = isCmd ? target : template.replaceAll('{project}', target).replaceAll('{service}', svc.name);
      if (!runs.has(target)) runs.set(target, { service: svc.name, target, cmd });
    }
  }
  return [...runs.values()].sort((a, b) => a.target.localeCompare(b.target));
}

// Build and unit tests, as the harness runs them for verifiers: `implement.checks` always, plus the unit
// tests of every service with changed files (unitTestRuns). With nothing configured the verifier is told
// so; nothing runs and nothing fails.
export async function runChecks(ctx, cwd, files) {
  const parts = [];
  let ok = true;
  const exec = async (name, cmd) => {
    const r = await runAsync('sh', ['-c', cmd], { cwd, timeoutSec: ctx.s.timeouts.checkSec, signal: ctx.abort.signal });
    ok &&= r.status === 0;
    parts.push(`$ ${name}: ${r.status === 0 ? 'passed' : `FAILED (exit ${r.status}${r.timedOut ? ', timed out' : ''})`}\n${tail(`${r.stdout}\n${r.stderr}`.trim(), r.status === 0 ? 400 : 4000)}`);
  };
  const checks = (ctx.s.checks ?? []).filter((c) => c?.cmd);
  if (!checks.length) noteOnce(ctx, 'checks', 'no build checks configured (implement.checks); verifiers get the diff and diagnostics only');
  for (const c of checks) await exec(c.name ?? c.cmd, c.cmd);
  for (const run of unitTestRuns(ctx.config, files, { cwd, log: (m) => noteOnce(ctx, m, m) })) await exec(`unit tests ${run.target}`, run.cmd);
  return { ok, output: parts.join('\n\n') || '(no checks configured)' };
}

// Logs a note once per story run (a missing optional command is worth one line, not one per round).
function noteOnce(ctx, id, message) {
  ctx.notes ??= new Set();
  if (ctx.notes.has(id)) return;
  ctx.notes.add(id);
  ctx.log(message);
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

const limitsOf = (s, config = null) => ({ maxSubtasks: s.maxSubtasks, maxLargeSubtasks: s.maxLargeSubtasks, selfModeMaxFiles: s.selfModeMaxFiles, ...(config ? { allowedModels: modelsFor(config), ui: uiRules(config), scenarios: appScenarios(config) } : {}) });

// The app-stack scenarios a UI verifier can load: the scenario folders of the repository (the base layer, whose
// name starts with "_", is loaded under every scenario). A plan may name only these (dogfood step 5: a plan put a
// description of the data it wanted in `scenario`, the load failed, and the verifier never ran).
function appScenarios(config) {
  const dir = path.join(config.root, config.teststack?.scenariosDir ?? '.factory/stack/scenarios');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// The model aliases a pair implementer may run on this run's CLI (allowed and with an id for it).
export const modelsFor = (config) => (config.agent.allowedModels ?? []).filter((a) => config.agent.cmd || config.agent.modelIds?.[roleCli(config, 'pairImplementer')]?.[a]);

export async function planStory(ctx) {
  // A resumed run keeps the plan the interrupted run had accepted (its subtasks' work is on the branch), so its
  // pairs and verifiers run as planned; without one it plans as usual.
  if (ctx.resume) {
    const saved = readJson(path.join(ctx.worktree, ctx.config.stateDir, 'implement', `${ctx.key}.plan.json`), null);
    if (saved?.decisionId && Array.isArray(saved.subtasks) && saved.subtasks.length) {
      const { decisionId, ...plan } = saved;
      ctx.decisionId = decisionId;
      ctx.plan = plan;
      ctx.log(`${ctx.key}: resuming with plan ${decisionId.slice(0, 8)} of the interrupted run (${plan.mode})`);
      return { plan };
    }
  }
  // A ticket with mockups is a UI story even without an [FE] title.
  const uiStory = isUiStory(ctx.storyText, uiRules(ctx.config)) || hasMockups(mockupsOf(ctx));
  const limits = { ...limitsOf(ctx.s, ctx.config), hasMockups: hasMockups(mockupsOf(ctx)) };
  let errors = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callAgent(ctx, {
      role: 'orchestrator',
      name: 'implementer',
      mode: 'read',
      step: 'plan',
      round: attempt,
      cwd: ctx.worktree,
      timeoutSec: ctx.s.timeouts.plannerSec,
      task: planTask({ key: ctx.key, storyFile: ctx.storyFile, worktree: ctx.worktree, uiStory, limits, project: ctx.config.project, errors, epicNote: ctx.epicNote, mockups: uiStory ? mockupText(ctx) : null, decisions: ctx.decisions }),
    });
    const raw = parsePlanOutput(res.output);
    const agent = { cli: res.cli, model: res.model, version: res.version };
    if (raw?.status === 'blocked') {
      logDecision(ctx.config, planDecisionLog(decisionRecord({ ts: nowIso(), key: ctx.key, attempt, accepted: false, errors: [`blocked: ${raw.reason ?? ''}`], agent, raw, storyText: ctx.storyText, uiStory }), { blocked: true }));
      return { fail: 'blocked', reason: raw.reason ?? 'the orchestrator reported the story blocked' };
    }
    const v = raw ? validatePlan(raw, { storyText: ctx.storyText, limits }) : { ok: false, errors: ['no plan found: end your reply with `AGENT_RESULT: <plan JSON on one line>`'], fatal: [] };
    const decisionId = v.ok ? randomUUID() : null;
    logDecision(ctx.config, planDecisionLog(decisionRecord({ ts: nowIso(), key: ctx.key, decisionId, attempt, accepted: v.ok, errors: v.errors, agent, raw, plan: v.plan, storyText: ctx.storyText, uiStory })));
    if (v.ok) {
      // Every model the plan needs must pass the model policy before any pair starts.
      try {
        for (const st of v.plan.subtasks) resolveModelForRole(ctx.config, st.self ? 'orchestrator' : 'pairImplementer', st.modelClass, st.model ?? null);
        for (const role of ['verifier', ...(v.plan.subtasks.some((st) => st.verify === 'ui') ? ['uiVerifier'] : [])]) resolveModelForRole(ctx.config, role);
      } catch (error) {
        return { fail: 'model-policy', reason: error.message };
      }
      ctx.decisionId = decisionId;
      ctx.plan = v.plan;
      writeJson(path.join(ctx.worktree, ctx.config.stateDir, 'implement', `${ctx.key}.plan.json`), { decisionId, ...v.plan });
      return { plan: v.plan };
    }
    if (v.fatal?.length) return { fail: 'plan-rejected', reason: v.fatal[0], findings: v.errors };
    errors = v.errors;
    ctx.log(`plan rejected (${errors.length} problem(s)); asking the orchestrator again`);
  }
  return { fail: 'plan-rejected', reason: `the plan was rejected twice: ${errors[0]}`, findings: errors };
}

// ---------------------------------------------------------------------------------------------
// Verifier pairs
// ---------------------------------------------------------------------------------------------

const newRec = (st) => ({ st, rounds: [], followUps: [], implementer: null, verifier: null, agentRuns: 0, leaseWaitSec: 0, lspCalls: 0, sigNoRefs: false, outOfOwns: new Set(), neededOutside: [], escalation: 'none', mergeConflictFiles: [], usage: null, started: Date.now() });

async function agentFor(ctx, rec, slot, opts) {
  const res = await callAgent(ctx, { step: rec.st.id, round: rec.rounds.length + 1, ...opts });
  rec.agentRuns++;
  rec.lspCalls += res.lspCalls;
  rec.usage = addUsage(rec.usage, res.usage ?? null);
  rec[slot] = { cli: res.cli, model: res.model, version: res.version };
  return res;
}


// The round limit of a subtask's pair: its verifier council's when one sits for it, else implement.maxPairRounds.
export const pairStage = (st) => (st.verify === 'ui' ? 'pairUiVerify' : 'pairVerify');
export const pairRounds = (ctx, st) => councilRounds(ctx.config, pairStage(st), ctx.s.maxPairRounds);

async function verifyCode(ctx, st, { worktree, base, round, checks, diagText, rec, disputes, pending }) {
  const diff = diffSince(worktree, base);
  const council = councilFor(ctx.config, 'pairVerify');
  if (council) {
    const taskFor = (m) => codeVerifierTask({ key: ctx.key, st, round, maxRounds: council.rounds, diff, checks: checks.output, diagnostics: diagText, disputes: disputesFor(m, pending?.open ?? [], (open) => formatDisputes(open, pending?.overruled ?? [])) || null, decisions: ctx.decisions, signatures: signatureChanges(diff) });
    const v = await councilVerify(ctx, st, council, { worktree, base, round, rec, taskFor, role: 'verifier', name: 'pair-verifier', mode: 'read', timeoutSec: ctx.s.timeouts.codeVerifierSec });
    discardChanges(worktree, { keep: [ctx.config.metricsDir] });
    return v;
  }
  const task = codeVerifierTask({ key: ctx.key, st, round, maxRounds: ctx.s.maxPairRounds, diff, checks: checks.output, diagnostics: diagText, disputes, decisions: ctx.decisions, signatures: signatureChanges(diff) });
  for (let attempt = 0; attempt <= ctx.config.agent.resultParseRetries; attempt++) {
    const res = await agentFor(ctx, rec, 'verifier', { role: 'verifier', name: 'pair-verifier', mode: 'read', modelClass: ctx.s.roles.verifier.modelClass, cwd: worktree, timeoutSec: ctx.s.timeouts.codeVerifierSec, task });
    discardChanges(worktree, { keep: [ctx.config.metricsDir] });
    const v = parseVerdict(res.output);
    if (v) return v;
  }
  return null;
}

// The stack slot is leased on the first UI round and kept for the rest of the pair (released by
// releaseUi when runPair ends), so later rounds only rebuild and recreate the services their diff
// touched instead of paying for a down/up and a full image build every round.
async function leaseUi(ctx, st, rec) {
  if (rec.ui) return rec.ui;
  const t0 = Date.now();
  const lease = await ctx.deps.stack.leaseUntil(`${ctx.key}--${st.id}`, { deadline: ctx.deadline, log: ctx.log });
  rec.leaseWaitSec += Math.round((Date.now() - t0) / 1000);
  ctx.metrics.leaseWaitSec += Math.round((Date.now() - t0) / 1000);
  try {
    record(ctx, 'run-conditions.jsonl', { ts: nowIso(), story: ctx.key, kind: 'stack-slot', stage: `UI verifier (${st.id})`, slot: lease?.slot ?? null, waitedSec: Math.round((Date.now() - t0) / 1000), outcome: lease ? 'leased' : 'none' });
  } catch {
    /* best effort */
  }
  if (!lease) throw limit(ctx, 'limit-wall-clock', `no app stack slot for subtask ${st.id} before the story deadline`);
  // Keep the lease alive through long builds and verifier runs.
  const renew = setInterval(() => ctx.deps.stack.renew?.(lease.slot).catch(() => {}), (ctx.s.ui.renewEverySec ?? 1800) * 1000);
  renew.unref?.();
  rec.ui = { lease, renew, up: false };
  return rec.ui;
}

async function releaseUi(ctx, rec, worktree) {
  if (!rec.ui) return;
  const { lease, renew } = rec.ui;
  rec.ui = null;
  clearInterval(renew);
  // Release does not stop the stack: bring it down first so the slot frees its memory.
  await ctx.deps.stack.teststack(worktree, lease.slot, ['down']).catch(() => {});
  await ctx.deps.stack.release(lease.slot);
}

async function verifyUi(ctx, st, { worktree, base, round, checks, diagText, rec, disputes, pending }) {
  const shots = path.join(ctx.worktree, ctx.s.ui.screenshotsDir, ctx.key, st.id, `round-${round}`);
  fs.mkdirSync(shots, { recursive: true });
  const ui = await leaseUi(ctx, st, rec);
  const { lease } = ui;
  {
    // rebuild-changed first: it builds only the affected images (or everything when the slot's images
    // came from another worktree) and stamps them, so the following `up` starts without rebuilding.
    // `up` would otherwise do a full build every round. Once the stack is up,
    // rebuild-changed recreates just the changed containers.
    const steps = [['rebuild-changed', '--base', base], ...(ui.up ? [] : [['up']]), ...(st.scenario ? [['load', st.scenario]] : [])];
    for (const step of steps) {
      const s0 = Date.now();
      const r = await ctx.deps.stack.teststack(worktree, lease.slot, step);
      // Builds wait on a machine-wide build lock; that time counts as stack wait.
      if (step[0] !== 'load') {
        rec.leaseWaitSec += Math.round((Date.now() - s0) / 1000);
        ctx.metrics.leaseWaitSec += Math.round((Date.now() - s0) / 1000);
      }
      if (r.status !== 0) {
        // The harness's own finding: no verifier ran, so nothing was verified. It cannot be disputed away.
        return { verdict: 'CHANGES_REQUESTED', harness: true, summary: 'the app stack did not come up', screenshots: [], findings: [{ severity: 'blocking', category: 'stack', harness: true, file: null, issue: `the app stack command (--slot ${lease.slot} ${step.join(' ')}) failed (exit ${r.status}); no verifier ran this round`, detail: tail(`${r.stdout}\n${r.stderr}`.trim(), 3000) }] };
      }
      if (step[0] === 'up') ui.up = true;
    }
    // The mockups, rendered to PNGs once per set of mockup files (cached by their sha) and copied into
    // every round's mockup/ folder, so the verifier compares the app with the design each round.
    let renders = null;
    if (hasMockups(mockupsOf(ctx))) {
      const r = await ctx.deps.renderMockups({ files: mockupFilesOf(mockupsOf(ctx)), outDir: path.join(shots, 'mockup'), cacheDir: path.join(ctx.worktree, ctx.s.ui.screenshotsDir, ctx.key, '.mockup-cache') });
      if (!r.ok) ctx.log(`could not render the mockups for ${st.id} (${r.error}); the verifier reads the sources`);
      renders = { ...r, text: formatRenders(r.entries) };
    }
    const mockupRenders = (renders?.entries ?? []).filter((e) => e.kind === 'screen' && e.png).map((e) => e.png);
    const council = councilFor(ctx.config, 'pairUiVerify');
    if (council) {
      // Every member drives the same leased slot and saves its screenshots in a folder of its own.
      const taskFor = (m) => {
        fs.mkdirSync(path.join(shots, m.name), { recursive: true });
        return uiVerifierTask({ key: ctx.key, st, round, maxRounds: council.rounds, diff: diffSince(worktree, base), checks: checks.output, diagnostics: diagText, webappUrl: lease.webappUrl, screenshotsDir: path.join(shots, m.name), worktree, slot: lease.slot, mockups: mockupText(ctx), renders, implementerScreens: rec.mockupScreens ?? null, disputes: disputesFor(m, pending?.open ?? [], (open) => formatDisputes(open, pending?.overruled ?? [])) || null, decisions: ctx.decisions, browser: m.cli !== 'codex' });
      };
      const v = await councilVerify(ctx, st, council, { worktree, base, round, rec, taskFor, role: 'uiVerifier', name: 'pair-ui-verifier', mode: 'verify', ui: true, timeoutSec: ctx.s.timeouts.uiVerifierSec, env: { TESTSTACK_SLOT: String(lease.slot), ...(lease.baseUrl ? { TESTSTACK_URL: lease.baseUrl } : {}) } });
      const removed = discardChanges(worktree, { keep: [ctx.config.metricsDir] });
      if (removed.length) ctx.log(`discarded ${removed.length} file(s) the UI council left in ${path.basename(worktree)}`);
      const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && e.name !== 'mockup' ? files(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : [])) : []);
      return v && { ...v, screenshots: files(shots), mockupRenders };
    }
    const task = uiVerifierTask({ key: ctx.key, st, round, maxRounds: ctx.s.maxPairRounds, diff: diffSince(worktree, base), checks: checks.output, diagnostics: diagText, webappUrl: lease.webappUrl, screenshotsDir: shots, worktree, slot: lease.slot, mockups: mockupText(ctx), renders, implementerScreens: rec.mockupScreens ?? null, disputes, decisions: ctx.decisions, browser: agentSettings(ctx.config, 'uiVerifier', ctx.s.roles.uiVerifier.modelClass).cliName !== 'codex' });
    for (let attempt = 0; attempt <= ctx.config.agent.resultParseRetries; attempt++) {
      const res = await agentFor(ctx, rec, 'verifier', { role: 'uiVerifier', name: 'pair-ui-verifier', mode: 'verify', modelClass: ctx.s.roles.uiVerifier.modelClass, cwd: worktree, timeoutSec: ctx.s.timeouts.uiVerifierSec, task, env: { TESTSTACK_SLOT: String(lease.slot), ...(lease.baseUrl ? { TESTSTACK_URL: lease.baseUrl } : {}) } });
      const removed = discardChanges(worktree, { keep: [ctx.config.metricsDir] });
      if (removed.length) ctx.log(`discarded ${removed.length} file(s) the UI verifier left in ${path.basename(worktree)}`);
      const v = parseVerdict(res.output, { ui: true });
      if (v) return { ...v, screenshots: fs.readdirSync(shots, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(shots, e.name)), mockupRenders };
    }
    return null;
  }
}

// Why a council pair ended without approval when a blocking member gave no verdict in its last round (council C9 proof
// run: opus approved 10/10 three times while the Codex member could not check the app, and the story ended "not
// approved by its verifier", which named neither).
export function noVerdictNote(rec) {
  const members = rec?.council?.members ?? [];
  const none = members.filter((m) => m.blocking !== false && m.status !== 'ok');
  if (!none.length) return '';
  const ok = members.filter((m) => m.status === 'ok').map((m) => `${m.name} ${m.verdict ?? '?'} ${m.score ?? '-'}/10`);
  return `: council member${none.length > 1 ? 's' : ''} ${none.map((m) => `${m.name} (${m.cli}) gave no verdict (${m.status}${m.reason ? `: ${m.reason}` : ''})`).join('; ')}${ok.length ? `, while ${ok.join(', ')}` : ''} in the last round`;
}

// One council round of a pair: the members run in parallel (each an agent run under the story's budget and the agent
// semaphore), the harness merges them (council.mjs) and the result is a verdict in parseVerdict's shape, or null when
// no verdict came (the round is spent, as when a single verifier gives none). An unavailable member under
// council.onUnavailable "fail" stops the story like a provider outage.
async function councilVerify(ctx, st, council, { worktree, base = null, round, rec, taskFor, role, name, mode, ui = false, timeoutSec, env = {} }) {
  rec.late ??= lateBox();
  const memory = councilMemory({ file: memoryFile(ctx.config.root, ctx.config.stateDir, { stage: pairStage(st), story: ctx.key, step: st.id }), cwd: worktree, round, fixes: fixesFile(worktree, ctx.config.stateDir, { stage: pairStage(st), story: ctx.key, step: st.id }) });
  const out = await runCouncil({
    council,
    retries: ctx.config.agent.resultParseRetries,
    taskFor: (m) => memberTask(taskFor(m), { council, member: m, round, earlier: memory.text }),
    run: (m, task) => {
      const abort = new AbortController();
      return agentFor(ctx, rec, 'verifier', { role, name, mode, member: m, signal: abort.signal, cwd: worktree, timeoutSec: m.timeoutSec ?? timeoutSec, task, env: { ...env, ...memberRunEnv(m) } });
    },
    parse: (output) => {
      const v = parseVerdict(output, { ui });
      if (!v) return null;
      const raw = extractResult(output) ?? {};
      return { score: memberScore(raw), verdict: v.verdict, summary: v.summary, findings: v.findings, disputes: v.disputes, followUps: raw.followUps };
    },
    onLate: rec.late.push,
    // Every member is checked for an unchanged tree, the UI pair's too (council C10, Opus 2: its Codex member runs with
    // workspace-write and network to drive the browser, and nothing checked the tree). A UI member may write only into the
    // declared artifact folders (implement.ui.artifactDirs; git-ignored files never count either).
    readOnly: { cwd: worktree, exclude: [ctx.config.metricsDir, ctx.config.stateDir, ...(ctx.config.implExclude ?? []), ...(ui ? uiArtifactDirs(ctx.config) : [])] },
    log: ctx.log,
  });
  const keys = [ctx.key];
  const cases = planCases(ctx.worktree, ctx.config.plansDir, ctx.key);
  const mergeOpts = { protect: (f) => testProtection(f, { keys, cases }), feedback: rec.late.take(), violation: out.violation, changed: changedSince(worktree, base, git), earlier: memory, root: worktree };
  const merged = await adjudicate({
    config: ctx.config,
    council,
    merged: mergeCouncil(council, out.results, mergeOpts),
    remerge: (adjudications) => mergeCouncil(council, out.results, { ...mergeOpts, adjudications }),
    // Read-only, whatever the stage's own mode (a UI member drives a browser; adjudication only reads).
    run: (m, task) => agentFor(ctx, rec, 'verifier', { role, name: ui ? 'pair-verifier' : name, mode: 'read', member: m, cwd: worktree, timeoutSec: m.timeoutSec ?? timeoutSec, task, step: `${st.id}:adjudication`, env: { ...env, ...memberRunEnv(m) } }),
    stage: pairStage(st),
    story: ctx.key,
    step: st.id,
    round,
    retries: ctx.config.agent.resultParseRetries,
    readOnly: { cwd: worktree, exclude: [ctx.config.metricsDir, ctx.config.stateDir, ...(ctx.config.implExclude ?? [])] },
    log: ctx.log,
  });
  // Named as the implementer will see them (disputes.mjs withIds), so its fix declaration matches what is remembered.
  if (!merged.error) memory.remember(nameFindings(merged.findings, `${st.id}-r${round}`));
  recordCouncilRound(ctx.config, { stage: pairStage(st), story: ctx.key, step: st.id, round, council, merged });
  rec.council = merged;
  if (merged.error) {
    ctx.log(`${st.id} round ${round}: ${merged.error}`);
    if (!out.violation && merged.unavailable.length && council.onUnavailable === 'fail') throw limit(ctx, 'agent-unavailable', merged.error);
    return null;
  }
  return councilPairVerdict(merged);
}

// A merged council result as a pair verdict: standing findings block; minor, outvoted, protected and superseded ones and
// non-blocking feedback are minor notes. An upheld rewrite tells the implementer to rewrite its regions, not patch them.
export function councilPairVerdict(merged) {
  const issue = (f) => {
    const base = f.action === 'rewrite' ? rewriteText(f) : f.action === 'delete-test' ? `DELETE TEST ${f.test || '(named in the evidence)'}${f.file ? ` in ${f.file}` : ''}: ${f.text} It adds no protection: delete it.` : f.text;
    const why = f.protected ? ` (not acted on: ${f.protected})` : f.notUpheld ? ` (not upheld: ${f.notUpheld})` : f.supersededBy ? ` (superseded by rewrite ${f.supersededBy})` : f.feedback ? ` (feedback from non-blocking member ${f.member})` : '';
    return `${base}${contestedText(f)}${why}${f.members?.length > 1 ? ` [raised by ${f.members.join(', ')}]` : ''}`;
  };
  const findings = [...merged.findings, ...merged.notes].map((f) => ({ ...f, severity: f.severity === 'minor' || merged.notes.includes(f) ? 'minor' : 'blocking', issue: issue(f), file: f.file ?? (f.harness ? '(council)' : null) }));
  const blocking = findings.filter((f) => f.severity === 'blocking');
  // Not passed and nothing to act on (a blocking member gave no result): no verdict this round.
  if (!merged.pass && !blocking.length) return null;
  return { verdict: merged.pass ? 'APPROVED' : 'CHANGES_REQUESTED', summary: merged.summary, findings, disputes: merged.disputes, contradictions: merged.contradictions, council: { score: merged.score, members: merged.members } };
}

// The implement/verify loop of one subtask. Returns { status: approved | exhausted | blocked, findings, reason }.
export async function runPair(ctx, st, opts) {
  try {
    return await pairLoop(ctx, st, opts);
  } finally {
    await releaseUi(ctx, opts.rec, opts.worktree);
  }
}

async function pairLoop(ctx, st, { worktree, branch, base, rec, others = [], implementer = 'pair-implementer', role = 'pairImplementer', startAtVerify = false }) {
  const max = pairRounds(ctx, st);
  const all = [];
  let findings = [];
  let screenshots = [];
  let mockupRenders = [];
  let diagText = null;
  // Disputes: id -> { disputes, reasserts }; `pending` are the implementer's disputes for the next verifier.
  const disputeState = new Map();
  let pending = { open: [], overruled: [] };
  let roundFollowUps = [];
  let skipImplementer = startAtVerify;
  const progress = (round, status) => {
    ctx.subtasks.set(st.id, { ...(ctx.subtasks.get(st.id) ?? {}), status, rounds: round, branch, worktree });
    ctx.progress();
  };

  let sigNoRefsRound = [];
  const council = councilFor(ctx.config, pairStage(st));
  let protectedRound = [];
  for (let round = 1; round <= max; round++) {
    ctx.metrics.pairRounds++;
    progress(round, 'implementing');
    if (!skipImplementer) {
      const before = headSha(worktree);
      const res = await agentFor(ctx, rec, 'implementer', {
        role,
        name: implementer,
        mode: 'implement',
        modelClass: st.modelClass,
        // The planner may name a model alias (e.g. sol) for a pair implementer; the orchestrator keeps its own.
        model: role === 'pairImplementer' ? st.model ?? null : null,
        cwd: worktree,
        timeoutSec: ctx.s.timeouts.pairImplementerSec,
        // route: pairHandoff (findings = the last round's handoff.mine)
        task: pairImplementerTask({ key: ctx.key, storyFile: path.join(worktree, path.relative(ctx.worktree, ctx.storyFile)), st, worktree, branch, base, round, maxRounds: max, findings, screenshots, diagnostics: diagText, self: Boolean(st.self), mockups: st.verify === 'ui' ? mockupText(ctx) : null, mockupRenders, decisions: ctx.decisions }) + (council ? `\n\n${councilActionsText()}` : '') + (council && findings?.length ? `\n\n${fixDeclarationText(fixesFile(worktree, ctx.config.stateDir, { stage: pairStage(st), story: ctx.key, step: st.id }), findings)}` : ''),
      });
      commitAll(worktree, `${ctx.key}: ${st.id} (round ${round})`);
      // With a council (which can ask for tests to be deleted), a protected test the round deleted is put back.
      protectedRound = council ? guardProtectedTests({ cwd: worktree, from: before, keys: [ctx.key], cases: planCases(ctx.worktree, ctx.config.plansDir, ctx.key) }) : [];
      if (protectedRound.length) {
        ctx.log(`${st.id} round ${round}: restored ${protectedRound.length} protected test file(s) the implementer changed: ${protectedRound.map((v) => v.file).join(', ')}`);
        commitAll(worktree, `${ctx.key}: ${st.id} restore protected tests (round ${round})`);
      }
      sigNoRefsRound = [];
      if (ctx.deps.lsp.leasedRunning(worktree) && !res.referencesCalls) {
        sigNoRefsRound = signatureChanges(git(worktree, ['diff', before, 'HEAD']).stdout);
        if (sigNoRefsRound.length) {
          rec.sigNoRefs = true;
          ctx.metrics.signatureChangesWithoutReferences = true;
        }
      }
      const reported = extractResult(res.output);
      if (Array.isArray(reported?.mockupScreens)) rec.mockupScreens = reported.mockupScreens.filter((x) => typeof x === 'string').slice(0, 20);
      // Nits and out-of-scope requests the implementer disputed go to the next verifier to rule on;
      // real problems outside the ticket are follow-ups for the story's run record.
      const report = parseImplementerReport(reported, findings);
      // Static analysis findings are facts a tool proves: they are not disputed to a model (analysis/report.mjs).
      report.disputes = report.disputes.filter((d) => !isToolFinding(findings.find((f) => f.id === d.id) ?? { id: d.id }));
      // With a council, each dispute goes to the members that raised the finding (council.mjs disputesFor).
      for (const d of report.disputes) d.members = findings.find((f) => f.id === d.id)?.members;
      pending = openDisputes(report.disputes, disputeState);
      roundFollowUps = report.followUps.map((u) => ({ ...u, subtask: st.id, round }));
      rec.followUps.push(...roundFollowUps);
      ctx.metrics.followUps.push(...roundFollowUps);
      if (reported?.status === 'blocked') {
        const reason = reported.reason ?? 'blocked';
        rec.neededOutside = [...new Set([...String(reason).matchAll(pathLikeRegex(ctx.config.project, ctx.s.pathHints))].map((m) => m[1].replace(/[.]+$/, '')).filter((f) => !st.self && scopeViolations([f], st.owns).length))];
        rec.rounds.push(roundRecord({ round, verdict: 'BLOCKED' }));
        all.push({ severity: 'blocking', category: 'blocked', subtask: st.id, round, issue: `the implementer reported the subtask blocked: ${reason}` });
        return { status: 'blocked', reason, findings: all };
      }
    } else {
      commitAll(worktree, `${ctx.key}: ${st.id} (round ${round})`);
    }
    skipImplementer = false;
    progress(round, 'verifying');

    let files = filesChanged(worktree, base);
    const outside = st.self ? [] : scopeViolations(files, st.owns);
    let diag = { available: false, errors: [], warnings: [] };
    let verdict;
    let rulings = [];
    let continuedBy = null;
    if (protectedRound.length) {
      verdict = { verdict: 'CHANGES_REQUESTED', findings: protectedRound.map(protectedTestFinding) };
      protectedRound = [];
    } else if (!files.length) {
      verdict = { verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'blocking', category: 'scope', file: null, issue: 'no changes were committed for this subtask', fix: 'implement the subtask and commit it' }] };
    } else if (outside.length) {
      for (const f of outside) rec.outOfOwns.add(f);
      verdict = {
        verdict: 'CHANGES_REQUESTED',
        findings: outside.map((f) => ({ severity: 'blocking', category: 'scope', file: f, line: null, issue: `${f} is outside this subtask's owns (${st.owns.join(', ')})`, fix: 'restore it to its content on the story branch and commit; if the subtask really needs it, report blocked and name the file' })),
      };
    } else {
      // The implementer changed signatures without running find-references on them (council C1: a feature recorded the
      // flag and nothing else). It answers before any verifier or council member sits, in a bounce that does not spend
      // a pair round: run the check and update its callers, or say why none exist. Raised once per subtask. It used to
      // be added after the verdict, so a passing council round was followed by a whole implementer and council cycle
      // only to hear "a new member, no callers" (dogfood C17, council C11 Sol 2).
      if (sigNoRefsRound.length && !rec.sigFindingRaised) {
        rec.sigFindingRaised = true;
        const finding = sigNoRefsFinding(sigNoRefsRound);
        ctx.log(`${st.id} round ${round}: ${finding.issue}; the implementer answers before the verifiers sit`);
        const answer = await agentFor(ctx, rec, 'implementer', {
          role,
          name: implementer,
          mode: 'implement',
          modelClass: st.modelClass,
          model: role === 'pairImplementer' ? st.model ?? null : null,
          cwd: worktree,
          timeoutSec: ctx.s.timeouts.pairImplementerSec,
          task: `Story ${ctx.key}, subtask ${st.id}. You own: ${st.owns.join(', ')}.\n\n${finding.issue}\n\n${finding.fix} Commit any change.\n\nEnd with one line: AGENT_RESULT: {"status":"done","reason":"<what you checked and changed, or why no caller exists>"}`,
        });
        commitAll(worktree, `${ctx.key}: ${st.id} callers of changed signatures (round ${round})`);
        rec.codeIntelligence = { round, signatures: sigNoRefsRound.slice(0, 10), answer: String(extractResult(answer?.output)?.reason ?? '').slice(0, 400) };
        files = filesChanged(worktree, base);
      }
      // Static analysis (opt-in): auto-fix, the tools on what the round touched, and the harness fix loop with its own
      // small budget, before any verifier or council member sits. What stays open comes back as harness findings.
      const analysis = await pairAnalysis(ctx, st, { worktree, base, round, rec, implementer, role });
      const toolF = analysis ? toolFindings(analysis) : [];
      const blockingTool = toolF.filter((f) => f.severity === 'blocking');
      const minorTool = toolF.filter((f) => f.severity !== 'blocking');
      diag = await ctx.deps.lsp.diagnostics(worktree, files);
      diagText = formatDiagnostics(diag);
      const checks = await runChecks(ctx, worktree, files);
      if (analysis) checks.output = `${checks.output}\n\n${evidenceText(analysis)}`;
      if (!checks.ok) {
        verdict = { verdict: 'CHANGES_REQUESTED', findings: [...diagnosticFindings(diag), ...blockingTool, { severity: 'blocking', category: 'build', file: null, issue: 'a harness check (the build, or the generated test stack drift check) or the existing unit tests failed', detail: checks.output }] };
      } else {
        const disputes = formatDisputes(pending.open, pending.overruled) || null;
        const raw = st.verify === 'ui' ? await verifyUi(ctx, st, { worktree, base, round, checks, diagText, rec, disputes, pending }) : await verifyCode(ctx, st, { worktree, base, round, checks, diagText, rec, disputes, pending });
        let v = raw;
        // Disputes are ruled on by a verifier. When the harness itself failed (the stack did not come up), no
        // verifier ran: its finding stands, and the open disputes wait for the next verifier.
        if (raw && !raw.harness) {
          const ruled = ruleDisputes({ ...raw, findings: withIds(raw.findings, { subtask: st.id, round }) }, pending.open, disputeState, pending.overruled);
          v = ruled.verdict;
          rulings = ruled.rulings;
          pending = { open: [], overruled: [] };
        }
        if (!v) {
          // No parsable verdict: the round is spent, and the next one verifies again without asking the implementer for changes.
          rec.rounds.push(roundRecord({ round, verdict: 'VERIFIER_ERROR', diagnostics: diag }));
          skipImplementer = true;
          continue;
        }
        // Council members who contradict each other on the same subject two rounds running: no evidence settled it, so
        // it is a question for the ticket's owner (the story fails with it; the escalation questions ask it).
        if (v.contradictions?.length) {
          rec.contested ??= new Map();
          const now = new Set(v.contradictions.map((c) => String(c.subject)));
          const twice = v.contradictions.filter((c) => c.escalate || rec.contested.get(String(c.subject)) === round - 1);
          for (const subject of now) rec.contested.set(subject, round);
          if (twice.length) {
            const reason = `council members contradict each other and the evidence has not settled it: ${twice.map((c) => `${c.subject} (${c.positions.map((p) => `${p.member}: ${p.action}`).join(' vs ')})`).join('; ')}; the ticket's owner decides`;
            rec.rounds.push(roundRecord({ round, verdict: 'BLOCKED' }));
            all.push({ severity: 'blocking', category: 'council', subtask: st.id, round, issue: reason });
            return { status: 'blocked', reason, findings: all };
          }
        }
        const blockingDiag = diagnosticFindings(diag);
        // Harness findings (compiler errors, blocking tool findings) are added after the council's merge: they are
        // outside its votes (blockOn) and its disputes. Non-blocking tool findings are notes.
        const blockingHarness = [...blockingDiag, ...blockingTool];
        verdict = blockingHarness.length ? { ...v, verdict: 'CHANGES_REQUESTED', findings: [...blockingHarness, ...v.findings, ...minorTool] } : { ...v, findings: [...v.findings, ...minorTool] };
        // A verifier or council that passed, sent back by a harness fact it does not vote on: the record names it, so a
        // pass followed by another round always says why (council C11, Sol 2).
        if (blockingHarness.length && v.verdict === 'APPROVED') {
          continuedBy = [...new Set([...(blockingDiag.length ? ['compiler-diagnostics'] : []), ...(blockingTool.length ? ['static-analysis'] : [])])];
          ctx.log(`${st.id} round ${round}: the ${rec.council ? 'council' : 'verifier'} passed; ${continuedBy.join(' and ')} finding(s) it does not vote on send the round back`);
        }
      }
    }
    verdict = { ...verdict, findings: withIds(verdict.findings, { subtask: st.id, round }) };
    const blocking = verdict.findings.filter((f) => f.severity !== 'minor');
    rec.rounds.push({ ...roundRecord({ round, verdict: verdict.verdict, findings: verdict.findings, diagnostics: diag, outOfOwns: outside, crossFindings: crossFindings(blocking, others), disputes: disputeCounts(rulings, roundFollowUps) }), ...(continuedBy ? { continuedBy } : {}), ...(rec.codeIntelligence?.round === round ? { codeIntelligence: rec.codeIntelligence } : {}) });
    // Why the pair verifier (or the harness's own checks) approved or sent the subtask back, for the retro.
    logDecision(ctx.config, verdictDecisionLog({ key: ctx.key, decisionId: ctx.decisionId, st, round, verdict, verifier: rec.verifier, ui: st.verify === 'ui', disputes: rulings, followUps: roundFollowUps }));
    roundFollowUps = [];
    if (verdict.verdict === 'APPROVED') {
      progress(round, 'approved');
      return { status: 'approved', findings: all };
    }
    // Findings this pair cannot act on do not come back to it (pairHandoff): another subtask's files go to the
    // integration step, test gaps to feature verification as required cases. Nothing left: the round is approved.
    // Every pair kind routes, the self-mode and later-change pairs (bug fix, review fix, PR-check return, integration)
    // too (dogfood C24: a test gap blocked the bug-fix pair, which writes production code, for two of its three rounds).
    // route: pairHandoff
    const handoff = pairHandoff(blocking, { ownerOf: (file) => others.find((o) => matchesAny(file, o.owns ?? []))?.id ?? (matchesAny(file, st.owns ?? []) ? st.id : null), self: st.id });
    if (handoff.otherSide.length || handoff.tests.length) {
      for (const f of handoff.otherSide) ctx.integrationNotes.push(`The ${st.id} verifier raised a finding about ${f.file} (owned by ${f.owner}), which that pair could not change: ${f.issue}${f.fix ? ` Fix: ${f.fix}` : ''}`);
      ctx.requiredCases.push(...handoff.tests.map((f) => ({ id: f.id ?? `${st.id}-r${round}`, source: `${st.id} verifier round ${round}`, title: String(f.issue ?? f.title ?? '').slice(0, 300), fix: f.fix ?? null })));
      rec.handedOff = [...(rec.handedOff ?? []), ...handoff.otherSide.map((f) => ({ id: f.id, round, to: 'integration', why: f.why })), ...handoff.tests.map((f) => ({ id: f.id, round, to: 'feature-verification', why: f.why }))];
      if (!handoff.mine.length) {
        ctx.log(`${st.id} round ${round}: every blocking finding is for another stage (${rec.handedOff.filter((h) => h.round === round).map((h) => `${h.id} to ${h.to}`).join(', ')}); the pair's part is approved`);
        progress(round, 'approved');
        return { status: 'approved', findings: all, handedOff: rec.handedOff };
      }
    }
    all.push(...handoff.mine.map((f) => ({ ...f, subtask: st.id, round })));
    findings = handoff.mine;
    screenshots = verdict.screenshots ?? [];
    mockupRenders = verdict.mockupRenders ?? [];
  }
  progress(max, 'exhausted');
  return { status: 'exhausted', findings: all };
}

// The pair slot's static analysis for this round (null when analysis is off or the slot has no tool). A fix bounce is
// one more run of the round's implementer with exactly the tool's findings; it counts against the story's agent runs
// but is not a pair or council round.
async function pairAnalysis(ctx, st, { worktree, base, round, rec, implementer, role }) {
  if (ctx.analysis === undefined) ctx.analysis = resolveAnalysis(ctx.config);
  if (!ctx.analysis?.stages.pair.length) return null;
  const report = await fixLoop(ctx.config, 'pair', {
    cwd: worktree,
    base,
    resolved: ctx.analysis,
    label: `${ctx.key}: ${st.id} `,
    signal: ctx.abort.signal,
    deadline: ctx.deadline,
    deps: {
      commit: (m) => commitAll(worktree, m),
      head: () => headSha(worktree),
      log: ctx.log,
      exec: ctx.deps.analysisExec,
      askImplementer: async (task) => {
        await agentFor(ctx, rec, 'implementer', {
          role,
          name: implementer,
          mode: 'implement',
          modelClass: st.modelClass,
          model: role === 'pairImplementer' ? st.model ?? null : null,
          cwd: worktree,
          timeoutSec: ctx.s.timeouts.pairImplementerSec,
          task: `Story ${ctx.key}, subtask ${st.id}. You own: ${st.owns.join(', ')}.\n\n${task}\n\nEnd with one line: AGENT_RESULT: {"status":"done","reason":"<what you fixed>"}`,
        });
      },
    },
  });
  if (!report) return null;
  recordAnalysis(ctx.config, { story: ctx.key, stage: 'pair', step: st.id, round, report });
  (ctx.analysisReports ??= []).push(report);
  rec.analysis = { bounces: (rec.analysis?.bounces ?? 0) + report.fixLoop.bounces, fixed: (rec.analysis?.fixed ?? 0) + report.fixLoop.fixed, open: report.findings.length };
  // In the run record: every bounce is one more agent run against maxAgentRunsPerStory, so its share is visible.
  ctx.metrics.analysisBounces += report.fixLoop.bounces;
  ctx.metrics.analysisFixed += report.fixLoop.fixed;
  // Pre-existing findings on touched code are follow-ups, never the ticket's (one per tool and rule per subtask).
  for (const u of preexistingFollowUps(report)) {
    if (rec.followUps.some((x) => x.title === u.title)) continue;
    const up = { ...u, subtask: st.id, round };
    rec.followUps.push(up);
    ctx.metrics.followUps.push(up);
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Subtasks: worktree, pair, escalation
// ---------------------------------------------------------------------------------------------

export function sigNoRefsFinding(signatures) {
  return {
    severity: 'blocking',
    category: 'code-intelligence',
    file: null,
    line: null,
    issue: `This round added or changed ${signatures.length} signature(s) without running lsp_find_references: ${signatures.slice(0, 5).join(' | ')}`,
    fix: 'Run lsp_find_references on each changed existing signature and update every caller you own (report the others). For a new member with no callers, dispute this finding and say so.',
  };
}

async function openWorktree(ctx, st) {
  const wt = createSubtaskWorktree(ctx.worktree, { prefix: ctx.s.branchPrefix, key: ctx.key, id: st.id });
  // The story is not on the branch (it lives in the ticket cache), so the subtask gets its own copy of
  // the story's cache folder at the same relative path.
  const ticket = path.dirname(ctx.storyFile);
  const rel = path.relative(ctx.worktree, ticket);
  if (fs.existsSync(ticket) && !rel.startsWith('..') && !fs.existsSync(path.join(wt.path, rel))) fs.cpSync(ticket, path.join(wt.path, rel), { recursive: true });
  if (ctx.s.prepareCmd) {
    const r = await runAsync('sh', ['-c', ctx.s.prepareCmd], { cwd: wt.path, timeoutSec: ctx.s.timeouts.checkSec, signal: ctx.abort.signal });
    if (r.status !== 0) ctx.log(`prepareCmd failed in ${path.basename(wt.path)} (exit ${r.status}); continuing`);
  }
  await ctx.deps.lsp.start(wt.path, { owns: st.owns, key: ctx.key });
  ctx.subtasks.set(st.id, { status: 'starting', branch: wt.branch, worktree: wt.path, rounds: 0 });
  ctx.progress();
  return wt;
}

async function dropWorktree(ctx, wt) {
  await ctx.deps.lsp.stop(wt.path);
  removeWorktree(ctx.worktree, wt.path, wt.branch);
}

function numstat(cwd, base) {
  const rows = git(cwd, ['diff', '--numstat', base, 'HEAD']).stdout.split('\n').filter(Boolean);
  return { files: rows.length, loc: rows.reduce((n, r) => n + r.split('\t').slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0) };
}

// One subtask from worktree to approval, with at most one escalation. Returns { status, st, wt, rec, findings, reason }.
export async function runSubtask(ctx, st, others) {
  // Back-pressure (auto sizing): a new pair waits while free memory is below the reserve.
  await ctx.deps.memoryGate(`${ctx.key}--${st.id}`);
  const rec = newRec(st);
  let wt = await openWorktree(ctx, st);
  let r = await runPair(ctx, st, { worktree: wt.path, branch: wt.branch, base: wt.base, rec, others });
  if (r.status !== 'approved') {
    ctx.metrics.escalations++;
    const takeoverAllowed = ctx.metrics.takeovers < ctx.s.maxTakeovers;
    ctx.log(`subtask ${st.id} ${r.status}; escalating to the orchestrator`);
    const res = await agentFor(ctx, rec, 'orchestrator', {
      role: 'orchestrator',
      name: 'implementer',
      mode: 'implement',
      cwd: wt.path,
      timeoutSec: ctx.s.timeouts.orchestratorSec,
      // route: pairHandoff (r.findings are the rounds' handoff.mine)
      task: escalationTask({ key: ctx.key, storyFile: path.join(wt.path, path.relative(ctx.worktree, ctx.storyFile)), st, worktree: wt.path, branch: wt.branch, outcome: r.status, findings: r.findings, takeoverAllowed, otherOwns: others.flatMap((o) => o.owns) }),
    });
    const d = extractResult(res.output) ?? {};
    const priorFindings = r.findings;
    logDecision(ctx.config, {
      stage: 'implement-plan',
      story: ctx.key,
      round: null,
      agent: 'implementer',
      agentVer: res.version,
      subject: 'pair-implementer',
      decision: ['rewrite', 'takeover'].includes(d.action) ? `escalation-${d.action}` : 'gave-up',
      reason: d.reason ?? null,
      decision_id: ctx.decisionId,
      subtask: st.id,
      pair_outcome: r.status,
      items: (priorFindings ?? []).slice(-20).map((f) => ({ severity: f.severity ?? null, category: f.category ?? null, file: f.file ?? null, reason: f.issue ?? f.detail ?? null })),
    });
    let next = null;
    if (['rewrite', 'takeover'].includes(d.action)) {
      const v = validateRewrite(st, d.subtask ?? {}, others, { storyText: ctx.storyText, limits: { ...limitsOf(ctx.s, ctx.config), hasMockups: hasMockups(mockupsOf(ctx)) } });
      if (!v.ok) r = { status: 'failed', reason: `the orchestrator's ${d.action} of ${st.id} is invalid: ${v.errors[0]}`, findings: priorFindings };
      else next = v.subtask;
    }
    if (next && d.action === 'rewrite') {
      rec.escalation = 'rewrite';
      await dropWorktree(ctx, wt);
      st = next;
      wt = await openWorktree(ctx, st);
      r = await runPair(ctx, st, { worktree: wt.path, branch: wt.branch, base: wt.base, rec, others });
    } else if (next && d.action === 'takeover' && takeoverAllowed) {
      rec.escalation = 'takeover';
      ctx.metrics.takeovers++;
      st = next;
      r = await runPair(ctx, st, { worktree: wt.path, branch: wt.branch, base: wt.base, rec, others, implementer: 'implementer', role: 'orchestrator', startAtVerify: true });
    } else if (r.status !== 'failed') {
      r = { status: 'failed', reason: d.action === 'takeover' ? 'the orchestrator asked for a second takeover (maxTakeovers)' : d.reason ?? 'the orchestrator gave the subtask up', findings: priorFindings };
    }
    if (r.status !== 'approved') r = { ...r, findings: [...priorFindings, ...(r.findings ?? []).filter((f) => !priorFindings.includes(f))] };
  }
  Object.assign(rec, { approved: r.status === 'approved', actual: numstat(wt.path, wt.base), st });
  return { ...r, st, wt, rec };
}

function writeSubtaskRun(ctx, rec) {
  const st = rec.st;
  record(
    ctx,
    SUBTASK_RUNS_FILE,
    subtaskRunRecord({
      ts: nowIso(),
      key: ctx.key,
      decisionId: ctx.decisionId,
      subtaskId: st.id,
      implementer: rec.implementer,
      verifier: rec.verifier,
      modelClass: st.modelClass,
      verify: st.verify,
      maxRounds: pairRounds(ctx, st),
      rounds: rec.rounds,
      approved: rec.approved,
      escalation: rec.escalation,
      filesNeededOutsideOwns: [...new Set([...rec.neededOutside, ...rec.outOfOwns])],
      mergeConflictFiles: rec.mergeConflictFiles,
      expected: { files: st.decision?.expectedFiles ?? null, loc: st.decision?.expectedLoc ?? null },
      actual: rec.actual,
      wallClockSec: Math.round((Date.now() - rec.started) / 1000),
      agentRuns: rec.agentRuns,
      leaseWaitSec: rec.leaseWaitSec,
      lspCalls: rec.lspCalls,
      signatureChangesWithoutReferences: rec.sigNoRefs,
      usage: rec.usage,
      followUps: rec.followUps,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

export async function mergeSubtask(ctx, st, wt, rec) {
  const r = git(ctx.worktree, ['merge', '--no-ff', '--no-edit', '-m', `${ctx.key}: Merge subtask ${st.id}`, wt.branch], { env: commitEnv });
  if (r.status !== 0) {
    const files = unmergedFiles(ctx.worktree);
    rec.mergeConflictFiles = files;
    if (!files.length) {
      git(ctx.worktree, ['merge', '--abort']);
      return { ok: false, reason: `merging ${wt.branch} failed: ${tail(r.stderr || r.stdout, 300)}` };
    }
    ctx.log(`merging ${st.id} conflicts in ${files.join(', ')}; asking the orchestrator to resolve them`);
    await callAgent(ctx, { role: 'orchestrator', name: 'implementer', mode: 'implement', step: `merge ${st.id}`, cwd: ctx.worktree, timeoutSec: ctx.s.timeouts.orchestratorSec, task: conflictTask({ key: ctx.key, worktree: ctx.worktree, branch: ctx.branch, subtaskBranch: wt.branch, st, files }) });
    const left = unmergedFiles(ctx.worktree);
    if (left.length || /<<<<<<< /.test(git(ctx.worktree, ['diff', 'HEAD', '--', ...files]).stdout)) {
      git(ctx.worktree, ['merge', '--abort']);
      return { ok: false, reason: `the merge conflicts of subtask ${st.id} in ${files.join(', ')} were not resolved` };
    }
    if (mergeInProgress(ctx.worktree)) {
      git(ctx.worktree, ['add', '-A', '--', '.', ...HARNESS_EXCLUDES], { env: commitEnv });
      git(ctx.worktree, ['commit', '-q', '--no-edit'], { env: commitEnv });
    }
    const checks = await runChecks(ctx, ctx.worktree, files);
    if (!checks.ok) ctx.integrationNotes.push(`The build failed after resolving the merge conflicts of subtask ${st.id}:\n${tail(checks.output, 2000)}`);
  }
  const diag = await ctx.deps.lsp.diagnostics(ctx.worktree, filesChanged(ctx.worktree, `${headSha(ctx.worktree)}^1`));
  if (diag.errors.length) ctx.integrationNotes.push(`Language server errors after merging subtask ${st.id}:\n${formatDiagnostics({ ...diag, warnings: [] })}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------

const failure = (outcome, reason, findings = []) => ({ ok: false, outcome, reason, findings });

export async function orchestrate(ctx) {
  try {
    const planned = await planStory(ctx);
    if (planned.fail) return failure(planned.fail, planned.reason, (planned.findings ?? []).map((e) => ({ issue: e })));
    const plan = planned.plan;
    ctx.metrics.mode = plan.mode;
    ctx.log(`plan ${ctx.decisionId.slice(0, 8)}: ${plan.mode}${plan.mode === 'delegate' ? ` (${plan.subtasks.map((s) => `${s.id}:${s.modelClass}/${s.verify}`).join(', ')})` : ''}`);
    ctx.progress();
    return plan.mode === 'self' ? await runSelf(ctx, plan) : await runDelegated(ctx, plan);
  } catch (error) {
    if (error instanceof LimitError) return failure(error.outcome, error.message);
    throw error;
  }
}

// Also the epic foundation unit (lib/epic.mjs): one verifier pair the orchestrator implements itself.
export async function runSelf(ctx, plan) {
  const st = plan.subtasks[0];
  const rec = newRec(st);
  const base = headSha(ctx.worktree);
  ctx.subtasks.set(st.id, { status: 'starting', branch: ctx.branch, worktree: ctx.worktree, rounds: 0 });
  try {
    const r = await runPair(ctx, st, { worktree: ctx.worktree, branch: ctx.branch, base, rec, implementer: 'implementer', role: 'orchestrator' });
    Object.assign(rec, { approved: r.status === 'approved', actual: numstat(ctx.worktree, base) });
    if (r.status === 'approved') return { ok: true, mode: 'self', plan };
    return failure(r.status === 'blocked' ? 'blocked' : 'pair-exhausted', r.status === 'blocked' ? r.reason : `the story was not approved by its verifier after ${pairRounds(ctx, st)} rounds (self mode)${noVerdictNote(rec)}`, r.findings);
  } finally {
    rec.actual ??= numstat(ctx.worktree, base);
    writeSubtaskRun(ctx, rec);
  }
}

// A change the implementer made after the pair rounds (a fix after a blocking review, a feature verification
// bug-fix cycle) is checked by the same verifier pair before it goes on: verify first, and the implementer fixes
// what the verifier finds (dogfood C3: a bug-fix cycle no verifier saw reformatted untouched lines that shipped).
// `base`: the commit before the change. Returns { ok, outcome, reason, findings }.
export async function verifyLaterChange(ctx, { base, label, why }) {
  const plan = ctx.plan;
  const ui = Boolean(plan?.subtasks?.some((s) => s.verify === 'ui'));
  const first = plan?.subtasks?.[0] ?? {};
  const st = {
    id: label,
    goal: `${why}. The change since ${base.slice(0, 7)} must do that and nothing else, and keep the story's acceptance criteria met.`,
    acceptance: first.acceptance ?? [],
    owns: ['**'],
    verify: ui ? 'ui' : 'code',
    scenario: first.scenario ?? null,
  };
  const rec = newRec(st);
  ctx.subtasks.set(st.id, { status: 'starting', branch: ctx.branch, worktree: ctx.worktree, rounds: 0 });
  try {
    const r = await runPair(ctx, st, { worktree: ctx.worktree, branch: ctx.branch, base, rec, implementer: 'implementer', role: 'orchestrator', startAtVerify: true });
    Object.assign(rec, { approved: r.status === 'approved', actual: numstat(ctx.worktree, base) });
    if (r.status === 'approved') return { ok: true };
    return failure(r.status === 'blocked' ? 'blocked' : 'pair-exhausted', r.status === 'blocked' ? r.reason : `the change (${label}) was not approved by its verifier after ${pairRounds(ctx, st)} rounds${noVerdictNote(rec)}`, r.findings);
  } finally {
    rec.actual ??= numstat(ctx.worktree, base);
    writeSubtaskRun(ctx, rec);
  }
}

// The subtasks an interrupted run already merged into the story branch: their "<KEY>: Merge subtask <id>" commits
// since the base. A resumed run keeps their work and does not run their pairs again (held-out C14: a retry after the
// agent-run limit re-ran a merged subtask, whose fresh pair had nothing left to change and was failed three times for
// "no changes were committed").
export function mergedSubtaskIds(worktree, key, base) {
  const r = git(worktree, ['log', '--format=%s', `${base}..HEAD`]);
  const ids = new Set();
  if (r.status !== 0) return ids;
  const prefix = `${key}: Merge subtask `;
  for (const line of r.stdout.split('\n')) if (line.startsWith(prefix)) ids.add(line.slice(prefix.length).trim());
  return ids;
}

async function runDelegated(ctx, plan) {
  const order = topoOrder(plan.subtasks);
  const already = ctx.resume ? mergedSubtaskIds(ctx.worktree, ctx.key, ctx.base) : new Set();
  const state = new Map(order.map((s) => [s.id, already.has(s.id) ? 'merged' : 'pending']));
  if (already.size) ctx.log(`resuming: subtask(s) ${[...already].filter((id) => state.has(id)).join(', ')} already merged into the story branch; not run again`);
  const done = new Map(); // id -> runSubtask result
  const running = new Map();
  let failed = null;
  const fail = (f) => {
    if (failed) return;
    failed = f;
    ctx.abort.abort();
  };

  while (true) {
    if (!failed) {
      for (const st of order) {
        if (running.size >= ctx.s.maxConcurrentPairs) break;
        if (state.get(st.id) !== 'pending' || !st.dependsOn.every((d) => state.get(d) === 'merged')) continue;
        state.set(st.id, 'running');
        const others = plan.subtasks.filter((o) => o.id !== st.id);
        running.set(
          st.id,
          runSubtask(ctx, st, others).then(
            (r) => [st, r],
            (error) => [st, { status: 'error', error }],
          ),
        );
      }
    }
    if (!running.size) break;
    const [st, r] = await Promise.race(running.values());
    running.delete(st.id);
    // An approved subtask's record waits for its merge (it carries the merge conflicts).
    if (r.rec && r.status !== 'approved') writeSubtaskRun(ctx, r.rec);
    if (r.status === 'error') {
      if (r.error instanceof LimitError) fail(failure(r.error.outcome, r.error.message));
      else if (!(r.error instanceof AbortedError)) fail(failure('error', `subtask ${st.id}: ${r.error.message}`));
      state.set(st.id, 'failed');
      continue;
    }
    if (r.status !== 'approved') {
      state.set(st.id, 'failed');
      ctx.subtasks.set(st.id, { ...(ctx.subtasks.get(st.id) ?? {}), status: 'failed' });
      fail(failure('pair-exhausted', `subtask ${st.id} was not approved${r.reason ? `: ${r.reason}` : ` after ${pairRounds(ctx, st)} rounds and an escalation`}`, r.findings));
      continue;
    }
    state.set(st.id, 'approved');
    done.set(st.id, r);
    // Merge serially in plan/dependency order: a subtask merges once every subtask before it has.
    for (const o of order) {
      if (failed) break;
      if (state.get(o.id) === 'merged') continue;
      if (state.get(o.id) !== 'approved') break;
      const res = done.get(o.id);
      const m = await mergeSubtask(ctx, res.st, res.wt, res.rec);
      writeSubtaskRun(ctx, res.rec);
      res.recorded = true;
      if (!m.ok) {
        fail(failure('merge-conflict', m.reason, res.rec.mergeConflictFiles.map((f) => ({ subtask: o.id, file: f, issue: 'merge conflict' }))));
        break;
      }
      state.set(o.id, 'merged');
      ctx.subtasks.set(o.id, { ...(ctx.subtasks.get(o.id) ?? {}), status: 'merged', worktree: null });
      await dropWorktree(ctx, res.wt);
      ctx.progress();
    }
  }
  for (const res of done.values()) if (!res.recorded) writeSubtaskRun(ctx, res.rec);
  // Subtask worktrees of a failed story stay for debugging; their language servers do not.
  for (const [id, st] of ctx.subtasks) if (st.worktree && st.worktree !== ctx.worktree && state.get(id) !== 'merged') await ctx.deps.lsp.stop(st.worktree);
  ctx.progress();
  if (failed) return failed;
  if ([...state.values()].some((v) => v !== 'merged')) return failure('error', `subtasks ${[...state].filter(([, v]) => v !== 'merged').map(([k]) => k).join(', ')} never ran (unsatisfiable dependencies)`);
  return { ok: true, mode: 'delegate', plan, integrationNotes: ctx.integrationNotes };
}

// The folders a UI verifier may write into (screenshots, recordings, test reports): implement.ui.artifactDirs.
export const UI_ARTIFACT_DIRS = ['artifacts', 'test-results', 'playwright-report', 'blob-report'];
export const uiArtifactDirs = (config) => (Array.isArray(config.implement?.ui?.artifactDirs) ? config.implement.ui.artifactDirs : UI_ARTIFACT_DIRS);

