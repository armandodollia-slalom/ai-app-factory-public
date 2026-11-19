#!/usr/bin/env node
// Runs one leased language server for lspd and records whether it is alive in $LSPD_STATE_FILE
// ({"state":"running"} then {"state":"exited"}), so the daemon can give the machine-wide lease back when the
// server stops. The server talks LSP on this process's own stdin and stdout; nothing is proxied.
// A server that reports its own load state (`reportsState` in the config, e.g. through a pack's proxy) is
// started without this launcher.
//
// Usage (written by lspd into the bridge's config): node launch.mjs <command> [args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const stateFile = process.env.LSPD_STATE_FILE;
const since = new Date().toISOString();

function setState(state, extra = {}) {
  if (!stateFile) return;
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ state, pid: process.pid, since, at: new Date().toISOString(), ...extra }));
    fs.renameSync(tmp, stateFile);
  } catch {
    // the state dir is gone (checkout removed): the daemon is going away too
  }
}

if (!command) {
  process.stderr.write('usage: launch.mjs <command> [args...]\n');
  process.exit(2);
}
const server = spawn(command, args, { stdio: 'inherit', windowsHide: true });
server.on('spawn', () => setState('running'));
server.on('error', (error) => {
  process.stderr.write(`lsp: cannot start ${command}: ${error.message}\n`);
  setState('exited', { error: error.message });
  process.exit(127);
});
server.on('exit', (code, signal) => {
  setState('exited', { code, signal });
  process.exit(code ?? 1);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.kill(sig));
