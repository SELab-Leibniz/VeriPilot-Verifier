import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { deviceVerification, probeDeviceEnvironmentFromSnapshot } from "../lib/runtime-v2/device-verify.mjs";
import {
  ensureHarmonyEnvironmentSnapshot,
  loadHarmonyEnvironmentKnowledge,
  probeHarmonyEnvironment,
  refreshHarmonyTarget,
} from "../lib/runtime-v2/harmony-environment.mjs";
import { ensureTask, taskStatePath } from "../lib/runtime-v2/task-store.mjs";
import { loadPlatformAdapter } from "../lib/runtime-v2/platform-adapter.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-harmony-env-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function touch(root, relative) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "fixture", "utf8");
  return file;
}


async function fakeDevEco(root) {
  await touch(root, "tools/hvigor/bin/hvigorw.bat");
  await touch(root, "sdk/default/openharmony/toolchains/hdc.exe");
  await touch(root, "sdk/default/openharmony/previewer/common/bin/Previewer.exe");
  await touch(root, "tools/emulator/Emulator.exe");
}


test("HarmonyOS environment knowledge preserves Windows tools, Mac extension point and official links", async () => {
  const knowledge = await loadHarmonyEnvironmentKnowledge();
  const adapter = await loadPlatformAdapter("harmonyos");
  assert.deepEqual(
    knowledge.operatingSystems.win32.debuggingTools.map((tool) => tool.environmentVariable),
    ["DEVECO_STUDIO", "COMMAND_LINE_TOOL_PATH"],
  );
  assert.deepEqual(knowledge.operatingSystems.darwin.debuggingTools, []);
  assert.equal(knowledge.knowledge.officialDocumentation.length, 6);
  assert.ok(knowledge.knowledge.officialDocumentation.every((document) => (
    new URL(document.url).hostname === "developer.huawei.com"
  )));
  assert.deepEqual(adapter.deviceCheck.probes.device.args, ["list", "targets"]);
  assert.ok(adapter.environmentCheck.tools.hvigor.projectPaths.includes("hvigorw.bat"));
});


test("HarmonyOS environment is probed once per task and distinguishes installed tooling from an empty target list", async (t) => {
  const root = await workspace(t);
  await touch(root, "oh-package.json5");
  const deveco = path.join(root, "DevEco Studio");
  await fakeDevEco(deveco);
  const task = await ensureTask({ projectRoot: root, sessionId: "harmony-env-once" });
  const calls = [];
  const execFn = async (command, args) => {
    calls.push({ command, args });
    if (args.join(" ") === "list targets") {
      return { ok: true, exitCode: 0, stdout: "[Empty]\n", stderr: "", error: null };
    }
    return { ok: true, exitCode: 0, stdout: args[0] === "--version" ? "6.24.2" : "ok", stderr: "", error: null };
  };
  const options = {
    projectRoot: root,
    taskId: task.taskId,
    platform: "harmonyos",
    hostPlatform: "win32",
    env: { DEVECO_STUDIO: deveco, Path: "" },
    execFn,
  };

  const first = await ensureHarmonyEnvironmentSnapshot(options);
  const second = await ensureHarmonyEnvironmentSnapshot(options);

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 3, "hvigor version, hdc version and target list run only once");
  assert.equal(first.status, "AVAILABLE");
  assert.equal(first.capabilities.build.state, "READY");
  assert.equal(first.capabilities.deviceControl.state, "READY");
  assert.equal(first.capabilities.emulator.state, "INSTALLED_NOT_STARTED");
  assert.equal(first.capabilities.target.state, "ABSENT_AT_PROBE");
  assert.equal(first.capabilities.uiTestReadiness, "STARTABLE");
  const state = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  assert.equal(state.environment.harmonyos.status, "AVAILABLE");
  assert.equal(state.environment.harmonyos.uiTestReadiness, "STARTABLE");
});


test("unsupported Mac knowledge remains an explicit extension point", async (t) => {
  const root = await workspace(t);
  const snapshot = await probeHarmonyEnvironment({
    projectRoot: root,
    taskId: "mac-task",
    hostPlatform: "darwin",
    env: {},
  });
  assert.equal(snapshot.status, "UNSUPPORTED_OS");
  assert.deepEqual(snapshot.capabilities, {});
});


test("device verification reuses static environment facts but refreshes the volatile target", async (t) => {
  const root = await workspace(t);
  const calls = [];
  const outcome = await deviceVerification({
    projectRoot: root,
    adapter: await loadPlatformAdapter("harmonyos"),
    environmentSnapshot: {
      status: "AVAILABLE",
      capabilities: {
        build: { state: "READY" },
        target: { state: "ABSENT_AT_PROBE" },
      },
    },
    commandOverrides: { "./hvigorw": "C:/tools/hvigorw.bat", hdc: "C:/tools/hdc.exe" },
    execFn: async (command, args) => {
      calls.push({ command, args });
      return {
        ok: true,
        exitCode: 0,
        stdout: args.join(" ") === "list targets" ? "[Empty]" : "build ok",
        stderr: "",
        error: null,
      };
    },
  });
  assert.equal(outcome.assurance.level, "build");
  assert.equal(outcome.probe.cached, true);
  assert.equal(outcome.probe.targetRefreshed, true);
  assert.equal(outcome.build.status, "passed");
  assert.deepEqual(calls.map((call) => call.command), ["C:/tools/hdc.exe", "C:/tools/hvigorw.bat"]);
});


test("Stop target refresh overlays the cached facts and the device ladder reuses it", async (t) => {
  const root = await workspace(t);
  const adapter = await loadPlatformAdapter("harmonyos");
  const cached = {
    platform: "harmonyos",
    status: "AVAILABLE",
    capabilities: {
      build: { state: "READY" },
      deviceControl: { state: "READY" },
      emulator: { state: "INSTALLED_NOT_STARTED" },
      target: { state: "ABSENT_AT_PROBE", count: 0 },
      uiTestReadiness: "STARTABLE",
    },
    resolvedCommands: { hdc: "C:/tools/hdc.exe" },
  };
  let calls = 0;
  const refreshed = await refreshHarmonyTarget(cached, {
    projectRoot: root,
    adapter,
    execFn: async (command, args) => {
      calls += 1;
      assert.equal(command, "C:/tools/hdc.exe");
      assert.deepEqual(args, ["list", "targets"]);
      return { ok: true, exitCode: 0, stdout: "device-42", stderr: "", error: null };
    },
  });
  assert.equal(refreshed.capabilities.target.state, "CONNECTED");
  assert.equal(refreshed.capabilities.uiTestReadiness, "READY");
  assert.equal(refreshed.targetRefresh.initialState, "ABSENT_AT_PROBE");

  const probe = await probeDeviceEnvironmentFromSnapshot(refreshed, adapter, {
    projectRoot: root,
    execFn: async () => {
      throw new Error("the Stop refresh must be reused");
    },
  });
  assert.equal(calls, 1);
  assert.equal(probe.device.available, true);
  assert.equal(probe.targetRefreshReused, true);
  assert.equal(probe.initialTargetState, "ABSENT_AT_PROBE");
});


test("a target connected after the task snapshot upgrades Stop verification to device", async (t) => {
  const root = await workspace(t);
  await touch(root, "entry/build/default/outputs/default/entry-default-signed.hap");
  const calls = [];
  const outcome = await deviceVerification({
    projectRoot: root,
    adapter: await loadPlatformAdapter("harmonyos"),
    outputDir: path.join(root, "evidence"),
    environmentSnapshot: {
      status: "AVAILABLE",
      capabilities: {
        build: { state: "READY" },
        target: { state: "ABSENT_AT_PROBE" },
      },
    },
    commandOverrides: { "./hvigorw": "C:/tools/hvigorw.bat", hdc: "C:/tools/hdc.exe" },
    execFn: async (command, args) => {
      calls.push({ command, args });
      return {
        ok: true,
        exitCode: 0,
        stdout: args.join(" ") === "list targets" ? "emulator-5554" : "ok",
        stderr: "",
        error: null,
      };
    },
  });
  assert.equal(outcome.assurance.level, "device");
  assert.equal(outcome.probe.initialTargetState, "ABSENT_AT_PROBE");
  assert.equal(outcome.smoke.status, "passed");
  assert.equal(calls[0].command, "C:/tools/hdc.exe");
  assert.deepEqual(calls[0].args, ["list", "targets"]);
});


test("device policy and Harmony awareness are accepted by project schema and compiled compatibly", () => {
  const document = {
    version: 2,
    artifacts: [{ name: "result", patterns: ["result.md"] }],
    dynamicGroundTruth: { enabled: true },
    implementationCorrection: {
      enabled: true,
      device: { mode: "required" },
      harmonyEnvironmentAwareness: { enabled: true },
    },
  };
  assert.equal(validateProjectConfig(document, "harmony.yaml"), document);
  const compiled = compileRuntimeV2Config(document);
  assert.equal(compiled.implementationCorrection.device.mode, "required");
  assert.equal(compiled.implementationCorrection.harmonyEnvironmentAwareness.enabled, true);
  assert.throws(() => validateProjectConfig({
    ...document,
    implementationCorrection: { enabled: true, device: { mode: "sometimes" } },
  }, "invalid.yaml"), /implementationCorrection\.device\.mode/u);
});
