// Every pipeline PR opens finished (owner requirement C16; epics in C18): the only code that opens a PR or marks one ready
// is the shared delivery (implement.mjs deliverFinished / afterOpen), and it opens only after the branch CI proof. This
// test reads the engine's source and fails when any other caller opens a PR, marks one ready, or pushes to an open one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const files = spawnSync('git', ['ls-files', 'scripts/**/*.mjs', 'scripts/*/*.mjs'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter((f) => f && !/\/test\//.test(f));

// The top-level function (or const) each line belongs to.
function enclosing(lines) {
  let name = null;
  return lines.map((l) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/.exec(l);
    if (m) name = m[1] ?? m[2];
    return name;
  });
}
function callers(re) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    const where = enclosing(lines);
    lines.forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return;
      if (re.test(l)) out.push(`${f}:${where[i]}`);
    });
  }
  return [...new Set(out)].sort();
}

test('a PR is opened only by the shared delivery, through its two host adapters', () => {
  // The host call itself: the hosts' `pr.open`, only through the bot's openPullRequest, only from the three adapters the
  // delivery calls as its `open` (a standalone ticket's, an epic unit's, the lessons PR's).
  assert.deepEqual(callers(/\.pr\.open\(/), ['scripts/pipeline/lib/bot.mjs:openPullRequest']);
  assert.deepEqual(callers(/\bopenPullRequest\(/), ['scripts/implement/lib/epic.mjs:openPr', 'scripts/implement/lib/implement.mjs:openStoryPr', 'scripts/pipeline/lib/bot.mjs:openPullRequest', 'scripts/retro/lib/lessons.mjs:publish']);
  // The lessons adapter is the `open` it hands to the delivery.
  const lessons = fs.readFileSync(path.join(root, 'scripts/retro/lib/lessons.mjs'), 'utf8');
  const pub = lessons.slice(lessons.indexOf('export async function publish('), lessons.indexOf('\n}\n', lessons.indexOf('export async function publish(')));
  assert.ok(pub.indexOf('deliverFinished(') >= 0 && pub.indexOf('deliverFinished(') < pub.indexOf('openPullRequest('), 'the lessons PR opens only as the delivery\'s open');
  // The adapters are called only as the delivery's `open` (a standalone ticket's, an epic unit's).
  assert.deepEqual(callers(/\bopenStoryPr\(/), ['scripts/implement/lib/implement.mjs:deliverStory', 'scripts/implement/lib/implement.mjs:openStoryPr']);
  assert.deepEqual(callers(/\b(?:deps\.)?openPr\(/), ['scripts/implement/lib/epic.mjs:deliverUnit', 'scripts/implement/lib/epic.mjs:openPr']);
  assert.deepEqual(callers(/\bo\.open\(/), ['scripts/implement/lib/implement.mjs:deliverFinished']);
  // Only the hosts' own adapters speak `pr create`.
  for (const c of callers(/['"]pr['"],\s*['"]create['"]|\bpr create\b(?!\(| failed)/)) assert.match(c, /^scripts\/pipeline\/lib\/(hosts|bot)\b/, c);
});

test('the delivery opens only after the branch CI proof and the gate rating, and never pushes to an open PR outside it', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/implement/lib/implement.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('export async function deliverFinished('), src.indexOf('\nexport function adoptOpenedPr('));
  const at = (s) => fn.indexOf(s);
  for (const step of ['io.push({ worktree, branch, base })', 'proveBeforeOpen(', 'if (proof.delivery) return notFinished(', 'io.assess(']) assert.ok(at(step) >= 0, step);
  assert.ok(at('proveBeforeOpen(') < at('o.open(') && at('if (proof.delivery) return notFinished(') < at('o.open(') && at('io.assess(') < at('o.open('), 'push, proof, rating, then the open');
  assert.equal(fn.split('o.open(').length - 1, 1, 'one open');
  // Pushing to a branch outside the delivery's own push: only the delivery, the CI fixing round and non-PR flows.
  const pushers = callers(/\bpublisher\.push\(|\.push\(unit\.worktree/);
  assert.deepEqual(pushers.filter((c) => /implement\/lib\/(epic|implement)\.mjs/.test(c)), [], `no direct push from the implement flows: ${pushers.join(', ')}`);
  // The one force push (a folded story branch with no PR, the secret decision table's fold-branch) goes through the bot's
  // pushFoldedBranch, called only from the delivery's remedy adapter.
  assert.deepEqual(callers(/\bpushFoldedBranch\(/), ['scripts/implement/lib/implement.mjs:pushLeaseDefault', 'scripts/pipeline/lib/bot.mjs:pushFoldedBranch']);
  assert.deepEqual(callers(/\bpushLeaseDefault\(/), ['scripts/implement/lib/implement.mjs:deliverFinished', 'scripts/implement/lib/implement.mjs:pushLeaseDefault']);
});

test('a PR is marked ready only by afterOpen, once its checks are green', () => {
  assert.deepEqual(callers(/\breleasePr\(/), ['scripts/implement/lib/implement.mjs:deliveryIo', 'scripts/implement/lib/pre-open.mjs:releasePr']);
  assert.deepEqual(callers(/\bio\.release\(/), ['scripts/implement/lib/implement.mjs:afterOpen']);
  assert.deepEqual(callers(/draft:\s*false/), ['scripts/implement/lib/pre-open.mjs:releasePr']);
  const src = fs.readFileSync(path.join(root, 'scripts/implement/lib/implement.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('export async function afterOpen('));
  // ADV-31: on green every hold not yet released is released (a failed or unconfirmed one included).
  assert.match(fn, /if \(ci\.state === 'success' && holds\.some\(\(h\) => !h\.to\)\) \{\n\s*releaseAll\(\);/, 'released only on green');
  assert.equal((fn.match(/\brelease\(h\)/g) ?? []).length, 1, 'release() is called only from releaseAll');
});

test('no setting brings back an open before the work and CI are done', async () => {
  const { preOpenProblems, preOpenSettings } = await import('../lib/pre-open.mjs');
  const off = { implement: { preOpen: { enabled: false, failedStory: 'draft-pr' } } };
  assert.deepEqual([preOpenSettings(off).enabled, preOpenSettings(off).failedStory], [undefined, undefined]);
  const problems = preOpenProblems(off).join('\n');
  assert.match(problems, /preOpen\.enabled was removed: every pipeline PR now opens finished[\s\S]*preOpen\.failedStory was removed: a story whose PR check or CI never passes now always escalates/);
  assert.doesNotMatch(problems, /is not a setting/);
});

test('a reopened ticket whose PR is open: the PR goes on hold before any agent of the story runs', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/implement/lib/implement.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('async function implementStoryInner('), src.indexOf('\n}\n', src.indexOf('async function implementStoryInner(')));
  const hold = fn.indexOf('holdOpenPr(');
  assert.ok(hold > 0, 'the story holds a reopened open PR');
  for (const agent of ['orchestrate(', 'runAgent(', 'createContext(']) assert.ok(fn.indexOf(agent) < 0 || hold < fn.indexOf(agent), `${agent} after the hold`);
});

test('an open PR on hold is delivered without a second open: proven, body refreshed, marked ready only when green', async () => {
  const { spawnSync: sh } = await import('node:child_process');
  const os = await import('node:os');
  const { deliverFinished } = await import('../lib/implement.mjs');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-pr-')));
  const g = (...a) => sh('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const config = { root: dir, stateDir: '.factory/state', metricsDir: '.factory/metrics', implement: {}, project: { languages: [] } };
  const order = [];
  const pr = 'https://github.com/acme/shop/pull/9';
  const io = {
    push: (o) => (order.push(o.commitRecords === false ? 'sync' : 'push'), { pushed: true }),
    repo: () => 'acme/shop',
    gate: async (o) => (order.push(/^https?:/.test(o.pr) ? `pr-ci:${o.fixRounds}` : 'branch-ci'), { state: 'success', names: ['CI'], failing: [], pending: [], rounds: 0 }),
    publishTicket: () => {},
    assess: () => (order.push('assess'), { severity: 'Low', tickets: [] }),
    publishGate: () => order.push('gate'),
    regate: () => {},
    media: () => ({ notes: [] }),
    updateBody: () => order.push('update-body'),
    release: () => order.push('ready'),
    ownsPr: () => true,
    stateDecision: async () => {},
    usage: () => [],
  };
  const held = [{ mode: 'draft', from: new Date(Date.now() - 1000).toISOString(), why: 'reopened' }];
  const out = await deliverFinished(config, config, { id: 'BUG-9', keys: ['BUG-9'], label: 'BUG-9', branch: 'feat/bug-9', worktree: dir, base: 'main', title: 't', body: 'Implements BUG-9.\n\n- Test plan and automated tests: verified\n', isBug: true, existingPr: pr, holds: held, readyAt: '2026-11-01T00:00:00.000Z', io, open: () => assert.fail('an open PR is never opened again') });
  assert.deepEqual(order, ['push', 'branch-ci', 'sync', 'assess', 'update-body', 'gate', 'pr-ci:0', 'ready']);
  assert.equal(out.pr, pr);
  assert.ok(out.holds[0].to, 'released');
});

test('no CI template the factory renders opens a pull request or marks one ready', () => {
  const tpl = spawnSync('git', ['ls-files', 'templates/ci'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const hits = tpl.filter((f) => /\bgh pr (create|ready)\b|\/pullrequests\?|\/merge_requests\b.*POST|create-pull-request/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(hits, []);
});
