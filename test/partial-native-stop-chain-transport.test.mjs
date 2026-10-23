import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeStopReviews } from "../lib/openclaw/native-stop-review.mjs";
import { createNativeStopChains } from "../lib/openclaw/native-stop-chain.mjs";

test("native review scheduling preserves admitted partial feedback through the Stop chain and durable record", async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-partial-chain-transport-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const state = { projectRoot, sessionId: "host-session", sessionKey: "agent:main:partial-chain", nativeRunId: "first" };
  const controller = new AbortController(), jobs = new Map(), reviews = createNativeStopReviews(jobs);
  const chains = createNativeStopChains(), chain = chains.begin({ state, runId: "first", taskId: "task", budgetMs: 10000 });
  t.after(() => chain.cancel("TEST_CLEANUP"));
  const observed = [];
  const onSettled = record => { observed.push(record); chain.assessed(record); };
  await reviews.schedule({ ...state, runId: "first", signal: controller.signal, budgetMs: 10000, onSettled,
    run: async ({ commit }) => {
      await commit({ reviewStatus: "UNVERIFIED", evaluationId: "partial-evaluation" });
      chains.link(state, { taskId: "task", runId: "partial-feedback", feedbackOnly: true });
      return { reviewStatus: "UNVERIFIED", evaluationId: "partial-evaluation", followupStatus: "ADMITTED", feedbackOnly: true };
    } });
  const [first] = await reviews.wait();
  assert.equal(first.feedbackOnly, true);
  assert.equal(observed[0].feedbackOnly, true);
  assert.equal(chain.pending, true, "an admitted partial review must not release the waiting chain");
  assert.equal(chain.record.phase, "REVIEWING");
  const recordDirectory = path.join(projectRoot, ".runtime-correction/openclaw/native-stop-reviews");
  const [sessionDirectory] = await fs.readdir(recordDirectory);
  const [recordFile] = await fs.readdir(path.join(recordDirectory, sessionDirectory));
  const persisted = JSON.parse(await fs.readFile(path.join(recordDirectory, sessionDirectory, recordFile), "utf8"));
  assert.equal(persisted.feedbackOnly, true);
  assert.equal(persisted.followupStatus, "ADMITTED");
  assert.equal(persisted.reviewStatus, "UNVERIFIED");

  chain.enter("partial-feedback");
  state.nativeRunId = "partial-feedback";
  await reviews.schedule({ ...state, runId: state.nativeRunId, signal: controller.signal, budgetMs: 10000, onSettled,
    run: async ({ commit }) => {
      const result = { reviewStatus: "PASS", evaluationId: "complete-evaluation" };
      await commit(result); return result;
    } });
  await reviews.wait();
  assert.equal((await chain.released).evaluationId, "complete-evaluation");
  assert.equal(chain.record.reviewStatus, "PASS");
  assert.equal(chain.pending, false);
});
