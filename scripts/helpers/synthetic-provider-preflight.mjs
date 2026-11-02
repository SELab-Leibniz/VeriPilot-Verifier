// Offline only: generate fictional material and capture the installed provider
// serializer before HTTP dispatch. No credentials or private agent context.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSourceTools, toolText } from '../../lib/review-task/source-tools.mjs';

export const SYNTHETIC_FILES = Object.freeze({
  'request.txt': 'Fictional task: implement next(value) for integers 0 through 9. Return value + 1. No other input behavior is required.\n',
  'toy-document.md': '# Fictional shipping note\nThe toy package contains a blue cube. Never describe it as a red sphere.\n',
  'SKILL.md': '# Fictional local Skill\nIf the task changes next(value), run the synthetic unit test before claiming completion. If no code changes, no test run is required.\n',
  'toy-code.mjs': 'export const next = value => value;\n',
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const SYNTHETIC_SYSTEM_PROMPT = 'This is a fictional transport preflight. Read only the supplied frozen toy source. Identify whether next(value) satisfies the fictional request. Do not infer extra requirements. This request authorizes no external files or network tools.';
export const SYNTHETIC_USER_TEXT = 'Fictional input files are request.txt, toy-document.md, SKILL.md and toy-code.mjs. Read request.txt first; the next step will receive its original tool result. These are synthetic examples, not a real project.';
export async function createSyntheticSource(root) {
  await fs.mkdir(root, { recursive: true });
  root = await fs.realpath(root);
  for (const [file, text] of Object.entries(SYNTHETIC_FILES)) await fs.writeFile(path.join(root, file), text, { flag: 'wx' });
  const snapshot = new Map(Object.keys(SYNTHETIC_FILES).map(file => [file, {}]));
  const read = createSourceTools(root, snapshot).find(tool => tool.name === 'read');
  const tool = { ...read, name: 'source_read', async execute(id, args, signal) {
    if (typeof args.path !== 'string' || !snapshot.has(args.path)) throw new Error('SYNTHETIC_SOURCE_PATH_DENIED');
    // Refuse links, including links that resolve to another allowed toy file.
    const file = path.join(root, args.path), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error('SYNTHETIC_SOURCE_LINK_DENIED');
    const bytes = await fs.readFile(file);
    if (sha(bytes) !== sha(Buffer.from(SYNTHETIC_FILES[args.path]))) throw new Error('SYNTHETIC_SOURCE_CHANGED');
    return read.execute(id, args, signal);
  } };
  return { root, tool, files: Object.entries(SYNTHETIC_FILES).map(([file, text]) => ({ file, bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)), source: 'newly_authored_fictional_fixture' })) };
}

export async function captureSyntheticProviderPayloads({ root, hostRoot, modelId = 'glm-5.3', provider = 'review', captureAtFetch = false,
  protocol = 'anthropic-messages' }) {
  if (!['glm-5.3', 'glm-5.3-flash'].includes(modelId) || !['review', 'glm'].includes(provider)) throw new Error('Unapproved synthetic preflight route');
  if (!['anthropic-messages', 'openai-completions'].includes(protocol)) throw new Error('Unapproved synthetic preflight protocol');
  const coding = protocol === 'openai-completions';
  if (coding && (provider !== 'review' || modelId !== 'glm-5.3')) throw new Error('Unapproved Coding Plan model');
  const fixture = await createSyntheticSource(path.join(root, 'source'));
  // The host serializer's imports initialize state. Select a fresh private
  // process profile BEFORE importing them, outside the exposed frozen source.
  // Like the existing native evaluation helpers, run this in a dedicated process.
  const profile = path.join(fixture.root, '..', 'native-profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const configFile = path.join(profile, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ logging: { consoleLevel: 'silent' }, plugins: { enabled: false },
    models: { mode: 'replace', providers: {} } }), { flag: 'wx', mode: 0o600 });
  process.env.OPENCLAW_STATE_DIR = path.join(profile, 'state');
  process.env.OPENCLAW_CONFIG_PATH = configFile;
  process.env.OPENCLAW_AGENT_DIR = path.join(profile, 'agent');
  const systemPrompt = SYNTHETIC_SYSTEM_PROMPT, userText = SYNTHETIC_USER_TEXT;
  const tools = [{ name: fixture.tool.name, description: fixture.tool.description, parameters: fixture.tool.parameters }];
  const model = { id: modelId, name: modelId, provider, api: protocol,
    baseUrl: coding ? 'https://open.bigmodel.cn/api/coding/paas/v4' : 'https://open.bigmodel.cn/api/anthropic',
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
    ...(coding ? { cost: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 },
      compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens', supportsStore: false,
        supportsDeveloperRole: false, supportsReasoningEffort: false } } : {}) };
  const captured = [], wireCaptured = []; let fetchReached = 0, socketAttemptsBlocked = 0, phaseNow;
  const original = globalThis.fetch, originalConnect = net.Socket.prototype.connect;
  const runtimePort = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__';
  const originalRuntime = globalThis[runtimePort];
  const originalLookup = dns.lookup, originalPromiseLookup = dnsPromises.lookup;
  // The stock transport resolves its SSRF policy before fetch. Do not make
  // even a DNS query during this offline capture; use a public fixture address.
  const resolved = options => options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
  dns.lookup = (_name, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => options?.all ? callback(null, resolved(options)) : callback(null, '93.184.216.34', 4));
  };
  dnsPromises.lookup = async (_name, options) => resolved(options);
  syncBuiltinESMExports();
  // Defense in depth: even a cached fetch implementation cannot open a socket.
  net.Socket.prototype.connect = function () { socketAttemptsBlocked++; throw new Error('OFFLINE_PREFLIGHT_SOCKET_DENIED'); };
  globalThis.fetch = async (input, init) => {
    fetchReached++;
    if (!captureAtFetch) throw new Error('OFFLINE_PREFLIGHT_FETCH_DENIED');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, 'https://open.bigmodel.cn');
    assert.equal(url.pathname, coding ? '/api/coding/paas/v4/chat/completions' : '/api/anthropic/v1/messages');
    assert(!url.username && !url.password && !url.search && !url.hash);
    const body = typeof init?.body === 'string' ? init.body : await input.clone().text();
    const payload = JSON.parse(body);
    assert.deepEqual(payload, captured.at(-1).payload, 'actual wire JSON must match the reviewed synthetic payload');
    wireCaptured.push({ phase: phaseNow, origin: url.origin, pathname: url.pathname, payload, sha256: sha(Buffer.from(JSON.stringify(payload))) });
    // Never inspect or persist Authorization/header values, and never delegate
    // to the original fetch. The configured real endpoint is not contacted.
    throw new Error('OFFLINE_PREFLIGHT_WIRE_CAPTURED');
  };
  // The installed host deliberately uses a dispatcher-aware runtime fetch,
  // which can bypass global fetch. Its explicit development dependency port
  // lets us intercept that exact boundary while preserving all constructors.
  const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
  globalThis[runtimePort] = { ...undici, fetch: globalThis.fetch };
  const user = { role: 'user', content: [{ type: 'text', text: userText }], timestamp: 1 };
  const capture = async (phase, messages) => {
    phaseNow = phase; const previousWireCount = wireCaptured.length;
    let observed = false;
    let run;
    if (coding) run = (await import(pathToFileURL(path.join(hostRoot, 'node_modules/@openclaw/ai/dist/openai-completions-B9QLIq2U.mjs')))).r;
    else {
      const { i: createStream } = await import(pathToFileURL(path.join(hostRoot, 'dist/provider-stream-CqSx37Uy.js')));
      run = (model, context, options) => createStream(model)(model, context, options);
    }
    const result = await run(model, { systemPrompt, messages, tools }, {
      apiKey: 'synthetic-preflight-dummy-not-an-authentication-key', maxTokens: 1024, reasoning: 'off',
      maxRetries: 0, cacheRetention: 'none', onPayload(payload) {
        observed = true;
        const copy = JSON.parse(JSON.stringify(payload));
        assert.equal(copy.model, modelId); assert.equal(copy.max_tokens, 1024);
        if (coding) {
          assert.equal(copy.stream_options?.include_usage, true);
          assert.deepEqual(copy.messages.filter(message => message.role === 'system').map(message => message.content), [systemPrompt]);
          assert.deepEqual(copy.tools.map(tool => tool.function.name), ['source_read']);
          assert.deepEqual(copy.tools[0].function.parameters.properties, fixture.tool.parameters.properties);
          assert(Object.keys(copy.tools[0].function.parameters).every(key => ['type', 'properties', 'required', 'additionalProperties'].includes(key)));
        } else {
          assert.deepEqual(copy.system.map(block => block.text), [systemPrompt]);
          assert.deepEqual(copy.tools.map(tool => tool.name), ['source_read']);
          assert.deepEqual(copy.tools[0].input_schema, { type: 'object', properties: fixture.tool.parameters.properties, required: [] });
        }
        const encoded = JSON.stringify(copy);
        assert(!encoded.includes(fixture.root));
        assert(!encoded.includes('synthetic-preflight-dummy'));
        captured.push({ phase, origin: 'https://open.bigmodel.cn', provider, modelId, payload: copy, sha256: sha(Buffer.from(encoded)) });
        if (!captureAtFetch) throw new Error('OFFLINE_PREFLIGHT_PAYLOAD_CAPTURED');
      },
    }).result();
    assert(observed, 'must inspect the actual installed serializer payload');
    assert.equal(result.stopReason, 'error');
    if (captureAtFetch) assert.equal(wireCaptured.length, previousWireCount + 1,
      JSON.stringify({ fetchReached, socketAttemptsBlocked, error: result.errorMessage }));
    else assert.match(result.errorMessage, /OFFLINE_PREFLIGHT_PAYLOAD_CAPTURED/u);
  };
  try {
    await capture('initial', [user]);
    const calls = Object.keys(SYNTHETIC_FILES).map((file, index) => ({ type: 'toolCall', id: `synthetic-read-${index + 1}`, name: 'source_read', arguments: { path: file, numbered: true } }));
    const results = [];
    for (const call of calls) {
      const result = await fixture.tool.execute(call.id, call.arguments);
      results.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: toolText(result) }], isError: false, timestamp: 3 });
    }
    const assistant = { role: 'assistant', content: calls,
      api: protocol, provider, model: modelId, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 };
    await capture('after_synthetic_tool_result', [user, assistant, ...results]);
    assert.equal(fetchReached, captureAtFetch ? 2 : 0);
    assert.equal(socketAttemptsBlocked, 0);
    return { kind: 'offline_provider_serializer_capture_not_native_module_acceptance', origin: 'https://open.bigmodel.cn', protocol, provider, modelId,
      realModelRequests: 0, networkRequests: 0, fetchReached, socketAttemptsBlocked, wireCaptured,
      captureStage: captureAtFetch ? 'actual_fetch_intercepted_without_network' : 'provider_onPayload_before_HTTP_construction',
      privateContextLoadersUsed: false, authenticationLoaded: false,
      hostProfile: { isolated: true, configContainsCredentials: false, outsideExposedSource: true }, files: fixture.files,
      controlSources: [{ source: 'newly_authored_system_and_user_prompt', systemPrompt, userText },
        { source: 'lib/review-task/source-tools.mjs', purpose: 'frozen source_read tool description/schema and toy page formatting; no RC business source content', schemaSha256: sha(Buffer.from(JSON.stringify(tools))) },
        { source: 'installed_OpenClaw_provider_serializer', purpose: 'protocol formatting only; no stock agent bootstrap, AGENTS, memory, Skill discovery or history loading' }], captured };
  } finally { globalThis.fetch = original; net.Socket.prototype.connect = originalConnect;
    if (originalRuntime === undefined) delete globalThis[runtimePort]; else globalThis[runtimePort] = originalRuntime;
    dns.lookup = originalLookup; dnsPromises.lookup = originalPromiseLookup; syncBuiltinESMExports(); }
}
