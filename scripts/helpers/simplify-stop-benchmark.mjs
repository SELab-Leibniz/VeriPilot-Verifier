import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadPackaged, readProviderTiming, redactEvaluationText, summarizeProviderUsage } from './simplify-native-evaluation.mjs';

const isTime = value => Number.isSafeInteger(value) && value > 0;
const intervals = runs => runs.filter(run => isTime(run.startedAt) && isTime(run.settledAt) && run.settledAt >= run.startedAt)
  .map(run => [run.startedAt, run.settledAt]);

function wallTime(spans) {
  let sum = 0, latest = 0;
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0])) {
    sum += Math.max(0, end - Math.max(start, latest));
    latest = Math.max(latest, end);
  }
  return spans.length ? sum : null;
}

async function usageFor(runs, requestTimes) {
  const spans = intervals(runs);
  const observedCalls = requestTimes.filter(at => spans.some(([start, end]) => at >= start && at <= end)).length;
  const frames = [];
  for (const file of new Set(runs.map(run => run.sessionFile).filter(Boolean))) {
    const text = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const seen = new Set();
    for (const line of text.split(/\r?\n/u).filter(Boolean)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Date.parse(row.timestamp);
      if (row.message?.role !== 'assistant' || !row.id || seen.has(row.id)
        || !spans.some(([start, end]) => at >= start && at <= end)) continue;
      seen.add(row.id); frames.push(row.message.usage);
    }
  }
  return summarizeProviderUsage(observedCalls, frames);
}

export async function measureSimplifyBenchmark({ nativeRoot, privateRuns = [], ledger, rcElapsedMs }) {
  const timing = await readProviderTiming(nativeRoot);
  const requestTimes = timing.filter(row => row.event === 'request').map(row => Date.parse(row.startedAt));
  const baseline = privateRuns.filter(run => run.role === 'ground-truth-extractor');
  const baselineUsage = await usageFor(baseline, requestTimes);
  const assessments = Object.values(ledger?.stops ?? {}).filter(stop => isTime(stop.startedAt)
    && isTime(stop.assessmentFinishedAt) && stop.assessmentFinishedAt >= stop.startedAt)
    .map(stop => [stop.startedAt, stop.assessmentFinishedAt]);
  return { rcElapsedMs: rcElapsedMs ?? wallTime([...assessments, ...intervals(privateRuns)]),
    usage: await usageFor(privateRuns, requestTimes),
    baselineCost: { elapsedMs: wallTime(intervals(baseline)), tokens: baselineUsage.observedCalls && baselineUsage.completeCalls === baselineUsage.observedCalls
      ? baselineUsage.tokens : null }, rateLimited: timing.some(row => row.event === 'response' && row.status === 429) };
}

export async function verifyFrozenBenchmark({ gateway, projectRoot, pluginRoot, plan, transcript, instruction, deadlineAt, signal }) {
  const [{ handleRuntimeV2Event }, { createOpenClawReviewerFactory }, { readTranscriptSnapshot, latestAssistantText }, { findTask }, { listNativeRuns }] = await Promise.all([
    loadPackaged(pluginRoot, 'lib/runtime-v2/orchestrator.mjs'), loadPackaged(pluginRoot, 'lib/openclaw/reviewer.mjs'),
    loadPackaged(pluginRoot, 'lib/runtime-v2/transcript.mjs'), loadPackaged(pluginRoot, 'lib/runtime-v2/task-store.mjs'),
    loadPackaged(pluginRoot, 'lib/openclaw/native-runs.mjs'),
  ]);
  let snapshot = await readTranscriptSnapshot(transcript);
  if (!snapshot.userKeys.length && snapshot.entries.some(entry => entry.type === 'message' && entry.message?.role === 'user')) {
    const { normalizeMessages } = await loadPackaged(pluginRoot, 'lib/openclaw/transcript.mjs');
    transcript = path.join(gateway.root, 'frozen-parent-projection.jsonl');
    await fs.writeFile(transcript, normalizeMessages(snapshot.entries).map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    snapshot = await readTranscriptSnapshot(transcript);
  }
  const firstUser = snapshot.entries.find(entry => entry.type === 'user' && entry.isMeta !== true)?.message?.content;
  const userText = typeof firstUser === 'string' ? firstUser : firstUser?.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const normalized = text => text?.replace(/\r\n/gu, '\n').trim();
  if (normalized(userText) !== normalized(instruction) || !latestAssistantText(snapshot))
    throw new Error('Frozen transcript must contain the declared public instruction as the first user message and the original assistant delivery.');
  const api = { id: 'runtime-corrector', runtime: gateway.runtime, config: gateway.config, logger: { warn() {} } };
  const reviewerFactory = createOpenClawReviewerFactory(api, { pluginRoot, deadlineAt, abortSignal: signal,
    runEmbeddedAgent: params => gateway.runtime.agent.runEmbeddedAgent(params) });
  const sessionId = randomUUID(), identity = { session_id: sessionId, cwd: projectRoot, transcript_path: transcript };
  const options = { projectRoot, pluginRoot, plan, reviewerFactory,
    stopHost: { directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') } };
  await handleRuntimeV2Event({ ...options, input: { ...identity, hook_event_name: 'SessionStart', source: 'startup' } });
  await handleRuntimeV2Event({ ...options, input: { ...identity, hook_event_name: 'UserPromptSubmit', hook_event_id: 'frozen-original-user', prompt: instruction } });
  gateway.setPhase('frozen-stop-verification');
  const start = Date.now();
  const outcome = await handleRuntimeV2Event({ ...options, assessmentContext: { mode: 'verify_only', assessmentId: 'frozen-stop', deadlineAt, abortSignal: signal },
    input: { ...identity, hook_event_name: 'Stop', hook_event_id: 'frozen-stop', last_assistant_message: latestAssistantText(snapshot) } });
  const rcElapsedMs = Date.now() - start;
  await gateway.drain();
  const task = await findTask({ projectRoot, sessionId });
  const privateRuns = task ? await listNativeRuns(projectRoot, task.taskId) : [];
  const repairFeedback = outcome.stop ? outcome.stop.decision === 'block' && /\[runtime-corrector:stop-feedback\]/u.test(outcome.stop.feedback ?? '') : null;
  const reviewerRunIds = new Set(privateRuns.map(run => run.runId));
  const reviewerSessionIds = new Set(privateRuns.map(run => run.sessionId));
  const businessModelStarted = gateway.metrics().modelStarts.some(run => !reviewerRunIds.has(run.runId) && !reviewerSessionIds.has(run.sessionId));
  const complete = !businessModelStarted && outcome.stop?.review?.collection?.complete === true && !signal.aborted
    && privateRuns.length > 0 && privateRuns.every(run => run.status === 'SETTLED');
  return { mode: 'frozen-draft-verify-only', complete, sessionId, taskId: task?.taskId, rcElapsedMs, privateRuns,
    status: outcome.stop?.status ?? null, reason: outcome.stop?.reasonCode ?? outcome.reason ?? null, repairFeedback,
    feedback: repairFeedback ? redactEvaluationText(outcome.stop.feedback) : null, businessModelStarted, ...gateway.metrics() };
}
