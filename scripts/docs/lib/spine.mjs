// The Mermaid "spine" of the generated pipeline, from docs/pipeline-flow.json, and the check that keeps a Markdown page's
// copy of it in step with the data: every node id in a marked block exists in the data, and every decision point of the
// data is in the block. Pure: no imports, no I/O.
//
// The spine is compact so that it reads in a narrow column: every decision point and the main steps (nodes without
// `"spine": false`), the exits folded into their spine group (`spineGroups`, such as `failed`), and edges contracted
// through the steps left out. The node-to-page table under it carries the detail; the explorer has every step.
//
// Mark the block in a Markdown page with
//   <!-- pipeline-spine:start -->
//   ```mermaid
//   flowchart TD
//     ...
//   ```
//   <!-- pipeline-spine:end -->

export const SPINE_START = '<!-- pipeline-spine:start -->';
export const SPINE_END = '<!-- pipeline-spine:end -->';

const KIND_CLASS = { agent: 'agent', harness: 'harness', service: 'ext', record: 'rec', exit: 'fail', person: 'person' };
const esc = (t) => String(t ?? '').replace(/"/g, "'").replace(/[<>]/g, '').replace(/\{(\w+)\}/g, 'N').replace(/\|/g, '/');
// A label cut to about n characters at a boundary: after the last whole label of a merged edge (" / …"), else at the
// last space, never mid-word.
export function cutLabel(t, n = 38) {
  if (t.length <= n) return t;
  const head = t.slice(0, n - 1);
  const slash = head.lastIndexOf(' / ');
  if (slash > 0) return `${head.slice(0, slash)} / …`;
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head).replace(/[\s,;:(/-]+$/, '')}…`;
}
const short = cutLabel;

export const spineNodes = (flow) => flow.nodes.filter((n) => n.spine !== false && n.kind !== 'exit' || (n.kind === 'exit' && !groupOf(flow, n.id)));
const groupOf = (flow, id) => (flow.spineGroups ?? []).find((g) => g.members.includes(id)) ?? null;

function shape(n, decision) {
  const text = `"${n.id}: ${esc(n.label)}"`;
  if (decision || n.route) return `${n.id}{${text}}`;
  if (n.kind === 'exit') return `${n.id}([${text}])`;
  if (n.kind === 'service') return `${n.id}{{${text}}}`;
  if (n.kind === 'record') return `${n.id}[(${text})]`;
  if (n.kind === 'person') return `${n.id}[/${text}/]`;
  return `${n.id}[${text}]`;
}

// Where an edge lands in the spine: a spine node, a spine group, or (through left-out steps) the spine nodes after them.
function landings(flow, to, inSpine, seen = new Set()) {
  if (inSpine.has(to)) return [to];
  const g = groupOf(flow, to);
  if (g) return [g.id];
  if (seen.has(to)) return [];
  seen.add(to);
  return flow.edges.filter((e) => e.from === to && e.type !== 'uses').flatMap((e) => landings(flow, e.to, inSpine, seen));
}

export function spineEdges(flow) {
  const nodes = spineNodes(flow);
  const inSpine = new Set(nodes.map((n) => n.id));
  const decisionAt = Object.fromEntries(flow.decisions.map((d) => [d.at, d]));
  const out = [];
  const seen = new Set();
  for (const e of flow.edges) {
    if (e.type === 'uses' || !inSpine.has(e.from)) continue;
    const d = e.outcome ? decisionAt[e.from] : null;
    const label = e.label ?? (d ? d.outcomes.find((o) => o.id === e.outcome)?.label ?? e.outcome : '');
    for (const to of landings(flow, e.to, inSpine)) {
      const key = `${e.from}>${to}`;
      const same = out.find((x) => `${x.from}>${x.to}` === key);
      if (same) {
        const more = short(esc(label));
        if (more && !same.label.endsWith('…') && !same.label.split(' / ').includes(more)) same.label = short(`${same.label} / ${more}`, 60);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: e.from, to, label: short(esc(label)), loop: Boolean(e.loop), group: Boolean(groupOf(flow, e.to) && to !== e.to) || (flow.spineGroups ?? []).some((g) => g.id === to) });
    }
  }
  return out;
}

// One compact flowchart: the main steps and every decision point (a diamond carrying its step's id), the exits in their
// groups, the loops dashed. Node labels carry the ids the explorer shows.
export function mermaidSpine(flow) {
  const decisionAt = Object.fromEntries(flow.decisions.map((d) => [d.at, d]));
  const lines = ['flowchart TD'];
  for (const n of spineNodes(flow)) lines.push(`  ${shape(n, decisionAt[n.id])}:::${KIND_CLASS[n.kind]}`);
  for (const g of flow.spineGroups ?? []) lines.push(`  ${g.id}(["${g.id}: ${esc(g.label)}"]):::fail`);
  const edges = spineEdges(flow);
  for (const e of edges.filter((x) => !x.group)) lines.push(`  ${e.from} ${e.loop ? '-.->' : '-->'}${e.label ? `|"${e.label}"|` : ''} ${e.to}`);
  // A shared step several steps use (the council discussion): one dotted line from all of them.
  const inSpine = new Set(spineNodes(flow).map((n) => n.id));
  for (const id of inSpine) {
    const from = [...new Set(flow.edges.filter((e) => e.type === 'uses' && e.to === id && inSpine.has(e.from)).map((e) => e.from))];
    if (from.length) lines.push(`  ${from.join(' & ')} -.->|"uses"| ${id}`);
  }
  // Every way into a group on one line: the table and the explorer say which outcome it is.
  for (const g of flow.spineGroups ?? []) {
    const from = [...new Set(edges.filter((x) => x.group && x.to === g.id).map((x) => x.from))];
    if (from.length) lines.push(`  ${from.join(' & ')} -.-> ${g.id}`);
  }
  lines.push(
    '  classDef agent fill:#dbe8fb,stroke:#2f5fb3,color:#111',
    '  classDef harness fill:#eeeeee,stroke:#666,stroke-dasharray:5 3,color:#111',
    '  classDef rec fill:#dff2df,stroke:#2e7d32,color:#111',
    '  classDef fail fill:#fbe0e0,stroke:#c62828,color:#111',
    '  classDef ext fill:#fdebd3,stroke:#c77700,color:#111',
    '  classDef person fill:#f3e5f5,stroke:#7b1fa2,color:#111',
  );
  return lines.join('\n');
}

// A link from a page under `base` (default docs/ai-pipeline/, where the pipeline index lives) to a docs/-relative link.
export function relLink(doc, base = 'ai-pipeline/') {
  const [file, anchor] = doc.split('#');
  const from = base.split('/').filter(Boolean);
  const to = file.split('/');
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return `${'../'.repeat(from.length)}${to.join('/')}${anchor ? `#${anchor}` : ''}`;
}

// The node-to-page table under the spine: id, step, who does it, the settings that control it, the page.
export function nodeTable(flow, { base = 'ai-pipeline/' } = {}) {
  const setting = Object.fromEntries(flow.settings.map((s) => [s.id, s]));
  const decisionAt = Object.fromEntries(flow.decisions.map((d) => [d.at, d]));
  const cell = (t) => String(t ?? '').replace(/\|/g, '\\|');
  const page = (doc) => `[${doc.split('#')[0].split('/').pop()}](${relLink(doc, base)})`;
  const who = (n) => (n.agents ? n.agents.map((a) => `\`${a.split(' (')[0]}\``).join(', ') : n.calls ? `harness, may call ${n.calls.map((a) => `\`${a.split(' (')[0]}\``).join(', ')}` : flow.kinds[n.kind].label.toLowerCase());
  const settingsOf = (n) => [...new Set((n.settings ?? []).map((id) => setting[id]).filter((s) => s.kind !== 'scenario').map((s) => `\`${s.flag && !s.config ? s.flag : s.config}\``))].slice(0, 3).join(', ') || 'none';
  const rows = ['| Id | Step | Agent or harness | Settings | Page |', '| --- | --- | --- | --- | --- |'];
  for (const n of spineNodes(flow)) {
    const d = decisionAt[n.id];
    const step = d ? `${n.label}: ${d.outcomes.map((o) => o.id).join(', ')}` : n.label;
    rows.push(`| \`${n.id}\` | ${cell(step)} | ${who(n)} | ${settingsOf(n)} | ${page(n.doc)} |`);
  }
  for (const g of flow.spineGroups ?? []) {
    const members = g.members.map((id) => flow.nodes.find((n) => n.id === id));
    rows.push(`| \`${g.id}\` | ${cell(g.label)}: ${members.map((m) => `\`${m.id}\` (${m.outcome.map((o) => `\`${o}\``).join(', ')})`).join('; ')} | harness, \`escalation-questions\` | none | ${page(g.doc)} |`);
  }
  return rows.join('\n');
}

const KEYWORDS = new Set(['flowchart', 'graph', 'subgraph', 'end', 'classDef', 'class', 'style', 'click', 'linkStyle', 'direction', 'TD', 'TB', 'LR', 'RL', 'BT']);

// The node ids a Mermaid flowchart declares or links.
export function mermaidIds(text) {
  const ids = new Set();
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line || /^(flowchart|graph|classDef|class|style|click|linkStyle|direction|end)\b/.test(line)) continue;
    const bare = line
      .replace(/^subgraph\s+/, '')
      .replace(/"[^"]*"/g, '""')
      .replace(/\|[^|]*\|/g, ' ')
      .replace(/:::\w+/g, '');
    for (const m of bare.matchAll(/(?:^|[\s&>-])([A-Za-z][\w]*)(?=\s*(?:\[|\(|\{|>|-|=|&|$|\s))/g)) {
      if (!KEYWORDS.has(m[1])) ids.add(m[1]);
    }
  }
  return ids;
}

// The marked blocks of a Markdown text: [{ text, ids }].
export function spineBlocks(markdown) {
  const out = [];
  let rest = String(markdown);
  for (;;) {
    const s = rest.indexOf(SPINE_START);
    if (s < 0) break;
    const e = rest.indexOf(SPINE_END, s);
    if (e < 0) {
      out.push({ text: rest.slice(s + SPINE_START.length), ids: null, unterminated: true });
      break;
    }
    const block = rest.slice(s + SPINE_START.length, e);
    const fence = /```mermaid\n([\s\S]*?)```/.exec(block);
    out.push({ text: block, ids: fence ? mermaidIds(fence[1]) : new Set() });
    rest = rest.slice(e + SPINE_END.length);
  }
  return out;
}

// Problems with a Markdown text's marked spine blocks against the data: { ok, blocks, unknown, missing, problems }.
// A text without markers passes (blocks: 0).
export function checkSpine(flow, markdown) {
  const blocks = spineBlocks(markdown);
  const known = new Set([...flow.nodes.map((n) => n.id), ...flow.decisions.map((d) => d.id), ...(flow.spineGroups ?? []).map((g) => g.id)]);
  const problems = [];
  const unknown = [];
  const missing = [];
  for (const [i, b] of blocks.entries()) {
    if (b.unterminated) {
      problems.push(`block ${i + 1}: ${SPINE_START} has no ${SPINE_END}`);
      continue;
    }
    for (const id of b.ids) if (!known.has(id)) unknown.push(id);
    for (const d of flow.decisions) if (!b.ids.has(d.id)) missing.push(d.id);
  }
  for (const id of unknown) problems.push(`${id} is in the spine but not in docs/pipeline-flow.json`);
  for (const id of missing) problems.push(`decision ${id} of docs/pipeline-flow.json is missing from the spine`);
  return { ok: problems.length === 0, blocks: blocks.length, unknown, missing, problems };
}
