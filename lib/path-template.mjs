import { normalizeSlashes } from "./path-utils.mjs";


const PLACEHOLDER_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CORRELATION_FIELDS = new Set(["keys"]);


function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}


function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
}


function assertKnownFields(value, fields, label) {
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0) {
    throw new Error(`${label} 包含未知字段：${unknown.join("、")}。`);
  }
}


export function compilePathTemplate(template, label = "pathTemplate") {
  if (typeof template !== "string" || !template.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  if (/[*?]/.test(template)) {
    throw new Error(`${label} 不能混用 glob 通配符 * 或 ?。`);
  }

  const source = normalizeSlashes(template).replace(/^\.\//, "");
  const placeholders = [];
  const seen = new Set();
  let expression = "^";
  let scanPattern = "";
  let literalStart = 0;

  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "}") {
      throw new Error(`${label} 包含未配对的 }。`);
    }
    if (character !== "{") {
      index += 1;
      continue;
    }

    const close = source.indexOf("}", index + 1);
    if (close < 0) {
      throw new Error(`${label} 包含未闭合的占位符。`);
    }
    const literal = source.slice(literalStart, index);
    const name = source.slice(index + 1, close);
    if (!PLACEHOLDER_NAME.test(name)) {
      throw new Error(
        `${label} 的占位符“${name}”必须以字母开头，且只能包含字母、数字、下划线或连字符。`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`${label} 不能重复声明占位符“${name}”。`);
    }
    seen.add(name);
    placeholders.push(name);
    expression += `${escapeRegExp(literal)}([^/\\\\]+)`;
    scanPattern += `${literal}*`;
    index = close + 1;
    literalStart = index;
  }

  const trailing = source.slice(literalStart);
  expression += `${escapeRegExp(trailing)}$`;
  scanPattern += trailing;
  return Object.freeze({
    template: source,
    placeholders: Object.freeze(placeholders),
    scanPattern,
    regexp: new RegExp(expression, "iu"),
  });
}


export function compilePathTemplates(templates, label = "pathTemplates") {
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error(`${label} 必须是非空字符串列表。`);
  }
  return Object.freeze(templates.map(
    (template, index) => compilePathTemplate(template, `${label}[${index}]`),
  ));
}


export function compileArtifactPathMatcher(artifact, label = "artifact") {
  if (artifact.pathMatcher) return artifact.pathMatcher;
  const hasPatterns = artifact.patterns !== undefined;
  const hasPathTemplates = artifact.pathTemplates !== undefined;
  if (hasPatterns && hasPathTemplates) {
    throw new Error(`${label} 不能同时声明 patterns 和 pathTemplates。`);
  }
  if (!hasPatterns && !hasPathTemplates) {
    throw new Error(`${label} 必须声明 patterns 或 pathTemplates。`);
  }
  if (hasPathTemplates) {
    const templates = compilePathTemplates(
      artifact.pathTemplates,
      `${label}.pathTemplates`,
    );
    return Object.freeze({
      kind: "template",
      templates,
      scanPatterns: Object.freeze(templates.map(({ scanPattern }) => scanPattern)),
    });
  }
  const patterns = artifact.patterns;
  if (!Array.isArray(patterns) || patterns.some(
    (pattern) => typeof pattern !== "string" || !pattern,
  )) {
    throw new Error(`${label}.patterns 必须是字符串列表。`);
  }
  return Object.freeze({
    kind: "glob",
    patterns: Object.freeze([...patterns]),
    scanPatterns: Object.freeze([...patterns]),
  });
}


export function matchPathTemplates(filePath, compiledTemplates) {
  const normalized = normalizeSlashes(filePath).replace(/^\.\//, "");
  for (const compiled of compiledTemplates ?? []) {
    const match = compiled.regexp.exec(normalized);
    if (!match) continue;
    const captures = {};
    compiled.placeholders.forEach((name, index) => {
      captures[name] = match[index + 1];
    });
    return {
      template: compiled.template,
      captures,
    };
  }
  return null;
}


export function compileWorkflowCorrelation(
  correlation,
  label = "workflow.correlation",
) {
  if (correlation === undefined || correlation === null) return null;
  assertObject(correlation, label);
  assertKnownFields(correlation, CORRELATION_FIELDS, label);
  if (!Array.isArray(correlation.keys) || correlation.keys.length === 0) {
    throw new Error(`${label}.keys 必须是非空列表。`);
  }
  const seen = new Set();
  const keys = correlation.keys.map((key, index) => {
    if (typeof key !== "string" || !PLACEHOLDER_NAME.test(key)) {
      throw new Error(
        `${label}.keys[${index}] 必须以字母开头，且只能包含字母、数字、下划线或连字符。`,
      );
    }
    if (seen.has(key)) {
      throw new Error(`${label}.keys 不能包含重复 key：“${key}”。`);
    }
    seen.add(key);
    return key;
  });
  return Object.freeze({ keys: Object.freeze(keys) });
}


export function extractWorkflowInstance(captures, correlation, label = "artifact path") {
  if (!correlation) return null;
  const instance = {};
  for (const key of correlation.keys) {
    const value = captures?.[key];
    if (typeof value !== "string" || !value || /[/\\]/.test(value)) {
      throw new Error(`${label} 无法提取 workflow correlation key：“${key}”。`);
    }
    instance[key] = value;
  }
  return instance;
}


export function normalizeWorkflowInstance(instance, correlation, label = "instance") {
  if (!correlation) return null;
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    throw new Error(
      `${label} 必须是包含 correlation keys（${correlation.keys.join("、")}）的对象。`,
    );
  }
  const normalized = {};
  for (const key of correlation.keys) {
    const value = instance[key];
    if (typeof value !== "string" || !value || /[/\\]/.test(value)) {
      throw new Error(`${label} 必须包含非空、无路径分隔符的 correlation key：“${key}”。`);
    }
    normalized[key] = value;
  }
  return normalized;
}


export function workflowInstancesEqual(left, right, correlation) {
  if (!correlation) return true;
  if (!left || !right) return false;
  return correlation.keys.every(
    (key) => left[key].toLowerCase() === right[key].toLowerCase(),
  );
}


export function assertArtifactCorrelationCoverage({
  artifacts,
  reviewGraph,
  correlation,
  label = "workflow.correlation",
}) {
  if (!correlation || !reviewGraph) return;
  const participating = new Set(
    reviewGraph.edges.flatMap((edge) => [edge.from, edge.to]),
  );
  for (const artifact of artifacts) {
    if (!participating.has(artifact.nodeId)) continue;
    if (artifact.pathMatcher?.kind !== "template") {
      throw new Error(
        `${label} 已启用时，workflow artifact“${artifact.nodeId}”必须使用 pathTemplates。`,
      );
    }
    for (const compiled of artifact.pathMatcher.templates) {
      const missing = correlation.keys.filter(
        (key) => !compiled.placeholders.includes(key),
      );
      if (missing.length > 0) {
        throw new Error(
          `${label} 要求 artifact“${artifact.nodeId}”的每个 pathTemplate`
          + ` 都包含：${missing.join("、")}。`,
        );
      }
    }
  }
}
