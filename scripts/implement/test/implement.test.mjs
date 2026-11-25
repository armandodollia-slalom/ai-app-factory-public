// End-to-end run of `pipeline implement` in a throwaway git repo, with the scripted fake agent CLI
// standing in for the implementer, the reviewer and the feature verification agents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CACHE, seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts/pipeline/test/fixtures/fake-agent.mjs');
let tmp;
let repo;
let incoming;
let scriptFile;

const sh = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const calls = () => JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
const prompts = () => fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');

function pipeline(args, extraEnv = {}) {
  const env = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main', ...extraEnv };
  for (const k of ['PIPELINE_CHILD', 'PIPELINE_DISABLE', 'PIPELINE_ROOT']) delete env[k];
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', ...args], { cwd: repo, encoding: 'utf8', env });
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'implement-e2e-')));
  repo = path.join(tmp, 'shop');
  scriptFile = path.join(tmp, 'agent.json');
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/feature-verification', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video', 'scripts/review-gate', 'scripts/retro', 'scripts/factory', 'scripts/stack', 'scripts/teststack'].filter((d) => fs.existsSync(path.join(source, d)))) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  // Every section's defaults and descriptions: a stage reads the others' (scripts/pipeline/lib/settings.mjs).
  for (const d of fs.readdirSync(path.join(source, 'scripts'))) for (const f of ['config.json', 'settings.json']) if (fs.existsSync(path.join(source, 'scripts', d, f)) && !fs.existsSync(path.join(repo, 'scripts', d, f))) {
    fs.mkdirSync(path.join(repo, 'scripts', d), { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts', d, f), path.join(repo, 'scripts', d, f));
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  // The clean-code skill the writers' and orchestrators' prompts are built from (it includes the council skill's lists).
  for (const skill of ['clean-code', 'council']) fs.cpSync(path.join(source, 'skills', skill), path.join(repo, 'skills', skill), { recursive: true });
  const fvConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/feature-verification/config.json'), 'utf8'));
  fvConfig.featureVerification.precheck.runTests = false;
  write(repo, 'scripts/feature-verification/config.json', JSON.stringify(fvConfig, null, 2));
  const implConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/implement/config.json'), 'utf8'));
  implConfig.implement.pollSec.featureVerification = 0.1;
  implConfig.implement.maxParallel = 1; // the scripted agent answers in call order: one story at a time
  write(repo, 'scripts/implement/config.json', JSON.stringify(implConfig, null, 2));
  const prCheckConfig = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/pr-check/config.json'), 'utf8'));
  prCheckConfig.prCheck.hook.enabled = false;
  write(repo, 'scripts/pr-check/config.json', JSON.stringify(prCheckConfig, null, 2));
  write(repo, '.gitignore', '.factory/state/\n');
  write(repo, 'src/Basket/Coupons.cs', '// coupons\n');
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'fv@example.com']);
  sh(repo, 'git', ['config', 'user.name', 'Feature verification Test']);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);

  const rule = 'Rule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n';
  // The stories are board tickets in the checkout's ticket cache (as `board fetch` leaves them).
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: `# DEMO-1 Apply coupon\n\n${rule}` });
  seedTicket(repo, { key: 'DEMO-2', slug: 'DEMO-2-coupon-history', text: `# DEMO-2 Coupon history\n\n* **Blocked by:** [DEMO-1](DEMO-1-apply-coupon.md)\n\n${rule}` });
  seedTicket(repo, { key: 'DEMO-3', slug: 'DEMO-3-loyalty', text: `# DEMO-3 Loyalty\n\n${rule}` });
  seedTicket(repo, { key: 'DEMO-4', slug: 'DEMO-4-loyalty-tiers', text: `# DEMO-4 Loyalty tiers\n\n* **Blocked by:** [DEMO-3](DEMO-3-loyalty.md)\n\n${rule}` });
  incoming = ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4'];
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

test('implement run: each story gets a worktree and branch, loops with the review, waits for verified tests and stacks dependents', async () => {
  const happySad = [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }];
  const blocking = { verdict: 'CHANGES_REQUESTED', summary: 'no owner check', findings: [{ severity: 'blocking', category: 'security', file: 'src/Basket/Coupons.cs', line: 1, issue: 'no owner check', fix: 'check buyer id' }] };
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      implementer: [
        { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } },
        { writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'owner check added' } },
        { writeImpl: 'src/Basket/History.cs', result: { status: 'done', reason: 'history' } },
        { result: { status: 'blocked', reason: 'loyalty provider is an open question' } },
      ],
      'architecture-reviewer': [{ result: blocking }, { result: { score: 10, verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      'test-planner': [{ writePlan: happySad }],
      'test-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
      'test-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
      'test-automation-verifier': [{ result: { score: 10, gaps: [] } }],
    }),
  );

  const dry = pipeline(['implement', 'run', ...incoming, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1\. DEMO-1 +feat\/demo-1-apply-coupon <- main\n 2\. DEMO-2 +feat\/demo-2-coupon-history <- feat\/demo-1-apply-coupon {2}\(blocked by DEMO-1\)/);
  assert.ok(!fs.existsSync(`${scriptFile}.calls.json`), 'a dry run starts no agents');

  fs.rmSync(`${scriptFile}.env.jsonl`, { force: true });
  const result = pipeline(['implement', 'run', ...incoming], { PIPELINE_FAKE_RECORD_ENV: 'FV_USE_SLOTS', FV_USE_SLOTS: undefined });
  assert.equal(result.status, 1, 'not every story finished');
  // Council r2 (T6): the run hands featureVerification.slots.enabled (on by default) to every agent it starts.
  assert.deepEqual([...new Set(fs.readFileSync(`${scriptFile}.env.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l).FV_USE_SLOTS))], ['1']);
  assert.match(result.stdout, /DEMO-1 +done +feat\/demo-1-apply-coupon/);
  assert.match(result.stdout, /DEMO-2 +done +feat\/demo-2-coupon-history/);
  assert.match(result.stdout, /DEMO-3 +blocked .*\n +loyalty provider is an open question/);
  assert.match(result.stdout, /DEMO-4 +skipped .*\n +blocker DEMO-3 ended blocked/);
  // Each story's test plan and test automation stages, and the review that blocked once, began with their orchestrator's decision (unscripted: it delegated).
  assert.deepEqual(calls(), { implementer: 4, 'architecture-reviewer': 3, 'stage-orchestrator': 5, 'test-planner': 2, 'test-plan-verifier': 2, 'test-automation': 2, 'test-automation-verifier': 2 });
  assert.match(prompts(), /=== implementer #2[\s\S]*Address this feedback[\s\S]*no owner check[\s\S]*Fix: check buyer id/, 'review findings go back to the implementer');
  assert.match(prompts(), /=== implementer #1 \(child=1\)[\s\S]*headless under `pipeline implement`[\s\S]*AGENT_RESULT/);

  const wt1 = path.join(tmp, 'shop-worktrees', 'demo-1');
  const wt2 = path.join(tmp, 'shop-worktrees', 'demo-2');
  assert.equal(sh(wt1, 'git', ['branch', '--show-current']), 'feat/demo-1-apply-coupon');
  assert.equal(sh(wt1, 'git', ['status', '--porcelain']), '', 'everything is committed');
  assert.deepEqual(sh(wt1, 'git', ['log', '--format=%s', 'main..HEAD']).split('\n'), [
    'DEMO-1: Add verified test plan and automated tests',
    'DEMO-1: Implementation',
    // The orchestrator implemented the ticket itself (self mode), committed after its pair round.
    'DEMO-1: self (round 1)',
  ]);
  assert.ok(fs.existsSync(path.join(wt1, CACHE, 'DEMO-1/story.md')), "the ticket is in the worktree's cache, not on the branch");
  assert.ok(fs.existsSync(path.join(wt1, '.factory/plans/DEMO-1-apply-coupon/_index.md')));
  const metrics = fs.readFileSync(path.join(wt1, '.factory/metrics/implement-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // The orchestrator's own first run is counted with its plan and pair (the decision log); the run after the review block is the implementer's one more.
  assert.deepEqual(metrics.map((m) => [m.story, m.outcome, m.implementer_runs, m.review_blocks]), [['DEMO-1', 'done', 1, 1]]);

  assert.equal(sh(wt2, 'git', ['merge-base', '--is-ancestor', 'feat/demo-1-apply-coupon', 'HEAD']), '', 'DEMO-2 is stacked on DEMO-1');
  assert.equal(sh(wt2, 'git', ['log', '-1', '--format=%s']), 'DEMO-2: Add verified test plan and automated tests');
  assert.ok(!fs.existsSync(path.join(tmp, 'shop-worktrees', 'demo-4')), 'a story whose blocker failed never starts');
  assert.equal(sh(repo, 'git', ['branch', '--show-current']), 'main', 'the main checkout is untouched');

  const status = pipeline(['implement', 'status']);
  assert.match(status.stdout, /DEMO-2 +finished +done +feat\/demo-2-coupon-history/);
  assert.match(status.stdout, /DEMO-4 +finished +skipped/);

  // The machine dies while DEMO-3 is being worked on: its runner never records an outcome.
  const runs = path.join(repo, '.factory/state/implement');
  const edit = (file, patch) => fs.writeFileSync(path.join(runs, file), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(runs, file), 'utf8')), ...patch }));
  edit('batch.json', { pid: 2 ** 22 + 7, finishedAt: null });
  edit('DEMO-3.json', { status: 'running', outcome: null });
  edit('DEMO-4.json', { findings: [{ issue: 'from an earlier attempt' }], agentRuns: 9 }); // DEMO-4 starts fresh, not resumed
  assert.match(pipeline(['implement', 'status']).stdout, /last implement run was interrupted.*implement resume/);
  assert.match(JSON.parse(pipeline(['hook', 'session-start']).stdout).additionalContext, /last implement run was interrupted[\s\S]*pipeline.mjs resume/, 'the next session is told');
  assert.match(pipeline(['implement', 'resume', 'DEMO-9', '--background']).stdout, /does not include DEMO-9/, 'a story-scoped resume leaves other batches alone');
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      implementer: [{ writeImpl: 'src/Loyalty/Points.cs', result: { status: 'done', reason: 'points' } }],
      'architecture-reviewer': [{ result: { score: 10, verdict: 'APPROVED', summary: 'ok', findings: [] } }],
      'test-planner': [{ writePlan: happySad }],
      'test-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
      'test-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
      'test-automation-verifier': [{ result: { score: 10, gaps: [] } }],
    }),
  );
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  const resumed = pipeline(['implement', 'resume']);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /DEMO-1 +skip: done in a previous run[\s\S]*DEMO-3 +feat\/demo-3-loyalty <- main {2}\(resume\)[\s\S]*DEMO-4 +feat\/demo-4-loyalty-tiers <- feat\/demo-3-loyalty/);
  assert.match(resumed.stdout, /DEMO-3 +done[\s\S]*DEMO-4 +done/);
  assert.equal(calls().implementer, 2, 'only the unfinished stories run again');
  const demo4 = JSON.parse(fs.readFileSync(path.join(runs, 'DEMO-4.json'), 'utf8'));
  // A fresh start drops the earlier attempt's findings; the run's agent count is this attempt's own (the orchestrated run records it).
  assert.ok(!demo4.findings, "a fresh start drops the earlier attempt's findings");
  assert.match(prompts(), /=== implementer #1[\s\S]*previous run of this story was interrupted/, 'the orchestrator continuing the story is told the earlier run was interrupted');
  assert.match(pipeline(['implement', 'resume']).stdout, /DEMO-4 +skip: done in a previous run/, 'a finished run resumes to nothing');
  assert.match(pipeline(['resume']).stdout, /\[implement\]\nNo interrupted implement run\./);
});

test('implement run --epic: epic delivery by default (one epic branch), --delivery story keeps a branch per story; --dry-run starts nothing', () => {
  seedTicket(repo, { key: 'epic-promos', type: 'epic', text: '# Epic: Promos\n' });
  seedTicket(repo, { key: 'DEMO-7', slug: 'DEMO-7-banner', parent: 'epic-promos', text: '# DEMO-7 Banner\n\nRule.\n' });
  seedTicket(repo, { key: 'DEMO-8', slug: 'DEMO-8-promo-page', parent: 'epic-promos', text: '# DEMO-8 Promo page\n\n* **Blocked by:** [DEMO-7](DEMO-7-banner.md)\n\nRule.\n' });
  const epic = pipeline(['implement', 'run', '--epic', 'promos', '--dry-run', '--parallel', '1']);
  assert.equal(epic.status, 0, epic.stderr);
  assert.match(epic.stdout, /Delivery: epic\. One branch epic\/promos and one PR for epic-promos\./);
  assert.match(epic.stdout, /2\. DEMO-8 +feat\/demo-8-promo-page <- the epic's branch {2}\(blocked by DEMO-7\)/);
  const perStory = pipeline(['implement', 'run', '--epic', 'promos', '--delivery', 'story', '--dry-run', '--parallel', '1']);
  assert.equal(perStory.status, 0, perStory.stderr);
  assert.match(perStory.stdout, /2\. DEMO-8 +feat\/demo-8-promo-page <- feat\/demo-7-banner/);
  assert.equal(pipeline(['implement', 'run', '--epic', 'promos', '--delivery', 'nope', '--dry-run']).status, 2);
});

test('implement run --epic on a bug epic: the dry run names group delivery, not the epic branch', () => {
  seedTicket(repo, { key: 'epic-fixes', type: 'epic', text: '# Epic: Fixes\n' });
  seedTicket(repo, { key: 'BUG-71', slug: 'BUG-71-paging', type: 'bug', parent: 'epic-fixes', text: '# BUG-71 Paging\n\nRule.\n' });
  seedTicket(repo, { key: 'BUG-72', slug: 'BUG-72-auth', type: 'bug', parent: 'epic-fixes', text: '# BUG-72 Auth\n\nRule.\n' });
  const r = pipeline(['implement', 'run', '--epic', 'fixes', '--dry-run', '--parallel', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Delivery: bug groups\. Bug epic: the orchestrator groups the tickets into PRs\./);
  assert.match(r.stdout, /BUG-71 +feat\/bug-71-paging <- its group branch/);
  assert.doesNotMatch(r.stdout, /the epic's branch/);
});

test('a reused worktree takes what landed on its base since the branch was made (a factory fix and pin on main; dogfood step 5)', async () => {
  const { prepareWorktree } = await import('../lib/implement.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-base-')));
  const g = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  g(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'pin.json'), '{"version":"1"}\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'base');
  const worktree = path.join(root, '..', `${path.basename(root)}-wt`);
  g(root, 'worktree', 'add', '-q', '-b', 'feat/x', worktree, 'main');
  fs.writeFileSync(path.join(worktree, 'fix.cs'), 'class Fix {}\n');
  g(worktree, 'add', '-A');
  g(worktree, 'commit', '-qm', 'the ticket work');
  fs.writeFileSync(path.join(root, 'pin.json'), '{"version":"2"}\n');
  g(root, 'commit', '-qam', 'pin 2');
  const config = { root, stateDir: '.factory/state', tickets: { dir: '.factory/state/board' } };
  const story = path.join(root, '..', `${path.basename(root)}-X-1.md`);
  fs.writeFileSync(story, '# X-1: A story\n');
  const prep = prepareWorktree(config, { key: 'X-1', file: story, base: 'main', branch: 'feat/x', worktree });
  assert.ok(!prep?.error, prep?.error);
  assert.equal(prep.created, false, 'a reused worktree is not new (so prepareCmd does not run again)');
  assert.equal(fs.readFileSync(path.join(worktree, 'pin.json'), 'utf8'), '{"version":"2"}\n', 'the base was merged');
  const fresh = path.join(root, '..', `${path.basename(root)}-wt2`);
  const prep2 = prepareWorktree(config, { key: 'X-2', file: story, base: 'main', branch: 'feat/y', worktree: fresh });
  assert.equal(prep2.created, true, 'a new worktree is reported as new, so the story runs the repository install (prepareCmd) in it');
  fs.rmSync(fresh, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(worktree, 'fix.cs')), 'the ticket work is kept');
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(story, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('the PR description carries the Stop hook PR check: verdict, score and open findings (dogfood step 5)', async () => {
  const { prCheckSection } = await import('../lib/implement.mjs');
  assert.equal(prCheckSection({ status: 'idle' }), '- PR check: not run\n');
  // A check that did not complete is said so, and the PR waits for a person (council C12).
  assert.match(prCheckSection({ status: 'skipped', reason: 'automation blocked' }), /PR check: did not complete \(skipped: automation blocked\); this PR is not delivered and waits for a person/);
  const done = prCheckSection({ status: 'done', verdict: 'FAIL', score: 9, openFindings: [{ id: 'STY-1-1', lens: 'style', severity: 'minor', title: 'BASE_URL used inconsistently' }] });
  assert.match(done, /PR check \(report only, before this PR\): FAIL 9\/10, open findings:\n {2}- minor \[style\] BASE_URL used inconsistently/);
});

test('implement stop ends the run and its stage processes and marks them stopped, so nothing resumes them (dogfood step 5)', async () => {
  const { stopRun } = await import('../lib/stop.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-stop-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-stop-wt-'));
  const runsDir = path.join(root, '.factory/state/implement');
  fs.mkdirSync(runsDir, { recursive: true });
  const batchFile = path.join(runsDir, 'batch.json');
  fs.writeFileSync(batchFile, JSON.stringify({ pid: 111, boot: 'b', startedAt: '2026-11-13T07:00:00Z' }));
  fs.writeFileSync(path.join(runsDir, 'BUG-7.json'), JSON.stringify({ key: 'BUG-7', status: 'running', worktree: wt }));
  const config = { root, stateDir: '.factory/state' };
  const { updateState, loadState } = await import('../../pipeline/lib/state.mjs');
  updateState({ ...config, root: wt }, 'BUG-7', (s) => Object.assign(s.automation, { status: 'running', pid: 222 }));
  const killed = [];
  let cleaned = 0;
  const r = stopRun(config, { runsDir, batchFile, kill: (pid) => (killed.push(pid), true), alive: () => true, cleanup: () => (cleaned++, { daemons: 6, slots: [1, 2] }) });
  assert.deepEqual(killed.sort(), [111, 222]);
  // Council C3 (C7): the stopped run's language servers and stack slots are cleaned up as a finished run's are.
  assert.equal(cleaned, 1);
  assert.deepEqual(r.cleaned, { daemons: 6, slots: [1, 2] });
  assert.deepEqual(r.stories, ['BUG-7']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runsDir, 'BUG-7.json'), 'utf8')).outcome, 'stopped');
  assert.ok(JSON.parse(fs.readFileSync(batchFile, 'utf8')).finishedAt, 'a finished batch is not resumed');
  assert.equal(loadState({ ...config, root: wt }, 'BUG-7').automation.status, 'stopped');
  for (const d of [root, wt]) fs.rmSync(d, { recursive: true, force: true });
});

test("discarding a verifier's leftovers keeps the metrics its own run appended (dogfood clean run of BUG-10)", async () => {
  const { discardChanges } = await import('../lib/gitops.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discard-'));
  const g = (...args) => spawnSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, '.factory/metrics'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/metrics/token-usage.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(root, 'src.cs'), 'class A {}\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  fs.appendFileSync(path.join(root, '.factory/metrics/token-usage.jsonl'), '{"verifier":1}\n');
  fs.writeFileSync(path.join(root, '.factory/metrics/verifier-runs.jsonl'), '{"v":1}\n');
  fs.writeFileSync(path.join(root, 'src.cs'), 'class A { scribble }\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'scratch\n');
  const removed = discardChanges(root, { keep: ['.factory/metrics'] });
  assert.deepEqual(removed.sort(), ['notes.txt', 'src.cs']);
  assert.equal(fs.readFileSync(path.join(root, 'src.cs'), 'utf8'), 'class A {}\n');
  assert.ok(!fs.existsSync(path.join(root, 'notes.txt')));
  assert.equal(fs.readFileSync(path.join(root, '.factory/metrics/token-usage.jsonl'), 'utf8'), '{"a":1}\n{"verifier":1}\n');
  assert.ok(fs.existsSync(path.join(root, '.factory/metrics/verifier-runs.jsonl')));
  fs.rmSync(root, { recursive: true, force: true });
});

// Held-out C14 MORE-1: the feature scoped an assertion in another story's spec, nothing verified that story again, and
// the push was refused after the run reported done.
test('a change that edits another story\'s verified tests verifies them again before the PR; failing that, it is not delivered', async () => {
  const { reverifyEditedStories } = await import('../lib/implement.mjs');
  const calls = [];
  const script = (results) => (args, env) => {
    calls.push([args.join(' '), (env.PIPELINE_STORY_SOURCES ?? '').split(path.delimiter).pop()]);
    return results.shift() ?? { status: 0, stdout: '' };
  };
  const fetched = [];
  const commits = [];
  const deps = (results) => ({ fv: script(results), fetchTicket: (k) => fetched.push(k), commit: (m) => commits.push(m) });
  const failing = { status: 1, stdout: 'FAIL CAT-1      plan=verified   automation=unverified tests or scenario edited after verification\nok   MORE-1     plan=verified   automation=verified\n' };
  let r = reverifyEditedStories({}, { worktree: '/wt', base: 'origin/main', key: 'MORE-1', ...deps([failing, { status: 0 }, { status: 0 }, { status: 0, stdout: 'ok' }]) });
  assert.deepEqual(r, { ok: true, keys: ['CAT-1'] });
  assert.deepEqual(calls.map((c) => c[0]), ['check --changed-from origin/main', 'plan CAT-1 --verify-first', 'automate CAT-1 --verify-first', 'check --changed-from origin/main']);
  assert.equal(calls[1][1], 'CAT-1', 'the other ticket is handed to its own verification calls');
  assert.deepEqual(fetched, ['CAT-1']);
  assert.match(commits[0], /MORE-1: Re-verified the test plans and tests of CAT-1 that this change edited/);
  calls.length = 0;
  r = reverifyEditedStories({}, { worktree: '/wt', base: 'origin/main', key: 'MORE-1', ...deps([failing, { status: 0 }, { status: 2 }, failing]) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /edits the verified tests of CAT-1, and feature verification could not verify them again/);
  assert.deepEqual(reverifyEditedStories({}, { worktree: '/wt', base: 'b', key: 'MORE-1', ...deps([{ status: 0 }]) }), { ok: true, keys: [] });
});

// Held-out C14 PRICE-1: the run record of a retried ticket kept the retry's 6 agent runs and lost the first attempt's 32.
test('a retried ticket\'s run record keeps every attempt and their totals', async () => {
  const { attemptOf, attemptTotals } = await import('../lib/implement.mjs');
  assert.equal(attemptOf({ status: 'queued' }), null);
  const first = attemptOf({ startedAt: '1', finishedAt: '2', outcome: 'error', reason: 'the story used all 32 agent runs', agentRuns: 32, pairRounds: 9, tokens: 1000, cost_usd: 21.24, minutes: 115, prCheckReturns: [{}] });
  assert.deepEqual(first, { startedAt: '1', finishedAt: '2', outcome: 'error', reason: 'the story used all 32 agent runs', agentRuns: 32, pairRounds: 9, tokens: 1000, cost_usd: 21.24, minutes: 115, prCheckReturns: 1 });
  assert.deepEqual(attemptTotals([first, { agentRuns: 6, pairRounds: 6, tokens: 500, cost_usd: 2.22, minutes: 11.51 }]), { attempts: 2, agentRuns: 38, pairRounds: 15, implementerRuns: 0, tokens: 1500, cost_usd: 23.46, minutes: 126.51 });
});

// Dogfood C14 (BUG-43 #207): the flow critics of the report round and of a fix round each described two changes, in
// other words; the PR listed both copies.
test('side effects said twice in other words are listed once, the more detailed wording kept; distinct ones stay', async () => {
  const { dedupeSideEffects, sideEffectsSection } = await import('../lib/side-effects.mjs');
  const list = [
    "GET /api/catalog/items?name= (v2) and GET /api/catalog/items/by/{name} (v1): name predicate Name LIKE @p || '%' (can use a plain index on Name) → lower(Name) LIKE lower(@p) || '%' (a plain Name index no longer applies; full scan on large catalogs)",
    "Catalog functional tests: each test class had its own CatalogApiFixture via IClassFixture → CatalogApiTests and Bug43Tests share one Postgres-backed host through the 'Catalog API' collection and no longer run in parallel; Bug43Tests now see CatalogApiTests' changes (item 1 updated, items 5/6 deleted, items 10015/10016 added), none of which are Explorer items",
    "shared test setup: tests/Catalog.FunctionalTests/CatalogApiCollection.cs added and used by existing tests (it affects every test or build that uses it, not only this ticket's)",
    'GET /api/catalog/items/withsemanticrelevance (v1 and v2) with AI disabled or no embedding: fallback name search matched only with the same letter case → matches regardless of letter case (e.g. text=wanderer now returns the Wanderer items)',
    'WebApp chatbot product search (ChatState.cs:122 → withsemanticrelevance) with AI off: case-sensitive name fallback → case-insensitive',
    "Catalog name filter SQL: Name LIKE @p || '%' → lower(Name) LIKE lower-cased @p || '%' (a plain index on Name can no longer serve the filter)",
    "Catalog functional tests: CatalogApiTests took CatalogApiFixture via IClassFixture → shares one CatalogApiFixture through the new 'Catalog API' collection (CatalogApiCollection) with Bug43Tests; tests in the collection run one after another against one database",
  ];
  const out = dedupeSideEffects(list);
  assert.equal(out.length, 5);
  assert.equal(out[0], list[0], 'the longer of the two name-filter items is kept');
  assert.equal(out[1], list[1]);
  assert.ok(out.includes(list[2]) && out.includes(list[3]) && out.includes(list[4]));
  assert.equal(sideEffectsSection(list).split('\n').filter((l) => l.startsWith('- ')).length, 5);
});
