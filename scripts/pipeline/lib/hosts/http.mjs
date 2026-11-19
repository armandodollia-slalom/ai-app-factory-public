// A small JSON client over Node's global fetch for the REST adapters (GitLab, Azure DevOps): base URL,
// auth headers, retries on rate limits (429, and 403/503 with Retry-After) and transient 5xx, and
// errors that never carry a token.
import { HostAuthError, HostError, HostRefusedError } from './errors.mjs';
import { isContentRefusal } from './refusal.mjs';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Seconds to wait from Retry-After (seconds or an HTTP date) or a reset timestamp header.
export function retryDelayMs(headers, attempt, now = Date.now()) {
  const after = headers.get('retry-after');
  if (after != null) {
    const s = Number(after);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset');
  if (reset != null && Number.isFinite(Number(reset))) {
    const n = Number(reset);
    // An epoch (GitLab, Azure) or a number of seconds.
    return Math.max(0, n > 1e9 ? n * 1000 - now : n * 1000);
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

const shorten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

// { request(method, path, opts) -> { status, headers, json, text }, json(method, path, opts) -> body }
// opts: { query, body (JSON), raw (Buffer|string body), contentType, accept, allow: [statuses that are
// not errors, e.g. 404], absolute (path is a full URL) }.
export function createHttp({ baseUrl, headers = {}, fetch: f = globalThis.fetch, retries = 4, sleep = sleepMs, maxDelayMs = 60_000, label = 'host', secrets = [], timeoutMs = 120_000 }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const scrub = (text) => secrets.filter((s) => s && String(s).length >= 4).reduce((t, s) => t.split(String(s)).join('***'), String(text));
  async function request(method, path, opts = {}) {
    const url = new URL(opts.absolute ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const h = { Accept: opts.accept ?? 'application/json', 'User-Agent': 'ai-app-factory', ...headers, ...(opts.headers ?? {}) };
    let body;
    if (opts.raw !== undefined) {
      body = opts.raw;
      h['Content-Type'] = opts.contentType ?? 'application/octet-stream';
    } else if (opts.form !== undefined) body = opts.form;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      h['Content-Type'] = opts.contentType ?? 'application/json';
    }
    for (let attempt = 0; ; attempt++) {
      let res;
      // Every request is bounded (the external-call policy): a controller and a timer this call holds.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? timeoutMs);
      try {
        res = await f(url.toString(), { method, headers: h, body, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < retries) {
          await sleep(Math.min(maxDelayMs, 1000 * 2 ** attempt));
          continue;
        }
        throw new HostError(`${label} ${method} ${url.pathname}: ${scrub(error.message)}`, { code: 'network' });
      }
      const limited = res.status === 429 || ((res.status === 403 || res.status === 503) && (res.headers.get('retry-after') != null || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('ratelimit-remaining') === '0'));
      if ((limited || res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        clearTimeout(timer);
        await sleep(Math.min(maxDelayMs, retryDelayMs(res.headers, attempt)));
        continue;
      }
      let text;
      try {
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.ok || (opts.allow ?? []).includes(res.status)) return { status: res.status, headers: res.headers, json, text };
      const said = json?.message ?? json?.error ?? json?.errorMessage ?? text;
      const detail = shorten(scrub(typeof said === 'object' ? JSON.stringify(said) : said));
      const msg = `${label} ${method} ${url.pathname} answered HTTP ${res.status}${detail ? ` (${detail})` : ''}`;
      if (limited) throw new HostError(msg, { status: res.status, code: 'rate-limit' });
      // A content filter (a bare 403, or a 4xx naming spam or content), not a permission: the caller may shorten the text.
      if (body !== undefined && method !== 'GET' && res.status >= 400 && res.status < 500 && isContentRefusal({ status: res.status, text: detail })) throw new HostRefusedError(msg, { status: res.status });
      if (res.status === 401 || res.status === 403) throw new HostAuthError(`${msg}: check the token and its scopes`, { status: res.status });
      if (res.status === 404) throw new HostError(msg, { status: 404, code: 'not-found' });
      if (res.status === 409) throw new HostError(msg, { status: 409, code: 'exists' });
      throw new HostError(msg, { status: res.status });
    }
  }
  const json = async (method, path, opts) => (await request(method, path, opts)).json;
  return { request, json, base };
}
