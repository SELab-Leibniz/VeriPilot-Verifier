import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSupportedJsonSchema,
  validateJsonSchema,
} from "../json-schema-validator.mjs";
import { POLICY_ROOT_DIRECTORY } from "../runtime-v2/paths.mjs";
import { parseSimpleYaml } from "../simple-yaml.mjs";


const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_CONFIG_SCHEMA_PATH = path.join(
  MODULE_ROOT,
  "config",
  "schemas",
  "project-config.schema.json",
);
const PROJECT_CONFIG_SCHEMA = JSON.parse(
  await fs.readFile(PROJECT_CONFIG_SCHEMA_PATH, "utf8"),
);

assertSupportedJsonSchema(PROJECT_CONFIG_SCHEMA, PROJECT_CONFIG_SCHEMA_PATH);


function pointerLabel(configPath, pointer) {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let label = configPath;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (/^\d+$/.test(segment)) {
      label += `[${segment}]`;
    } else {
      label += index === 0 && segment === "artifacts"
        ? ` ${segment}`
        : `.${segment}`;
    }
  }
  return label;
}


function projectConfigError(configPath, issue) {
  const label = pointerLabel(configPath, issue.pointer);
  if (issue.pointer === "/version") {
    return `${configPath} 的 version 必须是 1 或 2。`;
  }
  if (issue.pointer === "/artifacts") {
    return `${configPath} 必须声明至少一个 artifacts 列表项。`;
  }
  if (/\/artifacts\/\d+\/reviewer$/.test(issue.pointer)) {
    return `${label} 已停用；请改用 review.enabled 和 review.criteria。`;
  }
  const policyMatch = issue.pointer.match(/^(\/artifacts\/\d+\/(?:rules|review))(?:\/enabled)?$/);
  if (policyMatch) {
    const policyPointer = policyMatch[1];
    const policyLabel = pointerLabel(configPath, policyPointer);
    const policyName = policyPointer.endsWith("/rules") ? "rules" : "review";
    if (issue.keyword === "required" || issue.pointer.endsWith("/enabled")) {
      return `${policyLabel} 必须显式配置 enabled。`;
    }
    if (issue.actual === "null") {
      return `${policyLabel} 必须显式配置 enabled；不再使用空值表示默认或关闭。`;
    }
    return `${policyLabel} 必须是包含 enabled 的对象。`;
  }
  if (/\/artifacts\/\d+\/(?:patterns|pathTemplates)$/.test(issue.pointer)
    || /\/artifacts\/\d+\/relatedPatterns(?:\/\d+)?$/.test(issue.pointer)
    || /\/enabledStages(?:\/\d+)?$/.test(issue.pointer)) {
    return `${label} 必须是非空字符串列表。`;
  }
  if (/\/artifacts\/\d+\/stage$/.test(issue.pointer)) {
    return `${label} 必须使用小写字母开头，并且只包含小写字母、数字或连字符（最多 64 个字符）。`;
  }
  if (/\/artifacts\/\d+\/format$/.test(issue.pointer)) {
    return `${label} 必须是 markdown、json、text 或 auto。`;
  }
  if (/\/artifacts\/\d+\/relatedRoot$/.test(issue.pointer)) {
    return `${label} 必须是 artifact-directory 或 project。`;
  }
  if (/\/artifacts\/\d+\/editable$/.test(issue.pointer)) {
    return `${label} 必须是布尔值。`;
  }
  if (/\/artifacts\/\d+\/outputKey$/.test(issue.pointer)) {
    return `${label} 必须是非空字符串。`;
  }
  if (/\/artifacts\/\d+\/type$/.test(issue.pointer)) {
    return `${label} 必须是字符串。`;
  }
  return `${label} ${issue.message}`;
}


export function validateProjectConfig(document, configPath) {
  const v2Keys = [
    "dynamicGroundTruth",
    "skillCorrection",
    "artifactCorrection",
    "stopCorrection",
    "implementationCorrection",
    "reviewers",
  ];
  if (document?.version === 1) {
    if (!Array.isArray(document.artifacts) || document.artifacts.length === 0) {
      throw new Error(`${configPath} must declare at least one artifact for version 1.`);
    }
    const v2Key = v2Keys.find((key) => Object.hasOwn(document, key));
    if (v2Key) {
      throw new Error(`${configPath}.${v2Key} requires version: 2.`);
    }
  }
  if (document?.version === 2) {
    const anyV2FeatureEnabled = document.dynamicGroundTruth?.enabled === true
      || document.skillCorrection?.enabled === true
      || document.stopCorrection?.enabled === true
      || document.implementationCorrection?.enabled === true
      || document.artifactCorrection?.groundTruthReviewEnabled === true
      || document.artifactCorrection?.stageMetricsEnabled === true;
    if ((!Array.isArray(document.artifacts) || document.artifacts.length === 0) && !anyV2FeatureEnabled) {
      throw new Error(`${configPath} must declare an artifact or enable a version 2 correction feature.`);
    }
    const dynamicEnabled = document.dynamicGroundTruth?.enabled === true;
    if (document.skillCorrection?.enabled === true && !dynamicEnabled) {
      throw new Error(`${configPath}.skillCorrection.enabled requires dynamicGroundTruth.enabled: true.`);
    }
    if (document.stopCorrection?.enabled === true && !dynamicEnabled) {
      throw new Error(`${configPath}.stopCorrection.enabled requires dynamicGroundTruth.enabled: true.`);
    }
    if (document.implementationCorrection?.enabled === true && !dynamicEnabled) {
      // The implementation reviewer judges against the frozen metric
      // population, which only exists when dynamic ground truth is on.
      throw new Error(`${configPath}.implementationCorrection.enabled requires dynamicGroundTruth.enabled: true.`);
    }
    if (document.artifactCorrection?.stageMetricsEnabled === true && !dynamicEnabled) {
      throw new Error(`${configPath}.artifactCorrection.stageMetricsEnabled requires dynamicGroundTruth.enabled: true.`);
    }
    if (document.artifactCorrection?.groundTruthReviewEnabled === true && !dynamicEnabled) {
      throw new Error(`${configPath}.artifactCorrection.groundTruthReviewEnabled requires dynamicGroundTruth.enabled: true.`);
    }
    const skill = document.skillCorrection;
    if (skill?.enabled === true) {
      if (!skill.selection || skill.selection.mode === undefined) {
        throw new Error(`${configPath}.skillCorrection.selection.mode must be include or all.`);
      }
      if (skill.selection.mode === "include" && (skill.selection.include?.length ?? 0) === 0) {
        throw new Error(`${configPath}.skillCorrection.selection.include cannot be empty in include mode.`);
      }
      const interval = skill.completionCheckIntervalTurns ?? 10;
      const maximum = skill.maxWatchTurns ?? 30;
      if (maximum < interval) {
        throw new Error(`${configPath}.skillCorrection.maxWatchTurns cannot be less than completionCheckIntervalTurns.`);
      }
    }
    // reviewers.modelPolicy is only a shorthand for explicit per-role
    // session/provider blocks; an active preset without a usable provider
    // (endpoint + env-var NAME) can expand to nothing, so reject it here
    // instead of silently running every role on the parent fork.
    const modelPolicy = document.reviewers?.modelPolicy;
    if (modelPolicy && (modelPolicy.preset ?? "off") !== "off") {
      const provider = modelPolicy.provider;
      const usable = provider
        && typeof provider.baseUrl === "string" && provider.baseUrl.trim() !== ""
        && typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.trim() !== "";
      if (!usable) {
        throw new Error(
          `${configPath}.reviewers.modelPolicy.provider (baseUrl + apiKeyEnv) is required when preset is "${modelPolicy.preset}".`,
        );
      }
    }
  }
  if (document?.artifacts && Array.isArray(document.artifacts)) {
    const deprecatedIndex = document.artifacts.findIndex(
      (artifact) => artifact
        && typeof artifact === "object"
        && !Array.isArray(artifact)
        && Object.hasOwn(artifact, "reviewer"),
    );
    if (deprecatedIndex >= 0) {
      throw new Error(
        `${configPath} artifacts[${deprecatedIndex}].reviewer 已停用；`
        + "请改用 review.enabled 和 review.criteria。",
      );
    }
    document.artifacts.forEach((artifact, index) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        return;
      }
      const hasPatterns = Object.hasOwn(artifact, "patterns");
      const hasPathTemplates = Object.hasOwn(artifact, "pathTemplates");
      if (hasPatterns === hasPathTemplates) {
        throw new Error(
          `${configPath} artifacts[${index}] 必须且只能声明 patterns 或 pathTemplates 之一。`,
        );
      }
    });
  }
  const issues = validateJsonSchema(document, PROJECT_CONFIG_SCHEMA);
  if (issues.length > 0) {
    throw new Error(projectConfigError(configPath, issues[0]));
  }
  return document;
}


export async function loadProjectConfigDocument(cwd) {
  const policyRoot = path.join(cwd, POLICY_ROOT_DIRECTORY);
  const configPath = path.join(policyRoot, "config.yaml");
  let contents;
  try {
    contents = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`无法读取 ${configPath}: ${error.message}`);
  }
  const document = parseSimpleYaml(contents, { source: configPath });
  validateProjectConfig(document, configPath);
  return {
    configPath,
    document,
    policyRoot,
  };
}
