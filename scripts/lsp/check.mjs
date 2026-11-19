#!/usr/bin/env node
// Smoke test for the "lsp" MCP server: runs mcp.mjs in a checkout over stdio (which starts that checkout's
// lspd daemon if needed), lists its tools and asks each configured language server about a real file:
// hover, definition and references when a symbol position is given, document symbols otherwise, and
// diagnostics either way.
//
// Usage: factory lsp check [--root <checkout>] [--only <id>,<id>...] [--wait <seconds>]
//        node <install root>/scripts/lsp/check.mjs ...
// Probes come from `lsp.check` in .factory/config.json: [[serverId, file, line, column], ...] (1-based position
// of a symbol; 0, 0 or omitted = no position). With none configured, one tracked file per configured server
// is picked by extension. --wait (default 0) retries a server that answers "unavailable" (still loading)
// for up to that many seconds.
// Exit code 0 when every probed server answered.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitionElsewhere, isMain, loadConfig, realWorktree, worktreeOf } from './lib/common.mjs';

// One existing file per server, by extension: the shortest tracked path, so the pick is stable.
export function defaultProbes(config, root) {
  const listed = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  const files = (listed.stdout ?? '').split('\n').filter(Boolean);
  const probes = [];
  for (const server of config.servers) {
    const candidates = files.filter((f) => server.extensions.includes(path.extname(f).toLowerCase()) && fs.existsSync(path.join(root, f)));
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b));
    if (candidates.length) probes.push([server.id, candidates[0], 0, 0]);
  }
  return probes;
}

export function probesFor(config, root, only = []) {
  const configured = (config.check ?? []).map(([id, file, line = 0, column = 0]) => [id, file, line, column]);
  const probes = configured.length ? configured : defaultProbes(config, root);
  return probes.filter(([id]) => !only.length || only.includes(id));
}

async function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const root = realWorktree(opt('root', null) ?? worktreeOf(process.cwd()));
  const only = (opt('only', '') ?? '').split(',').filter(Boolean);
  const waitMs = Number(opt('wait', 0)) * 1000;
  const config = loadConfig(root);
  const probes = probesFor(config, root, only);

  const mcp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.mjs');
  const child = spawn(process.execPath, [mcp], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.on('exit', (code) => {
    if (pending.size) {
      console.log(`the lsp MCP server exited (${code}) before answering`);
      process.exit(1);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const callOnce = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    const text = res.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res.error);
    return { ok: !res.error && !res.result?.isError, text };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A leased server that is still preparing or loading answers "unavailable" at once: wait for it when asked to.
  const call = async (name, args) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await callOnce(name, args);
      if (r.ok || !/language server unavailable/.test(r.text) || Date.now() >= deadline) return r;
      await sleep(3000);
    }
  };
  const short = (s, n = 160) => s.replace(/\s+/g, ' ').slice(0, n);

  let failed = 0;
  const started = Date.now();
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lsp-check', version: '1' } });
  console.log(`root: ${root}`);
  console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
  console.log(`configured: ${config.servers.map((s) => s.id).join(', ') || 'no language servers'}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await request('tools/list', {})).result.tools;
  console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

  const probed = new Set();
  for (const [id, rel, line, column] of probes) {
    const file = path.resolve(root, rel);
    if (!config.servers.some((s) => s.id === id)) {
      console.log(`\n[${id}] ERR no such server in the lsp configuration`);
      failed++;
      continue;
    }
    if (!fs.existsSync(file)) {
      console.log(`\n[${id}] skipped, ${rel} not found`);
      continue;
    }
    probed.add(id);
    const t0 = Date.now();
    console.log(`\n[${id}] ${rel}`);
    const results = [];
    if (line) {
      // The first request also waits for the server to load the workspace.
      results.push(['hover', await call('lsp_hover', { file_path: file, line, column })]);
      // A probe symbol is defined in another file (configuration.md, lsp.check): a definition inside the probe
      // file is the import binding of a server that has not loaded the project. Ask again until it resolves.
      let def = await call('lsp_goto_definition', { file_path: file, line, column });
      const until = Date.now() + Math.max(waitMs, 60_000);
      while (def.ok && !definitionElsewhere(def.text, file) && Date.now() < until) {
        await sleep(2000);
        def = await call('lsp_goto_definition', { file_path: file, line, column });
      }
      if (def.ok && !definitionElsewhere(def.text, file)) def = { ok: false, text: `the definition stays in ${rel} (${short(def.text)}): the server answers without having loaded the project, or the probe's symbol is not defined in another file` };
      results.push(['definition', def]);
      results.push(['references', await call('lsp_find_references', { file_path: file, line, column, include_declaration: true })]);
    } else {
      results.push(['symbols', await call('lsp_document_symbols', { file_path: file })]);
    }
    results.push(['diagnostics', await call('lsp_diagnostics', { file_path: file })]);
    for (const [what, r] of results) {
      if (!r.ok) failed++;
      let summary = short(r.text);
      try {
        const data = JSON.parse(r.text);
        const list = data.references ?? data.definitions ?? data.symbols ?? data.diagnostics;
        if (Array.isArray(list)) {
          const where = [...new Set(list.map((x) => x.path && `${path.relative(root, x.path)}:${x.line}`).filter(Boolean))];
          summary = `${list.length} result(s)${where.length ? ` ${where.slice(0, 4).join(', ')}${where.length > 4 ? ', ...' : ''}` : ''}`;
        }
      } catch {
        // not JSON: keep the text
      }
      console.log(`  ${r.ok ? 'ok ' : 'ERR'} ${what}: ${summary}`);
    }
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const unprobed = config.servers.map((s) => s.id).filter((id) => !probed.has(id) && (!only.length || only.includes(id)));
  if (unprobed.length) console.log(`\nnot probed: ${unprobed.join(', ')}`);
  console.log(`\n${failed ? `${failed} call(s) failed` : 'all calls answered'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  child.kill();
  process.exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
