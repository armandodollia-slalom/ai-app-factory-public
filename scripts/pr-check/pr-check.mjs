#!/usr/bin/env node
// PR check: an adversarial review loop that scores a pull request against its story (acceptance
// criteria, flow, UI design, code style, video evidence) and fixes it until it scores 10/10.
// See docs/ai-pipeline/pr-check.md.
import { writeText, appendText } from '../pipeline/lib/redact.mjs';
import { hostFor } from '../pipeline/lib/hosts/index.mjs';
import { ciTarget } from '../pipeline/lib/ci/index.mjs';
import { trackerFor } from '../board/lib/trackers/index.mjs';
import { prAnalysisSection } from '../pipeline/lib/analysis/fixloop.mjs';
import { withStaticAnalysis } from '../pipeline/lib/analysis/report.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readPayload, requireStory, runMain } from '../pipeline/lib/cli.mjs';
import { INSTALL_ROOT, isDisabled, loadConfig } from '../pipeline/lib/config.mjs';
import { git, git as gitIn } from '../pipeline/lib/git.mjs';
import { lockFile, metricsFile, readMetricsLocal } from '../pipeline/lib/state.mjs';
import { activeStory } from '../pipeline/lib/stories.mjs';
import { acquireLock, appendJsonl, log, lockHolder, nowIso, readJson, releaseLock, selfProcess, setLogTag, sha, writeJson } from '../pipeline/lib/util.mjs';
import { renderMockups } from '../implement/lib/mockups.mjs';
import { isClean, removeCheckout, resolveTarget } from './lib/context.mjs';
import { commentOnPullRequest } from './lib/github.mjs';
import { hookRun, hookStop, recheck, recoverHookRuns, resetPrCheck, sessionContext } from './lib/hooks.mjs';
import { CHECKS_FILE, LENSES, runPrCheck } from './lib/loop.mjs';
import { renderReport } from './lib/report.mjs';
import { interruptedRuns, readProgress, resumeRuns, writeProgress } from './lib/runs.mjs';
import { extractVideoFrames, videoSources } from './lib/video.mjs';
import { fixNote, fixesOf, withFixNote, withNotesUpdate, withSideEffects } from './lib/pr-notes.mjs';
import { councilRecords, councilReviewSection, withCouncilReview } from '../pipeline/lib/council.mjs';
import { withCheckVerdict, withDecision, withScopedCheck } from './lib/decision-body.mjs';
import { commitRecords } from '../implement/lib/gitops.mjs';
import { loadTicket } from '../pipeline/lib/tickets.mjs';
import { gateStaged } from '../pipeline/lib/analysis/commit-gate.mjs';
import { setting } from '../pipeline/lib/settings.mjs';
import { exportSlots } from '../feature-verification/lib/slots.mjs';

setLogTag('pr-check');

const USAGE = `Usage: node scripts/pr-check/pr-check.mjs <command> [options]

  run [--pr <n>] [--story <KEY>] [--stories <KEY>,...] [--epic <EPIC>] [--lenses <lens>,...]
      [--base <ref>] [--videos <path|url>,...]
      [--no-fix] [--max-rounds <n>] [--until blocking|major|minor] [--fix-lenses video,...] [--fix-first <result.json>] [--debate-turns <n>] [--comment] [--push] [--json]
        Review the PR (or the current branch) against its story until it scores 10/10.
        Without --pr it checks the current branch. --no-fix runs one report-only round. --until stops the
        fixing loop (ACCEPTED) once nothing of that severity or worse is upheld.
        --stories / --epic hold it to several tickets (an epic's stories, and the epic's journey);
        --lenses runs only those lenses (acceptance, flow, design, style, video).
        --resume continues an interrupted run of the same check from its last saved round.
  resume [KEY|pr-<n>] [--force] restart interrupted checks in the background (manual runs from their
                                last round, Stop-hook runs from the start), at most recovery.maxRetries times
  status [pr-<n>|KEY]           last result of each check (or one)
  metrics [--json] [--since <iso-date>]

Hooks (called by scripts/pipeline/pipeline.mjs; PR_CHECK_SKIP=1 turns them off)
  hook stop | hook session-start | hook story-start <story>
  hook-run <story> --hash <impl-hash>   background half of the Stop hook: waits for feature verification, then checks

Models: each role runs on its models.pool entry, named in models.agents (pr-check-judge, pr-check-acceptance,
pr-check-flow, pr-check-design, pr-check-style, pr-check-video, pr-check-defender, pr-check-fixer).`;

const VALUE_FLAGS = new Set(['pr', 'story', 'stories', 'epic', 'lenses', 'base', 'videos', 'max-rounds', 'until', 'fix-first', 'fix-lenses', 'debate-turns', 'since', 'hash', 'branch', 'fix-rounds']);
const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

const resultDir = (config, id) => path.join(config.root, config.stateDir, 'pr-check', id);

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

// One check; returns the summary saved to .factory/state/pr-check/<id>/result.json.
async function executeCheck(config, flags) {
  let stopOwnLspd = () => {};
  const fix = !flags['no-fix'];
  // prCheck.maxCouncilRounds in every caller (delivery, epic, CI fix); --max-rounds overrides it for a run by hand.
  if (flags['max-rounds']) config.prCheck.maxCouncilRounds = positiveInt(flags['max-rounds'], 'max-rounds');
  if (flags['debate-turns']) config.prCheck.maxDebateTurns = Number(flags['debate-turns']);
  if (!fix) config.prCheck.maxCouncilRounds = 1;

  const only = list(flags.lenses);
  const unknown = only.filter((l) => !LENSES[l]);
  if (unknown.length) throw new Error(`unknown lens ${unknown.join(', ')} (lenses: ${Object.keys(LENSES).join(', ')})`);
  const ctx = await resolveTarget(config, { pr: flags.pr ? positiveInt(flags.pr, 'pr') : null, story: flags.story, stories: list(flags.stories).map((k) => k.toUpperCase()), epic: typeof flags.epic === 'string' ? flags.epic : null, base: flags.base, fix });
  ctx.only = only;
  const lock = lockFile(config, ctx.id, 'pr-check');
  if (!acquireLock(lock)) throw new Error(`a PR check of ${ctx.id} is already running (pid ${lockHolder(lock)})`);
  // Manual runs record their progress so an interrupted one can resume; Stop-hook runs recover through prCheck state.
  const manual = !flags.hook;
  const saved = flags.resume ? readProgress(config, ctx.id) : null;
  let resume = fix && saved?.branch === ctx.branch ? saved.loop ?? null : null;
  // --fix-first <result.json>: start by fixing the findings an earlier report round upheld (the delivery fix
  // mode passes the Stop hook's result), then re-check. Without it a fresh first critique can miss a finding
  // the report round upheld, and the loop passes without fixing it (dogfood C2: a ticket's blocking flow finding).
  if (fix && !resume && typeof flags['fix-first'] === 'string') resume = seedFromReport(flags['fix-first'], git(ctx.workRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim());
  try {
    if (flags.resume && !saved) throw new Error(`there is no interrupted PR check of ${ctx.id} to resume`);
    if (resume) log(`resuming ${ctx.id} at round ${resume.round} (${resume.phase})`);
    // The fixer's changes are committed with `git add -A`; refuse to sweep someone's uncommitted work in.
    // A fix cut short leaves its changes behind; the resumed fix picks them up.
    if (fix && resume?.phase !== 'fix' && !isClean(config, ctx)) throw new Error('the working tree has uncommitted changes; commit or stash them, or pass --no-fix');
    ctx.runDir = path.join(ctx.workRoot, config.stateDir, 'pr-check', ctx.id);
    if (!resume) fs.rmSync(ctx.runDir, { recursive: true, force: true });
    if (manual) {
      const keep = { recoveries: saved?.recoveries ?? 0, retryAt: saved?.retryAt ?? null, loop: resume };
      writeProgress(config, ctx.id, { story: ctx.story.key, branch: ctx.branch, flags: { ...flags, resume: undefined }, ...keep, ...selfProcess(), startedAt: nowIso(), finishedAt: null, error: null });
    }
    const contextDir = path.join(ctx.runDir, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    writeText(path.join(contextDir, 'pr.md'), ctx.pr ? `# #${ctx.pr.number} ${ctx.pr.title}\n\n${ctx.pr.url}\n\n${ctx.pr.body || '(no description)'}\n` : `No pull request: checking branch ${ctx.branch}.\n`);

    const values = typeof flags.videos === 'string' ? flags.videos.split(',').map((v) => v.trim()).filter(Boolean) : [];
    ctx.video = await extractVideoFrames(config, ctx.runDir, videoSources(config, { values, prBody: ctx.pr?.body ?? '', caseIds: (ctx.tickets ?? [ctx.story]).filter(Boolean).map((t) => `tc-${t.key}-`) }), ctx.workRoot);
    writeJson(path.join(contextDir, 'frames.json'), ctx.video);
    ctx.videoKey = videoKeyOf(ctx.video, ctx.workRoot);
    // The design lens gets PNG renders of every mockup screen and state (cached by the mockups' sha).
    if (ctx.isFrontend && ctx.mockups.length && (!ctx.only?.length || ctx.only.includes('design'))) {
      ctx.mockupRenders = await renderMockups({ files: ctx.mockups, outDir: path.join(contextDir, 'mockups'), cacheDir: path.join(config.root, config.stateDir, 'pr-check', '.mockup-cache') });
      if (!ctx.mockupRenders.ok) log(`could not render the mockups (${ctx.mockupRenders.error}); the design critic reads the sources`);
    }

    log(`checking ${ctx.id} against ${ctx.story.key} (base ${ctx.baseRef}, ${fix ? `fixing, up to ${config.prCheck.maxCouncilRounds} rounds` : 'report only'})`);
    const started = Date.now();
    const onProgress = manual ? (loop) => writeProgress(config, ctx.id, { loop }) : undefined;
    const caseIds = (ctx.tickets ?? [ctx.story]).filter(Boolean).map((t) => `tc-${t.key}-`);
    const afterNotes = async (entry) => {
      ctx.fixEntries = [...(ctx.fixEntries ?? []), entry].filter(Boolean);
      if (updateStoryNotes(config, ctx, ctx.fixEntries, ctx.fixEntries.map((e) => e.fix?.commit).filter(Boolean))) ctx.notesChanged = true;
    };
    const afterFix = async (entry) => {
      // The notes first, so the scoped re-check reads what the code now does (council C5).
      ctx.fixEntries = [...(ctx.fixEntries ?? []), entry].filter(Boolean);
      if (updateStoryNotes(config, ctx, ctx.fixEntries, ctx.fixEntries.map((e) => e.fix?.commit).filter(Boolean))) ctx.notesChanged = true;
      reverifyAfterFixes(config, ctx, {}, { scoped: true });
      // The recordings feature verification just made (the PR body's videos predate the fix).
      ctx.video = await extractVideoFrames(config, ctx.runDir, videoSources(config, { values, prBody: '', caseIds }), ctx.workRoot);
      writeJson(path.join(contextDir, 'frames.json'), ctx.video);
    ctx.videoKey = videoKeyOf(ctx.video, ctx.workRoot);
    };
    const until = typeof flags.until === 'string' ? flags.until : null;
    if (until && !['blocking', 'major', 'minor'].includes(until)) throw new Error(`--until takes blocking, major or minor, not ${until}`);
    const fixLenses = typeof flags['fix-lenses'] === 'string' ? flags['fix-lenses'].split(',').map((l) => l.trim()).filter(Boolean) : [];
    // D-C9-1: a language-server daemon the check's agents start for its worktree is stopped when the check ends; one
    // that was already running (another run's) is left alone, and the main checkout's is never touched.
    const lspd = path.join(INSTALL_ROOT, 'scripts/lsp/lspd.mjs');
    const lspdRunning = () => {
      try {
        return JSON.parse(String(spawnSync(process.execPath, [lspd, 'status', '--worktree', ctx.workRoot], { encoding: 'utf8', timeout: 30_000 }).stdout).trim().split('\n').pop()).running === true;
      } catch {
        return false;
      }
    };
    // A linked worktree has a .git file; the main checkout (a .git folder) is never touched.
    const isWorktree = (() => {
      try {
        return fs.statSync(path.join(ctx.workRoot, '.git')).isFile();
      } catch {
        return false;
      }
    })();
    const lspdBefore = isWorktree ? lspdRunning() : true;
    // Stopped at the very end of the run (council C6: agents that run after the loop, the full verification and the
    // escalation questions, started it again).
    stopOwnLspd = () => {
      if (!lspdBefore && fs.existsSync(path.join(ctx.workRoot, '.git')) && lspdRunning()) {
        spawnSync(process.execPath, [lspd, 'stop', '--worktree', ctx.workRoot], { encoding: 'utf8', timeout: 60_000 });
        log(`stopped the language-server daemon this check started for ${path.basename(ctx.workRoot)}`);
      }
    };
    const result = await runPrCheck(config, ctx, { fix, resume, onProgress, afterFix: fix ? afterFix : null, afterNotes: fix ? afterNotes : null, until, fixLenses });
    const last = result.history[result.history.length - 1];
    const report = renderReport(ctx, result);

    let pushed = false;
    const commits = result.history.map((h) => h.fix?.commit).filter(Boolean);
    if (commits.length) {
      // The fixes may have edited a verified test plan, tests or scenario: one full verification after the scoped
      // checks of each round (the pre-push check would refuse stale ones), as an epic does for stale tickets.
      reverifyAfterFixes(config, ctx);
      // The story's Implementation Notes say what the fix changed (the fixer may not edit the story).
      if (updateStoryNotes(config, ctx, result.history, commits)) ctx.notesChanged = true;
    }
    // The check's own records go to the PR branch like every fix round's (council C8: a one-round pass left its record
    // untracked, so the branch had no PR check): committed, and pushed when this check pushes to an open PR.
    const recordsCommitted = Boolean(flags.push && ctx.pr && !ctx.pr.fromFork && commitRecords(ctx.workRoot, `${ctx.story.key}: PR check record`));
    if (recordsCommitted && !commits.length) {
      const r = git(ctx.workRoot, ['push', '--quiet', 'origin', `HEAD:${ctx.branch}`]);
      log(r.status === 0 ? `pushed the PR check record to ${ctx.branch}` : `push of the PR check record failed: ${String(r.stderr ?? '').trim().split('\n').pop()}`);
    }
    // Notes the fixer corrected without a code change still reach the board when the check works on a PR.
    if (!commits.length && ctx.notesChanged && flags.push && ctx.pr) publishTickets(config, ctx);
    if (flags.push && commits.length && ctx.pr?.fromFork) log('not pushing: the PR comes from a fork; push the fix commits to the fork yourself');
    else if (flags.push && commits.length) {
      const r = git(ctx.workRoot, ['push', '--quiet', 'origin', `HEAD:${ctx.branch}`]);
      pushed = r.status === 0;
      log(pushed ? `pushed ${commits.length} fix commit(s) to ${ctx.branch}` : `push to ${ctx.branch} failed: ${String(r.stderr ?? '').trim().split('\n').slice(-6).join(' | ')}`);
      if (pushed && ctx.pr) {
        publishFixNote(config, ctx, result.history, commits);
        publishTickets(config, ctx);
      }
    }
    // The verdict the PR body states is this check's (council C8 audit: a re-check never refreshed it).
    if (flags.push && ctx.pr && !ctx.pr.fromFork && ['PASS', 'ACCEPTED', 'FAIL', 'ESCALATED'].includes(result.verdict)) {
      const currentBody = prBody(config, ctx.pr.number);
      if (currentBody != null) {
        const was = currentBody.replace(/\n$/, '');
        // A check after a CI fixing round judged the fix only: it never replaces the full check's verdict (council C9).
        const head = git(ctx.workRoot, ['rev-parse', 'HEAD']).stdout.trim();
        const next = ctx.ciFixIds?.length
          ? withScopedCheck(was, { verdict: result.verdict, score: last?.score ?? '?', ids: ctx.ciFixIds, when: nowIso().slice(0, 10), head })
          : withCheckVerdict(was, { keys: (ctx.tickets ?? [ctx.story]).map((t) => t.key), verdict: result.verdict, score: last?.score ?? '?', openFindings: last?.upheld ?? [], when: nowIso().slice(0, 10), head });
        if (next !== was) {
          const e = setPrBody(config, ctx.pr.number, next);
          log(`PR #${ctx.pr.number}: ${e.status === 0 ? `body states this check's verdict (${result.verdict} ${last?.score}/10)` : 'verdict not updated in the body'}`);
        }
      }
    }
    // The PR description lists what the PR changes outside its tickets' lines, from this check (council C7).
    const allSideEffects = [...new Set(result.history.flatMap((h) => h.sideEffects ?? []))];
    if (flags.push && ctx.pr && !ctx.pr.fromFork && allSideEffects.length) {
      const currentBody = prBody(config, ctx.pr.number);
      if (currentBody != null) {
        const next = withSideEffects(currentBody.replace(/\n$/, ''), allSideEffects);
        if (next !== currentBody.replace(/\n$/, '')) {
          const e = setPrBody(config, ctx.pr.number, next);
          log(`PR #${ctx.pr.number}: ${e.status === 0 ? `body lists ${allSideEffects.length} behaviour change(s) outside the ticket's lines` : 'side effects not written to the body'}`);
        }
      }
    }
    // The council's results (every stage that seated one for these tickets), regenerated from the latest records.
    const councilSection = councilReviewSection(councilRecords(config, (ctx.tickets ?? [ctx.story]).map((t) => t.key)));
    if (flags.push && ctx.pr && !ctx.pr.fromFork && councilSection) {
      const currentBody = prBody(config, ctx.pr.number);
      if (currentBody != null) {
        const was = currentBody.replace(/\n$/, '');
        const next = withCouncilReview(was, councilSection).replace(/\n$/, '');
        if (next !== was) {
          const e = setPrBody(config, ctx.pr.number, next);
          log(`PR #${ctx.pr.number}: ${e.status === 0 ? 'body has the council review table' : 'council review table not written to the body'}`);
        }
      }
    }
    // The "Static analysis" section, regenerated like the council table (only with analysis on).
    const analysisSection = prAnalysisSection(config, (ctx.tickets ?? [ctx.story]).map((t) => t.key), { cwd: ctx.workRoot ?? config.root });
    if (flags.push && ctx.pr && !ctx.pr.fromFork && analysisSection) {
      const currentBody = prBody(config, ctx.pr.number);
      if (currentBody != null) {
        const was = currentBody.replace(/\n$/, '');
        const next = withStaticAnalysis(was, analysisSection).replace(/\n$/, '');
        if (next !== was) {
          const e = setPrBody(config, ctx.pr.number, next);
          log(`PR #${ctx.pr.number}: ${e.status === 0 ? 'body has the static analysis section' : 'static analysis section not written to the body'}`);
        }
      }
    }
    // Owner questions on an open PR (council C6): the ticket is not done. Its card goes to Failed with the escalation
    // questions (options and a recommendation, from the questions as findings) and the gate notice is refreshed, so it
    // states the decision and never auto-merges.
    if (result.verdict === 'QUESTION' && ctx.pr && flags.push) {
      const qs = last?.questions ?? [];
      postDecision(config, ctx.workRoot, { keys: (ctx.tickets ?? []).map((t) => t.key), pr: ctx.pr.url, outcome: 'needs-decision', reason: `needs an owner decision: ${qs.map((q) => q.title).join('; ')}`, findings: qs.map((q) => ({ id: q.id, severity: 'question', title: q.title, detail: q.question || q.reason || '' })), prCheck: `QUESTION ${last?.score ?? '?'}/10`, dropIds: qs.map((q) => q.id) });
    }
    // --wait-ci: after pushing to an open PR, wait for its CI (D-C8-3: no checks yet is not a result; a PR GitHub
    // cannot merge gets the base merged so its CI runs). The result says whether the PR is delivered.
    let ci = null;
    if (flags['wait-ci'] && ctx.pr && String(prHostOf(config)?.repo ?? '')) {
      const { waitForPrCi } = await import('../implement/lib/ci-wait.mjs');
      const { mergeLatestBase } = await import('../pipeline/lib/base-merge.mjs');
      const target = ciTarget(config);
      const resolveDirty = async () => {
        const m = mergeLatestBase(ctx.workRoot, ctx.baseRef);
        if (m.conflict) return { merged: false, reason: `merging ${ctx.baseRef} conflicts in ${(m.files ?? []).join(', ')}` };
        if (!m.merged) return { merged: Boolean(m.upToDate) };
        return { merged: git(ctx.workRoot, ['push', '--quiet', 'origin', `HEAD:${ctx.branch}`]).status === 0 };
      };
      log(`waiting for the CI of PR #${ctx.pr.number}`);
      ci = await waitForPrCi(config, ctx.pr.number, { target, log, resolveDirty });
      log(`PR #${ctx.pr.number}: ${ci.line}`);
    }
    if (flags.comment && ctx.pr) await commentOnPullRequest(config, ctx.pr.number, report);

    const out = resultDir(config, ctx.id);
    fs.mkdirSync(out, { recursive: true });
    writeText(path.join(out, 'report.md'), report);
    const summary = {
      id: ctx.id,
      story: ctx.story.key,
      ...(ctx.multi ? { stories: ctx.tickets.map((t) => t.key), epic: ctx.epic?.key ?? null } : {}),
      lenses: Object.keys(last?.lensScores ?? {}),
      pr: ctx.pr?.url ?? null,
      verdict: result.verdict,
      score: last?.score ?? 0,
      lensScores: last?.lensScores ?? {},
      rounds: result.history.length,
      reason: result.reason,
      // What routes a finding (implement's return to implementation or to test automation) travels with it.
      openFindings: last?.upheld.map(({ id, lens, severity, title, file, fix, action, resolves }) => ({ id, lens, severity, title, ...(file ? { file } : {}), ...(fix ? { fix: String(fix).slice(0, 600) } : {}), ...(action ? { action } : {}), ...(resolves ? { resolves } : {}) })) ?? [],
      upheldFindings: last?.upheld ?? [],
      // Findings upheld in an earlier round and fixed since (the report's "Resolved during the loop"), so the PR
      // body does not list them as follow-ups.
      // Resolved: upheld earlier, not upheld now, and neither a follow-up, an owner question nor something the fixer
      // said it could not fix (council C6: a finding was listed as resolved and as a follow-up at once).
      resolvedFindings: (() => {
        const open = new Set([...(last?.upheld.map((f) => f.id) ?? []), ...followUpsOf(result.history).map((u) => u.id), ...(last?.questions ?? []).map((q) => q.id), ...fixesOf(result.history).notFixed.map((n) => n.id)]);
        const seen = new Map();
        for (const h of result.history.slice(0, -1)) for (const f of h.upheld ?? []) if (!open.has(f.id)) seen.set(f.id, { id: f.id, lens: f.lens, severity: f.severity, title: f.title, detail: f.detail ?? null });
        return [...seen.values()];
      })(),
      followUps: followUpsOf(result.history),
      // Ticket lines the check could not settle because the ticket contradicts the application: an owner decides.
      questions: last?.questions ?? [],
      ...(ci ? { ci } : {}),
      // What the fixer could not fix and why (the PR body's Follow-ups and the board carry it).
      fixerNotes: fixerNotesOf(result.history),
      // Rounds in which the fixer worked (a seeded fix round included), as the PR body reports them.
      fixRounds: result.history.filter((h) => h.fix).length,
      // Every round's, once (council C11: a carried-over flow lens dropped what round 1 listed from #154's body).
      sideEffects: [...new Set(result.history.flatMap((h) => h.sideEffects ?? []))],
      commits,
      pushed,
      report: path.relative(config.root, path.join(out, 'report.md')).replace(/\\/g, '/'),
      runDir: path.relative(config.root, ctx.runDir).replace(/\\/g, '/'),
      seconds: Math.round((Date.now() - started) / 1000),
      finishedAt: nowIso(),
    };
    writeJson(path.join(out, 'result.json'), summary);
    if (manual) writeProgress(config, ctx.id, { pid: null, boot: null, recoveries: 0, retryAt: null, finishedAt: summary.finishedAt });
    if (ctx.workRoot !== config.root) fs.cpSync(ctx.runDir, path.join(out, 'run'), { recursive: true });
    return { ...summary, text: report };
  } catch (error) {
    // A run that fails (rather than dies) is not resumed.
    if (manual && (flags.resume || readProgress(config, ctx.id)?.pid === process.pid)) writeProgress(config, ctx.id, { pid: null, boot: null, finishedAt: nowIso(), error: error.message });
    throw error;
  } finally {
    try {
      stopOwnLspd();
    } catch {
      // cleanup only
    }
    releaseLock(lock);
    removeCheckout(config, ctx);
  }
}

// A decision a person must make, posted where people see it (council C6/C7): each ticket fails on the board with the
// escalation questions (options and a recommendation) on the ticket and on the PR, and the gate notice is rebuilt so it
// states the decision and never auto-merges. Nothing a person must decide stays only on this disk.
function regateWith(cwd, pr, extra = []) {
  const g = spawnSync(process.execPath, [path.join(INSTALL_ROOT, 'scripts/review-gate/review-gate.mjs'), 'regate', '--pr', pr, ...extra], { cwd, encoding: 'utf8' });
  log(`gate: ${String(g.stdout || g.stderr).trim().split('\n').pop()}`);
}

// The PR's code host, and its body read and written through it ({ status, error } like a CLI result).
function prHostOf(config) {
  try {
    return hostFor(config).sync;
  } catch {
    return null;
  }
}
function prBody(config, number) {
  try {
    const p = prHostOf(config)?.pr.get(number);
    return p ? String(p.body ?? '') : null;
  } catch {
    return null;
  }
}
function setPrBody(config, number, body) {
  try {
    prHostOf(config).pr.update(number, { body });
    return { status: 0 };
  } catch (error) {
    return { status: 1, error: String(error.message).split('\n').pop() };
  }
}

export function postDecision(config, cwd, { keys, pr, outcome, reason, findings, delivery = null, prCheck = null, dropIds = [] }) {
  const board = path.join(INSTALL_ROOT, 'scripts/board/board.mjs');
  const dir = path.join(config.root, config.stateDir, 'pr-check');
  // The PR body states it too: the decision first, each ticket's outcome in the stories table, no follow-up for a
  // line that became a question.
  const prNumber = String(pr).match(/(\d+)\/?$/)?.[1];
  if (prNumber && prHostOf(config)?.ownsPr(pr)) {
    const was = prBody(config, prNumber);
    if (was != null) {
      const issues = keys.map((k) => { try { const i = loadTicket(config, k, { fetch: false })?.issue; return i?.number ?? i ?? null; } catch { return null; } }).filter(Boolean);
      const next = withDecision(was.replace(/\n$/, ''), { keys, outcome, reason, issues, prCheck, dropIds });
      const e = setPrBody(config, prNumber, next);
      log(`PR #${prNumber}: ${e.status === 0 ? 'body states the decision' : `body not updated (${e.error})`}`);
    }
  }
  for (const key of keys) {
    const file = path.join(dir, `${key}-${outcome}.json`);
    writeJson(file, { key, outcome, reason, findings, pr, finishedAt: nowIso() });
    const f = spawnSync(process.execPath, [board, 'fail', key, '--result', file], { cwd, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: cwd } });
    log(`${key}: ${f.status === 0 ? `${outcome}: the decision is on the ticket and the PR with the escalation questions` : `${outcome}: the decision was not posted (${String(f.stderr || f.stdout).trim().split('\n').pop()})`}`);
  }
  let extra = [];
  if (delivery) {
    const file = path.join(dir, `delivery-${String(pr).split('/').pop()}.json`);
    writeJson(file, delivery);
    extra = ['--delivery', file];
  }
  regateWith(cwd, pr, extra);
}

// The loop state that resumes at the fix of round 1 with a report round's upheld findings (full objects, with
// their `fix`), so the fixer works on exactly what that round upheld. Null when there is nothing to fix.
export function seedFromReport(file, head) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const upheld = Array.isArray(report?.upheldFindings) ? report.upheldFindings : [];
  if (!upheld.length) return null;
  const entry = { round: 1, score: report.score ?? null, lensScores: report.lensScores ?? {}, raised: upheld.length, upheld, failedLenses: [], summary: 'report round (Stop hook)' };
  return { round: 1, phase: 'fix', head, history: [entry], previousUpheld: [], streak: upheld.map((f) => [f.id, 1]), seeded: true };
}

// Each finding the fixer reported it could not fix, once, with the finding's title and the fixer's reason.
export function fixerNotesOf(history = []) {
  const titles = new Map(history.flatMap((h) => (h.upheld ?? []).map((f) => [f.id, f.title])));
  const seen = new Map();
  for (const h of history) for (const n of h.fix?.notFixed ?? []) if (n?.id && !seen.has(n.id)) seen.set(n.id, { id: n.id, title: titles.get(n.id) ?? null, reason: String(n.reason ?? '') });
  return [...seen.values()];
}

function updateStoryNotes(config, ctx, history, commits) {
  const fixes = fixesOf(history);
  let changed = false;
  for (const t of ctx.tickets ?? []) {
    try {
      const before = fs.readFileSync(t.file, 'utf8');
      const after = withNotesUpdate(before, fixes, commits);
      if (after !== before) {
        writeText(t.file, after);
        changed = true;
        log(`${t.key}: Implementation Notes updated with what the PR check fix changed`);
      }
    } catch (error) {
      log(`${t.key}: Implementation Notes not updated (${error.message})`);
    }
  }
  return changed;
}

// The updated tickets go to the board, and are fetched back, so the board, CI's plan check and the reviewer read them.
function publishTickets(config, ctx) {
  const board = path.join(INSTALL_ROOT, 'scripts/board/board.mjs');
  for (const t of ctx.tickets ?? []) {
    const p = spawnSync(process.execPath, [board, 'publish', t.key], { cwd: ctx.workRoot, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: ctx.workRoot } });
    log(`${t.key}: ${p.status === 0 ? 'ticket published with the updated notes' : `ticket not published (${String(p.stderr || p.stdout).trim().split('\n').pop()})`}`);
  }
}

// D-C8-1: what the fixer changed reaches the PR body (a section the harness owns, resolved Follow-ups removed) and
// each ticket's issue, so neither the reviewer nor the board reads a description of the PR as it was before.
function publishFixNote(config, ctx, history, commits) {
  const fixes = fixesOf(history);
  const note = fixNote(fixes, commits);
  if (!note) return;
  const current = prBody(config, ctx.pr.number);
  const body = withFixNote(current ?? ctx.pr.body, note, fixes.fixed);
  const edited = setPrBody(config, ctx.pr.number, body);
  log(edited.status === 0 ? `PR #${ctx.pr.number}: body updated with what the PR check changed` : `PR #${ctx.pr.number}: body not updated (${edited.error})`);
  for (const t of ctx.tickets ?? [ctx.story]) {
    const issue = readJson(path.join(t.dir, 'meta.json'), null)?.issue?.number;
    if (!issue) continue;
    try {
      trackerFor(config).tickets.comment(issue, `${note}\n\nPull request: ${ctx.pr.url}\n`);
    } catch {
      log(`${t.key}: the PR check note was not posted on #${issue}`);
    }
  }
}

// The follow-ups across the rounds (a finding the judge dismissed as pre-existing or out of scope, a non-blocking
// member's feedback), once each: by id, or by what it says when it has none.
export function followUpsOf(history = []) {
  const seen = new Map();
  const key = (u) => u.id ?? `${u.lens ?? ''}\u0000${u.title ?? ''}\u0000${u.reason ?? ''}`;
  for (const entry of history) for (const u of entry.followUps ?? []) if (!seen.has(key(u))) seen.set(key(u), u);
  return [...seen.values()];
}

// What the video critic judged: each source with its size and modification time (a re-recording at the same path
// is a different video).
export function videoKeyOf(video, root) {
  const parts = (video?.videos ?? []).map((v) => {
    const file = path.isAbsolute(v.source ?? '') ? v.source : path.join(root ?? '.', v.source ?? '');
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    return [v.source, st?.size ?? null, st?.mtimeMs ?? null, v.duration];
  });
  return sha(JSON.stringify(parts));
}

async function runCheck(config, flags) {
  const { text, ...summary } = await executeCheck(config, flags);
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${text}\nReport: ${summary.report}`);
  return ['PASS', 'ACCEPTED'].includes(summary.verdict) ? 0 : 1;
}

function metrics(config, since) {
  const records = readMetricsLocal(config, CHECKS_FILE).filter((r) => !since || r.ts >= since);
  const targets = new Map();
  for (const r of records) targets.set(r.target, r);
  const finals = [...targets.values()];
  const upheldByLens = {};
  const upheldBySeverity = {};
  for (const r of records) {
    for (const u of r.upheld ?? []) {
      upheldByLens[u.lens] = (upheldByLens[u.lens] ?? 0) + 1;
      upheldBySeverity[u.severity] = (upheldBySeverity[u.severity] ?? 0) + 1;
    }
  }
  const raised = records.reduce((n, r) => n + (r.raised ?? 0), 0);
  const upheld = records.reduce((n, r) => n + (r.upheld?.length ?? 0), 0);
  return {
    rounds: records.length,
    checks: finals.length,
    perfect: finals.filter((r) => r.score === 10).length,
    firstRoundPerfect: records.filter((r) => r.round === 1 && r.score === 10).length,
    averageRounds: finals.length ? Math.round((records.length / finals.length) * 10) / 10 : 0,
    raised,
    upheld,
    upheldRate: raised ? Math.round((upheld / raised) * 100) / 100 : 0,
    upheldByLens,
    upheldBySeverity,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, VALUE_FLAGS);
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig('pr-check');
  // Every agent and stack run of a PR check leases a test-stack slot, and the stack guard refuses slot 0 to its agents,
  // as under implement (council C8 proof: a standalone CI gate's fixer ran `teststack up` on slot 0 and left it up),
  // while featureVerification.slots.enabled is on; FV_USE_SLOTS (0 or 1) overrides it. Its agents' guards read the
  // decision from FV_USE_SLOTS.
  exportSlots(config);

  switch (command) {
    case 'run':
      return runCheck(config, flags);

    // The pipeline's step after a PR opens, for an open PR: wait for CI (no checks yet keeps waiting; a PR GitHub cannot
    // merge gets the base merged), send a red check or a test that passed only on a retry through one fixing round, wait
    // again. Prints the outcome; delivered only when CI ran green on the first attempt of every test.
    case 'ci-gate': {
      const pr = String(flags.pr ?? '');
      const branch = String(flags.branch ?? '');
      if (!pr || !branch) throw new Error('usage: pr-check ci-gate --pr <url or number> --branch <head branch> (--story K | --stories A,B) [--base origin/main] [--fix-rounds N]');
      const { ciGate, ciLine, ciOutcome } = await import('../implement/lib/ci-wait.mjs');
      const targetArgs = flags.stories ? ['--stories', String(flags.stories)] : ['--story', String(flags.story ?? '')];
      const base = String(flags.base ?? setting(config, 'baseRef'));
      const { ciFixRounds } = await import('../implement/lib/ci-wait.mjs');
      const ci = await ciGate({ config, ciOptions: { ciSettings: config.implement?.reviewGate?.ci ?? {} }, fixRounds: flags['fix-rounds'] != null ? Number(flags['fix-rounds']) : ciFixRounds(config.implement), repo: config.board?.repo, pr, branch, cwd: config.root, prCheckCli: fileURLToPath(import.meta.url), targetArgs, base, seedFile: path.join(config.root, config.stateDir, 'pr-check', `ci-gate-${String(pr).split('/').pop()}.json`), log });
      appendJsonl(metricsFile(config, 'run-conditions.jsonl'), [{ ts: nowIso(), kind: 'ci', pr, state: ci.state, flaky: ci.flaky ?? [], fixed: ci.fixed ?? false, rounds: ci.rounds ?? 0, ...(ci.fixRun ? { fixVerdict: ci.fixRun.verdict } : {}) }]);
      // What a person must decide never stays on this disk (council C7): the tickets fail on the board with the options
      // on the ticket and the PR, and the gate holds the merge at any severity.
      const { deliveryDecision } = await import('../implement/lib/ci-wait.mjs');
      const delivery = deliveryDecision(ci);
      const keys = flags.stories ? String(flags.stories).split(',').map((k) => k.trim()).filter(Boolean) : [String(flags.story ?? '')].filter(Boolean);
      const prUrl = /^\d+$/.test(pr) && String(prHostOf(config)?.repo ?? '') ? prHostOf(config).prUrl(pr) : pr;
      if (delivery) postDecision(config, config.root, { keys, pr: prUrl, outcome: delivery.outcome, reason: delivery.reason, findings: delivery.findings, delivery });
      else regateWith(config.root, prUrl, ['--delivery-clear']);
      console.log(JSON.stringify({ pr, state: ci.state, outcome: delivery?.outcome ?? ciOutcome(ci), line: delivery?.reason ?? ciLine(ci), flaky: ci.flaky ?? [], fixed: ci.fixed ?? false, rounds: ci.rounds ?? 0, fixRun: ci.fixRun ?? null }));
      return delivery ? 1 : 0;
    }

    case 'status': {
      const root = path.join(config.root, config.stateDir, 'pr-check');
      const ids = positional.length ? positional : fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'result.json'))) : [];
      if (!ids.length) console.log('No PR checks have run yet.');
      for (const id of ids) {
        const r = readJson(path.join(resultDir(config, id), 'result.json'), null);
        if (!r) {
          console.log(`${id.padEnd(10)} no result`);
          continue;
        }
        console.log(`${id.padEnd(10)} ${r.verdict} ${r.score}/10 after ${r.rounds} round(s), ${r.openFindings.length} open finding(s)  ${r.report}`);
        if (positional.length) for (const f of r.openFindings) console.log(`  - [${f.severity}] ${f.id} ${f.title}`);
      }
      return 0;
    }

    case 'resume': {
      const force = Boolean(flags.force);
      const lines = [...recoverHookRuns(config, { key: positional[0], force }), ...resumeRuns(config, { id: positional[0], force })];
      console.log(lines.join('\n') || 'No interrupted PR checks.');
      return 0;
    }

    case 'metrics': {
      const m = metrics(config, typeof flags.since === 'string' ? flags.since : null);
      if (flags.json) console.log(JSON.stringify(m, null, 2));
      else {
        console.log(`PR checks: ${m.checks} checks, ${m.rounds} rounds (average ${m.averageRounds}), ${m.perfect} reached 10/10, ${m.firstRoundPerfect} on the first round`);
        console.log(`Findings: ${m.raised} raised, ${m.upheld} upheld (rate ${m.upheldRate}); by lens ${Object.entries(m.upheldByLens).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
      }
      return 0;
    }

    case 'hook': {
      const event = positional[0];
      // story-start comes from the `pipeline start` command, not an agent hook, so it resets even when hooks are disabled.
      if (event === 'story-start') {
        resetPrCheck(config, requireStory(config, positional[1]));
        return 0;
      }
      if (isDisabled()) return 0;
      const payload = await readPayload();
      const story = activeStory(config);
      if (event === 'stop') {
        const output = story ? hookStop(config, story, payload) : null;
        if (output) process.stdout.write(JSON.stringify(output));
        return 0;
      }
      if (event === 'session-start') {
        process.stdout.write([sessionContext(config, story), ...interruptedRuns(config)].filter(Boolean).join('\n'));
        return 0;
      }
      console.error(`Unknown hook event "${event}".`);
      return 2;
    }

    case 'recheck': {
      const bg = recheck(config, requireStory(config, positional[0]));
      console.log(bg ? `PR check: waiting for the tests to verify, then a new report round (log: ${bg.log}).` : 'PR check: no implementation to check.');
      return bg ? 0 : 1;
    }

    case 'hook-run': {
      if (typeof flags.hash !== 'string') throw new Error('hook-run needs --hash <impl-hash>');
      return hookRun(config, requireStory(config, positional[0]), flags.hash, executeCheck);
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

// The re-verification leases a test-stack slot and holds it for the pass, as under implement (council C7, live #120: a
// PR check run on its own re-verified the fixer's tests on slot 0, the shared default stack, and rebuilt it).
// featureVerification.slots.enabled (FV_USE_SLOTS) decides, as for every test run.
export const reverifyEnv = (base, root) => ({ ...base, PIPELINE_ROOT: root });

// Feature verification of every ticket the fixes made stale (`check` fails for it): plan, then automate, each
// re-verifying with its own verifier, then one commit. Nothing to do when the fixes touched none of it.
// After a fix round (`scoped`): the plan and the tests are checked as they are (`--verify-first`): a planner or an
// automation agent runs only on gaps the verifiers find, cases kept for upheld findings stay, and the whole test
// projects do not run. Before the push, the tickets re-verified in scoped mode get one full verification
// (council C5: the re-plan after each fix undid the fixer's work and dominated the wall-clock).
export function reverifyAfterFixes(config, ctx, deps = {}, { scoped = false } = {}) {
  const fv = path.join(INSTALL_ROOT, 'scripts/feature-verification/feature-verification.mjs');
  const env = reverifyEnv(process.env, ctx.workRoot);
  // Each feature verification call's output goes to a log file (council C5/C6: the re-check left no record).
  const logFile = path.join(ctx.workRoot, setting(config, 'stateDir'), 'logs', `${ctx.id}-reverify-${nowIso().replace(/[:.]/g, '-')}.log`);
  const run = deps.run ?? ((...args) => {
    const r = spawnSync(process.execPath, [fv, ...args], { cwd: ctx.workRoot, env, encoding: 'utf8' });
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      appendText(logFile, `$ feature-verification ${args.join(' ')} (exit ${r.status})\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
    } catch {
      // the log is a record, not a requirement
    }
    return r;
  });
  const git = deps.git ?? gitIn;
  const keys = ctx.multi ? ctx.tickets.map((t) => t.key) : [ctx.story.key];
  ctx.scopedKeys = ctx.scopedKeys ?? new Set();
  const check = run('check', '--changed-from', ctx.baseRef);
  if (check.status === 0) {
    if (!scoped) {
      for (const key of [...ctx.scopedKeys]) {
        log(`${key}: one full verification of the tests before the push (whole test projects included)`);
        const full = run('automate', key, '--verify-first');
        log(`${key}: full verification ${full.status === 0 ? 'passed' : `failed (exit ${full.status}); the push will be refused`}`);
      }
      ctx.scopedKeys.clear();
    }
  } else {
    for (const key of keys) {
      if (!new RegExp(`\\b${key}\\b`).test(`${check.stdout}${check.stderr}`)) continue;
      log(`${key}: the fixes changed its verified test plan or tests; feature verification checks them as they are${scoped ? ' (scoped)' : ''}`);
      const plan = run('plan', key, '--verify-first');
      const automate = plan.status === 0 ? run('automate', key, '--verify-first', ...(scoped ? ['--scoped'] : [])) : plan;
      if (scoped && automate.status === 0) ctx.scopedKeys.add(key);
      else ctx.scopedKeys.delete(key);
      log(`${key}: feature verification ${automate.status === 0 ? 'verified it again' : `did not verify it again (exit ${automate.status}); the push will be refused`}`);
    }
  }
  git(ctx.workRoot, ['add', '-A']);
  if (git(ctx.workRoot, ['diff', '--cached', '--quiet']).status !== 0) gateStaged(ctx.workRoot, { message: 're-verified test plan and tests' });
  if (git(ctx.workRoot, ['diff', '--cached', '--quiet']).status !== 0) git(ctx.workRoot, ['commit', '-q', '-m', `${ctx.story.key}: Re-verified test plan and tests after the PR check fixes`]);
}

// Run as a command (not when a test imports reverifyAfterFixes).
const entry = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (entry) runMain(main, 'pr-check');
