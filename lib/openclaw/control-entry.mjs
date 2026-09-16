import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createControlService, CONTROL_ACTIONS } from "./control-service.mjs";
import { loadInteractionCompatibility } from "./compat-2026.7.1-2.mjs";
import { registerNativeQueries } from "./native-query.mjs";

export function registerInteractionControls(api, runtime, sharedState, { compatibility = loadInteractionCompatibility } = {}) {
  for (const method of ["registerGatewayMethod", "registerCli", "registerHttpRoute"]) if (typeof api[method] !== "function") throw new Error(`OpenClaw interaction capability missing: ${method}`);
  let contract;
  const service = createControlService(api, runtime, sharedState, { currentSession: async (...args) => {
    contract ??= compatibility();
    const sdk = await contract;
    return sdk.currentSession(...args);
  } });
  for (const name of ["status", "feedback", "control", "receipt"]) {
    api.registerGatewayMethod(`runtime-corrector.${name}`, async ({ params, client, respond }) => {
      try { respond(true, await service.handle(name, params, client)); }
      catch (error) { respond(false, undefined, { code: error.code === "FORBIDDEN" ? "INVALID_REQUEST" : error.code ?? "UNAVAILABLE",
        message: String(error.message).slice(0, 600) }); }
    }, { scope: name === "control" ? "operator.write" : "operator.read" });
  }
  registerInteractionCli(api, { compatibility });
  registerNativeQueries(api, service);
  const route = "/plugins/runtime-corrector";
  api.registerHttpRoute({ path: route, match: "prefix", auth: "plugin", async handler(req, res) {
    // This public static shell contains no task data. Every read and mutation
    // goes through the host's authenticated/scoped WebSocket connection.
    const url = new URL(req.url, "http://localhost");
    const suffix = url.pathname.slice(route.length);
    if (!["", "/", "/app.mjs", "/style.css", "/capabilities.json"].includes(suffix)) { res.statusCode = 404; res.end(); return true; }
    if (req.method !== "GET") { res.statusCode = 405; res.end(); return true; }
    const sdk = await compatibility();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; frame-ancestors 'self'");
    if (suffix === "/capabilities.json") {
      res.setHeader("Content-Type", "application/json");
      const base = (api.config?.gateway?.controlUi?.basePath ?? "").replace(/\/$/u, "");
      res.end(JSON.stringify({ browserClient: `${base}/assets/${sdk.browserClient}`, version: sdk.version,
        nativeChatInstantQuery: false, nativeReplyRecorder: false, nativeHistoryReceipt: false }));
    } else {
      const file = suffix === "/app.mjs" ? "app.mjs" : suffix === "/style.css" ? "style.css" : "index.html";
      res.setHeader("Content-Type", file.endsWith("mjs") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html; charset=utf-8");
      res.end(await fs.readFile(new URL(`./ui/${file}`, import.meta.url)));
    }
    return true;
  } });
  return service;
}

export function registerInteractionCli(api, { compatibility = loadInteractionCompatibility } = {}) {
  api.registerCli(async ({ program }) => {
    const sdk = await compatibility();
    const group = program.command("runtime-corrector").description("纠偏状态、反馈与独立控制（OpenClaw 2026.7.1-2）");
    for (const action of ["status", "feedback", ...CONTROL_ACTIONS, "receipt"]) {
      const command = sdk.addGatewayClientOptions(group.command(action).requiredOption("--session <key>", "Native session key")
        .option("--command-id <id>", "Stable command ID; reuse after response loss")
        .option("--action-id <id>", "Stable sub-action ID", "main").option("--text <text>", "New requirements")
        .option("--delivery-id <id>", "Reconcile a final message delivery receipt")
        .option("--json", "Output JSON"));
      command.action(async (options) => {
        const mutation = CONTROL_ACTIONS.includes(action);
        const method = mutation ? "control" : action;
        const commandId = options.commandId ?? (mutation ? randomUUID() : undefined);
        if (action === "receipt" && !commandId && !options.deliveryId) throw new Error("--command-id or --delivery-id is required for receipt lookup.");
        if (mutation) {
          // Persist before transmission without storing keys or task contents.
          // An interrupted CLI can recover the command ID from this file.
          const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME, ".openclaw");
          const file = path.join(stateDir, "runtime-corrector", "cli-commands", `${commandId}.json`);
          if (!/^[\w:.-]{1,160}$/u.test(commandId)) throw new Error("Invalid command ID.");
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(file, JSON.stringify({ commandId, actionId: options.actionId, sessionKey: options.session, action }) + "\n", { mode: 0o600 });
          process.stderr.write(`commandId=${commandId} actionId=${options.actionId}\n`);
        }
        const params = { sessionKey: options.session, ...(commandId ? { commandId, actionId: options.actionId } : {}),
          ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
          ...(mutation ? { action, ...(options.text ? { text: options.text } : {}) } : {}) };
        const result = await sdk.callGatewayFromCli(`runtime-corrector.${method}`, options, params);
        process.stdout.write((options.json ? JSON.stringify(result, null, 2) : result.text ?? JSON.stringify(result, null, 2)) + "\n");
      });
    }
  }, { commands: ["runtime-corrector"] });
}
