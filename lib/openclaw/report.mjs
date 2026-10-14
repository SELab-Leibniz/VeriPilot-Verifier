import { promises as fs } from "node:fs";
import path from "node:path";
import { taskDirectory } from "../runtime-v2/task-store.mjs";
import { FileTransactionJournal } from "../runtime-v2/transaction-journal.mjs";
import { readJson } from "../runtime-v2/utils.mjs";
import { controllerDirectory } from "./controller-store.mjs";
import { interactionSnapshot } from "./interaction-store.mjs";
import { fingerprint, matchesEvidence } from "./evidence.mjs";
import { listNativeRuns } from "./native-runs.mjs";

// Display retained observations only; never use them to grant completion or
// close a deviation family. Identity, requirement version and current source
// bytes must all still match before an earlier assessment can be shown.
async function retainedAssessmentObservations(directory, task, committed) {
  const population = await readJson(path.join(directory, "metrics/population.json"));
  if (population?.groundTruthVersion !== task.groundTruth.version) return { observations: [], partialProgress: null };
  const expected = new Map(Object.values(population.metrics ?? {}).flatMap(items => items.map(item => [item.objectId, item])));
  let names = [];
  try { names = await fs.readdir(path.join(directory, "evaluations")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const projected = Object.keys(committed?.files ?? {}).filter(name => name.startsWith(`evaluations${path.sep}`));
  names = [...new Set([...names, ...projected.map(name => path.basename(name))])]
    .filter(name => name.startsWith("stop-") && name.endsWith(".json")).sort().reverse().slice(0, 32);
  const seen = new Set(), retained = [], hashes = new Map();
  let partialProgress = null, completeSeen = false;
  for (const name of names) {
    const pending = committed?.files?.[path.join("evaluations", name)];
    const assessment = pending ? JSON.parse(pending) : await readJson(path.join(directory, "evaluations", name));
    const partial = assessment?.partialReview;
    const report = assessment?.metricReport ?? (partial?.requirementVersion === task.groundTruth.version ? {
      groundTruthVersion: partial.requirementVersion, status: "PARTIAL",
      metrics: [{ objects: (partial.metricObjectJudgements ?? []).map(item => ({ ...item,
        sourceId: expected.get(item.objectId)?.sourceId })) }],
    } : null);
    if (report?.groundTruthVersion !== task.groundTruth.version) continue;
    completeSeen ||= report.status === "PASS";
    const countPartial = Boolean(partial && !partialProgress && !completeSeen);
    const checked = new Set();
    for (const object of (report.metrics ?? []).flatMap(metric => metric.objects ?? [])) {
      if (!expected.has(object.objectId) || !["PASS", "DEVIATION", "UNVERIFIED", "BASIS_PENDING", "EXTERNAL_BLOCKED",
        "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "CHECKER_ERROR"].includes(object.judgement)) continue;
      const citations = (assessment.sourceCitations ?? partial?.citations ?? []).filter(citation => citation.usedBy?.includes(object.objectId));
      if (!citations.length) continue;
      let current = true;
      for (const citation of citations) {
        if (!hashes.has(citation.path)) hashes.set(citation.path, await fingerprint(citation.path));
        if (hashes.get(citation.path) !== citation.contentHash) { current = false; break; }
      }
      if (!current) continue;
      if (countPartial) checked.add(object.objectId);
      if (seen.has(object.objectId) || !["PASS", "DEVIATION"].includes(object.judgement)
        || (object.judgement === "PASS" && report.status !== "PASS")) continue;
      seen.add(object.objectId);
      if (object.judgement === "DEVIATION") retained.push({ objectId: object.objectId, sourceId: object.sourceId,
        reason: object.reason, evaluationId: assessment.evaluationId, requirementVersion: report.groundTruthVersion,
        refs: [...new Set(citations.map(citation => `${citation.path}#L${citation.start}-L${citation.end}`))] });
    }
    if (countPartial) partialProgress = { evaluationId: assessment.evaluationId,
      saved: checked.size, total: expected.size, missing: expected.size - checked.size };
  }
  const groups = new Map();
  for (const item of retained) {
    const key = item.sourceId ?? item.objectId, group = groups.get(key);
    if (group) { group.objectIds.push(item.objectId); group.refs = [...new Set([...group.refs, ...item.refs])]; }
    else groups.set(key, { ...item, objectIds: [item.objectId] });
  }
  return { observations: [...groups.values()], partialProgress };
}

export async function readReport(binding) {
  const snapshot = await interactionSnapshot(binding);
  const { task, controller } = snapshot;
  if (!task) return { capturedAt: snapshot.capturedAt, status: "NO_TASK", text: "当前会话尚无纠偏任务记录。",
    summary: "当前会话尚无纠偏任务记录。", files: [] };
  const directory = taskDirectory(binding.workspaceDir, task.taskId);
  const committed = task.projectionPending && task.decisionCommitId
    ? task.decisionSequence != null ? await new FileTransactionJournal(directory).effects(task.decisionSequence)
      : await readJson(path.join(directory, "transactions", `${task.decisionCommitId}.json`)) : null;
  if (task.projectionPending && !committed) throw new Error("Committed decision manifest missing; current evidence is unavailable.");
  let entries = [];
  try {
    const contents = await fs.readFile(path.join(directory, "journal/events.jsonl"), "utf8");
    entries = contents.slice(0, contents.lastIndexOf("\n") + 1).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const event of committed?.events ?? []) {
    if (event.file === path.join("journal", "events.jsonl") && !entries.some(entry => entry.eventId === event.value.eventId)) entries.push(event.value);
  }
  const evaluationId = task.verification?.evaluationId ?? task.stop?.lastAssessmentId;
  let assessment = null;
  if (evaluationId) {
    let names = [];
    try { names = await fs.readdir(path.join(directory, "evaluations")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const projected = Object.keys(committed?.files ?? {}).find(name => name.startsWith(`evaluations${path.sep}`) && name.includes(evaluationId));
    const name = names.find((name) => name.includes(evaluationId));
    if (projected) assessment = JSON.parse(committed.files[projected]);
    else if (name) assessment = await readJson(path.join(directory, "evaluations", name));
  }
  const { observations: retainedObservations, partialProgress } = await retainedAssessmentObservations(directory, task, committed);
  const families = Object.values(task.deviations ?? {});
  const previousEvaluations = new Map();
  for (const family of families) for (const observation of family.observations ?? []) {
    if (observation.finding?.targetFiles || !/^[\w-]+$/u.test(observation.evaluationId ?? "")) continue;
    if (!previousEvaluations.has(observation.evaluationId)) previousEvaluations.set(observation.evaluationId,
      await readJson(path.join(directory, "evaluations", `${observation.evaluationId}.json`)));
    const source = previousEvaluations.get(observation.evaluationId)?.review?.findings?.filter(finding => finding.deviationKey === observation.finding?.deviationKey) ?? [];
    // Older core normalization dropped targets; recover only the exact saved
    // assessment identity, never infer defect ownership from matching prose.
    if (source.length === 1 && source[0].targetFiles) observation.finding.targetFiles = source[0].targetFiles;
  }
  const changes = entries.filter((entry) => entry.type === "OPENCLAW_FILE_CHANGED");
  const deliveries = entries.filter((entry) => entry.type === "OPENCLAW_FEEDBACK_DELIVERED");
  const artifactReviews = entries.filter((entry) => entry.type === "OPENCLAW_ARTIFACT_REVIEW");
  const files = new Set([...(task.verification?.evidence?.files ?? []), ...changes.map((entry) => entry.file)]);
  const resolveTarget = (file) => {
    const absolute = path.resolve(binding.workspaceDir, file);
    if (files.has(absolute)) return absolute;
    if (file === path.basename(file)) {
      const matches = [...files].filter(candidate => path.basename(candidate) === file);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    return absolute;
  };
  for (const family of families) for (const observation of family.observations ?? []) {
    const finding = observation.finding ?? {};
    for (const file of [finding.path, finding.filePath, finding.targetPath, ...(finding.targetFiles ?? [])]) if (typeof file === "string" && resolveTarget(file)) files.add(resolveTarget(file));
  }
  const evidenceCurrent = await matchesEvidence(task.verification?.evidence);
  const qualified = task.verification?.status === "PASS" && evidenceCurrent
    && task.verification.requirementVersion === task.groundTruth.version && task.verification.requirementDigest === task.groundTruth.digest
    && task.verification.rulesDigest && task.verification.assessmentId
    && task.verification.generation === task.control?.generation && task.verification.cancelEpoch === task.control?.cancelEpoch
    && !task.control?.cancelled && !task.control?.pendingRequirement;
  const verified = task.status === "COMPLETED" && qualified;
  const stageVerified = task.status === "ACTIVE" && qualified && assessment?.review?.stopClassification === "STAGE_COMPLETE";
  const perFile = await Promise.all([...files].filter((file) => !path.relative(binding.workspaceDir, file).split(path.sep).includes(".runtime-corrector")).map(async (file) => {
    const relative = path.relative(binding.workspaceDir, file);
    const findings = families.filter((family) => (family.observations ?? []).some(({ finding = {} }) => {
      const targets = [finding.path, finding.filePath, finding.targetPath, ...(finding.targetFiles ?? [])].filter(value => typeof value === "string");
      return targets.length ? targets.some(target => resolveTarget(target) === file) : JSON.stringify(finding).includes(relative);
    }));
    const modifications = changes.filter((entry) => entry.file === file);
    const fileDeliveries = deliveries.filter((entry) => entry.file === file);
    const reviews = artifactReviews.filter((entry) => entry.file === file);
    const latest = reviews.at(-1);
    const currentHash = await fingerprint(file);
    const reviewCurrent = latest?.fingerprint === currentHash && latest?.requirementVersion === task.groundTruth.version
      && await matchesEvidence(latest?.evidence);
    const finalFiles = (assessment?.review?.fileAssessments ?? []).filter(item => resolveTarget(item.path) === file);
    const finalFile = verified && finalFiles.length === 1 && task.verification.evidence.fingerprints[file]
      && finalFiles[0].evidence?.length ? finalFiles[0] : null;
    const artifactProblems = reviewCurrent ? latest.result?.diagnostics ?? [] : [];
    const artifactFailed = finalFile ? finalFile.status === "DEVIATION" : reviewCurrent && latest.result?.status === "failed";
    const resolved = reviewCurrent && latest.result?.status === "passed"
      ? reviews.slice(0, -1).flatMap((entry) => (entry.result?.diagnostics ?? []).map((finding) => ({ finding,
        detectedBy: entry.toolCallId, verifiedBy: latest.toolCallId, fingerprint: latest.fingerprint }))) : [];
    // Global pass or a critic detecting an injected issue is not evidence that
    // this particular document met every requirement.
    const governedArtifact = reviews.length > 0 || fileDeliveries.length > 0;
    const fileVerdict = verified && (finalFile ? finalFile.status === "PASS" : !governedArtifact || reviewCurrent && latest.result?.status === "passed")
      && findings.every((family) => family.status !== "OPEN") ? "PASS" : "UNVERIFIED";
    return { file: relative, status: artifactFailed || findings.some((family) => family.status === "OPEN") ? "DEVIATION" : fileVerdict,
      findings, artifactProblems, finalAssessment: finalFile, reviews, feedbackDelivered: fileDeliveries, modifications,
      verifiedFixes: [...findings.filter((family) => family.status === "FIXED" && family.fixedAt), ...resolved], snapshots: entries.filter((entry) => entry.type === "OPENCLAW_ARTIFACT_SNAPSHOT" && entry.file === file),
      retained: currentHash !== "missing" };
  }));
  const manualProgress = task.control?.activeWindow ? await readJson(path.join(controllerDirectory(binding.workspaceDir, binding.sessionId), "manual-progress.json")) : null;
  const active = task.control?.activeWindow || task.control?.ownerActive;
  const currentController = controller?.generation === task.control?.generation ? controller : null;
  const nativeRuns = await listNativeRuns(binding.workspaceDir, task.taskId);
  const progress = active ? (manualProgress && manualProgress.windowId === task.control?.activeWindow ? manualProgress : controller?.progress ?? null) : null;
  const report = { taskId: task.taskId, capturedAt: snapshot.capturedAt, status: task.status,
    unsettledRuns: nativeRuns.filter(run => run.status !== "SETTLED"),
    reviewActivity: { nativeCalls: nativeRuns.length, formatRepairs: nativeRuns.filter(run => run.phase?.endsWith("-repair")).length,
      currentPhase: progress?.attemptPhase ?? null, executionRound: active ? controller?.round ?? null : null },
    stageVerified, verification: verified ? "PASS" : stageVerified ? "UNVERIFIED" : task.verification?.status === "PASS" ? "STALE" : task.verification?.status ?? "UNVERIFIED",
    requirementVersion: task.groundTruth.version, epoch: task.correctionEpoch.id, guard: {
      generation: task.control?.generation ?? null, requirementVersion: task.groundTruth.version, cancelEpoch: task.control?.cancelEpoch ?? 0 },
    phase: task.control?.cancelled ? (["STOPPING", "STOPPED"].includes(task.status) ? task.status : "CANCELLED")
      : progress?.phase ?? (task.pendingCorrection?.status === "AWAITING_AUTHORIZATION" ? "AWAITING_CORRECTION"
      : controller?.generation === task.control?.generation ? controller?.phase : task.status) ?? "UNKNOWN", progress,
    waitingSince: active ? progress?.startedAt ?? controller?.updatedAt ?? null : null,
    budget: { correctionsUsed: task.stop.correctionAttempts, maximum: task.control?.maxCorrections ?? null,
      infrastructureConsecutiveFailures: task.stop.infrastructureFailures ?? 0,
      infrastructureTotalFailures: task.stop.infrastructureTotalFailures ?? 0 },
    delivery: task.delivery ?? null, files: perFile, findings: families, assessment, retainedObservations, partialProgress,
    failureCode: currentController?.failureCode ?? task.verification?.reason ?? null,
    pauseReason: verified ? null : currentController?.failureExplanation ?? task.verification?.reason ?? currentController?.failureCode ?? null,
    correctionBudgetExhausted: !verified && (currentController?.decision?.correctionBudgetExhausted === true
      || task.verification?.correctionBudgetExhausted === true),
    waitingQuestion: !verified ? currentController?.waitingQuestion ?? null : null,
    detectionCoverage: task.faultInjection?.coverage ?? "UNVERIFIED",
    correctionLoop: task.faultInjection?.closedLoop ?? "UNVERIFIED",
    evidenceCurrent, commandReceipts: Object.values(task.control?.commands ?? {}).map(({ key, commandId, actionId, action, status,
      receivedAt, updatedAt, windowId, deadlineAt, reason }) => ({ key, commandId, actionId, action, status, receivedAt, updatedAt, windowId, deadlineAt, reason })) };
  report.text = renderReport(report);
  report.summary = renderSummary(report);
  return report;
}

function summaryText(value, maximum = 140) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function findingReason(finding) {
  return finding?.reason ?? finding?.summary ?? finding?.description ?? finding?.message;
}

function fileSummary(file) {
  if (file.retained === false) return ["文件缺失", "需恢复文件后重新验收"];
  if (file.status === "PASS") return ["已通过", file.verifiedFixes?.length
    ? "此前问题已修正，并经复验确认" : file.finalAssessment?.reason ?? "当前内容已通过验收"];
  if (file.status === "DEVIATION") return ["未通过", file.finalAssessment?.reason
    ?? findingReason(file.artifactProblems?.[0])
    ?? findingReason(file.findings?.find(family => family.status === "OPEN")?.observations?.at(-1)?.finding)
    ?? "存在未解决问题，详见反馈"];
  return ["未验证", "缺少针对当前内容的有效验收证据"];
}

const SUMMARY_FAILURE_REASONS = {
  RUN_BUDGET_EXHAUSTED: "本次执行与评审达到总运行时限，自动执行已停止。",
  SUPERVISED_RUN_BUDGET_EXHAUSTED: "本次执行与评审达到总运行时限，自动执行已停止。",
  EVIDENCE_CHANGED: "成果在验收期间或交付前发生变化，验收证据已失效。",
  MODEL_SERVICE_OVERLOADED: "执行模型服务暂时过载，本轮未能继续。",
  MODEL_RATE_LIMITED: "执行模型接口触发限流，本轮未能继续。",
  OPENCLAW_REVIEWER_CONFIG: "当前项目的评审配置不可用，本次尚未启动工作执行。",
  NATIVE_RUN_UNSETTLED: "原生执行尚未确认结束，请先核对现有成果。",
};

// Compose from persisted verdicts only: no extra reviewer call and no inference
// that delivered feedback, file edits or a global PASS prove a particular fix.
export function renderSummary(report) {
  if (report.status === "NO_TASK") return "当前会话尚无纠偏任务记录。";
  const files = report.files ?? [];
  const incompleteFiles = files.some(file => file.status !== "PASS" || file.retained === false);
  const stopped = ["STOPPING", "CANCELLED"].includes(report.phase)
    || ["STOPPING", "STOPPED", "CANCELLED"].includes(report.status);
  const openFindings = (report.findings ?? []).some(family => family.status === "OPEN");
  const failed = report.verification === "DEVIATION" || openFindings
    || files.some(file => file.status === "DEVIATION" || file.retained === false);
  const passed = report.verification === "PASS" && !incompleteFiles && !openFindings && !stopped
    && !report.waitingQuestion && !report.correctionBudgetExhausted;
  const stale = report.verification === "STALE";
  const title = stopped ? "自动执行已停止，当前成果尚未验证。"
    : report.waitingQuestion ? "需要你作出决定，自动执行已暂停。"
    : report.correctionBudgetExhausted ? "纠偏已结束，成果尚未全部通过验收。"
    : report.stageVerified ? "当前阶段验收通过，任务整体验收尚未完成。"
    : stale ? "验收结论已失效，当前成果需要重新验收。"
    : passed ? (files.length ? "验收通过，本次成果符合当前任务要求。" : "当前任务要求验收通过。")
    : report.verification === "PASS" || report.verification === "DEVIATION" ? "成果尚未全部通过验收。"
    : "最终验收未完成，成果尚未验证。";
  const lines = [`**${report.phase === "STOPPING" || report.status === "STOPPING"
    ? "正在停止自动执行，成果尚未验证。" : title}**`];
  const { correctionsUsed, maximum } = report.budget ?? {};
  if (Number.isFinite(correctionsUsed)) lines.push("", `纠偏额度${report.correctionBudgetExhausted ? "已用尽" : "使用"}：${correctionsUsed}${Number.isFinite(maximum) ? `/${maximum}` : " 次（上限未记录）"}。`);
  if (report.waitingQuestion) lines.push("", `待确认：${summaryText(report.waitingQuestion, 300)}`);
  else if (report.verification === "PASS" && incompleteFiles) lines.push("", "任务要求已通过核心验收，但逐文件质量仍有未通过或未验证。");
  else if (report.verification === "PASS" && openFindings) lines.push("", "任务要求已通过核心验收，但仍有未解决的问题需要处理。");
  else if (!passed && !report.correctionBudgetExhausted) {
    const reason = SUMMARY_FAILURE_REASONS[report.failureCode] ?? report.pauseReason;
    if (reason && !/^[A-Z][A-Z0-9_]+$/u.test(reason)) lines.push("", `原因：${summaryText(reason)}`);
  }
  // Put failed/missing files first. Bound both the number of rows and the prose
  // so large tasks cannot turn the final reply into another diagnostic dump.
  const priority = file => file.retained === false || file.status === "DEVIATION" ? 0 : file.status === "PASS" ? 2 : 1;
  const shown = [...files].sort((a, b) => priority(a) - priority(b)).slice(0, 3);
  const cell = value => summaryText(value).replaceAll("|", "\\|").replaceAll("`", "\\`").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (shown.length) {
    lines.push("", "| 文件 | 验收结果 | 说明 |", "| --- | --- | --- |");
    for (const file of shown) {
      const [status, reason] = fileSummary(file);
      lines.push(`| ${cell(file.file)} | ${status} | ${cell(reason)} |`);
    }
    if (files.length > shown.length) lines.push("", `另有 ${files.length - shown.length} 份文件，详见完整反馈。`);
  } else lines.push("", "尚无完整文件证据，无法逐文件确认成果质量。");
  const taskFindings = (report.findings ?? []).filter(family => family.status === "OPEN"
    && !files.some(file => file.findings?.some(item => item.familyId === family.familyId)));
  const reasons = [...new Set(taskFindings.map(family => summaryText(findingReason(family.observations?.at(-1)?.finding))).filter(Boolean))];
  const remaining = Math.max(0, 3 - shown.filter(file => file.status !== "PASS" || file.retained === false).length);
  if (reasons.length && remaining) lines.push("", "需要处理：", ...reasons.slice(0, remaining).map(reason => `- ${reason}`));
  if (reasons.length > remaining) lines.push("", "其他未解决问题详见完整反馈。");
  if (["SEND_COMMITTED", "UNKNOWN"].includes(report.delivery?.status)) lines.push("", "上一条消息发送在途或结果未知；请先核对交付回执，不自动重发。");
  else if (report.waitingQuestion) lines.push("", "**下一步：**请确认上述问题后继续。");
  else if (!passed) lines.push("", `**下一步：**${stopped || stale || !failed
    ? "建议对当前成果重新验收。" : "请修正剩余问题，再重新验收。"}`);
  if (report.partialProgress?.saved) lines.push("", `部分评审已保存 ${report.partialProgress.saved}/${report.partialProgress.total} 项有当前依据的结果；另有 ${report.partialProgress.missing} 项没有有效结果。整体验收仍以当前状态为准。`);
  if (report.retainedObservations?.length) {
    lines.push("", "已有依据支持的偏离（整体验收仍以当前状态为准）：");
    for (const item of report.retainedObservations.slice(0, 3)) lines.push(
      `- ${summaryText(item.reason, 240)}\n  依据位置：${item.refs.join("; ")}`);
    if (report.retainedObservations.length > 3) lines.push("其他有效偏离见完整反馈。");
  }
  if (report.unsettledRuns?.length && ["STOPPING", "STOPPED", "CANCELLED", "STOPPED_UNVERIFIED"].includes(report.status)) {
    lines.push("", `仍有 ${report.unsettledRuns.length} 个评审运行尚未确认结束，不能确认所有调用已经退出。`);
  }
  lines.push("", "完整问题、修改记录和验收证据可通过“查看反馈”查看。");
  return lines.join("\n");
}

export function renderReport(report) {
  const incompleteFiles = report.files.some((file) => file.status !== "PASS");
  const lines = [`任务 ${report.taskId}：${report.verification === "PASS"
    ? (incompleteFiles ? "当前任务要求已通过核心验收；逐文件质量仍有未通过或未验证，不能宣布全部成果合格" : "当前成果验收通过")
    : "成果尚未验证，尚不能宣布全部完成"}。`,
    `阶段：${report.phase}；需求版本：${report.requirementVersion}。`,
    `内容修正：${report.budget.correctionsUsed}/${report.budget.maximum ?? "未验证"}；连续评审故障：${report.budget.infrastructureConsecutiveFailures}。`];
  if (report.stageVerified) lines.push("当前阶段验收通过；任务整体仍未完成终审。");
  if (report.correctionBudgetExhausted) lines.push("纠偏次数已用尽，成果仍未通过验收。");
  if (report.partialProgress?.saved) lines.push(`部分评审：已保存 ${report.partialProgress.saved}/${report.partialProgress.total} 项有当前依据的结果；${report.partialProgress.missing} 项没有有效结果；不代表整体验收通过。`);
  for (const item of report.retainedObservations ?? []) lines.push(
    `已有偏离（${item.objectIds.join(", ")}）：${summaryText(item.reason, 400)}\n依据位置：${item.refs.join("; ")}`);
  if (report.waitingQuestion) lines.push(`需要用户决定，自动执行已暂停。待确认问题：${report.waitingQuestion}`);
  for (const file of report.files) {
    lines.push(`${file.file}：${file.retained === null ? "保留情况未验证" : file.retained ? "文件已保留" : "文件缺失"}；质量 ${file.status}；反馈送达 ${file.feedbackDelivered.length} 次；修改 ${file.modifications.length} 次；复验确认解决 ${file.verifiedFixes.length} 项。`);
    for (const finding of file.artifactProblems ?? []) lines.push(`  ${finding.code ?? finding.ruleId ?? "问题"}：${finding.message ?? finding.reason ?? "见评审记录"}`);
    if (!file.reviews?.length && file.feedbackDelivered.length) {
      const feedback = file.feedbackDelivered.at(-1).feedback ?? "";
      const issues = feedback.split(/\n/u).filter(line => /^- \[(ERROR|WARN)\]/u.test(line));
      lines.push(`  最近反馈（旧记录，当前适用性未验证）：${issues.length ? issues.join("\n") : feedback.split(/\n/u)[0]}`);
    }
  }
  if (!report.files.length) lines.push("已保留成果及逐文件质量：未验证，尚无完整文件证据。");
  for (const family of report.findings) {
    const finding = family.observations?.at(-1)?.finding;
    lines.push(`问题 ${family.familyId}：${finding?.reason ?? finding?.summary ?? finding?.description ?? finding?.message ?? "详见问题记录"}；${family.status}。`);
  }
  lines.push(`验收中断原因：${report.pauseReason ?? (report.verification === "PASS" ? "无" : "未验证，见评审记录")}。`,
    `故障检测覆盖：${report.detectionCoverage}；完整纠偏闭环：${report.correctionLoop}；三份文档质量按上列分别判断。`,
    "可选择：查看反馈、修改要求、停止、仅重新验收；存在有效待修正问题时可授权继续修正。");
  if (["SEND_COMMITTED", "UNKNOWN"].includes(report.delivery?.status)) lines.push("上一条消息发送在途或结果未知；先核对回执，不自动重发。");
  if (report.unsettledRuns?.length && ["STOPPING", "STOPPED", "CANCELLED", "STOPPED_UNVERIFIED"].includes(report.status)) {
    lines.push(`仍有 ${report.unsettledRuns.length} 个原生评审运行尚未确认结束；取消已阻止后续提交，不能承诺所有调用已经退出。`);
  }
  return lines.join("\n");
}
