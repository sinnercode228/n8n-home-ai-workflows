import { clip, escapeHtml } from '../shared/text.js';
import { readLlmText } from '../shared/llm-response.js';

// Digest writing: request builder for Claude or local Ollama, a deterministic
// fallback digest (used when the LLM is down or there is nothing on the
// calendar), and the final message composer.

const DIGEST_SYSTEM = `You write a short morning digest of a family's calendar.
Plain, warm language a 10-year-old and a grandparent can both read. No emojis, no markdown headings.
Structure: one opening line, then the day in time order (who, what, when, where), then anything that needs attention (overlaps, early starts, things to bring).
Maximum 180 words. Use only the events provided - do not invent plans, reminders or weather.`;

function eventLine(e, includePrivate) {
  const where = includePrivate && e.location ? ` @ ${e.location}` : '';
  const note = includePrivate && e.description ? ` - note: ${e.description}` : '';
  return `- ${e.timeLabel}: ${e.title} [${e.members.join(', ')}]${where}${note}`;
}

export function dayPlanToText(day, { includePrivate = true } = {}) {
  const lines = [`Date: ${day.dateLabel} (${day.timezone})`, 'Events:'];
  lines.push(...(day.events.length ? day.events.map((e) => eventLine(e, includePrivate)) : ['- nothing scheduled']));
  if (day.conflicts.length) {
    lines.push('Overlaps:', ...day.conflicts.map((c) => `- ${c.first} overlaps ${c.second}`));
  }
  return lines.join('\n');
}

/**
 * @returns {{ route: 'claude'|'ollama'|'none', request?: object }}
 */
export function buildDigestRequest(day, config = {}) {
  if (day.eventCount === 0) return { route: 'none' };
  const provider = config.llmProvider === 'ollama' ? 'ollama' : 'claude';
  // Locations and event notes stay local unless explicitly allowed.
  const includePrivate = provider === 'ollama' || config.sendLocationsToCloud === true;
  const prompt = `Family: ${config.familyName || 'our family'}\n${dayPlanToText(day, { includePrivate })}`;

  if (provider === 'ollama') {
    return {
      route: 'ollama',
      request: {
        model: config.ollamaModel || 'llama3.1:8b',
        stream: false,
        options: { temperature: 0.3, num_predict: 600 },
        messages: [
          { role: 'system', content: DIGEST_SYSTEM },
          { role: 'user', content: prompt },
        ],
      },
    };
  }
  const request = {
    model: config.anthropicModel || 'claude-opus-5',
    max_tokens: 2000,
    system: DIGEST_SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  };
  if (config.useServerFallbacks !== false) request.fallbacks = 'default';
  return { route: 'claude', request };
}

/** Deterministic digest - no AI involved. */
export function renderPlainDigest(day) {
  if (day.eventCount === 0) return `Good morning! Nothing is on the family calendar for ${day.dateLabel}. Enjoy the free day.`;
  const lines = [`Good morning! Here is ${day.dateLabel}:`, ''];
  for (const e of day.events) lines.push(`${e.timeLabel} - ${e.title} (${e.members.join(', ')})${e.location ? `, ${e.location}` : ''}`);
  if (day.conflicts.length) {
    lines.push('', 'Heads up - these overlap:');
    for (const c of day.conflicts) lines.push(`${c.first} / ${c.second}`);
  }
  return lines.join('\n');
}

/**
 * @param {object|null} llmResponse  raw HTTP response (Claude or Ollama), or null when skipped
 */
export function composeDigest(day, llmResponse, config = {}) {
  let body;
  let usedFallback = false;
  let fallbackReason = null;
  if (llmResponse) {
    const read = readLlmText(llmResponse);
    if (read.ok) body = read.text.trim();
    else {
      usedFallback = true;
      fallbackReason = read.error;
    }
  } else {
    usedFallback = true;
    fallbackReason = day.eventCount === 0 ? 'no events' : 'LLM skipped';
  }
  if (!body) body = renderPlainDigest(day);

  const footer = usedFallback && day.eventCount > 0 ? '\n\n(Simple version - the AI writer was unavailable this morning.)' : '';
  const subject = `${config.familyName || 'Family'} calendar - ${day.dateLabel}`;
  return {
    usedFallback,
    fallbackReason,
    emailSubject: subject,
    emailBody: `${body}${footer}`,
    telegramText: clip(`<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(body)}${escapeHtml(footer)}`, 4000),
  };
}
