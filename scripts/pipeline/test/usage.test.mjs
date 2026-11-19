// Token usage capture, pricing and the cost reports (ticket, epic, overview).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedTicket } from './fixtures/tickets.mjs';
import { runAgent } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';
import { epicReport, formatOverview, formatStory, overviewReport, storyReport, summarize } from '../lib/costs.mjs';
import { addUsage, costOf, loadUsage, loadUsageAcrossWorktrees, normalizeModel, parseClaudeJson, parseCodexJsonl, parseCopilotUsage, priceFor, summarizeUsage, usageRecords } from '../lib/usage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const pricing = {
  models: {
    'claude-sonnet-5.5': [
      { effective: null, input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
      { effective: '2026-10-07', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
    ],
    'claude-haiku-5.5': [{ effective: null, input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, longContext: { aboveInputTokens: 100000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } }],
  },
};
const usage = (model, fields = {}) => ({ model, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: null, ...fields });

describe('usage parsing', () => {
  it('normalizes CLI model ids to pricing keys', () => {
    assert.equal(normalizeModel('claude-haiku-5-5'), 'claude-haiku-5.5');
    assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
    assert.equal(normalizeModel('claude-opus-5.5'), 'claude-opus-5.5');
  });

  it('reads the answer and per-model usage from claude --output-format json', () => {
    const out = JSON.stringify({ type: 'result', result: 'pong', modelUsage: { 'claude-haiku-5-5': { inputTokens: 1174, outputTokens: 18, cacheReadInputTokens: 11873, cacheCreationInputTokens: 15500, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 15500, costUSD: 0.00334513 } } });
    const parsed = parseClaudeJson(out);
    assert.equal(parsed.text, 'pong');
    assert.deepEqual([parsed.models[0].input, parsed.models[0].cacheRead, parsed.models[0].cacheWrite5m, parsed.models[0].cacheWrite1h], [1174, 11873, 0, 15500]);
    // pricing.json reproduces Claude's own list-price cost
    assert.equal(costOf(pricing, { ...parsed.models[0], model: normalizeModel(parsed.models[0].model) }, '2026-07-01T00:00:00Z').usd, 0.003345);
    assert.equal(parseClaudeJson('plain text answer'), null);
  });

  it('separates cached tokens from input in Copilot and Codex usage', () => {
    const copilot = parseCopilotUsage({ modelMetrics: { 'claude-haiku-5.5': { usage: { inputTokens: 27449, outputTokens: 4, cacheReadTokens: 19360, cacheWriteTokens: 8085 }, requests: { count: 1, cost: 1 }, totalNanoAiu: 1200 } } });
    assert.deepEqual([copilot.models[0].input, copilot.models[0].cacheRead, copilot.models[0].cacheWrite5m, copilot.models[0].premiumRequests], [4, 19360, 8085, 1]);
    const codex = parseCodexJsonl(['{"type":"thread.started"}', '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50}}'].join('\n'), 'gpt-5.5');
    assert.deepEqual([codex.models[0].input, codex.models[0].cacheRead, codex.models[0].output, codex.models[0].requests], [200, 800, 50, 1]);
    // Codex CLI 0.167.1 (recorded): cache writes are part of input_tokens and reasoning is part of output_tokens.
    const sol = parseCodexJsonl(['{"type":"turn.completed","usage":{"input_tokens":18552,"cached_input_tokens":12288,"cache_write_input_tokens":2000,"output_tokens":905,"reasoning_output_tokens":900}}', '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'].join('\n'), 'gpt-6.1-sol');
    assert.deepEqual([sol.models[0].input, sol.models[0].cacheRead, sol.models[0].cacheWrite5m, sol.models[0].output, sol.models[0].reasoning], [4264 + 100, 12288, 2000, 910, 900]);
    const [row] = usageRecords({ root: os.tmpdir(), stateDir: '.factory/state' }, { ctx: { story: 'K' }, agent: 'x', mode: 'read', cli: 'codex', runId: 'r', models: sol.models });
    assert.equal(row.tokens.reasoning_in_output, 900);
  });
});

describe('pricing', () => {
  it('uses the price in effect on the day of use', () => {
    assert.equal(priceFor(pricing, 'claude-sonnet-5.5', '2026-10-06T23:00:00Z').cacheRead, 0.2);
    assert.equal(priceFor(pricing, 'claude-sonnet-5.5', '2026-10-07T00:00:00Z').cacheRead, 0.1);
    assert.equal(priceFor(pricing, 'gpt-unknown', '2026-10-07T00:00:00Z'), null);
  });

  it('applies the long-context tier by average prompt per request', () => {
    const big = usage('claude-haiku-5.5', { input: 150000, output: 1000 });
    assert.equal(costOf(pricing, big, '2026-07-01').pricing.tier, 'long-context');
    assert.equal(costOf(pricing, big, '2026-07-01').usd, (150000 * 0.5 + 1000 * 2.5) / 1e6);
    assert.equal(costOf(pricing, { ...big, requests: 3 }, '2026-07-01').pricing.tier, 'standard');
  });
});

describe('cost reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts/pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/pipeline/pricing.json'), JSON.stringify(pricing));
  // The epic is a board ticket in the cache; it names its stories (they are also its sub-issues).
  seedTicket(root, { key: 'epic-demo', type: 'epic', text: '# Epic: Demo\n\n### DEMO-1: a\n### DEMO-2: b\n' });
  const config = { ...loadConfig(null, ROOT), root, metricsDir: '.factory/metrics' };
  const row = (story, stage, runId, models, ts = '2026-07-01T00:00:00Z') => usageRecords(config, { ctx: { story, stage }, agent: 'x', mode: 'headless', cli: 'claude', runId, models, ts });
  const rows = [
    ...row('DEMO-1', 'implement', 'r1', [usage('claude-sonnet-5.5', { input: 1e6, cacheRead: 1e6 }), usage('claude-haiku-5.5', { output: 1e6 })]),
    ...row('DEMO-1', 'review', 'r2', [usage('claude-sonnet-5.5', { output: 1e5 })]),
    ...row('DEMO-1', 'review', 'r3', []),
    ...row('DEMO-2', 'implement', 'r4', [usage('mystery-model', { input: 500 })], '2026-08-01T00:00:00Z'),
  ];

  it('itemizes a ticket by stage with a total', () => {
    const report = storyReport(config, 'DEMO-1', { rows });
    assert.equal(report.epic, 'demo');
    assert.deepEqual(report.stages.map((s) => [s.stage, s.runs, s.costUsd]), [['implement', 1, 2.7], ['review', 2, 1]]);
    assert.equal(report.total.costUsd, 3.7);
    assert.equal(report.total.unmeasuredRuns, 1);
    assert.equal(report.stages[0].cacheHitRate, 0.5);
    assert.deepEqual(Object.keys(report.stages[0].models), ['claude-sonnet-5.5', 'claude-haiku-5.5']);
    assert.match(formatStory(report), /1 run\(s\) reported no token usage/);
  });

  it('rolls tickets up to the epic and the long-term overview', () => {
    const epic = epicReport(config, 'demo', { rows });
    assert.deepEqual(epic.stories.map((s) => [s.story, s.total.costUsd]), [['DEMO-1', 3.7], ['DEMO-2', 0]]);
    assert.equal(epic.total.unpricedTokens, 500);
    const overview = overviewReport(config, { rows, since: '2026-07-15' });
    assert.deepEqual(overview.months.map((m) => m.key), ['2026-08']);
    assert.equal(overview.total.runs, 1);
  });

  it('a cost that leaves out unpriced tokens says so on its own row; tokens per CLI and per council member', () => {
    const sol = usageRecords(config, { ctx: { story: 'DEMO-1', stage: 'council-review', member: 'sol', login: 'CODEX_HOME=~/.codex-personal' }, agent: 'architecture-reviewer', mode: 'read', cli: 'codex', runId: 'r9', models: [usage('gpt-6.1-sol', { input: 2000 })] });
    const all = [...rows, ...sol];
    const text = formatOverview(overviewReport(config, { rows: all }));
    assert.match(text, /mystery-model .* unpriced \(500 tok\)/);
    assert.match(text, /gpt-6.1-sol .* unpriced \(2\.0k tok\)/);
    assert.match(text, /TOTAL .* \$3\.70 \+ 2\.5k tok unpriced/);
    assert.match(text, /By agent CLI \(provider\)[\s\S]*\ncodex .*unpriced \(2\.0k tok\)/);
    assert.match(text, /By council member[\s\S]*sol \(codex, CODEX_HOME=~\/\.codex-personal\)/);
    assert.match(formatStory(storyReport(config, 'DEMO-1', { rows: all })), /By council member[\s\S]*sol \(codex/);
  });
});

describe('runAgent records usage', () => {
  it('writes token-usage.jsonl from a custom agent command via PIPELINE_USAGE_FILE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-run-'));
    after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts/pipeline'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents/echo.agent.md'), '---\nname: echo\n---\nAnswer.\n');
    fs.writeFileSync(path.join(root, 'scripts/pipeline/pricing.json'), JSON.stringify(pricing));
    const agent = path.join(root, 'agent.mjs');
    fs.writeFileSync(agent, "import fs from 'node:fs'; fs.writeFileSync(process.env.PIPELINE_USAGE_FILE, JSON.stringify({ models: [{ model: 'claude-haiku-5-5', input: 50000, output: 0 }] })); console.log('done');\n");
    const base = loadConfig(null, ROOT);
    const config = { ...base, root, metricsDir: '.factory/metrics', agent: { ...base.agent, cmd: `"${process.execPath}" "${agent}"` } };
    const result = runAgent(config, { name: 'echo', task: 'hi', usage: { stage: 'implement', story: 'DEMO-9', round: 2 } });
    assert.equal(result.output.trim(), 'done');
    const [rec] = loadUsage(config);
    assert.deepEqual([rec.story, rec.stage, rec.round, rec.model, rec.measured, rec.cost_usd], ['DEMO-9', 'implement', 2, 'claude-haiku-5.5', true, 0.005]);
    assert.deepEqual([result.usage.runs, result.usage.tokens.total, result.usage.costUsd], [1, 50000, 0.005], 'the run result carries what it recorded');
  });
});

describe('usage summaries', () => {
  const rec = (run, model, tokens, cost, extra = {}) => ({ run_id: run, model, measured: true, tokens: { input: tokens, output: 10, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost_usd: cost, premium_requests: null, nano_aiu: null, ...extra });
  it('summarizeUsage sums tokens, cost and Copilot premium requests; addUsage adds summaries', () => {
    const a = summarizeUsage([rec('r1', 'claude-sonnet-5.5', 100, 0.25, { premium_requests: 1, nano_aiu: 25e9 }), rec('r1', 'claude-opus-5.5', 50, null)]);
    assert.deepEqual([a.runs, a.measured, a.unpriced, a.tokens.total, a.costUsd, a.premiumRequests, a.nanoAiu], [1, 2, 1, 170, 0.25, 1, 25e9]);
    const none = summarizeUsage([{ run_id: 'r2', measured: false }]);
    assert.deepEqual([none.runs, none.costUsd, none.premiumRequests], [1, null, null]);
    const both = addUsage(a, summarizeUsage([rec('r3', 'claude-opus-5.5', 30, 0.5, { premium_requests: 15 })]));
    assert.deepEqual([both.runs, both.tokens.total, both.costUsd, both.premiumRequests], [2, 210, 0.75, 16]);
    assert.equal(addUsage(null, a), a);
  });
  it('cost reports note Copilot premium requests and its metered AI credits next to the computed cost', () => {
    const s = summarize([{ ...rec('r1', 'claude-opus-5.5', 4, 0.141466, { premium_requests: 15, nano_aiu: 14146600000 }), ts: '2026-11-10' }]);
    assert.equal(s.premiumRequests, 15);
    assert.deepEqual(s.copilotCheck, { runs: 1, meteredUsd: 0.141466, computedUsd: 0.141466 });
    const text = formatStory({ story: 'TEST-1', epic: null, stages: [{ stage: 'implement-verify', ...s }], total: s });
    assert.match(text, /Copilot premium requests: 15/);
    assert.match(text, /AI credits worth \$0\.14; \$0\.14 computed/);
  });
});

describe('usage across worktrees', () => {
  it('reads every worktree once and drops the records a stacked branch repeats', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-wt-'));
    after(() => fs.rmSync(base, { recursive: true, force: true }));
    const write = (dir, rows) => {
      fs.mkdirSync(path.join(base, dir, '.factory/metrics'), { recursive: true });
      fs.writeFileSync(path.join(base, dir, '.factory/metrics', 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join(''));
    };
    const a = { ts: '1', story: 'BUG-1', model: 'claude-opus-5.5' };
    const b = { ts: '2', story: 'BUG-2', model: 'claude-sonnet-5.5' };
    write('main', [{ ts: '0', story: null }]);
    write('bug-1', [a]);
    write('group', [a, b]);
    const rows = loadUsageAcrossWorktrees({ root: path.join(base, 'main'), metricsDir: '.factory/metrics' }, { worktrees: [path.join(base, 'bug-1'), path.join(base, 'group'), path.join(base, 'gone')] });
    assert.deepEqual(rows.map((r) => r.ts), ['0', '1', '2']);
  });
});

describe('runAgent and the factory guard', () => {
  it('a pipeline agent that changes a protected file by any means fails, and the file is restored', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-run-')));
    after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, '.factory/policy'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents/sneaky.agent.md'), '---\nname: sneaky\n---\nWork.\n');
    fs.writeFileSync(path.join(root, '.factory/policy/profile.yaml'), 'kind: Profile\n');
    const agent = path.join(root, 'agent.mjs');
    // A write the PreToolUse hook never sees: straight from the agent's process.
    fs.writeFileSync(agent, "import fs from 'node:fs'; fs.writeFileSync('.factory/policy/profile.yaml', 'loosened'); fs.writeFileSync('app.txt', 'ok'); console.log('done'); console.log('AGENT_RESULT: ' + JSON.stringify({ status: 'done' }));\n");
    const base = loadConfig(null, ROOT);
    const config = { ...base, root, metricsDir: '.factory/metrics', agent: { ...base.agent, cmd: `"${process.execPath}" "${agent}"` } };
    const result = runAgent(config, { name: 'sneaky', task: 'hi', mode: 'write', cwd: root });
    assert.equal(result.ok, false);
    assert.deepEqual(result.factoryGuard, ['.factory/policy/profile.yaml']);
    assert.equal(fs.readFileSync(path.join(root, '.factory/policy/profile.yaml'), 'utf8'), 'kind: Profile\n');
    assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'ok', 'application changes stay');
    assert.doesNotMatch(result.output, /AGENT_RESULT:/, 'the run has no result: callers treat it as failed, not done');
  });
});

it('the price table is the engine\'s, not the application\'s; a record stored unpriced is priced when read (dogfood step 5)', async () => {
  const { loadPricing, withPrice } = await import('../lib/usage.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-engine-'));
  const config = { root, metricsDir: '.factory/metrics' };
  const pricing = loadPricing(config);
  assert.ok(pricing.models['claude-opus-5.5'], 'an application repository without scripts/ still gets the engine\'s prices');
  const row = { measured: true, model: 'claude-opus-5.5', ts: '2026-11-13T06:33:00Z', tokens: { input: 1_000_000, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }, cost_usd: null };
  const priced = withPrice(config, row);
  assert.equal(priced.cost_usd, pricing.models['claude-opus-5.5'].at(-1).input);
  assert.equal(priced.priced_on_read, true);
  fs.rmSync(root, { recursive: true, force: true });
});

it('a council member\'s usage rows name the member and its login label (as configured, never expanded)', async () => {
  const { withMember } = await import('../lib/agents.mjs');
  const { memberRunEnv } = await import('../lib/council.mjs');
  const env = memberRunEnv({ name: 'sol', cli: 'codex', env: { CODEX_HOME: '~/.codex-personal' } });
  assert.equal(env.PIPELINE_COUNCIL_LOGIN, 'CODEX_HOME=~/.codex-personal');
  const ctx = withMember({ stage: 'council-review', story: 'K-1' }, env);
  const config = { root: os.tmpdir(), stateDir: '.factory/state' };
  const [row] = usageRecords(config, { ctx, agent: 'architecture-reviewer', mode: 'read', cli: 'codex', runId: 'r', models: [{ model: 'gpt-6.1-sol', input: 10, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }] });
  assert.equal(row.member, 'sol');
  assert.equal(row.login, 'CODEX_HOME=~/.codex-personal');
  assert.deepEqual(row.tokens, { input: 10, output: 2, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
  // Not a member: no member fields.
  const [plain] = usageRecords(config, { ctx: withMember({ story: 'K-1' }, {}), agent: 'x', mode: 'read', cli: 'claude', runId: 'r2', models: [] });
  assert.equal('member' in plain, false);
});
