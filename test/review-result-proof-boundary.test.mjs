import { registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectReviewItems } from "../lib/runtime-v2/review-collector.mjs";
import { STOP_REVIEW_SCHEMA, startRoleReviewer } from "../lib/runtime-v2/reviewer.mjs";
import { calculateMetricReport } from "../lib/runtime-v2/metrics.mjs";
import { validateReviewJudgement, validateReviewFinding, reviewProofOwners } from "../lib/runtime-v2/review-result-validation.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { observeInternalTool } from "../lib/openclaw/internal-context.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import {runStartedHostEvent as handleRuntimeV2Event} from "./helpers/started-host.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { reviewReadEvidenceMatches } from "../lib/runtime-v2/review-pass-cache.mjs";

const row = (source = "R1", metric = "M11", target = "PROCESS") => ({ objectId: `${metric}:${source}`, metricId: metric,
  sourceId: source, sourceRevisionId: `${source}@1`, hard: true, evidenceRequired: true, verificationTarget: target,
  authority: "USER_EXPLICIT", applicabilityKind: "CURRENT_TASK", description: "Actually run the assigned verifier before completion." });
const complete = { stopClassification: "STAGE_COMPLETE", stage: "implementation" };
const proof = owner => ({ version: 1, owner, observed: true, basisComplete: true });

async function fixture(t, objects = [row()]) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/review-proof-boundary-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(root), path.resolve(scratch));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskId = "proof-boundary", taskRoot = path.join(root, ".runtime-correction/tasks", taskId);
  const source = path.join(root, "source.txt"), groundTruthPath = path.join(taskRoot, "ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(source, "A scripted original observation.\n");
  const truth = { version: 1, digest: "truth-1", claims: [...new Set(objects.map(object => object.sourceId))].map(claimId => ({
    claimId, revisionId: `${claimId}@1`, text: "Run the required verifier.", authority: "USER_EXPLICIT", severity: "HARD", status: "ACTIVE" })) };
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  await fs.writeFile(path.join(taskRoot, "task.json"), JSON.stringify({ taskId, groundTruth: { version: 1, digest: truth.digest },
    correctionEpoch: { id: "epoch-1" }, control: { generation: 1, cancelEpoch: 0 } }));
  const metrics = {}; for (const object of objects) (metrics[object.metricId] ??= []).push(object);
  const population = { version: 1, groundTruthVersion: 1, digest: sha256(metrics), metrics };
  const snapshot = { digest: "execution-1", entries: [
    { type: "assistant", uuid: "invocation", message: { content: [{ type: "tool_use", id: "verify-1", name: "Bash", input: { command: "verify" } }] } },
    { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "verify-1", content: "VERIFIED", is_error: false }] } },
  ] };
  const input = { projectRoot: root, taskId, role: "stop-reviewer", reviewer: { timeoutMs: 5000, formatRepairAttempts: 0 }, schema: STOP_REVIEW_SCHEMA,
    classification: complete, request: { population, groundTruthPath }, evidence: { groundTruth: truth, population, snapshot } };
  const result = (params, judgement = "PASS", evidence = [source + "#L1"]) => ({ summary: "Scripted original comparison.",
    ...params.request.fixedStopClassification, findings: [], fileAssessments: [],
    metricObjectJudgements: Object.values(params.request.population.metrics).flat().map(object => ({ objectId: object.objectId,
      judgement, reason: "The original evidence establishes this judgement.", evidence })) });
  const citation = (object, owner = reviewProofOwners(object)[0]) => ({ selection: source + "#L1", path: source, snapshotPath: source,
    contentHash: sha256("A scripted original observation.\n"), start: 1, end: 1, usedBy: [object.objectId], readProof: proof(owner) });
  return { root, source, taskId, taskRoot, objects, input, population, result, citation };
}

for (const judgement of ["NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING"]) test(`unproved ${judgement} retains the original denominator as an incomplete checker result`, async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => ({ result: f.result(params, judgement, []) }) });
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.collection.failures[0].code, "REVIEW_ITEM_EVIDENCE_UNAVAILABLE");
  assert.equal(handle.result.metricObjectJudgements[0].judgement, "UNVERIFIED");
  const report = calculateMetricReport({ population: f.population, judgements: handle.result.metricObjectJudgements });
  assert.equal(report.metrics.find(metric => metric.metricId === "M11").denominator, 1);
  assert.notEqual(report.status, "PASS");
});

test("a missing read proof fails only its item and preserves a checked sibling in the same group", async t => {
  const f = await fixture(t, [row("R1", "M01", "ARTIFACT"), row("R1", "M05", "ARTIFACT")]);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => ({ result: f.result(params),
    sourceCitations: [f.citation(f.objects[0])] }) });
  assert.equal(handle.collection.totalItems, 1);
  assert.equal(handle.collection.complete, false);
  assert.deepEqual(handle.result.metricObjectJudgements.map(value => value.judgement), ["PASS", "UNVERIFIED"]);
  assert.equal(handle.collection.reviewedObjects, 1);
  assert(handle.sourceCitations.some(citation => citation.readProof?.observed));
});

test("legitimate model UNVERIFIED needs no manufactured read proof", async t => {
  const f = await fixture(t);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => ({ result: f.result(params, "UNVERIFIED", []) }) });
  assert.equal(handle.collection.complete, true);
  assert.equal(handle.collection.failures.length, 0);
});

test("conditional exclusions and explicit document-only journeys retain their supported proof kinds", () => {
  const conditional = { ...row("R1", "M01", "ARTIFACT"), applicabilityKind: "CURRENT_TASK" };
  const excluded = { objectId: conditional.objectId, judgement: "NOT_APPLICABLE" };
  assert.equal(validateReviewJudgement({ row: excluded, object: conditional, citations: [{ readProof: proof("ARTIFACT") }] }), excluded);
  const documentJourney = row("R2", "M15", "ARTIFACT"), passed = { objectId: documentJourney.objectId, judgement: "PASS" };
  assert.equal(validateReviewJudgement({ row: passed, object: documentJourney, citations: [{ readProof: proof("ARTIFACT") }] }), passed);
  assert.throws(() => validateReviewJudgement({ row: passed, object: { ...documentJourney, verificationTarget: "IMPLEMENTATION" },
    citations: [{ readProof: proof("ARTIFACT") }] }), { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
});

test("a claim finding needs one supported projection per claim, not every metric's proof kind", () => {
  const objects = [row("R1", "M01", "IMPLEMENTATION"), row("R1", "M12", "IMPLEMENTATION"), row("R2", "M11", "PROCESS")];
  const finding = { violatedGroundTruthIds: ["R1"] }, citations = [{ readProof: proof("ARTIFACT") }];
  assert.equal(validateReviewFinding({ finding, objects, citations }), finding);
  assert.throws(() => validateReviewFinding({ finding: { violatedGroundTruthIds: ["R1", "R2"] }, objects, citations }),
    { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
  assert.throws(() => validateReviewFinding({ finding: { violatedGroundTruthIds: ["foreign"] }, objects, citations }),
    { code: "REVIEW_ITEM_OWNERSHIP_INVALID" });
  assert.throws(() => validateReviewFinding({ finding, objects, citations: [{ readProof: proof("BASIS") }] }),
    { code: "REVIEW_ITEM_EVIDENCE_UNAVAILABLE" });
});

test("collector retains a source-bound claim finding across artifact/runtime metric projections", async t => {
  const f = await fixture(t, [row("R1", "M01", "IMPLEMENTATION"), row("R1", "M12", "IMPLEMENTATION")]);
  const finding = { deviationKey: "artifact-gap", rootCauseId: "REQUIREMENT_OMITTED", severity: "error", reason: "The current artifact omits its required condition.",
    actualEvidence: [f.source + "#L1"], expectedConstraint: "Preserve the original condition.", violatedGroundTruthIds: ["R1"] };
  const citation = { ...f.citation(f.objects[0], "ARTIFACT"), usedBy: [finding.deviationKey] };
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: async params => ({
    result: { ...f.result(params, "UNVERIFIED", []), findings: [finding] }, sourceCitations: [citation] }) });
  assert.equal(handle.collection.complete, true);
  assert.equal(handle.collection.totalItems, 1);
  assert.equal(handle.result.findings.length, 1);
  assert.equal(handle.collection.failures.length, 0);
});

for (const mode of ['no-read', 'arguments-only', 'missing-basis', 'complete']) test(`task transport accepts only final source receipts and full basis: ${mode}`, async t => {
  const f = await fixture(t), hooks = new Map(); let toolsFor, calls = 0, brief;
  const api = { config: { agents: { defaults: { model: { primary: 'offline/model' } } } }, runtime: { version: '2026.7.1-2', agent: {} },
    registerTool: fn => { toolsFor = fn; }, on: (name, fn) => hooks.set(name, fn) };
  registerTaskTools(api);
  const factory = createOpenClawReviewerFactory(api, { runEmbeddedAgent: async params => {
    calls++; brief ??= JSON.parse(params.prompt);
    const tools = new Map(toolsFor(params).map(tool => [tool.name, tool]));
    const read = async file => {
      params.onAssistantMessageStart(); const id = crypto.randomUUID(), result = await tools.get('source_read').execute(id, { path: file });
      params.onAgentToolResult({ toolName: 'source_read', result, isError: false });
      if (mode !== 'arguments-only') hooks.get('tool_result_persist')({ toolName: 'source_read', toolCallId: id, isSynthetic: false,
        message: { role: 'toolResult', toolName: 'source_read', toolCallId: id, content: result.content, isError: false } }, params);
      return result.details.citation.citeId;
    };
    let citeId;
    if (mode === 'complete') for (const file of brief.task.basisFiles) await read(file);
    if (mode !== 'no-read') citeId = await read('execution/000001.json');
    params.onAssistantMessageStart();
    const submit = () => tools.get('submit_review').execute(crypto.randomUUID(), { taskId: brief.task.id, verdict: 'PASS',
      reason: 'The original verifier result establishes the assigned process obligation.', citeIds: citeId ? [citeId] : [] });
    if (mode === 'complete') { const result = await submit(); params.onAgentToolResult({ toolName: 'submit_review', result, isError: false }); }
    else await assert.rejects(submit(), /basis not fully read|requires source evidence|Unknown citation/);
    return { payloads: [{ text: 'Display only.' }], meta: {} };
  } });
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: factory });
  assert.equal(calls, mode === 'complete' ? 1 : 2);
  assert.equal(handle.collection.complete, mode === 'complete');
  assert.equal(handle.result.metricObjectJudgements[0].judgement, mode === 'complete' ? 'PASS' : 'UNVERIFIED');
  if (mode === 'complete') assert(handle.sourceCitations.some(citation => citation.readProof?.owner === 'PROCESS'));
  else assert.equal(handle.collection.failures[0].code, 'REVIEW_ITEM_INCOMPLETE');
});

test("checker proof loss does not consume business correction k", async t => {
  const f = await fixture(t), sessionId = "core-proof-session";
  const task = await ensureTask({ projectRoot: f.root, sessionId });
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: task.taskId, delta: { operations: [{ operation: "ADD", category: "workflowSteps",
    text: "Run the verifier before completion.", authority: "USER_EXPLICIT", severity: "HARD", verificationTarget: "PROCESS", source: { ref: "user" } }] } });
  const transcript = path.join(f.root, "transcript.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "Run the verifier before completion." } }));
  const factory = async params => ({ result: params.request.reviewScope?.kind === "classification"
    ? { summary: "Task-level check.", stopClassification: "TASK_COMPLETE", stage: null, findings: [], metricObjectJudgements: [] }
    : f.result(params), close: async () => {} });
  factory.supportsReviewCollection = true;
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2, locale: "en", dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false }, stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3, metrics: { M11: true } } }, { policyRoot: path.join(f.root, ".runtime-corrector") }) };
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan, reviewerFactory: factory,
    input: { cwd: f.root, session_id: sessionId, transcript_path: transcript, hook_event_name: "Stop", hook_event_id: "proof-loss", last_assistant_message: "Task complete." } });
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, task.taskId), "task.json"), "utf8"));
  assert.equal(result.stop.status, "UNVERIFIED");
  assert.equal(result.stop.review.collection.complete, false);
  assert.equal(state.stop.correctionAttempts, 0);
  assert.equal(state.stop.infrastructureFailures, 1);
});

test("CLI explicitly reports unavailable read proof instead of trusting an ordinary line reference", async t => {
  const f = await fixture(t), entry = path.join(f.root, "cli.cjs");
  const report = f.result({ request: { ...f.input.request, fixedStopClassification: complete } });
  await fs.writeFile(entry, `process.stdout.write(JSON.stringify({session_id:'proof-cli',structured_output:${JSON.stringify(report)}}));`);
  await assert.rejects(startRoleReviewer({ ...f.input, classification: undefined, sessionCwd: f.root, parentSessionId: "parent",
    reviewer: { ...f.input.reviewer, effort: "low", session: "detached" },
    reviewerRuntime: { executable: process.execPath, argsPrefix: [entry] } }), error => error.code === "REVIEW_ITEM_EVIDENCE_UNAVAILABLE"
      && error.message.includes("CLI_READ_EVENTS_UNAVAILABLE"));
});

async function streamedCli(t, mode) {
  const f = await fixture(t, [row("R1", "M01", "ARTIFACT")]), entry = path.join(f.root, "stream-cli.cjs"), count = path.join(f.root, "cli-count.json"), uncited = path.join(f.root, "dependency.txt");
  await fs.writeFile(uncited, "An actually read dependency not selected as a citation.\n");
  const report = f.result({ request: { ...f.input.request, fixedStopClassification: complete } });
  await fs.writeFile(entry, `
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[args.indexOf('--output-format')+1]!=='stream-json'||!args.includes('--verbose'))throw Error('Expected native stream-json transport');
const countFile=process.env.PROOF_COUNT;let count=0;try{count=JSON.parse(fs.readFileSync(countFile,'utf8'));}catch{};fs.writeFileSync(countFile,JSON.stringify(++count));
const mode=process.env.PROOF_MODE, resumed=args.includes('--resume')?args[args.indexOf('--resume')+1]:null;
const session=resumed||process.env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID;const frames=[];let serial=0;
function read(file){const id='read-'+count+'-'+(++serial);const body=fs.readFileSync(file,'utf8');
 const call={type:'assistant',session_id:session,message:{role:'assistant',content:[{type:'tool_use',id,name:'Read',input:{file_path:file}}]}};
 let text=body;if(['numbered','numbered-eof','numbered-missing-final'].includes(mode)){const lines=body.split('\\n');if(mode!=='numbered'&&body.endsWith('\\n'))lines.pop();if(mode==='numbered-missing-final')lines.pop();text=lines.map((line,index)=>String(index+1).padStart(6)+'→'+line).join('\\n');}
 if(mode==='forged'&&file===process.env.PROOF_SOURCE)text='Fabricated content never returned by this source.';
 const result={type:'user',session_id:session,message:{role:'user',content:[{type:'tool_result',tool_use_id:mode==='wrong-pair'&&file===process.env.PROOF_SOURCE?'foreign':id,content:text}]}};
 if(mode==='assistant-claim'&&file===process.env.PROOF_SOURCE)result.type='assistant';
 frames.push(call,result);if(mode==='duplicate-result'&&file===process.env.PROOF_SOURCE)frames.push(result);
}
if(count===1){const requestPath=/Read the request at (.*)\\.\\n/.exec(args[0])?.[1];if(!requestPath)throw Error('Missing private request');
 const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));read(requestPath);if(mode!=='missing-basis')read(request.groundTruthPath);if(mode==='uncited')read(process.env.PROOF_UNCITED);read(process.env.PROOF_SOURCE);}
const report=JSON.parse(process.env.PROOF_REPORT);if(mode==='repair'&&count===1)delete report.summary;
if(mode==='missing-frame-session')for(const frame of frames)delete frame.session_id;
frames.push({type:'result',session_id:mode==='missing-terminal-session'?undefined:mode==='wrong-followup-session'&&count>1?'foreign-session':session,structured_output:report});
process.stdout.write(frames.map(value=>JSON.stringify(value)).join('\\n')+'\\n');
`);
  const options = { ...f.input, classification: undefined, sessionCwd: f.root, parentSessionId: "parent",
    reviewer: { ...f.input.reviewer, effort: "low", session: "detached" }, reviewerRuntime: { executable: process.execPath, argsPrefix: [entry] },
    env: { ...process.env, PROOF_COUNT: count, PROOF_MODE: mode, PROOF_SOURCE: f.source, PROOF_UNCITED: uncited, PROOF_REPORT: JSON.stringify(report) } };
  return { ...f, options, uncited, calls: async () => JSON.parse(await fs.readFile(count, "utf8")) };
}

for (const mode of ["complete", "numbered", "numbered-eof", "numbered-missing-final", "missing-basis", "forged", "wrong-pair", "assistant-claim", "duplicate-result", "missing-frame-session", "missing-terminal-session", "repair"]) test(`Claude native stream-json read proof: ${mode}`, async t => {
  const f = await streamedCli(t, mode);
  const handle = await collectReviewItems({ ...f.input, reviewerFactory: params => startRoleReviewer({ ...f.options, ...params,
    reviewer: { ...f.options.reviewer, ...params.reviewer } }) });
  const success = ["complete", "numbered", "numbered-eof", "repair"].includes(mode);
  assert.equal(handle.collection.complete, success);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, success ? "PASS" : "UNVERIFIED");
  assert.equal(await f.calls(), mode === "repair" ? 2 : 1);
});

test("CLI follow-up retains authenticated basis reads in the same session and keeps streaming enabled", async t => {
  const f = await streamedCli(t, "complete"), handle = await startRoleReviewer(f.options);
  try {
    const next = await handle.followUp({ prompt: "Recheck the unchanged evidence.", nextReviewer: { effort: "low", session: "detached", timeoutMs: 5000 } });
    const citations = await handle.getSourceCitations(next);
    assert(citations.some(citation => citation.readProof?.observed && citation.readProof.basisComplete));
    assert.equal(await f.calls(), 2);
  } finally { await handle.close(); }
});

test("CLI follow-up cannot inherit proof through a different session identity", async t => {
  const f = await streamedCli(t, "wrong-followup-session"), handle = await startRoleReviewer(f.options);
  await assert.rejects(handle.followUp({ prompt: "Recheck the unchanged evidence." }), /expected/u);
  await handle.close();
  assert.equal(await f.calls(), 2);
});

test("CLI exposes uncited successful business reads as mutable review dependencies", async t => {
  const f = await streamedCli(t, "uncited"), handle = await startRoleReviewer(f.options);
  try {
    const evidence = handle.reviewEvidence;
    assert(evidence.files.includes(f.uncited));
    assert(evidence.files.includes(f.source));
    assert.equal(evidence.files.some(file => file.includes(".internal-requests")), false);
    assert.equal(await reviewReadEvidenceMatches(f.root, evidence), true);
    await fs.writeFile(f.uncited, "Changed after the model actually read it.\n");
    assert.equal(await reviewReadEvidenceMatches(f.root, evidence), false);
  } finally { await handle.close(); }
});
