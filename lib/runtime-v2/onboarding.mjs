// Automated task onboarding (generalization wave 2): decompose → agent panel
// → freeze, with no user confirmation anywhere.
//
// On the first hook event of a new task, panel.size independent
// ground-truth-extractor passes (config: dynamicGroundTruth.panel, default
// size 2) each decompose ALL task materials into atomic claims in one
// dedicated pass, reusing the standard reviewer spawn machinery and the
// extractor output schema. An adjudicator reviewer (panel.adjudicator,
// default true) receives the panel claim sets and merges them: claims agreed
// by a majority of passes are confirmed (stamped panelConfirmed on the
// ledger); disagreements and open questions are decided skeptically — prefer
// the narrower claim, and unresolvable ambiguity stays an openQuestions claim
// carrying a default-safe reading the corrector can review against.
//
// After adjudication the merged delta is applied and the ledger FREEZES
// (ground-truth-ledger frozenAtVersion): post-freeze mutations are restricted
// to USER_EXPLICIT authority, so new user messages can still supersede the
// baseline while agent inference cannot. Reviews thereafter run against the
// frozen baseline plus any user-explicit deltas.
//
// The extractor passes also mine dependency/capability obligations into
// capabilityChecklist claims (audit step 9). Explicit kit-checklist tables in
// the materials are ALSO parsed deterministically (impl-review's
// parseKitManifest) and unioned with the panel result — an exhaustive table
// lands in the ledger even when the panel under-extracts it. After the merge
// the entries are cross-checked deterministically against the platform
// adapter's catalog conventions; entries not resolvable to a platform module
// are kept but flagged catalogUnmatched (review-only — the deterministic kit
// checker in impl-review.mjs skips them, so they can never block a Stop).
//
// Fail-soft: any reviewer fault (panel entirely failed, adjudication failed,
// delta rejected) journals ONBOARDING_DEGRADED and falls back to the wave-1
// incremental single-extractor behavior — the ledger is left unfrozen.

import { promises as fs } from "node:fs";
import path from "node:path";

import { applyGroundTruthDelta, freezeGroundTruth } from "./ground-truth-ledger.mjs";
import {
  DEFAULT_CHECKLIST_SECTION_PATTERN,
  DEFAULT_KIT_COLUMN_INDEX,
  kitModuleName,
  parseKitManifest,
} from "./impl-review.mjs";
import { DEFAULT_PLATFORM, loadPlatformAdapter } from "./platform-adapter.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA } from "./reviewer.mjs";
import { scanSkillDirectory } from "./skill-source.mjs";
import { appendTaskJournal, taskDirectory, withTaskState } from "./task-store.mjs";
import { sha256 } from "./utils.mjs";


const CATALOG_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const ONBOARDING_INSTRUCTIONS = [
  "This is the DEDICATED TASK ONBOARDING pass: decompose ALL task materials (the materials manifest below plus the real user request in the parent conversation) into atomic Ground Truth claims in this single pass — complete coverage now, not incremental discovery.",
  "Extract claims only from real user messages, explicitly supplied materials, and verifiable project constraints. Assistant messages, hook feedback, internal reviewer output, and agent-authored artifacts are never USER_EXPLICIT.",
  "Use ADD operations only: this ledger is empty (version 0).",
  "AGENT_INFERRED claims must be SOFT. Do not invent a positive requirement from ambiguous material; use BASIS_PENDING.",
  "Use only the category enum exposed by the output schema; map functional or atomic requirements to requirements and workflow procedures to workflowSteps. Atomize claims: traceabilityRelations for M07 denominator objects, developmentStandards for M09, milestoneTargets for M14, and criticalJourneys for M15.",
  "Mine dependency/capability obligations into capabilityChecklist claims, each carrying capability.name (catalog-style lowercase-hyphenated capability or kit name), capability.module when the material states it, and capability.sourceHint (file or section). Use explicit dependency/kit tables when present (authority MATERIAL_DERIVED, severity HARD) and enumerate EVERY table row — never sample or summarize a table; otherwise infer from requirement semantics (authority AGENT_INFERRED, severity SOFT).",
  "When the task materials are ambiguous about a behavior, record it as an openQuestions claim that states the ambiguity AND a default-safe reading the corrector can review against — never a directive that asserts one resolution.",
];

const ADJUDICATOR_INSTRUCTIONS = [
  "You are the onboarding ADJUDICATOR: merge the independent panel claim sets below into one final claim set. Do not continue the parent task.",
  "majorityOperations were proposed by a majority of the panel passes: keep them unless two majority claims contradict each other.",
  "disputedOperations carry panelVotes (how many passes proposed the claim under the lexical vote key). That key matches exact wording only, so same-substance claims phrased differently by different passes land here too: first cluster disputed claims that state the same obligation; a cluster whose combined distinct passes reach a majority is an agreement in substance — merge it into the single clearest claim and KEEP it.",
  "Apply skepticism to genuinely minority claims (no same-substance support from another pass): prefer the narrower claim, prefer SOFT over HARD when the material evidence is thin, and drop claims without material support.",
  "Unresolvable ambiguity stays an openQuestions claim, but it MUST carry a default-safe reading the corrector can review against.",
  "Return ADD operations only (the ledger is empty), using the same category, authority, and severity rules as the extractor. Never assign USER_EXPLICIT authority the panel did not ground in a real user message.",
];


/**
 * Manifest of the task materials under dynamicGroundTruth.materialRoots:
 * per-file path, size and SHA-256 plus an aggregate digest. Shared by the
 * incremental refresh (source-cursor invalidation) and the onboarding pass.
 */
export async function materialManifest(roots) {
  const entries = [];
  for (const root of roots) {
    try {
      const stat = await fs.stat(root);
      if (stat.isDirectory()) {
        const scanned = await scanSkillDirectory(root, { maxFiles: 100, maxBytes: 1024 * 1024 });
        entries.push(...scanned.files.map(({ content, ...file }) => ({
          root: scanned.root,
          ...file,
        })));
      } else if (stat.isFile()) {
        const contents = await fs.readFile(root);
        entries.push({ root: path.dirname(root), path: path.basename(root), bytes: contents.length, sha256: sha256(contents) });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  entries.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
  return { entries, digest: sha256(entries) };
}


/**
 * Case-, separator- and prefix-insensitive vote key for capability names:
 * "NetworkKit", "@kit.NetworkKit", "Network Kit" and "network-kit" all cast
 * the same panel vote (and dedupe against the deterministic table parse).
 */
export function capabilityVoteKey(name) {
  return String(name ?? "")
    .trim()
    .replace(/^@[a-z0-9-]+\./iu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}


/**
 * Stable identity for panel voting: category plus normalized claim text
 * (capability name for capabilityChecklist entries, so wording differences in
 * the prose never split a capability vote).
 */
export function panelClaimKey(operation) {
  const category = operation.category ?? "requirements";
  if (category === "capabilityChecklist" && operation.capability?.name) {
    return `capabilityChecklist:${capabilityVoteKey(operation.capability.name)}`;
  }
  const text = String(operation.text ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
  return `${category}:${sha256(text).slice(0, 16)}`;
}


/**
 * Deterministic majority partition over the panel proposals. A claim is
 * majority-agreed when more than half of the successful passes proposed it
 * (matched by panelClaimKey); everything else is disputed. Within one key the
 * first pass's wording stands — resolving disputes is the adjudicator's job
 * (or the deterministic downgrade when the adjudicator is disabled).
 */
export function mergePanelOperations(panelResults) {
  const votes = new Map();
  for (const operations of panelResults) {
    const seen = new Set();
    for (const operation of operations ?? []) {
      const key = panelClaimKey(operation);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = votes.get(key) ?? { operation, count: 0 };
      entry.count += 1;
      votes.set(key, entry);
    }
  }
  const threshold = panelResults.length / 2;
  const majority = [];
  const disputed = [];
  const voteCounts = new Map();
  for (const [key, { operation, count }] of votes) {
    voteCounts.set(key, count);
    if (count > threshold) majority.push(operation);
    else disputed.push(operation);
  }
  return { majority, disputed, votes: voteCounts };
}


/**
 * Deterministic cross-check of capabilityChecklist entries against the
 * platform adapter's catalog conventions (names and irregular special cases).
 * Entries not resolvable to a platform module are KEPT but flagged
 * catalogUnmatched — review-only, never Stop-blocking. Resolvable entries get
 * their module filled in from the adapter's naming convention when the
 * material did not state it.
 */
/**
 * Catalog-shaped form of an extractor-supplied capability name. The simple
 * lowercase form wins when it is catalog-shaped and either matches an adapter
 * special case ("ArkUI" → "arkui") or carried no internal word boundaries;
 * otherwise camelCase/separator boundaries become hyphens ("@kit.NetworkKit"
 * → "network-kit") so module derivation stays correct.
 */
export function catalogCapabilityName(rawName, adapter) {
  const raw = String(rawName ?? "").trim().replace(/^@[a-z0-9-]+\./iu, "");
  const simple = raw.toLowerCase();
  const split = raw
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[\s_./]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (CATALOG_NAME_PATTERN.test(simple)) {
    if (adapter?.kitCheck?.moduleSpecialCases?.has(simple)) return simple;
    if (simple === split) return simple;
  }
  return split;
}


export function crossCheckCapabilityOperations(operations, adapter) {
  let unmatched = 0;
  const checked = operations.map((operation) => {
    if (operation.category !== "capabilityChecklist" || !operation.capability?.name) return operation;
    const name = catalogCapabilityName(operation.capability.name, adapter);
    if (!adapter || !CATALOG_NAME_PATTERN.test(name)) {
      unmatched += 1;
      return { ...operation, capability: { ...operation.capability, name, catalogUnmatched: true } };
    }
    return {
      ...operation,
      capability: {
        ...operation.capability,
        name,
        module: operation.capability.module ?? kitModuleName(name, adapter),
        catalogUnmatched: false,
      },
    };
  });
  return { operations: checked, catalogUnmatched: unmatched };
}


/**
 * Deterministic capability pre-pass: parse explicit kit-checklist tables
 * straight out of the material markdown files, so an exhaustive table lands
 * in the ledger even when the panel under-extracts it. Reuses the
 * implementation-correction checker's parser and honours its configured
 * section pattern and kit column; unreadable files fail soft; kits repeated
 * across files dedupe on the capability vote key.
 */
export async function deterministicCapabilityOperations(materials, implementationCorrection = {}, adapter = null) {
  const operations = [];
  const seen = new Set();
  for (const entry of materials?.entries ?? []) {
    if (!/\.(?:md|markdown)$/iu.test(entry.path)) continue;
    let content;
    try {
      content = await fs.readFile(path.join(entry.root, entry.path), "utf8");
    } catch {
      continue;
    }
    const { kits, hedgedKits, kitSections, sectionTitle } = parseKitManifest(content, {
      sectionPattern: implementationCorrection?.checklistSection ?? DEFAULT_CHECKLIST_SECTION_PATTERN,
      kitColumnIndex: implementationCorrection?.kitColumnIndex ?? DEFAULT_KIT_COLUMN_INDEX,
      adapter,
    });
    // Committed kits are obligations (HARD, may block); kits the material
    // itself marks as candidates or feasibility options are advisory (SOFT):
    // naming a capability is not committing to it.
    for (const [kit, committed] of [
      ...kits.map((kit) => [kit, true]),
      ...(hedgedKits ?? []).map((kit) => [kit, false]),
    ]) {
      const key = capabilityVoteKey(kit);
      if (seen.has(key)) continue;
      seen.add(key);
      const section = kitSections?.get(kit) ?? sectionTitle;
      operations.push({
        operation: "ADD",
        category: "capabilityChecklist",
        text: committed
          ? `Capability checklist (${entry.path}${section ? ` §${section}` : ""}): integrate ${kit} in production source.`
          : `Capability candidate (${entry.path}${section ? ` §${section}` : ""}): the material names ${kit} without committing to it.`,
        authority: "MATERIAL_DERIVED",
        severity: committed ? "HARD" : "SOFT",
        capability: { name: kit, sourceHint: `${entry.path}${section ? `#${section}` : ""}` },
      });
    }
  }
  return operations;
}


function onboardingRequest({ projectRoot, task, input, snapshot, materials, passIndex, panelSize }) {
  return {
    schemaVersion: "runtime-corrector.onboarding-request.v2",
    instructions: ONBOARDING_INSTRUCTIONS,
    taskId: task.taskId,
    hookEventId: input.hook_event_id ?? null,
    onboarding: { passIndex, panelSize },
    transcriptCursor: snapshot?.lastEntryKey ?? null,
    lastUserCursor: snapshot?.lastUserEntryKey ?? null,
    currentGroundTruth: {
      path: path.join(taskDirectory(projectRoot, task.taskId), "ground-truth", "current.json").replaceAll("\\", "/"),
      version: 0,
      digest: null,
    },
    materials,
  };
}


async function journalDegraded(projectRoot, taskId, reason, detail = {}) {
  await appendTaskJournal(projectRoot, taskId, {
    type: "ONBOARDING_DEGRADED",
    reason,
    ...detail,
  });
}


/**
 * The onboarding pass itself: panel extraction → adjudication (or the
 * deterministic majority merge) → capability catalog cross-check → single
 * ledger delta → freeze. Returns a status record; the caller persists it on
 * task state.
 *
 * The panel passes run in PARALLEL: onboarding must complete inside one hook
 * event's budget, and a real requirements document takes each extractor
 * minutes — sequential passes cannot fit. Peak spend stays bounded by
 * panel.size. For the same reason the onboarding roles get a timeout FLOOR
 * raised above the incremental-reviewer default (a bulk decompose of a large
 * document is not an incremental refresh); an explicitly higher configured
 * timeout still wins.
 */
const ONBOARDING_EXTRACTOR_TIMEOUT_FLOOR_MS = 480000;
const ONBOARDING_ADJUDICATOR_TIMEOUT_FLOOR_MS = 360000;

function flooredReviewer(reviewer, floorMs) {
  return { ...reviewer, timeoutMs: Math.max(reviewer?.timeoutMs ?? 0, floorMs) };
}

export async function runTaskOnboarding({
  input,
  projectRoot,
  sessionCwd,
  task,
  runtimeV2,
  reviewerFactory,
  snapshot = null,
}) {
  const dynamic = runtimeV2.dynamicGroundTruth;
  const panel = dynamic.panel;
  const materials = await materialManifest(dynamic.materialRoots);
  const passResults = await Promise.all(
    Array.from({ length: panel.size }, (_, index) => index + 1).map(async (passIndex) => {
      let handle = null;
      try {
        handle = await reviewerFactory({
          projectRoot,
          sessionCwd,
          taskId: task.taskId,
          parentSessionId: input.session_id,
          role: "onboarding-extractor",
          reviewer: flooredReviewer(runtimeV2.reviewers.groundTruthExtractor, ONBOARDING_EXTRACTOR_TIMEOUT_FLOOR_MS),
          schema: GROUND_TRUTH_REVIEW_SCHEMA,
          request: onboardingRequest({ projectRoot, task, input, snapshot, materials, passIndex, panelSize: panel.size }),
        });
        return { operations: Array.isArray(handle.result?.operations) ? handle.result.operations : [] };
      } catch (error) {
        return { failure: error.message };
      } finally {
        await handle?.close?.();
      }
    }),
  );
  const passes = passResults.filter((result) => !result.failure).map((result) => result.operations);
  const failures = passResults.filter((result) => result.failure).map((result) => result.failure);
  if (passes.length === 0) {
    await journalDegraded(projectRoot, task.taskId, "PANEL_FAILED", { failures });
    return { status: "DEGRADED", reason: "PANEL_FAILED", failures };
  }
  const { majority, disputed, votes } = mergePanelOperations(passes);
  let merged = null;
  let adjudicated = false;
  let adjudicatorError = null;
  if (panel.adjudicator) {
    let handle = null;
    try {
      handle = await reviewerFactory({
        projectRoot,
        sessionCwd,
        taskId: task.taskId,
        parentSessionId: input.session_id,
        role: "onboarding-adjudicator",
        reviewer: flooredReviewer(runtimeV2.reviewers.onboardingAdjudicator, ONBOARDING_ADJUDICATOR_TIMEOUT_FLOOR_MS),
        schema: GROUND_TRUTH_REVIEW_SCHEMA,
        request: {
          schemaVersion: "runtime-corrector.onboarding-adjudication-request.v2",
          instructions: ADJUDICATOR_INSTRUCTIONS,
          taskId: task.taskId,
          hookEventId: input.hook_event_id ?? null,
          panelSize: passes.length,
          // panelProposals (every operation from every pass) is deliberately
          // NOT sent: majorityOperations + disputedOperations already cover
          // every distinct claim, so including the raw passes roughly doubles
          // the payload and is what pushes the adjudicator past its timeout on
          // realistic (1000+ line) requirement documents.
          majorityOperations: majority.map((operation) => ({
            ...operation,
            panelVotes: votes.get(panelClaimKey(operation)) ?? 1,
          })),
          disputedOperations: disputed.map((operation) => ({
            ...operation,
            panelVotes: votes.get(panelClaimKey(operation)) ?? 1,
          })),
          materials,
          currentGroundTruth: { version: 0, digest: null },
        },
      });
      merged = Array.isArray(handle.result?.operations) ? handle.result.operations : [];
      adjudicated = true;
    } catch (error) {
      // The panel already produced complete claim sets; discarding them would
      // throw away the whole onboarding (and all protection) over a merge
      // fault. Fall through to the deterministic merge instead — the same
      // conservative path used when no adjudicator is configured.
      adjudicatorError = error.message;
      await journalDegraded(projectRoot, task.taskId, "ADJUDICATION_FAILED", {
        error: error.message,
        recovery: "DETERMINISTIC_MERGE",
      });
    } finally {
      await handle?.close?.();
    }
  }
  if (merged === null) {
    // Deterministic merge without an adjudicator: the majority stands;
    // disputed claims are kept but downgraded to inferred-only (SOFT), so
    // they remain reviewable without ever blocking a Stop.
    merged = [
      ...majority,
      ...disputed.map((operation) => ({ ...operation, authority: "AGENT_INFERRED", severity: "SOFT" })),
    ];
  }
  const majorityKeys = new Set(majority.map((operation) => panelClaimKey(operation)));
  const confirmed = merged
    // Onboarding writes against an empty ledger: only non-empty ADDs are
    // applicable, and filtering here (instead of letting the ledger throw)
    // keeps a sloppy adjudicator from degrading the whole onboarding.
    .filter((operation) => String(operation.operation ?? "").toUpperCase() === "ADD"
      && String(operation.text ?? "").trim())
    .map((operation) => (majorityKeys.has(panelClaimKey(operation))
      ? { ...operation, panelConfirmed: true }
      : operation));
  // Union with the deterministic table parse: a kit backed by an explicit
  // material table outranks panel judgement on strength (upgrade in place,
  // keeping the panel's richer wording); kits the panel missed are appended.
  const adapter = await loadPlatformAdapter(
    runtimeV2.implementationCorrection?.platform === undefined
      ? DEFAULT_PLATFORM
      : runtimeV2.implementationCorrection.platform,
  );
  const deterministicOps = await deterministicCapabilityOperations(materials, runtimeV2.implementationCorrection, adapter);
  const deterministicKeys = new Map(deterministicOps.map((operation) => [capabilityVoteKey(operation.capability.name), operation]));
  const seenCapabilityKeys = new Set();
  const withDeterministic = confirmed.map((operation) => {
    if (operation.category !== "capabilityChecklist" || !operation.capability?.name) return operation;
    const key = capabilityVoteKey(operation.capability.name);
    seenCapabilityKeys.add(key);
    const deterministic = deterministicKeys.get(key);
    if (!deterministic) return operation;
    // Table evidence upgrades a panel claim only when the material COMMITTED
    // to the kit; a candidate entry never manufactures an obligation.
    return deterministic.severity === "HARD"
      ? { ...operation, authority: "MATERIAL_DERIVED", severity: "HARD", panelConfirmed: true }
      : operation;
  });
  for (const [key, operation] of deterministicKeys) {
    if (!seenCapabilityKeys.has(key)) withDeterministic.push({ ...operation, panelConfirmed: true });
  }
  const crossChecked = crossCheckCapabilityOperations(withDeterministic, adapter);
  let applied;
  try {
    applied = await applyGroundTruthDelta({
      projectRoot,
      taskId: task.taskId,
      delta: { operations: crossChecked.operations },
      evidenceCapture: dynamic.evidenceCapture,
      hookEventId: input.hook_event_id ?? null,
    });
  } catch (error) {
    await journalDegraded(projectRoot, task.taskId, "APPLY_FAILED", { error: error.message });
    return { status: "DEGRADED", reason: "APPLY_FAILED", error: error.message };
  }
  if ((applied.current?.version ?? 0) === 0) {
    // Freezing an empty ledger would lock every future agent-derived claim
    // out; degrade to incremental extraction instead.
    await journalDegraded(projectRoot, task.taskId, "EMPTY_RESULT");
    return { status: "DEGRADED", reason: "EMPTY_RESULT" };
  }
  const frozen = await freezeGroundTruth({
    projectRoot,
    taskId: task.taskId,
    hookEventId: input.hook_event_id ?? null,
  });
  await appendTaskJournal(projectRoot, task.taskId, {
    type: "ONBOARDING_COMPLETED",
    panelSize: panel.size,
    successfulPasses: passes.length,
    failedPasses: failures.length,
    adjudicated,
    ...(adjudicatorError ? { adjudicatorError, mergeMode: "DETERMINISTIC" } : {}),
    majorityClaims: majority.length,
    disputedClaims: disputed.length,
    appliedClaims: applied.current.claims.length,
    capabilityClaims: applied.current.claims.filter((claim) => claim.category === "capabilityChecklist").length,
    deterministicKits: deterministicKeys.size,
    deterministicCommittedKits: deterministicOps.filter((operation) => operation.severity === "HARD").length,
    catalogUnmatched: crossChecked.catalogUnmatched,
    frozenAtVersion: frozen.current.frozenAtVersion,
  });
  return {
    status: "COMPLETED",
    frozenAtVersion: frozen.current.frozenAtVersion,
    groundTruthVersion: frozen.current.version,
  };
}


/**
 * Idempotent wrapper: runs onboarding exactly once per task — on the first
 * hook event of a new task, before normal processing — records the outcome on
 * task state, and never throws: every failure path degrades to the wave-1
 * incremental extractor behavior.
 */
export async function maybeRunTaskOnboarding(context) {
  const { projectRoot, task, runtimeV2 } = context;
  const dynamic = runtimeV2.dynamicGroundTruth;
  if (!dynamic?.enabled || (dynamic.panel?.size ?? 0) < 1) return null;
  let existing = null;
  let groundTruthVersion = 0;
  await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
    existing = state.onboarding ?? null;
    groundTruthVersion = state.groundTruth?.version ?? 0;
  });
  if (existing) {
    // A deferred panel failure retries on later hook events (the parent
    // session may not be resumable at the very first event); permanent
    // outcomes stand.
    if (existing.status !== "DEFERRED" || (existing.attempts ?? 0) >= 3) return existing;
  }
  // Failure text emitted by the host CLI when a fork targets a parent session
  // that is not persisted yet — an environmental race, not a real panel
  // fault, so it must not consume the (small) real-failure attempt budget.
  const TRANSIENT_RESUME_PATTERN = /No conversation found with session ID/u;
  let outcome;
  if (groundTruthVersion > 0 && !existing) {
    // A ledger that already carries claims (a task resumed from before
    // onboarding existed) must not be re-decomposed and frozen mid-flight.
    // A DEFERRED record is our own retry window: incremental claims added
    // meanwhile merge with the panel result instead of blocking it.
    outcome = { status: "SKIPPED_EXISTING_LEDGER" };
  } else {
    try {
      outcome = await runTaskOnboarding(context);
      if (outcome?.status === "DEGRADED" && outcome.reason === "PANEL_FAILED") {
        const realAttempts = existing?.attempts ?? 0;
        const transientAttempts = existing?.transientAttempts ?? 0;
        const transientOnly = (outcome.failures ?? []).length > 0
          && outcome.failures.every((failure) => TRANSIENT_RESUME_PATTERN.test(failure));
        if (transientOnly && transientAttempts < 5) {
          // Not-yet-resumable parent session: retry on a later event without
          // spending the real-failure budget (bounded so a host that never
          // persists the session still degrades eventually).
          outcome = { status: "DEFERRED", reason: "PANEL_FAILED", attempts: realAttempts, transientAttempts: transientAttempts + 1 };
        } else if (realAttempts < 2) {
          // Real panel failures (timeouts, reviewer faults) get a short
          // retry ladder before permanently degrading.
          outcome = { status: "DEFERRED", reason: "PANEL_FAILED", attempts: realAttempts + 1, transientAttempts };
        }
      }
    } catch (error) {
      outcome = { status: "DEGRADED", reason: "UNEXPECTED_ERROR", error: error.message };
      try {
        await journalDegraded(projectRoot, task.taskId, "UNEXPECTED_ERROR", { error: error.message });
      } catch {
        // Journaling must never break the hook.
      }
    }
  }
  const record = { ...outcome, recordedAt: new Date().toISOString() };
  await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
    state.onboarding = record;
  });
  return record;
}
