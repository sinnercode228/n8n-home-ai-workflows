// The validator must pass the real workflows and catch broken ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkflow } from '../scripts/validate.mjs';
import { ROOT } from '../scripts/lib/code-nodes.mjs';

const dir = join(ROOT, 'workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const raws = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const all = files.map((f) => JSON.parse(raws[f]));

function check(file, mutate) {
  const wf = JSON.parse(raws[file]);
  mutate(wf);
  return validateWorkflow(file, JSON.stringify(wf, null, 2), all).errors;
}

test('all shipped workflows pass', () => {
  for (const f of files) assert.deepEqual(validateWorkflow(f, raws[f], all).errors, [], f);
});

test('catches a connection to a missing node', () => {
  const errs = check('meeting-notes-to-notion.json', (wf) => {
    wf.connections.Config.main[0].push({ node: 'Ghost', type: 'main', index: 0 });
  });
  assert.ok(errs.some((e) => /unknown node "Ghost"/.test(e)));
});

test('catches a hard-coded API key header', () => {
  const errs = check('meeting-notes-to-notion.json', (wf) => {
    const http = wf.nodes.find((n) => n.name === 'Claude: Extract Notes');
    http.parameters.headerParameters.parameters.push({ name: 'x-api-key', value: `sk-ant-api03-${'x'.repeat(40)}` });
  });
  assert.ok(errs.some((e) => /literal value/.test(e)));
  assert.ok(errs.some((e) => /hard-coded secret \(Anthropic API key\)/.test(e)));
});

test('catches inline credential data and unauthenticated webhooks', () => {
  const errs = check('private-doc-qa-local-llm.json', (wf) => {
    const hook = wf.nodes.find((n) => n.name === 'Question Webhook');
    hook.parameters.authentication = 'none';
    hook.credentials.httpHeaderAuth.value = 'hunter2';
  });
  assert.ok(errs.some((e) => /webhook has no authentication/.test(e)));
  assert.ok(errs.some((e) => /inline fields/.test(e)));
});

test('catches a cloud call in a local-only workflow', () => {
  const errs = check('private-doc-qa-local-llm.json', (wf) => {
    const cfgNode = wf.nodes.find((n) => n.name === 'Config');
    const cfg = JSON.parse(cfgNode.parameters.jsonOutput);
    cfg.ollamaBaseUrl = 'https://api.some-cloud.example';
    cfgNode.parameters.jsonOutput = JSON.stringify(cfg);
  });
  assert.ok(errs.some((e) => /local-only: .*non-local host api\.some-cloud\.example/.test(e)));
});

test('catches Code node drift from src/, orphans, missing settings and bad $() references', () => {
  const errs = check('family-calendar-digest.json', (wf) => {
    wf.nodes.find((n) => n.name === 'Compose Digest').parameters.jsCode += '\n// edited in the UI';
    wf.nodes.find((n) => n.name === 'Build Digest Request').parameters.jsCode = 'return [ {';
    wf.nodes.push({ id: 'orphan-1', name: 'Orphan', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} });
    wf.nodes.find((n) => n.name === 'Gmail: Create Draft').parameters.message = "={{ $('Nope').first().json.x }}";
    delete wf.settings.errorWorkflow;
    wf.settings.executionOrder = 'v0';
  });
  for (const re of [/differs from src/, /does not compile/, /"Orphan" is not reachable/, /missing node \$\('Nope'\)/, /errorWorkflow is not set/, /executionOrder/]) {
    assert.ok(errs.some((e) => re.test(e)), `expected ${re}`);
  }
});

test('catches using an error output that is not enabled', () => {
  const errs = check('meeting-notes-to-notion.json', (wf) => {
    delete wf.nodes.find((n) => n.name === 'Claude: Extract Notes').onError;
  });
  assert.ok(errs.some((e) => /only has 1 output/.test(e)));
});
