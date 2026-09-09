import path from "node:path";

import { resolveClaudeExecutable } from "./claude-executable.mjs";


const EXECUTABLE_OVERRIDE = "RUNTIME_CORRECTOR_AGENT_EXECUTABLE";
const SESSION_DIALECT_OVERRIDE = "RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT";
const SESSION_DIALECTS = new Set(["claude", "codeagent"]);


function frozenPlan(executable, argsPrefix = [], sessionDialect = "claude") {
  return Object.freeze({
    executable,
    argsPrefix: Object.freeze([...argsPrefix]),
    sessionDialect,
  });
}


function assertExecutable(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new Error(`${label} must be a nonblank executable string without NUL bytes.`);
  }
}


function assertSessionDialect(value, label) {
  if (!SESSION_DIALECTS.has(value)) {
    throw new Error(`${label} must be claude or codeagent.`);
  }
}


function assertSessionId(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new Error(`${label} must be a nonblank session ID without NUL bytes.`);
  }
}


function isForbiddenCodeAgentSessionArgument(value) {
  return value === "--resume" || value.startsWith("--resume=")
    || value === "--continue" || value.startsWith("--continue=");
}


function assertNativeExecutable(executable, platform, label) {
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new Error(`${label}: shell shims are unsupported; use a native executable or node.exe with an absolute JavaScript entry in argsPrefix.`);
  }
}


function isAbsoluteExecutable(executable, platform) {
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(executable)
    : path.posix.isAbsolute(executable);
}


function hasPath(executable) {
  return executable === "." || executable === ".." || /[\\/]/.test(executable);
}


export function normalizeReviewerRuntime(value, { projectRoot, platform = process.platform } = {}) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reviewerRuntime must be an object containing executable and optional argsPrefix/sessionDialect.");
  }
  if (Object.keys(value).some((key) => !["executable", "argsPrefix", "sessionDialect"].includes(key))) {
    throw new Error("reviewerRuntime only accepts executable, argsPrefix, and sessionDialect.");
  }
  assertExecutable(value.executable, "reviewerRuntime.executable");
  const argsPrefix = value.argsPrefix === undefined ? [] : value.argsPrefix;
  if (!Array.isArray(argsPrefix)
    || [...argsPrefix].some((arg) => typeof arg !== "string" || arg.includes("\u0000"))) {
    throw new Error("reviewerRuntime.argsPrefix must be an array of strings without NUL bytes.");
  }
  const sessionDialect = value.sessionDialect ?? "claude";
  assertSessionDialect(sessionDialect, "reviewerRuntime.sessionDialect");
  let executable = value.executable;
  assertNativeExecutable(executable, platform, "reviewerRuntime.executable");
  if (!isAbsoluteExecutable(executable, platform)) {
    if (platform === "win32" && /^(?:[A-Za-z]:|[\\/])/.test(executable)) {
      throw new Error("reviewerRuntime.executable must use a fully absolute or project-relative path, not a drive-relative or rooted Windows path.");
    }
    if (hasPath(executable)) {
      if (typeof projectRoot !== "string" || !isAbsoluteExecutable(projectRoot, platform)) {
        throw new Error("reviewerRuntime.executable requires an absolute owning projectRoot for a relative path.");
      }
      executable = (platform === "win32" ? path.win32 : path.posix).resolve(projectRoot, executable);
    }
  }
  return frozenPlan(executable, argsPrefix, sessionDialect);
}


export async function resolveReviewerLaunchPlan({
  reviewerRuntime,
  env = process.env,
  platform = process.platform,
  projectRoot,
} = {}) {
  // A valid environment override cannot hide an invalid declared configuration.
  const configured = normalizeReviewerRuntime(reviewerRuntime, { projectRoot, platform });
  const override = env[EXECUTABLE_OVERRIDE];
  const dialectOverride = env[SESSION_DIALECT_OVERRIDE];
  if (dialectOverride !== undefined && override === undefined) {
    throw new Error(`${SESSION_DIALECT_OVERRIDE} requires ${EXECUTABLE_OVERRIDE}.`);
  }
  if (override !== undefined) {
    assertExecutable(override, EXECUTABLE_OVERRIDE);
    const sessionDialect = dialectOverride ?? "claude";
    assertSessionDialect(sessionDialect, SESSION_DIALECT_OVERRIDE);
    if (!isAbsoluteExecutable(override, platform)
      && (hasPath(override) || (platform === "win32" && /^[A-Za-z]:/.test(override)))) {
      throw new Error(`${EXECUTABLE_OVERRIDE} must be a PATH command or a fully absolute executable path.`);
    }
    assertNativeExecutable(override, platform, EXECUTABLE_OVERRIDE);
    // Select the entire launch plan; an executable override never inherits a
    // configured wrapper prefix or session dialect.
    return frozenPlan(override, [], sessionDialect);
  }
  if (configured) return configured;
  const executable = await resolveClaudeExecutable(env, platform);
  assertNativeExecutable(executable, platform, "Reviewer executable");
  return frozenPlan(executable);
}


export function buildReviewerSessionArguments({
  sessionDialect = "claude",
  sessionId = null,
  newSessionId = null,
  fork = false,
  noSessionPersistence = false,
} = {}) {
  assertSessionDialect(sessionDialect, "Reviewer session dialect");
  const args = [];
  if (sessionId !== null && sessionId !== undefined) {
    assertSessionId(sessionId, "Reviewer session ID");
    args.push(sessionDialect === "codeagent" ? "--sessions" : "--resume", sessionId);
  } else if (sessionDialect === "codeagent") {
    assertSessionId(newSessionId, "CodeAgent new session ID");
    args.push("--session-id", newSessionId);
  }
  if (fork) args.push("--fork-session");
  if (noSessionPersistence) args.push("--no-session-persistence");
  if (sessionDialect === "codeagent" && args.some(isForbiddenCodeAgentSessionArgument)) {
    throw new Error("CodeAgent reviewer arguments cannot contain --resume or --continue.");
  }
  return args;
}


export function buildReviewerInvocation(plan, cliArgs) {
  const args = [...plan.argsPrefix, ...cliArgs];
  if (plan.sessionDialect === "codeagent" && args.some(isForbiddenCodeAgentSessionArgument)) {
    throw new Error("CodeAgent reviewer arguments cannot contain --resume or --continue.");
  }
  return { executable: plan.executable, args };
}


export function decorateReviewerLaunchError(error, platform = process.platform) {
  if (platform === "win32" && ["ENOENT", "EINVAL", "ENOEXEC", "EACCES"].includes(error.code)) {
    error.message += " Windows reviewers run without a shell. Verify the executable exists or is on PATH; use a native executable or node.exe with an absolute JavaScript entry in reviewerRuntime.argsPrefix instead of a .cmd/.bat/.ps1 shim.";
  }
  return error;
}
