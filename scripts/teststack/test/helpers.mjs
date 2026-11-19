// Test helpers: a throwaway app repository with a .factory/config.json, and a fake compose runner that
// records every command instead of running Docker.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../lib/context.mjs';

export function makeRepo(config = {}, files = {}, { git = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-test-')));
  const all = { '.factory/config.json': JSON.stringify({ project: { name: 'shop' }, ...config }, null, 2), ...files };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  if (git) {
    const run = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    fs.writeFileSync(path.join(root, '.gitignore'), '.factory/state/\n');
    run('add', '-A');
    run('commit', '-qm', 'init');
  }
  return root;
}

/** `respond(call)` may return { status, stdout, stderr } for a call; anything it leaves out succeeds silently. */
export function fakeRunner(respond = () => null) {
  const calls = [];
  const reply = call => ({ status: 0, stdout: '', stderr: '', ...(respond(call) ?? {}) });
  return {
    calls,
    docker: 'docker',
    prefix: ['compose'],
    compose: async args => { const call = { compose: args }; calls.push(call); return reply(call); },
    exec: async (service, argv, { input, env = {}, user } = {}) => {
      const call = { service, argv, input, env, ...(user ? { user } : {}) };
      calls.push(call);
      return reply(call);
    },
    run: async args => { const call = { docker: args }; calls.push(call); return reply(call); },
  };
}

export async function makeContext(config, { files, respond, http = async () => 200, slot = 0, env = {}, git } = {}) {
  const root = makeRepo(config, files, { git });
  const runner = fakeRunner(respond);
  const ctx = await createContext({ root, slot, env: { PATH: process.env.PATH, ...env }, runner, http });
  ctx.cwd = root;
  return { ctx, runner, root, calls: runner.calls };
}

/** One store's adapter context from a full context. */
export const storeOf = (ctx, name) => ctx.stores.find(store => store.name === name);

export const yamlAvailable = await import('yaml').then(() => true, () => false);
export const needsYaml = yamlAvailable ? {} : { skip: "the 'yaml' npm package is not installed" };

export const SHOP = {
  stack: {
    ports: { web: { base: 18080, env: 'WEB_HOST_PORT' }, api: { base: 18081, env: 'API_HOST_PORT' }, db: { base: 18432, env: 'DB_HOST_PORT' } },
    urls: { web: 'http://localhost:{port:web}', api: 'http://localhost:{port:api}' },
    env: { DB_PASSWORD: 'secret-db', CACHE_PASSWORD: 'secret-cache' },
    services: { web: { inputs: ['web/**'] }, api: { inputs: ['api/', 'shared/**/*.py'] } },
  },
  teststack: {
    stores: {
      db: {
        type: 'postgres', service: 'postgres', passwordEnv: 'DB_PASSWORD', databases: ['appdb', 'authdb'],
        preserveTables: ['schema_migrations'], migrationsReady: { table: 'schema_migrations', column: 'version' },
        sequences: [{ database: 'appdb', sequence: 'sales.orderseq', table: 'sales.orders', column: 'Id' }],
      },
      cache: { type: 'redis', service: 'redis', passwordEnv: 'CACHE_PASSWORD' },
      bus: { type: 'rabbitmq', service: 'rabbit', queues: ['Orders', 'Mail'] },
    },
    infrastructureServices: ['postgres', 'redis', 'rabbit'],
    services: [
      { name: 'api', url: 'http://localhost:{port:api}/health', databases: ['appdb'], queues: ['Orders'] },
      { name: 'web', url: 'http://localhost:{port:web}/', http2: true },
    ],
  },
};
