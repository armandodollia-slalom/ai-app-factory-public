import { writeText } from '../../pipeline/lib/redact.mjs';
import fs from 'node:fs';
import { reportFor } from '../../pipeline/lib/analysis/fixloop.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDefinition, runAgent } from '../../pipeline/lib/agents.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { formatBugs, logDecision, normalizeBugs } from '../../pipeline/lib/decisions.mjs';
import { decisionsBlock, readDecisions } from '../../pipeline/lib/human-decisions.mjs';
import { INSTALL_ROOT, repoOverlay } from '../../pipeline/lib/config.mjs';
import { git, implChanges, mergeBase } from '../../pipeline/lib/git.mjs';
import { changedLines, lintable, lintChanged, linterName } from '../../pipeline/lib/lint.mjs';
import { readEvidence, formatEvidence } from './evidence.mjs';
import { NO_SLOT, holdStorySlot, onLeasedSlot, withAgentSlot } from './slots.mjs';
import {
  INDEX,
  automationFiles,
  automationSha,
  caseDecisions,
  planContentSha,
  tidyPlan,
  planStatus,
  precheckPlan,
  readPlan,
  stampIndex,
} from './plans.mjs';
import { clearEscalation, escalate, lockFile, logFile, loadState, metricsFile, updateState } from '../../pipeline/lib/state.mjs';
import { RECOVERY_DONE, nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { caseIdsIn, casePrefix, storyMatches, storySha } from '../../pipeline/lib/stories.mjs';
import { storyVersion } from '../../board/lib/source.mjs';
import { acquireLock, appendJsonl, extractResult, lockHolder, log, nowIso, releaseLock, run, runAsync, selfProcess, sleep, tail } from '../../pipeline/lib/util.mjs';
import { coveringUnits, expandArgv as expand, fenceLang, planRuns, runnerFor, sharedFixtureErrors, tagError, taggingLines, testRunners } from './runners.mjs';
import { servicesOfFile } from '../../implement/lib/project.mjs';
import { PRODUCER, formatGaps, stagePassScore, verifyRound } from './verify.mjs';
import { ownerQuestionsText } from '../../pipeline/lib/intercom.mjs';
import { decide, producerRun } from '../../pipeline/lib/orchestrator.mjs';
import { addRequired, requiredFor, requiredProducerText, unmetRequired } from './required.mjs';
import { resolvesGiven, routeToRole } from '../../pipeline/lib/finding-route.mjs';
import { councilActionsText, councilFor, councilRounds, fixDeclarationText, fixesFile, guardProtectedTests, lateBox, planCases, protectedTestFinding } from '../../pipeline/lib/council.mjs';

// A contradiction between council members (verdict.council.contradictions) that the round before also had: no evidence
// settled it, so it is a question for the ticket's owner (escalated like a loop that cannot finish). Updates `seen`.
export function repeatedContradictions(verdict, seen) {
  const now = (verdict?.council?.contradictions ?? []).map((c) => String(c.subject));
  // The council contradicting its own earlier ruling after an adjudication (`escalate`) is a question at once.
  const repeated = [...new Set([...now.filter((c) => seen.has(c)), ...(verdict?.council?.contradictions ?? []).filter((c) => c.escalate).map((c) => String(c.subject))])];
  seen.clear();
  for (const c of now) seen.add(c);
  return repeated;
}

// Non-blocking council members' notes (late feedback, outvoted and minor findings) for the producer's next round.
// not-an-agent: a text helper; each caller routes
const councilNotes = (verdict) => (verdict?.notes?.length ? `\n\nNon-blocking notes from the council (act on them only when they are right for the ticket):\n${formatGaps(verdict.notes)}` : '');

const FV_SCRIPT = fileURLToPath(new URL('../feature-verification.mjs', import.meta.url));
// How an agent in the app repository calls this script: relative when the engine is inside the checkout,
// else by its absolute path in the install root.
// How an agent runs feature verification: the factory's command, never the install's script by path, which the
// read guard denies (council C3: about a dozen denied tries per round, because this line named the script). The
// factory working on itself runs its own script.
export const fvCommandFor = (config) => (FV_SCRIPT.startsWith(`${config.root}${path.sep}`) ? `node ${fvScriptFor(config)}` : 'factory feature-verification');
const fvScriptFor = (config) => (FV_SCRIPT.startsWith(`${config.root}${path.sep}`) ? path.relative(config.root, FV_SCRIPT).split(path.sep).join('/') : FV_SCRIPT);

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n\`\`\`\``;
const readRel = (config, rel) => fs.readFileSync(path.join(config.root, rel), 'utf8');


function logPrecheck(config, stage, story, round, errors) {
  appendJsonl(metricsFile(config, 'precheck-failures.jsonl'), {
    ts: nowIso(),
    stage,
    story: story.key,
    round,
    agent_prompt_ver: agentDefinition(config, PRODUCER[stage]).version,
    errors,
  });
}

// The linters the repo's pre-commit hook runs (config precheck.lint, by file extension), so a lint error in
// the agent's files comes back to it as feedback instead of failing the harness's commit afterwards. A
// linter that is not installed in the checkout (a local node_modules/.bin path that is missing) is skipped,
// like the hook does.
// Auto-fixes the agent's files with the same tools the linters use (precheck.fix), so formatting
// (whitespace, import order, a formatter's rules) never costs an automation round. Exit codes
// are ignored: whatever the fixers cannot fix, lintFiles reports.
export function fixFiles(config, files, { runner = run } = {}) {
  const fixed = [];
  for (const [ext, template] of Object.entries(config.featureVerification.precheck.fix ?? {})) {
    const matching = lintable(config, files).filter((f) => f.endsWith(ext));
    if (!matching.length || !template?.length) continue;
    const head0 = expand([template[0]], { packs: path.join(INSTALL_ROOT, 'packs'), factoryBin: path.join(INSTALL_ROOT, 'node_modules', '.bin') })[0];
    if (head0.includes('/') && !fs.existsSync(path.resolve(config.root, head0))) continue;
    const argv = expand(template, { files: matching, packs: path.join(INSTALL_ROOT, 'packs'), factoryBin: path.join(INSTALL_ROOT, 'node_modules', '.bin') });
    runner(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: 300 });
    fixed.push(...matching);
  }
  return fixed;
}

export function lintFiles(config, files, { runner = run } = {}) {
  const errors = [];
  for (const [ext, template] of Object.entries(config.featureVerification.precheck.lint ?? {})) {
    const matching = lintable(config, files).filter((f) => f.endsWith(ext));
    if (!matching.length || !template?.length) continue;
    // A configured linter that is not installed is a problem to fix in the checkout, not a pass.
    const head = expand([template[0]], { packs: path.join(INSTALL_ROOT, 'packs'), factoryBin: path.join(INSTALL_ROOT, 'node_modules', '.bin') })[0];
    if (head.includes('/') && !fs.existsSync(path.resolve(config.root, head))) {
      // Only a linter the repository configured itself is a problem when missing; the engine's default
      // (markdownlint from the repository's own node_modules) is simply not available there.
      if (!(ext in (repoOverlay(config.root).featureVerification?.precheck?.lint ?? {}))) continue;
      errors.push(`\`${template[0]}\` (precheck.lint for ${ext}) is not installed in this checkout, so ${matching.join(', ')} could not be linted: run the repository's install (the implement prepareCmd), then try again.`);
      continue;
    }
    const argv = expand(template, { files: matching, packs: path.join(INSTALL_ROOT, 'packs'), factoryBin: path.join(INSTALL_ROOT, 'node_modules', '.bin') });
    const result = runner(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: 300 });
    if (result.status !== 0 && result.status !== 127) errors.push(`\`${linterName(argv)}\` (the commit hook's linter) failed on ${matching.join(', ')}:\n${tail(`${result.stdout ?? ''}${result.stderr ?? ''}`, 3000)}`);
  }
  return errors;
}

// Finds the version of the story the plan was written against (the ticket cache keeps every version it
// fetched, by story sha; else the issue's edit history) and diffs it with the current story, so an update
// can edit the affected cases in place instead of rewriting the plan.
export function storyDiffSince(config, story, oldSha, { version = storyVersion } = {}) {
  if (!oldSha) return null;
  const current = config.abs(story.file);
  if (!fs.existsSync(current) || storyMatches(oldSha, fs.readFileSync(current, 'utf8'))) return null;
  const old = version(config, story.key, oldSha);
  if (old == null) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'story-diff-'));
  try {
    const before = path.join(tmp, 'story.md');
    writeText(before, old);
    const diff = git(config.root, ['diff', '--no-index', '--no-ext-diff', '--', before, current]).stdout;
    return diff ? diff.replaceAll(before, `${story.key}@${oldSha}`).replaceAll(current, story.file) : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Workflow 1: story -> integration test plan, verified by a fresh verifier until it scores 10/10
// ---------------------------------------------------------------------------------------------

// A human's answers to an earlier run's escalation questions (decisions.md next to the cached story).
const humanDecisions = (config, story) => readDecisions(path.join(config.root, story.file));

// Cases kept for an upheld PR check finding (front matter `kept-for: <finding id>`, stamped by the PR check harness
// on the cases its fixer added or changed). They are regression cases the code after the fix must pass: in scope even
// when the story does not describe that behaviour, and never removed by a re-plan (council C5: a re-plan deleted a
// fixer's regression case as an invented requirement).
export const keptCases = (plan) => plan.cases.filter((c) => c.data?.['kept-for']);
const keptBlock = (plan) => {
  const kept = keptCases(plan);
  return kept.length ? ['', '### Cases kept for upheld PR check findings', '', `${kept.map((c) => `- ${c.data.id} (${c.file}), kept for ${c.data['kept-for']}`).join('\n')}`, '', 'These cases are regression cases for findings a PR check upheld and its fixer fixed. They are in scope although the story does not describe that behaviour, and the code after the fix is the truth for them: keep them, keep their ids and `kept-for`, and never report them as invented requirements. The story\'s Implementation Notes are the implementer\'s account and may predate the fix.'] : [];
};

// With a council for the stage, the producer fixing the last round's gaps says which lines answer which gap
// (council.mjs fixDeclarationText); '' otherwise.
function declareFixes(config, story, stage, gaps) {
  if (!councilFor(config, stage) || !gaps?.length) return '';
  const text = fixDeclarationText(fixesFile(config.root, config.stateDir, { stage, story: story.key }), gaps);
  return text ? `\n\n${text}` : '';
}

function planTask(config, story, { mode, reasons, storyDiff, feedback }) {
  const lines = [
    `Story: ${story.key} (${story.file})`,
    `Plan directory: ${story.planDir}`,
    `Mode: ${mode}${reasons?.length ? ` (${reasons.join('; ')})` : ''}`,
    `Case id format: ${casePrefix(story.key)}NN (two or more digits)`,
    `Allowed sad-path values: ${config.featureVerification.categories.sadPathSubtypes.join(', ')}`,
    '',
    '### Story',
    '',
    fence(readRel(config, story.file), 'markdown'),
    ...decisionsBlock(humanDecisions(config, story), 'feature-verification'),
    ...keptBlock(readPlan(config, story)),
  ];
  if (mode === 'update') {
    lines.push('', '### What changed in the story since the plan was written', '');
    lines.push(storyDiff ? fence(storyDiff, 'diff') : 'No diff is available; compare the story with the existing case files yourself.');
    lines.push('', 'Update the existing plan in place: keep the ids of cases that still apply, edit the ones affected by the change, delete cases the story no longer supports, and add new cases with the next unused number.');
  }
  if (feedback) lines.push('', '### Fix every item from the previous round', '', feedback);
  return lines.join('\n');
}

function planVerifierTask(config, story, plan) {
  const lines = [
    `Story: ${story.key}`,
    `Required score: ${stagePassScore(config, 'plan')}/10`,
    `Allowed categories: ${config.featureVerification.categories.plan.join(', ')}`,
    `Allowed missing-sad-path subtypes: ${config.featureVerification.categories.sadPathSubtypes.join(', ')}`,
    '',
    '### Story',
    '',
    fence(readRel(config, story.file), 'markdown'),
    ...decisionsBlock(humanDecisions(config, story), 'verify'),
    '',
    `### Plan index (${story.planDir}/${INDEX})`,
    '',
    fence(plan.index?.body ?? '(missing)', 'markdown'),
    '',
    '### Case files',
  ];
  lines.splice(lines.indexOf('### Case files'), 0, ...keptBlock(plan), '');
  for (const c of plan.cases) lines.push('', `#### ${c.file}`, '', fence(c.text, 'markdown'));
  return lines.join('\n');
}

// Why the plan agent wrote this plan: its summary and exclusions, and each case's "## Why".
// Logged every round that passes the precheck, so it pairs with that round's verifier decision.
function logPlanDecision(config, story, round, producer, feedback) {
  const reported = extractResult(producer.output) ?? {};
  const excluded = (Array.isArray(reported.excluded) ? reported.excluded : []).map((e) =>
    e && typeof e === 'object' ? { item: e.item ?? null, reason: e.why ?? e.reason ?? null } : { item: String(e), reason: null },
  );
  logDecision(config, {
    stage: 'plan',
    story: story.key,
    round,
    agent: PRODUCER.plan,
    agentVer: producer.version,
    subject: PRODUCER.plan,
    decision: 'plan-written',
    reason: reported.summary ?? null,
    trigger: round === 1 && !feedback ? 'story' : 'feedback',
    excluded,
    items: caseDecisions(readPlan(config, story)),
  });
}

// verifyFirst (after a PR check fix edited the plan): the plan is checked as it is by a fresh verifier before any
// planner run; the planner runs only on the gaps it finds (council C5: re-planning from the story undid the fixer's work).
// Why a verifier loop ended without a pass: the last round's lowest score and its open gaps, against what passing needs
// (dogfood C15: "plan did not reach 9/10" for a plan whose last rounds scored 9/10 with one open gap).
// An owner question from the council discussion stops the stage for the owner: neither the planner nor the test writer
// can answer it, and later rounds hold no discussion.
export function ownerEscalation(config, story, stage, verdict) {
  if (!verdict.ownerQuestions?.length) return null;
  // not-an-agent: an escalation to a person
  escalate(config, story, stage, 'the council discussion needs an owner decision', ownerQuestionsText(verdict.ownerQuestions));
  return { status: 'escalated', reason: 'owner question' };
}

export function notPassed(config, score, gaps = [], stage = 'plan') {
  const open = gaps.length;
  return `last round: lowest score ${score ?? 'none'}/10, ${open} open gap(s); passing needs ${stagePassScore(config, stage)}/10 and no open gap`;
}

export async function planLoop(config, story, { force = false, resume = false, seedFeedback = null, maxRounds = councilRounds(config, 'testPlan'), verifyFirst = false } = {}) {
  const lock = lockFile(config, story.key, 'plan');
  if (!acquireLock(lock)) {
    log(`${story.key}: plan run already in progress (pid ${lockHolder(lock)}).`);
    return { status: 'busy' };
  }
  const finished = (status, extra = {}) => updateState(config, story.key, (s) => Object.assign(s.plan, { status, pid: null, boot: null, ...RECOVERY_DONE, finishedAt: nowIso(), ...extra }));
  try {
    tidyPlan(config, story);
    const initial = planStatus(config, story);
    // Required cases a later stage upheld that the plan does not name yet: the planner runs on them (required.mjs).
    const requiredUnmet = unmetRequired(config, story, 'plan');
    if (requiredUnmet.length && !seedFeedback) seedFeedback = requiredProducerText(requiredUnmet, 'plan');
    if (initial.state === 'verified' && !force && !seedFeedback) {
      log(`${story.key}: plan is verified and up to date.`);
      finished('verified');
      return { status: 'verified' };
    }
    const saved = resume ? loadState(config, story.key).plan.progress : null;
    updateState(config, story.key, (s) => Object.assign(s.plan, { status: 'running', ...selfProcess(), startedAt: nowIso() }));
    let firstFeedback = null;
    const late = lateBox();
    const contested = new Set();
    if (verifyFirst && !force && !resume && initial.state === 'unverified' && !precheckPlan(config, story).errors.length) {
      const verdict = await verifyRound(config, { stage: 'plan', story, round: 0, producerVersion: 'unchanged', task: planVerifierTask(config, story, readPlan(config, story)), late });
      if (verdict.passed) {
        stampIndex(config, story, { 'plan-sha': planContentSha(readPlan(config, story)), 'verified-score': verdict.score, 'verified-at': nowIso(), 'verified-by': `as-is/${verdict.verifierVersion}` });
        clearEscalation(config, story, 'plan');
        finished('verified', { rounds: 0 });
        log(`${story.key}: the edited plan verified ${verdict.score}/10 as it is (no planner run).`);
        return { status: 'verified', rounds: 0 };
      }
      // route: resolvesGiven (the plan verifier's gaps of a changed plan are the planner's)
      if (!verdict.error) firstFeedback = `The plan was edited after verification (by a PR check fix) and the verifier found gaps. Fix only these; keep everything else as it is:\n${formatGaps(verdict.gaps)}`;
    }
    const keptSnapshot = new Map(keptCases(readPlan(config, story)).map((c) => [c.file, fs.readFileSync(path.join(config.root, c.file), 'utf8')]));
    const mode = initial.state === 'missing' ? 'create' : 'update';
    const storyDiff = mode === 'update' ? storyDiffSince(config, story, initial.plan.index?.data['story-sha']) : null;
    let feedback = resume ? resumeFeedback('plan', saved?.feedback ?? seedFeedback) : (seedFeedback ?? firstFeedback);
    let lastGaps = [];
    let lastScore = null;
    // The stage's orchestrator decides who writes the plan: the test planner, or itself (kept on resume).
    const led = saved?.orchestrator ?? await decide(config, {
      section: 'testPlan',
      stage: 'test plan',
      story: story.key,
      work: 'the test plan of the story: every happy and sad path as test cases, one Markdown file per case',
      delegateTo: 'the test planner (`test-planner`)',
      context: `Story ${story.key}: ${story.file}. The plan is ${initial.state} (${mode}).${feedback ? `\n\nWhat the plan must address:\n${feedback}` : ''}`,
      run: (o) => runAgent(config, { ...o, timeoutSec: config.featureVerification.timeoutsSec.plan }),
    });
    const selfDo = led.decision === 'self' ? led : null;
    for (let round = Math.min(saved?.round ?? 1, maxRounds); round <= maxRounds; round++) {
      updateState(config, story.key, (s) => (s.plan.progress = { round, feedback, orchestrator: led }));
      log(`${story.key}: plan round ${round}/${maxRounds} (${mode})${selfDo ? ', written by the orchestrator' : ''}`);
      const producer = runAgent(config, {
        mode: 'write',
        timeoutSec: config.featureVerification.timeoutsSec.plan,
        usage: { stage: 'plan', story: story.key, round },
        ...producerRun(config, { agent: PRODUCER.plan, selfDo, task: planTask(config, story, { mode: round === 1 ? mode : 'update', reasons: initial.reasons, storyDiff, feedback }) + declareFixes(config, story, 'testPlan', lastGaps) }),
      });
      if (!producer.ok) {
        feedback = `The previous run ${producer.timedOut ? 'timed out' : `failed (exit ${producer.status})`}. Finish the plan.`;
        continue;
      }
      stampIndex(config, story, { 'plan-sha': undefined, 'verified-score': undefined, 'verified-at': undefined, 'verified-by': undefined });
      // A kept case the planner removed or rewrote is put back as it was.
      for (const [file, text] of keptSnapshot) {
        const abs = path.join(config.root, file);
        // Removed or rewritten in any way (council C6: a rewrite that kept the marker escaped the old check).
        if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== text) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          writeText(abs, text);
          log(`${story.key}: restored ${path.basename(file)}, a case kept for an upheld PR check finding, after the planner removed or changed it`);
        }
      }
      tidyPlan(config, story);
      const pre = precheckPlan(config, story);
      if (!pre.errors.length) pre.errors.push(...lintFiles(config, [...(pre.plan.index ? [`${story.planDir}/${INDEX}`] : []), ...pre.plan.cases.map((c) => c.file)]));
      if (pre.errors.length) {
        logPrecheck(config, 'plan', story, round, pre.errors);
        // The verifier's last gaps stay in the feedback: a structural fix must not bring back what the verifier rejected
        // (council C9 proof run: sad cases added for the check were rejected as invented, removed, and demanded again).
        // not-an-agent: harness checks; the gaps it repeats were routed in their round (resolvesGiven)
        feedback = `Structural check failed:\n${pre.errors.map((e) => `- ${e}`).join('\n')}${lastGaps.length ? `\n\nThe verifier's points from the last verified round still apply; do not undo them:\n${formatGaps(lastGaps)}` : ''}`;
        continue;
      }
      logPlanDecision(config, story, round, producer, feedback);
      // One council sitting a round: a council that passes once verifies the plan.
      const verdict = await verifyRound(config, {
        stage: 'plan',
        story,
        round,
        producerVersion: producer.version,
        task: planVerifierTask(config, story, readPlan(config, story)),
        late,
      });
      if (verdict.error) {
        feedback = null;
        continue;
      }
      const owner = ownerEscalation(config, story, 'plan', verdict);
      if (owner) {
        finished('escalated');
        return owner;
      }
      if (verdict.passed) {
        const plan = readPlan(config, story);
        stampIndex(config, story, {
          'plan-sha': planContentSha(plan),
          'verified-score': verdict.score,
          'verified-at': nowIso(),
          'verified-by': `${PRODUCER.plan}@${producer.version}/${verdict.verifierVersion}`,
        });
        clearEscalation(config, story, 'plan');
        finished('verified', { rounds: round });
        log(`${story.key}: plan verified ${verdict.score}/10 after ${round} round(s).`);
        return { status: 'verified', rounds: round };
      }
      lastGaps = verdict.gaps;
      lastScore = verdict.score;
      const repeated = repeatedContradictions(verdict, contested);
      if (repeated.length) {
        // not-an-agent: an escalation to a person
        escalate(config, story, 'plan', 'council members contradict each other', `The test plan verifier council disagrees on ${repeated.join('; ')} two rounds running, and the evidence has not settled it. The ticket's owner decides.\n\n${formatGaps(verdict.gaps)}`);
        finished('escalated');
        return { status: 'escalated', reason: 'council members contradict each other' };
      }
      // The planner gets the gaps a plan change resolves; a gap its verifier says only production code resolves is named
      // as not the planner's (it stays in the verdict and the escalation).
      // route: resolvesGiven
      const notPlan = verdict.gaps.filter((g) => { const r = resolvesGiven(g); return r.length > 0 && !r.includes('plan') && !r.includes('tests'); });
      const planOwn = verdict.gaps.filter((g) => !notPlan.includes(g));
      feedback = `The verifier scored the plan ${verdict.score}/10. Fix every gap:\n${formatGaps(planOwn)}${notPlan.length ? `\n\nNot for the plan (a production change resolves them; do not act on them): ${notPlan.map((g) => g.case ?? g.detail).join('; ')}` : ''}${councilNotes(verdict)}`;
    }
    // not-an-agent: an escalation to a person
    escalate(config, story, 'plan', `plan did not pass in ${maxRounds} rounds (${notPassed(config, lastScore, lastGaps)})`, lastGaps.length ? formatGaps(lastGaps) : feedback ?? '');
    finished('escalated');
    return { status: 'escalated' };
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------------------------
// Workflow 2: verified plan -> scenario + automated tests, verified until 10/10
// ---------------------------------------------------------------------------------------------

// A UI case (a test that recorded video) must show the state it asserts: at least one keyframe from the demo
// fixture's `highlight` (the element in view, outlined) or `absent` (where a hidden element would be). Step
// keyframes alone are taken wherever the page happens to be, often before the element is scrolled into view
// (council C1: four of a feature's five UI videos lasted about a second and never showed the section, and the
// automation verifier still scored 10). `precheck.requireUiEvidence: false` turns this off.
// The case ids of the story's UI cases in a run's evidence (tests that recorded video).
export const uiCaseIds = (tests, key) => [...new Set((tests ?? []).filter((t) => t.videos?.length).flatMap((t) => [...caseIdsIn(t.title ?? '', key)]))];
export const STATE_KEYFRAME = /(^|- )(highlight|absent): /;
export function uiEvidenceErrors(tests) {
  return tests
    .filter((t) => t.ok && t.videos?.length && !(t.keyframes ?? []).some((k) => STATE_KEYFRAME.test(k.label)))
    .map((t) => `${t.title}: this UI case records no keyframe of the state it asserts. Bring the element it checks into view and mark it with \`demo.highlight(locator, label)\` before or as you assert it; for a state where something must NOT be shown, mark the place where it would be with \`demo.absent(anchor, label)\` (the \`demo\` fixture of \`e2e/demo.ts\`).`);
}

// Feature verification runs on the test stack. When the repository has a stack runner (`stack: true`) and
// the plan has cases above the unit layer, at least one of the story's tests must run with it, and (when
// stories have scenarios) load the story's scenario: otherwise nothing ran against the running services and
// the scenario is dead (dogfood: 12 functional cases as in-process xUnit tests, a scenario no test
// loaded, and a backend PR with no recorded API calls). `precheck.requireStack: false` turns this off.
export function stackErrors(config, story, plan, tests, runners, scenarioRequired) {
  const stackRunners = runners.filter((r) => r.stack);
  if (!stackRunners.length || config.featureVerification.precheck?.requireStack === false || !tests.size) return [];
  if (!plan.cases.some((c) => ['functional', 'e2e'].includes(String(c.data.layer ?? '').toLowerCase()))) return [];
  const where = stackRunners.map((r) => (r.match ?? r.roots ?? []).join(', ')).filter(Boolean).join(' or ') || 'the stack runner\'s files';
  const onStack = [...tests.keys()].filter((f) => runnerFor(config, f, runners)?.runner.stack);
  if (!onStack.length) {
    return [`None of the story's tests runs on the test stack. Write the cases that exercise the running services (the main functional and e2e paths: API calls, UI flows) as stack tests (${where}) that load the scenario \`${story.scenario}\` and call the services on the stack's ports; keep in-process test projects for what the stack cannot reach.`];
  }
  if (scenarioRequired && story.scenario && !onStack.some((f) => (readRel(config, f) ?? '').includes(story.scenario))) {
    return [`No stack test loads the story's scenario \`${story.scenario}\` (${onStack.join(', ')}): load it before the tests run (the Project context names the helper).`];
  }
  return [];
}

// Files changed against the base (or new and untracked) in the folders of the story's test files or in its
// scenario folder that are not test files themselves; outside the plans folder and the harness's own paths.
export function supportFiles(config, testFiles, scenarioDir, base) {
  if (!base || !testFiles.length) return [];
  const dirs = [...new Set([...testFiles.map((f) => path.posix.dirname(f)).filter((d) => d !== '.'), scenarioDir])];
  if (!dirs.length) return [];
  const list = (args) => git(config.root, args).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const changed = [...list(['diff', '--name-only', base, '--', ...dirs]), ...list(['ls-files', '--others', '--exclude-standard', '--', ...dirs])];
  const harness = [`${config.featureVerification.plansDir}/`, '.factory/metrics/', '.factory/state/'];
  return [...new Set(changed)].filter((f) => !testFiles.includes(f) && !harness.some((h) => f.startsWith(h)) && !f.split('/').includes('graphify-out') && fs.existsSync(path.join(config.root, f)));
}

// `fullProjects`: also run each affected test project whole, as CI does (after the story's own tests pass). `e2e`: run the
// story's end-to-end specs on the stack. The automation loop runs rounds without the whole projects and runs them once
// when the verifier approves (wall-clock, council C4: they ran in every round).
export async function precheckAutomation(config, story, { skipTests = false, fix = true, fullProjects = true, e2e: runE2e = true } = {}) {
  const errors = [];
  const status = planStatus(config, story);
  if (status.state !== 'verified') errors.push(`Plan for ${story.key} is ${status.state}: ${status.reasons.join('; ')}.`);
  const planIds = new Set(status.plan.cases.map((c) => c.data.id).filter(Boolean));
  const { tests, scenarioDir, scenario } = automationFiles(config, story);
  const covered = new Set([...tests.values()].flatMap((ids) => [...ids]));
  for (const id of planIds) if (!covered.has(id)) errors.push(`${id} has no automated test (put the id in the test name).`);
  for (const id of covered) if (!planIds.has(id)) errors.push(`${id} is referenced by tests but is not in the plan (remove or rename it).`);
  // `precheck.scenarioFile` names the file every story's scenario folder must hold (null: no scenario needed).
  const scenarioFile = config.featureVerification.precheck.scenarioFile;
  if (scenarioFile && !scenario.some((f) => scenarioNames(scenarioFile).includes(path.posix.basename(f)))) errors.push(`Missing scenario: create ${scenarioDir}/${scenarioFile}.`);

  const runners = testRunners(config);
  for (const [file] of tests) {
    const error = tagError(config, file, readRel(config, file), story.key, runners);
    if (error) errors.push(error);
  }
  errors.push(...stackErrors(config, story, status.plan, tests, runners, Boolean(scenarioFile)));
  errors.push(...sharedFixtureErrors(config, [...tests.keys()], runners));
  if (errors.length) return { errors, tests };
  // Files the story created are auto-fixed and linted whole. Existing test files it extended are not
  // reformatted (that would put every untouched line of an upstream file into the PR): only the lines it
  // changed are linted, and their problems come back to the agent.
  const base = mergeBase(config.root, config.baseRef);
  // Support files the automation changed beside its tests (a fixture, an AssemblyInfo.cs, a helper) carry no
  // case id but ship in the same PR: they are fixed and linted like the tests (dogfood: a new
  // AssemblyInfo.cs without the BOM the .editorconfig asks for passed the precheck and failed CI's lint).
  const testFiles = [...tests.keys(), ...supportFiles(config, [...tests.keys()], scenarioDir, base)];
  const created = base ? testFiles.filter((f) => changedLines(config.root, f, { base }) === null) : testFiles;
  if (fix) fixFiles(config, created);
  errors.push(...lintFiles(config, created));
  if (base) {
    const skipped = [];
    errors.push(...lintChanged(config, testFiles.filter((f) => !created.includes(f)), { base, skipped }));
    errors.push(...skipped.map((sk) => `precheck.lint: ${sk}`));
  }
  // Static analysis of the tests the automation wrote (opt-in, slot featureVerification): blocking findings the change
  // introduced go back to the agent like lint errors; the report of the head is reused when one exists.
  if (base && !errors.length) {
    const report = await reportFor(config, 'featureVerification', { cwd: config.root, base });
    for (const f of (report?.findings ?? []).filter((x) => x.severity === 'blocking' && testFiles.includes(x.file))) errors.push(`${f.tool} ${f.rule} at ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message} (static analysis; blocking)`);
  }

  const validate = config.featureVerification.precheck.validateScenario;
  if (validate?.length && (!validate[0].includes('/') || fs.existsSync(path.join(config.root, validate[0])))) {
    const result = run(validate[0], expand(validate.slice(1), { scenario: story.scenario }), { cwd: config.root, timeoutSec: 600 });
    if (result.status !== 0 && result.status !== 127) errors.push(`Scenario validation failed:\n${tail(result.stdout + result.stderr, 3000)}`);
  }
  if (skipTests || !config.featureVerification.precheck.runTests || errors.length) return { errors, tests };

  // Which runner runs which files (precheck.testRunners, lib/runners.mjs). Nothing configured, or a file
  // no runner takes, is a logged note, not a failure: the verifier still reads the tests.
  const { runs, unmatched } = planRuns(config, [...tests.keys()], story.key, { read: (file) => readRel(config, file), runners });
  if (!runners.length) log(`${story.key}: no test runner is configured (precheck.testRunners in .factory/config.json, or project.languages with a pack); the tests are not run`);
  else if (unmatched.length) log(`${story.key}: no test runner takes ${unmatched.join(', ')}; not run`);
  const failure = (argv, result) => `\`${argv.join(' ')}\` failed${result.timedOut ? ' (timed out)' : ''}:\n${tail(result.stdout + result.stderr, 4000)}`;
  const envOf = (runner) => (runner.env ? { ...process.env, ...runner.env } : undefined);
  let evidence = [];

  // Unit and functional runners: build each unit once, one after another (units often share dependencies,
  // so parallel builds would fight over the same output folders), then run every unit's tests at the same
  // time. They are expected not to share state (each starts what it needs).
  const local = (async () => {
    const out = [];
    const ready = [];
    for (const r of runs.filter((x) => !x.runner.stack)) {
      if (!r.build) {
        ready.push(r);
        continue;
      }
      log(`${story.key}: running ${r.build.join(' ')}`);
      const result = run(r.build[0], r.build.slice(1), { cwd: config.root, timeoutSec: config.featureVerification.timeoutsSec.tests, ...(envOf(r.runner) ? { env: envOf(r.runner) } : {}) });
      if (result.status === 0) ready.push(r);
      else out.push(failure(r.build, result));
    }
    const results = await Promise.all(ready.map((r) => {
      log(`${story.key}: running ${r.run.join(' ')}`);
      return runAsync(r.run[0], r.run.slice(1), { cwd: config.root, timeoutSec: config.featureVerification.timeoutsSec.tests, ...(envOf(r.runner) ? { env: envOf(r.runner) } : {}) }).then((result) => ({ argv: r.run, result }));
    }));
    for (const { argv, result } of results) if (result.status !== 0) out.push(failure(argv, result));
    // What CI runs: each unit's whole test project, unfiltered, one after another (they may start containers).
    // A story's tests can pass alone and fail beside the project's other tests (dogfood C2: new test classes each
    // started their own app host and database container next to the existing one, and timed out in CI).
    if (!out.length && fullProjects && config.featureVerification.precheck?.runFullProjects !== false) {
      // The story's own test projects, then every other test project that covers a service the change touches
      // (council C2: a changed service could still break a test project holding none of the story's tests).
      const touched = [...new Map(implChanges(config).files.flatMap((f) => servicesOfFile(f, config.project)).map((svc) => [svc.name, svc])).values()];
      const tracked = git(config.root, ['ls-files']).stdout.split('\n').filter(Boolean);
      const own = ready.filter((x) => x.runAll).map((r) => ({ ...r, why: 'holds the story\'s tests', build: null }));
      const ownUnits = new Set(own.map((r) => r.unit));
      const more = coveringUnits(config, touched, tracked, story.key).filter((u) => !ownUnits.has(u.unit)).map((u) => ({ ...u, why: `covers ${u.services.join(', ')}` }));
      for (const r of [...own, ...more]) {
        const env = envOf(r.runner) ? { env: envOf(r.runner) } : {};
        if (r.build) {
          log(`${story.key}: building ${r.unit} (${r.why}): ${r.build.join(' ')}`);
          const built = run(r.build[0], r.build.slice(1), { cwd: config.root, timeoutSec: config.featureVerification.timeoutsSec.tests, ...env });
          if (built.status !== 0) {
            appendJsonl(metricsFile(config, 'full-project-runs.jsonl'), [{ ts: nowIso(), story: story.key, unit: r.unit, why: r.why, argv: r.build.join(' '), status: built.status, timedOut: Boolean(built.timedOut), step: 'build' }]);
            out.push(`The test project ${r.unit} (${r.why}) does not build with this change: ${failure(r.build, built)}`);
            continue;
          }
        }
        log(`${story.key}: running the whole test project as CI does (${r.why}): ${r.runAll.join(' ')}`);
        const result = await runAsync(r.runAll[0], r.runAll.slice(1), { cwd: config.root, timeoutSec: config.featureVerification.timeoutsSec.tests, ...env });
        // What ran, on which head, with how many tests (council C9: CANC-1's whole-project run of Ordering.FunctionalTests
        // passed before the PR, and the same command fails 3 of 3 on the head CI failed on; the record held no head and no
        // count to say what had run). A run that reports success with no test is not a pass.
        const counts = testCounts(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        const head = git(config.root, ['rev-parse', 'HEAD']).stdout.trim() || null;
        const dirty = Boolean(git(config.root, ['status', '--porcelain', '--untracked-files=no']).stdout.trim());
        if (result.status === 0 && counts && counts.total === 0) result.status = 1, (result.stderr = `${result.stderr ?? ''}\nno test ran (the run reported 0 tests)`);
        // The run's own summary and failed tests, in the log and the record: a pass here and a failure in CI can then be
        // compared test by test (the CANC-1 runs that passed kept no output).
        const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        const { failedTests, summary } = runSummary(text);
        log(`${story.key}: ${r.unit} at ${head?.slice(0, 7) ?? '?'}${dirty ? ' (uncommitted changes)' : ''}: exit ${result.status}${summary.length ? `; ${summary.join(' | ')}` : ''}${failedTests.length ? `; failed: ${failedTests.join(', ')}` : ''}`);
        appendJsonl(metricsFile(config, 'full-project-runs.jsonl'), [{ ts: nowIso(), story: story.key, unit: r.unit, why: r.why, argv: r.runAll.join(' '), status: result.status, timedOut: Boolean(result.timedOut), head, dirty, tests: counts, failedTests }]);
        if (result.status !== 0 && ownUnits.has(r.unit)) out.push(`The story's tests pass when run alone, but their whole test project fails as CI runs it (other tests, or the story's tests beside them): ${failure(r.runAll, result)}\nFix the tests so the whole project passes. Tests that need a fixture which starts an app host or containers share the project's one fixture (join its existing collection or class; never a second fixture beside it).`);
        else if (result.status !== 0) out.push(`The test project ${r.unit} (${r.why}) holds none of the story's tests, and it fails with this change as CI runs it: ${failure(r.runAll, result)}\nThis is a regression or a test the change made stale: fix the implementation or report it as a product bug; change an existing test only when the story changes the behavior it asserts.`);
      }
    }
    return out;
  })();

  // Stack runners (`stack: true`, end to end): on a leased stack slot of its own when several tickets run
  // at once (featureVerification.slots.enabled, see lib/slots.mjs), else the one shared slot-0 stack per machine, where tests of
  // different stories (different worktrees) take turns. The lock lives in git's common dir, which every
  // worktree shares. Runs alongside the local runners.
  const onStack = async ({ runner, files: specFiles, run: argv }) => {
    const runSpecs = async (slotEnv) => {
      log(`${story.key}: running ${argv.join(' ')}${slotEnv.TESTSTACK_SLOT ? ` on slot ${slotEnv.TESTSTACK_SLOT}` : ''}`);
      const since = nowIso();
      // The verifier needs keyframes from passing tests too; a runner asks for them with its `env`.
      // No retries (council C6): a spec that passes only on a retry fails here, so it is fixed before it ships.
      const args = /playwright/.test(argv.join(' ')) && !argv.some((a) => /^--retries/.test(a)) ? [...argv, '--retries=0'] : argv;
      const result = await runAsync(args[0], args.slice(1), { cwd: config.root, timeoutSec: config.featureVerification.timeoutsSec.tests, env: { ...process.env, ...(runner.env ?? {}), ...slotEnv } });
      const seen = runner.evidence === false ? [] : readEvidence(config, { casePrefix: casePrefix(story.key), since });
      evidence = [...evidence, ...seen];
      if (result.status === 0) return config.featureVerification.precheck?.requireUiEvidence === false ? [] : uiEvidenceErrors(seen);
      let error = failure(argv, result);
      const failed = seen.filter((t) => !t.ok);
      if (failed.length) {
        error += '\n\nWhat the browser showed (from the recorded run). Open the keyframes with your image/file read tool, '
          + 'starting with the `failure` and `step failed` frames, before you change any code:\n\n' + formatEvidence(failed);
      }
      return [error];
    };
    const onSlot = await onLeasedSlot(config, { key: story.key, specFiles, timeoutSec: config.featureVerification.timeoutsSec.tests }, runSpecs);
    if (onSlot) return onSlot;
    const lock = teststackLock(config);
    const deadline = Date.now() + config.featureVerification.timeoutsSec.tests * 1000 * 2;
    while (!acquireLock(lock)) {
      if (Date.now() > deadline) return [`Timed out waiting for the shared app stack (held by pid ${lockHolder(lock)}).`];
      log(`${story.key}: waiting for the app stack (pid ${lockHolder(lock)} is running e2e tests)`);
      await sleep(10_000);
    }
    try {
      return await runSpecs({});
    } finally {
      releaseLock(lock);
    }
  };
  const e2e = (async () => {
    const out = [];
    if (runE2e) for (const r of runs.filter((x) => x.runner.stack)) out.push(...await onStack(r));
    return out;
  })();

  for (const list of await Promise.all([e2e, local])) errors.push(...list);
  return { errors, tests, evidence };
}

// Whole test projects in every automation round (the old behaviour), or once after the verifier approves (default).
const fullEveryRound = (config) => config.featureVerification.precheck?.fullProjectsEveryRound === true;

// `scenario.yaml` also accepts `scenario.yml`.
const scenarioNames = (name) => (/\.ya?ml$/.test(name) ? [name.replace(/\.ya?ml$/, '.yaml'), name.replace(/\.ya?ml$/, '.yml')] : [name]);

// Shared by every worktree of this repository (the main checkout and .claude/worktrees/*).
function teststackLock(config) {
  const common = git(config.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim() || path.join(config.root, '.git');
  return path.join(common, 'pipeline-locks', 'teststack.lock');
}

function automationTask(config, story, { mode, feedback, implFiles }) {
  const plan = readPlan(config, story);
  const lines = [
    `Story: ${story.key} (${story.file})`,
    `Mode: ${mode}`,
    `Verified plan: ${story.planDir} (${plan.cases.length} cases: ${plan.cases.map((c) => c.data.id).join(', ')})`,
    `Scenario directory: ${config.teststack.scenariosDir}/${story.scenario} (name: ${story.scenario})`,
    'Every test must carry its case id: in its name or title where the language allows it, else where its runner says below.',
    ...taggingLines(config, story.key),
    `Before you finish, run \`${fvCommandFor(config)} precheck ${story.key}\` and fix everything it reports until it prints "precheck passed". It runs the harness's deterministic checks (case coverage, story tags, lint, scenario validation) without the tests; run the story's tests yourself.`,
    ...(config.featureVerification.precheck.automationNotes ?? []),
    '',
    '### Implementation files changed for this story',
    '',
    implFiles.length ? implFiles.map((f) => `- ${f}`).join('\n') : '- (none detected; read the code the plan exercises)',
    ...decisionsBlock(humanDecisions(config, story), 'feature-verification'),
  ];
  if (mode === 'update') {
    lines.push('', 'Tests for this story already exist. Update them in place so they match the current plan and implementation; do not duplicate tests.');
  }
  const required = requiredFor(config, story.key);
  if (required.length) {
    const unmet = unmetRequired(config, story, 'automation', { required, plan });
    lines.push(requiredProducerText(unmet.length ? unmet : required, 'automation'));
  }
  if (feedback) lines.push('', '### Fix every item from the previous round', '', feedback);
  return lines.join('\n');
}

function automationVerifierTask(config, story, tests, evidence = []) {
  const plan = readPlan(config, story);
  const { scenario } = automationFiles(config, story);
  const lines = [
    `Story: ${story.key}`,
    `Required score: ${stagePassScore(config, 'automation')}/10`,
    `Allowed categories: ${config.featureVerification.categories.automation.join(', ')}`,
    'Set "root_stage": "plan" on a gap only when the test case itself is wrong or untestable, not the test.',
    '',
    '### Test cases (the specification the tests must match)',
  ];
  for (const c of plan.cases) lines.push('', `#### ${c.file}`, '', fence(c.text, 'markdown'));
  lines.push(...decisionsBlock(humanDecisions(config, story), 'verify'));
  lines.push('', '### Automated tests');
  const runners = testRunners(config);
  for (const [file, ids] of tests) lines.push('', `#### ${file} (references ${[...ids].join(', ')})`, '', fence(readRel(config, file), fenceLang(config, file, runners)));
  lines.push('', `### Scenario data (${config.teststack.scenariosDir}/${story.scenario})`);
  for (const file of scenario) lines.push('', `#### ${file}`, '', fence(readRel(config, file), fenceLang(config, file)));
  lines.push('', 'Helper modules imported by the tests may be opened with your read tools if you need them.');
  if (evidence.some((t) => t.keyframes.length)) {
    lines.push(
      '',
      '### Visual evidence (keyframes from the recorded run of these tests)',
      '',
      'Open the keyframes with your image/file read tool and check, case by case, that the screen shows what the case expects '
        + 'at that point (right page, user, data and outcome; no error page or empty state where content is expected). '
        + 'A test that passes while the screen contradicts its case is a `visual-mismatch` gap.',
      '',
      formatEvidence(evidence),
    );
  }
  return lines.join('\n');
}

export const planVerifierTaskFor = (config, story) => planVerifierTask(config, story, readPlan(config, story));
export const automationVerifierTaskFor = (config, story) => automationVerifierTask(config, story, automationFiles(config, story).tests);

// scoped (re-verification after a PR check fix round): no whole-project runs; the PR check runs one full verification
// before it pushes (wall-clock, council C5).
// The hash a verified automation pass records: the canonical implementation hash now (implChanges, the one every stage
// compares), and the hash it started from when the pass itself moved it.
export function verifiedHashOf(config, targetHash) {
  const now = implChanges(config);
  return { hash: now.hash, from: now.hash !== targetHash ? targetHash : null, files: now.files };
}

export async function automationLoop(config, story, { implHash = null, skipTests = false, resume = false, verifyFirst = false, scoped = false, maxRounds = councilRounds(config, 'testAutomation') } = {}) {
  const lock = lockFile(config, story.key, 'automation');
  if (!acquireLock(lock)) {
    updateState(config, story.key, (s) => (s.automation.requestedHash = implHash ?? s.automation.requestedHash));
    log(`${story.key}: automation already running (pid ${lockHolder(lock)}); queued a follow-up for the latest changes.`);
    return { status: 'busy' };
  }
  try {
    let targetHash = implHash ?? implChanges(config).hash;
    for (;;) {
      const saved = resume ? loadState(config, story.key).automation.progress : null;
      updateState(config, story.key, (s) => Object.assign(s.automation, { status: 'running', ...selfProcess(), requestedHash: null, workingHash: targetHash, startedAt: nowIso(), bugs: [] }));
      // One stack slot for the whole pass: the agent's sessions and every precheck round use it, warm (council C4).
      const result = await holdStorySlot(config, story.key, () => automationPass(config, story, { skipTests, maxRounds, targetHash, resume, verifyFirst, scoped, saved: saved?.hash === targetHash ? saved : null }));
      resume = false;
      // The verified hash is the canonical implementation hash after the pass (its own commit included), never the hash
      // it started from: test automation may change a file the implementation hash covers (dogfood C24: a central
      // package-version file for a new test package), and every later comparison reads this one value.
      const after = result.status === 'verified' ? verifiedHashOf(config, targetHash) : null;
      if (after?.from) log(`${story.key}: test automation changed files the implementation hash covers (${after.files.join(', ')}); verified hash ${after.hash} (started from ${after.from})`);
      const state = updateState(config, story.key, (s) => {
        Object.assign(s.automation, { status: result.status, pid: null, boot: null, ...RECOVERY_DONE, finishedAt: nowIso() });
        if (result.status === 'verified') Object.assign(s.automation, { verifiedHash: after.hash, verifiedFrom: after.from });
        if (result.bugs) s.automation.bugs = result.bugs;
      });
      const next = state.automation.requestedHash;
      if (!next || next === targetHash || result.status === 'product-bug') return result;
      log(`${story.key}: implementation changed while tests were being written; updating tests.`);
      targetHash = next;
    }
  } finally {
    releaseLock(lock);
  }
}

async function automationPass(config, story, { skipTests, maxRounds, targetHash, resume = false, verifyFirst = false, scoped = false, saved = null }) {
  const status = planStatus(config, story);
  const planRequired = unmetRequired(config, story, 'plan');
  if (status.state !== 'verified' || planRequired.length) {
    log(`${story.key}: plan is ${status.state}${planRequired.length ? ` and does not cover required case(s) ${planRequired.map((r) => r.id).join(', ')}` : ''}; running the plan loop first.`);
    let plan = await planLoop(config, story, { resume });
    // A plan run already in progress (for example the post-commit hook after the story's notes were
    // committed) holds the lock: wait for it, then use its plan (or run the loop if it didn't verify).
    const lock = lockFile(config, story.key, 'plan');
    const deadline = Date.now() + config.featureVerification.timeoutsSec.plan * 1000 * (councilRounds(config, 'testPlan') + 1);
    while (plan.status === 'busy' && Date.now() < deadline) {
      log(`${story.key}: waiting for the running plan loop (pid ${lockHolder(lock)}).`);
      while (lockHolder(lock) && Date.now() < deadline) await sleep(5000);
      plan = planStatus(config, story).state === 'verified' ? { status: 'verified' } : await planLoop(config, story);
    }
    if (plan.status !== 'verified') return { status: 'blocked-on-plan' };
  }
  const implFiles = implChanges(config).files;
  const council = councilFor(config, 'testAutomation');
  const late = lateBox();
  const contested = new Set();
  let feedback = resume ? resumeFeedback('automation', saved?.feedback) : null;
  let lastGaps = [];
  let lastScore = null;
  // The last verifier round's gaps stay in the feedback until a verifier round runs again, so a
  // precheck failure or a crashed run in between does not hide them from the next fresh agent.
  // route: productGapsOf (lastGaps are what the producer already received)
  const withOpenGaps = (text) => (lastGaps.length ? `${text}\n\nThe last verifier round's gaps are still open; fix them too:\n${formatGaps(lastGaps.filter((g) => g.root_stage !== 'plan'))}` : text);
  // verifyFirst (re-verification after the PR check's fixer edited the tests): the tests exist and were changed on
  // purpose, so they are checked as they are (precheck, run, verifier) before any automation agent run; the agent
  // only runs if that check fails (cost, dogfood C2: every re-verification began with an automation agent run).
  if (verifyFirst && !resume && automationFiles(config, story).tests.size) {
    const pre = await precheckAutomation(config, story, { skipTests, fullProjects: !scoped });
    if (!pre.errors.length) {
      const verdict = await verifyRound(config, { stage: 'automation', story, round: 0, producerVersion: 'unchanged', task: automationVerifierTask(config, story, pre.tests, pre.evidence), uiCases: uiCaseIds(pre.evidence, story.key), late });
      if (verdict.passed) {
        stampIndex(config, story, {
          'automation-sha': automationSha(config, story),
          'automation-plan-sha': readPlan(config, story).index.data['plan-sha'],
          'automation-score': verdict.score,
          'automation-verified-at': nowIso(),
        });
        clearEscalation(config, story, 'automation');
        log(`${story.key}: the changed tests verified ${verdict.score}/10 as they are (no automation agent run).`);
        return { status: 'verified', rounds: 0 };
      }
      if (!verdict.error) {
        lastGaps = verdict.gaps;
        lastScore = verdict.score;
        // route: productGapsOf
        feedback = `The tests were changed after verification and no longer pass the verifier:\n${formatGaps(verdict.gaps.filter((g) => g.root_stage !== 'plan' && !productGapsOf([g]).length))}`;
      }
    } else {
      logPrecheck(config, 'automation', story, 0, pre.errors);
      log(`${story.key}: the changed tests fail the deterministic checks as they are; the automation agent fixes them.`);
      feedback = `The tests were changed after verification; deterministic checks fail:\n${pre.errors.map((e) => `- ${e}`).join('\n')}`;
    }
  }
  // The stage's orchestrator decides who writes the tests: the test automation agent, or itself (kept on resume).
  const led = saved?.orchestrator ?? await decide(config, {
    section: 'testAutomation',
    stage: 'test automation',
    story: story.key,
    work: 'the automated tests of the verified test plan, one test per case, and the scenario they load',
    delegateTo: 'the test automation agent (`test-automation`)',
    context: `Story ${story.key}: ${story.file}. Cases: ${planCases(config.root, config.featureVerification.plansDir, story.key).length}; tests so far: ${automationFiles(config, story).tests.size} file(s).${feedback ? `\n\nWhat the tests must address:\n${feedback}` : ''}`,
    run: (o) => runAgent(config, { ...o, timeoutSec: config.featureVerification.timeoutsSec.automation }),
  });
  const selfDo = led.decision === 'self' ? led : null;
  for (let round = Math.min(saved?.round ?? 1, maxRounds); round <= maxRounds; round++) {
    updateState(config, story.key, (s) => (s.automation.progress = { hash: targetHash, round, feedback, orchestrator: led }));
    const mode = automationFiles(config, story).tests.size ? 'update' : 'create';
    log(`${story.key}: automation round ${round}/${maxRounds} (${mode})${selfDo ? ', written by the orchestrator' : ''}`);
    const roundStart = git(config.root, ['rev-parse', 'HEAD']).stdout.trim();
    const producer = await withAgentSlot(config, story.key, (slotEnv) => runAgent(config, {
      mode: 'write',
      timeoutSec: config.featureVerification.timeoutsSec.automation,
      usage: { stage: 'automation', story: story.key, round },
      extraEnv: slotEnv,
      ...producerRun(config, { agent: PRODUCER.automation, selfDo, task: automationTask(config, story, { mode, feedback, implFiles }) + (council ? `\n\n${councilActionsText({ refuse: 'say so in your result', owns: false })}` : '') + declareFixes(config, story, 'testAutomation', lastGaps) }),
    }));
    // No stack slot came free in time: the stage stops and says why rather than test against another checkout's stack.
    if (producer?.noSlot) {
      escalate(config, story, 'automation', 'no free test-stack slot', producer.noSlot);
      return { status: 'escalated', reason: producer.noSlot };
    }
    const reported = extractResult(producer.output);
    // The test writer's own bug reports are routed too: a "bug" that a test resolves (it names a missing test) stays
    // with test automation; only production defects go to the implementer.
    // route: routeToRole
    const claimed = reported?.status === 'product-bug' ? routeToRole((Array.isArray(reported.bugs) ? reported.bugs : []).map((b) => ({ ...b, issue: [b.case, b.reason].filter(Boolean).join(': ') })), 'implementer') : null;
    if (claimed && !claimed.mine.length && claimed.elsewhere.length) {
      log(`${story.key}: the test writer reported ${claimed.elsewhere.length} "bug(s)" that only a test resolves; they stay with test automation`);
      feedback = `What you reported as implementation bugs is resolved by tests, which are yours to write:\n${formatBugs(claimed.elsewhere)}`;
      continue;
    }
    if (reported?.status === 'product-bug') {
      const bugs = claimed.mine.length ? claimed.mine.map(({ issue: _issue, resolves: _resolves, ...b }) => b) : Array.isArray(reported.bugs) ? reported.bugs : [];
      logDecision(config, {
        stage: 'automation',
        story: story.key,
        round,
        agent: PRODUCER.automation,
        agentVer: producer.version,
        subject: 'implementer',
        decision: 'product-bug',
        reason: reported.summary ?? `${bugs.length} implementation bug(s)`,
        items: normalizeBugs(bugs),
      });
      // not-an-agent: an escalation to a person
      escalate(config, story, 'automation', 'tests found implementation bugs', formatBugs(bugs));
      return { status: 'product-bug', bugs };
    }
    // With a council (which can ask for tests to be deleted), a protected test the agent deleted is put back and the round
    // fails with a finding the agent answers next round.
    const restored = council && roundStart ? guardProtectedTests({ cwd: config.root, from: roundStart, keys: [story.key], cases: planCases(config.root, config.featureVerification.plansDir, story.key) }) : [];
    if (restored.length) {
      log(`${story.key}: restored ${restored.length} protected test file(s) the automation agent changed: ${restored.map((v) => v.file).join(', ')}`);
      logPrecheck(config, 'automation', story, round, restored.map((v) => protectedTestFinding(v).issue));
      feedback = withOpenGaps(`Protected tests were deleted and have been restored:\n${restored.map((v) => `- ${protectedTestFinding(v).issue} ${protectedTestFinding(v).fix}`).join('\n')}`);
      continue;
    }
    if (!producer.ok) {
      feedback = withOpenGaps(`The previous run ${producer.timedOut ? 'timed out' : `failed (exit ${producer.status})`}. Finish the tests.`);
      continue;
    }
    const pre = await precheckAutomation(config, story, { skipTests, fullProjects: fullEveryRound(config) });
    const noSlot = pre.errors.find((e) => e.startsWith(NO_SLOT));
    if (noSlot) {
      logPrecheck(config, 'automation', story, round, [noSlot]);
      escalate(config, story, 'automation', 'no free test-stack slot', noSlot);
      return { status: 'escalated', reason: noSlot };
    }
    if (pre.errors.length) {
      logPrecheck(config, 'automation', story, round, pre.errors);
      feedback = withOpenGaps(`Deterministic checks failed:\n${pre.errors.map((e) => `- ${e}`).join('\n')}`);
      continue;
    }
    // One council sitting a round: a council that passes once verifies the tests.
    const verdict = await verifyRound(config, { stage: 'automation', story, round, producerVersion: producer.version, task: automationVerifierTask(config, story, pre.tests, pre.evidence), uiCases: uiCaseIds(pre.evidence, story.key), late });
    if (verdict.error) continue;
    const owner = ownerEscalation(config, story, 'automation', verdict);
    if (owner) return owner;
    if (verdict.passed && !fullEveryRound(config) && !skipTests && !scoped) {
      // The whole test projects, once, on the approved tests (the story's own tests and the e2e specs already passed).
      const full = await precheckAutomation(config, story, { skipTests, fix: false, e2e: false });
      if (full.errors.length) {
        logPrecheck(config, 'automation', story, round, full.errors);
        feedback = `The verifier approved the tests, but the whole test projects fail as CI runs them:\n${full.errors.map((e) => `- ${e}`).join('\n')}`;
        continue;
      }
    }
    if (verdict.passed) {
      stampIndex(config, story, {
        'automation-sha': automationSha(config, story),
        'automation-plan-sha': readPlan(config, story).index.data['plan-sha'],
        'automation-score': verdict.score,
        'automation-verified-at': nowIso(),
      });
      clearEscalation(config, story, 'automation');
      log(`${story.key}: automated tests verified ${verdict.score}/10 after ${round} round(s).`);
      return { status: 'verified', rounds: round };
    }
    lastGaps = verdict.gaps;
    lastScore = verdict.score;
    // A gap only a production change can close (the verifier says `resolves: code`: the test is right, the code is wrong)
    // does not go back to the test writer, who cannot change the code: it is a product bug for the implementer.
    const productGaps = productGapsOf(verdict.gaps);
    if (productGaps.length) {
      const bugs = productGaps.map((g) => ({ case: g.case, reason: `${g.detail}${g.location ? ` (${g.location})` : ''}`, source: 'automation verifier' }));
      logDecision(config, { stage: 'automation', story: story.key, round, agent: 'verifier', agentVer: verdict.verifierVersion ?? null, subject: 'implementer', decision: 'product-bug', reason: `the verifier named ${bugs.length} gap(s) only a production change can close`, items: normalizeBugs(bugs) });
      // not-an-agent: an escalation to a person
      escalate(config, story, 'automation', 'the verifier found implementation bugs', formatBugs(bugs));
      return { status: 'product-bug', bugs };
    }
    const repeated = repeatedContradictions(verdict, contested);
    if (repeated.length) {
      // not-an-agent: an escalation to a person
      escalate(config, story, 'automation', 'council members contradict each other', `The test automation verifier council disagrees on ${repeated.join('; ')} two rounds running, and the evidence has not settled it. The ticket's owner decides.\n\n${formatGaps(verdict.gaps)}`);
      return { status: 'escalated', reason: 'council members contradict each other' };
    }
    const planGaps = verdict.gaps.filter((g) => g.root_stage === 'plan');
    if (planGaps.length) {
      log(`${story.key}: ${planGaps.length} gap(s) trace back to the plan; sending them to the plan agent.`);
      // route: productGapsOf (root_stage plan: the verifier traced them to the cases)
      const plan = await planLoop(config, story, { seedFeedback: `The automation verifier traced these problems to the test cases themselves:\n${formatGaps(planGaps)}` });
      if (plan.status !== 'verified') return { status: 'blocked-on-plan' };
    }
    // route: productGapsOf (above: gaps only production code closes went to the implementer as product bugs)
    feedback = `The verifier scored the tests ${verdict.score}/10. Fix every gap:\n${formatGaps(verdict.gaps.filter((g) => g.root_stage !== 'plan'))}${planGaps.length ? '\n\nThe plan was also updated to fix case-level problems; re-read the case files.' : ''}${councilNotes(verdict)}`;
  }
  // not-an-agent: an escalation to a person
  escalate(config, story, 'automation', `tests did not pass in ${maxRounds} rounds (${notPassed(config, lastScore, lastGaps, 'automation')})`, lastGaps.length ? formatGaps(lastGaps) : feedback ?? '');
  return { status: 'escalated' };
}

// ---------------------------------------------------------------------------------------------
// Background runs
// ---------------------------------------------------------------------------------------------

export const spawnFv = (config, key, stage, args, file) => spawnBackground(config, { script: FV_SCRIPT, key, stage, args, file });

// A later stage's test gaps become required cases, and test automation (with the plan loop first, when the plan does
// not name them) starts on the current implementation (required.mjs). Used by `fv require`.
export function requireCases(config, story, items, { head = null } = {}) {
  const required = addRequired(config, story.key, items, { head });
  const hash = implChanges(config).hash;
  const bg = startAutomation(config, story, hash);
  return { required, ...bg };
}

// Verifier gaps whose fix is in the production code (verify.mjs keeps `resolves` on a gap).
export const productGapsOf = (gaps) => (gaps ?? []).filter((g) => g.resolves === 'code' && g.root_stage !== 'plan');

export function startAutomation(config, story, implHash) {
  const holder = lockHolder(lockFile(config, story.key, 'automation'));
  if (holder) {
    updateState(config, story.key, (s) => (s.automation.requestedHash = implHash));
    return { queued: true, pid: holder };
  }
  // Saved before spawning: the child updates the same state file (and records its own pid), so a
  // write after the spawn could race it and drop the log path or reset the status.
  const file = logFile(config, story.key, 'automation');
  const log = path.relative(config.root, file);
  updateState(config, story.key, (s) => Object.assign(s.automation, { status: 'starting', pid: null, boot: null, log, requestedHash: null, workingHash: implHash, requestedAt: nowIso(), ...RECOVERY_DONE }));
  return spawnFv(config, story.key, 'automation', ['automate', story.key, '--impl-hash', implHash], file);
}

// ---------------------------------------------------------------------------------------------
// Crash recovery: background plan and automation runs that died (crash, kill, reboot) are resumed
// from their last round, retried a few times with growing delays, then escalated.
// ---------------------------------------------------------------------------------------------

export const RUN_KINDS = ['plan', 'automation'];

function resumeFeedback(kind, feedback) {
  const note = `A previous ${kind === 'plan' ? 'plan' : 'test automation'} run was interrupted before it finished. Keep the work already on disk and complete it.`;
  return feedback ? `${note}\n\n${feedback}` : note;
}

// The run recorded itself as active but its process is gone ("queued" covers the rest of a plan batch).
export const isInterrupted = (config, story, kind, state = loadState(config, story.key)) =>
  runDied(config, state[kind], { active: ['running', 'queued', 'starting'], lock: lockFile(config, story.key, kind) });

// Resumes one interrupted run in the background. `force` also restarts a run that used up its
// attempts ("crashed") and ignores the backoff. Returns what happened, or null if nothing needed doing.
export function recoverRun(config, story, kind, { force = false } = {}) {
  const state = loadState(config, story.key);
  const s = state[kind];
  if (!isInterrupted(config, story, kind, state) && !(force && s.status === 'crashed')) return null;
  const set = (fields) => updateState(config, story.key, (st) => Object.assign(st[kind], fields));

  let hash = null;
  if (kind === 'automation') {
    hash = s.workingHash ?? null;
    if (!hash || hash !== implChanges(config).hash) {
      set({ status: 'interrupted', pid: null, boot: null, progress: null });
      return { kind, action: 'abandoned', reason: 'the implementation changed since it started' };
    }
  }
  const next = nextAttempt(config, s, { force });
  if (next.action === 'waiting') return { kind, ...next };
  if (next.action === 'crashed') {
    set({ status: 'crashed', pid: null, boot: null });
    escalate(config, story, kind, `${kind} run crashed ${next.attempts + 1} times`, `Last log: ${s.log ?? 'none'}\n\nAfter fixing the cause, resume it with \`node scripts/pipeline/pipeline.mjs resume ${story.key} --force\`.`);
    return { kind, ...next };
  }
  const file = logFile(config, story.key, kind);
  const rel = path.relative(config.root, file);
  set({ status: 'starting', pid: null, boot: null, log: rel, requestedAt: nowIso(), ...next.fields });
  const args = kind === 'automation' ? ['automate', story.key, '--impl-hash', hash, '--resume'] : ['plan', story.key, '--resume'];
  spawnFv(config, story.key, kind, args, file);
  log(`${story.key}: resumed the interrupted ${kind} run (attempt ${next.attempt}/${next.maxRetries}, log ${rel}).`);
  return { kind, action: 'resumed', attempt: next.attempt, round: s.progress?.round ?? 1, log: rel };
}

// Every story with an interrupted run, or only `keys`. Stories missing from this checkout are skipped.
export function recoverAll(config, stories, { keys = null, force = false } = {}) {
  const results = [];
  for (const story of stories) {
    if (keys && !keys.includes(story.key)) continue;
    for (const kind of RUN_KINDS) {
      const r = recoverRun(config, story, kind, { force });
      if (r) results.push({ story: story.key, ...r });
    }
  }
  return results;
}

export function formatRecovery(r) {
  const what = r.kind === 'plan' ? 'test plan' : 'test automation';
  if (r.action === 'resumed') return `Feature verification: resumed the interrupted ${what} run for ${r.story} at round ${r.round} (attempt ${r.attempt}, log: ${r.log}).`;
  if (r.action === 'waiting') return `Feature verification: the ${what} run for ${r.story} crashed; it is retried after ${r.retryAt}.`;
  if (r.action === 'crashed') return `Feature verification: the ${what} run for ${r.story} kept crashing and was escalated (.factory/state/escalations/${r.story}-${r.kind}.md).`;
  return `Feature verification: dropped the interrupted ${what} run for ${r.story}: ${r.reason}.`;
}

// ---------------------------------------------------------------------------------------------
// Agent lifecycle hook: implementation agent Stop / SubagentStop
// ---------------------------------------------------------------------------------------------

// Automation already runs, or already ran on this implementation, and needs no restart. A run that stopped
// on the plan (`blocked-on-plan`) does need one once the plan is verified (a `fv plan` re-run after the
// escalation was handled): with the implementation unchanged, nothing else would ever start it again.
export const automationUpToDate = (automation, hash, planState = null) =>
  ['running', 'starting'].includes(automation.status) ||
  (automation.workingHash === hash && automation.status !== 'interrupted' && !(automation.status === 'blocked-on-plan' && planState === 'verified'));

// Runs after the review stage in the dispatcher. Its gate is the review's approval of the exact
// implementation now on disk; automation then runs in the background so the agent can finish.
export function hookStop(config, story) {
  const state = loadState(config, story.key);
  if (!state.done) return null;
  const { hash } = implChanges(config);
  if (!hash || state.review.lastVerdict !== 'APPROVED' || state.review.approvedHash !== hash) return null;
  const automation = state.automation;
  if (automation.verifiedHash === hash) return null;
  if (isInterrupted(config, story, 'automation', state)) {
    const recovered = recoverRun(config, story, 'automation');
    if (recovered && recovered.action !== 'abandoned') return { systemMessage: formatRecovery({ story: story.key, ...recovered }) };
  } else if (automationUpToDate(automation, hash, automation.status === 'blocked-on-plan' ? planStatus(config, story).state : null)) {
    return null;
  }
  const bg = startAutomation(config, story, hash);
  return { systemMessage: `Feature verification: test automation for ${story.key} ${bg.queued ? 'queued behind the running job' : `started in the background (log: ${bg.log})`}.` };
}

// Context injected at session start so agents see feature verification state without asking.
// Only the active story: agents are not told about other stories (story guard).
export function sessionContext(config, story, recovered = []) {
  const lines = [];
  if (story) {
    for (const r of recovered.filter((r) => r.story === story.key)) lines.push(formatRecovery(r));
    const state = loadState(config, story.key);
    lines.push(`Feature verification for ${story.key}: plan ${planStatus(config, story).state}, test automation ${state.automation.status}.`);
    // not-an-agent: a status summary
    if (state.automation.bugs?.length) lines.push(`Feature verification found implementation bugs:\n${formatBugs(state.automation.bugs)}`);
  }
  return lines.join('\n');
}

// The totals a test run printed: Microsoft.Testing.Platform ("total: 27", "failed: 1", "succeeded: 26"), VSTest
// ("Passed: 3, Failed: 0, Total: 3" / "Total tests: 3"), jest ("Tests: 1 failed, 26 passed, 27 total"), pytest
// ("26 passed, 1 failed"). Null when the output says nothing recognisable.
// The failed tests' names and the summary lines of a test run's output (Microsoft.Testing.Platform and VSTest).
export function runSummary(text) {
  const failedTests = [...new Set([...text.matchAll(/^\s*failed\s+([\w.]+)\s*\(/gm), ...text.matchAll(/^\s*Failed\s+([\w.]+)\s*\[/gm)].map((m) => m[1]))].slice(0, 50);
  const summary = text.split('\n').filter((l) => /Test run summary|^\s*(total|failed|succeeded|skipped):|Passed!|Failed!/.test(l)).map((l) => l.trim()).slice(-6);
  return { failedTests, summary };
}

export function testCounts(out) {
  const text = String(out ?? '');
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  let total = num(/^\s*total:\s*(\d+)\s*$/im) ?? num(/Total(?: tests)?:\s*(\d+)/) ?? num(/Tests:.*?(\d+) total/);
  let failed = num(/^\s*failed:\s*(\d+)\s*$/im) ?? num(/Failed:\s*(\d+)/) ?? num(/Tests:.*?(\d+) failed/);
  if (total == null) {
    const passed = num(/(\d+) passed/);
    const f = num(/(\d+) failed/);
    if (passed == null && f == null) return null;
    failed = f ?? 0;
    total = (passed ?? 0) + failed;
  }
  return { total, failed: failed ?? 0 };
}
