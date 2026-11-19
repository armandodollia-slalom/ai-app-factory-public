import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blockersOf, collectStories, orderStories, worktreeFor } from '../lib/batch.mjs';
import { implChanges } from '../../pipeline/lib/git.mjs';
import { approvedOnDisk, loadRun, plan, recordUnrun, skippedOutcome } from '../lib/implement.mjs';

function storiesDir(stories) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-unit-'));
  for (const [name, text] of Object.entries(stories)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const blocked = (...keys) => `* **Blocked by:** ${keys.map((k) => `[${k}](${k}-x.md)`).join(', ')} (partial: only the API)\n`;

test('blockersOf reads only the "Blocked by" line and ignores the story itself', () => {
  assert.deepEqual(blockersOf(`# SHOP-4 Coupons\n\nSee SHOP-9.\n${blocked('SHOP-1', 'SHOP-5', 'SHOP-4')}`, 'SHOP-4'), ['SHOP-1', 'SHOP-5']);
  assert.deepEqual(blockersOf('# X-1\n\n* **Blocked by:** none\n', 'X-1'), []);
});

test('stories run after their in-batch blockers, stack on the blocker that already contains the others, and skip implemented ones', () => {
  const dir = storiesDir({
    'A-1-base.md': '# A-1 Base\n\n## Implementation Notes\n\ndone\n',
    'A-2-api.md': `# A-2 Api\n${blocked('A-1')}`,
    'A-3-ui.md': `# A-3 Ui\n${blocked('A-2', 'A-1')}`,
    'A-10-checkout.md': `# A-10 Checkout\n${blocked('A-3', 'A-4', 'OUT-1')}`,
    'A-4-orders.md': '# A-4 Orders\n',
    'notes.md': 'not a story',
  });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.factory/state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  // A heading in the ticket's text never means done (dogfood C15); the pipeline's own delivery record does.
  assert.equal(plan(config, [dir]).find((s) => s.key === 'A-1').skip, null, 'an Implementation Notes heading alone is not done');
  fs.mkdirSync(path.join(dir, '.factory/state/implement'), { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'base'], ['branch', 'feat/a-1-base']]) spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.factory/state/implement/A-1.json'), JSON.stringify({ key: 'A-1', status: 'finished', outcome: 'done', branch: 'feat/a-1-base' }));
  const stories = plan(config, [dir]);
  assert.deepEqual(stories.map((s) => s.key), ['A-1', 'A-2', 'A-3', 'A-4', 'A-10']);
  const by = Object.fromEntries(stories.map((s) => [s.key, s]));
  assert.match(by['A-1'].skip, /done in a previous run/);
  assert.equal(by['A-2'].base, 'feat/a-1-base', 'a blocker delivered in an earlier run (not yet merged) is stacked on');
  assert.deepEqual([by['A-3'].base, by['A-3'].merge], ['feat/a-2-api', []]);
  assert.deepEqual([by['A-10'].base, by['A-10'].merge], ['feat/a-3-ui', ['feat/a-4-orders']], 'out-of-batch blockers are left to the implementer');
  assert.equal(by['A-10'].worktree, path.resolve(dir, `../${path.basename(dir)}-wt/a-10`));
  assert.equal(plan(config, [dir], { force: true })[0].skip, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a later run resumes the stories an interrupted run left part-way, in their worktree', () => {
  const dir = storiesDir({ 'B-1-a.md': '# B-1 A\n', 'B-2-b.md': '# B-2 B\n', 'B-3-c.md': '# B-3 C\n' });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.factory/state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.factory/state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  const record = (key, patch) => fs.writeFileSync(path.join(runs, `${key}.json`), JSON.stringify({ key, worktree: dir, ...patch }));
  record('B-1', { status: 'running' });
  record('B-2', { status: 'finished', outcome: 'fv-crashed' });
  record('B-3', { status: 'finished', outcome: 'review-failed' });
  const by = Object.fromEntries(plan(config, [dir]).map((s) => [s.key, s]));
  assert.deepEqual([by['B-1'].resume, by['B-2'].resume, by['B-3'].resume], [true, true, false]);
  assert.equal(plan(config, [dir], { force: true })[0].resume, false, '--force starts over');
  // A record that never got its worktree resumes in the story's own worktree path.
  const wt = worktreeFor(config, { key: 'B-1' });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(runs, 'B-1.json'), JSON.stringify({ key: 'B-1', status: 'finished', outcome: 'error' }));
  assert.equal(plan(config, [dir])[0].resume, true);
  fs.rmSync(wt, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a story whose escalation still stands keeps its outcome and its dependents stay blocked; handling it or --force runs it again', () => {
  const dir = storiesDir({ 'B-1-a.md': '# B-1 A\n', 'B-2-b.md': `# B-2 B\n\n${blocked('B-1')}`, 'B-3-c.md': '# B-3 C\n' });
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.factory/state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.factory/state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'B-1.json'), JSON.stringify({ key: 'B-1', worktree: dir, status: 'finished', outcome: 'fv-escalated' }));
  fs.writeFileSync(path.join(runs, 'B-3.json'), JSON.stringify({ key: 'B-3', worktree: dir, status: 'finished', outcome: 'review-escalated' }));
  const escalations = path.join(dir, '.factory/state', 'escalations');
  fs.mkdirSync(escalations, { recursive: true });
  fs.writeFileSync(path.join(escalations, 'B-1-automation.md'), '# B-1 automation: tests did not reach 9/10\n');
  fs.writeFileSync(path.join(escalations, 'B-3-review.md'), '# B-3 review: did not converge\n');
  const by = Object.fromEntries(plan(config, [dir]).map((s) => [s.key, s]));
  assert.match(by['B-1'].skip, /fv-escalated in a previous run: its escalation waits for a human/);
  assert.deepEqual(skippedOutcome(by['B-1']).outcome, 'fv-escalated');
  assert.equal(by['B-3'].escalatedBefore, 'review-escalated');
  assert.deepEqual(by['B-2'].deps, ['B-1'], 'the escalated blocker still blocks B-2');
  const forced = Object.fromEntries(plan(config, [dir], { force: true }).map((s) => [s.key, s]));
  assert.equal(forced['B-1'].skip, null);
  // Once the escalation is handled (its note cleared), the story runs again without --force.
  fs.rmSync(path.join(escalations, 'B-1-automation.md'));
  assert.equal(plan(config, [dir]).find((s) => s.key === 'B-1').skip, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dependency cycles and duplicate keys are errors', () => {
  const dir = storiesDir({ 'C-1-a.md': `# C-1\n${blocked('C-2')}`, 'C-2-b.md': `# C-2\n${blocked('C-1')}` });
  assert.throws(() => orderStories(collectStories([dir])), /cycle between stories: C-1 -> C-2 -> C-1/);
  fs.writeFileSync(path.join(dir, 'C-1-dupe.md'), '# C-1\n');
  assert.throws(() => collectStories([dir]), /Two story files for C-1/);
  assert.throws(() => collectStories([path.join(dir, 'missing.md')]), /No such file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('approvedOnDisk: a resumed story stacked on a group branch matches the hash its review approved against that branch', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-approved-'));
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  write('src/A.cs', '// a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  // The group branch already carries an earlier ticket; the story stacks on it.
  g('switch', '-q', '-c', 'bugfix/group');
  write('src/Earlier.cs', '// earlier ticket\n');
  g('add', '-A');
  g('commit', '-qm', 'earlier');
  g('switch', '-q', '-c', 'feat/story');
  write('src/Story.cs', '// this story\n');
  write('tests/StoryTests.cs', '// feature verification work in progress is not implementation\n');
  const wt = { root: repo, baseRef: 'main', implExclude: ['tests'] };
  const approvedHash = implChanges({ ...wt, baseRef: 'bugfix/group' }).hash;
  const prior = { done: { hash: approvedHash }, review: { lastVerdict: 'APPROVED', approvedHash } };
  assert.equal(approvedOnDisk(wt, prior, 'bugfix/group'), true);
  assert.notEqual(implChanges(wt).hash, approvedHash, 'against main the earlier ticket is in the diff');
  write('src/Story.cs', '// changed after the review\n');
  assert.equal(approvedOnDisk(wt, prior, 'bugfix/group'), false);
  assert.equal(approvedOnDisk(wt, { ...prior, review: { ...prior.review, lastVerdict: 'CHANGES_REQUESTED' } }, 'bugfix/group'), false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a cached ticket whose issue is closed counts as implemented, even without Implementation Notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-ticket-'));
  const ticket = (key, state) => {
    fs.mkdirSync(path.join(dir, key));
    fs.writeFileSync(path.join(dir, key, 'story.md'), `# ${key}: Story\n\n**Blocked by:** None\n`);
    fs.writeFileSync(path.join(dir, key, 'meta.json'), JSON.stringify({ key, slug: key.toLowerCase(), issue: { number: 1, state } }));
  };
  ticket('DEMO-1', 'CLOSED');
  ticket('DEMO-2', 'OPEN');
  const byKey = Object.fromEntries(collectStories([path.join(dir, 'DEMO-1'), path.join(dir, 'DEMO-2')]).map((s) => [s.key, s.implemented]));
  assert.deepEqual(byKey, { 'DEMO-1': true, 'DEMO-2': false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ticket labeled escalation-resolved runs again despite its standing fv escalation, like --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-resolved-'));
  const ticket = (key, labels) => {
    fs.mkdirSync(path.join(dir, key));
    fs.writeFileSync(path.join(dir, key, 'story.md'), `# ${key}: Story\n\n**Blocked by:** None\n`);
    fs.writeFileSync(path.join(dir, key, 'meta.json'), JSON.stringify({ key, slug: key.toLowerCase(), issue: { number: 1, state: 'OPEN', labels } }));
  };
  ticket('B-1', ['bug', 'escalation-resolved']);
  ticket('B-2', ['bug']);
  const config = { baseRef: 'origin/main', root: dir, stateDir: '.factory/state', implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const runs = path.join(dir, '.factory/state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  const escalations = path.join(dir, '.factory/state', 'escalations');
  fs.mkdirSync(escalations, { recursive: true });
  for (const key of ['B-1', 'B-2']) {
    fs.writeFileSync(path.join(runs, `${key}.json`), JSON.stringify({ key, worktree: dir, status: 'finished', outcome: 'fv-escalated' }));
    fs.writeFileSync(path.join(escalations, `${key}-automation.md`), `# ${key} automation: tests did not reach 9/10\n`);
  }
  const by = Object.fromEntries(plan(config, [path.join(dir, 'B-1'), path.join(dir, 'B-2')]).map((s) => [s.key, s]));
  assert.equal(by['B-1'].resolved, true);
  assert.equal(by['B-1'].skip, null, 'the resolved label bypasses the standing escalation');
  assert.equal(by['B-1'].resume, false, 'it starts fresh, as with --force');
  assert.match(by['B-2'].skip, /fv-escalated in a previous run: its escalation waits for a human/, 'without the label it still waits');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordUnrun: a ticket the batch never ran gets its outcome recorded once, so its failure is not posted again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-unrun-'));
  const config = { root: dir, stateDir: '.factory/state' };
  fs.mkdirSync(path.join(dir, '.factory/state', 'implement'), { recursive: true });
  const skipped = { key: 'B-2', outcome: 'skipped', reason: 'blocker B-1 ended fv-escalated' };
  recordUnrun(config, skipped);
  const first = loadRun(config, 'B-2');
  assert.deepEqual([first.outcome, first.reason, first.status], ['skipped', 'blocker B-1 ended fv-escalated', 'finished']);
  recordUnrun(config, skipped);
  assert.equal(loadRun(config, 'B-2').finishedAt, first.finishedAt, 'the same outcome keeps its finish time (a replay, not a new failure)');
  // A story that ran keeps its own record (a done worker whose merge failed stays merge-only).
  fs.writeFileSync(path.join(dir, '.factory/state', 'implement', 'B-3.json'), JSON.stringify({ key: 'B-3', outcome: 'done', status: 'finished' }));
  recordUnrun(config, { key: 'B-3', outcome: 'merge-conflict', reason: 'x' });
  assert.equal(loadRun(config, 'B-3').outcome, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resetEscalatedFv: a resolved re-run makes escalated feature verification stages start over, so feature verification sees the decision', async () => {
  const { resetEscalatedFv } = await import('../lib/implement.mjs');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-reset-fv-'));
  const stories = path.join(wt, '.factory/state', 'stories');
  fs.mkdirSync(stories, { recursive: true });
  const write = (state) => fs.writeFileSync(path.join(stories, 'B-1.json'), JSON.stringify({ story: 'B-1', ...state }));
  const read = () => JSON.parse(fs.readFileSync(path.join(stories, 'B-1.json'), 'utf8'));
  const config = { stateDir: '.factory/state' };
  // The escalated automation ran on the same implementation the re-run keeps (the decision is about tests).
  write({ automation: { status: 'escalated', workingHash: 'h1', verifiedHash: null }, plan: { status: 'verified' }, review: { lastVerdict: 'APPROVED', approvedHash: 'h1' } });
  assert.deepEqual(resetEscalatedFv(config, 'B-1', wt), ['automation']);
  assert.deepEqual([read().automation.status, read().automation.workingHash, read().plan.status], ['idle', null, 'verified']);
  write({ automation: { status: 'blocked-on-plan', workingHash: 'h1' }, plan: { status: 'escalated' } });
  assert.deepEqual(resetEscalatedFv(config, 'B-1', wt), ['automation', 'plan']);
  // A verified feature verification is left alone, and a missing worktree changes nothing.
  write({ automation: { status: 'verified', workingHash: 'h1', verifiedHash: 'h1' }, plan: { status: 'verified' } });
  assert.deepEqual(resetEscalatedFv(config, 'B-1', wt), []);
  assert.deepEqual(resetEscalatedFv(config, 'B-1', path.join(wt, 'missing')), []);
  fs.rmSync(wt, { recursive: true, force: true });
});

// Council C6: an epic run picked up a ticket that was waiting for its owner's decision (needs-human).
test('a ticket waiting for a person is not run again until the person resolves it', async () => {
  const { seedTicket } = await import('../../pipeline/test/fixtures/tickets.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'));
  seedTicket(root, { key: 'B-1', text: '# B-1 Rating\n', number: 1 });
  const metaFile = path.join(root, '.factory/state/board/B-1/meta.json');
  const setLabels = (labels) => {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    m.issue.labels = labels;
    fs.writeFileSync(metaFile, JSON.stringify(m));
  };
  const config = { baseRef: 'origin/main', root, stateDir: '.factory/state', board: { blockedLabel: 'needs-human', resolvedLabel: 'escalation-resolved' }, implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const dir = path.join(root, '.factory/state/board/B-1');
  setLabels(['bug', 'needs-human']);
  assert.match(plan(config, [dir])[0].skip, /waiting for a person \(needs-human\)/);
  setLabels(['bug', 'escalation-resolved']);
  assert.equal(plan(config, [dir])[0].skip, null);
  fs.rmSync(root, { recursive: true, force: true });
});

// Council C11: BUG-40's run was killed while it waited for its PR's CI; `implement resume` skipped the ticket as
// already implemented, so its CI gate never ran, and the dead run left a language-server daemon and unshipped metrics.
test('a run interrupted at its CI wait resumes there; a finished one is not run again', async () => {
  const { seedTicket } = await import('../../pipeline/test/fixtures/tickets.mjs');
  const { runsDir } = await import('../lib/implement.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-resume-'));
  seedTicket(root, { key: 'B-1', text: '# B-1 Sort\n\n## Implementation Notes\n\n* **Decisions:** x\n', number: 1 });
  const config = { baseRef: 'origin/main', root, stateDir: '.factory/state', board: { blockedLabel: 'needs-human', resolvedLabel: 'escalation-resolved' }, implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const dir = path.join(root, '.factory/state/board/B-1');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-resume-wt-'));
  fs.mkdirSync(runsDir(config), { recursive: true });
  const record = (r) => fs.writeFileSync(path.join(runsDir(config), 'B-1.json'), JSON.stringify({ key: 'B-1', worktree: wt, branch: 'feat/b-1', ...r }));
  assert.equal(plan(config, [dir])[0].skip, null, 'Implementation Notes in the text and no run record: not implemented');
  record({ status: 'running', outcome: null, phase: 'ci-wait', pr: 'https://github.com/a/b/pull/154' });
  const s = plan(config, [dir])[0];
  assert.deepEqual([s.skip, s.resume, s.ciResume], [null, true, 'https://github.com/a/b/pull/154']);
  record({ status: 'finished', outcome: 'error', phase: 'ci-wait', pr: 'https://github.com/a/b/pull/154' });
  assert.equal(plan(config, [dir])[0].ciResume, 'https://github.com/a/b/pull/154', 'a worker that died without a result too');
  record({ status: 'finished', outcome: 'skipped', reason: 'its card is in review on the board', phase: 'ci-wait', pr: 'https://github.com/a/b/pull/154' });
  assert.equal(plan(config, [dir])[0].ciResume, 'https://github.com/a/b/pull/154', 'a resume an earlier attempt skipped (council C8)');
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'base'], ['branch', 'feat/b-1']]) spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root });
  record({ status: 'finished', outcome: 'done', phase: null, pr: 'https://github.com/a/b/pull/154' });
  assert.match(plan(config, [dir])[0].skip, /done in a previous run/);
  assert.equal(plan(config, [dir], { force: true })[0].ciResume, undefined, '--force starts over');
  // Council C12: ACCT-1's run hung in a gh call at its CI wait and was ended with `implement stop`. Nothing resumes it on
  // its own; `implement resume --stopped` continues it at the CI wait instead of implementing it again.
  record({ status: 'stopped', outcome: 'stopped', reason: 'stopped by implement stop', phase: 'ci-wait', pr: 'https://github.com/a/b/pull/174' });
  assert.equal(plan(config, [dir])[0].ciResume, undefined, 'a stopped run is not resumed automatically');
  assert.equal(plan(config, [dir], { resumeStopped: true })[0].ciResume, 'https://github.com/a/b/pull/174');
});

test('recoverDeadRun: the worktrees of a killed run get their language servers stopped and their metrics shipped', async () => {
  const { recoverDeadRun, runsDir } = await import('../lib/implement.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-run-'));
  const config = { root, stateDir: '.factory/state' };
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-run-wt-'));
  fs.mkdirSync(runsDir(config), { recursive: true });
  fs.writeFileSync(path.join(runsDir(config), 'B-40.json'), JSON.stringify({ key: 'B-40', status: 'running', worktree: wt }));
  fs.writeFileSync(path.join(runsDir(config), 'S-1.json'), JSON.stringify({ key: 'S-1', status: 'finished', worktree: wt }));
  const stopped = [];
  const shipped = [];
  const deps = { lsp: { stop: async (w) => stopped.push(w) }, ship: async (c) => (shipped.push(c.root), { shipped: 7 }), configOf: (w) => ({ root: w }), slots: () => [3] };
  const r = await recoverDeadRun(config, { ...deps, batch: { pid: 1, finishedAt: null }, alive: () => false });
  assert.deepEqual(r.stories, [{ key: 'B-40', worktree: wt, shipped: 7 }]);
  assert.deepEqual(r.slots, [3], 'stale slots taken down');
  assert.deepEqual([stopped, shipped], [[wt], [wt]]);
  const live = await recoverDeadRun(config, { ...deps, batch: { pid: 1, finishedAt: null }, alive: () => true });
  assert.deepEqual([live.stories, live.slots], [[], []], 'a run still going is left alone');
  const finished = await recoverDeadRun(config, { ...deps, batch: { pid: 1, finishedAt: 'x' }, alive: () => false });
  assert.deepEqual([finished.stories, finished.slots], [[], [3]], 'stacks nobody holds are taken down after a finished run too');
});


test('recoverDeadRun leaves alone a story whose own worker is alive (another run\'s), and a second run in the same checkout is refused', async () => {
  const { recoverDeadRun, runsDir, batchFile } = await import('../lib/implement.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'two-runs-'));
  const config = { root, stateDir: '.factory/state' };
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'two-runs-wt-'));
  fs.mkdirSync(runsDir(config), { recursive: true });
  // Dogfood C15: the dead batch was a killed run's; P-13 belonged to another run whose worker was still going.
  fs.writeFileSync(path.join(runsDir(config), 'P-13.json'), JSON.stringify({ key: 'P-13', status: 'running', worktree: wt, workerPid: 4242, workerBoot: 'b' }));
  fs.writeFileSync(path.join(runsDir(config), 'P-15.json'), JSON.stringify({ key: 'P-15', status: 'running', worktree: wt, workerPid: 5151, workerBoot: 'b' }));
  const stopped = [];
  const deps = { lsp: { stop: async (w) => stopped.push(w) }, ship: async () => ({ shipped: 0 }), configOf: (w) => ({ root: w }), slots: () => [] };
  const r = await recoverDeadRun(config, { ...deps, batch: { pid: 1, finishedAt: null }, alive: (pid) => pid === 4242 });
  assert.deepEqual(r.stories.map((s) => s.key), ['P-15'], "the live worker's story is not recovered");
  assert.equal(stopped.length, 1);
  // A run is active in this checkout (this test process): `implement run` refuses to start a second one.
  fs.writeFileSync(batchFile(config), JSON.stringify({ pid: process.pid, boot: (await import('../../pipeline/lib/util.mjs')).bootId(), startedAt: 'now', finishedAt: null }));
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'implement.mjs');
  const out = spawnSync(process.execPath, [cli, 'run', 'X-1'], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: root, FACTORY_PRUNE: '0' } });
  assert.equal(out.status, 75, out.stderr);
  assert.match(out.stderr, /an implement run is active in this checkout \(pid \d+/);
});

test('resume at the new delivery boundaries (implement.preOpen): died in a draft-back cycle resumes at the CI wait of its PR; died after the branch push, before the PR, resumes the story in its worktree', async () => {
  const { seedTicket } = await import('../../pipeline/test/fixtures/tickets.mjs');
  const { runsDir } = await import('../lib/implement.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-open-resume-'));
  seedTicket(root, { key: 'B-2', text: '# B-2 Sort\n', number: 2 });
  const config = { baseRef: 'origin/main', root, stateDir: '.factory/state', board: { blockedLabel: 'needs-human', resolvedLabel: 'escalation-resolved' }, implement: { branchPrefix: 'feat/', worktreeDir: '../{repo}-wt' } };
  const dir = path.join(root, '.factory/state/board/B-2');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-open-resume-wt-'));
  fs.mkdirSync(runsDir(config), { recursive: true });
  const record = (r) => fs.writeFileSync(path.join(runsDir(config), 'B-2.json'), JSON.stringify({ key: 'B-2', worktree: wt, branch: 'feat/b-2', ...r }));
  record({ status: 'running', outcome: null, phase: 'draft-back', pr: 'https://github.com/a/b/pull/9', preOpen: true, holds: [{ mode: 'draft', from: '2026-11-18T10:00:00Z' }] });
  const held = plan(config, [dir])[0];
  assert.deepEqual([held.skip, held.resume, held.ciResume], [null, true, 'https://github.com/a/b/pull/9']);
  for (const phase of ['branch-ci', 'pre-open']) {
    record({ status: 'running', outcome: null, phase, firstPushAt: '2026-11-18T09:00:00Z' });
    const s = plan(config, [dir])[0];
    assert.deepEqual([s.skip, s.resume, s.ciResume], [null, true, undefined], phase);
  }
});
