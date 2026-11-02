import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordSkillVerifier, recordOrphanSkillResult, nativeSkillPolicy } from '../scripts/evaluate-native-skill.mjs';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { installNativeSkillBatch, prepareNativeEvaluationTools } from '../scripts/helpers/native-stop-evaluation.mjs';
import { createSkillCare } from '../lib/runtime-v2/skill-care.mjs';
import { runInternalExecution } from '../lib/openclaw/internal-context.mjs';
import { currentReviewerProgress } from '../lib/openclaw/internal-context.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { atomicWriteJson } from '../lib/runtime-v2/utils.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';

async function project(t, cleanup = true) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-driver-'));
  if (cleanup) t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const transcript = path.join(projectRoot, 'conversation.jsonl');
  const original = JSON.stringify({ type: 'user', message: { content: 'Follow the provided delivery Skill.' } }) + '\n';
  await fs.writeFile(transcript, original);
  return { projectRoot, transcript, original };
}

test('verifier evidence cannot precede the supplied watcher admission gate or an active cancellation', async t => {
  const f = await project(t);
  await fs.writeFile(path.join(f.projectRoot, 'verify.mjs'), "import fs from 'node:fs';fs.writeFileSync('ran','yes');\n");
  await assert.rejects(recordSkillVerifier({ ...f, assertWatcherActive: async () => { throw new Error('WATCHER_NOT_ACTIVE'); } }), /WATCHER_NOT_ACTIVE/u);
  assert.equal(await fs.readFile(f.transcript, 'utf8'), f.original);
  await assert.rejects(fs.access(path.join(f.projectRoot, 'ran')));
  const controller = new AbortController(); controller.abort(new Error('CANCELLED'));
  await assert.rejects(recordSkillVerifier({ ...f, signal: controller.signal, assertWatcherActive: async () => assert.fail('Cancelled admission must not proceed') }), /CANCELLED/u);
  assert.equal(await fs.readFile(f.transcript, 'utf8'), f.original);
});

for (const exitCode of [0, 3]) test(`controlled verifier helper records the actual local exit ${exitCode} with matching invocation/result; no model history is claimed`, async t => {
  const f = await project(t);
  await fs.writeFile(path.join(f.projectRoot, 'verify.mjs'), `console.log('controlled local check');process.exitCode=${exitCode};\n`);
  // Unit admission only: this is not a real Skill watcher/semantic acceptance.
  const result = await recordSkillVerifier({ ...f, assertWatcherActive: async () => {} });
  assert.equal(result.actualLocalExecution, true); assert.equal(result.exitCode, exitCode);
  assert.equal(result.modelBusinessRun, false); assert.equal(result.nativeHostToolInvocationClaimed, false);
  const text = await fs.readFile(f.transcript, 'utf8'); assert(text.startsWith(f.original));
  const entries = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 3);
  const invocation = entries[1].message.content[0], completion = entries[2].message.content[0];
  assert.equal(invocation.type, 'tool_use'); assert.equal(invocation.id, result.invocationId);
  assert.equal(invocation.input.executable, process.execPath);
  assert.equal(completion.tool_use_id, invocation.id); assert.equal(completion.is_error, exitCode !== 0);
  assert.match(completion.content, new RegExp(`Exit code ${exitCode}\\ncontrolled local check`));
  assert(entries.slice(1).every(entry => entry.actor === 'controlled-component-driver'));
});

test('orphan fixture result stays explicitly unpaired and does not execute the verifier', async t => {
  const f = await project(t);
  await fs.writeFile(path.join(f.projectRoot, 'verify.mjs'), "import fs from 'node:fs';fs.writeFileSync('ran','yes');\n");
  const result = await recordOrphanSkillResult({ ...f, assertWatcherActive: async () => {} });
  assert.equal(result.actualLocalExecution, false); assert.equal(result.matchedInvocation, false);
  const entries = (await fs.readFile(f.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 2); assert.equal(entries[1].message.content[0].type, 'tool_result');
  assert.equal(entries.some(entry => entry.message.content?.some?.(block => block.type === 'tool_use')), false);
  await assert.rejects(fs.access(path.join(f.projectRoot, 'ran')));
});

test('Skill policy compiles with project-local source roots and offline-only onboarding isolation', async t => {
  const f = await project(t), policyRoot = path.join(f.projectRoot, '.runtime-corrector'); await fs.mkdir(policyRoot);
  const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: fileURLToPath(new URL('../', import.meta.url)), outputRoot: path.join(f.projectRoot, 'build') });
  const pipeline = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')).href);
  for (const offline of [false, true]) {
    await fs.writeFile(path.join(policyRoot, 'config.yaml'), nativeSkillPolicy({ modelRef: 'evaluation/glm-5.3', offline }));
    const plan = await pipeline.loadConfig({ cwd: f.projectRoot, pluginRoot });
    assert.equal(plan.runtimeV2.skillCorrection.enabled, true);
    assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, true);
    assert.deepEqual(plan.runtimeV2.skillCorrection.skillRoots, [path.join(f.projectRoot, 'skills')]);
    assert.equal(plan.runtimeV2.dynamicGroundTruth.panel.size, offline ? 0 : 2);
    assert.equal(plan.runtimeV2.stopCorrection.enabled, false);
    assert.equal(plan.runtimeV2.implementationCorrection.enabled, false);
  }
});

async function skillBatchFixture(t, now = () => Date.parse('2026-11-03T14:00:00Z')) {
  const f = await project(t, false);
  await fs.writeFile(path.join(f.projectRoot, 'prior.json'), JSON.stringify({ totalProviderRequests: 0, inFlightRequests: 0, cumulativeReferenceEstimateIncludingOldHeldUsd: 0 }));
  const manifest = { kind: 'native-skill-triplet-v1', credentialEnv: 'RC_NATIVE_SKILL_API_KEY',
    stageDeadline: '2026-11-03T15:00:00Z', priorProviderRequests: 0, priorConservativeCommittedUsd: 0,
    priorSettlement: 'prior.json', sourceHashes: {}, hostHashes: {}, launchClaim: 'claim.json',
    limits: { requests: 6, perCase: 2, wallMs: 60000, inputTokens: 65536, payloadBytes: 57344, outputTokens: 32768, usd: 16 } };
  const batch = await installNativeSkillBatch({ sourceRoot: f.projectRoot, hostRoot: '/opt/homebrew/lib/node_modules/openclaw',
    outputRoot: f.projectRoot, manifest, offline: true, now });
  t.after(async () => { await batch.close(); await fs.rm(f.projectRoot, { recursive: true, force: true }); });
  const sample = path.join(f.projectRoot, 'sample'); await fs.mkdir(sample);
  const transcript = path.join(sample, 'conversation.jsonl'); await fs.writeFile(transcript, f.original);
  await batch.beginCase({ projectRoot: sample, files: [transcript], appendOnlyFiles: [transcript] });
  const skillCare = await createSkillCare({ projectRoot: sample, taskId: 'unit-task',
    request: { skill: { skillId: 'delivery-verifier' } }, evidence: { skillSource: { root: sample, digest: 'unit-source',
      files: [{ path: 'SKILL.md', content: 'Actually run the provided verifier before completion.\n', sha256: 'unit-hash' }] }, snapshot: { entries: [] } } });
  return { ...f, batch, sample, transcript, skillCare };
}

const hostAvailable = existsSync('/opt/homebrew/lib/node_modules/openclaw/package.json');
test('Skill private tools require the actual reviewer scope and reject previous-run/case callbacks', { skip: !hostAvailable }, async t => {
  await assert.rejects(installNativeSkillBatch({ manifest: { kind: 'native-document-pair-v1' } }));
  const f = await skillBatchFixture(t), progress = { sessionId: 'skill-session', role: 'skill-reviewer', skillCare: f.skillCare };
  const params = runId => ({ sessionId: progress.sessionId, sessionKey: `agent:main:${progress.sessionId}`, runId,
    config: {}, prompt: 'Current controlled request', extraSystemPrompt: 'Actual RC controls' });
  const prepared = { requestPath: f.transcript, request: {} };
  await assert.rejects(prepareNativeEvaluationTools(params('first'), { fixtureFence: { projectRoot: f.sample }, skill: true, role: progress.role }), /actual owning reviewer/u);
  const snapshots = [];
  for (const runId of ['first', 'second']) await f.batch.scopeReview({ role: progress.role }, async () => {
    f.batch.prepared(prepared);
    await runInternalExecution(progress.sessionId, async () => {
      const admitted = await prepareNativeEvaluationTools(params(runId), { fixtureFence: { projectRoot: f.sample }, skill: true, role: progress.role });
      assert.deepEqual(admitted.toolsAllow, ['read', 'rc_skill_care']);
      await f.batch.runNative(admitted, async () => {
        snapshots.push(AsyncLocalStorage.snapshot());
        assert.equal((await f.skillCare.execute({ action: 'resume' })).skillId, 'delivery-verifier');
      });
    }, undefined, progress);
  });
  await assert.rejects(snapshots[0](() => f.skillCare.execute({ action: 'resume' })), /another native session\/run/u);
  await snapshots[1](() => f.skillCare.execute({ action: 'resume' }));
  const another = path.join(f.projectRoot, 'another'); await fs.mkdir(another);
  const anotherTranscript = path.join(another, 'conversation.jsonl'); await fs.writeFile(anotherTranscript, f.original);
  await f.batch.beginCase({ projectRoot: another, files: [anotherTranscript], appendOnlyFiles: [anotherTranscript] });
  await assert.rejects(snapshots[1](() => f.skillCare.execute({ action: 'resume' })), /another native session\/run/u);
});

test('Skill transcript stages preserve original authority and allowance counters while admitting attributable future history', { skip: !hostAvailable }, async t => {
  const f = await skillBatchFixture(t), progress = { sessionId: 'extractor', role: 'ground-truth-extractor', skillCare: f.skillCare };
  const before = f.batch.metrics();
  await f.batch.scopeReview({ role: progress.role }, async () => {
    f.batch.prepared({ requestPath: f.transcript, request: {} });
    await runInternalExecution(progress.sessionId, async () => {
      const params = await prepareNativeEvaluationTools({ sessionId: progress.sessionId, sessionKey: `agent:main:${progress.sessionId}`,
        runId: 'current-run', config: {}, prompt: 'Current request', extraSystemPrompt: 'Actual controls' },
      { fixtureFence: { projectRoot: f.sample }, skill: true, role: progress.role });
      await f.batch.runNative(params, async () => {
        const response = await globalThis.fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${f.batch.credential()}` }, body: JSON.stringify({
            model: 'glm-5.3', stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
            messages: [{ role: 'system', content: 'Actual controls' }, { role: 'user', content: 'Current request' }],
            tools: ['read', 'rc_skill_care'].map(name => ({ type: 'function', function: { name } })),
          }),
        });
        assert.equal(response.status, 200);
      });
    }, undefined, progress);
  });
  const admittedHistory = JSON.stringify({ actor: 'controlled-component-driver', type: 'user', isMeta: true,
    message: { content: [{ type: 'tool_result', tool_use_id: 'deliberate-orphan', content: 'Unattributed fixture output' }] } }) + '\n';
  await fs.appendFile(f.transcript, admittedHistory);
  await f.batch.advanceTranscript({ path: f.transcript, stage: 'CONTROLLED_ORPHAN_RESULT' });
  const after = f.batch.metrics();
  assert.equal(after.budget.requests, 1); assert.equal(after.cases[0].requests, 1);
  assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.cases.length, 1);
  assert.equal(after.cases[0].sourceRevisions.length, 1); assert.equal(after.realProviderRequests, 0);
  const accepted = await fs.readFile(f.transcript);
  await fs.appendFile(f.transcript, JSON.stringify({ actor: 'controlled-component-driver', type: 'user', message: { content: 'Invented new user requirement' } }) + '\n');
  await assert.rejects(f.batch.advanceTranscript({ path: f.transcript, stage: 'FORBIDDEN_AUTHORITY' }), /new user authority is forbidden/u);
  await fs.writeFile(f.transcript, 'Changed original prefix\n');
  await assert.rejects(f.batch.advanceTranscript({ path: f.transcript, stage: 'FORBIDDEN_PREFIX' }), /exact original prefix/u);
  await fs.writeFile(f.transcript, accepted);
});

test('real reviewer handle followUp outside initial batch scope retains its own prepared Skill context', { skip: !hostAvailable }, async t => {
  const f = await skillBatchFixture(t), task = await ensureTask({ projectRoot: f.sample, sessionId: 'business' });
  const sourceText = 'Create app.mjs.\n'; await fs.writeFile(path.join(f.sample, 'SKILL.md'), sourceText);
  const admitted = [];
  const config = { agents: { defaults: { model: { primary: 'fixture/model' } } } };
  const api = { config, runtime: { agent: { async runEmbeddedAgent(original) {
    const params = await prepareNativeEvaluationTools(original, { fixtureFence: { projectRoot: f.sample },
      skill: true, batch: f.batch });
    return f.batch.runNative(params, async () => {
      const progress = currentReviewerProgress(params);
      assert.equal(progress.role, 'ground-truth-extractor');
      assert.equal((await progress.skillCare.execute({ action: 'resume' })).skillId, 'delivery-verifier');
      if (admitted.length) {
      const response = await globalThis.fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${f.batch.credential()}` }, body: JSON.stringify({
          model: 'glm-5.3', stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
          messages: [{ role: 'system', content: params.extraSystemPrompt }, { role: 'user', content: `[controlled host timestamp] ${params.prompt}` }],
          tools: params.toolsAllow.map(name => ({ type: 'function', function: { name } })),
        }),
      });
      assert.equal(response.status, 200);
      }
      admitted.push({ sessionId: params.sessionId, runId: params.runId });
      // Scripted transport output tests ownership only, not Skill semantics.
      return { payloads: [{ text: JSON.stringify({ ok: true }) }], meta: {} };
    });
  } } } };
  const factory = createOpenClawReviewerFactory(api, { pluginRoot: path.resolve('.') });
  const controller = new AbortController();
  const input = { projectRoot: f.sample, taskId: task.taskId, role: 'ground-truth-extractor',
    schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
    reviewer: { timeoutMs: 10000, formatRepairAttempts: 0 }, abortSignal: controller.signal,
    request: { skillGraphOnly: true, skill: { skillId: 'delivery-verifier' } },
    evidence: { snapshot: { entries: [] }, skillSource: { root: f.sample, digest: 'controlled-source',
      files: [{ path: 'SKILL.md', content: sourceText, sha256: 'controlled-hash' }] } },
    onPrepared: value => f.batch.prepared(value) };
  const handle = await f.batch.scopeReview(input, () => factory(input));
  try {
    assert.deepEqual(await handle.followUp({ prompt: 'Recheck this same original source.' }), { ok: true });
    assert.equal(admitted.length, 2);
    assert.equal(admitted[0].sessionId, admitted[1].sessionId);
    assert.notEqual(admitted[0].runId, admitted[1].runId);
    assert.equal(f.batch.metrics().realProviderRequests, 0);
    assert.equal(f.batch.metrics().budget.requests, 1);
    assert.throws(() => f.batch.reviewRole('foreign-session'), /context|session|owner/iu);
    const another = path.join(f.projectRoot, 'followup-another'); await fs.mkdir(another);
    const transcript = path.join(another, 'conversation.jsonl'); await fs.writeFile(transcript, f.original);
    await f.batch.beginCase({ projectRoot: another, files: [transcript] });
    await assert.rejects(handle.followUp({ prompt: 'A previous case cannot recover here.' }), /context|session|owner/iu);
    assert.equal(admitted.length, 2);
  } finally { await handle.close(); }
  await assert.rejects(handle.followUp({ prompt: 'Closed handles stay closed.' }), /closed/u);
  assert.equal(f.batch.metrics().realProviderRequests, 0);
});

for (const terminal of ['cancel', 'deadline', 'close']) test(`retained native session role cannot survive ${terminal}`, { skip: !hostAvailable }, async t => {
  let clock = Date.parse('2026-11-03T14:00:00Z');
  const f = await skillBatchFixture(t, () => clock), controller = new AbortController();
  const progress = { sessionId: 'owned-session', role: 'ground-truth-extractor', skillCare: f.skillCare };
  await f.batch.scopeReview(progress, async () => {
    f.batch.prepared({ requestPath: f.transcript, request: {} });
    await runInternalExecution(progress.sessionId, async () => {
      const params = await prepareNativeEvaluationTools({ sessionId: progress.sessionId, sessionKey: `agent:main:${progress.sessionId}`,
        runId: 'original', config: {}, prompt: 'Original request', extraSystemPrompt: 'Actual controls',
        abortSignal: controller.signal, runTimeoutOverrideMs: 5 }, { skill: true, role: f.batch.reviewRole(progress.sessionId) });
      await f.batch.runNative(params, async () => {
        assert.throws(() => f.batch.reviewRole('other-session'), /another session/u);
      });
    }, undefined, progress);
  });
  assert.equal(f.batch.reviewRole(progress.sessionId), progress.role);
  for (const role of ['skill-reviewer', progress.role]) await f.batch.scopeReview({ role }, async () => {
    f.batch.prepared({ requestPath: f.transcript, request: { differentReview: true } });
    assert.throws(() => f.batch.reviewRole(progress.sessionId), /another reviewer context/u);
  });
  if (terminal === 'cancel') controller.abort(new Error('CONTROLLED_CANCEL'));
  if (terminal === 'deadline') clock += 6;
  if (terminal === 'close') await f.batch.close();
  assert.throws(() => f.batch.reviewRole(progress.sessionId), /CANCEL|expired|context/iu);
  assert.equal(f.batch.metrics().budget.requests, 0);
  assert.equal(f.batch.metrics().realProviderRequests, 0);
});

async function nativeFixtureTool(params, tools, persist, ctx, name, id, args) {
  await fs.access(params.sessionFile).catch(() => fs.writeFile(params.sessionFile,
    JSON.stringify({ type: 'session', version: 3, id: params.sessionId }) + '\n'));
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }] } }) + '\n');
  const result = await tools.find(tool => tool.name === name).execute(id, args);
  const message = { role: 'toolResult', toolCallId: id, toolName: name, content: result.content,
    details: result.details, isError: Boolean(result.isError) };
  persist({ toolName: name, toolCallId: id, isSynthetic: false, message }, ctx);
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
  return result;
}

test('actual baseline factory may prepare a new request in its settled project session without reusing old prepared context', { skip: !hostAvailable }, async t => {
  const f = await skillBatchFixture(t), task = await ensureTask({ projectRoot: f.sample, sessionId: 'business-baseline' });
  const truth = await loadCurrentGroundTruth(f.sample, task.taskId), truthPath = path.join(taskDirectory(f.sample, task.taskId), 'ground-truth/current.json');
  await atomicWriteJson(truthPath, truth);
  let toolsFor, persist, calls = 0; const captures = [], prepared = [];
  const api = { config: { agents: { defaults: { model: { primary: 'fixture/model' } } } }, runtime: { agent: {} },
    registerTool(factory) { toolsFor = factory; }, on(name, callback) { if (name === 'tool_result_persist') persist = callback; } };
  registerTaskTools(api);
  const factory = createOpenClawReviewerFactory(api, { baselineWireMode: 'full', runEmbeddedAgent: async original => {
    const params = await prepareNativeEvaluationTools(original, { fixtureFence: { projectRoot: f.sample }, skill: true, batch: f.batch })
      .catch(error => { t.diagnostic(`Actual baseline tool preparation: ${error.message}; prior completed runs=${captures.length}; prepared=${prepared.length}`); throw error; });
    return f.batch.runNative(params, async () => {
      captures.push(params); const ctx = { sessionId: params.sessionId, sessionKey: params.sessionKey }, tools = toolsFor(ctx);
      for (const file of JSON.parse(params.prompt).requiredFiles) {
        const id = `actual-baseline-read-${++calls}`, value = await nativeFixtureTool(params, tools, persist, ctx, 'source_read', id, { path: file });
      }
      const value = await nativeFixtureTool(params, tools, persist, ctx, 'finish_baseline', `actual-finish-${calls}`, {
        batchIds: [], taskClassification: 'NO_CHANGE', summary: 'Ownership/receipt protocol only; no semantic or formal acceptance claimed.' });
      params.onAgentToolResult({ toolName: 'finish_baseline', result: value, isError: false });
      return { payloads: [], meta: {} };
    });
  } });
  for (const hookEventId of ['first-request', 'next-request']) {
    const input = { projectRoot: f.sample, taskId: task.taskId, role: 'ground-truth-extractor',
      reviewer: { timeoutMs: 10000 }, schema: GROUND_TRUTH_REVIEW_SCHEMA,
      request: { hookEventId, currentGroundTruth: { path: truthPath }, sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE' }], reviewScope: { kind: 'baseline', boundedBasis: true } },
      evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1', message: { content: 'Original controlled scope.' } }] } },
      onPrepared: value => { prepared.push(value); f.batch.prepared(value); } };
    const handle = await f.batch.scopeReview(input, () => factory(input)); await handle.close();
  }
  assert.equal(captures.length, 2); assert.equal(captures[0].sessionId, captures[1].sessionId);
  assert(captures[0].abortSignal.aborted); assert.notEqual(prepared[0].requestPath, prepared[1].requestPath);
  assert.equal(f.batch.metrics().realProviderRequests, 0); assert.equal(f.batch.metrics().budget.requests, 0);
});

// Real factory/worker/registered-tool plumbing with scripted native results.
// No installed agent, semantic verdict, formal ledger apply or provider call.
async function baselineContinuationFixture(t, { now = Date.now, beforeNative, duringNative } = {}) {
  const f = await skillBatchFixture(t, now), controller = new AbortController();
  const task = await ensureTask({ projectRoot: f.sample, sessionId: 'bounded-domain-business' });
  const truth = await loadCurrentGroundTruth(f.sample, task.taskId);
  const truthPath = path.join(taskDirectory(f.sample, task.taskId), 'ground-truth/current.json');
  await atomicWriteJson(truthPath, truth);
  let toolsFor, persist, calls = 0;
  const state = { ...f, task, controller, originals: [], admitted: [], prepared: [], bareSnapshots: [], nativeSnapshots: [], tools: [] };
  const api = { config: { agents: { defaults: { model: { primary: 'fixture/model' } } } }, runtime: { agent: {} },
    registerTool(factory) { toolsFor = factory; }, on(name, callback) { if (name === 'tool_result_persist') persist = callback; } };
  registerTaskTools(api);
  const factory = createOpenClawReviewerFactory(api, { baselineWireMode: 'full', runEmbeddedAgent: async original => {
    state.originals.push(original);
    await beforeNative?.(original, state);
    const params = await prepareNativeEvaluationTools(original, { fixtureFence: { projectRoot: f.sample }, skill: true, batch: f.batch });
    return f.batch.runNative(params, async () => {
      state.admitted.push(params); state.nativeSnapshots.push(AsyncLocalStorage.snapshot());
      const ctx = { sessionId: params.sessionId, sessionKey: params.sessionKey, runId: params.runId }, tools = toolsFor(ctx);
      state.tools.push(tools);
      const finish = async () => {
        for (const file of JSON.parse(params.prompt).requiredFiles) {
          const id = `domain-read-${++calls}`, value = await nativeFixtureTool(params, tools, persist, ctx, 'source_read', id, { path: file });
        }
        const value = await nativeFixtureTool(params, tools, persist, ctx, 'finish_baseline', `domain-finish-${calls}`, {
          batchIds: [], taskClassification: 'NO_CHANGE', summary: 'Controlled domain lifecycle only; no semantic or formal acceptance claimed.' });
        params.onAgentToolResult({ toolName: 'finish_baseline', result: value, isError: false });
        return { payloads: [], meta: {} };
      };
      return duringNative ? duringNative(params, state, finish) : finish();
    });
  } });
  state.input = { projectRoot: f.sample, taskId: task.taskId, role: 'ground-truth-extractor',
    reviewer: { timeoutMs: 10000 }, schema: GROUND_TRUTH_REVIEW_SCHEMA, abortSignal: controller.signal,
    request: { hookEventId: 'same-domain-request', currentGroundTruth: { path: truthPath },
      sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE' }], reviewScope: { kind: 'baseline', boundedBasis: true } },
    evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1', message: { content: 'Original controlled scope.' } }] } },
    onPrepared: value => { state.prepared.push(value); f.batch.prepared(value); state.bareSnapshots.push(AsyncLocalStorage.snapshot()); } };
  state.open = () => f.batch.scopeReview(state.input, () => factory(state.input));
  return state;
}

test('bounded baseline domain followUp keeps the actual prepared request and original allowance after prior native completion', { skip: !hostAvailable }, async t => {
  const f = await baselineContinuationFixture(t, { duringNative: async (params, state, finish) => {
    if (state.admitted.length === 2) {
      const response = await globalThis.fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${state.batch.credential()}` }, body: JSON.stringify({
          model: 'glm-5.3', stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
          messages: [{ role: 'system', content: params.extraSystemPrompt }, { role: 'user', content: params.prompt }],
          tools: params.toolsAllow.map(name => ({ type: 'function', function: { name } })),
        }),
      });
      assert.equal(response.status, 200); await response.text();
    }
    return finish();
  } });
  const handle = await f.open(), before = f.batch.metrics();
  try {
    assert(f.originals[0].abortSignal.aborted);
    const result = await handle.followUp({ prompt: 'Recheck the same original without changing task scope.', nextSchema: GROUND_TRUTH_REVIEW_SCHEMA });
    assert.deepEqual(result.operations, []); assert.equal(f.prepared.length, 1);
    assert.equal(f.admitted.length, 2); assert.equal(f.admitted[0].sessionId, f.admitted[1].sessionId);
    assert.notEqual(f.admitted[0].runId, f.admitted[1].runId);
    const after = f.batch.metrics(), request = after.requests[0];
    assert.equal(after.deadlineAt, before.deadlineAt); assert.deepEqual(after.limits, before.limits);
    assert.equal(after.budget.requests, 1); assert.equal(after.realProviderRequests, 0);
    assert.equal(request.requestPath, f.prepared[0].requestPath);
    assert.equal(request.runId, f.admitted[1].runId); assert.equal(request.sessionId, handle.sessionId);
    const checkpoint = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'review-checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.taskState.repairs, 1); assert.equal(checkpoint.taskState.attempts, 2);
  } finally { await handle.close(); }
});

test('bounded continuation rejects wrong current binding, prepared identity and stale callbacks before dispatch', { skip: !hostAvailable }, async t => {
  let unexpectedDispatches = 0, controls = 0;
  const f = await baselineContinuationFixture(t, { beforeNative: async (params, state) => {
    if (state.originals.length !== 2) return;
    const reject = async (candidate, pattern) => {
      await assert.rejects(prepareNativeEvaluationTools(candidate, { skill: true, batch: state.batch }), pattern);
      await assert.rejects(state.batch.runNative(candidate, () => { unexpectedDispatches++; }), pattern);
      controls++;
    };
    const binding = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')].get(params.sessionKey);
    for (const [field, invalid] of [['sessionKey', 'foreign-key'], ['sessionId', 'foreign-session'], ['runId', 'foreign-run'],
      ['signal', new AbortController().signal]]) {
      const actual = binding[field];
      try { binding[field] = invalid; await reject(params, /actual current task binding/u); }
      finally { binding[field] = actual; }
    }
    const active = binding.active;
    try { binding.active = () => { throw new Error('CONTROLLED_BINDING_INACTIVE'); }; await reject(params, /CONTROLLED_BINDING_INACTIVE/u); }
    finally { binding.active = active; }
    const cancelled = new AbortController(); cancelled.abort(new Error('CONTROLLED_CURRENT_RUN_CANCEL'));
    const currentSignal = binding.signal;
    try { binding.signal = cancelled.signal; await reject({ ...params, abortSignal: cancelled.signal }, /CONTROLLED_CURRENT_RUN_CANCEL/u); }
    finally { binding.signal = currentSignal; }
    const registry = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')];
    try { registry.delete(params.sessionKey); await reject(params, /actual current task binding/u); }
    finally { registry.set(params.sessionKey, binding); }
    for (const [patch, pattern] of [
      [{ sessionKey: 'foreign-key' }, /actual current task binding/u],
      [{ sessionId: 'foreign-session' }, /prepared owner context/u],
      [{ runId: 'foreign-run' }, /actual current task binding/u],
      [{ abortSignal: new AbortController().signal }, /actual current task binding/u],
      [{ cwd: path.join(state.sample, 'wrong-source') }, /prepared request paths/u],
      [{ workspaceDir: path.join(state.sample, 'wrong-source') }, /prepared request paths/u],
      [{ prompt: JSON.stringify({ ...JSON.parse(params.prompt), identity: { ...JSON.parse(params.prompt).identity, requestId: 'foreign-request' } }) }, /prepared request identity/u],
    ]) await reject({ ...params, ...patch }, pattern);
    const prepared = state.prepared[0];
    for (const [change, pattern] of [
      [value => { value.request.identity.taskId = 'foreign-task'; }, /prepared task identity/u],
      [value => { value.request.identity.requestId = 'foreign-request'; }, /prepared request identity/u],
      [value => { value.request.identity.baselineVersion++; }, /prepared request identity/u],
      [value => { value.requestDirectory += '-foreign'; }, /prepared request paths/u],
      [value => { value.requestPath += '-foreign'; }, /prepared request paths/u],
      [value => { value.request.requiredFiles.push('foreign-source.txt'); }, /prepared original files/u],
      [value => { value.request.reviewScope.boundedBasis = false; }, /prepared task identity/u],
    ]) {
      const invalid = structuredClone(prepared); change(invalid);
      await state.batch.scopeReview(state.input, async () => {
        state.batch.prepared(invalid); await reject(params, pattern);
      });
    }
    await state.batch.scopeReview({ ...state.input, taskId: 'foreign-task' }, async () => {
      state.batch.prepared(prepared); await reject(params, /prepared task identity/u);
    });
    await reject(state.originals[0], /actual current task binding/u);
    await state.bareSnapshots[0](() => reject(state.originals[0], /actual current task binding/u));
    await state.nativeSnapshots[0](() => reject(params, /callback belongs to another run/u));
    await assert.rejects(state.tools[0].find(tool => tool.name === 'source_read').execute('stale-read', {
      path: JSON.parse(params.prompt).requiredFiles[0] }), /binding expired/u);
  } });
  const handle = await f.open();
  try {
    await handle.followUp({ prompt: 'Same task, current real binding only.' });
    assert.equal(controls, 25); assert.equal(unexpectedDispatches, 0); assert.equal(f.admitted.length, 2);
    assert.equal(f.batch.metrics().budget.requests, 0); assert.equal(f.batch.metrics().realProviderRequests, 0);
  } finally { await handle.close(); }
});

test('new baseline preparation cannot borrow a previous bare ambient request even in the same physical session', { skip: !hostAvailable }, async t => {
  const f = await baselineContinuationFixture(t, { beforeNative: async (params, state) => {
    if (state.originals.length !== 2) return;
    assert.equal(state.bareSnapshots[0](() => state.batch.reviewRole(params.sessionId)), 'ground-truth-extractor');
    await state.bareSnapshots[0](async () => {
      await assert.rejects(prepareNativeEvaluationTools(params, { skill: true, batch: state.batch }), /prepared request paths/u);
      await assert.rejects(state.batch.runNative(params, () => assert.fail('Old prepared must never own a new request')), /prepared request paths/u);
    });
    await assert.rejects(state.tools[0].find(tool => tool.name === 'source_read').execute('closed-old-read', {
      path: JSON.parse(params.prompt).requiredFiles[0] }), /binding expired/u);
  } });
  const first = await f.open(); await first.close();
  await assert.rejects(first.followUp({ prompt: 'Closed handle cannot start another native invocation.' }), /closed/u);
  assert.equal(f.originals.length, 1);
  f.input.request.hookEventId = 'genuinely-new-preparation';
  const second = await f.open(); await second.close();
  assert.equal(f.prepared.length, 2); assert.notEqual(f.prepared[0].requestPath, f.prepared[1].requestPath);
  assert.equal(first.sessionId, second.sessionId); assert.equal(f.admitted.length, 2);
  assert.equal(f.batch.metrics().budget.requests, 0); assert.equal(f.batch.metrics().realProviderRequests, 0);
});

test('bounded continuation cannot dispatch concurrently before the genuine native callback settles', { skip: !hostAvailable }, async t => {
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await baselineContinuationFixture(t, { duringNative: async (_params, state, finish) => {
    if (state.admitted.length === 2) { entered(); await gate; }
    return finish();
  } });
  const handle = await f.open(); let pending;
  try {
    pending = handle.followUp({ prompt: 'First legitimate repair.' });
    await waiting;
    await assert.rejects(f.batch.runNative(f.originals[1], () => assert.fail('Concurrent dispatch is forbidden')), /invocation is not settled/u);
    await assert.rejects(handle.followUp({ prompt: 'Concurrent repair must not reach native runner.' }), /Concurrent native task runs/u);
    assert.equal(f.originals.length, 2); assert.equal(f.admitted.length, 2);
    release(); assert.deepEqual((await pending).operations, []);
    assert.equal(f.batch.metrics().budget.requests, 0); assert.equal(f.batch.metrics().realProviderRequests, 0);
  } finally { release(); await pending?.catch(() => {}); await handle.close(); }
});

for (const terminal of ['parent cancellation', 'original deadline', 'closed handle', 'another case']) {
  test(`bounded baseline domain continuation cannot survive ${terminal}`, { skip: !hostAvailable }, async t => {
    let clock = Date.now();
    const f = await baselineContinuationFixture(t, { now: () => clock }), handle = await f.open();
    const before = f.batch.metrics();
    try {
      if (terminal === 'parent cancellation') f.controller.abort(new Error('CONTROLLED_PARENT_CANCEL'));
      if (terminal === 'original deadline') clock += f.originals[0].runTimeoutOverrideMs + 1;
      if (terminal === 'closed handle') await handle.close();
      if (terminal === 'another case') {
        const another = path.join(f.projectRoot, 'next-case'); await fs.mkdir(another);
        const transcript = path.join(another, 'conversation.jsonl'); await fs.writeFile(transcript, f.original);
        await f.batch.beginCase({ projectRoot: another, files: [transcript] });
      }
      await assert.rejects(handle.followUp({ prompt: 'No new invocation authority from an expired owner.' }),
        /CONTROLLED_PARENT_CANCEL|closed|Native task execution failed/u);
      assert.equal(f.admitted.length, 1);
      assert.equal(f.originals.length, ['parent cancellation', 'closed handle'].includes(terminal) ? 1 : 2);
      const after = f.batch.metrics();
      assert.equal(after.deadlineAt, before.deadlineAt); assert.deepEqual(after.limits, before.limits);
      assert.equal(after.budget.requests, 0); assert.equal(after.realProviderRequests, 0);
    } finally { await handle.close(); }
  });
}
