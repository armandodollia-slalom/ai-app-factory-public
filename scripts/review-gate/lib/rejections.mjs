// Whether a person rejected any ticket of a PR, read when the gate decides (owner rule: a ticket a person rejected is
// never merged by the gate again, whatever its new rating; docs/ai-pipeline/review-gate.md#human-reopens). Every path that
// can merge on its own (publish, regate from board sync or after the CI wait, a merge retried) decides through
// withCurrentRejections, and decideGate refuses auto-merge for a ticket it did not mark checked: the proof is positive.
//
// For each ticket, from the ticket, its run record and the code host as they are now:
//   - the reopens its `## Triage` section and the metrics (this checkout's and its main checkout's) record, and its issue
//     standing reopened now;
//   - every PR of the ticket: those its record names (the triage's `prs` and `pr`, its run record's PRs), those the host
//     lists for its branches or with its key in the title (targeted queries read to the end), and this PR. On each, a person's live "changes requested"
//     (cleared only by a later approval of the same person) and every close or reopen that is not one of the pipeline's
//     own holds: an event its hold record names by the host's event id (or exact time), written by the pipeline's own
//     identity, made by that identity;
// and unknown is review: a ticket with no issue, a history that cannot be read in full, a host that does not report a PR's
// closes and reopens, more rejections stored on the PR than its history shows, or a forced re-run, leaves the ticket
// unchecked, so it needs a person.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../../pipeline/lib/util.mjs';
import { readMetricsLocal } from '../../pipeline/lib/state.mjs';
import { pipelineEvents, pipelineIdentity, readHoldLedger } from '../../implement/lib/pre-open.mjs';
import { mainCheckout } from './assessment.mjs';
import { ticketBody, ticketNow } from './fields.mjs';
import { prHost, prReviewComments, toReview } from './github.mjs';
import { mergeReopens, reviewTargets, ticketReopens } from './reopens.mjs';
import { prClass, prSeverity, ticketSeverity } from './severity.mjs';
import { gateSystemsSettings } from './systems.mjs';
import { extractTriage } from './triage-section.mjs';

// Set on an assessment the live read produced, so a caller that already read it does not read it again.
export const LIVE = Symbol('rejections read live');
const first = (error) => String(error?.message ?? error).split('\n')[0];
// The most PRs one targeted query reads (a ticket's branch, its key in the title); reaching it is unknown, so review.
const LIST_LIMIT = 500;
// How many PRs one query reads before the key filter (a search also returns PRs that only resemble the key): a query
// that fills it is unknown, so is one whose kept PRs reach LIST_LIMIT.
const FETCH_LIMIT = 1000;

// The reopens a ticket's record holds, without the code host: its triage section and the metrics of this checkout and of
// its main checkout (where `board sync` writes them). Map key -> { reopens, triage, unknown }.
export function recordedReopens(config, gh, tickets, { cwd = config.root } = {}) {
  const outcomes = outcomeRows(config, cwd);
  return new Map(tickets.map((t) => {
    const issue = issueOf(t);
    let triage = null;
    let unknown = null;
    if (issue) {
      try {
        triage = extractTriage(ticketBody(config, gh, issue));
      } catch (error) {
        unknown = `its issue could not be read (${first(error)})`;
      }
    }
    return [t.key, { reopens: ticketReopens({ key: t.key, triage, outcomes }), triage, unknown }];
  }));
}
function outcomeRows(config, cwd) {
  const read = (c) => {
    try {
      return readMetricsLocal(c, 'decision-outcomes.jsonl');
    } catch {
      return [];
    }
  };
  const main = mainCheckout(cwd);
  return [...read(config), ...(path.resolve(main) !== path.resolve(config.root) ? read({ ...config, root: main }) : [])];
}
const issueOf = (t) => t.issue?.number ?? (typeof t.issue === 'number' ? t.issue : null);

// A PR's state events; `person`: its close and reopen events that are a person's; `unknown`: those its pipeline's own
// identity made that no record of the pipeline names (an interrupted hold, or a person on the same login): never stored
// as a rejection, read as unknown (review) until told apart. Throws when they cannot be read (the host does not report
// them, or a read fails). A merge's own close (the same commit, or the same time and actor as the merge event) is neither.
export function personEvents(host, pr) {
  if (host?.capabilities?.stateEvents !== true || typeof host.pr?.stateEvents !== 'function') throw new Error('the code host does not report the closes and reopens of a PR');
  const events = host.pr.stateEvents?.(pr);
  if (!Array.isArray(events)) throw new Error('the code host does not report the closes and reopens of a PR');
  const identity = pipelineIdentity(host);
  const own = pipelineEvents(events, identity ? readHoldLedger(host, pr, identity) : [], identity);
  const merges = events.filter((e) => e.type === 'merged');
  const mergeClose = (e) => merges.some((m) => (e.commit && m.commit ? e.commit === m.commit : Boolean(e.at) && e.at === m.at && e.actor === m.actor));
  const theirs = events.filter((e) => ['closed', 'reopened'].includes(e.type) && !own.has(e) && !(e.type === 'closed' && mergeClose(e)));
  return { events, person: theirs.filter((e) => !identity || e.actor !== identity), unknown: theirs.filter((e) => identity && e.actor === identity) };
}

// What a PR's history says now: { rejections: [{ reopen, keys|null }], error }.
function prHistory(host, pr, keys) {
  try {
    const out = [];
    const reviews = host.pr.reviews(pr, { strict: true }).map(toReview);
    let comments = [];
    try {
      comments = prReviewComments(host, null, pr);
    } catch {
      // no line comments: a review then names every ticket
    }
    // A person's "changes requested" stays live until the same person approves later; nothing else clears it. A dismissed
    // review counts by the state it had: a dismissed "changes requested" is one, a dismissed approval or comment is not;
    // one whose earlier state the host does not tell makes the history unknown (review, and no rejection is stored).
    const live = new Map();
    const unknown = new Map();
    for (const r of [...reviews].sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')))) {
      if (r.user?.type === 'Bot' || !r.user?.login) continue;
      const state = r.state === 'DISMISSED' ? r.dismissed_state ?? 'UNKNOWN' : r.state;
      if (state === 'CHANGES_REQUESTED') live.set(r.user.login, r);
      else if (state === 'UNKNOWN') unknown.set(r.user.login, r);
      else if (state === 'APPROVED' && r.state === 'APPROVED') {
        live.delete(r.user.login);
        unknown.delete(r.user.login);
      }
    }
    if (unknown.size) throw new Error(`a review by @${[...unknown.keys()][0]} was dismissed and the host does not say what it was`);
    for (const r of live.values()) out.push({ keys: keys ? reviewTargets(r, comments, keys) : null, reopen: { at: r.submitted_at ?? null, source: 'changes-requested', detail: `changes requested by @${r.user.login}`, by: r.user.login, pr, afterMerge: false } });
    const states = personEvents(host, pr);
    if (states.unknown.length) throw new Error(`a ${states.unknown[0].type === 'closed' ? 'close' : 'reopen'} by the pipeline's own login that no record of the pipeline names (an interrupted hold, or a person on the same login)`);
    for (const e of states.person) {
      out.push({ keys: null, reopen: { at: e.at ?? null, source: e.type === 'closed' ? 'pr-closed' : 'pr-reopened', detail: `PR ${e.type === 'closed' ? 'closed without merge' : 'reopened'}${e.actor ? ` by @${e.actor}` : ''} (not a hold the pipeline recorded)`, by: e.actor ?? null, pr, afterMerge: false } });
    }
    return { rejections: out, error: null };
  } catch (error) {
    return { rejections: [], error: `the history of ${pr} could not be read (${first(error)})` };
  }
}

// The ticket's run record in the main checkout (implement's), or null.
function runRecord(config, cwd, key) {
  const file = path.join(mainCheckout(cwd), config.stateDir ?? '.factory/state', 'implement', `${key}.json`);
  return fs.existsSync(file) ? readJson(file, null) : null;
}

// The assessment `a` with each ticket's reopens read again now (merged with what it had; its severity and the PR's
// recomputed when they changed), and `rejectionChecked` set only for a ticket whose whole history was read;
// `reopensUnknown` says why otherwise. An unknown the assessment already carries (rebuildAssessment: the PR stores more
// rejections than the ticket's record shows) is never cleared here.
export function withCurrentRejections(config, gh, a, { cwd = config.root } = {}) {
  let host = null;
  let hostError = null;
  try {
    host = prHost(config, gh);
    if (host.capabilities?.stateEvents !== true || typeof host.pr?.stateEvents !== 'function') hostError = 'the code host does not report the closes and reopens of a PR';
  } catch (error) {
    hostError = `the code host could not be reached (${first(error)})`;
  }
  const outcomes = outcomeRows(config, cwd);
  const keys = a.tickets.map((t) => t.key);
  const histories = new Map();
  const history = (pr) => {
    if (!histories.has(pr)) histories.set(pr, prHistory(host, pr, pr === a.pr ? keys : null));
    return histories.get(pr);
  };
  // A ticket's PRs on the host: those on its branches and those with its key in the title, each asked for by a targeted
  // query read to the end; the cap applies to the PRs kept after the filter, and a query whose unfiltered answer fills
  // what is read is unknown too (review), never a short list.
  const queries = new Map();
  const hostPrs = (opts, what) => {
    const id = JSON.stringify(opts);
    if (!queries.has(id)) {
      try {
        const prs = host.pr.list({ state: 'all', limit: FETCH_LIMIT, ...opts }) ?? [];
        queries.set(id, prs.length >= FETCH_LIMIT ? { prs, error: `${what} match ${FETCH_LIMIT} PRs or more, more than the gate reads` } : { prs, error: null });
      } catch (error) {
        queries.set(id, { prs: [], error: `the PRs ${what} could not be listed (${first(error)})` });
      }
    }
    return queries.get(id);
  };
  const s = gateSystemsSettings(config);
  let changed = false;
  const tickets = a.tickets.map((t) => {
    const issue = issueOf(t);
    let unknown = typeof t.reopensUnknown === 'string' ? t.reopensUnknown : t.reopensUnknown ? 'an earlier read of its history was incomplete' : hostError;
    let triage = null;
    const live = [];
    if (!issue) unknown ??= 'it has no issue to read its history from';
    else {
      try {
        const now = ticketNow(config, gh, issue);
        if (!now) throw new Error('not found');
        triage = extractTriage(now.body ?? '');
        // An issue standing reopened was reopened by a person after it was closed: a rejection, whatever sync recorded.
        if (String(now.state ?? '').toLowerCase() === 'open' && String(now.stateReason ?? '').toUpperCase() === 'REOPENED') live.push({ at: null, source: 'issue', detail: 'issue reopened (it stands reopened)', pr: null, afterMerge: false });
      } catch (error) {
        unknown ??= `its issue could not be read (${first(error)})`;
      }
    }
    const run = runRecord(config, cwd, t.key);
    if (run?.historyUnknown) unknown ??= run.historyUnknown;
    if (!unknown) {
      const named = [...(triage?.prs ?? []), triage?.pr, a.pr, run?.pr, ...(run?.earlierPrs ?? []), ...(run?.attempts ?? []).map((x) => x?.pr)];
      const branches = [...new Set([run?.branch, a.view?.headRefName].filter(Boolean))];
      const word = new RegExp(`(^|[^A-Za-z0-9-])${t.key.replace(/[-]/g, '\\-')}(?![0-9])`, 'i');
      const found = [];
      for (const [opts, what, keep] of [...branches.map((b) => [{ head: b }, `on ${b}`, (p) => p.head === b]), [{ search: t.key }, `naming ${t.key}`, (p) => word.test(String(p.title ?? ''))]]) {
        const list = hostPrs(opts, what);
        const kept = list.prs.filter(keep);
        if (list.error) unknown ??= list.error;
        if (kept.length >= LIST_LIMIT) unknown ??= `${what} match ${LIST_LIMIT} PRs or more, more than the gate reads`;
        found.push(...kept.map((p) => p.url));
      }
      for (const pr of [...new Set([...named, ...found].filter(Boolean))]) {
        if (unknown) break;
        const h = history(pr);
        if (h.error) unknown = h.error;
        else live.push(...h.rejections.filter((r) => !r.keys || r.keys.includes(t.key)).map((r) => r.reopen));
      }
    }
    const reopens = mergeReopens(t.reopens ?? [], ticketReopens({ key: t.key, triage, outcomes }), live);
    // The gate stored more rejections of this ticket on the PR than its history shows now: a record was lost.
    if (Number(t.storedReopens) > reopens.length) unknown ??= `the PR's gate state records ${t.storedReopens} rejection(s) of it, its history shows ${reopens.length}`;
    const out = { ...t, reopens, rejectionChecked: !unknown };
    if (reopens.length !== (t.reopens ?? []).length) {
      changed = true;
      if (t.impact || t.fixRisk) out.severity = ticketSeverity({ impact: t.impact, complexity: t.complexity, fixRisk: t.fixRisk, floorReasons: t.floorReasons ?? [], reopens: reopens.length }, s);
    }
    if (unknown) out.reopensUnknown = unknown;
    else delete out.reopensUnknown;
    return out;
  });
  const result = { ...a, tickets };
  if (changed) {
    const systems = a.systems ?? { names: [], shared: false, contract: false };
    result.severity = prSeverity({ tickets, systems }, s);
    result.class = prClass({ severity: result.severity.level, shared: Boolean(systems.shared || systems.contract) });
  }
  result[LIVE] = true;
  return result;
}
