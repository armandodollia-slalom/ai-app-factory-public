// Scenario data files: JSON is read natively; YAML goes through the `yaml` npm package, loaded only when a
// YAML file is actually read, so JSON-only repositories need no dependency.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, TestStackError } from './common.mjs';

const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

let yamlModule;
let searchRoots = [];

/** Extra folders (the app repository) whose node_modules may hold the `yaml` package. */
export function setYamlSearchRoots(roots) {
  searchRoots = roots.filter(Boolean);
}

async function loadYamlModule() {
  if (yamlModule) return yamlModule;
  try {
    yamlModule = await import('yaml');
    return yamlModule;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  for (const root of searchRoots) {
    try {
      const file = createRequire(path.join(root, 'package.json')).resolve('yaml');
      yamlModule = await import(pathToFileURL(file).href);
      return yamlModule.parseAllDocuments ? yamlModule : (yamlModule = yamlModule.default);
    } catch { /* not installed there either */ }
  }
  throw new TestStackError(
    "YAML scenario files need the 'yaml' npm package, which is not installed. Run 'npm install' in the factory install folder "
    + "(or 'npm install yaml' in the app repository), or write the scenario as JSON (scenario.json).", EXIT.error);
}

const invalid = (file, message) => new TestStackError(`Invalid scenario ${file}: ${message}`, EXIT.invalidScenario);

/**
 * Plain (unquoted) scalars that look like JSON numbers, booleans or null get that type; everything else,
 * including quoted scalars and values like 02134, stays a string. The datastore converts strings to the
 * column type, so timestamps and uuids can be written as plain strings.
 */
export function plainScalar(text) {
  if (['', '~', 'null', 'Null', 'NULL'].includes(text)) return null;
  if (['true', 'True', 'TRUE'].includes(text)) return true;
  if (['false', 'False', 'FALSE'].includes(text)) return false;
  return JSON_NUMBER.test(text) ? Number(text) : text;
}

function toJson(node, yaml, doc, file) {
  if (node === null || node === undefined) return null;
  if (yaml.isAlias(node)) return toJson(node.resolve(doc), yaml, doc, file);
  if (yaml.isMap(node)) {
    return Object.fromEntries(node.items.map(pair => {
      if (!yaml.isScalar(pair.key)) throw invalid(file, 'mapping keys must be plain strings.');
      return [String(pair.key.source ?? pair.key.value ?? ''), toJson(pair.value, yaml, doc, file)];
    }));
  }
  if (yaml.isSeq(node)) return node.items.map(item => toJson(item, yaml, doc, file));
  if (yaml.isScalar(node)) {
    const text = String(node.value ?? '');
    return node.type === 'PLAIN' || node.type === undefined ? plainScalar(text) : text;
  }
  throw invalid(file, 'unsupported YAML node.');
}

/** Parses YAML text into plain JSON values with the scalar typing above. Returns null for an empty document. */
export async function parseYaml(text, file = '<yaml>') {
  const yaml = await loadYamlModule();
  const docs = yaml.parseAllDocuments(text, { schema: 'failsafe' });
  if (docs.length === 0) return null;
  const doc = docs[0];
  if (doc.errors.length) {
    const error = doc.errors[0];
    const at = error.linePos?.[0];
    throw invalid(file, `YAML error${at ? ` at line ${at.line}, column ${at.col}` : ''}: ${String(error.message).split('\n')[0]}`);
  }
  return toJson(doc.contents, yaml, doc, file);
}

/** Reads a .json, .yaml or .yml data file. */
export async function loadDataFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.json')) {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw invalid(file, `JSON error: ${error.message}`);
    }
  }
  return parseYaml(text, file);
}
