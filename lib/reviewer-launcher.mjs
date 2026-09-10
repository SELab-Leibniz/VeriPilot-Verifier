import path from "node:path";

import * as activeHost from "./active-host.mjs";


const EXECUTABLE_OVERRIDE = "RUNTIME_CORRECTOR_AGENT_EXECUTABLE";
const REMOVED_SESSION_DIALECT_OVERRIDE = "RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT";


function frozenPlan(executable, argsPrefix = []) {
  return Object.freeze({
    executable,
    argsPrefix: Object.freeze([...argsPrefix]),
  });
}


function assertExecutable(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new Error(`${label} must be a nonblank executable string without NUL bytes.`);
  }
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
    throw new Error("reviewerRuntime must be an object containing executable and optional argsPrefix.");
  }
  if (Object.hasOwn(value, "sessionDialect")) {
    throw new Error("reviewerRuntime.sessionDialect has been removed; the reviewer session protocol is selected by the installed host artifact.");
  }
  if (Object.keys(value).some((key) => !["executable", "argsPrefix"].includes(key))) {
    throw new Error("reviewerRuntime only accepts executable and argsPrefix.");
  }
  assertExecutable(value.executable, "reviewerRuntime.executable");
  const argsPrefix = value.argsPrefix === undefined ? [] : value.argsPrefix;
  if (!Array.isArray(argsPrefix)
    || [...argsPrefix].some((arg) => typeof arg !== "string" || arg.includes("\u0000"))) {
    throw new Error("reviewerRuntime.argsPrefix must be an array of strings without NUL bytes.");
  }
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
  return frozenPlan(executable, argsPrefix);
}


export async function resolveReviewerLaunchPlan({
  reviewerRuntime,
  env = process.env,
  platform = process.platform,
  projectRoot,
  hostAdapter = activeHost,
} = {}) {
  // A valid environment override cannot hide an invalid declared configuration.
  const configured = normalizeReviewerRuntime(reviewerRuntime, { projectRoot, platform });
  if (env[REMOVED_SESSION_DIALECT_OVERRIDE] !== undefined) {
    throw new Error(`${REMOVED_SESSION_DIALECT_OVERRIDE} has been removed; the reviewer session protocol is selected by the installed host artifact.`);
  }
  const override = env[EXECUTABLE_OVERRIDE];
  if (override !== undefined) {
    assertExecutable(override, EXECUTABLE_OVERRIDE);
    if (!isAbsoluteExecutable(override, platform)
      && (hasPath(override) || (platform === "win32" && /^[A-Za-z]:/.test(override)))) {
      throw new Error(`${EXECUTABLE_OVERRIDE} must be a PATH command or a fully absolute executable path.`);
    }
    assertNativeExecutable(override, platform, EXECUTABLE_OVERRIDE);
    // Select the entire launch plan; an executable override never inherits a
    // configured wrapper prefix.
    return frozenPlan(override, []);
  }
  if (configured) return configured;
  const executable = await hostAdapter.resolveDefaultReviewerExecutable(env, platform);
  assertNativeExecutable(executable, platform, "Reviewer executable");
  return frozenPlan(executable);
}


export function buildReviewerInvocation(plan, cliArgs, hostAdapter = activeHost) {
  const args = [...plan.argsPrefix, ...cliArgs];
  hostAdapter.assertReviewerInvocation(args);
  return { executable: plan.executable, args };
}


export function decorateReviewerLaunchError(error, platform = process.platform) {
  if (platform === "win32" && ["ENOENT", "EINVAL", "ENOEXEC", "EACCES"].includes(error.code)) {
    error.message += " Windows reviewers run without a shell. Verify the executable exists or is on PATH; use a native executable or node.exe with an absolute JavaScript entry in reviewerRuntime.argsPrefix instead of a .cmd/.bat/.ps1 shim.";
  }
  return error;
}
