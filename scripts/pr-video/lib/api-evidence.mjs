// A backend bug's evidence (docs/ai-pipeline/pr-demo-video.md, "Backend bugs: the requests before and after the fix"):
// the bug's reproduction case drives the service through its public interface, inside `reproduction(label, fn)` of the
// shared e2e fixtures (templates/e2e/fixtures.ts), which records every exchange. It runs against the application built
// from the merge base, where it must fail inside the reproduction (at its check), and against the fixed branch, where it
// passes. The harness then posts the ticket's "Reproduction" comment (one comment, edited in place, found by a hidden
// marker) and writes the PR's "Before the fix / After the fix" section. Requests and responses are inserted verbatim from
// the recording (after the redaction boundary); only the wording of the steps and of the "what is wrong" lines may come
// from the demo-narrator agent, and prose that quotes a status, body or value the recording does not hold is refused.
import fs from 'node:fs';
import path from 'node:path';
import { genericHits, PLACEHOLDER_MARKER, redactText } from '../../pipeline/lib/redact.mjs';
import { caseIdOf, parseResult, planCases } from './script.mjs';

// The recorded test of a case (its last attempt), with or without a video.
export const apiTestOfCase = (manifest, caseId) => (manifest?.tests ?? []).filter((t) => caseIdOf(t.title) === caseId).sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0)).at(-1) ?? null;
import { isBug } from './bugpair.mjs';

export const API_EVIDENCE_DEFAULTS = {
  enabled: true,
  // Response and request headers shown (others are left out); credentials are masked by name whatever this says.
  headers: [
    'content-type',
    'location',
    'allow',
    'retry-after',
    'accept',
    'x-requestid',
    'x-request-id',
    'idempotency-key',
    'x-idempotency-key',
    'x-correlation-id',
    'if-match',
    'if-none-match',
  ],
  maxBodyBytes: 1500,
  // Exchange pairs shown per bug in the PR; the rest are collapsed.
  maxPairs: 3,
};
export const apiEvidenceSettings = (config = {}) => ({ ...API_EVIDENCE_DEFAULTS, ...(config.video?.apiEvidence ?? {}) });

const SECRET_NAME = /authorization|cookie|(?<!(?:continuation|page|next|cursor)[-_.]?)token|secret|password|passwd|passphrase|(?:^|[-_.])(?:pass|pwd)(?:$|[-_.])|(?:api|access|private|auth|encryption|signing|subscription|functions?|master|host|client|app)[-_.]?key|client[-_.]?principal|session|credential|signature|(?:^|[-_.])pat$/i;
const MASK = '(masked)';
const CARD_FIELD_MARK = '[redacted:payment-card-field]';
const CARD_PAN_MARK = '[redacted:payment-card]';

// Single pattern classifying card-named keys into: number/PAN, security code (CVV/CVC/CSC), expiry, or holder name.
// Excludes non-sensitive metadata (cardTypeId, cardBrand, last4, orderId, expiresAt) and bare email `cc` objects.
const CARD_OBJECT_KEY = /^(?:(?:credit|debit|payment|billing|buyer)[_ .-]?)?(?:card|payment[_ .-]?card|credit[_ .-]?card|debit[_ .-]?card)$/i;
const CARD_KEY_RE = /^(?:(?:credit|debit|payment|billing|buyer)[_ .-]?)?(?:(?:card|cc)(?:[_ .-]+|\.)?(?:(num(?:ber)?|no|pan)|(cvv2?|cvc2?|cvn|csc|security[_ .-]?(?:code|num(?:ber)?)|verification[_ .-]?(?:code|val(?:ue)?))|(expir(?:y|ation)(?:[_ .-]?(?:date|month|year|mm|yy|yyyy|short))?|exp(?:[_ .-]?(?:date|month|year|mm|yy|yyyy))?)|(holder(?:[_ .-]?name)?|name))|(?:card|cc)\[(?:(num(?:ber)?|no|pan)|(cvv2?|cvc2?|cvn|csc|security[_ .-]?code)|(expir(?:y|ation)(?:[_ .-]?(?:date|month|year|mm|yy|yyyy))?|exp(?:[_ .-]?(?:date|month|year|mm|yy|yyyy))?)|(holder(?:[_ .-]?name)?|name))\]|(primary[_ .-]?account[_ .-]?num(?:ber)?|pan)|(cvv2?|cvc2?|cvn)|(cardholder(?:[_ .-]?name)?|name[_ .-]?on[_ .-]?card))$/i;
const EVIDENCE_FORM_FIELD_RE = /(?<![A-Za-z0-9_.\][%-])([A-Za-z][A-Za-z0-9_.\][%-]*)(\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s&;,)\]}"'\n]+))/g;
const LUHN_CANDIDATE_RE = /(?<![0-9A-Za-z+])(\d(?:[ -]?\d){12,18})(?![0-9A-Za-z])/g;

function decodeKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function cardKeyKind(rawKey, inCardObject = false) {
  const k = decodeKey(rawKey);
  const m = CARD_KEY_RE.exec(inCardObject && !/^(?:card|cc)/i.test(k) ? `card.${k}` : k);
  if (!m) return null;
  if (m[1] || m[5] || m[9]) return 'number';
  if (m[2] || m[6] || m[10]) return 'code';
  if (m[3] || m[7]) return 'expiry';
  return 'holder';
}

function isMaskEligible(val) {
  const s = String(val ?? '').trim();
  if (!s) return false;
  if (s === MASK || s === '***' || s.startsWith('[redacted') || s.toLowerCase().includes(PLACEHOLDER_MARKER)) return false;
  return true;
}

// Value-shape gate (ADV-22): never mask validation sentences (e.g. ValidationProblemDetails arrays) or short invalid
// test inputs like "12" under card-named keys; mask digits/digit-groups, date-like expiries, or holder-name strings.
function matchesCardValueShape(kind, val) {
  if (!isMaskEligible(val)) return false;
  const s = decodeKey(val).trim();
  if (kind === 'number') return /^\d(?:[ -]?\d){11,18}$/.test(s);
  if (kind === 'code') return /^\d{3,4}$/.test(s);
  if (kind === 'expiry') return /^(?:\d{1,2}\s*[/.-]\s*\d{2,4}|\d{4}\s*[/.-]\s*\d{1,2}(?:\s*[/.-]\s*\d{1,2})?(?:T[^\s]*)?|\d{1,2}|\d{4})$/.test(s);
  return kind === 'holder';
}

function isPaymentCardIin(digits) {
  const n = digits.length;
  if (n < 13 || n > 19) return false;
  if (digits[0] === '4') return n === 13 || n === 16 || n === 19;
  if (n === 16 && (/^5[1-5]/.test(digits) || (Number(digits.slice(0, 4)) >= 2221 && Number(digits.slice(0, 4)) <= 2720))) return true;
  if (n === 15 && /^3[47]/.test(digits)) return true;
  if ((n === 16 || n === 19) && (/^(?:6011|64[4-9]|65)/.test(digits) || (Number(digits.slice(0, 6)) >= 622126 && Number(digits.slice(0, 6)) <= 622925))) return true;
  if (n >= 16 && n <= 19 && Number(digits.slice(0, 4)) >= 3528 && Number(digits.slice(0, 4)) <= 3589) return true;
  if ((n === 14 || n === 16 || n === 19) && /^(?:30[0-5]|36|3[89])/.test(digits)) return true;
  if (n >= 16 && n <= 19 && digits.startsWith('62')) return true;
  return /^(?:5018|5020|5038|5893|6304|6759|676[1-3])/.test(digits);
}

function isLuhnValid(digits) {
  if (digits.length < 13 || digits.length > 19 || /^0+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function isPaymentCardNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return isPaymentCardIin(digits) && isLuhnValid(digits);
}

function maskJsonCardField(kind, v) {
  if (v == null) return v;
  // Never mask arrays of validation error messages under holder keys (e.g. ValidationProblemDetails).
  if (Array.isArray(v)) return kind === 'holder' ? v : v.map((x) => maskJsonCardField(kind, x));
  if (typeof v === 'string' || typeof v === 'number') return matchesCardValueShape(kind, v) ? CARD_FIELD_MARK : v;
  return v;
}

function maskJson(v, { inCardObject = false, env = process.env } = {}) {
  if (Array.isArray(v)) return v.map((x) => maskJson(x, { inCardObject, env }));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (SECRET_NAME.test(k)) return [k, MASK];
        const kind = cardKeyKind(k, inCardObject);
        if (kind) return [k, maskJsonCardField(kind, x)];
        if (CARD_OBJECT_KEY.test(decodeKey(k))) return [k, maskJson(x, { inCardObject: true, env })];
        if (typeof x === 'string') {
          const trimmed = x.trim();
          if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
              return [k, JSON.stringify(maskJson(JSON.parse(x), { inCardObject: false, env }))];
            } catch {
              // not valid nested JSON
            }
          }
          return [k, cleanEvidenceText(x, { env }).text];
        }
        return [k, maskJson(x, { inCardObject: false, env })];
      }),
    );
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && isPaymentCardNumber(String(v))) return CARD_PAN_MARK;
  return v;
}

// Evidence-only text cleaner (linear time): general redaction boundary + form-encoded card fields (incl. card[cvc]) +
// 13-19 digit Luhn + valid IIN payment card numbers (plain, single-spaced, or dashed).
export function cleanEvidenceText(raw, { env = process.env } = {}) {
  const base = redactText(String(raw ?? ''), { env });
  const hits = [...base.hits];
  let out = base.text;

  EVIDENCE_FORM_FIELD_RE.lastIndex = 0;
  out = out.replace(EVIDENCE_FORM_FIELD_RE, (m, key, sep, dq, sq, bare) => {
    const kind = cardKeyKind(key);
    if (!kind) return m;
    const val = dq ?? sq ?? bare;
    if (!matchesCardValueShape(kind, val)) return m;
    hits.push('payment-card-field');
    if (dq !== undefined) return `${key}${sep}"${CARD_FIELD_MARK}"`;
    if (sq !== undefined) return `${key}${sep}'${CARD_FIELD_MARK}'`;
    return `${key}${sep}${CARD_FIELD_MARK}`;
  });

  LUHN_CANDIDATE_RE.lastIndex = 0;
  out = out.replace(LUHN_CANDIDATE_RE, (match, num, offset, full) => {
    if (num.includes(' ') && num.includes('-')) return match;
    const before = full.slice(Math.max(0, offset - 2), offset);
    const after = full.slice(offset + match.length, offset + match.length + 2);
    if (/[0-9A-Fa-f]-$|[0-9]\.$/.test(before) || /^-[0-9A-Fa-f]|^\.[0-9]/.test(after)) return match;
    if (!isPaymentCardNumber(num)) return match;
    hits.push('payment-card');
    return CARD_PAN_MARK;
  });

  return { text: out, hits };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// One exchange as it may be shown: the path and query only (no scheme or host), allow-listed headers, credentials masked
// by name, JSON/form/text payment card data cleaned, every value through the detector, bodies truncated with byte count.
export function cleanExchange(x, s = API_EVIDENCE_DEFAULTS, { env = process.env } = {}) {
  const red = (t) => cleanEvidenceText(String(t ?? ''), { env }).text;
  let where = String(x.url ?? x.path ?? '');
  try {
    const u = new URL(where, 'http://host.invalid');
    where = `${u.pathname}${u.search}`;
  } catch {
    // keep as given
  }
  const allow = new Set(s.headers.map((h) => h.toLowerCase()));
  const headers = (obj) => Object.entries(obj ?? {})
    .filter(([k]) => allow.has(k.toLowerCase()) || SECRET_NAME.test(k))
    .map(([k, v]) => [k, SECRET_NAME.test(k) || v === '***' ? MASK : red(v)]);
  const body = (b) => {
    if (b == null || b === '') return null;
    let text = String(b);
    try {
      text = JSON.stringify(maskJson(JSON.parse(text), { env }), null, 2);
    } catch {
      // not JSON
    }
    // The fixture's own mask (a body too large to parse here keeps it) reads the same as the harness's.
    text = red(text).replace(/"\*\*\*"/g, `"${MASK}"`);
    const bytes = Buffer.byteLength(text);
    if (bytes <= s.maxBodyBytes) return text;
    const cut = Buffer.from(text).subarray(0, s.maxBodyBytes).toString('utf8');
    return `${cut}\n… (truncated: ${bytes} bytes in all, ${bytes - Buffer.byteLength(cut)} not shown)`;
  };
  return {
    method: String(x.method ?? 'GET').toUpperCase(),
    path: red(where),
    requestHeaders: headers(x.requestHeaders),
    requestBody: body(x.requestBody),
    status: Number(x.status) || null,
    responseHeaders: headers({ ...(x.responseHeaders ?? {}), ...(x.responseContentType && !x.responseHeaders ? { 'content-type': x.responseContentType } : {}) }),
    responseBody: body(x.responseBody),
    durationMs: x.durationMs ?? null,
    repro: x.repro ?? null,
  };
}

// The backend bugs of a change: bug tickets whose plan has an e2e case a changed spec runs; which one reproduces it
// (records exchanges inside `reproduction` and fails there on the base) is found by running them. Returns
// [{ key, caseIds, specs, preconditions }].
export function backendBugs({ root, cases = null, specs, stateDir = '.factory/state' }) {
  const all = cases ?? planCases(root);
  const texts = specs.map((f) => [f, fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '']);
  const usesRepro = (t) => /\breproduction\s*\(/.test(t);
  const byKey = new Map();
  for (const c of all) if (c.layer === 'e2e' && isBug(root, c.plan, stateDir)) (byKey.get(c.plan) ?? byKey.set(c.plan, []).get(c.plan)).push(c);
  const out = [];
  for (const [key, list] of byKey) {
    const runs = list.filter((c) => texts.some(([, t]) => usesRepro(t) && new RegExp(`\\b${c.id}\\b`).test(t)));
    if (!runs.length) continue;
    const ordered = [...runs].sort((a, b) => a.priority.localeCompare(b.priority) || (a.type === 'sad' ? 0 : 1) - (b.type === 'sad' ? 0 : 1) || b.coversCount - a.coversCount || a.id.localeCompare(b.id));
    out.push({ key, caseIds: ordered.map((c) => c.id), specs: texts.filter(([, t]) => ordered.some((c) => new RegExp(`\\b${c.id}\\b`).test(t))).map(([f]) => f), cases: ordered });
  }
  return out;
}

// The reproduction of one case: the base run failed inside its reproduction (at a Playwright assertion check after its
// exchanges), on a healthy stack, and the fixed run passed it with the same calls. Returns { ok, why, pairs: [{ before, after }] }.
export function verifyApiBefore({ before, after, healthy, beforeFailed = false }) {
  if (healthy === false) return { ok: false, why: 'the test stack built from the base was not healthy during the before run' };
  if (!before) return { ok: false, why: beforeFailed ? 'the before run failed outside the reproduction check (setup failed before the case ran)' : 'the before run did not run this case' };
  if (before.ok) return { ok: false, why: 'the bug does not reproduce on the base: the reproduction check passed before the fix' };
  const failed = before.apiRepro?.failed;
  if (!failed) {
    return {
      ok: false,
      why: before.apiRepro?.labels?.length
        ? 'the before run failed outside the reproduction check (a soft assertion or failure after the reproduction block)'
        : 'the before run failed outside the reproduction check (setup, sign-in or the stack)',
    };
  }
  if (failed.kind === undefined) {
    return { ok: false, why: 'the repository\'s e2e/fixtures.ts is older than the factory (reproduction record has no kind): run `factory render` to update it' };
  }
  if (failed.kind !== 'check') {
    return {
      ok: false,
      why: failed.responses === 0
        ? 'the before run failed outside the reproduction check (before any response was recorded)'
        : 'the before run failed outside the reproduction check (non-assertion error inside reproduction)',
    };
  }
  if (!after?.ok) return { ok: false, why: 'the fixed branch does not pass the reproduction case' };
  const mine = (t) => (t.api ?? []).filter((x) => x.repro === failed.label);
  const b = mine(before);
  const a = mine(after);
  if (!b.length || (failed.responses !== undefined && failed.responses < 1)) return { ok: false, why: 'the before run failed outside the reproduction check (before any response was recorded)' };
  const sig = (x) => `${x.method} ${String(x.url ?? '').replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`;
  if (a.length < b.length || b.some((x, i) => sig(x) !== sig(a[i]))) return { ok: false, why: 'the fixed run made other calls than the before run in the reproduction' };
  return { ok: true, why: null, label: failed.label, check: failed.message, pairs: b.map((x, i) => ({ before: x, after: a[i] })) };
}

// ---- prose ----------------------------------------------------------------------------------------------------------

// Everything a sentence may quote: the statuses, header values and body text of the recorded exchanges.
function recorded(pairs) {
  return pairs.flatMap((p) => [p.before, p.after]).map((x) => [x.method, x.path, x.status, ...x.requestHeaders.flat(), x.requestBody, ...x.responseHeaders.flat(), x.responseBody].filter((v) => v != null).join('\n')).join('\n').toLowerCase();
}

// Errors of the prose for one bug (empty: valid): it may not quote a status, body text or value the recording does not
// hold, and passes the same banned-content and secret checks as a narration script.
export function validateProse(prose, pairs, { env = process.env } = {}) {
  const errors = [];
  if (!prose || !Array.isArray(prose.steps) || prose.steps.length !== pairs.length) return [`give one step per request (${pairs.length})`];
  if (!Array.isArray(prose.wrong) || prose.wrong.length !== pairs.length) errors.push(`give one "what is wrong" line per request (${pairs.length})`);
  if (!Array.isArray(prose.difference) || prose.difference.length !== pairs.length) errors.push(`give one "difference" line per request (${pairs.length})`);
  const text = recorded(pairs);
  const all = [['preconditions', prose.preconditions], ...prose.steps.map((t, i) => [`step ${i + 1}`, t]), ...(prose.wrong ?? []).map((t, i) => [`what is wrong ${i + 1}`, t]), ...(prose.difference ?? []).map((t, i) => [`difference ${i + 1}`, t])];
  for (const [where, raw] of all) {
    const t = String(raw ?? '').trim();
    if (!t) {
      errors.push(`${where} is empty`);
      continue;
    }
    if (t.length > 400) errors.push(`${where} is ${t.length} characters; at most 400`);
    for (const m of t.matchAll(/\b([1-5]\d\d)\b/g)) if (!pairs.some((p) => String(p.before.status) === m[1] || String(p.after.status) === m[1])) errors.push(`${where} quotes the status ${m[1]}, which no recorded response has`);
    for (const m of t.matchAll(/[“"`']([^”"`']{2,120})[”"`']/g)) if (!text.includes(m[1].toLowerCase())) errors.push(`${where} quotes "${m[1].slice(0, 40)}", which the recording does not hold`);
    if (/https?:\/\/|localhost|\b[A-Z][A-Z0-9]+-\d+\b|\bTC-/.test(t)) errors.push(`${where} contains a host, a ticket key or a test-case id`);
    const r = redactText(t, { env });
    if (r.hits.length || genericHits(t).length) errors.push(`${where} contains something the secret detector flags`);
  }
  return errors;
}

// The prose without an agent: plain, from the recording only.
export function plainProse(pairs, preconditions) {
  return {
    preconditions: preconditions || 'The application runs with its seeded test data.',
    steps: pairs.map(() => 'Send the request below.'),
    wrong: pairs.map((p) => `It answers ${p.before.status}${p.after.status !== p.before.status ? `; after the fix the same request answers ${p.after.status}` : ''}.`),
    difference: pairs.map((p) => (p.after.status !== p.before.status ? `The status changes from ${p.before.status} to ${p.after.status}.` : 'The response body changes; the status stays the same.')),
  };
}

export function proseTask(bugs) {
  const lines = [
    'Describe the reproduction of each backend bug below for a person who will follow it by hand. The requests and the responses are recorded and will be shown verbatim next to your words: do not repeat them, and never quote a status, header, body or value that the recording below does not contain.',
    'For each bug give: `preconditions` (the seeded data and who is signed in, in words), one `steps` entry per request (what the person does and why, one sentence), one `wrong` entry per request (one line: whether the base response is an error, malformed or unexpected, and what the ticket expects instead), one `difference` entry per request (one line: the difference that matters between the response before and after the fix).',
    'Answer with exactly one line at the end: AGENT_RESULT: {"bugs": [{"key": "...", "preconditions": "...", "steps": ["..."], "wrong": ["..."], "difference": ["..."]}]}',
  ];
  for (const b of bugs) {
    lines.push('', `## Bug ${b.key}`, '', `Ticket: ${b.ticket.title}`, b.ticket.criteria ? `What it asks for:\n${b.ticket.criteria}` : '', `Case: ${b.case.title}`, b.preconditions ? `Preconditions in the plan: ${b.preconditions}` : '', 'Recorded exchanges (before the fix, then after):', '```json', JSON.stringify(b.pairs, null, 1), '```');
  }
  return lines.filter((l) => l !== '').join('\n');
}

export function writeProse({ config, bugs, runAgent, log = () => {}, env = process.env }) {
  const out = {};
  const runs = [];
  if (!bugs.length) return { prose: out, runs };
  const settings = config.video?.script ?? {};
  let pending = bugs;
  let feedback = null;
  for (let round = 1; round <= 2 && pending.length && runAgent && settings.scope !== 'none'; round++) {
    let res;
    try {
      res = runAgent(config, { name: 'demo-narrator', task: proseTask(pending) + (feedback ? `\n\nYour previous answer did not pass the checks; fix exactly these:\n${feedback.map((f) => `- ${f}`).join('\n')}` : ''), mode: 'read', model: settings.model ?? config.agent?.models?.narrator ?? config.agent?.models?.automation ?? null, timeoutSec: settings.timeoutSec ?? 600, usage: { stage: 'demo-narration', story: pending[0].key, round, step: 'reproduction steps' } });
    } catch (error) {
      res = { ok: false, error: String(error?.message ?? error) };
    }
    runs.push({ round, ok: Boolean(res?.ok), usage: res?.usage ?? null });
    const answer = res?.ok ? parseResult(res.output) : null;
    if (!answer) {
      log(`reproduction steps: the narrator agent ${res?.ok ? 'returned nothing usable' : 'is unavailable'}; plain wording`);
      break;
    }
    const failed = [];
    const errs = [];
    for (const b of pending) {
      const p = (answer.bugs ?? []).find((x) => x?.key === b.key);
      const e = validateProse(p, b.pairs, { env });
      if (!e.length) out[b.key] = { ...p, by: 'agent' };
      else {
        failed.push(b);
        errs.push(...e.map((x) => `${b.key}: ${x}`));
      }
    }
    pending = failed;
    feedback = errs;
    if (pending.length && round === 2) log(`reproduction steps: ${pending.length} answer(s) failed the checks twice; plain wording`);
  }
  for (const b of bugs) if (!out[b.key]) out[b.key] = { ...plainProse(b.pairs, b.preconditions), by: 'automatic' };
  return { prose: out, runs };
}

// ---- rendering ------------------------------------------------------------------------------------------------------

const fence = (t) => {
  const ticks = /```/.test(t) ? '````' : '```';
  return `${ticks}\n${t}\n${ticks}`;
};
export function requestBlock(x) {
  return fence([`${x.method} ${x.path}`, ...x.requestHeaders.map(([k, v]) => `${k}: ${v}`), ...(x.requestBody ? ['', x.requestBody] : [])].join('\n'));
}
export function responseBlock(x) {
  return fence([`HTTP ${x.status}`, ...x.responseHeaders.map(([k, v]) => `${k}: ${v}`), ...(x.responseBody ? ['', x.responseBody] : [])].join('\n'));
}

export const REPRO_MARKER = (key) => `<!-- factory:reproduction:${key} -->`;
// The ticket's "Reproduction" comment.
export function reproductionComment(key, ev, prose) {
  const lines = [REPRO_MARKER(key), '## Reproduction', '', `Recorded on the test stack, on the code this fix starts from${ev.base ? ` (${ev.base.slice(0, 7)})` : ''}. The requests and responses are copied from the recording; credentials are masked.`, '', `1. ${prose.preconditions}`];
  ev.pairs.forEach((p, i) => {
    lines.push(`${i + 2}. ${prose.steps[i]}`, '', requestBlock(p.before).replace(/^/gm, '   '), '', '   The response:', '', responseBlock(p.before).replace(/^/gm, '   '), '', `   What is wrong: ${prose.wrong[i]}`);
  });
  lines.push('', `<sub>Written by the factory's demo step${prose.by === 'agent' ? '; the wording by the demo-narrator agent' : ''}. Edited in place on every delivery.</sub>`);
  return lines.join('\n');
}

export function commentNote(key, comment, { env = process.env } = {}) {
  if (!comment) return null;
  if (!comment.posted) {
    return `> Note: the Reproduction comment was not posted on ticket ${key}: ${redactText(comment.why || 'unknown error', { env }).text}.`;
  }
  if (comment.reduced) {
    return `> Note: the Reproduction comment on ticket ${key} was shortened by the tracker's refusal fallback (dropped: ${(comment.reduced.dropped ?? []).join(', ') || 'sections'}).`;
  }
  return null;
}

// The PR's "Before the fix / After the fix" section for every backend bug (most important pair first: the first is the
// reproduction's failing call, then the order of the calls), with a cap and the rest collapsed.
export function evidenceSection(items, s = API_EVIDENCE_DEFAULTS) {
  const lines = ['## Before the fix / After the fix', ''];
  for (const it of items) {
    lines.push(`### ${it.key}${it.title ? `: ${it.title}` : ''}`, '');
    if (!it.ev?.ok) {
      lines.push(`No before evidence: ${it.why}`, '');
      continue;
    }
    const order = [...it.ev.pairs.keys()].reverse();
    const show = (i) => {
      const p = it.ev.pairs[i];
      return ['', `**${i + 1}.** ${it.prose.steps[i]}`, '', requestBlock(p.before), '', 'Before the fix:', '', responseBlock(p.before), '', 'After the fix:', '', responseBlock(p.after), '', `**What changed:** ${it.prose.difference[i]}`];
    };
    order.slice(0, s.maxPairs).forEach((i) => lines.push(...show(i)));
    if (order.length > s.maxPairs) {
      lines.push('', `<details><summary>${order.length - s.maxPairs} more request(s)</summary>`);
      order.slice(s.maxPairs).forEach((i) => lines.push(...show(i)));
      lines.push('', '</details>');
    }
    const note = commentNote(it.key, it.comment);
    if (note) lines.push('', note);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Whether a text that is about to be posted or stored holds anything the detector, evidence card rules or generic
// credential pattern flags.
export function scanHits(text, { env = process.env } = {}) {
  const r = cleanEvidenceText(String(text ?? ''), { env });
  return [...new Set([...r.hits, ...(genericHits(String(text ?? '')).length ? ['generic-key-pattern'] : [])])];
}

// The issue number of a ticket, from the ticket cache.
export function issueNumberOf(root, key, stateDir = '.factory/state') {
  const meta = readJson(path.join(root, stateDir, 'board', key, 'meta.json'));
  return meta?.issue?.number ?? (Number(/\/issues\/(\d+)/.exec(meta?.issue?.url ?? '')?.[1]) || null);
}
