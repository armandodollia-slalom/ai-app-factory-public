// CI's analysis jobs, run here before the harness pushes a branch for its CI proof: the generated job script itself
// (.factory/bin/analysis/ci.mjs, the file every CI system calls) on a clean checkout of HEAD against the same base, so
// the machine and CI cannot disagree about what blocks (both run decide.mjs on the same tree). A blocking finding goes
// back to the fixing round while nothing is pushed; a secret that lives only in unpushed commits is folded out by the
// harness; after a red CI on the pushed branch, the secret decision table (secret-table.mjs) gives the way out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, nowIso, run as defaultRun, tail } from '../../pipeline/lib/util.mjs';
import { machineCache } from '../../pipeline/lib/analysis/runner.mjs';
import { CI_DATA, CI_SCRIPT } from '../../pipeline/lib/analysis/ci.mjs';
import { toolSandbox } from '../../pipeline/lib/analysis/baseline.mjs';
import { dropUnpushedSecrets, foldStoryBranch } from '../../pipeline/lib/analysis/history.mjs';
import { judgeSecret, visibleCredentials } from '../../pipeline/lib/analysis/secret-table.mjs';
import { onlyInHistory } from '../../pipeline/lib/analysis/secrets.mjs';
import { PLACEHOLDER_MARKER } from '../../pipeline/lib/redact.mjs';
import { parityGate } from './ci-parity.mjs';

export const DECISIONS_METRICS = 'secret-decisions.jsonl';
export const AGREEMENT_METRICS = 'analysis-agreement.jsonl';
// The pre-push gate's result per job and head: ran or not, the verdict, why it could not run (no value).
import { GATE_METRICS } from '../../pipeline/lib/analysis/fixloop.mjs';

// The analysis jobs CI runs on this commit (from the committed job data; [] when the repository has none).
export function committedJobs(root, rev = 'HEAD') {
  const r = git(root, ['show', `${rev}:${CI_DATA}`]);
  if (r.status !== 0) return [];
  try {
    return JSON.parse(r.stdout).jobs ?? [];
  } catch {
    return [];
  }
}

// Runs every analysis job exactly as CI does, on a detached checkout of HEAD (no uncommitted file, no hook) against
// `base`. Returns [{ check, job, ok, output, findings }] (findings: the script's --json verdicts, no values).
export function runAnalysisJobs(root, base, { run = defaultRun, cacheDir = machineCache(), only = null, log = () => {} } = {}) {
  const jobs = committedJobs(root).filter((j) => !only || only.includes(j.id));
  if (!jobs.length) return [];
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ci-analysis-'));
  fs.rmSync(wt, { recursive: true, force: true });
  if (git(root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', wt, head]).status !== 0) return jobs.map((j) => ({ check: `factory-analysis ${j.name}`, job: j.id, ok: false, output: 'could not check out HEAD for the analysis jobs', findings: [] }));
  const out = [];
  try {
    for (const j of jobs) {
      const json = path.join(os.tmpdir(), `factory-ci-analysis-${process.pid}-${j.id}.json`);
      // The repository's hooks are off for every git call of the job and its tools (a tool's own worktree included).
      const box = toolSandbox({ ...process.env, FACTORY_CACHE_DIR: cacheDir });
      let r;
      try {
        r = run(process.execPath, [CI_SCRIPT, '--job', j.id, '--base', base, '--json', json], { cwd: wt, env: box.env, timeoutSec: j.timeoutSec * 60 });
      } finally {
        const left = box.cleanup(root);
        if (left.length) log(`${j.id}: removed ${left.length} git worktree(s) a tool left behind`);
      }
      let findings = [];
      try {
        findings = JSON.parse(fs.readFileSync(json, 'utf8')).findings ?? [];
      } catch {
        /* the script did not get that far: its output says why */
      } finally {
        fs.rmSync(json, { force: true });
      }
      // A job that failed here without a blocking finding (a tool that could not run on this machine: offline, a
      // download) is unverified here, not a finding: it does not hold the push, and CI stays the authority for it.
      const unverified = r.status !== 0 && !findings.some((f) => f.verdict === 'blocking');
      const output = r.status === 0 ? '' : tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim(), 2000);
      out.push({ check: `factory-analysis ${j.name}`, job: j.id, ok: r.status === 0 || unverified, ...(unverified ? { unverified: true, why: whyNotRun(output, r.status) } : {}), output, findings });
    }
  } finally {
    git(root, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
  log(`CI's analysis jobs on ${head.slice(0, 7)} against ${base}: ${out.filter((r) => r.ok && !r.unverified).length} of ${out.length} pass${out.some((r) => !r.ok) ? ` (failing: ${out.filter((r) => !r.ok).map((r) => r.job).join(', ')})` : ''}${out.some((r) => r.unverified) ? ` (could not run here, CI decides: ${out.filter((r) => r.unverified).map((r) => r.job).join(', ')})` : ''}`);
  return out;
}

// Why a job could not run here, in one line (the last error line of its output; never a value: the job prints none).
export function whyNotRun(output, status) {
  const lines = String(output ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /error|could not|cannot|failed|not found|timed out|refused/i.test(l)) ?? lines.at(-1) ?? '';
  return `${line.slice(0, 240)}${status != null ? ` (exit ${status})` : ''}`.trim();
}

const blockingOf = (results) => results.flatMap((r) => (r.ok ? [] : (r.findings ?? []).filter((f) => f.verdict === 'blocking').map((f) => ({ ...f, job: r.job }))));
const where = (f) => `${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}`;

// Failing analysis jobs as PR check findings for the fixing round (`pr-check run --fix-first`).
export function analysisFindings(results) {
  const out = [];
  for (const r of results.filter((x) => !x.ok)) {
    const blocking = (r.findings ?? []).filter((f) => f.verdict === 'blocking');
    const items = blocking.length ? blocking : [{ tool: r.job, rule: null, file: null, line: null, error: true }];
    for (const f of items) {
      out.push({
        id: `CI-${out.length + 1}`,
        lens: 'security',
        severity: 'major',
        title: f.error ? `CI's ${r.check} fails before the push` : `CI's ${r.check} fails before the push: ${f.tool} ${f.rule} at ${where(f)}`,
        detail: r.output,
        evidence: f.error ? (r.output.split('\n')[0] ?? '') : `${where(f)} ${f.tool} ${f.rule} (introduced by this change; the job's own decision)`,
        ...(f.file ? { file: f.file, line: f.line ?? null } : {}),
        requirement: 'The pull request passes every analysis job CI runs on it; the same job script ran here on this commit.',
        fix: f.secret
          ? `Replace the value at ${where(f)} with a fake one that contains "${PLACEHOLDER_MARKER}" (the secret scanner's allow-list accepts it; analysis.secrets.allow in .factory/config.json lists the repository's own) or refer to the setting by name. Never a real value. Do not rewrite history or add an ignore or suppression file: the harness removes the old value from unpushed history itself.`
          : 'Fix the reported finding in the code without changing behavior; never add a suppression or an ignore file.',
      });
    }
  }
  return out;
}

// The checks the pre-push gate runs: CI's analysis jobs on HEAD; a secret living only in unpushed commits is folded out
// first (deterministic, same tree), then the jobs run again; a file the commit gate holds out of the commits fails too.
export function gateChecks(config, { branch, base, held = () => [], jobs = runAnalysisJobs, log = () => {} }) {
  return (cwd, b) => {
    let results = jobs(cwd, b, { log });
    const secrets = blockingOf(results).filter((f) => f.secret && f.vendorFingerprint);
    if (secrets.length) {
      const folded = dropUnpushedSecrets(config, cwd, secrets, { branch, base, log });
      if (folded.rewritten) results = jobs(cwd, b, { log });
      else log(`secret finding(s) in history not folded: ${folded.reason}`);
    }
    const h = held(cwd);
    if (h.length) results = [...results, { check: 'commit gate (a new secret held out of the commits)', job: 'commit-gate', ok: false, output: h.map((x) => `${x.file}:${x.line ?? '?'} ${x.tool} ${x.rule}`).join('\n'), findings: h.map((x) => ({ ...x, verdict: 'blocking', secret: true })) }];
    return results;
  };
}

// The pre-push gate: { ok, results, fixRun }. No analysis jobs (or implement.ci.parity.enabled false): ok with no results.
export function analysisGate(config, { cwd, branch, base, targetArgs, seedFile, prCheckCli, env, budget, keys = [], held = () => [], jobs = runAnalysisJobs, fix = parityGate, run = defaultRun, log = () => {} }) {
  if (config.implement?.ci?.parity?.enabled === false || !committedJobs(cwd).length) return { ok: true, results: [], fixRun: null };
  const checks = gateChecks(config, { branch, base, held, jobs, log });
  const g = fix({ cwd, base, targetArgs, seedFile, prCheckCli, env, budget, run, checks, findingsOf: analysisFindings, log });
  recordGate(config, { cwd, branch, base, keys, results: g.results, fixRun: g.fixRun });
  return { ok: g.results.every((r) => r.ok), results: g.results, fixRun: g.fixRun };
}

// One row per job in the run records (analysis-gate.jsonl): the head it ran on, whether it ran, its verdict (pass, fail,
// unverified: could not run here, CI decides) and why it could not run. Counts and locations only, never a value.
export const gateVerdict = (r) => (r.unverified ? 'unverified' : r.ok ? 'pass' : 'fail');
export function recordGate(config, { cwd, branch, base, keys = [], results = [], fixRun = null }) {
  if (!results.length) return;
  const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim() || null;
  const ts = nowIso();
  appendJsonl(metricsFile(config, GATE_METRICS), results.map((r) => ({ ts, story: keys[0] ?? null, ...(keys.length > 1 ? { stories: keys } : {}), branch, base, head, job: r.job, check: r.check, ran: !r.unverified, verdict: gateVerdict(r), why: r.unverified ? r.why ?? whyNotRun(r.output, null) : null, blocking: (r.findings ?? []).filter((f) => f.verdict === 'blocking').length, fixRun: fixRun?.verdict ?? null })));
}

// The PR body line: CI's analysis jobs run before the push.
export function analysisGateSection(gate) {
  if (!gate?.results?.length) return '';
  const failed = gate.results.filter((r) => !r.ok);
  const unverified = gate.results.filter((r) => r.unverified);
  const passed = gate.results.filter((r) => r.ok && !r.unverified);
  if (failed.length) return `- CI's analysis jobs before the push: ${failed.length} of ${gate.results.length} fail (${failed.map((r) => r.check).join('; ')})`;
  return `- CI's analysis jobs before the push: ${passed.length} of ${gate.results.length} passed on this machine with CI's own script (${passed.map((r) => r.job).join(', ') || 'none'})${unverified.length ? `; could not run here, CI decides: ${unverified.map((r) => `${r.job}${r.why ? ` (${r.why})` : ''}`).join(', ')}` : ''}`;
}

// After CI on the pushed branch is red: runs the analysis jobs here on the same head and takes the decision table's way
// out. Returns { retried, reason, decisions }. `prOpen`: whether the story's PR is open (null: unknown).
//   - the jobs pass here but CI failed one: a disagreement, recorded; nothing to do (the CI result stands).
//   - a secret in the pushed branch's history, fake by the table's rule, no PR: the value is replaced (one fixing round
//     when it is still in the files), the branch's commits fold into one, CI's jobs pass here on the fold, and it is
//     pushed with a lease; then CI proves the new head.
//   - any other blocking analysis finding still in the files: one fixing round here, nothing pushed until the jobs pass.
//     It is one of the ticket's CI fixing rounds (implement.ci.maxFixRounds): with none left (`budget`, ciFixBudget), it does
//     not run and a person decides; when it runs, the result says so (`fixRounds: 1`).
//   - anything else (a value that may be real, an open PR): escalate, as before.
export async function remedyRedBranch(config, { worktree, branch, base, ci, prOpen, keys = [], targetArgs, seedFile, prCheckCli, env, push, pushLease, jobs = runAnalysisJobs, fix = parityGate, credentials = null, run = defaultRun, log = () => {}, budget }) {
  if (!budget) throw new Error('remedyRedBranch needs the ticket\'s CI fixing budget (ciFixBudget)');
  let spent = 0;
  const analysisRed = (ci?.failing ?? []).some((n) => /factory-analysis|Secret scan|Dependency audit|Security patterns|Workflow lint/i.test(n));
  const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
  const results = jobs(worktree, base, { log });
  const failing = results.filter((r) => !r.ok);
  appendJsonl(metricsFile(config, AGREEMENT_METRICS), [{ ts: nowIso(), story: keys[0] ?? null, branch, head, where: 'after-branch-ci', ciFailing: ci?.failing ?? [], analysisRedInCi: analysisRed, localFailing: failing.map((r) => r.job), agree: analysisRed === failing.length > 0 }]);
  if (!failing.length) return { fixRounds: spent, retried: false, reason: analysisRed ? 'CI\'s analysis jobs pass here on the same head but failed in CI: a disagreement, recorded (analysis-agreement.jsonl)' : 'the red CI is not an analysis job' };
  const mergeBase = git(worktree, ['merge-base', 'HEAD', base]).stdout.trim() || null;
  const creds = credentials ?? visibleCredentials();
  const secrets = blockingOf(results).filter((f) => f.secret);
  const decisions = secrets.map((f) => ({ f, d: judgeSecret(worktree, f, { mergeBase, credentials: creds, prOpen }) }));
  appendJsonl(metricsFile(config, DECISIONS_METRICS), decisions.map(({ f, d }) => ({ ts: nowIso(), story: keys[0] ?? null, branch, head, where: 'after-branch-ci', tool: f.tool, rule: f.rule, file: f.file, line: f.line, commit: f.vendorFingerprint ?? null, value: d.value, fake: d.fake, location: d.location, verdict: d.verdict, wayOut: d.wayOut })));
  const summary = decisions.map(({ f, d }) => `${where(f)} ${d.value}${d.fake ? ' (fake)' : ''}, ${d.location}: ${d.wayOut.join(' + ') || 'none'}`);
  if (decisions.some(({ d }) => d.wayOut.includes('escalate'))) return { fixRounds: spent, retried: false, reason: `the secret decision table says escalate (${summary.join('; ')})`, decisions: summary };
  // One fixing round here for what is still in the files (a secret's value, another finding, a job that could not run);
  // nothing is pushed by it, and the jobs run again on the fixed head.
  let now = results;
  const inFiles = secrets.some((f) => onlyInHistory(worktree, f) !== true) || blockingOf(results).some((f) => !f.secret) || failing.some((r) => !(r.findings ?? []).some((f) => f.verdict === 'blocking'));
  if (inFiles && budget.left() < 1) return { fixRounds: spent, retried: false, reason: 'a fixing round is needed, but implement.ci.maxFixRounds has none left: a person decides', decisions: summary };
  if (inFiles) {
    spent = 1;
    const g = fix({ cwd: worktree, base, targetArgs, seedFile, prCheckCli, env, budget, run, checks: gateChecks(config, { branch, base, jobs, log }), findingsOf: analysisFindings, log });
    now = g.results;
    if (now.every((r) => r.ok)) {
      const s = await push();
      return { fixRounds: spent, retried: Boolean(s?.pushed), reason: s?.pushed ? 'fixed here; CI\'s analysis jobs pass on this machine; pushed' : `the fix could not be pushed: ${s?.reason ?? 'unknown'}`, decisions: summary };
    }
  }
  // What is left: secrets only in the pushed branch's history. The table's fold-branch, when every one allows it.
  const left = blockingOf(now);
  const judgedLeft = left.map((f) => ({ f, d: f.secret ? judgeSecret(worktree, f, { mergeBase, credentials: creds, prOpen }) : null }));
  if (!left.length || judgedLeft.some(({ f, d }) => !d || !d.wayOut.includes('fold-branch') || onlyInHistory(worktree, f) !== true)) return { fixRounds: spent, retried: false, reason: `CI's analysis jobs still fail here (${now.filter((r) => !r.ok).map((r) => r.job).join(', ')}) and the decision table has no harness way out for them`, decisions: summary };
  const r = foldStoryBranch(config, worktree, left, {
    branch,
    base,
    prOpen,
    isFake: (f) => judgeSecret(worktree, f, { mergeBase, credentials: creds, prOpen }).fake,
    log,
    push: (fresh, remoteSha) => {
      const again = jobs(worktree, base, { log });
      if (again.some((x) => !x.ok)) return { pushed: false, reason: `CI's analysis jobs still fail on the folded head (${again.filter((x) => !x.ok).map((x) => x.job).join(', ')})` };
      return pushLease(remoteSha);
    },
  });
  if (r.pushed) appendJsonl(metricsFile(config, DECISIONS_METRICS), [{ ts: nowIso(), story: keys[0] ?? null, branch, head: r.record.to, where: 'fold-branch', from: r.record.from, dropped: r.record.dropped.length }]);
  return { fixRounds: spent, retried: Boolean(r.pushed), reason: r.pushed ? `folded the story branch into ${r.record.to.slice(0, 7)} (same tree) and pushed it with a lease` : r.reason, decisions: summary, fold: r.record ?? null };
}
