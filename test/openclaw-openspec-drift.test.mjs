import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';

const changeName = 'preserve-display-order';
const prefix = `openspec/changes/${changeName}`;
const tasks = '# Tasks\n\n- [ ] Retain the selected order.\n';
let output, pluginRoot, createRuntime, registerPlanControl, inspectPlan, findTask, ensureTask;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-drift-build-'));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ registerOpenSpecPlanControl: registerPlanControl, inspectArmedOpenSpecApply: inspectPlan } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs'))));
  ({ findTask, ensureTask } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
});
after(() => fs.rm(output, { recursive: true, force: true }));

// This fake producer replaces only model transport. Coverage authority must
// still come from the same packaged host verifier used by this runtime.
async function issuedFixtureCoverage(options, atoms) {
  assert.equal(options.role, 'artifact-reviewer', 'Only an artifact producer may obtain document coverage.');
  const { createDocumentTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/document-tools.mjs')));
  const semantic = options.evidence?.semanticRequest;
  assert(semantic?.originalRequirements, 'The fixture must review the actual host original sources.');
  const tools = await createDocumentTools({ projectRoot: options.projectRoot, semantic,
    requestPath: options.request.semanticReviewRequestPath, signal: options.abortSignal,
    originalDutyCohortContext: options.evidence.originalDutyCohortContext,
    requiredProposalReview: options.evidence.requiredProposalReview,
    requiredPlanReadiness: options.evidence.requiredPlanReadiness });
  const scope = tools.manifest();
  for (const file of scope) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
  const target = scope.find(file => file.path.endsWith('/spec.md')) ?? scope[0];
  assert(target, 'A fixture coverage assessment needs an actual declared plan target.');
  const line = Math.min(target.path.endsWith('/spec.md') ? 4 : 3, target.lines);
  const rows = [];
  for (const { source, requirement } of atoms) {
    assert(semantic.originalRequirements.userMessages.some(value => value.ref === source.ref && value.sha256 === source.sha256),
      'The fixture source must be present in this actual semantic request.');
    const { anchor } = await tools.execute({ action: 'read_original', ref: source.ref,
      start: source.start, count: source.end - source.start + 1 });
    rows.push({ originalSourceAnchorId: anchor.anchorId, requirement, disposition: 'COVERED',
      reason: 'The fixture reviewed the current declared plan range.', targets: [{ path: target.path, start: line, end: line }] });
  }
  const coverage = await tools.verifyRequirementCoverage(rows), accounting = tools.originalDutyAccounting();
  return { originalRequirementCoverage: coverage, ...(accounting ? { originalDutyAccounting: accounting } : {}) };
}

async function fixture(t, { arm = true, shadow = false, review = false, reviewerFailure = false,
  proposalOnly = false, reviewer, strictSources, partialManualCheck = false, fullPlanReview = false, configVersion = 2 } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-native-plan-drift-')));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: ${configVersion}
artifacts:
${partialManualCheck ? `  - name: partial-plan
    stage: proposal
    patterns: ["${prefix}/design.md"]
    rules:
      enabled: false
    review:
      enabled: true
` : ""}  - name: plan
    stage: proposal
    patterns: ["openspec/changes/**/proposal.md", "openspec/changes/**/design.md", "openspec/changes/**/tasks.md", "openspec/changes/**/specs/**/spec.md"]
${strictSources || fullPlanReview ? `    relatedRoot: project
    relatedPatterns: ["${prefix}/**/*.md"]
` : ""}    rules:
      enabled: false
    review:
      enabled: ${review}
${configVersion === 2 ? `dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
` : ''}${strictSources ? `artifactCorrection:
  originalRequirementsEnabled: true
` : ''}shadowMode: ${shadow}
`);
  const documents = {
    [`${prefix}/proposal.md`]: '# Proposal\n\nRetain display preferences.\n',
    [`${prefix}/design.md`]: '# Design\n\nRestore selected order on start.\n',
    [`${prefix}/tasks.md`]: tasks,
    [`${prefix}/specs/order/spec.md`]: '## ADDED Requirements\n\n### Requirement: Order\nThe app SHALL retain the selected order.\n',
  };
  await fs.mkdir(path.join(root, prefix, 'specs/order'), { recursive: true });
  for (const [relative, text] of Object.entries(documents)) await fs.writeFile(path.join(root, relative), text);
  const sid = 'native-plan-parent', sessionKey = 'agent:main:plan-drift';
  const transcript = path.join(root, 'native.jsonl');
  const originalText = strictSources?.[0]?.text ?? 'Retain the selected display order.';
  await fs.writeFile(transcript, [{ type: 'session', id: sid }, { type: 'message', id: 'original', parentId: null,
    message: { role: 'user', content: originalText } }].map(JSON.stringify).join('\n'));
  const sharedState = {}, warnings = [], methods = new Map();
  const sessions = { getSessionEntry: async () => ({ sessionId: sid, sessionFile: transcript }),
    resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
    runWithWorkAdmission: async (params, run) => run(params.signal) };
  const api = { id: 'runtime-corrector', config: { agents: { defaults: { model: { primary: 'test/test' } } } },
    logger: { warn: value => warnings.push(value) }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
    runtime: { version: '2026.7.1-2', gateway: { async request(method, params) {
      if (method === 'agent.wait') return { runId: params.runId, status: 'ok' };
      if (method === 'autopilot.status') return { projection: { status: 'idle' } };
      assert.fail(`Unexpected gateway method: ${method}`);
    } }, agent: { session: sessions,
      runEmbeddedAgent: async () => assert.fail('The plan drift guard must run without a model.') } } };
  const projectScopes = admittedProjectScopes(api);
  const task = await ensureTask({ projectRoot: root, sessionId: sid });
  projectScopes.activate = async () => ({ taskId: task.taskId });
  const calls = [];
  const reviewerFactory = async options => {
    calls.push(options.role);
    if (reviewerFailure) throw new Error('The artifact reviewer is unavailable.');
    if (reviewer) return reviewer(options);
    return { sessionId: 'artifact-review', result: { summary: 'Reviewed the selected artifact.', findings: [], edits: [] },
      async close() {} };
  };
  runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true, projectScopes,
    ...(review ? { reviewerFactory } : {}),
    postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  const ctx = { workspaceDir: root, sessionId: sid, sessionKey, agentId: 'main', runId: 'proposal', trigger: 'user',
    abortSignal: new AbortController().signal };
  await runtime.prompt({ prompt: originalText }, ctx);
  const state = sharedState.states.get(`main:${sid}`);
  registerPlanControl(api, { async openSpecPlanTarget(query) {
    return query.runId === state.nativeRunId && query.sessionId === sid && query.sessionKey === sessionKey
      ? { state, projectRoot: root, current: async () => true,
        ...(strictSources ? { requireProposalCoverage: true, readProposalSources: async () => strictSources } : {}) } : null;
  } });
  async function request(action, params) {
    let response;
    await methods.get(`runtime-corrector.openspec.${action}`)({ params,
      client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
      respond(...args) { response = args; } });
    assert(response);
    return response;
  }
  async function rpc(action, params) {
    const [ok, value, error] = await request(action, params);
    assert.equal(ok, true, error?.message);
    return value;
  }
  const address = { sessionKey, sessionId: sid, runId: ctx.runId, changeName };
  if (arm) {
    const preview = await rpc('preview', address);
    const approval = { ...address, expectedRevision: preview.revision };
    await rpc('approve', approval);
    await rpc('arm', { ...approval, applyRunId: 'apply' });
  }
  if (!proposalOnly) {
    await runtime.agentEnd({ runId: ctx.runId, success: true }, ctx);
    await runtime.waitForNativeReviews({ drain: true });
    ctx.runId = 'apply';
    await runtime.prompt({ prompt: 'Apply the approved plan.' }, ctx);
  }

  const journal = async () => {
    const task = await findTask({ projectRoot: root, sessionId: sid });
    const file = path.join(root, '.runtime-correction/tasks', task.taskId, 'journal/events.jsonl');
    return fs.readFile(file, 'utf8').then(text => text.split('\n').filter(Boolean).map(JSON.parse), error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  };
  let nextId = 0;
  async function edit(relative, contents, { result = {}, toolName = 'write', args, beforeResult } = {}) {
    const toolCallId = `native-change-${++nextId}`;
    args ??= { path: path.join(root, relative), content: contents };
    await runtime.beforeTool({ toolName, toolCallId, params: args }, ctx);
    if (contents !== null) await fs.writeFile(path.join(root, relative), contents);
    await beforeResult?.();
    const event = { toolName, toolCallId, args, result: {
      content: [{ type: 'text', text: 'Original host tool result' }], details: { original: true }, ...result,
    } };
    return { event, outcome: await runtime.toolResult(event, ctx), toolCallId };
  }
  async function check(relative, options = {}) {
    const toolCallId = `native-check-${++nextId}`;
    await runtime.beforeTool({ toolName: 'runtime_corrector', toolCallId, params: { command: 'check', subject: relative } }, ctx);
    const { runId, abortSignal, ...factoryContext } = ctx;
    return runtime.manualCheck(factoryContext, relative, { toolCallId, signal: abortSignal, ...options });
  }
  return { root, ctx, state, runtime, projectScopes, documents, warnings, calls, edit, check, journal, address, rpc, request,
    api, sharedState, transcript };
}

test('operator readiness requires strict coverage and reaches the real packaged Proposal hooks without enabling it implicitly', async t => {
  let factory;
  const f = await fixture(t, { arm: false, review: true, proposalOnly: true, fullPlanReview: true,
    reviewer: options => factory(options) });
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')));
  const { registerDocumentTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/document-tools.mjs')));
  const { createOpenClawReviewerFactory } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/reviewer.mjs')));
  const configuration = path.join(f.root, '.runtime-corrector/config.yaml');
  await fs.appendFile(configuration, '\nartifactCorrection:\n  originalRequirementsEnabled: true\n  requireOpenSpecProposalCoverage: false\n');
  const resolve = f.projectScopes.resolve;
  f.api.runtime.agent.resolveAgentWorkspaceDir = () => f.root;
  f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args), plan: await loadConfig({ cwd: f.root, pluginRoot }) });
  registerPlanControl(f.api, f.runtime);
  const text = 'Retain the selected order and restore it after reopening.';
  const requirements = ['Retain the selected display ordering.'].map(requirement => ({ start: 1, end: 1, requirement }));
  const address = { ...f.address, runId: 'readiness-proposal' };
  const preparation = { ...address, sourceRunId: address.runId, sourceSha256: sha256(text), requirements,
    requirePlanReadiness: true };
  const rejected = await f.request('prepare', preparation);
  assert.equal(rejected[0], false);
  assert.equal(rejected[2].code, 'CONFLICT');
  assert.equal((await loadConfig({ cwd: f.root, pluginRoot })).runtimeV2.artifactCorrection.requireOpenSpecProposalCoverage, undefined);

  await fs.writeFile(configuration, (await fs.readFile(configuration, 'utf8')).replace(
    'requireOpenSpecProposalCoverage: false', 'requireOpenSpecProposalCoverage: true'));
  assert.equal((await f.rpc('prepare', preparation)).requirePlanReadiness, true);
  let documentFactory, invocations = 0;
  f.api.registerTool = callback => { documentFactory = callback; };
  registerDocumentTools(f.api);
  f.api.runtime.agent.runEmbeddedAgent = async params => {
    invocations++;
    const tool = documentFactory({ sessionId: params.sessionId, runId: params.runId });
    assert(tool);
    const call = async args => JSON.parse((await tool.execute('readiness-fixture', args)).content[0].text);
    const opened = await call({ action: 'open' });
    assert.equal(opened.requiredProposal.total, 1);
    assert.equal(opened.planReadiness.total, 1);
    const atoms = await call({ action: 'required_proposal' });
    const checklist = await call({ action: 'plan_checklist' });
    for (const file of await call({ action: 'manifest' }))
      await call({ action: 'read', path: file.path, start: 1, count: 200 });
    const { anchor } = await call(atoms.items[0].readOriginal);
    return { payloads: [{ text: JSON.stringify({ summary: 'The unchecked work is planned and its prerequisites are sourced.',
      findings: [], edits: [], originalRequirementCoverage: [{ originalSourceAnchorId: anchor.anchorId,
        requirement: requirements[0].requirement, disposition: 'COVERED', reason: 'The current spec retains the ordering.',
        targets: [{ path: `${prefix}/specs/order/spec.md`, start: 4, end: 4 }] }],
      planReadiness: { inventorySha256: checklist.inventorySha256, status: 'READY',
        rows: checklist.items.map(task => ({ taskId: task.id, status: 'READY', reason: 'Future work is defined by the current plan.',
          targets: [{ path: task.path, start: task.line, end: task.line }] })) } }) }], meta: {} };
  };
  factory = createOpenClawReviewerFactory(f.api);
  await fs.appendFile(f.transcript, '\n' + JSON.stringify({ type: 'message', id: 'readiness-original', parentId: 'original',
    message: { role: 'user', content: text, idempotencyKey: `${address.runId}:user` } }) + '\n');
  f.ctx.runId = address.runId;
  await f.runtime.prompt({ prompt: text }, f.ctx);
  assert.equal(f.state.nativeProposalCoveragePolicy.required, true);
  assert.equal(f.state.nativeProposalCoveragePolicy.requirePlanReadiness, false, 'Only the operator preparation opted into readiness.');
  const checked = await f.check(`${prefix}/tasks.md`);
  assert.equal(invocations, 1);
  assert.equal(checked.result.metadata.semanticReview.planReadiness.status, 'READY');
  assert.equal(checked.result.metadata.semanticReview.planReadiness.runId, address.runId);
  await f.runtime.agentEnd({ runId: address.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const preview = await f.rpc('preview', address);
  assert.equal(preview.requirePlanReadiness, true);
  const coverage = checked.result.metadata.semanticReview.originalRequirementCoverage;
  const approval = await f.rpc('approve', { ...address, expectedRevision: preview.revision,
    requiredAtoms: coverage.rows.map(row => ({ source: { ref: row.source.ref, sha256: row.source.sha256, start: 1, end: 1 },
      requirement: row.requirement })) });
  assert.equal(approval.planReadiness.status, 'READY');
  const armed = await f.rpc('arm', { ...address, expectedRevision: preview.revision, applyRunId: 'readiness-apply',
    expectedInventorySha256: approval.inventorySha256 });
  assert.equal(armed.planReadiness.inventorySha256, checked.result.metadata.semanticReview.planReadiness.inventorySha256);
});

test('a packaged full-plan manual recheck recovers exact staged private atoms from native original sources without rewriting', async t => {
  let factory;
  const f = await fixture(t, { arm: false, review: true, proposalOnly: true, fullPlanReview: true,
    reviewer: options => factory(options) });
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const { registerDocumentTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/document-tools.mjs')));
  const { createOpenClawReviewerFactory } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/reviewer.mjs')));
  const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')));
  const { selectApprovedPlanCoverage } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/approved-plan-coverage.mjs')));
  const text = 'Keep the selected order and restore it after reopening.';
  const requirements = ['Preserve the selected ordering preference.', 'Restore the retained ordering when reopened.']
    .map(requirement => ({ start: 1, end: 1, requirement }));
  assert(requirements.every(item => !text.includes(item.requirement)), 'The private canonical wording cannot be copied from the public paraphrase.');
  await fs.appendFile(path.join(f.root, '.runtime-corrector/config.yaml'), '\nartifactCorrection:\n  requireOpenSpecProposalCoverage: true\n');
  const resolve = f.projectScopes.resolve;
  f.api.runtime.agent.resolveAgentWorkspaceDir = () => f.root;
  f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args), plan: await loadConfig({ cwd: f.root, pluginRoot }) });
  let documentFactory, mode = 'unavailable', invocations = 0;
  const bindings = [];
  f.api.registerTool = callback => { documentFactory = callback; };
  registerDocumentTools(f.api);
  f.api.runtime.agent.runEmbeddedAgent = async params => {
    invocations++;
    bindings.push({ sessionId: params.sessionId, runId: params.runId });
    const tool = documentFactory(bindings.at(-1));
    assert(tool, 'The real reviewer must own the exact rc_document binding.');
    const call = async args => JSON.parse((await tool.execute('fixture', args)).content[0].text);
    const opened = await call({ action: 'open' });
    assert.equal(opened.requiredProposal?.total, 2, 'Manual review must retain the operator-staged inventory.');
    const inventory = await call({ action: 'required_proposal' });
    assert.deepEqual(inventory.items.map(row => row.requirement).sort(), requirements.map(row => row.requirement).sort());
    if (mode === 'unavailable') throw new Error('Scripted checker unavailable before completion.');
    const scope = await call({ action: 'manifest' });
    for (const file of scope) await call({ action: 'read', path: file.path, start: 1, count: 200 });
    const rows = [];
    for (const item of inventory.items) {
      const { anchor } = await call(item.readOriginal);
      rows.push({ originalSourceAnchorId: anchor.anchorId, requirement: item.requirement, disposition: 'COVERED',
        reason: 'The current spec retains and restores the selection.', targets: [{ path: `${prefix}/specs/order/spec.md`, start: 4, end: 4 }] });
    }
    return { payloads: [{ text: JSON.stringify({ summary: 'Reviewed the exact current plan.', edits: [],
      findings: mode === 'blocked' ? [{ ruleId: 'AGENT-PLAN-CONSISTENCY', severity: 'error', path: `${prefix}/design.md`, line: 3,
        message: 'The design contradicts the current spec.', evidence: [`${prefix}/design.md:3`], suggestion: 'Keep the plan consistent.' }] : [],
      originalRequirementCoverage: rows }) }], meta: {} };
  };
  factory = createOpenClawReviewerFactory(f.api);
  registerPlanControl(f.api, f.runtime);
  const address = { ...f.address, runId: 'staged-proposal' };
  assert.equal((await f.rpc('prepare', { ...address, sourceRunId: address.runId, sourceSha256: sha256(text), requirements })).status, 'PREPARED');
  await fs.appendFile(f.transcript, '\n' + JSON.stringify({ type: 'message', id: 'staged-original', parentId: 'original',
    message: { role: 'user', content: text, idempotencyKey: `${address.runId}:user` } }) + '\n');
  f.ctx.runId = address.runId;
  await f.runtime.prompt({ prompt: text }, f.ctx);
  await f.edit(`${prefix}/tasks.md`, tasks);
  const snapshot = await readOpenSpecPlan(f.root, changeName);
  assert.equal(selectApprovedPlanCoverage(f.state, address.runId, snapshot).reviewStatus, 'UNVERIFIED');
  mode = 'clean';
  const checked = await f.check(`${prefix}/tasks.md`);
  assert.equal(checked.result.status, 'passed');
  assert.equal(checked.result.metadata.semanticReview.originalRequirementCoverage.rows.length, 2);
  assert.equal((await readOpenSpecPlan(f.root, changeName)).revision, snapshot.revision, 'No file rewrite is needed for recovery.');
  mode = 'blocked';
  assert.equal((await f.check(`${prefix}/tasks.md`)).result.status, 'failed');
  assert.equal(selectApprovedPlanCoverage(f.state, address.runId, snapshot).reviewStatus, 'BLOCKED');
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const requiredAtoms = requirements.map(({ start, end, requirement }) => ({ requirement,
    source: { ref: 'transcript:staged-original', sha256: sha256(text), start, end } }));
  const [ok, , error] = await f.request('approve', { ...address, expectedRevision: snapshot.revision, requiredAtoms });
  assert.equal(ok, false);
  assert.match(error.message, /blocking errors/u);
  mode = 'clean';
  assert.equal((await f.check(`${prefix}/tasks.md`)).result.status, 'passed');
  assert(bindings.every(binding => documentFactory(binding) === null), 'Every actual reviewer handle must release its tool binding.');
  assert.equal(invocations, 4);
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
    payload: { text: 'The Proposal is ready for approval.' } }, f.ctx);
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const preview = await f.rpc('preview', address);
  assert.equal(preview.requireProposalCoverage, true);
  const approved = await f.rpc('approve', { ...address, expectedRevision: preview.revision, requiredAtoms });
  assert.equal(approved.requiredAtomCount, 2);
  const { hasPreparedOpenSpecProposalReview } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs')));
  assert.equal(hasPreparedOpenSpecProposalReview(f.sharedState, f.state), false, 'Approval releases the preparation slot.');
  const arm = { ...address, expectedRevision: preview.revision, expectedInventorySha256: approved.inventorySha256, applyRunId: 'apply' };
  mode = 'blocked';
  assert.equal((await f.check(`${prefix}/tasks.md`)).result.status, 'failed');
  const [armOk, , armError] = await f.request('arm', arm);
  assert.equal(armOk, false);
  assert.match(armError.message, /blocking errors/u);
  mode = 'clean';
  const recovered = await f.check(`${prefix}/tasks.md`);
  assert.equal(recovered.result.status, 'passed');
  assert.deepEqual(recovered.result.metadata.semanticReview.originalRequirementCoverage.rows.map(row => row.requirement).sort(),
    requirements.map(row => row.requirement).sort());
  assert.equal((await readOpenSpecPlan(f.root, changeName)).revision, snapshot.revision);
  const armed = await f.rpc('arm', arm);
  assert.equal(armed.status, 'ARMED');
  assert.equal(armed.inventorySha256, approved.inventorySha256);
  assert.equal(hasPreparedOpenSpecProposalReview(f.sharedState, f.state), false, 'Recovery must not prepare another inventory.');
  assert(bindings.every(binding => documentFactory(binding) === null));
  assert.equal(invocations, 6);
  assert.deepEqual(f.warnings, []);
});

test('manual original-source preparation respects a document review opt-out', async t => {
  const f = await fixture(t, { arm: false, proposalOnly: true });
  await fs.appendFile(path.join(f.root, '.runtime-corrector/config.yaml'), '\nartifactCorrection:\n  originalRequirementsEnabled: true\n');
  const checked = await f.check(`${prefix}/design.md`);
  assert.equal(checked.result.status, 'passed');
  assert.equal(checked.result.metadata.semanticReview, undefined);
  assert.deepEqual(f.calls, []);
});

test('a legacy version-one plan retains a normalized disabled v2 policy and its ordinary manual artifact review', async t => {
  const f = await fixture(t, { arm: false, proposalOnly: true, review: true, configVersion: 1 });
  const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')));
  const plan = await loadConfig({ cwd: f.root, pluginRoot });
  assert.equal(plan.runtimeV2.schemaVersion, 'runtime-corrector.runtime-plan.v2');
  assert.equal(plan.runtimeV2.configVersion, 1);
  assert.equal(plan.runtimeV2.enabled, false);
  assert.equal(plan.runtimeV2.artifactCorrection.originalRequirementsEnabled, false);
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, false);
  assert(Array.isArray(plan.runtimeV2.dynamicGroundTruth.materialRoots));
  const checked = await f.check(`${prefix}/design.md`);
  assert.equal(checked.result.status, 'passed');
  assert.equal(checked.result.metadata.semanticReview.status, 'completed');
  assert.equal(checked.result.metadata.semanticReview.originalRequirementCoverage, undefined);
  assert.deepEqual(f.calls, ['artifact-reviewer']);
  assert.deepEqual(f.warnings, []);
});

test('packaged native publication keeps a later blocking review without coverage from authorizing an older all-covered plan', async t => {
  const text = 'Retain the selected order.\nRestore the selected order after reopening.';
  const source = { ref: 'transcript:original', text };
  const identity = { ref: source.ref, sha256: sha256(text), start: 1, end: 2 };
  const requiredAtoms = ['Retain the selected order.', 'Restore the selected order after reopening.']
    .map(requirement => ({ source: identity, requirement }));
  let mode = 'clean';
  const f = await fixture(t, { arm: false, review: true, proposalOnly: true, strictSources: [source],
    reviewer: async options => {
      const findings = mode === 'clean' ? [] : [{ ruleId: 'AGENT-PLAN-CONSISTENCY', severity: 'error',
        path: `${prefix}/design.md`, message: 'The design contradicts the retained-order spec.',
        evidence: ['The current design resets the preference.'], suggestion: 'Keep the design consistent with the spec.' }];
      return { sessionId: 'artifact-review', result: { summary: 'Reviewed the exact plan.', findings, edits: [] },
        ...(mode !== 'blocked-without-rows' ? await issuedFixtureCoverage(options, requiredAtoms) : {}), async close() {} };
    } });
  await f.edit(`${prefix}/proposal.md`, f.documents[`${prefix}/proposal.md`]);
  const preview = await f.rpc('preview', f.address);
  const approve = { ...f.address, expectedRevision: preview.revision, requiredAtoms };
  const approved = await f.rpc('approve', approve);
  const arm = { ...f.address, expectedRevision: preview.revision, expectedInventorySha256: approved.inventorySha256, applyRunId: 'apply' };
  for (mode of ['blocked-with-rows', 'blocked-without-rows']) {
    await f.edit(`${prefix}/tasks.md`, tasks);
    const [ok, value, error] = await f.request('arm', arm);
    assert.equal(ok, false);
    assert.equal(value, undefined);
    assert.match(error.message, /blocking errors/u);
    const [approveOk, , approveError] = await f.request('approve', approve);
    assert.equal(approveOk, false);
    assert.match(approveError.message, /blocking errors/u);
  }
  mode = 'clean';
  await f.edit(`${prefix}/design.md`, f.documents[`${prefix}/design.md`]);
  assert.equal((await f.rpc('arm', arm)).status, 'ARMED');
  mode = 'blocked-without-rows';
  await f.edit(`${prefix}/tasks.md`, tasks);
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  f.ctx.runId = 'apply';
  await f.runtime.prompt({ prompt: 'Apply the approved plan.' }, f.ctx);
  assert.equal(f.state.nativeRunId, 'apply', 'Native execution continues after pending authority is dropped.');
  assert.equal(await inspectPlan(f.state, 'apply'), null, 'An older ARMED response cannot bypass a later blocked review.');
  assert.equal(f.calls.length, 5, 'each outcome must come from an actual artifact review');
  assert.deepEqual(f.warnings, []);
});

test('a packaged explicit current subset check blocks strict arm and needs a clean full-plan re-review', async t => {
  const text = 'Retain the selected order.\nRestore the selected order after reopening.';
  const source = { ref: 'transcript:original', text };
  const identity = { ref: source.ref, sha256: sha256(text), start: 1, end: 2 };
  const requiredAtoms = ['Retain the selected order.', 'Restore the selected order after reopening.']
    .map(requirement => ({ source: identity, requirement }));
  let mode = 'clean';
  const f = await fixture(t, { arm: false, review: true, proposalOnly: true, partialManualCheck: true, strictSources: [source],
    reviewer: async options => {
      return { sessionId: 'artifact-review', result: { summary: 'Reviewed the current declared scope.', edits: [],
        findings: mode === 'blocked' ? [{ ruleId: 'AGENT-PLAN-CONSISTENCY', severity: 'error',
          path: `${prefix}/design.md`, message: 'The current design contradicts the retained-order spec.',
          evidence: ['The design resets the retained preference.'], suggestion: 'Preserve the retained order consistently.' }] : [] },
        ...(mode === 'clean' ? await issuedFixtureCoverage(options, requiredAtoms) : {}), async close() {} };
    } });
  await f.edit(`${prefix}/proposal.md`, f.documents[`${prefix}/proposal.md`]);
  const preview = await f.rpc('preview', f.address);
  const approve = { ...f.address, expectedRevision: preview.revision, requiredAtoms };
  const approved = await f.rpc('approve', approve);
  const arm = { ...f.address, expectedRevision: preview.revision, expectedInventorySha256: approved.inventorySha256, applyRunId: 'apply' };
  mode = 'blocked';
  const checked = await f.check(`${prefix}/design.md`);
  assert.equal(checked.result.status, 'failed');
  assert.equal(checked.result.metadata.semanticReview.status, 'completed');
  assert.deepEqual(checked.result.metadata.inputs.map(file => file.path), [`${prefix}/design.md`]);
  let [ok, , error] = await f.request('arm', arm);
  assert.equal(ok, false);
  assert.match(error.message, /blocking errors/u);
  mode = 'clean';
  await f.check(`${prefix}/design.md`);
  [ok, , error] = await f.request('arm', arm);
  assert.equal(ok, false, 'a partial check cannot clear the known cross-document error');
  assert.match(error.message, /blocking errors/u);
  await f.edit(`${prefix}/proposal.md`, f.documents[`${prefix}/proposal.md`]);
  assert.equal((await f.rpc('arm', arm)).status, 'ARMED');
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.warnings, []);
});

test('armed Apply drift adds one bounded notice and keeps mutation evidence without semantic re-review', async t => {
  const f = await fixture(t);
  const relative = `${prefix}/design.md`;
  const { event, outcome, toolCallId } = await f.edit(relative, '# Design\n\nSelect a different default.\n');
  assert(outcome?.result);
  assert.deepEqual(outcome.result.content.slice(0, -1), event.result.content);
  assert.match(outcome.result.content.at(-1).text, /Apply changed the approved OpenSpec plan/u);
  assert.equal(outcome.result.content.at(-1).text.match(/Apply changed/gu)?.length, 1);
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT'));
  assert(rows.some(row => row.type === 'OPENCLAW_FILE_CHANGED'));
  const [skipped] = rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED');
  assert.equal(skipped.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.equal(skipped.runId, 'apply');
  assert.equal(skipped.openSpecPlan.status, 'CHANGED');
  assert.deepEqual(skipped.openSpecPlan.differences, [relative]);
  assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW'));
  assert.deepEqual(f.warnings, []);
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
    payload: { text: 'Apply completed.' } }, f.ctx);
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const reviewRoot = path.join(f.root, '.runtime-correction/openclaw/native-stop-reviews');
  const directories = await fs.readdir(reviewRoot, { withFileTypes: true });
  const records = (await Promise.all(directories.filter(entry => entry.isDirectory()).map(async directory => {
    const folder = path.join(reviewRoot, directory.name);
    const files = await fs.readdir(folder);
    return Promise.all(files.filter(file => file.endsWith('.json')).map(file => fs.readFile(path.join(folder, file), 'utf8').then(JSON.parse)));
  }))).flat();
  const stop = records.find(record => record.runId === 'apply');
  assert.equal(stop?.status, 'SETTLED');
  assert.equal(stop?.reviewStatus, 'DEVIATION');
  assert.equal(stop?.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.deepEqual(stop?.openSpecPlan.differences, [relative]);
});

test('a mixed write batch skips only the changed plan document and still checks genuine checkbox progress', async t => {
  const f = await fixture(t);
  const relative = `${prefix}/design.md`, checklist = `${prefix}/tasks.md`;
  const input = `*** Begin Patch\n*** Update File: ${relative}\n@@\n-Restore selected order on start.\n+Select a new default.\n*** Update File: ${checklist}\n@@\n-- [ ] Retain the selected order.\n+- [x] Retain the selected order.\n*** End Patch`;
  const { outcome, toolCallId } = await f.edit(relative, '# Design\n\nSelect a new default.\n', {
    toolName: 'apply_patch', args: { input },
    beforeResult: () => fs.writeFile(path.join(f.root, checklist), tasks.replace('[ ]', '[x]')),
  });
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert.deepEqual(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED').map(row => row.file), [path.join(f.root, relative)]);
  assert.deepEqual(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW').map(row => row.file), [path.join(f.root, checklist)]);
  assert.equal(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT').length, 2);
  assert.equal(rows.filter(row => row.type === 'OPENCLAW_FILE_CHANGED').length, 2);
  assert.equal(outcome.result.content.at(-1).text.match(/Apply changed/gu)?.length, 1);
});

test('an error receipt is ineligible for the early drift optimization', async t => {
  const f = await fixture(t);
  const { outcome, toolCallId } = await f.edit(`${prefix}/design.md`, '# Partial failing write\n', { result: { isError: true } });
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
  assert(!outcome?.result?.content.some(block => block.text?.includes('Apply changed the approved OpenSpec plan')));
});

test('a native run replaced during plan capture receives no drift feedback or skip evidence', async t => {
  const f = await fixture(t);
  const lstat = fs.lstat;
  let replaced = false;
  const { outcome, toolCallId } = await f.edit(`${prefix}/design.md`, '# Changed design\n', { beforeResult() {
    t.mock.method(fs, 'lstat', async (...args) => {
      if (!replaced && args[0] === path.join(f.root, prefix, 'proposal.md')) {
        replaced = true;
        f.state.nativeRunId = 'a-new-native-run';
        f.state.reviewController.abort(new Error('The host replaced this run.'));
        f.state.reviewController = new AbortController();
      }
      return lstat(...args);
    });
  } });
  assert(replaced, 'The replacement must occur during approved plan inspection.');
  assert.equal(outcome, undefined);
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT'));
  assert(!rows.some(row => ['OPENCLAW_ARTIFACT_REVIEW_SKIPPED', 'OPENCLAW_FEEDBACK_DELIVERED'].includes(row.type)));
});

test('ordinary checkbox updates, unarmed changes, and unavailable plan evidence retain artifact processing', async t => {
  for (const kind of ['checkbox', 'unarmed', 'unavailable']) await t.test(kind, async t => {
    const f = await fixture(t, { arm: kind !== 'unarmed' });
    const relative = kind === 'checkbox' ? `${prefix}/tasks.md` : `${prefix}/design.md`;
    if (kind === 'unavailable') await fs.rm(path.join(f.root, prefix, 'proposal.md'));
    const { outcome, toolCallId } = await f.edit(relative, kind === 'checkbox' ? tasks.replace('[ ]', '[x]') : '# Changed design\n');
    const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
    assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
    assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW'));
    assert(!outcome?.result?.content.some(block => block.text?.includes('Apply changed the approved OpenSpec plan')));
  });
});

test('shadow drift records the unchanged guard evidence without delivering feedback', async t => {
  const f = await fixture(t, { shadow: true });
  const { outcome, toolCallId } = await f.edit(`${prefix}/design.md`, '# Changed design\n');
  assert.equal(outcome, undefined);
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
  assert(!rows.some(row => row.type === 'OPENCLAW_FEEDBACK_DELIVERED'));
});

test('an explicit native check retains armed drift without a semantic call or clearing final Stop', async t => {
  const f = await fixture(t, { review: true });
  const relative = `${prefix}/design.md`;
  await fs.writeFile(path.join(f.root, relative), '# Design\n\nSelect a different default.\n');
  const checked = await f.check(relative);
  assert.equal(checked.result.status, 'failed');
  assert.equal(checked.result.classification, 'DEVIATION');
  assert.equal(checked.result.metadata.openSpecPlan.status, 'CHANGED');
  assert.deepEqual(checked.result.metadata.openSpecPlan.differences, [relative]);
  assert.equal(checked.result.metadata.semanticReview.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.match(checked.feedback, /Apply changed the approved OpenSpec plan/u);
  assert.deepEqual(f.calls, []);
  assert.equal((await inspectPlan(f.state, 'apply')).status, 'CHANGED');
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.equal(task.verification.status, 'STALE');
  const [skipped] = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED');
  assert.equal(skipped.source, 'manual-check');
  assert.equal(skipped.runId, 'apply');
  assert.equal(skipped.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  await f.runtime.reply({ kind: 'final', runId: 'apply', sessionKey: f.ctx.sessionKey,
    payload: { text: 'Apply completed.' } }, f.ctx);
  await f.runtime.agentEnd({ runId: 'apply', success: true }, f.ctx);
  const records = await f.runtime.waitForNativeReviews({ drain: true });
  const stop = records.find(record => record.runId === 'apply');
  assert.equal(stop?.reviewStatus, 'DEVIATION');
  assert.equal(stop?.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('explicit unchanged, checkbox-only, unarmed, unrelated, and unreadable-plan checks retain semantic processing', async t => {
  for (const kind of ['unchanged', 'checkbox', 'unarmed', 'unrelated', 'unavailable']) await t.test(kind, async t => {
    const f = await fixture(t, { review: true, arm: kind !== 'unarmed' });
    let relative = `${prefix}/design.md`;
    if (kind === 'checkbox') {
      relative = `${prefix}/tasks.md`;
      await fs.writeFile(path.join(f.root, relative), tasks.replace('[ ]', '[x]'));
    }
    if (kind === 'unarmed' || kind === 'unrelated')
      await fs.writeFile(path.join(f.root, relative), '# Design\n\nSelect a new default.\n');
    if (kind === 'unrelated') {
      relative = 'openspec/changes/retain-search-term/design.md';
      await fs.mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
      await fs.writeFile(path.join(f.root, relative), '# Design\n\nRetain the search term.\n');
    }
    if (kind === 'unavailable') await fs.rm(path.join(f.root, prefix, 'proposal.md'));
    const checked = await f.check(relative);
    assert.equal(checked.result.status, 'passed');
    assert.deepEqual(f.calls, ['artifact-reviewer']);
    assert.equal(checked.result.metadata.semanticReview.status, 'completed');
    assert(!checked.result.diagnostics.some(row => row.ruleId === 'OPENSPEC_APPLY_PLAN_CHANGED'));
    assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
    if (kind === 'unrelated') assert.equal((await inspectPlan(f.state, 'apply')).status, 'CHANGED');
    if (kind === 'checkbox') assert.equal((await inspectPlan(f.state, 'apply')).status, 'PRESERVED');
  });
});

test('shadow explicit checks report confirmed plan drift without a semantic PASS or model call', async t => {
  const f = await fixture(t, { review: true, shadow: true });
  await fs.writeFile(path.join(f.root, prefix, 'tasks.md'), tasks + '\nA later instruction.\n');
  const checked = await f.check(`${prefix}/tasks.md`);
  assert.equal(checked.result.status, 'failed');
  assert.equal(checked.result.classification, 'DEVIATION');
  assert.equal(checked.result.metadata.openSpecPlan.status, 'CHANGED');
  assert.deepEqual(f.calls, []);
  assert.equal((await inspectPlan(f.state, 'apply')).status, 'CHANGED');
  assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_FEEDBACK_DELIVERED'));
});

test('explicit normal checks preserve unavailable-review diagnostics', async t => {
  const f = await fixture(t, { review: true, reviewerFailure: true });
  const checked = await f.check(`${prefix}/design.md`);
  assert.equal(checked.result.status, 'failed');
  assert(checked.result.diagnostics.some(row => row.ruleId === 'AGENT-SEMANTIC-REVIEW-FAILED'));
  assert(!checked.result.diagnostics.some(row => row.ruleId === 'OPENSPEC_APPLY_PLAN_CHANGED'));
  assert.deepEqual(f.calls, ['artifact-reviewer']);
});

test('an explicit check replaced during plan capture cannot publish old drift evidence', async t => {
  const f = await fixture(t, { review: true });
  await fs.writeFile(path.join(f.root, prefix, 'design.md'), '# Changed design\n');
  const lstat = fs.lstat;
  let replaced = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (!replaced && args[0] === path.join(f.root, prefix, 'proposal.md')) {
      replaced = true;
      f.state.nativeRunId = 'another-native-run';
      f.state.reviewController.abort(new Error('The host replaced this run.'));
      f.state.reviewController = new AbortController();
    }
    return lstat(...args);
  });
  await assert.rejects(f.check(`${prefix}/design.md`), /RC_CHECK_(?:INVOCATION_UNAVAILABLE|CANCELLED)/u);
  assert(replaced);
  assert.deepEqual(f.calls, []);
  assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
});

test('an explicit check whose project scope changes during capture cannot publish drift evidence', async t => {
  const f = await fixture(t, { review: true });
  await fs.writeFile(path.join(f.root, prefix, 'design.md'), '# Changed design\n');
  const lstat = fs.lstat, resolve = f.projectScopes.resolve;
  let changed = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (!changed && args[0] === path.join(f.root, prefix, 'proposal.md')) {
      changed = true;
      f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args), fingerprint: 'a-new-project-scope' });
    }
    return lstat(...args);
  });
  await assert.rejects(f.check(`${prefix}/design.md`), /RC_CHECK_(?:INVOCATION_UNAVAILABLE|CANCELLED|SCOPE_OR_EVIDENCE_UNAVAILABLE)/u);
  assert(changed);
  assert.deepEqual(f.calls, []);
  assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
});
