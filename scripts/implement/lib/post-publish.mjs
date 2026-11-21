// After the runner publishes a fix PR (a single-ticket bug PR, or a bug-epic group PR), the review gate
// assesses it and decides how it gets merged (scripts/review-gate/, docs/ai-pipeline/review-gate.md).
// It runs as its own process from the PR's worktree, like the board events: a failure is logged and
// never changes a ticket's outcome. Feature PRs (stories, feature epics) are not gated.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { log, run } from '../../pipeline/lib/util.mjs';

const GATE_CLI = path.join(INSTALL_ROOT, 'scripts/review-gate/review-gate.mjs');

export function reviewGatePublish(worktree, { pr, keys, base, assessment = null, timeoutSec = 1800, run: runCmd = run, log: logFn = log }) {
  if (!pr || !keys?.length || !fs.existsSync(GATE_CLI)) return { status: 0, skipped: true };
  const env = { ...process.env, PIPELINE_ROOT: worktree };
  delete env.PIPELINE_CHILD;
  // Pipeline delivery never starts an agent on an open PR: --no-agent publishes needs-human if no saved assessment exists.
  const r = runCmd(process.execPath, [GATE_CLI, 'publish', '--pr', pr, '--tickets', keys.join(','), '--base', base, '--no-agent', ...(assessment && fs.existsSync(assessment) ? ['--assessment', assessment] : [])], { cwd: worktree, env, timeoutSec });
  const last = (r.status === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`;
  logFn(`${keys.join(', ')}: review gate: ${last}`);
  return r;
}

// Before the PR exists (implement.preOpen): the gate's assessment and the bug-triage agent's rating of the branch's
// change, saved for reviewGatePublish({ assessment }) at open, so no model runs once the PR is open. Returns
// `{ skipped: true, reason }` when the gate is off, the assessment object on success, or null when assessment failed.
export function reviewGateAssess(worktree, { keys, base, out, timeoutSec = 1800, run: runCmd = run, log: logFn = log }) {
  if (!keys?.length || !fs.existsSync(GATE_CLI)) return { skipped: true, reason: 'review-gate CLI not present' };
  const env = { ...process.env, PIPELINE_ROOT: worktree };
  delete env.PIPELINE_CHILD;
  fs.rmSync(out, { force: true });
  const r = runCmd(process.execPath, [GATE_CLI, 'assess', '--tickets', keys.join(','), '--base', base, '--out', out], { cwd: worktree, env, timeoutSec });
  const last = (r.status === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`;
  logFn(`${keys.join(', ')}: review gate: ${last}`);
  if (r.status === 0 && !fs.existsSync(out) && /^Review gate off\b/.test(last)) return { skipped: true, reason: last };
  if (r.status !== 0 || !fs.existsSync(out)) return null;
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    return null;
  }
}

