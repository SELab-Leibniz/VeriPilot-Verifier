import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeSlashes } from "./path-utils.mjs";


export const RESULT_SCHEMA_VERSION = "runtime-corrector.result.v1";


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}


function canonicalDigest(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}


export function createInputManifest(artifacts, roles = new Map()) {
  const files = artifacts.map((artifact) => ({
    path: normalizeSlashes(artifact.relativePath),
    role: roles.get(normalizeSlashes(artifact.relativePath)) ?? "context",
    bytes: Buffer.byteLength(artifact.content, "utf8"),
    sha256: sha256(artifact.content),
  })).sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    digest: canonicalDigest(files),
  };
}


export async function createPolicyManifest(files, cwd) {
  const candidates = files.filter(Boolean).map((file) => (
    typeof file === "string" ? { path: file, label: null } : file
  ));
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const absolutePath = path.resolve(candidate.path);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    unique.push({ absolutePath, label: candidate.label ?? null });
  }
  const entries = [];
  for (const file of unique) {
    try {
      const contents = await fs.readFile(file.absolutePath);
      entries.push({
        path: file.label ?? normalizeSlashes(path.relative(cwd, file.absolutePath)),
        bytes: contents.length,
        sha256: sha256(contents),
      });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: entries,
    digest: canonicalDigest(entries),
  };
}


function diagnosticClassification(diagnostic) {
  if (new Set([
    "AGENT-SEMANTIC-REVIEW-FAILED",
    "RUNTIME-PATCH-VALIDATION-FAILED",
  ]).has(diagnostic.ruleId)) {
    return "CHECKER_FAILURE";
  }
  if (diagnostic.ruleId?.startsWith("GROUND-TRUTH-")) {
    return "GROUND_TRUTH_UNRESOLVED";
  }
  if (diagnostic.ruleId?.startsWith("EXTERNAL-")) {
    return "EXTERNAL_UNAVAILABLE";
  }
  if (diagnostic.severity === "pending") return "UNVERIFIED";
  if (diagnostic.severity === "info") return "PASSED";
  return "DEVIATION";
}


function suggestedAction(classification) {
  return ({
    PASSED: "NONE",
    DEVIATION: "FIX_CURRENT",
    UNVERIFIED: "COLLECT_EVIDENCE",
    GROUND_TRUTH_UNRESOLVED: "ASK_HUMAN",
    EXTERNAL_UNAVAILABLE: "WAIT_EXTERNAL",
    CHECKER_FAILURE: "FIX_CHECKER",
  })[classification];
}


const AGGREGATE_ORDER = [
  "CHECKER_FAILURE",
  "GROUND_TRUTH_UNRESOLVED",
  "EXTERNAL_UNAVAILABLE",
  "DEVIATION",
  "UNVERIFIED",
  "PASSED",
];


export function finalizeResultContract(result) {
  const policyDigest = result.metadata.policyDigest ?? null;
  const assessments = result.diagnostics.map((diagnostic) => {
    const classification = diagnosticClassification(diagnostic);
    const identity = {
      ruleId: diagnostic.ruleId,
      path: diagnostic.path,
      message: diagnostic.message,
      policyDigest,
    };
    const fingerprint = canonicalDigest(identity);
    return {
      assessmentId: `assessment-${fingerprint.slice(0, 16)}`,
      fingerprint,
      classification,
      suggestedAction: suggestedAction(classification),
      ruleId: diagnostic.ruleId,
      severity: diagnostic.severity,
      path: diagnostic.path,
      ...(diagnostic.line ? { line: diagnostic.line } : {}),
      message: diagnostic.message,
      ...(diagnostic.evidence ? { evidence: diagnostic.evidence } : {}),
      ...(diagnostic.suggestion ? { suggestion: diagnostic.suggestion } : {}),
    };
  });
  if (assessments.length === 0) {
    assessments.push({
      assessmentId: "assessment-passed",
      fingerprint: canonicalDigest({
        subject: result.metadata.triggerFile,
        inputDigest: result.metadata.inputDigest ?? null,
        policyDigest,
        classification: "PASSED",
      }),
      classification: "PASSED",
      suggestedAction: "NONE",
      ruleId: "RUNTIME-CORRECTOR-PASSED",
      severity: "info",
      path: result.metadata.triggerFile,
      message: "当前检查范围内的适用规则已有充分证据，未发现偏离。",
    });
  }
  const classifications = new Set(assessments.map((item) => item.classification));
  const classification = AGGREGATE_ORDER.find((item) => classifications.has(item))
    ?? "PASSED";
  result.schemaVersion = RESULT_SCHEMA_VERSION;
  result.classification = classification;
  result.assessments = assessments;
  result.findings = assessments.filter((item) => item.classification !== "PASSED");
  result.suggestedActions = [...new Set(result.findings.map((item) => item.suggestedAction))];
  result.checkerDiagnostics = assessments.filter(
    (item) => item.classification === "CHECKER_FAILURE",
  );
  result.resultDigest = canonicalDigest({
    schemaVersion: result.schemaVersion,
    status: result.status,
    classification,
    inputDigest: result.metadata.inputDigest ?? null,
    policyDigest,
    assessments,
    diffs: result.diffs.map((diff) => ({
      path: diff.path,
      baseHash: diff.baseHash,
      proposedHash: diff.proposedHash,
      unifiedDiff: diff.unifiedDiff,
    })),
    agentReview: result.agentReview
      ? {
          status: result.agentReview.status,
          summary: result.agentReview.summary ?? null,
          findingCount: result.agentReview.findingCount ?? null,
        }
      : null,
  });
  return result;
}
