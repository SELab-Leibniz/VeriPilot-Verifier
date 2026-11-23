import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

let buildRoot, pluginRoot, createRuntime, ensureTask, taskDirectory, registerPlanControl, createDocumentTools, loadConfig;
before(async () => {
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-bundle-build-')));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: buildRoot });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ ensureTask, taskDirectory } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
  ({ registerOpenSpecPlanControl: registerPlanControl } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs'))));
  ({ createDocumentTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/document-tools.mjs'))));
  ({ loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs'))));
});
after(() => fs.rm(buildRoot, { recursive: true, force: true }));

async function fixture(t, { artifacts, documents, reviewer, extraConfig = '', supportFiles = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-document-bundle-')));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const configFile = path.join(root, '.runtime-corrector/config.yaml');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, `version: 2
artifacts:
${artifacts ?? `  - name: plan
    stage: proposal
    patterns: ["notes/*.md"]
    relatedRoot: project
    relatedPatterns: ["notes/*.md"]
    rules:
      enabled: false
    review:
      enabled: true`}
dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
${extraConfig}
`);
  documents ??= { 'notes/overview.md': '# Overview\nRetain local preferences.\n',
    'notes/design.md': '# Design\nRestore local preferences.\n', 'notes/tasks.md': '# Tasks\n- [ ] Retain preferences.\n' };
  for (const [file, body] of Object.entries({ ...documents, ...supportFiles })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  const sessionId = 'bundle-parent', sessionKey = 'agent:main:bundle';
  const transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, [JSON.stringify({ type: 'session', id: sessionId }),
    JSON.stringify({ type: 'message', id: 'original', parentId: null,
      message: { role: 'user', content: 'Retain local preferences.' } })].join('\n'));
  const sharedState = {}, methods = new Map(), warnings = [], calls = [];
  const api = { id: 'runtime-corrector', config: { agents: { defaults: { model: { primary: 'test/test' } } } },
    logger: { warn: value => warnings.push(value) }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
    runtime: { version: '2026.7.1-2', gateway: { async request(method, params) {
      if (method === 'agent.wait') return { runId: params.runId, status: 'ok' };
      if (method === 'autopilot.status') return { projection: { status: 'idle' } };
      assert.fail(`Unexpected gateway method: ${method}`);
    } }, agent: { session: { getSessionEntry: async () => ({ sessionId, sessionFile: transcript }),
      resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
      runWithWorkAdmission: async (params, run) => run(params.signal) },
      runEmbeddedAgent: async () => assert.fail('These controls must not launch an SDK worker.') } } };
  const projectScopes = admittedProjectScopes(api);
  const task = await ensureTask({ projectRoot: root, sessionId });
  projectScopes.activate = async () => ({ taskId: task.taskId });
  runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true, projectScopes,
    reviewerFactory: async options => {
      assert.equal(options.role, 'artifact-reviewer');
      calls.push(options);
      return reviewer ? reviewer(options, { root, calls }) : { sessionId: `bundle-review-${calls.length}`,
        result: { summary: 'Reviewed the current declared bundle.', findings: [], edits: [] }, async close() {} };
    }, postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  const ctx = { workspaceDir: root, sessionId, sessionKey, agentId: 'main', runId: 'proposal', trigger: 'user',
    abortSignal: new AbortController().signal };
  await runtime.prompt({ prompt: 'Retain local preferences.' }, ctx);
  const state = sharedState.states.get(`main:${sessionId}`);
  let next = 0;
  async function write(changes, { pending = false } = {}) {
    const toolCallId = `bundle-write-${++next}`, args = { command: 'update the declared documents' };
    await runtime.beforeTool({ toolName: 'exec', toolCallId, params: args }, ctx);
    for (const [file, body] of Object.entries(changes)) await fs.writeFile(path.join(root, file), body);
    const event = { toolName: 'exec', toolCallId, args, result: { content: [{ type: 'text', text: 'Updated the declared documents.' }],
      details: pending ? { status: 'running', sessionId: 'pending-process' } : { status: 'completed', exitCode: 0 } } };
    return { toolCallId, result: await runtime.toolResult(event, ctx) };
  }
  const journal = async () => fs.readFile(path.join(taskDirectory(root, task.taskId), 'journal/events.jsonl'), 'utf8')
    .then(body => body.split('\n').filter(Boolean).map(JSON.parse), error => { if (error.code === 'ENOENT') return []; throw error; });
  return { root, api, runtime, state, sharedState, task, ctx, calls, warnings, write, journal, documents, methods, transcript, configFile, projectScopes };
}

const changeName = 'retain-preferences', prefix = `openspec/changes/${changeName}`;
const planDocuments = {
  [`${prefix}/proposal.md`]: '# Proposal\nRetain local preferences.\n',
  [`${prefix}/design.md`]: '# Design\nRestore local preferences.\n',
  [`${prefix}/tasks.md`]: '# Tasks\n- [ ] Retain local preferences.\n',
  [`${prefix}/specs/preferences/spec.md`]: '## ADDED Requirements\n### Requirement: Preferences\nThe application SHALL retain local preferences.\nThe application SHALL restore saved preferences after reopening.\n',
};
const planArtifacts = `  - name: plan
    stage: proposal
    patterns: ["${prefix}/**/*.md"]
    relatedRoot: project
    relatedPatterns: ["${prefix}/**/*.md"]
    rules:
      enabled: false
    review:
      enabled: true`;

async function planRpc(f, action, params) {
  let response;
  await f.methods.get(`runtime-corrector.openspec.${action}`)({ params,
    client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
    respond(...args) { response = args; } });
  assert(response);
  return response;
}
async function planOk(f, action, params) {
  const [ok, result, error] = await planRpc(f, action, params);
  assert.equal(ok, true, `${error?.message} ${JSON.stringify({ warnings: f.warnings, completion: f.state.nativeCompletion,
    policy: f.state.nativeProposalCoveragePolicy, pending: f.state.nativePreparingStop ? true : false })}`);
  return result;
}
async function settle(f) {
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
}

test('one equivalent multi-file write dispatches one fresh whole-bundle review and retains each file association', async t => {
  const f = await fixture(t);
  const { toolCallId } = await f.write({ 'notes/overview.md': '# Overview\nKeep preferences locally.\n',
    'notes/design.md': '# Design\nRestore preferences from local storage.\n' });
  assert.equal(f.calls.length, 1, 'A completed write of one equivalent bundle must not re-review that same bundle per trigger.');
  const request = f.calls[0].evidence.semanticRequest;
  assert.deepEqual(request.triggerFiles, ['notes/design.md', 'notes/overview.md']);
  assert.deepEqual([...request.artifactFiles].sort(), Object.keys(f.documents).sort());
  const rows = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === toolCallId);
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.result.status === 'passed'));
  assert.equal(new Set(rows.map(row => row.result.metadata.reviewBundle.id)).size, 1);
  assert(rows.every(row => row.result.metadata.semanticReview.forkSessionId === 'bundle-review-1'));
  assert.equal((await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT' && row.toolCallId === toolCallId).length, 2);
  assert.deepEqual(f.warnings, []);
});

test('ordinary single-file writes and the next multi-file write each earn a fresh review', async t => {
  const f = await fixture(t);
  await f.write({ 'notes/overview.md': '# Overview\nFirst current version.\n' });
  assert.equal(f.calls.length, 1);
  await f.write({ 'notes/overview.md': '# Overview\nSecond current version.\n', 'notes/design.md': '# Design\nSecond design.\n' });
  assert.equal(f.calls.length, 2, 'Sharing is scoped to a completed tool result, never a historical PASS.');
  assert.notEqual(f.calls[0].evidence.semanticRequest.triggerFile, undefined);
});

test('a blocking sibling finding holds every association of its shared review', async t => {
  const f = await fixture(t, { reviewer: async () => ({ sessionId: 'blocked-bundle',
    result: { summary: 'The design contradicts the required local preference.', edits: [], findings: [{
      ruleId: 'AGENT-LOCAL-PREFERENCE', severity: 'error', path: 'notes/design.md', line: 2,
      message: 'The preference is sent elsewhere.', evidence: ['The current design uploads the preference.'] }] }, async close() {} }) });
  const { toolCallId, result } = await f.write({ 'notes/overview.md': '# Overview\nKeep preferences locally.\n',
    'notes/design.md': '# Design\nUpload preferences remotely.\n' });
  assert.equal(f.calls.length, 1);
  const rows = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === toolCallId);
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.result.status === 'failed' && row.result.diagnostics.some(d => d.ruleId === 'AGENT-LOCAL-PREFERENCE')));
  assert.match(JSON.stringify(result), /The preference is sent elsewhere/u);
});

test('separate configured artifact nodes keep separate workers despite the same related file set', async t => {
  const artifacts = ['overview', 'design'].map(name => `  - name: ${name}
    stage: proposal
    patterns: ["notes/${name}.md"]
    relatedRoot: project
    relatedPatterns: ["notes/*.md"]
    rules:
      enabled: false
    review:
      enabled: true`).join('\n');
  const f = await fixture(t, { artifacts });
  await f.write({ 'notes/overview.md': '# Overview\nUpdated overview.\n', 'notes/design.md': '# Design\nUpdated design.\n' });
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(call => call.evidence.semanticRequest.triggerFiles === undefined));
});

test('trigger-specific deterministic failures refuse grouping and cannot be replaced by a worker PASS', async t => {
  const artifacts = `  - name: plan
    stage: proposal
    patterns: ["notes/*.md"]
    relatedRoot: project
    relatedPatterns: ["notes/*.md"]
    rules:
      enabled: true
      file: review.rules.yaml
    review:
      enabled: true`;
  const rules = `version: 1
rules:
  - id: REQUIRE-LOCAL-PREFERENCE
    type: require-text
    values: ["local preferences"]
    severity: error
`;
  const f = await fixture(t, { artifacts, supportFiles: { '.runtime-corrector/review.rules.yaml': rules } });
  const { toolCallId } = await f.write({ 'notes/overview.md': '# Overview\nRetain local preferences after restart.\n',
    'notes/design.md': '# Design\nUpload all preferences elsewhere.\n' });
  const rows = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === toolCallId);
  assert.equal(f.calls.length, 2, `Different trigger diagnostics must remain independent. ${JSON.stringify({ warnings: f.warnings,
    reviews: rows.map(row => ({ trigger: row.result.metadata.triggerFile, diagnostics: row.result.diagnostics })) })}`);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => path.basename(row.file) === 'overview.md').result.status, 'passed');
  const sibling = rows.find(row => path.basename(row.file) === 'design.md').result;
  assert.equal(sibling.status, 'failed');
  assert(sibling.diagnostics.some(row => row.ruleId === 'REQUIRE-LOCAL-PREFERENCE'));
});

for (const mutation of ['bytes', 'new-sibling', 'policy']) test(`shared review refuses ${mutation} changed during its worker`, async t => {
  const f = await fixture(t, { reviewer: async (_options, { root }) => {
    if (mutation === 'bytes') await fs.appendFile(path.join(root, 'notes/design.md'), 'Changed during review.\n');
    if (mutation === 'new-sibling') await fs.writeFile(path.join(root, 'notes/new-sibling.md'), '# Newly required context\n');
    if (mutation === 'policy') await fs.appendFile(path.join(root, '.runtime-corrector/config.yaml'), '\n# policy changed\n');
    return { sessionId: 'stale-worker', result: { summary: 'A returned PASS cannot certify freshness.', findings: [], edits: [] }, async close() {} };
  } });
  const { toolCallId, result } = await f.write({ 'notes/overview.md': '# Overview\nUpdated overview.\n',
    'notes/design.md': '# Design\nUpdated design.\n' });
  assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(result), /DOCUMENT_BUNDLE_BASIS_CHANGED/u);
  assert.equal((await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === toolCallId).length, 0);
});

test('a pending document command receives separate reviews and remains unverified', async t => {
  const f = await fixture(t);
  const { toolCallId, result } = await f.write({ 'notes/overview.md': '# Overview\nPending overview.\n',
    'notes/design.md': '# Design\nPending design.\n' }, { pending: true });
  assert.equal(f.calls.length, 2);
  const row = (await f.journal()).find(row => row.type === 'OPENCLAW_DOCUMENT_SCOPE_UNVERIFIED' && row.toolCallId === toolCallId);
  assert.equal(row.status, 'UNVERIFIED');
  assert.match(JSON.stringify(result), /DOCUMENT_EXECUTION_PENDING/u);
});

test('an approved Apply multi-file drift is detected before any semantic worker dispatch', async t => {
  const f = await fixture(t, { artifacts: planArtifacts, documents: planDocuments });
  registerPlanControl(f.api, f.runtime);
  await settle(f);
  const address = { sessionId: f.ctx.sessionId, sessionKey: f.ctx.sessionKey, runId: f.ctx.runId, changeName };
  const preview = await planOk(f, 'preview', address);
  await planOk(f, 'approve', { ...address, expectedRevision: preview.revision });
  await planOk(f, 'arm', { ...address, expectedRevision: preview.revision, applyRunId: 'apply' });
  f.ctx.runId = 'apply';
  await f.runtime.prompt({ prompt: 'Apply the approved plan.' }, f.ctx);
  const { toolCallId, result } = await f.write({ [`${prefix}/design.md`]: '# Design\nChanged the approved design.\n',
    [`${prefix}/proposal.md`]: '# Proposal\nChanged the approved requirement.\n' });
  assert.equal(f.calls.length, 0);
  assert.match(JSON.stringify(result), /Apply changed the approved OpenSpec plan/u);
  const rows = await f.journal();
  const skipped = rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED' && row.toolCallId === toolCallId);
  assert.equal(skipped.length, 2);
  assert(skipped.every(row => row.reasonCode === 'OPENSPEC_APPLY_PLAN_CHANGED'));
  assert.equal(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT' && row.toolCallId === toolCallId).length, 2);
});

test('a fresh shared whole-plan review reads every required identity; the next write cannot reuse its coverage', async t => {
  let skipReads = false;
  const receipts = [], currentRequests = [];
  const requirementRows = [{ start: 1, end: 1, requirement: 'Retain local preferences.' },
    { start: 2, end: 2, requirement: 'Restore saved preferences after reopening.' }];
  const f = await fixture(t, { artifacts: planArtifacts, documents: planDocuments,
    extraConfig: 'artifactCorrection:\n  originalRequirementsEnabled: true\n  requireOpenSpecProposalCoverage: true',
    reviewer: async options => {
      const cohort = options.evidence.originalDutyCohortContext;
      assert(cohort?.owner, 'The native fake producer must retain the captured host context.');
      assert.equal(cohort.owner.projectRoot, await fs.realpath(options.projectRoot));
      assert.equal(cohort.owner.taskId, options.taskId);
      assert.equal(cohort.owner.sessionId, options.parentSessionId);
      assert.equal(cohort.sourceRunId, options.evidence.snapshot.invocation.runId);
      assert.equal(typeof cohort.owner.sessionKey, 'string'); assert(cohort.owner.sessionKey.trim());
      assert.equal(typeof cohort.owner.scopeFingerprint, 'string'); assert(cohort.owner.scopeFingerprint.trim());
      assert(Number.isSafeInteger(cohort.owner.enabledRevision) && cohort.owner.enabledRevision >= 0);
      const tools = await createDocumentTools({ projectRoot: options.projectRoot, semantic: options.evidence.semanticRequest,
        requestPath: options.request.semanticReviewRequestPath, originalDutyCohortContext: cohort,
        requiredProposalReview: options.evidence.requiredProposalReview, requiredPlanReadiness: options.evidence.requiredPlanReadiness });
      const required = await tools.execute({ action: 'required_proposal' });
      assert.equal(required.items.length, 2);
      currentRequests.push(options.evidence.requiredProposalReview.requiredAtoms.map(({ source, requirement }) => {
        const span = requirementRows.find(row => row.requirement === requirement);
        assert(span);
        return { source: { ref: source.ref, sha256: source.sha256, start: span.start, end: span.end }, requirement };
      }));
      const checklist = await tools.execute({ action: 'plan_checklist' });
      if (skipReads) {
        await assert.rejects(tools.verifyRequirementCoverage(receipts[0].rawCoverage), /issued by read_original in this review/u);
        return { sessionId: 'unread-current-plan', result: { summary: 'The required current reads are unavailable.', findings: [], edits: [] }, async close() {} };
      }
      for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
      const rawCoverage = [];
      for (const [index, item] of required.items.entries()) {
        const { anchor } = await tools.execute(item.readOriginal);
        rawCoverage.push({ originalSourceAnchorId: anchor.anchorId, requirement: item.requirement,
          disposition: 'COVERED', reason: 'The current spec defines this required behavior.',
          targets: [{ path: `${prefix}/specs/preferences/spec.md`, start: 3 + index, end: 3 + index }] });
      }
      const readiness = { inventorySha256: checklist.inventorySha256, status: 'READY', rows: checklist.items.map(task => ({
        taskId: task.id, status: 'READY', reason: 'The current plan defines the required work.',
        targets: [{ path: task.path, start: task.line, end: task.line }] })) };
      const coverage = await tools.verifyRequirementCoverage(rawCoverage);
      const planReadiness = await tools.verifyPlanReadiness(readiness);
      receipts.push({ rawCoverage, coverage, requests: currentRequests.at(-1) });
      return { sessionId: `fresh-plan-${receipts.length}`, originalRequirementCoverage: coverage, planReadiness,
        result: { summary: 'Reviewed all current plan documents against the exact required identity.', findings: [], edits: [] }, async close() {} };
    } });
  f.api.runtime.agent.resolveAgentWorkspaceDir = () => f.root;
  const resolve = f.projectScopes.resolve;
  f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args), plan: await loadConfig({ cwd: f.root, pluginRoot }) });
  registerPlanControl(f.api, f.runtime);
  const sourceText = requirementRows.map(row => row.requirement).join('\n');
  async function beginStrict(runId) {
    await settle(f);
    const address = { sessionId: f.ctx.sessionId, sessionKey: f.ctx.sessionKey, runId, changeName };
    await planOk(f, 'prepare', { ...address, sourceRunId: runId, sourceSha256: sha256(sourceText), requirePlanReadiness: true,
      requirements: requirementRows });
    await fs.appendFile(f.transcript, '\n' + JSON.stringify({ type: 'message', id: `${runId}-original`, parentId: 'original',
      message: { role: 'user', content: sourceText, idempotencyKey: `${runId}:user` } }) + '\n');
    f.ctx.runId = runId;
    await f.runtime.prompt({ prompt: sourceText }, f.ctx);
    return address;
  }
  const atomRequests = receipt => receipt.requests;
  const address = await beginStrict('strict-proposal');
  await f.write({ [`${prefix}/proposal.md`]: '# Proposal\nRetain local preferences across sessions.\n',
    [`${prefix}/design.md`]: '# Design\nRestore preferences from local storage.\n' });
  assert.equal(f.calls.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].coverage.rows.length, 2);
  assert.equal(receipts[0].coverage.scope.length, 4);
  await settle(f);
  const first = await planOk(f, 'preview', address);
  const requiredAtoms = atomRequests(receipts[0]);
  const approved = await planOk(f, 'approve', { ...address, expectedRevision: first.revision, requiredAtoms });
  assert.equal(approved.planReadiness.status, 'READY');
  skipReads = true;
  const nextAddress = await beginStrict('strict-proposal-next');
  const second = await f.write({ [`${prefix}/proposal.md`]: '# Proposal\nRetain local preferences in the current account.\n',
    [`${prefix}/design.md`]: '# Design\nRestore the current account preference.\n' });
  assert.equal(f.calls.length, 2);
  assert.equal(receipts.length, 1, 'A previous read receipt never certifies a new review.');
  const secondRows = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === second.toolCallId);
  assert.equal(secondRows.length, 2);
  assert(secondRows.every(row => !row.result.metadata.semanticReview.originalRequirementCoverage));
  await settle(f);
  const next = await planOk(f, 'preview', nextAddress);
  assert.notEqual(next.revision, first.revision);
  const foreign = await planRpc(f, 'approve', { ...nextAddress, expectedRevision: next.revision, requiredAtoms });
  assert.equal(foreign[0], false);
  assert.match(foreign[2].message, /stale or foreign source/u);
  const denied = await planRpc(f, 'approve', { ...nextAddress, expectedRevision: next.revision, requiredAtoms: currentRequests[1] });
  assert.equal(denied[0], false);
  assert.match(denied[2].message, /unavailable|incomplete|coverage/u);
  skipReads = false;
  const recoveryAddress = await beginStrict('strict-proposal-recovered');
  await f.write({ [`${prefix}/proposal.md`]: '# Proposal\nRetain local preferences across restarts.\n',
    [`${prefix}/design.md`]: '# Design\nRestore the local preference after restarting.\n' });
  assert.equal(f.calls.length, 3);
  assert.equal(receipts.length, 2);
  await settle(f);
  const recovered = await planOk(f, 'preview', recoveryAddress);
  assert.equal((await planOk(f, 'approve', { ...recoveryAddress, expectedRevision: recovered.revision,
    requiredAtoms: atomRequests(receipts[1]) })).planReadiness.status, 'READY');
  assert.deepEqual(f.warnings, []);
});
