// Scenario files: parsing, `extends` resolution and validation errors (what testing/eShop.TestStack.Tests
// covered for the C# loader), plus JSON scenarios, which need no YAML package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../lib/common.mjs';
import { resolveSettings } from '../lib/context.mjs';
import { listScenarios, locate, parseFile, resolve } from '../lib/scenario.mjs';
import { plainScalar } from '../lib/yaml.mjs';
import { needsYaml } from './helpers.mjs';

const { stores } = await resolveSettings({
  stores: {
    postgres: { type: 'postgres', databases: ['catalogdb', 'orderingdb'] },
    redis: { type: 'redis' },
    eventbus: { type: 'rabbitmq' },
  },
}, { root: os.tmpdir(), ports: {} });

function scenarios(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-scenarios-')));
  const all = { '_base/scenario.yaml': 'postgres:\n  orderingdb:\n    - table: ordering.cardtypes\n      rows: [{ Id: 1, Name: Amex }]\n', ...files };
  for (const [file, text] of Object.entries(all)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const invalid = pattern => error => {
  assert.equal(error.exitCode, EXIT.invalidScenario, error.message);
  assert.match(error.message, pattern);
  return true;
};

test('resolve orders the base, then extends, then the scenario, each file once', needsYaml, async () => {
  const dir = scenarios({ 'a/scenario.yaml': 'extends: _base\n', 'b/scenario.yaml': 'extends: [a, _base]\n' });
  const layers = await resolve('b', { scenariosDir: dir, baseScenario: '_base', stores, cwd: dir });
  assert.deepEqual(layers.map(l => l.name), ['_base', 'a', 'b']);
  assert.deepEqual(layers[2].extends, ['a', '_base']);
  // reset: only the base layer
  assert.deepEqual((await resolve(null, { scenariosDir: dir, baseScenario: '_base', stores, cwd: dir })).map(l => l.name), ['_base']);
  // no base scenario configured
  assert.deepEqual((await resolve('a', { scenariosDir: dir, baseScenario: null, stores, cwd: dir })).map(l => l.name), ['_base', 'a']);
});

test('resolve rejects extends cycles', needsYaml, async () => {
  const dir = scenarios({ 'a/scenario.yaml': 'extends: b\n', 'b/scenario.yaml': 'extends: a\n' });
  await assert.rejects(resolve('a', { scenariosDir: dir, baseScenario: '_base', stores, cwd: dir }), invalid(/'extends' cycle: .*a.*b.*a/));
});

test('YAML scalars keep leading-zero strings and type numbers, booleans and nulls', needsYaml, async () => {
  const dir = scenarios({ 's/scenario.yaml': 'postgres:\n  catalogdb:\n    - table: Catalog\n      rows: [{ Zip: 02134, Price: 9.5, Id: 7, OnReorder: false, Description: null, Quoted: "42", Empty: , Tilde: ~, Date: 2024-01-02, Neg: -3, Exp: 1e3, Plus: +5 }]\n' });
  const layer = await parseFile(path.join(dir, 's/scenario.yaml'), stores);
  assert.equal(layer.name, 's');
  const [{ database, steps }] = layer.sections.postgres;
  assert.equal(database, 'catalogdb');
  assert.deepEqual(steps[0].rows, [{ Zip: '02134', Price: 9.5, Id: 7, OnReorder: false, Description: null, Quoted: '42', Empty: null, Tilde: null, Date: '2024-01-02', Neg: -3, Exp: 1000, Plus: '+5' }]);
  assert.equal(steps[0].kind, 'rows');
  assert.equal(steps[0].source, 'postgres.catalogdb[0] (Catalog)');
});

test('plain scalar typing follows the JSON number grammar', () => {
  assert.deepEqual(['0', '12', '-1.5', '1E2', '007', '1.', '.5', '0x10', 'True', 'FALSE', 'NULL', 'nil', 'yes'].map(plainScalar),
    [0, 12, -1.5, 100, '007', '1.', '.5', '0x10', true, false, null, 'nil', 'yes']);
});

for (const [name, yaml, pattern] of [
  ['unknown top-level key', 'unknown: 1\n', /top level: unknown key 'unknown'. Allowed: description, extends, postgres, redis, eventbus/],
  ['unknown database', 'postgres:\n  nosuchdb:\n    - sql: x.sql\n', /unknown database 'nosuchdb'. Known: catalogdb, orderingdb/],
  ['table step without rows', 'postgres:\n  catalogdb:\n    - table: Catalog\n', /postgres.catalogdb\[0\]: 'rows' must be a list/],
  ['missing sql file', 'postgres:\n  catalogdb:\n    - sql: missing.sql\n', /SQL file not found: .*missing.sql/],
  ['sql step with other keys', 'postgres:\n  catalogdb:\n    - sql: x.sql\n      table: T\n', /'sql' steps can't have other keys/],
  ['unknown step key', 'postgres:\n  catalogdb:\n    - tabel: Catalog\n', /unknown key 'tabel'. Allowed: sql, table, rows, rowsFile/],
  ['rows and rowsFile', 'postgres:\n  catalogdb:\n    - table: T\n      rows: []\n      rowsFile: r.json\n', /use either 'rows' or 'rowsFile'/],
  ['empty row', 'postgres:\n  catalogdb:\n    - table: T\n      rows: [{}]\n', /rows\[0\] must be a non-empty mapping/],
  ['bad table name', 'postgres:\n  catalogdb:\n    - table: a.b.c\n      rows: [{ x: 1 }]\n', /invalid table name 'a.b.c'/],
  ['steps not a list', 'postgres:\n  catalogdb: { table: T }\n', /postgres.catalogdb must be a list of steps/],
  ['document not a mapping', '- a\n- b\n', /the document must be a mapping/],
  ['extends a mapping', 'extends: { a: 1 }\n', /'extends' must be a string or a list of strings/],
  ['redis without key', 'redis:\n  - value: x\n', /redis\[0\]: 'key' is required/],
  ['redis value and json', 'redis:\n  - { key: k, value: x, json: {} }\n', /set exactly one of 'value' or 'json'/],
  ['redis neither value nor json', 'redis:\n  - { key: k }\n', /set exactly one of 'value' or 'json'/],
  ['redis bad ttl', 'redis:\n  - { key: k, value: x, ttl: -1 }\n', /'ttl' must be a positive number of seconds/],
  ['redis not a list', 'redis: { key: k }\n', /'redis' must be a list/],
  ['data for a store that takes none', 'eventbus:\n  - x\n', /'eventbus' \(rabbitmq\) takes no scenario data/],
  ['YAML syntax error', 'postgres:\n  catalogdb: [\n', /YAML error at line \d+, column \d+/],
]) {
  test(`parseFile rejects: ${name}`, needsYaml, async () => {
    const dir = scenarios({ 'bad/scenario.yaml': yaml, 'bad/x.sql': 'SELECT 1;' });
    await assert.rejects(parseFile(path.join(dir, 'bad/scenario.yaml'), stores), invalid(pattern));
  });
}

test('redis json values are stored compactly, with an optional ttl', needsYaml, async () => {
  const dir = scenarios({ 'r/scenario.yaml': 'redis:\n  - key: /basket/u1\n    json: { BuyerId: u1, Items: [] }\n    ttl: 60\n  - key: raw\n    value: 12\n' });
  const { redis } = (await parseFile(path.join(dir, 'r/scenario.yaml'), stores)).sections;
  assert.deepEqual(redis, [{ key: '/basket/u1', value: '{"BuyerId":"u1","Items":[]}', ttl: 60 }, { key: 'raw', value: '12', ttl: null }]);
});

test('JSON scenarios, sql files and rows files need no YAML package', async () => {
  const dir = scenarios({
    '_base/scenario.yaml': null,
    '_base/scenario.json': '{}',
    'j/scenario.json': JSON.stringify({
      description: 'json scenario',
      extends: '_base',
      postgres: { catalogdb: [{ sql: 'seed.sql' }, { table: 'Catalog', rowsFile: 'rows.json' }] },
      redis: [{ key: 'k', json: { a: [1, '2'] } }],
    }),
    'j/seed.sql': 'INSERT INTO t VALUES (1);\n',
    'j/rows.json': '[{ "Id": 1, "Zip": "02134" }]',
    'j/notalist.json': '{ "Id": 1 }',
    'k/scenario.json': '{ "postgres": { "catalogdb": [{ "table": "T", "rowsFile": "../j/notalist.json" }] } }',
    'broken/scenario.json': '{ "postgres": ',
    'empty/scenario.json': '',
  });
  const layers = await resolve('j', { scenariosDir: dir, baseScenario: '_base', stores, cwd: dir });
  assert.deepEqual(layers.map(l => [l.name, l.description]), [['_base', null], ['j', 'json scenario']]);
  const steps = layers[1].sections.postgres[0].steps;
  assert.deepEqual(steps[0], { kind: 'sql', source: 'postgres.catalogdb[0] (seed.sql)', sql: 'INSERT INTO t VALUES (1);\n' });
  assert.deepEqual(steps[1].rows, [{ Id: 1, Zip: '02134' }]);
  await assert.rejects(resolve('k', { scenariosDir: dir, baseScenario: '_base', stores, cwd: dir }), invalid(/notalist.json: a rows file must contain a list of rows/));
  await assert.rejects(resolve('broken', { scenariosDir: dir, baseScenario: '_base', stores, cwd: dir }), invalid(/JSON error/));
  assert.deepEqual((await parseFile(path.join(dir, 'empty/scenario.json'), stores)).sections, {});
});

test('a scenario is found by name, folder or file; a bare name prefers the scenarios folder; unknown names list what exists', async () => {
  const dir = scenarios({ '_base/scenario.yaml': null, '_base/scenario.json': '{}', 'one/scenario.json': '{}', 'two/scenario.yml': '' });
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-cwd-')));
  fs.mkdirSync(path.join(elsewhere, 'one'));
  fs.writeFileSync(path.join(elsewhere, 'one/scenario.json'), '{ "description": "local" }');
  fs.writeFileSync(path.join(elsewhere, 'mine.json'), '{ "extends": "one" }');
  const options = { scenariosDir: dir, baseScenario: '_base', stores, cwd: elsewhere };

  assert.deepEqual(listScenarios(dir), ['_base', 'one', 'two']);
  assert.equal(locate('two', [dir], dir), path.join(dir, 'two/scenario.yml'));
  assert.equal((await resolve('one', options)).at(-1).file, path.join(dir, 'one/scenario.json'));
  assert.equal((await resolve('./one', options)).at(-1).description, 'local');
  // A file outside the scenarios folder: named after the file; its `extends` looks beside it first.
  const mine = await resolve(path.join(elsewhere, 'mine.json'), options);
  assert.deepEqual(mine.map(l => l.name), ['_base', 'one', 'mine']);
  assert.equal(mine[1].description, 'local');
  await assert.rejects(resolve('nope', options), invalid(/Scenario 'nope' not found. Available: _base, one, two/));
});
