// Maps changed files to the compose services whose images they affect. Each service lists its inputs in
// `stack.services.<name>.inputs` (globs, or folders ending with "/"); an optional resolver module
// (`stack.resolver`, usually from a language pack) adds the inputs it can compute from the build files.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveModule } from './ports.mjs';

/** Normalizes a path to repo-relative POSIX form ("./src\\X" -> "src/X"). */
export function normalizePath(file) {
  return path.posix.normalize(String(file).trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '');
}

/** A glob as a RegExp: `**` crosses folders, `*` and `?` stay inside one path segment. */
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const globs = new Map();

/** True when a repo-relative file is covered by an input: a folder ("src/web/"), a glob or an exact path. */
export function matchesInput(file, input) {
  const pattern = normalizePath(input).replace(/\/$/, '') + (/[\\/]$/.test(input.trim()) ? '/' : '');
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  if (!/[*?]/.test(pattern)) return file === pattern;
  if (!globs.has(pattern)) globs.set(pattern, globToRegExp(pattern));
  return globs.get(pattern).test(file);
}

/** A service entry in its full form; a bare string or array is shorthand for its inputs. */
export function serviceEntry(value) {
  if (typeof value === 'string') return { inputs: [value] };
  if (Array.isArray(value)) return { inputs: value };
  return { ...value, inputs: value?.inputs ?? [] };
}

async function loadResolver(config, root) {
  if (!config.resolver) return null;
  const file = resolveModule(config.resolver, root);
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`stack.resolver '${config.resolver}' could not be loaded from ${file}: ${error.message}`, { cause: error });
  }
  if (typeof module.serviceInputs !== 'function') throw new Error(`stack.resolver '${config.resolver}' must export serviceInputs(service, context)`);
  return module.serviceInputs;
}

/** Inputs of every compose service with a built image: { "web": ["src/web/", ...], ... }. */
export async function serviceInputs({ config = loadConfig(), root = config.root } = {}) {
  const resolve = await loadResolver(config, root);
  const result = {};
  for (const [name, value] of Object.entries(config.services ?? {})) {
    const service = serviceEntry(value);
    const computed = resolve ? await resolve(service, { name, root, config }) : [];
    result[name] = [...new Set([...service.inputs, ...(computed ?? [])])];
  }
  return result;
}

/**
 * Compose services whose images must be rebuilt for the given changed files, in config order. Global build
 * inputs (`stack.rebuildAll`, and the compose file) select every service. Returns { services, all, reasons }
 * where reasons maps each selected service to the files that selected it.
 */
export async function servicesFor(files, { config = loadConfig(), root = config.root, inputs } = {}) {
  const normalized = [...new Set(files.map(normalizePath).filter(f => f && f !== '.'))];
  const names = Object.keys(config.services ?? {});
  const everything = [...(config.rebuildAll ?? []), ...(config.composeFile ? [config.composeFile] : [])];
  const global = normalized.filter(f => everything.some(input => matchesInput(f, input)));
  if (global.length) {
    return { services: names, all: true, reasons: Object.fromEntries(names.map(n => [n, global])) };
  }
  const byService = inputs ?? await serviceInputs({ config, root });
  const reasons = {};
  for (const name of names) {
    const hits = normalized.filter(f => (byService[name] ?? []).some(input => matchesInput(f, input)));
    if (hits.length) reasons[name] = hits;
  }
  return { services: Object.keys(reasons), all: false, reasons };
}
