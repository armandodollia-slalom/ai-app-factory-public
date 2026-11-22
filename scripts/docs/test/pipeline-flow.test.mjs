// Guards for the pipeline explorer (docs/pipeline-explorer.html) and its data (docs/pipeline-flow.json): every setting is
// the code's (same config path, allowed values and default, read from the code's own defaults and schema modules), every
// doc link resolves, the graph is whole, the page carries the current data and evaluator and loads nothing from the
// network, and the evaluator gives what the runner's rules say for the cases the docs describe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PATHS, evaluatorScript, extract, inline } from '../build-explorer.mjs';
import * as F from '../lib/flow-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = path.join(ROOT, 'docs');
const flow = JSON.parse(fs.readFileSync(PATHS.data, 'utf8'));
const html = fs.readFileSync(PATHS.html, 'utf8');
const node = (id) => flow.nodes.find((n) => n.id === id);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const at = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const mod = async (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const usageOf = async (rel) => {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return /const USAGE = `([\s\S]*?)`;/.exec(text)?.[1] ?? text;
};
const ev = (input, choices) => F.evaluate(flow, input, choices);
const pathOf = (e) => e.walk.steps.filter((s) => !s.skipped).map((s) => s.node);

// ---- settings against the code ----------------------------------------------------------------------------------------

test('every setting matches the code: config path or flag, allowed values and default come from the code', async () => {
  for (const s of flow.settings) {
    assert.ok(Array.isArray(s.checks) && s.checks.length, `${s.id}: no checks against the code`);
    assert.ok(['scenario', 'config', 'cli'].includes(s.kind), `${s.id}: kind`);
    if (s.kind === 'config') assert.ok(s.config, `${s.id}: a config setting names its config path`);
    if (s.kind === 'cli') assert.ok(s.flag, `${s.id}: a CLI setting names its flag`);
    if (s.type === 'enum') assert.ok(s.values.includes(s.default), `${s.id}: default is one of its values`);
    for (const c of s.checks) {
      const where = `${s.id}: ${JSON.stringify(c)}`;
      if (c.json) {
        const value = at(readJson(c.json), c.path);
        if (c.absent) assert.equal(value, undefined, `${where}: expected no default in the file (the code's fallback applies)`);
        else if (c.exists) assert.notEqual(value, undefined, where);
        else if (c.keysInclude) assert.deepEqual(Object.keys(value).filter((k) => s.values.includes(k)).sort(), [...s.values].sort(), where);
        else assert.deepEqual(value, s.default, where);
      } else if (c.module) {
        const m = await mod(c.module);
        assert.ok(c.export in m, `${where}: no export ${c.export}`);
        const value = m[c.export];
        if (c.exists) continue;
        if (c.values) assert.deepEqual(Array.isArray(value) ? value : Object.keys(value), s.values, `${where}: allowed values`);
        else if (c.hasKey) assert.ok(Object.hasOwn(value, c.hasKey), where);
        else if (c.call) {
          const out = value(...c.call);
          assert.deepEqual(c.path ? at(out, c.path) : out, 'expect' in c ? c.expect : s.default, where);
        } else assert.deepEqual(c.path ? at(value, c.path) : value, s.default, where);
      } else if (c.usage) {
        const usage = await usageOf(c.usage);
        if (c.includes) assert.ok(usage.includes(c.includes), `${where}: not in the CLI usage`);
        if (c.flagValues) {
          const m = new RegExp(`${c.flagValues} ([\\w|-]+)`).exec(usage);
          assert.ok(m, `${where}: flag not in the CLI usage`);
          assert.deepEqual(m[1].split('|'), s.values, `${where}: the CLI's values`);
        }
      } else if (c.code) {
        const text = fs.readFileSync(path.join(ROOT, c.code), 'utf8');
        if (c.includes) assert.ok(text.includes(c.includes), `${where}: not in the code`);
        if (c.literals) for (const v of s.values) if (!c.except?.[v]) assert.ok(text.includes(`'${v}'`), `${where}: '${v}' is not a literal in the code`);
      } else assert.fail(`${where}: unknown check`);
    }
  }
});

test('the council settings are exactly the council stages of the code', async () => {
  const { COUNCIL_STAGES } = await mod('scripts/pipeline/lib/council-config.mjs');
  assert.deepEqual(flow.settings.filter((s) => s.seat).map((s) => s.seat), Object.keys(COUNCIL_STAGES));
  for (const s of flow.settings.filter((x) => x.seat)) assert.equal(s.config, `council.stages.${s.seat}`);
});

test('the branch-pipeline capability of each CI system is the adapter\'s', async () => {
  const { CI_PROVIDERS } = await mod('scripts/pipeline/lib/products.mjs');
  assert.deepEqual(Object.keys(flow.branchPipelines).filter((k) => !k.startsWith('$')), CI_PROVIDERS);
  const fact = flow.facts.find((f) => f.id === 'branchPipelines').is.any[0].in[1];
  for (const p of CI_PROVIDERS) {
    if (p === 'custom') {
      assert.equal(flow.branchPipelines.custom, null, 'custom: declared by the adapter');
      continue;
    }
    const { CAPABILITIES } = await mod(`scripts/pipeline/lib/ci/${p}.mjs`);
    assert.equal(flow.branchPipelines[p], CAPABILITIES.branchPipelines, p);
    assert.equal(fact.includes(p), CAPABILITIES.branchPipelines === true, `${p}: the branchPipelines fact`);
  }
});

// ---- doc links ---------------------------------------------------------------------------------------------------------

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered.
export function anchorsOf(markdown) {
  const out = new Set();
  const seen = new Map();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

const checkLink = (link, from = DOCS) => {
  const [file, anchor] = link.split('#');
  const abs = path.resolve(from, file);
  assert.ok(fs.existsSync(abs), `${link}: ${path.relative(ROOT, abs)} does not exist`);
  if (anchor) assert.ok(anchorsOf(fs.readFileSync(abs, 'utf8')).has(anchor), `${link}: no heading #${anchor} in ${path.relative(ROOT, abs)}`);
};

test('every doc link and anchor in the data resolves to a file and heading', () => {
  for (const x of [...flow.settings, ...flow.nodes]) {
    assert.ok(x.doc && !/^[a-z]+:/i.test(x.doc), `${x.id}: a relative doc link`);
    checkLink(x.doc);
  }
});

test('the page\'s own relative links resolve', () => {
  const links = [...html.matchAll(/href="([^"#][^"]*)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 2);
  for (const l of links) checkLink(l);
});

// ---- the graph is whole ------------------------------------------------------------------------------------------------

const refs = new Set([...flow.settings.map((s) => s.id), ...flow.facts.map((f) => f.id)]);
const conditions = () => [
  ...flow.nodes.map((n) => [n.id, n.when]),
  ...flow.edges.map((e) => [`${e.from}->${e.to}`, e.when]),
  ...flow.decisions.flatMap((d) => d.outcomes.map((o) => [`${d.id}.${o.id}`, o.when])),
  ...flow.entries.map((e) => [`entry ${e.node}`, e.when]),
  ...flow.facts.map((f) => [`fact ${f.id}`, f.is ?? { select: f.select }]),
  ...flow.normalize.map((r, i) => [`normalize ${i}`, r.when]),
  ...flow.settings.map((s) => [`setting ${s.id}`, s.onlyWhen]),
];

test('ids are unique and every reference exists', () => {
  const ids = [...flow.nodes.map((n) => n.id), ...(flow.spineGroups ?? []).map((g) => g.id)];
  assert.equal(new Set(ids).size, ids.length, 'node and group ids are unique');
  for (const d of flow.decisions) assert.equal(d.id, d.at, `${d.id}: a decision carries its step's id`);
  for (const g of flow.spineGroups ?? []) for (const id of g.members) assert.equal(node(id)?.kind, 'exit', `${g.id}: ${id} is an exit`);
  assert.equal(new Set(flow.settings.map((s) => s.id)).size, flow.settings.length, 'setting ids are unique');
  for (const id of ids) assert.match(id, /^[a-z][A-Za-z0-9]{1,15}$/, `${id}: a short id`);
  for (const [where, c] of conditions()) for (const r of F.refsOf(c)) assert.ok(refs.has(r), `${where}: unknown reference ${r}`);
  for (const n of flow.nodes) {
    assert.ok(flow.kinds[n.kind], `${n.id}: kind`);
    assert.ok(n.desc && n.label, `${n.id}: label and description`);
    for (const s of n.settings ?? []) assert.ok(flow.settings.some((x) => x.id === s), `${n.id}: unknown setting ${s}`);
    assert.ok(n.lane === null || n.lane === undefined || flow.lanes.includes(n.lane), `${n.id}: lane`);
  }
  for (const e of flow.edges) {
    assert.ok(node(e.from) && node(e.to), `edge ${e.from}->${e.to}`);
    if (e.loop?.budget) assert.ok(flow.settings.some((s) => s.id === e.loop.budget), `edge ${e.from}->${e.to}: budget`);
  }
  for (const d of flow.decisions) {
    assert.equal(node(d.at)?.decision, d.id, `${d.id}: its node names it`);
  }
  for (const n of flow.nodes.filter((x) => x.decision)) assert.ok(flow.decisions.some((d) => d.id === n.decision && d.at === n.id), `${n.id}: decision ${n.decision}`);
});

test('every node is reachable from an entry, and every non-end node leads somewhere', () => {
  const seen = new Set();
  const queue = flow.entries.map((e) => e.node);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of flow.edges.filter((x) => x.from === id)) queue.push(e.to);
  }
  assert.deepEqual(flow.nodes.map((n) => n.id).filter((id) => !seen.has(id)), []);
  for (const n of flow.nodes) {
    if (n.kind === 'exit' || n.end || n.kind === 'service') continue;
    assert.ok(flow.edges.some((e) => e.from === n.id && e.type !== 'uses'), `${n.id} leads nowhere`);
  }
});

test('every decision outcome leads somewhere, and only decision nodes branch on outcomes', () => {
  for (const d of flow.decisions) {
    for (const o of d.outcomes) assert.ok(flow.edges.some((e) => e.from === d.at && e.outcome === o.id), `${d.id}.${o.id} leads nowhere`);
  }
  for (const e of flow.edges.filter((x) => x.outcome)) {
    const d = flow.decisions.find((x) => x.at === e.from);
    assert.ok(d?.outcomes.some((o) => o.id === e.outcome), `${e.from}->${e.to}: outcome ${e.outcome} is not one of ${d?.id ?? 'no decision'}`);
  }
  for (const n of flow.nodes.filter((x) => !x.decision)) assert.ok(!flow.edges.some((e) => e.from === n.id && e.outcome), `${n.id} has outcome edges but no decision`);
});

test('every exit says what remains and how to continue', () => {
  const exits = flow.nodes.filter((n) => n.kind === 'exit');
  assert.ok(exits.length >= 10);
  for (const x of exits) {
    for (const k of ['branch', 'ticket', 'pr']) assert.ok(String(x.remains?.[k] ?? '').trim(), `${x.id}: remains.${k}`);
    assert.ok(String(x.continue ?? '').trim(), `${x.id}: continue`);
    assert.ok(Array.isArray(x.outcome) && x.outcome.length, `${x.id}: the run outcome(s)`);
    assert.ok(!flow.edges.some((e) => e.from === x.id && e.type !== 'uses'), `${x.id}: an exit ends the walk`);
  }
});

// Configurations that between them switch every node on: the presets, and each of them with one setting changed.
const variations = () => {
  const out = [];
  for (const p of flow.presets) {
    out.push(p.values);
    for (const s of flow.settings) {
      const vals = s.type === 'boolean' ? [true, false] : s.type === 'enum' ? s.values : [s.min ?? 0, s.default];
      for (const v of vals) out.push({ ...p.values, [s.id]: v });
    }
  }
  return out;
};

test('every node runs in some configuration and every exit is reached by some walk', () => {
  const active = new Set();
  const configs = variations();
  for (const c of configs) for (const [id, st] of Object.entries(ev(c).nodes)) if (st.state === 'active') active.add(id);
  assert.deepEqual(flow.nodes.map((n) => n.id).filter((id) => !active.has(id)), []);
  for (const x of flow.nodes.filter((n) => n.kind === 'exit')) {
    const into = flow.edges.filter((e) => e.to === x.id && e.outcome);
    // The outcome into the exit, alone or with the outcome that reaches its decision (a hold is reached only when a
    // check fails after the open).
    const choiceSets = into.flatMap((e) => {
      const own = { [node(e.from).decision]: e.outcome };
      const before = flow.edges.filter((p) => p.to === e.from && p.outcome).map((p) => ({ [node(p.from).decision]: p.outcome, ...own }));
      return [own, ...before];
    });
    const found = configs.some((c) => choiceSets.some((ch) => ev(c, ch).walk.end === x.id));
    assert.ok(found, `${x.id}: no walk ends there`);
  }
});

// ---- the page ----------------------------------------------------------------------------------------------------------

test('the page carries the current data and evaluator (run node scripts/docs/build-explorer.mjs)', () => {
  const now = extract(html);
  assert.deepEqual(now.data, flow, 'the inlined data equals docs/pipeline-flow.json');
  assert.equal(now.evaluator, evaluatorScript(fs.readFileSync(PATHS.evaluator, 'utf8')), 'the inlined evaluator equals scripts/docs/lib/flow-eval.mjs');
  assert.equal(inline(html, { data: fs.readFileSync(PATHS.data, 'utf8'), evaluator: fs.readFileSync(PATHS.evaluator, 'utf8') }), html);
});

test('the page loads nothing from the network: no external script, style, font or image', () => {
  const loads = [
    ...html.matchAll(/<(?:script|img|iframe|source|video|audio|embed)\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi),
    ...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi),
    // url(#marker) points inside the page; anything else would load something
    ...html.matchAll(/url\(\s*["'`]?(?!#)([^"'`)]+)/gi),
    ...html.matchAll(/@import\s+["']?([^"';\s]+)/gi),
    ...html.matchAll(/\b(?:fetch|XMLHttpRequest|importScripts|EventSource|WebSocket)\s*\(/g),
  ].map((m) => m[1] ?? m[0]);
  assert.deepEqual(loads, []);
  assert.doesNotMatch(html, /<script[^>]+type=["']module/i, 'classic scripts only (file:// pages cannot use inline module imports)');
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)/gi)) assert.doesNotMatch(m[1], /^(?:[a-z]+:)?\/\//i, `external reference ${m[1]}`);
});

// ---- the evaluator against the runner's rules -------------------------------------------------------------------------

test('defaults, single feature ticket with --pr: PR check, push, CI proof, open, a person reviews; no rating, no evidence', () => {
  const e = ev({ pr: true });
  const p = pathOf(e);
  for (const id of ['run', 'claim', 'plan', 'verifier', 'review', 'fv', 'prCheck', 'push', 'ownerQ', 'branchCi', 'open', 'checks', 'runDone', 'gate', 'approval', 'merged']) assert.ok(p.includes(id), id);
  for (const id of ['epicPlan', 'triage', 'headScan', 'evidence', 'uiPair', 'apiEvidence', 'apiChanges', 'gatePublish', 'analysisGate', 'analysisFix', 'ready']) assert.notEqual(e.nodes[id].state === 'active' && p.includes(id), true, id);
  assert.equal(e.decisions.gate.default, 'person');
  assert.equal(e.walk.end, 'merged');
  assert.deepEqual(e.walk.steps.filter((s) => s.node === 'testPlan').map((s) => s.lane), ['Testing']);
  assert.equal(e.walk.steps.find((s) => s.node === 'open').lane, 'Pending Review');
});

test('without --pr the run ends done with no PR (the CLI default)', () => {
  const e = ev({});
  assert.equal(e.values.pr, false);
  assert.equal(e.walk.end, 'doneNoPr');
  assert.equal(e.nodes.open.state, 'off');
});

test('UI bug: the before/after pair; requireBefore turns a missing reproduction into demo-video-blocked', () => {
  const base = { ticket: 'ui-bug', changes: 'frontend', pr: true, demoVideo: true };
  const e = ev(base);
  assert.equal(e.nodes.uiPair.state, 'active');
  assert.equal(e.nodes.evidence.state, 'active');
  assert.notEqual(e.nodes.apiEvidence.state, 'active');
  assert.notEqual(e.nodes.apiChanges.state, 'active', 'no backend change: no API changes section');
  assert.ok(pathOf(e).includes('triage'), 'a bug is triaged before the open');
  assert.equal(ev(base, { uiPair: 'missing' }).walk.end, 'merged', 'without requireBefore: a note, the PR opens');
  assert.equal(ev({ ...base, requireBefore: true }, { uiPair: 'missing' }).walk.end, 'videoBlocked');
  assert.equal(ev({ ...base, demoVideo: false }).nodes.uiPair.state, 'skipped', 'no demo video: no pair');
});

test('backend bug: request evidence and API changes, no video; requireBefore stops it on missing API evidence too', () => {
  const base = { ticket: 'backend-bug', changes: 'backend', pr: true, demoVideo: true };
  const e = ev(base);
  assert.equal(e.nodes.apiEvidence.state, 'active');
  assert.equal(e.nodes.apiChanges.state, 'active');
  assert.equal(e.nodes.evidence.state, 'skipped');
  assert.equal(e.nodes.uiPair.state, 'skipped');
  assert.equal(ev({ ...base, requireBefore: true }, { apiEvidence: 'missing' }).walk.end, 'videoBlocked');
});

test('API changes appear for any backend change, mixed frontend and backend included (classifyFiles)', async () => {
  const { classifyFiles } = await mod('scripts/pr-video/lib/api-summary.mjs');
  const project = { services: [{ name: 'api', kind: 'backend', paths: ['api/**'] }, { name: 'web', kind: 'frontend', paths: ['web/**'] }] };
  assert.equal(classifyFiles(['api/a.cs', 'web/b.tsx'], { project }).api, true);
  const e = ev({ ticket: 'feature', changes: 'both', pr: true, demoVideo: true });
  assert.equal(e.nodes.apiChanges.state, 'active');
  assert.equal(e.nodes.evidence.state, 'active');
});

test('a UI bug normalizes a backend-only change to frontend and backend; epics normalize the ticket kind', () => {
  assert.equal(F.resolve(flow, { ticket: 'ui-bug', changes: 'backend' }).values.changes, 'both');
  assert.equal(F.resolve(flow, { entry: 'feature-epic', ticket: 'backend-bug' }).values.ticket, 'feature');
  assert.equal(F.resolve(flow, { entry: 'bug-epic', ticket: 'feature' }).values.ticket, 'ui-bug');
});

test('council off vs on: the same steps run; the config fragment seats the stage', () => {
  const off = ev({ pr: true });
  const on = ev({ pr: true, 'council.review': true, 'council.prCheck': true });
  assert.deepEqual(pathOf(on), pathOf(off));
  const frag = F.configFragment(flow, { 'council.review': true, 'council.prCheck': true })['.factory/config.json'];
  assert.deepEqual(Object.keys(frag.council.stages), ['review', 'prCheck']);
  assert.ok(frag.council.members.length);
  assert.deepEqual(F.configFragment(flow, {}), {});
});

test('auto-merge: only a bug PR, Low, high confidence, with autoMerge.enabled; otherwise the approvals its severity needs', () => {
  const bug = { ticket: 'ui-bug', pr: true };
  assert.equal(ev(bug).decisions.gate.default, 'auto-merge');
  assert.ok(pathOf(ev(bug)).includes('autoMerge'));
  for (const change of [{ autoMerge: false }, { severity: 'Medium' }, { confidence: 'low' }]) {
    const e = ev({ ...bug, ...change });
    assert.deepEqual(e.decisions.gate.available, ['approvals'], JSON.stringify(change));
    assert.ok(pathOf(e).includes('approval'));
  }
  assert.equal(ev({ ...bug, severity: 'High', 'approvals.High': 2 }).facts.approvalsNeeded, 2);
  assert.deepEqual(ev({ pr: true }).decisions.gate.available, ['person'], 'a feature PR is not rated');
  // No agent after the open: an unreadable rating is published as not assessed, and the walk goes on to the PR's checks.
  const missing = pathOf(ev(bug, { gatePublish: 'missing' }));
  assert.equal(missing[missing.indexOf('gatePublish') + 1], 'checks', 'no saved rating: no triage after the open');
  assert.equal(missing.filter((id) => node(id).kind === 'agent' && missing.indexOf(id) > missing.indexOf('open')).length, 0, 'no agent after the open');
});

test('epic shapes: explicit grouping first, then a strict bug majority, then --pr-split; --delivery story bypasses units', async () => {
  const { deliveryShape } = await mod('scripts/implement/lib/epic-plan.mjs');
  const feats = [{ key: 'A-1', type: 'story' }, { key: 'A-2', type: 'story' }];
  const bugs = [{ key: 'B-1', type: 'bug' }, { key: 'B-2', type: 'bug' }, { key: 'B-3', type: 'story' }];
  const cases = [
    [{ entry: 'feature-epic' }, deliveryShape(feats, 'auto', 'epic'), 'shapeEpic'],
    [{ entry: 'feature-epic', prSplit: 'story' }, deliveryShape(feats, 'auto', 'story'), 'shapeFeatureGroups'],
    [{ entry: 'feature-epic', prSplit: 'groups' }, deliveryShape(feats, 'auto', 'groups'), 'shapeFeatureGroups'],
    [{ entry: 'feature-epic', grouping: 'ticket', prSplit: 'story' }, deliveryShape(feats, 'ticket', 'story'), 'shapeBugGroups'],
    [{ entry: 'bug-epic', prSplit: 'story' }, deliveryShape(bugs, 'auto', 'story'), 'shapeBugGroups'],
    [{ entry: 'bug-epic', grouping: 'epic' }, deliveryShape(bugs, 'epic', 'epic'), 'shapeEpic'],
  ];
  for (const [input, shape, fact] of cases) {
    const e = ev({ ...input, pr: true });
    assert.equal(e.facts[fact], true, `${JSON.stringify(input)} -> ${fact}`);
    assert.equal(shape.kind === 'epic', fact === 'shapeEpic', JSON.stringify(input));
    assert.equal(Boolean(shape.feature), fact === 'shapeFeatureGroups', JSON.stringify(input));
  }
  const story = ev({ entry: 'feature-epic', prSplit: 'story', pr: true });
  assert.equal(story.nodes.epicPlan.state, 'active', 'a story split still plans the design note');
  assert.equal(story.nodes.prCheck.state, 'off', 'units skip the per-ticket PR check');
  assert.ok(['unit', 'journeys', 'unitPrCheck', 'parity', 'branchCi', 'open'].every((id) => pathOf(story).includes(id)));
  assert.equal(story.facts.bugUnit, false, 'feature groups are feature PRs: no rating');
  assert.equal(ev({ entry: 'feature-epic', grouping: 'ticket', pr: true }).nodes.epicPlan.state, 'skipped', 'grouping ticket: no planner');
  assert.equal(ev({ entry: 'bug-epic', pr: true }).facts.bugUnit, true, 'bug groups are rated');
  // As the code runs it (epic.mjs runParity) and ci-parity.md says: a feature epic delivered as one PR runs parity first.
  assert.ok(pathOf(ev({ entry: 'feature-epic', prSplit: 'epic', pr: true })).includes('parity'), 'the feature epic\'s one PR runs parity before it opens (other-34)');
  const perStory = ev({ entry: 'feature-epic', delivery: 'story', pr: true });
  assert.equal(perStory.facts.epicRun, false);
  assert.ok(pathOf(perStory).includes('prCheck'));
  assert.equal(ev({ entry: 'bug-epic', pr: true }, { journeys: 'failed' }).walk.end, 'unitFailed');
});

test('a CI system without branch pipelines: no proof before the open, the PR opens as a draft and is marked ready when green', () => {
  const e = ev({ pr: true, ciProvider: 'azure-pipelines' });
  assert.equal(e.facts.draftFirst, true);
  assert.equal(e.nodes.branchCi.state, 'skipped');
  assert.ok(pathOf(e).includes('ready'), 'ready only when green');
  assert.equal(ev({ pr: true, ciProvider: 'custom' }).facts.draftFirst, true);
  assert.equal(ev({ pr: true, ciProvider: 'custom', ciCustomBranchPipelines: true }).facts.proveOnBranch, true);
  const off = ev({ pr: true, ciWait: false });
  assert.equal(off.nodes.branchCi.state, 'skipped');
  assert.equal(off.nodes.checks.state, 'skipped');
  assert.equal(off.facts.draftFirst, false, 'ciWait off: opens ready, without the proof');
});

test('the failure exits: each stops where the runner stops, with what remains', () => {
  const pr = { pr: true };
  const cases = [
    [pr, { claim: 'skipped' }, 'skipped'],
    [{ entry: 'feature-epic', pr: true }, { epicPlan: 'failed' }, 'epicFailed'],
    [pr, { plan: 'rejected' }, 'implFailed'],
    [pr, { verifier: 'exhausted' }, 'implFailed'],
    [pr, { review: 'escalated' }, 'reviewFailed'],
    [pr, { fv: 'failed' }, 'fvFailed'],
    [pr, { prCheck: 'unresolved' }, 'unresolved'],
    [pr, { parity: 'failed' }, 'notDelivered'],
    [{ pr: true, analysis: true }, { analysisGate: 'blocked' }, 'blocked'],
    [pr, { ownerQ: 'question' }, 'needsDecision'],
    [pr, { ownerQ: 'incomplete' }, 'prcIncomplete'],
    [pr, { branchCi: 'red', ciFixRound: 'red' }, 'ciRed'],
    [{ pr: true, ciFixRounds: 0 }, { branchCi: 'red' }, 'ciRed'],
    [pr, { open: 'refused' }, 'prRefused'],
    [{ ticket: 'ui-bug', pr: true }, { triage: 'failed' }, 'gateAssessFailed'],
    [pr, { checks: 'failed', hold: 'unconfirmed' }, 'holdFailed'],
    [{ pr: true, ciProvider: 'azure-pipelines' }, { ready: 'unconfirmed' }, 'releaseUnconf'],
    [{ entry: 'resume', pr: true }, { resume: 'reopened', reopenHold: 'unconfirmed' }, 'holdFailed'],
    [{ entry: 'resume', pr: true }, { resume: 'held', ready: 'unconfirmed' }, 'releaseUnconf'],
    [{ pr: true, draftCycles: 2 }, { checks: 'failed', holdFix: ['again', 'failed'] }, 'heldFailed'],
    [pr, { checks: 'failed', holdFix: 'failed' }, 'heldFailed'],
    [{ pr: true, draftCycles: 0 }, { checks: 'failed' }, 'heldFailed'],
    [{ pr: true, ciFixRounds: 0 }, { checks: 'failed' }, 'heldFailed'],
  ];
  for (const [input, choices, exit] of cases) {
    const e = ev(input, choices);
    assert.equal(e.walk.end, exit, `${JSON.stringify(choices)} with ${JSON.stringify(input)}`);
    assert.equal(e.walk.lane, node(exit).lane ?? e.walk.steps.at(-2)?.lane ?? null);
  }
  // The owner question is asked after the push, never before it (implement.mjs deliverFinished).
  const q = pathOf(ev(pr, { ownerQ: 'question' }));
  assert.ok(q.indexOf('push') < q.indexOf('ownerQ') && q.at(-1) === 'needsDecision');
  // The PR check's returns loop back once and the walk still delivers.
  const back = ev(pr, { prCheck: 'production' });
  assert.equal(pathOf(back).filter((id) => id === 'pairs').length, 2);
  assert.equal(back.walk.steps.find((s) => s.node === 'pairs' && s.visit === 2).lane, 'In Progress');
  assert.equal(back.walk.end, 'merged');
  assert.ok(!ev({ pr: true, returnEnabled: false }).decisions.prCheck.available.includes('production'), 'returns off: everything to the fixer');
});

test('resume and requeue re-enter where the run stopped', () => {
  const r = { entry: 'resume', pr: true };
  assert.equal(ev(r).walk.steps[0].node, 'resume');
  const refused = pathOf(ev(r, { resume: 'refused' }));
  assert.ok(!refused.some((id) => ['plan', 'pairs', 'harnessChecks', 'verifier', 'policy', 'review', 'testPlan', 'fv', 'prCheck'].includes(id)), 'pr-refused: no implementation, review or test agents');
  assert.equal(ev(r, { resume: 'refused' }).walk.steps[1].node, 'analysisGate', 'replayed from the analysis gate (skipped without analysis) and the push');
  assert.equal(refused[1], 'push');
  assert.equal(pathOf(ev({ ...r, analysis: true }, { resume: 'refused' }))[1], 'analysisGate');
  assert.equal(pathOf(ev(r, { resume: 'ci-wait' }))[1], 'checks');
  assert.equal(pathOf(ev(r, { resume: 'adopted' }))[1], 'checks');
  assert.equal(pathOf(ev(r, { resume: 'held' }))[1], 'checks', 'an unconfirmed hold or release resumes at the CI wait');
  assert.equal(ev(r, { resume: 'gate-failed' }).walk.steps[1].node, 'analysisGate', 'gate-assessment-failed replays the delivery');
  assert.equal(pathOf(ev(r, { resume: 'approved' }))[1], 'testPlan');
  assert.deepEqual(pathOf(ev(r, { resume: 'resolved' })).slice(1, 5), ['requeue', 'claim', 'entry', 'plan']);
  assert.deepEqual(pathOf(ev(r, { resume: 'reopened' })).slice(1, 5), ['requeue', 'claim', 'reopenHold', 'entry']);
  // A reviewer who sends the PR back starts the ticket again with the open PR held.
  const sent = ev({ ticket: 'ui-bug', pr: true, severity: 'High' }, { approval: 'sent-back' });
  const p = pathOf(sent);
  assert.ok(p.indexOf('sentBack') > 0 && p.indexOf('reopenHold') > p.indexOf('sentBack'));
  assert.equal(sent.walk.end, 'merged');
});

// ---- routes the docs promise (resume with a hold, re-delivery, bypasses, the post-open fixing loop) ---------------------

test('no step is switched on or off by a walk fact: only edges and outcomes read them', () => {
  const walkFacts = new Set(flow.facts.filter((f) => f.walk).map((f) => f.id));
  assert.ok(walkFacts.has('heldPr'));
  for (const n of flow.nodes) for (const r of F.refsOf(n.when)) assert.ok(!walkFacts.has(r), `${n.id}: ${r}`);
  for (const e of flow.edges.filter((x) => x.set)) for (const k of Object.keys(e.set)) assert.ok(walkFacts.has(k), `${e.from}->${e.to}: sets ${k}`);
});

test('a green resumed wait with a hold still recorded goes through the release, with the CI wait on or off', () => {
  for (const input of [{ entry: 'resume', pr: true }, { entry: 'resume', pr: true, ciWait: false }]) {
    const e = ev(input, { resume: 'held' });
    const p = pathOf(e);
    assert.ok(p.indexOf('ready') > 0 && p.indexOf('ready') < p.indexOf('runDone'), `${JSON.stringify(input)}: release before done`);
    assert.equal(e.walk.end, 'merged');
    assert.equal(ev(input, { resume: 'held', ready: 'unconfirmed' }).walk.end, 'releaseUnconf', `${JSON.stringify(input)}: release-unconfirmed`);
  }
  assert.equal(ev({ entry: 'resume', pr: true, ciWait: false }, { resume: 'held' }).walk.steps.find((s) => s.node === 'checks').skipped, true, 'no wait with ciWait off');
  // Without a recorded hold a resumed GitHub Actions wait has nothing to release.
  assert.ok(!pathOf(ev({ entry: 'resume', pr: true }, { resume: 'ci-wait' })).includes('ready'));
});

test('a reopened ticket with --pr: requeue, claim, hold confirmed, the same PR updated, then released; without --pr no hold', () => {
  const r = { entry: 'resume', ticket: 'ui-bug', pr: true };
  const e = ev(r, { resume: 'reopened' });
  const p = pathOf(e);
  assert.deepEqual(p.slice(0, 5), ['resume', 'requeue', 'claim', 'reopenHold', 'entry']);
  assert.equal(e.walk.steps.find((s) => s.node === 'open').outcome, 'updated', 'the held PR is updated, never opened twice');
  assert.deepEqual(e.walk.steps.find((s) => s.node === 'open').available, ['updated']);
  assert.ok(p.indexOf('ready') > p.indexOf('open') && p.indexOf('ready') < p.indexOf('runDone'), 'released when green');
  assert.equal(e.walk.end, 'merged');
  assert.equal(ev(r, { resume: 'reopened', reopenHold: 'unconfirmed' }).walk.end, 'holdFailed', 'no agent before a confirmed hold');
  assert.equal(ev(r, { resume: 'reopened', triage: 'failed' }).walk.end, 'gateAssessFailed', 'a held re-delivery can end gate-assessment-failed, its PR still held');
  const local = ev({ ...r, pr: false }, { resume: 'reopened' });
  assert.ok(!pathOf(local).includes('reopenHold'), 'without --pr nothing is held');
  assert.equal(local.walk.end, 'doneNoPr');
  // A resolved ticket with no open PR runs again with nothing held, and opens a new PR.
  const resolved = ev(r, { resume: 'resolved' });
  assert.ok(!pathOf(resolved).includes('reopenHold'));
  assert.equal(resolved.walk.steps.find((s) => s.node === 'open').outcome, 'opened');
  // A PR sent back runs again the same way: held, updated, released.
  const sent = ev({ ticket: 'ui-bug', pr: true, severity: 'High' }, { approval: 'sent-back' });
  const sp = pathOf(sent);
  assert.deepEqual(sp.slice(sp.indexOf('sentBack'), sp.indexOf('sentBack') + 4), ['sentBack', 'requeue', 'claim', 'reopenHold']);
  assert.deepEqual(sent.walk.steps.filter((s) => s.node === 'open').map((s) => s.outcome), ['opened', 'updated']);
});

test('static analysis off: no pre-push analysis gate and no analysis fixing round', () => {
  const off = ev({ pr: true });
  assert.equal(off.nodes.analysisGate.state, 'skipped');
  assert.equal(off.nodes.analysisFix.state, 'off');
  const on = ev({ pr: true, analysis: true }, { analysisGate: 'finding' });
  assert.deepEqual(pathOf(on).filter((id) => ['analysisGate', 'analysisFix', 'push'].includes(id)), ['analysisGate', 'analysisFix', 'analysisGate', 'push']);
});

test('the post-open fixing loop: another round on hold while cycles are left; only an exhausted budget exits', () => {
  const two = { pr: true, draftCycles: 2 };
  const e = ev(two, { checks: 'failed', holdFix: ['again', 'green'] });
  const p = pathOf(e);
  assert.equal(p.filter((id) => id === 'holdFix').length, 2, 'two fixing cycles');
  assert.equal(p.filter((id) => id === 'hold').length, 1, 'one hold, kept for the second round');
  assert.equal(e.walk.end, 'merged');
  assert.deepEqual(e.walk.steps.filter((s) => s.node === 'holdFix').map((s) => s.available), [['green', 'again'], ['green', 'failed']], 'failed only once every cycle is used');
  assert.equal(ev(two, { checks: 'failed', holdFix: ['again', 'failed'] }).walk.end, 'heldFailed');
  assert.equal(ev(two, { checks: 'failed', holdFix: 'failed' }).walk.end, 'merged', 'a failure with a cycle left is not offered as the end');
  assert.deepEqual(ev({ pr: true }, { checks: 'failed' }).walk.steps.find((s) => s.node === 'holdFix').available, ['green', 'failed'], 'one cycle: no second round');
  const back = F.decodeHash(flow, F.encodeHash(flow, two, { holdFix: ['again', 'green'] }));
  assert.deepEqual(back.choices.holdFix, ['again', 'green'], 'a list of outcomes round-trips through the URL hash');
});

// The "removed" view and the step details read the same walk state as the walk: a held PR set on the way, and the visit.
const collapsed = (e, from, outcome) => e.edges.filter((x) => x.from === from && x.outcome === outcome && x.live).flatMap((x) => x.effectiveTos);
const possible = (view) => view.visits.map((v) => v.outcomes.filter((o) => o.possible).map((o) => o.id));

test('removed view: a held resume with the CI wait off still collapses into the release, never straight to done', () => {
  for (const input of [{ entry: 'resume', pr: true, ciWait: false }, { entry: 'resume', pr: true }]) {
    const e = ev(input, { resume: 'held' });
    const target = input.ciWait === false ? 'ready' : 'checks';
    assert.deepEqual(collapsed(e, 'resume', 'held'), [target], `${JSON.stringify(input)}: the held edge leads where the walk goes`);
    const p = pathOf(e);
    assert.equal(p[1], target, 'the walk agrees');
  }
  // The same edge without a recorded hold (a plain resumed wait) still goes to done with the wait off.
  assert.deepEqual(collapsed(ev({ entry: 'resume', pr: true, ciWait: false }, { resume: 'ci-wait' }), 'resume', 'ci-wait'), ['runDone']);
});

test('step details: the outcomes and destinations are those of the walk\'s visit', () => {
  // A reopened ticket's open: only the update of the same PR, and it leads on to the CI wait.
  const re = ev({ entry: 'resume', ticket: 'ui-bug', pr: true }, { resume: 'reopened' });
  const open = F.decisionView(flow, re, 'open');
  assert.equal(open.onWalk, true);
  assert.deepEqual(possible(open), [['updated']], 'no new open, refusal or failed open on a held re-delivery');
  assert.equal(open.visits[0].outcome, 'updated');
  // A fresh delivery's open offers the open and its failures, not the update.
  assert.deepEqual(possible(F.decisionView(flow, ev({ pr: true }), 'open')), [['opened', 'refused', 'failed']]);
  // Two fixing cycles: the first visit offers another round, never the exhausted budget; the second offers it.
  const two = { pr: true, draftCycles: 2 };
  assert.deepEqual(possible(F.decisionView(flow, ev(two, { checks: 'failed', holdFix: ['again', 'green'] }), 'holdFix')), [['green', 'again'], ['green', 'failed']]);
  const first = F.decisionView(flow, ev(two, { checks: 'failed' }), 'holdFix');
  assert.equal(first.visits.length, 1);
  assert.equal(first.visits[0].outcomes.find((o) => o.id === 'failed').possible, false, 'first visit of two: budget not spent');
  // A held resume with the wait off: the release's outcomes include release-unconfirmed.
  const held = F.decisionView(flow, ev({ entry: 'resume', pr: true, ciWait: false }, { resume: 'held' }), 'ready');
  assert.ok(possible(held)[0].includes('unconfirmed'));
  assert.deepEqual(held.visits[0].outcomes.find((o) => o.id === 'unconfirmed').to, ['releaseUnconf']);
  // Off the walk: what the configuration allows in any walk state, with the budget said.
  const off = F.decisionView(flow, ev(two), 'holdFix');
  assert.equal(off.onWalk, false);
  assert.deepEqual(off.visits[0].outcomes.map((o) => [o.id, o.budget?.kind ?? null]), [['green', null], ['again', 'left'], ['failed', 'used']]);
  // The page draws and details from these, not from the configuration's start state.
  assert.match(html, /E\.decisionView\(flow, ev, n\.id\)/);
  assert.match(html, /e\.effectiveTos/);
});

test('the configuration round-trips through the URL hash, and the command line matches it', () => {
  const input = { entry: 'feature-epic', prSplit: 'story', pr: true, 'council.review': true, maxReturns: 3 };
  const hash = F.encodeHash(flow, input, { prCheck: 'light' }, { view: 'remove' });
  const back = F.decodeHash(flow, hash);
  assert.deepEqual(F.resolve(flow, back.input).values, F.resolve(flow, input).values);
  assert.deepEqual(back.choices, { prCheck: 'light' });
  assert.equal(back.view.view, 'remove');
  assert.equal(F.decodeHash(flow, '#prSplit=nonsense&prCheck=bogus').input.prSplit, 'epic', 'invalid values fall back');
  assert.equal(F.cliCommand(flow, input), 'factory implement run --epic <EPIC> --pr-split story --pr');
  assert.equal(F.cliCommand(flow, { pr: true, ciFixRounds: 0 }), 'PIPELINE_CI_FIX_ROUNDS=0 factory implement run <KEY> --pr');
  for (const p of flow.presets) assert.ok(F.cliCommand(flow, p.values).startsWith('factory implement '), p.id);
});

test('council discussion: no step without a seated council or without the intercom; with both, one shared step and its four outcomes', () => {
  const view = (e) => Object.fromEntries(F.decisionView(flow, e, 'discussion').visits[0].outcomes.map((o) => [o.id, o.possible ? o.to.sort() : null]));
  assert.notEqual(ev({ pr: true, 'council.intercom.enabled': true }).nodes.discussion.state, 'active', 'no council seated: no discussion');
  const councilOnly = ev({ pr: true, 'council.review': true });
  assert.notEqual(councilOnly.nodes.discussion.state, 'active', 'council on, intercom off: no discussion');
  assert.equal(councilOnly.decisions.review.available.includes('owner'), false);

  const both = { pr: true, 'council.review': true, 'council.intercom.enabled': true };
  const e = ev(both);
  assert.equal(e.nodes.discussion.state, 'active');
  assert.ok(e.edges.some((x) => x.from === 'review' && x.to === 'discussion' && x.live), 'the review council uses it');
  assert.equal(e.edges.some((x) => x.from === 'prCheck' && x.to === 'discussion' && x.live), false, 'a stage without a council does not');
  // Settled and "not held or interrupted" continue in the stage; a split here goes to the owner (no model rules in review).
  assert.deepEqual(view(e), { settled: ['councilMerge'], ruled: null, owner: ['reviewFailed'], unavailable: ['councilMerge'] });
  assert.deepEqual(pathOf(e), pathOf(ev({ pr: true })), 'settled: the same steps run');
  assert.equal(ev(both, { review: 'owner' }).walk.end, 'reviewFailed', 'owner question: the review stops for a person');

  // Where a model rules on splits (pairs, PR check), and per stage where an owner question stops.
  const all = { pr: true, 'council.intercom.enabled': true, 'council.pairVerify': true, 'council.testPlan': true, 'council.testAutomation': true, 'council.prCheck': true };
  assert.deepEqual(view(ev(all)), { settled: ['councilMerge'], ruled: ['councilMerge'], owner: ['fvFailed', 'implFailed', 'needsDecision'], unavailable: ['councilMerge'] });
  assert.equal(view(ev({ ...all, 'council.intercom.onSplit': 'owner' })).ruled, null, 'onSplit owner: no ruling');
  assert.equal(ev(all, { verifier: 'owner' }).walk.end, 'implFailed');
  assert.equal(ev(all, { testPlan: 'owner' }).walk.end, 'fvFailed');
  assert.equal(ev(all, { fv: 'owner' }).walk.end, 'fvFailed');
  assert.equal(ev(all, { ownerQ: 'question' }).walk.end, 'needsDecision', 'the PR check\'s owner question stops before the PR opens');
  const frag = F.configFragment(flow, both)['.factory/config.json'];
  assert.deepEqual(frag.council.intercom, { enabled: true });
});
