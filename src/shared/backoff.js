// Retry planning for the Claude HTTP call.
// n8n's built-in "Retry On Fail" waits a fixed time (max 5 s) between tries.
// Rate limits (429) and overload (529) deserve real exponential backoff, and
// a 400/401 should not be retried at all - so the workflow loops through a
// Wait node using the plan computed here.

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const NETWORK_CODES = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout/i;

/** Best-effort HTTP status from the error item n8n emits on the error output. */
export function statusFromError(error) {
  if (!error) return null;
  const candidates = [error.httpCode, error.status, error.statusCode, error.response?.status, error.cause?.status];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n >= 100 && n < 600) return n;
  }
  const text = `${error.message || ''} ${error.description || ''}`;
  const m = text.match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * @param {object} p
 * @param {number} p.attempt       1-based number of the attempt that just failed
 * @param {number} [p.maxAttempts] total attempts allowed (default 4)
 * @param {number} [p.baseSeconds] first wait (default 10)
 * @param {number} [p.capSeconds]  longest wait (default 300)
 * @param {object} p.error         the error object from the HTTP node
 * @param {() => number} [p.random] injectable for tests
 */
export function planRetry({ attempt, maxAttempts = 4, baseSeconds = 10, capSeconds = 300, error, random = Math.random }) {
  const status = statusFromError(error);
  const message = String(error?.message || error?.description || 'Unknown error');
  const retryable = status ? RETRYABLE_STATUS.has(status) : NETWORK_CODES.test(message);
  const exhausted = attempt >= maxAttempts;
  // Full jitter: wait a random time in [exp/2, exp] so parallel runs don't sync up.
  const exp = Math.min(capSeconds, baseSeconds * 2 ** (attempt - 1));
  const waitSeconds = Math.max(1, Math.round(exp / 2 + random() * (exp / 2)));
  return {
    retry: retryable && !exhausted,
    attempt,
    maxAttempts,
    status,
    retryable,
    waitSeconds: retryable && !exhausted ? waitSeconds : 0,
    reason: !retryable
      ? `Not retryable (${status ?? 'no status'}): ${message}`
      : exhausted
        ? `Gave up after ${attempt} attempts: ${message}`
        : `Attempt ${attempt} failed (${status ?? 'network'}), retrying in ${waitSeconds}s`,
  };
}
