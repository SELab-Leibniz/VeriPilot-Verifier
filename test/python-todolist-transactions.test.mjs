import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runTodoScenario } from "../scripts/validate-python-todolist.mjs";

const pythonAvailable = spawnSync(process.env.PYTHON ?? "python3", ["--version"], { encoding: "utf8" }).status === 0;

test("real Python Todo CLI with compiled plugin hooks survives duplicate requests and process termination", { skip: !pythonAvailable || process.platform === "win32", timeout: 120000 }, async () => {
  const result = await runTodoScenario();
  assert.equal(result.pythonTests, 9);
  assert.equal(result.defectDetected, true);
  assert.equal(result.verification, "PASS");
  assert.equal(result.appOperations, 74);
  assert.equal(result.rejectedToolOperations, 2);
  assert.equal(result.crashes.length, 5);
  assert(result.crashes.every(crash => crash.signal === "SIGKILL"));
  assert.equal(result.crashes.filter(crash => crash.outputReferences > 0).length, 3);
  assert.equal(result.tornUnpublishedTailRecovered, true);
  assert.equal(result.duplicateEventIds, 0);
  assert(result.checkpointCount <= 2);
  assert.deepEqual(result.warnings, []);
});
