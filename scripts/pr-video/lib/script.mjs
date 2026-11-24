// The narration script of a demo video (docs/ai-pipeline/pr-demo-video.md, "Narration scripts").
//
// A headline demo is narrated from a script the demo-narrator agent writes as prose for a product manager, bound to the
// steps of the first recording: each segment is one or more whole sentences tied to a range of recorded steps, so the
// renderer knows when each sentence is spoken and what the video shows meanwhile. The harness validates every script
// before anything is rendered (coverage, order, grounding, banned content, lengths, the secret detector); an invalid
// script goes back to the agent once with the errors, then the video falls back to the automatic per-step lines.
//
// Everything the agent sees (the ticket, the case, the step list) and everything it writes passes the redaction boundary.
import fs from 'node:fs';
import path from 'node:path';
import { genericHits, redactText } from '../../pipeline/lib/redact.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';

// The defaults are in scripts/pr-video/config.json (`video.script`).
export const SCRIPT_DEFAULTS = defaultSettings().video.script;

export const scriptSettings = (config = {}) => ({ ...SCRIPT_DEFAULTS, ...(config.video?.script ?? {}) });

const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const safe = (t, env) => redactText(clean(t), { env }).text;

// ---- the recorded steps ------------------------------------------------------------------------------------------

const ACTION_KIND = { goto: 'navigate', reload: 'navigate', goBack: 'navigate', goForward: 'navigate', click: 'click', dblclick: 'click', tap: 'click', fill: 'type', type: 'type', pressSequentially: 'type', selectOption: 'choose', check: 'tick', uncheck: 'tick', setChecked: 'tick', press: 'press' };

// The events of a step log (e2e/demo.ts) in time order: user actions, highlights (what a step shows on purpose) and
// passed visible checks. Each has its recorded times in ms: `lead` (the cursor sets off), `at` (the action happens),
// `end` (its result has settled). Logs written before these fields existed get estimates from the pacing.
export function recordedEvents(stepsLog, { env = process.env } = {}) {
  const log = stepsLog ?? {};
  const steps = log.steps ?? [];
  const pacing = log.pacing ?? {};
  // The step log records the pacing it was recorded with (milliseconds; scripts/pr-video/lib/local.mjs).
  const P = defaultSettings().video.pacing;
  const cursorMs = Number(pacing.cursorMs ?? P.cursorSec * 1000);
  const holdMs = Number(pacing.holdMs ?? P.holdSec * 1000);
  const out = [];
  const actions = log.actions ?? [];
  actions.forEach((a, k) => {
    const next = actions[k + 1]?.t;
    const at = a.at ?? a.t;
    const end = a.end ?? Math.min(next ?? Infinity, at + holdMs + 250);
    const kind = ACTION_KIND[a.kind] ?? 'action';
    out.push({
      category: 'action',
      kind,
      raw: a.kind,
      step: a.step,
      lead: Math.max(0, kind === 'navigate' ? a.t : Math.min(a.t, at - cursorMs - 150)),
      at,
      end: Math.max(end, at + 300),
      target: a.target ? { name: safe(a.target.name, env), role: clean(a.target.role) } : null,
      value: a.value ? safe(a.value, env) : null,
      before: a.before ? { page: safe(a.before.page, env), heading: safe(a.before.heading, env) } : null,
      after: a.after ? { page: safe(a.after.page, env), heading: safe(a.after.heading, env) } : null,
      line: safe(steps[a.step]?.caption, env),
    });
  });
  for (const s of steps.filter((x) => x.kind === 'highlight')) {
    const t1 = s.t1 > 0 ? s.t1 : s.t0 + 3500;
    out.push({ category: 'show', kind: 'highlight', step: s.i, lead: s.t0, at: s.t0, end: Math.min(t1, s.t0 + 4000), seen: safe(s.caption, env), line: safe(s.caption, env) });
  }
  const checks = Array.isArray(log.checks)
    ? log.checks.map((c) => ({ t: c.t, step: c.step, line: c.line }))
    : steps.filter((s) => s.kind === 'check').map((s) => ({ t: s.t0, step: s.i, line: s.caption }));
  for (const c of checks) out.push({ category: 'check', kind: 'check', step: c.step, lead: c.t, at: c.t, end: c.t + 300, seen: safe(c.line, env), line: safe(c.line, env) });
  // Where a before-the-fix recording went wrong: what the screen showed at the reproduction check (never what it should
  // have shown).
  if (log.failed?.kind === 'check') {
    const f = log.failed;
    const step = steps.find((x) => x.kind === 'failure')?.i ?? steps.length - 1;
    out.push({ category: 'failure', kind: 'went wrong', step, lead: f.t, at: f.t, end: f.t + 1800, seen: f.observed ? `the screen shows “${safe(f.observed, env)}”` : 'what the flow should lead to does not appear', line: safe(steps[step]?.caption, env), page: f.page ? safe(f.page.page, env) : null });
  }
  out.sort((x, y) => x.at - y.at || x.lead - y.lead);
  return out.map((e, i) => ({ ...e, id: `e${i + 1}` }));
}

// The step list the agent is given: viewer-level facts only, already redacted, with times in seconds.
export function stepListForAgent(events) {
  return events.map((e) => {
    const row = { id: e.id, what: e.category === 'action' ? e.kind : e.category === 'show' ? 'shows' : e.category === 'failure' ? 'went wrong (the bug, as recorded)' : 'check (nothing to do, only seen)' };
    if (e.target) row.target = [e.target.name, e.target.role].filter(Boolean).join(' ') || null;
    if (e.value) row.value = e.value;
    if (e.before) row.on = [e.before.page, e.before.heading && `heading “${e.before.heading}”`].filter(Boolean).join(', ');
    if (e.after && (e.after.page !== e.before?.page || e.after.heading !== e.before?.heading)) row.changed = `now ${[e.after.page, e.after.heading && `heading “${e.after.heading}”`].filter(Boolean).join(', ')}`;
    if (e.seen) row.seen = e.seen;
    row.atSec = Math.round(e.at / 100) / 10;
    row.takesSec = Math.round((e.end - e.lead) / 100) / 10;
    return row;
  });
}

// ---- which videos are headline demos -----------------------------------------------------------------------------

const frontMatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const out = {};
  for (const line of m ? m[1].split('\n') : []) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
};
const coversCount = (v) => {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return v ? 1 : 0;
  }
};

// The cases of every test plan in the checkout: { id, plan (the plan folder's ticket key), type, layer, priority, covers,
// demo, title, why, file }.
export function planCases(root, plansDir = defaultSettings().featureVerification.plansDir) {
  const dir = path.join(root, plansDir);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const folder of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, folder);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).filter((x) => /^TC-.*\.md$/.test(x)).sort()) {
      const text = fs.readFileSync(path.join(full, f), 'utf8');
      const fm = frontMatter(text);
      const id = fm.id ?? f.replace(/-[a-z].*$/, '');
      const plan = /^TC-(.+)-\d+$/.exec(id)?.[1] ?? folder.split('-').slice(0, 2).join('-');
      const title = /^#\s+(?:TC-[A-Z0-9-]+:\s*)?(.+)$/m.exec(text.slice(text.indexOf('\n---', 3) + 4))?.[1]?.trim() ?? id;
      const why = /##\s+Why\s*\n([\s\S]*?)(\n##\s|$)/.exec(text)?.[1]?.trim() ?? '';
      const acs = [...String(fm.covers ?? '').matchAll(/\bAC\s*(\d+)/gi)].map((m) => Number(m[1]));
      out.push({ id, plan, type: fm.type ?? '', layer: fm.layer ?? '', priority: fm.priority ?? 'P9', covers: fm.covers ?? '[]', coversCount: coversCount(fm.covers), firstAc: acs.length ? Math.min(...acs) : 99, demo: fm.demo ?? '', title, why, file: path.join(full, f) });
    }
  }
  return out;
}

// The headline demo of each plan: a case marked `demo: headline` in its front matter, else its main happy-path case
// (the e2e `happy` case of the highest priority, then the one covering the earliest acceptance criterion, the story's
// core, then the one covering most, then the lowest id).
// An epic's plan is a plan like any other: its main journey case is its headline.
export function headlineCases(cases) {
  const byPlan = new Map();
  for (const c of cases.filter((x) => x.layer === 'e2e')) (byPlan.get(c.plan) ?? byPlan.set(c.plan, []).get(c.plan)).push(c);
  const ids = new Set();
  for (const list of byPlan.values()) {
    const marked = list.filter((c) => /^headline$/i.test(c.demo));
    if (marked.length) {
      marked.forEach((c) => ids.add(c.id));
      continue;
    }
    const happy = list.filter((c) => c.type === 'happy');
    const pick = [...happy].sort((a, b) => a.priority.localeCompare(b.priority) || (a.firstAc ?? 99) - (b.firstAc ?? 99) || b.coversCount - a.coversCount || a.id.localeCompare(b.id))[0];
    if (pick) ids.add(pick.id);
  }
  return ids;
}

// The case id a recorded test stands for (its title starts with it: "TC-BRAND-2-01 ...").
export const caseIdOf = (title) => /^(TC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)\b/i.exec(String(title ?? '').trim())?.[1]?.toUpperCase() ?? null;

// ---- the agent's task --------------------------------------------------------------------------------------------

export function narratorTask(videos, s = SCRIPT_DEFAULTS, feedback = null) {
  const lines = [
    'Write the narration script of each demo video below. A product manager will watch these videos to see the change working.',
    '',
    `Limits: at most ${s.maxSegments} segments per video; a segment at most ${s.maxSegmentChars} characters (the opening ${s.maxOpeningChars}, the close ${s.maxCloseChars} and one sentence); at most ${s.maxTotalChars} characters per video; at least ${s.minWordsPerAction} words per user action a segment covers.`,
    '',
    'Answer with exactly one line at the end of your reply:',
    'AGENT_RESULT: {"videos": [{"id": "<video id>", "segments": [{"role": "opening", "text": "...", "from": "e1", "to": "e1"}, {"role": "walk", "text": "...", "from": "e2", "to": "e4"}, {"role": "close", "text": "..."}]}]}',
    '`from`/`to` name the first and last recorded step a segment narrates (`to` may be left out for one step); the opening and the close may name none.',
  ];
  if (feedback) lines.push('', 'Your previous script did not pass the checks. Fix exactly these problems and answer again with every video listed below:', ...feedback.map((f) => `- ${f}`));
  for (const v of videos) {
    lines.push('', `## Video ${v.id}`, '', `Ticket: ${v.ticket.title || '(no title)'}`);
    if (v.ticket.criteria) lines.push('Acceptance criteria:', v.ticket.criteria);
    lines.push(`What this case shows: ${v.case.title}`);
    if (v.case.covers) lines.push(`It covers: ${v.case.covers}`);
    if (v.case.why) lines.push(`Why it matters: ${v.case.why}`);
    if (v.pair?.side === 'before') lines.push(`This is the BEFORE THE FIX recording of a bug, made on the code the fix starts from; video ${v.pair.with ?? '(the after video)'} is the same flow after the fix. Say what the user was trying to do, what they did, and what went wrong, as the problem the customer saw: the step "went wrong" is what the screen actually showed; describe that, never what it should have shown. Use the same words for the same steps as in the after video.`);
    if (v.pair?.side === 'after') lines.push(`This is the AFTER THE FIX recording of a bug${v.pair.with ? `; video ${v.pair.with} is the same flow before the fix` : ''}. Walk the same steps with the same words as the before video, now working, and say what changed for the user.`);
    lines.push('', 'Recorded steps (JSON, in order):', '```json', JSON.stringify(v.steps, null, 1), '```');
  }
  return lines.join('\n');
}

// The AGENT_RESULT payload of an agent's reply, or null.
export function parseResult(output) {
  const line = String(output ?? '').split('\n').reverse().find((l) => l.startsWith('AGENT_RESULT:'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('AGENT_RESULT:'.length).trim());
  } catch {
    return null;
  }
}

// ---- validation --------------------------------------------------------------------------------------------------

export const BANNED = [
  ['a selector', /getBy\w+|locator\(|\bcss=|xpath|>>|\[data-[\w-]+|(^|\s)[#.][a-z][\w-]*\b(?=[\s.,;:]|$)/i],
  ['a raw URL or path', /https?:\/\/|www\.|localhost|(^|\s)\/[\w-]+(\/|\?|\s|$)/i],
  ['a query string', /\?[\w-]+=|&[\w-]+=|\b[\w-]+=[\w-]+/],
  ['a test-case id or ticket key', /\bTC-[A-Z0-9-]+|\b[A-Z][A-Z0-9]+-\d+\b/],
  ['testing vocabulary', /\b(assert\w*|expect\w*|verif(y|ies|ied|ication)|test(s|ed|ing)?|spec|selector|locator|playwright|fixture|step\s?\d+|e\d+)\b/i],
  ['a redaction marker', /\[redacted|redacted:/i],
  ['a count read out as a bare fact', /(^|[.!?]\s+)\d+\s+\w+\s+(are|is)\s+(shown|displayed|visible|listed)\b/i],
  ['markup', /[<>{}`|*_]{1}|\]\(/],
];
const SMALL_WORDS = new Set(['I', 'OK', 'A', 'The', 'This', 'That', 'Then', 'Now', 'Here', 'She', 'He', 'They', 'It', 'When', 'And', 'From', 'With', 'Back', 'Next', 'So']);

// The words a script may name in capitals or in quotes: what the ticket, the case and the recorded steps say.
function vocabulary(video) {
  const parts = [video.ticket.title, video.ticket.criteria, video.case.title, video.case.covers, video.case.why, ...video.steps.flatMap((s) => [s.target, s.value, s.on, s.changed, s.seen])];
  return ` ${parts.filter(Boolean).join(' ').toLowerCase().replace(/[^\p{L}\p{N}$.]+/gu, ' ')} `;
}

// Errors of one video's script (empty: valid). `events`: the video's recorded events; `video`: what the agent was given.
export function validateScript(script, events, video, s = SCRIPT_DEFAULTS, { env = process.env } = {}) {
  const errors = [];
  const segs = Array.isArray(script?.segments) ? script.segments : null;
  if (!segs || segs.length < 2) return ['the script needs an opening, the walk through the flow and a close'];
  if (segs.length > s.maxSegments) errors.push(`${segs.length} segments; at most ${s.maxSegments}`);
  const index = new Map(events.map((e, i) => [e.id, i]));
  if (segs[0].role !== 'opening') errors.push('the first segment must be the opening (role "opening")');
  if (segs.at(-1).role !== 'close') errors.push('the last segment must be the close (role "close")');
  let last = -1;
  let total = 0;
  const covered = new Set();
  const vocab = vocabulary(video);
  segs.forEach((g, n) => {
    const where = `segment ${n + 1}${g.role ? ` (${g.role})` : ''}`;
    const text = clean(g.text);
    total += text.length;
    if (!text) return errors.push(`${where} has no text`);
    if (!['opening', 'walk', 'close'].includes(g.role)) errors.push(`${where}: role must be opening, walk or close`);
    if (n > 0 && n < segs.length - 1 && g.role !== 'walk') errors.push(`${where}: only the first segment is the opening and only the last the close`);
    const max = g.role === 'opening' ? s.maxOpeningChars : g.role === 'close' ? s.maxCloseChars : s.maxSegmentChars;
    if (text.length > max) errors.push(`${where} is ${text.length} characters; at most ${max}`);
    if (!/^["“]?[A-Z]/.test(text) || !/[.!?]["”]?$/.test(text)) errors.push(`${where} must be whole sentences (a capital first, a full stop last)`);
    if (g.role === 'close' && (text.match(/[.!?](\s|$)/g) ?? []).length > 1) errors.push(`${where}: the close is one sentence`);
    for (const [what, re] of BANNED) if (re.test(text)) errors.push(`${where} contains ${what}: "${(re.exec(text)?.[0] ?? '').trim()}"`);
    const r = redactText(text, { env });
    if (r.hits.length || genericHits(text).length) errors.push(`${where} contains something the secret detector flags (${[...new Set([...r.hits, ...(genericHits(text).length ? ['generic-key-pattern'] : [])])].join(', ')})`);
    // Grounding: every quoted phrase and every capitalised word inside a sentence must come from the ticket, the case or
    // the recorded steps.
    for (const m of text.matchAll(/[“"]([^”"]{2,60})[”"]/g)) {
      const phrase = m[1].toLowerCase().replace(/[^\p{L}\p{N}$.]+/gu, ' ').trim();
      if (phrase && !vocab.includes(` ${phrase} `) && !vocab.includes(phrase)) errors.push(`${where} quotes "${m[1]}", which no recorded step, the ticket or the case shows`);
    }
    for (const sentence of text.split(/(?<=[.!?:]["”]?)\s+/)) {
      const words = sentence.split(/\s+/).slice(1);
      for (const raw of words) {
        const w = raw.replace(/^[“"(‘']+|[”")’'.,;:!?]+$/g, '').replace(/['’]s$/, '');
        if (!/^[A-Z]/.test(w) || SMALL_WORDS.has(w)) continue;
        const word = w.toLowerCase();
        if (!vocab.includes(` ${word} `) && !vocab.includes(` ${word}`)) errors.push(`${where} names "${w}", which no recorded step, the ticket or the case shows`);
      }
    }
    const hasFrom = g.from != null && g.from !== '';
    if (!hasFrom) {
      if (g.role === 'walk') errors.push(`${where} names no recorded step (from)`);
      return;
    }
    const a = index.get(g.from);
    const b = index.get(g.to ?? g.from);
    if (a == null) return errors.push(`${where}: "${g.from}" is not a recorded step`);
    if (b == null) return errors.push(`${where}: "${g.to}" is not a recorded step`);
    if (b < a) return errors.push(`${where}: "${g.to}" comes before "${g.from}"`);
    if (a <= last) errors.push(`${where} starts at ${g.from}, which an earlier segment already narrates (segments follow the steps in order)`);
    last = Math.max(last, b);
    const actions = events.slice(a, b + 1).filter((e) => e.category === 'action');
    actions.forEach((e) => covered.add(e.id));
    const words = text.split(/\s+/).length;
    if (actions.length > 1 && words < actions.length * s.minWordsPerAction) errors.push(`${where} covers ${actions.length} user actions in ${words} words; give them at least ${actions.length * s.minWordsPerAction} words or more segments`);
  });
  if (total > s.maxTotalChars) errors.push(`the script is ${total} characters; at most ${s.maxTotalChars}`);
  for (const g of segs) {
    const a = index.get(g.from);
    const b = a == null ? null : index.get(g.to ?? g.from);
    if (a != null && b != null) events.slice(a, b + 1).filter((e) => e.category === 'failure').forEach((e) => covered.add(e.id));
  }
  const failure = events.find((e) => e.category === 'failure');
  if (failure && !covered.has(failure.id)) errors.push(`no segment narrates what went wrong (${failure.id}); the before video must show and say the problem as recorded`);
  // A before-the-fix script never states the expected result as what happened.
  for (const word of video.forbid ?? []) if (word && segs.some((g) => clean(g.text).toLowerCase().includes(word.toLowerCase()))) errors.push(`the script says "${word}", which is what the screen should have shown, not what it showed before the fix`);
  const missing = events.filter((e) => e.category === 'action' && !covered.has(e.id)).map((e) => e.id);
  if (missing.length) errors.push(`no segment narrates the user action(s) ${missing.join(', ')}`);
  return errors;
}

// The script bound to events, as the renderer takes it: [{ id, role, text, events: [event], auto }].
export function bindScript(script, events) {
  const index = new Map(events.map((e, i) => [e.id, i]));
  return script.segments.map((g, n) => {
    const a = g.from != null && g.from !== '' ? index.get(g.from) : null;
    const b = a == null ? null : index.get(g.to ?? g.from);
    return { id: `g${n + 1}`, role: g.role, text: clean(g.text), events: a == null ? [] : events.slice(a, b + 1), auto: false };
  });
}

// ---- the fallback: the automatic per-step lines ------------------------------------------------------------------

const norm = (t) => String(t ?? '').toLowerCase().replace(/^(now|then|next)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'page', 'open', 'opened', 'click', 'with', 'now', 'and', 'shown', 'are', 'is']);
const significant = (t) => norm(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
// One line says what the other says (the same significant words: "Now on the home page, with brand 1" and "Now at the
// home page, with brand 1").
export function sameLine(x, y) {
  const a = significant(x);
  const b = significant(y);
  if (!a.length || !b.length) return norm(x) === norm(y);
  return a.length === b.length && a.every((w) => b.includes(w));
}

// The automatic lines of a step log as a script: one segment per narrated step, bound to the events that step narrates
// (its actions, its highlight, its checks). Consecutive lines that say the same thing become one (one step, one line;
// the spec's own wording wins).
export function automaticScript(stepsLog, events) {
  const steps = (stepsLog?.steps ?? []).filter((s) => s.caption);
  const segs = [];
  for (const s of steps) {
    const mine = events.filter((e) => e.step === s.i);
    const role = s.kind === 'intro' ? 'opening' : s.kind === 'outcome' ? 'close' : 'walk';
    const prev = segs.at(-1);
    if (prev && prev.role === 'walk' && role === 'walk' && sameLine(prev.text, s.caption)) {
      if (!s.auto) prev.text = s.caption;
      prev.events.push(...mine);
      prev.window = prev.window ?? null;
      continue;
    }
    segs.push({ id: `s${s.i}`, role, text: clean(s.caption), events: mine, auto: true, window: mine.length ? null : [s.t0, s.t1 > 0 ? s.t1 : s.t0 + 1500] });
  }
  return segs;
}

// ---- the narrator run --------------------------------------------------------------------------------------------

// The ticket as the narrator reads it: its title and what it asks for (the cached story without its implementation
// notes), redacted. Missing cache: the key only.
export function ticketFor(root, key, stateDir = '.factory/state', { env = process.env, maxChars = 1800 } = {}) {
  const file = path.join(root, stateDir, 'board', key ?? '', 'story.md');
  if (!key || !fs.existsSync(file)) return { key, title: '', criteria: '' };
  const text = fs.readFileSync(file, 'utf8');
  const title = /^#\s*[^:\n]+:\s*(.+)$/m.exec(text)?.[1]?.replace(/^(\[[^\]]*\]\s*-?\s*)+/, '').trim() ?? '';
  const body = text.split('\n').slice(1).join('\n').split(/\n##\s+Implementation Notes/i)[0];
  const ac = /##\s+Acceptance criteria\s*\n([\s\S]*?)(\n##\s|$)/i.exec(body)?.[1] ?? body;
  return { key, title: safe(title, env), criteria: redactText(ac.trim(), { env }).text.slice(0, maxChars) };
}

// Writes the scripts of `videos` ([{ name, title, steps (the step log) }]) with the demo-narrator agent: one run for all
// of them, one more for the ones whose script failed validation (with the errors), then the automatic lines. Never
// throws. Returns { scripts: { name: segments }, fallback: { name: why }, runs: [{ ok, seconds, usage }] }.
export function scriptVideos({ root, config, videos, runAgent, settings = scriptSettings(config), stateDir = '.factory/state', cases = null, env = process.env, log = () => {} }) {
  const scripts = {};
  const fallback = {};
  const runs = [];
  if (!videos.length) return { scripts, fallback, runs };
  if (settings.scope === 'none') {
    for (const v of videos) fallback[v.name] = 'narration by agent is off (video.script.scope "none")';
    return { scripts, fallback, runs };
  }
  const allCases = cases ?? planCases(root);
  const inputs = videos.map((v, i) => {
    const id = caseIdOf(v.title);
    const c = allCases.find((x) => x.id === id) ?? { title: v.title.replace(/^TC-\S+\s+/, ''), covers: '', why: '', plan: /^TC-(.+)-\d+$/.exec(id ?? '')?.[1] ?? null };
    const events = recordedEvents(v.steps, { env });
    const ticket = ticketFor(root, c.plan, stateDir, { env });
    const f = v.steps?.failed;
    const observed = String(f?.observed ?? '').toLowerCase();
    const forbid = v.pair?.side === 'before' ? [...String(f?.line ?? '').matchAll(/“([^”]+)”/g)].map((m) => m[1]).filter((w) => !observed.includes(w.toLowerCase())) : [];
    return { name: v.name, pair: v.pair ?? null, events, forbid, given: { id: `v${i + 1}`, ticket, case: { title: safe(c.title, env), covers: safe(c.covers === '[]' ? '' : c.covers, env), why: safe(c.why, env).slice(0, 600) }, steps: stepListForAgent(events) } };
  });
  // The two videos of a bug are a pair: each names the other.
  for (const x of inputs) {
    if (!x.pair) continue;
    const other = inputs.find((y) => y !== x && y.pair?.key === x.pair.key);
    x.given.pair = { side: x.pair.side, with: other?.given.id ?? null };
  }
  let pending = inputs;
  let feedback = null;
  const story = videos[0]?.key ?? null;
  for (let round = 1; round <= 2 && pending.length; round++) {
    let res;
    try {
      res = runAgent(config, { name: 'demo-narrator', task: narratorTask(pending.map((p) => p.given), settings, feedback), mode: 'read', timeoutSec: settings.timeoutSec, usage: { stage: 'demo-narration', story, round, step: 'narration scripts' } });
    } catch (error) {
      res = { ok: false, error: String(error?.message ?? error).split('\n')[0] };
    }
    runs.push({ round, ok: Boolean(res?.ok), seconds: res?.seconds ?? null, usage: res?.usage ?? null });
    const answer = res?.ok ? parseResult(res.output) : null;
    if (!res?.ok || !answer) {
      const why = !res?.ok ? `the narrator agent is unavailable (${res?.error ?? (res?.timedOut ? 'timed out' : res?.outage ? res.outage : `exit ${res?.status}`)})` : 'the narrator agent returned no script';
      for (const p of pending) fallback[p.name] = why;
      log(`demo narration: ${why}; ${pending.length} video(s) use the automatic lines`);
      return { scripts, fallback, runs };
    }
    const errorsByVideo = [];
    for (const p of pending) {
      const script = (answer.videos ?? []).find((x) => x?.id === p.given.id);
      const errors = script ? validateScript(script, p.events, { ...p.given, forbid: p.forbid }, settings, { env }) : ['no script for this video'];
      if (!errors.length) scripts[p.name] = bindScript(script, p.events);
      else errorsByVideo.push({ p, errors });
    }
    pending = errorsByVideo.map((x) => x.p);
    feedback = errorsByVideo.flatMap((x) => x.errors.map((e) => `video ${x.p.given.id}: ${e}`));
    if (pending.length && round === 2) {
      for (const x of errorsByVideo) fallback[x.p.name] = `the script failed validation twice (${x.errors.slice(0, 3).join('; ')}${x.errors.length > 3 ? '; …' : ''})`;
      log(`demo narration: ${pending.length} script(s) failed validation twice; they use the automatic lines`);
    }
  }
  return { scripts, fallback, runs };
}
