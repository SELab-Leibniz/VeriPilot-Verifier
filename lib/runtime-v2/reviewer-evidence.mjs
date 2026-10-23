import path from "node:path";
import { promises as fs } from "node:fs";

import { atomicWriteJson, sha256 } from "./utils.mjs";
import { prepareReviewScope, REVIEW_SCOPE_PAGE_BYTES } from "./review-scope.mjs";


/**
 * Materialize already-read evidence in the receiving reviewer's own directory.
 * The caller owns request.json and cleanup. Source paths are never read here.
 */
export async function prepareReviewerRequest({ requestDirectory, request, evidence = null }) {
  // Capture all inputs before the first filesystem await: the caller can keep
  // processing its event without changing the assessment currently being sent.
  let prepared = JSON.parse(JSON.stringify(request));
  let captured = JSON.parse(JSON.stringify(evidence));
  if (prepared.reviewScope) {
    const scoped = await prepareReviewScope({ projectRoot: request.projectRoot ?? path.dirname(path.dirname(path.dirname(requestDirectory))),
      requestDirectory, request: prepared, evidence: captured });
    prepared = scoped.request;
    captured = scoped.evidence;
  }
  if (!captured) return prepared;

  const references = {};
  if (captured.snapshot) {
    const transcriptPath = path.join(requestDirectory, "transcript.json");
    await atomicWriteJson(transcriptPath, { entries: captured.snapshot.entries ?? [] });
    // These identify the source snapshot, not the serialized evidence file.
    references.transcript = {
      path: transcriptPath,
      digest: captured.snapshot.digest ?? null,
      cursor: captured.snapshot.lastEntryKey ?? null,
    };
  }
  if (captured.groundTruth) {
    references.groundTruthPath = path.join(requestDirectory, "ground-truth.json");
    await atomicWriteJson(references.groundTruthPath, captured.groundTruth);
  }
  if (captured.skillGroundTruth) {
    references.skillGroundTruthPath = path.join(requestDirectory, "skill-ground-truth.json");
    await atomicWriteJson(references.skillGroundTruthPath, captured.skillGroundTruth);
  }
  if (captured.skillSource) {
    references.skillSourcePath = path.join(requestDirectory, "skill-source.json");
    await atomicWriteJson(references.skillSourcePath, captured.skillSource);
  }
  if (captured.population !== null && captured.population !== undefined) {
    references.population = captured.population;
  }
  Object.assign(prepared, references);
  if (references.groundTruthPath && prepared.currentGroundTruth) {
    prepared.currentGroundTruth.path = references.groundTruthPath;
  }

  if (captured.semanticRequest) {
    const semantic = captured.semanticRequest;
    semantic.runtimeV2 = { ...semantic.runtimeV2, ...references };
    if (references.transcript) {
      semantic.runtimeV2.transcriptDigest = references.transcript.digest;
      semantic.runtimeV2.transcriptCursor = references.transcript.cursor;
    }
    if (references.groundTruthPath && semantic.runtimeV2.currentGroundTruth) {
      semantic.runtimeV2.currentGroundTruth.path = references.groundTruthPath;
    }
    prepared.semanticReviewRequestPath = path.join(requestDirectory, "semantic-request.json");
    await atomicWriteJson(prepared.semanticReviewRequestPath, semantic);
  }
  return prepared;
}

/** Bind only this request's program-generated disclosure files before cleanup. */
export async function scopedSourceCitations({ projectRoot, requestDirectory, prepared, report }) {
  if (!prepared.reviewScope) return [];
  const within = (base, file) => { const relative = path.relative(base, file); return !relative.startsWith("..") && !path.isAbsolute(relative); };
  const root = await fs.realpath(projectRoot), requestRoot = await fs.realpath(requestDirectory);
  if (!within(root, requestRoot)) return [];
  const localPath = async file => {
    if (typeof file !== "string") return null;
    try { const real = await fs.realpath(path.resolve(root, file)); return within(requestRoot, real) ? real : null; }
    catch { return null; }
  };
  const truth = await localPath(prepared.groundTruthPath);
  const pages = await localPath(prepared.reviewScope.evidenceDirectory);
  const selections = new Map(), sources = new Map();
  const rows = [...(report?.metricObjectJudgements ?? []), ...(report?.findings ?? []), ...(report?.fileAssessments ?? [])];
  for (const row of rows) {
    const owner = row.objectId ?? row.deviationKey ?? row.path ?? "finding";
    for (const ref of [...(row.evidence ?? []), ...(row.actualEvidence ?? [])]) {
      if (typeof ref !== "string") continue;
      const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(ref);
      if (!match) continue;
      const file = await localPath(match[1]);
      if (!file || (file !== truth && !(pages && within(pages, file)))) continue;
      let source = sources.get(file);
      if (!source) {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > REVIEW_SCOPE_PAGE_BYTES) continue;
        const bytes = await fs.readFile(file);
        if (bytes.includes(0)) continue;
        source = { lines: bytes.toString("utf8").split("\n"), contentHash: sha256(bytes) }; sources.set(file, source);
      }
      const start = Number(match[2]), end = Number(match[3] ?? start);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > source.lines.length) continue;
      const selection = `${file}#L${start}-L${end}`, previous = selections.get(selection);
      if (previous) { if (!previous.usedBy.includes(owner)) previous.usedBy.push(owner); continue; }
      selections.set(selection, { selection, path: file, snapshotPath: file, frozen: true, start, end,
        contentHash: source.contentHash, exactQuote: source.lines.slice(start - 1, end).join("\n"), usedBy: [owner] });
    }
  }
  return [...selections.values()];
}
