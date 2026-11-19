import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultProbes, probesFor } from '../check.mjs';
import { INSTALL_ROOT, acquireLease, control, daemonPaths, expand, listLeases, loadConfig, mergeServers, releaseLease, resolveCommand, runtimeDir, worktreeHash } from '../lib/common.mjs';
import { instructions, lspMcpConfig, unavailable } from '../lib/daemon.mjs';
import { inspect } from '../setup.mjs';

// Lease owners are checkouts that exist: a slot whose checkout is gone is reclaimed (and its daemon stopped).
const WT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-wt-'));
for (const x of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(WT, x));

const LSP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(LSP_DIR, 'test/fixtures');
const FAKE_LSP = path.join(FIXTURES, 'fake-lsp.mjs');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

// A git checkout with the given `lsp` section in .factory/config.json and the given files.
function checkout(prefix, lsp, files = {}) {
  const root = tmp(prefix);
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ project: { name: 'Demo Shop' }, lsp }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

// A fake language server entry: reports its own load state like a pack proxy unless `reportsState` is false.
const fakeServer = (id, ext, extra = {}) => ({
  id,
  extensions: [ext],
  languageIds: [id],
  command: 'node',
  args: [FAKE_LSP],
  leased: true,
  reportsState: true,
  env: { FAKE_LSP_REPORTS: '1' },
  ...extra,
});

describe('socket paths', () => {
  test('are derived from the real worktree path and fit a unix socket', () => {
    const dir = tmp('lspd-path-');
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    try {
      assert.match(worktreeHash(dir), /^[0-9a-f]{12}$/);
      assert.equal(worktreeHash(link), worktreeHash(dir));
      const p = daemonPaths(dir);
      if (process.platform === 'win32') assert.match(p.socket, new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\ai-app-factory-lsp-[0-9a-f]{8}-${p.hash}$`));
      else assert.equal(path.basename(p.socket), `${p.hash}.sock`);
      assert.ok(Buffer.byteLength(p.socket) < 104, p.socket);
      assert.notEqual(daemonPaths(os.tmpdir()).socket, p.socket);
    } finally {
      fs.rmSync(link);
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('machine-wide state is named after the factory, never after an app', () => {
    const saved = process.env.LSP_RUNTIME_DIR;
    delete process.env.LSP_RUNTIME_DIR;
    try {
      assert.equal(runtimeDir(), path.join(os.tmpdir(), 'ai-app-factory-lsp'));
    } finally {
      if (saved !== undefined) process.env.LSP_RUNTIME_DIR = saved;
    }
  });
});

describe('machine-wide lease', () => {
  test('caps holders, denies when full and frees on release', () => {
    const dir = tmp('lspd-lease-');
    const a = acquireLease({ owner: `${WT}/a`, max: 2, dir });
    const b = acquireLease({ owner: `${WT}/b`, max: 2, dir, pid: process.ppid });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.slot, b.slot);
    const c = acquireLease({ owner: `${WT}/c`, max: 2, dir, pid: process.ppid });
    assert.equal(c.ok, false);
    // Was "all 2 C# language server slots are in use": the lease is no longer specific to one language.
    assert.match(c.reason, /all 2 leased language server slots are in use/);
    releaseLease(a);
    const d = acquireLease({ owner: `${WT}/d`, max: 2, dir });
    assert.ok(d.ok);
    assert.equal(d.slot, a.slot);
    fs.rmSync(dir, { recursive: true });
  });

  test('is idempotent for the same holder', () => {
    const dir = tmp('lspd-lease-');
    const a = acquireLease({ owner: `${WT}/a`, max: 1, dir });
    const again = acquireLease({ owner: `${WT}/a`, max: 1, dir });
    assert.ok(again.ok);
    assert.equal(again.slot, a.slot);
    fs.rmSync(dir, { recursive: true });
  });

  test('one checkout holds a slot per leased server, and the holders are named when full', () => {
    const dir = tmp('lspd-lease-');
    const rust = acquireLease({ owner: `${WT}/a`, server: 'rust', max: 2, dir });
    const java = acquireLease({ owner: `${WT}/a`, server: 'java', max: 2, dir });
    assert.ok(rust.ok && java.ok);
    assert.notEqual(rust.slot, java.slot);
    assert.equal(acquireLease({ owner: `${WT}/a`, server: 'rust', max: 2, dir }).slot, rust.slot, 'idempotent per server');
    assert.deepEqual(listLeases(dir).map((l) => l.server).sort(), ['java', 'rust']);
    const full = acquireLease({ owner: `${WT}/a`, server: 'go', max: 2, dir });
    assert.equal(full.ok, false);
    assert.ok(full.reason.includes(`${WT}/a (rust)`), full.reason);
    fs.rmSync(dir, { recursive: true });
  });

  test('reclaims a slot whose holder died', () => {
    const dir = tmp('lspd-lease-');
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify({ slot: 0, pid: deadPid(), owner: '/wt/gone' }));
    assert.equal(listLeases(dir)[0].alive, false);
    const l = acquireLease({ owner: '/wt/new', max: 1, dir });
    assert.ok(l.ok);
    assert.equal(JSON.parse(fs.readFileSync(l.file, 'utf8')).owner, '/wt/new');
    fs.rmSync(dir, { recursive: true });
  });

  test('never reclaims a slot that is still being written', () => {
    const dir = tmp('lspd-lease-');
    fs.writeFileSync(path.join(dir, 'slot-0.json'), '');
    assert.equal(acquireLease({ owner: '/wt/x', max: 1, dir }).ok, false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('configuration', () => {
  const roots = [];
  const make = (lsp, files) => {
    const root = checkout('lspd-cfg-', lsp, files);
    roots.push(root);
    return root;
  };
  after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

  test('engine defaults hold only language-neutral servers and no app paths', () => {
    const text = fs.readFileSync(path.join(LSP_DIR, 'config.json'), 'utf8');
    const defaults = JSON.parse(text);
    assert.deepEqual(defaults.servers.map((s) => s.id).sort(), ['bash', 'json', 'yaml']);
    assert.ok(defaults.servers.every((s) => !s.leased && !s.prepare && !s.scope));
    assert.doesNotMatch(text, /eshop|slnx?|csharp|dotnet/i);
    for (const file of ['lib/common.mjs', 'lib/daemon.mjs', 'lspd.mjs', 'mcp.mjs', 'hook.mjs', 'check.mjs', 'setup.mjs', 'scope.mjs', 'launch.mjs']) {
      assert.doesNotMatch(fs.readFileSync(path.join(LSP_DIR, file), 'utf8'), /eshop|\.slnx?\b|slnf|csharp|roslyn|dotnet|nuget/i, `${file} knows a stack`);
    }
  });

  test('app servers are merged with the defaults by id; disabled removes one', () => {
    const merged = mergeServers(
      [{ id: 'json', extensions: ['.json'], command: 'a', hook: false }, { id: 'yaml', extensions: ['.yml'], command: 'b' }],
      [{ id: 'json', command: 'c' }, { id: 'yaml', disabled: true }, { id: 'rust', extensions: ['.rs'], command: 'rust-analyzer', leased: true }],
    );
    assert.deepEqual(merged, [{ id: 'json', extensions: ['.json'], command: 'c', hook: false }, { id: 'rust', extensions: ['.rs'], command: 'rust-analyzer', leased: true }]);
  });

  test('loadConfig merges the lsp section of .factory/config.json and carries the project model', () => {
    const root = make({ idleSec: 60, servers: [fakeServer('heavy', '.HV', { loadTimeoutSec: 5 }), { id: 'bash', disabled: true }], check: [['heavy', 'src/a.hv', 1, 2]] });
    const config = loadConfig(root);
    assert.equal(config.idleSec, 60);
    assert.equal(config.callTimeoutSec, 60, 'defaults survive');
    assert.equal(config.project.name, 'demo-shop');
    assert.deepEqual(config.servers.map((s) => s.id), ['json', 'yaml', 'heavy']);
    assert.deepEqual(config.servers.at(-1).extensions, ['.hv'], 'extensions compare lower-case');
    assert.deepEqual(config.check, [['heavy', 'src/a.hv', 1, 2]]);
    const bad = make({ servers: [{ id: 'odd', extensions: ['.odd'] }] });
    assert.throws(() => loadConfig(bad), /server "odd" has no languageIds, command/);
  });

  test('commands resolve from the app node_modules, then the engine, then PATH; placeholders expand', () => {
    const root = make({ servers: [] });
    const bin = path.join(root, 'node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'app-language-server'), '#!/bin/sh\n', { mode: 0o755 });
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'app-language-server.cmd'), '@echo off\r\n');
    const local = resolveCommand(root, 'app-language-server', ['--stdio']);
    assert.equal(local.found, true);
    assert.ok(local.source.startsWith(bin));
    assert.deepEqual(local.args.slice(-1), ['--stdio']);
    assert.deepEqual(resolveCommand(root, 'node', ['x']), { command: process.execPath, args: ['x'], found: true, source: 'node' });
    assert.equal(resolveCommand(root, 'git').found, true, 'falls back to PATH');
    assert.equal(resolveCommand(root, 'no-such-language-server').found, false);
    assert.equal(resolveCommand(root, 'no-such-language-server').command, 'no-such-language-server');
    assert.equal(expand('${factory}/packs/x/lsp/p.mjs', { factory: INSTALL_ROOT }), path.join(INSTALL_ROOT, 'packs/x/lsp/p.mjs'));
    assert.equal(expand('${worktree}/a/${stateDir}', { worktree: '/w', stateDir: '/s' }), '/w/a//s');
  });

  test('the bridge config launches every server from the install root, never from the checkout', () => {
    const root = make({
      servers: [
        fakeServer('heavy', '.hv', { reportsState: false, env: { WHERE: '${worktree}/x' } }),
        fakeServer('proxied', '.px', { command: 'node', args: ['${factory}/packs/demo/lsp/proxy.mjs', 'srv'] }),
        { id: 'light', extensions: ['.lt'], languageIds: ['light'], command: 'light-ls', args: ['--stdio'] },
      ],
    });
    const config = loadConfig(root);
    const sdir = path.join(root, '.git/lsp');
    const scopes = new Map([['heavy', { ok: true, env: { SCOPED: '1' } }]]);
    const byId = Object.fromEntries(lspMcpConfig(config, root, { sdir, scopes }).servers.map((s) => [s.id, s]));
    // A leased server that does not report its own state runs under the engine's launcher.
    assert.equal(byId.heavy.command, process.execPath);
    assert.deepEqual(byId.heavy.args, [path.join(INSTALL_ROOT, 'scripts/lsp/launch.mjs'), process.execPath, FAKE_LSP]);
    assert.deepEqual(byId.heavy.env, { LSPD_SERVER_ID: 'heavy', LSPD_STATE_FILE: path.join(sdir, 'server-heavy.json'), SCOPED: '1', WHERE: `${root}/x` });
    assert.deepEqual(byId.proxied.args, [path.join(INSTALL_ROOT, 'packs/demo/lsp/proxy.mjs'), 'srv']);
    assert.deepEqual([byId.light.command, byId.light.args], ['light-ls', ['--stdio']]);
    for (const s of Object.values(byId)) assert.ok(!JSON.stringify(s).includes(path.join(root, 'scripts')), 'no <checkout>/scripts path');
    assert.match(instructions(config), /checkout \(demo-shop\) through language servers: bash, json, yaml, heavy, proxied, light\./);
  });

  test('the unavailable message names the server and tells the agent what to do instead', () => {
    assert.equal(unavailable('rust', 'still loading (3s so far)'), 'rust language server unavailable (still loading (3s so far)); use graphify and grep');
  });

  test('check probes come from lsp.check, else one tracked file per configured server by extension', () => {
    const root = make({ servers: [fakeServer('heavy', '.hv'), { id: 'bash', disabled: true }] }, { 'src/deep/b.hv': '', 'src/a.hv': '', 'data.json': '{}', 'untracked.yml': '' });
    spawnSync('git', ['add', 'src', 'data.json'], { cwd: root });
    const config = loadConfig(root);
    assert.deepEqual(defaultProbes(config, root), [['json', 'data.json', 0, 0], ['heavy', 'src/a.hv', 0, 0]]);
    assert.deepEqual(probesFor(config, root, ['heavy']), [['heavy', 'src/a.hv', 0, 0]]);
    config.check = [['heavy', 'src/deep/b.hv', 3, 9], ['json', 'data.json']];
    assert.deepEqual(probesFor(config, root), [['heavy', 'src/deep/b.hv', 3, 9], ['json', 'data.json', 0, 0]]);
  });

  test('setup reports which configured servers can be found', () => {
    const root = make({ servers: [fakeServer('heavy', '.hv'), { id: 'ghost', extensions: ['.gh'], languageIds: ['ghost'], command: 'no-such-language-server' }, { id: 'bash', disabled: true }, { id: 'json', disabled: true }, { id: 'yaml', disabled: true }] });
    const saved = process.env.LSP_MCP_SERVER;
    process.env.LSP_MCP_SERVER = path.join(FIXTURES, 'fake-bridge.mjs');
    try {
      const report = inspect(root);
      assert.equal(report.ok, false);
      assert.equal(report.bridge, path.join(FIXTURES, 'fake-bridge.mjs'));
      assert.deepEqual(report.servers.map((s) => [s.id, s.found]), [['heavy', true], ['ghost', false]]);
    } finally {
      if (saved === undefined) delete process.env.LSP_MCP_SERVER;
      else process.env.LSP_MCP_SERVER = saved;
    }
  });
});

// The daemon runs against fixtures only: a checkout made here, fake language servers (fixtures/fake-lsp.mjs) and,
// unless LSP_MCP_SERVER already names a real lsp-mcp-server entry, a fake bridge (fixtures/fake-bridge.mjs).
function daemonHarness(lsp, files = { 'src/A.hv': 'thing A\n' }, extraEnv = {}) {
  const worktree = checkout('lspd-wt-', lsp, files);
  const env = { ...process.env, LSP_RUNTIME_DIR: tmp('lspd-rt-'), LSP_MCP_SERVER: process.env.LSP_MCP_SERVER ?? path.join(FIXTURES, 'fake-bridge.mjs'), ...extraEnv };
  delete env.PIPELINE_ROOT;
  const lspd = (...args) => {
    const r = spawnSync(process.execPath, [path.join(LSP_DIR, 'lspd.mjs'), ...args], { encoding: 'utf8', env, timeout: 60000 });
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const status = () => lspd('status', '--worktree', worktree);
  const waitFor = async (id, state) => {
    let st;
    for (let i = 0; i < 100; i++) {
      st = status().servers?.[id];
      if (st?.state === state) return st;
      await sleep(100);
    }
    assert.fail(`${id} never reached ${state}: ${JSON.stringify(st)}`);
    return st;
  };
  // Runs MCP requests through mcp.mjs and returns the replies by id.
  const mcpCalls = async (messages, agent = 'tester') => {
    const mcp = spawn(process.execPath, [path.join(LSP_DIR, 'mcp.mjs')], { cwd: worktree, env: { ...env, PIPELINE_AGENT_NAME: agent }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = [];
    let buf = '';
    mcp.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    for (const m of messages) mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    for (let i = 0; i < 100 && replies.length < messages.length; i++) await sleep(100);
    mcp.stdin.end();
    return Object.fromEntries(replies.map((r) => [r.id, r]));
  };
  const hover = (id, file) => ({ id, method: 'tools/call', params: { name: 'lsp_hover', arguments: { file_path: path.isAbsolute(file) ? file : path.join(worktree, file), line: 1, column: 7 } } });
  const cleanup = () => {
    lspd('stop', '--worktree', worktree);
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(env.LSP_RUNTIME_DIR, { recursive: true, force: true });
  };
  return { worktree, env, lspd, status, waitFor, mcpCalls, hover, cleanup, leases: path.join(env.LSP_RUNTIME_DIR, 'leases') };
}

describe('lspd daemon', { timeout: 120000 }, () => {
  let h;
  before(() => {
    h = daemonHarness({ servers: [fakeServer('heavy', '.hv')] }, undefined, { LSP_MAX_SERVERS: '1' });
  });
  after(() => h.cleanup());

  test('start is idempotent and serves MCP calls through the fake server', async () => {
    const first = h.lspd('start', '--worktree', h.worktree);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.leased, 'running');
    assert.equal(first.servers.heavy.status, 'running');
    const second = h.lspd('start', '--worktree', h.worktree);
    assert.equal(second.pid, first.pid);
    assert.equal(second.socket, first.socket);

    process.env.LSP_RUNTIME_DIR = h.env.LSP_RUNTIME_DIR;
    try {
      let state;
      for (let i = 0; i < 50 && state !== 'ready'; i++) {
        state = (await control(first.socket, { lspd: 'status' })).servers.heavy.state;
        if (state !== 'ready') await sleep(200);
      }
      assert.equal(state, 'ready');

      const byId = await h.mcpCalls([
        { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
        { id: 2, method: 'tools/list' },
        h.hover(3, 'src/A.hv'),
        h.hover(4, '/elsewhere/B.hv'),
      ]);
      assert.equal(byId[1].result.serverInfo.name, 'ai-app-factory-lsp');
      assert.match(byId[1].result.instructions, /demo-shop.*language servers: bash, json, yaml, heavy\./);
      const names = byId[2].result.tools.map((t) => t.name);
      assert.ok(names.includes('lsp_find_references') && names.includes('lsp_rename'));
      assert.ok(!names.includes('lsp_stop_server'));
      assert.match(byId[3].result.content[0].text, /fake hover/);
      assert.match(byId[4].result.content[0].text, /outside this checkout/);

      const calls = fs.readFileSync(path.join(h.worktree, '.git/lsp/calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(calls[0].agent, 'tester');
      assert.equal(calls[0].tool, 'lsp_hover');
      assert.equal(calls[0].file, path.join(h.worktree, 'src/A.hv'));
    } finally {
      delete process.env.LSP_RUNTIME_DIR;
    }

    const stopped = h.lspd('stop', '--worktree', h.worktree);
    assert.equal(stopped.stopped, true);
    assert.ok(!fs.existsSync(first.socket));
    assert.equal(fs.readdirSync(h.leases).length, 0);
    assert.equal(h.status().running, false);
  });

  test('recovers from a stale socket and pid file', () => {
    const paths = (() => {
      process.env.LSP_RUNTIME_DIR = h.env.LSP_RUNTIME_DIR;
      try {
        return daemonPaths(h.worktree);
      } finally {
        delete process.env.LSP_RUNTIME_DIR;
      }
    })();
    fs.mkdirSync(paths.dir, { recursive: true });
    // A named pipe (Windows) cannot be left behind as a stale file.
    if (process.platform !== 'win32') fs.writeFileSync(paths.socket, '');
    fs.writeFileSync(paths.pidFile, JSON.stringify({ pid: deadPid(), worktree: h.worktree, socket: paths.socket }));
    const st = h.lspd('start', '--worktree', h.worktree);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.notEqual(st.pid, undefined);
    h.lspd('stop', '--worktree', h.worktree);
  });

  test('reports a leased server unavailable, by its id, when no lease is free', () => {
    fs.mkdirSync(h.leases, { recursive: true });
    fs.writeFileSync(path.join(h.leases, 'slot-0.json'), JSON.stringify({ slot: 0, pid: process.pid, owner: WT }));
    try {
      const st = h.lspd('start', '--worktree', h.worktree);
      assert.equal(st.leased, 'unavailable');
      assert.equal(st.servers.heavy.status, 'unavailable');
      assert.match(st.reason, /slots are in use/);
      const diag = h.lspd('diagnostics', '--worktree', h.worktree, '--files', path.join(h.worktree, 'src/A.hv'));
      // Was "C# language server unavailable ...": the message now names whichever server is unavailable.
      assert.match(Object.values(diag.files)[0].unavailable, /^heavy language server unavailable \(.*slots are in use.*\); use graphify and grep$/);
    } finally {
      h.lspd('stop', '--worktree', h.worktree);
      fs.rmSync(path.join(h.leases, 'slot-0.json'), { force: true });
    }
  });
});

describe('lspd daemon: config-driven servers', { timeout: 120000 }, () => {
  const harnesses = [];
  const harness = (...args) => {
    const h = daemonHarness(...args);
    harnesses.push(h);
    return h;
  };
  after(() => harnesses.forEach((h) => h.cleanup()));

  test('every leased server takes its own machine-wide slot; servers without `leased` take none', async () => {
    const h = harness(
      { maxLanguageServers: 2, servers: [fakeServer('heavy', '.hv'), fakeServer('bulky', '.bk'), fakeServer('greedy', '.gr'), fakeServer('light', '.lt', { leased: false })] },
      { 'a.hv': '', 'b.bk': '', 'c.gr': '', 'd.lt': '' },
    );
    const st = h.lspd('start', '--worktree', h.worktree);
    assert.deepEqual(Object.keys(st.servers), ['heavy', 'bulky', 'greedy'], 'only leased servers are tracked');
    assert.deepEqual([st.servers.heavy.status, st.servers.bulky.status, st.servers.greedy.status], ['running', 'running', 'unavailable']);
    assert.equal(st.leased, 'unavailable');
    assert.match(st.reason, /^greedy: all 2 leased language server slots are in use/);
    const held = fs.readdirSync(h.leases).map((f) => JSON.parse(fs.readFileSync(path.join(h.leases, f), 'utf8')));
    assert.deepEqual(held.map((l) => l.server).sort(), ['bulky', 'heavy']);
    assert.ok(held.every((l) => l.owner === h.worktree));
    await h.waitFor('heavy', 'ready');
    await h.waitFor('bulky', 'ready');

    const byId = await h.mcpCalls([h.hover(1, 'a.hv'), h.hover(2, 'b.bk'), h.hover(3, 'c.gr'), h.hover(4, 'd.lt')]);
    assert.match(byId[1].result.content[0].text, /fake hover heavy/);
    assert.match(byId[2].result.content[0].text, /fake hover bulky/);
    assert.equal(byId[3].result.isError, true);
    assert.match(byId[3].result.content[0].text, /^greedy language server unavailable \(all 2 leased language server slots are in use .*\); use graphify and grep$/);
    assert.match(byId[4].result.content[0].text, /fake hover light/, 'an unleased server answers although every slot is taken');

    h.lspd('stop', '--worktree', h.worktree);
    assert.equal(fs.readdirSync(h.leases).length, 0, 'stop gives every slot back');
  });

  test('maxLanguageServers=0 disables leased servers only', async () => {
    const h = harness({ maxLanguageServers: 0, servers: [fakeServer('heavy', '.hv'), fakeServer('light', '.lt', { leased: false })] }, { 'a.hv': '', 'd.lt': '' });
    const st = h.lspd('start', '--worktree', h.worktree);
    assert.equal(st.servers.heavy.reason, 'leased language servers are disabled (maxLanguageServers=0)');
    const byId = await h.mcpCalls([h.hover(1, 'a.hv'), h.hover(2, 'd.lt')]);
    assert.match(byId[1].result.content[0].text, /^heavy language server unavailable \(leased language servers are disabled/);
    assert.match(byId[2].result.content[0].text, /fake hover light/);
  });

  test('`prepare` runs in the checkout before the server starts, with the server environment; requests wait for it', async () => {
    const script = [
      "const fs = require('fs');",
      "fs.writeFileSync('prepared.json', JSON.stringify({ cwd: process.cwd(), id: process.env.LSPD_SERVER_ID, state: fs.existsSync(process.env.LSPD_STATE_FILE), extra: process.env.EXTRA }));",
      "console.log('prepared output');",
      'setTimeout(() => {}, 1500);',
    ].join(' ');
    const h = harness({ servers: [fakeServer('heavy', '.hv', { env: { FAKE_LSP_REPORTS: '1', EXTRA: '${worktree}/x' }, prepare: { command: 'node', args: ['-e', script], label: 'fetching dependencies' } })] });
    const st = h.lspd('start', '--worktree', h.worktree);
    assert.equal(st.servers.heavy.status, 'running');
    assert.equal(st.servers.heavy.state, 'preparing');
    const early = h.lspd('diagnostics', '--worktree', h.worktree, '--files', path.join(h.worktree, 'src/A.hv'));
    assert.match(Object.values(early.files)[0].unavailable, /^heavy language server unavailable \(fetching dependencies \(\d+s so far\)\); use graphify and grep$/);
    await h.waitFor('heavy', 'ready');
    const prepared = JSON.parse(fs.readFileSync(path.join(h.worktree, 'prepared.json'), 'utf8'));
    assert.deepEqual(prepared, { cwd: h.worktree, id: 'heavy', state: false, extra: `${h.worktree}/x` }, 'ran in the checkout, before the server existed');
    assert.match(fs.readFileSync(path.join(h.worktree, '.git/lsp/prepare-heavy.log'), 'utf8'), /prepared output/);
    const late = h.lspd('diagnostics', '--worktree', h.worktree, '--files', path.join(h.worktree, 'src/A.hv'));
    assert.deepEqual(Object.values(late.files)[0], []);
  });

  test('a failing `prepare` does not keep the server from starting', async () => {
    const h = harness({ servers: [fakeServer('heavy', '.hv', { prepare: { command: 'node', args: ['-e', 'process.exit(3)'] } })] });
    h.lspd('start', '--worktree', h.worktree);
    await h.waitFor('heavy', 'ready');
    assert.match(fs.readFileSync(path.join(h.worktree, '.git/lsp/lspd.log'), 'utf8'), /heavy: prepare exited 3/);
  });

  test('a `scope` module narrows the server to the owned globs and falls back to the whole checkout', async () => {
    const scoped = (id, ext) => fakeServer(id, ext, { scope: { module: path.join(FIXTURES, 'fake-scope.mjs'), options: { root: 'app' } }, prepare: { command: 'node', args: ['-e', "require('fs').writeFileSync(process.env.LSPD_SERVER_ID + '.scope', process.env.FAKE_SCOPE)"] } });
    const lsp = { servers: [scoped('heavy', '.hv'), fakeServer('plain', '.pl')] };

    const narrowed = harness(lsp, { 'a.hv': '', 'b.pl': '' });
    const st = narrowed.lspd('start', '--worktree', narrowed.worktree, '--owns', 'src/Api/**', 'tests/**');
    assert.equal(st.servers.heavy.scope, '2 glob(s)');
    assert.equal(st.servers.plain.scope, null);
    await narrowed.waitFor('heavy', 'ready');
    await narrowed.waitFor('plain', 'ready');
    assert.equal(fs.readFileSync(path.join(narrowed.worktree, 'heavy.scope'), 'utf8'), 'src/Api/**+tests/**', 'prepare sees the scope');
    const byId = await narrowed.mcpCalls([narrowed.hover(1, 'a.hv'), narrowed.hover(2, 'b.pl')]);
    assert.match(byId[1].result.content[0].text, /fake hover heavy scope=src\/Api\/\*\*\+tests\/\*\*/, 'the server sees the scope');
    assert.match(byId[2].result.content[0].text, /fake hover plain/);
    assert.doesNotMatch(byId[2].result.content[0].text, /src\/Api/, 'a server without a scope module is untouched');

    const cli = spawnSync(process.execPath, [path.join(LSP_DIR, 'scope.mjs'), '--worktree', narrowed.worktree, '--owns', 'src/Api/**'], { encoding: 'utf8', env: narrowed.env });
    assert.deepEqual(JSON.parse(cli.stdout).scopes, { heavy: { ok: true, env: { FAKE_SCOPE: 'src/Api/**' }, description: '1 glob(s)', error: null } });

    const whole = harness(lsp, { 'a.hv': '' });
    assert.equal(whole.lspd('start', '--worktree', whole.worktree).servers.heavy.scope, 'the whole checkout');
    await whole.waitFor('heavy', 'ready');
    assert.equal(fs.readFileSync(path.join(whole.worktree, 'heavy.scope'), 'utf8'), 'whole:app', 'scope options reach the module');

    const fallback = harness(lsp, { 'a.hv': '' });
    assert.equal(fallback.lspd('start', '--worktree', fallback.worktree, '--owns', 'nothing/**').servers.heavy.scope, 'the whole checkout');
    assert.match(fs.readFileSync(path.join(fallback.worktree, '.git/lsp/lspd.log'), 'utf8'), /heavy: no scope for nothing\/\*\* \(nothing matches\); loading the whole checkout/);
  });

  test('a leased server that does not report its state runs under the launcher, which records running and exited', async () => {
    const h = harness({ servers: [fakeServer('heavy', '.hv', { reportsState: false, env: {} })] });
    h.lspd('start', '--worktree', h.worktree);
    const st = await h.waitFor('heavy', 'running');
    assert.notEqual(st.leaseSlot, null);
    const stateFile = path.join(h.worktree, '.git/lsp/server-heavy.json');
    const launcher = JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid;
    const byId = await h.mcpCalls([h.hover(1, 'src/A.hv')]);
    assert.match(byId[1].result.content[0].text, /fake hover heavy/);
    process.kill(launcher, 'SIGTERM');
    for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(stateFile, 'utf8')).state !== 'exited'; i++) await sleep(100);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).state, 'exited');
    const diag = h.lspd('diagnostics', '--worktree', h.worktree, '--files', path.join(h.worktree, 'src/A.hv'));
    assert.match(Object.values(diag.files)[0].unavailable, /^heavy language server unavailable \(the server exited; it restarts on the next request\)/);
  });

  test('a server whose command is missing is reported unavailable and gives its slot back', async () => {
    const h = harness({ servers: [fakeServer('ghost', '.gh', { command: 'no-such-language-server', args: [], reportsState: false })] }, { 'a.gh': '' });
    h.lspd('start', '--worktree', h.worktree);
    let st;
    for (let i = 0; i < 100; i++) {
      st = h.status().servers.ghost;
      if (st.status === 'unavailable') break;
      await sleep(100);
    }
    assert.equal(st.status, 'unavailable', JSON.stringify(st));
    assert.match(st.reason, /^failed to start: /);
    assert.equal(fs.readdirSync(h.leases).length, 0);
    const diag = h.lspd('diagnostics', '--worktree', h.worktree, '--files', path.join(h.worktree, 'a.gh'));
    assert.match(Object.values(diag.files)[0].unavailable, /^ghost language server unavailable \(.*\); use graphify and grep$/);
  });

  test('the edit hook reports errors for files of configured servers, and stays silent for hook: false and unknown types', async () => {
    const files = { 'a.hv': 'ERROR\n', 'ok.hv': 'fine\n', 'b.qt': 'ERROR\n', 'c.unknown': 'ERROR\n' };
    const h = harness({ servers: [fakeServer('heavy', '.hv'), fakeServer('quiet', '.qt', { hook: false })] }, files, { LSP_MCP_SERVER: path.join(FIXTURES, 'fake-bridge.mjs') });
    const hook = (file) => spawnSync(process.execPath, [path.join(LSP_DIR, 'hook.mjs')], { encoding: 'utf8', env: h.env, input: JSON.stringify({ tool_input: { file_path: path.join(h.worktree, file) } }) });
    // No daemon runs: the hook stays silent and never fails an edit.
    assert.deepEqual([hook('a.hv').status, hook('a.hv').stdout], [0, '']);
    h.lspd('start', '--worktree', h.worktree);
    await h.waitFor('heavy', 'ready');
    await h.waitFor('quiet', 'ready');
    const blocked = JSON.parse(hook('a.hv').stdout);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /1 error\(s\) in a\.hv after this edit[\s\S]*a\.hv:1:1 E1 fake error/);
    for (const file of ['ok.hv', 'b.qt', 'c.unknown']) {
      const r = hook(file);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', `${file} must not be reported`);
    }
    const direct = h.lspd('diagnostics', '--worktree', h.worktree, '--files', 'b.qt');
    assert.equal(direct.files['b.qt'].length, 1, 'hook: false only silences the hook, not diagnostics');
  });
});

test('definitionElsewhere: a probe definition inside the probe file is the import binding of an unloaded project', async () => {
  const { definitionElsewhere } = await import('../lib/common.mjs');
  const json = (paths) => JSON.stringify({ definitions: paths.map((p) => ({ path: p, line: 3 })) });
  assert.equal(definitionElsewhere(json(['/r/e2e/CartTest.spec.ts']), '/r/e2e/CartTest.spec.ts'), false);
  assert.equal(definitionElsewhere(json(['/r/e2e/cart-helpers.ts']), '/r/e2e/CartTest.spec.ts'), true);
  assert.equal(definitionElsewhere('not json', '/r/a.ts'), false);
});
