import assert from "node:assert/strict";
import test from "node:test";

import { calculateMetricReport } from "../lib/runtime-v2/metrics.mjs";
import { stopAssessmentBlocks } from "../lib/runtime-v2/orchestrator.mjs";


const population = {
  catalogVersion: "vp-m01-m15-v1",
  version: 1,
  groundTruthVersion: 1,
  metrics: {
    M01: [{
      objectId: "M01:REQ-001",
      metricId: "M01",
      sourceId: "REQ-001",
      sourceRevisionId: "REQ-001@1",
      description: "The required behavior is implemented.",
      authority: "USER_EXPLICIT",
      hard: true,
      evidenceRequired: false,
    }],
  },
};


test("an omitted frozen object is a fail-closed Stop checker error", () => {
  const report = calculateMetricReport({ population, metricIds: ["M01"], judgements: [] });

  assert.equal(report.status, "CHECKER_ERROR");
  assert.deepEqual(report.blockingObjects, []);
  assert.equal(stopAssessmentBlocks(report, []), true);
});


test("a fully judged PASS does not block a Stop", () => {
  const report = calculateMetricReport({
    population,
    metricIds: ["M01"],
    judgements: [{
      objectId: "M01:REQ-001",
      judgement: "PASS",
      reason: "Satisfied.",
      evidence: ["implementation"],
    }],
  });

  assert.equal(report.status, "PASS");
  assert.equal(stopAssessmentBlocks(report, []), false);
});


test("hard findings still block a Stop", () => {
  const report = calculateMetricReport({
    population,
    metricIds: ["M01"],
    judgements: [{
      objectId: "M01:REQ-001",
      judgement: "DEVIATION",
      reason: "Missing.",
      evidence: [],
    }],
  });

  assert.equal(report.status, "DEVIATION");
  assert.equal(stopAssessmentBlocks(report, []), true);
  assert.equal(stopAssessmentBlocks({ ...report, blockingObjects: [] }, [{ severity: "error" }]), true);
});
