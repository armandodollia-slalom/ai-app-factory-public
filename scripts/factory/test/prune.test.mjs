// `factory prune` and the automatic prune of `implement run`: what goes, what a run or a lease still needs, and that a
// run pauses rather than dies on a full disk. Real git worktrees in a throwaway repository; docker, gh, ps and df are
// fakes, so no real image or install is ever touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PRUNE_DEFAULTS, applyPrune, autoPrune, compareVersions, defaultExec, formatPlan, freeGb, gather, planPrune, recordBuiltImages, waitForDisk } from '../lib/prune.mjs';

const NOW = Date.now() + 60_000; // files the test writes are older than "now"
const HOUR = 3_600_000;
const id = (n) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const write = (file, text = 'x'.repeat(5000)) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const age = (p, ms) => {
  const t = new Date(NOW - ms);
  fs.utimesSync(p, t, t);
};

// A repository with three pipeline worktrees (a, b, c), a run folder and a stack state home.
function setup({ pin = '0.2.2' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-')));
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  write(path.join(root, '.gitignore'), 'bin/\nobj/\nartifacts/\n.factory/state/\nnode_modules/\n');
  write(path.join(root, '.factory/factory.json'), JSON.stringify({ version: pin }));
  write(path.join(root, 'src/App/Program.cs'), 'class P {}');
  write(path.join(root, 'tools/bin/tracked.sh'), 'echo tracked'); // a tracked folder named bin is never build output
  git(root, 'add', '-A');
  git(root, 'add', '-f', 'tools/bin/tracked.sh');
  git(root, 'commit', '-qm', 'init');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const wtDir = path.join(base, 'app-worktrees');
  for (const k of ['a', 'b', 'c']) git(root, 'worktree', 'add', '-q', '-b', `feat/${k}`, path.join(wtDir, k));
  for (const k of ['a', 'b', 'c']) {
    const w = path.join(wtDir, k);
    write(path.join(w, 'artifacts/bin/App/App.dll'));
    write(path.join(w, 'src/App/bin/Debug/App.dll'));
    write(path.join(w, 'src/App/obj/project.assets.json'));
    write(path.join(w, 'node_modules/pkg/bin/cli.js'));
    write(path.join(w, '.factory/state/teststack/slot-1/artifacts/out.dll'));
  }
  const runs = path.join(root, '.factory/state/implement');
  fs.mkdirSync(runs, { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'leases'), { recursive: true });
  const versions = path.join(base, 'versions');
  return { base, root, wtDir, runs, home, versions, wt: (k) => path.join(wtDir, k) };
}

function fakes({ containers = [], images = {}, docker = true, prs = [], prState = {}, issues = {}, processes = '', free = 100 } = {}) {
  const exec = (cmd, args, opts = {}) => {
    if (cmd === 'docker') {
      if (!docker) return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      if (args[0] === 'ps') return { status: 0, stdout: containers.map((c) => c.id).join('\n'), stderr: '' };
      if (args[0] === 'inspect') return { status: 0, stdout: containers.map((c) => c.image).join('\n'), stderr: '' };
      if (args[0] === 'image') return { status: 0, stdout: args.slice(4).filter((i) => images[i]).map((i) => `${i} ${images[i].created} ${images[i].size ?? 1000} ${images[i].tags ?? 0}`).join('\n'), stderr: '' };
      if (args[0] === 'rmi') return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'ps') return { status: 0, stdout: processes, stderr: '' };
    if (cmd === 'df') return { status: 0, stdout: `Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 ${Math.round(free * 1024 * 1024)} 50% /`, stderr: '' };
    return defaultExec(cmd, args, opts);
  };
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return prs === null ? { status: 1, stdout: '', stderr: 'HTTP 502' } : { status: 0, stdout: JSON.stringify(prs.map((headRefName) => ({ headRefName, state: 'OPEN' }))), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') return prState[args[2]] ? { status: 0, stdout: JSON.stringify(prState[args[2]]), stderr: '' } : { status: 1, stdout: '', stderr: 'not found' };
    if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify({ state: issues[args[2]] ?? 'OPEN' }), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { exec, gh };
}

function ctx(s, { settings = {}, alive = () => false, ...f } = {}) {
  const { exec, gh } = fakes(f);
  return gather({
    root: s.root,
    settings: { ...PRUNE_DEFAULTS, idleMinutes: 0, ...settings },
    implementConfig: { stateDir: '.factory/state', implement: { worktreeDir: '../{repo}-worktrees' } },
    stackConfig: { stateDir: '.factory/state/teststack', leaseTtlMinutes: 240 },
    stackHome: s.home,
    versionsDir: s.versions,
    installRoot: '/nowhere/engine',
    exec,
    now: Math.max(NOW, Date.now() + 60_000), // a slow machine may pass the module's clock while a test sets up
    isAlive: alive,
    gh,
    docker: 'docker',
  });
}

const paths = (plan, kind) => plan.filter((e) => e.kind === kind).map((e) => e.path);

test('an idle worktree loses its build output (ignored bin/obj, artifacts, stack state), never tracked or node_modules folders', () => {
  const s = setup();
  const plan = planPrune(ctx(s));
  const a = paths(plan, 'build').filter((p) => p.startsWith(s.wt('a')));
  assert.deepEqual(a.map((p) => path.relative(s.wt('a'), p)).sort(), ['.factory/state/teststack', 'artifacts', 'src/App/bin', 'src/App/obj']);
  assert.ok(!plan.some((e) => e.path?.includes('node_modules')));
  assert.ok(!plan.some((e) => e.path?.includes(path.join('tools', 'bin'))));
  assert.ok(!plan.some((e) => e.kind === 'worktree'), 'the worktrees themselves stay');
});

test('a worktree a running run, a live lease or recent work needs keeps its build output', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.runs, 'batch.json'), JSON.stringify({ pid: 4242, startedAt: new Date(NOW + HOUR).toISOString(), finishedAt: null }));
  fs.writeFileSync(path.join(s.runs, 'A-1.json'), JSON.stringify({ key: 'A-1', status: 'running', worktree: s.wt('a') }));
  fs.writeFileSync(path.join(s.home, 'leases', 'slot-2.json'), JSON.stringify({ slot: 2, pid: 777, cwd: path.join(s.wt('b'), 'src'), createdAt: new Date(NOW - HOUR).toISOString() }));
  const plan = planPrune(ctx(s, { alive: (pid) => pid === 4242 || pid === 777 }));
  const owners = new Set(paths(plan, 'build').map((p) => path.relative(s.wtDir, p).split(path.sep)[0]));
  assert.deepEqual([...owners], ['c']);
  // Once the run is over and the lease's process is gone, both are idle.
  const after = planPrune(ctx(s, { alive: () => false }));
  assert.deepEqual([...new Set(paths(after, 'build').map((p) => path.relative(s.wtDir, p).split(path.sep)[0]))].sort(), ['a', 'b', 'c']);
  // Recently touched (idleMinutes): kept.
  assert.equal(planPrune(ctx(s, { settings: { idleMinutes: 10 ** 9 } })).filter((e) => e.kind === 'build').length, 0);
});

test('while a run goes, a worktree it touched (an epic or group worktree has no ticket record) is its', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.runs, 'batch.json'), JSON.stringify({ pid: 4242, startedAt: new Date(NOW - 2 * HOUR).toISOString(), finishedAt: null }));
  for (const k of ['a', 'b']) for (const d of ['artifacts', '.factory/state/teststack', '.factory/state']) age(path.join(s.wt(k), d), 5 * HOUR);
  const gitdir = (k) => path.join(s.root, '.git/worktrees', k);
  for (const k of ['a', 'b']) for (const f of ['index', 'HEAD']) age(path.join(gitdir(k), f), 5 * HOUR);
  // c is left as created (touched "now", after the run started).
  const plan = planPrune(ctx(s, { alive: (pid) => pid === 4242 }));
  assert.deepEqual([...new Set(paths(plan, 'build').map((p) => path.relative(s.wtDir, p).split(path.sep)[0]))].sort(), ['a', 'b']);
});

test('slot build folders of a checkout in use: age limit, size cap (oldest first), a leased slot is kept', () => {
  const s = setup();
  const state = path.join(s.root, '.factory/state/teststack');
  for (const n of [1, 2, 3]) write(path.join(state, `slot-${n}`, 'artifacts/x.dll'), 'y'.repeat(200_000));
  write(path.join(state, 'artifacts/x.dll'), 'y'.repeat(200_000)); // slot 0
  for (const n of [1, 2, 3]) for (const p of [path.join(state, `slot-${n}`, 'artifacts/x.dll'), path.join(state, `slot-${n}`, 'artifacts'), path.join(state, `slot-${n}`)]) age(p, n === 3 ? 48 * HOUR : n * HOUR);
  for (const p of [path.join(state, 'artifacts/x.dll'), path.join(state, 'artifacts'), state]) age(p, 30 * HOUR);
  fs.writeFileSync(path.join(s.home, 'leases', 'slot-3.json'), JSON.stringify({ slot: 3, pid: 9, cwd: s.root, createdAt: new Date(NOW - HOUR).toISOString() }));
  const busy = { alive: (pid) => pid === 9 };
  // Age limit 24 h: slot 0 (30 h) goes; slot 3 (48 h) is leased and stays; slots 1 and 2 are young.
  let plan = planPrune(ctx(s, { ...busy, settings: { slotMaxAgeHours: 24, slotMaxGb: null } }));
  assert.deepEqual(paths(plan, 'slot').map((p) => path.relative(state, p)), ['artifacts']);
  // Size cap: everything over a tiny cap goes oldest first, still never the leased slot.
  plan = planPrune(ctx(s, { ...busy, settings: { slotMaxAgeHours: 1000, slotMaxGb: 0.0001 } }));
  assert.deepEqual(paths(plan, 'slot').map((p) => path.relative(state, p)), ['artifacts', 'slot-2/artifacts', 'slot-1/artifacts']);
});

test('images: only superseded (untagged) ones the pipeline built, no slot records, no container uses, old enough', () => {
  const s = setup();
  recordBuiltImages(s.home, [id(1), id(2), id(3), id(4), id(5)]);
  write(path.join(s.root, '.factory/state/teststack/slot-1/images.ids'), `webapp:t-1 ${id(2)}\n`);
  const old = new Date(NOW - 10 * HOUR).toISOString();
  const images = { [id(1)]: { created: old }, [id(2)]: { created: old }, [id(3)]: { created: old }, [id(4)]: { created: new Date(NOW - HOUR).toISOString() }, [id(5)]: { created: old, tags: 1 } };
  const f = { images, containers: [{ id: 'c1', image: id(3) }], settings: { imageMinAgeHours: 3 } };
  const plan = planPrune(ctx(s, f)).filter((e) => e.kind === 'image');
  // 2 is recorded by a slot, 3 is a container's, 4 is too young, 5 is tagged: only 1 goes.
  assert.deepEqual(plan.map((e) => e.id), [id(1)]);
  // A worktree whose stack state goes stops keeping the images it recorded.
  write(path.join(s.wt('a'), '.factory/state/teststack/slot-1/images.ids'), `webapp:t-1 ${id(6)}\n`);
  const plan2 = planPrune(ctx(s, { ...f, images: { ...images, [id(6)]: { created: old } } })).filter((e) => e.kind === 'image');
  assert.deepEqual(plan2.map((e) => e.id).sort(), [id(1), id(6)]);
  // Docker unreachable: nothing is known, nothing goes.
  assert.equal(planPrune(ctx(s, { ...f, docker: false })).filter((e) => e.kind === 'image').length, 0);
});

test('installs: kept when a live branch pins them (HEAD, default branch, open PR, worktree in use), a process runs them, or among the newest', () => {
  const s = setup({ pin: '0.2.2' });
  for (const v of ['0.2.1', '0.2.2', '0.2.3', '0.2.4', '0.2.9', '0.2.10', '0.2.11']) write(path.join(s.versions, v, 'package.json'), '{}');
  // An open PR's branch pins 0.2.3; a merged ticket's old branch pins 0.2.4 (not live).
  for (const [branch, v] of [['open-pr', '0.2.3'], ['old', '0.2.4']]) {
    git(s.root, 'checkout', '-q', '-b', branch, 'main');
    fs.writeFileSync(path.join(s.root, '.factory/factory.json'), JSON.stringify({ version: v }));
    git(s.root, 'commit', '-qam', v);
    git(s.root, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  }
  git(s.root, 'checkout', '-q', 'main');
  const processes = `node ${path.join(s.versions, '0.2.1')}/scripts/implement/implement.mjs run\n`;
  const plan = planPrune(ctx(s, { prs: ['open-pr'], processes, settings: { keepInstalls: 2 } }));
  assert.deepEqual(paths(plan, 'install').map((p) => path.basename(p)), ['0.2.4', '0.2.9']);
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
  // The open pull requests cannot be read: any version could be pinned, none goes.
  assert.equal(planPrune(ctx(s, { prs: null, processes })).filter((e) => e.kind === 'install').length, 0);
});

test('worktrees of a merged or closed ticket go after worktreeDays, with their subtask worktrees; open, dirty or moved ones stay', () => {
  const s = setup();
  git(s.root, 'worktree', 'add', '-q', '-b', 'feat/a--s1', `${s.wt('a')}--s1`);
  const head = (k) => git(s.wt(k), 'rev-parse', 'HEAD');
  const finished = new Date(NOW - 10 * 86_400_000).toISOString();
  const rec = (k, extra) => fs.writeFileSync(path.join(s.runs, `${k.toUpperCase()}-1.json`), JSON.stringify({ key: `${k.toUpperCase()}-1`, status: 'finished', worktree: s.wt(k), finishedAt: finished, pr: `https://x/pull/${k}`, ...extra }));
  rec('a');
  rec('b');
  rec('c');
  fs.appendFileSync(path.join(s.wt('c'), 'src/App/Program.cs'), '// uncommitted');
  const prState = { 'https://x/pull/a': { state: 'MERGED', headRefOid: head('a') }, 'https://x/pull/b': { state: 'OPEN', headRefOid: head('b') }, 'https://x/pull/c': { state: 'CLOSED', headRefOid: head('c') } };
  let plan = planPrune(ctx(s, { prState, settings: { worktreeDays: 7 } }));
  assert.deepEqual(paths(plan, 'worktree').sort(), [s.wt('a'), `${s.wt('a')}--s1`]);
  // Too recent: kept.
  assert.equal(planPrune(ctx(s, { prState, settings: { worktreeDays: 30 } })).filter((e) => e.kind === 'worktree').length, 0);
  // The PR's head is not the worktree's (unpushed work): kept.
  plan = planPrune(ctx(s, { prState: { ...prState, 'https://x/pull/a': { state: 'MERGED', headRefOid: 'f'.repeat(40) } }, settings: { worktreeDays: 7 } }));
  assert.equal(plan.filter((e) => e.kind === 'worktree').length, 0);
  // Applying it removes the worktrees through git and keeps the branch.
  plan = planPrune(ctx(s, { prState, settings: { worktreeDays: 7 } }));
  const g = ctx(s, { prState, settings: { worktreeDays: 7 } });
  const done = applyPrune(g, plan);
  assert.ok(done.every((e) => e.ok), JSON.stringify(done.filter((e) => !e.ok)));
  assert.ok(!fs.existsSync(s.wt('a')) && !fs.existsSync(`${s.wt('a')}--s1`));
  assert.ok(!git(s.root, 'worktree', 'list').includes(s.wt('a') + ' '));
  assert.ok(git(s.root, 'rev-parse', '--verify', 'refs/heads/feat/a'), 'the branch is kept');
  assert.ok(fs.existsSync(s.wt('b')) && fs.existsSync(s.wt('c')));
});

test('a dry run removes nothing; applying it does, and the report says what it freed', () => {
  const s = setup();
  const g = ctx(s);
  const plan = planPrune(g);
  assert.ok(plan.length > 0);
  assert.ok(fs.existsSync(path.join(s.wt('a'), 'artifacts')));
  assert.match(formatPlan(plan, { dryRun: true }), /Would free about/);
  const done = applyPrune(g, plan);
  assert.ok(done.every((e) => e.ok));
  assert.ok(!fs.existsSync(path.join(s.wt('a'), 'artifacts')));
  assert.ok(fs.existsSync(path.join(s.wt('a'), 'src/App/Program.cs')));
  assert.match(formatPlan(done), /Freed about/);
});

test('free space is read with df; the run pauses while it is short and starts once space is back', async () => {
  const { exec } = fakes({ free: 12.5 });
  assert.equal(freeGb(os.tmpdir(), { exec }), 12.5);
  const env = { FACTORY_DISK_MIN_GB: '20', FACTORY_DISK_ROOT: '/r' };
  const seen = [3, 8, 25];
  const logs = [];
  let waits = 0;
  const waited = await waitForDisk('BUG-1', { env, room: async () => ({ ok: seen[0] >= 20, freeGb: seen.shift() }), wait: async () => waits++, log: (m) => logs.push(m), pollSec: 60 });
  assert.equal(waited, 120);
  assert.equal(waits, 2);
  assert.match(logs[0], /BUG-1: only 3 GB free, below prune.minFreeGb \(20 GB\) after pruning; paused/);
  assert.match(logs.at(-1), /25 GB free again; starting/);
  // Not set up by a run: no check at all.
  assert.equal(await waitForDisk('X', { env: {}, room: async () => assert.fail('no check') }), 0);
});

test('the automatic prune: skipped under FACTORY_PRUNE=0; prunes, then reports the room a run needs', async () => {
  const s = setup();
  assert.deepEqual(await autoPrune(s.root, { env: { FACTORY_PRUNE: '0' } }), { skipped: true, room: { ok: true, freeGb: null } });
  const logs = [];
  const low = await autoPrune(s.root, { context: async () => ctx(s, { free: 5 }), log: (m) => logs.push(m), env: {} });
  assert.equal(low.room.ok, false);
  assert.equal(low.room.freeGb, 5);
  assert.ok(low.pruned > 0);
  assert.match(logs[0], /prune \(start\): removed \d+ item\(s\), about .*; 5 GB free/);
  // prune.enabled false: nothing removed, the free-space check still applies.
  const off = await autoPrune(s.root, { context: async () => ctx(s, { free: 50, settings: { enabled: false } }), log: () => {}, env: {} });
  assert.equal(off.pruned, 0);
  assert.equal(off.room.ok, true);
});
