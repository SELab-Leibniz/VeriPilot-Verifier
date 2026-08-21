import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "../json-schema-validator.mjs";
import {
  appendTaskJournal,
  taskDirectory,
  withTaskResourceLock,
  withTaskState,
} from "./task-store.mjs";
import { loadPlatformAdapter } from "./platform-adapter.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";


export const HARMONY_ENVIRONMENT_SNAPSHOT_SCHEMA = "runtime-corrector.harmony-environment-snapshot.v1";
const KNOWLEDGE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "knowledge", "platforms", "harmonyos-environment.v1.json",
);
const KNOWLEDGE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "config", "schemas", "environment-knowledge.schema.json",
);
const COMMAND_TIMEOUT_MS = 10_000;
const VERSION_CHARS = 200;


function snapshotPath(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), "environment", "harmonyos.json");
}


async function exists(candidate) {
  if (!candidate) return false;
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}


function boundedText(value, maximum = VERSION_CHARS) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, maximum);
}


function safeBatchCommand(command, args) {
  if (!path.isAbsolute(command) || /[\r\n"&|<>^%!]/u.test(command)) return null;
  if (args.some((arg) => /[\r\n"&|<>^%!]/u.test(String(arg)))) return null;
  return `""${command}" ${args.map((arg) => `"${String(arg)}"`).join(" ")}"`.trim();
}


/** Bounded command runner. Batch wrappers use cmd.exe only after strict validation. */
export async function runEnvironmentCommand(command, args, {
  cwd,
  timeoutMs = COMMAND_TIMEOUT_MS,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    let executable = command;
    let executableArgs = args;
    let windowsVerbatimArguments = false;
    if (/\.(?:bat|cmd)$/iu.test(command)) {
      const line = safeBatchCommand(command, args);
      if (!line) {
        resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "unsafe batch command path" });
        return;
      }
      executable = env.ComSpec ?? env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
      executableArgs = ["/d", "/s", "/c", line];
      windowsVerbatimArguments = true;
    }
    try {
      execFile(executable, executableArgs, {
        cwd,
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        windowsVerbatimArguments,
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0,
          stdout: boundedText(stdout, 4000),
          stderr: boundedText(stderr, 4000),
          error: error ? boundedText(error.message, 300) : null,
          timedOut: error?.killed === true,
        });
      });
    } catch (error) {
      resolve({ ok: false, exitCode: -1, stdout: "", stderr: "", error: boundedText(error.message, 300) });
    }
  });
}


export async function loadHarmonyEnvironmentKnowledge(filePath = KNOWLEDGE_PATH) {
  const document = JSON.parse(await fs.readFile(filePath, "utf8"));
  const schema = JSON.parse(await fs.readFile(KNOWLEDGE_SCHEMA_PATH, "utf8"));
  const issues = validateJsonSchema(document, schema);
  if (issues.length > 0) throw new Error(`Invalid HarmonyOS environment knowledge: ${issues[0].pointer} ${issues[0].message}`);
  const ids = new Set();
  for (const item of document.knowledge?.officialDocumentation ?? []) {
    const url = new URL(item.url);
    if (url.protocol !== "https:" || url.hostname !== "developer.huawei.com") {
      throw new Error(`Untrusted HarmonyOS documentation URL: ${item.url}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate HarmonyOS documentation id: ${item.id}`);
    ids.add(item.id);
  }
  const toolIds = new Set();
  for (const osKnowledge of Object.values(document.operatingSystems)) {
    for (const tool of osKnowledge.debuggingTools) {
      if (toolIds.has(tool.id)) throw new Error(`Duplicate HarmonyOS debugging tool id: ${tool.id}`);
      toolIds.add(tool.id);
    }
  }
  return document;
}


function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate?.path || !path.isAbsolute(candidate.path)) return false;
    const key = path.normalize(candidate.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


async function firstExisting(candidates) {
  for (const candidate of uniqueCandidates(candidates)) {
    if (await exists(candidate.path)) return candidate;
  }
  return null;
}


function pathCandidates(env, names) {
  const value = env.Path ?? env.PATH ?? "";
  return value.split(path.delimiter).filter(Boolean).flatMap((directory) => names.map((name) => ({
    path: path.resolve(directory, name),
    sourceKind: "path",
  })));
}


function rootedCandidates(roots, relatives) {
  return roots.flatMap((root) => relatives.map((relative) => ({
    path: path.join(root.path, relative),
    sourceKind: root.sourceKind,
    installationId: root.installationId,
  })));
}


async function toolProbe(candidate, probe, { projectRoot, env, execFn }) {
  if (!candidate) return { state: "ABSENT", sourceKind: null, version: null };
  if (!probe) {
    return {
      state: "UNKNOWN",
      sourceKind: candidate.sourceKind,
      version: null,
      error: "platform adapter declares no probe",
    };
  }
  const result = await execFn(candidate.path, probe.args ?? [], {
    cwd: projectRoot,
    timeoutMs: probe.timeoutMs ?? COMMAND_TIMEOUT_MS,
    env,
  });
  return {
    state: result.ok ? "READY" : "UNKNOWN",
    sourceKind: candidate.sourceKind,
    version: result.ok ? boundedText(result.stdout || result.stderr) : null,
    error: result.ok ? null : boundedText(result.error || result.stderr || `exit ${result.exitCode}`, 300),
  };
}


function targetSummary(result) {
  if (!result?.ok) {
    return { state: "UNKNOWN", count: 0, identityHashes: [], error: boundedText(result?.error || result?.stderr, 300) };
  }
  const lines = String(result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.every((line) => /^\[Empty\]$/iu.test(line))) {
    return { state: "ABSENT_AT_PROBE", count: 0, identityHashes: [] };
  }
  return {
    state: "CONNECTED",
    count: lines.length,
    identityHashes: lines.map((line) => sha256(line).slice(0, 16)),
  };
}


function uiTestReadiness(capabilities) {
  if (capabilities.build?.state === "READY"
    && capabilities.deviceControl?.state === "READY"
    && capabilities.target?.state === "CONNECTED") return "READY";
  if (capabilities.build?.state === "READY"
    && capabilities.deviceControl?.state === "READY"
    && capabilities.emulator?.state === "INSTALLED_NOT_STARTED") return "STARTABLE";
  return "BLOCKED";
}


/** Perform one read-only HarmonyOS environment transaction. */
export async function probeHarmonyEnvironment({
  projectRoot,
  taskId,
  env = process.env,
  hostPlatform = process.platform,
  execFn = runEnvironmentCommand,
  knowledgePath = KNOWLEDGE_PATH,
  adapter = null,
  now = new Date().toISOString(),
}) {
  const knowledge = await loadHarmonyEnvironmentKnowledge(knowledgePath);
  if (hostPlatform !== "win32") {
    return {
      schemaVersion: HARMONY_ENVIRONMENT_SNAPSHOT_SCHEMA,
      taskId,
      platform: "harmonyos",
      hostPlatform,
      checkedAt: now,
      status: hostPlatform === "darwin" ? "UNSUPPORTED_OS" : "NOT_APPLICABLE",
      capabilities: {},
      resolvedCommands: {},
      knowledgeDigest: sha256(knowledge),
      officialDocumentation: knowledge.knowledge.officialDocumentation,
    };
  }

  const platformAdapter = adapter ?? await loadPlatformAdapter("harmonyos");
  const environmentCheck = platformAdapter?.environmentCheck;
  if (!environmentCheck?.tools || !environmentCheck?.probes) {
    throw new Error("HarmonyOS platform adapter declares no environmentCheck");
  }

  const roots = [];
  for (const tool of knowledge.operatingSystems.win32.debuggingTools) {
    const configured = env[tool.environmentVariable];
    if (configured && path.isAbsolute(configured)) {
      roots.push({ path: path.normalize(configured), sourceKind: "env", installationId: tool.id });
    }
    for (const installPath of tool.installPaths) {
      roots.push({ path: path.normalize(installPath), sourceKind: "default", installationId: tool.id });
    }
  }
  const existingRoots = [];
  for (const root of uniqueCandidates(roots)) {
    if (await exists(root.path)) existingRoots.push(root);
  }
  const resolvedTools = {};
  for (const [toolName, declaration] of Object.entries(environmentCheck.tools)) {
    resolvedTools[toolName] = await firstExisting([
      ...(declaration.projectPaths ?? []).map((relative) => ({
        path: path.join(projectRoot, relative),
        sourceKind: "project",
      })),
      ...rootedCandidates(existingRoots, declaration.installationPaths ?? []),
      ...pathCandidates(env, declaration.pathNames ?? []),
    ]);
  }
  const hvigor = resolvedTools.hvigor ?? null;
  const hdc = resolvedTools.hdc ?? null;
  const previewer = resolvedTools.previewer ?? null;
  const emulator = resolvedTools.emulator ?? null;
  const sdk = resolvedTools.sdk ?? null;

  const build = await toolProbe(hvigor, environmentCheck.probes.build, { projectRoot, env, execFn });
  const deviceControl = await toolProbe(hdc, environmentCheck.probes.deviceControl, { projectRoot, env, execFn });
  let target = { state: "UNKNOWN", count: 0, identityHashes: [], error: "hdc is not ready" };
  const targetProbe = platformAdapter.deviceCheck?.probes?.device;
  if (hdc && deviceControl.state === "READY" && targetProbe) {
    target = targetSummary(await execFn(hdc.path, targetProbe.args ?? [], {
      cwd: projectRoot,
      timeoutMs: targetProbe.timeoutMs ?? COMMAND_TIMEOUT_MS,
      env,
    }));
  }
  const emulatorState = emulator ? "INSTALLED_NOT_STARTED" : "ABSENT";
  const previewerState = previewer ? "INSTALLED_NOT_EXECUTED" : "ABSENT";
  const readiness = uiTestReadiness({
    build,
    deviceControl,
    target,
    emulator: { state: emulatorState },
  });
  const anyPresent = existingRoots.length > 0 || hvigor || hdc || previewer || emulator || sdk;
  const status = build.state === "READY" && deviceControl.state === "READY"
    ? "AVAILABLE"
    : anyPresent
      ? "PARTIAL"
      : "UNAVAILABLE";
  return {
    schemaVersion: HARMONY_ENVIRONMENT_SNAPSHOT_SCHEMA,
    taskId,
    platform: "harmonyos",
    hostPlatform,
    checkedAt: now,
    status,
    capabilities: {
      installation: { state: existingRoots.length > 0 ? "PRESENT" : "ABSENT" },
      sdk: { state: sdk ? "PRESENT" : "ABSENT", sourceKind: sdk?.sourceKind ?? null },
      build,
      deviceControl,
      previewer: { state: previewerState, sourceKind: previewer?.sourceKind ?? null },
      emulator: { state: emulatorState, sourceKind: emulator?.sourceKind ?? null },
      target,
      uiTestReadiness: readiness,
    },
    resolvedCommands: {
      hvigor: hvigor?.path ?? null,
      hdc: hdc?.path ?? null,
      previewer: previewer?.path ?? null,
      emulator: emulator?.path ?? null,
    },
    knowledgeDigest: sha256(knowledge),
    officialDocumentation: knowledge.knowledge.officialDocumentation,
  };
}


/**
 * Refresh only the volatile connected-target fact immediately before Stop.
 * Static installation/tool facts remain the once-per-task cached snapshot.
 * The returned overlay is intentionally not persisted.
 */
export async function refreshHarmonyTarget(environment, {
  projectRoot,
  env = process.env,
  execFn = runEnvironmentCommand,
  adapter = null,
  now = new Date().toISOString(),
} = {}) {
  if (!environment || environment.platform !== "harmonyos") return environment;
  const initialState = environment.capabilities?.target?.state ?? "UNKNOWN";
  let target = environment.capabilities?.target ?? { state: "UNKNOWN", count: 0, identityHashes: [] };
  let attempted = false;
  try {
    const hdc = environment.resolvedCommands?.hdc;
    const deviceReady = environment.capabilities?.deviceControl?.state === "READY";
    const platformAdapter = adapter ?? await loadPlatformAdapter("harmonyos");
    const probe = platformAdapter?.deviceCheck?.probes?.device;
    if (hdc && deviceReady && probe) {
      attempted = true;
      target = targetSummary(await execFn(hdc, probe.args ?? [], {
        cwd: projectRoot,
        timeoutMs: probe.timeoutMs ?? COMMAND_TIMEOUT_MS,
        env,
      }));
    }
  } catch (error) {
    attempted = true;
    target = { state: "UNKNOWN", count: 0, identityHashes: [], error: boundedText(error.message, 300) };
  }
  const capabilities = {
    ...(environment.capabilities ?? {}),
    target,
  };
  capabilities.uiTestReadiness = uiTestReadiness(capabilities);
  return {
    ...environment,
    capabilities,
    targetRefresh: {
      checkedAt: now,
      attempted,
      initialState,
      state: target.state,
      device: {
        available: target.state === "CONNECTED",
        detail: target.state === "CONNECTED"
          ? `${target.count} connected target(s)`
          : target.error ?? target.state,
      },
    },
  };
}


/** Single-flight, once-per-task HarmonyOS probe. Later calls only read the snapshot. */
export async function ensureHarmonyEnvironmentSnapshot(options) {
  const { projectRoot, taskId, platform } = options;
  if (String(platform ?? "").toLowerCase() !== "harmonyos") return null;
  // An adapter default alone is not a project fingerprint. Avoid probing the
  // developer host for non-Harmony projects that merely inherited the legacy
  // default platform name.
  if (!await exists(path.join(projectRoot, "oh-package.json5"))) return null;
  return withTaskResourceLock({ projectRoot, taskId, resource: "harmonyos-environment" }, async () => {
    const filePath = snapshotPath(projectRoot, taskId);
    const cached = await readJson(filePath);
    if (cached?.schemaVersion === HARMONY_ENVIRONMENT_SNAPSHOT_SCHEMA) return { ...cached, cached: true };
    let snapshot;
    try {
      snapshot = await probeHarmonyEnvironment(options);
    } catch (error) {
      snapshot = {
        schemaVersion: HARMONY_ENVIRONMENT_SNAPSHOT_SCHEMA,
        taskId,
        platform: "harmonyos",
        hostPlatform: options.hostPlatform ?? process.platform,
        checkedAt: options.now ?? new Date().toISOString(),
        status: "UNKNOWN",
        capabilities: {},
        resolvedCommands: {},
        officialDocumentation: [],
        error: boundedText(error.message, 300),
      };
    }
    const digest = sha256(snapshot);
    await atomicWriteJson(filePath, snapshot);
    await withTaskState({ projectRoot, taskId }, (state) => {
      state.environment ??= {};
      state.environment.harmonyos = {
        schemaVersion: snapshot.schemaVersion,
        checkedAt: snapshot.checkedAt,
        status: snapshot.status,
        digest,
        snapshotPath: filePath.replaceAll("\\", "/"),
        uiTestReadiness: snapshot.capabilities?.uiTestReadiness ?? "BLOCKED",
      };
    });
    await appendTaskJournal(projectRoot, taskId, {
      type: snapshot.status === "UNKNOWN" ? "HARMONY_ENVIRONMENT_CHECK_FAILED" : "HARMONY_ENVIRONMENT_CHECK_COMPLETED",
      status: snapshot.status,
      digest,
      uiTestReadiness: snapshot.capabilities?.uiTestReadiness ?? "BLOCKED",
    });
    return { ...snapshot, cached: false };
  });
}
