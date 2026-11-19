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
