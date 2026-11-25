#!/usr/bin/env node
// jscpd (MIT, a dependency of the factory) on the repository, reporting only the clones a change adds: at least one
// copy on a line the change adds or edits (GEN-17). Its semantic mode stays off. Prints the lines format; exit 1 with
// findings.
//
//   node {packs}/security/analysis/duplication.mjs --min-tokens <n> [--base <merge-base>] [--json] <file>...   (from the root)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clonesInChange, toolArgs, toolOutput } from '../../../scripts/pipeline/lib/analysis/clean-code-tools.mjs';

const root = process.cwd();
const { flags, json, changed } = toolArgs(process.argv.slice(2), ['min-tokens'], root);
const jscpd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../node_modules/.bin/jscpd');
if (!fs.existsSync(jscpd)) {
  process.stderr.write('factory: jscpd is not installed with the factory (npm install in the factory install)\n');
  process.exit(3);
}
// The clones of the change, or an error; the report folder is removed whatever happened.
function scan() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-jscpd-'));
  try {
    // .gitignore'd files are skipped by jscpd itself; these are never the application's code.
    const ignore = ['**/node_modules/**', '**/.git/**', '**/.factory/**', '**/graphify-out/**'].join(',');
    const r = spawnSync(jscpd, ['--silent', '--no-tips', '-k', String(flags['min-tokens']), '-i', ignore, '-r', 'json', '-o', out, '.'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const report = path.join(out, 'jscpd-report.json');
    if (!fs.existsSync(report)) return { error: `jscpd wrote no report (exit ${r.status}): ${String(r.stderr).slice(-500)}` };
    return { findings: clonesInChange(JSON.parse(fs.readFileSync(report, 'utf8')).duplicates, changed()) };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const result = scan();
if (result.error) process.stderr.write(`factory: ${result.error}\n`);
else process.stdout.write(toolOutput(result.findings, json));
process.exitCode = result.error ? 2 : result.findings.length ? 1 : 0;
