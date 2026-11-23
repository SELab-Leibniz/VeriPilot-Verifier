import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// These controls use actual host document verification and filesystem state,
// with no subprocess, SDK transport, network or model entry point.
const attempts = { process: 0, network: 0 };
const forbidden = kind => () => { attempts[kind]++; throw new Error('LEGACY_COMPAT_FORBIDS_' + kind); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = forbidden('process');
process.kill = forbidden('process');
for (const key of ['connect', 'createConnection']) net[key] = forbidden('network');
net.Socket.prototype.connect = forbidden('network'); net.Server.prototype.listen = forbidden('network');
for (const module of [http, https]) for (const key of ['request', 'get']) module[key] = forbidden('network');
globalThis.fetch = forbidden('network'); syncBuiltinESMExports();

const { createDocumentTools } = await import('../lib/document-tools.mjs');
const { runSemanticReview, parseClaudeReview, REVIEW_SCHEMA } = await import('../lib/semantic-review.mjs');
const { finalizeArtifactCheck } = await import('../lib/runtime-corrector.mjs');
const { mergeSemanticReview } = await import('../lib/result-processing.mjs');
const { buildOriginalRequirements } = await import('../lib/runtime-v2/original-requirements.mjs');
const { readOpenSpecPlan } = await import('../lib/openspec-plan.mjs');
const { knownOriginalObligations, observeKnownOriginalObligations } = await import('../lib/runtime-v2/known-original-obligations.mjs');
const { captureOriginalDutyPublication, originalDutyPublicationCurrent, publishOriginalDutyArtifact } = await import('../lib/runtime-v2/original-duty-artifact-publication.mjs');
const { hostOriginalCoverageCurrent, hostOriginalCoverageDiagnosticOnly, cloneHostLegacyOriginalCoverage,
  retainHostOriginalCoverage, bindHostOriginalCoverage, hostOriginalReviewMetadata, cloneHostOriginalReview,
  originalDutyContextFromCapture, validateHostOriginalDutyContext } = await import('../lib/runtime-v2/original-duty-publication.mjs');
const { sha256 } = await import('../lib/runtime-v2/utils.mjs');
const { isDeepStrictEqual } = await import('node:util');

test.after(() => assert.deepEqual(attempts, { process: 0, network: 0 }));
const duties = ['Retain the saved sort order.', 'Restore the saved sort order on reopening.'];
let round = 0;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-legacy-diagnostic-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['openspec/changes/preferences/proposal.md', 'openspec/changes/preferences/tasks.md'];
  await fs.mkdir(path.dirname(path.join(root, files[0])), { recursive: true });
  await fs.writeFile(path.join(root, files[0]), '# Proposal\n' + duties.join('\n') + '\n');
  await fs.writeFile(path.join(root, files[1]), '- [ ] Retain and restore preferences.\n');
  const text = '# Request\n' + duties.join('\n') + '\n';
  const originals = await buildOriginalRequirements({ projectRoot: root, sessionId: 'legacy-parent',
    snapshot: { entries: [{ type: 'user', uuid: 'legacy-original', message: { content: text } }] },
    hostAdapter: { instructionFileNames: [] }, plan: { configuredArtifacts: [] }, materials: { entries: [] } });
  const snapshot = await readOpenSpecPlan(root, 'preferences');
  const state = { projectRoot: root, sessionId: 'legacy-parent', sessionKey: 'agent:legacy', scopeTaskId: 'legacy-task',
    projectScope: { fingerprint: 'legacy-scope' }, enabledRevision: 1, nativeRunId: 'legacy-run', reviewController: new AbortController() };
  const context = () => originalDutyContextFromCapture(captureOriginalDutyPublication(state));
  const open = ctx => createDocumentTools({ projectRoot: root, semantic: { artifactFiles: files, originalRequirements: originals },
    signal: state.reviewController.signal, originalDutyCohortContext: ctx });
  const issue = async tools => {
    const read = await tools.execute({ action: 'read_original', ref: originals.userMessages[0].ref, start: 2, count: 2 });
    for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 100 });
    return tools.verifyRequirementCoverage([{ originalSourceAnchorId: read.anchor.anchorId, requirement: duties[0],
      disposition: 'UNVERIFIED', reason: 'Diagnostic scope only.', targets: [] }]);
  };
  const prepare = () => ({ projectRoot: root, result: { status: 'passed', diagnostics: [], diffs: [], metadata: {
    roundId: '20261123T020202Z-' + (++round).toString(16).padStart(8, '0'), generatedAt: '2026-11-23T02:02:02Z',
    stage: 'proposal', artifactType: 'openspec-plan', triggerFile: files[0], artifactFiles: files, bundleComplete: true,
    ruleSetIds: [], inputs: snapshot.documents, inputDigest: sha256(snapshot.documents) } },
    reviewContext: { nodeReviewEnabled: true, reviewer: null, specification: null, workflow: null, semanticReviewTimeoutMs: 5000 },
    finalizeContext: { output: { persist: true, mode: 'centralized', directory: '.runtime-correction/legacy-results' },
      cwd: root, triggerFile: path.join(root, files[0]), stageSpecification: null, maxFeedbackChars: 10000,
      locale: 'en', includePublicCommandContext: false, editableArtifactFiles: null, outputKey: null } });
  const assessment = () => ({ summary: 'Actual host-verified ordinary coverage.', findings: [], edits: [] });
  const produce = async request => {
    const requestPath = request.prompt.match(/--request "([^"]+)"/u)[1];
    const tools = await createDocumentTools({ projectRoot: root, semantic: request.semanticRequest, requestPath });
    assert.equal(tools.originalDutyAccountingEnabled, false);
    return { sessionId: 'legacy-worker', review: assessment(), originalRequirementCoverage: await issue(tools) };
  };
  return { root, files, originals, snapshot, state, context, open, issue, prepare, assessment, produce };
}

test('ordinary host-issued coverage survives plain host merge without duty publication authority', async t => {
  const f = await fixture(t), receipt = await f.issue(await f.open(null));
  const result = f.prepare().result;
  mergeSemanticReview(result, { status: 'completed', ...f.assessment(), originalRequirementCoverage: receipt });
  assert.deepEqual(result.metadata.semanticReview.originalRequirementCoverage, receipt);
  assert.equal(result.metadata.semanticReview.originalRequirementCoverageAuthority, 'DIAGNOSTIC_ONLY');
  assert.equal(hostOriginalCoverageDiagnosticOnly(result.metadata.semanticReview.originalRequirementCoverage), true);
  assert.equal(bindHostOriginalCoverage(receipt, f.context(), () => true), null);
  assert.equal(retainHostOriginalCoverage(receipt), null);
});

test('null-context production semantic review keeps real diagnostic coverage through actual finalization and persistence', async t => {
  const f = await fixture(t), prepared = f.prepare();
  const review = await runSemanticReview({ input: { session_id: f.state.sessionId, cwd: f.root }, prepared,
    originalRequirements: f.originals, invokeFork: f.produce });
  assert.equal(review.status, 'completed');
  const finalized = await finalizeArtifactCheck(prepared, review), metadata = finalized.result.metadata.semanticReview;
  assert.equal(metadata.originalRequirementCoverageAuthority, 'DIAGNOSTIC_ONLY');
  assert.equal(metadata.originalRequirementCoverage.rows.length, 1);
  assert.equal(metadata.originalDutyAccounting, undefined);
  const stored = finalized.writtenFiles.find(file => path.basename(file) === 'result.json'); assert(stored);
  const persisted = JSON.parse(await fs.readFile(stored, 'utf8'));
  assert.deepEqual(persisted.metadata.semanticReview.originalRequirementCoverage, metadata.originalRequirementCoverage);
  assert.equal(await publishOriginalDutyArtifact(f.state, { file: f.files[0], finalized,
    sources: f.originals.userMessages, captured: captureOriginalDutyPublication(f.state) }), false);
  assert.equal(knownOriginalObligations(f.state), null);
});

test('JSON receipt lookalikes are rejected by direct merge and null-context semantic review', async t => {
  const f = await fixture(t), receipt = await f.issue(await f.open(null));
  const json = JSON.parse(JSON.stringify(receipt));
  const result = f.prepare().result;
  mergeSemanticReview(result, { status: 'completed', ...f.assessment(), originalRequirementCoverage: json });
  assert.equal(result.metadata.semanticReview.originalRequirementCoverage, undefined);
  const review = await runSemanticReview({ input: { session_id: f.state.sessionId, cwd: f.root }, prepared: f.prepare(),
    invokeFork: async () => ({ sessionId: 'json-lookalike', review: f.assessment(), originalRequirementCoverage: json }) });
  assert.equal(review.status, 'failed'); assert.match(review.error, /DOCUMENT_ORIGINAL_LEGACY_COVERAGE_INVALID/u);
  assert.deepEqual(hostOriginalReviewMetadata(review), {});
});

test('generic CLI model JSON coverage is never promoted to a host receipt', async t => {
  const f = await fixture(t), receipt = await f.issue(await f.open(null));
  const parsed = parseClaudeReview(JSON.stringify({ session_id: 'serialized-cli', structured_output: {
    ...f.assessment(), originalRequirementCoverage: receipt } }));
  assert.equal(parsed.originalRequirementCoverage, undefined);
  const review = await runSemanticReview({ input: { session_id: f.state.sessionId, cwd: f.root }, prepared: f.prepare(),
    invokeFork: async () => parsed });
  assert.equal(review.status, 'completed'); assert.equal(review.originalRequirementCoverage, undefined);
  assert.equal(hostOriginalReviewMetadata(review).originalRequirementCoverage, undefined);
});

for (const kind of ['staged', 'bound']) test(kind + ' host receipt cannot be downgraded into null-context diagnostics', async t => {
  const f = await fixture(t), tools = await f.open(f.context());
  let receipt;
  if (kind === 'staged') {
    const read = await tools.execute({ action: 'read_original', ref: f.originals.userMessages[0].ref, start: 2, count: 2 });
    await tools.execute({ action: 'stage_original_duties', duties: [{ originalSourceAnchorId: read.anchor.anchorId, requirement: duties[0] }] });
    receipt = await tools.verifyRequirementCoverage([]);
  } else receipt = bindHostOriginalCoverage(await f.issue(tools), f.context(), () => true);
  assert(receipt); assert.equal(cloneHostLegacyOriginalCoverage(receipt), null);
  const result = f.prepare().result;
  mergeSemanticReview(result, { status: 'completed', ...f.assessment(), originalRequirementCoverage: receipt });
  assert.equal(result.metadata.semanticReview.originalRequirementCoverage, undefined);
  const review = await runSemanticReview({ input: { session_id: f.state.sessionId, cwd: f.root }, prepared: f.prepare(),
    invokeFork: async () => ({ sessionId: kind, review: f.assessment(), originalRequirementCoverage: receipt }) });
  assert.equal(review.status, 'failed'); assert.match(review.error, /DOCUMENT_ORIGINAL_LEGACY_COVERAGE_INVALID/u);
});

test('diagnostic clones preserve their private mode and mutation never grants observer authority', async t => {
  const f = await fixture(t), receipt = await f.issue(await f.open(null));
  const review = { status: 'completed', ...f.assessment(), originalRequirementCoverage: receipt };
  const copy = cloneHostOriginalReview(review), diagnostic = hostOriginalReviewMetadata(copy).originalRequirementCoverage;
  assert(hostOriginalCoverageCurrent(diagnostic)); assert(hostOriginalCoverageDiagnosticOnly(diagnostic));
  Object.assign(diagnostic, { runId: f.state.nativeRunId, taskId: f.state.scopeTaskId, sessionId: f.state.sessionId });
  assert.equal(hostOriginalCoverageCurrent(diagnostic), false);
  assert.equal(bindHostOriginalCoverage(diagnostic, f.context(), () => true), null);
  assert.equal(await observeKnownOriginalObligations(f.state, { file: f.files[0], receipt: diagnostic,
    sources: f.originals.userMessages, publication: { runId: f.state.nativeRunId, taskId: f.state.scopeTaskId,
      sessionId: f.state.sessionId, result: { metadata: { triggerFile: f.files[0], inputs: f.snapshot.documents,
        semanticReview: { status: 'completed' } } } } }), false);
  assert.equal(knownOriginalObligations(f.state), null);
});

test('missing host context hides the entire staging capability while valid unopened context remains optional', async t => {
  const f = await fixture(t), ordinary = await f.open(null), eligible = await f.open(f.context());
  assert.equal(ordinary.originalDutyAccountingEnabled, false); assert.equal(ordinary.originalDutyAccounting(), null);
  assert.equal(ordinary.tool.parameters.properties.action.enum.includes('stage_original_duties'), false);
  assert.equal(Object.hasOwn(ordinary.tool.parameters.properties, 'duties'), false);
  assert.doesNotMatch(ordinary.tool.description, /stage_original_duties/u);
  assert.equal(eligible.originalDutyAccountingEnabled, true);
  assert.equal(eligible.tool.parameters.properties.action.enum.includes('stage_original_duties'), true);
  assert.equal(eligible.originalDutyAccounting().status, 'NOT_EXERCISED');
  assert.equal(eligible.originalDutyAccounting().stagedCount, 0);
});

test('malformed explicit host context fails before any staging advertisement', async t => {
  const f = await fixture(t);
  assert.throws(() => validateHostOriginalDutyContext({ owner: {}, sourceRunId: 'run' }),
    { code: 'DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID' });
  await assert.rejects(f.open({ owner: {}, sourceRunId: 'run' }), { code: 'DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID' });
  const foreign = f.context(); foreign.owner.projectRoot = path.dirname(f.root);
  await assert.rejects(f.open(foreign), { code: 'DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID' });
  const review = await runSemanticReview({ input: { session_id: f.state.sessionId, cwd: f.root }, prepared: f.prepare(),
    originalDutyCohortContext: foreign, invokeFork: () => assert.fail('Invalid context must fail before dispatch.') });
  assert.equal(review.status, 'failed'); assert.match(review.error, /DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_INVALID/u);
  const capture = captureOriginalDutyPublication(f.state); delete capture.controller;
  assert.equal(originalDutyContextFromCapture(capture), null);
});

test('canonical filesystem aliases retain captured owner spelling without losing legitimate staging capability', async t => {
  const f = await fixture(t), alias = f.root + '-alias';
  await fs.symlink(f.root, alias, 'dir'); t.after(() => fs.rm(alias, { force: true }));
  const ctx = f.context(); ctx.owner.projectRoot = alias;
  const tools = await f.open(ctx); assert.equal(tools.originalDutyAccountingEnabled, true);
  const read = await tools.execute({ action: 'read_original', ref: f.originals.userMessages[0].ref, start: 2, count: 2 });
  await tools.execute({ action: 'stage_original_duties', duties: [{ originalSourceAnchorId: read.anchor.anchorId, requirement: duties[0] }] });
  const receipt = await tools.verifyRequirementCoverage([]);
  assert.equal(receipt.originalDutyAccounting.stagedCount, 1);
  assert(bindHostOriginalCoverage(receipt, ctx, () => true));
});

test('nativeV2 source forwarding accepts canonical workspace aliases and preserves the captured owner binding', async t => {
  const f = await fixture(t), alias = f.root + '-native-alias';
  await fs.symlink(f.root, alias, 'dir'); t.after(() => fs.rm(alias, { force: true }));
  f.state.projectRoot = alias;
  const capture = captureOriginalDutyPublication(f.state), context = originalDutyContextFromCapture(capture);
  let calls = 0, closed = 0;
  const reviewerFactory = { handoff: async options => {
    calls++;
    assert.equal(options.evidence.semanticRequest.originalRequirements.sourceRole,
      'ORIGINAL_USER_DUTY_ACCOUNTING_ONLY_FROZEN_GROUND_TRUTH_UNCHANGED');
    assert.equal(options.evidence.originalDutyCohortContext.owner.projectRoot, alias);
    const tools = await createDocumentTools({ projectRoot: f.root, semantic: options.evidence.semanticRequest,
      requestPath: options.request.semanticReviewRequestPath, originalDutyCohortContext: options.evidence.originalDutyCohortContext });
    return { sessionId: 'native-alias-host', result: f.assessment(), originalRequirementCoverage: await f.issue(tools),
      originalDutyAccounting: tools.originalDutyAccounting(), close: async () => { closed++; } };
  } };
  const prepared = f.prepare();
  const review = await runSemanticReview({ input: { session_id: f.state.sessionId, cwd: f.root }, prepared,
    runtimeV2Context: { taskId: f.state.scopeTaskId, projectRoot: alias, reviewerExecution: {} },
    runtimeV2ExecutionContext: { projectRoot: f.root, sessionCwd: f.root, parentSessionId: f.state.sessionId,
      taskId: f.state.scopeTaskId }, runtimeV2ReviewerFactory: reviewerFactory,
    originalRequirements: f.originals, originalDutyCohortContext: context,
    originalDutyPublicationGuard: () => originalDutyPublicationCurrent(f.state, capture) });
  assert.equal(review.status, 'completed'); assert.equal(calls, 1); assert.equal(closed, 1);
  const finalized = await finalizeArtifactCheck(prepared, review);
  const receipt = finalized.result.metadata.semanticReview.originalRequirementCoverage;
  assert.equal(receipt.originalDutyOwnerBinding.owner.projectRoot, alias);
  assert.equal(hostOriginalCoverageDiagnosticOnly(receipt), false);
  assert.equal(await publishOriginalDutyArtifact(f.state, { file: f.files[0], finalized,
    sources: f.originals.userMessages, captured: capture }), true);
  assert.equal(knownOriginalObligations(f.state).owner.projectRoot, alias);
});

test('exact ordinary unbound production callback preserves diagnostic coverage without inventing task or run authority', async t => {
  const f = await fixture(t), state = { ...f.state, scopeTaskId: undefined, nativeRunId: undefined };
  assert.equal(originalDutyContextFromCapture(captureOriginalDutyPublication(state)), null);
  const source = (await fs.readFile(new URL('../lib/openclaw/runtime.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const start = source.indexOf('  async function artifactProposalBinding('), end = source.indexOf('  async function finalizeScopedArtifact(', start);
  assert(start >= 0 && end > start);
  const execute = new Function('runSemanticReview', 'captureOriginalDutyPublication', 'originalDutyPublicationCurrent',
    'originalDutyContextFromCapture', 'bindHostOriginalCoverage', 'cloneHostLegacyOriginalCoverage', 'REVIEW_SCHEMA',
    'isDeepStrictEqual', 'pluginRoot', 'hash', source.slice(start, end) + '\nreturn semanticArtifactReview;')(
    runSemanticReview, captureOriginalDutyPublication, originalDutyPublicationCurrent, originalDutyContextFromCapture,
    bindHostOriginalCoverage, cloneHostLegacyOriginalCoverage, REVIEW_SCHEMA, isDeepStrictEqual,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), value => sha256(value).slice(0, 24));
  let calls = 0, closed = 0;
  const reviewerFactory = async options => {
    calls++; assert.equal(options.evidence.originalDutyCohortContext, null);
    const tools = await createDocumentTools({ projectRoot: f.root, semantic: options.evidence.semanticRequest,
      requestPath: options.request.semanticReviewRequestPath, originalDutyCohortContext: options.evidence.originalDutyCohortContext });
    assert.equal(tools.originalDutyAccountingEnabled, false);
    return { sessionId: 'unbound-host-worker', result: f.assessment(), originalRequirementCoverage: await f.issue(tools),
      originalDutyAccounting: tools.originalDutyAccounting(), close: async () => { closed++; } };
  };
  const prepared = f.prepare();
  const review = await execute(state, { reviewerFactory, plan: { runtimeV2: { reviewers: { artifactReviewer: {} } } } },
    { session_id: state.sessionId, cwd: f.root }, prepared, { originalRequirements: f.originals });
  assert.equal(review.status, 'completed'); assert.equal(calls, 1); assert.equal(closed, 1);
  const finalized = await finalizeArtifactCheck(prepared, review);
  assert.equal(finalized.result.metadata.semanticReview.originalRequirementCoverageAuthority, 'DIAGNOSTIC_ONLY');
  assert.equal(finalized.result.metadata.semanticReview.originalRequirementCoverage.rows.length, 1);
  assert.equal(knownOriginalObligations(state), null);
});
