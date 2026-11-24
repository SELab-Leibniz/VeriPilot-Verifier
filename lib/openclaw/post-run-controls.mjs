import { promises as fs } from "node:fs";
import { authenticatedActor } from "./interaction-store.mjs";
import { loadInteractionCompatibility } from "./compat-2026.7.1-2.mjs";
import { findTask } from '../runtime-v2/task-store.mjs';
import { readConsoleObservations } from './console-observations.mjs';

const view = r => ({ id: r.id, agentId: r.agentId, sessionKey: r.sessionKey, sessionId: r.sessionId,
  projectRoot: r.projectRoot, scopeFingerprint: r.scopeFingerprint, label: r.label, phase: r.phase,
  reviewStatus: r.reviewStatus, reason: r.reason, version: r.version, updatedAt: r.updatedAt,
  runId: r.runId, reconciliation: r.reconciliation, recoveryAudit: r.recoveryAudit ?? [], coexistence: r.coexistence,
  deadlineAt: r.deadlineAt, pending: r.pending, history: r.history ?? [], reviewSummary: r.reviewSummary, dispatching: r.dispatching
    ? { id: r.dispatching.id, status: r.dispatching.status, text: r.dispatching.text } : null });

export function registerPostRunControls(api, runtime, { compatibility = loadInteractionCompatibility } = {}) {
  if (typeof api.registerGatewayMethod !== "function" || typeof api.registerHttpRoute !== "function") {
    api.logger.warn("[runtime-corrector] RC control page APIs unavailable."); return;
  }
  for (const action of ["list", "get", "observations", "recheck", "cancel", "release"]) {
    const write = ["recheck", "cancel", "release"].includes(action);
    api.registerGatewayMethod(`runtime-corrector.dispatch.${action}`, async ({ params = {}, client, respond }) => {
      try {
        const actor = authenticatedActor(client, write);
        await runtime.postRunReady;
        const manager = runtime.postRuns;
        if (action === "list") {
          const offset = params.offset ?? 0, limit = params.limit ?? 100;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new Error("Invalid session page.");
          if (typeof (params.search ?? "") !== "string" || (params.search?.length ?? 0) > 1000 || !["all", "pending", "active"].includes(params.filter ?? "all")) throw new Error("Invalid session filter.");
          respond(true, manager.list({ offset, limit, search: params.search, filter: params.filter })); return;
        }
        const record = typeof params.id === "string" && manager.byId(params.id);
        if (!record || ["agentId", "sessionKey", "sessionId", "scopeFingerprint"].some(key => params[key] !== record[key]))
          throw Object.assign(new Error("Session identity changed; choose it again."), { code: "CONFLICT" });
        if (action === "get" || action === "observations") {
          const task = await findTask({ projectRoot: record.projectRoot, sessionId: record.sessionId, explicitTaskId: record.scopeTaskId });
          if (action === 'observations') {
            respond(true, await readConsoleObservations(record, task, params.query)); return;
          }
          respond(true, { ...view(record), ...(task ? { requirements: { version: task.groundTruth.version,
            pending: Boolean(task.groundTruth.pendingUserCursor), pendingUserCursor: task.groundTruth.pendingUserCursor ?? null } } : {}) }); return;
        }
        if (!await runtime.validatePostSession(record)) throw Object.assign(new Error("Session or project is no longer current."), { code: "CONFLICT" });
        const options = { actor, runId: params.runId, version: params.version, confirmationToken: params.confirmationToken };
        const result = action === "recheck" ? await manager.recheck(record, options)
          : action === "cancel" ? await manager.confirmCancel(record, options)
          : params.confirmationToken === undefined ? await manager.prepareRelease(record, options) : await manager.safeRelease(record, options);
        respond(true, result.confirmationToken ? result : view(result));
      } catch (error) {
        respond(false, undefined, { code: ["CONFLICT", "FORBIDDEN"].includes(error.code) ? error.code : "INVALID_REQUEST",
          message: String(error.message).slice(0, 600) });
      }
    }, { scope: write ? "operator.write" : "operator.read" });
  }
  api.registerHttpRoute({ path: "/plugins/runtime-corrector", match: "prefix", auth: "plugin", async handler(req, res) {
    const pathname = new URL(req.url, "http://localhost").pathname, prefix = "/plugins/runtime-corrector";
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) { res.statusCode = 404; res.end(); return true; }
    const suffix = pathname.slice(prefix.length);
    const files = { "": "post-run.html", "/": "post-run.html", "/post-run.mjs": "post-run.mjs", "/post-run.css": "post-run.css",
      '/observations.mjs': 'observations.mjs', "/status-copy.mjs": "status-copy.mjs" };
    if (req.method !== "GET") { res.statusCode = 405; res.end(); return true; }
    if (!Object.hasOwn(files, suffix) && suffix !== "/capabilities.json") { res.statusCode = 404; res.end(); return true; }
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'");
    if (suffix === "/capabilities.json") {
      try {
        const sdk = await compatibility();
        const base = (api.config?.gateway?.controlUi?.basePath ?? "").replace(/\/$/u, "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ browserClient: `${base}/assets/${sdk.browserClient}`, version: sdk.version }));
      } catch (error) { res.statusCode = 503; res.end(JSON.stringify({ error: "当前宿主的浏览器认证接口尚未验证。" })); }
    } else {
      const name = files[suffix];
      res.setHeader("Content-Type", name.endsWith("mjs") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html; charset=utf-8");
      res.end(await fs.readFile(new URL(`./ui/${name}`, import.meta.url)));
    }
    return true;
  } });
}
