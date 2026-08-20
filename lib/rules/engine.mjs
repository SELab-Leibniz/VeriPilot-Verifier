import { statusFromDiagnostics } from "../diagnostic-status.mjs";
import { normalizeSlashes } from "../path-utils.mjs";
import { normalizeRuleSet } from "./legacy-knowledge.mjs";


function orderedRules(rules) {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => (
      (left.rule.phase ?? 100) - (right.rule.phase ?? 100)
      || left.index - right.index
    ))
    .map(({ rule }) => rule);
}


export function createRuleEngine(ruleTypeRegistry, { baselineRules = [] } = {}) {
  if (!ruleTypeRegistry) {
    throw new Error("创建 rule engine 需要显式提供 ruleTypeRegistry。");
  }

  return function diagnoseArtifacts({
    artifacts,
    knowledge,
    stage,
    artifactType,
    triggerFile,
  }) {
    const ruleSet = normalizeRuleSet(knowledge);
    const rules = orderedRules([...ruleSet.rules, ...baselineRules]);
    const artifactRules = rules.filter((rule) => rule.scope !== "bundle");
    const bundleRules = rules.filter((rule) => rule.scope === "bundle");
    const diagnostics = [];
    const state = {
      missingSectionsByPath: new Map(),
      parsedByPath: new Map(),
      requiredSectionRules: rules.filter((rule) => rule.type === "require-heading"),
    };

    for (const artifact of artifacts) {
      for (const rule of artifactRules) {
        if (rule.scope === "trigger" && !artifact.isTrigger) continue;
        diagnostics.push(...ruleTypeRegistry.evaluate(rule, {
          artifact,
          artifacts,
          state,
        }));
      }
    }

    for (const rule of bundleRules) {
      diagnostics.push(...ruleTypeRegistry.evaluate(rule, {
        artifacts,
        state,
      }));
    }

    const diffs = [];
    for (const rule of bundleRules) {
      const fixes = ruleTypeRegistry.proposeFixes(rule, {
        artifacts,
        diagnostics,
        artifactType,
        state,
      });
      for (const fix of fixes) {
        if (!diffs.some((item) => item.path === fix.path)) diffs.push(fix);
      }
    }

    const status = statusFromDiagnostics(diagnostics);
    const hasPending = diagnostics.some((item) => item.severity === "pending");
    return {
      status,
      diagnostics,
      diffs,
      metadata: {
        stage,
        artifactType,
        triggerFile: normalizeSlashes(triggerFile),
        artifactFiles: artifacts.map((artifact) => artifact.relativePath),
        bundleComplete: !hasPending,
        ruleSetIds: ruleSet.ids,
      },
    };
  };
}
