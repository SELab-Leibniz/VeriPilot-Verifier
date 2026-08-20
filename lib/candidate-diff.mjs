import { promises as fs } from "node:fs";
import path from "node:path";

import {
  createUnifiedDiff,
  validateUnifiedDiffs,
} from "./unified-diff.mjs";
import {
  isPathInside,
  normalizeSlashes,
} from "./path-utils.mjs";


function applyOperations(original, operations) {
  const newline = original.includes("\r\n")
    ? "\r\n"
    : original.includes("\r")
      ? "\r"
      : "\n";
  const normalized = original.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const hasFinalNewline = normalized.endsWith("\n");
  const lines = normalized === ""
    ? []
    : normalized.split("\n").slice(0, hasFinalNewline ? -1 : undefined);
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
    throw new Error("每个 edit.operations 必须包含 1 到 50 个编辑操作。");
  }
  const prepared = operations.map((operation, index) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new Error(`operations[${index}] 必须是对象。`);
    }
    if (!["remove-line", "replace-line", "insert-before", "insert-after"].includes(operation.type)) {
      throw new Error(`operations[${index}].type 不受支持。`);
    }
    if (!Number.isInteger(operation.line) || operation.line < 1 || operation.line > lines.length) {
      throw new Error(`operations[${index}].line 超出目标文件范围。`);
    }
    if (typeof operation.expect !== "string" || lines[operation.line - 1] !== operation.expect) {
      throw new Error(`operations[${index}] 的 expect 与目标文件第 ${operation.line} 行不一致。`);
    }
    const replacement = operation.type === "remove-line"
      ? []
      : Array.isArray(operation.replacement)
        ? operation.replacement
        : typeof operation.replacement === "string"
          ? [operation.replacement]
          : null;
    if (operation.type !== "remove-line"
      && (!replacement || replacement.some((line) => typeof line !== "string" || /[\r\n]/.test(line)))) {
      throw new Error(`operations[${index}].replacement 必须是单行字符串或字符串列表。`);
    }
    return { ...operation, replacement, originalIndex: index };
  });
  const targetedLines = new Set();
  for (const operation of prepared) {
    if (targetedLines.has(operation.line)) {
      throw new Error(
        `同一原始行不能包含多个操作：第 ${operation.line} 行；请合并为一个 replacement 列表。`,
      );
    }
    targetedLines.add(operation.line);
  }
  prepared.sort((left, right) => right.line - left.line || right.originalIndex - left.originalIndex);
  for (const operation of prepared) {
    const offset = operation.line - 1;
    if (operation.type === "remove-line") {
      lines.splice(offset, 1);
    } else if (operation.type === "replace-line") {
      lines.splice(offset, 1, ...operation.replacement);
    } else if (operation.type === "insert-before") {
      lines.splice(offset, 0, ...operation.replacement);
    } else {
      lines.splice(offset + 1, 0, ...operation.replacement);
    }
  }
  const result = lines.join(newline);
  return `${result}${hasFinalNewline ? newline : ""}`;
}


export async function generateCandidateDiffs(options) {
  const {
    cwd,
    artifactFiles,
    editableArtifactFiles,
    edits,
  } = options;
  if (!Array.isArray(edits)) throw new Error("semantic review edits 必须是数组。");
  if (edits.length > 20) throw new Error("semantic review 最多修改 20 个产物。");
  const hasEditableWhitelist = Object.hasOwn(options, "editableArtifactFiles");
  const allowedFiles = hasEditableWhitelist
    ? editableArtifactFiles ?? []
    : artifactFiles ?? [];
  const allowed = new Set(allowedFiles.map(normalizeSlashes));
  const seen = new Set();
  const diffs = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit) || typeof edit.target !== "string") {
      throw new Error("每个 semantic review edit 必须包含 target 和 operations。");
    }
    const target = normalizeSlashes(edit.target);
    if (!allowed.has(target)) {
      const listName = hasEditableWhitelist ? "可编辑产物列表" : "产物列表";
      throw new Error(`edit.target 不在本轮${listName}中：${target}`);
    }
    if (seen.has(target)) throw new Error(`同一目标只能出现一次：${target}`);
    seen.add(target);
    const targetPath = path.resolve(cwd, target);
    if (!isPathInside(cwd, targetPath)) throw new Error(`edit.target 必须位于当前项目内：${target}`);
    const original = await fs.readFile(targetPath, "utf8");
    const proposed = applyOperations(original, edit.operations);
    const diff = createUnifiedDiff({ relativePath: target, original, proposed });
    if (diff) diffs.push(diff);
  }
  validateUnifiedDiffs({ cwd, diffs });
  return diffs;
}
