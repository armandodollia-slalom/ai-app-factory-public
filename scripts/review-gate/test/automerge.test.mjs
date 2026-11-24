// Review gate, step 4: auto-merge for Low PRs, behind implement.autoMerge.enabled, through one merge
// function with a configurable identity.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseState } from '../lib/gate.mjs';
import { mergeIdentity, mergePr } from '../lib/github.mjs';
import { publishGate } from '../lib/publish.mjs';
import { syncGate } from '../lib/sync.mjs';
import { fakeGh } from './fake-gh.mjs';
import { cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, git, low } from './helpers.mjs';

function lowPr({ checks = 'pass', autoMerge = { enabled: true } } = {}) {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(8, { labels: [], checks: [{ name: 'ci', bucket: checks }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, { autoMerge });
  const publish = () => publishGate(config, { pr: pr.url, keys: ['BUG-3'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
  return { root, gh, pr, config, publish };
}

test('merge identity: gh-user uses the gh login; app needs its installation token; anything else is refused', () => {
  assert.deepEqual(mergeIdentity({ identity: 'gh-user' }), { identity: 'gh-user', env: undefined });
  assert.equal(mergeIdentity({ identity: 'app', appTokenEnv: 'X_TOKEN' }, { X_TOKEN: 't0k' }).env.GH_TOKEN, 't0k');
  assert.throws(() => mergeIdentity({ identity: 'app' }, {}), /REVIEW_GATE_APP_TOKEN is not set/);
  assert.equal(mergeIdentity({ identity: 'bot' }, {}, { bot: () => ({ GH_TOKEN: 'b0t' }) }).env.GH_TOKEN, 'b0t', 'bot merges with the PR bot token');
  assert.throws(() => mergeIdentity({ identity: 'bot' }, {}, { bot: () => null }), /"bot" but the pipeline's PR bot has no token/);
  assert.throws(() => mergeIdentity({ identity: 'robot' }), /must be "gh-user", "app" or "bot"/);
  const gh = fakeGh();
  gh.addPr(1);
  mergePr(gh.gh, 'acme/shop', 1, { identity: 'app', appTokenEnv: 'PATH' });
  assert.deepEqual(gh.merges[0].args.slice(0, 5), ['pr', 'merge', '1', '-R', 'acme/shop']);
  assert.ok(!gh.merges[0].args.includes('--auto') && gh.merges[0].args.includes('--squash'), 'nothing pending: a direct merge');
  assert.equal(gh.merges[0].token, process.env.PATH, 'the app token becomes GH_TOKEN');
});

test('a Low, high-confidence PR with green checks auto-merges and is labeled auto-merged', () => {
  const w = lowPr();
  const r = w.publish();
  assert.equal(r.decision.action, 'auto-merge');
  assert.equal(w.gh.merges.length, 1);
  assert.equal(w.pr.state, 'MERGED', 'merged directly: GitHub reported nothing pending');
  assert.deepEqual(w.pr.labels.sort(), ['approvals:0', 'auto-merged']);
  assert.deepEqual(w.pr.reviewers, []);
  assert.match(w.pr.comments[0].body, /## Review gate: auto-merge/);
  assert.equal(parseState(w.pr.comments[0].body).merge.identity, 'gh-user');
});

test('the kill switch: with implement.autoMerge.enabled false the same PR needs one approval', () => {
  const w = lowPr({ autoMerge: { enabled: false } });
  const r = w.publish();
  assert.equal(r.decision.action, 'review');
  assert.equal(w.gh.merges.length, 0);
  assert.deepEqual(w.pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.match(w.pr.comments[0].body, /auto-merge is switched off/);
});

// Dogfood C6 / council C3: a refused merge became "1 approval required". It is a merge failure, reported with its cause.
test('a merge GitHub refuses is reported as a merge failure with its cause, never as a review requirement', () => {
  const w = lowPr();
  w.gh.refuseMerge = 'Pull request is not mergeable: the base branch policy prohibits the merge';
  const r = w.publish();
  assert.equal(r.decision.action, 'merge-failed');
  assert.deepEqual(w.pr.labels.sort(), ['approvals:0', 'merge-failed']);
  assert.match(w.pr.comments[0].body, /## Review gate: merge failed/);
  assert.match(w.pr.comments[0].body, /GitHub refused the merge: \*\*.*the base branch policy prohibits the merge\*\*/);
  assert.match(w.pr.comments[0].body, /No approval is required for this/);
  assert.equal(parseState(w.pr.comments[0].body).required, false);
  // The next sync tries again and merges once GitHub allows it.
  delete w.gh.refuseMerge;
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  assert.equal(w.pr.state, 'MERGED');
  assert.ok(!w.pr.labels.includes('merge-failed') && w.pr.labels.includes('auto-merged'));
});

test('a PR GitHub has not cleared yet waits when the repository disallows auto-merge, and merges at the next sync', () => {
  const w = lowPr();
  w.gh.allowAuto = false;
  w.pr.mergeStateStatus = 'BLOCKED';
  const r = w.publish();
  assert.equal(r.decision.action, 'wait');
  assert.equal(w.gh.merges.length, 0, 'no --auto against a repository that refuses it');
  assert.deepEqual(w.pr.labels.sort(), ['approvals:0']);
  assert.match(w.pr.comments[0].body, /## Review gate: waiting for GitHub to clear the merge/);
  assert.match(w.pr.comments[0].body, /GitHub has not cleared the merge yet \(`BLOCKED`\).*No approval is required/);
  w.pr.mergeStateStatus = 'CLEAN';
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  assert.equal(w.pr.state, 'MERGED');
  assert.ok(!w.gh.merges[0].args.includes('--auto'));
});

test('a merge conflict is a merge failure with its cause', () => {
  const w = lowPr();
  w.pr.mergeStateStatus = 'DIRTY';
  assert.equal(w.publish().decision.action, 'merge-failed');
  assert.match(w.pr.comments[0].body, /conflicts with its base branch/);
});

// Dogfood C6: #78 and #79 were left in review by a refused --auto. The new gate drops that trigger and merges them.
test('a PR an earlier gate sent to review only because a merge failed is merged at the next sync', () => {
  const w = lowPr();
  w.gh.refuseMerge = 'x';
  w.publish();
  const body = w.pr.comments[0].body;
  const st = parseState(body);
  const legacy = { ...st, action: 'review', approvals: 1, required: true, triggers: ['auto-merge failed (gh pr merge 8 failed: GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge))'] };
  w.pr.comments[0].body = body.replace(/<!-- review-gate:.*-->/s, `<!-- review-gate:${JSON.stringify(legacy)} -->`);
  w.pr.labels = ['approvals:1', 'needs-human'];
  delete w.gh.refuseMerge;
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  assert.equal(w.pr.state, 'MERGED');
  assert.deepEqual(w.pr.labels.sort(), ['approvals:0', 'auto-merged']);
});

test('the pipeline\'s own base merges into a waiting PR are told apart from a real push', async () => {
  const { onlyBaseMergesSince } = await import('../lib/sync.mjs');
  const merge = (sha, message) => ({ sha, parents: [{}, {}], commit: { message } });
  const commits = [{ sha: 'a', parents: [{}], commit: { message: 'fix' } }, merge('b', 'Merge main into this branch (keep the PR mergeable)'), merge('c', "Merge branch 'main' into bugfix/x")];
  assert.equal(onlyBaseMergesSince(commits, 'a'), true);
  assert.equal(onlyBaseMergesSince([...commits, { sha: 'd', parents: [{}], commit: { message: 'more' } }], 'a'), false, 'a real push');
  assert.equal(onlyBaseMergesSince(commits, 'zzz'), false, 'unknown history is a change');
});

// ADV2-R4-01: a rating is bound to the PR's own change (its diff from the merge base), not to the head commit.
test('a rating survives the pipeline\'s base merge; a person\'s commit or a conflict resolved differently voids it', () => {
  const g = (root, ...args) => git(root, '-c', 'user.email=p@example.com', '-c', 'user.name=P', ...args);
  const sync = (w) => syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  // The base moves on another file; the pipeline merges it into the waiting PR: the PR's own change is the same.
  const baseMerged = (w, file = 'src/Other.cs', text = 'other') => {
    const branch = git(w.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    const before = git(w.root, 'rev-parse', 'HEAD');
    g(w.root, 'checkout', '-q', 'main');
    fs.mkdirSync(path.dirname(path.join(w.root, file)), { recursive: true });
    fs.writeFileSync(path.join(w.root, file), text);
    g(w.root, 'add', '-A');
    g(w.root, 'commit', '-qm', 'base moves');
    g(w.root, 'checkout', '-q', branch);
    const m = spawnSync('git', ['-c', 'user.email=p@example.com', '-c', 'user.name=P', 'merge', '--no-edit', '-q', '-m', 'Merge main into this branch (keep the PR mergeable)', 'main'], { cwd: w.root, encoding: 'utf8' });
    return { before, conflicted: m.status !== 0 };
  };
  const head = (w, extra = []) => {
    w.pr.headRefOid = git(w.root, 'rev-parse', 'HEAD');
    w.pr.commits = [{ sha: extra.before, parents: [{}], commit: { message: 'fix' } }, ...extra.commits];
    w.pr.checks = [{ name: 'ci', bucket: 'pass' }];
  };
  const keep = lowPr({ checks: 'pending' });
  keep.publish();
  const k = baseMerged(keep);
  head(keep, { before: k.before, commits: [{ sha: git(keep.root, 'rev-parse', 'HEAD'), parents: [{}, {}], commit: { message: 'Merge main into this branch (keep the PR mergeable)' } }] });
  sync(keep);
  assert.equal(keep.pr.state, 'MERGED', 'the pipeline\'s base merge keeps the rating');
  // A person's commit changes the PR's own change: not assessed, review.
  const person = lowPr({ checks: 'pending' });
  person.publish();
  const before = git(person.root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(person.root, 'src/Basket.API/A.cs'), 'a person\'s change');
  g(person.root, 'commit', '-qam', 'a person');
  head(person, { before, commits: [{ sha: git(person.root, 'rev-parse', 'HEAD'), parents: [{}], commit: { message: 'a person' } }] });
  sync(person);
  assert.equal(person.pr.state, 'OPEN');
  // The base changed the PR's own file; the conflict resolved another way changes the PR's own change: review.
  const conflict = lowPr({ checks: 'pending' });
  conflict.publish();
  const c = baseMerged(conflict, 'src/Basket.API/A.cs', 'the base\'s version');
  assert.ok(c.conflicted);
  fs.writeFileSync(path.join(conflict.root, 'src/Basket.API/A.cs'), 'resolved another way');
  g(conflict.root, 'commit', '-qam', 'Merge main into this branch (keep the PR mergeable)');
  head(conflict, { before: c.before, commits: [{ sha: git(conflict.root, 'rev-parse', 'HEAD'), parents: [{}, {}], commit: { message: 'Merge main into this branch (keep the PR mergeable)' } }] });
  sync(conflict);
  assert.equal(conflict.pr.state, 'OPEN');
  assert.match(parseState(conflict.pr.comments.find((x) => x.body.includes('review-gate:')).body).triggers.join('; '), /rating is for another change/);
});

test('board sync merges a waiting PR once its checks pass; failing checks send it to review', () => {
  const w = lowPr({ checks: 'pending' });
  assert.equal(w.publish().decision.action, 'wait');
  const deps = { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null };
  assert.deepEqual(syncGate(w.config, deps).regated, [w.pr.url]);
  assert.equal(w.gh.merges.length, 0, 'still pending');
  w.pr.checks = [{ name: 'ci', bucket: 'pass' }];
  syncGate(w.config, deps);
  assert.equal(w.gh.merges.length, 1);
  assert.ok(w.pr.labels.includes('auto-merged'));

  const f = lowPr({ checks: 'pending' });
  f.publish();
  f.pr.checks = [{ name: 'ci', bucket: 'fail' }];
  syncGate(f.config, { gh: f.gh.gh, items: [], metricsConfig: f.config, markerOf: () => null });
  assert.equal(f.gh.merges.length, 0);
  assert.deepEqual(f.pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.match(f.pr.comments[0].body, /checks are failing/);
});

test('a push to a waiting PR before its checks pass sends it to review instead of merging', () => {
  const w = lowPr({ checks: 'pending' });
  w.publish();
  w.pr.headRefOid = 'pushed-by-someone';
  w.pr.checks = [{ name: 'ci', bucket: 'pass' }];
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  assert.equal(w.gh.merges.length, 0);
  assert.match(w.pr.comments[0].body, /changed after it was assessed/);
});

// Council C2: #49's notice said "Merged with gh pr merge --auto" nine minutes before GitHub merged it, and notices
// kept "CI: pending" after CI finished.
// Council C9: GitHub's own auto-merge, once armed, merges a later head as soon as the required checks pass. It is used only
// with implement.autoMerge.native; by default a PR GitHub has not cleared yet waits, nothing is armed, and the next sync
// checks the head again before merging.
test('by default nothing arms GitHub auto-merge: a PR GitHub has not cleared yet waits for the next sync', () => {
  const w = lowPr();
  w.pr.mergeStateStatus = 'BLOCKED';
  assert.equal(w.publish().decision.action, 'wait');
  assert.equal(w.gh.calls.some((c) => c.args.includes('--auto')), false);
  assert.match(w.pr.comments[0].body, /GitHub has not cleared the merge yet \(`BLOCKED`\)\. GitHub's own auto-merge is not armed/);
});

test('every merge names the head the gate assessed', () => {
  const w = lowPr();
  w.publish();
  const merge = w.gh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.equal(merge.args[merge.args.indexOf('--match-head-commit') + 1], w.pr.headRefOid);
});

test('the auto-merge notice says auto-merge is enabled until the merge happens, then says when it merged', () => {
  const w = lowPr({ autoMerge: { enabled: true, hostAutoMerge: { enabled: true } } });
  w.pr.mergeStateStatus = 'BLOCKED';
  w.publish();
  assert.match(w.pr.comments[0].body, /Auto-merge is enabled \(`gh pr merge --auto`\): GitHub merges the PR once its required checks pass/);
  assert.doesNotMatch(w.pr.comments[0].body, /\bMerged\b/);
  assert.equal(parseState(w.pr.comments[0].body).merge.merged, false);
  Object.assign(w.pr, { state: 'MERGED', mergedAt: '2026-11-01T11:00:00Z', closedAt: '2026-11-01T11:00:00Z' });
  syncGate(w.config, { gh: w.gh.gh, items: [], metricsConfig: w.config, markerOf: () => null });
  assert.match(w.pr.comments[0].body, /Merged at 2026-11-01T11:00:00Z \(`gh pr merge`, squash\)/);
  assert.equal(parseState(w.pr.comments[0].body).merge.merged, true);
});

test('a PR in review gets its notice written again when its checks finish, keeping the recorded signals', () => {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(8, { labels: [], checks: [{ name: 'ci', bucket: 'pending' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, {});
  const high = { impact: 'High', complexity: 'High', fixRisk: 'High' };
  assert.equal(publishGate(config, { pr: pr.url, keys: ['BUG-3'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': high }).runAgent }).decision.action, 'review');
  const before = pr.comments[0].body;
  assert.match(before, /checks: pending/);
  const signalsOf = (body) => parseState(body).tickets[0].signals;
  assert.ok(signalsOf(before), 'the gate state records the ticket\'s signals');
  const confidenceLine = (body) => /- \*\*Confidence [^\n]*/.exec(body)[0].replace(/CI: [^;]*;/, '').replace(/Confidence \d+/, 'Confidence N');
  const scoreOf = (body) => Number(/- \*\*Confidence (\d+)/.exec(body)[1]);
  const deps = { gh: gh.gh, items: [], metricsConfig: config, markerOf: () => null };
  assert.deepEqual(syncGate(config, deps).regated, [], 'nothing changed: not written again');
  pr.checks = [{ name: 'ci', bucket: 'pass' }];
  assert.deepEqual(syncGate(config, deps).regated, [pr.url]);
  const after = pr.comments[0].body;
  assert.match(after, /checks: success/);
  // Council C9: the notice says which head the checks are for and when they were read, not only the first assessment's time.
  assert.match(after, /checks: success on head [0-9a-f]{7} \(read \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
  assert.equal(confidenceLine(after), confidenceLine(before), 'the rebuilt notice explains the same signals');
  // Council C7: the score is rebuilt with them; green CI earns its full share (it was half while pending).
  assert.ok(scoreOf(after) > scoreOf(before), `${scoreOf(after)} > ${scoreOf(before)}`);
  assert.doesNotMatch(after, /no record\)|no pair record\)/);
  assert.deepEqual(syncGate(config, deps).regated, [], 'written once per change');
});

// Dogfood C5: #69's notice said "checks: failure" on a green PR: the failing approval check counted as CI.
test('the gate\'s CI state leaves out its own approval check', async () => {
  const { checksState } = await import('../lib/github.mjs');
  const gh = (checks) => () => ({ status: 0, stdout: JSON.stringify(checks) });
  const workflows = () => ({ state: 'success', expected: [], missing: [], running: [], failing: [] });
  assert.equal(checksState(gh([{ name: 'test', bucket: 'pass' }, { name: 'review-quorum', bucket: 'fail' }]), 'a/b', 1, { workflows }), 'success');
  assert.equal(checksState(gh([{ name: 'test', bucket: 'fail' }, { name: 'review-quorum', bucket: 'fail' }]), 'a/b', 1, { workflows }), 'failure');
  assert.equal(checksState(gh([{ name: 'review-quorum', bucket: 'fail' }]), 'a/b', 1, { workflows }), null, 'nothing but the approval check: no CI state');
});
