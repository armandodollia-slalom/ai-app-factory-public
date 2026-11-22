// The generic credential rule of the redaction boundary in linear time: a long run of base64-like text once took time
// that grew with the square of its length (80,000 characters: seconds; a megabyte: minutes), and what the rule detects
// stays what it was.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { RULES } from '../lib/redact.mjs';

// Deterministic pseudo-random text (no value in this file is a credential: everything is generated at run time).
const prng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const word = (rnd, n, abc = ALNUM) => Array.from({ length: n }, () => pick(rnd, abc)).join('');

// Runs in a worker so that a slow rule fails the test at the bound instead of blocking the suite for minutes.
test('a megabyte run of base64-like text is redacted within a fixed time, and a credential after it is still found', async () => {
  const rnd = prng(7);
  const run = word(rnd, 1024 * 1024, `${ALNUM}+/_.-`);
  const value = `${word(rnd, 12)}7a${word(rnd, 12)}`;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.lib).then(({ forgetSecretsForTest, redactText }) => {
      forgetSecretsForTest();
      const plain = redactText('A'.repeat(1024 * 1024), { env: {} });
      const mixed = redactText(workerData.text, { env: {} });
      parentPort.postMessage({ plainHits: plain.hits, hits: mixed.hits, tail: mixed.text.slice(-40) });
    });`;
  const worker = new Worker(source, { eval: true, workerData: { lib: new URL('../lib/redact.mjs', import.meta.url).href, text: `${run} api_key=${value}` } });
  // Linear takes well under a second; the quadratic rule took minutes. The bound leaves room for a loaded machine.
  const BOUND_MS = 15_000;
  let timer;
  const result = await Promise.race([
    new Promise((resolve, reject) => worker.once('message', resolve).once('error', reject)),
    new Promise((resolve) => (timer = setTimeout(() => resolve(null), BOUND_MS))),
  ]);
  clearTimeout(timer);
  await worker.terminate();
  assert.ok(result, `two megabyte redactions did not finish within ${BOUND_MS} ms`);
  assert.deepEqual(result.plainHits, []);
  assert.ok(result.hits.includes('generic-api-key'));
  assert.ok(result.tail.endsWith(' api_key=[redacted:generic-api-key]'));
});

test('the generic credential rule finds and replaces exactly what the earlier rule did', () => {
  // The rule before the change (a lazy prefix before the credential word), kept here as the oracle.
  const before = /((?:[A-Za-z0-9_.-]*?)(?:api[_.-]?key|access[_.-]?key|secret[_.-]?key|private[_.-]?key|auth[_.-]?key|encryption[_.-]?key|signing[_.-]?key|client[_.-]?secret|secret|token|passwd|password|pwd|credentials?)s?["']?\s*(?:=>|:=|[:=])\s*["']?)([A-Za-z0-9+/_.~-]{8,}={0,2})/gi;
  const rule = RULES.find((r) => r.id === 'generic-api-key');
  const apply = (re, text) => {
    const found = [];
    re.lastIndex = 0;
    const out = text.replace(re, (...m) => {
      const groups = m.slice(1, -2);
      if (!rule.check(groups[1])) return m[0];
      found.push(groups[1]);
      return m[0].slice(0, m[0].length - groups[1].length) + '[x]';
    });
    return { out, found };
  };
  const rnd = prng(42);
  const names = ['api_key', 'API-KEY', 'apiKey', 'my_app.access_key', 'client_secret', 'secret', 'Token', 'auth_token', 'db.password', 'pwd', 'credentials', 'secretkey', 'x.secret_token', 'tokens', 'private-key', 'signingKey', 'ticket_key', 'name', 'monkey'];
  const seps = ['=', ': ', ' := ', ' => ', '="', ": '", ':', '\t=\t', ' '];
  const values = () => pick(rnd, [word(rnd, 6), word(rnd, 8 + Math.floor(rnd() * 30)), word(rnd, 20, 'abcdef0123456789'), 'some-plain-words', 'MY_ENV_NAME', '1234567890', `${word(rnd, 10)}==`, '${VAR}', `${word(rnd, 12)}.${word(rnd, 9)}`]);
  const fillers = [' ', '\n', ', ', '; ', '{"', '"}', ' and ', '&', '?', '/', '-', '.'];
  let cases = 0;
  for (let i = 0; i < 3000; i++) {
    let text = '';
    const parts = 1 + Math.floor(rnd() * 5);
    for (let p = 0; p < parts; p++) {
      if (rnd() < 0.3) text += word(rnd, Math.floor(rnd() * 12), `${ALNUM}_.-`);
      text += `${pick(rnd, names)}${pick(rnd, seps)}${values()}${pick(rnd, fillers)}`;
    }
    const a = apply(before, text);
    const b = apply(rule.re, text);
    assert.deepEqual(b, a, `differs on: ${JSON.stringify(text)}`);
    if (a.found.length) cases++;
  }
  assert.ok(cases > 500, `the corpus exercises detections (${cases})`);
});

// Repeated begin markers of a private-key block with no end marker took 25 s on a megabyte (the lazy body scanned to the
// end from every begin marker), through the evidence cleaner as well.
test('repeated private-key begin markers without an end marker are redacted within a fixed time, through the evidence cleaner too', async () => {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.redact), import(workerData.evidence)]).then(([r, e]) => {
      const text = ('-----BEGIN RSA ' + 'PRIVATE KEY-----\\n').repeat(Math.ceil(1048576 / 32));
      r.redactText(text, { env: {} });
      e.cleanExchange({ method: 'POST', url: '/x', requestBody: text, responseBody: text });
      parentPort.postMessage('done');
    });`;
  const worker = new Worker(source, { eval: true, workerData: { redact: new URL('../lib/redact.mjs', import.meta.url).href, evidence: new URL('../../pr-video/lib/api-evidence.mjs', import.meta.url).href } });
  const BOUND_MS = 15_000;
  let timer;
  const result = await Promise.race([
    new Promise((resolve, reject) => worker.once('message', resolve).once('error', reject)),
    new Promise((resolve) => (timer = setTimeout(() => resolve(null), BOUND_MS))),
  ]);
  clearTimeout(timer);
  await worker.terminate();
  assert.equal(result, 'done', `a megabyte of begin markers was not redacted within ${BOUND_MS} ms`);
});

test('the private-key forward pass finds exactly what the lazy rule did', () => {
  const rule = RULES.find((r) => r.id === 'private-key');
  // The rule as a lazy regex (what it matched before the forward pass): the oracle.
  const LAZY = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g;
  const lazy = (text) => [...text.matchAll(LAZY)].map((m) => [m.index, m.index + m[0].length]);
  const rnd = prng(11);
  const begin = () => `-----BEGIN ${pick(rnd, ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED '])}PRIVATE KEY${pick(rnd, ['', ' BLOCK'])}-----`;
  const end = () => `-----END ${pick(rnd, ['', 'RSA ', 'EC '])}PRIVATE KEY${pick(rnd, ['', ' BLOCK'])}-----`;
  let found = 0;
  for (let i = 0; i < 2000; i++) {
    let text = '';
    for (let p = 0; p < 1 + Math.floor(rnd() * 5); p++) text += pick(rnd, [begin, end, () => word(rnd, Math.floor(rnd() * 40), `${ALNUM}\n +/=`), () => '\n', () => `${begin()}\n${word(rnd, 10 + Math.floor(rnd() * 30), `${ALNUM}+/=`)}\n${end()}`])();
    const want = lazy(text);
    assert.deepEqual(rule.scan(text), want, JSON.stringify(text));
    found += want.length;
  }
  assert.ok(found > 500, `the corpus exercises matches (${found})`);
});
