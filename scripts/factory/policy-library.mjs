#!/usr/bin/env node
// `factory policy-library`: the rule libraries the language packs ship (packs/<id>/policy/), and adding
// them to a repository's architecture policy (.factory/policy). A library holds rules, validators and
// patterns proven on a real codebase of that stack, written against the profile vocabulary (project
// types, layers, service traits) instead of paths. The author-architecture-policy skill adds a library,
// then tunes it (profile, globs marked TUNE) and dry-runs it on the repository's history.
//
//   factory policy-library list [<pack>]
//   factory policy-library add <pack> [--rules ID,ID...] [--dir .factory/policy] [--dry-run]
//
// `add` edits the policy files as text, so the repository's comments and formatting survive:
// - a rule whose ID the policy already has is left alone (reported);
// - a missing category gets its line in policy.yaml and its rules file;
// - a validator the policy lacks is appended to validators/registry.yaml. A library validator marked
//   `replaces_starter: true` replaces the policy's validator of the same ID only while that one is still
//   exactly the starter's (templates/policy), so a repository's own tuning is never overwritten;
// - referenced patterns are copied when missing.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { INSTALL_ROOT, repoRoot } from '../pipeline/lib/config.mjs';

const isDeepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Top-level list items of `key:` in a YAML document, as text blocks with their id.
export function listBlocks(text, key) {
  const start = text.search(new RegExp(`^${key}:\\s*$`, 'm'));
  if (start < 0) return { head: text, blocks: [] };
  const bodyStart = text.indexOf('\n', start) + 1;
  const head = text.slice(0, bodyStart);
  const parts = text.slice(bodyStart).split(/\n(?=  - id: )/);
  const blocks = [];
  let preamble = '';
  for (const part of parts) {
    const m = /^\s*- id: (\S+)/.exec(part);
    if (m) blocks.push({ id: m[1], text: part.replace(/\s+$/, '') });
    else preamble += part;
  }
  return { head: head + preamble, blocks };
}

export function libraries(installRoot = INSTALL_ROOT) {
  const dir = path.join(installRoot, 'packs');
  return fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(dir, id, 'policy', 'categories.yaml'))).map((id) => loadLibrary(path.join(dir, id, 'policy'), id));
}

export function loadLibrary(dir, id = path.basename(path.dirname(dir))) {
  const { categories, replacesStarterValidators = [], replacesStarterRules = [] } = parse(fs.readFileSync(path.join(dir, 'categories.yaml'), 'utf8'));
  const rules = [];
  for (const category of categories) {
    const text = fs.readFileSync(path.join(dir, category.file), 'utf8');
    const parsed = parse(text);
    const { head, blocks } = listBlocks(text, 'rules');
    for (const block of blocks) rules.push({ ...block, category, rule: parsed.rules.find((r) => r.id === block.id), fileHead: head });
  }
  const vtext = fs.readFileSync(path.join(dir, 'validators.yaml'), 'utf8');
  const vparsed = parse(vtext).validators;
  const validators = listBlocks(vtext, 'validators').blocks.map((b) => ({ ...b, validator: vparsed.find((v) => v.id === b.id) }));
  const patterns = fs.readdirSync(path.join(dir, 'patterns')).map((f) => ({ file: f, pattern: parse(fs.readFileSync(path.join(dir, 'patterns', f), 'utf8')), text: fs.readFileSync(path.join(dir, 'patterns', f), 'utf8') }));
  return { id, dir, categories, rules, validators, patterns, replacesStarterValidators, replacesStarterRules };
}

function starterRuleOf(installRoot, id) {
  const dir = path.join(installRoot, 'templates/policy/rules');
  for (const f of fs.readdirSync(dir)) {
    const rule = parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.rules?.find((r) => r.id === id);
    if (rule) return rule;
  }
  return null;
}

function readPolicy(dir) {
  const manifest = parse(fs.readFileSync(path.join(dir, 'policy.yaml'), 'utf8'));
  const ruleIds = new Set();
  for (const c of manifest.categories ?? []) {
    const f = path.join(dir, c.file);
    if (fs.existsSync(f)) for (const r of parse(fs.readFileSync(f, 'utf8'))?.rules ?? []) ruleIds.add(r.id);
  }
  const registryFile = path.join(dir, 'validators/registry.yaml');
  const registryText = fs.readFileSync(registryFile, 'utf8');
  const validators = parse(registryText)?.validators ?? [];
  const patternIds = new Set();
  const pdir = path.join(dir, 'patterns');
  if (fs.existsSync(pdir)) for (const f of fs.readdirSync(pdir)) patternIds.add(parse(fs.readFileSync(path.join(pdir, f), 'utf8'))?.id);
  return { manifest, ruleIds, registryFile, registryText, validators, patternIds };
}

export function addLibrary(lib, dir, { rules: only = null, dryRun = false, installRoot = INSTALL_ROOT } = {}) {
  const policy = readPolicy(dir);
  const starterRegistry = parse(fs.readFileSync(path.join(installRoot, 'templates/policy/validators/registry.yaml'), 'utf8')).validators;
  const report = { added: [], kept: [], replacedRules: [], categories: [], validators: [], replaced: [], tunedKept: [], patterns: [] };
  const selected = lib.rules.filter((r) => !only || only.includes(r.id));
  const unknown = (only ?? []).filter((id) => !lib.rules.some((r) => r.id === id));
  if (unknown.length) throw new Error(`not in the ${lib.id} library: ${unknown.join(', ')}`);
  const writes = new Map();
  const read = (f) => (writes.has(f) ? writes.get(f) : fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

  let manifestText = read(path.join(dir, 'policy.yaml'));
  const neededValidators = new Set();
  const neededPatterns = new Set();
  for (const r of selected) {
    if (policy.ruleIds.has(r.id)) {
      // A library rule may replace the starter's rule of the same ID, only while that one is untouched.
      const starterRule = lib.replacesStarterRules.includes(r.id) && starterRuleOf(installRoot, r.id);
      const category = (policy.manifest.categories ?? []).find((c) => c.prefix === r.category.prefix);
      const file = category && path.join(dir, category.file);
      const current = file && read(file);
      const block = current && listBlocks(current, 'rules').blocks.find((b) => b.id === r.id);
      if (starterRule && block && isDeepEqual(parse(current).rules.find((x) => x.id === r.id), starterRule)) {
        writes.set(file, current.replace(block.text, r.text));
        report.replacedRules.push(r.id);
        for (const v of r.rule.validation?.validators ?? []) neededValidators.add(v);
        for (const p of r.rule.patterns ?? []) neededPatterns.add(p);
      } else report.kept.push(r.id);
      continue;
    }
    let category = (policy.manifest.categories ?? []).find((c) => c.id === r.category.id || c.prefix === r.category.prefix);
    if (!category) {
      category = r.category;
      const line = `  - { id: ${category.id}, prefix: ${category.prefix}, file: ${category.file} }`;
      manifestText = manifestText.replace(/(^categories:\s*\n(?: {2}- .*\n)*)/m, (block) => `${block}${line}\n`);
      policy.manifest.categories = [...(policy.manifest.categories ?? []), category];
      report.categories.push(category.id);
    }
    const file = path.join(dir, category.file);
    const current = read(file) ?? `${r.fileHead.replace(/\s+$/, '')}\n`;
    writes.set(file, `${current.replace(/\s+$/, '')}\n\n${r.text}\n`);
    report.added.push(r.id);
    for (const v of r.rule.validation?.validators ?? []) neededValidators.add(v);
    for (const p of r.rule.patterns ?? []) neededPatterns.add(p);
  }
  if (report.categories.length) writes.set(path.join(dir, 'policy.yaml'), manifestText);

  let registry = read(policy.registryFile);
  for (const v of lib.validators) {
    const existing = policy.validators.find((x) => x.id === v.id);
    if (lib.replacesStarterValidators.includes(v.id) && existing) {
      const starter = starterRegistry.find((x) => x.id === v.id);
      if (starter && isDeepEqual(starter, existing)) {
        const { blocks } = listBlocks(registry, 'validators');
        const old = blocks.find((b) => b.id === v.id);
        registry = registry.replace(old.text, v.text);
        report.replaced.push(v.id);
      } else report.tunedKept.push(v.id);
      continue;
    }
    if (!neededValidators.has(v.id) || existing) continue;
    registry = `${registry.replace(/\s+$/, '')}\n\n${v.text}\n`;
    report.validators.push(v.id);
  }
  writes.set(policy.registryFile, registry);

  // Rules and patterns list each other (selfcheck checks both directions).
  const finalRules = new Set([...policy.ruleIds, ...report.added]);
  const ruleFile = (id) => {
    for (const c of policy.manifest.categories ?? []) {
      const f = path.join(dir, c.file);
      const t = read(f);
      if (t && new RegExp(`^  - id: ${id}\\s*$`, 'm').test(t)) return f;
    }
    return null;
  };
  const addPatternToRule = (ruleId, patternId) => {
    const f = ruleFile(ruleId);
    if (!f) return;
    const t = read(f);
    const { blocks } = listBlocks(t, 'rules');
    const b = blocks.find((x) => x.id === ruleId);
    const updated = b.text.replace(/^(    patterns: \[)([^\]]*)\]/m, (all, open, list) => (list.split(',').map((x) => x.trim()).includes(patternId) ? all : `${open}${list.trim() ? `${list.trim()}, ` : ''}${patternId}]`));
    writes.set(f, t.replace(b.text, updated));
  };
  for (const p of lib.patterns) {
    if (!neededPatterns.has(p.pattern.id) || policy.patternIds.has(p.pattern.id)) continue;
    // Keep only rules the policy has; existing ones get the pattern added to their `patterns`.
    const keep = (p.pattern.rules ?? []).filter((id) => finalRules.has(id));
    let text = p.text.replace(/^rules:\n(?:- .*\n)*/m, `rules:\n${keep.map((id) => `- ${id}`).join('\n')}\n`);
    for (const id of keep) if (!report.added.includes(id)) addPatternToRule(id, p.pattern.id);
    writes.set(path.join(dir, 'patterns', p.file), text);
    report.patterns.push(p.pattern.id);
  }
  // An added rule that names a pattern the policy already had: that pattern lists the rule back.
  const pdir = path.join(dir, 'patterns');
  for (const f of fs.existsSync(pdir) ? fs.readdirSync(pdir) : []) {
    const file = path.join(pdir, f);
    if (writes.has(file)) continue;
    const t = read(file);
    const pat = parse(t);
    const back = report.added.filter((id) => (lib.rules.find((r) => r.id === id)?.rule.patterns ?? []).includes(pat.id) && !(pat.rules ?? []).includes(id));
    if (back.length) writes.set(file, t.replace(/^rules:\n((?:- .*\n)*)/m, (all, list) => `rules:\n${list}${back.map((id) => `- ${id}`).join('\n')}\n`));
  }
  if (!dryRun) {
    for (const [f, text] of writes) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
  }
  return report;
}

function main(argv) {
  const [command, packId, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i < 0 ? undefined : rest[i + 1];
  };
  const libs = libraries();
  if (command === 'list') {
    for (const lib of libs.filter((l) => !packId || l.id === packId)) {
      console.log(`${lib.id}: ${lib.rules.length} rules, ${lib.validators.length} validators, ${lib.patterns.length} patterns (${path.relative(INSTALL_ROOT, lib.dir)}/README.md)`);
      for (const r of lib.rules) {
        const enf = Object.entries(r.rule.checkpoints ?? {}).filter(([, c]) => c.enabled).map(([k, c]) => `${k}:${c.enforcement}`).join(' ');
        console.log(`  ${r.id.padEnd(9)} ${r.rule.severity.padEnd(8)} ${r.rule.validation.mode.padEnd(13)} ${r.rule.title}  [${enf}]`);
      }
    }
    if (!libs.length) console.log('No language pack ships a policy library.');
    return 0;
  }
  if (command === 'add') {
    const lib = libs.find((l) => l.id === packId);
    if (!lib) {
      console.error(`No policy library in pack "${packId}". Libraries: ${libs.map((l) => l.id).join(', ') || 'none'}.`);
      return 64;
    }
    const dir = path.resolve(repoRoot(), flag('dir') ?? '.factory/policy');
    if (!fs.existsSync(path.join(dir, 'policy.yaml'))) {
      console.error(`${dir} has no policy.yaml: run \`factory init\` (it copies the starter policy) first.`);
      return 1;
    }
    const only = flag('rules') ? flag('rules').split(',').map((s) => s.trim()).filter(Boolean) : null;
    const r = addLibrary(lib, dir, { rules: only, dryRun: rest.includes('--dry-run') });
    const say = (label, list) => list.length && console.log(`${label}: ${list.join(', ')}`);
    say(rest.includes('--dry-run') ? 'Would add rules' : 'Added rules', r.added);
    say('Replaced starter rules with the library version', r.replacedRules);
    say('Kept (the policy already has these IDs)', r.kept);
    say('New categories', r.categories);
    say('Added validators', r.validators);
    say('Replaced starter validators with the library version', r.replaced);
    say('Kept your tuned validators (not the starter any more)', r.tunedKept);
    say('Added patterns', r.patterns);
    console.log('\nNext (author-architecture-policy skill): classify projects in profile.yaml with the library\'s vocabulary, tune every line marked TUNE, then `arch.py selfcheck` and the dry run on merged history.');
    return 0;
  }
  console.error('Usage: factory policy-library list [<pack>] | add <pack> [--rules ID,ID...] [--dir .factory/policy] [--dry-run]');
  return 64;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`policy-library: ${error.message}`);
    process.exitCode = 1;
  }
}
