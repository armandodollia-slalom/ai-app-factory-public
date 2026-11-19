#!/usr/bin/env node
// stdio LSP proxy in front of the Roslyn language server (roslyn-language-server dotnet tool):
//  - opens the solution, solution filter or project named by ROSLYN_SOLUTION once the client is initialized
//    (set by this pack's scope module; without it, the only .slnx or .sln in the working directory). Roslyn
//    has no command-line flag for it, editors send the custom `solution/open` notification;
//  - records the load state in $LSPD_STATE_FILE (starting -> loading -> ready | exited), which lspd reads to
//    answer "still loading" immediately instead of letting tool calls hang (`"reportsState": true`);
//  - asks Roslyn for pull diagnostics and drops locations inside source-generated files.
// Usage (the `csharp` server entry of packs/dotnet/lsp.json): node roslyn-proxy.mjs <command> [args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [command, ...args] = process.argv.slice(2);
function onlySolution(dir) {
  for (const ext of ['.slnx', '.sln']) {
    const found = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
    if (found.length === 1) return path.join(dir, found[0]);
    if (found.length > 1) process.stderr.write(`roslyn-proxy: several ${ext} files in ${dir}; set lsp.servers[csharp].scope.options.solution\n`);
  }
  return null;
}
const solution = process.env.ROSLYN_SOLUTION || onlySolution(process.cwd());
const stateFile = process.env.LSPD_STATE_FILE || null;
const since = new Date().toISOString();

function setState(state, extra = {}) {
  if (!stateFile) return;
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ state, pid: process.pid, solution, since, at: new Date().toISOString(), ...extra }));
  fs.renameSync(tmp, stateFile);
}

const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
setState('starting');

// Minimal LSP framing (Content-Length headers) for both directions.
function framer(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
      const length = match ? Number(match[1]) : 0;
      const end = headerEnd + 4 + length;
      if (buffer.length < end) return;
      const raw = buffer.subarray(0, end);
      const body = buffer.subarray(headerEnd + 4, end).toString('utf8');
      buffer = buffer.subarray(end);
      onMessage(raw, body);
    }
  };
}
const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};
const peek = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
};

process.stdin.on(
  'data',
  framer((raw, body) => {
    const msg = peek(body);
    if (msg.method === 'initialize' && !msg.params?.capabilities?.textDocument?.diagnostic) {
      // Roslyn only reports diagnostics on request (pull). Advertise pull support so it declares a static
      // diagnosticProvider and the client asks for them.
      msg.params.capabilities.textDocument = { ...msg.params.capabilities.textDocument, diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } };
      server.stdin.write(frame(msg));
      return;
    }
    server.stdin.write(raw);
    if (msg.method === 'initialized' && solution) {
      const uri = pathToFileURL(path.resolve(solution)).href;
      const method = /\.(sln|slnx|slnf)$/i.test(solution) ? 'solution/open' : 'project/open';
      server.stdin.write(frame(method === 'solution/open' ? { jsonrpc: '2.0', method, params: { solution: uri } } : { jsonrpc: '2.0', method, params: { projects: [uri] } }));
      setState('loading');
    }
  }),
);
server.stdout.on(
  'data',
  framer((raw, body) => {
    const msg = peek(body);
    if (msg.method === 'workspace/projectInitializationComplete') setState('ready');
    // Locations inside source-generated files (roslyn-source-generated://...) have no file on disk and break
    // file-based clients; drop them from location lists.
    if (Array.isArray(msg.result) && body.includes('roslyn-source-generated:')) {
      const onDisk = (loc) => {
        const uri = loc?.uri ?? loc?.targetUri;
        return typeof uri !== 'string' || uri.startsWith('file:');
      };
      msg.result = msg.result.filter(onDisk);
      process.stdout.write(frame(msg));
      return;
    }
    process.stdout.write(raw);
  }),
);
process.stdin.on('end', () => server.stdin.end());
server.on('exit', (code, signal) => {
  setState('exited', { code, signal });
  process.exit(code ?? 1);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.kill(sig));
