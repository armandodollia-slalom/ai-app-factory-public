// Stack slots for the feature verification stage's e2e runs. On slot 0 every story's specs take turns behind one
// machine-wide lock. With `featureVerification.slots.enabled` on (the default; FV_USE_SLOTS=0|1 overrides it), a
// story's run leases an isolated slot instead (`factory stack lease`), brings that slot's stack up from the story's worktree
// (`factory teststack --slot <n> up`), runs its specs with TESTSTACK_SLOT and TESTSTACK_URL (the stack's
// base URL) pointing at it, and tears it down. Specs with hard-coded slot-0 ports stay on slot 0, and so
// does a run that finds no free slot. See docs/ai-pipeline/feature-verification.md#stack-slots.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { appendJsonl, log, nowIso, run, runAsync } from '../../pipeline/lib/util.mjs';
import { RUN_CONDITIONS_FILE, metricsFile } from '../../pipeline/lib/state.mjs';
import { loadConfig, slotPorts } from '../../stack/lib/ports.mjs';
import { setting } from '../../pipeline/lib/settings.mjs';

// A spec runs on any slot unless it names one of slot 0's host ports literally (the `stack.ports` bases of
// the repository); e2e/teststack/ports.ts builds the URLs from TESTSTACK_SLOT instead.
export function slotAware(texts, slot0Ports = []) {
  if (slot0Ports.length === 0) return true;
  const literal = new RegExp(`(?:localhost|127\\.0\\.0\\.1|host\\.docker\\.internal):(?:${slot0Ports.join('|')})\\b`);
  return texts.every((t) => !literal.test(t));
}

export function wantsSlot(config, env = process.env) {
  // featureVerification.slots.enabled (FV_USE_SLOTS overrides it): a run borrows its own copy whenever it is on.
  if (env.FV_USE_SLOTS === '0' || env.FV_USE_SLOTS === '1') return env.FV_USE_SLOTS === '1';
  return setting(config, 'featureVerification.slots.enabled') !== false;
}

// A run's agents (the stack guard, teststack) read the slots decision from FV_USE_SLOTS: a run's CLI exports
// featureVerification.slots.enabled there, unless FV_USE_SLOTS (0 or 1) already overrides it. Returns the value.
export function exportSlots(config, env = process.env) {
  if (env.FV_USE_SLOTS !== '0' && env.FV_USE_SLOTS !== '1') env.FV_USE_SLOTS = wantsSlot(config, env) ? '1' : '0';
  return env.FV_USE_SLOTS;
}

const slotsCli = () => path.join(INSTALL_ROOT, 'scripts/stack/slots.mjs');
const teststackCli = () => path.join(INSTALL_ROOT, 'scripts/teststack/teststack.mjs');

// How long a run waits for a free slot before it gives up (featureVerification `slotWaitSec`, default 6 h). A ceiling:
// leases whose owner died are reclaimed, so a run waits only on live runs, which slow agents make slower (council C12).
export const slotWaitSec = (config) => Number(setting(config, 'featureVerification.slotWaitSec'));

// The message a stage stops with when no slot came free in time: tests against a stack running another
// checkout's code do not count, so nothing runs on slot 0 instead (council C3, D-C6-1).
export const NO_SLOT = 'No free test-stack slot';
export const noSlotMessage = (key, waitSec, pool) => `${NO_SLOT} for ${key} after ${waitSec} s (all ${pool ?? '?'} leasable slots are held by other runs; \`stack.poolSize\` sets how many). The end-to-end tests did not run: a stack running another checkout's code (slot 0) would not count. Run the story again when a slot is free, or raise \`stack.poolSize\` if Docker has room.`;

export const defaultSlotDeps = {
  slot0Ports: (root) => Object.values(slotPorts(0, loadConfig(root))),
  lease: async (owner, root, waitSec = 0) => {
    const r = await runAsync(process.execPath, [slotsCli(), 'lease', '--root', root, '--owner', owner, '--pid', String(process.pid), ...(waitSec ? ['--wait-sec', String(waitSec)] : [])], { cwd: root, timeoutSec: waitSec + 120 });
    try {
      const out = JSON.parse(String(r.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '');
      return out?.ok ? out : { ok: false, poolSize: out?.poolSize ?? null, error: out?.error ?? null };
    } catch {
      return { ok: false, poolSize: null, error: null };
    }
  },
  release: (slot, root) => run(process.execPath, [slotsCli(), 'release', '--root', root, '--slot', String(slot)], { cwd: root, timeoutSec: 120 }),
  teststack: (root, slot, args, timeoutSec) => runAsync(process.execPath, [teststackCli(), '--root', root, '--slot', String(slot), ...args], { cwd: root, timeoutSec }),
};

function stackDownMessage(slot, up) {
  const output = `${up.stderr ?? ''}\n${up.stdout ?? ''}`.trim().split('\n');
  const baseline = output.filter((l) => /Baseline:|No baseline build/.test(l));
  return `The test stack did not build or start (slot ${slot}, exit ${up.status}), so no end-to-end test ran. This is not a test result and not a product bug of this story unless the baseline says the change breaks the build.\n${baseline.join('\n') || 'No baseline verdict was reported.'}\nLast output:\n${output.slice(-25).join('\n')}`;
}

// One record per lease attempt (run-conditions.jsonl), for the PR body and the retro.
function recordSlot(config, key, stage, startedMs, lease, extra = {}) {
  try {
    appendJsonl(metricsFile(config, RUN_CONDITIONS_FILE), [{ ts: nowIso(), story: key, kind: 'stack-slot', stage, slot: lease?.ok ? lease.slot : null, waitedSec: Math.round((Date.now() - startedMs) / 1000), outcome: lease?.ok ? 'leased' : 'none', poolSize: lease?.poolSize ?? null, ...extra }]);
  } catch {
    /* records are best effort */
  }
}

// A slot held for a story's whole automation pass (council C4, wall-clock): the agent's sessions and every precheck
// round use the same slot, which stays up between them. Before, the agent and each precheck round leased their own
// slot, and every precheck round built all images on a cold slot (slot images are tagged per slot), started the stack
// and took it down again. A precheck round on the held slot rebuilds only the services the change touched since the
// slot's last build (`teststack rebuild-changed`), and the slot is taken down once, when the pass ends.
const held = new Map();

export async function holdStorySlot(config, key, fn, deps = defaultSlotDeps) {
  if (!wantsSlot(config) || held.has(key)) return fn();
  const started = Date.now();
  const waitSec = slotWaitSec(config);
  log(`${key}: leasing a test-stack slot for the automation pass (waits up to ${waitSec} s)`);
  const lease = await deps.lease(`fv-${key}`, config.root, waitSec);
  recordSlot(config, key, 'automation pass', started, lease);
  // No slot: the agent session and the precheck lease their own and report the shortage as before.
  if (!lease?.ok) return fn();
  held.set(key, { ...lease, builtAt: null });
  log(`${key}: the automation pass holds stack slot ${lease.slot} (${lease.baseUrl}) until it ends`);
  try {
    return await fn();
  } finally {
    held.delete(key);
    await deps.teststack(config.root, lease.slot, ['down'], 600);
    deps.release(lease.slot, config.root);
  }
}

// Brings the held slot up for a precheck round: the first round with `up`; later rounds rebuild only the services
// changed since the last build, then `up` (images current: no build) reloads the scenario.
async function warmUp(config, key, slot, timeoutSec, deps) {
  const h = held.get(key);
  const head = (deps.head ?? defaultHead)(config.root);
  if (h.builtAt) {
    const changed = await deps.teststack(config.root, slot, ['rebuild-changed', '--base', h.builtAt], timeoutSec);
    if (changed.status !== 0) log(`${key}: rebuilding the changed services on slot ${slot} failed (exit ${changed.status}); a full \`up\` follows`);
  }
  const up = await deps.teststack(config.root, slot, ['up'], timeoutSec);
  if (up.status === 0 && head) h.builtAt = head;
  return up;
}
const defaultHead = (root) => String(run('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutSec: 30 }).stdout ?? '').trim() || null;

// Runs the test-automation agent's session `fn(env)` on a slot of its own. The agent brings the stack up and runs
// its e2e tests itself (`factory teststack up`, which reads TESTSTACK_SLOT); without a slot of its own every
// concurrent run's agent used slot 0, whose images are tagged per slot, not per worktree, so one run's agent
// tested another run's code (dogfood C6). Under `implement run` it waits up to `slotWaitSec` for a slot and, when
// none comes free, does not run at all: it returns { noSlot: message } and the stage escalates (council C3, D-C6-1).
// The slot is torn down and released when the session ends, whatever its outcome. Outside `implement run` (a
// developer's own checkout) the agent uses slot 0 as before.
export async function withAgentSlot(config, key, fn, deps = defaultSlotDeps, { stage = 'automation agent', owner = `fv-agent-${key}`, waitSec: waitOverride = null } = {}) {
  deps = deps ?? defaultSlotDeps;
  if (!wantsSlot(config)) return fn({});
  const h = held.get(key);
  if (h) return fn({ TESTSTACK_SLOT: String(h.slot), TESTSTACK_URL: h.baseUrl });
  const started = Date.now();
  const waitSec = waitOverride ?? slotWaitSec(config);
  log(`${key}: leasing a test-stack slot for the ${stage} (waits up to ${waitSec} s)`);
  const lease = await deps.lease(owner, config.root, waitSec);
  recordSlot(config, key, stage, started, lease);
  if (!lease?.ok) {
    const message = noSlotMessage(key, waitSec, lease?.poolSize);
    log(`${key}: ${message}`);
    return { noSlot: message };
  }
  log(`${key}: the ${stage} works on stack slot ${lease.slot} (${lease.baseUrl}${Date.now() - started > 5000 ? `, after waiting ${Math.round((Date.now() - started) / 1000)} s` : ''})`);
  try {
    return await fn({ TESTSTACK_SLOT: String(lease.slot), TESTSTACK_URL: lease.baseUrl });
  } finally {
    await deps.teststack(config.root, lease.slot, ['down'], 600);
    deps.release(lease.slot, config.root);
  }
}

// Runs `fn(env)` on a leased slot when the story's specs allow it, else returns null so the caller uses the slot-0
// lock (outside `implement run` only). `fn` gets the environment for the test command (TESTSTACK_SLOT, TESTSTACK_URL).
// Under `implement run` there is no slot-0 fallback: slot 0 holds whatever checkout last built it, so it waits up to
// `slotWaitSec` for a lease and otherwise returns the no-slot error (council C3, D-C6-1).
export async function onLeasedSlot(config, { key, specFiles, timeoutSec }, fn, deps = defaultSlotDeps) {
  if (!wantsSlot(config)) return null;
  const texts = specFiles.map((f) => {
    try {
      return fs.readFileSync(path.join(config.root, f), 'utf8');
    } catch {
      return '';
    }
  });
  if (!slotAware(texts, (deps.slot0Ports ?? defaultSlotDeps.slot0Ports)(config.root))) {
    return [`The story's end-to-end specs name slot 0's host ports literally, so they can only test slot 0, which may hold another checkout's code under \`implement run\`. Build the URLs from TESTSTACK_SLOT (the e2e ports helper) so they run on a leased slot of their own.`];
  }
  const h = held.get(key);
  if (h) {
    const started = Date.now();
    const up = await warmUp(config, key, h.slot, timeoutSec, deps);
    // Held slot: no wait for a slot; the time is the bring-up after a change (D-C9-2), recorded as such.
    recordSlot(config, key, 'precheck', Date.now(), { ok: true, slot: h.slot }, { held: true, upSec: Math.round((Date.now() - started) / 1000) });
    if (up.status !== 0) return [stackDownMessage(h.slot, up)];
    log(`${key}: running the specs on held stack slot ${h.slot} (${h.baseUrl})`);
    return fn({ TESTSTACK_SLOT: String(h.slot), TESTSTACK_URL: h.baseUrl });
  }
  const started = Date.now();
  const waitSec = slotWaitSec(config);
  const lease = await deps.lease(`fv-${key}`, config.root, waitSec);
  recordSlot(config, key, 'precheck', started, lease);
  if (!lease?.ok) {
    log(`${key}: no free stack slot after ${waitSec} s; the end-to-end tests do not run`);
    return [noSlotMessage(key, waitSec, lease?.poolSize)];
  }
  try {
    const up = await deps.teststack(config.root, lease.slot, ['up'], timeoutSec);
    if (up.status !== 0) {
      // The stack is the tests' environment: when it cannot be built or started, that is the finding, never the
      // tests' failures against a stack that is not there (dogfood C5: specs run on an idle slot 0 failed with
      // connection refused and were reported as a product bug). The build retries once and says whether the base
      // commit builds (teststack images.mjs).
      log(`${key}: slot ${lease.slot} did not come up (exit ${up.status})`);
      return [stackDownMessage(lease.slot, up)];
    }
    log(`${key}: running the specs on stack slot ${lease.slot} (${lease.baseUrl})`);
    return await fn({ TESTSTACK_SLOT: String(lease.slot), TESTSTACK_URL: lease.baseUrl });
  } finally {
    await deps.teststack(config.root, lease.slot, ['down'], timeoutSec);
    deps.release(lease.slot, config.root);
  }
}
