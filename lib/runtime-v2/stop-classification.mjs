// Shared semantic contract for the single workspace reviewer and retained
// development classification protocol. No legacy worker dependency is needed.
export const completionProperties = {
  completionClaim: { type: 'boolean', description: 'Whether the original reply claims the requested scope is complete; this is not an acceptance verdict.' },
  requiredUserInput: { type: ['string', 'null'], maxLength: 768, description: 'A necessary unresolved user decision, or null. Optional improvements are not prerequisites.' },
  externalBlocker: { type: ['string', 'null'], maxLength: 768, description: 'A concrete unresolved external blocker, or null.' },
};
export const COMPLETION_INSTRUCTIONS = 'Judge completion of the requested scope, not whether the conversation could continue. A delivered result followed by optional improvements or offers of more work is TASK_COMPLETE. WAITING_FOR_USER requires a necessary unresolved user decision; BLOCKED_EXTERNAL requires a concrete blocker. Missing execution proof does not turn a completion claim into INTERMEDIATE. Code implementation is not a proposal/design/tasks document stage. With classificationContract=2 always submit boolean completionClaim. Include requiredUserInput or externalBlocker only for a real unresolved prerequisite; otherwise omit them. Include stage only for STAGE_COMPLETE. Never send the string "null" for absent values.';

export function validateStopClassification(value, { contract, allowedStages = [] } = {}) {
  const invalid = message => { throw Object.assign(new Error(message), { code: 'STOP_CLASSIFICATION_INVALID' }); };
  if (contract === 2) {
    if (typeof value.completionClaim !== 'boolean') invalid('A structured completion claim assessment is required');
    if (value.stopClassification === 'WAITING_FOR_USER' && (value.completionClaim || !value.requiredUserInput?.trim()))
      invalid('Waiting requires a necessary unresolved user decision; optional follow-ups cannot narrow completed scope');
    if (value.stopClassification === 'BLOCKED_EXTERNAL' && (value.completionClaim || !value.externalBlocker?.trim()))
      invalid('External blocking requires an unresolved concrete blocker');
    if (['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(value.stopClassification) && (!value.completionClaim || value.requiredUserInput?.trim() || value.externalBlocker?.trim()))
      invalid('Completion cannot have unresolved prerequisites');
    if (value.stopClassification === 'INTERMEDIATE' && value.completionClaim) invalid('A completion claim requires completion scope assessment');
  }
  if (value.stopClassification === 'STAGE_COMPLETE') {
    if (!value.stage?.trim() || !allowedStages.includes(value.stage)) invalid('Stage must match the frozen workflow scope');
  } else if (value.stage != null) invalid('Only STAGE_COMPLETE owns a stage');
}
