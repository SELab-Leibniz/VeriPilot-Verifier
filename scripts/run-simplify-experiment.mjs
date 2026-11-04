#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { simplifySchedule } from './simplify-experiment-schedule.mjs';
import { countProfileCredentialMatches, loadPackaged, readProviderTiming, redactEvaluationText, resolveSimplifyProvider,
  supportsSimplifyModel } from './helpers/simplify-native-evaluation.mjs';
import { validateCompactionSettings } from './evaluate-simplify-compaction.mjs';
import { summarizeSimplifyExperiment } from './summarize-simplify-experiment.mjs';
import { arktsHiddenReward, readArktsComparisonInputs } from './bench/simplify-arkts-inputs.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { shortArktsWorkspace } from './bench/short-workspace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
let scanStage;

const needsRetry = record => record.state === 'rate-limited' || record.frameworkError === true;
const optionalJson = file => readJson(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function readResume(directory, schedule, identity) {
  const batches = [], seen = new Set();
  while (directory) {
    directory = await fs.realpath(directory);
    if (seen.has(directory)) throw new Error('Repeated resume batch directory.');
    seen.add(directory);
    const manifest = await readJson(path.join(directory, 'batch.json'));
    if (Object.entries(identity).some(([key, value]) => JSON.stringify(manifest[key]) !== JSON.stringify(value))
      || sha256(await fs.readFile(path.join(directory, 'integration.tgz'))) !== identity.artifactSha256)
      throw new Error('Resume batch identity differs from the plan, package, provider or host.');
    const scan = await readJson(path.join(directory, 'leak-scan.json'));
    if (scan.matches !== 0) throw new Error(`Credential scan matches: ${scan.matches}.`);
    batches.unshift({ directory, manifest });
    directory = manifest.resumeFrom;
  }
  const records = [], retries = new Map();
  for (const { directory, manifest } of batches) {
    if (!manifest.schedule?.length || manifest.schedule.some((slot, index) =>
      JSON.stringify(slot) !== JSON.stringify(schedule[records.length + index]))) throw new Error('Resume schedule does not match the planned run order.');
    let interrupted = false;
    for (const slot of manifest.schedule) {
      const attemptRoot = path.join(directory, slot.id);
      const attempt = await optionalJson(path.join(attemptRoot, 'attempt.json'));
      const record = await optionalJson(path.join(attemptRoot, 'observation.json'));
      if (!attempt && !record) { interrupted = true; continue; }
      if (interrupted || !attempt || !record || [attempt, record].some(row => row.id !== slot.id || row.arm !== slot.arm
        || row.sample !== slot.sample || row.repeat !== slot.repeat || row.artifactSha256 !== identity.artifactSha256
        || (row.planSha256 !== undefined && row.planSha256 !== identity.planSha256)))
        throw new Error(`Resume evidence is incomplete or inconsistent for ${slot.id}.`);
      if (needsRetry(record)) {
        if (record.state !== 'rate-limited') retries.set(slot.id, (retries.get(slot.id) ?? 0) + 1);
        interrupted = true;
      } else records.push(record);
    }
  }
  if (retries.get(schedule[records.length]?.id) >= 3) throw new Error('Infrastructure retry cap reached for the next scheduled run.');
  return records;
}

async function writeProgress(file, round, records, total, latest) {
  if (!file) return;
  const average = records.length ? records.reduce((sum, row) => sum + row.wallMs, 0) / records.length : null;
  const minutes = average === null ? null : Math.ceil(average * (total - records.length) / 60_000);
  const details = latest.reason ? redactEvaluationText(latest.reason).replace(/\s+/gu, ' ').slice(0, 250) : '无';
  await fs.writeFile(file, ['# RC Stop 对照进度', '', `- 当前步骤　${round === '1' ? '第一轮' : round === 'C' ? 'C 正式对照' : round}`,
    `- 已完成序号　${records.length}/${total}`, `- 最近一次　${latest.id} / ${latest.state}`, `- 限流或错误　${details}`,
    `- 本阶段剩余墙钟粗估　${minutes === null ? '待估' : `约 ${minutes} 分钟`}`, ''].join('\n'));
}

async function runProcess(script, args, { executable = process.execPath, timeoutMs } = {}) {
  const child = spawn(executable, [path.join(root, script), ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Persist the original evaluator files; only bounded, redacted progress is relayed.
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
  return await new Promise(resolve => {
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, reason: redactEvaluationText(error.message), timedOut }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ...(stderr ? { reason: redactEvaluationText(stderr) } : {}) });
    });
  });
}

function verifyArchive(file) {
  const listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8', windowsHide: true });
  if (!listing.split(/\r?\n/u).filter(Boolean).every(name => /^package\//u.test(name)
    && !/[:\\]/u.test(name) && !name.split('/').includes('..'))) throw new Error('Unexpected path in the integration npm package.');
  const details = execFileSync('tar', ['-tvf', file], { encoding: 'utf8', windowsHide: true });
  if (details.split(/\r?\n/u).filter(Boolean).some(line => !/^[-d]/u.test(line))) throw new Error('Package entries must be regular files or directories.');
}

async function runScreening(slot, context) {
  const { hostRoot, model, packageRoot, artifactSha256, directory, providerIdentity, profileArgs } = context;
  const output = path.join(directory, 'evaluation');
  const process = await runProcess(slot.entrypoints[0], ['--live', '--transport', 'native', '--engine', 'workspace', '--production',
    '--case', slot.sample, '--host-root', hostRoot, '--output-root', output, '--simplify-arm', slot.arm,
    '--simplify-model', model, '--simplify-provider', providerIdentity.kind, '--simplify-plugin-root', packageRoot, '--simplify-package-sha256', artifactSha256, ...profileArgs]);
  const evidence = path.join(output, 'results.json');
  const result = await readJson(evidence).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const raw = result?.records?.[0];
  if (!raw) return { state: 'failed', evidence: directory, reason: process.reason ?? `Evaluator exited with ${process.code}.`, completedInBudget: false, frameworkError: true };
  if (raw.case !== slot.sample || raw.simplify?.arm !== slot.arm || raw.simplify.artifactSha256 !== artifactSha256
    || (raw.simplify.providerIdentity || raw.simplify.state === 'completed') && JSON.stringify(raw.simplify.providerIdentity) !== JSON.stringify(providerIdentity))
    throw new Error(`Evaluator identity mismatch for ${slot.id}.`);
  const { state, repairFeedback, feedback, completedInBudget, rcElapsedMs, reason, usage, configurationSummary, frameworkError } = raw.simplify;
  return { state, repairFeedback, feedback, completedInBudget, elapsedMs: raw.elapsedMs, rcElapsedMs, reason, usage, configurationSummary, evidence, frameworkError };
}

async function runCompaction(slot, context) {
  const { hostRoot, model, packageRoot, artifactSha256, directory, requirements, settingsFile, providerIdentity, profileArgs } = context;
  const output = path.join(directory, 'evaluation');
  const child = await runProcess('scripts/evaluate-simplify-compaction.mjs', ['--live', '--arm', slot.arm,
    '--requirements', requirements, '--settings', settingsFile, '--output', output,
    '--artifact', packageRoot, '--artifact-sha256', artifactSha256, '--host-root', hostRoot, '--model', model,
    '--provider', providerIdentity.kind, ...profileArgs], { timeoutMs: 30 * 60_000 });
  const evidence = path.join(output, 'result.json');
  const raw = await readJson(evidence).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!raw) return { state: child.timedOut ? 'timed-out' : 'failed', evidence: directory,
    reason: child.reason ?? `Compaction evaluator exited with ${child.code}.`, completedInBudget: false, frameworkError: !child.timedOut };
  if (raw.arm !== slot.arm || raw.artifactSha256 !== artifactSha256 || raw.model !== model
    || JSON.stringify(raw.providerIdentity) !== JSON.stringify(providerIdentity))
    throw new Error(`Compaction evaluator identity mismatch for ${slot.id}.`);
  const { state, completedInBudget, elapsedMs, reason, usage, configurationSummary, compaction, frameworkError } = raw;
  return { state, completedInBudget, elapsedMs, reason, usage, configurationSummary, compaction, frameworkError, turns: raw.turns, evidence };
}

async function runSmoke(_slot, { directory, packageRoot, hostRoot, model, profileArgs, providerIdentity }) {
  const output = path.join(directory, 'evaluation');
  const child = await runProcess('scripts/evaluate-simplify-model-smoke.mjs', ['--output', output, '--artifact', packageRoot,
    '--host-root', hostRoot, '--model', model, ...profileArgs], { timeoutMs: 90000 });
  const evidence = path.join(output, 'result.json');
  const raw = await readJson(evidence).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!raw) return { state: child.timedOut ? 'timed-out' : 'failed', evidence: directory, reason: child.reason ?? 'Smoke evaluator did not write a result.' };
  if (raw.state === 'completed' && JSON.stringify(raw.providerIdentity) !== JSON.stringify(providerIdentity))
    throw new Error('Smoke evaluator provider identity mismatch.');
  return { ...raw, evidence };
}

async function runBenchmark(slot, context) {
  const { hostRoot, model, archive, directory, benchmark, arkts, openclawProfile, providerIdentity } = context;
  const output = path.join(directory, 'evaluation');
  const options = { case: benchmark.case, output, 'host-root': hostRoot, package: archive, 'simplify-arm': slot.arm,
    provider: 'host-profile', model, 'openclaw-profile': openclawProfile, 'plan-sha256': arkts.planSha256,
    frozen: benchmark.frozenRoot, 'freeze-sha256': benchmark.freezeSha256, ...arkts.cli };
  const cli = values => Object.entries(values).map(([key, value]) => `--${key}=${value}`);
  const controller = await runBoundedProcess(process.execPath, [path.join(root, slot.entrypoints[0]), '--live', ...cli(options)],
    { cwd: root, timeoutMs: 65 * 60_000 });
  const evidence = path.join(output, 'result.json');
  const raw = await optionalJson(evidence);
  if (!raw) {
    const timedOut = controller.reason === 'deadline';
    return { state: timedOut ? 'timed-out' : 'failed', evidence: directory, frameworkError: !timedOut, repairFeedback: null,
      reason: timedOut ? 'ARKTS_WALL_DEADLINE' : redactEvaluationText(controller.tail || controller.reason), completedInBudget: false };
  }
  if (raw.simplifyArm !== slot.arm || raw.instanceId !== benchmark.case || raw.datasetDigest !== benchmark.datasetDigest
    || raw.freezeSha256 !== benchmark.freezeSha256 || raw.artifactSha256 !== context.artifactSha256 || raw.planSha256 !== arkts.planSha256
    || JSON.stringify(raw.providerIdentity) !== JSON.stringify(providerIdentity))
    throw new Error(`ArkTS Stop identity differs for ${slot.id}.`);
  const { state, repairFeedback, feedback, completedInBudget, elapsedMs, rcElapsedMs, reason, usage, totalUsage, baselineCost, frameworkError } = raw;
  let after = null, gradingEvidence = null, gradingError = null;
  if (!frameworkError && state !== 'rate-limited') {
    const candidate = path.join(output, 'candidate.patch');
    const gradeRoot = path.join(directory, 'grading');
    const grader = await runProcess(slot.entrypoints[1], cli({ ...arkts.cli, case: benchmark.case, output: gradeRoot,
      candidate, 'calibration-dir': benchmark.calibrationDir }));
    gradingEvidence = path.join(gradeRoot, 'results.json');
    after = arktsHiddenReward(await optionalJson(gradingEvidence), sha256(await fs.readFile(candidate)), benchmark.case, benchmark.datasetDigest);
    if (!after) gradingError = grader.reason ?? 'No complete, attributable hidden score.';
  }
  return { state, repairFeedback, feedback, completedInBudget, elapsedMs, rcElapsedMs, reason, usage, totalUsage, baselineCost, frameworkError,
    official: { before: benchmark.before, after }, evidence, gradingEvidence, gradingError,
    configurationSummary: JSON.stringify({ ...slot.config, model, provider: providerIdentity, freezeSha256: benchmark.freezeSha256,
      phaseTimeoutMs: raw.limits.phaseTimeoutMs, maxCorrections: raw.limits.correctionAdmissions, compactionRestore: false }) };
}

async function main() {
  const { values } = parseArgs({ options: {
    round: { type: 'string' }, 'plan-sha256': { type: 'string' }, package: { type: 'string' }, 'package-sha256': { type: 'string' },
    'host-root': { type: 'string' }, 'output-root': { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean' },
    requirements: { type: 'string' }, settings: { type: 'string' }, calibration: { type: 'string' },
    'round-one': { type: 'string' }, 'round-two-inputs': { type: 'string' }, provider: { type: 'string', default: 'coding-plan' },
    'openclaw-profile': { type: 'string' }, limit: { type: 'string' },
    'resume-from': { type: 'string' }, 'progress-file': { type: 'string' },
    'round-two-inputs-sha256': { type: 'string' }, dataset: { type: 'string' }, 'tool-root': { type: 'string' },
    cache: { type: 'string' }, 'workspace-root': { type: 'string' }, 'json5-package': { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/run-simplify-experiment.mjs --round <1|2|C-calibration|C|model-smoke> --plan-sha256 <approved plan SHA256> --package <integration tgz> --package-sha256 <SHA256> --host-root <installed OpenClaw> --model <glm-5.3|glm-5.3-flash|deepseek-v4-flash> --output-root <new directory>');
    console.log('Both C modes also need --requirements <kitchen/requirements.md> and --settings <isolated compaction JSON>. Formal C requires --calibration <completed calibration result.json>.');
    console.log('Round 2 needs --round-one, --round-two-inputs, --round-two-inputs-sha256, --dataset, --tool-root, --cache, --workspace-root and --json5-package.');
    console.log('Use RC_EVAL_API_KEY in the process environment for the default Coding Plan. Round 1 and C can instead use --provider anthropic-environment with the configured Ark endpoint and model.');
    console.log('Each isolated attempt is immutable. Grade actual repair feedback from the evidence file before summarizing.');
    console.log('DeepSeek uses --provider host-profile --openclaw-profile <openclaw.json>. Round 1 accepts --limit <first N scheduled runs>.');
    console.log('Use --resume-from <previous batch directory> and --progress-file <progress.md> for scored DeepSeek runs.');
    return;
  }
  if (!['1', '2', 'C-calibration', 'C', 'model-smoke'].includes(values.round) || !values.package || !values['host-root'] || !values['output-root']
    || !supportsSimplifyModel(values.provider, values.model, values['openclaw-profile'])) throw new Error('Choose the round and provide package, host root, model and fresh output root.');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (values.round !== '1' || !Number.isSafeInteger(limit) || limit < 1 || limit > simplifySchedule('1').length))
    throw new Error('A positive scheduled prefix is only supported for round 1.');
  if (values.round === 'model-smoke' && values.provider !== 'host-profile') throw new Error('Model smoke uses the custom DeepSeek route.');
  if (values['resume-from'] && (!['1', '2', 'C'].includes(values.round) || values.provider !== 'host-profile'))
    throw new Error('Resume requires a scored DeepSeek batch.');
  if (sha256(await fs.readFile(path.join(root, 'docs/simplify-experiment-plan.md'))) !== values['plan-sha256'])
    throw new Error('The approved plan SHA256 differs from the current plan.');
  if (values.round === '2' && values.provider !== 'host-profile') throw new Error('Round 2 uses the pinned DeepSeek host profile.');
  const { identity: providerIdentity, credential } = await resolveSimplifyProvider(values.provider, values.model, values['openclaw-profile']);
  const profileArgs = values['openclaw-profile'] ? ['--openclaw-profile', path.resolve(values['openclaw-profile'])] : [];
  const archive = await fs.realpath(values.package), archiveBytes = await fs.readFile(archive);
  const artifactSha256 = sha256(archiveBytes);
  if (artifactSha256 !== values['package-sha256']) throw new Error('Integration package SHA256 mismatch.');
  const hostRoot = await fs.realpath(values['host-root']);
  const host = await readJson(path.join(hostRoot, 'package.json'));
  if (host.name !== 'openclaw' || host.version !== '2026.7.1-2') throw new Error('Use the pinned OpenClaw 2026.7.1-2 host.');
  const cMode = values.round.startsWith('C');
  let roundOne, promoted, arkts;
  if (values.round === '2') {
    const localOptions = ['dataset', 'tool-root', 'cache', 'workspace-root', 'json5-package'];
    if (['round-one', 'round-two-inputs', 'round-two-inputs-sha256', ...localOptions].some(key => !values[key]))
      throw new Error('Round 2 needs graded first-round records, pinned frozen inputs and explicit local paths.');
    roundOne = await readJson(values['round-one']);
    const screening = summarizeSimplifyExperiment(roundOne).round1;
    if (!screening.ready || !screening.promotions?.length) throw new Error('Round 1 has not produced a scored candidate for round 2.');
    if (roundOne.records.some(record => record.artifactSha256.toLowerCase() !== artifactSha256
      || record.planSha256 && record.planSha256 !== values['plan-sha256']))
      throw new Error('Round 2 requires the same package and plan as all four first-round arms.');
    promoted = screening.promotions;
    const inputs = await readArktsComparisonInputs({ file: values['round-two-inputs'], sha256: values['round-two-inputs-sha256'],
      planSha256: values['plan-sha256'], artifactSha256, dataset: values.dataset });
    const cli = { ...Object.fromEntries(localOptions.map(key => [key, path.resolve(values[key])])), 'phase-timeout-ms': 600_000 };
    arkts = { ...inputs, cli };
  }
  let requirements, settings, calibration;
  if (cMode) {
    if (!values.requirements || !values.settings || values.round === 'C' && !values.calibration)
      throw new Error('C needs requirements and settings. Formal runs need a successful calibration.');
    requirements = await fs.realpath(values.requirements);
    settings = validateCompactionSettings(await readJson(values.settings));
    if (values.round === 'C') {
      calibration = await readJson(values.calibration);
      if (calibration.state !== 'completed' || calibration.arm !== 'calibration' || calibration.model !== values.model
        || calibration.artifactSha256 !== artifactSha256 || !Number.isFinite(calibration.compaction?.firstCompactedAt)
        || JSON.stringify(calibration.settings) !== JSON.stringify(settings)
        || JSON.stringify(calibration.providerIdentity) !== JSON.stringify(providerIdentity)) throw new Error('Formal C inputs differ from the successful calibration.');
    }
  }
  const identity = { planSha256: values['plan-sha256'], artifactSha256, model: values.model, providerIdentity, hostVersion: host.version,
    ...(arkts ? { roundTwoInputsSha256: values['round-two-inputs-sha256'], arktsCli: arkts.cli } : {}),
    ...(values.round === 'C' ? { requirementsSha256: sha256(await fs.readFile(requirements)), compactionSettings: settings } : {}) };
  const resumeFrom = values['resume-from'] ? await fs.realpath(values['resume-from']) : null;
  const fullSchedule = values.round === 'model-smoke' ? [{ id: 'smoke', scored: false, config: {} }]
    : values.round === 'C-calibration' ? [{ id: 'calibration', arm: 'calibration', sample: 'kitchen-compaction',
      timeoutMs: 30 * 60_000, config: { originalRequirementsEnabled: true, compactionRestore: false, scored: false } }]
      : simplifySchedule(values.round, promoted, arkts?.samples);
  const records = resumeFrom ? await readResume(resumeFrom, fullSchedule, identity) : [];
  const schedule = fullSchedule.slice(records.length, limit);
  if (!schedule.length) throw new Error('No remaining scheduled runs in this batch.');
  const output = path.resolve(values['output-root']);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  const businessRoots = [];
  if (credential) scanStage = async () => {
    scanStage = undefined;
    let matches = await countProfileCredentialMatches(output, credential);
    for (const directory of businessRoots) matches += await countProfileCredentialMatches(directory, credential)
      .catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
    await writeJson(path.join(output, 'leak-scan.json'), { matches });
    if (matches) throw new Error(`Credential scan matches: ${matches}.`);
  };
  const isolatedArchive = path.join(output, 'integration.tgz');
  await fs.writeFile(isolatedArchive, archiveBytes, { flag: 'wx' });
  verifyArchive(isolatedArchive);
  execFileSync('tar', ['-xf', isolatedArchive, '-C', output], { windowsHide: true, stdio: 'pipe' });
  const packageRoot = path.join(output, 'package'), model = values.model;
  const { compileRuntimeV2Config } = await loadPackaged(packageRoot, 'lib/runtime-v2/config.mjs');
  const enabled = compileRuntimeV2Config({ version: 2, stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true },
    compactionRestore: { enabled: true } });
  if (!enabled.stopCorrection.originalRequirementsBasis || !enabled.stopCorrection.deviationOnly || !enabled.compactionRestore?.enabled)
    throw new Error('Use the integration package containing all three approved switches.');
  const settingsFile = cMode ? path.join(output, 'compaction-settings.json') : null;
  if (cMode) await writeJson(settingsFile, settings);
  await writeJson(path.join(output, 'batch.json'), { ...identity, schedule, ...(resumeFrom ? { resumeFrom } : {}) });
  let attempted = 0;
  for (const slot of schedule) {
    const startedAt = Date.now();
    const directory = path.join(output, slot.id);
    await fs.mkdir(directory);
    await writeJson(path.join(directory, 'attempt.json'), { ...slot, startedAt: new Date().toISOString(), artifactSha256, planSha256: identity.planSha256 });
    const businessRoot = arkts ? shortArktsWorkspace(path.join(directory, 'evaluation'), 'biz', undefined, arkts.cli['workspace-root']) : null;
    if (businessRoot) businessRoots.push(businessRoot);
    let result;
    const context = { hostRoot, model, packageRoot, artifactSha256, directory, requirements, settingsFile, providerIdentity,
      profileArgs, archive, openclawProfile: values['openclaw-profile'], arkts, benchmark: arkts?.samples.find(sample => sample.id === slot.sample) };
    const run = values.round === 'model-smoke' ? runSmoke : cMode ? runCompaction : arkts ? runBenchmark : runScreening;
    try { result = await run(slot, context); }
    catch (error) { result = { state: 'failed', evidence: directory, reason: redactEvaluationText(error.message), completedInBudget: false, frameworkError: true }; }
    if (credential) {
      const evaluation = path.join(directory, 'evaluation');
      // The Stop evaluator keeps each sample's native Gateway in a neutral subdirectory.
      const samples = values.round === '1' ? (await fs.readdir(evaluation, { withFileTypes: true })
        .catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
        .filter(entry => entry.isDirectory() && entry.name.startsWith('sample-')) : [];
      const nativeRun = samples.length === 1 ? path.join(evaluation, samples[0].name) : evaluation;
      const readOptional = file => readJson(path.join(nativeRun, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const boundary = await readOptional('provider-boundary.json');
      result.gatewayStarts = (await readOptional('gateway-start.json'))?.starts ?? 0;
      result.modelRequests = boundary?.requests ?? (await readProviderTiming(path.join(nativeRun, 'native-host'))).filter(row => row.event === 'request').length;
      if (boundary?.failure) Object.assign(result, { state: boundary.failure === 'PROFILE_RATE_LIMIT' ? 'rate-limited' : 'failed',
        reason: boundary.failure, completedInBudget: false, frameworkError: true });
    }
    const record = { id: slot.id, arm: slot.arm, sample: slot.sample, repeat: slot.repeat, artifactSha256, planSha256: identity.planSha256,
      configurationSummary: JSON.stringify({ ...slot.config, model, provider: providerIdentity }), ...result, wallMs: Date.now() - startedAt };
    await writeJson(path.join(directory, 'observation.json'), record);
    attempted++;
    if (!needsRetry(record)) records.push(record);
    console.log(JSON.stringify({ id: slot.id, state: record.state }));
    if (credential && (await countProfileCredentialMatches(directory, credential) || businessRoot
      && await countProfileCredentialMatches(businessRoot, credential).catch(error => { if (error.code === 'ENOENT') return 0; throw error; }))) break;
    await writeProgress(values['progress-file'], values.round, records, fullSchedule.length, record);
    if (needsRetry(record)) break;
  }
  if (values.round === 'C') {
    const blind = records.filter(record => record.compaction?.answer).map(record => ({ blindId: randomUUID(), runId: record.id,
      answer: record.compaction.answer })).sort((left, right) => left.blindId.localeCompare(right.blindId));
    await writeJson(path.join(output, 'answers-blind.json'), blind.map(({ blindId, answer }) => ({ blindId, answer })));
    await writeJson(path.join(output, 'answers-index.json'), blind.map(({ blindId, runId }) => ({ blindId, runId })));
  }
  if (values.round !== 'C-calibration' && values.round !== 'model-smoke')
    await writeJson(path.join(output, 'observations.json'), { records, ...(arkts ? { promoted, roundTwoInputs: { s0: arkts.s0, samples: arkts.samples } } : {}) });
  await scanStage?.();
  if (values.round === 'C-calibration' || values.round === 'model-smoke') {
    if (records[0]?.state !== 'completed') process.exitCode = 1;
    return;
  }
  if (attempted < schedule.length || records.length < (limit ?? fullSchedule.length) || records.some(record => record.state !== 'completed')) process.exitCode = 1;
}

await main().catch(async error => {
  try { await scanStage?.(); } catch (scanError) { console.error(redactEvaluationText(scanError.message)); }
  console.error(redactEvaluationText(error.message)); process.exitCode = 1;
});
