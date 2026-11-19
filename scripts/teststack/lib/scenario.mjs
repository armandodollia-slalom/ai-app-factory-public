// Scenario files. A scenario is a YAML or JSON mapping:
//
//   description: text
//   extends: other-scenario            # optional; a name, a path or a list. Applied before this file.
//   <store>:                           # one section per configured store (teststack.stores), in the
//     ...                              # format of that store's adapter (see lib/stores/*.mjs)
//
// Resolving a scenario gives the ordered layers to apply: the base scenario, then the `extends` chain
// (depth first), then the scenario itself. Each file is applied once.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, TestStackError } from './common.mjs';
import { loadDataFile } from './yaml.mjs';

const FILE_NAMES = ['scenario.yaml', 'scenario.yml', 'scenario.json'];
const RESERVED = ['description', 'extends'];

export const invalidScenario = (file, message) => new TestStackError(`Invalid scenario ${file}: ${message}`, EXIT.invalidScenario);

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Throws when a mapping has a key outside `allowed`. */
export function checkKeys(node, allowed, invalid, location) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw invalid(`${location}: unknown key '${key}'. Allowed: ${allowed.join(', ')}.`);
  }
}

const isFile = candidate => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/** A scenario reference is a file, a folder containing scenario.yaml|yml|json, or a name under the scenarios folder. */
export function locate(reference, searchDirs, scenariosDir) {
  for (const dir of searchDirs) {
    const candidate = path.resolve(dir, reference);
    for (const file of [candidate, ...FILE_NAMES.map(name => path.join(candidate, name))]) {
      if (isFile(file)) return file;
    }
  }
  throw new TestStackError(`Scenario '${reference}' not found. Available: ${listScenarios(scenariosDir).join(', ') || '(none)'}`, EXIT.invalidScenario);
}

/** Names of the scenarios in the scenarios folder, sorted. */
export function listScenarios(scenariosDir) {
  if (!fs.existsSync(scenariosDir)) return [];
  return fs.readdirSync(scenariosDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

const looksLikePath = reference => /[\\/]/.test(reference) || reference.startsWith('.');

/**
 * Parses one scenario file. `stores` is a list of { name, adapter, config }; each adapter validates and
 * converts its own section, so an unknown key, database or file fails here, before anything is touched.
 */
export async function parseFile(file, stores) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  const name = stem === 'scenario' ? path.basename(dir) : stem;
  const invalid = message => invalidScenario(file, message);
  const document = await loadDataFile(file);
  const layer = { name, file, description: null, extends: [], sections: {} };
  if (document === null) return layer;
  if (!isMapping(document)) throw invalid('the document must be a mapping.');
  checkKeys(document, [...RESERVED, ...stores.map(store => store.name)], invalid, 'top level');

  const ext = document.extends;
  if (Array.isArray(ext)) {
    if (ext.some(item => item === null || typeof item === 'object')) throw invalid("'extends' entries must be strings.");
    layer.extends = ext.map(String);
  } else if (ext !== undefined && ext !== null) {
    if (typeof ext === 'object') throw invalid("'extends' must be a string or a list of strings.");
    layer.extends = [String(ext)];
  }
  if (document.description !== undefined && document.description !== null) layer.description = String(document.description);

  for (const store of stores) {
    const section = document[store.name];
    if (section === undefined || section === null) continue;
    if (typeof store.adapter.parseSection !== 'function') throw invalid(`'${store.name}' (${store.config.type}) takes no scenario data.`);
    layer.sections[store.name] = await store.adapter.parseSection(section, {
      store: store.config, file, dir, location: store.name, invalid, loadDataFile,
    });
  }
  return layer;
}

/** The ordered layers for a scenario name or path: base first, then `extends` dependencies, then the scenario. */
export async function resolve(scenario, { scenariosDir, baseScenario, stores, cwd = process.cwd() }) {
  const layers = [];
  const visited = new Set();
  const visiting = [];

  async function visit(reference, searchDirs) {
    const file = locate(reference, searchDirs, scenariosDir);
    if (visited.has(file)) return;
    if (visiting.includes(file)) {
      throw new TestStackError(`Scenario 'extends' cycle: ${[...visiting, file].join(' -> ')}`, EXIT.invalidScenario);
    }
    visiting.push(file);
    const layer = await parseFile(file, stores);
    for (const dependency of layer.extends) await visit(dependency, [path.dirname(file), scenariosDir]);
    visiting.pop();
    visited.add(file);
    layers.push(layer);
  }

  if (baseScenario) await visit(baseScenario, [scenariosDir]);
  // A bare name means a scenario of the repository even when the caller's folder has an entry of that name.
  if (scenario) await visit(scenario, looksLikePath(scenario) ? [cwd, scenariosDir] : [scenariosDir, cwd]);
  return layers;
}
