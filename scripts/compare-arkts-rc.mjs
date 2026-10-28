// Serial paired native runs: model -> independent hidden tests -> accounting.
// Never evaluate two Previewer jobs concurrently. Failed attempts are retained.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runBoundedProcess } from './bench/bounded-process.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const directory = path.resolve(arg('--output') ?? `.runtime-correction/system-optimization/paired-${Date.now()}`);
const root = path.resolve('.runtime-correction/system-optimization');
const cases = (arg('--cases') ?? 'security_tool_1,happyword_12').split(',');
if (cases.some(id => !/^[a-z0-9_-]+$/u.test(id)) || new Set(cases).size !== cases.length) throw new Error('Distinct valid cases required');
const hostRoot = arg('--host-root'); if (!hostRoot) throw new Error('--host-root required');
const arms = {
  baseline: { artifact: path.resolve(arg('--baseline-artifact') ?? 'dist/runtime-corrector-openclaw'), ref: arg('--baseline-ref') ?? 'c33bae6' },
  candidate: { artifact: path.resolve(arg('--candidate-artifact') ?? '.runtime-correction/system-optimization/candidates/2909891/runtime-corrector-openclaw'), ref: arg('--candidate-ref') ?? '2909891' },
};
const navigationArtifact = path.resolve(arg('--navigation-artifact') ?? arms.baseline.artifact);
const audit = JSON.parse(await fs.readFile(path.join(root, 'calibration-audit.json'), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
if (audit.evaluatorSha256 !== sha(await fs.readFile(new URL('./bench/hypium-results.mjs', import.meta.url)))) throw new Error('Refresh calibration audit after evaluator changes');
const calibrations = Object.fromEntries(cases.map(id => {
  const record = audit.records.filter(row => row.id === id && row.baseValid && row.goldValid).at(-1);
  if (!record) throw new Error(`No valid native base/gold calibration: ${id}`);
  return [id, record.root];
}));
await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
const protocolFiles = ['scripts/run-arkts-rc-case.mjs', 'scripts/helpers/native-gateway-evaluation.mjs', 'scripts/calibrate-arkts-bench.mjs',
  'scripts/bench/native-arkts-tools.mjs', 'scripts/bench/bounded-process.mjs', 'scripts/bench/prepare-arkts-model-workspace.mjs',
  'scripts/bench/business-mutations.mjs', 'scripts/bench/run-arkts-toolchain.ps1', 'scripts/bench/hypium-results.mjs', 'scripts/bench/validate-artifact-skills.mjs', 'scripts/bench/short-workspace.mjs',
  path.join(navigationArtifact, 'lib/review-task/live-source-tools.mjs'), path.join(navigationArtifact, 'lib/review-task/source-tools.mjs')];
const protocol = Object.fromEntries(await Promise.all(protocolFiles.map(async file => [file, sha(await fs.readFile(file))])));
const adopted = new Map();
if (arg('--adopt-baselines')) {
  const previous = JSON.parse(await fs.readFile(arg('--adopt-baselines'), 'utf8'));
  if (previous.model !== (process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL)
    || previous.arms.baseline.ref !== arms.baseline.ref || previous.arms.baseline.artifact !== arms.baseline.artifact) throw new Error('Adopted baseline model/artifact mismatch');
  for (const [file, hash] of Object.entries(previous.protocol)) {
    if (protocol[file] === hash) continue;
    if (file !== 'scripts/run-arkts-rc-case.mjs') throw new Error(`Adopted business protocol differs: ${file}`);
    // A narrowly checked, input-neutral preflight addition may reuse already
    // completed business work. Any other source-byte change rejects adoption.
    const reconstructed = (await fs.readFile(file, 'utf8'))
      .replace(/^import \{ validateArtifactSkills \} from '\.\/bench\/validate-artifact-skills\.mjs';\r?\n/mu, '')
      .replace(/^  const validatedSkills = await validateArtifactSkills[^\r\n]*\r?\n/mu, '')
      .replace(/^  await fs\.writeFile\(path\.join\(outputRoot, 'skill-validation\.json'\)[^\r\n]*\r?\n/mu, '');
    if (sha(reconstructed) !== hash) throw new Error('Adopted runner changed beyond the Skill preflight guard');
  }
  for (const row of previous.results) if (row.arm === 'baseline' && row.nativeComplete && row.grade?.results[0]?.executed && row.usage && cases.includes(row.id)) adopted.set(row.id, structuredClone(row));
}
const order = cases.flatMap((id, index) => (index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map(arm => ({ id, arm })));
const results = [], manifest = { kind: 'paired-native-arkts-comparison', createdAt: new Date().toISOString(), ownerPid: process.pid,
  model: process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL, arms, cases, order, protocol, calibrations,
  adoptedBaselines: arg('--adopt-baselines') ? { source: path.resolve(arg('--adopt-baselines')), cases: [...adopted.keys()], qualification: 'All original protocol bytes match, except the mechanically reconstructed model-free YAML preflight guard.' } : null,
  navigationArtifact, fairness: 'Identical public inputs, business tools, toolchain, budget and hidden grader. Alternating arm order. No automatic retries.' };
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ state: 'PLAN_NO_MODEL', directory, order })); process.exit(0); }
async function stage(id, arm, name, argv, timeoutMs) {
  for (const [file, hash] of Object.entries(protocol)) if (sha(await fs.readFile(file)) !== hash) throw new Error(`Protocol changed during pair: ${file}`);
  await fs.writeFile(path.join(directory, 'progress.json'), JSON.stringify({ state: 'RUNNING', ownerPid: process.pid, id, arm, stage: name, startedAt: Date.now(), results }, null, 2));
  let log = '';
  const result = await runBoundedProcess(process.execPath, argv, { cwd: process.cwd(), timeoutMs, exitDrainMs: 3000, onOutput(value) { log += value; } });
  await fs.writeFile(path.join(directory, `${id}-${arm}-${name}.log`), log);
  await fs.writeFile(path.join(directory, `${id}-${arm}-${name}.json`), JSON.stringify(result, null, 2));
  return result;
}
try {
  for (const { id, arm } of order) {
    if (arm === 'baseline' && adopted.has(id)) { results.push(adopted.get(id)); continue; }
    const run = path.join(directory, `${id}-${arm}`), grade = path.join(directory, `${id}-${arm}-grade`), settings = arms[arm];
    const execution = await stage(id, arm, 'model', ['scripts/run-arkts-rc-case.mjs', '--live', `--case=${id}`, `--artifact=${settings.artifact}`,
      `--baseline-ref=${settings.ref}`, `--navigation-artifact=${navigationArtifact}`, `--host-root=${hostRoot}`, `--output=${run}`], 1100000);
    const native = await fs.readFile(path.join(run, 'result.json'), 'utf8').then(JSON.parse, () => null);
    const row = { id, arm, run, modelExit: execution.exitCode, modelInterrupted: execution.interrupted, nativeComplete: native?.infrastructureComplete === true };
    results.push(row);
    if (native?.infrastructureComplete) {
      const scored = await stage(id, arm, 'grade', ['scripts/calibrate-arkts-bench.mjs', `--case=${id}`, `--candidate=${path.join(run, 'candidate.patch')}`,
        `--calibration-dir=${calibrations[id]}`, `--output=${grade}`], 400000);
      row.gradeExit = scored.exitCode;
      row.grade = await fs.readFile(path.join(grade, 'results.json'), 'utf8').then(JSON.parse, () => null);
      await stage(id, arm, 'usage', ['scripts/summarize-arkts-run.mjs', `--run=${run}`], 30000);
      row.usage = await fs.readFile(path.join(run, 'usage-summary.json'), 'utf8').then(JSON.parse, () => null);
    }
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ ...manifest, state: 'PARTIAL', results }, null, 2));
    console.log(JSON.stringify({ id, arm, nativeComplete: row.nativeComplete, executed: row.grade?.results[0]?.executed,
      resolved: row.grade?.results[0]?.resolved, totalTokens: row.usage?.totals.totalTokens }));
    if (!native?.infrastructureComplete || execution.interrupted) throw new Error('Model infrastructure did not settle; preserve state and investigate before further model spend');
  }
  await fs.writeFile(path.join(directory, 'progress.json'), JSON.stringify({ state: 'SETTLED', ownerPid: process.pid, endedAt: Date.now(), results: results.map(({ id, arm, nativeComplete }) => ({ id, arm, nativeComplete })) }, null, 2));
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ ...manifest, state: 'SETTLED', results }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(directory, 'progress.json'), JSON.stringify({ state: 'NEEDS_ATTENTION', ownerPid: process.pid, reason: error.message, results }, null, 2));
  throw error;
}
