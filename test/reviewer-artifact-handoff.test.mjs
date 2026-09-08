import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSemanticReview } from "../lib/semantic-review.mjs";
import { startRoleReviewer } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "parent" });
  const entry = path.join(root, "agent.cjs");
  const capture = path.join(root, "capture.jsonl");
  await fs.writeFile(entry, String.raw`
const fs = require("node:fs"); const path = require("node:path");
const root = process.env.RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT;
const dir = path.join(root, ".runtime-correction", ".internal-requests", process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID);
const req = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
const role = process.env.RUNTIME_CORRECTOR_INTERNAL_ROLE;
const semantic = req.semanticReviewRequestPath ? JSON.parse(fs.readFileSync(req.semanticReviewRequestPath, "utf8")) : null;
const frozen = semantic ? { gt: JSON.parse(fs.readFileSync(semantic.runtimeV2.groundTruthPath, "utf8")), transcript: JSON.parse(fs.readFileSync(semantic.runtimeV2.transcript.path, "utf8")) } : null;
let previous = [];
try { previous = fs.readFileSync(process.env.CAPTURE, "utf8").trim().split("\n").map(JSON.parse); } catch {}
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({ role, args: process.argv.slice(2), provider: process.env.ANTHROPIC_BASE_URL, req, semantic, frozen, originExists: process.env.ORIGIN_DIR ? fs.existsSync(process.env.ORIGIN_DIR) : null }) + "\n");
const firstArtifact = !previous.some(p => p.role === "artifact-reviewer");
const result = role === "artifact-reviewer" ? firstArtifact ? { summary: "needs schema repair" } : { summary: "repaired", findings: [], edits: [] } : { ok: true };
process.stdout.write(JSON.stringify({ session_id: process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID, structured_output: result }));
`);
  const runtime = { executable: process.execPath, argsPrefix: [entry] };
  const env = { ...process.env, RUNTIME_CORRECTOR_AGENT_EXECUTABLE: undefined, CAPTURE: capture, KEY_A: "secret-source-A", KEY_B: "secret-target-B" };
  const reviewer = (key) => ({ effort: "low", timeoutMs: 2000, session: "independent", provider: { baseUrl: `https://${key}.invalid`, apiKeyEnv: key } });
  const owner = { projectRoot: root, sessionCwd: root, taskId: task.taskId, parentSessionId: "parent", pluginRoot: root, reviewerRuntime: runtime, env };
  const prepared = { projectRoot: root, result: { status: "passed", diagnostics: [], metadata: { roundId: "artifact-round", artifactFiles: [] } }, reviewContext: {} };
  return { root, capture, owner, reviewer, prepared };
}

test("artifact handoff routes target provider and retains frozen target evidence through structured repair", async (t) => {
  const f = await fixture(t);
  const origin = await startRoleReviewer({ ...f.owner, role: "ground-truth-extractor", reviewer: f.reviewer("KEY_A"), schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, request: {} });
  const gtPath = path.join(f.root, "current.json");
  const transcriptPath = path.join(f.root, "transcript.jsonl");
  const groundTruth = { version: 8, claims: [{ text: "original GT" }] };
  const snapshot = { entries: [{ type: "user", message: { content: "original transcript" } }], digest: "source-only-digest", lastEntryKey: "cursor" };
  await fs.writeFile(gtPath, JSON.stringify({ version: 99, claims: [] }));
  await fs.writeFile(transcriptPath, "changed transcript after read");
  const outcome = await runSemanticReview({ input: { cwd: f.root, session_id: "parent", transcript_path: transcriptPath }, prepared: f.prepared,
    runtimeV2Handle: origin,
    runtimeV2Context: { taskId: f.owner.taskId, reviewerExecution: f.reviewer("KEY_B"), groundTruthPath: gtPath },
    runtimeV2ExecutionContext: { ...f.owner, env: { ...f.owner.env, ORIGIN_DIR: origin.requestDirectory } },
    runtimeV2Evidence: { snapshot, groundTruth, population: { objects: [] } },
  });
  assert.equal(outcome.status, "completed", outcome.error);
  const calls = (await fs.readFile(f.capture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 3, "one GT, one target, one target repair");
  for (const call of calls.slice(1)) {
    assert.equal(call.role, "artifact-reviewer");
    assert.equal(call.provider, "https://KEY_B.invalid");
    assert.equal(call.originExists, false);
    assert.equal(call.frozen.gt.version, 8);
    assert.equal(call.frozen.transcript.entries[0].message.content, "original transcript");
    assert.equal(call.semantic.runtimeV2.transcriptDigest, "source-only-digest");
    assert.ok(!JSON.stringify(call.req).includes("secret-"));
    assert.ok(!JSON.stringify(call.semantic).includes("secret-"));
    await assert.rejects(fs.access(call.req.semanticReviewRequestPath));
  }
  assert.ok(!calls[1].args.includes("--resume"));
  assert.ok(calls[2].args.includes("--no-session-persistence"));
  assert.deepEqual(await fs.readdir(path.join(f.root, ".runtime-correction", "internal-runs")), []);
  await assert.rejects(fs.access(path.join(f.root, ".runtime-correction", ".semantic-review", "artifact-round")));
});

test("semantic request preparation failure closes an already owned source and removes partial request directory", async (t) => {
  const f = await fixture(t);
  f.prepared.result.diagnostics = [1n];
  let closes = 0;
  const result = await runSemanticReview({ input: { cwd: f.root, session_id: "parent" }, prepared: f.prepared,
    runtimeV2Handle: { close: async () => { closes += 1; } }, runtimeV2Context: { reviewerExecution: f.reviewer("KEY_A") },
  });
  assert.equal(result.status, "failed");
  assert.equal(closes, 1);
  await assert.rejects(fs.access(path.join(f.root, ".runtime-correction", ".semantic-review", "artifact-round")));
});
