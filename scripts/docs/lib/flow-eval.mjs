// The pipeline explorer's flow evaluator: pure functions over docs/pipeline-flow.json, no imports and no I/O, so the same
// code runs in the tests and, inlined by scripts/docs/build-explorer.mjs, in docs/pipeline-explorer.html. It says what the
// rules in the data file give for one configuration; it runs nothing.
//
//   defaults(flow)                       { settingId: default }
//   resolve(flow, input)                 { values, facts, notes }: defaults + input, normalized, facts derived
//   evaluate(flow, input, choices)       the configuration's flow: nodes (active, skipped, off), edges, the walk
//   walk(flow, ev, choices)              the path the reader's decision outcomes take, to its end state
//   decisionView(flow, ev, nodeId)       a decision's outcomes as the details show them: per walk visit, else in any state
//
// A fact marked `"walk": true` starts false and is set by the edges the walk takes (`"set": {"heldPr": true}`): it carries
// what an earlier step left behind (a PR already open and held) to later decisions. Reachability follows those facts:
// each step is reached in the walk states (`ev.states[node]`, the walk facts' values) its incoming edges can carry, and
// an edge or an outcome that depends on such a fact is possible where some reaching state allows it.
//   encodeHash / decodeHash              the configuration in the URL hash
//   configFragment / cliCommand          the matching .factory/config.json fragment and command line

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function defaults(flow) {
  const out = {};
  for (const s of flow.settings) out[s.id] = s.default;
  return out;
}

// A setting's value from user input (strings from a URL or a form), typed by the setting; invalid values fall back to
// the default.
export function coerce(setting, raw) {
  if (raw === undefined || raw === null || raw === '') return setting.default;
  if (setting.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return setting.default;
  }
  if (setting.type === 'integer') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n)) return setting.default;
    const min = setting.min ?? Number.MIN_SAFE_INTEGER;
    const max = setting.max ?? Number.MAX_SAFE_INTEGER;
    return Math.min(max, Math.max(min, n));
  }
  if (setting.type === 'enum') return setting.values.includes(raw) ? raw : setting.default;
  return raw;
}

// The value of a reference: a setting or a fact.
const ref = (env, name) => {
  if (has(env.facts, name)) return env.facts[name];
  if (has(env.values, name)) return env.values[name];
  throw new Error(`unknown reference "${name}"`);
};

// A condition from the data file: true when absent.
export function test(cond, env) {
  if (cond === undefined || cond === null || cond === true) return true;
  if (cond === false) return false;
  if (has(cond, 'is')) return Boolean(ref(env, cond.is));
  if (has(cond, 'eq')) return ref(env, cond.eq[0]) === cond.eq[1];
  if (has(cond, 'in')) return cond.in[1].includes(ref(env, cond.in[0]));
  if (has(cond, 'gt')) return Number(ref(env, cond.gt[0])) > cond.gt[1];
  if (has(cond, 'not')) return !test(cond.not, env);
  if (has(cond, 'all')) return cond.all.every((c) => test(c, env));
  if (has(cond, 'any')) return cond.any.some((c) => test(c, env));
  throw new Error(`unknown condition ${JSON.stringify(cond)}`);
}

// Every reference a condition names (the tests check them against the settings and facts).
export function refsOf(cond, out = []) {
  if (!cond || typeof cond !== 'object') return out;
  if (has(cond, 'is')) out.push(cond.is);
  for (const k of ['eq', 'in', 'gt']) if (has(cond, k)) out.push(cond[k][0]);
  if (has(cond, 'not')) refsOf(cond.not, out);
  for (const k of ['all', 'any']) if (has(cond, k)) for (const c of cond[k]) refsOf(c, out);
  if (has(cond, 'select')) out.push(cond.select[0], ...Object.values(cond.select[1]));
  return out;
}

export function resolve(flow, input = {}) {
  const values = defaults(flow);
  for (const s of flow.settings) if (has(input, s.id)) values[s.id] = coerce(s, input[s.id]);
  const notes = [];
  const env = { values, facts: {} };
  for (const rule of flow.normalize ?? []) {
    if (!test(rule.when, env)) continue;
    Object.assign(values, rule.set);
    notes.push(rule.note);
  }
  for (const f of flow.facts) {
    if (has(f, 'select')) {
      const [by, map] = f.select;
      const target = map[ref(env, by)];
      env.facts[f.id] = target ? ref(env, target) : null;
    } else env.facts[f.id] = test(f.is, env);
  }
  return { values, facts: env.facts, notes };
}

// "{maxPairRounds}" in a label becomes the setting's (or fact's) value.
export function interpolate(text, env) {
  return String(text ?? '').replace(/\{([\w.]+)\}/g, (m, name) => (has(env.facts, name) || has(env.values, name) ? String(ref(env, name)) : m));
}

const decisionOf = (flow, nodeId) => flow.decisions.find((d) => d.at === nodeId) ?? null;

// The outcomes of a decision available under this configuration, in order; the default is the first one marked
// default that is available, else the first available.
export function outcomesFor(decision, env) {
  const available = decision.outcomes.filter((o) => test(o.when, env));
  const def = available.find((o) => o.default) ?? available[0] ?? null;
  return { available, default: def ? def.id : null };
}

const flowEdges = (flow) => flow.edges.filter((e) => e.type !== 'uses');

// The edge a skipped node passes on through: its default outcome's edge, or its plain edge.
function passEdge(flow, env, nodeId) {
  const d = decisionOf(flow, nodeId);
  const out = flowEdges(flow).filter((e) => e.from === nodeId && test(e.when, env));
  if (d) {
    const { default: def } = outcomesFor(d, env);
    return out.find((e) => e.outcome === def) ?? null;
  }
  return out.find((e) => !e.outcome) ?? null;
}

// An edge is live when its condition holds and, from a decision, its outcome is available.
function edgeLive(flow, env, e) {
  if (!test(e.when, env)) return false;
  if (!e.outcome) return true;
  const d = decisionOf(flow, e.from);
  return Boolean(d) && outcomesFor(d, env).available.some((o) => o.id === e.outcome);
}

// The facts the walk sets; a walk state is their values (all false at an entry).
const walkFacts = (flow) => flow.facts.filter((f) => f.walk).map((f) => f.id);
const withSet = (x, set) => (set ? { values: x.values, facts: { ...x.facts, ...set } } : x);
const stateKey = (flow, x) => walkFacts(flow).map((id) => (x.facts[id] ? 1 : 0)).join('');
const stateOf = (flow, x) => Object.fromEntries(walkFacts(flow).map((id) => [id, Boolean(x.facts[id])]));

// A node is on (its condition holds) or off; an off node on the way is skipped: the flow passes through it.
export function evaluate(flow, input = {}, choices = {}) {
  const { values, facts, notes } = resolve(flow, input);
  const env = { values, facts };
  const nodes = {};
  for (const n of flow.nodes) nodes[n.id] = { id: n.id, on: test(n.when, env), reached: false, state: 'off' };
  const entries = flow.entries.filter((e) => test(e.when, env)).map((e) => e.node);
  // Reachability from the entry over live edges, per walk state: an edge is followed in the states that reach its step
  // and carries what it sets; a node that is off forwards along its pass edge.
  const reach = {};
  const queue = entries.map((id) => [id, env]);
  while (queue.length) {
    const [id, x] = queue.shift();
    const k = stateKey(flow, x);
    reach[id] = reach[id] ?? new Map();
    if (reach[id].has(k)) continue;
    reach[id].set(k, x);
    const st = nodes[id];
    st.reached = true;
    if (!st.on) {
      const p = passEdge(flow, x, id);
      if (p) queue.push([p.to, withSet(x, p.set)]);
      continue;
    }
    for (const e of flow.edges.filter((y) => y.from === id)) if (e.type === 'uses' || edgeLive(flow, x, e)) queue.push([e.to, withSet(x, e.set)]);
  }
  const statesAt = (id) => [...(reach[id]?.values() ?? [])];
  for (const st of Object.values(nodes)) st.state = st.reached ? (st.on ? 'active' : 'skipped') : 'off';
  // Where an edge really leads once skipped nodes are passed through (the "remove" view draws these), in each walk state
  // the edge is taken in, with what the edge and the passed edges set carried along (a hold set on the way decides where
  // a skipped CI wait passes on to).
  const through = (to, x, guard = 0) => {
    let t = to;
    let at = x;
    while (nodes[t] && nodes[t].state === 'skipped' && guard++ < 50) {
      const p = passEdge(flow, at, t);
      if (!p) return null;
      at = withSet(at, p.set);
      t = p.to;
    }
    return t;
  };
  const edges = flow.edges.map((e, i) => {
    const from = nodes[e.from].state === 'active' ? statesAt(e.from) : [];
    const takenIn = e.type === 'uses' ? from : from.filter((x) => edgeLive(flow, x, e));
    const live = takenIn.length > 0;
    const label = e.loop ? interpolate(e.loop.text, env) : e.label ? interpolate(e.label, env) : e.outcome ? interpolate(decisionOf(flow, e.from)?.outcomes.find((o) => o.id === e.outcome)?.label ?? e.outcome, env) : '';
    const effectiveTos = [...new Set(takenIn.map((x) => through(e.to, withSet(x, e.set))).filter(Boolean))];
    return { index: i, from: e.from, to: e.to, outcome: e.outcome ?? null, type: e.type ?? 'flow', loop: Boolean(e.loop), live, label, effectiveTo: effectiveTos[0] ?? null, effectiveTos };
  });
  const decisions = {};
  for (const d of flow.decisions) {
    const o = outcomesFor(d, env);
    decisions[d.id] = { id: d.id, at: d.at, available: o.available.map((x) => x.id), default: o.default, active: nodes[d.at].state === 'active' };
  }
  const states = Object.fromEntries(Object.keys(reach).map((id) => [id, statesAt(id).map((x) => stateOf(flow, x))]));
  const ev = { values, facts, notes, nodes, edges, decisions, entries, states };
  ev.walk = walk(flow, ev, choices);
  return ev;
}

// The reader's path: from the entry, at each decision the reader's outcome on its first visit (when it is available
// here), otherwise the default, until an exit or an end. A loop is taken once; on the way back the step passes. A list
// of outcomes picks one per visit (["again", "green"]: a second fixing round, then green).
export function walk(flow, ev, choices = {}) {
  const env = { values: ev.values, facts: { ...ev.facts } };
  const byId = Object.fromEntries(flow.nodes.map((n) => [n.id, n]));
  const steps = [];
  const visits = {};
  let lane = null;
  let at = ev.entries[0] ?? null;
  let via = null;
  for (let guard = 0; at && guard < 400; guard++) {
    const node = byId[at];
    const st = ev.nodes[at];
    visits[at] = (visits[at] ?? 0) + 1;
    if (st.state === 'skipped') {
      const p = passEdge(flow, env, at);
      steps.push({ node: at, skipped: true, lane });
      if (p?.set) Object.assign(env.facts, p.set);
      at = p ? p.to : null;
      continue;
    }
    if (via?.lane) lane = via.lane;
    if (node.lane) lane = node.lane;
    const d = decisionOf(flow, at);
    let outcome = null;
    let chosen = false;
    let available;
    if (d) {
      // A budgeted loop: an outcome offered only while cycles are left (cyclesLeft), or once they are used (cyclesUsed).
      const budget = (name) => Number(ref(env, name));
      const offered = outcomesFor(d, env).available.filter((x) => (!x.cyclesLeft || visits[at] < budget(x.cyclesLeft)) && (!x.cyclesUsed || visits[at] >= budget(x.cyclesUsed)));
      const def = (offered.find((x) => x.default) ?? offered[0])?.id ?? null;
      available = offered.map((x) => x.id);
      const picks = choices[d.id];
      const pick = Array.isArray(picks) ? picks[visits[at] - 1] : visits[at] === 1 ? picks : undefined;
      if (pick && available.includes(pick)) {
        outcome = pick;
        chosen = pick !== def;
      } else outcome = def;
    }
    const out = flowEdges(flow).filter((e) => e.from === at && edgeLive(flow, env, e));
    // A decision step keeps this visit's default and where each of its outcomes leads from here (the details show them).
    const targets = d ? Object.fromEntries(available.map((id) => [id, out.find((e) => e.outcome === id)?.to ?? null])) : null;
    const step = { node: at, lane, decision: d ? d.id : null, outcome, chosen, visit: visits[at], ...(d ? { available, default: (outcomesFor(d, env).available.find((x) => available.includes(x.id) && x.default) ?? null)?.id ?? available[0] ?? null, targets } : {}) };
    steps.push(step);
    if (node.kind === 'exit' || node.end) {
      return { steps, end: at, endKind: node.kind === 'exit' ? 'exit' : 'end', lane };
    }
    const next = d ? out.find((e) => e.outcome === outcome) : out.find((e) => !e.outcome);
    if (!next) return { steps, end: at, endKind: 'stuck', lane };
    step.edge = flow.edges.indexOf(next);
    if (next.set) Object.assign(env.facts, next.set);
    via = next;
    at = next.to;
  }
  return { steps, end: at, endKind: at ? 'limit' : 'stuck', lane };
}

// A decision's outcomes for the details pane. On the walk: one entry per visit, with the outcomes that visit offers (a
// held PR is updated, never opened; an exhausted budget only once it is spent), where each leads, and the walk's pick.
// Off the walk: one entry with what the configuration allows in the walk states that reach the step, each outcome's possible destinations
// and its budget ({ kind: 'left' | 'used', n }: offered on visits before n, or from visit n).
export function decisionView(flow, ev, nodeId) {
  const d = decisionOf(flow, nodeId);
  if (!d) return null;
  const visits = ev.walk.steps.filter((s) => s.node === nodeId && !s.skipped && s.decision);
  if (visits.length) {
    return {
      decision: d.id,
      onWalk: true,
      visits: visits.map((s) => ({ visit: s.visit, outcome: s.outcome, default: s.default, outcomes: d.outcomes.map((o) => ({ id: o.id, label: o.label, possible: s.available.includes(o.id), to: s.targets?.[o.id] ? [s.targets[o.id]] : [] })) })),
    };
  }
  const env = { values: ev.values, facts: ev.facts };
  const envs = (ev.states?.[nodeId] ?? []).map((st) => withSet(env, st));
  const outcomes = d.outcomes.map((o) => {
    const inEnvs = envs.filter((x) => outcomesFor(d, x).available.some((a) => a.id === o.id));
    const to = [...new Set(flowEdges(flow).filter((e) => e.from === nodeId && e.outcome === o.id && inEnvs.some((x) => test(e.when, x))).map((e) => e.to))];
    const budget = o.cyclesLeft ? { kind: 'left', n: Number(ref(env, o.cyclesLeft)) } : o.cyclesUsed ? { kind: 'used', n: Number(ref(env, o.cyclesUsed)) } : null;
    return { id: o.id, label: o.label, possible: inEnvs.length > 0, to, budget };
  });
  return { decision: d.id, onWalk: false, visits: [{ visit: null, outcome: null, default: outcomesFor(d, env).default, outcomes }] };
}

// ---- the configuration in the URL hash --------------------------------------------------------------------------------

export function encodeHash(flow, input = {}, choices = {}, view = {}) {
  const { values } = resolve(flow, input);
  const parts = [];
  for (const s of flow.settings) if (has(input, s.id) && values[s.id] !== s.default) parts.push(`${encodeURIComponent(s.id)}=${encodeURIComponent(String(values[s.id]))}`);
  // A decision's id is its step's id, which may equal a setting's: outcomes are prefixed with @.
  for (const d of flow.decisions) if (choices[d.id]) parts.push(`@${encodeURIComponent(d.id)}=${encodeURIComponent([].concat(choices[d.id]).join(','))}`);
  for (const [k, v] of Object.entries(view)) if (v !== undefined && v !== null && v !== '') parts.push(`_${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

export function decodeHash(flow, hash) {
  const input = {};
  const choices = {};
  const view = {};
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text) return { input, choices, view };
  for (const pair of text.split('&')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    let k;
    let v;
    try {
      k = decodeURIComponent(pair.slice(0, i));
      v = decodeURIComponent(pair.slice(i + 1));
    } catch {
      continue;
    }
    const s = flow.settings.find((x) => x.id === k);
    if (k.startsWith('@')) {
      const id = k.slice(1);
      const d = flow.decisions.find((x) => x.id === id);
      const picks = v.split(',');
      if (d && picks.every((p) => d.outcomes.some((o) => o.id === p))) choices[id] = picks.length > 1 ? picks : picks[0];
    } else if (k.startsWith('_')) view[k.slice(1)] = v;
    else if (s) input[k] = coerce(s, v);
  }
  return { input, choices, view };
}

// ---- what to write to get this configuration ---------------------------------------------------------------------------

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[keys.at(-1)] = value;
};

// The .factory/config.json and .factory/factory.json fragments for the settings that differ from their defaults
// (scenario values and CLI-only flags are not config). A seated council stage needs members: the fragment names a
// placeholder member to replace.
export function configFragment(flow, input = {}) {
  const { values } = resolve(flow, input);
  const files = {};
  for (const s of flow.settings) {
    if (s.kind !== 'config' || values[s.id] === s.default) continue;
    if (s.onlyWhen && !test(s.onlyWhen, { values, facts: {} })) continue;
    const file = s.file ?? '.factory/config.json';
    files[file] = files[file] ?? {};
    if (s.seat) {
      if (!values[s.id]) continue;
      setPath(files[file], `council.stages.${s.seat}`, {});
      if (!files[file].council.members) files[file].council.members = [{ name: 'member-1', cli: 'claude', model: 'opus', lens: 'correctness' }];
    } else if (s.section) {
      if (values[s.id]) setPath(files[file], s.config, {});
    } else setPath(files[file], s.config, values[s.id]);
  }
  return files;
}

// The command line that starts this configuration.
export function cliCommand(flow, input = {}) {
  const { values } = resolve(flow, input);
  const entry = flow.settings.find((s) => s.id === 'entry');
  const parts = [entry.cli[values.entry]];
  const epic = values.entry === 'feature-epic' || values.entry === 'bug-epic';
  for (const s of flow.settings) {
    if (!s.flag || s.id === 'pr') continue;
    if (values[s.id] === s.default) continue;
    if (!epic && ['grouping', 'prSplit'].includes(s.id)) continue;
    if (values.entry === 'resume') continue;
    parts.push(`${s.flag} ${values[s.id]}`);
  }
  if (values.pr) parts.push('--pr');
  const env = flow.settings.filter((s) => s.env && values[s.id] !== s.default).map((s) => `${s.env}=${values[s.id]}`);
  return [...env, ...parts].join(' ');
}
