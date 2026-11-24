// The council intercom's MCP server: Streamable HTTP (JSON-RPC 2.0) on node:http, no dependency. One listener hosts any
// number of rooms at /rooms/<roomId>/mcp; every request carries a bearer token issued for one seat of one room, checked
// by its SHA-256 digest. Bodies are capped at 64 KB, any Origin header and any Host other than the bound or advertised
// address are refused, and a closed room is evicted with its tokens at once. Rooms are created here and never loaded
// from disk (intercom-room.mjs).
import http from 'node:http';
import net from 'node:net';
import { INTERCOM_DEFAULTS, canonicalHost, isLoopbackHost, isWildcardHost, resolveIntercom } from './council-config.mjs';
import { DISPUTE_EFFECTS, DISPUTE_KINDS, FIELD_LIMITS, IntercomError, IntercomRoom, scrub, tokenDigest } from './intercom-room.mjs';

export const MAX_BODY_BYTES = 64 * 1024;
const PROTOCOL_VERSION = '2025-03-26';
const requestId = { type: 'string', maxLength: FIELD_LIMITS.id, description: 'Optional idempotency key: a retry with the same key and arguments gets the first answer.' };
const effect = { type: 'string', enum: DISPUTE_EFFECTS, description: 'What should happen to the finding; votes are counted on this.' };

export const INTERCOM_TOOLS = [
  { name: 'read_messages', description: 'Read the room after your cursor: the seeded round-1 results, posts, disputes, votes and resolutions. Pass `since` (a seq you have read) to move your cursor.', inputSchema: { type: 'object', properties: { since: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  {
    name: 'post_message',
    description: 'Post to the room (counts toward maxTurnsPerMember). Optionally withdraw findings you authored or revise your score or verdict; a revision counts only through this tool.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: FIELD_LIMITS.text }, withdrawFindings: { type: 'array', maxItems: FIELD_LIMITS.withdrawFindings, items: { type: 'string', maxLength: FIELD_LIMITS.id } }, score: { type: 'number', minimum: 0, maximum: 10 }, verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] }, requestId }, additionalProperties: false },
  },
  {
    name: 'open_dispute',
    description: 'Dispute a seeded finding. fact and fix need an effect; fact needs file:line evidence of an existing line in the repository; product becomes an owner question and is never voted.',
    inputSchema: { type: 'object', required: ['findingId', 'kind', 'position'], properties: { findingId: { type: 'string', maxLength: FIELD_LIMITS.id }, kind: { type: 'string', enum: DISPUTE_KINDS }, effect, position: { type: 'string', maxLength: FIELD_LIMITS.position }, evidence: { type: 'string', maxLength: FIELD_LIMITS.evidence }, question: { type: 'string', maxLength: FIELD_LIMITS.question }, requestId }, additionalProperties: false },
  },
  {
    name: 'vote_dispute',
    description: 'Vote on an open fact or fix dispute (by disputeId or findingId). A majority of all seats settles it; a finding is dropped or noted only if its author made at least one call to this room (no vote on this dispute needed); otherwise the owner decides.',
    inputSchema: { type: 'object', required: ['effect'], properties: { disputeId: { type: 'string', maxLength: FIELD_LIMITS.id }, findingId: { type: 'string', maxLength: FIELD_LIMITS.id }, effect, position: { type: 'string', maxLength: FIELD_LIMITS.position }, evidence: { type: 'string', maxLength: FIELD_LIMITS.evidence }, requestId }, additionalProperties: false },
  },
  { name: 'room_status', description: 'Your turns and votes left, every dispute with its status and votes, and the withdrawn findings.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const IDENTIFIERS = ['findingId', 'disputeId', 'requestId', 'withdrawFindings'];

const sendJson = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
};
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolResult = (id, payload, isError = false) => rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError });

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      req.resume();
      reject(Object.assign(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`), { statusCode: 413 }));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Arguments against the tool's schema: known keys only (own properties of the schema, so `constructor` or `__proto__`
// is just an unknown key), strings within maxLength (64 for an enum), arrays within maxItems of bounded strings, plain
// numbers. Nothing else, nested or not, gets past. Key names are never echoed (a member chooses them).
function argumentProblem(schema, input) {
  for (const [key, value] of Object.entries(input)) {
    const p = Object.hasOwn(schema, key) ? schema[key] : null;
    if (!p) return { code: 'invalid', error: 'an argument this tool does not take' };
    const tooLong = (v, max) => typeof v !== 'string' || v.length > max;
    if (p.type === 'string' && tooLong(value, p.maxLength ?? 64)) return { code: typeof value === 'string' ? 'too_large' : 'invalid', error: `${key} must be a string of at most ${p.maxLength ?? 64} characters` };
    if (p.type === 'array' && (!Array.isArray(value) || value.length > p.maxItems || value.some((v) => tooLong(v, p.items.maxLength)))) return { code: 'too_large', error: `${key} holds at most ${p.maxItems} strings of at most ${p.items.maxLength} characters` };
    if ((p.type === 'integer' || p.type === 'number') && typeof value !== 'number') return { code: 'invalid', error: `${key} must be a number` };
  }
  return null;
}

// A request id or protocol version that may be sent back: a finite number, or a string of at most 128 characters that
// the redaction boundary leaves as it is.
const safeEcho = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 128 && scrub(v) === v);

// `Host: name`, `Host: name:port`, `Host: [v6]:port` -> { host, port }, or null when malformed.
function parseHostHeader(raw) {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d+))?$/.exec(String(raw ?? '').trim());
  return m ? { host: canonicalHost(m[1] ?? m[2]), port: m[3] ? Number(m[3]) : null } : null;
}

export class IntercomServer {
  constructor({ host = INTERCOM_DEFAULTS.host, port = INTERCOM_DEFAULTS.port, advertiseHost = null, allowInsecureRemote = false } = {}) {
    Object.assign(this, { host, requestedPort: port, advertiseHost: advertiseHost || null, allowInsecureRemote: Boolean(allowInsecureRemote), port: null, httpServer: null });
    this.rooms = new Map(); // roomId -> IntercomRoom
    this.auth = new Map(); // token digest -> { roomId, seat }
    const allowed = [this.advertiseHost, isWildcardHost(host) ? null : host, ...(isLoopbackHost(host) || isWildcardHost(host) ? ['127.0.0.1', '::1', 'localhost'] : [])];
    this.allowedHosts = new Set(allowed.filter(Boolean).map(canonicalHost));
  }

  roomUrl(roomId) {
    const h = this.advertiseHost ?? this.host;
    return `http://${h.includes(':') ? `[${h}]` : h}:${this.port}/rooms/${encodeURIComponent(roomId)}/mcp`;
  }

  createRoom(opts) {
    const { room, tokens } = IntercomRoom.create(opts);
    this.rooms.set(room.roomId, room);
    for (const [seat, token] of Object.entries(tokens)) this.auth.set(tokenDigest(token), { roomId: room.roomId, seat });
    return { room, tokens, url: this.roomUrl(room.roomId) };
  }

  // Forgets a room and its tokens (a later request gets 401). Idempotent.
  evictRoom(roomId) {
    this.rooms.delete(roomId);
    for (const [digest, p] of this.auth) if (p.roomId === roomId) this.auth.delete(digest);
  }

  async start() {
    if (this.httpServer) return this;
    if (!isLoopbackHost(this.host) && (!this.allowInsecureRemote || !this.advertiseHost || isWildcardHost(this.advertiseHost))) {
      throw new Error(`council.intercom.host "${this.host}" is not loopback: it needs council.intercom.allowInsecureRemote: true and a council.intercom.advertiseHost members can reach`);
    }
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, error?.statusCode ?? 500, rpcError(null, -32603, error?.statusCode ? error.message : 'internal error'));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', (error) => {
        reject(error?.code === 'EADDRINUSE' && this.requestedPort > 0 ? new Error(`council.intercom.port ${this.requestedPort} on ${this.host} is in use (by another process?); set council.intercom.port to 0 for a free port`) : error);
      });
      server.listen(this.requestedPort, this.host, resolve);
    });
    server.unref(); // an idle listener never keeps the process alive
    this.httpServer = server;
    this.port = server.address().port;
    return this;
  }

  async stop() {
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async _handle(req, res) {
    if (req.headers.origin !== undefined) return sendJson(res, 403, rpcError(null, -32003, 'Forbidden: Origin header'));
    const host = parseHostHeader(req.headers.host);
    if (!host || !this.allowedHosts.has(host.host) || (host.port !== null && host.port !== this.port)) return sendJson(res, 403, rpcError(null, -32003, 'Forbidden: Host is not the bound or advertised address'));
    const route = /^\/rooms\/([^/?]+)\/mcp(?:\?.*)?$/.exec(req.url ?? '');
    if (!route) return sendJson(res, 404, rpcError(null, -32601, 'Not found'));
    if (req.method !== 'POST') return sendJson(res, 405, rpcError(null, -32600, 'use POST'), { Allow: 'POST' });
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim());
    const principal = bearer ? this.auth.get(tokenDigest(bearer[1])) : null;
    const room = principal ? this.rooms.get(principal.roomId) : null;
    if (!room) return sendJson(res, 401, rpcError(null, -32001, 'Unauthorized: missing, invalid or closed-room token'));
    let roomId;
    try {
      roomId = decodeURIComponent(route[1]);
    } catch {
      roomId = null;
    }
    if (roomId !== principal.roomId) return sendJson(res, 403, rpcError(null, -32003, 'Forbidden: the token is for another room'));
    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    if (!Object.hasOwn(msg, 'id')) {
      res.writeHead(202);
      res.end();
      return;
    }
    const { id, method } = msg;
    const params = Object.hasOwn(msg, 'params') ? msg.params : undefined;
    // Ids and the protocol version are echoed as sent, so clients can correlate replies; one that is not a short string
    // or a number, or that holds a credential, is refused before anything runs, without echoing it.
    if (!safeEcho(id)) return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: the id must be a number or a string of at most 128 characters, without a credential'));
    const session = { 'Mcp-Session-Id': `${principal.roomId}:${principal.seat}` };
    if (method === 'initialize') {
      const asked = params && typeof params === 'object' && Object.hasOwn(params, 'protocolVersion') ? params.protocolVersion : PROTOCOL_VERSION;
      if (typeof asked !== 'string' || !safeEcho(asked)) return sendJson(res, 200, rpcError(id, -32602, 'Invalid params: protocolVersion must be a short string without a credential'), session);
      return sendJson(res, 200, rpcResult(id, { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: 'factory-council-intercom', version: '1.0.0' } }), session);
    }
    if (method === 'ping') return sendJson(res, 200, rpcResult(id, {}), session);
    if (method === 'tools/list') return sendJson(res, 200, rpcResult(id, { tools: INTERCOM_TOOLS }), session);
    if (method !== 'tools/call') return sendJson(res, 200, rpcError(id, -32601, 'Method not found'), session);
    const own = (k) => (params && typeof params === 'object' && Object.hasOwn(params, k) ? params[k] : undefined);
    const name = own('name');
    const input = own('arguments') ?? {};
    if (!INTERCOM_TOOLS.some((t) => t.name === name) || !input || typeof input !== 'object' || Array.isArray(input)) return sendJson(res, 200, rpcError(id, -32602, 'Invalid params: a known tool name and an arguments object'), session);
    // Shape first, cheaply: an unknown key, a wrong type or anything over its bound is refused before the (costly)
    // redaction boundary ever sees it. Then the boundary, once; an identifier that held a credential is refused
    // outright: it would match nothing, and the error must not echo it.
    const shapeError = argumentProblem(INTERCOM_TOOLS.find((t) => t.name === name).inputSchema.properties, input);
    if (shapeError) return sendJson(res, 200, toolResult(id, { ok: false, code: shapeError.code, error: shapeError.error }, true), session);
    const args = scrub(input);
    if (IDENTIFIERS.some((k) => JSON.stringify(args[k]) !== JSON.stringify(input[k]))) return sendJson(res, 200, toolResult(id, { ok: false, code: 'invalid', error: 'an identifier holds a credential; nothing was recorded' }, true), session);
    try {
      return sendJson(res, 200, toolResult(id, this._dispatch(room, principal.seat, name, args)), session);
    } catch (error) {
      if (!(error instanceof IntercomError)) throw error;
      return sendJson(res, 200, toolResult(id, { ok: false, code: error.code, error: error.message }, true), session);
    }
  }

  _dispatch(room, seat, name, args) {
    if (name === 'read_messages') return room.readMessages(seat, { since: args.since });
    if (name === 'post_message') return room.postMessage(seat, args);
    if (name === 'open_dispute') return room.openDispute(seat, args);
    if (name === 'vote_dispute') return room.voteDispute(seat, args);
    return room.statusFor(seat);
  }
}

export function canBindPort(host = INTERCOM_DEFAULTS.host, port = INTERCOM_DEFAULTS.port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => resolve({ ok: false, error: error.code ?? error.message }));
    server.listen(port, host, () => {
      const bound = server.address().port;
      server.close(() => resolve({ ok: true, port: bound }));
    });
  });
}

// `factory doctor` and `factory council check` rows: the setting is reported even when it is off or there is no council;
// a non-loopback bind is a warning, not a failure.
export async function intercomDoctor(config, { probeBind = canBindPort } = {}) {
  const c = config?.council;
  const targets = [];
  if (c && resolveIntercom(c).enabled) targets.push({ label: 'council.intercom', settings: resolveIntercom(c) });
  // A stage section's own override (`<section>.councilIntercom`).
  for (const section of ['implement', 'architectureReview', 'testPlan', 'testAutomation', 'prCheck']) {
    const own = config?.[section]?.councilIntercom;
    if (own && resolveIntercom(c, own).enabled) targets.push({ label: `${section}.councilIntercom`, settings: resolveIntercom(c, own) });
  }
  if (!targets.length) return { rows: [['council intercom', true, c ? 'disabled (council.intercom.enabled is not true)' : 'disabled (no council configured)']], warnings: [] };
  const rows = [];
  const warnings = [];
  for (const { label, settings: s } of targets) {
    const bind = await probeBind(s.host, s.port);
    const what = `listens on ${s.host}:${s.port === 0 ? 'a free port' : s.port}${s.advertiseHost ? `, advertised as ${s.advertiseHost}` : ''}; maxTurnsPerMember ${s.maxTurnsPerMember}, maxEscalations ${s.maxEscalations}, onSplit ${s.onSplit}`;
    rows.push([`council intercom (${label})`, bind.ok, bind.ok ? what : `cannot bind ${s.host}:${s.port} (${bind.error}); ${what}`]);
    if (!isLoopbackHost(s.host)) warnings.push([`council intercom (${label}) binds ${s.host}`, 'bearer tokens cross the network in clear HTTP; bind 127.0.0.1 and forward with an SSH tunnel (ssh -R) instead']);
  }
  return { rows, warnings };
}
