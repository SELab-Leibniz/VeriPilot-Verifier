import { installArtifactDependencies } from "./lib/native-review-host.mjs";
// Real MatrixAssistant-bundled Gateway and SDK sessions, loopback scripted
// provider only. This validates transport/lifecycle, not semantic accuracy or
// the real-model TodoList/performance acceptance in requirements section 18.5.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const [hostRoot, destination, port = "18937"] = process.argv.slice(2);
if (!hostRoot || !destination) throw new Error("hostRoot new-output-directory [gateway-port] required");
const text = content => typeof content === "string" ? content : (content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
const requests = [], cases = [], model = "ma-stop-contract";
const code = broken => [0, 1, 2].map(i => `def f${i}(x): return ${broken ? "-1" : `x + ${i + 1}`}`).join("\n") + "\n";
let host, failure;
const server = http.createServer(async (req, res) => {
  try {
    let bytes = ""; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes), messages = body.messages ?? [], system = messages.filter(m => m.role === "system").map(m => text(m.content)).join("\n");
    const role = system.includes("read-only acceptance reviewer") ? "sdk-group" : system.match(/You are the isolated ([a-z-]+)/u)?.[1] ?? "business";
    const row = { at: Date.now(), role, messages }; requests.push(row);
    let content, action;
    const call = (name, args) => { action = { index: 0, id: `tool_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }; };
    if (role === "sdk-group") {
      const start = messages.filter(m => m.role === "user").map(m => text(m.content)).find(value => value.includes('{"task":'));
      const jsonStart = start?.indexOf('{"task":');
      const brief = JSON.parse(start.slice(jsonStart)), members = brief.members ?? [brief.task];
      const previousCalls = messages.flatMap(m => m.tool_calls ?? []);
      const saved = new Set();
      for (const message of messages.filter(m => m.role === "tool")) {
        try { const value = JSON.parse(text(message.content)); if (value.saved) saved.add(value.taskId); } catch {}
      }
      const member = members.find(member => !saved.has(member.id));
      assert(member, "SDK group continued after all receipts");
      const paths = [...new Set([...member.basisFiles, ...member.targetFiles])];
      const read = new Set(previousCalls.filter(c => c.function.name === "source_read").map(c => JSON.parse(c.function.arguments).path));
      const missing = paths.find(file => !read.has(file));
      if (missing) call("source_read", { path: missing });
      else {
        const sources = messages.filter(m => m.role === "tool").map(m => text(m.content));
        const source = sources.find(value => /range project\/app\.py:/u.test(value));
        const citeId = /citeId="([^"\s]+)"/u.exec(source)?.[1];
        assert(citeId, "No actual source_read citation");
        const broken = source.includes("return -1");
        row.taskId = member.id; row.members = members.map(m => m.id);
        call("submit_review", { taskId: member.id, verdict: broken ? "DEVIATION" : "PASS", citeIds: [citeId],
          reason: broken ? "The controlled fixture returns -1 instead of its frozen x + n result." : "The controlled stateless function returns its frozen x + n result.",
          ...(!broken ? { productionTrace: { version: 1, entryPoint: "f0/f1/f2", actualInput: "integer x",
            producerToConsumer: "Argument x flows directly through integer addition to the return value.", stateful: false,
            statelessReason: "This controlled fixture has only three pure functions and no storage or auxiliary writers.", stateTargets: [], targetRelations: [] } } : {}) });
      }
    } else if (role !== "business") {
      const file = messages.filter(m => m.role === "user").map(m => text(m.content)).join("\n").match(/Read the request at (.+?request\.json)\./u)?.[1];
      assert(file, `Unknown ${role} request`);
      const request = JSON.parse(await fs.readFile(file, "utf8"));
      row.requestFile = file;
      if (role === "ground-truth-extractor") content = JSON.stringify({ summary: "Controlled original requirements.", taskClassification: "CONTINUATION",
        operations: request.currentGroundTruth?.version === 0 ? [0, 1, 2].map(i => ({ operation: "ADD", claimId: `fixture-R${i}`, category: "requirements",
          text: `Implement pure function f${i}(x) returning x + ${i + 1}.`, authority: "USER_EXPLICIT", severity: "HARD", verificationTarget: "IMPLEMENTATION",
          applicabilityKind: "CURRENT_TASK", applicability: "CURRENT_TASK",
          source: { ref: request.sourceCatalog.find(source => source.kind === "USER_MESSAGE").ref, subject: "MAIN_TASK", kind: "USER_MESSAGE" } })) : [] });
      else content = JSON.stringify({ summary: "Declared complete.", stopClassification: "TASK_COMPLETE", stage: null, findings: [], metricObjectJudgements: [] });
    } else {
      const all = messages.map(m => text(m.content)).join("\n");
      const current = cases.find(item => all.includes(item.marker));
      assert(current, "Business request has no case marker");
      const correction = all.includes("[runtime-corrector:stop-feedback]");
      row.case = current.k; row.correction = correction;
      if (messages.at(-1)?.role !== "tool") call("write", { path: path.join(current.root, "app.py"), content: code(!correction) });
      else content = "Implementation complete.";
    }
    const id = `contract-${requests.length}`;
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", ...(action ? { tool_calls: [action] } : { content }) });
      chunk({}, action ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, model, object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content: content ?? null, ...(action ? { tool_calls: [action] } : {}) },
        finish_reason: action ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  } catch (error) { failure ??= error; res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const providerFile = `${destination}.provider.json`;
await fs.writeFile(providerFile, JSON.stringify({ api: "openai-completions", authHeader: true,
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: { id: model, name: "Loopback contract fixture", reasoning: false,
    input: ["text"], contextWindow: 128000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
process.env.RC_TEST_MODEL_KEY = "local-contract-fixture-only";
const result = { status: "RUNNING", externalModelCalls: 0, hostModified: false, cases: [] };
try {
  host = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), tools: ["read", "write"],
    preparePlugin: async pluginRoot => {
      await installArtifactDependencies(pluginRoot);
    } });
  result.hostVersion = host.version;
  const sessions = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-store-runtime.js")));
  const storePath = sessions.resolveStorePath(path.join(host.stateDir, "agents/main/sessions/sessions.json"), { agentId: "main" });
  for (const k of [1, 3]) {
    const current = { k, root: path.join(host.root, `K${k}`), marker: `MA_STOP_V1_K${k}_${randomUUID()}` };
    cases.push(current);
    await fs.mkdir(path.join(current.root, ".runtime-corrector"), { recursive: true });
    await fs.writeFile(path.join(current.root, ".runtime-corrector/config.yaml"), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  panel:
    size: 0
implementationCorrection:
  enabled: false
  platform: null
stopCorrection:
  enabled: true
  maxCorrectionsPerSession: 2
  maxCorrectionsPerFlow: 2
  assessmentTimeoutMs: 120000
  feedbackReserveMs: 20000
  reviewGroupSize: ${k}
  metrics:
${Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, "0")}: ${i === 15}`).join("\n")}
`);
    const key = `agent:main:ma-stop-v1-k${k}-${randomUUID()}`;
    await host.request("sessions.create", { key, model: host.model });
    const entry = sessions.getSessionEntry({ agentId: "main", sessionKey: key, storePath, readConsistency: "latest" });
    assert(entry?.sessionId);
    await sessions.patchSessionEntry({ agentId: "main", sessionKey: key, storePath, preserveActivity: true,
      update: existing => { assert.equal(existing.sessionId, entry.sessionId); return { spawnedCwd: current.root }; } });
    const began = Date.now();
    await host.send(key, `${current.marker} Implement app.py with three pure functions: f0(x)=x+1, f1(x)=x+2, f2(x)=x+3. Complete the controlled fixture.`, 120000);
    const deadline = Date.now() + 150000;
    let state, ledger;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      state = await runtimeState(current.root);
      const ledgerFiles = (await files(path.join(host.stateDir, "runtime-corrector-stop-sessions/sessions")));
      const ledgers = await Promise.all(ledgerFiles.filter(file => file.endsWith(".json")).map(async file => JSON.parse(await fs.readFile(file, "utf8"))));
      ledger = ledgers.find(value => value.sessionId === entry.sessionId);
      if (state.records.some(record => record.reviewStatus === "PASS") && ledger?.used === 1) break;
      if (state.records.some(record => record.status === "SETTLED" && ["STOP_SESSION_MIGRATION_REQUIRED", "HOST_START_PROTOCOL_UNSUPPORTED"].includes(record.reasonCode)))
        throw new Error(`Native bridge unavailable: ${JSON.stringify(state.records)}`);
      if (state.records.some(record => record.status === "SETTLED" && record.reviewStatus === "UNVERIFIED")
        && Object.values(ledger?.stops ?? {}).every(stop => stop.releasedAt !== undefined))
        throw new Error(`Native assessment did not verify: ${JSON.stringify(state.evaluations.at(-1)?.core?.failure ?? state.records)}`);
      await pause(100);
    }
    assert(state.records.some(record => record.reviewStatus === "PASS"), JSON.stringify(state.records));
    assert.equal(ledger.used, 1);
    assert.equal(Object.keys(ledger.flows).length, 1);
    assert(Object.values(ledger.stops).every(stop => stop.releasedAt !== undefined));
    assert.equal(await fs.readFile(path.join(current.root, "app.py"), "utf8"), code(false));
    const scopes = await Promise.all((await files(path.join(host.stateDir, "runtime-corrector-stop-sessions/review-scopes")))
      .filter(file => file.endsWith(".json")).map(async file => JSON.parse(await fs.readFile(file, "utf8"))));
    const scope = scopes.find(scope => scope.sessionId === entry.sessionId);
    assert.equal(Object.keys(scope.receipts).length, 6, "Each original requirement needs one receipt per D/P round");
    assert.equal(Object.keys(scope.groups).length, k === 1 ? 6 : 2, "Configured groups must share one native session per round");
    result.cases.push({ k, elapsedMs: Date.now() - began, groups: Object.keys(scope.groups).length,
      receipts: Object.keys(scope.receipts).length, sessionUsed: ledger.used, stops: Object.values(ledger.stops).map(stop => ({ status: stop.reviewStatus, releasedAt: stop.releasedAt })),
      nativeRecords: state.records });
    await host.save(`K${k}-ledger.json`, ledger);
    await host.save(`K${k}-scope.json`, scope);
  }
  result.status = "PASS_LOCAL_HOST_CONTRACT";
} catch (error) { result.status = "FAIL"; result.error = error.message; process.exitCode = 1; }
finally {
  if (host) { await host.save("contract-result.json", result); await host.save("provider-requests.json", requests); await host.close(); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
