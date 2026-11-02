// Skill component: genuine watcher first, controlled local evidence second.
// The new batch adapter is deliberately required; no baseline/Stop fallback.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import * as nativeHelpers from './helpers/native-stop-evaluation.mjs';

const executeFile = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const actor = 'controlled-component-driver';
const append = (file, entry) => fs.appendFile(file, JSON.stringify({ ...entry, actor }) + '\n');

export function nativeSkillPolicy({ modelRef, offline = false }) {
  return `version: 2
locale: en
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: []
${offline ? '  panel:\n    size: 0\n    adjudicator: false\n' : ''}skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [delivery-verifier]
    exclude: []
  skillRoots: [skills]
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: false
reviewers:
  defaults:
    session: detached
    model: ${modelRef}
    effort: low
    timeoutMs: 240000
    maxOutputTokens: 32768
`;
}

export async function recordSkillVerifier({ projectRoot, transcript, assertWatcherActive, signal }) {
  signal?.throwIfAborted(); await assertWatcherActive(); signal?.throwIfAborted();
  const invocationId = randomUUID(), startedAt = new Date().toISOString();
  const input = { command: 'node verify.mjs', executable: process.execPath, args: ['verify.mjs'], cwd: projectRoot };
  await append(transcript, { type: 'assistant', uuid: `fixture-invocation-${invocationId}`, timestamp: startedAt,
    message: { content: [{ type: 'tool_use', id: invocationId, name: 'Bash', input }] } });
  let stdout, stderr, exitCode;
  try {
    const result = await executeFile(process.execPath, ['verify.mjs'], { cwd: projectRoot, encoding: 'utf8',
      env: { PATH: path.dirname(process.execPath), LANG: 'C.UTF-8' }, maxBuffer: 65536, timeout: 30000, signal });
    ({ stdout, stderr } = result); exitCode = 0;
  } catch (error) {
    // Cancellation, timeout and launch failures cannot become a completed run.
    if (!Number.isInteger(error.code) || error.killed || signal?.aborted) throw error;
    ({ stdout, stderr } = error); exitCode = error.code;
  }
  const finishedAt = new Date().toISOString();
  await append(transcript, { type: 'user', isMeta: true, uuid: `fixture-result-${invocationId}`, timestamp: finishedAt,
    message: { content: [{ type: 'tool_result', tool_use_id: invocationId, is_error: exitCode !== 0,
      content: `Exit code ${exitCode}\n${stdout ?? ''}${stderr ?? ''}` }] } });
  return { actor, actualLocalExecution: true, invocationId, startedAt, finishedAt, input, exitCode, stdout, stderr,
    modelBusinessRun: false, nativeHostToolInvocationClaimed: false };
}

export async function recordOrphanSkillResult({ transcript, assertWatcherActive, signal }) {
  signal?.throwIfAborted(); await assertWatcherActive(); signal?.throwIfAborted();
  const unmatchedId = randomUUID();
  await append(transcript, { type: 'user', isMeta: true, uuid: `fixture-orphan-${unmatchedId}`,
    message: { content: [{ type: 'tool_result', tool_use_id: unmatchedId,
      content: 'Controlled orphan fixture result: exit code 0; {"checks":2,"passed":true}' }] } });
  return { actor, actualLocalExecution: false, unmatchedId, matchedInvocation: false,
    resultProvenance: 'Deliberate unpaired test fixture, not an observed execution or model claim.' };
}

export async function runNativeSkillComponent({ sourceRoot, hostRoot, outputRoot, manifest, offline = false }) {
  assert.equal(manifest.kind, 'native-skill-triplet-v1');
  assert.equal(typeof nativeHelpers.installNativeSkillBatch, 'function', 'Skill batch adapter must be implemented and qualified after the current shared-source freeze; no fallback kind is permitted');
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const batch = await nativeHelpers.installNativeSkillBatch({ sourceRoot, hostRoot, outputRoot, manifest, offline });
  assert.equal(typeof batch.advanceTranscript, 'function', 'Skill phases need audited append-only transcript advancement without resetting allowances');
  const records = []; let failure;
  try {
    for (const [index, sample] of manifest.cases.entries()) {
      const projectRoot = path.join(outputRoot, `sample-${randomUUID()}`); await fs.mkdir(projectRoot);
      for (const [relative, expected] of Object.entries(sample.files)) {
        assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
        const original = path.resolve(sourceRoot, sample.fixtureDirectory, relative), stat = await fs.lstat(original);
        assert(stat.isFile() && !stat.isSymbolicLink());
        const bytes = await fs.readFile(original); assert.equal(digest(bytes), expected);
        const target = path.join(projectRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      }
      let native; const record = { case: index + 1, scenario: sample.scenario, projectRoot, semanticAcceptance: null,
        actor, claimsHandSeeded: false, watcherHandSeeded: false };
      try {
        native = await nativeHelpers.createNativeStopEvaluation({ sourceRoot, hostRoot, projectRoot, outputRoot, batch,
          stateRoot: path.join(outputRoot, `native-profile-${index + 1}`), fixtureFence: { projectRoot }, providerCredential: batch.credential(),
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
        const initial = await fs.readFile(transcript, 'utf8');
        const entries = initial.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(entries.length, 1); assert.equal(entries[0].type, 'user', 'Initial Skill input must not contain future invocation/result or completion');
        const task = await store.ensureTask({ projectRoot, sessionId });
        const empty = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId);
        assert.equal(empty.version, 0); assert.equal(empty.claims.length, 0);
        await store.withTaskState({ projectRoot, taskId: task.taskId }, state => { state.control ??= {}; });
        await batch.beginCase({ projectRoot, files: [...Object.keys(sample.files).map(file => path.join(projectRoot, file)), policyPath], appendOnlyFiles: [transcript] });
        const input = { cwd: projectRoot, session_id: sessionId, transcript_path: transcript };
        const assessment = () => ({ assessmentId: randomUUID(), deadlineAt: Date.parse(batch.metrics().deadlineAt), abortSignal: batch.signal });
        record.taskId = task.taskId; record.initialTranscriptSha256 = digest(Buffer.from(initial));
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
        if (offline) { record.offlineCaptureOnly = true; records.push(record); break; }
        const watcher = record.establishment.watcher;
        assert(watcher?.watcherId && watcher.status === 'ACTIVE', 'No verifier may execute before genuine Skill extraction and watcher publication');
        const assertWatcherActive = async () => {
          batch.signal.throwIfAborted();
          const state = await store.withTaskState({ projectRoot, taskId: task.taskId }, state => structuredClone(state));
          assert.equal(state.watchers[watcher.watcherId]?.status, 'ACTIVE');
          assert.equal(state.watchers[watcher.watcherId]?.skillDigest, watcher.skillDigest);
        };
        const skillRoot = path.join(store.taskDirectory(projectRoot, task.taskId), 'skills/delivery-verifier');
        record.skillGroundTruth = JSON.parse(await fs.readFile(path.join(skillRoot, 'skill-ground-truth.json'), 'utf8'));
        assert(record.skillGroundTruth.constraints.length, 'The Skill constraint graph must be real and nonempty');
        record.process = sample.scenario === 'unattributed-result'
          ? await recordOrphanSkillResult({ transcript, assertWatcherActive, signal: batch.signal })
          : await recordSkillVerifier({ projectRoot, transcript, assertWatcherActive, signal: batch.signal });
        await append(transcript, { type: 'assistant', uuid: `fixture-completion-${randomUUID()}`, message: { content: 'The delivery is complete.' } });
        await batch.advanceTranscript({ path: transcript, stage: 'CONTROLLED_VERIFIER_RESULT_AND_COMPLETION_ATTEMPT' });
        record.completionTrigger = { ...input, hook_event_name: 'Stop', hook_event_id: randomUUID(), last_assistant_message: 'The delivery is complete.' };
        record.completion = await orchestrator.handleRuntimeV2Event({ projectRoot, pluginRoot: native.pluginRoot,
          input: record.completionTrigger, plan, reviewerFactory: native.run, assessmentContext: assessment() });
        const state = await store.withTaskState({ projectRoot, taskId: task.taskId }, state => structuredClone(state));
        record.watcherAfterCheck = state.watchers[watcher.watcherId];
        assert.notEqual(record.watcherAfterCheck.status, 'ACTIVE', 'Completion attempt must actually check the watcher');
        record.preparedFeedback = record.completion.feedback ?? null; record.hostFeedbackDelivered = false;
        record.formalGroundTruth = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId);
        record.completed = true;
      } catch (cause) {
        record.error = { code: cause.code ?? 'SKILL_COMPONENT_FAILED', message: String(cause.message).replaceAll(batch.credential(), '[REDACTED_CREDENTIAL]') };
        failure = record.error;
      } finally { await native?.close(); record.native = native?.metrics(); }
      records.push(record); await fs.writeFile(path.join(outputRoot, `case-${index + 1}.json`), JSON.stringify(record, null, 2));
      if (failure) break;
    }
  } catch (cause) { failure = { code: cause.code ?? 'SKILL_COMPONENT_FAILED', message: String(cause.message).replaceAll(batch.credential(), '[REDACTED_CREDENTIAL]') }; }
  finally { await batch.close(); }
  const transport = batch.metrics(), requestsWithSkillCareResults = [];
  for (const request of transport.requests) {
    const payload = JSON.parse(await fs.readFile(path.join(outputRoot, `request-${request.request}.json`), 'utf8'));
    const calls = new Map(payload.messages.filter(x => x.role === 'assistant').flatMap(x => x.tool_calls ?? []).map(call => [call.id, call.function.name]));
    if (payload.messages.some(x => x.role === 'tool' && calls.get(x.tool_call_id) === 'rc_skill_care')) requestsWithSkillCareResults.push(request.request);
  }
  const settled = transport.budget.inFlightRequests === 0 && records.every(x => !x.native || x.native.nativeInvocations === x.native.settledInvocations);
  const captured = offline && settled && requestsWithSkillCareResults.length > 0;
  const complete = !offline && !failure && records.length === 3 && records.every(x => x.completed) && settled;
  const result = { kind: 'native_skill_watcher_production_component', state: captured ? 'CAPTURED_NO_MODEL' : complete ? 'SETTLED_CHECKED' : 'INCOMPLETE',
    outputRoot, records, failure, transport, requestsWithSkillCareResults, semanticAcceptance: null, infrastructureComplete: complete,
    limitations: ['Skill source extraction, watcher establishment, completion checking and factory handoff are actual production paths.',
      'Explicit component Skill/Stop events and controlled local command histories are not model business actions or automatic native host activation.',
      'Offline has no graph, claims or watcher seeded: it disables onboarding only and captures the actual first Skill extractor/private reads, then stops without executing the verifier.',
      'Success/failure outcomes are observed only after real watcher establishment; orphan result has no actual invocation. Independent semantics/attribution audit is required.',
      'Prepared feedback is inspected; actual host delivery, business repair, benchmark results and efficiency wins are separate.'] };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2)); return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const offline = args.includes('--capture-native');
  if (offline === args.includes('--live') || !value('--host-root') || !value('--manifest') || !value('--output-root'))
    throw new Error('Use exactly one of --capture-native or --live, with --host-root, --manifest and a fresh --output-root.');
  const result = await runNativeSkillComponent({ sourceRoot: fileURLToPath(new URL('../', import.meta.url)), hostRoot: value('--host-root'),
    outputRoot: path.resolve(value('--output-root')), manifest: JSON.parse(await fs.readFile(value('--manifest'), 'utf8')), offline });
  console.log(JSON.stringify({ state: result.state, cases: result.records.length, providerRequests: result.transport.realProviderRequests,
    inFlight: result.transport.budget.inFlightRequests, outputRoot: result.outputRoot }));
  process.exit(['CAPTURED_NO_MODEL', 'SETTLED_CHECKED'].includes(result.state) ? 0 : 1);
}
