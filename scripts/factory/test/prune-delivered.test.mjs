// What a delivered run made on this machine goes, and only that, only once the delivery remote itself confirms it holds
// the commits, and never forced: anything in doubt is kept and reported. Real git repositories with a local origin;
// containers are not touched at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PRUNE_DEFAULTS, baseCheckoutDir, defaultExec, listWorktrees, pruneRunLocal, removeBaseCheckout, removeDelivered } from '../lib/prune.mjs';
import { baseCheckout } from '../../pr-video/lib/bugpair.mjs';
import { backgroundResumeArgs, cleanDeliveredBatch, loadRun, saveRun } from '../../implement/lib/implement.mjs';
import { stackedRef } from '../../implement/lib/gitops.mjs';
import { pruneProblems } from '../../pipeline/lib/config.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const exists = (p) => fs.existsSync(p);
const branches = (main) => git(main, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();

// A main checkout with an origin and BUG-1 delivered: its worktree (with ignored generated artefacts) pushed; `item` is
// the manifest its run recorded.
function world(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-delivered-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const main = path.join(tmp, 'shop');
  const origin = path.join(tmp, 'origin.git');
  const wtDir = path.join(tmp, 'shop-worktrees');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, '.gitignore'), '.factory/state/\nartifacts/\n');
  fs.mkdirSync(path.join(main, '.factory'));
  fs.writeFileSync(path.join(main, '.factory/config.json'), '{}\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  git(tmp, 'init', '-q', '--bare', origin);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', 'origin', 'main');
  const wt = path.join(wtDir, 'bug-1');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/bug-1', wt, 'main');
  fs.writeFileSync(path.join(wt, 'fix.txt'), 'fix\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'fix');
  git(wt, 'push', '-q', 'origin', 'feat/bug-1');
  fs.mkdirSync(path.join(wt, 'artifacts/e2e-videos'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'artifacts/e2e-videos/a.webm'), 'video');
  const docker = [];
  const exec = (cmd, args, opts) => (cmd === 'docker' ? (docker.push(args), { status: 1, stdout: '', stderr: 'no' }) : defaultExec(cmd, args, opts));
  const g = (extra = {}) => ({ root: main, main, wtDir, worktrees: listWorktrees(main), leases: [], settings: { ...PRUNE_DEFAULTS }, exec, docker: 'docker', now: Date.now(), ...extra });
  return { tmp, main, origin, wtDir, wt, g, docker, item: { worktree: wt, branch: 'feat/bug-1' } };
}

test('a delivered run\'s recorded worktree (with its generated artefacts) and branch go once the remote confirms; nothing else', (t) => {
  const w = world(t);
  // An independent checkout beside it, named like a subtask of it: not in the manifest, never touched (ADV2-05).
  const sibling = `${w.wt}--notes`;
  git(w.main, 'worktree', 'add', '-q', '-b', 'notes', sibling, 'feat/bug-1');
  git(sibling, 'push', '-q', 'origin', 'notes');
  const r = removeDelivered(w.g(), w.item);
  assert.deepEqual(r, { removed: [w.wt, 'branch feat/bug-1'], kept: [] });
  assert.equal(exists(w.wt), false);
  assert.ok(exists(sibling), 'what the run did not record stays');
  assert.deepEqual(branches(w.main), ['main', 'notes']);
  assert.equal(git(w.main, 'ls-remote', 'origin', 'refs/heads/feat/bug-1').split('\t')[1], 'refs/heads/feat/bug-1', 'the remote keeps it');
  assert.deepEqual(w.docker, [], 'no container is touched');
});

test('the remote itself must hold the commits: a deleted remote branch or a tracking ref moved by hand keeps everything (ADV2-04)', (t) => {
  const gone = world(t);
  git(gone.origin, 'update-ref', '-d', 'refs/heads/feat/bug-1');
  assert.match(removeDelivered(gone.g(), gone.item).kept[0].reason, /origin has no branch feat\/bug-1/);
  assert.ok(exists(gone.wt) && branches(gone.main).includes('feat/bug-1'));
  // A local commit never pushed, with the tracking ref pointed at it by hand.
  const local = world(t);
  fs.writeFileSync(path.join(local.wt, 'more.txt'), 'x\n');
  git(local.wt, 'add', '-A');
  git(local.wt, 'commit', '-qm', 'more');
  git(local.main, 'update-ref', 'refs/remotes/origin/feat/bug-1', git(local.wt, 'rev-parse', 'HEAD'));
  assert.match(removeDelivered(local.g(), local.item).kept[0].reason, /does not contain/);
  assert.ok(exists(local.wt));
  // The remote cannot be read.
  const off = world(t);
  git(off.main, 'remote', 'set-url', 'origin', path.join(off.tmp, 'nowhere.git'));
  assert.match(removeDelivered(off.g(), off.item).kept[0].reason, /could not be read/);
});

test('git is never forced: a locked worktree, a rebase in progress, a stash of its branch, a submodule, uncommitted work keep it and its branch (ADV2-03, -06)', (t) => {
  const cases = [
    ['locked', (w) => git(w.main, 'worktree', 'lock', w.wt), /locked/],
    ['a rebase in progress', (w) => {
      fs.writeFileSync(path.join(w.wt, 'fix.txt'), 'fix2\n');
      git(w.wt, 'commit', '-qam', 'second');
      git(w.wt, 'push', '-q', 'origin', 'feat/bug-1');
      spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'rebase', '-i', 'HEAD~1'], { cwd: w.wt, env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak 's/^pick/edit/'" } });
    }, /in progress/],
    ['a stash of its branch', (w) => {
      fs.writeFileSync(path.join(w.wt, 'fix.txt'), 'wip\n');
      git(w.wt, 'stash');
    }, /stash of feat\/bug-1/],
    ['an initialised submodule', (w) => {
      const lib = path.join(w.tmp, 'lib');
      fs.mkdirSync(lib);
      git(lib, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(lib, 'a'), 'a');
      git(lib, 'add', '-A');
      git(lib, 'commit', '-qm', 'lib');
      git(w.wt, 'submodule', 'add', '-q', lib, 'vendor/lib');
      git(w.wt, 'commit', '-qm', 'submodule');
      git(w.wt, 'push', '-q', 'origin', 'feat/bug-1');
    }, /submodule/],
    ['uncommitted work', (w) => fs.writeFileSync(path.join(w.wt, 'notes.txt'), 'a person\'s notes\n'), /uncommitted or untracked work/],
  ];
  for (const [what, make, why] of cases) {
    const w = world(t);
    make(w);
    const r = removeDelivered(w.g(), w.item);
    assert.deepEqual(r.removed, [], what);
    assert.match(r.kept[0].reason, why, what);
    assert.ok(exists(w.wt) && branches(w.main).includes('feat/bug-1'), `${what}: worktree and branch kept`);
  }
});

test('only a resolved path inside the worktree folder: a recorded link, a `..` path, a broad folder are refused (ADV2-02, -05)', (t) => {
  const w = world(t);
  const link = path.join(w.wtDir, 'bug-9');
  fs.symlinkSync(w.wt, link);
  assert.match(removeDelivered(w.g(), { worktree: link, branch: 'feat/bug-1' }).kept[0].reason, /not a worktree/);
  assert.match(removeDelivered(w.g(), { worktree: `${w.wtDir}/x/../bug-1`, branch: 'feat/bug-1' }).kept[0].reason, /not a worktree|checked out in another worktree/);
  for (const wtDir of ['/', os.homedir()]) assert.match(removeDelivered(w.g({ wtDir }), w.item).kept[0].reason, /not a worktree/, wtDir);
  assert.ok(exists(w.wt));
});

// The ticket worktree of `w` with scenarios of its own: baseCheckout adds the before run's checkout of main in it.
function ticketWithScenarios(w) {
  fs.mkdirSync(path.join(w.wt, '.factory/stack/scenarios'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, '.factory/stack/scenarios/s.json'), '{}');
  return baseCheckout(w.wt, 'main');
}

test('a before run\'s base checkout: only the exact files it wrote, as it wrote them, are put back; anything else keeps it, ignored files too (ADV2-01, Sol 1)', (t) => {
  const w = world(t);
  const base = ticketWithScenarios(w);
  assert.deepEqual(base.generated.map((x) => x.path).sort(), ['.factory/config.json', '.factory/stack/scenarios/s.json']);
  const cases = [
    ['a person\'s note', 'NOTE.md', 'a person\'s note\n', /untracked or ignored work.*NOTE\.md/],
    ['a person\'s file matched by .gitignore', 'artifacts/mine.txt', 'mine\n', /ignored work.*artifacts\/mine\.txt/],
    ['a file of theirs among the copied scenarios', '.factory/stack/scenarios/theirs.json', '{}', /theirs\.json/],
    ['a generated file a person edited', '.factory/stack/scenarios/s.json', '{"edited":true}', /s\.json/],
  ];
  for (const [what, file, text, why] of cases) {
    const abs = path.join(base.dir, file);
    const before = exists(abs) ? fs.readFileSync(abs, 'utf8') : null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    const r = removeBaseCheckout(w.g(), w.wt, base);
    assert.match(r.kept[0]?.reason ?? '', why, what);
    assert.equal(fs.readFileSync(abs, 'utf8'), text, `${what}: nothing changed`);
    assert.ok(exists(path.join(base.dir, '.factory/config.json')), `${what}: not even the generated files were touched`);
    if (before == null) fs.rmSync(abs);
    else fs.writeFileSync(abs, before);
  }
  assert.deepEqual(removeBaseCheckout(w.g(), w.wt, base), { removed: [base.real], kept: [] });
  assert.equal(exists(base.dir), false);
});

test('the base checkout is set up only through plain folders of the ticket: a linked state folder or an occupied folder Git did not register is left as it is (Sol 2)', (t) => {
  const w = world(t);
  const sha = git(w.main, 'rev-parse', 'main');
  // The ticket's state folder is a link to another place holding a sentinel where the checkout would go.
  const other = path.join(w.tmp, 'other');
  const sentinel = path.join(other, 'demo-base', sha.slice(0, 12), 'KEEP.txt');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'keep');
  fs.mkdirSync(path.join(w.wt, '.factory'), { recursive: true });
  fs.symlinkSync(other, path.join(w.wt, '.factory/state'));
  assert.throws(() => baseCheckout(w.wt, 'main'), /is a link or not a folder/);
  assert.ok(exists(sentinel), 'nothing was removed through the link');
  // A state folder that leads out of the ticket.
  assert.throws(() => baseCheckout(w.wt, 'main', '.factory/../../other'), /not inside the ticket/);
  assert.throws(() => baseCheckoutDir(w.wt, '/tmp/x', sha), /not inside the ticket/);
  // An occupied folder at the destination that is not a checkout Git registered: kept, not deleted.
  fs.rmSync(path.join(w.wt, '.factory/state'));
  const occupied = path.join(w.wt, '.factory/state/demo-base', sha.slice(0, 12));
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'mine.txt'), 'mine');
  assert.throws(() => baseCheckout(w.wt, 'main'), /not a checkout Git registered/);
  assert.equal(fs.readFileSync(path.join(occupied, 'mine.txt'), 'utf8'), 'mine');
  // Removal checks the same way: a recorded checkout under a state folder outside the ticket is refused.
  const outside = path.join(w.tmp, 'outside-demo', sha.slice(0, 12));
  git(w.main, 'worktree', 'add', '-q', '--detach', outside, sha);
  assert.match(removeBaseCheckout(w.g(), w.wt, { dir: outside, sha, generated: [] }, { stateDir: '../outside-demo/..' }).kept[0].reason, /not a base checkout/);
  assert.ok(exists(outside));
});

test('the remote that confirms is the one delivered to, asked once before anything is removed (ADV2-R2-07, Sol 4, Sol 11)', (t) => {
  // origin fetches from a mirror that has the branch, but pushes somewhere else.
  const split = world(t);
  const elsewhere = path.join(split.tmp, 'elsewhere.git');
  git(split.tmp, 'init', '-q', '--bare', elsewhere);
  git(split.main, 'remote', 'set-url', '--push', 'origin', elsewhere);
  assert.match(removeDelivered(split.g(), split.item).kept[0].reason, /fetches from .* but pushes to/);
  assert.ok(exists(split.wt) && branches(split.main).includes('feat/bug-1'));
  // The run delivered to another repository than origin (the PR bot pushes to the host repository directly).
  const other = world(t);
  assert.match(removeDelivered(other.g(), { ...other.item, repo: 'acme/elsewhere' }).kept[0].reason, /not the repository the run delivered to/);
  assert.ok(exists(other.wt));
  // One answer of the remote covers the worktree and the branch: a remote that fails on a second read changes nothing.
  const once = world(t);
  let reads = 0;
  const exec = (cmd, args, o) => (args[0] === 'ls-remote' && ++reads > 1 ? { status: 128, stdout: '', stderr: 'unreachable' } : defaultExec(cmd, args, o));
  assert.deepEqual(removeDelivered(once.g({ exec }), { ...once.item, repo: once.origin }), { removed: [once.wt, 'branch feat/bug-1'], kept: [] });
  assert.equal(reads, 1);
});

test('the record never outlives what it describes: a removed item is retired, a branch that existed before is not the run\'s (ADV2-R2-08, Sol 5)', async (t) => {
  const w = world(t);
  const config = { root: w.main, mainRoot: w.main, stateDir: '.factory/state', board: {} };
  saveRun(config, 'BUG-1', { outcome: 'done', pr: 'https://github.com/acme/shop/pull/1', phase: null, branch: 'feat/bug-1', created: w.item });
  await cleanDeliveredBatch(config, [{ key: 'BUG-1', branch: 'feat/bug-1' }], { cleanup: async (root, remove) => remove(w.g()) });
  assert.equal(exists(w.wt), false);
  assert.equal(loadRun(config, 'BUG-1').created, null, 'retired once removed');
  // A person checks the PR branch out again with work of their own; a rework run adds its worktree on that branch.
  git(w.main, 'branch', 'feat/bug-1', 'origin/feat/bug-1');
  const src = fs.readFileSync(new URL('../../implement/lib/implement.mjs', import.meta.url), 'utf8');
  assert.match(src, /saveRun\(config, key, \{ created: \{ worktree: fs\.realpathSync\(worktree\), branch: exists \? null : branch \} \}\)/, 'an existing branch is never recorded as created');
});

test('local cleanup after a delivery is alpha and off by default: nothing is removed unless prune.afterDelivery is true; it is validated (owner decision)', async (t) => {
  assert.equal(PRUNE_DEFAULTS.afterDelivery, false);
  const w = world(t);
  const remove = (g) => removeDelivered(g, w.item);
  const off = await pruneRunLocal(w.main, remove, { label: 'BUG-1', log: () => {}, env: {}, context: async () => w.g() });
  assert.equal(off.skipped, 'prune.afterDelivery is off');
  assert.ok(exists(w.wt) && branches(w.main).includes('feat/bug-1'));
  // The before run's base checkout goes through the same switch.
  const base = ticketWithScenarios(w);
  const r = await pruneRunLocal(w.wt, (g) => removeBaseCheckout(g, w.wt, base), { label: 'BUG-1', log: () => {}, env: {}, context: async () => w.g() });
  assert.equal(r.skipped, 'prune.afterDelivery is off');
  assert.ok(exists(base.dir));
  assert.deepEqual(pruneProblems({ afterDelivery: 'yes' }), ['prune.afterDelivery must be true or false']);
});

test('stacked work: a blocker\'s branch stays while a ticket or a saved resume builds on it; a later start resolves it from the remote (ADV2-08)', async (t) => {
  const w = world(t);
  const config = { root: w.main, mainRoot: w.main, stateDir: '.factory/state', board: {} };
  saveRun(config, 'BUG-1', { outcome: 'done', pr: 'https://github.com/acme/shop/pull/1', phase: null, branch: 'feat/bug-1', created: w.item });
  saveRun(config, 'BUG-2', { outcome: 'error', base: 'feat/bug-1', branch: 'feat/bug-2' });
  const calls = [];
  await cleanDeliveredBatch(config, [{ key: 'BUG-1', branch: 'feat/bug-1' }], { cleanup: async (root, remove, o) => calls.push(o.label) });
  assert.deepEqual(calls, [], 'BUG-2 resumes from it');
  saveRun(config, 'BUG-2', { outcome: 'done', phase: null });
  await cleanDeliveredBatch(config, [{ key: 'BUG-1', branch: 'feat/bug-1' }], { cleanup: async (root, remove, o) => calls.push(o.label) });
  assert.deepEqual(calls, ['BUG-1']);
  // Delivered and removed here: a dependent started later builds on the remote branch.
  git(w.main, 'fetch', '-q', 'origin');
  removeDelivered(w.g(), w.item);
  assert.equal(stackedRef(w.main, 'feat/bug-1'), 'refs/remotes/origin/feat/bug-1');
  assert.equal(stackedRef(w.main, 'main'), 'main');
});

test('--keep reaches a background resume; --keep, prune.keepLocal and prune.enabled false keep everything; keepLocal is validated (ADV2-09)', async (t) => {
  assert.deepEqual(backgroundResumeArgs({ keep: true }), ['resume', '--keep']);
  assert.deepEqual(backgroundResumeArgs({}), ['resume']);
  const w = world(t);
  const remove = (g) => removeDelivered(g, w.item);
  for (const [env, settings, why] of [[{ FACTORY_KEEP_LOCAL: '1' }, {}, 'keep'], [{}, { keepLocal: true }, 'keep'], [{}, { enabled: false }, 'prune.enabled is false']]) {
    const r = await pruneRunLocal(w.main, remove, { label: 'BUG-1', log: () => {}, env, context: async () => w.g({ settings: { ...PRUNE_DEFAULTS, afterDelivery: true, ...settings } }) });
    assert.equal(r.skipped, why);
    assert.ok(exists(w.wt));
  }
  const logs = [];
  const r = await pruneRunLocal(w.main, remove, { label: 'BUG-1', log: (m) => logs.push(m), env: {}, context: async () => w.g({ settings: { ...PRUNE_DEFAULTS, afterDelivery: true } }) });
  assert.equal(r.removed.length, 2);
  assert.match(logs.join('\n'), /BUG-1: removed /);
  assert.deepEqual(pruneProblems({ keepLocal: 'yes' }), ['prune.keepLocal must be true or false']);
});

// ---- round 4 -----------------------------------------------------------------------------------------------------------

test('the before checkout writes nothing outside itself: a tracked link at its config, a scenarios folder that climbs out or is absolute, a link among its scenarios are refused before any write (ADV2-R3-02, workspace-2)', (t) => {
  // The base commit tracks .factory/config.json as a link to a shared file outside the ticket.
  const linked = world(t);
  const shared = path.join(linked.tmp, 'shared-config.json');
  fs.writeFileSync(shared, '{"stack":{"imageTag":"shop-teststack"}}\n');
  fs.rmSync(path.join(linked.main, '.factory/config.json'));
  fs.symlinkSync(shared, path.join(linked.main, '.factory/config.json'));
  git(linked.main, 'add', '-A');
  git(linked.main, 'commit', '-qm', 'config is a link');
  git(linked.wt, 'merge', '-q', 'main');
  assert.throws(() => baseCheckout(linked.wt, 'main'), /\.factory\/config\.json in the before checkout goes through a link/);
  assert.equal(fs.readFileSync(shared, 'utf8'), '{"stack":{"imageTag":"shop-teststack"}}\n', 'the shared file is unchanged');
  // A scenarios folder that climbs out of the checkout, or an absolute one.
  for (const scenariosDir of ['../../../../../../victim', path.join(os.tmpdir(), 'victim-abs')]) {
    const w = world(t);
    const victim = path.resolve(w.wt, '.factory/state/demo-base/x', scenariosDir);
    fs.mkdirSync(path.join(w.wt, scenariosDir.startsWith('/') ? scenariosDir : '.factory/s'), { recursive: true });
    fs.writeFileSync(path.join(w.wt, '.factory/config.json'), JSON.stringify({ stack: { scenariosDir } }));
    assert.throws(() => baseCheckout(w.wt, 'main'), /not a plain path inside it/, scenariosDir);
    assert.ok(!fs.existsSync(path.join(victim, 'seed.json')));
  }
  // The base tracks a link inside its scenarios folder: the copy would write through it.
  const inner = world(t);
  const outside = path.join(inner.tmp, 'outside.json');
  fs.writeFileSync(outside, 'theirs');
  fs.mkdirSync(path.join(inner.main, '.factory/stack/scenarios'), { recursive: true });
  fs.symlinkSync(outside, path.join(inner.main, '.factory/stack/scenarios/s.json'));
  git(inner.main, 'add', '-A');
  git(inner.main, 'commit', '-qm', 'a linked scenario');
  git(inner.wt, 'merge', '-q', 'main');
  fs.rmSync(path.join(inner.wt, '.factory/stack/scenarios/s.json'));
  fs.writeFileSync(path.join(inner.wt, '.factory/stack/scenarios/s.json'), '{"mine":true}');
  assert.throws(() => baseCheckout(inner.wt, 'main'), /scenarios\/s\.json in the before checkout goes through a link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'theirs');
});

// ---- round 5 -----------------------------------------------------------------------------------------------------------

test('the before checkout reads the scenarios without following links and copies them file by file: a linked folder, a link among them, an empty folder beyond a tracked link are refused (tidy-2, workspace-2)', (t) => {
  // The base tracks a scenarios sub-folder as a link out of the ticket; the ticket has an empty folder under that name.
  const w = world(t);
  const outside = path.join(w.tmp, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(w.main, '.factory/stack/scenarios'), { recursive: true });
  fs.symlinkSync(outside, path.join(w.main, '.factory/stack/scenarios/sub'));
  git(w.main, 'add', '-A');
  git(w.main, 'commit', '-qm', 'a linked scenario folder');
  git(w.wt, 'merge', '-q', 'main');
  fs.rmSync(path.join(w.wt, '.factory/stack/scenarios/sub'));
  fs.mkdirSync(path.join(w.wt, '.factory/stack/scenarios/sub/deeper'), { recursive: true });
  assert.throws(() => baseCheckout(w.wt, 'main'), /scenarios\/sub in the before checkout goes through a link/);
  assert.deepEqual(fs.readdirSync(outside), [], 'no folder was made through the link');
  // A link in the ticket's own scenarios (to a folder or a file anywhere): nothing is copied, no before run.
  for (const target of [outside, path.join(w.tmp, 'origin.git', 'HEAD')]) {
    const v = world(t);
    fs.mkdirSync(path.join(v.wt, '.factory/stack/scenarios'), { recursive: true });
    fs.writeFileSync(path.join(v.wt, '.factory/stack/scenarios/plain.json'), '{}');
    fs.symlinkSync(target, path.join(v.wt, '.factory/stack/scenarios/linked'));
    assert.throws(() => baseCheckout(v.wt, 'main'), /scenarios\/linked in the scenarios is a link/);
    const made = path.join(v.wt, '.factory/state/demo-base', git(v.main, 'rev-parse', 'main').slice(0, 12), '.factory/stack/scenarios/plain.json');
    assert.ok(!fs.existsSync(made), 'nothing was copied before the refusal');
  }
});

test('the before checkout refuses a destination file with other names (a hard link), scenarios and config alike, and never takes an empty folder Git did not register (workspace-2)', (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.wt, '.factory/stack/scenarios'), { recursive: true });
  fs.writeFileSync(path.join(w.wt, '.factory/stack/scenarios/seed.json'), '{"v":1}');
  const first = baseCheckout(w.wt, 'main');
  // The checkout's scenario is made another name of a file outside it: a copy would change that file.
  const shared = path.join(w.tmp, 'shared-seed.json');
  fs.writeFileSync(shared, 'theirs');
  fs.rmSync(path.join(first.dir, '.factory/stack/scenarios/seed.json'));
  fs.linkSync(shared, path.join(first.dir, '.factory/stack/scenarios/seed.json'));
  fs.writeFileSync(path.join(w.wt, '.factory/stack/scenarios/seed.json'), '{"v":2}');
  assert.throws(() => baseCheckout(w.wt, 'main'), /seed\.json in the before checkout has other names \(a hard link\)/);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'theirs');
  // The same for its config.
  fs.rmSync(path.join(first.dir, '.factory/stack/scenarios/seed.json'));
  const sharedConfig = path.join(w.tmp, 'shared-config.json');
  fs.writeFileSync(sharedConfig, '{}\n');
  fs.rmSync(path.join(first.dir, '.factory/config.json'));
  fs.linkSync(sharedConfig, path.join(first.dir, '.factory/config.json'));
  assert.throws(() => baseCheckout(w.wt, 'main'), /config\.json in the before checkout has other names \(a hard link\)/);
  assert.equal(fs.readFileSync(sharedConfig, 'utf8'), '{}\n');
  // An empty folder at the destination that Git did not register: refused and left as it is, never replaced.
  const v = world(t);
  const empty = path.join(v.wt, '.factory/state/demo-base', git(v.main, 'rev-parse', 'main').slice(0, 12));
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => baseCheckout(v.wt, 'main'), /not a checkout Git registered/);
  assert.deepEqual(fs.readdirSync(empty), []);
});
