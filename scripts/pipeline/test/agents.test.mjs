import { fileURLToPath } from 'node:url';
// How agent CLIs are invoked: modes, subagents and each run's CLI (its pool entry's; pool.mjs resolves which).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliInvocation } from '../lib/agents.mjs';

const config = (cmd = null) => ({ agent: { cmd } });
const flag = (args, name) => args[args.indexOf(name) + 1];

test('a custom command (PIPELINE_AGENT_CMD or a custom pool entry) picks its own model; it gets the model and effort as variables', () => {
  assert.deepEqual(cliInvocation(config('my-agent'), { prompt: 'p', mode: 'read', model: 'anything' }).args, ['-c', 'my-agent']);
  assert.deepEqual(cliInvocation(config(), { prompt: 'p', mode: 'read', model: 'm', cli: 'custom', effort: 'low', cmd: 'own' }).env, { PIPELINE_AGENT_MODEL: 'm', PIPELINE_AGENT_EFFORT: 'low' });
});

test('claude modes: implement and read can forbid subagents; verify has a shell but no edits', () => {
  const impl = cliInvocation(config(), { prompt: 'p', mode: 'implement', model: null, noSubagents: true }).args;
  assert.match(flag(impl, '--disallowedTools'), /Bash\(git push:\*\).*Bash\(git worktree:\*\),Agent,Task$/);
  assert.doesNotMatch(flag(cliInvocation(config(), { prompt: 'p', mode: 'implement', model: null }).args, '--disallowedTools'), /Agent/);
  assert.match(flag(impl, '--allowedTools'), /,mcp__lsp$/, 'implementers get the whole lsp server');
  const verify = cliInvocation(config(), { prompt: 'p', mode: 'verify', model: null }).args;
  assert.match(flag(verify, '--allowedTools'), /^Bash,Read,Glob,Grep,mcp__lsp__lsp_goto_definition,.*mcp__lsp__lsp_find_references/);
  const read = flag(cliInvocation(config(), { prompt: 'p', mode: 'read', model: null }).args, '--allowedTools');
  assert.match(read, /mcp__lsp__lsp_diagnostics/);
  assert.doesNotMatch(read, /lsp_rename|lsp_code_actions|lsp_format_document|mcp__lsp,|mcp__lsp$/, 'read-only agents never get mutating lsp tools');
  assert.match(flag(verify, '--disallowedTools'), /^Edit,Write,.*Agent,Task,.*Bash\(git commit:\*\)/);
  assert.ok(!verify.includes('--permission-mode'));
  const copilot = cliInvocation(config(), { cli: 'copilot', prompt: 'p', mode: 'verify', model: 'claude-opus-5.5', cwd: '/repo/wt' }).args;
  assert.deepEqual(copilot.slice(copilot.indexOf('--allow-tool'), copilot.indexOf('--allow-tool') + 4), ['--allow-tool', 'shell', '--deny-tool', 'write']);
  assert.ok(copilot.includes('lsp(lsp_rename)'));
  assert.ok(copilot.includes('--trust-folder'), 'worktrees are trusted so .mcp.json loads');
  assert.equal(copilot[copilot.indexOf('--trust-folder') + 1]?.startsWith('--'), true, '--trust-folder takes no value');
});

test('codex gets the lsp server inline (untrusted worktrees), read-only modes without mutating tools', () => {
  const codexConfig = { agent: { cmd: null } };
  // cliInvocation builds the command for an already-resolved model; the policy (resolveModel) refuses codex today.
  const args = (mode) => cliInvocation(codexConfig, { cli: 'codex', prompt: 'p', mode, model: null, cwd: '/repo/wt' }).args;
  // The MCP server is the engine's (the install root), not a file of the worktree: an app repository holds no engine code.
  assert.ok(args('read').includes(`mcp_servers.lsp.args=${JSON.stringify([fileURLToPath(new URL('../../lsp/mcp.mjs', import.meta.url))])}`));
  assert.ok(args('read').some((a) => a.startsWith('mcp_servers.lsp.disabled_tools=')));
  assert.ok(!args('implement').some((a) => a.startsWith('mcp_servers.lsp.disabled_tools=')));
});

test('copilot: the prompt file is written under the agent\'s cwd, which headless Copilot trusts', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runAgentAsync } = await import('../lib/agents.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-prompt-'));
  const root = path.join(tmp, 'story');
  const cwd = path.join(tmp, 'story--sub');
  const bin = path.join(tmp, 'bin');
  for (const d of [root, cwd, bin]) fs.mkdirSync(d, { recursive: true });
  // A fake copilot that reads the prompt file it was told about, the way the real one would (from cwd).
  fs.writeFileSync(path.join(bin, 'copilot'), '#!/bin/sh\nf=$(printf "%s" "$2" | sed -E "s/^Read the file ([^ ]+) and.*/\\1/")\ncat "$f"\n', { mode: 0o755 });
  const { loadConfig } = await import('../lib/config.mjs');
  const base = loadConfig();
  // The pair implementer runs on a Copilot pool entry.
  const cfg = { ...base, root, agent: { ...base.agent, cmd: null }, models: { pool: [{ name: 'copilot-sonnet', cli: 'copilot', model: 'claude-sonnet-5.5', effort: 'medium' }], agents: { default: 'copilot-sonnet' } } };
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const [a, b] = await Promise.all([1, 2].map((n) => runAgentAsync(cfg, { name: 'pair-implementer', task: `TASK-${n}`, mode: 'implement', cwd, timeoutSec: 30 })));
    assert.equal(a.status, 0);
    assert.match(a.output, /TASK-1/, 'the agent can read its prompt relative to its own cwd');
    assert.match(b.output, /TASK-2/, 'two agents started at once get distinct prompt files');
    const files = fs.readdirSync(path.join(cwd, base.stateDir, 'prompts'));
    assert.equal(files.length, 2);
    assert.equal(fs.existsSync(path.join(root, base.stateDir, 'prompts')), false, 'nothing is written under another worktree');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an agent prompt is the factory base, the repository addendum and the lessons; the version covers all three', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { agentDefinition } = await import('../lib/agents.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-agents-'));
  const config = { root, agentsDir: 'agents', lessonsDir: '.factory/lessons' };
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const base = agentDefinition(config, 'implementer');
  assert.match(base.body, /^# /, 'the base comes from the install when the repository has none');
  assert.doesNotMatch(base.body, /## Project context/);

  put('.factory/agents/implementer.md', '<!-- Addendum skeleton. Fill me in. -->\n\n### Stack\n');
  assert.equal(agentDefinition(config, 'implementer').version, base.version, 'an unfilled skeleton adds nothing');

  put('.factory/agents/implementer.md', '<!-- a note for editors -->\n### Build\n\nRun `cargo build --workspace`.\n');
  const withAddendum = agentDefinition(config, 'implementer');
  assert.match(withAddendum.body, /## Project context\n\n### Build\n\nRun `cargo build --workspace`\.$/);
  assert.doesNotMatch(withAddendum.body, /a note for editors/);
  assert.notEqual(withAddendum.version, base.version);

  put('.factory/lessons/implementer.md', '## L1: Check the borrow\n');
  const withLessons = agentDefinition(config, 'implementer');
  assert.equal(withLessons.lessons, '## L1: Check the borrow');
  assert.notEqual(withLessons.version, withAddendum.version);

  put('.factory/agents/implementer.agent.md', '---\nname: implementer\ndescription: local\n---\n# Local override\n');
  const overridden = agentDefinition(config, 'implementer');
  assert.match(overridden.body, /^# Local override\n\n## Project context/);
  assert.equal(overridden.sources.overridden, true);
  assert.throws(() => agentDefinition(config, 'no-such-agent'), /unknown agent "no-such-agent"/);
});

test('a headless Claude Code agent writes 5-minute prompt caches and sees the MCP tools directly (dogfood step 5)', async () => {
  const { cliInvocation } = await import('../lib/agents.mjs');
  const config = { root: process.cwd(), agent: { cli: 'claude' } };
  const inv = cliInvocation(config, { prompt: 'x', mode: 'read', model: 'sonnet' });
  assert.deepEqual(inv.env, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', ENABLE_TOOL_SEARCH: 'false' });
  const custom = cliInvocation({ ...config, agent: { cli: 'claude', claude: { promptCacheTtlSec: 3600, toolSearch: true } } }, { prompt: 'x', mode: 'read' });
  assert.deepEqual(custom.env, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', ENABLE_TOOL_SEARCH: 'true' });
});
