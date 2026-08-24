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
  capabilityVoteKey,
  catalogCapabilityName,
  crossCheckCapabilityOperations,
  deterministicCapabilityOperations,
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


test("an adjudicator fault with nothing usable from the panel still degrades unfrozen", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = onboardingPlan(root);
  const factory = onboardingFakeFactory({
    passOperations: () => [],
    failAdjudicator: true,
    stopAssessment: passingStopAssessment,
    incrementalOperations: () => [],
  });
  await stopEvent(root, plan, factory, "stop-adjfail-1");
  const { state, groundTruth } = await readTaskArtifacts(root);
  // The deterministic-merge recovery cannot invent claims: with an empty
  // panel there is nothing to apply, and freezing an empty ledger would lock
  // out every later claim.
  assert.equal(state.onboarding.status, "DEGRADED");
  assert.equal(state.onboarding.reason, "EMPTY_RESULT");
  assert.equal(groundTruth.version, 0);
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
    // Panel consensus on an inferred (SOFT) kit is common-mode error, not
    // independent confirmation: it never escalates to blocking.
    ["arkdata", "@kit.ArkData", false, false],
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

test("capabilityVoteKey aligns casing, separators, and module prefixes onto one vote", () => {
  for (const variant of ["NetworkKit", "@kit.NetworkKit", "Network Kit", "network_kit", "network-kit"]) {
    assert.equal(capabilityVoteKey(variant), "networkkit", variant);
  }
  const vote = (name) => panelClaimKey({ category: "capabilityChecklist", capability: { name }, text: `use ${name}` });
  assert.equal(vote("NetworkKit"), vote("network-kit"));
  const { majority, disputed, votes } = mergePanelOperations([
    [{ ...SCAN_CAPABILITY_OP, capability: { name: "ScanKit" } }],
    [SCAN_CAPABILITY_OP],
  ]);
  assert.equal(majority.length, 1, "differently-cased kit names still reach majority");
  assert.deepEqual(disputed, []);
  assert.equal(votes.get(panelClaimKey(SCAN_CAPABILITY_OP)), 2);
});

test("catalogCapabilityName prefers adapter special cases and hyphenates camelCase", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  assert.equal(catalogCapabilityName("ArkUI", adapter), "arkui", "special-cased simple form wins");
  assert.equal(catalogCapabilityName("NetworkKit", adapter), "network-kit");
  assert.equal(catalogCapabilityName("@kit.ScanKit", adapter), "scan-kit");
  assert.equal(catalogCapabilityName("Network Kit", adapter), "network-kit");
  assert.equal(catalogCapabilityName("network-kit", adapter), "network-kit");
});

test("crossCheckCapabilityOperations canonicalizes non-catalog capability names before module resolution", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  const { operations, catalogUnmatched } = crossCheckCapabilityOperations([
    { ...SCAN_CAPABILITY_OP, capability: { name: "@kit.ScanKit" } },
  ], adapter);
  assert.equal(catalogUnmatched, 0);
  assert.equal(operations[0].capability.name, "scan-kit");
  assert.equal(operations[0].capability.module, "@kit.ScanKit");
});

const KIT_TABLE_MD = [
  "# 需求",
  "",
  "### 10.1 Kit使用清单",
  "",
  "| 功能 | 使用Kit | 代码文件 |",
  "| --- | --- | --- |",
  "| 商品服务 | network-kit | services/CommodityService.ets |",
  "| 扫码 | scan-kit | pages/ScanPage.ets |",
  "",
  "### 10.2 其他",
].join("\n");

test("deterministicCapabilityOperations parses material kit tables into HARD claims", async (t) => {
  const root = await workspace(t);
  await write(root, "materials/app-requirements.md", KIT_TABLE_MD);
  const materials = await materialManifest([path.join(root, "materials")]);
  const operations = await deterministicCapabilityOperations(materials, {});
  assert.deepEqual(operations.map((op) => op.capability.name), ["network-kit", "scan-kit"]);
  for (const op of operations) {
    assert.equal(op.operation, "ADD");
    assert.equal(op.category, "capabilityChecklist");
    assert.equal(op.authority, "MATERIAL_DERIVED");
    assert.equal(op.severity, "HARD");
    assert.match(op.capability.sourceHint, /app-requirements\.md#/u);
  }
});

test("onboarding unions the deterministic table parse with the panel result", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", KIT_TABLE_MD);
  const plan = onboardingPlan(root);
  // The panel proposes only one table kit (in sloppy casing) plus an inferred
  // SOFT capability the table does not carry.
  const factory = onboardingFakeFactory({
    passOperations: () => [
      REQUIREMENT_OP,
      { ...SCAN_CAPABILITY_OP, authority: "AGENT_INFERRED", severity: "SOFT", capability: { name: "ScanKit" } },
      MAP_CAPABILITY_OP,
    ],
    stopAssessment: passingStopAssessment,
  });
  await stopEvent(root, plan, factory, "stop-onboard-table");
  const { state, groundTruth, journal } = await readTaskArtifacts(root);
  assert.equal(state.onboarding.status, "COMPLETED");
  const capabilities = groundTruth.claims.filter((claim) => claim.category === "capabilityChecklist");
  assert.deepEqual(
    capabilities.map((claim) => claim.capability.name).sort(),
    ["map-kit", "network-kit", "scan-kit"],
    "table kits the panel missed are appended",
  );
  const scan = capabilities.find((claim) => claim.capability.name === "scan-kit");
  assert.equal(scan.authority, "MATERIAL_DERIVED", "table evidence upgrades the panel claim");
  assert.equal(scan.severity, "HARD");
  assert.equal(scan.panelConfirmed, true);
  assert.match(scan.text, /scan-kit|ScanKit/u, "the panel's own wording survives the upgrade");
  const network = capabilities.find((claim) => claim.capability.name === "network-kit");
  assert.equal(network.severity, "HARD");
  assert.equal(network.panelConfirmed, true);
  assert.equal(network.capability.module, "@kit.NetworkKit");
  const map = capabilities.find((claim) => claim.capability.name === "map-kit");
  assert.equal(map.severity, "SOFT", "non-table capabilities keep the panel's judgement");
  const completed = JSON.parse(journal.split("\n").filter(Boolean)
    .map((line) => line)
    .find((line) => line.includes("ONBOARDING_COMPLETED")));
  assert.equal(completed.deterministicKits, 2);
  assert.equal(completed.capabilityClaims, 3);
});

test("the adjudicator request annotates operations with panel vote counts", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# requirements\n");
  const plan = onboardingPlan(root);
  let passCount = 0;
  const factory = onboardingFakeFactory({
    passOperations: () => (passCount += 1) === 1
      ? [REQUIREMENT_OP, SCAN_CAPABILITY_OP]
      : [SCAN_CAPABILITY_OP],
    stopAssessment: passingStopAssessment,
  });
  await stopEvent(root, plan, factory, "stop-onboard-votes");
  const adjudication = factory.calls.find((call) => call.role === "onboarding-adjudicator");
  const majorityVotes = adjudication.request.majorityOperations.map((op) => op.panelVotes);
  assert.deepEqual(majorityVotes, [2], "the shared capability claim reports both votes");
  const disputedVotes = adjudication.request.disputedOperations.map((op) => op.panelVotes);
  assert.deepEqual(disputedVotes, [1], "the single-pass requirement reports one vote");
});

test("openQuestions claims are severity-capped to SOFT whatever their authority", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-oq" });
  const applied = await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: {
      operations: [{
        operation: "ADD",
        category: "openQuestions",
        text: "Scanning: scan-kit or camera-kit? Default-safe reading: either satisfies the requirement.",
        authority: "MATERIAL_DERIVED",
        severity: "HARD",
      }],
    },
    evidenceCapture: "references-only",
    hookEventId: "hook-oq",
  });
  const question = applied.current.claims.find((claim) => claim.category === "openQuestions");
  assert.equal(question.severity, "SOFT", "an admitted ambiguity can never be a hard obligation");
});

test("onboarding floors reviewer timeouts for the bulk decompose and runs panel passes in parallel", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# requirements\n");
  const plan = onboardingPlan(root);
  const factory = onboardingFakeFactory({
    passOperations: () => [REQUIREMENT_OP],
    stopAssessment: passingStopAssessment,
  });
  const spawns = [];
  const wrapped = async (args) => {
    spawns.push({ role: args.role, timeoutMs: args.reviewer?.timeoutMs });
    return factory(args);
  };
  wrapped.calls = factory.calls;
  await stopEvent(root, plan, wrapped, "stop-onboard-floor");
  const extractors = spawns.filter((spawn) => spawn.role === "onboarding-extractor");
  assert.equal(extractors.length, 2);
  assert.ok(extractors.every((spawn) => spawn.timeoutMs >= 480000),
    "bulk-decompose extractor timeout is floored above the incremental default");
  const adjudicator = spawns.find((spawn) => spawn.role === "onboarding-adjudicator");
  assert.ok(adjudicator.timeoutMs >= 360000, "adjudicator timeout floored");
  // Incremental (non-onboarding) reviewer spawns keep their configured default.
  const stopSpawns = spawns.filter((spawn) => !spawn.role.startsWith("onboarding-"));
  assert.ok(stopSpawns.every((spawn) => spawn.timeoutMs === 240000),
    "non-onboarding roles keep the configured/default timeout");
});

test("resume-transient panel failures defer without consuming the real-failure attempt budget", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# requirements\n");
  const plan = onboardingPlan(root);
  let mode = "transient";
  const factory = onboardingFakeFactory({
    passOperations: () => [REQUIREMENT_OP, SCAN_CAPABILITY_OP],
    stopAssessment: passingStopAssessment,
  });
  const inner = factory;
  const wrapped = async (args) => {
    if (mode === "transient" && args.role === "onboarding-extractor") {
      throw new Error("Internal reviewer exited with code 1: No conversation found with session ID: abc");
    }
    return inner(args);
  };
  wrapped.calls = inner.calls;

  // Four transient failures in a row: attempts must stay 0, status DEFERRED.
  for (let round = 1; round <= 4; round += 1) {
    await stopEvent(root, plan, wrapped, `stop-transient-${round}`);
    const { state } = await readTaskArtifacts(root);
    assert.equal(state.onboarding.status, "DEFERRED", `round ${round} defers`);
    assert.equal(state.onboarding.attempts ?? 0, 0, `round ${round} spends no real attempt`);
    assert.equal(state.onboarding.transientAttempts, round);
  }

  // The panel becoming healthy afterwards still completes and freezes.
  mode = "healthy";
  await stopEvent(root, plan, wrapped, "stop-transient-recovery");
  const { state, groundTruth } = await readTaskArtifacts(root);
  assert.equal(state.onboarding.status, "COMPLETED");
  assert.equal(groundTruth.frozenAtVersion, 1);
});

test("an adjudicator fault falls back to the deterministic merge instead of losing the panel's work", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# requirements\n");
  const plan = onboardingPlan(root);
  let pass = 0;
  const factory = onboardingFakeFactory({
    // Pass 1 proposes both claims; pass 2 only the capability -> the
    // requirement is disputed and must survive as inferred-only.
    passOperations: () => (pass += 1) === 1 ? [REQUIREMENT_OP, SCAN_CAPABILITY_OP] : [SCAN_CAPABILITY_OP],
    failAdjudicator: true,
    stopAssessment: passingStopAssessment,
  });
  await stopEvent(root, plan, factory, "stop-adjudicator-fallback");

  const { state, groundTruth, journal } = await readTaskArtifacts(root);
  assert.equal(state.onboarding.status, "COMPLETED", "onboarding still completes");
  assert.equal(groundTruth.frozenAtVersion, 1, "the ledger is still frozen");
  const capability = groundTruth.claims.find((claim) => claim.category === "capabilityChecklist");
  assert.equal(capability.severity, "HARD", "panel-majority material claims stand");
  assert.equal(capability.panelConfirmed, true);
  const requirement = groundTruth.claims.find((claim) => claim.category === "requirements");
  assert.equal(requirement.authority, "AGENT_INFERRED", "disputed claims downgrade, not vanish");
  assert.equal(requirement.severity, "SOFT");

  const events = journal.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const degraded = events.find((event) => event.type === "ONBOARDING_DEGRADED");
  assert.equal(degraded.reason, "ADJUDICATION_FAILED");
  assert.equal(degraded.recovery, "DETERMINISTIC_MERGE", "the recovery path is journaled");
  const completed = events.find((event) => event.type === "ONBOARDING_COMPLETED");
  assert.equal(completed.adjudicated, false);
  assert.equal(completed.mergeMode, "DETERMINISTIC");
});

test("material hedging caps a panel-committed kit at SOFT", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", [
    "### 10.1 Kit使用清单",
    "",
    "| 功能 | 使用Kit | 代码文件 |",
    "|------|---------|---------|",
    "| 扫码 | scan-kit | Scan.ets |",
    "| 视觉 | core-vision-kit候选/经POC验证 | Vision.ets |",
  ].join("\n"));
  const plan = onboardingPlan(root);
  // The panel commits to BOTH kits as hard material obligations.
  const factory = onboardingFakeFactory({
    passOperations: () => [
      SCAN_CAPABILITY_OP,
      { ...SCAN_CAPABILITY_OP, text: "Vision via core-vision-kit.", capability: { name: "core-vision-kit" } },
    ],
    stopAssessment: passingStopAssessment,
  });
  await stopEvent(root, plan, factory, "stop-hedge-cap");

  const { groundTruth } = await readTaskArtifacts(root);
  const byKit = Object.fromEntries(groundTruth.claims
    .filter((claim) => claim.category === "capabilityChecklist")
    .map((claim) => [claim.capability.name, claim]));
  assert.equal(byKit["scan-kit"].severity, "HARD", "a committed table entry still blocks");
  assert.equal(byKit["core-vision-kit"].severity, "SOFT",
    "the material hedges this kit, so panel commitment cannot make it an obligation");
});

test("onboarding reviewers detach by default but never override an explicit session", async () => {
  const { compileRuntimeV2Config } = await import("../lib/runtime-v2/config.mjs");
  const defaulted = compileRuntimeV2Config({ version: 2 }).reviewers.groundTruthExtractor;
  assert.equal(defaulted.session, "fork", "the compiled default is still fork");
  assert.equal(defaulted.sessionExplicit, false, "but it was defaulted, not chosen");

  const chosen = compileRuntimeV2Config({
    version: 2,
    reviewers: { groundTruthExtractor: { session: "fork" } },
  }).reviewers.groundTruthExtractor;
  assert.equal(chosen.sessionExplicit, true, "an explicit fork is recorded as chosen");

  const viaDefaults = compileRuntimeV2Config({
    version: 2,
    reviewers: { defaults: { session: "fork" } },
  }).reviewers.groundTruthExtractor;
  assert.equal(viaDefaults.sessionExplicit, true, "reviewers.defaults counts as explicit too");
});

test("onboarding spawns detached extractors so it never forks a growing parent", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# requirements\n");
  const plan = onboardingPlan(root);
  const spawns = [];
  const inner = onboardingFakeFactory({
    passOperations: () => [REQUIREMENT_OP],
    stopAssessment: passingStopAssessment,
  });
  const factory = async (args) => {
    spawns.push({ role: args.role, session: args.reviewer?.session });
    return inner(args);
  };
  factory.calls = inner.calls;
  await stopEvent(root, plan, factory, "stop-detached");
  const onboarding = spawns.filter((spawn) => spawn.role.startsWith("onboarding-"));
  assert.ok(onboarding.length >= 2);
  assert.ok(onboarding.every((spawn) => spawn.session === "detached"),
    "onboarding roles must not fork the parent conversation");
});

test("onboarding inlines material text but keeps the digest identity-only", async (t) => {
  const root = await workspace(t);
  await write(root, "materials/app-requirements.md", "# Requirements\n\nThe app must do X.\n");
  const roots = [path.join(root, "materials")];
  const identity = await materialManifest(roots);
  const withText = await materialManifest(roots, { includeContent: true });

  assert.equal(identity.entries[0].text, undefined, "the incremental path stays identity-only");
  assert.match(withText.entries[0].text, /The app must do X/u, "onboarding gets the text itself");
  assert.equal(withText.digest, identity.digest,
    "inlining must not change task identity, or every task would look new");
});

test("inlined material is capped so a huge document cannot blow the request", async (t) => {
  const root = await workspace(t);
  // Larger than the per-file inline allowance.
  await write(root, "materials/huge.md", `# Big\n${"x".repeat(260000)}`);
  const { entries } = await materialManifest([path.join(root, "materials")], { includeContent: true });
  const entry = entries[0];
  assert.equal(entry.contentTruncated, true, "oversized material is flagged, not silently cut");
  assert.ok(entry.text.length <= 200000);
  assert.ok(entry.bytes > entry.text.length, "the manifest still records the true size");
});

test("the capability module is adapter-derived, never taken from the extractor", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  // A panel pass that mapped the checklist table's code-file column into
  // capability.module — observed in a real run, and it made the kit checker
  // search for "BackgroundRefreshService.ets" as an import specifier.
  const { operations } = crossCheckCapabilityOperations([
    {
      ...SCAN_CAPABILITY_OP,
      capability: { name: "background-tasks-kit", module: "BackgroundRefreshService.ets" },
    },
    { ...SCAN_CAPABILITY_OP, capability: { name: "arkdata", module: "CommodityStore.ets" } },
  ], adapter);
  assert.equal(operations[0].capability.module, "@kit.BackgroundTasksKit");
  assert.equal(operations[1].capability.module, "@kit.ArkData", "adapter special cases still apply");
  assert.ok(operations.every((operation) => !/\.ets$/u.test(operation.capability.module)),
    "a source file name can never be a module specifier");
});
