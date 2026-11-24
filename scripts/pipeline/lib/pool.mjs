// The model pool (`models.pool`): the models the pipeline may run, listed once. Every agent run takes its CLI, model id,
// reasoning effort and process environment from one pool entry: an agent's own entry (`models.agents.<agent>`, else
// `models.agents.default`), a council seat's, or a subtask's (the planner's pick from `implement.subtaskModels`). An
// entry's family (Anthropic, OpenAI, Google) is derived from its model id, never set by hand; a model in no known family,
// or a custom command, is a family of its own named after its entry. See docs/ai-pipeline/models.md.
import os from 'node:os';
import path from 'node:path';
import { envProblems } from './council-config.mjs';
import { setting } from './settings.mjs';

export const POOL_CLIS = ['claude', 'codex', 'copilot', 'custom'];
export const POOL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ENTRY_KEYS = ['name', 'cli', 'model', 'effort', 'env', 'cmd', 'timeoutSec'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

// Model id to family. Ids are each CLI's own spelling (claude-opus-5-5 on Claude Code, claude-opus-5.5 on Copilot).
export const FAMILIES = [
  ['Anthropic', /^(claude|anthropic)\b|\b(opus|sonnet|haiku|fable)\b/i],
  ['OpenAI', /^(gpt|o\d|codex|openai|chatgpt)\b/i],
  ['Google', /^(gemini|gemma|google)\b/i],
];

export function familyOf(entry) {
  if (!entry) return null;
  if (entry.cli === 'custom') return entry.name;
  const id = String(entry.model ?? '');
  return FAMILIES.find(([, re]) => re.test(id))?.[0] ?? entry.name;
}

export const poolOf = (config) => {
  const p = setting(config, 'models.pool');
  return Array.isArray(p) ? p : [];
};
export const entryNames = (config) => poolOf(config).map((e) => e?.name);
export const poolEntry = (config, name) => poolOf(config).find((e) => e?.name === name) ?? null;
export const withFamily = (entry) => (entry ? { ...entry, family: familyOf(entry) } : null);

// The stages led by an orchestrator (orchestrator.mjs) and the section of their settings.
export const ORCHESTRATED = ['implement', 'architectureReview', 'testPlan', 'testAutomation', 'prCheck'];
// The implement stage's orchestrator is the implementer agent.
const ORCHESTRATOR_OF_AGENT = { implementer: 'implement' };

// A stage's orchestrator: its pool entry name and effort (`<section>.orchestrator.*`, else `orchestrator.*`; the effort
// falls back to the entry's own).
export function orchestratorSettings(config, section) {
  return {
    model: setting(config, `${section}.orchestrator.model`) ?? setting(config, 'orchestrator.model'),
    effort: setting(config, `${section}.orchestrator.effort`) ?? setting(config, 'orchestrator.effort') ?? null,
  };
}

// The entry name an agent runs on: PIPELINE_MODEL_OVERRIDE (every agent, for experiments), the implement orchestrator's
// for the implementer, its own, else the default.
export function agentEntryName(config, agent, env = process.env) {
  const agents = setting(config, 'models.agents') ?? {};
  const orchestrated = ORCHESTRATOR_OF_AGENT[agent];
  return env.PIPELINE_MODEL_OVERRIDE || (orchestrated && orchestratorSettings(config, orchestrated).model) || agents[agent] || agents.default || null;
}

// The pool entry one run uses: `entry` (a seat's or a subtask's name, or a resolved entry object), else the agent's own.
// PIPELINE_AGENT_CLI=<cli> (a CI job that installs one CLI) moves every run onto that CLI's entries: the one with the
// same model where the pool has it, else the CLI's first entry. Throws, naming the pool's entries, when nothing fits.
export function entryFor(config, { name, entry = null, env = process.env }) {
  let found;
  if (entry && typeof entry === 'object' && !env.PIPELINE_MODEL_OVERRIDE) found = entry;
  else {
    const wanted = env.PIPELINE_MODEL_OVERRIDE || (typeof entry === 'string' ? entry : entry?.name) || agentEntryName(config, name, env);
    found = poolEntry(config, wanted);
    if (!found) throw new Error(`agent ${name}: "${wanted}" is not in models.pool (entries: ${entryNames(config).join(', ') || 'none'})`);
  }
  // The implementer runs at the implement orchestrator's effort when one is set.
  const orchestrated = !entry && ORCHESTRATOR_OF_AGENT[name] ? orchestratorSettings(config, ORCHESTRATOR_OF_AGENT[name]).effort : null;
  if (orchestrated) found = { ...found, effort: orchestrated };
  const cli = env.PIPELINE_AGENT_CLI;
  if (cli && found.cli !== cli && found.cli !== 'custom') {
    const on = poolOf(config).filter((e) => e?.cli === cli);
    const key = (id) => String(id ?? '').toLowerCase().replace(/^(claude-[a-z]+)-(\d+)-(\d+)/, '$1-$2.$3');
    const same = on.find((e) => key(e.model) === key(found.model)) ?? on[0];
    if (!same) throw new Error(`agent ${name}: PIPELINE_AGENT_CLI is ${cli}, and models.pool has no entry on it (entries: ${entryNames(config).join(', ')})`);
    found = same;
  }
  return withFamily(found);
}

// Every problem with the pool and with the settings that name its entries, as sentences naming the key. Types and
// allowed values of each field come from the settings descriptions; these are the rules across fields and settings.
export function poolProblems(config) {
  const pool = setting(config, 'models.pool');
  const problems = [];
  if (!Array.isArray(pool) || !pool.length) return ['models.pool must list at least one entry'];
  const names = new Set();
  for (const [i, e] of pool.entries()) {
    const at = `models.pool[${i}]${e && typeof e.name === 'string' ? ` ("${e.name}")` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    for (const key of Object.keys(e)) if (!key.startsWith('$') && !ENTRY_KEYS.includes(key)) problems.push(`${at}.${key} is not a pool entry setting (${ENTRY_KEYS.join(', ')})`);
    if (typeof e.name !== 'string' || !NAME.test(e.name)) problems.push(`${at}.name must be a short name of letters, digits, ., - or _`);
    else if (names.has(e.name)) problems.push(`models.pool has two entries named "${e.name}"`);
    else names.add(e.name);
    if (!POOL_CLIS.includes(e.cli)) problems.push(`${at}.cli must be one of ${POOL_CLIS.join(', ')}`);
    if (!POOL_EFFORTS.includes(e.effort)) problems.push(`${at}.effort must be one of ${POOL_EFFORTS.join(', ')}`);
    if (e.cli === 'custom') {
      if (typeof e.cmd !== 'string' || !e.cmd.trim()) problems.push(`${at}.cmd must be the command a custom entry runs (it reads the prompt on stdin)`);
    } else {
      if (e.cmd !== undefined) problems.push(`${at}.cmd is only for cli "custom"`);
      if (typeof e.model !== 'string' || !e.model.trim()) problems.push(`${at}.model must be the CLI's own model id`);
    }
    if (e.env !== undefined) problems.push(...envProblems(e.env, `${at}.env`));
    if (e.timeoutSec !== undefined && !(Number.isInteger(e.timeoutSec) && e.timeoutSec >= 1)) problems.push(`${at}.timeoutSec must be a whole number of seconds`);
  }
  const list = [...names].join(', ');
  const named = (key, value) => {
    if (value != null && !names.has(value)) problems.push(`${key} is "${value}", which is not in models.pool (entries: ${list})`);
  };
  for (const [agent, value] of Object.entries(setting(config, 'models.agents') ?? {})) named(`models.agents.${agent}`, value);
  if (!names.has(setting(config, 'orchestrator.model'))) problems.push(`orchestrator.model must name a models.pool entry (entries: ${list})`);
  for (const section of ORCHESTRATED) named(`${section}.orchestrator.model`, setting(config, `${section}.orchestrator.model`));
  if (!setting(config, 'models.agents')?.default) problems.push(`models.agents.default must name a models.pool entry (entries: ${list})`);
  const sub = setting(config, 'implement.subtaskModels');
  if (sub != null) {
    if (!Array.isArray(sub) || !sub.length) problems.push('implement.subtaskModels must list at least one models.pool entry, or be null for every entry');
    else sub.forEach((n, i) => named(`implement.subtaskModels[${i}]`, n));
  }
  return problems;
}

// A one-family pool loads, with a warning: no council can be diverse.
export function poolWarnings(config) {
  const families = new Set(poolOf(config).map(familyOf));
  return families.size === 1 ? [`models.pool has one model family (${[...families][0]}): councils cannot be diverse`] : [];
}

// The entries the planner may give a subtask (`implement.subtaskModels`, else every entry).
export const subtaskModels = (config) => setting(config, 'implement.subtaskModels') ?? entryNames(config);

// An `env` map (a pool entry's; validated by council-config.mjs envProblems) as the variables its CLI
// process gets: `${NAME}` from this process's environment (an unset one stops the run, as the metrics sink does) and a
// leading `~` as the home folder.
export function agentEnv(envMap, env = process.env, home = os.homedir()) {
  const out = {};
  for (const [k, v] of Object.entries(envMap ?? {})) {
    const expanded = String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] == null) throw new Error(`env.${k} needs the environment variable ${name}, which is not set`);
      return env[name];
    });
    out[k] = expanded === '~' || expanded.startsWith('~/') ? path.join(home, expanded.slice(1)) : expanded;
  }
  return out;
}
