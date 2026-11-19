// lspd: one daemon per checkout. It runs lsp-mcp-server as a child (which starts the language servers lazily and
// stops idle ones), serves any number of MCP sessions and control requests over a unix socket, and holds the
// machine-wide leases for the checkout's heavy ("leased") servers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureToolPath } from '../../pipeline/lib/config.mjs';
import {
  definitionElsewhere,
  INSTALL_ROOT,
  LSP_DIR,
  RUNTIME_NAME,
  acquireLease,
  connect,
  daemonPaths,
  expand,
  loadConfig,
  protectSocket,
  readJson,
  releaseLease,
  removeSocket,
  resolveBridge,
  resolveCommand,
  serverForFile,
  stateDir,
  writeJsonAtomic,
} from './common.mjs';

// Tools the daemon manages itself: agents must not stop servers other sessions share.
const HIDDEN_TOOLS = new Set(['lsp_start_server', 'lsp_stop_server']);

export const unavailable = (id, reason) => `${id} language server unavailable (${reason}); use graphify and grep`;

export const instructions = (config) =>
  [
    `Code intelligence for this checkout (${config.project?.name ?? 'app'}) through language servers: ${config.servers.map((s) => s.id).join(', ') || 'none configured'}.`,
    'Use graphify first to find where to look; use these tools for precise facts at code graphify or a read already located:',
    'confirm definitions, signatures and callers (lsp_goto_definition, lsp_hover, lsp_find_references) before changing existing code,',
    'run lsp_diagnostics after every edit, and preview renames with lsp_rename dry_run=true.',
    'Paths must be absolute and inside this checkout; line and column are 1-indexed.',
    'When a call answers "<server> language server unavailable", do not retry in a loop: use graphify and grep instead.',
  ].join(' ');

export const stateFileOf = (sdir, id) => path.join(sdir, `server-${id}.json`);

// Runs the `scope` module of every server that has one. A scope module narrows what its server loads to the
// part of the checkout that owns `owns` (globs), and answers with environment variables for the server and
// its `prepare` command: export function scope({ worktree, owns, stateDir, options, server }) ->
// { ok, env?, description?, error? }. It is also called with no globs, for the whole checkout.
export async function resolveScopes(config, { worktree, sdir, owns = [], log = () => {} }) {
  const scopes = new Map();
  const vars = { worktree, factory: INSTALL_ROOT, stateDir: sdir };
  for (const server of config.servers) {
    if (!server.scope?.module) continue;
    const file = path.resolve(worktree, expand(server.scope.module, vars));
    const call = async (globs) => {
      const mod = await import(pathToFileURL(file).href);
      return (await mod.scope({ worktree, owns: globs, stateDir: sdir, options: server.scope.options ?? {}, server })) ?? { ok: false, error: 'no answer' };
    };
    let result;
    try {
      result = await call(owns);
      if (!result.ok && owns.length) {
        log(`${server.id}: no scope for ${owns.join(', ')} (${result.error ?? 'no reason given'}); loading the whole checkout`);
        result = await call([]);
      }
    } catch (error) {
      result = { ok: false, error: `scope module ${file} failed: ${error.message}` };
    }
    if (!result.ok) log(`${server.id}: scope unavailable (${result.error ?? 'no reason given'})`);
    scopes.set(server.id, { ok: Boolean(result.ok), env: result.ok ? (result.env ?? {}) : {}, description: result.description ?? null, error: result.ok ? null : (result.error ?? null) });
  }
  return scopes;
}

// Environment of one server (and of its prepare command): where to report load state, its scope, its own env.
export function serverEnv(server, { worktree, sdir, scopes = new Map() }) {
  const vars = { worktree, factory: INSTALL_ROOT, stateDir: sdir };
  const own = Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, expand(v, vars)]));
  return { LSPD_SERVER_ID: server.id, LSPD_STATE_FILE: stateFileOf(sdir, server.id), ...(scopes.get(server.id)?.env ?? {}), ...own };
}

// The bridge's config. Commands are resolved here (app node_modules, engine node_modules, PATH). A leased
// server that does not report its own state runs under launch.mjs, which records whether it is alive.
export function lspMcpConfig(config, worktree, { sdir = worktree, scopes = new Map() } = {}) {
  const vars = { worktree, factory: INSTALL_ROOT, stateDir: sdir };
  return {
    requestTimeout: (config.callTimeoutSec ?? 60) * 1000,
    idleTimeout: (config.idleSec ?? 900) * 1000,
    minify: 'full',
    logLevel: 'warn',
    servers: config.servers.map((s) => {
      const resolved = resolveCommand(worktree, expand(s.command, vars), (s.args ?? []).map((a) => expand(a, vars)));
      const wrapped = s.leased && !s.reportsState ? { command: process.execPath, args: [path.join(LSP_DIR, 'launch.mjs'), resolved.command, ...resolved.args] } : resolved;
      return {
        id: s.id,
        extensions: s.extensions,
        languageIds: s.languageIds,
        command: wrapped.command,
        args: wrapped.args,
        env: serverEnv(s, { worktree, sdir, scopes }),
        rootPatterns: s.rootPatterns ?? ['.git'],
      };
    }),
  };
}

export async function serve({ worktree, owns = [] }) {
  const config = loadConfig(worktree);
  ensureToolPath(config.project?.toolPaths);
  const paths = daemonPaths(worktree);
  const sdir = stateDir(worktree);
  const startedAt = new Date().toISOString();
  const log = (...args) => process.stderr.write(`[lspd ${new Date().toISOString()}] ${args.join(' ')}\n`);
  fs.mkdirSync(paths.dir, { recursive: true });

  // Another daemon already serving this checkout: nothing to do.
  try {
    (await connect(paths.socket, 1000)).destroy();
    log(`another daemon already serves ${worktree}`);
    return 0;
  } catch {
    removeSocket(paths.socket);
  }

  const entry = resolveBridge(worktree);
  if (!entry || !fs.existsSync(entry)) throw new Error('lsp-mcp-server is not installed (run `npm ci` in the factory install root, then `factory lsp setup`)');
  const scopes = await resolveScopes(config, { worktree, sdir, owns, log });
  fs.writeFileSync(path.join(sdir, '.lsp-mcp.json'), `${JSON.stringify(lspMcpConfig(config, worktree, { sdir, scopes }), null, 2)}\n`);
  for (const s of config.servers) fs.rmSync(stateFileOf(sdir, s.id), { force: true });

  // ---- child: lsp-mcp-server over stdio ------------------------------------------------------------------
  const child = spawn(process.execPath, [entry], {
    cwd: sdir, // picks up the generated .lsp-mcp.json
    env: {
      ...process.env,
      LSP_WORKSPACE_ROOT: worktree,
      LSPD_STATE_DIR: sdir,
      LSP_LOG_LEVEL: process.env.LSP_LOG_LEVEL ?? 'warn',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let nextId = 1;
  const pending = new Map();
  let childBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    childBuffer += chunk;
    let nl;
    while ((nl = childBuffer.indexOf('\n')) >= 0) {
      const line = childBuffer.slice(0, nl).trim();
      childBuffer = childBuffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method && msg.id !== undefined) {
        // Server-to-client request (roots/list, ping, ...): answer with an empty result.
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [{ uri: `file://${worktree}`, name: path.basename(worktree) }] } : {} })}\n`);
      }
    }
  });
  const childRequest = (method, params, timeoutMs = 30000) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timedOut: true });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  let shuttingDown = false;
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      log(`lsp-mcp-server exited (${code ?? signal}); stopping`);
      shutdown(1);
    }
  });

  const init = await childRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: {} },
    clientInfo: { name: 'lspd', version: '1' },
  });
  if (!init.result) throw new Error(`lsp-mcp-server did not initialize: ${JSON.stringify(init.error ?? init)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = ((await childRequest('tools/list', {})).result?.tools ?? []).filter((t) => !HIDDEN_TOOLS.has(t.name));

  // A server that cannot report its load state (no `reportsState`; typescript-language-server, for example)
  // answers before its project is loaded, with the import binding as the definition. Warm each one up with its
  // `lsp.check` probe: repeat the probe's definition call until it resolves into another file (at most two
  // minutes), so an agent's first call finds the project loaded.
  const warmUp = async () => {
    const probes = (config.check ?? []).filter(([id, , line]) => line && !config.servers.find((x) => x.id === id)?.reportsState);
    for (const [id, rel, line, column = 1] of probes) {
      const file = path.resolve(worktree, rel);
      if (!fs.existsSync(file)) continue;
      const deadline = Date.now() + 120_000;
      while (!shuttingDown && Date.now() < deadline) {
        const r = await childRequest('tools/call', { name: 'lsp_goto_definition', arguments: { file_path: file, line, column } }, 60_000);
        if (definitionElsewhere((r.result?.content ?? []).map((c) => c.text ?? '').join(''), file)) {
          log(`${id}: project loaded (probe ${rel}:${line} resolves into another file)`);
          break;
        }
        await new Promise((r2) => setTimeout(r2, 2000));
      }
    }
  };
  warmUp().catch((error) => log(`warm-up: ${error.message}`));

  // ---- leased servers: one machine-wide lease each -----------------------------------------------------
  // A leased server is started by the daemon (not lazily by the bridge) once it holds a lease slot, after its
  // `prepare` command. Its load state comes from its state file: launch.mjs writes running/exited, a server
  // with `reportsState` writes starting -> loading -> ready | exited itself.
  const tracked = new Map(
    config.servers.filter((s) => s.leased).map((cfg) => [cfg.id, { cfg, lease: null, info: { status: 'unavailable', reason: 'not started' }, exitedSince: null }]),
  );
  const serverState = (t) => readJson(stateFileOf(sdir, t.cfg.id));
  const vars = { worktree, factory: INSTALL_ROOT, stateDir: sdir };

  // Runs the server's `prepare` command (restore packages, fetch dependencies, ...) before it starts. The
  // command decides itself whether there is anything to do; a failure is logged and the server starts anyway.
  function prepareThen(t, next) {
    const prepare = t.cfg.prepare;
    if (!prepare?.command) return next();
    const label = prepare.label ?? 'preparing';
    t.info = { status: 'running', reason: null, startedAt: Date.now(), preparing: label };
    log(`${t.cfg.id}: ${label} before starting`);
    const resolved = resolveCommand(worktree, expand(prepare.command, vars), (prepare.args ?? []).map((a) => expand(a, vars)));
    const out = fs.openSync(path.join(sdir, `prepare-${t.cfg.id}.log`), 'w');
    const proc = spawn(resolved.command, resolved.args, { cwd: worktree, stdio: ['ignore', out, out], env: { ...process.env, ...serverEnv(t.cfg, { worktree, sdir, scopes }) }, windowsHide: true });
    fs.closeSync(out);
    let done = false;
    const finish = (what) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log(`${t.cfg.id}: prepare ${what}`);
      next();
    };
    const limitSec = prepare.timeoutSec ?? config.prepareTimeoutSec ?? 900;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish(`timed out after ${limitSec}s`);
    }, limitSec * 1000);
    timer.unref();
    proc.on('error', (error) => finish(`failed to start: ${error.message}`));
    proc.on('exit', (code) => finish(`exited ${code}`));
  }

  function startLeased(t) {
    if (t.lease?.ok) return;
    if (config.maxLanguageServers <= 0) {
      t.info = { status: 'unavailable', reason: 'leased language servers are disabled (maxLanguageServers=0)' };
      return;
    }
    t.lease = acquireLease({ owner: worktree, server: t.cfg.id, max: config.maxLanguageServers });
    if (!t.lease.ok) {
      t.info = { status: 'unavailable', reason: t.lease.reason };
      t.lease = null;
      return;
    }
    fs.rmSync(stateFileOf(sdir, t.cfg.id), { force: true });
    t.exitedSince = null;
    t.info = { status: 'running', reason: null, startedAt: Date.now() };
    log(`${t.cfg.id}: lease slot ${t.lease.slot}${scopes.get(t.cfg.id)?.description ? `; ${scopes.get(t.cfg.id).description}` : ''}`);
    prepareThen(t, () => {
      t.info.preparing = null;
      if (!t.lease?.ok || shuttingDown) return;
      launch(t);
    });
  }

  function launch(t) {
    // The initialize handshake returns long before a big workspace is loaded.
    childRequest('tools/call', { name: 'lsp_start_server', arguments: { server_id: t.cfg.id, workspace_root: worktree } }, 300000).then((res) => {
      if (res.result?.isError || res.error || res.timedOut) {
        const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? 'timed out');
        log(`${t.cfg.id}: failed to start: ${text}`);
        t.info = { status: 'unavailable', reason: `failed to start: ${text.slice(0, 300)}` };
        releaseLease(t.lease);
        t.lease = null;
      }
    });
  }

  // Why a request for a leased server cannot be served right now, or null when it can.
  function blocker(t) {
    if (!t.lease?.ok) startLeased(t);
    if (t.info.status !== 'running') return t.info.reason;
    const state = serverState(t);
    const elapsed = Math.round((Date.now() - t.info.startedAt) / 1000);
    const loadLimit = t.cfg.loadTimeoutSec ?? config.loadTimeoutSec ?? 900;
    if (t.info.preparing) return `${t.info.preparing} (${elapsed}s so far)`;
    if (!state || state.state === 'starting' || state.state === 'loading') {
      if (elapsed > loadLimit) return null; // never got the "ready" report; try anyway
      return `still loading${scopes.get(t.cfg.id)?.description ? ` ${scopes.get(t.cfg.id).description}` : ''} (${elapsed}s so far)`;
    }
    if (state.state === 'exited') return 'the server exited; it restarts on the next request';
    return null;
  }

  // Idle leased server stopped by lsp-mcp-server, or crashed for good: give the slot back.
  const leaseWatch = setInterval(() => {
    for (const t of tracked.values()) {
      if (!t.lease?.ok) continue;
      if (serverState(t)?.state === 'exited') {
        t.exitedSince ??= Date.now();
        if (Date.now() - t.exitedSince > 15000) {
          log(`${t.cfg.id}: server stopped; releasing lease`);
          releaseLease(t.lease);
          t.lease = null;
          t.info = { status: 'unavailable', reason: 'stopped after being idle; it restarts on the next request' };
        }
      } else t.exitedSince = null;
    }
  }, 5000);
  leaseWatch.unref();

  // Resolves symlinks (/tmp vs /private/tmp) so paths compare against the real checkout path.
  const realPath = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      try {
        return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
      } catch {
        return p;
      }
    }
  };

  // Checks a tool call's target; returns an error text or null.
  function gate(args = {}) {
    const file = args.file_path;
    if (file) {
      const abs = realPath(path.resolve(worktree, file));
      if (abs !== worktree && !abs.startsWith(`${worktree}${path.sep}`)) {
        return `${file} is outside this checkout (${worktree}); this server only answers for its own checkout`;
      }
      const t = tracked.get(serverForFile(config, abs)?.id);
      const why = t && blocker(t);
      if (why) return unavailable(t.cfg.id, why);
    }
    const byId = args.server_id && tracked.get(args.server_id);
    const why = byId && blocker(byId);
    if (why) return unavailable(byId.cfg.id, why);
    return null;
  }

  let lastActivity = Date.now();
  const callTimeoutMs = (config.callTimeoutSec ?? 60) * 1000;

  async function callTool(name, args) {
    lastActivity = Date.now();
    if (HIDDEN_TOOLS.has(name)) return { content: [{ type: 'text', text: `${name} is managed by lspd` }], isError: true };
    const blocked = gate(args);
    if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true };
    if (typeof args.file_path === 'string') args = { ...args, file_path: realPath(path.resolve(worktree, args.file_path)) };
    const res = await childRequest('tools/call', { name, arguments: args }, callTimeoutMs);
    lastActivity = Date.now();
    if (res.timedOut) {
      const leased = args?.file_path && tracked.get(serverForFile(config, args.file_path)?.id);
      const why = `no answer within ${callTimeoutMs / 1000}s`;
      return { content: [{ type: 'text', text: leased ? unavailable(leased.cfg.id, why) : `Language server busy (${why}); use graphify and grep` }], isError: true };
    }
    if (res.error) return { content: [{ type: 'text', text: res.error.message ?? JSON.stringify(res.error) }], isError: true };
    return res.result;
  }

  async function diagnostics(files) {
    const out = {};
    const timeoutMs = (config.diagnosticsTimeoutSec ?? 20) * 1000;
    for (const file of files) {
      const abs = realPath(path.resolve(worktree, file));
      const server = serverForFile(config, abs);
      if (!server) {
        out[file] = { unavailable: 'no language server for this file type' };
        continue;
      }
      if (!fs.existsSync(abs)) {
        out[file] = { unavailable: 'file not found' };
        continue;
      }
      const blocked = gate({ file_path: abs });
      if (blocked) {
        out[file] = { unavailable: blocked };
        continue;
      }
      const res = await childRequest('tools/call', { name: 'lsp_diagnostics', arguments: { file_path: abs, severity_filter: 'all' } }, timeoutMs);
      lastActivity = Date.now();
      const text = res.result?.content?.[0]?.text;
      if (res.timedOut || !text || res.result?.isError) {
        out[file] = { unavailable: res.timedOut ? `no answer within ${timeoutMs / 1000}s` : (text ?? 'no answer').slice(0, 300) };
        continue;
      }
      try {
        out[file] = (JSON.parse(text).diagnostics ?? []).map((d) => ({
          severity: d.severity,
          line: d.range?.start?.line,
          col: d.range?.start?.column,
          code: d.code ?? null,
          message: d.message,
        }));
      } catch {
        out[file] = { unavailable: text.slice(0, 300) };
      }
    }
    return out;
  }

  // ---- socket server ----------------------------------------------------------------------------------------
  const sessions = new Set();

  // Per leased server: running|unavailable, its load state, why it is unavailable and its lease slot.
  function serversStatus() {
    return Object.fromEntries(
      [...tracked.values()].map((t) => {
        const up = t.info.status === 'running';
        return [
          t.cfg.id,
          {
            status: t.info.status,
            state: up ? (t.info.preparing ? 'preparing' : (serverState(t)?.state ?? 'starting')) : null,
            reason: up ? null : t.info.reason,
            leaseSlot: t.lease?.ok ? t.lease.slot : null,
            scope: scopes.get(t.cfg.id)?.description ?? null,
          },
        ];
      }),
    );
  }

  function status() {
    const servers = serversStatus();
    const down = Object.entries(servers).find(([, s]) => s.status !== 'running');
    return {
      ok: true,
      running: true,
      pid: process.pid,
      socket: paths.socket,
      worktree,
      project: config.project?.name ?? null,
      stateDir: sdir,
      startedAt,
      sessions: sessions.size,
      lastActivity: new Date(lastActivity).toISOString(),
      // Summary of the leased servers: none | running | unavailable (with the first one's reason).
      leased: !tracked.size ? 'none' : down ? 'unavailable' : 'running',
      reason: down ? `${down[0]}: ${down[1].reason}` : null,
      servers,
    };
  }

  function mcpSession(conn, header, rest) {
    sessions.add(conn);
    const send = (msg) => conn.writable && conn.write(`${JSON.stringify(msg)}\n`);
    const handle = async (msg) => {
      lastActivity = Date.now();
      if (msg.id === undefined) return; // notifications (initialized, cancelled) need no answer
      const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
      switch (msg.method) {
        case 'initialize':
          return reply({
            protocolVersion: msg.params?.protocolVersion ?? init.result.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: RUNTIME_NAME, version: init.result.serverInfo?.version ?? '0' },
            instructions: instructions(config),
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools });
        case 'tools/call':
          return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
        default:
          return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    };
    let buffer = rest;
    const drain = () => {
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        handle(msg).catch((error) => log(`session error: ${error.stack ?? error}`));
      }
    };
    conn.on('data', (chunk) => {
      buffer += chunk;
      drain();
    });
    conn.on('close', () => {
      sessions.delete(conn);
      lastActivity = Date.now();
    });
    drain();
  }

  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    let head = '';
    const onData = async (chunk) => {
      head += chunk;
      const nl = head.indexOf('\n');
      if (nl < 0) return;
      conn.off('data', onData);
      let header;
      try {
        header = JSON.parse(head.slice(0, nl));
      } catch {
        conn.end(`${JSON.stringify({ ok: false, error: 'expected a JSON header line' })}\n`);
        return;
      }
      const rest = head.slice(nl + 1);
      const answer = (obj) => conn.end(`${JSON.stringify(obj)}\n`);
      switch (header.lspd) {
        case 'mcp':
          return mcpSession(conn, header, rest);
        case 'status':
          return answer(status());
        case 'diagnostics':
          return answer({ ok: true, files: await diagnostics(header.files ?? []) });
        case 'stop':
          answer({ ok: true, stopped: true, pid: process.pid });
          return shutdown(0);
        default:
          return answer({ ok: false, error: `unknown request ${header.lspd}` });
      }
    };
    conn.on('data', onData);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  protectSocket(paths.socket);
  writeJsonAtomic(paths.pidFile, { pid: process.pid, worktree, project: config.project?.name ?? null, socket: paths.socket, stateDir: sdir, startedAt });
  log(`serving ${worktree} on ${paths.socket} (pid ${process.pid})`);

  for (const t of tracked.values()) startLeased(t);

  const idleMs = (config.idleSec ?? 900) * 1000;
  const idleWatch = setInterval(() => {
    if (sessions.size === 0 && Date.now() - lastActivity > idleMs) {
      log(`idle for ${config.idleSec}s with no sessions; stopping`);
      shutdown(0);
    }
  }, Math.min(30000, idleMs));
  idleWatch.unref();

  function cleanupFiles() {
    if (readJson(paths.pidFile)?.pid === process.pid) {
      fs.rmSync(paths.pidFile, { force: true });
      removeSocket(paths.socket);
    }
    for (const t of tracked.values()) {
      releaseLease(t.lease);
      t.lease = null;
    }
  }

  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleWatch);
    clearInterval(leaseWatch);
    server.close();
    for (const conn of sessions) conn.destroy();
    cleanupFiles();
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    process.exit(code);
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', cleanupFiles);
  return new Promise(() => {}); // runs until shutdown()
}
