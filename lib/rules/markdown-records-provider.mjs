import { valueAtJsonPointer } from "../json-pointer.mjs";
import { createUnifiedDiff } from "../unified-diff.mjs";
import { artifactByBasename, issue } from "./generic-validator.mjs";


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


function requiredList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是非空列表。`);
  }
  return value;
}


function regexSource(value, label) {
  const source = requiredString(value, label);
  try {
    new RegExp(source);
  } catch (error) {
    throw new Error(`${label} 不是合法正则表达式：${error.message}`);
  }
  return source;
}


function compileMarkdownRecords(rule, { addRule, base, rulesFile, stringArray }) {
  const label = `${rulesFile} 规则 ${rule.id}`;
  const records = requiredObject(rule.records, `${label} 的 records`);
  const configuredBareFields = rule.bareFields ?? [];
  if (!Array.isArray(configuredBareFields)) {
    throw new Error(`${label} 的 bareFields 必须是列表。`);
  }
  const bareFields = configuredBareFields.map((candidate, index) => {
    const field = requiredObject(candidate, `${label} 的 bareFields[${index}]`);
    return {
      id: requiredString(field.id, `${label} 的 bareFields[${index}].id`),
      labels: stringArray(field.labels, `${label} 的 bareFields[${index}].labels`),
    };
  });
  const fields = requiredList(records.fields, `${label} 的 records.fields`)
    .map((candidate, index) => {
      const fieldLabel = `${label} 的 records.fields[${index}]`;
      const field = requiredObject(candidate, fieldLabel);
      return {
        id: requiredString(field.id, `${fieldLabel}.id`),
        labels: stringArray(field.labels, `${fieldLabel}.labels`),
        ...(field.requiredPattern ? {
          requiredPattern: regexSource(field.requiredPattern, `${fieldLabel}.requiredPattern`),
        } : {}),
        ...(field.forbiddenPattern ? {
          forbiddenPattern: regexSource(field.forbiddenPattern, `${fieldLabel}.forbiddenPattern`),
        } : {}),
        invalidId: field.invalidId ?? `${field.id}-VALUE`,
      };
    });
  const expected = (records.expected ?? []).map((candidate, index) => {
    const sourceLabel = `${label} 的 records.expected[${index}]`;
    const source = requiredObject(candidate, sourceLabel);
    const artifact = requiredString(source.artifact, `${sourceLabel}.artifact`);
    if (source.pattern) {
      return { artifact, pattern: regexSource(source.pattern, `${sourceLabel}.pattern`) };
    }
    const where = source.where
      ? requiredObject(source.where, `${sourceLabel}.where`)
      : null;
    return {
      artifact,
      pointer: requiredString(source.pointer, `${sourceLabel}.pointer`),
      idField: requiredString(source.idField, `${sourceLabel}.idField`),
      ...(where ? {
        where: {
          field: requiredString(where.field, `${sourceLabel}.where.field`),
          equals: requiredString(where.equals, `${sourceLabel}.where.equals`),
        },
      } : {}),
    };
  });
  if (rule.caseSensitiveIds !== undefined && typeof rule.caseSensitiveIds !== "boolean") {
    throw new Error(`${label} 的 caseSensitiveIds 必须是布尔值。`);
  }

  addRule({
    ...base,
    type: "markdown-records",
    scope: "bundle",
    phase: 100,
    artifact: requiredString(rule.artifact, `${label} 的 artifact`),
    recordLabel: rule.recordLabel ?? "record",
    caseSensitiveIds: rule.caseSensitiveIds === true,
    placeholderPattern: rule.placeholderPattern
      ? regexSource(rule.placeholderPattern, `${label} 的 placeholderPattern`)
      : null,
    bareFields,
    records: {
      headingPattern: regexSource(records.headingPattern, `${label} 的 records.headingPattern`),
      idPattern: regexSource(records.idPattern, `${label} 的 records.idPattern`),
      idReplacement: requiredString(records.idReplacement, `${label} 的 records.idReplacement`),
      emptyId: records.emptyId ?? "RECORDS-EMPTY",
      missingId: records.missingId ?? "RECORD-MISSING",
      unexpectedId: records.unexpectedId ?? "RECORD-UNEXPECTED",
      expected,
      fields,
    },
  });
}


function flags(rule, global = false) {
  return `${global ? "g" : ""}${rule.caseSensitiveIds ? "" : "i"}`;
}


function canonicalId(value, rule) {
  const pattern = new RegExp(rule.records.idPattern, flags(rule));
  const text = String(value ?? "");
  if (!pattern.test(text)) return null;
  const normalized = text.replace(pattern, rule.records.idReplacement);
  return rule.caseSensitiveIds ? normalized : normalized.toLocaleUpperCase();
}


function recordSections(content, rule) {
  const headingPattern = new RegExp(rule.records.headingPattern, flags(rule));
  const sections = new Map();
  let current = null;
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    const match = headingPattern.exec(line);
    if (match) {
      current = canonicalId(match[1], rule);
      if (current && !sections.has(current)) sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}


function fieldValue(lines, labels) {
  const names = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `^\\s*(?:-\\s*)?(?:\\*\\*)?(?:${names.join("|")})(?:\\*\\*)?\\s*[:：]\\s*(?:\\*\\*)?(.+?)\\s*$`,
    "i",
  );
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1].replace(/\*\*\s*$/, "").trim();
  }
  return null;
}


function expectedIds(artifacts, rule) {
  const ids = new Set();
  for (const source of rule.records.expected) {
    const artifact = artifactByBasename(artifacts, source.artifact);
    if (!artifact) continue;
    if (source.pattern) {
      for (const match of artifact.content.matchAll(new RegExp(source.pattern, flags(rule, true)))) {
        const id = canonicalId(match[1], rule);
        if (id) ids.add(id);
      }
      continue;
    }
    let values;
    try {
      values = valueAtJsonPointer(JSON.parse(artifact.content), source.pointer);
    } catch {
      continue;
    }
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (source.where && value?.[source.where.field] !== source.where.equals) continue;
      const id = canonicalId(value?.[source.idField], rule);
      if (id) ids.add(id);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}


function diagnoseMarkdownRecords(artifacts, rule) {
  const diagnostics = [];
  const artifact = artifactByBasename(artifacts, rule.artifact);
  if (!artifact) return diagnostics;
  const placeholder = rule.placeholderPattern
    ? new RegExp(rule.placeholderPattern, "i")
    : null;

  if (placeholder?.test(artifact.content)) diagnostics.push(issue(
    { ...rule, id: `${rule.id}-PLACEHOLDER` },
    artifact,
    `${rule.artifact} 仍包含模板占位符，不能作为可执行契约。`,
  ));
  for (const field of rule.bareFields) {
    const names = field.labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (new RegExp(`^\\s*(?:${names.join("|")})\\s*[:：]\\s*\\S+`, "im")
      .test(artifact.content)) continue;
    diagnostics.push(issue(
      { ...rule, id: `${rule.id}-${field.id}` },
      artifact,
      `${rule.artifact} 缺少非空的 ${field.labels[0]}。`,
      [],
      `使用裸行 \`${field.labels[0]}: <value>\`；行首不得加 \`-\`、\`*\` 或 \`#\`。`,
    ));
  }

  const sections = recordSections(artifact.content, rule);
  const expected = expectedIds(artifacts, rule);
  const requiredIds = expected.length > 0 ? expected : [...sections.keys()];
  if (requiredIds.length === 0) diagnostics.push(issue(
    { ...rule, id: `${rule.id}-${rule.records.emptyId}` },
    artifact,
    `${rule.artifact} 至少需要一个 ${rule.recordLabel} 记录章节。`,
  ));
  for (const recordId of requiredIds) {
    const lines = sections.get(recordId);
    if (!lines) {
      diagnostics.push(issue(
        { ...rule, id: `${rule.id}-${rule.records.missingId}` },
        artifact,
        `${recordId} 在上游存在，但 ${rule.artifact} 没有对应章节。`,
      ));
      continue;
    }
    for (const field of rule.records.fields) {
      const value = fieldValue(lines, field.labels);
      if (!value || placeholder?.test(value)) {
        diagnostics.push(issue(
          { ...rule, id: `${rule.id}-${field.id}` },
          artifact,
          `${recordId} 缺少可执行的 ${field.labels[0]} 内容。`,
        ));
        continue;
      }
      const invalid = field.requiredPattern
        ? !new RegExp(field.requiredPattern, flags(rule)).test(value)
        : field.forbiddenPattern
          ? new RegExp(field.forbiddenPattern, flags(rule)).test(value)
          : false;
      if (invalid) diagnostics.push(issue(
        { ...rule, id: `${rule.id}-${field.invalidId}` },
        artifact,
        `${recordId} 的 ${field.labels[0]} 内容不符合约定。`,
        [value],
      ));
    }
  }
  if (expected.length > 0) {
    for (const recordId of sections.keys()) {
      if (!expected.includes(recordId)) diagnostics.push(issue(
        { ...rule, id: `${rule.id}-${rule.records.unexpectedId}` },
        artifact,
        `${recordId} 未出现在上游 ID 集合中，目标文档不应自行扩张记录。`,
      ));
    }
  }
  return diagnostics;
}


function proposeDocumentFieldFixes(rule, { artifacts, diagnostics }) {
  const artifact = artifactByBasename(artifacts, rule.artifact);
  if (!artifact) return [];
  let proposed = artifact.content;
  for (const field of rule.bareFields) {
    if (!diagnostics.some((item) => item.ruleId === `${rule.id}-${field.id}`)) continue;
    const names = field.labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    proposed = proposed.replace(
      new RegExp(
        `^(\\s*)(?:[-*]\\s+|#{2,6}\\s+)((?:${names.join("|")})\\s*[:：]\\s*\\S.*)$`,
        "gim",
      ),
      "$1$2",
    );
  }
  const patch = createUnifiedDiff({
    relativePath: artifact.relativePath,
    original: artifact.content,
    proposed,
  });
  return patch ? [patch] : [];
}


export const MARKDOWN_RECORD_RULE_DEFINITIONS = [{
  type: "markdown-records",
  compile: compileMarkdownRecords,
  evaluate: (rule, { artifacts }) => diagnoseMarkdownRecords(artifacts, rule),
  proposeFixes: proposeDocumentFieldFixes,
}];
