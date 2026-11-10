#!/usr/bin/env node
// Compose the existing full public suite and a separately calibrated public
// contract case. Each runs in a different native process and project snapshot.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runRegressionCheck } from './arkts-regression-check.mjs';
import { readRegressionContractProbe } from './regression-workspace.mjs';
const { values } = parseArgs({ options: Object.fromEntries(['project', 'tool-root', 'java-home', 'baseline',
  'contract-probe', 'contract-baseline', 'requirement-probe', 'timeout-ms'].map(name => [name, { type: 'string' }])) });
for (const key of ['project', 'tool-root', 'baseline'])
  if (!values[key]) throw new Error(`--${key} required`);
const requirement = values['requirement-probe'];
if (Boolean(requirement) === Boolean(values['contract-probe']) || requirement && values['contract-baseline'])
  throw new Error('Choose a calibrated --contract-probe/--contract-baseline or a new-task --requirement-probe.');
if (!requirement && !values['contract-baseline']) throw new Error('--contract-baseline required for a compatibility probe');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const original = await read(values.baseline);
const contract = requirement ? null : await read(values['contract-baseline']);
if (!original.completeRuntime || contract && (original.baseCommit !== contract.baseCommit || !contract.completeRuntime))
  throw new Error('Original and contract baselines must be completed on the same prepared commit.');
if (contract && (await readRegressionContractProbe(values['contract-probe'])).receipt.sha256 !== contract.contractProbe?.sha256)
  throw new Error('Contract probe baseline hash mismatch.');
const common = { project: values.project, toolRoot: values['tool-root'], javaHome: values['java-home'],
  timeoutMs: Number(values['timeout-ms'] ?? 420000) };
const suite = await runRegressionCheck({ ...common, baseline: values.baseline, originalTests: true });
console.log([suite.line, ...suite.names, ...(suite.diagnostics ?? []), ...suite.errors].join('\n'));
const probe = await runRegressionCheck({ ...common, baseline: requirement ? undefined : values['contract-baseline'],
  contractProbe: requirement ?? values['contract-probe'] });
const probeLine = probe.line.replace('RC_REGRESSION_CHECK', requirement ? 'RC_REQUIREMENT_CHECK' : 'RC_CONTRACT_CHECK');
console.log([requirement ? probeLine.replace('baseline calibration, not a before/after comparison', 'public task requirements; no baseline comparison') : probeLine,
  ...probe.names, ...(probe.diagnostics ?? []), ...probe.errors,
  requirement
    ? `Public task requirement source: ${probe.contractProbe.source}; all observed cases must pass; no baseline regression comparison is claimed.`
    : `Public contract source: ${probe.contractProbe.source}; original baseline evidence: ${contract.sourceEvidence}`].join('\n'));
process.exitCode = Math.max(suite.exitCode, probe.exitCode);
