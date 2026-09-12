import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, handleHook, finalizeArtifactCheck } from "../runtime-corrector.mjs";
import { runSemanticReview, REVIEW_SCHEMA } from "../semantic-review.mjs";
import { handleRuntimeV2Event, handleRuntimeV2SessionEnd, finalizeArtifactRuntimeV2 } from "../runtime-v2/orchestrator.mjs";
import { recordFailOpenWarning, countOuterStopFailure, clearOuterStopFailures } from "../runtime-v2/fail-open.mjs";
import { createOpenClawReviewerFactory, INTERNAL_SESSION_MARKER } from "./reviewer.mjs";
import { persistTranscript } from "./transcript.mjs";
import { changedFiles, selectedSkillRead, toolName } from "./tools.mjs";
import { checkEvidenceDistinctness } from "../evidence-distinctness.mjs";
import { isInternalExecution } from "./internal-context.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const joined = (...items) => items.filter(Boolean).join("\n\n");
const FEEDBACK = "[runtime-corrector:feedback]";

export function createOpenClawRuntime(api, { pluginRoot, reviewerFactory: injectedFactory, sharedState = {} } = {}) {
  const states = sharedState.states ??= new Map();
  const queues = sharedState.queues ??= new Map();
  const internalSessions = sharedState.internalSessions ??= new Set();
  const toolBindings = sharedState.toolBindings ??= new Map();
  const settings = api.pluginConfig ?? {};
  function internal(event, ctx) {
    const id = event.sessionId ?? ctx.sessionId;
    return isInternalExecution() || ctx.runtimeCorrectorInternal === true || internalSessions.has(id)
      || [ctx.sessionKey, event.sessionKey].some((key) => String(key ?? "").includes(INTERNAL_SESSION_MARKER));
  }
  function stateFor(event, ctx) {
    const sessionId = event.sessionId ?? ctx.sessionId;
    if (!sessionId || internal(event, ctx)) return null;
    const agentId = ctx.agentId ?? "main";
    const key = `${agentId}:${sessionId}`;
    let state = states.get(key);
    const config = api.runtime.config?.current?.() ?? api.config;
    const directory = ctx.workspaceDir ?? state?.projectRoot ?? event.cwd
      ?? api.runtime.agent.resolveAgentWorkspaceDir?.(config, agentId);
    if (!directory || !path.isAbsolute(directory)) throw new Error("OpenClaw did not provide an absolute workspace directory.");
    if (!state) {
      state = { key, sessionId, agentId, projectRoot: path.resolve(directory), entries: [], seen: new Map() };
      states.set(key, state);
    }
    if (path.resolve(directory) !== state.projectRoot) throw new Error("OpenClaw session workspace changed without a new session id.");
    state.sessionKey = ctx.sessionKey ?? event.sessionKey ?? state.sessionKey;
    state.provider = ctx.modelProviderId ?? event.provider ?? state.provider;
    state.model = ctx.modelId ?? event.model ?? state.model;
    return state;
  }
  function queue(state, callback) {
    const previous = queues.get(state.key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(callback);
    queues.set(state.key, next);
    return next.finally(() => { if (queues.get(state.key) === next) queues.delete(state.key); });
  }
  function hookBudget(name) {
    const policy = (api.runtime.config?.current?.() ?? api.config)?.plugins?.entries?.[api.id]?.hooks;
    return Math.max(1, Math.min(settings.hookTimeoutMs ?? 540000,
      policy?.timeouts?.[name] ?? policy?.timeoutMs ?? Infinity, 600000) - 1000);
  }
  async function context(state, hookName) {
    const plan = await loadConfig({ cwd: state.projectRoot, pluginRoot });
    const reviewerFactory = injectedFactory ?? createOpenClawReviewerFactory(api, {
      agentId: state.agentId, provider: state.provider, model: state.model,
      reviewerModel: settings.reviewerModel, reviewerTimeoutMs: settings.reviewerTimeoutMs,
      deadlineAt: Date.now() + hookBudget(hookName), internalSessions,
    });
    return { input: null, plan, projectRoot: state.projectRoot, pluginRoot, reviewerFactory };
  }
  function inputFor(state, eventName, fields = {}) {
    return { hook_event_name: eventName, session_id: state.sessionId, cwd: state.projectRoot,
      transcript_path: state.transcriptPath ?? "", hook_event_id: randomUUID(), ...fields };
  }
  async function run(state, eventName, fields, contextValue) {
    return handleRuntimeV2Event({ ...contextValue, input: inputFor(state, eventName, fields) });
  }
  async function failure(state, error, label) {
    // Host/model errors can include request data; expose a bounded message,
    // and redact ambient named credentials before persisting diagnostics.
    let message = String(error.message ?? error);
    for (const [key, value] of Object.entries(process.env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(key) && value?.length > 7) message = message.split(value).join("<redacted>");
    }
    message = message.replace(/(?:ark-|sk-)[a-z0-9_-]{15,}/giu, "<redacted>").slice(0, 1500);
    api.logger.warn(`[runtime-corrector] ${label}: ${message}`);
    await recordFailOpenWarning({ projectRoot: state.projectRoot, category: `OPENCLAW_${label}`, message }).catch(() => {});
    return `${FEEDBACK} 本次纠偏检查未完成：${message}`;
  }
  async function withState(event, ctx, callback) {
    if (settings.enabled === false || internal(event, ctx)) return;
    let state;
    try { state = stateFor(event, ctx); }
    catch (error) { api.logger.warn(`[runtime-corrector] ${error.message}`); return; }
    if (!state) return;
    return queue(state, () => callback(state));
  }
  const handlers = {
    async sessionStart(event, ctx) {
      return withState(event, ctx, async (state) => {
        try { const value = await context(state, "session_start"); await run(state, "SessionStart", { source: "startup" }, value); }
        catch (error) { await failure(state, error, "SESSION_START"); }
      });
    },
    async prompt(event, ctx) {
      return withState(event, ctx, async (state) => {
        try {
          const runId = ctx.runId ?? event.runId;
          // Finalize retries reuse the runId. They are not new user messages
          // and must not reset the correction budget or alter Ground Truth.
          const realUser = [undefined, "user", "manual"].includes(ctx.trigger)
            && (!state.hasPrompt || (runId && state.promptRunId !== runId));
          await persistTranscript(state, { messages: event.messages, prompt: event.prompt, realUser, runId });
          if (!realUser) return;
          state.promptRunId = runId;
          state.hasPrompt = true;
          state.finalNotice = null;
          const value = await context(state, "before_prompt_build");
          const outcome = await run(state, "UserPromptSubmit", { prompt: event.prompt }, value);
          if (outcome.feedback) return { prependContext: `${FEEDBACK}\n${outcome.feedback}` };
        } catch (error) { await failure(state, error, "PROMPT"); }
      });
    },
    async beforeTool(event, ctx) {
      // The pinned native runtime supplies only {runtime:"openclaw"} to
      // result middleware. Bind the exact call before execution; never infer
      // a session from cwd (several conversations can share one workspace).
      const callId = event.toolCallId ?? ctx.toolCallId;
      if (callId && ctx.sessionId) {
        const bindings = toolBindings.get(callId) ?? new Map();
        bindings.set(`${ctx.agentId ?? "main"}:${ctx.sessionId}`, {
          ...ctx, ...(internal(event, ctx) ? { runtimeCorrectorInternal: true } : {}),
        });
        toolBindings.set(callId, bindings);
        if (toolBindings.size > 5000) toolBindings.delete(toolBindings.keys().next().value);
      }
      return withState(event, ctx, async (state) => {
        const id = event.toolCallId ?? ctx.toolCallId;
        if (!id) return;
        const key = `pre:${id}`;
        if (state.seen.has(key)) return state.seen.get(key);
        try {
          const value = await context(state, "before_tool_call");
          const args = event.params ?? {};
          const skill = await selectedSkillRead(event.toolName, args, state, pluginRoot,
            value.plan.runtimeV2?.skillCorrection?.skillRoots);
          const name = skill ? "Skill" : toolName(event.toolName);
          state.entries.push({ type: "assistant", uuid: `oc-tool-${id}`, message: { id: `oc-tool-${id}`,
            content: [{ type: "tool_use", id, name, input: args }] } });
          await persistTranscript(state);
          const outcome = await run(state, "PreToolUse", { tool_name: name,
            tool_input: skill ? { skill } : args, tool_use_id: id }, value);
          // Advisory skill feedback travels with the read's tool result.
          if (outcome.feedback) state.seen.set(`feedback:${id}`, outcome.feedback);
          state.seen.set(key, undefined);
        } catch (error) { await failure(state, error, "PRE_TOOL"); }
      });
    },
    async toolResult(event, ctx) {
      // Check before resolving a bare call id: reviewer calls must never be
      // attached to a main task's binding, including after reviewer cleanup.
      if (internal(event, ctx)) return;
      if (!ctx.sessionId && !event.sessionId) {
        const bindings = [...(toolBindings.get(event.toolCallId)?.values() ?? [])];
        if (bindings.length !== 1) {
          if (bindings.length > 1) api.logger.warn("[runtime-corrector] Ambiguous tool call identity; result review skipped.");
          return;
        }
        ctx = { ...bindings[0], ...ctx };
      }
      return withState(event, ctx, async (state) => {
        const id = event.toolCallId;
        if (!id) return;
        const key = `post:${id}`;
        if (state.seen.has(key)) return state.seen.get(key);
        let value;
        try {
          value = await context(state, "tool_result");
          const content = event.result?.content ?? [];
          state.entries.push({ type: "user", isMeta: true, uuid: `oc-result-${id}`, message: {
            content: [{ type: "tool_result", tool_use_id: id, content, is_error: event.isError === true }] } });
          await persistTranscript(state);
          const fields = { tool_name: toolName(event.toolName), tool_input: event.args ?? {},
            tool_response: event.result, tool_use_id: id };
          let feedback = state.seen.get(`feedback:${id}`);
          const files = event.isError || event.result?.isError ? [] : changedFiles(event.toolName, event.args ?? {}, state.projectRoot, event.cwd);
          const existing = [];
          for (const file of files) { try { if ((await fs.stat(file)).isFile()) existing.push(file); } catch { /* Deleted file: covered by terminal review. */ } }
          for (const file of existing.length ? existing : [null]) {
            const input = inputFor(state, "PostToolUse", { ...fields, ...(file ? {
              tool_name: "Edit", tool_input: { ...fields.tool_input, file_path: file },
            } : {}) });
            const prepared = file ? await handleHook(input, { deferPersistence: true, pluginRoot }) : { matched: false };
            const outcome = await handleRuntimeV2Event({ ...value, input,
              artifact: prepared.matched ? prepared.reviewContext.artifact : null });
            feedback = joined(feedback, outcome.feedback);
            if (!prepared.matched) continue;
            prepared.reviewContext.enabled = prepared.reviewContext.nodeReviewEnabled
              || (prepared.reviewContext.workflow?.incomingEdges?.length ?? 0) > 0 || Boolean(outcome.artifactReviewContext);
            const review = prepared.reviewContext.enabled ? await runSemanticReview({
              input, prepared, pluginRoot, runtimeV2Handle: outcome.reviewerHandle,
              runtimeV2Context: outcome.artifactReviewContext, runtimeV2ExecutionContext: outcome.reviewerExecutionContext,
              runtimeV2Evidence: outcome.reviewerEvidence, runtimeV2ReviewerFactory: value.reviewerFactory,
              invokeFork: async (request) => {
                const semanticReviewRequestPath = request.prompt.match(/--request "([^"]+)"/u)?.[1];
                if (!semanticReviewRequestPath) throw new Error("Semantic review request path is missing.");
                const handle = await value.reviewerFactory({ projectRoot: state.projectRoot, sessionCwd: state.projectRoot,
                  taskId: outcome.taskId ?? `openclaw-${hash(state.sessionId)}`, parentSessionId: state.sessionId,
                  role: "artifact-reviewer", reviewer: { timeoutMs: request.timeoutMs, session: "detached" },
                  reviewerRuntime: request.reviewerRuntime,
                  evidence: { snapshot: { entries: state.entries } },
                  schema: REVIEW_SCHEMA, request: { semanticReviewRequestPath,
                    instructions: "Read semanticReviewRequestPath and review all available artifacts according to the semantic-review protocol, project criteria and deterministic diagnostics." }, pluginRoot });
                try { return { sessionId: handle.sessionId, review: handle.result }; } finally { await handle.close(); }
              },
            }) : null;
            if (!prepared.reviewContext.enabled) await outcome.reviewerHandle?.close();
            const finalized = await finalizeArtifactCheck(prepared, review);
            feedback = joined(feedback, finalized.feedback);
            if (outcome.artifactReviewContext) {
              const metrics = await finalizeArtifactRuntimeV2({ runtimeV2: value.plan.runtimeV2,
                projectRoot: state.projectRoot, taskId: outcome.taskId,
                artifactReviewContext: outcome.artifactReviewContext, semanticReview: review,
                delivered: !value.plan.runtimeV2?.shadowMode && Boolean(finalized.feedback) });
              feedback = joined(feedback, metrics.feedback);
            }
          }
          if (["Bash", "Write", "Edit"].includes(fields.tool_name)) {
            feedback = joined(feedback, checkEvidenceDistinctness({ projectRoot: state.projectRoot, plan: value.plan }));
          }
          const result = feedback && !value.plan.runtimeV2?.shadowMode ? { result: { ...event.result,
            content: [...content, { type: "text", text: `${FEEDBACK}\n${feedback}` }] } } : undefined;
          state.seen.set(key, result);
          if (state.seen.size > 3000) state.seen.clear();
          return result;
        } catch (error) {
          const feedback = await failure(state, error, "POST_TOOL");
          if (value && !value.plan.runtimeV2?.shadowMode) return { result: { ...event.result,
            content: [...(event.result?.content ?? []), { type: "text", text: feedback }] } };
        }
      });
    },
    async finalize(event, ctx) {
      return withState(event, ctx, async (state) => {
        let value;
        try {
          await persistTranscript(state, { messages: event.messages, transcriptPath: event.transcriptPath });
          value = await context(state, "before_agent_finalize");
          const outcome = await run(state, "Stop", { stop_hook_active: event.stopHookActive === true,
            last_assistant_message: event.lastAssistantMessage ?? "" }, value);
          state.finalRunId = ctx.runId ?? event.runId;
          state.finalNotice = value.plan.runtimeV2?.shadowMode ? null : outcome.decision === "block"
            ? "纠偏验收尚未通过。已要求修正；宿主可能因副作用保护、重试上限或中止而结束，最后的改动仍需重新验收。"
            : outcome.feedback ?? null;
          if (["block", "allow"].includes(outcome.decision)) await clearOuterStopFailures(state.projectRoot);
          if (outcome.decision === "block" && outcome.feedback) {
            api.logger.warn(`${FEEDBACK}\n${outcome.feedback}`);
            return {
            action: "revise", reason: `${FEEDBACK}\n${outcome.feedback}`,
            retry: { instruction: "继续修正以上问题；修正后重新完成验收。", idempotencyKey: `runtime-corrector:${state.sessionId}:${ctx.runId ?? event.runId}`,
              maxAttempts: Math.min(3, value.plan.runtimeV2?.stopCorrection?.maxCorrectionsPerEpoch ?? 3) },
            };
          }
          if (outcome.feedback && !value.plan.runtimeV2?.shadowMode) api.logger.warn(outcome.feedback);
        } catch (error) {
          const feedback = await failure(state, error, "FINALIZE");
          state.finalRunId = ctx.runId ?? event.runId;
          state.finalNotice = value?.plan.runtimeV2?.shadowMode ? null : feedback;
          if (value?.plan.runtimeV2?.stopCorrection?.enabled && !value.plan.runtimeV2.shadowMode) {
            const { released } = await countOuterStopFailure(state.projectRoot);
            if (!released) return { action: "revise", reason: feedback,
              retry: { instruction: "验收尚未完成；请保留未验证状态并重试。", maxAttempts: 3,
                idempotencyKey: `runtime-corrector-failure:${state.sessionId}:${ctx.runId ?? event.runId}` } };
          }
        }
      });
    },
    async reply(event) {
      if (settings.enabled === false || internal(event, {}) || event.kind !== "final" || !event.runId) return;
      const matches = [...states.values()].filter((state) => state.finalRunId === event.runId
        && (!event.sessionKey || state.sessionKey === event.sessionKey)
        && (!event.usageState?.sessionId || state.sessionId === event.usageState.sessionId));
      if (matches.length !== 1 || !matches[0].finalNotice) return;
      const notice = `${FEEDBACK}\n${matches[0].finalNotice}`;
      if (event.payload.text?.includes(notice)) return;
      return { payload: { ...event.payload, text: joined(event.payload.text, notice) } };
    },
    async compact(event, ctx) {
      return withState(event, ctx, async (state) => {
        try { const value = await context(state, "before_compaction");
          await run(state, "PreCompact", { trigger: "auto", custom_instructions: null }, value);
        } catch (error) { await failure(state, error, "COMPACT"); }
      });
    },
    async sessionEnd(event, ctx) {
      return withState(event, ctx, async (state) => {
        await handleRuntimeV2SessionEnd({ projectRoot: state.projectRoot,
          input: inputFor(state, "SessionEnd", { reason: event.reason ?? "unknown" }) });
        states.delete(state.key);
        for (const [id, bindings] of toolBindings) {
          bindings.delete(state.key);
          if (!bindings.size) toolBindings.delete(id);
        }
      });
    },
  };
  return { ...handlers, internalSessions };
}
