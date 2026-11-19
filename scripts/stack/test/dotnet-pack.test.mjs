// The .NET pack's stack resolver (packs/dotnet/stack/services.mjs): service inputs computed from MSBuild
// project references. The fixture is the project graph of a real services-based .NET application (its
// .csproj files only), so the mapping is checked against shared projects and linked files as they occur.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectInputs } from '../../../packs/dotnet/stack/services.mjs';
import { finishConfig, serviceInputs, servicesFor } from '../lib/index.mjs';

const FIXTURE = fileURLToPath(new URL('../../../packs/dotnet/stack/test/fixtures/eshop', import.meta.url));
const pack = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../packs/dotnet/stack.json', import.meta.url)), 'utf8')).config;

const project = name => ({ project: `src/${name}/${name}.csproj` });
const config = finishConfig({
  project: { name: 'eshop' },
  ports: {},
  ...pack.stack,
  composeFile: '.factory/stack/docker-compose.yaml',
  services: {
    'identity-api': project('Identity.API'), 'basket-api': project('Basket.API'), 'catalog-api': project('Catalog.API'),
    'ordering-api': project('Ordering.API'), 'order-processor': project('OrderProcessor'), 'payment-processor': project('PaymentProcessor'),
    'webhooks-api': project('Webhooks.API'), 'promotions-api': project('Promotions.API'), webhooksclient: project('WebhookClient'), webapp: project('WebApp'),
  },
  rebuildAll: [...pack.stack.rebuildAll, 'src/Directory.Build.props', 'src/eShop.AppHost/'],
}, FIXTURE);

test('services-for maps project folders, shared code and linked files to the services that build them', async () => {
  const inputs = await serviceInputs({ config });
  const pick = async files => (await servicesFor(files, { config, inputs })).services;
  assert.deepEqual(await pick(['src/WebApp/Components/Pages/Home.razor']), ['webapp']);
  assert.deepEqual(await pick(['src/WebAppComponents/Catalog/CatalogListItem.razor']), ['webapp']);
  assert.deepEqual(await pick(['src/Ordering.Domain/AggregatesModel/OrderAggregate/Order.cs']), ['ordering-api']);
  assert.deepEqual(await pick(['src/Basket.API/Proto/basket.proto']), ['basket-api', 'webapp']);
  assert.deepEqual(await pick(['src/IntegrationEventLogEF/IntegrationEventLogEntry.cs']), ['catalog-api', 'ordering-api', 'webhooks-api', 'promotions-api']);
  // MigrateDbContextExtensions.cs is linked into the services with EF migrations only.
  assert.deepEqual(await pick(['src/Shared/MigrateDbContextExtensions.cs']), ['identity-api', 'catalog-api', 'ordering-api', 'webhooks-api', 'promotions-api']);
  const everyService = Object.keys(config.services);
  assert.deepEqual(await pick(['src/eShop.ServiceDefaults/Extensions.cs']), everyService);
  assert.deepEqual(await pick(['src/EventBus/Abstractions/IEventBus.cs']), everyService.filter(s => !['identity-api', 'webhooksclient'].includes(s)));
  for (const global of ['Directory.Packages.props', 'global.json', 'src/eShop.AppHost/AppHost.cs', '.factory/stack/docker-compose.yaml']) {
    const result = await servicesFor([global], { config, inputs });
    assert.deepEqual(result.services, everyService, global);
    assert.equal(result.all, true);
  }
  assert.deepEqual(await pick(['README.md', 'docs/test-stack.md', 'e2e/teststack/x.spec.ts', 'src/ClientApp/App.xaml', 'tests/Ordering.UnitTests/A.cs']), []);
  assert.deepEqual(await pick(['./src\\WebApp\\Program.cs']), ['webapp']);
});

test('projectInputs follows ProjectReference transitively and linked items outside the project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-pack-'));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  write('src/App/App.csproj', '<Project><ItemGroup><ProjectReference Include="..\\Lib\\Lib.csproj" /><Compile Include="..\\Common\\*.cs" /><Protobuf Include="../Api/Proto/api.proto" /><Content Include="$(Elsewhere)\\x.json" /></ItemGroup></Project>');
  write('src/Lib/Lib.csproj', '<Project><ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /><ProjectReference Include="..\\App\\App.csproj" /></ItemGroup></Project>');
  write('src/Core/Core.csproj', '<Project />');
  assert.deepEqual(projectInputs('src/App/App.csproj', { root }).sort(),
    ['src/Api/Proto/api.proto', 'src/App/', 'src/Common/', 'src/Core/', 'src/Lib/']);
  const cfg = finishConfig({ project: { name: 'x' }, ports: {}, resolver: pack.stack.resolver, rebuildAll: [],
    services: { app: { project: 'src/App/App.csproj' }, core: { project: 'src/Core/Core.csproj', inputs: ['tools/codegen/**'] }, static: { inputs: ['site/'] } } }, root);
  assert.deepEqual((await servicesFor(['src/Core/X.cs'], { config: cfg })).services, ['app', 'core']);
  assert.deepEqual((await servicesFor(['src/Common/Y.cs'], { config: cfg })).services, ['app']);
  assert.deepEqual((await servicesFor(['tools/codegen/gen.csx'], { config: cfg })).services, ['core'], 'configured inputs are kept beside the computed ones');
  assert.deepEqual((await servicesFor(['site/index.html'], { config: cfg })).services, ['static'], 'a service without a project uses only its globs');
});

test('dotnet pack publish-container: one dotnet publish -t:PublishContainer per service, named and tagged as the stack expects', async () => {
  const { publishCommands, platform } = await import('../../../packs/dotnet/stack/publish-container.mjs');
  const stack = {
    services: {
      'catalog-api': { project: 'src/Catalog.API/Catalog.API.csproj', image: { env: 'CATALOG_API_IMAGE', name: 'shop/catalog-api' } },
      webapp: { project: 'src/WebApp/WebApp.csproj', image: { env: 'WEBAPP_IMAGE' } },
    },
  };
  const all = publishCommands(stack, ['--all'], { env: {}, arch: 'arm64' });
  assert.deepEqual(all.map((c) => c.image), ['shop/catalog-api:latest', 'webapp:latest']);
  assert.deepEqual(all[0].args.slice(0, 9), ['publish', 'src/Catalog.API/Catalog.API.csproj', '-c', 'Release', '-t:PublishContainer', '--os', 'linux', '--arch', 'arm64']);
  assert.ok(all[0].args.includes('-p:ContainerRepository=shop/catalog-api') && all[0].args.includes('-p:ContainerImageTag=latest'));
  assert.ok(all[0].args.includes('--disable-build-servers'), 'no compiler server or MSBuild node shared with other builds (dogfood C6)');
  assert.equal(publishCommands({ ...stack, build: { builtTag: 'ci' } }, ['webapp'], { env: {}, arch: 'x64' })[0].image, 'webapp:ci');
  assert.equal(platform({ TESTSTACK_PLATFORM: 'linux-amd64' }, 'arm64'), 'x64');
  assert.throws(() => publishCommands(stack, ['nope'], { env: {} }), /stack\.services\.nope\.project/);
  // Dogfood C5: the image build uses its own build output; a baseline build compiles without making an image.
  const isolated = publishCommands(stack, ['webapp'], { env: { TESTSTACK_BUILD_ARTIFACTS: '/state/artifacts' }, arch: 'arm64' })[0].args;
  assert.deepEqual(isolated.slice(isolated.indexOf('--artifacts-path'), isolated.indexOf('--artifacts-path') + 2), ['--artifacts-path', '/state/artifacts']);
  const baseline = publishCommands(stack, ['webapp'], { env: { TESTSTACK_BASELINE: '1' }, arch: 'arm64' })[0].args;
  assert.ok(!baseline.includes('-t:PublishContainer'));
});

test('dotnet pack aspire-publish: declared overrides apply to the published stack; stale ones and unresolved parameters fail', async () => {
  const { transform } = await import('../../../packs/dotnet/stack/aspire-publish.mjs');
  const published = {
    services: {
      postgres: { image: 'docker.io/ankane/pgvector:latest', expose: ['5432'] },
      dashboard: { image: 'aspire-dashboard:13.6', ports: ['18888'] },
      'orders-api': { image: '${ORDERS_API_IMAGE}', environment: { HTTP_PORTS: '${ORDERS_API_PORT}', Identity__Url: 'http://identity:${IDENTITY_PORT}' }, expose: ['${ORDERS_API_PORT}'], depends_on: { postgres: { condition: 'service_started' }, dashboard: { condition: 'service_started' } } },
    },
  };
  const stack = { ports: { orders: { env: 'ORDERS_HOST_PORT', base: 28084 } }, services: { 'orders-api': { image: { env: 'ORDERS_API_IMAGE' } } }, env: { DB_PASSWORD: 'x' } };
  const overrides = {
    name: 'shop-teststack',
    parameters: { '*_PORT': { value: '8080', why: 'images listen on 8080 inside the container' } },
    remove: { dashboard: 'the tests do not read telemetry from the dashboard' },
    ports: { why: 'each slot publishes its own host ports', services: { 'orders-api': 'orders' } },
    services: [
      { services: '*', set: { restart: 'unless-stopped' }, why: 'a crashed container comes back while a test waits' },
      { services: ['orders-api'], env: { Identity__Url: 'http://host.docker.internal:${IDENTITY_HOST_PORT:-28081}' }, addEnv: { Seeding__Disabled: 'true' }, why: 'browser-facing issuer; scenario files own the data' },
    ],
  };
  const { doc, problems } = transform(published, overrides, stack);
  assert.deepEqual(problems, []);
  assert.equal(doc.name, 'shop-teststack');
  assert.equal(doc.services.dashboard, undefined);
  assert.deepEqual(Object.keys(doc.services['orders-api'].depends_on), ['postgres'], 'a removed service leaves no dangling depends_on');
  assert.deepEqual(doc.services['orders-api'].ports, ['${ORDERS_HOST_PORT:-28084}:8080'], 'the slot port maps to the published container port');
  assert.equal(doc.services['orders-api'].environment.HTTP_PORTS, '8080');
  assert.equal(doc.services['orders-api'].environment.Seeding__Disabled, 'true');
  assert.equal(doc.services.postgres.restart, 'unless-stopped');
  assert.equal(published.services.dashboard.image, 'aspire-dashboard:13.6', 'the published document is not changed');

  // The AppHost changed under the overrides: each mismatch is a problem, never a silent pass.
  const changed = structuredClone(published);
  delete changed.services['orders-api'].environment.Identity__Url;
  changed.services['orders-api'].environment.Seeding__Disabled = 'false';
  changed.services['orders-api'].environment.Payments__Url = '${PAYMENTS_URL}';
  delete changed.services.dashboard;
  const stale = transform(changed, overrides, stack).problems;
  for (const re of [/remove\.dashboard: the AppHost publishes no service/, /has no Identity__Url from the AppHost to replace/, /the AppHost now sets Seeding__Disabled on "orders-api" itself/, /\$\{PAYMENTS_URL\} has no value/]) assert.ok(stale.some((p) => re.test(p)), `${re}\n${stale.join('\n')}`);
  const unreasoned = transform(published, { ...overrides, services: [{ services: ['orders-api'], set: { restart: 'no' } }] }, stack).problems;
  assert.ok(unreasoned.some((p) => /services\[0\]: give the reason/.test(p)));
});

test('dotnet pack drift is publish --check: it never answers a plain ok for an AppHost whose stack is not published from it', async () => {
  const { default: drift } = await import('../../../packs/dotnet/stack/apphost-drift.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apphost-drift-'));
  assert.deepEqual(await drift({}, { root, stack: {} }), { compared: false, note: 'no Aspire AppHost: nothing to compare' });
  fs.mkdirSync(path.join(root, 'src/AppHost'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/AppHost/AppHost.csproj'), '<Project Sdk="Aspire.AppHost.Sdk/13.6.0" />');
  await assert.rejects(drift({}, { root, stack: {} }), (e) => e.exitCode === 1 && /not published from it \(stack\.publish is not set\)/.test(e.message));
  const { aspireVersion } = await import('../../../packs/dotnet/stack/aspire-publish.mjs');
  assert.equal(aspireVersion(path.join(root, 'src/AppHost/AppHost.csproj')), '13.6.0', 'the CLI runs at the AppHost SDK version');
  fs.rmSync(root, { recursive: true, force: true });
});

test('dotnet pack doctor: a repository with EF Core migrations needs dotnet-ef pinned at its EF Core version', async () => {
  const { checks, efCoreVersion } = await import('../../../packs/dotnet/doctor.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-doctor-'));
  assert.deepEqual(checks(root), [], 'no migrations: nothing to check');
  fs.mkdirSync(path.join(root, 'src/Api/Migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/Api/Migrations/ShopContextModelSnapshot.cs'), '');
  fs.writeFileSync(path.join(root, 'Directory.Packages.props'), '<Project><ItemGroup><PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.12" /></ItemGroup></Project>');
  assert.equal(efCoreVersion(root), '10.0.12');
  let [row] = checks(root);
  assert.equal(row[1], false);
  assert.match(row[2], /dotnet tool install --local dotnet-ef --version 10\.0\.12/);
  fs.writeFileSync(path.join(root, 'dotnet-tools.json'), JSON.stringify({ version: 1, isRoot: true, tools: { 'dotnet-ef': { version: '9.0.8', commands: ['dotnet-ef'] } } }));
  [row] = checks(root);
  assert.equal(row[1], false);
  assert.match(row[2], /pins dotnet-ef 9\.0\.8, the code uses EF Core 10\.0\.12/);
});

test("dotnet pack aspire-publish: a failure shows the AppHost's error, not the CLI's update notice", async () => {
  const { aspirePublish, stripCliNotices } = await import('../../../packs/dotnet/stack/aspire-publish.mjs');
  const notice = 'AppHost.cs(12,5): error CS1002: ; expected\n\nA new version of Aspire is available: 13.6.5\nTo update, run: aspire update\nFor more information, see: https://aka.ms/aspire/update\n';
  assert.equal(stripCliNotices(notice), 'AppHost.cs(12,5): error CS1002: ; expected');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-fail-'));
  fs.writeFileSync(path.join(root, 'AppHost.csproj'), '<Project Sdk="Aspire.AppHost.Sdk/13.6.0" />');
  const run = () => ({ status: 6, stdout: notice, stderr: '' });
  assert.throws(() => aspirePublish(root, path.join(root, 'AppHost.csproj'), { run }), (e) => /error CS1002/.test(e.message) && !/new version of Aspire/.test(e.message));
  fs.rmSync(root, { recursive: true, force: true });
});
