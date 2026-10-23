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

export function assertReviewScopeActive({ request, deadlineAt = Infinity, abortSignal = null }) {
  if (request.reviewScope?.boundedBasis !== true) return;
  if (abortSignal?.aborted || Date.now() >= deadlineAt)
    throw Object.assign(new Error("The short Stop review ended during source preparation; its unchecked scope remains UNVERIFIED."),
      { code: abortSignal?.aborted ? "REVIEWER_CANCELLED" : "REVIEWER_DEADLINE", reviewerRuntimeFailure: true });
}

function scopeWriter(directory, assertActive = () => {}) {
  let serial = 0;
  const file = suffix => path.join(directory, `${String(++serial).padStart(5, "0")}-${suffix}`);

  async function writeIndex(records, name, extra = {}) {
    const pages = [];
    let batch = [];
    const flush = async () => {
      assertActive();
      const target = file(`${name}-index.json`);
      await atomicWriteJson(target, { kind: "records", records: batch });
      assertActive();
      pages.push({ path: target, records: batch.length }); batch = [];
    };
    for (const record of records) {
      assertActive();
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
        assertActive();
        if (group.length && bytes({ kind: "index", pages: [...group, child] }) + 1 > REVIEW_SCOPE_PAGE_BYTES) {
          const target = file(`${name}-tree.json`);
          await atomicWriteJson(target, { kind: "index", pages: group });
          assertActive(); next.push({ path: target }); group = [];
        }
        group.push(child);
      }
      if (group.length) {
        assertActive();
        const target = file(`${name}-tree.json`);
        await atomicWriteJson(target, { kind: "index", pages: group });
        assertActive(); next.push({ path: target });
      }
      if (next.length >= children.length) throw fail("The review navigation path is too large to page.");
      children = next;
    }
    const target = file(`${name}.json`);
    assertActive();
    await atomicWriteJson(target, { kind: "index", pages: children, ...extra });
    assertActive();
    return { path: target, records: records.length };
  }

  async function writeOriginal(value, name, { required = false, compact = false } = {}) {
    assertActive();
    const text = JSON.stringify(value, null, compact ? undefined : 2), source = Buffer.from(text, "utf8"), parts = [];
    for (let offset = 0; offset < source.length;) {
      assertActive();
      let end = Math.min(offset + REVIEW_SCOPE_PAGE_BYTES, source.length);
      while (end < source.length && (source[end] & 0xc0) === 0x80) end--;
      const body = source.subarray(offset, end), target = file(`${name}.txt`);
      await atomicWrite(target, body.toString("utf8"));
      assertActive();
      parts.push({ path: target, offset, bytes: body.length, sha256: sha256(body) }); offset = end;
    }
    const descriptor = await writeIndex(parts, name, { encoding: "UTF8_JSON_CONCATENATE", sourceBytes: source.length,
      sourceSha256: sha256(source), ...(compact ? { jsonFormat: "COMPACT_VALUE_PRESERVING" } : {}),
      ...(required ? { required: true, read: "ALL_PARTS_IN_OFFSET_ORDER" } : {}),
      instructions: `${required ? "Read ALL original parts" : "Read the needed parts"} in offset order. Concatenate their exact UTF-8 contents to recover the original JSON; parts may end inside a JSON string. Index metadata is not original evidence.` });
    return required ? { ...descriptor, required: true, read: "ALL_PARTS_IN_OFFSET_ORDER" } : descriptor;
  }
  return { writeIndex, writeOriginal };
}

/** Keep the final serialized Stop request bounded, including materializer references. */
export async function finalizeReviewScopeRequest({ requestDirectory, request, phase = "final", deadlineAt = Infinity, abortSignal = null }) {
  const assertActive = () => assertReviewScopeActive({ request, deadlineAt, abortSignal });
  assertActive();
  if (!request.reviewScope || bytes(request) + 1 <= REVIEW_SCOPE_REQUEST_BYTES) return request;
  if (request.reviewScope.boundedBasis !== true)
    throw fail("The short review request exceeds its bounded input size; the obligation must remain unverified rather than truncate its requirements.");
  const { writeOriginal } = scopeWriter(path.join(requestDirectory, "review-scope", "request-basis", phase), assertActive);
  const basis = await writeOriginal(request, "required-request-basis", { required: true });
  const keys = ["schemaVersion", "taskId", "assessmentMode", "groundTruthPath", "transcript", "population", "hook",
    "reviewScope", "fixedStopClassification", "skillGroundTruthPath", "skillSourcePath", "semanticReviewRequestPath"];
  const prepared = Object.fromEntries(keys.filter(key => Object.hasOwn(request, key)).map(key => [key, request[key]]));
  if (request.currentGroundTruth) prepared.currentGroundTruth = Object.fromEntries(
    ["path", "version", "digest", "frozenAtVersion"].filter(key => Object.hasOwn(request.currentGroundTruth, key))
      .map(key => [key, request.currentGroundTruth[key]]));
  prepared.reviewSources = { ...request.reviewSources, requiredRequestBasis: basis };
  prepared.instructions = [
    "This is a navigation view of an exact, complete request. Before deciding, read reviewSources.requiredRequestBasis in full and apply ALL of its original instructions, conditions, exceptions and source declarations. Follow any required basis pointers inside it. Omitted inline fields are deferred originals, never waived obligations. Recover original JSON by following every index page and concatenating UTF-8 parts in offset order; cite original part paths and line ranges, not navigation metadata.",
    request.reviewScope.kind === "baseline"
      ? "This session aligns the current Ground Truth with the original task sources. Read the complete required Ground Truth and request bases before claiming alignment; preserve this role's extraction schema and do not emit metric judgements. If the available context cannot establish the basis, explicitly disclose the missing basis in the result."
      : "Keep this session's assigned object identities and fixed Stop classification. Read each assigned object's complete required basis and all applicable common constraints before judging it. If the available context cannot establish compliance, return UNVERIFIED with the missing basis.",
  ];
  if (bytes(prepared) + 1 > REVIEW_SCOPE_REQUEST_BYTES)
    throw fail("The short review's identities and source navigation exceed the bounded input size; its basis remains unverified rather than truncate identity or source references.");
  assertActive();
  return prepared;
}

/** Bounded originals are retrieval sources, never a summary or a new baseline. */
export async function prepareReviewScope({ projectRoot, requestDirectory, request, evidence = null, deadlineAt = Infinity, abortSignal = null }) {
  assertReviewScopeActive({ request, deadlineAt, abortSignal });
  let prepared = clone(request);
  const captured = clone(evidence);
  if (!prepared.reviewScope) return { request: prepared, evidence: captured };
  const scope = prepared.reviewScope, classification = scope.kind === "classification", baseline = scope.kind === "baseline";
  const boundedBasis = scope.boundedBasis === true;
  const assertActive = () => assertReviewScopeActive({ request: prepared, deadlineAt, abortSignal });
  assertActive();
  const directory = path.join(requestDirectory, "review-scope");
  const { writeIndex, writeOriginal } = scopeWriter(directory, assertActive);

  const canonicalPath = scope.originalGroundTruthPath ?? prepared.groundTruthPath ?? prepared.currentGroundTruth?.path;
  let canonical = captured?.groundTruth ?? null;
  if (!canonical && canonicalPath) canonical = await readJson(path.resolve(projectRoot, canonicalPath));
  assertActive();
  const sources = new Set(scope.sourceIds ?? []);
  const objectIds = new Set(scope.objectIds ?? []);
  const allowedCategories = classification ? classificationCategories : globalCategories;
  let scopedTruth = null;
  const reviewSources = {};
  if (canonical) {
    const selected = (canonical.claims ?? []).filter(claim => baseline || sources.has(claim.claimId) || allowedCategories.has(claim.category));
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
    scopedTruth = { ...(baseline ? canonical : { schemaVersion: canonical.schemaVersion, taskId: canonical.taskId, version: canonical.version,
      digest: canonical.digest, frozenAtVersion: canonical.frozenAtVersion }), claims: selected,
      reviewScope: { originalDigest: canonical.digest, viewDigest: sha256(selected), selectedSourceIds: [...sources], dependencyCompleteness: "NOT_PROVEN" } };
    if (bytes(scopedTruth) + 1 > REVIEW_SCOPE_PAGE_BYTES) {
      if (!classification && !boundedBasis) throw fail("This obligation and its common constraints exceed the short review's Ground Truth budget; it remains unverified, not truncated.");
      const required = boundedBasis && !classification;
      const basis = await writeOriginal(scopedTruth, classification ? "classification-basis" : "required-ground-truth-basis", { required, compact: required });
      if (classification) reviewSources.classificationBasis = basis;
      if (required) reviewSources.requiredGroundTruthBasis = basis;
      scopedTruth = { schemaVersion: canonical.schemaVersion, taskId: canonical.taskId, version: canonical.version,
        digest: canonical.digest, frozenAtVersion: canonical.frozenAtVersion, claims: [],
        reviewScope: { ...scopedTruth.reviewScope, claimCount: selected.length,
          ...(classification ? { deferredClassificationBasis: true } : {}),
          ...(required ? { deferredRequiredBasis: true, requiredBasis: basis,
            instructions: "claims is an empty navigation placeholder, not an empty requirement set. Read the complete requiredBasis, including all common constraints and conditions, before deciding." } : {}) } };
    }
    if (bytes(scopedTruth) + 1 > REVIEW_SCOPE_PAGE_BYTES)
      throw fail("The Ground Truth's identity and required source navigation exceed a bounded page; its basis remains unverified.");
    reviewSources.originalGroundTruth = await writeOriginal(canonical, "original-ground-truth");
    prepared.groundTruthPath = path.join(requestDirectory, "ground-truth.json");
    if (prepared.currentGroundTruth) prepared.currentGroundTruth = { ...prepared.currentGroundTruth, path: prepared.groundTruthPath };
  }

  const population = captured?.population ?? prepared.population;
  let exactDescriptions = null;
  if (boundedBasis && population != null && canonical && bytes(population) > 8 * 1024) {
    const claims = new Map((canonical.claims ?? []).map(claim => [claim.claimId, claim]));
    const normalized = { ...population, metrics: Object.fromEntries(Object.entries(population.metrics ?? {}).map(([metric, rows]) => [metric,
      rows.map(object => {
        const claim = claims.get(object.sourceId);
        // This is exact substitution, not a summary. Keep applicability and
        // every other object field; never infer equivalence from similar text.
        if (!sources.has(object.sourceId) || !claim || typeof object.description !== "string" || object.description !== claim.text
          || Object.hasOwn(object, "descriptionBasis") || object.sourceRevisionId && object.sourceRevisionId !== claim.revisionId) return object;
        return { ...object, description: "Read descriptionBasis's exact Ground Truth text once; it is shared by this obligation's metric objects.",
          descriptionBasis: { kind: "EXACT_GROUND_TRUTH_TEXT", claimId: claim.claimId, revisionId: claim.revisionId ?? null } };
      })])) };
    if (bytes(normalized) <= 8 * 1024) exactDescriptions = normalized;
  }
  if (exactDescriptions) {
    prepared.population = exactDescriptions;
    reviewSources.originalPopulation = await writeOriginal(population, "original-population");
  } else if (boundedBasis && population != null && bytes(population) > 8 * 1024) {
    const basis = await writeOriginal(population, "required-population-basis", { required: true });
    reviewSources.requiredPopulationBasis = basis;
    const keep = ["objectId", "metricId", "sourceId", "sourceRevisionId", "verificationTarget", "authority", "hard", "evidenceRequired"];
    const populationKeys = ["schemaVersion", "catalogVersion", "taskId", "version", "groundTruthVersion", "digest"];
    prepared.population = { ...Object.fromEntries(populationKeys.filter(key => Object.hasOwn(population, key)).map(key => [key, population[key]])),
      metrics: Object.fromEntries(Object.entries(population.metrics ?? {}).map(([metric, rows]) => [metric, rows.map((object, index) => ({
        ...Object.fromEntries(keep.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]])),
        description: "Read requiredBasis for this object's complete original description, applicability, conditions and remaining fields before judging it.",
        requiredBasis: { ...basis, jsonPointer: `/metrics/${metric.replaceAll("~", "~0").replaceAll("/", "~1")}/${index}` },
      }))])), reviewScope: { disclosureView: true, requiredBasis: basis } };
  } else if (boundedBasis && population != null) prepared.population = population;

  const snapshot = captured?.snapshot;
  if (snapshot) {
    const entries = [], pairs = new Map(), classificationEntries = [];
    let latestAssistant = null, latestUser = null;
    const blocksOf = entry => typeof entry.message?.content === "string"
      ? [{ type: "text", text: entry.message.content }] : entry.message?.content ?? [];
    const genuineUser = entry => entry.type === "user" && !entry.isMeta && blocksOf(entry).some(block => block.type !== "tool_result"
      && (block.type !== "text" || !String(block.text ?? "").includes("[runtime-corrector:internal]")));
    const assistantText = entry => entry.type === "assistant" && !entry.isMeta
      && blocksOf(entry).some(block => block.type === "text" && block.text?.trim());
    const classificationOnly = boundedBasis && classification;
    const latestAssistantIndex = classificationOnly ? (snapshot.entries ?? []).findLastIndex(assistantText) : -1;
    for (const [index, entry] of (snapshot.entries ?? []).entries()) {
      if (classificationOnly && !genuineUser(entry) && index !== latestAssistantIndex) continue;
      const source = await writeOriginal(entry, `transcript-${index}`);
      const record = { index, type: entry.type, key: entry.uuid ?? entry.message?.id ?? null, isMeta: entry.isMeta === true, source };
      entries.push(record);
      const blocks = blocksOf(entry);
      if (genuineUser(entry)) { classificationEntries.push(record); latestUser = record; }
      if (assistantText(entry)) latestAssistant = record;
      if (classificationOnly) continue;
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
    assertActive();
    await atomicWriteJson(target, { schemaVersion: "runtime-corrector.paged-transcript.v1", digest: snapshot.digest,
      cursor: snapshot.lastEntryKey, entryCount: entries.length, entryIndex, toolIndex, classificationIndex,
      ...(classificationOnly ? { sourceEntryCount: snapshot.entries?.length ?? 0, classificationOnly: true,
        latestUser, latestAssistant } : {}),
      instructions: classificationOnly
        ? "Classify from latestAssistant and latestUser first. Consult earlier genuine users through classificationIndex or goal originals ONLY if needed to disambiguate this Stop's scope. Do not verify every requirement or reload all original users. Tool history is outside this classification session; absence here cannot establish execution or compliance."
        : "Use entryIndex for original messages and toolIndex for exact input/result pairs. Every source has ordered bounded UTF-8 parts; read every part needed for a conclusion. A missing or ambiguous pair cannot prove execution. Classification reads genuine user messages and the latest assistant via classificationIndex, not the entire tool history." });
    assertActive();
    prepared.transcript = { path: target, digest: snapshot.digest ?? null, cursor: snapshot.lastEntryKey ?? null, paged: true };
  }
  if (prepared.processToolEvidence) {
    reviewSources.processToolEvidence = await writeOriginal(prepared.processToolEvidence, "process-tool-evidence");
    delete prepared.processToolEvidence;
  }
  if (prepared.sourceManifest) {
    // File hashes are program-side validation data, not reading instructions.
    // Keep every other field, including any semantic metadata, in navigation.
    const navigation = boundedBasis ? prepared.sourceManifest.map(({ sha256: _hash, ...entry }) => entry) : prepared.sourceManifest;
    if (boundedBasis) reviewSources.originalSourceManifest = await writeOriginal(prepared.sourceManifest, "original-source-manifest");
    reviewSources.sourceManifest = await writeIndex(navigation, "source-manifest");
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
  const scopeInstruction = !boundedBasis
    ? "This short session owns ONLY reviewScope.objectIds. The scoped Ground Truth is a disclosure view of the unchanged canonical baseline, not permission to rewrite or waive obligations. Common constraints are preserved; dependency completeness is NOT proven. When a condition, exception or cross-source dependency is unclear, consult reviewSources.originalGroundTruth and the original message/tool indexes. Never infer compliance from omitted context or navigation metadata. Read only evidence needed for these objects; do not reload the whole history. reviewSources.sourceManifest is the paged sourceManifest, and reviewSources.processToolEvidence is its paged execution index. Give each assigned object one concise diagnosis and concrete source locations, with no copied quotations. If this scope cannot be checked within the available context, return UNVERIFIED and explain the missing basis."
    : classification
    ? "This session ONLY classifies the current Stop; it cannot establish PASS or waive requirements. Use the hook's last assistant message and the transcript index's latestAssistant/latestUser first. Consult earlier user messages and reviewSources.classificationBasis only when the stopping scope is ambiguous. Do not read all historical messages, all goals or all business source files to classify a Stop. Omitted inline goals are deferred originals, not absent requirements; complete obligation checking belongs to subsequent isolated review items. Keep all finding and judgement arrays empty."
    : baseline
    ? "This session aligns the current Ground Truth with original task sources; it does not own metric judgements. The Ground Truth disclosure retains every existing claim. Read reviewSources.requiredGroundTruthBasis in full when present, then use reviewSources.originalGroundTruth and the original message/tool indexes to resolve source conditions, exceptions and changes. If reviewSources.requiredRequestBasis is present, read it in full and apply all original instructions and source declarations. Follow every index page and read the exact UTF-8 parts in offset order; metadata and empty inline claim arrays are navigation, not evidence of an empty baseline. Preserve this role's extraction schema and disclose any missing basis explicitly."
    : "This short session owns ONLY reviewScope.objectIds. The scoped Ground Truth is a disclosure view of the unchanged canonical baseline, not permission to rewrite or waive obligations. Common constraints are preserved; dependency completeness is NOT proven. When present, read reviewSources.requiredGroundTruthBasis and every assigned object's requiredBasis in full before judging; empty inline claims and deferred descriptions are navigation placeholders, not absent requirements. When a condition, exception or cross-source dependency is unclear, consult reviewSources.originalGroundTruth and the original message/tool indexes. Never infer compliance from omitted context or navigation metadata. Read only evidence needed for these objects; do not reload the whole history. reviewSources.sourceManifest is the paged sourceManifest, and reviewSources.processToolEvidence is its paged execution index. Follow every index page and reconstruct needed original JSON by concatenating exact UTF-8 parts in offset order. Give each assigned object one concise diagnosis and original part/source paths with line ranges, with no copied quotations. If this scope cannot be checked within the available context, return UNVERIFIED and explain the missing basis.";
  prepared.instructions = [...(Array.isArray(prepared.instructions) ? prepared.instructions : [prepared.instructions].filter(Boolean)), scopeInstruction,
    ...(boundedBasis && !classification ? [
      "sourceManifest navigation omits only per-file SHA-256 values, which the program validates against originalSourceManifest. All other metadata is preserved. Locate needed sources through the navigation; do not reread the audit manifest merely to inspect hashes.",
      "requiredGroundTruthBasis already contains the complete selected obligation, common constraints and explicit dependencies. After reading it, do not also read originalGroundTruth unless a specific unresolved condition or dependency requires an omitted original claim. Avoid retrieving duplicate basis text or unrelated history.",
      "A population descriptionBasis with kind EXACT_GROUND_TRUTH_TEXT refers to byte-identical text in that claim at the given revision. Read that claim through groundTruthPath or requiredGroundTruthBasis once, retaining each object's other fields and applicability. originalPopulation is an exact audit copy; do not read it again merely to repeat those identical descriptions.",
    ] : [])];
  prepared = await finalizeReviewScopeRequest({ requestDirectory, request: prepared, phase: "scoped", deadlineAt, abortSignal });
  assertActive();
  const scopedEvidence = captured ?? {};
  scopedEvidence.snapshot = null;
  if (scopedTruth) scopedEvidence.groundTruth = scopedTruth;
  if (boundedBasis && prepared.population != null) scopedEvidence.population = prepared.population;
  return { request: prepared, evidence: scopedEvidence };
}
