import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { clip, escapeHtml, isValidIsoDate, stableUuid } from '../src/shared/text.js';
import { extractJson } from '../src/shared/json-repair.js';
import { readLlmText } from '../src/shared/llm-response.js';
import { planRetry, statusFromError } from '../src/shared/backoff.js';
import { redactSecrets } from '../src/shared/redact.js';
import { buildAlert } from '../src/shared/alert.js';
import { normalizeTranscript } from '../src/meeting/normalize-transcript.js';
import { buildMeetingRequest, MEETING_NOTES_SCHEMA } from '../src/meeting/claude-request.js';
import { validateMeetingNotes } from '../src/meeting/validate-notes.js';
import { parseMeetingResponse, toTaskItems, nextIsoDate } from '../src/meeting/notion-content.js';
import { dayWindow, expandCalendars } from '../src/calendar/day-window.js';
import { mergeEvents } from '../src/calendar/merge-events.js';
import { buildDigestRequest, composeDigest } from '../src/calendar/digest.js';
import { chunkDocument, buildQdrantPoints } from '../src/docqa/chunk.js';
import { buildRagRequest, formatAnswer, normalizeQuestion } from '../src/docqa/rag.js';
import { buildErrorRecord, shouldAlert } from '../src/errors/error-record.js';
import { sample } from './harness.mjs';

// ---------------------------------------------------------------- shared
test('clip marks truncation and leaves short text alone', () => {
  assert.equal(clip('short', 10), 'short');
  const out = clip('word '.repeat(100), 50);
  assert.ok(out.length <= 50);
  assert.ok(out.endsWith('[...truncated]'));
});

test('escapeHtml escapes Telegram HTML metacharacters', () => {
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
});

test('isValidIsoDate rejects impossible dates', () => {
  assert.ok(isValidIsoDate('2026-02-28'));
  assert.ok(!isValidIsoDate('2026-02-30'));
  assert.ok(!isValidIsoDate('26-02-01'));
});

test('stableUuid is deterministic and UUID-shaped', () => {
  assert.equal(stableUuid('a'), stableUuid('a'));
  assert.notEqual(stableUuid('a'), stableUuid('b'));
  assert.match(stableUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('extractJson: clean JSON needs no repair', () => {
  assert.deepEqual(extractJson('{"a":1}'), { value: { a: 1 }, repairs: [] });
});

test('extractJson: repairs fences, prose, smart quotes and trailing commas', () => {
  const r = extractJson('Sure!\n```json\n{“a”: [1, 2,],}\n```\nBye');
  assert.deepEqual(r.value, { a: [1, 2] });
  assert.deepEqual(r.repairs, ['strip-code-fence', 'normalize-smart-quotes', 'remove-trailing-commas']);
});

test('extractJson: throws a readable error on hopeless input', () => {
  assert.throws(() => extractJson('no json here'), /Could not parse model output as JSON/);
  assert.throws(() => extractJson(''), /no text/);
});

test('readLlmText: skips thinking blocks, detects fallback, refusal and truncation', () => {
  const ok = readLlmText({ content: [{ type: 'thinking', thinking: '' }, { type: 'fallback' }, { type: 'text', text: 'hi' }], stop_reason: 'end_turn', model: 'm' });
  assert.deepEqual(ok, { ok: true, provider: 'anthropic', text: 'hi', model: 'm', fellBack: true });
  assert.match(readLlmText(sample('anthropic-refusal.json')).error, /declined/);
  assert.match(readLlmText({ content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens' }).error, /max_tokens/);
  assert.equal(readLlmText(sample('ollama-digest-response.json')).provider, 'ollama');
  assert.equal(readLlmText({ error: { message: 'boom' } }).ok, false);
});

test('statusFromError finds the HTTP status in n8n error shapes', () => {
  assert.equal(statusFromError({ httpCode: '429' }), 429);
  assert.equal(statusFromError({ message: 'Request failed with status code 529' }), 529);
  assert.equal(statusFromError({ message: 'socket hang up' }), null);
});

test('planRetry: exponential backoff with jitter, stops on 4xx and when exhausted', () => {
  const mid = () => 0.5;
  const a1 = planRetry({ attempt: 1, error: { httpCode: 429 }, random: mid });
  const a3 = planRetry({ attempt: 3, error: { httpCode: 529 }, random: mid });
  assert.equal(a1.retry, true);
  assert.equal(a1.waitSeconds, 8); // 10 * 2^0 = 10 -> 5 + 0.5*5
  assert.equal(a3.waitSeconds, 30); // 40 -> 20 + 10
  assert.equal(planRetry({ attempt: 1, error: { httpCode: 401 } }).retry, false);
  assert.equal(planRetry({ attempt: 4, maxAttempts: 4, error: { httpCode: 500 } }).retry, false);
  assert.equal(planRetry({ attempt: 1, error: { message: 'ETIMEDOUT' } }).retry, true);
  assert.equal(planRetry({ attempt: 10, maxAttempts: 20, capSeconds: 300, error: { httpCode: 503 }, random: () => 1 }).waitSeconds, 300);
});

test('redactSecrets scrubs keys and tokens but keeps the message readable', () => {
  const out = redactSecrets('401 invalid x-api-key: sk-ant-demo-NOT-A-REAL-KEY-000000 (Bearer abcdefghijklmnop1234)');
  assert.ok(!out.includes('NOT-A-REAL-KEY'));
  assert.ok(!out.includes('abcdefghijklmnop1234'));
  assert.match(out, /^401 invalid/);
});

test('buildAlert produces escaped Telegram HTML and plain email text', () => {
  const a = buildAlert({ workflow: 'W <1>', stage: 'step', message: 'bad & worse', details: { Meeting: 'x' }, executionUrl: 'http://n8n/e/1', hint: 'do this' });
  assert.match(a.telegramHtml, /W &lt;1&gt;/);
  assert.match(a.telegramHtml, /bad &amp; worse/);
  assert.match(a.emailText, /What to do: do this/);
  assert.equal(a.emailSubject, '[home-n8n] W <1>: step failed');
});

// ---------------------------------------------------------------- meeting
test('normalizeTranscript: Fathom-style payload', () => {
  const m = normalizeTranscript(sample('fathom-webhook.json'));
  assert.equal(m.source, 'fathom');
  assert.equal(m.meetingId, 'fathom:918273');
  assert.deepEqual(m.attendees, ['Sam Alder', 'Jordan Alder']);
  assert.equal(m.durationMin, 24);
  assert.match(m.transcriptText, /^\[00:00:04\] Sam Alder: Okay, three things/);
});

test('normalizeTranscript: Granola-style and generic payloads', () => {
  const g = normalizeTranscript(sample('granola-webhook.json'));
  assert.equal(g.source, 'granola');
  assert.equal(g.url, 'https://notes.granola.example/d/gr_demo_5521');
  const x = normalizeTranscript(sample('generic-webhook.json'));
  assert.equal(x.source, 'generic');
  assert.equal(x.startedAt, '2026-09-24T22:00:00.000Z');
  assert.match(x.meetingId, /^generic:[0-9a-f]{8}$/);
});

test('normalizeTranscript: rejects payloads without a transcript', () => {
  assert.throws(() => normalizeTranscript({ title: 'x' }), /No transcript/);
  assert.throws(() => normalizeTranscript(null), /empty/);
});

test('buildMeetingRequest: structured output schema, model from config, fallbacks toggle', () => {
  const m = normalizeTranscript(sample('fathom-webhook.json'));
  const { meetingDate, claudeRequest } = buildMeetingRequest(m, { anthropicModel: 'claude-opus-5', timezone: 'America/New_York' });
  assert.equal(meetingDate, '2026-09-21');
  assert.equal(claudeRequest.model, 'claude-opus-5');
  assert.equal(claudeRequest.fallbacks, 'default');
  assert.deepEqual(claudeRequest.output_config.format, { type: 'json_schema', schema: MEETING_NOTES_SCHEMA });
  assert.match(claudeRequest.messages[0].content, /Meeting date: 2026-09-21 \(Monday\)/);
  assert.ok(!('thinking' in claudeRequest) && !('temperature' in claudeRequest));
  const noFb = buildMeetingRequest(m, { useServerFallbacks: false }).claudeRequest;
  assert.ok(!('fallbacks' in noFb));
});

test('MEETING_NOTES_SCHEMA: every object is closed and fully required (structured outputs rules)', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength']) assert.ok(!(k in s));
  };
  walk(MEETING_NOTES_SCHEMA);
});

test('validateMeetingNotes: repairs owners, dates, priorities and duplicates with warnings', () => {
  const r = validateMeetingNotes(
    {
      summary: 'ok',
      actionItems: [
        { task: 'A', owner: 'jordan', dueDate: '2026-02-30', priority: 'urgent' },
        { task: 'a', owner: 'Jordan Alder' },
        { task: '', owner: 'x' },
        { task: 'B', owner: '', dueDate: '2020-01-01' },
      ],
      decisions: 'not a list',
    },
    { meetingDate: '2026-09-21', attendees: ['Sam Alder', 'Jordan Alder'] },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.actionItems.map((a) => [a.task, a.owner, a.dueDate, a.priority]), [
    ['A', 'Jordan Alder', null, 'normal'],
    ['B', 'Unassigned', null, 'normal'],
  ]);
  assert.equal(r.warnings.length, 5);
});

test('validateMeetingNotes: hard errors block writing', () => {
  assert.equal(validateMeetingNotes([]).ok, false);
  assert.deepEqual(validateMeetingNotes({ actionItems: {} }).errors, ['summary is missing', 'actionItems must be a list']);
});

test('parseMeetingResponse + toTaskItems on the sample Claude response', () => {
  const meeting = normalizeTranscript(sample('fathom-webhook.json'));
  const parsed = parseMeetingResponse(sample('anthropic-meeting-response.json'), { meeting, meetingDate: '2026-09-21' });
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.meeting.transcriptText, undefined);
  assert.equal(parsed.notes.actionItems[0].owner, 'Jordan Alder');
  assert.match(parsed.notion.actionItemsText, /Brightwell Heating and book the annual boiler service -> Jordan Alder \(due 2026-09-25\) \[high\]/);
  const tasks = toTaskItems(parsed, { id: 'page-1', url: 'https://notion.so/page-1' }, {});
  assert.deepEqual(tasks.map((t) => t.addToCalendar), [true, true, false]);
  for (const t of tasks.filter((x) => x.dueDate)) assert.ok(t.calendarEndDate > t.dueDate, 'all-day end date must be exclusive');
  assert.equal(nextIsoDate('2026-12-31'), '2027-01-01');
  assert.equal(tasks[0].meetingPageId, 'page-1');
  assert.equal(toTaskItems(parsed, { id: 'p' }, { createCalendarEvents: false }).some((t) => t.addToCalendar), false);
});

test('parseMeetingResponse: refusal and garbage become ok:false with a stage', () => {
  const meeting = normalizeTranscript(sample('generic-webhook.json'));
  assert.deepEqual(
    [parseMeetingResponse(sample('anthropic-refusal.json'), { meeting }).stage, parseMeetingResponse({ content: [{ type: 'text', text: 'nope' }], stop_reason: 'end_turn' }, { meeting }).stage],
    ['claude-response', 'parse-json'],
  );
});

// ---------------------------------------------------------------- calendar
test('dayWindow covers one local day, including DST changes', () => {
  assert.deepEqual(dayWindow(new Date('2026-09-25T11:00:00Z'), 'America/New_York'), {
    date: '2026-09-25', timeMin: '2026-09-25T04:00:00.000Z', timeMax: '2026-09-26T04:00:00.000Z',
  });
  const fallBack = dayWindow(new Date('2026-11-01T12:00:00Z'), 'America/New_York'); // 25-hour day
  assert.equal((new Date(fallBack.timeMax) - new Date(fallBack.timeMin)) / 3600000, 25);
  assert.throws(() => expandCalendars({ calendars: [] }), /empty/);
});

function sampleEvents() {
  const s = sample('google-calendar-events.json');
  return s.eventsByCalendar.flatMap((list, i) => list.map((e) => ({ ...e, _calendar: s.calendars[i] })));
}

test('mergeEvents: dedupes shared events, drops cancelled, sorts, flags overlaps', () => {
  const day = mergeEvents(sampleEvents(), { date: '2026-09-25', timezone: 'America/New_York' });
  assert.equal(day.dateLabel, 'Friday, September 25');
  assert.deepEqual(day.events.map((e) => e.title), ['Recycling out', 'Dentist - Sam', 'Work call', 'School pickup', 'Leo soccer practice']);
  assert.deepEqual(day.events.find((e) => e.title === 'School pickup').members, ['Sam', 'Jordan']);
  assert.equal(day.events[1].timeLabel, '8:30 AM-9:15 AM');
  assert.equal(day.conflicts.length, 1);
  assert.match(day.conflicts[0].first, /Work call/);
});

test('buildDigestRequest: privacy - no locations/notes to the cloud by default; Ollama gets everything', () => {
  const day = mergeEvents(sampleEvents(), { date: '2026-09-25', timezone: 'America/New_York' });
  const cloud = buildDigestRequest(day, { llmProvider: 'claude' });
  assert.equal(cloud.route, 'claude');
  assert.ok(!cloud.request.messages[0].content.includes('Riverside'));
  assert.ok(!cloud.request.messages[0].content.includes('shin guards'));
  const local = buildDigestRequest(day, { llmProvider: 'ollama' });
  assert.equal(local.route, 'ollama');
  assert.ok(local.request.messages[1].content.includes('Riverside Field 2'));
  assert.equal(buildDigestRequest({ ...day, eventCount: 0, events: [] }, {}).route, 'none');
});

test('composeDigest: uses the LLM text, falls back to a plain digest when the LLM failed', () => {
  const day = mergeEvents(sampleEvents(), { date: '2026-09-25', timezone: 'America/New_York' });
  const good = composeDigest(day, sample('ollama-digest-response.json'), { familyName: 'Alder' });
  assert.equal(good.usedFallback, false);
  assert.match(good.telegramText, /^<b>Alder calendar - Friday, September 25<\/b>/);
  const bad = composeDigest(day, { error: { message: 'ECONNREFUSED' } }, {});
  assert.equal(bad.usedFallback, true);
  assert.match(bad.emailBody, /8:30 AM-9:15 AM - Dentist - Sam/);
  assert.match(bad.emailBody, /AI writer was unavailable/);
});

// ---------------------------------------------------------------- doc QA
test('chunkDocument: paragraph packing, headings, overlap, stable ids', () => {
  const doc = ['# Title', 'Intro paragraph.', '## Section A', 'a '.repeat(300), '## Section B', 'b '.repeat(300)].join('\n\n');
  const chunks = chunkDocument({ path: 'x.md', text: doc }, { maxChars: 700, overlapChars: 100 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.text.length <= 700));
  assert.equal(chunks.at(-1).heading, 'Section B');
  assert.deepEqual(chunks.map((c) => c.chunkIndex), chunks.map((_, i) => i));
  assert.deepEqual(chunkDocument({ path: 'x.md', text: doc }, { maxChars: 700, overlapChars: 100 }).map((c) => c.id), chunks.map((c) => c.id));
  assert.deepEqual(chunkDocument({ path: 'e.md', text: '  ' }), []);
});

test('chunkDocument on the demo boiler document keeps section headings', () => {
  const text = readFileSync(new URL('../samples/docs/home/boiler.md', import.meta.url), 'utf8');
  const chunks = chunkDocument({ path: 'home/boiler.md', text }, { maxChars: 300, overlapChars: 60 });
  assert.ok(chunks.some((c) => c.heading === 'Annual service' && c.text.includes('13 months')));
  assert.ok(chunks.every((c) => c.path === 'home/boiler.md'));
});

test('buildQdrantPoints: batches points and prepares stale-chunk deletion per file', () => {
  const chunks = Array.from({ length: 70 }, (_, i) => ({ id: `id${i}`, path: i < 35 ? 'a.md' : 'b.md', chunkIndex: i, heading: null, text: 't' }));
  const out = buildQdrantPoints(chunks, chunks.map(() => [0.1, 0.2]));
  assert.deepEqual(out.batches.map((b) => b.points.length), [64, 6]);
  assert.deepEqual(out.deleteRequest.filter.must[0].match.any, ['a.md', 'b.md']);
  assert.throws(() => buildQdrantPoints(chunks, []), /embeddings/);
});

test('normalizeQuestion validates input', () => {
  assert.deepEqual(normalizeQuestion({ body: { question: '  When is the boiler service? ' } }), { ok: true, question: 'When is the boiler service?', topK: null });
  assert.equal(normalizeQuestion({ body: {} }).status, 400);
});

test('buildRagRequest drops low-score hits and numbers sources', () => {
  const r = buildRagRequest('q', sample('qdrant-search-response.json').result, { minScore: 0.35 });
  assert.equal(r.hasSources, true);
  assert.deepEqual(r.sources.map((s) => [s.n, s.path]), [[1, 'home/boiler.md'], [2, 'home/boiler.md']]);
  assert.match(r.request.messages[1].content, /\[1\] home\/boiler\.md > Annual service/);
  assert.equal(buildRagRequest('q', [], {}).hasSources, false);
});

test('formatAnswer keeps valid citations and strips invented ones', () => {
  const { sources } = buildRagRequest('q', sample('qdrant-search-response.json').result, {});
  const a = formatAnswer(sample('ollama-answer-response.json'), sources, 'q');
  assert.equal(a.grounded, true);
  assert.deepEqual(a.citations.map((c) => c.n), [1]);
  assert.ok(!a.answer.includes('[7]'));
  assert.match(a.warnings[0], /non-existent sources: 7/);
  const nf = formatAnswer({ message: { content: "I couldn't find that in the documents." } }, sources, 'q');
  assert.equal(nf.grounded, false);
});

// ---------------------------------------------------------------- errors
test('buildErrorRecord: structured, redacted, with hint and fingerprint', () => {
  const r = buildErrorRecord(sample('error-trigger.json'), new Date('2026-09-25T12:00:00Z'));
  assert.equal(r.workflow.id, 'HmMeetingNotes01');
  assert.equal(r.failedNode, 'Claude: Extract Notes');
  assert.equal(r.severity, 'high');
  assert.ok(!JSON.stringify(r).includes('NOT-A-REAL-KEY'));
  assert.match(r.hint, /Rotating API keys/);
  assert.match(r.fingerprint, /^[0-9a-f]{8}$/);
  const t = buildErrorRecord({ trigger: { error: { message: 'boom' }, mode: 'trigger' }, workflow: { id: 'w', name: 'W' } });
  assert.equal(t.kind, 'trigger');
});

test('shouldAlert suppresses repeats inside the window but never auth errors', () => {
  const state = {};
  const rec = { fingerprint: 'f1', severity: 'medium' };
  const t0 = new Date('2026-09-25T12:00:00Z');
  assert.equal(shouldAlert(rec, state, t0).alert, true);
  assert.equal(shouldAlert(rec, state, new Date(t0.getTime() + 10 * 60000)).alert, false);
  assert.equal(shouldAlert(rec, state, new Date(t0.getTime() + 31 * 60000)).alert, true);
  assert.equal(shouldAlert({ fingerprint: 'f2', severity: 'high' }, state, t0).alert, true);
  assert.equal(shouldAlert({ fingerprint: 'f2', severity: 'high' }, state, t0).alert, true);
});
