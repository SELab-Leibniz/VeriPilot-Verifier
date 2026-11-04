// Calibrate only the evaluator. No model is called; gold is never a candidate
// fix. A single object cache per upstream repo is reused by detached worktrees.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { shortArktsWorkspace } from './bench/short-workspace.mjs';
import { loadArktsTask, arktsAgentInput, digest } from './bench/arkts-dataset.mjs';
import { parseHypium, gradeArkts } from './bench/hypium-results.mjs';
import { arktsRunProfile } from './bench/arkts-run-profile.mjs';
const args = process.argv.slice(2), arg = key => args.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const runProfile = arktsRunProfile(arg('--phase-timeout-ms'));
const gitExecutable = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const candidate = arg('--candidate') ? await fs.realpath(arg('--candidate')) : null;
const dataset = path.resolve(arg('--dataset') ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench');
const id = arg('--case') ?? 'happyword_12', toolRoot = path.resolve(arg('--tool-root') ?? 'C:/Program Files/Huawei/command-line-tools');
const output = path.resolve(arg('--output') ?? `.runtime-correction/system-optimization/calibration/${id}-${Date.now()}`);
const cacheRoot = path.resolve(arg('--cache') ?? '.runtime-correction/system-optimization/source-cache');
const { task, datasetDigest } = await loadArktsTask(dataset, id);
await fs.mkdir(output, { recursive: false });
await fs.writeFile(path.join(output, 'agent-input.json'), JSON.stringify(arktsAgentInput(task), null, 2));
async function run(command, argv, cwd, name, timeoutMs = runProfile.explicit ? runProfile.setupTimeoutMs : 180000) {
  if (command === 'git') { command = gitExecutable;
    if (arg('--git-proxy')) argv = ['-c', `http.proxy=${arg('--git-proxy')}`, ...argv]; }
  const start = Date.now();
  let text = '';
  const result = await runBoundedProcess(command, argv, { cwd, timeoutMs, onOutput(value) { text += value; } });
  await fs.writeFile(path.join(output, `${name}.log`), text);
  const metadata = { command, argv, code: result.exitCode, timedOut: result.interrupted || !result.outputComplete,
    reason: result.reason, outputComplete: result.outputComplete, durationMs: Date.now() - start };
  await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify(metadata, null, 2));
  return { ...metadata, text };
}
const cache = path.join(cacheRoot, task.repo.replace('/', '--') + '.git');
await fs.mkdir(cacheRoot, { recursive: true });
if (!await fs.stat(cache).catch(() => null)) {
  const init = await run('git', ['init', '--bare', cache], output, 'git-init');
  if (init.code) throw new Error('Source cache initialization failed');
}
// Fetch exact shallow base, no PR refs or gold commit.
const cached = await run('git', ['--git-dir', cache, 'cat-file', '-e', `${task.base_commit}^{commit}`], output, 'base-cache-check');
if (cached.code) {
  const fetch = await run('git', ['-c', 'core.longpaths=true', '--git-dir', cache, 'fetch', '--no-tags', '--depth=1', `https://github.com/${task.repo}.git`, task.base_commit], output, 'fetch-base');
  if (fetch.code) throw new Error('Exact upstream base fetch failed');
}
// An exact-SHA fetch only writes FETCH_HEAD. Retain each known base as a ref so
// future fetch negotiation can reuse its objects rather than downloading the
// same tree repeatedly. These refs never enter business-agent tools.
const retained = await run('git', ['--git-dir', cache, 'update-ref', `refs/rc-bench/base/${task.base_commit}`, task.base_commit], output, 'retain-base');
if (retained.code) throw new Error('Could not retain shared base objects');
const source = shortArktsWorkspace(output, 'grd', arg('--workspace-base'), arg('--workspace-root'));
await fs.mkdir(path.dirname(source), { recursive: true });
const checkout = await run('git', ['-c', 'core.longpaths=true', '--git-dir', cache, 'worktree', 'add', '--detach', source, task.base_commit], output, 'checkout');
if (checkout.code) throw new Error('Shared source worktree creation failed');
const testPatch = path.join(output, 'hidden-test.patch'); await fs.writeFile(testPatch, task.test_patch);
const apply = await run('git', ['-c', 'core.longpaths=true', 'apply', '--whitespace=nowarn', testPatch], source, 'apply-tests');
if (apply.code) throw new Error('Hidden test patch did not apply to the exact base');
const json5Location = arg('--json5-package') ?? path.join(process.env.APPDATA ?? '', 'npm/node_modules/@deveco/deveco-cli/package.json');
const json5 = createRequire(json5Location)('json5');
const profilePath = path.join(source, 'build-profile.json5'), originalProfile = await fs.readFile(profilePath, 'utf8');
const profile = json5.parse(originalProfile);
// Explicit compatibility adaptation, identical for before and after. API 23
// fixtures are reported as API24-adapted, never as exact original environments.
profile.app.signingConfigs = [];
for (const product of profile.app.products) { delete product.signingConfig; product.targetSdkVersion = '6.1.1(24)'; product.compatibleSdkVersion = '6.1.1(24)'; }
await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));
const environment = { requestedSdk: task.version, actualSdk: 'API24 / 6.1.1.125', hvigor: '6.24.2',
  adapted: task.version !== 'api-24', changes: ['build-profile signing configuration removed', 'target/compatible SDK API24'],
  originalProfileSha256: digest(originalProfile), adaptedProfileSha256: digest(await fs.readFile(profilePath)), testPatchSha256: task.test_patch_sha256, datasetDigest };
await fs.writeFile(path.join(output, 'environment.json'), JSON.stringify(environment, null, 2));
const script = fileURLToPath(new URL('./bench/run-arkts-toolchain.ps1', import.meta.url));
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const invoke = phase => run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Project', source, '-ToolRoot', toolRoot, '-Phase', phase], source, phase, runProfile.setupTimeoutMs);
let calibration;
if (candidate) {
  const directory = arg('--calibration-dir'); if (!directory) throw new Error('--candidate requires --calibration-dir with native base and gold evidence');
  calibration = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
  if (calibration.instanceId !== id || calibration.environment.datasetDigest !== datasetDigest) throw new Error('Calibration identity mismatch');
  for (const phase of ['base', 'gold']) {
    const original = calibration.results.find(row => row.phase === phase);
    const parsed = parseHypium(await fs.readFile(path.join(directory, `${phase}-coverage.log`), 'utf8'));
    const checked = gradeArkts(task, parsed, original.execution);
    if (!(phase === 'base' ? checked.validFailToPassBase : checked.resolved)) throw new Error(`Calibration does not establish ${phase}`);
  }
  await fs.copyFile(candidate, path.join(output, 'candidate.patch'));
  if ((await fs.stat(candidate)).size > 0) {
  const checked = await run('git', ['apply', '--numstat', '-z', candidate], source, 'candidate-paths');
  if (checked.code) throw new Error('Candidate patch metadata invalid');
  const segments = checked.text.split('\0').filter(Boolean), paths = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment.includes('\t')) { paths.push(segment); continue; }
    const file = segment.split('\t').slice(2).join('\t');
    if (file) paths.push(file); else paths.push(segments[++index], segments[++index]);
  }
  if (paths.some(file => !file || /(?:^|\/)(?:\.git|\.runtime-correction|\.runtime-corrector)(?:\/|$)/u.test(file))) throw new Error('Candidate modifies evaluator/control scope');
  // Keep the full model patch for audit, but evaluator-owned test bodies stay
  // exactly the base + test_patch. Updating a legitimate original project test
  // is allowed business work and cannot rewrite the hidden scoring oracle.
  const testExcludes = ['*/src/test/*', '*/src/ohosTest/*', '*/tests/*', 'tests/*', '*.test.ets', '*.spec.ets', '*.test.mjs', '*.test.ts', '*.test.js'];
  const applied = await run('git', ['apply', '--whitespace=nowarn', ...testExcludes.map(pattern => `--exclude=${pattern}`),
    path.join(output, 'candidate.patch')], source, 'apply-candidate');
  if (applied.code) throw new Error('Candidate patch does not apply in the common prepared environment');
  } else await fs.writeFile(path.join(output, 'empty-candidate.json'), JSON.stringify({ noEdits: true, meaning: 'Evaluate the unchanged common base with hidden tests; no failure is silently dropped.' }));
}
const install = await invoke('install'); if (install.code || install.timedOut) throw new Error('CLT dependency installation failed; see local install.log');
const coverage = path.join(source, 'entry/.test/default/intermediates/test/coverage_data/coverage.log');
const results = [];
for (const phase of candidate ? ['candidate'] : ['base', 'gold']) {
  if (phase === 'gold') {
    const patch = path.join(output, 'evaluator-gold.patch'); await fs.writeFile(patch, task.patch);
    const apply = await run('git', ['-c', 'core.longpaths=true', 'apply', '--whitespace=nowarn', patch], source, 'apply-evaluator-gold');
    if (apply.code) throw new Error('Evaluator-only gold patch failed to apply');
  }
  // Remove this exact old report file, never a directory, so a crashed test
  // cannot inherit the preceding phase's PASS.
  await fs.rm(coverage, { force: true });
  const start = Date.now(), execution = await invoke('test');
  await fs.rename(path.join(output, 'test.log'), path.join(output, `${phase}-test.log`));
  await fs.rename(path.join(output, 'test.json'), path.join(output, `${phase}-test.json`));
  const stat = await fs.stat(coverage).catch(() => null), fresh = stat && stat.mtimeMs >= start - 2000;
  const raw = fresh ? await fs.readFile(coverage, 'utf8') : '';
  await fs.writeFile(path.join(output, `${phase}-coverage.log`), raw);
  const parsed = parseHypium(raw);
  const grade = gradeArkts(task, parsed, { code: execution.code, timedOut: execution.timedOut,
    compileSucceeded: /Finished :entry:.*@UnitTestArkTS/u.test(execution.text), freshReport: Boolean(fresh), durationMs: execution.durationMs });
  results.push({ phase, ...grade });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ kind: candidate ? 'hidden-test-candidate-grade' : 'evaluator-calibration-no-agent',
    instanceId: id, baseCommit: task.base_commit, workspace: source, environment, ...(candidate ? { candidateSha256: digest(await fs.readFile(candidate)), calibrationDirectory: path.resolve(arg('--calibration-dir')) } : {}), results }, null, 2));
  console.log(JSON.stringify({ phase, executed: grade.executed, f2p: `${grade.f2p.passed.length}/${grade.f2p.expected}`, p2p: `${grade.p2p.passed.length}/${grade.p2p.expected}`, errors: grade.runtimeErrors.length, validBase: grade.validFailToPassBase, resolved: grade.resolved }));
}
process.exitCode = candidate ? results[0]?.resolved ? 0 : 1 : results[0]?.validFailToPassBase && results[1]?.resolved ? 0 : 1;
