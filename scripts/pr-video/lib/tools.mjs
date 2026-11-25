// The local demo-video toolchain: a Python virtualenv with the narration packages at pinned versions, the Kokoro model
// files pinned by URL, size and SHA-256 (packs/video/tools.json), and ffmpeg. `factory video install` sets it up once per
// machine (in the factory's machine cache, next to the analysis tools); recording, narration and rendering then run on
// the machine that runs the pipeline, never in CI.
//
// ffmpeg: `video.ffmpeg` in .factory/config.json (a team's own build), else the binary the pinned imageio-ffmpeg wheel
// ships, else ffmpeg on PATH. Narration is optional: without the toolchain, with narration off, or with
// video.licenceReview "strict" (pending licence items off), a video is still produced, silent with subtitles.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWLIST } from '../../pipeline/lib/analysis/licences.mjs';
import { toolsDir } from '../../pipeline/lib/analysis/runner.mjs';
import { INSTALL_ROOT, defaultSettings } from '../../pipeline/lib/settings.mjs';

export const PINS = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'packs/video/tools.json'), 'utf8'));

// The defaults are in scripts/pr-video/config.json (`video`).
export const VIDEO_DEFAULTS = defaultSettings().video;

export function videoSettings(config = {}) {
  const v = config.video ?? {};
  return {
    ...VIDEO_DEFAULTS,
    ...v,
    narration: { ...VIDEO_DEFAULTS.narration, ...(v.narration ?? {}) },
    pacing: { ...VIDEO_DEFAULTS.pacing, ...(v.pacing ?? {}) },
  };
}

export const videoHome = (env = process.env) => env.FACTORY_VIDEO_HOME ?? path.join(toolsDir(), PINS.id);
const venvPython = (home) => path.join(home, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const modelPath = (home, key) => path.join(home, 'models', PINS.models[key].file);

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// One row per pinned item: { what, licence, use, ok, pending, problem }. Pending items are on by default with a
// warning; "strict" turns narration off (the packages and models are what narration needs; ffmpeg is the renderer's).
export function licenceRows(settings = videoSettings()) {
  const strict = settings.licenceReview === 'strict';
  const items = [
    ...PINS.packages.map((p) => ({ what: `${p.name} ${p.version}`, licence: p.licence, use: 'execute' })),
    ...PINS.bundled.map((b) => ({ what: b.name, licence: b.licence, use: b.use, review: b.licenceReview })),
    ...Object.values(PINS.models).map((m) => ({ what: `${m.file} (${m.version})`, licence: m.licence, use: 'data', review: m.licenceReview })),
  ];
  return items.map((i) => {
    const allowed = ALLOWLIST[i.licence];
    const okByList = allowed === 'any' || (allowed === 'execute' && i.use === 'execute') || (allowed === 'data' && i.use === 'data');
    if (i.review === 'pending') return { ...i, ok: true, pending: true, off: strict, problem: null, warning: strict ? 'off: legal review pending (video.licenceReview "strict")' : 'enabled by default, legal review pending' };
    return { ...i, ok: okByList, problem: okByList ? null : `${i.licence} is not on the factory's licence allowlist for ${i.use}` };
  });
}

// Where everything is, and what is missing. Never throws.
export function resolveTools(config = {}, { env = process.env } = {}) {
  const s = videoSettings(config);
  const home = videoHome(env);
  const python = venvPython(home);
  const model = PINS.models[s.narration.model] ?? PINS.models.int8;
  const files = { model: path.join(home, 'models', model.file), voices: modelPath(home, 'voices') };
  const missing = [];
  if (!fs.existsSync(python)) missing.push('the narration virtualenv (factory video install)');
  for (const [k, f] of Object.entries(files)) if (!fs.existsSync(f)) missing.push(`${k} file ${path.basename(f)} (factory video install)`);
  const ffmpeg = s.ffmpeg ?? pinnedFfmpeg(python) ?? onPath('ffmpeg');
  const pendingOff = licenceRows(s).some((r) => r.off);
  const narrationWhyOff = !s.narration.enabled ? 'narration is off (video.narration.enabled)' : pendingOff ? 'narration is off: its licence review is pending and video.licenceReview is "strict"' : missing.length ? `narration is unavailable: missing ${missing.join(', ')}` : null;
  return { home, python, files, ffmpeg, narration: narrationWhyOff ? null : { ...s.narration, python, ...files }, narrationWhyOff, settings: s };
}

// The binary the pinned imageio-ffmpeg ships, asked of the toolchain's Python once per process and kept once found: a
// later probe that fails (a slow Python start under load) does not take it away from a run that already had it.
const pinned = new Map();
function pinnedFfmpeg(python) {
  if (!fs.existsSync(python)) return null;
  if (pinned.has(python) && fs.existsSync(pinned.get(python))) return pinned.get(python);
  const r = spawnSync(python, ['-I', '-c', 'import imageio_ffmpeg as i; print(i.get_ffmpeg_exe())'], { encoding: 'utf8', timeout: 60_000 });
  const exe = r.status === 0 ? r.stdout.trim() : '';
  if (!exe || !fs.existsSync(exe)) return null;
  pinned.set(python, exe);
  return exe;
}
function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() || null : null;
}

// `factory video install`: the virtualenv with the pinned packages, and the model files checked against their pins.
// Idempotent: a file already present with the right SHA-256 is not fetched again.
export async function installTools({ config = {}, env = process.env, log = console.log, fetchImpl = globalThis.fetch, python = null } = {}) {
  const s = videoSettings(config);
  const home = videoHome(env);
  fs.mkdirSync(path.join(home, 'models'), { recursive: true });
  const py = venvPython(home);
  if (!fs.existsSync(py)) {
    const base = python ?? findPython();
    if (!base) throw new Error(`no Python ${PINS.python.min} to ${PINS.python.max} found (python3.13 ... python3.10, python3, python); install one, or set FACTORY_PYTHON`);
    log(`creating ${path.join(home, 'venv')} with ${base}`);
    const r = spawnSync(base, ['-m', 'venv', path.join(home, 'venv')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${base} -m venv failed`);
  }
  const reqs = PINS.packages.map((p) => `${p.name}==${p.version}`);
  log(`installing ${reqs.join(', ')}`);
  const pip = spawnSync(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...reqs], { stdio: 'inherit' });
  if (pip.status !== 0) throw new Error('pip install of the pinned narration packages failed');
  // What pip actually installed (with the dependencies it resolved), recorded for an audit.
  const freeze = spawnSync(py, ['-m', 'pip', 'freeze', '--disable-pip-version-check'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(home, 'installed.txt'), freeze.stdout ?? '');
  const wanted = [s.narration.model in PINS.models ? s.narration.model : 'int8', 'voices'];
  for (const key of wanted) {
    const m = PINS.models[key];
    const file = path.join(home, 'models', m.file);
    if (fs.existsSync(file) && fs.statSync(file).size === m.size && sha256File(file) === m.sha256) {
      log(`${m.file}: present, SHA-256 checked`);
      continue;
    }
    log(`downloading ${m.file} (${Math.round(m.size / 1e6)} MB, ${m.version})`);
    const res = await fetchImpl(m.url);
    if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== m.size || got !== m.sha256) throw new Error(`${m.file}: size ${buf.length} / SHA-256 ${got} does not match the pin (${m.size} / ${m.sha256}); not installed`);
    fs.writeFileSync(`${file}.part`, buf);
    fs.renameSync(`${file}.part`, file);
  }
  const t = resolveTools(config, { env });
  if (!t.ffmpeg) throw new Error('no ffmpeg: the pinned imageio-ffmpeg did not provide one for this platform; set video.ffmpeg');
  return t;
}

function findPython() {
  if (process.env.FACTORY_PYTHON) return process.env.FACTORY_PYTHON;
  const [minMaj, minMin] = PINS.python.min.split('.').map(Number);
  const [maxMaj, maxMin] = PINS.python.max.split('.').map(Number);
  for (const c of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const [maj, min] = r.stdout.trim().split('.').map(Number);
    if (maj === minMaj && min >= minMin && maj === maxMaj && min <= maxMin) return c;
  }
  return null;
}

// `factory video status`: lines for a person.
export function statusLines(config = {}, { env = process.env } = {}) {
  const t = resolveTools(config, { env });
  return [
    `toolchain   ${t.home}`,
    `ffmpeg      ${t.ffmpeg ?? 'MISSING (factory video install, or set video.ffmpeg)'}`,
    `narration   ${t.narration ? `on (${t.narration.voice}, speed ${t.narration.speed}, model ${path.basename(t.files.model)})` : t.narrationWhyOff}`,
    ...licenceRows(t.settings).map((r) => `${r.ok ? (r.pending ? (r.off ? 'off   ' : 'WARN  ') : 'ok    ') : 'FAILED'}  licence ${r.what}: ${r.licence}${r.warning ? ` (${r.warning})` : ''}${r.problem ? `: ${r.problem}` : ''}`),
  ];
}
