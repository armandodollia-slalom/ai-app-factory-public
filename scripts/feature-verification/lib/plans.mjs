import fs from 'node:fs';
import path from 'node:path';
import { fsReader } from '../../pipeline/lib/git.mjs';
import { caseIdsIn, storyMatches, ticketSha } from '../../pipeline/lib/stories.mjs';
import { ticketText } from '../../pipeline/lib/tickets.mjs';
import { parseFrontMatter, sha, stringifyFrontMatter } from '../../pipeline/lib/util.mjs';
import { isTestFile, testRoots, testRunners } from './runners.mjs';

export const INDEX = '_index.md';
const SECTIONS = ['Why', 'Preconditions', 'Steps', 'Expected result'];
const LAYERS = ['unit', 'functional', 'e2e'];

export function readPlan(config, story, reader = fsReader(config.root)) {
  const indexText = reader.read(`${story.planDir}/${INDEX}`);
  const index = indexText == null ? null : { text: indexText, ...parseFrontMatter(indexText) };
  const cases = reader
    .list(story.planDir)
    .filter((name) => name.startsWith('TC-') && name.endsWith('.md'))
    .map((name) => {
      const text = reader.read(`${story.planDir}/${name}`) ?? '';
      return { file: `${story.planDir}/${name}`, name, text, ...parseFrontMatter(text) };
    });
  return { index, cases };
}

export function planContentSha(plan) {
  const parts = plan.cases.map((c) => `${c.name}\n${c.text.replace(/\r\n/g, '\n')}`);
  parts.push(plan.index ? plan.index.body.replace(/\r\n/g, '\n') : '');
  return sha(parts.join('\n\u0000\n'));
}

// A case's title is its heading, `# <id>: <title>`. It is not repeated in the front matter: Markdown linters
// count a front-matter `title` as a second top-level heading (markdownlint MD025), so a repository that lints
// Markdown with the defaults could never commit a plan (dogfood step 5). An older plan's front-matter title
// is read when the heading has none.
export function caseTitle(c) {
  const heading = /^#\s+(.+?)\s*$/m.exec(c.body ?? '')?.[1] ?? '';
  const after = heading.replace(/^TC-[A-Z][A-Z0-9]*-\d+-\d+\s*:\s*/, '');
  return (after !== heading ? after : '') || (c.data?.title ? String(c.data.title) : '') || heading;
}

export function sectionBody(body, title) {
  const match = new RegExp(`^##\\s+${title}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi').exec(body);
  return match ? match[1].trim() : null;
}

// Why the plan agent wrote each case (decision log items): what it covers and its own "## Why".
export const caseDecisions = (plan) =>
  plan.cases.map((c) => ({
    case: c.data.id ?? c.name,
    title: caseTitle(c) || null,
    type: c.data.type ?? null,
    layer: c.data.layer ?? null,
    covers: Array.isArray(c.data.covers) ? c.data.covers : [c.data.covers].filter(Boolean),
    reason: sectionBody(c.body ?? '', 'Why')?.replace(/^\s*[-*]\s+/gm, '') ?? null,
  }));

// Deterministic structural checks that run before any verifier tokens are spent.
export function precheckPlan(config, story, reader = fsReader(config.root)) {
  const plan = readPlan(config, story, reader);
  const errors = [];
  if (!plan.index) errors.push(`${story.planDir}/${INDEX} is missing.`);
  if (plan.cases.length === 0) errors.push(`No case files (TC-${story.key}-NN-<slug>.md) in ${story.planDir}.`);

  const seen = new Map();
  const idPattern = new RegExp(`^TC-${story.key}-\\d{2,}$`);
  for (const c of plan.cases) {
    const where = c.file;
    const id = c.data.id;
    if (!c.hasFrontMatter) errors.push(`${where}: missing front matter.`);
    if (!idPattern.test(String(id ?? ''))) errors.push(`${where}: id "${id ?? ''}" must look like TC-${story.key}-01.`);
    else if (!c.name.startsWith(`${id}-`) && c.name !== `${id}.md`) errors.push(`${where}: file name must start with its id ${id}.`);
    if (id && seen.has(id)) errors.push(`${where}: duplicate id ${id} (also in ${seen.get(id)}).`);
    if (id) seen.set(id, where);
    if (c.data.title !== undefined) errors.push(`${where}: remove \`title\` from the front matter; the title is the "# ${id ?? '<id>'}: <title>" heading (Markdown linters count a front-matter title as a second top-level heading, MD025).`);
    if (!caseTitle({ ...c, data: {} }).trim()) errors.push(`${where}: the "# <id>: <title>" heading has no title.`);
    if (!['happy', 'sad'].includes(c.data.type)) errors.push(`${where}: type must be happy or sad.`);
    if (c.data.type === 'sad' && !config.categories.sadPathSubtypes.includes(c.data['sad-path'])) {
      errors.push(`${where}: sad cases need sad-path: one of ${config.categories.sadPathSubtypes.join(', ')}.`);
    }
    const covers = Array.isArray(c.data.covers) ? c.data.covers : [c.data.covers].filter(Boolean);
    if (covers.length === 0) errors.push(`${where}: covers must list the story requirement(s) this case checks.`);
    if (!LAYERS.includes(c.data.layer)) errors.push(`${where}: layer must be one of ${LAYERS.join(', ')}.`);
    if (!/^#\s+\S/m.test(c.body)) errors.push(`${where}: body must start with a "# <id>: <title>" heading.`);
    for (const section of SECTIONS) {
      const content = sectionBody(c.body, section);
      if (content == null) errors.push(`${where}: missing "## ${section}" section.`);
      else if (!content) errors.push(`${where}: "## ${section}" is empty.`);
    }
  }

  const types = new Set(plan.cases.map((c) => c.data.type));
  if (plan.cases.length && !types.has('happy')) errors.push('The plan has no happy-path case.');
  // A story that states and implies no error outcome has no sad path to test: the plan says so under "## No sad path"
  // (the verifier judges the claim) instead of inventing one (council C9 proof run: the precheck demanded a sad case, the
  // council rejected the invented ones, and the planner went back and forth until the plan escalated).
  const noSad = plan.index ? sectionBody(plan.index.body, 'No sad path') : null;
  if (plan.cases.length && !types.has('sad') && !noSad) errors.push('The plan has no sad-path case. Add one only where the story states or directly implies an error outcome (an existing error the story keeps counts); if it states and implies none, say why under "## No sad path" in _index.md instead of inventing one.');

  if (plan.index) {
    const listed = caseIdsIn(plan.index.body, story.key);
    for (const id of seen.keys()) if (!listed.has(id)) errors.push(`${INDEX} does not list ${id}.`);
    for (const id of listed) if (!seen.has(id)) errors.push(`${INDEX} lists ${id} but no case file exists.`);
  }
  return { plan, errors };
}

// The story text always comes from the ticket cache (the board is the source of truth), whatever
// revision the plan files are read at.
export function planStatus(config, story, reader = fsReader(config.root)) {
  const storyText = ticketText(config, story);
  const plan = readPlan(config, story, reader);
  if (!plan.index || plan.cases.length === 0) return { state: 'missing', plan, reasons: ['no plan'] };
  const fm = plan.index.data;
  const reasons = [];
  if (storyText != null && !storyMatches(fm['story-sha'], storyText)) reasons.push('story changed since the plan was written');
  if (reasons.length) return { state: 'stale', plan, reasons };
  if (Number(fm['verified-score']) < config.loops.requiredScore) reasons.push('plan has not passed the verifier');
  else if (fm['plan-sha'] !== planContentSha(plan)) reasons.push('plan edited after verification');
  if (reasons.length) return { state: 'unverified', plan, reasons };
  return { state: 'verified', plan, reasons };
}

// Pipeline-owned front matter. Agents write the index body; the runner owns these fields.
export function stampIndex(config, story, fields) {
  const file = path.join(config.root, story.planDir, INDEX);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# Test plan: ${story.slug}\n`;
  const { data, body } = parseFrontMatter(text);
  const storyText = fs.readFileSync(path.join(config.root, story.file), 'utf8');
  const { 'story-file': _legacyFile, ...rest } = data;
  const next = {
    ...rest,
    story: story.key,
    ...(story.issue?.url ? { 'story-issue': story.issue.url } : {}),
    'story-sha': ticketSha(storyText),
    ...fields,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyFrontMatter(next, body));
}

// Agents often write table delimiter rows without spaces (`|----|----|`), which markdownlint's MD060
// rejects and `--fix` cannot repair, so the runner normalizes them to `| --- | --- |`.
export const tidyTableDelimiters = (text) =>
  text.replace(/^[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/gm, (row) => `| ${row.trim().slice(1, -1).split('|').map((cell) => cell.trim()).join(' | ')} |`);

// Formatting-only tidy of the plan files. A plan that was verified stays verified: only whitespace in
// table delimiter rows changed, so the runner re-stamps its plan-sha.
export function tidyPlan(config, story) {
  const before = readPlan(config, story);
  const verified = before.index != null && before.index.data['plan-sha'] === planContentSha(before);
  const files = [...(before.index ? [{ file: `${story.planDir}/${INDEX}`, text: before.index.text }] : []), ...before.cases];
  let changed = false;
  for (const { file, text } of files) {
    const next = tidyTableDelimiters(text);
    if (next === text) continue;
    fs.writeFileSync(path.join(config.root, file), next);
    changed = true;
  }
  if (changed && verified) {
    const sha = planContentSha(readPlan(config, story));
    const automated = before.index.data['automation-plan-sha'] === before.index.data['plan-sha'];
    stampIndex(config, story, { 'plan-sha': sha, ...(automated ? { 'automation-plan-sha': sha } : {}) });
  }
  return changed;
}

// Test files and scenario files that implement a story's cases. Which files count as tests and where they
// are looked for comes from the configuration (lib/runners.mjs: `testExtensions`, `testRoots`, else the
// test runners' `match` and `roots`).
export function automationFiles(config, story, reader = fsReader(config.root)) {
  const tests = new Map();
  const runners = testRunners(config);
  const seen = new Set();
  for (const root of testRoots(config, runners)) {
    for (const walked of reader.walk(root)) {
      const file = walked.replace(/^\.\//, '');
      if (seen.has(file)) continue;
      seen.add(file);
      if (file.startsWith(`${config.plansDir}/`)) continue;
      if (!isTestFile(config, file, runners)) continue;
      const text = reader.read(file) ?? '';
      if (!text.includes(`TC-${story.key}-`)) continue;
      const ids = caseIdsIn(text, story.key);
      if (ids.size) tests.set(file, ids);
    }
  }
  const scenarioDir = `${config.scenariosDir}/${story.scenario}`;
  const scenario = reader.walk(scenarioDir);
  return { tests, scenarioDir, scenario };
}

export function automationSha(config, story, reader = fsReader(config.root)) {
  const { tests, scenario } = automationFiles(config, story, reader);
  const files = [...tests.keys(), ...scenario].sort();
  if (files.length === 0) return '';
  return sha(files.map((f) => `${f}\n${(reader.read(f) ?? '').replace(/\r\n/g, '\n')}`).join('\n\u0000\n'));
}

export function automationStatus(config, story, reader = fsReader(config.root)) {
  const { tests } = automationFiles(config, story, reader);
  if (tests.size === 0) return { state: 'none', reasons: [] };
  const fm = readPlan(config, story, reader).index?.data ?? {};
  if (Number(fm['automation-score']) < config.loops.requiredScore || !fm['automation-sha']) {
    return { state: 'unverified', reasons: ['automated tests have not passed the verifier'] };
  }
  if (fm['automation-sha'] !== automationSha(config, story, reader)) {
    return { state: 'unverified', reasons: ['tests or scenario edited after verification'] };
  }
  if (fm['automation-plan-sha'] !== fm['plan-sha']) {
    return { state: 'unverified', reasons: ['plan changed since the tests were verified'] };
  }
  return { state: 'verified', reasons: [] };
}
