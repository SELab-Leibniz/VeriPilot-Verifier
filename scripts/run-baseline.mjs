#!/usr/bin/env node
// Standalone real-host baseline pipeline. Model output still passes the
// production source, coverage-audit and transactional publication checks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createNativeStopEvaluation } from './helpers/native-stop-evaluation.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { ensureTask, taskStatePath } from '../lib/runtime-v2/task-store.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { verifyBaselineCoverageProof } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { resolveBaselineLimits, MAX_BASELINE_TIMEOUT_MS } from '../lib/review-task/baseline-limits.mjs';

export const BASELINE_RUN_DEFAULTS = Object.freeze({
  timeoutMs: 600000, assessmentTimeoutMs: 900000, requestTimeoutMs: 600000,
  maxSteps: 200, maxRepairs: 8, maxAuditCalls: 2, maxExternalRepairs: 1, auditUnitBytes: 2048,
  model: 'glm-5.3', api: 'anthropic-messages', baseUrl: null,
});

export function baselineRunSettings(value = {}) {
  const settings = { ...BASELINE_RUN_DEFAULTS, ...value };
  for (const key of ['timeoutMs', 'assessmentTimeoutMs', 'requestTimeoutMs'])
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1000 || settings[key] > MAX_BASELINE_TIMEOUT_MS)
      throw new Error(`Invalid finite ${key}.`);
  if (settings.assessmentTimeoutMs < settings.timeoutMs)
    throw new Error('assessmentTimeoutMs must be at least timeoutMs.');
  resolveBaselineLimits({ timeoutMs: settings.timeoutMs, maxSteps: settings.maxSteps, maxRepairs: settings.maxRepairs,
    maxAuditCalls: settings.maxAuditCalls, maxExternalRepairs: settings.maxExternalRepairs, auditUnitBytes: settings.auditUnitBytes });
  if (typeof settings.model !== 'string' || !settings.model.trim()) throw new Error('A model is required.');
  if (!['anthropic-messages', 'openai-completions'].includes(settings.api)) throw new Error('Unsupported provider API.');
  if (settings.baseUrl !== null) {
    const url = new URL(settings.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider base URL.');
  }
  if (settings.api === 'openai-completions' && !settings.baseUrl) throw new Error('A baseUrl is required for openai-completions.');
  return settings;
}

function safeError(error) {
  let message = String(error?.message ?? error);
  for (const [key, value] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(key) && value?.length >= 8) message = message.replaceAll(value, '[REDACTED]');
  return { code: error?.code ?? 'BASELINE_RUN_FAILED', message,
    ...(error?.cause && error.cause !== error ? { cause: safeError(error.cause) } : {}) };
}

export async function runBaseline({ input, materials = [], output, hostRoot,
  sourceRoot = fileURLToPath(new URL('../', import.meta.url)), settings: supplied,
  credentialEnv = 'ANTHROPIC_AUTH_TOKEN', onProgress = () => {} }) {
  const settings = baselineRunSettings(supplied), startedAt = Date.now();
  const text = await fs.readFile(input, 'utf8');
  if (!text.trim()) throw new Error('The original input must not be empty.');
  if (!/^[A-Z][A-Z0-9_]*$/u.test(credentialEnv) || !process.env[credentialEnv]?.trim()
    || settings.api === 'anthropic-messages' && !(settings.baseUrl ?? process.env.ANTHROPIC_BASE_URL)?.trim())
    throw new Error('Set the selected credential environment variable and ANTHROPIC_BASE_URL, or load your existing OpenClaw environment with node --env-file.');
  process.env.ANTHROPIC_AUTH_TOKEN = process.env[credentialEnv];
  if (settings.api === 'anthropic-messages' && settings.baseUrl) process.env.ANTHROPIC_BASE_URL = settings.baseUrl;
  const root = path.resolve(output);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root); // Each attempt owns a new directory; old results remain intact.
  const projectRoot = path.join(root, 'workspace'); await fs.mkdir(projectRoot);
  const materialRoots = [];
  for (const [index, source] of materials.entries()) {
    const target = path.join(projectRoot, 'materials', String(index));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.resolve(source), target, { recursive: true, errorOnExist: true, force: false });
    materialRoots.push(target);
  }
  const transcript = path.join(projectRoot, 'conversation.jsonl'), sessionId = randomUUID();
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'baseline-original-user',
    message: { role: 'user', content: text } }) + '\n');
  const task = await ensureTask({ projectRoot, sessionId });
  const controller = new AbortController();
  const deadlineAt = startedAt + settings.assessmentTimeoutMs;
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Configured baseline assessment deadline expired'),
    { code: 'REVIEWER_DEADLINE' })), Math.max(1, deadlineAt - Date.now()));
  const interrupt = () => controller.abort(Object.assign(new Error('Baseline run interrupted'), { code: 'BASELINE_CANCELLED' }));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let native, result;
  try {
    process.env.RC_EVAL_NATIVE_MODEL = settings.model;
    onProgress({ phase: 'host-setup', settings });
    native = await createNativeStopEvaluation({ hostRoot, sourceRoot, projectRoot, outputRoot: root,
      fixtureFence: { projectRoot }, traceTransport: true, providerTimeoutMs: settings.requestTimeoutMs, standaloneBaseline: true,
      baselineLimits: { timeoutMs: settings.timeoutMs, maxSteps: settings.maxSteps, maxRepairs: settings.maxRepairs,
        maxAuditCalls: settings.maxAuditCalls, maxExternalRepairs: settings.maxExternalRepairs, auditUnitBytes: settings.auditUnitBytes },
      ...(settings.api === 'openai-completions' ? { provider: { api: settings.api, baseUrl: settings.baseUrl,
        model: settings.model, credentialEnv }, providerCredential: process.env[credentialEnv] } : {}) });
    const runtimeV2 = compileRuntimeV2Config({ version: 2,
      dynamicGroundTruth: { enabled: true, materialRoots },
      reviewers: { groundTruthExtractor: { session: 'detached', model: native.modelRef,
        // Ordinary reviewer schema retains its existing caps. The baseline-only
        // factory option above owns the longer original extraction allowance.
        timeoutMs: Math.min(settings.timeoutMs, 3600000), formatRepairAttempts: Math.min(settings.maxRepairs, 20), maxOutputTokens: 32768 } },
      skillCorrection: { enabled: false }, artifactCorrection: { groundTruthReviewEnabled: false },
      stopCorrection: { enabled: false } });
    onProgress({ phase: 'extract-audit-publish', taskId: task.taskId });
    const outcome = await refreshRuntimeRequirements({ projectRoot,
      input: { cwd: projectRoot, session_id: sessionId, transcript_path: transcript, hook_event_id: randomUUID() },
      plan: { runtimeV2 }, reviewerFactory: native.run,
      assessmentContext: { deadlineAt, abortSignal: controller.signal } });
    const truth = await loadCurrentGroundTruth(projectRoot, task.taskId);
    const state = JSON.parse(await fs.readFile(taskStatePath(projectRoot, task.taskId), 'utf8'));
    const proof = state.groundTruth?.sharedBasis?.coverageAudit;
    if (!outcome.baselineCommitted || truth.version < 1 || !proof)
      throw new Error('The pipeline did not publish an independently audited baseline.');
    const audited = await verifyBaselineCoverageProof(proof.pointer, { identity: proof.identity, truth });
    if (audited.report.verdict !== 'PASS') throw new Error('The published baseline lacks a current PASS audit.');
    result = { status: 'PUBLISHED', complete: true, taskId: task.taskId, baselineVersion: truth.version,
      auditVerdict: audited.report.verdict, claims: truth.claims, auditProof: proof.pointer,
      outcome, settings, projectRoot, resultPath: path.join(root, 'result.json') };
  } catch (error) {
    result = { status: 'FAILED', complete: false, taskId: task.taskId, error: safeError(error), settings, projectRoot };
  } finally {
    try { await native?.close(); }
    catch (error) { result = { ...result, status: 'FAILED', complete: false, closeError: safeError(error) }; }
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  result.runtime = native?.metrics() ?? null;
  result.startedAt = new Date(startedAt).toISOString(); result.durationMs = Date.now() - startedAt;
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/run-baseline.mjs --input requirements.txt --output NEW_DIRECTORY --host-root OPENCLAW_ROOT [--material PATH ...] [--config JSON] [--timeout-ms N] [--assessment-timeout-ms N] [--request-timeout-ms N] [--max-steps N] [--max-repairs N] [--max-audit-calls N] [--max-external-repairs N] [--audit-unit-bytes N] [--model NAME] [--api NAME] [--base-url URL] [--credential-env NAME]');
    return;
  }
  const values = {}, materials = [], overrides = {};
  const keys = { '--timeout-ms': 'timeoutMs', '--assessment-timeout-ms': 'assessmentTimeoutMs',
    '--request-timeout-ms': 'requestTimeoutMs', '--max-steps': 'maxSteps', '--max-repairs': 'maxRepairs',
    '--max-audit-calls': 'maxAuditCalls', '--max-external-repairs': 'maxExternalRepairs',
    '--audit-unit-bytes': 'auditUnitBytes',
    '--model': 'model', '--api': 'api', '--base-url': 'baseUrl' };
  for (let index = 0; index < args.length; index++) {
    const key = args[index], value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--material') materials.push(value);
    else if (keys[key]) overrides[keys[key]] = ['--model', '--api', '--base-url'].includes(key) ? value : Number(value);
    else if (['--input', '--output', '--host-root', '--config', '--credential-env'].includes(key)) values[key] = value;
    else throw new Error(`Unknown option: ${key}`);
  }
  for (const required of ['--input', '--output', '--host-root'])
    if (!values[required]) throw new Error(`Required: ${required}`);
  const config = values['--config'] ? JSON.parse(await fs.readFile(values['--config'], 'utf8')) : {};
  const result = await runBaseline({ input: values['--input'], output: values['--output'],
    hostRoot: path.resolve(values['--host-root']), materials, settings: { ...config, ...overrides },
    credentialEnv: values['--credential-env'] ?? 'ANTHROPIC_AUTH_TOKEN',
    onProgress: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ status: result.status, complete: result.complete, baselineVersion: result.baselineVersion,
    claimCount: result.claims?.length ?? 0, durationMs: result.durationMs,
    resultPath: path.resolve(values['--output'], 'result.json'), error: result.error }));
  process.exitCode = result.complete ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; });
