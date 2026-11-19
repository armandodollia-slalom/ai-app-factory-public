// The worker thread behind blocking.mjs: runs one task per message (a fetch, or one method of a module's
// export), then wakes the caller, which waits on a shared Int32Array and reads the reply from the port.
import { pathToFileURL } from 'node:url';
import { workerData } from 'node:worker_threads';
import { serializeError } from './hosts/errors.mjs';

const { port } = workerData;

async function doFetch(request) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60000);
    const body = request.bodyBase64 != null ? Buffer.from(request.bodyBase64, 'base64') : request.body;
    const res = await fetch(request.url, { method: request.method ?? 'GET', headers: request.headers ?? {}, body, signal: controller.signal, redirect: 'follow' }); // timeout: the controller's timer
    const buf = Buffer.from(await res.arrayBuffer());
    clearTimeout(timer);
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), bodyBase64: buf.toString('base64') };
  } catch (error) {
    return { status: 0, error: error.name === 'AbortError' ? 'timeout' : String(error.cause?.message ?? error.message) };
  }
}

async function doCall({ module, fn, args = [] }) {
  try {
    const mod = await import(pathToFileURL(module).href);
    if (typeof mod[fn] !== 'function') throw new Error(`${module} has no export ${fn}()`);
    const value = await mod[fn](...args);
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

port.on('message', async ({ task, flag }) => {
  const reply = task.kind === 'fetch' ? await doFetch(task.request) : await doCall(task);
  port.postMessage(reply);
  const done = new Int32Array(flag);
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
});
