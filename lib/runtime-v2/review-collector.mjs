import { promises as fs } from "node:fs";
import path from "node:path";

import { validateJsonSchema } from "../json-schema-validator.mjs";
import { DEFAULT_REVIEW_TIMEOUT_MS, MIN_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";
import { outsideDecision } from "./decision-scope.mjs";
import { OBJECT_JUDGEMENTS } from "./metrics.mjs";
import { emptyReviewPassIndex, isCompletePassItem, loadReviewPassIndex, readReviewPassItem, reviewPassInputKey,
  reviewPassItemKey, reviewReadEvidenceMatches, saveReviewPassIndex } from "./review-pass-cache.mjs";
import { decisionGuard, taskDirectory } from "./task-store.mjs";
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

function partition(population, findingsOnly = false) {
  const groups = new Map();
  for (const object of Object.values(population.metrics ?? {}).flat()) {
    const key = JSON.stringify([object.sourceId ?? object.objectId, object.verificationTarget ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  }
  return [...groups.values()].flatMap(objects => {
    if (findingsOnly) return [objects];
    const parts = [];
    for (let start = 0; start < objects.length; start += MAX_OBJECTS_PER_ITEM)
      parts.push(objects.slice(start, start + MAX_OBJECTS_PER_ITEM));
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
  const items = partition(population, stopReview && findingsOnly);
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
  async function currentBasis() {
    return outsideDecision(async () => {
      const task = await readJson(taskPath);
      const truth = await readJson(gtPath);
      return {
        guard: task ? { ...decisionGuard({ ...task, groundTruth: task.groundTruth ?? {}, correctionEpoch: task.correctionEpoch ?? {} }),
          cancelled: task.control?.cancelled ?? false, pendingRequirement: task.control?.pendingRequirement ?? null } : null,
        groundTruth: truth == null ? null : sha256(truth),
      };
    });
  }
  const basis = await currentBasis();
  // The ambient transaction may legitimately hold a newer, unpublished GT.
  // Match that caller-owned snapshot while monitoring committed state separately.
  const ambientTruth = await readJson(gtPath);
  const capturedTruthMatches = !ambientTruth || !evidence?.groundTruth || sha256(ambientTruth) === sha256(evidence.groundTruth);
  const collection = {
    schemaVersion: "runtime-corrector.review-collection.v1", runId, role, taskId,
    path: directory, progressPath, mode: findingsOnly ? "findings-only" : "metrics", complete: false, status: "RUNNING", totalItems: items.length,
    totalObjects: allObjects.length, completedItems: 0, reviewedObjects: 0, items: [], failures: [],
    ...(stopReview ? { reusedItems: 0, reusedObjects: 0 } : {}),
    basis: { ...basis, populationVersion: population.version ?? null, populationDigest: population.digest ?? sha256(population),
      groundTruthVersion: evidence?.groundTruth?.version ?? population.groundTruthVersion ?? null,
      groundTruthDigest: evidence?.groundTruth?.digest ?? null }, startedAt: new Date().toISOString(),
  };
  const persistProgress = () => durable(progressPath, { ...collection, updatedAt: new Date().toISOString() });
  const passInputKey = stopReview && !findingsOnly && classification
    ? reviewPassInputKey({ reviewerFactory, reviewer, role, taskId, basis, classification, schema, request, evidence,
      execution: Object.fromEntries(Object.entries(execution).filter(([, value]) => typeof value !== "function")) }) : null;
  const passItemKeys = passInputKey ? items.map(owned => reviewPassItemKey(passInputKey, owned)) : [];
  const passIndexPath = path.join(taskDirectory(root, taskId), "review-pass-cache.json");
  let passIndex = emptyReviewPassIndex(passInputKey);
  async function ensureCurrent() {
    if (abortSignal?.aborted) throw failure("REVIEW_COLLECTION_CANCELLED", "The review collection was cancelled.");
    if (Date.now() >= deadlineAt)
      throw failure("REVIEW_COLLECTION_STALE", "The review collection's shared publication deadline expired.");
    if (!capturedTruthMatches)
      throw failure("REVIEW_COLLECTION_STALE", "The supplied Ground Truth is already stale.");
    const current = await currentBasis();
    if (sha256(current) !== sha256(basis) || current.guard?.cancelled)
      throw failure("REVIEW_COLLECTION_STALE", "The task or canonical Ground Truth changed during review.");
    if (typeof execution.evidenceMatches === "function" && !await execution.evidenceMatches())
      throw failure("REVIEW_COLLECTION_STALE", "The frozen evidence changed during review.");
    for (const source of sources.values()) {
      try {
        const bytes = await fs.readFile(source.frozen ? source.snapshotPath : source.path);
        if (sha256(bytes) !== source.contentHash) throw new Error("changed");
      } catch {
        throw failure("REVIEW_COLLECTION_STALE", "A checked source changed or disappeared during review.");
      }
    }
    for (const readEvidence of checkedReadEvidence)
      if (!await reviewReadEvidenceMatches(root, readEvidence))
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
      start, end, exactQuote: rows.slice(start - 1, end).join("\n"), usedBy: [owner] };
  }
  async function proveReport(report, supplied, owned, partial = false) {
    const result = clone(report), accepted = [], selected = [];
    for (const row of result.metricObjectJudgements ?? []) {
      try {
        const refs = [];
        for (const ref of row.evidence ?? []) refs.push(await capture(ref, row.objectId, supplied));
        if (["PASS", "DEVIATION"].includes(row.judgement) && !refs.length)
          throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "PASS and DEVIATION require checked original evidence.");
        row.evidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        selected.push(...refs); accepted.push(row);
      } catch (error) {
        if (terminal(error) || !partial) throw error;
      }
    }
    result.metricObjectJudgements = accepted;
    const acceptedFindings = [];
    for (const finding of result.findings ?? []) {
      try {
        const refs = [];
        for (const ref of finding.actualEvidence ?? finding.evidence ?? []) refs.push(await capture(ref, finding.deviationKey, supplied));
        if (!refs.length) throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "A finding requires checked original evidence.");
        if (finding.actualEvidence) finding.actualEvidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        else finding.evidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        selected.push(...refs); acceptedFindings.push(finding);
      } catch (error) { if (terminal(error) || !partial) throw error; }
    }
    result.findings = acceptedFindings;
    const fileAssessments = [];
    for (const file of result.fileAssessments ?? []) {
      try {
        const refs = [];
        for (const ref of file.evidence ?? []) refs.push(await capture(ref, file.path, supplied, true));
        if (["PASS", "DEVIATION"].includes(file.status) && !refs.length)
          throw failure("REVIEW_ITEM_EVIDENCE_INVALID", "A file verdict requires checked original evidence.");
        file.evidence = refs.map(ref => ref.frozen ? ref.selection : `${ref.path}#L${ref.start}-L${ref.end}`);
        selected.push(...refs); fileAssessments.push(file);
      } catch (error) { if (terminal(error) || !partial) throw error; }
    }
    if (result.fileAssessments) result.fileAssessments = fileAssessments;
    return { report: result, citations: selected };
  }
  function validateReport(report, owned) {
    const issues = validateJsonSchema(report, schema);
    if (issues.length) throw failure("REVIEW_ITEM_INVALID", `${issues[0].pointer}: ${issues[0].message}`);
    const expected = new Set(findingsOnly ? [] : owned.map(object => object.objectId));
    const rows = report.metricObjectJudgements ?? [];
    if (rows.length !== expected.size || new Set(rows.map(row => row.objectId)).size !== rows.length
      || rows.some(row => !expected.has(row.objectId)))
      throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", "A short review omitted, repeated or judged an unassigned object.");
    const sourceIds = new Set(owned.map(object => object.sourceId).filter(Boolean));
    if ((report.findings ?? []).some(finding => !ownedFinding(finding, sourceIds)))
      throw failure("REVIEW_ITEM_OWNERSHIP_INVALID", "A short review finding references an unassigned requirement.");
    if (classification && (report.stopClassification !== classification.stopClassification
      || (report.stage ?? null) !== (classification.stage ?? null)))
      throw failure("REVIEW_ITEM_CLASSIFICATION_INVALID", "A short review changed the caller's Stop classification.");
    if (rows.some(row => !OBJECT_JUDGEMENTS.has(row.judgement) || !row.reason?.trim()
      || !Array.isArray(row.evidence) || row.evidence.some(ref => typeof ref !== "string" || !ref.trim())))
      throw failure("REVIEW_ITEM_INVALID", "A short review returned an invalid judgement.");
  }
  function partialReport(value, owned) {
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
    return { summary: "Partial short review; final verification is incomplete.", findings,
      metricObjectJudgements: accepted, fileAssessments: [] };
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
    const objectIds = [], itemIds = [], rows = [];
    for (let index = startIndex; index < items.length; index++) {
      const owned = items[index];
      const ids = owned.map(object => object.objectId);
      const itemId = `item-${String(index + 1).padStart(4, "0")}`;
      const jsonPointer = `/items/${collection.items.length}`;
      collection.items.push({ itemId, objectIds: ids,
        sourceIds: [...new Set(owned.map(object => object.sourceId).filter(Boolean))],
        path: progressPath, jsonPointer, status: "UNVERIFIED", unstarted: true, reasonCode: code, reason });
      objectIds.push(...ids); itemIds.push(itemId);
      if (!findingsOnly) rows.push(...ids.map(objectId => ({ objectId, judgement: "UNVERIFIED",
        reason: `${code}: this review item was not started.`, evidence: [] })));
    }
    collection.failures.push({ code, reason, objectIds, itemIds, itemCount: itemIds.length });
    reports.push({ summary: "Remaining review items were not started before the aggregation cutoff.",
      findings: [], metricObjectJudgements: rows, fileAssessments: [], ...(classification ?? {}) });
  }
  await persistProgress();
  try {
    if (passInputKey) {
      await ensureCurrent();
      passIndex = await boundedOptional(() => loadReviewPassIndex(passIndexPath, passInputKey, passItemKeys), passIndex);
    }
    for (const [index, owned] of items.entries()) {
      // Once dispatch closes, account for the remaining scope in memory and
      // publish it in the single final progress write. Do not repeat source
      // validation or create a file for each task that was never started.
      if (deadlineAt - Date.now() - summaryReserveMs < MIN_REVIEW_TIMEOUT_MS + CLEANUP_GRACE_MS) {
        recordUnstarted(index);
        break;
      }
      await ensureCurrent();
      const objectIds = owned.map(object => object.objectId), sourceIds = [...new Set(owned.map(object => object.sourceId).filter(Boolean))];
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
        const instructions = Array.isArray(request.instructions) ? request.instructions : request.instructions ? [request.instructions] : [];
        const localRequest = { ...request, population: localPopulation,
          instructions: [...instructions,
            findingsOnly
              ? `This short review owns ONLY these sourceIds: ${JSON.stringify(sourceIds)}. Return findings for their actual HARD violations at this Stop, and return no metric judgements or file assessments. Do not invent or omit a mandatory violation solely because the assistant calls this Stop intermediate.`
              : `This short review owns ONLY these objectIds: ${JSON.stringify(objectIds)}. Return exactly one judgement per assigned object and no foreign requirement findings.`,
            ...(classification ? [`Keep stopClassification=${classification.stopClassification} and stage=${JSON.stringify(classification.stage ?? null)} fixed. This is the caller's review scope, not a PASS claim.`] : []),
            "Keep each reason short: name the concrete mechanism and consequence. Select evidence path and line ranges; do not generate quotations or repeat the request.",
            "Read the evidence relevant to the assigned obligation, its actual conditions and applicable global constraints. The source manifest is navigation, not a requirement to read every file. Do not reload the complete transcript or unrelated source bodies."],
          reviewScope: { objectIds, sourceIds, ...(role === "stop-reviewer" ? { boundedBasis: true } : {}),
            ...(findingsOnly ? { findingsOnly: true } : {}) }, ...(classification ? { fixedStopClassification: classification } : {}) };
        const localEvidence = evidence == null ? null : { ...evidence, population: localPopulation };
        if (passItemKey && passIndex.items[passItemKey]) {
          const cached = await boundedOptional(() => readReviewPassItem({ taskRoot: taskDirectory(root, taskId),
            record: passIndex.items[passItemKey], inputKey: passInputKey, itemKey: passItemKey }));
          if (cached && await boundedOptional(() => reviewReadEvidenceMatches(root, cached.reviewEvidence), false)) {
            let proven = null;
            try {
              validateReport(cached.result, owned);
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
            schema, request: localRequest, evidence: localEvidence, deadlineAt, abortSignal }, dispatchTimeoutMs);
          validateReport(handle?.result, owned);
          const unavailable = Symbol("citations-unavailable");
          const supplied = typeof handle.getSourceCitations === "function"
            ? await boundedOptional(() => handle.getSourceCitations(handle.result), unavailable) : handle.sourceCitations ?? [];
          if (supplied === unavailable) throw failure("REVIEW_ITEM_EVIDENCE_UNAVAILABLE", "Program evidence lookup did not complete within the remaining review window.");
          const proven = await proveReport(handle.result, supplied, owned);
          report = proven.report; itemCitations = proven.citations;
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
        itemError = { itemId, code: error.code ?? "REVIEW_ITEM_FAILED", reason: String(error.message ?? error), objectIds };
        let recovered = error.partialReview;
        if (!recovered && typeof handle?.recoverProgress === "function") recovered = await boundedOptional(() => handle.recoverProgress(error));
        if (typeof error.partialReviewIsActive === "function" && !error.partialReviewIsActive()) recovered = null;
        const partial = partialReport(recovered, owned);
        const supplied = recovered?.citations ?? [];
        const proven = await proveReport(partial, supplied, owned, true);
        const accepted = new Map(proven.report.metricObjectJudgements.map(row => [row.objectId, row]));
        report = { ...proven.report, ...(classification ?? {}), metricObjectJudgements: (findingsOnly ? [] : owned).map(object => accepted.get(object.objectId)
          ?? { objectId: object.objectId, judgement: "UNVERIFIED", reason: `${itemError.code}: this review item was not completed.`, evidence: [] }) };
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
              result: report, sourceCitations: itemCitations, failure: itemError, completedAt: new Date().toISOString(),
              ...(passItemKey ? { passReuseInputKey: passInputKey, passReuseItemKey: passItemKey } : {}),
              ...(itemReadEvidence ? { reviewEvidence: itemReadEvidence } : {}),
              ...(reusedFrom ? { reusedFrom } : {}) };
            await durable(itemPath, entry);
            reports.push(report); citations.push(...itemCitations);
            collection.items.push({ itemId, objectIds, sourceIds, path: itemPath, status: entry.status,
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
    await ensureCurrent();
    collection.complete = collection.failures.length === 0;
    collection.status = collection.complete ? "COMPLETED" : "UNVERIFIED";
    await persistProgress();
    const result = { summary: `Reviewed ${collection.reviewedObjects}/${collection.totalObjects} objects in ${collection.totalItems} isolated tasks; ${stopReview ? `reused ${collection.reusedItems} items/${collection.reusedObjects} objects; ` : ""}${collection.totalItems - collection.completedItems} tasks remain unverified.`,
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
