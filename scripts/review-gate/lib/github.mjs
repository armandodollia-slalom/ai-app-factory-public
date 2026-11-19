// The code host calls of the review gate. Pull requests go through the code host (scripts/pipeline/lib/hosts, the
// `host` contract of scripts/pipeline/lib/providers/contracts.mjs); tickets, labels on them, assignees and triage
// fields through the ticket tracker (fields.mjs); the CI evidence of a head through the CI layer
// (scripts/pipeline/lib/ci). `gh` is the injectable gh runner (args, { input, env }) -> { status, stdout, stderr }
// the GitHub adapters use, so tests use an in-memory GitHub. All merging goes through mergePr (one function, one
// identity setting), bound to the head the gate assessed.
import { ghCli, hostFor, hostOf } from '../../pipeline/lib/hosts/index.mjs';
import { ciTarget } from '../../pipeline/lib/ci/index.mjs';
import { checksSummary, combine } from '../../pipeline/lib/ci/evidence.mjs';
import { headWorkflows } from './expected-ci.mjs';

// The real gh runner (it lives in the GitHub host adapter).
export const realGh = ghCli;

export const prNumber = (pr) => Number(/\/pull\/(\d+)/.exec(String(pr))?.[1] ?? /merge_requests\/(\d+)/.exec(String(pr))?.[1] ?? /pullrequest\/(\d+)/i.exec(String(pr))?.[1] ?? String(pr).replace(/^[#!]/, '')) || null;

// ---------------------------------------------------------------------------------------------
// Pull requests: through the code host (scripts/pipeline/lib/hosts). Each helper takes the code host
// (`prHost(config, gh)`, synchronous form) or, as before the adapters, a gh runner and the GitHub
// repository. The results keep the GitHub shapes the gate's logic reads (pr-review, reopens, quorum).
// ---------------------------------------------------------------------------------------------

const hosts = new WeakMap();
// The synchronous code host of the review gate's config; `gh` runs GitHub (and the tests' fake GitHub).
export function prHost(config, gh = realGh, deps = {}) {
  if (Object.keys(deps).length) return hostFor(config, { gh, repo: config.board?.repo, ...deps }).sync;
  let byGh = hosts.get(config);
  if (!byGh) hosts.set(config, (byGh = new WeakMap()));
  if (!byGh.has(gh)) byGh.set(gh, hostFor(config, { gh, repo: config.board?.repo }).sync);
  return byGh.get(gh);
}

const asHost = (target, repo) => (typeof target === 'function' ? hostOf(target, { repo }) : target);

// Normalised PR -> the `gh pr view` shape.
export const toView = (p) =>
  p && {
    number: p.number,
    url: p.url,
    state: String(p.state ?? 'open').toUpperCase(),
    author: p.author ?? null,
    createdAt: p.createdAt ?? null,
    mergedAt: p.mergedAt ?? null,
    closedAt: p.closedAt ?? null,
    headRefName: p.head ?? null,
    headRefOid: p.headSha ?? null,
    baseRefName: p.base ?? null,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    changedFiles: p.changedFiles ?? null,
    labels: p.labels ?? [],
    body: p.body ?? '',
    title: p.title ?? '',
    isDraft: Boolean(p.draft),
    mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
  };
// Normalised review / review comment / commit -> GitHub's REST shapes.
export const toReview = (r) => ({ id: r.id, user: { login: r.author, type: r.bot ? 'Bot' : 'User' }, state: String(r.state ?? '').toUpperCase(), submitted_at: r.submittedAt ?? null, commit_id: r.commit ?? null, body: r.body ?? '' });
export const toReviewComment = (c) => ({ id: c.id, user: { login: c.author }, body: c.body ?? '', path: c.path ?? null, line: c.line ?? null, pull_request_review_id: c.reviewId ?? null, created_at: c.createdAt ?? null });
// `parents` is a count (null when the host does not say: such a commit never counts as a base merge).
export const toCommit = (c) => ({ sha: c.sha, author: c.author ? { login: c.author } : null, parents: Array.from({ length: c.parents ?? 0 }, () => ({})), commit: { message: c.message ?? '', committer: { date: c.committedAt ?? null } } });

export function prView(target, repo, pr) {
  const p = asHost(target, repo).pr.get(pr);
  if (!p) throw new Error(`pull request ${pr} not found`);
  return toView(p);
}

export const prFiles = (target, repo, pr) => asHost(target, repo).pr.files(pr).map((f) => f.path);

// 'success' | 'pending' | 'failure' | null (no checks reported yet, or the CI evidence cannot be read).
// The PR's CI state. The gate's own approval check (`review-quorum`) is not CI: it fails until people approve,
// and counting it called a green PR's checks "failure" (dogfood C5, #69). Green also needs every pipeline the head is
// expected to run (pipeline/lib/ci/evidence.mjs) completed and green: never "nothing is red" (council C9: a Low PR could
// be authorised to merge while its application workflows had not registered).
// `target`: a gh runner (GitHub with GitHub Actions, with `repo`), a repository config, or the { host, ci } pair.
export function checksState(target, repo, pr, { ignore = ['review-quorum'], workflows = headWorkflows, ciSettings = {}, head = null, activities = null } = {}) {
  const t = ciTarget(target, repo);
  const s = checksSummary(t.host, pr, { ignore });
  if (s.state === 'unknown') return null;
  // No check reported yet; only skipped checks: the head's pipelines have not run yet, which is not a pass (council C12).
  if (s.state === 'none' && !s.names?.length) return null;
  if (s.state === 'failure') return 'failure';
  const state = s.state === 'none' ? 'pending' : s.state;
  const number = String(pr).match(/(\d+)\/?$/)?.[1] ?? String(pr);
  const both = combine(state, workflows(t, repo, number, { settings: ciSettings, head, activities }));
  return both === 'unknown' || both === 'none' ? null : both;
}

const LABEL_COLORS = { 'needs-human': 'b60205', 'auto-merged': '0e8a16', reopened: 'd93f0b' };
export const labelColor = (name) => LABEL_COLORS[name] ?? (name.startsWith('approvals:') ? 'fbca04' : 'ededed');
// A label on the repository (some hosts need it before it is added; others create it on use).
export function ensureLabel(target, repo, name, description = '') {
  asHost(target, repo).repo.ensureLabel(name, { color: labelColor(name), description: description || 'Set by the review gate' });
}

export function editPrLabels(target, repo, pr, { add = [], remove = [] }) {
  const host = asHost(target, repo);
  for (const l of add) ensureLabel(host, repo, l);
  if (!add.length && !remove.length) return;
  host.pr.update(pr, { labels: { add, remove } });
}

// Requests reviews; a login the host refuses (not a collaborator) is skipped, not fatal. Returns the
// logins requested.
export const requestReviewers = (target, repo, pr, logins) => asHost(target, repo).pr.requestReviewers(pr, logins);

// The PR comment carrying `marker`, or null: { id, body, url }.
export function findComment(target, repo, pr, marker) {
  const c = asHost(target, repo).pr.comments(pr).filter((x) => String(x.body ?? '').includes(marker)).at(-1);
  return c ? { id: c.id, body: c.body, url: c.url ?? null } : null;
}

// Adds or edits (in place) the PR comment that carries `marker`. Returns its URL.
export const upsertComment = (target, repo, pr, marker, body) => asHost(target, repo).pr.comment(pr, body, { marker })?.url ?? null;

export const prReviews = (target, repo, pr) => asHost(target, repo).pr.reviews(pr).map(toReview);
export const prReviewComments = (target, repo, pr) => asHost(target, repo).pr.reviewComments(pr).map(toReviewComment);
export const prCommits = (target, repo, pr) => asHost(target, repo).pr.commits(pr).map(toCommit);

// ---------------------------------------------------------------------------------------------
// Merging: the one function every merge goes through
// ---------------------------------------------------------------------------------------------

// Who merges (implement.autoMerge.identity):
//   gh-user  the gh CLI's logged-in user (today; works while main requires no approvals from people)
//   app      a GitHub App with a ruleset bypass, once approvals are required: its installation token
//            in the environment variable `appTokenEnv` (REVIEW_GATE_APP_TOKEN) becomes GH_TOKEN
//   bot      the pipeline's PR bot (dev-bot-<login>, scripts/pipeline/lib/bot.mjs): `bot()` returns
//            its { GH_TOKEN }, or null when it is not set up (then the merge is refused)
export function mergeIdentity(settings, env = process.env, { bot } = {}) {
  const identity = settings?.identity ?? 'gh-user';
  if (identity === 'gh-user') return { identity, env: undefined };
  if (identity === 'app') {
    const name = settings.appTokenEnv ?? 'REVIEW_GATE_APP_TOKEN';
    if (!env[name]) throw new Error(`implement.autoMerge.identity is "app" but ${name} is not set (the GitHub App's installation token)`);
    return { identity, env: { ...env, GH_TOKEN: env[name] }, token: env[name] };
  }
  if (identity === 'bot') {
    const b = bot?.();
    const token = b?.GH_TOKEN ?? b?.token;
    if (!token) throw new Error('implement.autoMerge.identity is "bot" but the pipeline\'s PR bot has no token (run `node scripts/pipeline/pipeline.mjs bot status`)');
    return { identity, env: { ...env, GH_TOKEN: token }, token };
  }
  throw new Error(`implement.autoMerge.identity must be "gh-user", "app" or "bot", not "${identity}"`);
}

// Merges a PR the gate cleared. It merges at once when the host says nothing is pending; when something is
// (checks restarted after the base moved, mergeability still being computed) it hands the merge to the host's
// auto-merge where the repository allows it and `implement.autoMerge.native` is on, and otherwise reports it pending
// so `board sync` tries again. It never turns a refusal into a review requirement: a refusal throws with the host's
// reason (dogfood C6: #78 and #79 qualified, `--auto` was refused because "Allow auto-merge" was off, and the gate
// asked for approvals). Returns { identity, method, merged, mergedAt, autoMerge, pending, status }.
// `headSha`: the head the gate assessed; the merge is refused if the branch moved since (council C9). A host that
// cannot bind a merge to a SHA (capability mergeHeadGuard) is asked for the head right before the merge, and the merge
// is refused if it moved; such a host never gets auto-merge. The host's own auto-merge is used only with
// `implement.autoMerge.native: true`: once armed it merges a later head as soon as the required checks pass, without
// the gate's CI evidence for that head (council C9). By default a PR the host has not cleared yet waits, and
// `board sync` merges it once the host does, after the gate has checked that head again.
// `target`: a gh runner (with `repo`), or `config` to merge through its code host.
const READY = ['clean', 'has_hooks', 'unstable'];
export function mergePr(target, repo, pr, settings, { bot, allowAuto = null, waitMs, headSha = null, gh = realGh } = {}) {
  const { identity, env, token } = mergeIdentity(settings, process.env, { bot });
  const host = typeof target === 'function' ? hostOf((args, o = {}) => target(args, { ...o, env: o.env ?? env }), { repo }) : token ? prHost(target, gh, { token }) : prHost(target, gh);
  const caps = host.capabilities ?? {};
  const method = settings?.method ?? 'squash';
  const before = host.pr.mergeState(pr, waitMs == null ? {} : { waitMs });
  const status = before.raw ?? String(before.mergeState ?? 'unknown').toUpperCase();
  if (before.state === 'merged') return { identity, method, merged: true, mergedAt: before.mergedAt ?? null, autoMerge: false, pending: false, status: 'MERGED' };
  if (before.mergeState === 'dirty') throw new Error(`the PR conflicts with its base branch (${host.label ?? 'the host'}: ${status}); board sync merges the base in when it can, else a person resolves the conflict`);
  // Without a merge bound to the SHA, the head is read right before the merge (fail closed when it moved).
  if (headSha && caps.mergeHeadGuard === false) {
    const now = host.pr.get(pr)?.headSha ?? null;
    if (now !== headSha) throw new Error(`the PR's head moved from ${String(headSha).slice(0, 7)} to ${String(now ?? '?').slice(0, 7)} since the gate assessed it; not merged (the gate assesses the new head first)`);
  }
  let how;
  if (READY.includes(before.mergeState)) how = host.pr.merge(pr, { method, headSha });
  else {
    const hostAuto = caps.autoMerge !== false && caps.mergeHeadGuard !== false && caps.cancelAutoMerge !== false;
    const auto = hostAuto && (allowAuto ?? (settings?.native === true && host.repo.settings?.()?.autoMergeAllowed === true));
    if (!auto) return { identity, method, merged: false, mergedAt: null, autoMerge: false, pending: true, status };
    how = host.pr.merge(pr, { method, headSha, auto: true });
  }
  return { identity, method, merged: Boolean(how?.merged), mergedAt: how?.mergedAt ?? null, autoMerge: !how?.merged && !READY.includes(before.mergeState), pending: false, status };
}

// Whether the host's auto-merge is armed on the PR (null when it cannot be read or the host has none).
export const autoMergeArmed = (target, repo, pr) => asHost(target, repo).pr.autoMergeArmed?.(pr) ?? null;
export const disableAutoMerge = (target, repo, pr) => asHost(target, repo).pr.cancelAutoMerge(pr);
