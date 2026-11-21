// GitHub Actions as the CI system (the CI contract, providers/contracts.mjs): the pipelines a head must run are
// the workflows a `pull_request` (or `pull_request_target`) event for that PR triggers, read from the repository's
// own workflow files at that head after their `types`, `branches` and `paths` filters; runs and logs come from the
// Actions API through gh (gh owns authentication; GH_TOKEN selects another identity). Every call is the one the
// gate and the implement run made before the CI layer existed.
//
// Settings (`implement.reviewGate.ci`, or `ci.expected` / `ci.ignore` in .factory/config.json):
//   expected: [".github/workflows/x.yml", ...]   use this list instead of deriving it
//   ignore:   [".github/workflows/y.yml", ...]   workflows never waited for (default: the review-quorum workflow)
//   allowNoWorkflows: false                       a repository with no pull-request workflow can never be green
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run as runCmd } from '../util.mjs';
import { UnsupportedError } from '../hosts/errors.mjs';

// The YAML parser is loaded when a workflow is read, not when the module loads (a copy of the scripts without
// node_modules still loads it; a workflow it cannot parse is unreadable, which never counts as green).
const requireHere = createRequire(import.meta.url);
let yamlLib = null;
const YAML = { parse: (text) => (yamlLib ??= requireHere('yaml')).parse(text) };

export const CAPABILITIES = { logs: true, expectedFromDefinition: true, runsByCommit: true, reviewEvents: true, schedules: true, rerun: true, branchPipelines: true };

// The pull_request activity types GitHub uses when `types` is not given.
const DEFAULT_TYPES = ['opened', 'synchronize', 'reopened'];

// A GitHub workflow filter pattern as a regular expression (`**` any path, `*` within a segment, `?` one character).
export function globRegex(pattern) {
  let re = '';
  const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// GitHub's include/exclude list with `!` negations, evaluated in order.
function matches(patterns, value) {
  let hit = false;
  for (const raw of patterns ?? []) {
    const neg = String(raw).startsWith('!');
    if (globRegex(neg ? String(raw).slice(1) : raw).test(value)) hit = !neg;
  }
  return hit;
}

// The `on:` section of a workflow, normalised to { event: config|null }.
export function triggers(doc) {
  const on = doc?.on ?? doc?.true; // YAML 1.1 reads a bare `on` key as true
  if (!on) return {};
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, null]));
  return on;
}

// Whether a workflow runs for this head, and whether the head owes it.
// - mode 'pr': a pull_request (or pull_request_target) event for the PR. The head owes the workflow for the activities it
//   went through (`activities`: opened, synchronize, reopened, ready_for_review, labeled; council C10, Sol 2): a
//   synchronize-only workflow is owed by a replacement head, not by the PR's first one, and a labeled-only workflow only
//   by a head that was labelled. A workflow that may run but is not owed must still pass when it does run.
// - mode 'push': a push of `branch` before any PR exists (implement.preOpen): the `push` trigger's branch and path filters.
export function workflowApplies(doc, { base, changed = [], activities = ['opened'], mode = 'pr', branch = null }) {
  const on = triggers(doc);
  const pathsOk = (cfg) => !(cfg.paths && !changed.some((f) => matches(cfg.paths, f))) && !(cfg['paths-ignore'] && changed.length && changed.every((f) => matches(cfg['paths-ignore'], f)));
  if (mode === 'push') {
    if (!Object.hasOwn(on, 'push')) return { applies: false, required: false };
    const cfg = on.push ?? {};
    if (cfg.branches && !matches(cfg.branches, branch)) return { applies: false, required: false };
    if (cfg['branches-ignore'] && matches(cfg['branches-ignore'], branch)) return { applies: false, required: false };
    if (cfg.tags && !cfg.branches) return { applies: false, required: false };
    if (!pathsOk(cfg)) return { applies: false, required: false };
    return { applies: true, required: true, event: 'push' };
  }
  for (const event of ['pull_request', 'pull_request_target']) {
    if (!Object.hasOwn(on, event)) continue;
    const cfg = on[event] ?? {};
    const types = Array.isArray(cfg.types) ? cfg.types : cfg.types ? [cfg.types] : DEFAULT_TYPES;
    if (cfg.branches && !matches(cfg.branches, base)) continue;
    if (cfg['branches-ignore'] && matches(cfg['branches-ignore'], base)) continue;
    if (!pathsOk(cfg)) continue;
    const required = types.some((t) => (activities ?? ['opened', 'synchronize', 'reopened']).includes(t));
    return { applies: true, required, event };
  }
  return { applies: false, required: false };
}

// The workflows a PR's head is expected to run: [{ id, path, name, required }].
export function expectedWorkflows(files, { base, changed = [], settings = {}, activities = ['opened'], mode = 'pr', branch = null }) {
  const ignore = new Set(settings.ignore ?? []);
  if (Array.isArray(settings.expected)) return settings.expected.map((p) => ({ id: p, path: p, name: p, required: true }));
  const out = [];
  for (const { path: p, text } of files) {
    if (ignore.has(p)) continue;
    let doc;
    try {
      doc = YAML.parse(text);
    } catch {
      out.push({ id: p, path: p, name: p, required: true, unreadable: true });
      continue;
    }
    if ((settings.ignoreNames ?? ['review-quorum']).includes(doc?.name)) continue;
    const w = workflowApplies(doc, { base, changed, activities, mode, branch });
    if (w.applies) out.push({ id: p, path: p, name: doc?.name ?? p, required: w.required });
    // Before the PR: a workflow only a pull request runs is listed (prOnly), never waited for on the branch.
    else if (mode === 'push' && workflowApplies(doc, { base, changed, activities: ['opened'] }).applies) out.push({ id: p, path: p, name: doc?.name ?? p, required: false, prOnly: true });
  }
  return out;
}

// The CI checks a host should require next to review-quorum (council C9): the jobs of every pull-request workflow that
// runs for EVERY pull request of the default branch (no paths or branches filter, `opened` among its types): a check
// that does not run for some PR (a docs-only change skips a paths-ignore workflow) can never be required, or GitHub would
// block that PR forever. A job whose condition is for closing the PR (`github.event.action == 'closed'`) and matrix jobs
// are left out; a reusable workflow's jobs are named "<caller job> / <job>", as GitHub reports them.
// The job the factory renders first into a workflow that also runs on story-branch pushes (factory/lib/pre-open-ci.mjs):
// on a PR event it only decides whether the push run on the same head already passed. It is not a check to require:
// the workflow's own jobs carry the required names, and several workflows share the job's name.
const isReuseJob = (id, job) => id === 'reuse' && /event_name\s*==\s*'pull_request'/.test(String(job?.if ?? ''));

export function defaultRequiredChecks(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const read = (f) => {
    try {
      return YAML.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const out = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const doc = read(path.join(dir, f));
    if (!doc || doc.name === 'review-quorum') continue;
    const on = triggers(doc);
    if (!Object.hasOwn(on, 'pull_request')) continue;
    const cfg = on.pull_request ?? {};
    if (cfg.paths || cfg['paths-ignore'] || cfg['branches-ignore']) continue;
    if (cfg.branches && !(Array.isArray(cfg.branches) ? cfg.branches : [cfg.branches]).some((b) => ['**', '*'].includes(b))) continue;
    const types = cfg.types ? (Array.isArray(cfg.types) ? cfg.types : [cfg.types]) : ['opened'];
    if (!types.includes('opened')) continue;
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (!job || job.strategy?.matrix) continue;
      if (/github\.event\.action\s*==\s*'closed'/.test(String(job.if ?? ''))) continue;
      if (isReuseJob(id, job)) continue;
      const name = job.name ?? id;
      if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
        const called = read(path.join(root, job.uses));
        for (const [cid, cjob] of Object.entries(called?.jobs ?? {})) if (cjob && !cjob.strategy?.matrix) out.add(`${name} / ${cjob.name ?? cid}`);
      } else out.add(name);
    }
  }
  return [...out].sort();
}

// Every check name the checkout's workflows can produce on a pull request (any job of a workflow with a pull_request
// trigger, the jobs of reusable workflows it calls as "<job> / <called job>"; a matrix job as "<name> (" prefixes).
// A host rule that requires a name not in this list waits for a check that never runs.
export function providedChecks(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const read = (f) => {
    try {
      return YAML.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const out = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const doc = read(path.join(dir, f));
    if (!doc) continue;
    const on = triggers(doc);
    if (!Object.hasOwn(on, 'pull_request') && !Object.hasOwn(on, 'pull_request_target') && !Object.hasOwn(on, 'pull_request_review')) continue;
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (!job) continue;
      const name = job.name ?? id;
      out.add(name);
      if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
        const called = read(path.join(root, job.uses));
        for (const [cid, cjob] of Object.entries(called?.jobs ?? {})) if (cjob) out.add(`${name} / ${cjob.name ?? cid}`);
      }
    }
  }
  return [...out].sort();
}

// The jobs of the repository's own pull-request workflows that no host rule requires, and why (council C10, Opus 5: the
// application's own test jobs were not required, both named "test", so a person merging by hand was not stopped). The
// factory's own workflows (factory-*) are left out: enforce requires those. [{ workflow, job, name, reason }]
export function uncoveredChecks(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const required = new Set(defaultRequiredChecks(root));
  const read = (f) => {
    try {
      return YAML.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const jobs = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const doc = read(path.join(dir, f));
    if (!doc || doc.name === 'review-quorum') continue;
    const on = triggers(doc);
    if (!Object.hasOwn(on, 'pull_request')) continue;
    const cfg = on.pull_request ?? {};
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (!job || /github\.event\.action\s*==\s*'closed'/.test(String(job.if ?? ''))) continue;
      jobs.push({ workflow: `.github/workflows/${f}`, own: !f.startsWith('factory-'), job: id, name: job.name ?? id, cfg, matrix: Boolean(job.strategy?.matrix) });
    }
  }
  const out = [];
  // A required name another workflow's job also carries: either one passing may satisfy the requirement.
  for (const j of jobs.filter((x) => x.own && required.has(x.name))) {
    const twins = jobs.filter((x) => x !== j && x.name === j.name);
    if (twins.length) out.push({ workflow: j.workflow, job: j.job, name: j.name, shared: true, reason: `the required check "${j.name}" is also the name of ${twins.map((x) => `${x.workflow} (job ${x.job})`).join(', ')}: either one passing may satisfy it (give the jobs distinct names)` });
  }
  for (const j of jobs.filter((x) => x.own && !required.has(x.name))) {
    const reasons = [];
    const twins = jobs.filter((x) => x !== j && x.name === j.name);
    if (twins.length) reasons.push(`its job name "${j.name}" is also used by ${twins.map((x) => x.workflow).join(', ')}: a required check by that name would be ambiguous (give the jobs distinct names)`);
    if (j.cfg.paths || j.cfg['paths-ignore']) reasons.push('its workflow has a paths filter: a required check the filter skips would hold that pull request forever');
    const types = j.cfg.types ? [j.cfg.types].flat() : ['opened'];
    if (!types.includes('opened')) reasons.push('it does not run when a pull request opens');
    if (j.cfg['branches-ignore'] || (j.cfg.branches && ![j.cfg.branches].flat().some((b) => ['**', '*'].includes(b)))) reasons.push('its workflow runs only for some base branches');
    if (j.matrix) reasons.push('it is a matrix job (one check per matrix entry)');
    out.push({ workflow: j.workflow, job: j.job, name: j.name, reason: reasons.join('; ') || 'not required on the host' });
  }
  return out;
}

const decode = (b64) => Buffer.from(String(b64 ?? '').replace(/\s/g, ''), 'base64').toString('utf8');
const STATUS = { completed: 'completed', in_progress: 'running', queued: 'queued', waiting: 'queued', requested: 'queued', pending: 'queued' };

// settings: { repo, url }; deps: { gh(args, opts) | run(cmd, args, opts), env }.
export function createGithubActions(settings = {}, deps = {}) {
  const repo = settings.repo ?? null;
  const runner = deps.gh ?? ((args, o = {}) => (deps.run ?? runCmd)('gh', args, { cwd: o.cwd, input: o.input, env: o.env ?? deps.env, timeoutSec: 120 }));
  const gh = (args, o = {}) => runner(args, o);
  const need = () => {
    if (!repo) throw new Error('the GitHub repository is unknown: set host.repo ("owner/name") in .factory/config.json or add a GitHub origin remote');
    return repo;
  };
  const ok = (what, r) => {
    // A runner that reports no status (a test's fake) succeeded.
    if (r && (r.status === 0 || r.status == null)) return String(r.stdout ?? '');
    throw Object.assign(new Error(`${what}: ${r?.cause ?? String(r?.stderr ?? '').trim().split('\n').pop() ?? 'no answer'}`), { status: r?.status ?? null });
  };
  return {
    type: 'github-actions',
    capabilities: CAPABILITIES,
    prEvents: ['pull_request', 'pull_request_target'],
    pushEvents: ['push'],
    // The workflows the head's pull_request event triggers, read from the workflow files at that head.
    expected({ head, base, changed = [], settings: s = {}, activities = null, mode = 'pr', branch = null }) {
      const listR = gh(['api', `repos/${need()}/contents/.github/workflows?ref=${head}`, '--jq', '.[] | select(.type == "file") | .path']);
      let paths = [];
      if (listR?.status === 0) paths = String(listR.stdout).split('\n').filter((p) => /\.ya?ml$/.test(p));
      else if (!/HTTP 404/.test(String(listR?.stderr))) ok('the workflow files could not be listed', listR);
      const files = [];
      for (const p of paths) {
        const f = gh(['api', `repos/${need()}/contents/${p}?ref=${head}`, '--jq', '.content']);
        files.push(f?.status === 0 ? { path: p, text: decode(f.stdout) } : { path: p, text: '\u0000' });
      }
      return expectedWorkflows(files, { base, changed, settings: s, activities: activities ?? ['opened', 'synchronize', 'reopened'], mode, branch });
    },
    // The head's workflow runs (all events; the evidence keeps the pull_request ones), from the Actions API. With a
    // `limit`: `gh run list` of the branch (or, without a branch, of the commit), newest first, filtered to the head.
    runs({ head = null, branch = null, limit = null } = {}) {
      if (head && limit == null) {
        const out = ok('the head\'s workflow runs could not be read', gh(['api', `repos/${need()}/actions/runs?head_sha=${head}&per_page=100`, '--jq', '[.workflow_runs[] | {id, path, name, status, conclusion, event}]']));
        return (JSON.parse(out || '[]') ?? []).map((r) => ({ id: r.id, pipeline: r.path, path: r.path, name: r.name, status: STATUS[r.status] ?? r.status, conclusion: r.conclusion ?? null, event: r.event, url: r.html_url ?? null, sha: head }));
      }
      const args = ['run', 'list', '-R', need(), ...(branch ? ['--branch', branch] : head ? ['--commit', head] : []), '--limit', String(limit), '--json', 'databaseId,conclusion,name,headSha,status,event,workflowName,url'];
      const list = JSON.parse(ok('the workflow runs could not be read', gh(args)) || '[]') ?? [];
      return list.filter((r) => !head || !r.headSha || r.headSha === head).map((r) => ({ id: r.databaseId, pipeline: r.workflowName ?? r.name, name: r.name ?? r.workflowName, status: STATUS[r.status] ?? r.status ?? 'completed', conclusion: r.conclusion ?? null, event: r.event ?? null, url: r.url ?? null, sha: r.headSha ?? head }));
    },
    log(runId, { failedOnly = false } = {}) {
      return ok(`the log of run ${runId} could not be read`, gh(['run', 'view', String(runId), '-R', need(), failedOnly ? '--log-failed' : '--log']));
    },
    rerun(runId) {
      ok(`run ${runId} could not be started again`, gh(['run', 'rerun', String(runId), '-R', need(), '--failed']));
    },
    requiredChecks: (root) => defaultRequiredChecks(root),
    uncoveredChecks: (root) => uncoveredChecks(root),
    providedChecks: (root) => providedChecks(root),
    definitionFiles: (root) => (fs.existsSync(path.join(root, '.github/workflows')) ? fs.readdirSync(path.join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`) : []),
    unsupported: (what) => {
      throw new UnsupportedError(what);
    },
  };
}
