import { clip, fnv1a } from '../shared/text.js';
import { redactSecrets } from '../shared/redact.js';

// Turn the Error Trigger payload into (1) a structured JSON log line and
// (2) a decision on whether to alert, with duplicate suppression so a
// workflow failing every 5 minutes does not send 12 messages an hour.

const HINTS = [
  [/401|403|unauthori[sz]ed|invalid.*(api key|token|credential)|forbidden/i, 'A key or login has expired or been revoked. See runbook: "Rotating API keys".'],
  [/429|rate limit|overloaded|529/i, 'The AI service is busy or rate-limited. It usually recovers by itself; if it repeats all day, check the usage limits.'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up/i, 'A service could not be reached. Check that the Mac mini is online and the containers are running (runbook: "Restart everything").'],
  [/ollama|11434/i, 'The local AI (Ollama) did not answer. Check that Ollama is running (runbook: "Restart everything").'],
  [/notion/i, 'Notion rejected the request. Check the database is still shared with the integration.'],
];

function severityFor(message) {
  if (/401|403|unauthori[sz]ed|forbidden|credential/i.test(message)) return 'high';
  if (/429|overloaded|timeout|ETIMEDOUT|529/i.test(message)) return 'low';
  return 'medium';
}

/** @param {object} payload  Error Trigger output item json */
export function buildErrorRecord(payload, now = new Date()) {
  const execution = payload?.execution || {};
  const trigger = payload?.trigger || null;
  const workflow = payload?.workflow || {};
  const err = execution.error || trigger?.error || {};
  const message = redactSecrets(err.message || err.description || 'Unknown error');
  const node = err.node?.name || execution.lastNodeExecuted || null;
  const hint = HINTS.find(([re]) => re.test(message))?.[1] || 'Open the failed run in n8n to see which step broke.';

  const record = {
    ts: now.toISOString(),
    level: 'error',
    severity: severityFor(message),
    workflow: { id: workflow.id || null, name: workflow.name || 'Unknown workflow' },
    execution: {
      id: execution.id || null,
      url: execution.url || null,
      mode: execution.mode || trigger?.mode || null,
      retryOf: execution.retryOf || null,
    },
    failedNode: node,
    kind: trigger ? 'trigger' : 'execution',
    message: clip(message, 2000),
    stack: err.stack ? clip(redactSecrets(err.stack).split('\n').slice(0, 8).join('\n'), 2000) : null,
    fingerprint: fnv1a(`${workflow.id}|${node}|${message.replace(/\d+/g, '#').slice(0, 200)}`),
    hint,
  };
  return record;
}

/**
 * Decide whether to alert and update the throttle state in place.
 * @param {object} record      from buildErrorRecord
 * @param {object} state       persisted object (n8n workflow static data)
 * @param {number} windowMinutes suppress repeats of the same fingerprint within this window
 */
export function shouldAlert(record, state, now = new Date(), windowMinutes = 30) {
  state.lastAlerts ||= {};
  const nowMs = now.getTime();
  // Forget old fingerprints so static data does not grow forever.
  for (const [fp, ts] of Object.entries(state.lastAlerts)) {
    if (nowMs - ts > 24 * 3600 * 1000) delete state.lastAlerts[fp];
  }
  const last = state.lastAlerts[record.fingerprint];
  const suppressed = record.severity !== 'high' && last !== undefined && nowMs - last < windowMinutes * 60000;
  if (!suppressed) state.lastAlerts[record.fingerprint] = nowMs;
  return { alert: !suppressed, suppressedSinceMinutes: suppressed ? Math.round((nowMs - last) / 60000) : null };
}
