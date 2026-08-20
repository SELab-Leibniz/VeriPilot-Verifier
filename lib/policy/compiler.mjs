import { DEFAULT_LOCALE } from "../messages.mjs";
import { compileReviewGraph } from "../review-graph.mjs";
import {
  bindArtifactGroundTruth,
  compileGroundTruthSources,
} from "../ground-truth.mjs";
import {
  assertArtifactCorrelationCoverage,
  compileArtifactPathMatcher,
  compileWorkflowCorrelation,
} from "../path-template.mjs";
import { resolvePolicyPath } from "./policy-path.mjs";
import { optionalStringArray } from "./policy-values.mjs";
import { compileRuntimeV2Config } from "../runtime-v2/config.mjs";


const MAX_SEMANTIC_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;


export function assertStageName(value, label = "stage") {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(
      `${label} 必须使用小写字母开头，并且只包含小写字母、`
      + "数字或连字符（最多 64 个字符）。",
    );
  }
  return value;
}


function compileLimits(value, label) {
  const limits = value ?? {};
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`${label} 必须是对象。`);
  }
  const timeoutMs = limits.semanticReviewTimeoutMs;
  if (timeoutMs !== undefined
    && (!Number.isInteger(timeoutMs)
      || timeoutMs < 1000
      || timeoutMs > MAX_SEMANTIC_REVIEW_TIMEOUT_MS)) {
    throw new Error(
      `${label}.semanticReviewTimeoutMs 必须是 1000 到 `
      + `${MAX_SEMANTIC_REVIEW_TIMEOUT_MS} 之间的整数。`,
    );
  }
  return { ...limits };
}


function artifactLabel(configPath, index) {
  return configPath ? `${configPath} artifacts[${index}]` : `artifacts[${index}]`;
}


function compileRulePolicy(value, policyRoot, label) {
  if (value === undefined) return { enabled: false, file: null };
  const rulesFile = resolvePolicyPath(policyRoot, value.file, `${label}.file`);
  if (value.enabled && !rulesFile) {
    throw new Error(`${label}.enabled 为 true 时必须配置 file。`);
  }
  return { enabled: value.enabled, file: rulesFile };
}


function compileReviewPolicy(value, policyRoot, label) {
  if (value === undefined) return { enabled: false, criteriaFile: null };
  return {
    enabled: value.enabled,
    criteriaFile: resolvePolicyPath(
      policyRoot,
      value.criteria,
      `${label}.criteria`,
    ),
  };
}


function compileProjectArtifact(artifact, index, context) {
  const label = artifactLabel(context.configPath, index);
  const name = artifact.name ?? artifact.type;
  if (!name || typeof name !== "string") {
    throw new Error(`${label} 缺少 name。`);
  }
  const stage = assertStageName(artifact.stage ?? name, `${label}.stage`);
  if (artifact.outputKey !== undefined && !artifact.outputKey.trim()) {
    throw new Error(`${label}.outputKey 必须是非空字符串。`);
  }
  const rulesPolicy = compileRulePolicy(
    artifact.rules,
    context.policyRoot,
    `${label}.rules`,
  );
  const reviewPolicy = compileReviewPolicy(
    artifact.review,
    context.policyRoot,
    `${label}.review`,
  );
  return {
    nodeId: name,
    stage,
    type: artifact.type ?? name,
    format: artifact.format ?? "markdown",
    editable: artifact.editable !== false,
    ...(artifact.outputKey ? { outputKey: artifact.outputKey } : {}),
    ...(artifact.patterns !== undefined
      ? { patterns: [...artifact.patterns] }
      : { pathTemplates: [...artifact.pathTemplates] }),
    relatedPatterns: optionalStringArray(
      artifact.relatedPatterns,
      `${label}.relatedPatterns`,
    ),
    ...(artifact.groundTruth !== undefined
      ? {
          groundTruthRefs: optionalStringArray(
            artifact.groundTruth,
            `${label}.groundTruth`,
          ),
        }
      : {}),
    relatedRoot: artifact.relatedRoot ?? "artifact-directory",
    knowledge: [],
    rulesPolicy,
    reviewPolicy,
    simpleRulesFile: rulesPolicy.enabled ? rulesPolicy.file : null,
    reviewEnabled: reviewPolicy.enabled,
    reviewerFile: reviewPolicy.enabled ? reviewPolicy.criteriaFile : null,
    metricCheckpoint: artifact.metricCheckpoint === true,
    metrics: [...(artifact.metrics ?? [])],
  };
}


function compileArtifact(
  artifact,
  stageCatalog,
  index,
  { projectPolicy, configPath, policyRoot },
) {
  const source = projectPolicy
    ? compileProjectArtifact(artifact, index, { configPath, policyRoot })
    : artifact;
  const pathMatcher = compileArtifactPathMatcher(
    source,
    artifactLabel(configPath, index),
  );
  return {
    ...source,
    nodeId: source.nodeId ?? source.name ?? source.type,
    format: source.format ?? "markdown",
    editable: source.editable !== false,
    relatedPatterns: source.relatedPatterns ?? [],
    ...((source.groundTruthRefs ?? source.groundTruth)?.length > 0
      ? { groundTruthRefs: [...(source.groundTruthRefs ?? source.groundTruth)] }
      : {}),
    knowledge: source.knowledge ?? [],
    rulesPolicy: source.rulesPolicy ?? null,
    simpleRulesFile: source.simpleRulesFile ?? null,
    reviewEnabled: source.reviewEnabled ?? true,
    reviewerFile: source.reviewerFile ?? null,
    relatedRoot: source.relatedRoot ?? "artifact-directory",
    pathMatcher,
    scanPatterns: [...pathMatcher.scanPatterns],
    outputKey: source.outputKey
      ?? stageCatalog?.outputKeyForArtifactType(source.type)
      ?? null,
  };
}


function compileEnabledStages({
  configuredArtifacts,
  requestedStages,
  projectPolicy,
  configPath,
}) {
  const installedStages = [
    ...new Set(configuredArtifacts.map((artifact) => artifact.stage)),
  ];
  if (!projectPolicy) {
    return {
      installedStages,
      enabledStages: requestedStages ?? installedStages,
    };
  }

  const enabledStages = requestedStages === undefined
    ? installedStages
    : optionalStringArray(requestedStages, `${configPath} enabledStages`);
  const unknownStages = enabledStages.filter(
    (stage) => !installedStages.includes(stage),
  );
  if (unknownStages.length > 0) {
    throw new Error(
      `${configPath} enabledStages 包含未安装的 stage：`
      + `${unknownStages.join("、")}。`,
    );
  }
  if (new Set(enabledStages).size !== enabledStages.length) {
    throw new Error(`${configPath} enabledStages 不能包含重复 stage。`);
  }
  return { installedStages, enabledStages };
}


export function compileRuntimePolicy(
  config,
  {
    stageCatalog = null,
    projectPolicy = false,
  } = {},
) {
  const context = {
    projectPolicy,
    configPath: config.configPath ?? null,
    policyRoot: config.policyRoot ?? null,
  };
  const compileArtifacts = (artifacts = []) => artifacts.map(
    (artifact, index) => compileArtifact(artifact, stageCatalog, index, context),
  );
  const hasSeparateConfiguredArtifacts = config.configuredArtifacts !== undefined;
  const groundTruthSources = compileGroundTruthSources(
    config.groundTruth,
    context.configPath ? `${context.configPath} groundTruth` : "groundTruth",
  );
  const configuredArtifacts = bindArtifactGroundTruth(
    compileArtifacts(
      hasSeparateConfiguredArtifacts ? config.configuredArtifacts : config.artifacts,
    ),
    groundTruthSources,
    context.configPath ? `${context.configPath} artifacts` : "artifacts",
  );
  const compiledArtifacts = hasSeparateConfiguredArtifacts
    ? bindArtifactGroundTruth(
        compileArtifacts(config.artifacts),
        groundTruthSources,
        "artifacts",
      )
    : configuredArtifacts;
  const stageSelection = compileEnabledStages({
    configuredArtifacts,
    requestedStages: config.enabledStages,
    projectPolicy,
    configPath: context.configPath,
  });
  const installedStages = config.installedStages ?? stageSelection.installedStages;
  const enabledStages = config.enabledStages ?? stageSelection.enabledStages;
  const enabledStageSet = new Set(enabledStages);
  const artifacts = projectPolicy
    ? configuredArtifacts.filter((artifact) => enabledStageSet.has(artifact.stage))
    : compiledArtifacts;
  const reviewGraph = projectPolicy
    ? compileReviewGraph({
        workflow: config.workflow,
        artifacts: configuredArtifacts,
        policyRoot: context.policyRoot,
        configPath: context.configPath,
      })
    : (config.reviewGraph ?? null);
  const workflowCorrelation = compileWorkflowCorrelation(
    config.workflowCorrelation ?? config.workflow?.correlation,
    context.configPath
      ? `${context.configPath} workflow.correlation`
      : "workflow.correlation",
  );
  assertArtifactCorrelationCoverage({
    artifacts: configuredArtifacts,
    reviewGraph,
    correlation: workflowCorrelation,
    label: context.configPath
      ? `${context.configPath} workflow.correlation`
      : "workflow.correlation",
  });
  const publicConfig = projectPolicy
    ? Object.fromEntries(
        Object.entries(config).filter(([key]) => key !== "workflow"),
      )
    : config;

  return {
    ...publicConfig,
    artifacts,
    configuredArtifacts,
    groundTruthSources,
    reviewGraph,
    workflowCorrelation,
    installedStages,
    enabledStages,
    configPath: context.configPath,
    policyRoot: context.policyRoot,
    ignorePatterns: config.ignorePatterns ?? [],
    extensions: config.extensions ?? {},
    output: config.output ?? {},
    locale: config.locale ?? DEFAULT_LOCALE,
    evidenceRoots: config.evidenceRoots ?? [],
    limits: compileLimits(
      config.limits,
      context.configPath ? `${context.configPath} limits` : "limits",
    ),
    runtimeV2: compileRuntimeV2Config(config, {
      policyRoot: context.policyRoot,
      limits: config.limits,
    }),
  };
}
