import { statusFromDiagnostics } from "./diagnostic-status.mjs";
import { validateUnifiedDiffs } from "./unified-diff.mjs";
import { normalizeSlashes } from "./path-utils.mjs";


export function mergeSemanticReview(result, review) {
  if (!review) return result;
  if (review.status === "failed") {
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
