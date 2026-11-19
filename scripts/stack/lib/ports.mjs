// Stack settings and slot math for the Docker Compose test stack. Everything about the codebase (host ports,
// URLs, services, build commands) comes from the `stack` section of the app repository's .factory/config.json;
// config.json beside this folder holds only neutral defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_ROOT, repoRoot, toolConfig } from '../../pipeline/lib/config.mjs';

export const STACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(STACK_DIR, 'config.json');
export { INSTALL_ROOT };

/** The app repository the stack belongs to: an explicit folder, $TESTSTACK_ROOT, or the git checkout around cwd. */
export function resolveRoot(explicit, env = process.env) {
  const root = explicit || env.TESTSTACK_ROOT;
  return root ? path.resolve(root) : repoRoot();
}

/** "pack:<path>" is a file of an installed language pack; anything else is a path inside the app repository. */
export function resolveModule(spec, root) {
  if (spec.startsWith('pack:')) return path.join(INSTALL_ROOT, 'packs', spec.slice(5));
  return path.resolve(root, spec);
}

const cache = new Map();

/** Engine defaults merged with the repository's `stack` section, with the names derived from the project filled in. */
export function loadConfig(root = resolveRoot()) {
  const key = path.resolve(root);
  if (!cache.has(key)) cache.set(key, finishConfig(toolConfig('stack', JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), key), key));
  return cache.get(key);
}

/** Fills the derived values of a merged stack config (also used by tests that build a config by hand). */
export function finishConfig(config, root = config.root) {
  const name = config.project?.name ?? 'app';
  const out = { ...config, root };
  out.composeProject = config.composeProject || `${name}-teststack`;
  out.imageTag = config.imageTag || `${name}-teststack`;
  for (const [portName, p] of Object.entries(out.ports ?? {})) {
    if (!Number.isInteger(p?.base)) throw new Error(`stack.ports.${portName}.base must be an integer`);
  }
  return out;
}

/** Machine-wide state of one project's test stacks (slot leases, the image build lock). */
export function stateHome(config = loadConfig(), env = process.env) {
  return env.TESTSTACK_STATE_HOME || path.join(os.homedir(), '.ai-app-factory', 'teststack', config.project?.name ?? 'app');
}

/** Validates a slot number (0 = the default stack, 1..maxSlot = isolated copies) and returns it as a number. */
export function parseSlot(value, config = loadConfig()) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`slot must be an integer 0..${config.maxSlot}, got '${value}'`);
  const slot = Number(text);
  if (slot > config.maxSlot) throw new Error(`slot ${slot} is out of range (0..${config.maxSlot})`);
  return slot;
}

/** Host ports of a slot, keyed by name: base + slotStride * slot. */
export function slotPorts(slot, config = loadConfig()) {
  const n = parseSlot(slot, config);
  return Object.fromEntries(Object.entries(config.ports).map(([name, p]) => [name, p.base + config.slotStride * n]));
}

/** Compose interpolation variables (the `env` name of each port) for a slot. */
export function slotPortEnv(slot, config = loadConfig()) {
  const ports = slotPorts(slot, config);
  return Object.fromEntries(Object.entries(config.ports).filter(([, p]) => p.env).map(([name, p]) => [p.env, String(ports[name])]));
}

/** Replaces {port:<name>} with the slot's host port for that name. */
export function expandPorts(template, ports) {
  return String(template).replace(/\{port:([^}]+)\}/g, (_, name) => {
    if (!(name in ports)) throw new Error(`unknown port '${name}' in '${template}' (stack.ports has: ${Object.keys(ports).join(', ') || 'none'})`);
    return String(ports[name]);
  });
}

/** Everything that identifies a slot: compose project, state paths, image tag, host ports and URLs. */
export function slotInfo(slot, config = loadConfig()) {
  const n = parseSlot(slot, config);
  const ports = slotPorts(n, config);
  const stateDir = n === 0 ? config.stateDir : `${config.stateDir}/slot-${n}`;
  const urls = Object.fromEntries(Object.entries(config.urls ?? {}).map(([name, template]) => [name, expandPorts(template, ports)]));
  const names = Object.keys(urls);
  if (config.baseUrl && !(config.baseUrl in urls)) throw new Error(`stack.baseUrl names '${config.baseUrl}', which is not in stack.urls`);
  return {
    slot: n,
    project: n === 0 ? config.composeProject : `${config.composeProject}-${n}`,
    stateDir,
    envFile: `${stateDir}/.env`,
    composeFile: config.composeFile,
    imageTag: n === 0 ? config.imageTag : `${config.imageTag}-${n}`,
    baseUrl: names.length ? urls[config.baseUrl ?? names[0]] : null,
    urls,
    ports,
  };
}

/**
 * The fields every JSON result line carries about its slot. Each named URL also appears as `<name>Url`
 * (urls.web -> webUrl), so callers can read one URL without knowing the whole map.
 */
export function slotAnnotation(info) {
  const aliases = Object.fromEntries(Object.entries(info.urls).map(([name, url]) => [`${name}Url`, url]));
  return { slot: info.slot, project: info.project, baseUrl: info.baseUrl, urls: info.urls, ...aliases, ports: info.ports };
}

/** KEY=VALUE lines for shell scripts (values never contain newlines). */
export function shellEnv(slot, config = loadConfig()) {
  const info = slotInfo(slot, config);
  const lines = {
    SLOT: info.slot,
    PROJECT: info.project,
    STATE_DIR: info.stateDir,
    ENV_FILE: info.envFile,
    COMPOSE_FILE: info.composeFile,
    IMAGE_TAG: info.imageTag,
    BASE_URL: info.baseUrl ?? '',
    SLOT_JSON: JSON.stringify(slotAnnotation(info)).slice(1, -1),
    ...Object.fromEntries(Object.entries(slotPortEnv(info.slot, config)).map(([k, v]) => [`PORT_${k}`, v])),
  };
  return Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n');
}
