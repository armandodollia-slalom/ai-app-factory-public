// Card data in published request evidence (bodies cut by the recording's size limit, almost-JSON, plain text and XML,
// echoed values, holder and expiry beside a card number or under a payment method, dot-separated numbers, more card
// issuers), and evidence that shows exactly what was sent (no number rounded, no duplicate key dropped, no reformatting).
// Every card-like number is made at run time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { API_EVIDENCE_DEFAULTS, cardValuesIn, cleanEvidenceText, cleanExchange, evidenceSection, isPaymentCardNumber, isPaymentExchange, PAYMENT_WITHHELD, reproductionComment, requestBlock, responseBlock } from '../lib/api-evidence.mjs';
import { redactText } from '../../pipeline/lib/redact.mjs';

// A Luhn-valid number of `len` digits that starts with `prefix`.
const luhn = (prefix, len) => {
  const body = `${prefix}${'4820193756'.repeat(2)}`.slice(0, len - 1);
  let sum = 0;
  for (let i = body.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = Number(body[i]);
    if (dbl) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
};
// The same digits with a wrong check digit: no card number rule can catch it, only its key.
const notLuhn = (n) => `${n.slice(0, -1)}${(Number(n.at(-1)) + 1) % 10}`;
const pan = luhn('4539', 16);
const number = notLuhn(luhn('5412', 16));
const cvv = ['6', '0', '4'].join('');
const holder = ['Rowan', 'Ellery'].join(' ');
const expiry = ['09', '31'].join('/');
const FIELD = '[redacted:payment-card-field]';
// These tests check the masking (`video.apiEvidence.paymentBodies: "mask"`); the default withholds payment exchanges.
const settings = { ...API_EVIDENCE_DEFAULTS, paymentBodies: 'mask', maxBodyBytes: 100_000 };
const leaks = (text, values) => values.filter((v) => text.includes(v));

test('a JSON body cut by the recording\'s size limit in a payment exchange is withheld, never published as read (final fixes B1)', () => {
  const sent = JSON.stringify({ items: 'x'.repeat(3900), paymentMethod: { number, cvc: cvv, holderName: holder, expiry, brand: 'visa' }, cardNumber: number });
  // The e2e fixture's cut: the first 4,000 characters, then a note; the cut falls inside the second card number.
  const cut = sent.length - 6;
  const recorded = `${sent.slice(0, cut)}\n… (${sent.length - cut} more characters)`;
  const c = cleanExchange({ method: 'POST', url: '/api/orders', requestBody: recorded }, settings);
  assert.deepEqual(leaks(shownText(c), [number, cvv, holder, expiry, number.slice(0, 10)]), [], shownText(c));
  assert.ok(withheldAll(c), JSON.stringify(c));
  assert.match(c.withheld[0].reason, /could not be read with confidence/);
});

test('almost-JSON in a payment exchange is withheld (not read cleanly); plain key/value text and XML are masked by key', () => {
  const almost = `{ paymentMethod: { 'number': '${number}', cvc: ${cvv}, holder: '${holder}', exp_date: '${expiry}', }, 'cardTypeId': 2, }`;
  const a = cleanExchange({ method: 'POST', url: '/p', requestBody: almost }, settings);
  assert.deepEqual(leaks(shownText(a), [number, cvv, holder, expiry]), [], shownText(a));
  assert.ok(withheldAll(a), JSON.stringify(a));

  const log = `charge failed: cardNumber: ${number}; card_cvc=${cvv} cardHolderName="${holder}" card_expiry='${expiry}' orderId: 77`;
  const l = cleanEvidenceText(log, { env: {} }).text;
  assert.deepEqual(leaks(l, [number, cvv, holder, expiry]), [], l);
  assert.match(l, /orderId: 77$/);

  const xml = `<Payment><Card><CardNumber>${number}</CardNumber><ns:CardSecurityNumber>${cvv}</ns:CardSecurityNumber><CardHolderName>${holder}</CardHolderName><CardTypeId>2</CardTypeId></Card></Payment>`;
  const x = cleanEvidenceText(xml, { env: {} }).text;
  assert.deepEqual(leaks(x, [number, cvv, holder]), [], x);
  assert.match(x, /<CardTypeId>2<\/CardTypeId>/);
});

test('a value quoted back (attemptedValue beside a card field name, an error message, a later response) is masked', () => {
  // The response alone: the field it names is a card field, so what it says was attempted goes.
  const alone = cleanExchange({ method: 'POST', url: '/o', responseBody: JSON.stringify({ errors: [{ attemptedValue: cvv, propertyName: 'Card.SecurityNumber' }, { propertyName: 'Quantity', attemptedValue: 7 }] }) }, settings).responseBody;
  assert.ok(!alone.includes(cvv), alone);
  assert.ok(alone.includes('"attemptedValue":7'), 'a field that is not a card field keeps its value');

  // A request and the responses that quote it, across the exchanges of one piece of evidence.
  const exchanges = [
    { method: 'POST', url: '/api/orders', requestBody: JSON.stringify({ cardNumber: number, cardSecurityNumber: cvv, cardHolderName: holder, cardExpiration: expiry }), responseBody: `The value '${cvv}' is not valid for CardSecurityNumber; card holder ${holder} expires ${expiry}.` },
    { method: 'GET', url: '/api/orders/5', responseBody: JSON.stringify({ id: 5, note: `charged ${number} for ${holder}` }) },
  ];
  const echo = cardValuesIn(exchanges, { env: {} });
  for (const x of exchanges) {
    const c = cleanExchange(x, settings, { echo });
    const all = `${c.requestBody ?? ''}\n${c.responseBody ?? ''}`;
    assert.deepEqual(leaks(all, [number, cvv, holder, expiry]), [], all);
  }
  assert.match(cleanExchange(exchanges[1], settings, { echo }).responseBody, /^\{"id":5,"note":"charged \[redacted:payment-card-field\] for \[redacted:payment-card-field\]"\}$/);
});

test('holder and expiry beside a card number or under a payment method are masked; elsewhere they are not card data', () => {
  const body = JSON.stringify({
    cardNumber: number,
    holderName: holder,
    expiry,
    payment_methods: [{ type: 'card', owner: 'x', name: holder, exp_month: 9, exp_year: 2031, billing_details: { name: holder } }],
    account: { holderName: 'Avery Stone', expiry: '2027-01-31' },
    coupon: { expiry: '2026-12-01' },
  });
  const shown = cleanExchange({ method: 'POST', url: '/pay', requestBody: body }, settings).requestBody;
  assert.deepEqual(leaks(shown, [number, holder, expiry, '"exp_month":9', '"exp_year":2031']), [], shown);
  // The order holds card fields beside other fields: it is not a card container, so only its card fields are masked,
  // the bare `expiry` beside its card number included (MP-1).
  const beside = cleanExchange({ method: 'POST', url: '/pay', requestBody: JSON.stringify({ card: { number, expiry }, account: { holderName: 'Avery Stone', expiry: '2027-01-31' }, coupon: { expiry: '2026-12-01' } }) }, settings).requestBody;
  assert.ok(beside.includes('"account":{"holderName":"Avery Stone","expiry":"2027-01-31"}'), beside);
  assert.ok(beside.includes('"coupon":{"expiry":"2026-12-01"}'));
});

test('card numbers split by dots are masked; versions, addresses and decimals are not', () => {
  const dotted = pan.match(/.{4}/g).join('.');
  const r = cleanEvidenceText(`paid with ${dotted} from 192.0.2.10 on v1.2.3.4567.8901.2345 total 4539123456789.50`, { env: {} });
  assert.ok(!r.text.includes(dotted), r.text);
  assert.match(r.text, /from 192\.0\.2\.10 on v1\.2\.3\.4567\.8901\.2345 total 4539123456789\.50$/);
});

test('numbers of the issuers the table lacked are recognised and masked', () => {
  const issuers = { mir: ['2201', 16], rupay: ['6070', 16], verve: ['506100', 19], troy: ['9792', 16], uatp: ['1003', 15], dankort: ['5019', 16], maestro: ['5612', 19], interpayment: ['6360', 17], instapayment: ['6380', 16], hipercard: ['606282', 16], tunion: ['3108', 19], unionpay81: ['8171', 17], laser: ['6706', 18] };
  for (const [name, [prefix, len]] of Object.entries(issuers)) {
    const n = luhn(prefix, len);
    assert.equal(isPaymentCardNumber(n), true, name);
    assert.ok(!cleanEvidenceText(`card ${n} declined`, { env: {} }).text.includes(n), name);
    assert.equal(isPaymentCardNumber(notLuhn(n)), false, `${name}: a wrong check digit is no card`);
  }
  // Lengths an issuer never uses stay numbers (a 16-digit UATP-like id, a 13-digit epoch time in milliseconds).
  assert.equal(isPaymentCardNumber(luhn('1003', 16)), false);
  assert.equal(isPaymentCardNumber(luhn('1732', 13)), false);
});

test('request evidence shows exactly what was sent: large integers, number formats, duplicate keys, order and spacing', () => {
  const sent = '{"orderId": 123456789012345678901, "ref":9007199254740993, "amount": 1.50, "rate":1e3, "neg":-0, "tag":"a", "tag":"b",\n  "z": 1, "a": 2}';
  assert.equal(cleanExchange({ method: 'POST', url: '/o', requestBody: sent, responseBody: sent }, settings).requestBody, sent);
  // A 19-digit number that is not a card number is shown to its last digit, under any key.
  const id = notLuhn(luhn('4000', 19));
  const withId = `{"traceId":${id},"card":{"cardNumber":${number}}}`;
  assert.equal(cleanExchange({ method: 'POST', url: '/o', requestBody: withId }, settings).requestBody, `{"traceId":${id},"card":{"cardNumber":"${FIELD}"}}`);
  // A card number written as a JSON number is masked as a whole, never shown rounded.
  assert.equal(cleanExchange({ method: 'POST', url: '/o', requestBody: `{"ref":${pan}}` }, settings).requestBody, '{"ref":"[redacted:payment-card]"}');
});

test('the card rules stay linear on large and adversarial bodies, and the general redaction boundary has none of them', () => {
  const big = `{${'"cardNumber":"1","note":"cvv: 1 <cvc>1</cvc>", "x":[{"y":"'.repeat(20_000)}`;
  const text = `${'card_number="'.repeat(40_000)}\n${'<cvc>'.repeat(40_000)}\n${`${pan.slice(0, 4)}.`.repeat(40_000)}`;
  const t0 = performance.now();
  cleanExchange({ method: 'POST', url: '/o', requestBody: big, responseBody: text }, settings);
  const ms = performance.now() - t0;
  assert.ok(ms < 5_000, `cleaning ${big.length + text.length} characters took ${Math.round(ms)} ms`);
  assert.equal(redactText(`card ${pan} cvv: ${cvv} cardHolderName=${holder}`, { env: {} }).text, `card ${pan} cvv: ${cvv} cardHolderName=${holder}`);
});

// ---- round 2: the adversary's reproductions -------------------------------------------------------------------------

test('card data in any representation is masked, and what the rules cannot prove clean is withheld, never published', () => {
  const exp = `${pan[0]}.${pan.slice(1)}e${pan.length - 1}`;
  // A card number written as an exponent-form JSON number.
  const a = cleanExchange({ method: 'POST', url: '/p', requestBody: `{"cardNumber":${exp},"amount":5}` }, settings);
  assert.equal(a.requestBody, '{"cardNumber":"[redacted:payment-card-field]","amount":5}');
  // A percent-encoded card number in the path: withheld, with a reason.
  const enc = pan.match(/.{4}/g).join('%20');
  const b = cleanExchange({ method: 'GET', url: `/api/charge/${enc}`, status: 200 }, settings);
  assert.ok(!b.path.includes(enc) && !b.path.includes(pan), b.path);
  assert.match(b.withheld[0].part, /^path$/);
  // An expiry nested under XML card elements.
  const c = cleanExchange({ method: 'POST', url: '/p', requestBody: `<payment><card><expiry><month>09</month><year>2031</year></expiry><holder>${holder}</holder></card><amount>5</amount></payment>` }, settings);
  assert.equal(c.requestBody, '<payment><card><expiry><month>[redacted:payment-card-field]</month><year>[redacted:payment-card-field]</year></expiry><holder>[redacted:payment-card-field]</holder></card><amount>5</amount></payment>');
  // A code masked in the request is masked where the response's header and body echo it.
  const d = cleanExchange({ method: 'POST', url: `/cards?cvv=${cvv}`, status: 201, responseHeaders: { location: `/cards?cvv=${cvv}` }, responseBody: `{"message":"code '${cvv}' accepted"}` }, settings);
  assert.ok(!d.path.includes(cvv) && !d.responseBody.includes(cvv) && !JSON.stringify(d.responseHeaders).includes(cvv), JSON.stringify(d));
  // A card number next to letters: a withheld body, not a leak.
  const e = cleanExchange({ method: 'POST', url: '/p', requestBody: `ref=card${pan}x` }, settings);
  assert.match(e.requestBody, /^\(withheld: /);
  assert.equal(e.withheld.length, 1);
  // A card-keyed value of digits with no card shape: masked by its key.
  assert.equal(cleanExchange({ method: 'POST', url: '/p', requestBody: `{"cardNumber":"${pan.slice(0, 8)}"}` }, settings).requestBody, `{"cardNumber":"${FIELD}"}`);
});

test('the evidence changes nothing but the masks: a literal ***, JSON escapes inside a string, the path the test asked for', () => {
  // `"***"` in a field that is not secret-named stays; under a secret-named key it reads as the harness's mask.
  assert.equal(cleanExchange({ method: 'POST', url: '/p', requestBody: '{"glob":"***","token":"***"}' }, settings).requestBody, '{"glob":"***","token":"(masked)"}');
  // A JSON document inside a string, written with escapes JSON would not use: masked, and said to be written back.
  const inner = `{"note":"caf\\u00e9","cvv":"${cvv}"}`;
  const x = cleanExchange({ method: 'POST', url: '/p', requestBody: JSON.stringify({ payload: inner }).replace('caf\\\\u00e9', 'caf\\\\u00e9') }, settings);
  assert.ok(!x.requestBody.includes(cvv));
  // The test's object, printed by the recorder, is labelled; the redirect target is not the path shown.
  const y = cleanExchange({ method: 'POST', url: 'http://h/after-redirect', requestUrl: '/api/orders', requestBody: '{\n  "a": 1\n}', requestBodyForm: 'as-given' }, settings);
  assert.equal(y.path, '/api/orders');
  assert.match(requestBlock(y), /\(the request body is shown as the test gave it, re-serialised, not the bytes sent\)$/);
});

test('card context is narrow and echoes are matched where an echo sits: a bank name, a status equal to a code', () => {
  const a = cleanExchange({ method: 'POST', url: '/p', requestBody: '{"paymentMethod":{"type":"bank_transfer","bank":{"name":"First Federal"},"name":"Main account"}}' }, settings);
  assert.ok(a.requestBody.includes('"First Federal"') && a.requestBody.includes('"Main account"'), a.requestBody);
  const ex = [
    { method: 'POST', url: '/p', requestBody: `{"cardSecurityNumber":"${cvv}"}`, responseBody: `{"status":${cvv},"items":${cvv},"error":"value '${cvv}' rejected"}` },
  ];
  // Round 4: in a payment exchange a security code is masked wherever it is repeated as a whole number (a status or a
  // quantity that happens to be equal included): more masking, never the code published.
  const b = cleanExchange(ex[0], settings, { echo: cardValuesIn(ex) });
  assert.equal(b.responseBody, `{"status":${FIELD},"items":${FIELD},"error":"value '${FIELD}' rejected"}`);
});

test('dense evidence of card fields cleans in finite time at 256 KiB and 1 MiB through the exchange entry point', () => {
  const json = (i) => `{"cardNumber":"${notLuhn(luhn('4539', 16))}","cvv":"${String(100 + (i % 900))}","cardHolderName":"H${i}"},`;
  const form = (i) => `cvv=${String(100 + (i % 900))}\n`;
  for (const [size, field, open, close] of [[256 * 1024, json, '[', ']'], [1024 * 1024, json, '[', ']'], [256 * 1024, form, '', 'x=1'], [1024 * 1024, form, '', 'x=1']]) {
    let body = open;
    for (let i = 0; body.length < size; i++) body += field(i);
    body += close;
    const t0 = performance.now();
    const r = cleanExchange({ method: 'POST', url: '/p', requestBody: body, responseBody: body }, { ...settings, maxBodyBytes: 2_000_000 });
    const ms = performance.now() - t0;
    assert.ok(!/"cvv":"1|cvv=1/.test(r.requestBody), "masked");
    assert.ok(ms < 20_000, `${size} bytes took ${Math.round(ms)} ms`);
  }
});

test('the recorder masks a secret-named scalar in place and leaves a secret-named object whole for the harness', () => {
  const src = fs.readFileSync(new URL('../../../templates/e2e/fixtures.ts', import.meta.url), 'utf8');
  const pair = new RegExp(/const JSON_PAIR = \/(.+)\/g;/.exec(src)[1], 'g');
  const secretKey = new RegExp(/const SECRET_KEY = \/(.+)\/i;/.exec(src)[1], 'i');
  const mask = (text) => text.replace(pair, (p, key, sep) => (secretKey.test(key) ? `${key}${sep}"***"` : p));
  const body = '{"token":{"a":"x","b":1},"password":"p4ss-word","n":12345678901234567890,"ok":true}';
  const masked = mask(body);
  assert.equal(masked, '{"token":{"a":"x","b":1},"password":"***","n":12345678901234567890,"ok":true}');
  assert.doesNotThrow(() => JSON.parse(masked.replace(/1234567890\d+/, '1')), 'the structure is intact');
  // The harness masks the object by its span.
  assert.equal(cleanExchange({ method: 'POST', url: '/p', requestBody: masked }, settings).requestBody, '{"token":"(masked)","password":"(masked)","n":12345678901234567890,"ok":true}');
});

// ---- round 3: the final check is the guarantee ----------------------------------------------------------------------

const withheldAll = (x) => x.withheld?.length && x.requestHeaders.length === 0 && x.responseHeaders.length === 0 && [x.requestBody, x.responseBody].every((b) => b == null || /^\(withheld/.test(b));
const shownText = (x) => [x.path, x.requestBody, x.responseBody, ...x.requestHeaders.map(([, v]) => v), ...x.responseHeaders.map(([, v]) => v)].join('\n');

test('card numbers in the forms the docs say are withheld never reach the record: `+` and Unicode space separators, JSON escapes, base64, a digit before (ADV2-R2-03, Sol 28)', () => {
  const g = (sep) => pan.match(/.{1,4}/g).join(sep);
  const b64 = Buffer.from(pan).toString('base64');
  const escaped = [...pan].map((d) => `\\u00${d.charCodeAt(0).toString(16)}`).join('');
  const cases = [
    ['form body, + separators', { method: 'POST', url: '/api/pay', requestBody: `paymentType=card&note=${g('+')}` }],
    ['query string, + separators', { method: 'GET', url: `/api/search?card=x&q=${g('+')}` }],
    ['non-breaking spaces', { method: 'POST', url: '/api/pay', responseBody: `Card ${g(' ')} was declined` }],
    ['narrow no-break spaces', { method: 'POST', url: '/api/pay', responseBody: `Card ${g(' ')} was declined` }],
    ['base64 under a card key', { method: 'POST', url: '/api/pay', requestBody: `{"card":"${b64}","cvv":""}` }],
    ['JSON \\u escapes of each digit', { method: 'POST', url: '/api/card', requestBody: `{"note":"${escaped}"}` }],
    ['a one-digit label before it (Sol 28)', { method: 'GET', url: '/api/batch', responseBody: `batch 1 ${pan} done` }],
    ['underscore separators in a plain body (Sol 28)', { method: 'POST', url: '/api/x', requestBody: `ref ${g('_')}`, responseBody: 'ok', requestHeaders: { 'content-type': 'text/plain' } }],
  ];
  for (const [what, x] of cases) {
    const c = cleanExchange({ status: 200, ...x }, settings);
    assert.deepEqual(leaks(shownText(c), [pan, g('+'), b64, escaped, ...pan.match(/.{1,4}/g).slice(1)]), [], `${what}: ${shownText(c)}`);
    assert.ok(c.withheld?.length || !shownText(c).includes(pan.slice(4, 12)), what);
  }
  // Any part withheld: the whole exchange's headers and bodies go; method, path and status stay (Sol 28).
  const x = cleanExchange({ method: 'POST', url: '/api/x', status: 201, requestHeaders: { 'content-type': 'text/plain', 'x-requestid': 'r-1' }, requestBody: `ref ${g('_')}`, responseBody: 'the response, otherwise harmless', responseHeaders: { 'content-type': 'text/plain' } }, settings);
  assert.ok(withheldAll(x), JSON.stringify(x));
  assert.deepEqual([x.method, x.path, x.status], ['POST', '/api/x', 201]);
  assert.match(requestBlock(x), /POST \/api\/x[\s\S]*\(withheld/);
});

test('a payment method object holding a card number under a plain key is a card context: holder and expiry masked (ADV2-R2-04)', () => {
  for (const body of [
    { paymentMethod: { type: 'scheme', number: pan, expiryMonth: '09', expiryYear: '2031', holderName: holder } },
    { card: { details: { number: pan, expMonth: 9, expYear: 2031, name: holder } } },
  ]) {
    const c = cleanExchange({ method: 'POST', url: '/api/payments', status: 200, requestBody: JSON.stringify(body) }, settings);
    assert.deepEqual(leaks(shownText(c), [pan, holder, '2031']), [], shownText(c));
  }
});

test('a card field left unmasked in a payment exchange withholds it; a security code repeated in prose too; a cut XML code and a bare holder line are masked (Sol 27)', () => {
  // The response repeats the code in a sentence.
  const echo = cleanExchange({ method: 'POST', url: '/api/pay', status: 400, requestBody: JSON.stringify({ cardNumber: number, cvc: cvv }), responseBody: `The code ${cvv} does not match` }, settings);
  assert.deepEqual(leaks(shownText(echo), [cvv, number]), [], shownText(echo));
  // XML cut short inside the security code; a bare key/value holder with a space in the name.
  const xml = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `<payment><card><number>${number}</number><cvc>${cvv}` }, settings);
  assert.deepEqual(leaks(shownText(xml), [cvv, number]), [], shownText(xml));
  const kv = cleanEvidenceText(`cardholder: ${holder}\nstatus: ok`, { env: {} }).text;
  assert.equal(kv, `cardholder: ${FIELD}\nstatus: ok`);
  // A card field's value with no card shape is masked all the same (a), never shown.
  const left = cleanExchange({ method: 'POST', url: '/api/pay', status: 400, requestBody: '{"cardNumber":"12ab"}' }, settings);
  assert.equal(left.requestBody, `{"cardNumber":"${FIELD}"}`);
});

test('nothing but the masked spans changes: unrelated escapes, XML padding; a JSON document in a string with other escapes is withheld, not rewritten (Sol 29)', () => {
  const inner = `{\\u0022note\\u0022:\\u0022a\\u0022,"cardHolderName":"${holder}"}`;
  const c = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `{"payload":"${inner.replace(/"/g, '\\"')}"}` }, settings);
  assert.ok(c.withheld?.length, 'withheld, not written back with other escapes');
  assert.ok(!shownText(c).includes(holder));
  const xml = cleanEvidenceText(`<cardHolderName>  ${holder}  </cardHolderName><note>  as sent  </note>`, { env: {} }).text;
  assert.equal(xml, `<cardHolderName>  ${FIELD}  </cardHolderName><note>  as sent  </note>`);
  const canonical = JSON.stringify({ payload: JSON.stringify({ note: 'a\tb', cardHolderName: holder }) });
  const cc = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: canonical }, settings);
  assert.equal(cc.requestBody, canonical.replace(holder, FIELD));
});

test('XML card context reaches everything beneath a card element holding a card value, and nothing beside it', () => {
  assert.equal(cleanEvidenceText(`<card><number>${pan}</number><billing><name>Alice Example</name></billing></card><shop><name>Main</name></shop>`, { env: {} }).text, `<card><number>${FIELD}</number><billing><name>${FIELD}</name></billing></card><shop><name>Main</name></shop>`);
  // A `card` with no card value (a board's card) is not a card container.
  assert.equal(cleanEvidenceText('<card><billing><name>Alice Example</name></billing></card>', { env: {} }).text, '<card><billing><name>Alice Example</name></billing></card>');
  assert.equal(cleanEvidenceText(`<card><expiry><month>09</month><year>2031</year></expiry><brand>visa</brand></card>`, { env: {} }).text, `<card><expiry><month>${FIELD}</month><year>${FIELD}</year></expiry><brand>visa</brand></card>`);
});

test('XML is read in linear time: 256 KiB and 1 MiB of repeated, deeply nested and cut-short elements within a fixed bound (ADV2-R2-06, Sol 31)', () => {
  for (const size of [256 * 1024, 1024 * 1024]) {
    for (const [what, unit] of [['repeated', '<a>'], ['card prefix, unmatched closers', '<card><a>'], ['nested with an attribute', '<a x="1">']]) {
      const body = `${unit.repeat(Math.ceil(size / unit.length / 2))}${'</b>'.repeat(Math.ceil(size / 8))}<cvc>${cvv}`;
      const t0 = performance.now();
      const c = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: body }, { ...settings, maxBodyBytes: 2 * size });
      const ms = performance.now() - t0;
      assert.ok(ms < 8_000, `${what} at ${size} bytes took ${Math.round(ms)} ms`);
      assert.ok(!shownText(c).includes(`<cvc>${cvv}`), what);
    }
  }
});

// ---- round 4: broader withholding instead of a smarter parser ---------------------------------------------------------

test('XML card attributes are masked in their element\'s context; a typed card object\'s compound fields are masked beneath it (published-records-27)', () => {
  const xml = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `<payment><card holder="${holder}" cvc="${cvv}" brand="visa"/><amount>5</amount></payment>` }, settings);
  assert.deepEqual(leaks(shownText(xml), [holder, cvv]), [], shownText(xml));
  assert.match(xml.requestBody, /brand="visa"/);
  assert.match(xml.requestBody, /<amount>5<\/amount>/);
  // A payment method element holding a card number: everything beneath it is card data, attributes too.
  const inferred = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `<paymentMethod><acct>${pan}</acct><owner name="${holder}"/><valid>${expiry}</valid></paymentMethod>` }, settings);
  assert.deepEqual(leaks(shownText(inferred), [pan, holder, expiry]), [], shownText(inferred));
  const json = cleanExchange({ method: 'POST', url: '/api/payments', status: 200, requestBody: JSON.stringify({ payment: { type: 'card', number: pan, holder: { first: 'Rowan', last: 'Ellery' }, expiry: { month: '09', year: '2031' } }, orderId: 'o-1' }) }, settings);
  assert.deepEqual(leaks(shownText(json), [pan, 'Rowan', 'Ellery', '2031']), [], shownText(json));
  assert.match(json.requestBody, /"type":"card"/);
  assert.match(json.requestBody, /"orderId":"o-1"/);
});

test('a card value from the request is masked wherever the response repeats it, a security code as a JSON number too (published-records-28)', () => {
  const ex = { method: 'POST', url: '/api/pay', status: 400, requestBody: JSON.stringify({ cardNumber: number, cvc: cvv }), responseBody: `{"receipt":{"code":${cvv}},"note":"holder ${holder}"}` };
  const c = cleanExchange(ex, settings, { echo: cardValuesIn([{ ...ex, requestBody: JSON.stringify({ cardNumber: number, cvc: cvv, cardHolderName: holder }) }]) });
  assert.deepEqual(leaks(shownText(c), [cvv, holder, number]), [], shownText(c));
});

test('a bare holder field stops at the next field on its line (published-records-30)', () => {
  assert.equal(cleanEvidenceText(`cardholder: ${holder} qty=2 note: ok`, { env: {} }).text, `cardholder: ${FIELD} qty=2 note: ok`);
});

test('in a payment exchange, a body that could not be read with confidence is withheld; a recorder-cut body or an HTML page without card data is not (published-records-28 d)', () => {
  const stray = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `{"cardNumber":"${number}"}}]` }, settings);
  assert.match(stray.withheld?.[0]?.reason ?? '', /could not be read with confidence/);
  const xml = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `<card><number>${number}</number></holder></card>` }, settings);
  assert.match(xml.withheld?.[0]?.reason ?? '', /could not be read with confidence/);
  const page = cleanExchange({ method: 'GET', url: '/checkout', status: 200, responseBody: '<html><body><p>Choose a card<br>the shop accepts</p></body></html>' }, settings);
  assert.equal(page.withheld, undefined, JSON.stringify(page.withheld));
});

// ---- the final rule: card keys (a), card containers (b), echoes of request card values (c), and the final check ------

test('the card-data leaks found in review are masked or withheld: a long XML tag, keys of several words, a card details object, numbers split by Unicode dashes or commas (evidence-27, evidence-28)', () => {
  // An XML card tag with more than 256 characters of attributes, one of them holding `>`.
  const attrs = Array.from({ length: 12 }, (_, i) => `data-x${i}="value number ${i} > ok"`).join(' ');
  const xml = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `<card ${attrs} cvc="${cvv}"><number>${number}</number><holder>${holder}</holder><expiry>${expiry}</expiry></card>` }, settings);
  assert.deepEqual(leaks(shownText(xml), [cvv, number, holder, expiry]), [], shownText(xml));
  // The `>` inside a quoted attribute does not end the tag; beneath the card element its attributes are card data (b).
  assert.ok(xml.requestBody.startsWith(`<card data-x0="${FIELD}"`) && xml.requestBody.includes(`data-x11="${FIELD}" cvc="${FIELD}"><number>${FIELD}</number>`), xml.requestBody);
  // Keys of several words in key/value text.
  const text = cleanEvidenceText(`card security code: ${cvv}\ncard holder: ${holder}\ncard expiry: ${expiry}\nName on card: ${holder}\nquantity: 2`, { env: {} }).text;
  assert.equal(text, `card security code: ${FIELD}\ncard holder: ${FIELD}\ncard expiry: ${FIELD}\nName on card: ${FIELD}\nquantity: 2`);
  // A GET response with a card details object and no number or code.
  const details = cleanExchange({ method: 'GET', url: '/api/wallet', status: 200, responseBody: JSON.stringify({ cardDetails: { holder, expiry, last4: '4242' }, cardInfo: { name: holder } }) }, settings);
  assert.deepEqual(leaks(shownText(details), [holder, expiry]), [], shownText(details));
  assert.match(details.responseBody, /"last4":"4242"/);
  // A card number split by an en dash, a non-breaking hyphen, a minus sign or commas: withheld wherever it is.
  for (const sep of ['–', '‑', '−', ',', ' ']) {
    const split = pan.match(/.{4}/g).join(sep);
    const c = cleanExchange({ method: 'GET', url: '/api/receipt', status: 200, responseBody: `{"note":"paid with ${split}"}` }, settings);
    assert.ok(!shownText(c).includes(split), `${JSON.stringify(sep)}: ${shownText(c)}`);
  }
  // The security code words the payment hint did not know.
  for (const key of ['cvn', 'csc', 'ccv', 'primaryAccountNumber']) {
    const c = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: JSON.stringify({ [key]: cvv }), responseBody: `ok ${cvv}` }, settings);
    assert.deepEqual(leaks(shownText(c), [cvv]), [], `${key}: ${shownText(c)}`);
  }
});

test('records that are not card data are published: a flat order, a payment\'s billing details, a board card (evidence-30)', () => {
  // eShop's create-order request: address, items, units and prices are shown; the card number, security code, holder
  // and expiry are masked.
  const order = {
    userId: 'u-1', userName: 'shopper', city: 'Springfield', street: '1 Main St', state: 'WA', country: 'US', zipCode: '98000',
    cardNumber: pan, cardHolderName: holder, cardExpiration: '2031-09-01T00:00:00Z', cardSecurityNumber: cvv, cardTypeId: 1, buyer: 'shopper',
    items: [{ productId: 7, productName: 'Mug', unitPrice: 8.5, oldUnitPrice: 0, quantity: 2, pictureUrl: '/pics/7' }],
  };
  const c = cleanExchange({ method: 'POST', url: '/api/orders', status: 200, requestBody: JSON.stringify(order), responseBody: JSON.stringify({ orderId: 41, total: 17 }) }, settings);
  const shown = JSON.parse(c.requestBody);
  assert.deepEqual({ ...shown, cardNumber: 'x', cardHolderName: 'x', cardExpiration: 'x', cardSecurityNumber: 'x' }, { ...order, cardNumber: 'x', cardHolderName: 'x', cardExpiration: 'x', cardSecurityNumber: 'x' });
  for (const k of ['cardNumber', 'cardHolderName', 'cardExpiration', 'cardSecurityNumber']) assert.equal(shown[k], FIELD, k);
  assert.equal(c.responseBody, JSON.stringify({ orderId: 41, total: 17 }));
  // A payment with its billing details beside its card: the billing details are shown.
  const stripe = cleanExchange({ method: 'POST', url: '/v1/payment_methods', status: 200, requestBody: JSON.stringify({ type: 'card', billingDetails: { city: 'Springfield', postalCode: '98000' }, card: { number: pan, exp_month: 9, exp_year: 2031, cvc: cvv } }) }, settings);
  assert.deepEqual(JSON.parse(stripe.requestBody).billingDetails, { city: 'Springfield', postalCode: '98000' });
  assert.deepEqual(leaks(shownText(stripe), [pan, cvv, '2031']), [], shownText(stripe));
  // A board's card holds no card value: nothing in it is card data.
  const board = JSON.stringify({ card: { id: 12, title: 'Fix the login', column: 'doing', priority: 2, assignee: 'sam' } });
  const b = cleanExchange({ method: 'POST', url: '/api/board/cards', status: 201, requestBody: board, responseBody: board }, settings);
  assert.equal(b.requestBody, board);
  assert.equal(b.responseBody, board);
});

test('XML mixed content: each text run of a card element is masked and its inline tags kept (published-records-29)', () => {
  const t = cleanEvidenceText(`<cardHolderName>Rowan <i/> Ellery</cardHolderName><note>keep <b>this</b></note>`, { env: {} }).text;
  assert.equal(t, `<cardHolderName>${FIELD} <i/> ${FIELD}</cardHolderName><note>keep <b>this</b></note>`);
});

test('echoes: the URL first asked for seeds them (a redirect), only request card values do, and overlapping echoes stop at a work limit (published-records-27, published-records-31)', () => {
  // Asked for with the code in the query, answered at another URL, the response quoting the code.
  const r = cleanExchange({ method: 'GET', requestUrl: `/checkout?cvc=${cvv}`, url: '/checkout/done', status: 200, responseBody: `<p>code ${cvv} checked</p>` }, settings);
  assert.deepEqual(leaks(shownText(r), [cvv]), [], shownText(r));
  // A value only a response holds under a card key is masked there, not looked for elsewhere: a status that happens to be
  // equal stays.
  const status = cleanExchange({ method: 'GET', url: '/api/cards/1', status: 200, responseBody: JSON.stringify({ cardSecurityCode: cvv, retries: Number(cvv) }) }, settings);
  assert.equal(status.responseBody, JSON.stringify({ cardSecurityCode: FIELD, retries: Number(cvv) }));
  // Many echo values that end inside each other over a long run of them: bounded, and withheld, not published.
  const values = Array.from({ length: 400 }, (_, i) => Array(i + 2).fill('7').join(' '));
  const body = Array(20_000).fill('7').join(' ');
  const t0 = performance.now();
  const c = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, responseBody: body }, { ...settings, maxBodyBytes: 100_000 }, { echo: values });
  assert.ok(performance.now() - t0 < 4_000, `took ${Math.round(performance.now() - t0)} ms`);
  assert.match(c.withheld?.[0]?.reason ?? '', /too many overlapping card values/);
});

test('the final check decodes percent-encoded UTF-8 before reading separators: a thin space between digit groups (published-records-28)', () => {
  const split = pan.match(/.{4}/g).join('%E2%80%89');
  const c = cleanExchange({ method: 'GET', url: '/api/receipt', status: 200, responseBody: `paid with ${split}` }, settings);
  assert.ok(!shownText(c).includes(split), shownText(c));
  assert.ok(c.withheld?.length);
  // A malformed escape next to it is read byte by byte, not given up on.
  const bad = cleanExchange({ method: 'GET', url: '/api/receipt', status: 200, responseBody: `paid %E2 with ${split}` }, settings);
  assert.ok(bad.withheld?.length);
});

// ---- MP-1, MP-2: beside a card number, and self-closing card elements ----------------------------------------------

test('beside a card number, a code, expiry or holder under a loose name is masked; other fields stay; the final check withholds what is left (MP-1)', () => {
  for (const [code, exp] of [['cardCode', 'expirationDate'], ['cvvCode', 'expiryDate'], ['securityCode', 'expiry'], ['cvvNumber', 'expMonth']]) {
    const body = { amount: 5, cardNumber: pan, [code]: cvv, [exp]: expiry, nameOnCard: holder, city: 'Springfield' };
    const c = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: JSON.stringify(body) }, settings);
    assert.deepEqual(leaks(shownText(c), [pan, cvv, expiry, holder]), [], `${code}/${exp}: ${shownText(c)}`);
    assert.deepEqual(JSON.parse(c.requestBody), { ...body, cardNumber: FIELD, [code]: FIELD, [exp]: FIELD, nameOnCard: FIELD });
    // The same as a form and as XML elements.
    const form = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: `amount=5&cardNumber=${pan}&${code}=${cvv}&${exp}=${encodeURIComponent(expiry)}&city=Springfield` }, settings);
    assert.deepEqual(leaks(shownText(form), [cvv, encodeURIComponent(expiry), '31']), [], shownText(form));
    assert.match(form.requestBody, /amount=5&.*&city=Springfield$/);
    const xml = cleanEvidenceText(`<order><cardNumber>${pan}</cardNumber><${code}>${cvv}</${code}><${exp}>${expiry}</${exp}><city>Springfield</city></order>`, { env: {} }).text;
    assert.equal(xml, `<order><cardNumber>${FIELD}</cardNumber><${code}>${FIELD}</${code}><${exp}>${FIELD}</${exp}><city>Springfield</city></order>`);
  }
  // eShop's create-order request: address, items and prices are still shown.
  const order = { userId: 'u-1', city: 'Springfield', street: '1 Main St', zipCode: '98000', cardNumber: pan, cardHolderName: holder, cardExpiration: '2031-09-01T00:00:00Z', cardSecurityNumber: cvv, cardTypeId: 1, items: [{ productId: 7, unitPrice: 8.5, quantity: 2 }] };
  const shown = JSON.parse(cleanExchange({ method: 'POST', url: '/api/orders', status: 200, requestBody: JSON.stringify(order) }, settings).requestBody);
  assert.deepEqual(shown, { ...order, cardNumber: FIELD, cardHolderName: FIELD, cardExpiration: FIELD, cardSecurityNumber: FIELD });
  // A code or expiry left elsewhere in an exchange holding a card number is withheld, never published.
  const left = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: JSON.stringify({ payment: { cardNumber: pan }, meta: { expirationDate: expiry } }) }, settings);
  assert.ok(withheldAll(left), JSON.stringify(left));
  assert.match(left.withheld[0].reason, /security code or expiry field beside a card number whose value was left \(expirationDate\)/);
  // Without a card number in the exchange, such names are not card data.
  const plain = cleanExchange({ method: 'GET', url: '/api/coupons', status: 200, responseBody: JSON.stringify({ code: 'SAVE10', expiryDate: '2026-12-01' }) }, settings);
  assert.equal(plain.responseBody, JSON.stringify({ code: 'SAVE10', expiryDate: '2026-12-01' }));
});

test('a self-closing card element is a container by its own attributes, as with a closing tag (MP-2)', () => {
  for (const attrs of [`number="${pan}" cvv="${cvv}" holder="${holder}" exp="${expiry}"`, `cvv="${cvv}" holder="${holder}" exp="${expiry}"`]) {
    const selfClosing = cleanEvidenceText(`<order><card ${attrs}/><total>5</total></order>`, { env: {} }).text;
    const closed = cleanEvidenceText(`<order><card ${attrs}></card><total>5</total></order>`, { env: {} }).text;
    assert.equal(selfClosing.replace('/>', '></card>'), closed);
    assert.deepEqual(leaks(selfClosing, [pan, cvv, holder, expiry]), [], selfClosing);
    assert.match(selfClosing, /<total>5<\/total>/);
  }
});

// ---- final fixes: payment exchanges withheld by default; the mask mode's cut and nested forms --------------------------

test('by default a payment exchange publishes its method, path without the query and status only; a non-payment exchange of the same bug is published in full (final fixes A)', () => {
  const defaults = { ...API_EVIDENCE_DEFAULTS };
  assert.equal(defaults.paymentBodies, 'withhold');
  // eShop's create-order request.
  const order = { userId: 'u-1', city: 'Springfield', street: '1 Main St', cardNumber: pan, cardHolderName: holder, cardExpiration: '2031-09-01T00:00:00Z', cardSecurityNumber: cvv, cardTypeId: 1, items: [{ productId: 7, unitPrice: 8.5, quantity: 2 }] };
  const create = { method: 'post', url: 'http://127.0.0.1:5000/api/orders?api-version=1.0', status: 400, requestHeaders: { 'content-type': 'application/json', 'x-requestid': 'r-1' }, requestBody: JSON.stringify(order), responseHeaders: { 'content-type': 'application/problem+json' }, responseBody: JSON.stringify({ title: 'One or more validation errors occurred.', errors: { CardSecurityNumber: ['too short'] } }) };
  assert.equal(isPaymentExchange(create), true);
  const c = cleanExchange(create, defaults);
  assert.deepEqual(c, { method: 'POST', path: '/api/orders', requestHeaders: [], requestBody: null, status: 400, responseHeaders: [], responseBody: null, durationMs: null, repro: null, notes: [PAYMENT_WITHHELD], paymentWithheld: true });
  assert.deepEqual(leaks(JSON.stringify(c), [pan, holder, cvv, 'Springfield', 'api-version', 'r-1']), []);
  // A payment value in the query string is not published (the query is dropped), nor one in a header.
  const query = cleanExchange({ method: 'GET', url: `/api/payments/lookup?cvv=${cvv}&exp=${encodeURIComponent(expiry)}`, status: 200, responseHeaders: { location: `/cards?number=${pan}` }, responseBody: '{"ok":true}' }, defaults);
  assert.deepEqual([query.path, query.requestBody, query.responseBody, query.responseHeaders], ['/api/payments/lookup', null, null, []]);
  // The same bug's catalog call has no payment data: shown exactly as before.
  const catalog = { method: 'GET', url: '/api/catalog/items?pageSize=10', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: JSON.stringify({ count: 1, data: [{ id: 7, name: 'Mug', price: 8.5 }] }) };
  assert.equal(isPaymentExchange(catalog), false);
  const shown = cleanExchange(catalog, defaults);
  assert.equal(shown.path, '/api/catalog/items?pageSize=10');
  assert.equal(shown.responseBody, catalog.responseBody);
  assert.deepEqual(shown.responseHeaders, [['content-type', 'application/json']]);
  // The evidence still shows the calls and statuses: the PR section and the ticket comment say the bodies were withheld.
  const ev = { ok: true, pairs: [{ before: c, after: { ...c, status: 201 } }, { before: shown, after: shown }] };
  const prose = { preconditions: 'Signed in.', steps: ['Create an order', 'List the catalog'], difference: ['400 before, 201 after', 'unchanged'], wrong: ['it is refused', 'nothing'] };
  const section = evidenceSection([{ key: 'BUG-9', title: 'Create order fails', ev, prose, comment: { posted: true } }], defaults);
  assert.match(section, /POST \/api\/orders\n```\n\n\(bodies withheld: payment data\)/);
  assert.match(section, /HTTP 400\n```\n\n\(bodies withheld: payment data\)/);
  assert.match(section, /HTTP 201/);
  assert.match(section, /"name":"Mug"/);
  assert.deepEqual(leaks(section, [pan, holder, cvv]), []);
  assert.match(reproductionComment('BUG-9', ev, prose), /bodies withheld: payment data/);
  assert.match(requestBlock(c), /^```[a-z]*\nPOST \/api\/orders\n```/);
  assert.match(responseBlock(c), /HTTP 400/);
});

test('`video.apiEvidence.paymentBodies` is validated like the other choices, by every loader', async (t) => {
  const { ConfigError, loadConfig, toolConfig } = await import('../../pipeline/lib/config.mjs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'payment-bodies-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ video: { apiEvidence: { paymentBodies: 'publish' } } }));
  for (const load of [() => toolConfig('prune', {}, dir), () => loadConfig('implement', dir)]) assert.throws(load, (e) => e instanceof ConfigError && /video\.apiEvidence\.paymentBodies must be one of withhold, mask/.test(e.message));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ video: { apiEvidence: { paymentBodies: 'mask' } } }));
  assert.doesNotThrow(() => toolConfig('prune', {}, dir));
});

test('mask mode: an XML card container the recorder cut short is withheld, and its elements left open still make it a container; a compound expiry makes its parent one (final fixes B)', () => {
  // Cut inside a card container, never closed: in a payment exchange, withheld whole (the recorder's cut included).
  for (const body of [`<order><paymentMethod><holder>${holder}</holder><number>${pan}</number>\n… (120 more characters)`, `<order><card><holder>${holder}</holder><cvv>${cvv}`, `{"card":{"holder":"${holder}","cvv":"${cvv}"`]) {
    const c = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: body }, settings);
    assert.ok(withheldAll(c), body);
    assert.deepEqual(leaks(shownText(c), [holder, cvv, pan]), []);
  }
  // Elements left open at the end are closed there: the container status still applies to what they hold.
  const open = cleanEvidenceText(`<order><card><holder>${holder}</holder><cvv>${cvv}</cvv>`, { env: {} }).text;
  assert.deepEqual(leaks(open, [holder, cvv]), [], open);
  // A payment whose expiry is a compound field (month and year) is a container: its holder is masked too.
  const xml = cleanEvidenceText(`<payment><expiry><month>09</month><year>2031</year></expiry><holder>${holder}</holder></payment><shop>Main</shop>`, { env: {} }).text;
  assert.equal(xml, `<payment><expiry><month>${FIELD}</month><year>${FIELD}</year></expiry><holder>${FIELD}</holder></payment><shop>Main</shop>`);
  const json = cleanExchange({ method: 'POST', url: '/api/pay', status: 200, requestBody: JSON.stringify({ payment: { expiry: { month: '09', year: '2031' }, holder }, shop: 'Main' }) }, settings);
  assert.equal(json.requestBody, JSON.stringify({ payment: { expiry: { month: FIELD, year: FIELD }, holder: FIELD }, shop: 'Main' }));
});

// ---- last check: what makes a payment exchange ----------------------------------------------------------------------

test('a payment exchange is told by a card number or an unambiguous card name, not by Expires headers, token expiries, board cards or prose words (last check)', () => {
  const defaults = { ...API_EVIDENCE_DEFAULTS };
  const published = (x) => {
    const c = cleanExchange(x, defaults);
    assert.equal(isPaymentExchange(x), false, JSON.stringify(x).slice(0, 120));
    assert.ok(!c.paymentWithheld && c.responseBody != null, JSON.stringify(c).slice(0, 200));
    return c;
  };
  // A Spring Security response: `Expires: 0`, `Cache-Control`, a cookie with `Expires=`, and a JSON body.
  const spring = published({ method: 'GET', url: '/api/orders/7', status: 200, responseHeaders: { 'content-type': 'application/json', expires: '0', 'cache-control': 'no-cache, no-store', 'set-cookie': 'SESSION=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/' }, responseBody: JSON.stringify({ id: 7, status: 'submitted', total: 17 }) });
  assert.equal(spring.responseBody, JSON.stringify({ id: 7, status: 'submitted', total: 17 }));
  // A token response with `expires_in` and an `exp` claim: published, its secret fields still masked by name.
  const token = published({ method: 'POST', url: '/connect/token', status: 200, responseBody: JSON.stringify({ access_token: 'a1b2c3d4e5f6g7h8', expires_in: 3600, token_type: 'Bearer', claims: { exp: 1790000000, iat: 1789996400, nbf: 1789996400, expiresAt: '2026-09-21T00:00:00Z' } }) });
  assert.match(token.responseBody, /"expires_in":3600/);
  assert.match(token.responseBody, /"exp":1790000000/);
  assert.ok(!token.responseBody.includes('a1b2c3d4e5f6g7h8'), token.responseBody);
  // A board API: `cards` holding titles only.
  const board = published({ method: 'GET', url: '/api/board/1', status: 200, responseBody: JSON.stringify({ id: 1, cards: [{ id: 3, title: 'Pay the card bill' }, { id: 4, title: 'Expand the panel' }], company: 'Shop' }) });
  assert.match(board.responseBody, /"cards":\[\{"id":3/);
  // "pan" and "card" in prose, and inside other words.
  published({ method: 'GET', url: '/api/recipes/2', status: 200, responseBody: JSON.stringify({ title: 'Pan-fried card-shaped crackers', steps: 'Heat the pan, then expand the dough.' }) });
  // Still withheld: eShop's create-order request (a card number), a body with only `cvv`, a card number only in a header
  // value or only in the URL path, a card field name in the query.
  for (const x of [
    { method: 'POST', url: '/api/orders', status: 200, requestBody: JSON.stringify({ city: 'Springfield', cardNumber: number, cardHolderName: holder, cardExpiration: '2031-09-01', cardSecurityNumber: cvv, items: [] }), responseBody: '{}' },
    { method: 'POST', url: '/api/pay', status: 400, requestBody: JSON.stringify({ cvv }), responseBody: '{"ok":false}' },
    { method: 'GET', url: '/api/receipt', status: 200, responseHeaders: { 'x-request-id': pan }, responseBody: '{"ok":true}' },
    { method: 'GET', url: `/api/cards/${pan}/status`, status: 200, responseBody: '{"ok":true}' },
    { method: 'GET', url: `/api/pay?card%5Bcvc%5D=${cvv}`, status: 200, responseBody: '{"ok":true}' },
  ]) {
    assert.equal(isPaymentExchange(x), true, JSON.stringify(x).slice(0, 120));
    const c = cleanExchange(x, defaults);
    assert.ok(c.paymentWithheld, JSON.stringify(c));
    assert.deepEqual(leaks(JSON.stringify(c), [pan, number, cvv, holder]), [], JSON.stringify(c));
  }
});
