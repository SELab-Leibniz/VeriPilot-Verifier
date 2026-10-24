// Adapt the tested single-obligation worker to the existing Stop collector.
// Scope selection, metrics, publication, retry and correction remain caller-owned.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskDirectory, decisionGuard } from "./task-store.mjs";
import { atomicWriteJson, safeId, sha256 } from "./utils.mjs";
import { fingerprint } from "./evidence-state.mjs";
import { reviewScopeClaims } from "./review-scope.mjs";
import { METRIC_CATALOG } from "./metrics.mjs";
import { resolveSkillDirectory, scanSkillDirectory } from "./skill-source.mjs";
import * as openclawHost from "../hosts/openclaw.mjs";
import { validateJsonSchema } from "../json-schema-validator.mjs";
import { SKILL_GROUND_TRUTH_REVIEW_SCHEMA } from "./reviewer.mjs";

const within = (root, file) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const privateName = /^(?:\.git|\.aws|\.ssh|\.gnupg|\.azure|\.env(?:\..*)?|\.npmrc|\.pypirc|auth(?:-profiles)?\.json|openclaw\.json|.*(?:credentials|secret|api[-_]?key|keystore|\.p12|\.pfx).*)$/iu;
const excludedDirectory = new Set([".runtime-correction", "node_modules", "oh_modules", ".hvigor", "build", "dist", "__pycache__", ".idea"]);
const textExtension = /\.(?:md|txt|json5?|ya?ml|toml|[cm]?js|jsx|tsx?|ets|py|java|kt|rs|go|[ch](?:pp)?|css|html|xml|csv|sql|sh|ps1)$/iu;
const objectsOf = input => Object.values(input.request?.population?.metrics ?? {}).flat();
const currentTaskApplicability = value => value == null || value === "" || typeof value === "string"
  && ["CURRENT_TASK", "MAIN_TASK"].includes(value.trim().toUpperCase().replaceAll("-", "_"));

export function canUseStopTaskReview(input) {
  const objects = objectsOf(input), object = objects[0], scope = input.request?.reviewScope;
  if (scope?.kind === "classification" || scope?.findingsOnly === true
    || objects.length !== 1 || scope?.objectIds?.length !== 1 || scope.objectIds[0] !== object.objectId
    || !(Object.hasOwn(object, "applicabilityKind") ? object.applicabilityKind === "CURRENT_TASK" : currentTaskApplicability(object.applicability))
    || object.authority === "BASIS_PENDING" || !object.sourceId) return false;
  if (!METRIC_CATALOG[object.metricId]) return false;
  if (input.role === "implementation-reviewer") return ["M09", "M12"].includes(object.metricId) && object.verificationTarget === "IMPLEMENTATION";
  if (input.role !== "stop-reviewer" || input.request.fixedStopClassification?.stopClassification !== "TASK_COMPLETE") return false;
  return true;
}

function proofScope(input, object) {
  if (input.role === "implementation-reviewer") return "SOURCE_IMPLEMENTATION";
  if (["M08", "M11"].includes(object.metricId)) return "PROCESS_COMPLIANCE";
  if (["M13", "M14", "M15"].includes(object.metricId)) return "EXECUTION_CLOSURE";
  if (["M09", "M10", "M12"].includes(object.metricId)) {
    if (object.verificationTarget === "PROCESS") return "PROCESS_COMPLIANCE";
    if (object.verificationTarget === "IMPLEMENTATION") return object.metricId === "M12" ? "RUNTIME_ACCEPTANCE" : "SOURCE_IMPLEMENTATION";
    return object.metricId === "M12" ? "ARTIFACT_EXECUTION" : "METRIC_ARTIFACT_REVIEW";
  }
  return "METRIC_ARTIFACT_REVIEW";
}

export async function runStopTaskReview(input, { runTask, modelRuntime, model } = {}) {
  if (!canUseStopTaskReview(input)) throw new Error("Stop task review received an unsupported scope.");
  input = { ...input, request: structuredClone(input.request), evidence: structuredClone(input.evidence) };
  const root = await fs.realpath(input.projectRoot), object = objectsOf(input)[0];
  const controller = new AbortController(), parents = [...new Set([input.abortSignal, input.signal].filter(Boolean))];
  const stop = () => controller.abort(Object.assign(new Error("Stop task review cancelled."), { code: "REVIEW_COLLECTION_CANCELLED" }));
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + (input.reviewer?.timeoutMs ?? 120000));
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Stop task review deadline expired."), { code: "REVIEW_ITEM_TIMEOUT" })), Math.max(1, deadlineAt - Date.now()));
  for (const signal of parents) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); }
  const active = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (Date.now() >= deadlineAt) throw Object.assign(new Error("Stop task review deadline expired."), { code: "REVIEW_ITEM_TIMEOUT" });
  };
  try {
    active();
    const statePath = path.join(taskDirectory(root, input.taskId), "task.json");
    const taskGuard = async () => {
      const state = await fs.readFile(statePath, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      return state ? { ...decisionGuard(state), cancelled: state.control?.cancelled ?? false,
        pendingRequirement: state.control?.pendingRequirement ?? null } : null;
    };
    const initialGuard = await taskGuard(); active();
    if (initialGuard?.cancelled) throw Object.assign(new Error("Stop task is cancelled."), { code: "REVIEW_COLLECTION_CANCELLED" });
    const directory = path.join(taskDirectory(root, input.taskId), "review-task-runs", randomUUID());
    const frame = input.role === "stop-reviewer" ? { ...(input.request.fixedStopClassification ?? {}), fileAssessments: [] } : {};
    const sourceRoot = path.join(directory, "input"), outputDir = path.join(directory, "review");
    await fs.mkdir(sourceRoot, { recursive: true }); active();
    const origins = new Map(), dependencies = new Map(), targets = [], basisFiles = [];
    const unverified = async reason => {
      await atomicWriteJson(path.join(directory, "unverified.json"), { objectId: object.objectId, reason }); active();
      return { result: { summary: reason, ...frame, findings: [],
        metricObjectJudgements: [{ objectId: object.objectId, judgement: "UNVERIFIED", reason, evidence: [] }] },
        sourceCitations: [], reviewEvidence: null, close: async () => {}, artifacts: directory };
    };
    const write = async (relative, bytes, origin = null) => {
      active(); const destination = path.join(sourceRoot, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true }); active();
      await fs.writeFile(destination, bytes, { flag: "wx" }); active();
      origins.set(relative, { path: origin ?? destination, contentHash: sha256(bytes), frozen: !origin });
      return relative;
    };
    // Byte-preserving small parts, including for one enormous JSON string. No
    // summary or omitted conditions; no tree of process indexes in the prompt.
    const basis = async (name, value) => {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
      for (let start = 0, index = 0; start < bytes.length; index++) {
        let end = Math.min(start + 16384, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        basisFiles.push(await write(`basis/${name}-${String(index).padStart(4, "0")}.txt`, bytes.subarray(start, end)));
        start = end;
      }
    };
    const truthPath = input.request.groundTruthPath && path.resolve(root, input.request.groundTruthPath);
    const originalTruth = truthPath ? await fs.readFile(truthPath).catch(error => { if (error.code === "ENOENT") return null; throw error; }) : null;
    const truth = input.evidence?.groundTruth ?? (originalTruth && JSON.parse(originalTruth)); active();
    if (!truth || object.metricId !== "M08" && !(truth.claims ?? []).some(claim => claim.claimId === object.sourceId))
      throw Object.assign(new Error("Assigned authoritative obligation is unavailable."), { code: "REVIEW_ITEM_BASIS_UNAVAILABLE" });
    const claims = reviewScopeClaims(truth, { sourceIds: [object.sourceId] });
    const scope = proofScope(input, object);
    await basis("ground-truth", { schemaVersion: truth.schemaVersion, taskId: truth.taskId, version: truth.version, digest: truth.digest, claims });
    let checkSkillSource = async () => {};
    if (object.metricId === "M08") {
      const skillId = object.skillId, skillRoot = path.join(taskDirectory(root, input.taskId), "skills", safeId(skillId));
      if (!skillId) return unverified("The assigned Skill identity and original source cannot be established.");
      const privateJson = async file => {
        active(); const absolute = path.resolve(root, file);
        if (!within(taskDirectory(root, input.taskId), absolute)) return null;
        try {
          if (await fs.realpath(absolute) !== absolute) return null;
          const bytes = await fs.readFile(absolute); active(); dependencies.set(absolute, sha256(bytes));
          return JSON.parse(bytes);
        } catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
      };
      const canonicalDocumentPath = path.join(skillRoot, "skill-ground-truth.json");
      const documentPath = input.request.skillGroundTruthPath ?? canonicalDocumentPath;
      const diskDocument = await privateJson(documentPath);
      const canonicalDocument = documentPath === canonicalDocumentPath ? diskDocument : await privateJson(canonicalDocumentPath);
      const document = input.evidence?.skillGroundTruth ?? diskDocument ?? canonicalDocument;
      if ([diskDocument, canonicalDocument].some(current => current && document && sha256(current) !== sha256(document)))
        throw Object.assign(new Error("Skill Ground Truth changed before capture."), { code: "REVIEW_COLLECTION_STALE" });
      if (!document || validateJsonSchema({ constraints: document.constraints, taskOverlays: document.taskOverlays },
        SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth).length)
        return unverified("The frozen Skill constraint document is unavailable or invalid.");
      const constraint = document?.constraints?.find(item => `${skillId}:${item.constraintId}` === object.sourceId);
      if (!document || document.taskId !== input.taskId || document.skillId !== skillId || !constraint
        || !["MUST", "PROHIBITED"].includes(constraint.modality)
        || document.digest !== sha256({ skillId, skillDigest: document.skillDigest, constraints: document.constraints, taskOverlays: document.taskOverlays }))
        return unverified("The frozen Skill constraint and its authoritative source cannot be verified.");
      if (object.sourceRevisionId !== `${skillId}@${document.version}` || object.description !== constraint.statement)
        throw Object.assign(new Error("The assigned Skill constraint no longer matches its frozen revision."), { code: "REVIEW_COLLECTION_STALE" });
      const capturedDisk = input.request.skillSourcePath && await privateJson(input.request.skillSourcePath);
      const captured = input.evidence?.skillSource ?? capturedDisk;
      if (captured && capturedDisk && sha256({ root: captured.root, digest: captured.digest, files: captured.files })
        !== sha256({ root: capturedDisk.root, digest: capturedDisk.digest, files: capturedDisk.files }))
        throw Object.assign(new Error("The captured Skill source changed before review."), { code: "REVIEW_COLLECTION_STALE" });
      const resolved = await resolveSkillDirectory({ skillId, projectRoot: root, pluginRoot: input.pluginRoot,
        configuredRoots: Array.isArray(input.skillRoots) ? input.skillRoots : [], hostAdapter: openclawHost }); active();
      const capturedRoot = captured?.root && path.resolve(captured.root), privateSource = path.join(skillRoot, "source");
      const sourceDirectory = capturedRoot && (within(privateSource, capturedRoot) || capturedRoot === resolved) ? capturedRoot : resolved;
      if (!sourceDirectory) return unverified("The original Skill source is unavailable; a derived constraint alone cannot establish compliance.");
      const source = await scanSkillDirectory(sourceDirectory); active();
      if (source.root !== sourceDirectory || source.truncated || source.digest !== document.skillDigest
        || captured?.digest && captured.digest !== source.digest)
        return unverified("The available Skill source does not match the complete frozen Skill digest.");
      const related = new Set([constraint.constraintId]);
      for (let count = -1; count !== related.size;) {
        count = related.size;
        for (const item of document.constraints) if (related.has(item.constraintId)) for (const id of item.dependsOn ?? []) related.add(id);
      }
      const references = ["SKILL.md", ...document.constraints.filter(item => related.has(item.constraintId)).map(item => item.sourceRef).filter(Boolean)];
      const refersTo = (ref, file) => {
        const name = String(ref).replaceAll("\\", "/").replace(/#.*$/u, "");
        return name === file.path || name.endsWith(`/${file.path}`) || name.endsWith(`:${file.path}`)
          || name.startsWith(`${file.path}:`) || name.includes(`/${file.path}:`) || name.includes(`:${file.path}:`);
      };
      // Older ledgers also use heading/constraint anchors and free text after a
      // filename. The complete original SKILL.md remains mandatory; only an
      // explicit unavailable file is a missing source, not an opaque anchor.
      const explicitFile = ref => /(?:^|[\s/:])[^\s#/:]+\.[a-z][a-z\d]{0,8}(?=$|[\s#:])/iu.test(String(ref).replaceAll("\\", "/"));
      if (references.some(ref => explicitFile(ref) && !source.files.some(file => refersTo(ref, file))))
        return unverified("A required original Skill source reference is unavailable.");
      const required = source.files.filter(file => references.some(ref => refersTo(ref, file)));
      if (!required.some(file => file.path === "SKILL.md")) return unverified("The captured original Skill text is unavailable.");
      await basis("skill-ground-truth", document);
      await basis("skill-source", { digest: source.digest, files: required });
      for (const file of source.files) {
        active(); const absolute = path.resolve(source.root, file.path), bytes = Buffer.from(file.content);
        if (!within(source.root, absolute) || bytes.length !== file.bytes || sha256(bytes) !== file.sha256
          || file.path.split("/").some(part => privateName.test(part)))
          return unverified("The original Skill source contains an unavailable restricted reference.");
        dependencies.set(absolute, file.sha256);
        await write(`skill-source/${file.path}`, bytes);
      }
      checkSkillSource = async () => {
        active(); const current = await scanSkillDirectory(sourceDirectory); active();
        if (current.digest !== source.digest || current.truncated)
          throw Object.assign(new Error("The original Skill source changed during review."), { code: "REVIEW_COLLECTION_STALE" });
      };
    }
    const sameDescription = claims.find(claim => claim.claimId === object.sourceId)?.text === object.description;
    const assigned = sameDescription ? { ...object, description: undefined, descriptionBasis: { kind: "EXACT_GROUND_TRUTH_TEXT", claimId: object.sourceId } } : object;
    await basis("assigned-object", { object: assigned, metric: METRIC_CATALOG[object.metricId], scope,
      instructions: input.request.instructions ?? [], fixedStopClassification: input.request.fixedStopClassification ?? null,
      inputRoles: { groundTruth: "Authoritative obligations, common constraints and explicit dependencies, not candidate coverage.",
        project: "Current project files. Locate actual candidate decomposition/acceptance units or implementation; original requirements and self-reports do not prove their own fulfillment.",
        process: "Captured original session messages, not reviewer execution. Tool inputs need attributable results; reports alone are not runtime proof." } });
    // Preserve the complete unchanged baseline for unresolved dependencies, but
    // do not require reading it again after the selected complete basis.
    await write("original-ground-truth.json", Buffer.from(JSON.stringify(truth, null, 2) + "\n"));
    const copyFile = async (file, expected = null) => {
      active(); const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
      if (!relative || !within(root, absolute))
        throw Object.assign(new Error("Source is outside the permitted business scope."), { code: "REVIEW_ITEM_SOURCE_INVALID" });
      const parts = relative.split(path.sep);
      if (parts.some(part => privateName.test(part) || excludedDirectory.has(part))) {
        // A broad secret-name exclusion can also match an ordinary business
        // helper (e.g. a password utility). Keep it unavailable, without making
        // every unrelated manifest object fail before reading its own source.
        if (!parts.slice(0, -1).some(part => privateName.test(part) || excludedDirectory.has(part))
          && /^[^.].*\.(?:ets|tsx?|[cm]?js|py|java|kt|rs|go)$/iu.test(parts.at(-1))) return;
        throw Object.assign(new Error("Source is outside the permitted business scope."), { code: "REVIEW_ITEM_SOURCE_INVALID" });
      }
      if (!textExtension.test(relative)) return;
      const real = await fs.realpath(absolute); active();
      if (real !== absolute || !within(root, real) || (await fs.lstat(real)).isSymbolicLink()) throw Object.assign(new Error("Linked business sources are not permitted."), { code: "REVIEW_ITEM_SOURCE_INVALID" });
      const bytes = await fs.readFile(real); active();
      if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) return;
      if (expected && sha256(bytes) !== expected) throw Object.assign(new Error("Source manifest changed before capture."), { code: "REVIEW_COLLECTION_STALE" });
      dependencies.set(real, sha256(bytes));
      targets.push(await write(`project/${relative.replaceAll("\\", "/")}`, bytes, real));
    };
    if (input.request.sourceManifest) {
      for (const entry of input.request.sourceManifest) await copyFile(entry.path ?? entry.relativePath, entry.sha256);
    } else {
      const walk = async directory => {
        active(); dependencies.set(directory, await fingerprint(directory)); active();
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          active();
          if (privateName.test(entry.name) || excludedDirectory.has(entry.name)) continue;
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) throw Object.assign(new Error("Linked business sources are not permitted."), { code: "REVIEW_ITEM_SOURCE_INVALID" });
          if (entry.isDirectory()) await walk(file); else if (entry.isFile()) await copyFile(file);
        }
      };
      await walk(root);
    }
    if (scope !== "SOURCE_IMPLEMENTATION") {
      // Original entries remain separate, on demand. No complete process index
      // or full transcript is injected into the model context.
      const navigation = [];
      for (const [index, entry] of (input.evidence?.snapshot?.entries ?? []).entries()) {
        active(); const relative = `process/${String(index).padStart(6, "0")}.json`;
        await write(relative, Buffer.from(JSON.stringify(entry, null, 2) + "\n"));
        targets.push(relative);
        navigation.push({ path: relative, type: entry.type, id: entry.uuid ?? entry.message?.id ?? null,
          tools: (Array.isArray(entry.message?.content) ? entry.message.content : []).filter(block => block.type === "tool_use").map(block => ({ id: block.id, name: block.name })) });
      }
      await write("process-index.json", Buffer.from(JSON.stringify(navigation, null, 2) + "\n"));
    }
    const processTargets = targets.filter(file => file.startsWith("process/"));
    const permittedTargets = scope === "PROCESS_COMPLIANCE" || scope === "RUNTIME_ACCEPTANCE" ? processTargets : targets;
    if (!permittedTargets.length) return unverified("No authorized current candidate/source or required process evidence is available; the assigned obligation remains unverified.");
    const { reviewPromptProfile } = await import("../review-task/prompt-profile.mjs"); active();
    const profile = reviewPromptProfile(object.metricId, scope);
    const task = { id: object.objectId, metricId: object.metricId, scope, phase: input.request.fixedStopClassification?.stage ?? "VERIFICATION",
      reviewType: profile.reviewType,
      requirement: "Judge exactly the assigned object against the complete mandatory basis at its fixed proof scope. basis/* parts concatenate in filename order to their original JSON; read every part, including all conditions and exceptions. applicabilityKind only selects the executor: it does not prove that original conditions hold, that the metric applies, or that the obligation is satisfied; judge the complete original text, applicability/condition and source. Candidate meaning may be equivalent. Do not promote original requirements, Skill instructions or self-reports into candidate acceptance units or proof that actions occurred. The original-ground-truth file is for unresolved dependencies, not duplicate mandatory reading. For SOURCE_IMPLEMENTATION use symptom-only reasons; do not disclose expected literal values or acceptance answers. A coverage PASS proves only this object, never whole-file quality or the whole project. If applicability or proof ownership cannot be established, submit UNVERIFIED. "
        + (scope === "SOURCE_IMPLEMENTATION" ? "This source-only proof has no business execution history. Reviewer memory is not business process evidence. "
          : "Original process entries are available separately under process/; inspect only needed events, not the whole index by default. ")
        + "Missing or unsuitable proof is UNVERIFIED, not an observed business contradiction.",
      basisFiles, targetFiles: [permittedTargets[0]], targetPrefixes: scope === "PROCESS_COMPLIANCE" || scope === "RUNTIME_ACCEPTANCE"
        ? ["process/"] : scope === "SOURCE_IMPLEMENTATION" ? ["project/"] : ["project/", "process/"] };
    runTask ??= (await import("../review-task/review-task.mjs")).runReviewTask;
    const result = await runTask({ task, root: sourceRoot, outputDir, modelRuntime, model, signal: controller.signal,
      maxAttempts: 2, maxTurns: 100, maxTokens: 8192, promptAppend: profile.promptAppend, onEvent: input.onReviewEvent ?? (() => {}) });
    active();
    if (sha256(await taskGuard()) !== sha256(initialGuard)) throw Object.assign(new Error("Stop task was replaced during review."), { code: "REVIEW_COLLECTION_STALE" });
    if (!result.completed) {
      const cause = /^(CONTEXT_UNSAFE|CONTEXT_COMPACTION_FAILED|CHECKPOINT_FAILED|TURN_LIMIT)(?::|$)/u.exec(result.reason ?? "")?.[1]
        ?? "NO_VALID_SUBMISSION";
      const diagnostic = { cause, resultPath: path.join(outputDir, "result.json") };
      throw Object.assign(new Error(`The isolated review did not complete (${cause}). Details: ${diagnostic.resultPath}`),
        { code: "REVIEW_ITEM_INCOMPLETE", reviewDiagnostic: diagnostic });
    }
    if (originalTruth && sha256(await fs.readFile(truthPath)) !== sha256(originalTruth)) throw Object.assign(new Error("Ground Truth changed during review."), { code: "REVIEW_COLLECTION_STALE" });
    await checkSkillSource();
    for (const [file, expected] of dependencies) { active(); if (await fingerprint(file) !== expected) throw Object.assign(new Error("Business evidence changed during review."), { code: "REVIEW_COLLECTION_STALE" }); }
    const references = [], citations = [];
    for (const ref of result.refs ?? []) {
      const origin = origins.get(ref.path);
      if (!origin || input.role === "implementation-reviewer" && origin.frozen) continue;
      if (ref.sha256 !== origin.contentHash) throw Object.assign(new Error("Worker evidence hash differs from captured source."), { code: "REVIEW_ITEM_EVIDENCE_INVALID" });
      const selection = `${origin.path}#L${ref.start}-L${ref.end}`;
      references.push(selection);
      citations.push({ ...origin, selection, snapshotPath: path.join(outputDir, "frozen-source", ref.path), start: ref.start, end: ref.end, usedBy: [object.objectId] });
    }
    if (["PASS", "DEVIATION"].includes(result.verdict) && (!references.length
      || !(result.refs ?? []).some(ref => origins.has(ref.path) && task.targetPrefixes.some(prefix => ref.path.startsWith(prefix)))))
      throw Object.assign(new Error("A conclusive review has no evidence from its permitted proof owner."), { code: "REVIEW_ITEM_EVIDENCE_INVALID" });
    const report = { summary: `One isolated ${object.metricId} review completed.`, ...frame, findings: [],
      metricObjectJudgements: [{ objectId: object.objectId, judgement: result.verdict, reason: result.reason, evidence: references }] };
    const fingerprints = Object.fromEntries(dependencies);
    const reviewEvidence = { unstable: false, files: [...dependencies.keys()], fingerprints, missing: [],
      digest: sha256([...dependencies].sort(([a], [b]) => a.localeCompare(b))) };
    await atomicWriteJson(path.join(directory, "adapter-result.json"), { result: report, sourceCitations: citations, reviewEvidence, workerArtifacts: outputDir }); active();
    return { result: report, sourceCitations: citations, getSourceCitations: async () => structuredClone(citations), reviewEvidence,
      close: async () => {}, artifacts: directory };
  } finally {
    clearTimeout(timer);
    for (const signal of parents) signal.removeEventListener("abort", stop);
  }
}
