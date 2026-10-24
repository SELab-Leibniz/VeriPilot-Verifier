// Read-only experiment audit. Its checks describe mechanisms, not model accuracy.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const root = path.resolve(process.argv[2]);
assert.equal(path.dirname(root), path.join(process.cwd(), "experiments"));
assert(/^live-todolist-/u.test(path.basename(root)));
const read = file => fs.readFile(path.join(root, file), "utf8").then(JSON.parse);
const countBy = (rows, key) => rows.reduce((out, row) => { const value = key(row) ?? "unknown"; out[value] = (out[value] ?? 0) + 1; return out; }, {});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const [report, analysis, postcheck, settings, admission, runtime] = await Promise.all([
  "report.json", "analysis.json", "postcheck.json", "effective-config.json", "source-admission.json", "runtime-final.json",
].map(read));
const optional = file => read(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const [postClose, supplementary, identityProbe] = await Promise.all([
  "post-close-state.json", "supplementary-store-path-probe.json", "manual-check-identity-probe.json",
].map(optional));
const ownTasks = runtime.tasks.filter(task => task.rootSessionId === report.sessionId || task.sessionIds?.includes(report.sessionId));
assert.equal(ownTasks.length, 1);
const task = ownTasks[0], taskRoot = path.join(report.projectRoot, ".runtime-correction/tasks", task.taskId);
const truth = JSON.parse(await fs.readFile(path.join(taskRoot, "ground-truth/current.json"), "utf8"));
const population = await fs.readFile(path.join(taskRoot, "metrics/population.json"), "utf8").then(JSON.parse)
  .catch(error => { if (error.code === "ENOENT") return null; throw error; });
const terminalEvaluation = runtime.evaluations.find(value => value.evaluationId === task.verification?.evaluationId);
// A bounded no-progress exit can retain the previous complete metric report.
// Keep the terminal decision separate rather than losing its retained proof.
const evaluation = terminalEvaluation?.metricReport ? terminalEvaluation
  : runtime.evaluations.filter(value => value.metricReport).sort((a, b) => a.evaluationId.localeCompare(b.evaluationId)).at(-1);
const metricRows = evaluation?.metricReport?.metrics ?? [];
const timeline = (await fs.readFile(path.join(root, "timeline.jsonl"), "utf8")).trim().split(/\r?\n/u).map(JSON.parse);
const generated = new Set(["lib/active-host.mjs", "lib/claude-executable.mjs", "lib/plugin-builder.mjs", "lib/hosts/claude.mjs", "lib/hosts/codeagent.mjs"]);
const sourceChecks = [];
for (const [file, expected] of Object.entries(admission.sourceHashes)) {
  if (generated.has(file)) continue;
  const actual = await fs.readFile(path.join(root, "host/plugin/runtime-corrector-openclaw", file)).catch(() => null);
  sourceChecks.push({ file, matches: actual !== null && sha(actual) === expected });
}
const policy = JSON.parse(await fs.readFile(path.join(root, "host/plugin/runtime-corrector-openclaw/lib/review-task/prompts.json"), "utf8"));
const finalIds = new Set(metricRows.flatMap(metric => metric.objects ?? []).map(object => object.objectId));
const expectedIds = Object.values(population?.metrics ?? {}).flat().map(object => object.objectId);
const hardClaims = truth.claims.filter(claim => claim.status === "ACTIVE" && claim.severity === "HARD");
const executionClaims = hardClaims.filter(claim => ["IMPLEMENTATION", "PROCESS"].includes(claim.verificationTarget));
const measuredClaims = new Set(metricRows.filter(metric => !/^M0[1-7]$/u.test(metric.metricId))
  .flatMap(metric => metric.objects ?? []).map(object => object.sourceId));
const receipts = analysis.followups;
const activeStatuses = new Set(["PENDING", "RUNNING", "DISPATCH_COMMITTED", "RESERVED", "ADMITTED"]);
const checks = {
  oneBusinessAdmission: timeline.filter(row => row.phase === "business admission").length === 1,
  startsWithoutApp: report.startsWithoutApp === true && report.businessCodeAuthoredByObserver === false,
  documentCorrectionDisabled: settings.artifactCorrection.groundTruthReviewEnabled === false && settings.artifactCorrection.stageMetricsEnabled === false,
  skillCorrectionDisabled: settings.skillCorrection.enabled === false,
  stopLimitExactlyTwo: settings.stopCorrection.enabled === true && settings.stopCorrection.maxCorrectionsPerEpoch === 2,
  correctionCountWithinLimit: (task.stop?.correctionAttempts ?? 0) <= 2,
  implementationReviewEnabled: settings.implementationCorrection.enabled === true,
  noDocumentOrSkillReviewer: !runtime.records.some(row => ["artifact-reviewer", "skill-reviewer"].includes(row.role)),
  noSkillWatchers: Object.keys(task.watchers ?? {}).length === 0 && Object.keys(task.skillFeedbacks ?? {}).length === 0,
  admittedPluginSourceUnchanged: sourceChecks.every(row => row.matches),
  m16PolicyMatchesAdmission: sha(policy.metricPrompts.M16) === report.m16PolicySha256,
  m16HasFrozenObjects: (population?.metrics.M16?.length ?? 0) > 0,
  retainedPopulationIdsPreserved: Boolean(population) && finalIds.size === expectedIds.length && expectedIds.every(id => finalIds.has(id)),
  hardExecutionClaimsHaveObjectOwners: executionClaims.every(claim => measuredClaims.has(claim.claimId)),
  protectedInputsUnchanged: Object.values(report.protectedInputChecks ?? {}).length > 0 && Object.values(report.protectedInputChecks).every(Boolean),
  originalHostFilesUnchanged: Object.values(report.originalHostChecks).every(Boolean),
  independentAcceptancePassed: report.businessAcceptance?.status === "PASS" && report.businessAcceptance.exitCode === 0 && report.businessAcceptance.scenarios === 10,
  noOpenFollowupReceipt: !receipts.some(row => activeStatuses.has(row.status) && !row.finishedAt),
  ownedGatewayClosed: report.ownedGatewayClosed === true,
  coreTaskHasTerminalStatus: ["COMPLETED", "COMPLETED_WITH_ISSUES", "STOPPED_UNVERIFIED", "CANCELLED"].includes(task.status),
  postCloseTaskHasTerminalStatus: postClose !== null && ["COMPLETED", "COMPLETED_WITH_ISSUES", "STOPPED_UNVERIFIED", "CANCELLED"].includes(postClose.status),
};
const workers = analysis.workerRows.map(worker => ({ ...worker, metricId: /^M\d\d(?=:)/u.exec(worker.taskId ?? "")?.[0] ?? null }));
const m16History = runtime.evaluations.map(row => ({ evaluationId: row.evaluationId, file: row.file,
  collectionComplete: row.review?.collection?.complete,
  implementationCollectionComplete: row.implementationReview?.collection?.complete,
  objects: row.metricReport?.metrics?.find(metric => metric.metricId === "M16")?.objects ?? [],
})).filter(row => row.objects.length);
const result = {
  auditedAt: Date.now(), checks, failedChecks: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
  caveat: "These are observation and integrity checks, not proof of model accuracy, complete application correctness, all-metric PASS or correction effectiveness.",
  source: { branch: report.sourceBranch, commit: report.sourceCommit, catalog: report.metricCatalogVersion,
    sourceFilesChecked: sourceChecks.length, mismatches: sourceChecks.filter(row => !row.matches) },
  task: { taskId: task.taskId, status: task.status, stop: task.stop, verification: task.verification },
  metricEvidenceEvaluationId: evaluation?.evaluationId,
  terminalEvaluation: terminalEvaluation && { evaluationId: terminalEvaluation.evaluationId, file: terminalEvaluation.file,
    status: terminalEvaluation.status, reasonCode: terminalEvaluation.reasonCode },
  groundTruth: { version: truth.version, frozenAtVersion: truth.frozenAtVersion, claims: truth.claims.length,
    categories: countBy(truth.claims, row => row.category), targets: countBy(truth.claims, row => row.verificationTarget),
    hardClaims: hardClaims.length, hardExecutionClaims: executionClaims.length,
    hardClaimsMissingExecutionOwner: executionClaims.filter(row => !measuredClaims.has(row.claimId)),
    ownershipCaveat: "This compares claim IDs with direct non-document metric ownership. A missing direct owner is not proof that the behavior was omitted: equivalent requirements and common review basis may cover the same meaning." },
  metrics: metricRows.map(metric => ({ metricId: metric.metricId, status: metric.status, value: metric.value,
    numerator: metric.numerator, denominator: metric.denominator, judgements: countBy(metric.objects ?? [], row => row.judgement) })),
  m16History, workersByMetric: countBy(workers, row => row.metricId), workersByScope: countBy(workers, row => row.scope),
  m16Workers: workers.filter(row => row.metricId === "M16"),
  deviations: Object.values(task.deviations ?? {}).map(family => ({ familyId: family.familyId, status: family.status,
    firstDetectedAt: family.firstDetectedAt, fixedAt: family.fixedAt, observations: family.observations?.length,
    deliveredObservations: family.observations?.filter(row => row.delivered).length,
    latestFinding: family.observations?.at(-1)?.finding })),
  checkerIssues: evaluation?.metricReport?.checkerIssues ?? [],
  roleCounts: analysis.nativeRoleCounts, followups: receipts, nativeStops: analysis.nativeStops,
  postCloseTask: postClose,
  supplementaryStorePathProbe: supplementary,
  manualCheckIdentityProbe: identityProbe,
  health: { workerTotals: analysis.workerTotals, maxEstimatedRequestTokens: Math.max(0, ...analysis.workerHealth.map(row => row.maxEstimatedRequestTokens)),
    gatewayErrors: analysis.gatewayErrors, chatTerminals: postcheck.wire.chatTerminals },
  evidence: { root, source: path.join(root, "source-admission.json"), settings: path.join(root, "effective-config.json"),
    mainSession: analysis.paths.mainSession, finalEvaluation: evaluation?.file, postcheck: path.join(root, "postcheck.json") },
};
await fs.writeFile(path.join(root, "audit.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ checks, taskStatus: task.status, verification: task.verification?.status,
  m16: result.metrics.find(metric => metric.metricId === "M16"), audit: path.join(root, "audit.json") }, null, 2));
