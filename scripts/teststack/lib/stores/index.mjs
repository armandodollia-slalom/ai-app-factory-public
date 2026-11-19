// Store adapters. A store is one datastore of the stack (a database server, a cache, a broker), configured
// under teststack.stores.<name>; its `type` picks the adapter: a built-in one below, or the path of a module
// with the same interface ("pack:<path>" inside a language pack, anything else inside the app repository).
//
// An adapter is a module that exports (only `normalize` and `probe` are required):
//
//   normalize(config, name) -> config      defaults filled in; throws on a wrong setting
//   parseSection(section, helpers) -> data validates this store's part of a scenario file (no I/O on the stack)
//   count(data) -> number                  how many steps/keys/documents that part holds (for `validate`)
//   probe(ctx) -> { detail, state? }       readiness of the server itself; throws when it does not answer
//   serviceChecks(ctx, service, state) -> [{ name, ok, detail }]   readiness of what a service owns in the store
//   clear(ctx) -> { purged? }              remove all data, keep the schema
//   load(ctx, sections) -> { count, detail? }   apply the parsed sections of every layer, in order
//   fixups(ctx)                            post-load repairs (sequences, counters)
//   usedSequences(ctx) -> [names]          for restartAfterLoad rules with when: "sequencesUsed"
//   restore(ctx) -> [pending], snapshot(ctx, pending)   --hard: recreate from a snapshot (else `clear` is used)
//   drainTwice: true                       clear again after the other stores (queues refill while they clear)
//
// ctx = { name, store, exec(argv, { input, env }), secret(name), log(message) }. `exec` runs a command inside
// the store's container (`docker compose exec -T <service> ...`) and resolves to { status, stdout, stderr },
// so adapters use the datastore's own CLI and the host needs no client library.
import { pathToFileURL } from 'node:url';
import { resolveModule } from '../../../stack/lib/ports.mjs';
import * as mongodb from './mongodb.mjs';
import * as mysql from './mysql.mjs';
import * as postgres from './postgres.mjs';
import * as rabbitmq from './rabbitmq.mjs';
import * as redis from './redis.mjs';

export const builtin = { postgres, redis, rabbitmq, mysql, mongodb };

export async function loadAdapter(type, root) {
  if (builtin[type]) return builtin[type];
  if (!type || !/[./\\:]/.test(type)) throw new Error(`unknown store type '${type}'. Built in: ${Object.keys(builtin).join(', ')}; or the path of an adapter module.`);
  const adapter = await import(pathToFileURL(resolveModule(type, root)).href);
  for (const required of ['normalize', 'probe']) {
    if (typeof adapter[required] !== 'function') throw new Error(`store adapter '${type}' must export ${required}()`);
  }
  return adapter;
}
