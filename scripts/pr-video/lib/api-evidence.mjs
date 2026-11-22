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
  // A payment exchange (card data by name or by shape anywhere in it): `withhold` (the guarantee) publishes its method,
  // path without the query and status only; `mask` publishes it with card data masked (best effort, see the docs).
  paymentBodies: 'withhold',
};
export const apiEvidenceSettings = (config = {}) => ({ ...API_EVIDENCE_DEFAULTS, ...(config.video?.apiEvidence ?? {}) });

const SECRET_NAME = /authorization|cookie|(?<!(?:continuation|page|next|cursor)[-_.]?)token|secret|password|passwd|passphrase|(?:^|[-_.])(?:pass|pwd)(?:$|[-_.])|(?:api|access|private|auth|encryption|signing|subscription|functions?|master|host|client|app)[-_.]?key|client[-_.]?principal|session|credential|signature|(?:^|[-_.])pat$/i;
const MASK = '(masked)';
const CARD_FIELD_MARK = '[redacted:payment-card-field]';
const CARD_PAN_MARK = '[redacted:payment-card]';

// ---- payment card data: evidence only (the general redaction boundary, redact.mjs, has no card rules) ----------------
// Every rule below reads the text once, left to right, and never parses and prints a body again: what is shown is what
// was sent, with only the masked values replaced.

// The rule (docs/ai-pipeline/pr-demo-video.md, card data). A value is masked when:
//   (a) its key (JSON key, form key, XML element or attribute name, a multi-word key in key/value text such as
//       "card security code:") is a card field by the key table below: a field word after `card` or `cc` (with an
//       optional credit, debit, payment, billing or buyer before it), or `pan`, `cvv`, `cvc`, `cvn`, `csc`, `ccv`,
//       `primaryAccountNumber`, `nameOnCard`, `cardholder`; whatever the value's shape, and everything beneath such a key
//       (`cardExpiry: { month, year }`, a list of validation messages);
//   (b) it sits beneath a card container: an object or element named as a card or payment-card object (`creditCard`,
//       `paymentCard`, `cardDetails`, `cardInfo`, `cardData`, …), or named `card` or as a payment method and holding a
//       card number, code or expiry at any depth, or named `payment` and holding one as its own field: beneath it
//       everything is masked except a short list of plainly non-card fields
//       (type, brand, network, scheme, funding, country, currency, last four, status), and a bare field word (`number`,
//       `name`, `holder`, `expiry`, …) is a card field;
//   (c) it equals, as a whole token, a value masked under (a) or (b) in a request (its URL, headers or body) of the same
//       evidence (an echo): in any position of an exchange that looks like a payment (a 3 or 4 digit code as a whole
//       number), elsewhere quoted or after `=`. Only values masked as card fields (and card numbers) are echo values.
// An object that merely holds card fields beside other fields (an order with `cardNumber` next to `city` and `items`) is
// not a container: only its card fields are masked. A key is compared lower-cased and without separators (card_number,
// card-number, cardNumber, card[number], card.number and "card number" all read `cardnumber`).
const CARD_PREFIXES = ['credit', 'debit', 'payment', 'billing', 'buyer'];
const CARD_WORDS = ['card', 'cc'];
const expiryWords = [...['expiry', 'expiration'].flatMap((w) => ['', 'date', 'month', 'year', 'mm', 'yy', 'yyyy', 'short'].map((s) => `${w}${s}`)), ...['', 'date', 'month', 'year', 'mm', 'yy', 'yyyy'].map((s) => `exp${s}`)];
const CARD_FIELDS = new Map([
  ...['number', 'num', 'no', 'pan'].map((w) => [w, 'number']),
  ...['cvv', 'cvv2', 'cvc', 'cvc2', 'cvn', 'csc', 'ccv', 'securitycode', 'securitynumber', 'securitynum', 'verificationcode', 'verificationvalue', 'verificationval'].map((w) => [w, 'code']),
  ...expiryWords.map((w) => [w, 'expiry']),
  ...['holder', 'holdername', 'name'].map((w) => [w, 'holder']),
]);
// Card fields whatever their context.
const CARD_FIELDS_ALONE = new Map([
  ...['pan', 'primaryaccountnumber', 'primaryaccountnum'].map((w) => [w, 'number']),
  ...['cvv', 'cvv2', 'cvc', 'cvc2', 'cvn', 'csc', 'ccv', 'cardverificationvalue', 'cardsecuritycode'].map((w) => [w, 'code']),
  ...['nameoncard', 'cardholder', 'cardholdername'].map((w) => [w, 'holder']),
]);
// Card containers by their own name (b): always; `card` or a payment method only when it holds a card number, code or
// expiry at any depth (a board's `card` with a title is not one); `payment` only when it holds one itself, as one of its
// own fields. A plural (`cards`) names a list of them.
const CARD_OBJECTS = new Set(['creditcard', 'debitcard', 'paymentcard', 'billingcard', 'buyercard', 'carddetails', 'cardinfo', 'cardinformation', 'carddata', 'storedcard', 'savedcard']);
const WEAK_CARD_OBJECTS = new Set(['card', 'paymentmethod', 'paymentinstrument', 'paymentsource', 'fundingsource']);
// `payment` only when it holds a card number, code or expiry itself (a payment with its card inside a `card` is not one).
const PAYMENT_OBJECTS = new Set(['payment']);
const TYPE_KEYS = new Set(['type', 'object', 'kind', 'method', 'paymenttype', 'paymentmethodtype', 'instrumenttype']);
// Fields of a card object that are plainly not card data: what kind of object it is and how it is labelled.
const NON_PAYMENT = new Set([...TYPE_KEYS, 'cardtype', 'cardtypeid', 'typeid', 'brand', 'cardbrand', 'network', 'scheme', 'funding', 'country', 'currency', 'last4', 'lastfour', 'status']);
// A scalar that is not data at all (no card field is left "unmasked" by it).
const NOT_DATA = /^(?:null|true|false|undefined)?$/i;
// A validation error naming a card field (`propertyName`) and echoing what was sent (`attemptedValue`).
const FIELD_NAMING_KEYS = new Set(['propertyname', 'property', 'field', 'fieldname', 'member', 'membername', 'membernames', 'path', 'param', 'parameter', 'pointer', 'loc', 'location']);
const ECHO_KEYS = new Set(['attemptedvalue', 'value', 'rawvalue', 'providedvalue', 'rejectedvalue', 'actualvalue', 'receivedvalue', 'input', 'received']);

const norm = (raw) => decodeKey(raw).toLowerCase().replace(/[^a-z0-9]/g, '');

function decodeKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 'number', 'code', 'expiry', 'holder' or null.
function cardKeyKind(rawKey, inCard = false) {
  const k = norm(rawKey);
  if (!k) return null;
  if (CARD_FIELDS_ALONE.has(k)) return CARD_FIELDS_ALONE.get(k);
  if (k === 'cardholder' || k === 'cardholdername') return 'holder';
  for (const p of ['', ...CARD_PREFIXES]) {
    if (!k.startsWith(p)) continue;
    for (const w of CARD_WORDS) if (k.startsWith(w, p.length) && CARD_FIELDS.has(k.slice(p.length + w.length))) return CARD_FIELDS.get(k.slice(p.length + w.length));
  }
  return inCard ? CARD_FIELDS.get(k) ?? null : null;
}
const named = (set, rawKey) => {
  const k = norm(rawKey);
  return set.has(k) || (k.endsWith('s') && set.has(k.slice(0, -1)));
};
const isCardObjectKey = (rawKey) => named(CARD_OBJECTS, rawKey);
const isWeakCardObjectKey = (rawKey) => named(WEAK_CARD_OBJECTS, rawKey);
const isPaymentObjectKey = (rawKey) => named(PAYMENT_OBJECTS, rawKey);
// What makes a `card` or payment-method object a container: a card number, code or expiry by key (read as inside a card)
// and shape, or any valid card number, at any depth; or an object under a card number, code or expiry key that holds data.
const HOLDING = new Set(['number', 'code', 'expiry']);
const holdsCardValue = (key, value) => {
  const kind = cardKeyKind(key, true);
  return (HOLDING.has(kind) && matchesCardValueShape(kind, value)) || (/^[\d .-]{13,30}$/.test(String(value ?? '')) && isPaymentCardNumber(value));
};
// A field name given as a value (`"propertyName": "Card.SecurityNumber"`, `"field": "$.card.cvc"`): its last two parts.
const namesCardField = (value) => {
  const parts = String(value ?? '').split(/[.[\]/]+/).filter(Boolean);
  return Boolean(cardKeyKind(parts.slice(-2).join('.')) || cardKeyKind(parts.at(-1) ?? ''));
};

// Beside a card number (in the object, element or key/value text that holds one), a key that loosely reads as a
// security code, an expiry or a holder is a card field too, whatever its value: compared case-insensitively without
// separators, a code key contains cvv, cvc, cvn, csc, ccv, cid, securitycode, cardcode or verification; an expiry key has
// a word `exp` or one starting with `expir`, `expdate`, `expmonth`, `expyear` (`expMonth`, `exp_date`, `expirationDate`,
// `expires`), or is valid-thru or valid-to; a holder key contains holder, nameoncard or cardname. 'code', 'expiry',
// 'holder' or null.
function looseKind(rawKey) {
  const words = decodeKey(rawKey).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const k = words.join('');
  if (!k) return null;
  if (/cvv|cvc|cvn|csc|ccv|cid|securitycode|cardcode|verification/.test(k)) return 'code';
  if (words.some((w) => w === 'exp' || /^exp(?:ir|date|month|year|mm|yy)/.test(w)) || /validthru|validto/.test(k)) return 'expiry';
  if (/holder|nameoncard|cardname/.test(k)) return 'holder';
  return null;
}
const isPanValue = (v) => /^[\d .-]{13,30}$/.test(String(v ?? '').trim()) && isPaymentCardNumber(v);

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
  if (kind === 'number') return /^\d(?:[ .-]?\d){11,18}$/.test(s);
  if (kind === 'code') return /^\d{3,4}$/.test(s);
  if (kind === 'expiry') return /^(?:\d{1,2}\s*[/.-]\s*\d{2,4}|\d{4}\s*[/.-]\s*\d{1,2}(?:\s*[/.-]\s*\d{1,2})?(?:T[^\s]*)?|\d{1,2}|\d{4})$/.test(s);
  return kind === 'holder';
}

// Issuer ranges: [first, last] prefixes of the same length, and the card lengths the issuer uses.
const L = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ISSUERS = [
  ['4', '4', [13, 16, 19]], // Visa (Electron, Elo and Dankort co-badges included)
  ['51', '55', [16]], ['2221', '2720', [16]], // Mastercard
  ['34', '34', [15]], ['37', '37', [15]], // American Express
  ['6011', '6011', L(16, 19)], ['644', '649', L(16, 19)], ['65', '65', L(16, 19)], ['622126', '622925', L(16, 19)], // Discover
  ['3528', '3589', L(16, 19)], // JCB
  ['300', '305', L(14, 19)], ['36', '36', L(14, 19)], ['38', '39', L(14, 19)], // Diners Club
  ['62', '62', L(16, 19)], ['81', '81', L(16, 19)], // UnionPay
  ['2200', '2204', L(16, 19)], // Mir
  ['60', '60', [16]], ['508', '508', [16]], ['652', '653', [16]], // RuPay
  ['5018', '5018', L(13, 19)], ['5020', '5020', L(13, 19)], ['5038', '5038', L(13, 19)], ['5893', '5893', L(13, 19)], ['56', '58', L(13, 19)], ['6304', '6304', L(13, 19)], ['6759', '6759', L(13, 19)], ['6761', '6763', L(13, 19)], // Maestro
  ['5019', '5019', [16]], // Dankort
  ['506099', '506198', [16, 18, 19]], ['650002', '650027', [16, 18, 19]], // Verve
  ['636', '636', L(16, 19)], ['637', '639', [16]], // InterPayment, InstaPayment
  ['9792', '9792', [16]], // Troy
  ['1', '1', [15]], // UATP
  ['31', '31', [19]], // China T-Union
  ['606282', '606282', [16]], ['3841', '3841', [16, 19]], // Hipercard
  ['6706', '6706', L(16, 19)], ['6709', '6709', L(16, 19)], ['6771', '6771', L(16, 19)], // Laser
];
function isPaymentCardIin(digits) {
  const n = digits.length;
  if (n < 13 || n > 19) return false;
  return ISSUERS.some(([from, to, lengths]) => {
    const p = Number(digits.slice(0, from.length));
    return lengths.includes(n) && p >= Number(from) && p <= Number(to);
  });
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

// ---- JSON-like bodies ---------------------------------------------------------------------------------------------
// A body that starts with `{` or `[` is read as JSON, or almost JSON (single quotes, bare keys, trailing commas, cut
// short by the recording's size limit), to know which object each value is in. Values are replaced in the raw text.
const BARE_END = /[\s,:{}[\]"']/;
const MAX_DEPTH = 256;
// The note the e2e recorder puts after a body it cut at its size limit (templates/e2e/fixtures.ts).
const RECORDER_CUT = /\n… \(\d+ more characters\)\s*$/;
// `audit`: { found: masked values (for their echoes), residual: why the text cannot be shown (card values left as they are,
// a JSON document inside a string that could not be masked in place), cardKeys: card fields whose value was left }.
function maskStructured(text, audit, depth = 0) {
  const edits = [];
  const root = { type: 'root', ctx: false, entries: [], key: null };
  const stack = [root];
  const edit = (start, end, replacement, value) => {
    edits.push([start, end, replacement]);
    if (value != null) audit.found.push(String(value));
  };
  const scalarMask = (e, mark) => edit(e.start, e.end, e.quote ? `${e.quote}${mark}${e.closed ? e.quote : ''}` : `"${mark}"`, mark === MASK ? null : e.value);
  // Whether a frame holds a card value at any depth (worked out once per frame).
  const holds = (frame) => {
    if (frame.holds === undefined) {
      frame.holds = frame.entries.some((e) => (e.container
        ? holds(e.frame) || (HOLDING.has(cardKeyKind(e.key, true)) && e.frame.entries.some((x) => x.container || (isMaskEligible(x.value) && !NOT_DATA.test(String(x.value).trim()))))
        : holdsCardValue(e.key, e.value)));
    }
    return frame.holds;
  };
  const finish = (frame, inherited, parentKindOf) => {
    // A card container (b): named for a card, or named `card`/payment method and holding a card value; beneath it
    // everything. An object that merely holds card fields is not one (only those fields are masked, by key).
    const container = inherited || (frame.type !== 'root' && (isCardObjectKey(frame.key) || (isWeakCardObjectKey(frame.key) && holds(frame)) || (isPaymentObjectKey(frame.key) && frame.entries.some((e) => (e.container ? HOLDING.has(cardKeyKind(e.key, true)) && e.frame.entries.some((x) => x.container || (isMaskEligible(x.value) && !NOT_DATA.test(String(x.value).trim()))) : holdsCardValue(e.key, e.value))))));
    // Everything under a card field's key is that field (`cardExpiry: { month, year }`, a list of messages).
    const kindOf = frame.type === 'root' ? null : cardKeyKind(frame.key, inherited) ?? parentKindOf;
    const echoes = frame.type === 'obj' && frame.entries.some((e) => !e.container && FIELD_NAMING_KEYS.has(norm(e.key)) && namesCardField(e.value));
    // An object holding a card number (by its key, or a valid card number): its code, expiry and holder siblings by the
    // loose reading are card fields too (MP-1).
    const beside = frame.type === 'obj' && frame.entries.some((e) => !e.container && isMaskEligible(e.value) && (cardKeyKind(e.key, container) === 'number' || isPanValue(e.value)));
    const looseOf = (e) => (beside ? looseKind(e.key) : null);
    for (const e of frame.entries) {
      if (frame.type === 'obj' && e.key != null && SECRET_NAME.test(e.key)) {
        if (e.container) edit(e.start, e.end ?? text.length, `"${MASK}"`, null);
        else if (isMaskEligible(e.value) || e.value === '***') scalarMask(e, MASK);
        continue;
      }
      if (e.container) {
        finish(e.frame, container, kindOf ?? looseOf(e));
        continue;
      }
      const data = isMaskEligible(e.value) && !NOT_DATA.test(String(e.value).trim());
      // (a) a card field by key, whatever its value (a validation message under a card key included), and all under it.
      const kind = (frame.type === 'obj' ? cardKeyKind(e.key, container) : null) ?? kindOf ?? looseOf(e);
      if (kind && data) {
        scalarMask(e, CARD_FIELD_MARK);
        continue;
      }
      if (echoes && ECHO_KEYS.has(norm(e.key)) && data) {
        scalarMask(e, CARD_FIELD_MARK);
        continue;
      }
      if (!e.quote && /^\d{13,19}$/.test(e.value) && isPaymentCardNumber(e.value)) {
        edit(e.start, e.end, `"${CARD_PAN_MARK}"`, e.value);
        continue;
      }
      // (b) beneath a card container: everything but the plainly non-card fields.
      if (container && frame.type !== 'root' && !NON_PAYMENT.has(norm(e.key)) && data) {
        scalarMask(e, CARD_FIELD_MARK);
        continue;
      }
      // A JSON document inside a string value: cleaned the same way and written back only when something changed, and
      // only when the original used JSON's own escapes (then nothing but the masks differs); otherwise it is withheld.
      if (e.quote === '"' && e.closed && depth < 3 && /^\s*[[{]/.test(e.value)) {
        try {
          const literal = text.slice(e.start, e.end);
          const inner = JSON.parse(literal);
          const cleaned = maskStructured(inner, audit, depth + 1);
          if (cleaned !== inner) {
            if (JSON.stringify(inner) === literal) edit(e.start, e.end, JSON.stringify(cleaned), null);
            else audit.residual.push('a JSON document inside a string, with escapes the masks cannot keep');
          }
        } catch {
          // not a string literal JSON can read: left as it is (the final check reads it)
        }
      }
    }
  };
  const add = (frame, e) => {
    e.key = frame.type === 'obj' ? frame.pending : frame.type === 'arr' ? frame.key : null;
    frame.entries.push(e);
    frame.pending = null;
  };
  let i = 0;
  // The recorder's note after a body it cut is not part of the body: read up to it, and left as it is.
  const n = RECORDER_CUT.exec(text)?.index ?? text.length;
  const nextNonSpace = (j) => {
    while (j < n && /\s/.test(text[j])) j++;
    return j;
  };
  while (i < n) {
    const c = text[i];
    const top = stack.at(-1);
    if (/\s/.test(c) || c === ',' || c === ':') {
      if (c === ',' && top.type === 'obj') top.pending = null;
      i++;
    } else if (c === '{' || c === '[') {
      const entry = { container: true, start: i, end: null };
      add(top, entry);
      const frame = { type: c === '{' ? 'obj' : 'arr', key: entry.key, parent: top, entries: [], pending: null, entry };
      entry.frame = frame;
      stack.push(frame);
      // Too deep to be a document a test exchanged: not read further (the part is withheld).
      if (stack.length > MAX_DEPTH) {
        audit.residual.push(`a document nested deeper than ${MAX_DEPTH} levels`);
        return text;
      }
      i++;
    } else if (c === '}' || c === ']') {
      // A closer with nothing open, or of the other kind, is not a document read with confidence.
      if (stack.length > 1 && (c === '}') === (top.type === 'obj')) stack.pop().entry.end = i + 1;
      else audit.uncertain = true;
      i++;
    } else {
      let j = i;
      let quote = null;
      let closed = true;
      let value;
      if (c === '"' || c === "'") {
        quote = c;
        j = i + 1;
        closed = false;
        while (j < n && text[j] !== '\n') {
          if (text[j] === '\\') j += 2;
          else if (text[j] === quote) {
            closed = true;
            break;
          } else j++;
        }
        j = Math.min(j, n);
        value = text.slice(i + 1, j);
        if (closed) j++;
      } else {
        while (j < n && !BARE_END.test(text[j])) j++;
        if (j === i) j++;
        value = text.slice(i, j);
      }
      const after = nextNonSpace(j);
      if (top.type === 'obj' && top.pending == null && text[after] === ':') {
        top.pending = quote === '"' && closed ? (() => {
          try {
            return JSON.parse(text.slice(i, j));
          } catch {
            return value;
          }
        })() : value;
        i = after + 1;
      } else {
        add(top, { start: i, end: j, quote, closed, value: quote === '"' && closed ? (() => {
          try {
            return JSON.parse(text.slice(i, j));
          } catch {
            return value;
          }
        })() : value });
        i = j;
      }
    }
  }
  // Never closed: read as far as it goes, and not with confidence, unless the recorder cut it (its note says so).
  if (stack.length > 1 && n === text.length) audit.uncertain = true;
  while (stack.length > 1) stack.pop().entry.end = n;
  // Then from the top down, so a card container (b) and a card key (a) reach every value beneath them.
  finish(root, false, null);
  if (!edits.length) return text;
  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (const [start, end, replacement] of edits) {
    if (start < at) continue; // inside an edit already made (a masked object)
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}

// ---- any text -------------------------------------------------------------------------------------------------------
// `key=value`, `key: value`, `"key": "value"` (JSON-like text that did not parse, logs, query strings, YAML), and keys of
// several words (`card security code: 123`, `Name on card: …`: the longest run of words before the `:` or `=` that is a
// card field), with card-qualified keys only (there is no object to give a bare field word its context). The value of a
// card key is masked whatever its shape (a): a quoted value to its quote (cut short by a recording's size limit, to the
// line's end), a number with its digit groups, a holder's name to the end of its field, anything else one token. Every
// part has a length bound: linear.
const KV_TEXT_RE = /(?<![A-Za-z0-9_.\][%-])([A-Za-z][A-Za-z0-9_.\][%-]{0,63})(\\?["']?)\s{0,8}[=:]\s{0,8}/g;
const SPACED_KEY_RE = /(?<![A-Za-z0-9_])((?:[A-Za-z]{1,32}[ \t]{1,4}){1,5}[A-Za-z]{1,32})[ \t]{0,8}[=:][ \t]{0,8}/g;
// 13 to 19 digits, plain or in groups split by spaces, dashes or dots (one kind of separator).
const LUHN_CANDIDATE_RE = /(?<![0-9A-Za-z+])(\d(?:[ .-]?\d){12,18})(?![0-9A-Za-z])/g;
// The value of a key/value pair starting at `at`: [start, value, quoted].
function kvValue(text, at, kind) {
  const q = text[at] === '\\' && text[at + 1] === '"' ? '\\"' : text[at] === '"' || text[at] === "'" ? text[at] : null;
  if (q) {
    const from = at + q.length;
    const line = /^[^\n]{0,256}/.exec(text.slice(from))[0];
    const end = line.indexOf(q);
    return [from, end < 0 ? line : line.slice(0, end), true];
  }
  const rest = text.slice(at, at + 400);
  // A holder's name runs to the end of its field: `cardholder: Alice Example qty=2` keeps `qty=2`.
  if (kind === 'holder') return [at, /^[^\n&;,<"]{0,256}/.exec(rest)[0].replace(/\s+[A-Za-z][\w.[\]-]{0,63}\s{0,8}[=:][\s\S]*$/, '').replace(/\s+$/, ''), false];
  // A number with its digit groups, or the whole token when that is longer (`07%2F31` in a form).
  if (/^\d/.test(rest)) {
    const groups = /^\d(?:[ ./-]?\d){0,30}/.exec(rest)[0];
    const token = /^[^\s&;,)\]}"'<:=\n]{0,256}/.exec(rest)[0];
    return [at, token.length > groups.length ? token : groups, false];
  }
  return [at, /^[^\s&;,)\]}"'<:=\n]{0,256}/.exec(rest)[0], false];
}

// Evidence-only text cleaner (linear time): the general redaction boundary, then card fields by key and payment card
// numbers (Luhn-valid with a known issuer). `values` are the card values it masked (for their echoes).
export function cleanEvidenceText(raw, { env = process.env, audit = null } = {}) {
  const base = redactText(String(raw ?? ''), { env });
  const hits = [...base.hits];
  const values = [];
  const residual = [];
  const cardKeys = [];
  let out = base.text;

  // The value is read ahead, not consumed, so a key inside the value of a key before it is still seen.
  const edits = [];
  let numberSeen = false;
  const take = (key, kind, at, into = edits) => {
    const [start, val] = kvValue(out, at, kind);
    if (!isMaskEligible(val) || NOT_DATA.test(val.trim())) return;
    // An object or list in text that is not JSON: what is inside is read by these rules on its own.
    if (/^[[{]/.test(val)) return;
    if (kind === 'number') numberSeen = true;
    into.push([start, start + val.length, CARD_FIELD_MARK]);
    hits.push('payment-card-field');
    values.push(val);
  };
  KV_TEXT_RE.lastIndex = 0;
  for (const m of out.matchAll(KV_TEXT_RE)) {
    const kind = cardKeyKind(m[1]);
    if (kind) take(m[1], kind, m.index + m[0].length);
  }
  SPACED_KEY_RE.lastIndex = 0;
  for (const m of out.matchAll(SPACED_KEY_RE)) {
    const words = m[1].split(/[ \t]+/);
    for (let i = 0; i < words.length - 1; i++) {
      const kind = cardKeyKind(words.slice(i).join(' '));
      if (!kind) continue;
      take(m[1], kind, m.index + m[0].length);
      break;
    }
  }
  out = splice(out, edits.sort((x, y) => x[0] - y[0] || y[1] - x[1]));
  out = maskXml(out, { values, hits, residual, audit });

  LUHN_CANDIDATE_RE.lastIndex = 0;
  out = out.replace(LUHN_CANDIDATE_RE, (match, num, offset, full) => {
    const seps = new Set(num.replace(/\d/g, ''));
    if (seps.size > 1) return match;
    // Dots split numbers that are not cards too (versions, addresses, decimals): only groups of 3 to 6 digits count.
    if (seps.has('.') && !num.split('.').every((g) => g.length >= 3 && g.length <= 6)) return match;
    const before = full.slice(Math.max(0, offset - 2), offset);
    const after = full.slice(offset + match.length, offset + match.length + 2);
    if (/[0-9A-Fa-f]-$|[0-9]\.$/.test(before) || /^-[0-9A-Fa-f]|^\.[0-9]/.test(after)) return match;
    if (!isPaymentCardNumber(num)) return match;
    numberSeen = true;
    hits.push('payment-card');
    values.push(num);
    return CARD_PAN_MARK;
  });
  // Key/value text or a form that holds a card number (not JSON, whose objects are read one by one): its code, expiry
  // and holder keys by the loose reading are masked too (MP-1).
  if (numberSeen && !/^\s*[[{]/.test(out)) {
    const more = [];
    for (const re of [KV_TEXT_RE, SPACED_KEY_RE]) {
      re.lastIndex = 0;
      for (const m of out.matchAll(re)) {
        const lk = looseKind(m[1]);
        if (lk) take(m[1], lk, m.index + m[0].length, more);
      }
    }
    out = splice(out, more.sort((x, y) => x[0] - y[0] || y[1] - x[1]));
  }

  return { text: out, hits, values, residual, cardKeys };
}

// Non-overlapping [start, end, replacement] edits (sorted by start) applied to `text`.
function splice(text, edits) {
  if (!edits.length) return text;
  let at = 0;
  let out = '';
  for (const [start, end, replacement] of edits) {
    if (start < at) continue;
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}

// XML, by the same rule: element and attribute names are keys (a), card containers by their names (b). A tokenizer reads
// each tag in one pass, a quoted attribute value whole (a `>` inside it does not end the tag) and with no length cap. Text
// is masked run by run (the text between two tags), so inline tags and padding stay; an element the recording cut short
// is masked to the end. In an exchange that looks like a payment, tags that do not pair up around card data, a tag never
// closed, or a document nested deeper than MAX_DEPTH is not read with confidence (`audit.uncertain`, withheld).
const XML_NAME_RE = /^<(\/?)(?:[A-Za-z][\w-]{0,31}:)?([A-Za-z][\w.-]{0,63})/;
const XML_ATTR_RE = /(?:[A-Za-z][\w-]{0,31}:)?([A-Za-z_][\w.-]{0,63})\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function xmlTags(text) {
  const tags = [];
  let unterminated = false;
  for (let i = text.indexOf('<'); i >= 0; ) {
    const m = XML_NAME_RE.exec(text.slice(i, i + 100));
    if (!m) {
      i = text.indexOf('<', i + 1);
      continue;
    }
    const from = i + m[0].length;
    let j = from;
    let quote = null;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>' || ch === '<') break;
    }
    if (j >= text.length || text[j] === '<') {
      unterminated = true;
      if (j >= text.length) break;
      i = j;
      continue;
    }
    const inner = text.slice(from, j);
    const attrs = [];
    XML_ATTR_RE.lastIndex = 0;
    for (const x of inner.matchAll(XML_ATTR_RE)) {
      const value = x[2] ?? x[3];
      attrs.push({ name: x[1], value, start: from + x.index + x[0].length - value.length - 1 });
    }
    tags.push({ index: i, end: j + 1, closing: m[1] === '/', local: m[2], attrs, selfClosing: /\/\s*$/.test(inner) });
    i = text.indexOf('<', j + 1);
  }
  return { tags, unterminated };
}
function maskXml(text, { values, hits, residual, audit = null }) {
  if (!text.includes('<')) return text;
  const { tags, unterminated } = xmlTags(text);
  if (!tags.length) return text;
  // The `card` and payment-method elements that hold a card value at any depth (a card-value attribute, an element whose
  // name and text make a card number, code or expiry, or one under such a name holding data): those are containers (b),
  // found first in one pass.
  const holding = new Set();
  const holdingOwn = new Set();
  // Elements holding a card number themselves (an attribute, or a child element's text, that is one by its key or a
  // valid card number): their code, expiry and holder attributes and children by the loose reading are card fields (MP-1).
  const numberOwners = new Set();
  const numberish = (name, value) => isMaskEligible(value) && !NOT_DATA.test(String(value).trim()) && (cardKeyKind(name) === 'number' || isPanValue(value));
  {
    const st = [];
    let at = 0;
    for (const t of tags) {
      const top = st.at(-1);
      const between = text.slice(at, t.index).trim();
      at = t.end;
      if (top && between) Object.assign(top, { data: true, direct: between });
      if (t.closing) {
        if (!top || top.local !== t.local) continue;
        st.pop();
        const leaf = !top.children && top.data && holdsCardValue(top.local, top.direct);
        if (leaf || (top.children && top.data && HOLDING.has(cardKeyKind(top.local, true)))) top.holds = true;
        if (top.holds) holding.add(top.index);
        if (top.own) holdingOwn.add(top.index);
        const parent = st.at(-1);
        // A compound card field (`<expiry>` holding `<month>` and `<year>`) counts for its parent as a leaf does.
        const compound = top.children && top.data && HOLDING.has(cardKeyKind(top.local, true));
        if (parent) Object.assign(parent, { children: true, data: parent.data || top.data, holds: parent.holds || top.holds, own: parent.own || leaf || compound });
        if (parent && !top.children && numberish(top.local, top.direct)) numberOwners.add(parent.index);
        continue;
      }
      const attr = t.attrs.some((x) => holdsCardValue(x.name, x.value));
      if (t.attrs.some((x) => numberish(x.name, x.value))) numberOwners.add(t.index);
      if (t.selfClosing) {
        // A self-closing element is a container by its own attributes too (MP-2), and still tells its parent.
        if (attr) {
          holding.add(t.index);
          holdingOwn.add(t.index);
        }
        if (top) Object.assign(top, { children: true, holds: top.holds || attr });
      } else if (st.length < MAX_DEPTH) st.push({ index: t.index, local: t.local, holds: attr, own: attr, data: false, children: false, direct: '' });
    }
    // Elements never closed (a body cut short): closed at the end, so what they hold still makes them containers.
    const tail = text.slice(at, RECORDER_CUT.exec(text)?.index ?? text.length).trim();
    if (st.length && tail) Object.assign(st.at(-1), { data: true, direct: tail });
    while (st.length) {
      const top = st.pop();
      const leaf = !top.children && top.data && holdsCardValue(top.local, top.direct);
      const compound = top.children && top.data && HOLDING.has(cardKeyKind(top.local, true));
      if (leaf || compound) top.holds = true;
      if (top.holds) holding.add(top.index);
      if (top.own) holdingOwn.add(top.index);
      const parent = st.at(-1);
      if (parent) Object.assign(parent, { children: true, data: parent.data || top.data, holds: parent.holds || top.holds, own: parent.own || leaf || compound });
      if (parent && !top.children && numberish(top.local, top.direct)) numberOwners.add(parent.index);
    }
  }
  const stack = [];
  const open = new Map();
  const edits = [];
  let unpaired = unterminated;
  let sawCard = false;
  const take = (from, core) => {
    sawCard = true;
    edits.push([from, from + core.length, CARD_FIELD_MARK]);
    hits.push('payment-card-field');
    values.push(core);
  };
  // A text run inside the innermost open element: masked when that element is a card field, or inside a container and
  // not plainly something else, or when the run is a card number.
  const run = (from, end) => {
    const el = stack.at(-1);
    const val = text.slice(from, end);
    const core = val.trim();
    if (!el || !core || NOT_DATA.test(core)) return;
    const lead = val.length - val.trimStart().length;
    if (el.kind || (el.container && !NON_PAYMENT.has(norm(el.local))) || (/^[\d .-]{13,30}$/.test(core) && isPaymentCardNumber(core))) take(from + lead, core);
  };
  const attrs = (t, container) => {
    const beside = numberOwners.has(t.index);
    for (const x of t.attrs) {
      if (!x.value || !isMaskEligible(x.value) || NOT_DATA.test(x.value.trim())) continue;
      if (cardKeyKind(x.name, container) || (beside && looseKind(x.name)) || (container && !NON_PAYMENT.has(norm(x.name))) || (/^[\d .-]{13,30}$/.test(x.value) && isPaymentCardNumber(x.value))) take(x.start, x.value);
    }
  };
  const pop = (depth) => {
    while (stack.length > depth) open.get(stack.pop().local).pop();
  };
  let at = 0;
  for (const t of tags) {
    run(at, t.index);
    at = t.end;
    const parent = stack.at(-1);
    if (t.closing) {
      const i = open.get(t.local)?.at(-1);
      if (i === undefined || i !== stack.length - 1) unpaired = true;
      if (i !== undefined) pop(i);
      continue;
    }
    const container = Boolean(parent?.container) || isCardObjectKey(t.local) || (isWeakCardObjectKey(t.local) && holding.has(t.index)) || (isPaymentObjectKey(t.local) && holdingOwn.has(t.index));
    const kind = cardKeyKind(t.local, Boolean(parent?.container)) ?? parent?.kind ?? (parent && numberOwners.has(parent.index) ? looseKind(t.local) : null);
    if (kind || container) sawCard = true;
    attrs(t, container);
    if (t.selfClosing) continue;
    if (stack.length >= MAX_DEPTH) {
      residual.push(`XML nested deeper than ${MAX_DEPTH} elements`);
      return text;
    }
    stack.push({ index: t.index, local: t.local, container, kind });
    if (!open.has(t.local)) open.set(t.local, []);
    open.get(t.local).push(stack.length - 1);
  }
  // Cut short: the text after the last tag belongs to the innermost element still open (masked to the end).
  run(at, RECORDER_CUT.exec(text)?.index ?? text.length);
  if (stack.length && !RECORDER_CUT.test(text)) unpaired = true;
  // Tags that do not pair up around card data: not read with confidence (an HTML page without card data is fine).
  if (unpaired && audit && sawCard) audit.uncertain = true;
  return splice(text, edits.sort((x, y) => x[0] - y[0]));
}

// The final check, the guarantee: a copy of each part is normalised for checking only (`+` read as a space, runs of
// percent escapes decoded as UTF-8, JSON `\u` escapes resolved, then Unicode compatibility forms (NFKC); every Unicode
// dash and hyphen read as `-`, comma as `,`, dot as `.`, and space-like or zero-width character as a space; separators of
// one or two of those characters between digits dropped, exponent-form numbers written out), and so is what every run of 16 or more base64 characters
// decodes to; a 13 to 19 digit stretch of any digit run in it with a known issuer and a valid check digit is a card
// number. Nothing is changed by it: a part where it finds one is withheld.
const SEPARATED_DIGITS = /\d(?:[ +._/\\,-]{0,2}\d)*/g;
const B64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
// A run of percent escapes is read as UTF-8 (`%E2%80%89` is one thin space), byte by byte when it is not UTF-8.
const percentDecoded = (t) => t.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
});
function checkView(text) {
  let v = percentDecoded(String(text).replace(/\+/g, ' '));
  v = v.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).normalize('NFKC');
  // Every dash and hyphen, comma, dot and space-like character read as its plain form (then dropped between digits).
  v = v.replace(/[\p{Pd}\u2212\u00AD\u2043\uFE63\uFF0D]/gu, '-').replace(/[\u060C\u3001\uFE50\uFF0C]/g, ',').replace(/[\u00B7\u2024\u2027\u2219\u22C5\u3002\uFE52\uFF0E]/g, '.');
  v = v.replace(/[\s\p{Z}\u180E\u200B-\u200D\u2060\uFEFF]/gu, ' ');
  return v.replace(/(\d)(?:\.(\d+))?[eE]\+?(\d{1,2})(?!\d)/g, (_, d, frac = '', e) => `${d}${frac}${'0'.repeat(Math.max(0, Number(e) - frac.length))}`);
}
// In each run of digit groups (split by those separators), any consecutive groups making 13 to 19 digits: a number with
// a digit group before it (`1 4111…`) is still found, a longer number is not cut into pieces.
function hasCardNumber(view) {
  SEPARATED_DIGITS.lastIndex = 0;
  for (const m of view.matchAll(SEPARATED_DIGITS)) {
    if (m[0].length < 13) continue;
    const groups = m[0].split(/[^\d]+/);
    for (let i = 0; i < groups.length; i++) {
      let digits = '';
      for (let j = i; j < groups.length && digits.length + groups[j].length <= 19; j++) {
        digits += groups[j];
        if (digits.length >= 13 && isPaymentCardNumber(digits)) return true;
      }
    }
  }
  return false;
}
export function cardShaped(text) {
  const view = checkView(text);
  if (hasCardNumber(view)) return ['a card number'];
  for (const [run] of String(text).matchAll(B64_RUN)) {
    let decoded;
    try {
      decoded = Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    } catch {
      continue;
    }
    if (hasCardNumber(checkView(decoded))) return ['a card number in an encoded value'];
  }
  return [];
}

// A card value masked in one place is masked where it is echoed (a validation message quoting it, a response repeating
// it), matched in one pass over the text for all the values at once (Aho-Corasick). Whole words only; values of 3
// characters or more; a value of 4 digits or fewer (a security code) only where an echo plausibly sits, quoted or after
// `=`, so an unrelated number that happens to be equal (a status, a quantity) is left alone.
// `anywhere` (an exchange that looks like a payment): every whole-token occurrence is masked, a 3 or 4 digit code as a
// whole number in any position (a field's value, an attribute, text).
function echoMasker(values, { anywhere = false } = {}) {
  const words = new Set();
  for (const v of values) {
    const s = String(v ?? '').trim();
    let decoded = s;
    try {
      decoded = decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      // as given
    }
    for (const w of [s, decoded]) if (w.length >= 3 && isMaskEligible(w)) words.add(w);
  }
  if (!words.size) return (t) => t;
  if (words.size > 2000) return () => null;
  const next = [new Map()];
  const fail = [0];
  const ends = [[]];
  for (const w of words) {
    let st = 0;
    for (const ch of w) {
      let to = next[st].get(ch);
      if (to === undefined) {
        to = next.length;
        next.push(new Map());
        fail.push(0);
        ends.push([]);
        next[st].set(ch, to);
      }
      st = to;
    }
    ends[st].push(w);
  }
  // Failure links, and for each state the nearest state on its failure chain where a word ends (so a step visits only
  // states with matches).
  const link = [0];
  const queue = [...next[0].values()];
  for (const u of queue) link[u] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const r = queue[qi];
    for (const [ch, u] of next[r]) {
      queue.push(u);
      let f = fail[r];
      while (f && !next[f].has(ch)) f = fail[f];
      fail[u] = r === 0 ? 0 : next[f].get(ch) ?? 0;
      link[u] = ends[fail[u]].length ? fail[u] : link[fail[u]];
    }
  }
  const word = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
  const plausible = (t, start, end, w) => {
    if (word(t[start - 1]) || word(t[end])) return false;
    if (!/^\d{1,4}$/.test(w) || anywhere) return true;
    const q = t[start - 1];
    return ((q === '"' || q === "'") && t[end] === q) || q === '=';
  };
  // Values that are suffixes of each other (`1 1`, `1 1 1`, …) can end many times at one place: past a work limit
  // proportional to the text, the answer is null (the caller withholds the part).
  return (t) => {
    const found = [];
    let st = 0;
    let i = 0;
    let work = 0;
    const limit = 8 * t.length + 10000;
    for (const ch of t) {
      while (st && !next[st].has(ch)) st = fail[st];
      st = next[st].get(ch) ?? 0;
      i += ch.length;
      // Every word ending here: this state's own, and those of its failure chain.
      for (let f = ends[st].length ? st : link[st]; f; f = link[f]) {
        for (const w of ends[f]) {
          if (++work > limit) return null;
          if (plausible(t, i - w.length, i, w)) found.push([i - w.length, i, CARD_FIELD_MARK]);
        }
      }
    }
    found.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    return splice(t, found);
  };
}

const headerValues = (obj) => Object.values(obj ?? {}).map((v) => String(v ?? ''));

// The card values the cleaner masks in the requests of a set of exchanges (the URL asked for and the one answered, request
// header values and bodies), for echo masking across all of them (c).
export function cardValuesIn(exchanges, { env = process.env } = {}) {
  const found = [];
  for (const x of exchanges ?? []) {
    for (const t of [...new Set([x?.requestUrl, x?.url ?? x?.path]), ...headerValues(x?.requestHeaders), x?.requestBody]) {
      if (t == null || t === '') continue;
      const audit = { found, residual: [], cardKeys: [], uncertain: false };
      const text = String(t);
      const structured = /^\s*[[{]/.test(text) ? maskStructured(text, audit) : text;
      for (const v of cleanEvidenceText(structured, { env }).values) found.push(v);
    }
  }
  return found;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// One exchange as it may be shown: the path and query only (no scheme or host), allow-listed headers, credentials masked
// by name, payment card data masked (by key in JSON-like, form-encoded, key/value text and XML bodies, card numbers
// anywhere, and their echoes), every value through the detector, bodies truncated with byte count. Masks are spliced into
// the recorded text and nothing else changes; a body the recorder could not keep as sent (an object or form the test gave,
// re-serialised) says so. Fail closed (the final check, cardShaped, is the guarantee): when any part (the path, a header
// value, a body) still holds a card number in any form it reads, a card key whose value is still data, echoes too many to
// mask within the work limit, or, in an exchange that looks like a payment, a body that could not be read with confidence,
// the exchange's headers and bodies are all withheld: only its method, path (unless the path itself is withheld) and
// status are shown, and `withheld` says which part and why. `echo`: the card values of the requests of the whole evidence
// (cardValuesIn), so one exchange's response quoting another's request is masked too.
const PAYMENT_HINT = /card|cvv|cvc|cvn|\bcsc\b|\bccv\b|\bpan\b|expir|cardholder|primary[\s_-]*account/i;
// The keys of a text (key/value and JSON-like keys, keys of several words, XML element names) with the value read after
// each: [key, value] (an XML element's value is its text when it has no child element).
const XML_ELEMENT_TEXT_RE = /<(?:[A-Za-z][\w-]{0,31}:)?([A-Za-z][\w.-]{0,63})(?:\s[^<>]*)?>([^<]*)<\//g;
function* keyValues(text) {
  for (const re of [KV_TEXT_RE, SPACED_KEY_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) yield [m[1], kvValue(text, m.index + m[0].length, 'number')[1], re === SPACED_KEY_RE];
  }
  XML_ELEMENT_TEXT_RE.lastIndex = 0;
  for (const m of text.matchAll(XML_ELEMENT_TEXT_RE)) yield [m[1], m[2].trim(), false];
}
const isData = (v) => isMaskEligible(v) && !NOT_DATA.test(String(v).trim()) && !/^[[{]/.test(String(v).trim());
// Whether a part holds a card number: a valid one anywhere (in any form the final check reads), or a value under a card
// number key.
function cardNumberIn(text) {
  if (cardShaped(text).length) return true;
  for (const [key, value, spaced] of keyValues(text)) {
    const words = spaced ? key.split(/[ \t]+/) : [key];
    if (isData(value) && words.some((_, i) => cardKeyKind(words.slice(i).join(' ')) === 'number')) return true;
  }
  return false;
}
// In an exchange that holds a card number, a security code or expiry key by the loose reading whose value is still data
// (MP-1): its name, or null.
function looseKeyLeft(text) {
  for (const [key, value] of keyValues(text)) if (['code', 'expiry'].includes(looseKind(key)) && isData(value)) return key;
  return null;
}
// A card key whose value is still data after cleaning (a safety net: every rule above masks those).
function cardKeyLeft(text) {
  for (const re of [KV_TEXT_RE, SPACED_KEY_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const words = re === SPACED_KEY_RE ? m[1].split(/[ \t]+/) : [m[1]];
      for (let i = 0; i < Math.max(1, words.length - 1); i++) {
        const kind = cardKeyKind(words.slice(i).join(' '));
        if (!kind) continue;
        const val = kvValue(text, m.index + m[0].length, kind)[1];
        if (isMaskEligible(val) && !NOT_DATA.test(val.trim()) && !/^[[{]/.test(val)) return m[1];
        break;
      }
    }
  }
  return null;
}
// A payment exchange: on the normalised copy of its request and response, (a) a card-number-shaped value anywhere (the
// URL, a header value, a body), or (b) a key, element, attribute, form or query name that names a card field without
// doubt: the card key table (`pan`, `cardNumber`, `ccNumber`, `primaryAccountNumber`, `cardExpiry`, `cardHolderName`,
// `nameOnCard`, `card[cvc]`, …) or a security code name (`cvv`, `cvc`, `cvn`, `csc`, `ccv`, `cardCode`,
// `securityCode`, `cardVerification…`). An expiry or holder name counts beside one of those, which already makes it one.
// Not by themselves: header names (`Expires`, `Set-Cookie`), cookie attributes, `expires_in`, `expiresAt`, token claims
// (`exp`, `iat`), the words card or pan in a value or in prose, a key named `card` or `cards` holding neither, `pan`
// inside another word. Names are read, not structure: an expiry or holder only, or a number split over neutral names,
// is not found (a documented limit).
const XML_TAG_NAME_RE = /<\/?(?:[A-Za-z][\w-]{0,31}:)?([A-Za-z][\w.-]{0,63})/g;
function cardName(rawKey) {
  if (cardKeyKind(rawKey)) return true;
  const words = decodeKey(rawKey).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const k = words.join('');
  return words.some((w) => /^(?:cvv2?|cvc2?|cvn|csc|ccv)$/.test(w)) || /cvv|cvc|securitycode|cardcode|cardverification|cardsecurity/.test(k);
}
function namesCard(text) {
  for (const re of [KV_TEXT_RE, SPACED_KEY_RE, XML_TAG_NAME_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const words = re === SPACED_KEY_RE ? m[1].split(/[ \t]+/) : [m[1]];
      for (let i = 0; i < words.length; i++) if (cardName(words.slice(i).join(' '))) return true;
    }
  }
  return false;
}
export function isPaymentExchange(x) {
  const parts = [x?.requestUrl, x?.url, x?.path, ...headerValues(x?.requestHeaders), ...headerValues(x?.responseHeaders), x?.requestBody, x?.responseBody];
  for (const t of parts) {
    if (t == null || t === '') continue;
    const text = String(t);
    if (cardShaped(text).length || namesCard(checkView(text))) return true;
  }
  return false;
}
export const PAYMENT_WITHHELD = 'bodies withheld: payment data';
// A payment exchange under `paymentBodies: "withhold"`: its method, its path without the query, its status, and why.
function withheldPayment(x, env) {
  let where = String(x.requestUrl ?? x.url ?? x.path ?? '');
  try {
    where = new URL(where, 'http://host.invalid').pathname;
  } catch {
    where = where.split(/[?#]/)[0];
  }
  const path = cardShaped(where).length ? '(withheld: the path held card data)' : redactText(where, { env }).text;
  return { method: String(x.method ?? 'GET').toUpperCase(), path, requestHeaders: [], requestBody: null, status: Number(x.status) || null, responseHeaders: [], responseBody: null, durationMs: x.durationMs ?? null, repro: x.repro ?? null, notes: [PAYMENT_WITHHELD], paymentWithheld: true };
}

export function cleanExchange(x, s = API_EVIDENCE_DEFAULTS, { env = process.env, echo = null } = {}) {
  // The default: a payment exchange's headers and bodies are not published at all, and no masking runs on them.
  if ((s?.paymentBodies ?? API_EVIDENCE_DEFAULTS.paymentBodies) !== 'mask' && isPaymentExchange(x)) return withheldPayment(x, env);
  const values = echo ?? cardValuesIn([x], { env });
  const withheld = [];
  const raw = [x.requestUrl ?? x.url ?? x.path, x.url, ...headerValues(x.requestHeaders), ...headerValues(x.responseHeaders), x.requestBody, x.responseBody].map((t) => String(t ?? ''));
  const payment = raw.some((t) => PAYMENT_HINT.test(checkView(t)) || cardShaped(t).length);
  const holdsNumber = raw.some((t) => t && cardNumberIn(t));
  // In a payment exchange every card value masked anywhere is masked wherever it is repeated, as a whole token.
  const echoed = echoMasker(values, { anywhere: payment });
  const clean = (t) => {
    const audit = { found: [], residual: [], cardKeys: [], uncertain: false };
    let text = String(t ?? '');
    if (/^\s*[[{]/.test(text)) text = maskStructured(text, audit);
    const c = cleanEvidenceText(text, { env, audit });
    text = echoed(c.text);
    if (text == null) return { text: null, residual: ['too many overlapping card values to mask their echoes'] };
    const reasons = [...audit.residual, ...c.residual, ...cardShaped(text)];
    const left = [...audit.cardKeys, ...c.cardKeys][0] ?? cardKeyLeft(text);
    if (left) reasons.push(`a card field whose value was left (${left})`);
    const loose = holdsNumber ? looseKeyLeft(text) : null;
    if (loose) reasons.push(`a security code or expiry field beside a card number whose value was left (${loose})`);
    // In an exchange that looks like a payment, a body that could not be read with confidence: cut short (the recorder's
    // own cut included), tags or brackets that do not pair up, a JSON-like body JSON does not read cleanly.
    const original = String(t ?? '');
    const unclean = /^\s*[[{]/.test(original) && (() => {
      try {
        JSON.parse(original);
        return false;
      } catch {
        return true;
      }
    })();
    if (payment && (audit.uncertain || RECORDER_CUT.test(original) || unclean)) reasons.push('a body that could not be read with confidence');
    return { text, residual: reasons };
  };
  const shown = (part, t) => {
    const c = clean(t);
    if (!c.residual.length) return c.text;
    withheld.push({ part, reason: [...new Set(c.residual)].join('; ') });
    return null;
  };
  // The path the test asked for (a redirect may have changed the response's URL).
  let where = String(x.requestUrl ?? x.url ?? x.path ?? '');
  try {
    const u = new URL(where, 'http://host.invalid');
    where = `${u.pathname}${u.search}`;
  } catch {
    // keep as given
  }
  const allow = new Set(s.headers.map((h) => h.toLowerCase()));
  const headers = (obj, side) => Object.entries(obj ?? {})
    .filter(([k]) => allow.has(k.toLowerCase()) || SECRET_NAME.test(k))
    .map(([k, v]) => [k, SECRET_NAME.test(k) || v === '***' ? MASK : shown(`${side} header ${k}`, v)]);
  const body = (b, side) => {
    if (b == null || b === '') return null;
    const text = shown(`${side} body`, String(b));
    if (text == null) return null;
    const bytes = Buffer.byteLength(text);
    if (bytes <= s.maxBodyBytes) return text;
    const cut = Buffer.from(text).subarray(0, s.maxBodyBytes).toString('utf8');
    return `${cut}\n… (truncated: ${bytes} bytes in all, ${bytes - Buffer.byteLength(cut)} not shown)`;
  };
  const path = shown('path', where) ?? '(withheld: the path held card data the cleaner could not mask)';
  const out = {
    method: String(x.method ?? 'GET').toUpperCase(),
    path,
    requestHeaders: headers(x.requestHeaders, 'request'),
    requestBody: body(x.requestBody, 'request'),
    status: Number(x.status) || null,
    responseHeaders: headers({ ...(x.responseHeaders ?? {}), ...(x.responseContentType && !x.responseHeaders ? { 'content-type': x.responseContentType } : {}) }, 'response'),
    responseBody: body(x.responseBody, 'response'),
    durationMs: x.durationMs ?? null,
    repro: x.repro ?? null,
  };
  if (withheld.length) {
    // Any part withheld: nothing of the exchange but its method, path and status is shown.
    Object.assign(out, { requestHeaders: [], responseHeaders: [], requestBody: x.requestBody ? WITHHELD_BODY : null, responseBody: x.responseBody ? WITHHELD_BODY : null, withheld });
    return out;
  }
  // The recorder keeps a text body as sent; an object or form the test gave is shown as it gave it (fixtures.ts).
  if (x.requestBodyForm === 'as-given' && out.requestBody) out.notes = ['the request body is shown as the test gave it, re-serialised, not the bytes sent'];
  return out;
}

const WITHHELD_BODY = '(withheld: this exchange could not be cleaned safely of payment card data)';

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
// What the recording could not show exactly, under the block that shows it.
const notesOf = (x, side) => (x.notes ?? []).filter((n) => n.includes(`the ${side} body`) || n === PAYMENT_WITHHELD);
const withNotes = (block, notes) => (notes.length ? `${block}\n\n(${notes.join('; ')})` : block);
export function requestBlock(x) {
  return withNotes(fence([`${x.method} ${x.path}`, ...x.requestHeaders.map(([k, v]) => `${k}: ${v}`), ...(x.requestBody ? ['', x.requestBody] : [])].join('\n')), notesOf(x, 'request'));
}
export function responseBlock(x) {
  return withNotes(fence([`HTTP ${x.status}`, ...x.responseHeaders.map(([k, v]) => `${k}: ${v}`), ...(x.responseBody ? ['', x.responseBody] : [])].join('\n')), notesOf(x, 'response'));
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
