import { promises as fs } from "node:fs";
import path from "node:path";
import { findTask, taskDirectory } from "../runtime-v2/task-store.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { listNativeRuns } from "./native-runs.mjs";
import { nativeStopReviewDirectory } from "./native-stop-review.mjs";
import { sessionRuntimeRoundId } from "./session-runtime-status.mjs";
import { sessionRuntimeText } from "./session-runtime-text.mjs";
import { readStartedStopFeedback } from "./stop-start-protocol.mjs";
import { isRepairRunId } from "./repair-run-id.mjs";

const rows = value => Array.isArray(value) ? value : [];
const evaluationId = value => typeof value === "string" && /^[a-z0-9_-]{1,180}$/iu.test(value);
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

async function containedPath(root, file) {
  const resolved = await fs.realpath(file);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative) ? resolved : null;
}

async function readArtifact(root, file, { tail = false } = {}) {
  try {
    const resolved = await containedPath(root, file);
    if (!resolved) return null;
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return null;
    if (stat.size <= MAX_ARTIFACT_BYTES) return await fs.readFile(resolved, "utf8");
    if (!tail) return null;
    const handle = await fs.open(resolved, "r");
    try {
      const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, stat.size - buffer.length);
      const firstNewline = buffer.subarray(0, bytesRead).indexOf(10);
      return firstNewline === -1 ? null : buffer.toString("utf8", firstNewline + 1, bytesRead);
    } finally { await handle.close(); }
  } catch { return null; }
}

async function readJsonArtifact(root, file) {
  try { return JSON.parse(await readArtifact(root, file)); }
  catch { return null; }
}

async function readNativeReviews(snapshot) {
  const { projectRoot, sessionKey, sessionId } = snapshot;
  if (!sessionKey) return [];
  const directory = await containedPath(projectRoot, nativeStopReviewDirectory(snapshot)).catch(() => null);
  if (!directory) return [];
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const names = files.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)).map(entry => entry.name);
  const reviews = [];
  for (let offset = 0; offset < names.length; offset += 16) {
    const group = await Promise.all(names.slice(offset, offset + 16).map(name => readJsonArtifact(projectRoot, path.join(directory, name))));
    reviews.push(...group.filter(record => record?.sessionKey === sessionKey && record.sessionId === sessionId
      && typeof record.runId === "string" && record.runId && record.reviewStatus
      && (record.status === "SETTLED" || Number.isFinite(record.assessmentCompletedAt))));
  }
  return reviews.sort((a, b) => (b.settledAt ?? b.assessmentCompletedAt ?? 0) - (a.settledAt ?? a.assessmentCompletedAt ?? 0));
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

const reviewCategories = ["NO_DEVIATION_FOUND", "DEVIATION", "UNVERIFIED", "NOT_REVIEWED", "NOT_APPLICABLE"];
const coverageNoteTypes = new Set(["ORIGINAL_CHECKLIST", "REVIEW_COMPLETION"]);

function reviewCategory(item, judgement, pending) {
  if (coverageNoteTypes.has(item.type) || judgement === "HISTORICAL_DEVIATION") return null;
  if (judgement === "PASS" || judgement === "NO_DEVIATION_FOUND") return "NO_DEVIATION_FOUND";
  if (judgement === "DEVIATION" || judgement === "FINDING") return "DEVIATION";
  if (judgement === "NOT_APPLICABLE" || judgement === "NOT_YET_APPLICABLE") return "NOT_APPLICABLE";
  if (pending || item.reviewState === "UNREVIEWED" || judgement === "NOT_REVIEWED"
    || ["NOT_REVIEWED", "HISTORICAL_RESULT_PENDING_REVIEW"].includes(item.reason)) return "NOT_REVIEWED";
  return "UNVERIFIED";
}

export function summarizeReviewView({ items = [], scopeKnown = false } = {}) {
  const counts = Object.fromEntries(reviewCategories.map(category => [category, 0]));
  for (const item of items) if (Object.hasOwn(counts, item.category)) counts[item.category]++;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!total && !scopeKnown) return null;
  let outcome = "NO_DEVIATION_FOUND";
  if (counts.DEVIATION) outcome = "DEVIATION";
  else if (!counts.NO_DEVIATION_FOUND && counts.UNVERIFIED) outcome = "UNVERIFIED";
  else if (total > 0 && counts.NOT_REVIEWED === total) outcome = "NOT_REVIEWED";
  return { outcome, total, categories: reviewCategories.map(category => ({
    category, count: counts[category], percentage: total ? (counts[category] / total) * 100 : null,
  })) };
}

function displayReviewItem(item, label, pending = false) {
  const judgement = item.judgement ?? item.status ?? (item.kind === "IRREVERSIBLE_ORDER" ? "HISTORICAL_DEVIATION" : item.severity ? "FINDING" : "UNVERIFIED");
  return {
    label: item.title ?? item.statement ?? item.requirement ?? item.description ?? label
      ?? item.objectId ?? item.path ?? item.metricId ?? item.deviationKey ?? item.id,
    judgement, category: reviewCategory(item, judgement, pending),
    reason: item.reason ?? item.message ?? item.explanation ?? null,
    evidence: rows(item.evidence ?? item.actualEvidence).filter(value => typeof value === "string"),
  };
}

const reviewItemId = item => item.objectId ?? (typeof item.path === "string" ? "file:" + item.path : null);
const unreviewedItem = label => displayReviewItem({ judgement: "NOT_REVIEWED", reason: "本轮已选入，尚无已保存的判定" }, label);

function summarizeReview(report) {
  const review = report.review ?? {};
  const selected = new Map(Object.values(review.scopeSelection?.metrics ?? {}).flatMap(metric => rows(metric?.objects))
    .filter(item => item?.selected === true && typeof item.objectId === "string").map(item => [item.objectId, item.description]));
  const primary = [...rows(review.metricObjectJudgements), ...rows(review.fileAssessments)].filter(Boolean);
  const pending = new Set(rows(report.core?.summary?.items)
    .filter(item => item?.receiptId === null && item.result?.judgement === "UNVERIFIED").map(item => item.objectId));
  const represented = new Set(primary.map(reviewItemId).filter(Boolean));
  const items = primary.map(item => displayReviewItem(item, selected.get(item.objectId), pending.has(item.objectId)
    || item.reason === "The requested file-quality review was not submitted."));
  for (const item of rows(review.findings).filter(Boolean)) items.push(displayReviewItem(item, selected.get(item.objectId)));
  for (const item of rows(report.unverifiedItems ?? review.unverifiedItems).filter(Boolean)) {
    const id = reviewItemId(item) ?? item.id;
    if (id && represented.has(id)) continue;
    if (id) represented.add(id);
    items.push(displayReviewItem(item, selected.get(id)));
  }
  for (const item of rows(report.outcome.historicalDeviations).filter(Boolean))
    items.push({ ...displayReviewItem(item), category: null });
  const coverage = report.coverage ?? report.outcome.coverage ?? null;
  const scanCompleted = review.collection?.mode === "deviation-only" && review.collection.complete === true
    && coverage?.scanCompleted === true;
  for (const [id, description] of selected) if (!represented.has(id)) {
    const label = description || id;
    items.push(scanCompleted && !pending.has(id) ? displayReviewItem({ judgement: "NO_DEVIATION_FOUND", reason: "本轮偏差扫描已完成" }, label)
      : unreviewedItem(label));
  }
  return { evaluationId: report.evaluationId, coverage,
    scopeKnown: Boolean(review.scopeSelection) || (coverage?.selectedObjectCount ?? 0) > 0,
    reasonCode: report.outcome.reasonCode ?? null, items };
}

async function finalReviewDetails(snapshot, round) {
  if (!round?.outcome || !round.runId) return null;
  const { projectRoot, sessionId } = snapshot;
  const readTask = taskId => findTask({ projectRoot, sessionId, explicitTaskId: taskId }).catch(() => null);
  const readReport = async (taskId, id) => {
    try {
      const file = path.join(taskDirectory(projectRoot, taskId), "evaluations", id + ".json");
      const report = await readJsonArtifact(projectRoot, file);
      if (report?.evaluationId !== id || report.outcome?.status !== round.outcome
        || report.outcome.taskId && report.outcome.taskId !== taskId) return null;
      const task = await readTask(taskId);
      return task?.sessionIds?.includes(sessionId) ? summarizeReview(report) : null;
    } catch { return null; }
  };
  const receipt = round.reviewReceipt;
  if (evaluationId(receipt?.evaluationId)) {
    const tried = new Set([receipt.taskId, round.taskId, snapshot.taskId, (await readTask())?.taskId].filter(Boolean));
    for (const taskId of tried) {
      const report = await readReport(taskId, receipt.evaluationId);
      if (report) return report;
    }
    // Older review receipts kept the evaluation ID without the task directory.
    if (!receipt.taskId) {
      const directory = await containedPath(projectRoot, path.join(projectRoot, ".runtime-correction", "tasks")).catch(() => null);
      const tasks = directory ? await fs.readdir(directory, { withFileTypes: true }).catch(() => []) : [];
      for (const task of tasks) {
        if (!task.isDirectory() || tried.has(task.name)) continue;
        const report = await readReport(task.name, receipt.evaluationId);
        if (report) return report;
      }
    }
  }
  const task = await readTask(round.taskId ?? snapshot.taskId);
  const verification = task?.verification;
  if (!task?.sessionIds?.includes(sessionId) || !matchesRun(verification, round)
    || verification.status !== round.outcome || !evaluationId(verification.evaluationId)) return null;
  return readReport(task.taskId, verification.evaluationId);
}

async function reviewProgress(snapshot, round) {
  if (!round?.runId) return null;
  const { projectRoot, sessionId, sessionKey } = snapshot;
  const task = await findTask({ projectRoot, sessionId, explicitTaskId: round.taskId ?? snapshot.taskId }).catch(() => null);
  if (!task?.sessionIds?.includes(sessionId)) return null;
  const occurrenceId = round.reviewReceipt?.occurrenceId;
  const runs = await listNativeRuns(projectRoot, task.taskId).catch(() => []);
  const owned = runs.filter(run => {
    const owner = run.stopReviewOwner;
    return run.role === "stop-reviewer" && run.taskId === task.taskId && owner?.runId === round.runId
      && owner.sessionId === sessionId && owner.sessionKey === sessionKey && owner.controlRevision === (round.controlRevision ?? 0)
      && (!occurrenceId || occurrenceId === owner.occurrenceId);
  }).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (typeof owned?.sessionFile !== "string" || !/^host-session(?:-reopened)?\.jsonl$/u.test(path.basename(owned.sessionFile))) return null;
  const workspace = await containedPath(projectRoot, path.join(taskDirectory(projectRoot, task.taskId), "workspace-reviews")).catch(() => null);
  const directory = workspace && await containedPath(workspace, path.dirname(owned.sessionFile)).catch(() => null);
  if (!directory || path.dirname(directory) !== workspace) return null;
  const [scope, checklist] = await Promise.all([
    readJsonArtifact(projectRoot, path.join(directory, "scope.json")),
    readJsonArtifact(projectRoot, path.join(directory, "original-checklist.json")),
  ]);
  if (!Array.isArray(scope?.objectIds)) return {
    stage: checklist ? "SELECTING_SCOPE" : "READING_BASIS", scopeKnown: false, items: [], provisional: true,
  };
  const descriptions = new Map(Object.values(checklist?.population?.metrics ?? {}).flatMap(rows)
    .filter(item => item?.objectId).map(item => [item.objectId, item.description]));
  const selected = new Map(scope.objectIds.filter(id => typeof id === "string").map(id => [id, descriptions.get(id) ?? id]));
  for (const file of rows(scope.qualityTargets))
    if (typeof file?.path === "string") selected.set("file:" + file.path, file.path);
  const items = [];
  const entries = [...selected];
  for (let offset = 0; offset < entries.length; offset += 16) {
    const pages = await Promise.all(entries.slice(offset, offset + 16).map(async ([id, label]) => {
      const saved = await readJsonArtifact(projectRoot, path.join(directory, "items", sha256(id) + ".json"));
      return saved?.itemId === id && saved.result && reviewItemId(saved.result) === id
        ? displayReviewItem(saved.result, label) : unreviewedItem(label);
    }));
    items.push(...pages);
  }
  return { stage: "CHECKING_ITEMS", scopeKnown: true, coverage: { selectedObjectCount: entries.length }, items, provisional: true };
}

async function reviewDetails(snapshot, round) {
  const final = await finalReviewDetails(snapshot, round);
  if (final?.scopeKnown || final?.items.length) return final;
  const progress = await reviewProgress(snapshot, round);
  return progress ? { ...final, ...progress } : final;
}

async function readBriefs({ projectRoot, sessionId }) {
  const file = path.join(projectRoot, ".runtime-correction", "requirement-frame", sha256(sessionId).slice(0, 24), "deliveries.jsonl");
  const raw = await readArtifact(projectRoot, file, { tail: true });
  const briefs = [];
  if (!raw) return briefs;
  const lines = raw.slice(0, raw.lastIndexOf("\n") + 1).trimEnd().split(/\r?\n/u);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (Number.isFinite(Date.parse(item.at)) && ["run_start", "tool_result"].includes(item.channel)
        && typeof item.runId === "string" && item.runId) briefs.push({ at: item.at, runId: item.runId, channel: item.channel,
        text: typeof item.text === "string" && item.text.startsWith("[runtime-corrector:feedback]\n") ? item.text : null });
    } catch { /* A later write can leave a partial or malformed record. */ }
  }
  return briefs;
}

function sessionRounds(snapshot, reviews, briefs, repairs) {
  const rounds = new Map(), byRun = new Map(), revisions = new Map();
  for (const review of reviews) {
    if (!revisions.has(review.runId)) revisions.set(review.runId, new Set());
    revisions.get(review.runId).add(review.enabledRevision ?? 0);
  }
  function add(round) {
    if (!round?.runId || !round.roundId || rounds.has(round.roundId)) return;
    rounds.set(round.roundId, round);
    if (!byRun.has(round.runId)) byRun.set(round.runId, []);
    byRun.get(round.runId).push(round);
  }
  const recovered = (runId, controlRevision, fields) => ({ runId, controlRevision,
    roundId: sessionRuntimeRoundId({ ...snapshot, scopeFingerprint: null }, runId, controlRevision), ended: true, ...fields });
  add({ ...snapshot, isCurrent: true });
  for (const row of [...rows(snapshot.history), snapshot.lastEndedRound]) add(row && { ...row });
  for (const receipt of reviews) {
    const { runId, reviewStatus, reasonCode, enabledRevision = 0 } = receipt;
    const matching = byRun.get(runId) ?? [];
    let round = matching.find(row => row.controlRevision === enabledRevision)
      ?? (revisions.get(runId).size === 1 && matching.length === 1 && matching[0].controlRevision == null ? matching[0] : null);
    if (!round) {
      round = recovered(runId, enabledRevision, { status: "ENDED", startedAt: receipt.createdAt ?? receipt.startedAt,
        endedAt: receipt.settledAt ?? receipt.assessmentCompletedAt });
      add(round);
    }
    if (!round.reviewReceipt && (!round.outcome || round.outcome === reviewStatus)) {
      round.reviewReceipt = receipt;
      round.outcome ??= reviewStatus;
      round.reasonCode ??= reasonCode;
    }
  }
  for (const repair of repairs) {
    if (!byRun.has(repair.runId) && Number.isFinite(repair.startedAt)) add(recovered(repair.runId, 0, {
      startedAt: repair.startedAt, endedAt: repair.endedAt, outcome: repair.outcome, ended: Boolean(repair.endedAt || repair.closed),
    }));
  }
  for (const brief of briefs) {
    const at = Date.parse(brief.at);
    if (!byRun.has(brief.runId)) add(recovered(brief.runId, 0, { startedAt: at, ended: null }));
    const matching = byRun.get(brief.runId);
    const candidates = matching.length === 1 ? matching : matching.filter(round => Number.isFinite(round.startedAt)
      && round.startedAt <= at && (!round.endedAt || at <= round.endedAt));
    if (candidates.length === 1) candidates[0].brief = brief;
  }
  return [...rounds.values()].sort((a, b) => Number(Boolean(b.isCurrent)) - Number(Boolean(a.isCurrent))
    || (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0));
}

export function summarizeSessionRepairs(snapshot, ledger) {
  if (ledger?.sessionId !== snapshot.sessionId) return [];
  return Object.values(ledger.admissions ?? {}).flatMap(admission => {
    const request = admission.hostRequest;
    if (!request?.runId || request.sessionKey !== snapshot.sessionKey || request.projectRoot !== snapshot.projectRoot) return [];
    return [{
      runId: request.runId, sourceRunId: request.source?.runId ?? null,
      startedAt: admission.startedAt ?? null, endedAt: admission.endedAt ?? null,
      closed: admission.accounting === "RELEASED" || Number.isFinite(admission.invalidatedAt),
      outcome: admission.finalReview?.status ?? null,
    }];
  }).reverse();
}

function repairFeedback(receipt) {
  if (!Number.isFinite(receipt.modelObservedAt) || typeof receipt.message !== "string") return null;
  if (receipt.message.startsWith("[runtime-corrector:stop-reference]")) return readStartedStopFeedback(receipt.admission);
  return sha256(receipt.message) === receipt.messageHash ? receipt.message : null;
}

export async function readSessionRuntimeDetails(snapshot, readFollowup, readRepairs, roundId = snapshot.roundId) {
  const [nativeReviews, briefs, repairRuns] = await Promise.all([
    readNativeReviews(snapshot), readBriefs(snapshot),
    Promise.resolve().then(() => readRepairs?.(snapshot)).catch(() => null),
  ]);
  const allRepairs = repairRuns ?? [];
  const rounds = sessionRounds(snapshot, nativeReviews, briefs, allRepairs);
  const round = roundId == null ? rounds[0] : rounds.find(row => row.roundId === roundId);
  if (!round && roundId != null)
    throw Object.assign(new Error("This round is unavailable for the selected session."), { code: "CONFLICT" });
  const readReceipt = async runId => {
    if (!runId) return null;
    const candidate = await Promise.resolve().then(() => readFollowup?.(snapshot, runId)).catch(() => null);
    return candidate?.runId === runId
      && (!candidate.projectRoot || candidate.projectRoot === snapshot.projectRoot)
      && (!candidate.sessionKey || candidate.sessionKey === snapshot.sessionKey) ? candidate : null;
  };
  const [review, receipt] = await Promise.all([reviewDetails(snapshot, round), readReceipt(round?.runId)]);
  let repair = null;
  if (receipt?.source?.runId && receipt.source.runId !== round.runId) {
    repair = {
      runId: receipt.runId,
      sourceRunId: receipt.source.runId,
      evaluationId: receipt.assessmentId ?? null,
      started: Number.isFinite(receipt.modelObservedAt),
      text: repairFeedback(receipt),
    };
  } else if (isRepairRunId(round?.runId)) {
    // The reserved prefix alone is insufficient to prove which input was delivered.
    repair = { runId: round.runId, sourceRunId: null, evaluationId: null, started: null, text: null };
  }
  const repairs = allRepairs.filter(row => round && [row.runId, row.sourceRunId].includes(round.runId));
  if (repair?.sourceRunId && !repairs.some(row => row.runId === repair.runId)) {
    repairs.unshift({ runId: receipt.runId, sourceRunId: receipt.source.runId,
      startedAt: receipt.modelObservedAt ?? null, endedAt: receipt.finishedAt ?? null,
      closed: receipt.status === "CANCELLED", outcome: null });
  }
  const repairRows = await Promise.all(repairs.map(async row => {
    const linked = rounds.find(candidate => candidate.runId === row.runId);
    const summary = { ...row, roundId: linked?.roundId ?? null };
    if (row.sourceRunId !== round?.runId) return summary;
    const next = Number.isFinite(row.startedAt) ? await readReceipt(row.runId) : null;
    return { ...summary, input: next?.source?.runId === round.runId ? repairFeedback(next) : null };
  }));
  const briefRound = rounds.filter(row => row.brief).sort((a, b) => Date.parse(b.brief.at) - Date.parse(a.brief.at))[0];
  const describe = row => ({ roundId: row.roundId, runId: row.runId, isCurrent: row.isCurrent === true,
    ended: row.ended ?? null, startedAt: row.startedAt ?? null, reasonCode: row.reasonCode ?? null, outcome: row.outcome ?? null,
    reviewLabel: !row.isCurrent && !row.outcome ? "终审记录不可用" : sessionRuntimeText(row).review,
    hasBrief: Boolean(row.brief), isRepair: allRepairs.some(item => item.runId === row.runId) || isRepairRunId(row.runId),
  });
  return { roundId: round?.roundId ?? null, round: round ? describe(round) : null, rounds: rounds.map(describe),
    review: review && { ...review, summary: summarizeReviewView(review) },
    brief: round?.brief ?? null, latestBriefRoundId: briefRound?.roundId ?? null, repair, repairs: repairRows,
  };
}
