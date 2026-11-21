// The demo fixture narrates a spec by itself (owner request, final round): a spec written with plain Playwright calls
// (page.goto, locator.click, fill, selectOption, expect) gets a viewer-language line for every action and for the
// assertions a viewer can see, worded from accessible names and roles; the video opens with what it demonstrates (test
// title and ticket) and ends with the outcome; a caption the spec writes wins for its step; the recording is 1280x720;
// a spec's own short timeout cannot cut a demo recording short; and a failed test's recording is never a demo.
// A real Playwright run against a small fixture app (the PR #363 brands page in miniature).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { probe } from '../lib/render.mjs';
import { renderRecorded } from '../lib/local.mjs';
import { resolveTools } from '../lib/tools.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function app() {
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>body{font:18px system-ui;margin:30px} article{border:1px solid #ccc;padding:8px;margin:6px;display:inline-block}</style></head><body><nav><a href="/">Shop all</a> <a href="/brands">Brands</a></nav>${body}</body></html>`;
  const brands = [['Daybird', 11], ['Gravitator', 9], ['Zest', 2]];
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/brands') {
      const list = url.searchParams.get('sort') === 'count' ? [...brands].sort((a, b) => b[1] - a[1]) : brands;
      return res.end(page('Brands', `<h1>Brands</h1><label for="sort">Sort</label> <select id="sort" onchange="location.search='?sort='+this.value"><option value="name">Name</option><option value="count"${url.searchParams.get('sort') === 'count' ? ' selected' : ''}>Most products</option></select>
        <label for="q">Search</label> <input id="q" name="q"><div>${list.map(([n, c], i) => `<a href="/?brand=${i + 1}"><article class="brand-card"><h2>${n}</h2><p>${c} products</p></article></a>`).join('')}</div>`));
    }
    return res.end(page('Catalog', `<h1>Catalog</h1><p class="count">${url.searchParams.get('brand') ? '11 products' : '101 products'}</p>`));
  });
}

const SPEC = `import { test, expect } from './demo';
test('TC-BRAND-2-01 selecting the Daybird card opens the catalog filtered to Daybird', async ({ page, demo }) => {
  test.setTimeout(1500);
  await page.goto('/brands');
  await demo.caption('Opened /brands');
  await expect(page.locator('article.brand-card')).toHaveCount(3);
  await page.getByLabel('Search').fill('Daybird');
  await page.getByLabel('Sort').selectOption('count');
  await expect(page).toHaveURL(/sort=count/);
  await demo.click(page.getByRole('link', { name: 'Brands' }), 'Back to all brands from the header');
  await page.locator('article.brand-card', { has: page.getByRole('heading', { name: 'Daybird' }) }).click();
  await expect(page).toHaveURL(/brand=1/);
  await demo.caption('Now at /?brand=1');
  await expect(page.locator('.count')).toHaveText('11 products');
  await demo.pause(2500);
});
test('TC-BRAND-2-02 a failing case is evidence, never a demo', async ({ page }) => {
  await page.goto('/brands');
  await expect(page.locator('h1')).toHaveText('Not this page', { timeout: 500 });
});
`;

const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e', workers: 1, reporter: [['./e2e/video-reporter.ts']],
  use: { baseURL: process.env.BASE_URL, viewport: { width: 800, height: 450 }, video: 'on' },
});
`;

const run = (cmd, args, opts) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, opts);
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => resolve({ status, out }));
  });

test('a plain Playwright spec is narrated in viewer language, opens with what it shows, ends with the outcome, records at 1280x720', { timeout: 300_000 }, async (t) => {
  const tools = resolveTools({ video: { narration: { enabled: false } } });
  if (!tools.ffmpeg) return t.skip('no ffmpeg (factory video install)');
  const server = app();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-'));
  try {
    fs.mkdirSync(path.join(dir, 'e2e'));
    for (const f of ['fixtures.ts', 'demo.ts', 'video-reporter.ts']) fs.copyFileSync(path.join(INSTALL, 'templates/e2e', f), path.join(dir, 'e2e', f));
    fs.writeFileSync(path.join(dir, 'e2e/brands.spec.ts'), SPEC);
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), CONFIG);
    fs.symlinkSync(path.join(INSTALL, 'node_modules'), path.join(dir, 'node_modules'));
    const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, E2E_DEMO: '1', E2E_KEEP_VIDEOS: '1', E2E_REDACT_MODULE: path.join(INSTALL, 'scripts/pipeline/lib/redact.mjs'), E2E_DEMO_PACING: JSON.stringify({ stepDelayMs: 100, holdMs: 200, typeDelayMs: 5, cursorMs: 100 }), E2E_DEMO_TIMEOUT_MS: '120000', E2E_DEMO_TICKETS: JSON.stringify({ 'BRAND-2': '[FE - WebApp] - From a brand card to that brand\'s products' }) };
    const r = await run(process.execPath, [path.join(INSTALL, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'playwright.config.ts'], { cwd: dir, env });
    assert.match(r.out, /1 failed[\s\S]*1 passed|1 passed[\s\S]*1 failed/, r.out.slice(-2000));
    const videos = path.join(dir, 'artifacts/e2e-videos');
    const manifest = JSON.parse(fs.readFileSync(path.join(videos, 'manifest.json'), 'utf8'));
    const passed = manifest.tests.find((x) => x.ok);
    assert.ok(passed, 'the spec\'s own test.setTimeout(1500) did not cut the demo recording short');
    const steps = JSON.parse(fs.readFileSync(path.join(videos, passed.steps), 'utf8'));
    const lines = steps.steps.map((s) => `${s.kind}: ${s.caption}`);
    assert.deepEqual(lines, [
      "intro: This video shows selecting the Daybird card opens the catalog filtered to Daybird. Ticket BRAND-2: From a brand card to that brand's products.",
      'auto:goto: Opened the Brands page',
      'check: 3 cards are shown.',
      'auto:type: Type “Daybird” into the Search field',
      'auto:select: Choose “Most products” in the Sort list',
      'check: Now on the Brands page, with sort count.',
      'click: Back to all brands from the header',
      'auto:click: Click the Daybird card',
      // One step, one line: the author's caption says what the URL assertion said, so only the caption is spoken.
      'caption: Now at the home page, with brand 1',
      'check: “11 products” is shown.',
      'outcome: Result: selecting the Daybird card opens the catalog filtered to Daybird, as expected.',
    ], lines.join('\n'));
    // Every user action has its line (the author's caption for the header click, automatic ones for the rest).
    assert.deepEqual(steps.actions.map((a) => [a.kind, steps.steps[a.step].kind]), [['goto', 'auto:goto'], ['fill', 'auto:type'], ['selectOption', 'auto:select'], ['click', 'click'], ['click', 'auto:click']]);
    // 1280x720, although the project's config asks for an 800x450 viewport and Playwright's default video size.
    const raw = probe(tools.ffmpeg, path.join(videos, passed.videos[0]));
    assert.deepEqual([raw.width, raw.height], [1280, 720]);
    assert.deepEqual(steps.viewport, { width: 1280, height: 720 });
    // What the narrator is given: each action's target, the page and heading before and after, and the passed checks.
    const click = steps.actions.at(-1);
    assert.deepEqual(click.target, { name: 'Daybird', role: 'card' });
    assert.equal(click.before.page, 'the Brands page');
    assert.deepEqual(click.after, { page: 'the home page, with brand 1', heading: 'Catalog' });
    assert.ok(click.at > click.t && click.end > click.at, 'the cursor sets off, the click happens, the result settles');
    assert.deepEqual(steps.checks.map((c) => c.line), ['3 cards are shown', 'Now on the Brands page, with sort count', 'Now on the home page, with brand 1', '“11 products” is shown']);

    // The failed test: kept locally as evidence, never rendered, narrated or staged for publishing.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-stage-'));
    const renderDir = path.join(dir, 'rendered');
    fs.mkdirSync(renderDir);
    const entries = renderRecorded({ videosDir: videos, stageDir: stage, renderDir, tools, log: () => {} });
    const failed = entries.find((e) => !e.ok);
    assert.ok(failed?.failed && /not a demo; it is kept on the machine/.test(failed.blocked));
    assert.ok(fs.existsSync(failed.kept), 'the raw recording stays as evidence');
    assert.ok(!fs.readdirSync(stage).some((f) => /brand-2-02|failing/.test(f)), 'nothing of it is staged');
    assert.ok(!fs.readdirSync(renderDir).some((f) => /failing/.test(f)), 'nothing of it is rendered');
    const good = entries.find((e) => e.ok);
    assert.equal(good.quality?.ok, true, JSON.stringify(good.quality));
  } finally {
    server.close();
  }
});

// A pin of 0.2.87 was refused by the test repository's pre-commit lint (an unused `_`-named binding in e2e/fixtures.ts):
// the templates render writes into every repository pass the TypeScript lint pack those repositories run.
test('the shipped e2e templates pass the lint pack a repository runs on them', () => {
  const files = ['fixtures.ts', 'demo.ts', 'video-reporter.ts'].map((f) => path.join(INSTALL, 'templates/e2e', f));
  return run(process.execPath, [path.join(INSTALL, 'packs/typescript/lint/eslint.mjs'), ...files], { cwd: INSTALL }).then((r) => assert.equal(r.status, 0, r.out));
});
