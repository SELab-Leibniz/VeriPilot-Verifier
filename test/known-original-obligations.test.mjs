import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations, knownOriginalObligationReader,
  forgetKnownOriginalObligations, currentKnownOriginalSources } from '../lib/runtime-v2/known-original-obligations.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-known-original-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'openspec/changes/add-stream');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'proposal.md'), '# Why\nPreserve stream ordering.\n');
  await fs.writeFile(path.join(directory, 'tasks.md'), '- [ ] Preserve ordering.\n');
  const snapshot = await readOpenSpecPlan(root, 'add-stream');
  const state = { projectRoot: root, sessionId: 's', sessionKey: 'agent:main:s', scopeTaskId: 't',
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'proposal-run', reviewController: new AbortController() };
  const text = 'Preserve stream ordering.', source = { ref: 'transcript:u1', text };
  const anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: sha256(text), bytes: Buffer.from(text), start: 1, end: 1 });
  const receipt = { schemaVersion: 1, runId: state.nativeRunId, taskId: 't', sessionId: 's', scope: snapshot.documents,
    rows: [{ source: anchor, requirement: text, disposition: 'COVERED', reason: 'Present in the reviewed plan.',
      targets: [{ ...snapshot.documents[0], start: 1, end: 2 }] }] };
  const publication = { runId: state.nativeRunId, taskId: 't', sessionId: 's', result: { status: 'passed',
    metadata: { triggerFile: 'openspec/changes/add-stream/tasks.md', inputs: snapshot.documents, semanticReview: { status: 'completed' } } } };
  const observation = { file: path.join(directory, 'tasks.md'), receipt, publication, sources: [source] };
  return { root, state, observation, source, snapshot };
}

test('first exact full-plan cohort survives ordinary approval/Apply but not reset or owner changes', async t => {
  const f = await fixture(t), empty = knownOriginalObligationReader(f.state);
  assert.equal(empty(), null);
  assert.equal(await observeKnownOriginalObligations(f.state, f.observation), true);
  assert.throws(empty, { code: 'STOP_TASK_INPUT_CHANGED' });
  const first = knownOriginalObligations(f.state);
  assert.equal(first.exhaustive, false);
  assert.equal(first.items.length, 1);
  f.state.nativeRunId = 'apply-run'; f.state.reviewController = new AbortController();
  assert.deepEqual(knownOriginalObligations(f.state), first);
  const current = currentKnownOriginalSources(first, { userMessages: [
    { ...f.source, sha256: sha256(f.source.text) }, { ref: 'transcript:approval', text: 'Approved. Apply.', sha256: sha256('Approved. Apply.') }] });
  assert.equal(current[0].sourceCurrent, true);
  assert.equal(currentKnownOriginalSources(first, { userMessages: [{ ...f.source, text: 'Changed', sha256: sha256('Changed') }] })[0].sourceCurrent, false);
  assert.equal(await observeKnownOriginalObligations(f.state, { ...f.observation, receipt: { ...f.observation.receipt,
    rows: [{ ...f.observation.receipt.rows[0], requirement: 'A later paraphrase.' }] } }), false);
  assert.deepEqual(knownOriginalObligations(f.state), first);
  const reader = knownOriginalObligationReader(f.state);
  forgetKnownOriginalObligations(f.state);
  assert.equal(knownOriginalObligations(f.state), null);
  assert.throws(reader, { code: 'STOP_TASK_INPUT_CHANGED' });
  await observeKnownOriginalObligations(f.state, { ...f.observation, publication: { ...f.observation.publication, runId: 'apply-run' },
    receipt: { ...f.observation.receipt, runId: 'apply-run' } });
  f.state.scopeTaskId = 'new-task'; assert.equal(knownOriginalObligations(f.state), null);
});

for (const invalid of ['partial', 'foreign-run', 'foreign-task', 'stale-source', 'wrong-anchor', 'deferred', 'scope-change', 'duplicate', 'strict-policy'])
  test(`first-cohort admission rejects ${invalid} observations`, async t => {
    const f = await fixture(t), value = structuredClone(f.observation);
    if (invalid === 'partial') value.publication.result.metadata.inputs = value.publication.result.metadata.inputs.slice(0, 1);
    if (invalid === 'foreign-run') value.publication.runId = 'other';
    if (invalid === 'foreign-task') value.receipt.taskId = 'other';
    if (invalid === 'stale-source') value.sources[0].text += 'changed';
    if (invalid === 'wrong-anchor') value.receipt.rows[0].source.byteEnd--;
    if (invalid === 'deferred') value.publication.result.metadata.semanticReview.status = 'deferred';
    if (invalid === 'scope-change') f.state.scopeClosed = true;
    if (invalid === 'duplicate') value.receipt.rows.push(value.receipt.rows[0]);
    if (invalid === 'strict-policy') f.state.nativeProposalCoveragePolicy = { required: true };
    assert.equal(await observeKnownOriginalObligations(f.state, value), false);
    assert.equal(knownOriginalObligations(f.state), null);
  });

test('actual optional full-plan inventory and retained-after-compaction sources are accepted', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'openspec/changes/add-stream');
  await fs.mkdir(path.join(directory, 'specs/stream'), { recursive: true });
  await fs.writeFile(path.join(directory, 'design.md'), '# Design\nPreserve ownership.\n');
  await fs.writeFile(path.join(directory, 'specs/stream/spec.md'), '# Requirement\nPreserve stream ordering.\n');
  const snapshot = await readOpenSpecPlan(f.root, 'add-stream');
  f.observation.receipt.scope = snapshot.documents;
  f.observation.publication.result.metadata.inputs = snapshot.documents;
  f.observation.sources[0].retainedAfterCompaction = true;
  assert.equal(await observeKnownOriginalObligations(f.state, f.observation), true);
  assert.equal(knownOriginalObligations(f.state).items[0].requirement, f.source.text);
});

test('a reset/rearm while actual plan I/O is pending cannot admit the old publication', async t => {
  const f = await fixture(t), original = fs.open;
  let release, entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let blocked = false;
  fs.open = async function(file, ...args) {
    if (!blocked && path.basename(String(file)) === 'proposal.md') { blocked = true; entered(); await resume; }
    return original.call(this, file, ...args);
  };
  let timer;
  const pending = observeKnownOriginalObligations(f.state, f.observation);
  try {
    await Promise.race([paused, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Actual plan open did not start.')), 1000); })]);
    f.state.reviewController.abort();
    forgetKnownOriginalObligations(f.state);
    f.state.reviewController = new AbortController();
  } finally { clearTimeout(timer); release(); fs.open = original; }
  assert.equal(await pending, false);
  assert.equal(knownOriginalObligations(f.state), null);
});

for (const boundary of ['49-rows', 'long-wording']) test(`unsupported ${boundary} is visible retention uncertainty`, async t => {
  const f = await fixture(t), row = f.observation.receipt.rows[0];
  f.observation.receipt.rows = boundary === '49-rows'
    ? Array.from({ length: 49 }, (_, index) => ({ ...row, requirement: `${row.requirement} Observation ${index}.` }))
    : [{ ...row, requirement: 'A'.repeat(601) }];
  assert.equal(await observeKnownOriginalObligations(f.state, f.observation), true);
  const cohort = knownOriginalObligations(f.state);
  assert.equal(cohort.unavailableReason, 'OBSERVATION_COHORT_LIMIT');
  assert.equal(cohort.items.length, 0);
  assert.equal(cohort.observedCandidateCount, boundary === '49-rows' ? 49 : 1);
  assert.equal(cohort.exhaustive, false);
});

test('a foreign oversized cohort cannot acquire even retention-uncertainty authority', async t => {
  const f = await fixture(t), row = f.observation.receipt.rows[0];
  f.observation.receipt.rows = Array.from({ length: 49 }, (_, index) => ({ ...row, requirement: `${row.requirement} Observation ${index}.` }));
  f.observation.receipt.rows[48] = { ...f.observation.receipt.rows[48], source: { ...row.source, sha256: 'f'.repeat(64) } };
  assert.equal(await observeKnownOriginalObligations(f.state, f.observation), false);
  assert.equal(knownOriginalObligations(f.state), null);
});

test('shipped bare and full-plan topologies admit the actual host-published observation', async t => {
  const output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-known-build-')));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: output });
  const load = file => import(pathToFileURL(path.join(pluginRoot, file)));
  const { createOpenClawRuntime } = await load('lib/openclaw/runtime.mjs');
  const { ensureTask, findTask } = await load('lib/runtime-v2/task-store.mjs');
  const { loadConfig } = await load('lib/runtime-corrector.mjs');
  const hostAdapter = await load('lib/hosts/openclaw.mjs');
  const { createDocumentTools } = await load('lib/document-tools.mjs');
  const { knownOriginalObligations: observed } = await load('lib/runtime-v2/known-original-obligations.mjs');
  for (const topology of ['bare', 'full-plan', 'ordinary-apply-checked', 'ordinary-apply-omitted', 'ordinary-apply-corroborated', 'ordinary-apply-corroboration-omitted']) await t.test(topology, { timeout: 30000 }, async t => {
    const integrated = topology.startsWith('ordinary-apply-'), corroborated = topology.startsWith('ordinary-apply-corrobor'),
      checked = ['ordinary-apply-checked', 'ordinary-apply-corroborated'].includes(topology);
    const f = await fixture(t), project = path.join(f.root, '.runtime-corrector');
    const canonicalDuty = f.source.text;
    if (corroborated) f.source.text = `# Stream contract\n${canonicalDuty}\n`;
    const planDirectory = path.join(f.root, 'openspec/changes/add-stream');
    await fs.mkdir(path.join(planDirectory, 'specs/stream'), { recursive: true });
    await fs.writeFile(path.join(planDirectory, 'design.md'), '# Design\nPreserve ordering.\n');
    await fs.writeFile(path.join(planDirectory, 'specs/stream/spec.md'), '## ADDED Requirements\n### Requirement: Ordering\nThe stream SHALL retain input order.\n#### Scenario: Values\n- **WHEN** values are supplied\n- **THEN** their order is retained\n');
    await fs.cp(path.join(pluginRoot, '.runtime-corrector-default'), project, { recursive: true });
    let config = await fs.readFile(path.join(project, 'config.yaml'), 'utf8');
    config = config.replace('enabled: false\n\nsessionDefaults:', 'enabled: true\n\nsessionDefaults:');
    if (!integrated) config = config.replace('stopCorrection:\n  enabled: true', 'stopCorrection:\n  enabled: false');
    if (topology === 'full-plan') {
      const overlay = await fs.readFile(path.join(project, 'openspec-full-plan.topology.yaml'), 'utf8');
      config = config.slice(0, config.indexOf('enabledStages:')) + overlay + '\n' + config.slice(config.indexOf('dynamicGroundTruth:'));
    }
    await fs.writeFile(path.join(project, 'config.yaml'), config);
    const task = await ensureTask({ projectRoot: f.root, sessionId: 'native-parent' });
    const transcript = path.join(f.root, 'native.jsonl');
    await fs.writeFile(transcript, [{ type: 'session', id: 'native-parent' }, { type: 'message', id: 'u1', parentId: null,
      message: { role: 'user', content: f.source.text } }].map(JSON.stringify).join('\n'));
    const warnings = [];
    const api = { id: 'runtime-corrector', config: {}, logger: { warn(value) { warnings.push(value); } }, runtime: { version: '2026.7.1-2',
      state: { resolveStateDir: () => path.join(f.root, 'host-state') },
      gateway: { async request(method, params) {
        if (method === 'agent.wait') return { runId: params.runId, status: 'ok' };
        if (method === 'autopilot.status') return { projection: { status: 'idle' } };
        assert.fail(`Unexpected host request: ${method}`);
      } }, agent: {
      session: { getSessionEntry: async () => ({ sessionId: 'native-parent', sessionFile: transcript }),
        resolveStorePath: () => path.join(f.root, 'sessions.json'), resolveSessionFilePath: () => transcript,
        runWithWorkAdmission: async (params, run) => run(params.signal) },
      runEmbeddedAgent: async () => assert.fail('No SDK/model worker is allowed in this unit control.') } } };
    const projectScopes = admittedProjectScopes(api);
    projectScopes.activate = async () => ({ taskId: task.taskId });
    const sharedState = {}, calls = [], stopCalls = [];
    const production = path.join(f.root, 'stream.mjs');
    await fs.writeFile(production, 'export const ordered = values => [...values];\n');
    const runtime = createOpenClawRuntime(api, { pluginRoot, nativeHooks: true, sharedState, projectScopes,
      reviewerFactory: Object.assign(async options => {
        if (options.role === 'stop-reviewer') {
          stopCalls.push(options);
          assert.equal(typeof options.readKnownOriginalObligations, 'function');
          assert.equal(options.request.approvedProposalInventory, undefined);
          const current = options.readKnownOriginalObligations();
          assert.equal(current?.items.length, 1);
          assert.equal(current.sourceRunId, 'proposal-run');
          return scriptedWorkspaceReview({ ...options, hostAdapter }, { file: production, script: async ({ task, call, read }) => {
            for (const file of task.basisFiles) await read(file);
            const original = await read(task.basisFiles.find(file => path.basename(file).startsWith('user-original-0')));
            const response = await call('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
              text: corroborated ? 'Return records in arrival order.' : canonicalDuty, citeId: original,
              lineStart: corroborated ? 2 : 1, lineEnd: corroborated ? 2 : 1,
              ...(corroborated ? { knownCandidateId: current.items[0].id,
                knownDutyReason: 'The actual atomic source line states the complete retained duty.' } : {}) }],
              scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
            const page = JSON.parse(response.content[0].text), object = page.items.find(item => item.description === canonicalDuty);
            const candidateId = page.knownObligations.items[0].id;
            assert.equal(candidateId, current.items[0].id);
            const citeId = checked ? await read(production) : null;
            const args = { summary: 'Actual runtime handoff assessment.', ...(checked ? { knownObligations: [{ id: candidateId,
              disposition: 'CURRENT', objectId: object.objectId, verdict: 'NO_CONFIRMED_DEVIATION',
              reason: 'Current production source preserves the original ordering.', citeIds: [citeId] }] } : {}) };
            const result = JSON.parse((await call('finish_stop_review', args)).content[0].text);
            if (!result.complete) {
              assert.equal(result.pendingKnownOriginals[0].id, candidateId);
              await call('finish_stop_review', args);
            }
          } });
        }
        calls.push(options);
        assert.equal(options.role, 'artifact-reviewer');
        assert.equal(options.evidence.requiredProposalReview, undefined);
        const cohortContext = options.evidence.originalDutyCohortContext;
        assert(cohortContext, 'The fake transport must forward the actual host publication context.');
        assert.equal(cohortContext.owner.projectRoot, f.root);
        assert.equal(cohortContext.owner.taskId, task.taskId);
        assert.equal(cohortContext.owner.sessionId, 'native-parent');
        assert.equal(cohortContext.owner.sessionKey, 'agent:main:s');
        assert.equal(cohortContext.sourceRunId, 'proposal-run');
        assert.equal(typeof cohortContext.owner.scopeFingerprint, 'string');
        assert(cohortContext.owner.scopeFingerprint.trim());
        assert(Number.isSafeInteger(cohortContext.owner.enabledRevision) && cohortContext.owner.enabledRevision >= 0);
        const tools = await createDocumentTools({ projectRoot: f.root, semantic: options.evidence.semanticRequest,
          requestPath: options.request.semanticReviewRequestPath, originalDutyCohortContext: cohortContext });
        for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
        const message = options.evidence.semanticRequest.originalRequirements.userMessages[0];
        const { anchor } = await tools.execute({ action: 'read_original', ref: message.ref, start: 1, count: 1 });
        const coverage = await tools.verifyRequirementCoverage([{ originalSourceAnchorId: anchor.anchorId,
          requirement: canonicalDuty, disposition: 'COVERED', reason: 'The complete current plan represents this obligation.',
          targets: [{ path: 'openspec/changes/add-stream/proposal.md', start: 2, end: 2 }] }]);
        return { sessionId: 'document-review', originalRequirementCoverage: coverage,
          result: { summary: 'Current plan reviewed.', findings: [], edits: [] }, close: async () => {} };
      }, { supportsStopTasks: true }),
      postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }),
      compatibility: async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }),
      stopStartCompatibility: async () => ({ version: 1, onStart: () => () => {}, drain: async () => {}, diagnosticsEnabled: () => true }),
    });
    t.after(() => runtime.dispose());
    const ctx = { agentId: 'main', sessionId: 'native-parent', sessionKey: 'agent:main:s', workspaceDir: f.root,
      runId: 'proposal-run', trigger: 'user', abortSignal: new AbortController().signal };
    if (integrated) await runtime.sessionStart({ sessionId: ctx.sessionId, source: 'startup' }, ctx);
    await runtime.prompt({ prompt: f.source.text }, ctx);
    await runtime.beforeTool({ toolName: 'write', toolCallId: 'w', params: { path: 'openspec/changes/add-stream/tasks.md' } }, ctx);
    await fs.appendFile(path.join(f.root, 'openspec/changes/add-stream/tasks.md'), '- [ ] Verify ordering.\n');
    await runtime.toolResult({ toolName: 'write', toolCallId: 'w', args: { path: 'openspec/changes/add-stream/tasks.md' },
      result: { content: [{ type: 'text', text: 'Written.' }] } }, ctx);
    assert.equal(calls.length, 1);
    const state = sharedState.states.get('main:native-parent');
    const cohort = observed(state);
    assert(cohort, topology);
    assert.equal(cohort.items.length, 1);
    assert.equal(cohort.items[0].requirement, canonicalDuty);
    assert.equal(cohort.exhaustive, false);
    if (integrated) {
      const configured = await loadConfig({ cwd: f.root, pluginRoot });
      assert.equal(configured.runtimeV2.artifactCorrection.requireOpenSpecProposalCoverage === true, false);
      assert.equal(configured.runtimeV2.artifactCorrection.requireOpenSpecPlanReadiness === true, false);
      assert.equal(configured.runtimeV2.stopCorrection.requireCurrentProductionCoverage, false);
      assert.equal(configured.runtimeV2.stopCorrection.requireProductionOriginCoverage, false);
      assert.equal(configured.runtimeV2.stopCorrection.maxCorrectionsPerSession, 2);
      assert.equal(configured.runtimeV2.stopCorrection.maxCorrectionsPerFlow, 2);
      await fs.appendFile(transcript, '\n' + JSON.stringify({ type: 'message', id: 'proposal-final', parentId: 'u1',
        message: { role: 'assistant', content: 'The Proposal is ready for approval.' } }) + '\n');
      await runtime.agentEnd({ runId: ctx.runId, success: true,
        messages: [{ role: 'assistant', content: 'The Proposal is ready for approval.' }] }, ctx);
      await runtime.waitForNativeReviews({ drain: true });
      await fs.appendFile(transcript, JSON.stringify({ type: 'message', id: 'approval', parentId: 'proposal-final',
        message: { role: 'user', content: 'Approved. Apply the current Proposal.', idempotencyKey: 'apply-run:user' } }) + '\n');
      const apply = { ...ctx, runId: 'apply-run' };
      await runtime.prompt({ prompt: 'Approved. Apply the current Proposal.' }, apply);
      assert.equal(observed(state).id, cohort.id);
      await runtime.beforeTool({ toolName: 'write', toolCallId: 'implementation', params: { path: 'stream.mjs' } }, apply);
      await fs.appendFile(production, '// Preserve the public ordering contract.\n');
      await runtime.toolResult({ toolName: 'write', toolCallId: 'implementation', args: { path: 'stream.mjs' },
        result: { content: [{ type: 'text', text: 'Written.' }] } }, apply);
      await fs.appendFile(transcript, JSON.stringify({ type: 'message', id: 'apply-final', parentId: 'approval',
        message: { role: 'assistant', content: 'The implementation is complete.' } }) + '\n');
      await runtime.finalize({ lastAssistantMessage: 'The implementation is complete.' }, apply);
      await runtime.agentEnd({ runId: apply.runId, success: true,
        messages: [{ role: 'assistant', content: 'The implementation is complete.' }] }, apply);
      await runtime.waitForNativeReviews({ drain: true });
      assert(stopCalls.length > 0, JSON.stringify({ topology, warnings }));
      const saved = await findTask({ projectRoot: f.root, sessionId: 'native-parent', explicitTaskId: task.taskId });
      assert.equal(saved.verification.status, checked ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED', JSON.stringify({ topology, warnings, verification: saved.verification }));
      if (!checked) assert.equal(saved.verification.reasonCode, 'STOP_KNOWN_ORIGINAL_OBLIGATION_UNVERIFIED');
    }
  });
});
