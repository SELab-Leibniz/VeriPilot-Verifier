import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deviceVerification,
  probeDeviceEnvironment,
  resolveAssuranceLevel,
  runBuildGate,
  runDeviceSmoke,
} from "../lib/runtime-v2/device-verify.mjs";
import { loadPlatformAdapter } from "../lib/runtime-v2/platform-adapter.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "device-verify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** Scripted exec fake: responses keyed by "command arg0 arg1 …" prefix. */
function fakeExec(script) {
  const calls = [];
  const fn = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    for (const [prefix, result] of Object.entries(script)) {
      if (line.startsWith(prefix)) {
        return { ok: true, exitCode: 0, stdout: "", stderr: "", error: null, ...result };
      }
    }
    return { ok: false, exitCode: 127, stdout: "", stderr: "", error: `not found: ${command}` };
  };
  fn.calls = calls;
  return fn;
}

const ADAPTER = Object.freeze({
  name: "fakeos",
  deviceCheck: {
    probes: {
      device: { command: "fdc", args: ["list"], successPattern: "^(?!\\s*\\[Empty\\])\\S+" },
      toolchain: { fileExists: "buildw" },
    },
    build: { command: "./buildw", args: ["assemble"] },
    smoke: {
      bundleNameFile: "app.json5",
      bundleNamePattern: "\"bundleName\"\\s*:\\s*\"([^\"]+)\"",
      artifacts: { roots: ["out"], extension: ".pkg" },
      steps: [
        { name: "install", command: "fdc", args: ["install", "{artifact}"] },
        { name: "launch", command: "fdc", args: ["start", "{bundleName}"] },
      ],
    },
  },
});

test("the harmonyos adapter declares the device ladder and unknown platforms cap at static", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  assert.ok(adapter.deviceCheck.probes.device.command, "device probe declared");
  assert.ok(adapter.deviceCheck.build.command, "build gate declared");
  assert.ok(adapter.deviceCheck.smoke.steps.length >= 2, "smoke steps declared");
  const probe = await probeDeviceEnvironment({ projectRoot: "/nonexistent", adapter: null });
  assert.equal(probe.declared, false);
  assert.deepEqual(resolveAssuranceLevel(probe, "auto"), {
    level: "static",
    reason: "NO_DEVICE_CHECK_DECLARED",
    requiredViolation: false,
  });
});

test("assurance ladder resolves device/build/static from the probes and honours mode", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "buildw"), "#!/bin/sh\n");
  const withDevice = await probeDeviceEnvironment({
    projectRoot: root,
    adapter: ADAPTER,
    execFn: fakeExec({ "fdc list": { stdout: "emulator-5554\n" } }),
  });
  assert.deepEqual(resolveAssuranceLevel(withDevice, "auto"), {
    level: "device", reason: "DEVICE_AND_TOOLCHAIN", requiredViolation: false,
  });
  const noDevice = await probeDeviceEnvironment({
    projectRoot: root,
    adapter: ADAPTER,
    execFn: fakeExec({ "fdc list": { stdout: "[Empty]\n" } }),
  });
  assert.equal(resolveAssuranceLevel(noDevice, "auto").level, "build");
  assert.equal(resolveAssuranceLevel(noDevice, "auto").reason, "NO_DEVICE_TARGET");
  assert.equal(resolveAssuranceLevel(noDevice, "required").requiredViolation, true);
  assert.equal(resolveAssuranceLevel(withDevice, "off").level, "static");
  // No toolchain file: build unreachable even with a device.
  const bare = await workspace(t);
  const noToolchain = await probeDeviceEnvironment({
    projectRoot: bare,
    adapter: ADAPTER,
    execFn: fakeExec({ "fdc list": { stdout: "emulator-5554\n" } }),
  });
  assert.equal(resolveAssuranceLevel(noToolchain, "auto").level, "static");
});

test("the build gate records evidence and caches on the manifest digest", async (t) => {
  const root = await workspace(t);
  const cacheFile = path.join(root, "cache", "build.json");
  const exec = fakeExec({ "./buildw assemble": { ok: false, exitCode: 3, stderr: "ERROR: missing module" } });
  const first = await runBuildGate({
    projectRoot: root, adapter: ADAPTER, budgetMs: 1000, execFn: exec, cacheFile, manifestDigest: "d1",
  });
  assert.equal(first.status, "failed");
  assert.match(first.logTail, /missing module/u);
  const second = await runBuildGate({
    projectRoot: root, adapter: ADAPTER, budgetMs: 1000, execFn: exec, cacheFile, manifestDigest: "d1",
  });
  assert.equal(second.cached, true, "identical sources reuse the identical outcome");
  assert.equal(exec.calls.length, 1);
  const third = await runBuildGate({
    projectRoot: root, adapter: ADAPTER, budgetMs: 1000, execFn: exec, cacheFile, manifestDigest: "d2",
  });
  assert.equal(third.cached, undefined, "a changed manifest rebuilds");
});

test("device smoke substitutes discovered artifact and bundle name, and stops at the first failure", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "app.json5"), "{ \"bundleName\": \"com.fake.app\" }");
  await fs.mkdir(path.join(root, "out", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "out", "nested", "app.pkg"), "pkg");
  const passExec = fakeExec({ fdc: {} });
  const passed = await runDeviceSmoke({ projectRoot: root, adapter: ADAPTER, outputDir: path.join(root, "evidence"), execFn: passExec });
  assert.equal(passed.status, "passed");
  assert.equal(passed.bundleName, "com.fake.app");
  assert.match(passExec.calls[0], /fdc install .*app\.pkg$/u);
  assert.equal(passExec.calls[1], "fdc start com.fake.app");

  const failExec = fakeExec({ "fdc install": {}, "fdc start": { ok: false, exitCode: 1, stderr: "ability crashed" } });
  const failed = await runDeviceSmoke({ projectRoot: root, adapter: ADAPTER, outputDir: null, execFn: failExec });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failedStep, "launch");

  // No artifact on disk: install-dependent smoke SKIPS — never judged.
  const empty = await workspace(t);
  const skipped = await runDeviceSmoke({ projectRoot: empty, adapter: ADAPTER, execFn: fakeExec({ fdc: {} }) });
  assert.equal(skipped.status, "skipped");
});

test("deviceVerification composes the ladder: findings only for checks that ran and failed", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "buildw"), "#!/bin/sh\n");
  // Build level (no device): failing build yields exactly one blocking finding.
  const buildFail = await deviceVerification({
    projectRoot: root,
    adapter: ADAPTER,
    execFn: fakeExec({ "fdc list": { stdout: "[Empty]" }, "./buildw assemble": { ok: false, exitCode: 2, stderr: "boom" } }),
  });
  assert.equal(buildFail.assurance.level, "build");
  assert.deepEqual(buildFail.findings.map((finding) => finding.deviationKey), ["impl:build:gate"]);
  assert.equal(buildFail.smoke.status, "skipped");

  // Static level: nothing runs, nothing is judged — zero findings.
  const bare = await workspace(t);
  const staticOnly = await deviceVerification({ projectRoot: bare, adapter: ADAPTER, execFn: fakeExec({ "fdc list": { stdout: "[Empty]" } }) });
  assert.equal(staticOnly.assurance.level, "static");
  assert.deepEqual(staticOnly.findings, []);

  // required mode raises the infrastructure violation on top.
  const required = await deviceVerification({
    projectRoot: bare,
    adapter: ADAPTER,
    deviceConfig: { mode: "required" },
    execFn: fakeExec({ "fdc list": { stdout: "[Empty]" } }),
  });
  assert.deepEqual(required.findings.map((finding) => finding.deviationKey), ["impl:device:required"]);

  // Device level all green: no findings, smoke evidence recorded.
  await fs.writeFile(path.join(root, "app.json5"), "{ \"bundleName\": \"com.fake.app\" }");
  await fs.mkdir(path.join(root, "out"), { recursive: true });
  await fs.writeFile(path.join(root, "out", "app.pkg"), "pkg");
  const green = await deviceVerification({
    projectRoot: root,
    adapter: ADAPTER,
    execFn: fakeExec({ "fdc list": { stdout: "emulator-5554" }, "./buildw assemble": {}, fdc: {} }),
  });
  assert.equal(green.assurance.level, "device");
  assert.deepEqual(green.findings, []);
  assert.equal(green.build.status, "passed");
  assert.equal(green.smoke.status, "passed");
});
