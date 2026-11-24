// Readiness of the whole stack. A service is ready when its container runs, the stores answer, its HTTP probe
// answers below 500, and whatever it owns in a store is there (its database is migrated, its queues have a
// consumer). `wait` polls until everything is ready and restarts a service once when it stays unready.
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { TestStackError, log, sleep } from './common.mjs';

const HTTP_TIMEOUT_MS = 5000;

/** GET that resolves to the status code. `http2: true` speaks HTTP/2 without TLS upgrade (gRPC-only ports). */
export function probeHttp(url, { http2: priorKnowledge = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (priorKnowledge) {
      const session = http2.connect(target.origin);
      const fail = error => { session.destroy(); reject(error); };
      session.setTimeout(HTTP_TIMEOUT_MS, () => fail(new Error(`no answer from ${target.host} in ${HTTP_TIMEOUT_MS / 1000}s`)));
      session.on('error', fail);
      const request = session.request({ ':path': target.pathname + target.search });
      request.on('response', headers => { session.destroy(); resolve(Number(headers[':status'])); });
      request.on('error', fail);
      request.end();
      return;
    }
    // "localhost" can resolve to ::1 first while some container runtimes publish ports on IPv4 only.
    const request = (target.protocol === 'https:' ? https : http).get(target, { timeout: HTTP_TIMEOUT_MS, autoSelectFamily: true, agent: false }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error(`no answer from ${target.host} in ${HTTP_TIMEOUT_MS / 1000}s`)));
    request.on('error', reject);
  });
}

/** Container state of every compose service: Map service -> { state, exitCode }. */
export async function containers(ctx) {
  const result = await ctx.runner.compose(['ps', '--all', '--format', 'json']);
  if (result.status !== 0) throw new TestStackError(`'docker compose ps' failed (${result.status}): ${result.stderr.trim()}`);
  const text = result.stdout.trim();
  if (!text) return new Map();
  // Older compose versions print a JSON array, newer ones one JSON object per line.
  const items = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return new Map(items.map(item => [item.Service, { state: item.State ?? '', exitCode: Number.isInteger(item.ExitCode) ? item.ExitCode : 0 }]));
}

// A refused connection tried on several addresses is an AggregateError with an empty message.
const errorDetail = error => String(error?.message || error?.errors?.[0]?.message || error?.code || error).trim().split('\n')[0];

async function attempt(name, fn, extra = {}) {
  try {
    return { name, ok: true, detail: await fn(), ...extra };
  } catch (error) {
    const detail = errorDetail(error);
    return { name, ok: false, detail: detail.startsWith(`${name}: `) ? detail.slice(name.length + 2) : detail, ...extra };
  }
}

// Databases of a store that no service entry claims are still part of readiness, as checks of the store.
function unclaimed(ctx, store) {
  const claimed = new Set(ctx.config.services.flatMap(service => service.databases ?? []));
  return (store.config.databases ?? []).map(db => db.name ?? db).filter(name => !claimed.has(name));
}

/** One readiness pass: [{ name, ok, detail }] (plus `kind` and `service`, which the JSON output leaves out). */
export async function check(ctx) {
  let states;
  try {
    states = await containers(ctx);
  } catch (error) {
    return [{ name: 'compose', ok: false, detail: errorDetail(error), kind: 'compose' }];
  }
  const { config } = ctx;
  const results = [...config.infrastructureServices, ...config.services.map(service => service.name)].map(service => {
    const state = states.get(service);
    if (!state) return { name: `container:${service}`, ok: false, detail: "not created; run 'factory teststack up'", kind: 'container', service };
    const running = state.state === 'running';
    return { name: `container:${service}`, ok: running, detail: running ? 'running' : `${state.state} (exit ${state.exitCode})`, kind: 'container', service };
  });

  const probes = await Promise.all(ctx.stores.map(async store => {
    let state;
    const result = await attempt(store.name, async () => {
      const probe = await store.adapter.probe(store.ctx);
      state = probe.state;
      return probe.detail;
    }, { kind: 'store' });
    return { result, state };
  }));
  results.push(...probes.map(probe => probe.result));
  const loose = await Promise.all(ctx.stores.map(async (store, i) => {
    const databases = unclaimed(ctx, store);
    if (!databases.length || !probes[i].result.ok || typeof store.adapter.serviceChecks !== 'function') return [];
    try {
      return (await store.adapter.serviceChecks(store.ctx, { name: store.name, databases }, probes[i].state)).map(result => ({ ...result, kind: 'store' }));
    } catch (error) {
      return [{ name: `${store.name}:databases`, ok: false, detail: errorDetail(error), kind: 'store' }];
    }
  }));
  results.push(...loose.flat());

  const perService = await Promise.all(config.services.map(async service => {
    const mine = [];
    const pending = [];
    if (service.url) {
      pending.push(attempt(`http:${service.name}`, async () => {
        const status = await ctx.http(service.url, { http2: Boolean(service.http2) });
        if (status >= 500) throw new Error(`HTTP ${status}`);
        return `HTTP ${status}`;
      }).then(result => [result]));
    }
    ctx.stores.forEach((store, i) => {
      if (typeof store.adapter.serviceChecks !== 'function') return;
      pending.push(Promise.resolve()
        .then(() => store.adapter.serviceChecks(store.ctx, service, probes[i].state))
        .catch(error => [{ name: `${store.name}:${service.name}`, ok: false, detail: errorDetail(error) }]));
    });
    for (const group of await Promise.all(pending)) mine.push(...group);
    return mine.map(result => ({ ...result, kind: 'service', service: service.name }));
  }));
  results.push(...perService.flat());
  return results;
}

export const publicCheck = ({ name, ok, detail }) => ({ name, ok, detail });

/**
 * Polls until every check passes or the timeout runs out. A service whose container runs but whose own checks
 * keep failing for `healAfterSec` while the stores are healthy is restarted once (a consumer that failed
 * to connect at startup and never retries).
 */
export async function wait(ctx, timeoutSec, { pollMs = 500, now = Date.now } = {}) {
  const started = now();
  const unreadySince = new Map();
  const healed = [];
  let lastSummary = '';
  for (;;) {
    const checks = await check(ctx);
    const failing = checks.filter(c => !c.ok);
    if (failing.length === 0) return { ready: true, checks, healed };
    const elapsed = now() - started;
    const summary = failing.map(c => c.name).join(', ');
    if (summary !== lastSummary) {
      log(`waiting (${Math.round(elapsed / 1000)}s): ${summary}`);
      lastSummary = summary;
    }
    if (elapsed >= timeoutSec * 1000) return { ready: false, checks, healed };
    await heal(ctx, checks, unreadySince, healed, elapsed);
    await sleep(pollMs);
  }
}

async function heal(ctx, checks, unreadySince, healed, elapsed) {
  const after = ctx.config.healAfterSec;
  if (!(after > 0)) return;
  const storesReady = checks.filter(c => c.kind === 'store').every(c => c.ok);
  for (const service of ctx.config.services) {
    const running = checks.some(c => c.kind === 'container' && c.service === service.name && c.ok);
    const own = checks.filter(c => c.kind === 'service' && c.service === service.name);
    if (!running || !storesReady || own.every(c => c.ok)) {
      unreadySince.delete(service.name);
      continue;
    }
    if (!unreadySince.has(service.name)) unreadySince.set(service.name, elapsed);
    if (elapsed - unreadySince.get(service.name) >= after * 1000 && !healed.includes(service.name)) {
      log(`restarting ${service.name}: unready for ${after}s (${own.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join('; ')})`);
      await composeOrThrow(ctx, ['restart', service.name]);
      healed.push(service.name);
      unreadySince.delete(service.name);
    }
  }
}

export async function composeOrThrow(ctx, args, options) {
  const result = await ctx.runner.compose(args, options);
  if (result.status !== 0) throw new TestStackError(`'docker compose ${args.join(' ')}' failed (${result.status}): ${result.stderr.trim()}`);
  return result;
}

/** Waits for readiness and throws (exit 2) with the failing checks when the timeout runs out. */
export async function ensureReady(ctx, timeoutSec, phase, options) {
  const { ready, checks } = await wait(ctx, timeoutSec, options);
  if (ready) return;
  const failing = checks.filter(c => !c.ok);
  throw new TestStackError(`Stack not ready ${phase} after ${timeoutSec}s: ${failing.map(c => `${c.name}: ${c.detail}`).join('; ')}`,
    2, { failing: failing.map(publicCheck) });
}
