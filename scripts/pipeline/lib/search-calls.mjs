// The searches agents make before they add or judge code (GEN-15, GEN-16): language-server tool calls, which the `lsp`
// MCP server logs to <git-dir>/lsp/calls.jsonl, and graphify commands, which the PreToolUse hook logs here to
// <git-dir>/lsp/graphify-calls.jsonl. Both are { ts, agent, member, tool, file, symbol } (`member`: a council member's seat). Recording is best effort: a hook never
// fails a tool call over its log.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { appendText } from './redact.mjs';
import { readJsonl } from './util.mjs';

const GRAPHIFY_FILE = 'graphify-calls.jsonl';
// The `lsp` MCP server's call log, in the language-server state folder.
export const LSP_FILE = 'calls.jsonl';

// A checkout's language-server state folder, <git-dir>/lsp (the lsp daemon's log and the call logs), from any folder in
// it; null outside a git checkout. The one place that says where it is: scripts/lsp (lib/common.mjs stateDir) and the
// implement stage's adapter (implement/lib/lsp.mjs callsFile) read it here.
export function lspDir(cwd) {
  const r = git(cwd, ['rev-parse', '--git-dir']);
  return r.status === 0 ? path.join(path.resolve(cwd, r.stdout.trim()), 'lsp') : null;
}

// lspDir, created, for a writer: outside a git checkout it throws.
export function lspStateDir(cwd) {
  const dir = lspDir(cwd);
  if (!dir) throw new Error(`not a git checkout: ${cwd}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A call log's records of an agent (or a council member's seat) between two times (ms), with a second's slack on each
// side: the one window both readers of the language-server calls use.
export const callsBetween = ({ agent = null, member = null, from, to = Date.now() }) => (c) => (!agent || c.agent === agent) && (!member || c.member === member) && Date.parse(c.ts) >= from - 1000 && Date.parse(c.ts) <= to + 1000;

// `graphify query|explain|path ...` anywhere in a shell command (alone, after `cd x &&`, in a pipeline).
const GRAPHIFY = /(?:^|[;&|(]\s*|\s)graphify\s+(query|explain|path)\b([^;&|\n]*)/;
// The language-server tools that find or confirm a definition and its callers.
const LSP_SEARCH = /lsp_(workspace_symbols|find_symbol|smart_search|goto_definition|find_references|find_implementations|hover)$/;

const commandOf = (payload) => {
  const c = payload?.tool_input?.command;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.join(' ') : null;
};

// The graphify search a shell tool call makes: { tool, symbol }, or null.
export function graphifySearch(payload) {
  const m = GRAPHIFY.exec(commandOf(payload) ?? '');
  return m ? { tool: `graphify ${m[1]}`, symbol: m[2].trim().replace(/^["']|["']$/g, '') || null } : null;
}

// Logs a pipeline agent's graphify search (PIPELINE_CHILD runs only; a person's own session is not traced).
export function recordGraphifyCall(payload, { env = process.env, now = () => new Date().toISOString() } = {}) {
  if (env.PIPELINE_CHILD !== '1') return false;
  const search = graphifySearch(payload);
  if (!search) return false;
  try {
    const dir = lspStateDir(payload.cwd ?? process.cwd());
    appendText(path.join(dir, GRAPHIFY_FILE), `${JSON.stringify({ ts: now(), agent: env.PIPELINE_AGENT_NAME ?? null, member: env.PIPELINE_COUNCIL_MEMBER ?? null, ...search, file: null })}\n`);
    return true;
  } catch {
    return false;
  }
}

// The searches in a checkout between two times (ms) of an agent, or of a council member (PIPELINE_COUNCIL_MEMBER):
// graphify commands and the language-server lookups.
export function searchCalls(cwd, { agent = null, member = null, from, to = Date.now() }) {
  const dir = lspDir(cwd);
  if (!dir) return [];
  const within = callsBetween({ agent, member, from, to });
  const lsp = readJsonl(path.join(dir, LSP_FILE)).filter((c) => LSP_SEARCH.test(String(c.tool ?? '')));
  return [...readJsonl(path.join(dir, GRAPHIFY_FILE)), ...lsp].filter(within).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
