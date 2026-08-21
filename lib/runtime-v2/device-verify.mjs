// Device-level verification ladder (generalization wave 4). The core is a
// GENERAL framework — it knows nothing about any platform. Every concrete
// command (device probe, toolchain probe, build, smoke steps) is declared by
// the platform adapter's deviceCheck section; a platform without one simply
// caps at the static assurance level, exactly as an unknown platform skips
// the kit check.
//
// Philosophy (mirrors the study's EXTERNAL_BLOCKED discipline):
// - A missing device changes VERIFIABILITY, never correctness: it can only
//   lower the assurance level and must be disclosed, never flip a judgement.
// - Checks the environment cannot run are SKIPPED with a recorded reason —
//   never PASS (fabrication) and never a deviation against the developer.
// - What DID run and objectively failed (a build break, a crash on launch)
//   is a real, blocking finding: it was verifiable, and it failed.
//
// Assurance ladder: device > build > static.
// - device: a target is connected AND the toolchain exists → build gate +
//   adapter-declared smoke steps (install/launch/…).
// - build: toolchain only → build gate.
// - static: neither (or deviceCheck absent, or device.mode "off").
// device.mode "required" (CI) turns a sub-device level into a blocking
// infrastructure finding instead of a silent downgrade.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const LOG_TAIL_CHARS = 2000;
const DEFAULT_STEP_TIMEOUT_MS = 60000;
const ARTIFACT_WALK_LIMIT = 2000;


/** Bounded, never-throwing command runner (injectable for tests). */
export async function runCommand(command, args, { cwd, timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      let executable = command;
      let executableArgs = args;
      let windowsVerbatimArguments = false;
      if (/\.(?:bat|cmd)$/iu.test(command)) {
        if (!path.isAbsolute(command) || /[\r\n"&|<>^%!]/u.test(command)
          || args.some((arg) => /[\r\n"&|<>^%!]/u.test(String(arg)))) {
          done({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "unsafe batch command path" });
          return;
        }
        executable = process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
        executableArgs = [
          "/d",
          "/s",
          "/c",
          `""${command}" ${args.map((arg) => `"${String(arg)}"`).join(" ")}"`.trim(),
        ];
        windowsVerbatimArguments = true;
      }
      const child = execFile(executable, executableArgs, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsVerbatimArguments,
      }, (error, stdout, stderr) => {
        done({
          ok: !error,
          exitCode: error?.code === undefined || typeof error?.code !== "number" ? (error ? -1 : 0) : error.code,
          stdout: String(stdout ?? "").slice(-LOG_TAIL_CHARS),
          stderr: String(stderr ?? "").slice(-LOG_TAIL_CHARS),
          error: error ? String(error.message).slice(0, 300) : null,
        });
      });
      child.on("error", (error) => done({ ok: false, exitCode: -1, stdout: "", stderr: "", error: String(error.message).slice(0, 300) }));
    } catch (error) {
      done({ ok: false, exitCode: -1, stdout: "", stderr: "", error: String(error.message).slice(0, 300) });
    }
  });
}


/**
 * Evaluate one adapter-declared probe: either { fileExists } (relative to the
 * project root) or { command, args, successPattern } — success requires exit
 * 0 and, when successPattern is present, a multiline match against stdout.
 */
async function evaluateProbe(probe, { projectRoot, execFn }) {
  if (!probe || typeof probe !== "object") return { available: false, detail: "probe not declared" };
  if (probe.fileExists) {
    try {
      await fs.access(path.join(projectRoot, probe.fileExists));
      return { available: true, detail: `${probe.fileExists} present` };
    } catch {
      return { available: false, detail: `${probe.fileExists} absent` };
    }
  }
  if (!probe.command) return { available: false, detail: "probe not declared" };
  const result = await execFn(probe.command, probe.args ?? [], { cwd: projectRoot, timeoutMs: probe.timeoutMs ?? 10000 });
  if (!result.ok) return { available: false, detail: result.error ?? `exit ${result.exitCode}` };
  if (probe.successPattern) {
    let pattern;
    try {
      pattern = new RegExp(probe.successPattern, "mu");
    } catch {
      return { available: false, detail: "invalid successPattern" };
    }
    if (!pattern.test(result.stdout)) {
      return { available: false, detail: `no match: ${result.stdout.trim().slice(0, 120) || "(empty output)"}` };
    }
  }
  return { available: true, detail: result.stdout.trim().slice(0, 120) || "ok" };
}


/** Probe device + toolchain availability through the adapter declarations. */
export async function probeDeviceEnvironment({ projectRoot, adapter, execFn = runCommand }) {
  const deviceCheck = adapter?.deviceCheck;
  if (!deviceCheck) {
    return {
      declared: false,
      device: { available: false, detail: "platform declares no deviceCheck" },
      toolchain: { available: false, detail: "platform declares no deviceCheck" },
    };
  }
  return {
    declared: true,
    device: await evaluateProbe(deviceCheck.probes?.device, { projectRoot, execFn }),
    toolchain: await evaluateProbe(deviceCheck.probes?.toolchain, { projectRoot, execFn }),
  };
}


/** Convert the task-scoped HarmonyOS snapshot into the generic ladder probe. */
export function probeDeviceEnvironmentFromSnapshot(snapshot, adapter) {
  if (!snapshot) return null;
  return {
    declared: Boolean(adapter?.deviceCheck),
    device: {
      available: snapshot.capabilities?.target?.state === "CONNECTED",
      detail: snapshot.capabilities?.target?.state ?? "UNKNOWN",
    },
    toolchain: {
      available: snapshot.capabilities?.build?.state === "READY",
      detail: snapshot.capabilities?.build?.state ?? "UNKNOWN",
    },
    cached: true,
    snapshotStatus: snapshot.status,
  };
}


function resolveCommand(command, commandOverrides = {}) {
  return commandOverrides[command]
    ?? (command === "./hvigorw" ? commandOverrides.hvigorw : null)
    ?? command;
}


/**
 * Ladder resolution. mode: "auto" (default) degrades honestly; "required"
 * additionally raises an infrastructure violation when the device level is
 * unreachable; "off" pins static.
 */
export function resolveAssuranceLevel(probe, mode = "auto") {
  if (mode === "off") return { level: "static", reason: "DEVICE_MODE_OFF", requiredViolation: false };
  let level = "static";
  let reason = probe.declared ? "NO_TOOLCHAIN" : "NO_DEVICE_CHECK_DECLARED";
  if (probe.toolchain?.available) {
    level = probe.device?.available ? "device" : "build";
    reason = level === "device" ? "DEVICE_AND_TOOLCHAIN" : "NO_DEVICE_TARGET";
  }
  return { level, reason, requiredViolation: mode === "required" && level !== "device" };
}


/**
 * Deterministic build gate, cached on the source-manifest digest: identical
 * sources reproduce the identical build outcome, so each Stop cycle does not
 * pay the build twice.
 */
export async function runBuildGate({
  projectRoot,
  adapter,
  budgetMs,
  execFn = runCommand,
  cacheFile = null,
  manifestDigest = null,
  commandOverrides = {},
}) {
  const build = adapter?.deviceCheck?.build;
  if (!build?.command) return { status: "skipped", detail: "platform declares no build command" };
  if (cacheFile && manifestDigest) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (cached.manifestDigest === manifestDigest) return { ...cached.result, cached: true };
    } catch {
      // no cache yet
    }
  }
  const command = resolveCommand(build.command, commandOverrides);
  const result = await execFn(command, build.args ?? [], { cwd: projectRoot, timeoutMs: budgetMs });
  const outcome = {
    status: result.ok ? "passed" : "failed",
    command: [command, ...(build.args ?? [])].join(" "),
    exitCode: result.exitCode,
    logTail: (result.stderr || result.stdout || result.error || "").slice(-LOG_TAIL_CHARS),
  };
  if (cacheFile && manifestDigest) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ manifestDigest, result: outcome }), "utf8");
    } catch {
      // cache is an optimization only
    }
  }
  return outcome;
}


async function findArtifact(projectRoot, artifacts) {
  const roots = artifacts?.roots ?? [];
  const extension = String(artifacts?.extension ?? "").toLowerCase();
  if (roots.length === 0 || !extension) return null;
  let visited = 0;
  for (const root of roots) {
    const stack = [path.join(projectRoot, root)];
    while (stack.length > 0 && visited < ARTIFACT_WALK_LIMIT) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase().endsWith(extension)) return full;
      }
    }
  }
  return null;
}


async function discoverBundleName(projectRoot, smoke) {
  if (!smoke?.bundleNameFile || !smoke?.bundleNamePattern) return null;
  try {
    const content = await fs.readFile(path.join(projectRoot, smoke.bundleNameFile), "utf8");
    const match = content.match(new RegExp(smoke.bundleNamePattern, "u"));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}


/**
 * Adapter-declared smoke steps (install/launch/…). Placeholders {artifact},
 * {bundleName}, {outputDir}, {projectRoot} are substituted into args. Runs
 * sequentially; the first failing step ends the run.
 */
export async function runDeviceSmoke({ projectRoot, adapter, outputDir, execFn = runCommand, commandOverrides = {} }) {
  const smoke = adapter?.deviceCheck?.smoke;
  if (!smoke?.steps?.length) return { status: "skipped", detail: "platform declares no smoke steps" };
  const bundleName = await discoverBundleName(projectRoot, smoke);
  const artifact = await findArtifact(projectRoot, smoke.artifacts);
  if (smoke.steps.some((step) => (step.args ?? []).some((arg) => arg.includes("{artifact}"))) && !artifact) {
    return { status: "skipped", detail: "no build artifact found to install" };
  }
  const substitutions = {
    "{artifact}": artifact ?? "",
    "{bundleName}": bundleName ?? "",
    "{outputDir}": outputDir ?? projectRoot,
    "{projectRoot}": projectRoot,
  };
  if (outputDir) {
    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch {
      // evidence dir is best-effort
    }
  }
  const steps = [];
  for (const step of smoke.steps) {
    const args = (step.args ?? []).map((arg) => Object.entries(substitutions)
      .reduce((value, [token, replacement]) => value.replaceAll(token, replacement), arg));
    const command = resolveCommand(step.command, commandOverrides);
    const result = await execFn(command, args, { cwd: projectRoot, timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
    steps.push({
      name: step.name ?? step.command,
      ok: result.ok,
      detail: (result.error || result.stderr || result.stdout || "").trim().slice(0, 300),
    });
    if (!result.ok) {
      return { status: "failed", failedStep: step.name ?? step.command, steps, bundleName, artifact };
    }
  }
  return { status: "passed", steps, bundleName, artifact };
}


/**
 * The full ladder: probe → level → build gate → smoke, producing deterministic
 * findings plus an assurance record for disclosure. Never throws.
 */
export async function deviceVerification({
  projectRoot,
  adapter,
  deviceConfig = {},
  budgetMs = 600000,
  outputDir = null,
  cacheFile = null,
  manifestDigest = null,
  execFn = runCommand,
  environmentSnapshot = null,
  commandOverrides = {},
}) {
  const mode = deviceConfig.mode ?? "auto";
  const probe = probeDeviceEnvironmentFromSnapshot(environmentSnapshot, adapter)
    ?? await probeDeviceEnvironment({ projectRoot, adapter, execFn });
  const { level, reason, requiredViolation } = resolveAssuranceLevel(probe, mode);
  const findings = [];
  let build = { status: "skipped", detail: `assurance level ${level}` };
  let smoke = { status: "skipped", detail: `assurance level ${level}` };
  if (requiredViolation) {
    findings.push({
      deviationKey: "impl:device:required",
      rootCauseId: "EXTERNAL_ENVIRONMENT_BLOCK",
      severity: "error",
      reason: `device.mode is "required" but the environment only supports the ${level} assurance level (device: ${probe.device.detail}; toolchain: ${probe.toolchain.detail})`,
      actualEvidence: [`device probe: ${probe.device.detail}`, `toolchain probe: ${probe.toolchain.detail}`],
      expectedConstraint: "A connected device/emulator and the platform toolchain are required by configuration.",
      violatedGroundTruthIds: [],
      suggestedNextAction: "Connect a device or emulator (or relax implementationCorrection.device.mode to \"auto\").",
    });
  }
  if (level === "build" || level === "device") {
    build = await runBuildGate({
      projectRoot,
      adapter,
      budgetMs,
      execFn,
      cacheFile,
      manifestDigest,
      commandOverrides,
    });
    if (build.status === "failed") {
      findings.push({
        deviationKey: "impl:build:gate",
        rootCauseId: "REQUIREMENT_OMITTED",
        severity: "error",
        reason: `production build failed (exit ${build.exitCode}) — the build gate ran and is objectively failing`,
        actualEvidence: [`${build.command}: exit ${build.exitCode}`, build.logTail.slice(-500)],
        expectedConstraint: "The project must build cleanly with the platform toolchain.",
        violatedGroundTruthIds: [],
        suggestedNextAction: "Fix the build errors in the log tail before declaring completion.",
      });
    }
  }
  if (level === "device" && build.status === "passed") {
    smoke = await runDeviceSmoke({ projectRoot, adapter, outputDir, execFn, commandOverrides });
    if (smoke.status === "failed") {
      findings.push({
        deviationKey: `impl:device:${smoke.failedStep}`,
        rootCauseId: "REQUIREMENT_OMITTED",
        severity: "error",
        reason: `device smoke step "${smoke.failedStep}" failed — the app was verifiable on a live target and objectively failed`,
        actualEvidence: smoke.steps.map((step) => `${step.name}: ${step.ok ? "ok" : `FAILED ${step.detail}`}`),
        expectedConstraint: "The built app must install and pass the adapter-declared smoke steps on a connected target.",
        violatedGroundTruthIds: [],
        suggestedNextAction: "Reproduce with the same steps on the connected target and fix the failing stage.",
      });
    }
  }
  return {
    assurance: { level, reason, mode, declared: probe.declared },
    probe,
    build,
    smoke,
    findings,
  };
}
