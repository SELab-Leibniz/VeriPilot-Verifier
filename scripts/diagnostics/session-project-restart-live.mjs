// Reopen ONLY a previously isolated probe root; never a user's live profile.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { isolatedHost, runtimeState, json, pause } from "./lib/isolated-openclaw.mjs";
const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
const prior = await json(path.join(destination, "summary.json")), completedStop = process.argv.includes("--completed-stop");
let inputs;
if (completedStop) {
  const inspection = await json(path.join(destination, "inspection-only-results.json")), manifest = await json(path.join(destination, "manifest.json"));
  if (inspection?.["E1-L"]?.businessRepairAndFinalVerification !== "PASS" || !manifest?.A || !manifest?.B) throw new Error("A verified completed isolated Stop chain is required");
  inputs = [manifest.A, manifest.B].map(p => ({ key: p.key, actualRoot: p.projectRoot, sessionId: p.sessionId }));
} else {
  if (!prior?.sessions?.length || prior.status !== "PASS" || prior.probe !== "real-model-and-business-files") throw new Error("A successful isolated real-model project probe is required");
  inputs = prior.sessions.filter(s => s.enabled);
}
const snapshot = async () => Promise.all(inputs.map(async s => ({ key: s.key, actualRoot: s.actualRoot, sessionId: s.sessionId, state: await runtimeState(s.actualRoot) })));
const original = await snapshot();
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), resume: true });
const outcome = { experiment: completedStop ? "E4-L-completed-stop" : h.version === "2026.10.3" ? "E4-N" : "E4-L", status: "RUNNING", hostVersion: h.version, queryOnly: true,
  originalProbe: completedStop ? "verified-completed-stop-with-checkpoint-inconsistency" : prior.probe };
try {
  const read = () => Promise.all(inputs.map(async s => ({ key: s.key, scope: await h.status(s.key), history: await h.request("chat.history", { sessionKey: s.key, limit: 100 }), state: await runtimeState(s.actualRoot) })));
  outcome.before = await read(); await h.restart(); outcome.after = await read(); await pause(1000);
  for (let i = 0; i < inputs.length; i++) {
    for (const current of [outcome.before[i], outcome.after[i]]) {
      assert.equal(current.scope.identity.sessionId, original[i].sessionId); assert.equal(current.scope.projectRoot, original[i].actualRoot);
      assert.equal(current.scope.source, h.version === "2026.10.3" ? "host" : "rc"); assert.equal(current.scope.enabled, true);
      assert.deepEqual(current.state.tasks.map(t => [t.taskId, t.groundTruth, t.stop, t.correctionEpoch]), original[i].state.tasks.map(t => [t.taskId, t.groundTruth, t.stop, t.correctionEpoch]));
      assert.deepEqual(current.state.records, original[i].state.records);
    }
    assert.deepEqual(outcome.before[i].scope.identity, outcome.after[i].scope.identity);
    // Status commands are legitimately persisted by both hosts. Compare the
    // existing transcript records, not the changing row timestamps/cursors.
    const messages = outcome.after[i].history.messages;
    for (const message of outcome.before[i].history.messages) {
      const restored = messages.find(row => row.__openclaw?.id === message.__openclaw?.id);
      assert(restored, "Existing transcript record disappeared after restart");
      for (const field of ["role", "content", "timestamp"]) assert.deepEqual(restored[field], message[field]);
    }
  }
  assert(!h.events.some(e => e.event === "agent" && e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start"));
  assert.equal((await fs.readFile(path.join(h.root, "console.log"), "utf8")).includes("<model-key>"), false);
  outcome.status = "PASS"; outcome.startedNoModels = true; outcome.noReceiptReplay = true;
} catch (error) { outcome.status = "FAIL"; outcome.error = h.redact(error.stack); }
finally { await h.save("restart-audit.json", outcome); await h.close(); }
process.stdout.write(JSON.stringify({ experiment: outcome.experiment, status: outcome.status, output: h.root, error: outcome.error }) + "\n");
process.exitCode = outcome.status === "PASS" ? 0 : 1;
