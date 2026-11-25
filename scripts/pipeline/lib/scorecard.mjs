// How each model does in each lens and stage (GEN-13): plain arithmetic over the council records of GEN-12, never an
// agent's impression. The retro writes it to `<lessonsDir>/scorecard.json`, a pipeline-owned file committed with the
// lessons; the stage orchestrators read it when they pick a council (selection.mjs), and every `council.selection`
// event quotes its version.
//
// One row per model, lens and stage:
// - seats: the councils (ticket, stage and step) the model sat on with that lens;
// - judged, upheld and upheldRate: the row's findings that have an outcome, those upheld (a PR check judge's `upheld`,
//   another stage's `led-to-change`), and the share upheld;
// - unique: upheld findings no other member of the same council raised (members are compared within a ticket, never
//   across tickets);
// - misses and lowWeightMisses: problems found after a council the model sat on passed (council-findings.jsonl);
// - tokensPerUpheld and secondsPerUpheld: the row's member runs (token-usage.jsonl) per upheld finding;
// - score: (upheld × the stage's weight − misses × `miss` − lower-weight misses × `lowWeightMiss`) per seat, with the
//   weights of `council.scorecard.weights` (a PR check ruling weighs more than a pair stage's "led to a change").
// A row with fewer seats than `council.scorecard.minSeats` is `unknown`: its numbers are null.
//
// Beside the rows, a family-bias check: per PR check judge family, the upheld rate of findings raised by members of the
// same family and of other families.
//
// The file holds no timestamp: the same records give the same file. Its `version` is a hash of its content, and its
// `inputs` a hash of the records it was computed from, so the pre-push check (checkScorecardPush) refuses a hand edit.
import { sha } from './util.mjs';
import path from 'node:path';
import { COUNCIL_FILE } from './council.mjs';
import { SOLE_LENS } from './council-config.mjs';
import { FINDINGS_FILE } from './findings.mjs';
import { VERIFY_STAGE } from './decisions.mjs';
import { git } from './git.mjs';
import { poolEntry } from './pool.mjs';
import { writeTextIfChanged } from './redact.mjs';
import { setting } from './settings.mjs';
import { sinkSettings } from './sink.mjs';
import { readMetrics } from './state.mjs';
import { USAGE_FILE } from './usage.mjs';

export const SCORECARD_FILE = 'scorecard.json';
// token-usage.jsonl names a member run's stage by the stage's own usage tag.
const USAGE_STAGE = { review: 'architectureReview', 'pr-check': 'prCheck', 'plan-verify': 'testPlan', 'automation-verify': 'testAutomation', [VERIFY_STAGE]: 'pairVerify', 'implement-ui-verify': 'pairUiVerify' };
// The outcomes of a council finding that count as upheld.
export const UPHELD_OUTCOMES = new Set(['upheld', 'led-to-change']);

export const scorecardPath = (config, root = config.root) => path.join(root, setting(config, 'lessonsDir'), SCORECARD_FILE);
const round3 = (n) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const ratio = (a, b) => (b ? round3(a / b) : null);
// A record without its envelope (the store's _id, _project, _host) and its timestamp: what it says, not when or where.
const bare = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));

// The version of a scorecard: a hash of everything in it but the version itself.
export const scorecardVersion = (doc) => sha(JSON.stringify({ ...doc, version: undefined }));

// The records the scorecard is computed from, this repository's only (a store with scope "all" returns others' too).
export function scorecardRecords(config) {
  let project = null;
  try {
    project = sinkSettings(config).project ?? null;
  } catch {
    // no store settings: every record is this checkout's own
  }
  const mine = (r) => !r._project || !project || r._project === project;
  const read = (name) => readMetrics(config, name).filter(mine).map(bare);
  return {
    rounds: read(COUNCIL_FILE).filter((r) => r.kind !== 'adjudication' && Array.isArray(r.members)),
    findings: read(FINDINGS_FILE),
    usage: read(USAGE_FILE).filter((u) => u.seat),
  };
}

// The scorecard of a set of records: { version, inputs, minSeats, weights, rows, bias }. Pure: the same records and
// settings give the same scorecard.
export function computeScorecard(config, { rounds = [], findings = [], usage = [] } = {}) {
  const minSeats = setting(config, 'council.scorecard.minSeats');
  const weights = Object.fromEntries(['prCheckRuling', 'miss', 'ledToChange', 'lowWeightMiss'].map((w) => [w, setting(config, `council.scorecard.weights.${w}`)]));
  const modelOf = (m) => m.model ?? (m.entry ? poolEntry(config, m.entry)?.model : null) ?? m.entry ?? m.name ?? 'unknown';
  const council = (r) => `${r.story}|${r.stage}|${r.step ?? ''}`;
  const rowKey = (model, lens, stage) => `${model}|${lens ?? SOLE_LENS}|${stage}`;
  const rows = new Map();
  const rowOf = (model, lens, stage) => {
    const k = rowKey(model, lens, stage);
    if (!rows.has(k)) rows.set(k, { model, lens: lens ?? SOLE_LENS, stage, seats: new Set(), judged: 0, upheld: 0, unique: 0, misses: 0, lowWeightMisses: 0, tokens: 0, runs: new Map() });
    return rows.get(k);
  };
  // Seats: each council a member sat on, once however many rounds it took. A seat is known by its council and name.
  // `sittings`: each seat with the model on it and the check run (a PR check's), which a member run's usage joins on.
  const seatRow = new Map();
  const sittings = [];
  for (const r of rounds) {
    for (const m of r.members) {
      const row = rowOf(modelOf(m), m.lens, r.stage);
      row.seats.add(`${council(r)}|${m.name}`);
      seatRow.set(`${council(r)}|${m.name}`, row);
      sittings.push({ story: r.story, stage: r.stage, check: r.check ?? null, seat: m.name, row });
    }
  }
  // Findings and outcomes, by the round that raised them. Uniqueness counts the members that raised the same finding.
  // A PR check's records name their check run (`check`): ids start again in each check of a ticket.
  const key = (r) => `${r.story}|${r.stage}|${r.step ?? ''}|${r.check ?? ''}|${r.round}|${r.finding}`;
  const outcomes = new Map(findings.filter((r) => r.kind === 'outcome').map((r) => [key(r), r]));
  const raised = new Map();
  for (const f of findings.filter((r) => r.kind === 'finding')) {
    if (!raised.has(key(f))) raised.set(key(f), []);
    raised.get(key(f)).push(f);
  }
  const bias = new Map();
  for (const [k, raisers] of raised) {
    const outcome = outcomes.get(k);
    const seats = new Set(raisers.map((f) => f.seat));
    for (const f of raisers) {
      const row = rowOf(modelOf(f), f.lens, f.stage);
      // A non-blocking member's (feedback) row shares the finding, so the finding is unique to nobody else, but the
      // outcome was ruled on the deciding member's finding: it earns its raiser nothing (council r5, sol-26).
      if (!outcome || f.feedback) continue;
      const up = UPHELD_OUTCOMES.has(outcome.outcome);
      row.judged += 1;
      if (up) row.upheld += 1;
      if (up && seats.size === 1) row.unique += 1;
      // The bias check: a PR check judge's own rulings on findings of its own family and of the others (never an
      // outcome the harness decided: no ruling, or one it reversed).
      const judge = outcome.judge?.family;
      const ruling = 'ruling' in outcome ? outcome.ruling : outcome.outcome;
      if (judge && f.family && ruling) {
        if (!bias.has(judge)) bias.set(judge, { same: { judged: 0, upheld: 0 }, other: { judged: 0, upheld: 0 } });
        const side = bias.get(judge)[f.family === judge ? 'same' : 'other'];
        side.judged += 1;
        if (ruling === 'upheld') side.upheld += 1;
      }
    }
  }
  for (const m of findings.filter((r) => r.kind === 'miss')) {
    // The model the miss names (its seat's entry and model when it was recorded), never whoever held the seat last
    // (council r4, sol-25); a record without them falls back to the seat.
    const row = m.model || m.entry ? rowOf(modelOf(m), m.lens, m.stage) : seatRow.get(`${m.story}|${m.stage}|${m.step ?? ''}|${m.seat}`) ?? rowOf(modelOf(m), m.lens, m.stage);
    if (m.lowWeight) row.lowWeightMisses += 1;
    else row.misses += 1;
  }
  // Cost: a member run's tokens (every record of the run) and seconds (once per run), on the row of the model that run
  // was on: the seat it sat (ticket, stage, seat name, and a PR check's check run) and that run's own entry or model. A
  // seat another model held in another check or round never takes it.
  for (const u of usage) {
    const stage = USAGE_STAGE[u.stage] ?? u.stage;
    const models = new Set([u.requested_model, u.entry ? poolEntry(config, u.entry)?.model : null, u.entry].filter(Boolean));
    const row = sittings.find((x) => x.story === u.story && x.stage === stage && x.seat === u.seat && x.row.lens === (u.lens ?? SOLE_LENS) && (!u.check || !x.check || x.check === u.check) && models.has(x.row.model))?.row;
    if (!row) continue;
    const t = u.tokens ?? {};
    row.tokens += (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + (t.cache_write_5m ?? 0) + (t.cache_write_1h ?? 0);
    row.runs.set(u.run_id ?? `${u.ts}|${u.seat}`, u.seconds ?? 0);
  }
  const out = [...rows.values()]
    .filter((r) => r.seats.size)
    .map((r) => {
      const seats = r.seats.size;
      if (seats < minSeats) return { model: r.model, lens: r.lens, stage: r.stage, seats, unknown: true, judged: null, upheld: null, upheldRate: null, unique: null, misses: null, lowWeightMisses: null, tokensPerUpheld: null, secondsPerUpheld: null, score: null };
      const seconds = [...r.runs.values()].reduce((a, b) => a + b, 0);
      const w = r.stage === 'prCheck' ? weights.prCheckRuling : weights.ledToChange;
      const score = (r.upheld * w - r.misses * weights.miss - r.lowWeightMisses * weights.lowWeightMiss) / seats;
      return { model: r.model, lens: r.lens, stage: r.stage, seats, unknown: false, judged: r.judged, upheld: r.upheld, upheldRate: ratio(r.upheld, r.judged), unique: r.unique, misses: r.misses, lowWeightMisses: r.lowWeightMisses, tokensPerUpheld: r.upheld ? Math.round(r.tokens / r.upheld) : null, secondsPerUpheld: ratio(seconds, r.upheld), score: round3(score) };
    })
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.lens.localeCompare(b.lens) || a.model.localeCompare(b.model));
  const biasRows = [...bias.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([judgeFamily, s]) => ({ judgeFamily, sameFamily: { ...s.same, upheldRate: ratio(s.same.upheld, s.same.judged) }, otherFamilies: { ...s.other, upheldRate: ratio(s.other.upheld, s.other.judged) } }));
  const inputs = { records: rounds.length + findings.length + usage.length, hash: sha([...rounds, ...findings, ...usage].map((r) => JSON.stringify(r)).sort().join('\n')) };
  const doc = { version: null, inputs, minSeats, weights, rows: out, bias: biasRows };
  doc.version = scorecardVersion(doc);
  return doc;
}

export const scorecardText = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

// Writes the scorecard computed from this checkout's records (and what the retro pulled from the store) under `root`.
// Returns { doc, changed }.
export function writeScorecard(config, root = config.root) {
  const doc = computeScorecard(config, scorecardRecords(config));
  return { doc, changed: writeTextIfChanged(scorecardPath(config, root), scorecardText(doc)) };
}

// Why a scorecard text is not the pipeline's own (empty: it is). Its version must match its content; when this
// checkout holds the very records it was computed from, its numbers must match them too.
export function scorecardProblems(config, text, records = null) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ['it is not valid JSON'];
  }
  if (!doc || typeof doc !== 'object' || doc.version !== scorecardVersion(doc)) return ['its version does not match its content: it was edited after the retro computed it'];
  const recomputed = computeScorecard(config, records ?? scorecardRecords(config));
  if (recomputed.inputs.hash === doc.inputs?.hash && recomputed.version !== doc.version) return ['its numbers differ from the ones its records give'];
  return [];
}

// The pre-push check: a pushed commit range that changes the scorecard must carry the pipeline's own. `input` is the
// pre-push hook's stdin. Returns the number of refused refs.
export function checkScorecardPush(config, input, { from: fromOf }) {
  const rel = path.relative(config.root, scorecardPath(config)).replace(/\\/g, '/');
  let refused = 0;
  for (const line of String(input).split('\n').filter(Boolean)) {
    const [localRef, localSha, , remoteSha] = line.split(' ');
    if (!localSha || /^0+$/.test(localSha)) continue;
    const from = fromOf(remoteSha);
    const touched = git(config.root, ['diff', '--name-only', `${from}..${localSha}`, '--', rel]).stdout.trim();
    if (!touched) continue;
    const shown = git(config.root, ['show', `${localSha}:${rel}`]);
    // Deleted in the pushed head while the remote has it: refused like an edit (only the retro writes it, and its
    // history is the evidence the selections were made on). Absent on both sides: nothing to protect.
    const existed = git(config.root, ['cat-file', '-e', `${from}:${rel}`]).status === 0;
    if (shown.status !== 0 && !existed) continue;
    const problems = shown.status !== 0 ? ['the push deletes it'] : scorecardProblems(config, shown.stdout);
    if (!problems.length) continue;
    refused++;
    console.error(`Scorecard: ${localRef} changes ${rel}, which only the retro writes: ${problems.join('; ')}.`);
  }
  if (refused) console.error('\nScorecard: push blocked. Rewrite it from the records with `factory retro scorecard` and commit the result (or drop the edit).');
  return refused;
}
