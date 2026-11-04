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

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
let scanStage;
const benchmarkTasks = { 'etree-deepequal-injected': 'etree-xml-diff-patch', 'httpx-frozen': 'httpx-multipart-response-parsing',
  'etree-frozen': 'etree-xml-diff-patch', 'narwhals-frozen': 'narwhals-rolling-window-suite' };

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
    reason: child.reason ?? `Compaction evaluator exited with ${child.code}.`, completedInBudget: false };
  if (raw.arm !== slot.arm || raw.artifactSha256 !== artifactSha256 || raw.model !== model
    || JSON.stringify(raw.providerIdentity) !== JSON.stringify(providerIdentity))
    throw new Error(`Compaction evaluator identity mismatch for ${slot.id}.`);
  const { state, completedInBudget, elapsedMs, reason, usage, configurationSummary, compaction } = raw;
  return { state, completedInBudget, elapsedMs, reason, usage, configurationSummary, compaction, turns: raw.turns, evidence };
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

async function readRoundTwoInputs(file, model) {
  const provided = await readJson(file);
  const entries = await Promise.all(Object.entries(benchmarkTasks).map(async ([sample, task]) => {
    const input = provided[sample];
    if (!input?.preparedRoot || !/^[a-f0-9]{64}$/u.test(input.manifestSha256 ?? '')) throw new Error(`Missing pinned benchmark input ${sample}.`);
    const preparedRoot = await fs.realpath(input.preparedRoot);
    const bytes = await fs.readFile(path.join(preparedRoot, 'manifest.json'));
    const manifest = JSON.parse(bytes);
    const injected = sample === 'etree-deepequal-injected';
    if (sha256(bytes) !== input.manifestSha256 || manifest.task !== task || manifest.model !== model
      || !/^sha256:[a-f0-9]{64}$/u.test(manifest.image ?? '') || !manifest.seedCheckpoint || Boolean(manifest.injectedDefect) !== injected)
      throw new Error(`Prepared benchmark identity differs for ${sample}.`);
    const verifyInput = async (relative, expected) => {
      if (sha256(await fs.readFile(path.join(preparedRoot, 'public', relative))) !== expected)
        throw new Error(`Pinned ${relative} differs for ${sample}.`);
    };
    await verifyInput('instruction.md', manifest.instructionSha256);
    await fs.access(path.join(preparedRoot, 'public/seed-state.json'));
    let official = null;
    if (!injected) {
      if (!input.officialResult || !/^[a-f0-9]{64}$/u.test(input.officialResultSha256 ?? '')
        || !/^[a-f0-9]{64}$/u.test(manifest.frozenTranscriptSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(manifest.frozenPatchSha256 ?? ''))
        throw new Error(`Missing frozen transcript, draft or original official grade for ${sample}.`);
      await verifyInput('frozen-transcript.jsonl', manifest.frozenTranscriptSha256);
      const grade = await fs.readFile(input.officialResult);
      const { reward, patchSha256, officialVerifierModified, exitCode } = JSON.parse(grade);
      if (sha256(grade) !== input.officialResultSha256 || patchSha256 !== manifest.frozenPatchSha256 || !reward
        || officialVerifierModified !== false || exitCode !== 0)
        throw new Error(`Frozen official grade does not match the draft for ${sample}.`);
      official = { before: reward, after: null };
    } else if (!/^sha256:[a-f0-9]{64}$/u.test(manifest.verifierImage ?? '')) {
      throw new Error('Pin the original injected-sample verifier image by SHA256.');
    } else {
      await fs.access(path.join(preparedRoot, 'public/fault-spec.json'));
    }
    return [sample, { preparedRoot, manifest, manifestSha256: input.manifestSha256, injected, official }];
  }));
  return Object.fromEntries(entries);
}

async function runBenchmark(slot, context) {
  const { packageRoot, directory, benchmark } = context;
  const output = path.join(directory, 'evaluation');
  const controller = await runProcess(slot.entrypoints[0], ['--prepared-root', benchmark.preparedRoot, '--attempt', slot.id,
    '--simplify-arm', slot.arm, '--artifact-root', packageRoot, '--runner-source', root, '--run-root', output,
    ...(!benchmark.injected ? ['--verify-frozen'] : [])]);
  const evidence = path.join(output, 'result.json');
  const raw = await readJson(evidence).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const relay = await readJson(path.join(output, 'relay.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const blockedByRateLimit = !raw?.complete && relay?.requests?.some(row => row.status === 429);
  if (!raw) return { state: blockedByRateLimit ? 'rate-limited' : 'failed', evidence: directory,
    reason: controller.reason ?? `Benchmark controller exited with ${controller.code}.`, completedInBudget: false };
  if (raw.simplify?.arm !== slot.arm || (!benchmark.injected && raw.mode !== 'frozen-draft-verify-only'))
    throw new Error(`Benchmark identity mismatch for ${slot.id}.`);
  let official = benchmark.official;
  if (benchmark.injected && !blockedByRateLimit) {
    const scorer = await runProcess('scripts/grade-native-stop-benchmark.py', ['--prepared-root', benchmark.preparedRoot, '--attempt', slot.id,
      '--run-root', output, '--verifier-image', benchmark.manifest.verifierImage], { executable: process.platform === 'win32' ? 'python' : 'python3' });
    const comparison = await readJson(path.join(output, 'official-scoring/comparison.json')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    official = Object.fromEntries(['before', 'after'].map(phase => {
      const score = comparison?.rows?.find(row => row.phase === phase);
      return [phase, score?.exitCode === 0 && score.officialVerifierModified === false ? score.reward : null];
    }));
    await writeJson(path.join(directory, 'official-grading-process.json'), scorer);
  }
  const { state, repairFeedback, completedInBudget, rcElapsedMs, usage, baselineCost } = raw.simplify;
  return { state: blockedByRateLimit ? 'rate-limited' : state, repairFeedback, completedInBudget, elapsedMs: raw.elapsedMs, rcElapsedMs,
    reason: raw.reason ?? raw.error?.code ?? null, usage, baselineCost, official, evidence,
    configurationSummary: JSON.stringify({ ...slot.config, model: context.model, inputManifestSha256: benchmark.manifestSha256,
      timeoutMs: benchmark.manifest.maxRuntimeMs, maxReviewSteps: benchmark.manifest.maxReviewSteps ?? 2000,
      maxRepairSteps: benchmark.manifest.maxRepairSteps ?? 2000, maxCorrections: benchmark.manifest.correctionLimit ?? 3, compactionRestore: false }) };
}

async function main() {
  const { values } = parseArgs({ options: {
    round: { type: 'string' }, 'plan-sha256': { type: 'string' }, package: { type: 'string' }, 'package-sha256': { type: 'string' },
    'host-root': { type: 'string' }, 'output-root': { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean' },
    requirements: { type: 'string' }, settings: { type: 'string' }, calibration: { type: 'string' },
    'round-one': { type: 'string' }, 'round-two-inputs': { type: 'string' }, provider: { type: 'string', default: 'coding-plan' },
    'openclaw-profile': { type: 'string' }, limit: { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/run-simplify-experiment.mjs --round <1|2|C-calibration|C|model-smoke> --plan-sha256 <approved plan SHA256> --package <integration tgz> --package-sha256 <SHA256> --host-root <installed OpenClaw> --model <glm-5.3|glm-5.3-flash|deepseek-v4-flash> --output-root <new directory>');
    console.log('Both C modes also need --requirements <kitchen/requirements.md> and --settings <isolated compaction JSON>. Formal C requires --calibration <completed calibration result.json>.');
    console.log('Round 2 needs --round-one <graded observations JSON> and --round-two-inputs <JSON mapping each fixed sample to { preparedRoot, manifestSha256, officialResult?, officialResultSha256? }>.');
    console.log('Use RC_EVAL_API_KEY in the process environment for the default Coding Plan. Round 1 and C can instead use --provider anthropic-environment with the configured Ark endpoint and model.');
    console.log('Each isolated attempt is immutable. Grade actual repair feedback from the evidence file before summarizing.');
    console.log('DeepSeek uses --provider host-profile --openclaw-profile <openclaw.json>. Round 1 accepts --limit <first N scheduled runs>.');
    return;
  }
  if (!['1', '2', 'C-calibration', 'C', 'model-smoke'].includes(values.round) || !values.package || !values['host-root'] || !values['output-root']
    || !supportsSimplifyModel(values.provider, values.model, values['openclaw-profile'])) throw new Error('Choose the round and provide package, host root, model and fresh output root.');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (values.round !== '1' || !Number.isSafeInteger(limit) || limit < 1 || limit > simplifySchedule('1').length))
    throw new Error('A positive scheduled prefix is only supported for round 1.');
  if (values.round === 'model-smoke' && values.provider !== 'host-profile') throw new Error('Model smoke uses the custom DeepSeek route.');
  if (sha256(await fs.readFile(path.join(root, 'docs/simplify-experiment-plan.md'))) !== values['plan-sha256'])
    throw new Error('The approved plan SHA256 differs from the current plan.');
  if (values.round === '2' && values.provider !== 'coding-plan') throw new Error('Round 2 uses the existing Coding Plan benchmark relay.');
  const { identity: providerIdentity, credential } = await resolveSimplifyProvider(values.provider, values.model, values['openclaw-profile']);
  const profileArgs = values['openclaw-profile'] ? ['--openclaw-profile', path.resolve(values['openclaw-profile'])] : [];
  const archive = await fs.realpath(values.package), archiveBytes = await fs.readFile(archive);
  const artifactSha256 = sha256(archiveBytes);
  if (artifactSha256 !== values['package-sha256']) throw new Error('Integration package SHA256 mismatch.');
  const hostRoot = await fs.realpath(values['host-root']);
  const host = await readJson(path.join(hostRoot, 'package.json'));
  if (host.name !== 'openclaw' || host.version !== '2026.7.1-2') throw new Error('Use the pinned OpenClaw 2026.7.1-2 host.');
  const cMode = values.round.startsWith('C');
  let roundOne, promoted, benchmarkInputs;
  if (values.round === '2') {
    if (!values['round-one'] || !values['round-two-inputs']) throw new Error('Round 2 needs the graded first round and pinned fixture inputs.');
    roundOne = await readJson(values['round-one']);
    const screening = summarizeSimplifyExperiment(roundOne).round1;
    if (!screening.ready || !screening.promotions?.length) throw new Error('Round 1 has not produced a scored candidate for round 2.');
    if (roundOne.records.some(record => record.artifactSha256.toLowerCase() !== artifactSha256))
      throw new Error('Round 2 requires the same package as all four first-round arms.');
    promoted = screening.promotions;
    benchmarkInputs = await readRoundTwoInputs(values['round-two-inputs'], values.model);
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000, windowsHide: true, stdio: 'pipe' });
    for (const { manifest } of Object.values(benchmarkInputs)) {
      for (const image of [manifest.image, manifest.verifierImage].filter(Boolean))
        execFileSync('docker', ['image', 'inspect', '--platform', 'linux/amd64', image], { timeout: 10000, windowsHide: true, stdio: 'pipe' });
    }
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
  const output = path.resolve(values['output-root']);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  if (credential) scanStage = async () => {
    scanStage = undefined;
    const matches = await countProfileCredentialMatches(output, credential);
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
  const schedule = values.round === 'model-smoke' ? [{ id: 'smoke', scored: false, config: {} }]
    : values.round === 'C-calibration' ? [{ id: 'calibration', arm: 'calibration', sample: 'kitchen-compaction',
      timeoutMs: 30 * 60_000, config: { originalRequirementsEnabled: true, compactionRestore: false, scored: false } }]
      : simplifySchedule(values.round, promoted).slice(0, limit);
  await writeJson(path.join(output, 'batch.json'), { planSha256: values['plan-sha256'], artifactSha256, model, providerIdentity, hostVersion: host.version, schedule });
  const records = [];
  for (const slot of schedule) {
    const startedAt = Date.now();
    const directory = path.join(output, slot.id);
    await fs.mkdir(directory);
    await writeJson(path.join(directory, 'attempt.json'), { ...slot, startedAt: new Date().toISOString(), artifactSha256 });
    let result;
    const context = { hostRoot, model, packageRoot, artifactSha256, directory, requirements, settingsFile, providerIdentity,
      profileArgs, benchmark: benchmarkInputs?.[slot.sample] };
    const run = values.round === 'model-smoke' ? runSmoke : cMode ? runCompaction : benchmarkInputs ? runBenchmark : runScreening;
    try { result = await run(slot, context); }
    catch (error) { result = { state: 'failed', evidence: directory, reason: redactEvaluationText(error.message), completedInBudget: false, frameworkError: true }; }
    if (credential) {
      const evaluation = path.join(directory, 'evaluation');
      const readOptional = file => readJson(path.join(evaluation, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const boundary = await readOptional('provider-boundary.json');
      result.gatewayStarts = (await readOptional('gateway-start.json'))?.starts ?? 0;
      result.modelRequests = boundary?.requests ?? (await readProviderTiming(path.join(evaluation, 'native-host'))).filter(row => row.event === 'request').length;
      if (boundary?.failure) Object.assign(result, { state: boundary.failure === 'PROFILE_RATE_LIMIT' ? 'rate-limited' : 'failed',
        reason: boundary.failure, completedInBudget: false, frameworkError: true });
    }
    const record = { id: slot.id, arm: slot.arm, sample: slot.sample, repeat: slot.repeat, artifactSha256,
      configurationSummary: JSON.stringify({ ...slot.config, model, provider: providerIdentity }), ...result, wallMs: Date.now() - startedAt };
    await writeJson(path.join(directory, 'observation.json'), record);
    records.push(record);
    console.log(JSON.stringify({ id: slot.id, state: record.state }));
    if (credential && await countProfileCredentialMatches(directory, credential)) break;
    if (record.state === 'rate-limited' || credential && record.frameworkError) break;
  }
  if (values.round === 'C') {
    const blind = records.filter(record => record.compaction?.answer).map(record => ({ blindId: randomUUID(), runId: record.id,
      answer: record.compaction.answer })).sort((left, right) => left.blindId.localeCompare(right.blindId));
    await writeJson(path.join(output, 'answers-blind.json'), blind.map(({ blindId, answer }) => ({ blindId, answer })));
    await writeJson(path.join(output, 'answers-index.json'), blind.map(({ blindId, runId }) => ({ blindId, runId })));
  }
  if (values.round !== 'C-calibration' && values.round !== 'model-smoke')
    await writeJson(path.join(output, 'observations.json'), roundOne ? { promoted, records: [...roundOne.records, ...records] } : { records });
  await scanStage?.();
  if (values.round === 'C-calibration' || values.round === 'model-smoke') {
    if (records[0]?.state !== 'completed') process.exitCode = 1;
    return;
  }
  if (records.length < schedule.length || records.some(record => record.state !== 'completed')) process.exitCode = 1;
}

await main().catch(async error => {
  try { await scanStage?.(); } catch (scanError) { console.error(redactEvaluationText(scanError.message)); }
  console.error(redactEvaluationText(error.message)); process.exitCode = 1;
});
