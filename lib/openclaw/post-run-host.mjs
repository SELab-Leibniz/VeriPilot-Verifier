import { beforeStopDeadline } from "../runtime-v2/stop-deadline.mjs";
import { loadInteractionCompatibility } from "./compat-2026.7.1-2.mjs";

/** Third-party plugins use the public authenticated client when trusted-plugin
 * dispatch is unavailable. Never retry a request that may have reached the host. */
export function createPostRunHostRequester(api, { compatibility = loadInteractionCompatibility } = {}) {
  let nativeAllowed = typeof api.runtime.gateway?.request === "function", sdk;
  return async (method, params, options = {}) => {
    if (!["agent.wait", "chat.send", "autopilot.status"].includes(method)) throw new Error("Unsupported post-run host method.");
    if (nativeAllowed) {
      try { return await api.runtime.gateway.request(method, params, options); }
      catch (error) {
        // In the pinned host this error is thrown before method dispatch.
        if (error.message !== "Gateway requests are only available to bundled or trusted official plugins.") throw error;
        nativeAllowed = false;
      }
    }
    sdk ??= compatibility();
    return (await sdk).callGatewayFromCli(method, { timeout: String(options.timeoutMs ?? 15000), json: true }, params,
      { progress: false, scopes: method === "autopilot.status" ? ["operator.read"] : ["operator.read", "operator.write"], signal: options.signal });
  };
}

export async function readAutopilotStatus(api, identity, { signal, request = createPostRunHostRequester(api) } = {}) {
  const result = (status, reason, message, hostStatus) => ({ status, reason, message,
    ...(hostStatus ? { hostStatus } : {}), updatedAt: Date.now() });
  let config;
  try { config = api.runtime.config?.current?.() ?? api.config; }
  catch { return result("UNKNOWN", "AUTOPILOT_STATUS_UNAVAILABLE", "无法读取宿主配置以核实 autopilot 状态；仅提示可能互斥，不推断其已结束。"); }
  const entry = config?.plugins?.entries?.autopilot;
  if (entry?.enabled === false || config?.plugins?.enabled === false || config?.plugins?.deny?.includes("autopilot"))
    return result("IDLE", "AUTOPILOT_DISABLED", "autopilot 已禁用，RC 正常审查。");
  if (!entry || !identity.sessionKey)
    return result("UNKNOWN", "AUTOPILOT_STATUS_UNAVAILABLE", "无法核实 autopilot 状态；仅提示可能互斥，RC 保持现有行为。");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Autopilot status timed out"), { code: "AUTOPILOT_STATUS_TIMEOUT" })), 1000);
  try {
    const response = await beforeStopDeadline(() => request("autopilot.status", { sessionKey: identity.sessionKey },
      { timeoutMs: 1000, signal: controller.signal }), { deadlineAt: Date.now() + 1000, signal: controller.signal });
    const projection = (response?.result ?? response)?.projection;
    if (projection?.status === "running")
      return result("RUNNING", "AUTOPILOT_RUNNING", "autopilot 正在运行；RC Stop 排队等待其结束。", projection.status);
    if (["idle", "paused", "done"].includes(projection?.status))
      return result("IDLE", "AUTOPILOT_NOT_RUNNING", `autopilot 当前状态：${projection.status}；RC 继续审查。`, projection.status);
    return result("UNKNOWN", "AUTOPILOT_STATUS_UNVERIFIED", "autopilot 未提供可核实的状态；仅提示可能互斥，不推断其已结束。");
  } catch {
    return result("UNKNOWN", "AUTOPILOT_STATUS_UNAVAILABLE", "无法核实 autopilot 状态；仅提示可能互斥，不推断其已结束。");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** agent.wait's gateway terminal covers reply draining, unlike agent_end. */
export async function waitPostRunTerminal(api, identity, runId, deadlineAt, signal, request = createPostRunHostRequester(api)) {
  if (!runId) throw new Error("HOST_TERMINAL_READER_UNAVAILABLE");
  while (Date.now() < deadlineAt && !signal?.aborted) {
    const remaining = deadlineAt - Date.now();
    const response = await beforeStopDeadline(() => request("agent.wait", {
      runId, timeoutMs: Math.min(1000, remaining),
    }, { timeoutMs: Math.min(2000, remaining), signal }), { deadlineAt, signal });
    const terminal = response?.result ?? response;
    if (terminal?.runId !== runId) throw new Error("HOST_TERMINAL_IDENTITY_MISMATCH");
    if (["ok", "error"].includes(terminal.status)) return terminal;
    if (terminal.status !== "timeout") throw new Error("HOST_TERMINAL_UNKNOWN");
    // Some hosts answer an unknown run immediately. Avoid a busy polling loop.
    await beforeStopDeadline(() => new Promise(resolve => setTimeout(resolve, 100)), { deadlineAt, signal });
  }
  return null;
}
