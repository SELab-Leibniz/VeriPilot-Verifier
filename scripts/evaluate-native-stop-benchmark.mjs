// A real benchmark workspace, original public instruction, and Stop only.
// The benchmark verifier and its tests are never mounted into this process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { nativeStopTimeouts } from './helpers/native-stop-timeouts.mjs';
import { waitPostRunTerminal } from '../lib/openclaw/post-run-host.mjs';
import { createBenchmarkFaultFixture } from './helpers/benchmark-fault-fixture.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const projectRoot = path.resolve(value('--project-root', '/app'));
const outputRoot = path.resolve(value('--output', '/run'));
const hostRoot = value('--host-root');
const pluginRoot = path.resolve(value('--artifact'));
const baseCommit = value('--base-commit');
const instructionFile = path.resolve(value('--instruction'));
const resume = args.includes('--resume');
const seedCheckpointFile = value('--seed-checkpoint-state');
const faultSpecFile = value('--inject-defect-spec');
if (resume && (seedCheckpointFile || faultSpecFile)) throw new Error('Injected benchmark control requires a fresh host profile');
if (!hostRoot || !/^[a-f0-9]{40}$/u.test(baseCommit ?? '')) throw new Error('Explicit host and benchmark base commit required');
const timeouts = nativeStopTimeouts(Number(value('--timeout-ms', '86400000')));
const budgets = { maxReviewSteps: Number(value('--max-review-steps', '2000')),
  maxRepairSteps: Number(value('--max-repair-steps', '2000')),
  maxCorrections: Number(value('--max-corrections', '3')) };
for (const [name, amount] of Object.entries(budgets))
  if (!Number.isSafeInteger(amount) || amount < (name === 'maxCorrections' ? 0 : 1)) throw new Error(`Invalid ${name}`);
const startedAt = Date.now(), deadlineAt = startedAt + timeouts.wallMs;
const controller = new AbortController();
const cancel = () => controller.abort(new Error('Benchmark cancelled'));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const timer = setTimeout(() => controller.abort(new Error('Benchmark deadline expired')), timeouts.wallMs);
timer.unref();
// Accept a transient credential on stdin so Docker's saved environment and
// command line never contain the key. The caller closes stdin immediately.
if (!args.includes('--transport-check') && !process.env.RC_EVAL_API_KEY) {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error('Credential input too large'); }
  process.env.RC_EVAL_API_KEY = JSON.parse(input).apiKey;
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...argv) => execFileSync('git', ['-C', projectRoot, ...argv], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
const save = async (name, data) => fs.writeFile(path.join(outputRoot, name), JSON.stringify(data, null, 2) + '\n');
const instruction = await fs.readFile(instructionFile, 'utf8');
if (resume || seedCheckpointFile) {
  // Resume only the preserved model workspace, including uncommitted additions.
  // Verify it before rewriting harness policy or dispatching any model work.
  const checkpoint = JSON.parse(await fs.readFile(seedCheckpointFile ?? path.join(outputRoot, 'resume-source-state.json'), 'utf8'));
  if (git('rev-parse', 'HEAD').trim() !== checkpoint.head
    || git('branch', '--show-current').trim() !== checkpoint.branch
    || git('status', '--porcelain') !== checkpoint.gitStatus)
    throw new Error('Checkpoint Git state does not match the preserved model workspace');
  git('merge-base', '--is-ancestor', baseCommit, 'HEAD');
  for (const file of checkpoint.files) {
    const absolute = path.resolve(projectRoot, file.path);
    if (!absolute.startsWith(projectRoot + path.sep) || hash(await fs.readFile(absolute)) !== file.sha256)
      throw new Error('Checkpoint source file differs from the preserved model workspace');
  }
} else if (git('rev-parse', 'HEAD').trim() !== baseCommit || git('status', '--porcelain').trim())
  throw new Error('Benchmark workspace is not pristine at its declared base');
await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(path.join(projectRoot, '.runtime-corrector'), { recursive: true });
await fs.appendFile(path.join(projectRoot, '.git/info/exclude'), '\n.runtime-corrector/\n.runtime-correction/\n');
git('config', 'user.name', 'RC Benchmark Agent');
git('config', 'user.email', 'rc-benchmark@example.invalid');
const model = process.env.RC_EVAL_NATIVE_MODEL ?? 'glm-5.3-flash';
await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), `version: 2
enabled: true
sessionDefaults:
  enabled: true
locale: en
artifacts: []
dynamicGroundTruth:
  enabled: true
  panel:
    size: 0
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
skillCorrection:
  enabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: ${budgets.maxCorrections}
  maxCorrectionsPerFlow: ${budgets.maxCorrections}
  maxReviewSteps: ${budgets.maxReviewSteps}
  maxRepairSteps: ${budgets.maxRepairSteps}
  assessmentTimeoutMs: ${timeouts.assessmentTimeoutMs}
  feedbackReserveMs: ${timeouts.feedbackReserveMs}
reviewers:
  defaults:
    model: openai/${model}
    effort: low
    timeoutMs: ${timeouts.reviewerTimeoutMs}
    maxOutputTokens: 32768
`);
const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')).href);
const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
const modules = { stop: plan.runtimeV2.stopCorrection.enabled, skill: plan.runtimeV2.skillCorrection.enabled,
  document: plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled,
  writeTimeImplementation: plan.runtimeV2.implementationCorrection.enabled,
  artifacts: plan.artifacts.length, metrics: plan.runtimeV2.stopCorrection.metrics,
  budgets: { maxReviewSteps: plan.runtimeV2.stopCorrection.maxReviewSteps, maxRepairSteps: plan.runtimeV2.stopCorrection.maxRepairSteps,
    maxCorrectionsPerSession: plan.runtimeV2.stopCorrection.maxCorrectionsPerSession, maxCorrectionsPerFlow: plan.runtimeV2.stopCorrection.maxCorrectionsPerFlow } };
if (!modules.stop || modules.skill || modules.document || modules.writeTimeImplementation || modules.artifacts)
  throw new Error('Benchmark policy is not Stop only');
await save('policy.json', modules);
let gateway, sessionKey, runId, task, ledger, result;
try {
  const faultFixture = faultSpecFile ? await createBenchmarkFaultFixture({ projectRoot, outputRoot, specFile: faultSpecFile }) : null;
  gateway = await createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot,
    sourceRoot: fileURLToPath(new URL('../', import.meta.url)), prebuiltPluginRoot: pluginRoot, reuseProfile: resume,
    extraPluginPaths: faultFixture ? [faultFixture] : [],
    phaseTimeoutMs: timeouts.phaseTimeoutMs, disableMemoryFlush: true, confineBusinessFiles: true, skipBootstrap: true,
    businessToolNames: ['read', 'write', 'edit', 'exec', 'process'],
    provider: { api: 'openai-completions', baseUrl: process.env.RC_EVAL_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4', model } });
  if (args.includes('--transport-check')) {
    const health = await gateway.request('health', {});
    if (!health.ok || gateway.metrics().modelStarts.length) throw new Error('Zero-model benchmark preflight failed');
    result = { mode: 'transport-check', complete: true, timeouts, ...gateway.metrics() };
  } else {
    gateway.setPhase('real-benchmark-stop-only');
    if (resume) {
      const original = JSON.parse(await fs.readFile(path.join(outputRoot, 'resume-source-target.json'), 'utf8'));
      sessionKey = original.sessionKey;
    } else {
      const created = await gateway.request('sessions.create', { key: `agent:main:bench-${randomUUID()}`, agentId: 'main' });
      if (!created.ok || !created.key) throw new Error('Benchmark session was not created');
      sessionKey = created.key;
    }
    const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
    await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
    const entry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
    const sessionId = entry.sessionId;
    runId = randomUUID(); await save('target.json', { runId, sessionId, sessionKey });
    if (faultFixture) await save('fault-target.json', { runId, baseCommit });
    const load = file => import(pathToFileURL(path.join(pluginRoot, file)).href);
    const [{ findTask }, { createStopCorrectionStore }, { listNativeRuns }] = await Promise.all([
      load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/native-runs.mjs')]);
    const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
    const initialLedger = await store.inspect(sessionId);
    const initialUsed = initialLedger?.used ?? 0, initialAdmissions = new Set(Object.keys(initialLedger?.admissions ?? {}));
    const accepted = await gateway.request('agent', { message: instruction, agentId: 'main', sessionId, sessionKey,
      idempotencyKey: runId, deliver: false, thinking: 'low', timeout: Math.floor((deadlineAt - Date.now()) / 1000) },
      { timeoutMs: deadlineAt - Date.now() });
    if (accepted?.runId !== runId || accepted?.sessionKey !== sessionKey) throw new Error('Original benchmark dispatch identity mismatch');
    console.log(JSON.stringify({ state: 'BENCHMARK_STARTED', runId, sessionId, instructionSha256: hash(instruction) }));
    let previous, originalTerminal, nextTerminalPoll = 0, runs = [], reason;
    while (Date.now() < deadlineAt && !controller.signal.aborted) {
      await gateway.drain(); task = await findTask({ projectRoot, sessionId }); ledger = await store.inspect(sessionId);
      runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
      const used = Object.values(ledger?.admissions ?? {}).filter(a => a.accounting === 'USED' && !initialAdmissions.has(a.id));
      const currentVerification = [runId, ...used.map(a => `rc-stop-${a.id}`)]
        .some(id => task?.verification?.assessmentId?.startsWith(`${id}:`));
      const progress = { status: task?.status, verification: task?.verification?.status,
        corrections: (ledger?.used ?? 0) - initialUsed, modelCalls: gateway.metrics().modelStarts.length,
        privateActive: runs.filter(r => r.status !== 'SETTLED').length };
      if (JSON.stringify(progress) !== previous) { previous = JSON.stringify(progress); console.log(previous); await save('progress.json', progress); }
      if (!originalTerminal && Date.now() >= nextTerminalPoll) {
        nextTerminalPoll = Date.now() + 2000;
        const response = await gateway.request('agent.wait', { runId, timeoutMs: 1 }, { timeoutMs: 2000 });
        const terminal = response?.result ?? response;
        if (terminal.runId !== runId) throw new Error('Benchmark original terminal identity mismatch');
        if (['ok', 'error'].includes(terminal.status)) originalTerminal = terminal;
      }
      if (originalTerminal?.status === 'error') { reason = 'ORIGINAL_HOST_ERROR'; break; }
      if (faultFixture && originalTerminal?.status === 'ok'
        && !await fs.stat(path.join(outputRoot, 'fault-injection.json')).catch(() => null)) {
        reason = 'FAULT_NOT_INJECTED'; break;
      }
      // The production controller starts Stop only after the original host
      // terminal. Read the committed first draft before any repair is admitted.
      if (originalTerminal?.status === 'ok' && !used.length && runs.some(r => r.role === 'stop-reviewer' && r.startedAt >= startedAt)
        && !await fs.stat(path.join(outputRoot, 'first-stop/snapshot.json')).catch(() => null)) {
        const first = path.join(outputRoot, 'first-stop'); await fs.mkdir(first, { recursive: true });
        await fs.writeFile(path.join(first, 'model.patch'), git('diff', '--binary', baseCommit, 'HEAD'));
        await fs.writeFile(path.join(first, 'working-tree.patch'), git('diff', '--binary', baseCommit));
        await fs.writeFile(path.join(first, 'snapshot.json'), JSON.stringify({ at: Date.now(),
          originalTerminal, head: git('rev-parse', 'HEAD').trim(), branch: git('branch', '--show-current').trim(),
          status: git('status', '--porcelain'), corrections: (ledger?.used ?? 0) - initialUsed,
          source: faultFixture ? 'Authenticated original completion after recorded one-time fault injection; first Stop review observed; zero repair admissions'
            : 'Authenticated original completion, first Stop review observed, zero repair admissions; no injected fault' }, null, 2));
      }

      const allSettled = runs.length && runs.every(r => r.status === 'SETTLED');
      const activeRepair = Object.values(ledger?.admissions ?? {}).some(a => a.accounting === 'RESERVED' || a.accounting === 'USED' && !a.endedAt);
      if (faultFixture && originalTerminal?.status === 'ok' && currentVerification
        && task?.verification?.status === 'PASS' && allSettled && !activeRepair && !used.length) {
        reason = 'FAULT_NOT_DETECTED'; break;
      }
      const faultFinalReviewSaved = !faultFixture || used.at(-1)?.finalReview?.status === 'PASS'
        && used.at(-1).finalReview.evaluationId === task?.verification?.evaluationId;
      if (originalTerminal?.status === 'ok' && currentVerification && task?.verification?.status === 'PASS' && allSettled && !activeRepair && faultFinalReviewSaved) break;
      const exhausted = ledger?.used >= budgets.maxCorrections && (!used.length
        || used.some(a => a.finalReview?.evaluationId === task?.verification?.evaluationId));
      if (originalTerminal?.status === 'ok' && currentVerification && allSettled && !activeRepair && (['STOPPED_UNVERIFIED', 'STOPPED_CHECKER_ERROR', 'CANCELLED'].includes(task?.status)
        || task?.verification?.status === 'UNVERIFIED' || exhausted)) { reason = 'STOP_NOT_PASSED'; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (controller.signal.aborted || Date.now() >= deadlineAt) reason = Date.now() >= deadlineAt ? 'BENCHMARK_DEADLINE' : 'BENCHMARK_CANCELLED';
    const used = Object.values(ledger?.admissions ?? {}).filter(a => a.accounting === 'USED' && !initialAdmissions.has(a.id));
    const terminals = [];
    if (!reason && task?.verification?.status === 'PASS') {
      for (const id of [runId, ...used.map(a => `rc-stop-${a.id}`)])
        terminals.push(id === runId && originalTerminal ? originalTerminal
          : await waitPostRunTerminal(null, null, id, deadlineAt, controller.signal,
            (method, params, options) => gateway.request(method, params, options)));
    }
    const injected = faultFixture ? await fs.readFile(path.join(outputRoot, 'fault-injection.json'), 'utf8').then(JSON.parse, () => null) : null;
    const faultCycleComplete = !faultFixture || injected?.runId === runId && used.length > 0 && used.length <= budgets.maxCorrections
      && ledger.events.some(event => event.type === 'STOP_REVIEW_SETTLED' && event.stopId === runId && event.status === 'DEVIATION')
      && used.at(-1)?.finalReview?.status === 'PASS'
      && used.at(-1).finalReview.evaluationId === task?.verification?.evaluationId
      && used.every(a => gateway.metrics().modelStarts.some(event => event.runId === `rc-stop-${a.id}` && event.sessionId === sessionId));
    result = { mode: 'real-benchmark-stop-only', complete: !reason && faultCycleComplete && task?.verification?.status === 'PASS'
        && terminals.length === used.length + 1 && terminals.every(t => t?.status === 'ok')
        && runs.every(r => r.status === 'SETTLED'),
      reason, baseCommit, instructionSha256: hash(instruction), model, timeouts, sessionId, sessionKey, originalRunId: runId,
      taskId: task?.taskId, verification: task?.verification, status: task?.status, corrections: (ledger?.used ?? 0) - initialUsed, sessionCorrections: ledger?.used ?? 0, budgets,
      terminals, privateRuns: runs, ledger, ...gateway.metrics() };
    if (faultFixture) Object.assign(result, { injected, faultCycleComplete });
  }
} catch (error) {
  const message = String(error.message).split(process.env.RC_EVAL_API_KEY ?? 'never-a-key').join('[REDACTED]');
  result = { complete: false, error: { code: error.code ?? 'BENCHMARK_RUN_FAILED', message: message.slice(0, 2000) }, ...gateway?.metrics() };
} finally {
  clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  if (!result?.complete && gateway && runId) {
    for (const id of [runId, ...Object.values(ledger?.admissions ?? {}).filter(a => a.accounting === 'USED' && !a.endedAt).map(a => `rc-stop-${a.id}`)])
      await gateway.request('chat.abort', { sessionKey, runId: id }).catch(() => {});
  }
  if (gateway) { await gateway.close(); await save('closure.json', { gatewayClosed: true, at: Date.now() }); }
  // These are the model's actual commits. Uncommitted work is retained for
  // diagnosis but never silently committed into an official prediction.
  await fs.writeFile(path.join(outputRoot, 'model.patch'), git('diff', '--binary', baseCommit, 'HEAD'));
  await fs.writeFile(path.join(outputRoot, 'working-tree.patch'), git('diff', '--binary', baseCommit));
  result = { ...result, elapsedMs: Date.now() - startedAt, finalHead: git('rev-parse', 'HEAD').trim(),
    finalBranch: git('branch', '--show-current').trim(), finalGitStatus: git('status', '--porcelain') };
  await save('result.json', result); console.log(JSON.stringify({ complete: result.complete, reason: result.reason,
    verification: result.verification, corrections: result.corrections, elapsedMs: result.elapsedMs }));
}
process.exit(result?.complete ? 0 : 1);
