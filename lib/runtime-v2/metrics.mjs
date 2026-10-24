import path from "node:path";

import { taskDirectory } from "./task-store.mjs";
import { rejectedGroundTruthSource } from "./ground-truth-provenance.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";


export const METRIC_CATALOG_VERSION = "vp-m01-m15-v2-proof-owners";

export const METRIC_CATALOG = Object.freeze({
  M01: { name: "Requirement decomposition coverage", earliestPhase: "REQUIREMENTS", source: ["goals", "requirements", "constraints", "inScope", "outOfScope", "criticalJourneys"] },
  M02: { name: "Requirement decomposition qualification", earliestPhase: "REQUIREMENTS", source: ["requirements"] },
  M03: { name: "Test contract coverage", earliestPhase: "TEST_DESIGN", source: ["acceptanceCriteria"] },
  M04: { name: "Test contract qualification", earliestPhase: "TEST_DESIGN", source: ["testContracts"] },
  M05: { name: "Acceptance criteria coverage", earliestPhase: "REQUIREMENTS", source: ["requirements"] },
  M06: { name: "Acceptance criteria qualification", earliestPhase: "REQUIREMENTS", source: ["acceptanceCriteria"] },
  M07: { name: "Requirement-artifact traceability completeness", earliestPhase: "PLANNING", source: ["traceabilityRelations"] },
  M08: { name: "Skill step compliance", earliestPhase: "SKILL_EXECUTION", source: ["skillConstraints"] },
  M09: { name: "Development standard compliance", earliestPhase: "IMPLEMENTATION", source: ["developmentStandards"] },
  M10: { name: "Mandatory experience-rule compliance", earliestPhase: "IMPLEMENTATION", source: ["experienceRules"] },
  M11: { name: "Fixed workflow compliance", earliestPhase: "IMPLEMENTATION", source: ["workflowSteps"] },
  M12: { name: "Requirement execution rate", earliestPhase: "IMPLEMENTATION", source: ["requirements"] },
  M13: { name: "Acceptance closure rate", earliestPhase: "VERIFICATION", source: ["acceptanceCriteria"] },
  M14: { name: "Milestone closure rate", earliestPhase: "VERIFICATION", source: ["milestoneTargets"] },
  M15: { name: "Critical journey pass rate", earliestPhase: "VERIFICATION", source: ["criticalJourneys"] },
});

export const OBJECT_JUDGEMENTS = new Set([
  "PASS",
  "DEVIATION",
  "UNVERIFIED",
  "BASIS_PENDING",
  "EXTERNAL_BLOCKED",
  "NOT_APPLICABLE",
  "NOT_YET_APPLICABLE",
  "NOT_YET_EXECUTED",
  "CHECKER_ERROR",
]);


function metricPopulationPath(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), "metrics", "population.json");
}


function hardClaim(claim) {
  return claim.severity === "HARD"
    && new Set(["USER_EXPLICIT", "MATERIAL_DERIVED", "PROJECT_CONSTRAINT"]).has(claim.authority);
}


function claimObject(metricId, claim) {
  return {
    objectId: `${metricId}:${claim.claimId}`,
    metricId,
    sourceId: claim.claimId,
    sourceRevisionId: claim.revisionId,
    description: claim.text,
    authority: claim.authority,
    hard: hardClaim(claim),
    evidenceRequired: claim.category === "evidenceObligations"
      || new Set(["M12", "M13", "M14", "M15"]).has(metricId),
    applicability: claim.applicability,
    ...(Object.hasOwn(claim, "applicabilityKind") ? { applicabilityKind: claim.applicabilityKind } : {}),
    ...(claim.verificationTarget ? { verificationTarget: claim.verificationTarget } : {}),
  };
}


function skillObjects(skillDocuments) {
  const objects = [];
  for (const document of skillDocuments) {
    for (const constraint of document.constraints ?? []) {
      if (!new Set(["MUST", "PROHIBITED"]).has(constraint.modality)) continue;
      objects.push({
        objectId: `M08:${document.skillId}:${constraint.constraintId}`,
        metricId: "M08",
        sourceId: `${document.skillId}:${constraint.constraintId}`,
        sourceRevisionId: `${document.skillId}@${document.version}`,
        description: constraint.statement,
        authority: "MATERIAL_DERIVED",
        hard: true,
        evidenceRequired: true,
        applicability: constraint.condition ?? "CURRENT_TASK",
        ...(Object.hasOwn(constraint, "applicabilityKind") ? { applicabilityKind: constraint.applicabilityKind } : {}),
        skillId: document.skillId,
        modality: constraint.modality,
        kind: constraint.kind,
        sourceRef: constraint.sourceRef ?? null,
      });
    }
  }
  return objects;
}


export function isSourceOnlyDelivery(artifacts) {
  return Array.isArray(artifacts) && artifacts.length > 0 && artifacts.every(artifact => {
    const paths = [...(artifact.patterns ?? []), ...(artifact.pathTemplates ?? [])];
    return /^(?:implementation|coding|code|development)$/iu.test(artifact.stage ?? "") && paths.length > 0
      && paths.every(file => typeof file === "string" && /\.(?:py|[cm]?js|tsx?|ets|java|kt|rs|go|c|cpp|h|hpp|cs|swift|rb|php|lua)$/iu.test(file));
  });
}

export async function buildMetricPopulation({ projectRoot, taskId, groundTruth, skillDocuments = [], artifactMetricIds = null, sourceOnlyDelivery = false }) {
  // Existing ledgers are never rewritten, but known internal-role claims
  // from older versions must not contaminate newly computed populations.
  const activeClaims = (groundTruth.claims ?? []).filter((claim) => claim.status === "ACTIVE" && !rejectedGroundTruthSource(claim));
  const metrics = {};
  for (const [metricId, specification] of Object.entries(METRIC_CATALOG)) {
    metrics[metricId] = specification.source.includes("skillConstraints")
      ? skillObjects(skillDocuments)
      : activeClaims
        .filter((claim) => specification.source.includes(claim.category))
        .map((claim) => claimObject(metricId, claim));
  }
  // Categories describe where an obligation came from, not its proof owner.
  // PROCESS constraints/goals must not disappear into document coverage only.
  const processOwned = new Set(["M08", "M09", "M10", "M11", "M12", "M13", "M14", "M15"]
    .flatMap(id => metrics[id]).filter(object => object.verificationTarget === "PROCESS").map(object => object.sourceId));
  metrics.M11.push(...activeClaims.filter(claim => claim.verificationTarget === "PROCESS"
    && !processOwned.has(claim.claimId)).map(claim => claimObject("M11", claim)));
  const mandatory = activeClaims.filter(hardClaim);
  const sourceOnly = sourceOnlyDelivery && Array.isArray(artifactMetricIds) && !artifactMetricIds.some(id => /^M0[1-7]$/u.test(id))
    && mandatory.length > 0 && mandatory.every(claim => ["IMPLEMENTATION", "PROCESS"].includes(claim.verificationTarget))
    && !activeClaims.some(claim => claim.verificationTarget === "ARTIFACT");
  if (sourceOnly) {
    // Every source-owned obligation still needs a fulfillment check; dropping
    // an inapplicable document view must not drop the underlying condition.
    const fulfilled = new Set(["M09", "M10", "M12", "M13", "M14", "M15"].flatMap(id => metrics[id])
      .filter(object => object.verificationTarget === "IMPLEMENTATION").map(object => object.sourceId));
    metrics.M12.push(...mandatory.filter(claim => claim.verificationTarget === "IMPLEMENTATION"
      && !fulfilled.has(claim.claimId)).map(claim => claimObject("M12", claim)));
    for (const id of Object.keys(metrics).filter(id => /^M0[1-7]$/u.test(id))) metrics[id] = [];
  }
  const digest = sha256({ catalogVersion: METRIC_CATALOG_VERSION, metrics });
  const previous = await readJson(metricPopulationPath(projectRoot, taskId));
  if (previous?.digest === digest && previous.groundTruthVersion === groundTruth.version) return previous;
  const population = {
    schemaVersion: "runtime-corrector.metric-population.v2",
    catalogVersion: METRIC_CATALOG_VERSION,
    taskId,
    version: (previous?.version ?? 0) + 1,
    groundTruthVersion: groundTruth.version,
    createdAt: new Date().toISOString(),
    digest,
    metricCatalog: Object.fromEntries(Object.entries(METRIC_CATALOG).map(([metricId, specification]) => [
      metricId,
      { name: specification.name, earliestPhase: specification.earliestPhase,
        ...(sourceOnly && /^M0[1-7]$/u.test(metricId) ? { applicability: "NOT_APPLICABLE",
          reasonCode: "NO_ARTIFACT_OBLIGATIONS", basis: mandatory.map(claim => claim.claimId) } : {}) },
    ])),
    metrics,
  };
  await atomicWriteJson(metricPopulationPath(projectRoot, taskId), population);
  return population;
}


function aggregateMetric(metricId, objects, judgementById) {
  const evaluated = objects.map((object) => {
    const judgement = judgementById.get(object.objectId) ?? {
      objectId: object.objectId,
      judgement: "CHECKER_ERROR",
      reason: "Reviewer omitted this population object.",
      evidence: [],
    };
    return { ...object, ...judgement };
  });
  const eligible = evaluated.filter((item) => !new Set([
    "BASIS_PENDING",
    "NOT_APPLICABLE",
    "NOT_YET_APPLICABLE",
    "NOT_YET_EXECUTED",
  ]).has(item.judgement));
  let status;
  if (eligible.some((item) => item.judgement === "CHECKER_ERROR")) status = "CHECKER_ERROR";
  else if (eligible.some((item) => new Set(["UNVERIFIED", "EXTERNAL_BLOCKED"]).has(item.judgement))) status = "UNVERIFIED";
  else if (eligible.length === 0) status = objects.length === 0 ? "NOT_COMPUTABLE" : "NOT_APPLICABLE";
  else status = "MEASURED";
  const numerator = eligible.filter((item) => item.judgement === "PASS").length;
  const denominator = eligible.length;
  return {
    metricId,
    name: METRIC_CATALOG[metricId].name,
    status,
    numerator,
    denominator,
    value: status === "MEASURED" ? numerator / denominator : null,
    objects: evaluated,
  };
}


export function calculateMetricReport({ population, judgements = [], metricIds = null }) {
  const allowedMetricIds = metricIds?.length ? metricIds : Object.keys(METRIC_CATALOG);
  const expected = new Set(allowedMetricIds.flatMap(
    (metricId) => (population.metrics[metricId] ?? []).map((item) => item.objectId),
  ));
  const judgementById = new Map();
  const checkerIssues = [];
  for (const judgement of judgements) {
    if (!expected.has(judgement.objectId)) {
      checkerIssues.push({
        type: "UNKNOWN_OBJECT",
        objectId: judgement.objectId,
        message: `Reviewer returned an object outside the frozen population: ${judgement.objectId}`,
      });
      continue;
    }
    if (judgementById.has(judgement.objectId)) {
      checkerIssues.push({
        type: "DUPLICATE_OBJECT",
        objectId: judgement.objectId,
        message: `Reviewer returned a duplicate metric judgement: ${judgement.objectId}`,
      });
      judgementById.set(judgement.objectId, {
        objectId: judgement.objectId,
        judgement: "CHECKER_ERROR",
        reason: "Reviewer returned duplicate judgements for this frozen population object.",
        evidence: [],
      });
      continue;
    }
    if (!OBJECT_JUDGEMENTS.has(judgement.judgement)) {
      checkerIssues.push({
        type: "UNSUPPORTED_JUDGEMENT",
        objectId: judgement.objectId,
        message: `Unsupported metric judgement: ${judgement.judgement}`,
      });
      judgementById.set(judgement.objectId, {
        objectId: judgement.objectId,
        judgement: "CHECKER_ERROR",
        reason: `Reviewer returned unsupported judgement ${judgement.judgement}.`,
        evidence: [],
      });
      continue;
    }
    judgementById.set(judgement.objectId, judgement);
  }
  const metrics = allowedMetricIds.map((metricId) => aggregateMetric(
    metricId,
    population.metrics[metricId] ?? [],
    judgementById,
  ));
  const blockingObjects = metrics.flatMap((metric) => metric.objects.filter((object) => (
    object.judgement === "DEVIATION" && object.hard
  ) || (
    new Set(["UNVERIFIED", "EXTERNAL_BLOCKED"]).has(object.judgement)
      && object.hard
      && object.evidenceRequired
  )));
  return {
    schemaVersion: "runtime-corrector.metric-report.v2",
    catalogVersion: population.catalogVersion,
    populationVersion: population.version,
    groundTruthVersion: population.groundTruthVersion,
    calculatedAt: new Date().toISOString(),
    metrics,
    blockingObjects,
    checkerIssues,
    status: checkerIssues.length > 0 || metrics.some((metric) => metric.status === "CHECKER_ERROR")
      ? "CHECKER_ERROR"
      : blockingObjects.length > 0
        ? "DEVIATION"
        : metrics.some((metric) => metric.status === "UNVERIFIED")
          ? "UNVERIFIED"
          : "PASS",
  };
}
