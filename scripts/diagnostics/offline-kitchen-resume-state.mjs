// State restoration is independent of whether the prior assessment passed.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isolatedHost, runtimeState } from "./lib/isolated-openclaw.mjs";

const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
const root = await fs.realpath(destination), manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const initial = await runtimeState(manifest.project);
await fs.copyFile(path.join(root, "process.json"), path.join(root, "process-experiment-terminal.json"));
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), resume: true,
  workspaceSkillSources: [fileURLToPath(new URL("../../examples/openclaw-offline-kitchen/skills/build-offline-kitchen", import.meta.url))],
  platformAdapters: { "offline-kitchen-python-test": { name: "offline-kitchen-python-test",
    kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] }, sourceManifest: { roots: [], files: ["kitchen.py"], extensions: [".py"] } } },
});
const result = { experiment: "terminal-kitchen-state-real-restart", status: "RUNNING", priorTaskState: initial.tasks[0].status };
try {
  const scopeBefore = await h.status(manifest.key);
  await h.save("resume-first-generation-process.json", JSON.parse(await fs.readFile(path.join(root, "process.json"), "utf8")));
  const starts = () => h.events.filter(e => e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start").length;
  assert.equal(starts(), 0); await h.restart(); const scopeAfter = await h.status(manifest.key);
  const after = await runtimeState(manifest.project);
  assert.deepEqual(scopeBefore.identity, scopeAfter.identity); assert.equal(scopeAfter.projectRoot, manifest.project);
  assert.equal(after.tasks.length, initial.tasks.length);
  for (let i = 0; i < initial.tasks.length; i++) for (const field of ["taskId", "status", "groundTruth", "stop", "correctionEpoch", "watchers", "verification"]) {
    assert.deepEqual(after.tasks[i][field], initial.tasks[i][field], field);
  }
  assert.equal(starts(), 0);
  Object.assign(result, { status: "PASS", scopeBefore, scopeAfter, taskId: after.tasks[0].taskId,
    taskStatus: after.tasks[0].status, verification: after.tasks[0].verification?.status,
    correctionAttempts: after.tasks[0].stop.correctionAttempts, queriesStartedNoModels: true });
} catch (error) { result.status = "FAIL"; result.error = h.redact(error.stack); }
finally { await h.save("restart-after-failure.json", result); await h.close(); }
process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.status === "PASS" ? 0 : 1;
