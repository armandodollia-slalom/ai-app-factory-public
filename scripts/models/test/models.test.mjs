import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allowedModels,
  assertProviderUsable,
  availableModels,
  checkConfigs,
  discoverModels,
  loadPolicy,
  ModelNotAllowedError,
  parseCodexModels,
  parseCopilotHelpConfig,
  ProviderDisabledError,
  resolveModel,
  STATIC_CLAUDE_MODELS,
} from '../lib/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The models section is the policy: the pool's entries per CLI (scripts/models/config.json).
const MODELS = {
  cacheTtlSec: 86400,
  pool: [
    { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    { name: 'copilot-opus', cli: 'copilot', model: 'claude-opus-5.5', effort: 'high' },
    { name: 'copilot-sonnet', cli: 'copilot', model: 'claude-sonnet-5.5', effort: 'medium' },
  ],
  agents: { default: 'sonnet' },
};

let n = 0;
function configDir() {
  const dir = path.join(tmp, `cfg-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cacheTtlSec: 86400 }));
  return dir;
}
const base = (models = MODELS) => ({ configDir: configDir(), models });
const cacheFile = () => path.join(tmp, `cache-${n++}.json`);

// A fake command runner: maps "cmd arg arg" to {status, stdout}; anything else is "not installed".
function fakeRunner(table) {
  const calls = [];
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    if (key in table) return { status: 0, stderr: '', error: null, ...table[key] };
    const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    return { status: null, stdout: '', stderr: '', error: err };
  };
  run.calls = calls;
  return run;
}

const COPILOT_HELP = `Configuration Settings:

  \`mouse\`: whatever.
  \`model\`: AI model to use for Copilot CLI, including custom and local models; can be changed with /model command or --model flag option.
    - "claude-sonnet-5.5"
    - "claude-opus-5.5"
    - "claude-haiku-5.5"
    - "gpt-6-sol"

  \`contextTier\`: context window tier.
    - "default"
`;
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: 'gpt-6-sol', visibility: 'list' },
    { slug: 'gpt-5.5', visibility: 'list' },
    { slug: 'codex-auto-review', visibility: 'hide' },
  ],
});

// --- policy ---------------------------------------------------------------------------------------

test('the policy per CLI: the ids of the pool\'s entries on that CLI, default from models.agents.default in the CLI\'s own spelling', () => {
  const opts = base();
  assert.deepEqual(allowedModels('claude', opts), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(allowedModels('copilot', opts), ['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.deepEqual(allowedModels('codex', opts), [], 'no entry on codex: nothing allowed');
  assert.equal(resolveModel('claude', null, opts), 'claude-sonnet-5-5');
  assert.equal(resolveModel('copilot', '', opts), 'claude-sonnet-5.5');
  assert.equal(resolveModel('copilot', 'default', opts), 'claude-sonnet-5.5');
});

test('a one-family pool is a policy with a warning: councils cannot be diverse', () => {
  const policy = loadPolicy(base({ ...MODELS, pool: MODELS.pool.slice(0, 2) }));
  assert.deepEqual(policy.providers.claude.allowed, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.match(policy.warnings.join('\n'), /models\.pool has one model family \(Anthropic\): councils cannot be diverse/);
  assert.deepEqual(loadPolicy(base({ ...MODELS, pool: [...MODELS.pool, { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] })).warnings, []);
});

test('entry names and the CLI\'s own ids resolve', () => {
  const opts = base();
  assert.equal(resolveModel('claude', 'opus', opts), 'claude-opus-5-5');
  assert.equal(resolveModel('claude', 'claude-sonnet-5-5', opts), 'claude-sonnet-5-5');
  assert.equal(resolveModel('copilot', 'claude-opus-5.5', opts), 'claude-opus-5.5');
  assert.equal(resolveModel('copilot', 'copilot-sonnet', opts), 'claude-sonnet-5.5');
  assert.throws(() => resolveModel('claude', 'claude-opus-5.5', opts), ModelNotAllowedError, "another CLI's spelling is not this CLI's id");
  assert.throws(() => resolveModel('claude', 'copilot-opus', opts), ModelNotAllowedError, "another CLI's entry");
});

test('models outside the pool are rejected with the CLI\'s entries', () => {
  const opts = base();
  for (const [provider, model] of [['claude', 'claude-haiku-5-5'], ['claude', 'haiku'], ['claude', 'claude-opus-5'], ['copilot', 'auto'], ['copilot', 'gpt-6-sol']]) {
    assert.throws(
      () => resolveModel(provider, model, opts),
      (e) => e instanceof ModelNotAllowedError && e.provider === provider && e.requested === model && e.allowed.length === 2 && /not in models\.pool/.test(e.message),
    );
  }
});

test('codex is disabled: no pool entry on it', () => {
  const opts = base();
  assert.throws(() => assertProviderUsable('codex', opts), (e) => e instanceof ProviderDisabledError && /no allowed models configured for codex/.test(e.message));
  assert.throws(() => resolveModel('codex', null, opts), ProviderDisabledError);
  assert.throws(() => resolveModel('codex', 'gpt-6-sol', opts), ProviderDisabledError);
  assert.equal(assertProviderUsable('claude', opts), true);
  assert.throws(() => resolveModel('gemini', null, opts), /Unknown model provider/);
});

// --- discovery parsing ----------------------------------------------------------------------------

test('parses the model list from copilot help config', () => {
  assert.deepEqual(parseCopilotHelpConfig(COPILOT_HELP), ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-haiku-5.5', 'gpt-6-sol']);
  assert.deepEqual(parseCopilotHelpConfig('nothing here'), []);
});

test('parses codex debug models JSON', () => {
  assert.deepEqual(parseCodexModels(CODEX_JSON), [
    { id: 'gpt-6-sol', hidden: false },
    { id: 'gpt-5.5', hidden: false },
    { id: 'codex-auto-review', hidden: true },
  ]);
  assert.throws(() => parseCodexModels('{"x":1}'), /no models array/);
});

test('copilot discovery runs the CLI and records aliases', async () => {
  const runner = fakeRunner({ 'copilot --version': { stdout: 'GitHub Copilot CLI 1.0.109.\n' }, 'copilot help config': { stdout: COPILOT_HELP } });
  const d = await discoverModels('copilot', { ...base(), runner, cacheFile: cacheFile() });
  assert.equal(d.installed, true);
  assert.equal(d.source, 'cli');
  assert.equal(d.version, 'GitHub Copilot CLI 1.0.109.');
  assert.deepEqual(d.models[0], { id: 'claude-sonnet-5.5', aliases: ['claude-sonnet-5-5'], source: 'cli' });
});

test('codex discovery falls back to the bundled catalog', async () => {
  const runner = fakeRunner({ 'codex --version': { stdout: 'codex-cli 0.167.1\n' }, 'codex debug models': { status: 1, stdout: '' }, 'codex debug models --bundled': { stdout: CODEX_JSON } });
  const d = await discoverModels('codex', { ...base(), runner, cacheFile: cacheFile() });
  assert.equal(d.source, 'bundled');
  assert.deepEqual(d.models.map((m) => m.id), ['gpt-6-sol', 'gpt-5.5', 'codex-auto-review']);
  assert.equal(d.models[2].hidden, true);
});

test('claude discovery uses the static list without an API key', async () => {
  const runner = fakeRunner({ 'claude --version': { stdout: '2.1.318 (Claude Code)\n' } });
  const d = await discoverModels('claude', { ...base(), runner, env: {}, cacheFile: cacheFile(), fetch: () => assert.fail('no API call without a key') });
  assert.equal(d.source, 'static');
  assert.deepEqual(d.models.map((m) => m.id), STATIC_CLAUDE_MODELS);
});

test('claude discovery pages through the models API when a key is configured', async () => {
  const runner = fakeRunner({ 'claude --version': { stdout: '2.1.318 (Claude Code)\n' } });
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers['x-api-key'], 'sk-test');
    const page = urls.length === 1 ? { data: [{ id: 'claude-opus-5-5' }], has_more: true, last_id: 'claude-opus-5-5' } : { data: [{ id: 'claude-sonnet-5-5' }], has_more: false };
    return { ok: true, json: async () => page };
  };
  const d = await discoverModels('claude', { ...base(), runner, env: { ANTHROPIC_API_KEY: 'sk-test' }, fetch, cacheFile: cacheFile() });
  assert.equal(d.source, 'api');
  assert.deepEqual(d.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.match(urls[1], /after_id=claude-opus-5-5/);
});

test('a missing CLI is reported as not installed and not cached', async () => {
  const file = cacheFile();
  const d = await discoverModels('copilot', { ...base(), runner: fakeRunner({}), cacheFile: file });
  assert.equal(d.installed, false);
  assert.equal(fs.existsSync(file), false);
});

// --- cache ----------------------------------------------------------------------------------------

test('discovery is cached for the TTL and refreshed after it or on --refresh', async () => {
  const file = cacheFile();
  const runner = fakeRunner({ 'copilot --version': { stdout: '1.0\n' }, 'copilot help config': { stdout: COPILOT_HELP } });
  let clock = 1_000_000;
  const opts = { ...base(), runner, cacheFile: file, now: () => clock };
  const first = await discoverModels('copilot', opts);
  assert.equal(first.cached, false);
  assert.equal(runner.calls.length, 2);

  clock += 23 * 3600 * 1000;
  const second = await discoverModels('copilot', opts);
  assert.equal(second.cached, true);
  assert.equal(runner.calls.length, 2);

  const forced = await discoverModels('copilot', { ...opts, refresh: true });
  assert.equal(forced.cached, false);
  assert.equal(runner.calls.length, 4);

  clock += 25 * 3600 * 1000;
  const expired = await discoverModels('copilot', opts);
  assert.equal(expired.cached, false);
  assert.equal(runner.calls.length, 6);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).providers.copilot);
});

// --- availability ---------------------------------------------------------------------------------

test('available models are allowed ∩ discovered', async () => {
  const help = COPILOT_HELP.replace('    - "claude-opus-5.5"\n', '');
  const runner = fakeRunner({ 'copilot --version': { stdout: '1.0\n' }, 'copilot help config': { stdout: help } });
  const a = await availableModels('copilot', { ...base(), runner, cacheFile: cacheFile() });
  assert.deepEqual(a.models, ['claude-sonnet-5.5']);
  assert.equal(a.degraded, false);
  assert.match(a.warning, /not offered by the installed copilot CLI: claude-opus-5.5/);
});

test('static or failed discovery falls back to the allowed list with a warning flag', async () => {
  const opts = { ...base(), env: {}, cacheFile: cacheFile() };
  const fromStatic = await availableModels('claude', { ...opts, runner: fakeRunner({ 'claude --version': { stdout: '2\n' } }) });
  assert.deepEqual(fromStatic.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(fromStatic.degraded, true);
  assert.match(fromStatic.warning, /static list/);

  const failed = await availableModels('copilot', { ...opts, cacheFile: cacheFile(), runner: fakeRunner({ 'copilot --version': { stdout: '1\n' }, 'copilot help config': { status: 1, stdout: '' } }) });
  assert.deepEqual(failed.models, ['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.equal(failed.degraded, true);

  const missing = await availableModels('copilot', { ...opts, cacheFile: cacheFile(), runner: fakeRunner({}) });
  assert.equal(missing.degraded, true);
  assert.match(missing.warning, /not installed/);
});

test('codex availability: disabled even when installed', async () => {
  const runner = fakeRunner({ 'codex --version': { stdout: 'codex-cli 0.167.1\n' }, 'codex debug models': { stdout: CODEX_JSON } });
  const a = await availableModels('codex', { ...base(), runner, cacheFile: cacheFile() });
  assert.equal(a.disabled, true);
  assert.deepEqual(a.models, []);
  assert.equal(a.discovery.installed, true);
  assert.match(a.warning, /no allowed models configured for codex/);
});

// --- check ----------------------------------------------------------------------------------------

function fixtureRepo(files) {
  const root = path.join(tmp, `repo-${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('check passes when every agent names a pool entry', () => {
  const root = fixtureRepo({
    'scripts/models/config.json': { ...MODELS, agents: { default: 'sonnet', 'architecture-reviewer': 'opus', 'pr-check-judge': 'copilot-opus' } },
    'agents/other.agent.md': '---\nname: other\nmodel: inherit\n---\nbody\n',
  });
  const result = checkConfigs({ root });
  assert.deepEqual(result.problems, []);
  // The three agents' entries (an agent file that inherits the session's model is not checked).
  assert.deepEqual(result.checked.slice(0, 3).map((c) => [c.where, c.provider, c.model]), [['models.agents.default', 'claude', 'claude-sonnet-5-5'], ['models.agents.architecture-reviewer', 'claude', 'claude-opus-5-5'], ['models.agents.pr-check-judge', 'copilot', 'claude-opus-5.5']]);
});

test('check reports an agent naming no pool entry, a bad entry, and agent files whose model is not in the pool', () => {
  const root = fixtureRepo({
    'scripts/models/config.json': { ...MODELS, pool: [...MODELS.pool, { name: 'own', cli: 'custom', effort: 'high' }], agents: { default: 'haiku' } },
    'agents/reviewer.agent.md': '---\nname: reviewer\nmodel: "gpt-6-sol"\n---\n',
    '.claude/agents/x.md': '---\nmodel: haiku\n---\n',
  });
  const result = checkConfigs({ root });
  assert.equal(result.ok, false);
  const where = [...new Set(result.problems.map((p) => `${p.file}:${p.where}`))].sort();
  assert.deepEqual(where, ['.claude/agents/x.md:frontmatter model', 'agents/reviewer.agent.md:frontmatter model', 'scripts/models/config.json:models']);
  const pool = result.problems.filter((p) => p.where === 'models').map((p) => p.message).join('\n');
  assert.match(pool, /models\.agents\.default is "haiku", which is not in models\.pool \(entries: opus, sonnet, copilot-opus, copilot-sonnet, own\)/);
  assert.match(pool, /\("own"\)\.cmd must be the command a custom entry runs/);
});

test('this repository\'s pool and every agent\'s entry pass the check', () => {
  const result = checkConfigs({ configDir: path.join(here, '..') });
  assert.deepEqual(result.problems, []);
});

test('the models CLI rejects a model outside the pool', () => {
  const resolve = spawnSync(process.execPath, [path.join(here, '..', 'models.mjs'), 'resolve', '--provider', 'claude', '--model', 'haiku'], { encoding: 'utf8' });
  assert.equal(resolve.status, 1);
  assert.match(resolve.stderr, /not in models\.pool for claude/);
});
