// `factory pr-video local`: the demo video of a story branch, produced on the machine that runs the pipeline (never in
// CI). The harness runs it after every agent stage and the CI proof, right before the PR opens; the PR's body is then
// written once with the section (implement.mjs preOpenMedia reads it back by head).
//
//   1. the changed e2e specs and the change's scope (frontend: a video; backend only: the API summary)
//   2. the test stack (the slot this process holds, TESTSTACK_SLOT), the specs run in demo mode: slow pacing, the drawn
//      cursor, captions, the step log, secrets covered (e2e/demo.ts), with the factory's redaction boundary as detector
//   3. per video: narration, holds, mask boxes, subtitles (.vtt), and the fail-closed secret gate (render.mjs)
//   4. publish: the rendered files and section.md go to the storage branch through the code host (git push to its remote;
//      links from the host adapter's fileUrl), under the branch's folder; the API summary as before
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText, writeText } from '../../pipeline/lib/redact.mjs';
import { runAgent as defaultRunAgent } from '../../pipeline/lib/agents.mjs';
import { log as defaultLog } from '../../pipeline/lib/util.mjs';
import { changeScope } from './api-summary.mjs';
import { changedSpecs, keyFolder, makePreview, publishFolder, recordedTests, renderSection, slug } from './pr-video.mjs';
import { renderVideo } from './render.mjs';
import { appendJsonl } from '../../pipeline/lib/util.mjs';
import { trackerFor } from '../../board/lib/trackers/index.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { apiEvidenceSettings, apiTestOfCase, backendBugs, cleanExchange, evidenceSection, issueNumberOf, reproductionComment, REPRO_MARKER, scanHits, verifyApiBefore, writeProse } from './api-evidence.mjs';
import { baseCheckout, bugPairSettings, testOfCase, uiBugs, verifyBefore } from './bugpair.mjs';
import { automaticScript, caseIdOf, headlineCases, planCases, recordedEvents, scriptSettings, scriptVideos, ticketFor } from './script.mjs';
import { resolveTools } from './tools.mjs';

const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REDACT_MODULE = path.join(INSTALL_ROOT, 'scripts/pipeline/lib/redact.mjs');
const readJsonFile = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
export const LOCAL_FOOTER = 'Recorded, narrated and rendered on the machine that ran the pipeline (`factory pr-video local`), then checked for secrets before publishing';

// The command that runs the specs in demo mode; `{specs}` is replaced by the spec paths.
// Demo pacing makes a spec several times slower than at test speed: its own timeout is lifted (--timeout).
export const DEFAULT_RECORD_CMD = 'npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps --timeout 900000 {specs}';

// The tickets' titles by key, from the ticket cache (`<state>/board/<KEY>/story.md`, first line "# KEY: title"), for the
// opening line of each video. Missing cache: the line names the key only.
export function ticketTitles(root, stateDir = '.factory/state') {
  const dir = path.join(root, stateDir, 'board');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const key of fs.readdirSync(dir)) {
    const file = path.join(dir, key, 'story.md');
    if (!fs.existsSync(file)) continue;
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const m = /^#\s*([^:]+):\s*(.+)$/.exec(first);
    if (m && m[1].trim() === key) out[key] = m[2].trim();
  }
  return out;
}

export function demoEnv(tools, env = process.env, { tickets = {}, timeoutSec = 900 } = {}) {
  const p = tools.settings.pacing;
  const size = tools.settings.size ?? { width: 1280, height: 720 };
  return {
    ...env,
    E2E_DEMO: '1',
    E2E_KEEP_VIDEOS: '1',
    E2E_API_LOG: '1',
    E2E_REDACT_MODULE: REDACT_MODULE,
    E2E_DEMO_PACING: JSON.stringify({ stepDelayMs: p.stepDelayMs, holdMs: p.holdMs, typeDelayMs: p.typeDelayMs, cursorMs: p.cursorMs }),
    E2E_VIDEO_SIZE: `${size.width}x${size.height}`,
    // A spec's own test.setTimeout cannot cut a demo recording short (e2e/fixtures.ts raises it to this floor).
    E2E_DEMO_TIMEOUT_MS: String(Math.round(Number(timeoutSec) * 1000)),
    E2E_DEMO_TICKETS: JSON.stringify(tickets),
  };
}

// Renders every recorded test's video and stages what may be published (stageDir: the storage branch's layout).
// Headline demos (script.mjs headlineCases; all videos with video.script.scope "all") are narrated aloud from the
// demo-narrator agent's script, or from the automatic lines when there is none (the entry says why); the other videos
// are evidence: subtitled with the automatic lines, silent unless video.script.speakEvidence.
export function renderRecorded({ videosDir, stageDir, renderDir, tools, log = defaultLog, env = process.env, root = null, config = {}, key = null, runAgent = null, cases = null, bugs = [], before = null }) {
  const manifestFile = path.join(videosDir, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const settings = scriptSettings(config);
  const plan = cases ?? (root ? planCases(root, config.plansDir ?? '.factory/plans') : []);
  const headline = headlineCases(plan);
  const entries = [];
  const todo = [];
  for (const t of recordedTests(manifest)) {
    const rel = t.videos[0];
    const title = t.titlePath.slice(2).join(' › ') || t.title;
    // Only a passing test is a demo. A failed recording stays on this machine as evidence for agents (the raw video and
    // its keyframes under videosDir); it is never narrated, rendered or published.
    if (!t.ok) {
      entries.push({ title, file: t.file, ok: false, failed: true, kept: path.join(videosDir, rel), blocked: 'the test failed in demo mode, so this recording is not a demo; it is kept on the machine that ran the pipeline as evidence' });
      log(`${t.file}: "${t.title}" failed in demo mode; its recording is kept locally and not published`);
      continue;
    }
    const name = slug(`${path.basename(t.file).replace(/\.spec\.ts$/, '')}--${t.title}`);
    const steps = t.steps && fs.existsSync(path.join(videosDir, t.steps)) ? JSON.parse(fs.readFileSync(path.join(videosDir, t.steps), 'utf8')) : null;
    const isHeadline = headline.has(caseIdOf(t.title) ?? '') && !bugs.some((b) => b.caseIds.includes(caseIdOf(t.title)));
    todo.push({ t, title, name, steps, rel, dir: videosDir, headline: isHeadline, pair: null, scripted: Boolean(steps) && (settings.scope === 'all' || (settings.scope === 'headline' && isHeadline)) });
  }
  // Each UI bug's "before the fix" recording, used only when it failed at the reproduction check (bugpair.mjs).
  const missing = [];
  for (const b of bugs) {
    // The first of the bug's cases, in order, whose before run failed at its reproduction check.
    let chosen = null;
    const verdicts = [];
    for (const caseId of b.caseIds) {
      const afterItem = todo.find((x) => caseIdOf(x.t.title) === caseId);
      const bt = before?.manifest ? testOfCase(before.manifest, caseId) : null;
      const bSteps = bt?.steps && fs.existsSync(path.join(before.dir, bt.steps)) ? JSON.parse(fs.readFileSync(path.join(before.dir, bt.steps), 'utf8')) : null;
      const verdict = before?.error ? { ok: false, why: `the before run could not be made: ${before.error}` } : !afterItem ? { ok: false, why: 'the fixed branch has no passing recording of the reproduction case' } : verifyBefore({ test: bt, steps: bSteps, after: { steps: afterItem.steps }, healthy: before?.healthy });
      verdicts.push([caseId, verdict.why]);
      if (verdict.ok) {
        chosen = { afterItem, bt, bSteps };
        break;
      }
    }
    if (!chosen) {
      const why = before?.error ? `the before run could not be made: ${before.error}` : verdicts.length > 1 ? `none of its ${verdicts.length} browser cases failed at its check on the base (${verdicts.map(([id, w]) => `${id}: ${w}`).join('; ')})` : verdicts[0][1];
      missing.push({ key: b.key, why });
      log(`${b.key}: no before-the-fix video: ${why}`);
      const after = todo.find((x) => caseIdOf(x.t.title) === b.caseIds[0]);
      if (after) Object.assign(after, { headline: true, pair: { key: b.key, side: 'after' }, scripted: settings.scope !== 'none' && Boolean(after.steps) });
      continue;
    }
    const { afterItem, bt, bSteps } = chosen;
    Object.assign(afterItem, { headline: true, pair: { key: b.key, side: 'after' }, scripted: settings.scope !== 'none' && Boolean(afterItem.steps) });
    const name = `${slug(`${b.key}--before-the-fix--${bt.title}`)}`;
    todo.unshift({ t: bt, title: `${bt.titlePath.slice(2).join(' › ') || bt.title}`, name, steps: { ...bSteps, steps: (bSteps.steps ?? []).filter((x) => x.kind !== 'outcome') }, rel: bt.videos[0], dir: before.dir, headline: true, pair: { key: b.key, side: 'before', partner: afterItem.name }, scripted: settings.scope !== 'none' });
  }
  // One narrator run for every scripted video (plus one retry for scripts that failed validation).
  const wanted = todo.filter((x) => x.scripted || (x.headline && settings.scope === 'none'));
  const pairOf = (x) => (x.pair ? { key: x.pair.key, side: x.pair.side, partner: x.pair.side === 'before' ? x.pair.partner : todo.find((y) => y.pair?.key === x.pair.key && y.pair.side === 'before')?.name ?? null } : null);
  const narration = runAgent || settings.scope === 'none'
    ? scriptVideos({ root, config, videos: wanted.map((x) => ({ name: x.name, title: x.t.title, steps: x.steps, key, pair: pairOf(x) })), runAgent, settings, stateDir: config.stateDir, cases: plan, env, log })
    : { scripts: {}, fallback: Object.fromEntries(wanted.map((x) => [x.name, 'no agent runner was given to the video step'])), runs: [] };
  for (const x of todo) {
    const script = narration.scripts[x.name] ?? null;
    const spoken = x.headline || x.scripted || settings.speakEvidence;
    const narrator = { by: script ? 'agent' : 'automatic', why: script ? null : redactText(narration.fallback[x.name] ?? (x.headline || x.scripted ? '' : 'evidence video: automatic subtitles'), { env }).text || null };
    const report = renderVideo({ video: path.join(x.dir, x.rel), steps: x.steps, outDir: renderDir, name: x.name, tools, env, log, script: script ?? (x.pair?.side === 'before' ? beforeScript(x.steps, env) : null), speak: spoken, narrator });
    const entry = { title: x.title, file: x.t.file, ok: x.pair?.side === 'before' ? true : x.t.ok, headline: x.headline || x.scripted, narrator, ...(x.pair ? { pair: { key: x.pair.key, side: x.pair.side, title: ticketFor(root ?? '.', x.pair.key, config.stateDir).title } } : {}), report: path.join(renderDir, `${x.name}.report.json`) };
    if (!report.ok) {
      entries.push({ ...entry, blocked: report.reason, quality: report.quality ?? null });
      log(`${x.t.file}: ${report.reason}`);
      continue;
    }
    fs.copyFileSync(path.join(renderDir, report.video), path.join(stageDir, `${x.name}.webm`));
    fs.copyFileSync(path.join(renderDir, report.subtitles), path.join(stageDir, `${x.name}.vtt`));
    const preview = makePreview(path.join(stageDir, `${x.name}.webm`), path.join(stageDir, `${x.name}.gif`), tools.ffmpeg) ? `${x.name}.gif` : null;
    entries.push({ ...entry, video: `${x.name}.webm`, vtt: `${x.name}.vtt`, preview, durationSec: report.durationSec, narration: report.narration ? `${report.narration.voice}, speed ${report.narration.speed}` : null, narrationWhyOff: report.narration ? null : report.narrationWhyOff, rendered: path.join(renderDir, report.video), renderedVtt: path.join(renderDir, report.subtitles), secretCheck: report.secretCheck, quality: report.quality ?? null });
  }
  for (const m of missing) entries.unshift({ title: `${m.key}: before the fix`, file: null, ok: false, headline: true, pair: { key: m.key, side: 'before', title: ticketFor(root ?? '.', m.key, config.stateDir).title }, missing: redactText(m.why, { env }).text });
  entries.narratorRuns = narration.runs;
  return entries;
}

// The automatic lines of a before-the-fix recording: the opening says it shows the problem, the failing step says what
// the screen showed instead, and the close names it as the problem the change fixes.
function beforeScript(steps, env) {
  const segs = automaticScript(steps, recordedEvents(steps, { env }));
  if (segs[0]?.role === 'opening') segs[0] = { ...segs[0], text: 'Before the fix: this recording shows the problem the ticket reports.' };
  return [...segs.filter((g) => g.role !== 'close'), { id: 'close', role: 'close', text: 'That is the problem this change fixes.', events: [], auto: true }];
}

// The plan's "Preconditions" of a case, in words (for the ticket's reproduction steps).
function preconditionsOf(file) {
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return (/##\s+Preconditions\s*\n([\s\S]*?)(\n##\s|$)/.exec(text)?.[1] ?? '').replace(/^\s*[-*]\s+/gm, '').replace(/`/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

// Each backend bug's evidence: the case whose base run failed inside its reproduction and whose fixed run passed it,
// its exchanges cleaned (redacted, headers allow-listed, credentials masked, bodies truncated), the wording from the
// narrator (checked against the recording), the ticket's "Reproduction" comment posted or edited in place, and the
// exchanges kept in the run records.
function backendEvidence({ root, config, key, backend, before, afterManifest, settings, runAgent, postComment, env, log, stateDir, renderDir }) {
  const items = [];
  const findings = [];
  for (const b of backend) {
    const ticket = ticketFor(root, b.key, stateDir, { env });
    const verdicts = [];
    let chosen = null;
    for (const id of b.caseIds) {
      const v = before.error ? { ok: false, why: `the before run could not be made: ${before.error}` } : verifyApiBefore({ before: apiTestOfCase(before.manifest, id), after: apiTestOfCase(afterManifest, id), healthy: before.healthy });
      verdicts.push([id, v.why]);
      if (v.ok) {
        chosen = { id, v };
        break;
      }
    }
    if (!chosen) {
      const why = redactText(before.error ? `the before run could not be made: ${before.error}` : verdicts.length > 1 ? `none of its ${verdicts.length} reproduction cases failed at its check on the base (${verdicts.map(([id, w]) => `${id}: ${w}`).join('; ')})` : verdicts[0][1], { env }).text;
      items.push({ key: b.key, title: ticket.title, ev: { ok: false }, why });
      findings.push({ id: `API-NO-REPRO-${b.key}`, severity: 'minor', title: `The bug ${b.key} could not be reproduced before the fix`, detail: why });
      log(`${b.key}: no before evidence: ${why}`);
      continue;
    }
    const c = b.cases.find((x) => x.id === chosen.id);
    const pairs = chosen.v.pairs.map((p) => ({ before: cleanExchange(p.before, settings, { env }), after: cleanExchange(p.after, settings, { env }) }));
    items.push({ key: b.key, title: ticket.title, ticket, case: { title: c.title }, caseId: chosen.id, preconditions: redactText(preconditionsOf(c.file), { env }).text, ev: { ok: true, pairs, base: before.base?.sha ?? null } });
  }
  const ok = items.filter((i) => i.ev.ok);
  const { prose, runs } = writeProse({ config, bugs: ok.map((i) => ({ key: i.key, ticket: i.ticket, case: i.case, preconditions: i.preconditions, pairs: i.ev.pairs })), runAgent, log, env });
  for (const i of ok) {
    i.prose = prose[i.key];
    const body = reproductionComment(i.key, i.ev, i.prose);
    writeText(path.join(renderDir, `${i.key}.reproduction.md`), `${body}\n`);
    writeText(path.join(renderDir, `${i.key}.api-evidence.json`), `${JSON.stringify({ key: i.key, case: i.caseId, base: i.ev.base, pairs: i.ev.pairs, prose: i.prose }, null, 2)}\n`);
    try {
      appendJsonl(metricsFile(config, 'run-conditions.jsonl'), [{ ts: new Date().toISOString(), story: key, kind: 'api-reproduction', ticket: i.key, case: i.caseId, base: i.ev.base, pairs: i.ev.pairs.map((p) => ({ request: `${p.before.method} ${p.before.path}`, before: p.before.status, after: p.after.status })) }]);
    } catch {
      // never stops the evidence
    }
    const hits = scanHits(body, { env });
    if (hits.length) {
      i.comment = { posted: false, why: `the scan gate flagged ${hits.join(', ')}` };
      continue;
    }
    const issue = issueNumberOf(root, i.key, stateDir);
    try {
      i.comment = issue ? { posted: true, ...postComment(issue, body, { marker: REPRO_MARKER(i.key) }) } : { posted: false, why: 'the ticket has no issue in the ticket cache' };
    } catch (error) {
      i.comment = { posted: false, why: redactText(String(error?.message ?? error).split('\n')[0], { env }).text };
    }
    if (!i.comment.posted) log(`${i.key}: the reproduction comment was not posted: ${i.comment.why}`);
  }
  return { items, findings, runs };
}

// The whole local step for one story branch. Returns { video, api, entries, note }. Never opens or edits a PR.
export async function produceLocal({ root, config, base, key, headSha, host, deps = {}, log = defaultLog, env = process.env }) {
  const settings = { specPatterns: [], videosDir: 'artifacts/e2e-videos', storageBranch: 'pr-videos', recordCmd: DEFAULT_RECORD_CMD, ...(config.prVideo ?? {}) };
  const tools = deps.tools ?? resolveTools(config, { env });
  const folder = keyFolder(key);
  const scope = deps.scope ?? changeScope(root, base, config);
  const specs = deps.specs ?? changedSpecs(root, base, settings.specPatterns);
  const publish = deps.publish ?? ((opts) => publishFolder(root, opts));
  const sh = deps.sh ?? ((cmd, e) => spawnSync('sh', ['-c', cmd], { cwd: root, env: e, stdio: 'inherit' }).status);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-local-'));
  // Local only (the factory's state folder is never committed): the rendered videos stay here for the run's report.
  const renderDir = path.join(root, config.stateDir ?? '.factory/state', 'demo-videos', folder);
  fs.mkdirSync(renderDir, { recursive: true });
  const section = (s) => writeText(path.join(stage, 'section.md'), `<!-- head: ${headSha ?? ''} -->\n${s ?? ''}\n`);
  const fileUrl = (file, opts) => host.fileUrl(file, settings.storageBranch, opts);
  try {
    const stateDir = config.stateDir ?? '.factory/state';
    const cases = deps.cases ?? planCases(root, config.plansDir ?? '.factory/plans');
    const pairSettings = bugPairSettings(config);
    const apiSettings = apiEvidenceSettings(config);
    // Backend bugs whose reproduction case a changed spec runs: their requests are captured before and after the fix,
    // whether or not the change also has a browser-visible part.
    const backend = apiSettings.enabled && specs.length ? backendBugs({ root, cases, specs, stateDir }) : [];
    if (!scope.video && !backend.length) {
      // A backend-only change (a backend bug among them) has no browser-visible part: the section says so.
      section(scope.api ? renderSection({ repo: String(host.repo), fileUrl, branch: settings.storageBranch, headSha, note: 'No demo video: this change has no browser-visible part (backend only).', folder, footer: LOCAL_FOOTER }) : '');
      publish({ branch: settings.storageBranch, folder, stageDir: stage, message: `No demo video for ${key}` });
      return { video: null, entries: [], note: 'no frontend change: no demo video' };
    }
    if (!specs.length) {
      const note = `No e2e spec matching \`${settings.specPatterns.join('`, `') || '(prVideo.specPatterns is empty)'}\` changed, so there is no demo video. User-facing changes need one: see the factory's feature-demo-video skill.`;
      section(renderSection({ repo: String(host.repo), fileUrl, branch: settings.storageBranch, headSha, note, folder, footer: LOCAL_FOOTER }));
      publish({ branch: settings.storageBranch, folder, stageDir: stage, message: `Demo video note of ${key}` });
      return { video: 'note', entries: [], note };
    }
    if (scope.video && !tools.ffmpeg) throw new Error('no ffmpeg for the demo video: run `factory video install` (or set video.ffmpeg)');
    const bugs = scope.video && pairSettings.enabled ? uiBugs({ root, cases, specs, stateDir }) : [];
    const videosDir = path.join(root, settings.videosDir);
    const beforeDir = `${videosDir}-before`;
    // `stackRoot`: the checkout whose stack is up; the specs' own stack calls (loading a scenario) go to it.
    const record = (files, grep = null, stackRoot = null) => sh(`${settings.recordCmd.replace('{specs}', files.map((s) => JSON.stringify(s)).join(' '))}${grep ? ` --retries 0 --grep ${JSON.stringify(grep)}` : ''}`, { ...demoEnv(tools, env, { tickets: ticketTitles(root, stateDir), timeoutSec: settings.testTimeoutSec ?? 900 }), ...(stackRoot ? { TESTSTACK_ROOT: stackRoot } : {}) });
    const timing = (side, seconds, extra = {}) => {
      try {
        appendJsonl(metricsFile(config, 'run-conditions.jsonl'), [{ ts: new Date().toISOString(), story: key, kind: 'demo-recording', side, seconds: Math.round(seconds), ...extra }]);
      } catch {
        // a record that cannot be written never stops the video
      }
    };
    // Bugs first: the reproduction against the application built from the merge base (its own checkout and image tags),
    // on the same slot, then the stack goes down and the fixed branch's comes up.
    const before = { manifest: null, healthy: null, base: null, error: null };
    fs.rmSync(beforeDir, { recursive: true, force: true });
    const reproSpecs = [...new Set([...bugs, ...backend].flatMap((b) => b.specs))];
    const reproCases = [...new Set([...bugs, ...backend].flatMap((b) => b.caseIds))];
    if (reproCases.length) {
      const started = Date.now();
      try {
        before.base = (deps.baseCheckout ?? baseCheckout)(root, base, stateDir);
        const up = deps.stackUp ? await deps.stackUp(before.base.dir) : 0;
        if (up !== 0) throw new Error(`the test stack built from the base ${before.base.sha.slice(0, 7)} did not start (exit ${up})`);
        await record(reproSpecs, reproCases.join('|'), before.base.dir);
        before.healthy = deps.stackHealthy ? deps.stackHealthy(before.base.dir) : true;
      } catch (error) {
        before.error = String(error?.message ?? error);
        log(`${key}: the before-the-fix run failed: ${before.error}`);
      } finally {
        deps.stackDown?.(before.base?.dir);
      }
      if (fs.existsSync(videosDir)) fs.renameSync(videosDir, beforeDir);
      before.manifest = readJsonFile(path.join(beforeDir, 'manifest.json'));
      timing('before', (Date.now() - started) / 1000, { bugs: [...bugs, ...backend].map((b) => b.key), base: before.base?.sha ?? null });
    }
    let recorded;
    const started = Date.now();
    try {
      const up = deps.stackUp ? await deps.stackUp(root) : 0;
      if (up !== 0) throw new Error(`the test stack did not start (exit ${up})`);
      // A backend-only change runs only its bugs' reproduction cases (nothing to film).
      recorded = scope.video ? await record(specs) : await record(reproSpecs, backend.flatMap((b) => b.caseIds).join('|'));
    } finally {
      deps.stackDown?.(root, { release: true });
    }
    timing('after', (Date.now() - started) / 1000);
    if (recorded !== 0) log(`${key}: a demo spec failed (exit ${recorded}); its video is marked failed`);
    const runAgent = deps.runAgent ?? defaultRunAgent;
    const entries = scope.video ? renderRecorded({ videosDir, stageDir: stage, renderDir, tools, log, env, root, config, key, runAgent, cases, bugs, before: { ...before, dir: beforeDir } }) : [];
    const api = backendEvidence({ root, config, key, backend, before, afterManifest: readJsonFile(path.join(videosDir, 'manifest.json')), settings: apiSettings, runAgent, postComment: deps.postComment ?? ((issue, body, opts) => trackerFor(config).tickets.comment(issue, body, opts)), env, log, stateDir, renderDir });
    const findings = [
      ...entries.filter((e) => e.pair?.side === 'before' && e.missing).map((e) => ({ id: `DEMO-NO-REPRO-${e.pair.key}`, severity: 'minor', title: `The bug ${e.pair.key} could not be shown before the fix`, detail: e.missing })),
      ...api.findings,
    ];
    const block = pairSettings.requireBefore && findings.length ? `${findings.map((f) => f.title).join('; ')} (${findings.map((f) => f.detail).join('; ')}), and video.bugPair.requireBefore is on` : null;
    const note = scope.video ? (entries.length ? null : 'The changed e2e specs recorded no video (API-only tests have no browser, or the run failed before any test started).') : 'No demo video: this change has no browser-visible part (backend only).';
    const evidence = api.items.length ? evidenceSection(api.items, apiSettings) : '';
    const hits = scanHits(evidence, { env });
    const evidenceText = hits.length ? '## Before the fix / After the fix\n\nNot shown: the scan gate flagged the recorded exchanges (' + hits.join(', ') + ').' : evidence;
    section([renderSection({ repo: String(host.repo), fileUrl, branch: settings.storageBranch, headSha, specs, videos: entries, note, folder, footer: LOCAL_FOOTER }), evidenceText].filter(Boolean).join('\n\n'));
    publish({ branch: settings.storageBranch, folder, stageDir: stage, message: `Demo videos of ${key}${headSha ? ` at ${headSha.slice(0, 7)}` : ''}` });
    log(`${key}: ${entries.filter((e) => !e.blocked).length} demo video(s) published to ${settings.storageBranch}/${folder}${entries.some((e) => e.blocked) ? `; ${entries.filter((e) => e.blocked).length} held back by the secret gate` : ''}${api.items.length ? `; request evidence for ${api.items.map((i) => i.key).join(', ')}` : ''}`);
    return { video: scope.video ? 'published' : null, entries, note, narratorRuns: [...(entries.narratorRuns ?? []), ...api.runs], findings, block, apiEvidence: api.items.map((i) => ({ key: i.key, ok: Boolean(i.ev?.ok), why: i.why ?? null, case: i.caseId ?? null, comment: i.comment ?? null, prose: i.prose?.by ?? null })) };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
