import { authenticatedActor } from "./interaction-store.mjs";
import { sessionRuntimeIdentity } from "./session-runtime-status.mjs";
import { isInternalExecution, isManagedExecution } from "./internal-context.mjs";
import { readSessionRuntimeDetails } from "./session-runtime-details.mjs";
import { sessionRuntimeText } from "./session-runtime-text.mjs";

export function registerSessionRuntimeControls(api, runtime) {
  if (typeof api.registerGatewayMethod !== "function" || !runtime.sessionRuntime) return;
  for (const action of ["get", "details", "refresh", "terminate"]) {
    const write = action === "refresh" || action === "terminate";
    api.registerGatewayMethod(`runtime-corrector.runtime.${action}`, async ({ params, client, respond }) => {
      try {
        const actor = authenticatedActor(client, write);
        if (isInternalExecution() || isManagedExecution()) throw Object.assign(new Error("Private RC executions cannot control business rounds."), { code: "FORBIDDEN" });
        const allowed = ["projectRoot", "agentId", "sessionKey", "sessionId", ...(["terminate", "details"].includes(action) ? ["roundId"] : [])];
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key)))
          throw Object.assign(new Error("Invalid runtime control parameters."), { code: "INVALID_REQUEST" });
        const identity = sessionRuntimeIdentity(params);
        await runtime.postRunReady;
        if (action === "details") {
          const snapshot = await runtime.sessionRuntime.get(identity);
          if (!Object.hasOwn(params, "roundId") || snapshot.roundId !== params.roundId)
            throw Object.assign(new Error("The correction round changed; refresh the view."), { code: "CONFLICT" });
          respond(true, await readSessionRuntimeDetails(snapshot, runtime.readSessionFollowup));
          return;
        }
        const value = await runtime.sessionRuntime[action]({ ...identity, actor, ...(action === "terminate" ? { roundId: params.roundId } : {}) });
        if (action === "get") {
          const snapshot = { ...value, ...(runtime.sessionInputMode ? { inputMode: runtime.sessionInputMode(identity) } : {}) };
          respond(true, { ...snapshot, display: sessionRuntimeText(snapshot) });
        } else respond(true, value);
      } catch (error) {
        respond(false, undefined, { code: ["CONFLICT", "FORBIDDEN"].includes(error.code) ? error.code : "INVALID_REQUEST",
          message: String(error.message).slice(0, 600) });
      }
    }, { scope: write ? "operator.write" : "operator.read" });
  }
}
