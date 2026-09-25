import { clip } from '../shared/text.js';
import { extractJson } from '../shared/json-repair.js';
import { readLlmText } from '../shared/llm-response.js';
import { validateMeetingNotes } from './validate-notes.js';

// Notion limits a single rich-text value to 2000 characters. The n8n Notion
// node writes one text value per block, so each section is clipped with a
// visible notice (the full notes stay in the n8n execution log).
const NOTION_TEXT_LIMIT = 1990;

function bullets(list, empty) {
  return list.length ? list.map((s) => `- ${s}`).join('\n') : empty;
}

function actionLine(a) {
  const due = a.dueDate ? ` (due ${a.dueDate})` : '';
  const prio = a.priority === 'high' ? ' [high]' : '';
  return `- ${a.task} -> ${a.owner}${due}${prio}`;
}

export function toNotionPage(meeting, notes, warnings = []) {
  return {
    title: clip(notes.title || meeting.title, 200),
    date: meeting.startedAt ? meeting.startedAt.slice(0, 10) : null,
    source: meeting.source,
    recordingUrl: meeting.url,
    attendees: clip(meeting.attendees.join(', '), NOTION_TEXT_LIMIT),
    summaryText: clip(notes.summary, NOTION_TEXT_LIMIT),
    keyPointsText: clip(bullets(notes.keyPoints, 'None recorded.'), NOTION_TEXT_LIMIT),
    decisionsText: clip(bullets(notes.decisions, 'No decisions recorded.'), NOTION_TEXT_LIMIT),
    actionItemsText: clip(notes.actionItems.length ? notes.actionItems.map(actionLine).join('\n') : 'No action items.', NOTION_TEXT_LIMIT),
    openQuestionsText: clip(bullets(notes.openQuestions, 'None.'), NOTION_TEXT_LIMIT),
    warningsText: warnings.length ? clip(`Automation notes:\n${bullets(warnings, '')}`, NOTION_TEXT_LIMIT) : 'No issues found while processing.',
  };
}

/**
 * Full "Parse & Validate Notes" step: Claude response -> validated notes.
 * Never throws; returns ok:false with a reason so the workflow can alert.
 */
export function parseMeetingResponse(response, { meeting, meetingDate }) {
  const read = readLlmText(response);
  if (!read.ok) return { ok: false, stage: 'claude-response', error: read.error, meeting };

  let parsed;
  try {
    parsed = extractJson(read.text);
  } catch (err) {
    return { ok: false, stage: 'parse-json', error: err.message, meeting };
  }

  const result = validateMeetingNotes(parsed.value, { meetingDate, attendees: meeting.attendees });
  if (!result.ok) {
    return { ok: false, stage: 'validate-notes', error: result.errors.join('; '), meeting };
  }
  const warnings = [...result.warnings];
  if (parsed.repairs.length) warnings.push(`JSON needed repair: ${parsed.repairs.join(', ')}`);
  if (read.fellBack) warnings.push(`Claude used a server-side fallback model (${read.model})`);

  return {
    ok: true,
    meeting: { ...meeting, transcriptText: undefined },
    notes: result.notes,
    warnings,
    model: read.model,
    notion: toNotionPage(meeting, result.notes, warnings),
  };
}

/** "2026-10-02" -> "2026-10-03" (pure date arithmetic, no time zones involved). */
export function nextIsoDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** One item per action item, ready for the Notion "Tasks" database. */
export function toTaskItems(parsed, meetingPage, config = {}) {
  const addToCalendar = config.createCalendarEvents !== false;
  return parsed.notes.actionItems.map((a) => ({
    task: clip(a.task, 200),
    owner: a.owner,
    dueDate: a.dueDate,
    priority: a.priority,
    sourceQuote: a.sourceQuote,
    meetingTitle: parsed.notion.title,
    meetingPageId: meetingPage.id,
    meetingPageUrl: meetingPage.url || null,
    addToCalendar: addToCalendar && Boolean(a.dueDate),
    // Google Calendar all-day events use an exclusive end date: a one-day
    // event on 2026-10-02 must end on 2026-10-03, or the API rejects it as empty.
    calendarEndDate: a.dueDate ? nextIsoDate(a.dueDate) : null,
    calendarDescription: `${a.task}\nOwner: ${a.owner}\nFrom meeting: ${parsed.notion.title}${meetingPage.url ? `\n${meetingPage.url}` : ''}`,
  }));
}
