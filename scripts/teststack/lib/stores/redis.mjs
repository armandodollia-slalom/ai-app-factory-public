// Redis store adapter, through `redis-cli` inside the Redis container.
//
// Config: type: "redis", service (default: the store's name), passwordEnv | password, database (default 0).
//
// Scenario section:
//   <store>:
//     - key: /basket/user-1
//       json: { ... }                  # stored as compact JSON; or value: "raw string"
//       ttl: 60                        # optional, seconds
import { TestStackError } from '../common.mjs';
import { checkKeys } from '../scenario.mjs';

const ENTRY_KEYS = ['key', 'value', 'json', 'ttl'];

export function normalize(config, name) {
  return { service: name, passwordEnv: null, password: null, database: 0, ...config };
}

export function parseSection(section, h) {
  if (!Array.isArray(section)) throw h.invalid(`'${h.location}' must be a list.`);
  return section.map((entry, i) => {
    const location = `${h.location}[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw h.invalid(`${location} must be a mapping.`);
    checkKeys(entry, ENTRY_KEYS, h.invalid, location);
    if (entry.key === undefined || entry.key === null) throw h.invalid(`${location}: 'key' is required.`);
    if (('json' in entry) === ('value' in entry)) throw h.invalid(`${location}: set exactly one of 'value' or 'json'.`);
    const value = 'json' in entry ? JSON.stringify(entry.json ?? null) : String(entry.value ?? '');
    let ttl = null;
    if (entry.ttl !== undefined && entry.ttl !== null) {
      if (!/^\d+$/.test(String(entry.ttl)) || Number(entry.ttl) <= 0) throw h.invalid(`${location}: 'ttl' must be a positive number of seconds.`);
      ttl = Number(entry.ttl);
    }
    return { key: String(entry.key), value, ttl };
  });
}

export const count = parsed => parsed.length;

function cli(ctx, args, input) {
  const { store } = ctx;
  const password = store.password ?? (store.passwordEnv ? ctx.secret(store.passwordEnv) : null);
  const argv = ['redis-cli', ...(store.database ? ['-n', String(store.database)] : []), ...args];
  return ctx.exec(argv, { input, env: password ? { REDISCLI_AUTH: password } : {} });
}

async function expect(ctx, args, reply, what) {
  const result = await cli(ctx, args);
  const out = result.stdout.trim();
  if (result.status !== 0 || out !== reply) throw new TestStackError(`${ctx.name}: ${what} failed: ${out || result.stderr.trim() || `redis-cli exited with ${result.status}`}`);
}

export async function probe(ctx) {
  await expect(ctx, ['PING'], 'PONG', 'PING');
  return { detail: 'PONG' };
}

/** Removes every key of every database. */
export async function clear(ctx) {
  await expect(ctx, ['FLUSHALL'], 'OK', 'FLUSHALL');
  return {};
}

/** One command in the Redis wire protocol, which is safe for any key or value. */
export function respCommand(args) {
  return `*${args.length}\r\n${args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
}

/** SET for every entry of every layer (later layers overwrite earlier ones), sent in one `redis-cli --pipe`. */
export async function load(ctx, sections) {
  const entries = sections.flat();
  if (entries.length === 0) return { count: 0 };
  const input = entries.map(e => respCommand(['SET', e.key, e.value, ...(e.ttl ? ['EX', String(e.ttl)] : [])])).join('');
  const result = await cli(ctx, ['--pipe'], input);
  const errors = /errors: (\d+), replies: (\d+)/.exec(result.stdout);
  if (result.status !== 0 || !errors || errors[1] !== '0' || Number(errors[2]) !== entries.length) {
    throw new TestStackError(`${ctx.name}: loading ${entries.length} key(s) failed: ${(result.stdout + result.stderr).trim() || `redis-cli exited with ${result.status}`}`);
  }
  return { count: entries.length, detail: `${entries.length} key(s)` };
}
