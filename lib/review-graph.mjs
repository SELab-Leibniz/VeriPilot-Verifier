import path from "node:path";

import { isPathInside } from "./path-utils.mjs";


const WORKFLOW_FIELDS = new Set(["correlation", "edges"]);
const EDGE_FIELDS = new Set(["from", "to", "review"]);
const REVIEW_FIELDS = new Set(["enabled", "criteria"]);

export const EDGE_REVIEW_BASELINE = "检查目标产物不得违背、遗漏或无依据扩张上游产物的意图、范围、约束、决策与可追溯标识。";


function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
}


function assertKnownFields(value, allowedFields, label) {
  const unknownFields = Object.keys(value).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`${label} 包含未知字段：${unknownFields.join("、")}。`);
  }
}


function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value;
}


function resolveReviewerPath(policyRoot, configuredPath, label) {
  if (configuredPath === undefined || configuredPath === null || configuredPath === "") {
    return null;
  }
  if (typeof configuredPath !== "string") {
    throw new Error(`${label} 必须是相对路径或 null。`);
  }
  if (path.isAbsolute(configuredPath)) {
    throw new Error(`${label} 必须使用相对于 .runtime-corrector 的路径。`);
  }
  const resolved = path.resolve(policyRoot, configuredPath);
  if (!isPathInside(policyRoot, resolved)) {
    throw new Error(`${label} 不能指向 .runtime-corrector 目录之外。`);
  }
  return resolved;
}


function compileEdgeReview(configuredReview, policyRoot, label) {
  if (!configuredReview || typeof configuredReview !== "object" || Array.isArray(configuredReview)) {
    throw new Error(`${label} 必须是包含 enabled 的对象。`);
  }
  assertKnownFields(configuredReview, REVIEW_FIELDS, label);
  if (typeof configuredReview.enabled !== "boolean") {
    throw new Error(`${label}.enabled 必须显式设置为 true 或 false。`);
  }
  return {
    reviewEnabled: configuredReview.enabled,
    reviewerFile: resolveReviewerPath(
      policyRoot,
      configuredReview.criteria,
      `${label}.criteria`,
    ),
  };
}


function assertAcyclic(nodeIds, edges, label) {
  const indegree = new Map(nodeIds.map((nodeId) => [nodeId, 0]));
  const outgoing = new Map(nodeIds.map((nodeId) => [nodeId, []]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const ready = nodeIds.filter((nodeId) => indegree.get(nodeId) === 0);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const nodeId = ready[index];
    visited += 1;
    for (const target of outgoing.get(nodeId)) {
      const nextIndegree = indegree.get(target) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) ready.push(target);
    }
  }

  if (visited !== nodeIds.length) {
    throw new Error(`${label} 必须是有向无环图，不能包含环。`);
  }
}


export class ReviewGraph {
  #incomingByTarget;

  constructor(edges) {
    this.edges = Object.freeze(edges.map((edge) => Object.freeze({ ...edge })));
    this.#incomingByTarget = new Map();
    for (const edge of this.edges) {
      const incoming = this.#incomingByTarget.get(edge.to) ?? [];
      incoming.push(edge);
      this.#incomingByTarget.set(edge.to, incoming);
    }
  }

  incomingEdges(targetNodeId) {
    return [...(this.#incomingByTarget.get(targetNodeId) ?? [])];
  }
}


export function compileReviewGraph({
  workflow,
  artifacts,
  policyRoot,
  configPath = path.join(policyRoot, "config.yaml"),
}) {
  if (workflow === undefined || workflow === null) return null;

  const workflowLabel = `${configPath} workflow`;
  assertObject(workflow, workflowLabel);
  assertKnownFields(workflow, WORKFLOW_FIELDS, workflowLabel);
  if (!Array.isArray(workflow.edges)) {
    throw new Error(`${workflowLabel}.edges 必须是列表。`);
  }
  if (workflow.edges.length === 0) return null;

  const nodeIds = artifacts.map((artifact, index) => requiredString(
    artifact.nodeId,
    `${configPath} artifacts[${index}].name`,
  ));
  const seenNodeIds = new Set();
  for (const nodeId of nodeIds) {
    if (seenNodeIds.has(nodeId)) {
      throw new Error(`${configPath} artifacts[].name 不能重复：“${nodeId}”。`);
    }
    seenNodeIds.add(nodeId);
  }

  const seenEdges = new Set();
  const edges = workflow.edges.map((configuredEdge, index) => {
    const edgeLabel = `${workflowLabel}.edges[${index}]`;
    assertObject(configuredEdge, edgeLabel);
    assertKnownFields(configuredEdge, EDGE_FIELDS, edgeLabel);
    const from = requiredString(configuredEdge.from, `${edgeLabel}.from`);
    const to = requiredString(configuredEdge.to, `${edgeLabel}.to`);
    if (!seenNodeIds.has(from)) {
      throw new Error(`${edgeLabel}.from 引用了未知 artifact：“${from}”。`);
    }
    if (!seenNodeIds.has(to)) {
      throw new Error(`${edgeLabel}.to 引用了未知 artifact：“${to}”。`);
    }
    if (from === to) {
      throw new Error(`${edgeLabel} 不能连接 artifact 自身：“${from}”。`);
    }
    const edgeKey = JSON.stringify([from, to]);
    if (seenEdges.has(edgeKey)) {
      throw new Error(`${workflowLabel}.edges 不能包含重复边：“${from}” -> “${to}”。`);
    }
    seenEdges.add(edgeKey);
    const review = compileEdgeReview(
      configuredEdge.review,
      policyRoot,
      `${edgeLabel}.review`,
    );
    return {
      from,
      to,
      ...review,
    };
  });

  assertAcyclic(nodeIds, edges, workflowLabel);
  return new ReviewGraph(edges);
}
