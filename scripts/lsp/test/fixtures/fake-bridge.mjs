#!/usr/bin/env node
// Stand-in for lsp-mcp-server in lspd tests (LSP_MCP_SERVER points at it), so they need no npm install.
// Like the real bridge it reads .lsp-mcp.json from its working directory, speaks MCP over stdio as JSON lines,
// and starts the configured language servers over stdio (on lsp_start_server, or lazily on the first call for
// a file) with the configured command, args and env.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.lsp-mcp.json'), 'utf8'));
const TOOLS = ['lsp_hover', 'lsp_goto_definition', 'lsp_find_references', 'lsp_rename', 'lsp_diagnostics', 'lsp_document_symbols', 'lsp_start_server', 'lsp_stop_server'];
const clients = new Map();

function client(cfg) {
  if (clients.has(cfg.id)) return clients.get(cfg.id);
  const proc = spawn(cfg.command, cfg.args, { cwd: process.env.LSP_WORKSPACE_ROOT, env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const write = (msg) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
      if (buf.length < end + 4 + len) return;
      const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
      buf = buf.subarray(end + 4 + len);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.once('error', reject);
      proc.once('exit', () => reject(new Error(`${cfg.id} exited`)));
      write({ id, method, params });
    });
  const c = { proc, request, write, ready: null };
  c.ready = request('initialize', { processId: process.pid, rootUri: null, capabilities: {} }).then(() => write({ method: 'initialized', params: {} }));
  c.ready.catch(() => clients.delete(cfg.id));
  proc.on('exit', () => clients.delete(cfg.id));
  clients.set(cfg.id, c);
  return c;
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args) {
  const cfg = args.server_id ? config.servers.find((s) => s.id === args.server_id) : config.servers.find((s) => s.extensions.includes(path.extname(args.file_path ?? '')));
  if (!cfg) return text(`no language server for ${args.server_id ?? args.file_path}`, true);
  if (name === 'lsp_stop_server') {
    const c = clients.get(cfg.id);
    if (c) {
      await c.request('shutdown', null).catch(() => {});
      c.write({ method: 'exit' });
    }
    return text('stopped');
  }
  try {
    const c = client(cfg);
    await c.ready;
    if (name === 'lsp_start_server') return text(`started ${cfg.id}`);
    if (name === 'lsp_hover') return text(JSON.stringify((await c.request('textDocument/hover', { textDocument: { uri: `file://${args.file_path}` }, position: { line: 0, character: 0 } })).result));
    if (name === 'lsp_diagnostics') {
      // A file containing the word ERROR has one error, so tests can exercise the edit hook.
      const bad = fs.readFileSync(args.file_path, 'utf8').includes('ERROR');
      return text(JSON.stringify({ diagnostics: bad ? [{ severity: 'error', range: { start: { line: 1, column: 1 } }, code: 'E1', message: 'fake error' }] : [] }));
    }
    if (name === 'lsp_document_symbols') return text(JSON.stringify({ symbols: [] }));
    return text(`${name} is not implemented by the fake bridge`, true);
  } catch (error) {
    return text(`Failed to start language server: ${cfg.command}: ${error.message}`, true);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-bridge', version: '0' } });
    else if (msg.method === 'tools/list') reply({ tools: TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) });
    else if (msg.method === 'tools/call') callTool(msg.params.name, msg.params.arguments ?? {}).then(reply);
    else reply({});
  }
});
const stop = () => {
  for (const c of clients.values()) c.proc.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
