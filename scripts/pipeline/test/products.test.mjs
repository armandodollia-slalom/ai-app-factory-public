// The product defaults (scripts/pipeline/lib/products.mjs) are the same for the host layer
// (hostSettings), the tracker layer (trackerType) and the generator (factory/lib/hosting.mjs products):
// host from config or the origin, tracker from config, the legacy GitHub keys or the host, CI from the host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostSettings } from '../lib/hosts/index.mjs';
import { resolveProducts, trackerTypeFor } from '../lib/products.mjs';
import { trackerType } from '../../board/lib/trackers/index.mjs';
import { products } from '../../factory/lib/hosting.mjs';

const CASES = [
  // [what, config, remote, host, tracker (null: must be set), ci]
  ['GitHub origin, no keys (today)', {}, 'git@github.com:acme/shop.git', 'github', 'github', 'github-actions'],
  ['no origin, legacy board keys', { tickets: { repo: 'acme/shop' }, board: { owner: 'acme', repo: 'acme/shop' } }, '', 'github', 'github', 'github-actions'],
  ['GitLab origin, no keys: GitLab issues', {}, 'https://gitlab.com/g/shop.git', 'gitlab', 'gitlab', 'gitlab-ci'],
  ['Bitbucket origin, no keys: the board must be named', {}, 'git@bitbucket.org:ws/shop.git', 'bitbucket', null, 'bitbucket-pipelines'],
  ['Jira, Bitbucket and Jenkins', { tracker: { type: 'jira' }, ci: { provider: 'jenkins' } }, 'https://bitbucket.org/ws/shop', 'bitbucket', 'jira', 'jenkins'],
  ['Linear, GitHub and CircleCI', { tracker: { type: 'linear' }, ci: { provider: 'circleci' } }, 'git@github.com:acme/shop.git', 'github', 'linear', 'circleci'],
  ['GitLab origin, legacy GitHub board keys', { board: { owner: 'acme', repo: 'acme/shop', projectNumber: 3 } }, 'https://gitlab.com/g/shop.git', 'gitlab', 'github', 'gitlab-ci'],
  ['GitLab host with Jira', { host: { type: 'gitlab' }, tracker: { type: 'jira' } }, 'https://gitlab.com/g/shop.git', 'gitlab', 'jira', 'gitlab-ci'],
  ['Azure DevOps origin, no keys', {}, 'https://dev.azure.com/o/P/_git/r', 'azure-devops', 'azure-boards', 'azure-pipelines'],
  ['Azure DevOps host with Jira: CI follows the host', { host: { type: 'azure-devops' }, tracker: { type: 'jira' } }, '', 'azure-devops', 'jira', 'azure-pipelines'],
  ['GitHub with Azure Boards and Azure Pipelines', { tracker: { type: 'azure-boards' }, ci: { provider: 'azure-pipelines' } }, 'https://github.com/a/b', 'github', 'azure-boards', 'azure-pipelines'],
  ['self-hosted GitLab named in config', { host: { type: 'gitlab', url: 'https://code.acme.io/gitlab' }, tracker: { type: 'github' } }, 'https://code.acme.io/gitlab/team/app.git', 'gitlab', 'github', 'gitlab-ci'],
];

test('host, tracker and CI defaults agree across the host layer, the tracker layer and the generator', () => {
  for (const [what, config, remote, host, tracker, ci] of CASES) {
    const r = resolveProducts(config, { remote });
    assert.deepEqual([r.host.type, r.tracker.type, r.ci.provider], [host, tracker, ci], `${what}: resolveProducts`);
    assert.equal(hostSettings(config, { remote }).type, host, `${what}: hostSettings`);
    const g = products('/nonexistent', { config, remote });
    assert.deepEqual([g.host.type, g.tracker.type, g.ci.provider], [host, tracker, ci], `${what}: factory products`);
    if (tracker) assert.equal(trackerTypeFor(config, { remote }), tracker, `${what}: trackerTypeFor`);
    else assert.throws(() => trackerTypeFor(config, { remote }), /has no ticket tracker of its own the factory uses: set tracker\.type/, `${what}: a clear error`);
  }
});

test('trackerFor detects the host from the checkout origin: GitLab issues for GitLab, a clear error for Bitbucket without a tracker', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'products-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:g/shop.git'], { cwd: root });
    assert.equal(trackerType({ root }), 'gitlab');
    spawnSync('git', ['remote', 'set-url', 'origin', 'git@bitbucket.org:ws/shop.git'], { cwd: root });
    const { resetProducts } = await import('../lib/products.mjs');
    resetProducts?.();
    assert.throws(() => trackerType({ root }), (e) => e.name === 'TrackerError' && e.code === 'config' && /code host is bitbucket/.test(e.message));
    assert.equal(trackerType({ root, tracker: { type: 'jira' } }), 'jira');
    assert.throws(() => trackerType({ root, tracker: { type: 'trello' } }), /tracker.type is "trello"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
