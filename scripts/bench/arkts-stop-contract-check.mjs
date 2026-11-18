#!/usr/bin/env node
// Compose the existing full public suite and a separately calibrated public
// contract case. Each runs in a different native process and project snapshot.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { regressionCommandOptions, regressionOutputLines, runArktsRequirementProbe, runRegressionCheck } from './arkts-regression-check.mjs';
const stringOptions = ['project', 'tool-root', 'java-home', 'baseline', 'contract-probe', 'contract-baseline',
  'requirement-probe', 'requirement-probe-sha256', 'timeout-ms', 'max-names', 'isolate-test', 'exclude-cases'];
const { values } = parseArgs({ options: {
  ...Object.fromEntries(stringOptions.map(name => [name, { type: 'string' }])),
  'requirement-test': { type: 'string', multiple: true },
  'requirement-only': { type: 'boolean' },
  'regression-only': { type: 'boolean' },
} });
const requirementOnly = values['requirement-only'] === true;
const regressionOnly = values['regression-only'] === true;
for (const key of requirementOnly ? ['project', 'tool-root'] : ['project', 'tool-root', 'baseline'])
  if (!values[key]) throw new Error(`--${key} required`);

const requirement = values['requirement-probe'];
const triage = values['isolate-test'] !== undefined || values['exclude-cases'] !== undefined;
const trusted = values['requirement-probe-sha256'] !== undefined || values['requirement-test'] !== undefined;
if (regressionOnly && (requirementOnly || triage || values['contract-probe'] || values['contract-baseline']))
  throw new Error('--regression-only cannot be combined with --requirement-only, triage or compatibility flags.');
if (requirementOnly && (!requirement || !/^[a-f0-9]{64}$/u.test(values['requirement-probe-sha256'] ?? '')
  || !values['requirement-test']?.length || triage || values['contract-probe'] || values['contract-baseline'])) {
  throw new Error('--requirement-only requires a pinned requirement probe and named cases, without triage or compatibility flags.');
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const original = requirementOnly ? null : await read(values.baseline);
if (!requirementOnly && !original?.completeRuntime)
  throw new Error('Original and contract baselines must be completed on the same prepared commit.');
let contract;
if (!triage && !regressionOnly) {
  if (Boolean(requirement) === Boolean(values['contract-probe']) || requirement && values['contract-baseline'] || trusted && !requirement)
    throw new Error('Choose a calibrated --contract-probe/--contract-baseline or a new-task --requirement-probe.');
  if (!requirement) {
    if (!values['contract-baseline']) throw new Error('--contract-baseline required for a compatibility probe');
    contract = await read(values['contract-baseline']);
    if (original.baseCommit !== contract.baseCommit || !contract.completeRuntime)
      throw new Error('Original and contract baselines must be completed on the same prepared commit.');
    if (createHash('sha256').update(await fs.readFile(values['contract-probe'])).digest('hex') !== contract.contractProbe?.sha256)
      throw new Error('Contract probe baseline hash mismatch.');
  }
}

const runtime = regressionCommandOptions(Number(values['timeout-ms'] ?? (trusted || triage ? 840000 : 420000)));
const common = { project: values.project, toolRoot: values['tool-root'], javaHome: values['java-home'],
  maxNames: Number(values['max-names'] ?? 20), ...runtime,
  deadlineAt: trusted ? Math.min(runtime.deadlineAt, Date.now() + runtime.timeoutMs) : runtime.deadlineAt };
if (!requirementOnly) {
  const suite = await runRegressionCheck({ ...common, baseline: values.baseline, originalTests: true,
    isolateTest: values['isolate-test'], excludeCases: values['exclude-cases'] });
  console.log(regressionOutputLines(suite).join('\n'));
  process.exitCode = suite.exitCode;
}

if (!regressionOnly && !triage && trusted) {
  const { sha256, checks, status, snapshotSha256, exitCode } = await runArktsRequirementProbe({ ...common, probe: requirement,
    sha256: values['requirement-probe-sha256'], testIds: values['requirement-test'] });
  console.log('RC_REQUIREMENT_PROBE ' + JSON.stringify({ sha256, checks, status, ...(snapshotSha256 ? { snapshotSha256 } : {}) }));
  if (requirementOnly) process.exitCode = exitCode;
} else if (!regressionOnly && !triage) {
  const source = requirement ?? values['contract-probe'];
  const probe = await runRegressionCheck({ ...common, baseline: requirement ? undefined : values['contract-baseline'], contractProbe: source });
  const [line, ...lines] = regressionOutputLines(probe);
  const label = requirement ? 'RC_REQUIREMENT_CHECK' : 'RC_CONTRACT_CHECK';
  console.log([line.replace('RC_REGRESSION_CHECK', label)
    .replace('baseline calibration, not a before/after comparison', 'public task requirements; no baseline comparison'),
    ...lines.filter(value => !value.startsWith('RC_REGRESSION_INVENTORY ')),
    requirement
      ? `Public task requirement source: ${probe.contractProbe?.source ?? source}; all observed cases must pass; no baseline regression comparison is claimed.`
      : `Public contract source: ${probe.contractProbe?.source ?? source}; original baseline evidence: ${contract.sourceEvidence}`].join('\n'));
  process.exitCode = Math.max(process.exitCode, probe.exitCode);
}
