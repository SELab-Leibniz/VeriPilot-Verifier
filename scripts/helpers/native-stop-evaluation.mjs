// Development-only acceptance transport for the pinned, installed host. The
// host package is inspected/imported only; config, state and build stay local.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildPlugin } from '../../lib/plugin-builder.mjs';
import { createOpenClawReviewerFactory } from '../../lib/openclaw/reviewer.mjs';
import { readOpenClawTranscript } from '../../lib/openclaw/transcript.mjs';
import * as hostAdapter from '../../lib/hosts/openclaw.mjs';
import { installProviderFetchTiming } from './provider-fetch-timing.mjs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { createProviderRequestBudget } from './provider-request-budget.mjs';
import { syntheticOpenAiSseUsage } from './synthetic-calibration-fetch.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentReviewerProgress } from '../../lib/openclaw/internal-context.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeControl = (value, workspace) => JSON.stringify(value).replaceAll(workspace, '<WORKSPACE>')
  .replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gu, '<UUID>');

export function validateNativeStopBatchLimits(value) {
  const keys = ['requests', 'perCase', 'wallMs', 'inputTokens', 'payloadBytes', 'outputTokens', 'usd'];
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Finite native batch limits are required');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected native batch limit fields');
  const bounds = { requests: [1, 128], perCase: [1, 128], wallMs: [1000, 3600000],
    inputTokens: [1, 1048576], payloadBytes: [1, 1048576], outputTokens: [32768, 32768] };
  for (const [key, [min, max]] of Object.entries(bounds))
    assert(Number.isSafeInteger(value[key]) && value[key] >= min && value[key] <= max, `Invalid finite native batch limit: ${key}`);
  assert(value.perCase <= value.requests, 'Per-case requests cannot exceed the shared request cap');
  assert(value.inputTokens >= value.payloadBytes + 8192, 'Input reservation must cover the serialized body and protocol allowance');
  assert(Number.isFinite(value.usd) && value.usd > 0, 'A positive finite native batch USD cap is required');
  return Object.freeze({ ...value });
}

// One invocation of the existing evaluation CLI owns both cases and this one
// ledger. Profile/session replacement never creates another paid allowance.
export async function installNativeStopBatch(options) {
  assert.equal(options.manifest.kind, 'native-stop-pair-batch-v1');
  return installNativeEvaluationBatch(options);
}

export async function installNativeBaselineBatch(options) {
  assert.equal(options.manifest.kind, 'native-baseline-component-v1');
  return installNativeEvaluationBatch({ ...options, baseline: true });
}

export async function installNativeDocumentBatch(options) {
  assert.equal(options.manifest.kind, 'native-document-pair-v1');
  return installNativeEvaluationBatch({ ...options, document: true });
}

export async function installNativeSkillBatch(options) {
  assert.equal(options.manifest.kind, 'native-skill-triplet-v1');
  return installNativeEvaluationBatch({ ...options, skill: true });
}

async function installNativeEvaluationBatch({ hostRoot, sourceRoot, outputRoot, manifest, offline = false, now = Date.now, baseline = false, document = false, skill = false }) {
  const component = baseline || document || skill;
  const limits = validateNativeStopBatchLimits(manifest.limits);
  const approvedDeadline = Date.parse(manifest.stageDeadline);
  assert(Number.isFinite(approvedDeadline), 'A valid batch launch deadline is required');
  assert.equal(manifest.credentialEnv, skill ? 'RC_NATIVE_SKILL_API_KEY' : document ? 'RC_NATIVE_DOCUMENT_API_KEY' : baseline ? 'RC_NATIVE_COMPONENT_API_KEY' : 'RC_NATIVE_STOP_API_KEY');
  for (const [file, hash] of Object.entries(manifest.sourceHashes))
    assert.equal(digest(await fs.readFile(path.join(sourceRoot, file))), hash, `Unfrozen source: ${file}`);
  for (const [file, hash] of Object.entries(manifest.hostHashes))
    assert.equal(digest(await fs.readFile(path.join(hostRoot, file))), hash, `Unfrozen host: ${file}`);
  const prior = JSON.parse(await fs.readFile(path.join(sourceRoot, manifest.priorSettlement), 'utf8'));
  assert(Number.isSafeInteger(manifest.priorProviderRequests) && manifest.priorProviderRequests >= 0);
  assert(Number.isFinite(manifest.priorConservativeCommittedUsd) && manifest.priorConservativeCommittedUsd >= 0);
  assert.equal(prior.totalProviderRequests, manifest.priorProviderRequests); assert.equal(prior.inFlightRequests, 0);
  assert.equal(prior.cumulativeReferenceEstimateIncludingOldHeldUsd, manifest.priorConservativeCommittedUsd);
  const priorRequests = prior.totalProviderRequests, priorEstimate = prior.cumulativeReferenceEstimateIncludingOldHeldUsd;
  const auth = offline ? 'offline-native-dummy-not-an-authentication-key' : process.env[manifest.credentialEnv];
  if (!auth?.trim()) throw new Error('The native pair requires its dedicated temporary credential environment; no auth fallback is permitted');
  if (!offline) delete process.env[manifest.credentialEnv];
  let template, templateWorkspace;
  if (!component) {
    const templateBytes = await fs.readFile(path.join(sourceRoot, manifest.payloadTemplate));
    assert.equal(digest(templateBytes), manifest.payloadTemplateSha256);
    template = JSON.parse(templateBytes); templateWorkspace = manifest.templateWorkspace;
  }
  const startedAt = now(), deadlineAt = Math.min(startedAt + limits.wallMs, approvedDeadline);
  if (deadlineAt <= startedAt) throw new Error('The shared native stage deadline has expired');
  if (!offline) await fs.writeFile(path.join(sourceRoot, manifest.launchClaim), JSON.stringify({
    startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadlineAt).toISOString(), outputRoot,
    priorRequests, priorConservativeReferenceUsd: priorEstimate }, null, 2), { flag: 'wx', mode: 0o600 });
  const budget = createProviderRequestBudget({ origin: 'https://open.bigmodel.cn', limits: {
    usd: limits.usd, requests: limits.requests, wallMs: deadlineAt - startedAt,
    inputPerRequest: limits.inputTokens, outputPerRequest: limits.outputTokens,
    totalInput: limits.requests * limits.inputTokens, totalOutput: limits.requests * limits.outputTokens },
    prices: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 }, now });
  const controller = new AbortController(), requests = [], cases = []; let current, activeRequest, dispatches = 0, closed = false;
  const reviewContext = new AsyncLocalStorage(), sessions = new Map(), mockTurns = new Map();
  const skillCareExecutors = new WeakMap();
  function currentTaskBinding(ctx, params) {
    const prepared = ctx.prepared, identity = prepared.request.identity;
    const binding = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')]?.get(params.sessionKey);
    assert(binding && binding.sessionKey === params.sessionKey && binding.sessionId === params.sessionId
      && binding.runId === params.runId && binding.signal && binding.signal === params.abortSignal,
    'Native continuation needs its actual current task binding');
    params.abortSignal.throwIfAborted(); binding.active();
    assert(ctx.role === 'ground-truth-extractor' && prepared.request.reviewScope?.kind === 'baseline'
      && prepared.request.reviewScope.boundedBasis === true && identity?.taskId === ctx.taskId
      && typeof identity.requestId === 'string' && identity.requestId,
    'Native task differs from its actual prepared task identity');
    assert(typeof prepared.requestDirectory === 'string'
      && path.dirname(path.dirname(path.dirname(prepared.requestDirectory)))
        === path.join(current.projectRoot, '.runtime-correction', 'tasks', identity.taskId)
      && prepared.requestPath === path.join(prepared.requestDirectory, 'request.json')
      && params.cwd === path.join(path.dirname(prepared.requestDirectory), 'frozen-source')
      && params.workspaceDir === params.cwd,
    'Native task differs from its actual prepared request paths');
    const prompt = JSON.parse(params.prompt);
    assert(prompt.identity?.requestId === identity.requestId && prompt.identity.taskId === identity.taskId
      && prompt.identity.baselineVersion === identity.baselineVersion,
    'Native task prompt differs from its actual prepared request identity');
    assert.deepEqual(prompt.requiredFiles, prepared.request.requiredFiles,
      'Native task prompt differs from its actual prepared original files');
    return binding;
  }
  function owningContext(sessionId, params) {
    const ambient = reviewContext.getStore(), registered = sessions.get(sessionId), ctx = ambient ?? registered;
    // A fresh same-owner factory preparation may replace a settled baseline
    // job in its persistent project session. Absent that ambient preparation,
    // old closed/cancelled contexts still fail below; no prepared data is lent.
    assert(!ambient || !registered || ambient.owner === registered.owner && ambient.role === registered.role
      && (ambient.prepared === registered.prepared || registered.native?.abortSignal?.aborted),
    'Native session belongs to another reviewer context');
    assert(!closed && ctx?.owner === current && ctx.prepared,
      'Native component session needs its actual prepared owner context');
    controller.signal.throwIfAborted(); current.controller.signal.throwIfAborted();
    assert(now() < deadlineAt, 'Native component owner context expired');
    const bounded = params && (globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')]?.has(params.sessionKey)
      || ctx.prepared.request?.reviewScope?.kind === 'baseline' && ctx.prepared.request.reviewScope.boundedBasis === true);
    if (bounded) {
      assert(params.sessionId === sessionId, 'Native task binding belongs to another session');
      currentTaskBinding(ctx, params);
      // A late native callback cannot become the next invocation merely by
      // retaining its ambient scope. Bare preparation metadata grants no run.
      assert(!ambient?.native || ambient.native.runId === params.runId,
        'Native task callback belongs to another run');
    }
    if (ctx.native) {
      assert(!sessionId || ctx.native.sessionId === sessionId, 'Native component context belongs to another session');
      // completed aborts every bounded host run, including successful ones.
      // Only the genuine next binding can establish a still-live task run;
      // all other callbacks retain the original run's cancellation check.
      if (!bounded) ctx.native.abortSignal?.throwIfAborted();
      assert(ctx.native.deadlineAt == null || now() < ctx.native.deadlineAt, 'Native component session context expired');
    }
    return ctx;
  }
  let queue = Promise.resolve(), queued = 0;
  const timer = setTimeout(() => controller.abort(new Error('BUDGET_WALL_LIMIT')), deadlineAt - startedAt);
  const previousFetch = globalThis.fetch, port = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', previousRuntime = globalThis[port];
  const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
  const originalConnect = net.Socket.prototype.connect, originalLookup = dns.lookup, originalPromiseLookup = dnsPromises.lookup;
  const checkpoint = async () => fs.writeFile(path.join(outputRoot, 'batch-checkpoint.json'), JSON.stringify(metrics(), null, 2));
  const metrics = () => ({ kind: skill ? (offline ? 'offline_native_skill_capture' : 'native_skill_component')
    : document ? (offline ? 'offline_native_document_capture' : 'native_document_component')
    : baseline ? (offline ? 'offline_native_baseline_capture' : 'native_baseline_component')
    : offline ? 'offline_native_pair_batch_qualification' : 'native_stop_pair_batch',
    startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadlineAt).toISOString(), stageDeadline: manifest.stageDeadline,
    limits, queued, budget: budget.snapshot(), cases: cases.map(item => ({ projectRoot: item.projectRoot, requests: item.requests, validatedPayloads: item.validatedPayloads,
      fictionalFiles: [...item.files].map(([file, sha256]) => ({ file, sha256 })),
      generatedBasis: [...item.basis ?? []].map(([file, sha256]) => ({ file, sha256 })),
      ...(skill ? { sourceRevisions: item.sourceRevisions } : {}) })), requests, wireDispatches: dispatches, realProviderRequests: offline ? 0 : dispatches,
    priorProviderRequests: priorRequests, cumulativeProviderRequests: priorRequests + (offline ? 0 : dispatches),
    priorConservativeCommittedUsd: priorEstimate,
    cumulativeConservativeReferenceUsd: priorEstimate + (offline ? 0 : budget.snapshot().estimatedCommittedUsd),
    actualAccountDollarCharges: 'unknown', simulatedUsageIsNotProviderEvidence: offline });
  const guarded = original => createNativeStopProviderFetch({ budget, maxPayloadBytes: limits.payloadBytes,
    inputTokensUpperBound: limits.inputTokens, maxOutputTokens: limits.outputTokens,
    validateRequest(input, init) {
      const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
      if (headers.get('authorization') !== `Bearer ${auth}`) throw new Error('NATIVE_DEDICATED_AUTH_MISMATCH');
    },
    async validatePayload(payload) {
      controller.signal.throwIfAborted(); current?.controller.signal.throwIfAborted();
      if (!current || !component && !current.prepared) throw new Error('NATIVE_CASE_NOT_PREPARED');
      if (current.requests >= limits.perCase) throw Object.assign(new Error('BUDGET_CASE_REQUEST_LIMIT'), { code: 'BUDGET_CASE_REQUEST_LIMIT' });
      assert(!JSON.stringify(payload).includes(auth), 'Authentication must never enter the request body');
      for (const [file, hash] of current.files) assert.equal(digest(await fs.readFile(file)), hash, 'Synthetic source changed');
      current.basis ??= new Map(await Promise.all((current.prepared?.request?.task?.basisFiles ?? []).map(async file => [file, digest(await fs.readFile(file))])));
      for (const [file, hash] of current.basis) assert.equal(digest(await fs.readFile(file)), hash, 'Generated synthetic basis changed');
      // Full RC/host controls and schema must equal the reviewed template;
      // only generated neutral workspace/session identities may differ.
      if (component) {
        const ctx = reviewContext.getStore();
        assert(ctx?.owner === current && ctx.prepared && ctx.native, 'Native component request needs its actual prepared role context');
        assert((skill ? ['ground-truth-extractor', 'skill-reviewer'] : document ? ['ground-truth-extractor', 'artifact-reviewer'] : ['onboarding-extractor', 'onboarding-adjudicator', 'ground-truth-extractor']).includes(ctx.role));
        assert(typeof payload.messages[0]?.content === 'string' && payload.messages[0].content.includes(ctx.native.extraSystemPrompt));
        const text = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n');
        assert(payload.messages.some(message => message.role === 'user' && text(message).replace(/^\[[^\n]*?\] /u, '') === ctx.native.prompt), 'Native component prompt differs from the actual production invocation');
        assert((payload.tools ?? []).every(tool => ctx.native.toolsAllow.includes(tool.function.name)), 'Native component tool escaped its read-only role policy');
        if (document && ctx.role === 'artifact-reviewer') assert((payload.tools ?? []).some(tool => tool.function.name === 'rc_document'), 'Document role lost its actual bound private tool');
        if (skill && !ctx.native.toolsAllow.includes('save_baseline_batch')) assert((payload.tools ?? []).some(tool => tool.function.name === 'rc_skill_care'), 'Skill role lost its actual scoped private tool');
        for (const name of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'MEMORY.md'])
          assert(!(await fs.lstat(path.join(current.projectRoot, name)).catch(() => null)), 'A private bootstrap source appeared in the fictional workspace');
      } else {
        assert.equal(normalizeControl(payload.messages[0], current.projectRoot), normalizeControl(template.messages[0], templateWorkspace));
        assert.equal(normalizeControl(payload.tools, current.projectRoot), normalizeControl(template.tools, templateWorkspace));
        for (const message of payload.messages.filter(message => message.role === 'user')) {
          const text = typeof message.content === 'string' ? message.content : '';
          const parsed = JSON.parse(text.replace(/^\[[^\n]*?\] /u, ''));
          assert.deepEqual(parsed.task, current.prepared.request.task);
          assert([1, 2].includes(parsed.attempt));
        }
      }
      current.validatedPayloads++;
    },
    async onRequest(payload) {
      const request = budget.snapshot().requests;
      current.requests++;
      activeRequest = { request, caseIndex: cases.length, payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
        payloadSha256: digest(Buffer.from(JSON.stringify(payload))), maxTokens: payload.max_tokens,
        inputTokensUpperBound: limits.inputTokens, sourceValidationPassed: true, dedicatedAuthenticationMatches: true, providerUsage: null };
      if (component) Object.assign(activeRequest, { role: reviewContext.getStore().role, runId: reviewContext.getStore().native.runId,
        sessionId: reviewContext.getStore().native.sessionId, requestPath: reviewContext.getStore().prepared.requestPath });
      requests.push(activeRequest);
      await fs.writeFile(path.join(outputRoot, `request-${request}.json`), JSON.stringify(payload, null, 2), { flag: 'wx' });
      await checkpoint();
    },
    async onResponse({ status, bytes }) {
      const text = bytes.toString('utf8'), safe = text.replaceAll(auth, '[REDACTED_CREDENTIAL]');
      await fs.writeFile(path.join(outputRoot, `response-${activeRequest.request}.sse`), safe, { flag: 'wx' });
      Object.assign(activeRequest, { status, responseSourceSha256: digest(bytes), responseStoredSha256: digest(Buffer.from(safe)), credentialRedacted: text !== safe });
      if (status >= 200 && status < 300) {
        try { Object.assign(activeRequest, syntheticOpenAiSseUsage(text)); } catch { activeRequest.usageUnknown = true; }
      } else activeRequest.usageUnknown = true;
    },
    async fetchImpl(input, init) {
      dispatches++;
      if (!offline) return original(input, init);
      if (component) {
        const ctx = reviewContext.getStore(), count = (mockTurns.get(ctx.native.sessionId) ?? 0) + 1;
        mockTurns.set(ctx.native.sessionId, count);
        const first = count === 1;
        const modeSwitch = baseline && count === 2 && ctx.native.toolsAllow.includes('save_baseline_batch');
        const readName = ctx.native.toolsAllow.includes('read') ? 'read' : 'source_read';
        const readPath = readName === 'read' ? ctx.prepared.requestPath
          : (ctx.prepared.request.requiredFiles.find(file => file.startsWith('request-')) ?? ctx.prepared.request.requiredFiles[0]);
        const documentRead = document && ctx.role === 'artifact-reviewer';
        const skillRead = skill && ctx.native.toolsAllow.includes('rc_skill_care');
        const calls = skillRead ? [{ name: 'read', args: { path: ctx.prepared.requestPath } },
          { name: 'rc_skill_care', args: { action: 'inventory' } }, { name: 'rc_skill_care', args: { action: 'read', id: 'skill/SKILL.md' } }]
          : documentRead ? [{ name: 'read', args: { path: ctx.prepared.requestPath } }, { name: 'rc_document', args: { action: 'open' } }]
          : [{ name: readName, args: { path: readPath } }];
        const delta = first ? { role: 'assistant', tool_calls: calls.map(({ name, args }, index) => ({ index, id: `offline-read-${dispatches}-${index}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } })) }
          : modeSwitch ? { role: 'assistant', tool_calls: [{ index: 0, id: `offline-mode-${dispatches}`, type: 'function',
            function: { name: 'save_baseline_batch', arguments: JSON.stringify({ batchId: 1, fullTextReason: 'Offline transport qualification of full-mode schema only; no extracted claims or semantic verdict.' }) } }] }
            : { role: 'assistant', content: 'OFFLINE_CAPTURE_ONLY' };
        const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first || modeSwitch ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`;
        if (!first && !modeSwitch) setTimeout(() => controller.abort(new Error('OFFLINE_NATIVE_CAPTURE_COMPLETE')), 0);
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }
      const first = current.requests === 1;
      const paths = [current.prepared.request.task.basisFiles[0], ...current.files.keys()];
      const delta = first ? { role: 'assistant', tool_calls: paths.map((file, index) => ({ index, id: `offline-pair-${index}`, type: 'function', function: { name: 'source_read', arguments: JSON.stringify({ path: file }) } })) }
        : { role: 'assistant', content: 'OFFLINE_CAPTURE_ONLY' };
      const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`;
      if (!first) setTimeout(() => current.controller.abort(new Error('OFFLINE_NATIVE_CAPTURE_COMPLETE')), 0);
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    } });
  const wrap = original => { const transport = guarded(original); return (...args) => {
    const ctx = reviewContext.getStore();
    const execute = async () => {
      try { return await reviewContext.run(ctx, () => transport(...args)); }
      catch (error) { (error.code === 'BUDGET_CASE_REQUEST_LIMIT' ? current.controller : controller).abort(error); throw error; }
      finally { await checkpoint(); }
    };
    if (!component) return execute();
    // Default onboarding has independent parallel reviewers. Serialize only
    // this experiment's HTTP admission, preserving each owning async context.
    queued++;
    const job = queue.then(execute).finally(() => { queued--; }); queue = job.catch(() => {}); return job;
  }; };
  globalThis.fetch = wrap(previousFetch); globalThis[port] = { ...undici, fetch: wrap(undici.fetch) };
  if (offline) {
    net.Socket.prototype.connect = function () { throw new Error('OFFLINE_NATIVE_SOCKET_DENIED'); };
    dns.lookup = (_name, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      queueMicrotask(() => options?.all ? callback(null, [{ address: '93.184.216.34', family: 4 }]) : callback(null, '93.184.216.34', 4));
    };
    dnsPromises.lookup = async (_name, options) => options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
    syncBuiltinESMExports();
  }
  return { kind: skill ? 'metered_native_skill_batch' : document ? 'metered_native_document_batch' : baseline ? 'metered_native_baseline_batch' : 'metered_native_stop_batch', signal: controller.signal,
    credential: () => auth, metrics,
    scopeReview(input, callback) { return reviewContext.run({ role: input.role, taskId: input.taskId, owner: current }, callback); },
    reviewRole(sessionId, params) { return owningContext(sessionId, params).role; },
    prepared(value) { const ctx = reviewContext.getStore(); assert(ctx); ctx.prepared = value; },
    async runNative(params, callback) {
      const parent = owningContext(params.sessionId, params); params.abortSignal?.throwIfAborted();
      assert(sessions.get(params.sessionId)?.native?.settled !== false, 'Native task invocation is not settled');
      const requestedDeadline = Number.isFinite(params.runTimeoutOverrideMs) ? now() + params.runTimeoutOverrideMs : Infinity;
      const inheritedDeadline = parent.native?.deadlineAt ?? Infinity;
      const effectiveDeadline = Math.min(requestedDeadline, inheritedDeadline);
      const ctx = { ...parent, native: { runId: params.runId, sessionId: params.sessionId, prompt: params.prompt,
        extraSystemPrompt: params.extraSystemPrompt, toolsAllow: params.toolsAllow, abortSignal: params.abortSignal,
        deadlineAt: effectiveDeadline === Infinity ? null : effectiveDeadline,
        settled: false } };
      if (skill && params.toolsAllow.includes('rc_skill_care')) {
        const progress = currentReviewerProgress(params), care = progress?.skillCare;
        assert(care && progress.role === ctx.role && progress.sessionId === params.sessionId, 'Skill care needs its actual owning reviewer scope');
        if (!skillCareExecutors.has(care)) skillCareExecutors.set(care, care.execute.bind(care));
        const execute = skillCareExecutors.get(care);
        care.execute = async args => {
          const active = reviewContext.getStore();
          assert(active?.owner === current && active.native.runId === params.runId && active.native.sessionId === params.sessionId,
            'Skill care belongs to another native session/run');
          return execute(args);
        };
      }
      sessions.set(params.sessionId, ctx);
      try { return await reviewContext.run(ctx, callback); }
      finally { ctx.native.settled = true; }
    },
    async beginCase({ projectRoot, contract, files, appendOnlyFiles = [] }) {
      controller.signal.throwIfAborted();
      if (now() >= deadlineAt || cases.length >= (skill ? 3 : 2) || queued || budget.snapshot().inFlightRequests) throw new Error('Native batch cannot begin another case');
      assert(!appendOnlyFiles.length || skill && appendOnlyFiles.length === 1, 'Only the Skill component admits one append-only controlled transcript');
      current = { projectRoot, controller: new AbortController(), requests: 0, validatedPayloads: 0,
        files: new Map(await Promise.all((files ?? [path.join(projectRoot, 'app.mjs'), contract]).map(async file => {
          if (component) assert(file.startsWith(projectRoot + path.sep));
          return [file, digest(await fs.readFile(file))];
        }))), transcriptHeads: new Map(), sourceRevisions: [] };
      for (const file of appendOnlyFiles) {
        assert(current.files.has(file) && path.basename(file) === 'conversation.jsonl');
        current.transcriptHeads.set(file, await fs.readFile(file));
      }
      cases.push(current);
      return { signal: AbortSignal.any([controller.signal, current.controller.signal]), onPrepared(value) { current.prepared = value; } };
    },
    async advanceTranscript({ path: file, stage }) {
      controller.signal.throwIfAborted(); current?.controller.signal.throwIfAborted();
      assert(skill && current && !queued && !budget.snapshot().inFlightRequests && now() < deadlineAt, 'Transcript may advance only between settled Skill phases');
      const before = current.transcriptHeads.get(file), next = await fs.readFile(file);
      assert(before && next.length > before.length && next.length <= 1048576 && next.subarray(0, before.length).equals(before), 'Skill history must append to the exact original prefix');
      const added = next.subarray(before.length).toString('utf8');
      assert(Buffer.from(added).equals(next.subarray(before.length)) && added.endsWith('\n') && !added.includes('\0'));
      for (const line of added.trimEnd().split('\n')) {
        const entry = JSON.parse(line), content = entry.message?.content;
        assert(entry.actor === 'controlled-component-driver');
        assert(entry.type === 'assistant' && (typeof content === 'string' || Array.isArray(content) && content.every(block => block.type === 'tool_use' && typeof block.id === 'string'))
          || entry.type === 'user' && entry.isMeta === true && Array.isArray(content) && content.every(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string'),
        'Only explicitly attributed controlled tool history/completion may append; new user authority is forbidden');
      }
      const sha256 = digest(next);
      current.sourceRevisions.push({ file, stage, previousSha256: digest(before), sha256, previousBytes: before.length, bytes: next.length });
      current.transcriptHeads.set(file, next); current.files.set(file, sha256); await checkpoint();
    },
    async close() {
      await queue;
      clearTimeout(timer);
      await checkpoint();
      if (budget.snapshot().inFlightRequests) throw new Error('Native provider remains in flight; keep guard installed');
      closed = true; sessions.clear();
      globalThis.fetch = previousFetch;
      if (previousRuntime === undefined) delete globalThis[port]; else globalThis[port] = previousRuntime;
      if (offline) { net.Socket.prototype.connect = originalConnect; dns.lookup = originalLookup; dnsPromises.lookup = originalPromiseLookup; syncBuiltinESMExports(); }
      await fs.writeFile(path.join(outputRoot, 'batch-result.json'), JSON.stringify(metrics(), null, 2));
    } };
}

// Development data isolation, not a restriction or optimization of RC itself.
// Bindings are the same session-scoped objects used by the installed plugin.
export async function fenceNativeStopTools(params, { projectRoot, externalFiles = [] }) {
  const roots = [await fs.realpath(projectRoot)];
  const originals = new Set(await Promise.all(externalFiles.map(file => fs.realpath(file))));
  const inside = (root, file) => file === root || file.startsWith(root + path.sep);
  const allowed = file => roots.some(root => inside(root, file)) || originals.has(file);
  const reject = () => { throw Object.assign(new Error('NATIVE_FIXTURE_PATH_DENIED'), { code: 'NATIVE_FIXTURE_PATH_DENIED' }); };
  const check = async file => {
    if (!allowed(file)) reject();
    // Reject every link in the selected path, including a link within a toy.
    let cursor = file;
    while (roots.some(root => inside(root, cursor)) || originals.has(cursor)) {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) reject();
      if (roots.includes(cursor) || originals.has(cursor)) break;
      cursor = path.dirname(cursor);
    }
    if (!allowed(await fs.realpath(file))) reject();
  };
  const tree = async directory => {
    await check(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) reject();
      if (entry.isDirectory()) await tree(file);
    }
  };
  const binding = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')]?.get(params.sessionKey);
  if (!binding || binding.sessionId !== params.sessionId) throw new Error('Native fixture fence needs the actual owning task binding');
  binding.tools = binding.tools.map(tool => ({ ...tool, async execute(id, args, signal) {
    if (/^source_(?:read|grep|find|ls)$/u.test(tool.name)) {
      const selected = path.resolve(params.cwd ?? projectRoot, args.path ?? '.');
      await check(selected);
      if (tool.name !== 'source_read' && (await fs.stat(selected)).isDirectory()) await tree(selected);
    }
    return tool.execute(id, args, signal);
  } }));
}

export async function prepareNativeEvaluationTools(params, { fixtureFence, baseline = false, document = false, skill = false, role, batch }) {
  const bounded = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')]?.has(params.sessionKey);
  // Stop always needs its owning task binding. Only the baseline factory's
  // unbounded reader roles may use the host's workspace-only read tool.
  if (fixtureFence && (bounded || !(baseline || document || skill))) await fenceNativeStopTools(params, fixtureFence);
  if (!(baseline || document || skill)) return params;
  role ??= batch?.reviewRole?.(params.sessionId, params);
  const toolsAllow = ['read'];
  if (document && !bounded && role === 'artifact-reviewer') {
    const binding = globalThis[Symbol.for('runtime-corrector.document-tools.v1')]?.get(params.sessionId);
    assert(binding && binding.runId === params.runId && binding.tools?.tool?.name === 'rc_document', 'Document component needs its actual owning document-tool binding');
    binding.active(); toolsAllow.push('rc_document');
  }
  if (skill && !bounded) {
    const progress = currentReviewerProgress(params);
    assert(progress?.skillCare && progress.sessionId === params.sessionId && progress.role === role, 'Skill component needs its actual owning reviewer/Skill-care scope');
    toolsAllow.push('rc_skill_care');
  }
  return { ...params, skillsSnapshot: { prompt: '', skills: [] },
    ...(!bounded ? { toolsAllow, disableMessageTool: true, requireExplicitMessageTarget: true,
      config: { ...params.config, tools: { ...params.config?.tools, fs: { ...params.config?.tools?.fs, workspaceOnly: true } } } } : {}) };
}

// Actual native fetch boundary, shared by offline qualification and a later
// explicitly frozen batch. No SDK retry or compaction can bypass admission.
export function createNativeStopProviderFetch({ fetchImpl, budget, maxPayloadBytes, inputTokensUpperBound,
  maxOutputTokens = 32768, validateRequest = () => {}, validatePayload = async () => {}, onRequest = async () => {}, onResponse = async () => {} }) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href !== 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
      || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('NATIVE_PROVIDER_REQUEST_DENIED');
    validateRequest(input, init);
    const payload = JSON.parse(init.body);
    // Remove only the host's personal machine label from the Runtime line.
    // Preserve RC controls, obligations, tool arguments and evidence verbatim.
    for (const message of payload.messages ?? []) if (message.role === 'system' && typeof message.content === 'string')
      message.content = message.content.replace(/(\nRuntime: [^\n]*?\| host=)[^|\n]+(?= \| repo=)/gu, '$1fixture-host');
    const wireBody = JSON.stringify(payload);
    if (payload.model !== 'glm-5.3' || payload.stream !== true || payload.stream_options?.include_usage !== true
      || Object.hasOwn(payload, 'max_completion_tokens') || payload.max_tokens !== maxOutputTokens
      || Buffer.byteLength(wireBody) > maxPayloadBytes) throw new Error('NATIVE_PROVIDER_ENVELOPE_DENIED');
    await validatePayload(payload);
    return budget.run({ origin: url.origin, inputTokensUpperBound, maxOutputTokens }, async ({ signal }) => {
      await onRequest(payload);
      const response = await fetchImpl(input, { ...init, body: wireBody, redirect: 'manual',
        signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('Native response exceeds 4 MiB');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      await onResponse({ status: response.status, bytes });
      if (!response.ok) throw Object.assign(new Error('BUDGET_USAGE_UNKNOWN'), { code: 'BUDGET_USAGE_UNKNOWN' });
      const parsed = syntheticOpenAiSseUsage(bytes.toString('utf8'));
      return { value: new Response(bytes, { status: response.status, headers: response.headers }), usage: parsed.usage };
    });
  };
}

export async function installNativeStopCapture({ hostRoot, directory, projectRoot, externalFiles }) {
  await fs.mkdir(directory, { recursive: true });
  const controller = new AbortController(), payloads = [], responses = [];
  let prepared, socketAttempts = 0;
  const budget = createProviderRequestBudget({ origin: 'https://open.bigmodel.cn',
    limits: { usd: 4, requests: 2, wallMs: 90000, inputPerRequest: 128000, outputPerRequest: 32768,
      totalInput: 256000, totalOutput: 65536 }, prices: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 } });
  const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect,
    originalLookup = dns.lookup, originalPromiseLookup = dnsPromises.lookup;
  const port = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', previousRuntime = globalThis[port];
  const captureFetch = createNativeStopProviderFetch({ budget, maxPayloadBytes: 1024 * 1024, inputTokensUpperBound: 128000,
    async onRequest(payload) {
      payloads.push(payload);
      await fs.writeFile(path.join(directory, `request-${payloads.length}.json`), JSON.stringify(payload, null, 2), { flag: 'wx' });
    },
    async onResponse({ status, bytes }) { responses.push({ status, bytes: bytes.length }); },
    async fetchImpl() {
      const first = payloads.length === 1;
      if (!prepared?.request?.task?.basisFiles?.length) throw new Error('Production Stop basis was not prepared');
      const calls = [prepared.request.task.basisFiles[0], path.join(projectRoot, 'app.mjs'), ...externalFiles]
        .map((file, index) => ({ index, id: `offline-native-read-${index + 1}`, type: 'function',
          function: { name: 'source_read', arguments: JSON.stringify({ path: file }) } }));
      const event = delta => `data: ${JSON.stringify({ id: 'offline-native', object: 'chat.completion.chunk', model: 'glm-5.3',
        choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
      const body = event({ role: 'assistant', ...(first ? { tool_calls: calls } : { content: 'OFFLINE_CAPTURE_ONLY' }) })
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`;
      if (!first) setTimeout(() => controller.abort(new Error('OFFLINE_NATIVE_CAPTURE_COMPLETE')), 0);
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
  globalThis.fetch = captureFetch;
  const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
  globalThis[port] = { ...undici, fetch: captureFetch };
  net.Socket.prototype.connect = function () { socketAttempts++; throw new Error('OFFLINE_NATIVE_SOCKET_DENIED'); };
  dns.lookup = (_name, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => options?.all ? callback(null, [{ address: '93.184.216.34', family: 4 }]) : callback(null, '93.184.216.34', 4));
  };
  dnsPromises.lookup = async (_name, options) => options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
  syncBuiltinESMExports();
  return { signal: controller.signal, onPrepared(value) { prepared = value; },
    metrics: () => ({ kind: 'offline_production_native_capture', realProviderRequests: 0, socketAttempts,
      payloadCount: payloads.length, payloadBytes: payloads.map(payload => Buffer.byteLength(JSON.stringify(payload))),
      toolResultsInFollowup: payloads[1]?.messages.filter(message => message.role === 'tool') ?? [],
      toolNames: payloads[0]?.tools.map(tool => tool.function.name) ?? [], responses,
      simulatedBudget: budget.snapshot(), semanticVerdict: null }),
    async close() {
      controller.abort(); globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect;
      if (previousRuntime === undefined) delete globalThis[port]; else globalThis[port] = previousRuntime;
      dns.lookup = originalLookup; dnsPromises.lookup = originalPromiseLookup; syncBuiltinESMExports();
    } };
}

export async function createNativeStopEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, legacy = false, traceTransport = false,
  provider: selectedProvider, stateRoot, capture, fixtureFence, batch, providerCredential }) {
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.7.1-2') throw new Error('The native live probe requires installed OpenClaw 2026.7.1-2.');
  const coding = selectedProvider?.api === 'openai-completions';
  if (selectedProvider && (!coding || selectedProvider.baseUrl !== 'https://open.bigmodel.cn/api/coding/paas/v4'
    || selectedProvider.model !== 'glm-5.3' || !/^[A-Z][A-Z0-9_]*$/u.test(selectedProvider.credentialEnv ?? '')))
    throw new Error('Unapproved explicit native provider configuration');
  const component = ['metered_native_baseline_batch', 'metered_native_document_batch', 'metered_native_skill_batch'].includes(batch?.kind);
  if (coding && !capture && !['metered_native_stop_batch', 'metered_native_baseline_batch', 'metered_native_document_batch', 'metered_native_skill_batch'].includes(batch?.kind)) throw new Error('Native Coding Plan dispatch needs a separately frozen batch');
  const providerWallMs = coding && batch ? batch.metrics().limits.wallMs : null;
  if (providerWallMs !== null && (!Number.isSafeInteger(providerWallMs) || providerWallMs < 1000 || providerWallMs > 3600000))
    throw new Error('Native provider policy requires the existing finite batch wall limit');
  if (!coding && (!process.env.ANTHROPIC_AUTH_TOKEN || !process.env.ANTHROPIC_BASE_URL)) throw new Error('The native live probe requires the existing Anthropic-compatible provider environment.');
  const credential = coding ? providerCredential ?? process.env[selectedProvider.credentialEnv] : process.env.ANTHROPIC_AUTH_TOKEN;
  if (!credential) throw new Error('Missing explicit native provider credential environment');
  const providerId = coding ? 'evaluation' : 'anthropic';
  const model = coding ? selectedProvider.model : process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error('Set RC_EVAL_NATIVE_MODEL or ANTHROPIC_MODEL for the native live probe.');
  const root = stateRoot ?? path.join(outputRoot, 'native-host');
  await fs.mkdir(root, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = path.join(root, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'config.json');
  // The provider reads this in memory. No key enters the saved config or build.
  if (!coding) process.env.ANTHROPIC_API_KEY = credential;
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs');
  const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(root, 'build') });
  const config = { logging: { level: 'warn', consoleLevel: 'silent', file: path.join(root, 'host.log') },
    agents: { defaults: { workspace: projectRoot, model: { primary: `${providerId}/${model}` }, sandbox: { mode: 'off' } },
      list: [{ id: 'main', agentDir: path.join(root, 'agent') }] },
    session: { store: path.join(root, 'sessions.json') },
    models: { mode: 'replace', providers: { [providerId]: { api: coding ? selectedProvider.api : 'anthropic-messages',
      baseUrl: coding ? selectedProvider.baseUrl : process.env.ANTHROPIC_BASE_URL,
      ...(providerWallMs !== null ? { timeoutSeconds: Math.floor(providerWallMs / 1000) } : {}),
      ...(coding ? { apiKey: '${' + selectedProvider.credentialEnv + '}' } : {}),
      models: [{ id: model, name: model, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 32768,
        ...(coding ? { cost: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 },
          compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens', supportsStore: false,
            supportsDeveloperRole: false, supportsReasoningEffort: false } } : {}) }] } } },
    plugins: { enabled: true, allow: ['runtime-corrector'], load: { paths: [pluginRoot] },
      entries: { 'runtime-corrector': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } } };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
  // Resolved only in this process; the saved profile contains the env name.
  if (coding) config.models.providers[providerId].apiKey = credential;
  const timing = traceTransport ? await installProviderFetchTiming({ file: path.join(root, 'provider-fetch-timing.jsonl'),
    origin: new URL(process.env.ANTHROPIC_BASE_URL).origin }) : null;
  try {
  const load = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
  const { createPluginRuntime } = await load('dist/plugins/runtime/index.js');
  const { s: loadPlugins } = await load('dist/loader-D8d2EvVh.js');
  const registry = loadPlugins({ config, workspaceDir: projectRoot, activate: true, onlyPluginIds: ['runtime-corrector'] });
  const plugin = registry.plugins.find(item => item.id === 'runtime-corrector');
  if (plugin?.status !== 'loaded' || !registry.tools.some(item => item.pluginId === plugin.id))
    throw new Error(`Native plugin/tool registration failed: ${JSON.stringify(registry.diagnostics)}`);
  const runtime = createPluginRuntime(); runtime.config.current = () => config;
  const starts = [], ends = []; let businessInvocations = 0, reviewInvocations = 0;
  const legacyTask = legacy ? (await import('../../test/compat/legacy-stop-task-runtime.mjs')).runOpenClawStopTask : null;
  const createReviewerFactory = ['metered_native_document_batch', 'metered_native_skill_batch'].includes(batch?.kind)
    ? (await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/reviewer.mjs')).href)).createOpenClawReviewerFactory
    : createOpenClawReviewerFactory;
  const factory = createReviewerFactory({ runtime, config, logger: { warn() {} } }, {
    ...(fixtureFence || component ? { runEmbeddedAgent: async params => {
      params = await prepareNativeEvaluationTools(params, { fixtureFence, baseline: batch?.kind === 'metered_native_baseline_batch',
        document: batch?.kind === 'metered_native_document_batch', skill: batch?.kind === 'metered_native_skill_batch', batch });
      if (component) {
        return batch.runNative(params, () => runtime.agent.runEmbeddedAgent(params));
      }
      return runtime.agent.runEmbeddedAgent(params);
    } } : {}),
    ...(legacyTask ? { runStopTask: legacyTask } : {}),
    pluginRoot, onRunStart: id => { starts.push(id); }, onRunEnd: id => { ends.push(id); },
  });
  if (legacyTask) factory.supportsStopGroups = true;
  const invokeReview = async (input, handoff = false) => {
    timing?.setPhase(`review:${++reviewInvocations}`);
    const { reviewerRuntime, ...native } = input;
    const { maxBudgetUsd, ...reviewer } = native.reviewer ?? {};
    const observation = capture ?? (component ? batch : null);
    const invoke = () => (handoff ? factory.handoff : factory)({ ...native, reviewer: { ...reviewer, model: `${providerId}/${model}` }, hostAdapter, pluginRoot,
      ...(observation ? { abortSignal: native.abortSignal ? AbortSignal.any([native.abortSignal, observation.signal]) : observation.signal,
        onPrepared: async value => { if (capture) capture.onPrepared(value); else batch.prepared(value); await native.onPrepared?.(value); } } : {}),
      excludedEvidencePaths: [...native.excludedEvidencePaths ?? [], root] });
    return component ? batch.scopeReview(native, invoke) : invoke();
  };
  const run = Object.assign(input => invokeReview(input), factory);
  if (component) run.handoff = input => invokeReview(input, true);
  return { model, modelRef: `${providerId}/${model}`, pluginRoot, run, async close() {
    if (batch?.kind === 'metered_native_document_batch') await (await import('../../lib/document-session.mjs')).releaseDocumentSessions(projectRoot);
    await timing?.close();
  }, async repair({ requirement, feedback, file }) {
    if (coding) throw new Error('Coding Plan calibration is judgment-only; repair is not qualified');
    timing?.setPhase('business-repair');
    const sessionId = randomUUID(), runId = randomUUID(), transcript = path.join(root, `repair-${sessionId}.jsonl`);
    businessInvocations++;
    const result = await runtime.agent.runEmbeddedAgent({ sessionId, sessionKey: `agent:main:evaluation-business:${sessionId}`, agentId: 'main',
      runId, sessionFile: transcript, workspaceDir: projectRoot, cwd: projectRoot, agentDir: path.join(root, 'agent'), config,
      provider: 'anthropic', model, agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [], trigger: 'manual',
      timeoutMs: 180000, runTimeoutOverrideMs: 180000, abortSignal: AbortSignal.timeout(180000),
      toolsAllow: ['read', 'write', 'edit'], disableMessageTool: true, requireExplicitMessageTarget: true,
      skillsSnapshot: { prompt: '', skills: [] }, bootstrapContextMode: 'lightweight', promptMode: 'minimal', thinkLevel: 'low', suppressLiveStreamOutput: true,
      extraSystemPrompt: 'You are repairing a controlled local acceptance fixture. Modify only the named delivery file. Inspect the original external contract if required. Do not send messages or spawn agents. End with a concise completion statement.',
      prompt: `Original requirement:\n${requirement}\n\nNamed delivery file:\n${file}\n\nThe review found this deviation:\n${feedback}\n\nInspect the evidence and repair the named file to satisfy the original requirement.` });
    if (result.meta?.aborted) throw new Error('The business repair did not complete.');
    const entries = (await readOpenClawTranscript(transcript)).map(entry => entry.type === 'user' ? { ...entry, isMeta: true } : entry);
    if (!entries.some(entry => entry.type === 'assistant' && entry.message.content.some(block => block.type === 'tool_use' && /write|edit/iu.test(block.name))))
      throw new Error('The real business model did not issue a write/edit tool call.');
    return { entries, transcript, runId, sessionId };
  }, metrics: () => ({ kind: 'installed-native', hostVersion: pkg.version, actualModels: [model],
    nativeInvocations: starts.length, settledInvocations: ends.length, businessInvocations, hostRoot, isolatedState: root,
    ...(timing ? { fetchTiming: timing.requestCount ? timing.file : null, fetchRequestsObserved: timing.requestCount } : {}) }) };
  } catch (error) { await timing?.close(); throw error; }
}
