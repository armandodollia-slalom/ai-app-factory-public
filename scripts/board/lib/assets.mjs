// Ticket assets (mockups, images, attachments, spilled sources) live on the orphan branch
// `board-assets` (config.tickets.assetsBranch), under mockups/<KEY>/... and files/<KEY>/....
// Commits are built with git plumbing (hash-object, a temporary index, write-tree, commit-tree), so
// the user's branch and working tree are never touched. Only `board migrate --apply` pushes the branch.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './ticket-format.mjs';
import { describeCall, externalKind, externalRetries, externalRetryPauseMs, externalTimeoutSec, noteExternal, retrySafe, transientFailure } from '../../pipeline/lib/external.mjs';

// Runs a command; `binary` returns stdout as a Buffer. Same shape as util.run: { status, stdout, stderr }. gh and git
// follow the external-call rule (pipeline/lib/external.mjs): a timeout, and retries when a repeat is safe.
export function exec(cmd, args, { cwd, input, env, binary = false } = {}) {
  const kind = externalKind(cmd, args);
  const limit = externalTimeoutSec(kind, env ?? process.env);
  const tries = kind && retrySafe(cmd, args) ? 1 + externalRetries(env ?? process.env) : 1;
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(cmd, args, { cwd, input, env: env ?? process.env, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true, ...(limit ? { timeout: limit * 1000, killSignal: 'SIGKILL' } : {}) });
    const out = {
      status: r.status ?? (r.error ? 127 : 1),
      stdout: r.stdout ?? (binary ? Buffer.alloc(0) : ''),
      stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`,
      timedOut: r.error?.code === 'ETIMEDOUT',
    };
    if (!kind || !transientFailure(out)) return out;
    const what = out.timedOut ? `timed out after ${limit} s` : String(out.stderr).trim().split('\n').pop().slice(0, 200);
    if (attempt >= tries) {
      noteExternal({ call: describeCall(cmd, args), event: `gave up after ${attempt} attempt(s)`, detail: what, attempts: attempt, timedOut: out.timedOut });
      return { ...out, stderr: `${out.stderr}\n${describeCall(cmd, args)}: ${what}`, attempts: attempt };
    }
    noteExternal({ call: describeCall(cmd, args), event: `attempt ${attempt} of ${tries} ${out.timedOut ? 'timed out' : 'failed'}, retrying`, detail: what, attempt });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, externalRetryPauseMs(attempt));
  }
}

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr).trim().slice(0, 500)}`);
  return typeof r.stdout === 'string' ? r.stdout.trim() : r.stdout;
};

export const assetsRef = (config) => `refs/heads/${config.tickets.assetsBranch}`;
export const remoteAssetsRef = (config) => `refs/remotes/origin/${config.tickets.assetsBranch}`;

function revParse(root, rev, run = exec) {
  const r = run('git', ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { cwd: root });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The current asset commit: the local branch, else the remote-tracking one.
export function currentAssetsCommit(config, { run = exec } = {}) {
  return revParse(config.root, assetsRef(config), run) ?? revParse(config.root, remoteAssetsRef(config), run);
}

// Fetches the assets branch from origin (best effort; returns false offline).
export function fetchAssetsBranch(config, { run = exec } = {}) {
  const b = config.tickets.assetsBranch;
  return run('git', ['fetch', '-q', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`], { cwd: config.root }).status === 0;
}

// Lists the files (path -> blob id) in an asset commit.
export function listAssetTree(config, commit, { run = exec } = {}) {
  if (!commit) return new Map();
  const out = must(run('git', ['ls-tree', '-r', '-z', commit], { cwd: config.root }), 'git ls-tree');
  const files = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const [info, p] = entry.split('\t');
    files.set(p, info.split(' ')[2]);
  }
  return files;
}

// Builds (without checking anything out) a commit on the assets branch that contains `files`
// ([{ path, abs | data }]) on top of the current tree. Returns { commit, changed, parent }.
// With `write: false` it only reports whether anything would change.
export function buildAssetsCommit(config, files, { message = 'Update board assets', write = true, run = exec } = {}) {
  const root = config.root;
  const parent = currentAssetsCommit(config, { run });
  const existing = listAssetTree(config, parent, { run });
  const blobs = files.map((f) => {
    const args = ['hash-object', ...(write ? ['-w'] : []), '--stdin'];
    const data = f.data ?? fs.readFileSync(f.abs);
    return { path: f.path, blob: must(run('git', args, { cwd: root, input: data }), 'git hash-object') };
  });
  const changes = blobs.filter((b) => existing.get(b.path) !== b.blob);
  if (!changes.length) return { commit: parent, parent, changed: false, changes: [] };
  if (!write) return { commit: null, parent, changed: true, changes: changes.map((c) => c.path) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-assets-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    if (parent) must(run('git', ['read-tree', parent], { cwd: root, env }), 'git read-tree');
    else must(run('git', ['read-tree', '--empty'], { cwd: root, env }), 'git read-tree --empty');
    const info = changes.map((c) => `100644 ${c.blob}\t${c.path}`).join('\n');
    must(run('git', ['update-index', '--add', '--index-info'], { cwd: root, env, input: `${info}\n` }), 'git update-index');
    const tree = must(run('git', ['write-tree'], { cwd: root, env }), 'git write-tree');
    const commitEnv = { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'board-assets', GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'board-assets@localhost', GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'board-assets', GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'board-assets@localhost' };
    const commit = must(run('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { cwd: root, env: commitEnv }), 'git commit-tree');
    must(run('git', ['update-ref', assetsRef(config), commit, ...(parent && revParse(root, assetsRef(config), run) ? [parent] : [])], { cwd: root }), 'git update-ref');
    return { commit, parent, changed: true, changes: changes.map((c) => c.path) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function pushAssetsBranch(config, { run = exec } = {}) {
  const b = config.tickets.assetsBranch;
  must(run('git', ['push', '-q', 'origin', `${assetsRef(config)}:refs/heads/${b}`], { cwd: config.root }), `git push origin ${b}`);
}

// Reads one asset at a pinned commit as a Buffer: the local object store first (fetching the branch
// once if the commit is missing), then the code host's API (`fallback(assetPath, commit)`, which the tracker that
// stores its assets on a branch passes). Throws when it cannot be read.
export function readAsset(config, commit, assetPath, { run = exec, fallback = null } = {}) {
  const show = () => run('git', ['cat-file', 'blob', `${commit}:${assetPath}`], { cwd: config.root, binary: true });
  let r = show();
  if (r.status !== 0 && run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: config.root }).status !== 0) {
    fetchAssetsBranch(config, { run });
    r = show();
  }
  if (r.status === 0) return r.stdout;
  const viaApi = !fallback ? { status: 1, stderr: 'no API fallback for this tracker' } : fallback(assetPath, commit);
  if (viaApi.status === 0) return Buffer.isBuffer(viaApi.stdout) ? viaApi.stdout : Buffer.from(viaApi.stdout);
  throw new Error(`asset ${assetPath}@${String(commit).slice(0, 10)} is not available (git: ${String(r.stderr).trim().slice(0, 200)}; API: ${String(viaApi.stderr).trim().slice(0, 200)})`);
}

// Downloads a manifest's files into `dir` (by each file's `name`), verifying every sha256. Files already
// present with the right hash are kept. Returns the number written.
export function downloadAssets(config, assets, dir, { run = exec, fallback = null, filter = () => true } = {}) {
  let written = 0;
  for (const f of (assets?.files ?? []).filter(filter)) {
    const target = path.join(dir, f.name);
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === f.sha256) continue;
    const data = readAsset(config, assets.commit, f.path, { run, fallback });
    const got = sha256(data);
    if (got !== f.sha256) throw new Error(`asset ${f.path} has sha256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written++;
  }
  return written;
}
