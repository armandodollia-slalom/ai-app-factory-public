// Review gate, step 2: the decision (auto-merge, wait, review), the review notice, labels, reviewer
// requests and the review-quorum check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalsFor, decideGate, parseState, renderNotice, reviewersFor, gateState } from '../lib/gate.mjs';
import { publishGate, readCodeowners } from '../lib/publish.mjs';
import { quorum, requiredApprovals } from '../lib/quorum.mjs';
import { parseCodeowners } from '../lib/systems.mjs';
import { fakeGh } from './fake-gh.mjs';
import { SETTINGS, cacheTicket, cleanMetrics, fakeTriage, fixRepo, gateConfigFor, low, write, git } from './helpers.mjs';

const high = { score: 98, high: true, criteria: {}, reasons: [] };
const ticket = (key, level, extra = {}) => ({ key, issue: { number: Number(key.split('-')[1]) }, impact: level, complexity: 'Low', fixRisk: 'Low', severity: { level, explanation: `Impact ${level}, Fix risk Low → ${level}` }, confidence: high, reopens: [], rejectionChecked: true, systems: ['Basket.API'], paths: ['src/Basket.API/A.cs'], ...extra });
const assessment = (tickets, extra = {}) => ({ pr: 'https://github.com/acme/shop/pull/5', tickets, severity: { level: tickets.map((t) => t.severity.level).includes('Medium') ? 'Medium' : 'Low', explanation: 'max ticket severity' }, class: 'Low', systems: { names: ['Basket.API'] }, ci: 'success', headSha: 'h1', ...extra });
const on = { enabled: true, identity: 'gh-user' };

test('decide: Low, high confidence, no reopens and green checks auto-merge (only when switched on)', () => {
  const a = { ...assessment([ticket('BUG-3', 'Low'), ticket('BUG-9', 'Low')]), headSha: 'h1', deliveryChecked: 'h1' };
  assert.equal(decideGate(a, { settings: SETTINGS, autoMerge: on }).action, 'auto-merge');
  // Council C8: never before the delivery check (the retry check) ran on this head.
  const unchecked = decideGate({ ...a, deliveryChecked: null }, { settings: SETTINGS, autoMerge: on });
  assert.deepEqual([unchecked.action, unchecked.reasons[0]], ['wait', "waiting for the delivery check (no retried test) on the PR's head"]);
  assert.equal(decideGate({ ...a, deliveryChecked: 'h0' }, { settings: SETTINGS, autoMerge: on }).action, 'wait', 'a check of an older head does not count');
  const off = decideGate(a, { settings: SETTINGS, autoMerge: { enabled: false } });
  assert.equal(off.action, 'review');
  assert.equal(off.approvals, 1);
  assert.match(off.triggers[0], /auto-merge is switched off/);
  assert.equal(decideGate({ ...a, ci: 'pending' }, { settings: SETTINGS, autoMerge: on }).action, 'wait');
  assert.equal(decideGate({ ...a, ci: null }, { settings: SETTINGS, autoMerge: on }).action, 'wait');
});

test('decide: says exactly what triggered review and which tickets would have auto-merged', () => {
  const a = assessment([ticket('BUG-3', 'Low'), ticket('BUG-7', 'Medium', { systems: ['Identity.API'] }), ticket('BUG-9', 'Low')], { class: 'Medium' });
  const d = decideGate(a, { settings: SETTINGS, autoMerge: on });
  assert.equal(d.action, 'review');
  assert.equal(d.approvals, 1);
  assert.deepEqual(d.wouldAutoMerge, ['BUG-3', 'BUG-9']);
  assert.match(d.triggers.join(), /^BUG-7 is Medium \(Identity\.API;/);
  const notice = renderNotice(a, d, gateState(a, d));
  assert.match(notice, /BUG-3 and BUG-9 would have auto-merged/);
  assert.match(notice, /## Review gate: 1 approval required/);
  assert.equal(parseState(notice).required, true);
});

test('decide: low confidence, a human reopen, failing checks and PR-level severity each trigger review', () => {
  const lowConf = ticket('BUG-3', 'Low', { confidence: { score: 50, high: false, reasons: ['Feature verification first try unmet', 'CI pending'] } });
  assert.match(decideGate(assessment([lowConf]), { settings: SETTINGS, autoMerge: on }).triggers.join(), /BUG-3 has confidence 50 \(Feature verification first try unmet\)/);
  // Pending CI alone is not low confidence: the PR waits.
  const pending = ticket('BUG-3', 'Low', { confidence: { score: 90, high: false, reasons: ['CI pending'] } });
  assert.equal(decideGate(assessment([pending], { ci: 'pending' }), { settings: SETTINGS, autoMerge: on }).action, 'wait');
  const reopened = ticket('BUG-3', 'Low', { reopens: [{ at: 'x', source: 'card' }] });
  assert.match(decideGate(assessment([reopened]), { settings: SETTINGS, autoMerge: on }).triggers.join(), /BUG-3 has 1 human reopen/);
  assert.match(decideGate(assessment([ticket('BUG-3', 'Low')], { ci: 'failure' }), { settings: SETTINGS, autoMerge: on }).triggers.join(), /checks are failing/);
  const many = assessment([ticket('BUG-3', 'Low')], { severity: { level: 'Medium', explanation: 'max ticket severity Low, +1 for 3 systems → Medium', bumped: true }, class: 'Medium' });
  assert.match(decideGate(many, { settings: SETTINGS, autoMerge: on }).triggers.join(), /the PR is Medium: .*3 systems/);
  const unassessed = ticket('BUG-3', null, { severity: { level: null } });
  assert.match(decideGate(assessment([unassessed], { errors: ['no AGENT_RESULT line'] }), { settings: SETTINGS, autoMerge: on }).triggers.join(), /BUG-3 was not assessed \(no AGENT_RESULT line\)/);
});

test('decide: review is sticky once people were asked; a push while waiting sends the PR to review', () => {
  const a = assessment([ticket('BUG-3', 'Low')]);
  assert.equal(decideGate(a, { settings: SETTINGS, autoMerge: on, prior: { required: true, triggers: ['BUG-3 was Medium'] } }).action, 'review');
  const pushed = decideGate({ ...a, headSha: 'h2' }, { settings: SETTINGS, autoMerge: on, prior: { action: 'wait', headSha: 'h1' } });
  assert.equal(pushed.action, 'review');
  assert.match(pushed.triggers.join(), /changed after it was assessed/);
});

test('approvals: the policy table by class, then severity, then default; never below 1', () => {
  assert.equal(approvalsFor({ default: 1, High: 2, 'High+shared': 3 }, { cls: 'High+shared', severity: 'High' }), 3);
  assert.equal(approvalsFor({ default: 1, High: 2 }, { cls: 'High+shared', severity: 'High' }), 2);
  assert.equal(approvalsFor({ default: 2 }, { cls: 'Medium', severity: 'Medium' }), 2);
  assert.equal(approvalsFor({ Low: 0 }, { cls: 'Low', severity: 'Low' }), 1);
});

test('reviewers: the tickets\' assignees, else the CODEOWNERS of their files; never the author', () => {
  const a = assessment([ticket('BUG-3', 'Low'), ticket('BUG-7', 'Medium', { paths: ['src/Identity.API/P.cs'] })]);
  const codeowners = parseCodeowners('* @armando @landon\nsrc/Identity.API/ @sec\n');
  assert.deepEqual(reviewersFor(a, { assignees: { 'BUG-3': ['dana'], 'BUG-7': [] }, codeowners, author: 'pipeline-bot' }), ['dana', 'sec']);
  assert.deepEqual(reviewersFor(a, { assignees: {}, codeowners, author: 'armando' }), ['landon', 'sec']);
});

test('quorum: distinct approvals on the head commit reach approvals:N; stale, author and bot reviews do not count', () => {
  const r = (login, state, commit, at, type = 'User') => ({ user: { login, type }, state, commit_id: commit, submitted_at: at });
  assert.equal(requiredApprovals(['bug', 'approvals:2', 'approvals:1']), 2);
  assert.equal(requiredApprovals([{ name: 'x' }]), null);
  const reviews = [r('ann', 'APPROVED', 'old', '1'), r('bob', 'APPROVED', 'head', '2'), r('bob', 'COMMENTED', 'head', '3'), r('me', 'APPROVED', 'head', '4'), r('bot', 'APPROVED', 'head', '5', 'Bot')];
  const one = quorum({ labels: [{ name: 'approvals:1' }], reviews, author: 'me', headSha: 'head' });
  assert.equal(one.pass, true);
  assert.deepEqual(one.approvers, ['bob']);
  assert.deepEqual(one.stale, ['ann']);
  const two = quorum({ labels: ['approvals:2'], reviews, author: 'me', headSha: 'head' });
  assert.equal(two.pass, false);
  assert.match(two.summary, /1 of 2 required approval\(s\).*stale, from before the latest push: ann/);
  // A later "changes requested" replaces that reviewer's approval.
  assert.equal(quorum({ labels: ['approvals:1'], reviews: [...reviews, r('bob', 'CHANGES_REQUESTED', 'head', '6')], author: 'me', headSha: 'head' }).pass, false);
  assert.equal(quorum({ labels: ['approvals:0'], reviews: [], author: 'me', headSha: 'head' }).pass, true);
  assert.equal(quorum({ labels: [], reviews: [], author: 'me', headSha: 'head' }).pass, true);
});

test('publish: a PR that needs people gets approvals:N, needs-human, reviewers and one notice (edited in place)', () => {
  const root = fixRepo({ merges: [{ key: 'BUG-3', files: { 'src/Basket.API/A.cs': 'a' } }, { key: 'BUG-7', files: { 'src/Identity.API/B.cs': 'b' } }] });
  write(root, '.github/CODEOWNERS', '* @armando @landon\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'codeowners');
  cacheTicket(root, 'BUG-3', { number: 3 });
  cacheTicket(root, 'BUG-7', { number: 7 });
  cleanMetrics(root, ['BUG-3', 'BUG-7']);
  const gh = fakeGh();
  gh.addIssue(3, { assignees: ['dana'] });
  gh.addIssue(7);
  const pr = gh.addPr(5, { author: 'armando', labels: ['approvals:3'], checks: [{ name: 'ci', bucket: 'pass' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, { autoMerge: { enabled: true } });
  const agent = fakeTriage({ 'BUG-3': low, 'BUG-7': low });
  const r = publishGate(config, { pr: pr.url, keys: ['BUG-3', 'BUG-7'], base: 'main' }, { gh: gh.gh, runAgent: agent.runAgent });
  assert.equal(r.decision.action, 'review');
  assert.equal(r.assessment.tickets[1].severity.level, 'High');
  assert.deepEqual(pr.labels.sort(), ['approvals:1', 'needs-human']);
  assert.deepEqual(pr.reviewers, ['dana', 'landon']);
  assert.equal(pr.comments.length, 1);
  assert.match(pr.comments[0].body, /What triggered review:\*\* BUG-7 is High \(Identity\.API; .*floor High \(src\/Identity\.API\/\*\*\)/);
  assert.match(pr.comments[0].body, /BUG-3 would have auto-merged/);
  // A second run edits the same notice.
  publishGate(config, { pr: pr.url, keys: ['BUG-3', 'BUG-7'], base: 'main' }, { gh: gh.gh, runAgent: agent.runAgent });
  assert.equal(pr.comments.length, 1);
  assert.equal(parseState(pr.comments[0].body).required, true);
});

test('publish: a qualifying PR whose checks are still running waits, with no labels', () => {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(6, { checks: [{ name: 'ci', bucket: 'pending' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const r = publishGate(gateConfigFor(root, { autoMerge: { enabled: true } }), { pr: pr.url, keys: ['BUG-3'], base: 'main' }, { gh: gh.gh, runAgent: fakeTriage({ 'BUG-3': low }).runAgent });
  assert.equal(r.decision.action, 'wait');
  assert.deepEqual(pr.labels, ['approvals:0'], 'found again by board sync; nothing for review-quorum to enforce');
  assert.match(pr.comments[0].body, /waiting for the checks/);
  assert.equal(parseState(pr.comments[0].body).action, 'wait');
});

test('CODEOWNERS come from the PR\'s base branch, not the fix branch (which may predate the file)', () => {
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  // main gets CODEOWNERS after the fix branch was cut.
  git(root, 'checkout', '-q', 'main');
  write(root, '.github/CODEOWNERS', '* @landon @erin\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'codeowners');
  git(root, 'checkout', '-q', 'bugfix/epic/g1');
  assert.deepEqual(readCodeowners(root, 'main').map((r) => r.owners), [['landon', 'erin']]);
  assert.deepEqual(readCodeowners(root), [], 'the fix branch has none');
  assert.deepEqual(readCodeowners(root, 'no-such-ref'), [], 'an unknown base falls back to the working tree');
});

// Council C8: the pipeline's own files (test scenarios, plans, metrics) made a system named "Other" on every gated PR,
// which with two real services bumps a Low fix to Medium; the reference's gate ignores them.
test('the pipeline\'s own files touch no system', async () => {
  const { systemsTouched } = await import('../lib/systems.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../implement/config.json'), 'utf8'));
  const settings = { ignore: [...cfg.implement.reviewGate.ignore, 'tests/**', 'e2e/**'], systems: [{ name: 'catalog-api', paths: ['src/Catalog.API/**'] }, { name: 'webapp', paths: ['src/WebApp/**'] }] };
  // #154's own pipeline files, as they were in the PR.
  const files = ['.factory/metrics/run-conditions.jsonl.d/feat__bug-40.jsonl', '.factory/metrics/arch-history/2026-11/x.json', '.factory/plans/BUG-40-x/_index.md', '.factory/plans/BUG-40-x/state.json', '.factory/stack/scenarios/bug-40/scenario.yaml', 'e2e/teststack/bug-40.spec.ts', 'src/Catalog.API/Apis/CatalogApi.cs', 'src/WebApp/Components/Pages/Catalog/Catalog.razor'];
  assert.deepEqual(systemsTouched(files, settings).names, ['catalog-api', 'webapp']);
});

test('D2: pipeline publishGate (noAgent: true) with no saved assessment never runs an agent and publishes needs-human', async () => {
  const { readJsonl } = await import('../../pipeline/lib/util.mjs');
  const { loadGateState } = await import('../lib/publish.mjs');
  const path = await import('node:path');
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  const gh = fakeGh();
  gh.addIssue(3);
  const pr = gh.addPr(9, { checks: [{ name: 'ci', bucket: 'pass' }], headRefOid: git(root, 'rev-parse', 'HEAD') });
  const config = gateConfigFor(root, { autoMerge: { enabled: true } });
  let agentCalls = 0;
  const r = publishGate(
    config,
    { pr: pr.url, keys: ['BUG-3'], base: 'main', assessment: null, noAgent: true },
    { gh: gh.gh, runAgent: () => { agentCalls++; throw new Error('no agent may run after open'); } },
  );
  assert.equal(agentCalls, 0, 'publishGate with noAgent must never invoke runAgent');
  assert.equal(r.decision.action, 'review');
  assert.ok(r.decision.approvals >= 1);
  assert.ok(pr.labels.includes('needs-human'), `expected needs-human label, got ${JSON.stringify(pr.labels)}`);
  assert.match(pr.comments[0].body, /BUG-3 was not assessed \(no saved pre-open assessment/);
  const [decision] = readJsonl(path.join(root, '.factory/metrics/decisions.jsonl'));
  assert.equal(decision.decision, 'review');
  assert.match(decision.errors.join('; '), /no saved pre-open assessment/);
  assert.equal(loadGateState(config, pr.url).gate.action, 'review');
});

test('ADV-11 (D2): review-gate CLI parses --no-agent and publishes needs-human without invoking any agent when assessment is missing or unreadable', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'review-gate.mjs');
  const root = fixRepo({ files: { 'src/Basket.API/A.cs': 'a' } });
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  cacheTicket(root, 'BUG-3', { number: 3 });
  cleanMetrics(root, ['BUG-3']);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({
    board: { repo: 'acme/shop', projectNumber: 1 },
    tickets: { repo: 'acme/shop' },
    implement: { reviewGate: { enabled: true, autoMerge: { enabled: true } } },
  }));
  const head = git(root, 'rev-parse', 'HEAD');
  const binDir = path.join(root, '.fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghLog = path.join(root, 'gh.log');
  const fakeGhBin = path.join(binDir, 'gh');
  fs.writeFileSync(fakeGhBin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, a.join(' ') + '\\n');
// The comments posted are kept, so the publication is shown on the PR as on a real host.
const posted = ${JSON.stringify(ghLog)} + '.comments.json';
const comments = () => (fs.existsSync(posted) ? JSON.parse(fs.readFileSync(posted, 'utf8')) : []);
if (a[0] === 'pr' && a[1] === 'view') {
  if (a.includes('comments')) { process.stdout.write(JSON.stringify({ comments: comments().map((body, i) => ({ body, url: 'https://github.com/acme/shop/pull/9#issuecomment-' + (i + 1) })) })); process.exit(0); }
  if (a.includes('files')) { process.stdout.write(JSON.stringify({ files: [{ path: 'src/Basket.API/A.cs', additions: 1, deletions: 0, changeType: 'MODIFIED' }] })); process.exit(0); }
  process.stdout.write(JSON.stringify({ number: 9, url: 'https://github.com/acme/shop/pull/9', title: 'BUG-3', body: '', state: 'OPEN', isDraft: false, headRefName: 'feat/bug-3', baseRefName: 'main', headRefOid: ${JSON.stringify(head)}, author: { login: 'dev' }, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', mergedAt: null, closedAt: null }));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'checks') { process.stdout.write(JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass', link: '' }])); process.exit(0); }
if (a[0] === 'api' && /\\/issues\\/9\\/comments$/.test(a[1] || '')) { process.stdout.write(JSON.stringify([comments().map((body, i) => ({ id: i + 1, body, user: { login: 'dev' }, html_url: 'https://github.com/acme/shop/pull/9#issuecomment-' + (i + 1) }))])); process.exit(0); }
if (a[0] === 'api' && /\\/reviews$/.test(a[1] || '')) { process.stdout.write(''); process.exit(0); }
if (a[0] === 'api' && /\\/commits$/.test(a[1] || '')) { process.stdout.write(''); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'comment') { fs.writeFileSync(posted, JSON.stringify([...comments(), fs.readFileSync(0, 'utf8')])); process.stdout.write('https://github.com/acme/shop/pull/9#issuecomment-' + comments().length + '\\n'); process.exit(0); }
process.stdout.write('');
`);
  fs.chmodSync(fakeGhBin, 0o755);
  const badAssess = path.join(root, 'corrupt.json');
  fs.writeFileSync(badAssess, '{not-valid-json');
  const res = spawnSync(
    process.execPath,
    [cli, 'publish', '--pr', 'https://github.com/acme/shop/pull/9', '--tickets', 'BUG-3', '--base', 'main', '--no-agent', '--assessment', badAssess, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PIPELINE_ROOT: root, PATH: `${binDir}:${process.env.PATH}`, PIPELINE_AGENT_CMD: 'exit 99' },
    },
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stdout}\n${res.stderr}`);
  const out = JSON.parse(res.stdout.trim().split('\n').at(-1));
  assert.equal(out.action, 'review');
  assert.ok(out.approvals >= 1);
  assert.match(fs.readFileSync(ghLog, 'utf8'), /--add-label[^\n]*needs-human/);
});
