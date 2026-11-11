// One shared acceptance boundary for SDK, native and CLI review results.
// readProof is transport-owned metadata on a checked source citation, never a
// model field. It proves disclosure and scope, not the truth of a diagnosis.
import { missingFileProof } from './expected-files.mjs';
import { sha256 } from './utils.mjs';
import { validateConditionalAssessment, CONDITIONAL_REVIEW_POLICY_VERSION, requiresConditionWindow } from '../review-task/task-evidence.mjs';
// This non-JSON capability travels only through the explicit accepted-row
// argument. Raw model rows and restored serialized tags cannot manufacture it.
const acceptedConditionalJudgement = Symbol('accepted-conditional-judgement');
const evidenceIdentity = citation => sha256([citation.path, citation.contentHash]);
export const EXCLUDING_REVIEW_VERDICTS = new Set([
  "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING",
]);

// The explicit original obligation owns the proof subject. Implementing code
// and actually running a requested operation are separate claims; a metric ID
// must not turn the former into an unrequested execution duty.
export function reviewProofScope(object, role = 'stop-reviewer') {
  if (role === 'implementation-reviewer' || object.metricId === 'M16') return 'SOURCE_IMPLEMENTATION';
  if (['M08', 'M11'].includes(object.metricId)) return 'PROCESS_COMPLIANCE';
  if (['M13', 'M14', 'M15'].includes(object.metricId)) return 'EXECUTION_CLOSURE';
  if (['M09', 'M10', 'M12'].includes(object.metricId)) {
    if (object.verificationTarget === 'PROCESS') return object.metricId === 'M12' ? 'RUNTIME_ACCEPTANCE' : 'PROCESS_COMPLIANCE';
    if (object.verificationTarget === 'IMPLEMENTATION') return 'SOURCE_IMPLEMENTATION';
    // Unknown/legacy targets retain their conservative prior subject.
    return object.metricId === 'M12' ? 'ARTIFACT_EXECUTION' : 'METRIC_ARTIFACT_REVIEW';
  }
  return 'METRIC_ARTIFACT_REVIEW';
}

/** Shared proof owners for native workspace, task and collector boundaries. */
export function reviewProofOwners(object, role = "stop-reviewer") {
  if (role === "implementation-reviewer") return ["SOURCE"];
  const metric = object?.metricId;
  if (metric === "M16") return ["SOURCE"];
  if (["M08", "M11"].includes(metric)) return ["PROCESS"];
  if (["M13", "M14", "M15"].includes(metric))
    return object.verificationTarget === "ARTIFACT" ? ["ARTIFACT", "PROCESS"] : ["PROCESS"];
  if (["M09", "M10", "M12"].includes(metric)) {
    if (object.verificationTarget === "PROCESS") return ["PROCESS"];
    if (object.verificationTarget === "IMPLEMENTATION") return ["SOURCE"];
    return metric === "M12" ? ["ARTIFACT", "PROCESS"] : ["ARTIFACT"];
  }
  return ["ARTIFACT"];
}

export function hasReviewReadProof(citation, owners) {
  const proof = citation?.readProof;
  return proof?.version === 1 && proof.observed === true && proof.basisComplete === true
    && owners.includes(proof.owner);
}

export function requiresExecutionResult(object, role = "stop-reviewer") {
  const owners = reviewProofOwners(object, role);
  return ['M12', 'M13', 'M15'].includes(object?.metricId) && owners.length === 1 && owners[0] === 'PROCESS';
}

function unavailable(cause) {
  throw Object.assign(new Error(cause), { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
}

// This is a checker failure, not a business UNVERIFIED judgement. The collector
// preserves valid siblings and keeps this item incomplete so k is not spent.
export function validateReviewJudgement({ row, object, citations = [], role = "stop-reviewer", classification = null, conditionContext = null, mechanicalEvidence = false }) {
  if (mechanicalEvidence) {
    if (row.judgement === 'DEVIATION' && !citations.length) unavailable('A deviation requires a file and line-range citation.');
    return row;
  }
  let conditionBinding;
  if (object?.applicabilityKind === 'CONDITIONAL') {
    conditionBinding = validateConditionalAssessment({ assessment: row.conditionAssessment, verdict: row.judgement,
      context: { policy: CONDITIONAL_REVIEW_POLICY_VERSION, objectId: object.objectId,
        objectRevision: object.sourceRevisionId, objectDigest: sha256(object),
        currentCursor: sha256({ revision: object.sourceRevisionId, classification, citations: citations.map(c => [c.path, c.contentHash]) }),
        basisComplete: citations.some(c => c.readProof?.observed === true && c.readProof.basisComplete === true),
        targetEvidence: citations.some(c => hasReviewReadProof(c, ['SOURCE', 'ARTIFACT', 'PROCESS']) && c.readProof.fullFile === true && c.readProof.activationFact === true),
        processEvidence: citations.some(c => hasReviewReadProof(c, ['PROCESS'])),
        ...conditionContext, requiresProcessWindow: requiresConditionWindow(object) } });
  }
  const checked = conditionBinding ? { ...row, conditionBinding } : row;
  if (!["PASS", "DEVIATION"].includes(row.judgement) && !EXCLUDING_REVIEW_VERDICTS.has(row.judgement)) return checked;
  if (!citations.length) return unavailable("No checked original evidence supports this judgement.");
  // Inactivity is about the trigger, not fulfillment of the inactive duty.
  // The shared contract already checked its original basis and target/window
  // witness; do not demand execution of an inapplicable PROCESS action.
  if (row.judgement === 'NOT_APPLICABLE' && conditionBinding?.activation === 'INACTIVE_AT_CURRENT_BOUNDARY') return checked;
  // A program-observed missing output is a concrete counterexample, not a
  // missing execution log. This receipt can never establish PASS or exclusion.
  if (row.judgement === 'DEVIATION' && citations.some(citation => missingFileProof(object, citation))) return row;
  if (row.judgement === "BASIS_PENDING") {
    if (object?.authority !== "BASIS_PENDING" || object.hard === true)
      return unavailable("The frozen obligation is not an unresolved, nonbinding basis.");
    return citations.some(citation => hasReviewReadProof(citation, ["BASIS"])) ? row
      : unavailable("The pending basis and its complete original conditions were not demonstrably read.");
  }
  if (row.judgement === "NOT_YET_EXECUTED" && classification?.stopClassification === "TASK_COMPLETE"
    && object?.hard === true && object.evidenceRequired === true)
    return unavailable("A required execution that has not happened cannot be excluded at task completion.");
  const owners = reviewProofOwners(object, role);
  if (!citations.some(citation => hasReviewReadProof(citation, owners)))
    return unavailable(`Complete basis and actually read ${owners.join("/")} evidence were not established.`);
  if (['PASS', 'DEVIATION'].includes(row.judgement) && requiresExecutionResult(object, role)
    && citations.some(citation => citation.readProof?.protocol === 'workspace-stop-v1')
    && !citations.some(citation => hasReviewReadProof(citation, ['PROCESS']) && citation.readProof.executionEvidence === true))
    return unavailable('An attributable original execution result is unavailable. Read both original invocation and result. Messages or missing records cannot certify execution PASS or DEVIATION; use UNVERIFIED.');
  if (conditionBinding && row.judgement === 'DEVIATION') Object.defineProperty(checked, acceptedConditionalJudgement,
    { value: Object.freeze({ object: sha256(object), row: sha256(checked), evidence: citations.map(evidenceIdentity),
      sources: citations.map(c => [c.path, c.contentHash]), classification: sha256([classification?.stopClassification ?? null, classification?.stage ?? null]) }) });
  return checked;
}

export function validateReviewFile({ file, citations = [], mechanicalEvidence = false }) {
  if (mechanicalEvidence) {
    if (file.status === 'DEVIATION' && !citations.length) unavailable('A deviation requires a file and line-range citation.');
    return file;
  }
  if (!["PASS", "DEVIATION"].includes(file.status)) return file;
  if (citations.some(citation => hasReviewReadProof(citation, ["ARTIFACT", "SOURCE"]))) return file;
  return unavailable("Complete basis and actually read delivery-file evidence were not established.");
}

/** A finding owns claims; one claim can project to several metric questions. */
export function validateReviewFinding({ finding, objects = [], citations = [], role = "stop-reviewer", classification = null,
  judgements = classification?.metricObjectJudgements ?? [], conditionContexts = {}, conditionContextForObject = id => conditionContexts[id], mechanicalEvidence = false }) {
  if (mechanicalEvidence) {
    if (!(finding.violatedGroundTruthIds?.length && finding.violatedGroundTruthIds.every(id => objects.some(object => object.sourceId === id))))
      throw Object.assign(new Error('A finding must refer to assigned original requirements.'), { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
    if (!citations.length) unavailable('A deviation requires a file and line-range citation.');
    return finding;
  }
  for (const id of finding.violatedGroundTruthIds ?? []) {
    const candidates = objects.filter(object => object.sourceId === id);
    if (!candidates.length) throw Object.assign(new Error("A finding references a claim outside its evidence ownership."),
      { code: "REVIEW_ITEM_OWNERSHIP_INVALID" });
    let established = false, lastError;
    for (const object of candidates) {
      try {
        let row = { judgement: 'DEVIATION' };
        if (object.applicabilityKind === 'CONDITIONAL') {
          const matching = judgements.filter(value => value.objectId === object.objectId);
          if (matching.length > 1) throw Object.assign(new Error('Duplicate conditional rows cannot authorize a finding.'), { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
          if (matching.length) {
            const accepted = matching[0], proof = accepted[acceptedConditionalJudgement];
            if (!proof || proof.object !== sha256(object) || proof.row !== sha256(accepted)
              || accepted.judgement !== 'DEVIATION' || accepted.conditionAssessment?.activation !== 'ACTIVE'
              || proof.classification !== sha256([classification?.stopClassification ?? null, classification?.stage ?? null])
              || !citations.some(c => proof.evidence.includes(evidenceIdentity(c)))
              || citations.some(c => proof.sources.some(([file, hash]) => c.path === file && c.contentHash !== hash)))
              throw Object.assign(new Error('A finding requires its current same-object validated ACTIVE DEVIATION and original evidence.'), { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
            row = accepted;
          } else {
            const explicit = (finding.conditionAssessments ?? []).filter(value => value.objectId === object.objectId);
            if (explicit.length !== 1) throw Object.assign(new Error('REVIEW_CONDITION_ASSESSMENT_REQUIRED: a findings-only conditional claim needs its explicit original activation witness.'), { code: 'REVIEW_CONDITION_ASSESSMENT_REQUIRED' });
            row = { judgement: 'DEVIATION', conditionAssessment: explicit[0].conditionAssessment };
          }
        }
        validateReviewJudgement({ row, object, citations, role, classification, conditionContext: conditionContextForObject(object.objectId) }); established = true; break;
      }
      catch (error) { if (error.code !== "REVIEW_ITEM_EVIDENCE_UNAVAILABLE") throw error; lastError = error; }
    }
    if (!established) throw lastError;
  }
  return finding;
}
