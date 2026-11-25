// GEN-18: a generated factory's analysis gate reports a value written twice (a fallback that repeats a configured
// default, a literal that repeats a named constant) on the lines a change adds, as evidence for the clean-code reviewer;
// onboarding records where the configuration lives and asks when it cannot tell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changeRepo, git, runGate, tmp, write } from './gate-repo.mjs';

process.env.FACTORY_CACHE_DIR = tmp('fcache-');
const { evidenceText, toolFindings } = await import('../lib/analysis/report.mjs');
const { findRepeats, fileConstants, sourceDefaults } = await import('../lib/analysis/repeats.mjs');
const { interview } = await import('../../factory/lib/interview.mjs');

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FACTORY = path.join(INSTALL, 'bin/factory.mjs');

// A repository on `main` with its base files, a branch with the change, and the analysis gate of one pack's check.
function repoWith(t, { pack, sources, base, change }) {
  const root = changeRepo(t, { base: { '.factory/config.json': JSON.stringify({ project: { languages: [pack], configSources: sources } }), ...base }, change, prefix: 'repeats-' });
  const tool = `repeated-values-${pack}`;
  const config = { root, mainRoot: root, stateDir: '.factory/state', project: { languages: [pack], configSources: sources }, featureVerification: { precheck: {} }, analysis: { stages: { story: [tool] } } };
  return { root, config, tool };
}
const gate = ({ config }) => runGate(config);

test('.NET: a change that writes `?? 900` beside an options default of 900 is reported with both places', async (t) => {
  const r = repoWith(t, {
    pack: 'dotnet',
    sources: ['**/*Options.cs', '**/appsettings*.json'],
    base: {
      'src/Basket/BasketOptions.cs': 'namespace Basket;\npublic class BasketOptions\n{\n    public int? TimeoutSec { get; set; } = 900;\n}\n',
      'src/Basket/appsettings.json': '{\n  "Basket": {\n    "RetryCount": 5\n  }\n}\n',
      'src/Basket/Service.cs': 'namespace Basket;\npublic class Service\n{\n}\n',
    },
    change: { 'src/Basket/Service.cs': 'namespace Basket;\npublic class Service\n{\n    int Timeout(BasketOptions o) => o.TimeoutSec ?? 900;\n    int Retries(IConfiguration c) => c.GetValue<int>("Basket:RetryCount", 5);\n    int Pages(BasketOptions o) => o.PageSize ?? 900;\n}\n' },
  });
  const report = await gate(r);
  const items = report.cleanCode.map((f) => [f.rule, f.file, f.line, f.message]);
  assert.deepEqual(items.map((i) => i.slice(0, 3)), [['repeated-default', 'src/Basket/Service.cs', 4], ['repeated-default', 'src/Basket/Service.cs', 5]], JSON.stringify(report.cleanCode));
  assert.match(items[0][3], /repeats the default of TimeoutSec, which src\/Basket\/BasketOptions\.cs:4 already defines as 900/);
  assert.match(items[1][3], /RetryCount, which src\/Basket\/appsettings\.json:3/);
  // A reviewer's evidence, never a harness finding: nothing to fix by the tool's word alone, nothing that blocks.
  assert.deepEqual(report.findings, []);
  assert.deepEqual(toolFindings(report), []);
  assert.match(evidenceText(report), /Clean-code evidence[\s\S]*repeated-values-dotnet repeated-default src\/Basket\/Service\.cs:4/);
});

test('Node: a literal that repeats a named constant of another file for the same purpose is reported; other uses are not', async (t) => {
  const r = repoWith(t, {
    pack: 'typescript',
    sources: ['**/config/*'],
    base: {
      'src/limits.ts': "export const MAX_CART_ITEMS = 50;\nexport const SUPPORT_EMAIL = 'help@example.com';\n",
      'src/config/defaults.ts': 'export default {\n  pageSize: 25,\n};\n',
      'src/cart.ts': 'export {};\n',
    },
    change: { 'src/cart.ts': "export const tooMany = (cartItems: unknown[]) => cartItems.length > 50;\nexport const retries = 50;\nexport const pageOf = (opts: { pageSize?: number }) => opts.pageSize ?? 25;\n" },
  });
  const report = await gate(r);
  assert.deepEqual(report.cleanCode.map((f) => [f.rule, f.line]), [['repeated-constant', 1], ['repeated-default', 3]], JSON.stringify(report.cleanCode));
  assert.match(report.cleanCode[0].message, /50 repeats the constant MAX_CART_ITEMS, which src\/limits\.ts:1 defines/);
  // `retries = 50` shares the value, not the purpose: not reported.
});

test('a change that only reads the configured value or the constant reports nothing; old repeats are not the change\'s', async (t) => {
  const r = repoWith(t, {
    pack: 'typescript',
    sources: ['**/config/*'],
    base: {
      'src/limits.ts': 'export const MAX_CART_ITEMS = 50;\n',
      'src/config/defaults.ts': 'export default {\n  pageSize: 25,\n};\n',
      'src/old.ts': 'export const oldCheck = (cartItems: unknown[]) => cartItems.length > 50;\n',
      'src/cart.ts': 'export {};\n',
    },
    change: {
      'src/cart.ts': "import { MAX_CART_ITEMS } from './limits';\nimport defaults from './config/defaults';\nexport const tooMany = (cartItems: unknown[]) => cartItems.length > MAX_CART_ITEMS;\nexport const pageSize = defaults.pageSize;\n",
      'src/old.ts': 'export const oldCheck = (cartItems: unknown[]) => cartItems.length > 50;\nexport const unrelated = true;\n',
    },
  });
  const report = await gate(r);
  assert.deepEqual(report.cleanCode, []);
});

test('Python: a settings default read again with `.get(key, default)` is reported', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/python/repeats.json'), 'utf8'));
  const defaults = sourceDefaults('app/settings.py', 'TIMEOUT_SEC = 900\nDEBUG = False\n', patterns);
  const found = findRepeats('app/jobs.py', 'import os\ntimeout = os.environ.get("TIMEOUT_SEC", 900)\n', patterns, { defaults, constants: fileConstants('app/settings.py', 'TIMEOUT_SEC = 900\n', patterns) });
  assert.deepEqual(found.map((f) => [f.rule, f.line]), [['repeated-default', 2]]);
});

test('init drafts the configuration sources it finds, and asks for them when it finds none instead of guessing', async (t) => {
  const make = (files) => {
    const root = tmp('cfgsrc-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-q', '-b', 'main');
    for (const [f, text] of Object.entries(files)) write(root, f, text);
    git(root, 'add', '-A');
    return root;
  };
  const found = make({ 'App.sln': '', 'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />\n', 'src/Api/appsettings.json': '{}\n', 'src/Api/BasketOptions.cs': 'class BasketOptions {}\n' });
  const r1 = spawnSync(process.execPath, [FACTORY, 'init', '--tools', 'claude'], { cwd: found, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(found, '.factory/config.json'), 'utf8')).project.configSources, ['**/appsettings*.json', '**/*Options.cs']);
  assert.doesNotMatch(r1.stdout, /Configuration sources: none found/);

  const none = make({ 'App.sln': '', 'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />\n', 'src/Api/Program.cs': 'class P {}\n' });
  const r2 = spawnSync(process.execPath, [FACTORY, 'init', '--tools', 'claude'], { cwd: none, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(none, '.factory/config.json'), 'utf8')).project.configSources, [], 'nothing guessed');
  assert.match(r2.stdout, /Configuration sources: none found \(project\.configSources\)/);

  // In the interview the question is asked with nothing filled in, and the answer is recorded.
  const shown = [];
  const ask = async (q, def) => (q.id === 'project.configSources' ? (shown.push(def), 'src/**/Settings.cs') : '');
  const asked = await interview({ config: { project: { configSources: [] } }, ask });
  assert.deepEqual(shown, ['']);
  assert.deepEqual(asked.config.project.configSources, ['src/**/Settings.cs']);
  // Headless with nothing found: no answer is invented.
  const headless = await interview({ config: { project: { configSources: [] } } });
  assert.ok(!headless.asked.some((a) => a.id === 'project.configSources'));
});

// Council r1 (sol-05): the member's reproducers. Mail and Shop both default Timeout to 900.
test('sol-05: a qualified key matches its own section at its own line; an absent section, a longer literal and a split line are judged right', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/dotnet/repeats.json'), 'utf8'));
  const settingsText = '{\n  "Mail": {\n    "Timeout": 900\n  },\n  "Shop": {\n    "Timeout": 900\n  }\n}\n';
  const defaults = sourceDefaults('src/appsettings.json', settingsText, patterns);
  const run = (code) => findRepeats('src/Service.cs', code, patterns, { defaults }).map((f) => [f.line, f.message.match(/default of (\S+), which (\S+)/)?.slice(1).join(' ')]);
  assert.deepEqual(run('var t = config["Shop:Timeout"] ?? 900;\n'), [[1, 'Shop:Timeout src/appsettings.json:6']], 'the Shop line, not the Mail one');
  assert.deepEqual(run('var t = config["Shipping:Timeout"] ?? 900;\n'), [], 'no Shipping section: nothing to repeat');
  assert.deepEqual(run('var t = config["Shop:Timeout"] ?? 900_000;\n'), [], '900_000 is not 900');
  assert.deepEqual(run('var t = config["Shop:Timeout"] ??\n    900;\n'), [[2, 'Shop:Timeout src/appsettings.json:6']], 'the literal on the next line, reported where it is');
  // An unqualified property that two sections both default is ambiguous: no source to point at.
  assert.deepEqual(run('var t = options.Timeout ?? 900;\n'), []);
});

// Council r2 (sol-05): the member's reproducers. A JSON key is found where it is (not where a string value or another
// section's key of the same name first appears); one key defined in two sources is one default; a nullable GetValue
// read falls back by its qualified key.
test('sol-05 r2: JSON keys at their own line, one key across sources, and GetValue<int?>(key) ?? literal', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/dotnet/repeats.json'), 'utf8'));
  const settings = '{\n "alias": "Shop",\n "Mail": { "Shop": 42, "Timeout": 900 },\n "Shop": {\n  "Timeout": 900\n }\n}\n';
  const base = sourceDefaults('src/appsettings.json', settings, patterns);
  assert.deepEqual(base.map((d) => [d.key, d.line]), [['alias', 2], ['Mail:Shop', 3], ['Mail:Timeout', 3], ['Shop:Timeout', 5]]);
  const run = (code, defaults = base) => findRepeats('src/Service.cs', code, patterns, { defaults }).map((f) => [f.line, f.related]);
  assert.deepEqual(run('var t = config["Shop:Timeout"] ?? 900;\n'), [[1, ['src/appsettings.json:5']]]);
  const dev = sourceDefaults('src/appsettings.Development.json', '{"Shop":{"Timeout":900}}', patterns);
  assert.deepEqual(run('var t = config["Shop:Timeout"] ?? 900;\n', [...base, ...dev]), [[1, ['src/appsettings.json:5']]], 'an environment override of the same key does not hide it');
  assert.deepEqual(run('var t = config.GetValue<int?>("Shop:Timeout") ?? 900;\n'), [[1, ['src/appsettings.json:5']]]);
  // Still ambiguous: an unqualified property two sections default.
  assert.deepEqual(run('var t = options.Timeout ?? 900;\n'), []);
});

// Council r2 (F11): the check flagged `// MCP stdio server "lsp" for agents` as repeating LSP_SERVER. A whole-line
// comment is prose; the same literal in code on the next line is still reported. Each pack says what its comments are.
test('F11: a literal in a whole-line comment repeats nothing; the same literal in code does', () => {
  const pack = (name) => JSON.parse(fs.readFileSync(path.join(INSTALL, `packs/${name}/repeats.json`), 'utf8'));
  const lines = (file, text, patterns, constants) => findRepeats(file, text, patterns, { constants }).map((f) => f.line);
  const ts = pack('typescript');
  const tsConst = fileConstants('lib/agents.mjs', "export const LSP_SERVER = 'lsp';\n", ts);
  assert.deepEqual(lines('lsp/mcp.mjs', '// MCP stdio server "lsp" for the LSP_SERVER agents\n/* the "lsp" LSP_SERVER\n * server "lsp" LSP_SERVER */\nconst server = { name: \'lsp\' }; // LSP_SERVER\n', ts, tsConst), [4]);
  const cs = pack('dotnet');
  const csConst = fileConstants('Limits.cs', '    public const int MaxCartItems = 50;\n', cs);
  assert.deepEqual(lines('Cart.cs', '/// <summary>MaxCartItems is 50.</summary>\n    if (items > 50) // MaxCartItems\n', cs, csConst), [2]);
  const py = pack('python');
  const pyConst = fileConstants('app/settings.py', 'TIMEOUT_SEC = 900\n', py);
  assert.deepEqual(lines('app/jobs.py', '# TIMEOUT_SEC is 900 by default\nTIMEOUT = 900  # TIMEOUT_SEC\n', py, pyConst), [2]);
  for (const name of ['typescript', 'dotnet', 'python']) assert.ok(pack(name).comments, `${name} says what a comment is`);
});

// Council r3 (sol-12): the member's reproducer. A changed file that declares a constant another file already declares
// (same name, same value) holds the knowledge twice: reported, as a differently named copy is.
test('sol-12: a constant redeclared under the same name in another file is a repeat', () => {
  const ts = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/typescript/repeats.json'), 'utf8'));
  const decl = 'export const REQUEST_TIMEOUT_MS = 900;\n';
  const constants = [...fileConstants('src/config.mjs', decl, ts), ...fileConstants('src/fetcher.mjs', decl, ts)];
  assert.equal(constants.length, 2, 'both declarations are read');
  const found = (text) => findRepeats('src/fetcher.mjs', text, ts, { constants, lines: new Set([1]) }).map((f) => [f.line, f.related]);
  assert.deepEqual(found(decl), [[1, ['src/config.mjs:1']]]);
  assert.deepEqual(found('const requestTimeout = 900;\n'), [[1, ['src/config.mjs:1']]], 'a differently named copy, as before');
});

// Council r3 (sol-05): the member's reproducer. Mail and Shop both default Timeout to 900; a .NET read names Shop's key
// through the default-argument overload or a GetSection chain (with `??`, an indexer, or the overload). Each repeats
// Shop's default, and with only Mail configured none of them is Mail's.
test('sol-05 r3: a qualified key through GetValue(key, default) or GetSection(section) is its own section\'s default', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/dotnet/repeats.json'), 'utf8'));
  const both = sourceDefaults('appsettings.json', '{"Mail":{"Timeout":900},"Shop":{"Timeout":900}}', patterns);
  const mailOnly = sourceDefaults('appsettings.json', '{"Mail":{"Timeout":900}}', patterns);
  const reads = [
    'var t = config.GetValue<int>("Shop:Timeout", 900);',
    'var t = config.GetSection("Shop").GetValue<int?>("Timeout") ?? 900;',
    'var t = config.GetSection("Shop").GetValue<int>("Timeout", 900);',
    'var t = config.GetSection("Shop")["Timeout"] ?? "900";',
  ];
  for (const code of reads) {
    const run = (defaults) => findRepeats('App.cs', `${code}\n`, patterns, { defaults }).map((f) => f.message.match(/default of (\S+),/)?.[1]);
    assert.deepEqual(run(both), ['Shop:Timeout'], code);
    assert.deepEqual(run(mailOnly), [], `${code}: Mail's default governs another key`);
  }
});

// Council r3 (test-value follow-up): a fallback in a whole-line comment is prose too; the same fallback in code is
// reported.
test('a fallback in a whole-line comment repeats nothing; in code it does', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/dotnet/repeats.json'), 'utf8'));
  const defaults = sourceDefaults('appsettings.json', '{"Shop":{"Timeout":900}}', patterns);
  const lines = (code) => findRepeats('App.cs', code, patterns, { defaults }).map((f) => [f.rule, f.line]);
  assert.deepEqual(lines('// var t = config["Shop:Timeout"] ?? 900;\nvar t = config["Shop:Timeout"] ?? 900;\n'), [['repeated-default', 2]]);
});

// Council r4 (sol-05): the member's reproducer. An explicit read names its full key from the root: `Shop:Timeout` is not
// `Tenant:Shop:Timeout` (GetSection("Tenant") first is), and `{"Shop:Timeout": 900}` is the same key as
// `{"Shop": {"Timeout": 900}}`, as .NET's JSON configuration provider reads them. An unqualified options property still
// matches by its last segment.
test('sol-05 r4: an explicit .NET read matches its full key path; colon-named JSON keys are the nested key', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/dotnet/repeats.json'), 'utf8'));
  const keys = (code, json) => findRepeats('App.cs', `${code}\n`, patterns, { defaults: sourceDefaults('appsettings.json', json, patterns) }).map((f) => f.message.match(/default of (\S+),/)?.[1]);
  const nested = '{"Tenant":{"Shop":{"Timeout":900}}}';
  assert.deepEqual(keys('var t = config.GetSection("Shop").GetValue<int?>("Timeout") ?? 900;', nested), []);
  assert.deepEqual(keys('var t = config.GetValue<int>("Shop:Timeout", 900);', nested), []);
  assert.deepEqual(keys('var t = config.GetSection("Tenant").GetSection("Shop").GetValue<int?>("Timeout") ?? 900;', nested), ['Tenant:Shop:Timeout']);
  for (const json of ['{"Shop:Timeout":900}', '{"Shop":{"Timeout":900}}']) {
    assert.deepEqual(keys('var t = config.GetValue<int>("Shop:Timeout", 900);', json), ['Shop:Timeout'], json);
    assert.deepEqual(keys('var t = config["Shop:Timeout"] ?? 900;', json), ['Shop:Timeout'], json);
  }
  assert.deepEqual(keys('var t = options.Timeout ?? 900;', nested), ['Tenant:Shop:Timeout'], 'an options property by its last segment');
});

// Council r5 (sol-05): the member's reproducer. A read on a section held in a variable is relative to the section:
// `shop.GetValue("Timeout")` after `var shop = config.GetSection("Shop")` reads Shop:Timeout, whatever top-level Timeout
// exists. A receiver the scanner cannot resolve is some section, never the root: matched by its last segments, below
// the top level.
test('sol-05 r5: a read on a section variable is that section\'s key; an unresolved receiver never cites a top-level key', () => {
  const patterns = JSON.parse(fs.readFileSync(path.join(INSTALL, 'packs/dotnet/repeats.json'), 'utf8'));
  const cited = (code, json, line) => findRepeats('App.cs', code, patterns, { defaults: sourceDefaults('appsettings.json', json, patterns), lines: new Set([line]) }).map((f) => [f.line, f.message.match(/default of (\S+),/)?.[1]]);
  const viaVariable = 'var shop = config.GetSection("Shop");\nvar timeout = shop.GetValue<int?>("Timeout") ?? 900;\n';
  assert.deepEqual(cited(viaVariable, '{"Shop":{"Timeout":900}}', 2), [[2, 'Shop:Timeout']]);
  assert.deepEqual(cited(viaVariable, '{"Timeout":900,"Shop":{"Timeout":900}}', 2), [[2, 'Shop:Timeout']], 'not the top-level Timeout');
  // A section of a section, through two variables.
  const nested = 'var tenant = Configuration.GetSection("Tenant");\nvar shop = tenant.GetSection("Shop");\nvar t = shop.GetValue<int>("Timeout", 900);\n';
  assert.deepEqual(cited(nested, '{"Shop":{"Timeout":900},"Tenant":{"Shop":{"Timeout":900}}}', 3), [[3, 'Tenant:Shop:Timeout']]);
  // A receiver of unknown origin (a parameter): some section, so not the top-level key; a nested key by its last segments.
  const unknown = 'var t = section.GetValue<int?>("Timeout") ?? 900;\n';
  assert.deepEqual(cited(unknown, '{"Timeout":900}', 1), []);
  assert.deepEqual(cited(unknown, '{"Shop":{"Timeout":900}}', 1), [[1, 'Shop:Timeout']]);
  // The root configuration reads from the root (round 4), by its name or its declared type.
  assert.deepEqual(cited('var t = config.GetValue<int>("Shop:Timeout", 900);\n', '{"Tenant":{"Shop":{"Timeout":900}}}', 1), []);
  assert.deepEqual(cited('int T(IConfiguration c) =>\n  c.GetValue<int>("Timeout", 900);\n', '{"Timeout":900,"Shop":{"Timeout":900}}', 2), [[2, 'Timeout']]);
  assert.deepEqual(cited('int T(IConfigurationSection c) =>\n  c.GetValue<int>("Timeout", 900);\n', '{"Timeout":900}', 2), [], 'a section parameter is not the root');
});
