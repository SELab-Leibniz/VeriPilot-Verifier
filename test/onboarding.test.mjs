import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import {
  applyGroundTruthDelta,
  freezeGroundTruth,
  loadCurrentGroundTruth,
} from "../lib/runtime-v2/ground-truth-ledger.mjs";
import {
  capabilityChecklistFromClaims,
  checkKitIntegration,
  IMPL_REVIEW_SCHEMA,
} from "../lib/runtime-v2/impl-review.mjs";
import {
  crossCheckCapabilityOperations,
  materialManifest,
  mergePanelOperations,
  panelClaimKey,
} from "../lib/runtime-v2/onboarding.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { loadPlatformAdapter } from "../lib/runtime-v2/platform-adapter.mjs";
import {
  GROUND_TRUTH_REVIEW_SCHEMA,
  STOP_REVIEW_SCHEMA,
} from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskStatePath } from "../lib/runtime-v2/task-store.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, contents) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

function transcriptEntries(turns) {
  const entries = [];
  for (let index = 1; index <= turns; index += 1) {
    entries.push({ type: "user", uuid: `user-${index}`, message: { id: `um-${index}`, content: `request ${index}` } });
    entries.push({ type: "assistant", uuid: `assistant-${index}`, message: { id: `am-${index}`, content: `work ${index}` } });
  }
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function onboardingPlan(projectRoot, overrides = {}) {
  return {
    runtimeV2: compileRuntimeV2Config({
      version: 2,
      dynamicGroundTruth: { enabled: true, materialRoots: [".runtime-corrector/materials"] },
      skillCorrection: { enabled: false, selection: { mode: "include", include: [] } },
      artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
      stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
      ...overrides,
    }, { policyRoot: path.join(projectRoot, ".runtime-corrector") }),
  };
}

const REQUIREMENT_OP = Object.freeze({
  operation: "ADD",
  category: "requirements",
  text: "The home page must render the product list.",
  authority: "USER_EXPLICIT",
  severity: "HARD",
  source: { ref: "transcript:user-1" },
});

const SCAN_CAPABILITY_OP = Object.freeze({
  operation: "ADD",
  category: "capabilityChecklist",
  text: "The app must integrate scan-kit for barcode scanning.",
  authority: "MATERIAL_DERIVED",
  severity: "HARD",
  source: { ref: "materials/app-requirements.md#10.1" },
  capability: { name: "scan-kit", sourceHint: "10.1 Kit使用清单" },
});

const MAP_CAPABILITY_OP = Object.freeze({
  operation: "ADD",
  category: "capabilityChecklist",
  text: "Map display is probably needed for the store-locator requirement.",
  authority: "AGENT_INFERRED",
  severity: "SOFT",
  source: { ref: "materials/app-requirements.md#stores" },
  capability: { name: "map-kit", sourceHint: "store locator requirement" },
});

/**
 * Role-aware fake factory: onboarding passes and the adjudicator are keyed by
 * role, everything else mirrors the standard incremental fakes.
 */
function onboardingFakeFactory({
  passOperations = () => [REQUIREMENT_OP],
  adjudicate = (request) => [...request.majorityOperations, ...request.disputedOperations],
  failOnboardingRoles = false,
  failAdjudicator = false,
  incrementalOperations = () => [],
  stopAssessment = null,
  implAssessment = null,
} = {}) {
  const calls = [];
  const factory = async ({ projectRoot, role, request, schema }) => {
    if (failOnboardingRoles && role.startsWith("onboarding-")) {
      throw new Error(`fake ${role} failure`);
    }
    if (failAdjudicator && role === "onboarding-adjudicator") {
      throw new Error("fake adjudicator failure");
    }
    calls.push({ role, request, schema });
    const requestDirectory = path.join(projectRoot, ".runtime-correction", "fake-review", String(calls.length));
    await fs.mkdir(requestDirectory, { recursive: true });
    let result;
    if (role === "onboarding-extractor") {
      result = {
        summary: "Onboarding decomposition.",
        taskClassification: "CONTINUATION",
        operations: passOperations(request.onboarding.passIndex, request),
      };
    } else if (role === "onboarding-adjudicator") {
      result = {
        summary: "Adjudicated.",
        taskClassification: "CONTINUATION",
        operations: adjudicate(request),
      };
    } else if (schema === GROUND_TRUTH_REVIEW_SCHEMA) {
      result = {
        summary: "Incremental refresh.",
        taskClassification: "CONTINUATION",
        operations: incrementalOperations(request),
        skillGroundTruth: null,
      };
    } else if (schema === STOP_REVIEW_SCHEMA) {
      result = stopAssessment(request);
    } else if (schema === IMPL_REVIEW_SCHEMA) {
      result = implAssessment(request);
    } else {
      throw new Error(`Unexpected fake reviewer role: ${role}`);
    }
    return {
      result,
      requestDirectory,
      async followUp({ nextSchema }) {
        if (nextSchema === STOP_REVIEW_SCHEMA) {
          const assessment = JSON.parse(await fs.readFile(
            path.join(requestDirectory, "assessment-request.json"),
            "utf8",
          ));
          return stopAssessment(assessment);
        }
        throw new Error("Unexpected fake follow-up schema.");
      },
      async close() {},
    };
  };
  factory.calls = calls;
  return factory;
}

function passingStopAssessment(request) {
  const objects = Object.values(request.population.metrics).flat();
  return {
    summary: "Stage complete.",
    stopClassification: "STAGE_COMPLETE",
    stage: "implementation",
    findings: [],
    metricObjectJudgements: objects.map((object) => ({
      objectId: object.objectId,
      judgement: "PASS",
      reason: "Satisfied.",
      evidence: ["session evidence"],
    })),
  };
}

function passingImplAssessment(request) {
  const owned = Object.values(request.population.metrics).flat();
  return {
    summary: "Implementation matches.",
    findings: [],
    metricObjectJudgements: owned.map((object) => ({
      objectId: object.objectId,
      judgement: "PASS",
      reason: "Implemented.",
      evidence: ["entry/src/main/ets/pages/Index.ets:1"],
    })),
  };
}

async function stopEvent(root, plan, factory, id) {
  return handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-onboarding",
      transcript_path: path.join(root, "transcript.jsonl"),
      hook_event_name: "Stop",
      hook_event_id: id,
      last_assistant_message: "Stage complete.",
    },
    projectRoot: root,
    plan,
    reviewerFactory: factory,
  });
}

async function readTaskArtifacts(root) {
  const tasksRoot = path.join(root, ".runtime-correction", "tasks");
  const [taskId] = await fs.readdir(tasksRoot);
  const state = JSON.parse(await fs.readFile(path.join(tasksRoot, taskId, "task.json"), "utf8"));
  const groundTruth = await loadCurrentGroundTruth(root, taskId);
  const journal = await fs.readFile(path.join(tasksRoot, taskId, "journal", "events.jsonl"), "utf8");
  return { taskId, state, groundTruth, journal };
}


test("panel config defaults to size 2 with an adjudicator, and size 0 disables onboarding", () => {
  // The schema accepts the new panel and onboardingAdjudicator keys.
  const document = {
    version: 2,
    artifacts: [],
    dynamicGroundTruth: { enabled: true, panel: { size: 3, adjudicator: false } },
    reviewers: { onboardingAdjudicator: { effort: "low" } },
  };
  assert.equal(validateProjectConfig(document, "config.yaml"), document);
  assert.throws(
    () => validateProjectConfig({
      version: 2,
      artifacts: [],
      dynamicGroundTruth: { enabled: true, panel: { size: -1 } },
    }, "config.yaml"),
    /panel/u,
  );
  const compiled = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true } });
  assert.equal(compiled.dynamicGroundTruth.panel.size, 2);
  assert.equal(compiled.dynamicGroundTruth.panel.adjudicator, true);
  const disabled = compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true, panel: { size: 0, adjudicator: false } },
  });
  assert.equal(disabled.dynamicGroundTruth.panel.size, 0);
  assert.equal(disabled.dynamicGroundTruth.panel.adjudicator, false);
  // A malformed size falls back to the default rather than exploding the panel.
  const malformed = compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true, panel: { size: -3 } },
  });
  assert.equal(malformed.dynamicGroundTruth.panel.size, 2);
});


test("mergePanelOperations partitions majority and disputed claims by stable key", () => {
  const wordingA = { ...REQUIREMENT_OP, text: "The home page  MUST render the product list." };
  assert.equal(panelClaimKey(REQUIREMENT_OP), panelClaimKey({ ...REQUIREMENT_OP }));
  // Capability claims vote by capability name, not prose wording.
  assert.equal(
    panelClaimKey(SCAN_CAPABILITY_OP),
    panelClaimKey({ ...SCAN_CAPABILITY_OP, text: "different wording" }),
  );
  const { majority, disputed } = mergePanelOperations([
    [REQUIREMENT_OP, SCAN_CAPABILITY_OP],
    [wordingA, MAP_CAPABILITY_OP],
  ]);
  // Case/whitespace-normalized text agreement counts as a majority vote.
  assert.deepEqual(majority.map((operation) => operation.category), ["requirements"]);
  assert.deepEqual(
    disputed.map((operation) => operation.capability?.name).sort(),
    ["map-kit", "scan-kit"],
  );
  // A single pass is its own majority.
  const single = mergePanelOperations([[REQUIREMENT_OP]]);
  assert.equal(single.majority.length, 1);
  assert.equal(single.disputed.length, 0);
});


test("crossCheckCapabilityOperations resolves modules from the platform catalog and flags unmatched entries", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  const checked = crossCheckCapabilityOperations([
    REQUIREMENT_OP,
    SCAN_CAPABILITY_OP,
    { ...SCAN_CAPABILITY_OP, capability: { name: "arkdata" } },
    { ...SCAN_CAPABILITY_OP, capability: { name: "Not A Catalog Name!" } },
  ], adapter);
  assert.equal(checked.catalogUnmatched, 1);
  assert.equal(checked.operations[0], REQUIREMENT_OP, "non-capability claims pass through untouched");
  assert.equal(checked.operations[1].capability.module, "@kit.ScanKit");
  assert.equal(checked.operations[1].capability.catalogUnmatched, false);
  assert.equal(checked.operations[2].capability.module, "@kit.ArkData", "irregular casing comes from the adapter");
  assert.equal(checked.operations[3].capability.catalogUnmatched, true);
  assert.equal(checked.operations[3].capability.module, undefined, "unmatched entries keep no derived module");
  // Without an adapter every capability entry is kept but unmatched.
  const withoutAdapter = crossCheckCapabilityOperations([SCAN_CAPABILITY_OP], null);
  assert.equal(withoutAdapter.catalogUnmatched, 1);
  assert.equal(withoutAdapter.operations[0].capability.catalogUnmatched, true);
});


test("materialManifest lists files deterministically with digests", async (t) => {
  const root = await workspace(t);
  await write(root, "materials/b.md", "beta");
  await write(root, "materials/a.md", "alpha");
  const first = await materialManifest([path.join(root, "materials")]);
  const second = await materialManifest([path.join(root, "materials")]);
  assert.deepEqual(first.entries.map((entry) => entry.path), ["a.md", "b.md"]);
  assert.ok(first.entries.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)));
  assert.equal(first.digest, second.digest);
  assert.deepEqual(await materialManifest([path.join(root, "missing")]), (
    { entries: [], digest: (await materialManifest([])).digest }
  ));
});


test("a frozen ledger drops non-user operations but still accepts USER_EXPLICIT deltas", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-freeze" });
  await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: { operations: [{ ...SCAN_CAPABILITY_OP, capability: { name: "scan-kit", module: "@kit.ScanKit" } }, REQUIREMENT_OP] },
  });
  const frozen = await freezeGroundTruth({ projectRoot: root, taskId: task.taskId });
  assert.equal(frozen.changed, true);
  assert.equal(frozen.current.frozenAtVersion, 1);
  // Freezing is idempotent.
  assert.equal((await freezeGroundTruth({ projectRoot: root, taskId: task.taskId })).changed, false);
  const state = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  assert.equal(state.groundTruth.frozenAtVersion, 1);

  // Post-freeze agent inference is dropped fail-soft, not applied and not thrown.
  const dropped = await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: { operations: [{
      operation: "ADD",
      category: "requirements",
      text: "An inferred post-freeze requirement.",
      authority: "AGENT_INFERRED",
      severity: "SOFT",
      source: { ref: "agent" },
    }] },
  });
  assert.equal(dropped.changed, false);
  assert.equal(dropped.droppedPostFreeze.length, 1);
  assert.equal(dropped.droppedPostFreeze[0].authority, "AGENT_INFERRED");

  // A new real user message can still supersede the frozen baseline.
  const userClaim = frozen.current.claims.find((claim) => claim.authority === "USER_EXPLICIT");
  const superseded = await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: { operations: [{
      operation: "SUPERSEDE",
      claimId: userClaim.claimId,
      category: userClaim.category,
      text: "The home page must render the product list with pagination.",
      authority: "USER_EXPLICIT",
      severity: "HARD",
      source: { ref: "transcript:user-2" },
    }] },
  });
  assert.equal(superseded.changed, true);
  assert.equal(superseded.current.version, 2);
  assert.equal(superseded.current.frozenAtVersion, 1, "the freeze marker survives user-explicit deltas");
});


test("onboarding runs the panel once, adjudicates, freezes the ledger, and journals completion", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# requirements\n");
  const plan = onboardingPlan(root);
  const factory = onboardingFakeFactory({
    passOperations: () => [REQUIREMENT_OP, SCAN_CAPABILITY_OP],
    stopAssessment: passingStopAssessment,
  });
  const outcome = await stopEvent(root, plan, factory, "stop-onboard-1");
  assert.equal(outcome.decision, "allow");
  const passes = factory.calls.filter((call) => call.role === "onboarding-extractor");
  assert.equal(passes.length, 2, "two independent panel passes");
  assert.deepEqual(passes.map((call) => call.request.onboarding.passIndex), [1, 2]);
  const adjudications = factory.calls.filter((call) => call.role === "onboarding-adjudicator");
  assert.equal(adjudications.length, 1, "one adjudicator merge");
  assert.equal(adjudications[0].request.majorityOperations.length, 2);
  assert.deepEqual(adjudications[0].request.disputedOperations, []);

  const { state, groundTruth, journal } = await readTaskArtifacts(root);
  assert.equal(state.onboarding.status, "COMPLETED");
  assert.equal(groundTruth.frozenAtVersion, 1);
  assert.equal(groundTruth.version, 1);
  const requirement = groundTruth.claims.find((claim) => claim.category === "requirements");
  assert.equal(requirement.panelConfirmed, true, "majority-agreed claims are stamped confirmed");
  const capability = groundTruth.claims.find((claim) => claim.category === "capabilityChecklist");
  assert.equal(capability.capability.name, "scan-kit");
  assert.equal(capability.capability.module, "@kit.ScanKit", "the catalog cross-check fills the module in");
  assert.equal(capability.capability.catalogUnmatched, false);
  assert.ok(journal.includes("ONBOARDING_COMPLETED"));

  // The second event must not onboard again.
  await write(root, "transcript.jsonl", transcriptEntries(2));
  await stopEvent(root, plan, factory, "stop-onboard-2");
  assert.equal(factory.calls.filter((call) => call.role === "onboarding-extractor").length, 2);
});


test("onboarding fails soft to incremental extraction and journals ONBOARDING_DEGRADED", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = onboardingPlan(root);
  const factory = onboardingFakeFactory({
    failOnboardingRoles: true,
    incrementalOperations: (request) => (request.currentGroundTruth.version === 0 ? [REQUIREMENT_OP] : []),
    stopAssessment: passingStopAssessment,
  });
  const outcome = await stopEvent(root, plan, factory, "stop-degraded-1");
  assert.equal(outcome.decision, "allow");
  let artifacts = await readTaskArtifacts(root);
  // Early panel failures DEFER (the parent session may not be resumable on
  // the first events) and retry on later hook events before degrading.
  assert.equal(artifacts.state.onboarding.status, "DEFERRED");
  assert.equal(artifacts.state.onboarding.reason, "PANEL_FAILED");
  await write(root, "transcript.jsonl", transcriptEntries(2));
  await stopEvent(root, plan, factory, "stop-degraded-2");
  await write(root, "transcript.jsonl", transcriptEntries(3));
  await stopEvent(root, plan, factory, "stop-degraded-3");
  artifacts = await readTaskArtifacts(root);
  const { state, groundTruth, journal } = artifacts;
  assert.equal(state.onboarding.status, "DEGRADED");
  assert.equal(state.onboarding.reason, "PANEL_FAILED");
  assert.ok(journal.includes("ONBOARDING_DEGRADED"));
  // The wave-1 incremental extractor still populated the ledger, unfrozen.
  assert.equal(groundTruth.version, 1);
  assert.equal(groundTruth.frozenAtVersion ?? null, null, "a degraded onboarding never freezes");
  // The degraded outcome is terminal: no retry on the next event.
  await write(root, "transcript.jsonl", transcriptEntries(4));
  await stopEvent(root, plan, factory, "stop-degraded-4");
  assert.equal((await readTaskArtifacts(root)).state.onboarding.status, "DEGRADED");
});


test("an adjudicator fault degrades without applying panel claims", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = onboardingPlan(root);
  const factory = onboardingFakeFactory({
    failAdjudicator: true,
    stopAssessment: passingStopAssessment,
    incrementalOperations: () => [],
  });
  await stopEvent(root, plan, factory, "stop-adjfail-1");
  const { state, groundTruth } = await readTaskArtifacts(root);
  assert.equal(state.onboarding.status, "DEGRADED");
  assert.equal(state.onboarding.reason, "ADJUDICATION_FAILED");
  assert.equal(groundTruth.version, 0, "panel output is not applied without adjudication");
  assert.equal(groundTruth.frozenAtVersion ?? null, null);
});


test("panel size 0 disables onboarding entirely", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = onboardingPlan(root, {
    dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
  });
  const factory = onboardingFakeFactory({
    incrementalOperations: (request) => (request.currentGroundTruth.version === 0 ? [REQUIREMENT_OP] : []),
    stopAssessment: passingStopAssessment,
  });
  await stopEvent(root, plan, factory, "stop-nopanel-1");
  assert.deepEqual(factory.calls.filter((call) => call.role.startsWith("onboarding-")), []);
  const { state, groundTruth } = await readTaskArtifacts(root);
  assert.equal(state.onboarding, undefined, "no onboarding record is minted when disabled");
  assert.equal(groundTruth.version, 1, "incremental extraction is unchanged");
  assert.equal(groundTruth.frozenAtVersion ?? null, null);
});


test("without an adjudicator the majority stands and disputed claims downgrade to inferred-only", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = onboardingPlan(root, {
    dynamicGroundTruth: {
      enabled: true,
      panel: { size: 2, adjudicator: false },
    },
  });
  const factory = onboardingFakeFactory({
    passOperations: (passIndex) => (passIndex === 1
      ? [REQUIREMENT_OP, SCAN_CAPABILITY_OP]
      : [REQUIREMENT_OP]),
    stopAssessment: passingStopAssessment,
  });
  await stopEvent(root, plan, factory, "stop-noadj-1");
  assert.deepEqual(factory.calls.filter((call) => call.role === "onboarding-adjudicator"), []);
  const { groundTruth } = await readTaskArtifacts(root);
  assert.equal(groundTruth.frozenAtVersion, 1);
  const requirement = groundTruth.claims.find((claim) => claim.category === "requirements");
  assert.equal(requirement.panelConfirmed, true);
  assert.equal(requirement.severity, "HARD");
  const disputedCapability = groundTruth.claims.find((claim) => claim.category === "capabilityChecklist");
  assert.equal(disputedCapability.panelConfirmed, false);
  assert.equal(disputedCapability.authority, "AGENT_INFERRED", "disputed claims are downgraded");
  assert.equal(disputedCapability.severity, "SOFT");
});


test("capabilityChecklistFromClaims maps claims to checker entries with blocking semantics", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  const entries = capabilityChecklistFromClaims({
    claims: [{
      claimId: "capabilityChecklist-hard",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "HARD",
      panelConfirmed: false,
      capability: { name: "scan-kit", module: null, catalogUnmatched: false },
    }, {
      claimId: "capabilityChecklist-confirmed",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "SOFT",
      panelConfirmed: true,
      capability: { name: "arkdata", module: null, catalogUnmatched: false },
    }, {
      claimId: "capabilityChecklist-inferred",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "SOFT",
      panelConfirmed: false,
      capability: { name: "map-kit", module: null, catalogUnmatched: false },
    }, {
      claimId: "capabilityChecklist-unmatched",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "HARD",
      panelConfirmed: true,
      capability: { name: "no-such-catalog-shape!", module: null, catalogUnmatched: true },
    }, {
      claimId: "requirements-1",
      category: "requirements",
      status: "ACTIVE",
      severity: "HARD",
    }],
  }, adapter);
  assert.deepEqual(entries.map((entry) => [entry.kit, entry.module, entry.blocking, entry.catalogUnmatched]), [
    ["scan-kit", "@kit.ScanKit", true, false],
    ["arkdata", "@kit.ArkData", true, false],
    ["map-kit", "@kit.MapKit", false, false],
    ["no-such-catalog-shape!", null, true, true],
  ]);
});


test("the kit checker consumes frozen capability claims as primary source and cites claim ids", async (t) => {
  const root = await workspace(t);
  // The wave-1 table names core-speech-kit; with capability claims present the
  // table must be ignored entirely.
  await write(root, ".runtime-corrector/materials/app-requirements.md", [
    "### 10.1 Kit使用清单",
    "",
    "| 功能 | 使用Kit | 代码文件 |",
    "|------|---------|---------|",
    "| 语音 | core-speech-kit | Voice.ets |",
  ].join("\n"));
  // arkdata integrated for real; scan-kit and map-kit absent.
  await write(root, "entry/src/main/ets/data/Store.ets", [
    "import { relationalStore } from \"@kit.ArkData\";",
    "",
    "export const store = relationalStore.getRdbStore(globalThis.context, { name: \"app.db\" });",
  ].join("\n"));
  const groundTruth = {
    claims: [{
      claimId: "capabilityChecklist-scan",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "HARD",
      panelConfirmed: true,
      capability: { name: "scan-kit", module: null, catalogUnmatched: false },
    }, {
      claimId: "capabilityChecklist-arkdata",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "HARD",
      panelConfirmed: true,
      capability: { name: "arkdata", module: null, catalogUnmatched: false },
    }, {
      claimId: "capabilityChecklist-map",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "SOFT",
      panelConfirmed: false,
      capability: { name: "map-kit", module: null, catalogUnmatched: false },
    }, {
      claimId: "capabilityChecklist-unmatched",
      category: "capabilityChecklist",
      status: "ACTIVE",
      severity: "HARD",
      panelConfirmed: true,
      capability: { name: "bespoke-internal-capability", module: null, catalogUnmatched: true },
    }],
  };
  const findings = await checkKitIntegration(root, {
    materialRoots: [".runtime-corrector/materials"],
    groundTruth,
  });
  assert.deepEqual(
    findings.map((finding) => finding.deviationKey).sort(),
    ["impl:kit:map-kit", "impl:kit:scan-kit"],
    "integrated, unmatched, and table-only kits produce no findings",
  );
  const hard = findings.find((finding) => finding.deviationKey === "impl:kit:scan-kit");
  assert.equal(hard.severity, "error", "a hard/majority-confirmed entry blocks");
  assert.deepEqual(hard.violatedGroundTruthIds, ["capabilityChecklist-scan"]);
  assert.match(hard.reason, /capabilityChecklist-scan/u);
  const soft = findings.find((finding) => finding.deviationKey === "impl:kit:map-kit");
  assert.equal(soft.severity, "warning", "an inferred-only entry warns");
  assert.deepEqual(soft.violatedGroundTruthIds, ["capabilityChecklist-map"]);

  // With no capability claims the wave-1 table parser is the fallback.
  const fallback = await checkKitIntegration(root, {
    materialRoots: [".runtime-corrector/materials"],
    groundTruth: { claims: [] },
  });
  assert.deepEqual(fallback.map((finding) => finding.deviationKey), ["impl:kit:core-speech-kit"]);
  assert.deepEqual(fallback[0].violatedGroundTruthIds, []);
});


test("onboarded capability claims gate the stop: hard entries block, inferred-only entries warn", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, "entry/src/main/ets/pages/Index.ets", "@Entry struct Index {}");
  const plan = onboardingPlan(root, { implementationCorrection: { enabled: true } });
  const factory = onboardingFakeFactory({
    // scan-kit is agreed by both passes (majority-confirmed HARD); map-kit is
    // inferred by only one pass and kept by the adjudicator as disputed.
    passOperations: (passIndex) => (passIndex === 1
      ? [REQUIREMENT_OP, SCAN_CAPABILITY_OP, MAP_CAPABILITY_OP]
      : [REQUIREMENT_OP, SCAN_CAPABILITY_OP]),
    stopAssessment: passingStopAssessment,
    implAssessment: passingImplAssessment,
  });

  const first = await stopEvent(root, plan, factory, "stop-capgate-1");
  assert.equal(first.decision, "block", "the missing hard capability blocks the stage claim");
  assert.match(first.feedback, /scan-kit/u);
  const { state, groundTruth } = await readTaskArtifacts(root);
  assert.equal(groundTruth.frozenAtVersion, 1);
  const families = Object.values(state.deviations);
  const scanFamily = families.find((family) => (
    family.observations.at(-1)?.finding?.deviationKey === "impl:kit:scan-kit"
  ));
  assert.ok(scanFamily, "the blocking capability finding is recorded as a family");
  assert.deepEqual(
    scanFamily.observations.at(-1).finding.violatedGroundTruthIds.map((id) => id.startsWith("capabilityChecklist-")),
    [true],
    "the finding cites the frozen claim id",
  );
  assert.ok(!families.some((family) => (
    family.observations.at(-1)?.finding?.deviationKey === "impl:kit:map-kit"
  )), "the inferred-only warning never becomes a blocking family");

  // The developer integrates the hard capability; the retest allows the stop
  // while the inferred-only capability stays a warning.
  await write(root, "entry/src/main/ets/services/ScanService.ets", [
    "import { scanBarcode } from \"@kit.ScanKit\";",
    "",
    "export function scan() {",
    "  return scanBarcode.startScanForResult(getContext());",
    "}",
  ].join("\n"));
  await write(root, "transcript.jsonl", transcriptEntries(2));
  const second = await stopEvent(root, plan, factory, "stop-capgate-2");
  assert.equal(second.decision, "allow", "an inferred-only capability warning must not block");
  // The warning is still visible in the merged stop review findings.
  assert.ok(second.stop.review.findings.some((finding) => (
    finding.deviationKey === "impl:kit:map-kit" && finding.severity === "warning"
  )), "the inferred-only entry surfaces as a warning finding");
});
