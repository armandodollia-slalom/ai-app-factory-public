#!/usr/bin/env node
// Runs one agent CLI process and ends it only when it stops making progress, never because it is slow (council C12:
// a PR check's video critic hit its fixed 1800-second timeout while its API requests were stalling, and the check's
// verdict changed). Progress is the agent's heartbeat file growing or being touched (Claude Code's own session
// transcript, given with --session-id) or the process writing output. The agent is stopped when nothing has moved for
// `--idle` seconds, or at the `--ceiling`, which is a generous multiple of the agent's usual time limit.
//
//   node agent-supervisor.mjs --idle <s> --ceiling <s> [--heartbeat <file>] [--slow <factor>] -- <cmd> <args...>
//
// stdin, stdout and the exit code pass through. On a stop it writes `AGENT_SUPERVISOR: idle|ceiling <seconds>` to
// stderr and exits 124. `--slow <factor>` (PIPELINE_AGENT_SLOW) is a test mode: once the agent finishes after t seconds,
// the supervisor holds its result for (factor - 1) * t more seconds, alive and touching the heartbeat, so a whole run
// behaves as it would with agents `factor` times slower.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = argv.slice(0, sep);
const [cmd, ...args] = argv.slice(sep + 1);
const opt = (name, fallback) => {
  const i = opts.indexOf(`--${name}`);
  return i >= 0 ? opts[i + 1] : fallback;
};
const idleSec = Number(opt('idle', 0));
const ceilingSec = Number(opt('ceiling', 0));
const heartbeat = opt('heartbeat', null);
const slow = Math.max(1, Number(opt('slow', 1)) || 1);
const pollMs = Number(process.env.PIPELINE_SUPERVISOR_POLL_MS ?? 5000);

const started = Date.now();
let lastProgress = started;
let lastBeat = null;
const beat = () => {
  if (!heartbeat) return null;
  try {
    const st = fs.statSync(heartbeat);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
};

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
const out = [];
child.stdout.on('data', (d) => {
  lastProgress = Date.now();
  out.push(d);
});
child.stderr.on('data', (d) => {
  lastProgress = Date.now();
  process.stderr.write(d);
});

let stopped = null;
const stop = (why) => {
  if (stopped) return;
  stopped = why;
  process.stderr.write(`\nAGENT_SUPERVISOR: ${why} ${Math.round((Date.now() - started) / 1000)}\n`);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
};
const timer = setInterval(() => {
  const b = beat();
  if (b && b !== lastBeat) {
    lastBeat = b;
    lastProgress = Date.now();
  }
  if (ceilingSec && Date.now() - started > ceilingSec * 1000) stop('ceiling');
  else if (idleSec && Date.now() - lastProgress > idleSec * 1000) stop('idle');
}, pollMs);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(143), 10_000).unref();
});

child.on('error', (error) => {
  clearInterval(timer);
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
child.on('close', async (code, signal) => {
  clearInterval(timer);
  const took = Date.now() - started;
  if (!stopped && slow > 1) {
    const until = Date.now() + (slow - 1) * took;
    while (Date.now() < until) {
      if (heartbeat) {
        try {
          const now = new Date();
          fs.utimesSync(heartbeat, now, now);
        } catch {
          // no heartbeat file
        }
      }
      await new Promise((r) => setTimeout(r, Math.min(pollMs, until - Date.now())));
    }
  }
  process.stdout.write(Buffer.concat(out), () => process.exit(stopped ? 124 : code ?? (signal ? 1 : 0)));
});
