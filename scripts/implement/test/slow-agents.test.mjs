// Council C12 (D-C12-2): BUG-41's PR opened with "PR check: running" because implement waited a fixed 30 minutes for
// the Stop hook's PR check while its agents were slow, and nothing acted on the check's result afterwards. Slow agents
// must only make a run slower: the wait follows the check to its end, a dead check is restarted, and a check that does
// not complete holds the PR for a person. Agents themselves stop only on no progress or at a ceiling.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateState } from '../../pipeline/lib/state.mjs';
import { ceiling, supervise, SUPERVISOR } from '../../pipeline/lib/agents.mjs';
import { heldBlock, mergeDecisions, prCheckIncomplete, prCheckSection, waitForHookPrCheck } from '../lib/implement.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function cfg() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-agents-'));
  return { root, stateDir: '.factory/state', recovery: { startingGraceSec: 120, maxAttempts: 3, backoffSec: 30 } };
}

// A fake clock: each wait advances it; the check's state follows a script of (minute -> fields).
function scripted(config, key, script) {
  let t = 0;
  const now = () => t;
  const wait = async (ms) => {
    t += ms;
    const due = script.filter(([min]) => min * 60_000 <= t).pop();
    if (due) updateState(config, key, (s) => Object.assign(s.prCheck, due[1]));
  };
  return { now, wait };
}

test('reproduction: a check still running after 30 minutes was taken as it stood; now the wait follows it to the end (BUG-41)', async () => {
  const config = cfg();
  updateState(config, 'BUG-41', (s) => Object.assign(s.prCheck, { status: 'running', pid: process.pid, boot: null }));
  // The check's slow agents finish after 72 minutes with FAIL 9/10 (as BUG-41's did).
  const clock = scripted(config, 'BUG-41', [[72, { status: 'done', verdict: 'FAIL', score: 9, openFindings: [{ id: 'FLOW-1-1', severity: 'minor', lens: 'flow', title: 'x' }], sideEffects: ['a', 'b'] }]]);
  const prc = await waitForHookPrCheck(config, 'BUG-41', { ceilingSec: 144000, pollSec: 15, died: () => false, ...clock });
  assert.equal(prc.status, 'done');
  assert.equal(prc.verdict, 'FAIL');
  assert.equal(prc.sideEffects.length, 2, 'the result reaches the PR body and fix mode');
  assert.ok(clock.now() >= 72 * 60_000);
  assert.equal(prCheckIncomplete(prc), null);
});

test('a check whose process died is restarted, and a crashed one ends the wait as not complete', async () => {
  const config = cfg();
  updateState(config, 'K-1', (s) => Object.assign(s.prCheck, { status: 'running', pid: 999999, boot: 'x' }));
  let restarts = 0;
  const clock = scripted(config, 'K-1', [[3, { status: 'crashed', reason: 'the background check died 3 times' }]]);
  const prc = await waitForHookPrCheck(config, 'K-1', { pollSec: 15, died: () => true, recover: () => restarts++, ...clock });
  assert.ok(restarts >= 1);
  assert.equal(prc.status, 'crashed');
  const d = prCheckIncomplete(prc, { issues: [172] });
  assert.equal(d.outcome, 'pr-check-incomplete');
  assert.match(d.reason, /the PR check did not complete \(crashed: the background check died 3 times\): not delivered/);
  assert.deepEqual(d.issues, [172]);
});

test('only a check that never finishes ends at the ceiling, and that holds the PR', async () => {
  const config = cfg();
  updateState(config, 'K-2', (s) => Object.assign(s.prCheck, { status: 'running', pid: process.pid }));
  const clock = scripted(config, 'K-2', []);
  const prc = await waitForHookPrCheck(config, 'K-2', { ceilingSec: 3600, pollSec: 60, died: () => false, ...clock });
  assert.equal(prc.status, 'timed-out');
  assert.match(prCheckIncomplete(prc).reason, /timed-out: still running at the 3600 s ceiling/);
  assert.match(prCheckSection(prc), /PR check: did not complete \(timed-out: still running at the 3600 s ceiling\); this PR is not delivered and waits for a person/);
  assert.match(heldBlock(prCheckIncomplete(prc)), /^> \*\*Not delivered: waits for a person\.\*\* The PR check did not complete/);
  assert.equal(heldBlock(null), '');
});

test('a disabled hook is no reason to hold; a check never started is', () => {
  assert.equal(prCheckIncomplete({ status: 'idle' }, { enabled: false }), null);
  assert.match(prCheckIncomplete({ status: 'idle' }).reason, /did not complete \(not started\)/);
  const both = mergeDecisions({ outcome: 'ci-flaky', reason: 'CI green only with retries (t): not delivered', findings: [{ id: 'CI-FLAKY-1' }] }, prCheckIncomplete({ status: 'error', reason: 'boom' }));
  assert.equal(both.outcome, 'ci-flaky');
  assert.match(both.reason, /retries \(t\): not delivered; the PR check did not complete \(error: boom\)/);
  assert.deepEqual(both.findings.map((f) => f.id), ['CI-FLAKY-1', 'PRC-INCOMPLETE']);
});

// The supervisor, with a stand-in agent: `node -e` scripts that print, sleep and touch a heartbeat file.
const agent = (code) => [process.execPath, '-e', code];
const supervised = (args, { input = '', env = {} } = {}) => {
  const started = Date.now();
  const r = spawnSync(process.execPath, [SUPERVISOR, ...args], { input, encoding: 'utf8', env: { ...process.env, PIPELINE_SUPERVISOR_POLL_MS: '100', ...env } });
  return { ...r, ms: Date.now() - started };
};

test('the supervisor passes stdin, stdout and the exit code through', () => {
  const r = supervised(['--idle', '0', '--ceiling', '30', '--', ...agent("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('got:'+d);process.exit(3)})")], { input: 'hello' });
  assert.equal(r.stdout, 'got:hello');
  assert.equal(r.status, 3);
});

test('an agent that keeps making progress runs past its usual limit; one that stops making progress is stopped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  const hb = path.join(dir, 'session.jsonl');
  fs.writeFileSync(hb, '');
  // 6 s of work with a heartbeat every 300 ms, under a 3 s idle limit (node's own start-up on a loaded machine stays
  // under it): it finishes, past twice the idle limit.
  const alive = supervised(['--idle', '3', '--ceiling', '60', '--heartbeat', hb, '--', ...agent(`const fs=require('fs');let n=0;const t=setInterval(()=>{fs.appendFileSync(${JSON.stringify(hb)},'x');if(++n>=20){clearInterval(t);process.stdout.write('done')}},300)`)]);
  assert.equal(alive.status, 0);
  assert.equal(alive.stdout, 'done');
  // Silent and no heartbeat for longer than the idle limit: stopped as idle, exit 124.
  const stuck = supervised(['--idle', '3', '--ceiling', '60', '--heartbeat', hb, '--', ...agent('setTimeout(()=>{},60000)')]);
  assert.equal(stuck.status, 124);
  assert.match(stuck.stderr, /AGENT_SUPERVISOR: idle \d+/);
  assert.ok(stuck.ms < 30_000);
  const capped = supervised(['--idle', '0', '--ceiling', '1', '--', ...agent('setTimeout(()=>{},60000)')]);
  assert.equal(capped.status, 124);
  assert.match(capped.stderr, /AGENT_SUPERVISOR: ceiling/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('slow mode makes an agent that many times slower, alive, with the same result', () => {
  const fast = supervised(['--idle', '0', '--ceiling', '60', '--', ...agent("setTimeout(()=>process.stdout.write('ok'),400)")]);
  const slow = supervised(['--idle', '0', '--ceiling', '60', '--slow', '10', '--', ...agent("setTimeout(()=>process.stdout.write('ok'),400)")]);
  assert.equal(slow.stdout, 'ok');
  assert.equal(slow.status, 0);
  assert.ok(slow.ms >= 3600, `held for about 9x the agent's own time (${slow.ms} ms vs ${fast.ms} ms)`);
});

test('agent limits are ceilings: the supervisor gets 10x the limit and a claude session id for its heartbeat', () => {
  const config = { agent: { supervisor: { idleSec: 1800, ceilingFactor: 10 } } };
  assert.equal(ceiling(config, 1800), 18000);
  assert.equal(ceiling(config, 1800, { PIPELINE_CEILING_FACTOR: '2' }), 3600);
  const sup = supervise(config, { cmd: 'claude', cli: 'claude', args: ['-p', '--output-format', 'json'], env: {} }, { cwd: '/w/bug-41', timeoutSec: 1800, env: { CLAUDE_CONFIG_DIR: '/cfg' } });
  assert.equal(sup.cmd, process.execPath);
  const a = sup.args;
  assert.equal(a[0], SUPERVISOR);
  assert.deepEqual(a.slice(1, 5), ['--idle', '1800', '--ceiling', '18000']);
  const id = a[a.indexOf('--session-id') + 1];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(a[a.indexOf('--heartbeat') + 1], `/cfg/projects/-w-bug-41/${id}.jsonl`);
  assert.ok(sup.timeoutSec > 18000);
  // A custom agent command has no transcript: no idle stop, only the ceiling.
  const custom = supervise(config, { cmd: 'sh', cli: 'custom', args: ['-c', 'x'] }, { cwd: '/w', timeoutSec: 60, env: { PIPELINE_AGENT_SLOW: '10' } });
  assert.deepEqual(custom.args.slice(1, 5), ['--idle', '0', '--ceiling', '600']);
  assert.ok(custom.args.includes('--slow'));
  assert.ok(custom.timeoutSec >= 6000, 'the backstop covers the slow mode hold');
});

// Council C12 (PRB-7 live): implement's CI gate held a Low PR on a retry-only pass; the gate notice and a comment said so,
// but the PR body still read "PR check: PASS 10/10" with nothing about the hold.
test('an implement run that ends with a delivery decision writes it at the top of the PR body', async () => {
  const { stateDecisionInBody } = await import('../lib/implement.mjs');
  let body = 'Implements PRB-7 (generated by `pipeline implement`).\n\n- PR check (report only, before this PR): PASS 10/10\n';
  const gh = (args, o = {}) => (args[1] === 'view' ? { status: 0, stdout: JSON.stringify({ number: 184, body: `${body}\n` }) } : ((body = o.input), { status: 0, stdout: '' }));
  assert.equal(await stateDecisionInBody('a/b', 'https://github.com/a/b/pull/184', { keys: ['PRB-7'], outcome: 'ci-flaky', reason: 'CI green only with retries (TC-PRB-7-01): not delivered', issues: [180] }, { gh }), true);
  assert.match(body, /^<!-- pipeline-decision:start -->\n> \*\*Needs a person's decision: not delivered\.\*\* PRB-7: CI green only with retries \(TC-PRB-7-01\): not delivered\. The options are on the ticket \(#180\)/);
  assert.match(body, /PASS 10\/10/, 'the rest of the body stays');
  const before = body;
  await stateDecisionInBody('a/b', 'https://github.com/a/b/pull/184', { keys: ['PRB-7'], outcome: 'ci-flaky', reason: 'CI green only with retries (TC-PRB-7-01): not delivered', issues: [180] }, { gh });
  assert.equal(body, before, 'written once');
});

test('a check the hook starts late (still idle at the first read) is waited for; one that never registers ends as not started after the grace', async () => {
  const config = cfg();
  // Reproduction (full suite on a loaded machine): the run read the state before the Stop hook wrote "waiting", took
  // the idle state for a check that never started, and held a PR whose check then passed.
  const clock = scripted(config, 'K-3', [[1, { status: 'running', pid: process.pid }], [4, { status: 'done', verdict: 'PASS', score: 10 }]]);
  const prc = await waitForHookPrCheck(config, 'K-3', { pollSec: 15, died: () => false, expected: true, startGraceSec: 300, ...clock });
  assert.equal(prc.status, 'done');
  assert.equal(prCheckIncomplete(prc), null);
  // Without the hook there is nothing to wait for: the first read decides.
  const off = scripted(cfg(), 'K-4', []);
  assert.notEqual((await waitForHookPrCheck(cfg(), 'K-4', { pollSec: 15, died: () => false, expected: false, ...off })).status, 'done');
  // Never registers: after the grace it is "not started" (a held PR), not an endless wait.
  const config5 = cfg();
  const never = scripted(config5, 'K-5', []);
  const prc5 = await waitForHookPrCheck(config5, 'K-5', { pollSec: 15, died: () => false, expected: true, startGraceSec: 300, ...never });
  assert.ok(never.now() >= 300_000 && never.now() < 400_000);
  assert.match(prCheckIncomplete(prc5).reason, /not started/);
});

test('after a return to implementation, the check that sent it back is not taken for the new head\'s check', async () => {
  const config = cfg();
  updateState(config, 'K-6', (s) => Object.assign(s.prCheck, { status: 'done', hash: 'old', verdict: 'FAIL', score: 6 }));
  // The new check registers a minute later (its own hash) and finishes after four.
  const clock = scripted(config, 'K-6', [[1, { status: 'running', hash: 'new', pid: process.pid }], [4, { status: 'done', hash: 'new', verdict: 'PASS', score: 10 }]]);
  const prc = await waitForHookPrCheck(config, 'K-6', { pollSec: 15, died: () => false, expected: true, startGraceSec: 300, notHash: 'old', ...clock });
  assert.deepEqual([prc.status, prc.hash, prc.verdict], ['done', 'new', 'PASS']);
});
