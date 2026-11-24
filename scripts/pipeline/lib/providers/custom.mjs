// The `custom` adapter of every kind (tracker, host, ci, scanner): each contract operation (contracts.mjs) runs a command
// the repository declares, so a client with an in-house tracker, code host or CI system writes one small script instead
// of forking the factory. docs/providers/custom.md is the guide; this is the protocol:
//
//   settings (in .factory/config.json, under `tracker`, `host`, `ci` or `analysis.commercial`):
//     { "type": "custom", "command": ["node", "scripts/factory-tracker.mjs"],   // argv (a string is split on spaces)
//       "timeoutSec": 60,                                                       // per call (default 60)
//       "env": { "ACME_TOKEN": "${ACME_TOKEN}" },                               // only these variables reach it
//       "label": "Acme Tracker" }
//   stdin  one JSON object: { "protocol": 1, "kind": "tracker", "op": "tickets.get", "args": [...], "settings": {...} }
//          (`settings` is the section as configured: `${NAME}` references, never their values)
//   stdout one JSON object: { "ok": true, "result": <value> } or { "ok": false, "error": "<message>", "code": "<code>" }
//   exit   0 the answer is on stdout; 3 the operation is not supported (UnsupportedError: the harness degrades);
//          4 not found (the operation's null); anything else, a timeout or unreadable JSON is an error.
//   op "describe" (args []) -> { "operations": ["tickets.get", ...], "capabilities": { ... }, "traits": { ... } }:
//          the operations it implements (the rest are unsupported without being called) and what it can do.
//
// Secrets reach the command only through the variables its `env` names (expanded from this process's environment when
// the command starts); they are never on its command line, in the stdin settings or in an error message.
import { spawnSync } from 'node:child_process';
import { CONTRACTS } from './contracts.mjs';
import { expandEnv } from '../env.mjs';
import { UnsupportedError, HostError } from '../hosts/errors.mjs';

export const PROTOCOL = 1;
const ESSENTIAL_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'LANG', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

const argvOf = (command) => (Array.isArray(command) ? command.map(String) : String(command ?? '').trim().split(/\s+/).filter(Boolean));

// The child's environment: the essentials, plus the variables `env` names, expanded here.
function childEnv(settings, env) {
  const out = {};
  for (const k of ESSENTIAL_ENV) if (env[k] != null) out[k] = env[k];
  for (const [k, v] of Object.entries(settings.env ?? {})) out[k] = expandEnv(String(v), env, `the custom ${settings.kind ?? 'adapter'}'s env.${k}`);
  return out;
}

const redact = (text, secrets) => secrets.filter((s) => s && s.length >= 4).reduce((t, s) => t.split(s).join('***'), String(text ?? ''));

// One call of the command. Returns the result, null for "not found"; throws UnsupportedError or an error otherwise.
export function callCommand(kind, settings, op, args = [], { env = process.env, spawn = spawnSync, cwd = settings.root ?? process.cwd() } = {}) {
  const argv = argvOf(settings.command);
  if (!argv.length) throw new HostError(`the custom ${kind} adapter has no command: set ${kind === 'scanner' ? 'analysis.commercial' : kind}.command in .factory/config.json`, { code: 'config' });
  const childEnvironment = childEnv({ ...settings, kind }, env);
  const secrets = Object.keys(settings.env ?? {}).map((k) => childEnvironment[k]);
  const { root: _root, resolveToken: _rt, ...shown } = settings;
  const input = JSON.stringify({ protocol: PROTOCOL, kind, op, args: args.map((a) => (a === undefined ? null : a)), settings: shown });
  const timeoutMs = Math.max(1, Number(settings.timeoutSec ?? CUSTOM_CALL_TIMEOUT_SEC)) * 1000;
  const r = spawn(argv[0], argv.slice(1), { cwd, input, env: childEnvironment, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(argv[0]) && !['node', 'python', 'python3'].includes(argv[0]) });
  const label = `custom ${kind} ${op}`;
  if (r.error?.code === 'ETIMEDOUT' || (r.signal && r.status == null)) throw new HostError(`${label}: timed out after ${timeoutMs / 1000} s`, { code: 'timeout' });
  if (r.error) throw new HostError(`${label}: could not run ${argv[0]} (${r.error.code ?? r.error.message})`, { code: 'cli' });
  if (r.status === 3) throw new UnsupportedError(`${label}: the custom adapter does not support it${r.stdout ? ` (${redact(parse(r.stdout)?.error ?? '', secrets)})` : ''}`);
  if (r.status === 4) return null;
  const out = parse(r.stdout);
  if (r.status !== 0 || !out) throw new HostError(`${label}: exit ${r.status}${out?.error ? `: ${redact(out.error, secrets)}` : r.stderr ? `: ${redact(String(r.stderr).trim().split('\n').pop(), secrets)}` : ': no JSON answer on stdout'}`, { status: r.status, code: out?.code ?? 'cli' });
  if (out.ok === false) {
    if (out.code === 'unsupported') throw new UnsupportedError(`${label}: ${redact(out.error ?? 'not supported', secrets)}`);
    if (out.code === 'not-found') return null;
    throw new HostError(`${label}: ${redact(out.error ?? 'failed', secrets)}`, { code: out.code ?? 'error' });
  }
  return out.result === undefined ? null : out.result;
}

function parse(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // The last line holds the JSON when the command logged before it.
    try {
      return JSON.parse(s.split('\n').pop());
    } catch {
      return null;
    }
  }
}

// The factory's metadata block for trackers that store plain text (a custom tracker that implements no format.*).
const META = /\n*<!-- factory-meta:([A-Za-z0-9+/=]+) -->\s*$/;
const defaultFormat = {
  render: (ticketInfo, text) => ({ body: `${text}\n\n<!-- factory-meta:${Buffer.from(JSON.stringify({ key: ticketInfo?.key ?? null, type: ticketInfo?.type ?? null })).toString('base64')} -->`, meta: { key: ticketInfo?.key ?? null } }),
  parse: (t) => {
    const body = String(t?.body ?? '');
    const m = META.exec(body);
    let meta = {};
    try {
      meta = m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : {};
    } catch {
      /* a damaged marker: no metadata */
    }
    return { content: m ? body.slice(0, m.index) : body, meta, legacy: !m, edited: false };
  },
};

// The adapter object of a kind: every contract operation at its dotted path, calling the command.
// One call's time limit when host/tracker/ci.timeoutSec sets none (their reference rows show it as their default).
export const CUSTOM_CALL_TIMEOUT_SEC = 60;

export function createCustomAdapter(kind, settings, deps = {}) {
  const env = deps.env ?? process.env;
  const call = (op, args) => callCommand(kind, settings, op, args, { env, ...(deps.spawn ? { spawn: deps.spawn } : {}) });
  let described;
  const describe = () => {
    if (described !== undefined) return described;
    try {
      described = call('describe', []) ?? {};
    } catch (error) {
      if (error?.name !== 'UnsupportedError') throw error;
      described = {};
    }
    return described;
  };
  const implemented = (op) => {
    const d = describe();
    return !Array.isArray(d.operations) || d.operations.includes(op);
  };
  const adapter = { type: 'custom', label: settings.label ?? `custom ${kind}` };
  for (const o of CONTRACTS[kind] ?? []) {
    const parts = o.id.split('.');
    let at = adapter;
    for (const p of parts.slice(0, -1)) at = at[p] ??= {};
    at[parts.at(-1)] = (...args) => {
      if (!implemented(o.id)) throw new UnsupportedError(`custom ${kind} ${o.id}: the command does not implement it (its describe answer lists what it does)`);
      return call(o.id, args);
    };
  }
  Object.defineProperty(adapter, 'capabilities', { enumerable: true, get: () => ({ ...(describe().capabilities ?? {}), ...(settings.capabilities ?? {}) }) });
  adapter.describe = describe;
  if (kind === 'host') {
    const slug = settings.repo ?? null;
    Object.assign(adapter.repo, { slug, toString: () => slug ?? '', toJSON: () => slug });
    adapter.hints = settings.hints ?? {};
    adapter.webUrl = settings.url ?? null;
  }
  if (kind === 'tracker') {
    Object.defineProperty(adapter, 'traits', { enumerable: true, get: () => ({ keyFromTitle: false, blockBody: false, ...(describe().traits ?? {}) }) });
    adapter.format = {
      render: (...a) => (implemented('format.render') ? call('format.render', a) : defaultFormat.render(...a)),
      parse: (...a) => (implemented('format.parse') ? call('format.parse', a) : defaultFormat.parse(...a)),
    };
    adapter.setupSteps = () => settings.setupSteps ?? [`Implement the tracker contract in ${argvOf(settings.command).join(' ')} (docs/providers/custom.md), then run \`factory adapter check tracker\`.`];
    const active = adapter.active;
    adapter.active = (...a) => (implemented('active') ? active(...a) : !/^(0|off|false|no)$/i.test(env.PIPELINE_BOARD ?? ''));
    const available = adapter.available;
    adapter.available = (...a) => (implemented('available') ? available(...a) : !/^(0|off|false|no)$/i.test(env.PIPELINE_BOARD ?? '') && env.PIPELINE_TICKETS_OFFLINE !== '1');
  }
  if (kind === 'ci') {
    adapter.prEvents = null;
    const required = adapter.requiredChecks;
    adapter.requiredChecks = (root) => (implemented('requiredChecks') ? required(root) ?? [] : settings.requiredChecks ?? []);
  }
  adapter.sync = adapter;
  return adapter;
}
