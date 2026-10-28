// Offline counter extraction for explicit live experiments, never a model run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectNativeReviewArtifacts } from './helpers/native-evaluation-metrics.mjs';

if (!process.argv[2]) throw new Error('Supply an evaluation output directory or its results.json.');
const argument = path.resolve(process.argv[2]), root = path.extname(argument) === '.json' ? path.dirname(argument) : argument;
const source = JSON.parse(await fs.readFile(path.join(root, 'results.json'), 'utf8'));
const records = [];
for (const record of source.records) {
  if (record.transportKind !== 'native') continue;
  const metrics = await inspectNativeReviewArtifacts(record.evaluationArtifacts?.length ? record.evaluationArtifacts : record.artifacts ? [record.artifacts] : []);
  records.push({ case: record.case, engine: record.engine, expected: record.expected,
    matchesExpected: record.matchesExpected, productionStatus: record.productionStatus, ...metrics });
}
await fs.writeFile(path.join(root, 'observed-metrics.json'), JSON.stringify({ source: path.join(root, 'results.json'), records }, null, 2));
for (const record of records) console.log(JSON.stringify({ case: record.case, engine: record.engine, productionStatus: record.productionStatus,
  matchesExpected: record.matchesExpected, actualModels: record.actualModels, transcriptCount: record.transcriptCount,
  toolCalls: record.toolCalls, toolErrors: record.toolErrors, sourceReads: record.sourceReads, usageTotals: record.usageTotals,
  assessments: record.assessments.map(({ elapsedMs, objectCount, status }) => ({ elapsedMs, objectCount, status })) }));
