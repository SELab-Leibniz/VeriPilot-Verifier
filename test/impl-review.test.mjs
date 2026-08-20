import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import {
  IMPL_REVIEW_SCHEMA,
  checkKitIntegration,
  collectSourceManifest,
  filterOwnedJudgements,
  kitModuleName,
  mergeJudgementsByObjectId,
  normalizeImplFinding,
  parseKitManifest,
  runImplementationReview,
} from "../lib/runtime-v2/impl-review.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { loadPlatformAdapter } from "../lib/runtime-v2/platform-adapter.mjs";
import {
  GROUND_TRUTH_REVIEW_SCHEMA,
  STOP_REVIEW_SCHEMA,
} from "../lib/runtime-v2/reviewer.mjs";
// Downstream closure attribution consumes the families this pipeline
// produces; importing it here locks the corrector and the evaluation to the
// same closure-attribution contract.
import { attributeClosures } from "./helpers/critic-contract.mjs";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "impl-review-"));
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
    entries.push({ type: "user", uuid: `user-${index}`, message: { id: `user-message-${index}`, content: `request ${index}` } });
    entries.push({ type: "assistant", uuid: `assistant-${index}`, message: { id: `assistant-message-${index}`, content: `work ${index}` } });
  }
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function implPlan(projectRoot, { shadowMode = false } = {}) {
  return {
    runtimeV2: compileRuntimeV2Config({
      version: 2,
      shadowMode,
      dynamicGroundTruth: { enabled: true, materialRoots: [".runtime-corrector/materials"] },
      skillCorrection: { enabled: false, selection: { mode: "include", include: [] } },
      artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
      stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
      implementationCorrection: { enabled: true },
    }, { policyRoot: path.join(projectRoot, ".runtime-corrector") }),
  };
}

// Fake reviewers: the extractor freezes one HARD requirement; the stop
// reviewer judges everything PASS (a self-satisfied claim); the implementation
// reviewer contradicts it with a first-party DEVIATION until `implPasses`
// flips, mimicking the developer fixing the code between stops.
function implFakeFactory(state) {
  const stopAssessment = (request) => {
    const objects = Object.values(request.population.metrics).flat();
    return {
      summary: "Developer claims the stage is complete.",
      stopClassification: "STAGE_COMPLETE",
      stage: "implementation",
      findings: [],
      metricObjectJudgements: objects.map((object) => ({
        objectId: object.objectId,
        judgement: "PASS",
        reason: "Claimed satisfied.",
        evidence: ["developer claim"],
      })),
    };
  };
  return async ({ projectRoot, role, request, schema }) => {
    const requestDirectory = path.join(projectRoot, ".runtime-correction", "fake-review", String((state.serial += 1)));
    await fs.mkdir(requestDirectory, { recursive: true });
    let result;
    if (schema === GROUND_TRUTH_REVIEW_SCHEMA) {
      result = {
        summary: "Ground Truth refreshed.",
        taskClassification: "CONTINUATION",
        operations: request.currentGroundTruth.version === 0 ? [{
          operation: "ADD",
          category: "requirements",
          text: "The home page must render the product list.",
          authority: "USER_EXPLICIT",
          severity: "HARD",
          source: { ref: "transcript:user-1" },
        }] : [],
        skillGroundTruth: null,
      };
    } else if (schema === STOP_REVIEW_SCHEMA) {
      result = stopAssessment(request);
    } else if (schema === IMPL_REVIEW_SCHEMA) {
      state.implCalls += 1;
      const m12 = (request.population.metrics.M12 ?? []);
      assert.ok(m12.length > 0, "impl request must carry the M12 slice");
      const passes = state.implPasses;
      result = {
        summary: passes ? "Source now implements the requirement." : "Source does not implement the requirement.",
        findings: passes ? [] : m12.map((object) => ({
          deviationKey: `impl:${object.sourceId}`,
          rootCauseId: "IMPLEMENTATION_BEHAVIOR_MISMATCH",
          severity: "error",
          reason: `Requirement ${object.sourceId} is not observable in the production source.`,
          actualEvidence: ["entry/src/main/ets/pages/Index.ets:1"],
          expectedConstraint: "The artifact must satisfy the frozen Ground Truth.",
          // Deliberately prefixed to prove normalizeImplFinding protects closure.
          violatedGroundTruthIds: [`M12:${object.sourceId}`],
          suggestedNextAction: "Implement the requirement.",
        })),
        metricObjectJudgements: m12.map((object) => ({
          objectId: object.objectId,
          judgement: passes ? "PASS" : "DEVIATION",
          reason: passes ? "Implemented at entry/src/main/ets/pages/Index.ets:1." : "No implementing code found.",
          evidence: ["entry/src/main/ets/pages/Index.ets:1"],
        })),
      };
    } else {
      throw new Error(`Unexpected fake reviewer schema for role ${role}`);
    }
    return {
      result,
      requestDirectory,
      // assessStop reuses the ground-truth extractor's handle: it writes
      // assessment-request.json into the request directory and calls followUp
      // with the STOP schema. Mirror the real fakeReviewerFactory behavior.
      async followUp({ nextSchema }) {
        if (nextSchema === STOP_REVIEW_SCHEMA) {
          const assessment = JSON.parse(await fs.readFile(
            path.join(requestDirectory, "assessment-request.json"),
            "utf8",
          ));
          return stopAssessment(assessment);
        }
        throw new Error("Unexpected followUp schema");
      },
      async close() {},
    };
  };
}

async function runStop(root, plan, factory, id) {
  return handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-impl",
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

async function taskFamilies(root) {
  const tasksRoot = path.join(root, ".runtime-correction", "tasks");
  const tasks = await fs.readdir(tasksRoot);
  const families = [];
  for (const taskId of tasks) {
    const state = JSON.parse(await fs.readFile(path.join(tasksRoot, taskId, "task.json"), "utf8"));
    families.push(...Object.values(state.deviations ?? {}));
  }
  return families;
}

test("normalizeImplFinding strips metric prefixes so closure can key on bare claim ids", () => {
  const finding = normalizeImplFinding({ violatedGroundTruthIds: ["M12:claim-1", "claim-2", "M09:claim-3"] });
  assert.deepEqual(finding.violatedGroundTruthIds, ["claim-1", "claim-2", "claim-3"]);
});

test("mergeJudgementsByObjectId dedupes with the implementation judgement winning", () => {
  const merged = mergeJudgementsByObjectId(
    [{ objectId: "M12:c1", judgement: "PASS" }, { objectId: "M01:c9", judgement: "PASS" }],
    [{ objectId: "M12:c1", judgement: "DEVIATION" }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.objectId === "M12:c1").judgement, "DEVIATION");
});

test("filterOwnedJudgements keeps only the M09/M11/M12 partition", () => {
  const owned = filterOwnedJudgements([
    { objectId: "M12:c1" }, { objectId: "M09:c2" }, { objectId: "M11:c3" },
    { objectId: "M13:c4" }, { objectId: "M01:c5" },
  ]);
  assert.deepEqual(owned.map((item) => item.objectId), ["M12:c1", "M09:c2", "M11:c3"]);
});

test("collectSourceManifest hashes production source and skips excluded trees", async (t) => {
  const root = await workspace(t);
  await write(root, "entry/src/main/ets/pages/Index.ets", "@Entry struct Index {}");
  await write(root, "entry/src/main/module.json5", "{}");
  await write(root, "entry/src/main/ets/mock/Fake.ets", "mock");
  await write(root, "entry/src/test/Unit.test.ets", "test");
  await write(root, "oh-package.json5", "{}");
  const manifest = await collectSourceManifest(root);
  const paths = manifest.map((item) => item.path);
  assert.ok(paths.includes("entry/src/main/ets/pages/Index.ets"));
  assert.ok(paths.includes("entry/src/main/module.json5"));
  assert.ok(paths.includes("oh-package.json5"));
  assert.ok(!paths.some((item) => item.includes("/mock/")), "mock trees are excluded");
  assert.ok(manifest.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)));
});

const KIT_MANIFEST_MARKDOWN = [
  "### 10.1 Kit使用清单",
  "",
  "| 功能 | 使用Kit | 代码文件 |",
  "|------|---------|---------|",
  "| 扫码 | scan-kit | ScanService.ets |",
  "| 数据持久化 | arkdata | Store.ets |",
  "| 地图 | map-kit | MapPage.ets |",
  "",
  "### 10.2 其他",
  "",
  "| 功能 | 使用Kit | 代码文件 |",
  "| 语音 | core-speech-kit | Voice.ets |",
].join("\n");

test("kitModuleName maps catalog names to @kit modules, including irregular casing", async () => {
  const adapter = await loadPlatformAdapter("harmonyos");
  assert.equal(kitModuleName("scan-kit", adapter), "@kit.ScanKit");
  assert.equal(kitModuleName("core-speech-kit", adapter), "@kit.CoreSpeechKit");
  assert.equal(kitModuleName("arkdata", adapter), "@kit.ArkData");
});

test("loadPlatformAdapter returns null for null or unknown platforms", async () => {
  assert.equal(await loadPlatformAdapter(null), null);
  assert.equal(await loadPlatformAdapter("no-such-platform"), null);
});

test("parseKitManifest reads only the configured section table and skips header/divider rows", () => {
  assert.deepEqual(parseKitManifest(KIT_MANIFEST_MARKDOWN), {
    kits: ["scan-kit", "arkdata", "map-kit"],
    sectionTitle: "10.1 Kit使用清单",
  });
  assert.deepEqual(parseKitManifest("## other\n| a | b-kit | c |"), { kits: [], sectionTitle: null });
  assert.deepEqual(parseKitManifest(null), { kits: [], sectionTitle: null });
  // A custom section pattern selects a different table.
  assert.deepEqual(
    parseKitManifest(KIT_MANIFEST_MARKDOWN, { sectionPattern: "^#{1,4}\\s*10\\.2\\b" }).kits,
    ["core-speech-kit"],
  );
});

test("checkKitIntegration flags manifest kits that are absent or import-only in production source", async (t) => {
  const root = await workspace(t);
  await write(root, ".runtime-corrector/materials/app-requirements.md", KIT_MANIFEST_MARKDOWN);
  // scan-kit: imported and used -> integrated.
  await write(root, "entry/src/main/ets/services/ScanService.ets", [
    "import { scanBarcode, scanCore } from \"@kit.ScanKit\";",
    "",
    "export function scan() {",
    "  return scanBarcode.startScanForResult(getContext(), new scanCore.ScanOptions());",
    "}",
  ].join("\n"));
  // arkdata: import-only -> not integrated.
  await write(root, "entry/src/main/ets/data/Store.ets", [
    "import { relationalStore } from \"@kit.ArkData\";",
    "",
    "export const placeholder = 1;",
  ].join("\n"));
  // map-kit: only used inside an excluded mock tree -> not integrated.
  await write(root, "entry/src/main/ets/mock/MapMock.ets", [
    "import { MapComponent } from \"@kit.MapKit\";",
    "export const mock = MapComponent;",
  ].join("\n"));
  const findings = await checkKitIntegration(root, {
    materialRoots: [".runtime-corrector/materials"],
  });
  assert.deepEqual(findings.map((finding) => finding.deviationKey).sort(), ["impl:kit:arkdata", "impl:kit:map-kit"]);
  for (const finding of findings) {
    assert.equal(finding.severity, "error");
    assert.equal(finding.rootCauseId, "REQUIREMENT_OMITTED");
    assert.deepEqual(finding.violatedGroundTruthIds, []);
    assert.match(finding.reason, /未在生产源码中真实集成/u);
    // The finding cites the actual matched section title, not a fixed §10.1.
    assert.match(finding.reason, /10\.1 Kit使用清单/u);
    assert.match(finding.expectedConstraint, /10\.1 Kit使用清单/u);
  }
  const importOnly = findings.find((finding) => finding.deviationKey === "impl:kit:arkdata");
  assert.ok(importOnly.actualEvidence[0].includes("entry/src/main/ets/data/Store.ets"));
});

test("checkKitIntegration fails soft when the checklist file or section is absent", async (t) => {
  const root = await workspace(t);
  const checklistPaths = [".runtime-corrector/materials/app-requirements.md"];
  assert.deepEqual(await checkKitIntegration(root, { checklistPaths }), []);
  await write(root, ".runtime-corrector/materials/app-requirements.md", "# no kit manifest here\n");
  assert.deepEqual(await checkKitIntegration(root, { checklistPaths }), []);
});

test("checkKitIntegration is inactive without configured checklist sources or a known platform", async (t) => {
  const root = await workspace(t);
  await write(root, ".runtime-corrector/materials/app-requirements.md", KIT_MANIFEST_MARKDOWN);
  // No checklistPaths and no materialRoots: nothing to check.
  assert.deepEqual(await checkKitIntegration(root), []);
  // Explicit checklist but a null/unknown platform: the kit check is skipped.
  const checklistPaths = [".runtime-corrector/materials/app-requirements.md"];
  assert.deepEqual(await checkKitIntegration(root, { checklistPaths, platform: null }), []);
  assert.deepEqual(await checkKitIntegration(root, { checklistPaths, platform: "no-such-platform" }), []);
});

test("deterministic kit findings survive an implementation reviewer fault", async (t) => {
  const root = await workspace(t);
  await write(root, ".runtime-corrector/materials/app-requirements.md", KIT_MANIFEST_MARKDOWN);
  const args = {
    projectRoot: root,
    sessionCwd: root,
    taskId: "task-kit",
    parentSessionId: "session-kit",
    runtimeV2: {
      reviewers: { implementationReviewer: {} },
      implementationCorrection: {
        checklistPaths: [".runtime-corrector/materials/app-requirements.md"],
      },
    },
    reviewerFactory: async () => { throw new Error("reviewer subprocess boom"); },
    population: { metrics: { M09: [], M11: [], M12: [] } },
    groundTruthPath: "unused",
    rootCauseIds: [],
  };
  const review = await runImplementationReview(args);
  assert.deepEqual(
    review.findings.map((finding) => finding.deviationKey).sort(),
    ["impl:kit:arkdata", "impl:kit:map-kit", "impl:kit:scan-kit"],
  );
  assert.deepEqual(review.metricObjectJudgements, []);
  assert.equal(review.reviewerError, "reviewer subprocess boom");
  // No deterministic findings -> the reviewer fault still fails open upstream.
  await fs.rm(path.join(root, ".runtime-corrector"), { recursive: true, force: true });
  await assert.rejects(() => runImplementationReview(args), /reviewer subprocess boom/u);
});

test("kit findings block the stop gate and stamp observation.turnIndex", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, "entry/src/main/ets/pages/Index.ets", "@Entry struct Index {}");
  await write(root, ".runtime-corrector/materials/app-requirements.md", [
    "### 10.1 Kit使用清单",
    "",
    "| 功能 | 使用Kit | 代码文件 |",
    "|------|---------|---------|",
    "| 扫码 | scan-kit | ScanService.ets |",
  ].join("\n"));
  const plan = implPlan(root);
  // Both LLM reviewers pass everything; only the deterministic check can block.
  const state = { serial: 0, implCalls: 0, implPasses: true };
  const first = await runStop(root, plan, implFakeFactory(state), "stop-kit-1");
  assert.equal(first.decision, "block", "an unintegrated manifest kit must block the stop");
  const families = await taskFamilies(root);
  const family = families.find((item) => item.observations.at(-1)?.finding?.deviationKey === "impl:kit:scan-kit");
  assert.ok(family, "kit finding is recorded as a deviation family");
  assert.equal(family.observations[0].turnIndex, 1, "observation carries the assistant-turn counter");
});

test("implementation review detects, delivers, closes on retest, and attributes CRITIC (active arm)", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, "entry/src/main/ets/pages/Index.ets", "@Entry struct Index {}");
  const plan = implPlan(root);
  const state = { serial: 0, implCalls: 0, implPasses: false };
  const factory = implFakeFactory(state);

  // Epoch 1: stop reviewer says PASS everywhere; impl reviewer contradicts
  // with a first-party DEVIATION -> merged report blocks the stage claim.
  const first = await runStop(root, plan, factory, "stop-impl-1");
  assert.equal(first.decision, "block", "impl DEVIATION must override the stop PASS and block");
  assert.ok(state.implCalls >= 1, "implementation reviewer ran");
  let families = await taskFamilies(root);
  assert.ok(families.length > 0, "a deviation family was recorded");
  const family = families.find((item) => (item.observations.at(-1)?.finding?.violatedGroundTruthIds ?? []).length > 0);
  assert.ok(family, "family carries violatedGroundTruthIds");
  for (const id of family.observations.at(-1).finding.violatedGroundTruthIds) {
    assert.ok(!/^M\d\d:/u.test(id), `closure key must be a bare claim id, got ${id}`);
  }
  assert.equal(family.observations[0].delivered, true, "active arm stamps delivered");
  assert.equal(family.status, "OPEN");

  // Developer "fixes the code"; epoch 2 retest passes -> family closes.
  state.implPasses = true;
  const second = await runStop(root, plan, factory, "stop-impl-2");
  assert.equal(second.decision, "allow", "clean retest allows the stop");
  families = await taskFamilies(root);
  const closed = families.find((item) => item.familyId === family.familyId);
  assert.equal(closed.status, "FIXED", "retest PASS closes the family via markMetricPassesFixed");
  assert.equal(typeof closed.fixedAt, "string");

  // The evaluation-side attribution credits the critic: delivered, fix after delivery.
  const attribution = attributeClosures([closed]);
  assert.equal(attribution.get(closed.familyId), "CRITIC");
});

test("shadow arm records identical detection but never delivers, and closures attribute SELF", async (t) => {
  const root = await workspace(t);
  await write(root, "transcript.jsonl", transcriptEntries(1));
  await write(root, "entry/src/main/ets/pages/Index.ets", "@Entry struct Index {}");
  const plan = implPlan(root, { shadowMode: true });
  const state = { serial: 0, implCalls: 0, implPasses: false };
  const factory = implFakeFactory(state);

  const first = await runStop(root, plan, factory, "stop-shadow-1");
  assert.equal(first.decision, undefined, "shadow strips the outbound decision");
  assert.equal(first.feedback, null, "shadow strips the outbound feedback");
  assert.equal(first.shadowMode, true);
  let families = await taskFamilies(root);
  const family = families.find((item) => (item.observations.at(-1)?.finding?.violatedGroundTruthIds ?? []).length > 0);
  assert.ok(family, "detection is still recorded in shadow");
  assert.equal(family.observations[0].delivered, false, "shadow arm never stamps delivered");

  state.implPasses = true;
  await runStop(root, plan, factory, "stop-shadow-2");
  families = await taskFamilies(root);
  const closed = families.find((item) => item.familyId === family.familyId);
  assert.equal(closed.status, "FIXED");
  const attribution = attributeClosures([closed]);
  assert.equal(attribution.get(closed.familyId), "SELF", "a shadow-arm closure must never credit the critic");
});
