import { readFileSync } from "node:fs";
import path from "node:path";

import { taskDirectory, withTaskState } from "./task-store.mjs";
import { atomicWriteJson, safeId, sha256 } from "./utils.mjs";


const ROOT_CAUSE_CATALOG_SCHEMA_VERSION = "runtime-corrector.root-cause-catalog.v1";
const ROOT_CAUSE_CATALOG_URL = new URL("../../config/root-cause-catalog.v1.json", import.meta.url);


function loadRootCauseIds() {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(ROOT_CAUSE_CATALOG_URL, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Unable to read the frozen Root Cause catalog: ${error.message}`, { cause: error });
  }
  if (catalog?.schemaVersion !== ROOT_CAUSE_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Root Cause catalog schemaVersion must be ${ROOT_CAUSE_CATALOG_SCHEMA_VERSION}.`);
  }
  if (catalog.status !== "FROZEN") {
    throw new Error("Root Cause catalog status must be FROZEN.");
  }
  if (!Array.isArray(catalog.rootCauses)) {
    throw new Error("Root Cause catalog rootCauses must be an array.");
  }
  const ids = catalog.rootCauses.map((rootCause, index) => {
    if (!rootCause || typeof rootCause !== "object" || Array.isArray(rootCause)
      || typeof rootCause.id !== "string" || rootCause.id.trim().length === 0) {
      throw new Error(`Root Cause catalog rootCauses[${index}].id must be a non-empty string.`);
    }
    return rootCause.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Root Cause catalog IDs must be unique.");
  }
  if (!ids.includes("OTHER")) {
    throw new Error("Root Cause catalog must include the fallback ID OTHER.");
  }
  return ids;
}


export const ROOT_CAUSE_IDS = new Set(loadRootCauseIds());


function normalizedFinding(finding) {
  return {
    deviationKey: finding.deviationKey ?? sha256({
      rootCauseId: finding.rootCauseId,
      expectedConstraint: finding.expectedConstraint,
      violatedGroundTruthIds: finding.violatedGroundTruthIds,
    }).slice(0, 24),
    rootCauseId: ROOT_CAUSE_IDS.has(finding.rootCauseId) ? finding.rootCauseId : "OTHER",
    severity: finding.severity ?? "warning",
    reason: finding.reason ?? "No reviewer reason supplied.",
    actualEvidence: [...(finding.actualEvidence ?? finding.evidence ?? [])],
    expectedConstraint: finding.expectedConstraint ?? "See the frozen Ground Truth object.",
    violatedGroundTruthIds: [...(finding.violatedGroundTruthIds ?? [])],
    suggestedNextAction: finding.suggestedNextAction ?? null,
  };
}


export async function dismissInformationalFamilies({ projectRoot, taskId }) {
  const dismissed = await withTaskState({ projectRoot, taskId }, (state) => {
    const changed = [];
    for (const deviation of Object.values(state.deviations)) {
      const severities = (deviation.observations ?? [])
        .map((observation) => observation.finding?.severity)
        .filter(Boolean);
      if (deviation.status === "OPEN" && severities.length > 0
        && severities.every((severity) => severity === "info")) {
        deviation.status = "DISMISSED";
        deviation.dismissedAt = new Date().toISOString();
        deviation.dismissalReason = "Informational reviewer observations are not deviations.";
        changed.push(JSON.parse(JSON.stringify(deviation)));
      }
    }
    return changed;
  });
  for (const family of dismissed) {
    await atomicWriteJson(
      path.join(taskDirectory(projectRoot, taskId), "feedback", `${safeId(family.familyId)}.json`),
      family,
    );
  }
  return dismissed;
}


export async function recordDeviationFindings({
  projectRoot,
  taskId,
  pipeline,
  findings,
  groundTruthVersion,
  targetSnapshotHash = null,
  evaluationId = null,
  // Whether findings were actually surfaced to the developer (false in
  // observe-only mode). Stamped per observation so closure attribution can
  // distinguish corrector-caused fixes (delivered, fix after delivery) from
  // developer self-fixes — without this, self-debugging during an
  // observe-only run would be credited to the corrector.
  delivered = false,
}) {
  const observations = [];
  await dismissInformationalFamilies({ projectRoot, taskId });
  await withTaskState({ projectRoot, taskId }, (state) => {
    // Assistant-turn counter maintained by reconcileTurnState on every hook
    // event; monotonically non-decreasing because transcript keys are only
    // ever added. Latency analysis reads this stamp per observation.
    const turnIndex = state.turns?.assistantKeys?.length ?? null;
    for (const raw of findings) {
      const finding = normalizedFinding(raw);
      if (finding.severity === "info") continue;
      const familyId = sha256({
        taskId,
        deviationKey: finding.deviationKey,
        rootCauseId: finding.rootCauseId,
        violatedGroundTruthIds: finding.violatedGroundTruthIds,
      }).slice(0, 24);
      const previous = state.deviations[familyId];
      const recordedAt = new Date().toISOString();
      const observation = {
        observationId: `${familyId}-${(previous?.observations?.length ?? 0) + 1}`,
        pipeline,
        evaluationId,
        groundTruthVersion,
        targetSnapshotHash,
        recordedAt,
        turnIndex,
        delivered: delivered === true,
        deliveredAt: delivered === true ? recordedAt : null,
        finding,
      };
      state.deviations[familyId] = {
        familyId,
        status: previous?.status === "FIXED" ? "OPEN" : previous?.status ?? "OPEN",
        firstSeenAt: previous?.firstSeenAt ?? observation.recordedAt,
        lastSeenAt: observation.recordedAt,
        pipelines: [...new Set([...(previous?.pipelines ?? []), pipeline])],
        observations: [...(previous?.observations ?? []), observation],
      };
      observations.push(state.deviations[familyId]);
    }
  });
  for (const family of observations) {
    await atomicWriteJson(
      path.join(taskDirectory(projectRoot, taskId), "feedback", `${safeId(family.familyId)}.json`),
      family,
    );
  }
  return observations;
}


export async function markMetricPassesFixed({ projectRoot, taskId, passedObjectIds }) {
  const passed = new Set(passedObjectIds);
  const families = await withTaskState({ projectRoot, taskId }, (state) => {
    const fixed = [];
    for (const deviation of Object.values(state.deviations)) {
      const ids = deviation.observations.at(-1)?.finding?.violatedGroundTruthIds ?? [];
      if (ids.length > 0 && ids.every((id) => passed.has(id))) {
        deviation.status = "FIXED";
        deviation.fixedAt = new Date().toISOString();
        fixed.push(JSON.parse(JSON.stringify(deviation)));
      }
    }
    return fixed;
  });
  for (const family of families) {
    await atomicWriteJson(
      path.join(taskDirectory(projectRoot, taskId), "feedback", `${safeId(family.familyId)}.json`),
      family,
    );
  }
  return families.map((family) => family.familyId);
}
