// Tracker, code host and CI system chosen independently: each combination is set up from the interview's answers,
// gets the right adapter of each kind, renders that CI system's files, and judges a pull request's head from the fakes
// (the CI evidence, the host's checks, the review-quorum status where the CI system has no review events, the merge
// guard). GitHub + GitHub + GitHub Actions is the regression baseline (v0.2.68's suites, unchanged, cover it in depth).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { interview } from '../../factory/lib/interview.mjs';
import { products } from '../../factory/lib/hosting.mjs';
import { render, readManifest } from '../../factory/lib/render.mjs';
import { hostFor } from '../lib/hosts/index.mjs';
import { ciFor, ciTarget } from '../lib/ci/index.mjs';
import { headPipelines } from '../lib/ci/evidence.mjs';
import { trackerFor, resetTrackers } from '../../board/lib/trackers/index.mjs';
import { checksState, mergePr } from '../../review-gate/lib/github.mjs';
import { postQuorumStatus } from '../../review-gate/lib/sync.mjs';
import { encodeState } from '../../review-gate/lib/gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.resolve(HERE, '../../..');
const SHA = 'a'.repeat(40);
const workers = [];
after(() => Promise.all(workers.map((w) => w.terminate())));
async function fake(kind, auth) {
  const w = new Worker(path.join(HERE, 'fakes/providers-fake-server.mjs'), { workerData: { kind, auth } });
  workers.push(w);
  const [{ port }] = await once(w, 'message');
  const url = `http://127.0.0.1:${port}`;
  return { url, state: async () => (await fetch(`${url}/__fake/state`)).json(), seed: (s) => fetch(`${url}/__fake/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }) };
}
function checkout(remote, config, pin = { version: '0.0.0', tools: ['claude'], features: { lsp: false, graphify: false, ci: true, agentFiles: false, gitHooks: false, demoVideo: false }, owners: ['@acme'] }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/factory.json'), JSON.stringify(pin));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify(config));
  return root;
}

test('Jira + Bitbucket + Jenkins: set up from the interview, judged from the fakes; Jenkins has no review events, so the gate posts review-quorum', async () => {
  const bb = await fake('bitbucket', 'Bearer bb-good');
  const jk = await fake('jenkins', `Basic ${Buffer.from('ci-user:jk-good').toString('base64')}`);
  Object.assign(process.env, { FACTORY_TEST_BB_TOKEN: 'bb-good', FACTORY_TEST_JK_USER: 'ci-user', FACTORY_TEST_JK: 'jk-good' });
  const { config } = await interview({ answers: { 'host.type': 'bitbucket', 'host.url': bb.url, 'host.repo': 'ws/app', 'host.token': 'FACTORY_TEST_BB_TOKEN', 'tracker.type': 'jira', 'tracker.url': 'https://acme.atlassian.net', 'tracker.project': 'SHOP', 'tracker.token': 'JIRA_API_TOKEN', 'ci.provider': 'jenkins', 'ci.url': jk.url, 'ci.job': 'team/shop', 'ci.user': 'FACTORY_TEST_JK_USER', 'ci.token': 'FACTORY_TEST_JK' } });
  const root = checkout('https://bitbucket.org/ws/app.git', config);
  const full = { ...config, root, board: { repo: 'ws/app' }, implement: { reviewGate: { ci: {} } } };
  const used = products(root);
  assert.deepEqual([used.host.type, used.tracker.type, used.ci.provider], ['bitbucket', 'jira', 'jenkins']);
  assert.deepEqual([hostFor(full).type, trackerFor({ ...full, tracker: { ...full.tracker, auth: { token: 'x' } } }).type, ciFor(full).type], ['bitbucket', 'jira', 'jenkins']);
  render(root, INSTALL);
  assert.ok(Object.keys(readManifest(root).files).includes('ci/jenkins/Jenkinsfile.factory'));
  // The head's evidence: Jenkins' PR-1 build of the head passed; the host still shows a build in progress.
  const t = ciTarget(full, null);
  assert.equal(headPipelines(t, 1, {}).state, 'success');
  assert.equal(checksState(t, null, 1), 'pending', 'a build the host shows in progress keeps the head from green');
  // No review events on Jenkins: the gate posts review-quorum on the head (approvals:1 from the gate notice, met).
  t.host.pr.comment(1, `gate notice ${encodeState({ action: 'review', approvals: 1 })}`, { marker: 'review-gate:' });
  assert.deepEqual(postQuorumStatus(full, null, 1), { pr: 1, state: 'success' });
  const st = await bb.state();
  assert.ok(st.statuses['1'].some((s) => s.name === 'review-quorum' && s.state === 'SUCCESSFUL'));
  // Merge safety on a host without a SHA-bound merge: a moved head is refused.
  assert.throws(() => mergePr(full, null, 1, { method: 'squash' }, { headSha: 'f'.repeat(40) }), /head moved/);
});

test('Azure Boards + Azure Repos + Azure Pipelines: the build validation policy is the expected pipeline, the PR build of the head its run', async () => {
  const az = await fake('azure', `Basic ${Buffer.from(':az-good').toString('base64')}`);
  process.env.FACTORY_TEST_AZ = 'az-good';
  const { config } = await interview({ detected: { host: { type: 'azure-devops', url: az.url, repo: 'o/p/app' } }, answers: { 'host.url': az.url, 'host.token': 'FACTORY_TEST_AZ', 'tracker.token': 'FACTORY_TEST_AZ', 'agents.local': 'claude' } });
  assert.deepEqual([config.host.type, config.tracker.type, config.ci.provider], ['azure-devops', 'azure-boards', 'azure-pipelines'], 'the host\'s own board and CI are the defaults');
  const root = checkout('https://dev.azure.com/o/p/_git/app', config);
  render(root, INSTALL);
  assert.ok(Object.keys(readManifest(root).files).some((f) => f.startsWith('.azure-pipelines/')));
  const ci = ciFor({ ...config, root });
  const host = { repo: 'o/p/app', pr: { get: () => ({ headSha: SHA, base: 'main', head: 'feat/x' }), files: () => [] } };
  const w = headPipelines({ host, ci }, 1, {});
  assert.deepEqual([w.state, w.expected.map((x) => x.name)], ['success', ['app-ci']]);
  assert.equal(ci.capabilities.reviewEvents, false);
});

test('GitLab issues + GitLab + GitLab CI: one pipeline per head, lanes as labels, the tracker drafted from the host', async () => {
  const gl = await fake('gitlab', 'glpat-good');
  process.env.FACTORY_TEST_GL_TOKEN = 'glpat-good';
  resetTrackers();
  const { config } = await interview({ detected: { host: { type: 'gitlab', url: gl.url, repo: 'grp/app' } }, answers: { 'host.url': gl.url, 'host.token': 'FACTORY_TEST_GL_TOKEN', 'tracker.url': gl.url, 'tracker.project': 'grp/app', 'tracker.token': 'FACTORY_TEST_GL_TOKEN', 'tracker.lanes.backlog': '' } });
  assert.deepEqual([config.host.type, config.tracker.type, config.ci.provider], ['gitlab', 'gitlab', 'gitlab-ci']);
  const root = checkout('https://gitlab.com/grp/app.git', config);
  render(root, INSTALL);
  assert.ok(Object.keys(readManifest(root).files).includes('.gitlab/ci/factory.yml'));
  const tracker = trackerFor({ ...config, root });
  assert.equal(tracker.tickets.find('SHOP-1').number, 1);
  tracker.board.move(1, 'inProgress');
  assert.equal(tracker.board.lane(1), 'inProgress');
  const ci = ciFor({ ...config, root });
  const host = { repo: 'grp/app', pr: { get: () => ({ headSha: SHA, base: 'main', head: 'feat/x' }), files: () => [] } };
  assert.equal(headPipelines({ host, ci }, 1, {}).state, 'success');
});

test('Linear + GitHub + CircleCI: tickets in Linear, code on GitHub through gh, workflows of the head from CircleCI', async () => {
  const ln = await fake('linear', 'lin_api_good');
  const cc = await fake('circleci', 'cc-good');
  Object.assign(process.env, { FACTORY_TEST_LINEAR_KEY: 'lin_api_good', FACTORY_TEST_CC: 'cc-good' });
  resetTrackers();
  const { config } = await interview({ detected: { host: { type: 'github', url: 'https://github.com', repo: 'acme/shop' } }, answers: { 'tracker.type': 'linear', 'tracker.url': ln.url, 'tracker.project': 'ENG', 'tracker.token': 'FACTORY_TEST_LINEAR_KEY', 'ci.provider': 'circleci', 'ci.token': 'FACTORY_TEST_CC' } });
  assert.deepEqual([config.host.type, config.tracker.type, config.ci.provider], ['github', 'linear', 'circleci']);
  const root = checkout('git@github.com:acme/shop.git', { ...config, ci: { ...config.ci, url: `${cc.url}/api`, project: 'gh/acme/shop' } });
  render(root, INSTALL);
  assert.ok(Object.keys(readManifest(root).files).includes('.circleci/config.yml'));
  assert.ok(!Object.keys(readManifest(root).files).some((f) => f.startsWith('.github/workflows/')), 'no GitHub Actions workflows with CircleCI as the CI system');
  const tracker = trackerFor({ ...config, root });
  assert.equal(tracker.tickets.get('ENG-1').title, 'Cart total');
  // GitHub through a fake gh; CircleCI's workflows of the head (the fake's build workflow failed).
  const gh = (args) => (args[0] === 'api' && /contents\/\.circleci/.test(args[1]) ? { status: 0, stdout: 'version: 2.1\nworkflows:\n  build:\n    jobs: [test]\n' } : args[0] === 'pr' && args[1] === 'view' ? { status: 0, stdout: JSON.stringify({ number: 1, headRefOid: SHA, baseRefName: 'main', headRefName: 'feat/x', state: 'OPEN', files: [] }) } : { status: 0, stdout: '[]' });
  const full = { ...config, root, ci: { ...config.ci, url: `${cc.url}/api`, project: 'gh/acme/shop' } };
  const t = ciTarget(full, 'acme/shop', gh);
  assert.equal(t.host.type, 'github');
  assert.equal(t.ci.type, 'circleci');
  assert.equal(headPipelines(t, 1, {}).state, 'failure');
});

test('GitHub + GitHub + GitHub Actions: the default combination and its adapters are unchanged', () => {
  const root = checkout('git@github.com:acme/shop.git', {});
  const used = products(root);
  assert.deepEqual([used.host.type, used.tracker.type, used.ci.provider], ['github', 'github', 'github-actions']);
  assert.deepEqual([hostFor({ root }).type, trackerFor({ root, board: {} }).type, ciFor({ root }).type], ['github', 'github', 'github-actions']);
  assert.equal(ciFor({ root }).capabilities.reviewEvents, true, 'review-quorum stays a workflow on review events');
});
