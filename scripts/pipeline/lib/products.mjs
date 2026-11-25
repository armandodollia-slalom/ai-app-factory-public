// Which code host, ticket tracker and CI system a repository uses: the one place that parses a git remote
// and applies the defaults. The host layer (hosts/index.mjs hostSettings), the tracker layer
// (board/lib/trackers/index.mjs trackerFor) and the generator (factory/lib/hosting.mjs: init, render,
// doctor) all call it, so they always agree.
//
// Defaults (docs/configuration.md, docs/hosts-and-trackers.md):
//   host.type    config `host.type`, else detected from the `origin` remote, else github.
//   tracker.type config `tracker.type`; else GitHub when the config holds the legacy GitHub keys
//                (`tickets.repo`, `board.repo|owner|projectNumber`) and no `host` section; else the host's
//                own tracker (github -> github, azure-devops -> azure-boards); else, for a GitLab host,
//                GitHub when legacy keys are present, otherwise none: it must be set (trackerTypeFor
//                throws a message that says how).
//   ci.provider  config `ci.provider`, else the host's own CI system.
// No module here imports an adapter, so the generator can load it without them.
import { spawnSync } from 'node:child_process';
import { defaultSettings } from './settings.mjs';

// `custom` is the escape hatch of each kind: a command the repository declares (providers/custom.mjs).
export const HOST_TYPES = ['github', 'gitlab', 'azure-devops', 'bitbucket', 'custom'];
export const TRACKER_TYPES = ['github', 'jira', 'azure-boards', 'gitlab', 'linear', 'custom'];
export const CI_PROVIDERS = ['github-actions', 'gitlab-ci', 'azure-pipelines', 'jenkins', 'circleci', 'bitbucket-pipelines', 'custom'];
export const DEFAULT_URLS = { github: 'https://github.com', gitlab: 'https://gitlab.com', 'azure-devops': 'https://dev.azure.com', bitbucket: 'https://bitbucket.org' };
// The merge method a host's merge() uses when its caller names none: the implement.autoMerge.method setting's default.
export const defaultMergeMethod = () => defaultSettings().implement.autoMerge.method;
// The CI system each host ships with, and the tracker it has (Bitbucket's issue tracker is not a factory tracker: Jira
// is the usual pair, and the interview asks).
export const CI_FOR_HOST = { github: 'github-actions', gitlab: 'gitlab-ci', 'azure-devops': 'azure-pipelines', bitbucket: 'bitbucket-pipelines', custom: 'custom' };
export const TRACKER_FOR_HOST = { github: 'github', gitlab: 'gitlab', 'azure-devops': 'azure-boards', bitbucket: null, custom: null };

const strip = (p) => String(p ?? '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// { protocol, hostname, port, path } of a remote URL (https, ssh://, git://, or scp-like user@host:path).
function splitRemote(remote) {
  const text = String(remote ?? '').trim();
  if (!text) return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { protocol: 'ssh', hostname: scp[1].toLowerCase(), port: '', path: strip(scp[2]) };
  try {
    const u = new URL(text);
    return { protocol: u.protocol.replace(/:$/, ''), hostname: u.hostname.toLowerCase(), port: u.port, path: strip(dec(u.pathname)) };
  } catch {
    return null;
  }
}

// Azure DevOps cloud paths: "<org>/<project>/_git/<repo>", "<org>/_git/<repo>" (the repository named
// after its project), "v3/<org>/<project>/<repo>" (ssh); on <org>.visualstudio.com the organization is
// the host name and the path is "[DefaultCollection/]<project>/_git/<repo>" or "_git/<repo>".
function azureCloudRepo(segs, org = null) {
  if (segs[0] === 'v3' && segs.length >= 4) return `${segs[1]}/${segs[2]}/${segs[3]}`;
  const at = segs.indexOf('_git');
  if (at < 0 || at + 1 >= segs.length) return null;
  const before = segs.slice(0, at).filter((p) => p !== 'DefaultCollection');
  const o = org ?? before[0];
  const project = org ? (before.at(-1) ?? segs[at + 1]) : before.length >= 2 ? before.at(-1) : segs[at + 1];
  return o && project ? `${o}/${project}/${segs[at + 1]}` : null;
}

// { type, url, repo } of a remote URL: github.com, gitlab.com, dev.azure.com, *.visualstudio.com (https
// and ssh forms), and self-hosted servers when `type` (and for a server under a path prefix, `url`) is
// given. Without `type`, a self-hosted server whose name or path gives it away (gitlab.*, github.*, a
// `_git` path) is guessed; `markGuess` adds `guessed: true` to such a result so a drafted config can ask
// for review. null when it cannot tell.
export function detectHost(remoteUrl, { type = null, url = null, markGuess = false } = {}) {
  const r = splitRemote(remoteUrl);
  if (!r) return null;
  const segs = r.path.split('/').filter(Boolean).map(dec);
  // An ssh port says nothing about the web server's port.
  const web = (scheme = 'https') => `${scheme}://${r.hostname}${r.port && !['ssh', 'git'].includes(r.protocol) ? `:${r.port}` : ''}`;
  const https = r.protocol === 'http' ? 'http' : 'https';
  if (r.hostname === 'github.com' || r.hostname === 'ssh.github.com') return segs.length === 2 ? { type: 'github', url: DEFAULT_URLS.github, repo: `${segs[0]}/${segs[1]}` } : null;
  if (r.hostname === 'gitlab.com' || r.hostname === 'altssh.gitlab.com') return segs.length >= 2 ? { type: 'gitlab', url: DEFAULT_URLS.gitlab, repo: segs.join('/') } : null;
  if (r.hostname === 'bitbucket.org' || r.hostname === 'altssh.bitbucket.org') return segs.length === 2 ? { type: 'bitbucket', url: DEFAULT_URLS.bitbucket, repo: `${segs[0]}/${segs[1]}` } : null;
  if (r.hostname === 'dev.azure.com' || r.hostname === 'ssh.dev.azure.com' || r.hostname === 'vs-ssh.visualstudio.com') {
    const repo = azureCloudRepo(segs);
    return repo ? { type: 'azure-devops', url: DEFAULT_URLS['azure-devops'], repo } : null;
  }
  const vs = /^([\w-]+)\.visualstudio\.com$/.exec(r.hostname);
  if (vs) {
    const repo = azureCloudRepo(segs, vs[1]);
    return repo ? { type: 'azure-devops', url: DEFAULT_URLS['azure-devops'], repo } : null;
  }
  const guess = type ?? (segs.includes('_git') ? 'azure-devops' : /(^|\.)gitlab\./.test(r.hostname) ? 'gitlab' : /(^|\.)github\./.test(r.hostname) ? 'github' : /(^|\.)bitbucket\./.test(r.hostname) || segs[0] === 'scm' ? 'bitbucket' : null);
  if (!guess) return null;
  const mark = (o) => (o && markGuess && !type ? { ...o, guessed: true } : o);
  // The path prefix of a configured server URL (https://example.com/gitlab, https://server/tfs).
  const prefix = (() => {
    try {
      return url ? strip(new URL(url).pathname).split('/').filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  const rest = prefix.length && prefix.every((p, i) => segs[i]?.toLowerCase() === p.toLowerCase()) ? segs.slice(prefix.length) : segs;
  const base = url ? String(url).replace(/\/+$/, '') : null;
  if (guess === 'azure-devops') {
    // Server: [prefix..., collection, project, _git, repo]; ssh: the same or v3/... forms.
    const at = rest.indexOf('_git');
    if (at >= 2) return mark({ type: guess, url: base ?? `${web(https)}${rest.slice(0, at - 2).length ? `/${rest.slice(0, at - 2).join('/')}` : ''}`, repo: `${rest[at - 2]}/${rest[at - 1]}/${rest[at + 1]}` });
    if (rest[0] === 'v3' && rest.length >= 4) return mark({ type: guess, url: base ?? web(https), repo: `${rest[1]}/${rest[2]}/${rest[3]}` });
    return null;
  }
  // Bitbucket Data Center: https://server/scm/<PROJECT>/<repo>.git (http) or ssh://server:7999/<project>/<repo>.git.
  if (guess === 'bitbucket') {
    const parts = rest[0] === 'scm' ? rest.slice(1) : rest;
    return parts.length === 2 ? mark({ type: guess, url: base ?? web(https), repo: `${parts[0]}/${parts[1]}` }) : null;
  }
  if (guess === 'github' ? rest.length !== 2 : rest.length < 2) return null;
  return mark({ type: guess, url: base ?? web(https), repo: guess === 'github' ? `${rest[0]}/${rest[1]}` : rest.join('/') });
}

const origins = new Map();
// Forgets the cached origin remotes (tests that change a checkout's origin).
export const resetProducts = () => origins.clear();
// The `origin` remote of a checkout ('' when there is none). Cached per root.
export function originRemote(root) {
  if (!root) return '';
  if (!origins.has(root)) {
    let r;
    try {
      r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    } catch {
      r = { status: 1 };
    }
    origins.set(root, r.status === 0 ? String(r.stdout).trim() : '');
  }
  return origins.get(root);
}

// The repository ("owner/name", "group/project", ...) of a checkout's origin remote, on any host the factory recognises.
export const originRepo = (root) => detectHost(originRemote(root) || '')?.repo ?? null;

// The legacy GitHub board/ticket keys, set by the repository (the engine defaults leave them null).
export const hasLegacyGithubKeys = (config) => Boolean(config?.tickets?.repo || config?.board?.repo || config?.board?.owner || config?.board?.projectNumber);

// { host: { type, url, repo, source }, tracker: { type, source }, ci: { provider, source }, remote }.
// `remote` defaults to the origin of config.root; pass null for none.
export function resolveProducts(config = {}, { remote = undefined } = {}) {
  const origin = remote === undefined ? originRemote(config?.root) : remote;
  const h = config?.host ?? {};
  const detected = origin ? detectHost(origin, { type: h.type ?? null, url: h.url ?? null, markGuess: true }) : null;
  const hostType = h.type ?? detected?.type ?? 'github';
  const same = detected?.type === hostType ? detected : null;
  const host = { type: hostType, url: String(h.url ?? same?.url ?? DEFAULT_URLS[hostType] ?? '').replace(/\/+$/, ''), repo: h.repo ?? same?.repo ?? null, source: h.type ? 'config' : detected ? 'origin' : 'default', ...(same?.guessed && !h.type ? { guessed: true } : {}) };
  const legacy = hasLegacyGithubKeys(config);
  const trackerType = config?.tracker?.type ?? (legacy && !config?.host ? 'github' : (TRACKER_FOR_HOST[hostType] ?? (legacy ? 'github' : null)));
  const tracker = { type: trackerType, source: config?.tracker?.type ? 'config' : trackerType ? (legacy && trackerType === 'github' && hostType !== 'github' ? 'legacy' : 'default') : 'unset' };
  const ci = { provider: config?.ci?.provider ?? CI_FOR_HOST[hostType], source: config?.ci?.provider ? 'config' : 'host' };
  return { host, tracker, ci, remote: origin || null };
}

// The tracker type, or a clear error when none can be derived (a GitLab host without `tracker.type`).
export function trackerTypeFor(config, opts = {}) {
  const explicit = config?.tracker?.type;
  if (explicit && !TRACKER_TYPES.includes(explicit)) throw configError(`tracker.type is "${explicit}"; use one of ${TRACKER_TYPES.join(', ')}`);
  const { host, tracker } = resolveProducts(config, opts);
  if (tracker.type) return tracker.type;
  throw configError(`the code host is ${host.type}, which has no ticket tracker of its own the factory uses: set tracker.type (${TRACKER_TYPES.join(', ')}) in .factory/config.json, or answer the interview (factory init --interview; docs/providers/trackers/)`);
}

const configError = (message) => Object.assign(new Error(message), { code: 'config' });
