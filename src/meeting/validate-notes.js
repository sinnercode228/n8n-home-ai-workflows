import { cleanText, clip, isValidIsoDate } from '../shared/text.js';

// Validate (and gently repair) the meeting notes object before anything is
// written to Notion. Hard problems go to `errors` (the run alerts instead of
// writing garbage); soft problems go to `warnings` (written to the page).

const PRIORITIES = new Set(['high', 'normal', 'low']);

function stringList(value, field, warnings) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${field} was not a list and was ignored`);
    return [];
  }
  const seen = new Set();
  return value.map(cleanText).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

function matchOwner(owner, attendees) {
  const name = cleanText(owner);
  if (!name || /^(unassigned|none|n\/a|unknown|tbd)$/i.test(name)) return 'Unassigned';
  const exact = attendees.find((a) => a.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const first = attendees.find((a) => a.split(' ')[0].toLowerCase() === name.split(' ')[0].toLowerCase());
  return first || name;
}

/**
 * @param {unknown} raw          parsed JSON from the model
 * @param {object}  ctx
 * @param {string}  ctx.meetingDate  YYYY-MM-DD
 * @param {string[]} ctx.attendees
 */
export function validateMeetingNotes(raw, { meetingDate, attendees = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Notes are not a JSON object'], warnings, notes: null };
  }

  const summary = cleanText(raw.summary);
  if (!summary) errors.push('summary is missing');
  if (!Array.isArray(raw.actionItems)) errors.push('actionItems must be a list');

  const seenTasks = new Set();
  const actionItems = (Array.isArray(raw.actionItems) ? raw.actionItems : [])
    .map((item, i) => {
      const task = cleanText(item?.task);
      if (!task) {
        warnings.push(`action item #${i + 1} had no task text and was dropped`);
        return null;
      }
      const key = task.toLowerCase();
      if (seenTasks.has(key)) {
        warnings.push(`duplicate action item dropped: "${clip(task, 60)}"`);
        return null;
      }
      seenTasks.add(key);

      let dueDate = item.dueDate ?? null;
      if (dueDate !== null && !isValidIsoDate(dueDate)) {
        warnings.push(`"${clip(task, 60)}": invalid due date "${dueDate}" removed`);
        dueDate = null;
      } else if (dueDate && meetingDate && dueDate < meetingDate) {
        warnings.push(`"${clip(task, 60)}": due date ${dueDate} is before the meeting and was removed`);
        dueDate = null;
      }
      const priority = PRIORITIES.has(item.priority) ? item.priority : 'normal';
      return {
        task,
        owner: matchOwner(item.owner, attendees),
        dueDate,
        priority,
        sourceQuote: clip(cleanText(item.sourceQuote), 280),
      };
    })
    .filter(Boolean);

  const notes = {
    title: cleanText(raw.title),
    summary,
    keyPoints: stringList(raw.keyPoints, 'keyPoints', warnings),
    decisions: stringList(raw.decisions, 'decisions', warnings),
    actionItems,
    openQuestions: stringList(raw.openQuestions, 'openQuestions', warnings),
  };
  return { ok: errors.length === 0, errors, warnings, notes };
}
