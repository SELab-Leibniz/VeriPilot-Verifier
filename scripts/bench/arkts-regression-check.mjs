#!/usr/bin/env node
// Runs public ArkTS suites or a calibrated public contract case through the
// mutexed toolchain; it never reads a dataset, test_patch or hidden tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { runBoundedProcess } from './bounded-process.mjs';
import { localTestEvidence, publicLocalTestEvidence } from './local-test-evidence.mjs';
import { applyJavaEnvironment, resolveJavaHome } from './arkts-java.mjs';
import { prepareRegressionWorkspace, installRegressionContractProbe, installRegressionCaseFilter } from './regression-workspace.mjs';

export const regressionCheckOverride = { stopCorrection: { regressionCheck: { enabled: true,
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
const coverageLog = 'entry/.test/default/intermediates/test/coverage_data/coverage.log';

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

export async function runRegressionCheck({ project, toolRoot, javaHome, baseline, originalTests = false, contractProbe, isolateTest, timeoutMs = 840000, maxNames = 20, signal }) {
  const testFilter = isolateTest === undefined ? null : regressionCaseScope(isolateTest);
  const baselineEvidence = baseline ? JSON.parse(await fs.readFile(baseline, 'utf8')) : null;
  if (originalTests && (!baselineEvidence?.completeRuntime || !baselineEvidence.baseCommit))
    throw new Error('--original-tests requires a completed baseline with its exact original test commit.');
  const probeBytes = contractProbe ? await fs.readFile(contractProbe) : null;
  const probe = probeBytes ? { source: path.resolve(contractProbe), sha256: createHash('sha256').update(probeBytes).digest('hex') } : null;
  if (baselineEvidence && (probe || baselineEvidence.contractProbe)
    && probe?.sha256 !== baselineEvidence.contractProbe?.sha256) throw new Error('Contract probe baseline hash mismatch.');
  if (probe && baselineEvidence && (!baselineEvidence.completeRuntime || !/^[a-f0-9]{40}$/u.test(baselineEvidence.baseCommit ?? '')))
    throw new Error('Contract probe requires a completed original baseline with its exact commit.');
  const root = await prepareRegressionWorkspace(path.resolve(project), { originalTestCommit: originalTests ? baselineEvidence.baseCommit : undefined, signal });
  if (probe) await installRegressionContractProbe(root, probeBytes);
  if (testFilter) await installRegressionCaseFilter(root, testFilter);
  const java = resolveJavaHome({ explicit: javaHome });
  applyJavaEnvironment(java.javaHome);
  const coverage = path.join(root, coverageLog);
  await fs.rm(coverage, { force: true });
  const started = Date.now(); let output = '';
  const run = phase => runBoundedProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./run-arkts-toolchain.ps1', import.meta.url)), '-Project', root, '-ToolRoot', path.resolve(toolRoot),
    '-Phase', phase, '-JavaHome', java.javaHome], { cwd: root, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
    signal, onOutput(value) { output += value; } });
  const installed = await run('install');
  const execution = installed.exitCode === 0 && !installed.interrupted ? await run('test') : installed;
  const stat = await fs.stat(coverage).catch(() => null), freshReport = Boolean(stat && stat.mtimeMs >= started - 2000);
  const current = localTestEvidence(freshReport ? await fs.readFile(coverage, 'utf8') : '', execution, { freshReport, compileOutput: output });
  const verdict = regressionVerdict(current, baselineEvidence, maxNames);
  const inventory = { complete: current.completeRuntime, failures: current.failures.map(({ id }) => ({ id,
    title: id.replace(/^[^:]+::[^:]+::/u, '') })) };
  if (isolateTest === undefined) verdict.names.push('RC_REGRESSION_INVENTORY ' + JSON.stringify(inventory));
  const observed = Object.keys(current.statuses);
  const isolatedCase = isolateTest === undefined ? null : { id: isolateTest, status: current.statuses[isolateTest] ?? 'UNAVAILABLE',
    complete: current.completeRuntime && observed.length === 1 && observed[0] === isolateTest, observed };
  if (originalTests && !probe) verdict.line += ' suite=task-start; compare failures with the original request before classifying regressions';
  if (probe) verdict.line += ` contractProbe=${probe.sha256}; ${baselineEvidence ? 'matches the original baseline probe' : 'baseline calibration, not a before/after comparison'}`;
  await fs.writeFile(root + '.result.json', JSON.stringify({ source: path.resolve(project), workspace: root, baselineCommit: baselineEvidence?.baseCommit,
    ...(probe ? { contractProbe: probe } : {}),
    current, verdict, execution, output, ...(isolatedCase ? { isolatedCase } : {}) }, null, 2));
  const errors = verdict.status === 'INCOMPLETE' ? output.split(/\r?\n/u).filter(line => /\bERROR\b|error:|Exception|RC_ARKTS_JAVA/iu.test(line)).slice(-12) : [];
  return { ...verdict, ...(probe ? { contractProbe: probe, workspace: root } : {}), ...(isolatedCase ? { isolatedCase } : {}),
    errors, execution: { exitCode: execution.exitCode, interrupted: execution.interrupted, reason: execution.reason } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values: args } = parseArgs({ options: Object.fromEntries([...['project', 'tool-root', 'java-home', 'baseline', 'timeout-ms', 'max-names']
    .concat('contract-probe', 'isolate-test').map(name => [name, { type: 'string' }]), ['help', { type: 'boolean' }], ['original-tests', { type: 'boolean' }]]) });
  if (args.help || !args.project || !args['tool-root']) { console.log(usage); process.exit(args.help ? 0 : 2); }
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  const result = await runRegressionCheck({ project: args.project, toolRoot: args['tool-root'], javaHome: args['java-home'], baseline: args.baseline,
    originalTests: args['original-tests'],
    contractProbe: args['contract-probe'],
    isolateTest: args['isolate-test'],
    timeoutMs: Number(args['timeout-ms'] ?? 840000), maxNames: Number(args['max-names'] ?? 20), signal: controller.signal });
  console.log([result.line, ...result.names, ...(result.isolatedCase ? [`RC_REGRESSION_CASE ${JSON.stringify(result.isolatedCase)}`] : []),
    ...(result.diagnostics ?? []), ...result.errors.map(line => `  ${line.trim().slice(0, 300)}`),
    ...(result.execution.interrupted ? [`  interrupted: ${result.execution.reason}`] : [])].join('\n'));
  process.exitCode = result.exitCode;
}
