import test from "node:test";
import assert from "node:assert/strict";
import { stopFeedbackNotice, savedStopFeedbackNotice } from "../lib/openclaw/stop-feedback-notice.mjs";
import { createNativeStopChains } from "../lib/openclaw/native-stop-chain.mjs";
import { stopWaitText } from "../lib/openclaw/stop-wait-status.mjs";

const feedback = "FILE_QUALITY_DEVIATION delivery.md: title is missing; the intended subject is unclear.\nEvidence: delivery.md:1";

test("incomplete quality notice survives native settlement without admitting business work", async () => {
  const notice = stopFeedbackNotice({ fileQualityIncomplete: true, feedback });
  const chains = createNativeStopChains(), state = { projectRoot: "fixture", sessionId: "session", sessionKey: "key" };
  const chain = chains.begin({ state, runId: "run", taskId: "task", budgetMs: 1000 });
  chain.assessed({ runId: "run", reviewStatus: "UNVERIFIED", evaluationId: "evaluation", verificationFeedback: notice });
  const settled = await chain.released;
  assert.equal(settled.status, "SETTLED");
  assert.equal(settled.followupStatus, undefined);
  assert.match(stopWaitText(settled), /title is missing/);
  assert.match(stopWaitText(settled), /delivery.md:1/);
  assert.doesNotMatch(stopWaitText(settled), /验收通过/);
});

test("only a matching committed assessment can supply the next normal prompt's historical notice", () => {
  const task = { verification: { assessmentId: "assessment", evaluationId: "evaluation" }, stop: { lastAssessmentId: "evaluation" },
    assessments: { assessment: { verification: { evaluationId: "evaluation" }, result: { stop: { fileQualityIncomplete: true, feedback } } } } };
  assert.equal(savedStopFeedbackNotice(task).evaluationId, "evaluation");
  task.stop.lastAssessmentId = "newer";
  assert.equal(savedStopFeedbackNotice(task), null);
  assert.equal(stopFeedbackNotice({ feedback }), null);
  assert.equal(stopFeedbackNotice({ savedReviewCollection: { completedItems: 1 }, feedback }), feedback);
});

test("native display wrapping retains the existing total feedback limit", () => {
  const message = stopWaitText({ verificationFeedback: "诊断".repeat(10000) });
  assert.ok(Buffer.byteLength(message, "utf8") <= 8192);
});

test("ordinary metric UNVERIFIED and process no-progress notices disclose the failure without dispatching a correction", () => {
  const metric = "UNVERIFIED: runtime proof is missing. See the saved item for details.";
  assert.equal(stopFeedbackNotice({ report: { status: "UNVERIFIED" }, feedback: metric }), metric);
  const stopped = "PROCESS_CORRECTION_NO_PROGRESS: the same scope violation remains; automatic correction stopped.";
  assert.equal(stopFeedbackNotice({ verificationIncomplete: true, feedback: stopped }), stopped);
  assert.match(stopWaitText({ reviewStatus: "UNVERIFIED", reasonCode: "PROCESS_CORRECTION_NO_PROGRESS", verificationFeedback: stopped }), /same scope violation/u);
  assert.match(stopWaitText({ reviewStatus: "UNVERIFIED", reasonCode: "REVIEW_DEADLINE_EXPIRED", verificationFeedback: "Saved 98/110: progress.json" }), /98\/110/u);
  assert.equal(stopFeedbackNotice({ report: { status: "PASS" }, feedback: "Passed." }), null);
});
