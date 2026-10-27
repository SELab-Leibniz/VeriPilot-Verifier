import { beforeStopDeadline } from "../runtime-v2/stop-deadline.mjs";
import { loadInteractionCompatibility } from "./compat-2026.7.1-2.mjs";

/** Third-party plugins use the public authenticated client when trusted-plugin
 * dispatch is unavailable. Never retry a request that may have reached the host. */
export function createPostRunHostRequester(api, { compatibility = loadInteractionCompatibility } = {}) {
  let nativeAllowed = typeof api.runtime.gateway?.request === "function", sdk;
  return async (method, params, options = {}) => {
    if (!["agent.wait", "chat.send"].includes(method)) throw new Error("Unsupported post-run host method.");
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
      { progress: false, scopes: ["operator.read", "operator.write"], signal: options.signal });
  };
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
