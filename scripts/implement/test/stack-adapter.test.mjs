// The implement harness's stack adapter against the real slot registry, in an app repository whose engine
// is installed elsewhere (the factory layout): a lease must carry the repository's URLs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { stackAdapter } from '../lib/stack.mjs';

test('a UI pair leases a slot of the app repository, from the main checkout or a worktree, with its URLs', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-adapter-')));
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, '.factory/stack'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/stack/docker-compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ project: { name: 'adapter-probe' }, stack: { ports: { web: { base: 47080, env: 'WEB_HOST_PORT' } }, urls: { web: 'http://localhost:{port:web}' }, baseUrl: 'web' } }));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'stack');
  const worktree = path.join(root, '..', `${path.basename(root)}-wt`);
  git(root, 'worktree', 'add', '-q', worktree, 'HEAD');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-home-'));
  const saved = process.env.TESTSTACK_STATE_HOME;
  process.env.TESTSTACK_STATE_HOME = home;
  try {
    for (const dir of [root, worktree]) {
      const adapter = stackAdapter(loadConfig('implement', dir), { log: () => {} });
      const lease = await adapter.lease('test:pair');
      assert.equal(lease.ok, true, JSON.stringify(lease));
      assert.equal(lease.baseUrl, `http://localhost:${47080 + 1000 * lease.slot}`);
      assert.equal(await adapter.release(lease.slot), true);
    }
  } finally {
    if (saved === undefined) delete process.env.TESTSTACK_STATE_HOME;
    else process.env.TESTSTACK_STATE_HOME = saved;
  }
});
