import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hasLinkedPath, isPathInside } from '../path-utils.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';

const hash = /^[a-f0-9]{64}$/u;
const sorted = values => [...values].sort();

// This key grants no review/reading authority. It only schedules one fresh
// semantic worker for equivalent preparations within the caller's tool result.
export function documentReviewBundleKey({ prepared, outcome, proposalBinding, owner }) {
  const result = prepared?.result, context = prepared?.reviewContext, metadata = result?.metadata;
  const artifact = context?.artifact;
  if (!prepared?.matched || !context.enabled || !artifact?.nodeId || !metadata?.bundleComplete
    || context.runtimeV2Enabled || artifact.metricCheckpoint || artifact.metrics?.length
    || outcome?.artifactReviewContext || outcome?.reviewerHandle || outcome?.reviewerExecutionContext
    || outcome?.groundTruthChanged || outcome?.groundTruthError || !hash.test(metadata.policyDigest)
    || !Array.isArray(metadata.inputs) || metadata.inputs.length < 2 || metadata.inputs.length > 259
    || !Array.isArray(metadata.artifactFiles) || !Array.isArray(result.diagnostics)) return null;
  const inputs = metadata.inputs;
  if (new Set(inputs.map(file => file.path)).size !== inputs.length
    || inputs.some(file => typeof file.path !== 'string' || !hash.test(file.sha256))
    || !inputs.some(file => file.path === metadata.triggerFile)
    || sha256(sorted(inputs.map(file => file.path))) !== sha256(sorted(metadata.artifactFiles))) return null;
  let basisInputs = inputs;
  if (!context.workflow) {
    // Without workflow targeting, every declared artifact is an allowed
    // finding/edit target. The checker labels only its current trigger target;
    // prove this exact representation before normalizing that role difference.
    if (inputs.some(file => file.role !== (file.path === metadata.triggerFile ? 'target' : 'context'))
      || prepared.finalizeContext.editableArtifactFiles !== null) return null;
    basisInputs = inputs.map(({ role, ...file }) => file);
  }
  const { snapshotHash, ...artifactPolicy } = artifact;
  return sha256({ owner, inputs: basisInputs, policyDigest: metadata.policyDigest,
    diagnostics: result.diagnostics, status: result.status,
    reviewContext: { ...context, artifact: artifactPolicy },
    finalizePolicy: { ...prepared.finalizeContext, triggerFile: undefined, output: undefined },
    originalRequirements: outcome.originalRequirements ?? null,
    proposalBinding, taskId: outcome.taskId ?? null });
}

export function groupDocumentReviews(entries, { enabled = false } = {}) {
  const groups = [], byKey = new Map();
  for (const entry of entries) {
    const key = enabled ? documentReviewBundleKey(entry) : null;
    let group = key && byKey.get(key);
    if (!group) {
      group = { entries: [], key }; groups.push(group);
      if (key) byKey.set(key, group);
    }
    group.entries.push(entry);
  }
  return groups;
}

// Recheck the exact shared scope and policy before dispatch and publication.
// A completed worker or a model PASS cannot certify that these stayed current.
export async function documentReviewBundleCurrent(prepared, { projectRoot, pluginRoot }) {
  const files = [
    ...prepared.result.metadata.inputs.map(file => ({ ...file, absolute: path.resolve(projectRoot, file.path) })),
    ...prepared.result.metadata.policyFiles.map(file => ({ ...file, absolute: file.path.startsWith('plugin:')
      ? path.resolve(pluginRoot, file.path.slice('plugin:'.length)) : path.resolve(projectRoot, file.path) })),
  ];
  for (const file of files) {
    if (!hash.test(file.sha256) || (!isPathInside(projectRoot, file.absolute) && !isPathInside(pluginRoot, file.absolute))) return false;
    try {
      if (await hasLinkedPath(file.absolute) || !(await fs.stat(file.absolute)).isFile()
        || sha256(await fs.readFile(file.absolute)) !== file.sha256) return false;
    } catch { return false; }
  }
  return true;
}
