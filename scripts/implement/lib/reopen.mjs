// Re-runs of bug fixes a person reopened after the review gate assessed them (label `reopened`, set by
// `board sync`; see docs/ai-pipeline/review-gate.md#human-reopens). The reopen's reason is already in
// the issue's `## Decisions`, so every agent of the re-run gets it as a binding requirement.
//   - its PR is still open: the ticket runs again on the PR's branch (a single-ticket PR), or joins its
//     PR group's branch (a bug-epic group PR); the PR is updated and gated again;
//   - its PR merged: the fix runs as a follow-up, on a new branch from the base (`<branch>-r<n>`), and
//     its new PR goes through the same gate (the ticket's reopens keep it from auto-merging).
import { git, revExists } from '../../pipeline/lib/git.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';

export const reopenedLabel = (config) => config.implement?.reviewGate?.labels?.reopened ?? 'reopened';
// A planned story carries its issue's labels as `labels`; a loaded ticket as `issue.labels`.
export const isReopened = (config, s) => Boolean((s.labels ?? s.issue?.labels)?.includes(reopenedLabel(config)));

// The open PR of a branch on the code host, or null. `env` / `publisher`: the identity to ask as (the PR
// bot's, lib/bot.mjs: its gh environment on GitHub, its token elsewhere).
export function openPrFor(config, branch, env, publisher = null) {
  try {
    const host = hostFor(config, { ...(env ? { env } : {}), ...(publisher?.token ? { token: publisher.token } : {}), ...(publisher?.repo ? { repo: publisher.repo } : {}) });
    return host.sync.pr.list({ head: branch, state: 'open', limit: 1 })[0]?.url ?? null;
  } catch {
    return null;
  }
}

// Whether a PR (by URL) is open: true, false, or 'unknown' when the host could not be read (callers treat it as open).
export function prIsOpen(config, url) {
  try {
    return String(hostFor(config).sync.pr.get(url)?.state ?? '').toLowerCase() === 'open';
  } catch {
    return 'unknown';
  }
}

const branchExists = (config, branch) => revExists(config.root, `refs/heads/${branch}`) || git(config.root, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).status === 0;

// Where a reopened ticket runs (mutates the planned story): on its open PR's branch (`fromRemote`, so a
// person's commits on the PR are kept), else as a follow-up on the first free `<branch>-r<n>`.
export function placeReopened(config, s, { prOf = (b) => openPrFor(config, b), exists = (b) => branchExists(config, b) } = {}) {
  const pr = prOf(s.branch);
  if (pr) {
    Object.assign(s, { reopenedPr: pr, fromRemote: true });
    return s;
  }
  let n = 1;
  while (exists(`${s.branch}-r${n}`)) n++;
  Object.assign(s, { followUp: n, branch: `${s.branch}-r${n}`, worktree: `${s.worktree}-r${n}` });
  return s;
}

// Brings a worktree's branch up to its remote (fast-forward only): a person may have pushed to the PR.
export function syncFromRemote(worktree, branch, env) {
  if (git(worktree, ['fetch', '-q', 'origin', branch], { env }).status !== 0) return false;
  return git(worktree, ['merge', '--ff-only', '-q', `origin/${branch}`], { env }).status === 0;
}
