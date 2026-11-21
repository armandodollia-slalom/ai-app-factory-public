// Headline demos narrated from the narrator's script, evidence videos collapsed, and a UI bug's pair: "Before the fix"
// recorded against the application built from the merge base (here: the fixture app switched to its buggy mode when
// the base's stack comes up), used only when it fails at the check the "After the fix" recording passes. Real
// Playwright runs of the shipped e2e templates, the real renderer, a scripted narrator (no live model).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { produceLocal } from '../lib/local.mjs';
import { checkCues, parseVtt } from '../lib/render.mjs';
import { resolveTools } from '../lib/tools.mjs';
import { scriptedNarrator } from './narrator-stub.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let mode = 'fixed';

function app() {
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>body{font:18px system-ui;margin:30px} article{border:1px solid #ccc;padding:8px;margin:6px;display:inline-block}</style></head><body><nav><a href="/">Shop all</a> <a href="/brands">Brands</a></nav>${body}</body></html>`;
  const brands = [['Daybird', 11], ['Gravitator', 9]].filter(([n]) => !(mode === 'early' && n === 'Daybird'));
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/brands') return res.end(page('Brands', `<h1>Brands</h1><div>${(mode === 'early' ? brands.slice(1) : brands).map(([n, c], i) => `<a href="/?brand=${i + 1}"><article class="brand-card"><h2>${n}</h2><p>${c} products</p></article></a>`).join('')}</div>`));
    const n = url.searchParams.get('brand') ? (mode === 'buggy' ? 0 : 11) : 101;
    return res.end(page('Catalog', `<h1>${url.searchParams.get('brand') ? 'Brand: Daybird' : 'Catalog'}</h1><p class="count">${n} products</p>`));
  });
}

const BRAND_SPEC = `import { test, expect } from './demo';
test('TC-BRAND-2-01 selecting the Daybird card opens the catalog filtered to Daybird', async ({ page, demo: _demo }) => {
  await page.goto('/brands');
  await page.locator('article.brand-card', { has: page.getByRole('heading', { name: 'Daybird' }) }).click();
  await expect(page.locator('h1')).toHaveText('Brand: Daybird');
});
test('TC-BRAND-2-03 the Brands link in the header opens the Brands page', async ({ page, demo: _demo }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Brands' }).click();
  await expect(page.locator('h1')).toHaveText('Brands');
});
`;
const BUG_SPEC = `import { test, expect } from './demo';
test('TC-BUG-7-00 the Brands page still lists the brands', async ({ page, demo: _demo }) => {
  await page.goto('/brands');
  await expect(page.locator('h1')).toHaveText('Brands');
});
test('TC-BUG-7-01 the Daybird card lists its products', async ({ page, demo: _demo }) => {
  await page.goto('/brands');
  await page.locator('article.brand-card', { has: page.getByRole('heading', { name: 'Daybird' }) }).click();
  await expect(page.locator('.count')).toHaveText('11 products', { timeout: 3000 });
});
`;
const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'e2e', workers: 1, reporter: [['./e2e/video-reporter.ts']], use: { baseURL: process.env.BASE_URL, video: 'on' } });
`;
const PLAN = (id, fm) => `---\nid: ${id}\ntype: happy\nlayer: e2e\npriority: ${fm.priority ?? 'P1'}\ncovers: ${fm.covers ?? '["AC1"]'}\n---\n\n# ${id}: ${fm.title}\n\n## Why\n\n- ${fm.why ?? 'it is the point of the ticket'}\n`;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-pair-'));
  fs.mkdirSync(path.join(dir, 'e2e'));
  for (const f of ['fixtures.ts', 'demo.ts', 'video-reporter.ts']) fs.copyFileSync(path.join(INSTALL, 'templates/e2e', f), path.join(dir, 'e2e', f));
  fs.writeFileSync(path.join(dir, 'e2e/brand-2.spec.ts'), BRAND_SPEC);
  fs.writeFileSync(path.join(dir, 'e2e/bug-7.spec.ts'), BUG_SPEC);
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), CONFIG);
  fs.symlinkSync(path.join(INSTALL, 'node_modules'), path.join(dir, 'node_modules'));
  const plan = (folder, id, fm) => {
    fs.mkdirSync(path.join(dir, '.factory/plans', folder), { recursive: true });
    fs.writeFileSync(path.join(dir, '.factory/plans', folder, `${id}-x.md`), PLAN(id, fm));
  };
  plan('BRAND-2-x', 'TC-BRAND-2-01', { title: 'Selecting the Daybird card opens the catalog filtered to Daybird', covers: '["AC1","AC2"]' });
  plan('BRAND-2-x', 'TC-BRAND-2-03', { title: 'The Brands link in the header opens the Brands page' });
  // Ranked first (P1) but passes on the base too: the pair must use the case that reproduces the bug (P2 here).
  plan('BUG-7-x', 'TC-BUG-7-00', { title: 'The Brands page still lists the brands' });
  plan('BUG-7-x', 'TC-BUG-7-01', { title: 'The Daybird card lists its products', priority: 'P2' });
  const ticket = (key, text, meta) => {
    fs.mkdirSync(path.join(dir, '.factory/state/board', key), { recursive: true });
    fs.writeFileSync(path.join(dir, '.factory/state/board', key, 'story.md'), text);
    fs.writeFileSync(path.join(dir, '.factory/state/board', key, 'meta.json'), JSON.stringify(meta));
  };
  ticket('BRAND-2', '# BRAND-2: From a brand card to that brand\'s products\n\n## Acceptance criteria\n\n- Selecting a brand card opens the catalog filtered to that brand.\n', { type: 'story' });
  ticket('BUG-7', '# BUG-7: The Daybird card shows no products\n\n## Acceptance criteria\n\n- Selecting the Daybird card lists its products.\n', { type: 'bug' });
  return dir;
}

async function deliver(root, server, { baseMode, config = {}, scope = { video: true, api: false }, stub = scriptedNarrator() }) {
  const published = [];
  const stackRoots = [];
  const tools = resolveTools({ video: { narration: { enabled: false } } });
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const deps = {
    tools,
    scope,
    specs: ['e2e/brand-2.spec.ts', 'e2e/bug-7.spec.ts'],
    publish: (o) => published.push({ ...o, section: fs.readFileSync(path.join(o.stageDir, 'section.md'), 'utf8'), files: fs.readdirSync(o.stageDir) }),
    baseCheckout: () => ({ dir: 'BASE', sha: 'abc1234def5678' }),
    stackUp: async (dir) => ((mode = dir === 'BASE' ? baseMode : 'fixed'), 0),
    stackHealthy: () => true,
    stackDown: () => {},
    // Asynchronous: the fixture app answers from this process.
    sh: (cmd, e) => (stackRoots.push(e.TESTSTACK_ROOT ?? null), new Promise((resolve) => spawn('sh', ['-c', cmd], { cwd: root, env: e, stdio: 'ignore' }).on('close', resolve))),
    runAgent: stub.runAgent,
  };
  const recordCmd = `node ${JSON.stringify(path.join(INSTALL, 'node_modules/@playwright/test/cli.js'))} test -c playwright.config.ts {specs}`;
  const r = await produceLocal({ root, config: { ...config, prVideo: { specPatterns: ['e2e/*.spec.ts'], recordCmd, testTimeoutSec: 45 } }, base: 'main', key: 'fix/bug-7', headSha: 'f00dfeed', host: { repo: 'acme/shop', fileUrl: (f, b) => `https://host/${b}/${f}` }, deps, log: () => {}, env: { ...env, E2E_DEMO_PACING: JSON.stringify({ stepDelayMs: 80, holdMs: 250, typeDelayMs: 5, cursorMs: 80 }) } });
  return { r, published, stub, stackRoots };
}

test('a UI bug that reproduces: "Before the fix" and "After the fix" under its ticket, first; the story\'s headline narrated by the agent; evidence collapsed', { timeout: 600_000 }, async (t) => {
  if (!resolveTools({}).ffmpeg) return t.skip('no ffmpeg (factory video install)');
  const server = app();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = repo();
  try {
    const { r, published, stub, stackRoots } = await deliver(root, server, { baseMode: 'buggy' });
    // The before run's own stack calls (a scenario load) go to the base's stack, the after run's to the branch's.
    assert.deepEqual(stackRoots, ['BASE', null]);
    assert.equal(r.video, 'published');
    assert.deepEqual(r.findings, []);
    assert.equal(r.block, null);
    const byPair = (side) => r.entries.find((e) => e.pair?.key === 'BUG-7' && e.pair.side === side);
    assert.ok(byPair('before')?.video, JSON.stringify(r.entries.map((e) => [e.title, e.blocked, e.missing])));
    assert.ok(byPair('after')?.video);
    assert.match(byPair('after').title, /^TC-BUG-7-01 /, 'the case that fails on the base and passes on the fix, not the higher-ranked one that passes on both');
    assert.ok(r.entries.some((e) => /^TC-BUG-7-00 /.test(e.title) && !e.pair && !e.headline), 'the other bug case is evidence');
    assert.deepEqual([byPair('before').narrator.by, byPair('after').narrator.by], ['agent', 'agent']);
    // One narrator run wrote every headline script: the pair (each naming the other) and the story's main case.
    assert.equal(stub.calls.length, 1);
    assert.match(stub.tasks[0], /BEFORE THE FIX recording of a bug[\s\S]*went wrong \(the bug, as recorded\)[\s\S]*the screen shows “0 products”/);
    assert.match(stub.tasks[0], /AFTER THE FIX recording of a bug; video v\d is the same flow before the fix/);
    assert.ok(!/## Video v\d[^#]*TC-BRAND-2-03/.test(stub.tasks[0]), 'evidence videos get no script');
    // The before video says the problem as recorded, and its cues follow the rule.
    const beforeVtt = fs.readFileSync(byPair('before').renderedVtt, 'utf8');
    assert.match(beforeVtt, /the problem appears/);
    assert.deepEqual(checkCues(parseVtt(beforeVtt)), []);
    // The section: the pair under its ticket at the top, the story's headline next, the evidence collapsed below.
    const section = published.at(-1).section;
    const at = (re) => section.search(re);
    assert.ok(at(/### BUG-7: The Daybird card shows no products/) > 0);
    assert.ok(at(/#### ✅ Before the fix/) > at(/### BUG-7/) && at(/#### ✅ After the fix/) > at(/#### ✅ Before the fix/));
    assert.ok(at(/### ✅ TC-BRAND-2-01/) > at(/#### ✅ After the fix/));
    assert.ok(at(/<details><summary>Evidence: 2 more test-case video/) > at(/### ✅ TC-BRAND-2-01/));
    assert.ok(at(/TC-BRAND-2-03/) > at(/<details>/));
    assert.match(section, /silent with subtitles: an evidence video/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a UI bug that does not reproduce on the base, or fails earlier: no before video, the reason, a finding; blocking only when the setting says so', { timeout: 600_000 }, async (t) => {
  if (!resolveTools({}).ffmpeg) return t.skip('no ffmpeg (factory video install)');
  const server = app();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = repo();
  try {
    const same = await deliver(root, server, { baseMode: 'fixed', config: { video: { bugPair: { requireBefore: true } } } });
    const missing = same.r.entries.find((e) => e.pair?.side === 'before');
    assert.match(missing.missing, /none of its 2 browser cases failed at its check on the base \(TC-BUG-7-00: the bug does not reproduce on the base: the reproduction check passed before the fix; TC-BUG-7-01: the bug does not reproduce/);
    assert.deepEqual(same.r.findings.map((f) => f.id), ['DEMO-NO-REPRO-BUG-7']);
    assert.match(same.r.block, /could not be shown before the fix .* video\.bugPair\.requireBefore is on/);
    assert.match(same.published.at(-1).section, /#### Before the fix\n\nNot shown: none of its 2 browser cases failed at its check on the base \(TC-BUG-7-00: the bug does not reproduce on the base: the reproduction check passed before the fix; TC-BUG-7-01: the bug does not reproduce on the base/);
    assert.ok(same.r.entries.some((e) => e.pair?.side === 'after' && e.video), 'the after video is still published');

    const early = await deliver(root, server, { baseMode: 'early' });
    // In the "early" base the Daybird card is missing: the reproducing case fails at its click, the other passes.
    const earlyWhy = early.r.entries.find((e) => e.pair?.side === 'before').missing;
    assert.match(earlyWhy, /TC-BUG-7-01: the before run failed at an earlier step \(the click action after 1 action\(s\)\), not at the reproduction check\)$/);
    assert.ok(fs.existsSync(path.join(root, 'artifacts/e2e-videos-before/manifest.json')));
    const beforeManifest = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/e2e-videos-before/manifest.json'), 'utf8'));
    const t1 = beforeManifest.tests.find((x) => /TC-BUG-7-01/.test(x.title));
    const log1 = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/e2e-videos-before', t1.steps), 'utf8'));
    assert.deepEqual([log1.failed.kind, log1.failed.what, log1.failed.actionsBefore], ['action', 'click', 1], 'the earlier failure is recorded as the click after one action');
    assert.equal(early.r.findings.length, 1);
    assert.equal(early.r.block, null, 'not blocking by default');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a backend-only bug gets no demo video, and the PR says so; a required before video holds the delivery', async () => {
  const root = repo();
  const { r, published } = await deliver(root, { address: () => ({ port: 1 }) }, { baseMode: 'buggy', scope: { video: false, api: true }, stub: scriptedNarrator({ fail: () => assert.fail('no narrator for a backend-only change') }) });
  assert.equal(r.video, null);
  assert.match(published.at(-1).section, /No demo video: this change has no browser-visible part \(backend only\)/);
  fs.rmSync(root, { recursive: true, force: true });
  const src = fs.readFileSync(path.join(INSTALL, 'scripts/implement/lib/implement.mjs'), 'utf8');
  assert.match(src, /if \(video\?\.block\) return notFinished\(\{ outcome: 'demo-video-blocked'/, 'the delivery opens no PR when the setting makes a missing before video block');
});

test('the base checkout: a worktree of the merge base, kept by commit, its stack images tagged with the commit', async () => {
  const { baseCheckout } = await import('../lib/bugpair.mjs');
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-checkout-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ project: { name: 'shop' }, stack: { poolSize: 2 } }));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n');
  fs.mkdirSync(path.join(dir, '.factory/stack/scenarios/default'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.factory/stack/scenarios/default/scenario.yaml'), 'name: default\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const sha = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'fix');
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'fixed');
  fs.mkdirSync(path.join(dir, '.factory/stack/scenarios/bug-9'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.factory/stack/scenarios/bug-9/scenario.yaml'), 'name: bug-9\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'fix');
  const first = baseCheckout(dir, 'main');
  assert.equal(first.sha, sha);
  assert.equal(first.dir, path.join(dir, '.factory/state/demo-base', sha.slice(0, 12)));
  assert.ok(!fs.existsSync(path.join(first.dir, 'fix.txt')), 'the base, without the fix');
  assert.ok(fs.existsSync(path.join(first.dir, '.factory/stack/scenarios/bug-9/scenario.yaml')), 'with the branch\'s scenarios (the reproduction loads the bug\'s own)');
  const cfg = JSON.parse(fs.readFileSync(path.join(first.dir, '.factory/config.json'), 'utf8'));
  assert.deepEqual(cfg.stack, { poolSize: 2, imageTag: `shop-teststack-base-${sha.slice(0, 12)}` });
  fs.writeFileSync(path.join(first.dir, 'marker'), 'kept');
  const again = baseCheckout(dir, 'main');
  assert.equal(again.dir, first.dir);
  assert.ok(fs.existsSync(path.join(again.dir, 'marker')), 'a re-run reuses the checkout of the same commit');
  fs.rmSync(dir, { recursive: true, force: true });
});
