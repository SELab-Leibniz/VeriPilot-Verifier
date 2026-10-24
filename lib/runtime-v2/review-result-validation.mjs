// One shared acceptance boundary for SDK, native and CLI review results.
// readProof is transport-owned metadata on a checked source citation, never a
// model field. It proves disclosure and scope, not the truth of a diagnosis.
export const EXCLUDING_REVIEW_VERDICTS = new Set([
  "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING",
]);

/** Match the existing Stop adapter's proof scopes, including document tasks. */
export function reviewProofOwners(object, role = "stop-reviewer") {
  if (role === "implementation-reviewer") return ["SOURCE"];
  const metric = object?.metricId;
  if (metric === "M16") return ["SOURCE"];
  if (["M08", "M11"].includes(metric)) return ["PROCESS"];
  if (["M13", "M14", "M15"].includes(metric))
    return object.verificationTarget === "ARTIFACT" ? ["ARTIFACT", "PROCESS"] : ["PROCESS"];
  if (["M09", "M10", "M12"].includes(metric)) {
    if (object.verificationTarget === "PROCESS") return ["PROCESS"];
    if (object.verificationTarget === "IMPLEMENTATION") return metric === "M12" ? ["PROCESS"] : ["SOURCE"];
    return metric === "M12" ? ["ARTIFACT", "PROCESS"] : ["ARTIFACT"];
  }
  return ["ARTIFACT"];
}

export function hasReviewReadProof(citation, owners) {
  const proof = citation?.readProof;
  return proof?.version === 1 && proof.observed === true && proof.basisComplete === true
    && owners.includes(proof.owner);
}

function unavailable(cause) {
  throw Object.assign(new Error(cause), { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
}

// This is a checker failure, not a business UNVERIFIED judgement. The collector
// preserves valid siblings and keeps this item incomplete so k is not spent.
export function validateReviewJudgement({ row, object, citations = [], role = "stop-reviewer", classification = null }) {
  if (!["PASS", "DEVIATION"].includes(row.judgement) && !EXCLUDING_REVIEW_VERDICTS.has(row.judgement)) return row;
  if (!citations.length) return unavailable("No checked original evidence supports this judgement.");
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
  return citations.some(citation => hasReviewReadProof(citation, owners)) ? row
    : unavailable(`Complete basis and actually read ${owners.join("/")} evidence were not established.`);
}

export function validateReviewFile({ file, citations = [] }) {
  if (!["PASS", "DEVIATION"].includes(file.status)) return file;
  if (citations.some(citation => hasReviewReadProof(citation, ["ARTIFACT", "SOURCE"]))) return file;
  return unavailable("Complete basis and actually read delivery-file evidence were not established.");
}

/** A finding owns claims; one claim can project to several metric questions. */
export function validateReviewFinding({ finding, objects = [], citations = [], role = "stop-reviewer", classification = null }) {
  for (const id of finding.violatedGroundTruthIds ?? []) {
    const candidates = objects.filter(object => object.sourceId === id);
    if (!candidates.length) throw Object.assign(new Error("A finding references a claim outside its evidence ownership."),
      { code: "REVIEW_ITEM_OWNERSHIP_INVALID" });
    let established = false, lastError;
    for (const object of candidates) {
      try { validateReviewJudgement({ row: { judgement: "DEVIATION" }, object, citations, role, classification }); established = true; break; }
      catch (error) { if (error.code !== "REVIEW_ITEM_EVIDENCE_UNAVAILABLE") throw error; lastError = error; }
    }
    if (!established) throw lastError;
  }
  return finding;
}
