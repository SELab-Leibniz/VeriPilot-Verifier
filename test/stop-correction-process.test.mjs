import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";

const execute = promisify(execFile);
const moduleUrl = new URL("../lib/runtime-v2/stop-correction-store.mjs", import.meta.url).href;

test("separate host processes/project scopes share one durable session quota and recover confirmed usage", async t => {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "stop-process-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storeDirectory = path.join(directory, "host-session-store");
  const projectRoots = [path.join(directory, "project-a"), path.join(directory, "project-b")];
  for (const root of projectRoots) await fs.mkdir(root);
  const script = `
    import { createStopCorrectionStore } from ${JSON.stringify(moduleUrl)};
    const [directory, flowId] = process.argv.slice(1);
    const store = createStopCorrectionStore({ directory });
    const entry = await store.beginStop({ sessionId: "host-session", flowId, stopId: flowId,
      sourceInput: { origin: "HUMAN", id: flowId },
      config: { enabled: true, maxCorrectionsPerSession: 1 },
      initialize: { kind: "NEW_SESSION", evidence: "host session creation record" } });
    if (entry.stop.control !== "ALLOW") {
      await store.settleReview({ sessionId: "host-session", stopId: flowId, status: "DEVIATION",
        currentDeviations: [{ objectId: "M16:R1", basisKey: "current" }] });
      const admission = await store.reserveFeedback({ sessionId: "host-session", stopId: flowId,
        packageId: flowId, basisCurrent: async () => true });
      if (admission) await store.observeStart({ sessionId: "host-session", admissionId: admission.id,
        executionId: flowId, startedAt: Date.now(), observationId: flowId });
    }
    process.stdout.write(JSON.stringify(await store.inspect("host-session")));
  `;
  const outputs = await Promise.all(projectRoots.map((cwd, index) => execute(process.execPath,
    ["--input-type=module", "-e", script, storeDirectory, `flow-${index}`], { cwd, timeout: 15000 })));
  assert.ok(outputs.every(result => JSON.parse(result.stdout).used <= 1));
  const recovered = await createStopCorrectionStore({ directory: storeDirectory }).inspect("host-session");
  assert.equal(recovered.used, 1);
  assert.equal(Object.values(recovered.admissions).filter(value => value.accounting === "USED").length, 1);
  assert.equal(Object.values(recovered.flows).reduce((sum, flow) => sum + flow.used, 0), 1);
});
