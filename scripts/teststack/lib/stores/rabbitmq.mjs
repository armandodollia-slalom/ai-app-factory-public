// RabbitMQ store adapter, through `rabbitmqctl` inside the broker's container. It holds no scenario data:
// it purges the configured queues on every reset and reports whether each service's queues have a consumer.
//
// Config: type: "rabbitmq", service (default: the store's name), vhost: "/", queues: [names to purge],
//   user: "rabbitmq" (the container user rabbitmqctl runs as).
// A service entry lists the queues it consumes in `queues`; each must exist with at least one consumer.
import { TestStackError } from '../common.mjs';

export const drainTwice = true;

export function normalize(config, name) {
  return { service: name, vhost: '/', queues: [], user: 'rabbitmq', ...config };
}

// rabbitmqctl runs as the broker's own user: run as root while the broker is still starting, it would create
// the Erlang cookie file with root as its owner, and the broker then fails to read it and exits.
const ctl = (ctx, args) => ctx.exec(['rabbitmqctl', '-q', ...args], { user: ctx.store.user || undefined });

/** Every queue of the vhost: Map name -> { messages, consumers }. Never creates a queue the services own. */
export async function inspect(ctx) {
  const result = await ctl(ctx, ['--formatter', 'json', 'list_queues', '-p', ctx.store.vhost, 'name', 'messages_ready', 'consumers']);
  if (result.status !== 0) throw new TestStackError(`${ctx.name}: list_queues failed: ${result.stderr.trim().split('\n')[0] || `rabbitmqctl exited with ${result.status}`}`);
  let rows;
  try {
    rows = JSON.parse(result.stdout.trim() || '[]');
  } catch {
    throw new TestStackError(`${ctx.name}: list_queues printed no JSON: ${result.stdout.trim().split('\n')[0]}`);
  }
  return new Map(rows.map(row => [row.name, { messages: Number(row.messages_ready ?? 0), consumers: Number(row.consumers ?? 0) }]));
}

export async function probe(ctx) {
  return { detail: 'accepting connections', state: await inspect(ctx) };
}

export function serviceChecks(ctx, service, queues) {
  return (service.queues ?? []).map(queue => {
    const name = `queue:${queue}`;
    const state = queues?.get(queue);
    if (!queues) return { name, ok: false, detail: `${ctx.name} unavailable` };
    if (!state) return { name, ok: false, detail: `not declared yet by ${service.name}` };
    if (state.consumers === 0) return { name, ok: false, detail: `no consumer (${service.name} not subscribed)` };
    return { name, ok: true, detail: `${state.consumers} consumer(s), ${state.messages} message(s)` };
  });
}

/** Drops every ready message from the configured queues that exist and are not empty. */
export async function clear(ctx) {
  const queues = await inspect(ctx);
  const full = ctx.store.queues.filter(queue => (queues.get(queue)?.messages ?? 0) > 0);
  await Promise.all(full.map(async queue => {
    const result = await ctl(ctx, ['purge_queue', '-p', ctx.store.vhost, queue]);
    if (result.status !== 0) throw new TestStackError(`${ctx.name}: purging ${queue} failed: ${result.stderr.trim().split('\n')[0]}`);
  }));
  return { purged: full.reduce((sum, queue) => sum + queues.get(queue).messages, 0) };
}
