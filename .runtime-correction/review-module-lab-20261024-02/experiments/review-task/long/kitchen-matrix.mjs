// Isolated controls. Candidate labels, independent oracle and verifier stay outside model input.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewTask } from './review-task.mjs';
import { verifyCites } from './verify-cites.mjs';
import { exec, save, sha256, sourceRepo, newOutput, copyHashed, confirmUnchanged, trackedState, authorizedRuntime } from './harness-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), live = args.includes('--live');
const selected = args.find(value => value.startsWith('--cases='))?.slice('--cases='.length).split(',') ?? ['C01', 'C02', 'C03', 'C04', 'C05'];
const [destination, source] = args.filter(value => value !== '--live' && !value.startsWith('--cases='));
if (!destination) throw new Error('Usage: node kitchen-matrix.mjs NEW_LAB_OUTPUT_DIRECTORY [SOURCE_REPO] [--cases=C01,C02,C03,C04,C05] [--live]');
if (new Set(selected).size !== selected.length || selected.some(value => !/^C0[1-5]$/u.test(value))) throw new Error('Choose distinct C01 through C05 cases');
const repository = await sourceRepo(source), before = await trackedState(repository), output = await newOutput(repository, destination);
const frozenOriginal = path.join(repository, '.runtime-correction/review-module-lab-20261024-02/kitchen-live-01/frozen-original');
const provenance = [];
for (const name of ['kitchen.py', 'requirements.md', 'verify_kitchen.py'])
  provenance.push(await copyHashed(path.join(frozenOriginal, name), path.join(output, 'frozen-original', name)));
provenance.push(await copyHashed(path.join(here, 'verify-kitchen.py'), path.join(output, 'frozen-original/verify-kitchen.py')));
const code = await fs.readFile(path.join(output, 'frozen-original/kitchen.py'), 'utf8');
const requirementBytes = await fs.readFile(path.join(output, 'frozen-original/requirements.md'));
const lines = requirementBytes.toString('utf8').split('\n');
const anchorStart = lines.findIndex(line => /^R04\s/u.test(line)) + 1;
let anchorEnd = lines.findIndex((line, index) => index >= anchorStart && /^R05\s/u.test(line));
while (anchorEnd > anchorStart && !lines[anchorEnd - 1].trim()) anchorEnd--;
if (anchorStart < 1 || anchorEnd < anchorStart) throw new Error('Cannot establish original R04 requirement anchor');
const consume = /    for ing, need in recipe\.items\(\):\r?\n        pantry\[ing\] = pantry\.get\(ing, 0\) - need\r?\n/u;
const withoutConsumption = code.replace(consume, '');
const queryHeader = 'def cmd_can_cook(args):\n    store = load_store(args.store)';
const normalizedCode = code.replaceAll('\r\n', '\n');
const mutatingQuery = normalizedCode.replace(queryHeader, `${queryHeader}\n    store["last_query"] = args.name\n    save_store(args.store, store)`);
if (withoutConsumption === code || mutatingQuery === normalizedCode) throw new Error('A kitchen mutation did not apply');
const cases = {
  C01: { baseline: code, candidate: `${code}\n# Local CLI implementation.\n`, expected: 'PASS', businessPass: true, kind: 'source-positive' },
  C02: { baseline: code, candidate: withoutConsumption, expected: 'DEVIATION', businessPass: false, businessFailure: 'persisted-consumption', kind: 'missing-consumption' },
  C03: { baseline: code, candidate: mutatingQuery, expected: 'DEVIATION', businessPass: false, businessFailure: 'shortfall: store bytes changed', kind: 'query-changes-store' },
  C04: { baseline: withoutConsumption, candidate: `${withoutConsumption}\n# Local CLI implementation.\n`, expected: 'DEVIATION', businessPass: false, businessFailure: 'persisted-consumption', kind: 'preexisting-defect-with-comment-diff' },
  C05: { baseline: code, candidate: `${code}\n# Local CLI implementation.\n`, expected: 'UNVERIFIED', businessPass: true, kind: 'runtime-proof-withheld' },
};
const runtime = live ? await authorizedRuntime(output) : null;
await save(path.join(output, 'engine.json'), { mode: live ? 'LIVE_REVIEW' : 'OFFLINE_PREFLIGHT', model: runtime?.primary ?? null,
  maxAttempts: 2, maxTurns: 100, tokenBudget: null, deadline: null, nativeCompaction: true,
  originalProjectOrSessionAccessed: false, productionStopIntegration: false });
async function atomicReport(file, value) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temporary, file);
}
const results = [];
for (const caseId of selected) {
  const definition = cases[caseId], directory = path.join(output, caseId), workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  let row;
  try {
    await fs.writeFile(path.join(workspace, 'kitchen.py'), definition.baseline);
    await fs.writeFile(path.join(workspace, 'requirements.md'), requirementBytes);
    await fs.writeFile(path.join(workspace, '.gitignore'), '__pycache__/\n');
    await exec('git', ['init', '--quiet', workspace]);
    await exec('git', ['add', '.'], { cwd: workspace });
    const identity = ['-c', 'user.name=Review experiment', '-c', 'user.email=review@example.invalid'];
    await exec('git', [...identity, 'commit', '--quiet', '-m', `Capture baseline ${caseId}`], { cwd: workspace });
    const baseline = (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
    await fs.writeFile(path.join(workspace, 'kitchen.py'), definition.candidate);
    await exec('git', ['add', 'kitchen.py'], { cwd: workspace });
    await exec('git', [...identity, 'commit', '--quiet', '-m', `Capture candidate ${caseId}`], { cwd: workspace });
    const candidate = (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
    const patch = (await exec('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', baseline, candidate, '--', 'kitchen.py'], { cwd: workspace })).stdout;
    await fs.writeFile(path.join(workspace, 'review.diff'), patch);
    const scope = caseId === 'C05' ? 'RUNTIME_ACCEPTANCE' : 'SOURCE_IMPLEMENTATION';
    const task = { id: 'R04', scope,
      requirement: scope === 'SOURCE_IMPLEMENTATION'
        ? 'Check the entire original R04 obligation and applicable original conditions and exceptions against current kitchen.py. Judge source-decidable implementation behavior only; actual runtime acceptance is a separate proof question.'
        : 'Check actual runtime acceptance of the entire original R04 obligation and applicable original conditions and exceptions. The input contains source but no execution records. Source reasoning cannot establish that the required executions occurred. Do not execute the application.',
      basisFiles: ['requirements.md'], targetFiles: ['kitchen.py'],
      basisAnchors: [{ claimId: 'R04', path: 'requirements.md', start: anchorStart, end: anchorEnd }],
      navigation: { diff: 'review.diff', baseline, candidate, applicability: 'A real isolated base-to-candidate diff. Use it for navigation and check current implementation; it does not establish initial acceptance.' } };
    await save(path.join(directory, 'task.json'), task);
    // Run the unchanged original verifier against a byte-identical oracle copy,
    // outside the model workspace. Its temporary stores never enter model input.
    const oracleApp = path.join(directory, 'independent-app');
    await fs.mkdir(oracleApp);
    await fs.writeFile(path.join(oracleApp, 'kitchen.py'), definition.candidate);
    const verifierEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/iu.test(key)));
    verifierEnv.PYTHONDONTWRITEBYTECODE = '1';
    let independent;
    try {
      const checked = await exec('python', ['-B', path.join(output, 'frozen-original/verify-kitchen.py'), path.join(output, 'frozen-original/verify_kitchen.py'), oracleApp], { cwd: directory, env: verifierEnv, maxBuffer: 8 * 1024 * 1024 });
      independent = { passed: true, stdout: checked.stdout };
    } catch (error) { independent = { passed: false, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
    const businessMatched = independent.passed === definition.businessPass
      && (!definition.businessFailure || `${independent.stdout ?? ''}\n${independent.stderr ?? ''}`.includes(definition.businessFailure));
    await save(path.join(directory, 'independent-verifier.json'), { ...independent, sourceSha256: sha256(Buffer.from(definition.candidate)) });
    await save(path.join(directory, 'oracle.json'), { visibility: 'outside model workspace', kind: definition.kind, expectedVerdict: definition.expected,
      expectedScope: scope, businessMatched, explanation: caseId === 'C05' ? 'The independent verifier passes, but its output is intentionally unavailable to the runtime-acceptance reviewer.' : 'Expected source proof is checked against the original independent business verifier.' });
    let result = null, citations = null;
    if (live) {
      console.log(JSON.stringify({ caseId, phase: 'review-start' }));
      result = await runReviewTask({ task, root: workspace, outputDir: path.join(directory, 'review'), modelRuntime: runtime.runtime, model: runtime.model,
        maxAttempts: 2, maxTurns: 100, onEvent: event => { if (['assistant', 'attempt', 'decision_saved'].includes(event.type)) console.log(JSON.stringify({ caseId, ...event })); } });
      citations = await verifyCites(path.join(directory, 'review'));
      await save(path.join(directory, 'citation-verification.json'), citations);
    }
    const modelMatched = live ? (result.completed && result.scope === scope && result.verdict === definition.expected
      && result.conclusive === (definition.expected !== 'UNVERIFIED') && citations.passed) : null;
    row = { caseId, scope, expected: definition.expected, submitted: result?.completed ?? null, conclusive: result?.conclusive ?? null,
      businessMatched, modelMatched, matched: businessMatched && (!live || modelMatched),
      sourceSha256: sha256(Buffer.from(definition.candidate)), requirementSha256: sha256(requirementBytes), result, citations };
  } catch (error) { row = { caseId, matched: false, error: error.message }; }
  results.push(row);
  await atomicReport(path.join(directory, 'report.json'), row);
  await atomicReport(path.join(output, 'progress.json'), { mode: live ? 'LIVE_REVIEW' : 'OFFLINE_PREFLIGHT', completedCases: results.length, results });
}
const sourcesUnchanged = await confirmUnchanged(provenance), after = await trackedState(repository);
const originalRepositoryUnchanged = JSON.stringify(before) === JSON.stringify(after);
const originalConfigurationUnchanged = runtime ? await runtime.unchanged() : null;
const passed = results.every(row => row.matched) && sourcesUnchanged && originalRepositoryUnchanged && originalConfigurationUnchanged !== false;
const report = { status: passed ? (live ? 'PASS' : 'PREFLIGHT_PASS') : 'FAIL', mode: live ? 'LIVE_REVIEW' : 'OFFLINE_PREFLIGHT', results,
  originalRepositoryUnchanged, sourceStateBefore: before, sourceStateAfter: after, sourcesUnchanged, originalConfigurationUnchanged, provenance,
  limitations: 'Five controls, not a production completion-rate estimate. No original project/session access, no Stop integration. C05 UNVERIFIED is the correct completed runtime-proof outcome, not a source PASS. Citation byte integrity is not semantic support.' };
await atomicReport(path.join(output, 'report.json'), report);
console.log(JSON.stringify({ status: report.status, output, cases: results.map(row => ({ caseId: row.caseId, matched: row.matched, verdict: row.result?.verdict ?? null })) }));
if (!passed) process.exitCode = 1;
