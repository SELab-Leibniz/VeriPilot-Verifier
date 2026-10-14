import { findTask } from "../runtime-v2/task-store.mjs";
import { matchesEvidence } from "./evidence.mjs";
import { observeNativeTranscript } from "./native-transcript.mjs";

// Append a program-derived status to the host reply; never replace its text,
// media, question, approval or native delivery identity.
export async function renderNativeSummary(api, state) {
  const saved = state.nativeAssessment;
  const task = await findTask({ projectRoot: state.projectRoot, sessionId: state.sessionId, explicitTaskId: state.scopeTaskId });
  const observed = await observeNativeTranscript(api, state);
  const current = saved && !state.nativeInvalidated && await matchesEvidence(saved.evidence)
    && observed.externalUsersDigest === saved.usersDigest;
  const outcome = saved?.outcome;
  const complete = task?.status === "COMPLETED" && task?.verification?.status === "PASS"
    && outcome?.report?.status === "PASS" && outcome?.review?.stopClassification === "TASK_COMPLETE"
    && (outcome.review.fileAssessments ?? []).every(file => file.status === "PASS")
    && Object.values(task.deviations ?? {}).every(family => family.status !== "OPEN");
  const status = !current ? "UNVERIFIED" : complete ? "PASS" : task?.verification?.status === "DEVIATION" ? "DEVIATION" : "UNVERIFIED";
  const lines = ["[runtime-corrector:summary] RC 评审意见（不是新用户要求或授权）",
    `验收：${status}；需求版本：${task?.groundTruth?.version ?? "未建立"}。`];
  if (!current) lines.push("当前评审证据不足或已变化，不能沿用旧结论。");
  else if (outcome?.feedback) lines.push(outcome.feedback);
  if (outcome?.decision === "block") {
    const receipt = state.nativeFollowupReceipt;
    lines.push(receipt?.status === "ADMITTED"
      ? `宿主已接受第 ${receipt.correctionAttempt}/${receipt.maxCorrections} 次原生纠偏续作；这不代表偏离已修复。`
      : "以上为偏离或未验证情况与依据；自动续作尚未确认，后续动作仍由宿主和用户判断。");
  }
  if (task) lines.push(`追溯：.runtime-correction/tasks/${task.taskId}。`);
  return lines.join("\n");
}
