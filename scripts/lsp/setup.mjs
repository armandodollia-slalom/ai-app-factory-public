#!/usr/bin/env node
// Checks that code intelligence can run in a checkout (main checkout or git worktree): the MCP bridge is
// installed and every configured language server's command can be found (the app repo's node_modules, the
// engine's node_modules, then PATH). It installs nothing itself: for a missing server it prints the install
// commands of the language pack that describes it (packs/<id>/lsp.json).
//
// Usage: factory lsp setup [--worktree <checkout>] [--check] [--json]
//        node <install root>/scripts/lsp/setup.mjs ...
//   --check  also start this checkout's lspd daemon and run the smoke test (check.mjs)
// Exit code 0 when the bridge and every configured server were found.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureToolPath } from '../pipeline/lib/config.mjs';
import { INSTALL_ROOT, LSP_DIR, expand, isMain, loadConfig, realWorktree, resolveBridge, resolveCommand, stateDir, worktreeOf } from './lib/common.mjs';

const OS = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform;

// Install instructions per server id, from the language packs.
export function packInstalls(root = INSTALL_ROOT) {
  const out = new Map();
  const dir = path.join(root, 'packs');
  if (!fs.existsSync(dir)) return out;
  for (const pack of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, pack, 'lsp.json');
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const optional = Object.values(data.optional ?? {}).flatMap((o) => o.config?.lsp?.servers ?? []);
      for (const server of [...(data.config?.lsp?.servers ?? []), ...optional]) {
        if (!out.has(server.id)) out.set(server.id, { pack, install: data.install?.[server.id] ?? null });
      }
    } catch {
      // a broken pack file is that pack's problem, not this checkout's
    }
  }
  return out;
}

export function inspect(worktree) {
  const config = loadConfig(worktree);
  ensureToolPath(config.project?.toolPaths);
  const vars = { worktree, factory: INSTALL_ROOT, stateDir: stateDir(worktree) };
  const bridge = resolveBridge(worktree);
  const packs = packInstalls();
  const servers = config.servers.map((s) => {
    const resolved = resolveCommand(worktree, expand(s.command, vars), []);
    const hint = packs.get(s.id);
    const commands = hint?.install?.[OS] ?? hint?.install?.all ?? null;
    return { id: s.id, command: s.command, found: resolved.found, source: resolved.source, leased: Boolean(s.leased), pack: hint?.pack ?? null, install: resolved.found ? null : commands };
  });
  return { ok: Boolean(bridge && fs.existsSync(bridge)) && servers.every((s) => s.found), worktree, project: config.project?.name ?? null, bridge: bridge && fs.existsSync(bridge) ? bridge : null, servers };
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  for (const a of argv) if (a.startsWith('--') && !['--worktree', '--check', '--json'].includes(a)) throw new Error(`Unknown option: ${a}`);
  const worktree = realWorktree(opt('worktree') ?? worktreeOf(process.cwd()));
  const report = inspect(worktree);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    console.log(report.bridge ? `lsp: bridge ${report.bridge}` : `lsp: lsp-mcp-server is not installed; run \`npm ci\` in ${INSTALL_ROOT}`);
    for (const s of report.servers) {
      if (s.found) console.log(`lsp: ${s.id} ready (${s.source})`);
      else {
        console.log(`lsp: ${s.id} MISSING: \`${s.command}\` is not in node_modules or on PATH`);
        for (const c of s.install ?? []) console.log(`       install (${s.pack} pack): ${c}`);
        if (!s.install) console.log(`       no pack describes "${s.id}"; install its language server and make sure \`${s.command}\` is on PATH (project.toolPaths)`);
      }
    }
    if (!report.servers.length) console.log('lsp: no language servers configured (lsp.servers in .factory/config.json)');
  }
  if (argv.includes('--check')) {
    const run = (script, args) => spawnSync(process.execPath, [path.join(LSP_DIR, script), ...args], { cwd: worktree, stdio: 'inherit', windowsHide: true }).status;
    run('lspd.mjs', ['start', '--worktree', worktree]);
    return run('check.mjs', ['--root', worktree]) === 0 && report.ok ? 0 : 1;
  }
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`lsp: ${error.message}\n`);
    process.exit(2);
  }
}
