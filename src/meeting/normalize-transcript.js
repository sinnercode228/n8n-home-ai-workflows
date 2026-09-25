import { cleanText, fnv1a } from '../shared/text.js';

// Turn a meeting-recorder webhook into one predictable shape.
// Supported inputs (see samples/):
//   - Fathom-style: transcript is an array of { speaker: { display_name }, text, timestamp }
//   - Granola-style (usually relayed through Zapier/Make): transcript is a string,
//     attendees is [{ name, email }]
//   - Generic: { title, date, attendees: ["Name"], transcript: "..." }
// Field names differ between vendors and plan tiers; this is the one place to
// adjust the mapping.

const MAX_TRANSCRIPT_CHARS = 600000; // ~150k tokens: far inside Claude's window, but a guard against junk payloads

function speakerName(entry) {
  const s = entry.speaker;
  if (typeof s === 'string') return cleanText(s);
  return cleanText(s?.display_name || s?.name || entry.speaker_name || entry.name || 'Speaker');
}

function transcriptToText(transcript) {
  if (typeof transcript === 'string') return transcript.trim();
  if (Array.isArray(transcript)) {
    return transcript
      .filter((e) => e && cleanText(e.text))
      .map((e) => {
        const ts = e.timestamp ? `[${cleanText(e.timestamp)}] ` : '';
        return `${ts}${speakerName(e)}: ${cleanText(e.text)}`;
      })
      .join('\n');
  }
  return '';
}

function attendeeNames(list) {
  if (!Array.isArray(list)) return [];
  const names = list
    .map((a) => (typeof a === 'string' ? a : a?.name || a?.display_name || a?.email))
    .map(cleanText)
    .filter(Boolean);
  return [...new Set(names)];
}

function detectSource(p) {
  if (p.source) return String(p.source).toLowerCase();
  if (Array.isArray(p.transcript) && p.transcript.some((e) => e && typeof e.speaker === 'object')) return 'fathom';
  if (p.notes_markdown || p.granola_id) return 'granola';
  return 'generic';
}

/**
 * @param {object} payload  webhook body
 * @returns normalized meeting object; throws on unusable input so the
 *          workflow fails loudly (and the Error Trigger workflow alerts).
 */
export function normalizeTranscript(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Webhook body is empty or not JSON');
  const source = detectSource(payload);
  const transcriptText = transcriptToText(payload.transcript ?? payload.transcript_text);
  if (!transcriptText) throw new Error(`No transcript found in ${source} payload (expected "transcript")`);
  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(`Transcript is ${transcriptText.length} chars (limit ${MAX_TRANSCRIPT_CHARS}). Split the recording or raise the limit in src/meeting/normalize-transcript.js`);
  }

  const title = cleanText(payload.meeting_title || payload.title || payload.name) || 'Untitled meeting';
  const startedAt = payload.recording_start_time || payload.scheduled_start_time || payload.started_at || payload.created_at || payload.date || null;
  const endedAt = payload.recording_end_time || payload.ended_at || null;
  const startDate = startedAt ? new Date(startedAt) : null;
  if (startDate && Number.isNaN(startDate.getTime())) throw new Error(`Unparseable meeting start time: ${startedAt}`);

  let attendees = attendeeNames(payload.calendar_invitees || payload.attendees || payload.participants);
  if (attendees.length === 0 && Array.isArray(payload.transcript)) {
    attendees = [...new Set(payload.transcript.filter(Boolean).map(speakerName))];
  }

  const durationMin = startDate && endedAt ? Math.round((new Date(endedAt) - startDate) / 60000) : null;
  const externalId = payload.recording_id || payload.id || payload.granola_id || null;

  return {
    source,
    meetingId: externalId ? `${source}:${externalId}` : `${source}:${fnv1a(`${title}|${startedAt}|${transcriptText.length}`)}`,
    title,
    startedAt: startDate ? startDate.toISOString() : null,
    durationMin: Number.isFinite(durationMin) ? durationMin : null,
    attendees,
    url: payload.share_url || payload.url || payload.link || null,
    transcriptText,
    transcriptChars: transcriptText.length,
  };
}
