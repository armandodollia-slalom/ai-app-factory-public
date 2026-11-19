#!/usr/bin/env node
// A client's own scanner service in server mode, over the custom adapter protocol (docs/providers/custom.md): the
// scanner contract's two operations, `checkName` and `result`. This one reads a JSON file the client's scan job writes
// (one result per head SHA); replace `load` with a call to your scanner's API.
//
// .factory/config.json:
//   "analysis": {
//     "tools": { "acme-scan": { "licence": "LicenseRef-Acme-Scan", "lens": "security",
//       "severity": { "critical": "blocking", "high": "blocking", "medium": "major", "low": "minor", "info": "minor" },
//       "commercial": { "vendor": "Acme", "modes": ["server"], "tokenEnv": "ACME_SCAN_TOKEN",
//         "server": { "adapter": "custom", "command": ["node", "scripts/acme-scan.mjs"], "env": { "ACME_SCAN_TOKEN": "${ACME_SCAN_TOKEN}", "ACME_SCAN_RESULTS": "${ACME_SCAN_RESULTS}" } } } } },
//     "commercial": { "scanner": "acme-scan", "mode": "server", "token": "${ACME_SCAN_TOKEN}", "check": "acme/scan" },
//     "acceptLicence": [{ "tool": "acme-scan", "licence": "LicenseRef-Acme-Scan", "by": "<a named person>" }]
//   }
import fs from 'node:fs';

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.ACME_SCAN_RESULTS ?? '.acme-scan.json', 'utf8'));
  } catch {
    return {};
  }
};
const OPS = {
  describe: () => ({ operations: ['checkName', 'result'], capabilities: { serverSide: true, prAnalysis: true, triageStates: true, sarif: false, shaBound: true } }),
  checkName: () => 'acme/scan',
  // { head, pr } -> { status pending|complete|failed, gate, url, findings: [{ rule, severity, path, line, message, cwe, fingerprint, triage }] }
  result: ({ head }) => {
    const r = load()[head];
    if (!r) return { status: 'pending', findings: [] };
    return { status: r.failed ? 'failed' : 'complete', gate: r.gate ?? null, url: r.url ?? null, commit: head, findings: r.findings ?? [] };
  },
};

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (!process.env.ACME_SCAN_TOKEN) return process.stdout.write(`${JSON.stringify({ ok: false, error: 'ACME_SCAN_TOKEN is not set', code: 'auth' })}\n`);
  const op = OPS[req.op];
  if (!op) process.exit(3);
  process.stdout.write(`${JSON.stringify({ ok: true, result: op(...(req.args ?? [])) })}\n`);
});
