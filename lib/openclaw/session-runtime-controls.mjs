import { authenticatedActor } from "./interaction-store.mjs";
import { sessionRuntimeIdentity } from "./session-runtime-status.mjs";
import { isInternalExecution, isManagedExecution } from "./internal-context.mjs";

export function registerSessionRuntimeControls(api, runtime) {
  if (typeof api.registerGatewayMethod !== "function" || !runtime.sessionRuntime) return;
  for (const action of ["get", "refresh", "terminate"]) {
    const write = action !== "get";
    api.registerGatewayMethod(`runtime-corrector.runtime.${action}`, async ({ params, client, respond }) => {
      try {
        const actor = authenticatedActor(client, write);
        if (isInternalExecution() || isManagedExecution()) throw Object.assign(new Error("Private RC executions cannot control business rounds."), { code: "FORBIDDEN" });
        const allowed = ["projectRoot", "agentId", "sessionKey", "sessionId", ...(action === "terminate" ? ["roundId"] : [])];
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key)))
          throw Object.assign(new Error("Invalid runtime control parameters."), { code: "INVALID_REQUEST" });
        const identity = sessionRuntimeIdentity(params);
        await runtime.postRunReady;
        const value = await runtime.sessionRuntime[action]({ ...identity, actor, ...(action === "terminate" ? { roundId: params.roundId } : {}) });
        respond(true, value);
      } catch (error) {
        respond(false, undefined, { code: ["CONFLICT", "FORBIDDEN"].includes(error.code) ? error.code : "INVALID_REQUEST",
          message: String(error.message).slice(0, 600) });
      }
    }, { scope: write ? "operator.write" : "operator.read" });
  }
}
