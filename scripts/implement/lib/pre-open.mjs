// A pull request opens finished (owner requirement, dogfood C16: "When a pr is opened all automated agentic workflows
// should be completed"). Before the PR exists the story's branch goes through everything the pipeline does: the PR check
// on the branch, its returns to implementation, CI proven on the branch's own pushed head, the review gate's rating, the
// demo video and the whole PR body. Then the PR opens, ready, in its final state. After that only deterministic steps run
// (the gate's merge decision, required checks, auto-merge, board moves, notices). When something goes wrong after the
// open (a check only a PR runs fails, the base moved and CI broke, a person asks for changes), the PR is taken back to
// draft first (`afterOpen`), the agent work happens on the branch through the normal stack, and the PR is marked ready
// again only when everything is complete again. The audit proves the property from the records: no pipeline agent run
// starts after the PR's ready time, unless the PR was in draft (or held) at that moment.
//
// Settings (governance, implement.preOpen in .factory/config.json):
// Every pipeline PR (a ticket's, a bug-epic group's, a feature epic's) opens finished; no setting changes that.
//   branches      null    story branch patterns whose pushes run CI before the PR (default: from implement.branchPrefix,
//                         implement.epic.branchPrefix and implement.epic.bugfixPrefix)
//   afterOpen     'draft' how an open PR is held while agents work on it again: 'draft' (convert to draft and back),
//                         'label' (a blocking work-in-progress label on hosts without drafts), 'close-reopen'
//   wipLabel      'work-in-progress'
//   draftCycles   1       times an open PR may go back to draft before a person decides
// Removed settings, reported by preOpenProblems when a config still has them: `enabled` (an open before the work and
// CI are done is no longer possible) and `failedStory` (a story that does not finish always escalates on its ticket with
// its branch pushed and no PR).
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { ciFor } from '../../pipeline/lib/ci/index.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';
import { AFTER_OPEN, PRE_OPEN_DEFAULTS, PRE_OPEN_REMOVED, addConfigWarning, preOpenProblems } from '../../pipeline/lib/config.mjs';
import { branchFlaky, branchLabel, branchWait, ciFixRounds, ciGate, ciLine, deliveryDecision } from './ci-wait.mjs';
import { headSha } from './gitops.mjs';

export { PRE_OPEN_DEFAULTS, preOpenProblems };

export function preOpenSettings(config) {
  const s = { ...PRE_OPEN_DEFAULTS, ...(config.implement?.preOpen ?? {}) };
  if (!AFTER_OPEN.includes(s.afterOpen)) s.afterOpen = 'draft';
  // The order is not optional (owner requirement C16/C18): no setting opens a PR before its work and CI are done.
  for (const k of Object.keys(PRE_OPEN_REMOVED)) delete s[k];
  return s;
}

// A hold mode the code host cannot do works with a fallback (holdMode): a warning, not a problem. `close-reopen` on a
// host that cannot reopen a closed pull request (Bitbucket Cloud) holds as a draft.
export function preOpenWarnings(config, { host = null } = {}) {
  if (config.implement?.preOpen?.afterOpen !== 'close-reopen') return [];
  let h = host;
  if (!h) {
    try {
      h = hostFor(config).sync;
    } catch {
      h = null;
    }
  }
  return h?.reopenPr === false || h?.capabilities?.reopenPr === false ? [`implement.preOpen.afterOpen "close-reopen" is not supported on ${h.label ?? h.type} (a declined pull request cannot be reopened); "draft" is used instead`] : [];
}
// Config validation warns about it whenever this module is loaded (the run, doctor, the review gate).
addConfigWarning((config) => preOpenWarnings(config));

// The branch patterns whose pushes run CI before a PR exists (the CI renderers write them into the workflows' push
// triggers; provider neutral: each renderer says it in its own syntax).
export function storyBranchPatterns(config) {
  const s = preOpenSettings(config);
  if (Array.isArray(s.branches) && s.branches.length) return s.branches;
  const i = config.implement ?? {};
  const prefixes = [i.branchPrefix ?? 'feat/', i.epic?.branchPrefix ?? 'epic/', i.epic?.bugfixPrefix ?? 'bugfix/'];
  return [...new Set(prefixes.filter(Boolean).map((p) => `${String(p).replace(/\/+$/, '')}/**`))];
}

// ---- the head ledger -------------------------------------------------------------------------------------------------
// Which pull_request activities happened to each head of a pipeline PR (council C10, Sol 2): a workflow is owed by a
// head only for the activities that head went through (opened, synchronize, reopened, ready_for_review, labeled). The
// pipeline performs those activities itself, so it records them as it does; a head it did not push (a person's push to
// the PR) is a `synchronize`.

const mainRoot = (config) => config.mainRoot ?? config.root;
const prNo = (pr) => String(pr ?? '').match(/(\d+)\/?$/)?.[1] ?? null;
export const ledgerFile = (config, pr) => path.join(mainRoot(config), config.stateDir ?? '.factory/state', 'review-gate', `heads-pr-${prNo(pr)}.json`);

export function recordHeadActivity(config, pr, head, activity, { at = nowIso() } = {}) {
  if (!prNo(pr) || !head) return null;
  const file = ledgerFile(config, pr);
  const l = readJson(file, null) ?? { pr: String(pr), opened: null, heads: {}, events: [] };
  if (activity === 'opened' && !l.opened) l.opened = head;
  l.heads[head] = [...new Set([...(l.heads[head] ?? []), activity])];
  l.events.push({ at, head, activity });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, l);
  return l;
}

// The activities a head went through, or null when nothing is known about the PR (not a pipeline PR).
export function headActivities(config, pr, head) {
  const l = readJson(ledgerFile(config, pr), null);
  if (!l) return null;
  if (l.heads?.[head]?.length) return l.heads[head];
  // Not pushed by the pipeline: a later push to the open PR.
  return l.opened && head !== l.opened ? ['synchronize'] : ['opened'];
}

// ---- holding an open PR while agents work on it again ------------------------------------------------------------
// Through the host contract (scripts/pipeline/lib/hosts): `host` is hostFor(config).sync. The mode follows the host's
// capabilities: 'draft' needs `drafts`, 'label' needs `labels`; a host with neither closes the PR and reopens it.

export function holdMode(host, wanted = 'draft') {
  const cap = host?.capabilities ?? {};
  const canCloseReopen = host?.reopenPr !== false && cap.reopenPr !== false;
  if (wanted === 'draft' && cap.drafts) return 'draft';
  if (wanted === 'label' && cap.labels) return 'label';
  if (wanted === 'close-reopen' && canCloseReopen) return 'close-reopen';
  if (cap.drafts) return 'draft';
  if (cap.labels) return 'label';
  return canCloseReopen ? 'close-reopen' : 'draft';
}

const syncSleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function confirmPrState(host, pr, { mode, label, held, attempts = 3, delayMs = 1000, sleep = syncSleep } = {}) {
  if (typeof host?.pr?.get !== 'function') return false;
  const max = Math.max(1, Number(attempts) || 1);
  for (let i = 0; i < max; i++) {
    if (i > 0) sleep(delayMs);
    let view;
    try {
      view = host.pr.get(pr);
    } catch {
      continue;
    }
    if (!view || typeof view !== 'object') continue;
    const isDraft = Boolean(view.draft ?? view.isDraft);
    const labels = Array.isArray(view.labels) ? view.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
    const state = String(view.state ?? '').toLowerCase();
    const ok = mode === 'draft'
      ? (held ? isDraft : !isDraft && (state === '' || state === 'open'))
      : mode === 'label'
        ? (held ? labels.includes(label) : !labels.includes(label))
        : (held ? state === 'closed' : state === 'open');
    if (ok) return true;
  }
  return false;
}

// ---- the hold record: the pipeline's own closes and reopens of a PR (close-reopen holds) ---------------------------
// After the host confirms a close or reopen the pipeline made, it records that exact event on the PR (a comment of its
// own): the host's event id, else the exact time and actor the host returned. The review gate trusts a record only when
// the comment's author is the identity the pipeline acts as on the host, and only for an event that identity made with
// that id: one record, one event, no time window. Any other close or reopen is a person's. A close whose record could not
// be written (a crash in between, a failed read) is therefore a person's: one more review, never a wrong merge.
export const HOLD_LEDGER = '<!-- factory:holds';
const identities = new WeakMap();
// The login the pipeline acts as on `host`, resolved once per host (null when it cannot be read: then no close or reopen
// is taken for the pipeline's).
export function pipelineIdentity(host) {
  if (!host || typeof host !== 'object') return null;
  if (!identities.has(host)) {
    let login;
    try {
      login = host.identity?.()?.login ?? null;
    } catch {
      login = null;
    }
    identities.set(host, typeof login === 'string' && login ? login : null);
  }
  return identities.get(host);
}
// The entries of the PR's hold records written by `identity` (comments by anyone else are ignored).
export function readHoldLedger(host, pr, identity = pipelineIdentity(host)) {
  if (!identity) return [];
  const entries = [];
  for (const c of host.pr.comments(pr) ?? []) {
    if (c.author !== identity || !String(c.body ?? '').includes(HOLD_LEDGER)) continue;
    const m = /<!-- factory:holds (\[[\s\S]*?\]) -->/.exec(c.body);
    if (!m) throw new Error('a hold record on the PR cannot be read');
    entries.push(...JSON.parse(m[1]));
  }
  return entries;
}
const eventKey = (e) => (e.id != null ? `id:${e.id}` : `at:${e.at}|${e.actor}`);
const entryKey = (h) => (h.event != null ? `id:${h.event}` : `at:${h.at}|${h.actor}`);
// The events (of `events`) that are the pipeline's own: made by `identity`, each named by one record of that type.
export function pipelineEvents(events, ledger, identity) {
  const own = new Set();
  if (!identity) return own;
  const records = new Map(ledger.filter((h) => h && (h.event != null || (h.at && h.actor))).map((h) => [entryKey(h), h]));
  for (const e of events) {
    if (!['closed', 'reopened'].includes(e.type) || e.actor !== identity || (e.id == null && !e.at)) continue;
    const h = records.get(eventKey(e));
    if (h && h.type === e.type) {
      own.add(e);
      records.delete(eventKey(e));
    }
  }
  return own;
}
// The PR's close and reopen events before the pipeline's own update (a snapshot of their keys), or null when they cannot
// be read: then nothing the update makes can be told from a person's event, and nothing is recorded.
export function eventSnapshot(host, pr) {
  try {
    if (host.capabilities?.stateEvents !== true) return null;
    const events = host.pr.stateEvents?.(pr);
    return Array.isArray(events) ? new Set(events.map(eventKey)) : null;
  } catch {
    return null;
  }
}
// Records the pipeline's own close or reopen of `pr` that its update just made: an event of that type, made by its
// identity, that is new since `before` (the snapshot taken right before the update). An update that threw, did nothing
// (the PR already closed or open) or made no new event records nothing: that event stays a person's. Returns the entry,
// or null.
export function recordOwnEvent(host, pr, type, before, why = null) {
  try {
    const identity = pipelineIdentity(host);
    if (!identity || !before || host.capabilities?.stateEvents !== true) return null;
    const fresh = (host.pr.stateEvents?.(pr) ?? []).filter((x) => x.type === type && x.actor === identity && (x.id != null || x.at) && !before.has(eventKey(x)));
    if (fresh.length !== 1) return null;
    const [e] = fresh;
    const entry = { type, ...(e.id != null ? { event: e.id } : { at: e.at, actor: e.actor }), ...(why ? { why: String(why).slice(0, 200) } : {}) };
    host.pr.comment(pr, `${HOLD_LEDGER} ${JSON.stringify([entry])} -->\nThe pipeline ${type === 'closed' ? 'closed' : 'reopened'} this PR itself (a hold while agents work on it again); any other close or reopen is a person's.`);
    return entry;
  } catch {
    return null;
  }
}

// Takes an open PR out of the ready state before any agent works on it again; returns the hold to record. Auto-merge is
// disarmed first (where the host can), so a PR on hold never merges. Confirms by re-reading the PR from the host.
export function holdPr(host, pr, { mode = 'draft', label = 'work-in-progress', why, at = nowIso(), attempts = 3, delayMs = 1000, sleep = syncSleep } = {}) {
  const m = holdMode(host, mode);
  if (host.capabilities?.cancelAutoMerge) {
    try {
      host.pr.cancelAutoMerge(pr);
    } catch {
      // nothing armed
    }
  }
  let ok;
  let threw = false;
  const before = m === 'close-reopen' ? eventSnapshot(host, pr) : null;
  try {
    if (m === 'draft') host.pr.update(pr, { draft: true });
    else if (m === 'label') {
      try {
        host.repo.ensureLabel(label, { color: 'B60205', description: 'The pipeline is working on this PR again; do not merge' });
      } catch {
        // an existing label
      }
      host.pr.update(pr, { labels: { add: [label] } });
    } else host.pr.update(pr, { state: 'closed' });
    ok = confirmPrState(host, pr, { mode: m, label, held: true, attempts, delayMs, sleep });
  } catch {
    threw = true;
    ok = confirmPrState(host, pr, { mode: m, label, held: true, attempts: 1, delayMs: 0, sleep });
  }
  // The close is the pipeline's only once recorded by the event its own update made (otherwise a person's).
  const recorded = m === 'close-reopen' ? (ok && !threw ? Boolean(recordOwnEvent(host, pr, 'closed', before, why)) : false) : null;
  if (ok) {
    try {
      host.pr.comment(pr, `**On hold: the pipeline is working on this PR again** (${m === 'draft' ? 'converted to draft' : m === 'label' ? `labelled \`${label}\`` : 'closed until it is complete'}).\n\nWhy: ${why}\n\nIt is marked ready again only when the change has passed the whole stack again (static analysis, council, architecture review, feature verification, PR check, CI on the head).`, { marker: '<!-- factory:hold -->' });
    } catch {
      // the record keeps the hold
    }
  }
  return { mode: m, label, ok, from: at, why, ...(recorded === null ? {} : { recorded }) };
}

export function releasePr(host, pr, { mode = 'draft', label = 'work-in-progress', attempts = 3, delayMs = 1000, sleep = syncSleep } = {}) {
  const before = mode === 'close-reopen' ? eventSnapshot(host, pr) : null;
  try {
    if (mode === 'draft') host.pr.update(pr, { draft: false });
    else if (mode === 'label') host.pr.update(pr, { labels: { remove: [label] } });
    else host.pr.update(pr, { state: 'open' });
  } catch {
    // An update that threw records nothing, whatever the PR shows now.
    return confirmPrState(host, pr, { mode, label, held: false, attempts: 1, delayMs: 0, sleep });
  }
  const ok = confirmPrState(host, pr, { mode, label, held: false, attempts, delayMs, sleep });
  // The reopen is recorded by the event its own update made (none, or unrecorded: the gate takes it for a person's).
  if (ok && mode === 'close-reopen') recordOwnEvent(host, pr, 'reopened', before);
  return ok;
}

// ---- the audit: no agent run after the PR is ready ---------------------------------------------------------------

// Agent runs (usage rows: `ts` is when the run ended, `seconds` how long it took) of a story that started after its PR's
// `readyAt` and outside every hold window [{ from, to }]. Empty means the property holds.
// `keys`: every ticket the PR delivers (an epic unit's tickets, its feature verification key and the epic's own key).
export function agentRunsAfterReady(rows, { key, keys = [key], readyAt, holds = [] }) {
  const ready = Date.parse(readyAt ?? '');
  if (!ready) return [];
  const inHold = (t) => holds.some((h) => h.ok !== false && t >= Date.parse(h.from) && (!h.to || t <= Date.parse(h.to)));
  const seen = new Set();
  const out = [];
  for (const r of rows ?? []) {
    if (!keys.includes(r.story)) continue;
    const id = r.run_id ?? `${r.ts}|${r.agent}|${r.member ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const end = Date.parse(r.ts ?? '');
    if (!end) continue;
    const start = end - Number(r.seconds ?? 0) * 1000;
    if (start > ready && !inHold(start)) out.push({ agent: r.agent, member: r.member ?? null, stage: r.stage ?? null, started: new Date(start).toISOString() });
  }
  return out;
}

// ---- the PR body's media, before the PR exists ---------------------------------------------------------------------
// The demo video and API summary sections the story branch's push run stored (pr-video --key: `<folder>/section.md`,
// `<folder>-api/api.md` on the storage branch), when they were recorded on this head. `host` is hostFor(config).sync;
// `folder` is pr-video's keyFolder(branch). { video, api, notes }
export function preOpenMedia(host, { folder, head, storageBranch = 'pr-videos' }) {
  const notes = [];
  const read = (file) => {
    try {
      return host.repo.file(file, storageBranch);
    } catch {
      return null;
    }
  };
  const section = (file, what) => {
    const text = read(file);
    if (text == null) {
      notes.push(`no ${what} was recorded for this branch`);
      return null;
    }
    const at = /<!-- head: ([0-9a-f]*) -->/.exec(text)?.[1] ?? '';
    if (at && head && !head.startsWith(at) && !at.startsWith(head)) {
      notes.push(`the ${what} was recorded on ${at.slice(0, 7)}, not on this head ${String(head).slice(0, 7)}`);
      return null;
    }
    const body = text.replace(/<!-- head: [0-9a-f]* -->\n?/, '').trim();
    return body || null;
  };
  return { video: section(`${folder}/section.md`, 'demo video'), api: section(`${folder}-api/api.md`, 'API summary'), notes };
}

// The audit of one delivered story (run record and doctor): agent runs that started after its PR was ready, outside a
// hold. `rows`: its token-usage rows. { ok, after: [...], readyAt, holds }
export function readyAudit(run, rows) {
  if (!run?.readyAt) return { ok: true, after: [], readyAt: null, holds: run?.holds ?? [] };
  const after = agentRunsAfterReady(rows, { keys: run.keys ?? [run.key], readyAt: run.readyAt, holds: run.holds ?? [] });
  return { ok: after.length === 0, after, readyAt: run.readyAt, holds: run.holds ?? [] };
}

// CI proven on a branch's own pushed head before its PR exists: one code path for a standalone ticket and an epic unit
// (a bug-epic group or the feature epic; council C11: epic units opened their PR before the CI gate). The branch must
// already be pushed. The CI gate runs on the branch's push runs (a fixing round, if red, pushes the branch). The base
// may move meanwhile: `sync` merges and pushes it, and a head that moved is proven again.
// Returns { branchCi, draftFirst, provenHead, delivery (set when CI is not green: no PR opens), syncFailed }.
//   label        the story key or unit id, for logs, records and seed files
//   stories      the ticket keys (run-conditions records)
export async function proveBeforeOpen(config, { label, stories = [label], branch, worktree, base, issues = [], targetArgs, prCheckCli, env, stateDir, repo, sync, log, gate: runGate = ciGate, remedy = null }) {
  const settings = config.implement ?? {};
  const out = { branchCi: null, draftFirst: false, provenHead: null, delivery: null, syncFailed: null };
  if (!repo || settings.ciWait === false) return out;
  if (!ciFor(config).capabilities?.branchPipelines) {
    out.draftFirst = true;
    log(`${label}: ${ciFor(config).type} cannot run the pipelines on a branch push (capability branchPipelines): the PR opens as a draft and is marked ready when its checks are green`);
    return out;
  }
  const where = { branch, base, head: () => headSha(worktree), changed: () => String(git(worktree, ['diff', '--name-only', `${base}...HEAD`]).stdout ?? '').split('\n').filter(Boolean) };
  const prove = async () => {
    const gate = await runGate({ config, ciOptions: { ciSettings: settings.reviewGate?.ci ?? {} }, fixRounds: ciFixRounds(settings), repo, pr: branchLabel(branch), branch, cwd: worktree, prCheckCli, targetArgs, base, env, seedFile: path.join(stateDir, `${label}-branch-ci-fix.json`), log: (m) => log(`${label}: ${m}`), wait: branchWait(where), flakyOf: branchFlaky(where), resolveDirty: null, ...(settings.ciWaitSec ? { timeoutSec: settings.ciWaitSec } : {}), ...(settings.ciPollSec != null ? { pollSec: settings.ciPollSec } : {}), ...(settings.ciSettleSec != null ? { settleSec: settings.ciSettleSec } : {}) });
    out.provenHead = headSha(worktree);
    log(`${label}: before its PR, on ${branch}@${out.provenHead.slice(0, 7)}: ${ciLine(gate)}`);
    appendJsonl(metricsFile(config, 'run-conditions.jsonl'), [{ ts: nowIso(), story: stories[0], ...(stories.length > 1 ? { stories } : {}), kind: 'branch-ci', branch, head: out.provenHead, state: gate.state, rounds: gate.rounds ?? 0, pipelines: gate.names ?? [], prOnly: gate.prOnly ?? [] }]);
    return gate;
  };
  const judge = (gate) => (gate.state === 'none' ? null : deliveryDecision(gate, { issues }));
  // A red branch CI goes back for a fix before the PR opens: after the gate's fixing round, the harness's own way out
  // once (`remedy`: CI's analysis jobs run here, the secret decision table's fold or one more fixing round, then a push);
  // a new head is proven again. Without a way out the delivery escalates as before.
  const remedied = async () => {
    if (!remedy || !out.delivery || out.remedy) return;
    const r = (await remedy(out.branchCi)) ?? { retried: false, reason: 'no way out' };
    out.remedy = { retried: Boolean(r.retried), reason: r.reason ?? null, decisions: r.decisions ?? [] };
    log(`${label}: ${r.retried ? `the harness's way out after the red CI: ${r.reason}; proving the new head` : `no harness way out after the red CI: ${r.reason ?? 'none'}`}`);
    if (!r.retried) return;
    out.branchCi = await prove();
    out.delivery = judge(out.branchCi);
  };
  out.branchCi = await prove();
  if (out.branchCi.state === 'none') {
    out.draftFirst = true;
    log(`${label}: no pipeline runs on a push of ${branch}: the PR opens as a draft and is marked ready when its checks are green`);
  } else {
    out.delivery = judge(out.branchCi);
    await remedied();
    if (out.delivery) return out;
  }
  // The PR opens on the head CI proved, or not at all: the base is merged in and pushed now, and a moved head is proven again.
  const before = out.provenHead;
  const synced = await sync();
  if (!synced.pushed) {
    out.syncFailed = synced.reason ?? 'the push failed';
    return out;
  }
  if (headSha(worktree) !== before) {
    log(`${label}: the head moved from ${before.slice(0, 7)} to ${headSha(worktree).slice(0, 7)} after CI proved it; proving the new head before the PR`);
    out.branchCi = await prove();
    out.delivery = judge(out.branchCi);
    await remedied();
  }
  return out;
}
