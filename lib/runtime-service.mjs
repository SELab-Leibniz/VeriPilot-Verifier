import { createArtifactChecker } from "./artifact-checker.mjs";
import { createHookHandler } from "./hook-handler.mjs";
import { createResultFinalizer } from "./result-finalizer.mjs";


export function createRuntimeService(dependencies) {
  const {
    defaultPluginRoot,
    mergeSemanticReview,
    validateResultDiffs,
    persistResult,
    formatAgentFeedback,
    resolveInputFile,
    findPolicyRootForFile,
    transcriptHasPublicCommandContext,
  } = dependencies;

  const finalizeArtifactCheck = createResultFinalizer({
    mergeSemanticReview,
    validateResultDiffs,
    persistResult,
    formatAgentFeedback,
  });
  const checkArtifact = createArtifactChecker({
    ...dependencies,
    finalizeArtifactCheck,
  });
  const handleHook = createHookHandler({
    defaultPluginRoot,
    checkArtifact,
    resolveInputFile,
    findPolicyRootForFile,
    transcriptHasPublicCommandContext,
  });

  return {
    checkArtifact,
    finalizeArtifactCheck,
    handleHook,
  };
}
