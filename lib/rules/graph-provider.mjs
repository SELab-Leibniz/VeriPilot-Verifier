import {
  artifactByBasename,
  issue,
  parseJsonArtifact,
} from "./generic-validator.mjs";
import { valueAtJsonPointer } from "../json-pointer.mjs";


function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value;
}


function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value;
}


function optionalRules(value, label, compile) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是列表。`);
  return value.map((item, index) => compile(
    requiredObject(item, `${label}[${index}]`),
    `${label}[${index}]`,
  ));
}


function compileGraphRule(rule, {
  addRule,
  base,
  rulesFile,
  stringArray,
}) {
  const label = `${rulesFile} 规则 ${rule.id}`;
  const nodes = requiredObject(rule.nodes, `${label} 的 nodes`);
  const edges = requiredObject(rule.edges, `${label} 的 edges`);
  if (rule.caseSensitiveIds !== undefined && typeof rule.caseSensitiveIds !== "boolean") {
    throw new Error(`${label} 的 caseSensitiveIds 必须是布尔值。`);
  }

  addRule({
    ...base,
    type: "graph-invariants",
    scope: "bundle",
    phase: 100,
    artifact: requiredString(rule.artifact, `${label} 的 artifact`),
    caseSensitiveIds: rule.caseSensitiveIds !== false,
    nodes: {
      pointer: requiredString(nodes.pointer ?? "/nodes", `${label} 的 nodes.pointer`),
      idField: requiredString(nodes.idField ?? "id", `${label} 的 nodes.idField`),
      typeField: requiredString(nodes.typeField ?? "type", `${label} 的 nodes.typeField`),
      typeRules: optionalRules(nodes.typeRules, `${label} 的 nodes.typeRules`, (item, itemLabel) => {
        const idPattern = requiredString(item.idPattern, `${itemLabel}.idPattern`);
        try {
          new RegExp(idPattern);
        } catch (error) {
          throw new Error(`${itemLabel}.idPattern 不是合法正则表达式：${error.message}`);
        }
        return {
          id: requiredString(item.id, `${itemLabel}.id`),
          idPattern,
          expectedType: requiredString(item.expectedType, `${itemLabel}.expectedType`),
          ...(item.message ? { message: requiredString(item.message, `${itemLabel}.message`) } : {}),
        };
      }),
    },
    edges: {
      pointer: requiredString(edges.pointer ?? "/edges", `${label} 的 edges.pointer`),
      fromField: requiredString(edges.fromField ?? "from", `${label} 的 edges.fromField`),
      toField: requiredString(edges.toField ?? "to", `${label} 的 edges.toField`),
      typeField: requiredString(edges.typeField ?? "type", `${label} 的 edges.typeField`),
      endpointRules: optionalRules(
        edges.endpointRules,
        `${label} 的 edges.endpointRules`,
        (item, itemLabel) => {
          if (item.allowSelf !== undefined && typeof item.allowSelf !== "boolean") {
            throw new Error(`${itemLabel}.allowSelf 必须是布尔值。`);
          }
          return {
            id: requiredString(item.id, `${itemLabel}.id`),
            edgeType: requiredString(item.edgeType, `${itemLabel}.edgeType`),
            fromType: requiredString(item.fromType, `${itemLabel}.fromType`),
            toType: requiredString(item.toType, `${itemLabel}.toType`),
            allowSelf: item.allowSelf !== false,
            ...(item.message ? { message: requiredString(item.message, `${itemLabel}.message`) } : {}),
          };
        },
      ),
      acyclic: optionalRules(edges.acyclic, `${label} 的 edges.acyclic`, (item, itemLabel) => ({
        id: requiredString(item.id, `${itemLabel}.id`),
        types: stringArray(item.types, `${itemLabel}.types`),
        ...(item.message ? { message: requiredString(item.message, `${itemLabel}.message`) } : {}),
      })),
    },
  });
}


function interpolate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}


function hasDirectedCycle(edges) {
  const successors = new Map();
  for (const edge of edges) {
    const values = successors.get(edge.from) ?? [];
    values.push(edge.to);
    successors.set(edge.from, values);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    if ((successors.get(node) ?? []).some(visit)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  return [...successors.keys()].some(visit);
}


function diagnoseGraphRule(artifacts, rule) {
  const diagnostics = [];
  const artifact = artifactByBasename(artifacts, rule.artifact);
  if (!artifact) return diagnostics;
  const document = parseJsonArtifact(artifact, rule, diagnostics);
  if (!document) return diagnostics;

  const nodeValues = valueAtJsonPointer(document, rule.nodes.pointer);
  const edgeValues = valueAtJsonPointer(document, rule.edges.pointer);
  if (!Array.isArray(nodeValues) || !Array.isArray(edgeValues)) {
    return [issue(
      { ...rule, id: `${rule.id}-GRAPH-STRUCTURE` },
      artifact,
      `图规则要求 ${rule.nodes.pointer} 和 ${rule.edges.pointer} 指向数组。`,
    )];
  }

  const normalizeId = rule.caseSensitiveIds
    ? (value) => String(value ?? "")
    : (value) => String(value ?? "").toLocaleUpperCase();
  const nodes = new Map();
  for (const node of nodeValues) {
    const id = normalizeId(node?.[rule.nodes.idField]);
    if (nodes.has(id)) diagnostics.push(issue(
      { ...rule, id: `${rule.id}-RELATION-NODE-DUPLICATE` },
      artifact,
      `节点 ${id} 重复。`,
    ));
    nodes.set(id, node?.[rule.nodes.typeField]);
    for (const typeRule of rule.nodes.typeRules) {
      if (!new RegExp(typeRule.idPattern).test(id)
        || node?.[rule.nodes.typeField] === typeRule.expectedType) continue;
      diagnostics.push(issue(
        { ...rule, id: `${rule.id}-${typeRule.id}` },
        artifact,
        interpolate(typeRule.message ?? "节点 {nodeId} 的类型应为 {expectedType}。", {
          nodeId: id,
          expectedType: typeRule.expectedType,
        }),
        [JSON.stringify(node)],
      ));
    }
  }

  const edgeKeys = new Set();
  const normalizedEdges = [];
  for (const edge of edgeValues) {
    const from = normalizeId(edge?.[rule.edges.fromField]);
    const to = normalizeId(edge?.[rule.edges.toField]);
    const edgeType = edge?.[rule.edges.typeField];
    const key = `${from}|${String(edgeType)}|${to}`;
    normalizedEdges.push({ from, to, type: edgeType });

    if (edgeKeys.has(key)) diagnostics.push(issue(
      { ...rule, id: `${rule.id}-RELATION-EDGE-DUPLICATE` },
      artifact,
      `边 ${key} 重复。`,
    ));
    edgeKeys.add(key);
    if (!nodes.has(from) || !nodes.has(to)) diagnostics.push(issue(
      { ...rule, id: `${rule.id}-RELATION-EDGE-REFERENCE` },
      artifact,
      `边 ${from} ${String(edgeType)} ${to} 引用了不存在的节点。`,
    ));
    for (const endpointRule of rule.edges.endpointRules) {
      if (edgeType !== endpointRule.edgeType) continue;
      const invalid = nodes.get(from) !== endpointRule.fromType
        || nodes.get(to) !== endpointRule.toType
        || (!endpointRule.allowSelf && from === to);
      if (!invalid) continue;
      diagnostics.push(issue(
        { ...rule, id: `${rule.id}-${endpointRule.id}` },
        artifact,
        interpolate(
          endpointRule.message ?? "{edgeType} 边的端点类型不符合约束：{from} -> {to}。",
          { edgeType, from, to },
        ),
      ));
    }
  }

  for (const cycleRule of rule.edges.acyclic) {
    const selected = normalizedEdges.filter((edge) => cycleRule.types.includes(edge.type));
    if (!hasDirectedCycle(selected)) continue;
    diagnostics.push(issue(
      { ...rule, id: `${rule.id}-${cycleRule.id}` },
      artifact,
      cycleRule.message ?? `边类型 ${cycleRule.types.join("、")} 存在有向环。`,
    ));
  }
  return diagnostics;
}


export const GRAPH_RULE_DEFINITIONS = [{
  type: "graph-invariants",
  compile: compileGraphRule,
  evaluate: (rule, { artifacts }) => diagnoseGraphRule(artifacts, rule),
}];
