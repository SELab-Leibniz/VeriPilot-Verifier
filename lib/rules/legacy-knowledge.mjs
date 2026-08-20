const LEGACY_RULE_GROUPS = [
  ["requiredSections", "require-heading", "trigger", 10],
  ["sectionOrder", "section-order", "trigger", 20],
  ["requiredPatterns", "require-pattern", "trigger", 30],
  ["conditionalRequirements", "conditional-requirement", "trigger", 40],
  ["forbiddenPatterns", "forbid-pattern", "artifact", 70],
  ["idDeclarationPatterns", "duplicate-id", "bundle", 80],
];


function extensionRule(rule) {
  return {
    ...rule,
    scope: "bundle",
    phase: rule.type === "require-artifacts" ? 90 : 100,
  };
}


export function normalizeRuleSet(knowledge = {}) {
  if (Array.isArray(knowledge.rules)) {
    return {
      ids: knowledge.ids ?? [],
      ruleSummaries: knowledge.ruleSummaries ?? [],
      rules: knowledge.rules,
    };
  }

  const rules = [];
  for (const [field, type, scope, phase] of LEGACY_RULE_GROUPS) {
    for (const rule of knowledge[field] ?? []) {
      rules.push({ ...rule, type, scope, phase });
    }
  }
  rules.push(...(knowledge.validators ?? []).map(extensionRule));
  return {
    ids: knowledge.ids ?? [],
    ruleSummaries: knowledge.ruleSummaries ?? [],
    rules,
  };
}


export function mergeLegacyKnowledge(documents) {
  const merged = {
    ids: [],
    requiredSections: [],
    sectionOrder: [],
    requiredPatterns: [],
    conditionalRequirements: [],
    forbiddenPatterns: [],
    idDeclarationPatterns: [],
    validators: [],
  };

  for (const document of documents) {
    merged.ids.push(document.id);
    for (const [field] of LEGACY_RULE_GROUPS) {
      merged[field].push(...(document[field] ?? []));
    }
    merged.validators.push(...(document.validators ?? []));
  }
  return normalizeRuleSet(merged);
}
