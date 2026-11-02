#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { REQUIREMENTS, INITIAL_DESIGN } from './evaluate-document-e2e.mjs';
import { resolveReviewTimeoutMs } from '../lib/review-timeout.mjs';
import { assessDocumentCopy } from '../lib/document-copy.mjs';
import { changedFiles } from '../lib/openclaw/tools.mjs';
export { assessDocumentCopy } from '../lib/document-copy.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function documentMutations(snapshot, projectRoot) {
  const messages = (snapshot.messages ?? []).map(item => item.message ?? item);
  const succeeded = new Set(messages.filter(item => item.role === 'toolResult' && !item.isError).map(item => item.toolCallId));
  return messages.flatMap(item => item.role === 'assistant' && Array.isArray(item.content) ? item.content : [])
    .filter(call => ['toolCall', 'tool_use'].includes(call.type) && succeeded.has(call.id)
      && changedFiles(call.name, call.arguments ?? call.input ?? {}, projectRoot).includes(path.join(projectRoot, 'design.md')));
}

export function locateDocumentFaults(faults, actualText) {
  return faults.map(fault => {
    const needle = fault.draft.replace(/[ \t]+$/u, '');
    assert(needle.trim(), 'A controlled deviation must contain text');
    const offset = actualText.indexOf(needle);
    assert(offset >= 0, 'The initial candidate pre-repaired or omitted a controlled deviation');
    return { sourceLine: fault.line, actualLine: actualText.slice(0, offset).split('\n').length };
  });
}
export function openclawDocumentOptions(input = {}) {
  const defaults = { reviewTimeoutMs: 600000, baselineTimeoutMs: 1200000, hookTimeoutMs: 1200000, businessTimeoutMs: 1800000, totalTimeoutMs: 1800000, baselineFormatRepairAttempts: 12 };
  for (const key of Object.keys(input)) assert(Object.hasOwn(defaults, key), `Unknown OpenClaw document option: ${key}`);
  const result = { ...defaults, ...input };
  assert(Number.isInteger(result.baselineFormatRepairAttempts) && result.baselineFormatRepairAttempts >= 0 && result.baselineFormatRepairAttempts <= 20, 'baselineFormatRepairAttempts must be an integer from 0 to 20');
  for (const [key, value] of Object.entries(result).filter(([key]) => key.endsWith('TimeoutMs'))) {
    resolveReviewTimeoutMs(value, key);
    assert(value % 1000 === 0 && (key !== 'hookTimeoutMs' || value >= 2000), `${key} must use whole seconds`);
  }
  return result;
}

async function providerEnvironment(settingsPath) {
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL) {
    assert(process.env.ANTHROPIC_BASE_URL && (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY)
      && (process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL),
    'Supply a complete provider environment (endpoint, credential and model); do not mix credentials between configured providers');
  } else {
    const settings = JSON.parse(await fs.readFile(settingsPath ?? path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
    // Reuse only the explicitly configured provider. Credentials remain in
    // process memory and the host's ordinary authentication environment.
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'])
      if (!process.env[key] && settings.env?.[key]) process.env[key] = settings.env[key];
  }
  assert(process.env.ANTHROPIC_BASE_URL && (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY), 'Configured provider credentials are required');
  assert(process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL, 'An explicit configured model is required');
}

export const documentHookPolicy = (model, options, dynamicBaseline = false, providerId = 'anthropic') => `version: 2
locale: en
groundTruth:
  - id: original-requirements
    type: user-confirmed-requirement
    authority: user
    required: true
    patterns: [requirements.md]
artifacts:
  - name: design
    stage: solution-design
    format: markdown
    patterns: [design.md]
    groundTruth: [original-requirements]
    rules:
      enabled: false
    review:
      enabled: true
      criteria: document-review.md
      copyFrom: original-requirements
dynamicGroundTruth:
  enabled: ${dynamicBaseline}
  materialRoots: []
  panel:
    size: 0
skillCorrection:
  enabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: ${dynamicBaseline}
  stageMetricsEnabled: false
limits:
  semanticReviewTimeoutMs: ${options.reviewTimeoutMs}
reviewers:
  defaults:
    model: ${providerId}/${model}
    effort: low
    timeoutMs: ${options.reviewTimeoutMs}
    maxOutputTokens: 16384
  groundTruthExtractor:
    effort: high
    timeoutMs: ${options.baselineTimeoutMs}
    maxOutputTokens: 32768
    formatRepairAttempts: ${options.baselineFormatRepairAttempts ?? 12}
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`;

async function journal(projectRoot, task, store) {
  if (!task) return [];
  const file = path.join(store.taskDirectory(projectRoot, task.taskId), 'journal/events.jsonl');
  return (await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Static document-only policy intentionally has no dynamic task ledger. Its
// authoritative evidence is the session-scoped production artifact result and
// the matching tool result actually committed to the native conversation.
export async function collectAutomaticDocumentEvidence(projectRoot, snapshot, sessionId) {
  const root = path.join(projectRoot, '.runtime-correction/openclaw/session-artifacts'), artifacts = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'latest') await walk(file);
      else if (entry.isFile() && entry.name === 'result.json' && file.includes(`${path.sep}runs${path.sep}`)) {
        const result = JSON.parse(await fs.readFile(file, 'utf8'));
        if (result.metadata?.semanticReview?.parentSessionId === sessionId) artifacts.push({ file, result,
          scopeTaskId: path.relative(root, file).split(path.sep)[0] });
      }
    }
  }
  await walk(root);
  const messages = (snapshot?.messages ?? []).map(item => item.message ?? item);
  const receipts = messages.filter(item => item.role === 'toolResult' && !item.isError)
    .map(item => ({ toolCallId: item.toolCallId, toolName: item.toolName,
      text: (item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n') }))
    .filter(item => item.text.includes('[runtime-corrector:feedback]'));
  const reviews = artifacts.sort((a, b) => a.result.metadata.roundId.localeCompare(b.result.metadata.roundId))
    .map(item => ({ ...item, toolCallId: receipts.find(receipt => receipt.text.includes(item.result.metadata.roundId))?.toolCallId }));
  return { reviews, receipts };
}

export async function loadDocumentBenchmark(directory) {
  const specification = JSON.parse(await fs.readFile(path.join(directory, 'case.json'), 'utf8'));
  const requirements = await fs.readFile(path.join(directory, 'requirements.md'), 'utf8');
  const draft = await fs.readFile(path.join(directory, 'draft.md'), 'utf8');
  assert.equal(hash(requirements), specification.originalSha256, 'Benchmark original source identity changed');
  for (const fault of specification.faults)
    assert(requirements.includes(fault.original) && draft.includes(fault.draft), 'Benchmark fault does not match its frozen source');
  return { specification, requirements, draft };
}

export async function runOpenClawDocumentE2E({ hostRoot, outputRoot, options = {}, settingsPath, dynamicBaseline = false, benchmarkDirectory }) {
  const config = openclawDocumentOptions(options), started = Date.now(), deadlineAt = started + config.totalTimeoutMs;
  const benchmark = benchmarkDirectory ? await loadDocumentBenchmark(path.resolve(benchmarkDirectory)) : null;
  const requirements = benchmark?.requirements ?? REQUIREMENTS, initialDesign = benchmark?.draft ?? INITIAL_DESIGN;
  await providerEnvironment(settingsPath);
  const nativeModel = process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL;
  const codingProvider = nativeModel === 'glm-5.3-flash' ? { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: nativeModel } : null;
  outputRoot = path.resolve(outputRoot);
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const projectRoot = path.join(outputRoot, 'project'); await fs.mkdir(projectRoot);
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'));
  await fs.writeFile(path.join(projectRoot, 'requirements.md'), requirements);
  await fs.writeFile(path.join(projectRoot, 'draft.md'), initialDesign);
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'Only design.md is editable.\n');
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), documentHookPolicy(nativeModel, config, dynamicBaseline, codingProvider ? 'openai' : 'anthropic'));
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/document-review.md'), 'Check the CURRENT design content against every declared requirements.md obligation. DOCUMENT-COPY-MISMATCH diagnostics already compare literal content, including fenced whitespace and EOF newlines. Do not dismiss or duplicate these deterministic findings. Source priority and author execution controls do not require an authority/adoption paragraph or test-scope disclaimer inside the document. Require such text only when an original source explicitly requests that output text or section. Preserve original heading levels and formatting. Report concrete current contradictions using accurate physical line numbers. Do not carry resolved findings into a new round. Return no semantic findings when compliant. Return edits: []; the main agent owns actual native edits. Do not edit files.\n');
  await fs.writeFile(path.join(outputRoot, 'options.json'), JSON.stringify(config, null, 2));
  let gateway, sessionKey, sessionId, runId, task, events = [], snapshot, privateRuns = [], failure, terminal = false, state = 'FAILED';
  let evidence = { reviews: [], receipts: [] }, terminalReceipt, baseline = null, artifactEvaluations = [], initialCopy = null, finalCopy = null, initialFaultLocations = [];
  let controllerCancelled = false;
  const cancel = () => { controllerCancelled = true; if (gateway && sessionKey && runId) gateway.request('chat.abort', { sessionKey, runId }).catch(() => {}); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    gateway = await createNativeGatewayEvaluation({ hostRoot, sourceRoot: SOURCE_ROOT, projectRoot, outputRoot,
      businessToolNames: ['read', 'write', 'edit'], businessToolDeny: ['runtime_corrector'], confineBusinessFiles: true,
      reviewerTimeoutMs: Math.max(config.reviewTimeoutMs, config.baselineTimeoutMs), hookTimeoutMs: config.hookTimeoutMs,
      businessTimeoutMs: config.businessTimeoutMs, disableMemoryFlush: true,
      ...(codingProvider ? { provider: codingProvider, providerGuard: { kind: 'authorized_native_document',
        credential: () => process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY } } : {}) });
    gateway.setPhase('automatic-document-hook');
    const load = name => import(pathToFileURL(path.join(gateway.pluginRoot, name)).href);
    const [store, runs] = await Promise.all([load('lib/runtime-v2/task-store.mjs'), load('lib/openclaw/native-runs.mjs')]);
    const created = await gateway.request('sessions.create', { key: `agent:main:document-e2e-${randomUUID()}`, agentId: 'main', label: 'Document automatic Hook acceptance' });
    assert(created.ok && created.key, 'The native Gateway did not create the session');
    sessionKey = created.key;
    const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
    await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
    const saved = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
    sessionId = saved.sessionId; runId = randomUUID();
    const message = `Document-copy task in ${projectRoot}: deliver design.md as the COMPLETE verbatim content of requirements.md. Add no text; preserve every character, indentation, line break and literal block, except trailing spaces/tabs outside fenced literal blocks may differ.
Initialize the candidate by reading ONLY draft.md and copying ALL of it unchanged, including its defects, into design.md with the write tool. Do not read requirements.md before this write returns automatic feedback.
Then read requirements.md, consume the automatic feedback, and use native edits to repair design.md until the latest automatic review passes with zero diagnostics. Use exact characters shown in feedback. After that pass, stop tool calls and give a brief reply.`;
    const accepted = await gateway.request('chat.send', { sessionKey, sessionId, message, idempotencyKey: runId,
      deliver: false, thinking: codingProvider ? 'low' : 'off', timeoutMs: Math.min(config.businessTimeoutMs, deadlineAt - Date.now()) });
    assert(accepted.runId, 'The Gateway did not accept the actual business request');
    console.log(JSON.stringify({ state: 'native-business-started', sessionId, runId, outputRoot }));
    let previous = '';
    while (Date.now() < deadlineAt) {
      if (controllerCancelled) throw Object.assign(new Error('Experiment controller requested cancellation'), { code: 'DOCUMENT_EVALUATION_CANCELLED' });
      await gateway.drain();
      task = await store.findTask({ projectRoot, sessionId }); events = await journal(projectRoot, task, store);
      snapshot = await gateway.runtime.subagent.getSession({ sessionKey });
      evidence = await collectAutomaticDocumentEvidence(projectRoot, snapshot, sessionId);
      const messages = (snapshot.messages ?? []).map(item => item.message ?? item);
      const last = messages.at(-1);
      terminal = last?.role === 'assistant' && ['stop', 'error', 'aborted'].includes(last.stopReason);
      const reviews = evidence.reviews;
      const progress = JSON.stringify({ baselineVersion: task?.groundTruth?.version ?? 0, reviews: reviews.map(item => item.result.status), terminal, modelStarts: gateway.metrics().modelStarts.length });
      if (progress !== previous) { console.log(progress); previous = progress; }
      if (terminal) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!terminal) {
      await gateway.request('chat.abort', { sessionKey, runId }).catch(() => {});
      throw Object.assign(new Error('Automatic document loop exceeded the configured total deadline'), { code: 'DOCUMENT_HOOK_TIMEOUT' });
    }
    terminalReceipt = await gateway.runtime.subagent.waitForRun({ runId: accepted.runId,
      timeoutMs: Math.max(1, deadlineAt - Date.now()) });
    privateRuns = (await Promise.all([...new Set(evidence.reviews.map(item => item.scopeTaskId))]
      .map(id => runs.listNativeRuns(projectRoot, id)))).flat();
    await fs.writeFile(path.join(outputRoot, 'business-session.json'), JSON.stringify(snapshot, null, 2));
    await fs.writeFile(path.join(outputRoot, 'automatic-hook-events.json'), JSON.stringify(events, null, 2));
    assert.equal((snapshot.messages.at(-1).message ?? snapshot.messages.at(-1)).stopReason, 'stop', 'The original native model did not finish normally');
    assert.equal(terminalReceipt.status, 'ok', terminalReceipt.error ?? 'The native Gateway did not acknowledge normal run completion');
    const reviews = evidence.reviews, delivered = evidence.receipts;
    const calls = (snapshot.messages ?? []).flatMap(item => (item.message ?? item).role === 'assistant'
      ? (item.message ?? item).content ?? [] : []).filter(item => ['toolCall', 'tool_use'].includes(item.type));
    const writes = documentMutations(snapshot, projectRoot);
    const finalDesign = await fs.readFile(path.join(projectRoot, 'design.md'), 'utf8');
    const firstWrite = writes.find(call => call.name.toLowerCase() === 'write');
    const firstWrittenText = (firstWrite?.arguments ?? firstWrite?.input)?.content;
    assert.equal(typeof firstWrittenText, 'string', 'Initial business write content is unavailable');
    initialFaultLocations = benchmark ? locateDocumentFaults(benchmark.specification.faults, firstWrittenText) : [];
    assert(reviews.length >= 2, 'Fewer than two automatic artifact reviews were recorded');
    const expectedLines = benchmark ? initialFaultLocations.map(item => item.actualLine) : [2];
    for (const line of expectedLines)
      assert(reviews[0].result.diagnostics.some(item => item.severity === 'error' && item.path === 'design.md' && item.line === line), `Initial automatic review did not locate the controlled deviation at line ${line}`);
    assert.equal(reviews.at(-1).result.status, 'passed', 'Final automatic document review did not pass');
    assert.equal(reviews.at(-1).result.diagnostics.length, 0, 'Final automatic review retained findings');
    assert(writes.length >= 2, 'The business model did not perform both the initial write and real repair');
    assert(reviews[0].toolCallId && delivered.some(event => event.toolCallId === reviews[0].toolCallId), 'Initial finding was not delivered through actual host tool-result middleware');
    assert(!calls.some(call => call.name === 'runtime_corrector'), 'A manual check replaced the required automatic Hook');
    assert(JSON.stringify(snapshot).includes('[runtime-corrector:feedback]'), 'Native business transcript omitted automatic review feedback');
    assert(privateRuns.length >= 2 && privateRuns.every(item => item.status === 'SETTLED'), 'Private native reviews did not settle');
    initialCopy = assessDocumentCopy(initialDesign, firstWrittenText);
    // A copied candidate may acquire additional deviations: the automatic loop
    // must repair them too. The immutable seed and actual reviewed hash remain
    // evidence; only the final document can establish full-copy compliance.
    assert.equal(reviews[0].result.metadata.inputs.find(item => item.path === 'design.md')?.sha256, hash(firstWrittenText), 'Initial review did not inspect the actual bytes written by the business agent');
    assert.equal(reviews.at(-1).result.metadata.inputs.find(item => item.path === 'design.md')?.sha256, hash(finalDesign), 'Final review did not inspect the current repaired bytes');
    assert(gateway.metrics().modelStarts.some(item => item.runId === runId && item.sessionId === sessionId), 'No actual original business model start was observed');
    assert.equal(await fs.readFile(path.join(projectRoot, 'requirements.md'), 'utf8'), requirements, 'Original requirements changed');
    if (benchmark) {
      finalCopy = assessDocumentCopy(requirements, finalDesign);
      assert(finalCopy.equivalent, 'Final document adds or changes content beyond the complete original requirements');
    } else assert(!finalDesign.includes('https://telemetry.example.invalid/collect') && /local|device/iu.test(finalDesign)
      && /validat/iu.test(finalDesign) && /pars/iu.test(finalDesign) && /error/iu.test(finalDesign), 'Independent current-document fixture check failed');
    if (dynamicBaseline) {
      const id = task?.taskId ?? evidence.reviews[0].scopeTaskId;
      baseline = await (await load('lib/runtime-v2/ground-truth-ledger.mjs')).loadCurrentGroundTruth(projectRoot, id);
      assert(baseline.version > 0 && baseline.claims.length > 0, 'No model-extracted dynamic baseline was formally published');
      assert(privateRuns.some(item => item.role === 'ground-truth-extractor'), 'No real native baseline extraction occurred');
      const directory = path.join(store.taskDirectory(projectRoot, id), 'evaluations');
      for (const name of await fs.readdir(directory)) if (name.startsWith('artifact-') && name.endsWith('.json'))
        artifactEvaluations.push(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')));
      assert(artifactEvaluations.length >= 2 && artifactEvaluations.every(item => item.groundTruthVersion > 0), 'Automatic document reviews were not bound to the published dynamic baseline');
      await fs.writeFile(path.join(outputRoot, 'dynamic-baseline.json'), JSON.stringify(baseline, null, 2));
    }
    state = 'PASSED';
  } catch (error) {
    let message = String(error.message);
    for (const [key, secret] of Object.entries(process.env))
      if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(key) && secret?.length > 7) message = message.split(secret).join('[REDACTED]');
    failure = { code: error.code ?? 'OPENCLAW_DOCUMENT_E2E_FAILED', message };
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await gateway?.close();
  }
  const report = { kind: 'openclaw-automatic-document-hook-live-e2e', state, startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started, options: config,
    sessionKey, sessionId, runId, taskId: task?.taskId ?? evidence.reviews[0]?.scopeTaskId, terminal, terminalReceipt, failure, projectRoot,
    gateway: gateway?.metrics(), privateRuns, reviews: evidence.reviews, dynamicBaseline, baseline, artifactEvaluations,
    benchmark: benchmark?.specification ?? null, initialCopy, finalCopy, initialFaultLocations,
    feedbackReceipts: evidence.receipts,
    effectiveTimeouts: gateway ? { reviewerTimeoutMs: gateway.config.plugins.entries['runtime-corrector'].config.reviewerTimeoutMs,
      hookTimeoutMs: gateway.config.plugins.entries['runtime-corrector'].config.hookTimeoutMs,
      hostBusinessTimeoutMs: gateway.config.agents.defaults.timeoutSeconds * 1000 } : null,
    finalDesign: await fs.readFile(path.join(projectRoot, 'design.md'), 'utf8').catch(() => null),
    limitations: ['Controlled fictional draft; the model performs the initial write and repair through the actual native Gateway.',
      dynamicBaseline ? 'Real dynamically extracted baseline plus automatic document review; Skill, implementation checking, Stop and official benchmark execution are disabled.'
        : 'Declared original requirements are reviewed directly; dynamic baseline, Skill and Stop are separate workflows.'] };
  report.sourceHashes = Object.fromEntries(await Promise.all([
    'scripts/evaluate-openclaw-document-e2e.mjs', 'scripts/helpers/native-gateway-evaluation.mjs',
    'lib/openclaw/entry.mjs', 'lib/openclaw/runtime.mjs', 'lib/openclaw/reviewer.mjs', 'lib/document-tools.mjs',
    'lib/document-copy.mjs', 'lib/artifact-checker.mjs', 'lib/rules/engine.mjs', 'lib/policy/compiler.mjs', 'config/schemas/project-config.schema.json', 'packaging/runtime-modules.json',
    'lib/semantic-review.mjs', 'lib/review-timeout.mjs', 'skills/document-corrector/SKILL.md',
    'lib/runtime-v2/orchestrator.mjs', 'lib/runtime-v2/ground-truth-ledger.mjs',
    'lib/runtime-v2/baseline-task.mjs', 'lib/openclaw/task-session.mjs',
  ].map(async name => [name, hash(await fs.readFile(path.join(SOURCE_ROOT, name)))])));
  if (gateway) report.testedProductionHashes = Object.fromEntries(await Promise.all([
    'lib/review-task/task-evidence.mjs', 'lib/review-task/baseline-task.mjs', 'lib/openclaw/reviewer.mjs', 'lib/artifact-checker.mjs', 'lib/document-tools.mjs', 'lib/openclaw/runtime.mjs', 'lib/rules/engine.mjs', 'lib/runtime-v2/baseline-task.mjs', 'lib/runtime-v2/orchestrator.mjs'
  ].map(async name => [name, hash(await fs.readFile(path.join(gateway.pluginRoot, name)))])));
  await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (!args.includes('--live') || !value('--host-root') || !value('--output-root'))
    throw new Error('Use --live --host-root <installed-openclaw> --output-root <fresh-directory> [--dynamic-baseline] [--benchmark-case <directory>] [--config <json>] [--baseline-timeout-ms N] [--review-timeout-ms N] [--hook-timeout-ms N] [--business-timeout-ms N] [--total-timeout-ms N]');
  const options = value('--config') ? JSON.parse(await fs.readFile(value('--config'), 'utf8')) : {};
  for (const name of ['review', 'baseline', 'hook', 'business', 'total']) if (value(`--${name}-timeout-ms`) !== undefined)
    options[`${name}TimeoutMs`] = Number(value(`--${name}-timeout-ms`));
  const result = await runOpenClawDocumentE2E({ hostRoot: value('--host-root'), outputRoot: value('--output-root'), options, settingsPath: value('--claude-settings'),
    dynamicBaseline: args.includes('--dynamic-baseline'), benchmarkDirectory: value('--benchmark-case') });
  console.log(JSON.stringify({ state: result.state, elapsedMs: result.elapsedMs, reviews: result.reviews.length,
    feedbackReceipts: result.feedbackReceipts.length, failure: result.failure, outputRoot: path.resolve(value('--output-root')) }));
  // The pinned host retains internal observers after awaited Gateway shutdown.
  process.exit(result.state === 'PASSED' ? 0 : 1);
}
