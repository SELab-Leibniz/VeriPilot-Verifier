import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './openclaw-project-scope.mjs';
import { sha256 } from '../../lib/runtime-v2/utils.mjs';
import { readOpenSpecPlan } from '../../lib/openspec-plan.mjs';
import { runtimeFailureDiagnostics } from '../helpers/runtime-failure-diagnostics.mjs';

const changeName = 'preserve-display-order';
const prefix = `openspec/changes/${changeName}`;
const tasks = '# Tasks\n\n- [ ] Retain the selected order.\n';
let output, pluginRoot, createRuntime, registerPlanControl, inspectPlan, findTask, ensureTask;
before(async () => {
  output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-drift-build-')));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ registerOpenSpecPlanControl: registerPlanControl, inspectArmedOpenSpecApply: inspectPlan } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs'))));
  ({ findTask, ensureTask } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
});
after(() => output && fs.rm(output, { recursive: true, force: true }));

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
  proposalOnly = false, reviewer, strictSources, partialManualCheck = false, fullPlanReview = false, configVersion = 2,
  skipProgress = true, extraConfig = '', forbidProgress = false, stageMetrics = false,
  dynamicGroundTruth = false, groundTruthReview = false } = {}) {
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
      enabled: ${forbidProgress}
${forbidProgress ? '      file: progress.rules.yaml\n' : ''}    review:
      enabled: ${review}
${skipProgress === null ? '' : `      skipApprovedTaskProgress: ${skipProgress}\n`}
      criteria: review.md
${configVersion === 2 ? `dynamicGroundTruth:
  enabled: ${dynamicGroundTruth}
stopCorrection:
  enabled: false
` : ''}artifactCorrection:
  originalRequirementsEnabled: true
  requireOpenSpecProposalCoverage: true
  groundTruthReviewEnabled: ${groundTruthReview}
  stageMetricsEnabled: ${stageMetrics}
${extraConfig}
shadowMode: ${shadow}
`);
  await fs.writeFile(path.join(root, '.runtime-corrector/review.md'), 'Review the complete plan against the original request.\n');
  if (forbidProgress) await fs.writeFile(path.join(root, '.runtime-corrector/progress.rules.yaml'),
    'version: 1\nrules:\n  - id: REQUIRE-INDEPENDENT-COMPLETION-CHECK\n    type: forbid-text\n    values: ["[x]"]\n    severity: error\n');
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
    if (!ok) t.diagnostic(JSON.stringify({ phase: 'PLAN_CONTROL_RPC',
      action: ['preview', 'approve', 'arm'].includes(action) ? action : 'OTHER',
      errorCode: /^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code ?? '') ? error.code : undefined,
      diagnostics: await runtimeFailureDiagnostics({ root, calls: calls.map(role => ({ role })), warnings }) }));
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
  async function edit(relative, contents, { result = {}, toolName = 'write', args, beforeResult, eventRunId } = {}) {
    const toolCallId = `native-change-${++nextId}`;
    args ??= { path: path.join(root, relative), content: contents };
    await runtime.beforeTool({ toolName, toolCallId, params: args }, ctx);
    if (contents !== null) await fs.writeFile(path.join(root, relative), contents);
    await beforeResult?.();
    const event = { toolName, toolCallId, args, ...(eventRunId ? {runId:eventRunId} : {}), result: {
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

async function approvedFixture(t, options = {}) {
  const text = 'Retain the selected display order.', source = { ref: 'transcript:original', text };
  const identity = { ref: source.ref, sha256: sha256(text), start: 1, end: 1 };
  const requiredAtoms = [{ source: identity, requirement: text }];let reviewMode = 'clean';
  const f = await fixture(t, { arm: false, proposalOnly: true, review: true, fullPlanReview: true,
    strictSources: [source], ...options,
    reviewer: async args => {
      const findings = reviewMode === 'blocked' ? [{ ruleId:'AGENT-PLAN-CONFLICT',severity:'error',path:`${prefix}/design.md`,
        message:'The plan requires a conflicting default.',evidence:['The current review cannot accept this plan.'],suggestion:'Resolve the conflict.' }] : [];
      if(reviewMode==='unavailable')throw new Error('The independent reviewer is unavailable.');
      return { sessionId: 'prior-clean-plan', result: { summary: 'Reviewed the current complete plan.', findings, edits: [] },
        // Other fake roles keep their prior result contract. In particular,
        // an invalid Ground Truth result is not document coverage or a verified baseline.
        ...(args.role === 'artifact-reviewer' ? await issuedFixtureCoverage(args, requiredAtoms) : {}), async close() {} };
    } });
  await f.edit(`${prefix}/proposal.md`, f.documents[`${prefix}/proposal.md`] + 'Preserve the documented public behavior.\n');
  const { selectApprovedPlanCoverage } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/approved-plan-coverage.mjs')));
  f.priorCoverage = selectApprovedPlanCoverage(f.state, 'proposal', await readOpenSpecPlan(f.root, changeName));
  const preview = await f.rpc('preview', f.address);
  const approved = await f.rpc('approve', { ...f.address, expectedRevision: preview.revision, requiredAtoms });
  if (!options.unarmed) await f.rpc('arm', { ...f.address, expectedRevision: preview.revision, expectedInventorySha256: approved.inventorySha256, applyRunId: 'apply' });
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  await fs.appendFile(f.transcript, '\n'+JSON.stringify({type:'message',id:'apply-user',parentId:'original',message:{role:'user',content:'Apply the approved plan.',idempotencyKey:'apply:user'}})+'\n');
  f.ctx.runId = 'apply'; await f.runtime.prompt({ prompt: 'Apply the approved plan.' }, f.ctx);
  if (!options.unarmed) assert.equal((await inspectPlan(f.state, 'apply')).status, 'PRESERVED');
  f.setReviewMode = value => {reviewMode=value;};
  return f;
}

export { changeName, prefix, tasks, approvedFixture };
