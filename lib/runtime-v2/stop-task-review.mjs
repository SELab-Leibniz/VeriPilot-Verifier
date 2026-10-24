// Adapt the tested single-obligation worker to the existing Stop collector.
// Scope selection, metrics, publication, retry and correction remain caller-owned.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskDirectory, decisionGuard } from "./task-store.mjs";
import { atomicWriteJson, sha256 } from "./utils.mjs";
import { fingerprint } from "./evidence-state.mjs";
import { reviewScopeClaims } from "./review-scope.mjs";
import { METRIC_CATALOG } from "./metrics.mjs";

const within = (root, file) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const privateName = /^(?:\.git|\.aws|\.ssh|\.gnupg|\.azure|\.env(?:\..*)?|\.npmrc|\.pypirc|auth(?:-profiles)?\.json|openclaw\.json|.*(?:credentials|secret|api[-_]?key|keystore|\.p12|\.pfx).*)$/iu;
const excludedDirectory = new Set([".runtime-correction", "node_modules", "oh_modules", ".hvigor", "build", "dist", "__pycache__", ".idea"]);
const textExtension = /\.(?:md|txt|json5?|ya?ml|toml|[cm]?js|jsx|tsx?|ets|py|java|kt|rs|go|[ch](?:pp)?|css|html|xml|csv|sql|sh|ps1)$/iu;
const objectsOf = input => Object.values(input.request?.population?.metrics ?? {}).flat();

export function canUseStopTaskReview(input) {
  const objects = objectsOf(input), object = objects[0], scope = input.request?.reviewScope;
  if (scope?.kind === "classification" || scope?.findingsOnly === true
    || objects.length !== 1 || scope?.objectIds?.length !== 1 || scope.objectIds[0] !== object.objectId
    || ![undefined, null, "", "CURRENT_TASK"].includes(object.applicability)
    || object.authority === "BASIS_PENDING" || !object.sourceId) return false;
  if (input.role === "implementation-reviewer") return object.metricId === "M12" && object.verificationTarget === "IMPLEMENTATION";
  if (input.role !== "stop-reviewer" || input.request.fixedStopClassification?.stopClassification !== "TASK_COMPLETE") return false;
  if (["M01", "M05"].includes(object.metricId)) return object.verificationTarget !== "PROCESS";
  return object.metricId === "M12" && object.verificationTarget === "IMPLEMENTATION";
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
    if (!(truth?.claims ?? []).some(claim => claim.claimId === object.sourceId)) throw Object.assign(new Error("Assigned authoritative obligation is unavailable."), { code: "REVIEW_ITEM_BASIS_UNAVAILABLE" });
    const claims = reviewScopeClaims(truth, { sourceIds: [object.sourceId] });
    const scope = input.role === "implementation-reviewer" ? "SOURCE_IMPLEMENTATION"
      : object.metricId === "M12" ? "RUNTIME_ACCEPTANCE" : "METRIC_ARTIFACT_REVIEW";
    await basis("ground-truth", { schemaVersion: truth.schemaVersion, taskId: truth.taskId, version: truth.version, digest: truth.digest, claims });
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
    const businessTargets = [...targets];
    if (scope === "RUNTIME_ACCEPTANCE") {
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
    if (!businessTargets.length) {
      const reason = "No authorized current candidate/source text is available; the assigned obligation remains unverified.";
      await atomicWriteJson(path.join(directory, "unverified.json"), { objectId: object.objectId, reason });
      return { result: { summary: reason, ...frame, findings: [],
        metricObjectJudgements: [{ objectId: object.objectId, judgement: "UNVERIFIED", reason, evidence: [] }] },
        sourceCitations: [], reviewEvidence: null, close: async () => {}, artifacts: directory };
    }
    const task = { id: object.objectId, metricId: object.metricId, scope, phase: input.request.fixedStopClassification?.stage ?? "VERIFICATION",
      requirement: "Judge exactly the assigned object against the complete mandatory basis. basis/* parts concatenate in filename order to their original JSON; read every part, including all conditions and exceptions. Candidate meaning may be equivalent. Do not promote original requirement prose or self-reports into candidate acceptance units or execution proof. The original-ground-truth file is for unresolved dependencies, not duplicate mandatory reading. For implementation review use symptom-only reasons; do not disclose expected literal values or acceptance answers. A coverage PASS proves only this object, never whole-file quality or the whole project. If applicability or proof ownership cannot be established, submit UNVERIFIED. Inspect process-index only when actual runtime execution proof is required.",
      basisFiles, targetFiles: [businessTargets[0]], targetPrefixes: scope === "RUNTIME_ACCEPTANCE" ? ["project/", "process/"] : ["project/"] };
    const { reviewPromptProfile } = await import("../review-task/prompt-profile.mjs"); active();
    runTask ??= (await import("../review-task/review-task.mjs")).runReviewTask;
    const result = await runTask({ task, root: sourceRoot, outputDir, modelRuntime, model, signal: controller.signal,
      maxAttempts: 2, maxTurns: 100, maxTokens: 8192, promptAppend: reviewPromptProfile(object.metricId, scope).promptAppend, onEvent: input.onReviewEvent ?? (() => {}) });
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
    if (["PASS", "DEVIATION"].includes(result.verdict) && !references.length) throw Object.assign(new Error("A conclusive review has no permitted source citation."), { code: "REVIEW_ITEM_EVIDENCE_INVALID" });
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
