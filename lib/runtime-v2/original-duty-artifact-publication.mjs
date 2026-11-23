import { knownOriginalOwner } from './known-original-capacity.mjs';
import { observeKnownOriginalObligations } from './known-original-obligations.mjs';
import { hostOriginalCoverageCurrent } from './original-duty-publication.mjs';
import { sha256 } from './utils.mjs';

export function captureOriginalDutyPublication(state) {
  return { owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId, controller: state.reviewController };
}
export function originalDutyPublicationCurrent(state, captured) {
  return Boolean(captured && captured.sourceRunId && captured.sourceRunId === state.nativeRunId
    && captured.controller?.signal && captured.controller === state.reviewController && !captured.controller.signal.aborted
    && !state.scopeClosed && !state.nativeInvalidated
    && sha256(captured.owner) === sha256(knownOriginalOwner(state)));
}
// Both production publication callbacks and offline integration controls use
// this exact boundary. A caller supplies the finalized result, never a receipt.
export async function publishOriginalDutyArtifact(state, { file, finalized, sources, captured }) {
  if (!originalDutyPublicationCurrent(state, captured)) return false;
  const result = finalized?.result;
  const receipt = result?.metadata?.semanticReview?.originalRequirementCoverage;
  if (!hostOriginalCoverageCurrent(receipt)) return false;
  const binding = receipt.originalDutyOwnerBinding;
  if (!binding || binding.sourceRunId !== captured.sourceRunId
    || sha256(binding.owner) !== sha256(captured.owner)) return false;
  return observeKnownOriginalObligations(state, { file, receipt, sources,
    publication: { runId: captured.sourceRunId, taskId: captured.owner.taskId,
      sessionId: captured.owner.sessionId, result } });
}
