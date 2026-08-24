import path from "node:path";

import { DEFAULT_LOCALE } from "../messages.mjs";
import { DEFAULT_PLATFORM } from "./platform-adapter.mjs";


export const METRIC_IDS = Object.freeze(
  Array.from({ length: 15 }, (_, index) => `M${String(index + 1).padStart(2, "0")}`),
);

const REVIEWER_ROLES = Object.freeze([
  "groundTruthExtractor",
  "onboardingAdjudicator",
  "skillReviewer",
  "artifactReviewer",
  "stopReviewer",
  "implementationReviewer",
]);

// The two highest self-consistency-risk gates: both judge the coding agent's
// own output at a decision boundary (onboarding adjudication freezes the
// ground-truth ledger; the stop review decides whether work may end), so they
// benefit most from an independent reviewer session/model.
export const CRITICAL_GATE_REVIEWER_ROLES = Object.freeze([
  "onboardingAdjudicator",
  "stopReviewer",
]);

const MODEL_POLICY_PRESET_ROLES = Object.freeze({
  "off": Object.freeze([]),
  "critical-gates": CRITICAL_GATE_REVIEWER_ROLES,
  "all": REVIEWER_ROLES,
});


function reviewerProvider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const apiKeyEnv = typeof value.apiKeyEnv === "string" ? value.apiKeyEnv.trim() : "";
  if (baseUrl === "" || apiKeyEnv === "") return null;
  return Object.freeze({
    baseUrl,
    // NAME of the environment variable holding the provider key — the key
    // itself must never appear in configuration or code.
    apiKeyEnv,
    model: typeof value.model === "string" && value.model.trim() !== "" ? value.model.trim() : null,
  });
}


/**
 * Expand reviewers.modelPolicy into explicit per-role session/provider blocks.
 *
 * The canonical configuration form is the explicit per-role blocks
 * (reviewers.<role>.session/provider written out in full); the preset is only
 * a shorthand. Whenever configuration is materialized (for example a command
 * writing config.yaml), it must be written in the expanded explicit form —
 * never as a bare preset keyword. This function is that single expansion
 * point: it returns the reviewers input with modelPolicy removed and the
 * preset's roles rewritten as explicit blocks.
 *
 * Precedence: a role that explicitly declares session or provider is left
 * untouched — explicit per-role configuration always overrides the preset.
 * Presets: "off" (default) touches no role; "critical-gates" covers exactly
 * CRITICAL_GATE_REVIEWER_ROLES; "all" covers every reviewer role.
 */
export function expandReviewerModelPolicy(reviewersInput) {
  const source = reviewersInput && typeof reviewersInput === "object" && !Array.isArray(reviewersInput)
    ? reviewersInput
    : {};
  const { modelPolicy, ...rest } = source;
  const preset = modelPolicy?.preset ?? "off";
  // Unknown preset values are rejected at config-load time (JSON schema enum);
  // compile stays tolerant and applies no overlay.
  const roles = MODEL_POLICY_PRESET_ROLES[preset] ?? [];
  const provider = reviewerProvider(modelPolicy?.provider);
  if (roles.length === 0 || !provider) return rest;
  const expanded = { ...rest };
  for (const role of roles) {
    const explicit = rest[role];
    if (explicit && (Object.hasOwn(explicit, "session") || Object.hasOwn(explicit, "provider"))) continue;
    expanded[role] = { ...(explicit ?? {}), session: "independent", provider };
  }
  return expanded;
}


function projectRootFromPolicyRoot(policyRoot) {
  return policyRoot ? path.dirname(path.resolve(policyRoot)) : null;
}


function resolveRoots(values, policyRoot) {
  const projectRoot = projectRootFromPolicyRoot(policyRoot);
  return (values ?? []).map((value) => (
    path.isAbsolute(value) || !projectRoot ? path.resolve(value) : path.resolve(projectRoot, value)
  ));
}


function reviewerConfig(value, fallback) {
  return Object.freeze({
    model: value?.model ?? fallback.model ?? null,
    effort: value?.effort ?? fallback.effort ?? "low",
    timeoutMs: value?.timeoutMs ?? fallback.timeoutMs ?? 240000,
    maxBudgetUsd: value?.maxBudgetUsd ?? fallback.maxBudgetUsd ?? null,
    // fork reviews inside a --fork-session of the parent conversation;
    // independent spawns a FRESH session against provider (reviewer.mjs).
    session: value?.session ?? fallback.session ?? "fork",
    provider: reviewerProvider(value?.provider ?? fallback.provider ?? null),
  });
}


export function compileRuntimeV2Config(config, { policyRoot = null, limits = {}, derived = null } = {}) {
  // Derivation tier (see derive.mjs): plugin defaults < derived < explicit.
  const derivedInput = derived ?? config.derived ?? null;
  const version = config.version ?? 1;
  const dynamicInput = config.dynamicGroundTruth ?? {};
  const skillInput = config.skillCorrection ?? {};
  const artifactInput = config.artifactCorrection ?? {};
  const stopInput = config.stopCorrection ?? {};
  const selection = skillInput.selection ?? { mode: "include", include: [], exclude: [] };
  const panelInput = dynamicInput.panel ?? {};
  // Material roots: explicit config wins; unset falls back to the derived
  // discovery (absolute paths supplied by loadRuntimePlan).
  const materialRootsDerived = dynamicInput.materialRoots === undefined
    && (derivedInput?.materialRoots?.length ?? 0) > 0;
  const dynamicGroundTruth = Object.freeze({
    enabled: version === 2 && dynamicInput.enabled === true,
    evidenceCapture: dynamicInput.evidenceCapture ?? "minimal",
    materialRoots: Object.freeze(materialRootsDerived
      ? derivedInput.materialRoots.map((root) => path.resolve(root))
      : resolveRoots(dynamicInput.materialRoots, policyRoot)),
    // Automated task onboarding: on the first hook event of a new task,
    // panel.size independent extractor passes decompose ALL task materials,
    // an adjudicator merges them, and the ledger freezes (see onboarding.mjs).
    // size: 0 disables onboarding and keeps the incremental single-extractor
    // behavior unchanged.
    panel: Object.freeze({
      size: Number.isInteger(panelInput.size) && panelInput.size >= 0 ? panelInput.size : 2,
      adjudicator: panelInput.adjudicator !== false,
    }),
  });
  const skillCorrection = Object.freeze({
    enabled: version === 2 && skillInput.enabled === true,
    selection: Object.freeze({
      mode: selection.mode ?? "include",
      include: Object.freeze([...(selection.include ?? [])]),
      exclude: Object.freeze([...(selection.exclude ?? [])]),
    }),
    skillRoots: Object.freeze(resolveRoots(skillInput.skillRoots, policyRoot)),
    completionCheckIntervalTurns: skillInput.completionCheckIntervalTurns ?? 10,
    maxWatchTurns: skillInput.maxWatchTurns ?? 30,
    maxFeedbacksPerSkill: skillInput.maxFeedbacksPerSkill ?? 1,
  });
  const artifactCorrection = Object.freeze({
    groundTruthReviewEnabled: version === 2
      && artifactInput.groundTruthReviewEnabled === true,
    stageMetricsEnabled: version === 2 && artifactInput.stageMetricsEnabled === true,
  });
  const stopCorrection = Object.freeze({
    enabled: version === 2 && stopInput.enabled === true,
    maxCorrectionsPerEpoch: stopInput.maxCorrectionsPerEpoch ?? 3,
  });
  // Implementation/verification review: first-party checks of the BUILT app
  // against the frozen population (code-semantic compare, later build/device
  // methods), run at Stop checkpoints inside assessStop. See
  // docs/implementation-reviewer-design.md.
  const implementationInput = config.implementationCorrection ?? {};
  const awarenessInput = implementationInput.harmonyEnvironmentAwareness ?? {};
  const platformDerived = implementationInput.platform === undefined
    && derivedInput !== null
    && Object.hasOwn(derivedInput, "platform");
  const implementationCorrection = Object.freeze({
    enabled: version === 2 && implementationInput.enabled === true,
    // Wall-clock ceiling for the non-LLM evidence collector (build/device
    // work); the LLM plan/judge phases stay under the reviewer timeout.
    deviceBudgetMs: implementationInput.deviceBudgetMs ?? 600000,
    // Deterministic kit-integration check inputs (see impl-review.mjs):
    // explicit checklist documents (fallback: markdown under
    // dynamicGroundTruth.materialRoots), the section-heading pattern and kit
    // column, and the platform adapter supplying module-naming and
    // source-tree conventions. platform: null disables the kit check.
    checklistPaths: Object.freeze(resolveRoots(implementationInput.checklistPaths, policyRoot)),
    checklistSection: implementationInput.checklistSection ?? null,
    kitColumnIndex: implementationInput.kitColumnIndex ?? null,
    // Device-verification ladder policy: "auto" degrades honestly through
    // device > build > static as the environment allows; "required" turns a
    // sub-device level into a blocking infrastructure finding (CI); "off"
    // pins static. Unknown values fall back to "auto".
    device: Object.freeze({
      mode: ["auto", "required", "off"].includes(implementationInput.device?.mode)
        ? implementationInput.device.mode
        : "auto",
    }),
    // Task-scoped HarmonyOS environment facts are probed once and reused by
    // the Stop guard. Enabled by default with implementation correction, but
    // explicitly disableable for projects that cannot inspect the host.
    harmonyEnvironmentAwareness: Object.freeze({
      enabled: version === 2
        && implementationInput.enabled === true
        && awarenessInput.enabled !== false,
    }),
    // Platform precedence: explicit config > derived fingerprint > plugin
    // default. A derived null (no marker, or no adapter for the marker yet)
    // deliberately turns the kit check off.
    platform: implementationInput.platform !== undefined
      ? implementationInput.platform
      : platformDerived
        ? derivedInput.platform
        : DEFAULT_PLATFORM,
  });
  // Preset shorthand expands to explicit per-role blocks before compilation;
  // explicit per-role session/provider always wins (see the expansion's doc).
  const reviewersInput = expandReviewerModelPolicy(config.reviewers);
  const reviewerDefaults = {
    effort: "low",
    timeoutMs: limits.semanticReviewTimeoutMs ?? 240000,
    ...(reviewersInput.defaults ?? {}),
  };
  const reviewers = Object.fromEntries(REVIEWER_ROLES.map((role) => [
    role,
    reviewerConfig(reviewersInput[role], reviewerDefaults),
  ]));
  // What the derivation tier actually decided, for the once-per-task
  // DERIVED_CONFIG journal event (orchestrator). null when nothing derived.
  const derivation = derivedInput
    ? Object.freeze({
        zeroConfig: derivedInput.zeroConfig === true,
        materialRootsDerived,
        materialRoots: Object.freeze([
          ...(materialRootsDerived
            ? derivedInput.materialRootsRelative ?? derivedInput.materialRoots
            : []),
        ]),
        platformDerived,
        platform: platformDerived ? derivedInput.platform : null,
        platformMarker: platformDerived ? derivedInput.platformMarker ?? null : null,
        localeDerived: config.locale === undefined && typeof derivedInput.locale === "string",
        locale: config.locale === undefined ? derivedInput.locale ?? null : null,
      })
    : null;
  return Object.freeze({
    schemaVersion: "runtime-corrector.runtime-plan.v2",
    configVersion: version,
    enabled: version === 2 && [
      dynamicGroundTruth.enabled,
      skillCorrection.enabled,
      artifactCorrection.groundTruthReviewEnabled,
      artifactCorrection.stageMetricsEnabled,
      stopCorrection.enabled,
      implementationCorrection.enabled,
    ].some(Boolean),
    dynamicGroundTruth,
    skillCorrection,
    artifactCorrection,
    stopCorrection,
    implementationCorrection,
    // Observe-only mode (config key shadowMode, kept for compatibility):
    // observe, classify and journal exactly as normal, but emit no decision
    // and no feedback to the agent. Useful for evaluating detection on an
    // uncorrected trace without intervening in the run.
    shadowMode: config.shadowMode === true,
    // Locale for developer-facing message templates (see lib/messages.mjs).
    // Precedence: explicit config > environment-derived (LC_ALL/LC_MESSAGES/
    // LANG) > plugin default.
    locale: config.locale ?? derivedInput?.locale ?? DEFAULT_LOCALE,
    reviewers: Object.freeze(reviewers),
    derivation,
  });
}
