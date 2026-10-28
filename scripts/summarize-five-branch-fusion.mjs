// Rebuild the public, credential-free evidence summary without model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve('.runtime-correction/five-branch-fusion');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const local = file => path.join(root, file);
const read = file => json(local(file));
const sum = (rows, pick) => rows.reduce((value, row) => value + pick(row), 0);
const input = usage => (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
const stop = await read('stop-live/results.json');
const stopSummary = Object.fromEntries(['before', 'fused'].map(arm => {
  const rows = stop.rows.filter(row => row.arm === arm).map(row => row.report);
  return [arm, { samples: rows.length, correct: rows.filter(row => row.match).length, objects: sum(rows, row => row.rows.length),
    elapsedMs: sum(rows, row => row.elapsedMs), hostTokensIncludingCache: sum(rows, row => row.hostTokenCounters.totalTokens),
    toolCalls: sum(rows, row => row.toolCalls), reads: sum(rows, row => row.sourceReads),
    reviewStarts: sum(rows, row => row.reviewStarts), reviewEnds: sum(rows, row => row.reviewEnds) }];
}));
const doc = await read('document-live/report.json');
const documents = Object.fromEntries(['cold', 'reused'].map(mode => {
  const rows = doc.rows.filter(row => row.mode === mode);
  return [mode, { samples: rows.length, correct: rows.filter(row => row.correct).length,
    nativeIdentities: new Set(rows.map(row => row.sessionId)).size, cliSessions: new Set(rows.map(row => row.model.sessionId)).size,
    inputIncludingCache: sum(rows, row => input(row.model.usage)), output: sum(rows, row => row.model.usage.output_tokens),
    modelDurationMs: sum(rows, row => row.model.durationMs) }];
}));
const skillInitial = await json('.runtime-correction/skill-care-live-experiment.json');
const skills = await read('skill-protocol-live/results.json');
const baseline = [];
for (const [arm, prefix] of [['legacy-protocol', 'baseline-legacy'], ['specialty-branch', 'baseline-original'], ['initial-fusion', 'baseline-live'], ['final-fusion', 'baseline-final']]) {
  for (const suffix of ['inline', 'appointments']) {
    const lines = (await fs.readFile(local(`${prefix}-${suffix}.log`), 'utf8')).split(/\r?\n/u);
    const summary = lines.filter(line => line.startsWith('{')).map(JSON.parse).find(item => item.directory);
    if (!summary) throw new Error(`Missing baseline evidence: ${prefix}-${suffix}`);
    const observations = await json(path.join(summary.directory, 'observations.json'));
    for (const row of observations) baseline.push({ arm, case: row.case, success: row.success, quality: row.quality,
      modelCalls: row.attempts.length, errors: row.attempts.flatMap(attempt => attempt.validationError ? [attempt.validationError] : []),
      usage: row.usage, wallMs: row.wallMs, inputSha256: row.attempts.map(attempt => attempt.inputSha256),
      operations: row.operations, publication: row.publication });
  }
}
const finalSuiteText = await fs.readFile(local('full-final.log'), 'utf8');
const fullSuite = finalSuiteText.trim().split(/\r?\n/u).filter(line => line.startsWith('{')).map(JSON.parse).findLast(value => value.totals);
if (!fullSuite) throw new Error('Final suite is incomplete');
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  branch: 'codex/fuse-care-observability-baseline', implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  commonCommit: 'b1297e0ac882d7f412412961d4a2ad08259f7c28',
  stop: { summary: stopSummary, sources: Object.fromEntries(Object.entries(stop.sources).map(([key, value]) => [key, { commit: value.commit, runtimeDigest: value.runtimeDigest }])),
    cases: stop.rows.map(({ arm, report: row }) => ({ arm, case: row.case, expected: row.expected, status: row.status, match: row.match,
      expectedCount: row.expectedCount, judgements: row.rows.map(r => ({ objectId: r.objectId, judgement: r.judgement })),
      elapsedMs: row.elapsedMs, hostTokenCounters: row.hostTokenCounters, toolCalls: row.toolCalls, toolErrors: row.toolErrors, sourceReads: row.sourceReads })),
    finalSourceSmoke: (await read('stop-final-smoke/results.json')).rows.map(({ arm, report: row }) => ({ arm, case: row.case, match: row.match, status: row.status, elapsedMs: row.elapsedMs })),
    caveats: 'One sample per case per arm with alternating order. Earlier source hash identifies the full matrix; final source was additionally checked on missing execution evidence. Model sampling/cache/order differ; no statistically established or causal latency/token improvement.' },
  documents,
  skillInitialDisclosure: { completed: skillInitial.completed, correct: skillInitial.correct, cases: skillInitial.results.map(row => ({ case: row.case, arm: row.arm, expected: row.expected, actual: row.structured.judgement, reason: row.structured.reason, usage: row.usage, ms: row.ms })),
    caveats: 'Original lightweight disclosure replay; one optimized in-progress verdict was wrong. Do not discard this failure or label it a production-protocol accuracy comparison.' },
  skillProtocolReplay: skills,
  skillMechanism: await read('skill-mechanism.json'),
  baselineMechanism: await json('.runtime-correction/baseline-experiment/results.json'), baseline,
  console: { before: await read('console-joins-before.json'), after: await read('console-joins-after.json'),
    browser: await json('.runtime-correction/console-experiment/results.json') },
  specialtyBefore: await read('before/results.json'), specialtyAfter: await read('after-dependencies/results.json'),
  fullSuite,
  limitations: ['All business fixtures generated; no repository copies or installed MA changes.',
    'Byte/I/O reductions are not billed token reductions. Model counters include caches and are not invoices.',
    'Document study combines identity reuse and batched open; no isolated causal estimate for either factor.',
    'New baseline samples preserve source clauses, restrictions, granularity and routing fields, but field presence does not prove perfect semantic classification.',
    'The specialty baseline branch was faster/cheaper than fusion in these samples; fusion is a combined feature set, not universally faster.',
    'Refined Skill protocol retains a clearer trigger rule but was longer/slower; both old and new protocols matched all six replay cases.',
    'Browser used actual RC UI/RPC/projection with isolated transport; installed-host contract checked read-only; no desktop Electron publication or natural-business end-to-end claim.'],
};
// Only publish selected structured evidence. Strip machine-specific source paths
// from summaries; complete local logs remain in the ignored evidence directory.
for (const key of ['skillMechanism', 'baselineMechanism']) delete report[key].baseCommit;
for (const phase of ['specialtyBefore', 'specialtyAfter']) for (const row of report[phase].results) delete row.source;
for (const phase of ['before', 'after']) delete report.console[phase].source;
await fs.writeFile('docs/five-branch-fusion-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stop: stopSummary, documents, baseline: baseline.map(row => ({ arm: row.arm, case: row.case, success: row.success, modelCalls: row.modelCalls, wallMs: row.wallMs })), fullSuite }));
