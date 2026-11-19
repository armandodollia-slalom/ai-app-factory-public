// The code host layer: repository, pull requests, reviews, merge, status checks and the PR identity,
// behind one interface for GitHub (the gh CLI), GitLab and Azure DevOps (REST through fetch). The
// contract is in the factory's ADAPTERS notes; in short:
//
//   const host = hostFor(config)            // config.host: { type, url, repo, token: "${ENV}", bot }
//   await host.pr.open({ head, base, title, body })
//   host.sync.pr.get(12)                    // the same methods, synchronous (for synchronous callers)
//
// Calling convention (shared with the ticket tracker layer, scripts/board/lib/trackers/index.mjs):
//   - Host methods are async. `host.sync` has the same methods, synchronous: GitHub runs gh directly;
//     GitLab and Azure DevOps run each call on the adapter layers' one synchronous bridge
//     (../blocking.mjs). Synchronous code (the review gate, the board, implement) uses `host.sync`; async
//     code (pr-check, pr-video, retro, doctor) awaits `host`. Never rewrite a synchronous caller to async
//     to reach a host: use `.sync`.
//   - Tracker methods are synchronous and `tracker.sync` is the tracker, so `x.sync.*` is synchronous
//     and `await x.*` works on both layers.
//   - A method a product cannot support throws UnsupportedError (./errors.mjs) whose message names the
//     fallback (Azure DevOps pr.diff -> `git diff` locally); callers that can degrade catch it.
//
// Without `config.host` the host is detected from the `origin` remote (../products.mjs, shared with the
// tracker layer and the generator); a GitHub origin (or none, with the legacy `board.repo` /
// `tickets.repo`) behaves exactly as before the adapters.
import { fileURLToPath } from 'node:url';
import { runBlocking } from '../blocking.mjs';
import { expandEnv, secretSetting } from '../env.mjs';
import { DEFAULT_URLS, detectHost, HOST_TYPES, originRemote } from '../products.mjs';
import { deserializeError, HostError } from './errors.mjs';
import { createGithubHost, ghInstalled, githubBot, githubRest } from './github.mjs';
import { createGitlabHost, gitlabBot } from './gitlab.mjs';
import { azureBot, createAzureDevopsHost } from './azure-devops.mjs';
import { bitbucketBot, createBitbucketHost } from './bitbucket.mjs';
import { createCustomAdapter } from '../providers/custom.mjs';

// A custom host has no separate PR identity of the factory's (its command decides who it acts as).
const customBot = () => ({ configured: () => false, author: () => null, token: async () => null, status: async () => 0, setup: async () => 0 });

export { UnsupportedError, HostError, HostAuthError, HostRefusedError } from './errors.mjs';
// The GitHub host's gh runner and its review-gate ruleset, for the callers and tests that name them through this layer.
export { ghCli, desiredRuleset, RULESET_NAME } from './github.mjs';

export { DEFAULT_URLS, HOST_TYPES };
// The user name git sends with a token over HTTPS (basic auth).
const GIT_USER = { github: 'x-access-token', gitlab: 'oauth2', 'azure-devops': '', bitbucket: 'x-token-auth' };
const SELF = fileURLToPath(import.meta.url);

// Remote parsing and the product defaults are shared with the tracker layer and the generator.
export { detectHost };

// The resolved host settings: { type, url, repo, token (the unexpanded "${ENV}" setting), apiVersion,
// root, bot }. Precedence: config.host, then (GitHub only) the caller's legacy repo, then the origin
// remote, then (GitHub only) board.repo / tickets.repo.
export function hostSettings(config, deps = {}) {
  const h = config?.host ?? {};
  const remote = deps.remote ?? originRemote(config?.root);
  const detected = remote ? detectHost(remote, { type: h.type ?? null, url: h.url ?? null }) : null;
  const type = h.type ?? detected?.type ?? 'github';
  if (!HOST_TYPES.includes(type)) throw new HostError(`host.type is "${type}"; use one of ${HOST_TYPES.join(', ')}`, { code: 'config' });
  const same = detected?.type === type ? detected : null;
  const url = String(h.url ?? same?.url ?? DEFAULT_URLS[type]).replace(/\/+$/, '');
  const repo = h.repo ?? (type === 'github' ? deps.repo ?? null : null) ?? same?.repo ?? (type === 'github' ? config?.board?.repo ?? config?.tickets?.repo ?? null : null);
  const custom = type === 'custom' ? { command: h.command ?? null, env: h.env ?? {}, timeoutSec: h.timeoutSec ?? null, label: h.label ?? null, capabilities: h.capabilities ?? null, hints: h.hints ?? null } : {};
  return { type, url, repo, token: h.token ?? null, user: h.user ?? null, apiVersion: h.apiVersion ?? null, root: config?.root ?? null, bot: h.bot ?? null, ...custom };
}

// The value of host.token, or null (GitHub: gh owns authentication unless a token is configured).
// GitLab and Azure DevOps fall back to GITLAB_TOKEN / AZURE_DEVOPS_TOKEN when no token is configured.
export function resolveToken(settings, env = process.env) {
  if (settings.token) return expandEnv(settings.token, env, `host.token (${settings.type})`) || null;
  if (settings.type === 'gitlab') return env.GITLAB_TOKEN || null;
  if (settings.type === 'azure-devops') return env.AZURE_DEVOPS_TOKEN || env.SYSTEM_ACCESSTOKEN || null;
  if (settings.type === 'bitbucket') return env.BITBUCKET_TOKEN || null;
  return null;
}

// The HTTPS clone URL git pushes to, and the basic-auth user for a token.
export function gitRemote(settings) {
  const { type, url, repo } = settings;
  if (!repo) return null;
  if (type === 'azure-devops') {
    const [org, project, name] = repo.split('/');
    return { url: `${url}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`, user: GIT_USER[type], origin: new URL(url).origin };
  }
  return { url: `${url}/${repo}.git`, user: GIT_USER[type], origin: new URL(url).origin };
}

// The web URL of a file at a ref (no network call): the page that shows it, or with `raw` the file itself.
export function fileUrl(settings, file, ref, { raw = false } = {}) {
  const { type, url, repo } = settings;
  const p = String(file).split('/').map(encodeURIComponent).join('/');
  const r = encodeURIComponent(ref).replace(/%2F/g, '/');
  if (type === 'gitlab') return `${url}/${repo}/-/${raw ? 'raw' : 'blob'}/${r}/${p}`;
  if (type === 'bitbucket') return `${url}/${repo}/${raw ? 'raw' : 'src'}/${r}/${p}`;
  if (type === 'azure-devops') {
    const [org, project, name] = String(repo).split('/').map(encodeURIComponent);
    return raw
      ? `${url}/${org}/${project}/_apis/git/repositories/${name}/items?path=${encodeURIComponent(`/${file}`)}&versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=branch&$format=octetStream&api-version=7.1`
      : `${url}/${org}/${project}/_git/${name}?path=${encodeURIComponent(`/${file}`)}&version=GB${encodeURIComponent(ref)}`;
  }
  return `${url}/${repo}/blob/${r}/${p}${raw ? '?raw=true' : ''}`;
}

// The web URL of a pull request by number, and whether a URL is a pull request of this repository.
export function prUrl(settings, number) {
  const { type, url, repo } = settings;
  if (type === 'gitlab') return `${url}/${repo}/-/merge_requests/${number}`;
  if (type === 'azure-devops') {
    const [org, project, name] = String(repo).split('/').map(encodeURIComponent);
    return `${url}/${org}/${project}/_git/${name}/pullrequest/${number}`;
  }
  if (type === 'bitbucket') return `${url}/${repo}/pull-requests/${number}`;
  return `${url}/${repo}/pull/${number}`;
}
export function ownsPr(settings, link) {
  if (!settings.repo || !link) return false;
  const base = prUrl(settings, '').toLowerCase();
  const text = String(link).toLowerCase();
  // Cloud URLs and their API-less web forms (Azure's org.visualstudio.com, an https/ssh mismatch) compare by path.
  const tail = (u) => u.replace(/^[a-z]+:\/\/[^/]+/, '');
  return text.startsWith(base) || tail(text).startsWith(tail(base));
}

// Wraps a synchronous adapter in the async contract (identity values and toString stay as they are).
function asyncify(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function' && !['toString', 'toJSON'].includes(k)) out[k] = async (...args) => v(...args);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = asyncify(v);
    else out[k] = v;
  }
  return out;
}

// The synchronous form of a REST adapter: each call runs one async adapter method on the worker thread of
// the adapter layers' synchronous bridge (../blocking.mjs). The settings and an identity token override
// travel through the message port, never a command line; the worker shares this process's environment,
// so host.token resolves the same (deps.env, when a caller passes one, is sent along).
function bridged(settings, deps) {
  const call =
    (method) =>
    (...args) => {
      const out = runBlocking({ kind: 'call', module: SELF, fn: 'callAdapter', args: [settings, method, args, { token: deps.token ?? null, env: deps.env ?? null }] });
      if (out.timeout || out.lost) throw new HostError(`${settings.type} ${method}: the host bridge ${out.timeout ? 'timed out' : 'gave no answer'}`, { code: 'bridge' });
      if (!out.ok) throw deserializeError(out.error);
      return out.value;
    };
  const shape = (obj, prefix) => {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      if (['toString', 'toJSON'].includes(k)) o[k] = v;
      else if (typeof v === 'function') o[k] = call(`${prefix}${k}`);
      else if (v && typeof v === 'object' && !Array.isArray(v)) o[k] = shape(v, `${prefix}${k}.`);
      else o[k] = v;
    }
    return o;
  };
  // The method shape of the adapter, without any network call.
  return shape(createAdapter(settings, {}), '');
}

// Runs one method of a REST adapter (the worker side of `bridged`): `method` is a dotted path ("pr.get").
export async function callAdapter(settings, method, args = [], { token = null, env = null } = {}) {
  const host = createAdapter(settings, { ...(token ? { token } : {}), ...(env ? { env } : {}) });
  const parts = method.split('.');
  const owner = parts.slice(0, -1).reduce((o, k) => o?.[k], host);
  const fn = owner?.[parts.at(-1)];
  if (typeof fn !== 'function') throw new Error(`no host method ${method}`);
  return fn.apply(owner, args);
}

export function createAdapter(settings, deps = {}) {
  const s = { ...settings, resolveToken: () => resolveToken(settings, deps.env ?? process.env) };
  if (settings.type === 'github') return createGithubHost(s, deps);
  if (settings.type === 'gitlab') return createGitlabHost(s, deps);
  if (settings.type === 'bitbucket') return createBitbucketHost(s, deps);
  if (settings.type === 'custom') return createCustomAdapter('host', settings, deps);
  return createAzureDevopsHost(s, deps);
}

const cache = new WeakMap();

// The code host of a repository's config. deps (all optional, for tests and identities): { gh | run
// (GitHub runners), env, token (act as another identity, such as the PR bot), cwd, fetch, sleep, repo
// (the caller's legacy GitHub repository), remote }. Cached per config object when no deps are given.
export function hostFor(config, deps = {}) {
  const plain = !Object.keys(deps).length && config && typeof config === 'object';
  if (plain && cache.has(config)) return cache.get(config);
  const settings = hostSettings(config, deps);
  let host;
  if (settings.type === 'custom') {
    // A command the repository declares: synchronous by nature, so both forms are the same calls.
    const core = createCustomAdapter('host', settings, deps);
    host = asyncify(core);
    host.sync = core;
  } else if (settings.type === 'github') {
    const core = createGithubHost({ ...settings, resolveToken: () => resolveToken(settings, deps.env ?? process.env) }, deps);
    host = asyncify(core);
    host.sync = core;
    // No gh on this machine (a bare CI runner): the async reads and comments go through the REST API with its token.
    if (!deps.gh && !deps.run && !ghInstalled()) {
      const rest = githubRest(settings, { env: deps.env ?? process.env });
      if (rest) Object.assign(host.pr, { get: rest.get, comment: (n, body) => rest.comment(n, body) });
    }
  } else {
    host = createAdapter(settings, deps);
    let sync;
    Object.defineProperty(host, 'sync', { get: () => (sync ??= bridged(settings, deps)), enumerable: false });
  }
  host.settings = settings;
  host.git = gitRemote(settings);
  host.fileUrl = (file, ref, opts) => fileUrl(settings, file, ref, opts);
  host.prUrl = (number) => prUrl(settings, number);
  host.ownsPr = (link) => ownsPr(settings, link);
  const resolveBotToken = () => secretSetting(settings.bot?.token, deps.env ?? process.env);
  const createHost = (d) => hostFor(config, { ...deps, ...d });
  host.bot = settings.type === 'github' ? githubBot(config) : settings.type === 'gitlab' ? gitlabBot(settings, { resolveBotToken, createHost }) : settings.type === 'bitbucket' ? bitbucketBot(settings, { resolveBotToken, createHost }) : settings.type === 'custom' ? customBot() : azureBot(settings, { resolveBotToken, createHost });
  if (plain) cache.set(config, host);
  return host;
}

// The synchronous host (host.sync) for synchronous callers such as the review gate.
export const hostSync = (config, deps = {}) => hostFor(config, deps).sync;

// The synchronous code host of a call target, as older callers and tests name it: a gh runner (GitHub, with `repo`),
// a repository slug string with an optional gh runner (GitHub), a code host (returned as it is), or a repository
// config (its code host).
export function hostOf(target, { repo = null, gh = null } = {}) {
  if (typeof target === 'function') return createGithubHost({ type: 'github', repo }, { gh: target });
  if (typeof target === 'string') return createGithubHost({ type: 'github', repo: target }, gh ? { gh } : {});
  if (target?.pr && target?.repo) return target;
  return hostFor(target ?? {}, { ...(gh ? { gh } : {}), ...(repo ? { repo } : {}) }).sync;
}

// Links to attachments a host serves under its own URL (GitHub's uploaded files), for finding videos in a PR body.
export const ATTACHMENT_PATTERNS = ['https://github\\.com/user-attachments/assets/[\\w-]+'];

// A host's web link to a file in a repository, as the URL that serves the file itself (GitHub's blob and raw pages
// redirect; raw.githubusercontent.com serves the file and accepts the token). Other links are returned as they are.
export function rawFileUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^?#]+)/.exec(url);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : url;
}

// The headers that let a download of `url` through: the configured host's token for its own server, GITHUB_TOKEN or
// GH_TOKEN for github.com and its file servers; none otherwise.
export function downloadHeaders(url, config = null, env = process.env) {
  const hostname = new URL(url).hostname;
  const ghToken = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  if (ghToken && /(^|\.)github(usercontent)?\.com$/.test(hostname)) return { Authorization: `Bearer ${ghToken}` };
  if (!config) return {};
  try {
    const s = hostSettings(config);
    if (new URL(s.url).origin !== new URL(url).origin) return {};
    const value = resolveToken(s, env);
    if (!value) return {};
    if (s.type === 'gitlab') return { 'PRIVATE-TOKEN': value };
    if (s.type === 'azure-devops') return { Authorization: `Basic ${Buffer.from(`:${value}`).toString('base64')}` };
    return { Authorization: `Bearer ${value}` };
  } catch {
    return {};
  }
}

// The code host of another repository, named by its remote URL (the factory's own repository: the retro files issues and
// opens its self-test PR there). Synchronous; null when the URL names no host the factory knows.
export function remoteHost(remoteUrl, deps = {}) {
  const d = detectHost(remoteUrl, { markGuess: false });
  if (!d) return null;
  return hostFor({ host: { type: d.type, url: d.url, repo: d.repo } }, { remote: '', ...deps }).sync;
}
