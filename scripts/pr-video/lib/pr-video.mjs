// PR demo videos: pick the e2e specs a pull request changes, publish the videos they record to a
// storage branch, and keep a "Demo video" section in the PR description up to date. The PR check's
// video critic reads the links in that section (scripts/pr-check/lib/video.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesAnyPath } from '../../implement/lib/project.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { VIDEO_SECTION_END as SECTION_END, VIDEO_SECTION_START as SECTION_START, log, run } from '../../pipeline/lib/util.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';

const GIF_MAX_BYTES = 9 * 1024 * 1024;
const GIF_ATTEMPTS = [
  { fps: 6, width: 720 },
  { fps: 4, width: 480 },
];

export const prFolder = (pr) => `pr-${pr}`;
// Before a PR exists (implement.preOpen): the story branch's push run records into `branch-<slug>`, and writes the
// sections there (`section.md`, `api.md`) for the pipeline to put into the PR body before it opens.
export const keyFolder = (key) => `branch-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)}`;

// Specs added or changed between the merge base and HEAD: the changed files matching
// `prVideo.specPatterns` (globs of the e2e specs whose recordings demo a PR). With no pattern
// configured no spec is picked.
export function changedSpecs(root, base, patterns = []) {
  if (!patterns?.length) return [];
  const diff = git(root, ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`], { allowFail: false });
  return diff.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f && matchesAnyPath(f, patterns) && fs.existsSync(path.join(root, f)));
}

// Replaces the managed section (between `start` and `end`), or appends it when the body has none.
export function upsertSection(body, section, { start: startMarker = SECTION_START, end: endMarker = SECTION_END } = {}) {
  const block = `${startMarker}\n${section.trim()}\n${endMarker}`;
  const text = body ?? '';
  const start = text.indexOf(startMarker);
  const end = start === -1 ? -1 : text.indexOf(endMarker, start);
  if (end !== -1) return `${text.slice(0, start)}${block}${text.slice(end + endMarker.length)}`;
  return text.trim() ? `${text.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

// Removes a managed section, if present.
export function removeSection(body, { start: startMarker = SECTION_START, end: endMarker = SECTION_END } = {}) {
  const text = body ?? '';
  const start = text.indexOf(startMarker);
  const end = start === -1 ? -1 : text.indexOf(endMarker, start);
  if (end === -1) return text;
  return `${text.slice(0, start).trimEnd()}\n${text.slice(end + endMarker.length).replace(/^\n+/, '\n')}`.trim() + '\n';
}

// The tests of artifacts/e2e-videos/manifest.json, the last attempt of each.
export function latestAttempts(manifest) {
  const latest = new Map();
  for (const t of manifest?.tests ?? []) {
    const key = [t.project, t.file, ...t.titlePath].join('\u0000');
    if (!latest.has(key) || latest.get(key).retry <= t.retry) latest.set(key, t);
  }
  return [...latest.values()];
}

// Tests from the manifest that kept a video, last attempt of each test only.
export const recordedTests = (manifest) => latestAttempts(manifest).filter((t) => t.videos.length);

const blobUrl = (repo, branch, file) => `https://github.com/${repo}/blob/${branch}/${file.split('/').map(encodeURIComponent).join('/')}`;

// fileUrl(file, { raw }): the code host's link to a file on the storage branch (host.fileUrl); GitHub's
// blob URL by default.
export function renderSection({ repo, branch, pr, headSha, runUrl, specs = [], videos = [], note, fileUrl = null, folder = null, footer = null }) {
  const link = (file, raw = false) => (fileUrl ? fileUrl(file, { raw }) : `${blobUrl(repo, branch, file)}${raw ? '?raw=true' : ''}`);
  const lines = ['## Demo video', ''];
  const source = `${headSha ? `commit ${headSha.slice(0, 7)}` : 'this PR'}${runUrl ? `, [workflow run](${runUrl})` : ''}`;
  if (note) {
    lines.push(`${note} (${source})`);
    return lines.join('\n');
  }
  lines.push(`Recorded on the test stack from the e2e specs this PR changes: ${specs.map((s) => `\`${s}\``).join(', ')} (${source}).`);
  const dir = folder ?? prFolder(pr);
  const entry = (v, level) => {
    const out = ['', `${level} ${v.ok ? '✅' : '❌ (failed)'} ${v.title}`, ''];
    // A video the secret gate held back: never linked; the PR says why (fail closed).
    if (v.blocked) return [...out, `Not published: ${v.blocked} · \`${v.file}\``];
    const video = link(`${dir}/${v.video}`);
    if (v.preview) out.push(`[![${v.title}](${link(`${dir}/${v.preview}`, true)})](${video})`, '');
    const facts = [v.durationSec ? `${v.durationSec} s` : null, v.narration ? `narrated (${v.narration})` : v.narrationWhyOff ? `silent with subtitles: ${v.narrationWhyOff}` : null, v.vtt ? `[subtitles (VTT)](${link(`${dir}/${v.vtt}`)})` : null].filter(Boolean);
    out.push(`[Full video (WebM)](${video}) · \`${v.file}\`${facts.length ? ` · ${facts.join(' · ')}` : ''}`);
    return out;
  };
  // Headline demos first (narrated from the demo-narrator's script), then the other cases' videos as evidence, collapsed.
  // A UI bug's pair first, under its ticket: "Before the fix" (or why it could not be shown), then "After the fix".
  const pairs = [...new Set(videos.filter((v) => v.pair).map((v) => v.pair.key))];
  for (const k of pairs) {
    const mine = videos.filter((v) => v.pair?.key === k);
    lines.push('', `### ${k}${mine[0].pair.title ? `: ${mine[0].pair.title}` : ''}`);
    for (const side of ['before', 'after']) {
      const v = mine.find((x) => x.pair.side === side);
      const label = side === 'before' ? 'Before the fix' : 'After the fix';
      if (!v) continue;
      if (v.missing) {
        lines.push('', `#### ${label}`, '', `Not shown: ${v.missing}`);
        continue;
      }
      lines.push(...entry({ ...v, title: label }, '####'));
    }
  }
  const rest = videos.filter((v) => !v.pair);
  const marked = videos.some((v) => v.headline != null);
  const headline = marked ? rest.filter((v) => v.headline) : rest;
  const evidence = marked ? rest.filter((v) => !v.headline) : [];
  for (const v of headline) lines.push(...entry(v, '###'));
  const fallback = [...videos.filter((v) => v.pair && !v.missing), ...headline].filter((v) => v.narrator?.by === 'automatic' && v.narrator?.why);
  if (fallback.length) {
    lines.push('', '**Automatic narration** (no script by the narrator agent):', '');
    for (const v of fallback) lines.push(`- ${v.title}: ${v.narrator.why}`);
  }
  if (evidence.length) {
    lines.push('', `<details><summary>Evidence: ${evidence.length} more test-case video(s), subtitled with the automatic lines</summary>`);
    for (const v of evidence) lines.push(...entry(v, '####'));
    lines.push('', '</details>');
  }
  lines.push('', `<sub>${footer ?? `Updated by \`${workflowFile()}\` on every push`}; edits inside this section are overwritten.</sub>`);
  return lines.join('\n');
}

// The workflow file that wrote the section, as installed (council C9: the footer named the template's file,
// pr-demo-video.yml, while repositories install it as factory-pr-demo-video.yml). GitHub Actions gives its path.
export const workflowFile = (env = process.env) => /(\.github\/workflows\/[^@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1] ?? '.github/workflows/factory-pr-demo-video.yml';

export const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'video';

// Animated preview shown inline in the PR. Skipped (link only) without ffmpeg or when it gets too big.
export function makePreview(video, out, ffmpeg = 'ffmpeg') {
  if (run(ffmpeg, ['-version']).status !== 0) return false;
  for (const { fps, width } of GIF_ATTEMPTS) {
    const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`;
    const result = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', filter, '-loop', '0', out]);
    if (result.status === 0 && fs.existsSync(out) && fs.statSync(out).size <= GIF_MAX_BYTES) return true;
    log(`preview ${path.basename(out)} at ${fps} fps/${width}px ${result.status === 0 ? 'is too large' : `failed: ${result.stderr.trim()}`}`);
  }
  fs.rmSync(out, { force: true });
  return false;
}

// Copies the recorded videos (and previews) into a staging folder laid out as on the storage branch.
export function stageVideos(videosDir, stageDir) {
  const manifestFile = path.join(videosDir, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  fs.mkdirSync(stageDir, { recursive: true });
  const staged = [];
  for (const t of recordedTests(manifest)) {
    t.videos.forEach((rel, i) => {
      const name = `${slug(`${path.basename(t.file).replace(/\.spec\.ts$/, '')}--${t.title}`)}${t.videos.length > 1 ? `--page${i + 1}` : ''}${t.ok ? '' : '.failed'}`;
      fs.copyFileSync(path.join(videosDir, rel), path.join(stageDir, `${name}.webm`));
      const preview = makePreview(path.join(stageDir, `${name}.webm`), path.join(stageDir, `${name}.gif`)) ? `${name}.gif` : null;
      // titlePath is [project, file, ...describes, title]
      staged.push({ title: t.titlePath.slice(2).join(' › ') || t.title, file: t.file, ok: t.ok, video: `${name}.webm`, preview });
    });
  }
  return staged;
}

// Rewrites the storage branch as one parentless commit holding every PR folder, with `folder`
// replaced by the files in `stageDir` (or removed when stageDir is null). Squashing keeps the branch
// small: replaced videos are not kept in history. Retries when another run pushed in between.
export function publishFolder(root, { branch, folder, stageDir, message, remote = 'origin', attempts = 5 }) {
  const env = { ...process.env };
  env.GIT_AUTHOR_NAME ??= 'github-actions[bot]';
  env.GIT_AUTHOR_EMAIL ??= '41898282+github-actions[bot]@users.noreply.github.com';
  env.GIT_COMMITTER_NAME ??= env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL ??= env.GIT_AUTHOR_EMAIL;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const fetched = git(root, ['fetch', '-q', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    const current = fetched.status === 0 ? git(root, ['rev-parse', `refs/remotes/${remote}/${branch}`]).stdout.trim() : '';
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-'));
    const indexEnv = { ...env, GIT_INDEX_FILE: path.join(indexDir, 'index') };
    try {
      git(root, ['read-tree', ...(current ? [current] : ['--empty'])], { env: indexEnv, allowFail: false });
      git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', folder], { env: indexEnv, allowFail: false });
      for (const name of stageDir ? fs.readdirSync(stageDir).sort() : []) {
        const blob = git(root, ['hash-object', '-w', '--', path.join(stageDir, name)], { allowFail: false }).stdout.trim();
        git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${folder}/${name}`], { env: indexEnv, allowFail: false });
      }
      const tree = git(root, ['write-tree'], { env: indexEnv, allowFail: false }).stdout.trim();
      if (current && git(root, ['rev-parse', `${current}^{tree}`]).stdout.trim() === tree) return { pushed: false, commit: current };
      const commit = git(root, ['commit-tree', tree, '-m', message], { env, allowFail: false }).stdout.trim();
      const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${branch}:${current}`, remote, `${commit}:refs/heads/${branch}`]);
      if (push.status === 0) return { pushed: true, commit };
      log(`push to ${branch} failed (attempt ${attempt}/${attempts}): ${push.stderr.trim()}`);
    } finally {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
  }
  throw new Error(`could not push ${branch} after ${attempts} attempts`);
}

// The code host of a config (or of a checkout root): its synchronous form, as these helpers are.
const hostOf = (target) => hostFor(typeof target === 'string' ? { root: target } : target).sync;

export function readPrBody(target, pr) {
  const p = hostOf(target).pr.get(pr);
  if (!p) throw new Error(`pull request ${pr} not found`);
  return String(p.body ?? '');
}

// The body of an already-open PR with the demo video and API sections the local step stored for its head (`media`:
// preOpenMedia's answer): each section replaced in place, or added once; a section with nothing stored is left as it is.
export function embedSections(body, media, apiMarkers) {
  let out = String(body ?? '');
  if (media?.video) out = upsertSection(out, media.video);
  if (media?.api) out = upsertSection(out, media.api, apiMarkers);
  return out;
}

// Writes `section` into the PR body between `markers` (default: the demo video section);
// a null section removes it. `target`: the repository's config, or its checkout root.
export function writePrSection(target, pr, section, markers) {
  const current = readPrBody(target, pr);
  const body = section === null ? removeSection(current, markers) : upsertSection(current, section, markers);
  if (body === current) return;
  hostOf(target).pr.update(pr, { body });
}
