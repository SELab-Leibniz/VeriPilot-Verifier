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

export function normalizeProjectChecks(input) {
  if (!Array.isArray(input) || input.length > 16) invalid('projectChecks must be an array of at most 16 configured checks.');
  const ids = new Set();
  return Object.freeze(input.map(value => {
    const fail = message => invalid(`projectChecks.${message}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('each check must be an object.');
    const allowed = ['id', 'enabled', 'command', 'cwd', 'timeoutMs', 'maxOutputBytes', 'metrics', 'source', 'inputs'];
    for (const field of Object.keys(value)) if (!allowed.includes(field)) fail(`${field} is not supported.`);
    if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.id) || ids.has(value.id)) fail('id must be unique and contain only letters, numbers, dot, underscore or dash.');
    ids.add(value.id);
    if (!Array.isArray(value.command)) fail('command must be an explicit argv array.');
    let command;
    try { command = normalizeRegressionCheck({ enabled: Object.hasOwn(value, 'enabled') ? value.enabled : true, command: value.command,
      ...Object.fromEntries(['cwd', 'timeoutMs', 'maxOutputBytes'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) }); }
    catch (error) { fail(error.message.replace(/^stopCorrection\.regressionCheck\.?/u, '')); }
    if (!Array.isArray(value.metrics) || !value.metrics.length || value.metrics.some(id => !['M13', 'M14', 'M15'].includes(id))
      || new Set(value.metrics).size !== value.metrics.length) fail('metrics must name distinct acceptance metrics M13, M14 or M15.');
    const source = value.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some(key => !['path', 'sha256', 'start', 'end'].includes(key))
      || typeof source.path !== 'string' || !source.path.trim() || source.path.includes('\0')
      || path.posix.isAbsolute(source.path) || path.win32.isAbsolute(source.path) || /^[A-Za-z]:/u.test(source.path)
      || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256) || !Number.isSafeInteger(source.start) || source.start < 1
      || !Number.isSafeInteger(source.end) || source.end < source.start) fail('source requires a relative path, exact SHA256 and positive inclusive line range.');
    const relative = path.posix.normalize(source.path.replaceAll('\\', '/'));
    if (relative === '..' || relative.startsWith('../') || relative === '.') fail('source cannot leave the project root or name a directory.');
    const pins = Object.hasOwn(value, 'inputs') ? value.inputs : [], pinnedPaths = new Set();
    if (!Array.isArray(pins) || pins.length > 64) fail('inputs must be an array of at most 64 pinned verification files.');
    const inputs = pins.map(pin => {
      if (!pin || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).some(key => !['path', 'sha256'].includes(key))
        || typeof pin.path !== 'string' || !pin.path.trim() || pin.path.includes('\0')
        || path.posix.isAbsolute(pin.path) || path.win32.isAbsolute(pin.path) || /^[A-Za-z]:/u.test(pin.path)
        || typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(pin.sha256)) fail('inputs require relative paths and exact SHA256 values.');
      const file = path.posix.normalize(pin.path.replaceAll('\\', '/'));
      if (file === '..' || file.startsWith('../') || file === '.' || pinnedPaths.has(file)) fail('inputs must name distinct files inside the project.');
      pinnedPaths.add(file);
      return Object.freeze({ path: file, sha256: pin.sha256 });
    });
    return Object.freeze({ ...command, id: value.id, metrics: Object.freeze([...value.metrics]),
      source: Object.freeze({ ...source, path: relative }), inputs: Object.freeze(inputs) });
  }));
}

/** Normalize once at entry. Legacy fields never select a second scheduler. */
export function normalizeStopCorrectionConfig(input = {}) {
  const warnings = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("config must be an object.");
  for (const field of ["enabled", "waitMode", "metrics", "families", "fileQualityReviewEnabled"])
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
    ...(Object.hasOwn(input, 'projectChecks') ? { projectChecks: normalizeProjectChecks(input.projectChecks) } : {}),
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
