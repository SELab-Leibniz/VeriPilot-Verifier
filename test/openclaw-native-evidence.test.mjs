import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureCommand, hostDeviceVerifier } from "../lib/openclaw/native-evidence.mjs";

async function workspace(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-native-evidence-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}
const completed = (command, cwd, exitCode = 0) => ({ toolCallId: `host:${command}`, args: { command, cwd },
  result: { content: [{ type: "text", text: exitCode === 0 ? "actual fixture result: build succeeded" : "actual fixture result: compiler error" }],
    details: { status: "completed", exitCode } } });
const adapter = { deviceCheck: {
  probes: { device: { fileExists: "missing-device.flag" }, toolchain: { command: "fixture-toolchain", args: ["--version"] } },
  build: { command: "fixture-build", args: ["--production"] },
} };
const verify = (state, manifestDigest = "source-A") => hostDeviceVerifier(state)({
  projectRoot: state.projectRoot, adapter, deviceConfig: { mode: "auto" }, manifestDigest,
});

test("native validation consumes exact-cwd completed host results for the current source version", async (t) => {
  const state = { projectRoot: await workspace(t) };
  captureCommand(state, completed("fixture-toolchain --version", state.projectRoot), "source-A", "source-A");
  captureCommand(state, completed("fixture-build --production", state.projectRoot), "source-A", "source-A");
  const result = await verify(state);
  assert.equal(result.assurance.level, "build"); assert.equal(result.build.status, "passed");
  assert.deepEqual(result.findings, []);
  assert.equal(state.hostCommands.size, 2);
});

test("native validation refuses other working directories and commands with embedded directory changes", async (t) => {
  const projectRoot = await workspace(t);
  for (const event of [
    completed("fixture-toolchain --version", path.dirname(projectRoot)),
    { ...completed("fixture-toolchain --version", projectRoot), args: { command: "fixture-toolchain --version", workdir: path.dirname(projectRoot) } },
    completed("cd ../other && fixture-toolchain --version", projectRoot),
    completed("Set-Location ../other; fixture-toolchain --version", projectRoot),
    { ...completed("fixture-toolchain --version", projectRoot), args: { command: "fixture-toolchain --version" }, cwd: path.dirname(projectRoot) },
  ]) {
    const state = { projectRoot };
    captureCommand(state, event, "source-A", "source-A");
    assert.equal(state.hostCommands?.size ?? 0, 0);
    await assert.rejects(verify(state), { code: "HOST_EXECUTION_EVIDENCE_REQUIRED" });
  }
});

test("native validation refuses running, approval, missing-exit and stale-source command evidence", async (t) => {
  const projectRoot = await workspace(t);
  for (const [event, before, after] of [
    [completed("fixture-toolchain --version", projectRoot), "source-A", "source-B"],
    [{ args: { command: "fixture-toolchain --version", cwd: projectRoot }, result: {
      content: [{ type: "text", text: "The business model says success." }], details: { status: "completed" } } }, "source-A", "source-A"],
    [{ ...completed("fixture-toolchain --version", projectRoot), result: { details: { status: "running", exitCode: 0 }, content: [] } }, "source-A", "source-A"],
    [{ ...completed("fixture-toolchain --version", projectRoot), result: { details: { status: "approval-pending", approvalId: "pending", exitCode: 0 }, content: [] } }, "source-A", "source-A"],
  ]) {
    const state = { projectRoot };
    captureCommand(state, event, before, after);
    assert.equal(state.hostCommands?.size ?? 0, 0);
    await assert.rejects(verify(state), { code: "HOST_EXECUTION_EVIDENCE_REQUIRED" });
  }
  const state = { projectRoot };
  captureCommand(state, completed("fixture-toolchain --version", projectRoot), "source-A", "source-A");
  captureCommand(state, completed("fixture-build --production", projectRoot), "source-A", "source-A");
  await assert.rejects(verify(state, "source-B"), { code: "HOST_EXECUTION_EVIDENCE_REQUIRED" });
});

test("absent host execution remains unverified without running a command or inventing success", async (t) => {
  const state = { projectRoot: await workspace(t) };
  await assert.rejects(verify(state), { code: "HOST_EXECUTION_EVIDENCE_REQUIRED" });
  assert.equal(state.hostCommands, undefined);
  assert.deepEqual(await fs.readdir(state.projectRoot), []);
});

test("actual host compiler failures remain business deviations instead of reviewer infrastructure errors", async (t) => {
  const state = { projectRoot: await workspace(t) };
  captureCommand(state, completed("fixture-toolchain --version", state.projectRoot), "source-A", "source-A");
  captureCommand(state, completed("fixture-build --production", state.projectRoot, 2), "source-A", "source-A");
  const result = await verify(state);
  assert.equal(result.build.status, "failed"); assert.equal(result.build.exitCode, 2);
  assert.ok(result.findings.some(finding => finding.deviationKey === "impl:build:gate" && finding.severity === "error"));
  assert.match(result.findings[0].actualEvidence.join("\n"), /compiler error/);
});
