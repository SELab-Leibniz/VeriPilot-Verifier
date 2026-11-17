import { parseArgs } from "node:util";
import { readSessionRuntimeStatus, refreshSessionRuntimeStatus, terminateSessionCorrection } from "./session-runtime-client.mjs";

export async function runSessionRuntimeCli(action, args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args, options: {
      "project-root": { type: "string" }, "session-key": { type: "string" }, "session-id": { type: "string" },
      "agent-id": { type: "string" }, "round-id": { type: "string" }, "openclaw-root": { type: "string" },
      config: { type: "string" }, "state-dir": { type: "string" },
      "timeout-ms": { type: "string" }, help: { type: "boolean" },
    } });
    if (values.help) {
      console.log(`node rc-${action === "get" ? "status" : action}.mjs --project-root <absolute-path> --session-key <key> --session-id <id>\n`
        + "Optional: --agent-id <id> --round-id <queried-round> --openclaw-root <installed-package> --config <host-config> --state-dir <host-state> --timeout-ms <milliseconds>");
      return;
    }
    const timeoutMs = Number(values["timeout-ms"] ?? 30000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error("timeout-ms must be 100..60000.");
    const input = { projectRoot: values["project-root"], sessionKey: values["session-key"], sessionId: values["session-id"],
      ...(values["agent-id"] ? { agentId: values["agent-id"] } : {}), ...(values["round-id"] ? { roundId: values["round-id"] } : {}) };
    const options = { openclawRoot: values["openclaw-root"], configPath: values.config, stateDir: values["state-dir"], timeoutMs };
    const result = action === "get" ? await readSessionRuntimeStatus(input) : action === "refresh"
      ? await refreshSessionRuntimeStatus(input, options) : await terminateSessionCorrection(input, options);
    console.log(JSON.stringify({ ok: true, result }));
    if (result.status === "UNKNOWN" || result.refreshConfirmed === false || result.target?.ended === false) process.exitCode = 2;
  } catch (error) {
    // Do not print execFile's command, environment, or unfiltered host stderr.
    console.log(JSON.stringify({ ok: false, error: { code: error.code ?? "RC_CONTROL_FAILED",
      message: error.cmd ? "The host control call failed; query/refresh before retrying a termination." : String(error.message).slice(0, 600) } }));
    process.exitCode = 1;
  }
}
