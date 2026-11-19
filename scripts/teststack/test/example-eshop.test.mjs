// The eShop example (examples/eshop): its config fragment, compose file and scenarios must agree with each
// other and load through the generic engine. This replaces the checks the eShop repository ran on
// testing/teststack.json, deploy/teststack and testing/scenarios.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../../../packs/dotnet/stack/hash-password.mjs';
import { slotInfo } from '../../stack/lib/ports.mjs';
import { createContext } from '../lib/context.mjs';
import { validate } from '../lib/load.mjs';
import { resolve } from '../lib/scenario.mjs';
import { fakeRunner, needsYaml } from './helpers.mjs';

const EXAMPLE = fileURLToPath(new URL('../../../examples/eshop', import.meta.url));
const fragment = JSON.parse(fs.readFileSync(path.join(EXAMPLE, '.factory/config.json'), 'utf8'));

// An app repository made of the example: its .factory/stack folder and the fragment as the config.
function exampleRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eshop-example-')));
  fs.mkdirSync(path.join(root, '.factory'));
  fs.symlinkSync(path.join(EXAMPLE, '.factory/stack'), path.join(root, '.factory/stack'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ project: { name: 'eshop' }, ...fragment }));
  return root;
}
const context = (slot = 0) => createContext({ root: exampleRepo(), slot, env: {}, runner: fakeRunner() });

test('eShop: slot 0 reproduces the names, ports and URLs the stack had before the port', async () => {
  const ctx = await context();
  assert.deepEqual({ ...ctx.info, ports: undefined }, {
    slot: 0, project: 'eshop-teststack', stateDir: '.factory/state/teststack', envFile: '.factory/state/teststack/.env',
    composeFile: '.factory/stack/docker-compose.yaml', imageTag: 'teststack', baseUrl: 'http://localhost:18080',
    urls: { webapp: 'http://localhost:18080', identity: 'http://host.docker.internal:18081', dashboard: 'http://localhost:18888' }, ports: undefined,
  });
  assert.equal(ctx.annotation.webappUrl, 'http://localhost:18080');
  assert.equal(ctx.annotation.identityUrl, 'http://host.docker.internal:18081');
  const three = slotInfo(3, ctx.stack);
  assert.deepEqual([three.project, three.imageTag, three.urls.webapp, three.urls.identity, three.ports.postgres], ['eshop-teststack-3', 'teststack-3', 'http://localhost:21080', 'http://host.docker.internal:21081', 21432]);
  assert.deepEqual(ctx.envValues(), {
    BASKET_API_IMAGE: '', BASKET_API_PORT: '', CATALOG_API_IMAGE: '', CATALOG_API_PORT: '', EVENTBUS_PASSWORD: 'teststack-rabbit', IDENTITY_API_IMAGE: '', IDENTITY_API_PORT: '',
    ORDER_PROCESSOR_IMAGE: '', ORDER_PROCESSOR_PORT: '', ORDERING_API_IMAGE: '', ORDERING_API_PORT: '', PAYMENT_PROCESSOR_IMAGE: '', PAYMENT_PROCESSOR_PORT: '',
    POSTGRES_PASSWORD: 'teststack-postgres', PROMOTIONS_API_IMAGE: '', PROMOTIONS_API_PORT: '', REDIS_PASSWORD: 'teststack-redis', WEBAPP_IMAGE: '', WEBAPP_PORT: '',
    WEBHOOKS_API_IMAGE: '', WEBHOOKS_API_PORT: '', WEBHOOKSCLIENT_IMAGE: '', WEBHOOKSCLIENT_PORT: '',
    ...Object.fromEntries(Object.values(fragment.stack.ports).map(p => [p.env, String(p.base)])),
  });
});

test('eShop: the compose file, the port table, the services and the readiness URLs agree', async () => {
  const compose = fs.readFileSync(path.join(EXAMPLE, '.factory/stack/docker-compose.yaml'), 'utf8');
  const used = new Map([...compose.matchAll(/\$\{([A-Z_]+_HOST_PORT):-(\d+)\}/g)].map(m => [m[1], Number(m[2])]));
  assert.deepEqual(used, new Map(Object.values(fragment.stack.ports).map(p => [p.env, p.base])));
  assert.doesNotMatch(compose, /"\d{5}:/, 'a host port is hard-coded in the compose file');

  const composeServices = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(m => m[1]);
  const { teststack, stack } = fragment;
  for (const name of [...teststack.infrastructureServices, ...teststack.services.map(s => s.name), ...Object.keys(stack.services), ...Object.values(teststack.stores).map(s => s.service)]) {
    assert.ok(composeServices.includes(name), `${name} is not a service of the compose file`);
  }
  // Every image the compose file takes from a variable is built, retagged and required by the env template.
  const imageVars = [...compose.matchAll(/image: "\$\{([A-Z_]+_IMAGE)\}"/g)].map(m => m[1]).sort();
  assert.deepEqual(Object.values(stack.services).map(s => s.image.env).sort(), imageVars);
  const template = fs.readFileSync(path.join(EXAMPLE, '.factory/stack/.env'), 'utf8');
  for (const name of [...imageVars, ...Object.keys(stack.env)]) assert.match(template, new RegExp(`^${name}=`, 'm'));

  const ctx = await context(2);
  for (const service of ctx.config.services.filter(s => s.url)) assert.match(service.url, /^http:\/\/localhost:20\d{3}\//, service.name);
  assert.equal(ctx.config.services.find(s => s.name === 'catalog-api').url, 'http://localhost:20082/api/catalog/items?api-version=1.0&pageSize=1');
  assert.equal(ctx.config.services.find(s => s.name === 'basket-api').http2, true);
  const databases = ctx.stores.find(s => s.name === 'postgres').config.databases.map(db => db.name);
  for (const service of ctx.config.services) for (const database of service.databases ?? []) assert.ok(databases.includes(database), `${service.name}: ${database}`);
  const queues = fragment.teststack.stores.eventbus.queues;
  for (const service of ctx.config.services) for (const queue of service.queues ?? []) assert.ok(queues.includes(queue), `${service.name}: ${queue}`);
});

test('eShop: the .NET specifics of the old loader are configuration now', async () => {
  const ctx = await context();
  const postgres = ctx.stores.find(s => s.name === 'postgres').config;
  assert.deepEqual(postgres.databases[0], { name: 'catalogdb', preserveTables: ['__EFMigrationsHistory'], migrationsReady: { table: '__EFMigrationsHistory', column: 'MigrationId' } });
  assert.deepEqual(postgres.sequences.map(s => s.sequence), ['ordering.buyerseq', 'ordering.paymentseq', 'ordering.orderseq', 'ordering.orderitemseq']);
  assert.equal(postgres.onMissingTemplate, 'drop');
  assert.deepEqual(ctx.config.restartAfterLoad, [{ when: 'sequencesUsed', service: 'ordering-api' }]);
  assert.equal(ctx.config.commands['hash-password'], 'pack:dotnet/stack/hash-password.mjs');
  assert.match(ctx.stack.build.all, /^aspire do prepare-teststack /);
  assert.match(ctx.stack.build.service, /^aspire do build-\{service\} /);
  assert.match(ctx.stack.publish, /^aspire publish .* -o \{out\}/);
  assert.equal(ctx.stack.build.env.TestStack, 'true');
});

test('eShop: every scenario parses and resolves', needsYaml, async () => {
  const ctx = await context();
  const result = await validate(ctx, []);
  const byName = Object.fromEntries(result.scenarios.map(s => [s.scenario, s]));
  // The example keeps only generic scenarios (dogfood C4: the ones built for one run's bug findings were removed).
  assert.deepEqual(Object.keys(byName), ['_base', 'default', 'empty']);
  assert.deepEqual(byName._base, { scenario: '_base', layers: ['_base'], stores: { postgres: 1, redis: 0 } });
  assert.deepEqual(byName.default, { scenario: 'default', layers: ['_base', 'default'], stores: { postgres: 3, redis: 0 } });
  assert.deepEqual(byName.empty.layers, ['_base', 'empty']);
});

test('eShop: the committed password hashes match the documented password', needsYaml, async () => {
  const ctx = await context();
  const layers = await resolve('default', { scenariosDir: ctx.scenariosDir, baseScenario: '_base', stores: ctx.config.stores });
  const users = layers.at(-1).sections.postgres.find(entry => entry.database === 'identitydb').steps[0].rows;
  assert.equal(users.length, 2);
  for (const user of users) assert.equal(verifyPassword(user.PasswordHash, 'Pass123$'), true, user.UserName);
  assert.equal(verifyPassword(users[0].PasswordHash, 'wrong'), false);
  assert.equal(users[0].ZipCode, '98052', 'quoted scalars stay strings');
});
