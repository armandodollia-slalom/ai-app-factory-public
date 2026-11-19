// The CI evidence of a pull request's head, on any code host and CI system (council C9: "green" was judged from
// whichever checks happened to be registered, so a head could merge before its application pipelines even
// started). The expected set comes from the CI adapter (the CI definition at that head, or `ci.expected` /
// `implement.reviewGate.ci.expected` in .factory/config.json); a head is green only when every expected pipeline
// has a run for that head that completed successfully. A pipeline with no run yet, a run still going, or evidence
// that cannot be read is not green (fail closed).
//
//   headPipelines({ host, ci }, pr, { settings, head })
//     -> { state: success | failure | pending | none | unknown, head, expected, missing, running, failing, error }
//
// `host` and `ci` are synchronous adapters (hostFor(config).sync, ciFor(config)); ciTarget() builds them, and a gh
// runner stands for GitHub with GitHub Actions (the form the gate's tests and older callers use).
const GREEN = new Set(['success', 'skipped', 'neutral']);

// Each expected pipeline against the head's runs (the latest run of each pipeline for that head).
// `events`: the run events that count (GitHub: pull_request, pull_request_target); null counts every run.
// Per pipeline, the newest run that EXECUTED decides: a skipped run never supersedes a run that ran (council C10, Opus 1:
// the gate's own label edit made a newer, skipped run of a workflow whose real run had failed or was still going, and
// the head read as green). A skipped run counts only when the pipeline has no executed run for the head. Every CI
// adapter inherits this rule; `green` is what a completed run may conclude to count (the branch gate before a PR
// opens counts no skip at all).
export function evaluateRuns(expected, runs, { allowNoWorkflows = false, events = ['pull_request', 'pull_request_target'], green = GREEN } = {}) {
  if (!expected.length) return { state: allowNoWorkflows ? 'success' : 'none', expected, missing: [], running: [], failing: [] };
  const latest = new Map();
  const executed = (r) => !(r.status === 'completed' && r.conclusion === 'skipped');
  const newer = (r, prev) => Number(r.id) > Number(prev.id) || (Number.isNaN(Number(r.id)) && String(r.createdAt ?? '') > String(prev.createdAt ?? ''));
  for (const r of runs) {
    if (events && !events.includes(r.event)) continue;
    const key = r.pipeline ?? r.path;
    const prev = latest.get(key);
    if (!prev || (executed(r) && !executed(prev)) || (executed(r) === executed(prev) && newer(r, prev))) latest.set(key, r);
  }
  const missing = [];
  const running = [];
  const failing = [];
  for (const w of expected) {
    const id = w.id ?? w.path;
    if (w.unreadable) {
      missing.push(`${id} (its definition could not be read)`);
      continue;
    }
    const r = latest.get(id);
    if (!r) {
      if (w.required) missing.push(w.name);
      continue;
    }
    if (r.status !== 'completed') running.push(w.name);
    else if (!green.has(r.conclusion)) failing.push(`${w.name}${r.conclusion === 'skipped' ? ' (skipped, which is not a pass)' : ''}`);
  }
  const state = failing.length ? 'failure' : missing.length || running.length ? 'pending' : 'success';
  return { state, expected, missing, running, failing };
}

// The pull request checks' state combined with the expected pipelines': a red check or pipeline is failure; green
// needs every expected pipeline completed and green, and no check pending.
export function combine(checksState, workflows) {
  if (checksState === 'failure' || workflows.state === 'failure') return 'failure';
  if (workflows.state === 'unknown') return 'unknown';
  if (workflows.state === 'none') return checksState === 'pending' ? 'pending' : 'none';
  if (workflows.state === 'pending' || checksState === 'pending') return 'pending';
  return checksState === 'success' ? 'success' : 'pending';
}

export const describeWorkflows = (w) =>
  [w.missing?.length ? `not started yet: ${w.missing.join(', ')}` : null, w.running?.length ? `running: ${w.running.join(', ')}` : null, w.failing?.length ? `failed: ${w.failing.join(', ')}` : null, w.error ?? null].filter(Boolean).join('; ');

const expectedCache = new Map();

// The head's CI as the CI system defines it. Every read goes through the adapters (each bounded by the
// external-call policy); a read that fails makes the state `unknown`, which is never green.
// `activities`: the pull_request activities the head went through (opened, synchronize, reopened, ready_for_review,
// labeled), an array or a function of the head (implement/lib/pre-open.mjs's head ledger); null for a PR the pipeline did
// not open: the adapter then owes every pipeline of opened, synchronize and reopened (fail closed). Council C10, Sol 2.
export const UNKNOWN_ACTIVITIES = ['opened', 'synchronize', 'reopened'];
export function headPipelines(target, pr, { settings = {}, head = null, activities = null } = {}) {
  const { host, ci } = target;
  const fail = (what, error) => ({ state: 'unknown', head, expected: [], missing: [], running: [], failing: [], error: `${what}: ${String(error?.message ?? error ?? 'no answer').split('\n').pop()}` });
  let info;
  try {
    info = host.pr.get(pr);
  } catch (error) {
    return fail('the pull request could not be read', error);
  }
  if (!info) return fail('the pull request could not be read', 'not found');
  // The evidence is for the head the caller assessed: if the branch moved since, nothing about that head is known yet.
  if (head && info.headSha && head !== info.headSha) return { state: 'pending', head, expected: [], missing: [`the PR's head moved from ${head.slice(0, 7)} to ${info.headSha.slice(0, 7)}`], running: [], failing: [] };
  head = head ?? info.headSha;
  const acts = (typeof activities === 'function' ? activities(head) : activities) ?? UNKNOWN_ACTIVITIES;
  const key = `${ci.type}:${String(host.repo ?? '')}@${head}@${[...acts].sort().join(',')}`;
  let expected = expectedCache.get(key);
  if (!expected) {
    if (Array.isArray(settings.expected)) expected = settings.expected.map((p) => ({ id: p, path: p, name: p, required: true }));
    else {
      let changed;
      try {
        changed = host.pr.files(pr).map((f) => f.path ?? f);
      } catch (error) {
        return fail('the changed files could not be read', error);
      }
      try {
        expected = ci.expected({ head, base: info.base, changed, pr, branch: info.head, settings, mode: 'pr', activities: acts });
      } catch (error) {
        if (error?.name === 'UnsupportedError') return fail(`${ci.type} cannot derive the pipelines a head must run; set ci.expected in .factory/config.json`, error);
        return fail('the CI definitions could not be read', error);
      }
      const ignore = new Set(settings.ignore ?? []);
      const ignoreNames = settings.ignoreNames ?? ['review-quorum'];
      expected = expected.filter((w) => !ignore.has(w.id ?? w.path) && !ignoreNames.includes(w.name));
    }
    expectedCache.set(key, expected);
  }
  let runs;
  try {
    runs = ci.runs({ head, branch: info.head, pr });
  } catch (error) {
    return fail('the head\'s pipeline runs could not be read', error);
  }
  const result = { head, ...evaluateRuns(expected, runs, { allowNoWorkflows: Boolean(settings.allowNoWorkflows), events: ci.prEvents === undefined ? ['pull_request', 'pull_request_target'] : ci.prEvents }) };
  return target.scanners?.length ? withScanners(result, target, pr, info) : result;
}

// A story branch's head before any pull request exists (implement.preOpen): the pipelines a push of `branch` runs, against
// that head's push runs, on the same fail-closed rules, and stricter: a skipped run is never a pass here, because this
// verdict decides whether a PR opens at all. `changed` comes from the caller's checkout (base...head). `prOnly` names the
// pipelines only a pull request runs (the review quorum, a repository's own PR-only workflows): what is still pending
// when the PR opens. Needs the CI adapter's `branchPipelines` capability (the caller falls back without it).
export function branchPipelines(target, { branch, head, base, changed = [], settings = {} }) {
  const { ci } = target;
  const fail = (what, error) => ({ state: 'unknown', head, expected: [], missing: [], running: [], failing: [], prOnly: [], error: `${what}: ${String(error?.message ?? error ?? 'no answer').split('\n').pop()}` });
  const key = `${ci.type}:push:${branch}@${head}`;
  let expected = expectedCache.get(key);
  if (!expected) {
    try {
      expected = ci.expected({ head, base, changed, pr: null, branch, settings, mode: 'push' });
    } catch (error) {
      if (error?.name === 'UnsupportedError') return fail(`${ci.type} cannot say which pipelines a branch push runs`, error);
      return fail('the CI definitions could not be read', error);
    }
    const ignore = new Set(settings.ignore ?? []);
    const ignoreNames = settings.ignoreNames ?? ['review-quorum'];
    expected = expected.filter((w) => !ignore.has(w.id ?? w.path) && !ignoreNames.includes(w.name));
    expectedCache.set(key, expected);
  }
  const owed = expected.filter((w) => !w.prOnly);
  const prOnly = expected.filter((w) => w.prOnly).map((w) => w.name);
  let runs;
  try {
    runs = ci.runs({ head, branch, pr: null });
  } catch (error) {
    return fail('the branch head\'s pipeline runs could not be read', error);
  }
  return { head, prOnly, ...evaluateRuns(owed, runs, { allowNoWorkflows: false, events: ci.pushEvents === undefined ? ['push'] : ci.pushEvents, green: new Set(['success', 'neutral']) }) };
}

// A commercial scanner in server mode is evidence of the head like a pipeline (analysis/scanners/index.mjs): its
// pending result keeps the head pending, its failure or an unreadable result keeps it from green.
function withScanners(result, target, pr, info) {
  let checks;
  try {
    checks = target.host.pr.checks(pr) ?? [];
  } catch (error) {
    return { ...result, state: result.state === 'failure' ? 'failure' : 'unknown', error: `the head's checks could not be read for the scanner: ${String(error?.message ?? error).split('\n')[0]}` };
  }
  const missing = [...result.missing];
  const running = [...result.running];
  const failing = [...result.failing];
  const scanners = [];
  let unknown = null;
  for (const s of target.scanners) {
    const ev = target.scannerEvidence(s, { head: result.head, pr, branch: info.head, checks, config: target.config });
    scanners.push(ev);
    if (ev.state === 'failure') failing.push(ev.detail);
    else if (ev.state === 'pending') running.push(ev.detail);
    else if (ev.state === 'unknown') unknown = ev.detail;
  }
  const state = failing.length ? 'failure' : unknown ? 'unknown' : missing.length || running.length ? 'pending' : result.state === 'none' ? 'success' : result.state;
  return { ...result, state, missing, running, failing, scanners, ...(unknown ? { error: unknown } : {}) };
}

// The checks the host shows for the PR's head (host.pr.checks, normalised), as one state: 'success' | 'pending' |
// 'failure' | 'none' | 'unknown', with the failing and pending names. The gate's own approval check (`review-quorum`)
// is not CI: it fails until people approve (dogfood C5, #69). Green needs a check that ran and passed: only skipped
// checks means the head's pipelines have not run yet (council C12).
export function checksSummary(host, pr, { ignore = ['review-quorum'] } = {}) {
  let checks;
  try {
    checks = host.pr.checks(pr);
  } catch (error) {
    return { state: 'unknown', failing: [], pending: [], error: String(error?.message ?? error).split('\n')[0] };
  }
  checks = (checks ?? []).filter((c) => !ignore.includes(c.name));
  if (!checks.length) return { state: 'none', failing: [], pending: [] };
  const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'error']);
  const failing = checks.filter((c) => c.status === 'completed' && RED.has(c.conclusion));
  const pending = checks.filter((c) => c.status !== 'completed');
  const passed = checks.filter((c) => c.status === 'completed' && c.conclusion === 'success');
  const state = failing.length ? 'failure' : pending.length ? 'pending' : passed.length ? 'success' : 'none';
  return { state, failing: failing.map((c) => c.name), links: failing.map((c) => c.url).filter(Boolean), pending: pending.map((c) => c.name), names: checks.map((c) => c.name).sort() };
}
