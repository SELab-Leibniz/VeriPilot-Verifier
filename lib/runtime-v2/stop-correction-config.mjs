import { readFileSync } from "node:fs";
import { resolveStopReviewPolicy } from "./metric-policy.mjs";

const defaults = JSON.parse(readFileSync(new URL("../../config/stop-defaults.json", import.meta.url), "utf8"));
const invalid = message => { throw new Error(`stopCorrection.${message}`); };

/** Normalize once at entry. Legacy fields never select a second scheduler. */
export function normalizeStopCorrectionConfig(input = {}) {
  const warnings = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("config must be an object.");
  for (const field of ["enabled", "waitMode", "metrics", "fileQualityReviewEnabled"])
    if (Object.hasOwn(input, field) && input[field] === null) invalid(`${field} cannot be null.`);
  if (Object.hasOwn(input, "maxCorrectionsPerEpoch")) {
    if (Object.hasOwn(input, "maxCorrectionsPerFlow")) invalid("maxCorrectionsPerEpoch conflicts with maxCorrectionsPerFlow; remove the deprecated field.");
    warnings.push("maxCorrectionsPerEpoch is deprecated; mapped to maxCorrectionsPerFlow only. It does not initialize session usage.");
  }
  if (Object.hasOwn(input, "waitTimeoutMs")) {
    if (Object.hasOwn(input, "assessmentTimeoutMs")) invalid("waitTimeoutMs conflicts with assessmentTimeoutMs; remove the deprecated field.");
    warnings.push("waitTimeoutMs is deprecated; mapped to this Stop's assessmentTimeoutMs. Business repair time is excluded.");
  }
  const result = {
    ...resolveStopReviewPolicy(input),
    enabled: input.enabled ?? false,
    waitMode: input.waitMode ?? defaults.waitMode,
    maxCorrectionsPerSession: input.maxCorrectionsPerSession ?? defaults.maxCorrectionsPerSession,
    maxCorrectionsPerFlow: input.maxCorrectionsPerFlow ?? input.maxCorrectionsPerEpoch ?? defaults.maxCorrectionsPerFlow,
    assessmentTimeoutMs: input.assessmentTimeoutMs ?? input.waitTimeoutMs ?? defaults.assessmentTimeoutMs,
    feedbackReserveMs: input.feedbackReserveMs ?? defaults.feedbackReserveMs,
    reviewGroupSize: input.reviewGroupSize ?? defaults.reviewGroupSize,
    migrationWarnings: Object.freeze(warnings),
  };
  if (typeof result.enabled !== "boolean") invalid("enabled must be boolean.");
  if (!["assessment", "until_pass"].includes(result.waitMode)) invalid("waitMode must be assessment or until_pass.");
  for (const field of ["maxCorrectionsPerSession", "maxCorrectionsPerFlow", "reviewGroupSize", "assessmentTimeoutMs", "feedbackReserveMs"]) {
    if (Object.hasOwn(input, field) && input[field] === null) invalid(`${field} must be an integer.`);
    if (!Number.isSafeInteger(result[field]) || result[field] < (field.startsWith("maxCorrections") ? 0 : 1))
      invalid(`${field} must be ${field.startsWith("maxCorrections") ? "a nonnegative" : "a positive"} safe integer.`);
  }
  for (const field of ["maxCorrectionsPerEpoch", "waitTimeoutMs"]) {
    if (Object.hasOwn(input, field) && (!Number.isSafeInteger(input[field]) || input[field] < (field === "waitTimeoutMs" ? 1 : 0)))
      invalid(`${field} has an invalid legacy value.`);
  }
  if (result.feedbackReserveMs >= result.assessmentTimeoutMs) invalid("feedbackReserveMs must be less than assessmentTimeoutMs.");
  return Object.freeze(result);
}

export const effectiveFlowLimit = config => config.waitMode === "assessment"
  ? Math.min(1, config.maxCorrectionsPerFlow) : config.maxCorrectionsPerFlow;

/** Host deadlines may shorten, never extend, the one preparation/review/delivery window. */
export function stopCorrectionWindow(config, startedAt, hostDeadlineAt = Infinity) {
  if (!Number.isFinite(startedAt) || !(Number.isFinite(hostDeadlineAt) || hostDeadlineAt === Infinity))
    throw new Error("Invalid Stop clock or host deadline.");
  const deadlineAt = Math.min(startedAt + config.assessmentTimeoutMs, hostDeadlineAt);
  return Object.freeze({ startedAt, deadlineAt,
    reviewDeadlineAt: Math.min(startedAt + config.assessmentTimeoutMs - config.feedbackReserveMs, deadlineAt - config.feedbackReserveMs) });
}
