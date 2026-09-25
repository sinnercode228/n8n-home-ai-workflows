#!/usr/bin/env node
// Inline the unit-tested modules from src/ into the Code nodes of
// workflows/*.json. Run after editing anything in src/:  npm run build
// Only `parameters.jsCode` of the mapped Code nodes is touched.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_NODES, ROOT, generateCode } from './lib/code-nodes.mjs';

const check = process.argv.includes('--check');
const byWorkflow = new Map();
for (const spec of CODE_NODES) {
  if (!byWorkflow.has(spec.workflow)) byWorkflow.set(spec.workflow, []);
  byWorkflow.get(spec.workflow).push(spec);
}

let changed = 0;
for (const [file, specs] of byWorkflow) {
  const path = join(ROOT, 'workflows', file);
  const original = readFileSync(path, 'utf8');
  const wf = JSON.parse(original);
  for (const spec of specs) {
    const node = wf.nodes.find((n) => n.name === spec.node);
    if (!node) throw new Error(`${file}: no node named "${spec.node}"`);
    if (node.type !== 'n8n-nodes-base.code') throw new Error(`${file}: "${spec.node}" is not a Code node`);
    node.parameters.jsCode = generateCode(spec);
  }
  const next = JSON.stringify(wf, null, 2) + '\n';
  if (next !== original) {
    changed++;
    if (check) console.error(`out of date: workflows/${file}`);
    else writeFileSync(path, next);
  }
}

if (check && changed) {
  console.error('Run `npm run build` to regenerate Code nodes from src/.');
  process.exit(1);
}
console.log(check ? 'Code nodes are in sync with src/.' : `Updated ${changed} workflow file(s).`);
