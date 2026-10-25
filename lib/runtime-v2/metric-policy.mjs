import { readFileSync } from "node:fs";

const defaults = JSON.parse(readFileSync(new URL("../../config/stop-defaults.json", import.meta.url), "utf8"));
export const METRIC_IDS = Object.freeze(Array.from({ length: 16 }, (_, index) => `M${String(index + 1).padStart(2, "0")}`));
export const DEFAULT_STOP_METRICS = Object.freeze({ ...defaults.metrics });

/** Partial project overrides inherit the declared defaults, never truthiness. */
export function resolveStopReviewPolicy(input = {}) {
  const overrides = input.metrics ?? {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("stopCorrection.metrics must be an object of M01–M16 boolean switches.");
  for (const [id, enabled] of Object.entries(overrides)) {
    if (!METRIC_IDS.includes(id) || typeof enabled !== "boolean")
      throw new Error(`stopCorrection.metrics.${id} must be a known metric with a boolean switch.`);
  }
  const quality = input.fileQualityReviewEnabled ?? defaults.fileQualityReviewEnabled;
  if (typeof quality !== "boolean") throw new Error("stopCorrection.fileQualityReviewEnabled must be boolean.");
  return Object.freeze({ metrics: Object.freeze({ ...DEFAULT_STOP_METRICS, ...overrides }), fileQualityReviewEnabled: quality });
}

export const enabledStopMetricIds = policy => METRIC_IDS.filter(id => policy.metrics[id]);
export const hasStopReviews = policy => policy.fileQualityReviewEnabled || enabledStopMetricIds(policy).length > 0;

/** Strip only explicitly disabled duties; unknown/foreign enabled rows still
 * reach the usual ownership validator and cannot be silently accepted. */
export function restrictStopReviewOutput(review, population, { includeIgnored = false } = {}) {
  if (!review || !population.reviewPolicy) return review;
  const result = structuredClone(review), policy = population.reviewPolicy;
  const ignoredRows = [], ignoredFindings = [], disabledSources = new Set(population.disabledSourceIds ?? []);
  if (Array.isArray(result.metricObjectJudgements)) result.metricObjectJudgements = result.metricObjectJudgements.filter(row => {
    const metric = /^(M\d{2}):/u.exec(String(row.objectId ?? ""))?.[1];
    if (policy.metrics[metric] !== false) return true;
    ignoredRows.push({ ...row, ignoredReason: "METRIC_DISABLED" }); return false;
  });
  if (Array.isArray(result.findings)) result.findings = result.findings.flatMap(finding => {
    const ids = finding.violatedGroundTruthIds ?? [], retained = ids.filter(id => !disabledSources.has(id));
    if (ids.length && !retained.length) {
      ignoredFindings.push({ ...finding, ignoredReason: "OUTSIDE_ENABLED_METRIC_SCOPE" }); return [];
    }
    return [{ ...finding, violatedGroundTruthIds: retained }];
  });
  if (includeIgnored && ignoredRows.length) result.ignoredMetricJudgements = [...(result.ignoredMetricJudgements ?? []), ...ignoredRows];
  if (includeIgnored && ignoredFindings.length) result.ignoredFindings = [...(result.ignoredFindings ?? []), ...ignoredFindings];
  if (!policy.fileQualityReviewEnabled && Object.hasOwn(result, "fileAssessments")) result.fileAssessments = [];
  return result;
}
