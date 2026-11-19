// API summary: route parsing, endpoint diffing against a throwaway git repo, OpenAPI enrichment and
// rendering of the PR's "API changes" section (no test stack or GitHub access).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { API_MARKERS, expandOpenApiPorts, allEndpoints, apiSources, buildApiSummary, changeScope, changedEndpoints, changedFromOpenApi, classifyFiles, loadExtractor, loadOpenApi, openApiDiff, openApiFiles, renderApiSection } from '../lib/api-summary.mjs';
import { parseEndpoints } from '../../../packs/dotnet/pr-video/aspnet-minimal-api.mjs';
import { removeSection, upsertSection } from '../lib/pr-video.mjs';

// What a .NET shop puts in .factory/config.json: nothing below is an engine default.
const SHOP = {
  project: {
    services: [
      { name: 'Items.API', kind: 'backend', paths: ['src/Items.API/**'] },
      { name: 'Catalog.API', kind: 'backend', paths: ['src/Catalog.API/**'] },
      { name: 'Ordering.API', kind: 'backend', paths: ['src/Ordering.API/**', 'src/Ordering.Domain/**'] },
      { name: 'Identity.API', kind: 'backend', paths: ['src/Identity.API/**'] },
      { name: 'WebApp', kind: 'frontend', paths: ['src/WebApp/**', 'src/WebAppComponents/**'] },
      { name: 'AppHost', kind: 'library', paths: ['src/eShop.AppHost/**'] },
    ],
    frontendPaths: ['src/**/*.razor', 'src/**/*.cshtml', 'src/**/Views/**'],
  },
  prVideo: { neutralPaths: ['src/eShop.AppHost/**'], api: { extractor: 'aspnet-minimal-api', sources: ['src/**/*.cs'], exclude: ['**/tests/**'] } },
};

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

const API = (extra = '', body = 'return TypedResults.Ok();') => `public static class ItemsApi
{
    public static IEndpointRouteBuilder MapItemsApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("api/items").HasApiVersion(1, 0).HasApiVersion(2, 0);
        var v1 = app.MapGroup("api/items").HasApiVersion(1.0);
        api.MapGet("/{id:int}", GetItem);
        v1.MapGet("/by/{name:minlength(1)}", GetByName);
        api.MapDelete("/{id:int}", DeleteItem);
${extra}        return app;
    }

    public static async Task<IResult> GetItem(int id)
    {
        ${body}
    }

    public static async Task<IResult> GetByName(string name)
    {
        return TypedResults.Ok();
    }

    public static async Task<IResult> DeleteItem(int id)
    {
        return TypedResults.NoContent();
    }
}
`;

test('parseEndpoints joins group prefixes, strips route constraints and keeps API versions', () => {
  const endpoints = parseEndpoints(API());
  assert.deepEqual(endpoints.map((e) => [e.method, e.route, e.versions.join()]), [
    ['GET', '/api/items/{id}', '1.0,2.0'],
    ['GET', '/api/items/by/{name}', '1.0'],
    ['DELETE', '/api/items/{id}', '1.0,2.0'],
  ]);
});

test('changedEndpoints reports added, modified (handler body) and removed endpoints, not untouched ones', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-summary-test-'));
  temps.push(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', API());
  write(repo, 'src/Items.API/Model/Item.cs', 'public record Item(int Id);\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', API('        api.MapPost("/", CreateItem);\n', 'return TypedResults.NotFound();')
    .replace('        api.MapDelete("/{id:int}", DeleteItem);\n', ''));
  sh(repo, 'commit', '-q', '-am', 'change');

  assert.deepEqual(changeScope(repo, 'main', SHOP), { frontend: false, backend: true, video: false, api: true });
  const extractor = await loadExtractor(SHOP);
  assert.equal(extractor.id, 'aspnet-minimal-api');
  const found = changedEndpoints(repo, 'main', { extractor, config: SHOP });
  assert.deepEqual(found.map((e) => `${e.change} ${e.method} ${e.route}`).sort(), ['added POST /api/items', 'modified GET /api/items/{id}', 'removed DELETE /api/items/{id}']);
  assert.deepEqual([...new Set(found.map((e) => e.service))], ['Items.API'], 'the service name comes from the project model');
  assert.deepEqual(allEndpoints(repo, { extractor, config: SHOP }).map((e) => `${e.method} ${e.route}`).sort(), ['GET /api/items/by/{name}', 'GET /api/items/{id}', 'POST /api/items']);

  // No extractor configured: the engine reads no routes out of source files, whatever they hold.
  assert.equal(await loadExtractor({}), null);
  assert.deepEqual(changedEndpoints(repo, 'main'), []);
  assert.deepEqual(allEndpoints(repo), []);
  assert.deepEqual(apiSources({}), { ok: false, mode: 'none', reason: 'no route extractor (prVideo.api.extractor) and no OpenAPI file to compare (prVideo.api.openapi) are configured' });
  assert.equal(apiSources(SHOP).mode, 'extractor');
  await assert.rejects(loadExtractor({ root: repo, prVideo: { api: { extractor: 'no/such-extractor.mjs' } } }), /neither a built-in extractor/);
});

// Council C2: #56's API summary marked DELETE as changed: the last Map call's lines ran to the end of the file, so
// any later handler's edit touched it. A Map call is its own statement; a handler's attributes are its contract.
test('changedEndpoints: an edit to one handler changes only its endpoint; an attribute on a handler changes its endpoint', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-summary-test-'));
  temps.push(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', API());
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  const extractor = await loadExtractor(SHOP);
  const changed = () => changedEndpoints(repo, 'main', { extractor, config: SHOP }).map((e) => `${e.change} ${e.method} ${e.route}`).sort();
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', API().replace('return TypedResults.Ok();\n    }\n\n    public static async Task<IResult> DeleteItem', 'return TypedResults.NotFound();\n    }\n\n    public static async Task<IResult> DeleteItem'));
  sh(repo, 'commit', '-q', '-am', 'by-name handler');
  assert.deepEqual(changed(), ['modified GET /api/items/by/{name}']);
  write(repo, 'src/Items.API/Apis/ItemsApi.cs', fs.readFileSync(path.join(repo, 'src/Items.API/Apis/ItemsApi.cs'), 'utf8').replace('    public static async Task<IResult> DeleteItem', '    [ProducesResponseType(StatusCodes.Status409Conflict)]\n    public static async Task<IResult> DeleteItem'));
  sh(repo, 'commit', '-q', '-am', 'delete contract');
  assert.deepEqual(changed(), ['modified DELETE /api/items/{id}', 'modified GET /api/items/by/{name}']);
});

test('a route extractor can be any module with the same exports, named by path in the configuration', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-extractor-test-'));
  temps.push(repo);
  // A toy extractor for `#[get("/path")]`-style attributes (the shape of a Rust web framework's routes).
  write(repo, '.factory/extractors/attr-routes.mjs', `export const id = 'attr-routes';
export const hasRoutes = (s) => /#\\[(get|post)\\(/.test(s);
export const parseEndpoints = (s) => [...s.matchAll(/#\\[(get|post)\\("([^"]+)"\\)\\]/g)].map((m) => ({ method: m[1].toUpperCase(), route: m[2], versions: [], line: s.slice(0, m.index).split('\\n').length, ranges: [[s.slice(0, m.index).split('\\n').length, s.slice(0, m.index).split('\\n').length + 1]] }));
`);
  const config = { root: repo, project: { services: [{ name: 'api', kind: 'backend', paths: ['crates/api/**'] }] }, prVideo: { api: { extractor: '.factory/extractors/attr-routes.mjs', sources: ['crates/**/*.rs'] } } };
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  write(repo, 'crates/api/src/routes.rs', '#[get("/items/{id}")]\nasync fn item() {}\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'crates/api/src/routes.rs', '#[get("/items/{id}")]\nasync fn item() {}\n\n\n\n#[post("/items")]\nasync fn create() {}\n');
  sh(repo, 'commit', '-q', '-am', 'change');
  const extractor = await loadExtractor(config);
  assert.equal(extractor.id, 'attr-routes');
  assert.deepEqual(changedEndpoints(repo, 'main', { extractor, config }).map((e) => `${e.change} ${e.method} ${e.route} ${e.service}`), ['added POST /items api']);
  assert.deepEqual(changeScope(repo, 'main', config), { frontend: false, backend: true, video: false, api: true });
});

test('without an extractor the changed endpoints are the difference between the OpenAPI file at the merge base and at HEAD', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-openapi-test-'));
  temps.push(repo);
  const doc = (paths) => JSON.stringify({ openapi: '3.1.0', info: { title: 'Orders', version: '2.0' }, paths }, null, 2);
  const get = { summary: 'Read', responses: { 200: { description: 'OK' } } };
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  write(repo, 'api/openapi.json', doc({ '/orders/{id}': { get, delete: { responses: { 204: { description: 'Gone' } } } }, '/orders': { get } }));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'api/openapi.json', doc({ '/orders/{id}': { get: { ...get, summary: 'Read one order' } }, '/orders': { get, post: { responses: { 201: { description: 'Created' } } } } }));
  sh(repo, 'commit', '-q', '-am', 'change');
  const config = { root: repo, prVideo: { api: { openapi: ['api/openapi.json', 'http://localhost:1/openapi.json'] } } };
  assert.deepEqual(apiSources(config), { ok: true, mode: 'openapi', reason: null });
  const files = openApiFiles(repo, 'main', config.prVideo.api.openapi);
  assert.deepEqual(files.map((f) => f.file), ['api/openapi.json'], 'URLs have no base version to compare');
  const changed = changedFromOpenApi(files);
  assert.deepEqual(changed.map((e) => `${e.change} ${e.method} ${e.route} ${e.service} ${e.versions.join()}`).sort(), ['added POST /orders Orders 2.0', 'modified GET /orders/{id} Orders 2.0', 'removed DELETE /orders/{id} Orders 2.0']);
  assert.deepEqual(openApiDiff(null, null), []);
  const docs = await loadOpenApi(['api/openapi.json'], () => assert.fail('a file is not fetched'), repo);
  const section = renderApiSection({ endpoints: buildApiSummary({ changed, docs }), origin: 'from the OpenAPI files compared with the merge base' });
  assert.match(section, /adds, changes or removes \(from the OpenAPI files compared with the merge base\)/);
  assert.match(section, /\| 🆕 Added \| `POST` \| `\/orders` \| Orders \| {2}\| 201 \|/);
});

test('classifyFiles: video with frontend changes, API summary with any backend change (council C10, Opus 4: a full-stack PR gets both)', () => {
  const scope = (...files) => classifyFiles(files, SHOP);
  assert.deepEqual(scope('src/WebApp/Components/Pages/Cart.razor', 'e2e/teststack/cart.spec.ts'), { frontend: true, backend: false, video: true, api: false });
  assert.deepEqual(scope('src/Ordering.API/Apis/OrdersApi.cs', 'src/Ordering.Domain/Order.cs', 'tests/Ordering.UnitTests/OrderTests.cs', 'docs/x.md'), { frontend: false, backend: true, video: false, api: true });
  assert.deepEqual(scope('src/Catalog.API/Apis/CatalogApi.cs', 'src/WebAppComponents/Catalog/CatalogListItem.razor'), { frontend: true, backend: true, video: true, api: true });
  assert.equal(scope('src/Identity.API/Views/Account/Login.cshtml').frontend, true);
  assert.equal(scope('src/Identity.API/Views/Account/Login.cshtml').backend, false);
  assert.deepEqual(scope('src/eShop.AppHost/Program.cs', 'README.md', 'e2e/teststack/cart.spec.ts'), { frontend: false, backend: false, video: false, api: false });
  assert.deepEqual(classifyFiles(['src/Catalog.API/Apis/CatalogApi.cs', 'src/WebApp/Cart.razor']), { frontend: false, backend: false, video: false, api: false }, 'no project model: the engine guesses nothing from folder or file names');
  assert.deepEqual(classifyFiles(['lib/x.cs', 'src/eShop.AppHost/Program.cs'], { ...SHOP, prVideo: { ...SHOP.prVideo, backendPaths: ['lib/**', 'src/**'] } }), { frontend: false, backend: true, video: false, api: true }, 'prVideo.backendPaths replaces the services as the backend');
});

const docs = [{
  url: 'http://localhost:18082/openapi/v1.json',
  doc: {
    info: { version: '1.0' },
    paths: {
      '/api/items': {
        post: {
          summary: 'Create an item',
          parameters: [{ name: 'api-version', in: 'query', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
          responses: { 201: { description: 'Created' }, 400: { description: 'Bad Request', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } } } },
        },
      },
    },
    components: { schemas: { Item: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number', format: 'double' } } } } },
  },
}];

test('the API section documents each changed endpoint from OpenAPI with one recorded example per status', () => {
  const changed = [
    { change: 'added', method: 'POST', route: '/api/items', versions: ['1.0'], service: 'Items.API', file: 'src/Items.API/Apis/ItemsApi.cs', line: 7 },
    { change: 'removed', method: 'DELETE', route: '/api/items/{id}', versions: [], service: 'Items.API', file: 'src/Items.API/Apis/ItemsApi.cs', line: 9 },
  ];
  const known = [{ method: 'GET', route: '/api/items/{id}', versions: ['1.0'], service: 'Items.API', file: 'src/Items.API/Apis/ItemsApi.cs', line: 6 }];
  const call = (method, url, status, extra = {}) => ({ method, url, status, test: 'creates an item', file: 'e2e/teststack/items.spec.ts', ...extra });
  const exchanges = [
    call('POST', 'http://localhost:18082/api/items?api-version=1.0', 201, { requestBody: '{\n  "name": "Rope"\n}', requestHeaders: { authorization: '***' } }),
    call('POST', 'http://localhost:18082/api/items?api-version=1.0', 201),
    call('POST', 'http://localhost:18082/api/items?api-version=1.0', 400, { responseContentType: 'application/problem+json', responseBody: '{ "title": "Bad" }' }),
    call('GET', 'http://localhost:18082/api/items/42?api-version=1.0', 200),
  ];
  const endpoints = buildApiSummary({ changed, known, exchanges, docs });
  assert.deepEqual(endpoints.map((e) => `${e.change} ${e.method} ${e.route} ${e.calls.length}`), [
    'added POST /api/items 3', 'removed DELETE /api/items/{id} 0', 'exercised GET /api/items/{id} 1',
  ]);
  assert.deepEqual(endpoints[0].examples.map((x) => x.status), [201, 400]);

  const section = renderApiSection({ endpoints, headSha: 'abcdef1234', specs: ['e2e/teststack/items.spec.ts'] });
  assert.match(section, /\| 🆕 Added \| `POST` \| `\/api\/items` \| Items\.API \| `Item` \| 201, 400 \| 3 \(201, 400\) \|/);
  assert.match(section, /\*\*Request body:\*\* `application\/json` `Item` \(required\)/);
  assert.match(section, /Fields: `name: string`, `price: number\(double\)`/);
  assert.match(section, /`400` `ProblemDetails` Bad Request/);
  assert.match(section, /```http\nPOST \/api\/items\?api-version=1\.0\nauthorization: \*\*\*\n\n\{\n {2}"name": "Rope"\n\}\n```/);
  assert.doesNotMatch(section, /### `DELETE/, 'removed endpoints are only listed in the table');
  assert.equal(renderApiSection({ endpoints: [] }), null);
});

test('the API section has its own markers, so it coexists with the demo video section and can be removed', () => {
  const withVideo = upsertSection('Story text', 'video');
  const both = upsertSection(withVideo, 'api v1', API_MARKERS);
  assert.equal(upsertSection(both, 'api v2', API_MARKERS), both.replace('api v1', 'api v2'));
  assert.equal(removeSection(both, API_MARKERS), withVideo);
});

// Dogfood BUG-10: the API summary said "Not in the OpenAPI documents" for every endpoint: only a checked-in
// Catalog document was configured, and a live document's port depends on the stack slot.
test('OpenAPI URLs name stack ports as {port:<name>}, resolved to the slot in use; unknown ports are skipped', () => {
  const warnings = [];
  const out = expandOpenApiPorts(
    ['src/Catalog.API/Catalog.API.json', 'http://localhost:{port:ordering}/openapi/v1.json', 'http://localhost:{port:billing}/openapi/v1.json', 'https://example.com/openapi.json'],
    { ordering: 29084, catalog: 29082 },
    (w) => warnings.push(w),
  );
  assert.deepEqual(out, ['src/Catalog.API/Catalog.API.json', 'http://localhost:29084/openapi/v1.json', 'https://example.com/openapi.json']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /names no stack port billing/);
  assert.deepEqual(expandOpenApiPorts(['http://localhost:{port:ordering}/openapi/v1.json'], null), [], 'no stack: a templated URL cannot be read');
});
