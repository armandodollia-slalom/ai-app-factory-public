// Errors of the code host and ticket tracker adapters (UnsupportedError is shared by both layers; the
// tracker layer adds TrackerError in board/lib/trackers/shared.mjs). Messages never hold a token.

// A method the product cannot support. The message says what to do instead; callers that can degrade
// catch it (`error instanceof UnsupportedError` or `error.name === 'UnsupportedError'`, which survives
// the synchronous bridge).
export class UnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedError';
    this.unsupported = true;
  }
}

// A request the host refused or could not answer. `status` is the HTTP status (or the CLI exit code),
// `code` a short reason: 'auth', 'not-found', 'exists', 'rate-limit', 'refused', 'http', 'cli'.
export class HostError extends Error {
  constructor(message, { status = null, code = 'http' } = {}) {
    super(message);
    this.name = 'HostError';
    this.status = status;
    this.code = code;
  }
}

// The token is missing, expired or lacks a permission (HTTP 401, or 403 that is not a rate limit).
export class HostAuthError extends HostError {
  constructor(message, { status = 401 } = {}) {
    super(message, { status, code: 'auth' });
    this.name = 'HostAuthError';
  }
}

// The host refused the request's text (a content filter), not the caller's permission: hosts/refusal.mjs classifies it
// and sends the request again with a shorter body. `attempts` when even the shortest body was refused.
export class HostRefusedError extends HostError {
  constructor(message, { status = 403, attempts = [] } = {}) {
    super(message, { status, code: 'refused' });
    this.name = 'HostRefusedError';
    this.attempts = attempts;
  }
}

const CLASSES = { UnsupportedError, HostError, HostAuthError, HostRefusedError };

// Plain data for an error that crosses a process boundary (the synchronous bridge), and back.
export const serializeError = (e) => ({ name: e?.name ?? 'Error', message: String(e?.message ?? e), status: e?.status ?? null, code: e?.code ?? null });
export function deserializeError(data) {
  const Cls = CLASSES[data?.name];
  if (!Cls) return Object.assign(new Error(data?.message ?? 'host call failed'), { status: data?.status ?? null, code: data?.code ?? null });
  if (Cls === UnsupportedError) return new UnsupportedError(data.message);
  if (Cls === HostAuthError) return new HostAuthError(data.message, { status: data.status ?? 401 });
  if (Cls === HostRefusedError) return new HostRefusedError(data.message, { status: data.status ?? 403 });
  return new HostError(data.message, { status: data.status, code: data.code ?? 'http' });
}
