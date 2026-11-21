import { promises as fs } from "node:fs";
import path from "node:path";
import { findTask, taskDirectory } from "../runtime-v2/task-store.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";

const rows = value => Array.isArray(value) ? value : [];
const evaluationId = value => typeof value === "string" && /^[a-z0-9_-]{1,180}$/iu.test(value);

async function readArtifact(root, file) {
  try {
    const resolved = await fs.realpath(file);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) return null;
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return null;
    return await fs.readFile(resolved, "utf8");
  } catch { return null; }
}

function matchesRun(verification, { runId, controlRevision = 0 }) {
  if (!verification || !runId) return false;
  if (verification.terminalRunId) return verification.terminalRunId === runId;
  const occurrence = controlRevision ? sha256(JSON.stringify({ runId, enabledRevision: controlRevision })).slice(0, 24) : runId;
  const assessment = runId + ":stop" + (controlRevision ? ":enabled-" + controlRevision : "");
  const value = verification.assessmentId;
  return typeof value === "string" && (value === occurrence || value === assessment
    || value.startsWith(occurrence) && /^:check-\d+$/u.test(value.slice(occurrence.length))
    || value.startsWith(assessment) && /^:infra-\d+$/u.test(value.slice(assessment.length)));
}

async function reviewDetails(snapshot) {
  const { projectRoot, sessionId, taskId } = snapshot;
  if (!snapshot.outcome || !snapshot.runId) return null;
  let task;
  try { task = await findTask({ projectRoot, sessionId, explicitTaskId: taskId }); }
  catch { return null; }
  if (!task?.sessionIds?.includes(sessionId)) return null;
  const verification = task.verification;
  if (!matchesRun(verification, snapshot) || verification.status !== snapshot.outcome || !evaluationId(verification.evaluationId)) return null;
  try {
    const file = path.join(taskDirectory(projectRoot, task.taskId), "evaluations", verification.evaluationId + ".json");
    const report = JSON.parse(await readArtifact(projectRoot, file));
    if (report?.evaluationId !== verification.evaluationId || report.outcome?.status !== snapshot.outcome || !report.review) return null;
    const review = report.review;
    return {
      evaluationId: report.evaluationId,
      coverage: report.coverage ?? null,
      items: [...rows(review.metricObjectJudgements), ...rows(review.fileAssessments), ...rows(review.findings),
        ...rows(report.unverifiedItems ?? review.unverifiedItems), ...rows(report.outcome.historicalDeviations)]
        .map(item => ({
          label: item.title ?? item.statement ?? item.requirement ?? item.objectId ?? item.path ?? item.metricId ?? item.deviationKey,
          judgement: item.judgement ?? item.status ?? (item.kind === "IRREVERSIBLE_ORDER" ? "HISTORICAL_DEVIATION" : item.severity ? "FINDING" : "UNVERIFIED"),
          reason: item.reason ?? item.message ?? item.explanation ?? null,
          evidence: rows(item.evidence ?? item.actualEvidence).filter(value => typeof value === "string"),
        })),
    };
  } catch { return null; }
}

async function latestBrief({ projectRoot, sessionId }) {
  const file = path.join(projectRoot, ".runtime-correction", "requirement-frame", sha256(sessionId).slice(0, 24), "deliveries.jsonl");
  const raw = await readArtifact(projectRoot, file);
  if (!raw) return null;
  const lines = raw.slice(0, raw.lastIndexOf("\n") + 1).trimEnd().split(/\r?\n/u);
  for (const line of lines.reverse()) {
    try {
      const item = JSON.parse(line);
      if (Number.isFinite(Date.parse(item.at)) && ["run_start", "tool_result"].includes(item.channel)
        && typeof item.runId === "string") return { at: item.at, runId: item.runId, channel: item.channel };
    } catch { /* A later write can leave a partial or malformed record. */ }
  }
  return null;
}

export async function readSessionRuntimeDetails(snapshot, readFollowup) {
  const [review, brief, receipt] = await Promise.all([
    reviewDetails(snapshot), latestBrief(snapshot),
    snapshot.runId ? Promise.resolve().then(() => readFollowup?.(snapshot, snapshot.runId)).catch(() => null) : null,
  ]);
  let repair = null;
  if (receipt?.runId === snapshot.runId && receipt.source?.runId && receipt.source.runId !== snapshot.runId) {
    const started = Number.isFinite(receipt.modelObservedAt);
    repair = {
      runId: receipt.runId,
      sourceRunId: receipt.source.runId,
      evaluationId: receipt.assessmentId ?? null,
      started,
      text: started && typeof receipt.message === "string" && !receipt.message.startsWith("[runtime-corrector:stop-reference]")
        && sha256(receipt.message) === receipt.messageHash ? receipt.message : null,
    };
  } else if (snapshot.runId?.startsWith("rc-stop-")) {
    // The reserved prefix alone is insufficient to prove which input was delivered.
    repair = { runId: snapshot.runId, sourceRunId: null, evaluationId: null, started: null, text: null };
  }
  return { roundId: snapshot.roundId, review, brief, repair };
}
