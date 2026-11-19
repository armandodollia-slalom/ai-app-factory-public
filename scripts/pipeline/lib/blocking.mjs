// The one synchronous bridge of the adapter layers. The board stage, the review gate and the pipeline's
// ticket loader are synchronous, while GitLab, Azure DevOps, Jira and Azure Boards are reached through
// Node's asynchronous fetch. `runBlocking(task)` posts the task to a worker thread and blocks this thread
// on Atomics.wait until the worker answers:
//
//   { kind: 'fetch', request: { method, url, headers, body | bodyBase64, timeoutMs } }
//       -> { status, headers, bodyBase64 } or { status: 0, error }      (the tracker layer's HTTP client)
//   { kind: 'call', module, fn, args }
//       -> { ok: true, value } or { ok: false, error: serializeError(e) } (host.sync: one adapter method)
//
// Anything the task carries (settings, an identity token) goes through the message port, never a command
// line. The worker shares this process's environment (SHARE_ENV), so `${ENV}` settings resolve the same.
// Because this thread is blocked while it waits, a test's fake server must not run on this thread: run it
// in a worker or a child process (scripts/board/test/fixtures/fake-tracker-server.mjs,
// scripts/pipeline/test/hosts-fake-server.mjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, SHARE_ENV, Worker, receiveMessageOnPort } from 'node:worker_threads';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blocking-worker.mjs');
let channel = null;

function worker() {
  if (channel) return channel;
  const { port1, port2 } = new MessageChannel();
  const w = new Worker(WORKER, { workerData: { port: port2 }, transferList: [port2], env: SHARE_ENV });
  w.unref();
  port1.unref();
  const reset = () => {
    if (channel?.worker === w) channel = null;
  };
  w.on('error', reset);
  w.on('exit', reset);
  channel = { port: port1, worker: w };
  return channel;
}

// Runs one task on the worker and returns its reply, or { timeout: true } / { lost: true }.
export function runBlocking(task, { timeoutMs = 300_000 } = {}) {
  const { port } = worker();
  const flag = new SharedArrayBuffer(4);
  port.postMessage({ task, flag });
  const r = Atomics.wait(new Int32Array(flag), 0, 0, timeoutMs);
  const msg = receiveMessageOnPort(port);
  if (!msg) return r === 'timed-out' ? { timeout: true } : { lost: true };
  return msg.message;
}

export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
