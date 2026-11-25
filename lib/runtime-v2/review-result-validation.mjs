// One shared acceptance boundary for SDK, native and CLI review results.
// readProof is transport-owned metadata on a checked source citation, never a
// model field. It proves disclosure and scope, not the truth of a diagnosis.
import { missingFileProof } from './expected-files.mjs';
import { sha256 } from './utils.mjs';
import { validateConditionalAssessment, CONDITIONAL_REVIEW_POLICY_VERSION, requiresConditionWindow } from '../review-task/task-evidence.mjs';
import { validateProcessClaims } from './process-claims.mjs';
// This non-JSON capability travels only through the explicit accepted-row
// argument. Raw model rows and restored serialized tags cannot manufacture it.
const acceptedConditionalJudgement = Symbol('accepted-conditional-judgement');
const evidenceIdentity = citation => sha256([citation.path, citation.contentHash]);
export const EXCLUDING_REVIEW_VERDICTS = new Set([
  "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING",
]);

export const ORIGINAL_PROOF_SUBJECT_GUIDANCE = 'Before freezing the checklist, choose from the complete original duty: ARTIFACT for a required document or other delivered content; IMPLEMENTATION for required code or configuration behavior (SUPPORT still requires SOURCE); PROCESS for an explicitly required operation being performed. Preserve every part and condition of mixed duties; do not choose an easier target. Do not borrow unrelated SOURCE to satisfy a mismatch, reclassify automatically, or treat navigation as proof.';

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

export const CONDITIONAL_WITNESS_GUIDANCE = 'TARGET_FACTS needs an acknowledged SOURCE/ARTIFACT/PROCESS activation-fact citation with fullFile=true and activationFact=true. PROCESS_EVENT needs acknowledged PROCESS evidence of the original event; it does not replace the duty\'s required SOURCE/ARTIFACT proof or a required PROCESS_WINDOW. Choose the kind from the original condition, not to bypass a failed predicate. Readiness describes disclosure only, not semantic truth.';

// Display only: each predicate mirrors the existing checks below. Do not use
// this projection to grant a read receipt, convert a kind, or accept a row.
export function conditionalWitnessReadiness({ citations = [], object, role = 'stop-reviewer', assessment, context = {} }) {
  const targetOwners = ['SOURCE', 'ARTIFACT', 'PROCESS'], requiredOwners = reviewProofOwners(object, role);
  const ownerLabel = owner => [...targetOwners, 'BASIS', 'REVIEWER'].includes(owner) ? owner : 'UNKNOWN';
  const missing = (proof, owners) => [
    ...(proof?.version === 1 ? [] : ['version']), ...(proof?.observed === true ? [] : ['observed']),
    ...(proof?.basisComplete === true ? [] : ['basisComplete']), ...(owners.includes(proof?.owner) ? [] : ['owner']),
  ];
  const windowRequired = assessment?.evidenceKind === 'PROCESS_WINDOW'
    || assessment?.activation === 'INACTIVE_AT_CURRENT_BOUNDARY' && context.requiresProcessWindow;
  return { navigationOnly: true, readProofGranted: false, semanticsVerified: false,
    selectedEvidenceKind: assessment?.evidenceKind ?? null, targetFactsOwners: targetOwners,
    processEventOwners: ['PROCESS'], requiredJudgementOwners: requiredOwners,
    effectiveContext: { policyCurrent: context.policy === CONDITIONAL_REVIEW_POLICY_VERSION,
      basisComplete: context.basisComplete === true, currentCursorAvailable: Boolean(context.currentCursor),
      targetFactsReady: Boolean(context.targetEvidence), processEventReady: Boolean(context.processEvidence),
      ...(windowRequired ? { processWindowRequired: true, processWindowComplete: Boolean(context.processWindow?.complete),
        afterCallIdMatches: Boolean(assessment?.afterCallId && context.processWindow?.afterCallId === assessment.afterCallId),
        windowCursorMatches: context.processWindow?.cursor === context.currentCursor } : {}) },
    citationCount: citations.length, citations: citations.slice(0, 16).map((citation, checkedCitationIndex) => {
      const proof = citation?.readProof;
      return { checkedCitationIndex,
        ...(typeof citation?.citeId === 'string' && Buffer.byteLength(JSON.stringify(citation.citeId)) <= 64 ? { citeId: citation.citeId } : {}),
        owner: ownerLabel(proof?.owner),
        targetFactsMissing: [...missing(proof, targetOwners), ...(proof?.fullFile === true ? [] : ['fullFile']),
          ...(proof?.activationFact === true ? [] : ['activationFact'])],
        processEventMissing: missing(proof, ['PROCESS']),
        requiredOwnerReady: hasReviewReadProof(citation, requiredOwners) };
    }), omittedCitationCount: Math.max(0, citations.length - 16) };
}

function withWitnessReadiness(error, options) {
  const witnessReadiness = conditionalWitnessReadiness(options);
  error.witnessReadiness = witnessReadiness;
  error.message += ` ${CONDITIONAL_WITNESS_GUIDANCE} ${JSON.stringify({ witnessReadiness })}`;
  return error;
}

// Display only. Fixed enum labels and aggregate counts keep arbitrary subjects,
// references and citation arrays out of the native error transport.
function proofOwnerReadiness(object, role, citations) {
  const owners = reviewProofOwners(object, role), labels = ['SOURCE', 'ARTIFACT', 'PROCESS', 'BASIS', 'REVIEWER', 'UNKNOWN'];
  const counts = new Map(labels.map(owner => [owner, { owner, total: 0, version1: 0, observed: 0, basisComplete: 0, complete: 0 }]));
  for (const citation of citations) {
    const proof = citation?.readProof, group = counts.get(labels.includes(proof?.owner) ? proof.owner : 'UNKNOWN');
    group.total++; group.version1 += Number(proof?.version === 1); group.observed += Number(proof?.observed === true);
    group.basisComplete += Number(proof?.basisComplete === true);
    group.complete += Number(proof?.version === 1 && proof.observed === true && proof.basisComplete === true);
  }
  const received = [...counts.values()].filter(group => group.total);
  const matchingOwnerPresent = received.some(group => owners.includes(group.owner));
  return { navigationOnly: true, readProofGranted: false, assessmentGranted: false,
    target: ['ARTIFACT', 'IMPLEMENTATION', 'PROCESS'].includes(object?.verificationTarget) ? object.verificationTarget : 'UNSPECIFIED',
    implementationRole: ['PRODUCTION', 'TEST', 'SUPPORT'].includes(object?.implementationRole) ? object.implementationRole : null,
    requiredOwners: owners, citationCount: citations.length, received,
    issue: !matchingOwnerPresent && received.some(group => group.complete) ? 'PROOF_OWNER_MISMATCH' : 'READ_PROOF_INCOMPLETE' };
}

function unavailable(cause, witnessOptions = null, ownerReadiness = null) {
  const error = Object.assign(new Error(cause), { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
  if (ownerReadiness) {
    error.proofOwnerReadiness = ownerReadiness;
    const received = ownerReadiness.received.map(group => `${group.owner}:${group.complete}/${group.total}`).join(',');
    error.message += ` Frozen target ${ownerReadiness.target}${ownerReadiness.implementationRole ? '/' + ownerReadiness.implementationRole : ''}; required ${ownerReadiness.requiredOwners.join('/')}; complete acknowledged ${received} (version1+observed+basisComplete). ${JSON.stringify({ proofOwnerReadiness: ownerReadiness })} This diagnostic grants no proof or reclassification. Rereading the same artifact does not change its owner; do not borrow unrelated source.`;
  }
  throw witnessOptions ? withWitnessReadiness(error, witnessOptions) : error;
}

// This is a checker failure, not a business UNVERIFIED judgement. The collector
// preserves valid siblings and keeps this item incomplete so k is not spent.
export function validateReviewJudgement({ row, object, citations = [], role = "stop-reviewer", classification = null, conditionContext = null, mechanicalEvidence = false }) {
  validateProcessClaims({ claims: row.processClaims, citations });
  if (mechanicalEvidence) {
    if (row.judgement === 'DEVIATION' && !citations.length) unavailable('A deviation requires a file and line-range citation.');
    return row;
  }
  let conditionBinding, witnessContext;
  if (object?.applicabilityKind === 'CONDITIONAL') {
    witnessContext = { policy: CONDITIONAL_REVIEW_POLICY_VERSION, objectId: object.objectId,
        objectRevision: object.sourceRevisionId, objectDigest: sha256(object),
        currentCursor: sha256({ revision: object.sourceRevisionId, classification, citations: citations.map(c => [c.path, c.contentHash]) }),
        basisComplete: citations.some(c => c.readProof?.observed === true && c.readProof.basisComplete === true),
        targetEvidence: citations.some(c => hasReviewReadProof(c, ['SOURCE', 'ARTIFACT', 'PROCESS']) && c.readProof.fullFile === true && c.readProof.activationFact === true),
        processEvidence: citations.some(c => hasReviewReadProof(c, ['PROCESS'])),
        ...conditionContext, requiresProcessWindow: requiresConditionWindow(object) };
    try { conditionBinding = validateConditionalAssessment({ assessment: row.conditionAssessment, verdict: row.judgement, context: witnessContext }); }
    catch (error) {
      if (error.code === 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE')
        throw withWitnessReadiness(error, { citations, object, role, assessment: row.conditionAssessment, context: witnessContext });
      throw error;
    }
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
    return unavailable(`Complete basis and actually read ${owners.join("/")} evidence were not established.`,
      witnessContext ? { citations, object, role, assessment: row.conditionAssessment, context: witnessContext } : null,
      proofOwnerReadiness(object, role, citations));
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
  validateProcessClaims({ claims: file.processClaims, citations });
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
