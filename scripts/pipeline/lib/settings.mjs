// Every setting the pipeline reads, described once next to its defaults, and checked against the code.
//
// - Defaults: each section's `scripts/<dir>/config.json` (a tool's own file, `lsp`, `stack`, `teststack`, `models`,
//   holds the section itself). A default is written there once; code reads the merged settings (`defaultSettings()`
//   for a helper handed a partial config) and has no fallback literal for it.
// - Descriptions: `scripts/<dir>/settings.json` beside each defaults file: per setting, what it does, its type, its
//   allowed values (a fixed list, or a number's range and unit), and the environment variable that overrides it. The
//   loader refuses a value outside them, and an unknown or misspelt name, with the allowed values or the right name.
// - Renamed settings: `scripts/pipeline/renamed-settings.json`, the one table of old name to new name (or "removed",
//   with the reason). A settings file with an old name fails to load naming the new one.
// - The configuration reference (docs/configuration.md, between `<!-- generated:settings -->` markers) is generated
//   from the descriptions and the defaults; `node scripts/pipeline/lib/settings.mjs --write` rewrites it and
//   `--check` (and the settings test) fails when it is stale, when code reads a setting nothing describes, when a
//   described setting is read nowhere, or when a default is not one of its setting's allowed values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeText } from './redact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(here, '../..');
export const INSTALL_ROOT = path.resolve(SCRIPTS_DIR, '..');
// Defaults files that hold one section of the settings (a tool's own), not the top level.
export const SECTION_DIRS = { lsp: 'lsp', stack: 'stack', teststack: 'teststack', models: 'models' };
export const RENAMED_FILE = path.join(SCRIPTS_DIR, 'pipeline', 'renamed-settings.json');
export const REFERENCE_FILE = path.join(INSTALL_ROOT, 'docs', 'configuration.md');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v;
  return out;
}
const clone = (v) => (v === undefined ? v : structuredClone(v));

// The folders under scripts/ with a defaults file, in a stable order (pipeline first: the shared settings).
export function settingsDirs(scriptsDir = SCRIPTS_DIR) {
  const dirs = fs.readdirSync(scriptsDir).filter((d) => fs.existsSync(path.join(scriptsDir, d, 'config.json'))).sort();
  return ['pipeline', ...dirs.filter((d) => d !== 'pipeline')].filter((d) => dirs.includes(d));
}

// One defaults file's content placed at the top level (a tool's file under its section).
function placed(dir, doc) {
  const { $comment: _c, ...rest } = doc;
  return SECTION_DIRS[dir] ? { [SECTION_DIRS[dir]]: rest } : rest;
}

const cache = new Map();
// The merged defaults of every section, as the settings are before a repository's overlay. A fresh copy each call.
export function defaultSettings(scriptsDir = SCRIPTS_DIR) {
  if (!cache.has(`d:${scriptsDir}`)) {
    let out = {};
    for (const dir of settingsDirs(scriptsDir)) out = merge(out, placed(dir, readJson(path.join(scriptsDir, dir, 'config.json'))));
    cache.set(`d:${scriptsDir}`, out);
  }
  return clone(cache.get(`d:${scriptsDir}`));
}

// A setting's value in a loaded (or partial) settings object, else its default from the default settings files: for
// helpers that may be handed a partial config. `name` is the setting's full dotted name.
export function setting(config, name) {
  const get = (doc) => name.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), doc);
  return get(config) ?? get(defaultSettings());
}

// Every description, in file order: [{ name, dir, does, type, ... }]. A name may hold `<key>` segments (any key of a map).
export function descriptions(scriptsDir = SCRIPTS_DIR) {
  if (!cache.has(`s:${scriptsDir}`)) {
    const out = [];
    for (const dir of settingsDirs(scriptsDir)) {
      const file = path.join(scriptsDir, dir, 'settings.json');
      if (!fs.existsSync(file)) continue;
      const doc = readJson(file);
      for (const [name, d] of Object.entries(doc)) if (!name.startsWith('$')) out.push({ name, dir, ...d });
    }
    cache.set(`s:${scriptsDir}`, out);
  }
  return cache.get(`s:${scriptsDir}`);
}

// The fixed list of values a setting allows (its description's `values`).
export const allowedValues = (name, scriptsDir = SCRIPTS_DIR) => [...(descriptions(scriptsDir).find((d) => d.name === name)?.values ?? [])];

export function renamedSettings(file = RENAMED_FILE) {
  if (!cache.has(`r:${file}`)) {
    const doc = fs.existsSync(file) ? readJson(file) : {};
    cache.set(`r:${file}`, Object.entries(doc).filter(([k]) => !k.startsWith('$')).map(([from, to]) => ({ from, ...(typeof to === 'string' ? { to } : to) })));
  }
  return cache.get(`r:${file}`);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

// `a.b[].c` -> ['a', 'b', '[]', 'c']
export const segments = (name) => name.replace(/\[\]/g, '.[]').split('.').filter(Boolean);
const isWild = (seg) => /^<[^>]+>$/.test(seg);
const segMatch = (pattern, key) => pattern === key || (isWild(pattern) && key !== '[]');
// Whether a description name (pattern) matches a concrete path (array of keys).
export const matches = (pattern, keys) => pattern.length === keys.length && pattern.every((p, i) => segMatch(p, keys[i]));
// Whether a concrete path is a proper prefix of the pattern (an object that holds described settings).
const isPrefixOf = (keys, pattern) => keys.length < pattern.length && keys.every((k, i) => segMatch(pattern[i], k));

function indexOf(descs) {
  return descs.map((d) => ({ d, seg: segments(d.name) }));
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

const TYPE_LABEL = { boolean: 'on/off', integer: 'whole number', number: 'number', string: 'text', enum: 'choice', list: 'list', object: 'object', map: 'map', command: 'command', any: 'any' };
const unitText = (d) => (d.unit ? ` ${d.unit}` : '');
const code = (v) => `\`${typeof v === 'string' ? v : JSON.stringify(v)}\``;

// The allowed values of a setting, in words (the same words the reference shows and the loader's message lists).
export function allowedText(d) {
  const nullable = d.nullable ? ', or `null`' : '';
  switch (d.type) {
    case 'boolean':
      return `\`true\`, \`false\`${nullable}`;
    case 'enum':
      return `${d.values.map(code).join(', ')}${nullable}`;
    case 'integer':
    case 'number': {
      const kind = d.type === 'integer' ? 'whole number' : d.decimals !== undefined ? `number with at most ${d.decimals} decimal place${d.decimals === 1 ? '' : 's'}` : 'number';
      const range = d.min !== undefined && d.max !== undefined ? ` from ${d.min} to ${d.max}` : d.min !== undefined ? ` of ${d.min} or more` : d.max !== undefined ? ` up to ${d.max}` : '';
      return `${kind}${range}${unitText(d)}${nullable}`;
    }
    case 'string':
      return `${d.allowed ?? 'text'}${nullable}`;
    case 'list':
      return `${d.values ? `list of ${d.values.map(code).join(', ')}` : `list of ${d.items ?? 'text'}`}${d.allowed ? ` (${d.allowed})` : ''}${nullable}`;
    case 'map':
      return `${d.allowed ?? `names to ${d.items ?? 'values'}`}${nullable}`;
    case 'command':
      return `a command line, or a list of arguments${nullable}`;
    case 'object':
      return `${d.allowed ?? 'see the linked page'}${nullable}`;
    default:
      return d.allowed ?? 'any';
  }
}

// Whether a number has at most `places` decimal places, in any notation (1e-7 has seven).
const withinDecimals = (n, places) => Number(n.toFixed(places)) === n;
const itemOk = (item, kind) => (kind === 'object' ? isObject(item) : kind === 'number' ? Number.isFinite(item) : kind === 'command' ? typeof item === 'string' || (Array.isArray(item) && item.every((x) => typeof x === 'string')) : kind === 'any' ? true : typeof item === 'string');

// Whether a value is one the description allows.
export function valueOk(d, v) {
  if (v === null) return Boolean(d.nullable);
  switch (d.type) {
    case 'boolean':
      return typeof v === 'boolean';
    case 'enum':
      return d.values.includes(v);
    case 'integer':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (d.type === 'integer' && !Number.isInteger(v)) return false;
      if (d.decimals !== undefined && !withinDecimals(v, d.decimals)) return false;
      return (d.min === undefined || v >= d.min) && (d.max === undefined || v <= d.max);
    case 'string':
      return typeof v === 'string' && (!d.pattern || new RegExp(d.pattern).test(v));
    case 'list':
      return Array.isArray(v) && v.every((x) => (d.values ? d.values.includes(x) : itemOk(x, d.items ?? 'string')));
    case 'map':
      return isObject(v) && (!d.items || Object.values(v).every((x) => x === null || itemOk(x, d.items)));
    case 'object':
      return isObject(v);
    case 'command':
      return itemOk(v, 'command');
    default:
      return true;
  }
}

const LEAF_TYPES = new Set(['boolean', 'enum', 'integer', 'number', 'string', 'list', 'map', 'object', 'command', 'any']);

// ---------------------------------------------------------------------------------------------
// Checking a settings document
// ---------------------------------------------------------------------------------------------

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return dp[a.length][b.length];
}

// The described setting closest to an unknown name, if one is close enough to be a misspelling.
function closest(keys, index) {
  const name = keys.join('.');
  let best = null;
  for (const { d, seg } of index) {
    const cand = seg.slice(0, keys.length);
    if (cand.length !== keys.length || !cand.slice(0, -1).every((p, i) => segMatch(p, keys[i]))) continue;
    const at = [...keys.slice(0, -1), cand.at(-1)].join('.');
    const dist = editDistance(name, at);
    if (!best || dist < best.dist) best = { at: seg.length === keys.length ? d.name : at, dist };
  }
  return best && best.dist <= Math.max(2, Math.floor(keys.at(-1).length / 3)) ? best.at : null;
}

// The value at a path with `[]` (every item of a list) and `<key>` (every key of a map) segments: [{ keys, value }].
function valuesAt(doc, seg) {
  let found = [{ keys: [], value: doc }];
  for (const s of seg) {
    const next = [];
    for (const { keys, value } of found) {
      if (s === '[]') {
        if (Array.isArray(value)) value.forEach((v, i) => next.push({ keys: [...keys, String(i)], value: v }));
      } else if (isWild(s)) {
        if (isObject(value)) for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) next.push({ keys: [...keys, k], value: v });
      } else if (isObject(value) && Object.hasOwn(value, s)) next.push({ keys: [...keys, s], value: value[s] });
    }
    found = next;
  }
  return found;
}

// The live name an old one leads to: `<x>` in the new name takes the old name's value at that place, and a new name
// that was itself renamed later is followed to the end (a.old -> b.mid -> c.new: c.new). { to, note } or { removed }.
const nameOf = (segs) => segs.join('.').replace(/\.\[\]/g, '[]');
export function renamedTarget(r, keys, renamed = renamedSettings()) {
  let row = r;
  let at = keys;
  let note = r.note ?? null;
  for (let hop = 0; hop < 10; hop++) {
    if (row.removed) return { removed: row.removed };
    const from = segments(row.from);
    const to = segments(row.to).map((seg) => (isWild(seg) ? at[from.indexOf(seg)] ?? seg : seg));
    const next = renamed.find((o) => !o.from.startsWith('env:') && o !== row && matches(segments(o.from), to) && (!o.from.includes('<') || !renamed.some((x) => !x.from.includes('<') && x.from === to.join('.'))));
    if (!next) return { to: nameOf(to), note };
    row = next;
    at = to;
    note = next.note ?? note;
  }
  return { to: row.to, note };
}
function renamedMessage(r, keys, renamed) {
  const old = keys.join('.');
  const t = renamedTarget(r, keys, renamed);
  if (t.removed) return `${old} was removed: ${t.removed}`;
  return `${old} was renamed: use ${t.to}${t.note ? ` (${t.note})` : ''}`;
}

// The renamed and removed names a settings document uses, and old environment variables that are set.
export function renamedProblems(doc, { env = process.env, renamed = renamedSettings() } = {}) {
  const problems = [];
  for (const r of renamed) {
    if (r.from.startsWith('env:')) {
      const name = r.from.slice(4);
      if (env[name] !== undefined && env[name] !== '') problems.push(r.removed ? `the environment variable ${name} was removed: ${r.removed}` : `the environment variable ${name} was renamed: use ${r.to.replace(/^env:/, '')}`);
      continue;
    }
    for (const { keys } of valuesAt(doc, segments(r.from))) {
      // A name an exact row covers is reported by that row only, not again by a `<x>` row that also matches it.
      const path = keys.join('.');
      if (r.from.includes('<') && renamed.some((o) => o !== r && !o.from.includes('<') && o.from === path)) continue;
      problems.push(renamedMessage(r, keys, renamed));
    }
  }
  return problems;
}

// Every problem of a settings document (a repository's overlay, or merged settings): old names, names no description
// knows (with the closest described name), and values outside a setting's allowed ones (listing them).
export function settingsProblems(doc, { descs = descriptions(), renamed = renamedSettings(), env = process.env, unknown = true } = {}) {
  if (!isObject(doc)) return ['the settings must be a JSON object'];
  const problems = renamedProblems(doc, { env, renamed });
  const renamedPaths = renamed.filter((r) => !r.from.startsWith('env:')).map((r) => segments(r.from));
  const index = indexOf(descs);
  // `open`: inside an object setting whose description says other keys are allowed (an adapter validates them).
  const walk = (value, keys, open = false) => {
    if (keys.length && renamedPaths.some((p) => matches(p, keys))) return;
    const exact = keys.length ? index.find(({ seg }) => matches(seg, keys)) : null;
    if (exact) {
      const d = exact.d;
      if (!valueOk(d, value)) problems.push(`${keys.join('.')} is ${JSON.stringify(value)}; allowed: ${allowedText(d)}`);
      // A list of objects whose items are described (`a.b[].c`): check each item.
      if (Array.isArray(value) && index.some(({ seg }) => seg[keys.length] === '[]' && isPrefixOf(keys, seg))) value.forEach((item, i) => isObject(item) && walkItem(item, [...keys, '[]'], i, Boolean(d.open)));
      if (d.type !== 'object' || !isObject(value) || !index.some(({ seg }) => isPrefixOf(keys, seg))) return;
      open = Boolean(d.open);
    } else if (keys.length && !index.some(({ seg }) => isPrefixOf(keys, seg))) {
      // An object that only holds renamed settings: renamedProblems names each; walk on for the rest.
      if (renamedPaths.some((p) => isPrefixOf(keys, p)) && isObject(value)) {
        for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) walk(v, [...keys, k], open);
        return;
      }
      if (!open) problems.push(unknownMessage(keys));
      return;
    } else if (!isObject(value)) {
      // A section (a key that holds settings) must be an object: `null` or a value would replace all of its defaults.
      if (keys.length && !open) problems.push(`${keys.join('.')} is ${JSON.stringify(value)}; it holds settings, so it must be an object (leave it out to keep its defaults)`);
      return;
    }
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) walk(v, [...keys, k], open);
  };
  const walkItem = (item, keys, i, open) => {
    for (const [k, v] of Object.entries(item)) {
      if (k.startsWith('$')) continue;
      const at = [...keys, k];
      const d = index.find(({ seg }) => matches(seg, at))?.d;
      const shown = `${keys.slice(0, -1).join('.')}[${i}].${k}`;
      if (!d) {
        // A renamed key in an item is reported by renamedProblems.
        if (renamedPaths.some((p) => matches(p, at))) continue;
        if (!open) problems.push(`${shown} is not a setting`);
      } else if (!valueOk(d, v)) problems.push(`${shown} is ${JSON.stringify(v)}; allowed: ${allowedText(d)}`);
    }
  };
  const unknownMessage = (keys) => {
    const near = closest(keys, index);
    return `${keys.join('.')} is not a setting${near ? `; did you mean ${near}?` : ''}`;
  };
  if (!unknown) {
    // Values only (merged settings, where the defaults' own maps hold keys no overlay names).
    for (const { d, seg } of index) for (const { keys, value } of valuesAt(doc, seg)) if (value !== undefined && !valueOk(d, value)) problems.push(`${keys.join('.')} is ${JSON.stringify(value)}; allowed: ${allowedText(d)}`);
    return problems;
  }
  walk(doc, []);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------------------------

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function defaultText(d, defaults) {
  if (d.defaultText) return d.defaultText;
  const found = valuesAt(defaults, segments(d.name));
  if (!found.length || segments(d.name).some(isWild)) return 'none';
  const v = found[0].value;
  if (v === null) return '`null`';
  if (Array.isArray(v) && !v.length) return '`[]`';
  if (isObject(v) && !Object.keys(v).length) return '`{}`';
  return code(v);
}

const SECTION_TITLE = (s) => `\`${s}\``;

// The reference as Markdown: one table per top-level section, one row per setting with all six facts.
export function referenceMarkdown({ descs = descriptions(), defaults = defaultSettings() } = {}) {
  const bySection = new Map();
  for (const d of descs) {
    const section = segments(d.name)[0];
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(d);
  }
  const out = [];
  for (const section of [...bySection.keys()].sort((a, b) => a.localeCompare(b))) {
    out.push(`### ${SECTION_TITLE(section)}`, '', '| Setting | What it does | Type | Allowed values | Default | Environment variable |', '| --- | --- | --- | --- | --- | --- |');
    for (const d of bySection.get(section)) {
      out.push(`| \`${d.name}\` | ${cell(d.does)} | ${TYPE_LABEL[d.type] ?? d.type} | ${cell(allowedText(d))} | ${cell(defaultText(d, defaults))} | ${d.env ? `\`${d.env}\`` : 'none'} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

// The upgrade note's table: every old name and what replaced it, from the renamed-settings table.
export function renamedMarkdown(renamed = renamedSettings()) {
  const out = ['| Old name | Now |', '| --- | --- |'];
  for (const r of renamed) {
    const old = r.from.startsWith('env:') ? `environment variable \`${r.from.slice(4)}\`` : `\`${r.from}\``;
    const to = r.to?.startsWith('env:') ? `environment variable \`${r.to.slice(4)}\`` : `\`${r.to}\``;
    out.push(`| ${old} | ${r.removed ? `removed: ${cell(r.removed)}` : `${to}${r.note ? ` (${cell(r.note)})` : ''}`} |`);
  }
  return out.join('\n');
}

const PARTS = { settings: () => referenceMarkdown(), 'renamed-settings': () => renamedMarkdown() };
const partRe = (id) => new RegExp(`(<!-- generated:${id} -->\\n)([\\s\\S]*?)(<!-- /generated:${id} -->)`);

// The generated parts of the reference that differ from what the descriptions say: [{ id, problem }].
export function staleReference(file = REFERENCE_FILE) {
  const text = fs.readFileSync(file, 'utf8');
  const stale = [];
  for (const [id, make] of Object.entries(PARTS)) {
    const m = partRe(id).exec(text);
    if (!m) stale.push({ id, problem: `no <!-- generated:${id} --> part` });
    else if (m[2] !== `${make()}\n`) stale.push({ id, problem: 'differs from the settings descriptions (node scripts/pipeline/lib/settings.mjs --write)' });
  }
  return stale;
}

export function writeReference(file = REFERENCE_FILE) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [id, make] of Object.entries(PARTS)) text = text.replace(partRe(id), (_, a, _b, c) => `${a}${make()}\n${c}`);
  writeText(file, text);
}

// ---------------------------------------------------------------------------------------------
// The code against the descriptions
// ---------------------------------------------------------------------------------------------

const CODE_DIRS = ['scripts', 'packs', 'bin', 'templates', 'architecture-policy'];
const CODE_EXT = /\.(mjs|js|cjs|ts|py|sh|ps1)$/;
const SKIP_DIR = new Set(['node_modules', 'test', 'tests', '.git', 'fixtures', '__pycache__']);

export function codeFiles(root = INSTALL_ROOT) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name));
      } else if (CODE_EXT.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  for (const d of CODE_DIRS) walk(path.join(root, d));
  return out;
}

// Keys on the loaded settings object that are not settings (the loader adds them), and names that end a chain.
// `agent.cmd` is PIPELINE_AGENT_CMD, which the loader puts on the settings (not a setting of its own).
const RUNTIME_READS = new Set(['agent.cmd']);
const RUNTIME = new Set(['root', 'mainRoot', 'abs', 'stage', 'installRoot', 'warnings', 'json', 'mjs', 'ts', 'yml', 'yaml', 'toml', 'local', 'js', 'cjs', 'md', 'jsonl', 'txt', 'env', 'stack']);
const TAIL = new Set(['length', 'map', 'some', 'every', 'filter', 'find', 'forEach', 'includes', 'join', 'slice', 'push', 'concat', 'flatMap', 'split', 'replace', 'startsWith', 'endsWith', 'trim', 'toLowerCase', 'indexOf', 'at', 'get', 'has', 'set', 'keys', 'values', 'entries', 'sort', 'reduce', 'test', 'exec', 'toString', 'call', 'apply', 'bind', 'then', 'catch']);
// In a tool's own code, `config` is that tool's section.
const TOOL_CODE = { 'scripts/teststack/lib/stores/': 'teststack.stores.<store>', 'scripts/lsp/': 'lsp', 'scripts/stack/': 'stack', 'scripts/teststack/': 'teststack', 'scripts/models/': 'models' };

// Code without its comments: block comments, and line comments at the start of a line or after a space or a
// punctuation mark (not `//` inside a URL such as `https://`), so a setting named only in a comment is not "read".
// Line comments go first: a `/*` inside one (a glob such as `board/*/story.md`) opens no block.
export const stripComments = (text) => String(text).replace(/(^|[\s;,{}()[\]])\/\/[^\n]*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

// A read through a local name for a part of the settings (`s.newKey` after `const s = config.prCheck`): see
// scopedAliases.
const aliasRead = (alias) => new RegExp(`(?<![.\\w$])${alias.replace(/\$/g, '\\$')}\\??\\.((?:[A-Za-z_$][\\w$]*)(?:\\??\\.[A-Za-z_$][\\w$]*)*)`, 'g');

// Names for a part of the settings, each with the code it is in scope for: from its declaration to the end of the block
// that holds it, so two functions may each have their own `s`. `const s = config.a.b`, `const s = setting(config, 'a.b')`
// (either `?? {}`). [{ name, base, from, to }]
const SCOPED_ALIAS = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*(?:config\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)|setting\s*\(\s*config\s*,\s*(['"`])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\3\s*\))\s*(?:\?\?\s*\{\s*\}\s*)?\)?\s*;/g;
const blockEnd = (text, from) => {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth < 0) return i;
  }
  return text.length;
};
const scopedAliases = (text) => [...text.matchAll(SCOPED_ALIAS)].filter((m) => m[1] !== 'config').map((m) => ({ name: m[1], base: (m[2] ?? m[4]).replace(/\?/g, ''), from: m.index + m[0].length, to: blockEnd(text, m.index + m[0].length) }));
// `const { a, b: c, d = 1 } = config.x` (or `setting(config, 'x')`): reads of x.a, x.b, x.d.
const DESTRUCTURE = /\b(?:const|let)\s*\{([^{}]*)\}\s*=\s*\(?\s*(?:config\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)|setting\s*\(\s*config\s*,\s*(['"`])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\3\s*\))/g;
// `setting(config, 'a.b').c` or `?.c`: a read of a.b.c.
// Code text with the contents of its quoted strings blanked (a key named in a message or a key's quoted name is no
// read); template literals are kept, as their `${...}` parts are code.
const blankStrings = (t) => t.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
// Whether code text reads the key `leaf` (of the setting `name`): a property read (`x.leaf`, `x?.leaf`, not a write), a
// bracket read (`x['leaf']`), a destructuring (`const { leaf } = x`, `({ leaf }) =>`), or the setting's literal name
// in a setting() call. `copyOnly`: every property read is a copy into another object under the same key
// (`leaf: x.leaf ...`), which only moves the setting on.
export function keyReads(code, name, leaf) {
  const esc = leaf.replace(/[$]/g, '\\$');
  if (settingCalls(code).some((c) => (c.name && (c.name === name || c.name.split('.').at(-1) === leaf)) || (c.computed && new RegExp(`\\.${esc}\`$`).test(c.computed)))) return { read: true, copyOnly: false };
  if (new RegExp(`\\[\\s*(['"\`])${esc}\\1\\s*\\]`).test(code)) return { read: true, copyOnly: false };
  const bare = blankStrings(code);
  const braces = `\\{(?:[^{}]|\\{[^{}]*\\})*?(?<![\\w$.])${esc}(?![\\w$:])(?:[^{}]|\\{[^{}]*\\})*\\}`;
  if (new RegExp(`${braces}\\s*=(?![=>])|[(,]\\s*${braces}`).test(bare)) return { read: true, copyOnly: false };
  const reads = [...bare.matchAll(new RegExp(`[\\w$\\])]\\s*\\??\\.\\s*${esc}(?![\\w$])(?!\\s*=(?!=))`, 'g'))];
  if (!reads.length) return { read: false, copyOnly: false };
  const copy = new RegExp(`(?<![\\w$.])${esc}\\s*:\\s*[^,;{}]*$`);
  return { read: true, copyOnly: reads.every((m) => copy.test(bare.slice(Math.max(0, bare.lastIndexOf('\n', m.index)), m.index))) };
}

// Every `setting(<settings>, <name>)` call in code text, whatever its first argument (`config`, `{}`, `readJson(...) ?? {}`;
// council r4, sol-05): { index, end, name } with `name` the literal setting name, or { index, end, computed } with the
// second argument's text when it is not one literal. Parentheses, brackets, braces and strings are matched, so a
// nested call or an object literal is one argument.
const SETTING_NAME = /^(['"`])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\1$/;
export function settingCalls(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w$.])setting\s*\(/g)) {
    const args = [];
    let depth = 0;
    let start = m.index + m[0].length;
    let i = start;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) {
        args.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    if (i >= text.length) continue;
    args.push(text.slice(start, i).trim());
    if (args.length < 2) continue;
    const literal = SETTING_NAME.exec(args[1]);
    out.push({ index: m.index, end: i + 1, ...(literal ? { name: literal[2] } : { computed: args[1] }) });
  }
  return out;
}

// `const c = { ...defaults, ...(config.a.b ?? {}) }`: c holds a.b's keys.
const SPREAD_ALIAS = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^{}]*?\.\.\.\(?\s*config\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)[^{}]*\}\s*;/g;

// Top-level functions of the code, by name (a name defined in two files is left out: the call cannot be told apart):
// { name: { file, params: [name | [destructured keys]], body } }. A part of the settings passed to one is read there by
// its parameter.
const FUNCTION_DEF = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>)/gm;
const paramsOf = (list) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => {
    const t = p.trim();
    if (t.startsWith('{')) return [...t.slice(1, t.lastIndexOf('}')).matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    return /^([A-Za-z_$][\w$]*)/.exec(t)?.[1] ?? null;
  });
};
function functionIndex(files) {
  const index = new Map();
  const twice = new Set();
  for (const { rel, text } of files) {
    for (const m of text.matchAll(FUNCTION_DEF)) {
      const name = m[1] ?? m[3];
      const open = text.indexOf(m[1] ? '{' : '=>', m.index + m[0].length - 1);
      const start = m[1] ? open : open + 2;
      const body = text.slice(start, text[start] === '{' || /^\s*\{/.test(text.slice(start)) ? blockEnd(text, text.indexOf('{', start) + 1) + 1 : text.indexOf('\n', start));
      if (index.has(name)) twice.add(name);
      index.set(name, { file: rel, params: paramsOf(m[2] ?? m[4]), body });
    }
  }
  for (const n of twice) index.delete(n);
  return index;
}

// Code as the read checks see it: no comments, `x['key']` as `x.key`, and string literals joined by `+` folded into one
// (`'implement.' + 'rounds'`), so those forms read like the plain ones.
export const codeText = (text) => {
  let t = stripComments(text).replace(/(\?\.)?\[\s*(['"])([A-Za-z_$][\w$]*)\2\s*\]/g, (m, opt, q, k) => `${opt ? '?' : ''}.${k}`);
  for (let i = 0; i < 20; i++) {
    const folded = t.replace(/(['"])([^'"\n]*)\1\s*\+\s*(['"])([^'"\n]*)\3/g, (m, q1, a, q2, b) => `'${a}${b}'`);
    if (folded === t) break;
    t = folded;
  }
  return t;
};
// `setting(<settings>, <name>)` calls whose name is not one literal: computed names the check cannot read. Every setting
// such a name can stand for must declare the file with `readBy`. [{ file, line, name }]
export function computedReads(root = INSTALL_ROOT) {
  const out = [];
  for (const file of codeFiles(root)) {
    if (!/\.m?js$/.test(file)) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === 'scripts/pipeline/lib/settings.mjs') continue;
    const text = codeText(fs.readFileSync(file, 'utf8'));
    for (const c of settingCalls(text)) if (c.computed !== undefined) out.push({ file: rel, line: text.slice(0, c.index).split('\n').length, name: c.computed });
  }
  return out;
}

// Setting names the code reads as `config.<a>.<b>...` (the loaded settings), or through the settings accessor as
// `setting(<settings>, '<a>.<b>')` with a literal name, with the file of the first read.
// `plain` (a Set) gets only the plain reads, which alone count a described setting as read: `config.a.b` (`config['a']`
// too) and a literal `setting(config, 'a.b')`. Every other form only adds names the check reports when undescribed.
export function codeReads(root = INSTALL_ROOT, { byFile = null, plain = null } = {}) {
  const reads = new Map();
  const files = codeFiles(root).filter((f) => /\.m?js$/.test(f)).map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), text: codeText(fs.readFileSync(f, 'utf8')) }));
  const fns = functionIndex(files);
  const callArg = new RegExp(`\\b(${[...fns.keys()].map((n) => n.replace(/\$/g, '\\$')).join('|') || '(?!)'})\\(([^;]*)`, 'g');
  const re = /(?<![.\w$])config\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)/g;
  for (const file of codeFiles(root)) {
    if (!/\.m?js$/.test(file)) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const tool = Object.entries(TOOL_CODE).find(([p]) => rel.startsWith(p))?.[1];
    const text = codeText(fs.readFileSync(file, 'utf8'));
    // The accessor names the whole setting from the top of the settings (it is not a tool's own section).
    const calls = rel !== 'scripts/pipeline/lib/settings.mjs' ? settingCalls(text).filter((c) => c.name) : [];
    const accessorReads = calls.map((c) => c.name);
    const add = (keys) => {
      const name = keys.join('.');
      if (RUNTIME_READS.has(name)) return;
      if (!reads.has(name)) reads.set(name, rel);
      if (byFile) (byFile.get(rel) ?? byFile.set(rel, new Set()).get(rel)).add(name);
    };
    const chain = (raw) => {
      const keys = [];
      for (const k of raw.replace(/\?/g, '').split('.').filter(Boolean)) {
        if (TAIL.has(k)) break;
        keys.push(k);
      }
      return keys;
    };
    const within = (base) => [...(tool && base[0] !== tool && base[0] !== 'project' ? [tool] : []), ...base];
    // Reads through a local name for a part of the settings, in the block that declares it.
    for (const a of scopedAliases(text)) {
      const head = a.base.split('.');
      if (RUNTIME.has(head[0])) continue;
      for (const m of text.slice(a.from, a.to).matchAll(aliasRead(a.name))) {
        const keys = chain(m[1]);
        // A file name in a string (`evidence.mjs`) is not a read.
        if (!keys.length || keys.some((k) => RUNTIME.has(k))) continue;
        add([...within(head), ...keys]);
      }
    }
    for (const m of text.matchAll(DESTRUCTURE)) {
      const head = (m[2] ?? m[4]).replace(/\?/g, '').split('.');
      if (RUNTIME.has(head[0])) continue;
      for (const part of m[1].split(',')) {
        const key = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
        if (key) add([...(m[2] ? within(head) : head), key]);
      }
    }
    for (const c of calls) {
      const tail = /^((?:\??\.[A-Za-z_$][\w$]*)+)/.exec(text.slice(c.end))?.[1];
      if (tail) add([...c.name.split('.'), ...chain(tail)]);
    }
    for (const m of text.matchAll(SPREAD_ALIAS)) {
      const head = m[2].replace(/\?/g, '').split('.');
      if (RUNTIME.has(head[0])) continue;
      const from = m.index + m[0].length;
      for (const r of text.slice(from, blockEnd(text, from)).matchAll(aliasRead(m[1]))) {
        const keys = chain(r[1]);
        if (keys.length && !keys.some((k) => RUNTIME.has(k))) add([...within(head), ...keys]);
      }
    }
    // A part of the settings passed to a function: read there by its parameter (one call level).
    for (const m of text.matchAll(callArg)) {
      const fn = fns.get(m[1]);
      const args = paramsOf(m[2].slice(0, blockEnd(`(${m[2]}`, 1) - 1 >= 0 ? m[2].length : m[2].length));
      const raw = (() => {
        let depth = 0;
        for (let i = 0; i < m[2].length; i++) {
          if ('([{'.includes(m[2][i])) depth++;
          else if (')]}'.includes(m[2][i]) && --depth < 0) return m[2].slice(0, i);
        }
        return m[2];
      })();
      const parts = [];
      let depth = 0;
      let cur = '';
      for (const ch of raw) {
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
        } else cur += ch;
      }
      parts.push(cur);
      void args;
      parts.forEach((arg, i) => {
        const a = /^\s*\(?\s*config\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)\s*(?:\?\?\s*\{\s*\}\s*)?\)?\s*$/.exec(arg) ?? /^\s*setting\s*\(\s*config\s*,\s*(['"`])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\1\s*\)\s*$/.exec(arg);
        if (!a) return;
        const base = (a[2] && !a[1].startsWith("'") && !a[1].startsWith('"') && !a[1].startsWith('`') ? a[1] : a[2] ?? a[1]).replace(/\?/g, '').split('.');
        const head = /setting\s*\(/.test(arg) ? base : within(base);
        if (RUNTIME.has(base[0])) return;
        const param = fn.params[i];
        if (Array.isArray(param)) for (const k of param) add([...head, k]);
        else if (param) for (const r of fn.body.matchAll(aliasRead(param))) {
          const keys = chain(r[1]);
          if (keys.length && !keys.some((k) => RUNTIME.has(k))) add([...head, ...keys]);
        }
      });
    }
    for (const m of text.matchAll(re)) {
      if (plain && rel !== 'scripts/pipeline/lib/settings.mjs') {
        const ks = [];
        for (const k of m[1].replace(/\?/g, '').split('.')) {
          if (TAIL.has(k)) break;
          ks.push(k);
        }
        if (ks.length && !RUNTIME.has(ks[0]) && !(ks[0] === 'project' && tool)) plain.add((tool && ks[0] !== tool ? [tool, ...ks] : ks).join('.'));
      }
      const keys = [];
      for (const k of m[1].replace(/\?/g, '').split('.')) {
        if (TAIL.has(k)) break;
        keys.push(k);
      }
      if (!keys.length || RUNTIME.has(keys[0]) || keys[0] === 'project' && tool) continue;
      add(tool && keys[0] !== tool ? [tool, ...keys] : keys);
    }
    for (const name of accessorReads) {
      add(name.split('.'));
      plain?.add(name);
    }
  }
  return reads;
}

// `config.<a>.<b> ?? <literal>` in the code: a second default for a setting.
const LITERAL = '(-?\\d[\\d_.]*|\'[^\']*\'|"[^"]*"|true|false|\\[[^\\]]*\\]|\\{[^}]*\\})';
// The described setting a name and a literal copy: the only setting whose last part is that name, when its default is
// that literal. Helper parameters any code has (a state folder, a timeout) are left out. `any`: a module constant's key,
// which may match a setting of any name length.
const GENERIC_PARAMS = new Set(['stateDir', 'metricsDir', 'timeoutSec', 'enabled', 'method', 'width', 'height', 'keep', 'root']);
// The names the loaded settings go by in the code.
const CONFIG_NAMES = new Set(['config', 'wt', 'wtConfig', 'cfg', 'settings']);
// The keys any object has (a timeout, a type, a switch): `<x>.<key> ?? <default>` counts only on the settings.
const GENERIC_KEYS = new Set(['stateDir', 'metricsDir', 'timeoutSec', 'enabled', 'keep', 'root', 'type']);
function twinsOf(scriptsDir) {
  const twins = new Map();
  // Every described setting with a plain default, by its last part ({ name, value }), unambiguous or not.
  twins.all = new Map();
  {
    const defs = defaultSettings(scriptsDir);
    // A setting under a map's key (`board.fields.<field>`) stands for each key its defaults hold (council r4, A4).
    const expand = (seg) => {
      const at = seg.findIndex((x) => isWild(x));
      if (at < 0) return [seg];
      if (seg[at + 1] !== undefined) return [];
      const map = seg.slice(0, at).reduce((o, k) => (o == null ? undefined : o[k]), defs);
      return map && typeof map === 'object' && !Array.isArray(map) ? Object.keys(map).map((k) => [...seg.slice(0, at), k]) : [];
    };
    for (const d of descriptions(scriptsDir)) {
      if (segments(d.name).includes('[]')) continue;
      for (const seg of expand(segments(d.name))) {
        const v = seg.reduce((o, k) => (o == null ? undefined : o[k]), defs);
        if (v == null || typeof v === 'object') continue;
        const leaf = seg.at(-1);
        const name = seg.join('.');
        twins.set(leaf, twins.has(leaf) ? null : { name, value: String(v) });
        twins.all.set(leaf, [...(twins.all.get(leaf) ?? []), { name, value: String(v) }]);
      }
    }
  }
  return twins;
}
const literalValue = (literal) => String(literal).replace(/^['"]|['"]$/g, '').replace(/_/g, '');
function defaultTwin(twins, name, literal, { any = false } = {}) {
  const t = twins.get(name);
  if (!t || (!any && GENERIC_PARAMS.has(name))) return null;
  return t.value === String(literal).replace(/^['"]|['"]$/g, '').replace(/_/g, '') ? t.name : null;
}
export function fallbackLiterals(root = INSTALL_ROOT, { scriptsDir = SCRIPTS_DIR } = {}) {
  const twins = twinsOf(scriptsDir);
  // Distinctive text defaults (a path, a ref, a pattern), by value: only when one setting has that default.
  const distinct = new Map();
  for (const list of twins.all.values()) {
    for (const t of list) if (t.value.length >= 6 && /[/.:{]/.test(t.value)) distinct.set(t.value, distinct.has(t.value) && distinct.get(t.value) !== t.name ? null : t.name);
  }
  for (const [v, n] of distinct) if (!n) distinct.delete(v);
  // A setting's environment variable ({ name, value } by the variable).
  const envTwins = new Map();
  {
    const defs = defaultSettings(scriptsDir);
    for (const d of descriptions(scriptsDir)) {
      const v = segments(d.name).reduce((o, k) => (o == null ? undefined : o[k]), defs);
      if (d.env && v != null && typeof v !== 'object') envTwins.set(d.env, { name: d.name, value: String(v) });
    }
  }
  const out = [];
  const re = /\bconfig\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)\s*(?:\?\?|\|\|)\s*(-?\d[\d_.]*|'[^']*'|"[^"]*"|true|false|\[[^\]]*\]|\{[^}]*\})/g;
  for (const file of codeFiles(root)) {
    if (!/\.m?js$/.test(file)) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const tool = Object.entries(TOOL_CODE).find(([p]) => rel.startsWith(p))?.[1];
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const keys = m[1].replace(/\?/g, '').split('.');
      // `?? {}` and `?? []` guard a missing object or list; they are not a second default.
      if (RUNTIME.has(keys[0]) || /^(\{\s*\}|\[\s*\])$/.test(m[2])) continue;
      const name = (tool && keys[0] !== tool ? [tool, ...keys] : keys).join('.');
      out.push({ name, file: rel, line: text.slice(0, m.index).split('\n').length, literal: m[2] });
    }
    // The same through the settings accessor (`setting(config, 'a.b') ?? 3`) and through a local name for a part of
    // the settings (`const s = config.a; s.b ?? 3`).
    for (const c of rel === 'scripts/pipeline/lib/settings.mjs' ? [] : settingCalls(text).filter((x) => x.name)) {
      const lit = new RegExp(`^\\s*(?:\\?\\?|\\|\\|)\\s*${LITERAL}`).exec(text.slice(c.end))?.[1];
      if (lit && !/^(\{\s*\}|\[\s*\])$/.test(lit)) out.push({ name: c.name, file: rel, line: text.slice(0, c.index).split('\n').length, literal: lit });
    }
    // Through a local name for a part of the settings, in the block that declares it (a name may be declared again in
    // another function).
    const code = codeText(text);
    for (const a of scopedAliases(code)) {
      const head = a.base.split('.');
      if (RUNTIME.has(head[0])) continue;
      for (const m of code.slice(a.from, a.to).matchAll(new RegExp(`(?<![.\\w$])${a.name.replace(/\$/g, '\\$')}\\??\\.((?:[A-Za-z_$][\\w$]*)(?:\\??\\.[A-Za-z_$][\\w$]*)*)\\s*(?:\\?\\?|\\|\\|)\\s*${LITERAL}`, 'g'))) {
        if (/^(\{\s*\}|\[\s*\])$/.test(m[2])) continue;
        const name = [...(tool && head[0] !== tool ? [tool] : []), ...head, ...m[1].replace(/\?/g, '').split('.')].join('.');
        out.push({ name, file: rel, line: code.slice(0, a.from).split('\n').length + code.slice(a.from, a.from + m.index).split('\n').length - 1, literal: m[2] });
      }
    }
    // A function parameter's default, or a module constant's key, equal to a described setting's default under the
    // setting's own unambiguous name: the default written again.
    for (const m of code.matchAll(/[({,]\s*([A-Za-z_$][\w$]*)\s*=\s*(-?\d[\d_.]*|'[^'\n]*'|"[^"\n]*")(?=\s*[,)}])/g)) {
      const hit = defaultTwin(twins, m[1], m[2]);
      if (hit) out.push({ name: hit, file: rel, line: code.slice(0, m.index).split('\n').length, literal: m[2] });
    }
    for (const m of code.matchAll(/^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*\{([^{}]*)\}/gm)) {
      const hits = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(-?\d[\d_.]*|'[^'\n]*'|"[^"\n]*"|true|false)/g)].map((k) => [defaultTwin(twins, k[1], k[2], { any: true }), k[2]]).filter(([h]) => h);
      const sections = new Set(hits.map(([h]) => h.split('.').slice(0, -1).join('.')));
      if (hits.length && sections.size === 1) for (const [h, lit] of hits) out.push({ name: h, file: rel, line: code.slice(0, m.index).split('\n').length, literal: lit });
    }
    // Any other object literal holding two or more of one section's defaults (an inline copy of a map setting, such as
    // the board's column names: council r4, A4).
    for (const m of code.matchAll(/\{([^{}]*)\}/g)) {
      const hits = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(-?\d[\d_.]*|'[^'\n]*'|"[^"\n]*"|true|false)/g)].map((k) => [defaultTwin(twins, k[1], k[2], { any: true }), k[2]]).filter(([h]) => h);
      const sections = new Set(hits.map(([h]) => h.split('.').slice(0, -1).join('.')));
      if (hits.length >= 2 && sections.size === 1) for (const [h, lit] of hits) out.push({ name: h, file: rel, line: code.slice(0, m.index).split('\n').length, literal: lit });
    }
    // Any `<x>.<key> ?? <value>` or `|| <value>`, where <value> is a literal or a module constant of one, and some
    // described setting named <key> has that value as its default: the default written again, whatever <x> is.
    const consts = new Map([...code.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d[\d_.]*|'[^'\n]*'|"[^"\n]*"|true|false)\s*;/gm)].map((m) => [m[1], m[2]]));
    // A key any object has (a timeout, a type, a size) counts only on the loaded settings themselves (config, wt) or a
    // part of them (settings). A bare name counts too (`plansDir ?? '.factory/plans'`), and so does a setting's own
    // environment variable with its default (`env.PIPELINE_BASE_REF || 'origin/main'`).
    for (const m of code.matchAll(/(?<![\w$])(?:([A-Za-z_$][\w$]*)\??\.)?([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\|)\s*(-?\d[\d_.]*(?![\w.])|'[^'\n]*'|"[^"\n]*"|true|false|[A-Za-z_$][\w$]*(?![\w$(.]))/g)) {
      if (GENERIC_KEYS.has(m[2]) && !CONFIG_NAMES.has(m[1])) continue;
      const literal = /^[A-Za-z_$]/.test(m[3]) && !/^(true|false)$/.test(m[3]) ? consts.get(m[3]) : m[3];
      if (literal === undefined) continue;
      const hit = (m[1] === 'env' && envTwins.get(m[2]) ? [envTwins.get(m[2])] : twins.all.get(m[2]) ?? []).find((t) => t.value === literalValue(literal));
      if (hit) out.push({ name: hit.name, file: rel, line: code.slice(0, m.index).split('\n').length, literal: m[3] === literal ? literal : `${m[3]} (${literal})` });
    }
    // A default no other value is likely to equal (a path, a ref, a pattern: text with `/`, `.`, `:` or `{`) after any
    // `??` or `||`, whatever comes before it (`flag('dir') ?? '.factory/policy'`, `run.base ?? 'origin/main'`).
    for (const m of code.matchAll(/(?:\?\?|\|\|)\s*('[^'\n]*'|"[^"\n]*")/g)) {
      const hit = distinct.get(literalValue(m[1]));
      if (hit) out.push({ name: hit, file: rel, line: code.slice(0, m.index).split('\n').length, literal: m[1] });
    }
  }
  // `{ key: <literal>, ...config.<a>.<b> }`: a literal default for `<a>.<b>.key` spread under the settings.
  const spread = /\{([^{}]*?)\.\.\.\(?(?:[A-Za-z_$][\w$]*\??\.)*?(?:config|wt|wtConfig)\??\.((?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*)/g;
  for (const file of codeFiles(root)) {
    if (!/\.m?js$/.test(file)) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(spread)) {
      for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*):\s*(-?\d[\d_.]*|'[^']*'|"[^"]*"|true|false)\s*(?:,|$)/g)) {
        out.push({ name: `${m[2].replace(/\?/g, '')}.${k[1]}`, file: rel, line: text.slice(0, m.index).split('\n').length, literal: k[2] });
      }
    }
  }
  // One problem per setting, place and value, whichever rules found it.
  return [...new Map(out.map((f) => [`${f.name}|${f.file}|${f.line}|${f.literal}`, f])).values()];
}

// Whether a read path is covered by a description: it is one, it lies inside one (a map, list or object setting), or
// it is an object that holds described settings.
function covered(keys, index) {
  return index.some(({ seg }) => matches(seg, keys) || isPrefixOf(keys, seg) || (seg.length < keys.length && matches(seg, keys.slice(0, seg.length)) && seg.length >= 1));
}

// The problems the settings test reports: [{ kind, name, problem }].
export function settingsCheck({ root = INSTALL_ROOT, scriptsDir = SCRIPTS_DIR, reference = REFERENCE_FILE } = {}) {
  const descs = descriptions(scriptsDir);
  const index = indexOf(descs);
  const defaults = defaultSettings(scriptsDir);
  const problems = [];
  // Every description is well formed.
  const seen = new Set();
  for (const d of descs) {
    if (seen.has(d.name)) problems.push({ kind: 'description', name: d.name, problem: 'described twice' });
    seen.add(d.name);
    if (!LEAF_TYPES.has(d.type)) problems.push({ kind: 'description', name: d.name, problem: `type "${d.type}" is not one of ${[...LEAF_TYPES].join(', ')}` });
    if (typeof d.does !== 'string' || d.does.length < 10) problems.push({ kind: 'description', name: d.name, problem: 'says nothing about what it does' });
    if (d.type === 'enum' && !(Array.isArray(d.values) && d.values.length)) problems.push({ kind: 'description', name: d.name, problem: 'a choice with no values' });
  }
  // Every default is described and allowed by its description.
  const walk = (value, keys) => {
    if (!keys.length) {
      for (const [k, v] of Object.entries(value)) walk(v, [k]);
      return;
    }
    const exact = index.find(({ seg }) => matches(seg, keys));
    if (exact) {
      if (!valueOk(exact.d, value)) problems.push({ kind: 'default', name: keys.join('.'), problem: `default ${JSON.stringify(value)} is not allowed by its description (${allowedText(exact.d)})` });
      if (exact.d.type !== 'object' || !isObject(value) || !index.some(({ seg }) => isPrefixOf(keys, seg))) return;
    } else if (!isObject(value) || !index.some(({ seg }) => isPrefixOf(keys, seg))) {
      problems.push({ kind: 'default', name: keys.join('.'), problem: 'has a default but no description' });
      return;
    }
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) walk(v, [...keys, k]);
  };
  walk(defaults, []);
  // Code reads only described settings.
  const byFile = new Map();
  const plain = new Set();
  const reads = codeReads(root, { byFile, plain });
  for (const [name, file] of reads) {
    if (!covered(segments(name), index)) problems.push({ kind: 'undescribed', name, problem: `read in ${file} but described nowhere` });
  }
  // Every described setting is read, by a plain read (`config.a.b`, `config['a'].b`, a literal
  // `setting(config, 'a.b')`, or one of a key under it), or by a declaration: the setting names in `readBy` the file that
  // reads it some other way (a local name for a part of the settings, a part handed to a function, a computed name). The
  // check does not guess at those other ways; it only holds a declaration to its file, which must exist and name the key.
  const texts = codeFiles(root).map((f) => ({ shell: !/\.(m?js|ts)$/.test(f), text: stripComments(fs.readFileSync(f, 'utf8')) }));
  // A read of an environment variable: `env.NAME` or `env['NAME']` in code, `$NAME` or `${NAME}` in a script; never the
  // name inside a longer one, a message or a comment (council r4, T12).
  const readsEnv = (name) => {
    const n = name.replace(/[$]/g, '\\$');
    const code = new RegExp(`\\benv\\??\\.${n}(?![\\w$])|\\benv\\[\\s*['"\`]${n}['"\`]\\s*\\]`);
    const shell = new RegExp(`\\$\\{?${n}(?![\\w])`);
    return texts.some((t) => (t.shell ? shell : code).test(t.text));
  };
  const plainNames = [...plain].map(segments);
  const under = (r, seg) => r.length >= seg.length && seg.every((x, i) => isWild(x) || x === '[]' || r[i] === x);
  for (const d of descs) {
    const seg = segments(d.name);
    const leaf = seg.filter((x) => x !== '[]' && !isWild(x)).at(-1);
    if (d.readBy) {
      const file = path.join(root, d.readBy);
      const code = fs.existsSync(file) ? codeText(fs.readFileSync(file, 'utf8')) : null;
      if (code === null) problems.push({ kind: 'unread', name: d.name, problem: `its readBy file ${d.readBy} does not exist` });
      else {
        // The file must read the key, not merely name it (council r4, A17); a copy into another object must be read on.
        const r = keyReads(code, d.name, leaf);
        const esc = leaf.replace(/[$]/g, '\\$');
        // Read on: another script reads the key (the same rule), or other code does (`x.key`, `x["key"]`, `x.get("key")`:
        // the policy engine, a shell or Python helper).
        const readOn = () => codeFiles(root).some((f) => {
          if (path.join(root, d.readBy) === f) return false;
          const text = fs.readFileSync(f, 'utf8');
          if (/\.(m?js|cjs|ts)$/.test(f)) {
            const o = keyReads(codeText(text), d.name, leaf);
            return o.read && !o.copyOnly;
          }
          return new RegExp(`\\.${esc}\\b|\\[\\s*['"]${esc}['"]\\s*\\]|\\.get\\(\\s*['"]${esc}['"]`).test(text);
        });
        if (!r.read) problems.push({ kind: 'unread', name: d.name, problem: `its readBy file ${d.readBy} never reads ${leaf} (a property read, a destructuring or its setting() name; a word in a string or comment is not one)` });
        else if (r.copyOnly && !readOn()) problems.push({ kind: 'unread', name: d.name, problem: `its readBy file ${d.readBy} only copies ${leaf} into another object, and no code reads it from there` });
      }
      continue;
    }
    if (isWild(leaf) && seg.length === 1) continue;
    if (!plainNames.some((r) => under(r, seg))) problems.push({ kind: 'unread', name: d.name, problem: 'described, but no plain read (config.<section>.<key>, a literal setting() name) reads it: name the file that reads it in readBy' });
  }
  // A computed `setting()` name resolves only to settings that declare that file: every described setting its name can
  // stand for (a template's `${...}` as any text) names the file in readBy, and it can stand for one at least.
  for (const c of computedReads(root)) {
    const template = /^`([^`]*)`$/.exec(c.name)?.[1];
    const pattern = template ? new RegExp(`^${template.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^()|[\]\\]/g, '\\$&')).join('.+')}$`) : /^.+$/;
    const matching = descs.filter((d) => pattern.test(d.name));
    const undeclared = matching.filter((d) => d.readBy !== c.file);
    if (!matching.length || undeclared.length) problems.push({ kind: 'computed', name: `${c.file}:${c.line}`, problem: `setting() with the computed name ${c.name} could read ${undeclared.length ? undeclared.slice(0, 4).map((d) => d.name).join(', ') + (undeclared.length > 4 ? ', ...' : '') : 'no described setting'}; every setting it can read names this file in readBy` });
  }
  // Every environment variable on a row is read by the code.
  for (const d of descs) {
    if (d.env && !readsEnv(d.env)) problems.push({ kind: 'env', name: d.name, problem: `its environment variable ${d.env} is read nowhere` });
  }
  // The renamed table names settings that exist.
  for (const r of renamedSettings()) {
    if (r.to && !r.to.startsWith('env:') && !r.to.startsWith('$') && !index.some(({ seg }) => matches(seg, segments(r.to)) || isPrefixOf(segments(r.to), seg))) problems.push({ kind: 'renamed', name: r.from, problem: `renamed to ${r.to}, which no description has` });
  }
  // No default is written twice: code reads the merged settings, never `config.<setting> ?? <literal>`.
  for (const f of fallbackLiterals(root, { scriptsDir })) {
    const keys = segments(f.name);
    if (index.some(({ seg }) => matches(seg, keys)) && valuesAt(defaults, keys).length) problems.push({ kind: 'fallback', name: f.name, problem: `${f.file}:${f.line} falls back to ${f.literal}; its default is in a default settings file` });
  }
  if (reference) for (const s of staleReference(reference)) problems.push({ kind: 'reference', name: s.id, problem: s.problem });
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    writeReference();
    console.log(`wrote ${path.relative(process.cwd(), REFERENCE_FILE)}`);
  }
  if (process.argv.includes('--check') || !process.argv.includes('--write')) {
    const problems = settingsCheck();
    for (const p of problems) console.error(`${p.kind}: ${p.name}: ${p.problem}`);
    process.exit(problems.length ? 1 : 0);
  }
}
