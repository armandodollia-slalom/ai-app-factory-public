// Narration scripts (owner feedback on the 0.2.88 videos): headline demos are narrated from a script the demo-narrator
// agent writes as prose for a product manager, bound to the recorded steps; the harness validates it (coverage, order,
// grounding, banned content, lengths, secrets), sends it back once with the errors, then falls back to the automatic
// lines; the headline demos are chosen from the test plan; one step gets one line. A scripted agent stands in for the
// model.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { automaticScript, bindScript, headlineCases, planCases, recordedEvents, sameLine, scriptVideos, SCRIPT_DEFAULTS, stepListForAgent, validateScript } from '../lib/script.mjs';
import { verifyBefore } from '../lib/bugpair.mjs';
import { scriptedNarrator } from './narrator-stub.mjs';

const log = {
  version: 1,
  pacing: { cursorMs: 600, holdMs: 1500 },
  steps: [
    { i: 0, kind: 'intro', caption: 'This video shows the Daybird card.', t0: 0, t1: 100 },
    { i: 1, kind: 'auto:goto', caption: 'Open the Brands page', t0: 100, t1: 2000, auto: true },
    { i: 2, kind: 'auto:click', caption: 'Click the Daybird card', t0: 2000, t1: 5000, auto: true },
    { i: 3, kind: 'check', caption: 'Now on the home page, with brand 1.', t0: 5000, t1: 6000, auto: true },
    { i: 4, kind: 'caption', caption: 'Now at the home page, with brand 1', t0: 6000, t1: 7000 },
    { i: 5, kind: 'outcome', caption: 'Result: as expected.', t0: 7000, t1: 8000 },
  ],
  actions: [
    { t: 100, at: 100, end: 1900, kind: 'goto', step: 1, before: { page: 'the home page', heading: '' }, after: { page: 'the Brands page', heading: 'Brands' } },
    { t: 2000, at: 2700, end: 4500, kind: 'click', step: 2, target: { name: 'Daybird', role: 'card' }, before: { page: 'the Brands page', heading: 'Brands' }, after: { page: 'the home page, with brand 1', heading: 'Brand: Daybird' } },
  ],
  checks: [{ t: 4600, step: 3, line: '“10 products” is shown', matcher: 'toHaveText' }],
};
const events = recordedEvents(log);
const video = { id: 'v1', ticket: { title: 'From a brand card to that brand\'s products', criteria: 'Selecting a brand card opens the catalog filtered to that brand.' }, case: { title: 'Selecting the Daybird card opens the catalog filtered to Daybird', covers: '', why: '' }, steps: stepListForAgent(events) };
const good = { id: 'v1', segments: [
  { role: 'opening', text: 'Shoppers who know the brand they want should reach its products in one step.', from: 'e1' },
  { role: 'walk', text: 'On the Brands page, the shopper picks the Daybird card, and the catalog now shows only Daybird products under the heading Brand: Daybird.', from: 'e2', to: 'e3' },
  { role: 'close', text: 'One click takes the shopper from a brand to everything it sells.' },
] };

test('the step list the agent gets: viewer facts only, in order, with what changed', () => {
  assert.deepEqual(events.map((e) => [e.id, e.category, e.kind]), [['e1', 'action', 'navigate'], ['e2', 'action', 'click'], ['e3', 'check', 'check']]);
  const click = video.steps[1];
  assert.equal(click.target, 'Daybird card');
  assert.match(click.changed, /now the home page, with brand 1, heading “Brand: Daybird”/);
  assert.equal(video.steps[2].seen, '“10 products” is shown');
  assert.equal(video.steps[2].what, 'check (nothing to do, only seen)');
});

test('a valid script passes and binds each sentence to its steps', () => {
  assert.deepEqual(validateScript(good, events, video), []);
  const bound = bindScript(good, events);
  assert.deepEqual(bound.map((g) => [g.role, g.events.map((e) => e.id)]), [['opening', ['e1']], ['walk', ['e2', 'e3']], ['close', []]]);
});

test('validation: coverage, order, grounding, banned content, lengths and secrets', () => {
  const errs = (segments) => validateScript({ id: 'v1', segments }, events, video).join('\n');
  const [o, w, c] = good.segments;
  assert.match(errs([{ ...o, from: undefined }, w, c]), /no segment narrates the user action\(s\) e1/);
  assert.match(errs([o, { ...w, from: 'e1', to: 'e3' }, c]), /already narrates/);
  assert.match(errs([o, { ...w, from: 'e3', to: 'e2' }, c]), /comes before/);
  assert.match(errs([o, { ...w, from: 'e9' }, c]), /"e9" is not a recorded step/);
  assert.match(errs([w, o, c]), /first segment must be the opening/);
  const bad = (text) => errs([o, { ...w, text }, c]);
  assert.match(bad('The shopper clicks getByRole link and sees the catalog filtered to Daybird.'), /a selector/);
  assert.match(bad('The shopper lands on /?brand=1 with the Daybird filter applied.'), /raw URL or path|query string/);
  assert.match(bad('This proves TC-BRAND-2-01 for the Daybird card on the Brands page.'), /test-case id or ticket key/);
  assert.match(bad('We assert that the Daybird card opens the filtered catalog as expected.'), /testing vocabulary/);
  assert.match(bad('The Daybird card opens the catalog. 10 products are shown.'), /count read out as a bare fact/);
  assert.match(bad('The shopper picks the Daybird card and lands on the Zebra Outlet page.'), /names "Zebra", which no recorded step/);
  assert.match(bad('The shopper picks the “Gold Members” card and the catalog follows along nicely.'), /quotes "Gold Members"/);
  assert.match(bad('the shopper picks the Daybird card'), /whole sentences/);
  assert.match(bad(`The shopper picks the Daybird card ${'and waits '.repeat(40)}.`), /characters; at most 280/);
  // A token of the shape a code host issues, made at run time (never a literal in the repository).
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const token = ['gh', 'p_', ...[...crypto.randomBytes(36)].map((b) => abc[b % abc.length])].join('');
  assert.match(bad(`The Daybird card shows ${token} to the shopper on the Brands page.`), /secret detector flags/);
  assert.match(errs([o, { ...w, text: 'Daybird card, then the catalog.', from: 'e1', to: 'e3' }, c]), /covers 2 user actions in 5 words/);
});

test('the headline demos come from the test plan: a marked case, else the main e2e happy path; the epic journey too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
  const write = (folder, id, fm) => {
    fs.mkdirSync(path.join(root, '.factory/plans', folder), { recursive: true });
    fs.writeFileSync(path.join(root, '.factory/plans', folder, `${id}-x.md`), `---\nid: ${id}\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# ${id}: title of ${id}\n\n## Why\n\n- because\n`);
  };
  write('BRAND-1-x', 'TC-BRAND-1-01', { type: 'happy', layer: 'api', priority: 'P1', covers: '["AC1","AC2","AC3"]' });
  write('BRAND-1-x', 'TC-BRAND-1-04', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC1"]' });
  write('BRAND-1-x', 'TC-BRAND-1-06', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC1","AC2"]' });
  write('BRAND-1-x', 'TC-BRAND-1-05', { type: 'happy', layer: 'e2e', priority: 'P2', covers: '["AC1","AC2","AC3"]' });
  write('BRAND-3-x', 'TC-BRAND-3-11', { type: 'sad', layer: 'e2e', priority: 'P1', covers: '["AC1","AC2","AC3"]' });
  write('BRAND-3-x', 'TC-BRAND-3-08', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC2"]' });
  write('BRAND-3-x', 'TC-BRAND-3-09', { type: 'happy', layer: 'e2e', priority: 'P2', covers: '["AC2"]', demo: 'headline' });
  // PR #363 at 0.2.89 picked TC-BRAND-2-09 (two criteria named, both of AC3) over TC-BRAND-2-01 (AC1, the story's core).
  write('BRAND-2-x', 'TC-BRAND-2-01', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC1: selecting a brand\'s card opens the catalog filtered to that brand"]' });
  write('BRAND-2-x', 'TC-BRAND-2-09', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC3: more than one brand selected shows the usual title", "Implementation Notes: two brand query values"]' });
  write('EPIC-359-brands', 'TC-EPIC-359-01', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC1","AC1b","AC1c"]' });
  write('EPIC-359-brands', 'TC-EPIC-359-03', { type: 'happy', layer: 'e2e', priority: 'P1', covers: '["AC2"]' });
  const cases = planCases(root);
  assert.equal(cases.find((c) => c.id === 'TC-BRAND-1-04').title, 'title of TC-BRAND-1-04');
  assert.deepEqual([...headlineCases(cases)].sort(), ['TC-BRAND-1-06', 'TC-BRAND-2-01', 'TC-BRAND-3-09', 'TC-EPIC-359-01']);
});

test('one narrator run for every headline video, one retry with the errors, then the automatic lines; costs recorded as their own stage', () => {
  const videos = [{ name: 'a', title: 'TC-BRAND-2-01 Selecting the Daybird card', steps: log, key: 'feat/x' }, { name: 'b', title: 'TC-BRAND-2-02 Same, second video', steps: log, key: 'feat/x' }];
  const config = { agent: { models: { automation: 'sonnet' } } };
  // a: valid at once; b: invalid twice (a raw path).
  const stub = scriptedNarrator({ write: (v) => (v.id === 'v2' ? { id: 'v2', segments: [good.segments[0], { ...good.segments[1], text: 'The shopper goes to /brands and picks the Daybird card there.' }, good.segments[2]] } : { ...good, id: v.id }) });
  const r = scriptVideos({ root: os.tmpdir(), config, videos, runAgent: stub.runAgent, cases: [] });
  assert.deepEqual(Object.keys(r.scripts), ['a']);
  assert.match(r.fallback.b, /the script failed validation twice \(segment 2 \(walk\) contains a raw URL or path/);
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(stub.calls.map((c) => [c.name, c.mode, c.model, c.usage.stage, c.usage.round]), [['demo-narrator', 'read', 'sonnet', 'demo-narration', 1], ['demo-narrator', 'read', 'sonnet', 'demo-narration', 2]]);
  assert.match(stub.tasks[1], /did not pass the checks[\s\S]*video v2: segment 2 \(walk\) contains a raw URL/);
  assert.ok(!/## Video v1/.test(stub.tasks[1]), 'the retry carries only the videos that failed');
  // An unavailable agent, and narration by agent switched off: every video falls back, and says why.
  const down = scriptVideos({ root: os.tmpdir(), config, videos, runAgent: scriptedNarrator({ fail: { ok: false, status: 1, outage: 'usage limit reached' } }).runAgent, cases: [] });
  assert.match(down.fallback.a, /the narrator agent is unavailable \(usage limit reached\)/);
  const off = scriptVideos({ root: os.tmpdir(), config: { video: { script: { scope: 'none' } } }, videos, runAgent: () => assert.fail('no agent when off'), cases: [] });
  assert.match(off.fallback.b, /narration by agent is off/);
  // The model is configurable; the default is the test-automation model.
  const own = scriptedNarrator();
  scriptVideos({ root: os.tmpdir(), config: { ...config, video: { script: { model: 'haiku' } } }, videos: videos.slice(0, 1), runAgent: own.runAgent, cases: [] });
  assert.equal(own.calls[0].model, 'haiku');
});

test('one step, one line: a caption that says what the assertion line said replaces it (the 0.2.88 "Now on" / "Now at" pair)', () => {
  assert.ok(sameLine('Now on the home page, with brand 1.', 'Now at the home page, with brand 1'));
  assert.ok(!sameLine('Click "Brands" in the header', 'Now on the Brands page.'));
  const segs = automaticScript(log, events);
  assert.deepEqual(segs.map((g) => g.text), ['This video shows the Daybird card.', 'Open the Brands page', 'Click the Daybird card', 'Now at the home page, with brand 1', 'Result: as expected.']);
  assert.ok(SCRIPT_DEFAULTS.scope === 'headline' && SCRIPT_DEFAULTS.speakEvidence === false);
});

test('a bug\'s before-the-fix run counts only when it failed at the check the after run passes, after the same actions, on a healthy stack', () => {
  const after = { steps: { actions: log.actions, checks: log.checks } };
  const failed = { ...log, failed: { t: 4600, kind: 'check', matcher: 'toHaveText', line: '“10 products” is shown', observed: '0 products', actionsBefore: 2 } };
  assert.deepEqual(verifyBefore({ test: { ok: false }, steps: failed, after, healthy: true }), { ok: true, why: null });
  assert.match(verifyBefore({ test: { ok: true }, steps: log, after, healthy: true }).why, /does not reproduce on the base/);
  assert.match(verifyBefore({ test: { ok: false }, steps: { ...log, failed: { t: 2500, kind: 'action', what: 'click', actionsBefore: 1 } }, after, healthy: true }).why, /failed at an earlier step \(the click action after 1 action\(s\)\)/);
  assert.match(verifyBefore({ test: { ok: false }, steps: failed, after, healthy: false }).why, /not healthy/);
  assert.match(verifyBefore({ test: { ok: false }, steps: { ...log, failed: undefined }, after, healthy: true }).why, /outside the flow/);
  assert.match(verifyBefore({ test: { ok: false }, steps: { ...failed, failed: { ...failed.failed, line: '“Brand: Daybird” is shown' } }, after, healthy: true }).why, /a check the after run does not pass/);
  assert.match(verifyBefore({ test: { ok: false }, steps: { ...failed, actions: [log.actions[0], { ...log.actions[1], target: { name: 'Gravitator' } }] }, after, healthy: true }).why, /other actions/);
  // The before script never states the expected result as what happened.
  const ev = recordedEvents({ ...failed, steps: [...log.steps.slice(0, 3), { i: 3, kind: 'failure', caption: 'Instead, the screen shows “0 products”.', t0: 4600, t1: 6000 }] });
  assert.equal(ev.at(-1).category, 'failure');
  assert.equal(ev.at(-1).seen, 'the screen shows “0 products”');
  const vid = { ...video, steps: stepListForAgent(ev), forbid: ['10 products'] };
  const fid = ev.at(-1).id;
  const segs = [good.segments[0], { role: 'walk', text: 'On the Brands page, the shopper picks the Daybird card to see its products.', from: 'e2' }];
  assert.match(validateScript({ segments: [...segs, good.segments[2]] }, ev, vid).join('\n'), new RegExp(`no segment narrates what went wrong \\(${fid}\\)`));
  assert.match(validateScript({ segments: [...segs, { role: 'walk', text: 'The catalog lists 10 products for Daybird, just as it should.', from: fid }, good.segments[2]] }, ev, vid).join('\n'), /says "10 products", which is what the screen should have shown/);
  assert.deepEqual(validateScript({ segments: [...segs, { role: 'walk', text: 'Instead of Daybird\'s range, the catalog shows 0 products, so the shopper is stuck.', from: fid }, good.segments[2]] }, ev, vid), []);
});
