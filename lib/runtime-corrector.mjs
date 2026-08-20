import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectArtifactPathPlan,
  collectArtifactPaths,
  findPolicyRootForFile,
  globToRegExp,
  matchArtifact,
  matchConfiguredArtifact,
  matchesAny,
  readArtifacts,
  resolveInputFile,
  transcriptHasPublicCommandContext,
} from "./artifact-pipeline.mjs";
import {
  buildDefaultStageSpecification,
  DEFAULT_BASELINE_RULES,
  DEFAULT_RULE_TYPE_REGISTRY,
  loadDefaultRules,
} from "./default-runtime.mjs";
import { formatAgentFeedback } from "./feedback.mjs";
import { isPathInside } from "./path-utils.mjs";
import { loadReviewer } from "./policy/project-policy.mjs";
import {
  mergeSemanticReview,
  validateResultDiffs,
} from "./result-processing.mjs";
import {
  createRoundMetadata,
  persistResult,
} from "./result-store.mjs";
import { createRuleEngine } from "./rules/engine.mjs";
import { mergeLegacyKnowledge } from "./rules/legacy-knowledge.mjs";
import { composeRuleTypeRegistries } from "./rules/registry.mjs";
import { loadRuntimePlan } from "./runtime-plan.mjs";
import { createRuntimeService } from "./runtime-service.mjs";
import { formatStageSpecification } from "./stage-specification.mjs";


const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


export {
  collectArtifactPaths,
  findPolicyRootForFile,
  formatAgentFeedback,
  globToRegExp,
  matchArtifact,
  matchConfiguredArtifact,
  matchesAny,
  mergeSemanticReview,
  persistResult,
  readArtifacts,
  transcriptHasPublicCommandContext,
};


async function readJson(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents);
}


export async function loadConfig({ cwd, pluginRoot = MODULE_ROOT, config } = {}) {
  return loadRuntimePlan({ cwd, pluginRoot, config });
}


export async function loadKnowledge({ ids, pluginRoot = MODULE_ROOT }) {
  const knowledgeRoot = path.resolve(pluginRoot, "knowledge");
  const documents = [];
  for (const id of ids) {
    const candidate = path.resolve(knowledgeRoot, `${id}.json`);
    if (!isPathInside(knowledgeRoot, candidate)) {
      throw new Error(`非法纠偏知识 ID: ${id}`);
    }
    const document = await readJson(candidate);
    documents.push({ ...document, id: document.id ?? id });
  }
  return mergeLegacyKnowledge(documents);
}


export function createArtifactDiagnoser(ruleTypeRegistry) {
  if (!ruleTypeRegistry) {
    throw new Error("创建 artifact diagnoser 需要显式提供 ruleTypeRegistry。");
  }
  const registry = ruleTypeRegistry === DEFAULT_RULE_TYPE_REGISTRY
    ? DEFAULT_RULE_TYPE_REGISTRY
    : composeRuleTypeRegistries(
        ruleTypeRegistry,
        DEFAULT_RULE_TYPE_REGISTRY,
      );
  return createRuleEngine(registry, {
    baselineRules: DEFAULT_BASELINE_RULES,
  });
}


const diagnoseDefaultArtifacts = createArtifactDiagnoser(DEFAULT_RULE_TYPE_REGISTRY);


export function diagnoseArtifacts(options) {
  return diagnoseDefaultArtifacts(options);
}


const DEFAULT_RUNTIME_SERVICE = createRuntimeService({
  defaultPluginRoot: MODULE_ROOT,
  loadRuntimePlan: loadConfig,
  matchArtifact,
  collectArtifactPathPlan,
  matchConfiguredArtifact,
  readArtifacts,
  loadSimpleRules: loadDefaultRules,
  loadKnowledge,
  diagnoseArtifacts: diagnoseDefaultArtifacts,
  createRoundMetadata,
  loadReviewer,
  buildStageSpecification: buildDefaultStageSpecification,
  formatStageSpecification,
  mergeSemanticReview,
  validateResultDiffs,
  persistResult,
  formatAgentFeedback,
  resolveInputFile,
  findPolicyRootForFile,
  transcriptHasPublicCommandContext,
});


export async function checkArtifact(options = {}) {
  return DEFAULT_RUNTIME_SERVICE.checkArtifact(options);
}


export async function finalizeArtifactCheck(prepared, semanticReview = null) {
  return DEFAULT_RUNTIME_SERVICE.finalizeArtifactCheck(prepared, semanticReview);
}


export async function handleHook(input, options = {}) {
  return DEFAULT_RUNTIME_SERVICE.handleHook(input, options);
}
