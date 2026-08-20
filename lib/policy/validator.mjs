import { promises as fs } from "node:fs";
import path from "node:path";

import { loadDefaultRules } from "../default-runtime.mjs";
import { normalizeSlashes } from "../path-utils.mjs";
import { createPolicyManifest } from "../result-contract.mjs";
import { loadRuntimePlan } from "../runtime-plan.mjs";
import { loadReviewer } from "./reviewer-loader.mjs";


function validationIssue(severity, code, message, subject = null) {
  return {
    severity,
    code,
    message,
    ...(subject ? { subject } : {}),
  };
}


function displayPath(filePath, cwd) {
  return filePath ? normalizeSlashes(path.relative(cwd, filePath)) : null;
}


async function exists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}


export async function validateProjectPolicy({ cwd, pluginRoot } = {}) {
  const resolvedCwd = path.resolve(cwd ?? process.cwd());
  let plan;
  try {
    plan = await loadRuntimePlan({ cwd: resolvedCwd, pluginRoot });
  } catch (error) {
    return {
      schemaVersion: "runtime-corrector.policy-validation.v1",
      status: "invalid",
      valid: false,
      projectRoot: normalizeSlashes(resolvedCwd),
      issues: [validationIssue(
        "error",
        "POLICY-COMPILE-FAILED",
        error instanceof Error ? error.message : String(error),
      )],
    };
  }

  const issues = [];
  if (plan.configSource === "plugin-default" || !plan.configPath) {
    issues.push(validationIssue(
      "error",
      "PROJECT-POLICY-NOT-INITIALIZED",
      "当前项目没有 .runtime-corrector/config.yaml；请先初始化并声明真实 Artifact 后再校验。",
    ));
  }
  const policyFiles = [plan.configPath];
  const matcherOwners = new Map();
  const referencedGroundTruth = new Set();
  for (const artifact of plan.configuredArtifacts) {
    const subject = `artifact:${artifact.nodeId}`;
    for (const matcher of artifact.scanPatterns ?? []) {
      const normalized = normalizeSlashes(matcher).toLowerCase();
      const owner = matcherOwners.get(normalized);
      if (owner && owner !== artifact.nodeId) {
        issues.push(validationIssue(
          "error",
          "ARTIFACT-MATCHER-SHADOWED",
          `Artifact ${artifact.nodeId} 与 ${owner} 声明了相同路径匹配器 ${matcher}；first-match-wins 会遮蔽后者。`,
          subject,
        ));
      } else {
        matcherOwners.set(normalized, artifact.nodeId);
      }
    }
    for (const source of artifact.groundTruthInputs ?? []) {
      referencedGroundTruth.add(source.id);
    }
    if (artifact.rulesPolicy?.enabled) {
      policyFiles.push(artifact.simpleRulesFile);
      try {
        const rules = await loadDefaultRules(artifact.simpleRulesFile);
        for (const rule of rules.rules ?? []) {
          if (rule.schemaPath) policyFiles.push(rule.schemaPath);
        }
      } catch (error) {
        issues.push(validationIssue(
          "error",
          "RULES-LOAD-FAILED",
          error instanceof Error ? error.message : String(error),
          subject,
        ));
      }
    }
    if (artifact.reviewEnabled) {
      policyFiles.push(artifact.reviewerFile);
      try {
        await loadReviewer(artifact.reviewerFile, plan.limits.maxReviewerChars);
      } catch (error) {
        issues.push(validationIssue(
          "error",
          "REVIEWER-LOAD-FAILED",
          error instanceof Error ? error.message : String(error),
          subject,
        ));
      }
    }
    const enabledIncoming = (plan.reviewGraph?.incomingEdges(artifact.nodeId) ?? [])
      .filter((edge) => edge.reviewEnabled);
    if (plan.enabledStages.includes(artifact.stage)
      && !artifact.rulesPolicy?.enabled
      && !artifact.reviewEnabled
      && enabledIncoming.length === 0) {
      issues.push(validationIssue(
        "warning",
        "ARTIFACT-HAS-NO-PROJECT-CHECKS",
        `已启用的 Artifact ${artifact.nodeId} 没有项目规则、节点 Reviewer 或启用的入边 Reviewer；只会执行通用格式基线。`,
        subject,
      ));
    }
  }

  const validatedEdgeReviewers = new Set();
  for (const edge of plan.reviewGraph?.edges ?? []) {
    if (!edge.reviewEnabled || !edge.reviewerFile
      || validatedEdgeReviewers.has(edge.reviewerFile)) continue;
    validatedEdgeReviewers.add(edge.reviewerFile);
    policyFiles.push(edge.reviewerFile);
    try {
      await loadReviewer(edge.reviewerFile, plan.limits.maxReviewerChars);
    } catch (error) {
      issues.push(validationIssue(
        "error",
        "EDGE-REVIEWER-LOAD-FAILED",
        error instanceof Error ? error.message : String(error),
        `edge:${edge.from}->${edge.to}`,
      ));
    }
  }

  for (const source of plan.groundTruthSources ?? []) {
    if (!referencedGroundTruth.has(source.id)) {
      issues.push(validationIssue(
        "warning",
        "GROUND-TRUTH-UNUSED",
        `Ground Truth 来源 ${source.id} 没有被任何 Artifact 引用。`,
        `ground-truth:${source.id}`,
      ));
    }
    if (!source.required) continue;
    const exactPatterns = source.patterns.filter((pattern) => !/[*?]/.test(pattern));
    for (const pattern of exactPatterns) {
      const candidate = path.resolve(resolvedCwd, pattern);
      const relative = path.relative(resolvedCwd, candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        issues.push(validationIssue(
          "error",
          "GROUND-TRUTH-PATH-OUTSIDE-PROJECT",
          `Ground Truth 来源 ${source.id} 的路径必须位于项目内：${pattern}。`,
          `ground-truth:${source.id}`,
        ));
      } else if (!await exists(candidate)) {
        issues.push(validationIssue(
          "error",
          "GROUND-TRUTH-REQUIRED-FILE-MISSING",
          `Ground Truth 来源 ${source.id} 缺少必需文件：${pattern}。`,
          `ground-truth:${source.id}`,
        ));
      }
    }
  }

  const policyManifest = await createPolicyManifest(policyFiles, resolvedCwd);
  const valid = !issues.some((issue) => issue.severity === "error");
  return {
    schemaVersion: "runtime-corrector.policy-validation.v1",
    status: valid ? "valid" : "invalid",
    valid,
    projectRoot: normalizeSlashes(resolvedCwd),
    config: displayPath(plan.configPath, resolvedCwd),
    policyDigest: policyManifest.digest,
    policyFiles: policyManifest.files,
    installedStages: plan.installedStages,
    enabledStages: plan.enabledStages,
    artifacts: plan.configuredArtifacts.map((artifact) => ({
      name: artifact.nodeId,
      stage: artifact.stage,
      enabled: plan.enabledStages.includes(artifact.stage),
      matchers: artifact.scanPatterns,
      groundTruth: (artifact.groundTruthInputs ?? []).map((source) => source.id),
    })),
    groundTruth: (plan.groundTruthSources ?? []).map((source) => ({
      ...source,
      patterns: [...source.patterns],
    })),
    issues,
  };
}
