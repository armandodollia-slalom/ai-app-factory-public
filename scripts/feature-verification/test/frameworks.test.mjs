// Test runners are configuration (precheck.testRunners, lib/runners.mjs), usually from a language pack.
// A repository can mix frameworks: here xUnit (functional tests) and MSTest (unit tests) in one .NET
// solution, each tagged and filtered its own way. (A run once failed every round by sending xUnit's
// --filter-trait to an MSTest project.) Fixture projects, no toolchain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { automationFiles } from '../lib/plans.mjs';
import { expandArgv, isTestFile, planRuns, runnerFor, storyTagPattern, storyTokens, tagError, taggingLines, testRoots, testRunners } from '../lib/runners.mjs';

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fixture(files, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-runners-'));
  temps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { root, installRoot: INSTALL_ROOT, plansDir: '.factory/plans', scenariosDir: '.factory/stack/scenarios', testRoots: [], testExtensions: [], project: { languages: [] }, precheck: {}, ...config };
}

const XUNIT = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" /></ItemGroup></Project>';
const MSTEST = '<Project Sdk="MSTest.Sdk"></Project>';
const dotnetRepo = (extra = {}) => fixture({
  'tests/Catalog.FunctionalTests/Catalog.FunctionalTests.csproj': XUNIT,
  'tests/Catalog.FunctionalTests/Promo/PromoTests.cs': '[Trait("Story", "SHOP-1")]\npublic class PromoTests { [Fact, Trait("TestCase", "TC-SHOP-1-01")] public void A() {} }',
  'tests/Catalog.FunctionalTests/PromoHost.cs': '// Program is referenced for TC-SHOP-1-01\npublic sealed class PromoHost {}',
  'tests/Ordering.UnitTests/Ordering.UnitTests.csproj': MSTEST,
  'tests/Ordering.UnitTests/PromoTests.cs': '[TestClass, TestCategory("SHOP-1")]\npublic class PromoTests { [TestMethod, TestProperty("TestCase", "TC-SHOP-1-02")] public void B() {} }',
  'tests/Loose.FunctionalTests/Sub/LooseTests.cs': '[Fact] public void TC_SHOP_1_03() {} // TC-SHOP-1-03',
}, { precheck: { testRunners: ['dotnet'] }, ...extra });

test('each test file gets the runner of its own project, found from the nearest project file', () => {
  const config = dotnetRepo();
  const of = (file) => {
    const hit = runnerFor(config, file);
    return hit && `${hit.runner.name} ${hit.unit}`;
  };
  assert.equal(of('tests/Catalog.FunctionalTests/Promo/PromoTests.cs'), 'xunit tests/Catalog.FunctionalTests');
  assert.equal(of('tests/Ordering.UnitTests/PromoTests.cs'), 'mstest tests/Ordering.UnitTests');
  assert.equal(of('tests/Loose.FunctionalTests/Sub/LooseTests.cs'), 'xunit tests/Loose.FunctionalTests', 'no project file: the fallback runner, on the first folders of the path');
  assert.equal(of('e2e/cart.spec.ts'), null, 'no runner takes the file');
});

test('the story tag is the runner\'s own, and only files that hold tests need it', () => {
  const config = dotnetRepo();
  const [mstest, xunit] = testRunners(config);
  assert.deepEqual([mstest.name, xunit.name], ['mstest', 'xunit']);
  assert.ok(storyTagPattern(xunit, 'SHOP-1').test('[Trait("Story", "SHOP-1")]'));
  assert.ok(!storyTagPattern(xunit, 'SHOP-1').test('[TestCategory("SHOP-1")]'));
  assert.ok(storyTagPattern(mstest, 'SHOP-1').test('[TestCategory( "SHOP-1" )]'));
  assert.ok(!storyTagPattern(mstest, 'SHOP-1').test('[Trait("Story", "SHOP-1")]'));
  assert.ok(!storyTagPattern(mstest, 'SHOP-1').test('[TestCategory("SHOP-12")]'));

  const error = (file, text) => tagError(config, file, text, 'SHOP-1');
  assert.equal(error('tests/Catalog.FunctionalTests/A.cs', '[Trait("Story", "SHOP-1")] [Fact] void A() {}'), null);
  assert.match(error('tests/Catalog.FunctionalTests/A.cs', '[Fact] void A() {}'), /tag the story's tests with \[Trait\("Story", "SHOP-1"\)\] so they can be selected \(tests\/Catalog\.FunctionalTests runs with xunit\)/);
  assert.match(error('tests/Ordering.UnitTests/A.cs', '[Trait("Story", "SHOP-1")] [TestMethod] void A() {}'), /\[TestCategory\("SHOP-1"\)\].*runs with mstest/);
  assert.equal(error('tests/Catalog.FunctionalTests/PromoHost.cs', '// Program is referenced for TC-SHOP-1-23\npublic sealed class PromoHost {}'), null, 'a helper without a test attribute needs no tag');
  assert.equal(error('e2e/cart.spec.ts', 'test("TC-SHOP-1-01", () => {})'), null, 'a file no runner takes is not tag-checked');
});

test('one build and one run per unit, each with its runner\'s own filter', () => {
  const config = dotnetRepo();
  const files = [...automationFiles(config, { key: 'SHOP-1', scenario: 'shop-1' }).tests.keys()];
  assert.deepEqual(files, ['tests/Catalog.FunctionalTests/Promo/PromoTests.cs', 'tests/Catalog.FunctionalTests/PromoHost.cs', 'tests/Loose.FunctionalTests/Sub/LooseTests.cs', 'tests/Ordering.UnitTests/PromoTests.cs']);
  const { runs, unmatched } = planRuns(config, [...files, 'e2e/cart.spec.ts'], 'SHOP-1', { read: (f) => fs.readFileSync(path.join(config.root, f), 'utf8') });
  assert.deepEqual(unmatched, ['e2e/cart.spec.ts']);
  assert.deepEqual(runs.map((r) => [r.runner.name, r.unit, r.files.length]), [['mstest', 'tests/Ordering.UnitTests', 1], ['xunit', 'tests/Catalog.FunctionalTests', 1], ['xunit', 'tests/Loose.FunctionalTests', 1]], 'the helper file is in no run');
  assert.deepEqual(runs[0].build, ['dotnet', 'build', 'tests/Ordering.UnitTests', '--nologo', '-v', 'quiet', '--disable-build-servers']);
  assert.deepEqual(runs[0].run, ['dotnet', 'test', '--project', 'tests/Ordering.UnitTests', '--no-build', '--filter', 'TestCategory=SHOP-1']);
  assert.deepEqual(runs[1].run, ['dotnet', 'test', '--project', 'tests/Catalog.FunctionalTests', '--no-build', '--', '--filter-trait', 'Story=SHOP-1']);
  assert.ok(!runs[0].run.includes('--filter-trait'), 'MSTest never gets the xUnit filter');
});

test('a runner entry is a definition, a pack, one runner of a pack, or a pack runner with overrides', () => {
  const own = { name: 'make-check', match: ['spec/**'], run: ['make', 'check', 'STORY={story}', '{files}'], storyTag: { pattern: '@story {story}\\b', template: '`@story {story}`' } };
  const config = dotnetRepo({ precheck: { testRunners: [{ use: 'playwright/playwright', match: ['.ts'], run: ['npx', 'playwright', 'test', '-c', 'pw.stack.config.ts', '--grep', '{casePrefix}', '{files}'] }, 'dotnet/xunit', own] } });
  const runners = testRunners(config);
  assert.deepEqual(runners.map((r) => r.name), ['playwright', 'xunit', 'make-check']);
  assert.equal(runners[0].stack, true, 'the pack marks the end-to-end runner as needing the app stack');
  assert.deepEqual(runners[0].env, { E2E_KEEP_VIDEOS: '1' });
  const { runs } = planRuns(config, ['e2e/a.spec.ts', 'e2e/helpers.ts', 'spec/cart.feature'], 'SHOP-1');
  assert.deepEqual(runs.map((r) => r.run), [
    ['npx', 'playwright', 'test', '-c', 'pw.stack.config.ts', '--grep', 'TC-SHOP-1-', 'e2e/a.spec.ts', 'e2e/helpers.ts'],
    ['make', 'check', 'STORY=SHOP-1', 'spec/cart.feature'],
  ]);
  assert.match(tagError(config, 'spec/cart.feature', 'Feature: cart', 'SHOP-1'), /tag the story's tests with `@story SHOP-1` so they can be selected \(runner make-check\)/);
  assert.equal(tagError(config, 'spec/cart.feature', '# @story SHOP-1', 'SHOP-1'), null);
  assert.deepEqual(taggingLines(config, 'SHOP-1'), [
    '- playwright (.ts): put the case id (TC-SHOP-1-NN) in each test title.',
    '- xunit (.cs): tag the story\'s tests with [Trait("Story", "SHOP-1")]; mark each test\'s case with [Trait("TestCase", "TC-SHOP-1-NN")].',
    '- make-check (spec/**): tag the story\'s tests with `@story SHOP-1`.',
  ]);

  assert.throws(() => testRunners(fixture({}, { precheck: { testRunners: ['dotnet/nunit'] } })), /"dotnet\/nunit" names no runner \(packs\/dotnet\/tests\.json has no runner "nunit"\)/);
  assert.throws(() => testRunners(fixture({}, { precheck: { testRunners: ['cobol'] } })), /packs\/cobol\/tests\.json is missing or empty/);
  assert.throws(() => testRunners(fixture({}, { precheck: { testRunners: [{ name: 'x', match: ['.x'] }] } })), /runner "x" has no `run` command/);
});

test('without precheck.testRunners the runners come from the packs of project.languages; with neither there are none', () => {
  assert.deepEqual(testRunners(fixture({}, { project: { languages: ['dotnet', 'go', 'cobol'] } })).map((r) => `${r.pack}/${r.name}`), ['dotnet/mstest', 'dotnet/xunit', 'go/go-test']);
  assert.deepEqual(testRunners(fixture({}, { project: { languages: ['dotnet'] }, precheck: { testRunners: [] } })), [], 'an empty list switches the runners off');
  const bare = fixture({ 'e2e/a.spec.ts': 'test("TC-SHOP-1-01 x", () => {})', 'README.md': 'TC-SHOP-1-01', '.factory/state/x.json': '"TC-SHOP-1-01"', '.factory/stack/scenarios/shop-1/seed.sql': '-- TC-SHOP-1-01' });
  assert.deepEqual(testRunners(bare), []);
  assert.deepEqual(testRoots(bare), ['.']);
  assert.deepEqual([...automationFiles(bare, { key: 'SHOP-1', scenario: 'shop-1' }).tests.keys()], ['.factory/stack/scenarios/shop-1/seed.sql', 'e2e/a.spec.ts'], 'an unconfigured repository: any source file that names a case, not docs or pipeline state');
  assert.deepEqual(planRuns(bare, ['e2e/a.spec.ts'], 'SHOP-1'), { runs: [], unmatched: ['e2e/a.spec.ts'] }, 'and nothing to run them with');
  assert.ok(isTestFile({ ...bare, testExtensions: ['.feature'] }, 'spec/a.feature'));
  assert.ok(!isTestFile({ ...bare, testExtensions: ['.feature'] }, 'e2e/a.spec.ts'), 'testExtensions, when set, decides alone');
});

test('story names for languages whose test names cannot hold a dash', () => {
  assert.deepEqual(storyTokens('SHOP-1'), { story: 'SHOP-1', casePrefix: 'TC-SHOP-1-', storyIdent: 'shop_1', caseIdent: 'tc_shop_1_', storyPascal: 'Shop1' });
  assert.deepEqual(expandArgv(['run', '{unit}/x', '{caseIdent}', '{files}', '{nope}'], { ...storyTokens('BUG-12'), unit: 'crates/api', files: ['a', 'b'] }), ['run', 'crates/api/x', 'tc_bug_12_', 'a', 'b', '']);
});

test('every pack runner is well formed and says whether its commands were executed', () => {
  for (const pack of fs.readdirSync(path.join(INSTALL_ROOT, 'packs'))) {
    const file = path.join(INSTALL_ROOT, 'packs', pack, 'tests.json');
    if (!fs.existsSync(file)) continue;
    const config = fixture({}, { precheck: { testRunners: [pack] } });
    for (const r of testRunners(config)) {
      assert.equal(typeof r.verified, 'boolean', `${pack}/${r.name}: verified`);
      assert.ok(r.storyTag?.pattern, `${pack}/${r.name}: a story tag pattern`);
      assert.doesNotThrow(() => storyTagPattern(r, 'SHOP-1'), `${pack}/${r.name}: the pattern compiles`);
      if (r.testFile) assert.doesNotThrow(() => new RegExp(r.testFile));
    }
  }
});

// Council C3: #49 (the pipeline's BUG-16 fix) added Bug16Tests with IClassFixture<WebhooksApiFixture> beside
// WebhooksApiTests, so two Aspire hosts started at once and Webhooks CI timed out on start-up for days.
test('the precheck refuses a fixture set up per class in two classes of one test project, existing classes included', async () => {
  const { sharedFixtureErrors } = await import('../lib/runners.mjs');
  const config = fixture({
    'tests/Webhooks.FunctionalTests/Webhooks.FunctionalTests.csproj': XUNIT,
    'tests/Webhooks.FunctionalTests/WebhooksApiFixture.cs': 'public sealed class WebhooksApiFixture : IAsyncLifetime {}',
    'tests/Webhooks.FunctionalTests/WebhooksApiTests.cs': 'public sealed class WebhooksApiTests(WebhooksApiFixture f) : IClassFixture<WebhooksApiFixture> { [Fact] public void A() {} }',
    'tests/Webhooks.FunctionalTests/Bug16Tests.cs': '[Trait("Story", "BUG-16")]\npublic sealed class Bug16Tests(WebhooksApiFixture f) : IClassFixture< WebhooksApiFixture > { [Fact] public void TC_BUG_16_01() {} }',
    'tests/Webhooks.FunctionalTests/bin/Debug/Copy.cs': 'class X : IClassFixture<WebhooksApiFixture> {}',
    'tests/Catalog.FunctionalTests/Catalog.FunctionalTests.csproj': XUNIT,
    'tests/Catalog.FunctionalTests/CatalogApiTests.cs': 'public sealed class CatalogApiTests : IClassFixture<CatalogApiFixture> { [Fact] public void A() {} }',
  }, { precheck: { testRunners: ['dotnet'] } });
  const list = (unit) => Object.keys({ 'tests/Webhooks.FunctionalTests/WebhooksApiFixture.cs': 1, 'tests/Webhooks.FunctionalTests/WebhooksApiTests.cs': 1, 'tests/Webhooks.FunctionalTests/Bug16Tests.cs': 1, 'tests/Webhooks.FunctionalTests/bin/Debug/Copy.cs': 1, 'tests/Catalog.FunctionalTests/CatalogApiTests.cs': 1 }).filter((f) => f.startsWith(`${unit}/`));
  const errors = sharedFixtureErrors(config, ['tests/Webhooks.FunctionalTests/Bug16Tests.cs', 'tests/Catalog.FunctionalTests/CatalogApiTests.cs'], testRunners(config), { list });
  assert.equal(errors.length, 1, 'one fixture type shared wrongly; build output ignored; one class per fixture is fine');
  assert.match(errors[0], /^tests\/Webhooks\.FunctionalTests: the fixture WebhooksApiFixture is set up per class in 2 classes \(.*WebhooksApiTests\.cs, .*Bug16Tests\.cs\)/);
  assert.match(errors[0], /ICollectionFixture<TheFixture>/);
  // With a collection fixture shared by both classes, nothing is reported.
  fs.writeFileSync(path.join(config.root, 'tests/Webhooks.FunctionalTests/WebhooksApiTests.cs'), '[Collection(WebhooksCollection.Name)]\npublic sealed class WebhooksApiTests(WebhooksApiFixture f) { }');
  fs.writeFileSync(path.join(config.root, 'tests/Webhooks.FunctionalTests/Bug16Tests.cs'), '[Collection(WebhooksCollection.Name)]\npublic sealed class Bug16Tests(WebhooksApiFixture f) { }');
  assert.deepEqual(sharedFixtureErrors(config, ['tests/Webhooks.FunctionalTests/Bug16Tests.cs'], testRunners(config), { list }), []);
});
