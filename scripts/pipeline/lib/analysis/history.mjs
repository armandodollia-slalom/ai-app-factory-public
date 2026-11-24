// A secret that lives only in the story branch's unpushed history (its value is gone from the working tree, but a commit
// the scanner reads still holds it) has a deterministic way out: the harness folds the branch's unpushed commits into
// one commit with the same tree, so the value leaves the history and nothing else changes. It never touches a commit
// any remote-tracking ref holds (pushed work), never the base branch or another shared branch, and it proves the new
// head's tree is the old head's tree byte for byte before it moves the branch. What it did is recorded.
//
//   dropUnpushedSecrets(config, cwd, findings, { branch, base }) -> { rewritten, reason, record }
//   foldStoryBranch(config, cwd, findings, { branch, base, prOpen, push }) -> { rewritten, pushed, reason, record }
// The second is the secret decision table's way out for a fake value already pushed on the story's own branch with no
// PR open (secret-table.mjs): the branch's commits since the base fold into one, and the branch is pushed with a lease.
import { writeText } from '../redact.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../git.mjs';
import { metricsFile } from '../state.mjs';
import { appendJsonl, nowIso } from '../util.mjs';
import { onlyInHistory } from './secrets.mjs';
import { setting } from '../settings.mjs';

const COMMIT = /^[0-9a-f]{40}$/;
export const REWRITES_METRICS = 'history-rewrites.jsonl';
const SHARED = new Set(['main', 'master', 'develop', 'trunk', 'HEAD']);

const lines = (r) => (r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []);

// The findings a history rewrite could clear: a commit-reading finding (it names its commit) whose value the working tree
// no longer holds.
export function historyOnly(cwd, findings) {
  return findings.filter((f) => COMMIT.test(String(f.vendorFingerprint ?? '')) && onlyInHistory(cwd, f) === true);
}

export function dropUnpushedSecrets(config, cwd, findings, { branch, base, env = process.env, log = null } = {}) {
  return fold(config, cwd, findings, { branch, base, env, log, kind: 'unpushed' });
}

// Folds the commits of `branch` that the exclusion does not reach: unpushed (not on any remote-tracking ref) or, for the
// story branch's own pushed history, every commit not on the base.
function fold(config, cwd, findings, { branch, base, env = process.env, log = null, kind }) {
  const not = kind === 'branch' ? [base] : ['--remotes'];
  const no = (reason) => ({ rewritten: false, reason });
  const targets = historyOnly(cwd, findings);
  if (!targets.length) return no('no finding lives only in history (its value is still in the working tree, or its commit is unknown)');
  const current = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  const baseName = String(base ?? '').replace(/^(refs\/remotes\/)?[^/]+\//, '');
  if (!branch || current !== branch) return no(`the worktree is on ${current || 'a detached HEAD'}, not the story's branch ${branch ?? '(unknown)'}`);
  if (SHARED.has(branch) || branch === baseName || branch === base) return no(`${branch} is a base or shared branch; it is never rewritten`);
  const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  // Unpushed: in the branch, in no remote-tracking ref. Every target commit must be among them.
  if (kind === 'branch' && !base) return no('no base branch to fold the story branch onto');
  const unpushed = lines(git(cwd, ['rev-list', 'HEAD', '--not', ...not]));
  if (!unpushed.length) return no(kind === 'branch' ? 'the branch has no commit of its own' : 'the branch has no unpushed commit');
  const pushed = targets.filter((f) => !unpushed.includes(f.vendorFingerprint));
  if (pushed.length) return no(kind === 'branch' ? `the value is in a commit the base already has (${pushed.map((f) => f.vendorFingerprint.slice(0, 7)).join(', ')})` : `the value is in a commit a remote already has (${pushed.map((f) => f.vendorFingerprint.slice(0, 7)).join(', ')}); pushed history is never rewritten`);
  if (base && unpushed.some((c) => git(cwd, ['merge-base', '--is-ancestor', c, base]).status === 0)) return no('an unpushed commit is on the base branch');
  // Parents of the new commit: the first-parent ancestor where the unpushed run starts, then every other pushed commit
  // the run merged (a merge of the base keeps its meaning: the change against the base stays the same).
  let first = head;
  for (;;) {
    const p = git(cwd, ['rev-parse', '--verify', '--quiet', `${first}^1`]).stdout.trim();
    if (!p) return no('the unpushed commits reach the root commit; there is no pushed commit to keep');
    first = p;
    if (!unpushed.includes(first)) break;
  }
  const boundary = lines(git(cwd, ['rev-list', '--boundary', 'HEAD', '--not', ...not])).filter((l) => l.startsWith('-')).map((l) => l.slice(1));
  const others = boundary.filter((c) => c !== first && git(cwd, ['merge-base', '--is-ancestor', c, first]).status !== 0);
  const merged = others.filter((c) => !others.some((d) => d !== c && git(cwd, ['merge-base', '--is-ancestor', c, d]).status === 0));
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const dropped = lines(git(cwd, ['log', '--format=%H %s', 'HEAD', '--not', ...not])).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41, 200) }));
  const what = kind === 'branch' ? 'commit(s) of the story branch' : 'unpushed commit(s)';
  const message = [
    `${branch}: ${dropped.length} ${what} folded into one by the harness`,
    '',
    `A secret-scan finding lived only in this branch's ${kind === 'branch' ? 'history (a fake test value, already replaced in the files; the branch has no PR)' : 'unpushed history (its value was already removed from the files)'}: ${targets.map((f) => `${f.tool} ${f.rule} ${f.file}:${f.line}`).join('; ')}.`,
    'The tree is unchanged. Folded commits:',
    ...dropped.map((d) => `- ${d.sha.slice(0, 12)} ${d.subject}`),
  ].join('\n');
  const made = git(cwd, ['commit-tree', tree, '-p', first, ...merged.flatMap((c) => ['-p', c]), '-m', message], { env: { ...env, PIPELINE_DISABLE: '1' } });
  const fresh = made.stdout.trim();
  if (made.status !== 0 || !COMMIT.test(fresh)) return no(`git commit-tree failed: ${String(made.stderr ?? '').slice(0, 200)}`);
  if (git(cwd, ['rev-parse', `${fresh}^{tree}`]).stdout.trim() !== tree) return no('the folded commit\'s tree differs from the head\'s; nothing was moved');
  // Compare-and-swap: the branch moves only if it still points at the head this was computed from.
  const moved = git(cwd, ['update-ref', '-m', `factory: fold ${kind === 'branch' ? 'the story branch' : 'unpushed history'} to drop a secret`, `refs/heads/${branch}`, fresh, head]);
  if (moved.status !== 0) return no(`the branch moved meanwhile: ${String(moved.stderr ?? '').slice(0, 200)}`);
  const still = targets.filter((f) => lines(git(cwd, ['rev-list', fresh])).includes(f.vendorFingerprint));
  const record = { ts: nowIso(), kind, branch, from: head, to: fresh, tree, parents: [first, ...merged], dropped: dropped.map((d) => d.sha), findings: targets.map((f) => ({ id: f.id, tool: f.tool, rule: f.rule, file: f.file, line: f.line, commit: f.vendorFingerprint })), treeIdentical: true, stillReachable: still.length };
  try {
    appendJsonl(metricsFile({ root: cwd, metricsDir: setting(config, 'metricsDir'), stateDir: setting(config, 'stateDir') }, REWRITES_METRICS), [record]);
    const dir = path.join(cwd, setting(config, 'stateDir'), 'analysis-rewrites');
    fs.mkdirSync(dir, { recursive: true });
    writeText(path.join(dir, `${fresh}.json`), `${JSON.stringify(record, null, 1)}\n`);
  } catch {
    /* records are best effort; the git reflog keeps the move */
  }
  log?.(`history: folded ${dropped.length} ${what} of ${branch} into ${fresh.slice(0, 7)} (same tree ${tree.slice(0, 7)}) to drop ${targets.length} secret finding(s) that lived only in history`);
  return { rewritten: true, reason: null, record };
}

// The decision table's way out for a fake value in the story branch's pushed history (secret-table.mjs, location
// pushed-no-pr, value fake-flagged): only on the story's own branch, only with no PR open, only when every finding it
// clears is a fake by the table's rule (`isFake`), and only with the value already gone from the files. The branch's
// commits since the base fold into one with the same tree; the push replaces the remote branch with a lease on the sha
// it had (`push(fresh, remoteSha)` returns { pushed, reason }).
export function foldStoryBranch(config, cwd, findings, { branch, base, prOpen, isFake, push, env = process.env, log = null } = {}) {
  const no = (reason) => ({ rewritten: false, pushed: false, reason });
  if (prOpen !== false) return no(prOpen ? `a PR is open for ${branch}: its history is never rewritten (escalate)` : 'whether a PR is open is unknown (escalate)');
  const targets = historyOnly(cwd, findings);
  if (!targets.length) return no('no finding lives only in history (its value is still in the files, or its commit is unknown)');
  const real = targets.filter((f) => !isFake?.(f));
  if (real.length) return no(`not a fake value by the decision table's rule (${real.map((f) => `${f.file}:${f.line}`).join(', ')}): a pushed value that may be a real credential is for a person (escalate)`);
  const remote = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).stdout.trim();
  const r = fold(config, cwd, targets, { branch, base, env, log, kind: 'branch' });
  if (!r.rewritten) return { ...r, pushed: false };
  const p = push(r.record.to, remote || null);
  if (!p?.pushed) {
    // The remote did not take it: the local branch goes back to what the remote has, nothing is half-done.
    git(cwd, ['update-ref', '-m', 'factory: fold not pushed, restored', `refs/heads/${branch}`, r.record.from, r.record.to]);
    return { rewritten: false, pushed: false, reason: `the folded branch could not be pushed: ${p?.reason ?? 'unknown'}` };
  }
  log?.(`history: ${branch} replaced on the remote by the folded commit ${r.record.to.slice(0, 7)} (lease on ${remote ? remote.slice(0, 7) : 'no remote branch'})`);
  return { ...r, pushed: true };
}
