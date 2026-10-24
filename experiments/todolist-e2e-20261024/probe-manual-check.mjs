// Controlled mechanism probe only: no model, Gateway or business application.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createOpenClawRuntime } from "../../lib/openclaw/runtime.mjs";
import { createNativeStopChains } from "../../lib/openclaw/native-stop-chain.mjs";

const scratch = path.resolve(".runtime-correction/manual-check-identity-probe");
await fs.mkdir(scratch, { recursive: true });
const root = await fs.mkdtemp(path.join(scratch, "run-"));
await fs.writeFile(path.join(root, "subject.py"), "# Controlled read-only check subject.\n");
const controller = new AbortController();
const scope = { enabled: true, projectRoot: root, fingerprint: "probe-scope" };
const state = { key: "main:probe-session", agentId: "main", sessionId: "probe-session",
  sessionKey: "agent:main:probe", nativeRunId: "owned-correction", projectRoot: root,
  executionDirectory: root, projectScope: scope, reviewController: controller, abortSignal: controller.signal };
const sharedState = { states: new Map([[state.key, state]]), stopWaitChains: new Map(), stopWaitRunOwners: new Map() };
const chains = createNativeStopChains(sharedState.stopWaitChains, sharedState.stopWaitRunOwners);
const chain = chains.begin({ state, runId: "original-run", taskId: "probe-task", budgetMs: 10000 });
chain.link("original-run", { runId: "owned-correction", taskId: "probe-task" });
chain.enter("owned-correction");
let scopeResolutions = 0;
const runtime = createOpenClawRuntime({ id: "runtime-corrector", config: {}, logger: { warn() {} },
  pluginConfig: { hookTimeoutMs: 10000 }, runtime: { version: "probe" } }, {
  pluginRoot: process.cwd(), nativeHooks: true, sharedState,
  projectScopes: { resolve: async () => { scopeResolutions++; return scope; } },
});
const context = { agentId: state.agentId, sessionId: state.sessionId, sessionKey: state.sessionKey,
  workspaceDir: root, abortSignal: controller.signal };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedAt = Date.now();
const manual = runtime.manualCheck(context, "subject.py").then(() => "RETURNED", error => error.code ?? error.message);
const withoutRunId = await Promise.race([manual, pause(200).then(() => "WAITING_ON_STOP_CHAIN")]);
assert.equal(withoutRunId, "WAITING_ON_STOP_CHAIN");
assert(scopeResolutions >= 2, "The call must have reached the Stop gate, not merely be waiting on initial filesystem preparation.");
const recognizedChild = await Promise.race([
  runtime.beforeDispatch({}, { ...context, runId: "owned-correction" }).then(() => "ADMITTED_IMMEDIATELY"),
  pause(200).then(() => "STILL_WAITING"),
]);
assert.equal(recognizedChild, "ADMITTED_IMMEDIATELY");
controller.abort(Object.assign(new Error("Controlled probe cleanup."), { code: "PROBE_CLEANUP" }));
chain.cancel("PROBE_CLEANUP");
await manual;
const result = { status: "REPRODUCED_MISSING_RUN_ID_SELF_WAIT", elapsedMs: Date.now() - startedAt,
  withoutRunId, withOwnedRunId: recognizedChild, scopeResolutions, modelCalls: 0, liveBusinessRuns: 0,
  caveat: "Controlled production-code mechanism probe. The live factory context was not instrumented; its declared schema and the stalled-call trajectory support applying this mechanism to the observed incident.",
  fixture: root };
if (process.argv[2]) {
  const destination = path.resolve(process.argv[2]);
  assert.equal(path.dirname(destination), path.join(process.cwd(), "experiments"));
  assert(/^live-todolist-/u.test(path.basename(destination)));
  await fs.writeFile(path.join(destination, "manual-check-identity-probe.json"), JSON.stringify(result, null, 2) + "\n");
}
console.log(JSON.stringify(result, null, 2));
