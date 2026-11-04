import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { correctionFixtureRuntime } from "./support/openclaw-project-scope.mjs";

const archive = await import("../lib/runtime-v2/original-requirements.mjs").catch(error => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.url?.endsWith("/original-requirements.mjs")) throw error;
  return null;
});
const stamp = "2026-11-04T00:00:00.000Z";
const original = "需求原文。".repeat(3000);

async function fixture(t, enabled) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-compaction-"));
  const transcript = path.join(root, "native.jsonl"), sessionId = "parent";
  const writeTranscript = (...entries) => fs.writeFile(transcript, [{ type: "session", id: sessionId }, ...entries]
    .map(record => JSON.stringify(record)).join("\n") + "\n");
  const logs = [], warnings = [], configDirectory = path.join(root, ".runtime-corrector");
  await fs.mkdir(configDirectory);
  await fs.writeFile(path.join(configDirectory, "config.yaml"), [
    "version: 2",
    "artifacts:",
    "  - name: draft",
    "    stage: proposal",
    "    patterns: [draft.md]",
    "compactionRestore:",
    "  enabled: " + enabled,
    ...(archive ? ["artifactCorrection:", "  originalRequirementsEnabled: true"] : []),
    "",
  ].join("\n"));
  const sessions = {
    getSessionEntry: async () => ({ sessionId, sessionFile: transcript }),
    resolveStorePath: () => path.join(root, "sessions.json"),
    resolveSessionFilePath: () => transcript,
    runWithWorkAdmission: async (params, run) => run(params.signal),
  };
  const api = { id: "runtime-corrector", config: {}, pluginConfig: {},
    logger: { warn: value => warnings.push(value), info: value => logs.push(value) },
    runtime: { agent: { session: sessions, runEmbeddedAgent: async () => assert.fail("model call in test") } } };
  const sharedState = {};
  const runtime = correctionFixtureRuntime(createOpenClawRuntime)(api, { pluginRoot: path.resolve("."), nativeHooks: true, sharedState });
  t.after(async () => { await runtime.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const ctx = { workspaceDir: root, sessionId, sessionKey: "agent:main:compaction", agentId: "main", runId: "business" };
  const first = { type: "message", id: "original", parentId: null, message: { role: "user", content: original } };
  const prompt = async () => {
    const result = await runtime.prompt({}, ctx);
    await sharedState.states.get(`main:${sessionId}`)?.hotReviewWork?.promise;
    return result;
  };
  await writeTranscript(first);
  assert.equal(await prompt(), undefined);
  const compact = (id, ...suffix) => writeTranscript({ type: "compaction", id, parentId: null, timestamp: stamp }, ...suffix);
  return { root, sessionId, prompt, compact, logs, warnings };
}

test("compaction restore defaults off and the disabled hook ignores a host compaction", async t => {
  assert.deepEqual(compileRuntimeV2Config({ version: 2 }), compileRuntimeV2Config({
    version: 2, compactionRestore: { enabled: false },
  }));
  const f = await fixture(t, false);
  await f.compact("compaction-one");
  assert.equal(await f.prompt(), undefined);
  assert.deepEqual(f.logs, []);
});

test("the next prompt restores the original once per host compaction, with a bounded internal marker",
  { skip: !archive && "requires the original-requirements dependency" }, async t => {
    const f = await fixture(t, true);
    const archived = () => archive.recordUserMessages({ projectRoot: f.root, sessionId: f.sessionId });
    const originals = await archived();
    assert.equal(originals.length, 1);
    assert.ok(originals[0].text === original);
    await f.compact("compaction-one");
    const { prependContext } = await f.prompt();
    assert.match(prependContext, /^\[runtime-corrector:internal\]/u);
    assert.ok(prependContext.includes("需求原文。"));
    assert.ok(prependContext.endsWith("[原文超过长度上限，已截断]"));
    assert.ok(!prependContext.includes("\ufffd"));
    assert.ok(Buffer.byteLength(prependContext) <= 24 * 1024);
    assert.equal(await f.prompt(), undefined);
    assert.equal(f.logs.filter(line => line.includes("compaction_restore")).length, 1);

    await f.compact("compaction-two", { type: "message", id: "internal-echo", parentId: "compaction-two",
      message: { role: "user", content: prependContext } });
    assert.equal((await f.prompt()).prependContext, prependContext);
    assert.equal((await archived()).length, 1);
    assert.equal(await f.prompt(), undefined);
    assert.equal(f.logs.filter(line => line.includes("compaction_restore")).length, 2);
  });

test("archive failure leaves prompt building open", async t => {
  const f = await fixture(t, true);
  if (archive) {
    const log = archive.userMessageLogPath(f.root, f.sessionId);
    await fs.unlink(log);
    await fs.mkdir(log);
  }
  await f.compact("compaction-one");
  assert.equal(await f.prompt(), undefined);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.warnings, []);
});
