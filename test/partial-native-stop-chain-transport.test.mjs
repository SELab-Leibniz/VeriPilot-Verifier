import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { createPostRunDispatcher } from "../lib/openclaw/post-run-dispatch.mjs";

test("post-run scheduling preserves admitted partial feedback and rechecks its independent run", async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-partial-post-run-"));
  const state = { projectRoot, agentId: "main", sessionId: "host-session", sessionKey: "agent:main:partial", scopeFingerprint: "scope" };
  const reviews = createNativeStopReviews(), observed = [];
  const manager = createPostRunDispatcher({ directoryFor: () => projectRoot, validate: async () => true,
    waitTerminal: async () => ({ status: "ok" }), sendUser: () => assert.fail("No user task is pending"),
    review: async record => {
      const controller = new AbortController();
      await reviews.schedule({ ...state, runId: record.runId, signal: controller.signal, budgetMs: 10000,
        onSettled: result => observed.push(result), run: async ({ commit }) => {
          if (record.runId === "first") {
            await commit({ reviewStatus: "UNVERIFIED", evaluationId: "partial-evaluation" });
            await manager.correction(state, "partial-feedback", Date.now() + 10000, "stop-partial", record.runId);
            return { reviewStatus: "UNVERIFIED", evaluationId: "partial-evaluation", followupStatus: "ADMITTED", feedbackOnly: true };
          }
          const result = { reviewStatus: "PASS", evaluationId: "complete-evaluation" };
          await commit(result); return result;
        } });
      return reviews.waitRun(state, record.runId);
    } });
  t.after(async () => { await manager.dispose(); await fs.rm(projectRoot, { recursive: true, force: true }); });
  await manager.started(state, "first");
  await manager.candidate(state, { runId: "first", reviewBudgetMs: 10000, text: "Done" });
  await manager.drain();
  assert.equal(observed[0].feedbackOnly, true);
  assert.equal(manager.snapshot(state).phase, "WAIT_CORRECTION");
  const base = path.join(projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const [session] = await fs.readdir(base), [file] = await fs.readdir(path.join(base, session));
  const persisted = JSON.parse(await fs.readFile(path.join(base, session, file), "utf8"));
  assert.equal(persisted.feedbackOnly, true); assert.equal(persisted.followupStatus, "ADMITTED");
  await manager.started(state, "partial-feedback");
  await manager.candidate(state, { runId: "partial-feedback", reviewBudgetMs: 10000, text: "Fixed" });
  await manager.drain();
  assert.equal(manager.snapshot(state).reviewStatus, "PASS");
  assert.equal(manager.snapshot(state).phase, "IDLE");
  assert.equal(observed[1].evaluationId, "complete-evaluation");
});
