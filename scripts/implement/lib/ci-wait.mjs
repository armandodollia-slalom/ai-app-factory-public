// After a PR opens, the run waits for its CI before it reports the PR delivered (council C4: a held-out PR was reported delivered
// with its `feature-verification / check` red). The gate's own approval check (`review-quorum`) is not CI and is not
// waited for. A red check goes back through the fixing loop once, as a finding with its log; still red, the run says
// so and does not call the PR delivered. Checks still running when the wait ends are reported as pending.
import { gatePushedRecords, pushBase } from '../../pipeline/lib/record-gate.mjs';
import { writeText } from '../../pipeline/lib/redact.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run as runCmd, tail } from '../../pipeline/lib/util.mjs';
import { combine, checksSummary } from '../../pipeline/lib/ci/evidence.mjs';
import { ciTarget } from '../../pipeline/lib/ci/index.mjs';
import { branchPipelines, headPipelines } from '../../pipeline/lib/ci/evidence.mjs';

// The head's expected pipelines against its runs (the gate's headWorkflows, without the review gate's modules).
const headWorkflows = (target, repo, pr, opts) => headPipelines(ciTarget(target, repo), pr, opts);

export const PASSED = new Set(['pass', 'success']);

// `target` in this module: the { host, ci } pair of ciTarget(config) (any code host and CI system), or a gh runner
// with `repo` (GitHub with GitHub Actions; the tests' fakes). Every call has a timeout and is retried after a timeout or
// a network error (pipeline/lib/external.mjs).

// { state: success|failure|pending|none|unknown, failing: [check names], pending: [names], workflows }
// The PR's checks, and the workflows its head is expected to run (review-gate/lib/expected-ci.mjs): green only when
// every expected workflow ran to completion and passed and no check is red or pending (council C9: a fast check that
// passed while the application workflows had not registered was read as green).
export function ciState(target, repo, pr, { ignore = ['review-quorum'], workflows = headWorkflows, ciSettings = {}, activities = null } = {}) {
  const t = ciTarget(target, repo);
  const checks = checksSummary(t.host, pr, { ignore });
  if (checks.state === 'unknown') return checks;
  const number = String(pr).match(/(\d+)\/?$/)?.[1] ?? String(pr);
  const w = workflows(t, repo, number, { settings: ciSettings, activities });
  // No check ran yet stays "none" (the wait then checks whether GitHub can merge the PR at all), unless a workflow failed.
  const state = checks.state === 'none' && w.state !== 'failure' ? 'none' : combine(checks.state, w);
  const waiting = [w.missing?.length ? `not started: ${w.missing.join(', ')}` : null, w.running?.length ? `running: ${w.running.join(', ')}` : null].filter(Boolean);
  return {
    ...checks,
    state: state === 'none' ? 'none' : state,
    failing: [...checks.failing, ...(w.failing ?? []).filter((n) => !checks.failing.includes(n)).map((n) => `workflow ${n}`)],
    pending: [...checks.pending, ...waiting],
    workflows: { expected: (w.expected ?? []).map((x) => x.name), missing: w.missing ?? [], running: w.running ?? [], failing: w.failing ?? [] },
    ...(state === 'unknown' ? { error: w.error ?? 'the head\'s expected workflows could not be read' } : {}),
  };
}

// The host runs no pipeline on a PR it cannot merge. `mergeState` reads it; `resolveDirty` merges the base into the
// branch and pushes (true when it did). A real conflict ends the wait as "conflict".
export const mergeStateOf = (target, repo, pr) => {
  try {
    return String(ciTarget(target, repo).host.pr.mergeState(pr, { tries: 1 })?.mergeState ?? 'unknown').toUpperCase();
  } catch {
    return 'UNKNOWN';
  }
};

// The PR's checks could not be read this many polls in a row (each gh call already retried): the wait ends as
// `unknown` with the cause, a not-delivered outcome, instead of waiting on (council C12).
export const UNKNOWN_POLLS = 3;

export async function waitForCi(target, repo, pr, { timeoutSec = 10800, pollSec = 30, settleSec = 60, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, now = Date.now, resolveDirty = null, maxResolves = 2, unknownPolls = UNKNOWN_POLLS, ciOptions = {} } = {}) {
  const deadline = now() + timeoutSec * 1000;
  let last = null;
  let resolves = 0;
  let unreadable = 0;
  let greenSince = null;
  let greenNames = null;
  // A just-pushed PR may report no checks for a while: that is not "success" and not a reason to stop.
  for (;;) {
    last = ciState(target, repo, pr, ciOptions);
    if (last.state === 'unknown') {
      unreadable += 1;
      log(`${pr}: its checks could not be read (${last.error}); ${unreadable < unknownPolls && now() < deadline ? 'trying again' : 'giving up: not delivered'}`);
      if (unreadable >= unknownPolls || now() >= deadline) return last;
      await sleep(pollSec * 1000);
      continue;
    }
    unreadable = 0;
    if (last.state === 'failure') return last;
    // Green twice, a settle period apart, with no new check: a workflow that registers late is not missed.
    if (last.state === 'success') {
      if (greenSince && now() - greenSince >= settleSec * 1000 && String(greenNames) === String(last.names)) return last;
      if (!greenSince || String(greenNames) !== String(last.names)) {
        greenSince = now();
        greenNames = last.names;
      }
    } else greenSince = null;
    if (last.state === 'none') {
      const merge = mergeStateOf(target, repo, pr);
      if (merge === 'DIRTY') {
        if (!resolveDirty || resolves >= maxResolves) return { ...last, state: 'conflict', mergeState: merge };
        resolves += 1;
        log(`${pr} cannot merge (DIRTY), so no CI runs on it; merging the base into the branch`);
        const r = await resolveDirty();
        if (!r?.merged) return { ...last, state: 'conflict', mergeState: merge, detail: r?.reason ?? null };
      }
    }
    if (now() >= deadline) return { ...last, state: last.state === 'none' ? 'none' : last.state, timedOut: true };
    await sleep(pollSec * 1000);
  }
}

// The failing checks as PR check findings, with the end of each failed job's log.
export function ciFindings(target, repo, pr, failing, { branch = null } = {}) {
  const branchOnly = /\(before its PR\)$/.test(String(pr));
  const { ci } = ciTarget(target, repo);
  const runs = branch ? (() => {
    try {
      return ci.runs({ branch, limit: 20 });
    } catch {
      return [];
    }
  })() : [];
  const logs = runs.filter((r) => r.conclusion === 'failure').map((r) => {
    try {
      return String(ci.log(r.id, { failedOnly: true }) ?? '');
    } catch {
      return '';
    }
  }).join('\n');
  const lines = logs.split('\n').filter((l) => /FAIL|error|Error|failed|stale/.test(l)).map((l) => l.replace(/^\S+\t\S+\t\S+\s/, '')).slice(-40).join('\n');
  return failing.map((name, i) => (/^flaky: /.test(name) ? {
    id: `CI-FLAKY-${i + 1}`,
    lens: 'flow',
    severity: 'major',
    title: `A test passes only on a retry in CI: ${name.slice(7)}`,
    detail: 'The PR\'s CI passed this test only after Playwright retried it. A spec the pipeline wrote must pass on its first attempt: find why the first attempt fails (a wait on the wrong condition, timing, data or a slow page) and fix the spec or the code; do not raise the timeout or the retries.',
    evidence: `CI on ${pr}`,
    requirement: 'Every test passes on its first attempt.',
    fix: 'Make the test pass on the first attempt.',
  } : {
    id: `CI-${i + 1}`,
    lens: 'flow',
    severity: 'major',
    title: branchOnly ? `CI check fails on the story branch: ${name}` : `CI check fails on the PR: ${name}`,
    detail: `${branchOnly ? `The CI check "${name}" failed on the story branch's push, before any PR exists.` : `The PR's CI check "${name}" failed after the PR opened, although the checks run before the PR passed.`}${lines ? `\n\nFrom the failed job's log:\n${tail(lines, 3000)}` : ''}`,
    evidence: `CI on ${pr}`,
    requirement: 'Every CI check of the PR passes.',
    fix: `Make "${name}" pass on the PR's head; do not weaken or skip the check.`,
  }));
}

// Green CI after the retry check: still green, `flaky` with the retried tests, or `unknown` when the check could not
// read the CI logs (not delivered, with its cause).
function withRetryCheck(ci, flaky, { pr, log }) {
  if (flaky === null || flaky === undefined) {
    log(`CI on ${pr} is green, but its logs could not be read to check for retried tests`);
    return { ...ci, state: 'unknown', error: 'the retry check could not read the CI logs (a gh call failed or timed out after its retries)' };
  }
  if (!flaky.length) return ci;
  log(`CI on ${pr} is green, but ${flaky.length} test(s) passed only on a retry: ${flaky.join('; ')}`);
  return { ...ci, state: 'flaky', failing: flaky.map((t) => `flaky: ${t}`), flaky };
}

// Waits for CI; when it is red, runs one fixing round on the failures and pushes, then waits again.
// Returns { state, failing, fixed, rounds }.
// How many fixing rounds a red or retry-only CI gets before a person decides: implement.ciFixRounds (default 1),
// PIPELINE_CI_FIX_ROUNDS for one run. 0 sends it straight to a person.
export const ciFixRounds = (settings = {}, env = process.env) => {
  const v = Number(env.PIPELINE_CI_FIX_ROUNDS ?? settings.ciFixRounds ?? 1);
  return Number.isInteger(v) && v >= 0 ? v : 1;
};

export async function ciGate({ ciOptions = {}, fixTimeoutSec = null, fixRounds = 1, flakyOf = ciFlaky, gh, config = null, repo, pr, branch, cwd, prCheckCli, targetArgs, base, env = process.env, seedFile, run = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...opts }), wait = waitForCi, log = () => {}, timeoutSec, pollSec = null, settleSec = null, resolveDirty = (cwd && branch && base) ? defaultResolveDirty(cwd, branch, base) : null } = {}) {
  // The CI target: the repository's code host and CI system (a gh runner stands for GitHub with GitHub Actions).
  gh = gh ?? ciTarget(config ?? { root: cwd ?? process.cwd() }, repo);
  let ci = await wait(gh, repo, pr, { log, resolveDirty, ciOptions, ...(timeoutSec ? { timeoutSec } : {}), ...(pollSec != null ? { pollSec } : {}), ...(settleSec != null ? { settleSec } : {}) });
  // Green, but a test needed a retry: that is a finding to fix (council C6), handled like a red check.
  if (ci.state === 'success') ci = withRetryCheck(ci, flakyOf(gh, repo, pr), { pr, log });
  if (!['failure', 'flaky'].includes(ci.state)) return { ...ci, fixed: false, rounds: 0 };
  if (fixRounds < 1) {
    log(`${ci.state === 'flaky' ? 'CI passed only with retries' : 'CI is red'} on ${pr}; no fixing round (implement.ciFixRounds 0): a person decides`);
    return { ...ci, fixed: false, rounds: 0 };
  }
  log(`${ci.state === 'flaky' ? 'CI passed only with retries' : 'CI is red'} on ${pr} (${ci.failing.join(', ')}); one fixing round on the failures`);
  fs.mkdirSync(path.dirname(seedFile), { recursive: true });
  writeText(seedFile, JSON.stringify({ score: 6, lensScores: {}, upheldFindings: ciFindings(gh, repo, pr, ci.failing, { branch }) }, null, 2));
  // The fix round knows its PR (council C7, live #120): what it changed goes into the PR body's "Changed by the PR check"
  // section, the ticket's notes and the PR's side effects, not only onto the branch.
  const prNumber = String(pr ?? '').match(/(?:\/pull\/)?(\d+)\/?$/)?.[1];
  const fixOut = run(process.execPath, [prCheckCli, 'run', ...(prNumber ? ['--pr', prNumber] : []), ...targetArgs, '--base', base, '--until', 'major', '--max-rounds', '2', '--fix-first', seedFile, '--push', '--json'], { cwd, env, timeout: (fixTimeoutSec ?? 72000) * 1000 }); // a ceiling (10x the usual 2 h): its agents end on no progress
  // What the fix round did, for the person who decides when it could not fix the failures (council C7).
  const fixRun = (() => {
    try {
      const out = String(fixOut?.stdout ?? '');
      const j = JSON.parse(out.slice(Math.max(0, out.search(/^\{/m))));
      return { verdict: j.verdict ?? null, reason: j.reason ?? '', fixerNotes: j.fixerNotes ?? [], commits: j.commits ?? [] };
    } catch {
      const failed = Number.isInteger(fixOut?.status) && fixOut.status !== 0;
      return { verdict: failed ? 'ESCALATED' : null, reason: failed ? `the fix round exited ${fixOut.status} without a result` : '', fixerNotes: [], commits: [] };
    }
  })();
  ci = await wait(gh, repo, pr, { log, resolveDirty, ciOptions, ...(timeoutSec ? { timeoutSec } : {}), ...(pollSec != null ? { pollSec } : {}), ...(settleSec != null ? { settleSec } : {}) });
  if (ci.state === 'success') ci = withRetryCheck(ci, flakyOf(gh, repo, pr), { pr, log });
  log(`CI on ${pr} after the fix: ${ci.state}${ci.failing.length ? ` (${ci.failing.join(', ')})` : ''}`);
  return { ...ci, fixed: ci.state === 'success' && fixRun.verdict !== 'ESCALATED', rounds: 1, fixRun };
}

// What a CI gate leaves for a person (council C7): null when the PR is delivered; otherwise the gate input that holds the
// merge at any severity and the result that fails the tickets on the board with options. A retry-only pass, red,
// unverified or conflicting CI, and a fix round that escalated (even when CI later passed) all wait for a person.
export function deliveryDecision(ci, { issues = [] } = {}) {
  const outcome = ciOutcome(ci);
  // A fix the critics did not then accept (no check after it, or one that still upholds something major) is not
  // delivered either (council C7, live #120: the CI fix round's commit was never critiqued).
  const unchecked = (ci.fixRun?.commits ?? []).length > 0 && !['PASS', 'ACCEPTED'].includes(ci.fixRun?.verdict);
  const escalated = ci.fixRun?.verdict === 'ESCALATED' || unchecked;
  if (outcome === 'done' && !escalated) return null;
  const state = outcome === 'done' ? 'escalated' : outcome.replace(/^ci-/, '');
  const reason = [ciLine(ci), escalated ? (unchecked && ci.fixRun.verdict !== 'ESCALATED' ? `the fix round's commits were not accepted by a check after them (${ci.fixRun.verdict ?? 'no check'}${ci.fixRun.reason ? `: ${ci.fixRun.reason}` : ''})` : `the fix round escalated (${ci.fixRun.reason || 'no reason given'})`) : null].filter(Boolean).join('; ');
  const fixerNotes = (ci.fixRun?.fixerNotes ?? []).map((n) => ({ id: n.id, title: n.title ?? null, reason: String(n.reason ?? '') }));
  const findings = [
    ...(ci.flaky ?? []).map((t, i) => ({ id: `CI-FLAKY-${i + 1}`, severity: 'major', title: `A test passes only on a retry: ${t}` })),
    ...(ci.failing ?? []).filter((f) => !/^flaky: /.test(f)).map((f, i) => ({ id: `CI-${i + 1}`, severity: 'major', title: `CI check fails: ${f}` })),
    ...fixerNotes.map((n) => ({ id: n.id, severity: 'major', title: n.title ?? n.id, detail: `The fixer could not fix it: ${n.reason}` })),
  ];
  return { state, outcome: outcome === 'done' ? 'ci-escalated' : outcome, reason, flaky: ci.flaky ?? [], failing: ci.failing ?? [], fixerNotes, findings, issues };
}

// Merges the base into the PR branch in its worktree and pushes, so GitHub can run the PR's CI.
function defaultResolveDirty(cwd, branch, base) {
  return async () => {
    const { mergeLatestBase } = await import('../../pipeline/lib/base-merge.mjs');
    const m = mergeLatestBase(cwd, base);
    if (m.conflict) return { merged: false, reason: `merging ${base} conflicts in ${(m.files ?? []).join(', ')}` };
    if (!m.merged) return { merged: Boolean(m.upToDate), reason: m.error ?? null };
    const from = pushBase(cwd, branch);
    if (from) gatePushedRecords(cwd, from);
    const p = runCmd('git', ['push', '-q', 'origin', `HEAD:${branch}`], { cwd });
    return p.status === 0 ? { merged: true } : { merged: false, reason: `push failed: ${String(p.stderr ?? '').trim().split('\n').pop()}` };
  };
}

// Tests that passed only on a retry in the PR's CI (Playwright's "N flaky" summary), from the logs of the head's runs
// (council C6: a green recording job hid two flaky specs). [{ test, run }]
export function parseFlaky(log) {
  const out = [];
  const lines = String(log ?? '').split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+Z\s?/, ''));
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\d+ flaky\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && /›/.test(lines[j]); j++) out.push(lines[j].trim());
  }
  return [...new Set(out)];
}

// Null when the logs cannot be read (a gh call failed or timed out after its retries) or the head has no successful run
// to read yet: the retry check did not run,
// which is never the same as "no retried test" (council C12: a hung gh call must not end as a silent pass).
export function ciFlaky(target, repo, pr) {
  try {
    const { host, ci } = ciTarget(target, repo);
    if (ci.capabilities?.logs === false) return null;
    const head = host.pr.get(pr)?.headSha;
    if (!head) return null;
    const runs = ci.runs({ head, limit: 30 });
    // No run for the head yet is not "no retried test": the check has nothing to read (council C9).
    if (!runs.some((r) => r.conclusion === 'success')) return null;
    const out = [];
    for (const r of runs.filter((x) => x.conclusion === 'success')) out.push(...parseFlaky(ci.log(r.id)));
    return [...new Set(out)];
  } catch {
    return null;
  }
}

// The run's word for a PR after CI: only CI that ran and passed is delivered (D-C8-3: a PR whose CI never ran was
// reported delivered).
export const ciOutcome = (ci) => (ci.state === 'success' ? 'done' : ci.state === 'failure' ? 'ci-red' : ci.state === 'flaky' ? 'ci-flaky' : ci.state === 'conflict' ? 'ci-conflict' : 'ci-unverified');
export const ciLine = (ci) => (ci.state === 'success' ? 'CI green' : ci.state === 'failure' ? `CI red (${ci.failing.join(', ')}): not delivered` : ci.state === 'flaky' ? `CI green only with retries (${(ci.flaky ?? []).join('; ')}): not delivered` : ci.state === 'conflict' ? `the PR cannot merge${ci.detail ? ` (${ci.detail})` : ''}, so no CI ran: not delivered` : ci.state === 'unknown' ? `CI state unknown (${ci.error ?? 'the PR checks could not be read'}): not delivered` : ci.state === 'none' ? 'no CI check ran on the PR before the wait ended: not delivered' : `CI still running when the wait ended (${(ci.pending ?? []).join(', ')}): not delivered`);

// ---- before the PR exists (implement.preOpen) -----------------------------------------------------------------------
// The story branch's CI as ciState gives a PR's (scripts/pipeline/lib/ci/evidence.mjs branchPipelines): every pipeline a
// push of the branch runs, completed and green on this exact head; a skipped run is not a pass. `prOnly`: what only the
// PR will run. `label` is "<branch> (before its PR)": ciGate's logs and findings name the branch, never a PR number.
export const branchLabel = (branch) => `${branch} (before its PR)`;

export function branchCiState(target, repo, { branch, head, base, changed = [], ciSettings = {}, pipelines = branchPipelines }) {
  const w = pipelines(ciTarget(target, repo), { branch, head, base, changed, settings: ciSettings });
  const waiting = [w.missing?.length ? `not started: ${w.missing.join(', ')}` : null, w.running?.length ? `running: ${w.running.join(', ')}` : null].filter(Boolean);
  return {
    state: w.state,
    head,
    failing: (w.failing ?? []).map((n) => `workflow ${n}`),
    pending: waiting,
    names: (w.expected ?? []).filter((x) => !x.prOnly).map((x) => x.name).sort(),
    prOnly: w.prOnly ?? [],
    workflows: { expected: (w.expected ?? []).filter((x) => !x.prOnly).map((x) => x.name), missing: w.missing ?? [], running: w.running ?? [], failing: w.failing ?? [] },
    ...(w.error ? { error: w.error } : {}),
  };
}

// waitForCi's contract for a story branch: `where` is { branch, base, head: () => sha, changed: () => [paths] }, read on
// every poll, so a fixing round's push is waited for on its own SHA. 'none' (no pipeline runs on a push of this branch)
// ends the wait at once: the head cannot be proven before a PR, and the caller falls back (a draft PR).
export function branchWait(where, { pipelines = branchPipelines } = {}) {
  return async (target, repo, _label, { timeoutSec = 10800, pollSec = 30, settleSec = 60, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, now = Date.now, unknownPolls = UNKNOWN_POLLS, ciOptions = {} } = {}) => {
    const deadline = now() + timeoutSec * 1000;
    let last;
    let unreadable = 0;
    let greenSince = null;
    let greenHead = null;
    for (;;) {
      const head = where.head();
      last = branchCiState(target, repo, { branch: where.branch, head, base: where.base, changed: where.changed?.() ?? [], ciSettings: ciOptions.ciSettings ?? {}, pipelines });
      if (last.state === 'unknown') {
        unreadable += 1;
        log(`${where.branch}@${String(head).slice(0, 7)}: its CI could not be read (${last.error}); ${unreadable < unknownPolls && now() < deadline ? 'trying again' : 'giving up'}`);
        if (unreadable >= unknownPolls || now() >= deadline) return last;
        await sleep(pollSec * 1000);
        continue;
      }
      unreadable = 0;
      if (last.state === 'failure' || last.state === 'none') return last;
      // Green twice, a settle period apart, on the same head: a pipeline that registers late is not missed.
      if (last.state === 'success') {
        if (greenSince && greenHead === head && now() - greenSince >= settleSec * 1000) return last;
        if (greenHead !== head) {
          greenSince = now();
          greenHead = head;
        }
      } else greenSince = greenHead = null;
      if (now() >= deadline) return { ...last, timedOut: true };
      await sleep(pollSec * 1000);
    }
  };
}

// ciFlaky for a story branch's head: the logs of its successful push runs. Null when they cannot be read.
export function branchFlaky(where) {
  return (target, repo) => {
    try {
      const { ci } = ciTarget(target, repo);
      if (ci.capabilities?.logs === false) return null;
      const head = where.head();
      const runs = ci.runs({ head, limit: 30 }).filter((r) => r.sha === head || !r.sha);
      if (!runs.some((r) => r.conclusion === 'success')) return null;
      const out = [];
      for (const r of runs.filter((x) => x.conclusion === 'success')) out.push(...parseFlaky(ci.log(r.id)));
      return [...new Set(out)];
    } catch {
      return null;
    }
  };
}

