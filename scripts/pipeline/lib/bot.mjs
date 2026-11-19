// The pipeline's PR identity. On GitHub: a GitHub App per developer, named `dev-bot-<gh login>` (`bot.namePattern`
// in scripts/pipeline/config.json). The pipeline pushes the branches of its PRs and opens the PRs with
// the App's installation token, so the developer is not the PR's author and can approve it with
// GitHub's normal review flow. Everything else (board, labels, reviews) stays the developer's gh login.
// Commit authorship is unchanged. See docs/ai-pipeline/setup.md#the-pipelines-pr-bot.
//
// Credentials live outside the repo: <bot.credentialsDir>/<bot name>.json ({ appId, slug, owner,
// privateKeyFile }) and the private key next to it (mode 0600), written by `pipeline bot setup`. CI
// sets PIPELINE_BOT_APP_ID and PIPELINE_BOT_PRIVATE_KEY (or PIPELINE_BOT_PRIVATE_KEY_FILE) instead.
// When the bot is enabled but not set up, the pipeline warns and uses the developer's login.
//
// On GitLab and Azure DevOps the identity is a token configured as `host.bot.token` ("${ENV}"): a project
// or group access token (GitLab), a service principal's or a dedicated user's token (Azure DevOps); see
// scripts/pipeline/lib/hosts (`host.bot`). Pull requests are opened through the code host either way.
//
// No token ever reaches a log, an error or a thrown message: git output is redacted, and the push
// sends the token in a header from the environment, never on the command line or in a URL.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from './git.mjs';
import { gitRemote, hostFor, hostSettings } from './hosts/index.mjs';
import { secretSetting } from './env.mjs';
import { log as defaultLog, readJson, run, tail } from './util.mjs';
import { withDerivedClasses } from './policy-classes.mjs';
import { mergeLatestBase } from './base-merge.mjs';
import { omittedNote, postOmitted, sendWithReductionAsync } from './hosts/refusal.mjs';

export const API = 'https://api.github.com';
// GitHub App names are global and at most 34 characters.
export const MAX_APP_NAME = 34;
export const BOT_DEFAULTS = { enabled: true, namePattern: 'dev-bot-{login}', credentialsDir: '~/.config/ai-app-factory' };
const SETUP_CMD = 'factory bot setup';
const REFRESH_MS = 5 * 60 * 1000;

// `dev-bot-{login}` with the gh login. A name over 34 characters keeps its first 27 and ends with
// `-` and 6 hex characters of a hash of the full name, so two long logins with the same prefix differ.
export function botName(login, pattern = BOT_DEFAULTS.namePattern) {
  const full = String(pattern || BOT_DEFAULTS.namePattern).replaceAll('{login}', String(login ?? '').toLowerCase());
  if (full.length <= MAX_APP_NAME) return full;
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 6);
  return `${full.slice(0, MAX_APP_NAME - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

const expandHome = (p) => (p === '~' ? os.homedir() : /^~[/\\]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);

// config.bot with its defaults; PIPELINE_BOT=0 turns the bot off.
export function botSettings(config, env = process.env) {
  const s = { ...BOT_DEFAULTS, ...(config?.bot ?? {}) };
  return {
    ...s,
    enabled: s.enabled !== false && env.PIPELINE_BOT !== '0',
    credentialsDir: path.resolve(expandHome(env.PIPELINE_BOT_CREDENTIALS_DIR || s.credentialsDir)),
  };
}

// owner/name of the origin remote when it is on GitHub, else null (a local or test repo: no PRs).
export function repoOf(config, { git: g = git } = {}) {
  const url = g(config.root, ['remote', 'get-url', 'origin']).stdout?.trim() ?? '';
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

let loginCache;
// The login of the developer's gh CLI (PIPELINE_BOT_LOGIN overrides it).
export function ghLogin({ run: r = run, env = process.env } = {}) {
  if (env.PIPELINE_BOT_LOGIN) return env.PIPELINE_BOT_LOGIN;
  if (loginCache !== undefined) return loginCache;
  const res = r('gh', ['api', 'user', '--jq', '.login'], { timeoutSec: 60 });
  loginCache = res.status === 0 ? res.stdout.trim() || null : null;
  return loginCache;
}

export const credentialsFile = (settings, name) => path.join(settings.credentialsDir, `${name}.json`);

// The App's id and private key: from the environment (CI), else from the credentials file of
// `dev-bot-<login>`. Null when there are none. The result holds the private key: never log it.
export function loadCredentials(config, { env = process.env, login, run: r } = {}) {
  if (env.PIPELINE_BOT_APP_ID && (env.PIPELINE_BOT_PRIVATE_KEY || env.PIPELINE_BOT_PRIVATE_KEY_FILE)) {
    const keyFile = env.PIPELINE_BOT_PRIVATE_KEY_FILE;
    const privateKey = env.PIPELINE_BOT_PRIVATE_KEY ? env.PIPELINE_BOT_PRIVATE_KEY.replace(/\\n/g, '\n') : fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null;
    if (!privateKey) return null;
    return { source: 'env', name: env.PIPELINE_BOT_NAME ?? null, appId: String(env.PIPELINE_BOT_APP_ID), slug: env.PIPELINE_BOT_SLUG ?? null, owner: null, privateKey };
  }
  const settings = botSettings(config, env);
  const who = login ?? ghLogin({ env, ...(r ? { run: r } : {}) });
  if (!who) return null;
  const name = botName(who, settings.namePattern);
  const file = credentialsFile(settings, name);
  const data = readJson(file, null);
  if (!data?.appId || !data.privateKeyFile) return null;
  const keyFile = path.resolve(path.dirname(file), data.privateKeyFile);
  if (!fs.existsSync(keyFile)) return null;
  return { source: 'file', file, name, appId: String(data.appId), slug: data.slug ?? null, owner: data.owner ?? null, privateKey: fs.readFileSync(keyFile, 'utf8') };
}

// Writes the credentials file and the private key (both 0600, in a 0700 folder). Returns the file.
export function saveCredentials(settings, name, { appId, slug, owner, pem }) {
  fs.mkdirSync(settings.credentialsDir, { recursive: true, mode: 0o700 });
  const keyName = `${name}.private-key.pem`;
  const keyPath = path.join(settings.credentialsDir, keyName);
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  const file = credentialsFile(settings, name);
  fs.writeFileSync(file, `${JSON.stringify({ appId, slug, owner, privateKeyFile: keyName }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

const b64url = (data) => Buffer.from(data).toString('base64url');

// The App's JWT (RS256): issued 60 s in the past against clock drift, valid for 9 minutes.
export function appJwt(appId, privateKey, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 60 + 9 * 60, iss: /^\d+$/.test(String(appId)) ? Number(appId) : String(appId) }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

// Removes every secret from text: the given values, their basic-auth form, and any token in a URL.
export function redact(text, ...secrets) {
  let out = String(text ?? '');
  for (const s of secrets.filter((x) => x && String(x).length >= 4)) {
    out = out.split(String(s)).join('***');
    for (const user of ['x-access-token', 'oauth2', '']) out = out.split(Buffer.from(`${user}:${s}`).toString('base64')).join('***');
  }
  return out.replace(/(https?:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@');
}

export async function githubApi(fetchFn, method, route, token, body) {
  const res = await fetchFn(`${API}${route}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-app-factory-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

const apiError = (what, r) => `${what}: HTTP ${r.status}${r.json?.message ? ` (${String(r.json.message).slice(0, 200)})` : ''}`;

// The App's installation on the repo, or { ok: false, status } when it is not installed there.
export async function installation(creds, repo, { fetch: f = globalThis.fetch, now = () => Date.now() } = {}) {
  const r = await githubApi(f, 'GET', `/repos/${repo}/installation`, appJwt(creds.appId, creds.privateKey, now()));
  return r.ok ? { ok: true, id: r.json?.id, account: r.json?.account?.login ?? null } : { ok: false, status: r.status, message: r.json?.message ?? null };
}

const tokenCache = new Map();
const warned = new Set();

// Clears the in-memory token cache, the gh login and the one-time warnings (tests).
export function resetBot() {
  tokenCache.clear();
  warned.clear();
  loginCache = undefined;
}

// An installation token for the repo, limited to it, cached in memory until 5 minutes before it
// expires. Throws (without any secret in the message) when the App is not installed or GitHub refuses.
export async function installationToken(config, { fetch: f = globalThis.fetch, now = () => Date.now(), creds, repo, env = process.env } = {}) {
  creds ??= loadCredentials(config, { env });
  if (!creds) throw new Error(`the pipeline's PR bot is not configured (run \`${SETUP_CMD}\`)`);
  repo ??= repoOf(config);
  if (!repo) throw new Error('the origin remote is not a GitHub repository');
  const key = `${creds.appId}:${repo}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - now() > REFRESH_MS) return hit.token;
  const jwt = appJwt(creds.appId, creds.privateKey, now());
  const inst = await githubApi(f, 'GET', `/repos/${repo}/installation`, jwt);
  if (!inst.ok || !inst.json?.id) throw new Error(apiError(`the GitHub App ${creds.slug ?? creds.appId} is not installed on ${repo}`, inst));
  const tok = await githubApi(f, 'POST', `/app/installations/${inst.json.id}/access_tokens`, jwt, { repositories: [repo.split('/')[1]] });
  if (!tok.ok || !tok.json?.token) throw new Error(apiError(`GitHub refused an installation token for ${creds.slug ?? creds.appId}`, tok));
  const expiresAt = Date.parse(tok.json.expires_at ?? '') || now() + 60 * 60 * 1000;
  tokenCache.set(key, { token: tok.json.token, expiresAt });
  return tok.json.token;
}

function warnOnce(key, lines, logFn) {
  if (warned.has(key)) return;
  warned.add(key);
  for (const line of lines) logFn(`WARNING: ${line}`);
}

// { name, repo, token } of the bot for this repo, or null: the bot is off, the origin is not on
// GitHub, or the bot is not set up or cannot mint a token (then a loud warning, once per process,
// and the caller uses the developer's gh login as before).
export async function resolveBot(config, deps = {}) {
  const env = deps.env ?? process.env;
  const logFn = deps.log ?? defaultLog;
  if (!botSettings(config, env).enabled) return null;
  const host = deps.repo !== undefined ? null : otherHost(config);
  if (host) return resolveTokenBot(host, env, logFn);
  const repo = deps.repo !== undefined ? deps.repo : repoOf(config);
  if (!repo) return null;
  const creds = deps.creds !== undefined ? deps.creds : loadCredentials(config, { env, run: deps.run });
  if (!creds) {
    warnOnce('not-configured', [
      "the pipeline's PR bot (dev-bot-<your gh login>) is not set up, so its PRs are opened with your own gh login and GitHub will not let you approve them.",
      `run \`${SETUP_CMD}\` once (PIPELINE_BOT=0 turns the bot off and silences this).`,
    ], logFn);
    return null;
  }
  const name = creds.name ?? creds.slug ?? `app ${creds.appId}`;
  try {
    return { name, repo, token: await installationToken(config, { fetch: deps.fetch, now: deps.now, creds, repo, env }) };
  } catch (error) {
    warnOnce('token', [
      `the pipeline's PR bot ${name} could not get a token (${redact(error.message)}); this PR is opened with your own gh login.`,
      'run `factory bot status` to see what is missing.',
    ], logFn);
    return null;
  }
}

// The host settings when the code host is not GitHub (GitLab, Azure DevOps), else null.
function otherHost(config) {
  try {
    const s = hostSettings(config);
    return s.type === 'github' ? null : s;
  } catch {
    return null;
  }
}

// The bot of a GitLab or Azure DevOps host: the token in host.bot.token, or null with a warning.
function resolveTokenBot(settings, env, logFn) {
  const token = secretSetting(settings.bot?.token, env);
  if (!token) {
    warnOnce('not-configured', [
      `the pipeline's PR bot is not set up for ${settings.type} (host.bot.token), so its pull requests are opened with your own token and you may not be able to approve them.`,
      `run \`${SETUP_CMD}\` for the steps (PIPELINE_BOT=0 turns the bot off and silences this).`,
    ], logFn);
    return null;
  }
  return { name: settings.bot?.name ?? `${settings.type} bot`, repo: settings.repo, token, type: settings.type, remote: gitRemote(settings) };
}

// { GH_TOKEN } for gh calls as the bot (GitHub), { token } for the REST hosts, or null (bot off or not
// configured: use the developer's identity).
export async function botEnv(config, deps = {}) {
  const bot = await resolveBot(config, deps);
  if (!bot) return null;
  return bot.type && bot.type !== 'github' ? { token: bot.token } : { GH_TOKEN: bot.token };
}

// botEnv for synchronous callers (the review gate's merge): runs it in a child process.
export function botEnvSync(config) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'env', config.root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120000, windowsHide: true });
  try {
    return r.status === 0 ? JSON.parse(r.stdout || 'null') : null;
  } catch {
    return null;
  }
}

// Pushes a branch with an installation token. The token goes to git in an Authorization header set
// from the environment (it never appears on the command line, in a URL or in the output), the
// developer's credential helpers are bypassed, and the branch's upstream is set to origin/<branch>.
// `remote` ({ url, user, origin }, from hosts' gitRemote) pushes to GitLab or Azure DevOps instead of
// github.com: the same header, with the host's basic-auth user (oauth2, or empty for a PAT).
// `lease`: the sha the remote branch must still have (a force push with a lease, only for the harness's fold of a story
// branch with no PR; never without one).
export function pushWithToken(cwd, branch, { repo, token, upstream = true, git: g = git, remote = null, lease = null }) {
  const user = remote?.user ?? 'x-access-token';
  const origin = remote?.origin ?? 'https://github.com';
  const header = `AUTHORIZATION: basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // The empty value first clears any other extra header for the host (actions/checkout sets one).
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_1: header,
  };
  const r = g(cwd, ['-c', 'credential.helper=', 'push', ...(lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : []), remote?.url ?? `https://github.com/${repo}.git`, `refs/heads/${branch}:refs/heads/${branch}`], { env });
  const out = { status: r.status, stdout: redact(r.stdout, token), stderr: redact(r.stderr, token) };
  if (out.status === 0 && upstream) {
    g(cwd, ['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
    g(cwd, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
  }
  return out;
}

// Pushes a branch as the bot. Throws when the bot is not configured or the push fails; neither
// message can hold the token (installationToken never puts it in one, and git's output is redacted).
export async function botPush(cwd, branch, config, deps = {}) {
  const host = deps.repo === undefined ? otherHost(config) : null;
  if (host) {
    const bot = resolveTokenBot(host, deps.env ?? process.env, deps.log ?? defaultLog);
    if (!bot) throw new Error(`the pipeline's PR bot is not configured for ${host.type} (run \`${SETUP_CMD}\`)`);
    const r = pushWithToken(cwd, branch, { repo: bot.repo, token: bot.token, upstream: deps.upstream ?? true, git: deps.git, remote: bot.remote });
    if (r.status !== 0) throw new Error(`git push of ${branch} as the bot failed: ${redact(tail(r.stderr, 300), bot.token)}`);
    return r;
  }
  const repo = deps.repo ?? repoOf(config);
  const token = await installationToken(config, { ...deps, repo });
  const r = pushWithToken(cwd, branch, { repo, token, upstream: deps.upstream ?? true, git: deps.git });
  if (r.status !== 0) throw new Error(`git push of ${branch} as the bot failed: ${redact(tail(r.stderr, 300), token)}`);
  return r;
}

// Who publishes the pipeline's PRs: the bot when it is set up, else the developer (today's behavior).
// { bot, env, token, config, repo, push(cwd, branch, { upstream }), host(deps) }: `env` is the full
// environment for gh calls as the GitHub bot, `token` the bot's token on GitLab or Azure DevOps (both
// undefined for the developer); push returns git's { status, stdout, stderr }; host(deps) is the code
// host acting as the publisher.
export async function prPublisher(config, deps = {}) {
  const bot = await resolveBot(config, deps);
  const g = deps.git ?? git;
  const repo = bot?.type ? undefined : bot?.repo;
  const host = (extra = {}) => hostFor(config ?? {}, { ...(repo ? { repo } : {}), ...(bot && !bot.type ? { env: { ...process.env, GH_TOKEN: bot.token } } : {}), ...(bot?.type ? { token: bot.token } : {}), ...extra });
  if (!bot) return { bot: null, env: undefined, token: undefined, config, host, push: (cwd, branch, { upstream = true, lease = null } = {}) => g(cwd, ['push', ...(upstream ? ['-u'] : []), ...(lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : []), 'origin', branch]) };
  (deps.log ?? defaultLog)(`publishing as ${bot.name}`);
  return {
    bot: bot.name,
    env: bot.type ? undefined : { ...process.env, GH_TOKEN: bot.token },
    token: bot.type ? bot.token : undefined,
    config,
    repo,
    host,
    push: (cwd, branch, { upstream = true, lease = null } = {}) => pushWithToken(cwd, branch, { repo: bot.repo, token: bot.token, upstream, git: g, remote: bot.remote ?? null, lease }),
  };
}

// The code host acting as the publisher (a publisher built by hand in a test may lack `host`).
export const publisherHost = (publisher, deps = {}) =>
  publisher.host ? publisher.host(deps) : hostFor(publisher.config ?? { root: deps.cwd }, { ...(publisher.env ? { env: publisher.env } : {}), ...(publisher.token ? { token: publisher.token } : {}), ...deps });

// Pushes a branch and opens its PR as the publisher, through the code host. { url, reason, pushed, env }:
// url is null when the push or the PR creation failed (an already open PR for the branch also fails it;
// the reason then says "already exists"). `run` replaces the gh runner (GitHub).
// The latest base merged into the story branch, then pushed (no pull request): what CI runs before the PR exists
// (implement.preOpen), and the first half of openPullRequest. { pushed, conflict, reason }
export function pushBranch(publisher, { cwd, branch, base }, { mergeBase = mergeLatestBase } = {}) {
  // The latest base first, so the PR is mergeable when it opens (other pipeline PRs may have merged meanwhile).
  const synced = base ? mergeBase(cwd, base) : null;
  if (synced?.conflict) defaultLog(`${branch}: merging ${base} conflicts in ${synced.files.join(', ')}; the PR opens as it is, for a person to resolve`);
  else if (synced?.error) defaultLog(`${branch}: ${synced.error}; the PR opens without the latest ${base}`);
  const push = publisher.push(cwd, branch);
  // The pre-push feature verification hook prints its FAIL lines on stdout, so the reason carries both streams.
  if (push.status !== 0) return { pushed: false, conflict: Boolean(synced?.conflict), reason: `push failed: ${tail(`${push.stderr ?? ''}\n${push.stdout ?? ''}`.trim(), 600)}` };
  return { pushed: true, conflict: Boolean(synced?.conflict) };
}

// The one force push the harness makes: a story branch it folded to drop a fake secret from its history (no PR open),
// with a lease on the sha the remote branch had (`lease` '' : the remote branch must not exist).
export function pushFoldedBranch(publisher, { cwd, branch, lease }) {
  const r = publisher.push(cwd, branch, { lease: lease ?? '' });
  return r.status === 0 ? { pushed: true } : { pushed: false, reason: tail(`${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim(), 400) };
}

// Where a PR's full text and its open attempts are kept (the run records), per branch.
export function prOpenRecords(cwd, branch, stateDir = '.factory/state') {
  const base = path.join(cwd, stateDir, 'pr-open', String(branch).replace(/[^\w.-]+/g, '__'));
  return { body: `${base}.md`, json: `${base}.json`, rel: path.relative(cwd, `${base}.md`) };
}

// The PR opens once. A code host that refuses its text (a content filter, hosts/refusal.mjs) gets the same open again
// with the body reduced step by step in a fixed order (never an agent); the accepted body says what it left out and the
// left-out sections follow as comments. The full body and every attempt are kept in the run records first. Refused even
// with the shortest body: { url: null, refused: true } (the caller keeps the CI-proven head for `implement resume`).
export async function openPullRequest(publisher, { cwd, branch, base, title, body, draft = false, minimalTitle = null }, { run: r, mergeBase = mergeLatestBase } = {}) {
  const pushed = pushBranch(publisher, { cwd, branch, base }, { mergeBase });
  if (!pushed.pushed) return { url: null, pushed: false, env: publisher.env, reason: pushed.reason };
  const host = publisherHost(publisher, { cwd, ...(r ? { run: r } : {}) });
  const records = prOpenRecords(cwd, branch, publisher.config?.stateDir ?? '.factory/state');
  const record = (data) => {
    try {
      fs.mkdirSync(path.dirname(records.json), { recursive: true });
      fs.writeFileSync(records.json, `${JSON.stringify({ branch, title, ...data }, null, 2)}\n`);
    } catch {
      // the records are best effort; the PR is what matters
    }
  };
  const isDraft = Boolean(draft && host.capabilities?.drafts);
  try {
    // The classes the architecture policy derived for projects this branch adds, for the person who approves it.
    const fullBody = withDerivedClasses(body, cwd, base ? `origin/${base.replace(/^origin\//, '')}` : null, { runner: r ?? run });
    try {
      fs.mkdirSync(path.dirname(records.body), { recursive: true });
      fs.writeFileSync(records.body, fullBody);
    } catch {
      // best effort
    }
    const sent = await sendWithReductionAsync((t) => host.pr.open({ head: branch, base, title: t.title, body: t.body, draft: isDraft }), title, fullBody, {
      minimalTitle: minimalTitle ?? (String(title).match(/^[A-Z][A-Z0-9]*-\d+/)?.[0] ?? null),
      note: (s) => omittedNote(s, { recordsPath: records.rel }),
      onAttempt: (a) => a.outcome === 'refused' && defaultLog(`${branch}: the code host refused the PR's text (step ${a.step}${a.dropped.length ? `, without ${a.dropped.join(', ')}` : ''}); trying a shorter body`),
    });
    const pr = sent.result;
    const reduced = sent.step.step > 0 ? { dropped: sent.step.dropped, attempts: sent.attempts } : null;
    let comments = [];
    if (reduced) comments = await postOmitted(sent.step.omitted, (text) => host.pr.comment(pr.number ?? pr.url, text));
    record({ url: pr.url, attempts: sent.attempts, reduced: Boolean(reduced), dropped: sent.step.dropped, titleSent: sent.title, comments });
    return { url: pr.url, pushed: true, env: publisher.env, draft: isDraft, ...(reduced ? { reduced: { ...reduced, comments, records: records.rel } } : {}) };
  } catch (error) {
    const what = host.type === 'github' ? 'gh pr create' : `${host.type} pull request creation`;
    const reason = `${what} failed: ${tail(redact(String(error.message).replace(/^gh pr create( \S+)? failed: /, ''), publisher.token), 300)}`;
    if (error.code === 'refused') {
      record({ url: null, refused: true, attempts: error.attempts ?? [], reason });
      return { url: null, pushed: true, env: publisher.env, refused: true, attempts: error.attempts ?? [], records: records.rel, reason: `the code host refused the PR's text even with the shortest body (${(error.attempts ?? []).length} attempt(s); a content filter, or a refusal that is not about the text): ${reason}` };
    }
    return { url: null, pushed: true, env: publisher.env, reason };
  }
}

// `node bot.mjs env <root>`: prints botEnv as JSON (for botEnvSync; stdout is read by the parent only).
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && process.argv[2] === 'env') {
  const { loadConfig } = await import('./config.mjs');
  process.stdout.write(JSON.stringify(await botEnv(loadConfig(null, process.argv[3] ?? process.cwd()))));
}
