// The Mermaid spine of the generated pipeline (scripts/docs/build-explorer.mjs --mermaid) and the check that keeps a
// Markdown page's marked copy of it in step with docs/pipeline-flow.json. Point checkSpine at any Markdown text; a page
// without the markers passes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spineMarkdown } from '../build-explorer.mjs';
import { SPINE_END, SPINE_START, checkSpine, cutLabel, mermaidIds, mermaidSpine, nodeTable, spineEdges, spineNodes } from '../lib/spine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/pipeline-flow.json'), 'utf8'));
const block = (mermaid) => `# Page\n\n${SPINE_START}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${SPINE_END}\n`;

test('the compact spine carries every decision, every spine step and group, and passes its own check', () => {
  const ids = mermaidIds(mermaidSpine(flow));
  for (const d of flow.decisions) assert.ok(ids.has(d.id), d.id);
  for (const n of spineNodes(flow)) assert.ok(ids.has(n.id), n.id);
  for (const g of flow.spineGroups) assert.ok(ids.has(g.id), g.id);
  assert.equal(ids.size, spineNodes(flow).length + flow.spineGroups.length);
  for (const n of flow.nodes.filter((x) => x.spine === false)) assert.ok(!ids.has(n.id), `${n.id} is left out of the compact spine`);
  assert.ok(ids.size <= 50, `${ids.size} nodes: keep the spine readable in a narrow column`);
  const r = checkSpine(flow, spineMarkdown(flow));
  assert.deepEqual(r.problems, []);
  assert.equal(r.blocks, 1);
});

test('--mermaid prints the marked spine and the node-to-page table', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/docs/build-explorer.mjs'), '--mermaid'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(SPINE_START));
  assert.match(r.stdout, /\| Id \| Step \| Agent or harness \| Settings \| Page \|/);
  assert.match(r.stdout, /\| `verifier` \| Pair verifier: approved, changes, exhausted \| `pair-verifier`, `pair-ui-verifier` \| /);
  assert.deepEqual(checkSpine(flow, r.stdout).problems, []);
});

// The seven flows the docs promise stay visible in the compact spine: single ticket, bug fix, UI bug, backend bug,
// feature epic with --pr-split, bug epic, resume or requeue.
test('the compact spine keeps all seven flows visible', () => {
  const ids = mermaidIds(mermaidSpine(flow));
  const edges = spineEdges(flow).map((e) => `${e.from}>${e.to}`);
  for (const id of ['run', 'entry', 'plan', 'prCheck', 'open', 'gate', 'merged']) assert.ok(ids.has(id), `single ticket: ${id}`);
  for (const id of ['bug', 'triage', 'gatePublish', 'autoMerge']) assert.ok(ids.has(id), `bug fix: ${id}`);
  assert.ok(ids.has('uiPair'), 'UI bug: before and after videos');
  assert.ok(ids.has('apiEvidence') && ids.has('apiChanges'), 'backend bug: request evidence, API changes');
  for (const id of ['epicPlan', 'shape', 'unit', 'journeys', 'unitPrCheck']) assert.ok(ids.has(id), `epics: ${id}`);
  for (const id of ['resume', 'requeue', 'reopenHold', 'sentBack', 'prRefused']) assert.ok(ids.has(id), `resume or requeue: ${id}`);
  for (const e of ['entry>epicPlan', 'entry>plan', 'bug>triage', 'resume>requeue', 'requeue>claim', 'claim>reopenHold', 'reopenHold>entry', 'sentBack>requeue', 'fv>unit', 'fv>prCheck', 'fv>doneNoPr', 'checks>ready', 'holdFix>holdFix']) assert.ok(edges.includes(e), e);
  assert.ok(ids.has('doneNoPr'), 'the default end without --pr: done, no PR');
});

test('a page without markers passes (nothing to check)', () => {
  const r = checkSpine(flow, '# A page\n\n```mermaid\nflowchart TD\n  ZZ9 --> YY8\n```\n');
  assert.equal(r.ok, true);
  assert.equal(r.blocks, 0);
});

test('fixture: an id in the block that the data does not have fails', () => {
  const r = checkSpine(flow, block(`${mermaidSpine(flow)}\n  ZZ9["ZZ9 · not in the data"] --> merged`));
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, ['ZZ9']);
});

test('fixture: a decision point of the data missing from the block fails', () => {
  const without = mermaidSpine(flow).split('\n').filter((l) => !/\bbranchCi\b/.test(l)).join('\n');
  const r = checkSpine(flow, block(without));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['branchCi']);
});

test('fixture: an unterminated marker fails', () => {
  assert.equal(checkSpine(flow, `${SPINE_START}\n\`\`\`mermaid\nflowchart TD\n\`\`\`\n`).ok, false);
});

test('mermaidIds reads declared and linked ids, not labels, classes or keywords', () => {
  const ids = mermaidIds('flowchart TD\n  A1["B9 in a label"]:::agent --> Q1{"Q2?"}\n  Q1 -->|"to X9"| X1([x])\n  A1 -.- S1{{s}}\n  classDef agent fill:#fff\n  class A1 agent\n');
  assert.deepEqual([...ids].sort(), ['A1', 'Q1', 'S1', 'X1']);
});

// The docs writer marks the spine in docs/ai-pipeline/README.md (or any page): every marked block in the docs must
// match the data. Pages without markers pass.
test('every marked spine block in the docs matches docs/pipeline-flow.json', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'docs'));
  files.push(path.join(ROOT, 'README.md'));
  for (const f of files) {
    const r = checkSpine(flow, fs.readFileSync(f, 'utf8'));
    assert.deepEqual(r.problems, [], path.relative(ROOT, f));
  }
});

// The hub carries the generated spine and table exactly: regenerate with --mermaid after any change to the data.
test('the hub\'s spine and node table are exactly what docs/pipeline-flow.json generates', () => {
  const hub = fs.readFileSync(path.join(ROOT, 'docs/ai-pipeline/README.md'), 'utf8');
  const s = hub.indexOf(SPINE_START);
  const e = hub.indexOf(SPINE_END);
  assert.ok(s >= 0 && e > s, 'the hub has the markers');
  assert.equal(hub.slice(s, e + SPINE_END.length), spineMarkdown(flow).split(SPINE_END)[0] + SPINE_END, 'the marked spine');
  assert.ok(hub.includes(`${nodeTable(flow)}\n`), 'the node-to-page table');
});

test('edge labels are cut at a word or label boundary, never mid-word', () => {
  assert.equal(cutLabel('PR adopted, never opened twice / continues the CI wait (--stopped)', 60), 'PR adopted, never opened twice / …');
  assert.equal(cutLabel('records, docs, style or minor: to the fixer', 38), 'records, docs, style or minor: to…');
  for (const e of flow.edges) {
    const full = e.label ?? '';
    const cut = cutLabel(full);
    if (cut === full) continue;
    const kept = cut.slice(0, -1);
    assert.ok(full.startsWith(kept) && /[\s,;:(/-]/.test(full[kept.length] ?? ' '), `${e.from}->${e.to}: "${cut}" cuts a word of "${full}"`);
  }
  // A merged spine label is cut after a whole label.
  for (const e of spineEdges(flow)) if (e.label.includes(' / ') && e.label.endsWith('…')) assert.match(e.label, / \/ …$/, `${e.from}->${e.to}`);
});
