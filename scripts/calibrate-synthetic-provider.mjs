// Explicitly authorized, two-request Coding Plan synthetic calibration only. Not a bench
// runner or RC module acceptance. No private bootstrap or repository inventory.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSyntheticSource, SYNTHETIC_FILES, SYNTHETIC_SYSTEM_PROMPT, SYNTHETIC_USER_TEXT } from './helpers/synthetic-provider-preflight.mjs';
import { createProviderRequestBudget } from './helpers/provider-request-budget.mjs';
import { createSyntheticCalibrationFetch } from './helpers/synthetic-calibration-fetch.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';

const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const mode = '--approved-coding-key-recovery';
if (!args.includes(mode) || ['--approved-synthetic-live', '--approved-flash-followup', '--approved-key-recovery'].some(flag => args.includes(flag))
  || !args.includes('--output') || !args.includes('--host-root'))
  throw new Error('Explicit approved Coding Plan synthetic calibration, fresh --output and --host-root are required; old Anthropic modes are retired');
// Recovery never falls back to a persisted credential or keeps the temporary
// key in the child environment seen by imported host components.
const recoveryCredential = process.env.RC_CALIBRATION_API_KEY;
delete process.env.RC_CALIBRATION_API_KEY;
if (!recoveryCredential?.trim()) throw Object.assign(new Error('Temporary recovery credential is required'), { code: 'RECOVERY_AUTH_NOT_CONFIGURED' });
const outputRoot = path.resolve(arg('--output')), hostRoot = path.resolve(arg('--host-root'));
await fs.mkdir(outputRoot, { recursive: false, mode: 0o700 });
const save = (file, value) => fs.writeFile(path.join(outputRoot, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const origin = 'https://open.bigmodel.cn', route = 'review', modelId = 'glm-5.3', maxTokens = 8192;
const protocol = 'openai-completions', baseUrl = origin + '/api/coding/paas/v4';
const sealedBatches = [];
for (const name of ['live-synthetic-001', 'live-synthetic-flash-001']) {
  const root = path.join(path.dirname(outputRoot), name);
  const previous = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  assert.equal(previous.realRequestsAdmitted, 1); assert.equal(previous.inFlightRequests, 0);
  assert.equal(previous.requests[0].status, 401); assert.equal(previous.budget.halted, 'BUDGET_USAGE_UNKNOWN');
  assert.equal(previous.budget.estimatedCommittedUsd, name === 'live-synthetic-001' ? 0.4096 : 0.045056);
  sealedBatches.push({ root, requests: 1, inFlight: 0, estimatedReservationHeldUsd: previous.budget.estimatedCommittedUsd,
    usageUnknown: true, notResumed: true });
}
const priorBatch = { sealedBatches, estimatedReservationHeldUsd: 0.454656, independentNewApprovalWindow: true, reusesOldDeadline: false };
const prices = { input: '7', output: '22', cacheRead: '7', cacheWrite: '7' };
const requestCap = 2;
const limits = { usd: '0.8192', requests: requestCap, wallMs: 5 * 60 * 1000, inputPerRequest: 32768, outputPerRequest: maxTokens,
  totalInput: requestCap * 32768, totalOutput: requestCap * maxTokens };
const budget = createProviderRequestBudget({ origin, limits, prices });
const records = [], responses = [], toolsUsed = [], modelOutputs = [];
let stopReason = 'NOT_STARTED', approvedPayload, activeRequest = 0, restore;
const sourceFiles = ['scripts/calibrate-synthetic-provider.mjs', 'scripts/helpers/provider-request-budget.mjs',
  'scripts/helpers/synthetic-calibration-fetch.mjs', 'scripts/helpers/synthetic-provider-preflight.mjs', 'lib/review-task/source-tools.mjs', 'lib/line-page.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await fs.readFile(file))])));
const serializer = 'node_modules/@openclaw/ai/dist/openai-completions-B9QLIq2U.mjs';
const manifest = { kind: 'approved_synthetic_channel_and_frozen_tool_calibration_only', origin, baseUrl, protocol, route, modelId, limits, prices, priorBatch,
  officialProtocolReferences: ['https://docs.bigmodel.cn/cn/coding-plan/tool/others', 'https://docs.bigmodel.cn/cn/coding-plan/quick-start'],
  mode: 'approved-coding-key-recovery', credentialSource: 'temporary_env:RC_CALIBRATION_API_KEY',
  serializer, serializerSha256: sha(await fs.readFile(path.join(hostRoot, serializer))),
  usageEvidence: 'requests[].reportedUsage is provider evidence; ledger usage charges the complete prompt total at full input price, not a claimed cache-zero report',
  createdAt: new Date().toISOString(), sourceHashesCapturedBeforeDispatch: true, sourceHashes,
  fictionalSources: Object.entries(SYNTHETIC_FILES).map(([file, value]) => ({ file, sha256: sha(value), bytes: Buffer.byteLength(value) })),
  systemSha256: sha(SYNTHETIC_SYSTEM_PROMPT), userSha256: sha(SYNTHETIC_USER_TEXT),
  priceSource: 'supervisor-frozen conservative public Z.ai reference times five; not actual BigModel bill',
  actualAccountDollarCharges: 'unknown', startsNativeRCModule: false, startsBenchmark: false,
  authorization: '2026-10-30 delegated supervisor approved alternative; four fictional files, fixed prompts/source_read schema and model outputs only' };
await save('manifest.json', manifest);
try {
  const require = createRequire(path.join(hostRoot, 'package.json'));
  const credential = recoveryCredential;
  const fixture = await createSyntheticSource(path.join(outputRoot, 'source'));
  const profile = path.join(outputRoot, 'native-profile'); await fs.mkdir(profile, { mode: 0o700 });
  process.env.OPENCLAW_STATE_DIR = path.join(profile, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(profile, 'config.json');
  process.env.OPENCLAW_AGENT_DIR = path.join(profile, 'agent');
  for (const name of ['OPENCLAW_DEBUG_MODEL_PAYLOAD', 'OPENCLAW_DEBUG_SSE', 'OPENCLAW_DEBUG_MODEL_TRANSPORT']) process.env[name] = 'off';
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ logging: { consoleLevel: 'silent' }, plugins: { enabled: false },
    models: { mode: 'replace', providers: {} } }), { mode: 0o600 });
  const tools = [{ name: fixture.tool.name, description: fixture.tool.description, parameters: fixture.tool.parameters }];
  manifest.toolSchemaSha256 = sha(JSON.stringify(tools)); await save('manifest.json', manifest);
  await save('payload-sources.json', { files: fixture.files, systemPrompt: SYNTHETIC_SYSTEM_PROMPT, userText: SYNTHETIC_USER_TEXT, tools,
    privateBootstrap: false, sourceOutsideLinksAllowed: false, authenticationInPayload: false });
  const undici = require('undici'), port = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__';
  const originalRuntime = globalThis[port], originalGlobal = globalThis.fetch;
  const guarded = fetchImpl => createSyntheticCalibrationFetch({ budget, origin, protocol, fetchImpl,
    getApprovedPayload: () => approvedPayload, onRecord(row) { records.push({ request: activeRequest, ...row }); },
    async onResponseBody(bytes) {
      const redacted = bytes.toString('utf8').replaceAll(credential, '[REDACTED]');
      const file = `response-${activeRequest}.sse`;
      await fs.writeFile(path.join(outputRoot, file), redacted, { mode: 0o600 });
      responses.push({ request: activeRequest, file, sourceSha256: sha(bytes), redactedSha256: sha(redacted), credentialRedacted: redacted !== bytes.toString('utf8') });
    } });
  globalThis[port] = { ...undici, fetch: guarded(undici.fetch) };
  globalThis.fetch = guarded(originalGlobal);
  restore = () => { globalThis.fetch = originalGlobal; if (originalRuntime === undefined) delete globalThis[port]; else globalThis[port] = originalRuntime; };
  // The installed SDK serializer forwards maxRetries:0 at request scope. The
  // host's separate wrapper does not, so use this installed implementation
  // directly for this calibration rather than changing the installed host.
  const { r: streamOpenAICompletions } = await import(pathToFileURL(path.join(hostRoot, serializer)));
  const model = { id: modelId, name: modelId, provider: route, api: protocol, baseUrl,
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens,
    cost: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 },
    compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens', supportsStore: false,
      supportsDeveloperRole: false, supportsReasoningEffort: false } };
  const messages = [{ role: 'user', content: [{ type: 'text', text: SYNTHETIC_USER_TEXT }], timestamp: Date.now() }];
  for (let turn = 0; turn < requestCap; turn++) {
    activeRequest = turn + 1;
    const result = await streamOpenAICompletions(model, { systemPrompt: SYNTHETIC_SYSTEM_PROMPT, messages, tools }, {
      apiKey: credential, maxTokens, reasoning: 'off', maxRetries: 0, cacheRetention: 'none', timeoutMs: limits.wallMs,
      async onPayload(payload) {
        assert.equal(payload.model, modelId); assert.equal(payload.max_tokens, maxTokens);
        assert.equal(payload.stream_options?.include_usage, true);
        assert.deepEqual(payload.messages.filter(message => message.role === 'system').map(message => message.content), [SYNTHETIC_SYSTEM_PROMPT]);
        assert.deepEqual(payload.tools.map(tool => tool.function.name), ['source_read']);
        assert(!JSON.stringify(payload).includes(outputRoot));
        assert(!JSON.stringify(payload).includes(credential));
        approvedPayload = JSON.parse(JSON.stringify(payload));
        await save(`request-${activeRequest}.json`, { origin, payload: approvedPayload });
      },
    }).result();
    // Persist only outputs derived from this synthetic context, never auth.
    modelOutputs.push(JSON.parse(JSON.stringify(result).replaceAll(credential, '[REDACTED]')));
    await save('checkpoint.json', { stopReason: 'TURN_SETTLED', budget: budget.snapshot(), records, responses, toolsUsed, modelOutputs });
    if (budget.snapshot().halted) { stopReason = budget.snapshot().halted; break; }
    if (result.stopReason === 'error' || result.stopReason === 'length') { stopReason = `MODEL_${result.stopReason.toUpperCase()}`; break; }
    messages.push(result);
    const calls = result.content.filter(block => block.type === 'toolCall');
    if (!calls.length) { stopReason = 'MODEL_FINAL_RESPONSE'; break; }
    for (const call of calls) {
      let value, errorCode = null;
      try {
        if (call.name !== 'source_read') throw new Error('SYNTHETIC_TOOL_DENIED');
        value = await fixture.tool.execute(call.id, call.arguments);
      } catch (error) { errorCode = /^SYNTHETIC_/u.test(error.message) ? error.message : 'SYNTHETIC_TOOL_REJECTED'; value = { content: [{ type: 'text', text: errorCode }] }; }
      toolsUsed.push({ request: activeRequest, id: call.id, name: call.name,
        path: Object.hasOwn(fixture.files.reduce((o,f) => ({ ...o, [f.file]: true }), {}), call.arguments?.path) ? call.arguments.path : null,
        errorCode, resultSha256: sha(toolText(value)) });
      messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: value.content, isError: Boolean(errorCode), timestamp: Date.now() });
    }
    stopReason = 'APPROVED_REQUEST_CAP_REACHED';
  }
} catch (error) { stopReason = typeof error.code === 'string' ? error.code : 'CALIBRATION_FAILED'; }
finally {
  restore?.();
  const result = { ...manifest, stopReason, budget: budget.snapshot(), requests: records, responses, toolsUsed, modelOutputs,
    realRequestsAdmitted: budget.snapshot().requests, inFlightRequests: budget.snapshot().inFlightRequests,
    unknownUsage: budget.snapshot().halted !== null, actualAccountDollarCharges: 'unknown',
    nativeRCModulePassed: false, benchmarkPassed: false };
  await save('result.json', result);
  console.log(JSON.stringify({ outputRoot, stopReason, providerRequests: result.realRequestsAdmitted, budget: result.budget,
    actualAccountDollarCharges: 'unknown', nativeRCModulePassed: false }));
  if (result.inFlightRequests) { console.log(JSON.stringify({ state: 'UPSTREAM_SETTLEMENT_UNKNOWN_DO_NOT_REDISPATCH' })); process.exitCode = 1; }
}
