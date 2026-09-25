// "Mock run" of each workflow: the real jsCode from workflows/*.json is
// executed in a vm sandbox, chained node to node, with samples/ standing in
// for the webhook payloads and the HTTP / Google / Notion responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configOf, items, runCodeNode, sample } from './harness.mjs';

const MEETING = 'meeting-notes-to-notion.json';
const DIGEST = 'family-calendar-digest.json';
const DOCQA = 'private-doc-qa-local-llm.json';
const ERRORS = 'error-handler.json';

async function meetingUpToClaude(payloadFile) {
  const config = configOf(MEETING);
  const webhookItem = { headers: {}, params: {}, query: {}, body: sample(payloadFile) };
  const normalized = await runCodeNode(MEETING, 'Normalize Transcript', { input: items(webhookItem) });
  const built = await runCodeNode(MEETING, 'Build Claude Request', { input: normalized, nodes: { Config: items(config) } });
  return { config, built };
}

test('meeting workflow: webhook -> Claude request -> parsed notes -> Notion tasks', async () => {
  const { config, built } = await meetingUpToClaude('fathom-webhook.json');
  const req = built[0].json.claudeRequest;
  assert.equal(req.model, config.anthropicModel);
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.match(req.messages[0].content, /<transcript>\n\[00:00:04\] Sam Alder:/);

  const parsed = await runCodeNode(MEETING, 'Parse & Validate Notes', {
    input: items(sample('anthropic-meeting-response.json')),
    nodes: { 'Build Claude Request': built },
  });
  assert.equal(parsed[0].json.ok, true);
  assert.equal(parsed[0].json.notion.date, '2026-09-21');

  const tasks = await runCodeNode(MEETING, 'Prepare Tasks', {
    input: items({ id: 'notion-page-123', url: 'https://www.notion.so/notion-page-123' }),
    nodes: { Config: items(config), 'Parse & Validate Notes': parsed },
  });
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.json.owner), ['Jordan Alder', 'Sam Alder', 'Unassigned']);
  assert.equal(tasks[0].json.meetingPageId, 'notion-page-123');
});

test('meeting workflow: messy model output is repaired and flagged, not silently trusted', async () => {
  const { built } = await meetingUpToClaude('generic-webhook.json');
  const parsed = await runCodeNode(MEETING, 'Parse & Validate Notes', {
    input: items(sample('anthropic-meeting-response-messy.json')),
    nodes: { 'Build Claude Request': built },
  });
  const j = parsed[0].json;
  assert.equal(j.ok, true);
  assert.equal(j.notes.actionItems.length, 2);
  assert.ok(j.warnings.some((w) => /JSON needed repair/.test(w)));
  assert.ok(j.warnings.some((w) => /invalid due date "2026-02-30"/.test(w)));
  assert.ok(j.warnings.some((w) => /before the meeting/.test(w)));
  assert.match(j.notion.warningsText, /^Automation notes:/);
});

test('meeting workflow: 429 -> backoff retry; 401 -> alert without retry', async () => {
  const { config, built } = await meetingUpToClaude('fathom-webhook.json');
  const nodes = { Config: items(config), 'Build Claude Request': built };

  const retry = await runCodeNode(MEETING, 'Plan Retry', { input: items({ error: { message: 'Too many requests', httpCode: '429' } }), nodes, runIndex: 0 });
  assert.equal(retry[0].json.retry.retry, true);
  assert.ok(retry[0].json.retry.waitSeconds >= 5 && retry[0].json.retry.waitSeconds <= 10);
  assert.ok(retry[0].json.claudeRequest, 'request is carried through the Wait node back to the HTTP node');

  const lastTry = await runCodeNode(MEETING, 'Plan Retry', { input: items({ error: { httpCode: 529 } }), nodes, runIndex: config.maxAttempts - 1 });
  assert.equal(lastTry[0].json.retry.retry, false);

  const auth = await runCodeNode(MEETING, 'Plan Retry', { input: items({ error: { httpCode: 401, message: 'invalid x-api-key' } }), nodes });
  assert.equal(auth[0].json.retry.retry, false);

  const alert = await runCodeNode(MEETING, 'Build Alert', { input: auth, nodes });
  assert.equal(alert[0].json.chatId, config.telegramChatId);
  assert.match(alert[0].json.telegramHtml, /Claude API call/);
  assert.match(alert[0].json.telegramHtml, /Alder family weekly planning/);
  assert.match(alert[0].json.telegramHtml, /executions\/42/);
});

test('meeting workflow: invalid notes branch produces an alert', async () => {
  const { config, built } = await meetingUpToClaude('granola-webhook.json');
  const parsed = await runCodeNode(MEETING, 'Parse & Validate Notes', {
    input: items(sample('anthropic-refusal.json')),
    nodes: { 'Build Claude Request': built },
  });
  assert.equal(parsed[0].json.ok, false);
  const alert = await runCodeNode(MEETING, 'Build Alert', { input: parsed, nodes: { Config: items(config) } });
  assert.match(alert[0].json.emailSubject, /claude-response failed/);
});

test('calendar workflow: 4 calendars -> merged day -> Claude request (no locations) -> digest', async () => {
  const config = configOf(DIGEST);
  const s = sample('google-calendar-events.json');
  const expandConfig = { ...config, calendars: s.calendars, timezone: s.timezone };
  const expanded = await runCodeNode(DIGEST, 'Expand Calendars', { nodes: { Config: items(expandConfig) } });
  assert.equal(expanded.length, 4);
  assert.ok(expanded.every((e) => e.json.timeMin && e.json.timeMax));

  // Google Calendar node output: one item per event, pairedItem -> calendar index
  const gcal = s.eventsByCalendar.flatMap((events, i) => events.map((e) => ({ json: e, pairedItem: { item: i } })));
  gcal.push({ json: {}, pairedItem: { item: 0 } }); // alwaysOutputData placeholder
  const pinnedDay = expanded.map((e) => ({ json: { ...e.json, date: '2026-09-25' } }));
  const merged = await runCodeNode(DIGEST, 'Merge & Dedupe Events', { input: gcal, nodes: { 'Expand Calendars': pinnedDay } });
  assert.equal(merged[0].json.eventCount, 5);
  assert.equal(merged[0].json.conflicts.length, 1);

  const request = await runCodeNode(DIGEST, 'Build Digest Request', { input: merged, nodes: { Config: items(config) } });
  assert.equal(request[0].json.route, 'claude');
  assert.ok(!JSON.stringify(request[0].json.request).includes('Maple St Dental'));

  const composed = await runCodeNode(DIGEST, 'Compose Digest', {
    input: items(sample('ollama-digest-response.json')),
    nodes: { Config: items(config), 'Merge & Dedupe Events': merged, 'Build Digest Request': request },
  });
  assert.equal(composed[0].json.usedFallback, false);
  assert.equal(composed[0].json.chatId, config.telegramChatId);
  assert.ok(composed[0].json.telegramText.length <= 4000);
});

test('calendar workflow: empty day skips the LLM and still sends a digest', async () => {
  const config = configOf(DIGEST);
  const cal = items({ calendarId: 'x', label: 'Family', member: 'Everyone', date: '2026-09-26', timezone: 'America/New_York' });
  const merged = await runCodeNode(DIGEST, 'Merge & Dedupe Events', { input: [{ json: {}, pairedItem: { item: 0 } }], nodes: { 'Expand Calendars': cal } });
  const request = await runCodeNode(DIGEST, 'Build Digest Request', { input: merged, nodes: { Config: items(config) } });
  assert.equal(request[0].json.route, 'none');
  const composed = await runCodeNode(DIGEST, 'Compose Digest', {
    input: request,
    nodes: { Config: items(config), 'Merge & Dedupe Events': merged, 'Build Digest Request': request },
  });
  assert.match(composed[0].json.emailBody, /Nothing is on the family calendar/);
});

test('doc QA workflow: files -> chunks -> points; question -> prompt -> cited answer', async () => {
  const config = configOf(DOCQA);
  const docs = ['home/boiler.md', 'insurance/home-policy.md', 'school.txt'];
  const readItems = docs.map((d) => {
    const parts = `${config.docsRoot}/${d}`.split('/');
    return { json: {}, binary: { data: { fileName: parts.pop(), directory: parts.join('/') } } };
  });
  const extracted = docs.map((d, i) => ({
    json: { data: readFileSync(new URL(`../samples/docs/${d}`, import.meta.url), 'utf8') },
    pairedItem: { item: i },
  }));
  const chunks = await runCodeNode(DOCQA, 'Chunk Documents', { input: extracted, nodes: { Config: items(config), 'Read Documents': readItems } });
  assert.ok(chunks.length >= 3);
  assert.deepEqual([...new Set(chunks.map((c) => c.json.path))], docs);

  const embeddings = chunks.map(() => ({ json: { model: config.embedModel, embeddings: [Array(8).fill(0.01)] } }));
  const points = await runCodeNode(DOCQA, 'Build Qdrant Points', { input: embeddings, nodes: { 'Chunk Documents': chunks } });
  assert.equal(points[0].json.pointCount, chunks.length);
  const batches = await runCodeNode(DOCQA, 'Split Upsert Batches', { input: items({ status: 'ok' }), nodes: { 'Build Qdrant Points': points } });
  assert.equal(batches.length, 1);

  const q = await runCodeNode(DOCQA, 'Validate Question', { input: items({ ...config, body: { question: 'When is the boiler service due?' } }) });
  assert.equal(q[0].json.ok, true);
  const prompt = await runCodeNode(DOCQA, 'Build Grounded Prompt', {
    input: items(sample('qdrant-search-response.json')),
    nodes: { Config: items(config), 'Validate Question': q },
  });
  assert.equal(prompt[0].json.hasSources, true);
  assert.equal(prompt[0].json.request.model, config.chatModel);
  const answer = await runCodeNode(DOCQA, 'Format Answer', { input: items(sample('ollama-answer-response.json')), nodes: { 'Build Grounded Prompt': prompt } });
  assert.equal(answer[0].json.grounded, true);
  assert.equal(answer[0].json.citations[0].path, 'home/boiler.md');
});

test('error handler: structured JSONL record, redaction, throttled alert', async () => {
  const config = configOf(ERRORS);
  const staticData = {};
  const run = () => runCodeNode(ERRORS, 'Build Error Record', {
    nodes: { Config: items(config), 'Error Trigger': items(sample('error-trigger.json')) },
    staticData,
  });
  const first = await run();
  const rec = first[0].json;
  assert.equal(rec.alert, true);
  assert.ok(rec.logLine.endsWith('\n'));
  assert.deepEqual(JSON.parse(rec.logLine).workflow, { id: 'HmMeetingNotes01', name: 'Meeting notes -> Notion (Claude)' });
  assert.ok(!rec.logLine.includes('NOT-A-REAL-KEY'));
  assert.ok(staticData.lastAlerts[rec.fingerprint]);

  const alert = await runCodeNode(ERRORS, 'Format Alert', { input: first });
  assert.match(alert[0].json.telegramHtml, /Rotating API keys/);
  assert.match(alert[0].json.telegramHtml, /executions\/231/);
});
