// MySQL / MariaDB store adapter, through the `mysql` client inside the database's container.
//
// Config: type: "mysql", service (default: the store's name), cli: "mysql" ("mariadb" on MariaDB images),
//   username: "root", passwordEnv | password, databases: [names or { name, preserveTables, migrationsReady }],
//   preserveTables: tables never truncated, migrationsReady: { table, column? } or { sql }.
// TRUNCATE resets AUTO_INCREMENT and an explicit id moves it forward, so there are no post-load fix-ups.
// --hard has no snapshots here; it clears the databases like a soft reset.
//
// Scenario section: the same as PostgreSQL's (per database, `sql` file steps and `table` + `rows` steps).
// A row's missing columns get DEFAULT; objects and lists are stored as JSON text.
import { EXIT, TestStackError, qualifiedName, quoteIdent, sqlString } from '../common.mjs';
import { count, parseSection } from './postgres.mjs';

export { count, parseSection };

const ident = name => quoteIdent(name, '`');

export function normalize(config, name) {
  const store = { service: name, cli: 'mysql', username: 'root', passwordEnv: null, password: null, preserveTables: [], migrationsReady: null, ...config };
  if (!Array.isArray(config.databases) || config.databases.length === 0) throw new Error(`teststack.stores.${name}.databases must list at least one database`);
  store.databases = config.databases.map(db => {
    const entry = typeof db === 'string' ? { name: db } : db;
    return { name: entry.name, preserveTables: entry.preserveTables ?? store.preserveTables, migrationsReady: entry.migrationsReady ?? store.migrationsReady };
  });
  return store;
}

/** A value as a MySQL literal. */
export function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const escapes = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\0': '\\0', '\x1a': '\\Z' };
  return `'${[...text].map(c => escapes[c] ?? c).join('')}'`;
}

export function insertSql(table, rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const values = rows.map(row => `(${columns.map(column => (column in row ? literal(row[column]) : 'DEFAULT')).join(', ')})`).join(', ');
  return `INSERT INTO ${qualifiedName(table, { quote: '`' })} (${columns.map(ident).join(', ')}) VALUES ${values};`;
}

export function loadScript(store, entries) {
  const lines = [];
  const ranges = [];
  const push = text => lines.push(...text.split('\n'));
  for (const { name: database } of store.databases) {
    const steps = entries.filter(entry => entry.database === database).flatMap(entry => entry.steps);
    if (steps.length === 0) continue;
    push(`USE ${ident(database)};`);
    push('START TRANSACTION;');
    for (const step of steps) {
      const from = lines.length + 1;
      push(step.kind === 'sql' ? `${step.sql.replace(/\s+$/, '')}\n;` : insertSql(step.table, step.rows));
      ranges.push({ from, to: lines.length, database, source: step.source });
    }
    push('COMMIT;');
  }
  return { script: `${lines.join('\n')}\n`, ranges, steps: ranges.length };
}

function client(ctx, script) {
  const { store } = ctx;
  const password = store.password ?? (store.passwordEnv ? ctx.secret(store.passwordEnv) : null);
  return ctx.exec([store.cli, '-u', store.username, '-N', '-B'], { input: script, env: password ? { MYSQL_PWD: password } : {} });
}

const firstError = result => (result.stderr.split('\n').find(line => line.startsWith('ERROR')) ?? result.stderr.trim().split('\n')[0] ?? '').trim();

async function mustRun(ctx, script, what) {
  const result = await client(ctx, script);
  if (result.status !== 0) throw new TestStackError(`${ctx.name}: ${what} failed: ${firstError(result) || `${ctx.store.cli} exited with ${result.status}`}`);
  return result;
}

export async function probe(ctx) {
  await mustRun(ctx, 'SELECT 1;\n', 'connecting');
  return { detail: 'accepting connections' };
}

function migrationsSql(db) {
  const probeConfig = db.migrationsReady;
  if (!probeConfig) return 'SELECT 1';
  if (typeof probeConfig === 'string') return probeConfig;
  if (probeConfig.sql) return probeConfig.sql;
  return `SELECT ${probeConfig.column ? ident(probeConfig.column) : '1'} FROM ${qualifiedName(probeConfig.table, { quote: '`' })} ORDER BY 1`;
}

export async function serviceChecks(ctx, service) {
  const mine = (service.databases ?? []).map(name => ctx.store.databases.find(db => db.name === name)).filter(Boolean);
  return Promise.all(mine.map(async db => {
    const result = await client(ctx, `USE ${ident(db.name)};\n${migrationsSql(db).replace(/;\s*$/, '')};\n`);
    const rows = result.stdout.split('\n').filter(line => line !== '');
    const name = `${db.migrationsReady ? 'migrations' : 'database'}:${db.name}`;
    if (result.status !== 0) return { name, ok: false, detail: firstError(result) };
    if (!db.migrationsReady) return { name, ok: true, detail: 'exists' };
    return rows.length > 0 ? { name, ok: true, detail: `${rows.length} applied (latest ${rows.at(-1)})` } : { name, ok: false, detail: 'no migrations applied yet' };
  }));
}

/** The statements that empty the given [database, table] pairs. */
export function clearSql(tables) {
  return ['SET FOREIGN_KEY_CHECKS = 0;', ...tables.map(([database, table]) => `TRUNCATE TABLE ${ident(database)}.${ident(table)};`), 'SET FOREIGN_KEY_CHECKS = 1;', ''].join('\n');
}

export async function clear(ctx) {
  const names = ctx.store.databases.map(db => sqlString(db.name)).join(', ');
  const listed = await mustRun(ctx, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN (${names}) ORDER BY 1, 2;\n`, 'listing tables');
  const tables = listed.stdout.split('\n').filter(Boolean).map(line => line.split('\t')).filter(([database, table]) => {
    const preserve = ctx.store.databases.find(db => db.name === database)?.preserveTables ?? [];
    return !preserve.includes(table) && !preserve.includes(`${database}.${table}`);
  });
  if (tables.length) await mustRun(ctx, clearSql(tables), 'clearing');
  return {};
}

export async function load(ctx, sections) {
  const { script, ranges, steps } = loadScript(ctx.store, sections.flat());
  if (steps === 0) return { count: 0 };
  const result = await client(ctx, script);
  if (result.status !== 0) {
    const match = /^ERROR \d+ \([^)]*\) at line (\d+): (.*)$/m.exec(result.stderr);
    const range = match && ranges.find(r => Number(match[1]) >= r.from && Number(match[1]) <= r.to);
    if (!range) throw new TestStackError(`${ctx.name}: loading failed: ${firstError(result) || `${ctx.store.cli} exited with ${result.status}`}`);
    throw new TestStackError(`${range.database}: ${range.source} failed: ${match[2].trim()}`, EXIT.invalidScenario);
  }
  return { count: steps, detail: `${steps} step(s)` };
}
