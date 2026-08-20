import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSimpleYaml } from "../simple-yaml.mjs";


const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");


export class StageCatalog {
  constructor(descriptors, { artifactOutputKeys = {} } = {}) {
    this.descriptors = descriptors.map((descriptor) => ({ ...descriptor }));
    this.byId = new Map(this.descriptors.map((descriptor) => [descriptor.id, descriptor]));
    this.artifactOutputKeys = new Map(Object.entries(artifactOutputKeys));
  }

  list() {
    return this.descriptors.map((descriptor) => ({ ...descriptor }));
  }

  ids() {
    return this.descriptors.map((descriptor) => descriptor.id);
  }

  get(stage) {
    return this.byId.get(stage) ?? null;
  }

  specificationName(stage) {
    return this.get(stage)?.specification ?? "custom-stage";
  }

  templateName(stage) {
    return this.get(stage)?.template ?? stage;
  }

  outputKeyForArtifactType(artifactType) {
    return this.artifactOutputKeys.get(artifactType) ?? null;
  }

  initializationMessage(stage) {
    return this.get(stage)?.initializationMessage
      ?? `可以直接加载插件并让 Agent 生成 ${stage} 产物；确定性规则与 Agent reviewer 均位于项目内 .runtime-corrector。`;
  }
}


export async function loadStageCatalog({
  catalogPath = path.join(MODULE_ROOT, "config", "runtime.yaml"),
} = {}) {
  const contents = await fs.readFile(catalogPath, "utf8");
  const document = parseSimpleYaml(contents, { source: catalogPath });
  if (document.version !== 1 || !Array.isArray(document.stages)) {
    throw new Error(`${catalogPath} 必须包含 version: 1 和 stages 列表。`);
  }
  const descriptors = document.stages.map((descriptor, index) => {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error(`${catalogPath} stages[${index}] 必须是对象。`);
    }
    if (typeof descriptor.id !== "string" || !descriptor.id.trim()) {
      throw new Error(`${catalogPath} stages[${index}] 缺少 id。`);
    }
    return descriptor;
  });
  if (new Set(descriptors.map((descriptor) => descriptor.id)).size !== descriptors.length) {
    throw new Error(`${catalogPath} 不能包含重复的 stage id。`);
  }
  const artifactOutputKeys = document.artifactOutputKeys ?? {};
  if (!artifactOutputKeys
    || typeof artifactOutputKeys !== "object"
    || Array.isArray(artifactOutputKeys)) {
    throw new Error(`${catalogPath} artifactOutputKeys 必须是对象。`);
  }
  return new StageCatalog(descriptors, { artifactOutputKeys });
}


export const DEFAULT_STAGE_CATALOG = await loadStageCatalog();
