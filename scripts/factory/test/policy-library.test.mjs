// The language packs' policy libraries (packs/<id>/policy): `factory policy-library add` merges one into
// the starter policy, the result passes the engine's selfcheck, and the .NET library blocks the changes the
// reference eShop pack blocked (an unversioned anonymous write endpoint, string-built SQL, a swallowed
// exception, a hand-made HttpClient) on a codebase that is not eShop.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { addLibrary, libraries } from '../policy-library.mjs';
import { policyPython } from '../../pipeline/lib/python.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ARCH = path.join(INSTALL, 'architecture-policy/hooks/arch.py');
// The Python the engine itself uses (FACTORY_PYTHON, the factory's virtualenv, then PATH).
const PY = policyPython();
const hasPython = Boolean(PY.cmd);
// These fixtures test the parse (their SDKs, such as MSTest.Sdk without a version, do not evaluate); the MSBuild
// cross-check is tested with the real toolchain in architecture-policy/tests/test_topology.py.
process.env.ARCH_MSBUILD_EVAL = '0';

function repo(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-lib-')));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root, git };
}

const PROFILE = `kind: Profile
schema_version: 1
id: default
language: csharp
description: A small .NET shop.
source_extensions: [".cs", ".csproj"]
comment_prefixes: ["//", "/*", "*"]
project_manifests: ["src/**/*.csproj"]
global_exclude: [".factory/**", "**/bin/**", "**/obj/**"]
projects:
  - { name: Shop.Api, path: src/Shop.Api, type: api, service: shop, layer: presentation }
  - { name: Shop.Domain, path: src/Shop.Domain, type: domain, service: shop, layer: domain }
services:
  - { id: shop, owns_datastores: [shopdb], traits: [owns_database, exposes_http_api] }
shared_datastore_names: []
layer_dependencies:
  domain: []
  presentation: ["same_service:domain", "shared"]
  shared: ["shared"]
forbidden_packages_by_layer:
  domain: [Microsoft.EntityFrameworkCore]
test_mapping: []
`;

const BASE = {
  'src/Shop.Api/Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="..\\Shop.Domain\\Shop.Domain.csproj" /></ItemGroup></Project>\n',
  'src/Shop.Api/Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nbuilder.AddServiceDefaults();\nbuilder.Services.AddProblemDetails();\nvar app = builder.Build();\napp.MapDefaultEndpoints();\napp.NewVersionedApi("Shop").MapItemsApi().RequireAuthorization();\napp.Run();\n',
  'src/Shop.Api/Apis/ItemsApi.cs': 'public static class ItemsApi {\n  public static RouteGroupBuilder MapItemsApi(this IEndpointRouteBuilder app) {\n    var api = app.MapGroup("api/items").HasApiVersion(1.0);\n    api.MapGet("/", () => 1);\n    return api;\n  }\n}\n',
  'src/Shop.Domain/Shop.Domain.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
};

// The council's probe: an unversioned POST, new HttpClient(), .Result, Console.WriteLine, string-built SQL, an empty catch.
const PROBE = `public static class ProbeApi
{
    public static void MapProbe(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/probe", Handle);
    }

    static IResult Handle(ShopContext db, string name)
    {
        var client = new HttpClient();
        var body = client.GetStringAsync("http://other").Result;
        Console.WriteLine(body);
        try { db.Database.ExecuteSqlRaw("DELETE FROM items WHERE name = '" + name + "'"); } catch (Exception) { }
        return Results.Ok();
    }
}
`;

test('the dotnet pack ships a policy library: rules, validators, patterns', () => {
  const lib = libraries(INSTALL).find((l) => l.id === 'dotnet');
  assert.ok(lib, 'packs/dotnet/policy');
  assert.ok(lib.rules.length >= 30);
  for (const id of ['API-001', 'API-002', 'DATA-004', 'ERR-001', 'RES-001', 'RES-002', 'ARCH-001', 'ARCH-002', 'SEC-002']) assert.ok(lib.rules.some((r) => r.id === id), id);
  const text = lib.rules.map((r) => r.text).join('\n') + lib.validators.map((v) => v.text).join('\n');
  assert.doesNotMatch(text, /eShop|recommendations\.md|Ordering\.API|Catalog\.API/, 'the library names no service of the application it was proven on');
});

test('policy-library add: merges into the starter without touching existing rules; selfcheck passes; the probe is blocked by API-001, DATA-004, ERR-001, RES-001', { skip: !hasPython && 'no Python with pyyaml and jsonschema (factory python setup)' }, () => {
  const { root, git } = repo(BASE);
  const dir = path.join(root, '.factory/policy');
  fs.cpSync(path.join(INSTALL, 'templates/policy'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.yaml'), PROFILE);
  const starterRules = (f) => parse(fs.readFileSync(path.join(dir, f), 'utf8')).rules.map(({ patterns, ...r }) => r);
  const before = starterRules('rules/data.yaml');
  const report = addLibrary(libraries(INSTALL).find((l) => l.id === 'dotnet'), dir, { installRoot: INSTALL });
  assert.ok(report.added.includes('DATA-004') && report.kept.length === 0);
  assert.deepEqual(report.replacedRules, ['SEC-001'], 'the starter SEC-001 becomes the .NET form (dev settings and tests excluded)');
  assert.deepEqual(report.replaced.sort(), ['VAL-DB-OWNERSHIP', 'VAL-SECRET-SCAN']);
  assert.deepEqual(starterRules('rules/data.yaml').slice(0, before.length), before, 'existing rules are kept as they were (only their pattern references grow)');
  // Adding again changes nothing.
  assert.equal(addLibrary(libraries(INSTALL).find((l) => l.id === 'dotnet'), dir, { installRoot: INSTALL }).added.length, 0);

  const self = spawnSync(PY.cmd, [ARCH, 'selfcheck', '--policy-dir', dir], { cwd: root, encoding: 'utf8' });
  assert.match(self.stdout, /SELFCHECK PASSED/, self.stdout.split('\n').filter((l) => /ERROR|FAIL/.test(l)).join('\n'));

  git('add', '-A');
  git('commit', '-qm', 'policy');
  fs.writeFileSync(path.join(root, 'src/Shop.Api/Apis/ProbeApi.cs'), PROBE);
  const run = spawnSync(PY.cmd, [ARCH, 'validate', '--checkpoint', 'code_review', '--policy-dir', dir, '--workspace', root, '--base', 'HEAD', '--format', 'json', '--no-evidence', '--no-history'], { cwd: root, encoding: 'utf8' });
  const result = JSON.parse(run.stdout);
  assert.equal(result.decision, 'BLOCK');
  const blocking = new Set(result.findings.filter((f) => f.outcome === 'BLOCK').map((f) => f.rule_id));
  for (const id of ['API-001', 'DATA-004', 'ERR-001', 'RES-001']) assert.ok(blocking.has(id), `${id} blocks (blocking: ${[...blocking].join(', ')})`);
});

// A profile with classification conventions (derived classification) and a shared library.
const CONVENTIONS = `classification:
  service_names: { Shop: shop }
  conventions:
    - { type: test, layer: test, match: { roots: ["tests/*"], test_project: true } }
    - { type: api, layer: presentation, service: required, traits: [exposes_http_api], match: { roots: ["src/*"], sdk: ["Microsoft.NET.Sdk.Web"], name: ["*.Api"] } }
    - { type: domain, layer: domain, service: required, match: { roots: ["src/*"], sdk: ["Microsoft.NET.Sdk"], name: ["*.Domain"] } }
    - { type: library, layer: shared, match: { roots: ["src/*"], sdk: ["Microsoft.NET.Sdk"], test_project: false, output_type: Library, not_name: ["*.Domain", "*.Api"] } }
`;
function shopWithConventions() {
  const { root, git } = repo({ ...BASE, 'tests/Shop.Tests/Shop.Tests.csproj': '<Project Sdk="MSTest.Sdk"><ItemGroup><ProjectReference Include="..\\..\\src\\Shop.Api\\Shop.Api.csproj" /></ItemGroup></Project>\n' });
  const dir = path.join(root, '.factory/policy');
  fs.cpSync(path.join(INSTALL, 'templates/policy'), dir, { recursive: true });
  const profile = PROFILE.replace('project_manifests: ["src/**/*.csproj"]', 'project_manifests: ["src/**/*.csproj", "tests/**/*.csproj"]')
    .replace('  shared: ["shared"]', '  shared: ["shared"]\n  test: ["*"]')
    .replace('  - { name: Shop.Domain,', '  - { name: Shop.Tests, path: tests/Shop.Tests, type: test, layer: test }\n  - { name: Shop.Domain,')
    .replace('services:\n', `${CONVENTIONS}services:\n`);
  fs.writeFileSync(path.join(dir, 'profile.yaml'), profile);
  addLibrary(libraries(INSTALL).find((l) => l.id === 'dotnet'), dir, { installRoot: INSTALL });
  git('add', '-A');
  git('commit', '-qm', 'policy');
  return { root, git, dir };
}
const WEB = (refs = '') => `<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup>${refs}</ItemGroup></Project>\n`;
const runPolicy = (root, dir, checkpoint = 'code_review') => JSON.parse(spawnSync(PY.cmd, [ARCH, 'validate', '--checkpoint', checkpoint, '--policy-dir', dir, '--workspace', root, ...(checkpoint === 'code_review' ? ['--base', 'HEAD'] : []), '--format', 'json', '--no-evidence', '--no-history'], { cwd: root, encoding: 'utf8' }).stdout);
const blocking = (r) => new Set(r.findings.filter((f) => f.outcome === 'BLOCK').map((f) => f.rule_id));

test("Opus's A5 probe table and Sol's reproductions: every placement blocks on API-001, DATA-004, ERR-001 and RES-001, or is refused", { skip: !hasPython && 'no Python with pyyaml and jsonschema (factory python setup)' }, () => {
  const { root, git, dir } = shopWithConventions();
  const self = spawnSync(PY.cmd, [ARCH, 'selfcheck', '--policy-dir', dir], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(self, /PASS\] classification_conventions/, 'the conventions classify every profiled project as its entry does');
  const FOUR = ['API-001', 'DATA-004', 'ERR-001', 'RES-001'];
  const place = (files, policy) => {
    git('reset', '-q', '--hard', 'HEAD');
    git('clean', '-qfd');
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    if (policy) fs.writeFileSync(path.join(root, '.factory/app.json'), JSON.stringify({ policy }));
    return runPolicy(root, dir);
  };
  // The probe goes where API code lives (`Apis/`), as in Opus's table.
  const probeIn = (folder) => ({ [`${folder.endsWith('/Apis') ? folder : `${folder}/Apis`}/ProbeApi.cs`]: PROBE });
  const service = (id, roots, extra = {}) => ({ services: [{ id, roots, ...extra }] });
  const cases = [
    ['baseline: the probe in src/Shop.Api/Apis', { ...probeIn('src/Shop.Api/Apis') }, null, FOUR],
    ['new src/Probe.Api (Web SDK), declared as a new service', { 'src/Probe.Api/Probe.Api.csproj': WEB(), ...probeIn('src/Probe.Api') }, service('probe', ['src/Probe.Api']), FOUR],
    ['new src/Probe.Api declared test/test (a class cannot be declared)', { 'src/Probe.Api/Probe.Api.csproj': WEB(), ...probeIn('src/Probe.Api') }, { ...service('probe', ['src/Probe.Api']), projects: [{ name: 'Probe.Api', path: 'src/Probe.Api', type: 'test', layer: 'test' }] }, [...FOUR, 'TOPOLOGY-001']],
    ['new src/Probe.Api declared client/client or host/host', { 'src/Probe.Api/Probe.Api.csproj': WEB(), ...probeIn('src/Probe.Api') }, { ...service('probe', ['src/Probe.Api']), projects: [{ name: 'Probe.Api', path: 'src/Probe.Api', type: 'host', layer: 'host' }] }, [...FOUR, 'TOPOLOGY-001']],
    ['a Web SDK project marked IsTestProject under src/', { 'src/Probe.Api/Probe.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n', ...probeIn('src/Probe.Api') }, service('probe', ['src/Probe.Api']), FOUR],
    ['nested: src/Probe.Api as api plus src/Probe.Api/Apis as a test project (Opus)', { 'src/Probe.Api/Probe.Api.csproj': WEB(), 'src/Probe.Api/Apis/Apis.csproj': '<Project Sdk="MSTest.Sdk" />\n', ...probeIn('src/Probe.Api/Apis') }, service('probe', ['src/Probe.Api']), ['ARCH-001']],
    ['nested declared roots (Sol)', { 'src/Reviews.Api/Reviews.Api.csproj': WEB(), 'src/Reviews.Api/Apis/Apis.csproj': '<Project Sdk="MSTest.Sdk" />\n', ...probeIn('src/Reviews.Api/Apis') }, { services: [{ id: 'reviews', roots: ['src/Reviews.Api'] }, { id: 'shadow', roots: ['src/Reviews.Api/Apis'] }] }, ['ARCH-001', 'TOPOLOGY-001']],
    ['a project with no service of its own (name maps to none, nothing declared)', { 'src/Probe.Api/Probe.Api.csproj': WEB(), ...probeIn('src/Probe.Api') }, null, ['ARCH-001']],
    ['another service\'s datastore under another casing (Opus, Sol)', { 'src/Probe.Api/Probe.Api.csproj': WEB(), 'src/Probe.Api/Db.cs': 'builder.AddNpgsqlDataSource("shopdb");\n', ...probeIn('src/Probe.Api') }, service('probe', ['src/Probe.Api'], { owns_datastores: ['ShopDB'] }), ['TOPOLOGY-001', 'ARCH-001', 'DATA-002']],
  ];
  // A refused declaration declares nothing: the service does not exist, so its project stays unclassified (ARCH-001)
  // and its use of another service's database is still DATA-002.
  for (const [name, files, policy, want] of cases) {
    const r = place(files, policy);
    const got = blocking(r);
    assert.equal(r.decision, 'BLOCK', name);
    for (const id of want) assert.ok(got.has(id), `${name}: ${id} blocks (blocking: ${[...got].join(', ')})`);
  }
  // An unclassifiable project is an escalation for a person, with a fix that says so.
  const nested = place(cases[5][1], cases[5][2]);
  const arch = nested.findings.find((f) => f.rule_id === 'ARCH-001' && f.outcome === 'BLOCK');
  assert.ok(arch.needs_person && /nested/.test(arch.message) && /a person must extend the policy profile/.test(arch.remediation), JSON.stringify(arch));
  // A project referencing another service's infrastructure keeps its derived layer (Opus: declared host to escape ARCH-002).
  const cross = place({ 'src/Probe.Api/Probe.Api.csproj': WEB('<ProjectReference Include="..\\Shop.Domain\\Shop.Domain.csproj" />') }, { ...service('probe', ['src/Probe.Api']), projects: [{ name: 'Probe.Api', path: 'src/Probe.Api', type: 'api', layer: 'host' }] });
  assert.ok(blocking(cross).has('ARCH-002') || blocking(cross).has('ARCH-001'), [...blocking(cross)].join(', '));

  // The honest path: a new service project and a new test project, the service declared, nothing else: no BLOCK.
  const honest = place({ 'src/Reviews.Api/Reviews.Api.csproj': WEB(), 'tests/Reviews.Tests/Reviews.Tests.csproj': '<Project Sdk="MSTest.Sdk"><ItemGroup><ProjectReference Include="..\\..\\src\\Reviews.Api\\Reviews.Api.csproj" /></ItemGroup></Project>\n' }, service('reviews', ['src/Reviews.Api'], { owns_datastores: ['reviewsdb'] }));
  assert.deepEqual([...blocking(honest)], [], JSON.stringify(honest.findings.filter((f) => f.outcome === 'BLOCK').map((f) => f.message)));
  // Unclassified until the service is declared: a fix the agent can make (not a person).
  const undeclared = place({ 'src/Reviews.Api/Reviews.Api.csproj': WEB() }, null);
  const fix = undeclared.findings.find((f) => f.rule_id === 'ARCH-001');
  assert.ok(!fix.needs_person && /policy\.services/.test(fix.message) && !/Reverse the dependency/.test(fix.remediation), JSON.stringify(fix));
});

test('the declaration rules: the engine (Python) and the guard (JavaScript) give the same errors on every case of one table', { skip: !hasPython && 'no Python with pyyaml and jsonschema (factory python setup)' }, async () => {
  const { policyTopologyProblems } = await import('../../pipeline/lib/policy-topology.mjs');
  const table = JSON.parse(fs.readFileSync(path.join(INSTALL, 'architecture-policy/tests/topology_cases.json'), 'utf8'));
  const py = JSON.parse(spawnSync(PY.cmd, ['-c', `import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(INSTALL, 'architecture-policy/hooks'))})\nfrom architecture import topology\nt = json.load(open(${JSON.stringify(path.join(INSTALL, 'architecture-policy/tests/topology_cases.json'))}))\nlinked = lambda c: (lambda rel: any(rel == l or rel.startswith(l + '/') for l in c.get('symlinks', [])))\nprint(json.dumps([topology.validate(t['profile'], c['policy'], set(t['manifest_dirs']), is_symlink=linked(c))[1] for c in t['cases']]))`], { encoding: 'utf8' }).stdout);
  table.cases.forEach((c, i) => {
    const links = c.symlinks ?? [];
    const js = policyTopologyProblems(c.policy, table.profile, new Set(table.manifest_dirs), { isSymlink: (rel) => links.some((l) => rel === l || rel.startsWith(`${l}/`)) });
    // The same errors, word for word: the four places that check a declaration agree on every row.
    assert.deepEqual(js, py[i], `${c.name}: js and python disagree`);
    for (const [label, errs] of [['js', js], ['python', py[i]]]) {
      if (c.error) assert.ok(errs.some((e) => e.includes(c.error)), `${label}: ${c.name}: ${errs.join(' | ')}`);
      else assert.deepEqual(errs, [], `${label}: ${c.name}`);
    }
  });
});

test('linked source: a folder compiled into projects from outside them must be in the profile (selfcheck, and validate at every checkpoint)', { skip: !hasPython && 'no Python with pyyaml and jsonschema (factory python setup)' }, () => {
  const { root, git, dir } = shopWithConventions();
  fs.mkdirSync(path.join(root, 'src/Shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/Shared/Extensions.cs'), 'public static class Ext {}\n');
  fs.writeFileSync(path.join(root, 'src/Shop.Api/Shop.Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><Compile Include="..\\Shared\\Extensions.cs" Link="Extensions.cs" /><ProjectReference Include="..\\Shop.Domain\\Shop.Domain.csproj" /></ItemGroup></Project>\n');
  git('add', '-A');
  git('commit', '-qm', 'linked source');
  let self = spawnSync(PY.cmd, [ARCH, 'selfcheck', '--policy-dir', dir], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(self, /FAIL\] linked_sources[\s\S]*src\/Shared is compiled into src\/Shop\.Api\/Shop\.Api\.csproj \(linked source\) but is not in the profile/);
  // validate blocks it too, at the review checkpoints (council A6, D1): CI and the review step agree.
  for (const checkpoint of ['code_review', 'ci']) {
    const linked = runPolicy(root, dir, checkpoint).findings.find((f) => f.rule_id === 'LINKED-001');
    assert.ok(linked && linked.outcome === 'BLOCK' && linked.needs_person && /src\/Shared is compiled into/.test(linked.message), `${checkpoint}: ${JSON.stringify(linked)}`);
  }
  const profile = fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8').replace('  - { name: Shop.Tests,', '  - { name: Shared, path: src/Shared, type: library, layer: shared }\n  - { name: Shop.Tests,');
  fs.writeFileSync(path.join(dir, 'profile.yaml'), profile);
  self = spawnSync(PY.cmd, [ARCH, 'selfcheck', '--policy-dir', dir], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(self, /PASS\] linked_sources/);
  git('add', '-A');
  git('commit', '-qm', 'profile');
  fs.writeFileSync(path.join(root, 'src/Shared/ProbeApi.cs'), PROBE);
  const r = runPolicy(root, dir);
  for (const id of ['DATA-004', 'ERR-001', 'RES-001']) assert.ok(blocking(r).has(id), `${id} blocks in linked source (${[...blocking(r)].join(', ')})`);
});


test('manifests are read as MSBuild reads them, end to end (classify_cases.json: Opus A6 table B and finding 3); derived classes are shown', { skip: !hasPython && 'no Python with pyyaml and jsonschema (factory python setup)' }, () => {
  const table = JSON.parse(fs.readFileSync(path.join(INSTALL, 'architecture-policy/tests/classify_cases.json'), 'utf8'));
  const { root, git } = repo({ 'README.md': '# shop\n' });
  const dir = path.join(root, '.factory/policy');
  fs.cpSync(path.join(INSTALL, 'templates/policy'), dir, { recursive: true });
  const yamlList = (xs) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;
  const conv = table.conventions.map((c) => `    - { type: ${c.type}, layer: ${c.layer}${c.service ? `, service: ${c.service}` : ''}${c.content ? `, content: { ${Object.entries(c.content).map(([k, v]) => `${k}: ${v}`).join(', ')} }` : ''}, match: { ${Object.entries(c.match).map(([k, v]) => `${k}: ${Array.isArray(v) ? yamlList(v) : JSON.stringify(v)}`).join(', ')} } }`).join('\n');
  fs.writeFileSync(path.join(dir, 'profile.yaml'), `kind: Profile\nschema_version: 1\nid: default\nlanguage: csharp\nsource_extensions: [".cs", ".csproj"]\nproject_manifests: ["src/**/*.csproj", "tests/**/*.csproj"]\nglobal_exclude: [".factory/**"]\nprojects: []\nclassification:\n  service_names: { Catalog: catalog, Probe: probe }\n  conventions:\n${conv}\nservices:\n  - { id: catalog, owns_datastores: [catalogdb], traits: [exposes_http_api] }\n  - { id: probe, owns_datastores: [], traits: [exposes_http_api] }\nshared_datastore_names: []\nlayer_dependencies:\n  presentation: ["shared"]\n  shared: ["shared"]\n  host: ["*"]\n  test: ["*"]\ntest_mapping: []\n`);
  addLibrary(libraries(INSTALL).find((l) => l.id === 'dotnet'), dir, { installRoot: INSTALL });
  git('add', '-A');
  git('commit', '-qm', 'policy');
  const env = { ...process.env, ARCH_MSBUILD_EVAL: '0' };
  for (const c of table.cases) {
    git('reset', '-q', '--hard', 'HEAD');
    git('clean', '-qfd');
    for (const [rel, text] of Object.entries(c.files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    git('add', '-A');
    const r = JSON.parse(spawnSync(PY.cmd, [ARCH, 'validate', '--checkpoint', 'code_review', '--policy-dir', dir, '--workspace', root, '--base', 'HEAD', '--format', 'json', '--no-evidence', '--no-history'], { cwd: root, encoding: 'utf8', env }).stdout);
    const arch = r.findings.filter((f) => f.rule_id === 'ARCH-001' && f.outcome === 'BLOCK');
    if (c.expect === 'person') assert.ok(arch.length && arch.every((f) => f.needs_person), `${c.name}: ${JSON.stringify(arch.map((f) => f.message))}`);
    else if (c.expect === 'none') assert.ok(arch.length && arch.every((f) => !f.needs_person), c.name);
    else {
      assert.deepEqual(arch, [], c.name);
      const info = r.findings.filter((f) => f.rule_id === 'CLASSIFY-001' && f.outcome === 'INFO');
      assert.equal(info.length, 1, `${c.name}: one INFO per derived project`);
      assert.match(info[0].message, new RegExp(`${c.expect.replace('/', '\\/')}.*by the convention ${c.expect.replace('/', '\\/')} \\(from SDK`), c.name);
      assert.equal(r.derived_classes[0].type + '/' + r.derived_classes[0].layer, c.expect);
      const shown = spawnSync(PY.cmd, [ARCH, 'classes', '--policy-dir', dir, '--workspace', root, '--format', 'markdown'], { cwd: root, encoding: 'utf8', env }).stdout;
      assert.match(shown, /## New projects and their classes[\s\S]*Derived class of/, `${c.name}: arch classes shows it`);
    }
  }
});
