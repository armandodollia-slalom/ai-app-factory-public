// Video evidence for the PR check: find the videos, download linked ones, and turn each into a set of
// frame images the video critic can look at. Frames come from ffmpeg when it is installed, otherwise
// from Playwright's Chromium, which plays the file and screenshots it at each timestamp.
/* global document -- used inside page.evaluate callbacks, which run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { download, videoLinks } from './github.mjs';
import { log, run } from '../../pipeline/lib/util.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';

const isUrl = (s) => /^https?:\/\//i.test(s);

function filesUnder(dir, extensions) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && extensions.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

// Explicit --videos values win; otherwise links in the PR body, then the default folders
// (Playwright's test-results/ when tests ran with video recording on).
export function videoSources(config, { values = [], prBody = '', caseIds = [] } = {}) {
  const { extensions, defaultDirs } = config.prCheck.video;
  const sources = [];
  const missing = [];
  const addPath = (p) => {
    const abs = path.resolve(config.root, p);
    if (!fs.existsSync(abs)) return missing.push({ source: p, reason: 'file or folder not found' });
    if (fs.statSync(abs).isDirectory()) for (const f of filesUnder(abs, extensions)) sources.push({ source: path.relative(config.root, f).replace(/\\/g, '/'), file: f });
    else sources.push({ source: p, file: abs });
  };
  for (const value of values) {
    if (isUrl(value)) sources.push({ source: value, url: value });
    else addPath(value);
  }
  for (const url of videoLinks(prBody, extensions)) sources.push({ source: url, url });
  if (values.length === 0 && sources.length === 0) {
    // The first default folder that holds videos (the e2e video reporter's artifacts/e2e-videos, where feature
    // verification keeps its verified tests' videos, before Playwright's test-results/), narrowed to the
    // story's own test cases when any video names one: stale videos of other tests are not evidence for it.
    for (const dir of defaultDirs) {
      if (!fs.existsSync(path.join(config.root, dir))) continue;
      const before = sources.length;
      addPath(dir);
      if (sources.length > before) break;
    }
    const ids = caseIds.map((c) => String(c).toLowerCase()).filter(Boolean);
    // None of the story's: other tests' videos are not evidence for it (council C4: a backend bug's check listed
    // unrelated cart and checkout videos), so none is used.
    if (ids.length) {
      const own = sources.filter((s) => ids.some((id) => path.basename(s.source).toLowerCase().includes(id)));
      if (!own.length && sources.length) missing.push({ source: defaultDirs.join(', '), reason: `none of the ${sources.length} video(s) there is of this story's test cases (${caseIds.join(', ')})` });
      sources.splice(0, sources.length, ...own);
    }
  }
  return { sources, missing };
}

const hasCmd = (cmd) => run(cmd, ['-version']).status === 0;

function timestamps(duration, { maxFrames, minIntervalSec }) {
  const count = Math.max(1, Math.min(maxFrames, Math.floor(duration / minIntervalSec) + 1));
  if (count === 1) return [duration / 2];
  const end = Math.max(0, duration - 0.05);
  return Array.from({ length: count }, (_, i) => Math.round(((i * end) / (count - 1)) * 100) / 100);
}

// One frame per narrated step (the middle of each step), from the video's subtitles (`<name>.vtt`, a rendered demo
// video) or the demo fixture's step log (`<name>.steps.json`, a raw recording): a slower video does not get more frames.
// More steps than the cap: evenly chosen. null when the video has neither.
export function stepTimes(file, { maxFrames, framesPerStep = defaultSettings().prCheck.video.framesPerStep } = {}) {
  const base = file.replace(/\.(webm|mp4)$/i, '');
  let spans = null;
  if (fs.existsSync(`${base}.vtt`)) {
    const sec = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);
    spans = [...fs.readFileSync(`${base}.vtt`, 'utf8').matchAll(/(\d+):(\d+):([\d.]+) --> (\d+):(\d+):([\d.]+)/g)].map((m) => [sec(m[1], m[2], m[3]), sec(m[4], m[5], m[6])]);
  } else if (fs.existsSync(`${base}.steps.json`)) {
    try {
      spans = (JSON.parse(fs.readFileSync(`${base}.steps.json`, 'utf8')).steps ?? []).filter((s) => s.t1 > s.t0).map((s) => [s.t0 / 1000, s.t1 / 1000]);
    } catch {
      spans = null;
    }
  }
  if (!spans?.length) return null;
  const per = Math.max(1, Math.floor(framesPerStep));
  const all = spans.flatMap(([a, b]) => Array.from({ length: per }, (_, k) => Math.round((a + ((k + 1) * (b - a)) / (per + 1)) * 100) / 100));
  if (all.length <= maxFrames) return all;
  return Array.from({ length: maxFrames }, (_, i) => all[Math.floor((i * all.length) / maxFrames)]);
}

function ffmpegFrames(file, outDir, options) {
  const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const duration = Number(probe.stdout.trim());
  if (!(duration > 0)) throw new Error(`ffprobe could not read the duration: ${probe.stderr.trim() || probe.stdout.trim()}`);
  const frames = (options.times ?? timestamps(duration, options)).map((t, i) => {
    const out = path.join(outDir, `frame-${String(i + 1).padStart(3, '0')}.png`);
    const result = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${options.width}:-2`, out]);
    if (result.status !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg failed at ${t}s: ${result.stderr.trim()}`);
    return { file: out, t };
  });
  return { duration, frames };
}

async function loadChromium() {
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    try {
      const mod = await import(name);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch {
      // try the next package
    }
  }
  throw new Error('neither ffmpeg nor Playwright is available to read videos (run `npm ci` and `npx playwright install chromium`, or install ffmpeg)');
}

async function browserFrames(file, outDir, options) {
  const chromium = await loadChromium();
  const player = path.join(outDir, 'player.html');
  fs.writeFileSync(player, `<!doctype html><body style="margin:0;background:#000"><video id="v" muted preload="auto" src="${pathToFileURL(file).href}" style="width:100%;display:block"></video></body>`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: options.width, height: Math.round((options.width * 9) / 16) } });
    await page.goto(pathToFileURL(player).href);
    const duration = await page.evaluate(async () => {
      const v = document.getElementById('v');
      await new Promise((resolve, reject) => {
        if (v.readyState >= 1) return resolve();
        v.onloadedmetadata = resolve;
        v.onerror = () => reject(new Error(v.error?.message || 'the browser cannot decode this video'));
      });
      // Recorded WebM files (Playwright, MediaRecorder) report no duration until the end has been seeked.
      if (!Number.isFinite(v.duration)) {
        await new Promise((resolve) => {
          v.ontimeupdate = () => {
            v.ontimeupdate = null;
            resolve();
          };
          v.currentTime = 1e101;
        });
      }
      return v.duration;
    });
    if (!(duration > 0)) throw new Error('the video has no duration');
    const frames = [];
    for (const [i, t] of (options.times ?? timestamps(duration, options)).entries()) {
      await page.evaluate(
        (time) =>
          new Promise((resolve) => {
            const v = document.getElementById('v');
            v.onseeked = () => resolve();
            v.currentTime = time;
          }),
        t,
      );
      const out = path.join(outDir, `frame-${String(i + 1).padStart(3, '0')}.png`);
      await page.locator('#v').screenshot({ path: out });
      frames.push({ file: out, t });
    }
    return { duration, frames };
  } finally {
    await browser.close();
    fs.rmSync(player, { force: true });
  }
}

// Returns frames.json content: every readable video with its frames (paths relative to `relativeTo`,
// the agents' working directory) and every source that could not be read, with the reason.
// Frames per video under a budget for all of a PR's videos (`prCheck.video.maxTotalFrames`; at least
// `minFramesPerVideo`): the video critic reads every frame, and 48 frames for each of six videos made it the most expensive
// step of a PR check (council C3, cost: $2.80-3.70 a round).
export function framesPerVideo(options, count) {
  const total = options.maxTotalFrames;
  return Math.max(options.minFramesPerVideo, Math.min(options.maxFrames, Math.floor(total / Math.max(1, count))));
}

export async function extractVideoFrames(config, runDir, { sources, missing }, relativeTo = config.root) {
  const options = { ...config.prCheck.video, maxFrames: framesPerVideo(config.prCheck.video, sources.length) };
  const useFfmpeg = hasCmd('ffmpeg') && hasCmd('ffprobe');
  const videos = [];
  const unreadable = [...missing];
  for (const [i, source] of sources.entries()) {
    const dir = path.join(runDir, 'videos', String(i + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    try {
      let file = source.file;
      if (source.url) {
        const ext = path.extname(new URL(source.url).pathname).toLowerCase();
        file = path.join(dir, `video${options.extensions.includes(ext) ? ext : '.mp4'}`);
        await download(source.url, file, config);
      }
      if (source.url) {
        // A rendered demo video's subtitles sit next to it: one frame per step instead of one per interval.
        const vtt = source.url.replace(/\.(webm|mp4)(\?|$)/i, '.vtt$2');
        if (vtt !== source.url) await download(vtt, file.replace(/\.(webm|mp4)$/i, '.vtt'), config).catch(() => {});
      }
      const times = stepTimes(file, { maxFrames: options.maxFrames, framesPerStep: options.framesPerStep });
      const opts = times ? { ...options, times } : options;
      const { duration, frames } = useFfmpeg ? ffmpegFrames(file, dir, opts) : await browserFrames(file, dir, opts);
      videos.push({
        source: source.source,
        duration: Math.round(duration * 100) / 100,
        extractor: useFfmpeg ? 'ffmpeg' : 'chromium',
        sampling: times ? 'per step' : 'per interval',
        frames: frames.map((f) => ({ file: path.relative(relativeTo, f.file).replace(/\\/g, '/'), t: f.t })),
      });
      log(`video ${source.source}: ${frames.length} frames over ${Math.round(duration)}s`);
    } catch (error) {
      unreadable.push({ source: source.source, reason: error.message });
      log(`video ${source.source} could not be read: ${error.message}`);
    }
  }
  return { videos, unreadable };
}
