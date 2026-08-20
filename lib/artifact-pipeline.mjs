import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeSlashes } from "./path-utils.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./runtime-v2/paths.mjs";
import {
  compileArtifactPathMatcher,
  extractWorkflowInstance,
  matchPathTemplates,
  normalizeWorkflowInstance,
  workflowInstancesEqual,
} from "./path-template.mjs";


export const PUBLIC_COMMANDS_CONTEXT_MARKER = "[runtime-corrector:public-commands]";
const READABLE_ARTIFACT_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".cs", ".go", ".h", ".hpp", ".java",
  ".ets", ".js", ".jsx", ".json", ".json5", ".md", ".mjs", ".ps1",
  ".py", ".rs", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml",
  ".yaml", ".yml",
]);


export function globToRegExp(glob) {
  const source = normalizeSlashes(glob);
  let expression = "^";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    const afterNext = source[index + 2];

    if (character === "*" && next === "*" && afterNext === "/") {
      expression += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && next === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else if ("\\^$+.|()[]{}".includes(character)) {
      expression += `\\${character}`;
    } else {
      expression += character;
    }
  }

  return new RegExp(`${expression}$`, "i");
}


export function matchesAny(filePath, patterns = []) {
  const normalized = normalizeSlashes(filePath).replace(/^\.\//, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}


export function matchConfiguredArtifact(
  filePath,
  artifacts = [],
  workflowCorrelation = null,
) {
  const normalized = normalizeSlashes(filePath).replace(/^\.\//, "");
  for (const artifact of artifacts) {
    const pathMatcher = artifact.pathMatcher
      ?? compileArtifactPathMatcher(artifact);
    if (pathMatcher.kind === "template") {
      const templateMatch = matchPathTemplates(
        normalized,
        pathMatcher.templates,
      );
      if (!templateMatch) continue;
      return {
        artifact,
        captures: templateMatch.captures,
        instance: workflowCorrelation
          ? extractWorkflowInstance(
              templateMatch.captures,
              workflowCorrelation,
              normalized,
            )
          : null,
        pathTemplate: templateMatch.template,
      };
    }
    if (matchesAny(normalized, pathMatcher.patterns)) {
      return {
        artifact,
        captures: null,
        instance: null,
        pathTemplate: null,
      };
    }
  }
  return null;
}


export function resolveInputFile(input, cwd) {
  const rawPath = input?.tool_input?.file_path
    ?? input?.tool_input?.path
    ?? input?.tool_input?.notebook_path;
  if (!rawPath || typeof rawPath !== "string") {
    return null;
  }
  return path.resolve(cwd, rawPath);
}


export async function transcriptHasPublicCommandContext(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return false;
  try {
    const contents = await fs.readFile(transcriptPath, "utf8");
    const activeEntries = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "system" && entry?.subtype === "compact_boundary") {
          activeEntries.length = 0;
          continue;
        }
        activeEntries.push(entry);
      } catch {
        // Claude Code can append a line while a hook is reading the transcript.
      }
    }
    const activeContext = activeEntries.map((entry) => JSON.stringify(entry)).join("\n");
    return activeContext.includes(PUBLIC_COMMANDS_CONTEXT_MARKER)
      || (
        activeContext.includes("/runtime-corrector:spec")
        && activeContext.includes("/runtime-corrector:help")
      );
  } catch {
    return false;
  }
}


async function hasProjectPolicy(candidate) {
  const policyPaths = [
    path.join(candidate, ".runtime-corrector", "config.yaml"),
    path.join(candidate, ".runtime-corrector.json"),
  ];
  for (const policyPath of policyPaths) {
    try {
      await fs.access(policyPath);
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return false;
}


export async function findPolicyRootForFile(filePath) {
  let candidate = path.dirname(path.resolve(filePath));
  while (true) {
    if (await hasProjectPolicy(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}


async function importExtension(modulePath, cwd) {
  if (!modulePath) {
    return null;
  }
  const absolutePath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(cwd, modulePath);
  return import(pathToFileURL(absolutePath).href);
}


function validateArtifactMatch(
  match,
  triggerFile,
  cwd,
  workflowCorrelation,
) {
  if (!match || typeof match !== "object") {
    return null;
  }
  if (!match.stage || !match.artifactType) {
    throw new Error("自定义 matcher 必须返回 stage 和 artifactType");
  }
  const instance = workflowCorrelation
    ? normalizeWorkflowInstance(
        match.instance,
        workflowCorrelation,
        "自定义 matcher 返回的 instance",
      )
    : match.instance ?? null;
  return {
    nodeId: match.nodeId ?? null,
    stage: match.stage,
    artifactType: match.artifactType,
    format: match.format ?? "markdown",
    primaryPath: path.resolve(cwd, match.primaryPath ?? triggerFile),
    relatedPatterns: match.relatedPatterns ?? [],
    knowledge: match.knowledge ?? [],
    simpleRulesFile: match.simpleRulesFile ?? null,
    reviewerFile: match.reviewerFile ?? null,
    relatedRoot: match.relatedRoot ?? "artifact-directory",
    editable: match.editable !== false,
    outputKey: match.outputKey ?? null,
    instance,
  };
}


export async function matchArtifact({ filePath, cwd, config }) {
  const relativePath = normalizeSlashes(path.relative(cwd, filePath));
  if (matchesAny(relativePath, config.ignorePatterns)) {
    return null;
  }

  const matcherExtension = await importExtension(config.extensions?.matcherModule, cwd);
  if (matcherExtension) {
    if (typeof matcherExtension.matchArtifact !== "function") {
      throw new Error("matcherModule 必须导出 matchArtifact 函数");
    }
    const customMatch = await matcherExtension.matchArtifact({
      filePath,
      relativePath,
      cwd,
      artifacts: config.artifacts,
    });
    return validateArtifactMatch(
      customMatch,
      filePath,
      cwd,
      config.workflowCorrelation,
    );
  }

  const configuredMatch = matchConfiguredArtifact(
    relativePath,
    config.artifacts,
    config.workflowCorrelation,
  );
  if (configuredMatch) {
    const { artifact, instance, pathTemplate } = configuredMatch;
    if (config.workflowCorrelation && !instance) {
      throw new Error(
        `workflow correlation 已启用，但 artifact“${artifact.nodeId}”无法从触发文件提取实例。`,
      );
    }
    return {
      nodeId: artifact.nodeId,
      stage: artifact.stage,
      artifactType: artifact.type,
      format: artifact.format,
      primaryPath: filePath,
      relatedPatterns: artifact.relatedPatterns,
      knowledge: artifact.knowledge,
      simpleRulesFile: artifact.simpleRulesFile,
      rulesPolicy: artifact.rulesPolicy,
      reviewEnabled: artifact.reviewEnabled,
      reviewerFile: artifact.reviewerFile,
      relatedRoot: artifact.relatedRoot,
      editable: artifact.editable,
      outputKey: artifact.outputKey,
      instance,
      pathTemplate,
    };
  }
  return null;
}


async function walkFiles(root, maxFiles, ignoredDirectories) {
  const results = [];

  async function visit(directory) {
    if (results.length >= maxFiles) {
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) {
        return;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(candidate);
        }
      } else if (entry.isFile()) {
        results.push(candidate);
      }
    }
  }

  await visit(root);
  return results;
}


function hasGlobMagic(pattern) {
  return /[*?]/.test(pattern);
}


function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}


function globStaticRoot(baseRoot, pattern) {
  const segments = normalizeSlashes(pattern)
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean);
  const staticSegments = [];
  for (const segment of segments) {
    if (hasGlobMagic(segment)) break;
    staticSegments.push(segment);
  }
  return path.resolve(baseRoot, ...staticSegments);
}


async function isReadableFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}


async function collectPatternMatches({
  patterns,
  baseRoots,
  scopeRoot,
  maxCandidates,
  ignoredDirectories,
}) {
  const normalizedScopeRoot = path.resolve(scopeRoot);
  const normalizedRoots = baseRoots
    .map((root) => path.resolve(root))
    .filter((root, index, all) => all.indexOf(root) === index);
  const exactPatterns = patterns.filter((pattern) => !hasGlobMagic(pattern));
  const wildcardPatterns = patterns.filter(hasGlobMagic);
  const results = [];
  const seen = new Set();

  function add(candidate) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    results.push(resolved);
  }

  for (const pattern of exactPatterns) {
    for (const baseRoot of normalizedRoots) {
      const candidate = path.resolve(baseRoot, pattern);
      if (!isInsideOrEqual(baseRoot, candidate)) continue;
      if (!isInsideOrEqual(normalizedScopeRoot, candidate)) continue;
      if (await isReadableFile(candidate)) add(candidate);
    }
  }

  for (const pattern of wildcardPatterns) {
    for (const baseRoot of normalizedRoots) {
      const scanRoot = globStaticRoot(baseRoot, pattern);
      if (!isInsideOrEqual(baseRoot, scanRoot)) continue;
      if (!isInsideOrEqual(normalizedScopeRoot, scanRoot)) continue;
      let candidates;
      try {
        candidates = await walkFiles(scanRoot, maxCandidates, ignoredDirectories);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
        throw error;
      }
      for (const candidate of candidates) {
        const relative = normalizeSlashes(path.relative(baseRoot, candidate));
        if (matchesAny(relative, [pattern])) add(candidate);
      }
    }
  }
  return results;
}


export async function collectArtifactPathPlan({
  match,
  cwd,
  config,
  targetArtifact = null,
  sourceArtifacts = [],
  additionalPatternGroups = [],
}) {
  const collectorExtension = await importExtension(config.extensions?.collectorModule, cwd);
  let relatedPaths = [];
  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    OUTPUT_TREE_DIRECTORY,
  ]);
  const ownership = (candidate) => matchConfiguredArtifact(
    normalizeSlashes(path.relative(cwd, path.resolve(cwd, candidate))),
    config.configuredArtifacts ?? config.artifacts,
    config.workflowCorrelation,
  );
  const sameInstanceOrGlobal = (candidate) => {
    if (!config.workflowCorrelation) return true;
    const owner = ownership(candidate);
    if (!owner) return true;
    return owner.instance !== null && workflowInstancesEqual(
      owner.instance,
      match.instance,
      config.workflowCorrelation,
    );
  };

  if (collectorExtension) {
    if (typeof collectorExtension.collectRelated !== "function") {
      throw new Error("collectorModule 必须导出 collectRelated 函数");
    }
    relatedPaths = await collectorExtension.collectRelated({
      triggerFile: match.primaryPath,
      match,
      cwd,
      config,
    });
    if (!Array.isArray(relatedPaths)) {
      throw new Error("collectRelated 必须返回文件路径数组");
    }
  } else if (match.relatedPatterns.length > 0) {
    const scanRoot = match.relatedRoot === "project" ? cwd : path.dirname(match.primaryPath);
    relatedPaths = await collectPatternMatches({
      patterns: match.relatedPatterns,
      baseRoots: [cwd, scanRoot],
      scopeRoot: scanRoot,
      maxCandidates: config.limits.maxRelatedFiles * 4,
      ignoredDirectories,
    });
  }
  relatedPaths = relatedPaths.filter(sameInstanceOrGlobal);

  const targetBundlePaths = [];
  if (config.workflowCorrelation && targetArtifact) {
    const candidates = await collectPatternMatches({
      patterns: targetArtifact.scanPatterns,
      baseRoots: [cwd],
      scopeRoot: cwd,
      maxCandidates: config.limits.maxRelatedFiles * 4,
      ignoredDirectories,
    });
    for (const candidate of candidates) {
      const owner = ownership(candidate);
      if (owner?.artifact.nodeId === targetArtifact.nodeId
        && workflowInstancesEqual(
          owner.instance,
          match.instance,
          config.workflowCorrelation,
        )) {
        targetBundlePaths.push(candidate);
      }
    }
  }

  const workflowPaths = [];
  for (const sourceArtifact of sourceArtifacts) {
    const candidates = await collectPatternMatches({
      patterns: sourceArtifact.scanPatterns,
      baseRoots: [cwd],
      scopeRoot: cwd,
      maxCandidates: config.limits.maxRelatedFiles * 4,
      ignoredDirectories: new Set([...ignoredDirectories, ".runtime-corrector"]),
    });
    for (const candidate of candidates) {
      const relativeToCwd = normalizeSlashes(path.relative(cwd, candidate));
      if (path.basename(candidate) === ".runtime-corrector.json"
        || matchesAny(relativeToCwd, config.ignorePatterns)) {
        continue;
      }
      const owner = ownership(candidate);
      if (owner?.artifact.nodeId !== sourceArtifact.nodeId) continue;
      if (config.workflowCorrelation && !workflowInstancesEqual(
        owner.instance,
        match.instance,
        config.workflowCorrelation,
      )) {
        continue;
      }
      workflowPaths.push(candidate);
    }
  }
  const namedAdditionalPaths = [];
  if (additionalPatternGroups.length > 0) {
    for (const configuredGroup of additionalPatternGroups) {
      const group = Array.isArray(configuredGroup)
        ? { id: null, patterns: configuredGroup }
        : configuredGroup;
      const patterns = group.patterns ?? [];
      const groupPaths = [];
      const candidates = await collectPatternMatches({
        patterns,
        baseRoots: [cwd],
        scopeRoot: cwd,
        maxCandidates: config.limits.maxRelatedFiles * 4,
        ignoredDirectories: new Set([...ignoredDirectories, ".runtime-corrector"]),
      });
      for (const candidate of candidates) {
        const relativeToCwd = normalizeSlashes(path.relative(cwd, candidate));
        if (path.basename(candidate) === ".runtime-corrector.json"
          || matchesAny(relativeToCwd, config.ignorePatterns)) {
          continue;
        }
        if (!sameInstanceOrGlobal(candidate)) continue;
        workflowPaths.push(candidate);
        groupPaths.push(candidate);
      }
      namedAdditionalPaths.push({
        id: group.id ?? null,
        paths: groupPaths,
      });
    }
  }

  const nodeCandidates = [match.primaryPath, ...targetBundlePaths, ...relatedPaths]
    .map((candidate) => path.resolve(cwd, candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  const nodeCandidateSet = new Set(nodeCandidates);
  const paths = [...nodeCandidates, ...workflowPaths.map((candidate) => path.resolve(cwd, candidate))]
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .slice(0, config.limits.maxRelatedFiles);
  return {
    paths,
    nodePaths: paths.filter((candidate) => nodeCandidateSet.has(candidate)),
    additionalPaths: namedAdditionalPaths.map((group) => ({
      id: group.id,
      paths: group.paths
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => paths.includes(candidate)),
    })),
  };
}


export async function collectArtifactPaths(options) {
  return (await collectArtifactPathPlan(options)).paths;
}


export async function readArtifacts({ paths, triggerFile, cwd }) {
  const artifacts = [];
  for (const filePath of paths) {
    try {
      const stat = await fs.stat(filePath);
      const extension = path.extname(filePath).toLowerCase();
      if (!stat.isFile() || !READABLE_ARTIFACT_EXTENSIONS.has(extension)) {
        continue;
      }
      artifacts.push({
        path: filePath,
        relativePath: normalizeSlashes(path.relative(cwd, filePath)),
        format: extension === ".md"
          ? "markdown"
          : extension === ".json"
            ? "json"
            : "text",
        content: await fs.readFile(filePath, "utf8"),
        isTrigger: path.resolve(filePath) === path.resolve(triggerFile),
      });
    } catch (error) {
      if (path.resolve(filePath) === path.resolve(triggerFile)) {
        throw new Error(`无法读取触发文件 ${filePath}: ${error.message}`);
      }
    }
  }
  if (!artifacts.some((artifact) => artifact.isTrigger)) {
    throw new Error(`触发文件不是 runtime-corrector 支持的 UTF-8 文本产物: ${triggerFile}`);
  }
  return artifacts;
}
