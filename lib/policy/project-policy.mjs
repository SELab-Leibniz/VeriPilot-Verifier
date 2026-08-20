import { compileRuntimePolicy, assertStageName } from "./compiler.mjs";
import { loadProjectConfigDocument } from "./config-loader.mjs";


export async function loadProjectPolicySource(cwd) {
  const loaded = await loadProjectConfigDocument(cwd);
  if (!loaded) return null;
  const {
    configPath,
    document,
    policyRoot,
  } = loaded;
  return {
    version: document.version,
    artifacts: document.artifacts,
    groundTruth: document.groundTruth,
    workflow: document.workflow,
    enabledStages: document.enabledStages,
    configPath,
    policyRoot,
    ignorePatterns: document.ignorePatterns,
    output: document.output,
    limits: document.limits,
    locale: document.locale,
    evidenceRoots: document.evidenceRoots,
    dynamicGroundTruth: document.dynamicGroundTruth,
    skillCorrection: document.skillCorrection,
    artifactCorrection: document.artifactCorrection,
    stopCorrection: document.stopCorrection,
    implementationCorrection: document.implementationCorrection,
    // reviewers carries the per-role session/provider blocks and the
    // reviewers.modelPolicy preset shorthand (expanded at compile time).
    reviewers: document.reviewers,
    // shadowMode MUST survive this whitelist. Dropping it here silently
    // compiled plan.runtimeV2.shadowMode=false, so a run configured as
    // observe-only received live corrections (v2 Stop blocks + artifact
    // context) — exactly what the mode exists to prevent.
    shadowMode: document.shadowMode,
  };
}


export function withSimpleModeCompatibility(plan) {
  return {
    ...plan,
    simpleMode: {
      enabled: true,
      configPath: plan.configPath,
      policyRoot: plan.policyRoot,
      installedStages: plan.installedStages,
      enabledStages: plan.enabledStages,
      configuredArtifacts: plan.configuredArtifacts,
      reviewGraph: plan.reviewGraph,
      workflowCorrelation: plan.workflowCorrelation,
    },
  };
}


export async function loadSimpleProjectConfig(cwd) {
  const source = await loadProjectPolicySource(cwd);
  if (!source) return null;
  return withSimpleModeCompatibility(
    compileRuntimePolicy(source, { projectPolicy: true }),
  );
}


export { assertStageName };
export { loadProjectRules } from "./rules-loader.mjs";
export { loadReviewer } from "./reviewer-loader.mjs";
