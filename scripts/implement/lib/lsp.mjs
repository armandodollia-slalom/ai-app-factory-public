// Adapter for the language-server daemons (scripts/lsp/) that agents reach through MCP tools. The
// harness starts one per worktree, asks it for diagnostics on changed files, and reads the agents' LSP
// call log for metrics. Everything goes through here, so a change in that tooling's contract is a change
// here only. When the tooling is missing or a language server is unavailable, every call degrades to
// "no information" and the run carries on (agents fall back to graphify).
//
// Contract (docs/code-intelligence.md):
//   <lspdCmd> start --worktree <path> [--owns <glob>...]
//       -> {"ok":true,"pid":n,"socket":"...","leased":"none|running|unavailable","reason":"...",
//           "servers":{"<id>":{"status":"running|unavailable","state":"...","reason":"..."}}} (idempotent)
//       `servers` lists the leased (heavy) language servers; --owns narrows the ones that have a scope
//       module to the part of the checkout owning those globs. A server still preparing or loading is not a
//       failure, and diagnostics for a language that is not ready come back as {"unavailable": "..."}.
//   <lspdCmd> stop --worktree <path> | status | stop-all
//   <lspdCmd> diagnostics --worktree <path> --files <f...>
//       -> {"ok":true,"files":{"<path>":[{"severity","line","col","code","message"}] | {"unavailable":"..."}}}
//   <setupCmd>, run in a new worktree first (checks that the configured servers can be found)
//   MCP tool calls are logged as JSONL {ts, agent, tool, file, symbol} to <worktree git-dir>/lsp/calls.jsonl.
// The commands are `lsp.client.lspdCmd` and `lsp.client.setupCmd` in the config; relative paths in them
// are looked up in the engine's install root first, then in the app repo.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { appendJsonl, nowIso, readJsonl, runAsync } from '../../pipeline/lib/util.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';

export function gitDir(worktree) {
  const r = git(worktree, ['rev-parse', '--git-dir']);
  return r.status === 0 ? path.resolve(worktree, r.stdout.trim()) : path.join(worktree, '.git');
}

export const callsFile = (worktree) => path.join(gitDir(worktree), 'lsp', 'calls.jsonl');

function lastJson(text) {
  for (const line of String(text).trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // keep looking
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Changed lines that declare a non-private member with a parameter list (a function, method or constructor
// signature) in the common declaration styles. `lsp.client.signaturePattern` (a regular expression source
// matched against each changed line, including its leading + or -) replaces it for a codebase it does not fit.
const SIGNATURE = /^[+-](?![+-])\s*(?:\[[^\]]*\]\s*|@[\w.]+(?:\([^)]*\))?\s*)*(?:public|internal|protected|export|pub|def|func)\b[^=;{]*\(/;
export const signatureChanges = (diff, pattern = SIGNATURE) =>
  String(diff ?? '')
    .split('\n')
    .filter((l) => pattern.test(l))
    .map((l) => l.slice(1).trim());

const isReferences = (tool) => /referen/i.test(String(tool ?? ''));

export function lspAdapter(config, { mainRoot = INSTALL_ROOT, log = () => {} } = {}) {
  const lsp = { ...defaultSettings().lsp.client, ...(config.lsp?.client ?? {}) };
  const resolve = (cmd, roots) => {
    if (!Array.isArray(cmd) || !cmd.length) return null;
    const [head, ...rest] = cmd;
    const args = rest.map((a) => {
      if (!/[/\\]/.test(a) || path.isAbsolute(a)) return a;
      return roots.map((r) => path.join(r, a)).find((f) => fs.existsSync(f)) ?? null;
    });
    return args.includes(null) ? null : [head, ...args];
  };
  const roots = [mainRoot, config.root];
  const lspd = resolve(lsp.lspdCmd, roots);
  const signature = lsp.signaturePattern ? new RegExp(lsp.signaturePattern) : SIGNATURE;
  const down = (reason) => ({ ok: false, leased: 'unavailable', reason, servers: {} });
  const setupCmd = (worktree) => resolve(lsp.setupCmd, [worktree, ...roots]);
  const enabled = lsp.enabled !== false && Boolean(lspd);
  const running = new Map(); // worktree -> start result
  const unavailable = new Map(); // worktree -> [server (reason)] when a run had to go without

  const call = async (cmd, args, cwd) => {
    const r = await runAsync(cmd[0], [...cmd.slice(1), ...args], { cwd, timeoutSec: lsp.timeoutSec });
    return { status: r.status, out: lastJson(r.stdout), stderr: r.stderr };
  };

  return {
    enabled,

    // Starts (or reuses) the daemon for a worktree. With `owns`, language servers that have a scope module
    // load only the part of the checkout that owns those globs (and what it depends on).
    async start(worktree, { owns = null, key = null } = {}) {
      if (!enabled) return down('lsp tooling not installed');
      const setup = setupCmd(worktree);
      if (setup) {
        const r = await call(setup, [], worktree);
        if (r.status !== 0) log(`lsp: setup reported a problem in ${path.basename(worktree)} (exit ${r.status}); starting anyway`);
      }
      const startOnce = async () => {
        const r = await call(lspd, ['start', '--worktree', worktree, ...(owns?.length ? ['--owns', ...owns] : [])], worktree);
        return r.out?.ok ? r.out : down(r.out?.reason ?? r.out?.error ?? (r.stderr.trim().slice(-300) || `lspd start exited ${r.status}`));
      };
      let result = await startOnce();
      // No free slot for a leased server: wait a bounded time for one (another run may be finishing) rather than
      // start without it (dogfood C5); then go on without, and say so (`unavailable`, in the PR body).
      const busy = (res) => Object.values(res.servers ?? {}).some((s) => s.status !== 'running' && /slots are in use/.test(s.reason ?? ''));
      const deadline = Date.now() + lsp.leaseWaitSec * 1000;
      while (busy(result) && Date.now() < deadline) {
        log(`lsp: no free language server slot for ${path.basename(worktree)}; waiting for one (up to ${lsp.leaseWaitSec} s)`);
        await new Promise((r) => setTimeout(r, lsp.leaseWaitPollSec * 1000));
        result = await startOnce();
      }
      if (result.ok) running.set(worktree, result);
      for (const [id, s] of Object.entries(result.servers ?? {})) {
        if (s.status !== 'running') log(`lsp: ${id} language server unavailable for ${path.basename(worktree)} (${s.reason ?? 'no reason given'}); agents fall back to graphify`);
      }
      if (!result.ok) log(`lsp: no language servers for ${path.basename(worktree)} (${result.reason ?? 'no reason given'}); agents fall back to graphify`);
      const missing = Object.entries(result.servers ?? {}).filter(([, v]) => v.status !== 'running').map(([id, v]) => `${id} (${v.reason ?? 'unavailable'})`);
      if (missing.length || !result.ok) {
        unavailable.set(worktree, missing.length ? missing : [result.reason ?? 'language servers unavailable']);
        // Recorded with the story, so every PR body that carries it (single ticket or group) can say so (council C3:
        // a story ran without C#, and its group PR did not say).
        try {
          appendJsonl(metricsFile({ ...config, root: worktree }, 'run-conditions.jsonl'), [{ ts: nowIso(), story: key ?? process.env.PIPELINE_STORY ?? null, kind: 'lsp', worktree: path.basename(worktree), missing: unavailable.get(worktree) }]);
        } catch {
          /* best effort */
        }
      } else unavailable.delete(worktree);
      return result;
    },

    // True when every leased (heavy) language server of the worktree's daemon is running: the servers whose
    // absence means agents had no precise code intelligence for the main language.
    leasedRunning: (worktree) => running.get(worktree)?.leased === 'running',
    // The leased servers a worktree had to go without (after the bounded wait), for the PR body.
    unavailable: (worktree) => unavailable.get(worktree) ?? [],
    signatureChanges: (diff) => signatureChanges(diff, signature),

    // Releases the daemon this run started for a checkout (its lease carries this run's pid), whoever else uses that
    // checkout: the epic planner's daemon in the main checkout held a slot until the run ended (council C3).
    async release(worktree) {
      if (!enabled) return false;
      const runPid = process.env.PIPELINE_RUN_PID;
      if (!runPid) return false;
      running.delete(worktree);
      const r = await call(lspd, ['stop-run', '--run', runPid, '--worktree', worktree], fs.existsSync(worktree) ? worktree : mainRoot);
      if (r.out?.stopped?.length) log(`lsp: released the language servers of ${path.basename(worktree)} (${r.out.stopped.length} daemon(s))`);
      return r.status === 0;
    },

    async stop(worktree) {
      if (!enabled) return false;
      running.delete(worktree);
      const r = await call(lspd, ['stop', '--worktree', worktree], fs.existsSync(worktree) ? worktree : mainRoot);
      return r.status === 0;
    },

    async stopAll() {
      for (const wt of [...running.keys()]) await this.stop(wt);
    },

    // { available, errors: [{file, line, col, code, message}], warnings: [...] } for the given files.
    async diagnostics(worktree, files) {
      const existing = files.filter((f) => fs.existsSync(path.join(worktree, f)));
      if (!enabled || !existing.length) return { available: false, errors: [], warnings: [] };
      const r = await call(lspd, ['diagnostics', '--worktree', worktree, '--files', ...existing], worktree);
      if (!r.out?.ok || !r.out.files) return { available: false, errors: [], warnings: [] };
      const errors = [];
      const warnings = [];
      let available = false;
      for (const [file, list] of Object.entries(r.out.files)) {
        if (!Array.isArray(list)) continue; // "unavailable" for that language
        available = true;
        const rel = path.isAbsolute(file) ? path.relative(worktree, file) : file;
        for (const d of list) {
          const item = { file: rel, line: d.line ?? null, col: d.col ?? null, code: d.code ?? null, message: d.message ?? '' };
          if (String(d.severity).toLowerCase() === 'error' || d.severity === 1) errors.push(item);
          else if (['warning', 2].includes(typeof d.severity === 'string' ? d.severity.toLowerCase() : d.severity)) warnings.push(item);
        }
      }
      return { available, errors, warnings };
    },

    // LSP tool calls an agent made in a worktree between two times (epoch ms).
    calls(worktree, agent, fromMs, toMs = Date.now()) {
      return readJsonl(callsFile(worktree)).filter((c) => (!agent || c.agent === agent) && Date.parse(c.ts) >= fromMs - 1000 && Date.parse(c.ts) <= toMs + 1000);
    },
    isReferences,
  };
}

export function formatDiagnostics(diag, { limit = 40 } = {}) {
  if (!diag?.available) return '(language server diagnostics unavailable)';
  const line = (d, kind) => `- ${kind} ${d.file}${d.line ? `:${d.line}${d.col ? `:${d.col}` : ''}` : ''}${d.code ? ` ${d.code}` : ''}: ${d.message}`;
  const all = [...diag.errors.map((d) => line(d, 'error')), ...diag.warnings.map((d) => line(d, 'warning'))];
  if (!all.length) return 'No errors or warnings in the changed files.';
  return [...all.slice(0, limit), ...(all.length > limit ? [`- ... and ${all.length - limit} more`] : [])].join('\n');
}

export const diagnosticFindings = (diag) =>
  (diag?.errors ?? []).map((d) => ({ severity: 'blocking', source: 'diagnostics', file: d.file, line: d.line, issue: `compiler/analyzer error${d.code ? ` ${d.code}` : ''}: ${d.message}`, fix: 'Fix the error; the harness blocks approval while the changed files have errors.' }));
