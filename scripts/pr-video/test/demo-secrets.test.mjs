// No secret may be visible or audible in a demo video (owner requirement): proof on a real recording. A fixture app
// shows a canary token in a form field, in page text, in the URL and on an error page; the shipped e2e fixtures
// (templates/e2e) record it in demo mode with the factory's detector, and the renderer re-checks and covers it.
// Asserted: the canary is absent from the subtitles, the narration text and the per-step visible-text log, and the
// regions the renderer covers hide the canary's bounding boxes in the rendered frames (and the live cover already in the
// recording), while the page around each box stays visible. The gate fails closed on a match it cannot cover.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { probe, renderVideo, secretCheck, timeline } from '../lib/render.mjs';
import { automaticScript, recordedEvents, scriptVideos, stepListForAgent } from '../lib/script.mjs';
import { scriptedNarrator } from './narrator-stub.mjs';
import { resolveTools } from '../lib/tools.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// A token of the shape a code host issues, made at run time (never a literal in the repository).
const canary = () => ['gh', 'p_', ...[...crypto.randomBytes(36)].map((b) => abc[b % abc.length])].join('');

function app(token) {
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>body{font:20px system-ui;margin:40px}</style></head><body>${body}</body></html>`;
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') return res.end(page('Settings', `<h1>Settings</h1><label for="t">API token</label> <input id="t" name="apiToken" size="50"><p id="leak" style="margin-top:60px">Your current token is ${token}</p>`));
    if (url.pathname === '/search') return res.end(page('Search', `<h1>Search</h1><p id="results">No results</p>`));
    res.statusCode = 500;
    return res.end(page('Error', `<h1>Unhandled exception</h1><pre id="trace">at TokenService.Validate(token: ${token})\n   at Program.Main()</pre>`));
  });
}

const SPEC = `import { test, expect } from './demo';
import fs from 'node:fs';
const T = process.env.E2E_CANARY_TOKEN!;
const box = async (page, sel) => { const b = await page.locator(sel).boundingBox(); return b && { x: b.x, y: b.y, w: b.width, h: b.height }; };
test('the canary never shows', async ({ page, demo }) => {
  test.setTimeout(240_000);
  const truth = {};
  await page.goto('/');
  await demo.caption('Open the settings page');
  await demo.fill(page.getByLabel('API token'), T, { caption: 'Paste the token ' + T });
  truth.field = await box(page, '#t');
  await demo.caption('The page shows the token ' + T);
  truth.leak = await box(page, '#leak');
  await demo.pause(600);
  await page.goto('/search?q=' + T);
  await demo.caption('Search for it');
  await expect(page.locator('#results')).toBeVisible();
  await page.goto('/error');
  await demo.caption('The error page');
  truth.trace = await box(page, '#trace');
  await demo.pause(600);
  // Raw Playwright calls, narrated by the fixture itself: the typed value, the address and the asserted text hold the canary.
  await page.goto('/');
  await page.getByLabel('API token').fill(T);
  await expect(page.locator('#leak')).toContainText(T);
  await page.goto('/search?q=' + T);
  await expect(page.locator('#results')).toHaveText('No results');
  fs.writeFileSync(process.env.E2E_TRUTH_FILE!, JSON.stringify(truth));
});
`;

const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e', workers: 1, reporter: [['./e2e/video-reporter.ts']],
  use: { baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 720 }, video: { mode: 'on', size: { width: 1280, height: 720 } } },
});
`;

// Gray pixels of a region of one frame (raw, 8 bits), via ffmpeg.
function region(ffmpeg, file, t, b) {
  const crop = `crop=${Math.max(8, Math.round(b.w))}:${Math.max(8, Math.round(b.h))}:${Math.round(b.x)}:${Math.round(b.y)},format=gray`;
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

test('a canary in a field, page text, the URL and an error page is absent from the subtitles, narration and visible-text log, and covered in the frames', { timeout: 300_000 }, async (t) => {
  const tools = resolveTools({ video: { narration: { enabled: false } } });
  if (!tools.ffmpeg) return t.skip('no ffmpeg (factory video install)');
  const token = canary();
  const server = app(token);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-secrets-'));
  try {
    fs.mkdirSync(path.join(dir, 'e2e'));
    for (const f of ['fixtures.ts', 'demo.ts', 'video-reporter.ts']) fs.copyFileSync(path.join(INSTALL, 'templates/e2e', f), path.join(dir, 'e2e', f));
    fs.writeFileSync(path.join(dir, 'e2e/canary.spec.ts'), SPEC);
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), CONFIG);
    fs.symlinkSync(path.join(INSTALL, 'node_modules'), path.join(dir, 'node_modules'));
    const truthFile = path.join(dir, 'truth.json');
    const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, E2E_CANARY_TOKEN: token, E2E_TRUTH_FILE: truthFile, E2E_DEMO: '1', E2E_KEEP_VIDEOS: '1', E2E_REDACT_MODULE: path.join(INSTALL, 'scripts/pipeline/lib/redact.mjs'), E2E_DEMO_PACING: JSON.stringify({ stepDelayMs: 150, holdMs: 400, typeDelayMs: 5, cursorMs: 150 }) };
    const run = await new Promise((resolve) => {
      const child = spawnSyncAsync(process.execPath, [path.join(INSTALL, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'playwright.config.ts'], { cwd: dir, env });
      child.then(resolve);
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-3000));
    const videos = path.join(dir, 'artifacts/e2e-videos');
    const manifest = JSON.parse(fs.readFileSync(path.join(videos, 'manifest.json'), 'utf8'));
    const entry = manifest.tests[0];
    assert.ok(entry.steps, 'the step log is saved next to the video');
    const stepsText = fs.readFileSync(path.join(videos, entry.steps), 'utf8');
    const steps = JSON.parse(stepsText);
    assert.ok(!stepsText.includes(token), 'the per-step visible-text log, captions and masks never hold the canary');
    assert.ok(steps.visible.some((v) => /\[redacted:/.test(v.text)), 'the page text and URL were seen and redacted');
    assert.ok(steps.masks.some((m) => m.why === 'secret field'), 'the typed secret field is covered');
    assert.deepEqual(steps.unmasked, []);
    // The automatic narration (5a extended to it): every raw action has a line, the typed secret is "(hidden)", and no
    // automatic line, assertion line or address holds the canary (stepsText above includes them all).
    assert.equal(steps.steps[0].kind, 'intro');
    assert.match(steps.steps[0].caption, /^This video shows the canary never shows\./);
    assert.ok(steps.steps.some((x) => x.kind === 'auto:type' && /^Type the API token \(hidden\)$/.test(x.caption)), steps.steps.map((x) => x.caption).join(' | '));
    assert.ok(steps.steps.some((x) => x.kind === 'auto:goto' && /^Open the Search page, with q a hidden value$/.test(x.caption)), steps.steps.map((x) => `${x.kind}: ${x.caption}`).join(' | '));
    assert.ok(steps.steps.some((x) => x.kind === 'check' && /“No results” is shown/.test(x.caption)));
    assert.ok(steps.actions.length >= 5 && steps.actions.every((a) => a.step >= 0 && steps.steps[a.step]?.caption), 'every action has a narrated line');
    assert.equal(steps.steps.at(-1).kind, 'outcome');

    const out = path.join(dir, 'out');
    const report = renderVideo({ video: path.join(videos, entry.videos[0]), steps, outDir: out, name: 'canary', tools, env: { ...process.env, E2E_CANARY_TOKEN: token } });
    assert.equal(report.ok, true, report.reason);
    assert.equal(report.narration, null);
    assert.match(report.narrationWhyOff, /narration is off/);
    const vtt = fs.readFileSync(path.join(out, 'canary.vtt'), 'utf8');
    assert.ok(!vtt.includes(token), 'subtitles');
    assert.match(vtt, /Paste the token ••••••/, "a typed secret is dots in its caption");
    assert.match(vtt, /shows the token \[redacted:/, "a secret in a caption is redacted");
    // The narration text is the subtitles' text, redacted again: none holds the canary.
    for (const s of steps.steps) assert.ok(!s.caption.includes(token), 'narration text');
    assert.deepEqual(secretCheck({ vtt, narrationTexts: steps.steps.map((s) => ({ id: s.i, text: s.caption })), steps }).ok, true);

    // Frames: each canary's box is covered (dark) in the rendered video, and not blank in the raw recording.
    const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
    const raw = path.join(videos, entry.videos[0]);
    const rendered = path.join(out, report.video);
    // The renderer's own timeline: where each line starts in the rendered video and which recorded moment it shows.
    const segs = timeline(automaticScript(steps, recordedEvents(steps)), probe(tools.ffmpeg, raw).seconds);
    const startOf = (caption) => {
      const g = segs.find((x) => x.text.startsWith(caption));
      if (!g) throw new Error(`no step ${caption}`);
      const p = g.pieces[0];
      const off = p.freeze != null ? 0.3 : Math.min(0.3, p.dur / 2);
      // The live cover in the recording: checked at the step's own start, as the fixture logged it.
      const step = steps.steps.find((x) => x.caption.startsWith(caption));
      return { rendered: g.start + off, raw: step.t0 / 1000 + 0.3 };
    };
    for (const [what, caption] of [['field', 'The page shows the token'], ['leak', 'The page shows the token'], ['trace', 'The error page']]) {
      const b = truth[what];
      assert.ok(b, `${what} box`);
      const at = startOf(caption);
      const hidden = region(tools.ffmpeg, rendered, at.rendered, b);
      const live = region(tools.ffmpeg, raw, at.raw, b);
      // The strip just above the box, in the same rendered frame: the page is still there (the cover is local).
      const above = region(tools.ffmpeg, rendered, at.rendered, { x: b.x, y: Math.max(0, b.y - 30), w: b.w, h: 16 });
      const max = (buf) => buf.reduce((m, v) => Math.max(m, v), 0);
      assert.ok(max(hidden) < 60, `${what}: the rendered frame's region is covered (max gray ${max(hidden)})`);
      assert.ok(max(live) < 60, `${what}: the live cover is in the recording itself too (max gray ${max(live)})`);
      assert.ok(max(above) > 150, `${what}: the page around the cover is visible (max gray ${max(above)})`);
    }

    // 5a for the narrator: the step list it is given, the script it writes, the subtitles and the spoken text never hold
    // the canary. Its task is built from the redacted step log; a narrator that writes the canary anyway (as if it had
    // seen it elsewhere) is refused by validation twice and the video keeps the automatic lines.
    const honest = scriptedNarrator();
    const ok = scriptVideos({ root: dir, config: {}, videos: [{ name: 'canary', title: 'TC-SEC-1-01 the canary never shows', steps }], runAgent: honest.runAgent, cases: [], env: { ...process.env, E2E_CANARY_TOKEN: token } });
    assert.ok(!honest.tasks.join('\n').includes(token), 'the step list given to the agent');
    assert.ok(!JSON.stringify(stepListForAgent(recordedEvents(steps))).includes(token));
    assert.ok(ok.scripts.canary, JSON.stringify(ok.fallback));
    const scripted = renderVideo({ video: raw, steps, outDir: out, name: 'canary-script', tools, script: ok.scripts.canary, env: { ...process.env, E2E_CANARY_TOKEN: token } });
    assert.equal(scripted.ok, true, scripted.reason);
    assert.ok(!fs.readFileSync(path.join(out, 'canary-script.vtt'), 'utf8').includes(token), 'subtitles of the scripted video');
    assert.ok(!JSON.stringify(scripted.lines).includes(token), 'spoken text of the scripted video');
    const leaky = scriptedNarrator({ write: (v) => ({ id: v.id, segments: [{ role: 'opening', text: `The token is ${token} today.` }, ...v.steps.filter((x) => !x.what.startsWith('check') && x.what !== 'shows').map((x, i) => ({ role: 'walk', text: `Next, the user carries on ${'with care '.repeat(i % 3)}here.`, from: x.id })), { role: 'close', text: 'That is all.' }] }) });
    const refused = scriptVideos({ root: dir, config: {}, videos: [{ name: 'canary', title: 'TC-SEC-1-01 the canary never shows', steps }], runAgent: leaky.runAgent, cases: [] });
    assert.equal(refused.scripts.canary, undefined);
    assert.match(refused.fallback.canary, /failed validation twice \([\s\S]*segment 1 \(opening\) contains something the secret detector flags \(github-pat\)/);
    assert.ok(!refused.fallback.canary.includes(token) && !leaky.tasks[1].includes(token), 'the errors sent back and the reason in the PR never repeat it');
  } finally {
    server.close();
    if (process.env.KEEP_DEMO_DIR) console.log(`kept ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a match the fixture could not cover, or a caption the detector missed, keeps the video unpublished', () => {
  const token = canary();
  const steps = { steps: [{ i: 0, caption: 'ok', t0: 0, t1: 1000 }], visible: [], masks: [], unmasked: [{ t: 10, step: 0, where: 'canvas', rules: ['github-pat'] }] };
  const a = secretCheck({ vtt: 'WEBVTT\n', steps });
  assert.equal(a.ok, false);
  assert.match(a.hits[0].where, /could not be covered/);
  const b = secretCheck({ vtt: `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nThe token ${token}\n`, steps: { ...steps, unmasked: [] } });
  assert.equal(b.ok, false);
  assert.ok(!JSON.stringify(b).includes(token), 'the check names rules, never the value');
  // renderVideo stops before encoding and says why.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-gate-'));
  const tools = resolveTools({ video: { narration: { enabled: false } } });
  if (!tools.ffmpeg) return;
  const video = path.join(dir, 'v.webm');
  spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2', '-c:v', 'libvpx', video]);
  const r = renderVideo({ video, steps, outDir: dir, name: 'held', tools });
  assert.deepEqual([r.ok, r.published], [false, false]);
  assert.match(r.reason, /not published/);
  assert.ok(!fs.existsSync(path.join(dir, 'held.webm')), 'nothing to publish was written');
});

// spawnSync without blocking the event loop (the fixture app answers the browser meanwhile).
function spawnSyncAsync(cmd, args, opts) {
  return import('node:child_process').then(
    ({ spawn }) =>
      new Promise((resolve) => {
        const c = spawn(cmd, args, opts);
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d) => (stdout += d));
        c.stderr.on('data', (d) => (stderr += d));
        c.on('close', (status) => resolve({ status, stdout, stderr }));
      }),
  );
}
