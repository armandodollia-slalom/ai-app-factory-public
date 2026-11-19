// Text that reaches an agent must not send it to a path it may not write. Inverted, so that a new phrasing is
// caught by default: every mention of a path the reading agent may not write (the factory guard's protected
// paths and the files the factory generates) is a problem, unless its sentence is recognisably harmless:
// - a prohibition: every write cue in it is negated ("Never edit `.factory/config.json`");
// - a statement of ownership or location ("are the factory's", "belongs to", "is in", "are declared in": a
//   descriptive passive, not "must be updated");
// - read-only: a read cue (read, see, follow, consult, load, ...) and no write cue;
// - explicitly marked: "(read-only)" or "<!-- read-only -->" in the sentence.
// Write cues are matched by stem anywhere in the sentence (edit, editing, edited, updat-, add-, insert, append,
// bump, adjust, tweak, sed, waiv-, ...), sentences are joined across wrapped lines, and a passive with
// must/should/needs to be counts as an instruction. Also:
// - topology placed in `.factory/config.json` (it lives in `.factory/app.json`) unless the sentence names app.json;
// - a `.factory/` path that does not exist in the repository, in a sentence with a write cue.
// What is scanned (agentTextProblems): each agent's prompt (definition, addendum, lessons); every string of the
// policy's rules, patterns and validator registry, as the engine renders them; the root instruction files
// (CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules, .github/copilot-instructions.md) whole; the repository's skills
// (.claude/skills, .github/skills, .agents/skills); the e2e tree and test-stack config agents extend; the
// Markdown in the test tree; the prose in app.json; the policy profile, exceptions, and YAML comments of the policy.
// Paths are recognised with backslashes or without their leading dot, and a clause after a semicolon continues
// the one before it ("lives in <path>; keep it current").
// It is a heuristic over English sentences: it errs towards flagging, and a sentence it misjudges is fixed or
// marked. `factory check` fails on a problem; `factory render` and `factory config split` print them.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { agentDefinition } from './agents.mjs';
import { addendumText } from './util.mjs';
import { APP_FILE, APP_KEYS, GOVERNANCE_SECTIONS, INSTALL_ROOT, OVERLAY_FILE } from './config.mjs';
import { manifestPaths, PROTECTED_DEFAULT, WRITERS_DEFAULT } from './factory-guard.mjs';

const TOPOLOGY = Object.entries(APP_KEYS).flatMap(([section, keys]) => keys.map((k) => `${section}.${k}`));
const BARE = TOPOLOGY.map((t) => t.split('.')[1]).filter((k) => !['services', 'env', 'ports', 'urls', 'projects'].includes(k));
const TOPOLOGY_RE = new RegExp(`(?<![\\w.])(${[...TOPOLOGY, ...BARE].map((t) => t.replace(/\./g, '\\.')).join('|')})\\b`);
// The code host, tracker and CI settings as they appear in prose: `tracker.lanes`, `host.token`, ...
const GOVERNANCE_RE = new RegExp(`\\b(${GOVERNANCE_SECTIONS.join('|')})\\.[a-zA-Z]+`);
const PATH_RE = /(?:^|[\s`'"(\[])((?:\.\/)?(?:\.factory|\.claude|\.github|\.codex|\.gemini|\.cursor|\.mcp\.json|AGENTS\.md|CLAUDE\.md|GEMINI\.md|CODEOWNERS)(?:\/[\w.*{}<>@-]+)*)/g;

const WRITE_STEM = /^(edit|chang|updat|add$|adds$|added$|adding$|insert|append|bump|adjust|tweak|writ|wrote|modif|remov|delet|replac|renam|creat|declar|regist|classif|fix|sed$|waiv|patch|overwrit|rewrit|amend|extend|enabl|disabl|uncomment|drop|rais|increas|decreas|truncat|regenerat|commit|mov|put$|puts$|set$|sets$|setting$|record$|silenc|bypass|toggl)/;
const READ_CUE = /^(read|see|follow|consult|refer|load|look|check|open|use|uses|using|per|according|describ|document|defin|list|explain|show|cite|quot|mention|nam)/;
const NEGATIONS = new Set(['never', 'not', "don't", 'dont', 'cannot', "can't", "mustn't", "shouldn't", "won't", 'no', 'nor', 'without']);
// A negation of these is not a negation of the write that follows ("do not forget to add ...").
const NOT_REALLY = new Set(['forget', 'hesitate', 'fail', 'omit', 'skip', 'wait', 'stop']);
const OWNERSHIP = /factory's|belongs? to|owned by|is guarded|are guarded|denied|protected|only (people|a person|the retro)|governance|read-only|read only/i;
// "(read-only)", "(`path`, read-only)" or <!-- read-only -->: the writer says the path is only read.
const MARKED = /\bread-only\b/i;

// Without a repository's manifest: the guard's defaults and the files `factory render` generates everywhere.
export const GUARDED_DEFAULT = [...PROTECTED_DEFAULT, '.claude/settings.json', '.claude/agents', '.github/agents', '.github/workflows', '.github/actions/setup-factory', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json', '.codex', '.gemini/settings.json', '.cursor/rules/factory.mdc', '.github/CODEOWNERS'];
const DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'each', 'every', 'any', 'your', 'its', 'their', 'whose', 'which']);

const isPlaceholder = (p) => /[<{*]/.test(p);
const inside = (child, parent) => child === parent || child.startsWith(`${parent}/`);

// Sentences of a text: wrapped lines of one paragraph or list item are joined, then split at sentence ends.
function sentences(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let buf = [];
  let start = 0;
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join(' ');
    for (const sentence of joined.split(/(?<=[.!?])\s+(?=[A-Z`*(-])/)) {
      // Clauses after a semicolon are judged on their own, but remember the clause before them ("X lives in
      // <path>; keep it current" tells the agent to change <path>).
      sentence.split(/(?<=;)\s+/).forEach((clause, k) => {
        if (clause.trim()) out.push({ text: clause, line: start + 1, afterSemicolon: k > 0 });
      });
    }
    buf = [];
  };
  lines.forEach((line, i) => {
    // Code comments: the comment marker is not text, and a bare marker line ends a paragraph.
    const t = line.trim().replace(/^(\/\/+|\/\*+|\*+\/?|<!--|-->)\s?/, '').trim();
    const item = /^([-*+]|\d+[.)]|#+|\|)\s/.test(t);
    if (!t || item || /^```/.test(t)) flush();
    if (!t) return;
    if (!buf.length) start = i;
    buf.push(t);
  });
  flush();
  return out;
}

// The write cues of a sentence that are not negated and not a descriptive passive ("are declared in").
function writeCues(sentence) {
  const words = sentence.toLowerCase().replace(/[`'"()[\],:;]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.replace(/\.+$/, ''));
  const cues = [];
  let negated = 0;
  words.forEach((w, i) => {
    if (!WRITE_STEM.test(w) || w.includes('/') || w.includes('.')) return;
    // A noun after an article or determiner ("a change", "the settings") is not an instruction.
    if (DETERMINERS.has(words[i - 1])) return;
    const before = words.slice(Math.max(0, i - 3), i);
    const n = before.findIndex((x) => NEGATIONS.has(x));
    if (n >= 0 && !before.slice(n + 1).some((x) => NOT_REALLY.has(x))) {
      negated += 1;
      return;
    }
    // "X is/are declared in Y" describes where something is; "must be updated" is an instruction.
    if (/ed$/.test(w) && ['is', 'are', 'was', 'were', 'been'].includes(words[i - 1]) && !['must', 'should', 'needs', 'need', 'has', 'have', 'to'].some((m) => words.slice(Math.max(0, i - 4), i).includes(m))) return;
    cues.push(w);
  });
  // "keep X current / up to date / in sync" is an instruction to change X.
  const keep = /\bkeep\b[^.;]{0,40}\b(current|up to date|up-to-date|in sync|fresh|accurate)\b/i.exec(sentence);
  if (keep && !words.slice(Math.max(0, words.indexOf('keep') - 3), words.indexOf('keep')).some((x) => NEGATIONS.has(x))) cues.push('keep current');
  return { cues, negated, read: words.some((w) => READ_CUE.test(w)), words };
}

// Spelling a path differently does not hide it: backslashes (`.factory\\policy`) and a missing leading dot
// (`factory/policy/...`) name the same file.
const canonicalPaths = (sentence) => sentence
  .replace(/(?<=[\w.*}>-])\\(?=[\w.*{<-])/g, '/')
  .replace(/(?<![\w./-])(factory|claude|github|codex|gemini|cursor)\/(?=[\w*{<])/g, '.$1/');

// "Follow the patterns in <path> when you add an endpoint": a read cue on the path, and every write cue inside a
// clause that starts after it with when/if/before/after/while/once/whenever (its object is something else).
function writesOnlyInLaterClause(sentence, pathText) {
  const lower = sentence.toLowerCase();
  const at = lower.indexOf(pathText.toLowerCase());
  if (at < 0) return false;
  const sub = /\b(when|whenever|if|before|after|while|once)\b/g;
  sub.lastIndex = at + pathText.length;
  const m = sub.exec(lower);
  if (!m) return false;
  const head = sentence.slice(0, m.index);
  const tail = sentence.slice(m.index);
  const before = writeCues(head);
  return before.cues.length === 0 && before.read && ![...tail.matchAll(PATH_RE)].length;
}

/** Problems in one text: [{ line, problem }]. `guarded`: the paths the reading agent may not write. */
export function textProblems(text, { guarded = GUARDED_DEFAULT, root = null, topologyOnly = false } = {}) {
  const problems = [];
  let previousHits = [];
  for (const { text: raw, line, afterSemicolon } of sentences(text)) {
    const sentence = canonicalPaths(raw);
    if (!afterSemicolon) previousHits = [];
    const quote = `"${sentence.trim().slice(0, 160)}"`;
    if (sentence.includes(OVERLAY_FILE) && TOPOLOGY_RE.test(sentence) && !sentence.includes(APP_FILE) && !/\b(never|not)\b[^.]{0,40}\bin `?\.factory\/config\.json/i.test(sentence)) {
      problems.push({ line, problem: `places ${TOPOLOGY_RE.exec(sentence)[1]} in ${OVERLAY_FILE}; the application's topology is in ${APP_FILE} (the agents may edit it, config.json is denied to them): ${quote}` });
      continue;
    }
    // The code host, tracker and CI settings are governance: an instruction to put them in app.json is wrong.
    if (sentence.includes(APP_FILE) && GOVERNANCE_RE.test(sentence)) {
      const { cues: govCues } = writeCues(sentence);
      if (govCues.length) {
        problems.push({ line, problem: `places ${GOVERNANCE_RE.exec(sentence)[0]} in ${APP_FILE}; the code host, tracker and CI settings are governance in ${OVERLAY_FILE} (people change them): ${quote}` });
        continue;
      }
    }
    if (topologyOnly || MARKED.test(sentence)) continue;
    // A path run as a command (`node .factory/bin/factory.mjs teststack publish`) is executed, not written.
    const mentions = [...sentence.matchAll(PATH_RE)].filter((m) => !/(node|bash|sh|python3?)\s+$/.test(sentence.slice(0, m.index + m[0].indexOf(m[1])))).map((m) => m[1].replace(/^\.\//, '').replace(/[.,;:]+$/, ''));
    const hits = mentions.filter((rel) => rel !== APP_FILE && !inside(rel, '.factory/stack') && !inside(rel, '.factory/state') && guarded.some((g) => inside(rel, g) || (isPlaceholder(rel) && inside(g, rel.replace(/\/[^/]*[<{*].*$/, '')))));
    let { cues, negated, read } = writeCues(sentence);
    if (hits.length && cues.length && read && writesOnlyInLaterClause(sentence, mentions.find((m) => hits.includes(m)) ?? hits[0])) cues = [];
    // A clause after a semicolon that tells the agent to change something, and names no path, continues the clause before.
    if (!hits.length && !mentions.length && afterSemicolon && cues.length && previousHits.length) {
      problems.push({ line, problem: `tells the agent to change (${cues.join(', ')}) ${previousHits[0]}, named before the semicolon, which the factory guard denies to it; say where to read it, forbid it, or mark the sentence (read-only): ${quote}` });
      continue;
    }
    // A prohibition before the semicolon ("Never edit X; report what should change") is not continued.
    if (hits.length) previousHits = negated ? [] : hits;
    if (hits.length) {
      const harmless = !cues.length && (negated > 0 || read || OWNERSHIP.test(sentence) || /\b(is|are|lives?|kept|stored)\b/i.test(sentence));
      if (!harmless) {
        problems.push({ line, problem: `${cues.length ? `tells the agent to change (${cues.join(', ')})` : 'names'} ${hits[0]}, which the factory guard denies to it; say where to read it, forbid it, or mark the sentence (read-only) (topology goes in ${APP_FILE}; anything else is reported in the result): ${quote}` });
        continue;
      }
    }
    if (root && cues.length) {
      const missing = mentions.find((rel) => rel.startsWith('.factory/') && !isPlaceholder(rel) && !fs.existsSync(path.join(root, rel)));
      if (missing) problems.push({ line, problem: `tells the agent to change ${missing}, which does not exist in this repository: ${quote}` });
    }
  }
  return problems;
}

// The paths the agents of a repository may not write: the guard's protected paths and every generated file.
const guardedFor = (config) => [...(config.factoryGuard?.protected ?? PROTECTED_DEFAULT), ...manifestPaths(config)];

/** Problems in the prompts of every agent the repository can run (definition, addendum, lessons). */
export function promptProblems(config) {
  const guarded = guardedFor(config);
  const names = new Set();
  for (const dir of [path.join(config.root, config.agentsDir), path.join(INSTALL_ROOT, 'agents')]) {
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.agent.md')) names.add(f.replace(/\.agent\.md$/, ''));
  }
  // The agents the guard lets write the factory's files (the retro) may be told to.
  const writers = new Set(config.factoryGuard?.writers ?? WRITERS_DEFAULT);
  const out = [];
  for (const name of [...names].sort().filter((n) => !writers.has(n))) {
    let def;
    try {
      def = agentDefinition(config, name);
    } catch {
      continue;
    }
    // What the agent reads: the addendum without the comments meant for the person who fills it in.
    for (const [label, file, text] of [['addendum', def.sources.addendum, def.sources.addendum && addendumText(fs.readFileSync(def.sources.addendum, 'utf8'))], ['lessons', def.sources.lessons, def.lessons], ['definition', def.sources.base, fs.readFileSync(def.sources.base, 'utf8')]]) {
      if (!text) continue;
      const repoText = file?.startsWith(config.root);
      for (const p of textProblems(text, { guarded, root: repoText ? config.root : null })) out.push({ path: `${repoText ? path.relative(config.root, file) : `(factory) ${path.relative(INSTALL_ROOT, file)}`}:${p.line}`, agent: name, source: label, problem: p.problem });
    }
  }
  return out;
}

// Every string in a parsed YAML document, with a label of where it is.
function strings(node, label, out = []) {
  if (typeof node === 'string') out.push([label, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${label}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) strings(v, label ? `${label}.${k}` : k, out);
  return out;
}

/** Every string of the policy's rules, patterns and validator registry, rendered as the engine renders them. */
export function policyTextProblems(config, policyDir = '.factory/policy') {
  const dir = path.join(config.root, policyDir);
  if (!fs.existsSync(path.join(dir, 'policy.yaml'))) return [];
  let manifest = {};
  try {
    manifest = parse(fs.readFileSync(path.join(dir, 'policy.yaml'), 'utf8')) ?? {};
  } catch {
    return [];
  }
  const profile = path.posix.join(policyDir, manifest.profile_file ?? (manifest.default_profile ? `profiles/${manifest.default_profile}/profile.yaml` : 'profile.yaml'));
  const topology = path.posix.normalize(path.posix.join(policyDir, manifest.topology_file ?? '../app.json'));
  const render = (s) => s.replace(/\{profile_file\}/g, profile).replace(/\{topology_file\}/g, topology);
  const registry = path.posix.join(policyDir, manifest.validators?.registry ?? 'validators/registry.yaml');
  // The profile and the exceptions too: agents are told to read the profile, and a justification is prose.
  const files = [...['rules', 'patterns', 'exceptions'].flatMap((sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.posix.join(policyDir, sub, f)) : [])), registry, profile, path.posix.join(policyDir, 'policy.yaml')];
  const out = [];
  for (const rel of files) {
    let doc;
    let text;
    try {
      text = fs.readFileSync(path.join(config.root, rel), 'utf8');
      doc = parse(text);
    } catch {
      continue;
    }
    // YAML comments are read by an agent that opens the file.
    const comments = text.split('\n').map((l, i) => [i + 1, /(?:^|\s)#\s?(.*)$/.exec(l)?.[1]]).filter(([, c]) => c && c.trim());
    for (const [n, c] of comments) for (const p of textProblems(render(c), { guarded: guardedFor(config), root: null })) out.push({ path: `${rel}:${n} (comment)`, agent: 'any agent (reads the policy)', source: 'policy', problem: p.problem });
    // Data that is not prose (globs, regexes, ids) has no sentence with a cue; every string is read.
    for (const [label, s] of strings(doc, '')) {
      if (/(^|\.)(include|exclude|regex|pattern|globs?|paths?|id|ids|file|implementation|checkpoints|severity|status|version|kind|type|mode)(\[\d+\])?$/.test(label)) continue;
      if (!/\s/.test(s.trim())) continue; // a value (a glob, a path, a name), not prose
      for (const p of textProblems(render(s), { guarded: guardedFor(config), root: config.root })) out.push({ path: `${rel} (${label})`, agent: 'any agent (a policy finding)', source: 'policy', problem: p.problem });
    }
  }
  return out;
}

// Files every agent session reads or extends: the root instruction files (whole, not only the factory's block),
// the repository's skills, and the e2e tree and test-stack config the factory's skills copy into it.
function agentFacingFiles(root) {
  const out = [];
  const add = (rel) => {
    if (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()) out.push(rel);
  };
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', 'playwright.teststack.config.ts', 'playwright.config.ts']) add(f);
  const walk = (dir, keep) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) walk(rel, keep);
      else if (keep(rel)) out.push(rel);
    }
  };
  walk('.cursor/rules', (f) => /\.(md|mdc)$/.test(f));
  for (const dir of ['.claude/skills', '.github/skills', '.agents/skills']) walk(dir, (f) => /\.md$/.test(f));
  walk('e2e', (f) => /\.(ts|js|mjs|cjs)$/.test(f));
  // Notes in the test tree (tests/README.md and the like) are read by the agents that write tests.
  for (const dir of ['tests', 'test']) walk(dir, (f) => /\.md$/i.test(f));
  return out;
}

export function helperProblems(config) {
  const out = [];
  // app.json: the agents edit it, so its prose ($comment and any other string) is read.
  const app = path.join(config.root, APP_FILE);
  if (fs.existsSync(app)) {
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(app, 'utf8'));
    } catch {
      /* reported by the settings check */
    }
    for (const [label, str] of strings(doc, '')) {
      if (!/\s/.test(str.trim())) continue; // a value (a path, a URL, a name), not prose
      for (const p of textProblems(str, { guarded: guardedFor(config), root: config.root })) out.push({ path: `${APP_FILE} (${label})`, agent: 'any agent', source: 'helper', problem: p.problem });
    }
  }
  for (const rel of agentFacingFiles(config.root)) {
    for (const p of textProblems(fs.readFileSync(path.join(config.root, rel), 'utf8'), { guarded: guardedFor(config), root: config.root })) out.push({ path: `${rel}:${p.line}`, agent: 'any agent', source: 'helper', problem: p.problem });
  }
  return out;
}

/** Everything a repository's agents read, checked. */
export function agentTextProblems(config) {
  return [...promptProblems(config), ...policyTextProblems(config), ...helperProblems(config)];
}
