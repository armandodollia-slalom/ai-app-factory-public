// Host x tracker combinations, end to end: for each of the 9 pairs of code host (GitHub, GitLab, Azure
// DevOps) and ticket tracker (GitHub, Jira, Azure Boards), the pipeline-level flow of one story against
// the adapters' fakes (no real service is called):
//
//   read the ticket from the tracker -> open a pull request on the host -> link the PR to the ticket
//   (board.mjs linkPullRequest) -> move the ticket to Pending Review -> post and upsert a marker comment
//   on the PR and on the ticket -> read the diff (UnsupportedError + fallback where the host has none) ->
//   label the PR approvals:1, read reviews, run the review-quorum decision (lib/quorum.mjs, as
//   quorum.mjs does) -> set the review-quorum status -> merge -> move the ticket to Done.
//
// The CI provider only changes the generated files (scripts/factory/test/providers.test.mjs covers all
// three); the second test runs `factory init`, `render`, `check` and `uninstall` on GitLab and Azure
// DevOps clones with each tracker. docs/hosts-and-trackers.md lists what this proves.
//
// Fakes: GitHub is an in-memory gh for both GitHub adapters (fake-github-combined.mjs); GitLab and Azure
// DevOps are HTTP servers on this thread (hosts-fakes.mjs; the host methods used here are async, so this
// thread is free to answer them); Jira and Azure Boards run on a worker thread
// (board/test/fixtures/fake-tracker-server.mjs) because tracker methods are synchronous and block this
// thread while they wait (scripts/pipeline/lib/blocking.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { hostFor } from '../lib/hosts/index.mjs';
import { trackerFor } from '../../board/lib/trackers/index.mjs';
import { linkPullRequest } from '../../board/lib/link.mjs';
import { quorum } from '../../review-gate/lib/quorum.mjs';
import { toReview } from '../../review-gate/lib/github.mjs';
import { fakeAzure, fakeGitlab } from './hosts-fakes.mjs';
import { fakeGithubCombined } from './fake-github-combined.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.resolve(here, '../../..');
const FACTORY = path.join(INSTALL, 'bin/factory.mjs');
const TRACKER_SERVER = path.join(INSTALL, 'scripts/board/test/fixtures/fake-tracker-server.mjs');
const LANES = { backlog: 'Backlog', ready: 'Ready', inProgress: 'In Progress', testing: 'Testing', review: 'Pending Review', failed: 'Failed', done: 'Done' };
const MARKER = '<!-- e2e-flow:v1 -->';

const temps = [];
const tmp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(d);
  return d;
};

async function startTrackerFake(kind, { prefix = '', auth }) {
  const worker = new Worker(TRACKER_SERVER, { workerData: { kind, prefix, auth } });
  const { port } = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const root = `http://127.0.0.1:${port}`;
  return { url: `${root}${prefix}`, state: async () => (await fetch(`${root}/__fake/state`)).json(), close: () => worker.terminate() };
}

let gl;
let az;
const ENV = { E2E_GITLAB_TOKEN: 'glpat-good', E2E_ADO_HOST_PAT: 'pat-good', E2E_JIRA_USER: 'me@example.com', E2E_JIRA_TOKEN: 'jira-secret', E2E_BOARDS_PAT: 'ado-pat' };
before(async () => {
  Object.assign(process.env, ENV);
  gl = await fakeGitlab('/gitlab');
  az = await fakeAzure('/tfs');
});
after(async () => {
  await gl.close();
  await az.close();
  for (const k of Object.keys(ENV)) delete process.env[k];
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

// ---- the products ---------------------------------------------------------------------------------------

// Each host: its config section, how a reviewer approves on the fake, and what pr.diff does there.
const HOSTS = {
  github: {
    config: () => ({ type: 'github', repo: 'acme/shop' }),
    approve: (gh, pr) => gh.approve(pr.number, 'alice'),
    statusOf: (gh, sha) => gh.statuses.filter((s) => s.sha === sha).map((s) => [s.context, s.state]),
    merged: (gh, n) => gh.prs.get(n).state === 'MERGED',
  },
  gitlab: {
    config: () => ({ type: 'gitlab', url: gl.url, repo: 'grp/sub/app', token: '${E2E_GITLAB_TOKEN}' }),
    approve: (_gh, pr) => {
      gl.state.mrs.get(pr.number).approvals = [{ username: 'bob', id: 12 }];
    },
    statusOf: (_gh, sha) => gl.state.statuses.filter((s) => s.sha === sha).map((s) => [s.name, s.state]),
    merged: (_gh, n) => gl.state.mrs.get(n).state === 'merged',
  },
  'azure-devops': {
    config: () => ({ type: 'azure-devops', url: az.url, repo: 'coll/Shop/app', token: '${E2E_ADO_HOST_PAT}' }),
    approve: (_gh, pr) => {
      az.state.prs.get(pr.number).reviewers.push({ uniqueName: 'bob@acme.test', id: 'u-bob', vote: 10 });
    },
    statusOf: (_gh, sha) => az.state.commitStatuses.filter((s) => s.sha === sha).map((s) => [`${s.context?.genre ? `${s.context.genre}/` : ''}${s.context?.name}`, s.state]),
    merged: (_gh, n) => az.state.prs.get(n).status === 'completed',
    // Documented in the adapter and docs/hosts-and-trackers.md: no unified diff API.
    diffUnsupported: /git diff/,
  },
};

// Each tracker: a fresh fake, its config section, and where its PR link shows.
const TRACKERS = {
  github: {
    start: async () => ({ close: () => {} }),
    config: () => ({ type: 'github' }),
    legacy: { tickets: { repo: 'acme/shop' }, board: { owner: 'acme', ownerType: 'user', repo: 'acme/shop', projectNumber: 1, statusField: 'Status' } },
    // GitHub with a GitHub PR: `Closes #N` in the PR body; with a PR elsewhere: a comment on the issue.
    linked: async (_fake, gh, ticket, pr, hostType) => (hostType === 'github' ? gh.prs.get(pr.number).body.includes(`Closes #${ticket.id}`) : [...gh.comments.values()].some((c) => c.on === ticket.id && c.body.includes(pr.url))),
  },
  jira: {
    start: () => startTrackerFake('jira-cloud', { auth: `Basic ${Buffer.from('me@example.com:jira-secret').toString('base64')}` }),
    config: (fake) => ({ type: 'jira', deployment: 'cloud', url: fake.url, project: 'SHOP', auth: { user: '${E2E_JIRA_USER}', token: '${E2E_JIRA_TOKEN}' }, board: { id: 7 } }),
    linked: async (fake, _gh, ticket, pr) => JSON.stringify((await fake.state()).remoteLinks[ticket.id] ?? []).includes(pr.url),
  },
  'azure-boards': {
    start: () => startTrackerFake('azure', { prefix: '/tfs/DefaultCollection', auth: `Basic ${Buffer.from(':ado-pat').toString('base64')}` }),
    config: (fake) => ({ type: 'azure-boards', url: fake.url, project: 'Shop', auth: { token: '${E2E_BOARDS_PAT}' }, board: { team: 'Shop Team', board: 'Stories' } }),
    linked: async (fake, _gh, ticket, pr) => JSON.stringify((await fake.state()).items[ticket.id]?.relations ?? []).includes(pr.url),
  },
};

const PAIRS = Object.keys(HOSTS).flatMap((h) => Object.keys(TRACKERS).map((t) => [h, t]));

// The flow of one story on one pair. Returns the steps it ran: [name, 'ok' | 'unsupported: <fallback>'].
async function flow(hostType, trackerType) {
  const H = HOSTS[hostType];
  const T = TRACKERS[trackerType];
  const gh = fakeGithubCombined('acme/shop');
  const fake = await T.start();
  const steps = [];
  try {
    const root = tmp(`combo-${hostType}-${trackerType}-`);
    const config = {
      root,
      stateDir: '.factory/state',
      host: H.config(),
      tracker: T.config(fake),
      board: { columns: LANES, epicLabel: 'epic', spikeLabel: 'spike', storyLabel: 'story', blockedLabel: 'needs-human', ...(T.legacy?.board ?? {}) },
      ...(T.legacy?.tickets ? { tickets: T.legacy.tickets } : {}),
      implement: { reviewGate: { labels: { approvals: 'approvals:{n}' } } },
    };
    const host = hostFor(config, { gh: gh.gh, remote: '' });
    const tracker = trackerFor(config, trackerType === 'github' ? { gh: gh.gh } : {});
    assert.equal(host.type, hostType);
    assert.equal(tracker.type, trackerType);

    // A story on the tracker, as `board new` leaves it.
    const rendered = tracker.format.render({ key: 'PROMO-3', type: 'story', title: 'PROMO-3: Coupons', slug: 'PROMO-3-coupons' }, '# PROMO-3: Coupons\n\nAs a shopper I enter a coupon.\n');
    tracker.tickets.create({ type: 'story', key: 'PROMO-3', title: 'PROMO-3: Coupons', body: rendered.body, labels: ['story'], meta: rendered.meta });

    // 1. Read the ticket from the tracker (the implementer's first step).
    const ticket = tracker.sync.tickets.get('PROMO-3');
    assert.equal(ticket?.key, 'PROMO-3', 'the ticket is found by its factory key');
    assert.match(tracker.format.parse(ticket).content, /As a shopper I enter a coupon/);
    steps.push(['read ticket', 'ok']);

    // 2. Open the pull request on the host.
    const pr = await host.pr.open({ head: 'story/PROMO-3', base: 'main', title: 'PROMO-3: Coupons', body: 'Implements PROMO-3.' });
    assert.ok(pr.number && pr.url, 'the host returns the new PR');
    steps.push(['open PR', 'ok']);

    // 3. Link the PR to the ticket: the board's own code (board.mjs `board review` does this).
    linkPullRequest(config, { number: ticket.id }, pr.url, { key: 'PROMO-3' }, { host, tracker });
    assert.ok(await T.linked(fake, gh, ticket, pr, hostType), 'the PR is linked from the ticket');
    steps.push(['link PR to ticket', 'ok']);

    // 4. Move the ticket's lane.
    tracker.sync.board.move(ticket.id, 'review');
    assert.equal(tracker.sync.board.lane(ticket.id), 'review');
    steps.push(['move lane', 'ok']);

    // 5. Post, then upsert, a marker comment on the PR and on the ticket: one comment each, updated.
    await host.pr.comment(pr.number, `First run.\n\n${MARKER}`, { marker: MARKER });
    await host.pr.comment(pr.number, `Second run.\n\n${MARKER}`, { marker: MARKER });
    const prMarked = (await host.pr.comments(pr.number)).filter((c) => c.body.includes(MARKER));
    assert.deepEqual(prMarked.map((c) => c.body.split('\n')[0]), ['Second run.'], 'one PR comment, upserted');
    tracker.sync.tickets.comment(ticket.id, `Claimed.\n\n${MARKER}`, { marker: MARKER });
    tracker.sync.tickets.comment(ticket.id, `Verified.\n\n${MARKER}`, { marker: MARKER });
    const ticketMarked = tracker.sync.tickets.comments(ticket.id).filter((c) => c.body.includes(MARKER));
    assert.deepEqual(ticketMarked.map((c) => c.body.split('\n')[0]), ['Verified.'], 'one ticket comment, upserted');
    steps.push(['upsert marker comments', 'ok']);

    // 6. The diff for review; a host without a diff API says what to do instead.
    try {
      const diff = await host.pr.diff(pr.number);
      assert.equal(typeof diff, 'string');
      assert.ok(!H.diffUnsupported, `${hostType} was expected to refuse pr.diff`);
      steps.push(['read diff', 'ok']);
    } catch (error) {
      assert.equal(error.name, 'UnsupportedError', `pr.diff failed with ${error.name}: ${error.message}`);
      assert.ok(error.unsupported);
      assert.match(error.message, H.diffUnsupported ?? /^$/, 'the message names the fallback');
      steps.push(['read diff', 'unsupported: git diff locally']);
    }

    // 7. Reviews and the review-quorum decision (as scripts/review-gate/quorum.mjs decides it).
    await host.pr.update(pr.number, { labels: { add: ['approvals:1'] } });
    const before = await host.pr.get(pr.number);
    let decision = quorum({ labels: before.labels, reviews: (await host.pr.reviews(pr.number)).map(toReview), author: before.author, headSha: before.headSha });
    assert.equal(decision.pass, false, 'no approval yet');
    H.approve(gh, before);
    const reviewed = await host.pr.get(pr.number);
    decision = quorum({ labels: reviewed.labels, reviews: (await host.pr.reviews(pr.number)).map(toReview), author: reviewed.author, headSha: reviewed.headSha });
    assert.equal(decision.pass, true, decision.summary);
    steps.push(['review quorum', 'ok']);

    // 8. The review-quorum status on the head commit.
    await host.pr.setStatus(reviewed.headSha, { name: 'review-quorum', state: 'success', description: decision.summary, pr: pr.number });
    assert.ok(H.statusOf(gh, reviewed.headSha).some(([name, state]) => /review-quorum/.test(name) && /success|succeeded/.test(state)), JSON.stringify(H.statusOf(gh, reviewed.headSha)));
    steps.push(['set status', 'ok']);

    // 9. Merge, and the ticket to Done.
    await host.pr.merge(pr.number, { method: 'squash', auto: false });
    assert.ok(H.merged(gh, pr.number), 'the PR is merged');
    assert.equal((await host.pr.get(pr.number)).state, 'merged');
    tracker.sync.board.move(ticket.id, 'done');
    assert.equal(tracker.sync.board.lane(ticket.id), 'done');
    steps.push(['merge', 'ok']);
    return steps;
  } finally {
    await fake.close();
  }
}

test('every host x tracker pair runs the pipeline flow end to end against the fakes', async (t) => {
  const table = [];
  for (const [h, tr] of PAIRS) {
    await t.test(`${h} + ${tr}`, async () => {
      const steps = await flow(h, tr);
      table.push([h, tr, steps.map(([s, r]) => (r === 'ok' ? s : `${s} (${r})`)).join(', ')]);
      assert.equal(steps.length, 9);
    });
  }
  assert.equal(table.length, 9, 'all 9 pairs ran');
  if (process.env.COMBINATIONS_TABLE) for (const row of table) console.log(row.join(' | '));
});

// ---- the generator on non-GitHub clones --------------------------------------------------------------

const TRACKER_SECTIONS = {
  github: { type: 'github' },
  jira: { type: 'jira', url: 'https://acme.atlassian.net', project: 'SHOP', auth: { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' } },
  'azure-boards': { type: 'azure-boards', url: 'https://dev.azure.com/acme', project: 'Shop', auth: { token: '${AZURE_DEVOPS_TOKEN}' } },
};
const ORIGINS = { gitlab: 'git@gitlab.com:platform/shop.git', 'azure-devops': 'https://dev.azure.com/acme/Shop/_git/shop' };

test('factory init, render, check and uninstall on GitLab and Azure DevOps clones with each tracker', () => {
  const run = (root, ...args) => spawnSync(process.execPath, [FACTORY, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  for (const [hostType, origin] of Object.entries(ORIGINS)) {
    for (const [trackerType, section] of Object.entries(TRACKER_SECTIONS)) {
      const what = `${hostType} + ${trackerType}`;
      const root = tmp('combo-init-');
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
      fs.writeFileSync(path.join(root, 'main.go'), 'package main\n');
      const before = fs.readdirSync(root).sort();
      let r = run(root, 'init', '--tools', 'claude');
      assert.equal(r.status, 0, `${what}: init: ${r.stderr}`);
      const config = JSON.parse(fs.readFileSync(path.join(root, '.factory/config.json'), 'utf8'));
      assert.equal(config.host.type, hostType, `${what}: init drafts the host from the origin`);
      assert.equal(config.ci.provider, hostType === 'gitlab' ? 'gitlab-ci' : 'azure-pipelines');
      // The host's own board is drafted (GitLab issues, Azure Boards), for the interview to confirm.
      assert.equal(config.tracker?.type ?? null, hostType === 'gitlab' ? 'gitlab' : 'azure-boards', `${what}: drafted tracker`);
      fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ ...config, tracker: section }, null, 2));
      r = run(root, 'render');
      assert.equal(r.status, 0, `${what}: render: ${r.stderr}`);
      const ciDir = hostType === 'gitlab' ? '.gitlab/ci' : '.azure-pipelines';
      assert.ok(fs.existsSync(path.join(root, ciDir, hostType === 'gitlab' ? 'factory-gate.yml' : 'factory-pr.yml')), `${what}: CI files`);
      // The tracker sweep job exists for every tracker on these CI systems (no tracker events there).
      assert.ok(fs.existsSync(path.join(root, ciDir, 'factory-tracker.yml')), `${what}: tracker job`);
      assert.ok(!fs.existsSync(path.join(root, '.github/workflows')), `${what}: no GitHub workflows`);
      r = run(root, 'check');
      assert.equal(r.status, 0, `${what}: check: ${r.stdout}${r.stderr}`);
      r = run(root, 'uninstall', '--all');
      assert.equal(r.status, 0, `${what}: uninstall: ${r.stderr}`);
      const left = fs.readdirSync(root).filter((f) => !before.includes(f) && f !== '.gitlab-ci.yml');
      assert.deepEqual(left, [], `${what}: uninstall leaves nothing of the factory's`);
      if (fs.existsSync(path.join(root, '.gitlab-ci.yml'))) assert.doesNotMatch(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), /factory/, `${what}: the include block is taken back`);
    }
  }
});
