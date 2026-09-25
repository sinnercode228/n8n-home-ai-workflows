// Small, dependency-free helpers shared by several Code nodes.
// Everything in src/ is plain JavaScript that runs both under Node (tests)
// and inside an n8n Code node (after scripts/build-workflows.mjs inlines it).

/** Collapse runs of whitespace and trim. Non-strings become ''. */
export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Cut text to `max` characters on a word boundary and say so, instead of
 * cutting silently. Used only for display surfaces with hard limits
 * (Notion text blocks, Telegram messages) - never for LLM input.
 */
export function clip(value, max, notice = ' [...truncated]') {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const room = Math.max(0, max - notice.length);
  const cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut) + notice;
}

/** 32-bit FNV-1a hash as 8 hex chars. Deterministic, no crypto module needed. */
export function fnv1a(input, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  const str = String(input);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministic UUID-shaped id (Qdrant accepts UUID strings as point ids).
 * Not RFC-4122 random - it is a stable fingerprint so re-ingesting the same
 * chunk overwrites the same point instead of duplicating it.
 */
export function stableUuid(input) {
  const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => fnv1a(input, seed)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** YYYY-MM-DD for a Date in the given IANA timezone. */
export function isoDateInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
