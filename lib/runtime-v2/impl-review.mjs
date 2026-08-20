// Implementation/verification review — Phase 1 (MVP): code-summary → semantic
// requirement comparison. See docs/implementation-reviewer-design.md.
//
// The stop reviewer judges the developer's *claims and artifacts*; this
// reviewer judges the *production source itself* against the frozen population,
// with first-party inputs only (a SHA-256 source manifest the collector builds;
// never the developer's self-reported evidence). Later phases add build/device
// methods via a non-LLM executor; this MVP is deliberately read-only so it fits
// the Read,Grep reviewer sandbox unchanged and perturbs nothing.
//
// Ownership partition (mandatory): this reviewer owns M09 (development
// standards), M11 (workflow compliance) and M12 (requirement execution,
// statically decidable side). Its judgements REPLACE the stop reviewer's for
// those objectIds (merge is dedupe-by-objectId, impl wins) because two
// judgements for one objectId force CHECKER_ERROR in calculateMetricReport.
// M13/M15 stay stop-owned until the device spine ships (design Phase 3).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_LOCALE, formatMessage } from "../messages.mjs";
import { OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY } from "./paths.mjs";
import { DEFAULT_PLATFORM, loadPlatformAdapter } from "./platform-adapter.mjs";

const IMPL_METRIC_PREFIXES = ["M09:", "M11:", "M12:"];

const IMPL_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["deviationKey", "rootCauseId", "severity", "reason", "actualEvidence", "expectedConstraint"],
  properties: {
    deviationKey: { type: "string" },
    rootCauseId: { type: "string" },
    severity: { type: "string", enum: ["blocker", "error", "warning", "info"] },
    reason: { type: "string" },
    actualEvidence: { type: "array", items: { type: "string" } },
    expectedConstraint: { type: "string" },
    violatedGroundTruthIds: { type: "array", items: { type: "string" } },
    suggestedNextAction: { type: "string" },
  },
};

export const IMPL_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "metricObjectJudgements"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", maxItems: 200, items: IMPL_FINDING_SCHEMA },
    metricObjectJudgements: {
      type: "array",
      maxItems: 5000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objectId", "judgement", "reason", "evidence"],
        properties: {
          objectId: { type: "string" },
          judgement: {
            type: "string",
            enum: ["PASS", "DEVIATION", "UNVERIFIED", "BASIS_PENDING", "EXTERNAL_BLOCKED", "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "CHECKER_ERROR"],
          },
          reason: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/**
 * Strip metric prefixes (M12: etc.) from a finding's violatedGroundTruthIds.
 * Closure keys on the BARE claimId: passedMetricSourceIds emits sourceId and
 * markMetricPassesFixed tests violatedGroundTruthIds against that set. A stray
 * prefixed id from the LLM would create a family that can never close.
 */
export function normalizeImplFinding(finding) {
  const violated = (finding.violatedGroundTruthIds ?? [])
    .map((id) => String(id).replace(/^M\d\d:/u, ""));
  // Stable family identity across stops: free-text deviationKeys mint a NEW
  // family every assessment for the same underlying problem, which breaks
  // reopen/closure tracking. Normalize to impl:<first violated claim id>.
  const anchor = violated[0] ?? finding.deviationKey ?? "unanchored";
  return { ...finding, violatedGroundTruthIds: violated, deviationKey: `impl:${anchor}` };
}

/**
 * Merge metric judgements by objectId with the implementation reviewer's
 * judgement winning on collision. calculateMetricReport forces CHECKER_ERROR
 * when one objectId receives two judgements, so the merge must dedupe — never
 * concatenate.
 */
export function mergeJudgementsByObjectId(baseJudgements, implJudgements) {
  // Dedupe CROSS-LIST collisions only (impl replaces base for the same
  // objectId). Duplicates WITHIN either list are preserved deliberately so
  // calculateMetricReport's DUPLICATE_OBJECT -> CHECKER_ERROR trap still fires
  // — a single-Map merge would silently launder a reviewer that judged one
  // object twice (last-wins could even flip DEVIATION to PASS).
  const implIds = new Set((implJudgements ?? []).map((judgement) => judgement.objectId));
  return [
    ...(baseJudgements ?? []).filter((judgement) => !implIds.has(judgement.objectId)),
    ...(implJudgements ?? []),
  ];
}

/** Keep only judgements inside this reviewer's ownership partition. */
export function filterOwnedJudgements(judgements) {
  return (judgements ?? []).filter((judgement) => (
    IMPL_METRIC_PREFIXES.some((prefix) => String(judgement.objectId).startsWith(prefix))
  ));
}

const SOURCE_EXTENSIONS = new Set([".ets", ".ts", ".js", ".json", ".json5", ".yaml", ".yml", ".ts5"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hvigor", ".preview", OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY,
  "build", "node_modules", "oh_modules", "ohosTest", "test", "mock",
]);
const MAX_MANIFEST_FILES = 400;

/**
 * First-party source manifest: every production source/config file with its
 * SHA-256. This freezes exactly what was reviewed (auditably — a cited file
 * must appear here) and is collected by code, not by the developer, so it
 * cannot be fabricated.
 */
export async function collectSourceManifest(projectRoot) {
  const roots = [
    "entry/src/main",
    "AppScope",
  ];
  const rootFiles = [
    "oh-package.json5",
    "build-profile.json5",
    "entry/build-profile.json5",
    "entry/oh-package.json5",
  ];
  const manifest = [];
  const walk = async (absolute, relative) => {
    if (manifest.length >= MAX_MANIFEST_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (manifest.length >= MAX_MANIFEST_FILES) return;
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const content = await fs.readFile(childAbsolute);
        manifest.push({
          path: childRelative,
          sha256: createHash("sha256").update(content).digest("hex"),
          size: content.length,
        });
      } catch {
        // A file the collector cannot read is simply absent from the manifest;
        // the reviewer may not cite it.
      }
    }
  };
  for (const root of roots) await walk(path.join(projectRoot, root), root);
  for (const file of rootFiles) {
    try {
      const content = await fs.readFile(path.join(projectRoot, file));
      manifest.push({
        path: file,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.length,
      });
    } catch {
      // Optional root config; absence is informative, not an error.
    }
  }
  manifest.sort((left, right) => left.path.localeCompare(right.path));
  return manifest;
}

function implPopulationSlice(population) {
  const metrics = {};
  for (const prefix of IMPL_METRIC_PREFIXES) {
    const metricId = prefix.slice(0, -1);
    metrics[metricId] = population?.metrics?.[metricId] ?? [];
  }
  return { ...population, metrics };
}

const MAX_KIT_SCAN_FILES = 2000;
const MAX_CHECKLIST_FILES = 50;
const CHECKLIST_EXTENSIONS = new Set([".md", ".markdown"]);

/** Default heading pattern locating the kit-checklist section in the material markdown. */
export const DEFAULT_CHECKLIST_SECTION_PATTERN = "^#{1,4}\\s*10\\.1\\b";
/** Default index of the kit-name column in the checklist table rows (cells split on |). */
export const DEFAULT_KIT_COLUMN_INDEX = 2;

/** Map a kit catalog name (scan-kit) to its import module via the platform adapter. */
export function kitModuleName(kitName, adapter) {
  const normalized = String(kitName).trim().toLowerCase();
  const kitCheck = adapter?.kitCheck ?? {};
  // Irregular casings come from the adapter; everything else derives by
  // hyphen-split PascalCase.
  const moduleBase = kitCheck.moduleSpecialCases?.get(normalized)
    ?? normalized.split("-").filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  return `${kitCheck.modulePrefix ?? ""}${moduleBase}`;
}

/**
 * Parse the kit-checklist table (e.g. "| 功能 | 使用Kit | 代码文件 |") out of a
 * checklist markdown document. The section is located by sectionPattern (a
 * regex tested against trimmed lines) and ends at the next heading. Returns
 * unique kit catalog names in table order plus the matched section title; an
 * absent section yields { kits: [], sectionTitle: null }.
 */
export function parseKitManifest(markdown, {
  sectionPattern = DEFAULT_CHECKLIST_SECTION_PATTERN,
  kitColumnIndex = DEFAULT_KIT_COLUMN_INDEX,
} = {}) {
  let headingPattern;
  try {
    headingPattern = new RegExp(sectionPattern ?? DEFAULT_CHECKLIST_SECTION_PATTERN, "u");
  } catch {
    // An invalid configured pattern fails soft onto the default.
    headingPattern = new RegExp(DEFAULT_CHECKLIST_SECTION_PATTERN, "u");
  }
  const column = kitColumnIndex ?? DEFAULT_KIT_COLUMN_INDEX;
  const lines = String(markdown ?? "").split(/\r?\n/u);
  const kits = [];
  let sectionTitle = null;
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inSection) {
      if (headingPattern.test(line)) {
        inSection = true;
        sectionTitle = line.replace(/^#{1,6}\s*/u, "") || null;
      }
      continue;
    }
    if (/^#{1,4}\s/u.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < column + 2) continue;
    const kit = cells[column].toLowerCase();
    // Header and divider rows fail the catalog-name shape and drop out here.
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(kit)) continue;
    if (!kits.includes(kit)) kits.push(kit);
  }
  return { kits, sectionTitle };
}

/**
 * Checklist documents to parse: the configured checklistPaths when declared,
 * otherwise every markdown file under the dynamic Ground Truth material
 * roots. Unreadable or missing files fail soft (they are simply absent).
 */
async function collectChecklistSources(projectRoot, { checklistPaths, materialRoots }) {
  const sources = [];
  const explicit = (checklistPaths ?? []).map((file) => path.resolve(projectRoot, file));
  if (explicit.length > 0) {
    for (const filePath of explicit) {
      try {
        sources.push({ path: filePath, content: await fs.readFile(filePath, "utf8") });
      } catch {
        // A missing declared checklist behaves like an absent section.
      }
    }
    return sources;
  }
  const walk = async (absolute) => {
    if (sources.length >= MAX_CHECKLIST_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (sources.length >= MAX_CHECKLIST_FILES) return;
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!CHECKLIST_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        sources.push({ path: child, content: await fs.readFile(child, "utf8") });
      } catch {
        // Unreadable material files are simply not checklist candidates.
      }
    }
  };
  for (const root of materialRoots ?? []) await walk(path.resolve(projectRoot, root));
  return sources;
}

async function collectKitSourceFiles(projectRoot, adapter) {
  const files = [];
  const extensions = new Set(adapter.kitCheck.sourceExtensions);
  const walk = async (absolute, relative) => {
    if (files.length >= MAX_KIT_SCAN_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_KIT_SCAN_FILES) return;
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        files.push({ path: childRelative, content: await fs.readFile(childAbsolute, "utf8") });
      } catch {
        // An unreadable production file is simply not scanned.
      }
    }
  };
  for (const root of adapter.kitCheck.sourceRoots) {
    await walk(path.join(projectRoot, root), root);
  }
  return files;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Local bindings introduced by any import of moduleName in this file. */
function importedKitSymbols(content, moduleName) {
  const escaped = escapeRegExp(moduleName);
  const importPattern = new RegExp(`import\\s+([^;'"]+?)\\s*from\\s*['"]${escaped}['"]`, "gu");
  const symbols = [];
  let imported = false;
  let match;
  while ((match = importPattern.exec(content)) !== null) {
    imported = true;
    let clause = match[1].trim();
    const named = clause.match(/\{([^}]*)\}/u);
    if (named) {
      for (const piece of named[1].split(",")) {
        const name = piece.replace(/^\s*type\s+/u, "").trim();
        if (!name) continue;
        // `a as b` binds b locally; usage scanning must look for the alias.
        const alias = name.split(/\s+as\s+/u).pop().trim();
        if (alias) symbols.push(alias);
      }
      clause = clause.replace(/\{[^}]*\}/u, "");
    }
    const namespace = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/u);
    if (namespace) symbols.push(namespace[1]);
    const defaultBinding = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/u);
    if (defaultBinding) symbols.push(defaultBinding[1]);
  }
  // Side-effect import (`import "@kit.X"`): counted as an import, but it
  // binds nothing, so it can never satisfy the usage requirement.
  if (!imported) {
    imported = new RegExp(`import\\s*['"]${escaped}['"]`, "u").test(content);
  }
  return { imported, symbols: [...new Set(symbols)] };
}

function stripImportsAndComments(content) {
  return String(content)
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ")
    .replace(/import\s+[^;'"]+?\s*from\s*['"][^'"]*['"];?/gu, " ")
    .replace(/import\s*['"][^'"]*['"];?/gu, " ");
}

/** Scan the collected source files for genuine integration of one module. */
function kitIntegrationEvidence(files, moduleName) {
  const importingFiles = [];
  for (const file of files) {
    if (!file.content.includes(moduleName)) continue;
    const { imported, symbols } = importedKitSymbols(file.content, moduleName);
    if (!imported) continue;
    importingFiles.push(file.path);
    if (symbols.length === 0) continue;
    const body = stripImportsAndComments(file.content);
    if (symbols.some((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "u").test(body))) {
      return { integrated: true, importingFiles };
    }
  }
  return { integrated: false, importingFiles };
}

/**
 * Capability checklist entries from the frozen Ground Truth capabilityChecklist
 * claims (audit step 9, produced by task onboarding). Entries whose capability
 * could not be resolved against the platform catalog (catalogUnmatched) are
 * review-only: the deterministic checker skips them, so they can never block a
 * Stop. Stop-blocking stays limited to entries that are NOT inferred-only: a
 * hard table-derived or panel-majority-confirmed entry blocks; an inferred-only
 * entry warns.
 */
export function capabilityChecklistFromClaims(groundTruth, adapter) {
  const entries = [];
  for (const claim of groundTruth?.claims ?? []) {
    if (claim.status !== "ACTIVE" || claim.category !== "capabilityChecklist") continue;
    const capability = claim.capability;
    if (!capability?.name) continue;
    entries.push({
      claimId: claim.claimId,
      kit: capability.name,
      module: capability.module
        ?? (adapter && !capability.catalogUnmatched ? kitModuleName(capability.name, adapter) : null),
      sourceHint: capability.sourceHint ?? null,
      catalogUnmatched: capability.catalogUnmatched === true,
      blocking: claim.severity === "HARD" || claim.panelConfirmed === true,
    });
  }
  return entries;
}

/**
 * Deterministic (no-LLM) kit-integration check. Primary source: the frozen
 * capabilityChecklist Ground Truth claims produced by task onboarding —
 * findings then cite the claim ids, and severity follows the claim (blocking
 * error for hard or panel-confirmed entries, warning for inferred-only ones).
 * Fallback (when onboarding produced no checklist): the wave-1 table parser
 * over the configured checklist documents or the markdown under the dynamic
 * Ground Truth material roots. A kit counts as integrated only if some
 * production source file both imports its kit module and references at least
 * one imported symbol outside the import statements (import-only lines pasted
 * to satisfy a reviewer do not count). Fails soft: a missing checklist or
 * section yields no findings, and a null or unknown platform skips the check
 * entirely (other implementation-review methods are unaffected).
 */
export async function checkKitIntegration(projectRoot, {
  checklistPaths = [],
  materialRoots = [],
  checklistSection = null,
  kitColumnIndex = null,
  platform = DEFAULT_PLATFORM,
  adapter = null,
  locale = DEFAULT_LOCALE,
  groundTruth = null,
} = {}) {
  const platformAdapter = adapter ?? await loadPlatformAdapter(platform);
  if (!platformAdapter) return [];
  const claimEntries = capabilityChecklistFromClaims(groundTruth, platformAdapter)
    .filter((entry) => !entry.catalogUnmatched && entry.module);
  if (claimEntries.length > 0) {
    const files = await collectKitSourceFiles(projectRoot, platformAdapter);
    const findings = [];
    for (const entry of claimEntries) {
      const { integrated, importingFiles } = kitIntegrationEvidence(files, entry.module);
      if (integrated) continue;
      findings.push({
        deviationKey: `impl:kit:${entry.kit}`,
        rootCauseId: "REQUIREMENT_OMITTED",
        severity: entry.blocking ? "error" : "warning",
        reason: formatMessage(locale, "implReview.capabilityNotIntegrated", { kit: entry.kit, claimId: entry.claimId }),
        actualEvidence: importingFiles.length > 0
          ? importingFiles.map((file) => `${file}: imports ${entry.module} but never references an imported symbol`)
          : [`no import of ${entry.module} found under ${platformAdapter.kitCheck.sourceRoots.join(", ")}`],
        expectedConstraint: formatMessage(locale, "implReview.capabilityExpectedConstraint", { kit: entry.kit, module: entry.module, claimId: entry.claimId }),
        violatedGroundTruthIds: [entry.claimId],
        suggestedNextAction: formatMessage(locale, "implReview.kitNextAction", { module: entry.module }),
      });
    }
    return findings;
  }
  const sources = await collectChecklistSources(projectRoot, { checklistPaths, materialRoots });
  // Kit -> title of the checklist section that demanded it (first mention
  // wins), so the finding can cite the actual matched section.
  const sectionByKit = new Map();
  for (const source of sources) {
    const { kits, sectionTitle } = parseKitManifest(source.content, {
      sectionPattern: checklistSection ?? DEFAULT_CHECKLIST_SECTION_PATTERN,
      kitColumnIndex: kitColumnIndex ?? DEFAULT_KIT_COLUMN_INDEX,
    });
    for (const kit of kits) {
      if (!sectionByKit.has(kit)) sectionByKit.set(kit, sectionTitle);
    }
  }
  if (sectionByKit.size === 0) return [];
  const files = await collectKitSourceFiles(projectRoot, platformAdapter);
  const findings = [];
  for (const [kit, sectionTitle] of sectionByKit) {
    const moduleName = kitModuleName(kit, platformAdapter);
    const { integrated, importingFiles } = kitIntegrationEvidence(files, moduleName);
    if (integrated) continue;
    const section = sectionTitle ?? "";
    findings.push({
      deviationKey: `impl:kit:${kit}`,
      rootCauseId: "REQUIREMENT_OMITTED",
      severity: "error",
      reason: formatMessage(locale, "implReview.kitNotIntegrated", { section, kit }),
      actualEvidence: importingFiles.length > 0
        ? importingFiles.map((file) => `${file}: imports ${moduleName} but never references an imported symbol`)
        : [`no import of ${moduleName} found under ${platformAdapter.kitCheck.sourceRoots.join(", ")}`],
      expectedConstraint: formatMessage(locale, "implReview.kitExpectedConstraint", { section, kit, module: moduleName }),
      violatedGroundTruthIds: [],
      suggestedNextAction: formatMessage(locale, "implReview.kitNextAction", { module: moduleName }),
    });
  }
  return findings;
}

/**
 * Run the Phase-1 implementation review (code-semantic compare) through the
 * standard role-reviewer subprocess (Read,Grep sandbox — the reviewer reads
 * the manifested source files itself and must cite path:line evidence).
 * Returns normalized findings plus judgements restricted to the ownership
 * partition, merged with the deterministic kit-integration findings (which
 * never require the LLM reviewer to succeed). Throws on reviewer failure only
 * when there is nothing deterministic to report; the caller fails open.
 */
export async function runImplementationReview({
  projectRoot,
  sessionCwd,
  taskId,
  parentSessionId,
  runtimeV2,
  reviewerFactory,
  population,
  groundTruth = null,
  groundTruthPath,
  rootCauseIds,
}) {
  const sourceManifest = await collectSourceManifest(projectRoot);
  // Deterministic pass first: kit findings must survive an LLM reviewer fault,
  // so they are computed before the subprocess and folded into its result.
  const implementationCorrection = runtimeV2.implementationCorrection ?? {};
  const kitFindings = await checkKitIntegration(projectRoot, {
    checklistPaths: implementationCorrection.checklistPaths ?? [],
    materialRoots: runtimeV2.dynamicGroundTruth?.materialRoots ?? [],
    checklistSection: implementationCorrection.checklistSection ?? null,
    kitColumnIndex: implementationCorrection.kitColumnIndex ?? null,
    platform: implementationCorrection.platform === undefined
      ? DEFAULT_PLATFORM
      : implementationCorrection.platform,
    locale: runtimeV2.locale,
    // Primary checklist source: the frozen capabilityChecklist claims from
    // task onboarding; the table parser above stays the fallback.
    groundTruth,
  });
  const request = {
    schemaVersion: "runtime-corrector.impl-review-request.v2",
    instructions: [
      "You are the implementation reviewer. Judge the PRODUCTION SOURCE CODE itself against the frozen population objects supplied — not the developer's reports, claims, or self-captured evidence.",
      "Scope: judge ONLY objects whose objectId starts with M09:, M11: or M12:. Emit exactly one judgement per in-scope object; never invent or omit objects, and never judge other metrics.",
      "Method: read the manifested source files (paths under sourceManifest; each entry lists the file's SHA-256), summarize what each module/page/adapter actually implements, then compare semantically against each object's requirement text.",
      "Evidence: every PASS or DEVIATION must cite concrete `path:line` references from files present in sourceManifest. A file not in the manifest may not be cited.",
      "Judge M12 objects only where implementation is statically decidable from source (code paths, page routes, data models, adapter wiring, manifest permissions). Where runtime behavior would be required to decide, emit UNVERIFIED — never PASS on inference.",
      "Findings: emit a finding only for non-PASS objects. Keep finding text SYMPTOM-ONLY — name the object id and what is missing or contradicted in the code; do not quote expected values from the ground truth.",
      "Judgement `reason` fields are ALSO symptom-only: they may be surfaced to the developer verbatim in blocking feedback, so they must never quote expected values, fixture strings, or acceptance answers from the ground truth — describe only what the code does or lacks.",
      `Use only these rootCauseId values: ${(rootCauseIds ?? []).join(", ")}.`,
      "In findings, violatedGroundTruthIds must contain BARE claim ids (no M12: prefix).",
    ],
    taskId,
    groundTruthPath,
    population: implPopulationSlice(population),
    sourceManifest,
    sourceRoot: projectRoot.replaceAll("\\", "/"),
  };
  let handle = null;
  let result = null;
  let reviewerError = null;
  try {
    handle = await reviewerFactory({
      projectRoot,
      sessionCwd,
      taskId,
      parentSessionId,
      role: "implementation-reviewer",
      reviewer: runtimeV2.reviewers.implementationReviewer,
      schema: IMPL_REVIEW_SCHEMA,
      request,
    });
    result = handle.result;
  } catch (error) {
    // Fail open (rethrow) only when there is nothing deterministic to keep.
    if (kitFindings.length === 0) throw error;
    reviewerError = error;
  } finally {
    await handle?.close?.();
  }
  return {
    summary: result?.summary
      ?? `Implementation reviewer failed (${reviewerError?.message}); deterministic kit-integration findings only.`,
    findings: [
      ...(result?.findings ?? [])
        .filter((finding) => finding.severity !== "info")
        .map((finding) => normalizeImplFinding(finding)),
      ...kitFindings,
    ],
    metricObjectJudgements: filterOwnedJudgements(result?.metricObjectJudgements),
    sourceManifestCount: sourceManifest.length,
    reviewerError: reviewerError?.message ?? null,
  };
}
