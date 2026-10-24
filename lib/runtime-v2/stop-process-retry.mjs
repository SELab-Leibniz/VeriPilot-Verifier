import fs from "node:fs/promises";
import path from "node:path";
import { taskDirectory } from "./task-store.mjs";
import { reviewReadEvidenceMatches } from "./review-pass-cache.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";
import { userEvidenceKey } from "./transcript.mjs";

const processObject = object => ["M08", "M11"].includes(object.metricId) || object.verificationTarget === "PROCESS";
const revision = objects => objects.map(o => [o.objectId, o.sourceRevisionId, o.description, o.hard, o.applicability]).sort();
export async function saveProcessRetryBasis({ projectRoot, taskId, report, review, evidence, snapshot, epochId, evaluationId, blockingFindings }) {
  try {
    const objects = report.blockingObjects;
    if (!objects.length || blockingFindings.length || !objects.every(o => o.judgement === "DEVIATION" && processObject(o))
      || !review?.collection?.complete || !await reviewReadEvidenceMatches(projectRoot, evidence, { maxFiles: Infinity })) return null;
    const value = { evaluationId, epochId, populationDigest: review.collection.basis.populationDigest,
      groundTruthDigest: review.collection.basis.groundTruthDigest, userDigest: userEvidenceKey(snapshot),
      classification: [review.stopClassification, review.stage ?? null], objects: revision(objects), evidence };
    const file = path.join(taskDirectory(projectRoot, taskId), "stop-process-retry.json");
    await atomicWriteJson(file, value);
    return { file, sha256: sha256(value), evaluationId };
  } catch { return null; } // A failed optimization must not invalidate a completed assessment.
}

export async function processRetryObjects({ projectRoot, task, population, truth, snapshot, classification }) {
  const ref = task.stop?.processRetry;
  if (!ref || task.stop.correctionAttempts < 1 || task.status !== "ACTIVE") return null;
  const expected = path.join(taskDirectory(projectRoot, task.taskId), "stop-process-retry.json");
  if (ref.file !== expected) return null;
  try {
    if ((await fs.stat(expected)).size > 2 * 1024 * 1024) return null;
    const prior = await readJson(expected);
    if (!prior || sha256(prior) !== ref.sha256 || prior.epochId !== task.correctionEpoch.id
      || prior.populationDigest !== population.digest || prior.groundTruthDigest !== truth.digest
      || prior.userDigest !== userEvidenceKey(snapshot)
      || JSON.stringify(prior.classification) !== JSON.stringify([classification.stopClassification, classification.stage ?? null])) return null;
    const ids = new Set(prior.objects.map(o => o[0]));
    const objects = Object.values(population.metrics).flat().filter(o => ids.has(o.objectId));
    if (!objects.length || !objects.every(processObject) || JSON.stringify(revision(objects)) !== JSON.stringify(prior.objects)
      || !await reviewReadEvidenceMatches(projectRoot, prior.evidence, { maxFiles: Infinity })) return null;
    return { prior, objects };
  } catch { return null; } // Unavailable proof disables this optimization, never verification.
}
