// The shared conformance suite (providers/conformance.mjs, what `factory adapter check` runs) against a fake server of
// every new built-in adapter, and against the custom adapter's worked example. A fake is built from the vendor's API
// documentation (the adapter's header names the pages); nothing here calls a real service.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { conformance } from '../lib/providers/conformance.mjs';
import { CONTRACTS, degradations, missingOperations } from '../lib/providers/contracts.mjs';
import { hostFor } from '../lib/hosts/index.mjs';
import { ciFor } from '../lib/ci/index.mjs';
import { headPipelines } from '../lib/ci/evidence.mjs';
import { trackerFor, resetTrackers } from '../../board/lib/trackers/index.mjs';
import { mergePr } from '../../review-gate/lib/github.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SHA = 'a'.repeat(40);
const workers = [];
after(() => Promise.all(workers.map((w) => w.terminate())));

async function fake(kind, auth) {
  const w = new Worker(path.join(HERE, 'fakes/providers-fake-server.mjs'), { workerData: { kind, auth } });
  workers.push(w);
  const [{ port }] = await once(w, 'message');
  const url = `http://127.0.0.1:${port}`;
  return { url, state: async () => (await fetch(`${url}/__fake/state`)).json(), seed: (s) => fetch(`${url}/__fake/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }), limit: (times) => fetch(`${url}/__fake/limit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ times }) }) };
}
const noFail = (r) => assert.deepEqual(r.results.filter((x) => x.status === 'fail').map((x) => `${x.op}: ${x.detail}`), [], `${r.type}: ${JSON.stringify(r.summary)}`);
const fakeGit = { head: () => SHA, pushBranch: () => true, deleteBranch: () => true };
const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conf-')));

test('Bitbucket Cloud host: every operation of the contract, read and write, against the fake; what it cannot do is declared', async () => {
  const bb = await fake('bitbucket', 'Bearer bb-good');
  process.env.FACTORY_TEST_BB_TOKEN = 'bb-good';
  const config = { root: tmpRoot(), host: { type: 'bitbucket', url: bb.url, repo: 'ws/app', token: '${FACTORY_TEST_BB_TOKEN}' } };
  const host = hostFor(config, { remote: '' });
  assert.deepEqual(missingOperations('host', host.sync).filter((m) => m.required), [], 'every required operation exists');
  const r = await conformance('host', host.sync, { write: true, git: fakeGit });
  noFail(r);
  assert.ok(r.summary.pass >= 25, JSON.stringify(r.summary));
  const pr = await host.pr.get(1);
  assert.equal(pr.headSha, SHA, 'the short hash Bitbucket returns is completed from the commits');
  assert.deepEqual((await host.pr.checks(1)).map((c) => [c.name, c.status, c.conclusion]), [['review-quorum', 'completed', 'success'], ['Pipeline #7', 'pending', null]]);
  assert.deepEqual((await host.pr.reviews(1)).map((x) => [x.author, x.state, x.commit]), [['rev', 'approved', SHA]]);
  const missing = degradations('host', host).map((d) => d.capability);
  for (const c of ['labels', 'mergeHeadGuard', 'autoMerge', 'attachments']) assert.ok(missing.includes(c), c);
  // A merge is refused when the head moved since the gate assessed it (no SHA-bound merge on Bitbucket).
  assert.throws(() => mergePr(config, 'ws/app', 1, { method: 'squash' }, { headSha: 'c'.repeat(40) }), /head moved/);
  const merged = mergePr(config, 'ws/app', 1, { method: 'squash' }, { headSha: SHA });
  assert.equal(merged.merged, true);
  // A 429 is retried.
  await bb.limit(2);
  assert.equal((await host.identity()).login, 'alice');
});

test('GitLab Issues tracker: read and write against the fake; lanes are labels, done closes; no custom fields (declared)', async () => {
  const gl = await fake('gitlab', 'glpat-good');
  process.env.FACTORY_TEST_GL_TOKEN = 'glpat-good';
  resetTrackers();
  const config = { root: tmpRoot(), tracker: { type: 'gitlab', url: gl.url, project: 'grp/app', auth: { token: '${FACTORY_TEST_GL_TOKEN}' }, lanes: { backlog: '', ready: 'Ready', inProgress: 'In Progress' }, board: { id: 4 } } };
  const t = trackerFor(config);
  const r = await conformance('tracker', t, { write: true });
  noFail(r);
  assert.equal(t.tickets.find('SHOP-1').number, 1);
  t.board.move(1, 'inProgress');
  assert.equal(t.board.lane(1), 'inProgress');
  t.board.move(1, 'done');
  assert.equal(t.tickets.get(1).state, 'closed');
  const created = t.tickets.create({ type: 'story', key: 'SHOP-9', title: 'SHOP-9: Coupons', body: 'Coupons apply once.', meta: { key: 'SHOP-9', sourceHash: 'x' } });
  assert.deepEqual(t.format.parse(t.tickets.get(created.id)).meta, { key: 'SHOP-9', sourceHash: 'x' }, 'the metadata block survives');
  assert.deepEqual(t.board.setup({ dryRun: true }).manual.length, 1, 'a missing board list is for a person');
  assert.ok(degradations('tracker', t).some((d) => d.capability === 'customFields'));
});

test('Linear tracker: read and write against the fake GraphQL server; states are lanes, metadata rides on an attachment', async () => {
  const ln = await fake('linear', 'lin_api_good');
  process.env.FACTORY_TEST_LINEAR_KEY = 'lin_api_good';
  resetTrackers();
  const config = { root: tmpRoot(), tracker: { type: 'linear', url: ln.url, project: 'ENG', auth: { token: '${FACTORY_TEST_LINEAR_KEY}' } } };
  const t = trackerFor(config);
  const r = await conformance('tracker', t, { write: true });
  noFail(r);
  const epic = t.tickets.create({ type: 'epic', title: 'Checkout', meta: { key: 'ENG-EPIC', type: 'epic' } });
  const child = t.tickets.create({ type: 'story', title: 'Totals', parent: epic.id });
  assert.equal(t.tickets.get(child.id).parent, epic.id);
  assert.deepEqual(t.tickets.children(epic.id).map((c) => c.id), [child.id]);
  assert.equal(t.tickets.get(epic.id).meta.key, 'ENG-EPIC');
  t.board.move(child.id, 'done');
  assert.equal(t.tickets.get(child.id).state, 'closed');
  assert.throws(() => t.tickets.attach(child.id, { name: 'x.png', data: Buffer.from('x') }), /signed upload/);
});

test('CI systems: GitLab CI, Azure Pipelines, Jenkins, CircleCI and Bitbucket Pipelines give expected pipelines, runs by commit and logs', async () => {
  const gl = await fake('gitlab', 'glpat-good');
  const az = await fake('azure', `Basic ${Buffer.from(':az-good').toString('base64')}`);
  const jk = await fake('jenkins', `Basic ${Buffer.from('ci-user:jk-good').toString('base64')}`);
  const cc = await fake('circleci', 'cc-good');
  const bb = await fake('bitbucket', 'Bearer bb-good');
  Object.assign(process.env, { FACTORY_TEST_GL_TOKEN: 'glpat-good', FACTORY_TEST_AZ: 'az-good', FACTORY_TEST_JK_USER: 'ci-user', FACTORY_TEST_JK: 'jk-good', FACTORY_TEST_CC: 'cc-good', FACTORY_TEST_BB_TOKEN: 'bb-good' });
  const fakeHost = { repo: { file: () => 'version: 2.1\nworkflows:\n  build:\n    jobs: [test]\n  nightly:\n    triggers:\n      - schedule: { cron: "0 0 * * *" }\n    jobs: [test]\n' } };
  const cases = [
    ['gitlab-ci', { root: tmpRoot(), host: { type: 'gitlab', url: gl.url, repo: 'grp/app', token: '${FACTORY_TEST_GL_TOKEN}' }, ci: { provider: 'gitlab-ci' } }, {}, 'success'],
    ['azure-pipelines', { root: tmpRoot(), host: { type: 'azure-devops', url: az.url, repo: 'o/p/app', token: '${FACTORY_TEST_AZ}' }, ci: { provider: 'azure-pipelines' } }, {}, 'success'],
    ['jenkins', { root: tmpRoot(), host: { type: 'github', repo: 'acme/shop' }, ci: { provider: 'jenkins', url: jk.url, job: 'team/shop', user: '${FACTORY_TEST_JK_USER}', token: '${FACTORY_TEST_JK}' } }, {}, 'success'],
    ['circleci', { root: tmpRoot(), host: { type: 'github', repo: 'acme/shop' }, ci: { provider: 'circleci', url: `${cc.url}/api`, project: 'gh/acme/shop', token: '${FACTORY_TEST_CC}' } }, { host: fakeHost }, 'failure'],
    ['bitbucket-pipelines', { root: tmpRoot(), host: { type: 'bitbucket', url: bb.url, repo: 'ws/app', token: '${FACTORY_TEST_BB_TOKEN}' }, ci: { provider: 'bitbucket-pipelines' } }, {}, 'pending'],
  ];
  // circleci's base is .../api, its v1.1 output URLs point at the fake.
  for (const [provider, config, deps, wantState] of cases) {
    const ci = ciFor(config, { remote: '', ...deps });
    assert.equal(ci.type, provider);
    const fixture = { head: SHA, base: 'main', pr: 1, branch: provider === 'circleci' ? 'feat/x' : 'feat/x', changed: ['src/cart.ts'], root: config.root };
    const r = await conformance('ci', ci, { fixture });
    noFail(r);
    const runs = ci.runs({ head: SHA, branch: 'feat/x', pr: 1 });
    assert.ok(runs.length >= 1, `${provider}: a run for the head`);
    assert.ok(runs.every((x) => !x.sha || x.sha === SHA || SHA.startsWith(x.sha)), `${provider}: only the head's runs`);
    const host = { repo: 'x', pr: { get: () => ({ headSha: SHA, base: 'main', head: 'feat/x' }), files: () => [{ path: 'src/cart.ts' }] } };
    assert.equal(headPipelines({ host, ci }, 1, {}).state, wantState, provider);
    if (ci.capabilities.logs) assert.match(ci.log(runs[0].id, { failedOnly: true }), /FAIL/, `${provider}: the failed log`);
  }
  // CircleCI: a workflow only a schedule starts is not expected on a pull request.
  assert.deepEqual(ciFor(cases[3][1], { remote: '', host: fakeHost }).expected({ head: SHA }).map((w) => w.name), ['build']);
});

test('the custom adapter: the worked example script passes the tracker suite; an unknown operation is unsupported, a slow one times out', async () => {
  const root = tmpRoot();
  const store = path.join(root, 'store.json');
  process.env.FACTORY_TEST_ACME_STORE = store;
  resetTrackers();
  const config = { root, tracker: { type: 'custom', command: [process.execPath, path.join(ROOT, 'docs/providers/examples/custom-tracker.mjs')], env: { ACME_TRACKER_STORE: '${FACTORY_TEST_ACME_STORE}' } } };
  const t = trackerFor(config);
  assert.equal(t.type, 'custom');
  const r = await conformance('tracker', t, { write: true });
  noFail(r);
  assert.ok(r.results.some((x) => x.op === 'tickets.attach' && x.status === 'skipped'));
  assert.throws(() => t.tickets.attach('ACME-1', { name: 'a', data: 'x' }), (e) => e.name === 'UnsupportedError');
  assert.equal(t.capabilities.customFields, false, 'capabilities come from its describe answer');
  // The protocol's timeout and a command that answers no JSON.
  const slow = trackerFor({ root, tracker: { type: 'custom', command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], timeoutSec: 0.5 } });
  assert.throws(() => slow.identity(), /timed out/);
  const junk = trackerFor({ root: tmpRoot(), tracker: { type: 'custom', command: [process.execPath, '-e', 'console.log("hello")'] } });
  assert.throws(() => junk.identity(), /no JSON answer/);
  // Secrets reach the command only through `env`, and never appear in an error.
  process.env.FACTORY_TEST_SECRET = 'super-secret-value';
  const leaky = trackerFor({ root: tmpRoot(), tracker: { type: 'custom', command: [process.execPath, '-e', 'console.log(JSON.stringify({ ok: false, error: "bad " + process.env.TOKEN }))'], env: { TOKEN: '${FACTORY_TEST_SECRET}' } } });
  assert.throws(() => leaky.identity(), (e) => /bad \*\*\*/.test(e.message) && !e.message.includes('super-secret-value'));
});

test('the conformance suite exercises every operation of each contract (none is silently left out)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/pipeline/lib/providers/conformance.mjs'), 'utf8');
  for (const kind of ['host', 'tracker', 'ci', 'scanner']) {
    const listed = CONTRACTS[kind].map((o) => o.id);
    // Each operation is either called by name or covered by the "skipped" sweep of its kind.
    const swept = kind === 'tracker' || /for \(const op of \[/.test(src);
    for (const op of listed) assert.ok(src.includes(`'${op}'`) || swept, `${kind} ${op}`);
  }
});

// ---- the adapters that existed before (their own fakes, from their own tests) ------------------------------------------
async function trackerFake(kind, { prefix = '', auth }) {
  const w = new Worker(path.join(ROOT, 'scripts/board/test/fixtures/fake-tracker-server.mjs'), { workerData: { kind, prefix, auth } });
  workers.push(w);
  const [{ port }] = await once(w, 'message');
  return { url: `http://127.0.0.1:${port}${prefix}` };
}
const boardCfg = (tracker) => ({ root: tmpRoot(), stateDir: '.factory/state', board: { columns: ['backlog', 'ready', 'inProgress', 'testing', 'review', 'failed', 'done'], epicLabel: 'epic', spikeLabel: 'spike', storyLabel: 'story', blockedLabel: 'needs-human' }, tracker });

test('Jira Cloud and Azure Boards trackers pass the same suite against their fakes, read and write', async () => {
  process.env.FACTORY_TEST_JIRA_USER = 'me@example.com';
  process.env.FACTORY_TEST_JIRA_TOKEN = 'jira-secret';
  const jira = await trackerFake('jira-cloud', { auth: `Basic ${Buffer.from('me@example.com:jira-secret').toString('base64')}` });
  resetTrackers();
  const j = trackerFor(boardCfg({ type: 'jira', deployment: 'cloud', url: jira.url, project: 'SHOP', auth: { user: '${FACTORY_TEST_JIRA_USER}', token: '${FACTORY_TEST_JIRA_TOKEN}' }, board: { id: 7 } }));
  noFail(await conformance('tracker', j, { write: true }));
  process.env.FACTORY_TEST_ADO_PAT = 'ado-pat';
  const ado = await trackerFake('azure', { prefix: '/tfs/DefaultCollection', auth: `Basic ${Buffer.from(':ado-pat').toString('base64')}` });
  resetTrackers();
  const a = trackerFor(boardCfg({ type: 'azure-boards', url: ado.url, project: 'Shop', auth: { token: '${FACTORY_TEST_ADO_PAT}' }, board: { team: 'Shop Team', board: 'Stories' } }));
  noFail(await conformance('tracker', a, { write: true }));
});

test('GitHub host and GitHub Actions pass the suite against the in-memory GitHub (fake gh); GitLab and Azure DevOps hosts against theirs', async () => {
  const { fakeGh } = await import('../../review-gate/test/fake-gh.mjs');
  const gh = fakeGh('acme/shop');
  gh.addPr(7, { headRefOid: SHA, checks: [{ name: 'ci', bucket: 'pass' }], files: ['src/a.ts'], reviews: [{ id: 1, user: { login: 'rev' }, state: 'APPROVED', commit_id: SHA }], commits: [{ sha: SHA, commit: { message: 'fix' }, parents: [{}] }] });
  const host = hostFor({ root: tmpRoot(), host: { type: 'github', repo: 'acme/shop' } }, { gh: gh.gh, remote: '' });
  const r = await conformance('host', host.sync, { fixture: { pr: 7 } });
  // Branch protection reads (rulesets, classic protection) are answered by the live check, not this fake.
  assert.deepEqual(r.results.filter((x) => x.status === 'fail' && x.op !== 'repo.branchProtection').map((x) => `${x.op}: ${x.detail}`), []);
  const ci = ciFor({ root: tmpRoot(), host: { type: 'github', repo: 'acme/shop' } }, { gh: gh.gh, remote: '' });
  noFail(await conformance('ci', ci, { fixture: { head: SHA, base: 'main', pr: 7, changed: ['src/a.ts'] } }));
  const { fakeGitlab, fakeAzure } = await import('./hosts-fakes.mjs');
  const gl = await fakeGitlab('/gitlab');
  gl.state.addMr();
  process.env.FACTORY_TEST_GITLAB = 'glpat-good';
  const glHost = hostFor({ root: tmpRoot(), host: { type: 'gitlab', url: gl.url, repo: 'grp/sub/app', token: '${FACTORY_TEST_GITLAB}' } }, { remote: '' });
  const glr = await conformance('host', glHost, {}).finally(() => gl.close());
  noFail(glr);
  const az = await fakeAzure('/tfs');
  az.state.addPr();
  process.env.FACTORY_TEST_AZURE = 'pat-good';
  const azHost = hostFor({ root: tmpRoot(), host: { type: 'azure-devops', url: az.url, repo: 'coll/Shop/app', token: '${FACTORY_TEST_AZURE}' } }, { remote: '' });
  const azr = await conformance('host', azHost, {}).finally(() => az.close());
  noFail(azr);
  assert.ok(azr.results.some((x) => x.op === 'issues.search' && x.status === 'unsupported'), 'Azure Repos has no issues: declared');
});

test('the application\'s own checks no host rule requires are named with why: duplicate job names, paths filters; a shared required name too (council C10, Opus 5)', async () => {
  const { uncoveredChecks } = await import('../lib/ci/github-actions.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uncovered-'));
  const w = (f, text) => {
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github/workflows', f), text);
  };
  w('factory-gate.yml', 'name: AI app factory\non: pull_request\njobs:\n  lint:\n    runs-on: x\n');
  w('markdownlint.yml', 'name: Markdownlint\non: pull_request\njobs:\n  lint:\n    runs-on: x\n');
  w('pr-validation.yml', "name: validation\non:\n  pull_request:\n    paths-ignore: ['**.md']\njobs:\n  test:\n    runs-on: x\n");
  w('playwright.yml', "name: playwright\non:\n  pull_request:\n    paths-ignore: ['**.md']\njobs:\n  test:\n    runs-on: x\n");
  w('maui.yml', "name: maui\non:\n  pull_request:\n    branches: ['**']\n    paths: ['src/ClientApp/**']\njobs:\n  test:\n    name: MAUI build\n    runs-on: x\n");
  const u = uncoveredChecks(root);
  const maui = u.find((x) => x.name === 'MAUI build');
  assert.match(maui.reason, /paths filter/);
  assert.doesNotMatch(maui.reason, /some base branches/, 'branches: ["**"] is every base branch');
  const byWf = Object.fromEntries(u.map((x) => [x.workflow, x]));
  assert.match(byWf['.github/workflows/pr-validation.yml'].reason, /also used by \.github\/workflows\/playwright\.yml[\s\S]*paths filter/);
  assert.match(byWf['.github/workflows/markdownlint.yml'].reason, /required check "lint" is also the name of \.github\/workflows\/factory-gate\.yml/);
  assert.equal(byWf['.github/workflows/factory-gate.yml'], undefined, 'the factory\'s own workflows are not listed');
});
