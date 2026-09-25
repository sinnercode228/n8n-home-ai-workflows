import { isoDateInZone } from '../shared/text.js';

// Build the Anthropic Messages API request for meeting notes.
// - Structured outputs (output_config.format) make Claude return JSON that
//   matches MEETING_NOTES_SCHEMA; the Parse node still validates it.
// - Server-side fallbacks ("default") let the API re-run a declined request
//   on Anthropic's recommended fallback model instead of failing the run.
// - The model id and effort come from the Config node, not from code.

export const MEETING_NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short, specific meeting title' },
    summary: { type: 'string', description: '3-6 plain-language sentences' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: { type: 'string' },
          owner: { type: 'string', description: 'Attendee name, or "Unassigned"' },
          dueDate: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
          sourceQuote: { type: 'string', description: 'Short quote from the transcript that supports this item' },
        },
        required: ['task', 'owner', 'dueDate', 'priority', 'sourceQuote'],
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'keyPoints', 'decisions', 'actionItems', 'openQuestions'],
};

const SYSTEM_PROMPT = `You turn meeting transcripts into notes for a busy household or small team.

Rules:
- Use only what is said in the transcript. If something is unclear, leave it out or add it to openQuestions.
- An action item needs a concrete next step. Owners must be one of the attendees; use "Unassigned" when nobody took it on.
- Resolve relative deadlines ("by Friday", "next week") against the meeting date given below and write them as YYYY-MM-DD. If no deadline was stated, use null. Never invent a date.
- decisions are things the group agreed on, not things that were merely discussed.
- sourceQuote is a short verbatim quote (under 25 words) that shows where the item came from.
- Write in the language the meeting was held in.`;

/**
 * @param {object} meeting  output of normalizeTranscript
 * @param {object} config   Config node values
 */
export function buildMeetingRequest(meeting, config = {}) {
  const timezone = config.timezone || 'UTC';
  const meetingDate = meeting.startedAt ? isoDateInZone(new Date(meeting.startedAt), timezone) : isoDateInZone(new Date(), timezone);
  const weekday = new Date(`${meetingDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

  const header = [
    `Meeting title: ${meeting.title}`,
    `Meeting date: ${meetingDate} (${weekday}), timezone ${timezone}`,
    `Attendees: ${meeting.attendees.length ? meeting.attendees.join(', ') : 'unknown'}`,
  ].join('\n');

  const request = {
    model: config.anthropicModel || 'claude-opus-5',
    max_tokens: Number(config.maxOutputTokens) || 16000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${header}\n\n<transcript>\n${meeting.transcriptText}\n</transcript>`,
      },
    ],
    output_config: {
      effort: config.anthropicEffort || 'medium',
      format: { type: 'json_schema', schema: MEETING_NOTES_SCHEMA },
    },
  };
  if (config.useServerFallbacks !== false) request.fallbacks = 'default';

  return { meetingDate, claudeRequest: request };
}
