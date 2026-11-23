import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { parseSimpleYaml } from '../lib/simple-yaml.mjs';
import { emitSimpleYaml } from '../scripts/bench/rc-config-overrides.mjs';

let buildRoot, pluginRoot, createRuntime, ensureTask, taskDirectory, registerPlanControl, createDocumentTools, loadConfig;
before(async () => {
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-bundle-build-')));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: fileURLToPath(new URL('../', import.meta.url)), outputRoot: buildRoot });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ ensureTask, taskDirectory } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
  ({ registerOpenSpecPlanControl: registerPlanControl } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs'))));
  ({ createDocumentTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/document-tools.mjs'))));
  ({ loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs'))));
});
after(() => fs.rm(buildRoot, { recursive: true, force: true }));

async function fixture(t, { artifacts, documents, reviewer, extraConfig = '', supportFiles = {}, policy = null } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-document-bundle-')));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const configFile = path.join(root, '.runtime-corrector/config.yaml');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, policy ?? `version: 2
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
    for (const [file, body] of Object.entries(changes)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), body);
    }
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

const packagedDefault = name => path.join(pluginRoot, '.runtime-corrector-default', name);
const topologyKeys = ['enabledStages', 'artifacts', 'workflow'];
const withoutTopology = value => Object.fromEntries(Object.entries(value).filter(([key]) => !topologyKeys.includes(key)));
async function readTopology() {
  const overlay = parseSimpleYaml(await fs.readFile(packagedDefault('openspec-full-plan.topology.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(overlay).sort(), [...topologyKeys].sort());
  return overlay;
}
function mergeTopology(active, overlay) {
  const merged = { ...structuredClone(active), ...structuredClone(overlay) };
  assert.deepEqual(withoutTopology(merged), withoutTopology(active));
  return merged;
}
const obligations = [{ start: 1, end: 1, requirement: 'Retain local preferences.' },
  { start: 2, end: 2, requirement: 'Restore saved preferences after reopening.' }];
const originalText = obligations.map(row => row.requirement).join('\n');

async function profileFixture(t, mode, { documents = {}, mutateAfterRead, readinessStatus = 'READY' } = {}) {
  const baseline = parseSimpleYaml(await fs.readFile(packagedDefault('config.yaml'), 'utf8'));
  const overlay = await readTopology();
  const config = mode === 'baseline' ? structuredClone(baseline) : mergeTopology(baseline, overlay);
  // Same document-only control policy in both arms. The candidate profile
  // itself changes only nodes/workflow/rules, retaining all release flags.
  config.enabled = true; config.sessionDefaults.enabled = true;
  config.dynamicGroundTruth.enabled = false;
  config.artifactCorrection = { originalRequirementsEnabled: true, groundTruthReviewEnabled: false,
    stageMetricsEnabled: false, requireOpenSpecProposalCoverage: true, requireOpenSpecPlanReadiness: true };
  config.stopCorrection.enabled = false;
  config.skillCorrection.enabled = false; config.implementationCorrection.enabled = false;
  const activePolicy = structuredClone(config);
  if (mode !== 'baseline') Object.assign(config, mergeTopology(activePolicy, overlay));
  assert.deepEqual(withoutTopology(config), withoutTopology(activePolicy));
  assert.equal(config.artifactCorrection.requireOpenSpecProposalCoverage, true);
  assert.equal(config.artifactCorrection.requireOpenSpecPlanReadiness, true);
  const supportFiles = { '.runtime-corrector/example.reviewer.md': await fs.readFile(packagedDefault('example.reviewer.md'), 'utf8'),
    '.runtime-corrector/openspec-plan.rules.yaml': await fs.readFile(packagedDefault('openspec-plan.rules.yaml'), 'utf8') };
  const issued = [];
  const f = await fixture(t, { documents, policy: emitSimpleYaml(config), supportFiles,
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
        requestPath: options.request.semanticReviewRequestPath, originalDutyCohortContext: cohort, requiredProposalReview: options.evidence.requiredProposalReview,
        requiredPlanReadiness: options.evidence.requiredPlanReadiness });
      for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
      let coverage, readiness, requests;
      if (tools.requiredProposalCount) {
        const required = await tools.execute({ action: 'required_proposal' });
        assert.equal(required.total, 2);
        const rows = [];
        for (const item of required.items) {
          const { anchor } = await tools.execute(item.readOriginal);
          const row = obligations.find(row => row.requirement === item.requirement);
          assert(row);
          rows.push({ originalSourceAnchorId: anchor.anchorId, requirement: item.requirement, disposition: 'COVERED',
            reason: 'The current spec defines the required behavior.',
            targets: [{ path: `${prefix}/specs/preferences/spec.md`, start: row.start + 2, end: row.end + 2 }] });
        }
        coverage = await tools.verifyRequirementCoverage(rows);
        const inventory = await tools.execute({ action: 'plan_checklist' });
        readiness = await tools.verifyPlanReadiness({ inventorySha256: inventory.inventorySha256, status: readinessStatus,
          rows: inventory.items.map(task => ({ taskId: task.id, status: readinessStatus, reason: 'The current plan defines this work.',
            targets: [{ path: task.path, start: task.line, end: task.line }] })) });
        requests = options.evidence.requiredProposalReview.requiredAtoms.map(({ source, requirement }) => {
          const span = obligations.find(row => row.requirement === requirement);
          return { source: { ref: source.ref, sha256: source.sha256, start: span.start, end: span.end }, requirement };
        });
      }
      await mutateAfterRead?.(options);
      await tools.verify();
      issued.push({ coverage, readiness, requests });
      return { sessionId: `profile-worker-${issued.length}`, ...(coverage ? { originalRequirementCoverage: coverage } : {}),
        ...(readiness ? { planReadiness: readiness } : {}),
        result: { summary: 'Reviewed only the actual current declared plan scope.', findings: [], edits: [] }, async close() {} };
    } });
  f.api.runtime.agent.resolveAgentWorkspaceDir = () => f.root;
  const resolve = f.projectScopes.resolve;
  f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args), plan: await loadConfig({ cwd: f.root, pluginRoot }) });
  registerPlanControl(f.api, f.runtime);
  await settle(f);
  const address = { sessionId: f.ctx.sessionId, sessionKey: f.ctx.sessionKey, runId: 'profile-proposal', changeName };
  await planOk(f, 'prepare', { ...address, sourceRunId: address.runId, sourceSha256: sha256(originalText),
    requirePlanReadiness: true, requirements: obligations });
  await fs.appendFile(f.transcript, '\n' + JSON.stringify({ type: 'message', id: 'profile-original', parentId: 'original',
    message: { role: 'user', content: originalText, idempotencyKey: `${address.runId}:user` } }) + '\n');
  f.ctx.runId = address.runId;
  await f.runtime.prompt({ prompt: originalText }, f.ctx);
  const check = async file => {
    const toolCallId = `manual-${f.calls.length}`;
    await f.runtime.beforeTool({ toolName: 'runtime_corrector', toolCallId, params: { command: 'check', subject: file } }, f.ctx);
    const { runId, abortSignal, ...context } = f.ctx;
    return f.runtime.manualCheck(context, file, { toolCallId, signal: abortSignal });
  };
  return { ...f, issued, address, check };
}

for (const mode of ['baseline', 'whole-plan']) test(`profile ${mode}: separate draft writes and later member edits use the configured scope`, async t => {
  const f = await profileFixture(t, mode);
  const edits = [
    [`${prefix}/proposal.md`, planDocuments[`${prefix}/proposal.md`]],
    [`${prefix}/specs/preferences/spec.md`, planDocuments[`${prefix}/specs/preferences/spec.md`]],
    [`${prefix}/design.md`, '# Design\nUse local preference storage.\n'],
    [`${prefix}/design.md`, '# Design\nUse persistent local preference storage.\n'],
    [`${prefix}/design.md`, '# Design\nRestore persistent preferences on startup.\n'],
    [`${prefix}/tasks.md`, planDocuments[`${prefix}/tasks.md`]],
    [`${prefix}/specs/preferences/spec.md`, planDocuments[`${prefix}/specs/preferences/spec.md`] + '\nPreserve the same local storage contract.\n'],
  ];
  const counts = [];
  for (const [file, body] of edits) {
    await f.write({ [file]: body }); counts.push(f.calls.length);
  }
  assert.deepEqual(counts, mode === 'baseline' ? [1, 2, 3, 4, 5, 6, 7] : [0, 0, 0, 0, 0, 1, 2]);
  const rows = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW');
  assert.equal(rows.length, 7, 'Every changed file retains its mechanical/finalized association.');
  assert.equal((await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT').length, 7);
  if (mode === 'whole-plan') {
    assert(rows.slice(0, 5).every(row => row.result.status === 'pending'
      && row.result.metadata.semanticReview.reasonCode === 'ARTIFACT_BUNDLE_INCOMPLETE'));
    assert(rows.slice(5).every(row => row.result.status === 'passed' && row.result.metadata.inputs.length === 4));
    assert(f.calls.every(call => call.evidence.requiredProposalReview.requiredAtoms.length === 2 && call.evidence.requiredPlanReadiness));
    assert(f.issued.every(item => item.coverage.scope.length === 4 && item.coverage.rows.length === 2 && item.readiness.status === 'READY'));
  }
  await settle(f);
  const current = await planOk(f, 'preview', f.address);
  const requiredAtoms = f.issued.find(item => item.requests)?.requests;
  assert.equal(requiredAtoms.length, 2);
  const approval = await planRpc(f, 'approve', { ...f.address, expectedRevision: current.revision, requiredAtoms });
  if (mode === 'whole-plan') assert.equal(approval[0], true, approval[2]?.message);
  else {
    assert.equal(approval[0], false, 'The partial last spec review cannot certify the changed whole plan.');
    await f.check(`${prefix}/tasks.md`);
    assert.equal(f.calls.length, 8);
    assert.equal((await planOk(f, 'approve', { ...f.address, expectedRevision: current.revision, requiredAtoms })).planReadiness.status, 'READY');
  }
  assert.deepEqual(f.warnings, []);
});

test('profile partial manual check remains pending and cannot approve an unfinished plan', async t => {
  const f = await profileFixture(t, 'whole-plan');
  await f.write({ [`${prefix}/proposal.md`]: planDocuments[`${prefix}/proposal.md`] });
  const check = await f.check(`${prefix}/proposal.md`);
  assert.equal(check.result.status, 'pending');
  assert.equal(check.result.metadata.semanticReview.reasonCode, 'ARTIFACT_BUNDLE_INCOMPLETE');
  assert.equal(f.calls.length, 0);
  await settle(f);
  const rejected = await planRpc(f, 'approve', { ...f.address, expectedRevision: '0'.repeat(64), requiredAtoms: [] });
  assert.equal(rejected[0], false);
});

test('profile another change cannot supply a missing required member', async t => {
  const other = Object.fromEntries(Object.entries(planDocuments).map(([name, body]) => [name.replace(changeName, 'other-preferences'), body]));
  const f = await profileFixture(t, 'whole-plan', { documents: { ...other,
    [`${prefix}/proposal.md`]: planDocuments[`${prefix}/proposal.md`], [`${prefix}/tasks.md`]: planDocuments[`${prefix}/tasks.md`] } });
  await f.write({ [`${prefix}/design.md`]: planDocuments[`${prefix}/design.md`] });
  assert.equal(f.calls.length, 0);
  const rows = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result.status, 'pending');
  assert(rows[0].result.metadata.artifactFiles.every(file => file.startsWith(`${prefix}/`)));
  assert(rows[0].result.diagnostics.some(item => item.ruleId === 'OPENSPEC-PLANNING-MEMBERS' && item.severity === 'pending'));
});

test('profile multiple capabilities share one change-bound full plan rather than separate capability instances', async t => {
  const second = `${prefix}/specs/appearance/spec.md`;
  const f = await profileFixture(t, 'whole-plan', { documents: { ...planDocuments, [second]: '# Appearance\nKeep the saved local appearance.\n' } });
  await f.write({ [second]: '# Appearance\nKeep the saved local appearance after reopening.\n' });
  assert.equal(f.calls.length, 1);
  const files = f.calls[0].evidence.semanticRequest.artifactFiles;
  assert.equal(files.length, 5);
  assert(files.includes(second) && files.includes(`${prefix}/specs/preferences/spec.md`));
  assert.deepEqual(f.calls[0].evidence.semanticRequest.workflow.instance, { changeName });
  assert.equal(f.issued[0].coverage.scope.length, 5);
});

test('profile unchanged strict authority rejects a document mutation after fresh reads', async t => {
  const f = await profileFixture(t, 'whole-plan', { documents: planDocuments,
    mutateAfterRead: async options => fs.appendFile(path.join(options.projectRoot, `${prefix}/design.md`), '\nChanged after the worker read.\n') });
  const result = await f.write({ [`${prefix}/tasks.md`]: '# Tasks\n- [ ] Retain local preferences across restarts.\n' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.issued.length, 0);
  assert.match(JSON.stringify(result), /DOCUMENT_EVIDENCE_CHANGED/u);
  await settle(f);
  const snapshot = await planOk(f, 'preview', f.address);
  const requests = f.calls[0].evidence.requiredProposalReview.requiredAtoms.map(({ source, requirement }) => {
    const row = obligations.find(row => row.requirement === requirement);
    return { source: { ref: source.ref, sha256: source.sha256, start: row.start, end: row.end }, requirement };
  });
  assert.equal((await planRpc(f, 'approve', { ...f.address, expectedRevision: snapshot.revision, requiredAtoms: requests }))[0], false);
});

test('profile complete filenames and covered original atoms cannot replace READY task evidence', async t => {
  const f = await profileFixture(t, 'whole-plan', { documents: planDocuments, readinessStatus: 'UNVERIFIED' });
  await f.write({ [`${prefix}/design.md`]: '# Design\nRestore preferences using the current local store.\n' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.issued[0].coverage.rows.length, 2);
  const row = (await f.journal()).find(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW');
  assert.equal(row.result.status, 'pending');
  assert.equal(row.result.metadata.semanticReview.planReadiness.status, 'UNVERIFIED');
  assert(row.result.diagnostics.some(item => item.ruleId === 'PLAN_READINESS_UNVERIFIED'));
  await settle(f);
  const snapshot = await planOk(f, 'preview', f.address);
  const rejected = await planRpc(f, 'approve', { ...f.address, expectedRevision: snapshot.revision, requiredAtoms: f.issued[0].requests });
  assert.equal(rejected[0], false);
  assert.match(rejected[2].message, /not READY/u);
});

test('profile immediate approved Apply drift runs before document semantic review', async t => {
  const f = await profileFixture(t, 'whole-plan', { documents: planDocuments });
  await f.write({ [`${prefix}/design.md`]: '# Design\nRestore local preferences across restarts.\n' });
  await settle(f);
  const snapshot = await planOk(f, 'preview', f.address);
  const approved = await planOk(f, 'approve', { ...f.address, expectedRevision: snapshot.revision, requiredAtoms: f.issued[0].requests });
  await planOk(f, 'arm', { ...f.address, expectedRevision: snapshot.revision,
    expectedInventorySha256: approved.inventorySha256, applyRunId: 'profile-apply' });
  const before = f.calls.length;
  f.ctx.runId = 'profile-apply';
  await f.runtime.prompt({ prompt: 'Apply the approved preference plan.' }, f.ctx);
  const { toolCallId, result } = await f.write({ [`${prefix}/design.md`]: '# Design\nAn unapproved plan revision.\n' });
  assert.equal(f.calls.length, before);
  assert.match(JSON.stringify(result), /Apply changed the approved OpenSpec plan/u);
  const row = (await f.journal()).find(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED' && row.toolCallId === toolCallId);
  assert.equal(row.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
});

test('packaged topology overlay changes exactly three active keys while preserving policy and model', async () => {
  const original = parseSimpleYaml(await fs.readFile(packagedDefault('config.yaml'), 'utf8'));
  const overlay = await readTopology();
  const active = structuredClone(original);
  active.enabled = true; active.sessionDefaults.enabled = true;
  active.artifactCorrection.requireOpenSpecProposalCoverage = true;
  active.artifactCorrection.requireOpenSpecPlanReadiness = true;
  active.stopCorrection.originalRequirementsBasis = true;
  active.stopCorrection.requireCurrentProductionCoverage = true;
  active.stopCorrection.requireProductionOriginCoverage = true;
  active.reviewers.defaults = { ...active.reviewers.defaults, model: 'fixture/current-review-model', effort: 'high', timeoutMs: 123456 };
  for (const baseline of [original, active, { ...active, enabled: false, locale: 'en' }]) {
    const before = structuredClone(baseline);
    const merged = mergeTopology(baseline, overlay);
    assert.deepEqual(baseline, before, 'The active source configuration is not mutated.');
    assert.deepEqual(withoutTopology(merged), withoutTopology(before));
    assert.deepEqual(merged.artifacts, overlay.artifacts);
    assert.deepEqual(merged.workflow, overlay.workflow);
    assert.deepEqual(merged.enabledStages, overlay.enabledStages);
    assert.deepEqual(merged.reviewers, before.reviewers);
    assert.deepEqual(merged.stopCorrection, before.stopCorrection);
    assert.deepEqual(merged.artifactCorrection, before.artifactCorrection);
    assert.deepEqual(merged.sessionDefaults, before.sessionDefaults);
  }
  assert.equal(original.artifacts.length, 4);
  assert.equal(original.workflow.edges.length, 5);
  assert.equal(overlay.artifacts.length, 1);
  assert.deepEqual(overlay.workflow.correlation.keys, ['changeName']);
  assert.deepEqual(overlay.workflow.edges, []);
  assert.equal(overlay.artifacts[0].review.deferUntilBundleComplete, true);
  for (const name of ['config.yaml', 'openspec-full-plan.topology.yaml', 'openspec-plan.rules.yaml']) {
    assert.equal(await fs.readFile(packagedDefault(name), 'utf8'),
      await fs.readFile(new URL(`../.runtime-corrector-default/${name}`, import.meta.url), 'utf8'));
  }
});

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
