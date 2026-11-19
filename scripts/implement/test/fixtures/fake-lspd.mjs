#!/usr/bin/env node
// Stand-in for scripts/lsp/lspd.mjs in tests. Logs every call to $FAKE_LSPD_LOG; diagnostics come from
// $FAKE_LSPD_DIAG (JSON {"files": {...}}); $FAKE_LSPD_LEASED sets the state of the one leased server it reports.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LSPD_LOG) fs.appendFileSync(process.env.FAKE_LSPD_LOG, `${JSON.stringify(args)}\n`);

if (args[0] === 'start') {
  const status = process.env.FAKE_LSPD_LEASED ?? 'running';
  const reason = status === 'running' ? null : 'all 1 leased language server slots are in use (/other)';
  console.log(JSON.stringify({ ok: true, pid: 4242, socket: '/tmp/x.sock', leased: status, reason: reason && `heavy: ${reason}`, servers: { heavy: { status, state: status === 'running' ? 'ready' : null, reason } } }));
} else if (args[0] === 'diagnostics') {
  console.log(JSON.stringify({ ok: true, ...(process.env.FAKE_LSPD_DIAG ? JSON.parse(process.env.FAKE_LSPD_DIAG) : { files: {} }) }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
