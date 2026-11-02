// A real benchmark workspace, original public instruction, and Stop only.
// The benchmark verifier and its tests are never mounted into this process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { skillBenchmarkBudgets } from './helpers/skill-benchmark-budgets.mjs';
import { waitPostRunTerminal } from '../lib/openclaw/post-run-host.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const projectRoot = path.resolve(value('--project-root', '/app'));
const outputRoot = path.resolve(value('--output', '/run'));
const hostRoot = value('--host-root');
const pluginRoot = path.resolve(value('--artifact'));
const baseCommit = value('--base-commit');
const instructionFile = path.resolve(value('--instruction'));
const resume = args.includes('--resume');
const formatRepairs = Number(value("--max-steps", "2000"));
if (!hostRoot || !/^[a-f0-9]{40}$/u.test(baseCommit ?? '')) throw new Error('Explicit host and benchmark base commit required');
const timeouts = skillBenchmarkBudgets(Number(value('--timeout-ms', '86400000')), Number(value('--max-steps', '2000')));
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
const originalInstruction = await fs.readFile(instructionFile, 'utf8');
const instruction = 'Use the native read tool to read and follow .rc-bench/skills/bench-task-contract/SKILL.md. It contains this original benchmark task. The Skill and Runtime Corrector configuration are read-only. Complete and commit the original task below.\n\n' + originalInstruction;
await fs.appendFile(path.join(projectRoot, '.git/info/exclude'), '\n.rc-bench/\n.runtime-corrector/\n.runtime-correction/\n');
if (!resume && (git('rev-parse', 'HEAD').trim() !== baseCommit || git('status', '--porcelain').trim()))
  throw new Error('Benchmark workspace is not pristine at its declared base');
if (resume) {
  git('merge-base', '--is-ancestor', baseCommit, 'HEAD');
  const prior = JSON.parse(await fs.readFile(path.join(outputRoot, 'resume-source-result.json')));
  const patch = await fs.readFile(path.join(outputRoot, 'resume-source-working-tree.patch'));
  if (git('rev-parse', 'HEAD').trim() !== prior.finalHead || git('status', '--porcelain') !== prior.finalGitStatus
    || hash(Buffer.from(git('diff', '--binary', baseCommit))) !== hash(patch)) throw new Error('Checkpoint differs from saved actual agent work');
  // The source container is stopped. Its process-local lock ownership is not
  // portable: PID 1 is reused by the new container. Preserve task data/history.
  await fs.rm(path.join(projectRoot, '.runtime-correction/locks'), { recursive: true, force: true });
  await save('checkpoint-lock-reset.json', { at: Date.now(), stoppedCheckpoint: true,
    removed: '.runtime-correction/locks', reason: 'Process ownership cannot cross container restart' });
}
await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(path.join(projectRoot, '.runtime-corrector'), { recursive: true });
await fs.appendFile(path.join(projectRoot, '.git/info/exclude'), '\n.runtime-corrector/\n.runtime-correction/\n');
git('config', 'user.name', 'RC Benchmark Agent');
git('config', 'user.email', 'rc-benchmark@example.invalid');
const model = process.env.RC_EVAL_NATIVE_MODEL ?? 'glm-5.3-flash';
if (hash(await fs.readFile(path.join(projectRoot, '.runtime-corrector/config.yaml'))) !== hash(await fs.readFile('/input/config.yaml'))) throw new Error('Skill-only configuration differs from the frozen profile');
const { loadConfig } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')).href);
const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
const modules = { skill: plan.runtimeV2.skillCorrection.enabled, globalBaseline: plan.runtimeV2.dynamicGroundTruth.enabled,
  document: plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled, writeTimeImplementation: plan.runtimeV2.implementationCorrection.enabled,
  metrics: plan.runtimeV2.stopCorrection.metrics, timeouts, formatRepairAttempts: formatRepairs };
if (!modules.skill || modules.globalBaseline || modules.document || modules.writeTimeImplementation
  || Object.entries(modules.metrics).some(([key,on]) => Boolean(on) !== (key === 'M08')))
  throw new Error('Expected standalone Skill with existing M08 terminal feedback only');
await save('policy.json', modules);
let gateway, sessionKey, runId, task, ledger, result;
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot,
    sourceRoot: fileURLToPath(new URL('../', import.meta.url)), prebuiltPluginRoot: pluginRoot, reuseProfile: resume,
    phaseTimeoutMs: timeouts.phaseTimeoutMs, disableMemoryFlush: true, confineBusinessFiles: true,
    businessToolNames: ['read', 'write', 'edit', 'exec', 'process'],
    provider: { api: 'openai-completions', baseUrl: process.env.RC_EVAL_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4', model },
    providerGuard: { kind: 'relay_native_gateway_batch', credential: () => process.env.RC_EVAL_API_KEY } });
  const effectiveBudgets = {
    businessMs: gateway.config.agents.defaults.timeoutSeconds * 1000,
    providerMs: gateway.config.models.providers.openai.timeoutSeconds * 1000,
    hookMs: gateway.config.plugins.entries['runtime-corrector'].config.hookTimeoutMs,
    correctionMs: gateway.config.plugins.entries['runtime-corrector'].config.businessRunTimeoutMs,
    reviewerMs: plan.runtimeV2.reviewers.skillReviewer.timeoutMs,
    skillFinalMs: plan.runtimeV2.reviewers.stopReviewer.timeoutMs,
    assessmentMs: plan.runtimeV2.stopCorrection.assessmentTimeoutMs,
    noProgressMs: gateway.config.diagnostics.stuckSessionAbortMs,
    skillSteps: plan.runtimeV2.reviewers.skillReviewer.maxSteps,
    finalSteps: plan.runtimeV2.reviewers.stopReviewer.maxSteps,
    configuredWallMs: timeouts.wallMs, configuredSteps: timeouts.maxSteps,
  };
  await save('effective-budgets.json', effectiveBudgets);
  if (Object.entries(effectiveBudgets).some(([key,value]) => key.endsWith('Ms') && value < timeouts.wallMs)
    || effectiveBudgets.skillSteps !== timeouts.maxSteps || effectiveBudgets.finalSteps !== timeouts.maxSteps)
    throw new Error('A loaded Skill phase has a shorter hidden budget');
  if (args.includes('--transport-check')) {
    const health = await gateway.request('health', {});
    if (!health.ok || gateway.metrics().modelStarts.length) throw new Error('Zero-model benchmark preflight failed');
    result = { mode: 'transport-check', complete: true, timeouts, ...gateway.metrics() };
  } else {
    gateway.setPhase('real-benchmark-skill-only');
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
    const load = file => import(pathToFileURL(path.join(pluginRoot, file)).href);
    const [{ findTask }, { createStopCorrectionStore }, { listNativeRuns }] = await Promise.all([
      load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/native-runs.mjs')]);
    const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
    const accepted = await gateway.request('agent', { message: instruction, agentId: 'main', sessionId, sessionKey,
      idempotencyKey: runId, deliver: false, thinking: 'low', timeout: Math.floor((deadlineAt - Date.now()) / 1000) },
      { timeoutMs: deadlineAt - Date.now() });
    if (accepted?.runId !== runId || accepted?.sessionKey !== sessionKey) throw new Error('Original benchmark dispatch identity mismatch');
    console.log(JSON.stringify({ state: 'BENCHMARK_STARTED', runId, sessionId, instructionSha256: hash(instruction) }));
    let previous, originalTerminal, nextTerminalPoll = 0, runs = [], reason;
    while (Date.now() < deadlineAt && !controller.signal.aborted) {
      await gateway.drain(); task = await findTask({ projectRoot, sessionId }); ledger = await store.inspect(sessionId);
      runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
      const progress = { status: task?.status, verification: task?.verification?.status,
        corrections: ledger?.used ?? 0, modelCalls: gateway.metrics().modelStarts.length,
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
      // Capture the authenticated original completion before any repair,
      // including failures in Stop's prerequisite extraction.
      if (originalTerminal?.status === 'ok' && !ledger?.used
        && !await fs.stat(path.join(outputRoot, 'first-stop/snapshot.json')).catch(() => null)) {
        const first = path.join(outputRoot, 'first-stop'); await fs.mkdir(first, { recursive: true });
        await fs.writeFile(path.join(first, 'model.patch'), git('diff', '--binary', baseCommit, 'HEAD'));
        await fs.writeFile(path.join(first, 'working-tree.patch'), git('diff', '--binary', baseCommit));
        await fs.writeFile(path.join(first, 'snapshot.json'), JSON.stringify({ at: Date.now(),
          originalTerminal, head: git('rev-parse', 'HEAD').trim(), branch: git('branch', '--show-current').trim(),
          status: git('status', '--porcelain'), corrections: ledger?.used ?? 0,
          source: 'Authenticated original completion, zero repair admissions; no injected fault' }, null, 2));
      }

      const allSettled = runs.length && runs.every(r => r.status === 'SETTLED');
      const activeRepair = Object.values(ledger?.admissions ?? {}).some(a => a.accounting === 'RESERVED' || a.accounting === 'USED' && !a.endedAt);
      const currentVerification = Date.parse(task?.verification?.updatedAt ?? '') >= startedAt;
      if (originalTerminal?.status === 'ok' && !currentVerification && !activeRepair && runs.every(r => r.status === 'SETTLED')) {
        const directory = path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions/post-run');
        for (const file of await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
          if (!file.endsWith('.json')) continue;
          const record = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
          if (record.runId === runId && record.phase === 'IDLE' && record.reason === 'RC_HOOK_UNAVAILABLE') {
            await save('unavailable-stop-dispatch.json', record); reason = 'STOP_HOOK_UNAVAILABLE'; break;
          }
        }
        if (reason) break;
      }
      if (originalTerminal?.status === 'ok' && currentVerification && task?.verification?.status === 'PASS' && allSettled && !activeRepair) break;
      if (originalTerminal?.status === 'ok' && currentVerification && allSettled && !activeRepair && (['STOPPED_UNVERIFIED', 'STOPPED_CHECKER_ERROR', 'CANCELLED'].includes(task?.status)
        || task?.verification?.status === 'UNVERIFIED' || ledger?.used >= timeouts.maxSteps)) { reason = 'STOP_NOT_PASSED'; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (controller.signal.aborted || Date.now() >= deadlineAt) reason = Date.now() >= deadlineAt ? 'BENCHMARK_DEADLINE' : 'BENCHMARK_CANCELLED';
    const used = Object.values(ledger?.admissions ?? {}).filter(a => a.accounting === 'USED');
    const terminals = [];
    if (!reason && task?.verification?.status === 'PASS') {
      for (const id of [runId, ...used.map(a => `rc-stop-${a.id}`)])
        terminals.push(id === runId && originalTerminal ? originalTerminal
          : await waitPostRunTerminal(null, null, id, deadlineAt, controller.signal,
            (method, params, options) => gateway.request(method, params, options)));
    }
    const skillRoot = task && path.join(projectRoot, '.runtime-correction/tasks', task.taskId, 'skills/bench-task-contract');
    const graph = skillRoot && await fs.readFile(path.join(skillRoot, 'skill-ground-truth.json'), 'utf8').then(JSON.parse, () => null);
    const evaluations = [];
    for (const file of skillRoot ? await fs.readdir(path.join(skillRoot, 'evaluations')).catch(() => []) : []) {
      if (file.endsWith('.json')) evaluations.push(JSON.parse(await fs.readFile(path.join(skillRoot, 'evaluations', file), 'utf8')));
    }
    const transcript = await fs.readFile(path.join(gateway.root, sessionId + '.jsonl'), 'utf8');
    const messages = transcript.trim().split('\n').map(line => JSON.parse(line).message).filter(Boolean);
    const reads = messages.filter(m => m.role === 'assistant').flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'toolCall'
      && b.name === 'read' && String(b.arguments?.path ?? b.arguments?.file_path ?? '').endsWith('/bench-task-contract/SKILL.md')));
    const pairedRead = reads.some(call => messages.some(m => m.role === 'toolResult' && m.toolCallId === call.id && !m.isError));
    const skillChecks = { actualSkillRead: pairedRead, realGraph: Boolean(graph?.constraints?.length),
      realExtractor: runs.some(r => r.role === 'ground-truth-extractor'), realSkillReviewer: runs.some(r => r.role === 'skill-reviewer'),
      watcherPass: Object.values(task?.watchers ?? {}).some(w => w.status === 'PASS' && w.sourceInterpretationChecked === true),
      globalBaselineOff: task?.groundTruth?.version === 0 };
    if (!reason && !Object.values(skillChecks).every(Boolean)) reason = 'SKILL_EVIDENCE_INCOMPLETE';
    await save('skill-evidence.json', { skillChecks, graph, evaluations, watchers: task?.watchers });
    result = { mode: 'real-benchmark-skill-only', complete: !reason && task?.verification?.status === 'PASS'
        && terminals.length === used.length + 1 && terminals.every(t => t?.status === 'ok')
        && runs.every(r => r.status === 'SETTLED'),
      reason, skillChecks, baseCommit, instructionSha256: hash(instruction), model, timeouts, sessionId, sessionKey, originalRunId: runId,
      taskId: task?.taskId, verification: task?.verification, status: task?.status, corrections: ledger?.used ?? 0,
      terminals, originalTerminal, privateRuns: runs, ledger, ...gateway.metrics() };
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
