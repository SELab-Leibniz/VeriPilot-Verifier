// Counter/routing test double, not a semantic oracle or production exemption.
// Replace old prose-only fake references with actual public fixture witnesses,
// then use the same original-byte reader/proof helper as other mechanism tests.
import { promises as fs } from "node:fs";
import path from "node:path";
import { withTestReviewProof } from "./review-proof.mjs";
import { reviewProofOwners } from "../../lib/runtime-v2/review-result-validation.mjs";

export async function observedLegacyStop(params, handle) {
  if (params.role !== "stop-reviewer") return handle;
  const objects = Object.values(params.request.population?.metrics ?? {}).flat();
  const witnesses = new Map();
  const witness = async owner => {
    if (!witnesses.has(owner)) {
      const file = path.join(params.projectRoot, `scripted-stop-${owner.toLowerCase()}.json`);
      await fs.writeFile(file, JSON.stringify({ kind: "SCRIPTED_TEST_OBSERVATION", proofScope: owner,
        description: "Explicit simulated role observation used only to exercise core counters and routing." }) + "\n");
      witnesses.set(owner, `${file}#L1`);
    }
    return witnesses.get(owner);
  };
  const prepare = async report => {
    for (const row of report.metricObjectJudgements ?? []) {
      const object = objects.find(object => object.objectId === row.objectId);
      if (object && ["PASS", "DEVIATION", "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING"].includes(row.judgement))
        row.evidence = [await witness(reviewProofOwners(object)[0])];
    }
    for (const finding of report.findings ?? []) {
      const object = objects.find(object => finding.violatedGroundTruthIds?.includes(object.sourceId));
      if (object) finding.actualEvidence = [await witness(reviewProofOwners(object)[0])];
    }
    return report;
  };
  await prepare(handle.result);
  const checked = await withTestReviewProof(params, handle);
  const get = checked.getSourceCitations;
  return { ...checked, getSourceCitations: async (report = checked.result) => get(await prepare(report)) };
}
