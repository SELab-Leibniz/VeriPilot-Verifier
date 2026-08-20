import { promises as fs } from "node:fs";
import path from "node:path";

import { taskDirectory, withTaskResourceLock, withTaskState } from "./task-store.mjs";
import {
  appendJsonLine,
  atomicWrite,
  atomicWriteJson,
  readJson,
  safeId,
  sha256,
} from "./utils.mjs";


export const GROUND_TRUTH_SCHEMA_VERSION = "runtime-corrector.ground-truth.v2";
export const SKILL_GROUND_TRUTH_SCHEMA_VERSION = "runtime-corrector.skill-ground-truth.v2";

const OPERATIONS = new Set(["ADD", "SUPERSEDE", "RETRACT", "CONFLICT", "RESOLVE"]);
const AUTHORITIES = new Set([
  "USER_EXPLICIT",
  "MATERIAL_DERIVED",
  "PROJECT_CONSTRAINT",
  "AGENT_INFERRED",
  "BASIS_PENDING",
]);
const HARD_AUTHORITIES = new Set([
  "USER_EXPLICIT",
  "MATERIAL_DERIVED",
  "PROJECT_CONSTRAINT",
]);
const AUTHORITY_PRIORITY = new Map([
  ["BASIS_PENDING", 0],
  ["AGENT_INFERRED", 1],
  ["PROJECT_CONSTRAINT", 2],
  ["MATERIAL_DERIVED", 3],
  ["USER_EXPLICIT", 4],
]);
export const GROUND_TRUTH_CATEGORIES = Object.freeze([
  "goals",
  "inScope",
  "outOfScope",
  "requirements",
  "constraints",
  "acceptanceCriteria",
  "testContracts",
  "traceabilityRelations",
  "developmentStandards",
  "milestones",
  "milestoneTargets",
  "criticalJourneys",
  "evidenceObligations",
  "decisions",
  "rejectedAlternatives",
  "workflowSteps",
  "experienceRules",
  "capabilityChecklist",
  "openQuestions",
]);
const CATEGORIES = new Set(GROUND_TRUTH_CATEGORIES);


function groundTruthDirectory(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), "ground-truth");
}


export function currentGroundTruthPath(projectRoot, taskId) {
  return path.join(groundTruthDirectory(projectRoot, taskId), "current.json");
}


function emptyGroundTruth(taskId) {
  return {
    schemaVersion: GROUND_TRUTH_SCHEMA_VERSION,
    taskId,
    version: 0,
    digest: sha256([]),
    updatedAt: null,
    frozenAtVersion: null,
    claims: [],
  };
}


export async function loadCurrentGroundTruth(projectRoot, taskId) {
  return await readJson(currentGroundTruthPath(projectRoot, taskId)) ?? emptyGroundTruth(taskId);
}


function normalizeSource(source, evidenceCapture) {
  const normalized = source && typeof source === "object" ? { ...source } : {};
  if (evidenceCapture === "references-only") delete normalized.excerpt;
  if (evidenceCapture !== "full" && typeof normalized.excerpt === "string") {
    normalized.excerpt = normalized.excerpt.slice(0, 800);
  }
  for (const key of ["secret", "token", "credential", "password"]) delete normalized[key];
  return normalized;
}


function normalizeCapability(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim().toLowerCase();
  if (!name) return null;
  return {
    name,
    module: raw.module ? String(raw.module).trim() : null,
    sourceHint: raw.sourceHint ? String(raw.sourceHint).trim() : null,
    catalogUnmatched: raw.catalogUnmatched === true,
  };
}


function normalizeClaim(raw, operation, evidenceCapture, existing = null) {
  const text = String(raw.text ?? existing?.text ?? "").trim();
  if (!text && !new Set(["RETRACT", "CONFLICT"]).has(operation)) {
    throw new Error(`${operation} Ground Truth operation requires claim.text.`);
  }
  const category = raw.category ?? existing?.category ?? "requirements";
  if (!CATEGORIES.has(category)) throw new Error(`Unsupported Ground Truth category: ${category}`);
  const authority = AUTHORITIES.has(raw.authority) ? raw.authority : "AGENT_INFERRED";
  let severity = raw.severity === "HARD" ? "HARD" : "SOFT";
  if (!HARD_AUTHORITIES.has(authority)) severity = "SOFT";
  const claimId = raw.claimId
    ?? existing?.claimId
    ?? `${category}-${sha256({ text, authority, source: raw.source }).slice(0, 16)}`;
  const revision = (existing?.revision ?? 0) + 1;
  return {
    claimId,
    revision,
    revisionId: `${claimId}@${revision}`,
    category,
    text,
    authority,
    severity,
    status: operation === "RETRACT"
      ? "RETRACTED"
      : operation === "CONFLICT"
        ? "CONFLICTED"
        : "ACTIVE",
    effectiveFromCursor: raw.effectiveFromCursor ?? existing?.effectiveFromCursor ?? null,
    applicability: raw.applicability ?? existing?.applicability ?? "CURRENT_TASK",
    // Stamped by the onboarding panel merge, never by the reviewer schema
    // (which rejects unknown properties): a majority of independent extractor
    // passes agreed on this claim. Sticky across revisions.
    panelConfirmed: raw.panelConfirmed === true || existing?.panelConfirmed === true,
    ...(category === "capabilityChecklist"
      ? { capability: normalizeCapability(raw.capability ?? existing?.capability) }
      : {}),
    source: normalizeSource(raw.source ?? existing?.source, evidenceCapture),
    ...(existing ? { supersedesRevisionId: existing.revisionId } : {}),
  };
}


function renderGroundTruthMarkdown(document) {
  const lines = [
    "# Runtime Corrector Ground Truth",
    "",
    `- Task: \`${document.taskId}\``,
    `- Version: \`${document.version}\``,
    `- Digest: \`${document.digest}\``,
    ...(document.frozenAtVersion != null ? [`- Frozen at version: \`${document.frozenAtVersion}\``] : []),
    "",
  ];
  const categories = [...new Set(document.claims.map((claim) => claim.category))];
  for (const category of categories) {
    lines.push(`## ${category}`, "");
    for (const claim of document.claims.filter((item) => item.category === category)) {
      lines.push(
        `- **${claim.claimId}** [${claim.status}/${claim.severity}/${claim.authority}] ${claim.text || "(no value yet)"}`,
      );
      if (claim.capability?.name) {
        lines.push(`  - Capability: ${claim.capability.name} \u2192 ${claim.capability.module ?? "(unresolved)"}${claim.capability.catalogUnmatched ? " [catalogUnmatched]" : ""}`);
      }
      if (claim.source?.ref) lines.push(`  - Source: \`${claim.source.ref}\``);
      if (claim.source?.excerpt) lines.push(`  - Evidence: ${claim.source.excerpt}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}


async function applyGroundTruthDeltaLocked({
  projectRoot,
  taskId,
  delta,
  evidenceCapture = "minimal",
  hookEventId = null,
}) {
  const current = await loadCurrentGroundTruth(projectRoot, taskId);
  const frozen = current.frozenAtVersion != null;
  const claims = new Map(current.claims.map((claim) => [claim.claimId, claim]));
  const accepted = [];
  const droppedPostFreeze = [];
  let hardChanged = false;
  for (const raw of delta?.operations ?? []) {
    const operation = String(raw.operation ?? raw.op ?? "").toUpperCase();
    if (!OPERATIONS.has(operation)) throw new Error(`Unsupported Ground Truth operation: ${operation}`);
    const incomingAuthority = AUTHORITIES.has(raw.authority) ? raw.authority : "AGENT_INFERRED";
    // A frozen ledger accepts USER_EXPLICIT operations only: new real user
    // messages can still supersede the baseline; agent inference cannot.
    // Dropping (not throwing) keeps the post-freeze incremental extractor
    // fail-soft; the caller journals the dropped operations.
    if (frozen && incomingAuthority !== "USER_EXPLICIT") {
      droppedPostFreeze.push({
        operation,
        claimId: raw.claimId ?? null,
        category: raw.category ?? null,
        authority: incomingAuthority,
      });
      continue;
    }
    const existing = raw.claimId ? claims.get(raw.claimId) : null;
    if (operation === "ADD" && existing) {
      throw new Error(`ADD cannot replace an existing Ground Truth claim: ${raw.claimId}`);
    }
    if (operation !== "ADD" && !existing) {
      throw new Error(`${operation} references an unknown Ground Truth claim: ${raw.claimId}`);
    }
    if (existing && AUTHORITY_PRIORITY.get(incomingAuthority) < AUTHORITY_PRIORITY.get(existing.authority)) {
      throw new Error(
        `${incomingAuthority} cannot ${operation.toLowerCase()} higher-authority Ground Truth ${existing.claimId} (${existing.authority}).`,
      );
    }
    const normalized = normalizeClaim(raw, operation, evidenceCapture, existing);
    claims.set(normalized.claimId, normalized);
    accepted.push({ operation, claim: normalized });
    if ((normalized.severity === "HARD" || existing?.severity === "HARD") && (
      operation !== "CONFLICT" || normalized.authority === "USER_EXPLICIT"
    )) hardChanged = true;
  }
  if (accepted.length === 0) {
    try {
      await fs.access(currentGroundTruthPath(projectRoot, taskId));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const directory = groundTruthDirectory(projectRoot, taskId);
      await atomicWriteJson(path.join(directory, "current.json"), current);
      await atomicWrite(path.join(directory, "current.md"), renderGroundTruthMarkdown(current));
      await withTaskState({ projectRoot, taskId }, (state) => {
        state.groundTruth.version = current.version;
        state.groundTruth.digest = current.digest;
      });
    }
    return { changed: false, hardChanged: false, current, droppedPostFreeze };
  }
  const updatedAt = new Date().toISOString();
  const nextClaims = [...claims.values()].sort((left, right) => (
    left.category.localeCompare(right.category) || left.claimId.localeCompare(right.claimId)
  ));
  const version = current.version + 1;
  const next = {
    schemaVersion: GROUND_TRUTH_SCHEMA_VERSION,
    taskId,
    version,
    digest: sha256(nextClaims),
    updatedAt,
    frozenAtVersion: current.frozenAtVersion ?? null,
    claims: nextClaims,
  };
  const directory = groundTruthDirectory(projectRoot, taskId);
  for (const item of accepted) {
    await appendJsonLine(path.join(directory, "history.jsonl"), {
      schemaVersion: "runtime-corrector.ground-truth-event.v2",
      eventId: `${taskId}-gt-${version}-${accepted.indexOf(item) + 1}`,
      taskId,
      version,
      hookEventId,
      recordedAt: updatedAt,
      operation: item.operation,
      claim: item.claim,
    });
  }
  await atomicWriteJson(path.join(directory, "current.json"), next);
  await atomicWrite(path.join(directory, "current.md"), renderGroundTruthMarkdown(next));
  await withTaskState({ projectRoot, taskId }, (state) => {
    state.groundTruth.version = next.version;
    state.groundTruth.digest = next.digest;
  });
  return { changed: true, hardChanged, current: next, accepted, droppedPostFreeze };
}


export async function applyGroundTruthDelta(options) {
  return withTaskResourceLock({
    projectRoot: options.projectRoot,
    taskId: options.taskId,
    resource: "ground-truth",
  }, () => applyGroundTruthDeltaLocked(options));
}


/**
 * Freeze the Ground Truth ledger after onboarding adjudication. A frozen
 * ledger accepts only USER_EXPLICIT operations (see applyGroundTruthDelta):
 * reviews thereafter run against the frozen baseline plus user-explicit
 * deltas. The caller (onboarding) refuses to freeze an empty ledger.
 */
export async function freezeGroundTruth({
  projectRoot,
  taskId,
  hookEventId = null,
  reason = "ONBOARDING_ADJUDICATED",
}) {
  return withTaskResourceLock({ projectRoot, taskId, resource: "ground-truth" }, async () => {
    const current = await loadCurrentGroundTruth(projectRoot, taskId);
    if (current.frozenAtVersion != null) return { changed: false, current };
    const updatedAt = new Date().toISOString();
    const next = { ...current, frozenAtVersion: current.version, updatedAt };
    const directory = groundTruthDirectory(projectRoot, taskId);
    await appendJsonLine(path.join(directory, "history.jsonl"), {
      schemaVersion: "runtime-corrector.ground-truth-event.v2",
      eventId: `${taskId}-gt-freeze-${current.version}`,
      taskId,
      version: current.version,
      hookEventId,
      recordedAt: updatedAt,
      operation: "FREEZE",
      reason,
    });
    await atomicWriteJson(path.join(directory, "current.json"), next);
    await atomicWrite(path.join(directory, "current.md"), renderGroundTruthMarkdown(next));
    await withTaskState({ projectRoot, taskId }, (state) => {
      state.groundTruth.frozenAtVersion = next.frozenAtVersion;
    });
    return { changed: true, current: next };
  });
}


function renderSkillMarkdown(document) {
  const lines = [
    `# Skill Ground Truth: ${document.skillId}`,
    "",
    `- Task: \`${document.taskId}\``,
    `- Version: \`${document.version}\``,
    `- Skill digest: \`${document.skillDigest ?? "unknown"}\``,
    "",
    "## Constraints",
    "",
  ];
  for (const constraint of document.constraints) {
    lines.push(`- **${constraint.constraintId}** [${constraint.modality}/${constraint.kind}] ${constraint.statement}`);
    if (constraint.condition) lines.push(`  - Condition: ${constraint.condition}`);
    if (constraint.dependsOn?.length) lines.push(`  - Depends on: ${constraint.dependsOn.join(", ")}`);
    if (constraint.sourceRef) lines.push(`  - Source: \`${constraint.sourceRef}\``);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}


export async function persistSkillGroundTruth({
  projectRoot,
  taskId,
  skillId,
  skillDigest,
  constraints = [],
  taskOverlays = [],
}) {
  const directory = path.join(taskDirectory(projectRoot, taskId), "skills", safeId(skillId));
  const previous = await readJson(path.join(directory, "skill-ground-truth.json"));
  const normalized = constraints.map((constraint, index) => {
    const statement = String(constraint.statement ?? "").trim();
    if (!statement) throw new Error("Skill Ground Truth constraints require statement.");
    const modality = new Set(["MUST", "SHOULD", "MAY", "PROHIBITED"])
      .has(constraint.modality) ? constraint.modality : "SHOULD";
    return {
      constraintId: constraint.constraintId
        ?? `skill-${sha256({ skillId, statement, index }).slice(0, 16)}`,
      kind: constraint.kind ?? "STEP",
      modality,
      statement,
      condition: constraint.condition ?? null,
      dependsOn: [...(constraint.dependsOn ?? [])],
      inputs: [...(constraint.inputs ?? [])],
      outputs: [...(constraint.outputs ?? [])],
      sourceRef: constraint.sourceRef ?? null,
    };
  });
  const document = {
    schemaVersion: SKILL_GROUND_TRUTH_SCHEMA_VERSION,
    taskId,
    skillId,
    version: (previous?.version ?? 0) + 1,
    skillDigest,
    updatedAt: new Date().toISOString(),
    constraints: normalized,
    taskOverlays,
    digest: sha256({ skillId, skillDigest, constraints: normalized, taskOverlays }),
  };
  await fs.mkdir(directory, { recursive: true });
  await appendJsonLine(path.join(directory, "history.jsonl"), document);
  await atomicWriteJson(path.join(directory, "skill-ground-truth.json"), document);
  await atomicWrite(path.join(directory, "skill-ground-truth.md"), renderSkillMarkdown(document));
  return { document, directory };
}
