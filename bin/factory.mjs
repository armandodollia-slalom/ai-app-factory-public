#!/usr/bin/env node
// The factory's one entry point: `factory <command> ...`. It routes to the stage and tool CLIs under
// scripts/, so an app repository (which holds no engine code) needs to know only this name.
// Anything that is not a tool below goes to the pipeline dispatcher (start, done, implement, hook, ...).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TOOLS = {
  board: 'scripts/board/board.mjs',
  fv: 'scripts/feature-verification/feature-verification.mjs',
  'feature-verification': 'scripts/feature-verification/feature-verification.mjs',
  review: 'scripts/review/review.mjs',
  council: 'scripts/council/council.mjs',
  'pr-check': 'scripts/pr-check/pr-check.mjs',
  'review-gate': 'scripts/review-gate/review-gate.mjs',
  'review-quorum': 'scripts/review-gate/quorum.mjs',
  'pr-video': 'scripts/pr-video/pr-video.mjs',
  models: 'scripts/models/models.mjs',
  retro: 'scripts/retro/retro.mjs',
  stack: 'scripts/stack/slots.mjs',
  teststack: 'scripts/teststack/teststack.mjs',
  mockups: 'scripts/implement/mockups.mjs',
  'requeue-schedule': 'scripts/implement/requeue-schedule.mjs',
  'gemini-adapter': 'scripts/hooks/gemini-adapter.mjs',
  sink: 'scripts/factory/sink.mjs',
  'policy-library': 'scripts/factory/policy-library.mjs',
  lint: 'scripts/factory/lint.mjs',
  analysis: 'scripts/factory/analysis.mjs',
  'graphify-build': 'scripts/graphify-build.sh',
  'graphify-prune-cache': 'scripts/graphify-prune-cache.sh',
  // The architecture policy engine (Python): `factory policy review -`, `factory policy validate`, ...
  policy: 'architecture-policy/agents/arch_review.py',
  // The engine's own CLI: `factory arch selfcheck --policy-dir .factory/policy --workspace .`, `factory arch validate ...`.
  arch: 'architecture-policy/hooks/arch.py',
};
// Commands of the generator itself (scripts/factory/factory.mjs keeps the command name).
export const FACTORY_COMMANDS = ['init', 'render', 'check', 'doctor', 'upgrade', 'install-setup', 'detect', 'uninstall', 'version', 'python', 'config', 'prune', 'automations', 'adapter'];
// `factory lsp <sub> ...`
export const LSP = { mcp: 'mcp.mjs', lspd: 'lspd.mjs', hook: 'hook.mjs', check: 'check.mjs', scope: 'scope.mjs', setup: 'setup.mjs' };

export function route(argv) {
  const [command, ...rest] = argv;
  if (command === 'lsp') {
    // `factory lsp stop [--worktree <path>] | --all | --orphans`: stop language-server daemons without signals by hand.
    if (rest[0] === 'stop') {
      const flags = rest.slice(1);
      const sub = flags.includes('--all') ? ['stop-all'] : flags.includes('--orphans') ? ['orphans'] : ['stop', ...flags];
      return { script: path.join(INSTALL_ROOT, 'scripts/lsp', 'lspd.mjs'), args: sub };
    }
    const file = LSP[rest[0]];
    if (!file) return { error: `Usage: factory lsp <${[...Object.keys(LSP), 'stop'].join('|')}> ... (stop [--worktree <path>] | --all | --orphans)` };
    return { script: path.join(INSTALL_ROOT, 'scripts/lsp', file), args: rest.slice(1) };
  }
  if (TOOLS[command]) return { script: path.join(INSTALL_ROOT, TOOLS[command]), args: rest };
  if (FACTORY_COMMANDS.includes(command)) return { script: path.join(INSTALL_ROOT, 'scripts/factory/factory.mjs'), args: argv };
  return { script: path.join(INSTALL_ROOT, 'scripts/pipeline/pipeline.mjs'), args: argv };
}

async function main() {
  // install-setup runs in a fresh clone, before the engine's packages exist: straight to its dependency-free
  // script (the factory CLI imports packages).
  if (process.argv[2] === 'install-setup') {
    const r = spawnSync(process.execPath, [path.join(INSTALL_ROOT, 'scripts', 'factory', 'install-setup.mjs'), process.cwd()], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const target = route(process.argv.slice(2));
  if (target.error) {
    console.error(target.error);
    process.exit(64);
  }
  if (!fs.existsSync(target.script)) {
    console.error(`factory: ${path.relative(INSTALL_ROOT, target.script)} is not part of this install (${INSTALL_ROOT}).`);
    process.exit(64);
  }
  process.env.FACTORY_HOME = INSTALL_ROOT;
  if (target.script.endsWith('.sh')) {
    // The scripts are bash (process substitution, arrays): `sh` is dash or bash in POSIX mode and fails on them.
    const r = spawnSync('bash', [target.script, ...target.args], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (target.script.endsWith('.py')) {
    // The same interpreter doctor and the review use (scripts/pipeline/lib/python.mjs).
    const { policyPython } = await import(pathToFileURL(path.join(INSTALL_ROOT, 'scripts/pipeline/lib/python.mjs')).href);
    const python = policyPython();
    if (!python.cmd) {
      console.error(`factory: no Python with pyyaml and jsonschema (tried ${python.tried.join('; ')}). Run \`factory python setup\` or set FACTORY_PYTHON.`);
      process.exit(127);
    }
    const r = spawnSync(python.cmd, [target.script, ...target.args], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  // Run the CLI in this process: no second Node start on every hook.
  process.argv = [process.argv[0], target.script, ...target.args];
  await import(pathToFileURL(target.script).href);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
