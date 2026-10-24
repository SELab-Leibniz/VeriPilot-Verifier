import { promises as fs } from "node:fs";
import path from "node:path";

import { localSkillRoots, instructionFileNames } from "../active-host.mjs";
import { collectPatternMatches, matchConfiguredArtifact, matchesAny } from "../artifact-pipeline.mjs";
import { compileArtifactPathMatcher } from "../path-template.mjs";
import { OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY, LEGACY_POLICY_CONFIG_FILE } from "./paths.mjs";
import { sha256 } from "./utils.mjs";

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const fileKey = file => process.platform === "win32" ? file.toLowerCase() : file;

// A policy declaration establishes proof ownership, not the candidate's quality
// or existence. Empty files leave that subject unbound; no metric is removed.
export async function collectArtifactCandidates({ projectRoot, plan = {} }) {
  const root = await fs.realpath(projectRoot);
  const artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
  const declared = artifacts.filter(artifact => artifact.metrics?.length);
  if (!declared.length) return [];
  const configPath = plan.configPath ? path.resolve(root, plan.configPath) : null;
  const configSha256 = configPath ? sha256(await fs.readFile(configPath)) : null;
  const privateRoots = [OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY, plan.output?.directory,
    ...(plan.runtimeV2?.dynamicGroundTruth?.materialRoots ?? []),
    ...(plan.runtimeV2?.skillCorrection?.skillRoots ?? []), ...localSkillRoots({ projectRoot: root })]
    .filter(Boolean).map(directory => path.resolve(root, directory));
  const controlFiles = new Set([configPath, path.join(root, LEGACY_POLICY_CONFIG_FILE),
    ...instructionFileNames.map(name => path.join(root, name)),
    ...artifacts.flatMap(artifact => [artifact.reviewerFile, artifact.simpleRulesFile])]
    .filter(Boolean).map(file => fileKey(path.resolve(root, file))));
  const authorityPatterns = (plan.groundTruthSources ?? []).flatMap(source => source.patterns ?? []);
  const ignoredDirectories = new Set([".git", "node_modules", OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY]);
  const declarationContext = {
    ownership: artifacts.map(artifact => ({ artifactId: artifact.nodeId, patterns: artifact.patterns ?? null,
      pathTemplates: artifact.pathTemplates ?? null })),
    workflowCorrelation: plan.workflowCorrelation ?? null,
    privateRoots: [...new Set(privateRoots)].sort(), controlFiles: [...controlFiles].sort(),
    authorityPatterns, ignorePatterns: plan.ignorePatterns ?? [],
  };
  const contents = new Map();
  const result = [];
  for (const artifact of declared) {
    const artifactId = artifact.nodeId ?? artifact.name ?? artifact.type;
    const metricIds = [...new Set(artifact.metrics)].sort();
    if (typeof artifactId !== "string" || !artifactId.trim()
      || metricIds.some(metric => !/^M(?:0[1-9]|1[0-5])$/u.test(metric)))
      throw new Error("Artifact candidate declarations require a node identity and explicit valid metric IDs.");
    const matcher = compileArtifactPathMatcher(artifact);
    const candidates = await collectPatternMatches({ patterns: matcher.scanPatterns, baseRoots: [root], scopeRoot: root,
      maxCandidates: Infinity, ignoredDirectories });
    const files = [];
    for (const candidate of [...new Set(candidates)].sort()) {
      const absolute = path.resolve(candidate), relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (!inside(root, absolute) || relative.split("/").some(part => ignoredDirectories.has(part))
        || controlFiles.has(fileKey(absolute)) || privateRoots.some(directory => inside(directory, absolute))
        || matchesAny(relative, authorityPatterns) || matchesAny(relative, plan.ignorePatterns ?? [])) continue;
      if (matchConfiguredArtifact(relative, artifacts, plan.workflowCorrelation)?.artifact !== artifact) continue;
      try {
        if (!(await fs.lstat(absolute)).isFile() || await fs.realpath(absolute) !== absolute) continue;
        if (!contents.has(absolute)) contents.set(absolute, sha256(await fs.readFile(absolute)));
        files.push({ path: relative, sha256: contents.get(absolute) });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }
    const digest = sha256({ artifactId, metricIds, patterns: artifact.patterns ?? null,
      pathTemplates: artifact.pathTemplates ?? null, ...declarationContext });
    result.push({ artifactId, metricIds, files, declaration: { configPath, configSha256, digest } });
  }
  return result;
}
