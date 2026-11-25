import { boundHostFeedback } from "../runtime-v2/feedback-delivery.mjs";
import { acceptanceNotice } from "../runtime-v2/stop-source-coverage.mjs";

// These notices disclose incomplete verification without dispatching another
// business run or turning a checker failure into a repair instruction.
export function stopFeedbackNotice(outcome) {
  // Document correction owns document-only work; the skip has nothing for the business model to act on.
  if (outcome?.reasonCode === "STOP_DOCUMENT_ONLY_CHANGES") return null;
  if (!outcome?.fileQualityIncomplete && !outcome?.savedReviewCollection
    && !outcome?.verificationIncomplete && outcome?.report?.status !== "UNVERIFIED") return null;
  if (typeof outcome.feedback !== "string" || !outcome.feedback.trim()) return null;
  const scope = outcome.decision === 'block' && outcome.acceptanceReport?.unverifiedItems.length
    ? acceptanceNotice(outcome.acceptanceReport) : '';
  return boundHostFeedback([scope, outcome.feedback].filter(Boolean).join('\n\n'));
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
