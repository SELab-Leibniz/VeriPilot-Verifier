import path from "node:path";


const GROUND_TRUTH_ID = /^[a-z][a-z0-9-]{0,63}$/;


function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value.trim();
}


function stringList(value, label) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} 必须是非空字符串列表。`);
  }
  return value.map((item) => item.trim());
}


export function compileGroundTruthSources(value, label = "groundTruth") {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是列表。`);
  const seen = new Set();
  return value.map((source, index) => {
    const sourceLabel = `${label}[${index}]`;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`${sourceLabel} 必须是对象。`);
    }
    const id = requiredString(source.id, `${sourceLabel}.id`);
    if (!GROUND_TRUTH_ID.test(id)) {
      throw new Error(
        `${sourceLabel}.id 必须使用小写字母开头，并且只包含小写字母、`
        + "数字或连字符（最多 64 个字符）。",
      );
    }
    if (seen.has(id)) throw new Error(`${label} 的 id 不能重复：“${id}”。`);
    seen.add(id);
    if (source.required !== undefined && typeof source.required !== "boolean") {
      throw new Error(`${sourceLabel}.required 必须是布尔值。`);
    }
    const patterns = stringList(source.patterns, `${sourceLabel}.patterns`);
    const unsafePattern = patterns.find((pattern) => (
      path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")
    ));
    if (unsafePattern) {
      throw new Error(`${sourceLabel}.patterns 必须使用项目内相对路径：${unsafePattern}。`);
    }
    return Object.freeze({
      id,
      type: source.type === undefined
        ? "reference"
        : requiredString(source.type, `${sourceLabel}.type`),
      version: source.version === undefined || source.version === null
        ? null
        : String(source.version),
      authority: source.authority === undefined
        ? null
        : requiredString(source.authority, `${sourceLabel}.authority`),
      required: source.required !== false,
      patterns: Object.freeze(patterns),
    });
  });
}


export function bindArtifactGroundTruth(artifacts, sources, label = "artifacts") {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return artifacts.map((artifact, index) => {
    const refs = artifact.groundTruthRefs ?? [];
    const unknown = refs.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `${label}[${index}].groundTruth 引用了未知来源：${unknown.join("、")}。`,
      );
    }
    if (refs.length === 0) return artifact;
    return { ...artifact, groundTruthInputs: refs.map((id) => byId.get(id)) };
  });
}
