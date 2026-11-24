// PR check as the last Stop-hook stage: once the architecture review has approved the implementation
// and feature verification has verified its tests, a report-only PR check runs in the background. Its findings go back
// to the agent on its next stop (or at the next session start); the agent is the fixer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { implChanges } from '../../pipeline/lib/git.mjs';
import { routeToRole } from '../../pipeline/lib/finding-route.mjs';
import { addRequired } from '../../feature-verification/lib/required.mjs';
import { nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { clearEscalation, escalate, lockFile, loadState, logFile, updateState } from '../../pipeline/lib/state.mjs';
import { listStories, resolveStory } from '../../pipeline/lib/stories.mjs';
import { bootId, lockHolder, log, nowIso, selfProcess, sleep } from '../../pipeline/lib/util.mjs';
import { defaultSettings, setting } from '../../pipeline/lib/settings.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pr-check.mjs');
const block = (reason) => ({ decision: 'block', reason });
const notice = (message) => ({ systemMessage: message });
const settings = (config) => ({ ...defaultSettings().prCheck.hook, ...config.prCheck.hook });

export const hookSkipped = (config) => process.env.PR_CHECK_SKIP === '1' || !settings(config).enabled;

// Main-session stops always count; subagent stops only for the agents that write the code (hooks.codeAgents, shared with
// the architecture review).
export function isCodeAgentStop(config, payload) {
  if (payload.hook_event_name !== 'SubagentStop' || !payload.agent_type) return true;
  return setting(config, 'hooks.codeAgents').includes(payload.agent_type);
}

const formatFindings = (findings) => findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.id} (${f.lens}) ${f.title}`).join('\n');

export function resetPrCheck(config, story) {
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'idle', hash: null, pid: null, log: null, verdict: null, score: null, openFindings: [], report: null, reason: null, deliveries: 0, runs: 0, recoveries: 0, retryAt: null }));
}

// Hands a finished result to the agent: a failing check blocks with its findings, then once more if
// nothing changed, then says so once; a pass is one notice.
function deliver(config, story, pc, payload) {
  const bump = () => updateState(config, story.key, (s) => (s.prCheck.deliveries += 1));
  if (pc.verdict === 'PASS') {
    if (pc.deliveries > 0) return null;
    bump();
    return notice(`PR check: ${story.key} scored ${pc.score}/10 against its story (acceptance criteria, flow, design, style, video). Report: ${pc.report}`);
  }
  // The code agent gets only what it can resolve; test gaps become required cases for feature verification
  // (finding-route.mjs, required.mjs).
  const { mine, elsewhere } = routeToRole(pc.openFindings ?? [], 'implementer');
  if (pc.deliveries === 0) {
    bump();
    const gaps = elsewhere.filter((f) => f.resolves.some((r) => r === 'tests' || r === 'plan'));
    if (gaps.length) addRequired(config, story.key, gaps.map((f) => ({ id: f.id, source: 'pr-check', title: f.title, fix: f.fix ?? null })));
    const handed = elsewhere.length ? `\n\nNot for you (${elsewhere.map((f) => f.id).join(', ')}): ${gaps.length ? 'feature verification adds the missing tests as required cases' : 'the PR check\'s fixer resolves them'}.` : '';
    if (!mine.length) return notice(`PR check: ${story.key} scored ${pc.score}/10; its open findings are not about the production code.${handed}`);
    // route: routeToRole
    return block(`The PR check of ${story.key} scored ${pc.score}/10 against its story. ${pc.reason ?? ''}\n\nOpen findings (details and fixes in ${pc.report}):\n${formatFindings(mine)}${handed}\n\nFix them, then finish your turn; the check runs again after the architecture review and feature verification pass.`);
  }
  if (pc.deliveries === 1 && !payload.stop_hook_active) {
    bump();
    // route: routeToRole (only the findings the code agent can resolve, as in the first delivery)
    if (!mine.length) return null;
    return block(`The PR check findings for ${story.key} are still open and nothing has changed since the check. Address them (see ${pc.report}):\n${formatFindings(mine)}`);
  }
  if (pc.deliveries <= 2) {
    updateState(config, story.key, (s) => (s.prCheck.deliveries = 3));
    return notice(`PR check: ${story.key} still has ${pc.openFindings.length} open finding(s) and the code has not changed. Run \`node scripts/pr-check/pr-check.mjs status ${story.key}\` for details.`);
  }
  return null;
}

// Stop hook, after review and fv in the dispatcher. Its gate is the review's approval of the code on
// disk; the check itself waits in the background for feature verification to verify the tests, so the agent can finish.
// How many automatic checks a ticket gets: one more than the times a failing check may send the code back
// (prCheck.returnToImplementation.maxReturns, the pipeline's own return budget too).
export const hookMaxChecks = (config) => setting(config, 'prCheck.returnToImplementation.maxReturns') + 1;

export function hookStop(config, story, payload = {}) {
  if (hookSkipped(config) || !isCodeAgentStop(config, payload)) return null;
  const state = loadState(config, story.key);
  if (!state.done) return null;
  const { hash } = implChanges(config);
  if (!hash || state.review.lastVerdict !== 'APPROVED' || state.review.approvedHash !== hash) return null;
  const pc = state.prCheck;

  if (pc.hash === hash) {
    if (pc.status === 'done') return deliver(config, story, pc, payload);
    if (['waiting', 'running'].includes(pc.status)) {
      const recovered = recoverHookRun(config, story);
      return recovered ? notice(`PR check: ${recovered}`) : null;
    }
    if (['skipped', 'error', 'escalated', 'crashed'].includes(pc.status)) return null;
  }

  // A failing check sends the code back to its implementer at most prCheck.returnToImplementation.maxReturns times: one
  // check more than the returns, then a person decides.
  if (pc.runs >= hookMaxChecks(config) && pc.verdict === 'FAIL') {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'escalated', hash }));
    // not-an-agent: an escalation to a person
    escalate(config, story, 'pr-check', `still failing after ${pc.runs} PR checks`, `Last score ${pc.score}/10. Open findings:\n${formatFindings(pc.openFindings)}\n\nReport: ${pc.report}`);
    return notice(`PR check: ${story.key} still failed after ${pc.runs} checks. A human needs to decide; see .factory/state/escalations/${story.key}-pr-check.md.`);
  }

  const bg = spawnWaiter(config, story, hash, { recoveries: 0, retryAt: null });
  return notice(`PR check: ${story.key} will be checked against its story in the background once feature verification has verified the tests (log: ${bg.log}). Findings come back on your next stop.`);
}

// A new report round on the same implementation (implement's return of test gaps to test automation): the check waits for
// the tests to verify again, then sits. The return budget (prCheck.returnToImplementation.maxReturns) bounds how often.
export function recheck(config, story) {
  const { hash } = implChanges(config);
  if (!hash) return null;
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'idle', verdict: null, score: null, openFindings: [] }));
  return spawnWaiter(config, story, hash, { recoveries: 0, retryAt: null });
}

// Saved before spawning: the waiter checks that its hash is still the current one.
function spawnWaiter(config, story, hash, fields) {
  const file = logFile(config, story.key, 'pr-check');
  const rel = path.relative(config.root, file);
  updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'waiting', hash, currentHash: null, files: implChanges(config).files, pid: null, boot: null, log: rel, reason: null, deliveries: 0, requestedAt: nowIso(), ...fields }));
  const bg = spawnBackground(config, { script: SCRIPT, key: story.key, stage: 'pr-check', args: ['hook-run', story.key, '--hash', hash], file });
  updateState(config, story.key, (s) => {
    if (s.prCheck.hash === hash && !s.prCheck.pid) Object.assign(s.prCheck, { pid: bg.pid, boot: bootId() });
  });
  return bg;
}

// A background check whose process died (crash, kill, reboot) while waiting or checking starts over,
// at most recovery.maxRetries times with growing delays, then escalates. Returns what happened, or
// null when the check is not interrupted.
export function recoverHookRun(config, story, { force = false } = {}) {
  const pc = loadState(config, story.key).prCheck;
  if (!runDied(config, pc, { active: ['waiting', 'running'] })) return null;
  if (implChanges(config).hash !== pc.hash) {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'stale', pid: null, reason: 'interrupted, and the implementation has changed since' }));
    return `the interrupted PR check of ${story.key} is out of date; it runs again after the next review and feature verification pass.`;
  }
  const next = nextAttempt(config, pc, { force });
  if (next.action === 'waiting') return null;
  if (next.action === 'crashed') {
    updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'crashed', pid: null, reason: `the background check died ${next.attempts} times` }));
    escalate(config, story, 'pr-check', `background PR check crashed ${next.attempts} times`, `Run \`node scripts/pr-check/pr-check.mjs resume ${story.key} --force\` to try again.`);
    return `the background PR check of ${story.key} died ${next.attempts} times; escalated (see .factory/state/escalations/${story.key}-pr-check.md).`;
  }
  const bg = spawnWaiter(config, story, pc.hash, next.fields);
  log(`${story.key}: restarted the interrupted PR check (attempt ${next.attempt}/${next.maxRetries})`);
  return `restarted the interrupted PR check of ${story.key} (attempt ${next.attempt}/${next.maxRetries}, log: ${bg.log}).`;
}

// `resume`: every story's interrupted background check (or one story's); --force also retries crashed ones.
export function recoverHookRuns(config, { key = null, force = false } = {}) {
  if (hookSkipped(config)) return [];
  const stories = key ? [resolveStory(config, key)].filter(Boolean) : listStories(config);
  return stories
    .map((story) => {
      if (force && loadState(config, story.key).prCheck.status === 'crashed') {
        updateState(config, story.key, (s) => Object.assign(s.prCheck, { status: 'running', pid: null, requestedAt: null, recoveries: 0, retryAt: null }));
      }
      const line = recoverHookRun(config, story, { force });
      return line && `${story.key}: ${line}`;
    })
    .filter(Boolean);
}

// What keeps the waiter waiting: feature verification automation is (or is about to be) working on this implementation.
function testsPending(config, story, automation, hash) {
  return ['starting', 'running'].includes(automation.status) || automation.requestedHash === hash || Boolean(lockHolder(lockFile(config, story.key, 'automation')));
}

// The background half of the hook: wait for feature verification, run one report-only check, record the result.
export async function hookRun(config, story, hash, executeCheck) {
  const { requireTests, waitForTestsSec, pollSec } = settings(config);
  // A ceiling, not a budget (council C12): the waiter keeps waiting while feature verification is alive and working on
  // this implementation (testsPending); slow agents make it wait longer, never skip the check.
  const deadline = Date.now() + waitForTestsSec * 1000;
  const set = (fields) => updateState(config, story.key, (s) => Object.assign(s.prCheck, fields));
  const current = () => loadState(config, story.key).prCheck.hash === hash;

  // One comparison, logged with both hashes and the files that differ: stale is recorded only with a current hash that
  // differs from the one waited for (dogfood C24: the waiter's log was empty and the cause had to be rebuilt by hand).
  let compared = 0;
  const moved = (when) => {
    const now = implChanges(config);
    if (compared++ === 0) log(`${story.key}: waiting for the PR check of implementation ${hash}; current ${now.hash || '(none)'} (${now.files.length} file(s))`);
    if (now.hash === hash) return false;
    const was = loadState(config, story.key).prCheck.files ?? null;
    const changed = was ? [...new Set([...now.files.filter((f) => !was.includes(f)), ...was.filter((f) => !now.files.includes(f))])] : now.files;
    log(`${story.key}: stale ${when}: waited for ${hash}, current ${now.hash || '(none)'}; files now in the implementation: ${now.files.join(', ') || '(none)'}${was ? `; added or removed since: ${changed.join(', ') || '(none: same files, changed content)'}` : ''}`);
    set({ status: 'stale', currentHash: now.hash || null, reason: `the implementation changed ${when} (waited for ${hash}, now ${now.hash || 'none'})` });
    return true;
  };
  if (!current()) return 0;
  set(selfProcess());
  for (;;) {
    if (!current()) {
      log(`superseded: ${story.key} has a newer PR check`);
      return 0;
    }
    if (moved('while waiting')) return 0;
    const { automation } = loadState(config, story.key);
    if (!requireTests || automation.verifiedHash === hash) break;
    if (!testsPending(config, story, automation, hash)) {
      set({ status: 'skipped', reason: `Feature verification test automation ended "${automation.status}" without verifying this implementation` });
      log(`skipped: automation ${automation.status}`);
      return 0;
    }
    if (Date.now() > deadline) {
      set({ status: 'skipped', reason: `Feature verification did not verify the tests within ${waitForTestsSec} s` });
      log('skipped: timed out waiting for feature verification');
      return 0;
    }
    await sleep(pollSec * 1000);
  }

  set({ status: 'running', startedAt: nowIso() });
  let summary;
  try {
    summary = await executeCheck(config, { story: story.key, 'no-fix': true, hook: true });
  } catch (error) {
    if (current()) set({ status: 'error', reason: error.message });
    log(`PR check failed: ${error.message}`);
    return 1;
  }
  if (!current()) return 0;
  if (moved('during the check')) return 0;
  const pass = summary.verdict === 'PASS';
  updateState(config, story.key, (s) =>
    Object.assign(s.prCheck, {
      status: 'done',
      verdict: summary.verdict,
      score: summary.score,
      openFindings: summary.openFindings,
      resolvedFindings: summary.resolvedFindings ?? [],
      questions: summary.questions ?? [],
      fixerNotes: summary.fixerNotes ?? [],
      sideEffects: summary.sideEffects ?? [],
      report: summary.report,
      reason: summary.reason,
      deliveries: 0,
      runs: pass ? 0 : s.prCheck.runs + 1,
      finishedAt: nowIso(),
    }),
  );
  if (pass) clearEscalation(config, story, 'pr-check');
  log(`${story.key}: ${summary.verdict} ${summary.score}/10`);
  return 0;
}

export function sessionContext(config, story) {
  if (!story || hookSkipped(config)) return '';
  const recovered = recoverHookRun(config, story);
  const pc = loadState(config, story.key).prCheck;
  if (recovered) return `PR check: ${recovered}`;
  if (pc.status !== 'done') return `PR check for ${story.key}: ${pc.status === 'idle' ? 'not run' : pc.status}${pc.reason ? ` (${pc.reason})` : ''}.`;
  const line = `PR check for ${story.key}: ${pc.verdict} ${pc.score}/10 (report: ${pc.report}).`;
  // The session's context reaches the code agent: only what it can resolve.
  // route: routeToRole
  return pc.verdict === 'PASS' ? line : `${line}\nOpen findings to fix:\n${formatFindings(routeToRole(pc.openFindings ?? [], 'implementer').mine)}`;
}
