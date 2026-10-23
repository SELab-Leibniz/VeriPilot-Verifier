import path from "node:path";
import { atomicWrite, atomicWriteJson, readJson, sha256 } from "./utils.mjs";

export const REVIEW_SCOPE_PAGE_BYTES = 16 * 1024;
export const REVIEW_SCOPE_REQUEST_BYTES = 24 * 1024;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
const globalCategories = new Set(["goals", "inScope", "outOfScope", "constraints", "executionContext",
  "evidenceObligations", "decisions", "rejectedAlternatives", "developmentStandards", "workflowSteps",
  "experienceRules", "capabilityChecklist", "milestones", "openQuestions"]);
const classificationCategories = new Set(["goals", "inScope", "outOfScope"]);
const fail = message => Object.assign(new Error(message), { code: "REVIEW_SCOPE_TOO_LARGE" });
const explicitReferences = claim => ["dependsOn", "relatedClaimIds", "conditionClaimIds", "exceptionClaimIds"]
  .flatMap(key => Array.isArray(claim[key]) ? claim[key].filter(id => typeof id === "string") : []);

/** Bounded originals are retrieval sources, never a summary or a new baseline. */
export async function prepareReviewScope({ projectRoot, requestDirectory, request, evidence = null }) {
  const prepared = clone(request), captured = clone(evidence);
  if (!prepared.reviewScope) return { request: prepared, evidence: captured };
  const scope = prepared.reviewScope, classification = scope.kind === "classification";
  const directory = path.join(requestDirectory, "review-scope");
  let serial = 0;
  const file = suffix => path.join(directory, `${String(++serial).padStart(5, "0")}-${suffix}`);

  async function writeIndex(records, name, extra = {}) {
    const pages = [];
    let batch = [];
    const flush = async () => {
      const target = file(`${name}-index.json`);
      await atomicWriteJson(target, { kind: "records", records: batch });
      pages.push({ path: target, records: batch.length }); batch = [];
    };
    for (const record of records) {
      if (bytes({ kind: "records", records: [record] }) + 1 > REVIEW_SCOPE_PAGE_BYTES)
        throw fail("A review navigation record exceeds the bounded page size.");
      if (batch.length && bytes({ kind: "records", records: [...batch, record] }) + 1 > REVIEW_SCOPE_PAGE_BYTES) await flush();
      batch.push(record);
    }
    if (batch.length || !pages.length) await flush();
    let children = pages;
    while (bytes({ kind: "index", pages: children, ...extra }) + 1 > REVIEW_SCOPE_PAGE_BYTES) {
      const next = [];
      let group = [];
      for (const child of children) {
        if (group.length && bytes({ kind: "index", pages: [...group, child] }) + 1 > REVIEW_SCOPE_PAGE_BYTES) {
          const target = file(`${name}-tree.json`);
          await atomicWriteJson(target, { kind: "index", pages: group }); next.push({ path: target }); group = [];
        }
        group.push(child);
      }
      if (group.length) {
        const target = file(`${name}-tree.json`);
        await atomicWriteJson(target, { kind: "index", pages: group }); next.push({ path: target });
      }
      if (next.length >= children.length) throw fail("The review navigation path is too large to page.");
      children = next;
    }
    const target = file(`${name}.json`);
    await atomicWriteJson(target, { kind: "index", pages: children, ...extra });
    return { path: target, records: records.length };
  }

  async function writeOriginal(value, name) {
    const text = JSON.stringify(value, null, 2), source = Buffer.from(text, "utf8"), parts = [];
    for (let offset = 0; offset < source.length;) {
      let end = Math.min(offset + REVIEW_SCOPE_PAGE_BYTES, source.length);
      while (end < source.length && (source[end] & 0xc0) === 0x80) end--;
      const body = source.subarray(offset, end), target = file(`${name}.txt`);
      await atomicWrite(target, body.toString("utf8"));
      parts.push({ path: target, offset, bytes: body.length, sha256: sha256(body) }); offset = end;
    }
    return writeIndex(parts, name, { encoding: "UTF8_JSON_CONCATENATE", sourceBytes: source.length,
      sourceSha256: sha256(source), instructions: "Read the needed parts in offset order. Concatenate their exact UTF-8 contents to recover the original JSON; parts may end inside a JSON string. Index metadata is not original evidence." });
  }

  const canonicalPath = scope.originalGroundTruthPath ?? prepared.groundTruthPath;
  let canonical = captured?.groundTruth ?? null;
  if (!canonical && canonicalPath) canonical = await readJson(path.resolve(projectRoot, canonicalPath));
  const sources = new Set(scope.sourceIds ?? []);
  const objectIds = new Set(scope.objectIds ?? []);
  const allowedCategories = classification ? classificationCategories : globalCategories;
  let scopedTruth = null;
  const reviewSources = {};
  if (canonical) {
    const selected = (canonical.claims ?? []).filter(claim => sources.has(claim.claimId) || allowedCategories.has(claim.category));
    const explicitIds = new Set(selected.flatMap(explicitReferences));
    // Follow only explicitly represented claim identifiers; never guess
    // dependency semantics from words, proximity or a requirement heading.
    for (let count = -1; count !== explicitIds.size;) {
      count = explicitIds.size;
      for (const claim of canonical.claims ?? []) if (explicitIds.has(claim.claimId)) {
        if (!selected.some(item => item.claimId === claim.claimId)) selected.push(claim);
        for (const id of explicitReferences(claim)) explicitIds.add(id);
      }
    }
    scopedTruth = { schemaVersion: canonical.schemaVersion, taskId: canonical.taskId, version: canonical.version,
      digest: canonical.digest, frozenAtVersion: canonical.frozenAtVersion, claims: selected,
      reviewScope: { originalDigest: canonical.digest, viewDigest: sha256(selected), selectedSourceIds: [...sources], dependencyCompleteness: "NOT_PROVEN" } };
    if (bytes(scopedTruth) + 1 > REVIEW_SCOPE_PAGE_BYTES) {
      if (!classification) throw fail("This obligation and its common constraints exceed the short review's Ground Truth budget; it remains unverified, not truncated.");
      reviewSources.classificationBasis = await writeOriginal(scopedTruth, "classification-basis");
      scopedTruth = { ...scopedTruth, claims: [], reviewScope: { ...scopedTruth.reviewScope, deferredClassificationBasis: true } };
    }
    reviewSources.originalGroundTruth = await writeOriginal(canonical, "original-ground-truth");
    prepared.groundTruthPath = path.join(requestDirectory, "ground-truth.json");
    if (prepared.currentGroundTruth) prepared.currentGroundTruth = { ...prepared.currentGroundTruth, path: prepared.groundTruthPath };
  }

  const snapshot = captured?.snapshot;
  if (snapshot) {
    const entries = [], pairs = new Map(), classificationEntries = [];
    let latestAssistant = null;
    for (const [index, entry] of (snapshot.entries ?? []).entries()) {
      const source = await writeOriginal(entry, `transcript-${index}`);
      const record = { index, type: entry.type, key: entry.uuid ?? entry.message?.id ?? null, isMeta: entry.isMeta === true, source };
      entries.push(record);
      const blocks = typeof entry.message?.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message?.content ?? [];
      if (entry.type === "user" && !entry.isMeta && blocks.some(block => block.type !== "tool_result"
        && (block.type !== "text" || !String(block.text ?? "").includes("[runtime-corrector:internal]")))) classificationEntries.push(record);
      if (entry.type === "assistant" && !entry.isMeta && blocks.some(block => block.type === "text" && block.text?.trim())) latestAssistant = record;
      for (const block of blocks) {
        const id = block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : null;
        if (typeof id !== "string") continue;
        const pair = pairs.get(id) ?? { toolUseId: id, inputs: [], results: [] };
        pair[block.type === "tool_use" ? "inputs" : "results"].push({ ...record,
          ...(block.type === "tool_use" ? { name: block.name } : { isError: block.is_error === true }) }); pairs.set(id, pair);
      }
    }
    const entryIndex = await writeIndex(entries, "transcript-entries");
    const toolRecords = [];
    for (const pair of pairs.values()) toolRecords.push({ toolUseId: pair.toolUseId, inputCount: pair.inputs.length,
      resultCount: pair.results.length, source: await writeOriginal(pair, "tool-pair") });
    const toolIndex = await writeIndex(toolRecords, "transcript-tools");
    if (latestAssistant) classificationEntries.push(latestAssistant);
    const classificationIndex = await writeIndex(classificationEntries, "classification-messages");
    const target = path.join(directory, "transcript-index.json");
    await atomicWriteJson(target, { schemaVersion: "runtime-corrector.paged-transcript.v1", digest: snapshot.digest,
      cursor: snapshot.lastEntryKey, entryCount: entries.length, entryIndex, toolIndex, classificationIndex,
      instructions: "Use entryIndex for original messages and toolIndex for exact input/result pairs. Every source has ordered bounded UTF-8 parts; read every part needed for a conclusion. A missing or ambiguous pair cannot prove execution. Classification reads genuine user messages and the latest assistant via classificationIndex, not the entire tool history." });
    prepared.transcript = { path: target, digest: snapshot.digest ?? null, cursor: snapshot.lastEntryKey ?? null, paged: true };
  }
  if (prepared.processToolEvidence) {
    reviewSources.processToolEvidence = await writeOriginal(prepared.processToolEvidence, "process-tool-evidence");
    delete prepared.processToolEvidence;
  }
  if (prepared.sourceManifest) {
    reviewSources.sourceManifest = await writeIndex(prepared.sourceManifest, "source-manifest");
    delete prepared.sourceManifest;
  }
  if (prepared.hook && bytes(prepared.hook) > 1024) {
    reviewSources.hook = await writeOriginal(prepared.hook, "hook");
    prepared.hook = { hookEventName: prepared.hook.hookEventName, stopHookActive: prepared.hook.stopHookActive,
      original: reviewSources.hook, instructions: "Read the original hook parts for the complete last assistant message; this is a navigation view." };
  }
  prepared.reviewScope = { ...scope, originalGroundTruthPath: canonicalPath ?? null, evidenceDirectory: directory,
    objectIds: [...objectIds], sourceIds: [...sources], dependencyCompleteness: "NOT_PROVEN" };
  prepared.reviewSources = reviewSources;
  prepared.instructions = [...(Array.isArray(prepared.instructions) ? prepared.instructions : [prepared.instructions].filter(Boolean)),
    "This short session owns ONLY reviewScope.objectIds. The scoped Ground Truth is a disclosure view of the unchanged canonical baseline, not permission to rewrite or waive obligations. Common constraints are preserved; dependency completeness is NOT proven. When a condition, exception or cross-source dependency is unclear, consult reviewSources.originalGroundTruth and the original message/tool indexes. Never infer compliance from omitted context or navigation metadata. Read only evidence needed for these objects; do not reload the whole history. reviewSources.sourceManifest is the paged sourceManifest, and reviewSources.processToolEvidence is its paged execution index. Give each assigned object one concise diagnosis and concrete source locations, with no copied quotations. If this scope cannot be checked within the available context, return UNVERIFIED and explain the missing basis."];
  if (bytes(prepared) + 1 > REVIEW_SCOPE_REQUEST_BYTES) throw fail("The short review request exceeds its bounded input size; the obligation must remain unverified rather than truncate its requirements.");
  const scopedEvidence = captured ?? {};
  scopedEvidence.snapshot = null;
  if (scopedTruth) scopedEvidence.groundTruth = scopedTruth;
  return { request: prepared, evidence: scopedEvidence };
}
