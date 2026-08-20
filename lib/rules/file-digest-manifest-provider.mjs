import { createHash } from "node:crypto";

import { valueAtJsonPointer } from "../json-pointer.mjs";
import {
  artifactByReference,
  issue,
  parseJsonArtifact,
} from "./generic-validator.mjs";


function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value;
}


function manifestIssue(rule, artifact, section, message, evidence = [], suggestion) {
  return {
    ...issue(rule, artifact, message, evidence, suggestion),
    ...(section ? { section } : {}),
  };
}


function normalizeManifestPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/");
}


function evaluateFileDigestManifest(rule, { artifacts }) {
  const diagnostics = [];
  const manifest = artifactByReference(artifacts, rule.artifact);
  if (!manifest) return diagnostics;

  const document = parseJsonArtifact(manifest, rule, diagnostics);
  if (!document) return diagnostics;
  const entries = valueAtJsonPointer(document, rule.entriesPointer);
  if (!Array.isArray(entries)) {
    diagnostics.push(manifestIssue(
      rule,
      manifest,
      rule.entriesPointer,
      `${rule.entriesPointer} 必须是文件摘要条目数组。`,
      [],
      "把当前 revision 的文件路径与 SHA-256 摘要写入数组后重新检查。",
    ));
    return diagnostics;
  }

  const seenPaths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryPointer = `${rule.entriesPointer}/${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(manifestIssue(
        rule,
        manifest,
        entryPointer,
        "文件摘要条目必须是对象。",
      ));
      continue;
    }

    const configuredPath = entry[rule.pathField];
    const configuredDigest = entry[rule.digestField];
    const relativePath = normalizeManifestPath(configuredPath);
    if (typeof configuredPath !== "string" || relativePath.length === 0) {
      diagnostics.push(manifestIssue(
        rule,
        manifest,
        `${entryPointer}/${rule.pathField}`,
        `文件摘要条目缺少非空 ${rule.pathField}。`,
      ));
      continue;
    }
    if (seenPaths.has(relativePath.toLocaleLowerCase())) {
      diagnostics.push(manifestIssue(
        rule,
        manifest,
        `${entryPointer}/${rule.pathField}`,
        `文件摘要清单重复引用 ${relativePath}。`,
      ));
      continue;
    }
    seenPaths.add(relativePath.toLocaleLowerCase());

    if (typeof configuredDigest !== "string" || !/^[a-fA-F0-9]{64}$/.test(configuredDigest)) {
      diagnostics.push(manifestIssue(
        rule,
        manifest,
        `${entryPointer}/${rule.digestField}`,
        `${relativePath} 的 ${rule.digestField} 必须是 64 位 SHA-256 十六进制字符串。`,
      ));
      continue;
    }

    const referenced = artifactByReference(artifacts, relativePath);
    if (!referenced) {
      diagnostics.push(manifestIssue(
        rule,
        manifest,
        `${entryPointer}/${rule.pathField}`,
        `无法在当前纠偏快照中读取摘要清单引用的文件 ${relativePath}。`,
        [`manifest=${manifest.relativePath}`],
        "把该文件纳入当前 artifact 的 relatedPatterns，或移除不属于本轮的清单条目。",
      ));
      continue;
    }

    const actualDigest = createHash("sha256")
      .update(referenced.content, "utf8")
      .digest("hex");
    if (actualDigest !== configuredDigest.toLowerCase()) {
      diagnostics.push(manifestIssue(
        rule,
        manifest,
        `${entryPointer}/${rule.digestField}`,
        `${relativePath} 的摘要不属于当前纠偏快照。`,
        [`expected=${configuredDigest.toLowerCase()}`, `actual=${actualDigest}`],
        "使旧证据失效，基于当前文件重新运行测试/构建并生成新的 checkpoint。",
      ));
    }
  }
  return diagnostics;
}


export const FILE_DIGEST_MANIFEST_RULE_DEFINITIONS = [{
  type: "file-digest-manifest",
  compile(rule, { addRule, base, rulesFile }) {
    const artifact = requiredString(
      rule.artifact,
      `${rulesFile} 规则 ${rule.id} 的 artifact`,
    );
    const entriesPointer = requiredString(
      rule.entriesPointer ?? "/sourceManifest",
      `${rulesFile} 规则 ${rule.id} 的 entriesPointer`,
    );
    if (!entriesPointer.startsWith("/")) {
      throw new Error(`${rulesFile} 规则 ${rule.id} 的 entriesPointer 必须是 JSON Pointer。`);
    }
    const algorithm = rule.algorithm ?? "sha256";
    if (algorithm !== "sha256") {
      throw new Error(`${rulesFile} 规则 ${rule.id} 仅支持 algorithm: sha256。`);
    }
    addRule({
      ...base,
      type: "file-digest-manifest",
      scope: "bundle",
      phase: 110,
      artifact,
      entriesPointer,
      pathField: requiredString(
        rule.pathField ?? "path",
        `${rulesFile} 规则 ${rule.id} 的 pathField`,
      ),
      digestField: requiredString(
        rule.digestField ?? "sha256",
        `${rulesFile} 规则 ${rule.id} 的 digestField`,
      ),
      algorithm,
    });
  },
  evaluate: evaluateFileDigestManifest,
}];
