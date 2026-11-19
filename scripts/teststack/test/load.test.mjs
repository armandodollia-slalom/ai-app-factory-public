// load, reset, readiness and the CLI contract, with a fake compose runner: the order of operations on the
// stack, which services are restarted, and what is printed. No Docker involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../lib/common.mjs';
import { load, validate } from '../lib/load.mjs';
import { check, publicCheck, wait } from '../lib/readiness.mjs';
import { SHOP, makeContext, makeRepo } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../teststack.mjs', import.meta.url));

const SCENARIOS = {
  '.factory/stack/scenarios/_base/scenario.json': JSON.stringify({ db: { appdb: [{ table: 'Countries', rows: [{ Id: 1 }] }] } }),
  '.factory/stack/scenarios/default/scenario.json': JSON.stringify({ db: { appdb: [{ table: 'sales.orders', rows: [{ Id: 7 }] }], authdb: [{ table: 'Users', rows: [{ Id: 'u1' }] }] }, cache: [{ key: 'k', value: 'v' }] }),
};

const QUEUES = JSON.stringify([{ name: 'Orders', messages_ready: 2, consumers: 1 }, { name: 'Mail', messages_ready: 0, consumers: 1 }]);
const PS = ['postgres', 'redis', 'rabbit', 'api', 'web'].map(Service => JSON.stringify({ Service, State: 'running', ExitCode: 0 })).join('\n');

// A healthy stack. `overrides(call)` may answer a call differently.
const healthy = (overrides = () => null) => call => {
  const answer = overrides(call);
  if (answer) return answer;
  if (call.compose?.[0] === 'ps') return { stdout: PS };
  if (call.argv?.includes('list_queues')) return { stdout: QUEUES };
  if (call.argv?.at(-1) === 'PING') return { stdout: 'PONG\n' };
  if (call.argv?.at(-1) === 'FLUSHALL') return { stdout: 'OK\n' };
  if (call.argv?.at(-1) === '--pipe') return { stdout: `errors: 0, replies: ${call.input.split('*3\r\n').length - 1}\n` };
  if (call.input?.startsWith('SELECT "version"')) return { stdout: '001\n' };
  return null;
};

// One word per call, to assert the order of operations.
function describe(call) {
  if (call.compose) return call.compose[0] === 'ps' ? 'compose ps' : `compose ${call.compose.join(' ')}`;
  const input = call.input ?? '';
  if (call.argv[0] === 'psql') {
    if (input.includes('TRUNCATE TABLE') && input.includes('CREATE DATABASE')) return 'pg:snapshot';
    if (input.includes('CREATE DATABASE')) return 'pg:copy';
    if (input.includes('DROP DATABASE')) return 'pg:drop';
    if (input.includes('TRUNCATE TABLE')) return 'pg:clear';
    if (input.includes('json_populate_recordset')) return 'pg:load';
    if (input.includes('setval')) return 'pg:fixups';
    if (input.includes('is_called')) return 'pg:used-sequences';
    if (input.startsWith('SELECT "version"')) return 'pg:migrations';
    return 'pg:ping';
  }
  if (call.argv[0] === 'redis-cli') return `redis:${call.argv.at(-1)}`;
  return `rabbit:${call.argv.find(arg => ['list_queues', 'purge_queue'].includes(arg))}`;
}

// The calls of a load, without the readiness passes around it.
const READINESS = ['compose ps', 'pg:ping', 'redis:PING', 'pg:migrations'];
const operations = calls => calls.map(describe).filter(word => !READINESS.includes(word));

test('readiness: containers, stores, then per service its HTTP probe, migrations and queues', async () => {
  const seen = [];
  const { ctx } = await makeContext(SHOP, { respond: healthy(), http: async (url, options) => { seen.push([url, options]); return url.includes(':18081') ? 404 : 200; } });
  const checks = await check(ctx);
  assert.deepEqual(checks.map(publicCheck), [
    { name: 'container:postgres', ok: true, detail: 'running' },
    { name: 'container:redis', ok: true, detail: 'running' },
    { name: 'container:rabbit', ok: true, detail: 'running' },
    { name: 'container:api', ok: true, detail: 'running' },
    { name: 'container:web', ok: true, detail: 'running' },
    { name: 'db', ok: true, detail: 'accepting connections' },
    { name: 'cache', ok: true, detail: 'PONG' },
    { name: 'bus', ok: true, detail: 'accepting connections' },
    { name: 'migrations:authdb', ok: true, detail: '1 applied (latest 001)' },
    { name: 'http:api', ok: true, detail: 'HTTP 404' },
    { name: 'migrations:appdb', ok: true, detail: '1 applied (latest 001)' },
    { name: 'queue:Orders', ok: true, detail: '1 consumer(s), 2 message(s)' },
    { name: 'http:web', ok: true, detail: 'HTTP 200' },
  ]);
  assert.deepEqual(seen.sort(), [['http://localhost:18080/', { http2: true }], ['http://localhost:18081/health', { http2: false }]]);
});

test('readiness on a slot probes the slot ports; failures say why', async () => {
  const respond = healthy(call => {
    if (call.compose?.[0] === 'ps') return { stdout: `[${JSON.stringify({ Service: 'postgres', State: 'running' })},${JSON.stringify({ Service: 'api', State: 'exited', ExitCode: 139 })}]` };
    if (call.argv?.includes('list_queues')) return { status: 69, stderr: 'Error: unable to perform an operation on node' };
    return null;
  });
  const { ctx } = await makeContext(SHOP, { slot: 2, respond, http: async url => { if (url.includes(':20080')) throw new Error('connect ECONNREFUSED 127.0.0.1:20080'); return 503; } });
  const byName = Object.fromEntries((await check(ctx)).map(c => [c.name, c]));
  assert.equal(byName['container:redis'].detail, "not created; run 'factory teststack up'");
  assert.equal(byName['container:api'].detail, 'exited (exit 139)');
  assert.deepEqual(publicCheck(byName.bus), { name: 'bus', ok: false, detail: 'list_queues failed: Error: unable to perform an operation on node' });
  assert.deepEqual(publicCheck(byName['queue:Orders']), { name: 'queue:Orders', ok: false, detail: 'bus unavailable' });
  assert.deepEqual(publicCheck(byName['http:api']), { name: 'http:api', ok: false, detail: 'HTTP 503' });
  assert.deepEqual(publicCheck(byName['http:web']), { name: 'http:web', ok: false, detail: 'connect ECONNREFUSED 127.0.0.1:20080' });

  const broken = await makeContext(SHOP, { respond: () => ({ status: 1, stderr: 'no configuration file provided: not found' }) });
  assert.deepEqual((await check(broken.ctx)).map(publicCheck), [{ name: 'compose', ok: false, detail: "'docker compose ps' failed (1): no configuration file provided: not found" }]);
});

test('wait restarts a running service once when it stays unready while the stores are healthy, and times out with exit 2 detail', async () => {
  let clock = 0;
  const now = () => clock;
  const { ctx, calls } = await makeContext(SHOP, { files: SCENARIOS, respond: healthy(), http: async url => { clock += 20_000; return url.includes(':18081') ? 500 : 200; } });
  const result = await wait(ctx, 200, { pollMs: 0, now });
  assert.equal(result.ready, false);
  assert.deepEqual(result.healed, ['api']);
  assert.deepEqual(result.checks.filter(c => !c.ok).map(publicCheck), [{ name: 'http:api', ok: false, detail: 'HTTP 500' }]);
  assert.deepEqual(calls.filter(call => call.compose?.[0] === 'restart').map(call => call.compose), [['restart', 'api']]);

  await assert.rejects(load(ctx, null, { timeoutSec: 0, waitOptions: { pollMs: 0 } }), error => {
    assert.equal(error.exitCode, EXIT.notReady);
    assert.match(error.message, /^Stack not ready before reset after 0s: http:api: HTTP 500$/);
    assert.deepEqual(error.extra.failing, [{ name: 'http:api', ok: false, detail: 'HTTP 500' }]);
    return true;
  });
});

test('soft load: wait, purge queues, clear the stores, purge again, load the layers, fix sequences', async () => {
  const { ctx, calls } = await makeContext(SHOP, { files: SCENARIOS, respond: healthy() });
  const result = await load(ctx, 'default', { timeoutSec: 5 });
  assert.equal(calls.filter(call => call.compose?.[0] === 'ps').length, 1, 'one readiness pass before the reset');
  calls.splice(0, calls.findIndex(call => describe(call) === 'rabbit:list_queues') + 1);
  assert.deepEqual({ ...result, elapsedMs: 0 }, { ok: true, command: 'load', scenario: 'default', layers: ['_base', 'default'], mode: 'soft', purgedMessages: 4, restarted: [], elapsedMs: 0 });
  assert.deepEqual(operations(calls), [
    'rabbit:list_queues', 'rabbit:purge_queue', 'pg:clear', 'redis:FLUSHALL', 'rabbit:list_queues', 'rabbit:purge_queue',
    'pg:load', 'pg:fixups', 'redis:--pipe',
  ]);
  assert.equal(calls.filter(call => call.compose && call.compose[0] !== 'ps').length, 0, 'nothing is restarted');
  const loaded = calls.find(call => describe(call) === 'pg:load').input;
  assert.ok(loaded.indexOf('"Countries"') < loaded.indexOf('"sales"."orders"'), 'the base layer is applied first');
  assert.ok(loaded.indexOf("\\connect 'appdb'") < loaded.indexOf("\\connect 'authdb'"));
});

test('reset loads only the base layer; --no-wait skips the readiness pass', async () => {
  const { ctx, calls } = await makeContext(SHOP, { files: SCENARIOS, respond: healthy() });
  const result = await load(ctx, null, { noWait: true, timeoutSec: 5 });
  assert.deepEqual([result.command, result.scenario, result.layers], ['reset', '_base', ['_base']]);
  assert.equal(calls.some(call => call.compose?.[0] === 'ps'), false);
  assert.deepEqual(calls.map(describe).filter(word => word.startsWith('redis')), ['redis:FLUSHALL']);
});

test('restartAfterLoad: a service is stopped before the stores are cleared and started after the load', async () => {
  const config = structuredClone(SHOP);
  config.teststack.restartAfterLoad = [{ service: 'api', when: 'sequencesUsed' }, 'web'];
  const used = await makeContext(config, { files: SCENARIOS, respond: healthy(call => (call.input?.includes('is_called') ? { stdout: 'sales.orderseq\n' } : null)) });
  const result = await load(used.ctx, 'default', { timeoutSec: 5 });
  assert.deepEqual(result.restarted, ['web', 'api']);
  const words = used.calls.map(describe);
  assert.deepEqual(operations(used.calls).slice(1, 4), ['pg:used-sequences', 'compose stop web api', 'rabbit:list_queues']);
  assert.ok(words.indexOf('compose start web api') > words.indexOf('redis:--pipe'));
  assert.ok(words.lastIndexOf('compose ps') > words.indexOf('compose start web api'), 'readiness is awaited after the restart');

  const unused = await makeContext(config, { files: SCENARIOS, respond: healthy() });
  assert.deepEqual((await load(unused.ctx, 'default', { timeoutSec: 5 })).restarted, ['web'], 'unused sequences: only the "always" rule applies');
});

test('hard load: stop the app, restore databases from templates, clear the rest, start, then load', async () => {
  const fingerprints = { appdb: '001\n', appdb__template: '001\n', authdb: '001\n' };
  const respond = healthy(call => {
    if (!call.input?.startsWith('SELECT "version"')) return null;
    const database = call.argv[call.argv.indexOf('-d') + 1];
    return fingerprints[database] ? { stdout: fingerprints[database] } : { status: 2, stderr: 'FATAL:  database does not exist' };
  });
  const { ctx, calls } = await makeContext(SHOP, { files: SCENARIOS, respond });
  const result = await load(ctx, 'default', { hard: true, timeoutSec: 5 });
  assert.deepEqual([result.mode, result.restarted, result.purgedMessages], ['hard', ['api', 'web'], 4]);
  assert.deepEqual(operations(calls), [
    'compose stop api web', 'pg:copy', 'pg:clear', 'pg:copy', 'redis:FLUSHALL', 'rabbit:list_queues', 'rabbit:purge_queue',
    'compose start api web', 'rabbit:list_queues', 'rabbit:list_queues', 'rabbit:purge_queue', 'pg:load', 'pg:fixups', 'redis:--pipe',
  ]);
});

test('validate resolves every scenario without touching the stack', async () => {
  const { ctx, calls } = await makeContext(SHOP, { files: SCENARIOS });
  assert.deepEqual(await validate(ctx, []), { ok: true, command: 'validate', scenarios: [
    { scenario: '_base', layers: ['_base'], stores: { db: 1, cache: 0 } },
    { scenario: 'default', layers: ['_base', 'default'], stores: { db: 3, cache: 1 } },
  ] });
  assert.deepEqual((await validate(ctx, ['default'])).scenarios.map(s => s.scenario), ['default']);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- the CLI

function cli(root, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, TESTSTACK_ROOT: root, TESTSTACK_SLOT: '', ...env } });
  const lines = result.stdout.split('\n').filter(Boolean);
  return { status: result.status, lines, json: lines.length ? JSON.parse(lines.at(-1)) : null, stderr: result.stderr };
}

test('CLI: one JSON line on stdout, logs on stderr, and the exit codes 0, 3 and 64', () => {
  const root = makeRepo(SHOP, { ...SCENARIOS, '.factory/stack/scenarios/bad/scenario.json': '{ "nope": 1 }' });
  const ok = cli(root, ['validate', 'default']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.lines.length, 1);
  assert.deepEqual(ok.json, { ok: true, command: 'validate', scenarios: [{ scenario: 'default', layers: ['_base', 'default'], stores: { db: 3, cache: 1 } }] });
  assert.equal(fs.existsSync(path.join(root, '.factory/state')), false, 'validate writes nothing');

  const invalid = cli(root, ['validate']);
  assert.equal(invalid.status, 3);
  assert.equal(invalid.lines.length, 1);
  assert.equal(invalid.json.ok, false);
  assert.equal(invalid.json.exitCode, 3);
  assert.match(invalid.json.error, /bad\/scenario.json: top level: unknown key 'nope'/);
  assert.match(invalid.stderr, /\[teststack\] error: Invalid scenario/);

  for (const args of [[], ['frobnicate'], ['load'], ['--slot', 'x', 'status'], ['--slot', '99', 'status'], ['wait', '--timeout', 'soon'], ['rebuild-changed']]) {
    const result = cli(root, args);
    assert.equal(result.status, 64, args.join(' '));
    if (args.length) assert.deepEqual([result.lines.length, result.json.ok, result.json.exitCode], [1, false, 64], args.join(' '));
  }
  assert.equal(cli(root, ['help']).status, 0);
});

test('CLI: status against a fake docker prints the checks with the slot annotation and exits 2 when not ready', () => {
  const root = makeRepo(SHOP, SCENARIOS);
  const docker = path.join(root, 'fake-docker');
  fs.writeFileSync(docker, '#!/bin/sh\ncase "$*" in *" ps "*) echo \'{"Service":"postgres","State":"running"}\';; *) echo "unexpected: $*" >&2; exit 1;; esac\n', { mode: 0o755 });
  const status = cli(root, ['--slot', '1', 'status'], { TESTSTACK_DOCKER: docker });
  assert.equal(status.status, 2, status.stderr);
  assert.equal(status.lines.length, 1);
  const { checks, ...rest } = status.json;
  assert.deepEqual(rest, {
    ok: false, command: 'status', slot: 1, project: 'shop-teststack-1', baseUrl: 'http://localhost:19080',
    urls: { web: 'http://localhost:19080', api: 'http://localhost:19081' }, webUrl: 'http://localhost:19080', apiUrl: 'http://localhost:19081',
    ports: { web: 19080, api: 19081, db: 19432 },
  });
  assert.deepEqual(checks[0], { name: 'container:postgres', ok: true, detail: 'running' });
  assert.equal(checks.find(c => c.name === 'db').ok, false);
  // The slot's env file: its host ports and the fixed test values of stack.env.
  assert.equal(fs.readFileSync(path.join(root, '.factory/state/teststack/slot-1/.env'), 'utf8'),
    'DB_PASSWORD=secret-db\nCACHE_PASSWORD=secret-cache\nWEB_HOST_PORT=19080\nAPI_HOST_PORT=19081\nDB_HOST_PORT=19432\n');
});

test('CLI: a repository or pack can register extra commands (teststack.commands)', () => {
  const root = makeRepo({ ...SHOP, teststack: { ...SHOP.teststack, commands: { 'hash-password': 'pack:dotnet/stack/hash-password.mjs', echo: './tools/echo.mjs' } } },
    { 'tools/echo.mjs': 'export default ({ positionals, options }, ctx) => ({ said: positionals, loud: Boolean(options.loud), project: ctx.info.project });\n' });
  const hashed = cli(root, ['hash-password', 'Pass123$']);
  assert.equal(hashed.status, 0, hashed.stderr);
  assert.match(hashed.json.hash, /^AQAAAAIAAYag/);
  assert.equal(cli(root, ['hash-password']).status, 64);
  assert.deepEqual(cli(root, ['echo', 'a', '--loud', 'b']).json, { ok: true, command: 'echo', said: ['a', 'b'], loud: true, project: 'shop-teststack' });
});
