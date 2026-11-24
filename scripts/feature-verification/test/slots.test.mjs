// feature verification e2e runs on leased stack slots: when they lease, when they stay on slot 0, and the cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportSlots, holdStorySlot, onLeasedSlot, slotAware, wantsSlot, withAgentSlot } from '../lib/slots.mjs';
import { stackGuard } from '../../pipeline/lib/story-guard.mjs';
import { slotZeroRefusal } from '../../teststack/teststack.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-slots-'));
fs.mkdirSync(path.join(root, 'e2e/teststack'), { recursive: true });
fs.mkdirSync(path.join(root, '.factory'));
fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ project: { name: 'fv-slots' }, stack: { ports: { web: { base: 18080 }, auth: { base: 18081 }, catalog: { base: 18082 } } } }));
fs.writeFileSync(path.join(root, 'e2e/teststack/good.spec.ts'), "import { CATALOG_URL } from './ports';\ntest('TC-X-1-01', () => fetch(`${CATALOG_URL}/api`));\n");
fs.writeFileSync(path.join(root, 'e2e/teststack/old.spec.ts'), "test('TC-X-1-02', () => fetch('http://localhost:18082/api'));\n");

const fakeStack = ({ lease = { ok: true, slot: 3, baseUrl: 'http://localhost:21080' }, upStatus = 0, upOutput = '' } = {}) => {
  const calls = [];
  const waits = [];
  return {
    calls,
    waits,
    deps: {
      lease: async (owner, r, waitSec) => (calls.push(['lease', owner]), waits.push(waitSec), lease ? { ok: true, ...lease } : { ok: false, poolSize: 1 }),
      release: (slot) => calls.push(['release', slot]),
      teststack: async (r, slot, args) => (calls.push(['teststack', slot, ...args]), { status: args[0] === 'up' ? upStatus : 0, stderr: args[0] === 'up' ? upOutput : '' }),
    },
  };
};

const withEnv = async (vars, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

test('slotAware: specs that name a slot-0 host port of the stack literally stay on slot 0', () => {
  const ports = [18080, 18081];
  assert.equal(slotAware(["fetch(`${CATALOG_URL}/x`)"], ports), true);
  assert.equal(slotAware(["'http://localhost:18080/'"], ports), false);
  assert.equal(slotAware(["'http://host.docker.internal:18081/Account'"], ports), false);
  assert.equal(slotAware(["'http://localhost:180801/'", "'http://localhost:3000/'"], ports), true, 'other ports are not the stack\'s');
  assert.equal(slotAware(["'http://localhost:18080/'"], []), true, 'a stack without ports has no slot-0 ports');
});

// GEN-7: featureVerification.slots.enabled allows a slot whenever it is on (it used to need a parallel run or the env).
test('wantsSlot: whenever featureVerification.slots.enabled is on; FV_USE_SLOTS overrides it', () => {
  const off = { featureVerification: { slots: { enabled: false } } };
  assert.equal(wantsSlot({}, {}), true, 'the default is on, outside implement too');
  assert.equal(wantsSlot(off, {}), false);
  assert.equal(wantsSlot(off, { FV_USE_SLOTS: '1' }), true, 'the variable overrides the setting for one shell');
  assert.equal(wantsSlot({}, { FV_USE_SLOTS: '0' }), false);
});

test('onLeasedSlot: leases, brings the slot up, runs with TESTSTACK_SLOT/URL, then downs and releases it', async () => {
  const s = fakeStack();
  const out = await withEnv({ IMPLEMENT_PARALLEL: '3' }, () => onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'], timeoutSec: 60 }, async (env) => ['ran', env], s.deps));
  assert.deepEqual(out, ['ran', { TESTSTACK_SLOT: '3', TESTSTACK_URL: 'http://localhost:21080' }]);
  assert.deepEqual(s.calls, [['lease', 'fv-X-1'], ['teststack', 3, 'up'], ['teststack', 3, 'down'], ['release', 3]]);
});

test('onLeasedSlot: slot 0 (null) for slot-0 specs or no free slot; a stack that does not come up is reported, with the baseline', async () => {
  await withEnv({ IMPLEMENT_PARALLEL: '3' }, async () => {
    const run = async () => 'ran';
    // Council C3, D-C6-1: under implement run nothing runs on slot 0, which may hold another checkout's images.
    const legacy = fakeStack();
    const named = await onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts', 'e2e/teststack/old.spec.ts'] }, run, legacy.deps);
    assert.match(named[0], /name slot 0's host ports literally/);
    assert.deepEqual(legacy.calls, [], 'no lease for slot-0 specs');
    const none = fakeStack({ lease: null });
    const waited = await onLeasedSlot({ root, featureVerification: { slotWaitSec: 60 } }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'] }, run, none.deps);
    assert.match(waited[0], /^No free test-stack slot for X-1 after 60 s/);
    assert.match(waited[0], /would not count/);
    assert.deepEqual(none.waits, [60], 'it waits the configured time for a lease');
    // Dogfood C5: a stack that does not come up is the finding (with the baseline verdict), never specs run on an
    // idle slot 0 that then fail with connection refused.
    const broken = fakeStack({ upStatus: 1, upOutput: 'stack.build.all failed (1)\nBaseline: the same build also fails on the base commit abc1234: the build environment or the base is broken, not this change.' });
    const errors = await onLeasedSlot({ root }, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'] }, run, broken.deps);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^The test stack did not build or start \(slot 3, exit 1\), so no end-to-end test ran/);
    assert.match(errors[0], /Baseline: the same build also fails on the base commit abc1234/);
    assert.deepEqual(broken.calls.at(-1), ['release', 3], 'the lease is released even when up fails');
  });
  assert.equal(await onLeasedSlot({ root, featureVerification: { slots: { enabled: false } } }, { key: 'X-1', specFiles: [] }, async () => 'ran', fakeStack().deps), null, 'slots off: slot 0');
});

// Dogfood C6: every concurrent run's test-automation agent ran `factory teststack up` on slot 0, whose images are tagged
// per slot, so one run's agent tested another run's code.
test('withAgentSlot: the automation agent gets a slot of its own, torn down and released whatever the outcome', async () => {
  await withEnv({ IMPLEMENT_PARALLEL: '2' }, async () => {
    const s = fakeStack();
    assert.deepEqual(await withAgentSlot({ root }, 'X-1', async (env) => env, s.deps), { TESTSTACK_SLOT: '3', TESTSTACK_URL: 'http://localhost:21080' });
    assert.deepEqual(s.calls, [['lease', 'fv-agent-X-1'], ['teststack', 3, 'down'], ['release', 3]], 'the agent brings it up itself');
    const failing = fakeStack();
    await assert.rejects(withAgentSlot({ root }, 'X-1', async () => { throw new Error('agent crashed'); }, failing.deps), /agent crashed/);
    assert.deepEqual(failing.calls.at(-1), ['release', 3], 'released after a failure too');
    const none = fakeStack({ lease: null });
    let ran = false;
    const r = await withAgentSlot({ root, featureVerification: { slotWaitSec: 45 } }, 'X-1', async (env) => ((ran = true), env), none.deps);
    assert.equal(ran, false, 'no free slot after the wait: the agent does not run on slot 0');
    assert.match(r.noSlot, /^No free test-stack slot for X-1 after 45 s/);
  });
  const outside = fakeStack();
  assert.deepEqual(await withAgentSlot({ root, featureVerification: { slots: { enabled: false } } }, 'X-1', async (env) => env, outside.deps), {}, 'slots off: no lease');
  assert.deepEqual(outside.calls, []);
});

// Council C3: the automation task named the install's script, which the read guard denies to agents.
test('the automation agent is told to run the precheck with the factory command, not the install path', async () => {
  const { fvCommandFor } = await import('../lib/workflows.mjs');
  assert.equal(fvCommandFor({ root: '/some/app/repo' }), 'factory feature-verification');
});

// Council C4 (wall-clock): the agent and every precheck round leased their own slot, so each round built every image
// on a cold slot, started the stack and took it down. A pass now holds one slot, warm, and takes it down once.
test('an automation pass holds one slot: the agent and every precheck round use it, warm; it goes down once', async () => {
  await withEnv({ IMPLEMENT_PARALLEL: '2' }, async () => {
    const f = fakeStack();
    const deps = { ...f.deps, head: () => 'c0ffee' };
    const config = { root };
    const seen = [];
    await holdStorySlot(config, 'X-1', async () => {
      seen.push(await withAgentSlot(config, 'X-1', async (env) => env, deps));
      seen.push(await onLeasedSlot(config, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'], timeoutSec: 60 }, async (env) => env.TESTSTACK_SLOT, deps));
      seen.push(await withAgentSlot(config, 'X-1', async (env) => env.TESTSTACK_SLOT, deps));
      seen.push(await onLeasedSlot(config, { key: 'X-1', specFiles: ['e2e/teststack/good.spec.ts'], timeoutSec: 60 }, async (env) => env.TESTSTACK_SLOT, deps));
    }, deps);
    assert.deepEqual(seen, [{ TESTSTACK_SLOT: '3', TESTSTACK_URL: 'http://localhost:21080' }, '3', '3', '3']);
    assert.deepEqual(f.calls, [
      ['lease', 'fv-X-1'],
      ['teststack', 3, 'up'],
      ['teststack', 3, 'rebuild-changed', '--base', 'c0ffee'],
      ['teststack', 3, 'up'],
      ['teststack', 3, 'down'],
      ['release', 3],
    ]);
  });
});

test('without a slot for the pass, the agent and the precheck lease their own as before', async () => {
  await withEnv({ IMPLEMENT_PARALLEL: '2' }, async () => {
    const f = fakeStack({ lease: null });
    const r = await holdStorySlot({ root }, 'X-2', async () => withAgentSlot({ root }, 'X-2', async () => 'ran', f.deps), f.deps);
    assert.deepEqual(r, { noSlot: r.noSlot });
    assert.equal(f.calls.filter((c) => c[0] === 'lease').length, 2);
  });
});

test('another role (the PR check fixer) leases its own slot with its own owner, stage and wait', async () => {
  await withEnv({ IMPLEMENT_PARALLEL: '2' }, async () => {
    const f = fakeStack();
    const seen = await withAgentSlot({ root }, 'X-3', async (env) => env.TESTSTACK_SLOT, f.deps, { stage: 'pr-check fixer', owner: 'pr-check-fixer-pr-9', waitSec: 300 });
    assert.equal(seen, '3');
    assert.deepEqual(f.calls[0], ['lease', 'pr-check-fixer-pr-9']);
    assert.equal(f.waits[0], 300);
    assert.deepEqual(f.calls.slice(-2), [['teststack', 3, 'down'], ['release', 3]]);
  });
});

// Council r1 (A5): the PR check forced FV_USE_SLOTS=1, so slots.enabled off was ignored by its agents' guards.
test('a run exports featureVerification.slots.enabled to its agents: off, the stack guard and teststack leave slot 0 open even under implement', () => {
  const off = { featureVerification: { slots: { enabled: false } } };
  const env = { IMPLEMENT_PARALLEL: '2' };
  assert.equal(exportSlots(off, env), '0');
  const agent = { ...env, PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer' };
  assert.equal(stackGuard({}, { tool_name: 'Bash', tool_input: { command: 'npx playwright test' } }, agent), null);
  assert.equal(slotZeroRefusal('up', 0, agent), null);
  assert.equal(exportSlots({}, {}), '1', 'on by default');
  assert.equal(exportSlots(off, { FV_USE_SLOTS: '1' }), '1', 'FV_USE_SLOTS overrides it');
  assert.ok(stackGuard({}, { tool_name: 'Bash', tool_input: { command: 'npx playwright test' } }, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer', FV_USE_SLOTS: exportSlots({}, {}) }), 'on: the guard refuses an agent without a slot');
});
