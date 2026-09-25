// Scrub things that look like credentials before text leaves n8n
// (alerts, log files). Error messages from HTTP nodes sometimes echo headers.

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/\b(?:secret|ntn)_[A-Za-z0-9]{20,}/g, '***notion-token***'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '***telegram-bot-token***'],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, '***google-oauth-token***'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***'],
  [/\b(x-api-key|api[_-]?key|authorization|password|passwd|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2***'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '***jwt***'],
];

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const [re, replacement] of PATTERNS) text = text.replace(re, replacement);
  return text;
}
