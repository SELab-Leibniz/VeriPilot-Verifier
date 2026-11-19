import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { publishProposalCoverage } from './support/proposal-coverage.mjs';
import { createNativeStopFixture } from './support/openclaw-native-stop-fixture.mjs';

const { lifecycle, findTask } = createNativeStopFixture();

for (const variant of ['ordinary', 'strict', 'source-change', 'policy-change']) test({
  ordinary: 'native plan restoration still reviews a real business defect under the ordinary semantic reviewer',
  strict: 'native restoration retains strict inventory and cannot pass an unsupported semantic reviewer',
  'source-change': 'a queued restoration rejects changed business source before any native start',
  'policy-change': 'a queued restoration rejects changed policy bytes before any native start',
}[variant], async t => {
  const strict = variant !== 'ordinary';
  const queued = [];
  const f = await lifecycle(t, { waitMode: 'until_pass', review: async () =>
    (await fs.readFile(path.join(f.root, 'draft.md'), 'utf8')).startsWith('Broken') });
  f.state.scopeTaskId = (await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId })).taskId;
  const control = await import(pathToFileURL(path.join(f.pluginRoot, 'lib/openclaw/openspec-plan-control.mjs')));
  const { recordProposalCoverage: recordCoverage } = await import(pathToFileURL(path.join(f.pluginRoot, 'lib/openclaw/approved-plan-coverage.mjs')));
  const recordProposalCoverage = (...args) => publishProposalCoverage(recordCoverage, ...args);
  const { observeNativeTranscript } = await import(pathToFileURL(path.join(f.pluginRoot, 'lib/openclaw/native-transcript.mjs')));
  const { transcriptUserMessages } = await import(pathToFileURL(path.join(f.pluginRoot, 'lib/runtime-v2/original-requirements.mjs')));
  const { createOriginalSourceAnchor } = await import(pathToFileURL(path.join(f.pluginRoot, 'lib/runtime-v2/original-source-anchor.mjs')));
  const { sha256 } = await import(pathToFileURL(path.join(f.pluginRoot, 'lib/runtime-v2/utils.mjs')));
  const changeName = 'preserve-draft', prefix = `openspec/changes/${changeName}`;
  const tasks = '# Tasks\n\n- [ ] Deliver the requested draft.\n';
  const documents = {
    'proposal.md': '# Proposal\n\nDeliver the requested draft.\n',
    'design.md': '# Design\n\nWrite the requested draft.\n',
    'tasks.md': tasks,
    'specs/draft/spec.md': '## ADDED Requirements\n\n### Requirement: Draft\nThe app SHALL deliver the requested draft.\n',
  };
  for (const [relative, text] of Object.entries(documents)) {
    await fs.mkdir(path.dirname(path.join(f.root, prefix, relative)), { recursive: true });
    await fs.writeFile(path.join(f.root, prefix, relative), text);
  }
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const methods = new Map();
  f.api.registerGatewayMethod = (name, handler) => methods.set(name, handler);
  control.registerOpenSpecPlanControl(f.api, { async openSpecPlanTarget({ sessionId, sessionKey, runId }) {
    if (sessionId !== f.ctx.sessionId || sessionKey !== f.ctx.sessionKey || runId !== f.state.nativeRunId) return null;
    return { state: f.state, projectRoot: f.root, requireProposalCoverage: strict, current: async () => true,
      readProposalSources: async () => transcriptUserMessages(await observeNativeTranscript(f.api, f.state)) };
  } });
  const address = { sessionKey: f.ctx.sessionKey, sessionId: f.ctx.sessionId, runId: f.ctx.runId, changeName };
  async function rpc(action, params) {
    let result;
    await methods.get(`runtime-corrector.openspec.${action}`)({ params,
      client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
      respond(ok, value, error) { assert(ok, error?.message); result = value; } });
    return result;
  }
  const preview = await rpc('preview', address);
  const source = transcriptUserMessages(await observeNativeTranscript(f.api, f.state)).at(-1);
  const identity = { ref: source.ref, sha256: sha256(source.text), start: 1, end: 1 };
  const anchor = createOriginalSourceAnchor({ ...identity, bytes: Buffer.from(source.text) });
  const target = preview.documents.find(row => row.path.endsWith('/spec.md'));
  if (strict) recordProposalCoverage(f.state, target.path, { runId: address.runId, taskId: f.state.scopeTaskId, sessionId: address.sessionId,
    scope: preview.documents, rows: [{ source: anchor, requirement: 'Write a draft.', disposition: 'COVERED',
      targets: [{ ...target, start: 4, end: 4 }] }] });
  const approval = await rpc('approve', { ...address, expectedRevision: preview.revision,
    ...(strict ? { requiredAtoms: [{ source: identity, requirement: 'Write a draft.' }] } : {}) });
  await rpc('arm', { ...address, expectedRevision: preview.revision, applyRunId: 'apply',
    ...(strict ? { expectedInventorySha256: approval.inventorySha256 } : {}) });

  await fs.appendFile(path.join(f.root, 'native.jsonl'), '\n' + JSON.stringify({ type: 'message', id: 'apply-user',
    message: { role: 'user', content: 'Apply the approved plan.', idempotencyKey: 'apply:user' } }) + '\n');
  const apply = { ...f.ctx, runId: 'apply' };
  await f.runtime.prompt({ prompt: 'Apply the approved plan.' }, apply);
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'business-write', params: { path: 'draft.md' } }, apply);
  await fs.writeFile(path.join(f.root, 'draft.md'), 'Broken requested draft.\n');
  await fs.writeFile(path.join(f.root, prefix, 'tasks.md'), tasks.replace('[ ]', '[x]') + '\nAdded after approval.\n');
  if (strict) assert(control.approvedInventoryForApply(f.state, apply.runId, await observeNativeTranscript(f.api, f.state)),
    'the initial Apply must retain the real original source and authenticated strict inventory');
  assert(f.state.projectScope?.fingerprint, 'the fixture must have a trusted scoped project fingerprint');
  f.api.runtime.subagent = { async run(args) { queued.push(args); return { runId: args.idempotencyKey }; } };
  await f.runtime.reply({ kind: 'final', runId: apply.runId, sessionKey: apply.sessionKey, payload: { text: 'Apply complete.' } }, apply);
  await f.runtime.agentEnd({ runId: apply.runId, success: true }, apply);
  await f.runtime.waitForNativeReviews();
  const nativeStops = await f.runtime.waitForNativeReviews();
  assert.equal(queued.length, 1, JSON.stringify({ nativeStops, warnings: f.warnings,
    state: { runId: f.state.nativeRunId, sourceInput: f.state.entries?.filter(row => row.type === 'user' && !row.isMeta).map(row => row.uuid) },
    post: f.runtime.postRuns.list() }));
  assert.match(queued[0].message, /stop-reference/u);
  assert(!queued[0].message.includes(documents['proposal.md']), 'the queued user reference contains no approved document');
  const child = { ...apply, runId: queued[0].idempotencyKey };
  async function promptRestoration() {
    const timing = [], previousInfo = f.api.logger.info;
    // Existing program-owned timing contains stages/durations only. Retain it
    // on failure without adding I/O to the successful admission path.
    f.api.logger.info = message => {
      previousInfo?.call(f.api.logger, message);
      const prefix = '[runtime-corrector] Input admission timing: ';
      if (typeof message === 'string' && message.startsWith(prefix) && timing.length < 32) {
        try { timing.push(JSON.parse(message.slice(prefix.length))); } catch { /* Keep the original failure. */ }
      }
    };
    try { return await f.runtime.prompt({ prompt: queued[0].message }, child); }
    catch (error) {
      t.diagnostic(JSON.stringify({ fixturePhase: 'RESTORATION_NATIVE_INPUT_ADMISSION', variant,
        configuredHookTimeoutMs: f.api.pluginConfig.hookTimeoutMs, admissionTiming: timing }));
      throw error;
    } finally {
      if (previousInfo === undefined) delete f.api.logger.info; else f.api.logger.info = previousInfo;
    }
  }
  if (variant === 'source-change' || variant === 'policy-change') {
    if (variant === 'source-change') await fs.writeFile(path.join(f.root, 'draft.md'), 'A later different candidate.\n');
    else await fs.appendFile(path.join(f.root, '.runtime-corrector/config.yaml'), '\n# Changed after the restoration was queued.\n');
    const prompt = await promptRestoration();
    assert.equal(prompt?.prependContext, undefined);
    const denied = await f.sharedState.stopStartProtocol.findRun({ state: f.state, runId: child.runId });
    assert.equal(denied.admission.accounting, 'RELEASED');
    assert.equal(denied.admission.startStatus, 'NOT_STARTED');
    const observed = await observeNativeTranscript(f.api, f.state);
    assert.equal(control.approvedInventoryForApply(f.state, child.runId, observed, denied), null);
    assert.throws(() => control.readApprovedOpenSpecRestoration(f.state, { runId: child.runId,
      observed, receipt: denied }), /No current admitted/u);
    await f.runtime.reset({}, child);
    return;
  }
  const prompt = await promptRestoration();
  assert.match(prompt.prependContext, /Restore only the existing authenticated approved OpenSpec plan/u);
  const receipt = await f.sharedState.stopStartProtocol.findRun({ state: f.state, runId: child.runId });
  assert.equal(receipt.status, 'STARTED');
  assert.equal(receipt.admission.accounting, 'USED');
  assert.equal(receipt.source.purpose, control.PLAN_RESTORATION_PURPOSE);
  const observed = await observeNativeTranscript(f.api, f.state);
  if (strict) assert.equal(control.approvedInventoryForApply(f.state, child.runId, observed, receipt).inventorySha256, approval.inventorySha256);
  else assert.equal(control.approvedInventoryForApply(f.state, child.runId, observed, receipt), null);

  const args = { command: 'approved-plan', subject: `${prefix}/tasks.md`, startLine: 1, endLine: 20 };
  await f.runtime.beforeTool({ toolName: 'runtime_corrector', toolCallId: 'read-sealed-plan', params: args }, child);
  const { runId: _runId, abortSignal, ...factoryContext } = child;
  const page = await f.runtime.readApprovedPlan(factoryContext, args, { toolCallId: 'read-sealed-plan', signal: abortSignal });
  assert.equal(page.text, tasks, 'changed task text cannot transfer current checkboxes by index');
  await assert.rejects(f.runtime.readApprovedPlan(child, { ...args, subject: 'draft.md' }, { toolCallId: 'read-sealed-plan' }));
  await assert.rejects(f.runtime.readApprovedPlan(factoryContext, args, { toolCallId: 'unbound-plan-read' }));
  await assert.rejects(f.runtime.readApprovedPlan({ ...factoryContext, runId: 'a-foreign-run' }, args, { toolCallId: 'read-sealed-plan' }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.runtime.readApprovedPlan({ ...factoryContext, abortSignal: aborted.signal }, args, { toolCallId: 'read-sealed-plan' }));
  const bindings = f.sharedState.toolBindings.get('read-sealed-plan');
  const binding = bindings.values().next().value;
  bindings.set('ambiguous-fixture', { ...binding, runId: 'another-bound-run' });
  await assert.rejects(f.runtime.readApprovedPlan(factoryContext, args, { toolCallId: 'read-sealed-plan' }));
  bindings.delete('ambiguous-fixture');
  const previousController = f.state.reviewController;
  f.state.reviewController = new AbortController();
  await assert.rejects(f.runtime.readApprovedPlan(factoryContext, args, { toolCallId: 'read-sealed-plan' }));
  f.state.reviewController = previousController;
  await fs.writeFile(path.join(f.root, prefix, 'tasks.md'), tasks.replace('[ ]', '[x]'));
  assert.equal((await control.inspectArmedOpenSpecApply(f.state, child.runId)).status, 'PRESERVED');
  assert.equal(await fs.readFile(path.join(f.root, 'draft.md'), 'utf8'), 'Broken requested draft.\n');
  const calls = f.calls();
  await f.runtime.reply({ kind: 'final', runId: child.runId, sessionKey: child.sessionKey, payload: { text: 'Restored the plan.' } }, child);
  await f.runtime.agentEnd({ runId: child.runId, success: true }, child);
  const finalStops = await f.runtime.waitForNativeReviews({ drain: true });
  const finalStop = finalStops.find(row => row.runId === child.runId);
  assert.equal(finalStop.openSpecPlan.status, 'PRESERVED');
  if (strict) {
    assert.equal(finalStop.reviewStatus, 'UNVERIFIED');
    assert.equal(finalStop.reasonCode, 'OPENSPEC_APPLY_INVENTORY_REVIEW_UNAVAILABLE');
    assert.equal(queued.length, 1, 'an unavailable semantic review cannot initiate a speculative code repair');
  } else {
    assert(f.calls() > calls, JSON.stringify({ finalStops, warnings: f.warnings }));
    const task = await findTask({ projectRoot: f.root, sessionId: child.sessionId });
    assert.equal(task.verification.status, 'DEVIATION', JSON.stringify({ warnings: f.warnings, verification: task.verification }));
    assert.equal(finalStop.reviewStatus, 'DEVIATION', 'restoration must not clear an independently supported business defect');
  }
  await f.runtime.reset({}, child);
});
