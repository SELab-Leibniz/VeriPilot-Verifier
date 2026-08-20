import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeSlashes } from "./path-utils.mjs";


const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function assertRelativeArtifactPath(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error("Unified Diff 目标必须是非空的单行项目相对路径。");
  }
  const normalized = normalizeSlashes(value);
  if (path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")) {
    throw new Error(`Unified Diff 目标必须位于当前项目内：${value}`);
  }
  return normalized;
}


function gitPath(prefix, relativePath) {
  const value = `${prefix}/${relativePath}`;
  return /[\s"\\\t]/.test(value) ? JSON.stringify(value) : value;
}


function runGit(args, { cwd } = {}) {
  const completed = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (completed.error) throw completed.error;
  return completed;
}


function withoutFinalLineBreaks(value) {
  return value.replace(/(?:\r?\n)+$/, "");
}


function hasUniformCrLf(value) {
  if (!value.includes("\r\n")) return false;
  return !/[\r\n]/.test(value.replaceAll("\r\n", ""));
}


function restoreCrLfInHunk(hunk, original, proposed) {
  // Some git builds (notably Windows) emit LF-delimited hunk text even when
  // the compared files use CRLF; others (macOS/Linux) preserve the CR bytes in
  // the hunk verbatim. Reattach the CR payload ONLY where it is missing so a
  // plain `git apply` matches the working-tree bytes on every platform —
  // appending unconditionally doubled the CR on platforms that preserve it,
  // which made every CRLF patch fail `git apply --check`.
  const originalCrLf = hasUniformCrLf(original);
  const proposedCrLf = hasUniformCrLf(proposed);
  if (!originalCrLf && !proposedCrLf) return hunk;
  const lines = hunk.split("\n");
  return lines.map((line, index) => {
    if (lines[index + 1] === "\\ No newline at end of file") return line;
    if (line.endsWith("\r")) return line;
    const prefix = line[0];
    const needsCr = prefix === "-"
      ? originalCrLf
      : prefix === "+"
        ? proposedCrLf
        : prefix === " "
          ? originalCrLf && proposedCrLf
          : false;
    return needsCr ? `${line}\r` : line;
  }).join("\n");
}


export function createUnifiedDiff({
  relativePath,
  original,
  proposed,
}) {
  if (typeof original !== "string" || typeof proposed !== "string") {
    throw new Error("Unified Diff 的 original 和 proposed 必须是字符串。");
  }
  if (original === proposed) return null;
  const target = assertRelativeArtifactPath(relativePath);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "runtime-corrector-diff-"));
  try {
    const beforePath = path.join(temporary, "before");
    const afterPath = path.join(temporary, "after");
    writeFileSync(beforePath, original, "utf8");
    writeFileSync(afterPath, proposed, "utf8");
    const diff = runGit([
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-color",
      "--text",
      "--unified=3",
      "--",
      beforePath,
      afterPath,
    ]);
    if (![0, 1].includes(diff.status)) {
      throw new Error(`git diff 失败：${(diff.stderr || diff.stdout).trim()}`);
    }
    if (diff.status === 0) return null;
    const hunkIndex = diff.stdout.search(/^@@ /m);
    if (hunkIndex < 0) throw new Error("git diff 未返回 Unified Diff hunk。");
    const hunk = restoreCrLfInHunk(
      withoutFinalLineBreaks(diff.stdout.slice(hunkIndex)),
      original,
      proposed,
    );
    const unifiedDiff = [
      `diff --git ${gitPath("a", target)} ${gitPath("b", target)}`,
      `--- ${gitPath("a", target)}`,
      `+++ ${gitPath("b", target)}`,
      // Remove line terminators only. A trailing " " is a required blank
      // context-line marker and must survive serialization.
      hunk,
    ].join("\n");
    return {
      path: target,
      format: "git-unified-diff",
      applyMode: "git-apply",
      baseHash: `sha256:${sha256(original)}`,
      proposedHash: `sha256:${sha256(proposed)}`,
      requiresBaseMatch: true,
      unifiedDiff,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}


export function serializeUnifiedDiffs(diffs) {
  if (!Array.isArray(diffs)) throw new Error("候选 Patch 集合必须是数组。");
  if (diffs.length === 0) return "";
  const patches = diffs.map((diff, index) => {
    if (!diff || typeof diff !== "object" || typeof diff.unifiedDiff !== "string") {
      throw new Error(`候选 Patch ${index + 1} 缺少 unifiedDiff。`);
    }
    if (!diff.unifiedDiff.startsWith("diff --git ") || /(?:\r?\n)+$/.test(diff.unifiedDiff)) {
      throw new Error(`候选 Patch ${index + 1} 不是规范化的 Unified Diff。`);
    }
    return diff.unifiedDiff;
  });
  return `${patches.join("\n\n")}\n`;
}


function assertAllowedDiffTargets(diffs, allowedPaths) {
  const allowed = new Set(
    (Array.isArray(allowedPaths) ? allowedPaths : []).map(assertRelativeArtifactPath),
  );
  for (const [index, diff] of diffs.entries()) {
    const target = assertRelativeArtifactPath(diff?.path);
    if (!allowed.has(target)) {
      throw new Error(`候选 Patch 目标不在当前节点可编辑文件中：${target}`);
    }
    const lines = typeof diff.unifiedDiff === "string"
      ? diff.unifiedDiff.split(/\r?\n/)
      : [];
    const expectedHeaders = [
      `diff --git ${gitPath("a", target)} ${gitPath("b", target)}`,
      `--- ${gitPath("a", target)}`,
      `+++ ${gitPath("b", target)}`,
    ];
    const fileHeaderCount = lines.filter((line) => line.startsWith("diff --git ")).length;
    if (fileHeaderCount !== 1
      || expectedHeaders.some((header, headerIndex) => lines[headerIndex] !== header)) {
      throw new Error(`候选 Patch ${index + 1} 的 path 与 Unified Diff 实际目标不一致。`);
    }
  }
  return allowed;
}


function assertGitParsedTargets(stdout, allowed) {
  const records = stdout.split("\0").filter(Boolean);
  if (records.length === 0) {
    throw new Error("无法确认候选 Patch 的实际目标文件。");
  }
  for (const record of records) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error("无法解析候选 Patch 的实际目标文件。");
    }
    const target = assertRelativeArtifactPath(record.slice(secondTab + 1));
    if (!allowed.has(target)) {
      throw new Error(`候选 Patch 实际目标不在当前节点可编辑文件中：${target}`);
    }
  }
}


export function validateUnifiedDiffs(options) {
  const { cwd, diffs } = options;
  const diffTargets = new Set(
    (Array.isArray(diffs) ? diffs : []).map((diff) => assertRelativeArtifactPath(diff?.path)),
  );
  let allowed = diffTargets;
  if (Object.hasOwn(options, "allowedPaths")) {
    allowed = assertAllowedDiffTargets(diffs, options.allowedPaths);
  } else {
    assertAllowedDiffTargets(diffs, [...diffTargets]);
  }
  const patch = serializeUnifiedDiffs(diffs);
  if (!patch) return { status: "empty", bytes: 0, sha256: null };
  const temporary = mkdtempSync(path.join(os.tmpdir(), "runtime-corrector-check-"));
  try {
    const patchPath = path.join(temporary, "candidate.diff");
    const validationRoot = path.join(temporary, "workspace");
    mkdirSync(validationRoot, { recursive: true });
    for (const target of diffTargets) {
      const sourcePath = path.resolve(cwd, target);
      const stagedPath = path.resolve(validationRoot, target);
      const stagedRelative = normalizeSlashes(path.relative(validationRoot, stagedPath));
      if (stagedRelative === ".." || stagedRelative.startsWith("../")) {
        throw new Error(`候选 Patch 目标必须位于校验沙箱内：${target}`);
      }
      mkdirSync(path.dirname(stagedPath), { recursive: true });
      copyFileSync(sourcePath, stagedPath);
    }
    writeFileSync(patchPath, patch, "utf8");
    const targets = runGit(["apply", "--numstat", "-z", "--", patchPath], {
      cwd: validationRoot,
    });
    if (targets.status !== 0) {
      throw new Error(`git apply --numstat 失败：${(targets.stderr || targets.stdout).trim()}`);
    }
    assertGitParsedTargets(targets.stdout, allowed);
    const check = runGit(["apply", "--check", "--", patchPath], { cwd: validationRoot });
    if (check.status !== 0) {
      throw new Error(`git apply --check 失败：${(check.stderr || check.stdout).trim()}`);
    }
    return {
      status: "passed",
      bytes: Buffer.byteLength(patch),
      sha256: `sha256:${sha256(patch)}`,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
