// GLM-5.3's official chat template represents effort as a system instruction:
// https://huggingface.co/zai-org/GLM-5.3/raw/main/chat_template.jinja
// The Coding Plan Anthropic endpoint does not reliably apply budget_tokens or
// reasoning_effort. This is a prompt compatibility hint, NOT a hard token cap.
// Keep the operator's selected effort; never change models or host config.
export function reviewerEffortPrompt(model, effort = "low") {
  if (model?.toLowerCase() !== "glm-5.3") return [];
  const level = { low: "Low", medium: "High", high: "High", max: "Max" }[effort];
  if (!level) throw new Error(`Unsupported GLM reviewer effort: ${effort}`);
  return [`Reasoning Effort: ${level}`];
}

export const STOP_CLASSIFICATION_PROMPT = "Classify the stopping situation separately from whether the evidence passes. STAGE_COMPLETE/TASK_COMPLETE describe a completion assessment, not a successful verification; they may contain blocking findings. For INTERMEDIATE, WAITING_FOR_USER or BLOCKED_EXTERNAL, return an empty metricObjectJudgements array. Never turn a known defect into PASS to match a completion claim.";

export function assertReviewerRunCompleted(result) {
  const stop = result?.meta?.stopReason;
  let code, message;
  if (result?.meta?.aborted) {
    code = "REVIEWER_RUN_ABORTED";
    message = result.meta.error?.message ?? "OpenClaw reviewer run was aborted before verification.";
  } else if (stop === "length" || stop === "max_tokens") {
    code = "REVIEWER_OUTPUT_LIMIT";
    message = "OpenClaw reviewer exhausted its output token budget before completing the assessment. Thinking shares this budget; increasing timeout alone does not fix it.";
  } else if (result?.meta?.error || result?.payloads?.some(item => item.isError)) {
    code = "REVIEWER_RUN_FAILED";
    message = result?.meta?.error?.message ?? "OpenClaw reviewer did not complete successfully.";
  } else if (!(result?.payloads ?? []).some(item => !item.isReasoning && !item.isCommentary && item.text?.trim())) {
    code = "REVIEWER_NO_FINAL_OUTPUT";
    message = "OpenClaw reviewer returned no final JSON output.";
  }
  if (code) throw Object.assign(new Error(`${code}: ${message}`), { code, reviewerRuntimeFailure: true });
}
