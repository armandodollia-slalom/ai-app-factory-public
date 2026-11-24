import fs from 'node:fs';
import { registerConfigSecrets } from './redact.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';
import { policyTopologyProblems } from './policy-topology.mjs';
import { councilProblems, intercomProblems } from './council-config.mjs';
import { ORCHESTRATED, poolProblems, poolWarnings } from './pool.mjs';
import { configAnalysisProblems } from './analysis/config.mjs';
import { withAnalysisGate } from './analysis/ci.mjs';
import { allowedValues, defaultSettings, settingsProblems } from './settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PIPELINE_DIR = path.resolve(here, '..');

// A configuration that cannot load (not JSON, an invalid setting): the CLIs print its message, never a stack trace.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'config';
  }
}
export const SCRIPTS_DIR = path.resolve(PIPELINE_DIR, '..');
export const INSTALL_ROOT = path.resolve(SCRIPTS_DIR, '..');

export function repoRoot(cwd = process.cwd()) {
  if (process.env.PIPELINE_ROOT) return path.resolve(process.env.PIPELINE_ROOT);
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.status !== 0) throw new ConfigError('the AI pipeline must run inside a git repository');
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


// The app repository's own settings: <root>/.factory/config.json. Everything the engine knows about the
// codebase it works on (project model, commands, paths, per-stage overrides) comes from this file; the
// config.json files beside the code hold only language-neutral defaults.
export const FACTORY_DIR = '.factory';
export const OVERLAY_FILE = `${FACTORY_DIR}/config.json`;
// Sections that are off unless the repository's settings name them.
const OPT_IN = ['analysis'];

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
    throw new ConfigError(`${label} is not valid JSON: ${error.message}`);
  }
}

// The repository's settings: config.json (governance and everything else) with app.json (topology) on top. `check: false`
// (factory doctor only, which reports each problem as a row) reads them without refusing a settings problem.
export function repoOverlay(root, { check = true } = {}) {
  const checked = (overlay) => (check ? checkedOverlay(overlay) : overlay);
  const config = readJsonFile(path.join(root, OVERLAY_FILE), OVERLAY_FILE) ?? {};
  const app = readJsonFile(path.join(root, APP_FILE), APP_FILE);
  if (!app) return checked(config);
  // The policy section is the architecture policy's (the engine reads it from app.json and reports a bad declaration
  // as TOPOLOGY-001 at every checkpoint), so it neither stops the settings from loading nor merges into them.
  const problems = appSettingsProblems(app, { policy: false });
  if (problems.length) throw new ConfigError(`${APP_FILE}: ${problems.join('; ')}`);
  const { policy: _policy, ...topology } = app;
  return checked(deepMerge(config, topology));
}
// The repository's own settings at `root`, unchecked, for code that has a checkout but no loaded config (the commit
// gate, the records commit, render): read them with setting(repoSettings(root), '<name>'), which falls back to the
// defaults. An unreadable overlay is none.
export function repoSettings(root) {
  try {
    return repoOverlay(root, { check: false }) ?? {};
  } catch {
    return {};
  }
}

function checkedOverlay(overlay) {
  const problems = overlayProblems(overlay);
  if (problems.length) throw new ConfigError(`${OVERLAY_FILE}: ${problems.join('; ')}`);
  return overlay;
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
  return { ...defaultSettings().project, ...project, name };
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

// The problems of one part of the settings (doctor reports each part on its own row): settingsProblems, which checks
// every name and value against the settings descriptions (scripts/<dir>/settings.json), filtered to that part.
const partProblems = (doc, prefix) => settingsProblems(isObject(doc) ? doc : {}).filter((p) => p.startsWith(prefix));
export const VIDEO_SCRIPT_SCOPES = allowedValues('video.script.scope');
// `video.apiEvidence.paymentBodies`: a payment exchange's headers and bodies withheld (the default) or masked.
export const PAYMENT_BODIES = allowedValues('video.apiEvidence.paymentBodies');
export const apiEvidenceProblems = (config) => partProblems(config, 'video.apiEvidence.');
export const videoScriptProblems = (config) => partProblems(config, 'video.script.');

const cache = new Map();
const warned = new Set();

// The `prune` settings' problems (scripts/factory/lib/prune.mjs reads them; a config that has problems does not load).
export const pruneProblems = (prune) => partProblems({ prune }, 'prune');

// The PR delivery settings (implement.preOpen; scripts/implement/lib/pre-open.mjs reads them).
export const PRE_OPEN_DEFAULTS = defaultSettings().implement.preOpen;
export const AFTER_OPEN = allowedValues('implement.preOpen.afterOpen');
export const preOpenProblems = (config) => partProblems(config, 'implement.preOpen.');

// The problems of the repository's own settings that every loader reports the same way (repoOverlay: a stage's config,
// a tool's section, doctor): a config with any of them does not load, whichever command reads it first. Old and
// misspelt names and values outside a setting's allowed ones come from the settings descriptions (settings.mjs).
export const overlayProblems = (overlay) => [...settingsProblems(overlay ?? {}), ...listedMembers(overlay), ...poolOverlayProblems(overlay)];
// A council written the old way, as a list of members: say where its members went (the pool) besides the type error.
const listedMembers = (overlay) => (Array.isArray(overlay?.council?.members) ? councilProblems({ members: overlay.council.members }) : []);
// The pool and every setting that names one of its entries, on the defaults with the repository's settings on top:
// every loader, a tool's section included, refuses an entry name that is not in the pool.
function poolOverlayProblems(overlay) {
  const names = (o) => o && typeof o === 'object' && (o.models || o.orchestrator || o.implement?.subtaskModels || ORCHESTRATED.some((s) => o[s]?.orchestrator));
  if (!names(overlay)) return [];
  return poolProblems(deepMerge(defaultSettings(), overlay));
}

// Settings the run honours only with a fallback: a warning when the config loads, never a failure. The modules that know
// the fallback register the check (implement/lib/pre-open.mjs: a hold mode the code host cannot do); each returns the
// warnings for a loaded config.
const warners = new Set();
export const addConfigWarning = (check) => warners.add(check);
export function configWarnings(config) {
  return [...warners].flatMap((check) => {
    try {
      return check(config) ?? [];
    } catch {
      return [];
    }
  });
}

// The defaults of every section (scripts/<dir>/config.json), then the repository's own .factory/config.json, so the app
// repo overrides anything. `stage` names the stage that loads them (config.stage).
export function loadConfig(stage = null, root = repoRoot()) {
  const cacheKey = `${root}\0${stage ?? ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  // Every section's defaults (scripts/<dir>/config.json; settings.mjs), whichever stage loads them.
  // An opt-in section's defaults apply only when the repository names the section (its presence turns it on).
  const overlay = repoOverlay(root);
  let config = Object.fromEntries(Object.entries(defaultSettings()).filter(([k]) => !(OPT_IN.includes(k) && (overlay[k] === undefined || overlay[k] === null))));
  config = deepMerge(config, overlay);
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
  config.agent.cmd = process.env.PIPELINE_AGENT_CMD || null;
  config.baseRef = process.env.PIPELINE_BASE_REF || config.baseRef;
  config.abs = (rel) => path.join(root, rel);
  // The pool, and every setting that names one of its entries, fails here, not halfway through a run.
  const pool = poolProblems(config);
  if (pool.length) throw new ConfigError(`${OVERLAY_FILE}: ${pool.join('; ')}`);
  const council = [...councilProblems(config.council), ...['implement', 'architectureReview', 'testPlan', 'testAutomation', 'prCheck'].flatMap((s) => (config[s]?.councilIntercom !== undefined ? intercomProblems(config[s].councilIntercom, `${s}.councilIntercom`, config.council?.intercom) : []))];
  if (council.length) throw new ConfigError(`${OVERLAY_FILE}: ${council.join('; ')}`);
  // Static analysis (opt-in): a bad tool, parser, scope, slot or pin fails here, not halfway through a pair round.
  const analysis = configAnalysisProblems(config);
  if (analysis.length) throw new ConfigError(`${OVERLAY_FILE}: ${analysis.join('; ')}`);
  // Settings that work but not as written: a warning, once per process, never a failure.
  config.warnings = [...poolWarnings(config), ...configWarnings(config)];
  for (const w of config.warnings) {
    if (warned.has(`${root}\0${w}`)) continue;
    warned.add(`${root}\0${w}`);
    console.error(`warning: ${OVERLAY_FILE}: ${w}`);
  }
  if (config.analysis) withAnalysisGate(config);
  cache.set(cacheKey, config);
  registerConfigSecrets(config);
  return config;
}

export const isDisabled = () => process.env.PIPELINE_DISABLE === '1' || process.env.PIPELINE_CHILD === '1';
