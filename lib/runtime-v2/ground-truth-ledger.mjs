import { promises as fs } from "node:fs";
import path from "node:path";

import { VERIFICATION_TARGETS } from "./review-routing.mjs";
import { rejectedGroundTruthSource } from "./ground-truth-provenance.mjs";
import { normalizeExpectedFiles } from './expected-files.mjs';

import { appendTaskJournal, taskDirectory, withTaskResourceLock, withTaskState, withTaskDecision, decisionGuard } from "./task-store.mjs";
import { scopedDecision } from './decision-scope.mjs';
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
export const APPLICABILITY_KINDS = Object.freeze(["CURRENT_TASK", "CONDITIONAL", "FUTURE", "UNKNOWN"]);
const applicabilityKinds = new Set(APPLICABILITY_KINDS);

// A legacy update may have changed the obligation's meaning. Never inherit
// an earlier kind when the new operation omitted that explicit metadata.
function applicabilityMetadata(value) {
  if (!Object.hasOwn(value, "applicabilityKind")) return {};
  if (!applicabilityKinds.has(value.applicabilityKind)) throw new Error("Unsupported applicabilityKind.");
  return { applicabilityKind: value.applicabilityKind };
}


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
  // An admitted ambiguity can never be a hard obligation, whatever authority
  // proposed it — otherwise a task could block on its own open question.
  if (category === "openQuestions") severity = "SOFT";
  const applicability = raw.applicability ?? existing?.applicability ?? "CURRENT_TASK";
  const machineApplicability = applicabilityMetadata(raw);
  const verificationTarget = (raw.verificationTarget ?? existing?.verificationTarget)
    ? VERIFICATION_TARGETS.includes(raw.verificationTarget) ? raw.verificationTarget : existing?.verificationTarget ?? null
    : undefined;
  const implementationRole = raw.implementationRole
    ?? (['ARTIFACT', 'PROCESS'].includes(verificationTarget) ? undefined : existing?.implementationRole);
  const expectedFiles = raw.expectedFiles !== undefined || existing?.expectedFiles
    ? normalizeExpectedFiles(raw.expectedFiles !== undefined ? raw.expectedFiles
      : existing.expectedFiles.filter(file => text.replaceAll('\\', '/').includes(file)), text)
    : undefined;
  const capability = category === "capabilityChecklist" ? normalizeCapability(raw.capability ?? existing?.capability) : undefined;
  // One original paragraph can legitimately own different proof scopes. Do
  // not let an inferred ADD ID erase PROCESS with IMPLEMENTATION, a condition,
  // a test-only role, or different explicit deliveries. Existing IDs remain
  // stable, and semantic duplicates are still recognized before insertion.
  const identityScope = { severity, applicability, ...machineApplicability,
    verificationTarget: verificationTarget ?? null, implementationRole: implementationRole ?? null,
    expectedFiles: expectedFiles ?? [], ...(capability ? { capability } : {}) };
  const claimId = raw.claimId
    ?? existing?.claimId
    ?? `${category}-${sha256({ text, authority, source: raw.source, scope: identityScope }).slice(0, 16)}`;
  const revision = (existing?.revision ?? 0) + 1;
  return {
    claimId,
    revision,
    revisionId: `${claimId}@${revision}`,
    category,
    text,
    ...(expectedFiles !== undefined ? { expectedFiles } : {}),
    authority,
    severity,
    status: operation === "RETRACT"
      ? "RETRACTED"
      : operation === "CONFLICT"
        ? "CONFLICTED"
        : "ACTIVE",
    effectiveFromCursor: raw.effectiveFromCursor ?? existing?.effectiveFromCursor ?? null,
    applicability,
    ...machineApplicability,
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    // Stamped by the onboarding panel merge, never by the reviewer schema
    // (which rejects unknown properties): a majority of independent extractor
    // passes agreed on this claim. Sticky across revisions.
    panelConfirmed: raw.panelConfirmed === true || existing?.panelConfirmed === true,
    ...(capability ? { capability } : {}),
    source: normalizeSource(raw.source ?? existing?.source, evidenceCapture),
    ...(implementationRole ? { implementationRole } : {}),
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


// The same side-effect-free normalization/authority/duplicate rules feed review and apply.
export function groundTruthPlanDigest(plan) {
  const { updatedAt, ...current } = plan.current;
  return sha256({ expectedVersion: plan.expectedVersion, expectedDigest: plan.expectedDigest,
    changed: plan.changed, hardChanged: plan.hardChanged, current, accepted: plan.accepted ?? [],
    operationDispositions: plan.operationDispositions,
    droppedPostFreeze: plan.droppedPostFreeze, droppedUntrustedSources: plan.droppedUntrustedSources });
}

export function planGroundTruthDelta({ current, taskId = current.taskId, delta, sourceCatalog = null, evidenceCapture = 'minimal' }) {
  const frozen = current.frozenAtVersion != null;
  const claims = new Map(current.claims.map((claim) => [claim.claimId, claim]));
  const accepted = [];
  const droppedPostFreeze = [];
  const droppedUntrustedSources = [];
  const operationDispositions = [];
  const target = claim => ({ claimId: claim.claimId, revision: claim.revision, revisionId: claim.revisionId, digest: sha256(claim), status: claim.status });
  let hardChanged = false;
  for (const [operationIndex, raw] of (delta?.operations ?? []).entries()) {
    const operation = String(raw.operation ?? raw.op ?? "").toUpperCase();
    if (!OPERATIONS.has(operation)) throw new Error(`Unsupported Ground Truth operation: ${operation}`);
    const sourceRejection = rejectedGroundTruthSource(raw, sourceCatalog);
    if (sourceRejection) {
      droppedUntrustedSources.push({ operation, claimId: raw.claimId ?? null, reason: sourceRejection, ref: raw.source?.ref ?? null });
      operationDispositions.push({ operationIndex, operation, disposition: 'DROPPED_UNTRUSTED', reason: sourceRejection, target: null });
      continue;
    }
    const incomingAuthority = AUTHORITIES.has(raw.authority) ? raw.authority : "AGENT_INFERRED";
    // A frozen ledger accepts USER_EXPLICIT operations only: new real user
    // messages can still supersede the baseline; agent inference cannot.
    // Dropping (not throwing) keeps the post-freeze incremental extractor
    // fail-soft; the caller journals the dropped operations.
    if (frozen && incomingAuthority !== "USER_EXPLICIT") {
      operationDispositions.push({ operationIndex, operation, disposition: 'DROPPED_POST_FREEZE', reason: 'Frozen ledger requires newly authorized USER_EXPLICIT operations', target: null });
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
    const duplicate = operation === 'ADD' && [...claims.values()].find(claim => claim.status === "ACTIVE"
      && claim.text === normalized.text && claim.category === normalized.category
      && claim.authority === normalized.authority && claim.severity === normalized.severity
      && claim.verificationTarget === normalized.verificationTarget
      && claim.implementationRole === normalized.implementationRole
      && sha256(claim.expectedFiles ?? []) === sha256(normalized.expectedFiles ?? [])
      && sha256(claim.capability ?? null) === sha256(normalized.capability ?? null)
      && claim.applicability === normalized.applicability
      && claim.applicabilityKind === normalized.applicabilityKind);
    if (duplicate) {
      operationDispositions.push({ operationIndex, operation, disposition: 'DEDUPLICATED', target: target(duplicate) });
      continue;
    }
    if (operation === "ADD" && claims.has(normalized.claimId))
      throw new Error(`ADD cannot replace an existing inferred identity: ${normalized.claimId}. Use an explicit authorized revision operation.`);
    claims.set(normalized.claimId, normalized);
    accepted.push({ operation, claim: normalized });
    operationDispositions.push({ operationIndex, operation, disposition: 'APPLIED', target: target(normalized) });
    if ((normalized.severity === "HARD" || existing?.severity === "HARD") && (
      operation !== "CONFLICT" || normalized.authority === "USER_EXPLICIT"
    )) hardChanged = true;
  }
  const nextClaims = [...claims.values()].sort((left, right) => left.category.localeCompare(right.category) || left.claimId.localeCompare(right.claimId));
  let next = accepted.length ? { schemaVersion: GROUND_TRUTH_SCHEMA_VERSION, taskId, version: current.version + 1,
    digest: sha256(nextClaims), updatedAt: null, frozenAtVersion: current.frozenAtVersion ?? null, claims: nextClaims } : { ...current };
  if (sourceCatalog) next = { ...next, userSourceHashes: { ...current.userSourceHashes,
    ...Object.fromEntries(sourceCatalog.filter(source => source.kind === 'USER_MESSAGE' && source.contentDigest).map(source => [source.ref, source.contentDigest])) },
    userSourceRefs: [...new Set([...(current.userSourceRefs ?? []), ...(next.userSourceRefs ?? []),
      ...sourceCatalog.filter(source => source.kind === 'USER_MESSAGE').map(source => source.ref)])] };
  for (const row of operationDispositions) row.effectiveTarget = row.target ? target(claims.get(row.target.claimId)) : null;
  const plan = { expectedVersion: current.version, expectedDigest: current.digest, changed: accepted.length > 0,
    hardChanged, current: next, accepted, operationDispositions, droppedPostFreeze, droppedUntrustedSources };
  return { ...plan, digest: groundTruthPlanDigest(plan) };
}

async function applyGroundTruthDeltaLocked({
  projectRoot,
  taskId,
  delta,
  evidenceCapture = "minimal",
  hookEventId = null,
  sourceCatalog = null,
  baselineCommit = null,
}) {
  const current = await loadCurrentGroundTruth(projectRoot, taskId);
  const receiptPath = baselineCommit && path.join(groundTruthDirectory(projectRoot, taskId), 'baseline-applied', `${sha256(baselineCommit.id)}.json`);
  const deltaHash = baselineCommit && sha256(delta);
  if (baselineCommit) {
    const previous = await readJson(receiptPath);
    if (previous) {
      if (baselineCommit.readCoverage?.requiresSemanticAudit && !baselineCommit.coverageAudit) throw Object.assign(new Error('Unreviewed baseline replay'), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
      if (previous.deltaHash !== deltaHash) throw Object.assign(new Error('Baseline request already committed different operations'), { code: 'BASELINE_COMMIT_CONFLICT' });
      await baselineCommit.coverageAudit?.assertReplay({ ...previous.result, current });
      return { ...previous.result, current, changed: false, hardChanged: false, duplicate: true };
    }
    if (current.version !== baselineCommit.expectedVersion || current.digest !== baselineCommit.expectedDigest)
      throw Object.assign(new Error('Baseline changed before delta application'), { code: 'BASELINE_INPUT_CHANGED' });
    await baselineCommit.assertCurrent();
    baselineCommit.signal?.throwIfAborted();
  }
  const finish = async result => {
    result.operationDispositions = planned.operationDispositions;
    if (sourceCatalog) {
      // Cursor and formal delta share the publication transaction, including a
      // successfully checked no-op input. Failure never consumes a new input.
      result.current = { ...result.current, userSourceHashes: { ...current.userSourceHashes,
        ...Object.fromEntries(sourceCatalog.filter(source => source.kind === 'USER_MESSAGE' && source.contentDigest)
          .map(source => [source.ref, source.contentDigest])) }, userSourceRefs: [...new Set([
        ...(current.userSourceRefs ?? []), ...(result.current.userSourceRefs ?? []),
        ...sourceCatalog.filter(source => source.kind === "USER_MESSAGE").map(source => source.ref),
      ])] };
      await atomicWriteJson(currentGroundTruthPath(projectRoot, taskId), result.current);
      await withTaskState({ projectRoot, taskId }, state => {
        state.groundTruth.userSourceRefs = result.current.userSourceRefs;
        if (sourceCatalog.some(source => source.kind === "USER_MESSAGE"
          && [source.ref, ...(source.aliases ?? [])].includes(state.groundTruth.pendingUserCursor))) {
          state.groundTruth.pendingUserCursor = null;
        }
      });
    }
    if (baselineCommit) {
      baselineCommit.signal?.throwIfAborted();
      if (Date.now() >= baselineCommit.deadlineAt) throw Object.assign(new Error('Baseline commit deadline expired'), { code: 'REVIEWER_DEADLINE' });
      const { current: _current, ...record } = result;
      await atomicWriteJson(receiptPath, { requestId: baselineCommit.id, deltaHash, result: record });
      await withTaskState({ projectRoot, taskId }, state => {
        state.groundTruth.sourceCursors[baselineCommit.scope] = baselineCommit.cursorDigest;
        // Only the program's acknowledged bounded finish can bind the exact
        // accepted delta. Suppressed/dropped candidates cannot certify truth.
        const shared = !result.droppedPostFreeze?.length && !result.droppedUntrustedSources?.length
          && baselineCommit.sharedBasis && baselineCommit.readCoverage?.bind?.(baselineCommit.sharedBasis, delta, result.current);
        if (shared) state.groundTruth.sharedBasis = shared;
      });
    }
    return result;
  };
  const planned = planGroundTruthDelta({ current, taskId, delta, evidenceCapture, sourceCatalog });
  if (baselineCommit?.readCoverage?.requiresSemanticAudit && !baselineCommit.coverageAudit)
    throw Object.assign(new Error('Independent baseline coverage audit required before apply'), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  await baselineCommit?.coverageAudit?.assertPlan(planned);
  const { accepted, droppedPostFreeze, droppedUntrustedSources, hardChanged } = planned;
  if (droppedUntrustedSources.length) await appendTaskJournal(projectRoot, taskId, {
    type: "GROUND_TRUTH_UNTRUSTED_SOURCES_DROPPED", hookEventId, dropped: droppedUntrustedSources,
  });
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
    return finish({ changed: false, hardChanged: false, current, droppedPostFreeze, droppedUntrustedSources });
  }
  const updatedAt = new Date().toISOString();
  const next = { ...planned.current, updatedAt }, version = next.version;
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
  return finish({ changed: true, hardChanged, current: next, accepted, droppedPostFreeze, droppedUntrustedSources });
}


export async function applyGroundTruthDelta(options) {
  if (options.baselineCommit) {
    const file = path.join(taskDirectory(options.projectRoot, options.taskId), 'task.json');
    const scope = scopedDecision(file), commit = options.baselineCommit;
    const receipt = await readJson(path.join(groundTruthDirectory(options.projectRoot, options.taskId), 'baseline-applied', `${sha256(commit.id)}.json`));
    if (receipt) {
      if (commit.readCoverage?.requiresSemanticAudit && !commit.coverageAudit) throw Object.assign(new Error('Unreviewed baseline replay'), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
      if (receipt.deltaHash !== sha256(options.delta)) throw Object.assign(new Error('Conflicting baseline commit retry'), { code: 'BASELINE_COMMIT_CONFLICT' });
      await commit.coverageAudit?.assertReplay({ ...receipt.result, current: await loadCurrentGroundTruth(options.projectRoot, options.taskId) });
      return { ...receipt.result, current: await loadCurrentGroundTruth(options.projectRoot, options.taskId), changed: false, hardChanged: false, duplicate: true };
    }
    if (!scope) {
      const state = await readJson(file);
      return withTaskDecision({ projectRoot: options.projectRoot, taskId: options.taskId, context: {
        kind: 'requirements', assessmentId: `baseline:${sha256([commit.id, options.delta])}`,
        guard: decisionGuard(state), deadlineAt: commit.deadlineAt, abortSignal: commit.signal,
        evidenceMatches: async () => { try { await commit.assertCurrent(); return true; } catch { return false; } },
      } }, () => applyGroundTruthDelta(options));
    }
    // The formal delta, receipt and cursor publish under the SAME task head.
    // Revalidate original inputs at publication, after any intervening review.
    const previous = scope.context.evidenceMatches;
    scope.context.evidenceMatches = async () => {
      if (previous && !await previous()) return false;
      try { await commit.assertCurrent(); return true; } catch(error) {
        scope.context.evidenceFailure={code:error.code??'BASELINE_INPUT_CHANGED',reason:String(error.message).slice(0,600)};
        return false;
      }
    };
    const beforePublish = scope.context.beforePublish;
    scope.context.beforePublish = async () => {
      await beforePublish?.();
      commit.signal?.throwIfAborted();
      if (Date.now() >= commit.deadlineAt) throw Object.assign(new Error('Baseline publication deadline expired'), { code: 'REVIEWER_DEADLINE' });
      await commit.assertCurrent();
      commit.signal?.throwIfAborted();
    };
  }
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
  sourceContract = null,
}) {
  const directory = path.join(taskDirectory(projectRoot, taskId), "skills", safeId(skillId));
  let previous;
  try { previous = await readJson(path.join(directory, "skill-ground-truth.json")); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const file = path.join(directory, 'skill-ground-truth.json'), scope = scopedDecision(file);
    const corruptSha256 = sha256(scope?.files[path.relative(scope.directory, file)] ?? await fs.readFile(file));
    const history = path.join(directory, 'history.jsonl');
    // Recover only the counter from an independently valid program history
    // record. The reconstructed constraints still come from current originals.
    try {
      if ((await fs.stat(history)).size > 2 * 1024 * 1024) throw new Error('History exceeds recovery bound');
      const line = (await fs.readFile(history, 'utf8')).trimEnd().split('\n').at(-1);
      previous = JSON.parse(line);
      if (previous.schemaVersion !== SKILL_GROUND_TRUTH_SCHEMA_VERSION || previous.taskId !== taskId || previous.skillId !== skillId
        || !Number.isSafeInteger(previous.version) || previous.version < 1
        || previous.digest !== sha256({ skillId, skillDigest: previous.skillDigest, constraints: previous.constraints, taskOverlays: previous.taskOverlays,
          ...(previous.sourceContract ? { sourceContract: previous.sourceContract } : {}) }))
        throw new Error('Invalid historical Skill graph');
      await appendTaskJournal(projectRoot, taskId, { type: 'SKILL_GROUND_TRUTH_CACHE_RECOVERED', skillId,
        corruptSha256, historyRecordSha256: sha256(line), previousVersion: previous.version });
    } catch {
      throw Object.assign(new Error(`Corrupt derived Skill cache ${corruptSha256}; historical version unavailable`), { code: 'SKILL_GROUND_TRUTH_CACHE_CORRUPT' });
    }
  }
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
      ...applicabilityMetadata(constraint),
      dependsOn: [...(constraint.dependsOn ?? [])],
      inputs: [...(constraint.inputs ?? [])],
      outputs: [...(constraint.outputs ?? [])],
      sourceRef: constraint.sourceRef ?? null,
      ...(sourceContract ? { sourceUnitIds: [...constraint.sourceUnitIds], sourceBinding: constraint.sourceBinding,
        sourceContextFiles: [...constraint.sourceContextFiles], sourceText: constraint.sourceText,
        sourceInterpretation: structuredClone(constraint.sourceInterpretation) } : {}),
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
    ...(sourceContract ? { sourceContract } : {}),
    digest: sha256({ skillId, skillDigest, constraints: normalized, taskOverlays, ...(sourceContract ? { sourceContract } : {}) }),
  };
  await fs.mkdir(directory, { recursive: true });
  await appendJsonLine(path.join(directory, "history.jsonl"), document);
  await atomicWriteJson(path.join(directory, "skill-ground-truth.json"), document);
  await atomicWrite(path.join(directory, "skill-ground-truth.md"), renderSkillMarkdown(document));
  return { document, directory };
}
