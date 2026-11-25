// The code host adapters (scripts/pipeline/lib/hosts): detection and settings, GitHub through a fake gh,
// GitLab and Azure DevOps through fake HTTP servers under a self-hosted path prefix (every interface
// method, pagination, an auth failure, a 429 retry), the synchronous bridge, and the PR bot on them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { detectHost, fileUrl, gitRemote, hostFor, hostSettings, HostAuthError, UnsupportedError } from '../lib/hosts/index.mjs';
import { retryDelayMs } from '../lib/hosts/http.mjs';
import { botEnv, openPullRequest, prPublisher, pushWithToken, resetBot } from '../lib/bot.mjs';
import { fakeAzure, fakeGitlab } from './hosts-fakes.mjs';
import { createBitbucketHost } from '../lib/hosts/bitbucket.mjs';
import { defaultSettings } from '../lib/settings.mjs';

// The merge method a host's merge() uses when its caller names none: the setting's default (council r3, F14).
const METHOD = defaultSettings().implement.autoMerge.method;

const noSleep = async () => {};
const here = path.dirname(fileURLToPath(import.meta.url));

test('detectHost: cloud URLs in https and ssh forms, and self-hosted servers when the type is given', () => {
  const cases = {
    'git@github.com:acme/shop.git': { type: 'github', url: 'https://github.com', repo: 'acme/shop' },
    'https://github.com/acme/shop': { type: 'github', url: 'https://github.com', repo: 'acme/shop' },
    'ssh://git@github.com/acme/shop.git': { type: 'github', url: 'https://github.com', repo: 'acme/shop' },
    'https://gitlab.com/grp/sub/app.git': { type: 'gitlab', url: 'https://gitlab.com', repo: 'grp/sub/app' },
    'git@gitlab.com:grp/sub/app.git': { type: 'gitlab', url: 'https://gitlab.com', repo: 'grp/sub/app' },
    'https://org@dev.azure.com/org/My%20Shop/_git/app': { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'org/My Shop/app' },
    'git@ssh.dev.azure.com:v3/org/Shop/app': { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'org/Shop/app' },
    'https://org.visualstudio.com/DefaultCollection/Shop/_git/app': { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'org/Shop/app' },
    'https://org.visualstudio.com/Shop/_git/app': { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'org/Shop/app' },
    'ssh://git@gitlab.acme.io:2222/team/app.git': { type: 'gitlab', url: 'https://gitlab.acme.io', repo: 'team/app' },
    'https://tfs.acme.local/tfs/Coll/Shop/_git/app': { type: 'azure-devops', url: 'https://tfs.acme.local/tfs', repo: 'Coll/Shop/app' },
  };
  for (const [remote, want] of Object.entries(cases)) assert.deepEqual(detectHost(remote), want, remote);
  assert.equal(detectHost('https://git.acme.io/team/app.git'), null, 'an unknown server without a type');
  assert.deepEqual(detectHost('https://git.acme.io/gitlab/team/app.git', { type: 'gitlab', url: 'https://git.acme.io/gitlab' }), { type: 'gitlab', url: 'https://git.acme.io/gitlab', repo: 'team/app' });
  assert.deepEqual(detectHost('https://ghe.acme.io/o/r.git', { type: 'github' }), { type: 'github', url: 'https://ghe.acme.io', repo: 'o/r' });
});

test('hostSettings: config.host wins, then the caller\'s legacy repo (GitHub), the origin, and board.repo', () => {
  assert.deepEqual(hostSettings({ board: { repo: 'acme/shop' } }, { remote: '' }), { type: 'github', url: 'https://github.com', repo: 'acme/shop', token: null, apiVersion: null, root: null, bot: null, user: null });
  assert.equal(hostSettings({ board: { repo: 'acme/shop' } }, { remote: 'git@github.com:acme/fork.git' }).repo, 'acme/fork');
  assert.equal(hostSettings({ board: { repo: 'acme/shop' } }, { remote: 'git@github.com:acme/fork.git', repo: 'acme/shop' }).repo, 'acme/shop');
  const gl = hostSettings({ host: { type: 'gitlab', url: 'https://git.acme.io/gitlab', token: '${GL}' }, board: { repo: 'acme/shop' } }, { remote: 'https://git.acme.io/gitlab/team/app.git', repo: 'acme/shop' });
  assert.deepEqual([gl.type, gl.url, gl.repo, gl.token], ['gitlab', 'https://git.acme.io/gitlab', 'team/app', '${GL}'], 'board.repo is never a GitLab project');
  assert.equal(hostSettings({}, { remote: 'git@ssh.dev.azure.com:v3/org/Shop/app' }).type, 'azure-devops');
  assert.equal(hostSettings({ host: { type: 'bitbucket' } }, { remote: '' }).type, 'bitbucket');
  assert.throws(() => hostSettings({ host: { type: 'sourcehut' } }, { remote: '' }), /use one of github, gitlab, azure-devops, bitbucket, custom/);
  const cfg = { board: { repo: 'a/b' } };
  assert.equal(hostFor(cfg), hostFor(cfg), 'cached per config');
  assert.equal(String(hostFor(cfg).repo), 'a/b');
});

test('fileUrl and gitRemote per host', () => {
  assert.equal(fileUrl({ type: 'github', url: 'https://github.com', repo: 'a/b' }, 'pr-1/v.webm', 'pr-videos', { raw: true }), 'https://github.com/a/b/blob/pr-videos/pr-1/v.webm?raw=true');
  assert.equal(fileUrl({ type: 'gitlab', url: 'https://gitlab.com', repo: 'g/p' }, 'pr-1/v.webm', 'pr-videos', { raw: true }), 'https://gitlab.com/g/p/-/raw/pr-videos/pr-1/v.webm');
  assert.match(fileUrl({ type: 'azure-devops', url: 'https://dev.azure.com', repo: 'o/P/r' }, 'pr-1/v.webm', 'pr-videos'), /^https:\/\/dev\.azure\.com\/o\/P\/_git\/r\?path=%2Fpr-1%2Fv\.webm&version=GBpr-videos$/);
  assert.deepEqual(gitRemote({ type: 'azure-devops', url: 'https://tfs.acme.local/tfs', repo: 'Coll/My Shop/app' }), { url: 'https://tfs.acme.local/tfs/Coll/My%20Shop/_git/app', user: '', origin: 'https://tfs.acme.local' });
  assert.equal(gitRemote({ type: 'gitlab', url: 'https://gitlab.com', repo: 'g/p' }).user, 'oauth2');
});

test('retry delay: Retry-After seconds or date, reset epochs, else exponential backoff', () => {
  const h = (o) => new Headers(o);
  assert.equal(retryDelayMs(h({ 'retry-after': '3' }), 0), 3000);
  assert.equal(retryDelayMs(h({ 'retry-after': new Date(10_000).toUTCString() }), 0, 4000), 6000);
  assert.equal(retryDelayMs(h({ 'ratelimit-reset': '20' }), 0, 0), 20_000);
  assert.equal(retryDelayMs(h({}), 2), 4000);
});

// ---------------------------------------------------------------------------------------------
// GitHub: the gh CLI, same commands as before the adapters
// ---------------------------------------------------------------------------------------------

function fakeGhCli() {
  const calls = [];
  const prs = { 5: { number: 5, url: 'https://github.com/acme/shop/pull/5', title: 'Fix', body: 'b', state: 'OPEN', isDraft: false, headRefName: 'fix/5', baseRefName: 'main', headRefOid: 'abc', author: { login: 'dev-bot' }, labels: [{ name: 'approvals:1' }], mergeable: 'MERGEABLE', createdAt: '2026-11-01T00:00:00Z', isCrossRepository: false, files: [{ path: 'a.js', additions: 2, deletions: 1, changeType: 'MODIFIED' }], comments: [{ body: 'x <!-- m -->', url: 'https://github.com/acme/shop/pull/5#issuecomment-77', author: { login: 'dev' } }] } };
  const gh = (args, opts = {}) => {
    calls.push({ args, input: opts.input, env: opts.env });
    const [a, b] = args;
    const out = (v) => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    if (a === 'pr' && b === 'create') return out('https://github.com/acme/shop/pull/9\n');
    if (a === 'pr' && b === 'view') return prs[args[2]] ? out(prs[args[2]]) : { status: 1, stdout: '', stderr: 'no pull requests found for branch "x"' };
    if (a === 'pr' && b === 'list') return out([prs[5]]);
    if (a === 'pr' && b === 'checks') return { status: 8, stdout: JSON.stringify([{ name: 'ci', bucket: 'pass' }, { name: 'e2e', bucket: 'pending', link: 'u' }]), stderr: '' };
    if (a === 'pr' && b === 'diff') return out('diff --git a/a.js b/a.js\n');
    if (a === 'api' && b === 'user') return out({ login: 'octocat', id: 1 });
    // A PR's comments from the issues API, every page (`--paginate --slurp`: a list of pages).
    if (a === 'api' && /issues\/5\/comments$/.test(b) && args.includes('--slurp')) return out([[{ id: 77, body: 'x <!-- m -->', user: { login: 'dev' }, html_url: 'https://github.com/acme/shop/pull/5#issuecomment-77' }]]);
    if (a === 'api' && /pulls\/5\/reviews$/.test(b)) return out(`${JSON.stringify({ id: 1, user: { login: 'alice', type: 'User' }, state: 'APPROVED', submitted_at: 't1', commit_id: 'abc', body: '' })}\n`);
    if (a === 'api' && /pulls\/5\/comments$/.test(b)) return out(`${JSON.stringify({ id: 2, user: { login: 'alice' }, body: 'nit', path: 'a.js', line: 3, pull_request_review_id: 1, created_at: 't2' })}\n`);
    if (a === 'api' && /pulls\/5\/commits$/.test(b)) return out(`${JSON.stringify({ sha: 'abc', author: { login: 'dev' }, commit: { committer: { date: 't0' } } })}\n`);
    if (a === 'api' && b === 'repos/acme/shop') return out('main\n');
    if (a === 'api' && /contents\/README\.md/.test(b)) return out('# shop\n');
    if (a === 'api' && /contents\//.test(b)) return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    if (a === 'api' && /branches\/main\/protection$/.test(b)) return { status: 1, stdout: '{"message":"Branch not protected"}', stderr: 'gh: Branch not protected (HTTP 404)' };
    if (a === 'api' && /branches\/dev\/protection$/.test(b)) return out({ required_status_checks: { contexts: ['build'], checks: [{ context: 'review-quorum' }] }, required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true } });
    if (a === 'api' && /rules\/branches\/dev$/.test(b)) return out([]);
    if (a === 'api' && /rules\/branches\/main$/.test(b)) return out([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'review-quorum' }] } }, { type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true } }]);
    return out('');
  };
  return { gh, calls };
}

test('github: every method maps onto the gh command it used before, normalised', async () => {
  const f = fakeGhCli();
  const host = hostFor({ host: { type: 'github', repo: 'acme/shop' } }, { gh: f.gh, remote: '' });
  assert.equal(host.type, 'github');
  assert.equal(host.webUrl, 'https://github.com/acme/shop');
  assert.deepEqual(await host.identity(), { login: 'octocat', id: 1 });
  const opened = await host.pr.open({ head: 'fix/9', base: 'main', title: 't', body: 'b', draft: true, labels: ['bug'], reviewers: ['alice'] });
  assert.deepEqual([opened.number, opened.url], [9, 'https://github.com/acme/shop/pull/9']);
  assert.deepEqual(f.calls.at(-1).args, ['pr', 'create', '--base', 'main', '--head', 'fix/9', '--title', 't', '--body', 'b', '--draft', '--label', 'bug', '--reviewer', 'alice', '-R', 'acme/shop']);
  const pr = await host.pr.get(5);
  assert.deepEqual({ ...pr, files: undefined }, { number: 5, url: 'https://github.com/acme/shop/pull/5', title: 'Fix', body: 'b', state: 'open', draft: false, head: 'fix/5', base: 'main', headSha: 'abc', author: 'dev-bot', labels: ['approvals:1'], mergeable: true, createdAt: '2026-11-01T00:00:00Z', updatedAt: null, mergedAt: null, closedAt: null, mergeCommit: null, additions: null, deletions: null, changedFiles: null, fromFork: false, files: undefined });
  assert.equal(await host.pr.get('fix/none'), null, 'no PR for a branch: null');
  assert.equal((await host.pr.list({ head: 'fix/5' }))[0].number, 5);
  assert.ok(f.calls.at(-1).args.includes('--head'));
  await host.pr.update(5, { title: 'T', body: 'B', labels: { add: ['x'], remove: ['y'] } });
  assert.deepEqual(f.calls.at(-1).args, ['pr', 'edit', '5', '-R', 'acme/shop', '--title', 'T', '--body-file', '-', '--add-label', 'x', '--remove-label', 'y']);
  assert.equal(f.calls.at(-1).input, 'B');
  assert.deepEqual(await host.pr.comment(5, 'new <!-- m -->', { marker: '<!-- m -->' }), { id: 77, url: 'https://github.com/acme/shop/pull/5#issuecomment-77' });
  assert.deepEqual(f.calls.at(-1).args.slice(0, 4), ['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/77']);
  assert.deepEqual((await host.pr.comments(5))[0], { id: 77, author: 'dev', body: 'x <!-- m -->', createdAt: null, url: 'https://github.com/acme/shop/pull/5#issuecomment-77' });
  assert.deepEqual(await host.pr.reviews(5), [{ id: 1, author: 'alice', bot: false, state: 'approved', submittedAt: 't1', commit: 'abc', body: '' }]);
  assert.deepEqual(await host.pr.reviewComments(5), [{ id: 2, author: 'alice', body: 'nit', path: 'a.js', line: 3, reviewId: 1, createdAt: 't2' }]);
  assert.deepEqual(await host.pr.commits(5), [{ sha: 'abc', author: 'dev', committedAt: 't0', parents: null, message: null }]);
  assert.deepEqual(await host.pr.requestReviewers(5, ['alice']), ['alice']);
  assert.deepEqual(await host.pr.files(5), [{ path: 'a.js', status: 'modified', additions: 2, deletions: 1 }]);
  assert.match(await host.pr.diff(5), /^diff --git/);
  assert.deepEqual(await host.pr.checks(5), [{ name: 'ci', status: 'completed', conclusion: 'success', url: null }, { name: 'e2e', status: 'pending', conclusion: null, url: 'u' }], 'gh exits 8 while pending; the JSON still counts');
  await host.pr.setStatus('abc', { name: 'review-quorum', state: 'success', description: 'ok' });
  assert.deepEqual(JSON.parse(f.calls.at(-1).input), { state: 'success', context: 'review-quorum', description: 'ok' });
  await host.pr.merge(5, { method: 'squash', auto: true });
  assert.deepEqual(f.calls.filter((c) => c.args[1] === 'merge').at(-1).args, ['pr', 'merge', '5', '-R', 'acme/shop', '--auto', '--squash']);
  await host.pr.merge(5, { auto: true });
  assert.equal(f.calls.filter((c) => c.args[1] === 'merge').at(-1).args.at(-1), `--${METHOD}`, 'no method: the setting\'s default');
  assert.equal(await host.pr.cancelAutoMerge(5), true);
  assert.equal(await host.repo.defaultBranch(), 'main');
  assert.equal(await host.repo.file('README.md', 'main'), '# shop\n');
  assert.equal(await host.repo.file('missing.md'), null);
  assert.deepEqual(await host.repo.branchProtection('main'), { enforced: true, branch: 'main', requiredChecks: ['review-quorum'], requiredApprovals: 1, codeOwnerReview: true, via: ['a ruleset'] });
  assert.deepEqual(await host.repo.branchProtection('dev'), { enforced: true, branch: 'dev', requiredChecks: ['build', 'review-quorum'], requiredApprovals: 2, codeOwnerReview: true, via: ['branch protection'] }, 'classic branch protection counts too');
  assert.equal(host.sync.pr.get(5).number, 5, 'the synchronous form');
});

test('github: an identity token becomes GH_TOKEN; GitHub Enterprise sets GH_HOST and -R host/owner/name', () => {
  const f = fakeGhCli();
  hostFor({ host: { repo: 'acme/shop' } }, { gh: f.gh, token: 'ghs_x', remote: '' }).sync.pr.merge(5);
  assert.equal(f.calls.at(-1).env.GH_TOKEN, 'ghs_x');
  hostFor({ host: { type: 'github', url: 'https://ghe.acme.io', repo: 'o/r' } }, { gh: f.gh, remote: '' }).sync.pr.get(5);
  assert.equal(f.calls.at(-1).env.GH_HOST, 'ghe.acme.io');
  assert.deepEqual(f.calls.at(-1).args.slice(3, 5), ['-R', 'ghe.acme.io/o/r']);
  const plain = fakeGhCli();
  hostFor({ host: { repo: 'acme/shop' } }, { gh: plain.gh, remote: '' }).sync.pr.get(5);
  assert.equal(plain.calls.at(-1).env, undefined, 'no override: gh keeps its own login and environment');
});

// ---------------------------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------------------------

let gl;
let az;
before(async () => {
  gl = await fakeGitlab('/gitlab');
  az = await fakeAzure('/tfs');
  process.env.HOSTS_TEST_GL = 'glpat-good';
  process.env.HOSTS_TEST_AZ = 'pat-good';
});
after(async () => {
  await gl.close();
  await az.close();
});

const glConfig = () => ({ host: { type: 'gitlab', url: gl.url, repo: 'grp/sub/app', token: '${HOSTS_TEST_GL}' } });
const azConfig = () => ({ host: { type: 'azure-devops', url: az.url, repo: 'coll/Shop/app', token: '${HOSTS_TEST_AZ}' } });

test('gitlab: every method against a self-managed server under /gitlab', async () => {
  const host = hostFor(glConfig(), { remote: '', sleep: noSleep });
  assert.equal(host.webUrl, `${gl.url}/grp/sub/app`);
  assert.deepEqual(await host.identity(), { login: 'alice', id: 11 });
  const opened = await host.pr.open({ head: 'fix/1', title: 'Fix it', body: 'why', draft: true, labels: ['bug'], reviewers: ['bob'] });
  assert.deepEqual([opened.state, opened.draft, opened.base, opened.head, opened.labels, opened.author], ['open', true, 'main', 'fix/1', ['bug'], 'alice'], 'base defaults to the default branch');
  const create = gl.state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/merge_requests'));
  assert.deepEqual(JSON.parse(create.body).reviewer_ids, [12]);
  assert.equal(create.headers['private-token'], 'glpat-good');
  await assert.rejects(host.pr.open({ head: 'fix/1', base: 'main', title: 'again' }), (e) => e.code === 'exists' && /already exists/.test(e.message));
  const n = opened.number;
  assert.equal((await host.pr.get(n)).title, 'Draft: Fix it');
  assert.equal((await host.pr.get('fix/1')).number, n, 'by branch');
  assert.equal(await host.pr.get(999), null);
  await host.pr.update(n, { title: 'Fix it', body: 'new', labels: { add: ['approvals:1'], remove: ['bug'] }, draft: false });
  const mr = gl.state.mrs.get(n);
  assert.deepEqual([mr.title, mr.description, mr.labels, mr.draft], ['Fix it', 'new', ['approvals:1'], false]);
  await host.pr.update(n, { labels: ['a', 'b'] });
  assert.deepEqual(mr.labels, ['a', 'b']);
  const c1 = await host.pr.comment(n, 'notice v1 <!-- gate -->', { marker: '<!-- gate -->' });
  const c2 = await host.pr.comment(n, 'notice v2 <!-- gate -->', { marker: '<!-- gate -->' });
  assert.equal(c1.id, c2.id, 'upserted by marker');
  assert.equal(c2.url, `https://gl.example/grp/sub/app/-/merge_requests/${n}#note_${c1.id}`);
  assert.deepEqual((await host.pr.comments(n)).map((c) => c.body), ['notice v2 <!-- gate -->']);
  mr.approvals = [{ username: 'bob', id: 12 }];
  mr.reviewerStates = [{ user: { username: 'carol' }, state: 'requested_changes', created_at: 't3' }, { user: { username: 'bob' }, state: 'approved' }];
  assert.deepEqual((await host.pr.reviews(n)).map((r) => [r.author, r.state, r.commit]), [['bob', 'approved', mr.sha], ['carol', 'changes_requested', mr.sha]]);
  mr.discussions = [{ notes: [{ id: 5, body: 'line note', author: { username: 'carol' }, position: { new_path: 'src/a.js', new_line: 4 }, created_at: 't4' }, { id: 6, body: 'general', author: { username: 'carol' } }] }];
  assert.deepEqual(await host.pr.reviewComments(n), [{ id: 5, author: 'carol', body: 'line note', path: 'src/a.js', line: 4, reviewId: null, createdAt: 't4' }]);
  mr.commits = [{ id: 'c1', author_name: 'Alice', committed_date: 't5' }];
  assert.deepEqual(await host.pr.commits(n), [{ sha: 'c1', author: 'Alice', committedAt: 't5', parents: null, message: null }]);
  assert.deepEqual(await host.pr.requestReviewers(n, ['alice', 'nobody']), ['alice']);
  assert.deepEqual(mr.reviewers.map((u) => u.username), ['bob', 'alice']);
  mr.diffs = [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1,2 @@\n-x\n+y\n+z\n' }, { old_path: 'n.js', new_path: 'n.js', new_file: true, diff: '@@ -0,0 +1 @@\n+n\n' }];
  assert.deepEqual(await host.pr.files(n), [{ path: 'a.js', status: 'modified', additions: 2, deletions: 1 }, { path: 'n.js', status: 'added', additions: 1, deletions: 0 }]);
  assert.match(await host.pr.diff(n), /^diff --git a\/a\.js b\/a\.js\n--- a\/a\.js\n\+\+\+ b\/a\.js\n@@/);
  mr.pipelines = [{ id: 40 }, { id: 41 }];
  mr.jobs = { 41: [{ name: 'test', status: 'success', web_url: 'j1' }, { name: 'lint', status: 'failed', allow_failure: true }, { name: 'review-quorum', status: 'running' }] };
  mr.commitStatuses = [{ name: 'external', status: 'pending', target_url: 's1' }];
  assert.deepEqual(await host.pr.checks(n), [
    { name: 'test', status: 'completed', conclusion: 'success', url: 'j1' },
    { name: 'lint', status: 'completed', conclusion: 'neutral', url: null },
    { name: 'review-quorum', status: 'in_progress', conclusion: null, url: null },
    { name: 'external', status: 'queued', conclusion: null, url: 's1' },
  ]);
  await host.pr.setStatus(mr.sha, { name: 'review-quorum', state: 'failure', description: 'needs 1 approval' });
  assert.deepEqual(gl.state.statuses.at(-1), { sha: mr.sha, state: 'failed', name: 'review-quorum', description: 'needs 1 approval' });
  await host.pr.merge(n, { method: 'squash', auto: true });
  assert.deepEqual(gl.state.merges.at(-1), { iid: n, squash: true, should_remove_source_branch: false, merge_when_pipeline_succeeds: true, auto_merge: true, by: 'alice' });
  await host.pr.merge(n, { auto: true });
  assert.equal(gl.state.merges.at(-1).squash, METHOD === 'squash', 'no method: the setting\'s default');
  assert.equal(await host.pr.cancelAutoMerge(n), true);
  assert.equal(mr.autoMerge, false);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-')), 'demo.webm');
  fs.writeFileSync(tmp, 'webm');
  assert.equal(await host.pr.uploadAttachment(n, tmp), `${gl.url}/grp/sub/app/uploads/abc/demo.webm`);
  assert.equal(await host.repo.defaultBranch(), 'main');
  assert.equal(await host.repo.file('README.md', 'main'), '# app\n');
  assert.equal(await host.repo.file('missing.md', 'main'), null);
  assert.deepEqual(await host.repo.branchProtection('main'), { enforced: true, branch: 'main', requiredChecks: ['pipeline', 'review-quorum'], requiredApprovals: 2, codeOwnerReview: true, pipelineGate: true, via: ['a protected branch', 'Pipelines must succeed'] });
  assert.equal((await host.repo.branchProtection('dev')).enforced, false);
  await host.repo.ensureLabel('approvals:1', { color: 'fbca04' });
  await host.repo.ensureLabel('approvals:1', { color: 'fbca04' });
  assert.deepEqual(gl.state.labels, [{ name: 'approvals:1', color: '#fbca04', description: '' }], 'an existing label (409) is fine');
  await host.pr.update(n, { state: 'closed' });
  assert.equal((await host.pr.get(n)).state, 'closed');
  assert.deepEqual((await host.pr.list({ state: 'closed' })).map((p) => p.number), [n], 'closed lists closed and merged MRs');
});

test('gitlab: pagination, a 429 retried, and an auth failure', async () => {
  for (let i = 0; i < 150; i++) gl.state.addMr({ labels: i % 2 ? ['approvals:1'] : [] });
  const host = hostFor(glConfig(), { remote: '', sleep: noSleep });
  const open = await host.pr.list({ state: 'open', limit: 500 });
  assert.ok(open.length >= 150, `every page (${open.length})`);
  assert.ok(gl.state.requests.some((r) => r.path.endsWith('/merge_requests') && r.query.page === '2'), 'page 2 was requested');
  assert.equal((await host.pr.list({ state: 'open', label: 'approvals:1', limit: 500 })).length, 75);
  gl.state.limitNext = 1;
  assert.equal((await host.identity()).login, 'alice', 'a 429 is retried');
  const bad = hostFor({ host: { ...glConfig().host, token: 'wrong-token' } }, { remote: '', sleep: noSleep });
  await assert.rejects(bad.identity(), (e) => e instanceof HostAuthError && e.status === 401 && !e.message.includes('wrong-token'));
  await assert.rejects(hostFor({ host: { type: 'gitlab', url: gl.url, repo: 'grp/sub/app' } }, { remote: '', env: {} }).identity(), /no GitLab token/);
});

// ---------------------------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------------------------

test('azure-devops: every method against an Azure DevOps Server under /tfs', async () => {
  const host = hostFor(azConfig(), { remote: '', sleep: noSleep });
  assert.equal(host.webUrl, `${az.url}/coll/Shop/_git/app`);
  assert.deepEqual(await host.identity(), { login: 'alice@acme.test', id: 'u-alice' });
  const opened = await host.pr.open({ head: 'fix/1', title: 'Fix', body: 'why', labels: ['bug'], reviewers: ['bob@acme.test'] });
  assert.deepEqual([opened.base, opened.head, opened.labels, opened.state, opened.url], ['main', 'fix/1', ['bug'], 'open', `${az.url}/coll/Shop/_git/app/pullrequest/${opened.number}`]);
  const create = az.state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/pullrequests'));
  assert.equal(create.headers.authorization, `Basic ${Buffer.from(':pat-good').toString('base64')}`);
  assert.deepEqual(JSON.parse(create.body).reviewers, [{ id: 'u-bob' }]);
  await assert.rejects(host.pr.open({ head: 'fix/1', base: 'main', title: 'again' }), (e) => e.code === 'exists' && /already exists/.test(e.message));
  const n = opened.number;
  const pr = az.state.prs.get(n);
  assert.equal((await host.pr.get('fix/1')).number, n);
  assert.equal(await host.pr.get(999), null);
  await host.pr.update(n, { title: 'T', body: 'B', draft: true, labels: { add: ['approvals:1'], remove: ['bug'] } });
  assert.deepEqual([pr.title, pr.description, pr.isDraft, pr.labels.map((l) => l.name)], ['T', 'B', true, ['approvals:1']]);
  assert.ok(az.state.requests.some((r) => r.path.endsWith('/labels') && r.query['api-version'] === '7.1-preview.1'), 'labels use the preview API version');
  const c1 = await host.pr.comment(n, 'v1 <!-- gate -->', { marker: '<!-- gate -->' });
  const c2 = await host.pr.comment(n, 'v2 <!-- gate -->', { marker: '<!-- gate -->' });
  assert.equal(c1.id, c2.id);
  assert.deepEqual((await host.pr.comments(n)).map((c) => [c.author, c.body]), [['alice@acme.test', 'v2 <!-- gate -->']]);
  pr.reviewers = [{ uniqueName: 'bob@acme.test', id: 'u-bob', vote: 10 }, { uniqueName: 'carol@acme.test', id: 'u-c', vote: -5 }, { uniqueName: 'dan@acme.test', id: 'u-d', vote: 0 }, { uniqueName: '[Shop]\\Team', id: 'g', vote: 10, isContainer: true }];
  assert.deepEqual((await host.pr.reviews(n)).map((r) => [r.author, r.state, r.commit]), [['bob@acme.test', 'approved', pr.lastMergeSourceCommit.commitId], ['carol@acme.test', 'changes_requested', pr.lastMergeSourceCommit.commitId]]);
  pr.threads.push({ id: 50, threadContext: { filePath: '/src/a.js', rightFileStart: { line: 7 } }, comments: [{ id: 1, content: 'fix this', commentType: 'text', author: { uniqueName: 'carol@acme.test' }, publishedDate: 't6' }] });
  assert.deepEqual(await host.pr.reviewComments(n), [{ id: '50/1', author: 'carol@acme.test', body: 'fix this', path: 'src/a.js', line: 7, reviewId: null, createdAt: 't6' }]);
  pr.commits = [{ commitId: 'c1', author: { email: 'a@acme.test' }, committer: { date: 't7' } }];
  assert.deepEqual(await host.pr.commits(n), [{ sha: 'c1', author: 'a@acme.test', committedAt: 't7', parents: null, message: null }]);
  assert.deepEqual(await host.pr.requestReviewers(n, ['alice@acme.test', 'nobody']), ['alice@acme.test']);
  pr.iterations = [{ id: 1 }, { id: 2 }];
  pr.changes = [{ item: { path: '/src/a.js' }, changeType: 'edit' }, { item: { path: '/src/n.js' }, changeType: 'add' }, { item: { path: '/src', isFolder: true }, changeType: 'edit' }];
  assert.deepEqual(await host.pr.files(n), [{ path: 'src/a.js', status: 'modified', additions: null, deletions: null }, { path: 'src/n.js', status: 'added', additions: null, deletions: null }]);
  await assert.rejects(host.pr.diff(n), (e) => e instanceof UnsupportedError && /git diff/.test(e.message));
  pr.statuses = [{ id: 1, state: 'pending', context: { genre: 'factory', name: 'review-quorum' } }, { id: 2, state: 'succeeded', context: { genre: 'factory', name: 'review-quorum' }, targetUrl: 'u' }];
  pr.evaluations = [{ status: 'rejected', configuration: { type: { displayName: 'Minimum number of reviewers' }, settings: {} } }];
  assert.deepEqual(await host.pr.checks(n), [{ name: 'factory/review-quorum', status: 'completed', conclusion: 'success', url: 'u' }, { name: 'Minimum number of reviewers', status: 'completed', conclusion: 'failure', url: null }]);
  await host.pr.setStatus('sha1', { name: 'factory/review-quorum', state: 'success', description: 'ok', pr: n });
  assert.deepEqual(az.state.commitStatuses.at(-1), { sha: 'sha1', state: 'succeeded', description: 'ok', context: { name: 'review-quorum', genre: 'factory' } });
  assert.equal(pr.statuses.at(-1).state, 'succeeded', 'and the PR status the policies read');
  await host.pr.merge(n, { method: 'squash', auto: true, deleteBranch: true });
  assert.deepEqual([pr.autoCompleteSetBy, pr.completionOptions], [{ id: 'u-alice' }, { mergeStrategy: 'squash', deleteSourceBranch: true }]);
  assert.equal(await host.pr.cancelAutoMerge(n), true);
  assert.equal(pr.autoCompleteSetBy, null);
  await host.pr.merge(n, { auto: true });
  assert.equal(pr.completionOptions.mergeStrategy, { squash: 'squash', merge: 'noFastForward', rebase: 'rebase' }[METHOD], 'no method: the setting\'s default');
  await host.pr.cancelAutoMerge(n);
  // Council r4 (test-value follow-up): a method Azure DevOps has no strategy for gets the setting default's.
  await host.pr.merge(n, { method: 'octopus', auto: true });
  assert.equal(pr.completionOptions.mergeStrategy, { squash: 'squash', merge: 'noFastForward', rebase: 'rebase' }[METHOD], 'an unknown method: the setting default\'s strategy');
  await host.pr.cancelAutoMerge(n);
  await host.pr.merge(n, { method: 'merge', auto: false });
  assert.equal((await host.pr.get(n)).state, 'merged');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-')), 'demo.webm');
  fs.writeFileSync(tmp, 'webm');
  assert.match(await host.pr.uploadAttachment(n, tmp), /attachments\/demo\.webm$/);
  assert.equal(await host.repo.defaultBranch(), 'main');
  assert.equal(await host.repo.file('README.md', 'main'), '# app\n');
  assert.equal(await host.repo.file('missing.md'), null);
  az.state.policies = [
    { isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' }, settings: { minimumApproverCount: 2 } },
    { isEnabled: true, isBlocking: true, type: { displayName: 'Status' }, settings: { statusGenre: 'factory', statusName: 'review-quorum' } },
    { isEnabled: true, isBlocking: true, type: { displayName: 'Required reviewers' }, settings: {} },
    { isEnabled: false, isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'ci' } },
  ];
  assert.deepEqual(await host.repo.branchProtection('main'), { enforced: true, branch: 'main', requiredChecks: ['factory/review-quorum'], requiredApprovals: 2, codeOwnerReview: true });
  await host.repo.ensureLabel('x');
  assert.ok(az.state.requests.every((r) => r.query['api-version']), 'every request names an api-version');
});

test('azure-devops: $top/$skip pagination, a 429 retried, and an auth failure', async () => {
  for (let i = 0; i < 150; i++) az.state.addPr({ labels: i % 3 === 0 ? [{ name: 'approvals:2' }] : [] });
  const host = hostFor(azConfig(), { remote: '', sleep: noSleep });
  assert.ok((await host.pr.list({ state: 'open', limit: 500 })).length >= 150);
  assert.ok(az.state.requests.some((r) => r.path.endsWith('/pullrequests') && r.query.$skip === '100'));
  assert.equal((await host.pr.list({ state: 'open', label: 'approvals:2', limit: 500 })).length, 50);
  az.state.limitNext = 2;
  assert.equal((await host.repo.defaultBranch()), 'main');
  await assert.rejects(hostFor({ host: { ...azConfig().host, token: 'nope-nope' } }, { remote: '', sleep: noSleep }).repo.defaultBranch(), (e) => e instanceof HostAuthError && !e.message.includes('nope-nope'));
});

test('the synchronous bridge runs a REST adapter in a child process and keeps error classes', async () => {
  const server = spawn(process.execPath, [path.join(here, 'hosts-fake-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const urls = await new Promise((resolve, reject) => {
      server.stdout.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0])));
      server.once('error', reject);
    });
    const g = hostFor({ host: { ...glConfig().host, url: urls.gitlab } }, { remote: '' }).sync;
    assert.equal(g.repo.defaultBranch(), 'main');
    assert.equal(g.pr.get(1).number, 1);
    assert.equal(g.pr.get(9999), null);
    assert.equal(String(g.repo), 'grp/sub/app');
    const a = hostFor({ host: { ...azConfig().host, url: urls.azure } }, { remote: '' }).sync;
    assert.equal(a.pr.get(1).number, 1);
    assert.throws(() => a.pr.diff(1), (e) => e.name === 'UnsupportedError');
    assert.throws(() => hostFor({ host: { ...glConfig().host, url: urls.gitlab, token: 'bad-token' } }, { remote: '' }).sync.identity(), (e) => e.name === 'HostAuthError');
  } finally {
    server.kill();
  }
});

// ---------------------------------------------------------------------------------------------
// The PR identity on GitLab and Azure DevOps
// ---------------------------------------------------------------------------------------------

test('PR bot on GitLab: host.bot.token; publisher pushes with oauth2 basic auth and opens the MR as the bot', async () => {
  resetBot();
  process.env.HOSTS_TEST_GL_BOT = 'glpat-bot';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-bot-'));
  const config = { root, bot: { enabled: true }, host: { ...glConfig().host, bot: { token: '${HOSTS_TEST_GL_BOT}' } } };
  assert.deepEqual(await botEnv(config, { log: () => {} }), { token: 'glpat-bot' });
  assert.equal(await hostFor(config).bot.token(), 'glpat-bot');
  assert.equal(await hostFor(config).bot.status({ log: () => {} }), 0);
  const pushes = [];
  const git = (cwd, args, opts = {}) => (pushes.push({ args, env: opts.env }), { status: 0, stdout: '', stderr: '' });
  const publisher = await prPublisher(config, { git, log: () => {} });
  assert.equal(publisher.token, 'glpat-bot');
  const r = await openPullRequest(publisher, { cwd: root, branch: 'fix/bot', base: 'main', title: 'Bot MR', body: 'b' });
  assert.match(r.url, /merge_requests\/\d+$/);
  const push = pushes.find((p) => p.args.includes('push'));
  assert.equal(push.args.at(-2), `${gl.url}/grp/sub/app.git`);
  assert.equal(push.env.GIT_CONFIG_KEY_1, `http.${new URL(gl.url).origin}/.extraheader`);
  assert.equal(push.env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('oauth2:glpat-bot').toString('base64')}`);
  const mr = [...gl.state.mrs.values()].find((m) => m.source_branch === 'fix/bot');
  assert.equal(mr.author.username, 'project_7_bot', 'authored by the bot user');
  const again = await openPullRequest(publisher, { cwd: root, branch: 'fix/bot', base: 'main', title: 'Bot MR', body: 'b' });
  assert.equal(again.url, null);
  assert.match(again.reason, /^gitlab pull request creation failed: .*already exists/);
  delete process.env.HOSTS_TEST_GL_BOT;
  resetBot();
  const logs = [];
  assert.equal(await botEnv({ ...config, host: { ...config.host, bot: { token: '${HOSTS_TEST_GL_BOT}' } } }, { log: (m) => logs.push(m) }), null);
  assert.match(logs.join('\n'), /not set up for gitlab/);
  const steps = [];
  assert.equal(await hostFor({ ...config, host: { ...config.host, bot: null } }).bot.setup({}, { log: (m) => steps.push(m) }), 1);
  assert.match(steps.join('\n'), /settings\/access_tokens.*\n.*api.*write_repository/);
});

test('PR bot on Azure DevOps: an empty basic-auth user for the PAT, and setup prints the manual steps', () => {
  const pushes = [];
  const git = (cwd, args, opts = {}) => (pushes.push({ args, env: opts.env }), { status: 0, stdout: '', stderr: '' });
  const remote = gitRemote({ type: 'azure-devops', url: 'https://dev.azure.com', repo: 'org/Shop/app' });
  pushWithToken('/wt', 'fix/1', { token: 'pat-bot', git, remote, upstream: false });
  assert.equal(pushes[0].args.at(-2), 'https://dev.azure.com/org/Shop/_git/app');
  assert.equal(pushes[0].env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from(':pat-bot').toString('base64')}`);
  assert.ok(!pushes[0].args.join(' ').includes('pat-bot'), 'the token is never on the command line');
});

test('review-quorum runs on a GitLab merge request through the host (approvals:N against approvals)', async () => {
  const { execFile } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-quorum-'));
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ host: glConfig().host }));
  const mr = gl.state.addMr({ labels: ['approvals:1'], author: { username: 'project_7_bot' } });
  const quorum = (n) =>
    new Promise((resolve) => execFile(process.execPath, [path.join(here, '../../review-gate/quorum.mjs'), String(n)], { cwd: root, env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_STEP_SUMMARY: '' } }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
  let r = await quorum(mr.iid);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /review-quorum: fail/);
  mr.approvals = [{ username: 'bob', id: 12 }];
  r = await quorum(mr.iid);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /review-quorum: pass/);
});

test('review-gate enforce on GitLab: Pipelines must succeed, the default branch protected with code owner approval; idempotent; a lower tier is reported', async () => {
  const server = await fakeGitlab('/gl2');
  try {
    server.state.project.only_allow_merge_if_pipeline_succeeds = false;
    delete server.state.protected.main;
    const host = hostFor({ host: { type: 'gitlab', url: server.url, repo: 'grp/sub/app', token: '${HOSTS_TEST_GL}' } }, { remote: '', sleep: noSleep });
    const dry = await host.repo.enforceReviewGate({ codeOwners: true, dryRun: true });
    assert.equal(dry.action, 'would-create');
    assert.ok(!server.state.requests.some((r) => r.method !== 'GET'), 'a dry run changes nothing');
    const done = await host.repo.enforceReviewGate({ codeOwners: true });
    assert.equal(done.action, 'created');
    assert.equal(server.state.project.only_allow_merge_if_pipeline_succeeds, true);
    assert.deepEqual([server.state.protected.main.code_owner_approval_required, server.state.protected.main.push_access_levels[0].access_level, server.state.protected.main.merge_access_levels[0].access_level], [true, 40, 30]);
    assert.deepEqual(done.manual, []);
    const bp = await host.repo.branchProtection();
    assert.deepEqual([bp.enforced, bp.codeOwnerReview, bp.requiredChecks.includes('pipeline')], [true, true, true], 'doctor then reads it as enforced');
    assert.equal((await host.repo.enforceReviewGate({ codeOwners: true })).action, 'unchanged');
    // A tier without code owner approval: the protected branch exists, the PATCH is refused.
    server.state.premium = false;
    server.state.protected.main.code_owner_approval_required = false;
    const lower = await host.repo.enforceReviewGate({ codeOwners: true });
    assert.equal(lower.action, 'updated');
    assert.match(lower.manual.join('\n'), /GitLab Premium/);
  } finally {
    await server.close();
  }
});

test('review-gate enforce on Azure DevOps: a blocking Status policy for factory/review-quorum; required reviewers listed for a person', async () => {
  const server = await fakeAzure('/tfs2');
  try {
    const host = hostFor({ host: { type: 'azure-devops', url: server.url, repo: 'coll/Shop/app', token: '${HOSTS_TEST_AZ}' } }, { remote: '', sleep: noSleep });
    const dry = await host.repo.enforceReviewGate({ codeOwners: true, dryRun: true });
    assert.equal(dry.action, 'would-create');
    assert.equal(server.state.policies.length, 0, 'a dry run changes nothing');
    const done = await host.repo.enforceReviewGate({ codeOwners: true });
    assert.equal(done.action, 'created');
    const [policy] = server.state.policies;
    assert.deepEqual([policy.isBlocking, policy.isEnabled, policy.settings.statusGenre, policy.settings.statusName, policy.settings.scope[0].refName], [true, true, 'factory', 'review-quorum', 'refs/heads/main']);
    assert.match(done.manual.join('\n'), /Required reviewers policy on main/);
    assert.equal((await host.repo.enforceReviewGate({ codeOwners: false })).action, 'unchanged');
    server.state.policies[0] = { ...server.state.policies[0], type: { id: policy.type.id, displayName: 'Status' } };
    const bp = await host.repo.branchProtection();
    assert.deepEqual(bp.requiredChecks, ['factory/review-quorum'], 'doctor reads the policy it created');
  } finally {
    await server.close();
  }
});

test('review-gate enforce through the review gate module: a code host or, as before, a gh runner', async () => {
  const { enforce } = await import('../../review-gate/lib/enforcement.mjs');
  const calls = [];
  const fakeHost = { repo: { enforceReviewGate: async (o) => (calls.push(o), { action: 'unchanged', summary: 's', manual: [] }) } };
  assert.equal((await enforce(fakeHost, { codeOwners: true })).action, 'unchanged');
  assert.deepEqual(calls, [{ codeOwners: true }]);
});

// Council r3 (F14): Bitbucket's merge with no method, or one Bitbucket has no strategy for, asks for the strategy of the
// implement.autoMerge.method setting's default.
test('bitbucket: merge() with no method, or an unknown one, uses the setting\'s default strategy', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/merge')) bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ state: 'MERGED', updated_on: 't' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const host = createBitbucketHost({ repo: 'ws/shop' }, { fetch, token: 'tok-x', env: {} });
  await host.pr.merge(7);
  await host.pr.merge(8, { method: 'octopus' });
  const strategy = { squash: 'squash', merge: 'merge_commit', rebase: 'fast_forward' }[METHOD];
  assert.deepEqual(bodies.map((b) => b.merge_strategy), [strategy, strategy]);
});
