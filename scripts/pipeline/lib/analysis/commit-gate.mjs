// The harness's commit gate: before the harness commits a worktree's files, its secret scanner (a security tool with a
// worktreeRun, such as Betterleaks `dir`) reads the staged files. A new secret on a line the commit adds is held: its
// file is unstaged and left in the worktree, so the value never reaches a commit, and the next scan of the story hands
// the finding back to the implementer. A value the base already holds is a note (secrets.mjs), never held. The scanner
// runs in a child process so callers keep a synchronous commit; nothing of the value is printed or recorded.
//
//   gateStaged(cwd) -> { held: [{ tool, rule, file, line, id }], notes: [...], error }
//   heldSecrets(config, cwd) -> the held findings whose files are still uncommitted (the delivery refuses to push them)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from '../git.mjs';
import { changedLines } from '../lint.mjs';
import { metricsFile } from '../state.mjs';
import { appendJsonl, nowIso } from '../util.mjs';
import { classify } from './baseline.mjs';
import { recordPrefixes, uncommittedInScope } from './runner.mjs';
import { isSecretTool } from './secrets.mjs';
import { settleSecretFindings } from './decide.mjs';

const SELF = fileURLToPath(import.meta.url);
export const HELD_FILE = 'analysis-held.json';
export const HELD_METRICS = 'analysis-held.jsonl';

const heldPath = (cwd, stateDir = '.factory/state') => path.join(cwd, stateDir, HELD_FILE);
const short = (f) => ({ tool: f.tool, rule: f.rule, file: f.file, line: f.line ?? null, id: f.id });

function overlayHasAnalysis(cwd) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(cwd, '.factory', 'config.json'), 'utf8'));
    return o && typeof o.analysis === 'object' && o.analysis !== null && o.analysis.enabled !== false;
  } catch {
    return false;
  }
}

async function loadFor(cwd) {
  const { loadConfig } = await import('../config.mjs');
  const { resolveAnalysis } = await import('./config.mjs');
  const config = loadConfig(null, cwd);
  const resolved = resolveAnalysis(config);
  const used = new Set(Object.values(resolved?.stages ?? {}).flat());
  const tools = resolved ? [...resolved.tools.values()].filter((t) => used.has(t.id) && isSecretTool(t)) : [];
  return { config, resolved, tools };
}

// The staged files the gate reads: everything but the pipeline's own records.
function stagedFiles(cwd, stateDir, metricsDir) {
  const records = recordPrefixes({ stateDir, metricsDir });
  return git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).stdout.split('\n').filter(Boolean).filter((f) => !records.some((r) => f.startsWith(r)));
}

// The child's work: the secret tools' worktreeRun on the staged files; findings on lines this commit adds, minus values
// the base already holds.
export async function scanStaged(cwd, { files, runTool = null, mergeBase = null, loaded = null } = {}) {
  const { config, resolved, tools } = loaded ?? (await loadFor(cwd));
  if (!tools.length || !files.length) return { held: [], notes: [], error: null };
  const run = runTool ?? (await import('./runner.mjs')).runTool;
  const base = mergeBase ?? (config.baseRef ? git(cwd, ['merge-base', 'HEAD', config.baseRef]).stdout.trim() || null : null);
  const changed = new Map(files.map((f) => [f, changedLines(cwd, f, { staged: true })]));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-commit-gate-'));
  const held = [];
  const notes = [];
  const errors = [];
  try {
    for (const tool of tools) {
      const r = await run(config, { ...tool, run: tool.worktreeRun, scope: 'changed-files' }, { cwd, files, base, mergeBase: base, outDir, extraVars: resolved?.vars ?? {} });
      if (!['ok', 'findings'].includes(r.status)) {
        if (r.status !== 'skipped') errors.push(`${tool.id}: ${r.error ?? r.status}`);
        continue;
      }
      const { introduced } = classify(r.findings, { scope: 'changed-files', baseline: 'lines', changed, base: [] });
      const settled = settleSecretFindings(cwd, introduced, { mergeBase: base });
      held.push(...settled.introduced.map(short));
      notes.push(...settled.preexisting.map((f) => ({ ...short(f), alreadyOnBase: f.alreadyOnBase })));
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  return { held, notes, error: errors.join('; ') || null };
}

// Runs the gate on what is staged in `cwd`; unstages the files holding a new secret. Never throws: a gate that cannot
// run says so in `error` and lets the commit through (the story's scans still read the change).
export function gateStaged(cwd, { message = '', spawn = spawnSync, stateDir = '.factory/state', metricsDir = '.factory/metrics', log = null } = {}) {
  const none = { held: [], notes: [], error: null };
  if (process.env.FACTORY_COMMIT_GATE === '0' || !overlayHasAnalysis(cwd)) return none;
  const files = stagedFiles(cwd, stateDir, metricsDir);
  if (!files.length) return none;
  const r = spawn(process.execPath, [SELF, 'gate', cwd], { input: JSON.stringify({ files }), encoding: 'utf8', timeout: 600_000, env: { ...process.env, PIPELINE_DISABLE: '1' } });
  let out;
  try {
    out = JSON.parse(String(r.stdout ?? '').trim().split('\n').at(-1) || 'null');
  } catch {
    out = null;
  }
  if (!out) return { ...none, error: `the commit gate did not run (exit ${r.status ?? r.signal ?? 'unknown'})` };
  const result = { held: out.held ?? [], notes: out.notes ?? [], error: out.error ?? null };
  const heldFiles = [...new Set(result.held.map((f) => f.file).filter(Boolean))];
  if (heldFiles.length) git(cwd, ['reset', '-q', '--', ...heldFiles]);
  // The held findings of this worktree: replaced for every file the gate read now, kept for files it did not read.
  const file = heldPath(cwd, stateDir);
  let before = [];
  try {
    before = JSON.parse(fs.readFileSync(file, 'utf8')).held ?? [];
  } catch {
    /* none yet */
  }
  const next = [...before.filter((h) => !files.includes(h.file)), ...result.held.map((h) => ({ ...h, at: nowIso(), commit: message.split('\n')[0].slice(0, 160) }))];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ held: next }, null, 1)}\n`);
    if (result.held.length || result.notes.length) {
      appendJsonl(metricsFile({ root: cwd, metricsDir, stateDir }, HELD_METRICS), [{ ts: nowIso(), commit: message.split('\n')[0].slice(0, 160), files: files.length, held: result.held, notes: result.notes, error: result.error }]);
    }
  } catch {
    /* records are best effort */
  }
  if (result.held.length) log?.(`commit gate: held ${heldFiles.length} file(s) out of the commit: a new secret on a line it adds (${result.held.map((f) => `${f.file}:${f.line} ${f.rule}`).join('; ')}); the value stays only in the worktree`);
  return result;
}

// Held findings whose files are still not committed (the value is still only in the worktree, or the file still differs).
export function heldSecrets(config, cwd) {
  let held;
  try {
    held = JSON.parse(fs.readFileSync(heldPath(cwd, config?.stateDir ?? '.factory/state'), 'utf8')).held ?? [];
  } catch {
    return [];
  }
  if (!held.length) return [];
  const open = new Set(uncommittedInScope(config, cwd));
  return held.filter((h) => open.has(h.file));
}

async function main() {
  const [cmd, cwd] = process.argv.slice(2);
  if (cmd !== 'gate' || !cwd) {
    process.stdout.write(`${JSON.stringify({ error: 'usage: commit-gate.mjs gate <cwd> < {"files": [...]}' })}\n`);
    process.exit(2);
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let out;
  try {
    const { files = [] } = JSON.parse(input || '{}');
    out = await scanStaged(cwd, { files });
  } catch (error) {
    out = { held: [], notes: [], error: `commit gate: ${error.message}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
