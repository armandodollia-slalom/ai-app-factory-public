// Council intercom room: the dispute state machine, its caps, and its journal (docs/ai-pipeline/council-intercom.md).
// A room lives in one process only: it is created, discussed and closed there, and never loaded back. Every event is
// redacted and fsynced to the room's journal before the room's state changes and before the caller gets an answer, so
// after a crash the journal is complete up to the last acknowledged event (an audit record; recovery runs the
// discussion again, intercom.mjs). Plaintext tokens never reach disk: only this process's memory and the member's env.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { INTERCOM_DEFAULTS } from './council-config.mjs';
import { redactValue, rememberSecret } from './redact.mjs';
import { nowIso, sha } from './util.mjs';

export const DISPUTE_KINDS = ['fact', 'fix', 'product'];
export const DISPUTE_EFFECTS = ['drop', 'keep', 'note'];
export const FIELD_LIMITS = { text: 4096, evidence: 2048, position: 500, question: 300, reason: 300, id: 80, withdrawFindings: 20 };

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
export const safeSlug = (v) => String(v ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
const oneLine = (text, max) => str(text).replace(/\s+/g, ' ').slice(0, max);
const clampLines = (text) => str(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).map((l) => l.slice(0, 240)).join('\n');
const oneSentence = (text) => {
  const flat = oneLine(text, 2000);
  return (/^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat).slice(0, FIELD_LIMITS.question);
};

export class IntercomError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

// ---- tokens and the redaction boundary --------------------------------------------------------------------------------
export const tokenDigest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const TOKEN_LENGTH = 32; // randomBytes(24) in base64url
const issued = new Set(); // digests of every token this process issued, for the whole run

export function generateToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  issued.add(tokenDigest(token));
  rememberSecret(token, 'intercom-token');
  return token;
}

// A run of base64url characters holding an issued token anywhere inside it (next to punctuation, inside an identifier)
// is replaced whole.
function scrubTokens(text) {
  if (!issued.size) return text;
  return text.replace(/[A-Za-z0-9_-]{32,}/g, (run) => {
    for (let i = 0; i + TOKEN_LENGTH <= run.length; i++) if (issued.has(tokenDigest(run.slice(i, i + TOKEN_LENGTH)))) return '[redacted:intercom-token]';
    return run;
  });
}

const walk = (value, fn) => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, fn));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, fn)]));
  return value;
};

// The redaction boundary of the intercom: the factory's rules (redact.mjs) plus every issued token. Applied once to a
// member's tool input (intercom-server.mjs) and once to every journal event as it is written.
export const scrub = (value) => redactValue(walk(value, scrubTokens));

// ---- room ids and the journal -------------------------------------------------------------------------------------------
// The prefix names the council round and its inputs (intercom.mjs roundKey); a random suffix makes every room unique.
export const roomPrefix = ({ subject, stage, step = null, round = 1, key }) => [stage, subject, step, `r${round}`, key].filter((x) => x != null && x !== '').map(safeSlug).join('--');
export const newRoomId = (prefix) => `${prefix}--${crypto.randomBytes(4).toString('hex')}`;

// Every event of a journal. The text after the last newline is a line whose write never finished (never acknowledged):
// it is ignored. Any other line that does not parse is an error naming the file and line, never a silent truncation.
export function readJournal(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`council intercom journal ${file}, line ${i + 1}: not a complete JSON record; the journal is damaged (move it aside to run the discussion again)`);
    }
  });
}

// Appends one record to the journal of a room no process holds (closed or abandoned), after dropping an unfinished last
// line. All or nothing: if the write or the sync fails, the journal is cut back to where it was and the error is thrown.
// Once the sync succeeded the record is on disk, so a failure to close the descriptor afterwards goes to `log` and the
// append still succeeds (what the caller reports and what a later reader sees always agree).
export function appendToJournal(file, event, { log = null } = {}) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(0x0a) + 1;
  if (end < buf.length) fs.truncateSync(file, end);
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(scrub({ ts: nowIso(), ...event }))}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.ftruncateSync(fd, end);
    } finally {
      closeQuietly(fd);
    }
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    log?.(`council intercom: ${file}: its ${event.type} record is on disk, but closing the file failed (${error.message})`);
  }
}

const closeQuietly = (fd) => {
  try {
    fs.closeSync(fd);
  } catch {
    // the error that matters is the one being thrown
  }
};

// ---- fact evidence ------------------------------------------------------------------------------------------------------
// `src/a.js:42`, `lib/foo:12`, `Dockerfile:8`; not URLs, times or versions.
const FILE_LINE_RE = /(?<![A-Za-z0-9_:/])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_]+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|Makefile|Dockerfile|Jenkinsfile|Procfile):(\d+)(?!\d*\/\/)/g;

// A fact position needs a citation of a line that exists in a file inside the repository root (symlinks resolved).
export function resolveFactEvidence(text, repoRoot) {
  const cited = [...String(text ?? '').matchAll(FILE_LINE_RE)].map((m) => ({ file: m[1], line: Number(m[2]), raw: `${m[1]}:${m[2]}` })).filter((c) => /[A-Za-z]/.test(c.file) && c.line > 0);
  if (!cited.length) return { ok: false, reason: 'a fact position needs file:line evidence (for example src/app.js:42)' };
  if (!repoRoot) return { ok: true, citations: cited.map((c) => c.raw) };
  const root = fs.realpathSync(repoRoot);
  // Each file is read once for all its cited lines, within a byte budget per file and per call.
  const lines = new Map(); // abs -> highest cited line
  const where = cited.map((c) => {
    try {
      const abs = fs.realpathSync(path.resolve(root, c.file));
      if (!abs.startsWith(`${root}${path.sep}`) || !fs.statSync(abs).isFile()) return null;
      lines.set(abs, Math.max(lines.get(abs) ?? 0, c.line));
      return abs;
    } catch {
      return null;
    }
  });
  let budget = MAX_CITED_CALL_BYTES;
  const known = new Map(); // abs -> { started, complete }
  for (const [abs, want] of lines) {
    const scan = startedLines(abs, want, Math.min(MAX_CITED_BYTES, budget));
    budget -= scan.bytes;
    known.set(abs, scan);
  }
  const results = cited.map((c, i) => {
    const scan = where[i] && known.get(where[i]);
    if (!scan) return 'missing';
    return c.line <= scan.started ? 'ok' : scan.complete ? 'missing' : 'beyond';
  });
  const valid = cited.filter((_, i) => results[i] === 'ok');
  if (!valid.length) {
    const far = results.includes('beyond') ? `; a cited line must start within the first ${MAX_CITED_BYTES / 1024 / 1024} MB of its file, and one dispute or vote reads at most ${MAX_CITED_CALL_BYTES / 1024 / 1024} MB of cited files` : '';
    return { ok: false, reason: `fact evidence must cite an existing line of a file in the repository (none of ${cited.map((c) => c.raw).join(', ')} does${far})` };
  }
  return { ok: true, citations: valid.map((c) => c.raw) };
}

const MAX_CITED_BYTES = 2 * 1024 * 1024;
const MAX_CITED_CALL_BYTES = 4 * 1024 * 1024;

// How many lines of the file have started within its first `limit` bytes, read only until `want` lines have: a line
// has started when a byte follows the newline before it. `complete` means the whole file was read.
function startedLines(abs, want, limit) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytes = 0;
    let newlines = 0;
    let last = -1;
    const started = () => (bytes ? newlines - (last === 0x0a ? 1 : 0) + 1 : 0);
    while (bytes < limit && started() < want) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, limit - bytes), bytes);
      if (!n) return { started: started(), complete: true, bytes };
      for (let i = buf.indexOf(0x0a); i !== -1 && i < n; i = buf.indexOf(0x0a, i + 1)) newlines++;
      last = buf[n - 1];
      bytes += n;
    }
    return { started: started(), complete: false, bytes };
  } finally {
    fs.closeSync(fd);
  }
}

// ---- when to discuss, and finding identity -----------------------------------------------------------------------------
// Round 1 only, enabled, no read-only violation, every seat terminal, at least two results, and something to discuss.
export function shouldDiscuss(council, results = [], { violation = null, round = 1 } = {}) {
  if (!council?.intercom?.enabled || violation || round !== 1) return false;
  if (results.some((r) => !r || r.status === 'pending' || r.status === 'late')) return false;
  const ok = results.filter((r) => r.status === 'ok');
  if (ok.length < 2) return false;
  if (ok.some((r) => r.findings?.length)) return true;
  return new Set(ok.map((r) => r.score)).size > 1 || new Set(ok.map((r) => r.verdict)).size > 1;
}

// Every finding gets a collision-free key, `<seat>:<position>`, on the normalized finding (`intercomId`). A member's own
// id is an alias, resolved by the room only when it names exactly one finding.
export function ensureFindingIds(results = []) {
  for (const r of results) {
    if (r?.status !== 'ok' || !Array.isArray(r.findings)) continue;
    r.findings.forEach((f, i) => {
      if (f && typeof f === 'object') f.intercomId = `${safeSlug(r.member?.name)}:${i + 1}`;
    });
  }
  return results;
}

// ---- the room -----------------------------------------------------------------------------------------------------------
// The open event, every seat's seed (original result and index, or why it has none), and the finding aliases.
function seedRoom(room, { roomId, meta, seats, results }) {
  room._write({ type: 'open', roomId, meta: { ...meta, pid: process.pid }, seats, config: { maxTurnsPerMember: room.config.maxTurnsPerMember, maxEscalations: room.config.maxEscalations, onSplit: room.config.onSplit } });
  ensureFindingIds(results);
  const aliases = new Map();
  for (const r of results) {
    const seat = r?.member?.name;
    if (!seat) continue;
    if (r.status !== 'ok') {
      room._write({ type: 'seed', seat, status: r.status, reason: oneLine(r.reason, 300) });
      room.markDisconnected(seat, `no round-1 result (${r.status})`);
      continue;
    }
    const findings = (r.findings ?? []).filter((f) => f?.intercomId);
    const index = findings.map((f) => ({ id: f.intercomId, rawId: str(f.id) || null, author: seat, severity: f.severity ?? null, title: oneLine(f.text || f.issue || f.title, 300), file: f.file ?? null, line: f.line ?? null }));
    const original = r.rawResult ?? { score: r.score ?? null, verdict: r.verdict ?? null, summary: r.summary ?? '', findings: r.findings ?? [] };
    const clean = room._write({ type: 'seed', seat, status: 'ok', original, index });
    for (const item of clean.index) {
      room.findings.set(item.id, item);
      for (const alias of [item.rawId && `${seat}:${item.rawId}`, item.rawId].filter(Boolean)) aliases.set(alias, aliases.has(alias) ? null : item.id);
    }
  }
  for (const seat of seats) if (!results.some((r) => r?.member?.name === seat)) room.markDisconnected(seat, 'no round-1 result');
  // An alias that is also a key, or that names two findings, is never used.
  for (const [alias, id] of aliases) if (id && !room.findings.has(alias)) room.aliases.set(alias, id);
}

const VISIBLE = new Set(['seed', 'message', 'dispute', 'vote', 'resolution', 'ruling']);

export class IntercomRoom {
  // `seats` is the full roster; only `results` with status ok get a token and can join. Seats without a result are
  // recorded as disconnected from the start, and still count for the majority.
  static create({ roomId, meta = {}, seats, config = {}, file = null, repoRoot = null, results = [] }) {
    const room = new IntercomRoom({ roomId, seats, config, file, repoRoot });
    const joining = results.filter((r) => r?.status === 'ok').map((r) => r.member.name);
    const tokens = Object.fromEntries(joining.map((s) => [s, generateToken()]));
    room.joinable = new Set(joining);
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        room.fd = fs.openSync(file, 'ax', 0o600); // append: a write after a cut-off lands at the new end, never past it
      } catch (error) {
        if (error.code === 'EEXIST') throw new IntercomError(`room journal already exists: ${file}`, 'room_exists');
        throw error;
      }
    }
    try {
      seedRoom(room, { roomId, meta, seats, results });
    } catch (error) {
      room.abort();
      throw error;
    }
    return { room, tokens };
  }

  constructor({ roomId, seats, config, file, repoRoot }) {
    Object.assign(this, { roomId, seats: [...seats], file, repoRoot, fd: null, nextSeq: 1, status: 'open' });
    this.config = { ...INTERCOM_DEFAULTS, ...config };
    this.maxMutations = this.config.maxTurnsPerMember * 2;
    this.joinable = new Set();
    this.connected = new Set();
    this.disconnected = new Map(); // seat -> reason
    this.messages = [];
    this.cursors = new Map();
    this.findings = new Map(); // key -> { id, rawId, author, title, ... }
    this.aliases = new Map(); // a member's own id (bare or seat:id), when unique -> key
    this.disputes = new Map(); // D<n> -> dispute
    this.byFinding = new Map(); // key -> D<n>
    this.withdrawn = new Map(); // key -> { findingId, by, reason }
    this.scoreChanges = new Map();
    this.turns = new Map();
    this.mutations = new Map();
    this.requests = new Map(); // seat\0requestId -> { op, hash, ack }
    this.escalations = 0;
  }

  // Redacted, written and fsynced before anything changes. A write that fails changes nothing: the record is cut off
  // the journal again (so a failed close never reads as finished), and the room is failed (intercom.mjs marks it).
  _write(event) {
    if (this.failed) throw new IntercomError(`room ${this.roomId} failed: its journal could not be written`, 'room_failed');
    if (this.status !== 'open') throw new IntercomError(`room ${this.roomId} is closed`, 'room_closed');
    const clean = scrub({ seq: this.nextSeq, ts: nowIso(), ...event });
    if (this.fd !== null) {
      const size = fs.fstatSync(this.fd).size;
      try {
        fs.writeSync(this.fd, `${JSON.stringify(clean)}\n`);
        fs.fsyncSync(this.fd);
      } catch (error) {
        this.failed = true;
        try {
          fs.ftruncateSync(this.fd, size);
        } catch {
          // the runner marks the journal failed as well
        }
        throw error;
      }
    }
    this.nextSeq++;
    if (VISIBLE.has(clean.type)) this.messages.push(clean);
    return clean;
  }

  // Every tool call: the seat must have a place, and its first call marks it as taking part in the room.
  _seat(seat) {
    if (!this.joinable.has(seat)) throw new IntercomError(`seat "${seat}" has no place in this room`, 'forbidden');
    if (this.connected.has(seat) || this.status !== 'open') return;
    this._write({ type: 'connected', seat });
    this.connected.add(seat);
  }

  // A retried call with the same requestId gets the first answer; the same id on another call or payload is refused.
  _once(seat, op, args, fn) {
    const id = args.requestId;
    if (id === undefined || id === null || id === '') return fn();
    if (typeof id !== 'string' || id.length > FIELD_LIMITS.id) throw new IntercomError(`requestId must be a string of at most ${FIELD_LIMITS.id} characters`);
    const key = `${seat}\0${id}`;
    const hash = sha(JSON.stringify([op, { ...args, requestId: null }]));
    const seen = this.requests.get(key);
    if (seen) {
      if (seen.op !== op || seen.hash !== hash) throw new IntercomError('requestId was already used for a different call', 'request_id_reused');
      return { ...seen.ack, deduplicated: true };
    }
    const ack = fn();
    this.requests.set(key, { op, hash, ack });
    return ack;
  }

  markDisconnected(seat, reason) {
    if (this.disconnected.has(seat) || this.status !== 'open') return;
    const ev = this._write({ type: 'member_status', seat, status: 'disconnected', reason: oneLine(reason, 300) });
    this.disconnected.set(seat, ev.reason);
  }

  resolveFindingId(findingId) {
    const fid = str(findingId);
    if (!fid || fid.length > FIELD_LIMITS.id) throw new IntercomError(`findingId is required (at most ${FIELD_LIMITS.id} characters)`);
    const key = this.findings.has(fid) ? fid : this.aliases.get(fid);
    if (!key) throw new IntercomError(`unknown or ambiguous findingId "${fid}"; use a key from the seed index (<seat>:<n>)`, 'not_found');
    return key;
  }

  _text(name, value, { required = false } = {}) {
    if (value !== undefined && value !== null && typeof value !== 'string') throw new IntercomError(`${name} must be a string`);
    const text = str(value);
    if (text.length > FIELD_LIMITS[name]) throw new IntercomError(`${name} exceeds ${FIELD_LIMITS[name]} characters`, 'too_large');
    if (required && !text) throw new IntercomError(`${name} is required`);
    return text;
  }

  // The cursor moves only when the member acknowledges with `since`, so a lost reply is read again.
  readMessages(seat, { since = null } = {}) {
    this._seat(seat);
    if (since !== null && since !== undefined) {
      if (!Number.isInteger(since) || since < 0) throw new IntercomError('since must be a non-negative integer');
      this.cursors.set(seat, Math.max(this.cursors.get(seat) ?? 0, Math.min(since, this.nextSeq - 1)));
    }
    const from = this.cursors.get(seat) ?? 0;
    const messages = this.messages.filter((m) => m.seq > from);
    return { roomId: this.roomId, seat, nextSince: messages.at(-1)?.seq ?? from, messages, roomStatus: this.failed ? 'failed' : this.status };
  }

  postMessage(seat, args = {}) {
    this._seat(seat);
    return this._once(seat, 'post_message', args, () => {
      const used = this.turns.get(seat) ?? 0;
      if (used >= this.config.maxTurnsPerMember) throw new IntercomError(`turn cap reached: ${used} post(s) of ${this.config.maxTurnsPerMember}`, 'turn_cap');
      const text = this._text('text', args.text);
      const list = args.withdrawFindings == null ? [] : Array.isArray(args.withdrawFindings) ? args.withdrawFindings : [args.withdrawFindings];
      if (list.length > FIELD_LIMITS.withdrawFindings) throw new IntercomError(`withdrawFindings holds at most ${FIELD_LIMITS.withdrawFindings} ids`, 'too_large');
      const withdraw = [...new Set(list.map((id) => this.resolveFindingId(id)))];
      for (const key of withdraw) if (this.findings.get(key).author !== seat) throw new IntercomError(`only the author can withdraw ${key}; open a dispute instead`, 'not_author');
      let score;
      if (args.score !== undefined && args.score !== null) {
        if (typeof args.score !== 'number' || !(args.score >= 0 && args.score <= 10)) throw new IntercomError('score must be a number from 0 to 10');
        score = args.score;
      }
      if (args.verdict != null && !['APPROVED', 'CHANGES_REQUESTED'].includes(args.verdict)) throw new IntercomError('verdict must be APPROVED or CHANGES_REQUESTED');
      const verdict = args.verdict ?? undefined;
      if (!text && !withdraw.length && score === undefined && verdict === undefined) throw new IntercomError('post_message needs text, withdrawFindings, score or verdict');
      const ev = this._write({ type: 'message', seat, text, ...(withdraw.length ? { withdrawFindings: withdraw } : {}), ...(score !== undefined ? { score } : {}), ...(verdict ? { verdict } : {}) });
      this.turns.set(seat, used + 1);
      for (const key of withdraw) {
        this.withdrawn.set(key, { findingId: key, by: seat, reason: oneLine(ev.text, 240) });
        const d = this.disputes.get(this.byFinding.get(key));
        if (d && (d.status === 'open' || d.status === 'escalated')) this._settle(d, { status: 'settled', outcome: 'drop', againstFinding: true, withdrawn: true });
      }
      if (score !== undefined || verdict) this.scoreChanges.set(seat, { ...this.scoreChanges.get(seat), ...(score !== undefined ? { score } : {}), ...(verdict ? { verdict } : {}) });
      return { ok: true, seq: ev.seq, turnsLeft: this.config.maxTurnsPerMember - used - 1 };
    });
  }

  _mutation(seat) {
    const used = this.mutations.get(seat) ?? 0;
    if (used >= this.maxMutations) throw new IntercomError(`dispute and vote cap reached (${this.maxMutations} per member)`, 'mutation_cap');
    return used;
  }

  // A vote's evidence: a fact position must cite an existing file:line in the repository.
  _vote(seat, d, args) {
    const effect = d.kind === 'product' ? null : args.effect;
    if (d.kind !== 'product' && !DISPUTE_EFFECTS.includes(effect)) throw new IntercomError(`effect is required: ${DISPUTE_EFFECTS.join(', ')}`);
    const vote = { seat, effect, position: this._text('position', args.position) || effect, evidence: this._text('evidence', args.evidence) };
    if (d.kind === 'fact') {
      const check = resolveFactEvidence(vote.evidence, this.repoRoot);
      if (!check.ok) throw new IntercomError(check.reason, 'evidence_required');
    }
    return vote;
  }

  openDispute(seat, args = {}) {
    this._seat(seat);
    return this._once(seat, 'open_dispute', args, () => {
      const key = this.resolveFindingId(args.findingId);
      const existing = this.disputes.get(this.byFinding.get(key));
      if (existing) throw new IntercomError(`${existing.disputeId} already exists for ${key} (${existing.status}); a closed dispute is never reopened`, existing.status === 'open' ? 'dispute_exists' : 'dispute_closed');
      if (this.withdrawn.has(key)) throw new IntercomError(`${key} was withdrawn by its author`, 'dispute_closed');
      if (!DISPUTE_KINDS.includes(args.kind)) throw new IntercomError(`kind must be one of ${DISPUTE_KINDS.join(', ')}`);
      const used = this._mutation(seat);
      const finding = this.findings.get(key);
      const d = { disputeId: `D${this.disputes.size + 1}`, findingId: key, author: finding.author, kind: args.kind, openedBy: seat, status: 'open', votes: new Map() };
      const vote = this._vote(seat, d, { ...args, position: this._text('position', args.position, { required: true }) });
      d.question = oneSentence(this._text('question', args.question) || `Does finding ${key} (${finding.title.slice(0, 140)}) stand?`);
      const ev = this._write({ type: 'dispute', seat, disputeId: d.disputeId, findingId: key, kind: d.kind, question: d.question, vote });
      this.mutations.set(seat, used + 1);
      d.question = ev.question;
      d.votes.set(seat, ev.vote);
      this.disputes.set(d.disputeId, d);
      this.byFinding.set(key, d.disputeId);
      if (d.kind === 'product') this._settle(d, { status: 'owner_question', ownerReason: 'product dispute: the owner decides' });
      else this._check(d, false);
      return { ok: true, disputeId: d.disputeId, findingId: key, status: d.status, mutationsLeft: this.maxMutations - used - 1 };
    });
  }

  voteDispute(seat, args = {}) {
    this._seat(seat);
    return this._once(seat, 'vote_dispute', args, () => {
      const d = args.disputeId ? this.disputes.get(str(args.disputeId)) : this.disputes.get(this.byFinding.get(this.resolveFindingId(args.findingId)));
      if (!d) throw new IntercomError('unknown dispute', 'not_found');
      if (d.status !== 'open') throw new IntercomError(`${d.disputeId} is closed (${d.status})`, 'dispute_closed');
      const vote = this._vote(seat, d, args);
      const prev = d.votes.get(seat);
      if (prev && JSON.stringify(prev) === JSON.stringify(vote)) return { ok: true, idempotent: true, disputeId: d.disputeId, status: d.status, mutationsLeft: this.maxMutations - (this.mutations.get(seat) ?? 0) };
      const used = this._mutation(seat);
      const ev = this._write({ type: 'vote', seat, disputeId: d.disputeId, findingId: d.findingId, vote });
      this.mutations.set(seat, used + 1);
      d.votes.set(seat, ev.vote);
      this._check(d, false);
      return { ok: true, disputeId: d.disputeId, status: d.status, ...(d.outcome ? { outcome: d.outcome } : {}), mutationsLeft: this.maxMutations - used - 1 };
    });
  }

  // Majority of the whole roster on `effect`. A drop or note needs the finding's author to have taken part in the room
  // (any tool call; silence on this dispute is no veto); while that is unknown nothing is dropped, and an author who
  // never took part leaves the finding to the owner. A split (no effect can still reach the majority) escalates for a
  // ruling, or goes to the owner.
  _decide(d, final) {
    const majority = Math.floor(this.seats.length / 2) + 1;
    const counts = new Map();
    for (const v of d.votes.values()) counts.set(v.effect, (counts.get(v.effect) ?? 0) + 1);
    const tally = DISPUTE_EFFECTS.filter((e) => counts.has(e)).map((effect) => ({ effect, count: counts.get(effect) }));
    const authorIn = this.connected.has(d.author);
    const noAuthor = `a finding is dropped only when its author took part in the discussion, and ${d.author} never did`;
    const winner = tally.find((t) => t.count >= majority);
    if (winner) {
      if (winner.effect === 'keep' || authorIn) return { status: 'settled', outcome: winner.effect, againstFinding: winner.effect !== 'keep', tally };
      return final ? { status: 'owner_question', tally, ownerReason: noAuthor } : null;
    }
    const undecided = this.seats.filter((s) => !d.votes.has(s) && !this.disconnected.has(s)).length;
    if (!final && Math.max(0, ...tally.map((t) => t.count)) + undecided >= majority) return null;
    if (!authorIn) return final ? { status: 'owner_question', tally, ownerReason: `split; ${noAuthor}` } : null;
    if (this.config.onSplit === 'owner' || this.escalations >= this.config.maxEscalations) {
      return { status: 'owner_question', tally, ownerReason: this.config.onSplit === 'owner' ? 'split (onSplit: owner)' : `split beyond maxEscalations (${this.config.maxEscalations})` };
    }
    const positions = [...d.votes.values()].map((v) => ({ seat: v.seat, effect: v.effect, position: clampLines(v.position), evidence: oneLine(v.evidence, 300) }));
    return { status: 'escalated', tally, escalation: { disputeId: d.disputeId, findingId: d.findingId, kind: d.kind, question: d.question, positions } };
  }

  _check(d, final) {
    const res = this._decide(d, final);
    if (res) this._settle(d, res);
  }

  _settle(d, res) {
    const { type: _t, seq: _s, ts: _ts, disputeId: _d, findingId: _f, ...clean } = this._write({ type: 'resolution', disputeId: d.disputeId, findingId: d.findingId, ...res });
    Object.assign(d, clean);
    if (res.status === 'escalated') this.escalations++;
  }

  // End of the discussion: every open dispute is decided as it stands.
  finalize() {
    for (const d of this.disputes.values()) if (d.status === 'open') this._check(d, true);
  }

  // A ruling on an escalated dispute only (the stage's orchestrating or judging model, intercom.mjs).
  rule(disputeId, { ruling, reason, by }) {
    const d = this.disputes.get(disputeId);
    if (d?.status !== 'escalated') throw new IntercomError(`${disputeId} is not awaiting a ruling`, 'dispute_closed');
    const ev = this._write({ type: 'ruling', disputeId, findingId: d.findingId, ruling, reason, by });
    Object.assign(d, { status: 'ruled', outcome: ruling, againstFinding: ruling !== 'keep', reason: ev.reason, by });
  }

  toOwner(disputeId, reason) {
    const d = this.disputes.get(disputeId);
    if (d?.status === 'escalated') this._settle(d, { status: 'owner_question', tally: d.tally, ownerReason: oneLine(reason, 300) });
  }

  escalated() {
    return [...this.disputes.values()].filter((d) => d.status === 'escalated');
  }

  statusFor(seat) {
    this._seat(seat);
    const all = [...this.disputes.values()];
    return {
      roomId: this.roomId,
      status: this.failed ? 'failed' : this.status,
      seats: this.seats,
      turnsLeft: this.config.maxTurnsPerMember - (this.turns.get(seat) ?? 0),
      mutationsLeft: this.maxMutations - (this.mutations.get(seat) ?? 0),
      disputes: all.map((d) => ({ disputeId: d.disputeId, findingId: d.findingId, kind: d.kind, status: d.status, question: d.question, votes: [...d.votes.values()].map((v) => ({ seat: v.seat, effect: v.effect })) })),
      withdrawn: [...this.withdrawn.keys()],
    };
  }

  // The compact result the orchestrator and mergeCouncil get: bounded, no transcript text, no tokens.
  summary() {
    const all = [...this.disputes.values()];
    const entry = (d) => ({ disputeId: d.disputeId, findingId: d.findingId, findingAuthor: d.author, kind: d.kind });
    const votes = (d) => [...d.votes.values()].map((v) => ({ seat: v.seat, effect: v.effect, position: clampLines(v.position), evidence: oneLine(v.evidence, 300) }));
    return {
      roomId: this.roomId,
      transcript: this.file,
      settledDisputes: all.filter((d) => d.status === 'settled').map((d) => ({ ...entry(d), outcome: d.outcome, againstFinding: d.againstFinding, tally: d.tally ?? [], ...(d.withdrawn ? { withdrawn: true } : {}) })),
      rulings: all.filter((d) => d.status === 'ruled').map((d) => ({ ...entry(d), ruling: d.outcome, againstFinding: d.againstFinding, reason: d.reason, by: d.by })),
      awaitingRuling: this.escalated().map((d) => d.escalation),
      ownerQuestions: all.filter((d) => d.status === 'owner_question').map((d) => ({ ...entry(d), question: d.question, reason: d.ownerReason, positions: votes(d) })),
      withdrawn: [...this.withdrawn.values()],
      scoreChanges: Object.fromEntries(this.scoreChanges),
      disconnected: [...this.disconnected].map(([seat, reason]) => ({ seat, reason })),
      connectedSeats: [...this.connected],
    };
  }

  // Closes the room with its final result (and the round-1 results it was merged with), so a re-run of the same round
  // and `factory council review --rulings` read it back without running anyone.
  close(reason, { result, results = [] } = {}) {
    if (this.status !== 'open') return;
    try {
      this._write({ type: 'close', reason, result, results: results.map(({ res: _res, member, ...r }) => ({ ...r, member: member?.name })) });
    } finally {
      this.abort();
    }
  }

  // Stops the room without a close event: its journal stays unfinished (a re-run marks it abandoned).
  abort() {
    this.status = 'closed';
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}
