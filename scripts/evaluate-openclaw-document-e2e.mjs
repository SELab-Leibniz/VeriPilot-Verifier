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

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function openclawDocumentOptions(input = {}) {
  const defaults = { reviewTimeoutMs: 600000, hookTimeoutMs: 1200000, businessTimeoutMs: 1800000, totalTimeoutMs: 1800000 };
  for (const key of Object.keys(input)) assert(Object.hasOwn(defaults, key), `Unknown OpenClaw document option: ${key}`);
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result)) {
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

const policy = (model, options) => `version: 2
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
dynamicGroundTruth:
  enabled: false
skillCorrection:
  enabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
limits:
  semanticReviewTimeoutMs: ${options.reviewTimeoutMs}
reviewers:
  defaults:
    model: anthropic/${model}
    effort: low
    timeoutMs: ${options.reviewTimeoutMs}
    maxOutputTokens: 16384
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

export async function runOpenClawDocumentE2E({ hostRoot, outputRoot, options = {}, settingsPath }) {
  const config = openclawDocumentOptions(options), started = Date.now(), deadlineAt = started + config.totalTimeoutMs;
  await providerEnvironment(settingsPath);
  outputRoot = path.resolve(outputRoot);
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const projectRoot = path.join(outputRoot, 'project'); await fs.mkdir(projectRoot);
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'));
  await fs.writeFile(path.join(projectRoot, 'requirements.md'), REQUIREMENTS);
  await fs.writeFile(path.join(projectRoot, 'draft.md'), INITIAL_DESIGN);
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'This is an isolated document review fixture. Only design.md is editable. Treat requirements.md as authoritative. Read all Runtime Corrector feedback attached to write/edit results and resolve concrete findings before finishing.\n');
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), policy(process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL, config));
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/document-review.md'), 'Check the CURRENT design against every declared requirements.md obligation. Report concrete current contradictions, using accurate physical line numbers and path:line: quoted evidence. Do not carry resolved findings into a new round. Return no findings when compliant. Do not edit files.\n');
  await fs.writeFile(path.join(outputRoot, 'options.json'), JSON.stringify(config, null, 2));
  let gateway, sessionKey, sessionId, runId, task, events = [], snapshot, privateRuns = [], failure, terminal = false, state = 'FAILED';
  let evidence = { reviews: [], receipts: [] }, terminalReceipt;
  try {
    gateway = await createNativeGatewayEvaluation({ hostRoot, sourceRoot: SOURCE_ROOT, projectRoot, outputRoot,
      businessToolNames: ['read', 'write', 'edit'], confineBusinessFiles: true,
      reviewerTimeoutMs: config.reviewTimeoutMs, hookTimeoutMs: config.hookTimeoutMs,
      businessTimeoutMs: config.businessTimeoutMs, disableMemoryFlush: true });
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
    const message = `Work only in ${projectRoot}. requirements.md is the complete original user-confirmed requirement. This is an automatic document-review exercise: first read draft.md and copy its bytes VERBATIM into design.md using write, so the configured automatic reviewer can inspect the initial draft. Then read the feedback attached to the actual write result and make the smallest required corrections in design.md. Continue until the automatic current-document reviewer reports no deviations. Preserve every original requirement, including local validation/errors and explicit exclusions. Only design.md may be changed. Do not edit requirements.md, draft.md, AGENTS.md or .runtime-corrector. Do not invoke runtime_corrector manually; automatic write/edit hooks own the review. Finish with a concise completion statement.`;
    const accepted = await gateway.request('chat.send', { sessionKey, sessionId, message, idempotencyKey: runId,
      deliver: false, thinking: 'off', timeoutMs: Math.min(config.businessTimeoutMs, deadlineAt - Date.now()) });
    assert(accepted.runId, 'The Gateway did not accept the actual business request');
    console.log(JSON.stringify({ state: 'native-business-started', sessionId, runId, outputRoot }));
    let previous = '';
    while (Date.now() < deadlineAt) {
      await gateway.drain();
      task = await store.findTask({ projectRoot, sessionId }); events = await journal(projectRoot, task, store);
      snapshot = await gateway.runtime.subagent.getSession({ sessionKey });
      evidence = await collectAutomaticDocumentEvidence(projectRoot, snapshot, sessionId);
      const messages = (snapshot.messages ?? []).map(item => item.message ?? item);
      const last = messages.at(-1);
      terminal = last?.role === 'assistant' && ['stop', 'error', 'aborted'].includes(last.stopReason);
      const reviews = evidence.reviews;
      const progress = JSON.stringify({ reviews: reviews.map(item => item.result.status), terminal, modelStarts: gateway.metrics().modelStarts.length });
      if (progress !== previous) { console.log(progress); previous = progress; }
      if (terminal) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!terminal) {
      await gateway.request('chat.abort', { sessionKey, runId }).catch(() => {});
      throw Object.assign(new Error('Automatic document loop exceeded the configured total deadline'), { code: 'DOCUMENT_HOOK_TIMEOUT' });
    }
    assert.equal((snapshot.messages.at(-1).message ?? snapshot.messages.at(-1)).stopReason, 'stop', 'The original native model did not finish normally');
    terminalReceipt = await gateway.runtime.subagent.waitForRun({ runId: accepted.runId,
      timeoutMs: Math.max(1, deadlineAt - Date.now()) });
    assert.equal(terminalReceipt.status, 'ok', terminalReceipt.error ?? 'The native Gateway did not acknowledge normal run completion');
    privateRuns = (await Promise.all([...new Set(evidence.reviews.map(item => item.scopeTaskId))]
      .map(id => runs.listNativeRuns(projectRoot, id)))).flat();
    await fs.writeFile(path.join(outputRoot, 'business-session.json'), JSON.stringify(snapshot, null, 2));
    await fs.writeFile(path.join(outputRoot, 'automatic-hook-events.json'), JSON.stringify(events, null, 2));
    const reviews = evidence.reviews, delivered = evidence.receipts;
    const calls = (snapshot.messages ?? []).flatMap(item => (item.message ?? item).role === 'assistant'
      ? (item.message ?? item).content ?? [] : []).filter(item => ['toolCall', 'tool_use'].includes(item.type));
    const writes = calls.filter(call => ['write', 'edit'].includes(call.name?.toLowerCase()) &&
      path.resolve(projectRoot, (call.arguments ?? call.input).path ?? (call.arguments ?? call.input).file_path ?? '') === path.join(projectRoot, 'design.md'));
    const finalDesign = await fs.readFile(path.join(projectRoot, 'design.md'), 'utf8');
    assert(reviews.length >= 2, 'Fewer than two automatic artifact reviews were recorded');
    assert(reviews[0].result.diagnostics.some(item => item.severity === 'error' && item.path === 'design.md' && item.line === 2), 'Initial automatic review did not locate the real telemetry deviation');
    assert.equal(reviews.at(-1).result.status, 'passed', 'Final automatic document review did not pass');
    assert.equal(reviews.at(-1).result.diagnostics.length, 0, 'Final automatic review retained findings');
    assert(writes.length >= 2, 'The business model did not perform both the initial write and real repair');
    assert(reviews[0].toolCallId && delivered.some(event => event.toolCallId === reviews[0].toolCallId), 'Initial finding was not delivered through actual host tool-result middleware');
    assert(!calls.some(call => call.name === 'runtime_corrector'), 'A manual check replaced the required automatic Hook');
    assert(JSON.stringify(snapshot).includes('[runtime-corrector:feedback]'), 'Native business transcript omitted automatic review feedback');
    assert(privateRuns.length >= 2 && privateRuns.every(item => item.status === 'SETTLED'), 'Private native reviews did not settle');
    assert.equal(reviews[0].result.metadata.inputs.find(item => item.path === 'design.md')?.sha256, hash(INITIAL_DESIGN), 'Initial review did not inspect the exact draft');
    assert.equal(reviews.at(-1).result.metadata.inputs.find(item => item.path === 'design.md')?.sha256, hash(finalDesign), 'Final review did not inspect the current repaired bytes');
    assert(gateway.metrics().modelStarts.some(item => item.runId === runId && item.sessionId === sessionId), 'No actual original business model start was observed');
    assert.equal(await fs.readFile(path.join(projectRoot, 'requirements.md'), 'utf8'), REQUIREMENTS, 'Original requirements changed');
    assert(!finalDesign.includes('https://telemetry.example.invalid/collect') && /local|device/iu.test(finalDesign)
      && /validat/iu.test(finalDesign) && /pars/iu.test(finalDesign) && /error/iu.test(finalDesign), 'Independent current-document fixture check failed');
    state = 'PASSED';
  } catch (error) {
    let message = String(error.message);
    for (const [key, secret] of Object.entries(process.env))
      if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(key) && secret?.length > 7) message = message.split(secret).join('[REDACTED]');
    failure = { code: error.code ?? 'OPENCLAW_DOCUMENT_E2E_FAILED', message };
  } finally {
    await gateway?.close();
  }
  const report = { kind: 'openclaw-automatic-document-hook-live-e2e', state, startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started, options: config,
    sessionKey, sessionId, runId, taskId: task?.taskId ?? evidence.reviews[0]?.scopeTaskId, terminal, terminalReceipt, failure, projectRoot,
    gateway: gateway?.metrics(), privateRuns, reviews: evidence.reviews,
    feedbackReceipts: evidence.receipts,
    effectiveTimeouts: gateway ? { reviewerTimeoutMs: gateway.config.plugins.entries['runtime-corrector'].config.reviewerTimeoutMs,
      hookTimeoutMs: gateway.config.plugins.entries['runtime-corrector'].config.hookTimeoutMs,
      hostBusinessTimeoutMs: gateway.config.agents.defaults.timeoutSeconds * 1000 } : null,
    finalDesign: await fs.readFile(path.join(projectRoot, 'design.md'), 'utf8').catch(() => null),
    limitations: ['Controlled fictional draft; the model performs the initial write and repair through the actual native Gateway.',
      'Declared original requirements are reviewed directly; dynamic baseline, Skill and Stop are separate workflows.'] };
  report.sourceHashes = Object.fromEntries(await Promise.all([
    'scripts/evaluate-openclaw-document-e2e.mjs', 'scripts/helpers/native-gateway-evaluation.mjs',
    'lib/openclaw/entry.mjs', 'lib/openclaw/runtime.mjs', 'lib/openclaw/reviewer.mjs', 'lib/document-tools.mjs',
    'lib/semantic-review.mjs', 'lib/review-timeout.mjs', 'skills/document-corrector/SKILL.md',
  ].map(async name => [name, hash(await fs.readFile(path.join(SOURCE_ROOT, name)))])));
  await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (!args.includes('--live') || !value('--host-root') || !value('--output-root'))
    throw new Error('Use --live --host-root <installed-openclaw> --output-root <fresh-directory> [--config <json>] [--review-timeout-ms N] [--hook-timeout-ms N] [--business-timeout-ms N] [--total-timeout-ms N]');
  const options = value('--config') ? JSON.parse(await fs.readFile(value('--config'), 'utf8')) : {};
  for (const name of ['review', 'hook', 'business', 'total']) if (value(`--${name}-timeout-ms`) !== undefined)
    options[`${name}TimeoutMs`] = Number(value(`--${name}-timeout-ms`));
  const result = await runOpenClawDocumentE2E({ hostRoot: value('--host-root'), outputRoot: value('--output-root'), options, settingsPath: value('--claude-settings') });
  console.log(JSON.stringify({ state: result.state, elapsedMs: result.elapsedMs, reviews: result.reviews.length,
    feedbackReceipts: result.feedbackReceipts.length, failure: result.failure, outputRoot: path.resolve(value('--output-root')) }));
  // The pinned host retains internal observers after awaited Gateway shutdown.
  process.exit(result.state === 'PASSED' ? 0 : 1);
}
