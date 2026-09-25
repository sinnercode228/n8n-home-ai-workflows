// Run the *actual* jsCode string stored in a workflow's Code node inside a
// Node vm sandbox that mimics the n8n Code node globals we use:
// $input, $('Node'), $runIndex, $workflow, $execution, $getWorkflowStaticData.
// This proves the generated code (not just the src/ modules) works.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../scripts/lib/code-nodes.mjs';

export const sample = (name) => JSON.parse(readFileSync(join(ROOT, 'samples', name), 'utf8'));
export const loadWorkflow = (file) => JSON.parse(readFileSync(join(ROOT, 'workflows', file), 'utf8'));

export function configOf(file) {
  const node = loadWorkflow(file).nodes.find((n) => n.name === 'Config');
  return JSON.parse(node.parameters.jsonOutput);
}

const accessor = (list, label) => ({
  all: () => list,
  first: () => {
    if (!list.length) throw new Error(`${label} has no items`);
    return list[0];
  },
  last: () => list[list.length - 1],
  item: list[0],
});

/**
 * @param {string} file      workflow file name
 * @param {string} nodeName  Code node name
 * @param {object} ctx       { input: items[], nodes: { 'Node name': items[] }, runIndex, staticData }
 * @returns items returned by the Code node (JSON round-tripped out of the sandbox realm)
 */
export async function runCodeNode(file, nodeName, ctx = {}) {
  const node = loadWorkflow(file).nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`${file} has no node "${nodeName}"`);
  const input = ctx.input ?? [];
  const sandbox = {
    $input: accessor(input, '$input'),
    $: (name) => {
      if (!ctx.nodes || !(name in ctx.nodes)) throw new Error(`test harness: no data provided for $('${name}')`);
      return accessor(ctx.nodes[name], `$('${name}')`);
    },
    $runIndex: ctx.runIndex ?? 0,
    $workflow: { id: 'TestWorkflow0001', name: 'Test workflow', active: false },
    $execution: { id: '42', mode: 'test' },
    $getWorkflowStaticData: () => ctx.staticData ?? {},
    console,
  };
  const fn = vm.runInNewContext(`(async function () {\n${node.parameters.jsCode}\n})`, sandbox, { filename: `${file}:${nodeName}` });
  const out = await fn();
  if (!Array.isArray(out)) throw new Error(`"${nodeName}" must return an array of items`);
  for (const item of out) if (!item || typeof item.json !== 'object') throw new Error(`"${nodeName}" returned an item without .json`);
  return JSON.parse(JSON.stringify(out));
}

export const items = (...jsons) => jsons.map((json) => ({ json }));
