// Dedicated baseline component probe: real production refresh/publication,
// fictional originals, and the existing metered native provider. Not a judge.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createNativeStopEvaluation, installNativeBaselineBatch } from './helpers/native-stop-evaluation.mjs';
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function initializeNativeBaselineTask({ projectRoot, sessionId }) {
  const task = await ensureTask({ projectRoot, sessionId });
  const empty = await loadCurrentGroundTruth(projectRoot, task.taskId);
  assert.equal(empty.version, 0); assert.equal(empty.claims.length, 0, 'Never discard or hand-seed an existing baseline');
  // Explicit refresh normally follows the interaction command lifecycle.
  // Match its empty control metadata, without claims or fabricated receipts.
  // SessionStart alone does not initialize this task-local object.
  await withTaskState({ projectRoot, taskId: task.taskId }, state => { state.control ??= {}; });
  return task;
}

export async function runNativeBaselineComponent({ sourceRoot, hostRoot, outputRoot, manifest, offline = false }) {
  assert.equal(manifest.kind, 'native-baseline-component-v1');
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const projectRoot = path.join(outputRoot, `sample-${randomUUID()}`); await fs.mkdir(projectRoot);
  const fixture = path.resolve(sourceRoot, manifest.fixtureDirectory);
  // Future user turns and the scoring-side protocol stay outside this workspace.
  for (const [relative, expectedHash] of Object.entries(manifest.fixtureFiles)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    const original = path.join(fixture, relative), stat = await fs.lstat(original);
    assert(stat.isFile() && !stat.isSymbolicLink());
    const bytes = await fs.readFile(original); assert.equal(digest(bytes), expectedHash);
    if (relative.startsWith('materials/')) {
      const target = path.join(projectRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    }
  }
  const initial = await fs.readFile(path.join(fixture, 'initial-transcript.jsonl'), 'utf8');
  const changed = await fs.readFile(path.join(fixture, 'changed-transcript.jsonl'), 'utf8');
  const transcript = path.join(projectRoot, 'conversation.jsonl'), sessionId = randomUUID();
  const batch = await installNativeBaselineBatch({ hostRoot, sourceRoot, outputRoot, manifest, offline });
  let native, failure; const phases = [];
  try {
    native = await createNativeStopEvaluation({ hostRoot, sourceRoot, projectRoot, outputRoot,
      stateRoot: path.join(outputRoot, 'native-profile'), batch, providerCredential: batch.credential(),
      provider: { api: 'openai-completions', baseUrl: manifest.baseUrl, model: manifest.model, credentialEnv: manifest.credentialEnv },
      fixtureFence: { projectRoot } });
    const task = await initializeNativeBaselineTask({ projectRoot, sessionId });
    const runtimeV2 = compileRuntimeV2Config({ version: 2,
      dynamicGroundTruth: { enabled: true, materialRoots: [path.join(projectRoot, 'materials')] },
      reviewers: { groundTruthExtractor: { session: 'detached', model: native.modelRef, effort: 'low', timeoutMs: 240000, maxOutputTokens: 32768 } },
      skillCorrection: { enabled: false }, artifactCorrection: { groundTruthReviewEnabled: false }, stopCorrection: { enabled: false } });
    const originals = Object.keys(manifest.fixtureFiles).filter(file => file.startsWith('materials/')).map(file => path.join(projectRoot, file));
    for (const [index, text] of [initial, changed].entries()) {
      await fs.writeFile(transcript, text);
      await batch.beginCase({ projectRoot, files: [...originals, transcript] });
      const before = await loadCurrentGroundTruth(projectRoot, task.taskId);
      let outcome, error;
      try {
        outcome = await refreshRuntimeRequirements({ projectRoot,
          input: { cwd: projectRoot, session_id: sessionId, transcript_path: transcript, hook_event_id: randomUUID() },
          plan: { runtimeV2, artifacts: [], configuredArtifacts: [] }, reviewerFactory: native.run,
          assessmentContext: { deadlineAt: Date.parse(batch.metrics().deadlineAt), abortSignal: batch.signal } });
      } catch (cause) {
        error = { code: cause.code ?? 'BASELINE_COMPONENT_FAILED', message: String(cause.message).replaceAll(batch.credential(), '[REDACTED_CREDENTIAL]') };
      }
      const truth = await loadCurrentGroundTruth(projectRoot, task.taskId);
      await fs.writeFile(path.join(outputRoot, `truth-${index + 1}.json`), JSON.stringify(truth, null, 2));
      phases.push({ phase: index + 1, trigger: 'explicit production refreshRuntimeRequirements', taskId: task.taskId,
        originalTranscriptSha256: digest(Buffer.from(text)), beforeVersion: before.version, afterVersion: truth.version,
        claimCount: truth.claims.length, routing: truth.claims.map(claim => ({ claimId: claim.claimId, status: claim.status,
          verificationTarget: claim.verificationTarget, implementationRole: claim.implementationRole, source: claim.source })),
        outcome, error });
      if (offline || error || truth.version <= before.version || !truth.claims.length) { failure = error ?? { code: offline ? 'OFFLINE_CAPTURE_ONLY' : 'BASELINE_NOT_PUBLISHED' }; break; }
    }
  } catch (cause) {
    failure = { code: cause.code ?? 'BASELINE_COMPONENT_FAILED', message: String(cause.message).replaceAll(batch.credential(), '[REDACTED_CREDENTIAL]') };
  } finally { await native?.close(); await batch.close(); }
  const metrics = batch.metrics(), nativeMetrics = native?.metrics();
  const requestsWithToolResults = [];
  for (const request of metrics.requests) {
    const payload = JSON.parse(await fs.readFile(path.join(outputRoot, `request-${request.request}.json`), 'utf8'));
    if (payload.messages.some(message => message.role === 'tool')) requestsWithToolResults.push(request.request);
  }
  const transportSettled = metrics.budget.inFlightRequests === 0
    && nativeMetrics?.nativeInvocations === nativeMetrics?.settledInvocations;
  const captured = offline && metrics.requests.length >= 2 && requestsWithToolResults.length > 0 && transportSettled;
  const publicationCompleted = !offline && !failure && phases.length === 2 && phases.every(phase => phase.afterVersion > phase.beforeVersion);
  const result = { kind: 'native_baseline_explicit_refresh_component', mode: offline ? 'offline_native_capture' : 'real_provider',
    state: captured ? 'CAPTURED_NO_MODEL' : publicationCompleted && transportSettled ? 'SETTLED_PUBLISHED' : 'INCOMPLETE',
    outputRoot, projectRoot, phases, failure, native: nativeMetrics, transport: metrics, requestsWithToolResults,
    infrastructureComplete: publicationCompleted && transportSettled, semanticAcceptance: null,
    originalMixedObligationRequired: true, claimsHandSeeded: false,
    limitations: ['Uses the actual production explicit refresh API and formal source-bound ledger publication.',
      'Automatic UserPrompt/onboarding triggers, business execution and full host correction are not claimed.',
      'Raw claims and revisions require independent semantic review against all original conditions, exclusions and separate execution duty.',
      'Offline responses only drive real read tools for payload qualification; no simulated semantic verdict is accepted.'] };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const offline = args.includes('--capture-native');
  if (offline === args.includes('--live') || !value('--host-root') || !value('--manifest') || !value('--output-root'))
    throw new Error('Use exactly one of --capture-native or --live, with --host-root, --manifest and a fresh --output-root.');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(value('--manifest'), 'utf8'));
  const result = await runNativeBaselineComponent({ sourceRoot, hostRoot: value('--host-root'),
    outputRoot: path.resolve(value('--output-root')), manifest, offline });
  console.log(JSON.stringify({ state: result.state, phases: result.phases.length, providerRequests: result.transport.realProviderRequests,
    inFlight: result.transport.budget.inFlightRequests, outputRoot: result.outputRoot }));
  process.exit(['CAPTURED_NO_MODEL', 'SETTLED_PUBLISHED'].includes(result.state) ? 0 : 1);
}
