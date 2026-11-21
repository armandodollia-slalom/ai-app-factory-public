// Tests for backend bug evidence: header allow-list & credential masking (D7),
// reproduction check validation & setup-failure wording (D1, D8), and non-blocking
// reporting of failed ticket Reproduction comment posts (D6).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_EVIDENCE_DEFAULTS, cleanEvidenceText, cleanExchange, evidenceSection, requestBlock, scanHits, verifyApiBefore } from '../lib/api-evidence.mjs';
import { redactText } from '../../pipeline/lib/redact.mjs';
import { produceLocal } from '../lib/local.mjs';
import { resolveTools } from '../lib/tools.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const runtimeToken = (prefix, len = 36) => [prefix, ...[...crypto.randomBytes(len)].map((b) => abc[b % abc.length])].join('');

test('D7: default header allow-list keeps replay headers (x-requestid, idempotency-key, x-correlation-id) and never keeps credential values', () => {
  const reqId = '11111111-2222-4333-8444-555555555555';
  const idemKey = 'order-idem-42';
  const corrId = 'corr-98765';
  const bearer = `Bearer ${runtimeToken('gh' + 'p_')}`;
  const cookieVal = `sid=${runtimeToken('sess_', 20)}`;
  const v1 = runtimeToken('ak_', 24);
  const v2 = runtimeToken('acc_', 24);
  const v3 = runtimeToken('pk_', 24);
  const v4 = runtimeToken('cs_', 24);
  const v5 = runtimeToken('pw_', 16);
  const v6 = runtimeToken('pat_', 24);

  // Direction 1: replay headers are in the default allow-list and survive cleanExchange + requestBlock.
  for (const h of ['x-requestid', 'idempotency-key', 'x-correlation-id']) {
    assert.ok(API_EVIDENCE_DEFAULTS.headers.includes(h), `default allow-list missing ${h}`);
  }
  const ex = cleanExchange({
    method: 'POST',
    url: 'http://127.0.0.1:5000/api/orders',
    status: 400,
    requestHeaders: {
      'content-type': 'application/json',
      'X-RequestId': reqId,
      'Idempotency-Key': idemKey,
      'X-Correlation-Id': corrId,
      'x-internal-trace': 'node-7.internal',
      Authorization: bearer,
      Cookie: cookieVal,
      'X-Api-Key': v1,
      'X-Access-Key': v2,
      'X-Private-Key': v3,
      'X-Client-Secret': v4,
      'X-Passwd': v5,
      'X-Pat': v6,
    },
    responseHeaders: {
      'content-type': 'application/problem+json',
      'Set-Cookie': cookieVal,
      'x-internal-trace': 'node-7.internal',
    },
  });
  const reqMap = Object.fromEntries(ex.requestHeaders.map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(reqMap['x-requestid'], reqId);
  assert.equal(reqMap['idempotency-key'], idemKey);
  assert.equal(reqMap['x-correlation-id'], corrId);
  assert.equal(reqMap['x-internal-trace'], undefined, 'non-allowlisted non-credential header dropped');

  const block = requestBlock(ex);
  assert.match(block, new RegExp(`X-RequestId: ${reqId}`));
  assert.match(block, new RegExp(`Idempotency-Key: ${idemKey}`));
  assert.match(block, new RegExp(`X-Correlation-Id: ${corrId}`));

  // Direction 2: credential headers are never in the default allow-list and their values are always masked,
  // even when explicitly passed in a custom allow-list.
  const credHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-access-key', 'x-private-key', 'x-client-secret', 'x-passwd', 'x-pat'];
  for (const h of credHeaders) {
    assert.ok(!API_EVIDENCE_DEFAULTS.headers.includes(h), `default allow-list must never contain ${h}`);
  }
  for (const h of ['authorization', 'cookie', 'x-api-key', 'x-access-key', 'x-private-key', 'x-client-secret', 'x-passwd', 'x-pat']) {
    assert.equal(reqMap[h], '(masked)', `credential header ${h} must be masked`);
  }
  const resMap = Object.fromEntries(ex.responseHeaders.map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(resMap['set-cookie'], '(masked)');
  assert.equal(resMap['x-internal-trace'], undefined);

  // Even with a custom allow-list attempting to include credential headers, values stay masked.
  const forced = cleanExchange(
    {
      method: 'POST',
      url: 'http://127.0.0.1:5000/api/orders',
      status: 200,
      requestHeaders: {
        Authorization: bearer,
        Cookie: cookieVal,
        'X-Access-Key': v2,
        'X-Private-Key': v3,
        'X-Correlation-Id': runtimeToken('gh' + 'p_'),
      },
    },
    { ...API_EVIDENCE_DEFAULTS, headers: [...API_EVIDENCE_DEFAULTS.headers, 'authorization', 'cookie', 'x-access-key', 'x-private-key'] },
  );
  const forcedMap = Object.fromEntries(forced.requestHeaders.map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(forcedMap.authorization, '(masked)');
  assert.equal(forcedMap.cookie, '(masked)');
  assert.equal(forcedMap['x-access-key'], '(masked)');
  assert.equal(forcedMap['x-private-key'], '(masked)');
  assert.match(forcedMap['x-correlation-id'], /^\[redacted:github-pat\]$/, 'secret inside allow-listed header value is still redacted');
  const flat = JSON.stringify([ex, forced]);
  for (const val of [bearer, cookieVal, v1, v2, v3, v4, v5, v6]) {
    assert.ok(!flat.includes(val), 'no credential value may leak');
  }
});

test('ADV-9 (D7): custom allow-list masks cloud/proxy/csrf/subscription credential headers and does not over-mask x-cache-bypass or x-continuation-token', () => {
  const secrets = {
    'ocp-apim-subscription-key': runtimeToken('sub_', 20),
    'x-functions-key': runtimeToken('fnk_', 20),
    'x-ms-client-principal': runtimeToken('princ_', 20),
    'proxy-authorization': `Basic ${runtimeToken('px_', 20)}`,
    'x-amz-security-token': runtimeToken('amz_', 20),
    'x-goog-api-key': runtimeToken('goog_', 20),
    'x-csrf-token': runtimeToken('csrf_', 20),
  };
  const harmless = {
    'x-cache-bypass': '1',
    'x-continuation-token': 'next-page-cursor',
    'idempotency-key': 'order-idem-99',
  };
  const ex = cleanExchange(
    {
      method: 'POST',
      url: 'http://127.0.0.1:5000/api/orders',
      status: 200,
      requestHeaders: { ...secrets, ...harmless },
    },
    { ...API_EVIDENCE_DEFAULTS, headers: [...API_EVIDENCE_DEFAULTS.headers, ...Object.keys(secrets), ...Object.keys(harmless)] },
  );
  const map = Object.fromEntries(ex.requestHeaders.map(([k, v]) => [k.toLowerCase(), v]));
  for (const [k, v] of Object.entries(secrets)) {
    assert.equal(map[k], '(masked)', `credential header ${k} must be masked even under custom allow-list`);
    assert.ok(!JSON.stringify(ex).includes(v), `value for ${k} leaked`);
  }
  assert.equal(map['x-cache-bypass'], '1', 'x-cache-bypass must not be over-masked');
  assert.equal(map['x-continuation-token'], 'next-page-cursor', 'x-continuation-token must not be over-masked');
  assert.equal(map['idempotency-key'], 'order-idem-99', 'idempotency-key must not be masked');
});

test('ADV-2/16/21/22 (D4): evidence cleaner masks card data via JSON, form, and Luhn rules in linear time, keeps validation messages, and general redactText stays untouched', () => {
  const makeLuhn = (prefix, len) => {
    const body = (prefix + '1234567890123456789').slice(0, len - 1);
    let sum = 0;
    let dbl = true;
    for (let i = body.length - 1; i >= 0; i--) {
      let d = Number(body[i]);
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      dbl = !dbl;
    }
    return `${body}${(10 - (sum % 10)) % 10}`;
  };
  const pan = makeLuhn('412345', 16);
  const nonLuhn = `${pan.slice(0, -1)}${(Number(pan.at(-1)) + 1) % 10}`;
  const cvv = ['7', '3', '9'].join('');
  const holder = ['Jane', 'Shopper'].join(' ');
  const g = (sep) => pan.match(/.{1,4}/g).join(sep);

  // ADV-16: general redactText does NOT mask payment cards (that belongs only in api-evidence.mjs).
  assert.equal(redactText(`test card ${pan}`, { env: {} }).text, `test card ${pan}`);

  // 1. JSON walk: nested card object, nested JSON string, non-card fields, and ADV-22 validation error shapes.
  const jsonEx = cleanExchange({
    method: 'POST',
    url: 'http://127.0.0.1:5000/api/orders',
    status: 400,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: JSON.stringify({
      cardTypeId: 99,
      'card number': nonLuhn,
      card: { number: nonLuhn, cvc: cvv, exp_month: 12, holder, name: holder, brand: 'visa', last4: '4242' },
      embedded: JSON.stringify({ cardNumber: nonLuhn, cvv }),
    }),
    responseBody: JSON.stringify({
      title: 'One or more validation errors occurred.',
      status: 400,
      errors: {
        cardNumber: ['The CardNumber field is required.'],
        cardSecurityNumber: ['Must be 3 or 4 digits.'],
      },
      rejectedInput: { cardNumber: '12', cvv: 'x' },
      token: 'tok-secret',
      expiry: '2026-12-01',
      product: { expDate: '2026-12-01', pan: 'frying' },
      account: { holderName: 'Alice' },
      cc: { number: '1234567890123456' },
    }),
  });
  const reqJson = JSON.parse(jsonEx.requestBody);
  assert.equal(reqJson.cardTypeId, 99);
  assert.equal(reqJson['card number'], '[redacted:payment-card-field]');
  assert.equal(reqJson.card.number, '[redacted:payment-card-field]');
  assert.equal(reqJson.card.cvc, '[redacted:payment-card-field]');
  assert.equal(reqJson.card.exp_month, '[redacted:payment-card-field]');
  assert.equal(reqJson.card.holder, '[redacted:payment-card-field]');
  assert.equal(reqJson.card.name, '[redacted:payment-card-field]');
  assert.equal(reqJson.card.brand, 'visa');
  assert.equal(reqJson.card.last4, '4242');
  assert.equal(JSON.parse(reqJson.embedded).cardNumber, '[redacted:payment-card-field]');
  assert.equal(JSON.parse(reqJson.embedded).cvv, '[redacted:payment-card-field]');

  // ADV-22: validation errors and short invalid test inputs are preserved, as are non-card objects.
  const resJson = JSON.parse(jsonEx.responseBody);
  assert.deepEqual(resJson.errors.cardNumber, ['The CardNumber field is required.']);
  assert.deepEqual(resJson.errors.cardSecurityNumber, ['Must be 3 or 4 digits.']);
  assert.equal(resJson.rejectedInput.cardNumber, '12', 'short invalid input is not masked');
  assert.equal(resJson.rejectedInput.cvv, 'x', 'non-digit cvv is not masked');
  assert.equal(resJson.token, '(masked)');
  assert.equal(resJson.expiry, '2026-12-01', 'token expiry is not a card field');
  assert.equal(resJson.product.expDate, '2026-12-01', 'product expDate is not a card field');
  assert.equal(resJson.product.pan, 'frying', 'non-numeric pan is not masked');
  assert.equal(resJson.account.holderName, 'Alice', 'account holderName without card prefix is not masked');
  assert.equal(resJson.cc.number, '1234567890123456', 'bare cc object is not treated as a card object');

  // 2. Form-encoded card fields (raw and percent-encoded brackets) + plain/space/dash Luhn PANs.
  const formEx = cleanExchange({
    method: 'POST',
    url: 'http://127.0.0.1:5000/api/charge',
    status: 200,
    requestBody: `card[number]=${nonLuhn}&card[cvc]=${cvv}&card[exp_month]=12&card[name]=Jane+Doe&card%5Bcvv%5D=${cvv}&cardTypeId=3`,
    responseBody: `declined ${g(' ')} and ${g('-')} and ${pan} at 192.0.2.10`,
  });
  for (const leaked of [nonLuhn, cvv, 'Jane+Doe', pan, g(' '), g('-')]) {
    assert.ok(!formEx.requestBody.includes(leaked), `form leaked ${leaked}: ${formEx.requestBody}`);
    assert.ok(!formEx.responseBody.includes(leaked), `text leaked ${leaked}: ${formEx.responseBody}`);
  }
  assert.match(formEx.requestBody, /cardTypeId=3/);
  assert.match(formEx.responseBody, /\[redacted:payment-card\]/);
  assert.match(formEx.responseBody, /192\.0\.2\.10/);

  // 3. ADV-21: linear performance on a 256 KB adversarial body (no quadratic regex/scanning blowup).
  const huge = `${'{"msg":"exp: 12/28 and card_holder_name=x"},'.repeat(6000)}pan=${pan}`;
  assert.ok(huge.length >= 256 * 1024);
  const t0 = performance.now();
  const cleanedHuge = cleanEvidenceText(huge, { env: {} });
  const elapsedMs = performance.now() - t0;
  assert.ok(!cleanedHuge.text.includes(pan), 'PAN in 256 KB input must still be masked');
  assert.ok(elapsedMs < 500, `cleanEvidenceText on 256 KB took ${elapsedMs.toFixed(1)}ms (expected linear < 500ms)`);

  // 4. Cleaned evidence section passes scanHits cleanly even with cardNumber in ticket title.
  const sec = evidenceSection([{
    key: 'BUG-30',
    title: 'Reject 2-digit cardNumber',
    ev: { ok: true, pairs: [{ before: jsonEx, after: formEx }] },
    prose: { steps: ['Send request.'], difference: ['Status changes.'] },
  }]);
  assert.deepEqual(scanHits(sec, { env: {} }), []);
});

// ---- D1 & D8: reproduction assertion check + API-only setup failure wording -------------------------------------------

test('D1: verifyApiBefore validates apiRepro.failed.kind and rejects non-check / untrusted records', () => {
  const call = { method: 'POST', url: 'http://127.0.0.1:5000/api/orders', status: 500, repro: 'place order' };
  const after = { ok: true, api: [{ ...call, status: 400 }] };

  // Legacy / older e2e/fixtures.ts record without kind -> clear version-skew instruction (ADV-5).
  const noKind = verifyApiBefore({
    before: { ok: false, api: [call], apiRepro: { labels: ['place order'], failed: { label: 'place order', message: 'Expected: 400\nReceived: 500' } } },
    after,
    healthy: true,
  });
  assert.equal(noKind.ok, false);
  assert.match(noKind.why, /e2e\/fixtures\.ts is older than the factory/i);
  assert.match(noKind.why, /factory render/i);
  assert.doesNotMatch(noKind.why, /failed outside the reproduction check/i);

  // Explicit kind: 'error' (e.g. TypeError / network error) -> refused, and raw non-assertion message is never echoed (ADV-10).
  const errKind = verifyApiBefore({
    before: { ok: false, api: [call], apiRepro: { labels: ['place order'], failed: { label: 'place order', kind: 'error', responses: 1, message: 'ECONNRESET socket hang up' } } },
    after,
    healthy: true,
  });
  assert.equal(errKind.ok, false);
  assert.match(errKind.why, /failed outside the reproduction check/i);
  assert.ok(!errKind.why.includes('ECONNRESET'), 'non-assertion error message must not be echoed');

  // kind: 'check' with zero recorded responses -> refused.
  const zeroResp = verifyApiBefore({
    before: { ok: false, api: [], apiRepro: { labels: ['place order'], failed: { label: 'place order', kind: 'check', responses: 0, message: 'Expected: 2\nReceived: 1' } } },
    after,
    healthy: true,
  });
  assert.equal(zeroResp.ok, false);
  assert.match(zeroResp.why, /failed outside the reproduction check/i);

  // Valid kind: 'check' after at least one recorded response -> accepted.
  const valid = verifyApiBefore({
    before: { ok: false, api: [call], apiRepro: { labels: ['place order'], failed: { label: 'place order', kind: 'check', matcher: 'toBe', responses: 1, message: 'Expected: 400\nReceived: 500' } } },
    after,
    healthy: true,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.pairs.length, 1);
});

async function runApiBugFixture({ specBody, baseMode = 'buggy', postComment, config = {} }) {
  let mode = 'fixed';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/orders' && req.method === 'POST') {
        res.statusCode = mode === 'buggy' ? 500 : 400;
        return res.end(JSON.stringify({ title: mode === 'buggy' ? 'Unhandled error' : 'Invalid card type' }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-ev-defects-'));
  try {
    fs.mkdirSync(path.join(root, 'e2e'));
    for (const f of ['fixtures.ts', 'demo.ts', 'video-reporter.ts']) {
      fs.copyFileSync(path.join(INSTALL, 'templates/e2e', f), path.join(root, 'e2e', f));
    }
    fs.writeFileSync(path.join(root, 'e2e/bug-1.spec.ts'), specBody);
    fs.writeFileSync(
      path.join(root, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: 'e2e', workers: 1, reporter: [['./e2e/video-reporter.ts']], use: { baseURL: process.env.BASE_URL, video: 'off' } });\n`,
    );
    fs.symlinkSync(path.join(INSTALL, 'node_modules'), path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, '.factory/plans/BUG-1-x'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.factory/plans/BUG-1-x/TC-BUG-1-01-x.md'),
      `---\nid: TC-BUG-1-01\ntype: sad\nlayer: e2e\npriority: P1\ncovers: ["AC1"]\n---\n\n# TC-BUG-1-01: Order validation\n`,
    );
    fs.mkdirSync(path.join(root, '.factory/state/board/BUG-1'), { recursive: true });
    fs.writeFileSync(path.join(root, '.factory/state/board/BUG-1/story.md'), '# BUG-1: Bad order returns 500\n');
    fs.writeFileSync(path.join(root, '.factory/state/board/BUG-1/meta.json'), JSON.stringify({ type: 'bug', issue: { number: 101, url: 'https://example.invalid/issues/101' } }));

    const published = [];
    const comments = [];
    const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}` };
    const recordCmd = `node ${JSON.stringify(path.join(INSTALL, 'node_modules/@playwright/test/cli.js'))} test -c playwright.config.ts {specs}`;
    const deps = {
      tools: resolveTools({ video: { narration: { enabled: false } } }),
      scope: { video: false, api: true },
      specs: ['e2e/bug-1.spec.ts'],
      publish: (o) => published.push(fs.readFileSync(path.join(o.stageDir, 'section.md'), 'utf8')),
      baseCheckout: () => ({ dir: 'BASE', sha: 'b45e0000aaaa1111' }),
      stackUp: async (dir) => ((mode = dir === 'BASE' ? baseMode : 'fixed'), 0),
      stackHealthy: () => true,
      stackDown: () => {},
      sh: (cmd, e) => new Promise((resolve) => spawn('sh', ['-c', cmd], { cwd: root, env: e, stdio: 'ignore' }).on('close', resolve)),
      runAgent: () => ({ ok: false, status: 1, output: '' }),
      postComment: postComment ?? ((issue, body, opts) => (comments.push({ issue, body, opts }), { id: 1, url: 'https://example.invalid/c/1', created: true })),
    };
    const r = await produceLocal({
      root,
      config: { ...config, prVideo: { specPatterns: ['e2e/*.spec.ts'], recordCmd, testTimeoutSec: 30 } },
      base: 'main',
      key: 'fix/bug-1',
      headSha: 'cafe1234',
      host: { repo: 'acme/shop', fileUrl: (f, b) => `https://host/${b}/${f}` },
      deps,
      log: () => {},
      env,
    });
    const beforeManifestFile = path.join(root, 'artifacts/e2e-videos-before/manifest.json');
    const beforeManifest = fs.existsSync(beforeManifestFile) ? JSON.parse(fs.readFileSync(beforeManifestFile, 'utf8')) : null;
    const runConditions = fs
      .readdirSync(path.join(root, '.factory'), { recursive: true })
      .filter((f) => /run-conditions/.test(String(f)))
      .map((f) => path.join(root, '.factory', String(f)))
      .filter((f) => fs.statSync(f).isFile())
      .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    return { r, published, comments, beforeManifest, runConditions };
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('D1: typo, network error, and pre-response assertion inside reproduction() fail outside the reproduction check and yield no evidence', { timeout: 120_000 }, async () => {
  // 1. Typo (TypeError) after a recorded response inside reproduction()
  const typoSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 typo inside repro', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    if (r.status() === 500) (r as any).statuz();
    expect(r.status()).toBe(400);
  });
});
`;
  const typo = await runApiBugFixture({ specBody: typoSpec });
  assert.equal(typo.r.apiEvidence[0].ok, false);
  assert.equal(typo.comments.length, 0);
  assert.match(typo.r.apiEvidence[0].why, /failed outside the reproduction check/i);
  assert.equal(typo.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'error');

  // 2. Network error inside reproduction() before any recorded response
  const netSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 network error inside repro', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const probe = await request.get('/');
    const r = await request.post(probe.ok() && (await request.post('/api/orders', { data: {} })).status() === 500 ? 'http://127.0.0.1:1/unreachable' : '/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const net = await runApiBugFixture({ specBody: netSpec });
  assert.equal(net.r.apiEvidence[0].ok, false);
  assert.equal(net.comments.length, 0);
  assert.match(net.r.apiEvidence[0].why, /failed outside the reproduction check/i);
  assert.equal(net.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'error');

  // 3. Assertion BEFORE any recorded response inside reproduction()
  const preAssertSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 assertion before response', async ({ request }) => {
  const probe = await request.post('/api/orders', { data: { cardTypeId: 99 } });
  await reproduction('Place invalid order', async () => {
    expect(probe.status()).toBe(400);
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const preAssert = await runApiBugFixture({ specBody: preAssertSpec });
  assert.equal(preAssert.r.apiEvidence[0].ok, false);
  assert.equal(preAssert.comments.length, 0);
  assert.match(preAssert.r.apiEvidence[0].why, /failed outside the reproduction check/i);
  assert.equal(preAssert.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'error');
});

test('ADV-32 (D1): a soft assertion that fails before the block records its first response is not the reproduction', { timeout: 120_000 }, async () => {
  // The precondition fails softly (500 on the base) before any response of the block; the block then records a
  // response and nothing else fails. Only a failure after the block's first response counts, so this gives no evidence.
  const spec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 soft precondition fails before any response in the block', async ({ request }) => {
  const probe = await request.post('/api/orders', { data: { cardTypeId: 1 } });
  await reproduction('Place invalid order', async () => {
    expect.soft(probe.status(), 'precondition: the order API answers').toBe(400);
    await request.post('/api/orders', { data: { cardTypeId: 99 } });
  });
});
`;
  const out = await runApiBugFixture({ specBody: spec });
  assert.equal(out.r.apiEvidence[0].ok, false, 'a soft precondition must not count as the reproduction');
  assert.equal(out.comments.length, 0);
  assert.notEqual(out.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'check');
});

test('ADV-10 (D1): rejects forged matcherResult error without posting its message; accepts expect.soft, nested reproduction(), and real check after caught error', { timeout: 300_000 }, async () => {
  // 1. Forged plain Error dressed with matcherResult -> refused, and its message never posted.
  const forgedSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 forged matcherResult', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    if (r.status() === 500) {
      throw Object.assign(new Error('ECONNRESET socket hang up'), { matcherResult: { name: 'toBe', pass: false } });
    }
    expect(r.status()).toBe(400);
  });
});
`;
  const forged = await runApiBugFixture({ specBody: forgedSpec });
  assert.equal(forged.r.apiEvidence[0].ok, false, 'forged matcherResult must be refused');
  assert.equal(forged.comments.length, 0);
  assert.equal(forged.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'error');
  assert.ok(!forged.published.at(-1).includes('ECONNRESET'), 'non-assertion error message must not be posted');

  // 2. Failing expect.soft inside reproduction() after response -> accepted as kind: check.
  const softSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 soft assertion inside repro', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect.soft(r.status()).toBe(400);
  });
});
`;
  const soft = await runApiBugFixture({ specBody: softSpec });
  assert.equal(soft.r.apiEvidence[0].ok, true, `expect.soft should be accepted, got: ${soft.r.apiEvidence[0].why}`);
  assert.equal(soft.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'check');
  assert.equal(soft.comments.length, 1);

  // 3. Assertion in nested reproduction() (outer made the call, inner asserted) -> accepted.
  const nestedSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 nested reproduction', async ({ request }) => {
  await reproduction('Outer call', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    await reproduction('Inner check', async () => {
      expect(r.status()).toBe(400);
    });
  });
});
`;
  const nested = await runApiBugFixture({ specBody: nestedSpec });
  assert.equal(nested.r.apiEvidence[0].ok, true, `nested reproduction should be accepted, got: ${nested.r.apiEvidence[0].why}`);
  assert.equal(nested.beforeManifest?.tests?.[0]?.apiRepro?.failed?.label, 'Outer call');
  assert.equal(nested.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'check');

  // 4. Real check after an earlier caught error -> accepted (earlier caught error does not poison it).
  const caughtSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 caught error then real check', async ({ request }) => {
  try {
    await reproduction('Probe', async () => { throw new Error('transient probe error'); });
  } catch {
    // caught by test
  }
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const caught = await runApiBugFixture({ specBody: caughtSpec });
  assert.equal(caught.r.apiEvidence[0].ok, true, `real check after caught error should be accepted, got: ${caught.r.apiEvidence[0].why}`);
  assert.equal(caught.beforeManifest?.tests?.[0]?.apiRepro?.failed?.label, 'Place invalid order');
  assert.equal(caught.beforeManifest?.tests?.[0]?.apiRepro?.failed?.kind, 'check');
});

test('ADV-12 (D8): proves BOTH setup-failure mechanisms independently (reporter writes manifest on in-test setup failure; beforeFailed handles pre-manifest crash)', { timeout: 120_000 }, async () => {
  // Mechanism 1: in-test setup failure -> video-reporter MUST write manifest.json even with no videos/api.
  const setupFailSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 fails in setup before any request', async ({ request }) => {
  if (process.env.TESTSTACK_ROOT === 'BASE') throw new Error('setup sign-in failed');
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const inTest = await runApiBugFixture({ specBody: setupFailSpec });
  assert.ok(inTest.beforeManifest, 'video-reporter must write manifest.json when an API-only test fails in setup');
  assert.equal(inTest.beforeManifest.tests.length, 1);
  assert.equal(inTest.beforeManifest.tests[0].ok, false);
  assert.equal(inTest.r.apiEvidence[0].ok, false);
  assert.doesNotMatch(inTest.r.apiEvidence[0].why, /did not run this case/i);
  assert.match(inTest.r.apiEvidence[0].why, /failed outside the reproduction check \(setup, sign-in or the stack\)/i);

  // Mechanism 2: pre-manifest crash (spec fails to load on BASE so no test runs and no manifest is written) -> beforeFailed handles it.
  const loadCrashSpec = `import { test, expect, reproduction } from './fixtures';
if (process.env.TESTSTACK_ROOT === 'BASE') throw new Error('spec top-level setup crash');
test('TC-BUG-1-01 crashes before running', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const preManifest = await runApiBugFixture({ specBody: loadCrashSpec });
  assert.equal(preManifest.beforeManifest, null, 'no manifest is written when spec crashes at load time');
  assert.equal(preManifest.r.apiEvidence[0].ok, false);
  assert.doesNotMatch(preManifest.r.apiEvidence[0].why, /did not run this case/i);
  assert.match(preManifest.r.apiEvidence[0].why, /setup failed before the case ran/i);
});

// ---- D6: failed ticket Reproduction comment post is recorded in PR evidence section, findings and run record ----------

test('D6: a failed Reproduction comment post reaches the PR evidence section, findings and run record without blocking', { timeout: 120_000 }, async () => {
  const validSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 reproduces bad order', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const res = await runApiBugFixture({
    specBody: validSpec,
    config: { video: { bugPair: { requireBefore: true } } },
    postComment: () => {
      throw new Error('HTTP 502 Bad Gateway');
    },
  });
  assert.equal(res.r.apiEvidence[0].ok, true);
  assert.deepEqual(res.r.apiEvidence[0].comment, { posted: false, why: 'HTTP 502 Bad Gateway' });
  assert.equal(res.r.block, null, 'a failed ticket comment post must never block delivery even when requireBefore is on');
  const finding = res.r.findings.find((f) => f.id === 'API-REPRO-COMMENT-BUG-1');
  assert.ok(finding, `expected API-REPRO-COMMENT-BUG-1 finding, got: ${JSON.stringify(res.r.findings)}`);
  assert.equal(finding.severity, 'minor');
  assert.match(finding.detail, /HTTP 502 Bad Gateway/);
  const section = res.published.at(-1);
  assert.match(section, /## Before the fix \/ After the fix[\s\S]*Reproduction comment was not posted[\s\S]*HTTP 502 Bad Gateway/i);
  const row = res.runConditions.find((x) => x.kind === 'api-reproduction' && x.ticket === 'BUG-1');
  assert.ok(row, 'api-reproduction row recorded in run-conditions.jsonl');
  assert.equal(row.commentPosted, false);
  assert.match(row.commentWhy, /HTTP 502 Bad Gateway/);
});

test('ADV-14 (D6): keeps comment-not-posted note when evidence section is scan-flagged, and reports tracker refusal-fallback reduced comments', { timeout: 120_000 }, async () => {
  const { withRefusalFallback } = await import('../../board/lib/trackers/index.mjs');
  // 1. withRefusalFallback on tracker.tickets.comment returns `reduced` when sections were dropped.
  const tracker = {
    tickets: {
      comment: (_id, body) => {
        if (body.includes('REFUSE_ME')) throw new Error('gh issue comment failed: HTTP 403: 403 Forbidden');
        return { id: 77, url: 'https://example.invalid/c/77' };
      },
    },
  };
  withRefusalFallback(tracker);
  const reducedRes = tracker.tickets.comment(101, 'Summary.\n\n## Details\n\nREFUSE_ME\n');
  assert.equal(reducedRes.id, 77);
  assert.ok(reducedRes.reduced, 'reduced metadata must be returned when refusal fallback dropped sections');
  assert.deepEqual(reducedRes.reduced.dropped, ['details']);

  // 2. End-to-end: reduced comment is noted in PR evidence section, findings, and run-conditions without blocking.
  const validSpec = `import { test, expect, reproduction } from './fixtures';
test('TC-BUG-1-01 reproduces bad order', async ({ request }) => {
  await reproduction('Place invalid order', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99 } });
    expect(r.status()).toBe(400);
  });
});
`;
  const reducedRun = await runApiBugFixture({
    specBody: validSpec,
    config: { video: { bugPair: { requireBefore: true } } },
    postComment: () => ({ id: 77, url: 'https://example.invalid/c/77', reduced: { dropped: ['reproduction'], attempts: [] } }),
  });
  assert.equal(reducedRun.r.block, null);
  assert.match(reducedRun.published.at(-1), /shortened by the tracker's refusal fallback \(dropped: reproduction\)/i);
  assert.ok(reducedRun.r.findings.some((f) => f.id === 'API-REPRO-COMMENT-REDUCED-BUG-1' && f.severity === 'minor'));
  const reducedRow = reducedRun.runConditions.find((x) => x.kind === 'api-reproduction' && x.ticket === 'BUG-1');
  assert.equal(reducedRow.commentReduced, true);

  // 3. When the evidence section itself is flagged by scanHits (so replaced by "Not shown"), the comment-not-posted note is kept.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv14-flagged-'));
  try {
    fs.mkdirSync(path.join(root, '.factory/plans/BUG-1-x'), { recursive: true });
    fs.writeFileSync(path.join(root, '.factory/plans/BUG-1-x/TC-BUG-1-01-x.md'), `---\nid: TC-BUG-1-01\ntype: sad\nlayer: e2e\npriority: P1\ncovers: ["AC1"]\n---\n\n# TC-BUG-1-01: Order\n`);
    fs.mkdirSync(path.join(root, '.factory/state/board/BUG-1'), { recursive: true });
    // Ticket title passes general redactText (no field masking) but triggers evidence scanHits on the rendered section.
    const cvcPart = ['7', '3', '9'].join('');
    fs.writeFileSync(path.join(root, '.factory/state/board/BUG-1/story.md'), `# BUG-1: reject card[cvc]=${cvcPart}\n`);
    fs.writeFileSync(path.join(root, '.factory/state/board/BUG-1/meta.json'), JSON.stringify({ type: 'bug', issue: { number: 101 } }));
    fs.mkdirSync(path.join(root, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(root, 'e2e/bug-1.spec.ts'), `reproduction('x', () => {}); // TC-BUG-1-01\n`);
    const call = { method: 'POST', url: 'http://127.0.0.1/api/orders', status: 500, repro: 'x' };
    let runNo = 0;
    const published = [];
    await produceLocal({
      root,
      config: { prVideo: { specPatterns: ['e2e/*.spec.ts'], recordCmd: 'true' } },
      base: 'main',
      key: 'fix/bug-1',
      headSha: 'cafe1234',
      host: { repo: 'acme/shop', fileUrl: (f, b) => `https://host/${b}/${f}` },
      deps: {
        tools: resolveTools({ video: { narration: { enabled: false } } }),
        scope: { video: false, api: true },
        specs: ['e2e/bug-1.spec.ts'],
        baseCheckout: () => ({ dir: 'BASE', sha: 'b45e0000' }),
        stackUp: async () => 0,
        stackHealthy: () => true,
        stackDown: () => {},
        sh: () => {
          runNo++;
          const dir = path.join(root, 'artifacts/e2e-videos');
          fs.mkdirSync(dir, { recursive: true });
          const entry = runNo === 1
            ? { title: 'TC-BUG-1-01', ok: false, api: [call], apiRepro: { labels: ['x'], failed: { label: 'x', kind: 'check', responses: 1, message: 'Expected: 400' } } }
            : { title: 'TC-BUG-1-01', ok: true, api: [{ ...call, status: 400 }] };
          fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ tests: [entry] }));
          return 0;
        },
        runAgent: () => ({ ok: false, status: 1, output: '' }),
        postComment: () => { throw new Error('HTTP 503 Unavailable'); },
        publish: (o) => published.push(fs.readFileSync(path.join(o.stageDir, 'section.md'), 'utf8')),
      },
      log: () => {},
      env: {},
    });
    const sec = published.at(-1);
    assert.match(sec, /Not shown: the scan gate flagged the recorded exchanges/i);
    assert.match(sec, /Reproduction comment was not posted on ticket BUG-1: HTTP 503 Unavailable/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
