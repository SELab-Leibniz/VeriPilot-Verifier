import assert from "node:assert/strict";
import test from "node:test";

import { calculateMetricReport } from "../lib/runtime-v2/metrics.mjs";
import { stopAssessmentBlocks } from "../lib/runtime-v2/orchestrator.mjs";

// Incident replica: enterprise-collab T1 20260829-formal-001. The developer
// stopped after the manual-tests stage; the Stop reviewer judged only the
// document-stage objects and omitted the implementation population entirely.
// Every omitted object aggregates as CHECKER_ERROR, which is never a blocking
// object — so the old `blockingObjects.length > 0` gate read the broken
// assessment as clean and allowed a stop with zero implementation.

const POPULATION = {
  schemaVersion: "runtime-corrector.metric-population.v2",
  catalogVersion: "vp-m01-m15-v1",
  version: 1,
  groundTruthVersion: 1,
  metrics: {
    M01: [
      { objectId: "M01:requirements-doc", hard: true, evidenceRequired: false },
    ],
    M12: [
      { objectId: "M12:req-implemented", hard: true, evidenceRequired: true },
    ],
  },
};

test("an assessment that omits frozen objects is CHECKER_ERROR and blocks the stop", () => {
  const report = calculateMetricReport({
    population: POPULATION,
    metricIds: ["M01", "M12"],
    judgements: [
      { objectId: "M01:requirements-doc", judgement: "PASS", reason: "Doc complete.", evidence: ["spec"] },
      // M12:req-implemented omitted — the implementation stage never ran.
    ],
  });
  assert.equal(report.status, "CHECKER_ERROR");
  assert.deepEqual(report.blockingObjects, [], "omissions are not blocking objects — that is the trap");
  assert.equal(stopAssessmentBlocks(report, []), true, "a broken assessment must fail closed");
});

test("a fully judged clean assessment still allows the stop", () => {
  const report = calculateMetricReport({
    population: POPULATION,
    metricIds: ["M01", "M12"],
    judgements: [
      { objectId: "M01:requirements-doc", judgement: "PASS", reason: "Doc complete.", evidence: ["spec"] },
      { objectId: "M12:req-implemented", judgement: "PASS", reason: "Implemented and verified.", evidence: ["build"] },
    ],
  });
  assert.equal(report.status, "PASS");
  assert.equal(stopAssessmentBlocks(report, []), false);
});

test("hard deviations and blocking findings still block independently", () => {
  const report = calculateMetricReport({
    population: POPULATION,
    metricIds: ["M01", "M12"],
    judgements: [
      { objectId: "M01:requirements-doc", judgement: "PASS", reason: "Doc complete.", evidence: ["spec"] },
      { objectId: "M12:req-implemented", judgement: "DEVIATION", reason: "Not implemented.", evidence: [] },
    ],
  });
  assert.equal(report.status, "DEVIATION");
  assert.equal(stopAssessmentBlocks(report, []), true);
  const clean = { status: "PASS", blockingObjects: [], metrics: [] };
  assert.equal(stopAssessmentBlocks(clean, [{ reason: "hard claim violated" }]), true);
});
