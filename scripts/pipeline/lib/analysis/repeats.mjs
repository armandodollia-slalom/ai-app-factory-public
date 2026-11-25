// The repeated-values check (GEN-18): application code that writes again a value that already has one source.
//   repeated-default   a literal fallback equal to the default the repository's configuration defines for the same key
//                      (`?? 900` where the options class or appsettings.json already says 900);
//   repeated-constant  a literal equal to a named constant's value, in another file, for the same purpose (the
//                      constant's name and the line share a word).
// The configuration sources are `project.configSources` (recorded at onboarding); the patterns that read defaults,
// constants and fallbacks are each language pack's `repeats.json`. Findings are evidence for the clean-code reviewer,
// never blocking by themselves (analysis/config.mjs CLEAN_CODE_LENS). Pure functions over file texts; the CLI is
// packs/security/analysis/repeated-values.mjs.
import { escapeRe } from '../util.mjs';

// A literal: a whole number token (digit separators allowed: `900_000` is not 900), or a quoted string.
export const LITERAL = String.raw`(?<![\w.])-?\d[\d_]*(?:\.\d+)?(?![\w.])|"[^"\n]*"|'[^'\n]*'`;
// Words that say nothing about a value's purpose.
const NOISE = new Set(['get', 'set', 'value', 'values', 'default', 'defaults', 'const', 'config', 'configuration', 'settings', 'setting', 'options', 'option', 'env', 'var', 'let', 'the', 'new', 'max', 'min', 'int', 'string', 'str', 'number', 'return', 'this', 'self', 'public', 'private', 'static', 'readonly', 'export', 'final']);

// The value a literal stands for: numbers by value, strings without their quotes.
export function valueOf(literal) {
  const t = String(literal).trim();
  if (/^-?\d[\d_]*(?:\.\d+)?$/.test(t)) return String(Number(t.replace(/_/g, '')));
  const m = /^(["'])([\s\S]*)\1$/.exec(t);
  return m ? m[2] : t;
}

// Values too common to say anything (0, 1, -1, true, an empty or one-character string; other numbers count).
export const trivial = (value) => ['', '0', '1', '-1', 'true', 'false', 'True', 'False', 'null', 'None'].includes(value) || (value.length === 1 && !/\d/.test(value));

// The words of an identifier or key: `TimeoutSec`, `timeout_sec`, `TIMEOUT-SEC` and `Basket:TimeoutSec` all give
// timeout and sec.
export function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !NOISE.has(w));
}
// A key segment in one spelling (`TimeoutSec`, `timeout_sec` and `TIMEOUT-SEC` are one).
const segment = (name) => String(name).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
// The key path a fallback's expression reads: every key it quotes, in order and whole (`"Shop:Timeout"`, `"shop.timeout"`,
// a section then its key: `GetSection("Shop").GetValue<int>("Timeout")`), else the property it ends with
// (`options.TimeoutSec`).
export function keyPath(expr) {
  const quoted = [...String(expr).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const parts = quoted.length ? quoted.flatMap((q) => q.split(/[:.]/)) : [String(expr).split(/[^\w$]+/).filter(Boolean).at(-1) ?? ''];
  return parts.map(segment).filter(Boolean);
}
// Whether a default's path ends with a key path: an unqualified property (`options.Timeout`) by its last segments.
const endsWith = (path, key) => key.length > 0 && key.length <= path.length && key.every((k, i) => path[path.length - key.length + i] === k);
// Whether a read names a default's key, by how the read is based (readBase): `exact`, the whole path from the root
// (council r4, sol-05: `Shop:Timeout` is not `Tenant:Shop:Timeout`); `below`, a section the scanner cannot resolve, so a
// key under the top level by its last segments (council r5: never an unrelated top-level key); `suffix`, an unquoted
// property, by its last segments.
const names = (path, key, how) => (how === 'exact' ? path.length === key.length && endsWith(path, key) : how === 'below' ? path.length > key.length && endsWith(path, key) : endsWith(path, key));

// The receiver a read starts from: `config` in `config.GetSection("Shop").GetValue(...)`, `shop` in `shop["Timeout"]`.
const receiverOf = (expr) => /^([\w.]+?)(?=\s*\.\s*Get\w*\s*[<(]|\s*\[)/.exec(expr)?.[1] ?? null;

// Where a quoted read is based (council r5, sol-05), when the pack says what the root configuration is called
// (`rootReceiver`) or declared as (`rootDeclared`), and how a variable is given a section (`sectionAssign`; `{name}` is
// the variable in both): the root, so the key is the whole path; a variable assigned a section chain earlier in the
// file, so the key is under that section's path (a section of a section too); else a section the scanner cannot
// resolve. Without `rootReceiver` a quoted key is the whole path. Returns { prefix, how }.
const named = (source, receiver) => new RegExp(source.replaceAll('{name}', escapeRe(receiver)), 'g');
const isRoot = (receiver, before, patterns) => new RegExp(patterns.rootReceiver).test(receiver) || Boolean(patterns.rootDeclared && named(patterns.rootDeclared, receiver).test(before));
function readBase(receiver, before, patterns, depth = 0) {
  if (!patterns.rootReceiver) return { prefix: [], how: 'exact' };
  if (receiver && isRoot(receiver, before, patterns)) return { prefix: [], how: 'exact' };
  const assign = receiver && depth < 8 && patterns.sectionAssign ? [...before.matchAll(named(patterns.sectionAssign, receiver))].at(-1) : null;
  if (!assign) return { prefix: [], how: 'below' };
  const base = readBase(receiverOf(assign.groups.expr), before.slice(0, assign.index), patterns, depth + 1);
  return { prefix: [...base.prefix, ...keyPath(assign.groups.expr)], how: base.how };
}

const regex = (source) => new RegExp(source.replaceAll('{literal}', LITERAL), 'gm');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Defaults a configuration source defines: [{ key, value, file, line }]. JSON files by their leaf keys; other files by
// the pack's `defaults` patterns (named groups `key` and `value`).
export function sourceDefaults(file, text, patterns) {
  if (file.endsWith('.json')) return jsonDefaults(file, text);
  const out = [];
  for (const source of patterns.defaults ?? []) {
    for (const m of text.matchAll(regex(source))) out.push({ key: m.groups.key, path: [segment(m.groups.key)], value: valueOf(m.groups.value), file, line: lineOf(text, m.index + m[0].indexOf(m.groups.key)) });
  }
  return out;
}

// A JSON source's defaults by their full key path (`Shop:Timeout`), each at the line of its own key.
function jsonDefaults(file, text) {
  try {
    JSON.parse(text);
  } catch {
    return [];
  }
  // A property name with colons is a path of its own (`{"Shop:Timeout": 900}` is `{"Shop": {"Timeout": 900}}`, as .NET's
  // JSON configuration provider reads it).
  return jsonLeaves(text).map((l) => {
    const keys = l.keys.flatMap((k) => k.split(':'));
    return { key: keys.join(':'), path: keys.map(segment), value: String(l.value), file, line: lineOf(text, l.at) };
  });
}

// The leaves of an object path in valid JSON text (numbers, strings, booleans; not inside arrays), each with the offset
// of its key, found by scanning the text itself: a key is where it is, not where its name first appears (a string value
// or another section's key of the same name).
function jsonLeaves(text) {
  const out = [];
  let i = 0;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const primitive = () => {
    const raw = /^[^,}\]\s]+/.exec(text.slice(i))[0];
    i += raw.length;
    return JSON.parse(raw);
  };
  const items = (close, each) => {
    i++;
    space();
    while (text[i] !== close) {
      each();
      space();
      if (text[i] === ',') i++;
      space();
    }
    i++;
  };
  const value = (keys, at) => {
    space();
    if (text[i] === '{') return items('}', () => {
      const keyAt = i;
      const k = string();
      space();
      i++;
      value(keys && [...keys, k], keyAt);
    });
    if (text[i] === '[') return items(']', () => value(null, null));
    const v = text[i] === '"' ? string() : primitive();
    if (keys?.length && v !== null) out.push({ keys, at, value: v });
    return undefined;
  };
  value([], null);
  return out;
}

// Named constants a file defines: [{ name, value, file, line }] (the pack's `constants` patterns, groups `name`, `value`).
export function fileConstants(file, text, patterns) {
  const out = [];
  for (const source of patterns.constants ?? []) {
    for (const m of text.matchAll(regex(source))) out.push({ name: m.groups.name, value: valueOf(m.groups.value), file, line: lineOf(text, m.index + m[0].indexOf(m.groups.name)) });
  }
  return out;
}

const where = (x) => `${x.file}:${x.line}`;

// The repeats in one file's lines (only the lines the caller asks about: `lines`, else all of them). `defaults` and
// `constants` are the repository's, from every source and code file. Returns findings (clean-code-tools.mjs asLines).
export function findRepeats(file, text, patterns, { defaults = [], constants = [], lines = null } = {}) {
  const out = [];
  const asked = (n) => !lines || lines.has(n);
  const reported = new Map();
  const report = (n, literal) => reported.set(n, new Set([...(reported.get(n) ?? []), literal]));
  // A whole-line comment (the pack's `comments`) is prose, not code: a literal in it repeats nothing.
  const rows = text.split('\n');
  const comment = patterns.comments ? new RegExp(patterns.comments) : null;
  const code = (n) => asked(n) && !comment?.test(rows[n - 1]);
  // Fallbacks over the whole text, so `??` at the end of one line and its literal on the next is one fallback; it is
  // reported at the literal's line. Only the default the key names, and only when exactly one does.
  for (const source of patterns.fallbacks ?? []) {
    for (const m of text.matchAll(regex(source))) {
      const literal = m.groups.value.trim();
      const n = lineOf(text, m.index + m[0].lastIndexOf(m.groups.value));
      const value = valueOf(literal);
      const base = /["']/.test(m.groups.expr) ? readBase(receiverOf(m.groups.expr), text.slice(0, m.index), patterns) : { prefix: [], how: 'suffix' };
      const key = [...base.prefix, ...keyPath(m.groups.expr)];
      // One key defined in several sources (appsettings.json and an environment's override) is one default; two
      // different keys the expression could mean (an unqualified property) are ambiguous.
      const matches = defaults.filter((d) => !trivial(d.value) && d.value === value && names(d.path ?? [segment(d.key)], key, base.how));
      if (!code(n) || new Set(matches.map((d) => (d.path ?? [segment(d.key)]).join(':'))).size !== 1) continue;
      const [d] = [...matches].sort((a, b) => a.file.length - b.file.length || a.file.localeCompare(b.file) || a.line - b.line);
      if (d.file === file && d.line === n) continue;
      report(n, literal);
      out.push({ rule: 'repeated-default', file, line: n, message: `the fallback ${literal} repeats the default of ${d.key}, which ${where(d)} already defines as ${d.value}: read the configured value instead (CC-1)`, related: [where(d)] });
    }
  }
  rows.forEach((row, i) => {
    const n = i + 1;
    if (!code(n)) return;
    const lineWords = new Set(words(row.replace(new RegExp(LITERAL, 'g'), ' ')));
    for (const m of row.matchAll(new RegExp(LITERAL, 'g'))) {
      const value = valueOf(m[0]);
      if (trivial(value) || reported.get(n)?.has(m[0].trim())) continue;
      const c = constants.find((k) => k.value === value && k.file !== file && words(k.name).some((w) => lineWords.has(w)));
      if (!c) continue;
      report(n, m[0].trim());
      out.push({ rule: 'repeated-constant', file, line: n, message: `${m[0].trim()} repeats the constant ${c.name}, which ${where(c)} defines with this value: use the constant instead (CC-1)`, related: [where(c)] });
    }
  });
  return out.sort((a, b) => a.line - b.line);
}
