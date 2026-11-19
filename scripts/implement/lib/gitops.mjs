// Git operations of the implement stage: commits made by the runner (hooks disabled), and the subtask
// worktrees the orchestrated flow branches off a story's worktree.
import fs from 'node:fs';
import path from 'node:path';
import { addWorktree, git, revExists } from '../../pipeline/lib/git.mjs';
import { gateStaged } from '../../pipeline/lib/analysis/commit-gate.mjs';

export const commitEnv = { ...process.env, PIPELINE_DISABLE: '1' };
export const mustGit = (cwd, args) => git(cwd, args, { allowFail: false, env: commitEnv });

// graphify's output (graphify-out/ at the root, or below a folder an agent ran `graphify update <dir>` on) is never
// part of an agent's change; the root's shared semantic cache is committed by `factory graphify-build`, not here.
export const NO_GRAPHIFY = ':(exclude,glob)**/graphify-out/**';
// A node_modules symlink an agent made to reuse the main checkout's packages is a file, so `node_modules/` in
// .gitignore does not match it (dogfood C2: a group branch committed a symlink to an absolute path on the
// developer's machine; the PR check caught it). Harness commits never include node_modules, link or folder.
export const NO_NODE_MODULES = [':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**'];
export const HARNESS_EXCLUDES = [NO_GRAPHIFY, ...NO_NODE_MODULES];

// The commit gate reads the staged files first: a file holding a new secret is left out of the commit, uncommitted in
// the worktree (analysis/commit-gate.mjs), and the story's next scan hands it back to the implementer.
export function commitAll(cwd, message, specs = ['.', ...HARNESS_EXCLUDES]) {
  git(cwd, ['add', '-A', '--', ...specs], { env: commitEnv });
  if (git(cwd, ['diff', '--cached', '--quiet']).status === 0) return false;
  gateStaged(cwd, { message, log: (m) => process.stderr.write(`${m}\n`) });
  if (git(cwd, ['diff', '--cached', '--quiet']).status === 0) return false;
  mustGit(cwd, ['commit', '-q', '-m', message]);
  return true;
}

// The pipeline's records of the work (PR check rounds, run conditions, usage) committed with it (council C8: a PR
// check that passed in one round left its record untracked in the worktree, so the PR branch had no PR check).
export function commitRecords(cwd, message = 'Pipeline records') {
  const dir = '.factory/metrics';
  try {
    if (!fs.existsSync(path.join(cwd, dir))) return false;
  } catch {
    return false;
  }
  return commitAll(cwd, message, [dir]);
}

export const headSha = (cwd) => git(cwd, ['rev-parse', 'HEAD']).stdout.trim();

export function filesChanged(cwd, base, to = 'HEAD') {
  const r = git(cwd, ['diff', '--name-only', base, to]);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

export function diffSince(cwd, base, maxChars = 150_000) {
  const stat = git(cwd, ['diff', '--stat', base, 'HEAD']).stdout;
  let diff = git(cwd, ['diff', '--no-ext-diff', base, 'HEAD', '--', '.', ':(exclude)graphify-out']).stdout;
  if (diff.length > maxChars) diff = `${diff.slice(0, maxChars)}\n... diff truncated at ${maxChars} chars; read the remaining files directly.`;
  return `Base commit: ${base}\n\n${stat}\n${diff}`;
}

// Throws away whatever an agent that must not edit left in a worktree. Returns the paths it removed.
// Throws away what an agent left in the worktree. `keep` (folders, repository-relative) survive as they are:
// the metrics the agent run itself appended (its token usage) are not the agent's edits (dogfood: a pair
// verifier's usage was erased this way, so its cost was missing from every report).
export function discardChanges(cwd, { keep = [] } = {}) {
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
  if (!dirty.length) return [];
  const kept = new Map();
  const isKept = (f) => keep.some((k) => f === k || f.startsWith(`${k.replace(/\/+$/, '')}/`));
  for (const f of dirty.filter(isKept)) {
    const abs = path.join(cwd, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) kept.set(f, fs.readFileSync(abs));
  }
  git(cwd, ['reset', '-q', '--hard', 'HEAD'], { env: commitEnv });
  git(cwd, ['clean', '-fdq'], { env: commitEnv });
  for (const [f, data] of kept) {
    fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
    fs.writeFileSync(path.join(cwd, f), data);
  }
  return dirty.filter((f) => !isKept(f));
}

export const unmergedFiles = (cwd) => git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
export const mergeInProgress = (cwd) => git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;

// ---------------------------------------------------------------------------------------------
// Subtask worktrees: <story worktree>--<id> on <branchPrefix><key>--<id>
// ---------------------------------------------------------------------------------------------

export const subtaskBranch = (prefix, key, id) => `${prefix}${key.toLowerCase()}--${id}`;
export const subtaskWorktree = (storyWorktree, id) => `${storyWorktree}--${id}`;

export function removeWorktree(root, worktree, branch) {
  if (fs.existsSync(worktree)) git(root, ['worktree', 'remove', '--force', worktree], { env: commitEnv });
  if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  git(root, ['worktree', 'prune'], { env: commitEnv });
  if (branch && revExists(root, `refs/heads/${branch}`)) git(root, ['branch', '-D', branch], { env: commitEnv });
}

// A fresh worktree and branch for a subtask, from the story branch's current HEAD. A leftover from an
// earlier run (kept for debugging) is replaced. The story worktree's knowledge graph is copied in, so the
// agents can query it without rebuilding.
export function createSubtaskWorktree(storyWorktree, { prefix, key, id }) {
  const branch = subtaskBranch(prefix, key, id);
  const worktree = subtaskWorktree(storyWorktree, id);
  removeWorktree(storyWorktree, worktree, branch);
  const base = headSha(storyWorktree);
  addWorktree(storyWorktree, ['-q', '-b', branch, worktree, base], { env: commitEnv });
  const graph = path.join(storyWorktree, 'graphify-out');
  for (const f of ['graph.json', 'GRAPH_REPORT.md']) {
    const src = path.join(graph, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(worktree, 'graphify-out'), { recursive: true });
    fs.copyFileSync(src, path.join(worktree, 'graphify-out', f));
  }
  return { branch, path: worktree, base };
}

// Subtask worktrees of a story (or of every story) that are still registered with git.
export function listSubtaskWorktrees(root, prefix, key = null) {
  const out = [];
  let current = null;
  for (const line of git(root, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) };
    else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice(18);
      const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z][a-z0-9]*-\\d+)--([a-z0-9-]+)$`).exec(current.branch);
      if (m && (!key || m[1] === key.toLowerCase())) out.push({ ...current, key: m[1].toUpperCase(), id: m[2] });
    }
  }
  return out;
}

// Hunks between `base` and HEAD that change only whitespace or line breaks: the removed and the added lines hold
// the same text once every whitespace character is dropped (a reflowed `new (){` -> `new()` + `{`, re-indented
// comments, blank lines). Files new since `base` have none. Returns [{ file, lines: "from-to" }].
export function formattingOnlyHunks(cwd, base, files = null) {
  const diff = git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', base, 'HEAD', '--', ...(files ?? ['.']), ...HARNESS_EXCLUDES]).stdout;
  const out = [];
  let file = null;
  let isNew = false;
  let hunk = null;
  const flush = () => {
    if (hunk && file && !isNew) for (const [from, to] of formattingRuns(hunk.removed, hunk.added)) out.push({ file, lines: to > from ? `${hunk.start + from}-${hunk.start + to - 1}` : `after ${hunk.start + from - 1}` });
    hunk = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      file = null;
      isNew = false;
    } else if (line.startsWith('new file mode') || line === '--- /dev/null') isNew = true;
    else if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '');
    else if (line.startsWith('@@')) {
      flush();
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = { start: Number(m?.[1] ?? 0), count: m?.[2] === undefined ? 1 : Number(m[2]), removed: [], added: [] };
    } else if (hunk && line.startsWith('-')) hunk.removed.push(line.slice(1));
    else if (hunk && line.startsWith('+')) hunk.added.push(line.slice(1));
  }
  flush();
  return out;
}

const squash = (lines) => lines.join('').replace(/\s+/g, '');

// The runs of a hunk that change only whitespace or line breaks, as [from, to) offsets into its added lines. A hunk
// can hold a formatting-only run next to a real edit (git joins adjacent changes): the runs are matched from the
// start and from the end of the hunk, up to `window` lines on each side.
export function formattingRuns(removed, added, window = 8) {
  if (!removed.length && !added.length) return [];
  // Blank lines added or removed alone are left out: spacing around new code is part of an edit.
  if (!squash(removed) && !squash(added)) return [];
  if (squash(removed) === squash(added)) return [[0, added.length]];
  const runs = [];
  const match = (rem, add) => {
    for (let i = 1; i <= Math.min(window, rem.length); i++) for (let j = 1; j <= Math.min(window, add.length); j++) if (squash(rem.slice(0, i)) && squash(rem.slice(0, i)) === squash(add.slice(0, j))) return [i, j];
    return null;
  };
  let [r, a] = [0, 0];
  for (let m = match(removed, added); m; m = match(removed.slice(r), added.slice(a))) {
    runs.push([a, a + m[1]]);
    r += m[0];
    a += m[1];
  }
  const rev = (x) => [...x].reverse();
  let [rr, ar] = [removed.length, added.length];
  for (let m = match(rev(removed.slice(r, rr)), rev(added.slice(a, ar))); m; m = match(rev(removed.slice(r, rr)), rev(added.slice(a, ar)))) {
    runs.push([ar - m[1], ar]);
    rr -= m[0];
    ar -= m[1];
  }
  return runs.sort((x, y) => x[0] - y[0]);
}
