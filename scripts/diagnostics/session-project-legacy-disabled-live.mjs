// Exercise legacy binding management and opt-out against a real Gateway.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { isolatedHost, pause } from "./lib/isolated-openclaw.mjs";

const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
if (!hostRoot || !providerFile || !destination || !port) throw new Error("hostRoot providerFile new-output-directory port required");
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), tools: ["exec"] });
const result = { experiment: "legacy-unconfigured-project-and-binding-management", hostVersion: h.version,
  baseline: process.env.RC_EXPERIMENT_BASELINE ?? "working-tree", status: "RUNNING" };
const starts = () => h.events.filter(e => e.event === "agent" && e.payload?.stream === "lifecycle" && e.payload.data?.phase === "start");
const text = terminal => {
  const content = terminal.outcome.message?.content;
  return typeof content === "string" ? content : (content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
};
try {
  assert.equal(h.version, "2026.7.1-2");
  const a = path.join(h.root, "unconfigured-a"), b = path.join(h.root, "unconfigured-b");
  for (const root of [a, b]) await fs.mkdir(root);
  const key = "agent:main:rc-disabled-project";
  await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false });
  result.unbound = await h.status(key);
  assert.equal(result.unbound.enabled, false); assert.equal(result.unbound.projectRoot, null);
  const bound = await h.send(key, `/rc-project bind ${a}`, 30000);
  await h.save("bind-reply.json", bound);
  // Mutation replies append a human-readable cwd notice after their JSON.
  assert.match(text(bound), /"hostWorkingDirectoryChanged"\s*:\s*false/u);
  result.bound = await h.status(key);
  assert.equal(result.bound.mode, "legacy"); assert.equal(result.bound.source, "rc");
  assert.equal(result.bound.projectRoot, a); assert.equal(result.bound.enabled, false);
  assert.equal(result.bound.reason, "RC_PROJECT_NOT_ENABLED"); assert.equal(starts().length, 0);
  const code = String.raw`from pathlib import Path; print(Path.cwd()); Path("marker.txt").write_text("UNCONFIGURED_OK\n", encoding="utf-8"); print("UNCONFIGURED_OK")`;
  const prompt = `执行一次真实文件操作：仅调用一次exec，显式workdir=${a}，原样运行以下命令。成功后报告实际输出，不调用其他工具，不创建其他文件：\npython3.13 -c '${code}'`;
  await h.save("request.md", prompt);
  const terminal = await h.send(key, prompt); await h.save("business-terminal.json", terminal);
  await pause(1500); // Let any erroneously scheduled post-delivery hook become observable.
  assert.equal(await fs.readFile(path.join(a, "marker.txt"), "utf8"), "UNCONFIGURED_OK\n");
  assert.equal(starts().length, 1, "Only the business model may start; no RC reviewers");
  result.modelRunIds = starts().map(e => e.payload.runId);
  result.boundBeforeRestart = await h.status(key);
  await h.restart();
  result.boundAfterRestart = await h.status(key);
  assert.deepEqual(result.boundAfterRestart.identity, result.boundBeforeRestart.identity);
  assert.equal(result.boundAfterRestart.projectRoot, a); assert.equal(result.boundAfterRestart.enabled, false);
  await h.send(key, `/rc-project bind ${b}`, 30000);
  result.changed = await h.status(key); assert.equal(result.changed.projectRoot, b); assert.equal(result.changed.enabled, false);
  await h.send(key, "/rc-project unbind", 30000);
  result.unboundAfter = await h.status(key); assert.equal(result.unboundAfter.projectRoot, null); assert.equal(result.unboundAfter.enabled, false);
  assert.equal(starts().length, 1, "Binding/status/restart must not invoke models");
  for (const root of [a, b, h.defaultDir]) {
    const names = await fs.readdir(root);
    assert(!names.includes(".runtime-corrector")); assert(!names.includes(".runtime-correction"));
  }
  const execution = h.events.filter(e => e.event === "agent" && e.payload?.stream === "tool" && e.payload.data?.name === "exec");
  assert(execution.some(e => e.payload.data.phase === "start"));
  result.hostWorkspace = h.config.agents.defaults.workspace;
  assert.equal(result.hostWorkspace, h.defaultDir);
  Object.assign(result, { status: "PASS", marker: "UNCONFIGURED_OK\n", noRcDirectories: true,
    noReviewerModels: true, managementStartedNoModels: true, restarted: true, hostWorkingDirectoryChanged: false });
} catch (error) { result.status = "FAIL"; result.error = h.redact(error.stack); }
finally { await h.save("summary.json", result); await h.close(); }
process.stdout.write(JSON.stringify({ status: result.status, output: h.root, error: result.error }) + "\n");
process.exitCode = result.status === "PASS" ? 0 : 1;
