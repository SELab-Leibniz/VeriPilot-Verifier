// Automated task onboarding (generalization wave 2): decompose → agent panel
// → freeze, with no user confirmation anywhere.
//
// At the lazy correction barrier of a new task, panel.size independent
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
// Fail-soft: faults without a recoverable candidate keep the incremental
// fallback. Invalid individual operations stay pending while valid siblings
// are written; a partial ledger must never freeze those obligations away.

import { promises as fs } from "node:fs";
import path from "node:path";

import { eventId } from "./event-identity.mjs";
import { applyGroundTruthDelta, freezeGroundTruth, loadCurrentGroundTruth, planGroundTruthDelta } from "./ground-truth-ledger.mjs";
import {
  DEFAULT_CHECKLIST_SECTION_PATTERN,
  DEFAULT_KIT_COLUMN_INDEX,
  checklistVocabularyOverrides,
  kitModuleName,
  parseKitManifest,
} from "./impl-review.mjs";
import { DEFAULT_PLATFORM, loadPlatformAdapter } from "./platform-adapter.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA } from "./reviewer.mjs";
import { scanSkillDirectory } from "./skill-source.mjs";
import {
  appendTaskJournal,
  taskDirectory,
  withTaskResourceLock,
  withTaskState,
} from "./task-store.mjs";
import { sha256 } from "./utils.mjs";
import { VERIFICATION_ROUTING_INSTRUCTIONS } from "./review-routing.mjs";
import { groundTruthSourceCatalog, SOURCE_INSTRUCTIONS } from "./ground-truth-provenance.mjs";
import { resolveReviewTimeoutMs } from "../review-timeout.mjs";
import { normalizeExpectedFiles } from './expected-files.mjs';


const CATALOG_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ONBOARDING_CLEANUP_MARGIN_MS = 60 * 1000;

function onboardingBudgets(runtimeV2) {
  const extractor = resolveReviewTimeoutMs(runtimeV2.reviewers.groundTruthExtractor?.timeoutMs);
  const adjudicator = runtimeV2.dynamicGroundTruth.panel.adjudicator
    ? resolveReviewTimeoutMs(runtimeV2.reviewers.onboardingAdjudicator?.timeoutMs) : 0;
  return { extractor, adjudicator, total: extractor + adjudicator + ONBOARDING_CLEANUP_MARGIN_MS };
}

const ONBOARDING_INSTRUCTIONS = [
  ...SOURCE_INSTRUCTIONS,
  ...VERIFICATION_ROUTING_INSTRUCTIONS,
  "The materials manifest below INLINES each document's text (field: text). Decompose from that text directly — do not re-read the files with tools unless an entry is marked contentTruncated or contentOmitted.",
  "This is the DEDICATED TASK ONBOARDING pass: decompose ALL task materials (the materials manifest below plus the real user request in the parent conversation) into atomic Ground Truth claims in this single pass — complete coverage now, not incremental discovery.",
  "Extract claims only from real user messages, explicitly supplied materials, and verifiable project constraints. Assistant messages, hook feedback, internal reviewer output, and agent-authored artifacts are never USER_EXPLICIT.",
  "Use ADD operations only: this ledger is empty (version 0).",
  "AGENT_INFERRED claims must be SOFT. Do not invent a positive requirement from ambiguous material; use BASIS_PENDING.",
  "Use only the category enum exposed by the output schema; map functional or atomic requirements to requirements and workflow procedures to workflowSteps. Atomize claims: traceabilityRelations for M07 denominator objects, developmentStandards for M09, milestoneTargets for M14, and criticalJourneys for M15.",
  "Mine dependency/capability obligations into capabilityChecklist claims, each carrying capability.name (catalog-style lowercase-hyphenated capability or kit name) and capability.sourceHint (file or section). Do NOT supply capability.module: the platform import specifier is derived deterministically from the name, and a checklist table's other columns (code file, notes) are never the module. Use explicit dependency/kit tables when present (authority MATERIAL_DERIVED, severity HARD) and enumerate EVERY table row — never sample or summarize a table; otherwise infer from requirement semantics (authority AGENT_INFERRED, severity SOFT).",
  "When the task materials are ambiguous about a behavior, record it as an openQuestions claim that states the ambiguity AND a default-safe reading the corrector can review against — never a directive that asserts one resolution.",
];

const ADJUDICATOR_INSTRUCTIONS = [
  ...SOURCE_INSTRUCTIONS,
  ...VERIFICATION_ROUTING_INSTRUCTIONS,
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
// Inlining budget for onboarding: a detached extractor has no inherited
// context, so without the text in the request it must re-read every material
// through tool round-trips before it can decompose anything — which is what
// pushed a 1300-line document past a 15-minute budget. The digest still comes
// from the full bytes, so truncation can never change task identity.
const MAX_INLINE_MATERIAL_BYTES = 400000;
const MAX_INLINE_FILE_BYTES = 200000;

export function sortMaterialEntries(entries, pathApi = path) {
  let base = entries[0]?.root;
  for (const entry of entries) while (base) {
    const relative = pathApi.relative(base, entry.root);
    if (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)) break;
    const parent = pathApi.dirname(base); if (parent === base) break; base = parent;
  }
  const key = entry => `${pathApi.relative(base, pathApi.resolve(entry.root, entry.path)).replaceAll('\\', '/')}\0${pathApi.relative(base, entry.root).replaceAll('\\', '/')}/${entry.path.replaceAll('\\', '/')}`;
  return [...entries].sort((left, right) => { const a = key(left), b = key(right); return a < b ? -1 : a > b ? 1 : 0; });
}

export async function materialManifest(roots, { includeContent = false, capturedEntries } = {}) {
  let entries = [];
  if (capturedEntries) entries.push(...capturedEntries.map(({ text, ...file }) => ({ ...file, ...(includeContent ? { text } : {}) })));
  else for (const root of roots) {
    try {
      const stat = await fs.stat(root);
      if (stat.isDirectory()) {
        const scanned = await scanSkillDirectory(root, { maxFiles: 100, maxBytes: 1024 * 1024 });
        entries.push(...scanned.files.map(({ content, ...file }) => ({
          root: scanned.root,
          ...file,
          ...(includeContent ? { text: content } : {}),
        })));
      } else if (stat.isFile()) {
        const contents = await fs.readFile(root);
        entries.push({
          root: path.dirname(root),
          path: path.basename(root),
          bytes: contents.length,
          sha256: sha256(contents),
          ...(includeContent ? { text: contents.toString("utf8") } : {}),
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  entries = sortMaterialEntries(entries);
  // Digest over identity only: inlined text never participates, so the same
  // materials produce the same digest whether or not content was requested.
  const digest = sha256(entries.map(({ text, ...identity }) => identity));
  if (!includeContent) return { entries, digest };
  let budget = MAX_INLINE_MATERIAL_BYTES;
  const inlined = entries.map((entry) => {
    const text = String(entry.text ?? "");
    const allowance = Math.min(MAX_INLINE_FILE_BYTES, budget);
    if (allowance <= 0) return { ...entry, text: undefined, contentOmitted: true };
    const kept = text.slice(0, allowance);
    budget -= Buffer.byteLength(kept, "utf8");
    return kept.length < text.length
      ? { ...entry, text: kept, contentTruncated: true }
      : { ...entry, text: kept };
  });
  return { entries: inlined, digest };
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
    // Shape is not membership. A reviewer inferring capabilities will coin
    // plausible-looking composites ("pdf-kit-pen-kit", "camera-audio-media-
    // avsession") and non-capabilities ("enterprise-idp-and-directory"); each
    // one looks catalog-shaped and would otherwise become a blocking
    // obligation to import a module that cannot exist. When the platform
    // publishes its vocabulary, a name outside it is review-only.
    const catalog = adapter?.kitCheck?.catalog;
    const knownName = !catalog || catalog.size === 0 || catalog.has(name);
    if (!adapter || !CATALOG_NAME_PATTERN.test(name) || !knownName) {
      unmatched += 1;
      return { ...operation, capability: { ...operation.capability, name, catalogUnmatched: true } };
    }
    return {
      ...operation,
      capability: {
        ...operation.capability,
        name,
        // The module specifier is DERIVED from the platform adapter, never
        // taken from the extractor. A reviewer reading a checklist table sees
        // columns it may map wrongly — one run filled this with the table's
        // code-file column ("BackgroundRefreshService.ets"), and the kit
        // checker then hunted for that as an import, reporting every kit
        // missing. Naming the capability is the extractor's job; translating
        // it into this platform's import convention is the adapter's.
        module: kitModuleName(name, adapter),
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
export async function deterministicCapabilityOperations(materials, implementationCorrection = {}, adapter = null, { readOriginalMaterial } = {}) {
  const operations = [];
  const seen = new Set();
  for (const entry of materials?.entries ?? []) {
    if (!/\.(?:md|markdown)$/iu.test(entry.path)) continue;
    let content;
    try {
      const file = path.join(entry.root, entry.path), captured = await readOriginalMaterial?.(file);
      content = captured ? captured.toString("utf8") : await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const { kits, hedgedKits, kitSections, sectionTitle } = parseKitManifest(content, {
      sectionPattern: implementationCorrection?.checklistSection ?? DEFAULT_CHECKLIST_SECTION_PATTERN,
      kitColumnIndex: implementationCorrection?.kitColumnIndex ?? DEFAULT_KIT_COLUMN_INDEX,
      ...checklistVocabularyOverrides(implementationCorrection ?? {}),
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
        source: { ref: path.resolve(entry.root, entry.path).replaceAll("\\", "/"), kind: "MATERIAL", subject: "MAIN_TASK" },
      });
    }
  }
  return operations;
}


/**
 * The real user messages from the transcript snapshot, in order, capped so a
 * long conversation cannot blow the request size. Assistant output, tool
 * results and the corrector's own internal prompts are excluded — only a
 * genuine user message can carry USER_EXPLICIT authority.
 */
function userRequestMessages(snapshot, { maxMessages = 20, maxChars = 4000 } = {}) {
  const texts = [];
  for (const entry of snapshot?.entries ?? []) {
    if (entry?.type !== "user" || entry.isMeta === true) continue;
    const content = entry.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type !== "text") continue;
      const text = String(block.text ?? "").trim();
      if (!text || text.includes("[runtime-corrector:internal]")) continue;
      texts.push(text.slice(0, maxChars));
    }
  }
  return texts.slice(-maxMessages);
}


const PENDING_OPERATION_REPAIR = 'Every pendingOperations entry is an unresolved original obligation retained from an earlier attempt. Explicitly return that same duty in operations; omission, a rewritten duty, weaker severity/authority, changed conditions or changed proof owner never resolves it. Preserve all original duty fields. Repair only invalid expectedFiles metadata, or an invalid source ref/excerpt while preserving its kind and MAIN_TASK subject. Existing valid siblings may be repeated without changing them; the ledger deduplicates them. Never treat the current panel as permission to discard an earlier obligation.';

function onboardingRequest({ projectRoot, task, input, snapshot, materials, sourceCatalog, passIndex, panelSize, pendingOperations }) {
  return {
    schemaVersion: "runtime-corrector.onboarding-request.v2",
    instructions: [...ONBOARDING_INSTRUCTIONS, ...(pendingOperations.length ? [PENDING_OPERATION_REPAIR] : [])],
    taskId: task.taskId,
    hookEventId: eventId(input),
    onboarding: { passIndex, panelSize },
    pendingOperations: structuredClone(pendingOperations),
    transcriptCursor: snapshot?.lastEntryKey ?? null,
    lastUserCursor: snapshot?.lastUserEntryKey ?? null,
    // Onboarding reviewers run DETACHED (see onboardingReviewer), so the real
    // user request cannot be read from the parent conversation — it travels
    // here instead. Assistant turns are deliberately excluded: they are never
    // USER_EXPLICIT authority.
    userMessages: userRequestMessages(snapshot),
    sourceCatalog,
    currentGroundTruth: {
      version: 0,
      digest: null,
      claims: [],
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
 * panel.size. Onboarding uses the same configured per-role timeout as other
 * reviews; the shared phase deadline can shorten it without extending it.
 */
/**
 * Onboarding reviewers use a DETACHED session by default: they decompose the
 * materials handed to them in the request, so forking the parent conversation
 * buys nothing and costs everything — on a long build the parent is large and
 * still growing, which made the fork itself exceed the budget. An explicit
 * per-role session setting still wins.
 */
function onboardingReviewer(reviewer) {
  return {
    ...reviewer,
    session: reviewer?.sessionExplicit ? reviewer.session : "detached",
  };
}

function operationValidation(message, issues, repairInstruction) {
  const repair = 'Keep EVERY original operation in the same order, preserving its text, source, authority, category and other fields. Correct only expectedFiles to exact delivered paths named in that obligation; do not change or remove a duty to pass validation. Return the complete corrected report.';
  return Object.assign(new Error(JSON.stringify({ code: 'ONBOARDING_OPERATIONS_INVALID', message, issues, repair: repairInstruction ?? repair })),
    { code: 'ONBOARDING_OPERATIONS_INVALID', operationIssues: issues });
}

function pendingOperationMatches(pending, candidate, requireRepair = false) {
  const original = structuredClone(pending.operation), proposed = structuredClone(candidate);
  // These are program-owned panel annotations, not reviewer-editable duty
  // fields. All text, conditions, authority and verification ownership remain
  // exact; only metadata that was actually invalid can be repaired.
  for (const operation of [original, proposed]) { delete operation.panelConfirmed; delete operation.panelVotes; }
  try { if (original.expectedFiles !== undefined) normalizeExpectedFiles(original.expectedFiles, String(original.text ?? '').trim()); }
  catch {
    if (requireRepair) {
      try { if (!normalizeExpectedFiles(proposed.expectedFiles, String(original.text ?? '').trim()).length) return false; }
      catch { return false; }
    }
    delete original.expectedFiles; delete proposed.expectedFiles;
  }
  if (/^SOURCE_/u.test(pending.reasonCode) || pending.reasonCode === 'ONBOARDING_SOURCE_UNVERIFIED') {
    for (const operation of [original, proposed]) if (operation.source) {
      delete operation.source.ref; delete operation.source.excerpt;
    }
  }
  return sha256(original) === sha256(proposed);
}

function onboardingValidation(pendingOperations = []) {
  let lastCandidate, originals;
  const identity = operation => { const { expectedFiles, ...rest } = operation; return sha256(rest); };
  return {
    get candidate() { return lastCandidate; },
    capture(value) {
      const operations = value?.operations ?? [];
      if (!originals || operations.length === originals.length && operations.every((operation, index) => identity(operation) === originals[index])) lastCandidate = value;
    },
    validate(value) {
      const operations = value?.operations ?? [];
      if (originals && (operations.length !== originals.length || operations.some((operation, index) => identity(operation) !== originals[index])))
        throw operationValidation('A metadata repair changed or removed an original obligation.', [{ reason: 'ORIGINAL_OPERATIONS_CHANGED' }]);
      lastCandidate = value;
      const issues = [];
      for (const [index, operation] of operations.entries()) if (operation.expectedFiles !== undefined) {
        try { normalizeExpectedFiles(operation.expectedFiles, String(operation.text ?? '').trim()); }
        catch (error) { issues.push({ index, code: error.code, field: 'expectedFiles', reason: error.message }); }
      }
      if (issues.length) {
        originals ??= operations.map(identity);
        throw operationValidation('Output metadata cannot be written to the Ground Truth ledger.', issues.slice(0, 8));
      }
      const omitted = pendingOperations.filter(pending => !operations.some(operation => pendingOperationMatches(pending, operation, true)));
      if (omitted.length) throw operationValidation('The report omitted or changed unresolved original obligations.',
        omitted.slice(0, 8).map(pending => ({ operationId: pending.operationId, reason: 'PENDING_ORIGINAL_NOT_RECONCILED' })),
        PENDING_OPERATION_REPAIR);
    },
  };
}

async function onboardingOperations(handle, validation, reviewer, deadlineAt) {
  let result = handle.result;
  for (let attempt = 0; ; attempt++) {
    try { validation.validate(result); return result.operations ?? []; }
    catch (error) {
      if (!handle.followUp || attempt >= (reviewer.formatRepairAttempts ?? 3) || Date.now() >= deadlineAt) throw error;
      result = await handle.followUp({ prompt: error.message, nextSchema: GROUND_TRUTH_REVIEW_SCHEMA,
        nextReviewer: { ...onboardingReviewer(reviewer), formatRepairAttempts: 0, timeoutMs: Math.max(1, Math.min(reviewer.timeoutMs, deadlineAt - Date.now())) } });
    }
  }
}

async function preflightOnboardingOperations(operations, { current, taskId, sourceCatalog, evidenceCapture, reviewerFactory, previousPending = [] }) {
  const accepted = [], pending = [], alreadyApplied = [], verified = []; let virtual = current, sourceError;
  const validateSources = reviewerFactory.nativeSourceDelivery === true
    ? values => reviewerFactory.validateSourceBindings(values, sourceCatalog) : null;
  if (validateSources) try { await validateSources(operations); } catch (error) { sourceError = error; }
  const retain = (operation, index, error) => pending.push({ operationId: sha256({ index, operation }), index, status: 'UNVERIFIED',
    reasonCode: error.code ?? 'ONBOARDING_OPERATION_INVALID', reason: String(error.message).slice(0, 2000), operation: structuredClone(operation) });
  for (const [index, operation] of operations.entries()) {
    try {
      if (String(operation.operation ?? '').toUpperCase() !== 'ADD' || !String(operation.text ?? '').trim())
        throw new Error('Onboarding requires a nonempty ADD operation.');
      if (previousPending.some(pending => pendingOperationMatches(pending, operation) && !pendingOperationMatches(pending, operation, true)))
        throw operationValidation('An original delivered-output duty still lacks repaired exact expectedFiles.', [{ index, reason: 'PENDING_METADATA_NOT_REPAIRED' }]);
      if (sourceError) await validateSources([operation]);
      let planned;
      try { planned = planGroundTruthDelta({ current: virtual, taskId, delta: { operations: [operation] }, sourceCatalog, evidenceCapture }); }
      catch (error) {
        if (operation.claimId && virtual.claims.some(claim => claim.claimId === operation.claimId)) {
          const repeated = { ...operation }; delete repeated.claimId;
          const check = planGroundTruthDelta({ current: virtual, taskId, delta: { operations: [repeated] }, sourceCatalog, evidenceCapture });
          const row = check.operationDispositions[0];
          if (row?.disposition === 'DEDUPLICATED' && row.target?.claimId === operation.claimId) {
            alreadyApplied.push({ index, claimId: operation.claimId }); verified.push(operation); continue;
          }
        }
        throw error;
      }
      if (planned.droppedPostFreeze.length || planned.droppedUntrustedSources.length)
        throw Object.assign(new Error('The original source or current ledger cannot admit this operation.'), { code: 'ONBOARDING_SOURCE_UNVERIFIED' });
      virtual = planned.current; accepted.push(operation); verified.push(operation);
    } catch (error) { retain(operation, index, error); }
  }
  if (sourceError && accepted.length) {
    try { await validateSources(accepted); }
    catch (error) {
      for (const operation of accepted) retain(operation, operations.indexOf(operation), error);
      for (let index = verified.length - 1; index >= 0; index--) if (accepted.includes(verified[index])) verified.splice(index, 1);
      accepted.length = 0;
    }
  }
  return { accepted, pending, alreadyApplied, verified };
}

function retainedPendingOperations(previous, pending) {
  const retained = structuredClone(previous);
  for (const item of pending) if (!retained.some(original => original.operationId === item.operationId
    || pendingOperationMatches(original, item.operation))) retained.push(item);
  return retained;
}

export async function runTaskOnboarding({
  input,
  projectRoot,
  sessionCwd,
  task,
  runtimeV2,
  reviewerFactory,
  snapshot = null,
  deadlineAt = Date.now() + onboardingBudgets(runtimeV2).total,
}) {
  const dynamic = runtimeV2.dynamicGroundTruth;
  const panel = dynamic.panel;
  const materials = await (reviewerFactory.materialManifest ?? materialManifest)(dynamic.materialRoots, { includeContent: true });
  const sourceCatalog = await groundTruthSourceCatalog({ snapshot, materials, projectRoot });
  // A new task has no persisted current.json yet. Pass the captured empty
  // ledger so native evidence preparation can publish a readable private
  // snapshot, rather than advertising a live path that does not exist.
  const initialGroundTruth = await loadCurrentGroundTruth(projectRoot, task.taskId);
  // The caller's task object can predate earlier attempts or a restart. Only
  // persisted state owns unresolved originals; an empty new panel cannot erase
  // them. Retain them before reviewer work and expose them to every retry role.
  let previousPending = [];
  await withTaskState({ projectRoot, taskId: task.taskId }, state => {
    previousPending = structuredClone(state.groundTruth.onboardingPending ?? []);
  });
  const budgets = onboardingBudgets(runtimeV2);
  // Preserve both configured phases. A shorter caller deadline divides the
  // available time proportionally instead of reserving a fixed ten minutes.
  const available = Math.max(0, deadlineAt - Date.now() - ONBOARDING_CLEANUP_MARGIN_MS);
  const reserve = Math.min(budgets.adjudicator,
    available * budgets.adjudicator / (budgets.extractor + budgets.adjudicator));
  const extractorDeadlineAt = Math.min(
    deadlineAt - reserve - ONBOARDING_CLEANUP_MARGIN_MS,
    Date.now() + budgets.extractor,
  );
  const passResults = await Promise.all(
    Array.from({ length: panel.size }, (_, index) => index + 1).map(async (passIndex) => {
      let handle = null; const validation = onboardingValidation(previousPending);
      try {
        handle = await reviewerFactory({
          projectRoot,
          sessionCwd,
          taskId: task.taskId,
          parentSessionId: input.session_id,
          role: "onboarding-extractor",
          reviewer: onboardingReviewer(runtimeV2.reviewers.groundTruthExtractor),
          deadlineAt: extractorDeadlineAt,
          schema: GROUND_TRUTH_REVIEW_SCHEMA,
          validateResult: validation.validate,
          onCandidate: validation.capture,
          request: onboardingRequest({ projectRoot, task, input, snapshot, materials, sourceCatalog, passIndex, panelSize: panel.size,
            pendingOperations: previousPending }),
          evidence: { snapshot, groundTruth: initialGroundTruth },
        });
        return { operations: await onboardingOperations(handle, validation, runtimeV2.reviewers.groundTruthExtractor, extractorDeadlineAt) };
      } catch (error) {
        if (validation.candidate && !error.reviewerRuntimeFailure && !['REVIEWER_DEADLINE', 'REVIEWER_OUTPUT_LIMIT'].includes(error.code))
          return { operations: validation.candidate.operations ?? [], validationFailure: error.message };
        return { failure: error.message, budgetExhausted: ["REVIEWER_DEADLINE", "REVIEWER_OUTPUT_LIMIT"].includes(error.code) };
      } finally {
        await handle?.close?.();
      }
    }),
  );
  const passes = passResults.filter((result) => !result.failure).map((result) => result.operations);
  const failures = passResults.filter((result) => result.failure).map((result) => result.failure);
  if (passes.length === 0) {
    await journalDegraded(projectRoot, task.taskId, "PANEL_FAILED", { failures });
    // Repeating a full panel after consuming its entire budget blocks another
    // tool for the same duration. Keep the existing incremental fallback;
    // transient transport/session failures still use the bounded retry ladder.
    return { status: "DEGRADED", reason: "PANEL_FAILED", failures,
      ...(passResults.every((result) => result.budgetExhausted) ? { retryable: false } : {}) };
  }
  const { majority, disputed, votes } = mergePanelOperations(passes);
  let merged = null;
  let adjudicated = false;
  let adjudicatorError = null;
  const adjudicatorDeadlineAt = deadlineAt - ONBOARDING_CLEANUP_MARGIN_MS;
  if (panel.adjudicator && adjudicatorDeadlineAt > Date.now()) {
    let handle = null; const validation = onboardingValidation(previousPending);
    try {
      handle = await reviewerFactory({
        projectRoot,
        sessionCwd,
        taskId: task.taskId,
        parentSessionId: input.session_id,
        role: "onboarding-adjudicator",
        reviewer: onboardingReviewer(runtimeV2.reviewers.onboardingAdjudicator),
        deadlineAt: adjudicatorDeadlineAt,
        schema: GROUND_TRUTH_REVIEW_SCHEMA,
        validateResult: validation.validate,
        onCandidate: validation.capture,
        request: {
          schemaVersion: "runtime-corrector.onboarding-adjudication-request.v2",
          instructions: [...ADJUDICATOR_INSTRUCTIONS, ...(previousPending.length ? [PENDING_OPERATION_REPAIR] : [])],
          taskId: task.taskId,
          hookEventId: eventId(input),
          panelSize: passes.length,
          pendingOperations: structuredClone(previousPending),
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
          sourceCatalog,
          userMessages: userRequestMessages(snapshot),
          currentGroundTruth: { version: 0, digest: null },
        },
        evidence: { snapshot, groundTruth: initialGroundTruth },
      });
      merged = await onboardingOperations(handle, validation, runtimeV2.reviewers.onboardingAdjudicator, adjudicatorDeadlineAt);
      adjudicated = true;
    } catch (error) {
      // The panel already produced complete claim sets; discarding them would
      // throw away the whole onboarding (and all protection) over a merge
      // fault. Fall through to the deterministic merge instead — the same
      // conservative path used when no adjudicator is configured.
      adjudicatorError = error.message;
      if (validation.candidate && !error.reviewerRuntimeFailure && !['REVIEWER_DEADLINE', 'REVIEWER_OUTPUT_LIMIT'].includes(error.code))
        merged = validation.candidate.operations ?? [];
      await journalDegraded(projectRoot, task.taskId, "ADJUDICATION_FAILED", {
        error: error.message,
        recovery: merged === null ? "DETERMINISTIC_MERGE" : 'ISOLATE_INVALID_OPERATIONS',
      });
    } finally {
      await handle?.close?.();
    }
  } else if (panel.adjudicator) {
    adjudicatorError = "Onboarding adjudication skipped because the shared deadline was exhausted.";
    await journalDegraded(projectRoot, task.taskId, "ADJUDICATION_DEADLINE_EXHAUSTED", {
      recovery: "DETERMINISTIC_MERGE",
    });
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
  const confirmed = merged.map((operation) => (majorityKeys.has(panelClaimKey(operation))
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
  const deterministicOps = await deterministicCapabilityOperations(materials, runtimeV2.implementationCorrection, adapter,
    { readOriginalMaterial: reviewerFactory.readOriginalMaterial });
  const deterministicKeys = new Map(deterministicOps.map((operation) => [capabilityVoteKey(operation.capability.name), operation]));
  const seenCapabilityKeys = new Set();
  const withDeterministic = confirmed.map((operation) => {
    if (operation.category !== "capabilityChecklist" || !operation.capability?.name) return operation;
    const key = capabilityVoteKey(operation.capability.name);
    seenCapabilityKeys.add(key);
    const deterministic = deterministicKeys.get(key);
    if (!deterministic) return operation;
    // The material's own words about a kit outrank panel judgement in BOTH
    // directions. A committed table entry upgrades the claim to a blocking
    // obligation; an entry the material hedges (候选 / POC / future) caps it at
    // SOFT even when a panel pass committed to it — otherwise the panel
    // silently manufactures obligations out of capabilities the document
    // deliberately declined to commit to, which is the exact failure the
    // candidacy split exists to prevent.
    return deterministic.severity === "HARD"
      ? { ...operation, authority: "MATERIAL_DERIVED", severity: "HARD", panelConfirmed: true, source: deterministic.source }
      : { ...operation, severity: "SOFT" };
  });
  for (const [key, operation] of deterministicKeys) {
    if (!seenCapabilityKeys.has(key)) withDeterministic.push({ ...operation, panelConfirmed: true });
  }
  const crossChecked = crossCheckCapabilityOperations(withDeterministic, adapter);
  let applied, preflight;
  try {
    preflight = await preflightOnboardingOperations(crossChecked.operations, { current: await loadCurrentGroundTruth(projectRoot, task.taskId),
      taskId: task.taskId, sourceCatalog, evidenceCapture: dynamic.evidenceCapture, reviewerFactory, previousPending });
    // An invalid operation remains an explicit obligation to resolve. A valid
    // subset cannot freeze a shorter ledger or certify the whole task.
    for (const pending of preflight.pending) await appendTaskJournal(projectRoot, task.taskId, {
      type: 'ONBOARDING_OPERATION_UNVERIFIED', hookEventId: eventId(input), ...pending });
    const retained = retainedPendingOperations(previousPending, preflight.pending);
    // Write unresolved originals before the ledger delta. If interrupted after
    // a successful repair applies, the next explicit retry can deduplicate it;
    // interrupted work must never clear an obligation without a durable claim.
    await withTaskState({ projectRoot, taskId: task.taskId }, state => { state.groundTruth.onboardingPending = retained; });
    applied = await applyGroundTruthDelta({
      projectRoot,
      taskId: task.taskId,
      delta: { operations: preflight.accepted },
      sourceCatalog,
      evidenceCapture: dynamic.evidenceCapture,
      hookEventId: eventId(input),
    });
    const resolved = previousPending.filter(pending => preflight.verified.some(operation => pendingOperationMatches(pending, operation, true)));
    preflight.pending = retained.filter(pending => !resolved.some(original => original.operationId === pending.operationId));
    for (const pending of resolved) await appendTaskJournal(projectRoot, task.taskId, {
      type: 'ONBOARDING_OPERATION_RECONCILED', hookEventId: eventId(input), operationId: pending.operationId,
      groundTruthVersion: applied.current.version });
    await withTaskState({ projectRoot, taskId: task.taskId }, state => { state.groundTruth.onboardingPending = preflight.pending; });
  } catch (error) {
    await journalDegraded(projectRoot, task.taskId, "APPLY_FAILED", { error: error.message });
    return { status: "DEGRADED", reason: "APPLY_FAILED", error: error.message };
  }
  if (preflight.pending.length) return { status: 'UNVERIFIED', reason: 'OPERATIONS_PENDING', pendingOperations: preflight.pending,
    alreadyApplied: preflight.alreadyApplied, groundTruthVersion: applied.current.version };
  if ((applied.current?.version ?? 0) === 0) {
    // Freezing an empty ledger would lock every future agent-derived claim
    // out; degrade to incremental extraction instead.
    await journalDegraded(projectRoot, task.taskId, "EMPTY_RESULT");
    return { status: "DEGRADED", reason: "EMPTY_RESULT" };
  }
  const frozen = await freezeGroundTruth({
    projectRoot,
    taskId: task.taskId,
    hookEventId: eventId(input),
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
    alreadyApplied: preflight.alreadyApplied,
    frozenAtVersion: frozen.current.frozenAtVersion,
  });
  return {
    status: "COMPLETED",
    frozenAtVersion: frozen.current.frozenAtVersion,
    groundTruthVersion: frozen.current.version,
  };
}


/**
 * Idempotent wrapper body. The exported entry point serializes this whole
 * check/run/record transaction so parallel first-tool hooks cannot both see
 * an empty onboarding record and start duplicate reviewer panels.
 */
async function maybeRunTaskOnboardingUnlocked(context) {
  const { projectRoot, task, runtimeV2 } = context;
  const dynamic = runtimeV2.dynamicGroundTruth;
  if (!dynamic?.enabled || (dynamic.panel?.size ?? 0) < 1) return null;
  let existing = null;
  let groundTruthVersion = 0;
  let hasPendingOperations = false;
  await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
    existing = state.onboarding ?? null;
    groundTruthVersion = state.groundTruth?.version ?? 0;
    hasPendingOperations = (state.groundTruth?.onboardingPending?.length ?? 0) > 0;
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
  if (groundTruthVersion > 0 && !existing && !hasPendingOperations) {
    // A ledger that already carries claims (a task resumed from before
    // onboarding existed) must not be re-decomposed and frozen mid-flight.
    // A DEFERRED record is our own retry window: incremental claims added
    // meanwhile merge with the panel result instead of blocking it. Persisted
    // pending originals also identify our own interrupted onboarding even if
    // the process ended before its outer onboarding record was committed.
    outcome = { status: "SKIPPED_EXISTING_LEDGER" };
  } else {
    try {
      outcome = await runTaskOnboarding(context);
      if (outcome?.status === 'UNVERIFIED' && outcome.reason === 'OPERATIONS_PENDING' && (existing?.attempts ?? 0) < 2)
        outcome = { ...outcome, status: 'DEFERRED', attempts: (existing?.attempts ?? 0) + 1 };
      if (outcome?.status === "DEGRADED" && outcome.reason === "PANEL_FAILED" && outcome.retryable !== false) {
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


/**
 * Run onboarding exactly once per task at the lazy correction barrier. The
 * lock deliberately outlives reviewer budgets; if Ctrl+C kills its owning
 * hook process, the next barrier reclaims it by owner liveness immediately.
 */
export async function maybeRunTaskOnboarding(context) {
  const { projectRoot, task, runtimeV2 } = context;
  const dynamic = runtimeV2.dynamicGroundTruth;
  if (!dynamic?.enabled || (dynamic.panel?.size ?? 0) < 1) return null;
  const budgetMs = onboardingBudgets(runtimeV2).total;
  const deadlineAt = context.deadlineAt ?? Date.now() + budgetMs;
  return withTaskResourceLock({
    projectRoot,
    taskId: task.taskId,
    resource: "onboarding",
    timeoutMs: budgetMs,
    staleMs: budgetMs + 2 * 60 * 1000,
    reclaimDeadOwner: true,
  }, () => maybeRunTaskOnboardingUnlocked({ ...context, deadlineAt }));
}
