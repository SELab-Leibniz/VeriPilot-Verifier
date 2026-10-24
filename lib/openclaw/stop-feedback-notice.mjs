import { boundHostFeedback } from "../runtime-v2/feedback-delivery.mjs";

// These notices disclose incomplete verification without dispatching another
// business run or turning a checker failure into a repair instruction.
export function stopFeedbackNotice(outcome) {
  if (!outcome?.fileQualityIncomplete && !outcome?.savedReviewCollection
    && !outcome?.verificationIncomplete && outcome?.report?.status !== "UNVERIFIED") return null;
  if (typeof outcome.feedback !== "string" || !outcome.feedback.trim()) return null;
  return boundHostFeedback(outcome.feedback);
}

export function savedStopFeedbackNotice(task) {
  const id = task?.verification?.assessmentId;
  const evaluationId = task?.verification?.evaluationId;
  const assessment = id && task.assessments?.[id];
  if (!evaluationId || task.stop?.lastAssessmentId !== evaluationId
    || assessment?.verification?.evaluationId !== evaluationId) return null;
  const result = assessment.result;
  const feedback = stopFeedbackNotice({ ...result?.stop, feedback: result?.feedback ?? result?.stop?.feedback });
  return feedback ? { evaluationId, feedback } : null;
}
