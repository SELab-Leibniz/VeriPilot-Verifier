import path from "node:path";

import { statusFromDiagnostics } from "./diagnostic-status.mjs";
import {
  isPathInside,
  normalizeSlashes,
} from "./path-utils.mjs";
import {
  createInputManifest,
  createPolicyManifest,
} from "./result-contract.mjs";


export function createArtifactChecker({
  defaultPluginRoot,
  loadRuntimePlan,
  matchArtifact,
  collectArtifactPathPlan,
  matchConfiguredArtifact,
  readArtifacts,
  loadSimpleRules,
  loadKnowledge,
  diagnoseArtifacts,
  createRoundMetadata,
  loadReviewer,
  buildStageSpecification,
  formatStageSpecification,
  finalizeArtifactCheck,
}) {
  return async function checkArtifact({
    filePath,
    cwd,
    pluginRoot = defaultPluginRoot,
    config,
    projectRootSource = "provided-cwd",
    deferPersistence = false,
    includePublicCommandContext = true,
  } = {}) {
    const startedAt = Date.now();
    const resolvedCwd = path.resolve(cwd ?? process.cwd());
    const resolvedPluginRoot = path.resolve(pluginRoot);
    const triggerFile = path.resolve(resolvedCwd, filePath);
    if (!isPathInside(resolvedCwd, triggerFile)) {
      throw new Error(`被检查文件必须位于当前项目目录内: ${triggerFile}`);
    }
    const runtimePlan = await loadRuntimePlan({
      cwd: resolvedCwd,
      pluginRoot: resolvedPluginRoot,
      config,
    });
    const match = await matchArtifact({
      filePath: triggerFile,
      cwd: resolvedCwd,
      config: runtimePlan,
    });
    if (!match) {
      return { matched: false, reason: "unmatched-artifact" };
    }

    const reviewGraph = runtimePlan.reviewGraph;
    const configuredArtifacts = runtimePlan.configuredArtifacts;
    const artifactByNode = new Map(
      configuredArtifacts.map((artifact) => [artifact.nodeId, artifact]),
    );
    const targetArtifact = artifactByNode.get(match.nodeId) ?? null;
    const groundTruthInputs = targetArtifact?.groundTruthInputs ?? [];
    const configuredIncomingEdges = reviewGraph && match.nodeId
      ? reviewGraph.incomingEdges(match.nodeId)
      : [];
    const incomingEdges = configuredIncomingEdges
      .filter((edge) => edge.reviewEnabled)
      .map((edge) => ({
        ...edge,
        source: artifactByNode.get(edge.from),
      }));
    const artifactPlan = await collectArtifactPathPlan({
      match,
      cwd: resolvedCwd,
      config: runtimePlan,
      targetArtifact,
      sourceArtifacts: incomingEdges.map((edge) => edge.source),
      additionalPatternGroups: groundTruthInputs.map((source) => ({
        id: source.id,
        patterns: source.patterns,
      })),
    });
    const artifacts = await readArtifacts({
      paths: artifactPlan.paths,
      triggerFile,
      cwd: resolvedCwd,
    });
    const nodePathSet = new Set(artifactPlan.nodePaths);
    const nodeArtifacts = artifacts.filter((artifact) => nodePathSet.has(artifact.path));
    const groundTruthFilesById = new Map(
      artifactPlan.additionalPaths.map((group) => [
        group.id,
        group.paths.map((file) => normalizeSlashes(path.relative(resolvedCwd, file))),
      ]),
    );
    const artifactOwnerByPath = new Map(artifacts.map((artifact) => [
      artifact.path,
      matchConfiguredArtifact(
        artifact.relativePath,
        configuredArtifacts,
        runtimePlan.workflowCorrelation,
      ),
    ]));
    const workflowScoped = incomingEdges.length > 0
      || Boolean(runtimePlan.workflowCorrelation)
      || groundTruthInputs.length > 0;
    const targetFiles = workflowScoped
      ? nodeArtifacts
          .filter((artifact) => {
            const owner = artifactOwnerByPath.get(artifact.path);
            return match.nodeId
              ? owner?.artifact.nodeId === match.nodeId
              : artifact.isTrigger;
          })
          .map((artifact) => artifact.relativePath)
      : null;
    const knowledge = match.simpleRulesFile
      ? await loadSimpleRules(match.simpleRulesFile)
      : await loadKnowledge({
          ids: match.rulesPolicy?.enabled === false ? [] : match.knowledge,
          pluginRoot: resolvedPluginRoot,
        });
    const result = diagnoseArtifacts({
      artifacts: nodeArtifacts,
      knowledge,
      stage: match.stage,
      artifactType: match.artifactType,
      triggerFile: normalizeSlashes(path.relative(resolvedCwd, triggerFile)),
    });
    result.metadata.artifactFiles = artifacts.map((artifact) => artifact.relativePath);
    let workflowContext = null;
    if (workflowScoped) {
      const targetFileSet = new Set(targetFiles);
      result.diagnostics = result.diagnostics.filter((diagnostic) => (
        typeof diagnostic.path === "string"
        && targetFileSet.has(normalizeSlashes(diagnostic.path))
      ));
      result.status = statusFromDiagnostics(result.diagnostics);
      result.metadata.bundleComplete = !result.diagnostics.some(
        (diagnostic) => diagnostic.severity === "pending",
      );
      const plannedEdges = incomingEdges.map((edge) => {
        const sourceFiles = artifacts
          .filter((artifact) => (
            artifactOwnerByPath.get(artifact.path)?.artifact.nodeId === edge.from
          ))
          .map((artifact) => artifact.relativePath);
        return {
          id: `${edge.from}->${edge.to}`,
          from: edge.from,
          to: edge.to,
          status: sourceFiles.length > 0 ? "ready" : "pending",
          sourceFiles,
          targetFiles,
          reviewerFile: edge.reviewerFile,
        };
      });
      const plannedGroundTruth = groundTruthInputs.map((source) => {
        const files = groundTruthFilesById.get(source.id) ?? [];
        return {
          id: source.id,
          type: source.type,
          version: source.version,
          authority: source.authority,
          required: source.required,
          status: files.length > 0 ? "ready" : source.required ? "unresolved" : "optional-missing",
          files,
        };
      });
      for (const edge of plannedEdges) {
        if (edge.status !== "pending") continue;
        result.diagnostics.push({
          ruleId: "WORKFLOW-EDGE-SOURCE-MISSING",
          severity: "pending",
          path: result.metadata.triggerFile,
          message: `Workflow 入边 ${edge.from} -> ${edge.to} 没有找到前序产物。`,
          evidence: [`from=${edge.from}`, `to=${edge.to}`],
          suggestion: `先生成 ${edge.from} 节点产物；当前节点及其他可用入边仍会继续检查。`,
        });
      }
      if (plannedEdges.some((edge) => edge.status === "pending")) {
        if (result.status !== "failed") result.status = "pending";
        result.metadata.bundleComplete = false;
      }
      for (const source of plannedGroundTruth) {
        if (source.status !== "unresolved") continue;
        result.diagnostics.push({
          ruleId: "GROUND-TRUTH-SOURCE-MISSING",
          severity: "pending",
          path: result.metadata.triggerFile,
          message: `Ground Truth 来源 ${source.id} 没有找到当前可读文件。`,
          evidence: [`groundTruth=${source.id}`, `required=${source.required}`],
          suggestion: "补齐或重新绑定该 Ground Truth；在依据恢复前不要把当前检查解释为通过或业务偏离。",
        });
      }
      if (plannedGroundTruth.some((source) => source.status === "unresolved")) {
        if (result.status !== "failed") result.status = "pending";
        result.metadata.bundleComplete = false;
      }
      const editableArtifactFiles = match.editable === false ? [] : targetFiles;
      result.metadata.workflow = {
        nodeId: match.nodeId,
        ...(match.instance ? { instance: match.instance } : {}),
        editableArtifactFiles,
        incomingEdges: plannedEdges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          status: edge.status,
          sourceFiles: edge.sourceFiles,
        })),
        ...(plannedGroundTruth.length > 0
          ? { groundTruthInputs: plannedGroundTruth }
          : {}),
      };
      if (plannedGroundTruth.length > 0) {
        result.metadata.groundTruth = { sources: plannedGroundTruth };
      }
      workflowContext = {
        nodeId: match.nodeId,
        ...(match.instance ? { instance: match.instance } : {}),
        targetFiles,
        editableArtifactFiles,
        incomingEdges: plannedEdges,
        ...(plannedGroundTruth.length > 0
          ? { groundTruthInputs: plannedGroundTruth }
          : {}),
      };
    }
    result.metadata.configSource = runtimePlan.configSource;
    result.metadata.projectRootSource = projectRootSource;
    result.metadata.durationMs = Date.now() - startedAt;
    Object.assign(result.metadata, createRoundMetadata(result));
    result.metadata.diffGeneration = {
      enabled: true,
      strategy: "always",
    };

    const nodeReviewEnabled = match.reviewEnabled !== false;
    const reviewer = nodeReviewEnabled
      ? await loadReviewer(
          match.reviewerFile,
          runtimePlan.limits.maxReviewerChars,
        )
      : null;
    if (nodeReviewEnabled) {
      result.agentReview = {
        status: "requested",
        ...(reviewer
          ? {
              path: normalizeSlashes(path.relative(resolvedCwd, reviewer.path)),
              criteria: reviewer.criteria,
            }
          : {}),
      };
    }
    if (workflowContext) {
      const hydratedEdges = [];
      for (const edge of workflowContext.incomingEdges) {
        const edgeReviewer = await loadReviewer(
          edge.reviewerFile,
          runtimePlan.limits.maxReviewerChars,
        );
        hydratedEdges.push({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          status: edge.status,
          sourceFiles: edge.sourceFiles,
          targetFiles: edge.targetFiles,
          reviewer: edgeReviewer
            ? {
              path: normalizeSlashes(path.relative(resolvedCwd, edgeReviewer.path)),
              criteria: edgeReviewer.criteria,
            }
            : null,
        });
      }
      workflowContext = {
        ...workflowContext,
        incomingEdges: hydratedEdges,
      };
      result.agentReview = {
        ...(result.agentReview ?? { status: "requested" }),
        edges: hydratedEdges,
      };
    }

    const inputRoles = new Map();
    for (const targetFile of workflowContext?.targetFiles ?? [result.metadata.triggerFile]) {
      inputRoles.set(normalizeSlashes(targetFile), "target");
    }
    for (const edge of workflowContext?.incomingEdges ?? []) {
      for (const sourceFile of edge.sourceFiles ?? []) {
        inputRoles.set(normalizeSlashes(sourceFile), "workflow-source");
      }
    }
    for (const source of workflowContext?.groundTruthInputs ?? []) {
      for (const sourceFile of source.files ?? []) {
        inputRoles.set(normalizeSlashes(sourceFile), "ground-truth");
      }
    }
    const inputManifest = createInputManifest(artifacts, inputRoles);
    result.metadata.inputs = inputManifest.files;
    result.metadata.inputDigest = inputManifest.digest;
    const policyManifest = await createPolicyManifest([
      {
        path: path.join(resolvedPluginRoot, "config", "runtime.yaml"),
        label: "plugin:config/runtime.yaml",
      },
      runtimePlan.configPath,
      match.simpleRulesFile,
      match.reviewerFile,
      ...incomingEdges.map((edge) => edge.reviewerFile),
      ...(knowledge.rules ?? []).map((rule) => rule.schemaPath),
      ...(result.metadata.ruleSetIds ?? [])
        .filter((id) => !id.startsWith("project:"))
        .map((id) => ({
          path: path.join(resolvedPluginRoot, "knowledge", `${id}.json`),
          label: `plugin:knowledge/${id}.json`,
        })),
    ], resolvedCwd);
    result.metadata.policyFiles = policyManifest.files;
    result.metadata.policyDigest = policyManifest.digest;
    if (result.metadata.groundTruth) {
      const inputByPath = new Map(inputManifest.files.map((file) => [file.path, file]));
      result.metadata.groundTruth.sources = result.metadata.groundTruth.sources.map(
        (source) => ({
          ...source,
          files: source.files.map((file) => inputByPath.get(file) ?? { path: file }),
        }),
      );
    }

    const stageSpecification = await buildStageSpecification({
      stage: match.stage,
      cwd: resolvedCwd,
      pluginRoot: resolvedPluginRoot,
      config: runtimePlan,
    });
    if (stageSpecification) {
      result.specification = {
        stage: stageSpecification.stage,
        slashCommand: stageSpecification.recovery.slashCommand,
        cliCommand: stageSpecification.recovery.cliCommand,
        globalPath: stageSpecification.globalSpecification.path,
      };
    }

    const runtimeV2ArtifactReviewEnabled = runtimePlan.runtimeV2?.enabled && (
      runtimePlan.runtimeV2.artifactCorrection.groundTruthReviewEnabled
      || (
        runtimePlan.runtimeV2.artifactCorrection.stageMetricsEnabled
        && targetArtifact?.metricCheckpoint === true
      )
    );

    const prepared = {
      matched: true,
      result,
      projectRoot: resolvedCwd,
      reviewContext: {
        enabled: nodeReviewEnabled || incomingEdges.length > 0 || runtimeV2ArtifactReviewEnabled,
        semanticReviewTimeoutMs: runtimePlan.limits.semanticReviewTimeoutMs,
        nodeReviewEnabled,
        reviewer: reviewer
          ? {
            path: normalizeSlashes(path.relative(resolvedCwd, reviewer.path)),
            criteria: reviewer.criteria,
          }
          : null,
        specification: nodeReviewEnabled && stageSpecification
          ? formatStageSpecification(stageSpecification)
          : null,
        workflow: workflowContext,
        artifact: {
          nodeId: match.nodeId,
          stage: match.stage,
          artifactType: match.artifactType,
          snapshotHash: result.metadata.inputDigest,
          metricCheckpoint: targetArtifact?.metricCheckpoint === true,
          metrics: [...(targetArtifact?.metrics ?? [])],
        },
        runtimeV2Enabled: runtimeV2ArtifactReviewEnabled,
      },
      finalizeContext: {
        output: runtimePlan.output,
        cwd: resolvedCwd,
        triggerFile,
        stageSpecification,
        maxFeedbackChars: runtimePlan.limits.maxFeedbackChars,
        locale: runtimePlan.locale,
        includePublicCommandContext,
        editableArtifactFiles: workflowContext?.editableArtifactFiles ?? null,
        outputKey: match.outputKey,
      },
    };
    if (deferPersistence) return prepared;
    return finalizeArtifactCheck(prepared);
  };
}
