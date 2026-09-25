import { clip, escapeHtml } from './text.js';
import { redactSecrets } from './redact.js';

/**
 * Build a human-readable alert for Telegram (HTML) and email (plain text).
 * Written for a non-technical household member: what broke, whether anything
 * was lost, and what to do next.
 */
export function buildAlert({ workflow, stage, message, details = {}, executionUrl = null, hint = null }) {
  const safeMessage = redactSecrets(message || 'Unknown error');
  const lines = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, redactSecrets(typeof v === 'string' ? v : JSON.stringify(v))]);

  const html = [
    `<b>Home automation: ${escapeHtml(workflow)} needs attention</b>`,
    `Step: <code>${escapeHtml(stage)}</code>`,
    `Problem: ${escapeHtml(clip(safeMessage, 800))}`,
    ...lines.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(clip(v, 300))}`),
    hint ? `\nWhat to do: ${escapeHtml(hint)}` : '',
    executionUrl ? `\n<a href="${escapeHtml(executionUrl)}">Open the run in n8n</a>` : '',
  ].filter(Boolean).join('\n');

  const text = [
    `${workflow} needs attention`,
    `Step: ${stage}`,
    `Problem: ${safeMessage}`,
    ...lines.map(([k, v]) => `${k}: ${v}`),
    hint ? `What to do: ${hint}` : '',
    executionUrl ? `Run details: ${executionUrl}` : '',
    '',
    'See docs/runbook.md -> "When something fails".',
  ].filter((l) => l !== '').join('\n');

  return {
    telegramHtml: clip(html, 4000),
    emailSubject: `[home-n8n] ${workflow}: ${stage} failed`,
    emailText: text,
  };
}
