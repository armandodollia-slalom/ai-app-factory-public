#!/usr/bin/env node
// Completes a machine install of the engine this file belongs to. It imports nothing but Node's own modules,
// because `factory upgrade <v> --install` runs it in a fresh clone, before the engine's packages exist:
//   node <engine>/scripts/factory/install-setup.mjs <app repository root>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A machine install runs the pipeline: all of the engine's packages (the language servers and their MCP bridge
// are dev dependencies; CI's setup-factory action omits them, as its jobs run no agent), the engine's own
// Chromium (the PR check reads videos with it when ffmpeg is missing), the policy engine's Python, and a check
// that code intelligence can run for `root`. Returns 0 when the packages installed.
// What a machine install does not keep (dogfood C4): the engine's own tests (fixtures and provenance notes about
// past tickets) and everything in examples/ except each example's .factory/ folder. A pipeline agent never needs
// them, and the install guard keeps agents out of the install in any case. Only a shallow clone (what
// `upgrade --install` makes) is pruned, never a developer's checkout. Returns the paths removed (relative).
export function installedPaths(dest) {
  const out = [];
  const walk = (rel, depth) => {
    const abs = path.join(dest, rel);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const child = rel ? `${rel}/${name}` : name;
      if (PRUNED(child)) out.push(child);
      else if (depth < 6 && fs.statSync(path.join(dest, child)).isDirectory()) walk(child, depth + 1);
    }
  };
  walk('', 0);
  return out;
}
export const PRUNED = (rel) => rel === 'test' || /^(scripts|packs)\/(.+\/)?test$/.test(rel) || /^examples\/[^/]+\/(?!\.factory$)[^/]+$/.test(rel);

export function pruneInstall(dest) {
  if (!fs.existsSync(path.join(dest, '.git', 'shallow'))) return [];
  const removed = installedPaths(dest);
  for (const rel of removed) fs.rmSync(path.join(dest, rel), { recursive: true, force: true });
  return removed;
}

export function installSetup(dest = ENGINE, root = process.cwd()) {
  const shell = process.platform === 'win32';
  const pruned = pruneInstall(dest);
  if (pruned.length) console.log(`install: left out ${pruned.length} folder(s) a pipeline never runs (tests, example material)`);
  const hasLsp = fs.existsSync(path.join(dest, 'node_modules', 'lsp-mcp-server'));
  if (!hasLsp && fs.existsSync(path.join(dest, 'package-lock.json')) && spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dest, stdio: 'inherit', shell }).status !== 0) {
    console.error(`npm ci failed in ${dest}`);
    return 1;
  }
  if (fs.existsSync(path.join(dest, 'node_modules', '@playwright', 'test')) && spawnSync('npx', ['playwright', 'install', 'chromium'], { cwd: dest, stdio: 'inherit', shell }).status !== 0) console.error(`npx playwright install chromium failed in ${dest}; the PR check needs ffmpeg or this to read videos`);
  const engine = (...args) => spawnSync(process.execPath, [path.join(dest, 'bin', 'factory.mjs'), ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, FACTORY_HOME: dest } });
  if (engine('python', 'setup').status !== 0) console.error(`factory python setup failed for ${dest}; the architecture policy needs it`);
  if (engine('lsp', 'setup').status !== 0) console.error(`factory lsp setup reported a problem with ${dest}; agents fall back to graphify until it is fixed`);
  return 0;
}


const entry = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (entry) process.exit(installSetup(ENGINE, path.resolve(process.argv[2] ?? process.cwd())));
