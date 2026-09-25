// Read the text out of an LLM HTTP response, for either provider.
//
// Anthropic Messages API: content is an array of blocks. With adaptive
// thinking on, `thinking` blocks can come before the `text` block, and with
// server-side fallbacks a `fallback` block marks a model switch - so we never
// assume content[0] is the answer. stop_reason must be checked before the
// content is trusted.
//
// Ollama /api/chat (stream: false): { message: { content }, done_reason }.

/**
 * @returns {{ ok: true, text: string, provider: string, model: string|null, fellBack: boolean }
 *         | { ok: false, error: string, provider: string, retryable: boolean }}
 */
export function readLlmText(response) {
  if (!response || typeof response !== 'object') {
    return { ok: false, provider: 'unknown', error: 'Empty response from LLM', retryable: true };
  }
  // n8n HTTP node with "continue" error handling puts failures under `error`.
  if (response.error && !response.content && !response.message) {
    const msg = typeof response.error === 'string' ? response.error : response.error.message || JSON.stringify(response.error);
    return { ok: false, provider: 'unknown', error: `LLM request failed: ${msg}`, retryable: true };
  }

  if (Array.isArray(response.content)) {
    const provider = 'anthropic';
    if (response.type === 'error') {
      return { ok: false, provider, error: `Anthropic error: ${response.error?.message || 'unknown'}`, retryable: false };
    }
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category || 'unspecified';
      return { ok: false, provider, error: `Claude declined the request (category: ${category})`, retryable: false };
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, provider, error: 'Claude hit max_tokens - output is incomplete. Raise maxOutputTokens in the Config node.', retryable: false };
    }
    const text = response.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) {
      return { ok: false, provider, error: 'Claude returned no text block', retryable: true };
    }
    const fellBack = response.content.some((b) => b && b.type === 'fallback');
    return { ok: true, provider, text, model: response.model || null, fellBack };
  }

  if (response.message && typeof response.message.content === 'string') {
    const provider = 'ollama';
    if (response.done_reason === 'length') {
      return { ok: false, provider, error: 'Ollama stopped at num_predict - output is incomplete', retryable: false };
    }
    const text = response.message.content;
    if (!text.trim()) return { ok: false, provider, error: 'Ollama returned an empty message', retryable: true };
    return { ok: true, provider, text, model: response.model || null, fellBack: false };
  }

  return { ok: false, provider: 'unknown', error: 'Unrecognised LLM response shape', retryable: false };
}
