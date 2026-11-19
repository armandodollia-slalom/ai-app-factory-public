// HTTP for the REST trackers (Jira, Azure Boards) through Node's global fetch, with no dependency.
//
// The board stage and the pipeline's ticket loader are synchronous, so tracker methods are too:
// requestSync runs fetch through the adapter layers' one synchronous bridge
// (scripts/pipeline/lib/blocking.mjs: a worker thread and Atomics.wait). A synchronous method can still
// be awaited. restClient adds the base URL, authentication, JSON, retries on 429 and 5xx (honouring
// Retry-After) and clear errors for a bad token.
import { runBlocking, sleepSync } from '../../../pipeline/lib/blocking.mjs';
import { isContentRefusal } from '../../../pipeline/lib/hosts/refusal.mjs';
import { TrackerError } from './shared.mjs';

// One HTTP request, synchronously: { method, url, headers, body (string) | bodyBase64, timeoutMs } ->
// { status, headers, body (Buffer) } or { status: 0, error }.
export function requestSync(request) {
  const reply = runBlocking({ kind: 'fetch', request }, { timeoutMs: (request.timeoutMs ?? 60000) + 5000 });
  if (reply.timeout) return { status: 0, error: 'timeout', body: Buffer.alloc(0) };
  if (reply.lost) return { status: 0, error: 'no reply from the HTTP worker', body: Buffer.alloc(0) };
  return { ...reply, body: reply.bodyBase64 != null ? Buffer.from(reply.bodyBase64, 'base64') : Buffer.alloc(0) };
}

export { sleepSync };

// Retry-After: seconds or an HTTP date.
function retryAfterMs(headers, attempt) {
  const v = headers?.['retry-after'];
  if (v != null) {
    const s = Number(v);
    if (Number.isFinite(s)) return Math.min(s * 1000, 60000);
    const at = Date.parse(v);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 60000);
  }
  return Math.min(500 * 2 ** attempt, 8000);
}

// A JSON REST client. `auth`: { header } (precomputed Authorization value). `product`: names the
// tracker in error messages. Returns { request, json, paths }; json(method, path, body, opts) parses the
// reply, raw replies come from request().
export function restClient({ baseUrl, authorization, product, retries = 4, timeoutMs = 60000, headers: extra = {}, send = requestSync, sleep = sleepSync }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const url = (p) => (/^https?:\/\//.test(p) ? p : `${base}${p.startsWith('/') ? '' : '/'}${p}`);

  function request(method, p, { body, contentType = 'application/json', accept = 'application/json', headers = {}, raw = false } = {}) {
    const h = { Accept: accept, ...extra, ...headers };
    if (authorization) h.Authorization = authorization;
    let payload;
    let bodyBase64;
    if (body != null) {
      if (Buffer.isBuffer(body)) bodyBase64 = body.toString('base64');
      else payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (contentType) h['Content-Type'] = contentType;
    }
    for (let attempt = 0; ; attempt++) {
      const res = send({ method, url: url(p), headers: h, body: payload, bodyBase64, timeoutMs });
      if (res.status === 0) {
        if (attempt < retries) {
          sleep(retryAfterMs(null, attempt));
          continue;
        }
        throw new TrackerError('network', `${product}: ${method} ${url(p)} failed: ${res.error}`);
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        sleep(retryAfterMs(res.headers, attempt));
        continue;
      }
      // A content filter on a request that sends text (a bare 403, or a 4xx naming spam or content): the caller may shorten it.
      if (payload != null && method !== 'GET' && res.status >= 400 && res.status < 500 && res.status !== 429 && isContentRefusal({ status: res.status, text: snippet(res.body) })) {
        throw new TrackerError('refused', `${product}: ${method} ${p} was refused (HTTP ${res.status}) without a reason that names a permission: a content filter on its text`, { status: res.status });
      }
      if (res.status === 401 || res.status === 403) {
        throw new TrackerError('auth', `${product}: ${method} ${p} was refused (HTTP ${res.status}); check the token (tracker.auth, ci.token or host.token) and its scopes: ${snippet(res.body)}`, { status: res.status });
      }
      if (res.status === 404) throw new TrackerError('not-found', `${product}: ${method} ${p}: not found (HTTP 404) ${snippet(res.body)}`, { status: 404 });
      if (res.status === 429) throw new TrackerError('rate-limit', `${product}: rate limited after ${retries} retries`, { status: 429 });
      if (res.status >= 400) throw new TrackerError('http', `${product}: ${method} ${p} failed (HTTP ${res.status}): ${snippet(res.body)}`, { status: res.status });
      return raw ? res : res;
    }
  }

  function json(method, p, body, opts = {}) {
    const res = request(method, p, { ...opts, body });
    const text = res.body.toString('utf8').trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new TrackerError('http', `${product}: ${method} ${p} did not return JSON: ${text.slice(0, 200)}`);
    }
  }

  return { request, json, url };
}

const snippet = (buf) => String(buf ?? '').replace(/\s+/g, ' ').slice(0, 300);

export const basicAuth = (user, token) => `Basic ${Buffer.from(`${user ?? ''}:${token}`).toString('base64')}`;
export const bearerAuth = (token) => `Bearer ${token}`;
