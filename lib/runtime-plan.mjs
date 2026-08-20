import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RUNTIME_CONFIG,
  loadRuntimeDefinition,
} from "./default-runtime.mjs";
import { compileRuntimePolicy } from "./policy/compiler.mjs";
import {
  loadProjectPolicySource,
  withSimpleModeCompatibility,
} from "./policy/project-policy.mjs";
import {
  deriveConfigDefaults,
  ZERO_CONFIG_DEFAULTS,
} from "./runtime-v2/derive.mjs";
import { LEGACY_POLICY_CONFIG_FILE } from "./runtime-v2/paths.mjs";
import {
  DEFAULT_STAGE_CATALOG,
  loadStageCatalog,
} from "./stages/catalog.mjs";


const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


function adaptConfigInput(config = {}) {
  const compatibility = config.simpleMode;
  if (!compatibility) return config;
  return {
    ...config,
    configuredArtifacts: config.configuredArtifacts
      ?? compatibility.configuredArtifacts,
    reviewGraph: config.reviewGraph ?? compatibility.reviewGraph,
    workflowCorrelation: config.workflowCorrelation
      ?? compatibility.workflowCorrelation,
    installedStages: config.installedStages ?? compatibility.installedStages,
    enabledStages: config.enabledStages ?? compatibility.enabledStages,
    configPath: config.configPath ?? compatibility.configPath,
    policyRoot: config.policyRoot ?? compatibility.policyRoot,
  };
}


function mergeConfig(base, override = {}) {
  const adaptedOverride = adaptConfigInput(override);
  return {
    ...base,
    ...adaptedOverride,
    artifacts: adaptedOverride.artifacts ?? base.artifacts,
    ignorePatterns: adaptedOverride.ignorePatterns ?? base.ignorePatterns,
    extensions: { ...base.extensions, ...adaptedOverride.extensions },
    output: { ...base.output, ...adaptedOverride.output },
    limits: { ...base.limits, ...adaptedOverride.limits },
    dynamicGroundTruth: {
      ...base.dynamicGroundTruth,
      ...adaptedOverride.dynamicGroundTruth,
    },
    skillCorrection: {
      ...base.skillCorrection,
      ...adaptedOverride.skillCorrection,
    },
    artifactCorrection: {
      ...base.artifactCorrection,
      ...adaptedOverride.artifactCorrection,
    },
    stopCorrection: {
      ...base.stopCorrection,
      ...adaptedOverride.stopCorrection,
    },
    reviewers: {
      ...base.reviewers,
      ...adaptedOverride.reviewers,
    },
  };
}


async function readJson(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents);
}


export async function loadRuntimePlan({
  cwd,
  pluginRoot = MODULE_ROOT,
  config,
} = {}) {
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const runtimeDefinitionPath = path.join(
    resolvedPluginRoot,
    "config",
    "runtime.yaml",
  );
  const defaultConfig = resolvedPluginRoot === MODULE_ROOT
    ? DEFAULT_RUNTIME_CONFIG
    : (await loadRuntimeDefinition(runtimeDefinitionPath)).defaults;
  const stageCatalog = resolvedPluginRoot === MODULE_ROOT
    ? DEFAULT_STAGE_CATALOG
    : await loadStageCatalog({
        catalogPath: runtimeDefinitionPath,
      });
  const compileConfig = (
    candidate,
    configSource,
    { projectPolicy = false } = {},
  ) => {
    const merged = { ...mergeConfig(defaultConfig, candidate), configSource };
    const plan = compileRuntimePolicy(merged, { stageCatalog, projectPolicy });
    if (projectPolicy) return withSimpleModeCompatibility(plan);
    if (!merged.simpleMode) return plan;
    return {
      ...plan,
      simpleMode: {
        ...merged.simpleMode,
        configuredArtifacts: plan.configuredArtifacts,
      },
    };
  };

  if (config) {
    return compileConfig(config, "provided");
  }

  const projectPolicy = await loadProjectPolicySource(cwd);
  if (projectPolicy) {
    // Auto-derivation (derive.mjs): fill the gaps an explicit v2 config left
    // open — precedence: plugin defaults < derived < explicit config.
    const needsDerivation = projectPolicy.version === 2 && (
      (projectPolicy.dynamicGroundTruth?.enabled === true
        && projectPolicy.dynamicGroundTruth?.materialRoots === undefined)
      || (projectPolicy.implementationCorrection?.enabled === true
        && projectPolicy.implementationCorrection?.platform === undefined)
    );
    const candidate = needsDerivation
      ? { ...projectPolicy, derived: await deriveConfigDefaults(cwd) }
      : projectPolicy;
    return compileConfig(
      candidate,
      "project-simple",
      { projectPolicy: true },
    );
  }

  const projectConfigPath = path.join(cwd, LEGACY_POLICY_CONFIG_FILE);
  try {
    const projectConfig = await readJson(projectConfigPath);
    return compileConfig(projectConfig, "project-legacy");
  } catch (error) {
    if (error.code === "ENOENT") {
      // Zero-config operation: no .runtime-corrector/ directory anywhere.
      // Compile the fully functional v2 baseline with derived task materials
      // and platform; the orchestrator journals DERIVED_CONFIG once per task.
      const derived = await deriveConfigDefaults(cwd);
      return compileConfig(
        { ...ZERO_CONFIG_DEFAULTS, derived: { ...derived, zeroConfig: true } },
        "plugin-default",
      );
    }
    throw new Error(`无法读取配置 ${projectConfigPath}: ${error.message}`);
  }
}
