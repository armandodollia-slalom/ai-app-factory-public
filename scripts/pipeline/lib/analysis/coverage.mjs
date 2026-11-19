// Coverage of the lines a change added to production code, by the tests, as evidence for the test-value lens: never a
// gate. Off unless a pack or the repository declares `analysis.coverage` ({ run, format: lcov | cobertura, output }),
// a command that runs the tests with coverage and writes the report to {out}.
import fs from 'node:fs';
import path from 'node:path';
import { changedLines } from '../lint.mjs';
import { runAsync } from '../util.mjs';
import { relFile } from './baseline.mjs';
import { expand } from './runner.mjs';
import { touchedFiles } from './runner.mjs';

// { file -> Map(line -> hits) } from an lcov report (SF:, DA:<line>,<hits>).
export function parseLcov(text, root) {
  const out = new Map();
  let file = null;
  for (const l of String(text).split('\n')) {
    if (l.startsWith('SF:')) {
      file = relFile(root, l.slice(3).trim());
      if (file && !out.has(file)) out.set(file, new Map());
    } else if (l.startsWith('DA:') && file) {
      const [n, hits] = l.slice(3).split(',');
      out.get(file).set(Number(n), Number(hits));
    } else if (l.startsWith('end_of_record')) file = null;
  }
  return out;
}

// The same from a Cobertura report (<class filename="..."> ... <line number="n" hits="h"/>), sources resolved.
export function parseCobertura(text, root) {
  const out = new Map();
  const sources = [...String(text).matchAll(/<source>([^<]+)<\/source>/g)].map((m) => m[1].trim());
  for (const cls of String(text).matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    const candidates = [cls[1], ...sources.map((s) => path.join(s, cls[1]))];
    const file = candidates.map((c) => relFile(root, c)).find((f) => f && fs.existsSync(path.join(root, f))) ?? relFile(root, cls[1]);
    if (!file) continue;
    const lines = out.get(file) ?? new Map();
    for (const l of cls[2].matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) lines.set(Number(l[1]), Math.max(lines.get(Number(l[1])) ?? 0, Number(l[2])));
    out.set(file, lines);
  }
  return out;
}

// Changed production lines the report knows (instrumented), covered or not. Files matching testGlobs are not production.
export function changedLineCoverage(cov, changed, { isTest = (f) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.|Tests?\.cs$/i.test(f) } = {}) {
  const rows = [];
  for (const [file, lines] of changed) {
    if (isTest(file)) continue;
    const c = cov.get(file);
    if (!c) continue;
    const wanted = lines === null ? [...c.keys()] : [...lines].filter((n) => c.has(n));
    if (!wanted.length) continue;
    const uncovered = wanted.filter((n) => !(c.get(n) > 0));
    rows.push({ file, lines: wanted.length, covered: wanted.length - uncovered.length, uncovered });
  }
  const total = rows.reduce((n, r) => n + r.lines, 0);
  const covered = rows.reduce((n, r) => n + r.covered, 0);
  return { rows, total, covered, pct: total ? Math.round((covered / total) * 100) : null };
}

export function coverageText(c) {
  if (!c || c.total === null || !c.rows.length) return '';
  return [
    `Coverage of the production lines this change added (evidence for the test-value lens, not a gate): ${c.covered}/${c.total} (${c.pct}%).`,
    ...c.rows.filter((r) => r.uncovered.length).slice(0, 15).map((r) => `- ${r.file}: not run by any test: lines ${r.uncovered.slice(0, 20).join(', ')}${r.uncovered.length > 20 ? ', ...' : ''}`),
  ].join('\n');
}

// Runs the declared coverage command and returns { ...changedLineCoverage, text } or null.
export async function coverageFor(config, coverage, { cwd, base, outDir, exec = runAsync, signal = null }) {
  if (!coverage?.run) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `coverage.${coverage.format === 'cobertura' ? 'xml' : 'info'}`);
  const target = expand(coverage.output ?? '{out}', { out });
  const cmd = expand(coverage.run, { out, root: cwd });
  const [c, a] = Array.isArray(cmd) ? [cmd[0], cmd.slice(1)] : process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['sh', ['-c', cmd]];
  await exec(c, a, { cwd, timeoutSec: coverage.timeoutSec ?? 1800, signal });
  if (!fs.existsSync(target)) return null;
  const text = fs.readFileSync(target, 'utf8');
  const cov = coverage.format === 'cobertura' ? parseCobertura(text, cwd) : parseLcov(text, cwd);
  const changed = new Map(touchedFiles(cwd, base).map((f) => [f, changedLines(cwd, f, { base })]));
  const result = changedLineCoverage(cov, changed);
  return { ...result, text: coverageText(result) };
}
