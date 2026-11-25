#!/usr/bin/env node
// lizard (MIT) on the changed files, reporting the functions the change adds or edits that are over the complexity or
// length limit (GEN-17). Prints the lines format; exit 1 with findings. lizard is a Python tool: `lizard` on PATH, or
// FACTORY_LIZARD naming it; without it this says it is not installed and exits 3 (the tool is reported missing).
//
//   node {packs}/security/analysis/complexity.mjs --max-cyclomatic <n> --max-lines <n> [--base <merge-base>] [--json] <file>...
import { spawnSync } from 'node:child_process';
import { breachesInChange, parseLizardCsv, toolArgs, toolOutput } from '../../../scripts/pipeline/lib/analysis/clean-code-tools.mjs';

const root = process.cwd();
const { flags, json, files, changed } = toolArgs(process.argv.slice(2), ['max-cyclomatic', 'max-lines'], root);
if (!files.length) process.exit(0);
const r = spawnSync(process.env.FACTORY_LIZARD || 'lizard', ['--csv', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (r.error?.code === 'ENOENT') {
  process.stderr.write('factory: lizard is not installed (pip install lizard)\n');
  process.exit(3);
}
// Any other failure to run, or a run that did not succeed, is the tool's failure: never "no findings".
if (r.error || r.status !== 0) {
  process.stderr.write(`factory: lizard failed (${r.error ? r.error.message : `exit ${r.status ?? r.signal}`}): ${String(r.stderr ?? '').slice(-500)}\n`);
  process.exit(2);
}
const findings = breachesInChange(parseLizardCsv(r.stdout), changed(), { maxCyclomatic: Number(flags['max-cyclomatic']), maxFunctionLines: Number(flags['max-lines']) });
process.stdout.write(toolOutput(findings, json));
// An exit code, not process.exit: a piped stdout over 8 KB is flushed before the process ends.
process.exitCode = findings.length ? 1 : 0;
