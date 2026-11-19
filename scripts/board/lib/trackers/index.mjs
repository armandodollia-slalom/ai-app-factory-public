// The ticket tracker of a repository: `trackerFor(config)` returns the adapter for `tracker.type`
// (github | jira | azure-boards), with the contract's methods (tickets, board, fields, comments, links).
//
// Calling convention (shared with the code host layer, scripts/pipeline/lib/hosts/index.mjs):
//   - Tracker methods are synchronous. The board stage, the review gate and the pipeline's ticket loader
//     are synchronous, so the REST trackers block on the adapter layers' one synchronous bridge
//     (scripts/pipeline/lib/blocking.mjs). Async code may `await` them all the same.
//   - Every adapter of both layers has a `.sync` form: for a tracker it is the tracker itself; for a code
//     host it is the synchronous twin of its async methods. So synchronous code writes
//     `trackerFor(config).sync.tickets.get(id)` / `hostFor(config).sync.pr.get(n)`, and async code writes
//     `await trackerFor(config).tickets.get(id)` / `await hostFor(config).pr.get(n)`.
//   - A method a product cannot support throws UnsupportedError (scripts/pipeline/lib/hosts/errors.mjs,
//     re-exported here) whose message names the fallback; callers that can degrade catch it.
//
// Which tracker (scripts/pipeline/lib/products.mjs, shared with the host layer and the generator):
// `tracker.type` when set; otherwise GitHub when the legacy keys (`tickets.repo`, `board.*`) are set and
// there is no `host` section; otherwise the code host's own tracker (github -> GitHub issues and Projects,
// azure-devops -> Azure Boards). GitLab has no tracker here, so `tracker.type` must be set: trackerFor
// throws a TrackerError('config') that says so. A repository with a GitHub origin and no new keys is the
// GitHub tracker, exactly as before.
import { azureBoardsTracker } from './azure-boards.mjs';
import { githubTracker, resetGithubMemo } from './github.mjs';
import { jiraTracker } from './jira.mjs';
import { gitlabTracker } from './gitlab.mjs';
import { linearTracker } from './linear.mjs';
import { createCustomAdapter } from '../../../pipeline/lib/providers/custom.mjs';
import { TRACKER_TYPES, trackerTypeFor } from '../../../pipeline/lib/products.mjs';
import { TrackerError } from './shared.mjs';
import { omittedNote, postOmittedSync, sendWithReduction } from '../../../pipeline/lib/hosts/refusal.mjs';

export { TRACKER_TYPES };

// The tracker type of a config (products.mjs holds the defaults, shared with the host layer and the
// generator): `tracker.type`; the legacy GitHub keys; the host's own tracker; a clear error for GitLab.
export function trackerType(config) {
  try {
    return trackerTypeFor(config);
  } catch (error) {
    throw new TrackerError('config', error.message);
  }
}

// One adapter per config object (and per injected runner: tests pass a fake `gh` or `send`).
const cache = new WeakMap();
export function trackerFor(config, opts = {}) {
  const runner = opts.gh ?? opts.send ?? null;
  let byRunner = cache.get(config);
  if (!byRunner) cache.set(config, (byRunner = new Map()));
  if (byRunner.has(runner)) return byRunner.get(runner);
  const type = trackerType(config);
  const tracker = type === 'jira' ? jiraTracker(config, opts) : type === 'azure-boards' ? azureBoardsTracker(config, opts) : type === 'gitlab' ? gitlabTracker(config, opts) : type === 'linear' ? linearTracker(config, opts) : type === 'custom' ? createCustomAdapter('tracker', { ...(config.tracker ?? {}), root: config.root }, opts) : githubTracker(config, opts);
  withRefusalFallback(tracker);
  // The synchronous form, as on a code host: tracker methods already are synchronous.
  if (!('sync' in tracker)) Object.defineProperty(tracker, 'sync', { value: tracker, enumerable: false });
  byRunner.set(runner, tracker);
  return tracker;
}

// Ticket and comment creation through every tracker adapter: a tracker that refuses the TEXT (a content filter,
// pipeline/lib/hosts/refusal.mjs) gets the same request again with the body reduced step by step (its sections from the
// end back, then the ticket key alone as the title), never an agent. A created ticket's body says what was left out, and
// the left-out sections follow as comments where the tracker accepts them (`reduced` on the result says which). The full
// text stays where the caller has it (the board's local ticket file). Refused even when shortest: TrackerError 'refused'.
const GENERIC = { first: [], last: [], keepLine: /^$/ };
export function withRefusalFallback(tracker) {
  const t = tracker.tickets;
  if (!t || t.__refusalFallback) return tracker;
  const create = typeof t.create === 'function' ? t.create.bind(t) : null;
  const comment = typeof t.comment === 'function' ? t.comment.bind(t) : null;
  const refused = (error) => new TrackerError('refused', error.message, { status: error.status ?? 403 });
  if (create) {
    t.create = (args = {}) => {
      let sent;
      try {
        sent = sendWithReduction((x) => create({ ...args, title: x.title, body: x.body }), args.title, args.body ?? '', { ...GENERIC, minimalTitle: args.key ?? String(args.title ?? '').match(/^[A-Z][A-Z0-9]*-\d+/)?.[0] ?? null, note: (st) => omittedNote(st, { comments: Boolean(comment) }) });
      } catch (error) {
        throw error.code === 'refused' && !(error instanceof TrackerError) ? Object.assign(refused(error), { attempts: error.attempts }) : error;
      }
      if (sent.step.step === 0 || !sent.result) return sent.result;
      const id = sent.result.id ?? sent.result.number ?? null;
      const comments = comment && id != null ? postOmittedSync(sent.step.omitted, (text) => comment(id, text)) : [];
      return { ...sent.result, reduced: { dropped: sent.step.dropped, attempts: sent.attempts, comments } };
    };
  }
  if (comment) {
    t.comment = (id, body, opts) => {
      try {
        return sendWithReduction((x) => comment(id, x.body, opts), '', body ?? '', GENERIC).result;
      } catch (error) {
        throw error.code === 'refused' && !(error instanceof TrackerError) ? Object.assign(refused(error), { attempts: error.attempts }) : error;
      }
    };
  }
  Object.defineProperty(t, '__refusalFallback', { value: true, enumerable: false });
  return tracker;
}

export const isGithub = (config) => trackerType(config) === 'github';

// Forgets cached state (GitHub's project ids and the active-board check); tests call it between runs.
export function resetTrackers() {
  resetGithubMemo();
}

export { TrackerError };
export { UnsupportedError } from './shared.mjs';
