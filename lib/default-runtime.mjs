import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectRules } from "./policy/rules-loader.mjs";
import { DEFAULT_RULE_TYPE_REGISTRY } from "./rules/default-registry.mjs";
import { parseSimpleYaml } from "./simple-yaml.mjs";
import { buildStageSpecification } from "./stage-specification.mjs";


const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


export async function loadRuntimeDefinition(
  definitionPath = path.join(MODULE_ROOT, "config", "runtime.yaml"),
) {
  const contents = await fs.readFile(definitionPath, "utf8");
  const document = parseSimpleYaml(contents, { source: definitionPath });
  if (document.version !== 1
    || !document.defaults
    || typeof document.defaults !== "object"
    || Array.isArray(document.defaults)
    || !Array.isArray(document.baselineRules)) {
    throw new Error(
      `${definitionPath} 必须包含 version: 1、defaults 对象和 baselineRules 列表。`,
    );
  }
  return document;
}


const DEFAULT_RUNTIME_DEFINITION = await loadRuntimeDefinition();


export const DEFAULT_BASELINE_RULES = DEFAULT_RUNTIME_DEFINITION.baselineRules;
export const DEFAULT_RUNTIME_CONFIG = DEFAULT_RUNTIME_DEFINITION.defaults;


export { DEFAULT_RULE_TYPE_REGISTRY };


export async function loadDefaultRules(rulesFile) {
  return loadProjectRules(rulesFile, DEFAULT_RULE_TYPE_REGISTRY);
}


export async function buildDefaultStageSpecification(options) {
  return buildStageSpecification({
    ...options,
    loadRules: loadDefaultRules,
  });
}
