#!/usr/bin/env node
// lspd: per-checkout language-server daemon (see docs/code-intelligence.md). `factory lsp lspd <command>`.
//
//   lspd.mjs start --worktree <path> [--owns <glob>...]
//       -> {"ok":true,"pid":n,"socket":"...","leased":"none|running|unavailable","reason":...,
//           "servers":{"<id>":{"status":"running|unavailable","state":...,"reason":...,"leaseSlot":n}}}  (idempotent)
//       --owns narrows servers that have a `scope` module to the part of the checkout owning those globs.
//   lspd.mjs stop --worktree <path>
//   lspd.mjs status [--worktree <path>]
//   lspd.mjs stop-all
//   lspd.mjs diagnostics --worktree <path> --files <f1> [<f2>...] [--no-start]
//       -> {"ok":true,"files":{"<f>":[{severity,line,col,code,message}] | {"unavailable":"<reason>"}}}
// --worktree defaults to the checkout containing the current directory. Every command prints one JSON line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  control,
  daemonPaths,
  isMain,
  leaseDir,
  listLeases,
  loadConfig,
  pidAlive,
  readJson,
  reapOrphan,
  realWorktree,
  removeSocket,
  runtimeDir,
  stateDir,
  worktreeOf,
} from './lib/common.mjs';

const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function daemonStatus(worktree, timeoutMs = 3000) {
  const paths = daemonPaths(worktree);
  try {
    return await control(paths.socket, { lspd: 'status' }, timeoutMs);
  } catch {
    return null;
  }
}

// Removes the socket/pid files of a daemon that is gone.
function clearStale(paths) {
  const info = readJson(paths.pidFile);
  if (info && pidAlive(info.pid)) return false;
  removeSocket(paths.socket);
  fs.rmSync(paths.pidFile, { force: true });
  return true;
}

function takeLock(file) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    if (Number.isInteger(holder) && !pidAlive(holder)) {
      fs.rmSync(file, { force: true });
      return takeLock(file);
    }
    return false;
  }
}

// Starts the daemon for `worktree` unless one is already answering. Returns its status.
export async function ensureDaemon(worktree, { owns = [], waitMs = 30000 } = {}) {
  worktree = realWorktree(worktree);
  const paths = daemonPaths(worktree);
  fs.mkdirSync(paths.dir, { recursive: true });
  const existing = await daemonStatus(worktree);
  if (existing) return existing;

  const deadline = Date.now() + waitMs;
  while (!takeLock(paths.lockFile)) {
    // Another process is starting it; wait for it to answer.
    const st = await daemonStatus(worktree, 1000);
    if (st) return st;
    if (Date.now() > deadline) throw new Error('timed out waiting for another lspd start');
    await sleep(200);
  }
  try {
    const again = await daemonStatus(worktree, 1000);
    if (again) return again;
    clearStale(paths);
    const log = fs.openSync(path.join(stateDir(worktree), 'lspd.log'), 'a');
    const args = [SELF, 'serve', '--worktree', worktree];
    if (owns?.length) args.push('--owns', ...owns);
    const child = spawn(process.execPath, args, { cwd: worktree, detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true });
    child.unref();
    fs.closeSync(log);
    while (Date.now() < deadline) {
      await sleep(200);
      const st = await daemonStatus(worktree, 1000);
      if (st) return st;
      if (child.exitCode !== null) break;
    }
    const tail = fs.readFileSync(path.join(stateDir(worktree), 'lspd.log'), 'utf8').split('\n').slice(-6).join('\n');
    throw new Error(`lspd did not start for ${worktree}: ${tail.trim()}`);
  } finally {
    fs.rmSync(paths.lockFile, { force: true });
  }
}

export async function stopDaemon(worktree) {
  const paths = daemonPaths(worktree);
  const info = readJson(paths.pidFile);
  try {
    const res = await control(paths.socket, { lspd: 'stop' }, 5000);
    for (let i = 0; i < 50 && pidAlive(res.pid); i++) await sleep(100);
    return { ok: true, worktree, stopped: true, pid: res.pid };
  } catch {
    if (info && pidAlive(info.pid)) {
      process.kill(info.pid, 'SIGTERM');
      return { ok: true, worktree, stopped: true, pid: info.pid, forced: true };
    }
    clearStale(paths);
    return { ok: true, worktree, stopped: false, running: false };
  }
}

function knownDaemons() {
  const dir = runtimeDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[0-9a-f]{12}\.json$/.test(f))
    .map((f) => {
      const info = readJson(path.join(dir, f));
      return info && { ...info, pidFile: path.join(dir, f) };
    })
    .filter(Boolean);
}

export async function allStatus() {
  const daemons = [];
  for (const info of knownDaemons()) {
    const st = fs.existsSync(info.worktree) ? await daemonStatus(info.worktree, 2000) : null;
    if (st) daemons.push(st);
    else {
      if (fs.existsSync(info.worktree)) clearStale(daemonPaths(info.worktree));
      else if (!pidAlive(info.pid)) {
        removeSocket(info.socket);
        fs.rmSync(info.pidFile, { force: true });
      }
    }
  }
  let config;
  try {
    config = loadConfig();
  } catch {
    config = {}; // not inside a checkout: the cap is that checkout's own setting
  }
  return { ok: true, daemons, leases: listLeases(leaseDir()), maxLanguageServers: config.maxLanguageServers ?? null };
}

function parseArgs(argv) {
  const opts = { cmd: argv[0], files: [], owns: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worktree') opts.worktree = argv[++i];
    else if (a === '--owns') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.owns.push(argv[++i]);
    }
    else if (a === '--no-start') opts.noStart = true;
    else if (a === '--run') opts.run = argv[++i];
    else if (a === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.files.push(argv[++i]);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const worktree = () => realWorktree(opts.worktree ?? worktreeOf(process.cwd()));
  switch (opts.cmd) {
    case 'serve': {
      const { serve } = await import('./lib/daemon.mjs');
      await serve({ worktree: worktree(), owns: opts.owns });
      return undefined;
    }
    case 'start': {
      const st = await ensureDaemon(worktree(), { owns: opts.owns });
      return { ok: true, pid: st.pid, socket: st.socket, leased: st.leased, reason: st.reason, servers: st.servers, stateDir: st.stateDir };
    }
    case 'stop':
      return stopDaemon(worktree());
    case 'status':
      if (opts.worktree) return (await daemonStatus(worktree())) ?? { ok: true, running: false, worktree: worktree() };
      return allStatus();
    case 'orphans': {
      // Daemons whose run died, or whose worktree is gone: stopped, and their leases freed.
      const stopped = [];
      for (const l of listLeases(leaseDir())) {
        const holder = readJson(l.file);
        if (holder && (reapOrphan(holder) || (holder.owner && !fs.existsSync(holder.owner) && pidAlive(holder.pid) && (process.kill(holder.pid, 'SIGTERM'), true)))) stopped.push({ worktree: holder.owner, pid: holder.pid });
      }
      for (const info of knownDaemons()) if (!fs.existsSync(info.worktree) && pidAlive(info.pid)) (process.kill(info.pid, 'SIGTERM'), stopped.push({ worktree: info.worktree, pid: info.pid }));
      return { ok: true, stopped };
    }
    case 'stop-run': {
      // Every daemon leased under a pipeline run (its lease's runPid): stopped when the run ends, whatever its
      // outcome (dogfood C5: a finished epic's daemon held the only slot and the next run started without C#).
      // With --worktree, only that checkout's daemon (the epic planner's, when planning ends).
      const run = Number(opts.run);
      const only = opts.worktree ? path.resolve(opts.worktree) : null;
      const stopped = [];
      for (const l of listLeases(leaseDir())) {
        const holder = readJson(l.file);
        if (!holder || Number(holder.runPid) !== run) continue;
        if (only && holder.owner && path.resolve(holder.owner) !== only) continue;
        if (holder.owner && fs.existsSync(holder.owner)) stopped.push(await stopDaemon(holder.owner));
        else if (pidAlive(holder.pid)) (process.kill(holder.pid, 'SIGTERM'), stopped.push({ worktree: holder.owner, pid: holder.pid }));
        fs.rmSync(l.file, { force: true });
      }
      return { ok: true, stopped };
    }
    case 'stop-all': {
      const stopped = [];
      for (const info of knownDaemons()) {
        if (fs.existsSync(info.worktree)) stopped.push(await stopDaemon(info.worktree));
        else if (pidAlive(info.pid)) process.kill(info.pid, 'SIGTERM');
      }
      for (const l of listLeases(leaseDir())) if (!l.alive) fs.rmSync(l.file, { force: true });
      return { ok: true, stopped };
    }
    case 'diagnostics': {
      if (!opts.files.length) throw new Error('--files is required');
      const wt = worktree();
      const config = loadConfig(wt);
      const st = opts.noStart ? await daemonStatus(wt) : await ensureDaemon(wt);
      if (!st) return { ok: true, files: Object.fromEntries(opts.files.map((f) => [f, { unavailable: 'lspd is not running' }])) };
      const timeoutMs = ((config.diagnosticsTimeoutSec) * opts.files.length + 10) * 1000;
      // Relative paths are relative to --worktree when given, else to the current directory.
      const abs = opts.files.map((f) => path.resolve(opts.worktree ? wt : process.cwd(), f));
      const res = await control(daemonPaths(wt).socket, { lspd: 'diagnostics', files: abs }, timeoutMs);
      // Key the answer by the paths as the caller wrote them.
      if (res.files) res.files = Object.fromEntries(opts.files.map((f, i) => [f, res.files[abs[i]]]));
      return res;
    }
    default:
      throw new Error('usage: lspd.mjs start|stop|status|stop-all|stop-run --run <pid>|orphans|diagnostics [--worktree <path>] [--owns <glob>...] [--files ...]');
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (result) => {
      if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      process.exit(1);
    },
  );
}
