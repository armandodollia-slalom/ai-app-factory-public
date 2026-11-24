// Renders a recorded demo video on the machine that runs the pipeline. The video follows a narration script
// (script.mjs: the demo-narrator agent's script for a headline demo, else the automatic per-step lines): each segment is
// spoken (optional), the recorded moments it narrates play while it is spoken and the rest is cut (timeline below), the
// regions the demo fixture covered are drawn over the recorded frames for their whole time window, the subtitles are
// drawn into the video and written as a `.vtt` from the same cues, then a fail-closed secret gate and the quality gate
// check everything a viewer could read or hear (docs/ai-pipeline/pr-demo-video.md).
//
// Inputs are the Playwright video and the fixture's step log (e2e/demo.ts, `<video>.steps.json`). In demo mode the
// fixture draws no caption into the recording: a caption drawn there follows the recording's timing, and a held or cut
// stretch then shows it too briefly or not at all (the 0.2.88 opening line left the screen after 1.5 s of a 13 s line).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genericHits, redactText, writeText } from '../../pipeline/lib/redact.mjs';
import { stepRecord } from '../../pipeline/lib/util.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';
import { automaticScript, recordedEvents } from './script.mjs';

const NARRATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'narrate.py');

// Seconds a viewer needs to read a caption without audio: about three words a second, at least two seconds.
export const readingSeconds = (text) => Math.max(2, String(text ?? '').split(/\s+/).filter(Boolean).length / 3 + 1);

const vttTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

// Duration and frame size of a video, from ffmpeg itself (a Playwright WebM may not state its duration).
export function probe(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 600_000 });
  const err = `${r.stderr ?? ''}`;
  const size = /Stream #0:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(err);
  const times = [...err.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  const stated = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const toS = (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return { width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, seconds: last ? toS(last) : stated ? toS(stated) : null, audio: /Stream #0:\d+.*Audio:/.test(err) };
}

// ---- the timeline ------------------------------------------------------------------------------------------------
//
// A script's segments become the rendered video's timeline. Each segment is spoken from its start; it lasts as long as
// its line is spoken plus a pause (`pauseSec`), or as long as the recorded moments it shows, whichever is longer. The
// moments are the windows of its events in the recording: from where the cursor sets off to where the result has
// settled. They play at recorded speed, spread across the sentence: after each one the settled frame is held for an
// equal share of the remaining time, so the action happens as it is described and its result stays on screen while
// the sentence ends. Everything between windows (waits, checks with nothing to see) is cut. A window longer than
// `maxWindowSec` (a slow load) keeps its start and its end. A segment with no window holds one frame.
//
// The subtitles come from the same timeline (cue = segment, from its start to its end) and are drawn by the renderer,
// so the text on screen, the .vtt and the voice can never drift apart.
// The pause after each narrated line is a setting (video.pacing.pauseSec); the rest are the renderer's own.
export const PACE_DEFAULTS = { pauseSec: defaultSettings().video.pacing.pauseSec, minStepSec: 1.2, maxWindowSec: 4.5, minTailSec: 0.25 };

const windowOf = (e) => [e.lead / 1000, e.end / 1000];

export function timeline(segments, videoSeconds, audio = {}, pace = {}) {
  const p = { ...PACE_DEFAULTS, ...pace };
  const end = Math.max(0.1, videoSeconds);
  const firstAction = segments.flatMap((g) => g.events).filter((e) => e.category === 'action').sort((a, b) => a.at - b.at)[0];
  const firstLead = Math.min(...segments.flatMap((g) => g.events.map((e) => e.lead / 1000)), end);
  let src = 0;
  let t = 0;
  return segments.map((g, n) => {
    // The opening with no step of its own shows the first page: it plays the first navigation and holds its result.
    const openOnFirstPage = !g.events.length && n === 0 && g.role === 'opening' && firstAction?.kind === 'navigate';
    let wins = g.events.length ? g.events.map(windowOf) : openOnFirstPage ? [windowOf(firstAction)] : g.window ? [[g.window[0] / 1000, g.window[1] / 1000]] : [];
    wins = wins
      .map(([a, b]) => [Math.max(a, src), Math.min(b, end)])
      .filter(([a, b]) => b - a > 0.04)
      .sort((x, y) => x[0] - y[0])
      .reduce((m, w) => (m.length && w[0] <= m.at(-1)[1] + 0.05 ? (m.at(-1)[1] = Math.max(m.at(-1)[1], w[1]), m) : [...m, w]), []);
    const pieces = [];
    for (const [a, b] of wins) {
      const len = b - a;
      if (len > p.maxWindowSec) pieces.push({ a, b: a + p.maxWindowSec * 0.4, win: true }, { a: b - p.maxWindowSec * 0.6, b, win: true, last: true });
      else pieces.push({ a, b, win: true, last: true });
    }
    const shown = pieces.reduce((s, x) => s + (x.b - x.a), 0);
    const spoken = audio[g.id] != null ? audio[g.id] : readingSeconds(g.text);
    const dur = Math.max(p.minStepSec, spoken + p.pauseSec, shown);
    const free = dur - shown;
    const out = [];
    if (!pieces.length) {
      const at = n === 0 ? Math.min(firstLead, end - 0.1) : g.role === 'close' && !g.events.length ? end - 0.15 : Math.max(0, Math.min(src, end) - 0.05);
      out.push({ freeze: Math.max(0, at), dur });
    } else {
      const gap = free / wins.length;
      for (const x of pieces) {
        out.push({ a: x.a, b: x.b, dur: x.b - x.a });
        if (x.last && gap > 0.01) out.push({ freeze: Math.max(x.a, x.b - 0.04), dur: gap });
      }
      src = wins.at(-1)[1];
    }
    const seg = { id: g.id, role: g.role, text: g.text, auto: g.auto, events: g.events.map((e) => e.id), start: t, end: t + dur, dur, pieces: out, audio: audio[g.id] ?? null };
    t += dur;
    return seg;
  });
}

// One cue per segment: shown from the segment's start to its end, the voice from its start for its length.
export const cuesOf = (segs) => segs.filter((g) => g.text).map((g) => ({ start: g.start, end: g.end, text: g.text, audioEnd: g.audio != null ? g.start + g.audio : null }));

// The subtitle rule, checked on every rendered video: every cue lasts until its line has been spoken, and a little
// longer (`minTailSec`); cues never overlap, so no line is cut off by the next; they fit the video.
export function checkCues(cues, { durationSec = null, minTailSec = PACE_DEFAULTS.minTailSec } = {}) {
  const failures = [];
  cues.forEach((c, i) => {
    const label = `cue ${i + 1} ("${String(c.text).slice(0, 40)}")`;
    if (!(c.end > c.start)) failures.push(`${label} has no length`);
    if (c.audioEnd != null && c.end + 0.001 < c.audioEnd + minTailSec) failures.push(`${label} ends at ${c.end.toFixed(2)} s, before its line is spoken (${c.audioEnd.toFixed(2)} s) plus ${minTailSec} s`);
    const next = cues[i + 1];
    if (next && next.start + 0.001 < c.end) failures.push(`${label} overlaps the next cue (${c.end.toFixed(2)} s > ${next.start.toFixed(2)} s)`);
    if (next && c.audioEnd != null && next.start + 0.001 < c.audioEnd) failures.push(`${label} is cut off by the next cue before its line is spoken`);
  });
  const last = cues.at(-1);
  if (durationSec != null && last && last.end > durationSec + 0.3) failures.push(`the last cue ends at ${last.end.toFixed(2)} s, after the video (${durationSec.toFixed(2)} s)`);
  return failures;
}

export function vttText(cues) {
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join('\n\n')}\n`;
}
// Reads cues back from a .vtt (the gate checks the file that is published, not only the plan).
export function parseVtt(text) {
  const toS = (v) => {
    const [h, m, s] = v.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };
  return String(text ?? '')
    .split(/\n\n+/)
    .map((b) => /(\d+:\d+:[\d.]+)\s+-->\s+(\d+:\d+:[\d.]+)\n([\s\S]+)/.exec(b))
    .filter(Boolean)
    .map((m) => ({ start: toS(m[1]), end: toS(m[2]), text: m[3].trim() }));
}

const assTime = (s) => {
  const cs = Math.round(s * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
// The burned-in subtitles (libass): the same cues, bottom centre, white on a dark box.
export function assText(cues, { width = 1280, height = 720 } = {}) {
  const size = Math.round(height / 24);
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Helvetica,${size},&H00FFFFFF,&H00FFFFFF,&H3A1A1714,&H3A1A1714,0,0,0,0,100,100,0,0,3,${Math.round(size / 3)},0,2,${Math.round(width / 8)},${Math.round(width / 8)},${Math.round(height / 20)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${esc(c.text)}`),
    '',
  ].join('\n');
}

const filtersCache = new Map();
export function hasFilter(ffmpeg, name) {
  if (!filtersCache.has(ffmpeg)) filtersCache.set(ffmpeg, String(spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? ''));
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filtersCache.get(ffmpeg));
}

// The ffmpeg filter graph: mask boxes on the recorded timeline; each segment made of its pieces (a recorded stretch,
// or one frame held), padded to its exact length; the segments joined with their audio; the subtitles drawn last.
export function filterGraph(segs, masks, { scaleX = 1, scaleY = 1, audioInputs = {}, assFile = null } = {}) {
  const lines = [];
  const boxes = (masks ?? []).map((m) => {
    const pad = 4;
    const x = Math.max(0, Math.floor((m.x - pad) * scaleX));
    const y = Math.max(0, Math.floor((m.y - pad) * scaleY));
    const w = Math.ceil((m.w + 2 * pad) * scaleX);
    const h = Math.ceil((m.h + 2 * pad) * scaleY);
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill:enable='between(t,${(Math.max(0, m.t0 - 500) / 1000).toFixed(3)},${((m.t1 + 500) / 1000).toFixed(3)})'`;
  });
  const all = segs.flatMap((g, i) => g.pieces.map((x) => ({ ...x, seg: i })));
  lines.push(`[0:v]${boxes.length ? boxes.join(',') : 'null'},split=${all.length}${all.map((_, k) => `[p${k}]`).join('')}`);
  all.forEach((x, k) => {
    if (x.freeze != null) lines.push(`[p${k}]trim=start=${x.freeze.toFixed(3)}:end=${(x.freeze + 0.08).toFixed(3)},setpts=PTS-STARTPTS,fps=25,format=yuv420p,tpad=stop_mode=clone:stop_duration=${x.dur.toFixed(3)},trim=duration=${x.dur.toFixed(3)}[q${k}]`);
    else lines.push(`[p${k}]trim=start=${x.a.toFixed(3)}:end=${x.b.toFixed(3)},setpts=PTS-STARTPTS,fps=25,format=yuv420p[q${k}]`);
  });
  segs.forEach((g, i) => {
    const mine = all.map((x, k) => [x, k]).filter(([x]) => x.seg === i).map(([, k]) => `[q${k}]`);
    const joined = mine.length > 1 ? `${mine.join('')}concat=n=${mine.length}:v=1:a=0,` : `${mine[0]}null,`;
    lines.push(`${joined}tpad=stop_mode=clone:stop_duration=1,trim=duration=${g.dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  });
  const withAudio = Object.keys(audioInputs).length > 0;
  const subs = assFile ? `ass=filename='${String(assFile).replace(/\\/g, '/').replace(/'/g, "'\\\\''")}'` : 'null';
  if (withAudio) {
    segs.forEach((g, i) => {
      const input = audioInputs[g.id];
      lines.push(input != null ? `[${input}:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${g.dur.toFixed(3)},atrim=0:${g.dur.toFixed(3)}[a${i}]` : `aevalsrc=0:c=stereo:s=48000:d=${g.dur.toFixed(3)}[a${i}]`);
    });
    lines.push(`${segs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segs.length}:v=1:a=1[vc][a]`);
  } else lines.push(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[vc]`);
  lines.push(`[vc]${subs}[v]`);
  return { graph: lines.join(';\n'), withAudio };
}

// The quality gate a demo video passes before it may be published: it opens with a line on what it demonstrates,
// every user action the test took is narrated, there is audio when narration is on, the subtitles are drawn into the
// video and follow the voice (checkCues on the written .vtt), no line repeats the one before, the cues add up to the
// video's length, and the secret gate passed. Returns { ok, failures: [text] }.
export function qualityGate({ steps, segs, cues, events = [], narrationWanted, narrated, audioStream, durationSec, secret, burnedIn = true }) {
  const failures = [];
  if (segs[0]?.role !== 'opening' || !segs[0]?.text) failures.push('no opening line on what the video demonstrates');
  const actions = steps?.actions;
  if (!Array.isArray(actions)) failures.push('no action log (the spec does not use the factory\'s demo fixture)');
  else {
    const said = new Set(segs.filter((g) => g.text).flatMap((g) => g.events));
    const silent = events.filter((e) => e.category === 'action' && !said.has(e.id));
    if (silent.length) failures.push(`${silent.length} of ${actions.length} user action(s) have no narrated line (${[...new Set(silent.map((a) => a.raw ?? a.kind))].join(', ')})`);
  }
  if (narrationWanted && !narrated) failures.push('narration is on but the video has no narration');
  if (narrated && !audioStream) failures.push('narration is on but the rendered video has no audio stream');
  if (!burnedIn) failures.push('the subtitles could not be drawn into the video (the ffmpeg in use has no libass "ass" filter; set video.ffmpeg to one that has, or run factory video install)');
  failures.push(...checkCues(cues, { durationSec }));
  segs.forEach((g, i) => {
    if (i && g.text && segs[i - 1].text && g.text.toLowerCase() === segs[i - 1].text.toLowerCase()) failures.push(`line ${i + 1} repeats the line before it ("${g.text.slice(0, 40)}")`);
  });
  const total = segs.reduce((n, g) => n + g.dur, 0);
  if (durationSec != null && Math.abs(durationSec - total) > 0.6) failures.push(`the subtitles cover ${total.toFixed(1)} s but the video lasts ${durationSec.toFixed(1)} s`);
  if (!secret?.ok) failures.push('the secret gate did not pass');
  return { ok: failures.length === 0, failures };
}

// Narrates the segments' lines (redacted again here, the boundary). Returns
// { audio: { segId: seconds }, files: { segId: wav }, texts: [{ id, text }], error }.
export function narrate(segs, narration, outDir) {
  const texts = segs.filter((g) => g.text).map((g) => ({ id: g.id, text: redactText(g.text).text }));
  if (!narration || !texts.length) return { audio: {}, files: {}, texts, error: null };
  const job = path.join(outDir, 'narration-job.json');
  writeText(job, JSON.stringify({ model: narration.model, voices: narration.voices, voice: narration.voice, speed: narration.speed, lang: narration.lang, out: path.join(outDir, 'narration'), steps: texts }));
  const r = spawnSync(narration.python, ['-I', NARRATE, job], { encoding: 'utf8', timeout: 1_800_000 });
  const out = (() => {
    try {
      return JSON.parse(String(r.stdout ?? '').trim().split('\n').at(-1));
    } catch {
      return null;
    }
  })();
  if (r.status !== 0 || !out?.steps) return { audio: {}, files: {}, texts, error: out?.error ?? `narration failed (exit ${r.status}): ${stepRecord(r).error}` };
  return { audio: Object.fromEntries(out.steps.map((s) => [s.id, s.seconds])), files: Object.fromEntries(out.steps.map((s) => [s.id, s.file])), texts, error: null };
}

// What a viewer could read or hear, re-checked after rendering. Any hit, or any match the fixture could not cover, and
// the video is not published (fail closed).
export function secretCheck({ vtt, narrationTexts = [], steps = null, env = process.env }) {
  const hits = [];
  const look = (where, text) => {
    const r = redactText(String(text ?? ''), { env });
    const g = genericHits(String(text ?? ''));
    if (r.hits.length || g.length) hits.push({ where, rules: [...new Set([...r.hits, ...(g.length ? ['generic-key-pattern'] : [])])] });
  };
  look('subtitles (.vtt)', vtt);
  for (const t of narrationTexts) look(`narration ${t.id}`, t.text);
  for (const v of steps?.visible ?? []) look(`visible text, step ${v.step}`, v.text);
  for (const s of steps?.steps ?? []) look(`caption, step ${s.i}`, s.caption);
  for (const u of steps?.unmasked ?? []) hits.push({ where: `step ${u.step}: ${u.where} could not be covered`, rules: u.rules });
  return { ok: hits.length === 0, hits };
}

// One video: render, write the sidecars, check. Returns the report (also written as <name>.report.json).
// `script`: the segments to narrate (script.mjs bindScript: the narrator's script; automaticScript: the per-step lines,
// used when there is none). `speak`: false for an evidence video (subtitled, silent). `narrator`: { by: 'agent' |
// 'automatic', why } for the report and the PR.
export function renderVideo({ video, steps, outDir, name, tools, env = process.env, log = () => {}, script = null, speak = true, narrator = null }) {
  fs.mkdirSync(outDir, { recursive: true });
  const ffmpeg = tools.ffmpeg;
  if (!ffmpeg) return { ok: false, published: false, reason: 'no ffmpeg (factory video install, or set video.ffmpeg)' };
  const p = probe(ffmpeg, video);
  if (!p.seconds) return { ok: false, published: false, reason: `ffmpeg could not read ${path.basename(video)}` };
  const pace = { ...(tools.settings?.pacing?.pauseSec != null ? { pauseSec: tools.settings.pacing.pauseSec } : {}) };
  const events = recordedEvents(steps, { env });
  const segments = (script ?? automaticScript(steps, events)).map((g) => ({ ...g, text: redactText(g.text ?? '', { env }).text }));
  if (!segments.length) return writeReport(outDir, name, { name, source: video, ok: false, published: false, reason: 'the recording has no narrated step (no step log: the test does not use the demo fixture)' });
  const by = narrator ?? { by: script ? 'agent' : 'automatic', why: null };
  const work = path.join(outDir, `${name}.work`);
  fs.mkdirSync(work, { recursive: true });
  const voice = speak ? tools.narration : null;
  const spoken = narrate(segments, voice, work);
  if (spoken.error) log(`${name}: ${spoken.error}; the video is silent with subtitles`);
  const segs = timeline(segments, p.seconds, spoken.audio, pace);
  const cues = cuesOf(segs);
  const vtt = vttText(cues);
  const vttFile = path.join(outDir, `${name}.vtt`);
  writeText(vttFile, vtt);
  // The check runs on the subtitle text, the narration text and the visible-text log before anything is encoded.
  const check = secretCheck({ vtt, narrationTexts: spoken.texts, steps, env });
  const narrationOn = Object.keys(spoken.files).length > 0;
  const narrationWhy = narrationOn ? null : !speak ? 'an evidence video: subtitled, not narrated aloud (video.script.speakEvidence)' : spoken.error ?? tools.narrationWhyOff ?? (spoken.texts.length ? 'narration is off' : 'the video has no narrated steps');
  const report = { name, source: video, durationSec: null, steps: cues.length, masks: (steps?.masks ?? []).length, narrator: by, narration: narrationOn ? { voice: tools.narration.voice, speed: tools.narration.speed } : null, narrationWhyOff: narrationWhy, subtitles: path.basename(vttFile), secretCheck: check };
  if (!check.ok) {
    fs.rmSync(work, { recursive: true, force: true });
    return writeReport(outDir, name, { ...report, ok: false, published: false, reason: `a secret check found ${check.hits.length} match(es) that could not be masked (${check.hits.map((h) => `${h.where}: ${h.rules.join(', ')}`).join('; ')}); the video is not published` });
  }
  const viewport = steps?.viewport;
  const scaleX = viewport?.width && p.width ? p.width / viewport.width : 1;
  const scaleY = viewport?.height && p.height ? p.height / viewport.height : scaleX;
  const order = segs.filter((g) => spoken.files[g.id]);
  const audioInputs = Object.fromEntries(order.map((g, i) => [g.id, i + 1]));
  const burnedIn = hasFilter(ffmpeg, 'ass');
  const assFile = burnedIn ? path.join(work, 'subtitles.ass') : null;
  if (assFile) writeText(assFile, assText(cues, { width: p.width ?? defaultSettings().video.size.width, height: p.height ?? defaultSettings().video.size.height }));
  const { graph, withAudio } = filterGraph(segs, steps?.masks ?? [], { scaleX, scaleY, audioInputs: narrationOn ? audioInputs : {}, assFile });
  // Kept for a person reading a failed render; passed inline (ffmpeg 8 and later dropped -filter_complex_script).
  writeText(path.join(work, 'filter.txt'), graph);
  const out = path.join(outDir, `${name}.webm`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, ...order.flatMap((g) => ['-i', spoken.files[g.id]]), '-filter_complex', graph.replace(/\n/g, ''), '-map', '[v]', ...(withAudio ? ['-map', '[a]', '-c:a', 'libopus', '-b:a', '64k'] : []), '-c:v', 'libvpx', '-b:v', '1200k', '-deadline', 'realtime', '-cpu-used', '8', out];
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 3_600_000 });
  if (r.status !== 0) {
    return writeReport(outDir, name, { ...report, ok: false, published: false, reason: `ffmpeg failed: ${String(r.stderr ?? '').trim().split('\n').slice(-3).join(' ')}` });
  }
  fs.rmSync(work, { recursive: true, force: true });
  const done = probe(ffmpeg, out);
  const durationSec = done.seconds ? Math.round(done.seconds * 10) / 10 : null;
  // The gate reads the subtitles back from the file that is published, with each line's audio end from the timeline.
  const written = parseVtt(fs.readFileSync(vttFile, 'utf8')).map((c, i) => ({ ...c, audioEnd: cues[i]?.audioEnd ?? null }));
  const quality = qualityGate({ steps, segs, cues: written, events, narrationWanted: Boolean(voice), narrated: narrationOn, audioStream: done.audio, durationSec: done.seconds, secret: check, burnedIn });
  const lines = segs.filter((g) => g.text).map((g) => ({ role: g.role, text: g.text, start: round(g.start), end: round(g.end), audioSec: g.audio != null ? round(g.audio) : null, steps: g.events }));
  const final = { ...report, ok: quality.ok, published: null, video: path.basename(out), durationSec, audio: withAudio, burnedIn, lines, actions: (steps?.actions ?? []).length, quality };
  if (!quality.ok) return writeReport(outDir, name, { ...final, published: false, reason: `the quality gate failed: ${quality.failures.join('; ')}` });
  return writeReport(outDir, name, final);
}
const round = (v) => Math.round(v * 100) / 100;

function writeReport(outDir, name, report) {
  writeText(path.join(outDir, `${name}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
