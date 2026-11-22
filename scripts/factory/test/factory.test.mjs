// The generator, pointed at throwaway repositories in several languages: what it detects, what it
// writes, and that what it writes can be told apart from the team's own content and removed again.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { detect, draftProject, loadPacks } from '../lib/detect.mjs';
import { draftConfig, unfilledPlaceholders } from '../lib/init.mjs';
import { applyBlock, check, extractBlock, readManifest, render, stripBlock, uninstall } from '../lib/render.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FACTORY = path.join(INSTALL, 'bin/factory.mjs');
const packs = loadPacks(INSTALL);

function repo(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gen-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
// No test reaches a code host: the factory runs with a `gh` first on PATH that records its arguments and fails, whatever
// the machine has signed in.
const NO_HOST = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-no-host-')));
const GH_CALLS = path.join(NO_HOST, 'calls.log');
fs.writeFileSync(path.join(NO_HOST, 'gh'), `#!/bin/sh\necho "$*" >> "${GH_CALLS}"\nexit 1\n`, { mode: 0o755 });
fs.writeFileSync(path.join(NO_HOST, 'gh.cmd'), `@echo %* >> "${GH_CALLS}"\r\n@exit /b 1\r\n`);
process.on('exit', () => fs.rmSync(NO_HOST, { recursive: true, force: true }));
const factory = (root, args) => spawnSync(process.execPath, [FACTORY, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '', PATH: `${NO_HOST}${path.delimiter}${process.env.PATH ?? ''}` } });
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const RUST = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/api", "crates/web"]\n',
  'crates/api/Cargo.toml': '[package]\nname = "api"\n',
  'crates/api/src/main.rs': 'fn main() {}\n',
  'crates/api/tests/it.rs': '#[test]\nfn works() {}\n',
  'crates/web/Cargo.toml': '[package]\nname = "web"\n[dependencies]\nleptos = "0.6"\n',
  'crates/web/src/main.rs': 'fn main() {}\n',
  'docker-compose.yml': 'services:\n  db:\n    image: postgres\n',
};
const JAVA = {
  'pom.xml': '<project><modules><module>orders-service</module><module>orders-service-it</module></modules></project>\n',
  'orders-service/pom.xml': '<project><artifactId>orders-service</artifactId></project>\n',
  'orders-service/src/main/java/app/Orders.java': 'class Orders {}\n',
  'orders-service-it/pom.xml': '<project><artifactId>orders-service-it</artifactId></project>\n',
  'orders-service-it/src/test/java/app/OrdersIT.java': 'class OrdersIT {}\n',
  '.github/workflows/ci.yml': 'on: push\n',
};

test('detect: a Rust workspace is two services (one a frontend), the workspace root is not a unit of its own', () => {
  const found = detect(repo(RUST), packs);
  assert.deepEqual(found.languages.map((l) => l.id), ['rust']);
  assert.deepEqual(found.units.map((u) => [u.path, u.kind]), [['.', 'workspace'], ['crates/api', 'backend'], ['crates/web', 'frontend']]);
  assert.deepEqual(found.compose, ['docker-compose.yml']);
  const project = draftProject(found, packs);
  assert.deepEqual(project.services, [{ name: 'api', kind: 'backend', paths: ['crates/api/**'] }, { name: 'web', kind: 'frontend', paths: ['crates/web/**'] }]);
  assert.deepEqual(project.toolPaths, ['~/.cargo/bin']);
});

test('detect: a Maven multi-module project pairs a service with its test module', () => {
  const found = detect(repo(JAVA), packs);
  assert.deepEqual(found.languages.map((l) => l.id), ['java']);
  const project = draftProject(found, packs);
  assert.deepEqual(project.services, [{ name: 'orders-service', kind: 'backend', paths: ['orders-service/**'], unitTests: 'orders-service-it' }]);
  assert.deepEqual(project.testRoots, ['orders-service-it']);
  assert.deepEqual(found.ci, ['.github/workflows/ci.yml']);
});

test('detect: a codebase no pack knows still gets a (empty) project model', () => {
  const found = detect(repo({ 'main.zig': 'pub fn main() void {}\n' }), packs);
  assert.deepEqual(found.languages, []);
  assert.deepEqual(draftProject(found, packs).services, []);
});

// A .NET solution with a root package.json that only holds Playwright (the eShop layout).
const DOTNET_E2E = {
  'App.slnx': '<Solution />\n',
  'App.Web.slnf': '{ "solution": { "path": "App.slnx", "projects": [] } }\n',
  'src/Basket.API/Basket.API.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />\n',
  'src/Basket.API/Program.cs': 'class P {}\n',
  'tests/Basket.FunctionalTests/Basket.FunctionalTests.csproj': '<Project><ItemGroup><PackageReference Include="xunit" /></ItemGroup></Project>\n',
  'tests/Basket.UnitTests/Basket.UnitTests.csproj': '<Project Sdk="MSTest.Sdk" />\n',
  'package.json': '{ "devDependencies": { "@playwright/test": "^1" } }\n',
  'playwright.config.ts': "export default { testDir: './e2e' };\n",
  'e2e/cart.spec.ts': 'test("x", () => {});\n',
  '.github/workflows/ci.yml': 'jobs:\n  b:\n    steps:\n      - run: dotnet build App.Web.slnf\n',
};

test('init draft on a .NET solution with a root e2e harness: no "." test root, the solution CI builds, no tools the repo lacks', () => {
  const found = detect(repo(DOTNET_E2E), packs);
  const config = draftConfig(found, packs);
  assert.deepEqual(config.project.testRoots, ['tests/Basket.FunctionalTests', 'tests/Basket.UnitTests', 'e2e']);
  assert.ok(!config.implExclude.includes('.'), 'the repository root must stay implementation');
  assert.ok(config.implExclude.includes('e2e'));
  assert.equal(config.project.services[0].unitTests, 'tests/Basket.UnitTests', 'unit tests are preferred over functional tests');
  assert.equal(config.implement.checks.find((c) => c.name === 'build').cmd, 'dotnet build App.Web.slnf -nologo -v q -clp:ErrorsOnly');
  assert.ok(!config.implement.checks.some((c) => c.name === 'typecheck'), 'no tsconfig.json: no tsc check');
  assert.deepEqual(config.precheck.lint['.ts'], ['node', '{packs}/typescript/lint/eslint.mjs', '{files}'], "no ESLint in the repo: the TypeScript pack's own ESLint lints the specs agents touch");
  assert.ok(config.precheck.lint['.cs'] && config.precheck.fix['.ts']);
  assert.deepEqual(unfilledPlaceholders(config, packs), []);
  assert.equal(config.stack?.resolver, 'pack:dotnet/stack/services.mjs', "the pack's stack fragment reaches the draft");
  assert.equal(config.teststack?.commands?.['hash-password'], 'pack:dotnet/stack/hash-password.mjs');
});

test('init draft with an Aspire AppHost: the stack is published from it and drift is an implement check', () => {
  const root = repo({ ...DOTNET_E2E, 'src/App.AppHost/App.AppHost.csproj': '<Project Sdk="Aspire.AppHost.Sdk/13.6.0"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>\n', 'src/App.AppHost/AppHost.cs': 'var builder = DistributedApplication.CreateBuilder(args);\n', '.factory/stack/docker-compose.yaml': 'services: {}\n' });
  const found = detect(root, packs);
  const config = draftConfig(found, packs);
  assert.ok(config.project.services.some((s) => s.kind === 'host'), 'the AppHost is a host');
  assert.equal(config.stack.publish, 'node {packs}/dotnet/stack/aspire-publish.mjs --out {out}');
  assert.ok(config.implement.checks.some((c) => /teststack drift/.test(c.cmd)));
  const plain = draftConfig(detect(repo(DOTNET_E2E), packs), packs);
  assert.equal(plain.stack?.publish, undefined, 'no AppHost: no publisher drafted');
});

test('init draft: an ambiguous {solution} is left for the onboarding and reported', () => {
  const files = { ...DOTNET_E2E, '.github/workflows/ci.yml': 'on: push\n' };
  const config = draftConfig(detect(repo(files), packs), packs);
  assert.match(config.implement.checks[0].cmd, /\{solution\}/);
  assert.deepEqual(unfilledPlaceholders(config, packs), ['solution']);
  const single = { ...files };
  delete single['App.Web.slnf'];
  assert.equal(draftConfig(detect(repo(single), packs), packs).implement.checks[0].cmd, 'dotnet build App.slnx -nologo -v q -clp:ErrorsOnly');
});

test('blocks: a managed block is added, replaced in place and removed without touching the rest', () => {
  const once = applyBlock('# Team notes\n\nKeep me.\n', 'md', 'factory text');
  assert.match(once, /^# Team notes\n\nKeep me\.\n\n<!-- factory:begin/);
  assert.equal(extractBlock(once, 'md'), 'factory text');
  const twice = applyBlock(`${once}\nAfter the block.\n`, 'md', 'new text');
  assert.equal(extractBlock(twice, 'md'), 'new text');
  assert.equal((twice.match(/factory:begin/g) ?? []).length, 1);
  assert.match(twice, /After the block\./);
  assert.equal(stripBlock(once, 'md').trim(), '# Team notes\n\nKeep me.');
});

test('init on a Rust repository: a draft config, the shim, hooks, agent files and a manifest; nothing outside it', () => {
  const root = repo({ ...RUST, 'AGENTS.md': '# Ours\n', '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo team hook' }] }] } }) });
  const init = factory(root, ['init', '--tools', 'claude,codex']);
  assert.equal(init.status, 0, init.stderr);
  const config = JSON.parse(read(root, '.factory/config.json'));
  assert.deepEqual(config.project.languages, ['rust']);
  const app = JSON.parse(read(root, '.factory/app.json'));
  assert.equal(app.project.services.length, 2, "the application's topology is in app.json");
  assert.equal(config.project.services, undefined, 'and not in the governance file');
  assert.ok(config.implExclude.includes('.factory'));
  const pin = JSON.parse(read(root, '.factory/factory.json'));
  assert.deepEqual(pin.tools, ['claude', 'codex']);
  assert.match(pin.version, /^\d+\.\d+\.\d+/);

  // The team's own content is kept beside the factory's.
  const settings = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo team hook');
  assert.ok(settings.hooks.Stop.some((e) => e.hooks.some((h) => h.command === 'node .factory/bin/factory.mjs hook stop')));
  assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === 'node .factory/bin/factory.mjs hook pre-tool')));
  assert.equal(JSON.stringify(settings).includes('graphify'), false, 'graphify is off unless asked for');
  assert.match(read(root, 'AGENTS.md'), /^# Ours\n\n<!-- factory:begin/);
  assert.equal(fs.existsSync(path.join(root, 'GEMINI.md')), false, 'no file for a tool that was not chosen');
  assert.equal(fs.existsSync(path.join(root, '.github/agents')), false);
  assert.match(read(root, '.claude/agents/implementer.md'), /^---\n# Generated by `factory render`/);
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim(), '.factory/githooks');
  assert.equal(fs.statSync(path.join(root, '.factory/githooks/pre-push')).mode & 0o111, 0o111);

  const manifest = readManifest(root);
  assert.ok(manifest.files['.claude/settings.json'].kind === 'json' && manifest.files['AGENTS.md'].kind === 'block' && manifest.files['.factory/bin/factory.mjs'].kind === 'file');
  assert.equal(factory(root, ['check']).status, 0);

  // A second init keeps the reviewed config.
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ ...config, project: { ...config.project, name: 'reviewed' } }));
  assert.equal(factory(root, ['init']).status, 0);
  assert.equal(JSON.parse(read(root, '.factory/config.json')).project.name, 'reviewed');
});

test('check tells a team edit from a hand edit of a generated file; render repairs it', () => {
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const settings = JSON.parse(read(root, '.claude/settings.json'));
  settings.env = { TEAM: '1' };
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify(settings));
  fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nA note the team added after the block.\n');
  assert.equal(check(root, INSTALL).length, 0, 'content outside the factory entries is the team\'s');

  fs.appendFileSync(path.join(root, '.claude/agents/implementer.md'), '\nhand edit\n');
  settings.hooks.Stop = [];
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify(settings));
  const problems = check(root, INSTALL);
  assert.deepEqual(problems.map((p) => p.path).sort(), ['.claude/agents/implementer.md', '.claude/settings.json']);
  assert.equal(factory(root, ['check']).status, 1);
  render(root, INSTALL);
  assert.equal(check(root, INSTALL).length, 0);
  assert.deepEqual(JSON.parse(read(root, '.claude/settings.json')).env, { TEAM: '1' });
});

test('an addendum reaches the generated agent file, and turning a feature off removes its outputs', () => {
  const root = repo(JAVA);
  assert.equal(factory(root, ['init', '--tools', 'claude,copilot']).status, 0);
  fs.writeFileSync(path.join(root, '.factory/agents/implementer.md'), 'Build with `mvn -q verify`.\n');
  assert.equal(check(root, INSTALL).some((p) => p.path === '.claude/agents/implementer.md'), true);
  render(root, INSTALL);
  for (const f of ['.claude/agents/implementer.md', '.github/agents/implementer.agent.md']) assert.match(read(root, f), /## Project context\n\nBuild with `mvn -q verify`\./);
  assert.ok(fs.existsSync(path.join(root, '.mcp.json')));
  assert.equal(factory(root, ['init', '--without', 'lsp,agentFiles']).status, 0);
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude/agents')), false);
  assert.equal(JSON.stringify(JSON.parse(read(root, '.claude/settings.json'))).includes('lsp hook'), false);
  assert.equal(factory(root, ['check']).status, 0);
});

test('uninstall removes exactly what the factory added: the app is as it was, plus .factory/ until --all', () => {
  const before = { ...RUST, 'AGENTS.md': '# Ours\n', '.gitattributes': '* text=auto\n' };
  const root = repo(before);
  assert.equal(factory(root, ['init']).status, 0);
  uninstall(root, INSTALL);
  assert.equal(read(root, 'AGENTS.md').trim(), '# Ours');
  assert.equal(read(root, '.gitattributes').trim(), '* text=auto');
  for (const gone of ['.claude', '.codex', '.gemini', '.cursor', '.mcp.json', 'CLAUDE.md', '.factory/bin', '.factory/manifest.json']) assert.equal(fs.existsSync(path.join(root, gone)), false, gone);
  assert.ok(fs.existsSync(path.join(root, '.factory/config.json')), 'the settings stay until --all');
  uninstall(root, INSTALL, { all: true });
  assert.equal(fs.existsSync(path.join(root, '.factory')), false);
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
  assert.deepEqual(status, Object.keys(before).sort());
});

test('the app-repo shim runs the engine it finds, and a hook never fails for a missing install', () => {
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const shim = path.join(root, '.factory/bin/factory.mjs');
  const ok = spawnSync(process.execPath, [shim, 'version'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_HOME: INSTALL } });
  assert.match(ok.stdout, /^ai-app-factory \d/);
  // No install anywhere: no FACTORY_HOME, an empty HOME, and a PATH without an `npm link`ed factory.
  const env = { ...process.env, FACTORY_HOME: '', HOME: root, PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
  const hook = spawnSync(process.execPath, [shim, 'hook', 'stop'], { cwd: root, encoding: 'utf8', env, input: '{}' });
  assert.equal(hook.status, 0);
  assert.match(hook.stderr, /engine .* is not installed/);
  assert.equal(spawnSync(process.execPath, [shim, 'status'], { cwd: root, encoding: 'utf8', env }).status, 127);
  // `npm link` (setup.md) leaves only a `factory` symlink on PATH: the shim finds the engine through it.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-link-'));
  fs.symlinkSync(FACTORY, path.join(bin, 'factory'));
  const linkEnv = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const viaLink = spawnSync(process.execPath, [shim, 'version'], { cwd: root, encoding: 'utf8', env: linkEnv });
  assert.match(viaLink.stdout, /^ai-app-factory \d/);
  // An engine at another version than the pin (dogfood step 5: an `npm link`ed checkout ran instead of the pinned
  // release): refused for commands, warned about for hooks; an explicit FACTORY_HOME is used with a warning.
  const pinFile = path.join(root, '.factory/factory.json');
  fs.writeFileSync(pinFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pinFile, 'utf8')), version: '9.9.9' }));
  const refused = spawnSync(process.execPath, [shim, 'version'], { cwd: root, encoding: 'utf8', env: linkEnv });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is version .*, but this repository pins 9\.9\.9: install the pinned one/);
  const hookRuns = spawnSync(process.execPath, [shim, 'hook', 'stop'], { cwd: root, encoding: 'utf8', env: linkEnv, input: '{}' });
  assert.notEqual(hookRuns.status, 1, hookRuns.stderr);
  assert.match(hookRuns.stderr, /pins 9\.9\.9 \(a hook still runs\)/);
  const allowed = spawnSync(process.execPath, [shim, 'version'], { cwd: root, encoding: 'utf8', env: { ...linkEnv, FACTORY_ALLOW_UNPINNED: '1' } });
  assert.match(allowed.stdout, /^ai-app-factory \d/);
  const explicit = spawnSync(process.execPath, [shim, 'version'], { cwd: root, encoding: 'utf8', env: { ...env, FACTORY_HOME: INSTALL } });
  assert.match(explicit.stdout, /^ai-app-factory \d/);
  assert.match(explicit.stderr, /pins 9\.9\.9 \(FACTORY_HOME\)/);
});

test('graphify: init --with graphify ignores the local graph but keeps the shared semantic cache; factory graphify-build runs under bash', () => {
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude', '--with', 'graphify']).status, 0);
  const ignore = read(root, '.gitignore');
  assert.match(ignore, /graphify-out\/\*\n!graphify-out\/cache\/\ngraphify-out\/cache\/\*\n!graphify-out\/cache\/semantic\//);
  fs.mkdirSync(path.join(root, 'graphify-out/cache/semantic'), { recursive: true });
  fs.writeFileSync(path.join(root, 'graphify-out/graph.json'), '{}');
  fs.writeFileSync(path.join(root, 'graphify-out/cache/semantic/a.json'), '{}');
  const ignored = (rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: root }).status === 0;
  assert.ok(ignored('graphify-out/graph.json'));
  assert.ok(!ignored('graphify-out/cache/semantic/a.json'));
  for (const hook of ['post-checkout', 'post-rewrite']) assert.match(read(root, `.factory/githooks/${hook}`), /graphify-build/, `${hook} refreshes the graph`);
  // A bash-only script (process substitution) must not be run with `sh`.
  const sh = path.join(root, 'bashism.sh');
  fs.writeFileSync(sh, '#!/usr/bin/env bash\nwhile read -r l; do echo "got $l"; done < <(printf "x\\n")\n');
  const r = spawnSync('bash', [sh], { encoding: 'utf8' });
  assert.equal(r.stdout, 'got x\n');
  assert.match(fs.readFileSync(FACTORY, 'utf8'), /spawnSync\('bash', \[target\.script/);
  assert.equal(factory(root, ['uninstall']).status, 0);
  assert.ok(!fs.existsSync(path.join(root, '.gitignore')) || !read(root, '.gitignore').includes('graphify-out'), 'uninstall removes the block');
});

test('CI templates: every workflow and action parses, installs a private factory with FACTORY_TOKEN, and names no path only the source repository had', async () => {
  const { parse } = await import('yaml');
  const dir = path.join(INSTALL, 'templates/ci/github-actions');
  const files = fs.readdirSync(path.join(dir, 'workflows')).map((f) => path.join(dir, 'workflows', f)).concat(fs.readdirSync(path.join(dir, 'actions')).map((d) => path.join(dir, 'actions', d, 'action.yml')));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => parse(text), `${path.relative(INSTALL, file)} is not valid YAML`);
    assert.doesNotMatch(text, /\bscripts\/(review-gate|pipeline|board|implement)\/|\.github\/skills\//, `${path.relative(INSTALL, file)} refers to a path of the factory's source repository, not of an app repository`);
    for (const m of text.matchAll(/- uses: \.\/\.github\/actions\/setup-factory\n(\s*)(\S.*)?/g)) assert.ok(/with:|if:/.test(m[2] ?? ''), `${path.relative(INSTALL, file)}: setup-factory without the FACTORY_TOKEN input`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'actions/setup-factory/action.yml'), 'utf8'), /FACTORY_TOKEN/);
  // A called workflow gets at most its caller's permissions (GitHub fails the run at startup otherwise),
  // and secrets only when the caller passes them.
  const rank = { none: 0, read: 1, write: 2 };
  for (const f of fs.readdirSync(path.join(dir, 'workflows'))) {
    const caller = parse(fs.readFileSync(path.join(dir, 'workflows', f), 'utf8'));
    for (const [name, job] of Object.entries(caller.jobs ?? {})) {
      if (!String(job.uses ?? '').startsWith('./.github/workflows/')) continue;
      const calleeFile = path.join(dir, 'workflows', path.basename(job.uses).replace(/^factory-/, ''));
      const callee = parse(fs.readFileSync(calleeFile, 'utf8'));
      const have = { ...caller.permissions, ...job.permissions };
      for (const [scope, level] of Object.entries(callee.permissions ?? {})) assert.ok((rank[have[scope]] ?? 0) >= rank[level], `${f} job ${name}: the called workflow needs ${scope}: ${level}`);
      if (/secrets\./.test(fs.readFileSync(calleeFile, 'utf8'))) assert.ok(job.secrets, `${f} job ${name}: the called workflow uses secrets; pass them (secrets: inherit)`);
    }
  }
});

test('a repository that ignores bin/ (the .NET .gitignore) still commits the launcher; check reports a generated file git ignores', () => {
  const root = repo({ ...RUST, '.gitignore': '[Bb]in/\n' });
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const ignored = spawnSync('git', ['check-ignore', '-q', '.factory/bin/factory.mjs'], { cwd: root });
  assert.equal(ignored.status, 1, '.factory/bin must not be ignored');
  assert.equal(factory(root, ['check']).status, 0);
  fs.appendFileSync(path.join(root, '.gitignore'), '.claude/agents/\n');
  const r = factory(root, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\.claude\/agents\/implementer\.md: ignored by a \.gitignore/);
});

test('a fresh clone of a repository with "* text=auto" passes factory check (the CRLF launcher is not "edited by hand")', () => {
  const root = repo({ ...RUST, '.gitattributes': '* text=auto\n' });
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  git(root, 'add', '-A');
  assert.equal(git(root, 'commit', '-qm', 'factory').status, 0);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clone-'));
  assert.equal(spawnSync('git', ['clone', '-q', root, clone]).status, 0);
  const r = factory(clone, ['check']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(fs.readFileSync(path.join(clone, '.factory/bin/factory.cmd'), 'utf8'), /\r\n/, 'the .cmd launcher keeps CRLF');
});

test('init drafts a review gate that never lets a sensitive or shared change through on Low ratings', () => {
  const web = '<Project Sdk="Microsoft.NET.Sdk.Web">';
  const root = repo({
    'Shop.slnx': '<Solution />\n',
    'Directory.Packages.props': '<Project />\n',
    'src/Identity.Api/Identity.Api.csproj': `${web}</Project>\n`,
    'src/Identity.Api/Config.cs': 'class Config {}\n',
    'src/Payment.Worker/Payment.Worker.csproj': '<Project Sdk="Microsoft.NET.Sdk.Worker"></Project>\n',
    'src/Payment.Worker/Pay.cs': 'class Pay {}\n',
    'src/EventBus/EventBus.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'src/EventBus/IntegrationEvent.cs': 'public record IntegrationEvent;\n',
    'src/Catalog.Api/Catalog.Api.csproj': `${web}<ItemGroup><ProjectReference Include="..\\EventBus\\EventBus.csproj" /></ItemGroup></Project>\n`,
    'src/Catalog.Api/Infrastructure/Migrations/20240101_Init.cs': 'class Init {}\n',
    'src/Catalog.Api/IntegrationEvents/Events/PriceChangedIntegrationEvent.cs': 'public record PriceChangedIntegrationEvent(int Id) : IntegrationEvent;\n',
    'src/Catalog.Api/Apis/ItemsApi.cs': 'class ItemsApi {}\n',
    'src/Orders.Domain/Orders.Domain.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'src/Orders.Domain/Order.cs': 'class Order {}\n',
    'src/Orders.Api/Orders.Api.csproj': `${web}<ItemGroup><ProjectReference Include="..\\Orders.Domain\\Orders.Domain.csproj" /><ProjectReference Include="..\\EventBus\\EventBus.csproj" /></ItemGroup></Project>\n`,
    'src/Shared/MigrateExtensions.cs': 'static class MigrateExtensions {}\n',
    'tests/Catalog.Tests/Catalog.Tests.csproj': '<Project><ItemGroup><PackageReference Include="xunit" /></ItemGroup></Project>\n',
    'tests/Catalog.Tests/ItemsTests.cs': 'class ItemsTests {}\n',
  });
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const explain = (file) => JSON.parse(factory(root, ['review-gate', 'explain', file, '--json']).stdout);
  for (const file of ['src/Identity.Api/Config.cs', 'src/Payment.Worker/Pay.cs', 'src/Catalog.Api/Infrastructure/Migrations/20240101_Init.cs', 'src/Catalog.Api/IntegrationEvents/Events/PriceChangedIntegrationEvent.cs', 'src/Shared/MigrateExtensions.cs', 'Directory.Packages.props', 'src/EventBus/IntegrationEvent.cs']) {
    assert.equal(explain(file).pr.level, 'High', `${file} must be High on Low ratings`);
  }
  const testOnly = explain('tests/Catalog.Tests/ItemsTests.cs');
  assert.deepEqual([testOnly.systems.length, testOnly.pr.level], [0, 'Low'], 'a test-only change touches no system');
  const domain = explain('src/Orders.Domain/Order.cs');
  assert.deepEqual([domain.systems.map((s) => s.name), domain.pr.level], [['orders-api'], 'Low'], "a service's own domain project is part of that service, not shared");
  assert.equal(explain('src/Catalog.Api/Apis/ItemsApi.cs').pr.level, 'Low');
  for (const file of ['.factory/policy/rules/api.yaml', '.factory/agents/implementer.md', '.factory/app.json', '.factory/config.json', '.factory/stack/docker-compose.yaml']) {
    assert.equal(explain(file).ticket.level, 'High', `${file}: a change to the factory's governance is never Low`);
  }
});

test('a repository with a test stack gets implement.ui.teststackCmd; doctor flags a stack without it', () => {
  const root = repo({ ...RUST, '.factory/stack/docker-compose.yaml': 'services: {}\n' });
  // A GitHub origin: doctor asks the code host, and only the failing stub answers (Sol 38).
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: root });
  fs.rmSync(GH_CALLS, { force: true });
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const config = JSON.parse(read(root, '.factory/config.json'));
  assert.deepEqual(config.implement.ui.teststackCmd, ['node', '.factory/bin/factory.mjs', 'teststack']);
  assert.match(factory(root, ['doctor']).stdout, /ok +UI verifiers build the subtask's stack/);
  delete config.implement.ui;
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify(config));
  const r = factory(root, ['doctor']);
  assert.match(r.stdout, /MISSING +UI verifiers build the subtask's stack .*would test whatever already runs/);
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(GH_CALLS) && fs.readFileSync(GH_CALLS, 'utf8').trim(), 'doctor\'s code host calls went to the stub');
});

test('with demoVideo on, the agent instructions carry the feature-video definition of done; off, they do not', () => {
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude', '--with', 'demoVideo']).status, 0);
  assert.match(read(root, 'CLAUDE.md'), /## Feature videos \(definition of done\)/);
  assert.match(read(root, 'AGENTS.md'), /E2E_KEEP_VIDEOS=1 npx playwright test -c playwright\.teststack\.config\.ts/);
  const off = repo(RUST);
  assert.equal(factory(off, ['init', '--tools', 'claude']).status, 0);
  assert.doesNotMatch(read(off, 'CLAUDE.md'), /Feature videos/);
});

test('pre-commit: lints only the lines a commit touches, and keeps the shared graphify cache', () => {
  const root = repo({ ...RUST, 'notes/a.txt': 'ok\nBAD old line\nok\n' });
  assert.equal(factory(root, ['init', '--tools', 'claude', '--with', 'graphify']).status, 0);
  // A linter that flags every line containing BAD, in path:line form.
  fs.writeFileSync(path.join(root, 'lint.sh'), '#!/bin/sh\nfor f in "$@"; do grep -n BAD "$f" | sed "s#^#$f:#"; done | grep . && exit 1; exit 0\n', { mode: 0o755 });
  const config = JSON.parse(read(root, '.factory/config.json'));
  config.precheck = { ...(config.precheck ?? {}), lint: { '.txt': ['./lint.sh', '{files}'] } };
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'graphify-out/cache/semantic'), { recursive: true });
  fs.writeFileSync(path.join(root, 'graphify-out/cache/semantic/x.json'), '{}');
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_HOME: INSTALL } });
  git('add', '-A');
  assert.equal(git('commit', '-qm', 'base', '--no-verify').status, 0);
  assert.ok(fs.existsSync(path.join(root, '.factory/githooks/pre-commit')));
  // A clean change in a file that already has a finding elsewhere: the commit goes through.
  fs.writeFileSync(path.join(root, 'notes/a.txt'), 'ok, edited\nBAD old line\nok\n');
  git('add', 'notes/a.txt');
  const clean = git('commit', '-qm', 'clean edit');
  assert.equal(clean.status, 0, clean.stderr);
  // A finding on a changed line blocks it.
  fs.writeFileSync(path.join(root, 'notes/a.txt'), 'ok, edited\nBAD old line\nBAD new line\n');
  git('add', 'notes/a.txt');
  const bad = git('commit', '-qm', 'bad edit');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /notes\/a\.txt:3/);
  assert.doesNotMatch(bad.stderr, /notes\/a\.txt:2\b/);
  git('reset', '-q', '--hard');
  // A staged deletion of a semantic-cache entry is put back.
  git('rm', '-q', 'graphify-out/cache/semantic/x.json');
  assert.equal(git('commit', '-qm', 'drop cache', '--allow-empty').status, 0);
  assert.ok(fs.existsSync(path.join(root, 'graphify-out/cache/semantic/x.json')));
  assert.equal(git('ls-files', 'graphify-out/cache/semantic/x.json').stdout.trim(), 'graphify-out/cache/semantic/x.json');
});

test('agent instruction files the factory creates pass markdownlint (first line a top-level heading); an existing file keeps its title', () => {
  const root = repo({ ...RUST, 'GEMINI.md': '# Our Gemini notes\n\nKeep it short.\n' });
  assert.equal(factory(root, ['init', '--with', 'graphify,demoVideo']).status, 0);
  const lint = spawnSync(path.join(INSTALL, 'node_modules/.bin/markdownlint'), ['--disable', 'MD013', '--', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.match(read(root, 'AGENTS.md'), /^<!-- factory:begin[^\n]*-->\n# Agent instructions\n/);
  assert.doesNotMatch(read(root, 'GEMINI.md'), /# Agent instructions/, 'the team\'s own title stays the only one');
  assert.equal(factory(root, ['uninstall']).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false, 'a file the factory created goes away entirely');
});

test("the TypeScript pack's ESLint lints a repository without ESLint, on changed lines", async () => {
  const { lintChanged } = await import('../../pipeline/lib/lint.mjs');
  const root = repo({ ...DOTNET_E2E, 'e2e/cart.spec.ts': "import { test } from '@playwright/test';\ntest('a', async () => {});\n" });
  const config = { root, precheck: { lint: { '.ts': ['node', '{packs}/typescript/lint/eslint.mjs', '{files}'] } } };
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-qm', 'base', '--no-verify');
  fs.writeFileSync(path.join(root, 'e2e/cart.spec.ts'), "import { test } from '@playwright/test';\ntest('a', async () => {});\nconst unused: any = 1;\n");
  git('add', '-A');
  const errors = lintChanged(config, ['e2e/cart.spec.ts'], { staged: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no-explicit-any|no-unused-vars/);
});

test('code owners: render owns .factory/ and every generated file for the pin\'s owners; doctor says whether GitHub enforces the review', async () => {
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude', '--owners', 'alice,@org/platform']).status, 0);
  assert.deepEqual(JSON.parse(read(root, '.factory/factory.json')).owners, ['@alice', '@org/platform']);
  const owners = read(root, '.github/CODEOWNERS');
  assert.match(owners, /^\/\.factory\/ @alice @org\/platform$/m);
  for (const p of ['/.claude/settings.json', '/.claude/agents/implementer.md', '/.github/workflows/factory-gate.yml', '/CLAUDE.md', '/AGENTS.md', '/.github/CODEOWNERS']) assert.match(owners, new RegExp(`^${p.replace(/[.]/g, '\\.')} @alice`, 'm'), p);
  assert.equal(factory(root, ['check']).status, 0, 'the CODEOWNERS block is a tracked output');

  const { reviewEnforcement } = await import('../lib/github.mjs');
  const gh = (answers) => (args) => answers(args.join(' '));
  const branch = { status: 0, stdout: 'main\n', stderr: '' };
  assert.equal(reviewEnforcement(null), null, 'no GitHub remote: nothing to ask');
  let r = reviewEnforcement('o/r', gh((a) => (a.includes('rules') || a.includes('protection') ? { status: 1, stdout: '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}', stderr: 'gh: (HTTP 403)' } : branch)));
  assert.equal(r[0], false);
  assert.match(r[1], /public repository or a paid plan.*advisory.*owner decision/);
  r = reviewEnforcement('o/r', gh((a) => (a.includes('rules') ? { status: 0, stdout: '[]' } : a.includes('protection') ? { status: 1, stdout: '', stderr: 'Branch not protected (HTTP 404)' } : branch)));
  assert.match(r[1], /does not require the review-quorum status check or code-owner review/);
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'review-quorum' }] } }, { type: 'pull_request', parameters: { require_code_owner_review: true } }];
  r = reviewEnforcement('o/r', gh((a) => (a.includes('rules') ? { status: 0, stdout: JSON.stringify(rules) } : a.includes('protection') ? { status: 1, stdout: '', stderr: 'Branch not protected (HTTP 404)' } : branch)));
  assert.deepEqual(r[0], true);
  // Doctor: a code-owner rule nobody can satisfy is reported; without it, review-quorum alone is fine.
  const alone = { satisfiable: false, reason: 'the only code owner of .factory/ (@alice) is also the author' };
  r = reviewEnforcement('o/r', gh((a) => (a.includes('rules') ? { status: 0, stdout: JSON.stringify(rules) } : a.includes('protection') ? { status: 1, stdout: '', stderr: 'Branch not protected (HTTP 404)' } : branch)), { review: alone });
  assert.equal(r[0], false);
  assert.match(r[1], /requires code-owner review, but nobody can give it on the pipeline's PRs: the only code owner/);
  r = reviewEnforcement('o/r', gh((a) => (a.includes('rules') ? { status: 0, stdout: JSON.stringify([rules[0]]) } : a.includes('protection') ? { status: 1, stdout: '', stderr: 'Branch not protected (HTTP 404)' } : branch)), { review: alone });
  assert.equal(r[0], true);
  assert.match(r[1], /requires review-quorum \(code-owner review is not required: the only code owner/);
});

test("doctor: a language the packs can lint but precheck.lint leaves out is MISSING; init maps .js/.mjs/.cjs/.jsx/.tsx", () => {
  const root = repo({ ...DOTNET_E2E, 'src/Api/wwwroot/js/app.js': 'export const a = 1;\n', 'src/Api/wwwroot/lib/jquery/jquery.min.js': 'x\n' });
  spawnSync('git', ['add', '-A'], { cwd: root });
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  const config = JSON.parse(read(root, '.factory/config.json'));
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']) assert.ok(config.precheck.lint[ext], ext);
  assert.match(factory(root, ['doctor']).stdout, /ok +linters cover every language the packs can lint/);
  delete config.precheck.lint['.js'];
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify(config));
  assert.match(factory(root, ['doctor']).stdout, /MISSING +linters cover every language the packs can lint +\(\.js file\(s\) are tracked/);
});

test('doctor reads classic branch protection as well as rulesets', async () => {
  const { reviewEnforcement } = await import('../lib/github.mjs');
  const branch = { status: 0, stdout: 'main\n', stderr: '' };
  const noRules = { status: 0, stdout: '[]' };
  const classic = (prot) => ({ status: 0, stdout: JSON.stringify(prot) });
  const gh = (rules, prot) => (args) => (args[1].endsWith('/protection') ? prot : args[1].includes('/rules/') ? rules : branch);
  let r = reviewEnforcement('o/r', gh(noRules, classic({ required_status_checks: { contexts: ['review-quorum'] }, required_pull_request_reviews: { require_code_owner_reviews: true } })));
  assert.deepEqual(r, [true, "o/r's main requires review-quorum and code-owner review (branch protection)"]);
  r = reviewEnforcement('o/r', gh(noRules, classic({ required_status_checks: { checks: [{ context: 'review-quorum' }] } })));
  assert.match(r[1], /does not require code-owner review \(checked rulesets and branch protection\)/);
  r = reviewEnforcement('o/r', gh(noRules, { status: 1, stdout: '{"message":"Branch not protected"}', stderr: 'gh: Branch not protected (HTTP 404)' }));
  assert.match(r[1], /does not require the review-quorum status check or code-owner review/);
});

test('review-gate enforce: one ruleset like the reference, created once, unchanged after; a free private repository is refused', async () => {
  const { enforce, desiredRuleset } = await import('../../review-gate/lib/enforcement.mjs');
  const rulesets = [];
  const calls = [];
  const gh = (args, opts = {}) => {
    calls.push(args.join(' '));
    const [, method, url] = args[1] === '-X' ? [null, args[2], args[3]] : [null, 'GET', args[1]];
    if (url === 'repos/o/r') return { status: 0, stdout: JSON.stringify({ private: false, visibility: 'public', default_branch: 'main' }) };
    if (url === 'repos/o/r/rulesets' && method === 'GET') return { status: 0, stdout: JSON.stringify(rulesets.map(({ id, name }) => ({ id, name }))) };
    if (url === 'repos/o/r/rulesets' && method === 'POST') { rulesets.push({ id: 7, ...JSON.parse(opts.input) }); return { status: 0, stdout: JSON.stringify(rulesets[0]) }; }
    if (url === 'repos/o/r/rulesets/7' && method === 'PUT') { rulesets[0] = { id: 7, ...JSON.parse(opts.input) }; return { status: 0, stdout: JSON.stringify(rulesets[0]) }; }
    // GitHub answers with parameters of its own added.
    if (url === 'repos/o/r/rulesets/7') return { status: 0, stdout: JSON.stringify({ ...rulesets[0], rules: rulesets[0].rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, required_reviewers: [], require_extra_approval_for_unattributed_changes: true } } : x)) }) };
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  assert.equal(enforce(gh, 'o/r', { codeOwners: true, dryRun: true }).action, 'would-create');
  assert.equal(rulesets.length, 0, 'a dry run changes nothing');
  const created = enforce(gh, 'o/r', { codeOwners: true });
  assert.equal(created.action, 'created');
  assert.deepEqual(rulesets[0].conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.deepEqual(rulesets[0].rules.map((x) => x.type), ['required_status_checks', 'pull_request']);
  assert.equal(rulesets[0].rules[0].parameters.required_status_checks[0].context, 'review-quorum');
  assert.equal(rulesets[0].rules[1].parameters.require_code_owner_review, true);
  assert.equal(rulesets[0].rules[1].parameters.required_approving_review_count, 0, 'the gate sets the count per pull request');
  assert.equal(enforce(gh, 'o/r', { codeOwners: true }).action, 'unchanged');
  assert.deepEqual(desiredRuleset('main', { codeOwners: false }).rules.map((x) => x.type), ['required_status_checks']);
  // A sole code owner who also authors the pipeline's PRs (no PR bot) could never give the review: the rule is
  // left out (the reference requires review-quorum only), with a warning saying what makes it satisfiable.
  const { codeOwnerReview } = await import('../../review-gate/lib/codeowners.mjs');
  const alone = codeOwnerReview({ owners: ['@alice'], author: 'alice' });
  assert.equal(alone.satisfiable, false);
  assert.match(alone.reason, /only code owner .*@alice.* is also the author .*alice, because the PR bot is not set up/);
  assert.equal(codeOwnerReview({ owners: ['@alice'], author: 'dev-bot-alice[bot]', botConfigured: true }).satisfiable, true, 'with the bot, the owner can approve');
  assert.equal(codeOwnerReview({ owners: ['@alice', '@org/platform'], author: 'alice' }).satisfiable, true, 'a team may hold someone else');
  const updated = enforce(gh, 'o/r', { codeOwners: true, review: alone });
  assert.equal(updated.action, 'updated');
  assert.deepEqual(rulesets[0].rules.map((x) => x.type), ['required_status_checks'], 'the unsatisfiable code-owner rule is removed');
  assert.match(updated.warnings[0], /code-owner review is not required: the only code owner/);
  const privateGh = (args) => (args[1] === 'repos/p/q' ? { status: 0, stdout: JSON.stringify({ private: true, visibility: 'private', default_branch: 'main' }) } : { status: 1, stdout: '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}', stderr: 'HTTP 403' });
  assert.throws(() => enforce(privateGh, 'p/q', { codeOwners: true }), /private on a plan without rulesets.*Nothing changed/);
});

test('workflow safety: no FACTORY_TOKEN for forks or for anyone who can comment; the rendered workflows pass', async () => {
  const { workflowProblems } = await import('../lib/workflow-safety.mjs');
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  assert.deepEqual(workflowProblems(root), [], 'every generated workflow');
  const wf = (name, text) => fs.writeFileSync(path.join(root, '.github/workflows', name), text);
  wf('target.yml', 'on: pull_request_target\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n    - uses: actions/checkout@v4\n      with:\n        ref: ${{ github.event.pull_request.head.sha }}\n    - run: echo ${{ secrets.FACTORY_TOKEN }}\n');
  wf('comment.yml', 'on:\n  issue_comment:\n    types: [created]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n    - uses: ./.github/actions/setup-factory\n      with:\n        token: ${{ secrets.FACTORY_TOKEN }}\n');
  const problems = workflowProblems(root).map((p) => `${p.path}: ${p.problem}`);
  assert.ok(problems.some((p) => /target\.yml: pull_request_target runs with secrets/.test(p)));
  assert.ok(problems.some((p) => /target\.yml: pull_request_target checks out the pull request's own code/.test(p)));
  assert.ok(problems.some((p) => /comment\.yml: issue_comment can be triggered by anyone/.test(p)));
  const r = factory(root, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /target\.yml: pull_request_target runs with secrets/);
});

test('upgrade --install fetches the pinned version and completes the install: Python for the policy, the code-intelligence check (dogfood step 5)', () => {
  const root = repo(RUST);
  assert.equal(factory(root, ['init', '--tools', 'claude']).status, 0);
  // A local "factory repository" with a tag v9.9.9 whose engine records the commands it is given.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-src-'));
  const g = (...args) => spawnSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', ...args], { cwd: src, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"ai-app-factory","version":"9.9.9"}\n');
  fs.writeFileSync(path.join(src, 'bin', 'factory.mjs'), "import fs from 'node:fs';\nfs.appendFileSync(process.env.FACTORY_HOME + '/calls.txt', process.argv.slice(2).join(' ') + '\\n');\n");
  g('add', '-A');
  g('commit', '-qm', 'engine');
  g('tag', 'v9.9.9');
  const pinFile = path.join(root, '.factory/factory.json');
  fs.writeFileSync(pinFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pinFile, 'utf8')), source: src }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-'));
  const r = spawnSync(process.execPath, [FACTORY, 'upgrade', '9.9.9', '--install'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, FACTORY_HOME: INSTALL } });
  assert.equal(r.status, 0, r.stderr);
  const dest = path.join(home, '.ai-app-factory', 'versions', '9.9.9');
  assert.deepEqual(fs.readFileSync(path.join(dest, 'calls.txt'), 'utf8').trim().split('\n'), ['python setup', 'lsp setup'], 'an engine without install-setup gets these steps from the running engine');
  assert.equal(JSON.parse(fs.readFileSync(pinFile, 'utf8')).version, '9.9.9');
  // A version that ships install-setup.mjs completes its own install with it, in a fresh clone with no packages
  // installed yet (it imports nothing but Node's modules).
  fs.mkdirSync(path.join(src, 'scripts', 'factory'), { recursive: true });
  fs.copyFileSync(path.join(INSTALL, 'scripts', 'factory', 'install-setup.mjs'), path.join(src, 'scripts', 'factory', 'install-setup.mjs'));
  g('add', '-A');
  g('commit', '-qm', 'engine 2');
  g('tag', 'v9.9.10');
  const r2 = spawnSync(process.execPath, [FACTORY, 'upgrade', '9.9.10', '--install'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, FACTORY_HOME: INSTALL } });
  assert.equal(r2.status, 0, r2.stderr);
  const dest2 = path.join(home, '.ai-app-factory', 'versions', '9.9.10');
  assert.ok(!fs.existsSync(path.join(dest2, 'node_modules')), 'no packages were needed to run it');
  assert.deepEqual(fs.readFileSync(path.join(dest2, 'calls.txt'), 'utf8').trim().split('\n'), ['python setup', 'lsp setup']);
  for (const d of [src, home]) fs.rmSync(d, { recursive: true, force: true });
});
