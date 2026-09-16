import { promises as fs } from "node:fs";
import path from "node:path";
import { taskDirectory } from "../runtime-v2/task-store.mjs";
import { readJson } from "../runtime-v2/utils.mjs";
import { controllerDirectory } from "./controller-store.mjs";
import { interactionSnapshot } from "./interaction-store.mjs";
import { fingerprint, matchesEvidence } from "./evidence.mjs";
import { listNativeRuns } from "./native-runs.mjs";

export async function readReport(binding) {
  const snapshot = await interactionSnapshot(binding);
  const { task, controller } = snapshot;
  if (!task) return { capturedAt: snapshot.capturedAt, status: "NO_TASK", text: "当前会话尚无纠偏任务记录。", files: [] };
  const directory = taskDirectory(binding.workspaceDir, task.taskId);
  const committed = task.projectionPending && task.decisionCommitId
    ? await readJson(path.join(directory, "transactions", `${task.decisionCommitId}.json`)) : null;
  if (task.projectionPending && !committed) throw new Error("Committed decision manifest missing; current evidence is unavailable.");
  let entries = [];
  try { entries = (await fs.readFile(path.join(directory, "journal/events.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
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
  const verified = task.status === "COMPLETED" && task.verification?.status === "PASS" && evidenceCurrent
    && task.verification.requirementVersion === task.groundTruth.version && task.verification.requirementDigest === task.groundTruth.digest
    && task.verification.rulesDigest && task.verification.assessmentId
    && task.verification.generation === task.control?.generation && task.verification.cancelEpoch === task.control?.cancelEpoch
    && !task.control?.cancelled && !task.control?.pendingRequirement;
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
    verification: verified ? "PASS" : task.verification?.status === "PASS" ? "STALE" : task.verification?.status ?? "UNVERIFIED",
    requirementVersion: task.groundTruth.version, epoch: task.correctionEpoch.id, guard: {
      generation: task.control?.generation ?? null, requirementVersion: task.groundTruth.version, cancelEpoch: task.control?.cancelEpoch ?? 0 },
    phase: task.control?.cancelled ? (["STOPPING", "STOPPED"].includes(task.status) ? task.status : "CANCELLED")
      : progress?.phase ?? (task.pendingCorrection?.status === "AWAITING_AUTHORIZATION" ? "AWAITING_CORRECTION"
      : controller?.generation === task.control?.generation ? controller?.phase : task.status) ?? "UNKNOWN", progress,
    waitingSince: active ? progress?.startedAt ?? controller?.updatedAt ?? null : null,
    budget: { correctionsUsed: task.stop.correctionAttempts, maximum: task.control?.maxCorrections ?? null,
      infrastructureConsecutiveFailures: task.stop.infrastructureFailures ?? 0,
      infrastructureTotalFailures: task.stop.infrastructureTotalFailures ?? 0 },
    delivery: task.delivery ?? null, files: perFile, findings: families, assessment,
    pauseReason: verified ? null : currentController?.failureExplanation ?? task.verification?.reason ?? currentController?.failureCode ?? null,
    correctionBudgetExhausted: !verified && currentController?.decision?.correctionBudgetExhausted === true,
    waitingQuestion: !verified ? currentController?.waitingQuestion ?? null : null,
    detectionCoverage: task.faultInjection?.coverage ?? "UNVERIFIED",
    correctionLoop: task.faultInjection?.closedLoop ?? "UNVERIFIED",
    evidenceCurrent, commandReceipts: Object.values(task.control?.commands ?? {}).map(({ key, commandId, actionId, action, status,
      receivedAt, updatedAt, windowId, deadlineAt, reason }) => ({ key, commandId, actionId, action, status, receivedAt, updatedAt, windowId, deadlineAt, reason })) };
  report.text = renderReport(report);
  return report;
}
export function renderReport(report) {
  const incompleteFiles = report.files.some((file) => file.status !== "PASS");
  const lines = [`任务 ${report.taskId}：${report.verification === "PASS"
    ? (incompleteFiles ? "当前任务要求已通过核心验收；逐文件质量仍有未通过或未验证，不能宣布全部成果合格" : "当前成果验收通过")
    : "成果尚未验证，尚不能宣布全部完成"}。`,
    `阶段：${report.phase}；需求版本：${report.requirementVersion}。`,
    `内容修正：${report.budget.correctionsUsed}/${report.budget.maximum ?? "未验证"}；连续评审故障：${report.budget.infrastructureConsecutiveFailures}。`];
  if (report.correctionBudgetExhausted) lines.push("纠偏次数已用尽，成果仍未通过验收。");
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
