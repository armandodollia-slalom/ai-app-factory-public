// Who sits on a stage's council, and through which lens (GEN-11, GEN-14). The stage's orchestrator picks one pool entry
// and one lens per seat, with a reason for each, from the pool with each entry's family, the stage, the number of seats,
// the ticket's shape and the scorecard. The harness holds it to a diverse council: a pick that breaks a rule goes back
// once with the reason; a second bad pick is replaced by the harness's own fill (one entry per family first, each seat
// to the best-ranked entry for its lens by the scorecard, the stage's core lens first). With two or more seats one seat
// is the exploration seat (`council.explorationSeat.enabled`): the entry with the fewest seats in the stage sits, so
// selection keeps gathering evidence on models the scorecard knows little about. The pick is made once per stage per
// ticket and kept (council.mjs savedSeats), so the same members and lenses sit in every round and on resume. Every pick
// is one `council.selection` event in council-selections.jsonl. A council of one is the stage's own verifier, which
// reviews everything (lens `all`), on the entry the orchestrator picks for it; with `council.shadowSeat.enabled` a
// non-blocking member of another family sits beside it (the shadow seat), whose findings are feedback and whose score
// never decides.
import fs from 'node:fs';
import path from 'node:path';
import { COUNCIL_LENSES, COUNCIL_STAGES, SOLE_LENS, STAGE_LENSES, canDriveBrowser } from './council-config.mjs';
import { CLEAN_CODE_LENS } from './clean-code.mjs';
import { cleanCodeEntry, cleanCodeSeat, memberCount, savedSeats, seatNames, seatsFile, soleMember } from './council.mjs';
import { orchestratorRun } from './orchestrator.mjs';
import { entryFor, familyOf, poolEntry, poolOf } from './pool.mjs';
import { scorecardPath } from './scorecard.mjs';
import { setting } from './settings.mjs';
import { metricsFile } from './state.mjs';
import { appendJsonl, extractResult, nowIso } from './util.mjs';
import { writeText } from './redact.mjs';

export const SELECTIONS_FILE = 'council-selections.jsonl';

// The lens a stage must seat when two or more sit.
export const CORE_LENS = { pairUiVerify: 'ui', testPlan: 'test-value', testAutomation: 'test-value', prCheck: 'acceptance' };

// A ticket's shape, as the orchestrator is told it: a bug fix, a UI or backend change, or a test stage's.
export const ticketShape = ({ key = '', ui = false, test = false } = {}) => [/^BUG-/i.test(String(key)) ? 'bug fix' : null, test ? 'test' : ui ? 'UI' : 'backend'].filter(Boolean).join(', ');

// The scorecard the orchestrator sees (scorecard.mjs; the retro computes it): { version, rows }. No file yet, or one that
// cannot be read: empty, every model unknown.
export function scorecardFor(config) {
  try {
    const doc = JSON.parse(fs.readFileSync(scorecardPath(config), 'utf8'));
    return { version: doc.version ?? null, rows: Array.isArray(doc.rows) ? doc.rows : [] };
  } catch {
    return { version: null, rows: [] };
  }
}

// The scorecard's rank of a pool entry for a stage and lens: its row's score. An unknown row, or none, ranks as a score
// of 0: below every known row with a positive score (its upheld findings outweigh its misses), above every known row
// with a negative one, so it is neither preferred to a known good row nor ranked below a known bad one.
const rowsOf = (scorecard, entry, stage) => (scorecard?.rows ?? []).filter((r) => r.model === (entry.model ?? entry.name) && r.stage === stage);
export function entryRank(scorecard, entry, stage, lens) {
  const row = rowsOf(scorecard, entry, stage).find((r) => r.lens === lens);
  return row && !row.unknown && Number.isFinite(row.score) ? row.score : 0;
}
// Entries best-ranked first for a stage and lens; pool order among equals.
export const byRank = (scorecard, stage, lens, entries) => entries.map((e, i) => ({ e, i, r: entryRank(scorecard, e, stage, lens) })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.e);

// The exploration seat's entry: the pool entry with the fewest seats in the stage by the scorecard (every lens, unknown
// rows too), so selection keeps learning about models it knows little about. Among equals (an empty scorecard), the last
// in pool order: the entry the fill would otherwise seat least. None with fewer than two seats or with
// `council.explorationSeat.enabled` off.
export function explorationEntry(config, { stage, pool, scorecard, count }) {
  if (count < 2 || !pool.length || !setting(config, 'council.explorationSeat.enabled')) return null;
  const seats = (e) => rowsOf(scorecard, e, stage).reduce((n, r) => n + (r.seats ?? 0), 0);
  return pool.map((e, i) => ({ e, i, n: seats(e) })).sort((a, b) => a.n - b.n || b.i - a.i)[0].e;
}

// The shadow seat's entry beside a council of one: the best-ranked entry (lens `all`) of another family than the sole
// member's (the PR check's panel with no entry of its own: its acceptance critic's). None with the setting off or with
// one family.
export function shadowEntry(config, { stage, pool, scorecard, own }) {
  if (!setting(config, 'council.shadowSeat.enabled')) return null;
  const base = own?.entry ? poolEntry(config, own.entry) : stage === 'prCheck' ? entryFor(config, { name: 'pr-check-acceptance' }) : null;
  if (!base) return null;
  const family = familyOf(base);
  return byRank(scorecard, stage, SOLE_LENS, pool.filter((e) => familyOf(e) !== family))[0] ?? null;
}

// Why a pick for a council of one breaks the rules: one entry of the pool; on the pair UI verifier, one whose CLI can
// drive a browser. Its lens is always `all`.
export function solePickProblems({ stage, pool, pick }) {
  if (!Array.isArray(pick) || pick.length !== 1) return [`pick exactly 1 seat (got ${Array.isArray(pick) ? pick.length : 'none'})`];
  const e = pool.find((x) => x.name === pick[0]?.entry);
  if (!e) return [`"${pick[0]?.entry}" is not in the pool (${pool.map((x) => x.name).join(', ')})`];
  if (stage === 'pairUiVerify' && !canDriveBrowser(e)) return [`${e.name} runs on ${e.cli}, which cannot drive a browser: the pair UI verifier drives the app`];
  return [];
}

// Every reason a pick breaks the rules (empty: it may sit). `pick` is [{ entry, lens, reason }].
export function pickProblems({ stage, count, pool, pick, explore = null }) {
  const problems = [];
  if (!Array.isArray(pick) || pick.length !== count) return [`pick exactly ${count} seat(s) (got ${Array.isArray(pick) ? pick.length : 'none'})`];
  const byName = new Map(pool.map((e) => [e.name, e]));
  const allowed = STAGE_LENSES[stage] ?? Object.keys(COUNCIL_LENSES);
  for (const [i, s] of pick.entries()) {
    const e = byName.get(s?.entry);
    if (!e) problems.push(`seat ${i + 1}: "${s?.entry}" is not in the pool (${pool.map((x) => x.name).join(', ')})`);
    if (!allowed.includes(s?.lens)) problems.push(`seat ${i + 1}: lens "${s?.lens}" is not one this stage allows (${allowed.join(', ')})`);
    else if (s.lens === 'ui' && e && !canDriveBrowser(e)) problems.push(`seat ${i + 1}: ${e.name} runs on ${e.cli}, which cannot drive a browser, so it cannot take the ui lens`);
  }
  if (problems.length) return problems;
  // Diversity: no family twice while a family of the pool has no seat.
  const families = pick.map((s) => familyOf(byName.get(s.entry)));
  const unused = [...new Set(pool.map(familyOf))].filter((f) => !families.includes(f));
  const repeated = [...new Set(families.filter((f, i) => families.indexOf(f) !== i))];
  if (repeated.length && unused.length) problems.push(`${repeated.join(', ')} sit twice while ${unused.join(', ')} has no seat: seat one entry per family first`);
  // No entry twice while an entry of the pool has no seat (an entry that would only fit a ui seat it cannot take aside).
  const entries = pick.map((s) => s.entry);
  const twiceEntry = [...new Set(entries.filter((e, i) => entries.indexOf(e) !== i))];
  const idle = pool.filter((e) => !entries.includes(e.name)).map((e) => e.name);
  if (!problems.length && twiceEntry.length && idle.length) problems.push(`${twiceEntry.join(', ')} sit twice while ${idle.join(', ')} has no seat: seat every entry once first`);
  const lenses = pick.map((s) => s.lens);
  const core = CORE_LENS[stage];
  if (core && count >= 2 && !lenses.includes(core) && pool.some((e) => core !== 'ui' || canDriveBrowser(e))) problems.push(`the stage's core lens ${core} has no seat`);
  const twice = [...new Set(lenses.filter((l, i) => lenses.indexOf(l) !== i))];
  const unseated = allowed.filter((l) => !lenses.includes(l) && (l !== 'ui' || pick.some((s) => canDriveBrowser(byName.get(s.entry)))));
  if (twice.length && unseated.length) problems.push(`two members share the ${twice.join(', ')} lens while ${unseated.join(', ')} has no seat`);
  if (explore && !pick.some((s) => s.entry === explore.name)) problems.push(`the exploration seat is ${explore.name}'s (the fewest seats in this stage): give it a seat`);
  return problems;
}

// Why the clean-code seat of a pick breaks the rules (GEN-16): it is missing (or there are two), its entry is not in the
// pool, or it sits on a family a counted seat already has while another family of the pool has no seat. `counted` are
// the counted seats' picks, `seats` the picks on the clean-code lens.
export function cleanCodePickProblems({ pool, counted, seats }) {
  const n = counted.length;
  if (!seats.length) return [`the clean-code seat is missing: seat one more member with lens "${CLEAN_CODE_LENS}", a fixed seat beside the ${n} counted seat(s)`];
  if (seats.length > 1) return [`seat exactly one member with lens "${CLEAN_CODE_LENS}" (got ${seats.length})`];
  const byName = new Map(pool.map((e) => [e.name, e]));
  const e = byName.get(seats[0].entry);
  if (!e) return [`the clean-code seat: "${seats[0].entry}" is not in the pool (${pool.map((x) => x.name).join(', ')})`];
  const seated = new Set(counted.map((s) => byName.get(s.entry)).filter(Boolean).map(familyOf));
  const unused = [...new Set(pool.map(familyOf))].filter((f) => !seated.has(f) && f !== familyOf(e));
  if (seated.has(familyOf(e)) && unused.length) return [`the clean-code seat sits on ${familyOf(e)}, which a counted seat already has, while ${unused.join(', ')} has no seat: give it a family no counted seat has`];
  return [];
}

// The harness's own fill, held to the same rules as an orchestrator's pick (pickProblems), in work bounded by the
// seats times the pool (council r4, sol-10: a search over every set of entries ran out of memory at 30 families and
// 10 seats). One entry list is built: one entry per family (each family's best-ranked entry, families in order of that
// rank, pool order among equals), then the entries not yet seated, then repeats; seats in pool order. Lenses: the
// stage's in order, its core lens first, repeating once each is seated; each lens in that order goes to the
// best-ranked seat left that can take it, and a seat no lens fits takes the first lens it can. When the rules object
// (the exploration entry not seated, no browser entry among the families chosen), the list is repaired one seat swap at a
// time, each step the swap that leaves the fewest problems, until it keeps the rules or no swap helps.
export function harnessPick(stage, pool, count, { scorecard = { rows: [] }, explore = null } = {}) {
  if (!pool.length || count < 1) return [];
  const allowed = STAGE_LENSES[stage] ?? Object.keys(COUNCIL_LENSES);
  const core = CORE_LENS[stage];
  const order = core ? [core, ...allowed.filter((l) => l !== core)] : allowed;
  const fits = (e, lens) => lens !== 'ui' || canDriveBrowser(e);
  const best = (e) => Math.max(...allowed.map((l) => entryRank(scorecard, e, stage, l)));
  const ranked = pool.map((e, i) => ({ e, i, r: best(e) })).sort((x, y) => y.r - x.r || x.i - y.i).map((x) => x.e);
  const seen = new Set();
  const perFamily = ranked.filter((e) => !seen.has(familyOf(e)) && seen.add(familyOf(e)));
  const list = [];
  const take = (e) => list.length < count && list.push(e);
  for (const e of perFamily) if (!list.some((x) => familyOf(x) === familyOf(e))) take(e);
  for (const e of ranked) if (!list.includes(e)) take(e);
  for (let i = 0; list.length < count; i++) take(ranked[i % ranked.length]);
  // Seats in pool order (a repeat after the first seat of its entry).
  list.sort((x, y) => pool.indexOf(x) - pool.indexOf(y));
  const fill = (entries) => {
    const lenses = entries.map((_, i) => order[i % order.length]);
    const seats = new Array(entries.length).fill(null);
    let rank = 0;
    for (const lens of lenses) {
      const free = entries.map((e, i) => ({ e, i })).filter(({ e, i }) => !seats[i] && fits(e, lens));
      const pickOne = free.sort((x, y) => entryRank(scorecard, y.e, stage, lens) - entryRank(scorecard, x.e, stage, lens) || x.i - y.i)[0];
      if (!pickOne) continue;
      seats[pickOne.i] = lens;
      rank += entryRank(scorecard, pickOne.e, stage, lens);
    }
    let explored = false;
    const pick = entries.map((e, i) => {
      const exploration = Boolean(explore && !explored && e === explore);
      explored ||= exploration;
      return { entry: e.name, lens: seats[i] ?? order.find((l) => fits(e, l)), reason: exploration ? 'the exploration seat: the fewest seats in this stage' : 'the harness fill: one entry per family first, the best-ranked by the scorecard for the lens' };
    });
    return { pick, rank, problems: pickProblems({ stage, count, pool, pick, explore }).length };
  };
  // Repair, step by step (council r5, sol-10: one swap from the first list could not seat both the exploration entry and
  // a browser entry): each step takes the swap of one seat that leaves the fewest problems (then the best rank, then the
  // first in seat and pool order), and keeps it while it removes a problem. At most one step per seat.
  let current = list;
  let chosen = fill(current);
  for (let step = 0; chosen.problems && step < count; step++) {
    let best = null;
    for (const i of current.keys()) {
      if (explore && current[i] === explore) continue;
      for (const e of pool) {
        if (e === current[i]) continue;
        const next = current.map((x, k) => (k === i ? e : x));
        const tried = fill(next);
        if (!best || tried.problems < best.tried.problems || (tried.problems === best.tried.problems && tried.rank > best.tried.rank)) best = { next, tried };
      }
    }
    if (!best || best.tried.problems >= chosen.problems) break;
    [current, chosen] = [best.next, best.tried];
  }
  return chosen.pick;
}

// The orchestrator's task: the pool with families, the stage, the seats, the ticket's shape, the scorecard, the rules.
export function selectionTask({ stage, count, pool, shape, scorecard, explore = null, rejected = [] }) {
  const allowed = STAGE_LENSES[stage] ?? Object.keys(COUNCIL_LENSES);
  const one = count === 1;
  return [
    `# Pick the ${COUNCIL_STAGES[stage]?.title ?? stage} council`,
    '',
    one
      ? `Seat 1 member for the ${stage} stage of a ${shape} ticket: one pool entry, with a short reason. It sits alone, as the stage's own ${stage === 'prCheck' ? 'critic panel (every critic runs on it)' : 'verifier'}, and reviews through every lens (lens \`all\`).${stage === 'pairUiVerify' ? ' It drives the app in a browser: pick an entry whose CLI can.' : ''}`
      : `Seat ${count} members for the ${stage} stage of a ${shape} ticket: one pool entry and one lens per seat, with a short reason for each. Favour a council of different model families: the harness rejects a pick that seats a family twice while another family of the pool has no seat.`,
    '',
    '## Pool',
    '',
    ...pool.map((e) => `- ${e.name}: ${e.cli}, ${e.model ?? 'custom command'}, family ${familyOf(e)}, effort ${e.effort}${canDriveBrowser(e) ? '' : ' (cannot drive a browser)'}`),
    ...(one
      ? []
      : [
          '',
          '## Lenses this stage allows',
          '',
          ...allowed.map((l) => `- ${l}: ${COUNCIL_LENSES[l]}`),
          ...(CORE_LENS[stage] ? ['', `The stage's core lens, ${CORE_LENS[stage]}, must have a seat. No two members share a lens while a lens above has no seat.`] : ['', 'No two members share a lens while a lens above has no seat.']),
        ]),
    '',
    '## Scorecard',
    '',
    scorecard.rows.length ? scorecard.rows.filter((r) => r.stage === stage).slice(0, 60).map((r) => `- ${r.model} / ${r.lens}: ${r.unknown ? `unknown (${r.seats} seats, too few)` : `seats ${r.seats}, score ${r.score}, upheld rate ${r.upheldRate}, unique ${r.unique}, misses ${r.misses}`}`).join('\n') || '(no rows for this stage: every model is unknown)' : '(empty: every model is unknown)',
    '',
    'An unknown row counts as a score of 0: below a known row with a positive score, above one with a negative score.',
    ...(explore ? ['', '## Exploration seat', '', `One seat is ${explore.name}'s: it has the fewest seats in this stage, and the scorecard learns only from models that sit. Give it a seat, with a lens it can take; pick the others by the scorecard.`] : []),
    '',
    '## The clean-code seat',
    '',
    `Besides the ${count} counted seat(s), seat one clean-code member: lens \`${CLEAN_CODE_LENS}\`, ${COUNCIL_LENSES[CLEAN_CODE_LENS]} It is fixed (no setting removes it). Give it a pool entry of a family no counted seat has: the harness rejects it on a family already seated while another family has no seat. A pick without it is rejected once; then the harness seats it.`,
    ...(rejected.length ? ['', '## Your last pick was rejected', '', ...rejected.at(-1).problems.map((p) => `- ${p}`), '', 'Pick again within the rules.'] : []),
    '',
    `End with: AGENT_RESULT: {"seats": [{"entry": "<pool entry>", "lens": "${one ? SOLE_LENS : '<lens>'}", "reason": "<why>"}, {"entry": "<pool entry>", "lens": "${CLEAN_CODE_LENS}", "reason": "<why>"}]}`,
  ].join('\n');
}

const parsePick = (output) => {
  const raw = extractResult(output ?? '');
  return Array.isArray(raw?.seats) ? raw.seats.map((s) => ({ entry: String(s?.entry ?? ''), lens: String(s?.lens ?? ''), reason: String(s?.reason ?? '').trim() })) : null;
};

// The entries runs can use (council r5, sol-30): with PIPELINE_AGENT_CLI set (a job that installs one CLI), every run
// moves onto that CLI's entries (pool.mjs entryFor), so the council is picked and checked among those, never among
// entries that would silently run as another.
export function effectivePool(config, env = process.env) {
  const pool = poolOf(config);
  return env.PIPELINE_AGENT_CLI ? pool.filter((e) => e?.cli === env.PIPELINE_AGENT_CLI || e?.cli === 'custom') : pool;
}

// The clean-code seat beside the counted seats (GEN-16): the orchestrator's pick (`chosen`) when it kept the rules, else
// the harness's, the best-ranked entry for the clean-code lens by the rule the council applies (council.mjs
// cleanCodeEntry). Named `clean-code` unless a counted seat took the name.
function withCleanCodeSeat(config, stage, { pool, pick, scorecard, chosen }) {
  const e = !chosen && cleanCodeEntry(pool, pick.filter((x) => !x.shadow), byRank(scorecard, stage, CLEAN_CODE_LENS, pool));
  const seat = chosen ?? (e ? { entry: e.name, reason: 'the harness fill: the clean-code seat on the best-ranked entry of a family no counted seat has' } : { entry: soleMember(config, stage).entry, reason: 'the harness fill: no pool entry, so the stage\'s own verifier\'s' });
  return [...pick, cleanCodeSeat(seat, pick.map((x) => x.name ?? x.entry))];
}

// The `council.selection` event of a seating: the pool, each seat with its entry's family and reason, the exploration,
// shadow and clean-code seats, who chose, and the picks rejected on the way.
function recordSelection(config, { stage, subject, step, count, pool, members, scorecard, rejected, fillProblems, chooser, cleanCodeChooser }) {
  const familyOfEntry = (entry) => {
    const e = pool.find((x) => x.name === entry);
    return e ? familyOf(e) : null;
  };
  appendJsonl(metricsFile(config, SELECTIONS_FILE), {
    ts: nowIso(),
    event: 'council.selection',
    stage,
    story: subject,
    ...(step ? { step } : {}),
    seats: count,
    pool: pool.map((e) => ({ entry: e.name, cli: e.cli, model: e.model ?? null, family: familyOf(e) })),
    pick: members.map((m) => ({ seat: m.name, entry: m.entry, family: familyOfEntry(m.entry), lens: m.lens, reason: m.reason, blocking: m.blocking, ...(m.exploration ? { exploration: true } : {}), ...(m.shadow ? { shadow: true } : {}), ...(m.fixed ? { fixed: true } : {}) })),
    lenses: members.map((m) => m.lens),
    reasons: members.map((m) => m.reason),
    // Which seat, if any, was the exploration seat and which the shadow seat.
    explorationSeat: members.find((m) => m.exploration)?.name ?? null,
    shadowSeat: members.find((m) => m.shadow)?.name ?? null,
    // The clean-code seat, and who chose its entry (the orchestrator, or the harness after a pick without a good one).
    cleanCodeSeat: members.find((m) => m.fixed)?.name ?? null,
    cleanCodeChooser,
    scorecardVersion: scorecard.version,
    rejected: rejected.map((r) => ({ pick: r.pick, reason: r.problems.join('; ') })),
    ...(fillProblems.length ? { fillProblems } : {}),
    chooser,
  });
}

// Seats a stage's council for one ticket, once: kept seats are used as they are (no new selection); otherwise the
// orchestrator picks (`run` runs an agent: it may return a promise) under the rules, the pick is kept and one
// `council.selection` event is recorded. Returns the kept seats ({ members, chooser }).
export async function selectCouncil(config, stage, { subject, shape = 'backend', run, step = null, env = process.env }) {
  const kept = savedSeats(config, stage, subject);
  if (kept) return { members: kept, chooser: 'kept' };
  const section = COUNCIL_STAGES[stage].section;
  const count = memberCount(config, stage);
  const pool = effectivePool(config, env);
  if (env.PIPELINE_AGENT_CLI && CORE_LENS[stage] === 'ui' && !pool.some(canDriveBrowser)) {
    throw new Error(`PIPELINE_AGENT_CLI is ${env.PIPELINE_AGENT_CLI}: no models.pool entry on it can drive a browser, and the ${stage} council drives the app (ui); run without the override or add a browser-capable entry on that CLI`);
  }
  const scorecard = scorecardFor(config);
  const explore = explorationEntry(config, { stage, pool, scorecard, count });
  let pick = null;
  let cleanCodePick = null;
  let chooser = 'orchestrator';
  let fillProblems = [];
  const rejected = [];
  // The orchestrator picks every council, one seat too (the entry the stage's own verifier runs on), and the clean-code
  // seat beside the counted seats; a pick that breaks the rules goes back once, and a second bad one is replaced by the
  // harness's own fill. A second pick whose counted seats keep the rules but whose clean-code seat does not keeps its
  // counted seats, and the harness seats the clean-code member.
  const ask = async (problemsOf) => {
    for (let attempt = 1; attempt <= 2 && !pick; attempt++) {
      let res;
      try {
        res = await run({ ...orchestratorRun(config, section), mode: 'read', task: selectionTask({ stage, count, pool, shape, scorecard, explore, rejected }), usage: { stage: `${section}-orchestrator`, story: subject, step: `select-${stage}` } });
      } catch (error) {
        res = { output: '', error: error.message };
      }
      const proposed = parsePick(res?.output);
      const counted = proposed?.filter((x) => x.lens !== CLEAN_CODE_LENS) ?? null;
      const seats = proposed?.filter((x) => x.lens === CLEAN_CODE_LENS) ?? [];
      const own = counted ? problemsOf(counted) : [`no readable pick${res?.error ? ` (${res.error})` : ''}: end with AGENT_RESULT {"seats": [...]}`];
      const problems = [...own, ...(counted ? cleanCodePickProblems({ pool, counted, seats }) : [])];
      if (!problems.length) [pick, cleanCodePick] = [counted, seats[0]];
      else rejected.push({ pick: proposed, problems });
      if (problems.length && attempt === 2 && !own.length) pick = counted;
    }
  };
  if (count === 1) {
    // A sole member reviews everything (lens `all`). The harness's fill is the stage's own verifier on its agent's
    // entry (the PR check's panel on its critics' own entries). The shadow seat, when on, sits beside it as a
    // non-blocking member of another family.
    await ask((proposed) => solePickProblems({ stage, pool, pick: proposed }));
    if (pick) pick = [{ entry: pick[0].entry, lens: SOLE_LENS, reason: pick[0].reason, name: 'verifier' }];
    else {
      // The stage's own verifier on its agent's entry, held to the same rules as a pick (council r4, sol-27: a pair UI
      // seat fell back to a Codex entry, which cannot drive a browser): when its entry breaks them, the best-ranked
      // pool entry that does not. The PR check's panel (no entry of its own) runs its critics on their own entries.
      const own = soleMember(config, stage);
      const ok = (entry) => !solePickProblems({ stage, pool, pick: [{ entry }] }).length;
      const entry = !own.entry || ok(own.entry) ? own.entry : byRank(scorecard, stage, SOLE_LENS, pool).find((e) => ok(e.name))?.name ?? own.entry;
      if (own.entry && !ok(entry)) fillProblems = solePickProblems({ stage, pool, pick: [{ entry }] });
      pick = [{ entry, lens: SOLE_LENS, reason: entry === own.entry ? 'the harness fill: the stage\'s own verifier, which reviews every lens' : `the harness fill: the stage's own verifier's entry ${own.entry} breaks the rules here, so the best-ranked entry that keeps them`, name: 'verifier' }];
      chooser = 'harness';
    }
    const shadow = shadowEntry(config, { stage, pool, scorecard, own: { entry: pick[0].entry } });
    if (shadow) pick.push({ entry: shadow.name, lens: SOLE_LENS, reason: 'the shadow seat: another family beside the sole member, non-blocking, for a unique-findings signal', shadow: true });
  } else {
    await ask((proposed) => pickProblems({ stage, count, pool, pick: proposed, explore }));
    if (!pick) {
      // The fill is held to the same rules (its search keeps only what pickProblems accepts, when the pool allows it);
      // what no fill can meet (a pool with too few entries) is recorded, not hidden.
      chooser = 'harness';
      pick = harnessPick(stage, pool, count, { scorecard, explore });
      fillProblems = pickProblems({ stage, count, pool, pick, explore });
    }
  }
  const cleanCodeChooser = cleanCodePick ? 'orchestrator' : 'harness';
  pick = withCleanCodeSeat(config, stage, { pool, pick, scorecard, chosen: cleanCodePick });
  let explored = false;
  const names = seatNames(pick.filter((s) => !s.name).map((s) => s.entry), pick.filter((s) => s.name).map((s) => s.name));
  let next = 0;
  const members = pick.map((s) => {
    const exploration = Boolean(explore && !explored && s.entry === explore.name);
    explored ||= exploration;
    return { name: s.name ?? names[next++], entry: s.entry, lens: s.lens, blocking: !s.shadow, reason: s.reason, ...(exploration ? { exploration: true } : {}), ...(s.shadow ? { shadow: true } : {}), ...(s.fixed ? { fixed: true } : {}) };
  });
  const file = seatsFile(config, stage, subject);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeText(file, JSON.stringify({ stage, subject, chooser, at: nowIso(), members }, null, 2));
  recordSelection(config, { stage, subject, step, count, pool, members, scorecard, rejected, fillProblems, chooser, cleanCodeChooser });
  return { members: savedSeats(config, stage, subject) ?? members, chooser };
}
