#!/usr/bin/env node
// Shows what the configured `scope` modules answer for a set of owned globs, without starting anything:
// the part of the checkout each scoped language server would load for a story or subtask.
//
// Usage: factory lsp scope --owns <glob> [<glob>...] [--worktree <checkout>] [--server <id>]
//        node <install root>/scripts/lsp/scope.mjs ...
// Prints {"ok":true,"scopes":{"<server id>":{"ok":true,"env":{...},"description":"..."}}}; exit 1 when a
// scope module failed. `lspd start --owns ...` applies the same answers when it starts the daemon.
import { isMain, loadConfig, realWorktree, stateDir, worktreeOf } from './lib/common.mjs';
import { resolveScopes } from './lib/daemon.mjs';

function parseArgs(argv) {
  const opts = { owns: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owns') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.owns.push(argv[++i]);
    } else if (a === '--worktree') opts.worktree = argv[++i];
    else if (a === '--server') opts.server = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export async function scopes({ worktree, owns = [], server = null }) {
  const config = loadConfig(worktree);
  if (server) config.servers = config.servers.filter((s) => s.id === server);
  const notes = [];
  const found = await resolveScopes(config, { worktree, sdir: stateDir(worktree), owns, log: (...a) => notes.push(a.join(' ')) });
  return { ok: [...found.values()].every((s) => s.ok), scopes: Object.fromEntries(found), notes };
}

if (isMain(import.meta.url)) {
  let result;
  try {
    const opts = parseArgs(process.argv.slice(2));
    result = await scopes({ ...opts, worktree: realWorktree(opts.worktree ?? worktreeOf(process.cwd())) });
  } catch (error) {
    result = { ok: false, scopes: {}, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
