// Consolidate explicit local replay runs; retain failed/interrupted trials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { baselineModelCases, baselineHeldoutCases } from './baseline-model-cases.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const runId = option('run'), heldoutId = option('heldout');
for (const id of [runId, heldoutId].filter(Boolean))
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/u.test(id)) throw new Error('Use an exact replay directory ID');
if (!runId) throw new Error('--run=<directory ID> is required');
const base = path.resolve('.runtime-correction/baseline-paired');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const maybe = async file => { try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const totals = rows => Object.fromEntries(['before', 'after'].map(mode => {
  const group = rows.filter(row => row.mode === mode);
  return [mode, { runs: group.length, passed: group.filter(row => row.success).length,
    usageUnknownRuns: group.filter(row => !row.usage).length,
    usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map(key => [key, group.reduce((sum, row) => sum + (row.usage?.[key] ?? 0), 0)])),
    wallMs: group.reduce((sum, row) => sum + row.wallMs, 0) }];
}));
async function selected(id) {
  const summary = await read(path.join(base, id, 'summary.json'));
  delete summary.directory;
  const rows = await read(path.join(base, id, 'observations.json'));
  const paired = rows.filter(row => row.mode === 'before').map(before => {
    const after = rows.find(row => row.mode === 'after' && row.case === before.case && row.repetition === before.repetition);
    if (!after) throw new Error(`Missing pair: ${id}/${before.case}/${before.repetition}`);
    return { case: before.case, repetition: before.repetition, bothPassed: before.success && after.success,
      beforeTokens: before.usage.total, afterTokens: after.usage.total, beforeMs: before.wallMs, afterMs: after.wallMs,
      tokenReduction: 1 - after.usage.total / before.usage.total, timeReduction: 1 - after.wallMs / before.wallMs };
  });
  const accepted = rows.filter(row => row.mode === 'after');
  return { id, summary, candidateAccepted: accepted.length > 0 && accepted.every(row => row.success), totals: totals(rows), paired, observations: rows.map(row => ({ ...row,
    attempts: row.attempts.map(attempt => ({ usage: attempt.usage, modelMs: attempt.modelMs, models: attempt.models,
      turns: attempt.turns, inputSha256: attempt.inputSha256, validationError: attempt.validationError })),
  })) };
}
const previousTrials = [];
for (const entry of (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  if ([runId, heldoutId].includes(entry.name)) continue;
  const rows = await maybe(path.join(base, entry.name, 'observations.json')) ?? [];
  previousTrials.push({ id: entry.name, complete: Boolean(await maybe(path.join(base, entry.name, 'summary.json'))),
    observations: rows.length, totals: totals(rows),
    failures: rows.filter(row => !row.success).map(row => ({ case: row.case, mode: row.mode, repetition: row.repetition, quality: row.quality, error: row.error })),
  });
}
const files = ['lib/review-task/baseline-selection.mjs', 'lib/review-task/baseline-task.mjs',
  'lib/review-task/skills/baseline-extraction/SKILL.md', 'lib/runtime-v2/baseline-task.mjs',
  'scripts/baseline-paired-experiment.mjs', 'scripts/baseline-model-cases.mjs'];
const sourceDigests = Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await fs.readFile(file))])));
const result = { schemaVersion: 2, baselineRef: 'f6def80', model: 'glm-5.3-flash', effort: 'low', reportSourceDigests: sourceDigests,
  method: 'Alternating synthetic replay through production frozen-source worker, candidate validation and ledger publication; simulated persisted-read receipts. No live MA model/UI loop.',
  usageBasis: 'Sum reported cumulative modelUsage input/output/cacheRead/cacheCreation of every recorded call/repair; costBasis unknown. Unavailable usage and interrupted in-flight calls are not estimated. Not final-turn usage or a billing amount.',
  acceptance: 'Predeclared clause coverage/cohesion/independence/count ranges plus explicit proof target/implementation role; semantic review by implementing agent, not independent human annotation. Historical trial counts use their then-current checks.',
  cases: baselineModelCases, heldoutCases: baselineHeldoutCases, previousTrials,
  finalRun: await selected(runId), ...(heldoutId ? { heldoutRun: await selected(heldoutId) } : {}),
  ...(option('tests') ? { regression: await read(option('tests')) } : {}),
  semanticReviewCompleted: process.argv.includes('--reviewed'),
};
await fs.writeFile('test/fixtures/baseline-paired-observations.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ final: result.finalRun.summary, heldout: result.heldoutRun?.summary,
  previousTrials: previousTrials.length, regression: result.regression }));
