// One independent Skill calibration; the original three-case driver is intact.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNativeSkillBatch, createNativeStopEvaluation } from './helpers/native-stop-evaluation.mjs';
import { nativeSkillPolicy, recordSkillVerifier } from './evaluate-native-skill.mjs';

const actor = 'controlled-component-driver';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const append = (file, entry) => fs.appendFile(file, JSON.stringify({ ...entry, actor }) + '\n');

export async function recordMixedSkillEvidence({ projectRoot, transcript, assertWatcherActive, signal }) {
  const primary = await recordSkillVerifier({ projectRoot, transcript, assertWatcherActive, signal });
  assert.equal(primary.exitCode, 3, 'The fixed primary failure control must actually exit 3; never rewrite or relabel an outcome');
  signal?.throwIfAborted(); await assertWatcherActive(); signal?.throwIfAborted();
  const resultId = randomUUID(), content = 'Exit code 0\n{"check":"beta","passed":true}';
  await append(transcript, { type: 'user', isMeta: true, uuid: `result-${randomUUID()}`,
    message: { content: [{ type: 'tool_result', tool_use_id: resultId, content }] } });
  return { actor, primary, secondary: { resultId, content, matchedInvocation: false, actualLocalExecution: false,
    provenance: 'Deliberately supplied unpaired fixture result, not an observed inspect.mjs invocation.' },
    modelBusinessRun: false, nativeHostToolInvocationClaimed: false };
}

export async function runNativeMixedSkillComponent({ sourceRoot, hostRoot, outputRoot, manifest, offline = false }) {
  assert.equal(manifest.kind, 'native-skill-triplet-v1', 'Reuse the existing guarded Skill transport; no fallback protocol');
  assert.equal(manifest.cases.length, 1, 'The mixed calibration is an independent single case');
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const batch = await installNativeSkillBatch({ sourceRoot, hostRoot, outputRoot, manifest, offline });
  const sample = manifest.cases[0], projectRoot = path.join(outputRoot, `sample-${randomUUID()}`);
  const record = { case: 1, projectRoot, actor, semanticAcceptance: null, claimsHandSeeded: false, watcherHandSeeded: false };
  let native, failure;
  try {
    await fs.mkdir(projectRoot);
    for (const [relative, expected] of Object.entries(sample.files)) {
      assert(!path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..'));
      const original = path.resolve(sourceRoot, sample.fixtureDirectory, relative), stat = await fs.lstat(original);
      assert(stat.isFile() && !stat.isSymbolicLink());
      const bytes = await fs.readFile(original); assert.equal(hash(bytes), expected);
      const target = path.join(projectRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    }
    native = await createNativeStopEvaluation({ sourceRoot, hostRoot, projectRoot, outputRoot, batch,
      stateRoot: path.join(outputRoot, 'native-profile-1'), fixtureFence: { projectRoot }, providerCredential: batch.credential(),
      provider: { api: 'openai-completions', baseUrl: manifest.baseUrl, model: manifest.model, credentialEnv: manifest.credentialEnv } });
    const load = file => import(pathToFileURL(path.join(native.pluginRoot, file)).href);
    const [store, ledger, orchestrator, pipeline] = await Promise.all([
      load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/ground-truth-ledger.mjs'),
      load('lib/runtime-v2/orchestrator.mjs'), load('lib/runtime-corrector.mjs'),
    ]);
    const policyRoot = path.join(projectRoot, '.runtime-corrector'); await fs.mkdir(policyRoot);
    const policyPath = path.join(policyRoot, 'config.yaml');
    await fs.writeFile(policyPath, nativeSkillPolicy({ modelRef: native.modelRef, offline }));
    const plan = await pipeline.loadConfig({ cwd: projectRoot, pluginRoot: native.pluginRoot });
    const sessionId = randomUUID(), transcript = path.join(projectRoot, 'conversation.jsonl');
    const initial = await fs.readFile(transcript, 'utf8'), entries = initial.trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 1); assert.equal(entries[0].type, 'user'); assert.notEqual(entries[0].isMeta, true);
    const task = await store.ensureTask({ projectRoot, sessionId });
    const empty = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId);
    assert.equal(empty.version, 0); assert.equal(empty.claims.length, 0);
    await store.withTaskState({ projectRoot, taskId: task.taskId }, state => { state.control ??= {}; });
    await batch.beginCase({ projectRoot, files: [...Object.keys(sample.files).map(file => path.join(projectRoot, file)), policyPath], appendOnlyFiles: [transcript] });
    const input = { cwd: projectRoot, session_id: sessionId, transcript_path: transcript };
    const assessment = () => ({ assessmentId: randomUUID(), deadlineAt: Date.parse(batch.metrics().deadlineAt), abortSignal: batch.signal });
    record.taskId = task.taskId; record.initialTranscriptSha256 = hash(Buffer.from(initial));
    if (!offline) {
      record.initialRefresh = await orchestrator.refreshRuntimeRequirements({ projectRoot,
        input: { ...input, hook_event_id: randomUUID() }, plan, reviewerFactory: native.run, assessmentContext: assessment() });
      const truth = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId);
      assert(record.initialRefresh.baselineCommitted && truth.version > 0 && truth.claims.length);
    }
    record.skillTrigger = { ...input, hook_event_name: 'PreToolUse', hook_event_id: randomUUID(),
      tool_name: 'Skill', tool_use_id: randomUUID(), tool_input: { skill: 'delivery-verifier' } };
    record.establishment = await orchestrator.handleRuntimeV2Event({ projectRoot, pluginRoot: native.pluginRoot,
      input: record.skillTrigger, plan, reviewerFactory: native.run, assessmentContext: assessment() });
    if (offline) record.offlineCaptureOnly = true;
    else {
      const watcher = record.establishment.watcher;
      assert(watcher?.watcherId && watcher.status === 'ACTIVE', 'No execution before genuine source extraction and ACTIVE watcher');
      const assertWatcherActive = async () => {
        batch.signal.throwIfAborted();
        const state = await store.withTaskState({ projectRoot, taskId: task.taskId }, state => structuredClone(state));
        assert.equal(state.watchers[watcher.watcherId]?.status, 'ACTIVE');
        assert.equal(state.watchers[watcher.watcherId]?.skillDigest, watcher.skillDigest);
      };
      const skillRoot = path.join(store.taskDirectory(projectRoot, task.taskId), 'skills/delivery-verifier');
      record.skillGroundTruth = JSON.parse(await fs.readFile(path.join(skillRoot, 'skill-ground-truth.json'), 'utf8'));
      assert(record.skillGroundTruth.constraints.length, 'No fake or empty Skill graph');
      record.process = await recordMixedSkillEvidence({ projectRoot, transcript, assertWatcherActive, signal: batch.signal });
      await append(transcript, { type: 'assistant', uuid: `completion-${randomUUID()}`, message: { content: 'The delivery is complete.' } });
      await batch.advanceTranscript({ path: transcript, stage: 'CONTROLLED_PROCESS_RESULTS_AND_COMPLETION' });
      record.completionTrigger = { ...input, hook_event_name: 'Stop', hook_event_id: randomUUID(), last_assistant_message: 'The delivery is complete.' };
      record.completion = await orchestrator.handleRuntimeV2Event({ projectRoot, pluginRoot: native.pluginRoot,
        input: record.completionTrigger, plan, reviewerFactory: native.run, assessmentContext: assessment() });
      const state = await store.withTaskState({ projectRoot, taskId: task.taskId }, state => structuredClone(state));
      record.watcherAfterCheck = state.watchers[watcher.watcherId];
      assert.notEqual(record.watcherAfterCheck.status, 'ACTIVE', 'Actual completion assessment must run');
      record.skillFeedbacks = state.skillFeedbacks; record.deviations = state.deviations;
      record.evaluations = [];
      for (const name of await fs.readdir(path.join(skillRoot, 'evaluations')))
        record.evaluations.push(JSON.parse(await fs.readFile(path.join(skillRoot, 'evaluations', name), 'utf8')));
      record.preparedFeedback = record.completion.feedback ?? null; record.hostFeedbackDelivered = false;
      record.formalGroundTruth = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId); record.completed = true;
    }
    for (const [relative, expected] of Object.entries(sample.files)) if (relative !== 'conversation.jsonl')
      assert.equal(hash(await fs.readFile(path.join(projectRoot, relative))), expected, 'Current fixture programs/Skill must remain immutable');
  } catch (cause) {
    failure = record.error = { code: cause.code ?? 'MIXED_SKILL_COMPONENT_FAILED', message: String(cause.message).replaceAll(batch.credential(), '[REDACTED_CREDENTIAL]') };
  } finally { await native?.close(); record.native = native?.metrics(); await batch.close(); }
  const transport = batch.metrics(), requestsWithSkillCareResults = [];
  for (const request of transport.requests) {
    const payload = JSON.parse(await fs.readFile(path.join(outputRoot, `request-${request.request}.json`), 'utf8'));
    const calls = new Map(payload.messages.filter(row => row.role === 'assistant').flatMap(row => row.tool_calls ?? []).map(call => [call.id, call.function.name]));
    if (payload.messages.some(row => row.role === 'tool' && calls.get(row.tool_call_id) === 'rc_skill_care')) requestsWithSkillCareResults.push(request.request);
  }
  const settled = transport.budget.inFlightRequests === 0 && record.native?.nativeInvocations === record.native?.settledInvocations;
  const captured = offline && settled && requestsWithSkillCareResults.length > 0;
  const complete = !offline && !failure && record.completed && settled;
  const result = { kind: 'native_skill_mixed_evidence_component', state: captured ? 'CAPTURED_NO_MODEL' : complete ? 'SETTLED_CHECKED' : 'INCOMPLETE',
    record, failure, transport, requestsWithSkillCareResults, semanticAcceptance: null, infrastructureComplete: Boolean(complete),
    limitations: ['Actual production source extraction, ledger/watcher, native factory/handoff and Stop check; no seeded graph or verdict.',
      'Controlled component process evidence is not a model business action or automatic host event; prepared feedback is not claimed delivered.',
      'The ordinary unpaired result text contains no expected verdict or missing-invocation label. Source/actor provenance is retained separately.',
      'Offline captures the real initial Skill extractor/private tools only; full mixed semantic behavior requires independent real calibration.'] };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2)); return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const offline = args.includes('--capture-native');
  if (offline === args.includes('--live') || !value('--host-root') || !value('--manifest') || !value('--output-root'))
    throw new Error('Use --capture-native or --live with --host-root, --manifest and a fresh --output-root.');
  const result = await runNativeMixedSkillComponent({ sourceRoot: fileURLToPath(new URL('../', import.meta.url)), hostRoot: value('--host-root'),
    manifest: JSON.parse(await fs.readFile(value('--manifest'), 'utf8')), outputRoot: path.resolve(value('--output-root')), offline });
  console.log(JSON.stringify({ state: result.state, providerRequests: result.transport.realProviderRequests, inFlight: result.transport.budget.inFlightRequests }));
  process.exit(['CAPTURED_NO_MODEL', 'SETTLED_CHECKED'].includes(result.state) ? 0 : 1);
}
