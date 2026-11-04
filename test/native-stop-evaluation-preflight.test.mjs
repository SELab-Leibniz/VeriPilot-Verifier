import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fenceNativeStopTools, prepareNativeEvaluationTools, createNativeStopProviderFetch, installNativeStopBatch, installNativeBaselineBatch, validateNativeStopBatchLimits, createNativeStopEvaluation } from '../scripts/helpers/native-stop-evaluation.mjs';
import { createProviderRequestBudget } from '../scripts/helpers/provider-request-budget.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { bindTaskTools, registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import { fileSymlinkSkipReason } from './helpers/file-symlink-capability.mjs';

test('custom standalone baseline models retain explicit provider, model and finite dispatch boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-provider-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.7.1-2' }));
  const provider = { api: 'openai-completions', baseUrl: 'https://provider.example.invalid/v1',
    model: 'configured-custom-model', credentialEnv: 'RC_CONTROLLED_UNIT_KEY' };
  await assert.rejects(createNativeStopEvaluation({ hostRoot: root, provider }), /Unapproved explicit native provider/);
  for (const invalid of [
    { ...provider, baseUrl: 'file:///private' },
    { ...provider, baseUrl: 'https://user:secret@provider.example.invalid/v1' },
    { ...provider, modelSettings: { id: 'different-model' } },
    { ...provider, credentialEnv: 'not an environment variable' },
  ]) await assert.rejects(createNativeStopEvaluation({ hostRoot: root, standaloneBaseline: true, provider: invalid }),
    /Unapproved explicit native provider/);
  await assert.rejects(createNativeStopEvaluation({ hostRoot: root, standaloneBaseline: true, provider }),
    /explicitly bounded standalone baseline/);
  assert.deepEqual((await fs.readdir(root)).sort(), ['package.json'], 'No profile, source build, auth lookup or model dispatch before admission');
});

test('native fixture fence permits generated basis and the exact external contract; denies parent/profile and links before read', { skip: await fileSymlinkSkipReason() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-data-'));
  const projectRoot = path.join(root, 'project'), contract = path.join(root, 'contract.md');
  await fs.mkdir(path.join(projectRoot, 'basis'), { recursive: true });
  await fs.writeFile(contract, 'fictional original');
  await fs.writeFile(path.join(projectRoot, 'basis/one.txt'), 'generated fictional basis');
  await fs.writeFile(path.join(root, 'profile.json'), 'unexposed profile');
  const key = Symbol.for('runtime-corrector.openclaw.task-tools.v1');
  const bindings = globalThis[key] ??= new Map(); let reads = 0;
  const binding = { sessionId: 'neutral', tools: ['source_read', 'source_find'].map(name => ({ name, async execute() { reads++; return 'ok'; } })) };
  bindings.set('neutral-key', binding);
  try {
    await fenceNativeStopTools({ sessionId: 'neutral', sessionKey: 'neutral-key' }, { projectRoot, externalFiles: [contract] });
    const read = binding.tools[0], find = binding.tools[1];
    assert.equal(await read.execute('1', { path: contract }), 'ok');
    assert.equal(await read.execute('2', { path: 'basis/one.txt' }), 'ok');
    for (const file of ['..', '../profile.json', '/etc/passwd'])
      await assert.rejects(read.execute('3', { path: file }), /NATIVE_FIXTURE_PATH_DENIED/u);
    assert.equal(reads, 2);
    await fs.symlink(contract, path.join(projectRoot, 'linked.md'));
    await assert.rejects(read.execute('4', { path: 'linked.md' }), /NATIVE_FIXTURE_PATH_DENIED/u);
    await assert.rejects(find.execute('5', { path: '.', pattern: 'x' }), /NATIVE_FIXTURE_PATH_DENIED/u);
    assert.equal(reads, 2);
  } finally { bindings.delete('neutral-key'); await fs.rm(root, { recursive: true, force: true }); }
});

test('audit fixture resolves captured sources separately from its intentionally empty workspace', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-audit-source-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = path.join(root, 'private-request'), cwd = path.join(request, 'empty-workspace');
  const sourceRoot = path.join(request, 'coverage-source');
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'original-source-0000-0000.txt'), 'Original task requirement.');
  const key = 'isolated-audit-path-key', bindings = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')];
  let calls = 0;
  const binding = { sessionId: 'isolated-audit-path', tools: [
    { name: 'source_read', execute: async () => { calls++; return 'actual bound source tool'; } },
    { name: 'commit_baseline_inventory' }, { name: 'finish_baseline_audit' },
  ] };
  bindings.set(key, binding); t.after(() => bindings.delete(key));
  const params = { sessionId: binding.sessionId, sessionKey: key, cwd, sessionFile: path.join(request, 'session.jsonl') };
  await prepareNativeEvaluationTools(params, { fixtureFence: { projectRoot: root } });
  assert.equal(await binding.tools[0].execute('read-original', { path: 'original-source-0000-0000.txt' }), 'actual bound source tool');
  assert.equal(calls, 1);
  await assert.rejects(binding.tools[0].execute('outside', { path: '/etc/passwd' }), /NATIVE_FIXTURE_PATH_DENIED/u);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(cwd), [], 'The auditor workspace remains empty.');
});

const budget = () => createProviderRequestBudget({ origin: 'https://open.bigmodel.cn',
  limits: { usd: 4, requests: 2, wallMs: 10000, inputPerRequest: 131072, outputPerRequest: 32768,
    totalInput: 262144, totalOutput: 65536 }, prices: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 } });
const payload = () => ({ model: 'glm-5.3', stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
  messages: [{ role: 'system', content: '\nRuntime: agent=main | host=personal-label | repo=/fiction/project | os=macOS\nRC controls unchanged' }] });
const endpoint = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const init = body => ({ method: 'POST', body: JSON.stringify(body) });
const sse = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\ndata: [DONE]\n\n';

test('native fetch admission preserves production cap, neutralizes machine label and counts every native request', async () => {
  const ledger = budget(); let calls = 0;
  const guarded = createNativeStopProviderFetch({ budget: ledger, inputTokensUpperBound: 65536, maxPayloadBytes: 57344,
    async fetchImpl(_url, options) {
      calls++; assert.equal(options.redirect, 'manual');
      const sent = JSON.parse(options.body);
      assert.equal(sent.max_tokens, 32768);
      assert.match(sent.messages[0].content, /host=fixture-host \| repo=/u);
      assert(!options.body.includes('personal-label')); assert(options.body.includes('RC controls unchanged'));
      return new Response(sse);
    } });
  await guarded(endpoint, init(payload())); await guarded(endpoint, init(payload()));
  await assert.rejects(guarded(endpoint, init(payload())), /BUDGET_REQUEST_LIMIT/u);
  assert.equal(calls, 2); assert.equal(ledger.snapshot().requests, 2);
  assert.equal(ledger.snapshot().committedInputTokens, 14); assert.equal(ledger.snapshot().inFlightRequests, 0);
});

test('native retries cannot dispatch after unknown usage; reservations stay held', async () => {
  const ledger = budget(); let calls = 0;
  const guarded = createNativeStopProviderFetch({ budget: ledger, inputTokensUpperBound: 65536, maxPayloadBytes: 57344,
    async fetchImpl() { calls++; return new Response('data: [DONE]\n\n'); } });
  await assert.rejects(guarded(endpoint, init(payload())), /BUDGET_USAGE_UNKNOWN/u);
  await assert.rejects(guarded(endpoint, init(payload())), /BUDGET_USAGE_UNKNOWN/u);
  assert.equal(calls, 1); assert.equal(ledger.snapshot().requests, 1);
  assert.equal(ledger.snapshot().estimatedCommittedUsd, 1.179648);
});

test('native fetch rejects other routes, wrong output caps and oversized complete native bodies before dispatch', async () => {
  const ledger = budget(); let calls = 0;
  const guarded = createNativeStopProviderFetch({ budget: ledger, inputTokensUpperBound: 65536, maxPayloadBytes: 57344,
    async fetchImpl() { calls++; return new Response(sse); } });
  await assert.rejects(guarded(endpoint.replace('/coding', ''), init(payload())), /NATIVE_PROVIDER_REQUEST_DENIED/u);
  await assert.rejects(guarded(endpoint, init({ ...payload(), max_tokens: 8192 })), /NATIVE_PROVIDER_ENVELOPE_DENIED/u);
  await assert.rejects(guarded(endpoint, init({ ...payload(), padding: 'x'.repeat(57344) })), /NATIVE_PROVIDER_ENVELOPE_DENIED/u);
  assert.equal(calls, 0); assert.equal(ledger.snapshot().requests, 0);
});

test('64 KiB native envelope admits a necessary larger follow-up, retains a 128 Ki input reserve and rejects overflow', async () => {
  const ledger = budget(); let calls = 0;
  const guarded = createNativeStopProviderFetch({ budget: ledger, inputTokensUpperBound: 131072, maxPayloadBytes: 65536,
    async fetchImpl(_input, options) {
      calls++; assert(Buffer.byteLength(options.body) > 57344); assert(Buffer.byteLength(options.body) <= 65536);
      return new Response('data: [DONE]\n\n');
    } });
  const larger = { ...payload(), messages: [{ role: 'user', content: 'x'.repeat(58000) }] };
  await assert.rejects(guarded(endpoint, init(larger)), /BUDGET_USAGE_UNKNOWN/u);
  assert.equal(ledger.snapshot().committedInputTokens, 131072);
  assert.equal(ledger.snapshot().estimatedCommittedUsd, 1.6384);
  await assert.rejects(guarded(endpoint, init(larger)), /BUDGET_USAGE_UNKNOWN/u);
  await assert.rejects(guarded(endpoint, init({ ...larger, padding: 'x'.repeat(10000) })), /NATIVE_PROVIDER_ENVELOPE_DENIED/u);
  assert.equal(calls, 1); assert.equal(ledger.snapshot().requests, 1);
});

test('two native cases share one ledger, one deadline and a one-shot launch claim', { skip: !existsSync('/opt/homebrew/lib/node_modules/openclaw/package.json') }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-batch-'));
  const previousFetch = globalThis.fetch, previousKey = process.env.RC_NATIVE_STOP_API_KEY;
  let batch, calls = 0;
  try {
    const template = payload(); template.tools = []; template.messages[0].content = 'Fixed controls, /fixture/reference';
    await fs.writeFile(path.join(root, 'template.json'), JSON.stringify(template));
    await fs.writeFile(path.join(root, 'prior.json'), JSON.stringify({ totalProviderRequests: 17, inFlightRequests: 0, cumulativeReferenceEstimateIncludingOldHeldUsd: 1.25 }));
    const manifest = { kind: 'native-stop-pair-batch-v1', stageDeadline: '2026-11-03T15:21:55Z', credentialEnv: 'RC_NATIVE_STOP_API_KEY',
      priorProviderRequests: 17, priorConservativeCommittedUsd: 1.25,
      limits: { requests: 4, perCase: 2, wallMs: 720000, inputTokens: 262144, payloadBytes: 131072, outputTokens: 32768, usd: 64 },
      sourceHashes: {}, hostHashes: {}, priorSettlement: 'prior.json', payloadTemplate: 'template.json',
      payloadTemplateSha256: createHash('sha256').update(JSON.stringify(template)).digest('hex'), templateWorkspace: '/fixture/reference', launchClaim: 'claim.json' };
    process.env.RC_NATIVE_STOP_API_KEY = 'new-test-dummy-never-a-real-key';
    globalThis.fetch = async (_input, options) => {
      calls++; assert(Buffer.byteLength(options.body) > 65536); assert(Buffer.byteLength(options.body) <= manifest.limits.payloadBytes);
      assert.equal(batch.metrics().requests.at(-1).inputTokensUpperBound, manifest.limits.inputTokens);
      return new Response(sse);
    };
    const now = () => Date.parse('2026-11-03T14:00:00Z');
    batch = await installNativeStopBatch({ hostRoot: '/opt/homebrew/lib/node_modules/openclaw', sourceRoot: root, outputRoot: root, manifest, now });
    assert.equal(process.env.RC_NATIVE_STOP_API_KEY, undefined);
    for (let index = 0; index < 2; index++) {
      const projectRoot = path.join(root, `sample-${index}`), contract = path.join(root, `contract-${index}.md`);
      await fs.mkdir(projectRoot); await fs.writeFile(path.join(projectRoot, 'app.mjs'), 'fictional'); await fs.writeFile(contract, 'original fictional');
      const scope = await batch.beginCase({ projectRoot, contract }), task = { workspace: projectRoot, syntheticNotes: 'x'.repeat(70000) };
      scope.onPrepared({ request: { task } });
      const p = structuredClone(template); p.messages[0].content = `Fixed controls, ${projectRoot}`;
      p.messages.push({ role: 'user', content: JSON.stringify({ task, attempt: 1 }) });
      const authenticated = { ...init(p), headers: { Authorization: 'Bearer new-test-dummy-never-a-real-key' } };
      for (let i = 0; i < manifest.limits.perCase; i++) await globalThis.fetch(endpoint, authenticated);
      await assert.rejects(globalThis.fetch(endpoint, authenticated), /BUDGET_CASE_REQUEST_LIMIT/u);
      assert.equal(batch.metrics().budget.requests, (index + 1) * manifest.limits.perCase);
      assert.deepEqual(batch.metrics().limits, manifest.limits);
      assert.equal(batch.metrics().deadlineAt, '2026-11-03T14:12:00.000Z');
    }
    assert.equal(calls, 4); assert.equal(batch.metrics().cumulativeProviderRequests, 21);
    assert.equal(batch.metrics().priorConservativeCommittedUsd, 1.25);
    await batch.close(); batch = null;
    process.env.RC_NATIVE_STOP_API_KEY = 'another-test-dummy';
    await assert.rejects(installNativeStopBatch({ hostRoot: '/opt/homebrew/lib/node_modules/openclaw', sourceRoot: root, outputRoot: root, manifest, now }), /EEXIST/u);
    delete process.env.RC_NATIVE_STOP_API_KEY;
    await assert.rejects(installNativeStopBatch({ hostRoot: '/opt/homebrew/lib/node_modules/openclaw', sourceRoot: root, outputRoot: root, manifest, now }), /dedicated temporary credential/u);
    process.env.RC_NATIVE_STOP_API_KEY = 'another-test-dummy';
    await assert.rejects(installNativeStopBatch({ hostRoot: '/opt/homebrew/lib/node_modules/openclaw', sourceRoot: root, outputRoot: root, manifest,
      now: () => Date.parse('2026-11-03T15:22:00Z') }), /deadline has expired/u);
  } finally {
    await batch?.close(); globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RC_NATIVE_STOP_API_KEY; else process.env.RC_NATIVE_STOP_API_KEY = previousKey;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native manifest accepts bounded operator choices and rejects unlimited, inconsistent or changed production-output limits', () => {
  const limits = { requests: 24, perCase: 12, wallMs: 720000, inputTokens: 262144, payloadBytes: 131072, outputTokens: 32768, usd: 64 };
  assert.deepEqual(validateNativeStopBatchLimits(limits), limits);
  for (const invalid of [{ ...limits, requests: Infinity }, { ...limits, perCase: 25 }, { ...limits, usd: NaN },
    { ...limits, payloadBytes: 262144 }, { ...limits, wallMs: 0 }, { ...limits, outputTokens: 8192 }])
    assert.throws(() => validateNativeStopBatchLimits(invalid));
});

test('Stop fails closed without its owning binding; only baseline reader roles receive workspace-only host tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-binding-'));
  const params = { sessionId: 'no-binding', sessionKey: 'no-binding', toolsAllow: ['read', 'exec'],
    config: { tools: { fs: { workspaceOnly: false } } }, skillsSnapshot: { prompt: 'unexposed', skills: ['unexposed'] } };
  try {
    await assert.rejects(prepareNativeEvaluationTools(params, { fixtureFence: { projectRoot: root } }), /actual owning task binding/u);
    const reader = await prepareNativeEvaluationTools(params, { fixtureFence: { projectRoot: root }, baseline: true });
    assert.deepEqual(reader.toolsAllow, ['read']);
    assert.equal(reader.config.tools.fs.workspaceOnly, true);
    assert.deepEqual(reader.skillsSnapshot, { prompt: '', skills: [] });
    assert.equal(params.config.tools.fs.workspaceOnly, false);
    const key = Symbol.for('runtime-corrector.openclaw.task-tools.v1');
    const bindings = globalThis[key] ??= new Map();
    bindings.set(params.sessionKey, { sessionId: 'different-owner', tools: [] });
    try {
      await assert.rejects(prepareNativeEvaluationTools(params, { fixtureFence: { projectRoot: root }, baseline: true }), /actual owning task binding/u);
    } finally { bindings.delete(params.sessionKey); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('noncomponent Stop preparation uses its real task binding without querying component reviewer context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-stop-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'original.txt'); await fs.writeFile(file, 'Original controlled Stop basis.');
  const params = { sessionId: 'actual-stop-session', sessionKey: 'actual-stop-key', runId: 'actual-stop-run' };
  const batch = { kind: 'metered_native_stop_batch', reviewRole() { assert.fail('Noncomponent Stop has no component ALS/role'); } };
  let registered, reads = 0;
  registerTaskTools({ registerTool(factory) { registered = factory; } });
  const unbind = bindTaskTools({ ...params, active() {}, checkpoint() {}, tools: [{ name: 'source_read',
    async execute(_id, args) { reads++; return fs.readFile(args.path, 'utf8'); } }] });
  try {
    const admitted = await prepareNativeEvaluationTools(params, { fixtureFence: { projectRoot: root }, batch });
    assert.equal(admitted, params);
    const tools = registered(params);
    assert.equal(await tools[0].execute('read-original', { path: file }), 'Original controlled Stop basis.');
    assert.equal(reads, 1);
    await assert.rejects(prepareNativeEvaluationTools({ ...params, sessionId: 'foreign' },
      { fixtureFence: { projectRoot: root }, batch }), /actual owning task binding/u);
  } finally { unbind(); }
  await assert.rejects(prepareNativeEvaluationTools(params, { fixtureFence: { projectRoot: root }, batch }), /actual owning task binding/u);
  assert.equal(reads, 1, 'Rejected/closed identities cannot execute the real bound tool');
});

test('baseline has its own batch kind and binds each request to its prepared role and current original revision', { skip: !existsSync('/opt/homebrew/lib/node_modules/openclaw/package.json') }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-baseline-'));
  let batch;
  try {
    await assert.rejects(installNativeBaselineBatch({ manifest: { kind: 'native-stop-pair-batch-v1' } }));
    await fs.writeFile(path.join(root, 'prior.json'), JSON.stringify({ totalProviderRequests: 50, inFlightRequests: 0,
      cumulativeReferenceEstimateIncludingOldHeldUsd: 4.320557 }));
    const manifest = { kind: 'native-baseline-component-v1', credentialEnv: 'RC_NATIVE_COMPONENT_API_KEY',
      stageDeadline: '2026-11-03T15:00:00Z', priorProviderRequests: 50, priorConservativeCommittedUsd: 4.320557,
      sourceHashes: {}, hostHashes: {}, priorSettlement: 'prior.json', launchClaim: 'claim.json',
      limits: { requests: 4, perCase: 2, wallMs: 60000, inputTokens: 65536, payloadBytes: 57344, outputTokens: 32768, usd: 8 } };
    batch = await installNativeBaselineBatch({ hostRoot: '/opt/homebrew/lib/node_modules/openclaw', sourceRoot: root,
      outputRoot: root, manifest, offline: true, now: () => Date.parse('2026-11-03T14:00:00Z') });
    const projectRoot = path.join(root, 'sample'); await fs.mkdir(projectRoot);
    const original = path.join(projectRoot, 'conversation.jsonl');
    for (const revision of ['original user request', 'later original user correction']) {
      await fs.writeFile(original, revision);
      await batch.beginCase({ projectRoot, files: [original] });
      await batch.scopeReview({ role: 'ground-truth-extractor' }, async () => {
        batch.prepared({ requestPath: original, request: { requiredFiles: ['request-0000.txt'] } });
        await batch.runNative({ runId: revision, sessionId: revision, prompt: revision, extraSystemPrompt: 'Actual RC controls', toolsAllow: ['source_read'] }, async () => {
          const response = await globalThis.fetch(endpoint, { ...init({ ...payload(), messages: [
            { role: 'system', content: 'Host header\nActual RC controls' }, { role: 'user', content: revision } ],
          tools: [{ type: 'function', function: { name: 'source_read' } }] }), headers: { Authorization: `Bearer ${batch.credential()}` } });
          assert.equal(response.status, 200);
        });
      });
    }
    const state = batch.metrics();
    assert.equal(state.cases.length, 2); assert.equal(state.requests.length, 2);
    assert(state.requests.every(request => request.role === 'ground-truth-extractor' && request.sourceValidationPassed));
    assert.notEqual(state.cases[0].fictionalFiles[0].sha256, state.cases[1].fictionalFiles[0].sha256);
    assert.equal(state.realProviderRequests, 0); assert.equal(state.cumulativeProviderRequests, 50);
    assert.equal(state.cumulativeConservativeReferenceUsd, 4.320557);
    assert.equal(existsSync(path.join(root, 'claim.json')), false);
    await assert.rejects(globalThis.fetch(endpoint, { ...init(payload()), headers: { Authorization: `Bearer ${batch.credential()}` } }), /actual prepared role context/u);
    assert.equal(batch.metrics().requests.length, 2);
  } finally { await batch?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
