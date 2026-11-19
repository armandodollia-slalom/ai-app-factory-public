// Token usage and cost of every pipeline agent run (.factory/metrics/token-usage.jsonl), committed with the
// story like the other metrics, so it is kept long term and ties each run to its story and epic.
//
// One record per agent run and model (a run that used two models writes two records with one run_id):
// { ts, run_id, story, epic, stage, round, step, agent, agent_ver, mode, cli, model, requested_model,
//   measured, tokens: { input, output, cache_read, cache_write_5m, cache_write_1h }, requests,
//   cache_hit, cache_hit_rate, cost_usd, pricing: { model, effective, tier, rates }, cli_cost_usd,
//   premium_requests, nano_aiu, seconds, ok, timed_out }
// - tokens.input is uncached input only; cache_read and cache_write_* are the rest of the prompt.
// - cost_usd is priced from scripts/pipeline/pricing.json at the time of the run, and `pricing` keeps
//   the rates used, so later price changes never rewrite history. null when the model has no price.
// - measured is false when the CLI reported no usage (timeout, crash, custom command without a report).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTags } from './run-tags.mjs';
import { metricsFile, readMetricsLocal, readTrackedStream } from './state.mjs';
import { activeStory, epicOf } from './stories.mjs';
import { appendJsonl, log, nowIso, readJson, readJsonl } from './util.mjs';

export const USAGE_FILE = 'token-usage.jsonl';
export const PRICING_FILE = 'scripts/pipeline/pricing.json';

export const STAGE_OF_AGENT = {
  implementer: 'implement',
  'pair-implementer': 'implement-pair',
  'pair-verifier': 'implement-verify',
  'pair-ui-verifier': 'implement-ui-verify',
  'architecture-reviewer': 'review',
  'test-planner': 'plan',
  'test-plan-verifier': 'plan-verify',
  'test-automation': 'automation',
  'test-automation-verifier': 'automation-verify',
  'retro': 'lessons',
};

const int = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0);

// claude-haiku-5-5 and claude-haiku-5.5 are the same model; dated ids (…-4-5-20251001) drop the date.
export function normalizeModel(id) {
  if (!id) return null;
  return String(id).toLowerCase().trim().replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

const emptyModel = (model) => ({ model, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: null, cliCostUsd: null, premiumRequests: null, nanoAiu: null });

// `claude -p --output-format json`: the answer is in .result, usage per model in .modelUsage.
export function parseClaudeJson(stdout) {
  let data;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || data.type !== 'result') return null;
  const models = Object.entries(data.modelUsage ?? {}).map(([id, u]) => {
    const split = u.cacheCreationEphemeral5mInputTokens != null || u.cacheCreationEphemeral1hInputTokens != null;
    return {
      ...emptyModel(id),
      input: int(u.inputTokens),
      output: int(u.outputTokens),
      cacheRead: int(u.cacheReadInputTokens),
      cacheWrite5m: split ? int(u.cacheCreationEphemeral5mInputTokens) : int(u.cacheCreationInputTokens),
      cacheWrite1h: split ? int(u.cacheCreationEphemeral1hInputTokens) : 0,
      cliCostUsd: Number.isFinite(u.costUSD) ? u.costUSD : null,
    };
  });
  return { text: typeof data.result === 'string' ? data.result : '', models };
}

// `copilot --usage-output-file`: per-model usage, where inputTokens includes cached tokens.
export function parseCopilotUsage(data) {
  if (!data || typeof data !== 'object' || !data.modelMetrics) return null;
  const models = Object.entries(data.modelMetrics).map(([id, m]) => {
    const u = m.usage ?? {};
    const d = m.tokenDetails ?? {};
    const cacheRead = int(d.cache_read?.tokenCount ?? u.cacheReadTokens);
    const cacheWrite = int(d.cache_write?.tokenCount ?? u.cacheWriteTokens);
    return {
      ...emptyModel(id),
      input: d.input ? int(d.input.tokenCount) : Math.max(0, int(u.inputTokens) - cacheRead - cacheWrite),
      output: int(d.output?.tokenCount ?? u.outputTokens),
      cacheRead,
      cacheWrite5m: cacheWrite,
      requests: m.requests?.count ?? null,
      premiumRequests: m.requests?.cost ?? null,
      nanoAiu: m.totalNanoAiu ?? null,
    };
  });
  return { models };
}

// `codex exec --json`: one turn.completed event per turn, where input_tokens includes cached tokens.
export function parseCodexJsonl(stdout, model) {
  const usage = emptyModel(model ?? 'codex-default');
  let found = false;
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'turn.completed' || !event.usage) continue;
    found = true;
    // Codex CLI 0.167+: input_tokens includes the cached and the cache-written tokens; output_tokens includes the
    // reasoning tokens (input + output = total). Cache writes are counted apart from fresh input, and the reasoning share
    // of the output is kept (dogfood C15: both were missing).
    const cached = int(event.usage.cached_input_tokens);
    const written = int(event.usage.cache_write_input_tokens);
    usage.cacheRead += cached;
    usage.cacheWrite5m += written;
    usage.input += Math.max(0, int(event.usage.input_tokens) - cached - written);
    usage.output += int(event.usage.output_tokens);
    usage.reasoning = (usage.reasoning ?? 0) + int(event.usage.reasoning_output_tokens);
    usage.requests = (usage.requests ?? 0) + 1;
  }
  return found ? { models: [usage] } : null;
}

// A usage file written by a custom agent command (PIPELINE_USAGE_FILE): Claude's or Copilot's format, or
// { models: [{ model, input, output, cacheRead, cacheWrite5m, cacheWrite1h }] }.
export function parseUsageFile(text) {
  if (!text?.trim()) return null;
  const claude = parseClaudeJson(text);
  if (claude) return { models: claude.models };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const copilot = parseCopilotUsage(data);
  if (copilot) return copilot;
  if (Array.isArray(data?.models)) return { models: data.models.map((m) => ({ ...emptyModel(m.model), ...m })) };
  return null;
}

// The engine's own price table (it is not in the application repository). A repository may override it with
// .factory/pricing.json; a checkout with the engine inside it (scripts/pipeline/pricing.json at its root, as
// the factory's own tests set up) uses that one.
const ENGINE_PRICING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pricing.json');
let pricingCache = null;
export function loadPricing(config) {
  const file = [path.join(config.root, '.factory', 'pricing.json'), path.join(config.root, PRICING_FILE)].find((f) => fs.existsSync(f)) ?? ENGINE_PRICING;
  if (pricingCache?.file !== file) pricingCache = { file, pricing: readJson(file, { models: {} }) };
  return pricingCache.pricing;
}

// The price in effect at `ts`: the last entry whose effective date is on or before it.
export function priceFor(pricing, model, ts) {
  const entries = pricing.models?.[normalizeModel(model)];
  if (!entries?.length) return null;
  const day = ts.slice(0, 10);
  return [...entries].filter((e) => !e.effective || e.effective <= day).sort((a, b) => (a.effective ?? '').localeCompare(b.effective ?? '')).at(-1) ?? null;
}

const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

export function costOf(pricing, usage, ts) {
  const entry = priceFor(pricing, usage.model, ts);
  if (!entry) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  // The long-context tier is per request; without a request count the run is treated as one request.
  const perRequest = prompt / Math.max(1, usage.requests ?? 1);
  const long = entry.longContext && perRequest > entry.longContext.aboveInputTokens;
  const rates = Object.fromEntries(RATE_KEYS.map((k) => [k, (long ? entry.longContext[k] : undefined) ?? entry[k] ?? 0]));
  const usd = RATE_KEYS.reduce((sum, k) => sum + usage[k] * rates[k], 0) / 1e6;
  return { usd: Math.round(usd * 1e6) / 1e6, pricing: { model: normalizeModel(usage.model), effective: entry.effective ?? null, tier: long ? 'long-context' : 'standard', rates } };
}

const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export function usageRecords(config, { ctx = {}, agent, agentVer = null, mode, cli, alias = null, modelId = null, models = [], seconds = null, ok = null, timedOut = false, runId, ts = nowIso(), api = null, cwd = null, session = null }) {
  // Callers pass the story (null for work outside any story); otherwise it is the active story.
  const story = 'story' in ctx ? (ctx.story ?? null) : attempt(() => activeStory(config)?.key ?? null);
  const epic = story ? attempt(() => epicOf(config, story)?.key ?? null) : null;
  const common = {
    ts,
    run_id: runId,
    story,
    epic,
    stage: ctx.stage ?? STAGE_OF_AGENT[agent] ?? agent,
    round: ctx.round ?? null,
    step: ctx.step ?? null,
    // A council member's run: which member and which login (its CLI home as configured, never expanded).
    ...(ctx.member ? { member: ctx.member, login: ctx.login ?? 'default' } : {}),
    agent,
    agent_ver: agentVer,
    mode,
    cli,
    requested_model: alias,
    seconds,
    ok,
    timed_out: Boolean(timedOut),
    // Where the agent ran and its CLI session, so an audit finds every session of a run from the run's own records,
    // delegated and subtask ones included (council C9: an audit from a list of worktrees missed two pair worktrees).
    cwd,
    session,
    // How the provider behaved during the run (provider-health.mjs): re-sent requests, time lost, errors, start delay.
    ...(api ? { api: { requests: api.requests, resent: api.resent, stalled_sec: api.stalledSec, errors: api.errors, rate_limited: api.rateLimited, overloaded: api.overloaded, startup_sec: api.startupSec } } : {}),
    ...runTags(),
  };
  if (!models.length) {
    return [{ ...common, model: normalizeModel(modelId ?? alias), measured: false, tokens: null, requests: null, cache_hit: null, cache_hit_rate: null, cost_usd: null, pricing: null, cli_cost_usd: null, premium_requests: null, nano_aiu: null }];
  }
  const pricing = loadPricing(config);
  return models.map((u) => {
    const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    const cost = costOf(pricing, u, ts);
    return {
      ...common,
      model: normalizeModel(u.model),
      measured: true,
      tokens: { input: u.input, output: u.output, cache_read: u.cacheRead, cache_write_5m: u.cacheWrite5m, cache_write_1h: u.cacheWrite1h, ...(u.reasoning ? { reasoning_in_output: u.reasoning } : {}) },
      requests: u.requests,
      cache_hit: u.cacheRead > 0,
      cache_hit_rate: prompt ? Math.round((u.cacheRead / prompt) * 1000) / 1000 : 0,
      cost_usd: cost?.usd ?? null,
      pricing: cost?.pricing ?? null,
      cli_cost_usd: u.cliCostUsd,
      premium_requests: u.premiumRequests,
      nano_aiu: u.nanoAiu,
    };
  });
}

// Never lets a usage problem break the agent run.
export function recordUsage(config, fields) {
  try {
    const records = usageRecords(config, fields);
    appendJsonl(metricsFile(config, USAGE_FILE), records);
    for (const r of records) if (r.measured && r.cost_usd == null) log(`no price for model ${r.model} in ${PRICING_FILE}; its tokens are recorded unpriced`);
    return records;
  } catch (error) {
    log(`could not record token usage: ${error.message}`);
    return [];
  }
}

// Sums usage records (one agent run, or many) for callers that attribute cost themselves, such as the
// implement harness's subtask records. Unmeasured or unpriced records leave their part null-safe:
// `costUsd` is null only when nothing was priced; `unpriced` counts measured records without a price.
export function summarizeUsage(records = []) {
  const sum = { runs: 0, measured: 0, unpriced: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 }, costUsd: null, premiumRequests: null, nanoAiu: null };
  const runs = new Set();
  const add = (field, value) => {
    if (value == null) return;
    sum[field] = Math.round(((sum[field] ?? 0) + value) * 1e6) / 1e6;
  };
  for (const r of records) {
    runs.add(r.run_id ?? r);
    if (!r.measured) continue;
    sum.measured++;
    const t = r.tokens ?? {};
    const write = (t.cache_write_5m ?? 0) + (t.cache_write_1h ?? 0);
    sum.tokens.input += t.input ?? 0;
    sum.tokens.output += t.output ?? 0;
    sum.tokens.cache_read += t.cache_read ?? 0;
    sum.tokens.cache_write += write;
    sum.tokens.total += (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + write;
    if (r.cost_usd == null) sum.unpriced++;
    add('costUsd', r.cost_usd);
    add('premiumRequests', r.premium_requests);
    add('nanoAiu', r.nano_aiu);
  }
  sum.runs = runs.size;
  return sum;
}

// Adds two summaries (from summarizeUsage); either may be null.
export function addUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const plus = (x, y) => (x == null && y == null ? null : Math.round(((x ?? 0) + (y ?? 0)) * 1e6) / 1e6);
  return {
    runs: a.runs + b.runs,
    measured: a.measured + b.measured,
    unpriced: a.unpriced + b.unpriced,
    tokens: Object.fromEntries(Object.keys(a.tokens).map((k) => [k, (a.tokens[k] ?? 0) + (b.tokens[k] ?? 0)])),
    costUsd: plus(a.costUsd, b.costUsd),
    premiumRequests: plus(a.premiumRequests, b.premiumRequests),
    nanoAiu: plus(a.nanoAiu, b.nanoAiu),
  };
}

// A record stored without a price (its model had none when it was recorded, or the price table was not found)
// is priced when it is read, at the price in effect on its own date; `priced_on_read` marks it.
export function withPrice(config, row) {
  if (!row?.measured || row.cost_usd != null || !row.tokens || !row.ts) return row;
  const k = row.tokens;
  const cost = costOf(loadPricing(config), { model: row.model, input: k.input ?? 0, output: k.output ?? 0, cacheRead: k.cache_read ?? 0, cacheWrite5m: k.cache_write_5m ?? 0, cacheWrite1h: k.cache_write_1h ?? 0, requests: row.requests ?? null }, row.ts);
  return cost ? { ...row, cost_usd: cost.usd, pricing: cost.pricing, priced_on_read: true } : row;
}

export const loadUsage = (config) => readMetricsLocal(config, USAGE_FILE).map((r) => withPrice(config, r));

// Usage from every git worktree of the repo (each `implement run` ticket and group has one, and its records
// reach main only when its branch merges), deduplicated: a group branch carries its tickets' records too.
export function loadUsageAcrossWorktrees(config, { worktrees = gitWorktrees(config.root) } = {}) {
  const seen = new Set();
  const rows = [];
  for (const dir of [config.root, ...worktrees]) {
    const spooled = path.join(dir, config.stateDir ?? '.factory/state', 'metrics-spool', USAGE_FILE);
    for (const row of [...readTrackedStream(path.join(dir, config.metricsDir), USAGE_FILE), ...readJsonl(spooled)].map((r) => withPrice(config, r))) {
      const id = JSON.stringify(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  return rows;
}

function gitWorktrees(root) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  } catch {
    return [];
  }
}

export function readUsageFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    return text;
  } catch {
    return '';
  }
}
