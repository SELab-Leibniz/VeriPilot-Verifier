import { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { correctionFixtureRuntime } from "./openclaw-project-scope.mjs";
import { buildPlugin } from "../../lib/plugin-builder.mjs";
import { withTestReviewProof } from "../helpers/review-proof.mjs";

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function within(promise, description, timeoutMs = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
export async function until(predicate, description) {
  const deadlineAt = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadlineAt, `Timed out waiting for ${description}`);
    await pause(2);
  }
}
export async function basic(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-budget-"));
  const cleanup = {};
  t.after(async () => { await cleanup.dispose?.(); await fs.rm(projectRoot, { recursive: true, force: true }); });
  return { cleanup, projectRoot, sessionId: "host", sessionKey: "agent:main:budget", runId: "business-run",
    signal: new AbortController().signal, budgetMs: 10000 };
}
export const deferred = t => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  t?.after(() => resolve());
  return { promise, resolve };
};


// Call once at each test file's top level. Every invocation owns a separate
// packed build and before/after hooks; only the unchanged fixture code is shared.
export function createNativeStopFixture() {
  let output, pluginRoot, createRuntime, findTask, withTaskState, taskDirectory, readReport;
  before(async () => {
    output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-budget-build-"));
    pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: fileURLToPath(new URL("../../", import.meta.url)), outputRoot: output });
    ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs"))));
    createRuntime = correctionFixtureRuntime(createRuntime);
    ({ findTask, withTaskState, taskDirectory } = await import(pathToFileURL(path.join(pluginRoot, "lib/runtime-v2/task-store.mjs"))));
    ({ readReport } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/report.mjs"))));
  });
  after(() => fs.rm(output, { recursive: true, force: true }));
  async function lifecycle(t, { failures = 0, deviation = false, review, quality = null, metrics = null, compatibility, waitMode = "assessment", waitTimeoutMs, hookTimeoutMs = 5000, executionTimeoutMs, postRunTerminal, baselineReview, awaitInitialReview = true, panelSize = 0, materialText, initialPrompt = true, initialToolName = "write" } = {}) {
    const params = await basic(t), root = params.projectRoot;
    const materialFile = materialText === undefined ? null : path.join(root, "requirements.md");
    if (materialFile) await fs.writeFile(materialFile, materialText);
    await fs.mkdir(path.join(root, ".runtime-corrector"));
    await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), `version: 2
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
  materialRoots: ${materialFile ? JSON.stringify([materialFile]) : "[]"}
  panel:
    size: ${panelSize}
    adjudicator: false
stopCorrection:
  enabled: true
  metrics:
${Object.entries({...Object.fromEntries(Array.from({length:16},(_,i)=>[`M${String(i+1).padStart(2,'0')}`,false])),M01:true,...metrics??{}}).map(([id,enabled])=>`    ${id}: ${enabled}`).join('\n')}
  fileQualityReviewEnabled: ${quality !== null}
  waitMode: ${waitMode}
  assessmentTimeoutMs: ${waitTimeoutMs ?? (waitMode === "until_pass" ? 30000 : 11000)}
  feedbackReserveMs: 1000
implementationCorrection:
  enabled: false
reviewers:
  defaults:
    timeoutMs: 5000
`);
    await fs.writeFile(path.join(root, "draft.md"), "A delivered draft.\n");
    const transcript = path.join(root, "native.jsonl");
    await fs.writeFile(transcript, [{ type: "session", id: "host" }, { type: "message", id: "u", parentId: null,
      message: { role: "user", content: "Write a draft." } }].map(JSON.stringify).join("\n"));
    let calls = 0, fail = 0;
    const factory = async params => {
      const { request, schema } = params;
      await api.runtime.agent.reviewAdmission?.();
      calls++;
      if (fail-- > 0) throw new Error("transient checker failure");
      let result;
      if (schema.properties.operations) {
        await baselineReview?.(params);
        const material = materialFile && request.sourceCatalog.find(source => source.kind === "MATERIAL");
        const sourceText = material && await params.readOriginalMaterial(materialFile);
        result = { summary: "No change", taskClassification: "CONTINUATION", operations:
        request.currentGroundTruth?.version === 0 ? [{ operation: "ADD", category: "requirements", text: sourceText ? sourceText.toString("utf8").trim() : "Deliver a draft with verified acceptance.",
          verificationTarget: "ARTIFACT",
          authority: material ? "MATERIAL_DERIVED" : "USER_EXPLICIT", severity: "HARD", source: { ref: material?.ref ?? request.sourceCatalog.find(s => s.kind === "USER_MESSAGE").ref,
            subject: "MAIN_TASK", kind: material ? "MATERIAL" : "USER_MESSAGE" } }] : [] };
      }
      else if(request.reviewScope?.kind==='classification')result={summary:'Completion scope only',stopClassification:'TASK_COMPLETE',stage:null,findings:[],metricObjectJudgements:[]};
      else {
        await params.onScope?.({ stopClassification: 'TASK_COMPLETE', stage: null });
        const verdict = await review?.(params);
        await pause(50);
        result = { summary: "Done", stopClassification: "TASK_COMPLETE", findings: [], ...(quality ? { fileAssessments: quality } : {}),
          metricObjectJudgements: Object.values(request.population?.metrics ?? {}).flat().map(object => ({
            objectId: object.objectId, judgement: (verdict ?? deviation) ? "DEVIATION" : "PASS", reason: "Current source", evidence: ["draft.md:1"] })) };
      }
      return withTestReviewProof(params, { result, sessionId: "review", close: async () => {} });
    };
    factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
    const warnings = [];
    const state = {}, hostAbort = new AbortController(), api = { id: "runtime-corrector", pluginConfig: { hookTimeoutMs }, config: {}, logger: { warn(message) { warnings.push(message); } },
      runtime: { version: "2026.7.1-2", state: { resolveStateDir: () => path.join(root, "host-state") }, agent: { session: { getSessionEntry: async () => ({ sessionId: "host", sessionFile: transcript }),
        resolveStorePath: () => path.join(root, "sessions.json"), resolveSessionFilePath: () => transcript,
        runWithWorkAdmission: async (params, run) => run(params.signal) }, runEmbeddedAgent() {} } } };
    const listeners=new Set();let startSequence=0;
    api.runtime.gateway={request:async()=>({id:'fixture-notice',aborted:true})};
    const startCompatibility=async()=>({version:1,onStart:callback=>{listeners.add(callback);return()=>listeners.delete(callback);},drain:async()=>{},diagnosticsEnabled:()=>true});
    const statusCompatibility=async()=>({emitAgentEvent(){},markDiagnosticSessionProgress(){},...(compatibility?await compatibility():{})});
    const runtime = createRuntime(api, { pluginRoot, sharedState: state, reviewerFactory: factory, nativeHooks: true, compatibility:statusCompatibility,stopStartCompatibility:startCompatibility,
      ...(postRunTerminal ? { postRunTerminal } : {}) });
    const prompt=runtime.prompt.bind(runtime);
    runtime.prompt=async(event,context)=>{
      const result=await prompt(event,context);
      if(String(context.runId).startsWith('rc-stop-')&&result?.prependContext){
        const gate=await runtime.beforeAgentRun({prompt:`${result.prependContext}\n${event.prompt}`},context);
        assert.equal(gate?.outcome,'pass',JSON.stringify({gate,warnings}));
        const configuredTimeout = api.pluginConfig.hookTimeoutMs;
        if (executionTimeoutMs) api.pluginConfig.hookTimeoutMs = executionTimeoutMs;
        try {
          for(const listener of listeners)listener({type:'model.call.started',sessionId:context.sessionId,sessionKey:context.sessionKey,agentId:context.agentId,
            runId:context.runId,ts:Date.now(),seq:++startSequence},{trusted:true});
          await state.stopStartProtocol.drain();
        } finally { api.pluginConfig.hookTimeoutMs = configuredTimeout; }
      }
      return result;
    };
    const ctx = { agentId: "main", sessionId: "host", sessionKey: params.sessionKey, runId: params.runId, workspaceDir: root, trigger: "user", abortSignal: hostAbort.signal };
    const runtimes = [runtime];
    params.cleanup.dispose = async () => { for (const value of [...runtimes].reverse()) await value.dispose(); };
    await runtime.sessionStart({ sessionId: "host" }, ctx);
    if (initialPrompt) await runtime.prompt({ prompt: "Write a draft." }, ctx);
    else assert.equal(await findTask({ projectRoot: root, sessionId: "host" }), null, "the first tool must establish its own task before material capture");
    await runtime.beforeTool({ toolName: initialToolName, toolCallId: "w", params: { path: "draft.md" } }, ctx);
    if (awaitInitialReview) await state.states.get("main:host")?.hotReviewWork?.promise;
    assert(await findTask({ projectRoot: root, sessionId: "host" }), JSON.stringify(warnings));
    calls = 0; fail = failures;
    return { api, runtime, ctx, warnings, sharedState: state, state: state.states.get("main:host"), root, materialFile, hostAbort, calls: () => calls,
      post: () => runtime.postRuns.byId(runtime.postRuns.list().sessions.at(-1).id),
      restart: (overrides = {}) => {
        const value = createRuntime(api, { pluginRoot, sharedState: {}, reviewerFactory: factory, nativeHooks: true,
          compatibility: statusCompatibility, stopStartCompatibility: startCompatibility,
          ...(postRunTerminal ? { postRunTerminal } : {}), ...overrides });
        runtimes.push(value); return value;
      } };
  }

  return { lifecycle, findTask: (...args) => findTask(...args),
    withTaskState: (...args) => withTaskState(...args), taskDirectory: (...args) => taskDirectory(...args),
    readReport: (...args) => readReport(...args) };
}
