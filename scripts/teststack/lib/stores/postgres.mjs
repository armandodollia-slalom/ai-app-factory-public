// PostgreSQL store adapter. Everything runs through `psql` inside the database's own container, so the host
// needs no client library. The application owns the schema (its migrations run at startup); this adapter only
// clears and fills tables.
//
// Config (teststack.stores.<name>):
//   type: "postgres"
//   service: compose service of the server (default: the store's name)
//   username: "postgres", passwordEnv | password, adminDatabase: "postgres"
//   databases: ["appdb", { name: "otherdb", preserveTables: [...], migrationsReady: {...} }]
//   preserveTables: tables never truncated, as "table" or "schema.table" (a migration history table)
//   migrationsReady: how to tell that a database is migrated: { table, column? } or { sql }. The query must
//     return at least one row once migrations ran; its rows also identify the schema version for --hard.
//   sequences: [{ database, sequence, table, column }] standalone sequences (not owned by a column) to move
//     past MAX(column) after a load. Column-owned sequences (serial, identity) are always moved.
//   onMissingTemplate: what --hard does with a database that has no usable snapshot: "truncate" (default) or
//     "drop" (the application must then recreate the database from its migrations at startup).
//
// Scenario section:
//   <store>:
//     <database>:                      # steps run in order, one transaction per database
//       - sql: file.sql                # a raw SQL file, relative to the scenario file
//       - table: schema.Table          # or Table for the default schema
//         rows: [{ Column: value }]    # or rowsFile: rows.json|yaml
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, TestStackError, qualifiedName, quoteIdent, sqlString } from '../common.mjs';
import { checkKeys } from '../scenario.mjs';

const STEP_KEYS = ['sql', 'table', 'rows', 'rowsFile'];

export function normalize(config, name) {
  const store = {
    service: name, username: 'postgres', passwordEnv: null, password: null, adminDatabase: 'postgres', preserveTables: [],
    migrationsReady: null, sequences: [], templateSuffix: '__template', onMissingTemplate: 'truncate', ...config,
  };
  if (!Array.isArray(config.databases) || config.databases.length === 0) throw new Error(`teststack.stores.${name}.databases must list at least one database`);
  if (!['truncate', 'drop'].includes(store.onMissingTemplate)) throw new Error(`teststack.stores.${name}.onMissingTemplate must be "truncate" or "drop"`);
  store.databases = config.databases.map(db => {
    const entry = typeof db === 'string' ? { name: db } : db;
    return {
      name: entry.name,
      preserveTables: entry.preserveTables ?? store.preserveTables,
      migrationsReady: entry.migrationsReady ?? store.migrationsReady,
    };
  });
  const names = store.databases.map(db => db.name);
  for (const sequence of store.sequences) {
    for (const key of ['database', 'sequence', 'table', 'column']) {
      if (!sequence[key]) throw new Error(`teststack.stores.${name}.sequences entries need '${key}'`);
    }
    if (!names.includes(sequence.database)) throw new Error(`teststack.stores.${name}.sequences names unknown database '${sequence.database}'`);
  }
  return store;
}

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function parseStep(node, h, location) {
  if (!isMapping(node)) throw h.invalid(`${location} must be a mapping with 'sql' or 'table'.`);
  checkKeys(node, STEP_KEYS, h.invalid, location);
  if (node.sql !== undefined && node.sql !== null) {
    if (Object.keys(node).length !== 1) throw h.invalid(`${location}: 'sql' steps can't have other keys.`);
    const file = path.resolve(h.dir, String(node.sql));
    if (!fs.existsSync(file)) throw h.invalid(`${location}: SQL file not found: ${file}`);
    return { kind: 'sql', source: `${location} (${path.basename(file)})`, sql: fs.readFileSync(file, 'utf8') };
  }
  if (node.table === undefined || node.table === null) throw h.invalid(`${location} needs 'sql' or 'table'.`);
  const table = String(node.table);
  qualifiedName(table, { invalid: message => h.invalid(`${location}: ${message}`) });
  let rows;
  if (node.rowsFile !== undefined && node.rowsFile !== null) {
    if ('rows' in node) throw h.invalid(`${location}: use either 'rows' or 'rowsFile'.`);
    const rowsFile = path.resolve(h.dir, String(node.rowsFile));
    if (!fs.existsSync(rowsFile)) throw h.invalid(`${location}: rows file not found: ${rowsFile}`);
    rows = await h.loadDataFile(rowsFile);
    if (!Array.isArray(rows)) throw new TestStackError(`Invalid scenario ${rowsFile}: a rows file must contain a list of rows.`, EXIT.invalidScenario);
  } else {
    rows = node.rows;
    if (!Array.isArray(rows)) throw h.invalid(`${location}: 'rows' must be a list.`);
  }
  rows.forEach((row, i) => {
    if (!isMapping(row) || Object.keys(row).length === 0) throw h.invalid(`${location}.rows[${i}] must be a non-empty mapping of column: value.`);
  });
  return { kind: 'rows', source: `${location} (${table})`, table, rows: structuredClone(rows) };
}

/** Validates a scenario section and returns [{ database, steps }]. */
export async function parseSection(section, h) {
  if (!isMapping(section)) throw h.invalid(`'${h.location}' must map database names to step lists.`);
  const known = h.store.databases.map(db => db.name);
  const result = [];
  for (const [database, steps] of Object.entries(section)) {
    if (!known.includes(database)) throw h.invalid(`unknown database '${database}'. Known: ${known.join(', ')}.`);
    if (!Array.isArray(steps)) throw h.invalid(`${h.location}.${database} must be a list of steps.`);
    const parsed = [];
    for (let i = 0; i < steps.length; i++) parsed.push(await parseStep(steps[i], h, `${h.location}.${database}[${i}]`));
    result.push({ database, steps: parsed });
  }
  return result;
}

export const count = parsed => parsed.reduce((sum, entry) => sum + entry.steps.length, 0);

// ---------------------------------------------------------------- SQL

const USER_TABLES = `c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

const textArray = values => `ARRAY[${values.map(sqlString).join(', ')}]::text[]`;

/** Truncates every table except the preserved ones and restarts every sequence, in one statement. */
export function clearSql(preserveTables = []) {
  return `DO $teststack$
DECLARE tables text; s record;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname) INTO tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${USER_TABLES}
      AND c.relname <> ALL (${textArray(preserveTables)})
      AND n.nspname || '.' || c.relname <> ALL (${textArray(preserveTables)})
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e');
  IF tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
  END IF;
  -- Standalone sequences are not covered by RESTART IDENTITY.
  FOR s IN
    SELECT format('%I.%I', n.nspname, c.relname) AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
  LOOP
    EXECUTE 'ALTER SEQUENCE ' || s.name || ' RESTART';
  END LOOP;
END $teststack$;`;
}

/** Moves column-owned sequences and the configured standalone ones to MAX(column) + 1. */
export function fixupSql(sequences = []) {
  const owned = `DO $teststack$
DECLARE c record; max_id bigint;
BEGIN
  FOR c IN
    SELECT format('%I.%I', n.nspname, t.relname) AS tbl, quote_ident(a.attname) AS col,
           pg_get_serial_sequence(format('%I.%I', n.nspname, t.relname), a.attname) AS seq
      FROM pg_attribute a
      JOIN pg_class t ON t.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND pg_get_serial_sequence(format('%I.%I', n.nspname, t.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT MAX(%s)::bigint FROM %s', c.col, c.tbl) INTO max_id;
    PERFORM setval(c.seq, COALESCE(max_id, 0) + 1, false);
  END LOOP;
END $teststack$;`;
  const standalone = sequences.map(s =>
    `SELECT setval(${sqlString(qualifiedName(s.sequence))}::regclass, COALESCE((SELECT MAX(${quoteIdent(s.column)})::bigint FROM ${qualifiedName(s.table)}), 0) + 1, false);`);
  return [owned, ...standalone].join('\n');
}

// A dollar-quote tag that does not occur in the text it wraps.
function dollarTag(text) {
  let tag = '$rows$';
  for (let i = 1; text.includes(tag); i++) tag = `$rows${i}$`;
  return tag;
}

/**
 * INSERT through json_populate_recordset, so PostgreSQL converts each JSON value to the column's type.
 * Columns no row mentions keep their defaults.
 */
export function insertSql(table, rows) {
  const name = qualifiedName(table);
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].map(column => quoteIdent(column)).join(', ');
  const json = JSON.stringify(rows);
  const tag = dollarTag(json);
  return `INSERT INTO ${name} (${columns}) SELECT ${columns} FROM json_populate_recordset(NULL::${name}, ${tag}${json}${tag}::json);`;
}

const connect = database => `\\connect ${sqlString(database)}`;

/**
 * The psql script that loads `entries` ([{ database, steps }]): per database, one transaction with every step.
 * `ranges` maps script lines back to steps so a psql error can name the step that failed.
 */
export function loadScript(store, entries) {
  const lines = [];
  const ranges = [];
  const push = text => lines.push(...text.split('\n'));
  for (const { name: database } of store.databases) {
    const steps = entries.filter(entry => entry.database === database).flatMap(entry => entry.steps);
    if (steps.length === 0) continue;
    push(connect(database));
    push('BEGIN;');
    for (const step of steps) {
      const from = lines.length + 1;
      // A statement left open by a file without a final ";" must not swallow the next step.
      push(step.kind === 'sql' ? `${step.sql.replace(/\s+$/, '')}\n;` : insertSql(step.table, step.rows));
      ranges.push({ from, to: lines.length, database, source: step.source });
    }
    push('COMMIT;');
  }
  return { script: `${lines.join('\n')}\n`, ranges, steps: ranges.length };
}

// ---------------------------------------------------------------- running psql

async function psql(ctx, database, script, { tags = false, stop = true } = {}) {
  const { store } = ctx;
  const password = store.password ?? (store.passwordEnv ? ctx.secret(store.passwordEnv) : null);
  const argv = ['psql', '-X', ...(tags ? [] : ['-q']), '-At', '-v', `ON_ERROR_STOP=${stop ? 1 : 0}`, '-U', store.username, '-d', database, '-f', '-'];
  return ctx.exec(argv, { input: script, env: password ? { PGPASSWORD: password } : {} });
}

const firstError = stderr => {
  const line = stderr.split('\n').find(l => /\b(ERROR|FATAL)\b/.test(l)) ?? stderr.trim().split('\n')[0] ?? '';
  return line.replace(/^psql:[^:]*:\d+:\s*/, '').replace(/^psql: error: /, '').replace(/^(ERROR|FATAL):\s*/, '').trim();
};

async function mustRun(ctx, database, script, what, options) {
  const result = await psql(ctx, database, script, options);
  if (result.status !== 0) throw new TestStackError(`${ctx.name}: ${what} failed: ${firstError(result.stderr) || `psql exited with ${result.status}`}`);
  return result;
}

export async function probe(ctx) {
  await mustRun(ctx, ctx.store.adminDatabase, 'SELECT 1;\n', 'connecting');
  return { detail: 'accepting connections' };
}

export function migrationsSql(probeConfig) {
  if (!probeConfig) return null;
  if (typeof probeConfig === 'string') return probeConfig;
  if (probeConfig.sql) return probeConfig.sql;
  if (!probeConfig.table) throw new Error("migrationsReady needs 'table' or 'sql'");
  return `SELECT ${probeConfig.column ? quoteIdent(probeConfig.column) : 't::text'} FROM ${qualifiedName(probeConfig.table)} t ORDER BY 1`;
}

const SCHEMA_SQL = `SELECT format('%I.%I.%I %s', table_schema, table_name, column_name, data_type) FROM information_schema.columns
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`;

/** Rows of the database's migrations probe, or null when the database or its history does not exist. */
async function migrations(ctx, database, fallbackSql = 'SELECT 1') {
  const db = ctx.store.databases.find(entry => entry.name === database) ?? ctx.store.databases.find(entry => entry.name + ctx.store.templateSuffix === database);
  const result = await psql(ctx, database, `${(migrationsSql(db?.migrationsReady) ?? fallbackSql).replace(/;\s*$/, '')};\n`);
  if (result.status !== 0) return { rows: null, error: firstError(result.stderr) };
  return { rows: result.stdout.split('\n').filter(line => line !== '') };
}

/** Readiness of the databases a service migrates at startup (`databases` in its service entry). */
export async function serviceChecks(ctx, service) {
  const mine = (service.databases ?? []).map(name => ctx.store.databases.find(db => db.name === name)).filter(Boolean);
  return Promise.all(mine.map(async db => {
    const { rows, error } = await migrations(ctx, db.name);
    if (!db.migrationsReady) return { name: `database:${db.name}`, ok: rows !== null, detail: rows !== null ? 'exists' : error };
    if (rows === null) return { name: `migrations:${db.name}`, ok: false, detail: error };
    return rows.length > 0
      ? { name: `migrations:${db.name}`, ok: true, detail: `${rows.length} applied (latest ${rows.at(-1)})` }
      : { name: `migrations:${db.name}`, ok: false, detail: 'no migrations applied yet' };
  }));
}

/** Truncates every database of the store (one psql session). */
export async function clear(ctx) {
  const script = ctx.store.databases.map(db => `${connect(db.name)}\n${clearSql(db.preserveTables)}\n`).join('');
  await mustRun(ctx, ctx.store.adminDatabase, script, 'clearing');
  return {};
}

/** Applies every layer's steps, one transaction per database. A failing step is reported by name (exit 3). */
export async function load(ctx, sections) {
  const { script, ranges, steps } = loadScript(ctx.store, sections.flat());
  if (steps === 0) return { count: 0 };
  const result = await psql(ctx, ctx.store.adminDatabase, script, { tags: true });
  if (result.status !== 0) {
    const match = /^psql:[^:\n]*:(\d+): ERROR:\s*(.*)$/m.exec(result.stderr);
    const range = match && ranges.find(r => Number(match[1]) >= r.from && Number(match[1]) <= r.to);
    if (!range) throw new TestStackError(`${ctx.name}: loading failed: ${firstError(result.stderr) || `psql exited with ${result.status}`}`);
    const detail = /^DETAIL:\s*(.*)$/m.exec(result.stderr);
    throw new TestStackError(`${range.database}: ${range.source} failed: ${match[2].trim()}${detail ? ` (${detail[1].trim()})` : ''}`, EXIT.invalidScenario);
  }
  const rows = [...result.stdout.matchAll(/^(?:INSERT \d+|UPDATE|DELETE|COPY|MERGE) (\d+)$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
  return { count: steps, detail: `${steps} step(s), ${rows} row(s)` };
}

/** Post-load fix-ups: sequences move past the loaded ids, so the application never generates a colliding id. */
export async function fixups(ctx) {
  const script = ctx.store.databases
    .map(db => `${connect(db.name)}\n${fixupSql(ctx.store.sequences.filter(s => s.database === db.name))}\n`).join('');
  await mustRun(ctx, ctx.store.adminDatabase, script, 'moving sequences');
}

/** Names of the configured standalone sequences that handed out a value since the last load. */
export async function usedSequences(ctx) {
  const used = [];
  const databases = [...new Set(ctx.store.sequences.map(s => s.database))];
  await Promise.all(databases.map(async database => {
    // A sequence that does not exist yet (not migrated) only prints an error, which is ignored.
    const script = ctx.store.sequences.filter(s => s.database === database)
      .map(s => `SELECT ${sqlString(s.sequence)} FROM ${qualifiedName(s.sequence)} WHERE is_called;\n`).join('');
    const result = await psql(ctx, database, script, { stop: false });
    used.push(...result.stdout.split('\n').filter(Boolean));
  }));
  return ctx.store.sequences.map(s => s.sequence).filter(name => used.includes(name));
}

// ---------------------------------------------------------------- hard reset (database snapshots)

const fingerprint = async (ctx, database) => (await migrations(ctx, database, SCHEMA_SQL)).rows;

/** CREATE DATABASE target TEMPLATE source: a file-level copy, which needs the source to have no sessions. */
export function copySql(source, target) {
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlString(source)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${quoteIdent(target)} WITH (FORCE);
CREATE DATABASE ${quoteIdent(target)} TEMPLATE ${quoteIdent(source)};\n`;
}

const copy = (ctx, source, target) => mustRun(ctx, ctx.store.adminDatabase, copySql(source, target), `copying ${source} to ${target}`);

async function snapshotDatabase(ctx, db) {
  await mustRun(ctx, db.name, `${clearSql(db.preserveTables)}\n`, `clearing ${db.name}`);
  await copy(ctx, db.name, db.name + ctx.store.templateSuffix);
}

/**
 * Hard reset, with the application stopped: every database is recreated from `<db>__template`, a snapshot of
 * the migrated, empty schema. Returns the databases that still need a snapshot once the application is up.
 */
export async function restore(ctx) {
  const pending = [];
  for (const db of ctx.store.databases) {
    const template = db.name + ctx.store.templateSuffix;
    const current = await fingerprint(ctx, db.name);
    const snapshot = await fingerprint(ctx, template);
    if (snapshot && current && JSON.stringify(snapshot) === JSON.stringify(current)) {
      await copy(ctx, template, db.name);
      ctx.log(`${db.name}: restored from ${template}`);
    } else if (ctx.store.onMissingTemplate === 'drop') {
      await mustRun(ctx, ctx.store.adminDatabase, `DROP DATABASE IF EXISTS ${quoteIdent(db.name)} WITH (FORCE);\n`, `dropping ${db.name}`);
      pending.push(db.name);
      ctx.log(`${db.name}: dropped; migrations will recreate it (template ${snapshot ? 'outdated' : 'missing'})`);
    } else if (current) {
      await snapshotDatabase(ctx, db);
      ctx.log(`${db.name}: truncated and snapshotted as ${template} (template was ${snapshot ? 'outdated' : 'missing'})`);
    } else {
      pending.push(db.name);
      ctx.log(`${db.name}: not migrated yet; it is snapshotted once the application is up`);
    }
  }
  return pending;
}

/** Second half of a hard reset: snapshot the databases `restore` could not, again with the application stopped. */
export async function snapshot(ctx, pending) {
  for (const db of ctx.store.databases.filter(entry => pending.includes(entry.name))) await snapshotDatabase(ctx, db);
}
