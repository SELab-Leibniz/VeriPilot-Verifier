import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveStopReviewPolicy } from "./metric-policy.mjs";

const defaults = JSON.parse(readFileSync(new URL("../../config/stop-defaults.json", import.meta.url), "utf8"));
const invalid = message => { throw new Error(`stopCorrection.${message}`); };
const REGRESSION_FIELDS = ["enabled", "command", "cwd", "timeoutMs", "maxOutputBytes", "baselineFile", "isolationCommand"];

// A string command is split into argv once; it is never handed to a shell.
function regressionArgv(value) {
  if (Array.isArray(value)) {
    if (!value.length || value.some(part => typeof part !== "string" || !part || part.includes("\0")))
      invalid("regressionCheck.command must be a nonempty argv array of nonempty strings.");
    return Object.freeze([...value]);
  }
  if (typeof value !== "string" || !value.trim()) invalid("regressionCheck.command must be an argv array or a nonempty string.");
  if (/[|&;<>`$\r\n\0]/u.test(value)) invalid("regressionCheck.command string cannot contain shell operators, substitutions or newlines; use an argv array.");
  const argv = [];
  let current = null, quote = null;
  for (const char of value) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "\"" || char === "'") { quote = char; current ??= ""; continue; }
    if (/\s/u.test(char)) { if (current !== null) argv.push(current); current = null; continue; }
    current = (current ?? "") + char;
  }
  if (quote) invalid("regressionCheck.command has an unterminated quote.");
  if (current !== null) argv.push(current);
  if (argv.some(part => !part)) invalid("regressionCheck.command cannot contain empty arguments.");
  return Object.freeze(argv);
}

export function normalizeRegressionCheck(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("regressionCheck must be an object.");
  for (const field of Object.keys(input)) if (!REGRESSION_FIELDS.includes(field)) invalid(`regressionCheck.${field} is not supported.`);
  for (const field of REGRESSION_FIELDS) if (Object.hasOwn(input, field) && input[field] === null) invalid(`regressionCheck.${field} cannot be null.`);
  const enabled = input.enabled ?? false;
  if (typeof enabled !== "boolean") invalid("regressionCheck.enabled must be boolean.");
  if (enabled && !Object.hasOwn(input, "command")) invalid("regressionCheck.command is required when regressionCheck is enabled.");
  const command = Object.hasOwn(input, "command") ? regressionArgv(input.command) : null;
  const isolationCommand = Object.hasOwn(input, 'isolationCommand') ? regressionArgv(input.isolationCommand) : null;
  if (isolationCommand && !isolationCommand.some(part => part.includes('{testId}')))
    invalid('regressionCheck.isolationCommand must include a {testId} argument placeholder.');
  const baselineFile = input.baselineFile;
  if (baselineFile !== undefined && (typeof baselineFile !== 'string' || !baselineFile.trim() || baselineFile.includes('\0')))
    invalid('regressionCheck.baselineFile must name a public task-start test result file.');
  const cwd = input.cwd ?? ".";
  if (typeof cwd !== "string" || !cwd.trim() || cwd.includes("\0") || path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd) || /^[A-Za-z]:/u.test(cwd))
    invalid("regressionCheck.cwd must be a relative project path.");
  const relative = path.posix.normalize(cwd.replaceAll("\\", "/")).replace(/\/+$/u, "") || ".";
  if (relative === ".." || relative.startsWith("../")) invalid("regressionCheck.cwd cannot leave the project root.");
  const timeoutMs = input.timeoutMs ?? 600000, maxOutputBytes = input.maxOutputBytes ?? 65536;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2147483647) invalid("regressionCheck.timeoutMs must be an integer from 1000 to 2147483647.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 4194304) invalid("regressionCheck.maxOutputBytes must be an integer from 1024 to 4194304.");
  return Object.freeze({ enabled, ...(command ? { command } : {}), cwd: relative, timeoutMs, maxOutputBytes,
    ...(baselineFile ? { baselineFile } : {}), ...(isolationCommand ? { isolationCommand } : {}) });
}

/** Normalize once at entry. Legacy fields never select a second scheduler. */
export function normalizeStopCorrectionConfig(input = {}) {
  const warnings = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("config must be an object.");
  for (const field of ["enabled", "waitMode", "metrics", "fileQualityReviewEnabled"])
    if (Object.hasOwn(input, field) && input[field] === null) invalid(`${field} cannot be null.`);
  if (Object.hasOwn(input, "originalRequirementsBasis") && typeof input.originalRequirementsBasis !== "boolean")
    invalid("originalRequirementsBasis must be boolean.");
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
    ...(input.originalRequirementsBasis === true ? { originalRequirementsBasis: true } : {}),
    ...(Object.hasOwn(input, "regressionCheck") ? { regressionCheck: normalizeRegressionCheck(input.regressionCheck) } : {}),
    enabled: input.enabled ?? false,
    waitMode: input.waitMode ?? defaults.waitMode,
    maxCorrectionsPerSession: input.maxCorrectionsPerSession ?? defaults.maxCorrectionsPerSession,
    maxCorrectionsPerFlow: input.maxCorrectionsPerFlow ?? input.maxCorrectionsPerEpoch ?? defaults.maxCorrectionsPerFlow,
    maxReviewSteps: input.maxReviewSteps ?? defaults.maxReviewSteps,
    maxRepairSteps: input.maxRepairSteps ?? defaults.maxRepairSteps,
    assessmentTimeoutMs: input.assessmentTimeoutMs ?? input.waitTimeoutMs ?? defaults.assessmentTimeoutMs,
    feedbackReserveMs: input.feedbackReserveMs ?? defaults.feedbackReserveMs,
    reviewGroupSize: input.reviewGroupSize ?? defaults.reviewGroupSize,
    migrationWarnings: Object.freeze(warnings),
  };
  if (typeof result.enabled !== "boolean") invalid("enabled must be boolean.");
  if (!["assessment", "until_pass"].includes(result.waitMode)) invalid("waitMode must be assessment or until_pass.");
  for (const field of ["maxCorrectionsPerSession", "maxCorrectionsPerFlow", "maxReviewSteps", "maxRepairSteps", "reviewGroupSize", "assessmentTimeoutMs", "feedbackReserveMs"]) {
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
