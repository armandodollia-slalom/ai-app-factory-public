// Everything a test stack command needs about one slot of one repository: the merged `stack` and `teststack`
// settings, the slot's names, ports and URLs, the env file, the compose runner and the store adapters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolConfig, ensureToolPath } from '../../pipeline/lib/config.mjs';
import { expandPorts, loadConfig, slotAnnotation, slotInfo, slotPortEnv } from '../../stack/lib/ports.mjs';
import { EXIT, TestStackError, log } from './common.mjs';
import { probeHttp } from './readiness.mjs';
import { composeRunner } from './runner.mjs';
import { loadAdapter } from './stores/index.mjs';
import { setYamlSearchRoots } from './yaml.mjs';

const DEFAULTS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

/** KEY=VALUE lines of a compose env file (comments and blank lines skipped, surrounding quotes removed). */
export function parseEnv(text) {
  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

export const readEnvFile = file => (fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {});

export const formatEnv = values => Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');

/** Merged `teststack` settings with each store's adapter and each service's URL resolved for the slot's ports. */
export async function resolveSettings(config, { root, ports }) {
  const stores = [];
  for (const [name, raw] of Object.entries(config.stores ?? {})) {
    let adapter;
    let store;
    try {
      adapter = await loadAdapter(raw?.type, root);
      store = adapter.normalize({ ...raw }, name);
    } catch (error) {
      throw new TestStackError(`teststack.stores.${name}: ${error.message}`, EXIT.usage);
    }
    stores.push({ name, adapter, config: store });
  }
  const services = (config.services ?? []).map(service => {
    if (!service?.name) throw new TestStackError('teststack.services entries need a name', EXIT.usage);
    try {
      return { ...service, url: service.url ? expandPorts(service.url, ports) : null };
    } catch (error) {
      throw new TestStackError(`teststack.services.${service.name}: ${error.message}`, EXIT.usage);
    }
  });
  const restartAfterLoad = (config.restartAfterLoad ?? []).map(rule => {
    const entry = typeof rule === 'string' ? { service: rule, when: 'always' } : { when: 'always', ...rule };
    if (!entry.service || !['always', 'sequencesUsed'].includes(entry.when)) {
      throw new TestStackError('teststack.restartAfterLoad entries need a service and when: "always" | "sequencesUsed"', EXIT.usage);
    }
    return entry;
  });
  return { ...config, stores, services, restartAfterLoad };
}

/**
 * The slot's env file: what is already there (image tags from the last build), else the template, with the
 * slot's host ports and the fixed test values of `stack.env` (overridable from the process environment).
 */
export function slotEnv({ stack, info, existing, env = process.env }) {
  const template = stack.envTemplate ? readEnvFile(path.resolve(stack.root, stack.envTemplate)) : {};
  const values = { ...template, ...existing };
  for (const [key, value] of Object.entries(stack.env ?? {})) values[key] = env[key] || values[key] || String(value);
  return { ...values, ...slotPortEnv(info.slot, stack) };
}

export async function createContext({ root, slot = 0, env = process.env, runner, http = probeHttp, writeEnv = true }) {
  let stack;
  let info;
  try {
    stack = loadConfig(root);
    info = slotInfo(slot, stack);
  } catch (error) {
    throw new TestStackError(error.message, EXIT.usage);
  }
  ensureToolPath(stack.project?.toolPaths, env);
  setYamlSearchRoots([stack.root]);
  const settings = toolConfig('teststack', JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')), stack.root);
  const config = await resolveSettings(settings, { root: stack.root, ports: info.ports });

  const abs = relative => path.resolve(stack.root, relative);
  const envFile = abs(info.envFile);
  const ctx = {
    root: stack.root,
    stack,
    info,
    config,
    env,
    annotation: slotAnnotation(info),
    stateDir: abs(info.stateDir),
    envFile,
    composeFile: abs(info.composeFile),
    scenariosDir: abs(config.scenariosDir),
    abs,
    http,
    log,
  };
  ctx.envValues = () => slotEnv({ stack, info, existing: readEnvFile(envFile), env });
  /** Writes the env file when its content changed; every compose call reads it. */
  ctx.syncEnv = (extra = {}) => {
    const text = formatEnv({ ...ctx.envValues(), ...extra });
    if (!fs.existsSync(envFile) || fs.readFileSync(envFile, 'utf8') !== text) {
      fs.mkdirSync(path.dirname(envFile), { recursive: true });
      fs.writeFileSync(envFile, text);
    }
  };
  /** A value from the process environment, the slot's env file or stack.env (passwords of the test stack). */
  ctx.secret = name => {
    const value = env[name] || ctx.envValues()[name];
    if (!value) throw new TestStackError(`Variable '${name}' is not set in ${info.envFile}, stack.env or the environment.`);
    return value;
  };
  if (writeEnv && !runner) ctx.syncEnv();
  ctx.runner = runner ?? composeRunner({
    docker: env.TESTSTACK_DOCKER || 'docker', project: info.project, composeFile: ctx.composeFile, envFile, cwd: stack.root,
    env: { ...env, ...Object.fromEntries(Object.entries(ctx.envValues()).filter(([key]) => !(key in env))) },
  });
  ctx.stores = config.stores.map(store => ({
    ...store,
    ctx: {
      name: store.name,
      store: store.config,
      exec: (argv, options) => ctx.runner.exec(store.config.service, argv, options),
      secret: ctx.secret,
      log,
    },
  }));
  return ctx;
}
