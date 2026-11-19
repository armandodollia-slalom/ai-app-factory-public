// Building images, the slot env file, incremental rebuilds and the generated compose file, with a fake shell
// and a fake docker: which configured commands run, with which placeholders, and what is recorded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../lib/common.mjs';
import { parseEnv } from '../lib/context.mjs';
import { build, contentHash, expand, imageRefs, publish, rebuildChanged, withBuildLock } from '../lib/images.mjs';
import { SHOP, makeContext } from './helpers.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-home-'));

// A repository whose images come from a build tool that writes an env file naming them (like a generated stack).
const GENERATED = {
  stack: {
    ...SHOP.stack,
    envTemplate: '.factory/stack/.env',
    services: { web: { inputs: ['web/**'], image: { env: 'WEB_IMAGE' } }, api: { inputs: ['api/**'], image: { env: 'API_IMAGE' } } },
    build: {
      all: 'tool build-all -o {out} --tag {imageTag}', service: 'tool build {service} -o {out}', serviceNext: 'tool build {service} -o {out} --no-restore',
      env: { TOOL_MODE: 'teststack' }, envFile: ['{out}/.env.*', '{out}/.env'], inputs: ['web', 'api'], exclude: ['web/assets/'],
    },
    publish: 'tool publish -o {out}',
  },
  teststack: { stores: {}, services: [] },
};
const FILES = { 'web/index.js': '1', 'web/assets/logo.png': 'png', 'api/main.py': '1', '.factory/stack/.env': '# generated\nWEB_IMAGE=\nAPI_IMAGE=\nDB_PASSWORD=\n', '.factory/stack/docker-compose.yaml': 'services: {}\n' };

// The fake build tool: records the command and its environment, and writes the env file a real one would.
function fakeShell(ctx, { envText = 'WEB_IMAGE=web:latest\nAPI_IMAGE=registry.local:5000/shop/api:latest\nDB_PASSWORD=\n', onRun } = {}) {
  const commands = [];
  ctx.shell = async (command, args, options) => {
    commands.push({ command, env: options.env, cwd: options.cwd, shell: options.shell });
    const out = /-o (\S+)/.exec(command)?.[1];
    if (command.includes('build-all')) fs.writeFileSync(path.join(out, '.env.teststack'), envText);
    onRun?.(command, out);
    return { status: command.includes('fail') ? 1 : 0, stdout: '', stderr: '' };
  };
  return commands;
}

const images = (ids = {}) => call => {
  if (call.docker?.[0] === 'image') return ids[call.docker.at(-1)] === null ? { status: 1 } : { stdout: `sha256:${ids[call.docker.at(-1)] ?? call.docker.at(-1)}\n` };
  if (call.compose?.[0] === 'ps') return { stdout: ids.running && call.compose.includes('-q') ? 'abc123\n' : '' };
  return null;
};

test('the slot env file: template, last build, fixed test values (overridable from the environment) and the slot ports', async () => {
  const { ctx, root } = await makeContext(GENERATED, { files: { ...FILES, '.factory/state/teststack/slot-2/.env': 'WEB_IMAGE=web:shop-teststack-2\nDB_PASSWORD=\n' }, slot: 2, env: { CACHE_PASSWORD: 'from-env' } });
  assert.deepEqual(ctx.envValues(), { WEB_IMAGE: 'web:shop-teststack-2', API_IMAGE: '', DB_PASSWORD: 'secret-db', CACHE_PASSWORD: 'from-env', WEB_HOST_PORT: '20080', API_HOST_PORT: '20081', DB_HOST_PORT: '20432' });
  assert.equal(ctx.secret('DB_PASSWORD'), 'secret-db');
  assert.equal(ctx.secret('CACHE_PASSWORD'), 'from-env');
  assert.throws(() => ctx.secret('NOPE'), /Variable 'NOPE' is not set in .factory\/state\/teststack\/slot-2\/.env, stack.env or the environment/);
  ctx.syncEnv();
  assert.deepEqual(parseEnv(fs.readFileSync(path.join(root, '.factory/state/teststack/slot-2/.env'), 'utf8')), ctx.envValues());
  assert.deepEqual(parseEnv('# c\n\nA=1\nB="two words"\nC=\'x\'\nbroken\n D = spaced \n'), { A: '1', B: 'two words', C: 'x', D: 'spaced' });
  assert.equal(expand('{service}:{imageTag} {unknown}', { service: 'web', imageTag: 't' }), 'web:t {unknown}');
});

test('build runs stack.build.all, adopts its env file, retags each image for the slot and records what it built', async () => {
  const { ctx, calls, root } = await makeContext(GENERATED, { files: FILES, git: true, slot: 1, respond: images(), env: { TESTSTACK_STATE_HOME: home() } });
  const commands = fakeShell(ctx);
  assert.deepEqual(await build(ctx), { built: true });

  const out = path.join(root, '.factory/state/teststack/slot-1/build');
  assert.deepEqual(commands.map(c => c.command), [`tool build-all -o ${out} --tag shop-teststack-1`]);
  assert.equal(commands[0].cwd, root);
  assert.equal(commands[0].shell, true);
  const { TOOL_MODE, TESTSTACK_SLOT, TESTSTACK_PROJECT, TESTSTACK_IMAGE_TAG, DB_PASSWORD, WEB_HOST_PORT } = commands[0].env;
  assert.deepEqual({ TOOL_MODE, TESTSTACK_SLOT, TESTSTACK_PROJECT, TESTSTACK_IMAGE_TAG, DB_PASSWORD, WEB_HOST_PORT },
    { TOOL_MODE: 'teststack', TESTSTACK_SLOT: '1', TESTSTACK_PROJECT: 'shop-teststack-1', TESTSTACK_IMAGE_TAG: 'shop-teststack-1', DB_PASSWORD: 'secret-db', WEB_HOST_PORT: '19080' });

  assert.deepEqual(calls.filter(call => call.docker?.[0] === 'tag').map(call => call.docker), [
    ['tag', 'web:latest', 'web:shop-teststack-1'],
    ['tag', 'registry.local:5000/shop/api:latest', 'registry.local:5000/shop/api:shop-teststack-1'],
  ]);
  assert.deepEqual(parseEnv(fs.readFileSync(ctx.envFile, 'utf8')), {
    WEB_IMAGE: 'web:shop-teststack-1', API_IMAGE: 'registry.local:5000/shop/api:shop-teststack-1', DB_PASSWORD: 'secret-db', CACHE_PASSWORD: 'secret-cache',
    WEB_HOST_PORT: '19080', API_HOST_PORT: '19081', DB_HOST_PORT: '19432',
  });
  assert.deepEqual(imageRefs(ctx).map(i => i.ref), ['web:shop-teststack-1', 'registry.local:5000/shop/api:shop-teststack-1']);
  assert.equal(fs.readFileSync(path.join(ctx.stateDir, 'images.stamp'), 'utf8').trim(), contentHash(ctx));
  assert.equal(fs.readFileSync(path.join(ctx.stateDir, 'images.ids'), 'utf8'),
    'registry.local:5000/shop/api:shop-teststack-1 sha256:registry.local:5000/shop/api:shop-teststack-1\nweb:shop-teststack-1 sha256:web:shop-teststack-1\n');

  // Nothing changed: no second build. An excluded or unrelated file does not count; a source file does.
  assert.deepEqual(await build(ctx), { built: false });
  fs.writeFileSync(path.join(root, 'web/assets/new.png'), 'x');
  fs.writeFileSync(path.join(root, 'README.md'), 'x');
  assert.deepEqual(await build(ctx), { built: false });
  fs.writeFileSync(path.join(root, 'api/main.py'), '2');
  assert.deepEqual(await build(ctx), { built: true });
  assert.deepEqual(await build(ctx, { force: true }), { built: true });
  assert.equal(commands.length, 3);
});

test('build is repeated when an image is missing or another checkout rebuilt the slot; failures are reported', async () => {
  const ids = {};
  const { ctx } = await makeContext(GENERATED, { files: FILES, git: true, respond: images(ids), env: { TESTSTACK_STATE_HOME: home() } });
  const commands = fakeShell(ctx);
  await build(ctx);
  ids['web:shop-teststack'] = 'rebuilt-elsewhere';
  assert.deepEqual(await build(ctx), { built: true }, 'image ids differ from the record');
  ids['web:shop-teststack'] = null;
  await assert.rejects(build(ctx), /images are missing after the build: web:shop-teststack/);
  assert.equal(commands.length, 3);

  const missing = await makeContext(GENERATED, { files: FILES, git: true, respond: images(), env: { TESTSTACK_STATE_HOME: home() } });
  fakeShell(missing.ctx, { envText: 'WEB_IMAGE=web:latest\nAPI_IMAGE=api:latest\n' });
  missing.ctx.stack.env = {};
  await assert.rejects(build(missing.ctx), /\.factory\/state\/teststack\/\.env has no value for DB_PASSWORD after the build/);

  const failing = await makeContext({ ...GENERATED, stack: { ...GENERATED.stack, build: { ...GENERATED.stack.build, all: 'tool fail -o {out}' } } }, { files: FILES, git: true, respond: images(), env: { TESTSTACK_STATE_HOME: home() } });
  fakeShell(failing.ctx);
  await assert.rejects(build(failing.ctx), /stack.build.all failed \(1\): tool fail -o /);
  const noDocker = await makeContext(GENERATED, { files: FILES, git: true, respond: call => (call.docker?.[0] === 'info' ? { status: 1 } : null), env: { TESTSTACK_STATE_HOME: home() } });
  await assert.rejects(build(noDocker.ctx), /the daemon is not reachable/);
});

test('without build commands the images are built by docker compose and named after the compose project', async () => {
  const { ctx, calls } = await makeContext(SHOP, { files: FILES, git: true, slot: 3, respond: images(), env: { TESTSTACK_STATE_HOME: home() } });
  assert.deepEqual(await build(ctx), { built: true });
  assert.deepEqual(calls.filter(call => call.compose).map(call => call.compose), [['build']]);
  assert.deepEqual(imageRefs(ctx), [{ service: 'web', ref: 'shop-teststack-3-web' }, { service: 'api', ref: 'shop-teststack-3-api' }]);
  assert.equal(calls.some(call => call.docker?.[0] === 'tag'), false);
});

test('rebuild-changed builds only the services the diff touches and recreates only their containers', async () => {
  const { ctx, calls, root } = await makeContext(GENERATED, { files: FILES, git: true, respond: images({ running: true }), env: { TESTSTACK_STATE_HOME: home() } });
  const commands = fakeShell(ctx);
  await build(ctx);
  commands.length = 0;
  calls.length = 0;

  fs.writeFileSync(path.join(root, 'api/main.py'), 'changed');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'untracked, affects nothing');
  const result = await rebuildChanged(ctx, { base: 'HEAD', only: [], timeoutSec: 5 });
  const out = path.join(root, '.factory/state/teststack/build-partial');
  assert.deepEqual(commands.map(c => c.command), [`tool build api -o ${out}`]);
  assert.deepEqual(calls.filter(call => call.docker?.[0] === 'tag').map(call => call.docker), [['tag', 'registry.local:5000/shop/api:latest', 'registry.local:5000/shop/api:shop-teststack']]);
  assert.deepEqual(calls.filter(call => call.compose?.[0] === 'up').map(call => call.compose), [['up', '-d', '--no-deps', 'api']]);
  assert.deepEqual({ ...result, elapsedMs: 0 }, {
    ok: true, command: 'rebuild-changed', base: 'HEAD', changedFiles: 2, services: ['api'], full: false, recreated: ['api'],
    wait: { ok: true, command: 'wait', restarted: [], failing: [] }, elapsedMs: 0,
  });

  // Nothing affected: nothing built, nothing recreated.
  fs.writeFileSync(path.join(root, 'api/main.py'), '1');
  commands.length = 0;
  const none = await rebuildChanged(ctx, { base: 'HEAD', only: [], timeoutSec: 5 });
  assert.deepEqual([none.services, none.recreated, commands.length], [[], [], 0]);

  // Every service named: one full build instead of one build per service.
  const all = await rebuildChanged(ctx, { base: null, only: ['web', 'api'], timeoutSec: 5 });
  assert.deepEqual([all.full, all.services, commands.map(c => c.command.split(' ')[1])], [true, ['web', 'api'], ['build-all']]);

  await assert.rejects(rebuildChanged(ctx, { base: null, only: ['nope'], timeoutSec: 5 }), error => error.exitCode === EXIT.usage && /unknown service 'nope' \(built services: web api\)/.test(error.message));
  await assert.rejects(rebuildChanged(ctx, { base: 'no-such-ref', only: [], timeoutSec: 5 }), error => error.exitCode === EXIT.usage && /unknown git ref/.test(error.message));
});

test('rebuild-changed uses serviceNext after the first service, and builds everything when the slot images are not ours', async () => {
  const config = structuredClone(GENERATED);
  config.stack.services.worker = { inputs: ['worker/**'], image: { env: 'WORKER_IMAGE' } };
  const ids = {};
  const { ctx } = await makeContext(config, { files: { ...FILES, 'worker/w.py': '1' }, git: true, respond: images(ids), env: { TESTSTACK_STATE_HOME: home() } });
  const commands = fakeShell(ctx, { envText: 'WEB_IMAGE=web:latest\nAPI_IMAGE=api:latest\nWORKER_IMAGE=worker:latest\n' });
  await build(ctx);
  commands.length = 0;
  const partial = await rebuildChanged(ctx, { base: null, only: ['web', 'api'], timeoutSec: 5 });
  assert.deepEqual(commands.map(c => c.command.replace(/ -o \S+/, '')), ['tool build web', 'tool build api --no-restore']);
  assert.deepEqual([partial.full, partial.recreated], [false, []], 'the stack is not running: nothing to recreate');

  ids['worker:shop-teststack'] = 'built-by-another-worktree';
  commands.length = 0;
  const full = await rebuildChanged(ctx, { base: null, only: ['web'], timeoutSec: 5 });
  assert.deepEqual([full.full, full.services, commands.length], [true, ['web', 'api', 'worker'], 1]);
});

test('publish regenerates the compose folder; --check fails on drift, or runs stack.publishCheck', async () => {
  const { ctx, root } = await makeContext(GENERATED, { files: FILES });
  let generated = 'services: {}\n';
  const commands = fakeShell(ctx, { onRun: (command, out) => { if (command.includes('publish')) fs.writeFileSync(path.join(out, 'docker-compose.yaml'), generated); } });
  assert.deepEqual(await publish(ctx, { check: false }), { ok: true, command: 'publish', output: '.factory/stack' });
  assert.equal(commands[0].command, `tool publish -o ${path.join(root, '.factory/stack')}`);
  assert.equal(commands[0].env.TOOL_MODE, 'teststack');
  assert.deepEqual(await publish(ctx, { check: true }), { ok: true, command: 'publish', check: 'clean' });
  assert.notEqual(commands[1].command, commands[0].command, '--check publishes to a temporary folder');
  generated = 'services: { new: {} }\n';
  await assert.rejects(publish(ctx, { check: true }), /\.factory\/stack is out of date \(docker-compose.yaml\): what the application publishes now differs[\s\S]*\+ services: \{ new: \{\} \}[\s\S]*Run 'factory teststack publish' and commit the result/);
  assert.equal(fs.readFileSync(path.join(root, '.factory/stack/docker-compose.yaml'), 'utf8'), 'services: {}\n', '--check never writes the committed files');

  ctx.stack.publishCheck = 'tool verify {composeFile}';
  await publish(ctx, { check: true });
  assert.equal(commands.at(-1).command, 'tool verify .factory/stack/docker-compose.yaml');
  const manual = await makeContext(SHOP);
  await assert.rejects(publish(manual.ctx, { check: false }), /stack.publish is not configured/);
});

test('the image build lock is machine-wide per project: a second build waits, a dead holder is evicted', async () => {
  const stateHome = home();
  const { ctx } = await makeContext(SHOP, { env: { TESTSTACK_STATE_HOME: stateHome } });
  const order = [];
  const first = withBuildLock(ctx, async () => { order.push('first in'); await new Promise(resolve => setTimeout(resolve, 60)); order.push('first out'); });
  const second = withBuildLock(ctx, async () => { order.push('second in'); }, { pollMs: 10 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
  assert.equal(fs.existsSync(path.join(stateHome, 'build.lock')), false);

  fs.mkdirSync(path.join(stateHome, 'build.lock'));
  fs.writeFileSync(path.join(stateHome, 'build.lock/pid'), '999999999');
  await withBuildLock(ctx, async () => order.push('evicted'), { pollMs: 10 });
  assert.equal(order.at(-1), 'evicted');
});

// Dogfood C5: an image publish raced a test build over the checkout's one obj folder and the stack did not build; the
// agent blamed the toolchain although main built.
test('the image build has its own build output, is retried once from a clean build folder, then says whether the base builds', async () => {
  const { ctx } = await makeContext(GENERATED, { files: FILES, git: true, respond: images(), env: { TESTSTACK_STATE_HOME: home() } });
  let fails = 1;
  const commands = fakeShell(ctx, { onRun: (command) => { if (command.includes('build-all') && fails-- > 0) throw Object.assign(new Error('raced'), { flaky: true }); } });
  const shell = ctx.shell;
  ctx.shell = async (...a) => { try { return await shell(...a); } catch { return { status: 1, stdout: '', stderr: '' }; } };
  assert.deepEqual(await build(ctx), { built: true }, 'the second, clean build succeeds');
  assert.equal(commands.filter((c) => c.command.includes('build-all')).length, 2);
  assert.equal(commands[0].env.TESTSTACK_BUILD_ARTIFACTS, path.join(ctx.stateDir, 'artifacts'));
  const { baselineVerdict } = await import('../lib/images.mjs');
  const ok = await baselineVerdict(ctx, { base: 'HEAD', run: async (c, template, vars) => assert.equal(vars.baseline, true) });
  assert.match(ok, /^Baseline: the same build succeeds on the base commit [0-9a-f]{7}, so this change breaks the build/);
  const broken = await baselineVerdict(ctx, { base: 'HEAD', run: async () => { throw new Error('stack.build.all failed (1): tool'); } });
  assert.match(broken, /^Baseline: the same build also fails on the base commit [0-9a-f]{7} \(stack.build.all failed \(1\): tool\): the build environment or the base is broken, not this change/);
});

// Dogfood C6: removing the baseline checkout threw EACCES on a read-only folder and the verdict was lost.
test('removeTree removes a folder with read-only folders inside and never throws', async () => {
  const { removeTree } = await import('../lib/images.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtree-'));
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a/b/f.json'), '{}');
  fs.chmodSync(path.join(dir, 'a/b'), 0o555);
  fs.chmodSync(path.join(dir, 'a'), 0o555);
  assert.equal(removeTree(dir), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(removeTree(path.join(dir, 'missing')), true);
});
