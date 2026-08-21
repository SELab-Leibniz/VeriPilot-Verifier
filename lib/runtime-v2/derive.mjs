// Zero-config derivation layer (generalization wave 4).
//
// The v2 runtime must work in a project with NO .runtime-corrector/ directory:
// when configuration is absent — or a v2 config leaves
// dynamicGroundTruth.materialRoots or implementationCorrection.platform
// unset — the plan loader derives the missing values from the project itself.
//
// Precedence everywhere: plugin defaults < derived values < explicit config.
// loadRuntimePlan (lib/runtime-plan.mjs) computes the derivation,
// compileRuntimeV2Config (config.mjs) applies the precedence and records what
// was derived, and the orchestrator journals one DERIVED_CONFIG event per
// task listing exactly the derived pieces.

import { promises as fs } from "node:fs";
import path from "node:path";


// Deterministic caps: derivation must stay cheap on every hook event and the
// discovered list must be reproducible run to run.
const MAX_MATERIAL_ROOTS = 12;
const MAX_DOCS_DEPTH = 4;
const MAX_KEYWORD_DEPTH = 2;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".claude",
  ".runtime-correction",
  ".runtime-corrector",
  "node_modules",
  "oh_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);


/** Fully functional zero-config baseline compiled when a project has no
 * configuration at all: dynamic Ground Truth with automated onboarding, the
 * terminal correction gate, and implementation review (whose deterministic
 * kit check stays off unless a platform is detected). */
export const ZERO_CONFIG_DEFAULTS = Object.freeze({
  version: 2,
  artifacts: Object.freeze([]),
  dynamicGroundTruth: Object.freeze({ enabled: true }),
  stopCorrection: Object.freeze({ enabled: true }),
  implementationCorrection: Object.freeze({ enabled: true }),
});


function normalize(relative) {
  return relative.replaceAll("\\", "/");
}


async function listDirectory(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}


function scannableDirectory(entry) {
  return entry.isDirectory()
    && !entry.name.startsWith(".")
    && !SKIPPED_DIRECTORIES.has(entry.name);
}


async function collectMarkdown(root, relative, depth, matches, predicate) {
  const entries = await listDirectory(path.join(root, relative));
  for (const entry of entries) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isFile()
      && entry.name.toLowerCase().endsWith(".md")
      && predicate(entry.name.toLowerCase())) {
      matches.push(normalize(entryRelative));
    } else if (depth > 1 && scannableDirectory(entry)) {
      await collectMarkdown(root, entryRelative, depth - 1, matches, predicate);
    }
  }
}


/**
 * Discover candidate task materials in a project without configuration, in
 * priority order so the cap never drops a high-signal file for a low-signal
 * one: root README* files, then markdown whose name mentions requirement or
 * spec (up to two directory levels deep), then everything under docs/.
 * Returns project-relative paths with forward slashes, deduplicated,
 * deterministic, capped at maxEntries.
 */
export async function discoverMaterialRoots(projectRoot, { maxEntries = MAX_MATERIAL_ROOTS } = {}) {
  const root = path.resolve(projectRoot);
  const readmes = (await listDirectory(root))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().startsWith("readme"))
    .map((entry) => normalize(entry.name));
  const keyword = [];
  await collectMarkdown(root, "", MAX_KEYWORD_DEPTH, keyword, (name) => (
    name.includes("requirement") || name.includes("spec")
  ));
  const docs = [];
  await collectMarkdown(root, "docs", MAX_DOCS_DEPTH, docs, () => true);
  const ordered = [];
  for (const candidate of [...readmes, ...keyword, ...docs]) {
    if (!ordered.includes(candidate)) ordered.push(candidate);
    if (ordered.length >= maxEntries) break;
  }
  return ordered;
}


async function fileExists(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}


/**
 * Fingerprint the project platform for the deterministic kit-integration
 * check. oh-package.json5 marks a HarmonyOS project. A plain package.json
 * project has no platform adapter yet — future adapters (for example a web
 * adapter keyed off framework markers) slot in here; until then null keeps
 * the kit check off while every other implementation-review method still
 * runs. No marker at all also yields null.
 */
export async function detectPlatform(projectRoot) {
  const root = path.resolve(projectRoot);
  if (await fileExists(path.join(root, "oh-package.json5"))) {
    return { platform: "harmonyos", marker: "oh-package.json5" };
  }
  if (await fileExists(path.join(root, "package.json"))) {
    return { platform: null, marker: "package.json" };
  }
  return { platform: null, marker: null };
}


/**
 * Feedback locale derived from the user's environment (LC_ALL > LC_MESSAGES >
 * LANG, the POSIX precedence): Chinese locales keep the zh default, anything
 * else that is set gets en. Nothing set derives nothing — the plugin default
 * (zh) then applies via the normal precedence.
 */
export function deriveLocale(env = process.env) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized || normalized === "c" || normalized === "posix") return null;
  return normalized.startsWith("zh") ? "zh" : "en";
}


/**
 * One derivation pass over a project: discovered material roots (absolute for
 * the compiler, relative for journals and the materialized config), the
 * platform fingerprint, and the environment locale. The result feeds
 * compileRuntimeV2Config as the middle precedence tier — below explicit
 * config, above plugin defaults.
 */
export async function deriveConfigDefaults(projectRoot, { env = process.env } = {}) {
  const root = path.resolve(projectRoot);
  const materialRootsRelative = await discoverMaterialRoots(root);
  const detected = await detectPlatform(root);
  return {
    materialRoots: materialRootsRelative.map((relative) => path.join(root, relative)),
    materialRootsRelative,
    platform: detected.platform,
    platformMarker: detected.marker,
    locale: deriveLocale(env),
  };
}


function yamlString(value) {
  return JSON.stringify(String(value));
}


/**
 * Render the commented config.yaml that /runtime-corrector:init materializes:
 * the same derivation the zero-config runtime performs, written out so the
 * detected materials and platform become visible, reviewable and editable.
 */
export function renderMaterializedConfig(derived) {
  const materials = derived?.materialRootsRelative ?? [];
  const platform = derived?.platform ?? null;
  const lines = [
    "# Runtime Corrector project configuration (materialized by /runtime-corrector:init).",
    "#",
    "# Generated from what init detected in this project. The same derivation runs",
    "# automatically when this file is absent (zero-config mode); materializing it",
    "# only makes the derived choices visible and editable.",
    "# Precedence: plugin defaults < derived values < explicit keys in this file.",
    "#",
    "# Full reference: the plugin's docs/configuration.md and",
    "# docs/runtime-corrector-v2-design.md.",
    "version: 2",
    "",
    "# Locale for the highest-visibility developer-facing messages: zh (default) or en.",
    ...(derived?.locale
      ? ["# Derived from your environment; edit freely.", `locale: ${derived.locale}`]
      : ["# locale: zh"]),
    "",
    "# Version 1 artifact/stage correction stays off until artifacts are declared.",
    "# See example.rules.yaml / example.reviewer.md next to this file for the",
    "# deterministic-rule and semantic-review starting points.",
    "artifacts: []",
    "",
    "dynamicGroundTruth:",
    "  enabled: true",
  ];
  if (materials.length > 0) {
    lines.push(
      "  # Task materials detected by init. Edit freely; removing the key entirely",
      "  # falls back to automatic discovery at runtime.",
      "  materialRoots:",
      ...materials.map((relative) => `    - ${yamlString(relative)}`),
    );
  } else {
    lines.push(
      "  # No candidate task materials (README*, docs/**/*.md, *requirement*/*spec*",
      "  # markdown) were detected. Declare them here once they exist:",
      "  # materialRoots:",
      "  #   - docs/requirements.md",
    );
  }
  lines.push(
    "  panel:",
    "    # Independent onboarding extraction passes; 0 disables automated task",
    "    # onboarding (decompose -> panel -> freeze).",
    "    size: 2",
    "    adjudicator: true",
    "",
    "stopCorrection:",
    "  enabled: true",
    "  maxCorrectionsPerEpoch: 3",
    "",
    "implementationCorrection:",
    "  enabled: true",
  );
  if (platform) {
    lines.push(
      `  # Platform detected from ${derived?.platformMarker ?? "project markers"}; drives the`,
      "  # deterministic kit-integration check (config/platforms/<name>.json).",
      `  platform: ${yamlString(platform)}`,
    );
  } else {
    lines.push(
      "  # No platform marker was detected"
        + (derived?.platformMarker ? ` beyond ${derived.platformMarker} (no adapter yet)` : "")
        + "; null keeps the deterministic",
      "  # kit-integration check off while other implementation-review methods run.",
      "  platform: null",
    );
  }
  lines.push(
    "",
    "# Reviewer sessions and providers. session: fork (default) reviews inside a",
    "# fork of the parent session; session: independent spawns a FRESH session",
    "# against the configured provider. apiKeyEnv is the NAME of an environment",
    "# variable — never put an API key, token, or endpoint secret in this file.",
    "# reviewers:",
    "#   onboardingAdjudicator:",
    "#     session: independent",
    "#     provider:",
    "#       baseUrl: https://api.example-provider.com",
    "#       apiKeyEnv: REVIEWER_API_KEY",
    "#       model: example-reviewer-model",
    "#   stopReviewer:",
    "#     session: independent",
    "#     provider:",
    "#       baseUrl: https://api.example-provider.com",
    "#       apiKeyEnv: REVIEWER_API_KEY",
    "#       model: example-reviewer-model",
    "#",
    "# Equivalent preset shorthand for exactly the two-role setup above:",
    "# reviewers:",
    "#   modelPolicy:",
    "#     preset: critical-gates",
    "#     provider:",
    "#       baseUrl: https://api.example-provider.com",
    "#       apiKeyEnv: REVIEWER_API_KEY",
    "#       model: example-reviewer-model",
    "",
  );
  return lines.join("\n");
}
