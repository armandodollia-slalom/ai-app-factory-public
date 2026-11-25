#!/usr/bin/env node
// The clean-code measurements of the generator itself (GEN-19), for its baseline and closing reports: run over the whole
// of `scripts/`, `agents/`, `skills/`, `packs/`, `templates/` and `bin/` (test code and fixtures aside), not a change.
//   clones        jscpd's clones in code, and in the agent and skill instructions;
//   complexity    lizard's functions over `analysis.complexity.maxCyclomatic` or `analysis.complexity.maxFunctionLines`;
//   repeats       fallbacks that repeat a settings default and literals that repeat a named constant (GEN-6, GEN-18);
//   dead code     exports nothing else names, and modules nothing imports or runs.
// Each item has a stable key (no line numbers in it) so a triage can name it and a closing report can compare. jscpd and
// lizard run through the analysis gate's own tool scripts (lizard: FACTORY_LIZARD or PATH); the patterns and limits are
// this checkout's, whichever tree is measured.
//
//   node scripts/docs/clean-code-report.mjs [--json <file>] [--at <commit>]   the items of this checkout, or of a commit
//   node scripts/docs/clean-code-report.mjs --functions <file> --at <base>     functions of the files changed since base
//   node scripts/docs/clean-code-report.mjs --markdown                         docs/clean-code/README.md
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_ROOT, defaultSettings } from '../pipeline/lib/settings.mjs';
import { writeText } from '../pipeline/lib/redact.mjs';
import { fileConstants, findRepeats, sourceDefaults } from '../pipeline/lib/analysis/repeats.mjs';
import { isGenericTestPath } from '../pipeline/lib/analysis/fixloop.mjs';
import { isMain, sha } from '../pipeline/lib/util.mjs';

const ROOT = INSTALL_ROOT;
const DIRS = ['scripts', 'agents', 'skills', 'packs', 'templates', 'bin'];
// Test code (fixloop.mjs's generic test paths), fixtures and dependencies are not the product measured.
const notProduct = (f) => isGenericTestPath(f) || /(^|\/)(fixtures|node_modules)\//.test(f);
const CODE = /\.(mjs|cjs|js|ts)$/;
const git = (cwd, args, input) => spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });

// A tree to measure: its root, its tracked files in the measured folders and a reader.
function treeAt(root) {
  return { root, files: git(root, ['ls-files', ...DIRS]).stdout.split('\n').filter(Boolean), read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}

// `fn` on the tree of `commit` (this checkout's HEAD when null), extracted to a temporary folder and removed after.
function onTree(commit, fn) {
  if (!commit) return fn(treeAt(ROOT));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tree-'));
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', commit, ...DIRS], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024, timeout: 300_000 });
    if (archive.status !== 0) throw new Error(`git archive ${commit}: ${archive.stderr}`);
    const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, timeout: 300_000 });
    if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
    return fn(treeAt(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The area of a file, as the report groups it.
export function areaOf(file) {
  const [top, dir, ...rest] = file.split('/');
  if (top !== 'scripts') return top;
  const name = rest.join('/');
  if (dir === 'pipeline') {
    if (/(^|\/)(settings|config|renamed)/.test(name)) return 'settings';
    if (/(^|\/)(council|selection|scorecard|findings|intercom|finding-route)/.test(name)) return 'council';
    if (/(^|\/)analysis\//.test(name)) return 'analysis';
    return 'pipeline';
  }
  return { 'pr-check': 'PR check', docs: 'docs build' }[dir] ?? dir;
}

// The analysis gate's own clean-code tools (packs/security/analysis), run over whole files with `--json`.
const TOOLS = path.join(ROOT, 'packs/security/analysis');
function gateTool(tree, script, args) {
  const r = spawnSync(process.execPath, [path.join(TOOLS, script), '--json', ...args], { cwd: tree.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`${script} failed (exit ${r.status ?? r.signal}): ${String(r.stderr).slice(-500)}`);
  return JSON.parse(r.stdout);
}

// A clone occurrence's identity across measurements, whatever its lines moved to: a hash of its two copies' code (each
// line trimmed). Two clones with the same file pair and length are told apart by it.
function cloneDigest(tree, a, b) {
  const text = (c) => tree.read(c.file).split('\n').slice(c.start - 1, c.end).map((l) => l.trim()).join('\n');
  return sha(`${text(a)}\n~\n${text(b)}`, 12);
}

// jscpd's clones between two files of one set: code, or the agent and skill instructions.
function clones(tree, code, instructions, minTokens) {
  const sets = [['clone', new Set(code)], ['instruction-clone', new Set(instructions)]];
  return gateTool(tree, 'duplication.mjs', ['--min-tokens', String(minTokens), ...code, ...instructions]).flatMap((d) => {
    const [a, b] = [...d.copies].sort((x, y) => x.file.localeCompare(y.file) || x.start - y.start);
    const kind = sets.find(([, set]) => set.has(a.file) && set.has(b.file))?.[0];
    return kind ? [{ kind, key: `${kind} ${a.file} ~ ${b.file} (${d.lines} lines)`, area: areaOf(a.file), files: [a.file, b.file], where: `${a.file}:${a.start}-${a.end} and ${b.file}:${b.start}-${b.end}`, lines: d.lines, tokens: d.tokens, digest: cloneDigest(tree, a, b) }] : [];
  });
}

// Every function lizard finds in `files` (the gate's complexity tool with both limits at 0 reports each), once each.
function functionsOf(tree, files) {
  const all = gateTool(tree, 'complexity.mjs', ['--max-cyclomatic', '0', '--max-lines', '0', ...files]);
  return [...new Map(all.map((f) => [`${f.file}:${f.start}`, f])).values()].map(({ file, name, start, end, ccn, length }) => ({ file, name, start, end, ccn, length }));
}
const overLimit = (f, { maxCyclomatic, maxFunctionLines }) => f.ccn > maxCyclomatic || f.length > maxFunctionLines;

// lizard's functions over either limit.
const complexity = (functions, limits) =>
  functions.filter((f) => overLimit(f, limits)).map((f) => ({ kind: 'complexity', key: `complexity ${f.file} ${f.name}`, area: areaOf(f.file), files: [f.file], where: `${f.file}:${f.start}-${f.end}`, ccn: f.ccn, length: f.length }));

// A repeat's key text: its message up to the source file, without the line (a qualified key's own `:` stays).
const repeatSubject = (message) => message.replace(/(, which \S+?):\d+[\s\S]*$/, '$1');

// GEN-6 and GEN-18 on the generator: fallbacks equal to a default of the settings files, and literals equal to a named
// constant of another module, by the TypeScript pack's patterns.
function repeats(tree, code) {
  const patterns = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs/typescript/repeats.json'), 'utf8'));
  const sources = fs.readdirSync(path.join(tree.root, 'scripts')).map((d) => `scripts/${d}/config.json`).filter((f) => fs.existsSync(path.join(tree.root, f)));
  const defaults = sources.flatMap((f) => sourceDefaults(f, tree.read(f), patterns));
  const constants = code.flatMap((f) => fileConstants(f, tree.read(f), patterns));
  return code.flatMap((f) => findRepeats(f, tree.read(f), patterns, { defaults, constants }).map((x) => ({ kind: 'repeat', key: `repeat ${f} ${x.rule} ${repeatSubject(x.message)}`, area: areaOf(f), files: [f], where: `${f}:${x.line}`, message: x.message })));
}

// Exports no other file names, and modules no other file imports, names or runs (a CLI with a shebang, a stage's CLI in
// stages.json, a pack command in a JSON file all name theirs).
function deadCode(tree, code, everything) {
  const texts = new Map(everything.map((f) => [f, tree.read(f)]));
  const items = [];
  for (const f of code) {
    const text = texts.get(f);
    for (const m of text.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
      const usedHere = (text.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) ?? []).length > 1;
      if (usedHere) continue;
      if ([...texts].some(([g, t]) => g !== f && word.test(t))) continue;
      items.push({ kind: 'dead-export', key: `dead-export ${f} ${name}`, area: areaOf(f), files: [f], where: f, name });
    }
    const base = path.basename(f);
    const stem = base.replace(/\.[cm]?[jt]s$/, '');
    if (/^#!/.test(text) || notProduct(f)) continue;
    const named = [...texts].some(([g, t]) => g !== f && (t.includes(base) || new RegExp(`['"\`/]${stem}(\\.m?js)?['"\`]`).test(t)));
    if (!named) items.push({ kind: 'dead-file', key: `dead-file ${f}`, area: areaOf(f), files: [f], where: f });
  }
  return items;
}

// The items of a tree, and its functions (for the function table).
function measureTree(tree) {
  const everything = tree.files.filter((f) => /\.(mjs|cjs|js|ts|json|md|sh|yml|yaml|toml)$/.test(f));
  const code = tree.files.filter((f) => CODE.test(f) && !notProduct(f));
  const instructions = tree.files.filter((f) => /^(agents|skills)\/.*\.md$/.test(f));
  const limits = defaultSettings().analysis;
  const functions = functionsOf(tree, code);
  const items = [
    ...clones(tree, code, instructions, limits.duplication.minTokens),
    ...complexity(functions, limits.complexity),
    ...repeats(tree, code),
    ...deadCode(tree, code, everything),
  ].sort((a, b) => a.area.localeCompare(b.area) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  return { items, functions };
}

// The items of this checkout, or of `commit`'s tree.
export const measure = (commit = null) => onTree(commit, (tree) => measureTree(tree).items);

// ---- functions the branch changed ------------------------------------------------------------------------------------

// The functions of `files` at the base and at the head, matched by file, name and, for an anonymous function, its first
// line (`line`; the n-th of each to the n-th), kept when either side is over a limit:
// { file, name, base: {ccn, length} | null, head }.
export function functionRows(baseFns, headFns, files, limits) {
  const ordinal = (fns) => {
    const seen = new Map();
    return fns.filter((f) => files.has(f.file)).sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start).map((f) => {
      const k = `${f.file}\u0000${f.name}\u0000${f.name === '(anonymous)' ? f.line ?? '' : ''}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      return [`${k}\u0000${seen.get(k)}`, f];
    });
  };
  const base = new Map(ordinal(baseFns));
  const metrics = (f) => (f ? { ccn: f.ccn, length: f.length } : null);
  return ordinal(headFns)
    .filter(([k, f]) => overLimit(f, limits) || (base.has(k) && overLimit(base.get(k), limits)))
    .map(([k, f]) => ({ file: f.file, name: f.name === '(anonymous)' && f.line ? `(anonymous) \`${f.line.slice(0, 60)}\`` : f.name, base: metrics(base.get(k)), head: metrics(f) }));
}

// The rule for the functions a branch changed (council r1, cc-6): none may end over a limit it was under at the base (a
// new function was under every limit), and none over a limit may be worse than at the base on that measure.
export function functionProblems(rows, { maxCyclomatic, maxFunctionLines }) {
  const limits = [['ccn', maxCyclomatic, 'cyclomatic complexity'], ['length', maxFunctionLines, 'lines']];
  return rows.flatMap((r) => limits.flatMap(([m, limit, label]) => {
    if (r.head[m] <= limit) return [];
    const was = r.base?.[m] ?? 0;
    if (was <= limit) return [`${r.file} ${r.name}: ${label} ${r.head[m]}, over ${limit}, was ${r.base ? was : 'not there'} at the base`];
    return r.head[m] > was ? [`${r.file} ${r.name}: ${label} ${r.head[m]}, worse than ${was} at the base`] : [];
  }));
}

// The function table of the files changed since `base`: the base's functions and this checkout's.
export function functionTable(base) {
  if (!base) throw new Error("--functions needs --at <base>");
  // Every file of the measured folders the branch changed (the closing check reads it), and the code among them.
  const all = git(ROOT, ['diff', '--name-only', base, 'HEAD', '--', ...DIRS]).stdout.split('\n').filter(Boolean).sort();
  const changed = new Set(all.filter((f) => CODE.test(f) && !notProduct(f)));
  const limits = defaultSettings().analysis.complexity;
  const files = [...changed];
  const of = (tree) => functionsOf(tree, files.filter((f) => fs.existsSync(path.join(tree.root, f)))).map((f) => ({ ...f, line: tree.read(f.file).split('\n')[f.start - 1]?.trim() }));
  return { base, limits, changed: all, rows: functionRows(onTree(base, of), of(treeAt(ROOT)), changed, limits) };
}

// ---- the report -----------------------------------------------------------------------------------------------------

const DOCS = path.join(ROOT, 'docs/clean-code');
const readDoc = (name) => (fs.existsSync(path.join(DOCS, name)) ? JSON.parse(fs.readFileSync(path.join(DOCS, name), 'utf8')) : null);
const KINDS = ['clone', 'instruction-clone', 'complexity', 'repeat', 'dead-export', 'dead-file'];
const count = (items, pred) => items.filter(pred).length;

// The literal a repeat's key names, after its rule's own words: `repeated-constant '<literal>' repeats the constant ...`
// or `repeated-default the fallback '<literal>' repeats the default ...` (council r3, F14: not a fixed word position).
const repeatLiteral = (key) => /^repeat \S+ (?:repeated-constant|repeated-default the fallback) (\S+)/.exec(key)?.[1] ?? '';
// A repeat of a string literal, a constant's or a fallback's.
const stringRepeat = (item) => item.kind === 'repeat' && /^['"`]/.test(repeatLiteral(item.key));

// An item's decision: its own triage entry, else its kind's. A string literal that repeats a constant has no kind-level
// decision (council r2, F11): it is the same knowledge until its own entry says why not, so it uses the constant or is
// kept on an entry of its own. A number (a timeout, a limit) keeps its kind's reason.
export const decisionOf = (triage, item) => triage.items?.[item.key] ?? (stringRepeat(item) ? null : triage.kinds?.[item.kind]) ?? null;

// How many items of each key a measurement has.
const keyCounts = (items) => items.reduce((m, i) => m.set(i.key, (m.get(i.key) ?? 0) + 1), new Map());

// A baseline key gone from the closing measurement although the branch changed none of its files (`changed`, the files
// changed since the base): the code is as it was, so the tool stopped seeing it (a constant it can no longer read, say);
// it is not fixed (council r3, F13). A fix made in another file (the other declaration of a value written twice) names
// it in the entry's `fixedIn`, which must have changed. Unknown without `changed`.
const goneUnchanged = (key, baseline, changed, d = {}) => {
  if (!changed) return false;
  const files = [...baseline.filter((i) => i.key === key).flatMap((i) => i.files), ...[d?.fixedIn ?? []].flat()];
  return !files.some((f) => changed.has(f));
};

// What became of one key the triage said to fix: fixed, partly fixed (the copies left, and those kept on purpose), still
// there, or gone from the measurement with its files unchanged.
function fixStatus(key, base, closing, d = {}, baseline = [], changed = null) {
  const left = closing.filter((i) => i.key === key);
  if (!left.length) return goneUnchanged(key, baseline, changed, d) ? 'not measured: its files are unchanged since the base' : 'fixed';
  if (left.length >= base.get(key)) return 'still there';
  const kept = keptOf(d, left).length;
  return `partly fixed (${left.length} of ${base.get(key)} left${kept ? `, ${kept} kept: ${d.keep.reason}` : ''})`;
}

// The copies left of a key triaged fix that stay on purpose: a fix entry's `keep: { reason, digests }` names each kept
// clone by its digest (the occurrence, wherever its lines moved); an item without a digest (a long function, a repeat)
// is kept by `keep.count`. Nothing is kept without a reason.
function keptOf(d, left) {
  if (!d?.keep?.reason) return [];
  const digests = new Set(d.keep.digests ?? []);
  const byDigest = left.filter((i) => i.digest && digests.has(i.digest));
  const counted = left.filter((i) => !i.digest).slice(0, Number.isInteger(d.keep.count) ? d.keep.count : 0);
  return [...byDigest, ...counted];
}

// A closing item the baseline does not have. A clone is matched by its key (its file pair and length) and its digest,
// each baseline occurrence once: the same code in another file pair, or a second copy where the baseline had one, is
// new (council r3, sol-08). Any other item is new beyond the baseline's count of its key.
function newItems(baseline, closing) {
  const base = keyCounts(baseline);
  const occurrences = keyCounts(baseline.filter((i) => i.digest).map((i) => ({ key: `${i.key}|${i.digest}` })));
  const seen = new Map();
  return closing.filter((i) => {
    const id = i.digest ? `${i.key}|${i.digest}` : i.key;
    seen.set(id, (seen.get(id) ?? 0) + 1);
    return seen.get(id) > ((i.digest ? occurrences : base).get(id) ?? 0);
  });
}

// A new item is kept only on an entry of its own: its key's, written for it (a key the baseline does not have), or, for
// a new occurrence of a baseline key, a reason under that entry's `occurrences` by its digest.
function keptAsNew(triage, baseline, i) {
  const own = triage.items?.[i.key];
  if (own?.decision !== 'kept' || !own.reason) return false;
  return !baseline.some((b) => b.key === i.key) || Boolean(i.digest && own.occurrences?.[i.digest]);
}

// Problems with a closing report against the baseline and its triage (AC1, AC4): a baseline item without a decision or
// kept without a reason, each copy of a key triaged fix still there and not kept with a reason, a new item not kept on
// an entry of its own (a kind's reason was written for the baseline's items), and no fewer clones or functions over the
// limits.
// The problem with one baseline key at the head, if any: no decision, copies left of a fix, or a fix whose files did
// not change.
function keyProblem(key, { baseline, triage, closing, added, base, touched }) {
  const d = decisionOf(triage, baseline.find((i) => i.key === key));
  const left = closing.filter((i) => i.key === key && !added.includes(i));
  const unkept = left.length - keptOf(d, left).length;
  if (!d || (d.decision === 'kept' && !d.reason)) return `no decision with a reason: ${key}`;
  if (d.decision !== 'fix') return null;
  if (unkept > 0) return `triaged fix but ${unkept} of ${base.get(key)} left with no kept entry: ${key}`;
  return !left.length && goneUnchanged(key, baseline, touched, d) ? `triaged fix and gone from the measurement, but none of its files changed: ${key}` : null;
}

export function closingProblems(baseline, triage, closing, { changed = null } = {}) {
  const base = keyCounts(baseline);
  const added = newItems(baseline, closing);
  const at = { baseline, triage, closing, added, base, touched: changed ? new Set(changed) : null };
  const problems = [...base.keys()].map((key) => keyProblem(key, at)).filter(Boolean);
  for (const i of added) if (!keptAsNew(triage, baseline, i)) problems.push(`new and not kept on its own entry with a reason: ${i.key}${i.digest ? ` (${i.where})` : ''}`);
  for (const kind of ['clone', 'complexity']) if (count(closing, (i) => i.kind === kind) >= count(baseline, (i) => i.kind === kind)) problems.push(`no fewer ${kind} items than the baseline`);
  return problems;
}

const INTRO = [
  '# Clean-code report of the generator',
  '',
  'The clean-code measurements of the factory itself (GEN-19): `jscpd` clones in code and in the agent and skill',
  'instructions, `lizard` functions over `analysis.complexity.maxCyclomatic` or `analysis.complexity.maxFunctionLines`,',
  'literals and fallbacks that repeat a value with one source (the GEN-6 and GEN-18 checks), and dead code (exports',
  'nothing names, modules nothing imports), over `scripts/`, `agents/`, `skills/`, `packs/`, `templates/` and `bin/`',
  '(test code and fixtures aside), with the analysis gate\'s own tools. `baseline.json` measures the branch\'s base,',
  '`triage.json` holds the decision on each item, `closing.json` measures the head, and `functions.json` lists the',
  'functions of the files the branch changed that are over a limit at the base or the head. Regenerate them with',
  '`--json docs/clean-code/baseline.json --at BASE`, `--json docs/clean-code/closing.json` and',
  '`--functions docs/clean-code/functions.json --at BASE`, then render this page with `--markdown`.',
];

const totals = (baseline, closing) => ['## Totals', '', '| Kind | Baseline | Closing |', '| --- | --- | --- |', ...KINDS.map((k) => `| ${k} | ${count(baseline, (i) => i.kind === k)} | ${closing ? count(closing, (i) => i.kind === k) : '-'} |`)];

function byArea(baseline, closing) {
  const areas = [...new Set([...baseline, ...(closing ?? [])].map((i) => i.area))].sort();
  const cell = (a, k) => `${count(baseline, (i) => i.area === a && i.kind === k)}${closing ? ` / ${count(closing, (i) => i.area === a && i.kind === k)}` : ''}`;
  return ['## By area', '', `| Area | ${KINDS.join(' | ')} |`, `| --- | ${KINDS.map(() => '---').join(' | ')} |`, ...areas.map((a) => `| ${a} | ${KINDS.map((k) => cell(a, k)).join(' | ')} |`), '', closing ? 'Each cell is baseline / closing.' : 'Each cell is the baseline count.'];
}

function fixedRows(baseline, triage, closing, changed = null) {
  const base = keyCounts(baseline);
  const touched = changed ? new Set(changed) : null;
  const rows = [...base.keys()].map((key) => [key, decisionOf(triage, baseline.find((i) => i.key === key))]).filter(([, d]) => d?.decision === 'fix');
  return ['## Triage: fixed', '', '| Item | Batch | How | Status |', '| --- | --- | --- | --- |', ...rows.map(([key, d]) => `| \`${key}\` | ${d.batch} | ${d.how ?? 'removed'} | ${closing ? fixStatus(key, base, closing, d, baseline, touched) : 'to do'} |`)];
}

function keptGroups(baseline, triage, closing) {
  const kept = new Map();
  // The baseline's items, and the items new at the head (each kept on its own entry).
  const added = newItems(baseline, closing ?? []);
  // An `occurrences` reason is a new occurrence's own: the baseline copy with the same digest keeps its key's reason
  // (council r4, sol-08).
  const occurrence = (i) => i.digest && triage.items?.[i.key]?.occurrences?.[i.digest];
  const reasoned = [...baseline.map((i) => [i, decisionOf(triage, i)]), ...added.map((i) => [i, occurrence(i) ? { decision: 'kept', reason: occurrence(i) } : decisionOf(triage, i)])];
  for (const [i, d] of reasoned) if (d?.decision === 'kept') kept.set(d.reason, [...(kept.get(d.reason) ?? []), i]);
  const item = (i) => `- \`${i.where}\` (${i.kind}${i.ccn ? `, CCN ${i.ccn}, ${i.length} lines` : ''})`;
  return ['## Triage: kept', '', ...[...kept].flatMap(([reason, items]) => [`- **${items.length} item(s)**: ${reason}.`, '', '<details>', '', ...items.map(item), '', '</details>', ''])];
}

// The functions the branch changed, base and head (cc-6).
function functionSection(functions) {
  const cell = (m) => (m ? `${m.ccn} / ${m.length}` : 'new');
  const problems = new Set(functionProblems(functions.rows, functions.limits).map((p) => p.split(':')[0]));
  return [
    '## Functions the branch changed',
    '',
    `The functions of the files changed since \`${functions.base}\` that are over a limit (cyclomatic complexity ${functions.limits.maxCyclomatic}, ${functions.limits.maxFunctionLines} lines) at the base or the head. None may end over a limit it was under at the base, and none over a limit may be worse than at the base.`,
    '',
    '| Function | Base (CCN / lines) | Head (CCN / lines) | Rule |',
    '| --- | --- | --- | --- |',
    ...functions.rows.map((r) => `| \`${r.file}\` ${r.name} | ${cell(r.base)} | ${cell(r.head)} | ${problems.has(`${r.file} ${r.name}`) ? 'broken' : 'held'} |`),
  ];
}

function closingCheck(baseline, triage, closing, functions) {
  const problems = [...closingProblems(baseline, triage, closing, { changed: functions?.changed }), ...(functions ? functionProblems(functions.rows, functions.limits) : [])];
  return ['## Closing check', '', problems.length ? problems.map((p) => `- ${p}`).join('\n') : 'Every baseline item is fixed or kept with a reason, no new item is unlisted, there are fewer clones and fewer functions over the limits, and no function the branch changed went over a limit or got worse.'];
}

export function markdown(baseline, triage, closing = null, functions = null) {
  const lines = [...INTRO, '', ...totals(baseline, closing), '', ...byArea(baseline, closing), '', ...fixedRows(baseline, triage, closing, functions?.changed), '', ...keptGroups(baseline, triage, closing), ...(triage.notes?.length ? ['', '## Notes', '', ...triage.notes.map((n) => `- ${n}`)] : []), ...(functions ? ['', ...functionSection(functions)] : []), ...(closing ? ['', ...closingCheck(baseline, triage, closing, functions)] : [])];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

if (isMain(import.meta.url)) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  const out = (file, value) => (file ? writeText(file, `${JSON.stringify(value, null, 1)}\n`) : process.stdout.write(`${JSON.stringify(value, null, 1)}\n`));
  if (process.argv.includes('--markdown')) writeText(path.join(DOCS, 'README.md'), markdown(readDoc('baseline.json'), readDoc('triage.json'), readDoc('closing.json'), readDoc('functions.json')));
  else if (process.argv.includes('--functions')) out(arg('--functions'), functionTable(arg('--at')));
  else out(arg('--json'), measure(arg('--at')));
}
