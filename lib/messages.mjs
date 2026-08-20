// Two-locale (zh/en) message catalog for the highest-visibility
// developer-facing strings: the delivered-diagnostic scaffolding in
// feedback.mjs and the deterministic kit-integration finding in
// impl-review.mjs. The active locale comes from the project config key
// `locale` (default "zh"); unknown locales fall back to the default.
//
// This is deliberately NOT a full string extraction — only strings the
// developer sees on every delivered diagnostic are covered. Add keys here
// only when a string has comparable visibility.

export const DEFAULT_LOCALE = "zh";
export const SUPPORTED_LOCALES = Object.freeze(["zh", "en"]);

const CATALOG = {
  zh: {
    "feedback.header": "[runtime-corrector] {artifactType} 纠偏诊断：{status}",
    "feedback.triggerFile": "触发文件：{file}",
    "feedback.knowledge": "纠偏知识：{ruleSets}",
    "feedback.none": "无",
    "feedback.configSource": "配置来源：{source}",
    "feedback.noDeviations": "未发现违反当前纠偏知识的内容。无需修改。",
    "feedback.diagnosticsHeading": "诊断结果：",
    "feedback.diagnosticsHeadingTruncated": "诊断结果（共 {total} 条，正文仅列最高严重级 {shown} 条）：",
    "feedback.candidatePatchCount": "候选 Git Patch：{count}",
    "feedback.errorStatus": "❌ 发现 error 级偏差。请主 Agent 根据诊断证据和候选 Git Patch 决定修正、忽略、转人工或终止当前阶段。",
    "feedback.warningStatus": "⚠️ 发现 warning 级偏差。是否处理或阻断由主 Agent 和当前工作流决定。",
    "feedback.noAutoApply": "runtime-corrector 不会自动修改目标文件，也不会自动应用候选 Git Patch。",
    "feedback.truncated": "...诊断内容因长度限制被截断。",
    "implReview.kitNotIntegrated": "「{section}」要求的 {kit} 未在生产源码中真实集成（无导入或仅导入未使用）",
    "implReview.kitExpectedConstraint": "材料清单「{section}」要求集成 {kit}（{module}）。",
    "implReview.kitNextAction": "导入 {module} 并在生产代码路径中实际调用其能力。",
    "implReview.capabilityNotIntegrated": "能力清单声明 {claimId} 要求的 {kit} 未在生产源码中真实集成（无导入或仅导入未使用）",
    "implReview.capabilityExpectedConstraint": "能力清单声明 {claimId} 要求集成 {kit}（{module}）。",
  },
  en: {
    "feedback.header": "[runtime-corrector] {artifactType} correction diagnosis: {status}",
    "feedback.triggerFile": "Trigger file: {file}",
    "feedback.knowledge": "Correction rule sets: {ruleSets}",
    "feedback.none": "none",
    "feedback.configSource": "Config source: {source}",
    "feedback.noDeviations": "No content violates the current correction rules. No changes needed.",
    "feedback.diagnosticsHeading": "Diagnostics:",
    "feedback.diagnosticsHeadingTruncated": "Diagnostics ({total} total; only the {shown} most severe listed inline):",
    "feedback.candidatePatchCount": "Candidate Git patches: {count}",
    "feedback.errorStatus": "❌ Error-level deviations found. The main Agent decides whether to fix, ignore, escalate to a human, or stop the current stage based on the diagnostic evidence and candidate Git patches.",
    "feedback.warningStatus": "⚠️ Warning-level deviations found. The main Agent and the current workflow decide whether to handle or block.",
    "feedback.noAutoApply": "runtime-corrector never edits target files or applies candidate Git patches automatically.",
    "feedback.truncated": "...diagnostic content truncated due to the length limit.",
    "implReview.kitNotIntegrated": "Kit {kit}, required by checklist section \"{section}\", is not genuinely integrated in the production source (no import, or imported but never used)",
    "implReview.kitExpectedConstraint": "Checklist section \"{section}\" requires integrating {kit} ({module}).",
    "implReview.kitNextAction": "Import {module} and actually invoke its capabilities on a production code path.",
    "implReview.capabilityNotIntegrated": "Capability {kit}, required by checklist claim {claimId}, is not genuinely integrated in the production source (no import, or imported but never used)",
    "implReview.capabilityExpectedConstraint": "Capability checklist claim {claimId} requires integrating {kit} ({module}).",
  },
};


export function resolveLocale(locale) {
  return CATALOG[locale] ? locale : DEFAULT_LOCALE;
}


export function formatMessage(locale, key, params = {}) {
  const template = CATALOG[resolveLocale(locale)][key] ?? CATALOG[DEFAULT_LOCALE][key];
  if (template === undefined) throw new Error(`Unknown message key: ${key}`);
  return template.replace(/\{(\w+)\}/gu, (placeholder, name) => (
    name in params ? String(params[name]) : placeholder
  ));
}
