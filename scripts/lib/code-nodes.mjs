// Single source of truth for which src/ modules become which n8n Code node.
//
// The JavaScript inside every Code node is generated: the listed modules are
// concatenated (import lines and `export` keywords removed) and the `entry`
// snippet - the only n8n-specific part, which reads $input / $('Node') - is
// appended. scripts/build-workflows.mjs writes it into workflows/*.json and
// scripts/validate.mjs fails if a workflow drifts from its source.

import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CODE_NODES = [
  // ---- meeting-notes-to-notion ------------------------------------------
  {
    workflow: 'meeting-notes-to-notion.json',
    node: 'Normalize Transcript',
    modules: ['src/meeting/normalize-transcript.js'],
    entry: `return $input.all().map((item) => ({ json: normalizeTranscript(item.json.body ?? item.json) }));`,
  },
  {
    workflow: 'meeting-notes-to-notion.json',
    node: 'Build Claude Request',
    modules: ['src/meeting/claude-request.js'],
    entry: `const config = $('Config').first().json;
return $input.all().map((item) => ({ json: { meeting: item.json, ...buildMeetingRequest(item.json, config) } }));`,
  },
  {
    workflow: 'meeting-notes-to-notion.json',
    node: 'Plan Retry',
    modules: ['src/shared/backoff.js'],
    entry: `// $runIndex counts how many times this node already ran in this execution,
// i.e. how many Claude attempts have failed so far (minus one).
const config = $('Config').first().json;
const request = $('Build Claude Request').first().json;
return $input.all().map((item) => ({
  json: {
    ...request,
    retry: planRetry({
      attempt: $runIndex + 1,
      maxAttempts: Number(config.maxAttempts) || 4,
      baseSeconds: Number(config.retryBaseSeconds) || 10,
      error: item.json.error ?? item.json,
    }),
  },
}));`,
  },
  {
    workflow: 'meeting-notes-to-notion.json',
    node: 'Parse & Validate Notes',
    modules: ['src/meeting/notion-content.js'],
    entry: `const built = $('Build Claude Request').first().json;
return $input.all().map((item) => ({
  json: parseMeetingResponse(item.json, { meeting: built.meeting, meetingDate: built.meetingDate }),
}));`,
  },
  {
    workflow: 'meeting-notes-to-notion.json',
    node: 'Prepare Tasks',
    modules: ['src/meeting/notion-content.js'],
    entry: `const config = $('Config').first().json;
const parsed = $('Parse & Validate Notes').first().json;
const page = $input.first().json;
return toTaskItems(parsed, { id: page.id, url: page.url }, config).map((json) => ({ json }));`,
  },
  {
    workflow: 'meeting-notes-to-notion.json',
    node: 'Build Alert',
    modules: ['src/shared/alert.js'],
    entry: `const config = $('Config').first().json;
const runUrl = config.n8nBaseUrl ? \`\${config.n8nBaseUrl.replace(/\\/$/, '')}/workflow/\${$workflow.id}/executions/\${$execution.id}\` : null;
return $input.all().map((item) => {
  const j = item.json;
  const fromRetry = Boolean(j.retry);
  return {
    json: {
      chatId: config.telegramChatId,
      alertEmail: config.alertEmail,
      ...buildAlert({
        workflow: $workflow.name,
        stage: fromRetry ? 'Claude API call' : j.stage || 'unknown step',
        message: fromRetry ? j.retry.reason : j.error,
        details: { Meeting: j.meeting?.title, Source: j.meeting?.source },
        executionUrl: runUrl,
        hint: fromRetry
          ? 'Nothing was lost - the transcript is stored in this n8n run. Retry the execution once the API is healthy.'
          : 'Open the run in n8n to see the Claude output; the transcript is stored there.',
      }),
    },
  };
});`,
  },

  // ---- family-calendar-digest -------------------------------------------
  {
    workflow: 'family-calendar-digest.json',
    node: 'Expand Calendars',
    modules: ['src/calendar/day-window.js'],
    entry: `const config = $('Config').first().json;
return expandCalendars(config, new Date()).map((json) => ({ json }));`,
  },
  {
    workflow: 'family-calendar-digest.json',
    node: 'Merge & Dedupe Events',
    modules: ['src/calendar/merge-events.js'],
    entry: `// Google Calendar returns one item per event; pairedItem tells us which
// calendar (input item of "Expand Calendars") each event came from.
const calendars = $('Expand Calendars').all().map((i) => i.json);
const events = $input.all()
  .filter((item) => item.json && item.json.start)
  .map((item) => {
    const paired = Array.isArray(item.pairedItem) ? item.pairedItem[0] : item.pairedItem;
    const cal = calendars[paired?.item ?? 0] || {};
    return { ...item.json, _calendar: { member: cal.member, label: cal.label } };
  });
const first = calendars[0] || {};
return [{ json: mergeEvents(events, { date: first.date, timezone: first.timezone }) }];`,
  },
  {
    workflow: 'family-calendar-digest.json',
    node: 'Build Digest Request',
    modules: ['src/calendar/digest.js'],
    entry: `const config = $('Config').first().json;
return [{ json: buildDigestRequest($input.first().json, config) }];`,
  },
  {
    workflow: 'family-calendar-digest.json',
    node: 'Compose Digest',
    modules: ['src/calendar/digest.js'],
    entry: `const config = $('Config').first().json;
const day = $('Merge & Dedupe Events').first().json;
const route = $('Build Digest Request').first().json.route;
const response = route === 'none' ? null : $input.first().json;
return [{ json: { chatId: config.telegramChatId, emailTo: config.digestEmailTo, ...composeDigest(day, response, config) } }];`,
  },

  // ---- private-doc-qa-local-llm -----------------------------------------
  {
    workflow: 'private-doc-qa-local-llm.json',
    node: 'Chunk Documents',
    modules: ['src/docqa/chunk.js'],
    entry: `const config = $('Config').first().json;
const root = String(config.docsRoot || '').replace(/\\/$/, '');
const files = $('Read Documents').all();
const out = [];
$input.all().forEach((item, idx) => {
  const paired = Array.isArray(item.pairedItem) ? item.pairedItem[0] : item.pairedItem;
  const meta = files[paired?.item ?? idx]?.binary?.data || {};
  let path = meta.directory && meta.fileName ? \`\${meta.directory}/\${meta.fileName}\` : meta.fileName || \`document-\${idx}\`;
  if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1);
  const chunks = chunkDocument({ path, text: item.json.data }, {
    maxChars: Number(config.chunkChars) || 1200,
    overlapChars: Number(config.chunkOverlap) || 200,
  });
  for (const chunk of chunks) out.push({ json: chunk, pairedItem: { item: idx } });
});
return out;`,
  },
  {
    workflow: 'private-doc-qa-local-llm.json',
    node: 'Build Qdrant Points',
    modules: ['src/docqa/chunk.js'],
    entry: `const chunks = $('Chunk Documents').all().map((i) => i.json);
const embeddings = $input.all().map((i) => i.json.embeddings?.[0]);
return [{ json: buildQdrantPoints(chunks, embeddings) }];`,
  },
  {
    workflow: 'private-doc-qa-local-llm.json',
    node: 'Split Upsert Batches',
    modules: [],
    entry: `return $('Build Qdrant Points').first().json.batches.map((batch) => ({ json: batch }));`,
  },
  {
    workflow: 'private-doc-qa-local-llm.json',
    node: 'Validate Question',
    modules: ['src/docqa/rag.js'],
    entry: `return $input.all().map((item) => ({ json: normalizeQuestion(item.json) }));`,
  },
  {
    workflow: 'private-doc-qa-local-llm.json',
    node: 'Build Grounded Prompt',
    modules: ['src/docqa/rag.js'],
    entry: `const config = $('Config').first().json;
const q = $('Validate Question').first().json;
const hits = $input.first().json.result ?? [];
return [{ json: { question: q.question, ...buildRagRequest(q.question, hits, config) } }];`,
  },
  {
    workflow: 'private-doc-qa-local-llm.json',
    node: 'Format Answer',
    modules: ['src/docqa/rag.js'],
    entry: `const prompt = $('Build Grounded Prompt').first().json;
return [{ json: formatAnswer($input.first().json, prompt.sources, prompt.question) }];`,
  },

  // ---- error-handler ------------------------------------------------------
  {
    workflow: 'error-handler.json',
    node: 'Build Error Record',
    modules: ['src/errors/error-record.js'],
    entry: `// Static data persists between production executions (not manual test runs).
const config = $('Config').first().json;
const state = $getWorkflowStaticData('global');
const now = new Date();
const record = buildErrorRecord($('Error Trigger').first().json, now);
const decision = shouldAlert(record, state, now, Number(config.alertWindowMinutes) || 30);
return [{
  json: {
    ...record,
    alert: decision.alert,
    suppressedSinceMinutes: decision.suppressedSinceMinutes,
    logLine: JSON.stringify(record) + '\\n', // one JSON object per line (JSONL)
    chatId: config.telegramChatId,
  },
}];`,
  },
  {
    workflow: 'error-handler.json',
    node: 'Format Alert',
    modules: ['src/shared/alert.js'],
    entry: `return $input.all().map((item) => {
  const r = item.json;
  return {
    json: {
      chatId: r.chatId,
      ...buildAlert({
        workflow: r.workflow.name,
        stage: r.failedNode || r.kind,
        message: r.message,
        details: { Severity: r.severity, Execution: r.execution.id },
        executionUrl: r.execution.url,
        hint: r.hint,
      }),
    },
  };
});`,
  },
];

function moduleBody(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  return src
    .split('\n')
    .filter((line) => !/^import\s.+from\s+['"].+['"];?\s*$/.test(line))
    .join('\n')
    .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, '')
    .trim();
}

/**
 * Roots plus everything they import (relative imports only), dependencies
 * first, each module once. Keeps the concatenated bundle in a valid order.
 */
export function expandModules(roots) {
  const ordered = [];
  const visit = (rel, stack = []) => {
    if (ordered.includes(rel)) return;
    if (stack.includes(rel)) throw new Error(`Import cycle: ${[...stack, rel].join(' -> ')}`);
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/^import\s.+from\s+['"](\.{1,2}\/[^'"]+)['"];?\s*$/gm)) {
      visit(posix.normalize(posix.join(posix.dirname(rel), m[1])), [...stack, rel]);
    }
    ordered.push(rel);
  };
  roots.forEach((r) => visit(r));
  return ordered;
}

/** The exact jsCode string a Code node must contain. */
export function generateCode(spec) {
  const modules = expandModules(spec.modules);
  const header = [
    '// ---------------------------------------------------------------------------',
    `// GENERATED by scripts/build-workflows.mjs from: ${modules.length ? modules.join(', ') : '(entry only)'}`,
    '// Edit the files in src/ (unit-tested) and run `npm run build` - not this box.',
    '// ---------------------------------------------------------------------------',
  ].join('\n');
  const bodies = modules.map((m) => `// ---- ${m}\n${moduleBody(m)}`);
  return [header, ...bodies, '// ---- n8n entry point', spec.entry].join('\n\n') + '\n';
}
