import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { normalizeSlashes } from "./path-utils.mjs";
import { OUTPUT_TREE_DIRECTORY, outputTreeDirectory } from "./runtime-v2/paths.mjs";
import { formatStageSpecification } from "./stage-specification.mjs";
import { serializeUnifiedDiffs } from "./unified-diff.mjs";


function safeStem(filePath) {
  const basename = path.basename(filePath, path.extname(filePath));
  return basename.replace(/[^\p{Letter}\p{Number}._-]+/gu, "-") || "artifact";
}


function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}


function safeOutputToken(value, fallback) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}


export function createRoundMetadata(result) {
  const generatedAt = new Date().toISOString();
  const compactTimestamp = generatedAt
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const identity = [
    generatedAt,
    result.metadata.stage,
    result.metadata.artifactType,
    result.metadata.triggerFile,
    ...result.metadata.artifactFiles,
  ].join("\n");
  return {
    generatedAt,
    roundId: `${compactTimestamp}-${shortHash(`${identity}\n${randomBytes(8).toString("hex")}`)}`,
  };
}


function outputArtifactKey(triggerFile, cwd, mode, configuredKey) {
  if (configuredKey) return configuredKey;
  const triggerIdentity = mode === "centralized"
    ? normalizeSlashes(path.relative(cwd, triggerFile))
    : path.basename(triggerFile);
  return `${safeOutputToken(safeStem(triggerFile), "artifact")}-${shortHash(triggerIdentity)}`;
}


function outputLayout(result, output, cwd, triggerFile, outputKey) {
  const outputRoot = output.mode === "centralized"
    ? path.resolve(cwd, outputTreeDirectory(output))
    : path.join(path.dirname(triggerFile), OUTPUT_TREE_DIRECTORY);
  const stage = safeOutputToken(result.metadata.stage, "stage");
  const artifact = outputArtifactKey(triggerFile, cwd, output.mode, outputKey);
  const artifactRunsDirectory = path.join(outputRoot, "runs", stage, artifact);
  return {
    latestDirectory: path.join(outputRoot, "latest", stage, artifact),
    roundDirectory: path.join(artifactRunsDirectory, result.metadata.roundId),
    artifactRunsDirectory,
  };
}


async function copyIfMissing(source, destination) {
  try {
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
  }
}


async function archiveExistingLatest(latestDirectory, artifactRunsDirectory) {
  const latestDiagnostic = path.join(latestDirectory, "diagnostic.md");
  let diagnostic;
  try {
    diagnostic = await fs.readFile(latestDiagnostic, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const roundId = diagnostic.match(/^- Round ID: `([^`]+)`$/m)?.[1];
  if (!/^\d{8}T\d{6}(?:\d{3})?Z-[a-f0-9]{8}$/.test(roundId ?? "")) return;
  const archivedDirectory = path.join(artifactRunsDirectory, roundId);
  await fs.mkdir(archivedDirectory, { recursive: true });
  for (const filename of ["diagnostic.md", "result.json", "spec.md", "patch.diff"]) {
    await copyIfMissing(
      path.join(latestDirectory, filename),
      path.join(archivedDirectory, filename),
    );
  }
}


function renderDiagnosticMarkdown(result) {
  const lines = [
    "# Runtime Correction Diagnostic",
    "",
    `- Round ID: \`${result.metadata.roundId}\``,
    `- Generated at: \`${result.metadata.generatedAt}\``,
    `- Status: \`${result.status}\``,
    `- Classification: \`${result.classification ?? "not-finalized"}\``,
    `- Stage: \`${result.metadata.stage}\``,
    `- Artifact type: \`${result.metadata.artifactType}\``,
    `- Trigger file: \`${result.metadata.triggerFile}\``,
    ...(result.metadata.artifactFiles?.length > 1
      ? [`- Bundle files: ${result.metadata.artifactFiles.map((file) => `\`${file}\``).join(", ")}`]
      : []),
    `- Bundle complete: \`${result.metadata.bundleComplete}\``,
    `- Input digest: \`${result.metadata.inputDigest ?? "none"}\``,
    `- Policy digest: \`${result.metadata.policyDigest ?? "none"}\``,
    `- Knowledge: ${result.metadata.ruleSetIds.map((id) => `\`${id}\``).join(", ") || "none"}`,
    `- Suggested Git patches: \`${result.diffs.length}\``,
    ...(result.metadata.workflow
      ? [
          `- Workflow node: \`${result.metadata.workflow.nodeId}\``,
          `- Workflow incoming edges: ${result.metadata.workflow.incomingEdges
            .map((edge) => `\`${edge.from} -> ${edge.to} (${edge.status})\``)
            .join(", ")}`,
          `- Editable artifact files: ${result.metadata.workflow.editableArtifactFiles
            .map((file) => `\`${file}\``)
            .join(", ")}`,
        ]
      : []),
    ...(result.agentReview?.status
      ? [`- Semantic review: \`${result.agentReview.status}\``]
      : []),
    ...(result.agentReview?.sessionId
      ? [`- Semantic review session: \`${result.agentReview.sessionId}\` (released)`]
      : []),
    ...(result.metadata.groundTruth?.sources?.length > 0
      ? [
          `- Ground Truth: ${result.metadata.groundTruth.sources
            .map((source) => `\`${source.id}@${source.version ?? "unversioned"} (${source.status})\``)
            .join(", ")}`,
        ]
      : []),
    "",
    "## Diagnostics",
    "",
  ];
  if (result.diagnostics.length === 0) {
    lines.push("No deviations detected.");
  } else {
    for (const item of result.diagnostics) {
      lines.push(`- **${item.severity.toUpperCase()} ${item.ruleId}** — \`${item.path}${item.line ? `:${item.line}` : ""}\`: ${item.message}`);
      if (item.suggestion) {
        lines.push(`  - Suggestion: ${item.suggestion}`);
      }
      if (item.evidence?.length > 0) {
        lines.push(`  - Evidence: ${item.evidence.map((evidence) => `\`${evidence}\``).join(", ")}`);
      }
    }
  }
  if (result.diffs.length > 0) {
    lines.push("", "## Candidate Git Patches", "");
    for (const patch of result.diffs) {
      lines.push(`- Path: \`${patch.path}\``);
      lines.push(`  - Format: \`${patch.format}\``);
      lines.push(`  - Apply mode: \`${patch.applyMode}\``);
      lines.push(`  - Base hash: \`${patch.baseHash}\``);
      lines.push(`  - Proposed hash: \`${patch.proposedHash}\``);
      lines.push("  - Required check: `git apply --check <patch-file>`");
    }
  }
  lines.push("", "> This report is diagnostic only. No correction was applied.", "");
  return lines.join("\n");
}


export async function persistResult({
  result,
  output,
  cwd,
  triggerFile,
  stageSpecification = null,
  outputKey = null,
}) {
  if (!output.persist) {
    return [];
  }
  if (!["centralized", "adjacent"].includes(output.mode)) {
    throw new Error(`不支持的输出模式: ${output.mode}`);
  }
  const {
    latestDirectory,
    roundDirectory,
    artifactRunsDirectory,
  } = outputLayout(result, output, cwd, triggerFile, outputKey);

  await archiveExistingLatest(latestDirectory, artifactRunsDirectory);
  await fs.mkdir(latestDirectory, { recursive: true });
  await fs.mkdir(roundDirectory, { recursive: true });
  const roundFiles = [];
  const latestFiles = [];
  const diagnosticMarkdown = renderDiagnosticMarkdown(result);
  const roundDiagnosticPath = path.join(roundDirectory, "diagnostic.md");
  const latestDiagnosticPath = path.join(latestDirectory, "diagnostic.md");
  await fs.writeFile(roundDiagnosticPath, diagnosticMarkdown, "utf8");
  await fs.writeFile(latestDiagnosticPath, diagnosticMarkdown, "utf8");
  roundFiles.push(roundDiagnosticPath);
  latestFiles.push(latestDiagnosticPath);

  const roundResultPath = path.join(roundDirectory, "result.json");
  const latestResultPath = path.join(latestDirectory, "result.json");
  const machineResult = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(roundResultPath, machineResult, "utf8");
  await fs.writeFile(latestResultPath, machineResult, "utf8");
  roundFiles.push(roundResultPath);
  latestFiles.push(latestResultPath);

  const roundSpecificationPath = path.join(roundDirectory, "spec.md");
  const latestSpecificationPath = path.join(latestDirectory, "spec.md");
  if (result.status === "failed" && stageSpecification) {
    const specification = formatStageSpecification(stageSpecification);
    await fs.writeFile(roundSpecificationPath, specification, "utf8");
    await fs.writeFile(latestSpecificationPath, specification, "utf8");
    roundFiles.push(roundSpecificationPath);
    latestFiles.push(latestSpecificationPath);
  } else {
    await fs.rm(latestSpecificationPath, { force: true });
  }

  const roundDiffPath = path.join(roundDirectory, "patch.diff");
  const latestDiffPath = path.join(latestDirectory, "patch.diff");
  const diff = serializeUnifiedDiffs(result.diffs);
  await fs.writeFile(roundDiffPath, diff, "utf8");
  await fs.writeFile(latestDiffPath, diff, "utf8");
  roundFiles.push(roundDiffPath);
  latestFiles.push(latestDiffPath);
  return { roundFiles, latestFiles, writtenFiles: [...roundFiles, ...latestFiles] };
}
