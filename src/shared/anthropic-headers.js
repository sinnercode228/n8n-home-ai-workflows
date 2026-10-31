// HTTP headers for an Anthropic Messages API call. The Claude HTTP nodes send
// these from the item (JSON headers mode), so the server-side-fallback beta
// header goes out only when the request body asks for fallbacks.

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function anthropicHeaders({ fallbacks = false } = {}) {
  const headers = { 'anthropic-version': '2023-06-01' };
  if (fallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
  return headers;
}
