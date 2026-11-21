// Runs a slot's analysis tools on what a change touches and writes one report for the head commit.
// Tools run one at a time per process and at most `analysis.maxConcurrent` at once on the machine (a semaphore under
// the git common dir, beside the agent slots), each with its own timeout. Outputs go under the factory state
// directory; merge-base results are cached per merge-base commit and tool settings, so a story pays for them once.
import { writeText } from '../redact.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_ROOT } from '../config.mjs';
import { git } from '../git.mjs';
import { changedLines, lintable } from '../lint.mjs';
import { runAsync, tail } from '../util.mjs';
import { redact, rememberSecret } from '../redact.mjs';
import { findingLine, matchedSecret } from './secrets.mjs';
import { acquire } from '../../../implement/lib/semaphore.mjs';
import { PRECHECK_TOOL, resolveAnalysis } from './config.mjs';
import { dedupe, expandSecretEnv, severityOf, triageOf } from './commercial.mjs';
import { classify, identify, stripRulePrefix, toolGitEnv, toolSandbox } from './baseline.mjs';
import { parserFor, parseLines } from './parsers.mjs';
import { addedSuppressions } from './suppressions.mjs';
import { isSecretTool } from './secrets.mjs';
import { changedMap, decide, settleSecretFindings } from './decide.mjs';
import { ruleSetDir } from './fetch.mjs';
import { matchesAny } from '../../../implement/lib/plan.mjs';

// Whether a tool applies: `when` (globs one tracked file must match: a GitHub workflow linter only where workflows
// exist) and, outside CI, `onChange` (globs a touched file must match: a dependency audit only when a manifest changed).
export function applies(tool, { cwd, touched, slot }) {
  if (tool.when?.length) {
    const tracked = git(cwd, ['ls-files']).stdout.split('\n').filter(Boolean);
    if (!tracked.some((f) => matchesAny(f, tool.when))) return `nothing matches ${tool.when.join(', ')}`;
  }
  if (tool.onChange?.length && slot !== 'ci' && !touched.some((f) => matchesAny(f, tool.onChange))) return `no change to ${tool.onChange.join(', ')}`;
  return null;
}

export const REPORT_VERSION = 1;

// The factory state folder of the main checkout (shared by its worktrees): reports, merge-base caches, pinned tools.
export const analysisDir = (config) => path.join(config.mainRoot ?? config.root, config.stateDir ?? '.factory/state', 'analysis');

// One cache per machine for pinned tool binaries, rule sources and tool data (an offline vulnerability database):
// FACTORY_CACHE_DIR, else the platform's user cache folder. `factory prune` removes what no configuration pins.
export function machineCache(env = process.env) {
  if (env.FACTORY_CACHE_DIR) return env.FACTORY_CACHE_DIR;
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ai-app-factory', 'cache');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ai-app-factory');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ai-app-factory');
}
export const toolsDir = () => path.join(machineCache(), 'tools');
export const toolDataDir = (tool) => path.join(machineCache(), 'data', tool.id);
// The prepared data's timestamp as a cache-key suffix ('' for a tool without prepared data).
export function preparedStamp(tool) {
  if (!tool?.prepare) return '';
  try {
    return `-${fs.readFileSync(path.join(toolDataDir(tool), '.prepared'), 'utf8').trim().replace(/[^0-9A-Za-z]/g, '')}`;
  } catch {
    return '-unprepared';
  }
}
// Age in days of a tool's prepared data (an offline database), or null when it was never prepared.
export function preparedAgeDays(tool, now = Date.now()) {
  try {
    const t = Date.parse(fs.readFileSync(path.join(toolDataDir(tool), '.prepared'), 'utf8').trim());
    return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
  } catch {
    return null;
  }
}
// The folders a tool's rule sources load from: a pinned git source's validated set in the per-machine cache, a folder
// of the repository, or the factory's own rules (packs/security/rules/<builtin>/<folder>). { dirs, missing }.
export const BUILTIN_RULES = (installRoot = INSTALL_ROOT) => path.join(installRoot, 'packs', 'security', 'rules');
export function ruleDirs(config, tool, { cacheDir = machineCache(), installRoot = INSTALL_ROOT } = {}) {
  const dirs = [];
  const missing = [];
  for (const src of tool.rules ?? []) {
    if (src.builtin) {
      for (const inc of src.include.length ? src.include : ['.']) {
        const d = path.join(BUILTIN_RULES(installRoot), src.builtin, inc);
        (fs.existsSync(d) ? dirs : missing).push(d);
      }
    } else if (src.dir) {
      const d = path.resolve(config.root, src.dir);
      (fs.existsSync(d) ? dirs : missing).push(d);
    } else {
      const m = path.join(ruleSetDir(cacheDir, src), 'ruleset.json');
      try {
        dirs.push(JSON.parse(fs.readFileSync(m, 'utf8')).dir);
      } catch {
        missing.push(`${src.id} (${src.repo}@${String(src.commit).slice(0, 12)})`);
      }
    }
  }
  return { dirs, missing };
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

// The installed executable of a pinned tool, or null when the tool is not pinned.
export function pinnedBin(config, tool, plat = platformKey()) {
  const d = tool.install?.platforms?.[plat];
  if (!d) return null;
  return path.join(toolsDir(), `${tool.install.name ?? tool.id}-${tool.install.version}-${plat}`, d.bin);
}

// A hash of the settings that decide a tool's findings (a report or a cache from other settings is not reused).
export const toolHash = (tool) => createHash('sha256').update(JSON.stringify({ ...tool, description: null })).digest('hex').slice(0, 12);

const semaphoreDir = (root) => {
  const r = git(root, ['rev-parse', '--git-common-dir']);
  const common = r.status === 0 ? path.resolve(root, r.stdout.trim()) : path.join(root, '.git');
  return path.join(common, 'pipeline-analysis-slots');
};

// Placeholders in a command: {files} (one argument per file), {out} (the tool's output file), {base}, {mergeBase},
// {range} (<mergeBase>..HEAD), {root}, {packs}, {factoryBin}, {bin} (a pinned tool's executable), {rules} (its rule
// source), {cache} (its per-machine data folder).
export function expand(cmd, vars) {
  const one = (a) =>
    a
      .replace(/\{files\}/g, (vars.files ?? []).join(' '))
      .replace(/\{rules\}/g, () => (vars.ruleDirs ?? []).map((d) => (vars.rulesArg ? `${vars.rulesArg} "${d}"` : `"${d}"`)).join(' '))
      .replace(/\{(out|base|mergeBase|range|root|bin|cache)\}/g, (_, k) => vars[k] ?? '')
      .replace(/\{([a-z][A-Za-z0-9]*)\}/g, (m, k) => (vars.extra && Object.hasOwn(vars.extra, k) ? vars.extra[k] : m))
      .replace(/\{packs\}/g, path.join(INSTALL_ROOT, 'packs'))
      .replace(/\{factoryBin\}/g, path.join(INSTALL_ROOT, 'node_modules', '.bin'));
  const rulesArgs = (vars.ruleDirs ?? []).flatMap((d) => (vars.rulesArg ? [vars.rulesArg, d] : [d]));
  if (Array.isArray(cmd)) return cmd.flatMap((a) => (a === '{files}' ? vars.files ?? [] : a === '{rules}' ? rulesArgs : [one(a)]));
  return one(cmd);
}

// A command as [executable, args]: an argv array as it is, a command line through the platform's shell.
const argvOf = (cmd) => (Array.isArray(cmd) ? [cmd[0], cmd.slice(1)] : process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['sh', ['-c', cmd]]);

// A tool's own files: its extensions, minus its `exclude` globs (eslint-security leaves test code alone: a test client is
// not the server's input; council C10, Sol 4).
const matchesExt = (tool, f) => (!tool.extensions || tool.extensions.some((e) => f.endsWith(e))) && !(tool.exclude?.length && matchesAny(f, tool.exclude));

// Runs one tool. Returns { id, status: ok | findings | missing | error | timeout | skipped, wallMs, findings (raw,
// identified), output (tail), error }.
export async function runTool(config, tool, { cwd, files = [], base = null, mergeBase = null, outDir, exec = runAsync, signal = null, extraVars = {} }) {
  const t0 = Date.now();
  const done = (o) => ({ id: tool.id, wallMs: Date.now() - t0, findings: [], output: '', error: null, ...o });
  if (tool.builtin === PRECHECK_TOOL) return runPrecheck(config, tool, { cwd, files, exec, signal, t0 });
  const mine = tool.scope === 'repo' ? files : files.filter((f) => matchesExt(tool, f));
  if (tool.scope !== 'repo' && !mine.length) return done({ status: 'skipped', error: 'no changed file for this tool' });
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${tool.id}.out`);
  fs.rmSync(out, { force: true });
  const bin = pinnedBin(config, tool);
  if (tool.install && (!bin || !fs.existsSync(bin))) return done({ status: 'missing', error: `${tool.id} ${tool.install.version} is not installed for ${platformKey()} (factory analysis install ${tool.id})` });
  const { dirs, missing } = ruleDirs(config, tool);
  if (tool.needsRules && !tool.rules.length) return done({ status: 'skipped', error: `${tool.id}: no rule source configured (analysis.tools.${tool.id}.rules); the factory bundles no third-party rules` });
  if (missing.length) return done({ status: 'missing', error: `${tool.id}: rule source(s) not on this machine: ${missing.join(', ')} (factory analysis install ${tool.id})` });
  if (tool.freshness && preparedAgeDays(tool) === null) return done({ status: 'missing', error: `${tool.id}: its ${tool.freshness.what ?? 'data'} is not prepared on this machine (factory analysis install ${tool.id})` });
  const vars = { files: mine, out, base, mergeBase, range: mergeBase ? `${mergeBase}..HEAD` : base ? `${base}..HEAD` : 'HEAD', root: cwd, bin, ruleDirs: dirs, rulesArg: tool.rulesArg, cache: toolDataDir(tool), extra: extraVars };
  const unresolved = JSON.stringify(expand(tool.run, vars)).match(/\{[a-z][A-Za-z0-9]*\}/);
  if (unresolved) return done({ status: 'skipped', error: `${tool.id}: ${unresolved[0]} is not set (analysis.vars.${unresolved[0].slice(1, -1)})` });
  const [cmd, args] = argvOf(expand(tool.run, vars));
  // `${NAME}` references (a commercial scanner's token) are read from the environment here and nowhere else; a scanner
  // whose token is not set does not run (it could only fail, or worse, scan anonymously).
  const secrets = expandSecretEnv(Object.fromEntries(Object.entries(tool.env ?? {}).map(([k, v]) => [k, expand(String(v), vars)])));
  if (secrets.missing.length) return done({ status: 'missing', error: `${tool.id}: ${secrets.missing.join(', ')} ${secrets.missing.length > 1 ? 'are' : 'is'} not set (the scanner's credentials; set ${secrets.missing.length > 1 ? 'them' : 'it'} in the environment)` });
  // The repository's hooks never run in a worktree the tool makes for itself; one it leaves behind is removed.
  const box = toolSandbox({ ...process.env, ...secrets.env });
  let r;
  try {
    r = await exec(cmd, args, { cwd, timeoutSec: tool.timeoutSec, signal, env: box.env });
  } finally {
    box.cleanup(cwd);
  }
  if (tool.submitOnly) {
    if (r.timedOut) return done({ status: 'timeout', error: `${tool.id} timed out after ${tool.timeoutSec} s` });
    return r.status === 0 ? done({ status: 'ok', note: 'uploaded; the result is read from the server' }) : done({ status: 'error', error: `${tool.id}: the upload failed (exit ${r.status})`, output: tail(`${r.stdout}${r.stderr}`, 2000) });
  }
  if (r.timedOut) return done({ status: 'timeout', error: `${tool.id} timed out after ${tool.timeoutSec} s`, output: tail(`${r.stdout}${r.stderr}`, 2000) });
  if (r.status === 127 || /ENOENT|command not found|is not recognized/.test(r.stderr ?? '') && r.status !== 0 && !String(r.stdout).trim()) return done({ status: 'missing', error: `${cmd} could not be started (not installed or not on PATH)` });
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (tool.missingPattern && new RegExp(tool.missingPattern).test(all)) return done({ status: 'missing', error: `${tool.id}: not installed in this repository (${tail(all.match(new RegExp(`.*(${tool.missingPattern}).*`))?.[0] ?? '', 200)})` });
  if (tool.errorPattern && new RegExp(tool.errorPattern).test(all)) return done({ status: 'error', error: `${tool.id}: ${tail(all.match(new RegExp(`.*(${tool.errorPattern}).*`))?.[0] ?? 'reported an error', 300)}`, output: tail(all, 2000) });
  const text = tool.output === 'stdout' ? r.stdout : tool.output === 'stderr' ? r.stderr : fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  let raw;
  try {
    raw = (await parserFor(tool.parse)).parse(text, { root: cwd });
  } catch (error) {
    return done({ status: 'error', error: `${tool.id}: its output could not be read (${tool.parse}): ${error.message}`, output: tail(`${r.stdout}${r.stderr}`, 2000) });
  }
  if (!raw.length && r.status !== 0 && !(tool.okExit ?? [0, 1]).includes(r.status)) return done({ status: 'error', error: `${tool.id} failed (exit ${r.status}) and reported nothing`, output: tail(`${r.stdout}${r.stderr}`, 2000) });
  // A tool that reports more than this tool entry is for (a build's every analyzer) keeps the rules it names.
  if (dirs.length) raw = raw.map((f) => ({ ...f, rule: stripRulePrefix(f.rule, dirs, cwd) }));
  // A secret scanner's findings keep rule, file, line and fingerprint, never the matched text: the snippet is dropped and
  // the message passes the redaction boundary; the value on the line is remembered (as a hash) so it is redacted wherever
  // it turns up later in the run (redact.mjs).
  if (isSecretTool(tool)) {
    for (const f of raw) {
      const v = matchedSecret(findingLine(cwd, { ...f, file: f.file }), { column: f.column ?? null, endColumn: f.endColumn ?? null });
      if (v) rememberSecret(v, f.rule);
    }
    raw = raw.map((f) => ({ ...f, snippet: null, message: redact(String(f.message ?? '')), redacted: true }));
  }
  if (tool.ruleFilter?.length) raw = raw.filter((f) => tool.ruleFilter.some((r) => (r.endsWith('*') ? String(f.rule).startsWith(r.slice(0, -1)) : r === f.rule)));
  return done({ status: raw.length ? 'findings' : 'ok', findings: identify(cwd, tool.id, raw) });
}

// precheck: each configured linter on the changed files of its extension, read like `factory lint` reads them. A linter
// that fails without a readable diagnostic is one finding (CI's lint fails the same way).
async function runPrecheck(config, tool, { cwd, files, exec, signal, t0 }) {
  const raw = [];
  const errors = [];
  let ran = false;
  for (const [ext, template] of Object.entries(tool.lint ?? {})) {
    const matching = lintable(config, files).filter((f) => f.endsWith(ext) && fs.existsSync(path.join(cwd, f)));
    if (!matching.length || !template?.length) continue;
    const head = expand([template[0]], {})[0];
    if (head.includes('/') && !path.isAbsolute(head) && !fs.existsSync(path.resolve(cwd, head))) {
      errors.push(`${template[0]} is not installed (${ext}: ${matching.length} file(s) not linted)`);
      continue;
    }
    ran = true;
    const argv = expand(template, { files: matching, root: cwd });
    const r = await exec(argv[0], argv.slice(1), { cwd, timeoutSec: tool.timeoutSec, signal });
    if (r.status === 0) continue;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 127) {
      errors.push(`${argv[0]} was not found on PATH (${ext})`);
      continue;
    }
    const found = parseLines(output);
    if (found.length) raw.push(...found.map((f) => ({ ...f, rule: f.rule === 'lint' ? path.basename(argv[0]) : f.rule })));
    else raw.push({ rule: 'lint-failed', level: 'error', file: matching[0], line: null, message: `\`${argv.join(' ').slice(0, 200)}\` failed on ${matching.join(', ')}: ${tail(output, 1500)}`, snippet: null, key: `failed:${ext}` });
  }
  const status = raw.length ? 'findings' : errors.length && !ran ? 'missing' : ran ? 'ok' : 'skipped';
  return { id: tool.id, status, wallMs: Date.now() - t0, findings: identify(cwd, tool.id, raw), output: '', error: errors.join('; ') || null };
}

// Each tool's auto-fix on the changed files (precheck: precheck.fix by extension). Exit codes do not matter: what the
// fixers changed is what the harness commits. Returns the ids of the tools that ran.
export async function autoFix(config, ids, { cwd, files, exec = runAsync, signal = null, resolved = resolveAnalysis(config) }) {
  const ran = [];
  for (const id of ids) {
    const tool = resolved.tools.get(id);
    if (!tool) continue;
    if (tool.builtin === PRECHECK_TOOL) {
      for (const [ext, template] of Object.entries(tool.fixers ?? {})) {
        const matching = lintable(config, files).filter((f) => f.endsWith(ext) && fs.existsSync(path.join(cwd, f)));
        if (!matching.length || !template?.length) continue;
        const argv = expand(template, { files: matching, root: cwd });
        await exec(argv[0], argv.slice(1), { cwd, timeoutSec: tool.timeoutSec, signal });
        ran.push(`${id}${ext}`);
      }
      continue;
    }
    if (!tool.fix) continue;
    const mine = tool.scope === 'repo' ? files : files.filter((f) => matchesExt(tool, f) && fs.existsSync(path.join(cwd, f)));
    if (tool.scope !== 'repo' && !mine.length) continue;
    const [cmd, args] = argvOf(expand(tool.fix, { files: mine, root: cwd, bin: pinnedBin(config, tool) }));
    await exec(cmd, args, { cwd, timeoutSec: tool.timeoutSec, signal, env: toolGitEnv({ ...process.env, ...tool.env }) });
    ran.push(id);
  }
  return ran;
}

// Files a change touches against `base` (added, changed, renamed; the working tree, untracked files included).
export function touchedFiles(cwd, base) {
  const tracked = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', base]).stdout.split('\n').filter(Boolean);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith('.factory/'));
}

// The pipeline's own records (metrics shards, run state): never in a scan's scope, so never what makes a tree "dirty".
export const recordPrefixes = (config) => [config?.metricsDir ?? '.factory/metrics', config?.stateDir ?? '.factory/state'].map((p) => `${String(p).replace(/\/+$/, '')}/`);

// Uncommitted files a scan's scope holds: modified tracked files and untracked ones, everything but the pipeline's own
// records (test plans and scenarios under .factory/ included: they ship with the change, and a secret copied into a plan
// is a secret).
export function uncommittedInScope(config, cwd) {
  const tracked = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']).stdout.split('\n').filter(Boolean);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter(Boolean);
  const records = recordPrefixes(config);
  return [...new Set([...tracked, ...untracked])].filter((f) => !records.some((r) => f.startsWith(r)));
}

const spot = (f) => `${f.rule}|${f.file}|${f.line}`;

export function mergeBaseOf(cwd, base) {
  const r = git(cwd, ['merge-base', 'HEAD', base]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// The merge-base's findings of a tool (same settings, same files where they exist there), cached per commit.
// A checkout's folder with whatever a tool or hook left read-only in it made writable first.
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    try {
      fs.chmodSync(d, 0o755);
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
    } catch {
      /* best effort */
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function baseFindings(config, tool, { cwd, mergeBase, files, exec = runAsync, signal = null, extraVars = {} }) {
  // Keyed by the tool's prepared data too (an offline advisory database refreshed since): a base judged with yesterday's
  // database would make an advisory published today look introduced here while CI, which scans both with today's, calls
  // it pre-existing.
  const cacheFile = path.join(analysisDir(config), 'base', mergeBase, `${tool.id}-${toolHash(tool)}${preparedStamp(tool)}.json`);
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* not cached yet */
  }
  // Outside the repository's tree (as the CI script does): a checkout under the main checkout's git-ignored
  // .factory/state is ignored by tools that honour .gitignore (OSV-Scanner then saw no lockfile at the merge-base, and
  // every advisory already on main came back as introduced). The repository's hooks do not run for it (a post-checkout
  // hook built a read-only knowledge graph in it, which also kept the checkout from being deleted).
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-analysis-base-'));
  fs.rmSync(wt, { recursive: true, force: true });
  const add = git(cwd, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', wt, mergeBase]);
  if (add.status !== 0) return null;
  try {
    const there = files.filter((f) => fs.existsSync(path.join(wt, f)));
    const r = await runTool(config, tool, { cwd: wt, files: there, base: mergeBase, mergeBase, outDir: path.join(wt, '.factory-analysis-out'), exec, signal, extraVars });
    if (!['ok', 'findings', 'skipped'].includes(r.status)) return null;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeText(cacheFile, JSON.stringify(r.findings));
    return r.findings;
  } finally {
    git(cwd, ['worktree', 'remove', '--force', wt]);
    removeTree(wt);
    git(cwd, ['worktree', 'prune']);
  }
}

// Runs a slot's tools on the change from `base` to the working tree of `cwd` and returns the report (not written).
//   { version, slot, sha, base, mergeBase, configHash, tools: [{ id, status, wallMs, error, introduced, preexisting }],
//     findings (introduced, each with severity and lens), preexisting, suppressions }
export async function runSlot(config, slot, { cwd = config.root, base, ids = null, files = null, exec = runAsync, signal = null, resolved = resolveAnalysis(config), deadline = Infinity } = {}) {
  const requested = ids ?? resolved.stages[slot] ?? [];
  const wanted = requested.map((id) => resolved.tools.get(id)).filter(Boolean);
  // A tool its licence keeps from running is said in the report, never passed over in silence.
  const licenceBlocked = requested.filter((id) => resolved.blocked?.[id]).map((id) => ({ id, status: 'licence', wallMs: 0, error: `${id} not run: ${resolved.blocked[id]}`, introduced: 0, preexisting: 0 }));
  // Everything is measured from the merge-base, as the CI script does (decide.mjs): a base that moved on since the
  // branch started does not make its own new lines this change's.
  const mergeBase = mergeBaseOf(cwd, base) ?? base;
  const touched = files ?? touchedFiles(cwd, mergeBase);
  // What is not committed yet in the scan's scope: a tool that reads commits does not see it unless its worktreeRun reads
  // it; the report then describes this working tree, not the HEAD commit (report.tree).
  const uncommitted = uncommittedInScope(config, cwd);
  const all = changedMap(cwd, mergeBase, { worktree: true });
  const changed = files ? new Map([...new Set([...touched, ...uncommitted])].map((f) => [f, all.has(f) ? all.get(f) : changedLines(cwd, f, { base: mergeBase })])) : all;
  const sha = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  const unseen = [];
  const outDir = path.join(analysisDir(config), 'out', `${path.basename(cwd)}-${process.pid}`);
  const report = { version: REPORT_VERSION, slot, sha, base, mergeBase, configHash: slotHash(resolved, slot), ts: new Date().toISOString(), tools: [...licenceBlocked], findings: [], preexisting: [], triaged: [], suppressions: addedSuppressions(cwd, base, resolved.suppressions) };
  try {
    for (const tool of wanted) {
      const release = (await acquire(semaphoreDir(cwd), resolved.maxConcurrent, { deadline, label: `analysis:${tool.id}` })) ?? (() => {});
      let r;
      let base0 = [];
      let worktreeOnly = [];
      try {
        const why = applies(tool, { cwd, touched, slot });
        r = why ? { id: tool.id, status: 'skipped', wallMs: 0, findings: [], error: null, note: why } : await runTool(config, tool, { cwd, files: touched, base, mergeBase, outDir, exec, signal, extraVars: resolved.vars });
        // A tool that reads commits (Betterleaks on the commit range) does not see what is not committed yet: its
        // worktreeRun reads those files, and what it finds on their changed lines counts as introduced.
        const dirty = tool.worktreeRun && ['ok', 'findings'].includes(r.status) ? (tool.scope === 'repo' ? uncommitted : uncommitted.filter((f) => touched.includes(f))) : [];
        // A commit-reading tool that did not run, or whose read of the uncommitted files failed, did not see them.
        if (tool.worktreeRun && uncommitted.length && !['ok', 'findings'].includes(r.status) && r.status !== 'skipped') unseen.push({ tool: tool.id, files: uncommitted.slice(0, 50), why: r.error ?? r.status });
        if (dirty.length) {
          const w = await runTool(config, { ...tool, run: tool.worktreeRun, scope: 'changed-files' }, { cwd, files: dirty, base, mergeBase, outDir, exec, signal, extraVars: resolved.vars });
          r.wallMs += w.wallMs;
          if (['ok', 'findings'].includes(w.status)) {
            const seen = new Set(r.findings.map(spot));
            worktreeOnly = classify(w.findings, { scope: 'changed-files', baseline: 'lines', changed, base: [] }).introduced.filter((f) => !seen.has(spot(f)));
            if (worktreeOnly.length) r.status = 'findings';
            r.note = [r.note, `also read ${dirty.length} uncommitted file(s)`].filter(Boolean).join('; ');
          } else {
            r.error = [r.error, `the uncommitted files could not be read: ${w.error ?? w.status}`].filter(Boolean).join('; ');
            unseen.push({ tool: tool.id, files: dirty.slice(0, 50), why: w.error ?? w.status });
          }
        }
        if (r.status === 'findings' && tool.baseline === 'merge-base') {
          const b = await baseFindings(config, tool, { cwd, mergeBase, files: touched, exec, signal, extraVars: resolved.vars });
          if (b === null) r.error = `${tool.id}: the merge-base could not be analysed; every finding counts as introduced`;
          base0 = b ?? [];
        }
      } finally {
        release();
      }
      // The shared decision (decide.mjs, the same code the CI script runs): introduced or already on the base, and for
      // a secret tool, whether the matched value itself is on the base (then a note naming where, not a block).
      const judged = decide({ scope: tool.scope, baseline: tool.baseline, secretValues: isSecretTool(tool) }, r.findings, { cwd, changed, base: base0, mergeBase });
      const settledDirty = isSecretTool(tool) && worktreeOnly.length ? settleSecretFindings(cwd, worktreeOnly, { mergeBase }) : { introduced: worktreeOnly, preexisting: [] };
      const introduced = [...judged.introduced, ...settledDirty.introduced];
      const preexisting = [...judged.preexisting, ...settledDirty.preexisting];
      const decorate = (f) => ({ ...f, severity: severityOf(tool, f), lens: tool.lens });
      // A finding a person triaged in the vendor's own system (accepted, false positive) is reported, never blocking;
      // only a commercial scanner's triage counts (an open-source tool's report has no such decision).
      const triaged = tool.commercial ? introduced.filter((f) => triageOf(f)) : [];
      report.triaged.push(...triaged.map((f) => ({ ...decorate(f), triage: triageOf(f), justification: f.triage?.justification ?? null })));
      report.findings.push(...introduced.filter((f) => !triaged.includes(f)).map(decorate));
      report.preexisting.push(...preexisting.map(decorate));
      report.tools.push({ id: tool.id, status: r.status, wallMs: r.wallMs, error: r.error, note: r.note, output: r.status === 'error' ? r.output : undefined, introduced: introduced.length, preexisting: preexisting.length });
    }
    // The same weakness at the same place from two tools (a commercial scanner beside the open-source ones) is one finding.
    report.findings = dedupe(report.findings);
    // Clean: the scan saw exactly the HEAD commit's tree and may stand for it. Dirty: it read a working tree with
    // uncommitted files (named), so it is never stored or counted as that commit's scan; `unseen` names what a tool missed.
    report.tree = { state: uncommitted.length ? 'dirty' : 'clean', uncommitted: uncommitted.slice(0, 50), count: uncommitted.length, unseen };
    // Coverage of the added production lines (evidence for the test-value lens) where a coverage command is declared:
    // story level and the PR check only (it runs the tests).
    if (resolved.coverage?.run && ['story', 'prCheck'].includes(slot)) {
      const { coverageFor } = await import('./coverage.mjs');
      report.coverage = await coverageFor(config, resolved.coverage, { cwd, base, outDir, exec, signal });
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  return report;
}

// The settings a report depends on: each tool of the slot, the placeholder values ({solution}) and the engine that ran
// them (a report from before a parser or runner fix is not reused by a fixed engine).
const ENGINE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
export const slotHash = (resolved, slot) => createHash('sha256').update(JSON.stringify({ engine: ENGINE_VERSION, vars: resolved.vars ?? {}, tools: (resolved.stages[slot] ?? []).map((id) => [id, resolved.tools.get(id) ? toolHash(resolved.tools.get(id)) : 'blocked']) })).digest('hex').slice(0, 12);
