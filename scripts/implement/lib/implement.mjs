import { writeText } from '../../pipeline/lib/redact.mjs';
import fs from 'node:fs';
import { hostFor, hostOf } from '../../pipeline/lib/hosts/index.mjs';
import { prAnalysisSection, recordAnalysis, reportFor } from '../../pipeline/lib/analysis/fixloop.mjs';
import { resolveAnalysis } from '../../pipeline/lib/analysis/config.mjs';
import { heldSecrets } from '../../pipeline/lib/analysis/commit-gate.mjs';
import { dropUnpushedSecrets } from '../../pipeline/lib/analysis/history.mjs';
import { isSecretTool } from '../../pipeline/lib/analysis/secrets.mjs';
import { fixTaskText } from '../../pipeline/lib/analysis/report.mjs';
import { withStaticAnalysis } from '../../pipeline/lib/analysis/report.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IMPLEMENTER, ceiling, runAgent } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT, deepMerge, loadConfig } from '../../pipeline/lib/config.mjs';
import { formatBugs, normalizeBugs } from '../../pipeline/lib/decisions.mjs';
import { addWorktree, git, implChanges, revExists } from '../../pipeline/lib/git.mjs';
import { HUMAN_DECISIONS_FILE, decisionsBlock, readDecisions } from '../../pipeline/lib/human-decisions.mjs';
import { loadState, RUN_CONDITIONS_FILE, metricsFile, readMetrics, readMetricsLocal, updateState } from '../../pipeline/lib/state.mjs';
import { runDied } from '../../pipeline/lib/recovery.mjs';
import { prsDisabled, runTags } from '../../pipeline/lib/run-tags.mjs';
import { USAGE_FILE, addUsage } from '../../pipeline/lib/usage.mjs';
import { activeStoryFile } from '../../pipeline/lib/stories.mjs';
import { openPullRequest, prPublisher, pushBranch, pushFoldedBranch } from '../../pipeline/lib/bot.mjs';
import { clearEscalationNotes, resolvedLabel } from '../../board/lib/escalation.mjs';
import { readMeta, ticketFile, writeTicket } from '../../board/lib/source.mjs';
import { gateConfig } from '../../review-gate/lib/config.mjs';
import { liveDiffKey, localDiffKey } from '../../review-gate/lib/assessment.mjs';
import { recordReopen } from '../../review-gate/lib/sync.mjs';
import { metaFor } from '../../board/lib/ticket-format.mjs';
import { VIDEO_SECTION_END, VIDEO_SECTION_START, appendJsonl, bootId, extractResult, isProcessAlive, log, nowIso, readJson, run, runAsync, sleep, stepRecord, tail, writeJson } from '../../pipeline/lib/util.mjs';
import { branchFor, collectStories, orderStories, worktreeFor } from './batch.mjs';
import { boardEvent } from './board-events.mjs';
import { OUTCOMES_FILE, attributeEscaped, storyOutcomeRecord } from './decisions.mjs';
import { changedLineLint, parityGate, paritySection } from './ci-parity.mjs';
import { analysisFindings, analysisGate, analysisGateSection, remedyRedBranch } from './analysis-gate.mjs';
import { ciFixBudget, ciGate, ciLine, deliveryDecision } from './ci-wait.mjs';
import { sideEffectsSection } from './side-effects.mjs';
import { councilFor, councilRecords, councilReviewSection, fixDeclarationText, fixesFile, sealPendingFixes, withCouncilReview } from '../../pipeline/lib/council.mjs';
import { freeReroute, returnSettings, returnTask, routeFindings, unaddressed } from './pr-check-return.mjs';
import { dedupeFollowUps, followUpLine } from './follow-ups.mjs';

export { dedupeFollowUps };
import { commitAll, commitEnv, commitRecords, filesChanged, formattingOnlyHunks, headSha, listSubtaskWorktrees, removeWorktree, stackedRef } from './gitops.mjs';
import { LSP_RECORD, formatDiagnostics, lspAdapter } from './lsp.mjs';
import { LimitError, RESUME_NOTE, checkBudget, createContext, orchestrate, verifyLaterChange } from './orchestrate.mjs';
import { applyResources, resourcesFromEnv, waitForMemory } from './resources.mjs';
import { newFeedbackLog } from './feedback.mjs';
import { readOutage } from '../../pipeline/lib/outage.mjs';
import { epicNoteBlock, integrationTask } from './tasks.mjs';
import { isBugTicket } from './epic-plan.mjs';
import { reviewGateAssess, reviewGatePublish } from './post-publish.mjs';
import { severityAtLeast } from '../../pipeline/lib/severity.mjs';
import { push as sinkPush, sinkSettings } from '../../pipeline/lib/sink.mjs';
import { isReopened, openPrFor, placeReopened, prIsOpen, syncFromRemote } from './reopen.mjs';
import { confirmPrState, headActivities, holdPr, preOpenMedia, preOpenSettings, proveBeforeOpen, readyAudit, recordHeadActivity, releasePr } from './pre-open.mjs';
import { keyFolder } from '../../pr-video/lib/pr-video.mjs';
import { pruneRunLocal, removeDelivered } from '../../factory/lib/prune.mjs';
import { defaultSettings, setting } from '../../pipeline/lib/settings.mjs';
import { fvEnabled } from '../../feature-verification/lib/enabled.mjs';

// With a PR check council, the implementer answering a return says which lines answer which finding (council.mjs
// fixDeclarationText); '' otherwise.
function declarePrCheckFixes(config, worktree, key, findings) {
  if (councilFor(config, 'prCheck', { subject: key }).sole) return '';
  const text = fixDeclarationText(fixesFile(worktree, config.stateDir, { stage: 'prCheck', story: key }), findings ?? []);
  return text ? `\n\n${text}` : '';
}

// The wait before a worker's retry: implement.worker.retryDelaySec, doubled each retry (1, 2, 4 ... times), like
// recovery.retryDelaySec.
export const retryWaitMs = (retryDelaySec, attempt) => retryDelaySec * 1000 * 2 ** (attempt - 1);

const PIPELINE_CLI = path.join(INSTALL_ROOT, 'scripts/pipeline/pipeline.mjs');
const FV_CLI = path.join(INSTALL_ROOT, 'scripts/feature-verification/feature-verification.mjs');
const PR_CHECK_CLI = path.join(INSTALL_ROOT, 'scripts/pr-check/pr-check.mjs');
const FV_TERMINAL = new Set(['verified', 'product-bug', 'escalated', 'blocked-on-plan', 'crashed', 'interrupted']);
// Outcomes from a run that died rather than finished: the next run resumes them, and the batch retries
// them itself a few times.
const INTERRUPTED = new Set(['error', 'fv-crashed', 'fv-not-started', 'fv-timed-out']);
const RETRYABLE = new Set(['error', 'fv-not-started']);
// A finished delivery whose PR could not open yet (the host refused its text, pre-open gate assessment failed, or the
// open failed after CI proved the head): implementation, review and feature verification are done and the head is
// CI-proven, so a later run (or `implement resume`) skips straight to delivery (delivery-stage agents such as the
// analysis/CI fixer, unsaved bug triage, or demo narrator may still run if needed). Records from before the pr-refused
// outcome say not-delivered with the host's failure.
// Planning and the worker's start clear `outcome` and `reason` (the run is queued, then running): the disposition that made it
// resumable at the open is kept in `pendingOpen` until the run ends, so the story still takes the open-pending route
// (held-out C22: the resume took the general route and reset the first push time).
const pendingDisposition = (rec) => (rec && !rec.outcome && rec.pendingOpen ? { ...rec, ...rec.pendingOpen } : rec);
// A rating that failed on a PR already open and on hold resumes at the rating too: the PR stays on hold meanwhile.
export const openPending = (rec0) => {
  const rec = pendingDisposition(rec0);
  if (!(rec && rec.phase === 'pre-open' && rec.greenAt)) return false;
  if (rec.outcome === 'gate-assessment-failed') return !rec.pr || (rec.holds ?? []).some((h) => !h.to && h.ok !== false);
  return Boolean(!rec.pr && (rec.outcome === 'pr-refused' || (rec.outcome === 'not-delivered' && /\b(?:pr|pull request) creat(?:e|ion) failed\b/.test(rec.reason ?? ''))));
};
// Why a delivery may not resume where it stopped, or null: { why, unreadable } when the branch head, here or on the
// remote, is not the one CI proved (`provenHead`; a person pushed in between), or `unreadable` when either could not be
// read to tell (the resume then stops: it never guesses). The remote's head is the SHA the remote itself answers
// (`git ls-remote`), never a remote-tracking ref (which a narrowed fetch leaves stale). A record from before `provenHead`
// was kept resumes as before, unless its PR is open (a person can push to it).
export function headMovedSince(worktree, branch, rec, { gitImpl = git } = {}) {
  if (!rec.provenHead && rec.pr) return { why: `the head CI proved was not recorded and ${rec.pr} is open` };
  const local = gitImpl(worktree, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (local.status !== 0 || !local.stdout.trim()) return { why: 'its head could not be read', unreadable: true };
  // A record from before the proven head was kept: the remote is compared with the local head instead.
  const proven = rec.provenHead ?? local.stdout.trim();
  if (local.stdout.trim() !== proven) return { why: `its head is ${local.stdout.trim().slice(0, 7)}, not ${proven.slice(0, 7)} that CI proved` };
  const remote = gitImpl(worktree, ['ls-remote', 'origin', `refs/heads/${branch}`], { env: commitEnv });
  const sha = remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0] : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return { why: `origin/${branch} could not be read`, unreadable: true };
  if (sha !== proven) return { why: `origin/${branch} is at ${sha.slice(0, 7)}, not ${proven.slice(0, 7)} ${rec.provenHead ? 'that CI proved' : 'here'} (pushed in between)` };
  return null;
}
// Brings a resumed run's checkout to the head the remote has now (a person may have pushed while the run was stopped), so
// the stages that run again review those commits: { head, moved } or { stop } when the remote cannot be read, its
// commits cannot be fetched, or the checkout cannot be fast-forwarded to them (never a merge or a reset of local work).
// The caller also compares `head` with the commit the run itself last pushed or proved (a checkout an earlier resume
// already brought forward is at the remote's head too: `moved` alone would not tell).
export function takeRemoteHead(worktree, branch, { gitImpl = git } = {}) {
  const remote = gitImpl(worktree, ['ls-remote', 'origin', `refs/heads/${branch}`], { env: commitEnv });
  const sha = remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0] : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return { stop: `origin/${branch} could not be read` };
  const local = gitImpl(worktree, ['rev-parse', '--verify', '-q', 'HEAD']).stdout?.trim() ?? '';
  if (local === sha) return { head: sha, moved: false };
  if (gitImpl(worktree, ['fetch', '-q', 'origin', `refs/heads/${branch}`], { env: commitEnv }).status !== 0) return { stop: `the commits on origin/${branch} could not be fetched` };
  if (!local || gitImpl(worktree, ['merge-base', '--is-ancestor', local, sha]).status !== 0) return { stop: `this checkout (${local.slice(0, 7) || '?'}) and origin/${branch} (${sha.slice(0, 7)}) have diverged; a person brings them together` };
  if (gitImpl(worktree, ['merge', '--ff-only', '-q', sha], { env: commitEnv }).status !== 0) return { stop: `this checkout could not be brought to ${sha.slice(0, 7)} on origin/${branch} (local changes in the way)` };
  return { head: sha, moved: true };
}
// What to keep through planning and start-up: the earlier run's outcome and reason when it waits only for its PR to open.
export const keepPendingOpen = (rec) => (openPending(rec) ? { pendingOpen: rec.pendingOpen && !rec.outcome ? rec.pendingOpen : { outcome: rec.outcome, reason: rec.reason ?? null } } : { pendingOpen: null });
// Outcomes that wait for a human, and the stage whose escalation note says so: while the note is still in
// the story's worktree (.factory/state/escalations/<KEY>-<stage>.md), a later run keeps the outcome
// instead of running the story again to the same end. Handling the escalation (a stage re-run that
// passes clears its note, or a human deletes it) or --force runs it again.
const ESCALATION_STAGE = { 'fv-escalated': 'automation', 'fv-blocked-on-plan': 'plan', 'review-escalated': 'review' };
const escalationStands = (config, s, prev) => {
  const stage = ESCALATION_STAGE[prev?.outcome];
  const wt = prev?.worktree ?? worktreeFor(config, s);
  return Boolean(stage) && fs.existsSync(path.join(wt, config.stateDir, 'escalations', `${s.key}-${stage}.md`));
};
// The outcome a story skipped by plan() reports: its standing escalation, or `skipped`.
export const skippedOutcome = (s) => ({ outcome: s.escalatedBefore ?? 'skipped', reason: s.skip });

export const runsDir = (config) => path.join(config.root, config.stateDir, 'implement');
const runFile = (config, key) => path.join(runsDir(config), `${key}.json`);
export const loadRun = (config, key) => readJson(runFile(config, key), null);
export const batchFile = (config) => path.join(runsDir(config), 'batch.json');
export const saveRun = (config, key, patch) => writeJson(runFile(config, key), { ...(loadRun(config, key) ?? {}), key, ...patch, updatedAt: nowIso() });

// The feature verification stages whose escalation a human resolved start over as well. A decision about the tests needs no
// code change, so with the implementation hash unchanged the feature verification stop hook would take its escalated run as
// current and the worker would read the old escalation back without feature verification ever seeing the decision.
export function resetEscalatedFv(config, key, worktree) {
  if (!worktree || !fs.existsSync(worktree)) return [];
  const reset = [];
  updateState({ root: worktree, stateDir: config.stateDir }, key, (st) => {
    if (['escalated', 'blocked-on-plan'].includes(st.automation.status)) {
      st.automation = { ...st.automation, status: 'idle', workingHash: null, requestedHash: null, verifiedHash: null, bugs: [], recoveries: 0, retryAt: null };
      reset.push('automation');
    }
    if (st.plan.status === 'escalated') {
      st.plan = { ...st.plan, status: 'idle', recoveries: 0, retryAt: null };
      reset.push('plan');
    }
  });
  return reset;
}

// A re-run of a ticket a human resolved starts clean: the escalation-resolved label comes off (a later
// failure asks again) and the old escalation notes go, so the next failure comment only shows new ones.
// A ticket a person sends back after a delivery that had a PR (its escalation resolved, then a re-run) was rejected: the
// review gate records it as a reopen on the ticket, so the re-run never merges itself (owner rule). Recorded also while the
// gate is off, so turning it on again finds the decision. Returns what was stored.
function recordRequeueRejection(config, { key, pr }) {
  const gc = gateConfig(config.root);
  const issue = readMeta(config, key)?.issue?.number;
  if (!issue) throw new Error('the ticket has no issue in the ticket cache to record it on');
  return recordReopen(gc, null, { key, issue: { number: issue }, reopen: { at: nowIso(), source: 'requeue', detail: 're-queued after a person resolved its escalation', pr, afterMerge: false } }, { metricsConfig: config, log: (m) => log(m) });
}

// Stories whose delivery the review gate must treat as having an unknown history (rejectionChecked false, so review):
// recorded in each run record for this run and its resumes (a later run that is not forced starts without it).
export function markHistoryUnknown(config, stories, why) {
  for (const s of stories) {
    s.historyUnknown = why;
    saveRun(config, s.key, { historyUnknown: why });
  }
}

export function startResolvedReruns(config, stories, { event = boardEvent, pr = true, recordRejection = recordRequeueRejection } = {}) {
  const started = [];
  // A reopened bug fix (review gate) re-runs once: for a follow-up (no open PR) the label comes off now; when an open PR
  // must be put on hold first, the label stays until the hold is confirmed in the worker (so a hold failure keeps it).
  // Without --pr the worker never takes the reopened path (and never clears the label), so it comes off now.
  for (const s of stories.filter((x) => x.reopened && !x.skip)) {
    if (!s.reopenedPr || !pr) event(config.root, s.key, ['clear-reopened', s.key]);
    log(`${s.key}: re-run of a reopened bug fix${s.reopenedPr ? ` on ${s.branch} (${s.reopenedPr})` : s.followUp ? ` as a follow-up on ${s.branch}` : ''}.`);
  }
  for (const s of stories.filter((x) => x.resolved && !x.skip)) {
    const delivered = loadRun(config, s.key)?.pr;
    if (delivered) {
      // Recorded before the marker (escalation-resolved) is consumed: if it cannot be, the marker stays and the ticket
      // waits for the next requeue, so the rejection is never lost.
      try {
        if (!recordRejection(config, { key: s.key, pr: delivered })) throw new Error('nothing was stored');
      } catch (error) {
        s.skip = `the rejection of ${delivered} could not be recorded on the ticket (${String(error?.message ?? error).split('\n')[0]}); escalation-resolved is kept and the next requeue tries again`;
        log(`${s.key}: ${s.skip}`);
        continue;
      }
    }
    const removed = clearEscalationNotes(config, s.key, [s.worktree]);
    const reset = resetEscalatedFv(config, s.key, s.worktree);
    event(config.root, s.key, ['clear-resolved', s.key]);
    log(`${s.key}: re-run with the human decisions${removed.length ? `; ${removed.length} old escalation note(s) cleared` : ''}${reset.length ? `; feature verification ${reset.join(' and ')} start over` : ''}.`);
    started.push(s.key);
  }
  return started;
}

// ---------------------------------------------------------------------------------------------
// Batch: order the stories, then run one worker process per story, at most `parallel` at a time
// ---------------------------------------------------------------------------------------------

// A ticket waiting for a person: the board's needs-human label without escalation-resolved.
export const waitingForPerson = (config, s) => (s.labels ?? []).includes(setting(config, 'board.blockedLabel')) && !(s.labels ?? []).includes(setting(config, 'board.resolvedLabel'));

export function plan(config, inputs, { base = config.baseRef, force = false, placeReopenedRuns = true, reopenDeps = {}, resumeStopped = false, checkPrState = true } = {}) {
  const stories = orderStories(collectStories(inputs));
  const byKey = new Map(stories.map((s) => [s.key, s]));
  for (const s of stories) {
    // A bug fix a person reopened after the review gate assessed it runs again (reopen.mjs).
    s.reopened = isReopened(config, s);
    // Waiting for a person (the board's needs-human label, an escalation or an owner decision not yet answered): not
    // run again until the person resolves it (council C6: an epic run picked up a ticket blocked on its owner).
    const blocked = setting(config, 'board.blockedLabel');
    // A delivery that only waits for its PR to open needs no person's answer: it resumes at the open.
    const waiting = waitingForPerson(config, s) && !(!force && openPending(loadRun(config, s.key)));
    s.skip = s.abandoned && !s.reopened ? 'abandoned (its issue is closed as not planned or a duplicate)' : waiting && !force ? `waiting for a person (${blocked}): answer the questions on the ticket and tick Resolved` : s.implemented && !force && !s.reopened ? 'already implemented (its issue is closed; --force to redo)' : null;
    if (s.skip) {
      const done = loadRun(config, s.key);
      if (done?.outcome === 'done' && done.pr) s.ownPr = done.pr;
    }
    // A human answered the escalation questions of its last run (the issue is labeled
    // escalation-resolved): the ticket runs again, fresh, as with --force for its earlier run's outcome
    // (also a standing fv/review escalation, which otherwise waits for a human).
    s.resolved = Boolean(s.labels?.includes(resolvedLabel(config)));
    const retry = force || s.resolved || s.reopened;
    // A later run continues where an interrupted one stopped: finished stories are kept, stories that
    // died part-way resume in their worktree.
    const prev = retry || s.skip ? null : loadRun(config, s.key);
    // A delivered run's local branch is removed once it is on the remote (prune.mjs removeDelivered): the remote one counts.
    if (prev?.outcome === 'done' && prev.branch && (revExists(config.root, `refs/heads/${prev.branch}`) || revExists(config.root, `refs/remotes/origin/${prev.branch}`))) {
      s.skip = `done in a previous run (--force to redo)`;
      s.doneBefore = true;
      if (prev.pr) s.ownPr = prev.pr;
    } else if (escalationStands(config, s, prev)) {
      s.skip = `${prev.outcome} in a previous run: its escalation waits for a human (label the issue escalation-resolved, or --force, to retry)`;
      s.escalatedBefore = prev.outcome;
    }
    // A record without a worktree (an epic run's story that died before reporting one) resumes in the
    // story's own worktree path.
    const prevWorktree = prev?.worktree ?? (prev ? worktreeFor(config, s) : null);
    s.resume = Boolean(prev && !s.doneBefore && (prev.status === 'running' || INTERRUPTED.has(prev.outcome) || openPending(prev)) && prevWorktree && fs.existsSync(prevWorktree));
    // A run that stopped while it waited for its PR's CI is not "already implemented": it resumes at the CI wait
    // (council C11: the CI gate, the retry check and the review gate were lost).
    const ciRun = force || waiting || (s.abandoned && !s.reopened) ? null : loadRun(config, s.key);
    // A run `implement stop` ended at its CI wait is resumed there only by an explicit `implement resume` (council C12:
    // a run stopped after a hung gh call would otherwise be implemented again from the start).
    const resumable = (o) => !o || ['error', 'skipped', 'release-unconfirmed', 'hold-failed'].includes(o) || INTERRUPTED.has(o) || (resumeStopped && o === 'stopped');
    if (['ci-wait', 'draft-back'].includes(ciRun?.phase) && ciRun.pr && resumable(ciRun.outcome) && ciRun.worktree && fs.existsSync(ciRun.worktree)) {
      s.skip = null;
      s.resume = true;
      s.ciResume = ciRun.pr;
      s.doneBefore = false;
    }
  }
  // Blockers already implemented are on the base branch, so only the ones built in this run (or kept
  // from an earlier one, still on their branch) count.
  const ancestors = new Map();
  for (const s of stories) {
    // An escalated blocker stays a dependency, so its dependents are skipped as when it first ended.
    s.deps = s.deps.filter((k) => !byKey.get(k).skip || byKey.get(k).doneBefore || byKey.get(k).escalatedBefore);
    ancestors.set(s.key, new Set(s.deps.flatMap((k) => [k, ...ancestors.get(k)])));
  }
  for (const s of stories) {
    s.branch = branchFor(config, s);
    s.worktree = worktreeFor(config, s);
    // A story stacks on the branch of the in-batch blocker that already contains the most of its other
    // blockers, and merges in whatever that branch lacks, so it builds on all the code it needs.
    const deps = s.deps.filter((k) => !s.deps.some((o) => o !== k && ancestors.get(o).has(k)));
    deps.sort((a, b) => ancestors.get(b).size - ancestors.get(a).size);
    s.base = deps.length ? byKey.get(deps[0]).branch : base;
    s.merge = deps.slice(1).map((k) => byKey.get(k).branch);
    if (s.reopened && !s.skip && placeReopenedRuns) placeReopened(config, s, reopenDeps);
    // A prior run that left an open PR (e.g. hold-failed before any agent ran, even if the `reopened` label was
    // cleared) still routes through reopenedPr so the worker must confirm the PR is on hold before any agent starts.
    if (!s.skip && !s.ciResume && !s.reopenedPr && placeReopenedRuns) {
      const priorRec = loadRun(config, s.key);
      const priorPr = priorRec?.pr ?? priorRec?.reopenedPr ?? null;
      if (priorPr && priorRec.outcome !== 'done' && !checkPrState) s.prUnchecked = priorPr;
      else if (priorPr && priorRec.outcome !== 'done') {
        const checkOpen = reopenDeps.prIsOpen ?? ((u) => prIsOpen(config, u));
        // Fails closed: a PR whose state could not be read ('unknown') is treated as open, so the worker holds it first
        // (and stops with hold-failed, no agent, when that hold cannot be confirmed either).
        const open = checkOpen(priorPr);
        // A PR closed by the run's own close-reopen hold (recorded, not released) is still this ticket's PR on hold: it
        // keeps the route, so the worker confirms that hold before any agent runs, never a second PR.
        const closedByHold = (priorRec.holds ?? []).some((h) => h.mode === 'close-reopen' && !h.to && h.ok !== false);
        if (open === true || open === 'unknown' || closedByHold) {
          s.reopenedPr = priorPr;
          s.fromRemote = true;
          if (priorRec.branch) s.branch = priorRec.branch;
          if (priorRec.worktree) s.worktree = priorRec.worktree;
        }
      }
    }
  }
  return stories;
}

// A story the batch never ran (skipped because a blocker failed, in epic delivery) has no run record of
// its own, so `board fail` would describe it as "no result" and, with no finish time, post a new failure
// comment on every run. Its outcome is recorded, keeping the first time it ended that way.
export function recordUnrun(config, r) {
  const prev = loadRun(config, r.key);
  if (prev && prev.outcome && prev.outcome !== 'skipped') return;
  if (prev?.outcome === r.outcome && prev?.reason === (r.reason ?? null) && prev?.finishedAt) return;
  saveRun(config, r.key, { outcome: r.outcome, reason: r.reason ?? null, status: 'finished', finishedAt: nowIso() });
}

export function describePlan(stories) {
  return stories
    .map((s, i) => `${String(i + 1).padStart(2)}. ${s.key.padEnd(10)} ${s.skip ? `skip: ${s.skip}` : `${s.branch} <- ${s.base}${s.merge.length ? ` + ${s.merge.join(', ')}` : ''}${s.ciResume ? `  (resume at the CI wait of ${s.ciResume})` : s.resume ? '  (resume)' : ''}${s.resolved ? '  (re-run with human decisions)' : ''}${s.prUnchecked ? `  (PR state not checked: ${s.prUnchecked})` : ''}`}${s.blockedBy.length ? `  (blocked by ${s.blockedBy.join(', ')})` : ''}`)
    .join('\n');
}

// `deps` replaces the worker start and the wait between retries (tests).
export async function runBatch(config, stories, { parallel = 1, pr = false, script, deps = {} }) {
  const start = deps.startWorker ?? startWorker;
  const wait = deps.sleep ?? sleep;
  fs.mkdirSync(runsDir(config), { recursive: true });
  const outcome = new Map(stories.filter((s) => s.skip).map((s) => [s.key, skippedOutcome(s)]));
  for (const s of stories) {
    if (s.doneBefore || s.escalatedBefore) continue;
    saveRun(config, s.key, s.skip ? { outcome: 'skipped', reason: s.skip, status: 'finished' } : { status: 'queued', outcome: null, reason: null, branch: s.branch, worktree: s.worktree, base: s.base, ...(s.resume ? keepPendingOpen(loadRun(config, s.key)) : { pendingOpen: null }) });
  }
  const retries = new Map();
  // implement.worker: a failed ticket is started again up to maxRetries times; the wait doubles each retry.
  const { maxRetries, retryDelaySec } = config.implement.worker;

  const pending = stories.filter((s) => !s.skip);
  const running = new Map();
  const blockerFailed = (s) => s.deps.find((k) => outcome.has(k) && !['done', 'skipped'].includes(outcome.get(k).outcome));
  const ready = (s) => s.deps.every((k) => ['done', 'skipped'].includes(outcome.get(k)?.outcome));

  const batchStarted = Date.now();
  while (pending.length || running.size) {
    // An agent provider outage (outage.mjs): start nothing more, and skip no blocked story for it.
    const outage = readOutage(batchStarted);
    if (outage && !running.size) break;
    for (let i = 0; !outage && i < pending.length; i++) {
      const s = pending[i];
      const failed = blockerFailed(s);
      if (failed) {
        pending.splice(i--, 1);
        const result = { outcome: 'skipped', reason: `blocker ${failed} ended ${outcome.get(failed).outcome}` };
        outcome.set(s.key, result);
        saveRun(config, s.key, { ...result, status: 'finished' });
        log(`${s.key}: ${result.reason}; skipped.`);
      } else if (running.size < parallel && ready(s)) {
        pending.splice(i--, 1);
        // Back-pressure: a new story waits while free memory is below the reserve (auto sizing).
        running.set(s.key, (deps.startWorker ? Promise.resolve() : waitForMemory(config, s.key)).then(() => start(config, s, { pr, script })).then((r) => [s, r]));
      }
    }
    if (!running.size) continue;
    const [s, result] = await Promise.race(running.values());
    running.delete(s.key);
    const attempt = (retries.get(s.key) ?? 0) + 1;
    if (RETRYABLE.has(result.outcome) && attempt <= maxRetries && !result.outage) {
      retries.set(s.key, attempt);
      s.resume = true;
      log(`${s.key}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}; retrying (${attempt}/${maxRetries}).`);
      running.set(s.key, wait(retryWaitMs(retryDelaySec, attempt)).then(() => start(config, s, { pr, script })).then((r) => [s, r]));
      continue;
    }
    outcome.set(s.key, result);
    log(`${s.key}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
  }
  for (const s of pending) outcome.set(s.key, { outcome: null, reason: 'not started: the agent provider is unavailable' });
  return stories.map((s) => ({ ...s, ...outcome.get(s.key) }));
}

// One attempt's figures, from a run record (null before any attempt started).
const ATTEMPT_FIELDS = ['startedAt', 'finishedAt', 'outcome', 'reason', 'minutes', 'agentRuns', 'pairRounds', 'implementerRuns', 'takeovers', 'escalations', 'limitHit', 'tokens', 'cost_usd', 'unpriced_runs', 'lspCalls', 'analysisBounces'];
export function attemptOf(rec) {
  if (!rec?.startedAt || (rec.outcome == null && rec.agentRuns == null)) return null;
  const a = Object.fromEntries(ATTEMPT_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));
  if (Array.isArray(rec.prCheckReturns)) a.prCheckReturns = rec.prCheckReturns.length;
  return a;
}
export function attemptTotals(attempts) {
  const sum = (k) => attempts.reduce((n, a) => n + (Number(a?.[k]) || 0), 0);
  return { attempts: attempts.length, agentRuns: sum('agentRuns'), pairRounds: sum('pairRounds'), implementerRuns: sum('implementerRuns'), tokens: sum('tokens'), cost_usd: Math.round(sum('cost_usd') * 1e6) / 1e6, minutes: Math.round(sum('minutes') * 100) / 100 };
}

export function startWorker(config, story, { pr, script }) {
  const resultFile = path.join(runsDir(config), `${story.key}.result.json`);
  const logPath = path.join(config.root, config.stateDir, 'logs', `implement-${story.key}-${nowIso().replace(/[:.]/g, '-')}.log`);
  fs.rmSync(resultFile, { force: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const args = ['story', story.key, '--file', story.file, '--base', story.base, '--branch', story.branch, '--worktree', story.worktree, '--result', resultFile];
  if (story.merge?.length) args.push('--merge', story.merge.join(','));
  // Epic delivery: the story gets the epic design note, and the runner merges it into the epic branch
  // and moves its card after the worker ends.
  if (story.epicNote) args.push('--epic-note', story.epicNote);
  if (story.epicBranch) args.push('--epic-branch', story.epicBranch);
  if (pr) args.push('--pr');
  if (story.resume) args.push('--resume');
  if (story.fromRemote) args.push('--from-remote');
  if (story.reopenedPr) args.push('--reopened-pr', story.reopenedPr);
  const running = { status: 'running', outcome: null, reason: null, startedAt: nowIso(), log: path.relative(config.root, logPath) };
  // A fresh start drops the previous attempt's metrics and findings, which `implement status` and the
  // board's failure comment would otherwise report as this run's; a resume keeps them.
  // A retried or resumed attempt keeps the attempts before it (held-out C14 PRICE-1: the record kept the retry's 6 agent
  // runs and lost the first attempt's 32); `totals` adds them up when the attempt ends.
  if (story.resume) {
    const prior = loadRun(config, story.key) ?? {};
    const attempt = attemptOf(prior);
    saveRun(config, story.key, { ...running, ...keepPendingOpen(prior), ...(attempt ? { attempts: [...(prior.attempts ?? []), attempt] } : {}) });
  } else {
    const prior = story.reopenedPr ? loadRun(config, story.key) ?? {} : null;
    const reopenState = story.reopenedPr
      ? { pr: story.reopenedPr, reopenedPr: story.reopenedPr, ...(prior?.pr === story.reopenedPr ? { holds: prior.holds ?? [], readyAt: prior.readyAt ?? null, openedAt: prior.openedAt ?? null } : {}) }
      : {};
    // The manifest of what earlier attempts created stays (a worktree they made is still theirs to remove after delivery),
    // and so do the PRs earlier runs opened (the review gate reads a person's close of any of them); this run's unknown
    // history (markHistoryUnknown) is recorded.
    const old = loadRun(config, story.key) ?? {};
    const earlierPrs = [...new Set([...(old.earlierPrs ?? []), old.pr, ...(old.attempts ?? []).map((a) => a?.pr)].filter(Boolean))];
    writeJson(runFile(config, story.key), { key: story.key, branch: story.branch, worktree: story.worktree, base: story.base, merge: story.merge ?? [], ...(old.created ? { created: old.created } : {}), ...(earlierPrs.length ? { earlierPrs } : {}), ...(story.historyUnknown ? { historyUnknown: story.historyUnknown } : {}), ...reopenState, ...running, updatedAt: nowIso() });
  }
  log(`${story.key}: started on ${story.branch} (log: ${path.relative(config.root, logPath)})`);
  const fd = fs.openSync(logPath, 'a');
  const env = { ...process.env };
  delete env.PIPELINE_ROOT;
  const child = spawn(process.execPath, [script, ...args], { cwd: config.root, stdio: ['ignore', fd, fd], env, windowsHide: true });
  fs.closeSync(fd);
  // The worker's own process: recovery never treats a story whose worker is alive as interrupted.
  if (child.pid) saveRun(config, story.key, { workerPid: child.pid, workerBoot: bootId() });
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      let result = readJson(resultFile, null) ?? { outcome: 'error', reason: `worker exited ${code} without a result; see ${path.relative(config.root, logPath)}` };
      // A story that failed during an agent provider outage was interrupted, not failed: `error` makes
      // the next run resume it in its worktree.
      const outage = result.outcome !== 'done' ? readOutage(Date.parse(running.startedAt)) : null;
      if (outage) result = { ...result, outcome: 'error', reason: `interrupted: the agent provider is unavailable (${outage.reason}); was ${result.outcome}`, outage: true };
      const finishedAt = nowIso();
      const before = loadRun(config, story.key)?.attempts ?? [];
      saveRun(config, story.key, { ...result, status: 'finished', finishedAt, ...(before.length ? { totals: attemptTotals([...before, attemptOf({ ...result, startedAt: running.startedAt, finishedAt })]) } : {}) });
      resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Worker: one story, start to finish, in its own worktree
// ---------------------------------------------------------------------------------------------

export function prepareWorktree(config, { key, file, base: base0, branch, worktree, merge: merge0 = [], fromRemote = false }) {
  // A stacked blocker delivered earlier may only be on the remote now (its local branch removed after delivery).
  const base = stackedRef(config.root, base0);
  const merge = merge0.map((m) => stackedRef(config.root, m));
  // A reopened bug fix re-runs on its open PR's branch: start from the remote branch when this machine
  // has none, and take a person's commits on the PR (fast-forward) when it has.
  const fetched = fromRemote && !revExists(config.root, `refs/heads/${branch}`) && git(config.root, ['fetch', '-q', 'origin', `${branch}:${branch}`], { env: commitEnv }).status === 0;
  if (fetched) log(`${key}: ${branch} fetched from origin (reopened bug fix)`);
  const created = !fs.existsSync(worktree);
  if (created) {
    if (!revExists(config.root, base)) throw new Error(`base ${base} does not exist`);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const exists = revExists(config.root, `refs/heads/${branch}`) && !fetched;
    addWorktree(config.root, ['-q', ...(exists || fetched ? [worktree, branch] : ['-b', branch, worktree, base])], { env: commitEnv });
    log(`${key}: worktree ${worktree} on ${branch}${exists ? ' (existing branch)' : ` from ${base}`}`);
    // The manifest: what this run created, the only things its cleanup may remove (prune.mjs removeDelivered). A branch
    // that existed before this worktree was added is not this run's, whatever an earlier record says.
    saveRun(config, key, { created: { worktree: fs.realpathSync(worktree), branch: exists ? null : branch } });
  } else {
    log(`${key}: reusing worktree ${worktree}`);
    // A re-run (resume, requeue, --force) takes what landed on its base since the branch was made, the factory's
    // pin and fixes included: otherwise it would re-run on the engine version and fixes of its first run.
    if (base && revExists(worktree, base) && git(worktree, ['merge-base', '--is-ancestor', base, 'HEAD']).status !== 0) {
      const r = git(worktree, ['merge', '--no-edit', '-q', base], { env: commitEnv });
      if (r.status !== 0) {
        git(worktree, ['merge', '--abort']);
        return { error: `merging ${base} into the reused worktree conflicts; resolve it by hand in ${worktree}` };
      }
      log(`${key}: merged ${base} into the reused worktree (it had moved on since the branch was made)`);
    }
  }
  if (fromRemote && !syncFromRemote(worktree, branch, commitEnv)) log(`${key}: ${branch} could not be fast-forwarded to origin/${branch}; continuing from the local branch`);
  for (const other of merge) {
    const r = git(worktree, ['merge', '--no-edit', '-q', other], { env: commitEnv });
    if (r.status !== 0) {
      git(worktree, ['merge', '--abort']);
      return { error: `merging ${other} conflicts; resolve it by hand in ${worktree}` };
    }
  }
  // The ticket (story, metadata, its own mockups) goes into the worktree's ticket cache, so the review,
  // feature verification and PR check stages there read the same text. A resumed run keeps the worktree's copy (it may
  // carry the implementer's Implementation Notes).
  const wtConfig = loadConfig('implement', worktree);
  const target = ticketFile(wtConfig, key);
  if (!fs.existsSync(target)) {
    const meta = path.join(path.dirname(file), 'meta.json');
    if (path.basename(file) === 'story.md' && fs.existsSync(meta)) {
      fs.mkdirSync(path.dirname(path.dirname(target)), { recursive: true });
      fs.cpSync(path.dirname(file), path.dirname(target), { recursive: true });
    } else {
      const text = fs.readFileSync(file, 'utf8');
      const slug = path.basename(file, '.md');
      writeTicket(wtConfig, key, { content: text, meta: metaFor({ key, type: 'story', title: /^#\s+(.+)$/m.exec(text)?.[1] ?? key, slug, source: null }, text), origin: 'file' });
    }
  }
  // A human's decisions (decisions.md, written by `board fetch`) always follow the issue: a re-run reuses
  // the worktree, so they are refreshed even when its ticket copy is kept.
  if (path.basename(file) === 'story.md') {
    const from = path.join(path.dirname(file), HUMAN_DECISIONS_FILE);
    const to = path.join(path.dirname(target), HUMAN_DECISIONS_FILE);
    if (path.resolve(from) !== path.resolve(to)) {
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
      else fs.rmSync(to, { force: true });
    }
  }
  // The epic's ticket (body and mockups) goes along when the run handed it over (`--epic`, or epic
  // delivery), so the story's mockups-from-the-epic are found in the worktree too.
  const parent = readJson(path.join(path.dirname(file), 'meta.json'), {})?.parent;
  const epicDir = parent ? path.join(path.dirname(path.dirname(file)), parent) : null;
  const handed = (process.env.PIPELINE_STORY_SOURCES ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  if (epicDir && fs.existsSync(epicDir) && handed.includes(path.resolve(epicDir))) {
    const dst = path.join(path.dirname(path.dirname(target)), parent);
    if (!fs.existsSync(dst)) fs.cpSync(epicDir, dst, { recursive: true });
  }
  return { config: wtConfig, story: target, created };
}

function pipeline(worktree, base, args, input = '') {
  // PIPELINE_HEADLESS: the board stage waits for the PR before moving the card to Pending Review.
  const env = { ...process.env, PIPELINE_ROOT: worktree, PIPELINE_BASE_REF: base, PIPELINE_HEADLESS: '1' };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  return run(process.execPath, [PIPELINE_CLI, ...args], { cwd: worktree, input, env });
}

function implementerTask({ key, storyFile, branch, worktree, base, feedback, epicNote = null, decisions = null }) {
  const lines = [
    `Implement story ${key}: ${path.relative(worktree, storyFile)}`,
    '',
    'You are running headless under `pipeline implement`. These instructions override steps 1 and 7 of your workflow:',
    `- The worktree (${worktree}) and branch (${branch}, based on ${base}) already exist and are your working directory. Do not create worktrees, switch branches, push, or open a PR.`,
    '- The pipeline has already been started for this story. Do not run `pipeline start` or `pipeline done`; the runner does that.',
    '- Commit your work with clear messages when you finish. Anything left uncommitted is committed for you.',
    '- Nobody can answer questions during the run. If an Open Question or missing blocker makes the story unimplementable, stop and report `blocked` (the board then asks a human, and the ticket runs again with the answers under "Human decisions"). Otherwise make a reasonable, documented choice and continue.',
    '',
    'End your reply with exactly one line:',
    'AGENT_RESULT: {"status": "done" | "blocked" | "partial", "reason": "<one sentence>", "disputes": [{"finding": "<finding id>", "kind": "nit" | "out-of-scope", "reason": "<the acceptance criterion, owns or mockup that shows why>"}], "followUps": [{"title": "<real problem outside this ticket>", "reason": "<why it matters>"}]}',
  ];
  lines.push(...decisionsBlock(decisions, 'implement'));
  if (epicNote) lines.push('', epicNoteBlock(epicNote));
  if (feedback) lines.push('', 'Address this feedback, then finish again:', '', feedback);
  return lines.join('\n');
}

// A feature verification run that dies is handed to the feature verification stage's own recovery (`pipeline resume`), which resumes it from
// its last round, backs off, and gives up as "crashed" after a few attempts.
async function waitForFv(config, key, { timeoutSec, pollSec, recover }) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSec * 1000;
  let nextRecover = 0;
  for (;;) {
    const a = loadState(config, key).automation;
    if (FV_TERMINAL.has(a.status) && !a.requestedHash) return a;
    const dead = (a.status === 'running' && !isProcessAlive(a.pid, a.boot)) || (a.status === 'starting' && Date.now() - Date.parse(a.requestedAt ?? 0) > config.recovery.startingGraceSec * 1000);
    if (dead && Date.now() >= nextRecover) {
      recover();
      nextRecover = Date.now() + Math.max(pollSec * 1000, 10_000);
    }
    if (a.status === 'idle' && Date.now() - startedAt > 30_000) return { ...a, status: 'not-started' };
    if (Date.now() > deadline) return { ...a, status: 'timed-out' };
    await sleep(pollSec * 1000);
  }
}

// Settings the environment overrides.
export function applyEnv(config) {
  const s = config.implement;
  // Experiments give every arm its own branch names (scripts/pipeline/lib/experiment.mjs).
  if (process.env.IMPLEMENT_BRANCH_PREFIX) s.branchPrefix = process.env.IMPLEMENT_BRANCH_PREFIX;
  s.epic = { ...(s.epic ?? {}) };
  if (process.env.IMPLEMENT_EPIC_BRANCH_PREFIX) s.epic.branchPrefix = process.env.IMPLEMENT_EPIC_BRANCH_PREFIX;
  if (process.env.IMPLEMENT_BUGFIX_BRANCH_PREFIX) s.epic.bugfixPrefix = process.env.IMPLEMENT_BUGFIX_BRANCH_PREFIX;
  if (process.env.IMPLEMENT_WORKTREE_DIR) s.worktreeDir = process.env.IMPLEMENT_WORKTREE_DIR;
  applyResources(config);
  return config;
}

export async function implementStory(config, opts) {
  // The language-server daemons this story starts record it as their run, so a crash leaves orphans that the next
  // lease request reaps (scripts/lsp/lib/common.mjs).
  process.env.PIPELINE_RUN_PID ??= String(process.pid);
  const holder = {};
  try {
    return await implementStoryInner(config, opts, holder);
  } finally {
    if (holder.ctx) await holder.ctx.deps.lsp.stopAll();
    if (holder.wt) await shipMetrics(holder.wt);
  }
}

// Removes what delivered runs recorded they created here (their manifests: [{ worktree, branch, deliveredOn }]), one item at
// a time (prune.mjs removeDelivered, alpha: only with prune.afterDelivery), each checked against the repository the
// delivery pushed to; never a reason for the run to fail. What is kept is logged with why. `retire(item)` is called for
// each item that is gone afterwards, so its record never outlives it.
export async function cleanDelivered(config, { key, items = [] }, { cleanup = pruneRunLocal, retire = () => {} } = {}) {
  if (!items.length) return null;
  let repo = null;
  try {
    repo = String(hostFor(config).sync.repo ?? '') || null;
  } catch {
    // origin must then fetch from where it pushes (prune.mjs remoteHas)
  }
  try {
    const out = await (cleanup ?? pruneRunLocal)(config.mainRoot ?? config.root, (g) => {
      const all = { removed: [], kept: [], gone: [] };
      for (const item of items) {
        const r = removeDelivered(g, { repo, ...item });
        all.removed.push(...r.removed);
        all.kept.push(...r.kept);
        if (!r.kept.length) all.gone.push(item);
      }
      return all;
    }, { label: key, log });
    for (const item of out?.gone ?? []) retire(item);
    return out;
  } catch (error) {
    log(`${key}: local files kept (${String(error?.message ?? error).split('\n')[0]})`);
    return null;
  }
}

// The detached `implement resume` a `--background` resume starts: an explicit --keep goes with it (the batch records it
// too, so every later resume of the batch keeps the run's local state).
export const backgroundResumeArgs = ({ keep = false } = {}) => ['resume', ...(keep ? ['--keep'] : [])];

// At the end of a batch: each ticket delivered in it (done, its PR open and past its CI wait) whose run recorded what it
// created, unless something still builds on its branch: a ticket of the batch that did not deliver, or any saved run
// record not done (a resume reads it), that starts from it or merges it. Those wait for their last consumer.
export async function cleanDeliveredBatch(config, stories, { cleanup } = {}) {
  const delivered = (r) => r?.outcome === 'done' && r.pr && !r.phase;
  const byKey = new Map(stories.map((s) => [s.key, loadRun(config, s.key)]));
  const records = (() => {
    try {
      return fs.readdirSync(runsDir(config)).filter((f) => /^[A-Z][A-Z0-9]*-\d+\.json$/i.test(f)).map((f) => readJson(path.join(runsDir(config), f), null)).filter(Boolean);
    } catch {
      return [];
    }
  })();
  const uses = (x, branch) => x?.base === branch || String(x?.base ?? '') === `origin/${branch}` || (x?.merge ?? []).includes(branch);
  for (const s of stories) {
    const rec = byKey.get(s.key);
    if (s.skip || !delivered(rec) || !rec?.created) continue;
    const consumer = stories.find((o) => o.key !== s.key && uses(o, s.branch) && !delivered(byKey.get(o.key))) ?? records.find((o) => o.key !== s.key && uses(o, s.branch) && !(o.outcome === 'done' && !o.phase));
    if (consumer) {
      log(`${s.key}: local files kept: ${consumer.key} still builds on ${s.branch}`);
      continue;
    }
    await cleanDelivered(config, { key: s.key, items: [rec.created] }, { cleanup, retire: () => saveRun(config, s.key, { created: null }) });
  }
}
// What a killed run leaves behind (council C11: a run killed during its CI wait left its
// language-server daemon running and its worktree's metrics unshipped). For every story the dead run left
// `running`: stop the daemons of its worktree and ship the worktree's metrics. Stack slot leases need nothing (a
// lease whose owner died is stale and reclaimed). Returns what it did.
// A stale lease (its owner died) whose slot still runs a stack: taken down and released (the lease alone would be
// reclaimed, but the containers would keep running until then).
export function staleSlotsCleanup(config) {
  const slots = path.join(INSTALL_ROOT, 'scripts/stack/slots.mjs');
  const teststack = path.join(INSTALL_ROOT, 'scripts/teststack/teststack.mjs');
  let list = [];
  try {
    list = JSON.parse(String(run(process.execPath, [slots, 'list'], { cwd: config.root, timeoutSec: 60 }).stdout ?? '').trim().split('\n').pop()).slots ?? [];
  } catch {
    return [];
  }
  const freed = [];
  // A pool slot whose stack runs with no lease at all (its holder was killed and the lease reclaimed, council C8 proof)
  // is taken down as well; slot 0, a developer's own stack, is never in the pool.
  const running = (project) => Boolean(String(run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`], { timeoutSec: 30 }).stdout ?? '').trim());
  for (const s of list.filter((x) => !x.lease && x.project && running(x.project))) {
    run(process.execPath, [teststack, '--slot', String(s.slot), 'down'], { cwd: config.root, timeoutSec: 600 });
    freed.push(s.slot);
  }
  for (const s of list.filter((x) => x.lease && x.stale)) {
    run(process.execPath, [teststack, '--slot', String(s.slot), 'down'], { cwd: config.root, timeoutSec: 600 });
    run(process.execPath, [slots, 'release', '--slot', String(s.slot), '--force'], { cwd: config.root, timeoutSec: 60 });
    freed.push(s.slot);
  }
  return freed;
}

export async function recoverDeadRun(config, { batch = readJson(batchFile(config), null), lsp = lspAdapter(config), ship = shipMetrics, alive = isProcessAlive, configOf = (w) => applyEnv(loadConfig('implement', w)), slots = staleSlotsCleanup } = {}) {
  if (!batch || batch.finishedAt || alive(batch.pid, batch.boot)) {
    // Stacks nobody holds are taken down whatever the last batch did (council C8 proof: a killed batch's slot stayed up
    // for hours after its lease was reclaimed). A run that is still going holds its slots, so this is safe.
    const freed = batch && !batch.finishedAt && alive(batch.pid, batch.boot) ? [] : slots(config);
    if (freed.length) log(`stack slot(s) ${freed.join(', ')} that no run holds taken down`);
    return { stories: [], slots: freed };
  }
  const done = [];
  for (const f of fs.existsSync(runsDir(config)) ? fs.readdirSync(runsDir(config)).filter((x) => x.endsWith('.json') && !x.endsWith('.result.json')) : []) {
    const r = readJson(path.join(runsDir(config), f), null);
    if (r?.status !== 'running' || !r.worktree || !fs.existsSync(r.worktree)) continue;
    // A story another run's worker is still working on is not this dead run's (dogfood C15: a second run's start stopped
    // the language servers of a live run's story).
    if (r.workerPid && alive(r.workerPid, r.workerBoot)) continue;
    await lsp.stop(r.worktree).catch(() => {});
    let shipped = null;
    try {
      shipped = await ship(configOf(r.worktree));
    } catch {
      /* best effort */
    }
    done.push({ key: r.key, worktree: r.worktree, shipped: shipped?.shipped ?? 0 });
    log(`${r.key}: the interrupted run's worktree cleaned up (language servers stopped, ${shipped?.shipped ?? 0} metrics record(s) shipped)`);
  }
  const freed = slots(config);
  if (freed.length) log(`stack slot(s) ${freed.join(', ')} of the interrupted run taken down and released`);
  return { stories: done, slots: freed };
}

// Ship the story's metrics to the configured store once it ends (done, failed or escalated). The Stop hook
// pushes only what exists when the implementer's session ends; feature verification, the PR check, the
// run outcome and the triage come later and live in the story branch until it merges, so a retro run
// before the merge could not see them (dogfood). Best effort: a store that is down never fails a story.
export async function shipMetrics(wt, pushImpl = sinkPush) {
  try {
    if (sinkSettings(wt).type === 'none') return null;
    const r = await pushImpl(wt);
    if (r?.shipped) log(`metrics: ${r.shipped} record(s) shipped to the ${sinkSettings(wt).type} store`);
    return r;
  } catch (error) {
    log(`metrics: not shipped to the store (${error.message}); \`factory sink push\` in the worktree retries`);
    return null;
  }
}

// The token usage and cost columns of a run record, from a summary (see summarizeUsage in usage.mjs).
export const usageFields = (u) => ({ tokens: u?.tokens?.total ?? null, cost_usd: u?.costUsd ?? null, premium_requests: u?.premiumRequests ?? null, unpriced_runs: u?.unpriced ?? null });

// Leftovers of an interrupted orchestrated run: its subtask worktrees and branches (with their language
// servers). Stack slot leases need nothing: a lease whose owner died is stale and reclaimed.
export async function cleanupSubtasks(config, key) {
  const lsp = lspAdapter(config);
  for (const w of listSubtaskWorktrees(config.root, config.implement.branchPrefix, key)) {
    await lsp.stop(w.path).catch(() => {});
    removeWorktree(config.root, w.path, w.branch);
    log(`${key}: removed ${w.branch} left by the interrupted run`);
  }
}

const lastReviewFindings = (wt, key) => readMetrics(wt, 'arch-reviews.jsonl').filter((r) => r.story === key).at(-1)?.findings ?? [];

// The code on disk is what the story's review approved. The review hook runs with PIPELINE_BASE_REF set
// to the story's base (a group or epic branch in epic delivery), so the hash is taken against that base
// too; against the worktree's default base ref the group's other tickets would always differ.
export function approvedOnDisk(wt, prior, base) {
  if (!prior?.done || prior.review?.lastVerdict !== 'APPROVED') return false;
  const { hash } = implChanges({ ...wt, baseRef: base ?? wt.baseRef });
  return Boolean(hash) && prior.review.approvedHash === hash;
}

async function implementStoryInner(config, opts, holder) {
  const { key, base, branch, worktree, pr } = opts;
  const settings = config.implement;
  const started = Date.now();
  // Epic and bug-group delivery check every ticket once, in the unit's PR check; the Stop hook's
  // per-story background check would run the whole critic panel again for each ticket.
  if (opts.epicBranch) process.env.PR_CHECK_SKIP = '1';
  const metrics = { implementerRuns: 0, reviewBlocks: 0, bugFixCycles: 0, promptVersion: null };
  let ctx = null;
  // Usage of the implementer runs this function starts itself (the orchestrator's integration and fix
  // runs); the planner, pairs and verifiers add up in ctx.metrics.usage.
  let storyUsage = null;
  const extraMetrics = () =>
    ctx
      ? {
          mode: ctx.metrics.mode,
          decisionId: ctx.decisionId,
          subtasks: ctx.plan?.subtasks.length ?? 0,
          agentRuns: ctx.metrics.agentRuns,
          pairRounds: ctx.metrics.pairRounds,
          takeovers: ctx.metrics.takeovers,
          analysisBounces: ctx.metrics.analysisBounces ?? 0,
          analysisFixed: ctx.metrics.analysisFixed ?? 0,
          escalations: ctx.metrics.escalations,
          limitHit: ctx.metrics.limitHit,
          lspCalls: ctx.metrics.lspCalls,
          signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences,
        }
      : {};
  // Disputes and follow-ups the implementer raised against review findings and feature verification bugs (lib/feedback.mjs);
  // the pairs' own follow-ups are in ctx.metrics.followUps.
  const feedbackLog = newFeedbackLog();
  const allFollowUps = () => [...(ctx?.metrics.followUps ?? []), ...feedbackLog.followUps];
  const finish = (outcome, reason = null, extra = {}) => ({ key, outcome, reason, branch, worktree, base, minutes: Math.round((Date.now() - started) / 600) / 100, ...metrics, ...extraMetrics(), ...usageFields(addUsage(ctx?.metrics.usage ?? null, storyUsage)), followUps: allFollowUps(), disputes: feedbackLog.counts(), ...extra });

  // A run interrupted while it waited for its PR's CI continues there, on the PR's branch as it is (council C11).
  const saved = opts.resume ? loadRun(config, key) : null;
  // A resume after the open whose branch a person moved meanwhile: their commits are taken into the checkout and the
  // stages run again on them, with the known PR held first (the reopened route), never only the steps after the open.
  let rerun = false;
  // `ours`: the commit the run itself last pushed or proved; a remote head other than it is a person's push.
  const movedAfterOpen = (where, ours = null) => {
    const taken = takeRemoteHead(worktree, branch);
    if (taken.stop) return { stop: finish('error', `not resumed ${where} of ${saved.pr}: ${taken.stop}`, { pr: saved.pr, resumeStopped: taken.stop }), why: taken.stop };
    if (!taken.moved && !(ours && taken.head !== ours)) return null;
    log(`${key}: ${taken.head.slice(0, 7)} was pushed to ${branch} while the run was stopped: the stages run again on it, with ${saved.pr} held first`);
    opts = carryHeldPr(opts, saved);
    rerun = true;
    return { moved: true };
  };
  // A delivery that pushed but did not reach a PR's CI wait (the branch's CI, or before the open with no rating pending):
  // the remote's head is read first, or nothing runs; a person's push is taken into the checkout, and a PR the earlier
  // run opened (recorded, or found on the host) is held first, so the stages run again on those commits.
  if (fs.existsSync(worktree) && (saved?.phase === 'branch-ci' || (saved?.phase === 'pre-open' && !openPending(saved) && !(saved.pr && saved.opened)))) {
    const where = saved.phase === 'branch-ci' ? 'at the branch CI' : 'before the open';
    const taken = takeRemoteHead(worktree, branch);
    if (taken.stop) {
      log(`${key}: not resumed ${where} of ${branch}: ${taken.stop}; nothing ran`);
      return finish('error', `not resumed ${where} of ${branch}: ${taken.stop}`, { pr: saved.pr ?? null, resumeStopped: taken.stop });
    }
    const ours = (saved.phase === 'branch-ci' ? saved.pushedHead : saved.provenHead) ?? null;
    if (taken.moved || (ours && taken.head !== ours)) {
      const adopted = saved.pr ? null : adoptOpenedPr(applyEnv(loadConfig('implement', worktree)), branch);
      if (adopted) saveRun(config, key, { pr: adopted.pr, opened: true, preOpen: true, openedAt: adopted.openedAt, readyAt: adopted.readyAt, holds: adopted.holds });
      const pr = saved.pr ?? adopted?.pr ?? null;
      log(`${key}: ${taken.head.slice(0, 7)} was pushed to ${branch} while the run was stopped: the stages run again on it${pr ? `, with ${pr} held first` : ''}`);
      if (pr) opts = carryHeldPr(opts, { pr });
      rerun = true;
    }
  }
  if (['ci-wait', 'draft-back'].includes(saved?.phase) && saved.pr && fs.existsSync(worktree)) {
    // The checkout takes what was pushed to the PR meanwhile (or the resume stops); afterOpen confirms a recorded hold on
    // the host again before any fixing agent.
    const m = movedAfterOpen('at the CI wait', saved.deliveredHead ?? null);
    if (m?.stop) {
      log(`${key}: not resumed at the CI wait of ${saved.pr}: ${m.why}; nothing ran`);
      return m.stop;
    }
  }
  if (['ci-wait', 'draft-back'].includes(saved?.phase) && saved.pr && fs.existsSync(worktree) && !rerun) {
    log(`${key}: resuming at the CI wait of ${saved.pr} (the earlier run stopped after the PR opened)`);
    const wtResume = applyEnv(loadConfig('implement', worktree));
    holder.wt = wtResume;
    recordExternalCalls(wtResume, key);
    const base0 = finish('done', null, { pr: saved.pr, resumedAt: saved.phase });
    // Older runs that waited on a PR opened before its CI (no `preOpen`) continue the same way: a failing check puts the PR
    // on hold before any fixing round (they have no ready time to audit).
    return afterOpen(config, wtResume, { ...storyDelivery({ key, branch, worktree, base: saved.base ?? base, isBug: Boolean(saved.bug), issueUrl: saved.issueUrl ?? null }), prUrl: saved.pr, result: base0, readyAt: saved.readyAt ?? null, holds: saved.holds ?? [], ratedDiff: saved.ratedDiff ?? null });
  }
  if (saved?.phase === 'pre-open' && fs.existsSync(worktree) && !rerun) {
    const wtResume = applyEnv(loadConfig('implement', worktree));
    // The code host refused the open earlier, it failed after CI proved the head, or the rating failed (before the open, or
    // on a PR already open and on hold): the delivery runs again from its saved title and body at the step that failed,
    // skipping implementation and review stages (delivery-stage agents such as the analysis fixer, CI fixer, bug triage if
    // no rating was saved for this head, or demo narrator may still run if needed). Checked before the adoption below, which
    // would take a held PR past its rating. Never when the branch moved since CI proved it (a person's commits are reviewed).
    if (openPending(saved)) {
      const moved = headMovedSince(worktree, branch, saved);
      // A head that cannot be read stops the resume where it is (it resumes the same way once the remote answers).
      const stop = (why) => {
        const at = pendingDisposition(saved);
        log(`${key}: not resumed: ${why}; nothing ran, and \`implement resume\` tries again`);
        return finish(at.outcome, `${at.reason ?? ''} (not resumed: ${why})`.trim(), { pr: saved.pr ?? null, resumeStopped: why });
      };
      if (moved?.unreadable) return stop(moved.why);
      if (moved) {
        // A person's commits reach this checkout first, so the stages that run again review them.
        const taken = takeRemoteHead(worktree, branch);
        if (taken.stop) return stop(taken.stop);
        log(`${key}: not resuming at the delivery of ${branch}: ${moved.why}; the stages run again on ${taken.head.slice(0, 7)}${saved.pr ? `, with ${saved.pr} held first` : ''}`);
        // A known PR (on hold, closed by a close-reopen hold) stays this ticket's PR: it is held and confirmed again
        // before any agent runs, and the delivery updates it; never a second PR.
        opts = carryHeldPr(opts, saved);
      } else {
        const held = saved.pr ? confirmRecordedHold(wtResume, saved) : null;
        if (held && !held.ok) return finish('hold-failed', held.reason, { pr: saved.pr });
        const input = readJson(deliveryInputFile(worktree, wtResume, key), null) ?? rebuildDeliveryInput(wtResume, { key, worktree, issueUrl: saved.issueUrl ?? null, followUps: Array.isArray(saved.followUps) ? saved.followUps : [] });
        log(`${key}: resuming the delivery of ${branch}: ${saved.pr ? `${saved.pr} (on hold) was not rated` : 'the PR did not open'} earlier (${String(saved.openRefused?.reason ?? saved.reason ?? '').slice(0, 160)}); skipping implementation and review to ${saved.pr ? 'rate and update it' : 'open'} on the CI-proven head (delivery-stage agents may still run if needed)${input.rebuilt ? ' (its body rebuilt from the run records)' : ''}`);
        holder.wt = wtResume;
        recordExternalCalls(wtResume, key);
        const ticketMeta = readJson(path.join(worktree, setting(wtResume, 'stateDir'), 'board', key, 'meta.json'), {}) ?? {};
        return deliverStory(config, wtResume, { key, branch, worktree, base: saved.base ?? base, baseBranch: String(saved.base ?? base).replace(/^origin\//, ''), title: input.title, body: input.body, result: finish('done', null, { resumedAt: 'open-pending', firstPushAt: saved.firstPushAt ?? null }), isBug: Boolean(saved.bug) || isBugTicket({ key, type: ticketMeta.type }), issueUrl: saved.issueUrl ?? ticketMeta.issue?.url ?? null, questions: [], prcIncomplete: null, resumed: true, ...(saved.pr ? { existingPr: saved.pr, holds: held?.holds ?? saved.holds ?? [], openedAt: saved.openedAt ?? null, readyAt: saved.readyAt ?? null } : {}) });
      }
    } else if (saved.pr && saved.opened && movedAfterOpen('after the open', saved.provenHead ?? null)?.stop) {
      return finish('error', `not resumed after the open of ${saved.pr}: the remote head could not be taken into the checkout`, { pr: saved.pr });
    } else if (saved.pr && saved.opened && !rerun) {
      // The run stopped after its PR opened and was recorded, before the rating was published: it is published now (the
      // rating saved for this head, or a result that needs a person), then the run continues after the open.
      log(`${key}: ${saved.pr} was opened and recorded by the earlier run before it stopped; continuing after the open`);
      holder.wt = wtResume;
      const o = { ...storyDelivery({ key, branch, worktree, base: saved.base ?? base, isBug: Boolean(saved.bug), issueUrl: saved.issueUrl ?? null }), result: finish('done', null, { pr: saved.pr, resumedAt: 'opened' }) };
      const failed = publishRatingOrHold(config, wtResume, o, { prUrl: saved.pr, holds: saved.holds ?? [], openedAt: saved.openedAt ?? null, readyAt: saved.readyAt ?? null, greenAt: saved.greenAt ?? null, provenHead: saved.provenHead ?? null, firstPushAt: saved.firstPushAt ?? null });
      if (failed) return failed;
      saveRun(config, key, { phase: 'ci-wait', pr: saved.pr, preOpen: true, opened: null, deliveredHead: headSha(worktree) });
      return afterOpen(config, wtResume, { ...o, prUrl: saved.pr, readyAt: saved.readyAt ?? null, holds: saved.holds ?? [] });
    } else if (!saved.pr && !rerun) {
      // A run that stopped right after its PR opened, before it recorded the open: the PR is adopted and the run continues
      // after the open, never opening it again and never running agents while it is ready.
      const adopted = adoptOpenedPr(wtResume, branch);
      if (adopted) {
        log(`${key}: ${adopted.pr} was opened by the earlier run before it stopped; continuing after the open`);
        holder.wt = wtResume;
        saveRun(config, key, { pr: adopted.pr, opened: true, preOpen: true, openedAt: adopted.openedAt, readyAt: adopted.readyAt, holds: adopted.holds });
        const o = { ...storyDelivery({ key, branch, worktree, base: saved.base ?? base, isBug: Boolean(saved.bug), issueUrl: saved.issueUrl ?? null }), result: finish('done', null, { pr: adopted.pr, resumedAt: 'pre-open' }) };
        // Never released unrated: the rating is published before the run continues after the open.
        const failed = publishRatingOrHold(config, wtResume, o, { prUrl: adopted.pr, holds: adopted.holds, openedAt: adopted.openedAt, readyAt: adopted.readyAt, greenAt: saved.greenAt ?? null, provenHead: saved.provenHead ?? null, firstPushAt: saved.firstPushAt ?? null });
        if (failed) return failed;
        saveRun(config, key, { phase: 'ci-wait', pr: adopted.pr, preOpen: true, opened: null, openedAt: adopted.openedAt, readyAt: adopted.readyAt, holds: adopted.holds, deliveredHead: headSha(worktree) });
        return afterOpen(config, wtResume, { ...o, prUrl: adopted.pr, readyAt: adopted.readyAt, holds: adopted.holds });
      }
    }
  }
  const prep = prepareWorktree(config, opts);
  if (prep.error) return finish('blocked', prep.error);
  // A reopened ticket whose PR is still open runs on that PR's branch: the PR is put on hold before any agent runs, and
  // the delivery marks it ready again only when CI is green on the new head (owner requirement C18). A resumed run whose
  // PR is already on hold keeps that hold.
  const reopened = opts.reopenedPr && opts.pr ? opts.reopenedPr : null;
  if (reopened) {
    const prior = loadRun(config, key) ?? {};
    // A recorded hold is trusted only once the host confirms it again (a person may have released it).
    const recorded = prior.pr === reopened && (prior.holds ?? []).some((h) => !h.to && h.ok !== false && h.releaseConfirmed !== false) ? confirmRecordedHold(applyEnv(prep.config), prior) : null;
    const kept = recorded?.ok ? prior.holds : null;
    const hold = kept ? null : holdOpenPr(applyEnv(prep.config), reopened, 'the ticket was reopened; agents work on it again');
    if (hold && hold.ok === false) {
      const reason = `could not confirm putting reopened ${reopened} on hold (${hold.mode}); no agent ran (the PR may already be in draft or held on the host — check its state before resuming)`;
      saveRun(config, key, { pr: reopened, preOpen: true, holds: [...(prior.pr === reopened ? prior.holds ?? [] : []), hold], reopenedPr: reopened, readyAt: prior.readyAt ?? null, openedAt: prior.openedAt ?? null, holdFailed: reason });
      return finish('hold-failed', reason);
    }
    const holds = kept ?? [...(prior.pr === reopened ? prior.holds ?? [] : []), hold];
    saveRun(config, key, { pr: reopened, preOpen: true, holds, reopenedPr: reopened, readyAt: prior.readyAt ?? null, openedAt: prior.openedAt ?? null });
    try {
      boardEvent(config.root, key, ['clear-reopened', key]);
    } catch {
      // best effort; the hold is already confirmed
    }
  }
  // The repository's install (dependencies, tools) in a new story worktree, as in a subtask worktree: in self
  // mode the story worktree is where the pair, the review and feature verification run (dogfood step 5: the
  // plan's lint precheck found no node_modules there).
  const prepareCmd = prep.config.implement?.prepareCmd;
  if (prep.created && prepareCmd) {
    const r = run('sh', ['-c', prepareCmd], { cwd: worktree, timeoutSec: setting(prep.config, 'implement.timeoutsSec.checks') });
    log(`${key}: prepareCmd ${r.status === 0 ? 'ran' : `failed (exit ${r.status}); continuing`} in the new worktree`);
  }
  // Epic delivery: the epic design note (written by the epic plan) goes to the orchestrator's plan.
  const epicNote = opts.epicNote && fs.existsSync(opts.epicNote) ? fs.readFileSync(opts.epicNote, 'utf8') : null;
  const wt = applyEnv(prep.config);
  holder.wt = wt;
  recordExternalCalls(wt, key);
  // Resuming a story whose review already approved the code on disk goes straight to feature verification; otherwise the
  // implementer continues from the work left in the worktree.
  const prior = opts.resume ? loadState(wt, key) : null;
  let skipImplementer = approvedOnDisk(wt, prior, base);
  let feedback = null;
  if (skipImplementer) {
    log(`${key}: resuming after the approved review; (re)starting feature verification.`);
    pipeline(worktree, base, ['hook', 'stop'], '{}');
  } else {
    // A resumed story that was already started keeps its review rounds and stage state; `start` would reset them.
    const active = activeStoryFile(wt);
    const alreadyStarted = Boolean(prior) && Boolean(active) && path.basename(path.dirname(active)) === key;
    if (!alreadyStarted) {
      const start = pipeline(worktree, base, ['start', key]);
      if (start.status !== 0) return finish('error', `pipeline start failed: ${tail(start.stderr, 500)}`);
    }
    if (opts.resume) feedback = RESUME_NOTE;
  }

  // A resumed story does not plan again: subtask worktrees, stack slots and language servers of the
  // interrupted run are cleaned up (approved subtasks were already merged into the story branch), and
  // the orchestrator continues the story itself from what is on the branch, like a single implementer.
  // A resumed story keeps its orchestration: it continues with the interrupted run's plan, pairs and verifiers
  // (dogfood C2: a crash-resumed story ran a lone implementer, so it had no verifier pair and no pair record, and the
  // review gate's confidence for it fell to 42).
  // The implement stage's orchestrator always leads: it implements the ticket itself or plans subtasks for pairs.
  const orchestrated = true;
  if (opts.resume) await cleanupSubtasks(wt, key);
  let prCheckReturnsSoFar = [];
  const prCheckReturnsCount = () => prCheckReturnsSoFar.length;
  const recordOutcome = (outcome, reason) => {
    const m = extraMetrics();
    appendJsonl(metricsFile(wt, 'implement-runs.jsonl'), [{ ts: nowIso(), story: key, outcome, implementer_runs: metrics.implementerRuns, review_blocks: metrics.reviewBlocks, bug_fix_cycles: metrics.bugFixCycles, minutes: Math.round((Date.now() - started) / 600) / 100, prompt_version: metrics.promptVersion, ...(ctx ? { mode: m.mode, decision_id: m.decisionId, subtasks: m.subtasks, agent_runs: m.agentRuns, pair_rounds: m.pairRounds, takeovers: m.takeovers, escalations: m.escalations, limit_hit: m.limitHit, analysis_bounces: m.analysisBounces ?? 0, analysis_fixed: m.analysisFixed ?? 0, pr_check_returns: prCheckReturnsCount(), lsp_calls: m.lspCalls, signature_changes_without_references: m.signatureChangesWithoutReferences } : {}), ...usageFields(addUsage(ctx?.metrics.usage ?? null, storyUsage)), ...(resourcesFromEnv() ? { resources: resourcesFromEnv() } : {}), disputes: feedbackLog.counts(), follow_ups: allFollowUps(), ...runTags() }]);
    if (ctx) appendJsonl(metricsFile(wt, OUTCOMES_FILE), [{ ...storyOutcomeRecord({ ts: nowIso(), key, decisionId: ctx.decisionId, mode: ctx.metrics.mode, outcome, reason, wallClockSec: Math.round((Date.now() - started) / 1000), agentRuns: ctx.metrics.agentRuns, reviewBlocks: metrics.reviewBlocks, bugFixCycles: metrics.bugFixCycles, limitHit: ctx.metrics.limitHit, branch, lspCalls: ctx.metrics.lspCalls, signatureChangesWithoutReferences: ctx.metrics.signatureChangesWithoutReferences, usage: addUsage(ctx.metrics.usage, storyUsage), followUps: ctx.metrics.followUps }), ...runTags() }]);
  };
  const recordEscaped = (source, findings, files) => {
    if (!ctx?.plan) return;
    const recs = attributeEscaped({ ts: nowIso(), key, decisionId: ctx.decisionId, subtasks: ctx.plan.subtasks, source, findings, files });
    if (recs.length) appendJsonl(metricsFile(wt, OUTCOMES_FILE), recs.map((r) => ({ ...r, ...runTags() })));
  };
  // A story that stops before the review loop still records (and commits) its metrics.
  const stop = (outcome, reason, extra = {}) => {
    recordOutcome(outcome, reason);
    commitAll(worktree, `${key}: Record implement metrics`, [wt.metricsDir]);
    return { ...finish(outcome, reason, extra), finalSha: headSha(worktree) };
  };

  // Test gaps the pair verifiers handed off (the first pairs and every later-change pair): required cases for the test
  // plan and test automation, handed over once each, before feature verification runs next.
  let requiredFlushed = 0;
  const flushRequiredCases = () => {
    const fresh = ctx?.requiredCases?.slice(requiredFlushed) ?? [];
    if (!fresh.length) return;
    requiredFlushed = ctx.requiredCases.length;
    const file = path.join(worktree, setting(wt, 'stateDir'), 'implement', `${key}-pair-required.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeText(file, JSON.stringify(fresh));
    const r = run(process.execPath, [FV_CLI, 'require', key, `--file=${file}`, '--no-start'], { cwd: worktree, env: { ...process.env, PIPELINE_ROOT: worktree } });
    log(`${key}: ${fresh.length} test gap(s) from the pair verifiers handed to feature verification as required case(s)${r.status === 0 ? '' : ` (fv require exited ${r.status})`}`);
  };
  let skipNextRun = false;
  let integration = null;
  if (orchestrated && !skipImplementer) {
    ctx = createContext({ config: wt, key, storyFile: prep.story, branch, worktree, base, epicNote, resume: Boolean(opts.resume), onProgress: (patch) => saveRun(config, key, patch) });
    holder.ctx = ctx;
    await ctx.deps.lsp.start(worktree, { key });
    const o = await orchestrate(ctx);
    if (!o.ok) return stop(o.outcome, o.reason, { findings: o.findings });
    // Self mode: the verifier already approved the orchestrator's own work, so the review comes next.
    skipNextRun = o.mode === 'self';
    flushRequiredCases();
    // route: pairHandoff (the notes are the findings pairHandoff sent to integration)
    if (o.mode === 'delegate') integration = integrationTask({ key, storyFile: prep.story, branch, worktree, base, plan: o.plan, notes: o.integrationNotes, decisions: ctx.decisions });
  }

  let fv = null;
  let fixingBugs = false;
  let hygieneRounds = 0;
  let answeringReview = false;
  // The review still blocks and the implementer did not resolve it (often it changed nothing, because it holds the
  // finding to be wrong or out of its reach). The story ends unresolved with the blocking findings and the
  // implementer's own reason, so the escalation's questions to a person name the actual decision (dogfood C5:
  // CHK-1 was escalated with no finding and no question).
  const unresolved = (message, reported) => {
    const blocking = lastReviewFindings(wt, key).filter((f) => f.severity !== 'minor').map((f) => `[${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.issue}`.trim());
    const said = [reported?.reason, ...(reported?.disputes ?? []).map((d) => `${d.finding}: ${d.kind}: ${d.reason}`)].filter(Boolean);
    const why = `${message}${said.length ? ` The implementer's last run said: ${said.join('; ')}` : ''}`;
    const findings = [...blocking, ...said.map((x) => `implementer: ${x}`)];
    return ctx ? stop('unresolved', why, { findings }) : finish('unresolved', why, { findings });
  };
  let lintRounds = 0;
  let analysisRounds = 0;
  // Returns to implementation from the PR check (pr-check-return.mjs): each round's upheld production findings go back
  // through the implementation stack. A resumed run continues a return it was in the middle of.
  const back = returnSettings(wt);
  const runRecord = readJson(path.join(runsDir(config), `${key}.json`), {}) ?? {};
  const prCheckReturns = opts.resume && Array.isArray(runRecord.prCheckReturns) ? [...runRecord.prCheckReturns] : [];
  prCheckReturnsSoFar = prCheckReturns;
  let fixingPrCheck = false;
  let checkedPrc = null;
  if (opts.resume && runRecord.phase === 'pr-check-return' && prCheckReturns.length) {
    const last = prCheckReturns.at(-1);
    log(`${key}: resuming return ${prCheckReturns.length} from the PR check (${last.findings.map((f) => f.id).join(', ')})`);
    // Records written before the tests route have no `route`: they went to the implementer.
    const codeItems = last.findings.filter((f) => (f.route ?? 'implementation') === 'implementation');
    if (codeItems.length) {
      skipImplementer = false;
      // The return's fix list is the next implementer run: not skipped (self mode) and not replaced by an integration.
      skipNextRun = false;
      integration = null;
      fixingPrCheck = true;
      // route: routeFindings (pr-check-return.mjs: codeItems are the implementation part)
      feedback = returnTask({ key, findings: codeItems, n: prCheckReturns.length, max: back.maxReturns, round: last.round }) + declarePrCheckFixes(wt, worktree, key, codeItems);
    } else {
      // A test return: its required cases are in feature verification's state; the tests and the PR check run again.
      skipImplementer = true;
      const pc = loadState(wt, key).prCheck;
      if (!['waiting', 'running'].includes(pc.status)) run(process.execPath, [PR_CHECK_CLI, 'recheck', key], { cwd: worktree, env: fixEnv(worktree, base, key), timeoutSec: 120 });
    }
  }
  for (;;) {
    // Implementation and review loop: the review's stop hook blocks with findings until it approves.
    let approved = skipImplementer;
    skipImplementer = false;
    while (!approved) {
      let reported = null;
      if (skipNextRun) {
        skipNextRun = false;
      } else {
        if (metrics.implementerRuns >= settings.maxOrchestratorRuns) return ctx ? stop('unresolved', `still not approved after ${metrics.implementerRuns} implementer runs`) : finish('unresolved', `still not approved after ${metrics.implementerRuns} implementer runs`);
        let left = settings.timeoutsSec.orchestratorFix;
        let release = null;
        if (ctx) {
          try {
            left = Math.min(left, checkBudget(ctx));
          } catch (error) {
            if (error instanceof LimitError) return stop(error.outcome, error.message);
            throw error;
          }
          release = await ctx.deps.acquire(`${key}:implementer`);
          ctx.metrics.agentRuns++;
          ctx.metrics.byRole.orchestrator = (ctx.metrics.byRole.orchestrator ?? 0) + 1;
        }
        metrics.implementerRuns++;
        const before = headSha(worktree);
        const wasIntegration = Boolean(integration);
        const task = integration ?? implementerTask({ key, storyFile: prep.story, branch, worktree, base, feedback, epicNote: ctx ? null : epicNote, decisions: readDecisions(prep.story) });
        integration = null;
        let res;
        try {
          res = runAgent(wt, { name: IMPLEMENTER, task, mode: 'implement', noSubagents: Boolean(ctx), timeoutSec: left, usage: { stage: 'implement', story: key, round: metrics.implementerRuns } });
        } finally {
          release?.();
        }
        storyUsage = addUsage(storyUsage, res.usage);
        metrics.promptVersion = res.version;
        reported = extractResult(res.output);
        // What the run declared it changed for each upheld finding (a review's, a PR check return's) is checked against
        // this run's own diff now, before later runs move the lines (council.mjs sealPendingFixes).
        sealPendingFixes({ cwd: worktree, stateDir: wt.stateDir, root: wt.root ?? worktree, before });
        commitAll(worktree, `${key}: Implementation`);
        // A run answering a blocking review that changed nothing ends the story now: running the review again on the
        // same code only burns a round (dogfood C5).
        if (answeringReview && !codeChangedSince(worktree, before)) {
          reported = extractResult(res.output);
          return unresolved('The architecture review blocks and the implementer\'s run changed nothing.', reported);
        }
        answeringReview = false;
        // Disputes of the findings it was given go to the next review round (or are recorded, for feature verification
        // bugs); follow-ups are collected for the run record.
        feedbackLog.afterRun(wt, key, reported, { round: metrics.implementerRuns });
        const wasFixingBugs = fixingBugs;
        if (fixingBugs) {
          recordEscaped('fv', (fv?.bugs ?? []).map((b) => (typeof b === 'string' ? { issue: b } : b)), filesChanged(worktree, before));
          fixingBugs = false;
        }
        if (reported?.status === 'blocked') return ctx ? stop('blocked', reported.reason ?? 'the implementer reported the story blocked') : finish('blocked', reported.reason ?? 'the implementer reported the story blocked');
        if (!res.ok && !reported) {
          feedback = `The previous run ${res.timedOut ? 'timed out' : `failed (exit ${res.status})`} before finishing. Continue the implementation.`;
          continue;
        }
        if (ctx) {
          // Language server errors in the story's changed files go straight back to the orchestrator.
          const diag = await ctx.deps.lsp.diagnostics(worktree, filesChanged(worktree, ctx.storyBaseSha));
          if (diag.errors.length) {
            feedback = `The language server reports errors in files this story changed. Fix them, then finish again:\n\n${formatDiagnostics({ ...diag, warnings: [] })}`;
            continue;
          }
        }
        // Diff hygiene, checked by the harness after every implementer run (council C2: a feature verification bug-fix
        // run, which no pair verifier sees, reformatted untouched lines of a file and they shipped): hunks this run made
        // that change only whitespace or line breaks go back to it to restore.
        const formatting = formattingOnlyHunks(worktree, before);
        if (formatting.length && hygieneRounds < 2) {
          hygieneRounds++;
          feedback = `Your last run changed only whitespace or line breaks in these places, on lines the change does not otherwise touch. Restore them exactly as they were (the file's own formatting), then finish again:\n${formatting.map((h) => `- ${h.file}: lines ${h.lines}`).join('\n')}`;
          continue;
        }
        // Orchestrated stories: this run changed code after the pair rounds (a review fix, a bug-fix cycle); the verifier
        // pair checks the change before the review sees it.
        if (ctx && codeChangedSince(worktree, before)) {
          const wasPrCheck = fixingPrCheck;
          fixingPrCheck = false;
          const v = await verifyLaterChange(ctx, { base: before, label: `${wasPrCheck ? `pr-check-return-${prCheckReturns.length}` : wasFixingBugs ? 'bug-fix' : wasIntegration ? 'integration' : 'review-fix'}-${metrics.implementerRuns}`, why: wasPrCheck ? 'Fix the production findings the PR check upheld' : wasFixingBugs ? 'Fix the implementation bugs the automated tests found' : wasIntegration ? 'Integrate the merged subtasks' : 'Fix the architecture review findings' });
          if (!v.ok) return stop(v.outcome, v.reason, { findings: v.findings });
          flushRequiredCases();
        }
        // CI's lint (`factory lint --base`) on the lines this story changed, implementation and tests (dogfood C4: CI
        // found whitespace errors in an implementation line nothing had linted).
        const lintErrors = changedLineLint(worktree, base);
        if (lintErrors.length && lintRounds < 2) {
          lintRounds++;
          feedback = `CI's lint reports problems on lines this story changed. Fix exactly these (the repository's formatter and linter rules), then finish again:\n${lintErrors.join('\n')}`;
          continue;
        }
        // Static analysis of the whole story (opt-in, slot story): blocking findings the story introduced go back to the
        // implementer with the analysis fix-loop budget; the report for this commit is what the review and the PR read.
        let storyReport = await reportFor(wt, 'story', { cwd: worktree, base });
        if (storyReport) {
          recordAnalysis(wt, { story: key, stage: 'story', round: analysisRounds + 1, report: storyReport });
          // A secret whose value is already gone from the files but stays in this branch's unpushed commits: the harness
          // folds those commits (same tree, proven) instead of asking an agent for a squash it may not do headless, and
          // scans the new head. Pushed history and shared branches are never rewritten (analysis/history.mjs).
          const secretTools = new Set([...(resolveAnalysis(wt)?.tools.values() ?? [])].filter(isSecretTool).map((t) => t.id));
          const inHistory = storyReport.findings.filter((f) => f.severity === 'blocking' && secretTools.has(f.tool));
          if (inHistory.length) {
            const folded = dropUnpushedSecrets(wt, worktree, inHistory, { branch, base, log });
            if (folded.rewritten) {
              storyReport = await reportFor(wt, 'story', { cwd: worktree, base });
              if (storyReport) recordAnalysis(wt, { story: key, stage: 'story', round: analysisRounds + 1, step: 'after-history-fold', report: storyReport });
            } else log(`${key}: secret finding(s) in history not folded: ${folded.reason}`);
          }
          const blockingTool = (storyReport?.findings ?? []).filter((f) => f.severity === 'blocking');
          if (blockingTool.length && analysisRounds < (resolveAnalysis(wt)?.fixLoop.bounces ?? 0)) {
            analysisRounds++;
            // not-routed: tool findings (static analysis on production files), the harness's own facts, always the code agent's
            feedback = fixTaskText({ ...storyReport, findings: blockingTool }, { bounce: analysisRounds, bounces: resolveAnalysis(wt)?.fixLoop.bounces ?? 0 });
            continue;
          }
        }
      }
      const done = pipeline(worktree, base, ['done', key]);
      if (/\(0 implementation file/.test(done.stdout)) return ctx ? stop('no-changes', reported?.reason ?? 'no implementation files changed') : finish('no-changes', reported?.reason ?? 'the implementer changed no implementation files');
      const stopHook = pipeline(worktree, base, ['hook', 'stop'], '{}');
      let output;
      try {
        output = stopHook.stdout.trim() ? JSON.parse(stopHook.stdout) : null;
      } catch {
        output = null;
      }
      if (output?.decision === 'block') {
        metrics.reviewBlocks++;
        answeringReview = true;
        // route: handOffTestGaps (the review's blocking findings after its hand-off)
        feedback = `${output.reason}${feedbackLog.given('architecture-reviewer', lastReviewFindings(wt, key).filter((f) => f.severity !== 'minor'), { round: metrics.reviewBlocks, config: wt, key })}`;
        recordEscaped('arch-review', lastReviewFindings(wt, key).filter((f) => f.severity !== 'minor'), []);
        continue;
      }
      const review = loadState(wt, key).review;
      if (review.lastVerdict === 'ESCALATED') return ctx ? stop('review-escalated', review.lastReason ?? 'the review did not converge') : finish('review-escalated', review.lastReason ?? 'the review did not converge');
      if (review.lastVerdict !== 'APPROVED') return unresolved(output?.systemMessage ?? `review verdict ${review.lastVerdict ?? 'none'}`, reported);
      approved = true;
    }

    // The review approved this code and feature verification is testing it: the card moves to Testing.
    const approvedHash = loadState(wt, key).review.approvedHash;
    boardEvent(worktree, key, ['event', key, 'testing', ...(approvedHash ? ['--id', `testing:${approvedHash}`] : [])]);
    // feature verification writes and verifies the tests in the background; wait for its verdict.
    // featureVerification.enabled false (or FV_SKIP=1): no tests are written for the ticket, so none are waited for.
    fv = fvEnabled(wt) ? await waitForFv(wt, key, { timeoutSec: ceiling(wt, settings.waitSec.featureVerification), pollSec: settings.pollSec.featureVerification, recover: () => pipeline(worktree, base, ['resume', key]) }) : { status: 'verified', skipped: 'featureVerification.enabled is false' };
    if (fv.status === 'verified' && pr && !opts.epicBranch && !prsDisabled() && back.enabled && prCheckHookOn(worktree)) {
      // The PR check's report round on this head; its upheld production findings return to implementation.
      checkedPrc = await waitForHookPrCheck(wt, key, { ceilingSec: ceiling(wt, settings.waitSec.prCheck), recover: () => run(process.execPath, [PR_CHECK_CLI, 'resume', key], { cwd: worktree, env: fixEnv(worktree, base, key), timeoutSec: 300 }), log, expected: true, startGraceSec: settings.waitSec.prCheckStart, restartStale: () => run(process.execPath, [PR_CHECK_CLI, 'recheck', key], { cwd: worktree, env: fixEnv(worktree, base, key), timeoutSec: 120 }), notHash: prCheckReturns.at(-1)?.findings?.some((f) => (f.route ?? 'implementation') === 'implementation') ? prCheckReturns.at(-1).hash ?? null : null });
      const fixable = checkedPrc?.status === 'done' ? prCheckToFix(wt, checkedPrc, { bug: isBugTicket({ key, type: (readJson(path.join(path.dirname(prep.story), 'meta.json'), {}) ?? {}).type }) }) : [];
      const prCouncil = councilFor(wt, 'prCheck', { subject: key });
      const memberLenses = Object.fromEntries((prCouncil.sole ? [] : prCouncil.members).map((m) => [m.name, m.lens]));
      const routed = routeFindings(fixable, { settings: back, memberLenses, root: worktree });
      const toReturn = [...routed.implementation, ...routed.tests];
      if (toReturn.length) {
        // Returned, nothing addressed (dogfood C23): a finding the last return was sent for comes back. Sent where it
        // cannot be resolved (a test gap to the implementer): re-routed once, without spending a return. Sent to the
        // right place and nothing of what resolves it changed: the story escalates with that reason now.
        const lastReturn = prCheckReturns.at(-1);
        const stale = lastReturn?.head ? unaddressed(toReturn, prCheckReturns, { changed: filesChanged(worktree, lastReturn.head), settings: back, root: worktree }) : [];
        const nothing = stale.filter((x) => x.kind === 'nothing-changed');
        if (nothing.length) {
          appendJsonl(metricsFile(wt, 'pr-check-returns.jsonl'), [{ ts: nowIso(), story: key, kind: 'nothing-addressed', findings: nothing.map((x) => ({ id: x.id, route: x.route, why: x.why })), ...runTags() }]);
          return stop('unresolved', `returned, nothing addressed: ${nothing.map((x) => x.why).join('; ')}`, { findings: nothing.map((f) => `[${f.severity}] ${f.id}: ${f.title} (returned, nothing addressed)`) });
        }
        const rerouted = stale.filter((x) => x.kind === 'wrong-route');
        // The re-route is free once per story; findings of the same new route ride along with it (other test gaps).
        const free = freeReroute(toReturn, rerouted, prCheckReturns);
        const spent = prCheckReturns.filter((e) => !e.free).length;
        const ids = toReturn.map((f) => f.id);
        if (spent >= back.maxReturns && !free) {
          const allCode = toReturn.every((f) => f.route === 'implementation');
          return stop('unresolved', `the PR check still upholds ${ids.length} ${allCode ? 'production ' : ''}finding(s) after ${spent} return(s)${allCode ? ' to implementation' : ''} (prCheck.returnToImplementation.maxReturns ${back.maxReturns}): ${toReturn.map((f) => `${f.id} ${f.title}${allCode ? '' : ` (${f.route === 'tests' ? 'tests' : 'production'})`}`).join('; ')}`, { findings: toReturn.map((f) => `[${f.severity}] ${f.id}: ${f.title}`) });
        }
        // The plan and tests feature verification just verified are kept on the branch before the change goes back.
        commitAll(worktree, `${key}: Test plan and tests verified before the PR check sent the change back`);
        const asEntry = (f) => ({ id: f.id, lens: f.routeLens, severity: f.severity, title: f.title, file: f.file ?? null, fix: f.fix ?? null, reason: f.reason ?? f.detail ?? null, route: f.route, resolves: f.resolves, ...(f.part ? { part: f.part } : {}), routeWhy: f.routeWhy });
        const entry = { n: prCheckReturns.length + 1, at: nowIso(), head: headSha(worktree), hash: checkedPrc.hash ?? null, round: checkedPrc.rounds ?? 1, score: checkedPrc.score ?? null, findings: toReturn.map(asEntry), light: routed.light.map((f) => f.id), ...(free ? { free: true, rerouted: rerouted.map((x) => ({ id: x.id, from: x.sentRoute, to: x.route, why: x.why })) } : {}) };
        prCheckReturns.push(entry);
        prCheckReturnsSoFar = prCheckReturns;
        saveRun(config, key, { phase: 'pr-check-return', prCheckReturns });
        // Test seam: a worker that dies here is resumed by the batch's worker retry (pr-check-return.test.mjs).
        if (process.env.PIPELINE_TEST_DIE_AT === 'pr-check-return' && prCheckReturns.length === 1 && !opts.resume) process.exit(137);
        appendJsonl(metricsFile(wt, 'pr-check-returns.jsonl'), [{ ts: entry.at, story: key, ...entry, ...runTags() }]);
        const label = free ? 're-routed (free)' : `return ${spent + 1} of at most ${back.maxReturns}`;
        boardEvent(worktree, key, ['event', key, 'product-bug', '--id', `pr-check-return:${entry.n}`], { input: JSON.stringify({ bugs: entry.findings.map((f) => `${f.id}: ${f.title}`), cycle: entry.n }) });
        const testItems = entry.findings.filter((f) => f.route === 'tests');
        const codeItems = entry.findings.filter((f) => f.route === 'implementation');
        if (testItems.length) {
          // Test gaps: required cases for the test plan and test automation, with the finding attached; their verifiers
          // cannot approve while one is unmet (feature-verification/lib/required.mjs).
          const file = path.join(worktree, setting(wt, 'stateDir'), 'pr-check', `${key}-required-${entry.n}.json`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          writeText(file, JSON.stringify(testItems.map((f) => ({ id: f.id, source: `pr-check round ${entry.round}`, title: f.title, fix: f.fix, reason: f.reason, head: entry.head }))));
          const rq = run(process.execPath, [FV_CLI, 'require', key, `--file=${file}`, ...(codeItems.length ? ['--no-start'] : [])], { cwd: worktree, env: { ...process.env, PIPELINE_ROOT: worktree } });
          if (rq.status !== 0) return stop('error', `feature verification did not take the required case(s): ${tail(String(rq.stderr || rq.stdout), 400)}`);
          log(`${key}: ${String(rq.stdout).trim()}`);
        }
        if (codeItems.length) {
          log(`${key}: the PR check upheld ${ids.length} finding(s) (${ids.join(', ')}); ${codeItems.map((f) => f.id).join(', ')} back to implementation${testItems.length ? `, ${testItems.map((f) => f.id).join(', ')} to test automation as required cases` : ''} (${label})`);
          fixingPrCheck = true;
          // route: routeFindings (pr-check-return.mjs: codeItems are the implementation part)
          feedback = returnTask({ key, findings: codeItems, n: entry.n, max: back.maxReturns, round: entry.round }) + declarePrCheckFixes(wt, worktree, key, codeItems);
        } else {
          log(`${key}: the PR check upheld ${ids.length} test gap(s) (${ids.join(', ')}); to test automation as required cases (${label})`);
          run(process.execPath, [PR_CHECK_CLI, 'recheck', key], { cwd: worktree, env: fixEnv(worktree, base, key), timeoutSec: 120 });
          // No production change: the implementer and the review do not run; feature verification and the PR check do.
          skipImplementer = true;
        }
        checkedPrc = null;
        continue;
      }
      if (prCheckReturns.length) saveRun(config, key, { phase: null, prCheckReturns });
    }
    if (fv.status !== 'product-bug') break;
    if (metrics.bugFixCycles >= settings.maxBugFixReturns) break;
    metrics.bugFixCycles++;
    // Back to the implementer: the card returns to In Progress with the bugs.
    boardEvent(worktree, key, ['event', key, 'product-bug', ...(fv.finishedAt ? ['--id', `bug:${fv.finishedAt}`] : [])], { input: JSON.stringify({ bugs: fv.bugs ?? [], cycle: metrics.bugFixCycles }) });
    fixingBugs = true;
    // route: routeToRole (feature verification routed the bugs before returning product-bug: routeToRole, productGapsOf)
    feedback = `The automated tests found implementation bugs. Fix the implementation (not the tests):\n${formatBugs(fv.bugs)}${feedbackLog.given('test-automation', normalizeBugs(fv.bugs).map((b) => ({ issue: [b.case, b.reason].filter(Boolean).join(': '), severity: 'blocking' })), { round: metrics.bugFixCycles })}`;
  }

  const outcome = fv.status === 'verified' ? 'done' : `fv-${fv.status}`;
  const fvReason = outcome === 'done' ? null : `Feature verification ended ${fv.status}${fv.bugs?.length ? `: ${fv.bugs.length} bug(s)` : ''}`;
  const fvFindings = outcome === 'done' ? undefined : (fv.bugs ?? []).map((b) => (typeof b === 'string' ? b : b.title ?? b.issue ?? JSON.stringify(b)));
  const result = finish(outcome, fvReason, fvFindings?.length ? { findings: fvFindings } : {});
  recordOutcome(outcome, fvReason);
  // Plans verified before the runner tidied their tables would fail the pre-commit markdownlint.
  run(process.execPath, [FV_CLI, 'tidy', key], { cwd: worktree, env: { ...process.env, PIPELINE_ROOT: worktree } });
  // The message says what feature verification concluded: a plan or tests it did not verify are not "verified".
  commitAll(worktree, outcome === 'done' ? `${key}: Add verified test plan and automated tests` : `${key}: Test plan and tests so far (feature verification ${fv.status}; not verified)`);
  result.finalSha = headSha(worktree);

  // Epic delivery: no PR per story. The epic runner merges the story into the epic branch, publishes
  // the ticket and moves the card to Pending Review (board review --epic-branch) once it has merged.
  if (opts.epicBranch) return result;
  if (pr && outcome === 'done' && !prsDisabled()) {
    const baseBranch = base.replace(/^origin\//, '');
    const title = `${key}: ${fs.readFileSync(prep.story, 'utf8').match(/^#\s+(.+)$/m)?.[1]?.replace(new RegExp(`^${key}[:\\s-]*`), '') ?? key}`;
    const orch = ctx ? `\n- Orchestration: ${ctx.metrics.mode}${ctx.plan?.mode === 'delegate' ? ` (${ctx.plan.subtasks.length} subtasks, ${ctx.metrics.pairRounds} pair rounds, ${ctx.metrics.takeovers} takeover(s))` : ''}, ${ctx.metrics.agentRuns} agent runs` : '';
    const ticketMeta = readJson(path.join(path.dirname(prep.story), 'meta.json'), {}) ?? {};
    const issueUrl = ticketMeta.issue?.url;
    // The PR check the Stop hook started runs in the background (report only): wait for it, so its verdict and
    // open findings are in the PR, not lost behind it (dogfood step 5: the PR opened 3 minutes before it ended).
    const reported = checkedPrc ?? (await waitForHookPrCheck(wt, key, { ceilingSec: ceiling(wt, settings.waitSec.prCheck), recover: () => run(process.execPath, [PR_CHECK_CLI, 'resume', key], { cwd: worktree, env: fixEnv(worktree, base, key), timeoutSec: 300 }), log, expected: prCheckHookOn(worktree), startGraceSec: settings.waitSec.prCheckStart, restartStale: () => run(process.execPath, [PR_CHECK_CLI, 'recheck', key], { cwd: worktree, env: fixEnv(worktree, base, key), timeoutSec: 120 }) }));
    const prcIncomplete = prCheckIncomplete(reported, { enabled: prCheckHookOn(worktree), issues: [Number(String(issueUrl ?? '').match(/\/issues\/(\d+)/)?.[1])].filter(Boolean) });
    if (prcIncomplete) log(`${key}: ${prcIncomplete.reason}; no PR opens (pr-check-incomplete): the branch is pushed and the findings go on the ticket`);
    const prc = fixBeforePr(wt, { key, worktree, base, bug: isBugTicket({ key, type: ticketMeta.type }) }, reported);
    // The ticket as CI will read it: published and fetched back from the board before the parity run (council C4).
    publishTicket(worktree, key);
    boardEvent(worktree, key, ['fetch', key, '--refresh']);
    // What CI runs on the PR, run here first; failures go back through the fixing loop (dogfood C4).
    const parity = settings.ci.parity.enabled === false ? null : parityGate({ cwd: worktree, base, targetArgs: ['--story', key], seedFile: path.join(worktree, setting(wt, 'stateDir'), 'pr-check', `${key}-ci-parity.json`), prCheckCli: PR_CHECK_CLI, env: fixEnv(worktree, base, key), budget: ciFixBudget(settings, { load: () => loadRun(config, key), save: (s) => saveRun(config, key, s) }), log: (m) => log(`${key}: ${m}`) });
    result.finalSha = headSha(worktree);
    const questions = prc?.questions ?? [];
    let body = `${heldBlock(prcIncomplete)}${ownerDecisionBlock(questions)}Implements ${key}${issueUrl ? ` (${issueUrl})` : ''} (generated by \`pipeline implement\`).\n\n- Architecture review: approved\n- Test plan and automated tests: verified\n- ${ctx ? '' : `Implementer runs: ${metrics.implementerRuns}, `}Review rounds blocked: ${metrics.reviewBlocks}, feature verification bug-fix cycles: ${metrics.bugFixCycles}${orch}\n${prCheckSection(prc)}${prCheckReturnsSection(prCheckReturns)}${runConditionsSection(runConditions(wt, [key]), ctx?.deps.lsp.unavailable?.(worktree) ?? [])}${paritySection(parity?.results)}${fullProjectsSection(fullProjectRuns(wt, [key]))}${followUpsSection([...withoutResolved(result.followUps ?? [], [prc]), ...prCheckFollowUps([prc])])}${sideEffectsBlock(prc?.sideEffects)}\nThe demo video of the changed e2e specs (and, for backend changes, an API summary of the endpoints) is added below by the local demo-video step before the PR opens.`;
    // The council's results, when a stage seated one (council.mjs); nothing without a council.
    const councilSection = councilReviewSection(councilRecords(wt, [key]));
    if (councilSection) body = withCouncilReview(body, councilSection);
    // Static analysis (opt-in): tools run, fixed before review, still open, follow-ups; nothing without analysis.
    const analysisSection = prAnalysisSection(wt, [key], { cwd: worktree });
    if (analysisSection) body = withStaticAnalysis(body, analysisSection);
    // Another story's verified plan or tests this change edited are verified again before the push (held-out C14: a
    // feature scoped an existing spec's assertion to the brand section, nothing re-verified that story, and the push was
    // refused after the run said done).
    const others = reverifyEditedStories(wt, { worktree, base, key, timeoutSec: ceiling(wt, settings.waitSec.featureVerification) });
    if (!others.ok) return { ...result, outcome: 'not-delivered', reason: `no PR: ${others.reason}` };
    // The PR opens finished (implement.preOpen, owner requirement C16): CI on the branch, the gate's rating, the video and
    // the whole body first; after the open only deterministic steps, and agent work only while the PR is on hold.
    const held = opts.reopenedPr ? loadRun(config, key) : null;
    return deliverStory(config, wt, { key, branch, worktree, base, baseBranch, title, body, result, isBug: isBugTicket({ key, type: ticketMeta.type }), issueUrl, questions, prcIncomplete, ...(held?.pr ? { existingPr: held.pr, holds: held.holds ?? [], openedAt: held.openedAt ?? null, readyAt: held.readyAt ?? null } : {}) });
  }
  if (outcome === 'done') {
    publishTicket(worktree, key);
    reportToBoard(worktree, key, null);
  }
  return result;
}

// Whether the branch has an open PR on the code host: true, false, or null when the host could not be asked (then a
// history rewrite is never allowed).
function prOpenState(wt, branch) {
  try {
    return hostFor(wt).sync.pr.list({ head: branch, state: 'open', limit: 1 }).length > 0;
  } catch {
    return null;
  }
}

// The push of a folded story branch with a lease on the sha the remote branch had (the PR bot's identity when set up).
async function pushLeaseDefault(wt, { worktree, branch, lease }) {
  return pushFoldedBranch(await prPublisher(wt), { cwd: worktree, branch, lease });
}

// A standalone ticket's delivery settings for deliverFinished / afterOpen.
function storyDelivery({ key, branch, worktree, base, isBug, issueUrl }) {
  return { id: key, keys: [key], label: key, branch, worktree, base, isBug, issues: [Number(String(issueUrl ?? '').match(/\/issues\/(\d+)/)?.[1])].filter(Boolean), targetArgs: ['--story', key], env: fixEnv(worktree, base, key) };
}

// A standalone ticket's PR: delivered by deliverFinished, opened through openStoryPr, reported on its card after the open.
function deliverStory(config, wt, { key, branch, worktree, base, baseBranch, title, body, result, isBug, issueUrl, questions, prcIncomplete, existingPr = null, holds = [], openedAt = null, readyAt = null, resumed = false }) {
  return deliverFinished(config, wt, {
    resumed,
    existingPr,
    holds,
    openedAt,
    readyAt,
    ...storyDelivery({ key, branch, worktree, base, isBug, issueUrl }),
    baseBranch,
    title,
    body,
    result,
    questions,
    prcIncomplete,
    save: (s) => saveRun(config, key, { ...s, ...(s.phase === 'branch-ci' || s.phase === 'pre-open' ? { bug: Boolean(isBug), issueUrl: issueUrl ?? null } : {}) }),
    open: ({ title: t, body: b, draft, onOpened }) => openStoryPr(wt, { worktree, branch, base: baseBranch, title: t, body: b, draft, records: false }, { onOpened }),
    onOpen: (url) => {
      publishTicket(worktree, key);
      reportToBoard(worktree, key, url);
    },
  });
}

// The PR title and body a delivery started from (deliverFinished), kept for a resume after the host refused the open.
export const deliveryInputFile = (worktree, wt, id) => path.join(worktree, setting(wt, 'stateDir'), 'pr-check', `${id}-delivery-input.json`);

// The title and body of a delivery whose input was not saved (a run from before the input was kept), rebuilt from the run
// records: the ticket's heading, the PR check result, run conditions, whole-project runs, follow-ups, behaviour changes,
// the council's rounds and the static analysis. Deterministic; no agent.
export function rebuildDeliveryInput(wt, { key, worktree, issueUrl = null, followUps = [] }) {
  const stateDir = path.join(worktree, setting(wt, 'stateDir'));
  const story = path.join(stateDir, 'board', key, 'story.md');
  const heading = fs.existsSync(story) ? fs.readFileSync(story, 'utf8').match(/^#\s+(.+)$/m)?.[1] : null;
  const title = `${key}: ${heading?.replace(new RegExp(`^${key}[:\\s-]*`), '') ?? key}`;
  const rec = readJson(path.join(stateDir, 'pr-check', key, 'result.json'), null);
  const prc = rec ? { status: 'done', ...rec } : null;
  let body = `Implements ${key}${issueUrl ? ` (${issueUrl})` : ''} (generated by \`pipeline implement\`; this description was rebuilt from the run records when the PR opened on a resume).\n\n- Architecture review: approved\n- Test plan and automated tests: verified\n${prCheckSection(prc)}${runConditionsSection(runConditions(wt, [key]), [])}${fullProjectsSection(fullProjectRuns(wt, [key]))}${followUpsSection([...withoutResolved(followUps ?? [], [prc]), ...prCheckFollowUps([prc])])}${sideEffectsBlock(prc?.sideEffects)}`;
  const councilSection = councilReviewSection(councilRecords(wt, [key]));
  if (councilSection) body = withCouncilReview(body, councilSection);
  return { title, body, rebuilt: true };
}

// A body without the sentence that promises the demo video "below ... once it has recorded them".
export const withoutDemoPromise = (body) => String(body ?? '').replace(/\n*The demo video of the changed e2e specs[^\n]*(?:\n|$)/, '\n');

// The delivery of a finished change: the ONLY path that opens a pipeline PR (a ticket's, a bug-epic group's, a feature
// epic's) or marks one ready (owner requirement C16, extended to epics in C18). Everything agentic happens before the PR
// exists, then the PR opens once in its final state, and after that only deterministic steps run. Order: owner questions
// and an unfinished PR check stay on the ticket (no PR); the branch is pushed and its own CI must be green on that exact
// head (the CI fixing round works against those runs; a base that moved is merged and the new head proven again); the
// review gate rates a bug fix; the demo video and API summary the branch run recorded go into the body; then the PR
// opens, ready. A failure before the open escalates on the tickets with no PR. A CI system that cannot run the pipelines
// on a branch push (no branchPipelines capability) gets a draft PR, marked ready only when its checks are green.
// An already open PR that agents worked on again (a re-delivered or joined epic group) was put on hold first
// (`holdOpenPr`); it is proven the same way, its body refreshed, and marked ready again only when green.
//
// o: { id (run record key), keys (the tickets), auditKeys (every story key whose agent runs count against the PR),
//      label (log prefix), branch, worktree, base, baseBranch, title, body, result, isBug, issues (issue numbers),
//      questions, prcIncomplete, targetArgs, env (the CI fixing round's environment),
//      open({ title, body, draft }) -> { pushed, url, draft, reason }  the host call, made here only
//      onOpen(prUrl, { existing })  board reporting after the open
//      existingPr, holds, openedAt, readyAt  an open PR on hold
//      save(state), load()  the run record (default: the ticket's implement run record)
//      io  injectable effects (deliveryIo) }
export async function deliverFinished(config, wt, o) {
  const { id, keys, label, branch, worktree, base, title, isBug, questions = [], prcIncomplete = null, existingPr = null } = o;
  const result = o.result ?? {};
  const io = { ...deliveryIo(wt), ...(o.io ?? {}) };
  const save = o.save ?? ((s) => saveRun(config, id, s));
  const load = o.load ?? (() => loadRun(config, id));
  // The ticket's CI fixing rounds, one count from the analysis gate to the rounds after the open (ciFixBudget).
  const budget = ciFixBudget(deepMerge(defaultSettings().implement, config.implement ?? {}), { load, save });
  const issues = o.issues ?? [];
  const targetArgs = o.targetArgs ?? ['--stories', keys.join(',')];
  let body = o.body;
  const stateDir = path.join(worktree, setting(wt, 'stateDir'), 'pr-check');
  const holds = [...(o.holds ?? [])];
  // The PR's title and body as the agent stages left them, before the delivery adds its evidence: what `implement resume`
  // delivers again (skipping implementation, review and feature verification) when the open was refused or assessment failed.
  writeJson(deliveryInputFile(worktree, wt, id), { id, title, body: o.body, savedAt: nowIso() });
  // A change that did not finish never gets a PR: the branch is pushed, the findings are on the tickets. An open PR on
  // hold stays on hold for a person.
  const notFinished = (extra, why) => {
    log(`${label}: ${why}; ${existingPr ? `${existingPr} stays on hold` : 'no PR'}: the branch ${branch} is pushed and the findings are on the ticket${keys.length > 1 ? 's' : ''}`);
    if (existingPr) save({ phase: null, pr: existingPr, preOpen: true, holds, readyAt: o.readyAt ?? null });
    return { ...result, ...extra, pr: existingPr, holds, branchPushed: true, phase: null };
  };
  // A file the commit gate held (a new secret on a line it adds) is still uncommitted: the branch is not pushed with the
  // change incomplete, and the value never leaves the machine.
  // CI's analysis jobs, run here with CI's own script on a clean checkout of HEAD before anything is pushed: a blocking
  // finding goes back to the fixing round, a secret only in unpushed commits is folded out, and nothing leaves the
  // machine until the jobs pass (analysis-gate.mjs).
  const heldOf = (w) => (io.held ?? ((x) => heldSecrets(wt, x)))(w);
  const fixEnvOf = () => o.env ?? fixEnv(worktree, base, keys[0]);
  const aGate = (io.analysisGate ?? ((a) => analysisGate(wt, a)))({ cwd: worktree, branch, base, targetArgs, seedFile: path.join(stateDir, `${id}-analysis-gate.json`), prCheckCli: PR_CHECK_CLI, env: fixEnvOf(), budget, keys, held: heldOf, log: (m) => log(`${label}: ${m}`) });
  if (!aGate.ok) {
    const failing = aGate.results.filter((r) => !r.ok);
    const reason = `CI's analysis jobs fail on the head before the push, after the fixing round (${failing.map((r) => r.check).join('; ')}); the branch is not pushed`;
    log(`${label}: ${reason}`);
    return { ...result, outcome: 'blocked', reason, findings: analysisFindings(failing).map((f) => f.title), pr: existingPr, phase: null, analysisGate: { results: aGate.results.map((r) => ({ check: r.check, ok: r.ok })), fixRun: aGate.fixRun ?? null } };
  }
  const held = heldOf(worktree);
  if (held.length) {
    const reason = `a new secret the commit gate held out of the commits is still in the worktree (${held.map((h) => `${h.file}:${h.line ?? '?'} ${h.tool} ${h.rule}`).join('; ')}); the branch is not pushed`;
    log(`${label}: ${reason}`);
    return { ...result, outcome: 'blocked', reason, findings: held.map((h) => `${h.tool} ${h.rule} ${h.file}:${h.line ?? '?'}`), pr: existingPr, phase: null };
  }
  const pushed = await io.push({ worktree, branch, base });
  if (!pushed.pushed) return { ...result, outcome: 'not-delivered', reason: `no PR: ${pushed.reason}`, pr: existingPr };
  // The branch's first push: a resumed delivery keeps the one its first run made.
  const firstPushAt = (o.resumed && result.firstPushAt) || nowIso();
  // Kept in the result on every path from here (a pre-open failure included: held-out C20 lost it).
  result.firstPushAt = firstPushAt;
  for (const k of keys) io.publishTicket(worktree, k);
  // Owner questions are asked on the ticket before any PR exists; an unfinished PR check never opens one.
  if (questions.length) return notFinished(needsDecision(questions), 'it needs an owner decision, asked on the ticket');
  if (prcIncomplete) return notFinished({ outcome: prcIncomplete.outcome, reason: prcIncomplete.reason, findings: prcIncomplete.findings, delivery: prcIncomplete }, prcIncomplete.reason);
  save({ phase: 'branch-ci', branch, worktree, base, firstPushAt, pushedHead: headSha(worktree), ...(existingPr ? { pr: existingPr, holds, preOpen: true } : {}) });
  const proof = await proveBeforeOpen(wt, { label, stories: keys, branch, worktree, base, issues, targetArgs, prCheckCli: PR_CHECK_CLI, env: fixEnvOf(), stateDir, repo: io.repo(), sync: () => io.push({ worktree, branch, base, commitRecords: false }), log, budget, gate: io.gate,
    // A red branch CI after its fixing round: the analysis jobs run here on the same head, and the secret decision table's
    // way out is taken (a fixing round for what is still in the files; the fold of the story's own branch with no PR for a
    // fake value in its pushed history); anything else escalates as before.
    remedy: (ci, spend = {}) => (io.remedy ?? ((a) => remedyRedBranch(wt, a)))({ ...spend, worktree, branch, base, ci, prOpen: existingPr ? true : io.prOpen(branch), keys, targetArgs, seedFile: path.join(stateDir, `${id}-branch-remedy.json`), prCheckCli: PR_CHECK_CLI, env: fixEnvOf(), push: () => io.push({ worktree, branch, base, commitRecords: false }), pushLease: (lease) => (io.pushLease ?? ((a) => pushLeaseDefault(wt, a)))({ worktree, branch, lease }), log: (m) => log(`${label}: ${m}`) }) });
  const { branchCi, draftFirst } = proof;
  if (proof.syncFailed) return { ...result, outcome: 'not-delivered', reason: `no PR: ${proof.syncFailed}`, pr: existingPr };
  if (proof.delivery) return notFinished({ outcome: proof.delivery.outcome, reason: `before its PR: ${proof.delivery.reason}`, findings: proof.delivery.findings, delivery: proof.delivery }, `its CI on the branch is not green (${proof.delivery.reason})`);
  const greenAt = nowIso();
  // The head CI proved: a resume continues from here only while the branch is still at it (headMovedSince).
  const provenHead = headSha(worktree);
  const onHold = existingPr ? { pr: existingPr, holds, preOpen: true, openedAt: o.openedAt ?? null, readyAt: o.readyAt ?? null } : {};
  save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, bug: Boolean(isBug), ...onHold });
  // The review gate's rating of a bug fix, guaranteed before the PR opens (the gate's only model call); published at open
  // without starting any agent. If the active gate cannot produce an assessment here, stop before opening the PR.
  const assessFile = path.join(stateDir, `${id}-gate-assessment.json`);
  // A resumed delivery reuses the saved rating only when it was made for this head (a rating repeated can come out
  // different and change whether the PR merges itself); otherwise io.assess runs before the PR opens.
  let assessment = null;
  let gateSkipped = false;
  if (isBug) {
    const saved = o.resumed && fs.existsSync(assessFile) ? readJson(assessFile, null) : null;
    const savedAssessment = saved?.headSha && saved.headSha === provenHead ? saved : null;
    if (saved && !savedAssessment) log(`${label}: the saved rating is for ${String(saved.headSha ?? 'an unrecorded head').slice(0, 7)}, not ${provenHead.slice(0, 7)}; rating this head`);
    const assessed = savedAssessment ?? io.assess({ worktree, keys, base, out: assessFile });
    if (assessed?.skipped) gateSkipped = true;
    else if (!assessed) {
      const reason = `the review gate could not produce a bug-triage assessment before the PR ${existingPr ? 'was updated' : 'opened'}; ${existingPr ? `${existingPr} stays on hold` : 'no PR opened'} (no agent may run after open), and \`implement resume\` rates it again on this head`;
      log(`${label}: ${reason}`);
      // The resume point stays at the rating, with an open PR on hold when there is one: no agent stage runs again.
      save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, bug: true, ...onHold });
      return { ...result, outcome: 'gate-assessment-failed', reason, findings: [{ id: 'GATE-ASSESS-FAILED', severity: 'major', title: 'Review gate pre-open assessment failed', detail: reason }], pr: existingPr, holds, branchPushed: true, phase: 'pre-open', greenAt, provenHead, bug: true };
    } else assessment = assessed;
  }
  // The body, whole: CI evidence, the gate's assessment, the demo video and the API summary of the branch run. The
  // records name the head the PR opens on (council C11, Sol 3).
  const head = headSha(worktree);
  result.finalSha = head;
  // The delivered head's own scan (the PR check's tools; deterministic, no agent): later commits (tests, plans, a CI fix,
  // the base merge) leave the earlier scans describing other trees. A head already scanned by any slot is not scanned again.
  await io.analyse({ worktree, base, keys });
  const analysisNow = prAnalysisSection(wt, o.auditKeys ?? keys, { cwd: worktree, head, base });
  if (analysisNow) body = withStaticAnalysis(body, analysisNow);
  // The demo video, produced here on this machine (never in CI), after every agent stage and the CI proof: recorded in
  // demo mode, narrated, rendered, checked for secrets, and stored for this head; the body below embeds it once.
  // Deterministic and never a reason to hold the delivery: a failure is a note in the section. The one exception is a
  // setting: a UI bug whose reproduction could not be shown before the fix (video.bugPair.requireBefore) opens no PR.
  // A resume skips recording and narration when this very commit's step finished (nothing it blocked on) and its media
  // is stored.
  const videoFile = path.join(stateDir, `${id}-demo-video.json`);
  const lastVideo = o.resumed ? readJson(videoFile, null) : null;
  let media = lastVideo?.head === head && lastVideo.exit === 0 && !lastVideo.block ? io.media({ folder: keyFolder(branch), head }) : null;
  if (media?.video || media?.api) log(`${label}: the demo media of ${head.slice(0, 7)} is stored already; not recorded or narrated again`);
  else {
    const video = io.demoVideo ? await io.demoVideo({ worktree, base, branch, head, keys, out: videoFile }) : null;
    if (video?.block) return notFinished({ outcome: 'demo-video-blocked', reason: video.block, findings: video.findings ?? [] }, video.block);
    media = io.media({ folder: keyFolder(branch), head });
  }
  // The video and API summary are embedded below from the branch run: the sentence promising them later goes.
  body = withoutDemoPromise(body);
  const ciEvidence = branchCi?.state === 'success'
    ? `- CI before this PR: every pipeline a push of \`${branch}\` runs passed on ${head.slice(0, 7)} (${branchCi.names?.join(', ') || 'none'})${branchCi.rounds ? `, after ${branchCi.rounds} CI fixing round(s) on the branch` : ''}; the PR's own runs of them reuse those runs. Only on the PR: ${branchCi.prOnly?.length ? branchCi.prOnly.join(', ') : 'nothing'}.`
    : `- CI before this PR: not proven on the branch (${draftFirst ? 'no pipeline runs on a branch push here' : 'the CI wait is off'}); the PR ${draftFirst ? 'opens as a draft and is marked ready when its checks are green' : 'opens without it'}.`;
  const gateLine = analysisGateSection(aGate);
  const evidence = `${ciEvidence}${gateLine ? `\n${gateLine}` : ''}${assessment ? `\n${assessedLine(assessment)}` : ''}`;
  // A re-delivered PR's body carries the evidence of its last delivery: replaced, not repeated.
  body = body.split('\n').filter((l) => !/^- (CI before this PR|CI's analysis jobs before the push|Review gate, assessed before this PR opened):/.test(l)).join('\n').replace(/^\n+/, '');
  const anchor = '\n- Test plan and automated tests: verified';
  body = body.includes(anchor) ? body.replace(anchor, `${anchor}\n${evidence}`) : `${evidence}\n\n${body}`;
  if (media.video) body += `\n\n${VIDEO_SECTION_START}\n${media.video}\n${VIDEO_SECTION_END}`;
  if (media.api) body += `\n\n<!-- pr-api-summary:start -->\n${media.api}\n<!-- pr-api-summary:end -->`;
  if (media.notes?.length && (media.video || media.api || branchCi?.state === 'success')) body += `\n\n<sub>Demo video and API summary: ${media.notes.join('; ')}.</sub>`;
  save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, ...onHold });
  let prUrl;
  let openedAt;
  let readyAt;
  if (existingPr) {
    // The PR exists and is on hold: its body is refreshed now; it is marked ready again by afterOpen once green.
    prUrl = existingPr;
    io.updateBody(prUrl, body);
    recordHeadActivity(wt, prUrl, head, 'synchronize');
    openedAt = o.openedAt ?? null;
    readyAt = o.readyAt ?? null;
  } else {
    // The PR opens finished: once, on the head CI proved, with its whole body. A bug fix opens held (a draft, else
    // labelled) until its rating is published: never ready before it.
    const holdAtOpen = draftFirst || (isBug && !gateSkipped);
    const holdWhy = draftFirst ? 'its checks run only once the PR exists' : 'its review gate rating is published first';
    // Recorded the moment the host returns the PR, before any follow-up call (the left-out text's comments, metrics):
    // a run that stops from there resumes after the open, never opening it again.
    // A PR asked to open as a draft is recorded with that hold, not yet confirmed (the host's answer says whether it is a
    // draft), so a resume from here releases it too and never takes the PR for one that was never held.
    const recordOpen = (url) => {
      const at = nowIso();
      save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, pr: url, opened: true, preOpen: true, openedAt: at, readyAt: null, holds: holdAtOpen ? [{ mode: 'draft', label: preOpenSettings(wt).wipLabel, ok: false, from: at, why: holdWhy }] : [], bug: Boolean(isBug) });
    };
    const opened = await o.open({ title, body, draft: holdAtOpen, onOpened: recordOpen });
    if (opened.refused) {
      // Every implementation/review stage is done and CI proved this head: the delivery is kept, not lost. The record stays
      // at pre-open with the refusal, and `implement resume` retries delivery on this head (delivery-stage agents may still run if needed).
      const refusal = { at: nowIso(), head, attempts: opened.attempts ?? [], records: opened.records ?? null, reason: opened.reason };
      save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, openRefused: refusal, ...onHold });
      appendJsonl(metricsFile(wt, RUN_CONDITIONS_FILE), [{ ts: nowIso(), story: keys[0], ...(keys.length > 1 ? { stories: keys } : {}), kind: 'host-refusal', what: 'pr-open', head, accepted: false, attempts: refusal.attempts.length }]);
      log(`${label}: ${opened.reason}; the branch ${branch} stays pushed and CI-proven on ${head.slice(0, 7)}: \`implement resume\` retries opening the PR`);
      return { ...result, outcome: 'pr-refused', reason: `no PR: ${opened.reason}; the CI-proven head ${head.slice(0, 7)} is kept and \`implement resume\` retries opening the PR without re-running implementation or review (delivery-stage agents may still run if needed)`, pr: null, finalSha: head, greenAt, openRefused: refusal };
    }
    if (!opened.pushed || !opened.url) return { ...result, outcome: 'not-delivered', reason: `no PR: ${opened.reason}` };
    prUrl = opened.url;
    openedAt = nowIso();
    if (opened.reduced) {
      appendJsonl(metricsFile(wt, RUN_CONDITIONS_FILE), [{ ts: nowIso(), story: keys[0], ...(keys.length > 1 ? { stories: keys } : {}), kind: 'host-refusal', what: 'pr-open', head, accepted: true, pr: opened.url, attempts: opened.reduced.attempts.length, dropped: opened.reduced.dropped, comments: (opened.reduced.comments ?? []).map((c) => `${c.id}:${c.outcome}`) }]);
      log(`${label}: the code host refused the PR's full text; it opened with a shorter body (without ${opened.reduced.dropped.join(', ')}); the full text is in ${opened.reduced.records}`);
    }
    // Recorded at once: a run that stops from here on resumes after the open (its rating published first), never opening
    // the PR again and never releasing it unrated.
    save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, pr: prUrl, opened: true, preOpen: true, openedAt, readyAt: null, holds: holdAtOpen && opened.draft ? [{ mode: 'draft', label: preOpenSettings(wt).wipLabel, ok: true, from: openedAt, why: holdWhy }] : [], bug: Boolean(isBug) });
    if (process.env.PIPELINE_TEST_DIE_AT === 'after-pr-open') process.exit(137);
    recordHeadActivity(wt, prUrl, headSha(worktree), 'opened', { at: openedAt });
    if (holdAtOpen) {
      const wipLabel = preOpenSettings(wt).wipLabel;
      const draftConfirmed = opened.draft && (io.confirmHold ? io.confirmHold(prUrl, { mode: 'draft', label: wipLabel }) !== false : true);
      if (draftConfirmed) {
        holds.push({ mode: 'draft', label: wipLabel, ok: true, from: openedAt, why: holdWhy });
      } else {
        const why = holdWhy;
        // A draft the host may have applied without confirming it: recorded (not trusted), so afterOpen releases it too.
        if (opened.draft) holds.push({ mode: 'draft', label: wipLabel, ok: false, from: openedAt, why });
        let h;
        try {
          h = io.hold(prUrl, { mode: 'label', why, at: openedAt });
        } catch (error) {
          h = { mode: 'label', label: wipLabel, ok: false, from: openedAt, why, error: String(error?.message ?? error) };
        }
        const ok = Boolean(h && h.ok !== false);
        holds.push({ ...(h && typeof h === 'object' ? h : { mode: 'label', label: wipLabel, from: openedAt, why }), ok });
      }
    }
    readyAt = holdAtOpen && holds.at(-1)?.ok !== false ? null : openedAt;
  }
  await o.onOpen?.(prUrl, { existing: Boolean(existingPr) });
  let ratedDiff = null;
  if (isBug && !gateSkipped) {
    const failed = publishRatingOrHold(config, wt, { ...o, io, save, result }, { prUrl, holds, openedAt, readyAt, greenAt, provenHead, firstPushAt, assessment });
    if (failed) return failed;
    ratedDiff = localDiffKey(worktree, base);
  }
  save({ phase: 'ci-wait', opened: null, pr: prUrl, branch, worktree, base, deliveredHead: headSha(worktree), bug: Boolean(isBug), issues, questions: [], prCheckIncomplete: null, preOpen: true, firstPushAt, greenAt, openedAt, readyAt, holds, branchCi: branchCi ? { state: branchCi.state, head: branchCi.head ?? head, pipelines: branchCi.names ?? [], prOnly: branchCi.prOnly ?? [], rounds: branchCi.rounds ?? 0 } : null });
  return afterOpen(config, wt, { ...o, io, save, load, issues, targetArgs, prUrl, result: { ...result, firstPushAt, greenAt, openedAt }, readyAt, holds, ratedDiff: gateSkipped ? localDiffKey(worktree, base) : ratedDiff, openedAt, greenAt, provenHead, firstPushAt });
}

// A PR found open for a branch whose run stopped between the open and its record (a crash right after `pr create`): it is
// adopted, never opened again and never worked on by agents while ready. Null when none.
export function adoptOpenedPr(wt, branch, { io = deliveryIo(wt) } = {}) {
  const found = io.findOpenPr(branch);
  if (!found?.url) return null;
  return { pr: found.url, openedAt: found.createdAt ?? nowIso(), readyAt: found.draft ? null : found.createdAt ?? nowIso(), holds: found.draft ? [{ mode: 'draft', from: found.createdAt ?? nowIso(), why: 'opened as a draft' }] : [] };
}

// The review gate's rating published on an open bug PR before anything can release it. Publishing again is harmless
// (the gate edits its one comment and its labels): the rating saved for this very head, or, with none, an unassessed
// result that needs a person (--no-agent). If publication fails, the PR is held for a person (or stays held) and the
// delivery stops at a point a resume publishes again: a bug PR is never released without its rating or a review state.
// Returns null when published (or the gate is off), else the run's result.
export function publishRatingOrHold(config, wt, o, { prUrl, holds = [], openedAt = null, readyAt = null, greenAt = null, provenHead = null, firstPushAt = null, assessment = null }) {
  const { id, keys, label, branch, worktree, base } = o;
  const io = { ...deliveryIo(wt), ...(o.io ?? {}) };
  const save = o.save ?? ((s) => saveRun(config, id, s));
  if (!o.isBug) return null;
  const head = headSha(worktree);
  const assessFile = path.join(worktree, setting(wt, 'stateDir'), 'pr-check', `${id}-gate-assessment.json`);
  const rating = readJson(assessFile, null);
  let r;
  try {
    // Only a rating made for this very head is published (the gate checks it against the PR's head again); otherwise a
    // result that needs a person.
    r = io.publishGate({ worktree, pr: prUrl, keys, base, assessment: (assessment ?? rating)?.headSha && (assessment ?? rating).headSha === head ? assessFile : null, noAgent: true });
  } catch (error) {
    r = { status: 1, stderr: String(error?.message ?? error) };
  }
  if (!(r && typeof r === 'object' && r.status != null && r.status !== 0)) {
    recordHeadActivity(wt, prUrl, head, 'labeled');
    // The change the host shows a rating for (its diff key; the pipeline's base merges keep it): the only change a release
    // may happen on (afterOpen).
    const ratedDiff = localDiffKey(worktree, base);
    save({ ratedHead: head, ratedDiff });
    o.ratedHead = head;
    o.ratedDiff = ratedDiff;
    return null;
  }
  const all = [...holds];
  if (!all.some((h) => !h.to && h.ok !== false)) all.push(holdOpenPr(wt, prUrl, "the review gate's rating could not be published", { io }));
  const heldNow = all.some((h) => !h.to && h.ok !== false);
  const reason = `the review gate's rating could not be published on ${prUrl} (${String(r.stderr ?? r.stdout ?? '').trim().split('\n').at(-1) || `exit ${r.status}`}); ${heldNow ? 'it stays on hold for a person, and `implement resume` publishes it again' : 'and it could not be put on hold: check its state before resuming'}`;
  log(`${label}: ${reason}`);
  save({ phase: 'pre-open', branch, worktree, base, firstPushAt, greenAt, provenHead, pr: prUrl, opened: null, preOpen: true, openedAt, readyAt, holds: all, bug: true });
  return { ...(o.result ?? {}), outcome: heldNow ? 'gate-assessment-failed' : 'hold-failed', reason, findings: [{ id: 'GATE-PUBLISH-FAILED', severity: 'major', title: 'Review gate rating not published on the open PR', detail: reason }], pr: prUrl, holds: all, phase: 'pre-open', greenAt, provenHead, bug: true };
}

// A resume whose branch moved runs the stages again; its known PR (on hold, or closed by a close-reopen hold) stays the
// ticket's PR: routed as a reopened PR, held and confirmed before any agent, updated by the delivery, never a second one.
export const carryHeldPr = (opts, saved) => (saved?.pr ? { ...opts, pr: true, reopenedPr: saved.pr, fromRemote: true } : opts);

// A recorded hold confirmed again on the host before agents work on its PR: { ok, holds, reason }.
export function confirmRecordedHold(wt, rec, { io = deliveryIo(wt) } = {}) {
  const open = (rec.holds ?? []).filter((h) => !h.to && h.ok !== false);
  const last = open.at(-1);
  if (!last) return { ok: false, holds: rec.holds ?? [], reason: `${rec.pr} has no recorded hold to confirm` };
  let ok;
  try {
    ok = io.confirmHold ? io.confirmHold(rec.pr, { mode: last.mode, label: last.label }) !== false : false;
  } catch {
    ok = false;
  }
  return ok ? { ok, holds: rec.holds } : { ok, holds: rec.holds, reason: `the recorded hold of ${rec.pr} (${last.mode}) is not confirmed on the host (a person may have released it); no agent ran` };
}

// An open PR that agents are about to work on again (a re-delivered or joined epic group, a resumed run that must do agent
// work): it is put on hold first, so no agent runs while it is ready. Always returns a hold record with an explicit boolean
// `ok` (false when the host call threw or could not confirm the hold); callers must stop before starting agents when `!ok`.
export function holdOpenPr(wt, pr, why, { io = deliveryIo(wt) } = {}) {
  const mode = preOpenSettings(wt).afterOpen;
  const label = preOpenSettings(wt).wipLabel;
  let h;
  try {
    h = io.hold(pr, { mode, why });
  } catch (error) {
    h = { mode, label, ok: false, from: nowIso(), why, error: String(error?.message ?? error) };
  }
  const ok = Boolean(h && h.ok !== false);
  const rec = { ...(h && typeof h === 'object' ? h : { mode, label, from: nowIso(), why }), ok };
  log(ok ? `${pr} is on hold (${rec.mode}) while agents work on it: ${why}` : `could not confirm putting ${pr} on hold (${rec.mode}): ${why}`);
  return rec;
}

// The effects the delivery has on the outside (the branch push, the CI gate, the host's PR, the gate's rating, the board),
// one place, injectable for fixture tests.
// Whether the repository wants demo videos (features.demoVideo in .factory/factory.json).
function demoVideoOn(worktree) {
  return readJson(path.join(worktree, '.factory/factory.json'), {})?.features?.demoVideo === true;
}

export function deliveryIo(wt) {
  const host = () => hostFor(wt).sync;
  const po = () => preOpenSettings(wt);
  return {
    push: ({ worktree, branch, base, commitRecords = true }) => pushStoryBranch(wt, { worktree, branch, base }, commitRecords ? {} : { commitRecords: () => {} }),
    repo: () => String(host().repo ?? '') || null,
    gate: (opts) => ciGate(opts),
    publishTicket: (worktree, key) => publishTicket(worktree, key),
    assess: ({ worktree, keys, base, out }) => reviewGateAssess(worktree, { keys, base, out }),
    publishGate: ({ worktree, pr, keys, base, assessment }) => reviewGatePublish(worktree, { pr, keys, base, assessment }),
    regate: ({ worktree, pr, args }) => run(process.execPath, [path.join(INSTALL_ROOT, 'scripts/review-gate/review-gate.mjs'), 'regate', '--pr', pr, ...args], { cwd: worktree, timeoutSec: 600 }),
    analyse: async ({ worktree, base, keys }) => {
      try {
        const report = await reportFor(wt, 'prCheck', { cwd: worktree, base, by: 'delivery' });
        if (report?.by === 'delivery') recordAnalysis(wt, { story: keys[0], stage: 'delivery', round: 1, report });
      } catch (error) {
        log(`static analysis of the delivered head not run: ${error.message}`);
      }
    },
    media: ({ folder, head }) => preOpenMedia(host(), { folder, head, storageBranch: setting(wt, 'prVideo.storageBranch') }),
    demoVideo: async ({ worktree, base, branch, head, out }) => {
      if (!demoVideoOn(worktree)) return null;
      // The step writes its outcome (or the error that stopped it) to a file of its own: never read from a log line.
      const resultFile = `${out}.result`;
      fs.rmSync(resultFile, { force: true });
      const r = await runAsync(process.execPath, [path.join(INSTALL_ROOT, 'scripts/pr-video/pr-video.mjs'), 'local', '--base', base, '--key', branch, '--head-sha', head, '--result', resultFile], { cwd: worktree, timeoutSec: Number(setting(wt, 'prVideo.localTimeoutSec')) });
      const record = stepRecord(r, readJson(resultFile, null));
      fs.rmSync(resultFile, { force: true });
      writeJson(out, { at: nowIso(), head, ...record });
      if (r.status !== 0) log(`${branch}: the local demo video step failed (exit ${r.status}): ${record.error}; the PR opens without a video section`);
      return r.status === 0 ? record : null;
    },
    updateBody: (pr, body) => {
      try {
        host().pr.update(pr, { body });
      } catch {
        // the body stays as it was; the PR is fine
      }
    },
    hold: (pr, { mode = po().afterOpen, why, at } = {}) => holdPr(host(), pr, { mode, label: po().wipLabel, why, at }),
    confirmHold: (pr, { mode = po().afterOpen, label = po().wipLabel } = {}) => confirmPrState(host(), pr, { mode, label, held: true }),
    release: (pr, { mode, label }) => releasePr(host(), pr, { mode, label }),
    ownsPr: (pr) => host().ownsPr?.(pr) !== false,
    // The PR's own change as the host has it now (its diff key), or null when it cannot be read.
    prDiffKey: (pr) => {
      try {
        const h = host();
        const v = h.pr.get(pr);
        return liveDiffKey({ cwd: wt.root, base: v?.base, head: v?.headSha, host: h, pr });
      } catch {
        return null;
      }
    },
    // Whether the branch has an open PR (true, false, or null when the host could not be asked).
    prOpen: (branch) => prOpenState(wt, branch),
    findOpenPr: (branch) => {
      try {
        const [p] = host().pr.list({ head: branch, state: 'open', limit: 1 }) ?? [];
        return p ? { url: p.url, createdAt: p.createdAt ?? null, draft: Boolean(p.isDraft ?? p.draft) } : null;
      } catch {
        return null;
      }
    },
    stateDecision: (pr, decision) => stateDecisionInBody(wt, pr, decision),
    prBody: (pr) => {
      try {
        return host().pr.get(pr)?.body ?? null;
      } catch {
        return null;
      }
    },
    usage: () => readMetricsLocal(wt, USAGE_FILE),
  };
}

// After the PR opened: deterministic steps only. The PR's checks are waited for (no fixing agent); a check that fails now
// (one only a PR runs, or the base moved) puts the PR on hold first (draft, the work-in-progress label, or closed), then
// the CI fixing round works on the branch, and the PR is marked ready again only when every expected check is green on
// its head. `implement resume` and a re-run epic continue here (phases ci-wait and draft-back).
export async function afterOpen(config, wt, o) {
  const { id, keys, label, prUrl, branch, worktree, base, isBug, result } = o;
  const io = o.io ?? deliveryIo(wt);
  const save = o.save ?? ((s) => saveRun(config, id, s));
  const load = o.load ?? (() => loadRun(config, id));
  const issues = o.issues ?? [];
  const targetArgs = o.targetArgs ?? ['--stories', keys.join(',')];
  const po = preOpenSettings(wt);
  const settings = deepMerge(defaultSettings().implement, config.implement ?? {});
  const holds = o.holds ?? [];
  let readyAt = o.readyAt ?? null;
  const repo = io.repo();
  const common = { config: wt, ciOptions: { ciSettings: settings.reviewGate?.ci ?? {}, activities: (h) => headActivities(wt, prUrl, h) }, repo, pr: prUrl, branch, cwd: worktree, prCheckCli: PR_CHECK_CLI, targetArgs, base, env: o.env ?? fixEnv(worktree, base, keys[0]), seedFile: path.join(worktree, setting(wt, 'stateDir'), 'pr-check', `${id}-ci-fix.json`), log: (m) => log(`${label}: ${m}`), timeoutSec: settings.ci.wait.timeoutSec, pollSec: settings.ci.wait.pollSec, settleSec: settings.ci.wait.settleSec };
  // `deliveredHead`: what the run itself pushed last (a resume compares the remote's head with it).
  const saveWait = (extra = {}) => save({ phase: 'ci-wait', pr: prUrl, preOpen: true, readyAt, holds, deliveredHead: headSha(worktree), ...extra });
  // Held for a fixing round only when the last hold was confirmed and its release was not attempted: a hold whose release
  // is unconfirmed may already be ready on the host, so it is held (and confirmed) again first.
  const held = () => holds.length > 0 && !holds.at(-1).to && holds.at(-1).ok !== false && holds.at(-1).releaseConfirmed !== false;
  const confirmedNow = (h) => {
    try {
      return Boolean(io.confirmHold) && io.confirmHold(prUrl, { mode: h.mode, label: h.label }) !== false;
    } catch {
      return false;
    }
  };
  let holdFailed = null;
  let releaseFailed = null;
  const release = (h) => {
    let confirmed;
    try {
      confirmed = io.release(prUrl, { mode: h.mode, label: h.label ?? po.wipLabel }) !== false;
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      h.releaseConfirmed = false;
      h.releaseFailedAt = nowIso();
      const reason = `the code host did not confirm releasing ${prUrl} from hold (${h.mode}); ready was not recorded and the ticket is not delivered-ready`;
      releaseFailed = { state: 'release-unconfirmed', outcome: 'release-unconfirmed', reason, flaky: [], failing: [], fixerNotes: [], findings: [{ id: 'PR-RELEASE-UNCONFIRMED', severity: 'major', title: 'PR release from hold was not confirmed by the host', detail: reason }], issues };
      log(`${label}: ${reason}`);
      return false;
    }
    h.to = nowIso();
    h.releaseConfirmed = true;
    if (h.mode === 'draft') recordHeadActivity(wt, prUrl, headSha(worktree), 'ready_for_review', { at: h.to });
    if (h.mode === 'close-reopen') recordHeadActivity(wt, prUrl, headSha(worktree), 'reopened', { at: h.to });
    return true;
  };
  // On green every hold not yet released is released, confirmed or not (a release is idempotent and confirmed by a
  // re-read): a hold the host applied without confirming it would otherwise leave a draft recorded as done.
  const releaseAll = () => {
    const open = holds.filter((h) => !h.to).reverse();
    for (const h of open) if (!release(h)) return false;
    readyAt = readyAt ?? open.at(-1).to;
    log(`${label}: ${prUrl} is ready again: every expected check is green on its head`);
    return true;
  };
  const waitOnly = () => (repo && settings.ci.wait.enabled !== false && io.ownsPr(prUrl) ? io.gate({ ...common, fixRounds: 0 }) : Promise.resolve({ state: 'success', failing: [], pending: [] }));
  let ci = await waitOnly();
  // The fixing rounds already spent after the open: the last round number a confirmed hold recorded (one hold can span
  // several rounds: each round under it sets its number), not the number of holds.
  let cycles = Math.max(0, ...holds.filter((h) => h.cycle && h.ok !== false).map((h) => Number(h.cycle) || 0));
  // implement.ci.maxFixRounds is one count for the ticket, read from the run record: every round charged before the PR
  // opened (or before a stop) comes off it.
  const budget = ciFixBudget(settings, { load, save });
  // The change whose rating the host shows (publishRatingOrHold's diff key): a bug PR is released only while the PR's own
  // change, as the host has it now (not this checkout's head), is still that change.
  const ratedDiff = o.ratedDiff ?? load()?.ratedDiff ?? null;
  for (;;) {
    if (ci.state === 'success' && holds.some((h) => !h.to)) {
      // A fixing round (or a person's push) gave the PR a head that was not rated: its rating, or the explicit "needs a
      // person" result, is published and shown on the host while it is still held; a failure keeps it held and stops.
      const current = isBug ? (io.prDiffKey ? io.prDiffKey(prUrl) : localDiffKey(worktree, base)) : null;
      if (isBug && (!current || current !== ratedDiff)) {
        log(`${label}: ${prUrl} is rated again before its release: its change is not the one rated (a fixing commit or a person's push)`);
        const failed = publishRatingOrHold(config, wt, { ...o, io, save, result }, { prUrl, holds, openedAt: o.openedAt ?? null, readyAt, greenAt: o.greenAt ?? null, provenHead: o.provenHead ?? null, firstPushAt: o.firstPushAt ?? null });
        if (failed) return failed;
      }
      releaseAll();
      saveWait();
      break;
    }
    if (!['failure', 'flaky'].includes(ci.state) || budget.left() < 1) break;
    cycles += 1;
    // Agents work on an open PR only while it is confirmed on hold: a recorded hold is confirmed on the host again first
    // (a person may have released it while the run was stopped); one that is not is closed and the PR held again.
    if (held() && !confirmedNow(holds.at(-1))) Object.assign(holds.at(-1), { to: nowIso(), unconfirmed: true });
    if (!held()) {
      const why = `the PR's CI is not green: ${ciLine(ci)}`;
      let h;
      try {
        h = io.hold(prUrl, { mode: po.afterOpen, why });
      } catch (error) {
        h = { mode: po.afterOpen, label: po.wipLabel, ok: false, from: nowIso(), why, error: String(error?.message ?? error) };
      }
      const confirmed = Boolean(h && h.ok !== false);
      holds.push({ ...(h && typeof h === 'object' ? h : { mode: po.afterOpen, label: po.wipLabel, from: nowIso(), why }), ok: confirmed, cycle: cycles });
      if (!confirmed) {
        const reason = `could not confirm putting ${prUrl} on hold (${h?.mode ?? po.afterOpen}) before a CI fixing round (${ciLine(ci)}); no agent ran (the PR may already be in draft or held on the host — check its state before resuming)`;
        holdFailed = { state: 'hold-failed', outcome: 'hold-failed', reason, flaky: ci.flaky ?? [], failing: ci.failing ?? [], fixerNotes: [], findings: [{ id: 'PR-HOLD-FAILED', severity: 'major', title: 'PR could not be put on hold before a CI fixing round', detail: reason }], issues };
        log(`${label}: ${reason}`);
        saveWait({ phase: 'ci-wait', holdFailed: reason });
        break;
      }
    } else holds.at(-1).cycle = cycles;
    saveWait({ phase: 'draft-back' });
    log(`${label}: ${prUrl} is on hold (${holds.at(-1).mode}); one CI fixing round on the branch`);
    const before = headSha(worktree);
    // The round is one of the ticket's from the moment it starts, whatever the gate then reports (a stop mid-round counts).
    budget.charge();
    ci = await io.gate({ ...common, fixRounds: 1 });
    if (headSha(worktree) !== before) recordHeadActivity(wt, prUrl, headSha(worktree), 'synchronize');
  }
  log(`${label}: ${ciLine(ci)}`);
  if (ci.flaky?.length) appendJsonl(metricsFile(wt, RUN_CONDITIONS_FILE), [{ ts: nowIso(), story: keys[0], ...(keys.length > 1 ? { stories: keys } : {}), kind: 'flaky-tests', pr: prUrl, tests: ci.flaky, state: ci.state }]);
  const ciDelivery = deliveryDecision(ci, { issues });
  const delivery = holdFailed ? mergeDecisions(holdFailed, ciDelivery) : releaseFailed ? mergeDecisions(releaseFailed, ciDelivery) : ciDelivery;
  const deliveryFile = path.join(worktree, setting(wt, 'stateDir'), 'pr-check', `${id}-delivery.json`);
  if (delivery) writeJson(deliveryFile, delivery);
  if (isBug) io.regate({ worktree, pr: prUrl, args: delivery ? ['--delivery', deliveryFile] : ['--delivery-clear'] });
  if (delivery) await io.stateDecision(prUrl, { keys, outcome: delivery.outcome, reason: delivery.reason, issues: delivery.issues ?? [] });
  // The property the owner asked for, checked from the records: no agent run of these tickets started after the PR was
  // ready, unless the PR was on hold at that moment.
  const auditKeys = o.auditKeys ?? keys;
  const audit = readyAudit({ keys: auditKeys, readyAt, holds }, io.usage());
  if (!audit.ok) appendJsonl(metricsFile(wt, RUN_CONDITIONS_FILE), [{ ts: nowIso(), story: keys[0], ...(keys.length > 1 ? { stories: keys } : {}), kind: 'agent-after-ready', pr: prUrl, readyAt, runs: audit.after }]);
  const nextPhase = releaseFailed || holdFailed ? 'ci-wait' : null;
  save({ phase: nextPhase, pr: prUrl, preOpen: true, readyAt, holds, readyAudit: audit, ...(releaseFailed ? { releaseConfirmed: false } : {}), ...(holdFailed ? { holdFailed: holdFailed.reason } : {}) });
  // The delivery's own figures (metrics): time from the first push of the branch to the PR, and to ready; holds; the audit.
  const rec = load() ?? {};
  const mins = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 600) / 100 : null);
  const firstPushAt = rec.firstPushAt ?? result.firstPushAt ?? null;
  const openedAt = rec.openedAt ?? result.openedAt ?? null;
  appendJsonl(metricsFile(wt, RUN_CONDITIONS_FILE), [{ ts: nowIso(), story: keys[0], ...(keys.length > 1 ? { stories: keys } : {}), kind: 'pre-open', pr: prUrl, first_push_at: firstPushAt, opened_at: openedAt, ready_at: readyAt, first_push_to_open_min: mins(firstPushAt, openedAt), first_push_to_ready_min: mins(firstPushAt, readyAt), branch_ci: rec.branchCi ?? null, holds: holds.length, agents_after_ready: audit.after.length, ci: ci.state, ...(releaseFailed ? { release_confirmed: false } : {}), ...(holdFailed ? { hold_failed: true } : {}) }]);
  // The PR's head as delivered: a hold's CI fixing round may have pushed after the open.
  const out = { ...result, finalSha: headSha(worktree), pr: prUrl, ci: ci.state, phase: nextPhase, readyAt, holds, readyAudit: { ok: audit.ok, after: audit.after.length }, ...(releaseFailed ? { releaseConfirmed: false } : {}) };
  if (delivery) return { ...out, outcome: delivery.outcome, reason: delivery.reason, findings: delivery.findings, delivery };
  return out;
}

// Rewrites a PR's body so it opens with the decision a person must make (pr-check/lib/decision-body.mjs). Best effort:
// the gate notice and the ticket carry the decision too. `target`: a repository config (its code host), or a GitHub
// "owner/name" with a gh runner (tests).
export async function stateDecisionInBody(target, prUrl, decision, { gh = null } = {}) {
  const host = target ? hostOf(target, { gh }) : null;
  const pr = String(prUrl ?? '').match(/(\d+)\/?$/)?.[1];
  if (!host || !String(host.repo ?? '') || !pr) return false;
  try {
    const { withDecision } = await import('../../pr-check/lib/decision-body.mjs');
    const view = host.pr.get(pr);
    if (!view) return false;
    const was = String(view.body ?? '').replace(/\n$/, '');
    const next = withDecision(was, decision);
    if (next === was) return true;
    host.pr.update(pr, { body: next });
    log(`PR #${pr}: body states the decision`);
    return true;
  } catch (error) {
    log(`PR #${pr}: decision not written to the body (${error.message})`);
    return false;
  }
}

// The Stop hook's PR check for the story, once it has finished (council C12: a fixed 30-minute wait opened a held-out bug's PR
// with "PR check: running" while its slow agents were still at work, and nothing acted on the result afterwards).
// The run waits as long as the check is alive; a check whose process died is restarted through the PR check's own
// recovery (it gives up as `crashed` after recovery.maxRetries); the ceiling only ends a check that never finishes.
// Whatever it returns that is not `done` is a check that did not complete (prCheckIncomplete).
const PR_CHECK_PENDING = ['waiting', 'starting', 'running'];
export async function waitForHookPrCheck(config, key, { ceilingSec = 144000, pollSec = 15, recover = null, died = (pc) => runDied(config, pc, { active: ['waiting', 'running'] }), now = Date.now, wait = sleep, log: say = () => {}, expected = false, startGraceSec = 300, notHash = null, restartStale = null } = {}) {
  let started = now();
  let restarted = 0;
  const deadline = started + ceilingSec * 1000;
  let nextRecover = 0;
  for (;;) {
    const prc = loadState(config, key).prCheck ?? {};
    // The Stop hook starts the check in the background: on a loaded machine its first state can land after the run's
    // first read (the suite saw "not started" for a check that ran). Expected but not registered yet: wait a while.
    // After a return to implementation, the state of the check that sent it back (its implementation hash) is not this
    // head's check: wait for the new one.
    const unregistered = !prc.status || prc.status === 'idle' || (notHash != null && prc.hash === notHash);
    if (unregistered && expected && now() - started < startGraceSec * 1000) {
      await wait(Math.min(pollSec, 5) * 1000);
      continue;
    }
    // A check that went stale (the implementation it waited for is no longer the current one) is started again once on
    // the current implementation, before the PR opens (dogfood C24: test automation's own commit moved the hash, and the
    // story ended "not delivered" with a check that never sat).
    if (prc.status === 'stale' && restartStale && restarted < 1) {
      restarted++;
      say(`${key}: the PR check went stale (${prc.reason ?? 'no reason'}; waited for ${prc.hash ?? '?'}, current ${prc.currentHash ?? '?'}); starting it again on the current implementation`);
      restartStale();
      notHash = prc.hash ?? null;
      started = now();
      expected = true;
      continue;
    }
    if (!PR_CHECK_PENDING.includes(prc.status)) return prc;
    if (now() > deadline) return { ...prc, status: 'timed-out', reason: `still ${prc.status} at the ${ceilingSec} s ceiling` };
    if (recover && now() >= nextRecover && died(prc)) {
      say(`${key}: the PR check's process is gone while it was ${prc.status}; restarting it`);
      recover();
      nextRecover = now() + Math.max(pollSec * 1000, 60_000);
    }
    await wait(pollSec * 1000);
  }
}

// Whether the Stop hook runs a PR check in this checkout (its own settings; off means nothing to wait for).
// (the same rule as the PR check's own hookSkipped, read here without loading the PR check's code).
function prCheckHookOn(worktree) {
  if (process.env.PR_CHECK_SKIP === '1') return false;
  try {
    return loadConfig('pr-check', worktree).prCheck?.hook?.enabled !== false;
  } catch {
    return false;
  }
}

// A PR check that did not complete (crashed, errored, skipped, stale, never started, or past its ceiling) is not a
// pass: the PR opens held, saying so first, and a person decides (the same path as a CI delivery decision).
export function prCheckIncomplete(prc, { enabled = true, issues = [] } = {}) {
  if (!enabled || prc?.status === 'done') return null;
  const status = prc?.status && prc.status !== 'idle' ? prc.status : 'not started';
  const reason = `the PR check did not complete (${status}${prc?.reason ? `: ${prc.reason}` : ''}): not delivered`;
  return { state: 'pr-check-incomplete', outcome: 'pr-check-incomplete', reason, flaky: [], failing: [], fixerNotes: [], findings: [{ id: 'PRC-INCOMPLETE', severity: 'major', title: 'The PR check did not complete', detail: reason }], issues };
}

// A PR check in fix mode that ended escalated, or still upholds findings at or above the severity it fixes, is a pre-open
// failure like an incomplete one: the change is not finished, so no PR opens (an open PR on hold stays on hold); the
// branch is pushed and the findings go on the tickets for a person (the same rule as the standalone route, where such a
// story ends unresolved without a PR). Report mode only reports: its verdict goes into the PR as it is.
export function prCheckHold(prc, { mode = defaultSettings().prCheck.mode, fixUntil = defaultSettings().prCheck.fixMinSeverity, issues = [] } = {}) {
  if (mode !== 'fix' || !prc || prc.status === 'skipped') return null;
  const severe = (prc.openFindings ?? []).filter((f) => severityAtLeast(f.severity, fixUntil));
  if (prc.verdict !== 'ESCALATED' && !severe.length) return null;
  const reason = `the PR check ${prc.verdict === 'ESCALATED' ? `ended ESCALATED${prc.score != null ? ` (${prc.score}/10)` : ''}` : `ended ${prc.verdict ?? 'unknown'}`}${severe.length ? ` with ${severe.length} finding(s) at ${fixUntil} or worse still upheld` : ''}${prc.reason ? `: ${prc.reason}` : ''}: not delivered`;
  return { state: 'pr-check-escalated', outcome: 'pr-check-escalated', reason, flaky: [], failing: [], fixerNotes: [], findings: severe.length ? severe.map((f) => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail ?? f.title })) : [{ id: 'PRC-ESCALATED', severity: 'major', title: 'The PR check escalated', detail: reason }], issues };
}

// Two reasons to hold a PR are one decision: both are stated, the CI one first.
export function mergeDecisions(ci, prc) {
  if (!ci) return prc;
  if (!prc) return ci;
  return { ...ci, reason: `${ci.reason}; ${prc.reason}`, findings: [...(ci.findings ?? []), ...prc.findings] };
}

// The PR description's line on the PR check: its verdict, score and the findings it left open.
// Council C6: ticket lines the PR check left as questions for the ticket's owner (the ticket contradicts the
// application). The PR opens for review with them at the top; the ticket is not done: its card goes to Failed with the
// escalation questions (options and a recommendation), and the gate never auto-merges it.
export const heldBlock = (decision) => (decision ? `> **Not delivered: waits for a person.** ${decision.reason[0].toUpperCase()}${decision.reason.slice(1)}. This PR is never auto-merged until a person decides (options on the ticket).\n\n` : '');
export const ownerDecisionBlock = (questions) => (questions?.length ? `> **Needs an owner decision.** The PR check could not settle ${questions.length === 1 ? 'this ticket line' : 'these ticket lines'}: the ticket contradicts the application.\n${questions.map((q) => `> - ${q.id} ${q.title}: ${q.question || q.reason || ''}`).join('\n')}\n> The ticket's owner decides (options on the ticket). Until then this PR is not delivered and is never auto-merged.\n\n` : '');
export const needsDecision = (questions) => ({ outcome: 'needs-decision', reason: `needs an owner decision: ${questions.map((q) => q.title).join('; ')}`, findings: questions.map((q) => ({ id: q.id, severity: 'question', title: q.title, detail: q.question || q.reason || '' })) });

// Whether a run changed code: files other than the harness's own records (.factory/, graphify-out/), which every
// harness commit carries.
export const codeChangedSince = (worktree, before) => filesChanged(worktree, before).some((f) => !/^(\.factory|graphify-out)\//.test(f) && !/\/graphify-out\//.test(f));

// The follow-ups a PR check's judge named (findings dismissed as real but pre-existing or out of scope), once each.
export function prCheckFollowUps(prcs) {
  const seen = new Map();
  for (const prc of prcs) for (const u of prc?.followUps ?? []) if (!seen.has(u.id)) seen.set(u.id, { title: u.title, reason: `PR check before this PR ${u.id}${u.reason ? `: ${u.reason}` : ''}` });
  // Minor findings a fix-mode check left open (it stops at majors) are follow-ups too.
  for (const prc of prcs) for (const f of prc?.openFindings ?? []) if (f.severity === 'minor' && !seen.has(f.id)) seen.set(f.id, { title: f.title, reason: `PR check before this PR ${f.id}, ${f.lens}, minor: not fixed in this PR` });
  // What the fixer said it could not fix (council C4: its notes did not reach the board), unless a later round fixed it.
  for (const prc of prcs) {
    const resolved = new Set((prc?.resolvedFindings ?? []).map((f) => f.id));
    for (const n of prc?.fixerNotes ?? []) if (!resolved.has(n.id) && !seen.has(n.id)) seen.set(n.id, { title: n.title ?? n.id, reason: `PR check ${n.id}: the fixer did not fix it: ${n.reason}` });
  }
  return [...seen.values()];
}

// The PR body's Follow-ups section: what the implementer and the PR check left out of this PR on purpose.
export function followUpsSection(followUps) {
  if (!followUps.length) return '';
  return `\n## Follow-ups (not in this PR)\n\n${dedupeFollowUps(followUps).map(followUpLine).join('\n')}\n`;
}

// What the run had to go without or wait for (run-conditions.jsonl, written by the language-server adapter and the
// stack-slot leases, merged in with each story's branch): a language server it ran without, a stack slot it waited
// for or did not get. Every PR body that carries the stories says so (council C3: a story ran without C# and its
// group PR did not say; the slot waits were nowhere).
// External calls that timed out or needed a retry (pipeline/lib/external.mjs) are recorded in the story's run conditions,
// so the run log, the metrics and the PR body say so (a story worker is its own process, so the environment is its own).
function recordExternalCalls(wt, key) {
  process.env.FACTORY_EXTERNAL_LOG = metricsFile(wt, RUN_CONDITIONS_FILE);
  process.env.FACTORY_EXTERNAL_STORY = key;
}

export function runConditions(config, keys) {
  return readMetricsLocal(config, RUN_CONDITIONS_FILE).filter((r) => keys.includes(r.story));
}

export function runConditionsSection(records, inMemoryLsp = []) {
  const lines = [];
  const lsp = new Map();
  for (const r of records.filter((x) => x.kind === LSP_RECORD)) for (const m of r.missing ?? []) lsp.set(`${r.story}\0${m}`, `${r.story} (${r.worktree}): ${m}`);
  if (!lsp.size && inMemoryLsp.length) for (const m of inMemoryLsp) lsp.set(m, m);
  if (lsp.size) lines.push(`- Code intelligence: the run went without ${[...lsp.values()].join('; ')}; the agents used graphify and search instead`);
  const slots = records.filter((x) => x.kind === 'stack-slot');
  const none = slots.filter((x) => x.outcome === 'none');
  const waited = slots.filter((x) => x.outcome === 'leased' && x.waitedSec >= 30);
  if (none.length) lines.push(`- Test stack: no free slot for ${none.map((x) => `${x.story} ${x.stage} (after ${x.waitedSec} s)`).join('; ')}; those tests did not run against this change`);
  if (waited.length) lines.push(`- Test stack: waited for a slot: ${waited.map((x) => `${x.story} ${x.stage}, ${x.waitedSec} s for slot ${x.slot}`).join('; ')}`);
  const ext = records.filter((x) => x.kind === 'external-call');
  if (ext.length) {
    const gaveUp = ext.filter((x) => /gave up/.test(x.event));
    lines.push(`- External calls: ${ext.length - gaveUp.length} retried after a timeout or a network error${gaveUp.length ? `; ${gaveUp.length} still failed after their retries (${[...new Set(gaveUp.map((x) => `${x.call}: ${x.detail}`))].slice(0, 3).join('; ')})` : ''}`);
  }
  const slow = records.filter((x) => x.kind === 'provider-slow');
  if (slow.length) lines.push(`- Agent provider: ${slow.reduce((n, x) => n + (x.resent ?? 0), 0)} API request(s) got no answer and were sent again (${Math.round(slow.reduce((n, x) => n + (x.stalledSec ?? 0), 0) / 60)} min lost), ${slow.reduce((n, x) => n + (x.errors ?? 0), 0)} API error(s), ${slow.filter((x) => (x.startupSec ?? 0) > 60).length} slow agent start(s); the run took longer, its outcome is unchanged`);
  if (slots.length && !none.length) lines.push(`- Test stack: every stack run the harness recorded (feature verification, UI verifiers, PR check fixers) used a leased slot built from this change; agents are refused slot 0 under implement run (${[...new Set(slots.map((x) => x.slot))].sort().join(', ')})`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Implementer follow-ups the PR check fixed in this same PR are not follow-ups (council C3: a PR listed as a follow-up
// the error handling its PR check had already fixed). A follow-up whose words are mostly those of a finding resolved
// during the PR check loop is dropped.
const words = (t) => new Set(String(t ?? '').toLowerCase().replace(/[^a-z0-9_/ ]+/g, ' ').split(/[\s/]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const STOP = new Set(['this', 'that', 'with', 'from', 'when', 'into', 'does', 'doesn', 'have', 'should', 'page', 'test', 'tests', 'instead', 'then', 'their', 'there', 'which']);
export function resolvedByPrCheck(followUp, resolved) {
  const a = words(followUp.title);
  if (a.size < 2) return false;
  return resolved.some((f) => {
    const b = words(`${f.title} ${f.detail ?? ''}`);
    const common = [...a].filter((w) => b.has(w)).length;
    return common / a.size >= 0.6;
  });
}
export const withoutResolved = (followUps, prcs) => {
  const resolved = prcs.flatMap((p) => p?.resolvedFindings ?? []);
  return followUps.filter((u) => !resolvedByPrCheck(u, resolved));
};

// The PR body line for a run that had to go without a leased language server after waiting for one.
export const lspSection = (missing) => (missing.length ? `- Code intelligence: this run went without ${missing.join(', ')}; the agents used graphify and search instead\n` : '');

// What feature verification ran in full before this PR (each test project once, its latest run): the story's own
// test projects and the others that cover a service the change touches (full-project-runs.jsonl).
export function fullProjectRuns(config, keys) {
  const last = new Map();
  for (const r of readMetricsLocal(config, 'full-project-runs.jsonl')) if (keys.includes(r.story)) last.set(r.unit, r);
  return [...last.values()].sort((a, b) => String(a.unit).localeCompare(String(b.unit)));
}

export function fullProjectsSection(runs) {
  if (!runs.length) return '';
  const status = (r) => (r.status === 0 ? 'passed' : `${r.step === 'build' ? 'did not build' : 'failed'} (exit ${r.status}${r.timedOut ? ', timed out' : ''})`);
  const detail = (r) => [r.tests ? `${r.tests.total} test(s), ${r.tests.failed} failed` : null, r.head ? `head ${String(r.head).slice(0, 7)}${r.dirty ? ' with uncommitted changes' : ''}` : null].filter(Boolean).join(', ');
  return `- Whole test projects run before this PR, as CI runs them:\n${runs.map((r) => `  - \`${r.unit}\`${r.why ? ` (${r.why})` : ''}: ${status(r)}${detail(r) ? ` (${detail(r)})` : ''}`).join('\n')}\n`;
}

// Behaviour outside the ticket's lines, from the PR check's flow critic (council C7).
const sideEffectsBlock = (list) => ((list ?? []).length ? `\n${sideEffectsSection(list)}\n` : '');

// The returns to implementation, for the PR body: which PR check round sent the change back, with what, and what the
// implementation stack made of it (the next check's verdict is the PR check line above).
export function prCheckReturnsSection(returns) {
  if (!returns?.length) return '';
  const rows = returns.map((r) => `  - return ${r.n}: the PR check (score ${r.score ?? '?'}/10, head ${String(r.head ?? '').slice(0, 7)}) upheld ${r.findings.map((f) => `${f.id} [${f.lens ?? '?'}] ${f.title}`).join('; ')}; the implementer fixed them and the pair, the architecture review and feature verification checked the change again`);
  return `- Sent back to implementation by the PR check: ${returns.length} time(s)\n${rows.join('\n')}\n`;
}

export function prCheckSection(prc) {
  if (!prc?.status || prc.status === 'idle') return '- PR check: not run\n';
  if (prc.status !== 'done') return `- PR check: did not complete (${prc.status}${prc.reason ? `: ${prc.reason}` : ''}); this PR is not delivered and waits for a person\n`;
  const open = (prc.openFindings ?? []).map((f) => `  - ${f.severity ?? ''} ${f.lens ? `[${f.lens}] ` : ''}${f.title ?? f.issue ?? f.id}`).join('\n');
  const how = prc.mode === 'fix'
    ? `fix mode, before this PR: the report round scored ${prc.reportScore}/10 with ${prc.reportMajor} finding(s) to fix, then ${prc.fixRounds ?? prc.rounds} fixing round(s) and ${prc.commits?.length ?? 0} fix commit(s)`
    : 'report only, before this PR';
  return `- PR check (${how}): ${prc.verdict} ${prc.score}/10${open ? `, open findings:\n${open}` : ''}\n`;
}

// The PR check mode before a PR opens (prCheck.mode, the same for a single ticket and an epic). `fix` (the default):
// when the report round upholds a finding at or above prCheck.fixMinSeverity (prCheck.bugFixMinSeverity for a bug), the
// work goes through the PR check's fixing loop on its branch before the PR opens (fixer, feature verification
// re-verifies what a fix made stale, re-check), for at most prCheck.maxCouncilRounds rounds, until nothing that
// severe is upheld; the PR then carries the final report. `report`: the report round's verdict goes into the PR as it
// is. `off`: no PR check before the PR.
export const prCheckFixSettings = (config) => {
  const p = { ...defaultSettings().prCheck, ...(config.prCheck ?? {}) };
  return { mode: p.mode, fixUntil: p.fixMinSeverity, bugFixUntil: p.bugFixMinSeverity, fixLenses: p.fixLenses, maxRounds: p.maxCouncilRounds, fixTimeoutSec: setting(config, 'implement.waitSec.prCheck') };
};
// The environment a pipeline CLI run on a story's worktree gets (PR check fixing loop, CI parity fix).
// Feature verification of the other stories whose verified plan or tests this change edited (`check --changed-from`
// fails for them): each ticket is fetched and handed to that call only, its plan and tests are checked as they are
// (an agent runs only on the gaps its verifiers find), and the result is committed. { ok, keys, reason }.
export function reverifyEditedStories(wt, { worktree, base, key, timeoutSec = 14400, fv = (args, env) => run(process.execPath, [FV_CLI, ...args], { cwd: worktree, env, timeoutSec }), fetchTicket = (k) => boardEvent(worktree, k, ['fetch', k]), commit = (msg) => commitAll(worktree, msg) } = {}) {
  const check = fv(['check', '--changed-from', base], fixEnv(worktree, base, key));
  if (check.status === 0) return { ok: true, keys: [] };
  const failing = [...new Set([...String(check.stdout ?? '').matchAll(/^FAIL\s+([A-Z][A-Z0-9]*-\d+)\b/gm)].map((m) => m[1]))];
  const keys = failing.filter((k) => k !== key);
  if (!keys.length) return { ok: false, keys, reason: `feature verification fails for ${key} itself: ${tail(String(check.stdout ?? ''), 400)}` };
  for (const k of keys) {
    log(`${key}: this change edits the verified test plan or tests of ${k}; feature verification checks them as they are`);
    fetchTicket(k);
    const env = fixEnv(worktree, base, k);
    const plan = fv(['plan', k, '--verify-first'], env);
    const automate = plan.status === 0 ? fv(['automate', k, '--verify-first'], env) : plan;
    log(`${key}: ${k} ${automate.status === 0 ? 'verified again' : `not verified again (exit ${automate.status})`}`);
  }
  commit(`${key}: Re-verified the test plans and tests of ${keys.join(', ')} that this change edited`);
  const after = fv(['check', '--changed-from', base], fixEnv(worktree, base, key));
  if (after.status === 0) return { ok: true, keys };
  return { ok: false, keys, reason: `this change edits the verified tests of ${keys.join(', ')}, and feature verification could not verify them again: ${tail(String(after.stdout ?? ''), 400)}` };
}

export function fixEnv(worktree, base, key) {
  const env = { ...process.env, PIPELINE_ROOT: worktree, PIPELINE_BASE_REF: base, PIPELINE_HEADLESS: '1', PIPELINE_TICKETS_OFFLINE: '1' };
  env.PIPELINE_STORY_SOURCES = [process.env.PIPELINE_STORY_SOURCES, key].filter(Boolean).join(path.delimiter);
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  return env;
}

// The upheld findings fix mode acts on: at fixUntil or worse (bugFixUntil for a bug), or on fixLenses.
export function prCheckToFix(wt, prc, { bug = false } = {}) {
  const s = prCheckFixSettings(wt);
  if (s.mode !== 'fix' || prc?.status !== 'done') return [];
  const until = bug ? s.bugFixUntil : s.fixUntil;
  return (prc.openFindings ?? []).filter((f) => severityAtLeast(f.severity, until) || (s.fixLenses ?? []).includes(f.lens));
}

export function fixBeforePr(wt, { key, worktree, base, bug = false }, prc, { runCli = run } = {}) {
  const s = prCheckFixSettings(wt);
  if (s.mode !== 'fix' || prc?.status !== 'done') return prc;
  // A bug fix aims at 10/10: the review gate auto-merges a Low fix only when its PR check scored 10 (the reference's
  // criterion), so its minor findings are fixed too (dogfood C2: a Low group at 9/10 went to review).
  if (bug) s.fixUntil = s.bugFixUntil;
  // A feature stops when nothing major or worse is upheld: fix mode is there to stop majors shipping, and its minors go to
  // the PR's Follow-ups (dogfood C4: a feature paid a third round, $4+, for a minor video finding). Findings on
  // `fixLenses` (none by default) are fixed at any severity.
  const severe = (prc.openFindings ?? []).filter((f) => severityAtLeast(f.severity, s.fixUntil) || (s.fixLenses ?? []).includes(f.lens));
  if (!severe.length) return prc;
  log(`${key}: the PR check upheld ${severe.length} finding(s) to fix (${s.fixUntil} or worse${(s.fixLenses ?? []).length ? `, or on ${s.fixLenses.join(', ')}` : ''}) (${severe.map((f) => f.id).join(', ')}); fixing them before the PR opens (up to ${s.maxRounds} round(s))`);
  const env = fixEnv(worktree, base, key);
  // The fixer starts on the report round's upheld findings (its result.json, read before the run folder is reused).
  const seed = path.join(worktree, setting(wt, 'stateDir'), 'pr-check', key, 'result.json');
  const r = runCli(process.execPath, [PR_CHECK_CLI, 'run', '--story', key, '--base', base, '--until', s.fixUntil, ...((s.fixLenses ?? []).length ? ['--fix-lenses', s.fixLenses.join(',')] : []), '--fix-first', seed, '--json'], { cwd: worktree, env, timeoutSec: ceiling(wt, s.fixTimeoutSec) });
  const reportFields = { reportScore: prc.score, reportMajor: severe.length };
  try {
    const out = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{')));
    log(`${key}: PR check fix mode: ${out.verdict} ${out.score}/10 after ${out.rounds} round(s), ${out.commits?.length ?? 0} fix commit(s)`);
    const stillOpen = (f) => (out.openFindings ?? []).some((o) => o.id === f.id || o.title === f.title);
    const resolvedFindings = [...(prc.openFindings ?? []).filter((f) => !stillOpen(f)), ...(out.resolvedFindings ?? []).filter((f) => !stillOpen(f))];
    return { status: 'done', mode: 'fix', verdict: out.verdict, score: out.score, openFindings: out.openFindings ?? [], questions: out.questions ?? [], // The report round's and every fix round's, once each (council C8: `??` on an empty list dropped the report round's).
      sideEffects: [...new Set([...(prc.sideEffects ?? []), ...(out.sideEffects ?? [])])], resolvedFindings, fixerNotes: [...(prc.fixerNotes ?? []), ...(out.fixerNotes ?? [])], rounds: out.rounds, fixRounds: out.fixRounds ?? null, commits: out.commits ?? [], reason: out.reason, ...reportFields };
  } catch {
    log(`${key}: PR check fix mode failed (${tail(String(r.stderr || r.stdout), 300)}); the PR opens with the report round's verdict`);
    return { ...prc, fixError: tail(String(r.stderr || r.stdout), 300) };
  }
}

// Pushes a story's branch and opens its PR as the pipeline's PR bot (dev-bot-<login>, lib/bot.mjs), or
// as the developer's gh login when the bot is not set up. The branch's PR may already be open (a
// reopened bug fix re-runs on it): the push updated it, and its URL is looked up as the same identity.
// { url, pushed, reason }.
// The story branch pushed without a pull request (implement.preOpen): the records committed, the latest base merged in.
export async function pushStoryBranch(config, { worktree, branch, base }, deps = {}) {
  (deps.commitRecords ?? commitRecords)(worktree, 'Pipeline records (PR check, run conditions, usage) before the PR');
  const publisher = deps.publisher ?? (await prPublisher(config));
  return pushBranch(publisher, { cwd: worktree, branch, base });
}

// The body's line for the review gate's assessment made before the PR opened (review-gate assess: ratings on each ticket).
export function assessedLine(assessment) {
  const level = (v) => (typeof v === 'string' ? v : v?.level) ?? '?';
  const tickets = (assessment.tickets ?? []).map((t) => `${t.key}: impact ${level(t.impact ?? t.rating?.impact)}, fix risk ${level(t.fixRisk ?? t.rating?.fixRisk)}, confidence ${t.confidence?.score ?? t.confidence ?? '?'}`);
  // Why a person must review it (a person's earlier rejection) is a section the gate rebuilds from its live read
  // (review-gate gate.mjs rejectionSection), not this line.
  return `- Review gate, assessed before this PR opened: severity ${level(assessment.severity)} (${tickets.join('; ')})`;
}

// `records: false` (implement.preOpen): the records were committed before the branch push, and nothing may change the
// head CI proved, so the rows written since stay in the worktree like every row written after the open.
export async function openStoryPr(config, { worktree, branch, base, title, body, draft = false, records = true }, deps = {}) {
  if (records) (deps.commitRecords ?? commitRecords)(worktree, 'Pipeline records (PR check, run conditions, usage) before the PR');
  const publisher = deps.publisher ?? (await prPublisher(config));
  const opened = await openPullRequest(publisher, { cwd: worktree, branch, base, title, body, draft }, { run: deps.run, onOpened: deps.onOpened, ...(records ? {} : { mergeBase: () => null }) });
  if (!opened.pushed || opened.url) return opened;
  const url = (deps.openPrFor ?? openPrFor)(config, branch, publisher.env, publisher);
  return url ? { ...opened, url, reason: undefined } : opened;
}

// The implementer appends its Implementation Notes to the ticket's cached story; the issue is the source
// of truth, so the finished story's text goes back to it (no-op when unchanged or the board is off).
export function publishTicket(worktree, key) {
  boardEvent(worktree, key, ['publish', key]);
}

// Moves the story's card to Pending Review with its evidence. The board is informational, so a failure
// is logged and never changes the outcome.
function reportToBoard(worktree, key, prUrl) {
  const verifiedHash = loadState(loadConfig('implement', worktree), key).automation.verifiedHash;
  boardEvent(worktree, key, ['review', key, ...(prUrl ? ['--pr', prUrl] : []), ...(verifiedHash ? ['--id', `verified:${verifiedHash}`] : [])]);
}

export function formatSummary(results) {
  const rows = results.map((r) => `${r.key.padEnd(10)} ${String(r.outcome ?? '-').padEnd(18)} ${r.branch ?? ''}${r.pr ? `  ${r.pr}` : ''}${r.reason ? `\n${' '.repeat(11)}${r.reason}` : ''}`);
  return `${'Story'.padEnd(10)} ${'Outcome'.padEnd(18)} Branch\n${rows.join('\n')}`;
}
