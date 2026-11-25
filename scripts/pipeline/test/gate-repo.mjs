// Shared by the analysis gate's clean-code tests (clean-code-tools, repeats): a repository whose base files are on
// `main` and whose change is on the branch `change`, and the gate run on that change.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

export const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

// The repository (removed after the test): `base` files committed on main, then `change` files on the branch.
export function changeRepo(t, { base, change, prefix = 'gate-repo-' }) {
  const root = tmp(prefix);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  for (const [step, files] of [['base', base], ['change', change]]) {
    if (step === 'change') git(root, 'checkout', '-qb', 'change');
    for (const [f, text] of Object.entries(files)) write(root, f, text);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', step);
  }
  return root;
}

// The story slot of the analysis gate on the change against main (imported when run: a test sets its cache folder first).
export async function runGate(config) {
  const { runSlot } = await import('../lib/analysis/runner.mjs');
  const { resolveAnalysis } = await import('../lib/analysis/config.mjs');
  return runSlot(config, 'story', { cwd: config.root, base: 'main', resolved: resolveAnalysis(config) });
}
