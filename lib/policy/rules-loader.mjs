import { promises as fs } from "node:fs";
import path from "node:path";

import { assertSupportedJsonSchema } from "../json-schema-validator.mjs";
import { parseSimpleYaml } from "../simple-yaml.mjs";
import { resolvePolicyPath } from "./policy-path.mjs";
import {
  optionalStringArray,
  stringArray,
} from "./policy-values.mjs";


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function baseRule(rule, rulesFile, index) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error(`${rulesFile} rules[${index}] 必须是对象。`);
  }
  if (!rule.id || typeof rule.id !== "string") {
    throw new Error(`${rulesFile} rules[${index}] 缺少 id。`);
  }
  if (!rule.type || typeof rule.type !== "string") {
    throw new Error(`${rulesFile} 规则 ${rule.id} 缺少 type。`);
  }
  const severity = rule.severity ?? "error";
  if (!new Set(["error", "warning", "info"]).has(severity)) {
    throw new Error(
      `${rulesFile} 规则 ${rule.id} 的 severity 必须是 error、warning 或 info。`,
    );
  }
  return {
    id: rule.id,
    severity,
    ...(rule.message ? { message: rule.message } : {}),
    ...(rule.suggestion ? { suggestion: rule.suggestion } : {}),
  };
}


function ruleValues(rule, rulesFile) {
  const values = rule.values ?? (rule.text ? [rule.text] : null);
  return stringArray(values, `${rulesFile} 规则 ${rule.id} 的 values`);
}


async function loadProjectSchema(rulesFile, configuredPath, ruleId) {
  if (!configuredPath || typeof configuredPath !== "string") {
    throw new Error(`${rulesFile} 规则 ${ruleId} 缺少 schema。`);
  }
  const schemaPath = resolvePolicyPath(
    path.dirname(rulesFile),
    configuredPath,
    "schema",
  );
  let document;
  try {
    document = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON Schema ${schemaPath}: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${schemaPath} 顶层必须是 JSON 对象。`);
  }
  assertSupportedJsonSchema(document, schemaPath);
  return { schemaPath, document };
}


export async function loadProjectRules(rulesFile, ruleTypeRegistry) {
  if (!ruleTypeRegistry) {
    throw new Error("加载项目规则需要显式提供 ruleTypeRegistry。");
  }
  let contents;
  try {
    contents = await fs.readFile(rulesFile, "utf8");
  } catch (error) {
    throw new Error(`无法读取规则文件 ${rulesFile}: ${error.message}`);
  }
  const document = parseSimpleYaml(contents, { source: rulesFile });
  if (document.version !== 1 || !Array.isArray(document.rules)) {
    throw new Error(`${rulesFile} 必须包含 version: 1 和 rules 列表。`);
  }

  const ruleSet = {
    ids: [`project:${path.basename(rulesFile)}`],
    ruleSummaries: [],
    rules: [],
  };
  const seenIds = new Set();
  for (let index = 0; index < document.rules.length; index += 1) {
    const rule = document.rules[index];
    const base = baseRule(rule, rulesFile, index);
    if (seenIds.has(rule.id)) {
      throw new Error(`${rulesFile} 规则 ID“${rule.id}”重复。`);
    }
    seenIds.add(rule.id);
    ruleSet.ruleSummaries.push({
      id: rule.id,
      type: rule.type,
      severity: base.severity,
      enabled: rule.enabled !== false,
      ...(rule.heading ? { heading: rule.heading } : {}),
      ...(rule.under ? { under: rule.under } : {}),
      ...(rule.minimum ? { minimum: rule.minimum } : {}),
      ...(rule.values ? { values: rule.values } : {}),
      ...(rule.artifact ? { artifact: rule.artifact } : {}),
      ...(rule.artifacts ? { artifacts: rule.artifacts } : {}),
      ...(rule.schema ? { configuredSchema: rule.schema } : {}),
    });
    if (rule.enabled === false) continue;

    const compiled = await ruleTypeRegistry.compile(rule, {
      addRule: (compiledRule) => ruleSet.rules.push(compiledRule),
      base,
      escapeRegExp,
      loadProjectSchema: (configuredPath, ruleId) => (
        loadProjectSchema(rulesFile, configuredPath, ruleId)
      ),
      optionalStringArray,
      rulesFile,
      ruleValues: (candidate) => ruleValues(candidate, rulesFile),
      stringArray,
    });
    if (!compiled) {
      throw new Error(
        `${rulesFile} 规则 ${rule.id} 使用了不支持的类型“${rule.type}”。`,
      );
    }
  }
  return ruleSet;
}
