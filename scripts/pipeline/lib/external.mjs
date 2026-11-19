// Every call the pipeline makes to something outside this machine's own files (the GitHub CLI, git's network
// commands, Docker, HTTP) runs with a timeout and, when repeating it is safe, bounded retries. A hung call ends as a
// retry and then as a failed call with its cause, never as a hang (council C12: a `gh pr checks` call whose connection
// had closed blocked a run for 1h45m).
//
// Timeouts (seconds) per kind; FACTORY_EXTERNAL_TIMEOUT_<KIND> overrides one (GH, GIT_NETWORK, GIT, DOCKER,
// DOCKER_LONG, HTTP), FACTORY_EXTERNAL_RETRIES the number of retries.
export const EXTERNAL_TIMEOUTS = { gh: 120, 'git-network': 1800, git: 900, docker: 120, 'docker-long': 3600, http: 60 };
export const EXTERNAL_RETRIES = 2;

const GIT_NETWORK = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);
// Local git commands that only read: bounded (a stalled process ends) and repeated after a timeout. Local writes (commit,
// merge, checkout, worktree add, ...) are not external calls and are never killed or repeated: a killed merge leaves
// MERGE_HEAD behind (seen on a loaded machine whose local git calls stalled for minutes).
const GIT_READ = new Set(['rev-parse', 'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'cat-file', 'merge-base', 'for-each-ref', 'show-ref', 'rev-list', 'describe', 'blame', 'grep', 'check-ignore', 'name-rev', 'symbolic-ref', 'var', 'count-objects', 'shortlog']);
// Docker commands that build, pull or wait for a stack: long, but still bounded.
const DOCKER_LONG = /^(build|pull|push|compose|buildx|image\s+(build|pull|push)|run|exec|wait|load|save)\b/;

const base = (cmd) => String(cmd ?? '').split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, '');

// The kind of an external command, or null for a local one.
export function externalKind(cmd, args = []) {
  const name = base(cmd);
  const a = args.map(String);
  if (name === 'gh') return 'gh';
  if (name === 'git') {
    const sub = a.find((x, i) => !x.startsWith('-') && !(i > 0 && ['-C', '-c', '--git-dir', '--work-tree'].includes(a[i - 1])));
    if (GIT_NETWORK.has(sub) || (sub === 'submodule' && a.includes('update')) || (sub === 'remote' && a.includes('update'))) return 'git-network';
    const rest = a.slice(a.indexOf(sub) + 1);
    const reads = GIT_READ.has(sub) || (sub === 'config' && rest.some((x) => /^--(get|list|get-all|get-regexp)$/.test(x))) || (sub === 'remote' && rest[0] === 'get-url') || (sub === 'worktree' && rest[0] === 'list') || (sub === 'branch' && (rest.includes('--list') || rest.includes('--show-current') || rest.length === 0)) || (sub === 'hash-object' && !rest.includes('-w')) || (sub === 'stash' && rest[0] === 'list');
    return reads ? 'git' : null;
  }
  if (name === 'docker' || name === 'podman') {
    const rest = a.join(' ');
    return DOCKER_LONG.test(rest) ? 'docker-long' : 'docker';
  }
  if (name === 'curl' || name === 'wget') return 'http';
  return null;
}

export function externalTimeoutSec(kind, env = process.env) {
  if (!kind) return undefined;
  const v = Number(env[`FACTORY_EXTERNAL_TIMEOUT_${kind.toUpperCase().replace(/-/g, '_')}`]);
  return Number.isFinite(v) && v > 0 ? v : EXTERNAL_TIMEOUTS[kind];
}

export const externalRetries = (env = process.env) => {
  const v = Number(env.FACTORY_EXTERNAL_RETRIES);
  return Number.isInteger(v) && v >= 0 ? v : EXTERNAL_RETRIES;
};

// gh subcommands that only read (or set something to a value, so a repeat changes nothing). A comment, a PR or an
// issue created twice is not safe, so those are never repeated: their timeout is a failure the caller sees.
const GH_READ = [
  /^(pr|issue|run|release|repo|label|project|workflow|secret|variable|cache|ruleset) (view|list|status|checks|diff|download)\b/,
  /^(auth|api-check) status\b/,
  /^(pr|issue) edit\b/,
  /^(pr|issue) (close|reopen|ready)\b/,
  /^--version\b/,
];

// Whether repeating the call after a timeout or a network error is safe.
export function retrySafe(cmd, args = []) {
  const kind = externalKind(cmd, args);
  const a = args.map(String);
  if (kind === 'gh') {
    if (a[0] === 'api') {
      // A plain `gh api` is a GET unless it sends fields or names another method; GraphQL reads are queries.
      const at = a.findIndex((x) => x === '-X' || x === '--method');
      const method = at >= 0 ? a[at + 1] : null;
      const fields = a.some((x) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(x));
      if (a[1] === 'graphql') return !a.some((x) => /^query=\s*mutation\b/.test(x));
      return method ? /^(GET|HEAD)$/i.test(method) : !fields;
    }
    return GH_READ.some((re) => re.test(a.join(' ')));
  }
  if (kind === 'git-network') return true; // fetch/ls-remote read; a push of the same ref again is a no-op
  if (kind === 'git') return true; // a local read
  if (kind === 'docker') return true; // inspect, info, ps, ls: reads
  if (kind === 'http') return true;
  return false;
}

// A failure worth another try: a timeout, or a network error the server or the connection gave.
export const transientFailure = (r) =>
  Boolean(r?.timedOut) ||
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|i\/o timeout|TLS handshake timeout|connection (reset|refused|closed)|unexpected EOF|Could not resolve host|Failed to connect|HTTP 50[234]|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|error connecting to api\.github\.com|stream error|was aborted)\b/i.test(String(r?.stderr ?? ''));

// One line for a log or a result: what the call was and why it failed.
export const describeCall = (cmd, args = []) => [base(cmd), ...args.map(String).filter((a) => a.length < 60).slice(0, 4)].join(' ');

// Process-wide record of external calls that timed out or needed a retry, for the run log and the run's metrics.
// The implement and PR check runners point FACTORY_EXTERNAL_LOG at their run-conditions stream.
export function noteExternal(record, { env = process.env, append } = {}) {
  process.stderr.write(`[external] ${record.call}: ${record.event}${record.detail ? ` (${record.detail})` : ''}\n`);
  const file = env.FACTORY_EXTERNAL_LOG;
  if (!file || !append) return;
  try {
    append(file, [{ ts: new Date().toISOString(), kind: 'external-call', ...(env.FACTORY_EXTERNAL_STORY ? { story: env.FACTORY_EXTERNAL_STORY } : {}), ...record }]);
  } catch {
    // the record is informational
  }
}

// fetch() with a timeout and, for a GET or HEAD, bounded retries on a timeout, a network error or a 502/503/504.
export async function fetchWithTimeout(url, options = {}, { timeoutSec = externalTimeoutSec('http'), retries = externalRetries(), pause = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl = globalThis.fetch } = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const safe = method === 'GET' || method === 'HEAD';
  let lastError;
  for (let attempt = 0; ; attempt++) {
    // A controller and a timer this frame holds, not AbortSignal.timeout(): that signal can be garbage-collected while
    // the request is pending, and then it never fires (the full test suite hung 29 minutes on one such request).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`timed out after ${timeoutSec} s`), { name: 'TimeoutError' })), timeoutSec * 1000);
    try {
      const res = await fetchImpl(url, { ...options, signal: controller.signal });
      // The body is read under the same limit; the timer no longer keeps the process alive once the answer came.
      timer.unref?.();
      if (safe && [502, 503, 504].includes(res.status) && attempt < retries) {
        clearTimeout(timer);
        noteExternal({ call: `${method} ${String(url).split('?')[0]}`, event: `HTTP ${res.status}, retrying`, attempt: attempt + 1 });
        await pause(2000 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (!safe || attempt >= retries) {
        const e = new Error(`${method} ${String(url).split('?')[0]} ${timedOut ? `timed out after ${timeoutSec} s` : `failed: ${error.message}`}${attempt ? ` (${attempt + 1} attempts)` : ''}`);
        e.timedOut = timedOut;
        e.cause = error;
        throw e;
      }
      noteExternal({ call: `${method} ${String(url).split('?')[0]}`, event: timedOut ? `timed out after ${timeoutSec} s, retrying` : `failed (${error.message}), retrying`, attempt: attempt + 1 });
      await pause(2000 * 2 ** attempt);
    }
  }
  // eslint-disable-next-line no-unreachable
  throw lastError;
}
