// Mechanism-test double: explicitly simulates a reviewer consuming the complete
// passed-in basis and reading its declared source ranges. Production never
// imports this helper. Scripted model tests must exercise real tool disclosures.
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "../../lib/runtime-v2/utils.mjs";
import { reviewProofOwners } from "../../lib/runtime-v2/review-result-validation.mjs";

export async function withTestReviewProof(params, handle) {
  const population = params.request?.population ?? params.evidence?.population;
  const objects = new Map(Object.values(population?.metrics ?? {}).flat().map(object => [object.objectId, object]));
  let basisComplete = Boolean(params.evidence?.groundTruth || params.request?.currentGroundTruth);
  if (!basisComplete && params.request?.groundTruthPath) try {
    basisComplete = Boolean(JSON.parse(await fs.readFile(params.request.groundTruthPath, "utf8")));
  } catch { /* Missing basis cannot be attested by a test double. */ }
  async function citations(report, supplied = []) {
    const result = supplied.map(value => ({ ...value }));
    const rows = [...(report?.metricObjectJudgements ?? []), ...(report?.findings ?? []), ...(report?.fileAssessments ?? [])];
    for (const row of rows) {
      const owner = row.objectId ?? row.deviationKey ?? row.path;
      const object = objects.get(row.objectId) ?? [...objects.values()].find(value => row.violatedGroundTruthIds?.includes(value.sourceId));
      const kind = row.path ? "ARTIFACT" : reviewProofOwners(object, params.role)[0];
      for (const ref of [...(row.evidence ?? []), ...(row.actualEvidence ?? [])]) {
        const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(ref);
        if (!match) continue;
        const absolute = path.resolve(params.projectRoot, match[1]), start = Number(match[2]), end = Number(match[3] ?? match[2]);
        let known = result.find(value => value.selection === ref || typeof value.path === "string" && path.resolve(value.path) === absolute && value.start === start && value.end === end);
        // The test double cannot mint private or foreign evidence rights.
        const relative = path.relative(params.projectRoot, absolute);
        if (!known && (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(/[\\/]/u)[0] === ".runtime-correction")) continue;
        if (known && (known.frozen || relative.split(/[\\/]/u)[0] === ".runtime-correction") && !known.usedBy?.includes(owner)) continue;
        try {
          const bytes = await fs.readFile(known?.snapshotPath ?? absolute);
          if (start < 1 || end < start || end > bytes.toString("utf8").split("\n").length) continue;
          if (!known) {
            known = { path: absolute, snapshotPath: absolute, selection: ref, start, end, contentHash: sha256(bytes), frozen: false, usedBy: [owner] };
            result.push(known);
          }
          known.usedBy = [...new Set([...(known.usedBy ?? []), owner])];
          known.readProof = { version: 1, owner: kind, observed: true, basisComplete };
        } catch { /* Intentionally broken fixture references remain invalid. */ }
      }
    }
    return result;
  }
  const get = handle.getSourceCitations?.bind(handle);
  return { ...handle, getSourceCitations: async (report = handle.result) => citations(report, get ? await get(report) : handle.sourceCitations ?? []) };
}
