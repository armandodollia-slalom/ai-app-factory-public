import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLease, reapOrphan } from '../lib/common.mjs';

// Dogfood C2: after a crash the dead run's daemons kept both language-server slots, so a resumed story ran
// without C#.
test('a slot held by a live daemon whose run died is reclaimed (the daemon is stopped); a live run keeps it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leases-'));
  const DEAD = 2 ** 22 + 12345; // no such process
  // Two real processes stand in for language server daemons (their pids must be alive).
  const [oldDaemon, newDaemon] = [spawn('sleep', ['30']), spawn('sleep', ['30'])];
  try {
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify({ slot: 0, pid: oldDaemon.pid, owner: '/wt/old', server: 'csharp', runPid: DEAD }));
    const killed = [];
    let alive = new Set([oldDaemon.pid]);
    const reap = (holder) => reapOrphan(holder, { kill: (pid) => (killed.push(pid), alive.delete(pid)), alive: (pid) => alive.has(pid), exists: () => true });
    const won = acquireLease({ owner: '/wt/new', server: 'csharp', pid: newDaemon.pid, max: 1, dir, runPid: process.pid, reap });
    assert.equal(won.ok, true);
    assert.deepEqual(killed, [oldDaemon.pid]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'slot-0.json'), 'utf8')).owner, '/wt/new');

    // The new holder's run (this process) is alive: its slot is not taken.
    alive = new Set([process.pid, newDaemon.pid]);
    const lost = acquireLease({ owner: '/wt/third', server: 'csharp', pid: 5353, max: 1, dir, runPid: process.pid, reap });
    assert.equal(lost.ok, false);
    assert.match(lost.reason, /all 1 leased language server slots are in use/);
  } finally {
    oldDaemon.kill();
    newDaemon.kill();
  }
});

test('reapOrphan leaves holders without a run (an interactive session) alone', () => {
  assert.equal(reapOrphan({ pid: process.pid }, { kill: () => assert.fail('no kill'), alive: () => true }), false);
});

// Dogfood C4: the retro removed its worktree and the C# daemon it started kept a slot (no run pid to tell).
test('a slot whose checkout no longer exists is reclaimed, whoever started it; an existing checkout keeps it', () => {
  const killed = [];
  const opts = (exists) => ({ kill: (pid) => killed.push(pid), alive: () => true, exists: (p) => exists.includes(p) });
  assert.equal(reapOrphan({ pid: 4242, owner: '/wt/removed', server: 'csharp', runPid: null }, opts([])), true);
  assert.deepEqual(killed, [4242]);
  assert.equal(reapOrphan({ pid: 4343, owner: '/wt/here', server: 'csharp', runPid: null }, opts(['/wt/here'])), false);
  assert.equal(reapOrphan({ pid: 4444, owner: '/wt/removed', runPid: null }, { ...opts([]), alive: () => false }), false, 'a dead daemon is reclaimed by acquireLease itself');
  assert.deepEqual(killed, [4242]);
});

// Dogfood C5: a finished epic's daemon kept the only slot. A run's daemons are stopped when it ends (lspd stop-run).
test('lspd stop-run stops the daemons leased under that run and frees their slots; other runs keep theirs', async () => {
  const { execFileSync } = await import('node:child_process');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'lspd-run-'));
  const leases = path.join(runtime, 'leases');
  fs.mkdirSync(leases, { recursive: true });
  const mine = spawn('sleep', ['30']);
  const other = spawn('sleep', ['30']);
  try {
    fs.writeFileSync(path.join(leases, 'slot-0.json'), JSON.stringify({ slot: 0, pid: mine.pid, owner: '/wt/gone-a', server: 'csharp', runPid: 4242 }));
    fs.writeFileSync(path.join(leases, 'slot-1.json'), JSON.stringify({ slot: 1, pid: other.pid, owner: '/wt/gone-b', server: 'csharp', runPid: 5353 }));
    const lspd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../lspd.mjs');
    const out = JSON.parse(execFileSync(process.execPath, [lspd, 'stop-run', '--run', '4242'], { env: { ...process.env, LSP_RUNTIME_DIR: runtime }, encoding: 'utf8' }).trim().split('\n').pop());
    assert.deepEqual(out.stopped.map((s) => s.pid), [mine.pid]);
    assert.deepEqual(fs.readdirSync(leases), ['slot-1.json']);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mine.exitCode !== null || mine.signalCode !== null, true, 'the run\'s daemon was stopped');
    assert.equal(other.exitCode, null, 'another run\'s daemon keeps running');
  } finally {
    mine.kill();
    other.kill();
  }
});

// Council C3: the epic planner's daemon in the main checkout held a slot, idle, while the next story ran without C#.
test('lspd stop-run --worktree stops only that checkout\'s daemon of the run', async () => {
  const { execFileSync } = await import('node:child_process');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'lspd-run-'));
  const leases = path.join(runtime, 'leases');
  fs.mkdirSync(leases, { recursive: true });
  const planner = spawn('sleep', ['30']);
  const story = spawn('sleep', ['30']);
  try {
    fs.writeFileSync(path.join(leases, 'slot-0.json'), JSON.stringify({ slot: 0, pid: planner.pid, owner: '/wt/gone-main', server: 'csharp', runPid: 4242 }));
    fs.writeFileSync(path.join(leases, 'slot-1.json'), JSON.stringify({ slot: 1, pid: story.pid, owner: '/wt/gone-story', server: 'csharp', runPid: 4242 }));
    const lspd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../lspd.mjs');
    const out = JSON.parse(execFileSync(process.execPath, [lspd, 'stop-run', '--run', '4242', '--worktree', '/wt/gone-main'], { env: { ...process.env, LSP_RUNTIME_DIR: runtime }, encoding: 'utf8' }).trim().split('\n').pop());
    assert.deepEqual(out.stopped.map((s) => s.pid), [planner.pid]);
    assert.deepEqual(fs.readdirSync(leases), ['slot-1.json'], 'the story\'s daemon of the same run keeps its slot');
  } finally {
    planner.kill();
    story.kill();
  }
});
