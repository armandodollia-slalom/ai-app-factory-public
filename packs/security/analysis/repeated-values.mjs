#!/usr/bin/env node
// The repeated-values check (GEN-18) for one language pack, on the changed files: a fallback that repeats a configured
// default, a literal that repeats a named constant of another file. Prints the lines format; exit 1 with findings.
//
//   node {packs}/security/analysis/repeated-values.mjs <pack> <file>...   (run from the repository root)
//
// Configuration sources: `project.configSources` in .factory/config.json (recorded at onboarding). Constants: every
// tracked file of the pack's extensions outside test code.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoSettings } from '../../../scripts/pipeline/lib/config.mjs';
import { packsDir, setting } from '../../../scripts/pipeline/lib/settings.mjs';
import { fileConstants, findRepeats, sourceDefaults } from '../../../scripts/pipeline/lib/analysis/repeats.mjs';
import { asLines } from '../../../scripts/pipeline/lib/analysis/clean-code-tools.mjs';
import { matchesAny } from '../../../scripts/implement/lib/plan.mjs';
import { isGenericTestPath } from '../../../scripts/pipeline/lib/analysis/fixloop.mjs';

const [pack, ...changed] = process.argv.slice(2);
const patternsFile = path.join(packsDir(), pack ?? '', 'repeats.json');
if (!pack || !fs.existsSync(patternsFile)) {
  process.stderr.write(`repeated-values: no patterns for pack "${pack}" (${patternsFile})\n`);
  process.exit(2);
}
const patterns = JSON.parse(fs.readFileSync(patternsFile, 'utf8'));
const root = process.cwd();
const read = (f) => {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null;
  }
};
const listed = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean);
const files = [...new Set([...listed, ...changed])];
const sources = setting(repoSettings(root), 'project.configSources') ?? [];
const defaults = files.filter((f) => matchesAny(f, sources)).flatMap((f) => sourceDefaults(f, read(f) ?? '', patterns));
const code = files.filter((f) => patterns.extensions.some((e) => f.endsWith(e)) && !isGenericTestPath(f));
const constants = code.slice(0, 20000).flatMap((f) => fileConstants(f, read(f) ?? '', patterns));
const findings = changed.filter((f) => patterns.extensions.some((e) => f.endsWith(e))).flatMap((f) => {
  const text = read(f);
  return text == null ? [] : findRepeats(f, text, patterns, { defaults, constants });
});
if (findings.length) process.stdout.write(`${asLines(findings)}\n`);
process.exitCode = findings.length ? 1 : 0;
