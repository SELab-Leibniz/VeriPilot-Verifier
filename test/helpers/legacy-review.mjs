// Counter/routing test double, not a semantic oracle or production exemption.
// Replace old prose-only fake references with actual public fixture witnesses,
// then use the same original-byte reader/proof helper as other mechanism tests.
import { promises as fs } from "node:fs";
import path from "node:path";
import { withTestReviewProof } from "./review-proof.mjs";
import { reviewProofOwners } from "../../lib/runtime-v2/review-result-validation.mjs";
import {scriptedProductionProofs} from './observed-review.mjs';
import {sha256} from '../../lib/runtime-v2/utils.mjs';

export async function observedLegacyStop(params, handle) {
  if (!['stop-reviewer','implementation-reviewer'].includes(params.role)) return handle;
  const objects = Object.values(params.request.population?.metrics ?? {}).flat();
  const findingObjects=objects.length?objects:(params.evidence?.groundTruth?.claims??[])
    .filter(claim=>params.request.reviewScope?.sourceIds?.includes(claim.claimId)).map(claim=>({sourceId:claim.claimId,
      metricId:params.request.reviewScope.objectIds?.find(id=>id.endsWith(':'+claim.claimId))?.split(':')[0]??'M01',verificationTarget:claim.verificationTarget}));
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
        row.evidence = [await witness(reviewProofOwners(object,params.role)[0])];
      else if(row.judgement==='UNVERIFIED'&&(row.evidence??[]).every(ref=>!/(?:#L|:)\d/u.test(ref)))row.evidence=[];
    }
    for (const finding of report.findings ?? []) {
      const object = findingObjects.find(object => finding.violatedGroundTruthIds?.includes(object.sourceId));
      if (object) finding.actualEvidence = [await witness(reviewProofOwners(object,params.role)[0])];
    }
    return report;
  };
  await prepare(handle.result);
  if(params.role==='stop-reviewer'&&objects.some(object=>object.verificationTarget!=='ARTIFACT'&&object.verificationTarget!=='PROCESS'))await witness('SOURCE');
  const checked = await withTestReviewProof(params, handle);
  const fingerprints={...handle.reviewEvidence?.fingerprints};
  for(const entry of params.request.sourceManifest??[]) {
    const file=path.resolve(params.projectRoot,entry.path??entry.relativePath);
    fingerprints[file]=sha256(await fs.readFile(file));
  }
  const get = checked.getSourceCitations;
  return { ...checked,reviewEvidence:{...handle.reviewEvidence,files:Object.keys(fingerprints),fingerprints,unstable:false,missing:[]},proofs:scriptedProductionProofs(params,checked.result), getSourceCitations: async (report = checked.result) => get(await prepare(report)) };
}
