import path from "node:path";

import { normalizeSlashes } from "./path-utils.mjs";
import { finalizeResultContract } from "./result-contract.mjs";


export function createResultFinalizer({
  mergeSemanticReview,
  validateResultDiffs,
  persistResult,
  formatAgentFeedback,
}) {
  return async function finalizeArtifactCheck(prepared, semanticReview = null) {
    const {
      output,
      cwd,
      triggerFile,
      stageSpecification,
      maxFeedbackChars,
      locale,
      includePublicCommandContext,
      editableArtifactFiles,
      outputKey,
    } = prepared.finalizeContext;
    const result = semanticReview
      ? mergeSemanticReview(prepared.result, semanticReview)
      : prepared.result;
    const hasWorkflow = result.metadata.workflow !== null
      && result.metadata.workflow !== undefined;
    validateResultDiffs(
      result,
      cwd,
      hasWorkflow
        ? Array.isArray(editableArtifactFiles) ? editableArtifactFiles : []
        : null,
    );
    finalizeResultContract(result);
    const persisted = await persistResult({
      result,
      output,
      cwd,
      triggerFile,
      stageSpecification,
      outputKey,
    });
    const writtenFiles = Array.isArray(persisted) ? persisted : persisted.writtenFiles;
    result.outputFiles = writtenFiles.map(
      (writtenFile) => normalizeSlashes(path.relative(cwd, writtenFile)),
    );
    result.roundOutputFiles = (persisted.roundFiles ?? []).map(
      (writtenFile) => normalizeSlashes(path.relative(cwd, writtenFile)),
    );
    result.latestOutputFiles = (persisted.latestFiles ?? []).map(
      (writtenFile) => normalizeSlashes(path.relative(cwd, writtenFile)),
    );
    const feedback = formatAgentFeedback(
      result,
      maxFeedbackChars,
      stageSpecification,
      { includePublicCommandContext, locale },
    );
    return { matched: true, result, feedback, writtenFiles, projectRoot: cwd };
  };
}
