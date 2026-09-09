import { statusFromDiagnostics } from "./diagnostic-status.mjs";
import { validateUnifiedDiffs } from "./unified-diff.mjs";
import { normalizeSlashes } from "./path-utils.mjs";


export function mergeSemanticReview(result, review) {
  if (!review) return result;
  if (review.status === "failed" && review.semanticStatus !== "completed") {
    const existingKeys = new Set(result.diagnostics.map(
      (item) => `${item.ruleId}\n${item.path}\n${item.line ?? ""}\n${item.message}`,
    ));
    for (const finding of review.findings ?? []) {
      const key = `${finding.ruleId}\n${finding.path}\n${finding.line ?? ""}\n${finding.message}`;
      if (!existingKeys.has(key)) {
        result.diagnostics.push(finding);
        existingKeys.add(key);
      }
    }
    result.diagnostics.push({
      ruleId: "AGENT-SEMANTIC-REVIEW-FAILED",
      severity: "error",
      path: result.metadata.triggerFile,
      message: "隔离语义审阅未能完成。",
      evidence: [review.error],
      suggestion: "保留当前产物不变，检查 Claude session、权限或语义审阅输出后重新触发检查。",
    });
    result.status = "failed";
    result.agentReview = { status: "failed", error: review.error };
    result.metadata.semanticReview = { status: "failed", error: review.error };
    return result;
  }
  const existingKeys = new Set(result.diagnostics.map(
    (item) => `${item.ruleId}\n${item.path}\n${item.line ?? ""}\n${item.message}`,
  ));
  for (const finding of review.findings ?? []) {
    const key = `${finding.ruleId}\n${finding.path}\n${finding.line ?? ""}\n${finding.message}`;
    if (!existingKeys.has(key)) {
      result.diagnostics.push(finding);
      existingKeys.add(key);
    }
  }
  const semanticPaths = new Set((review.diffs ?? []).map((item) => item.path));
  result.diffs = [
    ...(review.diffs ?? []),
    ...result.diffs.filter((item) => !semanticPaths.has(item.path)),
  ];
  result.status = statusFromDiagnostics(result.diagnostics);
  result.agentReview = {
    status: "completed",
    sessionId: review.forkSessionId ?? null,
    summary: review.summary,
    findingCount: review.findings?.length ?? 0,
  };
  result.metadata.semanticReview = {
    status: "completed",
    parentSessionId: review.parentSessionId,
    forkSessionId: review.forkSessionId ?? null,
    findingCount: review.findings?.length ?? 0,
    editTargetCount: review.edits?.length ?? 0,
  };
  if (review.patchStatus === "failed") {
    result.diagnostics.push({
      ruleId: "RUNTIME-PATCH-VALIDATION-FAILED", severity: "error", path: result.metadata.triggerFile,
      message: "语义审阅已完成，但候选编辑未通过补丁校验；未生成该候选补丁。",
      evidence: [review.patchError],
      suggestion: "依据已有诊断修复产物，或按当前文件内容重新生成候选编辑；无需把此错误归因为 API 或审阅权限故障。",
    });
    result.metadata.semanticReview.patchStatus = "failed";
    result.metadata.semanticReview.patchError = review.patchError;
    result.status = "failed";
  }
  return result;
}


export function validateResultDiffs(result, cwd, editableArtifactFiles = null) {
  try {
    const hasEditableWhitelist = editableArtifactFiles !== null;
    if (hasEditableWhitelist) {
      const editable = new Set(
        (Array.isArray(editableArtifactFiles) ? editableArtifactFiles : [])
          .map(normalizeSlashes),
      );
      const forbidden = result.diffs.find((diff) => !editable.has(normalizeSlashes(diff.path)));
      if (forbidden) {
        throw new Error(`候选 Patch 目标不在当前节点可编辑文件中：${forbidden.path}`);
      }
    }
    result.metadata.patchValidation = validateUnifiedDiffs({
      cwd,
      diffs: result.diffs,
      ...(hasEditableWhitelist
        ? { allowedPaths: Array.isArray(editableArtifactFiles) ? editableArtifactFiles : [] }
        : {}),
    });
  } catch (error) {
    result.diffs = [];
    result.diagnostics.push({
      ruleId: "RUNTIME-PATCH-VALIDATION-FAILED",
      severity: "error",
      path: result.metadata.triggerFile,
      message: "候选 Git Patch 未通过最终完整性校验，已禁止落盘。",
      evidence: [error instanceof Error ? error.message : String(error)],
      suggestion: "保留目标产物不变；修复 Patch 生成或序列化问题后重新触发检查。",
    });
    result.status = "failed";
    result.metadata.patchValidation = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
