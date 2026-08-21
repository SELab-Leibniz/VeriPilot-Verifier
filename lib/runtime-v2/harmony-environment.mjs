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


async function toolProbe(candidate, args, { projectRoot, env, execFn }) {
  if (!candidate) return { state: "ABSENT", sourceKind: null, version: null };
  const result = await execFn(candidate.path, args, {
    cwd: projectRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
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


/** Perform one read-only HarmonyOS environment transaction. */
export async function probeHarmonyEnvironment({
  projectRoot,
  taskId,
  env = process.env,
  hostPlatform = process.platform,
  execFn = runEnvironmentCommand,
  knowledgePath = KNOWLEDGE_PATH,
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
  const projectTools = [
    { path: path.join(projectRoot, "hvigorw.bat"), sourceKind: "project" },
    { path: path.join(projectRoot, "hvigorw.cmd"), sourceKind: "project" },
    { path: path.join(projectRoot, "hvigorw"), sourceKind: "project" },
  ];
  const hvigor = await firstExisting([
    ...projectTools,
    ...rootedCandidates(existingRoots, ["bin/hvigorw.bat", "bin/hvigorw.cmd", "tools/hvigor/bin/hvigorw.bat"]),
    ...pathCandidates(env, ["hvigorw.bat", "hvigorw.cmd", "hvigorw"]),
  ]);
  const hdc = await firstExisting([
    ...rootedCandidates(existingRoots, [
      "sdk/default/openharmony/toolchains/hdc.exe",
      "sdk/default/hms/toolchains/hdc.exe",
      "bin/hdc.exe",
    ]),
    ...pathCandidates(env, ["hdc.exe", "hdc"]),
  ]);
  const previewer = await firstExisting(rootedCandidates(existingRoots, [
    "sdk/default/openharmony/previewer/common/bin/Previewer.exe",
    "sdk/default/hms/previewer/common/bin/Previewer.exe",
  ]));
  const emulator = await firstExisting(rootedCandidates(existingRoots, [
    "emulator/Emulator.exe",
    "tools/emulator/Emulator.exe",
    "tools/emulator/bin/Emulator.exe",
  ]));
  const sdk = await firstExisting(rootedCandidates(existingRoots, [
    "sdk/default/openharmony",
    "sdk/default/hms",
    "sdk",
  ]));

  const build = await toolProbe(hvigor, ["--version"], { projectRoot, env, execFn });
  const deviceControl = await toolProbe(hdc, ["--version"], { projectRoot, env, execFn });
  let target = { state: "UNKNOWN", count: 0, identityHashes: [], error: "hdc is not ready" };
  if (hdc && deviceControl.state === "READY") {
    target = targetSummary(await execFn(hdc.path, ["list", "targets"], {
      cwd: projectRoot,
      timeoutMs: COMMAND_TIMEOUT_MS,
      env,
    }));
  }
  const emulatorState = emulator ? "INSTALLED_NOT_STARTED" : "ABSENT";
  const previewerState = previewer ? "INSTALLED_NOT_EXECUTED" : "ABSENT";
  const uiTestReadiness = build.state === "READY" && deviceControl.state === "READY" && target.state === "CONNECTED"
    ? "READY"
    : build.state === "READY" && deviceControl.state === "READY" && emulator
      ? "STARTABLE"
      : "BLOCKED";
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
      uiTestReadiness,
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
