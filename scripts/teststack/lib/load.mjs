// load and reset: put every store of the stack into the state a scenario describes.
//
// Soft (default): clear the stores, apply the scenario layers, run the stores' fix-ups. Services named by a
//   restartAfterLoad rule are stopped before and started after, so state they cache in memory cannot leak in.
// Hard (--hard): stop the application, restore each store from its snapshot of the migrated, empty schema
//   (stores without snapshots are cleared), start the application again, then apply the layers.
import { log } from './common.mjs';
import { composeOrThrow, ensureReady } from './readiness.mjs';
import { listScenarios, resolve } from './scenario.mjs';

const stop = (ctx, services) => (services.length ? composeOrThrow(ctx, ['stop', ...services]) : null);
const start = (ctx, services) => (services.length ? composeOrThrow(ctx, ['start', ...services]) : null);

/** Services a soft load must restart: every "always" rule, and "sequencesUsed" rules whose sequences were used. */
export async function servicesToRestart(ctx) {
  const rules = ctx.config.restartAfterLoad;
  const services = new Set(rules.filter(rule => rule.when === 'always').map(rule => rule.service));
  const conditional = rules.filter(rule => rule.when === 'sequencesUsed');
  if (conditional.length) {
    const used = (await Promise.all(ctx.stores.filter(store => store.adapter.usedSequences).map(store => store.adapter.usedSequences(store.ctx)))).flat();
    for (const rule of conditional) {
      if (rule.sequences ? rule.sequences.some(name => used.includes(name)) : used.length > 0) services.add(rule.service);
    }
  }
  return [...services];
}

async function clearStores(ctx, stores) {
  let purged = 0;
  for (const store of stores) {
    if (typeof store.adapter.clear !== 'function') continue;
    purged += (await store.adapter.clear(store.ctx))?.purged ?? 0;
  }
  return purged;
}

/** Applies the layers' sections store by store, then each store's post-load fix-ups. */
export async function applyLayers(ctx, layers) {
  for (const store of ctx.stores) {
    const sections = layers.map(layer => layer.sections[store.name]).filter(section => section !== undefined);
    if (sections.length && typeof store.adapter.load === 'function') {
      const loaded = await store.adapter.load(store.ctx, sections);
      if (loaded?.count) log(`${store.name}: ${loaded.detail ?? `${loaded.count} item(s)`}`);
    }
    if (typeof store.adapter.fixups === 'function') await store.adapter.fixups(store.ctx);
  }
}

export async function load(ctx, scenario, { hard = false, noWait = false, timeoutSec, waitOptions } = {}) {
  const started = Date.now();
  const { config } = ctx;
  const layers = await resolve(scenario, { scenariosDir: ctx.scenariosDir, baseScenario: config.baseScenario, stores: config.stores, cwd: ctx.cwd });
  log(`layers: ${layers.map(layer => layer.name).join(' -> ') || '(none)'} (${hard ? 'hard' : 'soft'} reset)`);

  const draining = ctx.stores.filter(store => store.adapter.drainTwice);
  const others = ctx.stores.filter(store => !store.adapter.drainTwice);
  const restarted = [];
  let purged = 0;

  if (hard) {
    // A hard reset restarts every application service and waits afterwards, so it also recovers a broken stack.
    const app = config.services.map(service => service.name);
    log(`stopping ${app.length} app service(s)`);
    await stop(ctx, app);
    const pending = new Map();
    for (const store of others) {
      if (typeof store.adapter.restore === 'function') pending.set(store, await store.adapter.restore(store.ctx));
      else purged += await clearStores(ctx, [store]);
    }
    purged += await clearStores(ctx, draining);
    await start(ctx, app);
    restarted.push(...app);
    await ensureReady(ctx, timeoutSec, 'after restoring the stores', waitOptions);
    if ([...pending.values()].some(list => list.length)) {
      log(`snapshotting ${[...pending.values()].flat().join(', ')}`);
      await stop(ctx, app);
      for (const [store, list] of pending) if (list.length) await store.adapter.snapshot(store.ctx, list);
      await start(ctx, app);
      await ensureReady(ctx, timeoutSec, 'after snapshotting', waitOptions);
    }
    purged += await clearStores(ctx, draining);
    await applyLayers(ctx, layers);
  } else {
    if (!noWait) await ensureReady(ctx, timeoutSec, 'before reset', waitOptions);
    const stale = await servicesToRestart(ctx);
    if (stale.length) {
      log(`stopping ${stale.join(', ')} (restartAfterLoad)`);
      await stop(ctx, stale);
    }
    purged += await clearStores(ctx, draining);
    purged += await clearStores(ctx, others);
    purged += await clearStores(ctx, draining);
    await applyLayers(ctx, layers);
    if (stale.length) {
      await start(ctx, stale);
      restarted.push(...stale);
      await ensureReady(ctx, timeoutSec, 'after restarting services', waitOptions);
    }
  }

  return {
    ok: true,
    command: scenario === null ? 'reset' : 'load',
    scenario: scenario ?? layers.at(-1)?.name ?? null,
    layers: layers.map(layer => layer.name),
    mode: hard ? 'hard' : 'soft',
    purgedMessages: purged,
    restarted,
    elapsedMs: Date.now() - started,
  };
}

/** validate: parse and resolve scenarios without touching the stack. */
export async function validate(ctx, scenarios) {
  const { config } = ctx;
  const names = scenarios.length ? scenarios : listScenarios(ctx.scenariosDir);
  const results = [];
  for (const scenario of names) {
    const layers = await resolve(scenario, { scenariosDir: ctx.scenariosDir, baseScenario: config.baseScenario, stores: config.stores, cwd: ctx.cwd });
    const stores = {};
    for (const store of config.stores) {
      if (typeof store.adapter.count !== 'function') continue;
      stores[store.name] = layers.reduce((sum, layer) => sum + (layer.sections[store.name] !== undefined ? store.adapter.count(layer.sections[store.name]) : 0), 0);
    }
    results.push({ scenario, layers: layers.map(layer => layer.name), stores });
  }
  return { ok: true, command: 'validate', scenarios: results };
}
