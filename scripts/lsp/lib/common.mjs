// Shared helpers for the per-worktree language-server daemon (lspd): config, paths, sockets and the machine-wide
// lease that caps how many heavy ("leased") language servers run at once.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_ROOT, toolConfig } from '../../pipeline/lib/config.mjs';

export { INSTALL_ROOT };
export const LSP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Name of everything this tooling shares machine-wide (runtime dir, named pipes, MCP server name).
export const RUNTIME_NAME = 'ai-app-factory-lsp';

// Servers are merged by id: an entry in the app repo's `lsp.servers` overrides the fields it names of the
// engine default with the same id, any other id is added, and `"disabled": true` removes a server.
export function mergeServers(defaults = [], overrides = []) {
  const byId = new Map(defaults.map((s) => [s.id, s]));
  for (const s of overrides) byId.set(s.id, { ...byId.get(s.id), ...s });
  return [...byId.values()].filter((s) => !s.disabled);
}

const SERVER_FIELDS = ['id', 'extensions', 'languageIds', 'command'];

// Engine defaults (config.json beside this tooling: language-neutral servers only) merged with the `lsp`
// section of <root>/.factory/config.json. `root` is the checkout the daemon serves.
export function loadConfig(root = worktreeOf(process.cwd())) {
  const { servers: defaults = [], ...rest } = JSON.parse(fs.readFileSync(path.join(LSP_DIR, 'config.json'), 'utf8'));
  const config = toolConfig('lsp', rest, root);
  config.servers = mergeServers(defaults, config.servers ?? []);
  for (const s of config.servers) {
    const missing = SERVER_FIELDS.filter((f) => s[f] === undefined);
    if (missing.length) throw new Error(`lsp.servers: server "${s.id ?? '?'}" has no ${missing.join(', ')} (.factory/config.json)`);
    s.extensions = s.extensions.map((e) => e.toLowerCase());
    s.args ??= [];
  }
  const max = Number.parseInt(process.env.LSP_MAX_SERVERS ?? '', 10);
  if (Number.isInteger(max) && max >= 0) config.maxLanguageServers = max;
  const idle = Number.parseInt(process.env.LSP_IDLE_SEC ?? '', 10);
  if (Number.isInteger(idle) && idle > 0) config.idleSec = idle;
  return config;
}

// True when an lsp_goto_definition answer points into a file other than `file`: a probe symbol is defined in
// another file, so an answer inside the probe file (the import binding) means the server has not loaded
// the project yet.
export function definitionElsewhere(text, file) {
  try {
    const data = JSON.parse(text);
    const list = data.definitions ?? data.locations ?? (Array.isArray(data) ? data : []);
    return list.some((d) => d?.path && path.resolve(d.path) !== path.resolve(file));
  } catch {
    return false;
  }
}

export const serverForFile = (config, file) => {
  const ext = path.extname(file).toLowerCase();
  return config.servers.find((s) => s.extensions.includes(ext)) ?? null;
};

// Runtime files shared by every checkout on the machine. Kept short: macOS caps unix socket paths at 104 bytes.
// The leases under it are shared by every project on the machine on purpose: memory is machine-wide.
export const runtimeDir = () => process.env.LSP_RUNTIME_DIR ?? path.join(os.tmpdir(), RUNTIME_NAME);
export const leaseDir = () => path.join(runtimeDir(), 'leases');

const isWindows = process.platform === 'win32';

export const realWorktree = (worktree) => fs.realpathSync(path.resolve(worktree));
export const worktreeHash = (worktree) => createHash('sha256').update(realWorktree(worktree)).digest('hex').slice(0, 12);

// Windows has no unix domain sockets: Node serves IPC on named pipes there. A pipe is not a file
// and disappears with its server, so it is named after the runtime dir (keeping LSP_RUNTIME_DIR
// isolation) and never chmod-ed or deleted.
const socketPath = (dir, hash) =>
  isWindows
    ? `\\\\.\\pipe\\${RUNTIME_NAME}-${createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8)}-${hash}`
    : path.join(dir, `${hash}.sock`);

export const removeSocket = (socket) => {
  if (!isWindows) fs.rmSync(socket, { force: true });
};

export const protectSocket = (socket) => {
  if (!isWindows) fs.chmodSync(socket, 0o600);
};

export function daemonPaths(worktree) {
  const hash = worktreeHash(worktree);
  const dir = runtimeDir();
  return {
    hash,
    dir,
    socket: socketPath(dir, hash),
    pidFile: path.join(dir, `${hash}.json`),
    lockFile: path.join(dir, `${hash}.lock`),
  };
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

// The checkout that owns `dir` (a worktree's own root, never the main checkout's).
export const worktreeOf = (dir = process.cwd()) => git(dir, ['rev-parse', '--show-toplevel']);

// Per-checkout state (logs, call log, server load states) lives in the checkout's git dir, outside the working tree:
// <main>/.git/lsp for the main checkout, <main>/.git/worktrees/<name>/lsp for a linked worktree.
export function stateDir(worktree) {
  const gitDir = path.resolve(worktree, git(worktree, ['rev-parse', '--git-dir']));
  const dir = path.join(gitDir, 'lsp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The main checkout, where node_modules usually lives when a fresh worktree has none.
export function mainCheckout(worktree) {
  try {
    return path.resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']), '..');
  } catch {
    return worktree;
  }
}

// Where node packages are looked up: the app checkout, its main checkout (a fresh worktree has no
// node_modules), then the engine's own install.
const moduleRoots = (worktree) => [...new Set([worktree, mainCheckout(worktree), INSTALL_ROOT])];

export function resolveNodeModule(worktree, rel) {
  for (const root of moduleRoots(worktree)) {
    const file = path.join(root, 'node_modules', rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The MCP-to-LSP bridge the daemon runs. LSP_MCP_SERVER names its entry file directly (tests, custom installs).
export const resolveBridge = (worktree) => process.env.LSP_MCP_SERVER || resolveNodeModule(worktree, 'lsp-mcp-server/dist/index.js');

// ${worktree}, ${factory} (the engine's install root) and ${stateDir} in a configured command, argument or
// environment value. A leading `pack:<id>/...` is a file of a language pack (<install root>/packs/<id>/...).
export const expand = (text, vars) =>
  String(text)
    .replace(/^pack:/, () => `${vars.factory ?? ''}/packs/`)
    .replace(/\$\{(worktree|factory|stateDir)\}/g, (_, name) => vars[name] ?? '');

export function onPath(command, env = process.env) {
  const exts = isWindows ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, command + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// Turns a configured command into what to spawn: `node` is this node, a bare name is looked up in
// node_modules/.bin (app checkout, main checkout, engine) and otherwise left to PATH, a relative path is
// relative to the checkout. `found` says whether the binary exists.
export function resolveCommand(worktree, command, args = []) {
  if (command === 'node') return { command: process.execPath, args, found: true, source: 'node' };
  if (/[/\\]/.test(command)) {
    const file = path.resolve(worktree, command);
    return { command: file, args, found: fs.existsSync(file), source: 'path' };
  }
  for (const root of moduleRoots(worktree)) {
    const bin = path.join(root, 'node_modules', '.bin', command);
    // npm writes <name>.cmd shims on Windows; they only run through cmd.exe.
    if (isWindows && fs.existsSync(`${bin}.cmd`)) return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `${bin}.cmd`, ...args], found: true, source: `${bin}.cmd` };
    if (!isWindows && fs.existsSync(bin)) return { command: bin, args, found: true, source: bin };
  }
  const file = onPath(command);
  return { command: file ?? command, args, found: Boolean(file), source: file ?? 'PATH' };
}

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------
// Machine-wide lease: one file per slot, created with O_EXCL. A slot whose holder pid is dead is reclaimed by
// renaming it away first, so two processes recovering the same stale slot cannot both win.
// ---------------------------------------------------------------------------------------------------------------

// `owner` is the checkout, `server` the leased server's id: one checkout holds a slot per leased server.
// `runPid`: the pipeline run that asked for the server (PIPELINE_RUN_PID). A slot whose daemon is alive but whose
// run died is an orphan of a crash: the daemon is stopped and the slot reclaimed (dogfood C2: after a crash the
// dead run's daemons kept both slots and a resumed story ran without C#).
// A slot whose checkout no longer exists is an orphan too, whoever started it (dogfood C4: the retro removed its
// worktree and the C# daemon it had started kept a slot, with no run pid to tell it was orphaned).
export function reapOrphan(holder, { kill = process.kill.bind(process), alive = pidAlive, exists = fs.existsSync } = {}) {
  // Never this process's own lease.
  if (!holder?.pid || holder.pid === process.pid || !alive(holder.pid)) return false;
  const runDied = Boolean(holder.runPid) && !alive(holder.runPid);
  const ownerGone = Boolean(holder.owner) && !exists(holder.owner);
  if (!runDied && !ownerGone) return false;
  try {
    kill(holder.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  return true;
}

export function acquireLease({ owner, server = null, pid = process.pid, max, dir = leaseDir(), runPid = Number(process.env.PIPELINE_RUN_PID) || null, reap = reapOrphan }) {
  fs.mkdirSync(dir, { recursive: true });
  for (let slot = 0; slot < max; slot++) {
    const file = path.join(dir, `slot-${slot}.json`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ slot, pid, owner, server, runPid, since: new Date().toISOString() }));
        fs.closeSync(fd);
        return { ok: true, slot, file };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const holder = readJson(file);
      if (holder && holder.pid === pid && holder.owner === owner && (holder.server ?? null) === server) return { ok: true, slot, file };
      // A file being written right now has no JSON yet; only reclaim when the pid is known to be dead, or when its
      // run died (an orphaned daemon, stopped here).
      if (!holder || (pidAlive(holder.pid) && !reap(holder))) break;
      const grave = `${file}.stale.${process.pid}.${Date.now()}`;
      try {
        fs.renameSync(file, grave);
        fs.rmSync(grave, { force: true });
      } catch {
        break; // someone else reclaimed it first
      }
    }
  }
  const holders = listLeases(dir).map((l) => (l.server ? `${l.owner} (${l.server})` : l.owner));
  return { ok: false, reason: `all ${max} leased language server slots are in use (${holders.join(', ') || 'none readable'})` };
}

export function releaseLease(lease) {
  if (!lease?.ok) return;
  const holder = readJson(lease.file);
  if (holder && holder.pid === process.pid) fs.rmSync(lease.file, { force: true });
}

export function listLeases(dir = leaseDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^slot-\d+\.json$/.test(f))
    .map((f) => ({ file: path.join(dir, f), ...(readJson(path.join(dir, f)) ?? {}) }))
    .map((l) => ({ ...l, alive: pidAlive(l.pid) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Socket client: one JSON header line, then either a JSON reply (control) or an MCP stream.
// ---------------------------------------------------------------------------------------------------------------

export function connect(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    conn.once('connect', () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function control(socket, header, timeoutMs = 5000) {
  const conn = await connect(socket, Math.min(timeoutMs, 2000));
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`no answer from lspd within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        conn.end();
        try {
          resolve(JSON.parse(buffer.slice(0, nl)));
        } catch (error) {
          reject(error);
        }
      }
    });
    conn.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conn.write(`${JSON.stringify(header)}\n`);
  });
}

// True when the module at `metaUrl` is the script node was started with.
export const isMain = (metaUrl) => {
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};
