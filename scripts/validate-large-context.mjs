// Development probe. Runs the installed OpenClaw and current RC against a synthetic
// repository. The provider transport is replaced before either runtime loads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import net from 'node:net';
import dns, { promises as dnsPromises } from 'node:dns';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { businessSnapshot, chineseText, createRepository, denseText, sourceName, sourceText } from './helpers/large-context-fixtures.mjs';
import { runInitialSdd } from './helpers/initial-sdd-pressure.mjs';
import { runSingleRequiredFile } from './helpers/single-required-file.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function arg(name, fallback) {
  const position = args.indexOf(name);
  return position < 0 ? fallback : args[position + 1];
}
if (!arg('--host-root') || !arg('--python') || !arg('--tokenizers'))
  throw new Error('Pass --host-root, --python, and --tokenizers. See docs/large-context-validation.md.');
const hostRoot = path.resolve(arg('--host-root'));
const outputRoot = path.resolve(arg('--output-root', path.join(sourceRoot, '.runtime-correction', 'context-' + randomUUID().slice(0, 8))));
const selectedCases = arg('--cases')?.split(',');
const caseNames = new Set(['calibration', 'local-projection', 'initial-sdd-164k', 'single-required-file', 'review-small', 'review-large', 'review-overflow',
  'review-wide-context', 'review-page-cap', 'review-dense-overflow', 'business-history', 'business-false-positive', 'business-single-input', 'business-summary-overflow']);
for (const name of selectedCases ?? []) assert(caseNames.has(name), 'Unknown case: ' + name);
const enabled = name => !selectedCases || selectedCases.includes(name);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const model = { review: 'deepseek-v4.1-flash', business: 'deepseek-v4-flash' };
const modelWindow = 204800;
const contextTokens = 200000;
const reserveTokens = 20000;
const hostPackage = await readJson(path.join(hostRoot, 'package.json'));
assert.equal(hostPackage.name, 'openclaw');
assert.equal(hostPackage.version, '2026.7.1-2');
const defaults = (await readJson(path.join(hostRoot, '..', 'openclaw-defaults.json'))).agents.defaults;
const toolResultCap = defaults.contextLimits.toolResultMaxChars;
assert.equal(defaults.contextTokens, contextTokens);
assert.equal(defaults.compaction.reserveTokensFloor, reserveTokens);

await fs.mkdir(outputRoot, { recursive: false });
const python = spawn(path.resolve(arg('--python')), [
  path.join(sourceRoot, 'scripts/helpers/large-context-tokenizer.py'), path.resolve(arg('--tokenizers')),
], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: python.stdout })[Symbol.asyncIterator]();
const nextCount = async () => {
  const { value, done } = await lines.next();
  if (done) throw new Error('Tokenizer process ended.');
  const result = JSON.parse(value);
  if (result.error) throw new Error(result.error);
  return result;
};
const tokenizer = await nextCount();
let tokenQueue = Promise.resolve();
function count(payload) {
  const operation = tokenQueue.then(async () => {
    await new Promise((resolve, reject) => python.stdin.write(JSON.stringify(payload) + '\n', error => error ? reject(error) : resolve()));
    return nextCount();
  });
  tokenQueue = operation.catch(() => {});
  return operation;
}

const stateDir = path.join(outputRoot, 'state');
await fs.mkdir(stateDir);
const hostHome = path.join(outputRoot, 'home');
await fs.mkdir(hostHome);
process.env.OPENCLAW_HOME = hostHome;
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(outputRoot, 'openclaw.json');
process.env.OPENCLAW_LOG_LEVEL = 'debug';
process.argv[1] = path.join(hostRoot, 'openclaw.mjs');

const endpoint = 'https://fixture.example';
const runtimeKey = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__';
const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
let activeCase, socketAttempts = 0;
const old = { fetch: globalThis.fetch, undici: globalThis[runtimeKey], connect: net.Socket.prototype.connect,
  lookup: dns.lookup, promiseLookup: dnsPromises.lookup };
net.Socket.prototype.connect = function () {
  socketAttempts++;
  throw new Error('External networking is disabled during the experiment.');
};
dns.lookup = (name, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  queueMicrotask(() => options?.all ? callback(null, [{ address: '93.184.216.34', family: 4 }]) : callback(null, '93.184.216.34', 4));
};
dnsPromises.lookup = async (_name, options) => options?.all ? [{ address: '93.184.216.34', family: 4 }] : '93.184.216.34';
syncBuiltinESMExports();

const assistantCall = (index, call) => ({ index, id: call.id, type: 'function',
  function: { name: call.name, arguments: JSON.stringify(call.args) } });
function streamed(payload, response, usage) {
  const { calls = [], text } = response;
  const delta = { role: 'assistant', ...(calls.length ? { tool_calls: calls.map((call, index) => assistantCall(index, call)) } : { content: text }) };
  const frame = (part, reason) => ({ id: 'sdd-fixture-' + randomUUID(), object: 'chat.completion.chunk', model: payload.model,
    choices: [{ index: 0, delta: part, finish_reason: reason }] });
  const inputTokens = usage.tokens;
  const completionTokens = calls.length ? 40 * calls.length : 15;
  const body = [frame(delta, null), { ...frame({}, calls.length ? 'tool_calls' : 'stop'),
    usage: { prompt_tokens: inputTokens, completion_tokens: completionTokens, total_tokens: inputTokens + completionTokens } }]
    .map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const hostImport = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
const precheck = (await hostImport('dist/attempt.tool-run-context-CuQsIXnb.js')).c;
const hostTruncation = await hostImport('dist/tool-result-truncation-rzMcqvvu.js');
const sessions = await hostImport('dist/plugin-sdk/agent-sessions.js');
const core = await hostImport('dist/plugin-sdk/agent-core.js');
const { I: cacheTtlEligible } = await hostImport('dist/attempt.model-diagnostic-events-CfZQM0hs.js');

function wireText(content) {
  if (Array.isArray(content)) {
    assert(content.every(block => block.type === 'text' && typeof block.text === 'string'), 'Expected a text-only prompt.');
    return content.map(block => block.text).join('');
  }
  return content ?? '';
}

function fromWire(payload) {
  const messages = payload.messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'tool' ? 'toolResult' : message.role,
    content: [
      ...(message.content ? [{ type: 'text', text: wireText(message.content) }] : []),
      ...(message.tool_calls ?? []).map(call => ({ type: 'toolCall', name: call.function.name,
        arguments: JSON.parse(call.function.arguments) })),
    ],
    ...(message.role === 'tool' ? { toolName: 'source_read', toolCallId: message.tool_call_id } : {}),
  }));
  return { messages, systemPrompt: payload.messages.filter(message => message.role === 'system').map(message => wireText(message.content)).join('\n') };
}
const estimate = (payload, budget = contextTokens) => precheck({ ...fromWire(payload), prompt: '', contextTokenBudget: budget,
  reserveTokens, toolResultMaxChars: toolResultCap });
const isSummaryRequest = payload => payload.messages.some(message => {
  const text = wireText(message.content);
  return text.startsWith('You are a context summarization assistant') || text.startsWith('<conversation>');
});

async function fixtureFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url ?? input.href;
  assert(url.startsWith(endpoint + '/'), 'Unexpected provider egress: ' + new URL(url).hostname);
  assert(activeCase, 'Provider called outside a case.');
  const body = typeof init?.body === 'string' ? init.body : await new Request(input, init).text();
  const payload = JSON.parse(body);
  const wireSequence = activeCase.wireSequence = (activeCase.wireSequence ?? 0) + 1;
  const wireFile = path.join(activeCase.directory, 'wire-' + String(wireSequence).padStart(3, '0') + '.json');
  await writeJson(wireFile, payload);
  let inputUsage;
  try {
    inputUsage = await count(payload);
  } catch (error) {
    (activeCase.transportErrors ??= []).push({ wireFile, error: error.message });
    throw error;
  }
  const kind = isSummaryRequest(payload) ? 'compaction' : 'prompt';
  const rows = payload.messages.filter(message => message.role === 'tool').map(message => ({
    id: message.tool_call_id, chars: message.content.length, sha256: hash(message.content),
    truncated: /more characters truncated|middle content omitted|tool result elided|chars truncated|old tool result content cleared/i.test(message.content),
  }));
  assert(!payload.messages.some(message => typeof message.content === 'string'
    && message.content.includes('UNRELATED_SDD_BENCHMARK_MODULE')), 'Unrelated source reached the wire.');
  const request = { sequence: activeCase.requests.length + 1, kind, model: payload.model, inputTokens: inputUsage.tokens,
    renderedBytes: inputUsage.renderedBytes, bodyBytes: Buffer.byteLength(body), wireEstimate: estimate(payload, activeCase.contextTokens),
    maxOutputTokens: payload.max_completion_tokens ?? payload.max_tokens, toolResults: rows };
  activeCase.requests.push(request);
  if (request.sequence > activeCase.requestLimit) {
    const error = 'Script produced too many requests in ' + activeCase.name;
    (activeCase.transportErrors ??= []).push({ wireFile, error });
    throw new Error(error);
  }
  const capacityDemand = inputUsage.tokens + (activeCase.reserveOutput ? request.maxOutputTokens ?? 0 : 0);
  if (inputUsage.tokens >= (activeCase.providerWindow ?? modelWindow) || capacityDemand > (activeCase.providerWindow ?? modelWindow)) {
    request.response = 'fixture_context_overflow';
    return new Response(JSON.stringify({ error: { code: 'context_length_exceeded',
      message: 'This model maximum context length is ' + (activeCase.providerWindow ?? modelWindow) + ' tokens. The prompt has ' + inputUsage.tokens + ' tokens.'
        + (activeCase.reserveOutput ? ' Requested output: ' + request.maxOutputTokens + ' tokens.' : '') } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (kind === 'compaction') {
    request.response = 'fixture_summary';
    return streamed(payload, { text: '## Goal\nReview the original staged workflow and preserve the execution references.\n'
      + '## Progress\nThe current input, prior stage results and verification requirements were reviewed.\n' }, inputUsage);
  }
  let response;
  try {
    response = await activeCase.reply(payload);
  } catch (error) {
    (activeCase.transportErrors ??= []).push({ wireFile, error: error.message });
    throw error;
  }
  request.response = response.calls?.map(call => call.name) ?? 'fixture_text';
  return streamed(payload, response, inputUsage);
}
globalThis.fetch = fixtureFetch;
globalThis[runtimeKey] = { ...undici, fetch: fixtureFetch };

let prepared;
const stopClass = { stopClassification: 'TASK_COMPLETE', stage: null };
function fileCall(file, limit, offset = 1) {
  return { name: 'source_read', args: { path: file, limit, offset, numbered: true } };
}
const pageMetadata = text => /\[RC page (\{[^\r\n]*\})\]/u.exec(text)?.[1];
const parseToolText = text => {
  try { return JSON.parse(text); } catch { return null; }
};
function stopScript(spec, summary) {
  let phase = 'basis', queue = [], pending = [], nextId = 0;
  function send(calls) {
    pending = calls.map(call => ({ ...call, id: 'call' + spec.name.replaceAll('-', '') + (++nextId) }));
    summary.calls.push(...pending);
    return { calls: pending };
  }
  function checklistItems() {
    return [
      { metricId: 'M16', text: 'Preserve restartable staged SDD workflow state.',
        verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', path: spec.contract, lineStart: 1, lineEnd: 1 },
      ...(spec.process ? [{ metricId: 'M11', text: 'Actually run the workflow checks and preserve their outputs and exit codes.',
        verificationTarget: 'PROCESS', path: spec.contract, lineStart: 2, lineEnd: 2 }] : []),
    ];
  }
  return async payload => {
    const task = prepared.request.task;
    const tools = new Map(payload.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]));
    for (const call of pending) {
      if (!tools.has(call.id)) continue;
      const text = tools.get(call.id);
      if (call.name === 'source_read') {
        const metadata = pageMetadata(text);
        if (metadata && JSON.parse(metadata).nextOffset != null) {
          queue.unshift(fileCall(call.args.path, call.args.limit, JSON.parse(metadata).nextOffset));
        }
      } else {
        const result = parseToolText(text);
        summary.submissions.push({ name: call.name, saved: result?.saved, complete: result?.complete,
          scope: result?.classification?.stopClassification, processNavigationOmitted: result?.processNavigationOmitted,
          proofOwners: Array.isArray(result?.items) ? result.items.map(item => item.proofOwners) : undefined,
          error: result ? result.code ?? result.error : text.slice(0, 360) });
        if (spec.wide && call.name === 'set_original_checklist' && result?.saved !== true && phase === 'scope') {
          phase = 'retry-basis';
          queue = [fileCall(spec.contract, 100)];
        }
      }
    }

    if (phase === 'basis' && nextId === 0) queue = task.basisFiles.map(file => fileCall(file, file === spec.contract && spec.wide ? 400 : 110));
    if (queue.length) return send(queue.splice(0, spec.batch ?? 1));
    if (phase === 'basis' || phase === 'retry-basis') {
      phase = phase === 'basis' ? 'scope' : 'scope-after-retry';
      return send([{ name: 'set_original_checklist', args: { items: checklistItems() } }]);
    }
    if (phase.startsWith('scope')) {
      phase = 'evidence';
      return send([{ name: 'review_checklist', args: { stopClassification: 'TASK_COMPLETE', completionClaim: true } }]);
    }
    if (phase === 'evidence') {
      phase = 'finish';
      const processFiles = spec.process ? (await fs.readdir(task.processDirectory))
        .filter(file => /^00000[1-4]-/u.test(file)).sort().map(file => path.join(task.processDirectory, file)) : [];
      const sourceFiles = spec.sources.map(file => path.join(spec.repo, file));
      queue = [...processFiles, ...sourceFiles].map(file => fileCall(file, 400));
      if (queue.length) return send(queue.splice(0, spec.batch ?? 1));
    }
    if (phase === 'finish') {
      phase = 'end';
      return send([{ name: 'finish_stop_review', args: { summary: 'End of deterministic transport fixture.' } }]);
    }
    return { text: 'Fixture protocol ended.' };
  };
}

async function jsonLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function pressureLog(sessionKey) {
  if (!sessionKey) return [];
  return (await jsonLines(path.join(outputRoot, 'host.log')))
    .map(entry => entry['1'])
    .filter(message => typeof message === 'string' && message.includes('sessionKey=' + sessionKey)
      && /^\[(?:context-overflow|compaction)/u.test(message));
}

async function reviewCase(baseConfig, runtime, spec) {
  const directory = path.join(outputRoot, spec.name);
  await fs.mkdir(directory);
  const budget = spec.window ?? contextTokens;
  const record = { name: spec.name, directory, requests: [], calls: [], submissions: [], requestLimit: 64,
    contextTokens: budget, providerWindow: spec.providerWindow ?? spec.window ?? modelWindow, reserveOutput: spec.reserveOutput };
  record.reply = spec.makeReply ? spec.makeReply(() => prepared.request.task, record) : stopScript(spec, record);
  activeCase = record;
  const nativeResults = [];
  const config = structuredClone(baseConfig);
  config.agents.defaults.workspace = spec.repo;
  config.agents.defaults.contextTokens = budget;
  if (spec.window) config.models.providers.custom.models.find(item => item.id === model.review).contextWindow = spec.window;
  if (spec.maxOutput) config.models.providers.custom.models.find(item => item.id === model.review).maxTokens = spec.maxOutput;
  const sessionId = 'fixture-' + spec.name;
  const task = await ensureTask({ projectRoot: spec.repo, sessionId });
  const snapshot = spec.snapshot ?? businessSnapshot(spec.contract, 5);
  const originalRequirements = await loadStopOriginalRequirements({ projectRoot: spec.repo, snapshot });
  if (!spec.snapshot) assert(originalRequirements.referencedFiles.some(file => path.resolve(spec.repo, file.path) === spec.contract),
    'The SDD attachment must be a mandatory original source.');
  const groundTruth = { taskId: task.taskId, version: 0, digest: null, claims: [] };
  const scopedRuntime = { ...runtime, config: { ...runtime.config, current: () => config } };
  const factory = createOpenClawReviewerFactory({ runtime: scopedRuntime, config, logger: {
    warn(message) { nativeResults.push({ warning: message }); },
  } }, {
    pluginRoot: baseConfig.plugins.load.paths[0],
    runEmbeddedAgent: async params => {
      record.sessionFile = params.sessionFile;
      record.sessionKey = params.sessionKey;
      const result = await runtime.agent.runEmbeddedAgent(params);
      nativeResults.push({ meta: result.meta, text: result.payloads?.map(item => item.text).filter(Boolean) });
      return result;
    },
  });
  const input = {
    projectRoot: spec.repo, sessionCwd: spec.repo, taskId: task.taskId, role: 'stop-reviewer',
    parentSessionId: sessionId, schema: STOP_REVIEW_SCHEMA, reviewer: { model: 'custom/' + model.review, effort: 'off', timeoutMs: 90000 },
    evidence: { originalRequirements, groundTruth, snapshot },
    request: {
      reviewScope: { kind: 'workspace-stop', objectIds: [], sourceIds: [] },
      fixedStopClassification: stopClass, workflowStages: [],
      hook: { last_assistant_message: snapshot.entries.at(-1).message.content },
      population: { metrics: {}, reviewPolicy: { deviationOnly: spec.deviationOnly ?? true, metrics: { M11: true, M16: true } } },
    },
    async onPrepared(value) { prepared = value; },
  };
  let result;
  try {
    const handle = await factory(input);
    result = { reviewCompleted: handle.reviewCompleted, collection: handle.collection, review: handle.result };
    await handle.close();
  } catch (error) {
    result = { code: error.code, error: error.message, cause: error.cause?.message };
  }
  const directoryOfReview = prepared?.requestDirectory;
  const observations = directoryOfReview ? (await jsonLines(path.join(directoryOfReview, 'observations.jsonl'))) : [];
  const reads = observations.flatMap(entry => {
    const m = entry.message;
    if (m?.role !== 'toolResult' || m.toolName !== 'source_read') return [];
    const citation = m.details.citation;
    const text = m.content[0].text;
    return [{ id: m.toolCallId, path: citation.path, start: citation.start, end: citation.end,
      sha256: hash(text), chars: text.length, category: path.relative(directoryOfReview, citation.path).split(path.sep)[0] === 'execution'
        ? 'execution' : citation.path.startsWith(path.join(spec.repo, 'src') + path.sep) ? 'source' : 'basis' }];
  });
  const transcript = record.sessionFile ? await jsonLines(record.sessionFile) : [];
  const evidence = { ...record, reply: undefined, nativeResults, result, reads, reviewDirectory: directoryOfReview,
    pressureLog: await pressureLog(record.sessionKey),
    ...(spec.snapshot ? { originalUsers: originalRequirements.userMessages.map(message => ({
      hash: message.sha256, bytes: Buffer.byteLength(message.text) })), namedReferences: originalRequirements.referencedFiles.length }
      : { attachmentBytes: (await fs.stat(spec.contract)).size }),
    basisFiles: prepared?.request?.task?.basisFiles,
    hostCompactions: transcript.filter(entry => entry.type === 'compaction')
      .map(entry => ({ tokensBefore: entry.tokensBefore, summaryChars: entry.summary?.length })),
    transcriptSourceResults: transcript.filter(entry => entry.message?.toolName === 'source_read').length };
  await writeJson(path.join(directory, 'evidence.json'), evidence);
  prepared = null;
  return evidence;
}

async function businessCase(baseConfig, runtime, { name, seedTurns = 0, perTurn = 0, currentLines = 0, denseOld = false,
  initialPrompt, hostBudget = contextTokens, catalogWindow, providerWindow, maxOutput, reserveOutput, reply }) {
  const directory = path.join(outputRoot, name);
  await fs.mkdir(directory);
  const sessionFile = path.join(directory, 'session.jsonl');
  const sessionKey = 'agent:main:fixture-' + name;
  const sessionId = randomUUID();
  const record = { name, directory, sessionFile, sessionKey, requests: [], requestLimit: 64, contextTokens: hostBudget,
    providerWindow, reserveOutput, reply: reply ?? (() => ({ text: '已收到新的验收步骤。' })) };
  activeCase = record;
  const config = structuredClone(baseConfig);
  config.agents.defaults.model.primary = 'custom/' + model.business;
  config.agents.defaults.contextTokens = hostBudget;
  const businessModel = config.models.providers.custom.models.find(item => item.id === model.business);
  if (catalogWindow) businessModel.contextWindow = catalogWindow;
  if (maxOutput) businessModel.maxTokens = maxOutput;
  const history = sessions.SessionManager.open(sessionFile);
  const now = Date.now() - 120000;
  const estimateMessages = [];
  for (let turn = 0; turn < seedTurns; turn++) {
    const user = { role: 'user', content: denseOld && turn === 0 ? denseText(2900) : chineseText(perTurn, turn), timestamp: now + 2 * turn };
    const assistant = { role: 'assistant', content: [{ type: 'text', text: '已记录当前阶段的验收条件。' }],
      api: 'openai-completions', provider: 'custom', model: model.business, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: now + 2 * turn + 1 };
    history.appendMessage(user);
    history.appendMessage(assistant);
    estimateMessages.push({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content[0].text });
  }
  const prompt = initialPrompt ?? (currentLines ? chineseText(currentLines) : '请继续之前的验收，给出下一步。');
  estimateMessages.push({ role: 'user', content: prompt });
  const plain = { model: model.business, messages: estimateMessages };
  const before = { ...await count(plain), precheck: estimate(plain, hostBudget) };
  let result;
  try {
    const outcome = await runtime.agent.runEmbeddedAgent({
      config, sessionId, sessionKey, runId: randomUUID(), sessionFile, agentId: 'main', agentDir: config.agents.list[0].agentDir,
      workspaceDir: config.agents.defaults.workspace, cwd: config.agents.defaults.workspace, provider: 'custom', model: model.business,
      agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [], prompt, timeoutMs: 60000, runTimeoutOverrideMs: 60000,
      abortSignal: AbortSignal.timeout(60000), toolsAllow: ['read'], disableMessageTool: true, promptMode: 'minimal',
      bootstrapContextMode: 'lightweight', skillsSnapshot: { prompt: '', skills: [] }, thinkLevel: 'off',
    });
    result = { meta: outcome.meta, text: outcome.payloads?.map(item => item.text).filter(Boolean) };
  } catch (error) {
    result = { code: error.code, error: error.message };
  }
  const transcript = await jsonLines(sessionFile);
  const evidence = { ...record, reply: undefined, before, result, pressureLog: await pressureLog(sessionKey),
    hostCompactions: transcript.filter(entry => entry.type === 'compaction')
      .map(entry => ({ tokensBefore: entry.tokensBefore, summaryChars: entry.summary?.length })) };
  await writeJson(path.join(directory, 'evidence.json'), evidence);
  return evidence;
}

async function calibration() {
  const results = {};
  const tool = { type: 'function', function: { name: 'source_read', description: 'Read a source page',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
  const system = { role: 'system', content: 'Review the SDD workflow against the original source and execution evidence.' };
  for (const profile of [
    { id: 'business-chinese', model: model.business, prompt: chineseText(1500) },
    { id: 'review-source', model: model.review, toolResults: Array.from({ length: 6 }, (_, stage) => sourceText(stage, 160)) },
    { id: 'review-dense', model: model.review, toolResults: Array.from({ length: 8 }, (_, stage) => denseText(240, stage)) },
  ]) {
    const messages = [system, { role: 'user', content: profile.prompt ?? 'Check the original SDD sources.' }];
    for (const [index, content] of (profile.toolResults ?? []).entries()) {
      const id = 'calibration-' + index;
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: {
        name: 'source_read', arguments: JSON.stringify({ path: 'source-' + index + '.json' }),
      } }] }, { role: 'tool', content, tool_call_id: id });
    }
    const payload = { model: profile.model, messages, ...(profile.toolResults ? { tools: [tool] } : {}) };
    const counted = await count(payload);
    const pressure = estimate(payload);
    results[profile.id] = { ...counted, precheck: pressure, model: profile.model,
      errorPercent: Math.round((pressure.estimatedPromptTokens / counted.tokens - 1) * 1000) / 10 };
  }
  return results;
}

function localProjection() {
  const evidence = Array.from({ length: 12 }, (_, index) => ({
    role: 'toolResult', toolName: 'source_read', toolCallId: 'projection' + index,
    content: [{ type: 'text', text: sourceText(index, 154) }],
  }));
  const textOf = rows => rows.map(row => row.content[0].text);
  const original = textOf(evidence);
  const narrow = hostTruncation.c(evidence.slice(0, 8), contextTokens, toolResultCap);
  const projected = hostTruncation.c(evidence, contextTokens, toolResultCap);
  const size = rows => textOf(rows).reduce((total, value) => total + value.length, 0);
  const serializedSummary = core.serializeConversation(evidence.slice(0, 1));
  assert(Math.max(...original.map(value => value.length)) < toolResultCap);
  assert.equal(narrow.truncatedCount, 0);
  assert(projected.aggregateTruncatedCount > 0);
  assert(size(projected.messages) <= projected.aggregateBudgetChars);
  assert.deepEqual(textOf(evidence), original);
  assert(serializedSummary.includes('more characters truncated'));
  assert(serializedSummary.length < original[0].length);
  return { results: evidence.length, beforeChars: size(evidence), afterChars: size(projected.messages),
    truncatedResults: projected.truncatedCount, aggregateTruncatedResults: projected.aggregateTruncatedCount,
    aggregateBudgetChars: projected.aggregateBudgetChars, controlTruncatedResults: narrow.truncatedCount,
    firstToolResultChars: original[0].length, firstToolResultAsSummaryChars: serializedSummary.length };
}

function verify(results) {
  const failures = [];
  const expect = (name, condition, message) => {
    if (!condition) failures.push({ case: name, message });
  };
  function checkCase(name, verifyCase) {
    if (!enabled(name)) return;
    const record = results.cases.find(entry => entry.name === name);
    expect(name, record, 'Missing evidence');
    if (record) {
      const check = (condition, message) => expect(name, condition, message);
      check(!record.transportErrors?.length, 'Fixture transport failed');
      verifyCase(record, check);
    }
  }
  const promptPeak = record => Math.max(0, ...record.requests.filter(row => row.kind === 'prompt').map(row => row.inputTokens));
  const readCount = (record, category) => record.reads.filter(row => row.category === category).length;
  const overflow = record => record.pressureLog.some(line => line.includes('[context-overflow-diag]'));
  const summaries = (record, response) => record.requests.filter(row => row.kind === 'compaction' && row.response === response);
  const cal = results.calibration;
  if (cal) {
    expect('calibration', cal['business-chinese'].errorPercent > 0, 'The Chinese host sample should be overestimated');
    expect('calibration', cal['review-source'].errorPercent > 0, 'The ordinary TypeScript sample should be overestimated');
    expect('calibration', cal['review-dense'].errorPercent < 0, 'The dense path sample should be underestimated');
  }
  checkCase('review-small', (record, check) => {
    check(record.result.reviewCompleted === true, 'Stop did not complete');
    check(record.submissions.some(row => row.processNavigationOmitted === true), 'SOURCE-only scope did not omit process navigation');
    check(readCount(record, 'execution') === 0 && readCount(record, 'source') === 1, 'Unexpected evidence scope');
  });
  checkCase('review-large', (record, check) => {
    check(record.result.reviewCompleted === true, 'Stop did not recover and complete');
    check(readCount(record, 'source') === 5 && readCount(record, 'execution') === 8, 'Missing source or execution receipts');
    check(overflow(record) && record.hostCompactions.length && summaries(record, 'fixture_summary').length, 'Missing native recovery evidence');
    check(record.reads.length > record.requests.at(-1)?.toolResults.length, 'Compaction should retire earlier pages from prompt history');
  });
  checkCase('review-overflow', (record, check) => {
    check(record.result.reviewCompleted === false, 'Expected a partial review');
    check(readCount(record, 'source') > 0 && readCount(record, 'source') < 16, 'Expected retained partial source receipts');
    check(overflow(record) && record.hostCompactions.length, 'Expected native compaction followed by renewed pressure');
  });
  checkCase('review-wide-context', (record, check) => {
    check(record.pressureLog.some(line => line.includes('contextTokenBudget=600000')), 'The wider window did not reach the host');
    check(record.result.reviewCompleted === true && readCount(record, 'source') === 16, 'Same workload should finish in the wider test window');
    check(record.hostCompactions.length === 0 && promptPeak(record) > 100000, 'Expected accumulation above 100K tokens before compaction');
    let previous = [];
    for (const request of record.requests.filter(row => row.kind === 'prompt')) {
      const ids = new Set(request.toolResults.map(row => row.id));
      check(previous.every(id => ids.has(id)), 'Unexpected loss of an earlier tool result before compaction');
      previous = [...ids];
    }
  });
  checkCase('review-page-cap', (record, check) => {
    const original = record.calls.find(call => call.name === 'source_read' && call.args.path.endsWith('page-probe.md'));
    const first = record.requests.flatMap(row => row.toolResults).find(row => row.id === original?.id);
    const retries = record.reads.filter(row => row.path === original?.args.path);
    check(first?.truncated && first.chars <= toolResultCap, 'No native truncation at the single-result cap');
    check(!record.reads.some(row => row.id === original?.id), 'A clipped read unexpectedly received original evidence credit');
    check(record.submissions.some(row => row.error?.includes('Required original basis not fully read')), 'Unread original did not block checklist creation');
    check(retries.length >= 2 && record.result.reviewCompleted === true, 'Narrower pages did not recover the identical required file');
  });
  checkCase('review-dense-overflow', (record, check) => {
    const missed = record.requests.find(row => row.kind === 'prompt' && row.response === 'fixture_context_overflow');
    check(missed?.wireEstimate.route === 'fits' && missed.inputTokens >= record.providerWindow, 'Missing tokenizer-confirmed precheck miss');
    check(record.pressureLog.some(line => line.includes('source=assistantError')), 'Native host did not observe rejection');
  });
  checkCase('business-history', (record, check) => {
    check(record.before.precheck.route === 'compact_only' && record.before.tokens < contextTokens - reserveTokens, 'Missing Chinese estimate false positive');
    check(record.hostCompactions.length && summaries(record, 'fixture_summary').length, 'Missing real compaction cycle');
    check(record.result.text?.includes('已收到新的验收步骤。'), 'The host did not resume with the scripted answer');
  });
  checkCase('business-false-positive', (record, check) => {
    check(record.before.tokens < contextTokens - reserveTokens && record.before.precheck.route === 'compact_only', 'Expected a false positive with spare context');
    check(record.requests.length === 0 && record.hostCompactions.length === 0, 'Expected the host to stop before submitting the current input');
    check(record.result.text?.some(text => text.includes('Context overflow')), 'Expected the native blocked reply');
  });
  checkCase('business-single-input', (record, check) => {
    check(record.before.tokens >= modelWindow && record.requests.length === 0, 'Expected a single over-window prompt blocked before transport');
    check(record.hostCompactions.length === 0 && record.result.text?.some(text => text.includes('Context overflow')), 'Oversized current input unexpectedly progressed');
  });
  checkCase('business-summary-overflow', (record, check) => {
    check(record.requests.some(row => row.kind === 'prompt' && row.response === 'fixture_context_overflow'), 'Expected oversized original request');
    check(summaries(record, 'fixture_context_overflow').some(row => row.inputTokens >= modelWindow), 'Expected oversized compaction payload');
    check(record.result.text?.some(text => text.includes('Context overflow')), 'Expected exhausted native recovery');
  });
  expect('offline', results.deniedSockets === 0, 'Unexpected socket attempt');
  if (enabled('initial-sdd-164k')) {
    expect('initial-sdd-164k', results.initialSdd?.verified === true, 'Initial SDD study did not finish');
  }
  if (enabled('single-required-file')) {
    expect('single-required-file', results.singleRequired?.verified === true, 'Single mandatory file cases did not verify');
  }
  return failures;
}

const results = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, windowsHide: true, encoding: 'utf8' }).trim(),
  host: { root: hostRoot, version: hostPackage.version, modelWindow, contextTokens, reserveTokens, toolResultCap,
    cacheTtlEligible: { business: cacheTtlEligible('custom', model.business, 'openai-completions'),
      reviewer: cacheTtlEligible('custom', model.review, 'openai-completions') } },
  harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
  tokenizer, realProviderRequests: 0, cases: [], outputRoot };
try {
  if (enabled('calibration')) results.calibration = await calibration();
  if (enabled('local-projection')) results.localProjection = localProjection();
  if (!selectedCases || selectedCases.some(name => !['calibration', 'local-projection'].includes(name))) {
    const repository = await createRepository(outputRoot);
    results.repository = repository;
    const plugin = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(outputRoot, 'build') });
    const config = {
      logging: { level: 'debug', consoleLevel: 'silent', file: path.join(outputRoot, 'host.log') },
      agents: { defaults: {
        workspace: repository.repo, model: { primary: 'custom/' + model.review }, contextTokens,
        contextLimits: defaults.contextLimits, contextPruning: defaults.contextPruning, compaction: defaults.compaction,
        memorySearch: { enabled: false }, sandbox: { mode: 'off' }, skipBootstrap: true,
      }, list: [{ id: 'main', agentDir: path.join(stateDir, 'agent') }] },
      session: { store: path.join(stateDir, 'sessions.json') },
      models: { mode: 'replace', providers: { custom: {
        api: 'openai-completions', apiKey: 'isolated-fixture-dummy', baseUrl: endpoint + '/v1',
        models: Object.values(model).map(id => ({ id, name: id, input: ['text'], reasoning: false, contextWindow: modelWindow, maxTokens: 65536,
          compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens', supportsReasoningEffort: false, supportsStore: false, supportsDeveloperRole: false } })),
      } } },
      plugins: { enabled: true, allow: ['runtime-corrector'], load: { paths: [plugin] },
        entries: { 'runtime-corrector': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } },
    };
    await writeJson(process.env.OPENCLAW_CONFIG_PATH, config);
    const { createPluginRuntime } = await hostImport('dist/plugins/runtime/index.js');
    const { s: loadPlugins } = await hostImport('dist/loader-D8d2EvVh.js');
    const registry = loadPlugins({ config, workspaceDir: repository.repo, activate: true, onlyPluginIds: ['runtime-corrector'] });
    assert(registry.plugins.some(item => item.id === 'runtime-corrector' && item.status === 'loaded'), JSON.stringify(registry.diagnostics));
    const runtime = createPluginRuntime();
    runtime.config.current = () => config;
    for (const spec of [
      { name: 'review-small', attachment: 'short.md', sources: ['src/small.mjs'] },
      { name: 'review-large', attachment: 'workflow.md', sources: Array.from({ length: 5 }, (_, index) => sourceName(index + 1)), process: true },
      { name: 'review-overflow', attachment: 'workflow.md', sources: Array.from({ length: 16 }, (_, index) => sourceName(index + 1)), process: true, batch: 3 },
      { name: 'review-wide-context', attachment: 'workflow.md', sources: Array.from({ length: 16 }, (_, index) => sourceName(index + 1)),
        process: true, batch: 3, window: 600000 },
      { name: 'review-page-cap', attachment: 'page-probe.md', sources: [], wide: true },
      { name: 'review-dense-overflow', attachment: 'short.md', sources: Array.from({ length: 7 }, (_, index) => 'src/dense-' + (index + 1) + '.log'), batch: 2 },
    ]) {
      if (!enabled(spec.name)) continue;
      const record = await reviewCase(config, runtime, { ...spec, repo: repository.repo, contract: path.join(repository.repo, 'contracts', spec.attachment) });
      results.cases.push(record);
      console.log(JSON.stringify({ case: spec.name, requests: record.requests.length, completed: record.result.reviewCompleted,
        peakInput: Math.max(0, ...record.requests.map(request => request.inputTokens)), reads: record.reads.length, error: record.result.code }));
    }
    for (const spec of [
      { name: 'business-history', seedTurns: 10, perTurn: 365 },
      { name: 'business-false-positive', currentLines: 3500 },
      { name: 'business-single-input', currentLines: 5900 },
      { name: 'business-summary-overflow', seedTurns: 7, perTurn: 90, denseOld: true },
    ]) {
      if (!enabled(spec.name)) continue;
      const record = await businessCase(config, runtime, spec);
      results.cases.push(record);
      console.log(JSON.stringify({ case: spec.name, requests: record.requests.length,
        compactions: record.hostCompactions.length, before: record.before.tokens, error: record.result.error }));
    }
    if (enabled('initial-sdd-164k')) {
      results.initialSdd = await runInitialSdd({ outputRoot, repo: repository.repo, count, model, modelWindow,
        business: spec => businessCase(config, runtime, spec),
        review: spec => reviewCase(config, runtime, { ...spec, repo: repository.repo }) });
    }
    if (enabled('single-required-file')) {
      results.singleRequired = await runSingleRequiredFile({ outputRoot, repo: repository.repo, count, model, modelWindow, toolResultCap,
        review: spec => reviewCase(config, runtime, { ...spec, repo: repository.repo }) });
    }
  }
} finally {
  results.deniedSockets = socketAttempts;
  results.validationFailures = verify(results);
  await writeJson(path.join(outputRoot, 'result.json'), results);
  python.stdin.end();
  net.Socket.prototype.connect = old.connect;
  dns.lookup = old.lookup;
  dnsPromises.lookup = old.promiseLookup;
  syncBuiltinESMExports();
  globalThis.fetch = old.fetch;
  globalThis[runtimeKey] = old.undici;
}
console.log(JSON.stringify({ result: path.join(outputRoot, 'result.json'), failures: results.validationFailures }));
if (results.validationFailures.length) process.exitCode = 1;
