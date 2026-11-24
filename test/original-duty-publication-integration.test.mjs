import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// Guard every external dispatch before importing the actual production chain.
const attempts = { process: 0, network: 0, fakeSelfLiveness: 0, fakeGraphInventory: 0 };
const offlineGraphRoots = new Set();
const forbid = kind => () => { attempts[kind]++; throw new Error('OFFLINE_INTEGRATION_FORBIDS_' + kind); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbid('process');
// Optional graph navigation receives an explicitly empty FAKE inventory. This
// exact own-fixture metadata seam never dispatches a command or grants proof.
const graphArgs = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'];
const fakeGraph = (command, args, options) => {
  assert.equal(command, 'git'); assert.deepEqual(args, graphArgs);
  assert(offlineGraphRoots.has(path.resolve(options?.cwd ?? '')));
  assert.deepEqual(Object.keys(options).sort(), ['cwd', 'maxBuffer', 'signal', 'windowsHide'].sort());
  assert.equal(options.windowsHide, true); assert.equal(options.maxBuffer, 4 * 1024 * 1024);
  assert(options.signal instanceof AbortSignal); options.signal.throwIfAborted();
  attempts.fakeGraphInventory++; assert(attempts.fakeGraphInventory <= 4);
  return { stdout: '', stderr: '' };
};
const isFakeGraph = (command, args, options) => command === 'git' && JSON.stringify(args) === JSON.stringify(graphArgs)
  && offlineGraphRoots.has(path.resolve(options?.cwd ?? ''));
const fakeExecFile = (command, args, options, callback) => {
  if (!isFakeGraph(command, args, options)) return forbid('process')();
  const result = fakeGraph(command, args, options); queueMicrotask(() => callback(null, result.stdout, result.stderr));
  return null;
};
fakeExecFile[promisify.custom] = async (command, args, options) => {
  if (!isFakeGraph(command, args, options)) return forbid('process')();
  return fakeGraph(command, args, options);
};
childProcess.execFile = fakeExecFile;

process.kill = (pid, signal) => {
  if (pid === process.pid && signal === 0) { attempts.fakeSelfLiveness++; return true; }
  return forbid('process')();
};
for (const name of ['connect', 'createConnection']) net[name] = forbid('network');
net.Socket.prototype.connect = forbid('network'); net.Server.prototype.listen = forbid('network');
for (const module of [http, https]) for (const name of ['request', 'get']) module[name] = forbid('network');
globalThis.fetch = forbid('network');
syncBuiltinESMExports();

const { runSemanticReview, REVIEW_SCHEMA } = await import('../lib/semantic-review.mjs');
const { isDeepStrictEqual } = await import('node:util');
const { finalizeArtifactCheck, checkArtifact } = await import('../lib/runtime-corrector.mjs');
const { groupDocumentReviews, documentReviewBundleKey, documentReviewBundleCurrent } = await import('../lib/openclaw/document-review-bundle.mjs');
const { mergeSemanticReview } = await import('../lib/result-processing.mjs');
const { createDocumentTools, registerDocumentTools } = await import('../lib/document-tools.mjs');
const { createOpenClawReviewerFactory } = await import('../lib/openclaw/reviewer.mjs');
const { registerTaskTools } = await import('../lib/openclaw/task-tools.mjs');
const { ensureTask } = await import('../lib/runtime-v2/task-store.mjs');
const { resolveStopReviewPolicy } = await import('../lib/runtime-v2/metric-policy.mjs');
const { STOP_REVIEW_SCHEMA } = await import('../lib/runtime-v2/reviewer.mjs');
const { releaseDocumentSessions } = await import('../lib/document-session.mjs');
const { buildOriginalRequirements } = await import('../lib/runtime-v2/original-requirements.mjs');
const { knownOriginalObligations, knownOriginalObservationSnapshot, knownOriginalObligationReader, forgetKnownOriginalObligations } = await import('../lib/runtime-v2/known-original-obligations.mjs');
const { knownOriginalOwner, knownOriginalItems, projectKnownOriginalCohort } = await import('../lib/runtime-v2/known-original-capacity.mjs');
const { createOriginalSourceAnchor } = await import('../lib/runtime-v2/original-source-anchor.mjs');
const { captureOriginalDutyPublication, originalDutyPublicationCurrent, publishOriginalDutyArtifact } = await import('../lib/runtime-v2/original-duty-artifact-publication.mjs');
const { hostOriginalCoverageCurrent, hostOriginalCapacityFailure, bindHostOriginalCoverage,
  cloneHostOriginalReview, hostOriginalReviewMetadata, cloneHostLegacyOriginalCoverage, originalDutyContextFromCapture } = await import('../lib/runtime-v2/original-duty-publication.mjs');
const { sha256 } = await import('../lib/runtime-v2/utils.mjs');
const { readOpenSpecPlan } = await import('../lib/openspec-plan.mjs');

test.after(() => {
  assert.equal(attempts.process, 0); assert.equal(attempts.network, 0);
  assert(attempts.fakeSelfLiveness > 0); assert.equal(attempts.fakeGraphInventory, 4); assert.equal(offlineGraphRoots.size, 0);
  console.log('OFFLINE_FACTORY_GUARDS ' + JSON.stringify(attempts));
});
// Execute the exact private pinned production closure, not a test rewrite of
// its invokeFork adapter. Proposal-review policy is absent in this fixture, so
// the actual artifactProposalBinding takes its normal no-extra-policy branch.
function pinRuntimeSource(source) {
  // Git checkouts may use CRLF. Pin and extract the same canonical LF text;
  // every other byte remains covered by the original committed-source hash.
  const runtimeSource = source.replace(/\r\n/gu, '\n');
  assert.equal(sha256(runtimeSource), '74bfff042a3360f6e3934a2792edccb327bbadf4d64ddc960d2c1d50897b92b7');
  return runtimeSource;
}
const runtimeSource = pinRuntimeSource(await fs.readFile(new URL('../lib/openclaw/runtime.mjs', import.meta.url), 'utf8'));
const productionLegacyBlock = runtimeSource.slice(runtimeSource.indexOf('  async function artifactProposalBinding('),
  runtimeSource.indexOf('  async function finalizeScopedArtifact('));
assert(productionLegacyBlock.includes('? bindHostOriginalCoverage(handle.originalRequirementCoverage, cohortContext, publicationCurrent)'));
const productionLegacyReview = new Function('runSemanticReview', 'captureOriginalDutyPublication',
  'originalDutyPublicationCurrent', 'bindHostOriginalCoverage', 'REVIEW_SCHEMA', 'isDeepStrictEqual',
  'pluginRoot', 'readOpenSpecPlan', 'cloneHostLegacyOriginalCoverage', 'originalDutyContextFromCapture', productionLegacyBlock + '\nreturn semanticArtifactReview;')(
  runSemanticReview, captureOriginalDutyPublication, originalDutyPublicationCurrent, bindHostOriginalCoverage,
  REVIEW_SCHEMA, isDeepStrictEqual, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), readOpenSpecPlan,
  cloneHostLegacyOriginalCoverage, originalDutyContextFromCapture);

const baseDuties = [
  'When recording is enabled, preserve every segment in its original order.',
  'Retain the diagnostic label on each retained segment, including truncation.',
  'Preserve the retained segment count.',
];
const manyDuties = Array.from({ length: 48 }, (_, i) => 'When event ' + i + ' occurs, preserve output ' + i + ' and its diagnostic label.');
const extraDuty = 'When a configuration error occurs, preserve the distinct configuration diagnostic.';
let nextRound = 0;

async function fixture(t, { duties = baseDuties, sourceRef = 'offline-original', tail = '', targetBytes = null, includeExtraInPlan = false, ownerTargetBytes = null, omittedPlanDuties = [] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-duty-production-')));
  t.after(async () => { await releaseDocumentSessions(root); await fs.rm(root, { recursive: true, force: true }); });
  const proposal = 'openspec/changes/accounting/proposal.md', tasks = 'openspec/changes/accounting/tasks.md';
  await fs.mkdir(path.dirname(path.join(root, proposal)), { recursive: true });
  const plannedDuties = [...duties.filter(duty => !omittedPlanDuties.includes(duty)), ...(includeExtraInPlan ? [extraDuty] : [])];
  await fs.writeFile(path.join(root, proposal), '# Plan\n' + plannedDuties.join('\n') + '\n');
  await fs.writeFile(path.join(root, tasks), '- [ ] Implement and verify every original duty.\n');
  const text = '# Request\n' + duties.join('\n') + '\n' + extraDuty + '\n' + tail;
  await fs.writeFile(path.join(root, 'nonadopted-context.txt'), 'context');
  const originals = await buildOriginalRequirements({ projectRoot: root, sessionId: 'parent-session',
    snapshot: { entries: [{ type: 'user', uuid: sourceRef, message: { content: [{ type: 'text', text }] } }] },
    hostAdapter: { instructionFileNames: [] }, plan: { configuredArtifacts: [] },
    materials: { entries: [{ root, path: 'nonadopted-context.txt', bytes: 7, sha256: sha256('context') }] } });
  // A material is still read-only context and must not be newly promoted by the native join.
  const snapshot = await readOpenSpecPlan(root, 'accounting');
  const state = { projectRoot: root, sessionId: 'parent-session', sessionKey: 'agent:parent',
    scopeTaskId: 'task-offline', projectScope: { fingerprint: 'scope-offline' }, enabledRevision: 3,
    nativeRunId: 'run-offline', reviewController: new AbortController() };
  if (targetBytes !== null) {
    const source = originals.userMessages[0];
    const anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes: Buffer.from(source.text), start: 2, end: duties.length + 2 });
    const projection = projectKnownOriginalCohort({ owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId,
      changeName: 'accounting', planRevision: snapshot.revision,
      items: knownOriginalItems(duties.map(requirement => ({ source: anchor, requirement }))) });
    const bytes = Buffer.byteLength(JSON.stringify(projection));
    assert(targetBytes > bytes); state.nativeRunId += 'x'.repeat(targetBytes - bytes);
  }
  if (ownerTargetBytes !== null) {
    const source = originals.userMessages[0];
    const anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes: Buffer.from(source.text), start: 2, end: duties.length + 2 });
    const projected = projectKnownOriginalCohort({ owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId,
      changeName: 'accounting', planRevision: snapshot.revision, items: knownOriginalItems([{ source: anchor, requirement: baseDuties[1] }]) });
    const bytes = Buffer.byteLength(JSON.stringify(projected));
    assert(ownerTargetBytes > bytes); state.sessionKey += 'x'.repeat(ownerTargetBytes - bytes);
  }
  const frozenTruth = { taskId: state.scopeTaskId, groundTruthDigest: sha256('frozen-truth-remains-authority'),
    groundTruthVersion: 7, reviewerExecution: { session: 'detached', timeoutMs: 1000 },
    activeClaims: [{ claimId: 'gt-unchanged', text: 'Frozen authority is not replaced by the accounting source view.' }] };
  const calls = { handoff: 0, legacy: 0, handlesClosed: 0, originClosed: 0, sourceRequests: [],
    actualFactoryRunner: 0, brandBeforeOuterBind: 0, actualFactoryCapacityErrors: 0, nativeSessionsClosed: 0, productionLegacyCallback: 0, actualLegacyFactory: 0 };
  async function run(mode = 'complete', { legacy = false, contextOverride = null, spoofPayload = null,
    unbrandedHandle = false, executionOverride = null, frozenOverride = null,
    actualFactory = false, changeOwnerAfterCopy = false, productionLegacy = false,
    preparedOverride = null, bundleOverride = null, reviewOnly = false, selectedDuties = duties,
    gapDuty = null, findingSeverity = null, deterministicPending = false } = {}) {
    if (productionLegacy) assert(legacy && actualFactory, 'Production legacy control requires actual factory and no V2 context.');
    if (actualFactory) await releaseDocumentSessions(root);
    const captured = captureOriginalDutyPublication(state);
    const current = () => originalDutyPublicationCurrent(state, captured);
    const cohortContext = contextOverride ?? { owner: captured.owner, sourceRunId: captured.sourceRunId };
    const deadlineAt = Date.now() + 5000;
    const activeTruth = actualFactory ? { ...frozenTruth,
      reviewerExecution: { ...frozenTruth.reviewerExecution, formatRepairAttempts: mode === 'same-worker-drop' ? 3 : 0 } } : frozenTruth;
    const number = ++nextRound;
    const result = { status: 'passed', diagnostics: deterministicPending ? [{ ruleId: 'DETERMINISTIC-EVIDENCE-PENDING',
      severity: 'pending', path: proposal, message: 'The deterministic checker retains an unresolved evidence prerequisite.' }] : [], diffs: [], metadata: {
      roundId: '20261123T010101Z-' + number.toString(16).padStart(8, '0'), generatedAt: '2026-11-23T01:01:01Z',
      stage: 'proposal', artifactType: 'openspec-plan', triggerFile: proposal, artifactFiles: snapshot.documents.map(file => file.path),
      ruleSetIds: [], configSource: 'offline-fixture',
      bundleComplete: true, inputs: snapshot.documents.map(file => ({ ...file })), inputDigest: sha256(snapshot.documents) } };
    const prepared = preparedOverride ?? { projectRoot: root, result,
      reviewContext: { reviewer: null, specification: null, nodeReviewEnabled: true, workflow: null,
        ...(productionLegacy ? { semanticReviewTimeoutMs: 5000, maxOutputTokens: 4096 } : {}) },
      finalizeContext: { output: { persist: true, mode: 'centralized', directory: '.runtime-correction/offline-results' },
        cwd: root, triggerFile: path.join(root, proposal), stageSpecification: null, maxFeedbackChars: 12000,
        locale: 'en', includePublicCommandContext: false, editableArtifactFiles: null, outputKey: null } };
    const worker = async options => {
      if (spoofPayload) throw Object.assign(new Error('UNTRUSTED_ERROR_PROPERTY'), { originalDutyCapacityFailure: spoofPayload });
      const semantic = options.evidence.semanticRequest;
      calls.sourceRequests.push(structuredClone(semantic));
      if (!legacy) {
        assert.deepEqual(semantic.runtimeV2, frozenTruth);
        assert.equal(semantic.originalRequirements.sourceRole, 'ORIGINAL_USER_DUTY_ACCOUNTING_ONLY_FROZEN_GROUND_TRUTH_UNCHANGED');
        assert.deepEqual(semantic.originalRequirements.materials, []);
        assert.deepEqual(semantic.originalRequirements.projectFiles, []);
        assert.deepEqual(semantic.originalRequirements.referencedFiles, []);
      }
      const tools = await createDocumentTools({ projectRoot: root, semantic,
        requestPath: options.request.semanticReviewRequestPath, signal: state.reviewController.signal,
        active: () => assert.equal(current(), true), originalDutyCohortContext: options.evidence.originalDutyCohortContext });
      let coverage = null;
      if (mode !== 'unopened') {
        assert.equal(tools.originalDutyAccountingEnabled, true);
        const source = semantic.originalRequirements.userMessages[0];
        if (mode === 'tamper-source') {
          if (typeof source.text === 'string') source.text += 'CHANGED';
          else await fs.appendFile(source.path, 'CHANGED');
        }
        const read = await tools.execute({ action: 'read_original', ref: source.ref, start: 2, count: duties.length + 1 });
        const values = selectedDuties.map(requirement => ({ originalSourceAnchorId: read.anchor.anchorId, requirement }));
        let page = await tools.execute({ action: 'stage_original_duties', duties: values }), items = [];
        while (true) {
          items.push(...page.items);
          if (page.nextStart === null) break;
          page = await tools.execute({ action: 'stage_original_duties', start: page.nextStart, count: 20 });
        }
        for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
        let rows = items.map(item => ({ originalDutyId: item.originalDutyId, originalSourceAnchorId: item.originalSourceAnchorId,
          requirement: item.requirement, disposition: 'COVERED', reason: 'The current plan explicitly states the whole canonical clause.',
          targets: [{ path: proposal, start: plannedDuties.indexOf(item.requirement) + 2, end: plannedDuties.indexOf(item.requirement) + 2 }] }));
        if (mode === 'omission') rows = rows.slice(0, -1);
        if (mode === 'narrowing') {
          const index = rows.findIndex(row => row.requirement === duties[0]);
          rows[index] = { ...rows[index], requirement: 'Preserve output.' };
        }
        if (mode === 'count-overflow') rows = [{ originalSourceAnchorId: read.anchor.anchorId,
          requirement: extraDuty, disposition: 'UNVERIFIED', reason: 'This distinct original-source duty has not been staged.', targets: [] }];
        coverage = await tools.verifyRequirementCoverage(rows);
      } else coverage = await tools.verifyRequirementCoverage();
      const actualCoverage = unbrandedHandle && coverage ? JSON.parse(JSON.stringify(coverage)) : coverage;
      return { sessionId: 'fake-transport-' + number, result: { summary: 'Offline original-duty assessment', findings: [], edits: [] },
        originalRequirementCoverage: actualCoverage, originalDutyAccounting: tools.originalDutyAccounting(),
        close: async () => { calls.handlesClosed++; } };
    };
    let factory = async () => { throw new Error('SDK_FACTORY_ROUTE_FORBIDDEN'); };
    factory.handoff = async options => {
      calls.handoff++; assert.equal(options.deadlineAt, deadlineAt);
      assert.deepEqual(options.reviewer, frozenTruth.reviewerExecution);
      await options.originHandle?.close(); return worker(options);
    };
    if (actualFactory) {
      let registered, semanticPath, runnerCallsThisInvocation = 0;
      const runner = async params => {
        calls.actualFactoryRunner++; runnerCallsThisInvocation++;
        assert(runnerCallsThisInvocation <= (mode === 'same-worker-drop' || productionLegacy && (mode === 'count-overflow' || targetBytes === 65537) ? 4 : 1), 'Fixed credential-free runner invocation cap.');
        assert(path.resolve(params.sessionFile).startsWith(root + path.sep));
        const semantic = JSON.parse(await fs.readFile(semanticPath, 'utf8'));
        if (productionLegacy) {
          assert.equal(semantic.runtimeV2, undefined);
          assert.equal(semantic.originalRequirements.digest, originals.digest);
          assert.equal(await fs.realpath(semantic.projectRoot), root, 'Serialized projectRoot must resolve to the exact canonical fixture root.');
          assert.equal(semantic.originalRequirements.schemaVersion, originals.schemaVersion);
          assert.equal(semantic.originalRequirements.sourceRole, undefined);
        } else {
          assert.deepEqual(semantic.runtimeV2, activeTruth);
          assert.equal(semantic.originalRequirements.sourceRole,
            'ORIGINAL_USER_DUTY_ACCOUNTING_ONLY_FROZEN_GROUND_TRUTH_UNCHANGED');
        }
        const tool = registered({ sessionId: params.sessionId, runId: params.runId }); assert(tool);
        const invoke = async args => JSON.parse((await tool.execute('offline-native', args)).content[0].text);
        const source = semantic.originalRequirements.userMessages[0];
        const read = await invoke({ action: 'read_original', ref: source.ref, start: 2, count: duties.length + 1 });
        let page = await invoke({ action: 'stage_original_duties', duties: selectedDuties.map(requirement => ({
          originalSourceAnchorId: read.anchor.anchorId, requirement })) }), items = [];
        while (true) {
          items.push(...page.items); if (page.nextStart === null) break;
          page = await invoke({ action: 'stage_original_duties', start: page.nextStart, count: 20 });
        }
        for (const file of await invoke({ action: 'manifest' })) await invoke({ action: 'read', path: file.path, start: 1, count: 200 });
        let rows = items.map(item => ({ originalDutyId: item.originalDutyId, originalSourceAnchorId: item.originalSourceAnchorId,
          requirement: item.requirement, disposition: 'COVERED', reason: 'The exact current plan clause is read.',
          targets: [{ path: proposal, start: plannedDuties.indexOf(item.requirement) + 2, end: plannedDuties.indexOf(item.requirement) + 2 }] }));
        if (gapDuty) rows = rows.map(row => row.requirement === gapDuty ? { ...row, disposition: 'GAP',
          reason: 'Every declared plan line is read; this exact original duty is absent.', targets: [] } : row);
        if (mode === 'invalid-coverage') rows[0].targets = [{ path: proposal, start: 1000, end: 1000 }];
        if (mode === 'invalid-explicit-duty-id') rows[0].originalDutyId = 'f'.repeat(64);
        if (mode === 'omission') rows = rows.slice(0, -1);
        if (mode === 'narrowing') { const index = rows.findIndex(row => row.requirement === duties[0]); rows[index] = { ...rows[index], requirement: 'Preserve output.' }; }
        if (mode === 'count-overflow') rows = [{ originalSourceAnchorId: read.anchor.anchorId,
          requirement: extraDuty, disposition: 'UNVERIFIED', reason: 'This distinct original-source duty has not been staged.', targets: [] }];
        if (mode === 'same-worker-drop' && runnerCallsThisInvocation === 1) rows = [{
          originalSourceAnchorId: read.anchor.anchorId, requirement: extraDuty, disposition: 'UNVERIFIED',
          reason: 'The distinct49th current original clause is also a discovered duty.', targets: [] }, ...rows.slice(0, 47)];
        await fs.appendFile(params.sessionFile, JSON.stringify({ prompt: params.prompt }) + '\n');
        if (changeOwnerAfterCopy) state.projectScope.fingerprint = 'changed-after-input-copy';
        // Model JSON is deliberately unbranded. Only the ACTUAL factory's
        // post-parse document verification may issue a host coverage receipt.
        const findings = findingSeverity ? [{ ruleId: 'AGENT-ORIGINAL-DUTY-GAP', severity: findingSeverity,
          path: proposal, message: 'The current plan omits an original duty.', evidence: ['Entire current declared plan read; missing duty: ' + gapDuty] }] : [];
        return { payloads: [{ text: JSON.stringify({ summary: 'Offline actual-factory assessment', findings, edits: [],
          originalRequirementCoverage: rows }) }], meta: {} };
      };
      runner.close = async () => { calls.nativeSessionsClosed++; };
      const api = { runtime: { agent: { runEmbeddedAgent: runner } },
        config: { agents: { defaults: { model: 'fixture/model' } } }, registerTool: provider => { registered = provider; } };
      registerDocumentTools(api);
      const nativeFactory = createOpenClawReviewerFactory(api, { runEmbeddedAgent: runner, abortSignal: state.reviewController.signal });
      const observedFactory = async (options, launch) => {
        semanticPath = options.request.semanticReviewRequestPath;
        if (!productionLegacy) assert.equal(options.reviewer.formatRepairAttempts, mode === 'same-worker-drop' ? 3 : 0);
        if (!productionLegacy) assert.equal(options.deadlineAt, deadlineAt);
        try {
          const handle = await launch(options);
          assert.equal(hostOriginalCoverageCurrent(handle.originalRequirementCoverage), true);
          calls.brandBeforeOuterBind++; return handle;
        } catch (error) {
          if (mode === 'count-overflow' || mode === 'same-worker-drop' || targetBytes === 65537) {
            assert(hostOriginalCapacityFailure(error)); calls.actualFactoryCapacityErrors++;
          }
          throw error;
        }
      };
      factory = async options => {
        calls.actualLegacyFactory++; assert(productionLegacy);
        return observedFactory(options, nativeFactory);
      };
      factory.handoff = async options => {
        calls.handoff++; return observedFactory(options, nativeFactory.handoff);
      };
    }
    try {
    let semanticReview;
    if (productionLegacy) {
      calls.productionLegacyCallback++;
      // This is the production callback's ordinary legacy invokeFork branch:
      // RuntimeV2 host stays enabled; no artifactReviewContext is fabricated.
      semanticReview = await productionLegacyReview(state, { reviewerFactory: factory,
        plan: { runtimeV2: { enabled: true, artifactCorrection: { originalRequirementsEnabled: true,
          groundTruthReviewEnabled: false, stageMetricsEnabled: false }, reviewers: { artifactReviewer: { model: 'fixture/model' } } } } },
        { session_id: state.sessionId, cwd: root }, prepared, { taskId: state.scopeTaskId, originalRequirements: originals }, bundleOverride);
    } else semanticReview = await runSemanticReview({ input: { session_id: state.sessionId, cwd: root }, prepared,
      runtimeV2Context: legacy ? null : frozenOverride ?? activeTruth,
      runtimeV2Handle: legacy ? null : { close: async () => { calls.originClosed++; } },
      runtimeV2ExecutionContext: { projectRoot: root, sessionCwd: root, parentSessionId: state.sessionId,
        taskId: state.scopeTaskId, deadlineAt, ...executionOverride },
      runtimeV2ReviewerFactory: factory, originalRequirements: originals,
      originalDutyCohortContext: cohortContext, originalDutyPublicationGuard: current,
      invokeFork: async options => {
        calls.legacy++;
        if (!legacy) throw new Error('NATIVE_TEST_MUST_NOT_FORCE_LEGACY');
        const requestPath = options.prompt.match(/--request "([^"]+)"/u)[1];
        const handle = await worker({ evidence: { semanticRequest: options.semanticRequest, originalDutyCohortContext: cohortContext },
          request: { semanticReviewRequestPath: requestPath } });
        try {
          return { sessionId: handle.sessionId, review: handle.result,
            originalRequirementCoverage: handle.originalRequirementCoverage, originalDutyAccounting: handle.originalDutyAccounting };
        } finally { await handle.close(); }
      } });
    const finalized = reviewOnly ? null : await finalizeArtifactCheck(prepared, semanticReview);
    return { semanticReview, finalized, captured };
    } finally { if (actualFactory) await releaseDocumentSessions(root); }
  }
  const publish = completed => publishOriginalDutyArtifact(state, { file: path.join(root, proposal),
    finalized: completed.finalized, captured: completed.captured, sources: originals.userMessages });
  return { root, proposal, tasks, duties, originals, snapshot, state, frozenTruth, calls, run, publish };
}

test('native production request→validated handle→real finalizer→normal publication retains an omitted whole duty', async t => {
  const f = await fixture(t, { tail: 'Original-source padding '.repeat(1600) });
  const completed = await f.run('omission');
  assert.equal(completed.semanticReview.status, 'completed'); assert.equal(f.calls.legacy, 0); assert.equal(f.calls.handoff, 1);
  assert.equal(f.calls.sourceRequests[0].originalRequirements.userMessages[0].text, undefined, 'Production source files, not inline-only test strings, were read.');
  const metadata = completed.finalized.result.metadata.semanticReview, receipt = metadata.originalRequirementCoverage;
  assert.equal(receipt.rows.length, 3); assert.equal(receipt.rows.filter(row => row.disposition === 'UNVERIFIED').length, 1);
  assert.deepEqual(receipt.originalDutyOwnerBinding.owner, knownOriginalOwner(f.state));
  assert.equal(receipt.runId, f.state.nativeRunId); assert.equal(receipt.taskId, f.state.scopeTaskId); assert.equal(receipt.sessionId, f.state.sessionId);
  assert.equal(metadata.originalDutyAccounting.stagedCount, 3); assert(hostOriginalCoverageCurrent(receipt));
  assert.equal(await f.publish(completed), true);
  assert.deepEqual(new Set(knownOriginalObligations(f.state).items.map(item => item.requirement)), new Set(baseDuties));
  assert.equal(f.calls.originClosed, 1); assert.equal(f.calls.handlesClosed, 1);
});

test('native normal publication retains the full conditional canonical duty when final wording narrows', async t => {
  const f = await fixture(t), completed = await f.run('narrowing');
  const row = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage.rows.find(item => item.originalDutyAccountingIssue === 'CANONICAL_DUTY_CHANGED');
  assert(row); assert.equal(row.requirement, baseDuties[0]); assert.equal(row.disposition, 'UNVERIFIED');
  assert.equal(await f.publish(completed), true); assert.equal(knownOriginalObligations(f.state).items.length, 3);
});

test('native49distinct original union remains sticky U after failed publication and a complete48 subset attempt', async t => {
  const f = await fixture(t, { duties: manyDuties }), failed = await f.run('count-overflow');
  const receipt = failed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(failed.semanticReview.status, 'failed'); assert.equal(failed.finalized.result.status, 'failed');
  assert.equal(failed.finalized.result.classification, 'CHECKER_FAILURE'); assert.equal(receipt.rows.length, 49);
  assert.equal(receipt.originalDutyAccounting.status, 'UNVERIFIED_CAPACITY');
  assert.equal(await f.publish(failed), false);
  const pending = knownOriginalObligations(f.state);
  assert.equal(pending.capacityUnverified, true); assert.equal(pending.protectionLimitExceeded, true);
  assert.equal(pending.observedProtectedCandidateCount, 49); assert(pending.requiredCanonicalCandidateIds.length <= 48);
  const unopened = await f.run('unopened'); assert.equal(await f.publish(unopened), false);
  assert.deepEqual(knownOriginalObligations(f.state), pending);
  const subset = await f.run('complete'); assert.equal(await f.publish(subset), false);
  assert.deepEqual(knownOriginalObligations(f.state), pending);
});

test('legacy actual semantic/failed merge path also retains host capacity U without a model receipt shortcut', async t => {
  const f = await fixture(t, { duties: manyDuties }), failed = await f.run('count-overflow', { legacy: true });
  assert.equal(f.calls.handoff, 0); assert.equal(f.calls.legacy, 1);
  assert.equal(failed.finalized.result.metadata.semanticReview.originalRequirementCoverage.rows.length, 49);
  assert.equal(await f.publish(failed), false); assert.equal(knownOriginalObligations(f.state).capacityUnverified, true);
});

for (const bytes of [65536, 65537]) test('native actual serialized cohort byte boundary ' + bytes + ' survives production finalization', async t => {
  const f = await fixture(t, { targetBytes: bytes }), completed = await f.run('complete');
  const receipt = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert(receipt);
  if (bytes === 65536) {
    assert.equal(completed.semanticReview.status, 'completed'); assert.equal(await f.publish(completed), true);
    assert.equal(knownOriginalObligations(f.state).items.length, 3);
  } else {
    assert.equal(completed.semanticReview.status, 'failed'); assert.equal(receipt.originalDutyAccounting.capacity.bytes, 65537);
    assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state).capacity.bytes, 65537);
  }
});

test('native large UTF8 original anchors exceed unchanged byte capacity through the failed production join', async t => {
  const f = await fixture(t, { duties: manyDuties, sourceRef: '原'.repeat(400) }), completed = await f.run('complete');
  const receipt = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(completed.semanticReview.status, 'failed'); assert.equal(receipt.rows.length, 48);
  assert(receipt.originalDutyAccounting.capacity.bytes > 65536);
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state).unavailableReason, 'OBSERVATION_COHORT_LIMIT');
});

test('unopened native method keeps candid NOT_EXERCISED and does not invent an original cohort', async t => {
  const f = await fixture(t), completed = await f.run('unopened');
  assert.equal(completed.finalized.result.metadata.semanticReview.originalDutyAccounting.status, 'NOT_EXERCISED');
  assert.equal(completed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state), null);
});

test('plain model/error properties and JSON receipt lookalikes cannot acquire host publication provenance', async t => {
  const f = await fixture(t, { duties: manyDuties }), genuine = await f.run('count-overflow');
  const lookalike = JSON.parse(JSON.stringify(genuine.finalized.result.metadata.semanticReview.originalRequirementCoverage));
  const spoofed = await f.run('complete', { spoofPayload: lookalike });
  assert.equal(spoofed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(spoofed), false); assert.equal(knownOriginalObligations(f.state), null);
  const plain = { status: 'failed', error: 'plain', findings: [], originalRequirementCoverage: lookalike,
    originalDutyAccounting: lookalike.originalDutyAccounting };
  const result = mergeSemanticReview({ status: 'passed', diagnostics: [], diffs: [], metadata: { triggerFile: f.proposal } }, plain);
  assert.equal(result.metadata.semanticReview.originalRequirementCoverage, undefined);
});

test('an unbranded successful handle cannot promote model coverage fields through production merge', async t => {
  const f = await fixture(t), completed = await f.run('complete', { unbrandedHandle: true });
  assert.equal(completed.semanticReview.status, 'failed');
  assert.equal(completed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state), null);
});

test('persisted JSON is evidence only and cannot replace the live host receipt at normal publication', async t => {
  const f = await fixture(t), completed = await f.run('complete');
  const resultPath = completed.finalized.writtenFiles.find(file => file.endsWith('result.json'));
  const diskResult = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  assert.equal(diskResult.metadata.semanticReview.originalRequirementCoverage.rows.length, 3);
  assert.equal(await publishOriginalDutyArtifact(f.state, { file: path.join(f.root, f.proposal),
    finalized: { result: diskResult }, captured: completed.captured, sources: f.originals.userMessages }), false);
  assert.equal(knownOriginalObligations(f.state), null); assert.equal(await f.publish(completed), true);
});

test('current run/task/session/scope/revision/controller lifecycle mutations reject normal publication', async t => {
  const f = await fixture(t), completed = await f.run('complete');
  for (const [key, value] of [['nativeRunId', 'other-run'], ['scopeTaskId', 'other-task'], ['sessionId', 'other-session'],
    ['sessionKey', 'other-key'], ['enabledRevision', 4], ['reviewController', new AbortController()], ['scopeClosed', true], ['nativeInvalidated', true]]) {
    const before = f.state[key]; f.state[key] = value;
    assert.equal(await f.publish(completed), false, key); assert.equal(knownOriginalObligations(f.state), null);
    if (before === undefined) delete f.state[key]; else f.state[key] = before;
  }
  f.state.projectScope.fingerprint = 'other-scope'; assert.equal(await f.publish(completed), false);
  f.state.projectScope.fingerprint = 'scope-offline'; f.state.reviewController.abort();
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state), null);
});

test('foreign starting owner and changed original source cannot stage or publish production authority', async t => {
  const f = await fixture(t), context = { owner: { ...knownOriginalOwner(f.state), taskId: 'foreign' }, sourceRunId: f.state.nativeRunId };
  const wrong = await f.run('complete', { contextOverride: context });
  assert.equal(wrong.semanticReview.status, 'failed'); assert.equal(f.calls.handoff, 0);
  assert.equal(await f.publish(wrong), false);
  for (const options of [{ executionOverride: { projectRoot: path.join(f.root, 'foreign') } },
    { executionOverride: { taskId: 'foreign' } }, { frozenOverride: { ...f.frozenTruth, taskId: 'foreign' } }]) {
    const rejected = await f.run('complete', options);
    assert.equal(rejected.semanticReview.status, 'failed'); assert.equal(f.calls.handoff, 0);
    assert.equal(await f.publish(rejected), false);
  }
  const changed = await f.run('tamper-source'); assert.equal(changed.semanticReview.status, 'failed');
  assert.equal(changed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(changed), false); assert.equal(knownOriginalObligations(f.state), null);
});

test('current plan hash changes or in-memory receipt mutation cannot publish a stale normal result', async t => {
  const f = await fixture(t), completed = await f.run('complete');
  await fs.appendFile(path.join(f.root, f.proposal), '\nChanged plan.\n');
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state), null);
  const g = await fixture(t), fresh = await g.run('complete');
  const receipt = fresh.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(hostOriginalCoverageCurrent(receipt), true);
  receipt.rows[0].requirement = 'Changed host receipt.';
  assert.equal(hostOriginalCoverageCurrent(receipt), false);
  assert.equal(await g.publish(fresh), false); assert.equal(knownOriginalObligations(g.state), null);
});

test('an actual later failed production publication cannot replace a valid first canonical cohort', async t => {
  const f = await fixture(t, { duties: manyDuties }), first = await f.run('omission');
  assert.equal(await f.publish(first), true); const before = JSON.stringify(knownOriginalObligations(f.state));
  const later = await f.run('count-overflow'); assert.equal(later.finalized.result.status, 'failed');
  assert.equal(await f.publish(later), false); assert.equal(JSON.stringify(knownOriginalObligations(f.state)), before);
});

test('a later finalized conditional atom is individually due at Stop while first-cohort N stays immutable', async t => {
  const f = await fixture(t), a = baseDuties[1], b = baseDuties[0];
  assert(f.originals.userMessages[0].text.includes(b), 'B was in the full original from the start.');
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [a] })), true);
  const first = knownOriginalObligations(f.state), oldReader = knownOriginalObligationReader(f.state);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [a, b] })), true);
  assert.deepEqual(knownOriginalObligations(f.state), first, 'The evaluation cohort and all its canonical fields remain unchanged.');
  const live = knownOriginalObservationSnapshot(f.state);
  assert.deepEqual(live.items.map(item => item.requirement), [a, b]);
  assert.equal(live.observationLedger.initialCohortId, first.id);
  assert.deepEqual(live.observationLedger.initialCandidateIds, first.items.map(item => item.id));
  assert.equal(live.observationLedger.revision, 1);
  assert.throws(oldReader, { code: 'STOP_TASK_INPUT_CHANGED' }, 'An existing Stop snapshot cannot stay fresh after admitted new knowledge.');
  await stopVisibleUncertainty(f, { late: true });
});

test('later subsets and exact repeats cannot erase an admitted atom or advance its revision', async t => {
  const f = await fixture(t), [a,b,c] = baseDuties;
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [a] })), true);
  const first = knownOriginalObligations(f.state);
  const later = await f.run('complete', { selectedDuties: [a,b] });
  assert.equal(await f.publish(later), true);
  const retained = knownOriginalObservationSnapshot(f.state), reader = knownOriginalObligationReader(f.state);
  assert.equal(await f.publish(later), false);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [a] })), false);
  assert.deepEqual(reader(), retained);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [c] })), true);
  const next = knownOriginalObservationSnapshot(f.state);
  assert.deepEqual(next.items.map(item => item.requirement), [a,b,c]);
  assert.equal(next.observationLedger.revision, 2);
  assert.deepEqual(knownOriginalObligations(f.state), first);
  assert.throws(reader, { code: 'STOP_TASK_INPUT_CHANGED' });
});

for (const verdict of ['failed', 'warning', 'pending'])
  test('a completed source-valid ' + verdict + ' artifact retains a newly discovered GAP duty', async t => {
    const [a,b] = baseDuties, f = await fixture(t, { omittedPlanDuties: [b] });
    const firstReview = await f.run('complete', { actualFactory: true, selectedDuties: [a] });
    assert.equal(await f.publish(firstReview), true);
    const first = knownOriginalObligations(f.state), oldReader = knownOriginalObligationReader(f.state);
    const completed = await f.run('complete', { actualFactory: true, selectedDuties: [a,b], gapDuty: b,
      findingSeverity: verdict === 'pending' ? null : verdict === 'failed' ? 'error' : 'warning',
      deterministicPending: verdict === 'pending' });
    const result = completed.finalized.result, receipt = result.metadata.semanticReview.originalRequirementCoverage;
    assert.equal(completed.semanticReview.status, 'completed');
    assert.equal(result.metadata.semanticReview.status, 'completed');
    assert.equal(result.status, verdict, 'The real finalizer keeps the business verdict; it is never retagged PASS.');
    assert.equal(result.metadata.bundleComplete, true);
    assert.equal(hostOriginalCoverageCurrent(receipt), true);
    assert.equal(receipt.originalDutyAccounting.status, 'STAGED');
    const row = receipt.rows.find(row => row.requirement === b);
    assert.equal(row.disposition, 'GAP'); assert.deepEqual(row.targets, []);
    assert.equal(f.calls.actualFactoryRunner, 2, 'Both tables use the actual native factory with bounded fake transport.');
    assert.equal(await f.publish(completed), true, 'Actual publication boundary retains B despite the business gap.');
    assert.equal(result.status, verdict);
    assert.deepEqual(knownOriginalObligations(f.state), first);
    const live = knownOriginalObservationSnapshot(f.state);
    assert.deepEqual(live.items.map(item => item.requirement), [a,b]);
    assert.equal(live.observationLedger.initialCohortId, first.id);
    assert.deepEqual(live.observationLedger.initialCandidateIds, first.items.map(item => item.id));
    assert.throws(oldReader, { code: 'STOP_TASK_INPUT_CHANGED' });
    assert.deepEqual(knownOriginalObligationReader(f.state)().items, live.items);
  });

test('a genuine native coverage-validation failure cannot import a late original duty', async t => {
  const f = await fixture(t), [a,b] = baseDuties;
  assert.equal(await f.publish(await f.run('complete', { actualFactory: true, selectedDuties: [a] })), true);
  const first = knownOriginalObligations(f.state);
  const failed = await f.run('invalid-coverage', { actualFactory: true, selectedDuties: [a,b] });
  assert.equal(failed.semanticReview.status, 'failed');
  assert.equal(failed.finalized.result.metadata.semanticReview.status, 'failed');
  assert.equal(failed.finalized.result.status, 'failed');
  assert.equal(failed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(failed), false);
  assert.deepEqual(knownOriginalObservationSnapshot(f.state), first);
});

test('a genuine mixed staged and unkeyed canonical table retains every validated late duty', async t => {
  const f = await fixture(t), [a,b] = baseDuties;
  assert.equal(await f.publish(await f.run('complete', { actualFactory: true, selectedDuties: [a] })), true);
  const first = knownOriginalObligations(f.state), oldReader = knownOriginalObligationReader(f.state);
  // This existing worker mode returns one unkeyed newly discovered original;
  // the actual verifier also retains every omitted staged duty as UNVERIFIED.
  // The small table is below capacity, so no capacity-failure bypass is used.
  const completed = await f.run('count-overflow', { actualFactory: true, selectedDuties: [a,b] });
  const result = completed.finalized.result, receipt = result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(completed.semanticReview.status, 'completed');
  assert.equal(result.status, 'passed');
  assert.equal(hostOriginalCoverageCurrent(receipt), true);
  assert.equal(receipt.originalDutyAccounting.status, 'STAGED');
  assert.equal(receipt.originalDutyAccounting.stagedCount, 2);
  assert.equal(receipt.rows.length, 3);
  const unkeyed = receipt.rows.find(row => row.requirement === extraDuty);
  assert(unkeyed); assert.equal(Object.hasOwn(unkeyed, 'originalDutyId'), false);
  assert.equal(unkeyed.disposition, 'UNVERIFIED');
  assert(receipt.rows.filter(row => row.originalDutyId).every(row => row.disposition === 'UNVERIFIED'));
  assert.equal(await f.publish(completed), true, 'A legitimate unkeyed row cannot discard the other validated late atoms.');
  const live = knownOriginalObservationSnapshot(f.state);
  assert.deepEqual(live.items.map(item => item.requirement).sort(), [a,b,extraDuty].sort());
  assert.deepEqual(live.items.map(item => item.id).sort(), knownOriginalItems(receipt.rows).map(item => item.id).sort());
  assert.equal(live.observationLedger.initialCohortId, first.id);
  assert.deepEqual(knownOriginalObligations(f.state), first);
  assert.throws(oldReader, { code: 'STOP_TASK_INPUT_CHANGED' });
  assert.deepEqual(knownOriginalObligationReader(f.state)().items, live.items);
});

test('a malformed explicit stage ID fails real producer validation and cannot import late atoms', async t => {
  const f = await fixture(t), [a,b] = baseDuties;
  assert.equal(await f.publish(await f.run('complete', { actualFactory: true, selectedDuties: [a] })), true);
  const first = knownOriginalObligations(f.state);
  const failed = await f.run('invalid-explicit-duty-id', { actualFactory: true, selectedDuties: [a,b] });
  assert.equal(failed.semanticReview.status, 'failed');
  assert.equal(failed.finalized.result.metadata.semanticReview.status, 'failed');
  assert.equal(failed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(failed), false);
  assert.deepEqual(knownOriginalObservationSnapshot(f.state), first);
});

test('concurrent finalized first observations retain both atoms without replacing the first cohort', async t => {
  const f = await fixture(t), [a,b] = baseDuties;
  const first = await f.run('complete', { selectedDuties: [a] });
  const second = await f.run('complete', { selectedDuties: [b] });
  assert.deepEqual(await Promise.all([f.publish(first), f.publish(second)]), [true,true]);
  assert.deepEqual(knownOriginalObligations(f.state).items.map(item => item.requirement), [a]);
  assert.deepEqual(knownOriginalObservationSnapshot(f.state).items.map(item => item.requirement), [a,b]);
  assert.equal(knownOriginalObservationSnapshot(f.state).observationLedger.revision, 1);
});

for (const invalid of ['owner', 'run', 'controller', 'abort', 'forget', 'missing-host-token'])
  test('queued publication cannot outlive its enqueued ' + invalid + ' context', async t => {
    const f = await fixture(t), [a,b] = baseDuties;
    const first = await f.run('complete', { selectedDuties: [a] });
    let second = await f.run('complete', { selectedDuties: [b] });
    if (invalid === 'missing-host-token') second = { ...second, finalized: JSON.parse(JSON.stringify(second.finalized)) };
    const original = fs.open;
    let enter, release, timer, blocked = false;
    const entered = new Promise(resolve => { enter = resolve; });
    const resumed = new Promise(resolve => { release = resolve; });
    fs.open = async function(file, ...args) {
      if (!blocked && path.resolve(String(file)) === path.join(f.root, f.proposal)) { blocked = true; enter(); await resumed; }
      return original.call(this, file, ...args);
    };
    let firstPending, secondPending;
    try {
      firstPending = f.publish(first);
      await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Plan validation did not start.')), 1000); })]);
      secondPending = f.publish(second);
      if (invalid === 'owner') f.state.projectScope = { fingerprint: 'changed-scope' };
      if (invalid === 'run') f.state.nativeRunId = 'changed-run';
      if (invalid === 'controller') f.state.reviewController = new AbortController();
      if (invalid === 'abort') f.state.reviewController.abort();
      if (invalid === 'forget') forgetKnownOriginalObligations(f.state);
    } finally { clearTimeout(timer); release(); fs.open = original; }
    assert.deepEqual(await Promise.all([firstPending,secondPending]), invalid === 'missing-host-token' ? [true,false] : [false,false]);
    assert.deepEqual(knownOriginalObligations(f.state)?.items.map(item => item.requirement) ?? [], invalid === 'missing-host-token' ? [a] : []);
    assert.deepEqual(knownOriginalObservationSnapshot(f.state), knownOriginalObligations(f.state));
  });

for (const invalid of ['json-lookalike', 'raw-stage-only', 'unbranded-read-proof', 'unopened', 'semantic-incomplete', 'incomplete', 'foreign-owner', 'revision', 'controller', 'source', 'plan'])
  test('late observation rejects ' + invalid + ' without importing a new atom', async t => {
    const f = await fixture(t), [a,b] = baseDuties;
    assert.equal(await f.publish(await f.run('complete', { selectedDuties: [a] })), true);
    const first = knownOriginalObligations(f.state);
    let completed = await f.run(invalid === 'unopened' ? 'unopened' : 'complete', {
      selectedDuties: [a,b], unbrandedHandle: invalid === 'unbranded-read-proof' });
    const restore = { projectScope: f.state.projectScope, enabledRevision: f.state.enabledRevision, reviewController: f.state.reviewController };
    if (invalid === 'json-lookalike') completed = { ...completed, finalized: JSON.parse(JSON.stringify(completed.finalized)) };
    if (invalid === 'raw-stage-only') completed = { ...completed, finalized: { result: { status: 'passed', metadata: {
      semanticReview: { status: 'completed', originalRequirementCoverage: { status: 'STAGED', items: [a,b] } } } } } };
    if (invalid === 'semantic-incomplete') completed.finalized.result.metadata.semanticReview.status = 'failed';
    if (invalid === 'incomplete') completed.finalized.result.metadata.bundleComplete = false;
    if (invalid === 'foreign-owner') f.state.projectScope = { fingerprint: 'foreign-scope' };
    if (invalid === 'revision') f.state.enabledRevision++;
    if (invalid === 'controller') f.state.reviewController = new AbortController();
    if (invalid === 'source') f.originals.userMessages[0].text += ' Source changed.';
    if (invalid === 'plan') await fs.appendFile(path.join(f.root, f.proposal), '\nPlan changed.\n');
    assert.equal(await f.publish(completed), false);
    Object.assign(f.state, restore);
    assert.deepEqual(knownOriginalObligations(f.state), first);
    assert.deepEqual(knownOriginalObservationSnapshot(f.state), first, 'No rejected input acquires ledger authority.');
  });

test('the aggregate validated late set keeps unchanged count capacity sticky without replacing first N', async t => {
  const f = await fixture(t, { duties: manyDuties, includeExtraInPlan: true });
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: manyDuties.slice(0,24) })), true);
  const first = knownOriginalObligations(f.state);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [...manyDuties.slice(24),extraDuty] })), false);
  const pending = knownOriginalObservationSnapshot(f.state);
  assert.equal(pending.unavailableReason, 'OBSERVATION_LEDGER_LIMIT');
  assert.equal(pending.observedCandidateCount, 49);
  assert.equal(pending.capacity.maximumCount, 48);
  assert.equal(pending.capacity.maximumBytes, 65536);
  assert.deepEqual(pending.items, []);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: manyDuties.slice(0,24) })), false);
  assert.deepEqual(knownOriginalObservationSnapshot(f.state), pending, 'A smaller publication cannot clear the prior uncertainty.');
  assert.deepEqual(knownOriginalObligations(f.state), first);
});

test('late provenance participates in the unchanged serialized-byte capacity', async t => {
  const f = await fixture(t, { includeExtraInPlan: true, targetBytes: 65536 });
  assert.equal(await f.publish(await f.run('complete')), true);
  const first = knownOriginalObligations(f.state);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [baseDuties[0],extraDuty] })), false);
  const pending = knownOriginalObservationSnapshot(f.state);
  assert.equal(pending.unavailableReason, 'OBSERVATION_LEDGER_LIMIT');
  assert(pending.capacity.bytes > 65536);
  assert(Buffer.byteLength(JSON.stringify(pending)) <= 65536, 'The U summary must itself remain bounded.');
  assert.deepEqual(knownOriginalObligations(f.state), first);
});

test('near-cap long owner creates a bounded host-bound U summary that remains visible to actual Stop', async t => {
  const f = await fixture(t, { ownerTargetBytes: 65536 });
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [baseDuties[1]] })), true);
  const first = knownOriginalObligations(f.state);
  assert.equal(await f.publish(await f.run('complete', { selectedDuties: [baseDuties[2]] })), false);
  const pending = knownOriginalObservationSnapshot(f.state);
  assert.equal(pending.unavailableReason, 'OBSERVATION_LEDGER_LIMIT');
  assert.equal(pending.owner, undefined);
  assert.equal(pending.ownerBindingSha256, sha256(first.owner));
  assert.equal(pending.taskBindingSha256, sha256([first.owner.projectRoot, first.owner.taskId, first.owner.sessionId]));
  assert(Buffer.byteLength(JSON.stringify(pending)) <= 65536);
  assert.deepEqual(knownOriginalObligations(f.state), first);
  await stopVisibleUncertainty(f, { ledgerFailure: true });
});

test('actual native factory JSON input copy issues fresh host provenance before outer binding and publication', async t => {
  const f = await fixture(t), completed = await f.run('omission', { actualFactory: true });
  assert.equal(completed.semanticReview.status, 'completed'); assert.equal(f.calls.actualFactoryRunner, 1);
  assert.equal(f.calls.brandBeforeOuterBind, 1); assert.equal(f.calls.legacy, 0);
  const receipt = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(receipt.rows.length, 3); assert.equal(receipt.rows.filter(row => row.disposition === 'UNVERIFIED').length, 1);
  assert.equal(hostOriginalCoverageCurrent(receipt), true);
  assert.deepEqual(receipt.originalDutyOwnerBinding.owner, knownOriginalOwner(f.state));
  assert.equal(await f.publish(completed), true); assert.equal(knownOriginalObligations(f.state).items.length, 3);
  assert(f.calls.nativeSessionsClosed > 0);
});

test('actual native factory wrapper Error keeps49distinct duties sticky U through a later48 subset', async t => {
  const f = await fixture(t, { duties: manyDuties }), failed = await f.run('count-overflow', { actualFactory: true });
  assert.equal(f.calls.actualFactoryRunner, 1); assert.equal(f.calls.actualFactoryCapacityErrors, 1);
  assert.equal(failed.semanticReview.status, 'failed');
  assert.equal(failed.finalized.result.metadata.semanticReview.originalRequirementCoverage.rows.length, 49);
  assert.equal(await f.publish(failed), false); assert.equal(knownOriginalObligations(f.state).capacityUnverified, true);
  const pending = knownOriginalObligations(f.state); assert.equal(pending.observedProtectedCandidateCount, 49);
  const subset = await f.run('complete', { actualFactory: true });
  assert.equal(f.calls.actualFactoryRunner, 2); assert.equal(f.calls.brandBeforeOuterBind, 1);
  assert.equal(await f.publish(subset), false); assert.deepEqual(knownOriginalObligations(f.state), pending);
});

test('actual factory byte65537 rejection retains the post-copy host error receipt and aggregate U', async t => {
  const f = await fixture(t, { targetBytes: 65537 }), completed = await f.run('complete', { actualFactory: true });
  assert.equal(f.calls.actualFactoryRunner, 1); assert.equal(f.calls.actualFactoryCapacityErrors, 1);
  const receipt = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(receipt.originalDutyAccounting.capacity.bytes, 65537);
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state).capacity.bytes, 65537);
});

test('private current-owner guard outside actual factory JSON copies rejects a stale returned host receipt', async t => {
  const f = await fixture(t), completed = await f.run('complete', { actualFactory: true, changeOwnerAfterCopy: true });
  assert.equal(f.calls.actualFactoryRunner, 1); assert.equal(f.calls.brandBeforeOuterBind, 1);
  assert.equal(completed.semanticReview.status, 'failed');
  assert.match(completed.semanticReview.error, /DOCUMENT_ORIGINAL_DUTY_HOST_RECEIPT_INVALID/u);
  assert.equal(completed.finalized.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.equal(await f.publish(completed), false); assert.equal(knownOriginalObligations(f.state), null);
});


test('exact production legacy invokeFork calls actual factory after JSON copy and retains omitted staged duty through normal publication', async t => {
  const f = await fixture(t), completed = await f.run('omission', { legacy: true, actualFactory: true, productionLegacy: true });
  assert.equal(f.calls.productionLegacyCallback, 1); assert.equal(f.calls.actualLegacyFactory, 1);
  assert.equal(f.calls.actualFactoryRunner, 1); assert.equal(f.calls.handoff, 0); assert.equal(f.calls.legacy, 0);
  assert.equal(f.calls.brandBeforeOuterBind, 1); assert.equal(completed.semanticReview.status, 'completed');
  const receipt = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(hostOriginalCoverageCurrent(receipt), true); assert.equal(receipt.rows.length, 3);
  assert.equal(receipt.rows.filter(row => row.disposition === 'UNVERIFIED').length, 1);
  assert.deepEqual(receipt.originalDutyOwnerBinding.owner, knownOriginalOwner(f.state));
  assert.equal(await f.publish(completed), true);
  assert.deepEqual(new Set(knownOriginalObligations(f.state).items.map(item => item.requirement)), new Set(baseDuties));
  assert(f.calls.nativeSessionsClosed > 0);
});

test('exact production legacy actual factory49distinct capacity Error stays U after a full48 subset', async t => {
  const f = await fixture(t, { duties: manyDuties });
  const failed = await f.run('count-overflow', { legacy: true, actualFactory: true, productionLegacy: true });
  assert.equal(f.calls.productionLegacyCallback, 1); assert.equal(f.calls.actualLegacyFactory, 1);
  assert.equal(f.calls.actualFactoryCapacityErrors, 1); assert.equal(f.calls.actualFactoryRunner, 4); assert.equal(f.calls.handoff, 0); assert.equal(f.calls.legacy, 0);
  assert.equal(failed.semanticReview.status, 'failed'); assert.equal(failed.finalized.result.classification, 'CHECKER_FAILURE');
  const receipt = failed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(receipt.rows.length, 49); assert.equal(receipt.originalDutyAccounting.status, 'UNVERIFIED_CAPACITY');
  assert.equal(await f.publish(failed), false);
  const pending = knownOriginalObligations(f.state);
  assert.equal(pending.capacityUnverified, true); assert.equal(pending.protectionLimitExceeded, true);
  assert.equal(pending.observedProtectedCandidateCount, 49); assert(pending.requiredCanonicalCandidateIds.length <= 48);
  const subset = await f.run('complete', { legacy: true, actualFactory: true, productionLegacy: true });
  assert.equal(f.calls.productionLegacyCallback, 2); assert.equal(f.calls.actualLegacyFactory, 2);
  assert.equal(f.calls.actualFactoryRunner, 5); assert.equal(f.calls.brandBeforeOuterBind, 1);
  assert.equal(await f.publish(subset), false); assert.deepEqual(knownOriginalObligations(f.state), pending);
});


for (const legacy of [false, true]) test('actual ' + (legacy ? 'exact legacy' : 'native V2') + ' factory byte-only U recovers with every same canonical ID under a fresh shorter run', async t => {
  const f = await fixture(t, { targetBytes: 65537 });
  const options = { actualFactory: true, ...(legacy ? { legacy: true, productionLegacy: true } : {}) };
  const failed = await f.run('complete', options);
  assert.equal(failed.semanticReview.status, 'failed'); assert.equal(await f.publish(failed), false);
  const receipt = failed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  const expectedIds = knownOriginalItems(receipt.rows).map(row => row.id).sort();
  const pending = knownOriginalObligations(f.state), oldReader = knownOriginalObligationReader(f.state);
  assert.equal(pending.capacity.bytes, 65537); assert.equal(pending.protectedCanonicalCountWithinLimit, true);
  assert.deepEqual(pending.requiredCanonicalCandidateIds, expectedIds); assert.equal(expectedIds.length, 3);
  const oldOwner = knownOriginalOwner(f.state);
  f.state.nativeRunId = 'fresh-short-run'; f.state.reviewController = new AbortController();
  assert.deepEqual(knownOriginalOwner(f.state), oldOwner); assert.throws(oldReader, { code: 'STOP_TASK_INPUT_CHANGED' });
  assert.equal(await f.publish(failed), false, 'A stale prior run cannot publish into the fresh run.');
  const completed = await f.run('complete', options); assert.equal(completed.semanticReview.status, 'completed');
  const recoveredRows = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage.rows;
  assert.deepEqual(knownOriginalItems(recoveredRows).map(row => row.id).sort(), expectedIds);
  assert.deepEqual(new Set(recoveredRows.map(row => row.requirement)), new Set(baseDuties));
  assert.equal(await f.publish(completed), true);
  const frozen = knownOriginalObligations(f.state); assert.deepEqual(frozen.items.map(row => row.id).sort(), expectedIds);
  assert.equal(frozen.capacityUnverified, undefined); assert.equal(frozen.items.length, 3);
  assert.equal(f.calls.actualFactoryRunner, legacy ? 5 : 2);
});


async function stopVisibleUncertainty(f, { late = false, ledgerFailure = false } = {}) {
  const pending = late || ledgerFailure ? knownOriginalObservationSnapshot(f.state) : knownOriginalObligations(f.state);
  await ensureTask({ projectRoot: f.root, sessionId: f.state.sessionId, explicitTaskId: f.state.scopeTaskId });
  let provider, calls = 0; const hooks = new Map();
  const api = { config: { agents: { defaults: { model: { primary: 'fixture/model' } } } }, logger: { warn() {} },
    runtime: { version: '2026.7.1-2', agent: {} }, registerTool: value => { provider = value; },
    on: (name, handler) => hooks.set(name, handler) };
  registerTaskTools(api);
  const runEmbeddedAgent = async params => {
    calls++; assert.equal(calls, 1, 'The actual Stop protocol has one bounded fake worker invocation.');
    const brief = JSON.parse(params.prompt), tools = new Map(provider(params).map(tool => [tool.name, tool]));
    const read = async (file, offset) => {
      params.onAssistantMessageStart(); const id = randomUUID();
      const result = await tools.get('source_read').execute(id, { path: file, offset });
      params.onAgentToolResult({ toolName: 'source_read', result, isError: false });
      hooks.get('tool_result_persist')({ toolName: 'source_read', toolCallId: id, isSynthetic: false,
        message: { role: 'toolResult', toolName: 'source_read', toolCallId: id, isError: false, content: result.content } }, params);
      return result;
    };
    for (const file of brief.task.basisFiles) {
      let offset = 1;
      do { const page = await read(file, offset); offset = page.details.page.nextOffset; } while (offset !== null);
    }
    const submit = async (name, value) => {
      params.onAssistantMessageStart(); const result = await tools.get(name).execute(randomUUID(), value);
      params.onAgentToolResult({ toolName: name, result, isError: false }); return JSON.parse(result.content[0].text);
    };
    await submit('set_original_checklist', { items: [], scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    const value = { summary: 'The host-observed duties remain unresolved.', ...(late ? { knownObligations: [
      { id: pending.observationLedger.initialCandidateIds[0], disposition: 'UNVERIFIED', reason: 'Initial duty has no current assessment.' }] } : {}) };
    let finished = await submit('finish_stop_review', value);
    if (late) {
      assert.equal(finished.complete, false);
      assert.equal(finished.pendingKnownOriginalCount, 1, 'The late atom needs its own accounting even when the full original is readable.');
      assert.equal(finished.pendingKnownOriginals[0].id, pending.items.find(item => !pending.observationLedger.initialCandidateIds.includes(item.id)).id);
      const originalPart = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
      assert((await fs.readFile(originalPart, 'utf8')).includes(baseDuties[0]), 'The complete conditional original clause remains in the ordinary source.');
      finished = await submit('finish_stop_review', { ...value, knownObligations: [...value.knownObligations,
        { id: finished.pendingKnownOriginals[0].id, disposition: 'UNVERIFIED', reason: 'Later conditional duty has no current assessment.' }] });
    }
    assert.equal(finished.complete, true);
    return { payloads: [{ text: 'Display text grants no assessment.' }], meta: { aborted: params.abortSignal.aborted } };
  };
  const factory = createOpenClawReviewerFactory(api, { runEmbeddedAgent, abortSignal: f.state.reviewController.signal });
  let handle; offlineGraphRoots.add(f.root);
  try {
  handle = await factory({ projectRoot: f.root, taskId: f.state.scopeTaskId, role: 'stop-reviewer',
    reviewer: { timeoutMs: 5000 }, schema: STOP_REVIEW_SCHEMA,
    request: { hook: { last_assistant_message: 'The implementation is complete.' }, workflowStages: ['proposal'],
      classificationContract: 2, reviewScope: { kind: 'workspace-stop' }, sourceManifest: [],
      taskChanges: { complete: true, startHead: null, changes: [] },
      population: { metrics: {}, reviewPolicy: resolveStopReviewPolicy({ deviationOnly: true, metrics: { M16: true } }) } },
    evidence: { groundTruth: { version: 1, digest: sha256([]), claims: [] }, originalRequirements: f.originals,
      snapshot: { entries: [{ type: 'user', uuid: f.originals.userMessages[0].ref,
        message: { content: f.originals.userMessages[0].text } }] } },
    readKnownOriginalObligations: knownOriginalObligationReader(f.state) });
    assert.equal(handle.result.knownOriginalCoverage.cohortId, pending.id);
    if (late) {
      assert.deepEqual(handle.result.knownOriginalCoverage.items.map(item => item.id).sort(), pending.items.map(item => item.id).sort());
      assert(handle.result.knownOriginalCoverage.items.every(item => item.disposition === 'UNVERIFIED'));
      assert.deepEqual(handle.result.knownOriginalCoverage.observationLedger, pending.observationLedger);
    } else assert.deepEqual(handle.result.knownOriginalCoverage.items, [{ id: pending.id, disposition: 'UNVERIFIED',
      reason: ledgerFailure ? 'OBSERVATION_LEDGER_LIMIT' : 'OBSERVATION_COHORT_LIMIT' }]);
    assert(handle.result.unverifiedItems.some(item => item.type === 'KNOWN_ORIGINAL_OBLIGATION'));
    assert.equal(calls, 1); return handle.result;
  } finally { try { await handle?.close(); } finally { offlineGraphRoots.delete(f.root); } }
}

for (const legacy of [false, true]) test('actual ' + (legacy ? 'exact legacy' : 'native V2') + '49duty failure and48subset stay visible as U in the actual Stop protocol', async t => {
  const f = await fixture(t, { duties: manyDuties });
  const options = { actualFactory: true, ...(legacy ? { legacy: true, productionLegacy: true } : {}) };
  const failed = await f.run('count-overflow', options); assert.equal(await f.publish(failed), false);
  const pending = knownOriginalObligations(f.state);
  assert.equal(pending.observedProtectedCandidateCount, 49); assert.equal(pending.protectedCanonicalCountWithinLimit, false);
  const subset = await f.run('complete', options); assert.equal(await f.publish(subset), false);
  assert.deepEqual(knownOriginalObligations(f.state), pending);
  await stopVisibleUncertainty(f); assert.deepEqual(knownOriginalObligations(f.state), pending);
});


// The immutable V7 probe confirmed these failures before the worker fix.
// These expected-pass regressions prevent same-worker erasure before observer
// publication. Model-shaped rows are real current-source
// clauses and go through actual host document validation in the factory tests.
test('same-worker49 direct document validation cannot erase an earlier complete49 union with a48 subset', async t => {
  const f = await fixture(t, { duties: manyDuties });
  const captured = captureOriginalDutyPublication(f.state);
  const tools = await createDocumentTools({ projectRoot: f.root,
    semantic: { artifactFiles: f.snapshot.documents.map(file => file.path), originalRequirements: f.originals },
    signal: f.state.reviewController.signal, active: () => assert(originalDutyPublicationCurrent(f.state, captured)),
    originalDutyCohortContext: { owner: captured.owner, sourceRunId: captured.sourceRunId } });
  const read = await tools.execute({ action: 'read_original', ref: f.originals.userMessages[0].ref, start: 2, count: 49 });
  let page = await tools.execute({ action: 'stage_original_duties', duties: manyDuties.map(requirement => ({ originalSourceAnchorId: read.anchor.anchorId, requirement })) }), items = [];
  while (true) { items.push(...page.items); if (page.nextStart === null) break; page = await tools.execute({ action: 'stage_original_duties', start: page.nextStart, count: 20 }); }
  for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
  const rows = items.map(item => ({ originalDutyId: item.originalDutyId, originalSourceAnchorId: item.originalSourceAnchorId,
    requirement: item.requirement, disposition: 'UNVERIFIED', reason: 'No semantic claim.', targets: [] }));
  await assert.rejects(tools.verifyRequirementCoverage([{ originalSourceAnchorId: read.anchor.anchorId, requirement: extraDuty,
    disposition: 'UNVERIFIED', reason: 'Distinct49th original clause.', targets: [] }, ...rows.slice(0, 47)]), { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  assert.equal(tools.originalDutyCapacityFailure().rows.length, 49);
  await assert.rejects(async () => {
    const result = await tools.verifyRequirementCoverage(rows);
    console.log('SAME_WORKER_DIRECT_DIAG ' + JSON.stringify({ laterRows: result.rows.length, retainedFailure: tools.originalDutyCapacityFailure()?.rows.length ?? null }));
    return result;
  }, { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
});

for (const legacy of [false, true]) test('same-worker49 actual ' + (legacy ? 'exact legacy' : 'native V2') + ' factory repair cannot silently publish48 after first valid49', async t => {
  const f = await fixture(t, { duties: manyDuties });
  const completed = await f.run('same-worker-drop', { actualFactory: true, ...(legacy ? { legacy: true, productionLegacy: true } : {}) });
  const published = await f.publish(completed), receipt = completed.finalized.result.metadata.semanticReview.originalRequirementCoverage;
  console.log('SAME_WORKER_FACTORY_DIAG ' + JSON.stringify({ legacy, status: completed.semanticReview.status,
    runnerCalls: f.calls.actualFactoryRunner, receiptRows: receipt?.rows.length ?? null, published,
    frozenCount: knownOriginalObligations(f.state)?.items.length ?? null }));
  assert.equal(published, false); assert.equal(completed.semanticReview.status, 'failed');
  assert.equal(f.calls.actualFactoryRunner, 4); assert.equal(receipt.rows.length, 49);
  assert.equal(knownOriginalObligations(f.state).protectionLimitExceeded, true);
});

// Execute the exact production grouping, sibling-finalizer and deferred
// publication bodies. The declared producer seam invokes the existing actual
// factory/exact legacy closure using the real first checker preparation; it
// neither fabricates a review receipt nor finalizes before the group does.
const groupsStart = runtimeSource.indexOf('          async function reviewDocumentGroups(entries)');
const groupsEnd = runtimeSource.indexOf('          if (recheckDocuments && artifactTask', groupsStart);
const productionGroupsBlock = runtimeSource.slice(groupsStart, groupsEnd);
assert(groupsStart >= 0 && groupsEnd > groupsStart);
assert(productionGroupsBlock.includes('shared ? cloneHostOriginalReview(review) : review'));
const scopedStart = runtimeSource.indexOf('  async function finalizeScopedArtifact(');
const scopedEnd = runtimeSource.indexOf('  async function approvedApplyArtifactDrift(', scopedStart);
assert(scopedStart >= 0 && scopedEnd > scopedStart);
const productionScopedFinalizer = new Function('scopeCurrent', 'path', 'hash', 'finalizeArtifactCheck',
  runtimeSource.slice(scopedStart, scopedEnd) + '\nreturn finalizeScopedArtifact;')(
  async () => true, path, value => sha256(value).slice(0, 24), finalizeArtifactCheck);
const publicationStart = runtimeSource.indexOf('        for (const { state, runId, file, receipt, publication, isCurrent, sources, originalDutyPublication } of coveragePublications)');
const publicationTail = '        return appendBrief ? appendBrief() : result;';
const publicationEnd = runtimeSource.indexOf(publicationTail, publicationStart) + publicationTail.length;
assert(publicationStart >= 0 && publicationEnd > publicationStart);
const productionPublicationBlock = runtimeSource.slice(publicationStart, publicationEnd);

async function coalescedPreparations(f, { nativeV2 = false } = {}) {
  const plan = { version: 2,
    artifacts: [{ name: 'plan', stage: 'proposal', patterns: ['openspec/changes/accounting/*.md'],
      relatedRoot: 'project', relatedPatterns: ['openspec/changes/accounting/*.md'],
      rules: { enabled: false }, review: { enabled: true } }],
    dynamicGroundTruth: { enabled: false }, stopCorrection: { enabled: false },
    artifactCorrection: { originalRequirementsEnabled: true, groundTruthReviewEnabled: nativeV2, stageMetricsEnabled: false },
    limits: { semanticReviewTimeoutMs: 5000 },
    output: { mode: 'centralized', directory: '.runtime-correction/offline-results' } };
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const documentOwner = () => ({ runId: f.state.nativeRunId, taskId: f.state.scopeTaskId, sessionId: f.state.sessionId,
    scopeFingerprint: f.state.projectScope.fingerprint, enabledRevision: f.state.enabledRevision, proposalPolicy: null });
  const entries = [];
  for (const file of [f.proposal, f.tasks]) {
    const prepared = await checkArtifact({ filePath: path.join(f.root, file), cwd: f.root,
      config: plan, pluginRoot, projectRootSource: 'session-project', deferPersistence: true });
    assert.equal(prepared.matched, true); assert.equal(prepared.reviewContext.runtimeV2Enabled, nativeV2);
    entries.push({ file: path.join(f.root, file), input: { session_id: f.state.sessionId, cwd: f.root }, prepared,
      outcome: { taskId: f.state.scopeTaskId, originalRequirements: f.originals,
        ...(nativeV2 ? { artifactReviewContext: structuredClone(f.frozenTruth) } : {}) },
      proposalBinding: { requiredProposalReview: null, requiredPlanReadiness: null, planRevision: null },
      owner: structuredClone(documentOwner()) });
  }
  const groups = groupDocumentReviews(entries, { enabled: true });
  assert.equal(groups.length, nativeV2 ? 2 : 1);
  if (!nativeV2) assert.equal(groups[0].entries.length, 2);
  return { entries, plan, pluginRoot, documentOwner };
}

async function runActualCoalesced(f, mode) {
  const { entries, plan, pluginRoot, documentOwner } = await coalescedPreparations(f);
  const counts = { producer: 0, finalized: 0, recorded: 0 }, finalized = [];
  const captured = captureOriginalDutyPublication(f.state);
  const current = () => originalDutyPublicationCurrent(f.state, captured);
  const bindings = { groupDocumentReviews, coalesceDocuments: true, isDeepStrictEqual, documentOwner,
    scopeCurrent: async () => current(), documentReviewBundleCurrent, pluginRoot, checkArtifact,
    documentReviewBundleKey, state: f.state, value: { plan },
    artifactProposalBinding: async () => ({ requiredProposalReview: null, requiredPlanReadiness: null, planRevision: null }),
    semanticArtifactReview: async (state, _value, input, prepared, outcome, bundle) => {
      counts.producer++; assert.equal(counts.producer, 1); assert.equal(state, f.state);
      assert.equal(prepared, entries[0].prepared); assert.equal(input, entries[0].input); assert.equal(outcome, entries[0].outcome);
      assert.deepEqual(bundle, { proposalBinding: entries[0].proposalBinding });
      const produced = await f.run(mode, { actualFactory: true, legacy: true, productionLegacy: true,
        preparedOverride: prepared, bundleOverride: bundle, reviewOnly: true });
      return produced.semanticReview;
    },
    finalizeScopedArtifact: async (state, prepared, review) => {
      assert.equal(state, f.state); assert(current());
      const result = await productionScopedFinalizer(state, prepared, review);
      counts.finalized++; finalized.push(result); return result;
    }, cloneHostOriginalReview, artifactTask: { taskId: f.state.scopeTaskId, groundTruth: { version: 1 } },
    appendTaskJournal: async (root, taskId, entry) => {
      assert.equal(root, f.root); assert.equal(taskId, f.state.scopeTaskId); assert.equal(entry.type, 'OPENCLAW_ARTIFACT_REVIEW');
    }, id: 'offline-coalesced', fingerprint: async file => sha256(await fs.readFile(file)),
    joined: (...values) => values.filter(Boolean).join('\n\n'),
    finalizeArtifactRuntimeV2: () => assert.fail('Native V2 contexts must not enter a shared group.'),
    recordObservation: () => assert.fail('No native V2 metric context is admitted.'), nativeHooks: true,
    ctx: { runId: f.state.nativeRunId }, event: { runId: f.state.nativeRunId }, captureOriginalDutyPublication,
    approvedProgressBasis: () => null };
  const dependencyNames = Object.keys(bindings);
  const grouped = new Function(...dependencyNames,
    "let feedback = '', documentRecheckPassed = true; const coveragePublications = [];\n"
    + productionGroupsBlock + '\nreturn { run: reviewDocumentGroups, publications: coveragePublications };')(...dependencyNames.map(name => bindings[name]));
  await grouped.run(entries);
  assert.equal(counts.producer, 1); assert.equal(counts.finalized, 2); assert.equal(grouped.publications.length, 1);
  for (const result of finalized) assert(hostOriginalCoverageCurrent(result.result.metadata.semanticReview.originalRequirementCoverage));
  const publish = new Function('coveragePublications', 'recordProposalCoverage', 'publishOriginalDutyArtifact', 'appendBrief', 'result',
    'return async function publishGroup() {\n' + productionPublicationBlock + '\n};')(
    grouped.publications, (state, file, receipt, publication) => {
      counts.recorded++; assert.equal(state, f.state); assert(entries.some(entry => entry.file === file));
      assert.equal(receipt, publication.result.metadata.semanticReview.originalRequirementCoverage);
    }, publishOriginalDutyArtifact, null, null);
  await publish(); assert.equal(counts.recorded, 1);
  return { counts, finalized, publication: grouped.publications[0] };
}

test('actual coalesced callback preserves omitted duty provenance through both sibling finalizers and one publication', async t => {
  const f = await fixture(t), result = await runActualCoalesced(f, 'omission');
  assert.equal(f.calls.actualLegacyFactory, 1); assert.equal(f.calls.actualFactoryRunner, 1);
  for (const finalized of result.finalized) {
    const receipt = finalized.result.metadata.semanticReview.originalRequirementCoverage;
    assert.equal(receipt.rows.length, 3); assert.equal(receipt.rows.filter(row => row.disposition === 'UNVERIFIED').length, 1);
  }
  assert.deepEqual(new Set(knownOriginalObligations(f.state).items.map(row => row.requirement)), new Set(baseDuties));
});

test('actual coalesced capacity failure keeps genuine49 provenance through failed sibling merges and aggregate-U publication', async t => {
  const f = await fixture(t, { duties: manyDuties }), result = await runActualCoalesced(f, 'count-overflow');
  assert.equal(f.calls.actualLegacyFactory, 1); assert.equal(f.calls.actualFactoryRunner, 4);
  for (const finalized of result.finalized) {
    assert.equal(finalized.result.classification, 'CHECKER_FAILURE');
    assert.equal(finalized.result.metadata.semanticReview.originalRequirementCoverage.rows.length, 49);
  }
  const pending = knownOriginalObligations(f.state);
  assert.equal(pending.protectionLimitExceeded, true); assert.equal(pending.observedProtectedCandidateCount, 49);
});

test('actual checker nativeV2 mode preparations remain noncoalescible instead of forcing an unsupported shared path', async t => {
  const f = await fixture(t), { entries } = await coalescedPreparations(f, { nativeV2: true });
  for (const entry of entries) {
    assert.equal(documentReviewBundleKey(entry), null);
  }
  assert.equal(groupDocumentReviews(entries, { enabled: true }).length, 2);
});

test('host review cloning rejects JSON lookalikes while preserving ordinary unsealed review behavior', async t => {
  const f = await fixture(t), completed = await f.run('omission', { actualFactory: true });
  const lookalike = JSON.parse(JSON.stringify(completed.semanticReview));
  assert.throws(() => cloneHostOriginalReview(lookalike), { code: 'DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID' });
  assert.deepEqual(hostOriginalReviewMetadata(lookalike), {});
  const ordinary = { status: 'deferred', reasonCode: 'ARTIFACT_BUNDLE_INCOMPLETE', findings: [], diffs: [] };
  const copy = cloneHostOriginalReview(ordinary); assert.deepEqual(copy, ordinary); assert.notEqual(copy, ordinary);
});

test('host review sibling clones isolate their receipts and mutable review data', async t => {
  const f = await fixture(t), completed = await f.run('omission', { actualFactory: true });
  const left = cloneHostOriginalReview(completed.semanticReview), right = cloneHostOriginalReview(completed.semanticReview);
  assert(hostOriginalCoverageCurrent(left.originalRequirementCoverage)); assert(hostOriginalCoverageCurrent(right.originalRequirementCoverage));
  left.findings.push({ ruleId: 'ISOLATION_ONLY' });
  left.originalRequirementCoverage.rows[0].requirement = 'Changed clone only.';
  assert.equal(right.findings.length, 0); assert.equal(completed.semanticReview.findings.length, 0);
  assert.equal(hostOriginalCoverageCurrent(left.originalRequirementCoverage), false);
  assert(hostOriginalReviewMetadata(right).originalRequirementCoverage);
  assert(hostOriginalReviewMetadata(completed.semanticReview).originalRequirementCoverage);
  assert.throws(() => cloneHostOriginalReview(left), { code: 'DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID' });
});

test('host review cloning rejects mutation of an issued original review', async t => {
  const f = await fixture(t), completed = await f.run('omission', { actualFactory: true });
  completed.semanticReview.status = 'failed';
  assert.throws(() => cloneHostOriginalReview(completed.semanticReview), { code: 'DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID' });
});

test('host review cloning retains the private current guard and rejects stale owner or controller', async t => {
  const f = await fixture(t), completed = await f.run('omission', { actualFactory: true });
  const copy = cloneHostOriginalReview(completed.semanticReview);
  f.state.reviewController = new AbortController();
  assert.equal(hostOriginalCoverageCurrent(copy.originalRequirementCoverage), false);
  assert.throws(() => cloneHostOriginalReview(completed.semanticReview), { code: 'DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID' });
  assert.throws(() => cloneHostOriginalReview(copy), { code: 'DOCUMENT_ORIGINAL_DUTY_HOST_REVIEW_INVALID' });
});

test('canonical runtime pin accepts CRLF before extraction and rejects a content mutation', () => {
  const crlf = runtimeSource.replace(/\n/gu, '\r\n');
  assert.equal(sha256(crlf), '45b96284af4ed9abeec7d2bbd7d21c90cae82d3b86486fd1e6272ba2632891cb');
  const canonical = pinRuntimeSource(crlf);
  assert.equal(canonical, runtimeSource);
  assert.equal(canonical.slice(canonical.indexOf('  async function artifactProposalBinding('),
    canonical.indexOf('  async function finalizeScopedArtifact(')), productionLegacyBlock);
  assert.equal(canonical.slice(groupsStart, groupsEnd), productionGroupsBlock);
  assert.equal(canonical.slice(publicationStart, publicationEnd), productionPublicationBlock);
  const changed = crlf.replace('async function semanticArtifactReview(', 'async function semanticArtifactReviewChanged(');
  assert.notEqual(changed, crlf);
  assert.throws(() => pinRuntimeSource(changed), { code: 'ERR_ASSERTION' });
});
