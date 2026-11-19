// What `factory adapter check <kind>` needs around the conformance suite (pipeline/lib/providers/conformance.mjs): the
// configured adapter of the kind, a read fixture (the latest pull request's head for a CI system or a scanner), and the
// git helper that pushes and deletes the --write test branch.
import { spawnSync } from 'node:child_process';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';
import { ciFor } from '../../pipeline/lib/ci/index.mjs';
import { trackerFor } from '../../board/lib/trackers/index.mjs';

export async function adapterFor(kind, config) {
  if (kind === 'host') return hostFor(config).sync;
  if (kind === 'tracker') return trackerFor(config);
  if (kind === 'ci') return ciFor(config);
  const { scannerFor } = await import('../../pipeline/lib/analysis/scanners/index.mjs');
  return scannerFor(config);
}

// The head of the repository's latest pull request (open first), for the CI and scanner checks.
export async function checkFixture(kind, config) {
  if (!['ci', 'scanner'].includes(kind)) return {};
  try {
    const host = hostFor(config).sync;
    const pr = host.pr.list({ state: 'open', limit: 1 })[0] ?? host.pr.list({ state: 'all', limit: 1 })[0];
    if (!pr) return { root: config.root };
    const full = host.pr.get(pr.number);
    let changed = [];
    try {
      changed = host.pr.files(pr.number).map((f) => f.path);
    } catch {
      /* the changed files are optional for the checks */
    }
    return { root: config.root, pr: pr.number, head: full?.headSha ?? pr.headSha, base: full?.base ?? pr.base, branch: full?.head ?? pr.head, changed };
  } catch {
    return { root: config.root };
  }
}

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
export function gitHelper(root) {
  let pushed = null;
  return {
    head: () => pushed ?? (git(root, ['rev-parse', 'HEAD']).stdout.trim() || null),
    // The test branch gets one empty commit of its own on top of HEAD (made without touching the working tree or the
    // current branch), so the host has something to open a pull request for: a branch at the base's own commit is
    // refused ("No commits between main and ...").
    pushBranch: (branch) => {
      const tree = git(root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
      const made = git(root, ['-c', 'user.name=factory adapter check', '-c', 'user.email=factory-adapter-check@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'factory adapter check (an empty commit; the branch is deleted after the check)']);
      const sha = made.stdout.trim();
      if (made.status !== 0 || !sha) return false;
      pushed = sha;
      return git(root, ['push', '-q', 'origin', `${sha}:refs/heads/${branch}`]).status === 0;
    },
    deleteBranch: (branch) => git(root, ['push', '-q', 'origin', '--delete', branch]).status === 0,
  };
}
