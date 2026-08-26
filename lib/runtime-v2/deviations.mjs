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


// A deviation family is the unit the loop bound applies to: the same
// deviationKey + rootCause + violated Ground Truth ids, re-observed across
// turns. Exported so feedback composition can consult the bound without
// duplicating the hash.
export function familyIdForFinding({ taskId, finding }) {
  const normalized = normalizedFinding(finding);
  return sha256({
    taskId,
    deviationKey: normalized.deviationKey,
    rootCauseId: normalized.rootCauseId,
    violatedGroundTruthIds: normalized.violatedGroundTruthIds,
  }).slice(0, 24);
}


// Families whose feedback has ALREADY been delivered `maxDeliveries` times.
// Counting DELIVERED observations (not all observations) is deliberate: an
// observation the corrector recorded but never spoke cannot have caused a
// re-edit, so it must not consume the agent's loop budget. Shadow-mode runs
// therefore never park anything, which keeps the control arm untouched.
export async function loopBoundedFamilyIds({ projectRoot, taskId, maxDeliveries }) {
  const bounded = new Set();
  if (!Number.isFinite(maxDeliveries) || maxDeliveries <= 0) return bounded;
  await withTaskState({ projectRoot, taskId }, (state) => {
    for (const deviation of Object.values(state.deviations ?? {})) {
      if (deviation.status === "FIXED" || deviation.status === "DISMISSED") continue;
      const delivered = (deviation.observations ?? []).filter((o) => o.delivered === true).length;
      if (delivered >= maxDeliveries) bounded.add(deviation.familyId);
    }
  });
  return bounded;
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
  // Per-family feedback loop bound (config: deviationLoop.maxDeliveriesPerFamily).
  // 0/null/undefined disables it, which is what every pre-bound run used.
  maxDeliveriesPerFamily = null,
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
      const familyId = familyIdForFinding({ taskId, finding });
      const previous = state.deviations[familyId];
      const recordedAt = new Date().toISOString();
      // Count only DELIVERED prior observations: one the corrector recorded but
      // never spoke cannot have provoked an edit, so it must not consume budget.
      const priorDeliveries = (previous?.observations ?? [])
        .filter((item) => item.delivered === true).length;
      const bounded = Number.isFinite(maxDeliveriesPerFamily)
        && maxDeliveriesPerFamily > 0
        && priorDeliveries >= maxDeliveriesPerFamily;
      const deliverThis = delivered === true && !bounded;
      const observation = {
        observationId: `${familyId}-${(previous?.observations?.length ?? 0) + 1}`,
        pipeline,
        evaluationId,
        groundTruthVersion,
        targetSnapshotHash,
        recordedAt,
        turnIndex,
        delivered: deliverThis,
        deliveredAt: deliverThis ? recordedAt : null,
        // Why this observation was recorded but not spoken. Distinguishes the
        // loop bound from shadow mode and from per-skill budget suppression.
        suppressedBy: delivered === true && bounded ? "LOOP_BOUND" : null,
        finding,
      };
      state.deviations[familyId] = {
        familyId,
        status: previous?.status === "FIXED" ? "OPEN" : previous?.status ?? "OPEN",
        // A parked family stays OPEN — it is still a real, unresolved deviation
        // and must keep counting in the V-metrics. Only the nagging stops.
        loopBounded: bounded || previous?.loopBounded === true,
        loopBoundedAt: previous?.loopBoundedAt ?? (bounded ? recordedAt : null),
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
