import fs from "node:fs/promises";
import path from "node:path";
import { taskDirectory, withTaskState, decisionGuard } from "../runtime-v2/task-store.mjs";
import { readJson, atomicWriteJson, sha256 } from "../runtime-v2/utils.mjs";
import { boundHostFeedback } from "../runtime-v2/feedback-delivery.mjs";
import { outsideDecision } from "../runtime-v2/decision-scope.mjs";

// Cancellation publishes navigation and a terminal failure, never a late PASS.
// Receipt closure is separate so an old run can close without changing a newer task.
export async function settleIncompleteStop({ projectRoot, taskId, runId, reasonCode, startedAt = 0, isCurrent = () => true }) {
  if (typeof taskId !== "string" || !taskId) return null;
  return outsideDecision(async () => {
    const root = taskDirectory(projectRoot, taskId);
    const directory = path.join(root, "review-collections");
    const collections = [];
    for (const name of await fs.readdir(directory).catch(e => { if (e.code === "ENOENT") return []; throw e; })) {
      const progressPath = path.join(directory, name, "progress.json");
      const progress = await readJson(progressPath);
      if (progress && Date.parse(progress.startedAt) >= startedAt) collections.push({ progressPath,
        totalItems: progress.totalItems, completedItems: progress.completedItems, statusAtTermination: progress.status });
    }
    const evaluationId = `stop-terminal-${sha256(runId).slice(0, 24)}`;
    const indexPath = path.join(root, "stop-terminals", `${evaluationId}.json`);
    const feedback = boundHostFeedback(`[runtime-corrector] UNVERIFIED: ${reasonCode}. Review stopped; this is not a business defect or PASS.\n`
      + collections.map(p => `Saved ${p.completedItems}/${p.totalItems} items: ${p.progressPath}`).join("\n")
      + `\n[RC_DETAILS] ${indexPath}`);
    await atomicWriteJson(indexPath, { runId, reasonCode, status: "UNVERIFIED", collections });
    if (!isCurrent()) return { feedback, indexPath };
    await withTaskState({ projectRoot, taskId }, async task => {
      const completedCurrent = task.status === "COMPLETED" && task.verification?.assessmentId?.startsWith(`${runId}:`);
      if (!isCurrent() || task.control?.cancelled || completedCurrent
        || task.verification?.terminalRunId === runId) return;
      const previousVerification = task.verification ?? null;
      await atomicWriteJson(path.join(root, "evaluations", `${evaluationId}.json`), {
        evaluationId, status: "UNVERIFIED", runId, reasonCode, previousVerification, savedCollections: collections,
      });
      const assessmentId = `${runId}:stop-terminal`;
      const verification = { status: "UNVERIFIED", evaluationId, assessmentId, terminalRunId: runId,
        reasonCode, previousVerification, updatedAt: new Date().toISOString() };
      task.assessments ??= {};
      task.assessments[assessmentId] = { mode: "execute_and_correct", guard: decisionGuard(task), verification,
        committedAt: new Date().toISOString(), result: { handled: true, taskId, decision: "allow", feedback,
          stop: { decision: "allow", verificationIncomplete: true, verificationUnavailable: true,
            savedReviewCollection: { progressPath: indexPath }, feedback } } };
      task.stop ??= {};
      task.stop.lastAssessmentId = evaluationId;
      task.verification = verification;
      task.status = "STOPPED_UNVERIFIED";
    });
    return { feedback, indexPath };
  });
}
