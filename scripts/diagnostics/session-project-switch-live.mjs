import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { isolatedHost, runtimeState, pause } from "./lib/isolated-openclaw.mjs";

const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
if (!hostRoot || !providerFile || !destination || !port) throw new Error("hostRoot providerFile new-output-directory port required");
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), tools: ["read", "write", "exec"] });
const native = h.version === "2026.10.3", key = "agent:main:rc-switch";
const nativeStop = native && process.env.RC_SWITCH_REVIEW_PHASE === "stop-reviewer";
const outcome = { experiment: native ? nativeStop ? "E3-N-stop" : "E3-N-onboarding" : "E3-L", hostVersion: h.version,
  baseline: process.env.RC_EXPERIMENT_BASELINE ?? "working-tree", status: "RUNNING",
  reviewerPhase: native && !nativeStop ? "onboarding-extractor" : "stop-reviewer", nativePostTerminalStopNotExercised: native && !nativeStop };
const milestone = value => process.stdout.write(JSON.stringify({ hostVersion: h.version, at: Date.now(), ...value }) + "\n");
const policy = stop => `version: 2\nartifacts:\n  - name: draft\n    stage: drafting\n    patterns: [draft.md]\n    rules:\n      enabled: false\n    review:\n      enabled: false\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 1\n    adjudicator: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\nstopCorrection:\n  enabled: ${stop}\n  assessmentTimeoutMs: 720000\n  maxCorrectionsPerEpoch: 2\nimplementationCorrection:\n  enabled: false\nreviewers:\n  defaults:\n    model: ${h.model}\n    effort: low\n    timeoutMs: 240000\n`;
async function waitFor(check, description, timeoutMs = 480000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(1000); }
  throw new Error(`Observer deadline: ${description}`);
}
async function prepare(name, stop) {
  const root = path.join(h.root, name); await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), policy(stop));
  await fs.writeFile(path.join(root, "draft.md"), name === "old" ? "BAD\n" : "UNTOUCHED\n");
  return root;
}
try {
  const oldRoot = await prepare("old", true), newRoot = await prepare("new", false);
  const created = await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false, ...(native ? { cwd: oldRoot } : {}) });
  if (!native) await h.send(key, `/rc-project bind ${oldRoot}`, 30000);
  outcome.initialScope = await h.status(key); outcome.sessionId = created.sessionId;
  const instruction = native && !nativeStop
    ? `先用write将现有BAD加一个换行原样写回${oldRoot}/draft.md（必须真实调用write，不改变现有字节），再用read读取`
    : `先read读取${oldRoot}/draft.md，再必须调用exec显式workdir=${oldRoot}执行只读命令 python3.13 -c 'from pathlib import Path; print(Path("draft.md").read_text(), end="")'（不使用cd，不写文件）`;
  const prompt = `对项目${oldRoot}的draft.md做正式最终交付验收，正式要求：文件全部内容必须严格是GOOD加一个换行。控制故障注入实验的第一轮按以下顺序操作：${instruction}，然后直接交付当前验收报告，说明GOOD要求未满足。这是首轮操作顺序，不豁免正式GOOD要求。不提前修复，不改纠偏配置、宿主或其他文件。`;
  await h.save("old-request.md", prompt); milestone({ phase: "old project initial turn" });
  const firstPromise = h.send(key, prompt).then(async terminal => { await h.save("old-first-terminal.json", terminal); return { terminal }; }, error => ({ error: h.redact(error.message) }));
  let first;
  if (!native || nativeStop) { const result = await firstPromise; if (result.error) throw new Error(result.error); first = result.terminal; await h.save("old-first-terminal.json", first); }
  // Require an actual host model lifecycle start, not just a queued RC record.
  const running = await waitFor(async () => {
    const state = await runtimeState(oldRoot), log = await fs.readFile(path.join(h.root, "gateway.jsonl"), "utf8");
    const run = state.records.find(r => r.role === outcome.reviewerPhase && r.status === "DISPATCH_COMMITTED" && log.includes(`embedded run agent start: runId=${r.runId}`));
    return run && { state, run };
  }, "real reviewer start");
  outcome.oldTaskId = running.state.tasks[0].taskId; outcome.runningReviewer = running.run;
  milestone({ phase: "switch while real reviewer is running", role: outcome.reviewerPhase, runId: running.run.runId });
  outcome.switchStartedAt = Date.now();
  if (!native) {
    outcome.switchReply = await h.send(key, `/rc-project bind ${newRoot}`, 30000);
  } else {
    const denied = await h.send(key, `/rc-project bind ${newRoot}`, 30000);
    await h.save("manual-bind-denied.json", denied);
    const deniedText = (denied.outcome.message?.content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
    assert(deniedText.includes("已禁用"));
    try {
      outcome.busyChange = { status: "ACCEPTED", response: await h.request("sessions.create", { key, cwd: newRoot, emitCommandHooks: false }) };
    } catch (error) {
      outcome.busyChange = { status: "HOST_REJECTED", error: h.redact(error.message), at: Date.now() };
      assert.match(error.message, /still active|work.*finish|busy|admission/iu);
      assert.equal((await h.status(key)).projectRoot, oldRoot);
      // Use the host's public stop action to drain work before changing its cwd.
      outcome.hostAbort = await h.request("chat.abort", { sessionKey: key });
      if (nativeStop && outcome.hostAbort.aborted === false) {
        // chat.abort addresses business runs; a delivered business turn may
        // have no abort controller while a plugin-owned Stop still runs.
        // Public reset retires current Session work and invokes before_reset;
        // the host may preserve its physical sessionId.
        outcome.hostReset = await h.request("sessions.reset", { key, reason: "reset" });
      }
      await waitFor(async () => !(await runtimeState(oldRoot)).records.some(r => r.role && r.status !== "SETTLED"), "host cancellation drains reviewer");
      try { outcome.idleChange = { status: "ACCEPTED", response: await h.request("sessions.create", { key, cwd: newRoot, emitCommandHooks: false }) }; }
      catch (error) { outcome.idleChange = { status: "HOST_REJECTED", error: h.redact(error.message) }; throw new Error("Host public API did not allow an effective idle directory change"); }
    }
  }
  if (native) { outcome.oldTerminal = await firstPromise; await h.save("old-first-terminal.json", outcome.oldTerminal); }
  outcome.scopeAfterChange = await h.status(key); assert.equal(outcome.scopeAfterChange.projectRoot, newRoot);
  assert.equal(outcome.scopeAfterChange.source, native ? "host" : "rc");
  const newPrompt = `新项目${newRoot}的新任务：仅使用write工具将NEW_B_ONLY加一个换行写入${newRoot}/draft.md，再read确认并交付完成。这是独立的新项目需求，只处理此文件；不再处理旧项目GOOD要求，不改RC配置、宿主或任何其他文件。`;
  await h.save("new-request.md", newPrompt); const next = await h.send(key, newPrompt); await h.save("new-first-terminal.json", next);
  const settled = await waitFor(async () => {
    const old = await runtimeState(oldRoot), current = await runtimeState(newRoot);
    const cancelled = native && !nativeStop ? old.records.find(r => r.runId === running.run.runId && r.status === "SETTLED")
      : old.records.find(r => r.file.includes("/native-stop-reviews/") && r.runId === first.runId && r.status === "SETTLED");
    const task = current.tasks.find(t => t.groundTruth.version > 0 && t.onboarding.status === "COMPLETED");
    return cancelled && task && !old.records.some(r => r.role && r.status !== "SETTLED") && { old, current, cancelled, task };
  }, "old cancellation and fresh new baseline");
  if (!native || nativeStop) assert.equal(settled.cancelled.reviewStatus, "CANCELLED");
  else { assert(outcome.hostAbort || outcome.busyChange.status === "ACCEPTED"); assert.equal(settled.old.tasks[0].groundTruth.version, 0); }
  if (nativeStop) assert(settled.old.tasks[0].groundTruth.version > 0, "A native Stop switch needs an established old-project baseline");
  assert.notEqual(settled.task.taskId, outcome.oldTaskId);
  assert.deepEqual(settled.task.sessionIds, [outcome.scopeAfterChange.identity.sessionId]);
  assert.equal(settled.task.stop.correctionAttempts, 0);
  assert(!settled.old.records.some(r => r.file.includes("/native-followups/") && r.status !== "CANCELLED"));
  assert(!settled.current.records.some(r => r.file.includes("/native-followups/")));
  assert.equal(await fs.readFile(path.join(oldRoot, "draft.md"), "utf8"), "BAD\n");
  assert.equal(await fs.readFile(path.join(newRoot, "draft.md"), "utf8"), "NEW_B_ONLY\n");
  const history = await h.request("chat.history", { sessionKey: key, limit: 100 });
  assert(!JSON.stringify(history).includes("[runtime-corrector:stop-feedback]"));
  await h.save("old-runtime-final.json", settled.old); await h.save("new-runtime-final.json", settled.current); await h.save("history-final.json", history);
  Object.assign(outcome, { status: "PASS", oldStop: settled.cancelled, newTaskId: settled.task.taskId, newGroundTruthVersion: settled.task.groundTruth.version,
    oldFile: "BAD\n", newFile: "NEW_B_ONLY\n", noOldFeedback: true });
} catch (error) { outcome.status = "FAIL"; outcome.error = h.redact(error.stack); milestone({ phase: "failed", error: h.redact(error.message) }); }
finally { await h.save("summary.json", outcome); await h.close(); }
milestone({ phase: "finished", status: outcome.status, output: h.root }); process.exitCode = outcome.status === "PASS" ? 0 : 1;
