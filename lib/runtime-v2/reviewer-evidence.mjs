import path from "node:path";

import { atomicWriteJson } from "./utils.mjs";


/**
 * Materialize already-read evidence in the receiving reviewer's own directory.
 * The caller owns request.json and cleanup. Source paths are never read here.
 */
export async function prepareReviewerRequest({ requestDirectory, request, evidence = null }) {
  // Capture all inputs before the first filesystem await: the caller can keep
  // processing its event without changing the assessment currently being sent.
  const prepared = JSON.parse(JSON.stringify(request));
  const captured = JSON.parse(JSON.stringify(evidence));
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
