// The clean-code skill (GEN-15): one set of rules (`skills/clean-code/SKILL.md`, ids `CC-<n>` and the fixed `SCOPE`),
// examples from each language pack (`packs/<id>/clean-code.md`), and three depths of it:
// - `full`: every rule, for the orchestrators that guide writers and for the clean-code reviewer;
// - `writer`: the skill's short core plus the writer rule set, for the agents that write code or tests.
// The writer rule set is data: the repository's `<lessonsDir>/clean-code-writers.json` (pipeline-owned; the retro tunes
// it, GEN-27), else the starting set shipped beside the skill. It lists rule ids only: each rule's text stays in the
// skill. An agent's depth is its definition's `clean-code` front matter (`writer` or `full`); a run may ask for
// another (the implementer plans as the orchestrator).
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT, packsDir, setting } from './settings.mjs';
import { isMain, parseFrontMatter } from './util.mjs';
import { writeText } from './redact.mjs';

// An install's skills, the clean-code skill's folder and its file.
const skillsDir = (installRoot = INSTALL_ROOT) => path.join(installRoot, 'skills');
const skillFile = (installRoot = INSTALL_ROOT) => path.join(skillsDir(installRoot), 'clean-code', 'SKILL.md');
export const CLEAN_CODE_DIR = path.dirname(skillFile());
export const WRITER_RULES_FILE = 'clean-code-writers.json';
export const SCOPE_RULE = 'SCOPE';
// The council lens of the clean-code reviewer, and of the analysis tools whose reports are its evidence.
export const CLEAN_CODE_LENS = 'clean-code';
export const AUDIENCES = ['writer', 'full'];
const STARTING_SET = path.join(CLEAN_CODE_DIR, 'writer-rules.json');
const RULE_HEADING = /^### (CC-\d+|SCOPE) (.+)$/;

const readText = (file) => fs.readFileSync(file, 'utf8');
const sectionsOf = (body, level) => body.split(new RegExp(`^(?=${'#'.repeat(level)} )`, 'm'));
const titleOf = (section) => /^#+ (.+)$/m.exec(section)?.[1]?.trim() ?? '';
// Markdown headings `by` levels deeper, leaving code fences alone (a Python comment is not a heading).
export function deeperHeadings(text, by) {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^#{1,6} /.test(line) ? `${'#'.repeat(by)}${line}` : line;
  }).join('\n');
}

// `<!-- include: <skill> "<section>" list -->`: the first bullet list of that section of another installed skill, so a
// rule stated in two skills is written once (the useless-tests list is the council skill's). The skill file keeps a copy
// of the list up to `<!-- end include -->` for readers of the file itself (the plugin serves skills/ as they are);
// expandIncludes always puts the included skill's list in its place, and syncIncludes rewrites the copy
// (`node scripts/pipeline/lib/clean-code.mjs --write`; `--check` fails on a stale copy).
const INCLUDE = /^<!-- include: ([\w-]+) "([^"]+)" list -->\n(?:(?!<!-- include)[\s\S])*?<!-- end include -->$|^<!-- include: ([\w-]+) "([^"]+)" list -->$/gm;
function includedList(skillsDir, skill, heading) {
  const body = parseFrontMatter(readText(path.join(skillsDir, skill, 'SKILL.md'))).body;
  const section = sectionsOf(body, 2).find((s) => titleOf(s) === heading);
  const list = section && /(?:^- .*\n(?: {2}.*\n)*)+/m.exec(`${section}\n`)?.[0];
  if (!list) throw new Error(`clean-code skill: the ${skill} skill has no "${heading}" list to include`);
  return list.trimEnd();
}
export const expandIncludes = (text, dir = skillsDir()) => text.replace(INCLUDE, (...m) => includedList(dir, m[1] ?? m[3], m[2] ?? m[4]));

// The text with each include's copy brought up to date: the markers kept, the included list between them.
export const syncIncludes = (text, dir = skillsDir()) =>
  text.replace(INCLUDE, (...m) => `<!-- include: ${m[1] ?? m[3]} "${m[2] ?? m[4]}" list -->\n${includedList(dir, m[1] ?? m[3], m[2] ?? m[4])}\n<!-- end include -->`);

// The skill as written in an install: { data (front matter), head (the front matter as written), body (includes
// expanded) }.
export function skillSource(installRoot = INSTALL_ROOT) {
  const text = readText(skillFile(installRoot));
  const { data, body } = parseFrontMatter(text);
  return { data, head: text.slice(0, text.length - body.length), body: expandIncludes(body, skillsDir(installRoot)) };
}

// Every rule of the skill, in order: [{ id, title, text }] (`text` is the rule's own paragraphs, without its heading).
export function skillRules(body = skillSource().body) {
  const rules = [];
  for (const section of sectionsOf(body, 3)) {
    const m = RULE_HEADING.exec(section.split('\n')[0]);
    if (!m) continue;
    rules.push({ id: m[1], title: m[2].trim(), text: section.split('\n').slice(1).join('\n').split(/^## /m)[0].trim() });
  }
  return rules;
}

// A level-2 section of the skill by its title, without the heading.
const skillSection = (body, title) => sectionsOf(body, 2).find((s) => titleOf(s) === title)?.split('\n').slice(1).join('\n').trim() ?? '';

// The examples of the given language packs, each under its pack file's own title, rule headings one level down so they
// sit under the skill's `## Examples`. Packs without a `clean-code.md` add nothing.
export function languageExamples(languages = [], packs = packsDir()) {
  return [...new Set(languages)]
    .map((id) => path.join(packs, id, 'clean-code.md'))
    .filter((f) => fs.existsSync(f))
    .map((f) => deeperHeadings(readText(f).trim(), 2))
    .join('\n\n');
}

// The skill's body with the examples of `languages` in place of its closing note on examples.
function withExamples(body, languages, packsDir) {
  const examples = languageExamples(languages, packsDir);
  return body.replace(/^## Examples\n[\s\S]*$/m, examples ? `## Examples\n\n${examples}\n` : '');
}

// The skill with the examples of `languages`: what `factory render` installs in a repository, with the front matter kept.
export function installedSkill(languages = [], installRoot = INSTALL_ROOT) {
  const { head, body } = skillSource(installRoot);
  return `${head}${withExamples(body, languages, packsDir(installRoot))}`;
}

// The repository's writer rule set file (pipeline-owned, beside the lessons and the scorecard).
export const writerRulesPath = (config, root = config.root) => path.join(root, setting(config, 'lessonsDir'), WRITER_RULES_FILE);

// The ids of the rules writers carry: the repository's file when it exists, else the starting set. SCOPE is always in.
// An id the skill does not define is refused: the file is the pipeline's own, so an unknown id is a broken file.
export function writerRuleIds(config, { root = config?.root, known = skillRules() } = {}) {
  const file = root ? writerRulesPath(config, root) : null;
  const doc = JSON.parse(readText(file && fs.existsSync(file) ? file : STARTING_SET));
  const ids = Array.isArray(doc.rules) ? doc.rules.map(String) : [];
  const unknown = ids.filter((id) => !known.some((r) => r.id === id));
  if (unknown.length) throw new Error(`${file && fs.existsSync(file) ? file : STARTING_SET} names clean-code rules the skill does not define: ${unknown.join(', ')}`);
  return [...new Set([SCOPE_RULE, ...ids])];
}

export const ruleText = (r) => `### ${r.id} ${r.title}\n\n${r.text}`;

// The clean-code rule a finding cites: its `rule`, else the first rule id in its words. Null when it cites none.
const RULE_ID = /\b(CC-\d+|SCOPE)\b/;
export const ruleIdOf = (f) => RULE_ID.exec(String(f?.rule ?? ''))?.[1] ?? RULE_ID.exec(`${f?.text ?? ''} ${f?.title ?? ''} ${f?.issue ?? ''} ${f?.detail ?? ''}`)?.[1] ?? null;

// The instructions a writing agent carries: the short core and its rules, each by id.
export function writerText(config, { root = config?.root } = {}) {
  const { body } = skillSource();
  const rules = skillRules(body);
  const ids = writerRuleIds(config, { root, known: rules });
  return [
    '## Clean code (your core)',
    '',
    skillSection(body, 'The writer core'),
    '',
    '### Search before you add',
    '',
    skillSection(body, 'Search before you add'),
    '',
    'Your clean-code rules (cite them by id; the clean-code reviewer holds you to every rule of the skill):',
    '',
    ...ids.map((id) => ruleText(rules.find((r) => r.id === id))),
  ].join('\n\n').replace(/\n{3,}/g, '\n\n');
}

// The instructions of an orchestrator or the clean-code reviewer: every rule, with the repository's languages' examples.
export function fullText(config) {
  const body = withExamples(skillSource().body, setting(config, 'project.languages') ?? [], packsDir()).trim();
  return `## Clean code (the full rules)\n\n${deeperHeadings(body, 1)}`;
}

// The clean-code section of a prompt for an audience (`writer` or `full`), or '' for none.
export function cleanCodeSection(config, audience) {
  if (!audience) return '';
  if (!AUDIENCES.includes(audience)) throw new Error(`clean-code audience "${audience}" is not one of ${AUDIENCES.join(', ')}`);
  return audience === 'full' ? fullText(config) : writerText(config);
}

// ---------------------------------------------------------------------------------------------
// Guidance: what an orchestrator tells a writer about where a change goes and what to reuse
// ---------------------------------------------------------------------------------------------

// One item: { what, where: "<file>:<line>", do: "reuse" | "change" }. `reuse`: it already exists there; read it, never
// redefine it. `change`: the change goes there.
export const GUIDANCE_ACTIONS = ['reuse', 'change'];
const WHERE = /^[^\s:][^\s]*:\d+$/;
export const GUIDANCE_SHAPE = '"guidance": [{"what": "<the value, helper or behaviour>", "where": "<file>:<line> where it lives or where the change goes>", "do": "reuse" | "change"}]';

// Why a guidance list is not one (empty: it is). Missing is an empty list.
export function guidanceProblems(list, at = 'guidance') {
  if (list == null) return [];
  if (!Array.isArray(list)) return [`\`${at}\` must be a list`];
  return list.flatMap((g, i) => {
    if (!g || typeof g !== 'object') return [`\`${at}\` item ${i + 1} is not an object`];
    return [
      ...(typeof g.what === 'string' && g.what.trim() ? [] : [`\`${at}\` item ${i + 1}: \`what\` is required`]),
      ...(WHERE.test(String(g.where ?? '').trim()) ? [] : [`\`${at}\` item ${i + 1}: \`where\` must be a file and line (\`path/to/file.ext:42\`)`]),
      ...(GUIDANCE_ACTIONS.includes(g.do) ? [] : [`\`${at}\` item ${i + 1}: \`do\` must be one of ${GUIDANCE_ACTIONS.join(', ')}`]),
    ];
  });
}

export const normalizeGuidance = (list) => (Array.isArray(list) ? list.filter((g) => !guidanceProblems([g]).length).map((g) => ({ what: g.what.trim(), where: String(g.where).trim(), do: g.do })) : []);

// The guidance as a writer's task shows it (and the reviewer checks it against).
export function guidanceText(list) {
  const items = normalizeGuidance(list);
  if (!items.length) return '';
  return [
    '### Where to change and what to reuse (from the orchestrator)',
    '',
    'Reuse what is marked `reuse`: read it from where it lives and never write a second definition of it. A change that redefines one of these is a blocking clean-code finding.',
    '',
    ...items.map((g) => `- ${g.do === 'reuse' ? 'reuse' : 'change here'}: ${g.what} (\`${g.where}\`)`),
  ].join('\n');
}

// What a reviewer of the change is told of the guidance its writer worked to, so the clean-code seat can check it was
// followed: the writer's own section, as lines to add to the reviewer's task (none without guidance). Every stage's
// reviewers get it from here (the pair verifiers through the subtask spec, which carries the same section).
export function reviewerGuidance(list) {
  const text = guidanceText(list);
  return text ? ['', 'The writer of this change worked to this guidance from the stage\'s orchestrator; check it was followed (a change that redefines what it says to reuse is a finding).', '', text] : [];
}

// What an orchestrator is asked for when it hands work to a writer: the searches and the guidance field.
export function guidanceAsk() {
  return [
    'Before you hand the work out, search the codebase for what it touches that already exists: the sources of truth (setting defaults, constants, messages), the helpers and any copies. Use graphify (`graphify query`, `graphify explain`, `graphify path`) to find them and the language-server tools (`lsp_workspace_symbols`, `lsp_goto_definition`, `lsp_find_references`) to confirm each one and its callers; the harness records these calls.',
    `Then give the writer concrete guidance in ${GUIDANCE_SHAPE}: every existing value, helper or behaviour the work touches with \`do: "reuse"\` and its file and line, and where the change goes with \`do: "change"\`. An empty list says the work touches nothing that exists.`,
  ].join('\n\n');
}

// `--write` brings the clean-code skill's copies of included lists up to date; `--check` exits 1 when one is stale.
if (isMain(import.meta.url)) {
  const file = skillFile();
  const text = readText(file);
  const synced = syncIncludes(text);
  if (process.argv.includes('--write')) writeText(file, synced);
  else if (synced !== text) {
    process.stderr.write(`${file}: an included list is stale; run node scripts/pipeline/lib/clean-code.mjs --write\n`);
    process.exitCode = 1;
  }
}
