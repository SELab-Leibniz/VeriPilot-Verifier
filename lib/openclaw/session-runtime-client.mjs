import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSessionRuntimeStatus, reconcileStoredSessionRuntimeStatus, sessionRuntimeIdentity } from "./session-runtime-status.mjs";

const execute = promisify(execFile);
export { readSessionRuntimeStatus, sessionRuntimeStatusPath } from "./session-runtime-status.mjs";

async function gatewayCall(action, input, { request, openclawRoot, configPath, stateDir, timeoutMs = 30000, executeHost = execute } = {}) {
  const identity = sessionRuntimeIdentity(input), method = `runtime-corrector.runtime.${action}`;
  const params = { ...identity, ...(action === "terminate" ? { roundId: input.roundId } : {}) };
  if (request) return request(method, params, { timeoutMs });
  let packageFile;
  if (openclawRoot ?? process.env.RC_OPENCLAW_HOST_ROOT) packageFile = path.join(openclawRoot ?? process.env.RC_OPENCLAW_HOST_ROOT, "package.json");
  else {
    try { packageFile = createRequire(import.meta.url).resolve("openclaw/package.json"); }
    catch { throw Object.assign(new Error("Set --openclaw-root to the installed OpenClaw package directory."), { code: "RC_GATEWAY_LOCATION_REQUIRED" }); }
  }
  packageFile = await fs.realpath(packageFile);
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (pkg.name !== "openclaw" || !["2026.7.1-2", "2026.10.3"].includes(pkg.version))
    throw Object.assign(new Error("The control client requires a supported OpenClaw installation."), { code: "RC_GATEWAY_VERSION_UNSUPPORTED" });
  const env = { ...process.env, OPENCLAW_NO_RESPAWN: "1", ELECTRON_RUN_AS_NODE: "1" };
  // Executable/configuration locations come from trusted caller options or
  // process environment, never from a writable project status document.
  if (configPath) env.OPENCLAW_CONFIG_PATH = path.resolve(configPath);
  if (stateDir) env.OPENCLAW_STATE_DIR = path.resolve(stateDir);
  let stdout;
  try {
    ({ stdout } = await executeHost(process.execPath, [path.join(path.dirname(packageFile), "openclaw.mjs"),
      "gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeoutMs)],
    { env, windowsHide: true, timeout: timeoutMs + 2000, maxBuffer: 1024 * 1024 }));
  } catch { throw Object.assign(new Error("Host control call failed; refresh status before retrying termination."), { code: "RC_GATEWAY_CALL_FAILED" }); }
  try { return JSON.parse(stdout); }
  catch { throw Object.assign(new Error("The host returned invalid control JSON."), { code: "RC_GATEWAY_RESPONSE_INVALID" }); }
}

export async function refreshSessionRuntimeStatus(input, options = {}) {
  const snapshot = await readSessionRuntimeStatus(input);
  if (snapshot.health === "OWNER_EXITED") {
    const checked = await reconcileStoredSessionRuntimeStatus(input);
    if (checked.status === "INTERRUPTED") return checked;
  }
  try { return await gatewayCall("refresh", input, options); }
  catch (error) {
    const checked = await reconcileStoredSessionRuntimeStatus(input);
    if (checked.status === "INTERRUPTED") return checked;
    // A reachable PID does not prove that the plugin or its workers are alive.
    return { ...checked, refreshConfirmed: false, refreshError: error.code ?? "RC_LIVE_REFRESH_UNAVAILABLE",
      ...(checked.active || checked.health === "STALE" ? { status: "UNKNOWN", active: null, running: null, ended: null, canTerminate: false } : {}) };
  }
}

export async function terminateSessionCorrection(input, options = {}) {
  const snapshot = await readSessionRuntimeStatus(input);
  const roundId = input.roundId ?? snapshot.roundId;
  if (!roundId) throw Object.assign(new Error("Query or refresh the target Session before terminating its current round."), { code: "RC_ROUND_NOT_REGISTERED" });
  // Never retry a mutating call or retarget it after a lost acknowledgement.
  return gatewayCall("terminate", { ...input, roundId }, options);
}
