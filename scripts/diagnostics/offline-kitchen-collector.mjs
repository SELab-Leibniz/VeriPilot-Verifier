// Real kitchen files and offline Python processes; deterministic semantic
// reviewer doubles exercise the built native transport and collector. This is
// deliberately not a real-model or Gateway acceptance claim.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlugin } from "../../lib/plugin-builder.mjs";

const execute = promisify(execFile), sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error("An absolute NEW output directory is required.");
await fs.mkdir(destination); const root = await fs.realpath(destination);
const hash = value => createHash("sha256").update(value).digest("hex");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
const milestone = data => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n");
const python = process.env.PYTHON ?? "python";
const example = path.join(sourceRoot, "examples/openclaw-offline-kitchen");
const skill = path.join(example, "skills/build-offline-kitchen");
const verifier = path.join(skill, "scripts/verify_kitchen.py");
const originalSource = await fs.readFile(path.join(example, "app/kitchen.py"), "utf8");
const contract = await fs.readFile(path.join(skill, "references/requirements.md"), "utf8");
const baselineHashes = Object.fromEntries(await Promise.all([verifier, path.join(skill, "SKILL.md"), path.join(skill, "references/requirements.md"),
  path.join(example, "app/kitchen.py")].map(async file => [file, hash(await fs.readFile(file))])));
const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot, outputRoot: path.join(root, "plugin") });
await save(path.join(pluginRoot, "config/platforms/offline-kitchen-python-test.json"), {
  name: "offline-kitchen-python-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
  sourceManifest: { roots: [], files: ["kitchen.py"], extensions: [".py"] },
});
const load = name => import(pathToFileURL(path.join(pluginRoot, "lib", name)));
const { handleRuntimeV2Event } = await load("runtime-v2/orchestrator.mjs");
const { compileRuntimeV2Config } = await load("runtime-v2/config.mjs");
const { ensureTask, taskDirectory, findTask } = await load("runtime-v2/task-store.mjs");
const { applyGroundTruthDelta, freezeGroundTruth } = await load("runtime-v2/ground-truth-ledger.mjs");
const { createOpenClawReviewerFactory } = await load("openclaw/reviewer.mjs");
const { createNativeFollowups } = await load("openclaw/native-followup.mjs");
const wrapper = path.join(root, "verify-with-explicit-utf8.py");
await fs.writeFile(wrapper, `# Only subprocess IO differs; verifier and business source remain unchanged.\nimport importlib.util, json, subprocess, sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location("bundled_kitchen_verifier", sys.argv[1])\nv=importlib.util.module_from_spec(spec); spec.loader.exec_module(v)\noriginal=subprocess.run\ndef utf8_run(args, **kwargs):\n    kwargs["encoding"]="utf-8"\n    return original([args[0],"-X","utf8",*args[1:]],**kwargs)\nv.subprocess.run=utf8_run\ntry:\n    report=v.verify(Path(sys.argv[2]))\nexcept Exception as error:\n    trace=error.__traceback__; report={}\n    while trace:\n        if trace.tb_frame.f_code.co_name=="verify": report=trace.tb_frame.f_locals.get("report",{})\n        trace=trace.tb_next\n    report.update(status="FAIL",error=str(error),attemptedScenarios=len(report.get("cases",[])))\n    Path(sys.argv[3]).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")\n    print("KITCHEN_INVALID: "+str(error)); sys.exit(1)\nPath(sys.argv[3]).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")\nprint("KITCHEN_VERIFIED "+str(report["scenarios"])+"/21")\n`);
const brokenSource = originalSource.replace("    if missing:", "    if False:  # controlled fault: skip the insufficient-stock guard");
assert.ok(brokenSource !== originalSource, "The controlled cook guard mutation must change the application.");
const clauses = [...contract.matchAll(/^(R\d+) ([\s\S]*?)(?=^R\d+ |$(?![\s\S]))/gmu)].map(match => ({ tag: match[1], text: `${match[1]} ${match[2].trim()}` }));
assert.equal(clauses.length, 6);
const claims = [...clauses.slice(0, 5).map(item => ({ ...item, target: "IMPLEMENTATION" })),
  { tag: "R06a", target: "PROCESS", text: "R06a Only edit kitchen.py and project-local app data; preserve frozen spec, Skill, RC config and any read-only baseline." },
  { tag: "R06b", target: "PROCESS", text: "R06b Run the unchanged bundled kitchen verifier and obtain KITCHEN_VERIFIED before declaring completion. Explicit UTF-8 process IO is permitted on Windows without changing verifier logic." }];
const config = { version: 2, locale: "en", artifacts: [], dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
  stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 }, implementationCorrection: { enabled: true, platform: "offline-kitchen-python-test" },
  reviewers: { defaults: { timeoutMs: 60000, formatRepairAttempts: 0 }, stopReviewer: { timeoutMs: 60000 }, implementationReviewer: { timeoutMs: 60000 } } };

async function fixture(name, { broken = false, oversized = false } = {}) {
  const projectRoot = path.join(root, name); await fs.mkdir(projectRoot); await fs.mkdir(path.join(projectRoot, "spec"));
  await fs.mkdir(path.join(projectRoot, ".runtime-corrector"));
  await fs.writeFile(path.join(projectRoot, "kitchen.py"), broken ? brokenSource : originalSource);
  await fs.writeFile(path.join(projectRoot, "spec/requirements.md"), contract);
  const configPath = path.join(projectRoot, ".runtime-corrector/config.json"); await save(configPath, config);
  const sessionId = `kitchen-${name}`, task = await ensureTask({ projectRoot, sessionId });
  await applyGroundTruthDelta({ projectRoot, taskId: task.taskId, delta: { operations: claims.map(claim => ({ operation: "ADD", category: "requirements",
    text: claim.text + (oversized && claim.tag === "R02" ? "\nThis original long obligation remains mandatory. 库存原文🌻 ".repeat(1300) : ""),
    severity: "HARD", authority: "USER_EXPLICIT", verificationTarget: claim.target, source: { ref: "user", kind: "USER_MESSAGE", subject: "MAIN_TASK" } })) } });
  const { current: gt } = await freezeGroundTruth({ projectRoot, taskId: task.taskId });
  const truthPath = path.join(taskDirectory(projectRoot, task.taskId), "ground-truth/current.json");
  const frozen = Object.fromEntries(await Promise.all([configPath, path.join(projectRoot, "spec/requirements.md"), truthPath].map(async file => [file, hash(await fs.readFile(file))])));
  const plan = { runtimeV2: compileRuntimeV2Config(config, { policyRoot: path.dirname(configPath) }) };
  return { name, projectRoot, sessionId, taskId: task.taskId, gt, frozen, plan, rounds: [] };
}

async function realAcceptance(f, round) {
  const reportPath = path.join(f.projectRoot, `acceptance-${round}.json`);
  let exit = 0, stdout, stderr;
  try { ({ stdout, stderr } = await execute(python, ["-B", "-X", "utf8", wrapper, verifier, f.projectRoot, reportPath], { cwd: f.projectRoot, timeout: 90000, maxBuffer: 2 ** 20 })); }
  catch (error) { if (typeof error.code !== "number") throw error; exit = error.code; ({ stdout, stderr } = error); }
  const report = await json(reportPath);
  assert.equal(report.networkPolicy, "DENIED");
  assert.equal(report.codeHash, hash(await fs.readFile(path.join(f.projectRoot, "kitchen.py"))));
  if (exit === 0) { assert.equal(report.scenarios, 21); assert.match(stdout, /KITCHEN_VERIFIED/u); }
  else assert.match(report.error, /failed-cook-atomic/u);
  await save(path.join(f.projectRoot, `acceptance-${round}-process.json`), { exit, stdout, stderr, reportPath });
  return { reportPath, report, exit };
}

async function checkFeedback(f, result, state) {
  if (!result.feedback) return { bytes: 0, itemCount: 0 };
  const bytes = Buffer.byteLength(result.feedback); assert.ok(bytes <= 8192);
  const indexPath = /^\[RC_DETAILS\] ([^\n]+)/mu.exec(result.feedback)?.[1]; assert(indexPath);
  const index = await json(indexPath); let itemCount = 0, maxItemBytes = 0;
  const evidenceLocations = [];
  for (const page of index.pages) for (const entry of (await json(page.path)).items) {
    const detail = await json(entry.path); evidenceLocations.push(...(detail.evidenceLocations ?? []));
    const itemBytes = Buffer.byteLength(await fs.readFile(entry.shortPath));
    maxItemBytes = Math.max(maxItemBytes, itemBytes); assert.ok(itemBytes <= 768); itemCount++;
  }
  assert.equal(itemCount, index.itemCount);
  const admission = result.stop.partialFeedbackEligible ? await createNativeFollowups({ runtime: { subagent: { run: async args => ({ runId: args.idempotencyKey }) } } }).submit({
    projectRoot: f.projectRoot, state: { sessionId: f.sessionId, sessionKey: `agent:main:${f.sessionId}`, nativeRunId: "offline-original", reviewController: new AbortController() },
    task: state, outcome: result.stop, maxCorrections: 3, source: { runId: "offline-original", leafId: "completion", usersDigest: "frozen-contract", evidenceDigest: "offline-process-receipt" },
  }) : null;
  if (admission) { assert.equal(admission.status, "ADMITTED"); assert.equal(admission.feedbackOnly, true); assert.ok(Buffer.byteLength(admission.message) <= 8192); }
  return { bytes, itemCount, maxItemBytes, indexPath, evidenceLocations: [...new Set(evidenceLocations)], partialAdmission: admission && { status: admission.status, feedbackOnly: admission.feedbackOnly } };
}

async function assess(f, round, { overflowRole = null, overflowAt = -1 } = {}) {
  const actual = await realAcceptance(f, round), transcriptPath = path.join(f.projectRoot, `transcript-${round}.jsonl`);
  const transcript = [{ type: "user", uuid: "user-original", message: { content: contract } },
    { type: "assistant", uuid: "acceptance-call", message: { content: [{ type: "tool_use", id: "verify-kitchen", name: "exec", input: { command: `${python} -X utf8 verify-with-explicit-utf8.py`, workdir: f.projectRoot } }] } },
    { type: "user", uuid: "acceptance-result", message: { content: [{ type: "tool_result", tool_use_id: "verify-kitchen", content: JSON.stringify(actual.report) }] } },
    { type: "assistant", uuid: "completion", message: { content: "The offline kitchen implementation is complete. Perform final acceptance against the frozen original contract." } }];
  await fs.writeFile(transcriptPath, transcript.map(JSON.stringify).join("\n") + "\n");
  const calls = [], dispatches = [], indices = new Map();
  const api = { rootDir: pluginRoot, config: { agents: { defaults: { model: { primary: "diagnostic/deterministic-python-oracle" } } } }, runtime: { agent: {
    runEmbeddedAgent: async params => {
      const requestPath = path.join(path.dirname(params.sessionFile), "request.json"), request = await json(requestPath);
      const classification = request.reviewScope?.kind === "classification", role = params.extraSystemPrompt.includes("isolated implementation-reviewer") ? "implementation-reviewer" : "stop-reviewer";
      calls.push({ role, classification, sessionId: params.sessionId, requestBytes: Buffer.byteLength(await fs.readFile(requestPath)), objectIds: request.reviewScope?.objectIds ?? [], sourceIds: request.reviewScope?.sourceIds ?? [] });
      const rows = Object.values(request.population?.metrics ?? {}).flat(), localTruth = await json(request.groundTruthPath);
      const source = path.join(f.projectRoot, "kitchen.py"), sourceLines = (await fs.readFile(source, "utf8")).split("\n");
      const reportLines = (await fs.readFile(actual.reportPath, "utf8")).split("\n");
      const judgements = rows.map(object => {
        const claim = localTruth.claims.find(item => item.claimId === object.sourceId); assert(claim);
        const tag = /^(R\d+[ab]?)/u.exec(claim.text)[1];
        const deviation = actual.exit !== 0 && ["R04", "R05", "R06b"].includes(tag);
        const implementation = object.verificationTarget === "IMPLEMENTATION";
        const needle = ["R04", "R05"].includes(tag) ? "def cmd_cook" : tag === "R02" ? "def cmd_pantry" : tag === "R03" ? "def cmd_recipe" : "def build_parser";
        const start = Math.max(1, sourceLines.findIndex(line => line.includes(needle)) + 1);
        const ref = implementation ? `${source}#L${start}-L${Math.min(sourceLines.length, start + 20)}` : `${actual.reportPath}#L1-L${Math.min(12, reportLines.length)}`;
        return { objectId: object.objectId, judgement: deviation ? "DEVIATION" : "PASS",
          reason: deviation ? tag === "R06b" ? "The real bundled verifier exited nonzero, so delivery has no successful final verification receipt."
            : "The insufficient-stock guard is disabled; cook succeeds and subtracts inventory below zero instead of failing atomically."
            : `The assigned ${tag} behavior matches the checked original source and real offline CLI evidence.`, evidence: [ref] };
      });
      const result = { summary: "Deterministic source/evidence comparison backed by real offline Python subprocesses.", findings: [], metricObjectJudgements: judgements,
        ...(role === "stop-reviewer" ? { stopClassification: "TASK_COMPLETE", stage: null } : {}) };
      return { payloads: [{ text: JSON.stringify(result) }], meta: {} };
    },
  } } };
  const nativeFactory = createOpenClawReviewerFactory(api, { deadlineAt: Date.now() + 120000 });
  const factory = async input => {
    const classification = input.request.reviewScope?.kind === "classification";
    const index = classification ? -1 : indices.get(input.role) ?? 0;
    if (!classification) indices.set(input.role, index + 1);
    dispatches.push({ role: input.role, classification, index, sourceIds: input.request.reviewScope?.sourceIds ?? [] });
    if (!classification && input.role === overflowRole && index === overflowAt)
      throw Object.assign(new Error("Controlled context window overflow in one kitchen review item."), { code: "CONTEXT_OVERFLOW" });
    return nativeFactory(input);
  };
  Object.assign(factory, { supportsReviewCollection: true, reviewDeadlineAt: nativeFactory.reviewDeadlineAt });
  const result = await handleRuntimeV2Event({ projectRoot: f.projectRoot, pluginRoot, plan: f.plan, reviewerFactory: factory,
    input: { cwd: f.projectRoot, session_id: f.sessionId, transcript_path: transcriptPath, hook_event_name: "Stop", hook_event_id: `${f.name}-${round}`, last_assistant_message: "Task complete." } });
  await save(path.join(f.projectRoot, `runtime-${round}.json`), result);
  const state = await findTask({ projectRoot: f.projectRoot, sessionId: f.sessionId });
  assert.ok(result.stop, `The Stop path must execute: ${JSON.stringify(result)}`);
  const stop = result.stop;
  const persisted = await json(path.join(taskDirectory(f.projectRoot, f.taskId), "evaluations", `${state.stop.lastAssessmentId}.json`));
  const implementation = stop.implementationReview ?? persisted.implementationReview;
  assert.equal(implementation.sourceManifestCount, 1, "The real kitchen.py must belong to the production manifest.");
  const population = await json(path.join(taskDirectory(f.projectRoot, f.taskId), "metrics/population.json"));
  assert.equal(stop.report.metrics.flatMap(metric => metric.objects).length, Object.values(population.metrics).flat().length);
  for (const [file, expected] of Object.entries(f.frozen)) assert.equal(hash(await fs.readFile(file)), expected, `Frozen input changed: ${file}`);
  assert.equal(state.groundTruth.version, f.gt.version);
  assert.ok(calls.every(call => call.requestBytes <= 24 * 1024));
  assert.equal(new Set(calls.map(call => call.sessionId)).size, calls.length, "Each native review uses a fresh session.");
  for (const collection of [stop.review.collection, implementation.collection]) for (const item of collection.items) await fs.access(item.path);
  const feedback = await checkFeedback(f, result, state);
  const evaluation = { round, actualAcceptance: { status: actual.report.status, scenarios: actual.report.scenarios ?? null, attemptedScenarios: actual.report.attemptedScenarios ?? null, reportPath: actual.reportPath },
    stopStatus: stop.status ?? stop.report.status, decision: result.decision, k: state.stop.correctionAttempts, infrastructureFailures: state.stop.infrastructureFailures,
    populationDigest: population.digest, populationObjects: Object.values(population.metrics).flat().length,
    stopCollection: stop.review.collection, implementationCollection: implementation.collection, implementationStatus: implementation.status,
    sourceManifestCount: implementation.sourceManifestCount, feedback, calls, dispatches,
    metricJudgements: stop.report.metrics.flatMap(metric => metric.objects).map(({ objectId, judgement, reason }) => ({ objectId, judgement, reason })) };
  if (actual.exit !== 0) {
    assert.match(result.feedback, /insufficient-stock guard is disabled/u);
    assert.match(result.feedback, /below zero/u);
    assert.ok(/kitchen\.py#L\d+/u.test(result.feedback) || feedback.evidenceLocations.some(location => /kitchen\.py#L\d+/u.test(location)),
      "The short feedback or its real per-item detail must locate original kitchen source lines.");
  }
  await save(path.join(f.projectRoot, `result-${round}.json`), evaluation); f.rounds.push(evaluation);
  milestone({ name: f.name, round, stopStatus: evaluation.stopStatus, k: evaluation.k, retainedStop: evaluation.stopCollection.reviewedObjects,
    retainedImplementation: evaluation.implementationCollection.reviewedObjects, feedbackBytes: feedback.bytes });
  return evaluation;
}

const results = [];
try {
  const good = await fixture("good-original"), passed = await assess(good, "initial");
  assert.equal(passed.stopStatus, "PASS"); assert.equal(passed.k, 0); results.push(good);
  const broken = await fixture("broken-and-recovered", { broken: true }), failed = await assess(broken, "broken");
  assert.equal(failed.stopStatus, "DEVIATION"); assert.equal(failed.k, 1); assert.equal(failed.actualAcceptance.attemptedScenarios, 9);
  await fs.writeFile(path.join(broken.projectRoot, "kitchen.py"), originalSource);
  const recovered = await assess(broken, "recovered"); assert.equal(recovered.stopStatus, "PASS"); assert.equal(recovered.k, 1); results.push(broken);
  for (const fault of [{ name: "stop-middle-overflow", role: "stop-reviewer", index: 3, broken: true },
    { name: "stop-last-overflow", role: "stop-reviewer", index: 6 }, { name: "implementation-middle-overflow", role: "implementation-reviewer", index: 2, broken: true }]) {
    const f = await fixture(fault.name, { broken: fault.broken }), value = await assess(f, "overflow", { overflowRole: fault.role, overflowAt: fault.index });
    assert.equal(value.stopStatus, "UNVERIFIED"); assert.equal(value.k, 0); assert.equal(value.infrastructureFailures, 1);
    const collection = fault.role === "stop-reviewer" ? value.stopCollection : value.implementationCollection;
    assert.equal(collection.complete, false); assert.equal(collection.failures.length, 1); assert.equal(collection.failures[0].code, "CONTEXT_OVERFLOW");
    assert.equal(collection.completedItems, collection.totalItems - 1); assert.equal(value.feedback.partialAdmission?.status, "ADMITTED");
    const journal = await fs.readFile(path.join(taskDirectory(f.projectRoot, f.taskId), "journal/events.jsonl"), "utf8");
    assert.ok(!/"(?:reason|deviationKey)":"[^"]*CONTEXT_OVERFLOW/u.test(journal), "Checker overflow cannot become a business finding.");
    results.push(f);
  }
  const oversized = await fixture("single-oversized-obligation", { oversized: true }), oversize = await assess(oversized, "oversized");
  assert.equal(oversize.stopStatus, "UNVERIFIED"); assert.equal(oversize.k, 0); assert.equal(oversize.infrastructureFailures, 1);
  for (const collection of [oversize.stopCollection, oversize.implementationCollection]) {
    assert.equal(collection.failures.length, 1); assert.equal(collection.failures[0].code, "REVIEW_SCOPE_TOO_LARGE");
    assert.equal(collection.completedItems, collection.totalItems - 1); assert.ok(collection.reviewedObjects > 0);
  }
  results.push(oversized);
  for (const [file, expected] of Object.entries(baselineHashes)) assert.equal(hash(await fs.readFile(file)), expected);
  const report = { status: "PASS", validationMode: "Real offline Python app/processes, deterministic semantic reviewer doubles; NOT a real-model/Gateway trial",
    builtPlugin: pluginRoot, root, python, networkPolicy: "DENIED in every application process", baselineHashes,
    windowsIoAdaptation: "Unchanged bundled verifier loaded in a wrapper; add child -X utf8 and encoding=utf-8 only, preserving all acceptance logic and audit hook.",
    observerRepairsBusinessCode: "Controlled recovery copies the unchanged archived source; this is a collector mechanism test, not autonomous model repair.",
    cases: results.map(({ name, projectRoot, taskId, rounds }) => ({ name, projectRoot, taskId, rounds })) };
  await save(path.join(root, "result.json"), report); milestone({ status: "PASS", projects: results.length, rounds: results.reduce((total, f) => total + f.rounds.length, 0), result: path.join(root, "result.json") });
} catch (error) {
  await save(path.join(root, "result.json"), { status: "FAIL", validationMode: "deterministic-reviewer real-Python diagnostic", root, error: error.stack, cases: results });
  throw error;
}
