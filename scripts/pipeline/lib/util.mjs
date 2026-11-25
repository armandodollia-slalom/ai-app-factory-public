import { installOutputRedaction, redact, redactValue } from './redact.mjs';
import crypto, { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describeCall, externalKind, externalRetries, externalRetryPauseMs, externalTimeoutSec, noteExternal, retrySafe, transientFailure } from './external.mjs';

// A string as a literal inside a regular expression (every special character escaped).
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sha = (text, length = 12) => createHash('sha256').update(text).digest('hex').slice(0, length);

// The markers around the demo video section of a pull request body (pr-video.mjs writes it; other sections go before it).
export const VIDEO_SECTION_START = '<!-- pr-demo-video:start -->';
export const VIDEO_SECTION_END = '<!-- pr-demo-video:end -->';

// True when the module at `metaUrl` is the script node was started with.
export const isMain = (metaUrl) => {
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

export const nowIso = () => new Date().toISOString();

// Console output of every harness process passes the redaction boundary (redact.mjs).
if (process.env.FACTORY_OUTPUT_REDACTION !== '0') installOutputRedaction();

let logTag = 'pipeline';
export const setLogTag = (tag) => (logTag = tag);

// Every log line passes the redaction boundary (redact.mjs).
export function log(...args) {
  process.stderr.write(`[${logTag}] ${redact(args.join(' '))}\n`);
}

// Windows cannot spawn an extensionless shebang script (a repository wrapper script): run it through bash.
function viaBash(cmd, args, cwd) {
  if (process.platform !== 'win32' || path.extname(cmd)) return [cmd, args];
  const file = path.resolve(cwd ?? process.cwd(), cmd);
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString() === '#!') return ['bash', [file.replace(/\\/g, '/'), ...args]];
  } catch {
    // not a local file: a command on PATH
  }
  return [cmd, args];
}

// spawnSync's `input` goes through a socketpair that, on macOS, now and then never reaches end-of-file in
// the child (about 1 call in 400 with a large input): the child blocks reading stdin and spawnSync waits
// for it until its timeout (an agent's: 90 minutes). The input is handed over as a file instead, which a
// reader always finishes.
function stdinFromFile(input) {
  if (input === undefined || input === null) return { stdin: 'pipe', done: () => {} };
  const file = path.join(os.tmpdir(), `factory-stdin-${process.pid}-${crypto.randomUUID()}`);
  fs.writeFileSync(file, input, { mode: 0o600 });
  const fd = fs.openSync(file, 'r');
  fs.rmSync(file, { force: true });
  return { stdin: fd, done: () => fs.closeSync(fd) };
}

export function run(cmd, args, { cwd, input, env, timeoutSec, allowFail = true, shell = false, retries } = {}) {
  // An external call (gh, git, docker, curl) always has a timeout, and one that is safe to repeat is retried after a
  // timeout or a network error (external.mjs). A shell command line is the caller's to bound.
  const kind = shell ? null : externalKind(cmd, args);
  const limit = timeoutSec ?? externalTimeoutSec(kind, env ?? process.env);
  const tries = kind && retrySafe(cmd, args) ? 1 + (retries ?? externalRetries(env ?? process.env)) : 1;
  let out;
  for (let attempt = 1; ; attempt++) {
    out = runOnce(cmd, args, { cwd, input, env, timeoutSec: limit, shell, killSignal: kind ? 'SIGKILL' : 'SIGTERM' });
    if (!kind || !transientFailure(out)) break;
    const what = out.timedOut ? `timed out after ${limit} s` : String(out.stderr).trim().split('\n').pop().slice(0, 200);
    if (attempt >= tries) {
      if (tries > 1 || out.timedOut) noteExternal({ call: describeCall(cmd, args), event: `gave up after ${attempt} attempt(s)`, detail: what, attempts: attempt, timedOut: out.timedOut }, { env: env ?? process.env, append: appendJsonl });
      out = { ...out, attempts: attempt, cause: `${describeCall(cmd, args)} ${out.timedOut ? `timed out after ${limit} s` : 'failed'}${attempt > 1 ? ` (${attempt} attempts)` : ''}${out.timedOut ? '' : `: ${what}`}` };
      break;
    }
    noteExternal({ call: describeCall(cmd, args), event: `attempt ${attempt} of ${tries} ${out.timedOut ? 'timed out' : 'failed'}, retrying`, detail: what, attempt, timedOut: out.timedOut }, { env: env ?? process.env, append: appendJsonl });
    sleepSync(retryPauseMs(attempt, env ?? process.env));
  }
  if (!allowFail && out.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${out.status}): ${out.stderr.trim()}`);
  }
  return out;
}

const retryPauseMs = (attempt, env) => externalRetryPauseMs(attempt, env);
export const sleepSync = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function runOnce(cmd, args, { cwd, input, env, timeoutSec, shell, killSignal }) {
  if (!shell) [cmd, args] = viaBash(cmd, args, cwd);
  const stdin = stdinFromFile(input);
  let result;
  try {
    result = spawnSync(cmd, args, {
      cwd,
      stdio: [stdin.stdin, 'pipe', 'pipe'],
      shell,
      env: env ?? process.env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutSec ? timeoutSec * 1000 : undefined,
      killSignal,
    });
  } finally {
    stdin.done();
  }
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') + (result.error ? `\n${result.error.message}` : '') + (result.signal ? `\nkilled by ${result.signal}` : ''),
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

// Async twin of run(): lets a caller run several processes at once. Same result shape.
// Sends `sig` to a process and every descendant (children first found from one `ps` listing), so a timed-out
// command cannot leave grandchildren running. Best effort: processes that already ended are skipped.
export function killTree(pid, sig = 'SIGTERM', { list = listProcesses } = {}) {
  if (!pid) return [];
  const children = new Map();
  for (const { pid: p, ppid } of list()) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(p);
  }
  const tree = [];
  const walk = (p) => {
    tree.push(p);
    for (const c of children.get(p) ?? []) walk(c);
  };
  walk(pid);
  for (const p of tree.reverse()) {
    try {
      process.kill(p, sig);
    } catch {
      // already gone
    }
  }
  return tree;
}

function listProcesses() {
  if (process.platform === 'win32') return [];
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  return String(r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, pp]) => p && pp >= 0).map(([p, pp]) => ({ pid: p, ppid: pp }));
}

export async function runAsync(cmd, args, { cwd, input, env, timeoutSec, signal, retries } = {}) {
  const kind = externalKind(cmd, args);
  const limit = timeoutSec ?? externalTimeoutSec(kind, env ?? process.env);
  const tries = kind && retrySafe(cmd, args) ? 1 + (retries ?? externalRetries(env ?? process.env)) : 1;
  for (let attempt = 1; ; attempt++) {
    const out = await runAsyncOnce(cmd, args, { cwd, input, env, timeoutSec: limit, signal });
    if (!kind || !transientFailure(out) || signal?.aborted) return out;
    const what = out.timedOut ? `timed out after ${limit} s` : String(out.stderr).trim().split('\n').pop().slice(0, 200);
    if (attempt >= tries) {
      noteExternal({ call: describeCall(cmd, args), event: `gave up after ${attempt} attempt(s)`, detail: what, attempts: attempt, timedOut: out.timedOut }, { env: env ?? process.env, append: appendJsonl });
      return { ...out, attempts: attempt, cause: `${describeCall(cmd, args)} ${out.timedOut ? `timed out after ${limit} s` : 'failed'}${attempt > 1 ? ` (${attempt} attempts)` : ''}${out.timedOut ? '' : `: ${what}`}` };
    }
    noteExternal({ call: describeCall(cmd, args), event: `attempt ${attempt} of ${tries} ${out.timedOut ? 'timed out' : 'failed'}, retrying`, detail: what, attempt, timedOut: out.timedOut }, { env: env ?? process.env, append: appendJsonl });
    await sleep(retryPauseMs(attempt, env ?? process.env));
  }
}

function runAsyncOnce(cmd, args, { cwd, input, env, timeoutSec, signal } = {}) {
  [cmd, args] = viaBash(cmd, args, cwd);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const finish = (status, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr: stderr + extra, timedOut });
    };
    // A timeout or an abort ends the whole process tree, not only the direct child: a grandchild that outlives
    // it keeps the output pipes open, 'close' never fires and the call never returns (dogfood C2: a shim's
    // engine process and its hung git survived the 40-minute stack timeout and the story waited forever).
    const stop = () => {
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000).unref();
      // Settle even if something still holds a pipe once the child itself is gone.
      setTimeout(() => finish(child.exitCode ?? 1, '\n(process tree stopped; output may be incomplete)'), 15000).unref();
    };
    // setTimeout fires at once for a delay over 2^31-1 ms: a very long limit is clamped to that.
    const timer = timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, Math.min(timeoutSec * 1000, 2 ** 31 - 1))
      : null;
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const onAbort = () => stop();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(127, `\n${error.message}`));
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      finish(code ?? (sig ? 1 : 0));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(redactValue(value), null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, records) {
  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, list.map((r) => JSON.stringify(redactValue(r))).join('\n') + '\n');
}

// The records of JSON-lines text; a line that does not parse is skipped.
export function parseJsonl(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export const readJsonl = (file) => (fs.existsSync(file) ? parseJsonl(fs.readFileSync(file, 'utf8')) : []);

// Minimal YAML front matter support: scalars, quoted strings and inline [a, b] lists.
export function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text, hasFrontMatter: false };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    // A hash (`story-sha`, `plan-sha`, ...) stays the text it was written as: an all-digit one is not a number.
    data[kv[1]] = /-sha$/.test(kv[1]) ? unquote(kv[2].trim()) : parseScalar(kv[2].trim());
  }
  return { data, body: text.slice(match[0].length), hasFrontMatter: true };
}

const unquote = (value) => (/^".*"$/.test(value) || /^'.*'$/.test(value) ? value.slice(1, -1) : value);

function parseScalar(value) {
  if (value === '') return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON; fall back to a plain comma split
    }
    return value
      .slice(1, -1)
      .split(',')
      .map((v) => parseScalar(v.trim()))
      .filter((v) => v !== '');
  }
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  if (value === 'null') return null;
  return value;
}

export function stringifyFrontMatter(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${formatScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

function formatScalar(value) {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (value === null) return 'null';
  // A string that would read back as something else (a number, a boolean, null) is quoted.
  if (typeof value === 'string' && (value === '' || /[:#[\]{},"']|^\s|\s$/.test(value) || parseScalar(value) !== value)) return JSON.stringify(value);
  return String(value);
}

// Agents end their final message with `AGENT_RESULT: {json}`. Take the last marker and parse the
// balanced JSON object that follows it (it may span several lines or sit in a code fence).
export function extractResult(text, marker = 'AGENT_RESULT') {
  const index = text.lastIndexOf(`${marker}:`);
  if (index < 0) return null;
  const start = text.indexOf('{', index);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function tail(text, chars = 4000) {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

// The record of a child step the harness ran: the result the step wrote itself (a file it was given) and, whenever it
// failed or wrote none, why: its own error message, else the last error line of its stderr, plus the tails of stderr
// and stdout (redacted). A failed step's output is never dropped, and a line some other tool printed on stdout is never
// mistaken for the step's result.
export function stepRecord(r, result = null, { chars = 2000 } = {}) {
  const exit = r?.status ?? null;
  const record = { exit, ...(result && typeof result === 'object' ? result : {}) };
  if (exit === 0 && result) return record;
  const stderr = String(r?.stderr ?? '');
  const stdout = String(r?.stdout ?? '');
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /error|failed|cannot|not a function|exception|refused|denied/i.test(l)) ?? lines.at(-1) ?? '';
  record.error = redact(String(result?.error ?? (errorLine || (r?.timedOut ? 'timed out' : `exit ${exit} with no output`))));
  record.stderrTail = redact(tail(stderr, chars));
  record.stdoutTail = redact(tail(stdout, Math.floor(chars / 2)));
  return record;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Identifies the current boot, so a pid recorded before a crash or reboot is never mistaken for a live
// process that happens to reuse it. Null where the OS offers no stable id (the pid check alone is used).
let cachedBootId;
export function bootId() {
  if (cachedBootId !== undefined) return cachedBootId;
  cachedBootId = null;
  try {
    if (process.platform === 'linux') cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    else if (process.platform === 'darwin') cachedBootId = /sec = (\d+)/.exec(spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', windowsHide: true }).stdout ?? '')?.[1] ?? null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

// What a background run records about itself (state sections and lock files), checked by isProcessAlive.
export const selfProcess = () => ({ pid: process.pid, boot: bootId() });

export function isProcessAlive(pid, boot = null) {
  if (!pid) return false;
  if (boot && bootId() && String(boot) !== bootId()) return false;
  return isPidAlive(pid);
}

const readLock = (file) => {
  const [pid, boot] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
  return { pid: Number(pid), boot: boot ?? null };
};
const lockText = () => `${process.pid}${bootId() ? ` ${bootId()}` : ''}`;

export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, lockText(), { flag: 'wx' });
    return true;
  } catch {
    if (lockHolder(file)) return false;
    fs.writeFileSync(file, lockText());
    return true;
  }
}

export function releaseLock(file) {
  try {
    if (readLock(file).pid === process.pid) fs.unlinkSync(file);
  } catch {
    // already released
  }
}

export function lockHolder(file) {
  try {
    const { pid, boot } = readLock(file);
    return isProcessAlive(pid, boot) ? pid : null;
  } catch {
    return null;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What an agent addendum (.factory/agents/<name>.md) contributes to a prompt: its text without HTML
// comments. A skeleton nobody filled in yet (it still carries its "Addendum skeleton." comment)
// contributes nothing, so an untouched `factory init` does not pad every prompt with empty headings.
export function addendumText(raw) {
  if (!raw || /<!--\s*Addendum skeleton\./.test(raw)) return '';
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// The PR body with a marked section (`start` and `end` marker lines) replaced, or added before the trailing generator
// line (a robot, "Generated with", "Model:" or "Harness:" line), else before the demo video block, else at the end. An
// empty section takes the old one out.
export function withMarkedSection(body, section, [start, end]) {
  let text = String(body ?? '').replace(/\r\n/g, '\n');
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a >= 0 && b > a) text = `${text.slice(0, a).trimEnd()}\n\n${text.slice(b + end.length).trimStart()}`.trimEnd() + '\n';
  if (!section) return text;
  const block = `${start}\n${section}\n${end}`;
  const lines = text.trimEnd().split('\n');
  const last = lines.length - 1;
  if (/^(🤖|Generated with|Model:|Harness:)/i.test(lines[last] ?? '')) return `${lines.slice(0, last).join('\n').trimEnd()}\n\n${block}\n\n${lines[last]}\n`;
  const video = text.indexOf(VIDEO_SECTION_START);
  if (video >= 0) return `${text.slice(0, video).trimEnd()}\n\n${block}\n\n${text.slice(video)}`;
  return `${text.trimEnd()}\n\n${block}\n`;
}
