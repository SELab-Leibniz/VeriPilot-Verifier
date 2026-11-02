// Production document component, not an automatic host/business repair loop.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createNativeStopEvaluation, installNativeDocumentBatch } from './helpers/native-stop-evaluation.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function nativeDocumentPolicy({ modelRef, offline = false }) {
  return `version: 2
locale: en
groundTruth:
  - id: original-requirements
    type: user-confirmed-requirement
    authority: user
    required: true
    patterns: [requirements.md]
artifacts:
  - name: design
    stage: solution-design
    format: markdown
    patterns: [design.md]
    groundTruth: [original-requirements]
    rules:
      enabled: false
    review:
      enabled: true
      criteria: review.md
dynamicGroundTruth:
  enabled: ${!offline}
  materialRoots: [requirements.md]
skillCorrection:
  enabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: ${!offline}
  stageMetricsEnabled: false
reviewers:
  defaults:
    session: detached
    model: ${modelRef}
    effort: low
    timeoutMs: 240000
    maxOutputTokens: 32768
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`;
}

export async function runNativeDocumentComponent({ sourceRoot, hostRoot, outputRoot, manifest, offline = false }) {
  assert.equal(manifest.kind, 'native-document-pair-v1');
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const projectRoot = path.join(outputRoot, `sample-${randomUUID()}`); await fs.mkdir(projectRoot);
  const fixture = path.resolve(sourceRoot, manifest.fixtureDirectory);
  for (const [relative, expected] of Object.entries(manifest.fixtureFiles)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    const original = path.join(fixture, relative), stat = await fs.lstat(original);
    assert(stat.isFile() && !stat.isSymbolicLink());
    const bytes = await fs.readFile(original); assert.equal(digest(bytes), expected);
    const target = path.join(projectRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  const correctionPath = path.resolve(sourceRoot, manifest.round2Control.path);
  assert(!correctionPath.startsWith(projectRoot + path.sep));
  assert.equal(digest(await fs.readFile(correctionPath)), manifest.round2Control.sha256);
  const batch = await installNativeDocumentBatch({ sourceRoot, hostRoot, outputRoot, manifest, offline });
  let native, failure, baseline = null; const rounds = [];
  try {
    native = await createNativeStopEvaluation({ sourceRoot, hostRoot, outputRoot, projectRoot, batch,
      stateRoot: path.join(outputRoot, 'native-profile'), fixtureFence: { projectRoot }, providerCredential: batch.credential(),
      provider: { api: 'openai-completions', baseUrl: manifest.baseUrl, model: manifest.model, credentialEnv: manifest.credentialEnv } });
    // Keep host selection and transaction scopes consistent with the artifact
    // loaded by the installed host, including the factory/handoff implementation.
    const load = file => import(pathToFileURL(path.join(native.pluginRoot, file)).href);
    const [store, ledger, orchestrator, pipeline, semantic] = await Promise.all([
      load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/ground-truth-ledger.mjs'),
      load('lib/runtime-v2/orchestrator.mjs'), load('lib/runtime-corrector.mjs'), load('lib/semantic-review.mjs'),
    ]);
    const policyRoot = path.join(projectRoot, '.runtime-corrector'); await fs.mkdir(policyRoot);
    const policyPath = path.join(policyRoot, 'config.yaml'), criteriaPath = path.join(policyRoot, 'review.md');
    await fs.writeFile(policyPath, nativeDocumentPolicy({ modelRef: native.modelRef, offline }));
    await fs.writeFile(criteriaPath, 'Assess the current design against the complete original user request and adopted requirements. Preserve all original conditions and explicit exclusions. Do not invent requirements or apply edits. Report only concrete current contradictions; otherwise return no findings.\n');
    const plan = await pipeline.loadConfig({ cwd: projectRoot, pluginRoot: native.pluginRoot });
    const sessionId = randomUUID(), transcript = path.join(projectRoot, 'conversation.jsonl'), artifact = path.join(projectRoot, 'design.md');
    const task = await store.ensureTask({ projectRoot, sessionId });
    const empty = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId);
    assert.equal(empty.version, 0); assert.equal(empty.claims.length, 0);
    await store.withTaskState({ projectRoot, taskId: task.taskId }, state => { state.control ??= {}; });
    const baseInput = { cwd: projectRoot, session_id: sessionId, transcript_path: transcript };
    const assessment = () => ({ assessmentId: randomUUID(), deadlineAt: Date.parse(batch.metrics().deadlineAt), abortSignal: batch.signal });
    for (let index = 0; index < 2; index++) {
      if (index) {
        const corrected = await fs.readFile(correctionPath); assert.equal(digest(corrected), manifest.round2Control.sha256);
        await fs.writeFile(artifact, corrected);
      }
      await batch.beginCase({ projectRoot, files: [...Object.keys(manifest.fixtureFiles).map(file => path.join(projectRoot, file)), policyPath, criteriaPath] });
      if (!index && !offline) {
        const outcome = await orchestrator.refreshRuntimeRequirements({ projectRoot, input: { ...baseInput, hook_event_id: randomUUID() },
          plan, reviewerFactory: native.run, assessmentContext: assessment() });
        const truth = await ledger.loadCurrentGroundTruth(projectRoot, task.taskId);
        assert(outcome.baselineCommitted && truth.version > 0 && truth.claims.length, 'The live document component requires genuine baseline publication');
        baseline = { outcome, version: truth.version, claimCount: truth.claims.length };
        await fs.writeFile(path.join(outputRoot, 'initial-truth.json'), JSON.stringify(truth, null, 2));
      }
      const beforeHash = digest(await fs.readFile(artifact));
      const input = { ...baseInput, hook_event_name: 'PostToolUse', hook_event_id: randomUUID(), tool_name: 'Edit',
        tool_use_id: randomUUID(), tool_input: { file_path: artifact }, tool_response: { success: true } };
      const prepared = await pipeline.checkArtifact({ filePath: artifact, cwd: projectRoot, pluginRoot: native.pluginRoot,
        config: plan, deferPersistence: true, includePublicCommandContext: false });
      assert(prepared.matched, 'Current document must match the actual configured artifact');
      const outcome = await orchestrator.handleRuntimeV2Event({ projectRoot, pluginRoot: native.pluginRoot, input, plan,
        reviewerFactory: native.run, artifact: prepared.reviewContext.artifact, assessmentContext: assessment() });
      if (!offline) assert(outcome.artifactReviewContext, 'Production artifact review context was not established');
      const review = await semantic.runSemanticReview({ input, prepared, pluginRoot: native.pluginRoot,
        runtimeV2Handle: outcome.reviewerHandle, runtimeV2Context: outcome.artifactReviewContext,
        runtimeV2ExecutionContext: { ...outcome.reviewerExecutionContext, deadlineAt: Date.parse(batch.metrics().deadlineAt) },
        runtimeV2Evidence: outcome.reviewerEvidence, runtimeV2ReviewerFactory: native.run,
        // Production's node-review path needs no claim ledger. Use its actual
        // generated request, with the native handoff, for offline tool capture.
        invokeFork: async request => {
          assert(offline, 'Live document review requires the genuine baseline context');
          const semanticReviewRequestPath = request.prompt.match(/--request "([^"]+)"/u)?.[1];
          assert(semanticReviewRequestPath);
          const entries = (await fs.readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          const handle = await native.run.handoff({ originHandle: null, projectRoot, sessionCwd: projectRoot, taskId: task.taskId,
            parentSessionId: sessionId, role: 'artifact-reviewer', reviewer: { session: 'detached', model: native.modelRef,
              timeoutMs: 240000, maxOutputTokens: 32768 }, schema: semantic.REVIEW_SCHEMA,
            deadlineAt: Date.parse(batch.metrics().deadlineAt), evidence: { snapshot: { entries } },
            request: { semanticReviewRequestPath, instructions: 'Read the complete current semantic request and assess the current documents against the adopted original requirements. Do not apply edits.' } });
          try { return { sessionId: handle.sessionId, review: handle.result }; } finally { await handle.close(); }
        } });
      assert.equal(digest(await fs.readFile(artifact)), beforeHash, 'Private document review must not apply business edits');
      const finalized = await pipeline.finalizeArtifactCheck(prepared, review);
      const persisted = await orchestrator.finalizeArtifactRuntimeV2({ projectRoot, taskId: task.taskId,
        runtimeV2: plan.runtimeV2, artifactReviewContext: outcome.artifactReviewContext, semanticReview: review, delivered: false });
      const round = { round: index + 1, actor: 'Controlled component driver; no model business edit or automatic host hook claimed.',
        trigger: input, taskId: task.taskId, artifactSha256: beforeHash, baselineVersion: outcome.artifactReviewContext?.groundTruthVersion ?? 0,
        review, result: finalized.result, preparedFeedback: finalized.feedback, hostFeedbackDelivered: false, evaluation: persisted };
      rounds.push(round); await fs.writeFile(path.join(outputRoot, `round-${index + 1}.json`), JSON.stringify(round, null, 2));
      if (offline) break;
      assert.equal(review.status, 'completed', review.error ?? 'Document review did not complete');
    }
  } catch (cause) {
    failure = { code: cause.code ?? 'DOCUMENT_COMPONENT_FAILED', message: String(cause.message).replaceAll(batch.credential(), '[REDACTED_CREDENTIAL]') };
  } finally { await native?.close(); await batch.close(); }
  const transport = batch.metrics(), nativeMetrics = native?.metrics();
  const requestsWithDocumentToolResults = [];
  for (const request of transport.requests) {
    const payload = JSON.parse(await fs.readFile(path.join(outputRoot, `request-${request.request}.json`), 'utf8'));
    const calls = new Map(payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function.name]));
    if (payload.messages.some(message => message.role === 'tool' && calls.get(message.tool_call_id) === 'rc_document')) requestsWithDocumentToolResults.push(request.request);
  }
  const settled = transport.budget.inFlightRequests === 0 && nativeMetrics?.nativeInvocations === nativeMetrics?.settledInvocations;
  const captured = offline && settled && requestsWithDocumentToolResults.length > 0;
  const complete = !offline && !failure && rounds.length === 2 && settled;
  const result = { kind: 'native_document_production_component', state: captured ? 'CAPTURED_NO_MODEL' : complete ? 'SETTLED_REVIEWED' : 'INCOMPLETE',
    outputRoot, projectRoot, baseline, rounds, failure, native: nativeMetrics, transport, requestsWithDocumentToolResults,
    infrastructureComplete: complete, semanticAcceptance: null, claimsHandSeeded: false,
    limitations: ['Uses the built OpenClaw production factory/handoff, artifact checker, orchestrator, semantic review and result/evaluation publication.',
      'Offline captures production node-review on an empty ledger, with dynamic extraction and ledger-based artifact review disabled; declared original document inputs and the native handoff remain active. It publishes no fake baseline or semantic verdict. Live requires genuine extraction and ledger-based artifact review.',
      'Driver supplies explicit PostToolUse component events and the second controlled current-file revision; model business editing, automatic host middleware delivery and Gateway correction are not claimed.',
      'Prepared feedback is persisted for inspection; host delivery is not stamped. Independent semantic review of both current documents remains required.'] };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2)); return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const offline = args.includes('--capture-native');
  if (offline === args.includes('--live') || !value('--host-root') || !value('--manifest') || !value('--output-root'))
    throw new Error('Use exactly one of --capture-native or --live, with --host-root, --manifest and a fresh --output-root.');
  const result = await runNativeDocumentComponent({ sourceRoot: fileURLToPath(new URL('../', import.meta.url)), hostRoot: value('--host-root'),
    outputRoot: path.resolve(value('--output-root')), manifest: JSON.parse(await fs.readFile(value('--manifest'), 'utf8')), offline });
  console.log(JSON.stringify({ state: result.state, rounds: result.rounds.length, providerRequests: result.transport.realProviderRequests,
    inFlight: result.transport.budget.inFlightRequests, outputRoot: result.outputRoot }));
  process.exit(['CAPTURED_NO_MODEL', 'SETTLED_REVIEWED'].includes(result.state) ? 0 : 1);
}
