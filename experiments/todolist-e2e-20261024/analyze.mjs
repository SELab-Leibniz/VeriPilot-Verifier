// Read-only analysis of this experiment's already saved traces.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { files } from "../../scripts/diagnostics/lib/isolated-openclaw.mjs";
const root = path.resolve(process.argv[2]);
assert.equal(path.dirname(root), path.join(process.cwd(), "experiments"));
assert(/^live-(?:todolist|kitchen)-/u.test(path.basename(root)));
const read = async p => JSON.parse(await fs.readFile(p, "utf8"));
const report = await read(path.join(root, "report.json"));
assert(report.projectRoot, "No business task was admitted");
const runtime = await read(path.join(root, "runtime-final.json"));
const runtimeFiles = await files(path.join(report.projectRoot, ".runtime-correction"));
const portable = p => p.replaceAll("\\", "/");
const countBy = (xs, key) => xs.reduce((out, x) => { const k = key(x) ?? "unknown"; out[k] = (out[k] ?? 0) + 1; return out; }, {});
const sessions = async file => (await fs.readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const usage = rows => rows.filter(r => r.type === "message" && r.message?.role === "assistant").reduce((out, r) => {
  const u = r.message.usage ?? {}; out.messages++; for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoningTokens"]) out[k] += u[k] ?? 0;
  out.maxReportedContextTokens = Math.max(out.maxReportedContextTokens, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
  return out;
}, { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, maxReportedContextTokens: 0 });
const mainFile = path.join(root, "host/host-state/agents/main/sessions", `${report.sessionId}.jsonl`);
const mainRows = await sessions(mainFile);
const mainMessages = mainRows.filter(r => r.type === "message");
const toolCalls = mainMessages.flatMap(r => (Array.isArray(r.message?.content) ? r.message.content : [])
  .filter(b => b.type === "toolCall").map(b => ({ at: r.timestamp, id: b.id, name: b.name, arguments: b.arguments })));
const finalReplies = mainMessages.filter(r => r.message?.role === "assistant" && r.message?.stopReason === "stop")
  .map(r => ({ at: r.timestamp, text: r.message.content?.filter?.(b => b.type === "text").map(b => b.text).join("\n") }));
const workerResults = await Promise.all(runtimeFiles.filter(p => portable(p).includes("/review-task-runs/") && p.endsWith("/result.json"))
  .map(async file => ({ file, ...await read(file) })));
// path.join uses backslashes on Windows; use the portable path for suffix checks.
if (!workerResults.length) for (const file of runtimeFiles.filter(p => portable(p).includes("/review-task-runs/") && portable(p).endsWith("/result.json")))
  workerResults.push({ file, ...await read(file) });
const workerRows = workerResults.map(r => ({ file: r.file, taskId: r.taskId, scope: r.scope, completed: r.completed,
  verdict: r.verdict, reason: r.reason, limits: r.limits, evidencePath: r.evidencePath,
  diagnostic: r.diagnostic, elapsedMs: r.elapsedMs, metrics: r.metrics, error: r.error, attempts: r.attempts }));
const workerHealth = await Promise.all(workerRows.map(async r => {
  const events = await sessions(path.join(path.dirname(r.file), "events.jsonl"));
  const checks = events.filter(e => e.type === "context_check");
  return { file: r.file, scope: r.scope, maxEstimatedRequestTokens: Math.max(0, ...checks.map(e => e.estimatedTokens ?? 0)),
    contextWindow: checks[0]?.contextWindow, unsafeRequestsPrevented: r.metrics?.unsafeRequestsPrevented ?? 0,
    requestCount: events.filter(e => e.type === "request_options").length };
}));
const sumMetrics = workerRows.reduce((out, r) => { for (const [key, value] of Object.entries(r.metrics ?? {})) if (typeof value === "number") out[key] = (out[key] ?? 0) + value; return out; }, {});
const evaluations = runtime.evaluations.map(e => ({ file: e.file, evaluationId: e.evaluationId,
  stopClassification: e.review?.stopClassification, reviewStatus: e.review?.status,
  implementation: e.implementationReview, collection: e.review?.collection, fileAssessments: e.review?.fileAssessments,
  metricStatus: e.metricReport?.status, checkerIssues: e.metricReport?.checkerIssues,
  metrics: e.metricReport?.metrics?.map(m => ({ metricId: m.metricId ?? m.id, status: m.status,
    counts: countBy(m.objects ?? [], o => o.judgement), objects: m.objects })) }));
const nativeFiles = runtimeFiles.filter(p => portable(p).includes("/.internal-requests/") && portable(p).endsWith("/session.jsonl"));
if (!nativeFiles.length) nativeFiles.push(...(await files(path.join(root, "native-traces-snapshots"))).filter(p => portable(p).endsWith("/session.jsonl")));
const nativeUsage = await Promise.all(nativeFiles.map(async file => {
  const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean);
  const rows = lines.flatMap((line, i) => { try { return [JSON.parse(line)]; }
    catch (error) { if (i === lines.length - 1) return []; throw error; } });
  const reads = rows.flatMap(r => Array.isArray(r.message?.content) ? r.message.content : [])
    .filter(b => b.type === "toolCall" && b.name === "read").map(b => b.arguments);
  return { file, ...usage(rows), reads, readPathCounts: countBy(reads, r => r.path ?? r.file_path) };
}));
const gatewayRows = (await sessions(path.join(root, "host/gateway.jsonl"))).map(r => ({ at: r.time, level: r._meta?.logLevelName, text: r.message ?? r[1] }));
const errors = gatewayRows.filter(r => /overflow|too (?:long|large)|context.*exceed|\btimeout\b|\btimed out\b|failed|checker.error|exception|stalled session|stuck session recovery|aborting run|lane task error|agent run aborted/iu.test(r.text ?? "")
  && !/overflow-precheck.*route=fits/iu.test(r.text ?? ""));
const trajectoryPointer = await read(path.join(root, "host/host-state/agents/main/sessions", `${report.sessionId}.trajectory-path.json`)).catch(() => null);
const supervisedCleanup = await read(path.join(root, "supervised-cleanup.json")).catch(e => { if (e.code === "ENOENT") return null; throw e; });
const analysis = { status: report.status, startedAt: report.startedAt, finishedAt: report.finishedAt,
  supervisedCleanup,
  elapsedMs: report.finishedAt - report.startedAt, sessionId: report.sessionId, projectRoot: report.projectRoot,
  flags: { document: report.documentCorrectionEnabled, skill: report.skillCorrectionEnabled, implementation: report.implementationCorrectionEnabled, stop: report.stopCorrectionEnabled },
  protectedInputChecks: report.protectedInputChecks, originalHostChecks: report.originalHostChecks,
  acceptance: report.businessAcceptance, stopTerminal: report.stopTerminal,
  taskStates: runtime.tasks.map(t => ({ taskId: t.taskId, status: t.status, stop: t.stop, verification: t.verification,
    watchers: t.watchers, skillFeedbacks: t.skillFeedbacks, groundTruth: t.groundTruth })),
  nativeRoleCounts: countBy(runtime.records.filter(r => r.file.includes("/native-runs/")), r => r.role),
  nativeStops: runtime.records.filter(r => r.file.includes("/native-stop-reviews/")),
  followups: runtime.records.filter(r => r.file.includes("/native-followups/")),
  evaluations, workerRows, workerHealth, workerTotals: sumMetrics, mainUsage: usage(mainRows), nativeUsage,
  usageCaveat: "Session-reported input/cache/output tokens; worker totals are SDK metrics. No billing proxy. Native snapshot copies can miss final messages before temporary-directory cleanup and are a lower bound, not full native usage. Categories are separate, do not add native assistant counts as exact HTTP request counts.",
  mainToolCounts: countBy(toolCalls, t => t.name), toolCalls, finalReplies, gatewayErrors: errors,
  paths: { mainSession: mainFile, trajectoryPointer, runtime: path.join(report.projectRoot, ".runtime-correction"),
    wire: path.join(root, "host/wire.jsonl"), gateway: path.join(root, "host/gateway.jsonl"), finalState: path.join(root, "runtime-final.json") } };
await fs.writeFile(path.join(root, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n");
console.log(JSON.stringify({ status: analysis.status, elapsedMs: analysis.elapsedMs, acceptance: analysis.acceptance?.status,
  stop: { kind: analysis.stopTerminal.kind, totalObjects: analysis.stopTerminal.totalObjects,
    unverified: analysis.stopTerminal.unverifiedObjectIds?.length, allMetricsPass: analysis.stopTerminal.allMetricsPass },
  nativeRoleCounts: analysis.nativeRoleCounts, workerCount: workerRows.length,
  workerVerdicts: countBy(workerRows, r => r.verdict), workerTotals: sumMetrics, mainUsage: analysis.mainUsage,
  gatewayErrorCount: errors.length, analysis: path.join(root, "analysis.json") }, null, 2));
