// The metrics sink: where the agents' observability data (decisions, verifier runs, token usage, review
// outcomes: every .factory/metrics/*.jsonl stream) is stored outside the machine that produced it.
//
// The local JSONL files stay the spool: a stage appends to them and never waits on, or fails because of,
// a remote service. `push` ships what is new (a byte offset per stream, kept in .factory/state/sink/);
// `pull` brings a time window back into a local cache, so the retro can read records from other machines,
// CI runs and (with scope "all") other repositories with the same code that reads local files.
//
// `metrics.sink` in .factory/config.json picks the service:
//   { "type": "none" }                                  nothing leaves the machine (default)
//   { "type": "directory", "path": "~/shared/metrics" } a shared folder or mounted bucket     push + pull
//   { "type": "http", "url": "...", "headers": {...} }  a collector that takes and returns NDJSON  push + pull
//   { "type": "command", "push": "...", "pull": "..." } any CLI (aws s3, gsutil, az, psql, bq)  push (+ pull)
//   { "type": "otlp", "endpoint": "...", "headers": {} } OpenTelemetry logs (Datadog, Honeycomb, Grafana...)  push only
// Secrets never go in the config: write "${ENV_VAR}" in a header, URL or command and it is read from the
// environment when used. A sink that can only push cannot feed the retro; `status` says so.
import { guardAdapter } from './redact.mjs';
import { writeText, appendText } from './redact.mjs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setMetricsMerger, stateDir, trackedStreamFiles } from './state.mjs';
import { log, readJson, writeJson } from './util.mjs';
import { fetchWithTimeout } from './external.mjs';
import { expandEnv as expandEnvShared } from './env.mjs';
import { defaultSettings, setting } from './settings.mjs';

export const SINK_TYPES = { none: { push: false, pull: false }, directory: { push: true, pull: true }, http: { push: true, pull: true }, command: { push: true, pull: 'when a pull command is set' }, otlp: { push: true, pull: false } };

const expandEnv = (text, env = process.env) => expandEnvShared(text, env, 'the sink');
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const lineId = (line) => crypto.createHash('sha256').update(line).digest('hex').slice(0, 20);
const host = () => os.hostname().replace(/[^A-Za-z0-9_.-]/g, '-') || 'host';

export function sinkSettings(config) {
  const sink = setting(config, 'metrics.sink');
  // FACTORY_SINK overrides metrics.sink.type for one run (`none` turns the store off).
  const type = process.env.FACTORY_SINK || sink.type || defaultSettings().metrics.sink.type;
  if (!SINK_TYPES[type]) throw new Error(`${process.env.FACTORY_SINK ? 'FACTORY_SINK (metrics.sink.type)' : 'metrics.sink.type'} is "${type}"; use one of ${Object.keys(SINK_TYPES).join(', ')}`);
  const canPull = type === 'command' ? Boolean(sink.pull) : SINK_TYPES[type].pull === true;
  return { ...sink, type, canPush: SINK_TYPES[type].push, canPull, project: config.project?.name ?? path.basename(config.root) };
}

const metricsDir = (config) => path.join(config.root, config.metricsDir);
const sinkDir = (config) => path.join(stateDir(config), 'sink');
const cursorsFile = (config) => path.join(sinkDir(config), 'cursors.json');
export const cacheFile = (config, stream) => path.join(sinkDir(config), 'cache', stream);
// Only the pipeline's own streams (and any a repository names in sink.streams) are shipped (council C7: a throwaway
// probe file under .factory/metrics became a stream in the store).
export const streams = (config) => {
  if (!fs.existsSync(metricsDir(config))) return [];
  const allowed = new Set([...KNOWN_STREAMS, ...(config.metrics?.sink?.streams ?? [])]);
  return [...new Set(fs.readdirSync(metricsDir(config)).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.d')).map((f) => f.replace(/\.d$/, '')))].filter((s) => allowed.has(s)).sort();
};
// Each tracked file of a stream (its own file and the branch shards, state.mjs), with a cursor of its own.
const trackedSources = (config) => streams(config).flatMap((s) => trackedStreamFiles(metricsDir(config), s).filter((f) => fs.existsSync(f)).map((file) => ({ stream: s, file, cursor: path.relative(metricsDir(config), file).replace(/\\/g, '/') })));
// The main checkout's spooled records (pipeline/lib/state.mjs): the same streams, read from the spool, with
// cursors of their own.
const spoolPath = (config) => path.join(stateDir(config), 'metrics-spool');
const spooledStreams = (config) => (fs.existsSync(spoolPath(config)) ? fs.readdirSync(spoolPath(config)).filter((f) => f.endsWith('.jsonl')).sort() : []);
const sources = (config) => [...trackedSources(config), ...spooledStreams(config).map((s) => ({ stream: s, file: path.join(spoolPath(config), s), cursor: `spool/${s}` }))];

// A record as the store sees it: the original fields plus where it came from. `_id` is the hash of the
// original line, so the same record shipped twice (a branch merged into another checkout) is one record.
function envelope(settings, stream, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return { _id: lineId(line), _project: settings.project, _stream: stream.replace(/\.jsonl$/, ''), _host: host(), ...record };
}

// ---- adapters: { push(stream, records), pull(stream, since) -> records } --------------------------

const adapters = {
  directory(settings) {
    const base = path.resolve(expandHome(expandEnv(settings.path ?? '')));
    if (!settings.path) throw new Error('metrics.sink.path is required for a directory sink');
    return {
      async push(stream, records) {
        const file = path.join(base, settings.project, stream.replace(/\.jsonl$/, ''), `${host()}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        appendText(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      },
      async pull(stream, since) {
        const name = stream.replace(/\.jsonl$/, '');
        const projects = settings.scope === 'all' && fs.existsSync(base) ? fs.readdirSync(base) : [settings.project];
        const out = [];
        for (const project of projects) {
          const dir = path.join(base, project, name);
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
            for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
              if (!line.trim()) continue;
              try {
                const r = JSON.parse(line);
                if (!since || !r.ts || r.ts > since) out.push(r);
              } catch { /* a torn line from a concurrent writer */ }
            }
          }
        }
        return out;
      },
    };
  },

  http(settings) {
    if (!settings.url) throw new Error('metrics.sink.url is required for an http sink');
    const headers = () => Object.fromEntries(Object.entries(settings.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]));
    const url = (stream) => `${expandEnv(settings.url).replace(/\/+$/, '')}/${stream.replace(/\.jsonl$/, '')}`;
    return {
      async push(stream, records) {
        const res = await fetchWithTimeout(url(stream), { method: 'POST', headers: { 'content-type': 'application/x-ndjson', ...headers() }, body: records.map((r) => JSON.stringify(r)).join('\n') + '\n' });
        if (!res.ok) throw new Error(`POST ${url(stream)} answered ${res.status}`);
      },
      async pull(stream, since) {
        const q = new URLSearchParams({ ...(since ? { since } : {}), ...(settings.scope === 'all' ? {} : { project: settings.project }) });
        const res = await fetchWithTimeout(`${url(stream)}?${q}`, { headers: { accept: 'application/x-ndjson', ...headers() } });
        if (!res.ok) throw new Error(`GET ${url(stream)} answered ${res.status}`);
        return (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      },
    };
  },

  // The command gets NDJSON on stdin (push) or prints NDJSON (pull), with FACTORY_STREAM, FACTORY_PROJECT
  // and FACTORY_SINCE in its environment.
  command(settings) {
    if (!settings.push) throw new Error('metrics.sink.push (a shell command) is required for a command sink');
    const sh = (cmd, stream, extra, input) => {
      const r = spawnSync(expandEnv(cmd), { shell: true, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: Number(process.env.FACTORY_SINK_TIMEOUT_SEC ?? 600) * 1000, killSignal: 'SIGKILL', env: { ...process.env, FACTORY_STREAM: stream.replace(/\.jsonl$/, ''), FACTORY_PROJECT: settings.project, FACTORY_HOST: host(), ...extra } });
      if (r.status !== 0) throw new Error(`the sink command exited ${r.status}: ${(r.stderr || '').trim().slice(0, 500)}`);
      return r.stdout;
    };
    return {
      async push(stream, records) {
        sh(settings.push, stream, {}, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      },
      async pull(stream, since) {
        return sh(settings.pull, stream, { FACTORY_SINCE: since ?? '' }, '').split('\n').filter((l) => l.trim()).flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
      },
    };
  },

  // OTLP/HTTP JSON logs: one log record per metrics record, the whole record as the body and its scalar
  // fields as attributes, so a backend can filter on stage, story, agent or model without parsing.
  otlp(settings) {
    if (!settings.endpoint) throw new Error('metrics.sink.endpoint is required for an otlp sink');
    const attr = (key, value) => ({ key, value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } });
    return {
      async push(stream, records) {
        const name = stream.replace(/\.jsonl$/, '');
        const body = {
          resourceLogs: [{
            resource: { attributes: [attr('service.name', settings.serviceName ?? 'ai-app-factory'), attr('factory.project', settings.project), attr('host.name', host())] },
            scopeLogs: [{
              scope: { name: `factory.${name}` },
              logRecords: records.map((r) => ({
                timeUnixNano: String(BigInt(Date.parse(r.ts ?? '') || Date.now()) * 1_000_000n),
                severityText: 'INFO',
                body: { stringValue: JSON.stringify(r) },
                attributes: [attr('factory.stream', name), ...Object.entries(r).filter(([k, v]) => !k.startsWith('_') && ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 256).map(([k, v]) => attr(`factory.${k}`, v)), attr('factory.record_id', r._id)],
              })),
            }],
          }],
        };
        const endpoint = `${expandEnv(settings.endpoint).replace(/\/+$/, '')}/v1/logs`;
        const res = await fetchWithTimeout(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(Object.entries(settings.headers ?? {}).map(([k, v]) => [k, expandEnv(v)])) }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`POST ${endpoint} answered ${res.status}`);
      },
    };
  },
};

// Every sink adapter's writes pass the secret gate (redact.mjs guardAdapter): records are exported only redacted.
export function sinkAdapter(config) {
  const settings = sinkSettings(config);
  return settings.type === 'none' ? null : guardAdapter(adapters[settings.type](settings), 'sink', SINK_WRITE_OPS);
}
export const SINK_WRITE_OPS = ['push', 'write', 'send', 'append', 'put'];

// Ships what each stream gained since the last push. A stream is cut at its last complete line, and its
// cursor moves only after the store accepted the batch, so a failed push is retried by the next one.
export async function push(config, { adapter = sinkAdapter(config), batch = 500 } = {}) {
  const settings = sinkSettings(config);
  if (!adapter || !settings.canPush) return { shipped: 0, streams: {}, skipped: 'no sink configured' };
  const cursors = readJson(cursorsFile(config), {});
  const result = { shipped: 0, streams: {} };
  for (const { stream, file, cursor } of sources(config)) {
    const text = fs.readFileSync(file, 'utf8');
    // A file that shrank was rewritten (a rebase, a manual edit): ship it from the start; `_id` dedupes.
    let offset = cursors[cursor]?.offset <= Buffer.byteLength(text) ? cursors[cursor]?.offset ?? 0 : 0;
    const pending = Buffer.from(text).subarray(offset).toString('utf8');
    const complete = pending.slice(0, pending.lastIndexOf('\n') + 1);
    const lines = complete.split('\n').filter((l) => l.trim());
    let sent = 0;
    try {
      for (let i = 0; i < lines.length; i += batch) {
        const chunk = lines.slice(i, i + batch);
        const records = chunk.map((l) => envelope(settings, stream, l)).filter(Boolean);
        if (records.length) await adapter.push(stream, records);
        sent += records.length;
      }
      offset += Buffer.byteLength(complete);
      cursors[cursor] = { offset, pushedAt: new Date().toISOString() };
    } catch (error) {
      result.streams[stream] = { shipped: sent, error: error.message };
      result.failed = true;
      continue;
    }
    result.shipped += sent;
    if (sent) result.streams[stream] = { shipped: (result.streams[stream]?.shipped ?? 0) + sent };
  }
  writeJson(cursorsFile(config), cursors);
  return result;
}

// Brings the store's records since `since` into the local cache (replacing it), one file per stream.
export async function pull(config, { adapter = sinkAdapter(config), since = null, only = null } = {}) {
  const settings = sinkSettings(config);
  if (!adapter || !settings.canPull) return { pulled: 0, streams: {}, skipped: settings.type === 'none' ? 'no sink configured' : `a ${settings.type} sink cannot be read back` };
  const names = only ?? [...new Set([...streams(config), ...(settings.streams ?? KNOWN_STREAMS)])];
  const result = { pulled: 0, streams: {} };
  for (const stream of names) {
    try {
      const records = await adapter.pull(stream, since);
      const seen = new Set();
      const unique = records.filter((r) => (r._id ? !seen.has(r._id) && seen.add(r._id) : true));
      fs.mkdirSync(path.dirname(cacheFile(config, stream)), { recursive: true });
      writeText(cacheFile(config, stream), unique.map((r) => JSON.stringify(r)).join('\n') + (unique.length ? '\n' : ''));
      if (unique.length) result.streams[stream] = { pulled: unique.length };
      result.pulled += unique.length;
    } catch (error) {
      result.streams[stream] = { error: error.message };
      result.failed = true;
    }
  }
  writeJson(path.join(sinkDir(config), 'pulled.json'), { at: new Date().toISOString(), since, type: settings.type });
  return result;
}

export const KNOWN_STREAMS = ['decisions.jsonl', 'decision-outcomes.jsonl', 'verifier-runs.jsonl', 'verifier-denials.jsonl', 'precheck-failures.jsonl', 'calibration.jsonl', 'arch-reviews.jsonl', 'pr-checks.jsonl', 'token-usage.jsonl', 'implement-runs.jsonl', 'subtask-runs.jsonl', 'run-conditions.jsonl', 'full-project-runs.jsonl', 'escalations.jsonl', 'retro-observations.jsonl', 'retro-selftests.jsonl', 'runs.jsonl', 'council-rounds.jsonl', 'council-selections.jsonl', 'council-findings.jsonl', 'analysis-runs.jsonl', 'analysis-findings.jsonl', 'pr-check-returns.jsonl', 'analysis-held.jsonl', 'history-rewrites.jsonl', 'secret-decisions.jsonl', 'analysis-agreement.jsonl', 'analysis-gate.jsonl'];
// Local only: never shipped (a run's own external-call log, the stack's image cache records).
// redact-seen.jsonl: hashes of values the redaction boundary saw, in the state directory; never shipped or committed.
export const LOCAL_STREAMS = ['calls.jsonl', 'images.jsonl', 'redact-seen.jsonl'];

// Local records plus what the last pull cached, without duplicates: what a reader that wants the whole
// picture (the retro) uses in place of the local file alone. Envelope fields are kept; readers ignore them.
export function mergedRecords(config, stream, localRecords) {
  const file = cacheFile(config, stream);
  if (!fs.existsSync(file)) return localRecords;
  const key = (r) => {
    const { _id, _project, _stream, _host, ...rest } = r;
    return _id ?? lineId(JSON.stringify(rest));
  };
  const seen = new Set(localRecords.map((r) => lineId(JSON.stringify(r))));
  const remote = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const extra = remote.filter((r) => !seen.has(key(r)) && seen.add(key(r)));
  return [...localRecords, ...extra].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
}

// Called at the end of a hook: never waits, never throws, never prints into the hook's output.
export function pushInBackground(config, spawnDetached) {
  try {
    if (sinkSettings(config).type === 'none') return false;
    spawnDetached();
    return true;
  } catch (error) {
    log(`metrics sink: ${error.message}`);
    return false;
  }
}

export function status(config) {
  const settings = sinkSettings(config);
  const cursors = readJson(cursorsFile(config), {});
  const pending = {};
  for (const src of trackedSources(config)) {
    const n = Math.max(0, fs.statSync(src.file).size - (cursors[src.cursor]?.offset ?? 0));
    if (n > 0) pending[src.stream] = (pending[src.stream] ?? 0) + n;
  }
  return { type: settings.type, canPush: settings.canPush, canPull: settings.canPull, project: settings.project, pendingBytes: pending, lastPull: readJson(path.join(sinkDir(config), 'pulled.json'), null) };
}

setMetricsMerger(mergedRecords);
