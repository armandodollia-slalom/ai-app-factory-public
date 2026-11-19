// `factory init`: the draft .factory/config.json and the starter content of .factory/.
import fs from 'node:fs';
import path from 'node:path';
import { deepMerge } from '../../pipeline/lib/config.mjs';
import { draftProject } from './detect.mjs';
import { CI_FOR_HOST, TOKEN_VARS } from './hosting.mjs';

// Each pack part (lsp.json, tests.json, commands.json, stack.json) may carry a `config` object: the
// overlay fragment a repository of that language starts from. Fragments merge in pack order; lists
// concatenate (two languages contribute two language servers and two test runners).
export function mergeFragments(base, fragment) {
  const out = { ...base };
  for (const [key, value] of Object.entries(fragment ?? {})) {
    if (Array.isArray(value) && Array.isArray(out[key])) out[key] = [...out[key], ...value.filter((v) => !out[key].some((o) => JSON.stringify(o) === JSON.stringify(v)))];
    else if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) out[key] = mergeFragments(out[key], value);
    else out[key] = value;
  }
  return out;
}

export function draftConfig(found, packs, { features = {} } = {}) {
  const project = draftProject(found, packs);
  const used = packs.filter((p) => project.languages.includes(p.id));
  let config = {
    $comment: "This repository's factory settings. Everything here overrides the engine defaults (docs/configuration.md in the factory). Drafted by `factory init` from file names: review it.",
    project,
  };
  for (const pack of used) {
    for (const part of ['commands', 'tests', ...(features.lsp === false ? [] : ['lsp']), 'stack']) config = mergeFragments(config, pack[part]?.config);
  }
  // The packs' default commands (commands.json): a starting point the onboarding corrects against CI.
  // A command whose tool the repository does not have (`requires`) is left out of the draft.
  const has = (pack, req) => {
    if (!req) return true;
    const lang = found.languages.find((l) => l.id === pack.id);
    if (req.rootFiles && !(lang?.topFiles ?? []).some((f) => req.rootFiles.some((g) => globRe(g).test(f)))) return false;
    if (req.manifest && !new RegExp(req.manifest).test(lang?.manifests ?? '')) return false;
    return true;
  };
  const withPacks = used.filter((p) => p.commands);
  if (withPacks.length) {
    const commands = withPacks.map((p) => p.commands);
    const prepare = commands.map((c) => c.prepare).filter(Boolean);
    const unit = commands.map((c) => c.unitTests).find(Boolean);
    const checks = withPacks.flatMap((p) => (p.commands.checks ?? []).filter((c) => has(p, c.requires)).map(({ requires, ...c }) => c));
    config = mergeFragments(config, {
      implement: { ...(prepare.length ? { prepareCmd: prepare.join(' && ') } : {}), checks, ...(unit ? { unitTests: { cmd: unit } } : {}) },
      precheck: {
        lint: Object.assign({}, ...withPacks.map((p) => (has(p, p.commands.lintRequires) ? p.commands.lint ?? {} : p.commands.lintFallback ?? {}))),
        fix: Object.assign({}, ...withPacks.map((p) => (has(p, p.commands.formatRequires) ? p.commands.format ?? {} : p.commands.formatFallback ?? {}))),
      },
    });
  }
  config = fillPlaceholders(config, found, used);
  config = mergeFragments(config, { implement: { reviewGate: draftReviewGate(found, used, project) } });
  // UI verifier pairs build and start the subtask's own worktree on their slot through this command.
  if (found.stack) config = mergeFragments(config, { implement: { ui: { teststackCmd: TESTSTACK_CMD } } });
  // A pack that can compare the test stack with the application's own composition (dotnet: the Aspire
  // AppHost) makes that a check every change passes: a service added to the app must reach the stack.
  // A pack whose stack is published from the host (dotnet: `aspire publish` of the AppHost) drafts that
  // publisher (stack.json `hostConfig`), so the compose file is generated, never hand-written.
  const hasHost = (project.services ?? []).some((s) => s.kind === 'host');
  if (hasHost) for (const p of withPacks) config = mergeFragments(config, p.stack?.hostConfig);
  if (found.stack && config.teststack?.commands?.drift && hasHost) {
    config.implement.checks = [...(config.implement.checks ?? []), { name: 'test stack matches the application (factory teststack drift)', cmd: 'node .factory/bin/factory.mjs teststack drift' }];
  }
  if (found.github) config = deepMerge({ tickets: { repo: found.github.repo }, board: { owner: found.github.owner, repo: found.github.repo } }, config);
  config = { ...config, ...draftProducts(found.host) };
  // What counts as implementation: everything but the tests, the factory's own folder and the code graph.
  config.implExclude = [...new Set(['.factory', 'graphify-out', ...project.testRoots.filter((d) => d !== '.'), ...(found.e2eDirs ?? []), ...found.e2e.map((f) => path.dirname(f)).filter((d) => d !== '.')])];
  return config;
}

// The code host, the tracker (when the host implies one) and the CI system, from the origin remote. GitHub
// keeps its existing keys (`tickets`, `board`) as the tracker settings. Tokens are `${NAME}` references,
// never values. Bitbucket has no board of its own the factory uses: `tracker` is left to the interview.
export function draftProducts(host) {
  if (!host) return {};
  const ci = { provider: CI_FOR_HOST[host.type] };
  if (host.type === 'github') return { host: { type: 'github', repo: host.repo }, ci };
  const drafted = { host: { type: host.type, url: host.url, repo: host.repo, token: `\${${TOKEN_VARS[host.type]}}` }, ci };
  if (host.guessed) drafted.host.$comment = 'Guessed from the origin remote of a self-hosted server: check type and url.';
  // GitLab issues in the same project are the default board (the interview asks to confirm).
  if (host.type === 'gitlab') drafted.tracker = { type: 'gitlab', project: host.repo, auth: { token: `\${${TOKEN_VARS.gitlab}}` }, ...(host.url && host.url !== 'https://gitlab.com' ? { url: host.url } : {}) };
  if (host.type === 'azure-devops') {
    const [organization, project] = host.repo.split('/');
    drafted.tracker = { type: 'azure-boards', url: `${host.url.replace(/\/+$/, '')}/${organization}`, project, auth: { token: `\${${TOKEN_VARS['azure-boards']}}` } };
  }
  return drafted;
}

const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

// The packs' generator placeholders (commands.json `placeholders`, e.g. {solution}): filled with the
// root file the CI workflows use, else the only candidate. Left as they are when that is ambiguous, so
// the onboarding (and `unfilledPlaceholders`) sees them.
export function fillPlaceholders(config, found, packs) {
  const values = {};
  for (const pack of packs) {
    for (const [name, spec] of Object.entries(pack.commands?.placeholders ?? {})) {
      const candidates = (found.languages.find((l) => l.id === pack.id)?.rootFiles ?? []).filter((f) => (spec?.candidates ?? []).some((g) => globRe(g).test(f)));
      const inCi = candidates.filter((f) => new RegExp(`(^|[\\s/"'=])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s"';])`, 'm').test(found.ciText ?? ''));
      const pick = inCi.length === 1 ? inCi[0] : candidates.length === 1 ? candidates[0] : null;
      if (pick) values[name] = pick;
    }
  }
  const walk = (v) => (typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (w, k) => values[k] ?? w) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(config);
}

// Generator placeholders still in a config (the packs' names only; {files}, {project} and the other
// run-time placeholders are the engine's).
export function unfilledPlaceholders(config, packs) {
  const names = new Set(packs.flatMap((p) => Object.keys(p.commands?.placeholders ?? {})));
  const left = new Set();
  JSON.stringify(config).replace(/\{(\w+)\}/g, (w, k) => (names.has(k) && left.add(k), w));
  return [...left];
}

// How the implement harness starts the test stack from a subtask worktree (resolved inside the worktree).
export const TESTSTACK_CMD = ['node', '.factory/bin/factory.mjs', 'teststack'];

// Services whose name says they handle identity, authentication or payments: a change to them always gets the
// review gate's High floor. A draft from names; the onboarding confirms it against the code.
const SENSITIVE = /(identity|auth|login|payment|billing|checkout|security|secret|vault)/i;

// The review gate's risk model, drafted so a sensitive or shared change can never auto-merge on low ratings
// alone: the engine's floor paths plus the packs' (schema migrations) and the sensitive services'; the
// packs' shared build files; the contract folders detect found (integration events).
export function draftReviewGate(found, packs, project, installRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')) {
  let engineFloor = [];
  try {
    engineFloor = JSON.parse(fs.readFileSync(path.join(installRoot, 'scripts/implement/config.json'), 'utf8')).implement.reviewGate.floor.paths;
  } catch {
    engineFloor = [];
  }
  const sensitive = (project.services ?? []).filter((s) => SENSITIVE.test(s.name)).flatMap((s) => s.paths);
  const floor = [...new Set([...engineFloor, ...packs.flatMap((p) => p.reviewGate?.floorPaths ?? []), ...sensitive])];
  const sharedPaths = Object.assign({}, ...packs.map((p) => p.reviewGate?.sharedPaths ?? {}));
  const contractPaths = Object.fromEntries((found.contracts ?? []).map((c) => [c.name, c.paths]));
  return { floor: { paths: floor }, ...(Object.keys(sharedPaths).length ? { sharedPaths } : {}), ...(Object.keys(contractPaths).length ? { contractPaths } : {}) };
}

function copyMissing(from, to, copied, label) {
  if (!fs.existsSync(from)) return;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyMissing(src, dst, copied, label);
    else if (!fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      if (!copied.includes(label)) copied.push(label);
    }
  }
}

// Starter content, copied only where the repository has nothing yet: addendum skeletons for the agents,
// the language-neutral starter policy, the base scenario of the test stack.
export function scaffold(root, installRoot, { features = {}, provider = 'github-actions' } = {}) {
  const copied = [];
  const t = (rel) => path.join(installRoot, 'templates', rel);
  copyMissing(t('agents'), path.join(root, '.factory/agents'), copied, '.factory/agents/ (addendum skeletons)');
  copyMissing(t('policy'), path.join(root, '.factory/policy'), copied, '.factory/policy/ (starter architecture policy)');
  copyMissing(t('stack'), path.join(root, '.factory/stack'), copied, '.factory/stack/ (base scenario)');
  // The one CI file that is the team's: how to install this codebase's toolchain on a runner.
  // GitHub Actions: an action; GitLab CI and Azure Pipelines: a shell script the jobs source.
  if (features.ci !== false && features.demoVideo) {
    if (provider === 'github-actions') copyMissing(t('toolchain'), path.join(root, '.github/actions/factory-toolchain'), copied, '.github/actions/factory-toolchain/ (yours to fill in)');
    else copyMissing(t('toolchain-sh'), path.join(root, '.factory/ci'), copied, '.factory/ci/toolchain.sh (yours to fill in)');
  }
  const lessons = path.join(root, '.factory/lessons');
  fs.mkdirSync(lessons, { recursive: true });
  if (!fs.readdirSync(lessons).length) fs.writeFileSync(path.join(lessons, '.gitkeep'), '');
  return copied;
}
