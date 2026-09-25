#!/usr/bin/env node
// Static checks for every workflows/*.json - run in CI and before importing.
//
//   node scripts/validate.mjs            # all workflows
//   node scripts/validate.mjs --json     # machine-readable report
//
// Checks: JSON parses; required top-level fields and settings; unique node
// ids/names; every connection points at an existing node and a valid output;
// no orphan nodes; $('Node') references resolve; webhooks are authenticated;
// HTTP nodes have timeouts; credentials are referenced by name only; no
// hard-coded secrets; Code nodes compile and match src/ (no drift);
// "local-only" workflows never call a non-local host.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { CODE_NODES, ROOT, generateCode } from './lib/code-nodes.mjs';

const WORKFLOW_DIR = join(ROOT, 'workflows');
const asJson = process.argv.includes('--json');

const isTriggerType = (type) => /Trigger$/.test(type) || type === 'n8n-nodes-base.webhook';
const STICKY = 'n8n-nodes-base.stickyNote';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'ollama', 'qdrant', 'n8n', 'host.docker.internal']);
const CLOUD_NODE_TYPES = /(anthropic|openAi|lmChatOpenAi|googleGemini|googlePalm|mistral|groq|cohere|huggingFace|pinecone|supabase|notion|gmail|googleCalendar|slack|telegram)/i;

const SECRET_PATTERNS = [
  ['Anthropic API key', /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['Notion token', /\b(?:secret|ntn)_[A-Za-z0-9]{30,}/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['Google OAuth token', /\bya29\.[A-Za-z0-9._-]{30,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
  ['Bearer token literal', /Bearer\s+[A-Za-z0-9._~+/-]{24,}/],
];
const SENSITIVE_PARAM = /^(authorization|x-api-key|api[-_]?key|apikey|token|access[-_]?token|password|secret)$/i;

function walkStrings(value, fn, path = []) {
  if (typeof value === 'string') fn(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, fn, [...path, i]));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, fn, [...path, k]);
}

function readConfig(wf) {
  const cfg = wf.nodes.find((n) => n.name === 'Config' && n.type === 'n8n-nodes-base.set');
  if (!cfg) return null;
  return JSON.parse(cfg.parameters.jsonOutput);
}

/** Substitute {{ $('Config').first().json.x }} with the Config value; null if anything dynamic remains. */
function resolveUrl(url, config) {
  if (typeof url !== 'string') return null;
  let text = url.startsWith('=') ? url.slice(1) : url;
  text = text.replace(/\{\{\s*\$\('Config'\)\.first\(\)\.json\.(\w+)\s*\}\}/g, (_, k) => (config && k in config ? String(config[k]) : '{{?}}'));
  return /\{\{/.test(text) ? null : text;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function validateWorkflow(file, raw, allWorkflows) {
  const errors = [];
  const warnings = [];
  const info = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  let wf;
  try {
    wf = JSON.parse(raw);
  } catch (e) {
    return { file, errors: [`Invalid JSON: ${e.message}`], warnings, info };
  }

  // ---- top level ----------------------------------------------------------
  if (typeof wf.name !== 'string' || !wf.name.trim()) err('missing workflow "name"');
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) return { file, errors: [...errors, '"nodes" must be a non-empty array'], warnings, info };
  if (!wf.connections || typeof wf.connections !== 'object') err('"connections" must be an object');
  if (!wf.settings || typeof wf.settings !== 'object') err('"settings" must be an object');
  if (wf.id !== undefined && !/^[A-Za-z0-9]{16}$/.test(wf.id)) err(`workflow id "${wf.id}" should be 16 alphanumeric characters`);
  if (wf.active === true) err('workflow is exported as active - ship inactive so nothing runs before credentials are set');
  const settings = wf.settings || {};
  if (settings.executionOrder !== 'v1') err('settings.executionOrder must be "v1"');
  if (!settings.timezone) warn('settings.timezone not set (schedules would use the instance default)');

  const nodes = wf.nodes;
  const byName = new Map();
  const ids = new Set();
  for (const n of nodes) {
    if (!n.name) err('a node has no name');
    else if (byName.has(n.name)) err(`duplicate node name "${n.name}"`);
    else byName.set(n.name, n);
    if (!n.id) err(`"${n.name}": missing id`);
    else if (ids.has(n.id)) err(`"${n.name}": duplicate node id ${n.id}`);
    else ids.add(n.id);
    if (typeof n.type !== 'string' || !/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\.[A-Za-z0-9]+$/.test(n.type)) err(`"${n.name}": unexpected node type "${n.type}"`);
    if (typeof n.typeVersion !== 'number' || n.typeVersion <= 0) err(`"${n.name}": typeVersion must be a positive number`);
    if (!Array.isArray(n.position) || n.position.length !== 2 || !n.position.every(Number.isFinite)) err(`"${n.name}": position must be [x, y]`);
    if (!n.parameters || typeof n.parameters !== 'object') err(`"${n.name}": parameters must be an object`);
  }

  const isTrigger = (n) => n.type !== STICKY && isTriggerType(n.type);
  const triggers = nodes.filter(isTrigger);
  if (triggers.length === 0) err('no trigger node');
  const hasErrorTrigger = nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');

  // ---- error workflow wiring -------------------------------------------------
  if (!hasErrorTrigger) {
    const target = settings.errorWorkflow;
    if (!target) err('settings.errorWorkflow is not set - failures would go unnoticed');
    else if (!allWorkflows.some((w) => w.id === target && w.nodes?.some((n) => n.type === 'n8n-nodes-base.errorTrigger'))) {
      err(`settings.errorWorkflow "${target}" is not a workflow in this repo with an Error Trigger`);
    }
  } else if (settings.errorWorkflow) {
    err('the error-handler workflow must not name an error workflow itself (loops)');
  }

  // ---- connections -------------------------------------------------------------
  const outgoing = new Map();
  for (const [from, types] of Object.entries(wf.connections || {})) {
    const src = byName.get(from);
    if (!src) {
      err(`connection from unknown node "${from}"`);
      continue;
    }
    if (src.type === STICKY) err(`sticky note "${from}" has connections`);
    for (const [type, outputs] of Object.entries(types)) {
      if (type !== 'main' && !type.startsWith('ai_')) err(`"${from}": unknown connection type "${type}"`);
      if (!Array.isArray(outputs)) {
        err(`"${from}".${type} must be an array of outputs`);
        continue;
      }
      if (type === 'main') {
        let maxOutputs = 1;
        if (src.type === 'n8n-nodes-base.if') maxOutputs = 2;
        else if (src.type === 'n8n-nodes-base.switch') maxOutputs = (src.parameters.rules?.values?.length || 0) + (src.parameters.options?.fallbackOutput === 'extra' ? 1 : 0);
        else if (src.onError === 'continueErrorOutput') maxOutputs = 2;
        if (outputs.length > maxOutputs) err(`"${from}" uses output #${outputs.length - 1} but only has ${maxOutputs} output(s)${maxOutputs === 1 ? ' (set onError: continueErrorOutput to get an error output)' : ''}`);
        if (src.onError === 'continueErrorOutput' && !(outputs[1] || []).length) warn(`"${from}" has an error output that is not connected`);
      }
      outputs.forEach((targets, outIdx) => {
        for (const t of targets || []) {
          const dst = byName.get(t.node);
          if (!dst) err(`"${from}" output ${outIdx} -> unknown node "${t.node}"`);
          else if (isTrigger(dst)) err(`"${from}" connects into trigger "${t.node}"`);
          if (t.type !== type) err(`"${from}" -> "${t.node}": connection type "${t.type}" does not match "${type}"`);
          if (!Number.isInteger(t.index) || t.index < 0) err(`"${from}" -> "${t.node}": invalid input index`);
          if (dst) {
            if (!outgoing.has(from)) outgoing.set(from, new Set());
            outgoing.get(from).add(t.node);
          }
        }
      });
    }
  }

  // ---- reachability ---------------------------------------------------------------
  const reached = new Set(triggers.map((t) => t.name));
  const queue = [...reached];
  while (queue.length) {
    for (const next of outgoing.get(queue.shift()) || []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  for (const n of nodes) if (n.type !== STICKY && !reached.has(n.name)) err(`"${n.name}" is not reachable from any trigger`);

  // ---- $('Node') references ------------------------------------------------------
  for (const n of nodes) {
    walkStrings(n.parameters, (s) => {
      for (const m of s.matchAll(/\$\(\s*(['"])(.+?)\1\s*\)/g)) {
        if (!byName.has(m[2])) err(`"${n.name}" references missing node $('${m[2]}')`);
      }
    });
  }

  // ---- credentials + secrets ------------------------------------------------------
  for (const n of nodes) {
    for (const [type, ref] of Object.entries(n.credentials || {})) {
      if (!ref || typeof ref !== 'object' || typeof ref.name !== 'string' || !ref.name.trim()) err(`"${n.name}": credential "${type}" must be { "name": "..." }`);
      if (ref && ref.id) warn(`"${n.name}": credential "${type}" carries an id - exported ids are instance-specific; keep name only`);
      if (ref && Object.keys(ref).some((k) => !['id', 'name'].includes(k))) err(`"${n.name}": credential "${type}" contains inline fields - secrets belong in n8n credentials`);
    }
    const params = [
      ...(n.parameters.headerParameters?.parameters || []),
      ...(n.parameters.queryParameters?.parameters || []),
      ...(n.parameters.bodyParameters?.parameters || []),
    ];
    for (const p of params) {
      if (SENSITIVE_PARAM.test(p.name || '') && p.value && !String(p.value).startsWith('=')) {
        err(`"${n.name}": parameter "${p.name}" has a literal value - use a credential instead`);
      }
    }
  }
  for (const [label, re] of SECRET_PATTERNS) {
    const m = raw.match(re);
    if (m) err(`possible hard-coded secret (${label}): "${m[0].slice(0, 12)}..."`);
  }
  const placeholders = raw.match(/REPLACE_WITH_[A-Z0-9_]+/g) || [];
  if (placeholders.length) info.push(`${new Set(placeholders).size} placeholder(s) to fill after import`);

  // ---- node-specific rules --------------------------------------------------------
  const config = (() => {
    try {
      return readConfig(wf);
    } catch (e) {
      err(`Config node jsonOutput is not valid JSON: ${e.message}`);
      return null;
    }
  })();
  for (const n of nodes) {
    const p = n.parameters || {};
    if (n.type === 'n8n-nodes-base.webhook') {
      if (!p.authentication || p.authentication === 'none') err(`"${n.name}": webhook has no authentication`);
      if (!n.webhookId) err(`"${n.name}": webhook needs a webhookId`);
      if (!p.path) err(`"${n.name}": webhook needs a path`);
    }
    if (n.type === 'n8n-nodes-base.wait' && !n.webhookId) err(`"${n.name}": Wait node needs a webhookId`);
    if (n.type === 'n8n-nodes-base.webhook' && p.responseMode === 'responseNode' && !nodes.some((x) => x.type === 'n8n-nodes-base.respondToWebhook')) {
      err(`"${n.name}": responseMode=responseNode but there is no Respond to Webhook node`);
    }
    if (n.type === 'n8n-nodes-base.httpRequest') {
      if (!p.options?.timeout) err(`"${n.name}": HTTP Request without options.timeout`);
      const url = resolveUrl(p.url, config) || p.url || '';
      if (/api\.anthropic\.com/.test(url)) {
        const headers = (p.headerParameters?.parameters || []).map((h) => h.name.toLowerCase());
        if (!headers.includes('anthropic-version')) err(`"${n.name}": Anthropic call without anthropic-version header`);
        if (!n.credentials?.httpHeaderAuth) err(`"${n.name}": Anthropic call must authenticate via an httpHeaderAuth credential`);
      }
      if (/^http:\/\//.test(url) && hostOf(url) && !LOCAL_HOSTS.has(hostOf(url)) && !/\.(local|lan|internal|home\.arpa)$/.test(hostOf(url))) {
        err(`"${n.name}": plain http:// to a non-local host (${hostOf(url)})`);
      }
    }
    if (n.type === 'n8n-nodes-base.code') {
      const code = p.jsCode || '';
      try {
        new vm.Script(`(async function () {\n${code}\n})`, { filename: `${file}:${n.name}` });
      } catch (e) {
        err(`"${n.name}": Code node does not compile: ${e.message}`);
      }
      const spec = CODE_NODES.find((s) => s.workflow === file && s.node === n.name);
      if (!spec) warn(`"${n.name}": Code node is not generated from src/ (untested code)`);
      else if (code !== generateCode(spec)) err(`"${n.name}": Code node differs from src/ - run \`npm run build\` (or port UI edits back to src/)`);
    }
  }
  for (const spec of CODE_NODES.filter((s) => s.workflow === file)) {
    if (!byName.has(spec.node)) err(`scripts/lib/code-nodes.mjs maps "${spec.node}" but the workflow has no such node`);
  }

  // ---- local-only privacy rule --------------------------------------------------------
  const localOnly = (wf.tags || []).some((t) => (typeof t === 'string' ? t : t?.name) === 'local-only');
  if (localOnly) {
    for (const n of nodes) {
      if (CLOUD_NODE_TYPES.test(n.type)) err(`local-only: "${n.name}" (${n.type}) is a cloud service node`);
      if (n.type === 'n8n-nodes-base.httpRequest') {
        const url = resolveUrl(n.parameters.url, config);
        if (!url) err(`local-only: "${n.name}" URL cannot be resolved statically (${n.parameters.url})`);
        else if (!LOCAL_HOSTS.has(hostOf(url))) err(`local-only: "${n.name}" calls non-local host ${hostOf(url)}`);
      }
    }
    for (const [k, v] of Object.entries(config || {})) {
      if (typeof v === 'string' && /^https?:\/\//.test(v) && !LOCAL_HOSTS.has(hostOf(v))) err(`local-only: Config.${k} points at non-local host ${hostOf(v)}`);
    }
    if (!errors.some((e) => e.startsWith('local-only'))) info.push('local-only: every HTTP call resolves to a local host');
  }

  info.push(`${nodes.filter((n) => n.type !== STICKY).length} nodes, ${triggers.length} trigger(s), ${nodes.filter((n) => n.type === 'n8n-nodes-base.code').length} Code node(s)`);
  return { file, name: wf.name, errors, warnings, info };
}

// ---------------------------------------------------------------------------------------
function main() {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json')).sort();
  const raws = Object.fromEntries(files.map((f) => [f, readFileSync(join(WORKFLOW_DIR, f), 'utf8')]));
  const parsed = files.map((f) => {
    try {
      return JSON.parse(raws[f]);
    } catch {
      return {};
    }
  });
  const ids = parsed.map((w) => w.id).filter(Boolean);
  const results = files.map((f) => validateWorkflow(f, raws[f], parsed));
  if (new Set(ids).size !== ids.length) results.push({ file: '(repo)', errors: ['two workflows share the same id'], warnings: [], info: [] });

  const errorCount = results.reduce((a, r) => a + r.errors.length, 0);
  if (asJson) {
    console.log(JSON.stringify({ ok: errorCount === 0, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.errors.length ? 'FAIL' : 'PASS'}  workflows/${r.file}${r.name ? `  (${r.name})` : ''}`);
      for (const m of r.info) console.log(`      - ${m}`);
      for (const m of r.warnings) console.log(`  WARN  ${m}`);
      for (const m of r.errors) console.log(`  ERR   ${m}`);
    }
    console.log(`\n${files.length} workflow(s), ${errorCount} error(s), ${results.reduce((a, r) => a + r.warnings.length, 0)} warning(s)`);
  }
  process.exit(errorCount ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
