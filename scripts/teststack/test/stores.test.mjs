// Store adapters, with a fake command runner: the exact commands, environment and scripts each adapter would
// run inside its container, and how it reads the datastore CLI's answers. No Docker involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../lib/common.mjs';
import * as mongodb from '../lib/stores/mongodb.mjs';
import * as mysql from '../lib/stores/mysql.mjs';
import * as postgres from '../lib/stores/postgres.mjs';
import * as redis from '../lib/stores/redis.mjs';
import { loadAdapter } from '../lib/stores/index.mjs';
import { SHOP, makeContext, makeRepo, storeOf } from './helpers.mjs';

const PSQL = ['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-f', '-'];
const PG_ENV = { PGPASSWORD: 'secret-db' };

const rowsStep = (table, rows) => ({ kind: 'rows', source: `db.appdb[0] (${table})`, table, rows });

test('postgres: clear truncates every database in one psql session and never touches the preserved tables', async () => {
  const { ctx, calls } = await makeContext(SHOP);
  const db = storeOf(ctx, 'db');
  await db.adapter.clear(db.ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], input: undefined }, { service: 'postgres', argv: PSQL, env: PG_ENV, input: undefined });
  const clear = postgres.clearSql(['schema_migrations']);
  assert.equal(calls[0].input, `\\connect 'appdb'\n${clear}\n\\connect 'authdb'\n${clear}\n`);
  assert.equal(clear, `DO $teststack$
DECLARE tables text; s record;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname) INTO tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      AND c.relname <> ALL (ARRAY['schema_migrations']::text[])
      AND n.nspname || '.' || c.relname <> ALL (ARRAY['schema_migrations']::text[])
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
END $teststack$;`);
  assert.match(postgres.clearSql([]), /c\.relname <> ALL \(ARRAY\[\]::text\[\]\)/);
});

test('postgres: load runs every layer in one transaction per database, in config order, through json_populate_recordset', async () => {
  const { ctx, calls } = await makeContext(SHOP, { respond: () => ({ stdout: 'BEGIN\nINSERT 0 2\nINSERT 0 1\nUPDATE 3\nCOMMIT\nBEGIN\nINSERT 0 1\nCOMMIT\n' }) });
  const db = storeOf(ctx, 'db');
  const base = [{ database: 'authdb', steps: [rowsStep('Users', [{ Id: 'u1', Name: "O'Brien" }])] },
    { database: 'appdb', steps: [rowsStep('sales.orders', [{ Id: 1, Total: 9.5 }, { Id: 2, Note: null, Tags: ['a'] }])] }];
  const layer = [{ database: 'appdb', steps: [{ kind: 'sql', source: 'db.appdb[0] (more.sql)', sql: 'INSERT INTO t VALUES (1);\nUPDATE t SET a = 1  \n\n' }] }];
  const result = await db.adapter.load(db.ctx, [base, layer]);
  assert.deepEqual(result, { count: 3, detail: '3 step(s), 7 row(s)' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-f', '-']);
  assert.deepEqual(calls[0].env, PG_ENV);
  assert.equal(calls[0].input, `\\connect 'appdb'
BEGIN;
INSERT INTO "sales"."orders" ("Id", "Total", "Note", "Tags") SELECT "Id", "Total", "Note", "Tags" FROM json_populate_recordset(NULL::"sales"."orders", $rows$[{"Id":1,"Total":9.5},{"Id":2,"Note":null,"Tags":["a"]}]$rows$::json);
INSERT INTO t VALUES (1);
UPDATE t SET a = 1
;
COMMIT;
\\connect 'authdb'
BEGIN;
INSERT INTO "Users" ("Id", "Name") SELECT "Id", "Name" FROM json_populate_recordset(NULL::"Users", $rows$[{"Id":"u1","Name":"O'Brien"}]$rows$::json);
COMMIT;
`);
  assert.deepEqual(await db.adapter.load(db.ctx, []), { count: 0 });
  assert.equal(calls.length, 1, 'nothing to load: no command');
});

test('postgres: identifiers are quoted and a value containing the dollar-quote tag gets another tag', () => {
  assert.equal(postgres.insertSql('We"ird', [{ 'a"b': '$rows$ and $rows1$' }]),
    'INSERT INTO "We""ird" ("a""b") SELECT "a""b" FROM json_populate_recordset(NULL::"We""ird", $rows2$[{"a\\"b":"$rows$ and $rows1$"}]$rows2$::json);');
});

test('postgres: a failing step is reported by name with exit code 3; other failures are plain errors', async () => {
  const steps = [{ database: 'appdb', steps: [rowsStep('A', [{ Id: 1 }]), { kind: 'sql', source: 'db.appdb[1] (x.sql)', sql: 'ONE;\nTWO;\nTHREE;' }, { ...rowsStep('B', [{ Id: 1 }]), source: 'db.appdb[2] (B)' }] }];
  // Lines: 1 \connect, 2 BEGIN, 3 A, 4-7 x.sql, 8 B, 9 COMMIT
  const failAt = line => ({ status: 3, stderr: `psql:<stdin>:${line}: ERROR:  insert or update on table "B" violates foreign key constraint "fk"\nDETAIL:  Key (Id)=(1) is not present in table "A".\n` });
  for (const [line, source] of [[3, 'db.appdb[0] (A)'], [5, 'db.appdb[1] (x.sql)'], [7, 'db.appdb[1] (x.sql)'], [8, 'db.appdb[2] (B)']]) {
    const { ctx } = await makeContext(SHOP, { respond: () => failAt(line) });
    const db = storeOf(ctx, 'db');
    await assert.rejects(db.adapter.load(db.ctx, [steps]), error => {
      assert.equal(error.exitCode, EXIT.invalidScenario);
      assert.equal(error.message, `appdb: ${source} failed: insert or update on table "B" violates foreign key constraint "fk" (Key (Id)=(1) is not present in table "A".)`);
      return true;
    });
  }
  const { ctx } = await makeContext(SHOP, { respond: () => ({ status: 2, stderr: 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  password authentication failed for user "postgres"\n' }) });
  const db = storeOf(ctx, 'db');
  await assert.rejects(db.adapter.load(db.ctx, [steps]), error => error.exitCode === EXIT.error && /db: loading failed: connection to server/.test(error.message));
  await assert.rejects(db.adapter.clear(db.ctx), /db: clearing failed: connection to server/);
});

test('postgres: fix-ups move column-owned sequences and the configured standalone ones past the loaded ids', async () => {
  const { ctx, calls } = await makeContext(SHOP);
  const db = storeOf(ctx, 'db');
  await db.adapter.fixups(db.ctx);
  assert.deepEqual(calls[0].argv, PSQL);
  const owned = postgres.fixupSql([]);
  assert.match(owned, /PERFORM setval\(c\.seq, COALESCE\(max_id, 0\) \+ 1, false\);/);
  assert.match(owned, /pg_get_serial_sequence\(format\('%I\.%I', n\.nspname, t\.relname\), a\.attname\) IS NOT NULL/);
  assert.equal(calls[0].input, `\\connect 'appdb'\n${owned}\n`
    + `SELECT setval('"sales"."orderseq"'::regclass, COALESCE((SELECT MAX("Id")::bigint FROM "sales"."orders"), 0) + 1, false);\n`
    + `\\connect 'authdb'\n${owned}\n`);
});

test('postgres: usedSequences asks each sequence whether it handed out a value and tolerates missing ones', async () => {
  const { ctx, calls } = await makeContext(SHOP, { respond: () => ({ status: 0, stdout: 'sales.orderseq\n', stderr: 'ERROR: relation "x" does not exist' }) });
  const db = storeOf(ctx, 'db');
  assert.deepEqual(await db.adapter.usedSequences(db.ctx), ['sales.orderseq']);
  assert.deepEqual(calls[0].argv, ['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=0', '-U', 'postgres', '-d', 'appdb', '-f', '-']);
  assert.equal(calls[0].input, `SELECT 'sales.orderseq' FROM "sales"."orderseq" WHERE is_called;\n`);
  const fresh = await makeContext(SHOP);
  assert.deepEqual(await storeOf(fresh.ctx, 'db').adapter.usedSequences(storeOf(fresh.ctx, 'db').ctx), []);
});

test('postgres: readiness is the server answering, and each service database passing its migrationsReady probe', async () => {
  const answers = { appdb: { stdout: '001_init\n002_orders\n' }, authdb: { stdout: '' }, gone: { status: 2, stderr: 'psql: error: connection failed: FATAL:  database "gone" does not exist' } };
  const config = structuredClone(SHOP);
  config.teststack.stores.db.databases = ['appdb', 'authdb', { name: 'gone', migrationsReady: { sql: 'SELECT id FROM flyway_schema_history;' } }, { name: 'plain', migrationsReady: false }];
  const { ctx, calls } = await makeContext(config, { respond: call => answers[call.argv?.[call.argv.indexOf('-d') + 1]] });
  const db = storeOf(ctx, 'db');
  assert.deepEqual(await db.adapter.probe(db.ctx), { detail: 'accepting connections' });
  assert.equal(calls[0].input, 'SELECT 1;\n');
  const checks = await db.adapter.serviceChecks(db.ctx, { name: 'api', databases: ['appdb', 'authdb', 'gone', 'plain', 'not-in-this-store'] });
  assert.deepEqual(checks, [
    { name: 'migrations:appdb', ok: true, detail: '2 applied (latest 002_orders)' },
    { name: 'migrations:authdb', ok: false, detail: 'no migrations applied yet' },
    { name: 'migrations:gone', ok: false, detail: 'connection failed: FATAL:  database "gone" does not exist' },
    { name: 'database:plain', ok: true, detail: 'exists' },
  ]);
  const scripts = Object.fromEntries(calls.slice(1).map(call => [call.argv[call.argv.indexOf('-d') + 1], call.input]));
  assert.deepEqual(scripts, {
    appdb: 'SELECT "version" FROM "schema_migrations" t ORDER BY 1;\n',
    authdb: 'SELECT "version" FROM "schema_migrations" t ORDER BY 1;\n',
    gone: 'SELECT id FROM flyway_schema_history;\n',
    plain: 'SELECT 1;\n',
  });
  assert.equal(postgres.migrationsSql({ table: 'public.history' }), 'SELECT t::text FROM "public"."history" t ORDER BY 1');
});

test('postgres: a hard reset restores each database from its template, or snapshots or drops it when the template is unusable', async () => {
  const fingerprints = { appdb: '001\n002\n', appdb__template: '001\n002\n', authdb: '001\n', authdb__template: '000\n' };
  const respond = call => {
    const database = call.argv[call.argv.indexOf('-d') + 1];
    return call.input.startsWith('SELECT "version"') ? (fingerprints[database] ? { stdout: fingerprints[database] } : { status: 2, stderr: 'FATAL:  database does not exist' }) : null;
  };
  const admin = calls => calls.filter(call => !call.input.startsWith('SELECT "version"')).map(call => [call.argv[call.argv.indexOf('-d') + 1], call.input]);

  const truncate = await makeContext(SHOP, { respond });
  let db = storeOf(truncate.ctx, 'db');
  assert.deepEqual(await db.adapter.restore(db.ctx), []);
  assert.deepEqual(admin(truncate.calls), [
    ['postgres', postgres.copySql('appdb__template', 'appdb')],
    ['authdb', `${postgres.clearSql(['schema_migrations'])}\n`],
    ['postgres', postgres.copySql('authdb', 'authdb__template')],
  ]);
  assert.equal(postgres.copySql('a', 'b'), `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'a' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "b" WITH (FORCE);
CREATE DATABASE "b" TEMPLATE "a";\n`);

  const config = structuredClone(SHOP);
  config.teststack.stores.db.onMissingTemplate = 'drop';
  const drop = await makeContext(config, { respond });
  db = storeOf(drop.ctx, 'db');
  assert.deepEqual(await db.adapter.restore(db.ctx), ['authdb']);
  assert.deepEqual(admin(drop.calls).at(-1), ['postgres', 'DROP DATABASE IF EXISTS "authdb" WITH (FORCE);\n']);
  drop.calls.length = 0;
  await db.adapter.snapshot(db.ctx, ['authdb']);
  assert.deepEqual(admin(drop.calls), [['authdb', `${postgres.clearSql(['schema_migrations'])}\n`], ['postgres', postgres.copySql('authdb', 'authdb__template')]]);
});

test('postgres: a password is optional and may be given literally', async () => {
  const config = structuredClone(SHOP);
  config.teststack.stores.db = { type: 'postgres', databases: ['appdb'], username: 'app' };
  const { ctx, calls } = await makeContext(config);
  const db = storeOf(ctx, 'db');
  await db.adapter.probe(db.ctx);
  assert.deepEqual(calls[0], { service: 'db', argv: ['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'app', '-d', 'postgres', '-f', '-'], input: 'SELECT 1;\n', env: {} });
  assert.throws(() => postgres.normalize({ type: 'postgres' }, 'db'), /databases must list at least one database/);
  assert.throws(() => postgres.normalize({ databases: ['a'], sequences: [{ database: 'b', sequence: 's', table: 't', column: 'c' }] }, 'db'), /unknown database 'b'/);
});

test('redis: PING, FLUSHALL and a binary-safe SET pipeline with the password in REDISCLI_AUTH', async () => {
  const { ctx, calls } = await makeContext(SHOP, { respond: call => ({ stdout: { PING: 'PONG\n', FLUSHALL: 'OK\n', '--pipe': 'All data transferred. Waiting for the last reply...\nLast reply received from server.\nerrors: 0, replies: 2\n' }[call.argv.at(-1)] }) });
  const cache = storeOf(ctx, 'cache');
  assert.deepEqual(await cache.adapter.probe(cache.ctx), { detail: 'PONG' });
  await cache.adapter.clear(cache.ctx);
  const loaded = await cache.adapter.load(cache.ctx, [[{ key: '/basket/ü', value: '{"a":"x y\\n"}', ttl: null }], [{ key: 'temp', value: 'line1\r\nline2', ttl: 60 }]]);
  assert.deepEqual(loaded, { count: 2, detail: '2 key(s)' });
  const env = { REDISCLI_AUTH: 'secret-cache' };
  assert.deepEqual(calls, [
    { service: 'redis', argv: ['redis-cli', 'PING'], input: undefined, env },
    { service: 'redis', argv: ['redis-cli', 'FLUSHALL'], input: undefined, env },
    { service: 'redis', argv: ['redis-cli', '--pipe'], env,
      input: '*3\r\n$3\r\nSET\r\n$10\r\n/basket/ü\r\n$13\r\n{"a":"x y\\n"}\r\n*5\r\n$3\r\nSET\r\n$4\r\ntemp\r\n$12\r\nline1\r\nline2\r\n$2\r\nEX\r\n$2\r\n60\r\n' },
  ]);
  assert.equal(redis.respCommand(['SET', 'k', '']), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$0\r\n\r\n');
});

test('redis: wrong answers are errors (bad password, rejected commands), and a database number is passed with -n', async () => {
  const config = structuredClone(SHOP);
  config.teststack.stores.cache.database = 3;
  const { ctx, calls } = await makeContext(config, { respond: call => ({ stdout: call.argv.includes('--pipe') ? 'errors: 1, replies: 1\n' : 'NOAUTH Authentication required.\n' }) });
  const cache = storeOf(ctx, 'cache');
  await assert.rejects(cache.adapter.probe(cache.ctx), /cache: PING failed: NOAUTH Authentication required/);
  await assert.rejects(cache.adapter.clear(cache.ctx), /cache: FLUSHALL failed/);
  await assert.rejects(cache.adapter.load(cache.ctx, [[{ key: 'k', value: 'v', ttl: null }]]), /cache: loading 1 key\(s\) failed: errors: 1, replies: 1/);
  assert.deepEqual(calls[0].argv, ['redis-cli', '-n', '3', 'PING']);
});

test('rabbitmq: queues are listed as the broker user; only configured, non-empty queues are purged', async () => {
  const listing = JSON.stringify([{ name: 'Orders', messages_ready: 4, consumers: 1 }, { name: 'Mail', messages_ready: 0, consumers: 0 }, { name: 'Other', messages_ready: 9, consumers: 0 }]);
  const { ctx, calls } = await makeContext(SHOP, { respond: call => (call.argv.includes('list_queues') ? { stdout: `${listing}\n` } : null) });
  const bus = storeOf(ctx, 'bus');
  const probe = await bus.adapter.probe(bus.ctx);
  assert.equal(probe.detail, 'accepting connections');
  assert.deepEqual(calls[0], { service: 'rabbit', user: 'rabbitmq', input: undefined, env: {}, argv: ['rabbitmqctl', '-q', '--formatter', 'json', 'list_queues', '-p', '/', 'name', 'messages_ready', 'consumers'] });
  assert.deepEqual(bus.adapter.serviceChecks(bus.ctx, { name: 'api', queues: ['Orders', 'Mail', 'Nope'] }, probe.state), [
    { name: 'queue:Orders', ok: true, detail: '1 consumer(s), 4 message(s)' },
    { name: 'queue:Mail', ok: false, detail: 'no consumer (api not subscribed)' },
    { name: 'queue:Nope', ok: false, detail: 'not declared yet by api' },
  ]);
  assert.deepEqual(bus.adapter.serviceChecks(bus.ctx, { name: 'api', queues: ['Orders'] }, undefined), [{ name: 'queue:Orders', ok: false, detail: 'bus unavailable' }]);
  assert.deepEqual(bus.adapter.serviceChecks(bus.ctx, { name: 'web' }, probe.state), []);
  calls.length = 0;
  assert.deepEqual(await bus.adapter.clear(bus.ctx), { purged: 4 });
  assert.deepEqual(calls.map(call => call.argv.slice(2)), [['--formatter', 'json', 'list_queues', '-p', '/', 'name', 'messages_ready', 'consumers'], ['purge_queue', '-p', '/', 'Orders']]);
  assert.equal(bus.adapter.drainTwice, true);
  assert.equal(bus.adapter.parseSection, undefined);

  const down = await makeContext(SHOP, { respond: () => ({ status: 69, stderr: 'Error: unable to perform an operation on node rabbit@x\nmore' }) });
  await assert.rejects(storeOf(down.ctx, 'bus').adapter.probe(storeOf(down.ctx, 'bus').ctx), /bus: list_queues failed: Error: unable to perform an operation on node rabbit@x$/);
});

const SQL_SHOP = { teststack: { stores: { db: { type: 'mysql', service: 'mysql', passwordEnv: 'DB_PASSWORD', databases: ['appdb'], preserveTables: ['flyway_schema_history'], migrationsReady: { table: 'flyway_schema_history', column: 'version' } } } }, stack: { env: { DB_PASSWORD: 'pw' } } };

test('mysql: clear lists the tables, then truncates all but the preserved ones with foreign keys off', async () => {
  const { ctx, calls } = await makeContext(SQL_SHOP, { respond: call => (call.input.includes('information_schema') ? { stdout: 'appdb\tflyway_schema_history\nappdb\torders\nappdb\tusers\n' } : null) });
  const db = storeOf(ctx, 'db');
  await db.adapter.clear(db.ctx);
  assert.deepEqual(calls.map(call => [call.service, call.argv, call.env]), Array(2).fill(['mysql', ['mysql', '-u', 'root', '-N', '-B'], { MYSQL_PWD: 'pw' }]));
  assert.equal(calls[0].input, "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('appdb') ORDER BY 1, 2;\n");
  assert.equal(calls[1].input, 'SET FOREIGN_KEY_CHECKS = 0;\nTRUNCATE TABLE `appdb`.`orders`;\nTRUNCATE TABLE `appdb`.`users`;\nSET FOREIGN_KEY_CHECKS = 1;\n');
});

test('mysql: rows become one INSERT with escaped literals; a failing step is named (exit 3); readiness uses the probe', async () => {
  assert.equal(mysql.insertSql('users', [{ id: 1, name: "O'Brien\\\n", active: true, meta: { a: [1] } }, { id: 2, deleted: null }]),
    "INSERT INTO `users` (`id`, `name`, `active`, `meta`, `deleted`) VALUES (1, 'O\\'Brien\\\\\\n', 1, '{\"a\":[1]}', DEFAULT), (2, DEFAULT, DEFAULT, DEFAULT, NULL);");
  const steps = [{ database: 'appdb', steps: [rowsStep('users', [{ id: 1 }]), { kind: 'sql', source: 'db.appdb[1] (x.sql)', sql: 'ONE;\nTWO;' }] }];
  const ok = await makeContext(SQL_SHOP);
  let db = storeOf(ok.ctx, 'db');
  assert.deepEqual(await db.adapter.load(db.ctx, [steps]), { count: 2, detail: '2 step(s)' });
  assert.equal(ok.calls[0].input, 'USE `appdb`;\nSTART TRANSACTION;\nINSERT INTO `users` (`id`) VALUES (1);\nONE;\nTWO;\n;\nCOMMIT;\n');
  const bad = await makeContext(SQL_SHOP, { respond: () => ({ status: 1, stderr: "ERROR 1146 (42S02) at line 5: Table 'appdb.nope' doesn't exist\n" }) });
  db = storeOf(bad.ctx, 'db');
  await assert.rejects(db.adapter.load(db.ctx, [steps]), error => error.exitCode === EXIT.invalidScenario && error.message === "appdb: db.appdb[1] (x.sql) failed: Table 'appdb.nope' doesn't exist");
  const ready = await makeContext(SQL_SHOP, { respond: () => ({ stdout: '1\n2.1\n' }) });
  db = storeOf(ready.ctx, 'db');
  assert.deepEqual(await db.adapter.serviceChecks(db.ctx, { name: 'api', databases: ['appdb'] }), [{ name: 'migrations:appdb', ok: true, detail: '2 applied (latest 2.1)' }]);
  assert.equal(ready.calls[0].input, 'USE `appdb`;\nSELECT `version` FROM `flyway_schema_history` ORDER BY 1;\n');
});

const DOC_SHOP = { teststack: { stores: { docs: { type: 'mongodb', service: 'mongo', username: 'root', passwordEnv: 'MONGO_PASSWORD', databases: ['appdb'], preserveCollections: ['migrations'], migrationsReady: { collection: 'migrations' } } } }, stack: { env: { MONGO_PASSWORD: 'pw' } } };

test('mongodb: one fixed mongosh script; the request travels as JSON on stdin', async () => {
  const replies = { ping: { ok: 1 }, clear: { ok: 1 }, counts: { counts: [2] }, load: { ok: 1, documents: 2 } };
  const { ctx, calls } = await makeContext(DOC_SHOP, { respond: call => ({ stdout: `noise\nTESTSTACK ${JSON.stringify(replies[JSON.parse(call.input).op])}\n` }) });
  const docs = storeOf(ctx, 'docs');
  await docs.adapter.probe(docs.ctx);
  await docs.adapter.clear(docs.ctx);
  assert.deepEqual(await docs.adapter.serviceChecks(docs.ctx, { name: 'api', databases: ['appdb'] }), [{ name: 'migrations:appdb', ok: true, detail: '2 applied' }]);
  const section = await docs.adapter.parseSection({ appdb: [{ collection: 'users', documents: [{ _id: { $oid: '65f000000000000000000001' }, name: 'Alice' }, { _id: 2 }] }] },
    { store: docs.config, dir: '/', location: 'docs', invalid: message => new Error(message) });
  assert.deepEqual(await docs.adapter.load(docs.ctx, [section]), { count: 1, detail: '1 step(s), 2 document(s)' });
  for (const call of calls) {
    assert.equal(call.service, 'mongo');
    assert.deepEqual(call.argv, ['mongosh', '--quiet', '--norc', '-u', 'root', '-p', 'pw', '--authenticationDatabase', 'admin', '--eval', mongodb.DRIVER]);
  }
  assert.deepEqual(calls.map(call => JSON.parse(call.input)), [
    { op: 'ping' },
    { op: 'clear', databases: [{ name: 'appdb', preserve: ['migrations'] }] },
    { op: 'counts', collections: [{ database: 'appdb', collection: 'migrations' }] },
    { op: 'load', steps: [{ database: 'appdb', collection: 'users', documents: [{ _id: { $oid: '65f000000000000000000001' }, name: 'Alice' }, { _id: 2 }] }] },
  ]);
  const failing = await makeContext(DOC_SHOP, { respond: () => ({ status: 1, stdout: 'TESTSTACK {"failed":0,"message":"E11000 duplicate key"}\n' }) });
  await assert.rejects(storeOf(failing.ctx, 'docs').adapter.load(storeOf(failing.ctx, 'docs').ctx, [section]),
    error => error.exitCode === EXIT.invalidScenario && error.message === 'appdb: docs.appdb[0] (users) failed: E11000 duplicate key');
  await assert.rejects(docs.adapter.parseSection({ appdb: [{ collection: 'users' }] }, { store: docs.config, dir: '/', location: 'docs', invalid: message => new Error(message) }), /'documents' must be a list of mappings/);
});

test('a store type may be the path of an adapter module in the app repository; unknown types are refused', async () => {
  const adapter = "export const normalize = (config, name) => ({ service: name, ...config });\nexport const probe = async ctx => ({ detail: (await ctx.exec(['true'], {})).status === 0 ? 'up' : 'down' });\n";
  const { ctx, calls } = await makeContext({ teststack: { stores: { search: { type: './.factory/stack/adapters/search.mjs' } } } }, { files: { '.factory/stack/adapters/search.mjs': adapter } });
  const search = storeOf(ctx, 'search');
  assert.deepEqual(await search.adapter.probe(search.ctx), { detail: 'up' });
  assert.deepEqual(calls, [{ service: 'search', argv: ['true'], input: undefined, env: {} }]);
  await assert.rejects(loadAdapter('oracle', makeRepo()), /unknown store type 'oracle'. Built in: postgres, redis, rabbitmq, mysql, mongodb/);
  await assert.rejects(makeContext({ teststack: { stores: { db: { type: 'postgres' } } } }), error => error.exitCode === EXIT.usage && /teststack.stores.db: .*databases must list/.test(error.message));
});
