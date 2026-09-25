import { cleanText } from '../shared/text.js';

// Merge events from several family calendars into one day plan:
// - drop cancelled events and n8n's "empty" placeholder items
// - de-duplicate the same event shared on several calendars (by iCalUID + start)
//   and remember everyone it belongs to
// - sort all-day first, then by start time
// - flag overlapping timed events so the digest can mention them

function timeLabel(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function normalizeEvent(raw, timeZone) {
  if (!raw || raw.status === 'cancelled') return null;
  const startRaw = raw.start?.dateTime || raw.start?.date;
  if (!startRaw) return null;
  const allDay = !raw.start?.dateTime;
  const endRaw = raw.end?.dateTime || raw.end?.date || startRaw;
  const member = raw._calendar?.member || 'Family';
  return {
    key: `${raw.iCalUID || raw.id}|${startRaw}`,
    title: cleanText(raw.summary) || '(no title)',
    allDay,
    start: startRaw,
    end: endRaw,
    startMs: allDay ? 0 : new Date(startRaw).getTime(),
    endMs: allDay ? 0 : new Date(endRaw).getTime(),
    timeLabel: allDay ? 'All day' : `${timeLabel(startRaw, timeZone)}-${timeLabel(endRaw, timeZone)}`,
    location: cleanText(raw.location) || null,
    description: cleanText(raw.description).slice(0, 300) || null,
    members: [member],
  };
}

/**
 * @param {object[]} rawEvents  Google Calendar events, each with `_calendar: { member, label }`
 * @param {object}   opts       { date: 'YYYY-MM-DD', timezone }
 */
export function mergeEvents(rawEvents, { date, timezone = 'UTC' } = {}) {
  const byKey = new Map();
  for (const raw of rawEvents) {
    const ev = normalizeEvent(raw, timezone);
    if (!ev) continue;
    const existing = byKey.get(ev.key);
    if (existing) {
      for (const m of ev.members) if (!existing.members.includes(m)) existing.members.push(m);
      existing.location ||= ev.location;
    } else {
      byKey.set(ev.key, ev);
    }
  }

  const events = [...byKey.values()].sort((a, b) => (a.allDay === b.allDay ? a.startMs - b.startMs : a.allDay ? -1 : 1));

  const timed = events.filter((e) => !e.allDay);
  const conflicts = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j].startMs >= timed[i].endMs) break; // sorted by start: no later event can overlap i
      conflicts.push({
        first: `${timed[i].title} (${timed[i].timeLabel}, ${timed[i].members.join(' & ')})`,
        second: `${timed[j].title} (${timed[j].timeLabel}, ${timed[j].members.join(' & ')})`,
      });
    }
  }

  const dateLabel = date
    ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : null;

  return {
    date,
    dateLabel,
    timezone,
    eventCount: events.length,
    events: events.map(({ key, startMs, endMs, ...rest }) => rest),
    conflicts,
  };
}
