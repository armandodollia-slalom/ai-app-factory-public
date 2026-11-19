// The one Python interpreter the factory runs the architecture policy engine with: doctor, `factory policy`
// and the review's policy step all ask here, so they cannot disagree because of PATH order (a Homebrew
// python3 without the modules ahead of a pyenv one with them). The first candidate that can import
// pyyaml and jsonschema wins:
//   1. $FACTORY_PYTHON (when set, the only one)
//   2. the factory's own virtualenv, <install>/.venv (created by `factory python setup`)
//   3. python3, then python, on PATH
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from './config.mjs';

export const POLICY_MODULES = ['yaml', 'jsonschema'];
const memo = new Map();

export const venvPython = (installRoot = INSTALL_ROOT) => path.join(installRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

// $FACTORY_PYTHON is an explicit choice: it is the only candidate (no silent fallback to another one).
export function pythonCandidates({ env = process.env, installRoot = INSTALL_ROOT } = {}) {
  if (env.FACTORY_PYTHON) return [{ cmd: env.FACTORY_PYTHON, how: '$FACTORY_PYTHON' }];
  return [fs.existsSync(venvPython(installRoot)) && { cmd: venvPython(installRoot), how: "the factory's virtualenv" }, { cmd: 'python3', how: 'python3 on PATH' }, { cmd: 'python', how: 'python on PATH' }].filter(Boolean);
}

// { cmd, how, version } of the interpreter to use, or { cmd: null, tried: [...] } when none has the modules.
export function policyPython(options = {}) {
  const key = JSON.stringify([options.env?.FACTORY_PYTHON ?? process.env.FACTORY_PYTHON, options.installRoot ?? INSTALL_ROOT, process.env.PATH]);
  if (memo.has(key)) return memo.get(key);
  const tried = [];
  let found = null;
  for (const c of pythonCandidates(options)) {
    const r = spawnSync(c.cmd, ['-c', `import sys, ${POLICY_MODULES.join(', ')}; print(sys.executable); print(sys.version.split()[0])`], { encoding: 'utf8', shell: process.platform === 'win32' && !path.isAbsolute(c.cmd) });
    if (r.status === 0) {
      const [executable, version] = r.stdout.trim().split('\n');
      found = { cmd: c.cmd, how: c.how, executable, version };
      break;
    }
    tried.push(`${c.cmd} (${r.error?.code === 'ENOENT' ? 'not found' : (r.stderr.trim().split('\n').pop() || `exit ${r.status}`)})`);
  }
  const result = found ?? { cmd: null, tried };
  memo.set(key, result);
  return result;
}

// Creates <install>/.venv and installs architecture-policy/requirements.txt into it.
export function setupPythonVenv({ installRoot = INSTALL_ROOT, base = null, log = console.log } = {}) {
  const python = base ?? ['python3', 'python'].find((p) => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!python) throw new Error('no python3 or python on PATH to create the virtualenv with');
  const venv = path.join(installRoot, '.venv');
  if (!fs.existsSync(venvPython(installRoot))) {
    log(`creating ${venv} with ${python}`);
    const r = spawnSync(python, ['-m', 'venv', venv], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${python} -m venv ${venv} failed`);
  }
  const r = spawnSync(venvPython(installRoot), ['-m', 'pip', 'install', '--quiet', '-r', path.join(installRoot, 'architecture-policy', 'requirements.txt')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('pip install of architecture-policy/requirements.txt failed');
  memo.clear();
  return venvPython(installRoot);
}
