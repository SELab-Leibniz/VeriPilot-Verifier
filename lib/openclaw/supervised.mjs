import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findTask, withTaskState } from "../runtime-v2/task-store.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { isInternalExecution, isManagedExecution, runManagedExecution } from "./internal-context.mjs";
import { withController, privateJson, workerIdentityPath } from "./controller-store.mjs";
import { loadSupervisedCompatibility } from "./compat-2026.7.1-2.mjs";
import { createEvidenceLedger } from "./evidence.mjs";

export const SUPERVISED_RUNTIME = "runtime-corrector-supervised";
const terminalText = {
  UNVERIFIED: "本次成果尚未验证，已停止自动续跑。",
  CANCELLED: "任务已取消，未交付完成结果。",
  BUDGET_EXHAUSTED: "纠偏次数已用尽，成果仍未通过验收。",
  WAITING_FOR_USER: "需要你补充信息或作出决定，自动执行已暂停。",
};
const failureText = {
  NATIVE_RUN_UNSETTLED: "原生执行未正常结束；部分工具可能已执行，请先核对成果。",
  EVIDENCE_CHANGED: "成果在验收期间或交付前发生变化，当前验收证据已失效。",
};
const failure = (code) => Object.assign(new Error(code), { code });

async function records(file) {
  try { return (await fs.readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// A check that read unstable evidence cannot certify it. Hash contents as
// well as names; mtimes alone miss same-size replacements and deletions.
export async function workspaceEvidence(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", ".runtime-correction", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) entries.push([path.relative(root, file), sha256(await fs.readFile(file))]);
      else if (entry.isSymbolicLink()) entries.push([path.relative(root, file), "symlink", await fs.readlink(file)]);
    }
  }
  await walk(root);
  return sha256(entries);
}

export function completionStatus(outcome, task) {
  if (outcome.correctionBudgetExhausted) return "BUDGET_EXHAUSTED";
  if (outcome.status === "UNVERIFIED" || outcome.verificationIncomplete || outcome.verificationUnavailable) return "UNVERIFIED";
  if (outcome.reason === "STOP_BARRIER_NOT_REQUIRED" && !task?.correctionBarrier?.turnActivated) return "CHAT";
  if (outcome.decision === "block" && outcome.feedback) return "CORRECT";
  if (outcome.review?.stopClassification === "TASK_COMPLETE" && outcome.report?.status === "PASS"
    && task?.status === "COMPLETED" && task?.verification?.status === "PASS" && !outcome.shadowMode) return "VERIFIED";
  if (outcome.review && !["TASK_COMPLETE", "STAGE_COMPLETE"].includes(outcome.review.stopClassification)) return "WAITING_FOR_USER";
  return "UNVERIFIED";
}

function attemptResult(params, result) {
  const text = result.text;
  const assistant = result.assistantMessage ?? { role: "assistant", content: [{ type: "text", text }],
    api: params.model?.api ?? "anthropic-messages", provider: params.provider, model: params.modelId,
    stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  return { aborted: result.status === "CANCELLED", externalAbort: result.status === "CANCELLED",
    timedOut: false, idleTimedOut: false, timedOutDuringCompaction: false,
    promptError: null, promptErrorSource: null, sessionIdUsed: params.sessionId, sessionFileUsed: params.sessionFile,
    assistantTranscriptOwned: true, agentHarnessId: SUPERVISED_RUNTIME,
    messagesSnapshot: result.messages ?? [assistant], assistantTexts: [text], lastAssistant: assistant,
    lastAssistantTextMessageIndex: (result.messages?.length ?? 1) - 1,
    currentAttemptAssistant: assistant, toolMetas: result.toolMetas ?? [],
    didSendViaMessagingTool: result.didSendViaMessagingTool ?? false,
    messagingToolSentTexts: result.messagingToolSentTexts ?? [], messagingToolSentMediaUrls: result.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: result.messagingToolSentTargets ?? [], cloudCodeAssistFormatError: false,
    // A supervisor never authorizes the outer fallback loop to replay work.
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...(result.usage ? { attemptUsage: result.usage } : {}),
    ...(result.mediaUrls?.length ? { toolMediaUrls: result.mediaUrls } : {}),
  };
}

export function createSupervisedHarness(api, runtime, { sharedState = {}, compatibility = loadSupervisedCompatibility,
  evidence } = {}) {
  const active = sharedState.controllers ??= new Map();
  let compatPromise;
  const compat = () => compatPromise ??= compatibility();
  const enabled = () => {
    const config = api.runtime.config?.current?.() ?? api.config;
    const entry = config?.plugins?.entries?.[api.id];
    return entry?.enabled !== false && (entry?.config ?? api.pluginConfig)?.enabled !== false
      && (entry?.config ?? api.pluginConfig)?.supervisedExecution !== false;
  };
  return {
    id: SUPERVISED_RUNTIME, label: "Runtime Corrector supervised execution",
    contextEngineHostCapabilities: ["bootstrap", "assemble-before-prompt", "after-turn", "maintain", "compact", "runtime-llm-complete"],
    supports: (ctx) => ({ supported: ctx.requestedRuntime === SUPERVISED_RUNTIME, priority: 100 }),
    async reset(params) {
      for (const control of active.values()) if ((!params.sessionId || params.sessionId === control.sessionId)
        && (!params.sessionKey || params.sessionKey === control.sessionKey)) control.abort();
    },
    async dispose() { for (const control of active.values()) control.abort(); },
    async runAttempt(params) {
      if (isInternalExecution() || isManagedExecution() || runtime.isWorker(params.sessionId, params.workspaceDir)) throw new Error("Internal runs cannot create a correction controller.");
      if (params.inputProvenance?.kind && params.inputProvenance.kind !== "external_user") {
        throw new Error("A correction controller requires genuine user input.");
      }
      const sdk = await compat();
      if (!enabled()) return sdk.nativeHarness(params).runAttempt({ ...params, agentHarnessRuntimeOverride: "openclaw", agentHarnessId: "openclaw" });
      const key = `${params.sessionId}:${params.runId}`;
      if (active.has(key)) return active.get(key).promise;
      const abort = new AbortController();
      const cancel = () => abort.abort(new Error("OpenClaw parent run cancelled."));
      for (const signal of [params.abortSignal, params.replyOperation?.abortSignal]) {
        if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
      }
      const controller = { sessionId: params.sessionId, sessionKey: params.sessionKey, abort: cancel };
      active.set(key, controller);
      const ownedRuns = new Set();
      const noteProgress = (reason) => {
        if (abort.signal.aborted || active.get(key) !== controller) return;
        sdk.reportProgress(params, `runtime-corrector:${reason}`);
        params.onRunProgress?.({ reason: `runtime-corrector:${reason}` });
      };
      // Mirror actual native activity only. A periodic heartbeat would hide a
      // genuinely stuck child from the host's independent recovery policy.
      const removeActivity = sdk.onRunActivity((event) => {
        if (ownedRuns.has(event.runId) && /^(run\.progress|model\.call\.|tool\.execution\.)/u.test(event.type)) {
          noteProgress(event.type);
        }
      });
      const emit = async (event) => {
        try {
        sdk.emitAgentEvent({ runId: params.runId, sessionId: params.sessionId, sessionKey: params.sessionKey,
          agentId: params.agentId, lifecycleGeneration: params.lifecycleGeneration, ...event });
        await params.onAgentEvent?.(event);
        } catch { api.logger?.warn("[runtime-corrector] Parent progress delivery failed; execution receipt remains authoritative."); }
      };
      const timeoutMs = Math.max(1, params.timeoutMs ?? 600000);
      const timer = setTimeout(cancel, timeoutMs);
      const configWatch = setInterval(() => { if (!enabled()) cancel(); }, 250);
      controller.promise = (async () => {
        await emit({ stream: "lifecycle", data: { phase: "start", startedAt: Date.now() } });
        const task = await findTask({ projectRoot: params.workspaceDir, sessionId: params.sessionId });
        const result = await withController({ projectRoot: params.workspaceDir, sessionId: params.sessionId,
          runId: params.runId, taskId: task?.taskId }, async (store) => {
          let workerId, workerLease, state, handle, stage = "STARTING", closed = false, inputVersion = 0;
          let inheritedIds = new Set(), assessmentAbort;
          let pendingInput = Promise.resolve();
          const check = async () => {
            abort.signal.throwIfAborted();
            if (!enabled() || !await store.current()) throw new Error("Supervised controller no longer owns this run.");
          };
          const progress = async (text) => {
            noteProgress(store.record.phase);
            const itemId = `runtime-corrector:${store.record.generation}:${store.record.round}:${store.record.phase}`;
            // Full snapshots (without delta) are replaced by the next phase and
            // by the verified final. The stock TUI suppresses commentary events.
            const event = { stream: "assistant", data: { text, itemId, replace: true } };
            await emit(event);
            await params.onPartialReply?.({ text, delta: text, replace: true });
          };
          const parentAppend = async (message, id) => sdk.appendSessionTranscriptMessage({ config: params.config,
            transcriptPath: params.sessionFile, sessionId: params.sessionId, cwd: params.workspaceDir,
            message: { ...message, idempotencyKey: id === "final" ? params.runId : `runtime-corrector:${params.runId}:${id}` }, idempotencyLookup: "scan",
            prepareMessageAfterIdempotencyCheck: (candidate) => id === "final" && abort.signal.aborted ? undefined : candidate });
          async function persistUser(text, recorder, id) {
            if (recorder) {
              await recorder.persistApproved();
              if (!recorder.hasPersisted()) throw new Error("OpenClaw user requirement was not persisted.");
            } else await parentAppend({ role: "user", content: text, timestamp: Date.now(), provenance: { kind: "external_user" } }, id);
          }
          try {
            await check();
            state = await runtime.beginSupervised(params, abort.signal);
            state.onReviewRunStart = (id) => ownedRuns.add(id);
            state.onReviewRunEnd = (id) => ownedRuns.delete(id);
            state.onTaskState = (task) => store.save({ taskId: task.taskId, requirementVersion: task.groundTruth.version,
              epoch: task.correctionEpoch.id });
            const sessionFile = path.join(store.directory, store.record.generation, "worker.jsonl");
            await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
            // Copy all native context, including compaction/branch records,
            // before appending this turn to the parent conversation.
            const lock = await sdk.acquireSessionWriteLock({ sessionFile: params.sessionFile, signal: abort.signal });
            try {
              const history = await records(params.sessionFile);
              inheritedIds = new Set(history.map((record) => record.id));
              workerId = randomUUID();
              await fs.writeFile(sessionFile, history.map((record) => JSON.stringify(record.type === "session"
                ? { ...record, id: workerId } : record)).join("\n") + "\n", { mode: 0o600 });
            } finally { await lock.release(); }
            await persistUser(params.transcriptPrompt ?? params.prompt, params.userTurnTranscriptRecorder, "user");
            await privateJson(workerIdentityPath(params.workspaceDir, workerId), { workerSessionId: workerId,
              parentSessionId: params.sessionId, generation: store.record.generation, createdAt: Date.now() });
            workerLease = runtime.bindWorker(workerId, state);
            handle = { kind: "embedded", runId: params.runId, supportsTranscriptCommitWait: true,
              sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
              isStreaming: () => !closed && stage !== "DELIVERING" && !abort.signal.aborted,
              isStopped: () => closed || abort.signal.aborted, isAbortable: () => !closed,
              isCompacting: () => false, cancel, abort: cancel,
              queueMessage(text, options = {}) {
                const receivedId = randomUUID();
                const operation = pendingInput.then(async () => {
                  await check();
                  if (closed || stage === "DELIVERING") throw new Error("This controller has already closed its user input window.");
                  // Only the host's user-turn recorder can authorize steering.
                  // Inter-agent/background injections cannot change Ground Truth.
                  const recorder = options.userTurnTranscriptRecorder;
                  const message = await recorder?.resolveMessage();
                  if (!recorder || message?.provenance?.kind && message.provenance.kind !== "external_user") {
                    throw new Error("Acknowledged user-turn provenance is required for supervised steering.");
                  }
                  await store.save({ pendingRequirement: { id: receivedId, status: "DELIVERING" } });
                  const target = { transcriptPath: sessionFile, sessionId: workerId, cwd: params.workspaceDir, config: params.config };
                  const workerRecorder = sdk.workerRecorder?.({ ...message, provenance: { kind: "external_user" } }, target);
                  if (!workerRecorder) throw new Error("OpenClaw user-turn recorder capability is unavailable.");
                  if (stage === "EXECUTING") {
                    await sdk.queueAcknowledged(workerId, text, { ...options, userTurnTranscriptRecorder: workerRecorder });
                  } else {
                    // Native execution has settled. Commit this genuine input
                    // into the next native turn and invalidate the in-flight
                    // assessment before acknowledging the parent queue handle.
                    inputVersion += 1;
                    assessmentAbort?.abort(new Error("User requirements changed during assessment."));
                    await workerRecorder.persistApproved();
                    if (!workerRecorder.hasPersisted()) throw new Error("Native worker did not persist the queued user requirement.");
                  }
                  await persistUser(text, recorder, receivedId);
                  await runtime.acceptRequirement(state, text, receivedId);
                  inputVersion += 1;
                  await store.save({ pendingRequirement: { id: receivedId, status: "ACKNOWLEDGED" }, inputVersion });
                });
                pendingInput = operation.catch((error) => { cancel(); throw error; });
                pendingInput.catch(() => {});
                return operation;
              },
            };
            sdk.setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
            params.replyOperation?.attachBackend(handle);
            params.onExecutionStarted?.({ lifecycleGeneration: params.lifecycleGeneration });
            params.onExecutionPhase?.({ phase: "turn_accepted", backend: SUPERVISED_RUNTIME });
            let prompt = params.prompt, finalResult, assessment = 0;
            const sent = { messagingToolSentTexts: [], messagingToolSentMediaUrls: [], messagingToolSentTargets: [], didSendViaMessagingTool: false,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
            executionLoop: while (true) {
              await check();
              const round = store.record.round + 1;
              const nativeRunId = randomUUID();
              await store.save({ phase: "EXECUTING", round, nativeRunId, workerSessionId: workerId });
              workerLease.setRun?.(nativeRunId);
              stage = "EXECUTING";
              await progress(round === 1 ? "正在执行任务。" : `正在修正第 ${round - 1} 轮验收发现的问题。`);
              const workerKey = `agent:${params.agentId ?? "main"}:rc-worker:${workerId}`;
              if (!sdk.workerPolicy) throw new Error("Private native worker policy capability is unavailable.");
              const policy = sdk.workerPolicy(params, workerKey);
              const child = { ...params, ...policy, sessionId: workerId, sessionKey: workerKey,
                sessionFile, sessionTarget: undefined,
                agentHarnessRuntimeOverride: "openclaw", agentHarnessOverride: undefined, agentHarnessId: undefined,
                model: params.modelId, runId: nativeRunId, abortSignal: abort.signal,
                lane: `runtime-corrector-worker:${workerId}`, enqueue: undefined, replyOperation: undefined,
                // The controller owns only the parent's deferred terminal event.
                // A private child must finish its own host lifecycle completely.
                deferTerminalLifecycle: false, deferTerminalLifecycleEnd: false,
                timeoutMs: Math.max(1, timeoutMs - (Date.now() - store.record.createdAt)),
                prompt, transcriptPrompt: round === 1 ? params.transcriptPrompt : undefined,
                inputProvenance: round === 1 ? params.inputProvenance : { kind: "internal_system", originSessionId: params.sessionId },
                suppressLiveStreamOutput: true, userTurnTranscriptRecorder: undefined, onUserMessagePersisted: undefined,
                suppressNextUserMessagePersistence: round === 1 ? params.suppressNextUserMessagePersistence : false,
              };
              for (const name of Object.keys(child)) if (name.startsWith("on") && typeof child[name] === "function") delete child[name];
              child.onRunProgress = () => noteProgress("native-work");
              // Child IDs are private; copying parent delivery callbacks would
              // leak a candidate reply before its assessment.
              ownedRuns.add(nativeRunId);
              try { finalResult = await runManagedExecution(workerId, () => api.runtime.agent.runEmbeddedAgent(child)); }
              finally { ownedRuns.delete(nativeRunId); }
              workerLease.endRun?.();
              stage = "VERIFYING";
              await pendingInput;
              await check();
              const text = (finalResult.payloads ?? []).filter((item) => !item.isReasoning && !item.isCommentary)
                .map((item) => item.text ?? "").filter(Boolean).join("\n");
              for (const name of ["messagingToolSentTexts", "messagingToolSentMediaUrls", "messagingToolSentTargets"]) sent[name].push(...finalResult[name] ?? []);
              sent.didSendViaMessagingTool ||= finalResult.didSendViaMessagingTool === true;
              for (const key of Object.keys(sent.usage)) sent.usage[key] += finalResult.meta?.agentMeta?.usage?.[key] ?? 0;
              await privateJson(path.join(path.dirname(sessionFile), `round-${round}.json`), { nativeRunId, text,
                meta: { aborted: finalResult.meta?.aborted, error: finalResult.meta?.error?.kind } });
              await store.save({ phase: "EXECUTED" });
              if (finalResult.meta?.aborted || finalResult.meta?.error || !text || finalResult.meta?.yielded) {
                throw failure("NATIVE_RUN_UNSETTLED");
              }
              let outcome, taskState, digest, reviewedInputVersion, ledger;
              const readEvidence = () => (evidence ?? workspaceEvidence)(params.workspaceDir);
              const evidenceMatches = () => ledger ? ledger.matches() : readEvidence().then((value) => value === digest);
              do {
                await check();
                ledger = !evidence && state.observedPaths ? createEvidenceLedger(params.workspaceDir) : null;
                if (ledger) await ledger.capture(state.observedPaths);
                state.observeReviewTool = ledger?.observeTool;
                digest = ledger ? ledger.snapshot().digest : await readEvidence();
                reviewedInputVersion = inputVersion;
                assessmentAbort = new AbortController();
                const stopAssessment = () => assessmentAbort.abort(abort.signal.reason);
                abort.signal.addEventListener("abort", stopAssessment, { once: true });
                const assessmentId = `${store.record.generation}:${++assessment}`;
                await store.save({ phase: "ASSESSING", assessmentId, evidenceDigest: digest });
                await progress("正在验收当前成果。");
                try {
                outcome = await runtime.assessSupervised(state, { transcriptPath: sessionFile, text,
                  assessmentId, stopHookActive: round > 1 || assessment > 1, abortSignal: assessmentAbort.signal });
                } catch (error) {
                  if (inputVersion === reviewedInputVersion || abort.signal.aborted) throw error;
                } finally { abort.signal.removeEventListener("abort", stopAssessment); }
                await pendingInput;
                if (inputVersion !== reviewedInputVersion) {
                  await check();
                  await store.save({ phase: "REQUIREMENT_UPDATED", decision: null });
                  prompt = "请依据刚刚收到的真实用户补充要求继续完成原任务，再提交当前成果接受验收。";
                  continue executionLoop;
                }
                await check();
                taskState = await findTask({ projectRoot: params.workspaceDir, sessionId: params.sessionId });
                await store.save({ phase: "ASSESSED", decision: outcome, taskId: taskState?.taskId ?? null,
                  requirementVersion: taskState?.groundTruth?.version, epoch: taskState?.correctionEpoch?.id,
                  ...(ledger ? { evidence: ledger.snapshot() } : {}) });
                // Original core owns the independent infrastructure retry count.
              } while (outcome.decision === "block" && outcome.status === "UNVERIFIED");
              const status = completionStatus(outcome, taskState);
              if (status === "CORRECT") { prompt = `[runtime-corrector:feedback]\n${outcome.feedback}\n继续完成原任务。以上为自动验收反馈，不是新的用户要求。`; continue; }
              await check();
              if (!await evidenceMatches()) throw failure("EVIDENCE_CHANGED");
              const delivered = ["VERIFIED", "CHAT"].includes(status);
              const result = { ...sent, status, text: delivered ? text : `${terminalText[status]}${status === "WAITING_FOR_USER" ? `\n\n${text}` : outcome.feedback ? `\n\n${outcome.feedback}` : ""}`,
                mediaUrls: delivered ? (finalResult.payloads ?? []).flatMap((item) => item.mediaUrls ?? (item.mediaUrl ? [item.mediaUrl] : [])) : [] };
              // Preserve paired execution evidence, but never candidate prose or
              // internal correction prompts as parent user turns.
              const history = await records(sessionFile);
              for (const record of history) {
                if (inheritedIds.has(record.id)) continue;
                const message = record.message;
                if (message?.role === "toolResult") await parentAppend(message, `evidence:${record.id}`);
                else if (message?.role === "assistant" && Array.isArray(message.content)
                  && message.content.some((item) => item.type === "toolCall")) {
                  await parentAppend({ ...message, content: message.content.filter((item) => item.type === "toolCall") }, `evidence:${record.id}`);
                }
              }
              await pendingInput;
              if (inputVersion !== reviewedInputVersion) {
                prompt = "请依据刚刚收到的真实用户补充要求继续完成原任务，再提交当前成果接受验收。";
                continue executionLoop;
              }
              stage = "DELIVERING";
              await check();
              if (!await evidenceMatches()) throw failure("EVIDENCE_CHANGED");
              await store.save({ phase: "DELIVERING", result });
              await check();
              result.assistantMessage = attemptResult(params, result).lastAssistant;
              const appended = await parentAppend(result.assistantMessage, "final");
              await check();
              result.assistantMessageId = appended?.messageId;
              await store.save({ phase: delivered ? "DELIVERED" : "STOPPED", result });
              return result;
            }
          } catch (error) {
            // A superseded controller must not even mark the shared core task
            // unverified: that task may now belong to a newer generation.
            if (!await store.current()) throw error;
            const status = abort.signal.aborted ? "CANCELLED" : "UNVERIFIED";
            const result = { status, text: terminalText[status] + (status !== "CANCELLED" && failureText[error.code] ? `\n${failureText[error.code]}` : "") };
            const taskState = await findTask({ projectRoot: params.workspaceDir, sessionId: params.sessionId });
            if (taskState) await withTaskState({ projectRoot: params.workspaceDir, taskId: taskState.taskId }, async (task) => {
              if (!await store.current()) return;
              task.status = "STOPPED_UNVERIFIED";
              task.verification = { ...task.verification, status: "UNVERIFIED", reason: `SUPERVISED_${status}` };
            });
            // Detailed native errors may contain authentication; keep only a
            // bounded code, never serialize the exception/config/attempt.
            await store.save({ phase: status, result, failureCode: error.code ?? error.name ?? "Error" });
            if (status !== "CANCELLED") await parentAppend(attemptResult(params, result).lastAssistant, "final");
            return result;
          } finally {
            closed = true;
            if (state) { state.onTaskState = null; state.observeReviewTool = null; state.onReviewRunStart = null; state.onReviewRunEnd = null; }
            workerLease?.close();
            if (workerId) sdk.abortAgentHarnessRun(workerId);
            if (handle) {
              params.replyOperation?.detachBackend(handle);
              sdk.clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
            }
          }
        }).catch(() => {
          // Lock/disk failures must not escape as retryable model errors: the
          // host cannot safely replay work whose durable receipt is uncertain.
          api.logger?.error("[runtime-corrector] Controller persistence or ownership failed; automatic replay is disabled.");
          return { status: abort.signal.aborted ? "CANCELLED" : "UNVERIFIED",
            text: abort.signal.aborted ? terminalText.CANCELLED : terminalText.UNVERIFIED };
        });
        if (!abort.signal.aborted && result.status !== "CANCELLED") await emit({ stream: "assistant",
          data: { text: result.text, phase: "final", messageId: result.assistantMessageId } });
        await emit({ stream: "lifecycle", data: { phase: params.deferTerminalLifecycle ? "finishing" : "end",
          endedAt: Date.now(), aborted: abort.signal.aborted || result.status === "CANCELLED", replayInvalid: true,
          stopReason: result.status === "CANCELLED" ? "aborted" : "stop" } });
        return attemptResult(params, abort.signal.aborted ? { status: "CANCELLED", text: terminalText.CANCELLED } : result);
      })().finally(() => {
        clearTimeout(timer); clearInterval(configWatch); active.delete(key);
        removeActivity(); ownedRuns.clear();
        for (const signal of [params.abortSignal, params.replyOperation?.abortSignal]) signal?.removeEventListener("abort", cancel);
      });
      return controller.promise;
    },
  };
}
