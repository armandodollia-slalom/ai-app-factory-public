// CI parity: every check the factory's own CI workflows run on a pull request has a step that runs the same
// check before the pipeline opens the PR, so CI never finds what the pipeline could have (dogfood C4: CI's
// `factory lint` failed on whitespace in an implementation line nothing had linted). The registry below
// lists every job of templates/ci/github-actions/workflows; docs/ai-pipeline/ci-parity.md lists the same, and a test keeps
// the three in step.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { changedFiles, lintChanged } from '../../pipeline/lib/lint.mjs';
import { run as defaultRun, tail } from '../../pipeline/lib/util.mjs';

const FACTORY = path.join(INSTALL_ROOT, 'bin', 'factory.mjs');

// The CI gate runs `factory teststack drift` when .factory/config.json names a drift command.
function driftConfigured(root) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(root, '.factory/config.json'), 'utf8')).teststack?.commands?.drift);
  } catch {
    return false;
  }
}

// workflow file (templates/ci/github-actions/workflows) -> job -> what runs before the PR. `run`: the commands a pre-PR parity
// run executes (null: the check is a pipeline stage of its own, or not a pull request check).
export const CI_PARITY = {
  'gate.yml': {
    pipeline: { prePr: 'parity run before the PR: factory check, factory models check, factory teststack validate (and factory teststack drift when the repository configures it)', run: (base, root) => [['check'], ['models', 'check'], ['teststack', 'validate'], ...(driftConfigured(root) ? [['teststack', 'drift']] : [])] },
    policy: { prePr: 'architecture review stage (Architecture Policy Pack), and the parity run: factory arch selfcheck', run: () => [['arch', 'selfcheck', '--policy-dir', '.factory/policy', '--workspace', '.']] },
    lint: { prePr: 'changed-line lint after every implementer run and every PR check fixer commit, and in the parity run (same code as factory lint --base)', run: 'lint' },
    'feature-verification': { prePr: 'feature verification stage, and the parity run: factory fv check --changed-from <base>', run: (base) => [['fv', 'check', '--changed-from', base]] },
  },
  'feature-verification-check.yml': { check: { prePr: 'the parity run: factory fv check --changed-from <base> (this workflow is what gate.yml calls)', run: (base) => [['fv', 'check', '--changed-from', base]] } },
  'pr-check.yml': { check: { prePr: 'the PR check stage before the PR opens (fix mode)', run: null } },
  'pr-demo-video.yml': {
    record: { prePr: 'feature verification runs the stack specs that record the videos', run: null },
    cleanup: { prePr: null, why: 'removes published videos after the PR closes', run: null },
  },
  'review-quorum.yml': { 'review-quorum': { prePr: null, why: 'counts approvals from people; the review gate sets how many', run: null } },
  'board-epic-assign.yml': { sync: { prePr: null, why: 'not a pull request check (issue events)', run: null } },
  'board-escalation-resolve.yml': { resolve: { prePr: null, why: 'not a pull request check (issue comments)', run: null } },
  'graphify-cache-prune.yml': { prune: { prePr: null, why: 'not a pull request check (schedule)', run: null } },
  'retro.yml': { lessons: { prePr: null, why: 'not a pull request check (manual)', run: null } },
  'tracker-sweep.yml': { sweep: { prePr: null, why: 'not a pull request check (scheduled tracker sweep)', run: null } },
};

// CI's `factory lint --base <base>` on a checkout: problems on the lines the change added or changed, in every
// changed file (implementation and tests). [] when clean.
export function changedLineLint(root, base) {
  const config = loadConfig('feature-verification', root);
  return lintChanged(config, changedFiles(root, { base }), { base });
}

// Runs every pre-PR parity check of a pull request job on `root` against `base`. Returns [{ check, ok, output }].
export function parityChecks(root, base, { run = defaultRun } = {}) {
  const out = [];
  const seen = new Set();
  for (const [workflow, jobs] of Object.entries(CI_PARITY)) {
    for (const [job, p] of Object.entries(jobs)) {
      if (!p.run) continue;
      if (p.run === 'lint') {
        const errors = changedLineLint(root, base);
        out.push({ check: `${workflow} ${job}`, ok: !errors.length, output: errors.join('\n') });
        continue;
      }
      for (const args of p.run(base, root)) {
        const key = args.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const r = run(process.execPath, [FACTORY, ...args], { cwd: root, env: { ...process.env, PIPELINE_ROOT: root }, timeoutSec: 900 });
        out.push({ check: `${workflow} ${job}: factory ${key}`, ok: r.status === 0, output: r.status === 0 ? '' : tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim(), 2000) });
      }
    }
  }
  return out;
}

// The PR body line: what ran before the PR and how it ended.
export function paritySection(results) {
  if (!results?.length) return '';
  const failed = results.filter((r) => !r.ok);
  return failed.length
    ? `- CI checks run before this PR: ${failed.length} of ${results.length} still fail (${failed.map((r) => r.check).join('; ')})\n`
    : `- CI checks run before this PR: all ${results.length} passed (${results.map((r) => r.check.replace(/^[^ ]+ /, '')).join('; ')})\n`;
}

// Parity failures as PR check findings, for the fixing loop (`pr-check run --fix-first`).
export const parityFindings = (results) => results.filter((r) => !r.ok).map((r, i) => ({ id: `CI-${i + 1}`, lens: 'style', severity: 'major', title: `CI check fails before the PR: ${r.check}`, detail: r.output, evidence: r.output.split('\n')[0] ?? '', requirement: 'The pull request passes every check CI runs on it.', fix: 'Make this check pass: fix the reported lines (formatting, lint, generated files or verified tests) without changing behavior.' }));

export const gitHead = (root) => git(root, ['rev-parse', 'HEAD']).stdout.trim();

// Before a PR opens: every parity check; failures go through the PR check's fixing loop as findings
// (`pr-check run --fix-first`, one more time at most), then the checks run again. Returns
// { results, fixRun: { verdict, rounds, commits } | null }. `targetArgs`: --story K or --stories K1,K2.
// Files a CI fix may change without the code being judged again: tests, end-to-end specs, the pipeline's records and
// plans, docs and lint configuration.
const NOT_PRODUCTION = /^(?:tests?\/|e2e\/|\.factory\/|graphify-out\/|docs\/|[^/]+\.md$|\.markdownlint|\.editorconfig)|(?:^|\/)(?:[^/]*\.(?:Tests?|UnitTests|FunctionalTests)[^/]*)\//;

export function parityGate({ cwd, base, targetArgs, seedFile, prCheckCli, env = process.env, run = defaultRun, checks = parityChecks, findingsOf = parityFindings, log = () => {} }) {
  let results = checks(cwd, base, { run });
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return { results, fixRun: null };
  log(`CI checks that would fail on the PR: ${failed.map((r) => r.check).join('; ')}; fixing them first`);
  fs.mkdirSync(path.dirname(seedFile), { recursive: true });
  fs.writeFileSync(seedFile, JSON.stringify({ score: 8, lensScores: {}, upheldFindings: findingsOf(results) }, null, 2));
  // The fixer fixes the failing checks; the checks themselves, run again below, are the verification. No critic round
  // follows a fix that touched only tests, the pipeline's records or docs: the PR check already judged the code, and a
  // full round after a mechanical fix cost a bug about $2.30 (council C3, cost). A fix that changed production code gets
  // one report-only round of the code lenses.
  const before = String(run('git', ['rev-parse', 'HEAD'], { cwd }).stdout ?? '').trim();
  const r = run(process.execPath, [prCheckCli, 'run', ...targetArgs, '--base', base, '--until', 'major', '--max-rounds', '1', '--fix-first', seedFile, '--json'], { cwd, env, timeoutSec: 72000 } /* a ceiling (10x the usual 2 h): its agents end on no progress (agent-supervisor.mjs) */);
  let fixRun = null;
  try {
    const out = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{')));
    fixRun = { verdict: out.verdict, rounds: out.rounds, commits: out.commits ?? [] };
  } catch {
    fixRun = { verdict: 'failed', rounds: 0, commits: [], error: tail(String(r.stderr || r.stdout), 300) };
  }
  const touched = before ? String(run('git', ['diff', '--name-only', before, 'HEAD'], { cwd }).stdout ?? '').split('\n').filter(Boolean) : [];
  const production = touched.filter((f) => !NOT_PRODUCTION.test(f));
  if (production.length) {
    log(`the CI fix changed production code (${production.slice(0, 5).join(', ')}${production.length > 5 ? ', ...' : ''}); one report-only check of the code`);
    const review = run(process.execPath, [prCheckCli, 'run', ...targetArgs, '--base', base, '--no-fix', '--lenses', 'acceptance,flow,style', '--json'], { cwd, env, timeoutSec: 36000 } /* a ceiling (10x the usual 1 h) */);
    try {
      const out = JSON.parse(String(review.stdout).slice(String(review.stdout).indexOf('{')));
      fixRun.review = { verdict: out.verdict, score: out.score, openFindings: out.openFindings ?? [] };
    } catch {
      fixRun.review = { verdict: 'failed', error: tail(String(review.stderr || review.stdout), 300) };
    }
  }
  results = checks(cwd, base, { run });
  log(`CI checks before the PR, after the fix: ${results.filter((x) => x.ok).length} of ${results.length} pass`);
  return { results, fixRun };
}
