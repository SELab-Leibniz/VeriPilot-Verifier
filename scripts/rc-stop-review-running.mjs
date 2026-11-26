#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readSessionRuntimeStatus } from "../lib/openclaw/session-runtime-client.mjs";
import { sessionRuntimeRoundId } from "../lib/openclaw/session-runtime-status.mjs";

const settledPhases = new Set(["IDLE", "ENDED", "CLOSED"]);
const endedStatuses = new Set(["ENDED", "TERMINATED", "INTERRUPTED"]);

function isStopReviewRunning(snapshot) {
  const { health, status, phase, runId, roundId, active, ended } = snapshot;
  if (!snapshot.registered) throw new Error("No runtime status is registered for the exact host session.");
  if (health !== "FRESH" && health !== "SETTLED") throw new Error(`Session runtime status is ${health}.`);
  if (runId !== null && (typeof runId !== "string" || !runId)
      || roundId !== sessionRuntimeRoundId(snapshot, runId, snapshot.controlRevision ?? 0)) {
    throw new Error("Runtime status does not identify a valid current round.");
  }

  if (health === "SETTLED" && active === false && settledPhases.has(phase)) {
    if (status === "IDLE" && runId === null && ended === null) return false;
    if (endedStatuses.has(status) && runId !== null && ended === true) return false;
  }
  if (health === "FRESH" && active === true && ended === false && runId !== null) {
    if (snapshot.stopReviewActive === true) return true;
    if ((phase === "RUNNING" || phase === "USER_DISPATCHING") && snapshot.hostReconciliation !== "UNKNOWN") return false;
  }
  throw new Error("Runtime status cannot confirm whether the current round has an active Stop review.");
}

try {
  const { values } = parseArgs({ options: {
    "project-root": { type: "string" }, "session-key": { type: "string" }, "session-id": { type: "string" },
  } });
  const snapshot = await readSessionRuntimeStatus({
    projectRoot: values["project-root"], sessionKey: values["session-key"], sessionId: values["session-id"],
  });
  console.log(JSON.stringify({ running: isStopReviewRunning(snapshot) }));
} catch (error) {
  const message = error instanceof SyntaxError ? "Invalid session runtime status JSON." : error.message;
  console.error(`rc-stop-review-running: ${String(message).replace(/\s+/gu, " ").slice(0, 600)}`);
  process.exitCode = 1;
}
