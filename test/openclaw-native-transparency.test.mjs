import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";
let output, pluginRoot, createRuntime;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-transparency-build-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs"))));
});
after(() => fs.rm(output, { recursive: true, force: true }));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-native-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".runtime-corrector"));
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: draft
    stage: drafting
    patterns: [draft.md]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
`);
  const file = path.join(root, "native.jsonl"), sid = "native-parent";
  await fs.writeFile(file, [{ type: "session", id: sid }, { type: "message", id: "u", parentId: null,
    message: { role: "user", content: "Write a draft when appropriate." } }].map(JSON.stringify).join("\n"));
  const sharedState = {}, hostAbort = new AbortController(), warnings = [];
  const sessions = {
    getSessionEntry: async () => ({ sessionId: sid, sessionFile: file }),
    resolveStorePath: () => path.join(root, "sessions.json"), resolveSessionFilePath: () => file,
    runWithWorkAdmission: async (params, run) => run(params.signal),
  };
  const api = { id: "runtime-corrector", config: { agents: { defaults: { model: { primary: "test/test" } } } },
    pluginConfig: {}, logger: { warn: x => warnings.push(x) }, runtime: { agent: { session: sessions,
      runEmbeddedAgent: async () => assert.fail("these lifecycle/interaction fixtures must not call a model") } } };
  const runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true });
  const ctx = { workspaceDir: root, sessionId: sid, sessionKey: "agent:main:native", agentId: "main", runId: "host-run", trigger: "user", abortSignal: hostAbort.signal };
  await runtime.prompt({ prompt: "Write a draft when appropriate." }, ctx);
  return { runtime, ctx, sessions, hostAbort, warnings, state: sharedState.states.get(`main:${sid}`) };
}
test("identityless and internal reviewer end events do not cancel the business review population", async t => {
  const f = await fixture(t);
  await f.runtime.agentEnd({}, {});
  await f.runtime.agentEnd({}, { ...f.ctx, sessionId: "private-reviewer", sessionKey: "agent:main:runtime-corrector:private" });
  assert.equal(f.state.reviewController.signal.aborted, false);
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("only a host-admitted retry reopens an ended review signal; reset stays cancelled", async t => {
  const f = await fixture(t);
  await f.runtime.agentEnd({ success: false, error: "fixture network failure" }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, true);
  await f.runtime.prompt({ prompt: "Assembled retry prompt is not a new user requirement." }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, false);
  await f.runtime.reset({}, f.ctx);
  await f.runtime.prompt({ prompt: "late callback" }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, true);
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("a reviewer admission fault is advisory and cannot become a host tool veto", async t => {
  const f = await fixture(t);
  f.sessions.runWithWorkAdmission = async () => { throw new Error("fixture review admission failure"); };
  const result = await f.runtime.beforeTool({ toolName: "write", toolCallId: "write", params: { path: "draft.md" } }, f.ctx);
  assert.equal(result, undefined);
  assert(f.warnings.some(x => x.includes("fixture review admission failure")));
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("approval and question results retain original media, error, structure and interaction identity", async t => {
  const f = await fixture(t);
  f.sessions.runWithWorkAdmission = async () => { throw new Error("fixture review admission failure"); };
  for (const interaction of [{ interactive: true, channelData: { question: "Proceed?" } }, { details: { status: "approval-pending", approvalId: "host-approval" } }]) {
    const result = { ...interaction, isError: true, content: [{ type: "text", text: "Original host result" }, { type: "image", data: "fixture", mimeType: "image/png" }], mediaUrl: "fixture://media" };
    const before = structuredClone(result);
    assert.equal(await f.runtime.toolResult({ toolName: "exec", toolCallId: "approval", args: {}, result }, f.ctx), undefined);
    assert.deepEqual(result, before);
  }
});


test("late terminal callbacks cannot replace or cancel a newer native run", async t => {
  const f = await fixture(t);
  await f.runtime.prompt({ prompt: "host-admitted next run" }, { ...f.ctx, runId: "new-host-run" });
  const controller = f.state.reviewController;
  f.state.nativeNeedsStop = true;
  await f.runtime.agentEnd({ success: true, runId: "host-run" }, f.ctx);
  await f.runtime.agentEnd({ success: false, runId: "host-run", error: "late old error" }, f.ctx);
  const payload = { text: "old native delivery", mediaUrl: "fixture://media" };
  assert.equal(await f.runtime.reply({ kind: "final", sessionKey: f.ctx.sessionKey, runId: "host-run", payload }), undefined);
  assert.equal(f.state.nativeRunId, "new-host-run");
  assert.equal(f.state.reviewController, controller);
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.state.nativeNeedsStop, true);
  assert.equal(f.hostAbort.signal.aborted, false);
});


test("an ordinary new chat does not inherit the prior business Stop flag", async t => {
  const f = await fixture(t);
  f.state.nativeNeedsStop = true;
  await f.runtime.prompt({ prompt: "hello" }, { ...f.ctx, runId: "ordinary-chat" });
  assert.equal(f.state.nativeNeedsStop, false);
  const payload = { text: "Hello!" };
  assert.equal(await f.runtime.reply({ kind: "final", sessionKey: f.ctx.sessionKey, runId: "ordinary-chat", payload }), undefined);
  assert.deepEqual(payload, { text: "Hello!" });
});
