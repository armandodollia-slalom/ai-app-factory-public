// MongoDB store adapter, through `mongosh` inside the database's container. The work is done by a fixed
// script passed with --eval; the data travels as JSON on stdin, so its size and content need no quoting.
//
// Config: type: "mongodb", service (default: the store's name), cli: "mongosh", username, passwordEnv |
//   password, authDatabase: "admin", databases: [names or { name, preserveCollections, migrationsReady }],
//   preserveCollections: collections never emptied, migrationsReady: { collection } (ready once it holds a
//   document). --hard has no snapshots here; it clears the databases like a soft reset.
//
// Scenario section:
//   <store>:
//     <database>:
//       - collection: users
//         documents: [{ _id: 1, name: Alice }]    # or documentsFile: users.json|yaml
//       - js: file.js                             # a mongosh script; `db` is the database
// Documents are read as MongoDB Extended JSON, so { "$oid": "..." } and { "$date": "..." } work.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, TestStackError } from '../common.mjs';
import { checkKeys } from '../scenario.mjs';

const STEP_KEYS = ['collection', 'documents', 'documentsFile', 'js'];
const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalize(config, name) {
  const store = { service: name, cli: 'mongosh', username: null, passwordEnv: null, password: null, authDatabase: 'admin', preserveCollections: [], migrationsReady: null, ...config };
  if (!Array.isArray(config.databases) || config.databases.length === 0) throw new Error(`teststack.stores.${name}.databases must list at least one database`);
  store.databases = config.databases.map(db => {
    const entry = typeof db === 'string' ? { name: db } : db;
    return { name: entry.name, preserveCollections: entry.preserveCollections ?? store.preserveCollections, migrationsReady: entry.migrationsReady ?? store.migrationsReady };
  });
  return store;
}

export async function parseSection(section, h) {
  if (!isMapping(section)) throw h.invalid(`'${h.location}' must map database names to step lists.`);
  const known = h.store.databases.map(db => db.name);
  const result = [];
  for (const [database, steps] of Object.entries(section)) {
    if (!known.includes(database)) throw h.invalid(`unknown database '${database}'. Known: ${known.join(', ')}.`);
    if (!Array.isArray(steps)) throw h.invalid(`${h.location}.${database} must be a list of steps.`);
    for (const [i, step] of steps.entries()) {
      const location = `${h.location}.${database}[${i}]`;
      if (!isMapping(step)) throw h.invalid(`${location} must be a mapping with 'js' or 'collection'.`);
      checkKeys(step, STEP_KEYS, h.invalid, location);
      if (step.js !== undefined && step.js !== null) {
        if (Object.keys(step).length !== 1) throw h.invalid(`${location}: 'js' steps can't have other keys.`);
        const file = path.resolve(h.dir, String(step.js));
        if (!fs.existsSync(file)) throw h.invalid(`${location}: script not found: ${file}`);
        result.push({ database, source: `${location} (${path.basename(file)})`, js: fs.readFileSync(file, 'utf8') });
        continue;
      }
      if (!step.collection) throw h.invalid(`${location} needs 'js' or 'collection'.`);
      let documents = step.documents;
      if (step.documentsFile !== undefined && step.documentsFile !== null) {
        if ('documents' in step) throw h.invalid(`${location}: use either 'documents' or 'documentsFile'.`);
        const file = path.resolve(h.dir, String(step.documentsFile));
        if (!fs.existsSync(file)) throw h.invalid(`${location}: documents file not found: ${file}`);
        documents = await h.loadDataFile(file);
      }
      if (!Array.isArray(documents) || documents.some(doc => !isMapping(doc))) throw h.invalid(`${location}: 'documents' must be a list of mappings.`);
      result.push({ database, source: `${location} (${step.collection})`, collection: String(step.collection), documents });
    }
  }
  return result;
}

export const count = parsed => parsed.length;

// The script mongosh runs. It reads one JSON request from stdin and prints one JSON reply line.
export const DRIVER = `
const request = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const reply = value => print('TESTSTACK ' + JSON.stringify(value));
if (request.op === 'ping') {
  reply({ ok: db.runCommand({ ping: 1 }).ok });
} else if (request.op === 'counts') {
  reply({ counts: request.collections.map(c => db.getSiblingDB(c.database).getCollection(c.collection).countDocuments({})) });
} else if (request.op === 'clear') {
  for (const d of request.databases) {
    const database = db.getSiblingDB(d.name);
    for (const name of database.getCollectionNames()) {
      if (!name.startsWith('system.') && !d.preserve.includes(name)) database.getCollection(name).deleteMany({});
    }
  }
  reply({ ok: 1 });
} else if (request.op === 'load') {
  let documents = 0;
  for (const [index, step] of request.steps.entries()) {
    try {
      const database = db.getSiblingDB(step.database);
      if (step.js !== undefined) new Function('db', step.js)(database);
      else if (step.documents.length) documents += database.getCollection(step.collection).insertMany(EJSON.deserialize(step.documents)).insertedIds ? step.documents.length : 0;
    } catch (error) {
      reply({ failed: index, message: String(error.message || error) });
      quit(1);
    }
  }
  reply({ ok: 1, documents });
}
`.trim();

async function run(ctx, request, what) {
  const { store } = ctx;
  const password = store.password ?? (store.passwordEnv ? ctx.secret(store.passwordEnv) : null);
  const auth = store.username ? ['-u', store.username, '-p', password ?? '', '--authenticationDatabase', store.authDatabase] : [];
  const result = await ctx.exec([store.cli, '--quiet', '--norc', ...auth, '--eval', DRIVER], { input: JSON.stringify(request) });
  const line = result.stdout.split('\n').find(text => text.startsWith('TESTSTACK '));
  if (!line) throw new TestStackError(`${ctx.name}: ${what} failed: ${(result.stderr || result.stdout).trim().split('\n')[0] || `${store.cli} exited with ${result.status}`}`);
  return JSON.parse(line.slice('TESTSTACK '.length));
}

export async function probe(ctx) {
  const reply = await run(ctx, { op: 'ping' }, 'ping');
  if (!reply.ok) throw new TestStackError(`${ctx.name}: ping failed`);
  return { detail: 'accepting connections' };
}

export async function serviceChecks(ctx, service) {
  const mine = (service.databases ?? []).map(name => ctx.store.databases.find(db => db.name === name)).filter(db => db?.migrationsReady?.collection);
  if (mine.length === 0) return [];
  const { counts } = await run(ctx, { op: 'counts', collections: mine.map(db => ({ database: db.name, collection: db.migrationsReady.collection })) }, 'counting');
  return mine.map((db, i) => (counts[i] > 0
    ? { name: `migrations:${db.name}`, ok: true, detail: `${counts[i]} applied` }
    : { name: `migrations:${db.name}`, ok: false, detail: 'no migrations applied yet' }));
}

export async function clear(ctx) {
  await run(ctx, { op: 'clear', databases: ctx.store.databases.map(db => ({ name: db.name, preserve: db.preserveCollections })) }, 'clearing');
  return {};
}

export async function load(ctx, sections) {
  const steps = sections.flat();
  if (steps.length === 0) return { count: 0 };
  const reply = await run(ctx, { op: 'load', steps: steps.map(({ database, collection, documents, js }) => ({ database, collection, documents, js })) }, 'loading');
  if (reply.failed !== undefined) {
    const step = steps[reply.failed];
    throw new TestStackError(`${step.database}: ${step.source} failed: ${reply.message}`, EXIT.invalidScenario);
  }
  return { count: steps.length, detail: `${steps.length} step(s), ${reply.documents} document(s)` };
}
