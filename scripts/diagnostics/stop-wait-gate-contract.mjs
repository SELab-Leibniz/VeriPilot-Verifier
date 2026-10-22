// Real, isolated Gateway + local deterministic provider. No external model calls.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { isolatedHost, runtimeState, files, pause } from "./lib/isolated-openclaw.mjs";

const [hostRoot, destination, port = "18897"] = process.argv.slice(2);
if (!hostRoot || !destination) throw new Error("hostRoot new-output-directory [gateway-port] required");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = [], holds = [], cases = new Map();
let h, failure;
async function until(read, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const result = await read(); if (result) return result;
    await pause(50);
  }
  throw new Error("Isolated contract observer deadline");
}
function hold() {
  const started = deferred(), released = deferred();
  const item = { started: false, released: false, startedAt: null, releasedAt: null,
    async enter() { item.started = true; item.startedAt = Date.now(); started.resolve(); await released.promise; },
    release() { if (!item.released) { item.released = true; item.releasedAt = Date.now(); released.resolve(); } },
    ready: started.promise };
  holds.push(item); return item;
}
const textOf = content => typeof content === "string" ? content
  : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
const caseMarker = text => [...text.matchAll(/STOP_WAIT_([A-Z_]+)_[AB]\b/gu)].at(-1)?.[1];
const caseAtPath = file => [...cases.values()].find(test => path.resolve(file).startsWith(test.root + path.sep));
const nextRequest = test => requests.find(row => row.caseName === test.name && row.kind === "next");
const observerFile = path.resolve(destination, "gate-admissions.jsonl");
async function admissionFor(test) {
  const rows = await fs.readFile(observerFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return rows.split("\n").filter(Boolean).map(JSON.parse).find(row => row.sessionKey === test.sessionKey && row.next);
}
async function remainsBlocked(test, stage) {
  await pause(500);
  if (failure) throw failure;
  assert(!nextRequest(test), `New business model started during ${stage}: ${test.name}`);
  assert(!await admissionFor(test), `New business passed the RC gate during ${stage}: ${test.name}`);
}
async function receiptFor(test, runId) {
  return (await runtimeState(test.root)).records.find(row => row.runId === runId && row.file.includes("/native-stop-reviews/"));
}
async function terminalReceipt(test, runId) {
  return until(async () => { const row = await receiptFor(test, runId); return row?.status === "SETTLED" && row; });
}
const server = http.createServer(async (req, res) => {
  try {
    let bytes = ""; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes), messages = body.messages ?? [];
    const system = messages.filter(m => m.role === "system").map(m => textOf(m.content)).join("\n");
    const role = system.match(/You are the isolated ([a-z-]+)/u)?.[1] ?? "business";
    const row = { at: Date.now(), role, messages, tools: body.tools?.map(tool => tool.function) };
    requests.push(row);
    let content, tool, prepared, test;
    if (role !== "business") {
      const requestFile = textOf(messages.filter(m => m.role === "user").at(-1)?.content)
        .match(/Read the request at (.+?request\.json)\./u)?.[1];
      assert(requestFile && (test = caseAtPath(requestFile)), "Reviewer request is outside an isolated case");
      row.requestFile = requestFile;
      prepared = JSON.parse(await fs.readFile(requestFile, "utf8"));
    } else {
      test = cases.get(caseMarker(messages.map(m => textOf(m.content)).join("\n")));
      assert(test, "Business request has no known isolated case marker");
    }
    // Capture each request's case before a hold; delayed work cannot inherit a later case.
    row.caseName = test.name;
    if (role === "ground-truth-extractor") content = JSON.stringify({ summary: "No change", taskClassification: "CONTINUATION",
      operations: test.deviation && prepared.currentGroundTruth?.version === 0 ? [{ operation: "ADD", category: "requirements",
        text: "Deliver a draft with verified acceptance.", authority: "USER_EXPLICIT", severity: "HARD",
        source: { ref: prepared.sourceCatalog.find(source => source.kind === "USER_MESSAGE").ref, subject: "MAIN_TASK", kind: "USER_MESSAGE" } }] : [] });
    else if (role === "stop-reviewer") {
      const index = test.stopCount++; row.reviewIndex = index;
      if (index === 0) await test.firstReview.enter();
      else if (test.holdRecheck && index === 1) await test.recheck.enter();
      const judgement = test.deviation && (index === 0 || test.neverPass) ? "DEVIATION" : "PASS";
      content = JSON.stringify({ summary: "Verified fixture", stopClassification: "TASK_COMPLETE", findings: [],
        metricObjectJudgements: Object.values(prepared.population?.metrics ?? {}).flat().map(object => ({ objectId: object.objectId,
          judgement, reason: "Current fixture draft", evidence: ["draft.md:1"] })) });
      row.returnedJudgement = judgement; row.returnedAt = Date.now();
    } else if (role !== "business") throw new Error(`Unexpected reviewer: ${role}`);
    else {
      const user = messages.filter(m => m.role === "user").at(-1), text = textOf(user?.content);
      row.kind = text.includes("[runtime-corrector:stop-feedback]") ? "correction"
        : /STOP_WAIT_[A-Z_]+_B\b/u.test(text) ? "next" : "initial";
      row.marker = text.match(/STOP_WAIT_[A-Z_]+_[AB]\b/u)?.[0] ?? null;
      if (row.kind === "correction" && test.holdCorrection && !test.correction.started) await test.correction.enter();
      const last = messages.at(-1);
      if (row.kind !== "next" && last?.role !== "tool") {
        assert(body.tools?.some(t => t.function.name === "write"), `Native write tool unavailable: ${JSON.stringify(row.tools)}`);
        tool = { index: 0, id: `write_${requests.length}`, type: "function", function: { name: "write",
          arguments: JSON.stringify({ path: path.join(test.root, "draft.md"), content: `${test.name}:${row.kind}\n` }) } };
      } else content = `DELIVERED_${test.name}_${row.kind.toUpperCase()}`;
    }
    const id = `contract-${requests.length}`, model = "stop-wait-fixture";
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", ...(tool ? { tool_calls: [tool] } : { content }) });
      chunk({}, tool ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, model, object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content: content ?? null, ...(tool ? { tool_calls: [tool] } : {}) },
        finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  } catch (error) {
    failure ??= error; res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "contract_fixture_error" } }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const providerFile = `${destination}.provider.json`;
await fs.writeFile(providerFile, JSON.stringify({ api: "openai-completions", authHeader: true,
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: { id: "stop-wait-fixture", name: "Local contract fixture",
    reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
process.env.RC_TEST_MODEL_KEY = "local-contract-fixture-only";
const result = { status: "RUNNING", cases: [], externalModelCalls: 0, hostModified: false };
try {
  h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), tools: ["read", "write", "runtime_corrector"],
    preparePlugin: async pluginRoot => {
      // Observe the public hook immediately after RC, before the host's own
      // business queue. Only the isolated plugin copy contains this observer.
      const file = path.join(pluginRoot, "lib/openclaw/entry.mjs");
      const source = await fs.readFile(file, "utf8"), marker = "registerProjectCommand(api, runtime.projects);";
      assert(source.includes(marker));
      await fs.writeFile(file, source.replace(marker, `${marker}\n    api.on("before_dispatch", async (event, ctx) => {
        const body = String(event.body ?? event.content ?? "");
        await (await import("node:fs/promises")).appendFile(${JSON.stringify(observerFile)}, JSON.stringify({ at: Date.now(),
          sessionKey: event.sessionKey ?? ctx.sessionKey, next: /STOP_WAIT_[A-Z_]+_B\\b/u.test(body) }) + "\\n");
      }, { priority: -100 });`));
    } });
  result.hostVersion = h.version;
  const definitions = [
    { name: "PASS" },
    { name: "UNTIL_PASS", deviation: true, holdCorrection: true, holdRecheck: true },
    { name: "ASSESSMENT", waitMode: "assessment", deviation: true, holdCorrection: true },
    { name: "EXHAUSTED", deviation: true, neverPass: true, maxCorrections: 1, holdCorrection: true, holdRecheck: true },
    { name: "TIMEOUT", assessmentTimeoutMs: 4000 },
  ];
  for (const definition of definitions) {
    const test = { ...definition, root: path.join(h.defaultDir, definition.name.toLowerCase()), stopCount: 0,
      firstReview: hold(), correction: hold(), recheck: hold() };
    cases.set(test.name, test);
    await fs.mkdir(path.join(test.root, ".runtime-corrector"), { recursive: true });
    await fs.writeFile(path.join(test.root, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: draft
    stage: proposal
    patterns: [draft.md]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
stopCorrection:
  enabled: true
  assessmentTimeoutMs: ${test.assessmentTimeoutMs ?? 30000}
  waitTimeoutMs: 120000
${test.waitMode ? `  waitMode: ${test.waitMode}\n` : ""}  maxCorrectionsPerEpoch: ${test.maxCorrections ?? 3}
implementationCorrection:
  enabled: false
reviewers:
  defaults:
    timeoutMs: 30000
`);
    const key = `agent:main:stop-wait-${test.name.toLowerCase()}`;
    test.sessionKey = key;
    await h.send(key, `/rc-project bind ${test.root}`, 30000);
    const a = await h.send(key, `STOP_WAIT_${test.name}_A Write draft.md then deliver. Deliver a draft with verified acceptance.`, 60000);
    await until(() => test.firstReview.started);
    const b = h.send(key, `STOP_WAIT_${test.name}_B Reply only.`, 120000); void b.catch(() => {});
    await remainsBlocked(test, "initial Stop review");
    assert.equal((await receiptFor(test, a.runId)).status, "RUNNING");
    let finalReview, feedback, observedCorrectionWait = false, observedRecheckWait = false;
    const releaseAt = Date.now();
    if (test.name !== "TIMEOUT") test.firstReview.release();
    if (test.deviation) {
      await until(() => test.correction.started);
      feedback = await until(async () => (await runtimeState(test.root)).records.find(row => row.sessionKey === key
        && row.file.includes("/native-followups/") && row.status === "ADMITTED"));
      if (test.waitMode === "assessment") {
        await until(() => admissionFor(test));
        assert(!test.correction.released, "Assessment case did not exercise release during active correction");
        assert.equal(test.stopCount, 1, "Assessment mode unexpectedly waited for a later PASS");
        test.correction.release();
      } else {
        await remainsBlocked(test, "correction execution with no active Stop reviewer");
        assert.equal(test.stopCount, 1, "A Stop reviewer ran before correction execution finished");
        observedCorrectionWait = true;
        test.correction.release();
        await until(() => test.recheck.started);
        await remainsBlocked(test, "final revalidation");
        observedRecheckWait = true;
        test.recheck.release();
        finalReview = await terminalReceipt(test, feedback.runId);
        assert.equal(finalReview.reviewStatus, test.neverPass ? "DEVIATION" : "PASS");
      }
    }
    const bResult = await b, initialReview = await terminalReceipt(test, a.runId);
    assert.equal(initialReview.reviewStatus, test.name === "TIMEOUT" ? "UNVERIFIED" : test.deviation ? "DEVIATION" : "PASS");
    if (test.name === "TIMEOUT") {
      assert.equal(initialReview.reasonCode, "REVIEW_DEADLINE_EXPIRED"); test.firstReview.release();
    }
    const next = nextRequest(test);
    assert(next && next.at >= releaseAt);
    if (feedback) assert(feedback.updatedAt <= next.at, "New work entered before feedback admission was recorded");
    if (test.name === "UNTIL_PASS") assert(next.at >= finalReview.assessmentCompletedAt, "New work entered before the committed final PASS");
    if (test.neverPass) {
      const snapshot = await runtimeState(test.root), task = snapshot.tasks.find(item => item.taskId === feedback.taskId);
      assert.equal(task.verification.status, "DEVIATION");
      assert.equal(task.verification.correctionBudgetExhausted, true);
      assert.equal(task.stop.correctionAttempts, 1);
      assert.equal(snapshot.records.filter(row => row.file.includes("/native-followups/")).length, 1,
        "Exhausted correction budget dispatched another business correction");
    }
    const ui = h.events.filter(event => event.event === "agent" && event.payload?.sessionKey === key
      && event.payload?.stream === "assistant" && /\[runtime-corrector\]/u.test(event.payload.data?.text ?? ""));
    assert(ui.some(event => /后续任务暂缓/u.test(event.payload.data.text)), "Visible wait event missing");
    if (test.name === "TIMEOUT") assert(ui.some(event => /超时/u.test(event.payload.data.text)), "Visible timeout event missing");
    if (test.neverPass) assert(ui.some(event => /耗尽|上限|用完/u.test(event.payload.data.text)), "Visible correction exhaustion event missing");
    // Drain intentionally held assessment-mode work before the next project.
    if (test.waitMode === "assessment") test.correction.release();
    await pause(500);
    const nativeFiles = (await files(path.join(h.stateDir, "agents"))).filter(file => file.endsWith(".jsonl"));
    const transcript = (await Promise.all(nativeFiles.map(file => fs.readFile(file, "utf8")))).join("\n");
    const statusText = /RC 正在验收|后续任务暂缓|后续任务继续等待|RC 验收超时|RC 验收通过|RC 等待修正与复验超时|RC 已用完配置的纠偏次数/u;
    assert(!statusText.test(transcript), "RC wait status entered native model history");
    assert(!statusText.test(JSON.stringify(next.messages)), "RC wait status entered next model prompt");
    result.cases.push({ name: test.name, waitMode: test.waitMode ?? "until_pass (default)", runId: a.runId,
      reviewStatus: initialReview.reviewStatus, reasonCode: initialReview.reasonCode,
      nextRunId: bResult.runId, waitedMs: next.at - bResult.startedAt, visibleStatus: true, historyClean: true,
      observedCorrectionWait, observedRecheckWait,
      ...(finalReview ? { finalReviewStatus: finalReview.reviewStatus, finalReviewRunId: finalReview.runId } : {}),
      ...(feedback ? { feedbackStatus: feedback.status, feedbackRunId: feedback.runId } : {}),
      ...(test.neverPass ? { correctionBudgetExhausted: true } : {}) });
    await h.save("result.json", result);
    process.stdout.write(JSON.stringify(result.cases.at(-1)) + "\n");
  }
  if (failure) throw failure;
  result.status = "PASS";
} catch (error) { result.status = "FAIL"; result.error = error.stack; throw error; }
finally {
  for (const item of holds) item.release();
  if (h) { await h.save("provider-requests.json", requests); await h.save("result.json", result); await h.close(); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
