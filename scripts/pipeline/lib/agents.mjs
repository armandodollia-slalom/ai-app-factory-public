import { writeText } from './redact.mjs';
import { AGENT_SECRET_RULE } from './redact.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_ROOT } from './config.mjs';
import { enforceProtected, protectedSnapshot } from './factory-guard.mjs';
import { providerOutage, recordOutage } from './outage.mjs';
import { parseClaudeJson, parseCodexJsonl, parseCopilotUsage, parseUsageFile, readUsageFile, recordUsage, summarizeUsage } from './usage.mjs';
import { addendumText, appendJsonl, killTree, log, nowIso, parseFrontMatter, run, sha } from './util.mjs';
import { claudeRunHealth, claudeTranscriptPath, degraded, describeHealth } from './provider-health.mjs';
import { defaultSettings, setting } from './settings.mjs';
import { agentEnv, entryFor } from './pool.mjs';

// An agent's prompt has three sources, and its version is the hash of all three:
//   base      <install>/agents/<name>.agent.md     shipped by the factory, the same for every repository
//   addendum  <repo>/.factory/agents/<name>.md      what this codebase adds (commands, layout, conventions)
//   lessons   <repo>/.factory/lessons/<name>.md     rules the retro learned here
// <repo>/.factory/agents/<name>.agent.md replaces the base outright: a local override, for a fix that is
// waiting for a factory release. The checkout being worked on wins; the main checkout is the fallback for
// a worktree whose branch predates a file.
const read = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const inRepo = (config, rel) => [config.root, config.mainRoot].filter(Boolean).map((r) => path.join(r, rel)).find((f) => fs.existsSync(f)) ?? null;

export function agentSources(config, name) {
  const overlayDir = setting(config, 'agentOverlayDir');
  const override = inRepo(config, path.join(overlayDir, `${name}.agent.md`));
  const base = override ?? [config.root, INSTALL_ROOT].map((r) => path.join(r, config.agentsDir, `${name}.agent.md`)).find((f) => fs.existsSync(f));
  if (!base) throw new Error(`unknown agent "${name}": no ${config.agentsDir}/${name}.agent.md in the factory install (${INSTALL_ROOT}) and no ${overlayDir}/${name}.agent.md override in the repository`);
  return { base, overridden: Boolean(override), addendum: inRepo(config, path.join(overlayDir, `${name}.md`)), lessons: inRepo(config, path.join(config.lessonsDir, `${name}.md`)) };
}

export function agentDefinition(config, name) {
  const sources = agentSources(config, name);
  const text = read(sources.base);
  const rawAddendum = read(sources.addendum);
  const rawLessons = read(sources.lessons);
  const addendum = addendumText(rawAddendum);
  const body = [parseFrontMatter(text).body.trim(), addendum && `## Project context\n\n${addendum}`].filter(Boolean).join('\n\n');
  // Without an addendum the hash input is what it always was, so versions recorded before stay comparable.
  const version = sha(addendum ? `${text}\n${addendum}\n${rawLessons}` : `${text}\n${rawLessons}`, 8);
  return { name, body, lessons: rawLessons.trim(), version, sources };
}

export function buildPrompt(definition, task) {
  const parts = [definition.body];
  if (definition.lessons) {
    parts.push(`## Lessons from earlier reviews, verifier denials and test failures (follow these)\n\n${definition.lessons}`);
  }
  parts.push(`## Task\n\n${task}`);
  // Every agent and council member, on every CLI (redact.mjs).
  parts.push(AGENT_SECRET_RULE);
  return parts.join('\n\n');
}

// Children get `factory` on PATH (the install's bin/), so the commands their prompts name run as written.
const FACTORY_BIN = path.join(INSTALL_ROOT, 'bin');
const withFactoryBin = (p = '') => (p.split(path.delimiter).includes(FACTORY_BIN) ? p : [FACTORY_BIN, p].filter(Boolean).join(path.delimiter));
const childEnv = (extra = {}) => ({ ...process.env, PATH: withFactoryBin(process.env.PATH), FACTORY_HOME: INSTALL_ROOT, PIPELINE_CHILD: '1', ...extra });

// Git commands no headless agent may run: they move branches, rewrite history or touch other worktrees.
const IMPLEMENT_DENY = ['git push', 'git reset', 'git stash', 'git checkout', 'git switch', 'git rebase', 'git worktree'];
const VERIFY_DENY = [...IMPLEMENT_DENY, 'git commit', 'git merge', 'git add', 'git clean', 'git restore'];
const claudeDeny = (cmds) => cmds.map((c) => `Bash(${c}:*)`);

// Language-server tools of the `lsp` MCP server (scripts/lsp/mcp.mjs, see docs/code-intelligence.md).
// Agents that may edit get the whole server; read-only agents get only the tools that change nothing.
export const LSP_SERVER = 'lsp';
export const INTERCOM_SERVER = 'council_intercom';
export const LSP_MUTATING = ['lsp_rename', 'lsp_code_actions', 'lsp_format_document'];
export const LSP_READ_ONLY = [
  'lsp_goto_definition', 'lsp_goto_type_definition', 'lsp_find_references', 'lsp_find_implementations', 'lsp_hover',
  'lsp_signature_help', 'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_find_symbol', 'lsp_smart_search',
  'lsp_call_hierarchy', 'lsp_type_hierarchy', 'lsp_diagnostics', 'lsp_workspace_diagnostics', 'lsp_index_files',
  'lsp_completions', 'lsp_document_highlights', 'lsp_inlay_hints', 'lsp_selection_range', 'lsp_folding_ranges',
  'lsp_file_imports', 'lsp_file_exports', 'lsp_related_files', 'lsp_server_status',
];
const claudeLspReadOnly = LSP_READ_ONLY.map((t) => `mcp__${LSP_SERVER}__${t}`);

// Claude Code tool lists per mode. Extend `allowed` here (for example with MCP tools such as
// language servers) to give every agent of that mode the tool.
export const CLAUDE_TOOLS = {
  // The implementation agent commits its own work on its feature branch; it never pushes or moves branches.
  implement: {
    permissionMode: 'acceptEdits',
    allowed: ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'TodoWrite', `mcp__${LSP_SERVER}`],
    disallowed: claudeDeny(IMPLEMENT_DENY),
  },
  write: {
    permissionMode: 'acceptEdits',
    allowed: ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'TodoWrite', `mcp__${LSP_SERVER}`],
    disallowed: claudeDeny(['git push', 'git commit', 'git reset', 'git checkout', 'git stash']),
  },
  verify: {
    allowed: ['Bash', 'Read', 'Glob', 'Grep', ...claudeLspReadOnly],
    disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'Agent', 'Task', ...claudeDeny(VERIFY_DENY)],
  },
  read: {
    allowed: ['Read', 'Glob', 'Grep', 'Bash(graphify:*)', ...claudeLspReadOnly],
    disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
  },
};

// The environment of a headless Claude Code agent run (agent.claude in the settings overrides each):
// - promptCacheTtlSec 300 (Claude Code's "5m"; 3600 is its "1h"): an agent run is one short session, so the 1-hour cache Claude Code picks on a Claude
//   subscription is written at 1.6x the price and never read again (dogfood step 5: 78% of a PR check round's
//   cost was 1-hour cache writes; the reference's Copilot runs wrote 5-minute caches);
// - toolSearch false: MCP tools (the language servers) are listed to the agent directly instead of being
//   deferred behind ToolSearch, where an agent told "if the LSP tools are available" never found them.
// The settings' seconds as Claude Code takes them.
const CACHE_TTL = { 300: '5m', 3600: '1h' };
export function claudeEnv(config) {
  const c = { ...defaultSettings().agent.claude, ...(config.agent?.claude ?? {}) };
  return {
    CLAUDE_CODE_PROMPT_CACHE_TTL: CACHE_TTL[c.promptCacheTtlSec] ?? '5m',
    ENABLE_TOOL_SEARCH: String(c.toolSearch),
  };
}

// Modes (the model is the pool entry's own id for its CLI):
//   read       no edits, no shell beyond graphify (reviewers, code verifiers, planning)
//   write      edits and shell, no commits (feature verification agents)
//   implement  edits, shell and commits on the current branch; no push, reset, stash, checkout, switch, rebase, worktree
//   verify     shell (to run Playwright and take screenshots) but no file edit tools and no git writes
//              (UI verifier); the harness also discards anything it leaves in the working tree
// `noSubagents` forbids the agent from spawning its own subagents (Claude's Agent and Task tools).
// Every invocation also reports token usage (`usage` says where): Claude in its JSON result, Copilot in
// `usageFile`, Codex in its JSON event stream, a custom command by writing PIPELINE_USAGE_FILE (optional).
// `effort` (low, medium, high, xhigh, max; a council member's) maps to the CLI's own reasoning-effort option: Claude
// Code's --effort, Codex's model_reasoning_effort (max becomes xhigh, its highest). Copilot's CLI documents no such
// option, so a Copilot member runs at its model's default effort. `cmd` (a council member on cli "custom") runs
// that command like PIPELINE_AGENT_CMD; PIPELINE_AGENT_CMD itself still wins over everything.
// Environment variables carrying a council member's per-room intercom connection (never in the prompt text).
export function intercomEnv(intercom) {
  if (!intercom?.url || !intercom?.token) return {};
  return {
    FACTORY_INTERCOM_URL: intercom.url,
    FACTORY_INTERCOM_TOKEN: intercom.token,
    ...(intercom.roomId ? { FACTORY_INTERCOM_ROOM: intercom.roomId } : {}),
    ...(intercom.seat ? { FACTORY_INTERCOM_SEAT: intercom.seat } : {}),
  };
}

export function cliInvocation(config, { prompt, mode, model, cli = 'claude', noSubagents = false, cwd = config.root, usageFile = null, effort = null, cmd = null, intercom = null }) {
  const iEnv = intercomEnv(intercom);
  if (config.agent.cmd || cmd) {
    // A council member's model and effort reach its command (and a fake agent under PIPELINE_AGENT_CMD) as variables.
    const env = { ...(effort || cmd ? { ...(model ? { PIPELINE_AGENT_MODEL: model } : {}), ...(effort ? { PIPELINE_AGENT_EFFORT: effort } : {}) } : {}), ...iEnv };
    return { cmd: 'sh', args: ['-c', config.agent.cmd || cmd], input: prompt, usage: 'file', cli: 'custom', model, ...(Object.keys(env).length ? { env } : {}) };
  }
  if (cli === 'claude') {
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    const tools = CLAUDE_TOOLS[mode] ?? CLAUDE_TOOLS.read;
    if (tools.permissionMode) args.push('--permission-mode', tools.permissionMode);
    const allowed = [...tools.allowed, ...(intercom?.url ? [`mcp__${INTERCOM_SERVER}`] : [])];
    const disallowed = [...tools.disallowed, ...(noSubagents ? ['Agent', 'Task'] : [])];
    args.push('--allowedTools', allowed.join(','), '--disallowedTools', [...new Set(disallowed)].join(','));
    if (intercom?.url) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: {
          [INTERCOM_SERVER]: {
            type: 'http',
            url: intercom.url,
            headers: { Authorization: 'Bearer ${FACTORY_INTERCOM_TOKEN}' },
          },
        },
      }));
    }
    return { cmd: 'claude', args, input: prompt, usage: 'claude', cli, model, env: { ...claudeEnv(config), ...iEnv } };
  }
  if (cli === 'copilot') {
    const args = ['-p', prompt, '-s', '--no-color'];
    if (usageFile) args.push('--usage-output-file', usageFile);
    if (model) args.push('--model', model);
    const deny = (cmds) => cmds.flatMap((c) => ['--deny-tool', `shell(${c})`]);
    const lspReadOnly = ['--allow-tool', LSP_SERVER, ...LSP_MUTATING.flatMap((t) => ['--deny-tool', `${LSP_SERVER}(${t})`])];
    // Workspace MCP servers (.mcp.json) load only in a trusted folder; worktrees are new folders.
    // The flag takes no value: it trusts the working directory, which is `cwd`.
    args.push('--trust-folder');
    if (mode === 'implement') {
      args.push('--allow-all-tools', '--allow-tool', LSP_SERVER, ...deny(IMPLEMENT_DENY));
    } else if (mode === 'write') {
      args.push('--allow-all-tools', '--allow-tool', LSP_SERVER, '--deny-tool', 'shell(git push)', '--deny-tool', 'shell(git commit)', '--deny-tool', 'shell(git reset)');
    } else if (mode === 'verify') {
      args.push('--allow-tool', 'shell', '--deny-tool', 'write', ...lspReadOnly, ...deny(VERIFY_DENY));
    } else {
      args.push('--deny-tool', 'write', '--deny-tool', 'shell', ...lspReadOnly);
    }
    if (intercom?.url) {
      args.push('--additional-mcp-config', JSON.stringify({
        mcpServers: {
          [INTERCOM_SERVER]: {
            type: 'http',
            url: intercom.url,
            headers: { Authorization: 'Bearer ${FACTORY_INTERCOM_TOKEN}' },
            tools: ['*'],
          },
        },
      }), '--allow-tool', INTERCOM_SERVER);
    }
    return { cmd: 'copilot', args, usage: 'copilot', cli, model, ...(Object.keys(iEnv).length ? { env: iEnv } : {}) };
  }
  if (cli === 'codex') {
    const outFile = path.join(os.tmpdir(), `pipeline-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // Codex has no per-tool deny list; verify mode needs a shell, so it gets workspace-write and the
    // harness discards whatever it leaves behind.
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', mode === 'read' ? 'read-only' : 'workspace-write', '--output-last-message', outFile];
    // A verifier checks the app running on its leased stack slot over localhost, which workspace-write blocks by default
    // (council C9 proof run: every request of a Codex UI verifier failed with curl exit 7). Read mode stays offline.
    if (mode === 'verify') args.push('-c', 'sandbox_workspace_write.network_access=true');
    // An untrusted worktree ignores .codex/config.toml, so the lsp server is defined inline.
    args.push(
      '-c', `mcp_servers.${LSP_SERVER}.command="node"`,
      '-c', `mcp_servers.${LSP_SERVER}.args=${JSON.stringify([path.join(INSTALL_ROOT, 'scripts/lsp/mcp.mjs')])}`,
      '-c', `mcp_servers.${LSP_SERVER}.env_vars=["PIPELINE_AGENT_NAME"]`,
      '-c', `mcp_servers.${LSP_SERVER}.default_tools_approval_mode="approve"`,
    );
    if (mode === 'read' || mode === 'verify') args.push('-c', `mcp_servers.${LSP_SERVER}.disabled_tools=${JSON.stringify(LSP_MUTATING)}`);
    if (intercom?.url) {
      args.push(
        '-c', `mcp_servers.${INTERCOM_SERVER}.url=${JSON.stringify(intercom.url)}`,
        '-c', `mcp_servers.${INTERCOM_SERVER}.bearer_token_env_var="FACTORY_INTERCOM_TOKEN"`,
        '-c', `mcp_servers.${INTERCOM_SERVER}.default_tools_approval_mode="approve"`,
      );
    }
    // The factory's PreToolUse guard (story guard, read and network guards: `factory hook pre-tool`), defined for this
    // run. A headless `codex exec` ignores the repository's .codex/hooks.json (an untrusted folder, and hooks need a
    // persisted trust the user grants interactively), so without this no guard reached a Codex agent; verified with
    // codex-cli 0.167.1. --dangerously-bypass-hook-trust is Codex's switch for automation that vets its own hook
    // sources: this hook is the factory's own command, not a repository's.
    const guard = `${shellQuote(process.execPath)} ${shellQuote(path.join(INSTALL_ROOT, 'bin', 'factory.mjs'))} hook pre-tool`;
    args.push('--dangerously-bypass-hook-trust', '-c', `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(guard)},timeout=10}]}]`);
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort === 'max' ? 'xhigh' : effort}"`);
    args.push('-');
    return { cmd: 'codex', args, input: prompt, outFile, usage: 'codex', cli, model, ...(Object.keys(iEnv).length ? { env: iEnv } : {}) };
  }
  throw new Error(`Unknown agent CLI "${cli}". Use claude, copilot, codex or set PIPELINE_AGENT_CMD.`);
}

// Reads the agent's answer and token usage once its process has exited, and records the usage.
// Returns the answer and a summary of the recorded usage (tokens, cost, premium requests).
function finishRun(config, invocation, { name, mode, entry, modelId, usageFile, usage, version, stdout, status, timedOut, started, cwd }) {
  let output = stdout;
  let models = [];
  if (invocation.outFile) {
    try {
      output = fs.readFileSync(invocation.outFile, 'utf8');
      fs.unlinkSync(invocation.outFile);
    } catch {
      // fall back to stdout
    }
  }
  const fileText = readUsageFile(usageFile);
  try {
    if (invocation.usage === 'claude') {
      const parsed = parseClaudeJson(stdout);
      if (parsed) {
        output = parsed.text;
        models = parsed.models;
      }
    } else if (invocation.usage === 'copilot') {
      models = fileText ? parseCopilotUsage(JSON.parse(fileText))?.models ?? [] : [];
    } else if (invocation.usage === 'codex') {
      models = parseCodexJsonl(stdout, modelId)?.models ?? [];
    } else {
      models = parseUsageFile(fileText)?.models ?? [];
    }
  } catch (error) {
    log(`could not read token usage of ${name}: ${error.message}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  // How the provider behaved (council C12: stalled API requests looked like slow agents).
  const api = invocation.usage === 'claude' ? claudeRunHealth(stdout, cwd) : null;
  if (degraded(api)) {
    log(`agent ${name}: the provider was slow: ${describeHealth(api)}`);
    const file = process.env.FACTORY_EXTERNAL_LOG;
    if (file) {
      try {
        appendJsonl(file, [{ ts: nowIso(), kind: 'provider-slow', story: usage?.story ?? process.env.FACTORY_EXTERNAL_STORY ?? null, agent: name, seconds, ...api }]);
      } catch {
        // informational
      }
    }
  }
  const records = recordUsage(config, {
    api,
    cwd: cwd ?? null,
    session: api?.sessionId ?? sessionOf(invocation, stdout),
    ctx: usage,
    agent: name,
    agentVer: version,
    mode,
    cli: invocation.cli,
    entry: entry?.name ?? null,
    family: entry?.family ?? null,
    modelId,
    models,
    seconds,
    ok: status === 0,
    timedOut,
    runId: randomUUID(),
  });
  return { output, seconds, usage: summarizeUsage(records) };
}

// The CLI's session id from its output when the transcript was not read: Claude's JSON result (session_id), Codex's
// JSON events (thread_id).
function sessionOf(invocation, stdout) {
  const text = String(stdout ?? '');
  if (invocation.usage === 'claude') {
    try {
      return JSON.parse(text.trim())?.session_id ?? null;
    } catch {
      return null;
    }
  }
  return /"thread_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
}

const shellQuote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

const usageFileFor = () => path.join(os.tmpdir(), `pipeline-usage-${process.pid}-${randomUUID()}.json`);

// The run's pool entry (pool.mjs entryFor: a seat's or a subtask's `entry`, else the agent's own models.agents entry)
// gives its CLI, model id, reasoning effort (`effort` overrides it for one run) and process environment. A custom entry
// runs its own `cmd`; PIPELINE_AGENT_CMD (the test fake agent) replaces every CLI and gets the model and effort as
// variables.
function prepare(config, { name, task, mode, entry = null, noSubagents, cwd, promptFile, effort = null, intercom = null }) {
  const definition = agentDefinition(config, name);
  const e = entryFor(config, { name, entry });
  const cmd = e.cli === 'custom' ? e.cmd : null;
  const cli = cmd && !config.agent.cmd ? 'custom' : e.cli;
  effort = effort ?? e.effort ?? null;
  let prompt = buildPrompt(definition, task);
  // Copilot takes its prompt as a command-line argument (capped at 32K chars on Windows, and cmd.exe
  // mangles newlines), so its prompt is written to a file and the agent is told to read it. The file
  // goes under the agent's own working directory: headless Copilot trusts only `cwd` and refuses to
  // read a file outside it (a pair in a subtask worktree whose config.root is the story worktree).
  if (promptFile !== false && !config.agent.cmd && !cmd && cli === 'copilot') {
    // Write it inside the agent's own working directory: a headless Copilot only reads its trusted folder,
    // so a prompt in another worktree (a subtask's parent) would go unread.
    const file = promptFile ?? path.join(cwd, config.stateDir, 'prompts', `${name}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeText(file, prompt);
    prompt = `Read the file ${path.relative(cwd, file).replace(/\\/g, '/')} and follow the instructions in it exactly; it is your complete task.`;
  }
  const modelId = e.model ?? null;
  const usageFile = usageFileFor();
  const invocation = cliInvocation(config, { prompt, mode, model: modelId, cli, noSubagents, cwd, usageFile, effort, cmd, intercom });
  // The entry's own variables (a second login's home folder), expanded when the agent starts; never secrets.
  const entryEnv = agentEnv(e.env);
  log(`agent ${name} (${mode}, ${invocation.cli}, ${e.name}${effort ? `, effort ${effort}` : ''}, prompt ${definition.version}) started`);
  return { definition, invocation, entry: e, modelId, usageFile, entryEnv };
}

// Every agent CLI runs under the supervisor (agent-supervisor.mjs): it is stopped when it stops making progress (no
// transcript or output for agent.idleSec), or at a ceiling of agent.ceilingFactor times its time limit, never at the
// time limit itself (council C12: slow agents must make a run slower, never change its outcome). Claude gets a session
// id up front so its transcript is the heartbeat. PIPELINE_AGENT_SLOW=<factor> makes every agent that many times slower
// (a test mode). Not on Windows shells, where the CLI is a .cmd shim started through cmd.exe.
// Every limit on work that agents do (an agent's own time limit, a stage that runs agents, a wait for such a stage)
// is the usual budget; the run stops only at ceilingFactor times it, or when the work stops making progress
// (agent.supervisor.ceilingFactor, default 10; PIPELINE_CEILING_FACTOR for one run).
export function ceilingFactor(config, env = process.env) {
  const v = Number(env.PIPELINE_CEILING_FACTOR ?? setting(config, 'agent.supervisor.ceilingFactor'));
  return Number.isFinite(v) && v >= 1 ? v : 10;
}
export const ceiling = (config, sec, env = process.env) => (sec ? Math.round(sec * ceilingFactor(config, env)) : sec);

export const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-supervisor.mjs');
export function supervise(config, invocation, { cwd, timeoutSec, env = process.env }) {
  const s = { ...defaultSettings().agent.supervisor, ...(config.agent?.supervisor ?? {}) };
  if (s.enabled === false) return { cmd: invocation.cmd, args: invocation.args, timeoutSec };
  const ceilingSec = ceiling(config, timeoutSec, env);
  let args = invocation.args;
  let heartbeat = null;
  if (invocation.cli === 'claude' && invocation.cmd === 'claude') {
    const id = randomUUID();
    args = [...args, '--session-id', id];
    heartbeat = claudeTranscriptPath(id, cwd, { ...env, ...(invocation.env ?? {}) });
  }
  const slow = Number(env.PIPELINE_AGENT_SLOW ?? 1) || 1;
  return {
    cmd: process.execPath,
    args: [SUPERVISOR, '--idle', String(heartbeat ? s.idleSec : 0), '--ceiling', String(ceilingSec), ...(heartbeat ? ['--heartbeat', heartbeat] : []), ...(slow > 1 ? ['--slow', String(slow)] : []), '--', invocation.cmd, ...args],
    // The supervisor ends the agent first; this outer limit is only a backstop (and covers the slow test mode's hold).
    timeoutSec: ceilingSec * Math.max(1, slow) + 300,
  };
}
// setTimeout fires at once for a delay over 2^31-1 ms (24.8 days): a large ceiling is clamped to that.
const MAX_TIMER_MS = 2 ** 31 - 1;
const supervisorStop = (status, stderr) => status === 124 && /AGENT_SUPERVISOR: (idle|ceiling)/.test(String(stderr));

// A council member's run carries its name and login label into the usage rows (council.mjs memberRunEnv sets both).
export const withMember = (usage, extraEnv = {}) => (extraEnv.PIPELINE_COUNCIL_MEMBER ? { ...usage, member: usage.member ?? extraEnv.PIPELINE_COUNCIL_MEMBER, login: usage.login ?? extraEnv.PIPELINE_COUNCIL_LOGIN ?? 'default', lens: usage.lens ?? extraEnv.PIPELINE_COUNCIL_LENS ?? null } : usage);

const finalize = (config, prepared, { name, mode, usage, cwd }, { stdout, stderr, status, timedOut }, started, guard = null) => {
  if (supervisorStop(status, stderr)) timedOut = true;
  const { definition, invocation, entry, modelId, usageFile } = prepared;
  // The factory's files are not the agent's to change (factoryGuard): whatever got past the PreToolUse
  // guard (a script, a shell trick) is put back here and the run fails.
  const violated = enforceProtected(guard);
  if (violated.length) {
    log(`FACTORY GUARD: agent ${name} changed files that belong to the factory (${violated.join(', ')}); they were restored, its result is discarded and the run counts as failed`);
    status = status === 0 ? 1 : status;
    stderr = `${stderr}\nFactory guard: ${violated.join(', ')} belong to the factory and were restored; report what should change in your result instead.`;
    // A run that needed a restore has no result: the caller treats it as a failed run, never as done.
    stdout = String(stdout).replace(/AGENT_RESULT:.*$/gm, 'AGENT_RESULT_DISCARDED_BY_FACTORY_GUARD');
  }
  const { output, seconds, usage: used } = finishRun(config, invocation, { name, mode, entry, modelId, usageFile, usage, version: definition.version, stdout, status, timedOut, started, cwd });
  log(`agent ${name} finished in ${seconds}s (exit ${status}${timedOut ? ', timed out' : ''})`);
  if (status !== 0 && stderr.trim()) log(stderr.trim().slice(-2000));
  // A quota or usage limit fails every later agent too: record it for the run (see outage.mjs).
  const outage = timedOut ? null : providerOutage({ output, stderr, status });
  if (outage) {
    log(`agent ${name}: the ${invocation.cli} provider is unavailable: ${outage}`);
    recordOutage({ cli: invocation.cli, agent: name, reason: outage });
  }
  return { ok: status === 0 && !outage, status, timedOut, output, version: definition.version, entry: entry.name, family: entry.family, cli: invocation.cli, seconds, usage: used, outage, ...(violated.length ? { factoryGuard: violated } : {}) };
};

// Every call is a brand-new headless process, so each agent (and each verifier round) starts with a
// clean context containing only the prompt built here. `cli` overrides the configured agent CLI for
// this call (for example a verifier on another provider); PIPELINE_AGENT_CMD still wins.
// `usage` ({ stage, story, round, step }) attributes the run's tokens and cost; see usage.mjs. The
// result's `usage` sums what was recorded ({ tokens, costUsd, premiumRequests, ... }).
export function runAgent(config, { name, task, mode = 'read', entry = null, noSubagents = false, cwd = config.root, timeoutSec = 900, extraEnv = {}, usage = {}, effort = null, intercom = null, work = null }) {
  usage = withMember(usage, extraEnv);
  // On Windows, npm-installed CLIs are .cmd shims that only start through a shell, and a Copilot
  // prompt must go through a file (see prepare), exactly as in runAgentAsync.
  const prepared = prepare(config, { name, task, mode, entry, noSubagents, cwd, promptFile: process.platform === 'win32' && !config.agent.cmd ? null : false, effort, intercom });
  const useShell = process.platform === 'win32' && !config.agent.cmd && prepared.invocation.cli !== 'custom';
  const { invocation, usageFile, entryEnv } = prepared;
  const guard = protectedSnapshot(config, cwd, work ?? name);
  const started = Date.now();
  const sup = useShell ? null : supervise(config, invocation, { cwd, timeoutSec });
  const result = run(useShell ? [invocation.cmd, ...invocation.args].map(shellQuote).join(' ') : sup.cmd, useShell ? [] : sup.args, {
    cwd,
    input: invocation.input,
    timeoutSec: sup?.timeoutSec ?? timeoutSec,
    shell: useShell,
    env: childEnv({ ...entryEnv, ...(invocation.env ?? {}), PIPELINE_AGENT_NAME: name, PIPELINE_AGENT_WORK: work ?? name, PIPELINE_AGENT_MODE: mode, PIPELINE_USAGE_FILE: usageFile, ...extraEnv, ...intercomEnv(intercom) }),
  });
  return finalize(config, prepared, { name, mode, usage, cwd }, result, started, guard);
}

// Non-blocking variant of runAgent, so a stage or the implement harness can run several fresh agents in
// parallel. `signal` (an AbortSignal) kills the agent; on Windows a Copilot prompt goes through
// `promptFile` (see prepare).
export function runAgentAsync(config, { name, task, mode = 'read', entry = null, noSubagents = false, cwd = config.root, timeoutSec = 900, extraEnv = {}, promptFile = null, signal, usage = {}, effort = null, intercom = null, work = null }) {
  usage = withMember(usage, extraEnv);
  let prepared;
  try {
    prepared = prepare(config, { name, task, mode, entry, noSubagents, cwd, promptFile, effort, intercom });
  } catch (error) {
    return Promise.reject(error);
  }
  const { invocation, usageFile, entryEnv } = prepared;
  const env = childEnv({ ...entryEnv, ...(invocation.env ?? {}), PIPELINE_AGENT_NAME: name, PIPELINE_AGENT_WORK: work ?? name, PIPELINE_AGENT_MODE: mode, PIPELINE_USAGE_FILE: usageFile, ...extraEnv, ...intercomEnv(intercom) });
  // On Windows, npm-installed CLIs are .cmd shims that only start through a shell.
  const useShell = process.platform === 'win32' && !config.agent.cmd && invocation.cli !== 'custom';
  const guard = protectedSnapshot(config, cwd, work ?? name);
  const started = Date.now();
  const sup = useShell ? null : supervise(config, invocation, { cwd, timeoutSec });
  const limitSec = sup?.timeoutSec ?? timeoutSec;
  return new Promise((resolve) => {
    const child = useShell
      ? spawn([invocation.cmd, ...invocation.args].map(shellQuote).join(' '), { cwd, shell: true, env, windowsHide: true })
      : spawn(sup.cmd, sup.args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const kill = () => {
      // Through a shell the agent is a grandchild that holds the output pipes open, so kill the whole
      // tree and stop waiting on the pipes.
      if (useShell) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      // Elsewhere the child is the agent supervisor, and the agent runs under it: SIGKILL cannot be passed on, so the whole
      // tree goes (an aborted or timed-out run never leaves its agent running).
      else {
        try {
          killTree(child.pid, 'SIGKILL');
        } catch {
          // best effort: the supervisor itself is killed below
        }
      }
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.min(limitSec * 1000, MAX_TIMER_MS));
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.input ?? '');
    const done = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(finalize(config, prepared, { name, mode, usage, cwd }, { stdout, stderr: stderr + extra, status: code, timedOut }, started, guard));
    };
    child.on('error', (error) => done(127, `\n${error.message}`));
    child.on('close', (code) => done(code ?? 1));
  });
}
