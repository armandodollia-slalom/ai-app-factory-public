// The GitHub code host: the `gh` CLI, exactly as the factory called it before the adapters (gh owns
// authentication; GH_TOKEN in the environment selects another identity, such as the PR bot's
// installation token). Every method exists in a synchronous form (`host.sync`), because gh is a
// synchronous process, and in the async form of the contract.
//
// deps: { gh(args, { input, env, cwd }) -> { status, stdout, stderr } | run(cmd, args, opts) (tests
// inject either), env (the full environment to run gh with), token (an identity override: GH_TOKEN),
// cwd }.
import { run as runCmd } from '../util.mjs';
import { HostAuthError, HostError, HostRefusedError } from './errors.mjs';
import { httpStatusIn, isContentRefusal } from './refusal.mjs';
import { API, ghLogin, loadCredentials } from '../bot.mjs';
import { DEFAULT_URLS, defaultMergeMethod } from '../products.mjs';

export const DEFAULT_URL = DEFAULT_URLS['github'];

// The gh CLI runner of the GitHub host (args, { input, env, cwd }) -> { status, stdout, stderr }. Other
// GitHub-only code (the review gate's runner, doctor's checks) takes it from here.
export const ghCli = (args, { input, env, cwd } = {}) => runCmd('gh', args, { input, env, cwd, timeoutSec: 120 });
// Whether the gh CLI is installed, and signed in.
let installed;
export const ghInstalled = () => (installed ??= ghCli(['--version']).status === 0);
export const ghSignedIn = () => ghCli(['auth', 'status']).status === 0;

// gh pr view fields the normalised PR is built from.
export const PR_FIELDS = 'number,url,title,body,state,isDraft,headRefName,baseRefName,headRefOid,author,labels,mergeable,createdAt,updatedAt,mergedAt,closedAt,mergeCommit,additions,deletions,changedFiles,isCrossRepository';
const LIST_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,author,labels,createdAt,updatedAt';

export const prNumberOf = (pr) => Number(/\/pull\/(\d+)/.exec(String(pr))?.[1] ?? String(pr).replace(/^#/, '')) || null;
const commentIdOf = (url) => Number(/issuecomment-(\d+)/.exec(url ?? '')?.[1] ?? 0) || null;
const lower = (s) => (s == null ? null : String(s).toLowerCase());

// gh pr view / list JSON -> the contract's normalised PR (plus mergedAt, closedAt, mergeCommit,
// additions, deletions, changedFiles, fromFork when gh returned them).
export function normalizePr(p) {
  if (!p) return null;
  const state = lower(p.state);
  return {
    number: p.number ?? prNumberOf(p.url),
    url: p.url ?? null,
    title: p.title ?? '',
    body: p.body ?? '',
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
    draft: Boolean(p.isDraft),
    head: p.headRefName ?? null,
    base: p.baseRefName ?? null,
    headSha: p.headRefOid ?? null,
    author: p.author?.login ?? p.author ?? null,
    labels: (p.labels ?? []).map((l) => l?.name ?? l),
    mergeable: p.mergeable === 'MERGEABLE' ? true : p.mergeable === 'CONFLICTING' ? false : null,
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
    mergedAt: p.mergedAt ?? null,
    closedAt: p.closedAt ?? null,
    mergeCommit: p.mergeCommit?.oid ?? null,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    changedFiles: p.changedFiles ?? null,
    fromFork: Boolean(p.isCrossRepository),
  };
}

// gh pr checks bucket -> { status, conclusion }.
const BUCKET = { pass: ['completed', 'success'], fail: ['completed', 'failure'], cancel: ['completed', 'cancelled'], skipping: ['completed', 'skipped'], pending: ['pending', null] };
export function normalizeCheck(c) {
  const b = lower(c.bucket ?? c.state) ?? '';
  const [status, conclusion] = BUCKET[b] ?? (['failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes(b) ? ['completed', b === 'cancelled' ? 'cancelled' : 'failure'] : ['success', 'neutral', 'skipped'].includes(b) ? ['completed', b] : ['pending', null]);
  return { name: c.name ?? c.context ?? null, status, conclusion, url: c.link ?? c.detailsUrl ?? null };
}

const REVIEW_STATE = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending' };
export const normalizeReview = (r) => ({ id: r.id ?? null, author: r.user?.login ?? r.author?.login ?? null, bot: r.user?.type === 'Bot', state: REVIEW_STATE[r.state] ?? lower(r.state), submittedAt: r.submitted_at ?? r.submittedAt ?? null, commit: r.commit_id ?? null, body: r.body ?? '' });

const STATUS_STATE = { success: 'success', failure: 'failure', pending: 'pending', error: 'error' };

// The review gate's ruleset (`factory review-gate enforce`): the `review-quorum` status check is required
// from GitHub Actions, so a pull request whose `approvals:N` label is not met cannot merge; with CODEOWNERS,
// a pull request and code-owner review are required (no general approval count: the gate sets it per pull
// request); repository admins may bypass, so the owner can still repair the branch.
export const RULESET_NAME = (branch) => `${branch}: review-quorum`;
const ACTIONS_APP_ID = 15368; // GitHub Actions: the check must come from the workflow, not any status poster.
const ADMIN_ROLE_ID = 5;

// requiredChecks: the CI checks required next to review-quorum (council C9: with review-quorum alone, GitHub merged a
// head whose CI had not run; required checks are the hard guard under the gate's own evidence).
export function desiredRuleset(branch, { codeOwners, requiredChecks = [] }) {
  const contexts = ['review-quorum', ...requiredChecks.filter((c) => c !== 'review-quorum')];
  const rules = [
    { type: 'required_status_checks', parameters: { do_not_enforce_on_create: true, strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context, integration_id: ACTIONS_APP_ID })) } },
  ];
  if (codeOwners) {
    rules.push({ type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true, dismiss_stale_reviews_on_push: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['merge', 'squash', 'rebase'] } });
  }
  return {
    name: RULESET_NAME(branch),
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules,
  };
}

// The parts of a ruleset enforceReviewGate sets, in a stable form, to compare what GitHub has with what is
// wanted. GitHub adds parameters of its own (required_reviewers, ...): only the ones `want` sets are compared.
function normalizeRuleset(r, want) {
  const keys = Object.fromEntries((want.rules ?? []).map((x) => [x.type, Object.keys(x.parameters ?? {}).filter((k) => k !== 'allowed_merge_methods')]));
  const rules = (r?.rules ?? []).map((x) => ({ type: x.type, parameters: Object.fromEntries((keys[x.type] ?? Object.keys(x.parameters ?? {})).sort().map((k) => [k, x.parameters?.[k]])) })).sort((a, b) => a.type.localeCompare(b.type));
  return { name: r?.name, enforcement: r?.enforcement, include: r?.conditions?.ref_name?.include ?? [], bypass: (r?.bypass_actors ?? []).map((b) => `${b.actor_type}:${b.actor_id}:${b.bypass_mode}`).sort(), rules };
}

// What GitHub can do for the harness (providers/contracts.mjs CAPABILITIES.host). Rulesets need a public repository
// or a paid plan (branchProtection says `unavailable: plan`); videos go to the storage branch (gh has no upload).
export const CAPABILITIES = { requiredChecks: true, codeOwners: true, autoMerge: true, mergeHeadGuard: true, cancelAutoMerge: true, drafts: true, labels: true, checkAnnotations: true, commitStatus: true, attachments: false, botIdentity: true, diff: true, reviewCommentThreads: true, stateEvents: true };

export function createGithubHost(settings, deps = {}) {
  const repo = settings.repo ?? null;
  const url = (settings.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const hostname = new URL(url).hostname;
  const enterprise = hostname !== 'github.com';
  const cwd = deps.cwd ?? settings.root ?? undefined;
  const token = deps.token ?? settings.resolveToken?.() ?? null;
  const env = token || enterprise ? { ...(deps.env ?? process.env), ...(token ? { GH_TOKEN: token } : {}), ...(enterprise ? { GH_HOST: hostname } : {}) } : deps.env;
  const runner = deps.gh ?? ((args, o = {}) => (deps.run ?? runCmd)('gh', args, { cwd: o.cwd ?? cwd, input: o.input, env: o.env, timeoutSec: 120 }));
  const gh = (args, o = {}) => runner(args, { env, cwd, ...o });
  const R = repo ? ['-R', enterprise ? `${hostname}/${repo}` : repo] : [];
  const need = () => {
    if (!repo) throw new HostError('the GitHub repository is unknown: set host.repo ("owner/name") in .factory/config.json or add a GitHub origin remote', { code: 'config' });
    return repo;
  };
  const fail = (args, r) => {
    const text = String(r.stderr ?? '').trim().slice(0, 400);
    // The external-call policy's cause (a timeout after its retries) says it best.
    const msg = r.cause && (!text || /timed out/.test(String(r.cause))) ? String(r.cause) : `gh ${args.slice(0, 3).join(' ')} failed: ${text}`;
    // The HTTP status the CLI reports, when it reports one (structured from here on; the exit code is not a status).
    const http = httpStatusIn(text);
    if (/HTTP 401|authentication|gh auth login/i.test(text) || http === 401) return new HostAuthError(msg, { status: 401 });
    // A content filter on a call that sends text (a PR, an issue, a comment, an edit): a bare 403 with no reason, or a
    // message naming spam or content (hosts/refusal.mjs). A read's 403 stays a permission error.
    if (/^(pr|issue) (create|comment|edit)$|^api$/.test(args.slice(0, 2).join(' ').replace(/^api .*/, 'api')) && (args[0] !== 'api' || args.some((a) => /^(POST|PATCH|PUT)$/.test(a))) && isContentRefusal({ status: http, text })) return new HostRefusedError(msg, { status: http ?? 403 });
    if (/already exists/i.test(text)) return new HostError(msg, { status: r.status, code: 'exists' });
    if (/HTTP 404|not found|no pull requests? found|could not resolve/i.test(text)) return new HostError(msg, { status: 404, code: 'not-found' });
    if (http === 429 || /rate.?limit/i.test(text)) return new HostError(msg, { status: http ?? 429, code: 'rate-limit' });
    return new HostError(msg, { status: http ?? r.status, code: 'cli' });
  };
  const ok = (args, o) => {
    const r = gh(args, o);
    if (r.status !== 0) throw fail(args, r);
    return String(r.stdout ?? '');
  };
  const json = (args, o) => {
    const out = ok(args, o).trim();
    return out ? JSON.parse(out) : null;
  };
  // `gh api --paginate --jq '.[]'`: one JSON value per line.
  const lines = (args) => ok([...args, '--paginate', '--jq', '.[]']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  // Every page, strictly (`gh api --paginate --slurp`: a list of pages): an answer that is not a list of lists, or a row
  // without the fields `row` checks, throws (never a short or flattened list read as the whole history).
  const pages = (args, row, what) => {
    let all;
    try {
      all = JSON.parse(ok([...args, '--paginate', '--slurp']).trim() || 'null');
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError(`GitHub: the ${what} could not be read (not JSON)`, { code: 'incomplete' });
    }
    if (!Array.isArray(all) || !all.every(Array.isArray)) throw new HostError(`GitHub: the ${what} came back incomplete (not a list of pages)`, { code: 'incomplete' });
    const flat = all.flat();
    if (!flat.every((r) => r && typeof r === 'object' && !Array.isArray(r) && row(r))) throw new HostError(`GitHub: the ${what} came back incomplete (a row without its fields)`, { code: 'incomplete' });
    return flat;
  };
  const isId = (v) => Number.isInteger(v) || (typeof v === 'string' && v.length > 0);
  const num = (pr) => prNumberOf(pr);

  let settingsMemo = null;
  // Every page of the PR's comments (`gh pr view --json comments` stops at the first 100).
  const comments = (pr) =>
    pages(['api', `repos/${need()}/issues/${num(pr)}/comments`], (c) => isId(c.id) && typeof (c.body ?? '') === 'string', 'comments of the PR').map((c) => ({ id: Number(c.id) || commentIdOf(c.html_url), author: c.user?.login ?? null, body: c.body ?? '', createdAt: c.created_at ?? null, url: c.html_url ?? null }));

  const sync = {
    type: 'github',
    label: 'GitHub',
    capabilities: CAPABILITIES,
    // Where GitHub keeps what the gate needs (doctor's and `review-gate enforce`'s wording).
    // gh owns authentication: doctor checks it is signed in.
    cliAuth: { name: 'gh, signed in', check: () => ghSignedIn(), note: 'needed for the board and for opening PRs' },
    hints: {
      codeOwnersFile: '.github/CODEOWNERS',
      checked: 'rulesets and branch protection',
      enforce: 'one ruleset on the default branch',
      settings: 'Settings → Rules',
      planDecision: 'make the repository public, upgrade the plan, or accept advisory review',
      autoMerge: (r) => `Settings → General → Pull Requests → "Allow auto-merge", or run: gh api -X PATCH repos/${r} -F allow_auto_merge=true`,
    },
    webUrl: repo ? `${url}/${repo}` : url,
    // The gh runner of this host (its identity and GitHub Enterprise host), for the GitHub-only paths of the gate.
    gh: (args, o = {}) => gh(args, o),
    identity() {
      const u = json(['api', 'user']);
      return { login: u?.login ?? null, id: u?.id ?? null };
    },
    pr: {
      open({ head, base, title, body = '', draft = false, labels = [], reviewers = [] }) {
        const args = ['pr', 'create', ...(base ? ['--base', base] : []), '--head', head, '--title', title, '--body', body, ...(draft ? ['--draft'] : []), ...labels.flatMap((l) => ['--label', l]), ...reviewers.flatMap((l) => ['--reviewer', l]), ...R];
        const out = ok(args).trim();
        const prUrl = out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).at(-1) ?? out;
        return { number: num(prUrl), url: prUrl, title, body, state: 'open', draft: Boolean(draft), head, base: base ?? null, headSha: null, author: null, labels: [...labels], mergeable: null, createdAt: null, updatedAt: null };
      },
      get(numberOrBranch) {
        const r = gh(['pr', 'view', String(numberOrBranch), ...R, '--json', PR_FIELDS]);
        if (r.status !== 0) {
          const e = fail(['pr', 'view', String(numberOrBranch)], r);
          if (e.code === 'not-found') return null;
          throw e;
        }
        return normalizePr(JSON.parse(String(r.stdout).trim() || 'null'));
      },
      // `withMergeState`: each PR's merge state too (clean, dirty, unknown, ...), in the same call.
      // `search`: PRs whose title holds the text as a phrase (`"<key>" in:title`, quoted as the tracker's search is, so a
      // key is not split into words).
      list({ state = 'open', head, base, label, search, limit = 200, withMergeState = false } = {}) {
        const args = ['pr', 'list', ...R, ...(head ? ['--head', head] : []), ...(base ? ['--base', base] : []), ...(label ? ['--label', label] : []), ...(search ? ['--search', `"${String(search).replace(/"/g, '')}" in:title`] : []), '--state', state, '--limit', String(limit), '--json', withMergeState ? `${LIST_FIELDS},mergeStateStatus` : LIST_FIELDS];
        return (json(args) ?? []).map((p) => (withMergeState ? { ...normalizePr(p), mergeState: lower(p.mergeStateStatus) ?? 'unknown' } : normalizePr(p)));
      },
      update(pr, { title, body, labels, state, draft } = {}) {
        let add = [];
        let remove = [];
        if (Array.isArray(labels)) {
          const current = sync.pr.get(pr)?.labels ?? [];
          add = labels.filter((l) => !current.includes(l));
          remove = current.filter((l) => !labels.includes(l));
        } else if (labels) {
          add = labels.add ?? [];
          remove = labels.remove ?? [];
        }
        const edit = [...(title != null ? ['--title', title] : []), ...(body != null ? ['--body-file', '-'] : []), ...(add.length ? ['--add-label', add.join(',')] : []), ...(remove.length ? ['--remove-label', remove.join(',')] : [])];
        if (edit.length) ok(['pr', 'edit', String(pr), ...R, ...edit], body != null ? { input: body } : {});
        if (state === 'closed') ok(['pr', 'close', String(pr), ...R]);
        if (state === 'open') ok(['pr', 'reopen', String(pr), ...R]);
        if (draft === true) ok(['pr', 'ready', String(pr), ...R, '--undo']);
        if (draft === false) ok(['pr', 'ready', String(pr), ...R]);
      },
      comment(pr, body, { marker } = {}) {
        const existing = marker ? comments(pr).filter((c) => c.body.includes(marker)).at(-1) : null;
        if (existing?.id) {
          ok(['api', '-X', 'PATCH', `repos/${need()}/issues/comments/${existing.id}`, '--input', '-'], { input: JSON.stringify({ body }) });
          return { id: existing.id, url: existing.url };
        }
        const out = ok(['pr', 'comment', String(pr), ...R, '--body-file', '-'], { input: body }).trim();
        return { id: commentIdOf(out), url: out || null };
      },
      comments,
      // `strict` (the review gate's rejection check): every page, each review with its id, state and login, and a dismissed
      // review with the state it had (the timeline's dismissal event), or none when that cannot be told.
      reviews: (pr, { strict = false } = {}) => {
        if (!strict) return lines(['api', `repos/${need()}/pulls/${num(pr)}/reviews`]).map(normalizeReview);
        const all = pages(['api', `repos/${need()}/pulls/${num(pr)}/reviews`], (r) => isId(r.id) && typeof r.state === 'string' && typeof r.user?.login === 'string', 'reviews of the PR').map(normalizeReview);
        if (!all.some((r) => r.state === 'dismissed')) return all;
        const was = new Map();
        for (const e of pages(['api', `repos/${need()}/issues/${num(pr)}/timeline`], (e) => typeof e.event === 'string', 'timeline of the PR')) {
          if (e.event === 'review_dismissed' && e.dismissed_review?.review_id != null) was.set(String(e.dismissed_review.review_id), REVIEW_STATE[String(e.dismissed_review.state ?? '').toUpperCase()] ?? lower(e.dismissed_review.state) ?? null);
        }
        return all.map((r) => (r.state === 'dismissed' ? { ...r, dismissedState: was.get(String(r.id)) ?? null } : r));
      },
      // Every page, strictly (the review gate's rejection check reads them).
      stateEvents: (pr) => pages(['api', `repos/${need()}/issues/${num(pr)}/events`], (e) => isId(e.id) && typeof e.event === 'string', 'events of the PR').filter((e) => ['closed', 'reopened', 'merged'].includes(e.event)).map((e) => ({ id: e.id ?? null, type: e.event, at: e.created_at ?? null, actor: e.actor?.login ?? null, commit: e.commit_id ?? null })),
      reviewComments: (pr) => lines(['api', `repos/${need()}/pulls/${num(pr)}/comments`]).map((c) => ({ id: c.id ?? null, author: c.user?.login ?? null, body: c.body ?? '', path: c.path ?? null, line: c.line ?? c.original_line ?? null, reviewId: c.pull_request_review_id ?? null, createdAt: c.created_at ?? null })),
      commits: (pr) => lines(['api', `repos/${need()}/pulls/${num(pr)}/commits`]).map((c) => ({ sha: c.sha ?? null, author: c.author?.login ?? c.commit?.author?.name ?? null, committedAt: c.commit?.committer?.date ?? c.commit?.author?.date ?? c.committedDate ?? null, parents: c.parents?.length ?? null, message: c.commit?.message ?? null })),
      requestReviewers(pr, logins = []) {
        const done = [];
        for (const l of logins) if (gh(['pr', 'edit', String(pr), ...R, '--add-reviewer', l]).status === 0) done.push(l);
        return done;
      },
      files: (pr) => (json(['pr', 'view', String(pr), ...R, '--json', 'files'])?.files ?? []).map((f) => ({ path: f.path, status: { ADDED: 'added', DELETED: 'removed', RENAMED: 'renamed', COPIED: 'added' }[f.changeType] ?? 'modified', additions: f.additions ?? null, deletions: f.deletions ?? null })),
      diff: (pr) => ok(['pr', 'diff', String(pr), ...R]),
      checks(pr) {
        // gh exits 8 while checks are pending, with the JSON on stdout.
        const r = gh(['pr', 'checks', String(pr), ...R, '--json', 'name,state,bucket,link']);
        const out = String(r.stdout ?? '').trim();
        if (!out) {
          if (r.status === 0 || /no checks reported/i.test(String(r.stderr ?? ''))) return [];
          throw fail(['pr', 'checks', String(pr)], r);
        }
        const list = JSON.parse(out);
        return Array.isArray(list) ? list.map(normalizeCheck) : [];
      },
      setStatus(sha, { name, state, description = '', url: target } = {}) {
        ok(['api', '-X', 'POST', `repos/${need()}/statuses/${sha}`, '--input', '-'], { input: JSON.stringify({ state: STATUS_STATE[state] ?? 'error', context: name, description: String(description).slice(0, 140), ...(target ? { target_url: target } : {}) }) });
      },
      // GitHub's merge state of a PR. UNKNOWN (GitHub is still computing it, e.g. right after the base moved) is asked
      // again a few times. { state, mergeState (lower case), raw (GitHub's mergeStateStatus), mergedAt }.
      mergeState(pr, { tries = 5, waitMs = 3000 } = {}) {
        let view = null;
        for (let i = 0; i < tries; i++) {
          view = json(['pr', 'view', String(pr), ...R, '--json', 'state,mergeStateStatus,mergedAt']);
          if (view?.state !== 'OPEN' || view?.mergeStateStatus !== 'UNKNOWN') break;
          if (waitMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
        }
        const st = lower(view?.state);
        return { state: st === 'merged' ? 'merged' : st === 'closed' ? 'closed' : 'open', mergeState: lower(view?.mergeStateStatus) ?? 'unknown', raw: view?.mergeStateStatus ?? 'UNKNOWN', mergedAt: view?.mergedAt ?? null };
      },
      // Merges now, or (auto) hands the merge to GitHub's auto-merge. `headSha`: GitHub refuses the merge if the branch
      // moved since the gate assessed that head (council C9). Returns { merged, mergedAt, autoMerge }.
      merge(pr, { method = defaultMergeMethod(), auto = false, headSha = null, deleteBranch = false } = {}) {
        ok(['pr', 'merge', String(pr), ...R, ...(auto ? ['--auto'] : []), `--${method}`, ...(headSha ? ['--match-head-commit', headSha] : []), ...(deleteBranch ? ['--delete-branch'] : [])]);
        let view = null;
        try {
          view = json(['pr', 'view', String(pr), ...R, '--json', 'state,mergedAt']);
        } catch {
          /* unreadable: not reported as merged */
        }
        const merged = view?.state === 'MERGED';
        return { merged, mergedAt: view?.mergedAt ?? null, autoMerge: Boolean(auto) && !merged };
      },
      cancelAutoMerge: (pr) => gh(['pr', 'merge', String(pr), ...R, '--disable-auto']).status === 0,
      // Whether GitHub's auto-merge is armed on the PR (null when it cannot be read).
      autoMergeArmed(pr) {
        const r = gh(['pr', 'view', String(pr), ...R, '--json', 'autoMergeRequest']);
        if (r.status !== 0) return null;
        try {
          return Boolean(JSON.parse(String(r.stdout || '{}')).autoMergeRequest);
        } catch {
          return null;
        }
      },
      close(pr, { comment = null } = {}) {
        if (comment) gh(['pr', 'comment', String(pr), ...R, '--body', comment]);
        return gh(['pr', 'close', String(pr), ...R]).status === 0;
      },
    },
  };
  // Issues on the host repository (the retro files factory issues where the factory lives).
  sync.issues = {
    search({ text, state = 'open', repo: r = null } = {}) {
      const target = r ? ['-R', r] : R;
      return (json(['issue', 'list', ...target, '--state', state, '--search', `"${String(text).replace(/"/g, '')}" in:title`, '--json', 'number,title,url']) ?? []).map((i) => ({ number: i.number ?? null, title: i.title ?? '', url: i.url ?? null }));
    },
    create({ title, body = '', labels = [], repo: r = null } = {}) {
      const target = r ? ['-R', r] : R;
      const out = ok(['issue', 'create', ...target, '--title', title, '--body', body, ...labels.flatMap((l) => ['--label', l])]).trim();
      return { number: Number(/\/issues\/(\d+)/.exec(out)?.[1]) || null, url: out.split('\n').pop() || null };
    },
  };
  // host.repo: the repository's methods; its `slug` (and String(host.repo)) is "owner/name".
  sync.repo = {
    slug: repo,
    toString: () => repo ?? '',
    toJSON: () => repo,
    defaultBranch: () => ok(['api', `repos/${need()}`, '--jq', '.default_branch']).trim() || null,
    // Repository settings the gate reports: { autoMergeAllowed: bool | null }. Asked once per host (one board sync), so a
    // change of the setting is seen at the next run.
    settings() {
      if (settingsMemo) return settingsMemo;
      let allowed = null;
      try {
        const r = gh(['api', `repos/${need()}`, '--jq', '.allow_auto_merge']);
        const out = String(r.stdout ?? '').trim();
        if (r.status === 0 || r.status == null) allowed = out === 'true' ? true : out === 'false' ? false : null;
      } catch {
        /* unknown: null */
      }
      settingsMemo = { autoMergeAllowed: allowed };
      return settingsMemo;
    },
    // The files of a folder at a ref (null when the folder does not exist).
    list(dir, ref) {
      const r = gh(['api', `repos/${need()}/contents/${dir}${ref ? `?ref=${ref}` : ''}`, '--jq', '.[] | select(.type == "file") | .path']);
      if (r.status !== 0) {
        if (/HTTP 404/.test(String(r.stderr))) return null;
        throw fail(['api', 'contents', dir], r);
      }
      return String(r.stdout).split('\n').filter(Boolean);
    },
    file(path, ref) {
      const r = gh(['api', `repos/${need()}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, '-H', 'Accept: application/vnd.github.raw']);
      if (r.status !== 0) {
        const e = fail(['api', 'contents', path], r);
        if (e.code === 'not-found') return null;
        throw e;
      }
      return String(r.stdout ?? '');
    },
    // What the signed-in identity may do here: { push, pullRequests, readPolicies, admin } from the
    // repository's `permissions`.
    permissions() {
      const p = json(['api', `repos/${need()}`, '--jq', '.permissions']) ?? {};
      return { push: Boolean(p.push), pullRequests: Boolean(p.push || p.triage), readPolicies: Boolean(p.admin || p.maintain), admin: Boolean(p.admin) };
    },
    // The rules that apply to the branch (rulesets and classic protection): { enforced, requiredChecks,
    // requiredApprovals, codeOwnerReview } | { enforced: false, unavailable: true, reason } when GitHub
    // cannot apply rules to this repository (a private repository on a free plan) | null when it cannot
    // be asked.
    // Rulesets (repository and organisation rules that apply to the branch) and classic branch protection:
    // either may require the check and the code-owner review. `via` names what was found.
    branchProtection(branch) {
      const b = branch ?? sync.repo.defaultBranch();
      const rules = gh(['api', `repos/${need()}/rules/branches/${b}`]);
      const classic = gh(['api', `repos/${need()}/branches/${b}/protection`]);
      const text = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const planLimited = (r) => r.status !== 0 && /Upgrade to GitHub Pro|make this repository public|HTTP 403/.test(text(r));
      const none = { enforced: false, unavailable: true, branch: b, requiredChecks: [], requiredApprovals: 0, codeOwnerReview: false, via: [] };
      if (planLimited(rules) && planLimited(classic)) return { ...none, reason: 'plan', detail: 'branch rules need a public repository or a paid plan' };
      if (rules.status !== 0 && classic.status !== 0 && !/Branch not protected|HTTP 404/.test(text(classic))) return { ...none, reason: text(rules).trim().split('\n')[0] };
      const json = (r, fallback) => {
        if (r.status !== 0) return fallback;
        try {
          return JSON.parse(r.stdout) ?? fallback;
        } catch {
          return fallback; // not JSON: no rules
        }
      };
      const list = json(rules, []);
      const prot = json(classic, {});
      const requiredChecks = [
        ...list.filter((x) => x.type === 'required_status_checks').flatMap((x) => x.parameters?.required_status_checks ?? []).map((c) => c.context),
        ...(prot.required_status_checks?.contexts ?? []),
        ...(prot.required_status_checks?.checks ?? []).map((c) => c.context),
      ];
      const prRules = list.filter((x) => x.type === 'pull_request');
      const via = [list.length > 0 && 'a ruleset', classic.status === 0 && 'branch protection'].filter(Boolean);
      return {
        enforced: via.length > 0,
        branch: b,
        requiredChecks: [...new Set(requiredChecks)],
        requiredApprovals: Math.max(0, ...prRules.map((x) => x.parameters?.required_approving_review_count ?? 0), prot.required_pull_request_reviews?.required_approving_review_count ?? 0),
        codeOwnerReview: prRules.some((x) => x.parameters?.require_code_owner_review) || Boolean(prot.required_pull_request_reviews?.require_code_owner_reviews),
        via,
      };
    },
    // `factory review-gate enforce`: one ruleset on the default branch, created or updated in place by name
    // (desiredRuleset). A private repository on a plan without rulesets is refused (exitCode 3), unchanged.
    // -> { action: created|updated|unchanged|would-create|would-update, ruleset, summary, manual: [] }
    // review: { satisfiable, reason } of code-owner review (codeowners.mjs): an unsatisfiable rule is left out, with a warning.
    enforceReviewGate({ codeOwners = false, dryRun = false, review = { satisfiable: true }, requiredChecks = [] } = {}) {
      const info = json(['api', `repos/${need()}`]) ?? {};
      if (info.private && info.visibility !== 'internal') {
        const plan = gh(['api', `repos/${need()}/rulesets`]);
        if (plan.status !== 0 && /Upgrade to GitHub Pro|make this repository public|HTTP 403/.test(`${plan.stdout}${plan.stderr}`)) {
          throw Object.assign(new HostError(`${need()} is private on a plan without rulesets: GitHub cannot require review-quorum or code-owner review there (owner decision: make it public or upgrade the plan). Nothing changed.`, { code: 'plan' }), { exitCode: 3 });
        }
      }
      const warnings = codeOwners && !review.satisfiable ? [`code-owner review is not required: ${review.reason}`] : [];
      const owners = codeOwners && review.satisfiable !== false;
      const want = desiredRuleset(info.default_branch, { codeOwners: owners, requiredChecks });
      const summary = (action) => `ruleset "${want.name}" ${action} (requires review-quorum${requiredChecks.length ? `, the CI checks ${requiredChecks.join(', ')}` : ''}${owners ? ' and code-owner review' : ''}; admins may bypass)`;
      const done = (action, ruleset) => ({ action, ruleset, summary: summary(action), manual: [], warnings });
      const existing = (json(['api', `repos/${need()}/rulesets`]) ?? []).find((r) => r.name === want.name);
      if (existing) {
        const current = json(['api', `repos/${need()}/rulesets/${existing.id}`]);
        if (JSON.stringify(normalizeRuleset(current, want)) === JSON.stringify(normalizeRuleset(want, want))) return done('unchanged', current);
        if (dryRun) return done('would-update', want);
        return done('updated', json(['api', '-X', 'PUT', `repos/${need()}/rulesets/${existing.id}`, '--input', '-'], { input: JSON.stringify(want) }));
      }
      if (dryRun) return done('would-create', want);
      return done('created', json(['api', '-X', 'POST', `repos/${need()}/rulesets`, '--input', '-'], { input: JSON.stringify(want) }));
    },
    ensureLabel(name, { color = 'ededed', description = '' } = {}) {
      gh(['label', 'create', name, ...R, '--color', String(color).replace(/^#/, ''), '--description', description || 'Set by the factory', '--force']);
    },
  };
  return sync;
}

// A CI runner without the gh CLI reads and comments on pull requests through the REST API with GITHUB_TOKEN or GH_TOKEN
// (the PR check's async calls). { get, comment } or null when there is no token.
export function githubRest(settings, { env = process.env, fetchImpl = null } = {}) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  if (!token || !settings.repo) return null;
  const base = settings.url && !/github\.com$/.test(new URL(settings.url).hostname) ? `${settings.url.replace(/\/+$/, '')}/api/v3` : API;
  const call = async (method, route, body) => {
    const { fetchWithTimeout } = await import('../external.mjs');
    const response = await (fetchImpl ?? fetchWithTimeout)(`${base}/repos/${settings.repo}${route}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) {
      const text = await response.text();
      const msg = `GitHub ${method} ${route} failed: ${response.status} ${text}`;
      // The structured status decides: a content refusal of a text-sending call, else the status as it is.
      if (body && method !== 'GET' && isContentRefusal({ status: response.status, text })) throw new HostRefusedError(msg, { status: response.status });
      throw new HostError(msg, { status: response.status, code: response.status === 429 ? 'rate-limit' : 'http' });
    }
    return response.json();
  };
  return {
    async get(number) {
      const pr = await call('GET', `/pulls/${prNumberOf(number)}`);
      return { ...normalizePr({ number: pr.number, url: pr.html_url, title: pr.title, body: pr.body, state: pr.merged_at ? 'MERGED' : pr.state, isDraft: pr.draft, headRefName: pr.head?.ref, baseRefName: pr.base?.ref, headRefOid: pr.head?.sha, author: pr.user?.login, labels: pr.labels, createdAt: pr.created_at, updatedAt: pr.updated_at, mergedAt: pr.merged_at, closedAt: pr.closed_at }), fromFork: pr.head?.repo?.full_name !== pr.base?.repo?.full_name };
    },
    async comment(number, body) {
      const c = await call('POST', `/issues/${prNumberOf(number)}/comments`, { body });
      return { id: c.id ?? null, url: c.html_url ?? null };
    },
  };
}

// The PR bot of GitHub: the existing GitHub App flow (scripts/pipeline/lib/bot.mjs, bot-setup.mjs).
export function githubBot(config) {
  return {
    // Whether the GitHub App PR bot is set up, and the login the pipeline's PRs are opened as (the bot, else gh's user).
    configured: () => Boolean(loadCredentials(config)),
    author() {
      const bot = loadCredentials(config);
      return bot ? `${bot.slug ?? bot.name}[bot]` : ghLogin();
    },
    async token() {
      const { resolveBot } = await import('../bot.mjs');
      return (await resolveBot(config))?.token ?? null;
    },
    async status(deps) {
      const { botStatus } = await import('../bot-setup.mjs');
      return botStatus(config, deps);
    },
    async setup(options, deps) {
      const { botSetup } = await import('../bot-setup.mjs');
      return botSetup(config, options, deps);
    },
  };
}
