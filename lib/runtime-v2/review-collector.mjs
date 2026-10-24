import { promises as fs } from "node:fs";
import path from "node:path";

import { validateJsonSchema } from "../json-schema-validator.mjs";
import { DEFAULT_REVIEW_TIMEOUT_MS, MIN_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";
import { outsideDecision } from "./decision-scope.mjs";
import { OBJECT_JUDGEMENTS } from "./metrics.mjs";
import { validateReviewFile, validateReviewFinding, validateReviewJudgement } from "./review-result-validation.mjs";
import { emptyReviewPassIndex, isCompletePassItem, loadReviewPassIndex, readReviewPassItem, reviewPassInputKey,
  reviewPassItemKey, reviewReadEvidenceMatches, saveReviewPassIndex } from "./review-pass-cache.mjs";
import { decisionGuard, taskDirectory } from "./task-store.mjs";
import { createReviewFingerprintCache } from "./review-fingerprint-cache.mjs";
import { evidencePath } from "./evidence-state.mjs";
import { atomicWrite, atomicWriteJson, readJson, sha256, uniqueId } from "./utils.mjs";

const MAX_OBJECTS_PER_ITEM = 4;
const MAX_ITEM_TIMEOUT_MS = 120_000;
const SUMMARY_RESERVE_MS = 250;
const CLEANUP_GRACE_MS = 100;
const OPTIONAL_OPERATION_MS = 500;
const clone = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const terminal = error => ["REVIEW_COLLECTION_STALE", "REVIEW_COLLECTION_CANCELLED"].includes(error?.code);
const blocked = /^(?:\.git|\.aws|\.ssh|\.env(?:\..*)?|auth-profiles\.json|openclaw\.json|.*(?:credentials|secret|api[-_]?key).*)$/iu;

function partition(population, findingsOnly = false, maxObjects = MAX_OBJECTS_PER_ITEM, singleMetrics = null) {
  const groups = new Map();
  for (const object of Object.values(population.metrics ?? {}).flat()) {
    const key = JSON.stringify([object.sourceId ?? object.objectId, object.verificationTarget ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  }
  return [...groups.values()].flatMap(objects => {
    if (findingsOnly) return [objects];
    if (singleMetrics) {
      const parts = [], ordinary = [];
      for (const object of objects) {
        if (singleMetrics.includes(object.metricId)) parts.push([object]); else ordinary.push(object);
      }
      for (let start = 0; start < ordinary.length; start += MAX_OBJECTS_PER_ITEM)
        parts.push(ordinary.slice(start, start + MAX_OBJECTS_PER_ITEM));
      return parts;
    }
    const parts = [];
    for (let start = 0; start < objects.length; start += maxObjects)
      parts.push(objects.slice(start, start + maxObjects));
    return parts;
  });
}

function subset(population, objects) {
  const ids = new Set(objects.map(object => object.objectId));
  return { ...population, metrics: Object.fromEntries(Object.entries(population.metrics ?? {})
    .map(([metric, rows]) => [metric, rows.filter(object => ids.has(object.objectId))])) };
}

function reference(value) {
  if (typeof value !== "string") return null;
  const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(value);
  return match ? { path: match[1], start: Number(match[2]), end: Number(match[3] ?? match[2]) } : null;
}

function ownedFinding(finding, sources) {
  const ids = finding?.violatedGroundTruthIds;
  return Array.isArray(ids) && ids.length > 0 && ids.every(id => sources.has(id));
}

function mergeFileAssessments(reports) {
  const files = new Map(), ranks = { PASS: 0, UNVERIFIED: 1, DEVIATION: 2 };
  for (const report of reports) for (const value of report.fileAssessments ?? []) {
    const previous = files.get(value.path);
    if (!previous) files.set(value.path, clone(value));
    else {
      if ((ranks[value.status] ?? 1) > (ranks[previous.status] ?? 1)) previous.status = value.status;
      previous.reason = [...new Set([previous.reason, value.reason])].join("\n");
      previous.evidence = [...new Set([...(previous.evidence ?? []), ...(value.evidence ?? [])])];
    }
  }
  return [...files.values()];
}

/** Run independent, bounded model tasks; task identity and the full denominator remain caller-owned. */
export async function collectReviewItems({
  projectRoot, taskId, role, reviewerFactory, reviewer = {}, schema, request, evidence = null,
  classification = null, deadlineAt = Infinity, abortSignal = null, ...execution
}) {
  // Capture the caller's scope before any asynchronous filesystem operation.
  request = clone(request);
  evidence = clone(evidence);
  schema = clone(schema);
  reviewer = clone(reviewer);
  classification = classification == null ? null : {
    stopClassification: classification.stopClassification, stage: classification.stage ?? null,
  };
  const findingsOnly = classification != null && !["STAGE_COMPLETE", "TASK_COMPLETE"].includes(classification.stopClassification);
  if (findingsOnly) {
    schema.properties.metricObjectJudgements.maxItems = 0;
    if (schema.properties.fileAssessments) schema.properties.fileAssessments.maxItems = 0;
  }
  const population = request.population ?? evidence?.population;
  if (!population?.metrics) throw failure("REVIEW_COLLECTION_SCOPE_INVALID", "A frozen metric population is required.");
  const allObjects = Object.values(population.metrics).flat();
  if (new Set(allObjects.map(object => object.objectId)).size !== allObjects.length)
    throw failure("REVIEW_COLLECTION_SCOPE_INVALID", "The frozen population contains duplicate object identities.");
  const stopReview = role === "stop-reviewer";
  const cacheableRole = stopReview || role === "implementation-reviewer";
  const items = partition(population, stopReview && findingsOnly, reviewerFactory.reviewItemSize === 1 ? 1 : MAX_OBJECTS_PER_ITEM,
    Array.isArray(reviewerFactory.singleReviewMetrics) ? reviewerFactory.singleReviewMetrics : null);
  const supplemental = stopReview && request.supplementalFileAssessments === true
    && reviewerFactory.supportsSupplementalFileAssessment === true && !findingsOnly
    && ["TASK_COMPLETE", "STAGE_COMPLETE"].includes(classification?.stopClassification);
  if (supplemental && !schema.properties?.fileAssessments)
    throw failure("REVIEW_COLLECTION_SCOPE_INVALID", "Supplemental file review requires the file assessment schema.");
  const fileQualityIndex = supplemental ? items.length : Infinity;
  const qualityTargets = new Map();
  if (supplemental && classification?.stopClassification === "TASK_COMPLETE") for (const binding of Array.isArray(request.artifactCandidates) ? request.artifactCandidates : []) {
    for (const file of Array.isArray(binding?.files) ? binding.files : []) {
      if (typeof binding.artifactId !== "string" || !binding.artifactId.trim() || typeof file?.path !== "string"
        || !file.path || !/^[a-f\d]{64}$/u.test(file.sha256 ?? "")) continue;
      const target = { path: file.path, sha256: file.sha256, artifactId: binding.artifactId };
      const previous = qualityTargets.get(file.path);
      if (previous && JSON.stringify(previous) !== JSON.stringify(target))
        throw failure("REVIEW_COLLECTION_SCOPE_INVALID", "A delivery file has conflicting declared ownership.");
      qualityTargets.set(file.path, target);
    }
  }
  const qualityByIndex = new Map();
  const allSourceIds = [...new Set(allObjects.map(object => object.sourceId).filter(Boolean))];
  // One known delivery file per item reuses the existing durable loop. An old
  // caller without bindings retains its single native supplemental duty.
  if (supplemental) for (const target of qualityTargets.size ? qualityTargets.values() : [null]) {
    qualityByIndex.set(items.length, target); items.push([]);
  }
  const initialWindow = deadlineAt - Date.now();
  const summaryReserveMs = Number.isFinite(initialWindow) && initialWindow >= 10_000
    ? Math.min(5000, Math.max(2000, Math.floor(initialWindow * 0.05))) : SUMMARY_RESERVE_MS;
  const root = await fs.realpath(projectRoot);
  const runId = uniqueId("review-collection");
  const directory = path.join(taskDirectory(root, taskId), "review-collections", runId);
  const progressPath = path.join(directory, "progress.json");
  const manifest = new Map((request.sourceManifest ?? []).map(entry => [path.resolve(root, entry.path ?? entry.relativePath), entry]));
  const sources = new Map(), citations = [], reports = [];
  const checkedReadEvidence = [];
  const durable = (file, value) => outsideDecision(() => atomicWriteJson(file, value));
  const gtPath = path.resolve(root, request.groundTruthPath ?? path.join(taskDirectory(root, taskId), "ground-truth", "current.json"));
  const taskPath = path.join(taskDirectory(root, taskId), "task.json");
  const assertHashActive = () => {
    if (abortSignal?.aborted) throw failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
    if (Date.now() >= deadlineAt) throw failure("REVIEW_COLLECTION_STALE", "The review collection's shared publication deadline expired.");
  };
  const checkedFingerprint = createReviewFingerprintCache({ assertActive: assertHashActive, signal: abortSignal });
  // Candidate ownership is caller-declared, not inferred by an individual
  // worker. Recheck even uncited candidates and the declaration source before
  // reuse/publication; request itself already participates in the cache key.
  const candidateDependencies = new Map();
  for (const candidate of Array.isArray(request.artifactCandidates) ? request.artifactCandidates : []) {
    for (const entry of Array.isArray(candidate?.files) ? candidate.files : []) {
      if (typeof entry?.path !== "string" || !/^[a-f\d]{64}$/u.test(entry.sha256 ?? "")) continue;
      const absolute = path.resolve(root, entry.path), relative = path.relative(root, absolute);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || relative.split(/[\\/]/u).some(part => blocked.test(part))) continue;
      candidateDependencies.set(absolute, entry.sha256);
    }
    // A loaded policy may live outside the business root. Its explicitly
    // declared bytes are a program dependency only, never model evidence.
    const declaration = candidate?.declaration;
    if (typeof declaration?.configPath === "string" && path.isAbsolute(declaration.configPath)
      && /^[a-f\d]{64}$/u.test(declaration.configSha256 ?? ""))
      candidateDependencies.set(path.resolve(declaration.configPath), declaration.configSha256);
  }
  async function currentCandidates(fingerprint = checkedFingerprint) {
    return Promise.all([...candidateDependencies].sort(([a], [b]) => a.localeCompare(b)).map(async ([file, expected]) => {
      try {
        const real = await fs.realpath(file);
        return [file, expected, real === file ? await fingerprint(real) : null];
      } catch (error) {
        if (abortSignal?.aborted) throw failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
        if (terminal(error)) throw error;
        return [file, expected, null];
      }
    }));
  }
  async function currentBasis(fingerprint = checkedFingerprint) {
    return outsideDecision(async () => {
      const task = await readJson(taskPath);
      const truth = await readJson(gtPath);
      return {
        guard: task ? { ...decisionGuard({ ...task, groundTruth: task.groundTruth ?? {}, correctionEpoch: task.correctionEpoch ?? {} }),
          cancelled: task.control?.cancelled ?? false, pendingRequirement: task.control?.pendingRequirement ?? null } : null,
        groundTruth: truth == null ? null : sha256(truth),
        ...(candidateDependencies.size ? { artifactCandidates: await currentCandidates(fingerprint) } : {}),
      };
    });
  }
  const basis = await currentBasis();
  const capturedCandidatesMatch = !(basis.artifactCandidates ?? []).some(([, expected, actual]) => expected !== actual);
  // The ambient transaction may legitimately hold a newer, unpublished GT.
  // Match that caller-owned snapshot while monitoring committed state separately.
  const ambientTruth = await readJson(gtPath);
  const capturedTruthMatches = !ambientTruth || !evidence?.groundTruth || sha256(ambientTruth) === sha256(evidence.groundTruth);
  const collection = {
    schemaVersion: "runtime-corrector.review-collection.v1", runId, role, taskId,
    path: directory, progressPath, mode: findingsOnly ? "findings-only" : "metrics", complete: false, status: "RUNNING", totalItems: items.length,
    totalObjects: allObjects.length, completedItems: 0, reviewedObjects: 0, items: [], failures: [],
    ...(cacheableRole ? { reusedItems: 0, reusedObjects: 0 } : {}),
    basis: { ...basis, populationVersion: population.version ?? null, populationDigest: population.digest ?? sha256(population),
      groundTruthVersion: evidence?.groundTruth?.version ?? population.groundTruthVersion ?? null,
      groundTruthDigest: evidence?.groundTruth?.digest ?? null }, startedAt: new Date().toISOString(),
  };
  const persistProgress = () => durable(progressPath, { ...collection, updatedAt: new Date().toISOString() });
  const passInputKey = cacheableRole && !findingsOnly && (classification || !stopReview)
    ? reviewPassInputKey({ reviewerFactory, reviewer, role, taskId, basis, classification, schema, request, evidence,
      execution: Object.fromEntries(Object.entries(execution).filter(([, value]) => typeof value !== "function")) }) : null;
  const passItemKeys = passInputKey ? items.map((owned, index) => index >= fileQualityIndex ? null : reviewPassItemKey(passInputKey, owned)) : [];
  const passIndexPath = path.join(taskDirectory(root, taskId), role === "implementation-reviewer"
    ? "implementation-review-pass-cache.json" : "review-pass-cache.json");
  let passIndex = emptyReviewPassIndex(passInputKey);
  async function ensureCurrent({ final = false } = {}) {
    // Every distinct input is fully rehashed once at publication, even when
    // several items/citations share it. Intermediate checks retain metadata
    // change detection without repeatedly loading unchanged source bodies.
    const publication = new Map();
    const fingerprint = file => {
      if (!final) return checkedFingerprint(file);
      if (!publication.has(file)) publication.set(file, checkedFingerprint(file, { force: true }));
      return publication.get(file);
    };
    if (abortSignal?.aborted) throw failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
    if (Date.now() >= deadlineAt)
      throw failure("REVIEW_COLLECTION_STALE", "The review collection's shared publication deadline expired.");
    if (!capturedTruthMatches)
      throw failure("REVIEW_COLLECTION_STALE", "The supplied Ground Truth is already stale.");
    if (!capturedCandidatesMatch)
      throw failure("REVIEW_COLLECTION_STALE", "A declared review candidate or its ownership declaration is already stale.");
    const current = await currentBasis(fingerprint);
    if (sha256(current) !== sha256(basis) || current.guard?.cancelled)
      throw failure("REVIEW_COLLECTION_STALE", "The task or canonical Ground Truth changed during review.");
    if (typeof execution.evidenceMatches === "function" && !await execution.evidenceMatches())
      throw failure("REVIEW_COLLECTION_STALE", "The frozen evidence changed during review.");
    for (const source of sources.values()) {
      try {
        if (await fingerprint(source.frozen ? source.snapshotPath : source.path) !== source.contentHash) throw new Error("changed");
      } catch (error) {
        if (abortSignal?.aborted) throw failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
        if (terminal(error)) throw error;
        throw failure("REVIEW_COLLECTION_STALE", "A checked source changed or disappeared during review.");
      }
    }
    for (const readEvidence of checkedReadEvidence)
      if (!await reviewReadEvidenceMatches(root, readEvidence, { fingerprint, maxFiles: Infinity }))
        throw failure("REVIEW_COLLECTION_STALE", "A program-observed review dependency changed during review.");
    if (abortSignal?.aborted) throw failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
    if (Date.now() >= deadlineAt)
      throw failure("REVIEW_COLLECTION_STALE", "The review collection's shared publication deadline expired.");
  }
  async function authorizedPath(file) {
    const real = await fs.realpath(path.resolve(root, file));
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
      || relative.split(/[\\/]/u).some(part => blocked.test(part)))
      throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "Evidence must select an authorized project text file.");
    return real;
  }
  async function capture(ref, owner, supplied = [], allowShared = false) {
    const parsed = reference(ref);
    const known = supplied.find(entry => (allowShared || entry.usedBy?.includes(owner)) && (entry.selection === ref || (parsed
      && [entry.path, entry.snapshotPath].filter(Boolean).some(file => path.resolve(root, file) === path.resolve(root, parsed.path))
      && entry.start === parsed.start && entry.end === parsed.end)));
    if (!known && !parsed) throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "An evidence identifier has no program-verified source.");
    const origin = known?.path ?? known?.source ?? parsed?.path;
    if (typeof origin !== "string") throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "Evidence has no original source path.");
    const frozen = known?.frozen === true;
    const file = await authorizedPath(frozen ? known.snapshotPath ?? origin : origin);
    const original = path.resolve(root, origin);
    const originalRelative = path.relative(root, original);
    if (!originalRelative || originalRelative === ".." || originalRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(originalRelative) || originalRelative.split(/[\\/]/u).some(part => blocked.test(part)))
      throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "The original evidence source is outside the authorized project scope.");
    // Prior reports, progress and private role requests are not business proof.
    // Only this review's program-bound frozen evidence can authorize a private file.
    if ((originalRelative.split(/[\\/]/u)[0] === ".runtime-correction"
      || path.relative(root, file).split(/[\\/]/u)[0] === ".runtime-correction") && !frozen)
      throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "Private runtime records require this scope's program-verified frozen citation.");
    if (role === "implementation-reviewer" && !manifest.has(original))
      throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "Implementation evidence is outside the declared source manifest.");
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "Evidence must select a text file.");
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "Binary files cannot establish a text judgement.");
    const contentHash = sha256(bytes);
    const expected = known?.contentHash ?? manifest.get(original)?.sha256;
    if (expected && expected !== contentHash)
      throw failure("REVIEW_COLLECTION_STALE", "An original source does not match its frozen content hash.");
    const text = bytes.toString("utf8"), rows = text.split("\n");
    const start = parsed?.start ?? known?.start, end = parsed?.end ?? known?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > rows.length)
      throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "The selected original source range does not exist.");
    const identity = `${original}\0${contentHash}\0${frozen}`;
    let stored = sources.get(identity);
    if (!stored) {
      const snapshotPath = path.join(directory, "sources", `${sha256(identity)}.txt`);
      await outsideDecision(() => atomicWrite(snapshotPath, text));
      stored = { path: original, snapshotPath, contentHash, frozen };
      sources.set(identity, stored);
    }
    return { ...stored, selection: `${stored.snapshotPath}#L${start}-L${end}`, originalSelection: ref,
      start, end, exactQuote: rows.slice(start - 1, end).join("\n"), usedBy: [owner],
      ...(known?.readProof ? { readProof: clone(known.readProof) } : {}) };
  }
  async function proveReport(report, supplied, owned, partial = false, qualityTarget = null) {
    const result = clone(report), accepted = [], selected = [], unavailable = [];
    const ownedById = new Map(owned.map(object => [object.objectId, object]));
    for (const row of result.metricObjectJudgements ?? []) {
      try {
        const refs = [];
        for (const ref of row.evidence ?? []) refs.push(await capture(ref, row.objectId, supplied));
        row.evidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        selected.push(...refs);
        accepted.push(validateReviewJudgement({ row, object: ownedById.get(row.objectId), citations: refs, role, classification }));
      } catch (error) {
        if (error.code === "REVIEW_ITEM_EVIDENCE_UNAVAILABLE") unavailable.push({ objectId: row.objectId, reason: error.message });
        else if (terminal(error) || !partial) throw error;
      }
    }
    result.metricObjectJudgements = accepted;
    const acceptedFindings = [];
    for (const finding of result.findings ?? []) {
      try {
        const refs = [];
        for (const ref of finding.actualEvidence ?? finding.evidence ?? []) refs.push(await capture(ref, finding.deviationKey, supplied));
        if (!refs.length) throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "A finding requires checked original evidence.");
        validateReviewFinding({ finding, objects: owned, citations: refs, role, classification });
        if (finding.actualEvidence) finding.actualEvidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        else finding.evidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        selected.push(...refs); acceptedFindings.push(finding);
      } catch (error) {
        if (error.code === "REVIEW_ITEM_EVIDENCE_UNAVAILABLE") unavailable.push({ deviationKey: finding.deviationKey, reason: error.message });
        else if (terminal(error) || !partial) throw error;
      }
    }
    result.findings = acceptedFindings;
    const fileAssessments = [];
    for (const file of result.fileAssessments ?? []) {
      try {
        if (qualityTarget && file.path !== qualityTarget.path)
          throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", "A file-quality item assessed another delivery file.");
        const refs = [];
        for (const ref of file.evidence ?? []) refs.push(await capture(ref, file.path, supplied, true));
        file.evidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        const target = path.resolve(root, qualityTarget?.path ?? file.path);
        selected.push(...refs); fileAssessments.push(validateReviewFile({ file, citations: refs.filter(ref => ref.path === target) }));
      } catch (error) {
        if (error.code === "REVIEW_ITEM_EVIDENCE_UNAVAILABLE") unavailable.push({ path: file.path, reason: error.message });
        else if (terminal(error) || !partial) throw error;
      }
    }
    if (result.fileAssessments) result.fileAssessments = fileAssessments;
    if (unavailable.length && !partial) throw Object.assign(failure("REVIEW_ITEM_EVIDENCE_UNAVAILABLE",
      `${unavailable.length} judgement(s) lack checked reading or proof ownership: ${unavailable[0].reason}`), {
      partialReview: { ...result, citations: selected },
    });
    return { report: result, citations: selected };
  }
  function validateReport(report, owned, itemSchema = schema, qualityTarget = null) {
    const issues = validateJsonSchema(report, itemSchema);
    if (issues.length) throw failure("REVIEW_ITEM_INVALID", `${issues[0].pointer}: ${issues[0].message}`);
    // The shared lightweight validator does not implement maxItems. Enforce
    // empty ownership here as well as publishing it in the model's schema.
    for (const field of ["metricObjectJudgements", "findings", "fileAssessments"])
      if (itemSchema.properties?.[field]?.maxItems === 0 && report[field]?.length)
        throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", `This short review does not own ${field}.`);
    const expected = new Set(findingsOnly ? [] : owned.map(object => object.objectId));
    const rows = report.metricObjectJudgements ?? [];
    if (rows.length !== expected.size || new Set(rows.map(row => row.objectId)).size !== rows.length
      || rows.some(row => !expected.has(row.objectId)))
      throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", "A short review omitted, repeated or judged an unassigned object.");
    const sourceIds = new Set(owned.map(object => object.sourceId).filter(Boolean));
    if ((report.findings ?? []).some(finding => !ownedFinding(finding, sourceIds)))
      throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", "A short review finding references an unassigned requirement.");
    if (qualityTarget && (report.fileAssessments?.length !== 1 || report.fileAssessments[0].path !== qualityTarget.path))
      throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", "A file-quality item must return its one declared delivery file.");
    if (!qualityTarget && supplemental && !findingsOnly && owned.length === 0
      && itemSchema.properties.findings.maxItems === 0 && !report.fileAssessments?.length)
      throw failure("REVIEW_ITEM_EVIDENCE_UNAVAILABLE", "FILE_QUALITY_SCOPE_UNRESOLVED: the requested file-quality duty returned no identified delivery-file assessment.");
    if (classification && (report.stopClassification !== classification.stopClassification
      || (report.stage ?? null) !== (classification.stage ?? null)))
      throw failure("REVIEW_ITEM_CLASSIFICATION_INVALID", "A short review changed the caller's Stop classification.");
    if (rows.some(row => !OBJECT_JUDGEMENTS.has(row.judgement) || !row.reason?.trim()
      || !Array.isArray(row.evidence) || row.evidence.some(ref => typeof ref !== "string" || !ref.trim())))
      throw failure("REVIEW_ITEM_INVALID", "A short review returned an invalid judgement.");
  }
  function partialReport(value, owned, fileQuality = false) {
    const expected = new Set(findingsOnly ? [] : owned.map(object => object.objectId));
    const rows = Array.isArray(value?.metricObjectJudgements) ? value.metricObjectJudgements : [];
    const counts = new Map();
    for (const row of rows) counts.set(row?.objectId, (counts.get(row?.objectId) ?? 0) + 1);
    const rowSchema = schema?.properties?.metricObjectJudgements?.items;
    const accepted = rows.filter(row => expected.has(row?.objectId) && counts.get(row.objectId) === 1
      && OBJECT_JUDGEMENTS.has(row.judgement) && typeof row.reason === "string" && row.reason.trim()
      && Array.isArray(row.evidence) && row.evidence.length && row.evidence.every(ref => typeof ref === "string" && ref.trim()))
      .map(row => rowSchema?.properties ? Object.fromEntries(Object.entries(row).filter(([key]) => Object.hasOwn(rowSchema.properties, key))) : clone(row))
      .filter(row => !rowSchema || !validateJsonSchema(row, rowSchema).length);
    const sourceIds = new Set(owned.map(object => object.sourceId).filter(Boolean));
    const findingSchema = schema?.properties?.findings?.items;
    const findings = (Array.isArray(value?.findings) ? value.findings : []).filter(finding => ownedFinding(finding, sourceIds)
      && (!findingSchema || !validateJsonSchema(finding, findingSchema).length));
    const fileSchema = schema?.properties?.fileAssessments?.items;
    const fileAssessments = fileQuality && fileSchema ? (Array.isArray(value?.fileAssessments) ? value.fileAssessments : [])
      .filter(file => !validateJsonSchema(file, fileSchema).length) : [];
    return { summary: "Partial short review; final verification is incomplete.", findings,
      metricObjectJudgements: accepted, fileAssessments };
  }
  async function invoke(input, timeoutMs) {
    let timer, abort;
    let settled = false;
    const work = Promise.resolve().then(() => reviewerFactory(input));
    // A timed-out transport must not publish a late handle or leak its session.
    void work.then(handle => { if (settled) return handle?.close?.(); }).catch(() => {});
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure("REVIEW_ITEM_TIMEOUT", "The short review exceeded its time budget.")), timeoutMs + CLEANUP_GRACE_MS);
        if (abortSignal) {
          abort = () => reject(failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled."));
          abortSignal.addEventListener("abort", abort, { once: true });
          if (abortSignal.aborted) abort();
        }
      })]);
    } finally {
      settled = true;
      clearTimeout(timer);
      if (abort) abortSignal.removeEventListener("abort", abort);
    }
  }
  async function boundedOptional(callback, fallback = null) {
    let timer;
    const work = Promise.resolve().then(callback);
    void work.catch(() => {});
    const available = Math.max(0, Math.min(OPTIONAL_OPERATION_MS, deadlineAt - Date.now()));
    if (!available) return fallback;
    try {
      return await Promise.race([work.catch(() => fallback), new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), available);
      })]);
    } finally { clearTimeout(timer); }
  }
  function recordUnstarted(startIndex) {
    const code = "REVIEW_COLLECTION_DEADLINE";
    const reason = "No review time remains before the collection's aggregation cutoff.";
    const objectIds = [], itemIds = [], rows = [], fileAssessments = [];
    for (let index = startIndex; index < items.length; index++) {
      const owned = items[index];
      const fileQuality = index >= fileQualityIndex, qualityTarget = qualityByIndex.get(index);
      const ids = owned.map(object => object.objectId);
      const itemId = `item-${String(index + 1).padStart(4, "0")}`;
      const jsonPointer = `/items/${collection.items.length}`;
      collection.items.push({ itemId, objectIds: ids,
        sourceIds: fileQuality ? allSourceIds : [...new Set(owned.map(object => object.sourceId).filter(Boolean))],
        ...(fileQuality ? { kind: "file-quality", ...(qualityTarget ? { qualityTarget } : {}) } : {}),
        path: progressPath, jsonPointer, status: "UNVERIFIED", unstarted: true, reasonCode: code, reason });
      objectIds.push(...ids); itemIds.push(itemId);
      if (!findingsOnly) rows.push(...ids.map(objectId => ({ objectId, judgement: "UNVERIFIED",
        reason: `${code}: this review item was not started.`, evidence: [] })));
      if (qualityTarget) fileAssessments.push({ path: qualityTarget.path, status: "UNVERIFIED", reason: `${code}: this file-quality item was not started.`, evidence: [] });
    }
    collection.failures.push({ code, reason, objectIds, itemIds, itemCount: itemIds.length });
    reports.push({ summary: "Remaining review items were not started before the aggregation cutoff.",
      findings: [], metricObjectJudgements: rows, fileAssessments, ...(classification ?? {}) });
  }
  await persistProgress();
  try {
    if (passInputKey) {
      await ensureCurrent();
      passIndex = await boundedOptional(() => loadReviewPassIndex(passIndexPath, passInputKey, passItemKeys.filter(Boolean)), passIndex);
    }
    for (const [index, owned] of items.entries()) {
      const fileQuality = index >= fileQualityIndex, qualityTarget = qualityByIndex.get(index);
      // Once dispatch closes, account for the remaining scope in memory and
      // publish it in the single final progress write. Do not repeat source
      // validation or create a file for each task that was never started.
      if (deadlineAt - Date.now() - summaryReserveMs < MIN_REVIEW_TIMEOUT_MS + CLEANUP_GRACE_MS) {
        recordUnstarted(index);
        break;
      }
      await ensureCurrent();
      const objectIds = owned.map(object => object.objectId), sourceIds = fileQuality ? allSourceIds
        : [...new Set(owned.map(object => object.sourceId).filter(Boolean))];
      const itemId = `item-${String(index + 1).padStart(4, "0")}`;
      const itemPath = path.join(directory, "items", `${itemId}.json`);
      const remaining = deadlineAt - Date.now() - summaryReserveMs;
      if (remaining < MIN_REVIEW_TIMEOUT_MS + CLEANUP_GRACE_MS) {
        recordUnstarted(index);
        break;
      }
      const configured = reviewer.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
      const allowance = stopReview ? remaining - CLEANUP_GRACE_MS
        : Math.max(MIN_REVIEW_TIMEOUT_MS, Math.floor(remaining / (items.length - index)) - CLEANUP_GRACE_MS);
      const timeoutMs = Math.min(configured, MAX_ITEM_TIMEOUT_MS, allowance);
      const passItemKey = passItemKeys[index];
      let handle = null, report, itemCitations = [], itemError = null, readyToPersist = false, reusedFrom = null, itemReadEvidence = null;
      try {
        const localPopulation = subset(population, findingsOnly ? [] : owned);
        const originalInstructions = fileQuality ? request.supplementalFileAssessmentInstructions : request.instructions;
        const instructions = Array.isArray(originalInstructions) ? originalInstructions : originalInstructions ? [originalInstructions] : [];
        const itemSchema = clone(schema);
        if (fileQuality) {
          itemSchema.properties.metricObjectJudgements.maxItems = 0;
          itemSchema.properties.findings.maxItems = 0;
        } else if (supplemental) itemSchema.properties.fileAssessments.maxItems = 0;
        const localRequest = { ...request, population: localPopulation,
          instructions: [...instructions,
            fileQuality
              ? "This supplemental review owns ONLY the CURRENT content quality of requested deliverable files. Return fileAssessments with checked source evidence, no metric judgements and no findings. Identify the original requested deliverables and their intended artifact requirements from the frozen task sources. Do not read generated metric reports, collection progress or summaries, do not summarize previous reviewer decisions, and never turn an object coverage PASS into a file PASS. This is the original supplemental file duty, not a new whole-project acceptance judgement."
              : findingsOnly
              ? `This short review owns ONLY these sourceIds: ${JSON.stringify(sourceIds)}. Return findings for their actual HARD violations at this Stop, and return no metric judgements or file assessments. Do not invent or omit a mandatory violation solely because the assistant calls this Stop intermediate.`
              : `This short review owns ONLY these objectIds: ${JSON.stringify(objectIds)}. Return exactly one judgement per assigned object and no foreign requirement findings.`,
            ...(classification ? [`Keep stopClassification=${classification.stopClassification} and stage=${JSON.stringify(classification.stage ?? null)} fixed. This is the caller's review scope, not a PASS claim.`] : []),
            "Keep each reason short: name the concrete mechanism and consequence. Select evidence path and line ranges; do not generate quotations or repeat the request.",
            "Read the evidence relevant to the assigned obligation, its actual conditions and applicable global constraints. The source manifest is navigation, not a requirement to read every file. Do not reload the complete transcript or unrelated source bodies."],
          reviewScope: { objectIds, sourceIds, ...(role === "stop-reviewer" ? { boundedBasis: true } : {}),
            ...(fileQuality ? { kind: "file-quality", ...(qualityTarget ? { qualityTarget } : {}) } : {}),
            ...(findingsOnly ? { findingsOnly: true } : {}) }, ...(classification ? { fixedStopClassification: classification } : {}) };
        delete localRequest.supplementalFileAssessments;
        delete localRequest.supplementalFileAssessmentInstructions;
        const localEvidence = evidence == null ? null : { ...evidence, population: localPopulation };
        if (passItemKey && passIndex.items[passItemKey]) {
          const cached = await boundedOptional(() => readReviewPassItem({ taskRoot: taskDirectory(root, taskId),
            record: passIndex.items[passItemKey], inputKey: passInputKey, itemKey: passItemKey }));
          if (cached && await boundedOptional(() => reviewReadEvidenceMatches(root, cached.reviewEvidence), false)) {
            let proven = null;
            try {
              validateReport(cached.result, owned, itemSchema);
              if (!isCompletePassItem(cached.result, owned)) throw new Error("Cached review is not a complete PASS item.");
              proven = await proveReport(cached.result, cached.sourceCitations ?? [], owned);
            } catch {
              // Old source bytes, damaged records and missing citations are cache misses.
            }
            // Do not swallow a changed task, cancellation or the shared deadline.
            await ensureCurrent();
            if (proven) {
              report = proven.report; itemCitations = proven.citations; reusedFrom = cached.path;
              itemReadEvidence = cached.reviewEvidence; checkedReadEvidence.push(itemReadEvidence);
              await ensureCurrent();
            }
          }
          if (!reusedFrom) delete passIndex.items[passItemKey];
        }
        if (!reusedFrom) {
          const dispatchRemaining = deadlineAt - Date.now() - summaryReserveMs;
          if (dispatchRemaining < MIN_REVIEW_TIMEOUT_MS + CLEANUP_GRACE_MS)
            throw failure("REVIEW_COLLECTION_DEADLINE", "No review time remains after checking the cached item.");
          const dispatchTimeoutMs = Math.min(timeoutMs, dispatchRemaining - CLEANUP_GRACE_MS);
          handle = await invoke({ ...execution, projectRoot: root, taskId, role,
            reviewer: { ...reviewer, session: reviewer.session === "independent" ? "independent" : "detached", timeoutMs: dispatchTimeoutMs },
            schema: itemSchema, request: localRequest, evidence: localEvidence, deadlineAt, abortSignal }, dispatchTimeoutMs);
          validateReport(handle?.result, owned, itemSchema, qualityTarget);
          const unavailable = Symbol("citations-unavailable");
          const supplied = typeof handle.getSourceCitations === "function"
            ? await boundedOptional(() => handle.getSourceCitations(handle.result), unavailable) : handle.sourceCitations ?? [];
          if (supplied === unavailable) throw failure("REVIEW_ITEM_EVIDENCE_UNAVAILABLE", "Program evidence lookup did not complete within the remaining review window.");
          const proven = await proveReport(handle.result, supplied, owned, false, qualityTarget);
          report = proven.report; itemCitations = proven.citations;
          // A transport's observable public read set is a publication guard,
          // even when caching is disabled. Cache limits must not waive source
          // currentness for an otherwise usable larger review.
          const observed = clone(handle.reviewEvidence);
          if (observed?.unstable === false && observed.files?.length && !observed.missing?.length
            && observed.files.every(file => evidencePath(root, file))) {
            if (!await reviewReadEvidenceMatches(root, observed, { fingerprint: checkedFingerprint, maxFiles: Infinity }))
              throw failure("REVIEW_COLLECTION_STALE", "A program-observed review dependency changed before publication.");
            checkedReadEvidence.push(observed);
          }
          if (passItemKey && isCompletePassItem(report, owned)) {
            itemReadEvidence = await boundedOptional(async () => {
              const readEvidence = clone(handle.reviewEvidence);
              return await reviewReadEvidenceMatches(root, readEvidence) ? readEvidence : null;
            });
            if (itemReadEvidence) checkedReadEvidence.push(itemReadEvidence);
          }
          await ensureCurrent();
        }
        readyToPersist = true;
      } catch (error) {
        if (terminal(error) || abortSignal?.aborted) throw terminal(error) ? error
          : failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
        itemError = { itemId, code: error.code ?? "REVIEW_ITEM_FAILED", reason: String(error.message ?? error), objectIds,
          ...(error.reviewDiagnostic ? { diagnostic: clone(error.reviewDiagnostic) } : {}) };
        let recovered = error.partialReview;
        if (!recovered && typeof handle?.recoverProgress === "function") recovered = await boundedOptional(() => handle.recoverProgress(error));
        if (typeof error.partialReviewIsActive === "function" && !error.partialReviewIsActive()) recovered = null;
        const partial = partialReport(recovered, owned, fileQuality);
        const supplied = recovered?.citations ?? [];
        const proven = await proveReport(partial, supplied, owned, true, qualityTarget);
        const accepted = new Map(proven.report.metricObjectJudgements.map(row => [row.objectId, row]));
        report = { ...proven.report, ...(classification ?? {}), metricObjectJudgements: (findingsOnly ? [] : owned).map(object => accepted.get(object.objectId)
          ?? { objectId: object.objectId, judgement: "UNVERIFIED", reason: `${itemError.code}: this review item was not completed.`, evidence: [] }) };
        if (qualityTarget && !report.fileAssessments.some(file => file.path === qualityTarget.path))
          report.fileAssessments.push({ path: qualityTarget.path, status: "UNVERIFIED", reason: `${itemError.code}: this file-quality review was not completed.`, evidence: [] });
        itemCitations = proven.citations;
        await ensureCurrent();
        readyToPersist = true;
      } finally {
        // Results must survive a hung transport close or a later outer decision failure.
        try {
          if (readyToPersist) {
            const checked = findingsOnly ? (!itemError || report.findings.length ? owned.length : 0)
              : report.metricObjectJudgements.filter(row => !itemError || row.judgement !== "UNVERIFIED").length;
            const entry = { itemId, objectIds, sourceIds, path: itemPath, status: itemError ? "UNVERIFIED" : "COMPLETED",
              ...(fileQuality ? { kind: "file-quality", ...(qualityTarget ? { qualityTarget } : {}) } : {}),
              result: report, sourceCitations: itemCitations, failure: itemError, completedAt: new Date().toISOString(),
              ...(passItemKey ? { passReuseInputKey: passInputKey, passReuseItemKey: passItemKey } : {}),
              ...(itemReadEvidence ? { reviewEvidence: itemReadEvidence } : {}),
              ...(reusedFrom ? { reusedFrom } : {}) };
            await durable(itemPath, entry);
            reports.push(report); citations.push(...itemCitations);
            collection.items.push({ itemId, objectIds, sourceIds, path: itemPath, status: entry.status,
              ...(fileQuality ? { kind: "file-quality", ...(qualityTarget ? { qualityTarget } : {}) } : {}),
              ...(reusedFrom ? { reusedFrom } : {}) });
            if (itemError) collection.failures.push(itemError); else collection.completedItems++;
            collection.reviewedObjects += checked;
            if (reusedFrom) { collection.reusedItems++; collection.reusedObjects += checked; }
            await persistProgress();
            if (passItemKey && itemReadEvidence && !itemError && isCompletePassItem(report, owned)) {
              passIndex.items[passItemKey] = { itemPath, itemHash: sha256(`${JSON.stringify(entry, null, 2)}\n`) };
              await boundedOptional(() => outsideDecision(() => saveReviewPassIndex(passIndexPath, passIndex)));
            }
          }
        } finally {
          if (handle) await boundedOptional(() => handle.close?.());
        }
      }
    }
    await ensureCurrent({ final: true });
    collection.complete = collection.failures.length === 0;
    collection.status = collection.complete ? "COMPLETED" : "UNVERIFIED";
    await persistProgress();
    const result = { summary: `Reviewed ${collection.reviewedObjects}/${collection.totalObjects} objects in ${collection.totalItems} isolated tasks; ${cacheableRole ? `reused ${collection.reusedItems} items/${collection.reusedObjects} objects; ` : ""}${collection.totalItems - collection.completedItems} tasks remain unverified.`,
      findings: reports.flatMap(report => report.findings ?? []),
      metricObjectJudgements: reports.flatMap(report => report.metricObjectJudgements ?? []),
      fileAssessments: mergeFileAssessments(reports), ...(classification ?? {}) };
    return { result, collection, sourceCitations: citations, getSourceCitations: async () => clone(citations), close: async () => {} };
  } catch (error) {
    collection.status = error.code === "REVIEW_COLLECTION_CANCELLED" ? "CANCELLED" : "STALE";
    collection.complete = false;
    collection.failures.push({ code: error.code ?? "REVIEW_COLLECTION_FAILED", reason: String(error.message ?? error) });
    await persistProgress();
    error.collection = collection;
    throw error;
  }
}
