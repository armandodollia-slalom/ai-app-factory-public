// The local renderer: the video follows a narration script (the narrator's, or the automatic lines), each line is spoken
// from the start of its segment and its subtitle stays until it has been spoken and a little longer, cues never overlap,
// several small actions in one sentence are spread across it, the subtitles are drawn by the renderer from the same cues
// as the .vtt (the 0.2.88 opening line left the screen after 1.5 s while its 12.9 s line was still spoken), a silent
// video with subtitles when narration is off, and the PR check's video critic sampling one frame per step.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assText, checkCues, cuesOf, parseVtt, probe, qualityGate, readingSeconds, renderVideo, timeline, vttText } from '../lib/render.mjs';
import { automaticScript, recordedEvents } from '../lib/script.mjs';
import { resolveTools } from '../lib/tools.mjs';
import { stepTimes } from '../../pr-check/lib/video.mjs';

const steps = { version: 1, viewport: { width: 320, height: 240 }, pacing: { cursorMs: 300, holdMs: 400 }, steps: [{ i: 0, kind: 'intro', caption: 'This video shows the bag. Ticket BAG-1.', t0: 0, t1: 500 }, { i: 1, kind: 'auto:click', caption: 'Click the Bag link', t0: 500, t1: 1500, auto: true }, { i: 2, kind: 'caption', caption: 'Each line shows when it was added', t0: 1500, t1: 2500 }], actions: [{ t: 600, at: 900, end: 1400, kind: 'click', step: 1 }], checks: [], masks: [{ x: 10, y: 10, w: 50, h: 20, t0: 0, t1: 3000, why: 'secret field' }], visible: [], unmasked: [] };
const auto = (log) => automaticScript(log, recordedEvents(log));

test('every cue lasts until its line has been spoken and a little longer, and no cue overlaps or cuts off the next', () => {
  const audio = { s0: 4.2, s1: 1.1, s2: 2.6 };
  const segs = timeline(auto(steps), 3, audio);
  const cues = cuesOf(segs);
  assert.equal(cues.length, 3);
  cues.forEach((c, i) => {
    assert.ok(c.end >= c.audioEnd + 0.25, `cue ${i + 1} ends ${c.end} before its audio ${c.audioEnd} + 0.25`);
    if (cues[i + 1]) assert.ok(cues[i + 1].start >= c.end - 1e-9, `cue ${i + 1} overlaps the next`);
  });
  assert.deepEqual(checkCues(cues, { durationSec: segs.at(-1).end }), []);
  // The written .vtt reads back to the same cues.
  const back = parseVtt(vttText(cues));
  back.forEach((c, i) => assert.ok(Math.abs(c.end - cues[i].end) < 0.002 && Math.abs(c.start - cues[i].start) < 0.002));
  // Without audio a line lasts its reading time plus the pause; the pause is configurable.
  assert.ok(Math.abs(timeline(auto(steps), 3)[1].dur - Math.max(readingSeconds('Click the Bag link') + 0.6, 0.5)) < 0.01);
  assert.ok(Math.abs(timeline(auto(steps), 3, { s1: 2.5 }, { pauseSec: 0.2 })[1].dur - 2.7) < 0.01);
  // checkCues names each way a cue can fail.
  const bad = checkCues([{ start: 0, end: 3, text: 'a', audioEnd: 3.1 }, { start: 2.5, end: 4, text: 'b', audioEnd: null }, { start: 4, end: 9, text: 'c', audioEnd: 5 }], { durationSec: 6 });
  for (const re of [/cue 1 .* before its line is spoken/, /cue 1 .* overlaps the next/, /cue 1 .* cut off by the next/, /last cue ends .* after the video/]) assert.ok(bad.some((f) => re.test(f)), `${re}: ${bad.join('; ')}`);
});

test('the 0.2.88 opening line: its subtitle now lasts as long as it is spoken (replay of the epic journey step log)', () => {
  // EPIC-359-01 as recorded at 0.2.88: the opening step 0..1.893 s, then the first navigation; the opening line took
  // 12.86 s to speak. 0.2.88 drew the line into the recording for 1.5 s (a chapter card) and held the step's last
  // frame, which already showed the next page: the text left the screen 11 s before the voice ended.
  const log = { version: 1, pacing: { cursorMs: 600, holdMs: 1500 }, steps: [
    { i: 0, kind: 'intro', caption: 'This video shows header Brands link, Daybird card to its filtered catalog, then "All brands" back to the Brands page.', t0: 0, t1: 1893 },
    { i: 1, kind: 'auto:goto', caption: 'Opened the home page', t0: 1893, t1: 4142, auto: true },
    { i: 2, kind: 'check', caption: '“101 products” is shown.', t0: 4142, t1: 5275, auto: true },
  ], actions: [{ t: 2617, kind: 'goto', step: 1 }] };
  const segs = timeline(auto(log), 6, { s0: 12.864, s1: 1.24, s2: 1.88 });
  const [opening] = cuesOf(segs);
  assert.equal(opening.start, 0);
  assert.ok(opening.end >= 12.864 + 0.25, `the opening cue ends at ${opening.end}`);
  // The opening shows the first page (the navigation plays, then its result is held), not the empty page before it.
  assert.ok(segs[0].pieces.some((x) => x.a != null && x.a >= 2.6), JSON.stringify(segs[0].pieces));
  // The burned-in subtitles are the same cues: the opening is drawn from 0 to its cue's end.
  assert.match(assText(cuesOf(segs)), new RegExp(`Dialogue: 0,0:00:00\\.00,0:00:${String(Math.floor(opening.end)).padStart(2, '0')}\\.\\d\\d,Default,,0,0,0,,This video shows header Brands link`));
});

test('several small actions in one sentence are spread across it, the result stays on screen, and checks are folded', () => {
  const log = { version: 1, steps: [{ i: 0, kind: 'intro', caption: 'Opening.', t0: 0, t1: 100 }], actions: [
    { t: 1000, at: 1600, end: 2600, kind: 'click', step: 0 },
    { t: 2600, at: 3200, end: 4200, kind: 'fill', step: 0 },
    { t: 20000, at: 20600, end: 21600, kind: 'click', step: 0 },
  ], checks: [{ t: 9000, step: 0, line: 'x' }] };
  const events = recordedEvents(log);
  const seg = { id: 'g1', role: 'walk', text: 'One long sentence that covers three small actions and what they lead to.', events: events.filter((e) => e.category === 'action'), auto: false };
  const [g] = timeline([seg], 30, { g1: 9 });
  const wins = g.pieces.filter((x) => x.a != null);
  const holds = g.pieces.filter((x) => x.freeze != null);
  assert.equal(wins.length, 2, 'the two adjacent actions play as one stretch, the third as another; the wait between is cut');
  assert.equal(holds.length, 2, 'each stretch is followed by its result held on screen');
  assert.ok(Math.abs(holds[0].dur - holds[1].dur) < 1e-9, 'the remaining time is shared evenly');
  assert.ok(Math.abs(g.dur - 9.6) < 1e-6, 'the segment lasts its line plus the pause');
  assert.ok(!g.pieces.some((x) => x.a != null && x.a < 9.3 && x.b > 9.0), 'the check with nothing to see is not played');
});

test('quality gate: opening line, a line for every action, audio when narrated, burned-in subtitles in step with the voice, no repeated line, secrets passed', () => {
  const segs = timeline(auto(steps), 3, { s0: 1.5, s1: 2.5, s2: 0.2 });
  const cues = cuesOf(segs);
  const events = recordedEvents(steps);
  const total = segs.reduce((n, g) => n + g.dur, 0);
  assert.deepEqual(qualityGate({ steps, segs, cues, events, narrationWanted: true, narrated: true, audioStream: true, durationSec: total, secret: { ok: true } }), { ok: true, failures: [] });
  const silentSegs = segs.map((g, i) => (i === 0 ? { ...g, role: 'walk' } : i === 1 ? { ...g, events: [] } : g));
  const bad = qualityGate({ steps, segs: silentSegs, cues, events, narrationWanted: true, narrated: false, audioStream: false, durationSec: total + 5, secret: { ok: false }, burnedIn: false });
  for (const re of [/no opening line/, /1 of 1 user action\(s\) have no narrated line \(click\)/, /narration is on but the video has no narration/, /subtitles cover .* but the video lasts/, /secret gate did not pass/, /could not be drawn into the video/]) assert.ok(bad.failures.some((f) => re.test(f)), `${re}: ${bad.failures.join('; ')}`);
  const cut = qualityGate({ steps, segs, cues: cues.map((c, i) => (i === 1 ? { ...c, end: c.audioEnd - 0.5 } : c)), events, narrationWanted: true, narrated: true, audioStream: true, durationSec: null, secret: { ok: true } });
  assert.ok(cut.failures.some((f) => /before its line is spoken/.test(f)), cut.failures.join('; '));
  const twice = qualityGate({ steps, segs: segs.map((g, i) => (i === 2 ? { ...g, text: segs[1].text } : g)), cues, events, narrationWanted: false, narrated: false, audioStream: false, durationSec: null, secret: { ok: true } });
  assert.ok(twice.failures.some((f) => /repeats the line before it/.test(f)));
  assert.ok(qualityGate({ steps: { ...steps, actions: undefined }, segs, cues, events, narrationWanted: false, narrated: false, audioStream: false, durationSec: total, secret: { ok: true } }).failures.some((f) => /no action log/.test(f)));
});

function sample(dir, seconds, source = 'testsrc=s=320x240') {
  const tools = resolveTools({});
  const video = path.join(dir, 'raw.webm');
  spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `${source}:d=${seconds}`, '-c:v', 'libvpx', video]);
  return { tools, video };
}

test('narration on: the rendered video carries audio and every step is held for it', { timeout: 300_000 }, (t) => {
  const tools = resolveTools({});
  if (!tools.ffmpeg) return t.skip('no ffmpeg (factory video install)');
  if (!tools.narration) return t.skip(`no narration: ${tools.narrationWhyOff}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  // A white page, so the only dark pixels at the bottom are the subtitle's.
  const { video } = sample(dir, 3, 'color=c=white:s=320x240');
  const r = renderVideo({ video, steps: { ...steps, masks: [] }, outDir: dir, name: 'n', tools });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.audio, true);
  assert.ok(r.narration?.voice);
  const work = path.join(dir, 'n.report.json');
  assert.ok(fs.existsSync(work));
  // Three spoken lines last longer than the three short steps: the video grew to hold them, and the gate checked it.
  assert.ok(r.durationSec > 3.5, `duration ${r.durationSec}`);
  assert.deepEqual(r.quality, { ok: true, failures: [] });
  assert.deepEqual(r.lines.map((l) => l.role), ['opening', 'walk', 'walk']);
  // The rule on the file that is published: every cue lasts until its line has been spoken (and 0.25 s more).
  const written = parseVtt(fs.readFileSync(path.join(dir, 'n.vtt'), 'utf8'));
  written.forEach((c, i) => assert.ok(c.end >= r.lines[i].start + r.lines[i].audioSec + 0.25 - 0.002, `cue ${i + 1}`));
  // The subtitle is drawn into the video: at the end of the opening line, the bottom centre shows the dark subtitle box.
  assert.equal(r.burnedIn, true);
  const at = r.lines[0].start + r.lines[0].audioSec - 0.05;
  const darkest = (sec) => Math.min(...spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(sec), '-i', path.join(dir, r.video), '-frames:v', '1', '-vf', 'crop=iw/2:ih/5:iw/4:ih*0.8,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' }).stdout);
  assert.ok(darkest(at) < 128, `the subtitle box is drawn at ${at.toFixed(2)} s, when the opening line ends`);
  const streams = spawnSync(tools.ffmpeg, ['-hide_banner', '-i', path.join(dir, r.video)], { encoding: 'utf8' }).stderr;
  assert.match(streams, /Audio: opus/);
  assert.match(fs.readFileSync(path.join(dir, 'n.vtt'), 'utf8'), /Click the Bag link/);
});

test('narration off: a silent video with subtitles, and the reason', (t) => {
  const tools = resolveTools({ video: { narration: { enabled: false } } });
  if (!tools.ffmpeg) return t.skip('no ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const { video } = sample(dir, 3);
  const r = renderVideo({ video, steps, outDir: dir, name: 's', tools });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.audio, false);
  assert.match(r.narrationWhyOff, /narration is off/);
  assert.ok(r.durationSec >= readingSeconds(steps.steps[1].caption) + readingSeconds(steps.steps[2].caption));
  assert.equal(r.quality.ok, true, 'narration off is allowed: silent with subtitles');
  assert.ok(probe(tools.ffmpeg, path.join(dir, r.video)).seconds > 0);
});

test('the PR check video critic takes one frame per step, however slow the video', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-'));
  const cues = (k, len) => `WEBVTT\n\n${Array.from({ length: k }, (_, i) => `${i + 1}\n00:00:${String(i * len).padStart(2, '0')}.000 --> 00:00:${String((i + 1) * len).padStart(2, '0')}.000\nstep ${i}`).join('\n\n')}\n`;
  fs.writeFileSync(path.join(dir, 'fast.vtt'), cues(5, 2));
  fs.writeFileSync(path.join(dir, 'slow.vtt'), cues(5, 9));
  const fast = stepTimes(path.join(dir, 'fast.webm'), { maxFrames: 24 });
  const slow = stepTimes(path.join(dir, 'slow.webm'), { maxFrames: 24 });
  assert.equal(fast.length, 5);
  assert.equal(slow.length, 5, 'the same number of frames for a video four times slower');
  assert.deepEqual(slow.slice(0, 2), [4.5, 13.5], 'the middle of each step');
  assert.equal(stepTimes(path.join(dir, 'none.webm'), { maxFrames: 24 }), null, 'no subtitles or step log: the interval sampling applies');
  fs.writeFileSync(path.join(dir, 'many.vtt'), cues(40, 1).replace(/00:00:(\d\d)/g, (m, s) => `00:${String(Math.floor(Number(s) / 60)).padStart(2, '0')}:${String(Number(s) % 60).padStart(2, '0')}`));
  assert.equal(stepTimes(path.join(dir, 'many.webm'), { maxFrames: 24 }).length, 24, 'capped');
});
