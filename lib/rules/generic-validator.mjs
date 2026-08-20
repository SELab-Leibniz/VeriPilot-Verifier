import path from "node:path";

import { validateJsonSchema } from "../json-schema-validator.mjs";


export function artifactByBasename(artifacts, basename) {
  const expected = basename.toLowerCase();
  return artifacts.find((artifact) => path.basename(artifact.path).toLowerCase() === expected);
}


function normalizeArtifactReference(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}


export function artifactByReference(artifacts, reference) {
  const expected = normalizeArtifactReference(reference);
  if (!expected.includes("/")) return artifactByBasename(artifacts, expected);
  return artifacts.find((artifact) => {
    const candidates = [artifact.relativePath, artifact.path]
      .filter((candidate) => typeof candidate === "string")
      .map(normalizeArtifactReference);
    return candidates.includes(expected);
  });
}


export function issue(rule, artifact, message, evidence = [], suggestion) {
  return {
    ruleId: rule.id,
    severity: rule.severity ?? "error",
    path: artifact.relativePath,
    message,
    ...(evidence.length ? { evidence } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}


export function parseJsonArtifact(artifact, rule, diagnostics) {
  try {
    const value = JSON.parse(artifact.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      diagnostics.push(issue(
        { ...rule, id: `${rule.id}-JSON-OBJECT` },
        artifact,
        "JSON 顶层必须是对象。",
        [],
        "把顶层值改为符合对应 schema 的 JSON 对象。",
      ));
      return null;
    }
    return value;
  } catch (error) {
    diagnostics.push(issue(
      { ...rule, id: `${rule.id}-JSON-SYNTAX` },
      artifact,
      `JSON 无法解析：${error.message}`,
      [],
      "修复 JSON 语法后重新运行纠偏。",
    ));
    return null;
  }
}


export function diagnoseRequiredArtifacts(artifacts, rule) {
  const diagnostics = [];
  const trigger = artifacts.find((artifact) => artifact.isTrigger) ?? artifacts[0];
  for (const name of rule.artifacts) {
    if (!artifactByReference(artifacts, name)) diagnostics.push(issue(
      { ...rule, severity: rule.pendingUntilComplete ? "pending" : rule.severity },
      trigger,
      `当前纠偏 bundle 尚未齐备，等待 ${name}。`,
      [],
      `继续生成 ${name}；现有 bundle 快照仍会接受语义审阅并保存诊断与候选 Diff。`,
    ));
  }
  return diagnostics;
}


export function diagnoseJsonSchemaRule(artifacts, rule) {
  const diagnostics = [];
  const artifact = artifactByBasename(artifacts, rule.artifact);
  if (!artifact) return diagnostics;
  const document = parseJsonArtifact(artifact, rule, diagnostics);
  if (!document) return diagnostics;
  for (const error of validateJsonSchema(document, rule.schema)) {
    diagnostics.push({
      ruleId: rule.id,
      severity: rule.severity ?? "error",
      path: artifact.relativePath,
      section: error.pointer,
      message: `${error.message}（JSON Pointer: ${error.pointer}）`,
      evidence: [`schema=${rule.schemaPath}`, `keyword=${error.keyword}`],
      suggestion: rule.suggestion ?? `按 ${rule.schemaPath} 修正字段；不要读取插件实现代码猜测结构。`,
    });
  }
  return diagnostics;
}
