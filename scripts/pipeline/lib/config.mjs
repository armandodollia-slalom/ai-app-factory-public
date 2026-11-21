import fs from 'node:fs';
import { registerConfigSecrets } from './redact.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';
import { policyTopologyProblems } from './policy-topology.mjs';
import { councilProblems, envProblems } from './council-config.mjs';
import { configAnalysisProblems } from './analysis/config.mjs';
import { withAnalysisGate } from './analysis/ci.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PIPELINE_DIR = path.resolve(here, '..');
export const SCRIPTS_DIR = path.resolve(PIPELINE_DIR, '..');
export const INSTALL_ROOT = path.resolve(SCRIPTS_DIR, '..');

export function repoRoot(cwd = process.cwd()) {
  if (process.env.PIPELINE_ROOT) return path.resolve(process.env.PIPELINE_ROOT);
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.status !== 0) throw new Error('the AI pipeline must run inside a git repository');
  return result.stdout.trim();
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = isObject(value) && isObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

const readConfig = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

// The app repository's own settings: <root>/.factory/config.json. Everything the engine knows about the
// codebase it works on (project model, commands, paths, per-stage overrides) comes from this file; the
// config.json files beside the code hold only language-neutral defaults.
export const FACTORY_DIR = '.factory';
export const OVERLAY_FILE = `${FACTORY_DIR}/config.json`;
// Sections of the overlay that belong to tools with their own config loader, not to the stages.
const TOOL_SECTIONS = ['lsp', 'stack', 'teststack'];

// The application's topology: the services, how the test stack reaches them and when they are ready. It is
// the application's own description, so the agents that change the application may change it (a story that
// adds a service registers it here). Everything else (models, gates, review, policy, the guard, commands the
// engine runs) is governance and stays in config.json, which only people and the retro change. Only these
// keys may appear in app.json; anything else fails loading, and the factory guard reverts it after a run.
export const APP_FILE = `${FACTORY_DIR}/app.json`;
export const APP_KEYS = {
  project: ['services', 'frontendPaths', 'testRoots'],
  stack: ['ports', 'urls', 'baseUrl', 'env', 'services', 'rebuildAll', 'publishAppHost', 'publishOverrides'],
  teststack: ['services', 'stores', 'infrastructureServices', 'restartAfterLoad'],
  // New services for the architecture policy (policy-topology.mjs); a project's class is derived, never declared.
  policy: ['services'],
};
const APP_SUBKEYS = {};
// The products the factory acts on (code host, ticket tracker, CI system; docs/hosts-and-trackers.md) and
// their token references: governance, so they live in config.json (denied to agents), never in app.json.
export const GOVERNANCE_SECTIONS = ['host', 'tracker', 'ci'];

// Problems with an app.json document: keys outside the topology, or settings the engine acts on as code.
export function appSettingsProblems(doc, { profile = null, dirs = new Set(), root = null, policy = true } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['app.json must hold a JSON object'];
  for (const [section, value] of Object.entries(doc)) {
    if (section.startsWith('$')) continue;
    const allowed = APP_KEYS[section];
    if (!allowed && GOVERNANCE_SECTIONS.includes(section)) {
      problems.push(`"${section}" is governance (the code host, ticket tracker or CI system the factory acts on, and its tokens), not application topology; it belongs in ${OVERLAY_FILE}, which only people change`);
      continue;
    }
    if (!allowed) {
      problems.push(`"${section}" is not application topology (allowed: ${Object.keys(APP_KEYS).join(', ')}); it belongs in ${OVERLAY_FILE}`);
      continue;
    }
    // The policy section has its own rules (policy-topology.mjs).
    if (section === 'policy') continue;
    for (const [key, sub] of Object.entries(value ?? {})) {
      if (key.startsWith('$')) continue;
      if (section === 'teststack' && key === 'drift') {
        problems.push('"teststack.drift" was replaced: a published test stack declares its test-only overrides in stack.publishOverrides (setup-teststack skill; packs/dotnet/stack/aspire-publish.mjs), and drift.ignore is gone because the stack is published from the application itself');
        continue;
      }
      if (!allowed.includes(key)) problems.push(`"${section}.${key}" is not application topology (allowed in ${section}: ${allowed.join(', ')}); it belongs in ${OVERLAY_FILE}`);
      const subAllowed = APP_SUBKEYS[`${section}.${key}`];
      if (subAllowed && sub && typeof sub === 'object') for (const k of Object.keys(sub)) if (!subAllowed.includes(k)) problems.push(`"${section}.${key}.${k}" is not application topology; it belongs in ${OVERLAY_FILE}`);
    }
  }
  // New services for the architecture policy: checked against the profile and the manifest folders when they are
  // known (the guard and the post-run check pass them).
  // `policy: false` (loading the settings) leaves them to the policy engine, which reports them as TOPOLOGY-001.
  if (policy && doc.policy !== undefined) problems.push(...policyTopologyProblems(doc.policy, profile, dirs, { root }));
  // A service's build is code the engine runs: only the project and the image name come from the application.
  for (const [name, svc] of Object.entries(doc.stack?.services ?? {})) {
    if (svc && typeof svc === 'object') for (const k of Object.keys(svc)) if (!['project', 'image', 'inputs'].includes(k)) problems.push(`"stack.services.${name}.${k}" is not application topology`);
  }
  return problems;
}

function readJsonFile(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

// The repository's settings: config.json (governance and everything else) with app.json (topology) on top.
export function repoOverlay(root) {
  const config = readJsonFile(path.join(root, OVERLAY_FILE), OVERLAY_FILE) ?? {};
  const app = readJsonFile(path.join(root, APP_FILE), APP_FILE);
  if (!app) return config;
  // The policy section is the architecture policy's (the engine reads it from app.json and reports a bad declaration
  // as TOPOLOGY-001 at every checkpoint), so it neither stops the settings from loading nor merges into them.
  const problems = appSettingsProblems(app, { policy: false });
  if (problems.length) throw new Error(`${APP_FILE}: ${problems.join('; ')}`);
  const { policy: _policy, ...topology } = app;
  return deepMerge(config, topology);
}

// Moves the topology keys of a config document into an app document (factory init, factory config split).
export function splitTopology(config) {
  const governance = JSON.parse(JSON.stringify(config));
  const app = {};
  for (const [section, keys] of Object.entries(APP_KEYS)) {
    for (const key of keys) {
      if (governance[section]?.[key] === undefined) continue;
      let value = governance[section][key];
      if (section === 'teststack' && key === 'drift') {
        if (!value.overrides) continue;
        value = { overrides: value.overrides };
        delete governance.teststack.drift.overrides;
      } else if (section === 'stack' && key === 'services') {
        value = Object.fromEntries(Object.entries(value).map(([n, svc]) => [n, typeof svc === 'object' ? Object.fromEntries(Object.entries(svc).filter(([k]) => ['project', 'image', 'inputs'].includes(k))) : svc]));
        const rest = Object.fromEntries(Object.entries(governance.stack.services).map(([n, svc]) => [n, typeof svc === 'object' ? Object.fromEntries(Object.entries(svc).filter(([k]) => !['project', 'image', 'inputs'].includes(k))) : {}]).filter(([, svc]) => Object.keys(svc).length));
        if (Object.keys(rest).length) governance.stack.services = rest;
        else delete governance.stack.services;
      } else delete governance[section][key];
      (app[section] ??= {})[key] = value;
    }
  }
  return { governance, app };
}

// Defaults for a tool outside the stage dispatcher (lsp, stack, teststack) merged with its overlay section.
export function toolConfig(section, defaults, root = repoRoot()) {
  const overlay = repoOverlay(root);
  return { ...deepMerge(defaults, overlay[section] ?? {}), project: projectModel(root, overlay) };
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

// The project model: what the codebase is, in terms every stage shares. `name` names machine-wide state
// (stack project, LSP sockets, bot credentials), so two repositories on one machine never collide.
export function projectModel(root, overlay = repoOverlay(root)) {
  const project = overlay.project ?? {};
  const name = slug(project.name ?? path.basename(mainCheckout(root)));
  return { languages: [], services: [], toolPaths: [], frontendPaths: [], ...project, name };
}

// A worktree's folder name is not the repository's: name the project after the main checkout.
function mainCheckout(root) {
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  const dir = common.status === 0 ? common.stdout.trim() : '';
  return dir && path.basename(dir) === '.git' ? path.dirname(dir) : root;
}

function originRepo(root) {
  const r = run('git', ['remote', 'get-url', 'origin'], { cwd: root });
  const m = r.status === 0 ? /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(r.stdout) : null;
  return m ? m[1] : null;
}

const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// Hooks and background runs don't load the user's shell profile, so tools installed per user (an SDK in
// the home folder, ~/.cargo/bin, ...) are often missing from PATH. `project.toolPaths` lists them.
export function ensureToolPath(toolPaths = [], env = process.env) {
  const dirs = (env.PATH ?? '').split(path.delimiter);
  const extra = toolPaths.map(expandHome).filter((d) => d && !dirs.includes(d) && fs.existsSync(d));
  if (extra.length) env.PATH = [...extra, env.PATH].join(path.delimiter);
}

const cache = new Map();

// Shared defaults come from scripts/pipeline/config.json; a stage's scripts/<stage>/config.json is merged
// on top, then the repository's own .factory/config.json, so the app repo overrides anything.
export function loadConfig(stage = null, root = repoRoot()) {
  const cacheKey = `${root}\0${stage ?? ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let config = readConfig(path.join(PIPELINE_DIR, 'config.json'));
  if (stage) config = deepMerge(config, readConfig(path.join(SCRIPTS_DIR, stage, 'config.json')));
  const overlay = repoOverlay(root);
  config = deepMerge(config, Object.fromEntries(Object.entries(overlay).filter(([k]) => !TOOL_SECTIONS.includes(k))));
  config.project = projectModel(root, overlay);
  config.installRoot = INSTALL_ROOT;
  // The ticket repository defaults to this checkout's GitHub origin.
  if (config.tickets && !config.tickets.repo) config.tickets.repo = originRepo(root);
  // So does the story board: same repository, its owner, and a project named after the project.
  if (config.board && config.tickets?.repo) {
    config.board.repo ??= config.tickets.repo;
    config.board.owner ??= config.tickets.repo.split('/')[0];
    config.board.projectTitle ??= `${config.project.name} story board`;
  }
  config.mainRoot = mainCheckout(root);
  ensureToolPath(config.project.toolPaths);
  config.root = root;
  config.stage = stage;
  config.agent.cli = process.env.PIPELINE_AGENT_CLI || config.agent.cli;
  config.agent.cmd = process.env.PIPELINE_AGENT_CMD || null;
  config.baseRef = process.env.PIPELINE_BASE_REF || config.baseRef;
  config.abs = (rel) => path.join(root, rel);
  // Fail on a mistyped model at load time, not halfway through a run.
  const allowed = config.agent.allowedModels ?? [];
  for (const [role, alias] of Object.entries(config.agent.models ?? {})) {
    if (alias && !allowed.includes(alias)) {
      throw new Error(`agent.models.${role} is "${alias}", which is not in agent.allowedModels (${allowed.join(', ')}).`);
    }
  }
  // The same for the council's members: a bad member, lens, stage or a model without an id for its CLI fails here.
  const council = councilProblems(config.council, config.agent);
  if (council.length) throw new Error(`${OVERLAY_FILE}: ${council.join('; ')}`);
  // An implement role's own `env` (beside its `cli`), under the same rules as a council member's.
  const roleEnv = Object.entries(config.implement?.roles ?? {}).flatMap(([role, r]) => (r?.env !== undefined ? envProblems(r.env, `implement.roles.${role}.env`) : []));
  if (roleEnv.length) throw new Error(`${OVERLAY_FILE}: ${roleEnv.join('; ')}`);
  // Static analysis (opt-in): a bad tool, parser, scope, slot or pin fails here, not halfway through a pair round.
  const analysis = configAnalysisProblems(config);
  if (analysis.length) throw new Error(`${OVERLAY_FILE}: ${analysis.join('; ')}`);
  if (config.analysis) withAnalysisGate(config);
  cache.set(cacheKey, config);
  registerConfigSecrets(config);
  return config;
}

export const isDisabled = () => process.env.PIPELINE_DISABLE === '1' || process.env.PIPELINE_CHILD === '1';
