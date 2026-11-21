# The custom adapter

**Who reads this:** B and D, connecting an in-house tracker, host, CI system or scanner.

A client with an in-house tracker, a code host the factory has no built-in for (Bitbucket Data Center, Gerrit, an internal forge), its own CI system, or its own scanner service writes one small script. The factory itself does not change. The script speaks the contract of its kind ([contracts.md](contracts.md)) over a simple protocol: one JSON request on stdin, one JSON answer on stdout. The adapter is `scripts/pipeline/lib/providers/custom.mjs`.

## Configuration

The same keys apply for every kind:

```json
"tracker": {
  "type": "custom",
  "command": ["node", "scripts/acme-tracker.mjs"],
  "timeoutSec": 60,
  "env": { "ACME_TRACKER_TOKEN": "${ACME_TRACKER_TOKEN}" },
  "label": "Acme Tracker",
  "capabilities": { "attachments": false }
}
```

| Key | Meaning |
| --- | --- |
| `command` | argv (preferred) or a command line split on spaces. It runs in the repository's root. |
| `timeoutSec` | per call, default 60. A call that takes longer is an error. |
| `env` | the only variables the script receives besides the essentials (`PATH`, `HOME`, temp folders, proxies, `NODE_EXTRA_CA_CERTS`). Values are `${NAME}` references, expanded when the script starts. |
| `label` | how doctor and `factory adapter check` name it |
| `capabilities` | overrides what the script's `describe` answer says it can do |

For a host, use `"host": { "type": "custom", ... }` (with `repo`, `url` and `hints` as needed). For a CI system, use `"ci": { "provider": "custom", ... }`. For a scanner, see [commercial-scanners.md](commercial-scanners.md#your-own-scanner-service).

## Protocol

Request on stdin, one JSON object:

```json
{ "protocol": 1, "kind": "tracker", "op": "tickets.get", "args": ["ACME-12"], "settings": { "type": "custom", "command": ["node", "scripts/acme-tracker.mjs"], "env": { "ACME_TRACKER_TOKEN": "${ACME_TRACKER_TOKEN}" } } }
```

- `op` is a contract operation, by its dotted id.
- `args` are its arguments, in the order the contract lists them.
- `settings` is the section as configured. It holds `${NAME}` references, never their values: read secrets from the environment.

Answer on stdout, one JSON object. A command that logs before answering puts the JSON on the last line.

```json
{ "ok": true, "result": { "id": "ACME-12", "key": "ACME-12", "title": "...", "state": "open" } }
{ "ok": false, "error": "the tracker refused the token", "code": "auth" }
```

| Exit code | Meaning |
| --- | --- |
| 0 | the answer is on stdout |
| 3 | the operation is not supported: the harness degrades as the capability says (the same as `"code": "unsupported"`) |
| 4 | not found: the operation's `null` (the same as `"code": "not-found"`) |
| anything else, a timeout, or no JSON | an error, reported with the operation's name. Secrets from `env` are masked in the message. |

**`describe`.** Before the first real call the adapter sends `op: "describe"`. Answer with the operations you implement and what the product can do:

```json
{ "ok": true, "result": { "operations": ["tickets.get", "tickets.list", "board.move"], "capabilities": { "customFields": false }, "traits": { "ticketNoun": "ticket" } } }
```

An operation not in the list is unsupported without being called. A script that does not implement `describe` (exit 3) is assumed to implement everything.

Values have the normalised shapes in [contracts.md](contracts.md). A tracker that implements no `format.*` operations gets the factory's default: the Markdown plus a hidden metadata marker at the end of the description.

## Check it

```sh
factory adapter check tracker            # every read operation
factory adapter check tracker --write    # also creates, edits and closes one test ticket (asks first)
```

Every operation shows as `pass`, `fail`, `unsupported` or `skipped`, followed by the capability table. The factory's own tests run the conformance suite against both examples below (`scripts/pipeline/test/adapters-conformance.test.mjs`, `commercial-scanners.test.mjs`).

## Worked example: a tracker

A complete tracker backed by one JSON file (`docs/providers/examples/custom-tracker.mjs`). To connect a real in-house tracker, replace `load` and `save` and the store operations with calls to its API. Read its token from `process.env.ACME_TRACKER_TOKEN`, which the config's `env` passes through.

<!-- generated:example-custom-tracker -->
```js
#!/usr/bin/env node
// A complete custom tracker for the factory (docs/providers/custom.md): the tracker contract over the custom adapter
// protocol, backed by one JSON file. Replace the store functions with calls to your in-house tracker's API.
//
// .factory/config.json:
//   "tracker": { "type": "custom", "command": ["node", "scripts/acme-tracker.mjs"],
//                "env": { "ACME_TRACKER_STORE": "${ACME_TRACKER_STORE}", "ACME_TRACKER_TOKEN": "${ACME_TRACKER_TOKEN}" } }
//
// Protocol: one JSON request on stdin ({ protocol, kind, op, args, settings }), one JSON answer on stdout
// ({ ok: true, result } or { ok: false, error, code }); exit 3 for an operation this script does not support.
import fs from 'node:fs';

const STORE = process.env.ACME_TRACKER_STORE ?? '.acme-tracker.json';
const LANES = ['backlog', 'ready', 'inProgress', 'testing', 'review', 'failed', 'done'];
const load = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : { next: 1, tickets: {}, comments: {} });
const save = (db) => fs.writeFileSync(STORE, JSON.stringify(db, null, 2));
const out = (result) => process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
const fail = (error, code = 'error') => process.stdout.write(`${JSON.stringify({ ok: false, error, code })}\n`);

const ticket = (t) => (t ? { id: t.id, number: t.id, key: t.key ?? t.id, type: t.type ?? 'story', title: t.title, body: t.body ?? '', state: t.lane === 'done' || t.closed ? 'closed' : 'open', stateReason: null, labels: t.labels ?? [], assignees: t.assignees ?? [], parent: t.parent ?? null, url: `https://acme.example/tickets/${t.id}`, updatedAt: t.updatedAt ?? null, meta: t.meta ?? null } : null);
const touch = (t) => (t.updatedAt = new Date().toISOString(), t);

const OPS = {
  describe: () => ({
    operations: ['reachable', 'identity', 'tickets.get', 'tickets.find', 'tickets.list', 'tickets.search', 'tickets.create', 'tickets.update', 'tickets.children', 'tickets.parent', 'tickets.setParent', 'tickets.comment', 'tickets.comments', 'tickets.editComment', 'tickets.link', 'board.lanes', 'board.lane', 'board.item', 'board.move', 'board.moveItem', 'board.items', 'board.setup', 'board.syncAssignees'],
    capabilities: { boardLanes: true, customFields: false, parentChild: true, attachments: false, commentEdit: true, bodyHistory: false, archive: false, labels: true, assignees: true },
    traits: { keyFromTitle: false, blockBody: false, ticketNoun: 'ticket' },
  }),
  reachable: () => ({ ok: true, reason: null }),
  identity: () => ({ login: 'acme-bot', id: 'acme-bot' }),
  'tickets.get': (db, id) => ticket(db.tickets[id] ?? Object.values(db.tickets).find((t) => t.key === id)),
  'tickets.find': (db, key) => {
    const t = Object.values(db.tickets).find((x) => x.key === key);
    return t ? { number: t.id, url: ticket(t).url } : null;
  },
  'tickets.list': (db, { state = 'all', parent = null, type = null } = {}) => Object.values(db.tickets).map(ticket).filter((t) => (state === 'all' || t.state === state) && (!parent || t.parent === parent) && (!type || t.type === type)),
  'tickets.search': (db, { text = '', state = 'open' } = {}) => OPS['tickets.list'](db, { state }).filter((t) => t.title.toLowerCase().includes(String(text).toLowerCase())),
  'tickets.create': (db, { type = 'story', key = null, title, body = '', parent = null, labels = [], meta = null }) => {
    const id = `ACME-${db.next++}`;
    db.tickets[id] = touch({ id, key: key ?? id, type, title, body, parent, labels, lane: 'backlog', meta });
    return ticket(db.tickets[id]);
  },
  'tickets.update': (db, id, { title, body, labels, state, assignees, meta } = {}) => {
    const t = db.tickets[id];
    if (!t) throw Object.assign(new Error(`${id} not found`), { code: 'not-found' });
    if (title != null) t.title = title;
    if (body != null) t.body = body;
    if (meta) t.meta = meta;
    if (Array.isArray(labels)) t.labels = labels;
    else if (labels) t.labels = [...new Set([...(t.labels ?? []).filter((l) => !(labels.remove ?? []).includes(l)), ...(labels.add ?? [])])];
    if (assignees) t.assignees = Array.isArray(assignees) ? assignees : assignees.add ?? [];
    if (state === 'closed') t.closed = true;
    if (state === 'open') t.closed = false;
    touch(t);
    return null;
  },
  'tickets.children': (db, id) => Object.values(db.tickets).filter((t) => t.parent === id).map(ticket),
  'tickets.parent': (db, id) => ticket(db.tickets[db.tickets[id]?.parent]),
  'tickets.setParent': (db, child, parent) => ((db.tickets[child].parent = parent), null),
  'tickets.comments': (db, id) => db.comments[id] ?? [],
  'tickets.comment': (db, id, body, { marker = null } = {}) => {
    const list = (db.comments[id] ??= []);
    const existing = marker ? list.filter((c) => c.body.includes(marker)).at(-1) : null;
    if (existing) existing.body = body;
    else list.push({ id: `c${list.length + 1}`, author: 'acme-bot', body, createdAt: new Date().toISOString(), url: `https://acme.example/tickets/${id}#c${list.length + 1}` });
    const c = existing ?? list.at(-1);
    return { id: c.id, url: c.url };
  },
  'tickets.editComment': (db, id, commentId, body) => (((db.comments[id] ?? []).find((c) => c.id === commentId) ?? {}).body = body, null),
  'tickets.link': (db, id, { url, title }) => OPS['tickets.comment'](db, id, `${title ?? 'Pull request'}: ${url}`, { marker: url }),
  'board.lanes': () => LANES.map((lane) => ({ lane, name: lane, id: lane })),
  'board.lane': (db, id) => db.tickets[id]?.lane ?? null,
  'board.item': (db, issue) => ({ id: issue.number ?? issue.id ?? issue, column: db.tickets[issue.number ?? issue.id ?? issue]?.lane ?? null }),
  'board.move': (db, id, lane) => ((touch(db.tickets[id]).lane = lane), null),
  'board.moveItem': (db, id, lane) => ((touch(db.tickets[id]).lane = lane), null),
  'board.items': (db, { lane = null } = {}) => Object.values(db.tickets).filter((t) => !lane || t.lane === lane).map((t) => ({ itemId: t.id, column: t.lane, status: t.lane, number: t.id, id: t.id, key: t.key, title: t.title, url: ticket(t).url, state: ticket(t).state === 'closed' ? 'CLOSED' : 'OPEN', repo: 'acme', labels: t.labels ?? [], assignees: t.assignees ?? [], parent: t.parent ?? null, stateReason: null, severity: null })),
  'board.setup': (db, { dryRun = false } = {}) => ({ url: 'https://acme.example/board', done: [`${dryRun ? 'dry run: ' : ''}the Acme board has every lane`], manual: [] }),
  'board.syncAssignees': () => [],
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const req = JSON.parse(input || '{}');
  const fn = OPS[req.op];
  if (!fn) {
    fail(`${req.op} is not supported by the Acme tracker`, 'unsupported');
    process.exit(3);
  }
  const db = load();
  try {
    const result = fn(db, ...(req.args ?? []));
    save(db);
    out(result === undefined ? null : result);
  } catch (error) {
    fail(error.message, error.code ?? 'error');
  }
});
```
<!-- /generated:example-custom-tracker -->

Walkthrough:

1. Copy it to `scripts/acme-tracker.mjs` in the repository and add the `tracker` section above.
2. `export ACME_TRACKER_STORE=.acme-tracker.json`, then run `factory adapter check tracker --write`. Every operation it lists passes, and the ones it leaves out (attachments, fields, history) are `unsupported`.
3. Run `factory board setup --dry-run`. The lanes it needs are the script's `LANES`.
4. Create a story (`factory board new`) and run it (`factory implement run ACME-1`). The pipeline reads the ticket, moves it through the lanes, and comments on it, all through the script.

## Worked example: a scanner service

The scanner contract has two operations: `checkName` (the check the scanner reports on a pull request's head) and `result` (the scan of one head: `pending`, `complete` or `failed`, with its findings). This example (`docs/providers/examples/custom-scanner.mjs`) reads results that the client's scan job wrote. The gate waits for the result of the exact head, then applies the severity map and the vendor's triage ([commercial-scanners.md](commercial-scanners.md)).

<!-- generated:example-custom-scanner -->
```js
#!/usr/bin/env node
// A client's own scanner service in server mode, over the custom adapter protocol (docs/providers/custom.md): the
// scanner contract's two operations, `checkName` and `result`. This one reads a JSON file the client's scan job writes
// (one result per head SHA); replace `load` with a call to your scanner's API.
//
// .factory/config.json:
//   "analysis": {
//     "tools": { "acme-scan": { "licence": "LicenseRef-Acme-Scan", "lens": "security",
//       "severity": { "critical": "blocking", "high": "blocking", "medium": "major", "low": "minor", "info": "minor" },
//       "commercial": { "vendor": "Acme", "modes": ["server"], "tokenEnv": "ACME_SCAN_TOKEN",
//         "server": { "adapter": "custom", "command": ["node", "scripts/acme-scan.mjs"], "env": { "ACME_SCAN_TOKEN": "${ACME_SCAN_TOKEN}", "ACME_SCAN_RESULTS": "${ACME_SCAN_RESULTS}" } } } } },
//     "commercial": { "scanner": "acme-scan", "mode": "server", "token": "${ACME_SCAN_TOKEN}", "check": "acme/scan" },
//     "acceptLicence": [{ "tool": "acme-scan", "licence": "LicenseRef-Acme-Scan", "by": "<a named person>" }]
//   }
import fs from 'node:fs';

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.ACME_SCAN_RESULTS ?? '.acme-scan.json', 'utf8'));
  } catch {
    return {};
  }
};
const OPS = {
  describe: () => ({ operations: ['checkName', 'result'], capabilities: { serverSide: true, prAnalysis: true, triageStates: true, sarif: false, shaBound: true } }),
  checkName: () => 'acme/scan',
  // { head, pr } -> { status pending|complete|failed, gate, url, findings: [{ rule, severity, path, line, message, cwe, fingerprint, triage }] }
  result: ({ head }) => {
    const r = load()[head];
    if (!r) return { status: 'pending', findings: [] };
    return { status: r.failed ? 'failed' : 'complete', gate: r.gate ?? null, url: r.url ?? null, commit: head, findings: r.findings ?? [] };
  },
};

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (!process.env.ACME_SCAN_TOKEN) return process.stdout.write(`${JSON.stringify({ ok: false, error: 'ACME_SCAN_TOKEN is not set', code: 'auth' })}\n`);
  const op = OPS[req.op];
  if (!op) process.exit(3);
  process.stdout.write(`${JSON.stringify({ ok: true, result: op(...(req.args ?? [])) })}\n`);
});
```
<!-- /generated:example-custom-scanner -->

## Rules for a custom script

- Never print a secret. The adapter masks the values of `env` in its own messages, but your logs are yours.
- Read operations change nothing. `factory adapter check` relies on that to run against a real service.
- Answer within `timeoutSec`. The gate and the CI wait call operations synchronously, and a slow call delays the pipeline.
- Keep `describe` honest. A capability you claim but do not have breaks the safety the harness builds on it. For a host, the most important ones are `mergeHeadGuard` (a merge bound to `headSha`) and `cancelAutoMerge`.
