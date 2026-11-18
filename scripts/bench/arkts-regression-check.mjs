#!/usr/bin/env node
// Runs public ArkTS suites or a calibrated public contract case through the
// mutexed toolchain; it never reads a dataset, test_patch or hidden tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { localTestEvidence, publicLocalTestEvidence } from './local-test-evidence.mjs';
import { applyJavaEnvironment, resolveJavaHome } from './arkts-java.mjs';
import { runArktsLocalTest } from './arkts-local-test.mjs';
import { arktsInstrumentRuntime } from './arkts-instrument-results.mjs';
import { prepareRegressionWorkspace, installRegressionContractProbe, installRegressionCaseFilter, installRegressionCaseExclusions } from './regression-workspace.mjs';

const { routeEnvironment } = createRequire(import.meta.url)('../../config/arkts-openspec-correction.json').stopCorrection.regressionCheck;
export const regressionCheckOverride = { stopCorrection: { regressionCheck: { enabled: true, testSource: 'current', routeEnvironment,
  command: ['${node}', '${harnessRoot}/scripts/bench/arkts-regression-check.mjs', '--project=${projectRoot}', '--tool-root=${toolRoot}', '--java-home=${javaHome}'],
  cwd: '.', timeoutMs: 900000 } } };
const usage = `node scripts/bench/arkts-regression-check.mjs --project=<business workspace> --tool-root=<command-line-tools> [--java-home=<jdk>]
  [--baseline=<baseline-local-tests.json>] [--original-tests] [--timeout-ms=840000] [--max-names=20]
  [--contract-probe=<public-contract-case.ets>] [--isolate-test=<exact public test ID>]
Prints one "RC_REGRESSION_CHECK PASS|FAIL|INCOMPLETE ..." line and failing test names; exit 0 / 1 / 2.
With --baseline, PASS means no regressions and no new failures; pre-existing failures are listed, not counted.
With --original-tests, run the task-start public tests on an isolated copy of the current implementation.
An optional contract probe runs its public case alone in a fresh native process; a supplied baseline must bind the same probe SHA256.

Override for scripts/run-original-basis-release.mjs, run-release-e2e.mjs or run-arkts-rc-case.mjs (--rc-config-overrides=<file>).
The harness substitutes \${node} \${harnessRoot} \${projectRoot} \${toolRoot} \${javaHome} \${outputRoot} before writing config.yaml:
${JSON.stringify(regressionCheckOverride, null, 2)}
Add "--baseline=\${outputRoot}/baseline-local-tests.json" to command with --baseline-local-tests.`;

export function regressionCaseScope(id) {
  const match = /^[^:]+::([^:]+)::(.+)$/u.exec(id ?? '');
  if (!match || /[\r\n,]/u.test(match[1] + match[2]))
    throw new Error('The exact test ID cannot be expressed with the native Hypium suite/itName filter.');
  return { module: id.slice(0, id.indexOf('::')), suite: match[1], itName: match[2] };
}

export function regressionVerdict(current, baseline, maxNames = 20) {
  const compared = publicLocalTestEvidence(current, baseline), comparison = compared.baselineComparison;
  const passed = Object.values(current.statuses).filter(status => status === 'PASS').length, total = Object.keys(current.statuses).length;
  if (!current.completeRuntime || !total) return { status: 'INCOMPLETE', exitCode: 2, line: `RC_REGRESSION_CHECK INCOMPLETE fresh=${current.freshReport} finished=${current.finished} tests=${total}`, names: [] };
  const counted = comparison.comparable ? [...comparison.regressions, ...comparison.newFailures] : current.failures.map(({ id }) => id);
  const known = comparison.comparable ? comparison.persistingFailures : [];
  const status = counted.length ? 'FAIL' : 'PASS';
  const names = [...counted.map(id => `- ${current.statuses[id]} ${id}`), ...known.map(id => `- known ${current.statuses[id]} ${id}`)];
  const diagnostics = counted.length ? (current.runtimeDiagnostics?.messages ?? []).map(item => `  public assertion: ${item.text}`) : [];
  return { status, exitCode: counted.length ? 1 : 0, names: names.slice(0, maxNames).concat(names.length > maxNames ? [`- ... ${names.length - maxNames} more`] : []),
    ...(diagnostics.length ? { diagnostics } : {}),
    line: `RC_REGRESSION_CHECK ${status} tests=${total} passed=${passed} failed=${total - passed}`
      + (comparison.comparable ? ` regressions=${comparison.regressions.length} newFailures=${comparison.newFailures.length} knownFailures=${known.length}` : ' baseline=none') };
}

export function collateralSuiteReceipt(exclusion, baseline, current) {
  const removed=new Set(exclusion.exclusions.map(x=>x.id));
  const survivors=Object.keys(baseline.statuses??{}).filter(id=>!removed.has(id));
  const complete=current.completeRuntime===true&&survivors.length>0&&Object.keys(current.statuses).length===survivors.length
    &&survivors.every(id=>['PASS','FAIL','ERROR'].includes(current.statuses[id]))
    &&[...removed].every(id=>!Object.hasOwn(current.statuses,id));
  return {requestId:exclusion.requestId,baselineSha256:exclusion.baselineSha256,taskStartSuite:true,complete,
    excludedIds:[...removed],expectedSurvivingCount:survivors.length,observedSurvivingCount:survivors.filter(id=>current.statuses[id]).length,
    failures:survivors.filter(id=>current.statuses[id]&&current.statuses[id]!=='PASS'),
    probes:Object.fromEntries(exclusion.probes.map(id=>[id,current.statuses[id]??'UNAVAILABLE']))};
}

function unavailableRegressionCheck(isolateTest, reason) {
  const execution = { exitCode: null, interrupted: true, outputComplete: false, reason };
  const current = localTestEvidence('', execution, { freshReport: false, compileOutput: '' });
  const verdict = regressionVerdict(current, null);
  return { ...verdict, current, errors: [], execution,
    ...(isolateTest === undefined
      ? { names: ['RC_REGRESSION_INVENTORY {"complete":false,"failures":[]}'] }
      : { isolatedCase: { id: isolateTest, status: 'UNAVAILABLE', complete: false, observed: [] } }) };
}

export async function runRegressionCheck({ project, toolRoot, javaHome, baseline, originalTests = false, contractProbe,
  contractProbeSha256, isolateTest, excludeCases, timeoutMs = 840000, deadlineAt = Infinity,
  maxNames = 20, signal, publicTestWorker, instrument, includeExecutionEvidence = false }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive ArkTS regression check timeout is required');
  const deadline = Math.min(deadlineAt, Date.now() + timeoutMs);
  const remaining = () => Math.floor(deadline - Date.now());
  const unavailable = () => unavailableRegressionCheck(isolateTest, signal?.aborted ? 'cancelled' : 'deadline');
  if (signal?.aborted || remaining() <= 0) return unavailable();
  const testFilter = isolateTest === undefined ? null : regressionCaseScope(isolateTest);
  const remoteInstrument = publicTestWorker?.runtime === arktsInstrumentRuntime;
  const baselineEvidence = baseline ? JSON.parse(await fs.readFile(baseline, 'utf8')) : null;
  const exclusion=excludeCases?JSON.parse(await fs.readFile(excludeCases,'utf8')):null;
  if(exclusion&&(!originalTests||contractProbe||isolateTest||!baselineEvidence?.completeRuntime||!Array.isArray(exclusion.exclusions)
    ||!exclusion.exclusions.length||!Array.isArray(exclusion.probes)||!exclusion.probes.length
    ||exclusion.baselineSha256!==createHash('sha256').update(await fs.readFile(baseline)).digest('hex')))
    throw new Error('Controlled exclusion requires the exact completed task-start public baseline.');
  if (originalTests && (!baselineEvidence?.completeRuntime || !baselineEvidence.baseCommit))
    throw new Error('--original-tests requires a completed baseline with its exact original test commit.');
  const probeBytes = contractProbe ? await fs.readFile(contractProbe) : null;
  const probe = probeBytes ? { source: path.resolve(contractProbe), sha256: createHash('sha256').update(probeBytes).digest('hex') } : null;
  if (contractProbeSha256 !== undefined && probe?.sha256 !== contractProbeSha256)
    throw Object.assign(new Error('Requirement probe hash mismatch.'), { code: 'REQUIREMENT_PROBE_SHA_MISMATCH' });
  if (baselineEvidence && (probe || baselineEvidence.contractProbe)
    && probe?.sha256 !== baselineEvidence.contractProbe?.sha256) throw new Error('Contract probe baseline hash mismatch.');
  if (probe && baselineEvidence && (!baselineEvidence.completeRuntime || !/^[a-f0-9]{40}$/u.test(baselineEvidence.baseCommit ?? '')))
    throw new Error('Contract probe requires a completed original baseline with its exact commit.');
  let root, report;
  try {
    root = await prepareRegressionWorkspace(path.resolve(project), { originalTestCommit: originalTests ? baselineEvidence.baseCommit : undefined,
      signal, preserveSymlinks: Boolean(publicTestWorker || instrument) });
    if (exclusion) await installRegressionCaseExclusions(root, exclusion.exclusions);
    if (probe) await installRegressionContractProbe(root, probeBytes);
    if (testFilter && !instrument && !remoteInstrument) await installRegressionCaseFilter(root, testFilter);
    const timeLeft = remaining();
    if (signal?.aborted || timeLeft <= 0) return unavailable();
    if (!publicTestWorker) {
      ({ javaHome } = resolveJavaHome({ explicit: javaHome }));
      applyJavaEnvironment(javaHome);
    }
    report = await runArktsLocalTest({ projectRoot: root, toolRoot, javaHome, timeoutMs: timeLeft,
      signal, install: true, publicTestWorker: remoteInstrument && testFilter ? { ...publicTestWorker, scope:testFilter } : publicTestWorker,
      instrument: instrument && { ...instrument, scope: testFilter } });
  } catch (error) {
    if (signal?.aborted || remaining() <= 0) return unavailable();
    throw error;
  }
  const { execution, output, raw, freshReport } = report;
  const current = localTestEvidence(raw, execution, { freshReport, compileOutput: output });
  const verdict = regressionVerdict(current, baselineEvidence, maxNames);
  const inventory = { complete: current.completeRuntime, failures: current.failures.map(({ id }) => ({ id,
    title: id.replace(/^[^:]+::[^:]+::/u, '') })) };
  if (isolateTest === undefined) verdict.names.push('RC_REGRESSION_INVENTORY ' + JSON.stringify(inventory));
  const observed = Object.keys(current.statuses);
  const collateral=exclusion?collateralSuiteReceipt(exclusion,baselineEvidence,current):null;
  if(collateral)verdict.names.push('RC_REGRESSION_COLLATERAL '+JSON.stringify(collateral));
  const isolatedCase = isolateTest === undefined ? null : { id: isolateTest, status: current.statuses[isolateTest] ?? 'UNAVAILABLE',
    complete: current.completeRuntime && observed.length === 1 && observed[0] === isolateTest, observed };
  if (originalTests && !probe) verdict.line += ' suite=task-start; compare failures with the original request before classifying regressions';
  if (probe) verdict.line += ` contractProbe=${probe.sha256}; ${baselineEvidence ? 'matches the original baseline probe' : 'baseline calibration, not a before/after comparison'}`;
  await fs.writeFile(root + '.result.json', JSON.stringify({ source: path.resolve(project), workspace: root, baselineCommit: baselineEvidence?.baseCommit,
    ...(probe ? { contractProbe: probe } : {}),
    current, verdict, execution, output, ...(isolatedCase ? { isolatedCase } : {}), ...(collateral?{collateral}:{}) }, null, 2));
  const errors = verdict.status === 'INCOMPLETE' ? output.split(/\r?\n/u).filter(line => /\bERROR\b|error:|Exception|RC_ARKTS_JAVA/iu.test(line)).slice(-12) : [];
  const compileDiagnostics = probe && execution.compileSucceeded === false && !execution.interrupted
    ? publicRequirementCompileDiagnostics(output) : [];
  return { ...verdict, current, ...(probe ? { contractProbe: probe, workspace: root } : {}), ...(isolatedCase ? { isolatedCase } : {}),
    ...(collateral?{collateral}:{}), errors, compileDiagnostics,
    ...(includeExecutionEvidence ? { executionEvidence: { execution, output, raw, freshReport } } : {}),
    execution: { exitCode: execution.exitCode, interrupted: execution.interrupted, reason: execution.reason,
      ...(typeof execution.compileSucceeded === 'boolean' ? { compileSucceeded: execution.compileSucceeded } : {}),
      ...(/^[a-f0-9]{64}$/u.test(execution.snapshotSha256 ?? '') ? { snapshotSha256: execution.snapshotSha256 } : {}) } };
}

function publicRequirementCompileDiagnostics(output) {
  return output.split(/\r?\n/u).map(line => line.replace(/\x1b\[[0-9;]*m/gu, '').trim())
    .filter(line => line.startsWith('Error Message: '))
    .map(line => line.slice('Error Message: '.length).split(/\s+At File:\s*/u, 1)[0]
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim())
    .filter(Boolean).slice(0, 4);
}

export async function runArktsRequirementProbe({ project, toolRoot, javaHome, probe, sha256, testIds, ...runnerArgs }) {
  const ids = Array.isArray(testIds) ? testIds : [];
  const checks = ids.map(id => ({ id, status: 'UNAVAILABLE' }));
  const incomplete = (reason, details = {}) => ({ sha256, checks, status: 'INCOMPLETE', exitCode: 2, reason, ...details });
  if (typeof probe !== 'string' || !probe || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256) || !ids.length
    || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[^:\r\n\0]+::[^:\r\n\0]+::[^\r\n\0]+$/u.test(id)))
    return incomplete('REQUIREMENT_PROBE_IDENTITY_INVALID');
  const { timeoutMs = 840000, signal, publicTestWorker, instrument, includeExecutionEvidence } = runnerArgs;
  const deadlineAt = Math.min(runnerArgs.deadlineAt ?? Infinity, Date.now() + timeoutMs);
  try {
    const run = await runRegressionCheck({ project, toolRoot, javaHome, contractProbe: probe, contractProbeSha256: sha256,
      timeoutMs, deadlineAt, signal, publicTestWorker, instrument, includeExecutionEvidence });
    const { statuses, completeRuntime } = run.current;
    const observed = Object.keys(statuses);
    const details = { observed, workspace: run.workspace,
      ...(run.executionEvidence ? { executionEvidence: run.executionEvidence } : {}) };
    if (signal?.aborted) return incomplete('REQUIREMENT_PROBE_CANCELLED', details);
    if (run.execution.reason === 'deadline' || !completeRuntime && Date.now() >= deadlineAt)
      return incomplete('REQUIREMENT_PROBE_DEADLINE', details);
    if (!completeRuntime && run.execution.compileSucceeded === false && !run.execution.interrupted) {
      if (!run.compileDiagnostics.length) return incomplete('REQUIREMENT_PROBE_BUILD_INCOMPLETE', details);
      return incomplete('REQUIREMENT_PROBE_COMPILE_FAILED', { ...details, diagnostics: run.compileDiagnostics });
    }
    if (!completeRuntime || !Number.isInteger(run.execution.exitCode) || run.execution.exitCode < 0)
      return incomplete('REQUIREMENT_PROBE_RUNTIME_INCOMPLETE', details);
    const outcomes = ids.map(id => ({ id, status: ['PASS', 'FAIL'].includes(statuses[id]) ? statuses[id] : 'UNAVAILABLE' }));
    if (observed.length !== ids.length || outcomes.some(check => check.status === 'UNAVAILABLE'))
      return incomplete('REQUIREMENT_PROBE_CASES_UNVERIFIED', { ...details, checks: outcomes });
    const failed = outcomes.some(check => check.status === 'FAIL');
    return { sha256, checks: outcomes, status: failed ? 'FAIL' : 'PASS', exitCode: failed ? 1 : 0, ...details,
      ...(run.execution.snapshotSha256 ? { snapshotSha256: run.execution.snapshotSha256 } : {}) };
  } catch (error) {
    if (error.code === 'REQUIREMENT_PROBE_SHA_MISMATCH') return incomplete(error.code);
    if (signal?.aborted) return incomplete('REQUIREMENT_PROBE_CANCELLED');
    return incomplete(Date.now() >= deadlineAt ? 'REQUIREMENT_PROBE_DEADLINE' : 'REQUIREMENT_PROBE_UNAVAILABLE');
  }
}

export function regressionCommandOptions(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive ArkTS regression check timeout is required');
  const { RC_ARKTS_TEST_EXCHANGE: exchange, RC_ARKTS_TEST_TOOLCHAIN_SHA256: toolchainSha256,
    RC_ARKTS_TEST_RELEASE_COMMIT: releaseCommit, RC_ARKTS_TEST_RUNTIME: runtime, RC_ARKTS_TEST_CASE: caseId } = process.env;
  if ((exchange || toolchainSha256 || releaseCommit)
    && (!exchange || !/^[a-f0-9]{64}$/u.test(toolchainSha256 ?? '') || !/^[a-f0-9]{40}$/u.test(releaseCommit ?? '')))
    throw new Error('Public test worker exchange, toolchain fingerprint, and release commit must be configured together.');
  assert(runtime === undefined || exchange && runtime === arktsInstrumentRuntime && /^[a-z0-9_-]+$/u.test(caseId ?? ''),
    'Instrument Test worker requires a public exchange and benchmark case');
  const publicTestWorker = exchange ? { exchange:path.resolve(exchange), toolchainSha256, releaseCommit,
    ...(runtime ? { runtime, caseId } : {}) } : undefined;
  const instrument = process.env.RC_ARKTS_INSTRUMENT ? JSON.parse(process.env.RC_ARKTS_INSTRUMENT) : undefined;
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  const inheritedDeadline = Number(process.env.RC_REGRESSION_DEADLINE_AT || NaN);
  const deadlineAt = Number.isSafeInteger(inheritedDeadline) ? inheritedDeadline - 2000 : Infinity;
  return { timeoutMs, deadlineAt, signal: controller.signal, publicTestWorker, instrument };
}

export function regressionOutputLines(result) {
  return [result.line, ...result.names, ...(result.isolatedCase ? [`RC_REGRESSION_CASE ${JSON.stringify(result.isolatedCase)}`] : []),
    ...(result.diagnostics ?? []), ...result.errors.map(line => `  ${line.trim().slice(0, 300)}`),
    ...(result.execution.interrupted ? [`  interrupted: ${result.execution.reason}`] : [])];
}

async function main() {
  const { values: args } = parseArgs({ options: Object.fromEntries([...['project', 'tool-root', 'java-home', 'baseline', 'timeout-ms', 'max-names']
    .concat('contract-probe', 'isolate-test', 'exclude-cases').map(name => [name, { type: 'string' }]), ['help', { type: 'boolean' }], ['original-tests', { type: 'boolean' }]]) });
  if (args.help || !args.project || !args['tool-root']) { console.log(usage); process.exit(args.help ? 0 : 2); }
  const runtime = regressionCommandOptions(Number(args['timeout-ms'] ?? 840000));
  const result = await runRegressionCheck({ project: args.project, toolRoot: args['tool-root'], javaHome: args['java-home'], baseline: args.baseline,
    originalTests: args['original-tests'],
    contractProbe: args['contract-probe'],
    isolateTest: args['isolate-test'],
    excludeCases: args['exclude-cases'],
    ...runtime, maxNames: Number(args['max-names'] ?? 20) });
  console.log(regressionOutputLines(result).join('\n'));
  process.exitCode = result.exitCode;
}

// OpenClaw loads this module synchronously through Jiti for the benchmark tools.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
