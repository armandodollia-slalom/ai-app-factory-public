// The synchronous JSON client the REST CI adapters share (the review gate and the CI wait are synchronous): the tracker
// layer's client (retries on 429 and 5xx honouring Retry-After, bounded requests, errors without the token) over the
// adapter layers' one synchronous bridge. `send` is injectable (the tests' fake servers).
import { basicAuth, bearerAuth, restClient } from '../../../board/lib/trackers/http.mjs';
import { expandEnv } from '../env.mjs';

// A `${NAME}` setting's value, or null (unset, or no setting).
export function secret(value, what, env = process.env) {
  if (value == null || value === '') return null;
  try {
    return expandEnv(String(value), env, what) || null;
  } catch {
    return null;
  }
}

export function ciClient({ baseUrl, token = null, user = null, header = null, product, send, retries = 4 }) {
  const authorization = header ? null : token ? (user != null ? basicAuth(user, token) : bearerAuth(token)) : null;
  const headers = header && token ? { [header]: token } : {};
  const c = restClient({ baseUrl, authorization, headers, product, send, retries });
  return {
    json: (method, p, body) => c.json(method, p, body),
    text: (p, { accept = 'text/plain' } = {}) => c.request('GET', p, { accept }).body.toString('utf8'),
    request: c.request,
  };
}

// The status words every CI adapter maps to: { status: queued|running|completed, conclusion }.
export const run = (id, pipeline, name, status, conclusion, extra = {}) => ({ id, pipeline, name, status, conclusion: status === 'completed' ? conclusion : null, event: extra.event ?? 'pull_request', url: extra.url ?? null, sha: extra.sha ?? null, createdAt: extra.createdAt ?? null });
