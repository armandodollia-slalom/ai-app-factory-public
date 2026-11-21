// The PR opens finished (owner requirement, dogfood C16; implement.preOpen). `implement run --pr` with scripted fake agents,
// a local origin and a fake gh that serves the GitHub host and GitHub Actions adapters: the CI runs of each head (the story
// branch's push runs before the PR, the PR's own runs after), the PR, its checks and its draft state.
//
// Scenarios:
// - red-first: the branch's first pushed head is red; the CI fixing round works against the branch runs; the PR opens
//   once, ready, after every expected pipeline is green on its head; nothing agentic after it is ready.
// - pr-only-fails: the branch is green, but a workflow only a PR runs fails after the open: the PR goes back to draft,
//   the fixing round runs while it is a draft, and it is marked ready again when the checks are green.
// - never-green: the branch never turns green: no PR at all, the branch is pushed and the run ends not delivered.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { agentRunsAfterReady, headActivities, holdMode, holdPr, recordHeadActivity, releasePr } from '../lib/pre-open.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts/pipeline/test/fixtures/fake-agent.mjs');
let tmp;

const sh = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const editJson = (file, fn) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(j);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
};

const rows = [{ ref: 'Rule: a valid coupon gives 10% off', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }, { ref: 'Rule: an expired coupon is rejected with 400', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }];
const clean = (lens) => ({ result: { lens, score: 10, summary: 'ok', coverage: lens === 'acceptance' ? rows : [], findings: [], sideEffects: [] } });
const SCRIPT = {
  implementer: [{ writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } }],
  'architecture-reviewer': [{ result: { verdict: 'APPROVED', summary: 'ok', findings: [] } }],
  'test-planner': [{ writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }] }],
  'test-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
  'test-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
  'test-automation-verifier': [{ result: { score: 10, gaps: [] } }],
  'pr-check-acceptance': [clean('acceptance')],
  'pr-check-flow': [clean('flow')],
  'pr-check-style': [clean('style')],
  'pr-check-video': [clean('video')],
  'pr-check-design': [clean('design')],
  'pr-check-defender': [{ result: { responses: [] } }],
  'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
  'pr-check-fixer': [{ writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'the CI failure fixed' } }],
};

// Two workflows: the gate runs on a push of a story branch and on the PR; `pr-only` runs only on the PR.
const WORKFLOWS = {
  '.github/workflows/factory-gate.yml': 'name: AI app factory\non:\n  pull_request:\n  push:\n    branches: ["feat/**"]\njobs:\n  pipeline:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',
  '.github/workflows/pr-only.yml': 'name: pr-only\non: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',
};

// The fake gh: answers the calls of the GitHub host and GitHub Actions adapters from a state file.
const FAKE_GH = (stateFile, logFile, origin) => `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const a = process.argv.slice(2);
const S = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(S));
fs.appendFileSync(${JSON.stringify(logFile)}, new Date().toISOString() + ' ' + a.join(' ').slice(0, 220) + '\\n');
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const branchHead = (b) => { try { return execFileSync('git', ['--git-dir', ${JSON.stringify(origin)}, 'rev-parse', 'refs/heads/' + b], { encoding: 'utf8' }).trim(); } catch { return null; } };
const WF = ${JSON.stringify(WORKFLOWS)};
const arg = (f) => a[a.indexOf(f) + 1];
const sc = S.scenario;
// The runs of one head: push runs of the gate, and (once the PR exists) the PR's runs of both workflows.
function runsOf(head) {
  S.heads = S.heads ?? [];
  if (!S.heads.includes(head)) S.heads.push(head);
  const n = S.heads.indexOf(head);
  const runs = [];
  const pushOk = sc === 'never-green' ? false : sc === 'red-first' ? n > 0 : true;
  // base-moves: another PR merges into main while the first head's CI runs.
  if (sc === 'base-moves' && !S.baseMoved) {
    const g = (args) => execFileSync('git', ['--git-dir', ${JSON.stringify(origin)}, ...args], { encoding: 'utf8' }).trim();
    const c = g(['commit-tree', 'refs/heads/main^{tree}', '-p', 'refs/heads/main', '-m', 'another PR merged']);
    g(['update-ref', 'refs/heads/main', c]);
    S.baseMoved = c;
  }
  runs.push({ id: 100 + n, path: '.github/workflows/factory-gate.yml', name: 'AI app factory', status: 'completed', conclusion: pushOk ? 'success' : 'failure', event: 'push' });
  if (S.pr) {
    runs.push({ id: 300 + n, path: '.github/workflows/factory-gate.yml', name: 'AI app factory', status: 'completed', conclusion: 'success', event: 'pull_request' });
    // pr-only fails on every head until the PR has been held once and a later head is pushed.
    const prOnlyOk = sc !== 'pr-only-fails' || (S.held && n > (S.heldAtHead ?? 0));
    runs.push({ id: 500 + n, path: '.github/workflows/pr-only.yml', name: 'pr-only', status: 'completed', conclusion: prOnlyOk ? 'success' : 'failure', event: 'pull_request' });
  }
  save();
  return runs;
}
const pr = () => S.pr;
if (a[0] === 'api' && a[1] === 'user') return out({ login: 'tester', id: 1 });
if (a[0] === 'api' && /\\/contents\\/\\.github\\/workflows\\?ref=/.test(a[1])) return out(Object.keys(WF).join('\\n'));
if (a[0] === 'api' && /\\/contents\\/\\.github\\/workflows\\/[^?]+\\?ref=/.test(a[1])) { const p = a[1].replace(/^repos\\/[^/]+\\/[^/]+\\/contents\\//, '').replace(/\\?ref=.*$/, ''); return out(Buffer.from(WF[p] ?? '').toString('base64')); }
if (a[0] === 'api' && /\\/contents\\//.test(a[1])) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
if (a[0] === 'api' && /\\/actions\\/runs\\?head_sha=/.test(a[1])) { const head = /head_sha=([0-9a-f]+)/.exec(a[1])[1]; return out(runsOf(head)); }
if (a[0] === 'run' && a[1] === 'list') { const head = a.includes('--commit') ? arg('--commit') : branchHead(arg('--branch')); return out(runsOf(head).map((r) => ({ databaseId: r.id, conclusion: r.conclusion, name: r.name, headSha: head, status: r.status, event: r.event, workflowName: r.name, url: '' }))); }
if (a[0] === 'run' && a[1] === 'view') return out(a.includes('--log-failed') ? 'pipeline\\tstep\\t2026 FAIL the check failed\\n' : 'all good\\n');
if (a[0] === 'pr' && a[1] === 'create') {
  // refuse-open: the host refuses the PR's text (the recorded C21 403) until the test lifts it.
  if (S.refuseOpen) { S.refusals = (S.refusals ?? 0) + 1; save(); process.stderr.write('pull request create failed: HTTP 403: 403 Forbidden (https://api.github.com/graphql)'); process.exit(1); }
  S.pr = { number: 1, draft: a.includes('--draft'), head: arg('--head'), body: arg('--body'), createdAt: new Date().toISOString(), openedHead: branchHead(arg('--head')) };
  S.events = [...(S.events ?? []), { at: S.pr.createdAt, what: S.pr.draft ? 'opened-draft' : 'opened-ready' }];
  save();
  fs.writeFileSync(${JSON.stringify(path.join(path.dirname(stateFile), 'pr-body.md'))}, S.pr.body);
  return out('https://github.com/acme/shop/pull/1\\n');
}
if (a[0] === 'pr' && a[1] === 'list') return out(pr() ? [{ url: 'https://github.com/acme/shop/pull/1', number: 1, headRefName: pr().head }] : []);
if (a[0] === 'pr' && a[1] === 'ready') {
  const undo = a.includes('--undo');
  S.pr.draft = undo;
  if (undo) { S.held = true; S.heldAtHead = (S.heads ?? []).indexOf(branchHead(S.pr.head)); }
  S.events = [...(S.events ?? []), { at: new Date().toISOString(), what: undo ? 'draft' : 'ready' }];
  save();
  return out('');
}
if (a[0] === 'pr' && a[1] === 'checks') { const head = branchHead(pr().head); return out(runsOf(head).filter((r) => r.event === 'pull_request').map((r) => ({ name: r.name, state: r.conclusion === 'success' ? 'SUCCESS' : 'FAILURE', bucket: r.conclusion === 'success' ? 'pass' : 'fail', link: '' }))); }
if (a[0] === 'pr' && a[1] === 'view') {
  if (!pr()) { process.stderr.write('no pull requests found'); process.exit(1); }
  const head = branchHead(pr().head);
  if (a.includes('files') && a[a.indexOf('--json') + 1] === 'files') return out({ files: [{ path: 'src/Basket/Coupons.cs', additions: 1, deletions: 0, changeType: 'MODIFIED' }] });
  return out({ number: 1, url: 'https://github.com/acme/shop/pull/1', title: 'DEMO-1', body: pr().body, state: 'OPEN', isDraft: pr().draft, headRefName: pr().head, baseRefName: 'main', headRefOid: head, author: { login: 'tester' }, labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, createdAt: pr().createdAt, updatedAt: pr().createdAt, mergedAt: null, closedAt: null, files: [{ path: 'src/Basket/Coupons.cs' }] });
}
if (a[0] === 'pr' && a[1] === 'comment') return out('https://github.com/acme/shop/pull/1#issuecomment-1\\n');
out('');
`;

function setup(name, scenario, { type = 'story', state = {} } = {}) {
  const root = path.join(tmp, name);
  const repo = path.join(root, 'shop');
  const origin = path.join(root, 'origin.git');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo, { recursive: true });
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/feature-verification', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video', 'scripts/review-gate', 'scripts/retro', 'scripts/factory', 'scripts/stack', 'scripts/teststack'].filter((d) => fs.existsSync(path.join(source, d)))) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  // As an install has it: the CI adapters read the workflow definitions with the yaml package.
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  editJson(path.join(repo, 'scripts/feature-verification/config.json'), (j) => (j.precheck.runTests = false));
  editJson(path.join(repo, 'scripts/pipeline/config.json'), (j) => (j.implExclude = ['.factory', 'graphify-out', 'e2e']));
  editJson(path.join(repo, 'scripts/implement/config.json'), (j) => {
    Object.assign(j.implement, { fvPollSec: 0.2, parallel: 1, orchestrate: false, ciParity: false, prCheckWaitSec: 1, ciPollSec: 0.2, ciSettleSec: 0.3, ciWaitSec: 120 });
  });
  editJson(path.join(repo, 'scripts/pr-check/config.json'), (j) => Object.assign(j.prCheck.hook, { enabled: true, pollSec: 0.2 }));
  write(repo, '.factory/config.json', JSON.stringify({ host: { type: 'github', repo: 'acme/shop' } }, null, 2));
  write(repo, '.gitignore', '.factory/state/\nnode_modules\n');
  write(repo, 'src/Basket/Coupons.cs', '// coupons\n');
  for (const [p, text] of Object.entries(WORKFLOWS)) write(repo, p, text);
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', type, text: '# DEMO-1 Apply coupon\n\nRule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n' });
  sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'fv@example.com']);
  sh(repo, 'git', ['config', 'user.name', 'Pre-open Test']);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);
  sh(repo, 'git', ['remote', 'add', 'origin', origin]);
  sh(repo, 'git', ['push', '-q', 'origin', 'main']);
  fs.mkdirSync(bin, { recursive: true });
  const stateFile = path.join(root, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ scenario, ...state }));
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH(stateFile, path.join(root, 'gh.log'), origin), { mode: 0o755 });
  return { root, repo, bin, stateFile };
}

function implement(ctx, { args = ['implement', 'run', 'DEMO-1', '--pr'], extraEnv = {} } = {}) {
  const scriptFile = path.join(ctx.root, 'agent.json');
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const env = { ...process.env, PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', PIPELINE_CEILING_FACTOR: '600', PIPELINE_SUPERVISOR_POLL_MS: '200', ...extraEnv };
  for (const k of ['PIPELINE_CHILD', 'PIPELINE_DISABLE', 'PIPELINE_ROOT', 'PIPELINE_BOARD']) delete env[k];
  const r = spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', ...args], { cwd: ctx.repo, encoding: 'utf8', env, timeout: 1_800_000 });
  const wt = path.join(ctx.root, 'shop-worktrees', 'demo-1');
  const metrics = path.join(wt, '.factory', 'metrics');
  const read = (stream) => (fs.existsSync(metrics) ? fs.readdirSync(metrics).filter((f) => f.startsWith(stream)) : []).flatMap((f) => {
    const p = path.join(metrics, f);
    const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((x) => path.join(p, x)) : [p];
    return files.flatMap((x) => fs.readFileSync(x, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  });
  const record = JSON.parse(fs.readFileSync(path.join(ctx.repo, '.factory/state/implement/DEMO-1.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
  const log = fs.existsSync(path.join(ctx.root, 'gh.log')) ? fs.readFileSync(path.join(ctx.root, 'gh.log'), 'utf8') : '';
  const logs = path.join(ctx.repo, '.factory/state/logs');
  const implLog = (fs.existsSync(logs) ? fs.readdirSync(logs).filter((f) => f.startsWith('implement-DEMO-1')) : []).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n');
  return { ...r, record, state, log, implLog, usage: read('token-usage'), conditions: read('run-conditions'), body: state.pr?.body ?? null };
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-open-')));
});
after(() => (process.env.PRE_OPEN_KEEP ? console.log(`kept ${tmp}`) : fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));

test('red branch CI is fixed on the branch before the PR exists; the PR opens once, ready, finished, and no agent starts after it is ready', { timeout: 3_600_000 }, () => {
  const r = implement(setup('red-first', 'red-first'));
  assert.match(r.stdout, /DEMO-1 +done +feat\/demo-1-apply-coupon/, `${r.stdout}\n${r.stderr}`);
  // Order: the branch's push runs were read, the fixing round ran, and only then was the PR created, once and ready.
  const lines = r.log.split('\n');
  const created = lines.findIndex((l) => / pr create /.test(l));
  assert.ok(created > 0, r.log);
  assert.equal(lines.filter((l) => / pr create /.test(l)).length, 1, 'one PR');
  assert.ok(lines.slice(0, created).some((l) => /actions\/runs\?head_sha=/.test(l)), 'the branch CI was read before the PR');
  assert.ok(r.usage.some((u) => u.agent === 'pr-check-fixer'), 'the CI fixing round ran');
  assert.ok(r.state.heads.length >= 2, 'a new head was pushed by the fixing round');
  assert.equal(r.state.events[0].what, 'opened-ready');
  // The body says the CI was proven on the branch, and nothing is left to add later.
  assert.match(r.body, /CI before this PR: every pipeline a push of `feat\/demo-1-apply-coupon` runs passed on [0-9a-f]{7} \(AI app factory\), after 1 CI fixing round\(s\) on the branch; .*Only on the PR: pr-only\./);
  assert.doesNotMatch(r.body, /added below by the PR demo video workflow/);
  // The PR opened on exactly the head whose push runs were read green: no records commit or base merge after the proof.
  const opened = r.state.pr.openedHead;
  assert.ok(lines.slice(0, created).some((l) => l.includes(`head_sha=${opened}`)), `the opened head ${opened} was proven before the PR:\n${r.log}`);
  assert.equal(/passed on ([0-9a-f]{7})/.exec(r.body)?.[1], opened.slice(0, 7), 'the body names the head the PR opened on');
  // The audit: nothing agentic started after the PR was ready.
  assert.ok(r.record.readyAt, 'ready time recorded');
  const result = JSON.parse(fs.readFileSync(path.join(path.dirname(r.record.worktree ?? ''), '..', 'shop', '.factory/state/implement/DEMO-1.result.json'), 'utf8'));
  assert.ok(result.firstPushAt && result.greenAt && result.openedAt && result.firstPushAt <= result.greenAt && result.greenAt <= result.openedAt, `push, green and open times in the result: ${JSON.stringify(result)}`);
  // The result names the head the PR opened on, not the commit the body was first written on (council C11, Sol 3).
  assert.equal(result.finalSha, opened, 'finalSha is the delivered head');
  assert.deepEqual([r.record.readyAudit.ok, r.record.readyAudit.after], [true, 0], 'the run record says no agent ran after ready');
  assert.deepEqual(agentRunsAfterReady(r.usage, { key: 'DEMO-1', readyAt: r.record.readyAt, holds: r.record.holds }), []);
  assert.equal(r.record.holds.length, 0);
});

test('the base moves while the branch CI runs: the latest base is merged before the open and that head is proven again; the PR opens on it', { timeout: 3_600_000 }, () => {
  const r = implement(setup('base-moves', 'base-moves'));
  assert.match(r.stdout, /DEMO-1 +done/, `${r.stdout}\n${r.stderr}`);
  const lines = r.log.split('\n');
  const created = lines.findIndex((l) => / pr create /.test(l));
  const opened = r.state.pr.openedHead;
  assert.ok(r.state.baseMoved, 'the base moved during the branch CI');
  assert.ok(r.state.heads.length >= 2 && r.state.heads.includes(opened) && r.state.heads[0] !== opened, 'the PR opened on a later head than the first one proven');
  assert.ok(lines.slice(0, created).some((l) => l.includes(`head_sha=${opened}`)), 'that head was proven before the PR');
  assert.match(r.implLog, /the head moved from [0-9a-f]{7} to [0-9a-f]{7} after CI proved it/);
  assert.equal(/passed on ([0-9a-f]{7})/.exec(r.body)?.[1], opened.slice(0, 7));
});

test('a check only the PR runs fails after the open: the PR goes back to draft, the fix happens while it is a draft, and it is ready again when green', { timeout: 3_600_000 }, () => {
  const r = implement(setup('pr-only-fails', 'pr-only-fails'));
  assert.match(r.stdout, /DEMO-1 +done +feat\/demo-1-apply-coupon/, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(r.state.events.map((e) => e.what), ['opened-ready', 'draft', 'ready']);
  assert.equal(r.record.holds.length, 1);
  assert.equal(r.record.holds[0].mode, 'draft');
  assert.ok(r.record.holds[0].from && r.record.holds[0].to);
  // The fixing round ran inside the hold; the audit holds with it, and would fail without the hold window.
  const fixer = r.usage.filter((u) => u.agent === 'pr-check-fixer');
  assert.ok(fixer.length > 0);
  assert.deepEqual(agentRunsAfterReady(r.usage, { key: 'DEMO-1', readyAt: r.record.readyAt, holds: r.record.holds }), []);
  assert.ok(agentRunsAfterReady(r.usage, { key: 'DEMO-1', readyAt: r.record.readyAt, holds: [] }).length > 0, 'without the hold the fixer would be an agent after ready');
  assert.deepEqual([r.record.readyAudit.ok, r.record.readyAudit.after], [true, 0], 'the run record says no agent ran after ready');
});

test('CI never turns green on the branch: no PR at all, the branch is pushed, the run is not delivered', { timeout: 3_600_000 }, () => {
  const r = implement(setup('never-green', 'never-green'));
  assert.doesNotMatch(r.log, / pr create /, 'no PR');
  assert.match(r.stdout, /DEMO-1 +ci-red/, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.record.pr ?? null, null);
});

// ---- units ------------------------------------------------------------------------------------------------------------

test('the audit: an agent run that started after ready counts unless the PR was on hold then', () => {
  const rows = [
    { story: 'K-1', run_id: 'a', agent: 'implementer', ts: '2026-11-18T10:00:00Z', seconds: 60 },
    { story: 'K-1', run_id: 'b', agent: 'pr-check-fixer', ts: '2026-11-18T12:10:00Z', seconds: 60 },
    { story: 'K-1', run_id: 'c', agent: 'bug-triage', ts: '2026-11-18T13:10:00Z', seconds: 60 },
    { story: 'K-2', run_id: 'd', agent: 'implementer', ts: '2026-11-18T13:10:00Z', seconds: 60 },
  ];
  const readyAt = '2026-11-18T11:00:00Z';
  assert.deepEqual(agentRunsAfterReady(rows, { key: 'K-1', readyAt }).map((x) => x.agent), ['pr-check-fixer', 'bug-triage']);
  assert.deepEqual(agentRunsAfterReady(rows, { key: 'K-1', readyAt, holds: [{ from: '2026-11-18T12:00:00Z', to: '2026-11-18T12:30:00Z' }] }).map((x) => x.agent), ['bug-triage']);
});

test('holding a PR follows the host: draft where it has drafts, the work-in-progress label where it has only labels, close and reopen otherwise', () => {
  const calls = [];
  const host = (capabilities) => ({ capabilities, pr: { cancelAutoMerge: () => calls.push('disarm'), update: (_pr, c) => calls.push(JSON.stringify(c)), comment: () => calls.push('comment') }, repo: { ensureLabel: () => calls.push('label-exists') } });
  assert.equal(holdMode(host({ drafts: true, labels: true }), 'draft'), 'draft');
  assert.equal(holdMode(host({ drafts: false, labels: true }), 'draft'), 'label');
  assert.equal(holdMode(host({ drafts: false, labels: false }), 'draft'), 'close-reopen');
  const h = holdPr(host({ drafts: false, labels: true, cancelAutoMerge: true }), 7, { mode: 'draft', why: 'x' });
  assert.equal(h.mode, 'label');
  assert.deepEqual(calls.slice(0, 3), ['disarm', 'label-exists', '{"labels":{"add":["work-in-progress"]}}']);
  calls.length = 0;
  releasePr(host({ drafts: false, labels: true }), 7, { mode: 'label', label: 'work-in-progress' });
  assert.deepEqual(calls, ['{"labels":{"remove":["work-in-progress"]}}']);
});

test('the head ledger: a head the pipeline did not push is a synchronize; an unknown PR has no ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const config = { root, stateDir: '.factory/state' };
  assert.equal(headActivities(config, 'https://github.com/a/b/pull/3', 'h1'), null);
  recordHeadActivity(config, 'https://github.com/a/b/pull/3', 'h1', 'opened');
  recordHeadActivity(config, 'https://github.com/a/b/pull/3', 'h1', 'labeled');
  assert.deepEqual(headActivities(config, 'https://github.com/a/b/pull/3', 'h1'), ['opened', 'labeled']);
  assert.deepEqual(headActivities(config, 'https://github.com/a/b/pull/3', 'h2'), ['synchronize']);
});

test('the body line for the gate assessment made before the PR reads the ratings where review-gate assess puts them', async () => {
  const { assessedLine } = await import('../lib/implement.mjs');
  const a = { severity: { level: 'Low' }, tickets: [{ key: 'BUG-1', impact: 'Low', fixRisk: 'Medium', confidence: { score: 82 } }] };
  assert.equal(assessedLine(a), '- Review gate, assessed before this PR opened: severity Low (BUG-1: impact Low, fix risk Medium, confidence 82)');
});

test('a run that stops right after its PR opened is resumed after the open (the runner\'s retry): the PR is adopted, never opened again, and no agent runs', { timeout: 3_600_000 }, () => {
  const ctx = setup('stop-after-open', 'green');
  const r = implement(ctx, { extraEnv: { PIPELINE_TEST_DIE_AT: 'after-pr-open' } });
  assert.match(`${r.stdout}\n${r.stderr}`, /worker exited 137[^\n]*retrying \(1\/\d\)/);
  assert.match(r.stdout, /DEMO-1 +done/);
  assert.equal(r.log.split('\n').filter((l) => / pr create /.test(l)).length, 1, 'one PR');
  const logs = path.join(ctx.repo, '.factory/state/logs');
  const attempts = fs.readdirSync(logs).filter((f) => f.startsWith('implement-DEMO-1')).sort();
  assert.equal(attempts.length, 2);
  const retry = fs.readFileSync(path.join(logs, attempts[1]), 'utf8');
  assert.match(retry, /was opened by the earlier run before it stopped; continuing after the open/);
  assert.doesNotMatch(retry, /agent \S+ \(/, 'no agent started on the retry');
  assert.equal(r.record.phase, null);
  assert.deepEqual([r.record.readyAudit.ok, r.record.readyAudit.after], [true, 0]);
  assert.equal(r.state.events.filter((e) => /^opened/.test(e.what)).length, 1);
});

// Held-out C22 (council C12, Sol 2): planning and the worker's start cleared the run record's outcome and reason before the
// story read them, so a resume of a refused open took the general route and reset the first push time. Through the real
// entry points: a run whose open the host refuses even when shortest, then `implement resume`.
test('a refused open, then `implement resume`: the open-pending route is taken, the first push time is kept, and no agent starts', { timeout: 3_600_000 }, () => {
  const ctx = setup('refused-open', 'green', { type: 'bug', state: { refuseOpen: true } });
  const first = implement(ctx);
  assert.match(first.stdout, /DEMO-1 +pr-refused/, `${first.stdout}\n${first.stderr}`);
  assert.ok(first.state.refusals > 1, 'the reduction was tried');
  assert.equal(first.state.pr, undefined);
  assert.deepEqual([first.record.outcome, first.record.phase, Boolean(first.record.greenAt)], ['pr-refused', 'pre-open', true]);
  const firstPushAt = first.record.firstPushAt;
  assert.ok(firstPushAt);
  // (The review gate is off in this fixture: no board. Reusing the gate's rating on the resumed open is proven on the same
  // call by 'a resumed delivery opens with no agent' in host-refusal.test.mjs.)
  const agentRows = first.usage.length;
  // The host takes the text now.
  const st = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
  fs.writeFileSync(ctx.stateFile, JSON.stringify({ ...st, refuseOpen: false }));
  const second = implement(ctx, { args: ['implement', 'resume', '--pr'] });
  assert.match(second.stdout, /DEMO-1 +done/, `${second.stdout}\n${second.stderr}`);
  const logs = path.join(ctx.repo, '.factory/state/logs');
  const attempts = fs.readdirSync(logs).filter((f) => f.startsWith('implement-DEMO-1')).sort();
  const resumed = fs.readFileSync(path.join(logs, attempts.at(-1)), 'utf8');
  assert.match(resumed, /resuming the delivery of feat\/demo-1-apply-coupon: the PR did not open earlier[\s\S]*no agent runs, the PR opens on the CI-proven head/, resumed);
  assert.doesNotMatch(resumed, /restarting feature verification|agent \S+ \(/, 'the general route and agents were not taken');
  assert.equal(second.usage.length, agentRows, 'no agent run on the resume');
  assert.equal(second.log.split('\n').filter((l) => / pr create /.test(l)).length, first.state.refusals + 1, 'one accepted open');
  const result = JSON.parse(fs.readFileSync(path.join(ctx.repo, '.factory/state/implement/DEMO-1.result.json'), 'utf8'));
  assert.equal(result.firstPushAt, firstPushAt, 'the first push time is kept');
  assert.equal(result.resumedAt, 'open-pending');
  assert.equal(second.record.pr, 'https://github.com/acme/shop/pull/1');
  assert.deepEqual([second.record.readyAudit.ok, second.record.readyAudit.after], [true, 0]);
});
