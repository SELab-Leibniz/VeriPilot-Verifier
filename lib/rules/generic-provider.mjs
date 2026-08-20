import {
  diagnoseJsonSchemaRule,
  diagnoseRequiredArtifacts,
} from "./generic-validator.mjs";
import { createUnifiedDiff } from "../unified-diff.mjs";


function normalizeHeadingText(text) {
  return text
    .replace(/[*_`~]/g, "")
    .replace(/^\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十百]+)[.、．\s]+/, "")
    .trim()
    .toLocaleLowerCase();
}


function slugifyHeading(text) {
  return normalizeHeadingText(text)
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/g, "-");
}


function parseMarkdown(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        normalizedText: normalizeHeadingText(match[2]),
        line: index + 1,
        lineIndex: index,
      });
    }
  }

  const anchors = new Set();
  const anchorCounts = new Map();
  for (const heading of headings) {
    const base = slugifyHeading(heading.text);
    const count = anchorCounts.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    anchorCounts.set(base, count + 1);
  }
  return { lines, headings, anchors };
}


function parsedMarkdown(artifact, state) {
  if (!state.parsedByPath.has(artifact.path)) {
    state.parsedByPath.set(artifact.path, parseMarkdown(artifact.content));
  }
  return state.parsedByPath.get(artifact.path);
}


function diagnostic({ rule, artifact, line, section, message, evidence, suggestion }) {
  return {
    ruleId: rule.id,
    severity: rule.severity ?? "warning",
    path: artifact.relativePath,
    ...(line ? { line } : {}),
    ...(section ? { section } : {}),
    message: message ?? rule.message,
    ...(evidence?.length ? { evidence } : {}),
    ...(suggestion ?? rule.suggestion ? { suggestion: suggestion ?? rule.suggestion } : {}),
  };
}


function headingMatchesRule(heading, rule) {
  const candidates = [rule.heading, ...(rule.aliases ?? [])].map(normalizeHeadingText);
  return candidates.includes(heading.normalizedText);
}


function findHeading(parsed, expected, requiredSectionRules) {
  const expectedNormalized = normalizeHeadingText(expected);
  const sectionRule = requiredSectionRules.find((rule) => (
    [rule.heading, ...(rule.aliases ?? [])]
      .map(normalizeHeadingText)
      .includes(expectedNormalized)
  ));
  const matchingHeadings = parsed.headings.filter((heading) => (
    sectionRule
      ? headingMatchesRule(heading, sectionRule)
      : heading.normalizedText === expectedNormalized
  ));
  return matchingHeadings.find((heading) => heading.level === sectionRule?.level)
    ?? matchingHeadings[0];
}


function sectionBody(parsed, heading) {
  const headingIndex = parsed.headings.indexOf(heading);
  const nextPeer = parsed.headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= heading.level);
  return parsed.lines
    .slice(heading.lineIndex + 1, nextPeer?.lineIndex ?? parsed.lines.length)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}


function countPatternMatches(content, rule) {
  const flagSet = new Set((rule.flags ?? "im").replaceAll("g", ""));
  flagSet.add("g");
  const pattern = new RegExp(rule.pattern, [...flagSet].join(""));
  return [...content.matchAll(pattern)].length;
}


function matchesPattern(content, pattern, flags = "im") {
  const flagSet = new Set(flags.replaceAll("g", ""));
  return new RegExp(pattern, [...flagSet].join("")).test(content);
}


function lineNumberAt(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}


function optionalRuleId(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value;
}


function evaluateRequiredHeading(rule, { artifact, state }) {
  const parsed = parsedMarkdown(artifact, state);
  const matchingHeadings = parsed.headings.filter((candidate) => headingMatchesRule(candidate, rule));
  const expectedLevels = rule.levels ?? (rule.level ? [rule.level] : []);
  const matchingLevelHeadings = expectedLevels.length > 0
    ? matchingHeadings.filter((candidate) => expectedLevels.includes(candidate.level))
    : matchingHeadings;
  const heading = matchingLevelHeadings[0] ?? matchingHeadings[0];
  if (!heading) {
    const missingSections = state.missingSectionsByPath.get(artifact.path) ?? [];
    missingSections.push(rule);
    state.missingSectionsByPath.set(artifact.path, missingSections);
    return [diagnostic({
      rule,
      artifact,
      message: rule.message ?? `文档缺少“${rule.heading}”章节。`,
      suggestion: `增加 ${"#".repeat(rule.level ?? 2)} ${rule.heading} 并补充内容。`,
    })];
  }

  const diagnostics = [];
  if (!rule.allowMultiple && matchingLevelHeadings.length > 1) {
    diagnostics.push({
      ruleId: `${rule.id}-DUPLICATE`,
      severity: rule.severity ?? "error",
      path: artifact.relativePath,
      section: heading.text,
      message: `“${rule.heading}”章节重复出现 ${matchingLevelHeadings.length} 次。`,
      evidence: matchingLevelHeadings.map((candidate) => `${candidate.text}:L${candidate.line}`),
      suggestion: "合并重复章节并只保留一个 H2 标题，不要通过复制章节来修复顺序。",
    });
  }

  if (expectedLevels.length > 0 && !expectedLevels.includes(heading.level)) {
    const expectedLabel = expectedLevels.map((level) => `H${level}`).join(" 或 ");
    const suggestedLevel = expectedLevels[0];
    diagnostics.push({
      ruleId: `${rule.id}-LEVEL`,
      severity: rule.severity ?? "error",
      path: artifact.relativePath,
      line: heading.line,
      section: heading.text,
      message: `“${heading.text}”应使用 ${expectedLabel}，当前为 H${heading.level}。`,
      suggestion: `将标题调整为 ${"#".repeat(suggestedLevel)} ${heading.text}。`,
    });
  }

  if (!sectionBody(parsed, heading)) {
    diagnostics.push({
      ruleId: rule.emptyRuleId ?? `${rule.id}-EMPTY`,
      severity: rule.severity ?? "error",
      path: artifact.relativePath,
      line: heading.line,
      section: heading.text,
      message: `“${heading.text}”章节没有有效内容。`,
      suggestion: "补充本章节内容。",
    });
  }
  return diagnostics;
}


function evaluateSectionOrder(rule, { artifact, state }) {
  const parsed = parsedMarkdown(artifact, state);
  const orderedHeadings = rule.headings
    .map((expected) => findHeading(parsed, expected, state.requiredSectionRules))
    .filter(Boolean);
  const outOfOrder = orderedHeadings.some(
    (heading, index) => index > 0 && heading.line < orderedHeadings[index - 1].line,
  );
  if (!outOfOrder) return [];
  return [{
    ruleId: rule.id,
    severity: rule.severity ?? "error",
    path: artifact.relativePath,
    message: rule.message ?? "文档章节顺序不符合约定。",
    evidence: orderedHeadings.map((heading) => `${heading.text}:L${heading.line}`),
    suggestion: rule.suggestion ?? "按纠偏 criteria 声明的顺序排列一级章节。",
  }];
}


function evaluateRequiredPattern(rule, { artifact, state }) {
  const parsed = parsedMarkdown(artifact, state);
  let content = artifact.content;
  let section;
  if (rule.section) {
    const heading = findHeading(parsed, rule.section, state.requiredSectionRules);
    if (!heading) return [];
    section = heading.text;
    content = sectionBody(parsed, heading);
  }
  const actual = countPatternMatches(content, rule);
  const minimum = rule.minMatches ?? 1;
  if (actual >= minimum) return [];
  return [{
    ruleId: rule.id,
    severity: rule.severity ?? "error",
    path: artifact.relativePath,
    ...(section ? { section } : {}),
    message: rule.message ?? `文档结构元素数量不足：至少 ${minimum} 个，当前 ${actual} 个。`,
    evidence: [`expected>=${minimum}`, `actual=${actual}`],
    ...(rule.suggestion ? { suggestion: rule.suggestion } : {}),
  }];
}


function evaluateConditionalRequirement(rule, { artifact }) {
  const triggerPatterns = rule.whenAnyOfPatterns ?? [];
  const applies = triggerPatterns.length === 0
    || triggerPatterns.some((pattern) => matchesPattern(artifact.content, pattern, rule.flags));
  if (!applies) return [];

  const anyPatterns = rule.requireAnyOfPatterns ?? [];
  const allPatterns = rule.requireAllOfPatterns ?? [];
  const satisfiesAny = anyPatterns.length === 0
    || anyPatterns.some((pattern) => matchesPattern(artifact.content, pattern, rule.flags));
  const satisfiesAll = allPatterns.every(
    (pattern) => matchesPattern(artifact.content, pattern, rule.flags),
  );
  return satisfiesAny && satisfiesAll ? [] : [diagnostic({ rule, artifact })];
}


function evaluateHeadingJump(rule, { artifact, state }) {
  const parsed = parsedMarkdown(artifact, state);
  const diagnostics = [];
  for (let index = 1; index < parsed.headings.length; index += 1) {
    const previous = parsed.headings[index - 1];
    const current = parsed.headings[index];
    if (current.level <= previous.level + 1) continue;
    diagnostics.push({
      ruleId: rule.id,
      severity: "warning",
      path: artifact.relativePath,
      line: current.line,
      section: current.text,
      message: `标题层级从 H${previous.level} 跳到了 H${current.level}。`,
      evidence: [parsed.lines[current.lineIndex]],
      suggestion: "调整标题层级，避免跨级。",
    });
  }
  return diagnostics;
}


function evaluateBrokenAnchor(rule, { artifact, state }) {
  const parsed = parsedMarkdown(artifact, state);
  const diagnostics = [];
  for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
    const line = parsed.lines[lineIndex];
    const linkPattern = /\[[^\]]+\]\(#([^)]+)\)/g;
    for (const link of line.matchAll(linkPattern)) {
      let anchor;
      try {
        anchor = decodeURIComponent(link[1]).toLocaleLowerCase();
      } catch {
        anchor = link[1].toLocaleLowerCase();
      }
      if (parsed.anchors.has(anchor)) continue;
      diagnostics.push({
        ruleId: rule.id,
        severity: "error",
        path: artifact.relativePath,
        line: lineIndex + 1,
        message: `文档内锚点“#${link[1]}”没有对应标题。`,
        evidence: [line.trim()],
        suggestion: "修正链接目标或补充对应标题。",
      });
    }
  }
  return diagnostics;
}


function evaluateForbiddenPattern(rule, { artifact, state }) {
  const parsed = parsedMarkdown(artifact, state);
  const flags = (rule.flags ?? "i").replaceAll("g", "");
  const pattern = new RegExp(rule.pattern, flags);
  const diagnostics = [];
  for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
    if (!pattern.test(parsed.lines[lineIndex])) continue;
    diagnostics.push(diagnostic({
      rule,
      artifact,
      line: lineIndex + 1,
      evidence: [parsed.lines[lineIndex].trim()],
    }));
  }
  return diagnostics;
}


function evaluateDuplicateId(rule, { artifacts }) {
  const declarations = new Map();
  const flags = rule.flags?.includes("g") ? rule.flags : `${rule.flags ?? "im"}g`;
  for (const artifact of artifacts) {
    const pattern = new RegExp(rule.pattern, flags);
    for (const match of artifact.content.matchAll(pattern)) {
      const identifier = match[rule.captureGroup ?? 1];
      if (!identifier) continue;
      const key = identifier.toLocaleLowerCase();
      const locations = declarations.get(key) ?? [];
      locations.push({
        artifact,
        line: lineNumberAt(artifact.content, match.index ?? 0),
        identifier,
      });
      declarations.set(key, locations);
    }
  }

  const diagnostics = [];
  for (const locations of declarations.values()) {
    if (locations.length < 2) continue;
    const evidence = locations.map((location) => `${location.artifact.relativePath}:${location.line}`);
    for (const location of locations) {
      diagnostics.push(diagnostic({
        rule,
        artifact: location.artifact,
        line: location.line,
        message: `${rule.message} 重复 ID：${location.identifier}。`,
        evidence,
        suggestion: "为每个需求声明唯一 ID，引用已有 ID 时不要再次使用声明语法。",
      }));
    }
  }
  return diagnostics;
}


function createAppendPatch(artifact, sections) {
  if (sections.length === 0) return null;
  const newline = artifact.content.includes("\r\n")
    ? "\r\n"
    : artifact.content.includes("\r")
      ? "\r"
      : "\n";
  const additions = [];
  if (artifact.content.length > 0) additions.push("");
  for (const section of sections) {
    additions.push(`${"#".repeat(section.level ?? section.levels?.[0] ?? 2)} ${section.heading}`);
    additions.push("");
    additions.push(...(section.template ?? ["<!-- 请根据纠偏诊断补充本节内容。 -->"]));
    additions.push("");
  }
  if (additions.at(-1) === "") additions.pop();
  const hasFinalLineBreak = /(?:\r\n|\r|\n)$/.test(artifact.content);
  const separator = artifact.content && !hasFinalLineBreak ? newline : "";
  const proposedContent = `${artifact.content}${separator}${additions.join(newline)}${newline}`;
  return createUnifiedDiff({
    relativePath: artifact.relativePath,
    original: artifact.content,
    proposed: proposedContent,
  });
}


function createMissingSectionPatches(artifacts, state) {
  const diffs = [];
  for (const artifact of artifacts) {
    const patch = createAppendPatch(
      artifact,
      state.missingSectionsByPath.get(artifact.path) ?? [],
    );
    if (patch) diffs.push(patch);
  }
  return diffs;
}


export const GENERIC_RULE_DEFINITIONS = [
  {
    type: "require-heading",
    compile(rule, {
      addRule,
      base,
      optionalStringArray,
      rulesFile,
    }) {
      if (!rule.heading || typeof rule.heading !== "string") {
        throw new Error(`${rulesFile} 规则 ${rule.id} 缺少 heading。`);
      }
      if (rule.level !== undefined
        && (!Number.isInteger(rule.level) || rule.level < 1 || rule.level > 6)) {
        throw new Error(`${rulesFile} 规则 ${rule.id} 的 level 必须是 1 到 6 的整数。`);
      }
      addRule({
        ...base,
        type: "require-heading",
        scope: "trigger",
        phase: 10,
        heading: rule.heading,
        aliases: optionalStringArray(rule.aliases, `${rulesFile} 规则 ${rule.id} 的 aliases`),
        level: rule.level ?? 2,
        emptyRuleId: optionalRuleId(
          rule.emptyRuleId,
          `${rule.id}-EMPTY`,
          `${rulesFile} 规则 ${rule.id} 的 emptyRuleId`,
        ),
        template: optionalStringArray(rule.template, `${rulesFile} 规则 ${rule.id} 的 template`),
        message: rule.message ?? `文档缺少“${rule.heading}”章节。`,
        suggestion: rule.suggestion ?? `增加“${rule.heading}”章节并补充有效内容。`,
      });
    },
    evaluate: evaluateRequiredHeading,
  },
  {
    type: "require-checklist",
    compile(rule, {
      addRule,
      base,
      optionalStringArray,
      rulesFile,
    }) {
      const heading = rule.under ?? rule.heading;
      if (!heading || typeof heading !== "string") {
        throw new Error(`${rulesFile} 规则 ${rule.id} 缺少 under。`);
      }
      if (rule.minimum !== undefined
        && (!Number.isInteger(rule.minimum) || rule.minimum < 1)) {
        throw new Error(`${rulesFile} 规则 ${rule.id} 的 minimum 必须是正整数。`);
      }
      addRule({
        ...base,
        id: `${rule.id}-SECTION`,
        type: "require-heading",
        scope: "trigger",
        phase: 10,
        heading,
        aliases: optionalStringArray(rule.aliases, `${rulesFile} 规则 ${rule.id} 的 aliases`),
        level: rule.level ?? 2,
        emptyRuleId: optionalRuleId(
          rule.emptyRuleId,
          `${rule.id}-SECTION-EMPTY`,
          `${rulesFile} 规则 ${rule.id} 的 emptyRuleId`,
        ),
        template: optionalStringArray(
          rule.template ?? ["- [ ] 核心流程具有明确输入、操作和可观察结果"],
          `${rulesFile} 规则 ${rule.id} 的 template`,
        ),
        message: `文档缺少“${heading}”章节。`,
        suggestion: `增加“${heading}”章节。`,
      });
      addRule({
        ...base,
        type: "require-pattern",
        scope: "trigger",
        phase: 30,
        pattern: "^-\\s+\\[[ xX]\\]\\s+\\S",
        flags: "m",
        section: heading,
        minMatches: rule.minimum ?? 1,
        message: rule.message ?? `“${heading}”中缺少可勾选的检查项。`,
        suggestion: rule.suggestion ?? "增加使用“- [ ]”格式、包含可观察结果的检查项。",
      });
    },
  },
  {
    type: "require-text",
    compile(rule, {
      addRule,
      base,
      escapeRegExp,
      ruleValues,
    }) {
      const values = ruleValues(rule);
      addRule({
        ...base,
        type: "require-pattern",
        scope: "trigger",
        phase: 30,
        pattern: values.map(escapeRegExp).join("|"),
        flags: rule.caseSensitive ? "m" : "im",
        message: rule.message ?? `文档至少需要包含以下内容之一：${values.join("、")}。`,
        suggestion: rule.suggestion ?? "补充规则要求的明确内容。",
      });
    },
  },
  {
    type: "forbid-text",
    compile(rule, {
      addRule,
      base,
      escapeRegExp,
      ruleValues,
    }) {
      const values = ruleValues(rule);
      addRule({
        ...base,
        type: "forbid-pattern",
        scope: "artifact",
        phase: 70,
        pattern: values.map(escapeRegExp).join("|"),
        flags: rule.caseSensitive === false ? "im" : "m",
        message: rule.message ?? `文档包含不允许保留的内容：${values.join("、")}。`,
        suggestion: rule.suggestion ?? "删除或补全相关内容。",
      });
    },
  },
  {
    type: "require-artifacts",
    compile(rule, {
      addRule,
      base,
      rulesFile,
      stringArray,
    }) {
      addRule({
        ...base,
        type: "require-artifacts",
        scope: "bundle",
        phase: 90,
        artifacts: stringArray(rule.artifacts, `${rulesFile} 规则 ${rule.id} 的 artifacts`),
        pendingUntilComplete: rule.pendingUntilComplete !== false,
      });
    },
    evaluate: (rule, { artifacts }) => diagnoseRequiredArtifacts(artifacts, rule),
  },
  {
    type: "json-schema",
    async compile(rule, {
      addRule,
      base,
      loadProjectSchema,
      rulesFile,
    }) {
      if (!rule.artifact || typeof rule.artifact !== "string") {
        throw new Error(`${rulesFile} 规则 ${rule.id} 缺少 artifact。`);
      }
      const schema = await loadProjectSchema(rule.schema, rule.id);
      addRule({
        ...base,
        type: "json-schema",
        scope: "bundle",
        phase: 100,
        artifact: rule.artifact,
        schemaPath: schema.schemaPath,
        schema: schema.document,
      });
    },
    evaluate: (rule, { artifacts }) => diagnoseJsonSchemaRule(artifacts, rule),
  },
  {
    type: "section-order",
    evaluate: evaluateSectionOrder,
  },
  {
    type: "require-pattern",
    evaluate: evaluateRequiredPattern,
  },
  {
    type: "conditional-requirement",
    evaluate: evaluateConditionalRequirement,
  },
  {
    type: "markdown-heading-jump",
    evaluate: evaluateHeadingJump,
  },
  {
    type: "markdown-broken-anchor",
    evaluate: evaluateBrokenAnchor,
  },
  {
    type: "forbid-pattern",
    evaluate: evaluateForbiddenPattern,
  },
  {
    type: "duplicate-id",
    evaluate: evaluateDuplicateId,
  },
  {
    type: "markdown-missing-section-fixes",
    proposeFixes: (rule, { artifacts, state }) => createMissingSectionPatches(artifacts, state),
  },
];
