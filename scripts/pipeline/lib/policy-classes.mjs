// The "New projects and their classes" section of a pipeline pull request: the classes the architecture policy
// derived for the projects the branch adds (architecture-policy `classes --base --format markdown`), so the person
// approving the pull request sees each classification as they would see a line of the policy profile.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from './config.mjs';
import { policyPython } from './python.mjs';
import { run } from './util.mjs';

export function derivedClassesSection(cwd, base, { runner = run, python = policyPython } = {}) {
  if (!fs.existsSync(path.join(cwd, '.factory/policy/policy.yaml'))) return '';
  const py = python();
  if (!py.cmd) return '';
  const r = runner(py.cmd, [path.join(INSTALL_ROOT, 'architecture-policy/hooks/arch.py'), 'classes', '--policy-dir', '.factory/policy', '--workspace', '.', ...(base ? ['--base', base] : []), '--format', 'markdown'], { cwd, timeoutSec: 300 });
  return r.status === 0 ? String(r.stdout ?? '').trim() : '';
}

export const withDerivedClasses = (body, cwd, base, deps) => {
  const section = derivedClassesSection(cwd, base, deps);
  return section && !String(body ?? "").includes(section) ? `${body}\n\n${section}\n` : body;
};
