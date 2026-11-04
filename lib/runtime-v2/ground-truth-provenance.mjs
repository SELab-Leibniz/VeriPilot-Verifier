import { promises as fs } from "node:fs";
import path from "node:path";

import * as activeHost from "../active-host.mjs";
import { sha256 } from './utils.mjs';

export const TASK_SCOPE_INSTRUCTIONS = [
  'Separate the rules of the repository from the workflow the task actually adopts. Keep standing rules governing actions or edits that can occur in this workspace, including prohibitions and cross-file consistency rules. If such a rule starts with an external trigger, retain it as a conditional duty with its full original trigger, owner and effect even when the requested change does not itself mention that trigger. A dormant conditional duty is not an execution requirement or evidence of activation. For example, a rule to synchronize manifests when a permission is changed remains conditional even for a change that requests no permission change.',
  'A documented separate delivery or collaboration workflow (such as deploying a signed release or passing a deliverable between named agents) does not require executing that workflow unless the current originals adopt it. Account for a clearly unselected workflow as context with a scope reason, including any steps internal to it. Preserve safeguards that apply to actions outside that workflow independently. If a binding workflow or its trigger may be in scope and the originals do not resolve it, retain the condition or report uncertainty. A heading, imperative within a workflow, or presence of tooling does not activate it. Never treat internal application branches or explicit current user requirements as optional external workflows.',
  'Troubleshooting and scope: preserve a standing symptom-to-action rule as conditional PROCESS when it tells the agent what to check or do if that symptom occurs in this workspace. Keep each distinct symptom, action, and retry condition. A FAQ heading and an unobserved symptom do not make the rule background; descriptive causes, informational tables and advice confined to an unselected workflow can remain context. Do not infer that a symptom occurred.',
  'Test methods and scope: when the originals prescribe a baseline method for a particular class of tests, retain that method as PROCESS with its own test-class trigger. A request to run or compare local tests adopts their documented local method when the repository prescribes one. It does not adopt CI, device installation, device smoke or optional scenarios listed alongside it. Check each entry in a mixed test-command block separately; keep descriptive examples as context and do not add invocations or trigger conditions absent from the originals.',
  'Read the complete user request, including trailing procedural guidance and verification/reporting clauses. Apply one owner per required result. A comparison the agent must perform is PROCESS; information explicitly required in the delivered report is ARTIFACT. A rule governing the contents of delivered tests, including a ban on weakening assertions, belongs to IMPLEMENTATION/TEST; actually running or comparing tests is PROCESS. When one clause requires changing a test and explaining that change in the report, keep the distinct duties with the same original condition.',
  'For compound rules, separate independently testable duties before assigning owners. Ask what each duty forbids or requires and what could disprove it: the delivered files or behavior, or the actual actions performed. If both are independently required, give each its own obligation with the same original source range and its own owner. Preserve the trigger and exceptions of each facet; do not make a conditional restriction a request to change a file.',
  'Encoding and read-back: when a rule requires UTF-8 source/test files and forbids committing garbled or wrongly transcoded text, the delivered-file constraint is IMPLEMENTATION (ARTIFACT for separately delivered documents). A requirement to reread or verify after editing is a distinct PROCESS duty. A passing read-back does not itself establish clean delivered contents. A rule only prescribing how to run an encoding tool, without a distinct requirement on delivered contents, is PROCESS.',
  'Regression and tests: preserving unrelated passing application behavior is an IMPLEMENTATION constraint, while running tests, comparing results against the original baseline, and distinguishing existing failures from regressions are PROCESS. Do not bundle behavior preservation into test execution. A required report of those checks is ARTIFACT. Where an original separately prohibits hardcoded local tool paths in delivered scripts, that is an IMPLEMENTATION content constraint; resolving which installed tool to invoke and when to use a fallback are PROCESS.',
];

export const SOURCE_INSTRUCTIONS = [
  ...TASK_SCOPE_INSTRUCTIONS,
  "Ground Truth describes the MAIN_TASK, never this reviewer/adjudicator. Internal role prompts, hook output, reviewer permissions and inherited assistant claims cannot become obligations under ANY authority, including PROJECT_CONSTRAINT.",
  "For every authoritative claim, cite a ref from sourceCatalog and set source.subject=MAIN_TASK and source.kind to that catalog entry's kind. A file/section anchor may be appended. Unknown sources are rejected before freezing; do not relabel internal instructions as project constraints.",
  "Preserve the source's meaning, normative force, conditions and scope. Semantic paraphrases are allowed; verbatim reproduction is not required. A valid source identity or a model-generated HARD/MUST label does not prove that the source entails the proposed obligation.",
  "For every newly generated operation and Skill constraint, set the separate applicabilityKind field to exactly CURRENT_TASK, CONDITIONAL, FUTURE or UNKNOWN. It selects a review route only; it does not prove metric applicability, that a condition holds, or fulfillment. Preserve natural applicability/condition text, claim text and source, including the subject, objects, triggers, limits and exceptions. Never replace those fields with machine tags or prefixes, or drop their scope information.",
  "CURRENT_TASK means an obligation belongs to this task. Internal business branches (for example, required invalid-input/error behavior) and requirements to verify before declaring completion remain current obligations; if/when/before wording alone does not make them CONDITIONAL or FUTURE. Use CONDITIONAL only when the entire obligation takes effect under an external activation condition, FUTURE only for an explicitly deferred scope, and UNKNOWN when the authoritative basis cannot establish its applicability. A label naming a command, file or object is not an activation condition. Keep every actual condition in the original natural fields and source; do not infer or invent one from a label.",
  "For Ground Truth operations, applicability is an optional string: preserve any original natural scope as text, or omit this property when there is no separate scope. Never set operation.applicability to null. This differs from the nullable Skill condition field; neither changes the separate applicabilityKind route or the original obligation.",
  "For each new Skill constraint, explicitly use condition=null when the original obligation has no activation condition; otherwise preserve its complete source-backed condition separately from applicabilityKind. A routing tag never authorizes a PASS, NOT_APPLICABLE, omitted obligation or weaker acceptance condition.",
  "Separate required actions from strict ordering relations. A request to read material does not by itself mean before ANY modification. Numbering, prose order and common working habits alone do not establish mandatory prerequisites. Keep suggestions advisory; do not add all/every/before/after/permanent-failure conditions without support in the original source.",
  "Preserve genuinely mandatory prerequisites and prohibitions, including ones clearly entailed by the source, without inventing additional steps. If a derived relation is uncertain, keep that relation SOFT/BASIS_PENDING (SHOULD/MAY in a Skill graph); do not weaken an independently supported mandatory action.",
  "These rules also apply to Skill constraints, dependsOn edges and task overlays. Cite each Skill constraint's original source in sourceRef; a previously extracted graph, duplicated metric or reviewer assertion is not independent authority for a stronger rule. Require a particular reading tool only if the original obligation requires it; attributable delivery of the required content through an equivalent tool can satisfy reading.",
];

function normalizedRef(ref) {
  return String(ref ?? "").trim().replaceAll("\\", "/").replace(/#.*$/u, "").replace(/:\d+(?:-\d+)?$/u, "");
}

// Generic aliases such as "user" cannot identify one input in a multi-turn
// conversation. Only an unambiguous original user source may authorize a delta.
export function userSourceRef(source, catalog = []) {
  const matches = catalog.filter(entry => entry.kind === "USER_MESSAGE"
    && [entry.ref, ...(entry.aliases ?? [])].some(ref => normalizedRef(ref) === normalizedRef(source?.ref)));
  const refs = [...new Set(matches.map(entry => entry.ref))];
  return refs.length === 1 ? refs[0] : null;
}

export function pendingUserSourceRefs(current, catalog) {
  const seen = new Set(current.userSourceRefs ?? current.claims.map(claim => userSourceRef(claim.source, catalog)).filter(Boolean));
  return catalog.filter(entry => entry.kind === "USER_MESSAGE" && (!seen.has(entry.ref)
    || entry.contentDigest && current.userSourceHashes?.[entry.ref] && current.userSourceHashes[entry.ref] !== entry.contentDigest)).map(entry => entry.ref);
}

export const GROUND_TRUTH_ADMISSION_POLICY = 'ground-truth-admission-v1-pre-ready';

// Program-owned navigation, never a semantic endorsement of retained claims.
export function groundTruthAdmissionContext(current, catalog) {
  const eligibleUserRefs = pendingUserSourceRefs(current, catalog);
  const frozen = current.version > 0 && current.frozenAtVersion != null;
  const claims = current.claims.filter(claim => claim.status === 'ACTIVE');
  return { policy: GROUND_TRUTH_ADMISSION_POLICY, baselineVersion: current.version, baselineDigest: current.digest,
    frozenAtVersion: current.frozenAtVersion ?? null,
    mode: frozen ? eligibleUserRefs.length ? 'NEW_USER_ONLY' : 'READ_ONLY_RECONCILIATION' : 'SOURCE_GROUNDED_CHANGES',
    eligibleUserRefs, currentClaimCount: claims.length, claimsNavigationOnly: true,
    currentClaims: claims.slice(0, 16).map(claim => ({ claimId: claim.claimId, category: claim.category,
      authority: claim.authority, verificationTarget: claim.verificationTarget, sourceRef: claim.source?.ref })),
    moreClaims: Math.max(0, claims.length - 16), currentClaimNavigation: 'Read the complete frozen baseline-* files for every current claim; this sample grants no coverage.',
    repair: 'Preserve existing claims; only eligible new real user refs authorize frozen-ledger changes. For read-only reconciliation, use full mode and an empty NO_CHANGE delta, then complete the independent original coverage audit. If draft whole-original exclusion is not exact, request ONLY batchId + fullTextReason; never weaken exclusion or invent a user source. Existing saved candidates require the original explicit reviseCandidate control before changing them; no allowance resets.',
  };
}

// Pure, identical admission rules for partial saves and the final outer guard.
// Save has no classification yet: only classification-independent rules apply.
export function groundTruthAdmissionFailure(candidate, current, catalog, { classificationKnown = true } = {}) {
  const operations = candidate.operations;
  const pending = pendingUserSourceRefs(current, catalog);
  const newTask = classificationKnown && current.version > 0 && candidate.taskClassification === 'NEW_TASK';
  const authorizedUser = operation => operation.authority === 'USER_EXPLICIT'
    && !rejectedGroundTruthSource(operation, catalog) && pending.includes(userSourceRef(operation.source, catalog));
  let issueCount = 0;
  const issues = [];
  const reject = (reason, message, operationIndex = null) => {
    if (++issueCount <= 8) issues.push({ reason, message, operationIndex, sourceRef: operations[operationIndex]?.source?.ref ?? null });
  };
  if (newTask && (!pending.length || !operations.some(authorizedUser)))
    reject('NEW_TASK_WITHOUT_PENDING_USER_OPERATION', 'NEW_TASK requires a new unprocessed real user source and its grounded operation; repair taskClassification or the reported source, never the original obligation.');
  for (const [index, operation] of operations.entries()) {
    const rejected = rejectedGroundTruthSource(operation, catalog);
    if (rejected) reject('SOURCE_REJECTED', `Ground Truth source rejected: ${rejected}`, index);
    if (current.version > 0 && (current.frozenAtVersion != null || newTask)) {
      if (operation.authority === 'USER_EXPLICIT' && !authorizedUser(operation))
        reject('PROCESSED_OR_AMBIGUOUS_USER_SOURCE', 'An old or ambiguous user source cannot authorize this change; cite the exact new unprocessed real user source.', index);
      if (current.frozenAtVersion != null && operation.authority !== 'USER_EXPLICIT')
        reject('FROZEN_NON_USER_OPERATION', 'Frozen Ground Truth accepts only operations authorized by new real user sources; unsupported material operations cannot be silently consumed.', index);
    }
  }
  return issues.length ? { ...issues[0], issues, issueCount, newTask, admission: groundTruthAdmissionContext(current, catalog) } : null;
}

export async function groundTruthSourceCatalog({ snapshot, materials, projectRoot, skill = null, hostAdapter = activeHost }) {
  const sources = [];
  for (const entry of snapshot?.entries ?? []) {
    if (entry.type !== "user" || entry.isMeta === true) continue;
    const content = entry.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const text = (Array.isArray(blocks) ? blocks : []).filter((block) => block.type === "text")
      .map((block) => block.text ?? "").join("\n");
    if (!text.trim() || text.includes("[runtime-corrector:internal]")) continue;
    const ids = [entry.uuid, entry.message?.id, entry.entryKey].filter(Boolean);
    sources.push({
      ref: `transcript:${ids[0] ?? sources.length + 1}`, kind: "USER_MESSAGE",
      contentDigest: sha256(text),
      aliases: [...ids.flatMap((id) => [id, `transcript:${id}`]), "user", "user prompt"],
    });
  }
  for (const file of [...(materials?.entries ?? []), ...(skill?.source?.files ?? []).map((file) => ({ ...file, root: skill.directory }))]) {
    const absolute = path.resolve(file.root, file.path);
    const relative = path.relative(projectRoot, absolute).replaceAll("\\", "/");
    sources.push({
      ref: absolute.replaceAll("\\", "/"), kind: "MATERIAL", projectRelativePath:relative,
      aliases: [relative, file.path, `${path.basename(file.root)}/${file.path}`],
    });
  }
  // Only existing, first-party project instruction files join the catalog;
  // generated artifacts and the corrector's private request files do not.
  for (const name of hostAdapter.instructionFileNames) {
    const file = path.join(projectRoot, name);
    try {
      if ((await fs.stat(file)).isFile()) sources.push({ ref: name, kind: "PROJECT_FILE", aliases: [file.replaceAll("\\", "/")] });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return sources;
}

export function rejectedGroundTruthSource(operation, catalog = null) {
  const source = operation.source ?? {};
  if (source.subject && source.subject !== "MAIN_TASK") return "REVIEWER_SUBJECT";
  if (source.kind === "INTERNAL_REVIEWER" || /^(?:system|assistant|tool|reviewer)$/iu.test(source.role ?? "")) return "INTERNAL_ROLE";
  const ref = normalizedRef(source.ref);
  const matches = (catalog??[]).filter((entry) => [entry.ref, ...(entry.aliases ?? [])].some((candidate) => normalizedRef(candidate) === ref));
  // Internal ownership is relative to the business project, not an arbitrary
  // ancestor directory name. A clean isolated project may itself live under
  // an observer's .runtime-correction directory.
  const pathRef=matches.length&&matches.every(entry=>typeof entry.projectRelativePath==='string')
    ? matches.map(entry=>entry.projectRelativePath).join('\n') : ref;
  if (/\[runtime-corrector:internal\]|^(?:internal[ /:_-]|system(?:[ /:_-]|$)|assistant(?:[ /:_-]|$)|hook(?:[ /:_-]|$)|reviewer(?:[ /:_-]|$))|system role/iu.test(ref)
    || /(?:^|\/)\.runtime-correction\//imu.test(pathRef)) return "INTERNAL_SOURCE";
  if (!catalog || ["AGENT_INFERRED", "BASIS_PENDING"].includes(operation.authority)) return null;
  if (matches.length === 0) return "SOURCE_NOT_IN_CATALOG";
  // Legacy generic user refs remain readable, but file aliases may not bind
  // ambiguously when two materials share a basename.
  if (new Set(matches.map((entry) => normalizedRef(entry.ref))).size > 1
    && matches.some((entry) => entry.kind !== "USER_MESSAGE")) return "AMBIGUOUS_SOURCE";
  if (source.kind && matches.every((entry) => entry.kind !== source.kind)) return "SOURCE_KIND_MISMATCH";
  if (operation.authority === "USER_EXPLICIT" && matches.every((entry) => entry.kind !== "USER_MESSAGE")) return "NON_USER_AUTHORITY";
  return null;
}

// Accepted ledger claims do not re-enter catalog admission when materials or
// configuration change. The trusted caller root only identifies ownership;
// it grants neither source authority nor current evidence of fulfillment.
export function rejectedGroundTruthOwnership(operation, { projectRoot } = {}) {
  const source = operation.source ?? {};
  if (source.subject && source.subject !== "MAIN_TASK") return "REVIEWER_SUBJECT";
  if (source.kind === "INTERNAL_REVIEWER" || /^(?:system|assistant|tool|reviewer)$/iu.test(source.role ?? "")) return "INTERNAL_ROLE";
  const ref = normalizedRef(source.ref);
  let pathRef = ref;
  if (projectRoot && path.isAbsolute(ref)) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(ref));
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      pathRef = relative.replaceAll('\\', '/');
  }
  if (/\[runtime-corrector:internal\]|^(?:internal[ /:_-]|system(?:[ /:_-]|$)|assistant(?:[ /:_-]|$)|hook(?:[ /:_-]|$)|reviewer(?:[ /:_-]|$))|system role/iu.test(ref)
    || /(?:^|\/)\.runtime-correction\//imu.test(pathRef)) return "INTERNAL_SOURCE";
  return null;
}
