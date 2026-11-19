// Slot math, leases and the file-to-service mapping, on a throwaway app repository: nothing here knows a
// real codebase's ports or services.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  expandPorts, globToRegExp, lease, listLeases, loadConfig, matchesInput, parseSlot, poolSize, release, renew, serviceInputs,
  servicesFor, shellEnv, slotAnnotation, slotInfo, slotPortEnv, slotPorts, staleReason, stateHome, tryLease,
} from '../lib/index.mjs';

const CLI = fileURLToPath(new URL('../slots.mjs', import.meta.url));
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-slots-'));

const STACK = {
  ports: {
    web: { base: 18080, env: 'WEB_HOST_PORT' },
    auth: { base: 18081, env: 'AUTH_HOST_PORT' },
    db: { base: 18432, env: 'DB_HOST_PORT' },
    metrics: { base: 18900 },
  },
  urls: { web: 'http://localhost:{port:web}', auth: 'http://host.docker.internal:{port:auth}/realms/shop' },
  services: {
    web: { inputs: ['web/**', 'shared/ui/'] },
    api: { inputs: ['services/api/', 'shared/**/*.proto', 'go.work'] },
    worker: ['services/worker/**'],
  },
  rebuildAll: ['go.work.sum', 'docker/'],
};

function makeRepo(stack = STACK, project = { name: 'Web Shop' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-repo-')));
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ project, stack }));
  return root;
}

const root = makeRepo();
const config = loadConfig(root);

test('engine defaults know no codebase: no ports, URLs, services or build commands', () => {
  const bare = loadConfig(makeRepo({}, { name: 'bare' }));
  assert.deepEqual([bare.ports, bare.urls, bare.services, bare.rebuildAll, bare.build.all, bare.publish], [{}, {}, {}, [], null, null]);
  assert.deepEqual({ ...slotInfo(1, bare) }, {
    slot: 1, project: 'bare-teststack-1', stateDir: '.factory/state/teststack/slot-1', envFile: '.factory/state/teststack/slot-1/.env',
    composeFile: '.factory/stack/docker-compose.yaml', imageTag: 'bare-teststack-1', baseUrl: null, urls: {}, ports: {},
  });
});

test('names derive from the project: compose project, image tag and the machine-wide state home', () => {
  assert.equal(config.project.name, 'web-shop');
  assert.equal(config.composeProject, 'web-shop-teststack');
  assert.equal(config.imageTag, 'web-shop-teststack');
  assert.equal(stateHome(config, {}), path.join(os.homedir(), '.ai-app-factory', 'teststack', 'web-shop'));
  assert.equal(stateHome(config, { TESTSTACK_STATE_HOME: '/somewhere' }), '/somewhere');
  const named = loadConfig(makeRepo({ ...STACK, composeProject: 'shop-ts', imageTag: 'ts' }));
  assert.deepEqual([slotInfo(0, named).project, slotInfo(2, named).project, slotInfo(0, named).imageTag, slotInfo(2, named).imageTag], ['shop-ts', 'shop-ts-2', 'ts', 'ts-2']);
});

test('slot 0 keeps the base ports and paths; slot n adds slotStride*n everywhere', () => {
  assert.deepEqual(slotPorts(0, config), { web: 18080, auth: 18081, db: 18432, metrics: 18900 });
  assert.deepEqual(slotPorts(1, config), { web: 19080, auth: 19081, db: 19432, metrics: 19900 });
  assert.equal(slotPorts(8, config).web, 26080);
  assert.deepEqual(slotPortEnv(2, config), { WEB_HOST_PORT: '20080', AUTH_HOST_PORT: '20081', DB_HOST_PORT: '20432' });

  assert.deepEqual(slotInfo(0, config), {
    slot: 0, project: 'web-shop-teststack', stateDir: '.factory/state/teststack', envFile: '.factory/state/teststack/.env',
    composeFile: '.factory/stack/docker-compose.yaml', imageTag: 'web-shop-teststack', baseUrl: 'http://localhost:18080',
    urls: { web: 'http://localhost:18080', auth: 'http://host.docker.internal:18081/realms/shop' }, ports: slotPorts(0, config),
  });
  const three = slotInfo('3', config);
  assert.equal(three.project, 'web-shop-teststack-3');
  assert.equal(three.envFile, '.factory/state/teststack/slot-3/.env');
  assert.equal(three.imageTag, 'web-shop-teststack-3');
  assert.equal(three.baseUrl, 'http://localhost:21080');
  assert.equal(three.urls.auth, 'http://host.docker.internal:21081/realms/shop');
  // Every JSON result carries the slot, and each named URL also as <name>Url.
  assert.deepEqual(slotAnnotation(three), { slot: 3, project: 'web-shop-teststack-3', baseUrl: 'http://localhost:21080', urls: three.urls, webUrl: three.urls.web, authUrl: three.urls.auth, ports: three.ports });

  const other = loadConfig(makeRepo({ ...STACK, baseUrl: 'auth', slotStride: 100 }));
  assert.equal(slotInfo(2, other).baseUrl, 'http://host.docker.internal:18281/realms/shop');
  assert.throws(() => slotInfo(0, loadConfig(makeRepo({ ...STACK, baseUrl: 'nope' }))), /stack.baseUrl names 'nope'/);
  assert.throws(() => expandPorts('http://localhost:{port:nope}', { web: 1 }), /unknown port 'nope'.*stack.ports has: web/);
  assert.throws(() => loadConfig(makeRepo({ ports: { web: { base: '18080' } } })), /stack.ports.web.base must be an integer/);
});

test('slots outside 0..maxSlot and non-integers are rejected', () => {
  for (const bad of [9, -1, '1.5', 'x', '', undefined]) assert.throws(() => parseSlot(bad, config), /slot/);
  assert.equal(parseSlot(' 8 ', config), 8);
});

test('no two slots share a host port', () => {
  const seen = new Map();
  for (let slot = 0; slot <= config.maxSlot; slot++) {
    for (const [name, port] of Object.entries(slotPorts(slot, config))) {
      assert.ok(!seen.has(port), `port ${port} of slot ${slot} ${name} collides with ${seen.get(port)}`);
      seen.set(port, `slot ${slot} ${name}`);
    }
  }
});

test('shell-env lines carry the slot paths, image tag, annotation and every port variable', () => {
  const env = Object.fromEntries(shellEnv(1, config).split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(env.PROJECT, 'web-shop-teststack-1');
  assert.equal(env.IMAGE_TAG, 'web-shop-teststack-1');
  assert.equal(env.ENV_FILE, '.factory/state/teststack/slot-1/.env');
  assert.equal(env.BASE_URL, 'http://localhost:19080');
  assert.equal(env.PORT_WEB_HOST_PORT, '19080');
  assert.equal(Object.keys(env).filter(k => k.startsWith('PORT_')).length, 3);
  const annotation = JSON.parse(`{${env.SLOT_JSON}}`);
  assert.equal(annotation.slot, 1);
  assert.equal(annotation.webUrl, 'http://localhost:19080');
  assert.equal(annotation.ports.db, 19432);
});

test('inputs are folders, globs or exact paths', () => {
  assert.equal(matchesInput('services/api/main.go', 'services/api/'), true);
  assert.equal(matchesInput('services/api2/main.go', 'services/api/'), false);
  assert.equal(matchesInput('web/src/app/page.tsx', 'web/**'), true);
  assert.equal(matchesInput('web', 'web/**'), false);
  assert.equal(matchesInput('shared/a/b/c.proto', 'shared/**/*.proto'), true);
  assert.equal(matchesInput('shared/c.proto', 'shared/**/*.proto'), true);
  assert.equal(matchesInput('shared/c.proto.bak', 'shared/**/*.proto'), false);
  assert.equal(matchesInput('src/a/pom.xml', 'src/*/pom.xml'), true);
  assert.equal(matchesInput('src/a/b/pom.xml', 'src/*/pom.xml'), false);
  assert.equal(matchesInput('Cargo.lock', 'Cargo.lock'), true);
  assert.equal(matchesInput('sub/Cargo.lock', 'Cargo.lock'), false);
  assert.equal(matchesInput('a/file1.txt', 'a/file?.txt'), true);
  assert.equal(matchesInput('a+b/(x).ts', 'a+b/(x).ts'), true);
  assert.equal(globToRegExp('**/*.rs').test('main.rs'), true);
});

test('services-for maps changed files to services through the input globs in config (no pack, any language)', async () => {
  const pick = async files => (await servicesFor(files, { config })).services;
  assert.deepEqual(await serviceInputs({ config }), { web: ['web/**', 'shared/ui/'], api: ['services/api/', 'shared/**/*.proto', 'go.work'], worker: ['services/worker/**'] });
  assert.deepEqual(await pick(['web/src/App.tsx']), ['web']);
  assert.deepEqual(await pick(['shared/ui/Button.tsx']), ['web']);
  assert.deepEqual(await pick(['shared/contracts/orders.proto']), ['api']);
  assert.deepEqual(await pick(['services/worker/src/main.rs', 'services/api/handler.go']), ['api', 'worker'], 'config order');
  assert.deepEqual(await pick(['go.work']), ['api']);
  assert.deepEqual(await pick(['README.md', 'docs/x.md', 'services/other/main.go']), []);
  assert.deepEqual(await pick(['./services\\api\\main.go', 'services/api/main.go']), ['api']);
  const reasons = await servicesFor(['web/a.ts', 'web/b.ts', 'services/api/x.go'], { config });
  assert.deepEqual(reasons, { services: ['web', 'api'], all: false, reasons: { web: ['web/a.ts', 'web/b.ts'], api: ['services/api/x.go'] } });
  // Global build inputs and the compose file select every service.
  for (const global of ['go.work.sum', 'docker/base.Dockerfile', '.factory/stack/docker-compose.yaml']) {
    const result = await servicesFor([global, 'web/a.ts'], { config });
    assert.deepEqual([result.services, result.all, result.reasons.worker], [['web', 'api', 'worker'], true, [global]], global);
  }
});

test('a resolver module adds computed inputs to the configured ones', async () => {
  const withResolver = makeRepo({ ...STACK, resolver: './tools/resolver.mjs', services: { api: { inputs: ['services/api/'], module: 'libs/core' }, web: { inputs: ['web/**'] } } });
  fs.mkdirSync(path.join(withResolver, 'tools'));
  fs.writeFileSync(path.join(withResolver, 'tools/resolver.mjs'), "export const serviceInputs = (service, { name, root }) => (service.module ? [`${service.module}/`, `generated/${name}/**`] : []);\n");
  const resolved = loadConfig(withResolver);
  assert.deepEqual(await serviceInputs({ config: resolved }), { api: ['services/api/', 'libs/core/', 'generated/api/**'], web: ['web/**'] });
  assert.deepEqual((await servicesFor(['libs/core/x.go'], { config: resolved })).services, ['api']);
  await assert.rejects(serviceInputs({ config: loadConfig(makeRepo({ ...STACK, resolver: './nope.mjs' })) }), /stack.resolver '.\/nope.mjs' could not be loaded/);
});

test('poolSize comes from config and TESTSTACK_SLOTS, capped at maxSlot', () => {
  assert.equal(poolSize(config, {}), 2);
  assert.equal(poolSize(loadConfig(makeRepo({ poolSize: 5 })), {}), 5);
  assert.equal(poolSize(config, { TESTSTACK_SLOTS: '4' }), 4);
  assert.equal(poolSize(config, { TESTSTACK_SLOTS: '50' }), config.maxSlot);
  assert.throws(() => poolSize(config, { TESTSTACK_SLOTS: 'two' }), /TESTSTACK_SLOTS/);
});

// Council C3, D-C6-1: every run sized TESTSTACK_SLOTS to its own parallelism (1), so two runs shared one slot.
test('stack.poolSize is machine-wide: Docker memory may lower it (TESTSTACK_SLOTS_MAX), TESTSTACK_SLOTS overrides it', () => {
  const five = loadConfig(makeRepo({ poolSize: 5 }));
  assert.equal(poolSize(five, { TESTSTACK_SLOTS_MAX: '3' }), 3, 'Docker holds only 3');
  assert.equal(poolSize(five, { TESTSTACK_SLOTS_MAX: '9' }), 5, 'the setting is the pool size');
  assert.equal(poolSize(five, { TESTSTACK_SLOTS_MAX: '3', TESTSTACK_SLOTS: '1' }), 1, 'an explicit size wins');
});

test('leases hand out slots 1..pool once each, then null; release frees a slot', async () => {
  const home = tmpHome();
  const opts = { home, pool: 2, config };
  const a = await tryLease('a', opts);
  const b = await tryLease('b', opts);
  assert.deepEqual([a.slot, b.slot], [1, 2]);
  assert.equal(a.baseUrl, 'http://localhost:19080');
  assert.equal(await tryLease('c', opts), null);
  await assert.rejects(release(1, { home, config, owner: 'b' }), /leased by 'a'/);
  assert.equal((await release(1, { home, config, owner: 'a' })).owner, 'a');
  assert.equal((await tryLease('c', opts)).slot, 1);
  const listed = listLeases(opts);
  assert.deepEqual(listed.map(s => [s.slot, s.free, s.lease?.owner]), [[1, false, 'c'], [2, false, 'b']]);
  assert.equal(await release(2, { home, config, owner: 'nobody', force: true }).then(l => l.owner), 'b');
  assert.equal(await release(2, { home, config }), null);
});

test('concurrent leases never share a slot (in-process and across processes)', async () => {
  const home = tmpHome();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => tryLease(`p${i}`, { home, pool: 3, config })));
  const slots = results.filter(Boolean).map(r => r.slot).sort();
  assert.deepEqual(slots, [1, 2, 3]);

  const home2 = tmpHome();
  const runs = Array.from({ length: 8 }, (_, i) => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'lease', '--owner', `proc${i}`, '--pid', String(process.pid)], {
      env: { ...process.env, TESTSTACK_ROOT: root, TESTSTACK_STATE_HOME: home2, TESTSTACK_SLOTS: '3', TESTSTACK_DOCKER: 'false' },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, result: JSON.parse(out) }));
  }));
  const done = await Promise.all(runs);
  const won = done.filter(r => r.result.ok).map(r => r.result.slot).sort();
  assert.deepEqual(won, [1, 2, 3]);
  assert.ok(done.filter(r => !r.result.ok).every(r => r.code === 2));
});

test('stale leases (owner gone or past the TTL) are recovered; fresh or unwritten ones are not', async () => {
  const home = tmpHome();
  const dir = path.join(home, 'leases');
  fs.mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  fs.writeFileSync(path.join(dir, 'slot-1.json'), JSON.stringify({ slot: 1, owner: 'ghost', pid: deadPid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, 'slot-2.json'), JSON.stringify({ slot: 2, owner: 'live', pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
  const listed = listLeases({ home, pool: 2, config });
  assert.match(listed[0].stale, /is gone/);
  assert.equal(listed[1].stale, null);
  const claimed = await tryLease('new', { home, pool: 2, config });
  assert.equal(claimed.slot, 1);
  assert.match(claimed.recovered, /is gone/);
  assert.equal(await tryLease('another', { home, pool: 2, config }), null);

  // Past the TTL even though the owner is alive.
  const later = Date.now() + 5 * 60_000;
  const viaTtl = await tryLease('ttl', { home, pool: 2, config, ttlMs: 60_000, now: () => later });
  assert.ok(viaTtl);
  assert.match(viaTtl.recovered, /older than 1 min/);

  // A lease file being written right now (unparseable, young) is respected; an old one is not.
  assert.equal(staleReason({ unreadable: true, ageMs: 1000 }, { ttlMs: 1e9 }), null);
  assert.match(staleReason({ unreadable: true, ageMs: 60_000 }, { ttlMs: 1e9 }), /unreadable/);
  // Leases from another host are only aged out by the TTL.
  assert.equal(staleReason({ pid: deadPid, hostname: 'elsewhere', createdAt: new Date().toISOString() }, { ttlMs: 1e9 }), null);
});

test('renew refreshes the TTL clock; lease waits for a slot to be released', async () => {
  const home = tmpHome();
  const first = await tryLease('holder', { home, pool: 1, config });
  const t0 = Date.now();
  const renewed = await renew(first.slot, { home, config, owner: 'holder', now: () => t0 + 50 * 60_000 });
  assert.equal(staleReason(renewed, { now: t0 + 90 * 60_000, ttlMs: 60 * 60_000 }), null);
  await assert.rejects(renew(1, { home, config, owner: 'other' }), /leased by 'holder'/);

  setTimeout(() => { release(1, { home, config }); }, 150);
  const started = Date.now();
  const waited = await lease('waiter', { home, pool: 1, config, waitSec: 5, pollMs: 50 });
  assert.equal(waited.slot, 1);
  assert.ok(Date.now() - started >= 100);
  assert.equal(await lease('impatient', { home, pool: 1, config, waitSec: 0 }), null);
});

test('the CLI prints one JSON line for lease, list and release', () => {
  const home = tmpHome();
  const env = { ...process.env, TESTSTACK_ROOT: root, TESTSTACK_STATE_HOME: home, TESTSTACK_SLOTS: '1', TESTSTACK_DOCKER: 'false' };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  const ok = run('lease', '--owner', 'cli', '--pid', String(process.pid));
  assert.equal(ok.status, 0, ok.stderr);
  const leased = JSON.parse(ok.stdout);
  assert.equal(leased.slot, 1);
  assert.equal(leased.baseUrl, 'http://localhost:19080');
  assert.equal(leased.webUrl, 'http://localhost:19080');
  assert.equal(leased.project, 'web-shop-teststack-1');
  assert.equal(leased.ports.auth, 19081);
  const full = run('lease', '--owner', 'cli2');
  assert.equal(full.status, 2);
  assert.equal(JSON.parse(full.stdout).ok, false);
  assert.equal(JSON.parse(run('list').stdout).slots[0].lease.owner, 'cli');
  assert.equal(JSON.parse(run('release', '--slot', '1').stdout).released, true);
  const bad = run('info', '--slot', '12');
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.equal(run('nope').status, 64);
  assert.deepEqual(JSON.parse(run('services-for', 'web/a.ts', 'README.md').stdout), { ok: true, command: 'services-for', services: ['web'], all: false, reasons: { web: ['web/a.ts'] } });
  assert.equal(run('services-for', '--plain', 'services/api/a.go', 'web/a.ts').stdout, 'web\napi\n');
  assert.equal(JSON.parse(run('info', '--slot', '2', '--root', makeRepo({ ports: { app: { base: 3000 } }, urls: { app: 'http://localhost:{port:app}' } }, { name: 'other' })).stdout).appUrl, 'http://localhost:5000');
  assert.equal(JSON.parse(run('list').stdout).stateHome, home);
});
