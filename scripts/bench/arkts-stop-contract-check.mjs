#!/usr/bin/env node
// Compose the existing full public suite and a separately calibrated public
// contract case. Each runs in a different native process and project snapshot.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runRegressionCheck } from './arkts-regression-check.mjs';
const { values } = parseArgs({ options: Object.fromEntries(['project', 'tool-root', 'java-home', 'baseline',
  'contract-probe', 'contract-baseline', 'timeout-ms'].map(name => [name, { type: 'string' }])) });
for (const key of ['project', 'tool-root', 'baseline', 'contract-probe', 'contract-baseline'])
  if (!values[key]) throw new Error(`--${key} required`);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const [original, contract] = await Promise.all([read(values.baseline), read(values['contract-baseline'])]);
if (original.baseCommit !== contract.baseCommit || !original.completeRuntime || !contract.completeRuntime)
  throw new Error('Original and contract baselines must be completed on the same prepared commit.');
const common = { project: values.project, toolRoot: values['tool-root'], javaHome: values['java-home'],
  timeoutMs: Number(values['timeout-ms'] ?? 420000) };
const suite = await runRegressionCheck({ ...common, baseline: values.baseline, originalTests: true });
console.log([suite.line, ...suite.names, ...(suite.diagnostics ?? []), ...suite.errors].join('\n'));
const probe = await runRegressionCheck({ ...common, baseline: values['contract-baseline'], contractProbe: values['contract-probe'] });
console.log([probe.line.replace('RC_REGRESSION_CHECK', 'RC_CONTRACT_CHECK'), ...probe.names, ...(probe.diagnostics ?? []), ...probe.errors,
  `Public contract source: ${probe.contractProbe.source}; original baseline evidence: ${contract.sourceEvidence}`].join('\n'));
process.exitCode = Math.max(suite.exitCode, probe.exitCode);
