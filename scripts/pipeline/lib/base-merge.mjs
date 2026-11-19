// Keeping a pipeline branch mergeable on GitHub. Every pipeline branch appends to the same metrics logs
// (.factory/metrics/*.jsonl, `merge=union` in .gitattributes): git merges them locally, but GitHub's
// mergeability check ignores merge drivers, so once one pipeline PR merges, every other open one is "dirty":
// no pull_request workflow runs and it cannot be merged (dogfood C2: #21, #40 and #50 after #41 and #49).
// Merging the latest base into the branch (locally, where the union driver applies) before it is pushed
// keeps it clean; a real conflict is left for a person and reported.
import { git } from './git.mjs';

const quiet = { ...process.env, PIPELINE_DISABLE: '1', GIT_MERGE_AUTOEDIT: 'no' };

// Merges origin/<base> into the checkout's HEAD. { merged, upToDate, conflict, files }.
export function mergeLatestBase(cwd, base, { gitImpl = git, env: extraEnv = {} } = {}) {
  const quietEnv = { ...quiet, ...extraEnv };
  const b = String(base).replace(/^origin\//, '');
  if (gitImpl(cwd, ['fetch', '-q', 'origin', b], { env: quietEnv }).status !== 0) return { merged: false, error: `git fetch origin ${b} failed` };
  if (gitImpl(cwd, ['merge-base', '--is-ancestor', `origin/${b}`, 'HEAD']).status === 0) return { merged: false, upToDate: true };
  const merge = () => gitImpl(cwd, ['merge', '--no-edit', '-q', '-m', `Merge ${b} into this branch (keep the PR mergeable)`, `origin/${b}`], { env: quietEnv });
  let r = merge();
  if (r.status === 0) return { merged: true };
  let files = gitImpl(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
  if (!files.length) {
    // Not a conflict: git refused to start (council C5: the pipeline's own uncommitted metrics records blocked the
    // merge, and the PR opened unmergeable with "conflicts in" and no file). When the only local changes are the
    // pipeline's records, they are committed and the merge runs again.
    const dirty = gitImpl(cwd, ['status', '--porcelain']).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
    if (dirty.length && dirty.every((f) => /^\.factory\/(metrics|state)\//.test(f))) {
      gitImpl(cwd, ['add', '--', ...dirty.filter((f) => f.startsWith('.factory/metrics/'))], { env: quietEnv });
      gitImpl(cwd, ['commit', '-q', '-m', 'Record pipeline metrics'], { env: quietEnv });
      r = merge();
      if (r.status === 0) return { merged: true };
      files = gitImpl(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    }
    if (!files.length) return { merged: false, error: `git merge origin/${b} failed: ${String(r.stderr ?? r.stdout ?? '').trim().split('\n').slice(-2).join(' ')}` };
  }
  gitImpl(cwd, ['merge', '--abort'], { env: quietEnv });
  return { merged: false, conflict: true, files };
}
