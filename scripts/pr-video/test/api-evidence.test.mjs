// A backend bug's evidence (owner requirement): the reproduction case's requests, recorded by `reproduction()` of the
// shared fixtures, run against the merge base (where they must fail at the check) and the fix; the ticket gets one
// "Reproduction" comment edited in place, the PR a "Before the fix / After the fix" section, with the requests and
// responses verbatim from the recording, redacted, credentials masked by name, large bodies truncated. Real Playwright
// runs against a fixture service, a scripted narrator for the wording (no live model).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanExchange, evidenceSection, validateProse } from '../lib/api-evidence.mjs';
import { produceLocal } from '../lib/local.mjs';
import { resolveTools } from '../lib/tools.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// A token of the shape a code host issues, made at run time (never a literal in the repository).
const canary = () => ['gh', 'p_', ...[...crypto.randomBytes(36)].map((b) => abc[b % abc.length])].join('');
const TOKEN = canary();
// Above 2^53: JSON.parse reads it as 90071992547409940.
const BIG_INT = '90071992547409931';
let mode = 'fixed';

function app() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (url.pathname === '/api/orders' && req.method === 'POST') {
        res.setHeader('content-type', 'application/problem+json');
        res.setHeader('x-internal-trace', 'node-7.internal');
        if (mode === 'buggy') {
          res.statusCode = 500;
          // An integer above 2^53 (JSON.parse rounds it) and a duplicate key: the evidence shows them as sent.
          // Over the evidence's size limit, under the recorder's (a payment body the recorder cuts is withheld).
          return res.end(JSON.stringify({ title: 'An unhandled error occurred', detail: `NullReferenceException in CardTypeLookup (caller ${TOKEN})`, token: TOKEN, trace: 'x'.repeat(2000) }).replace('{"title"', `{"orderRef":${BIG_INT},"status":500,"status":"failed","title"`));
        }
        res.statusCode = 400;
        return res.end(JSON.stringify({ title: 'One or more validation errors occurred.', errors: { CardTypeId: ['The card type is not one the shop accepts.'] } }));
      }
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/checkout') return res.end(`<!doctype html><html><body><h1>Checkout</h1><p class="message">${mode === 'buggy' ? 'Something went wrong' : 'Choose a card the shop accepts'}</p></body></html>`);
      return res.end('<!doctype html><html><body><h1>Shop</h1></body></html>');
    });
  });
}

const SPEC = `import { test, expect } from './demo';
import { reproduction } from './fixtures';
test('TC-BUG-8-01 an order with a card type the shop does not know is refused', async ({ request }) => {
  const created = await request.get('/');
  expect(created.status()).toBe(200);
  await reproduction('Place an order with card type 99', async () => {
    const r = await request.post('/api/orders', { data: { cardTypeId: 99, buyer: 'alice' }, headers: { Authorization: 'Bearer ' + process.env.E2E_CANARY, 'content-type': 'application/json' } });
    expect(r.status()).toBe(400);
  });
});
test('TC-BUG-8-02 the checkout page says which cards the shop accepts', async ({ page, demo: _demo }) => {
  await page.goto('/checkout');
  await expect(page.locator('.message')).toHaveText('Choose a card the shop accepts', { timeout: 3000 });
});
`;
const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'e2e', workers: 1, reporter: [['./e2e/video-reporter.ts']], use: { baseURL: process.env.BASE_URL, video: 'on' } });
`;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-evidence-'));
  fs.mkdirSync(path.join(dir, 'e2e'));
  for (const f of ['fixtures.ts', 'demo.ts', 'video-reporter.ts']) fs.copyFileSync(path.join(INSTALL, 'templates/e2e', f), path.join(dir, 'e2e', f));
  fs.writeFileSync(path.join(dir, 'e2e/bug-8.spec.ts'), SPEC);
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), CONFIG);
  fs.symlinkSync(path.join(INSTALL, 'node_modules'), path.join(dir, 'node_modules'));
  const plan = (id, title) => {
    fs.mkdirSync(path.join(dir, '.factory/plans/BUG-8-x'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.factory/plans/BUG-8-x', `${id}-x.md`), `---\nid: ${id}\ntype: sad\nlayer: e2e\npriority: P1\ncovers: ["AC1"]\n---\n\n# ${id}: ${title}\n\n## Preconditions\n\n- The demo user alice is signed in; the seeded card types are 1, 2 and 3.\n`);
  };
  plan('TC-BUG-8-01', 'An order with an unknown card type is refused');
  plan('TC-BUG-8-02', 'The checkout page says which cards the shop accepts');
  fs.mkdirSync(path.join(dir, '.factory/state/board/BUG-8'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.factory/state/board/BUG-8/story.md'), '# BUG-8: Placing an order with a card type the shop does not know answers 500\n\n## Acceptance criteria\n\n- The order is refused with 400 and nothing is placed.\n');
  fs.writeFileSync(path.join(dir, '.factory/state/board/BUG-8/meta.json'), JSON.stringify({ type: 'bug', issue: { number: 808, url: 'https://example.invalid/issues/808' } }));
  return dir;
}

const goodProse = (task) => {
  const keys = [...task.matchAll(/## Bug (\S+)/g)].map((m) => m[1]);
  return { bugs: keys.map((key) => ({ key, preconditions: 'Sign in as the demo user alice; the shop accepts card types 1, 2 and 3.', steps: ['Place an order that names a card type the shop does not know.'], wrong: ['The base answers 500, an error, where the ticket asks for 400 and nothing placed.'], difference: ['The status changes from 500 to 400, with a validation problem for CardTypeId.'] })) };
};

async function deliver(root, server, { baseMode, scope = { video: false, api: true }, prose = goodProse, config = {} }) {
  const published = [];
  const comments = [];
  const tasks = [];
  const events = [];
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, E2E_CANARY: TOKEN };
  const deps = {
    tools: resolveTools({ video: { narration: { enabled: false } } }),
    scope,
    specs: ['e2e/bug-8.spec.ts'],
    publish: (o) => published.push(fs.readFileSync(path.join(o.stageDir, 'section.md'), 'utf8')),
    baseCheckout: () => ({ dir: 'BASE', sha: 'b45e0000aaaa1111', created: true }),
    stackUp: async (dir) => ((mode = dir === 'BASE' ? baseMode : 'fixed'), 0),
    stackHealthy: () => true,
    stackDown: () => events.push('down'),
    removeBase: (r) => events.push(['remove-base', r]),
    sh: (cmd, e) => new Promise((resolve) => spawn('sh', ['-c', cmd], { cwd: root, env: e, stdio: 'ignore' }).on('close', resolve)),
    runAgent: (cfg, opts) => {
      tasks.push(opts.task);
      const answer = /Describe the reproduction/.test(opts.task) ? prose(opts.task, tasks.length) : { videos: [] };
      return { ok: true, status: 0, output: `AGENT_RESULT: ${JSON.stringify(answer)}`, usage: { costUsd: 0.01 } };
    },
    postComment: (issue, body, opts) => (comments.push({ issue, body, opts }), { id: 1, url: 'https://example.invalid/c/1', created: comments.length === 1 }),
  };
  const recordCmd = `node ${JSON.stringify(path.join(INSTALL, 'node_modules/@playwright/test/cli.js'))} test -c playwright.config.ts {specs}`;
  // The exchanges' bodies are checked here: the masking mode (the default withholds a payment exchange's bodies).
  const r = await produceLocal({ root, config: { video: { apiEvidence: { paymentBodies: 'mask' } }, ...config, prVideo: { specPatterns: ['e2e/*.spec.ts'], recordCmd, testTimeoutSec: 45 } }, base: 'main', key: 'fix/bug-8', headSha: 'cafe1234', host: { repo: 'acme/shop', fileUrl: (f, b) => `https://host/${b}/${f}` }, deps, log: () => {}, env: { ...env, E2E_DEMO_PACING: JSON.stringify({ stepDelayMs: 50, holdMs: 150, typeDelayMs: 5, cursorMs: 50 }) } });
  return { r, published, comments, tasks, events };
}

const everything = (root, x) => [JSON.stringify(x.r), ...x.published, ...x.comments.map((c) => c.body), ...x.tasks, ...fs.readdirSync(path.join(root, '.factory/state/demo-videos/branch-fix-bug-8')).map((f) => fs.readFileSync(path.join(root, '.factory/state/demo-videos/branch-fix-bug-8', f), 'utf8'))].join('\n');

test('a backend bug that reproduces: the ticket\'s Reproduction comment and the PR\'s Before/After section, exchanges verbatim, secrets masked, large bodies cut', { timeout: 600_000 }, async () => {
  const server = app();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = repo();
  try {
    const x = await deliver(root, server, { baseMode: 'buggy' });
    assert.deepEqual(x.r.findings, []);
    assert.deepEqual(x.r.apiEvidence.map((e) => [e.key, e.ok, e.case, e.prose, e.comment.posted]), [['BUG-8', true, 'TC-BUG-8-01', 'agent', true]]);
    // The before run's base checkout and its images go as soon as its stack is down (prune.mjs planBaseCheckouts).
    assert.deepEqual(x.events.slice(0, 2), ['down', ['remove-base', root]]);
    // One comment, on the ticket's issue, found by its hidden marker (edited in place on the next delivery).
    assert.equal(x.comments.length, 1);
    const c = x.comments[0];
    assert.equal(c.issue, 808);
    assert.equal(c.opts.marker, '<!-- factory:reproduction:BUG-8 -->');
    assert.match(c.body, /^<!-- factory:reproduction:BUG-8 -->\n## Reproduction/);
    assert.match(c.body, /1\. Sign in as the demo user alice/);
    assert.match(c.body, /2\. Place an order that names a card type/);
    // Verbatim from the recording: the request line and body, the base's response.
    assert.match(c.body, /POST \/api\/orders\n {3}Authorization: \(masked\)\n {3}content-type: application\/json/);
    assert.match(c.body, /"cardTypeId": 99/);
    assert.match(c.body, /HTTP 500\n {3}content-type: application\/problem\+json/);
    assert.match(c.body, /What is wrong: The base answers 500/);
    // Only the reproduction's calls (not the setup GET), the path only (no host), no header outside the allow-list.
    assert.ok(!/GET \/\n/.test(c.body) && !/127\.0\.0\.1|host\.invalid|x-internal-trace|node-7/.test(c.body));
    // Credentials masked by name, the canary nowhere: comment, section, records, the narrator's task, state files.
    assert.match(c.body, /Authorization: \(masked\)/);
    assert.match(c.body, /"token": ?"\(masked\)"/);
    // The response as it was received: the large integer to its last digit, both duplicate keys, no reformatting.
    assert.ok(c.body.includes(`{"orderRef":${BIG_INT},"status":500,"status":"failed","title":"An unhandled error occurred"`), c.body);
    assert.ok(!everything(root, x).includes(TOKEN), 'the canary is in nothing stored, posted or sent to the agent');
    const runConditions = fs.readdirSync(path.join(root, '.factory'), { recursive: true }).filter((f) => /run-conditions/.test(String(f)));
    for (const f of runConditions) assert.ok(!fs.statSync(path.join(root, '.factory', String(f))).isFile() || !fs.readFileSync(path.join(root, '.factory', String(f)), 'utf8').includes(TOKEN));
    // A body over the limit is cut, with its size stated.
    assert.match(c.body, /… \(truncated: \d+ bytes in all, \d+ not shown\)/);
    // The PR: before and after responses of the same request, and the difference.
    const section = x.published.at(-1);
    assert.match(section, /## Demo video\n\nNo demo video: this change has no browser-visible part \(backend only\)/);
    assert.match(section, /## Before the fix \/ After the fix\n\n### BUG-8: Placing an order with a card type the shop does not know answers 500/);
    assert.match(section, /Before the fix:\n\n```\nHTTP 500[\s\S]*After the fix:\n\n```\nHTTP 400[\s\S]*The card type is not one the shop accepts/);
    assert.match(section, /\*\*What changed:\*\* The status changes from 500 to 400/);
    // The layout never puts a credential word straight before a hash-like value.
    assert.ok(!/(token|key|secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_.~-]{16,}/i.test(`${section}\n${c.body}`));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prose that quotes a status, body or value the recording does not hold is refused; then the plain wording is used', () => {
  const ex = (status, body) => cleanExchange({ method: 'POST', url: 'http://h/api/orders', status, responseBody: body, responseHeaders: { 'content-type': 'application/json' } });
  const pairs = [{ before: ex(500, '{"title":"boom"}'), after: ex(400, '{"title":"Bad Request"}') }];
  const ok = { preconditions: 'Sign in as the demo user.', steps: ['Place the order.'], wrong: ['It answers 500 with "boom", an error.'], difference: ['500 becomes 400, "Bad Request".'] };
  assert.deepEqual(validateProse(ok, pairs), []);
  assert.match(validateProse({ ...ok, wrong: ['It answers 503, an error.'] }, pairs).join('\n'), /quotes the status 503, which no recorded response has/);
  assert.match(validateProse({ ...ok, difference: ['Now it says "Order refused".'] }, pairs).join('\n'), /quotes "Order refused", which the recording does not hold/);
  assert.match(validateProse({ ...ok, steps: ['Call https://shop.example/api/orders as in TC-BUG-8-01.'] }, pairs).join('\n'), /a host, a ticket key or a test-case id/);
  // A large body is cut and says by how much; the PR caps the pairs shown and collapses the rest.
  const big = cleanExchange({ method: 'GET', url: '/x', status: 200, responseBody: 'y'.repeat(5000) }, { headers: [], maxBodyBytes: 100 });
  assert.match(big.responseBody, /\(truncated: 5000 bytes in all, 4900 not shown\)$/);
  const many = { key: 'FIX-1', ev: { ok: true, pairs: Array.from({ length: 5 }, () => pairs[0]) }, prose: { steps: Array(5).fill('Step.'), difference: Array(5).fill('Diff.') } };
  const s = evidenceSection([many], { maxPairs: 3 });
  assert.equal((s.match(/Before the fix:/g) ?? []).length, 5);
  assert.match(s, /<details><summary>2 more request\(s\)<\/summary>/);
  assert.ok(s.indexOf('**5.**') < s.indexOf('**1.**'), 'the reproduction\'s failing call (the last) first');
});

test('a backend bug that does not reproduce on the base: no evidence, the reason and a finding; a bug with both sides gets both', { timeout: 600_000 }, async (t) => {
  if (!resolveTools({}).ffmpeg) return t.skip('no ffmpeg (factory video install)');
  const server = app();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = repo();
  try {
    const same = await deliver(root, server, { baseMode: 'fixed', prose: (task) => goodProse(task) });
    assert.equal(same.comments.length, 0, 'nothing is posted without a reproduction');
    assert.match(same.r.apiEvidence[0].why, /TC-BUG-8-01: the bug does not reproduce on the base/);
    assert.deepEqual(same.r.findings.map((f) => f.id), ['API-NO-REPRO-BUG-8']);
    assert.match(same.published.at(-1), /### BUG-8: [^\n]*\n\nNo before evidence: none of its 2 reproduction cases failed/);
    // A wording that quotes what the recording does not hold, twice: the plain wording, from the recording only.
    // The change also has a frontend part: the UI case gets its before/after videos too.
    const both = await deliver(root, server, { baseMode: 'buggy', scope: { video: true, api: true }, prose: (task) => ({ bugs: goodProse(task).bugs.map((b) => ({ ...b, wrong: ['It answers 418.'] })) }) });
    assert.equal(both.r.apiEvidence[0].prose, 'automatic');
    assert.match(both.comments[0].body, /What is wrong: It answers 500; after the fix the same request answers 400\./);
    const before = both.r.entries.find((e) => e.pair?.side === 'before');
    assert.ok(before?.video, JSON.stringify(both.r.entries.map((e) => [e.title, e.missing, e.blocked])));
    assert.match(before.title, /TC-BUG-8-02/);
    const section = both.published.at(-1);
    assert.ok(section.indexOf('#### ✅ Before the fix') < section.indexOf('## Before the fix / After the fix'), 'the videos, then the requests');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
