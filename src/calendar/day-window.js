import { isoDateInZone } from '../shared/text.js';

// Work out "today" in the household's timezone and the UTC instants that
// bound it, so Google Calendar returns exactly one local day (DST-safe).

/** Minutes that `timeZone` is ahead of UTC at instant `ms`. */
export function zoneOffsetMinutes(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - ms) / 60000);
}

/** UTC instant of local midnight at the start of `isoDate` in `timeZone`. */
export function localMidnightUtc(isoDate, timeZone) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - zoneOffsetMinutes(guess, timeZone) * 60000;
  ms = guess - zoneOffsetMinutes(ms, timeZone) * 60000; // second pass settles DST edges
  return ms;
}

export function dayWindow(now, timeZone) {
  const date = isoDateInZone(now, timeZone);
  const start = localMidnightUtc(date, timeZone);
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = localMidnightUtc(next, timeZone);
  return { date, timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

/** One item per configured calendar, each carrying the day window. */
export function expandCalendars(config, now = new Date()) {
  const timeZone = config.timezone || 'UTC';
  const window = dayWindow(now, timeZone);
  const calendars = Array.isArray(config.calendars) ? config.calendars : [];
  if (calendars.length === 0) throw new Error('Config.calendars is empty - add at least one calendar id');
  return calendars.map((c) => ({
    calendarId: c.id,
    label: c.label || c.id,
    member: c.member || c.label || 'Family',
    timezone: timeZone,
    ...window,
  }));
}
