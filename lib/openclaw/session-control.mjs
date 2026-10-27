import { authenticatedActor } from "./interaction-store.mjs";
import { isInternalExecution, isManagedExecution } from "./internal-context.mjs";

function authorize(ctx, write) {
  const scopes = ctx.gatewayClientScopes;
  if (isInternalExecution() || isManagedExecution() || ctx.isAuthorizedSender !== true
    || !(scopes ? scopes.includes("operator.admin") || scopes.includes(write ? "operator.write" : "operator.read")
      : ctx.senderIsOwner === true)) {
    throw new Error("需要可信用户身份及宿主读取/写入权限。");
  }
}

function gatewayContext(params, client, write) {
  authenticatedActor(client, write);
  const allowed = write ? ["agentId", "sessionKey", "sessionId", "enabled"] : ["agentId", "sessionKey", "sessionId"];
  if (!params || typeof params !== "object" || Array.isArray(params)
    || Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Invalid Session control parameters.");
  const agentId = /^agent:([a-zA-Z0-9_-]+):/u.exec(params.sessionKey ?? "")?.[1];
  if (!agentId || params.agentId !== undefined && params.agentId !== agentId
    || /:rc-worker:|:runtime-corrector:/u.test(params.sessionKey)) throw new Error("Invalid Session target.");
  return { agentId, sessionKey: params.sessionKey, sessionId: params.sessionId,
    isAuthorizedSender: true, gatewayClientScopes: client.connect.scopes };
}

export function createSessionControl(runtime) {
  const reconcile = ctx => runtime.reconcileSessionControl(ctx);
  const status = scope => ({
    projectRoot: scope.projectRoot, source: scope.source, identity: scope.identity ?? null,
    projectEnabled: scope.projectEnabled ?? null, requestedEnabled: scope.sessionEnabled ?? null,
    sessionDefaultEnabled: scope.sessionDefaultEnabled ?? null,
    effectiveEnabled: scope.enabled === true, reason: scope.reason ?? null,
    registered: scope.sessionSettings?.registered === true,
    recordKey: scope.sessionSettings?.key ?? null, settingsFile: scope.sessionSettings?.path ?? null,
  });
  return {
    async get(ctx) {
      authorize(ctx, false);
      return status(await reconcile(ctx));
    },
    async set(ctx, enabled) {
      authorize(ctx, true);
      try {
        await runtime.projects.setEnabled(ctx, enabled);
      } catch (error) {
        // A broken control file may already require stopping this process.
        // Do not describe a failed write as a persisted preference.
        await reconcile(ctx).catch(() => {});
        throw error;
      }
      return status(await reconcile(ctx));
    },
    async setDefault(ctx, enabled) {
      authorize(ctx, true);
      try { await runtime.projects.setSessionDefaultEnabled(ctx, enabled); }
      catch (error) { await reconcile(ctx).catch(() => {}); throw error; }
      return status(await reconcile(ctx));
    },
  };
}

export function registerSessionControl(api, runtime) {
  const control = createSessionControl(runtime);
  api.registerCommand({ name: "rc-session", description: "开关当前 Session 的 RC 纠偏或查看状态", acceptsArgs: true,
    requireAuth: true, requiredScopes: ["operator.read"], async handler(ctx) {
      const action = ctx.args?.trim() || "status";
      try {
        if (!["status", "on", "off"].includes(action)) throw new Error("用法：/rc-session status | on | off");
        const value = action === "status" ? await control.get(ctx) : await control.set(ctx, action === "on");
        return { text: JSON.stringify(value, null, 2) };
      } catch (error) { return { text: error.message }; }
    } });
  api.registerCommand({ name: "rc-session-default", description: "开关当前项目首次登记 Session 的 RC 默认选择", acceptsArgs: true,
    requireAuth: true, requiredScopes: ["operator.read"], async handler(ctx) {
      const action = ctx.args?.trim() || "status";
      try {
        if (!["status", "on", "off"].includes(action)) throw new Error("用法：/rc-session-default status | on | off");
        const value = action === "status" ? await control.get(ctx) : await control.setDefault(ctx, action === "on");
        return { text: JSON.stringify(value, null, 2) };
      } catch (error) { return { text: error.message }; }
    } });
  if (typeof api.registerGatewayMethod === "function") {
    for (const [action, write] of [["get", false], ["set", true]]) {
      api.registerGatewayMethod(`runtime-corrector.session.${action}`, async ({ params, client, respond }) => {
        try {
          const ctx = gatewayContext(params, client, write);
          const value = write ? await control.set(ctx, params.enabled) : await control.get(ctx);
          respond(true, value);
        } catch (error) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: String(error.message).slice(0, 600) });
        }
      }, { scope: write ? "operator.write" : "operator.read" });
    }
  }
  return control;
}
