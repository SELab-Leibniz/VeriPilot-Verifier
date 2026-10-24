// Select before any held-out review. Selection never reads held-out results.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = path.resolve('.runtime-correction/review-module-lab-20261024-02/prompt-accuracy-20261024-01');
const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = { baseline: { run: 'baseline-dev-01', audits: ['A1', 'A2'] },
  'rubric-v1': { run: 'rubric-v1-dev-01', audits: ['B1', 'B2'] },
  'rubric-v2': { run: 'rubric-v2-dev-01', audits: ['C1', 'C2'] } };
const evaluated = {};
for (const [name, source] of Object.entries(sources)) {
  const run = await read(`${source.run}/report.json`);
  const judgments = (await Promise.all(source.audits.map(tag => read(`semantic-audits/${tag}.json`)))).flatMap(audit => audit.cases);
  evaluated[name] = run.rows.map(row => {
    const semantic = judgments.find(item => item.caseId === row.caseId);
    assert(semantic, `Missing independent semantic decision ${name}/${row.caseId}`);
    return { ...row, semantic };
  });
}
const decisions = { M01: { source: 'rubric-v1', evidence: 'Both 4/4 grounded; v1 reduced observed turns and cumulative token input. No demonstrated accuracy gain.' },
  M05: { source: 'baseline', evidence: 'Baseline 4/4 grounded. V1 has a false PASS; v2 adds an unsupported missing-condition claim and a submit repair. Retain simpler baseline.' },
  M12: { source: 'rubric-v2', scope: 'SOURCE_IMPLEMENTATION', evidence: 'Baseline/v1 3/4 grounded; v2 4/4 after rejecting a permanent surrogate as a conditional operation. Runtime proof was not tuned; retain baseline there.' } };
for (const [metric, choice] of Object.entries(decisions)) {
  const rows = evaluated[choice.source].filter(row => row.metricId === metric);
  assert.equal(rows.length, 4);
  assert(rows.every(row => row.result.completed && row.citationIntegrity && row.semantic.groundedCorrect), `Selected profile not supported: ${metric}`);
}
const baseline = await read('profiles/baseline.json'), v1 = await read('profiles/rubric-v1.json'), v2 = await read('profiles/rubric-v2.json');
const selected = { id: 'selected', selectedAt: new Date().toISOString(), selectionBasis: 'Independent development-set semantic and byte checks only; no held-out results',
  metricPrompts: { M01: v1.metricPrompts.M01, M05: baseline.metricPrompts.M05, M12: v2.metricPrompts.M12 },
  scopeOverrides: { M12: { RUNTIME_ACCEPTANCE: baseline.metricPrompts.M12 } },
  reviewTypes: { M01: { default: 'requirement-decomposition-reviewer' }, M05: { default: 'acceptance-coverage-reviewer' },
    M12: { SOURCE_IMPLEMENTATION: 'source-implementation-reviewer', RUNTIME_ACCEPTANCE: 'runtime-evidence-reviewer' } },
  decisions };
const bytes = JSON.stringify(selected, null, 2) + '\n';
await fs.writeFile(path.join(root, 'profiles/selected.json'), bytes, { flag: 'wx' });
const summary = Object.fromEntries(Object.entries(evaluated).map(([name, rows]) => [name,
  Object.fromEntries(['M01', 'M05', 'M12'].map(metric => [metric, rows.filter(row => row.metricId === metric)]).filter(([, group]) => group.length)
    .map(([metric, group]) => [metric, { cases: group.length, labelCorrect: group.filter(row => row.semantic.labelCorrect).length,
      groundedCorrect: group.filter(row => row.semantic.groundedCorrect).length, turns: group.reduce((sum, row) => sum + row.result.metrics.turns, 0),
      inputTokens: group.reduce((sum, row) => sum + row.result.metrics.inputTokens, 0), outputTokens: group.reduce((sum, row) => sum + row.result.metrics.outputTokens, 0),
      submitErrors: group.reduce((sum, row) => sum + row.measured.submitErrors, 0) }]))]));
await fs.writeFile(path.join(root, 'development-selection.json'), JSON.stringify({ selectedSha256: hash(bytes), decisions, summary,
  limitation: 'Single runs on small selected controls, not a causal efficiency estimate or production stability rate. Different routes may retain the original prompt.' }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ selectedSha256: hash(bytes), decisions, summary }));
